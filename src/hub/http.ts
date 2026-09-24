/**
 * HTTP routing (+ /mode and the /state notify key): pure node:http, no express.
 *
 * Routes:
 *   POST   /mcp   → stateless Streamable HTTP (per-request McpServer + transport,
 *                   destroyed on response close — verified idiom)
 *   GET|DELETE /mcp → 405 + Allow: POST (stateless mode has no SSE stream / session)
 *   GET|HEAD /state → frozen shape for the Notifier (system-design 4.3)
 *                   + optional top-level `notify` key echoing config.json's notify
 *                   field (additive revision, absent by default)
 *                   + optional top-level `auto` key echoing the validated auto
 *                   whitelist section (same additive pattern)
 *                   + optional top-level `degraded` key: storage-corrupted
 *                   tasks that failed to fold — non-empty when present
 *                   + per-entry `version` (additive revision)
 *   POST   /mode  → flow_mode switch for `tut mode`:
 *                   validate → key-preserving read-modify-write → echo {flow_mode}
 *   POST   /repair-meta    → A-class meta rebuild (system-design 4.3):
 *                   server-computed version + human-supplied rebuild fields
 *   POST   /recover-record  → B-class recovery registration (4.3):
 *                   pin corrupt bytes, land the .recovered copy, append the
 *                   recovery.jsonl registration line
 *   other         → 404 JSON
 *
 * DNS-rebinding guard: Host must be 127.0.0.1 / localhost / [::1]
 * (any or absent port) → otherwise 403. The handler cannot know its own port,
 * so the port is not validated.
 *
 * /state never 5xx on config problems (readConfig's contract — null config
 * means flow_mode falls back to "manual" and `notify` stays absent); a
 * corrupt config behind POST /mode becomes a 500 (writeFlowMode refuses to
 * clobber what it cannot parse); any other unexpected error becomes a 500 JSON
 * response, never a process crash.
 */

import path from "node:path";
import { canonicalRoot } from "./rig-discovery.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { autoSectionOf, readConfig, writeFlowMode } from "../common/config.js";
import { createMcpServer } from "../mcp/server.js";
import { ErrorCode, PROJECT_TASK_ID, type AgentRoute, type Cast, type CheckoutRoute, type Flow } from "../common/types.js";
import { Store, StoreError, type RecoverRecordInput, type RepairMetaInput } from "./store.js";

export interface RequestHandlerDeps {
  store: Store;
  /** Storage root (config.json lives here; readConfig re-reads per request). */
  root: string;
}

/**
 * The handler function itself; the live-transport set is attached so
 * server.ts can drain per-request transports on shutdown.
 */
export interface RequestHandler {
  (req: IncomingMessage, res: ServerResponse): void;
  /** Transports of in-flight POST /mcp requests; drained by server shutdown. */
  transports: Set<StreamableHTTPServerTransport>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Hostname part of a Host header value, port stripped ("[::1]:3001" → "[::1]"). */
function hostHostname(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
    return host.slice(0, colon);
  }
  return host;
}

/** Only loopback Host values pass; absent Host (HTTP/1.0-style clients) is tolerated. */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (host === undefined) return true;
  return LOOPBACK_HOSTS.has(hostHostname(host.toLowerCase()));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // Never throws: headers not yet sent on all call sites; body is our own JSON.
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** /state entry — the frozen fields plus additive
 *  revisions: `version`, `flow` (always present, normalized
 *  "full"), `cast?`, and `checkout?` — same additive pattern as the
 *  top-level notify key. */
interface StateTaskEntry {
  task_id: string;
  title: string;
  status: string;
  updated_at: string;
  needs_attention: boolean;
  waiting_for: string;
  version: number;
  flow: string;
  cast?: Record<string, AgentRoute>;
  checkout?: CheckoutRoute;
}

/** StoreError → HTTP status for the repair endpoints (404 unknown task, 409 conflict, 400 validation). */
function storeErrorStatus(code: ErrorCode): number {
  if (code === ErrorCode.TASK_NOT_FOUND) return 404;
  if (code === ErrorCode.VERSION_CONFLICT) return 409;
  return 400;
}

/**
 * Map a JSON body field set onto the RepairMetaInput. Unknown fields are
 * ignored (additive-only surface). KNOWN fields, once present, are passed
 * through EXACTLY as sent: Store.repairMeta is the single validation
 * authority, and an invalid value comes back as an honest 400. The previous
 * silently-drop shaping let `flow:"bogus"` or a numeric
 * title return 200 while quietly rebuilding as full/default — a semantic
 * change the caller could not see. Callers wanting a field's default must
 * OMIT it, not send garbage.
 */
function parseRepairMetaBody(parsed: unknown): { task_id: string; input: RepairMetaInput } | { error: string } {
  if (typeof parsed !== "object" || parsed === null) return { error: "body must be a JSON object" };
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.task_id !== "string" || raw.task_id.length === 0) return { error: "task_id must be a non-empty string" };
  const input: RepairMetaInput = {};
  for (const field of ["title", "description", "creator", "created_at"] as const) {
    if (raw[field] !== undefined) input[field] = raw[field] as string; // store validates non-empty string
  }
  if (raw.flow !== undefined) input.flow = raw.flow as Flow; // store validates the enum
  if (raw.cast !== undefined) input.cast = raw.cast as Cast; // store validates the shape
  if (raw.checkout !== undefined) input.checkout = raw.checkout as CheckoutRoute; // store validates the shape
  return { task_id: raw.task_id, input };
}

export function createRequestHandler(deps: RequestHandlerDeps): RequestHandler {
  const { store, root } = deps;
  const hubRoot = canonicalRoot(path.dirname(path.resolve(root)));
  const transports = new Set<StreamableHTTPServerTransport>();

  async function handleState(res: ServerResponse): Promise<void> {
    // One readConfig call per request: flow_mode is DERIVED from the
    // same snapshot that carries `notify` — one request, one config view.
    const [config, snapshot] = await Promise.all([readConfig(root), store.snapshotTasks()]);
    const flowMode = config?.flow_mode ?? "manual";
    const tasks: StateTaskEntry[] = [];
    for (const entry of snapshot.tasks) {
      // project scope never appears in /state (system-design 4.3) — it has no derived state
      if (entry.task_id === PROJECT_TASK_ID) continue;
      tasks.push({
        task_id: entry.task_id,
        title: entry.title,
        status: entry.status ?? "designing",
        updated_at: entry.updated_at,
        needs_attention: entry.needs_attention ?? false,
        waiting_for: entry.waiting_for ?? "none",
        version: entry.version,
        flow: entry.flow ?? "full",
        ...(entry.cast !== undefined ? { cast: entry.cast } : {}),
        ...(entry.checkout !== undefined ? { checkout: entry.checkout } : {}),
      });
    }
    // Optional `notify` key: echoed only when a real,
    // parseable config carries it — corrupt/missing config → key absent, never a 5xx.
    // Optional `auto` key (same additive pattern): the validated
    // launch whitelist section — absent when missing/corrupt/malformed, so the
    // notifier's conservative default (empty = withhold all) applies.
    // Optional `degraded` key (system-design 4.3 additive revision):
    // storage-corrupted tasks that failed to fold — present only when non-empty,
    // so consumers may treat absence as healthy. A vanished directory is
    // invisible here by construction; consumers diff tasks∪degraded against
    // their previous snapshot to detect disappearance.
    const auto = autoSectionOf(config);
    sendJson(res, 200, {
      hub_root: hubRoot,
      flow_mode: flowMode,
      tasks,
      ...(snapshot.degraded.length > 0 ? { degraded: snapshot.degraded } : {}),
      ...(config !== null && "notify" in config ? { notify: config.notify } : {}),
      ...(auto !== undefined ? { auto } : {}),
    });
  }

  /** Collect a request body as a string (loopback-only endpoints; no size cap, same as /mcp). */
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  async function handleModePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const flowMode = typeof parsed === "object" && parsed !== null ? (parsed as { flow_mode?: unknown }).flow_mode : undefined;
    if (flowMode !== "manual" && flowMode !== "auto") {
      sendJson(res, 400, { error: 'flow_mode must be "manual" or "auto"' });
      return;
    }
    await writeFlowMode(root, flowMode); // throws on a corrupt config → outer guard 500s
    sendJson(res, 200, { flow_mode: flowMode });
  }

  /**
   * A-class repair entry (system-design 4.3): rebuild a corrupt/missing
   * meta.json through the hub's single-writer queue. Runs on the LIVE hub
   * only — a second process writing meta directly would race concurrent
   * appends (lost updates / version clobbers). The CLI client is `tut
   * repair-meta` (same discipline as `tut mode`).
   */
  async function handleRepairMetaPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const shaped = parseRepairMetaBody(parsed);
    if ("error" in shaped) {
      sendJson(res, 400, { error: shaped.error });
      return;
    }
    try {
      const result = await store.repairMeta(shaped.task_id, shaped.input);
      sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof StoreError) {
        sendJson(res, storeErrorStatus(e.code), { error: e.message });
        return;
      }
      throw e; // outer guard 500s
    }
  }

  /**
   * B-class recovery registration entry (system-design 4.3): pin the corrupt
   * bytes, land the recovered copy, append the registration line. The
   * recovered bytes come from the caller (human-held external snapshot) —
   * the hub never fetches backups itself.
   */
  async function handleRecoverRecordPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const taskId = typeof raw.task_id === "string" ? raw.task_id : undefined;
    const recordFile = typeof raw.record_file === "string" ? raw.record_file : undefined;
    const fromPath = typeof raw.from_path === "string" ? raw.from_path : undefined;
    if (!taskId || !recordFile || !fromPath) {
      sendJson(res, 400, { error: "task_id, record_file, and from_path must be non-empty strings" });
      return;
    }
    const input: RecoverRecordInput = {
      record_file: recordFile,
      from_path: fromPath,
      // Present-but-invalid source is NOT silently dropped (same principle as
      // repair-meta): pass it through, the store validates.
      ...(raw.source !== undefined ? { source: raw.source as string } : {}),
    };
    try {
      const result = await store.recoverRecord(taskId, input);
      sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof StoreError) {
        sendJson(res, storeErrorStatus(e.code), { error: e.message });
        return;
      }
      throw e; // outer guard 500s
    }
  }

  async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Stateless per-request lifecycle: a fresh McpServer + transport
    // per POST, destroyed when the response closes. createMcpServer may throw
    // (stub) — the outer guard turns that into a 500 JSON response.
    const server = createMcpServer(store);
    // SDK typings omit `| undefined` on optional props even though the SDK's own
    // docs construct the documented stateless mode with sessionIdGenerator:
    // undefined — that conflicts with exactOptionalPropertyTypes, hence the cast.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as StreamableHTTPServerTransportOptions);
    transports.add(transport);
    res.on("close", () => {
      void transport.close().finally(() => transports.delete(transport));
    });
    try {
      // Same exactOptionalPropertyTypes gap: the SDK class's optional handler
      // getters include undefined, the Transport interface doesn't.
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res);
    } catch (e) {
      // e.g. createMcpServer still a stub, or a transport-level failure —
      // handled here (not rethrown) so it stays a single 500 JSON response.
      // Client gets a generic body; the full error stays in the server log.
      console.error("[context-hub] MCP request failed:", e);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      }
      if (!res.writableEnded) res.end();
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (!isLoopbackHost(req)) {
        sendJson(res, 403, { error: "forbidden: Host header must be a loopback host" });
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (pathname === "/mcp") {
        if (req.method === "POST") {
          await handleMcpPost(req, res);
          return;
        }
        // stateless mode: no GET SSE stream, no DELETE session teardown
        res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed: use POST /mcp" }));
        return;
      }

      if (pathname === "/state") {
        if (req.method === "GET" || req.method === "HEAD") {
          await handleState(res);
          return;
        }
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed: use GET or HEAD /state" }));
        return;
      }

      if (pathname === "/mode") {
        if (req.method === "POST") {
          await handleModePost(req, res);
          return;
        }
        res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed: use POST /mode" }));
        return;
      }

      if (pathname === "/repair-meta") {
        if (req.method === "POST") {
          await handleRepairMetaPost(req, res);
          return;
        }
        res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed: use POST /repair-meta" }));
        return;
      }

      if (pathname === "/recover-record") {
        if (req.method === "POST") {
          await handleRecoverRecordPost(req, res);
          return;
        }
        res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed: use POST /recover-record" }));
        return;
      }

      sendJson(res, 404, { error: `not found: ${req.method} ${pathname}` });
    })().catch((e: unknown) => {
      // Last-resort guard: no crash, always a JSON response if possible.
      // Generic body to the client — the full error (which may contain
      // absolute file paths) goes to the server log only.
      console.error("[context-hub] request handler error:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      if (!res.writableEnded) res.end();
    });
  };

  const requestHandler = handler as RequestHandler;
  requestHandler.transports = transports;
  return requestHandler;
}

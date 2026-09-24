/**
 * tut CLI → Hub HTTP thin client.
 * Input/result types mirror the MCP tool schemas in src/mcp.ts (same source
 * of truth — the CLI layer never invents its own shape).
 *
 * `url` is the Hub BASE url (e.g. http://127.0.0.1:3001); every call appends
 * /mcp and speaks MCP over Streamable HTTP. Two consumption shapes:
 *
 * - One-shot (CLI): every call builds a FRESH Client + transport, connects,
 * calls, closes — the Hub serves /mcp statelessly, and a short-lived CLI
 * process must not leave keep-alive sockets behind at exit (hence
 * Connection: close on the one-shot requestInit).
 * - Resident (Notifier): `HubSession` connects ONCE and reuses the
 * Client + transport for every subsequent call — the MCP session handshake
 * (initialize + initialized) is paid once, and the underlying undici
 * keep-alive pool carries the per-call POSTs on one TCP connection instead
 * of ≥3 fresh connections per call. A transport-level failure drops the
 * session so the next call reconnects cleanly; a Hub tool error (isError
 * result) keeps it — the session itself is healthy.
 *
 * Every Hub fetch — one-shot or resident — is bounded by a per-request
 * AbortSignal timeout — a half-open connection can no longer hang a
 * CLI command or the Notifier's compare loop for minutes. Timeouts and
 * connection failures surface as HubError with a diagnosable code + the
 * endpoint named (HUB_TIMEOUT / HUB_UNREACHABLE / HUB_TRANSPORT_ERROR).
 *
 * Tool errors (isError results with code-first text, e.g. "TASK_NOT_FOUND: …")
 * throw HubError carrying the parsed first-line code so CLI callers can exit
 * non-zero with a parseable stderr line.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Cast, CheckoutRoute, ContextRecord, Flow, Warning } from "../common/types.js";

/** Structural twin of the SDK's FetchLike (its public name is a deep internal path — same shape, no deep import). */
type HubFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * CLI Hub calls are short-lived.  Do not leave an undici keep-alive socket
 * behind while the process is handing its exit code back to Node.
 */
const CLOSE_CONNECTION_REQUEST_INIT: RequestInit = {
  headers: { Connection: "close" },
};

/**
 * Per-request fetch timeout for EVERY Hub interaction. 10s:
 * local loopback hub calls answer in single-digit ms; anything slower is a
 * wedged/half-open connection that must fail diagnosably, not hang the CLI
 * (0.6.0 left fetch unbounded — a half-open TCP could pin a command for the
 * full OS timeout). Overridable per HubSession for tests.
 */
export const HUB_FETCH_TIMEOUT_MS = 10_000;

export class HubError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HubCreateInput {
  title: string;
  description: string;
  creator: string;
  role: string;
  /** Workflow variant: mirrors context.create's flow? — absent = "full". */
  flow?: Flow;
  /** Per-task cast routes: mirrors context.create's cast? — absent = default lineup. */
  cast?: Cast;
  /** Task-frozen checkout route; absent keeps the current checkout. */
  checkout?: CheckoutRoute;
}
export interface HubCreateResult {
  task_id: string;
  status: string;
  version: number;
}

export interface HubPublishInput {
  task_id: string;
  role: string;
  content_type: string;
  payload: {
    summary: string;
    body: string;
    verdict?: string;
    commits?: string[];
    ref_version?: number;
    [key: string]: unknown;
  };
  agent?: string;
  model?: string;
  expected_version?: number;
}
export interface HubPublishResult {
  task_id: string;
  version: number;
  status?: string;
  needs_attention?: boolean;
  warnings?: Warning[];
}

export interface HubReadResult {
  task_id: string;
  title: string;
  /** Task requirement text from creation; absent for project scope. */
  description?: string;
  /** Workflow variant, always present for task scope, normalized to "full". */
  flow?: Flow;
  /** Per-task cast routes: present only when the task carries one. */
  cast?: Cast;
  /** Task-frozen checkout route; absent keeps the current checkout. */
  checkout?: CheckoutRoute;
  status?: string;
  versions: ContextRecord[];
}

export interface HubListEntry {
  task_id: string;
  title: string;
  updated_at: string;
  /** Task's current record version. */
  version?: number;
  status?: string;
  waiting_for?: string;
  needs_attention?: boolean;
  scope?: "project";
  /** Workflow variant, always present for task scope, normalized to "full". */
  flow?: Flow;
  /** Per-task cast routes: present only when the task carries one. */
  cast?: Cast;
  /** Task-frozen checkout route; absent keeps the current checkout. */
  checkout?: CheckoutRoute;
}
export interface HubListResult {
  tasks: HubListEntry[];
}

export interface HubDecideInput {
  task_id: string;
  decision: "approve" | "reject" | "close";
  by: string;
  reason?: string;
}
export interface HubDecideResult {
  task_id: string;
  status?: string;
  version?: number;
}

export async function hubCreate(url: string, input: HubCreateInput): Promise<HubCreateResult> {
  // Exact mirror of context.create's input schema (title/description/creator/
  // role + optional flow); flow is omitted when absent so default creates stay
  // byte-identical on the wire.
  const args: Record<string, unknown> = { ...input };
  return (await callHubTool(url, "context.create", args)) as HubCreateResult;
}

export async function hubPublish(url: string, input: HubPublishInput): Promise<HubPublishResult> {
  // Mirrors context.publish: payload passes through verbatim (extend-only
  // envelope), optional fields are omitted when absent so the record never
  // grows empty-string/null artifacts.
  const args: Record<string, unknown> = {
    task_id: input.task_id,
    role: input.role,
    content_type: input.content_type,
    payload: input.payload,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.expected_version !== undefined ? { expected_version: input.expected_version } : {}),
  };
  return (await callHubTool(url, "context.publish", args)) as HubPublishResult;
}

export async function hubRead(url: string, taskId: string, sinceVersion?: number): Promise<HubReadResult> {
  return (await callHubTool(url, "context.read", {
    task_id: taskId,
    ...(sinceVersion !== undefined ? { since_version: sinceVersion } : {}),
  })) as HubReadResult;
}

export async function hubList(url: string, status?: string): Promise<HubListResult> {
  return (await callHubTool(url, "context.list", { ...(status !== undefined ? { status } : {}) })) as HubListResult;
}

export async function hubDecide(url: string, input: HubDecideInput): Promise<HubDecideResult> {
  return (await callHubTool(url, "context.decide", {
    task_id: input.task_id,
    decision: input.decision,
    by: input.by,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  })) as HubDecideResult;
}

// --- internals ---------------------------------------------------------------

/** MCP endpoint URL for a Hub BASE url; trailing slashes are tolerated. */
function mcpEndpoint(url: string): URL {
  return new URL(`${url.replace(/\/+$/, "")}/mcp`);
}

/**
 * fetch wrapper that bounds EVERY request with an AbortSignal timeout
 * (the per-request bound), composed with the transport's own abort signal (close must
 * still win immediately). AbortSignal.any: Node ≥ 20.3.
 */
export function timeoutFetch(timeoutMs: number): HubFetch {
  return (input: string | URL, init?: RequestInit) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal !== undefined && init.signal !== null
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return fetch(input, { ...init, signal });
  };
}

/**
 * Transport-level failures (fetch rejects: timeout abort, connection refused,
 * DNS, socket reset) → HubError with a diagnosable code and the endpoint
 * named. Hub tool errors (isError results) take the unwrap path
 * and never reach this function.
 */
function diagnoseTransportFailure(e: unknown, url: string, timeoutMs: number): HubError {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new HubError(
      "HUB_TIMEOUT",
      `hub ${url} did not answer within ${timeoutMs}ms (request aborted) — is the hub wedged? See: tut serve`,
    );
  }
  const cause = (e as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const causeCode = typeof cause?.code === "string" ? cause.code : undefined;
  if (name === "TypeError" || causeCode !== undefined || (e instanceof Error && /fetch failed|network/iu.test(e.message))) {
    const detail = causeCode ?? (e as Error)?.message ?? String(e);
    return new HubError(
      "HUB_UNREACHABLE",
      `cannot reach hub at ${url} (${detail}) — is the hub running? See: tut serve`,
    );
  }
  return new HubError("HUB_TRANSPORT_ERROR", `hub ${url}: ${(e as Error)?.message ?? String(e)}`);
}

/**
 * One stateless tool call: a fresh Client + StreamableHTTPClientTransport per
 * invocation, connected, called, and closed within this function — callers
 * never manage client lifecycle or leak sessions. Every request (handshake
 * included) is bounded by the per-request timeout fetch.
 */
async function callHubTool(url: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(mcpEndpoint(url), {
    requestInit: CLOSE_CONNECTION_REQUEST_INIT,
    fetch: timeoutFetch(HUB_FETCH_TIMEOUT_MS),
  });
  const client = new Client({ name: "tut-cli", version: "0.1.0" });
  try {
    // Same exactOptionalPropertyTypes gap as the server side (src/http.ts):
    // the SDK's optional `sessionId` getter includes undefined, the Transport
    // interface doesn't — cast rather than weaken the tsconfig.
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const result = await client.callTool({ name, arguments: args });
    return unwrapToolResult(result);
  } catch (e) {
    if (e instanceof HubError) throw e; // server answered with a tool error — not a transport failure
    throw diagnoseTransportFailure(e, url, HUB_FETCH_TIMEOUT_MS);
  } finally {
    await client.close().catch(() => undefined); // DELETE /mcp 405 on the stateless Hub is tolerated
  }
}

/**
 * Resident MCP session over the stateless Hub: ONE Client +
 * transport, connected lazily, REUSED for every call — the handshake is paid
 * once and undici's keep-alive pool carries the POSTs on one TCP connection
 * instead of ≥3 fresh connections per call (the 0.6.0 notifier opened a new
 * MCP session per auto-gate readLog, per candidate, per 5s poll).
 *
 * Failure protocol: a transport-level failure marks the session dead (the
 * NEXT call reconnects) and throws the diagnosed HubError for THIS call; a
 * Hub tool error (isError → HubError from unwrapToolResult) keeps the
 * session — the transport is healthy. No automatic retry: a call that may
 * have reached the hub must never be replayed blind (write tools could
 * double-land); callers treat the error and simply call again.
 */
export class HubSession {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Latched by close() — a closed session never reconnects. */
  private closed = false;

  constructor(url: string, opts?: { timeoutMs?: number; clientName?: string }) {
    this.url = url;
    this.timeoutMs = opts?.timeoutMs ?? HUB_FETCH_TIMEOUT_MS;
    this.clientName = opts?.clientName ?? "tut-session";
  }

  /** The Hub BASE url this session talks to (diagnostics). */
  get target(): string {
    return this.url;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureClient();
    try {
      const result = await client.callTool({ name, arguments: args });
      return unwrapToolResult(result);
    } catch (e) {
      if (e instanceof HubError) throw e; // hub answered — session still healthy
      await this.drop(client); // transport-level failure — force a fresh session next call
      throw diagnoseTransportFailure(e, this.url, this.timeoutMs);
    }
  }

  /**
   * Terminal teardown: idempotent, and SAFE against a handshake
   * still in flight. `closed` latches — every later call rejects instead of
   * silently reconnecting — and the connect completion checks it BEFORE
   * publishing the client, so a close that races the handshake can never
   * resurrect the session: the freshly-connected client is closed and the
   * waiting call fails with HUB_SESSION_CLOSED instead of proceeding on a
   * session the caller already tore down.
   */
  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (client !== null) await client.close().catch(() => undefined);
  }

  private ensureClient(): Promise<Client> {
    if (this.client !== null) return Promise.resolve(this.client);
    if (this.closed) {
      return Promise.reject(
        new HubError("HUB_SESSION_CLOSED", `hub session already closed (${this.url}) — create a new HubSession`),
      );
    }
    if (this.connecting !== null) return this.connecting;
    const transport = new StreamableHTTPClientTransport(mcpEndpoint(this.url), {
      fetch: timeoutFetch(this.timeoutMs), // NO Connection: close — keep-alive is the point
    });
    const client = new Client({ name: this.clientName, version: "0.1.0" });
    // Definite-assignment: the async body runs only after `connected` is
    // initialized (the IIFE's first await suspends), but TS cannot see that.
    let connected!: Promise<Client>;
    connected = (async () => {
      try {
        // Same exactOptionalPropertyTypes cast as callHubTool.
        await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
        if (this.closed) {
          // close() won the race against the handshake: never
          // publish the client — release the transport and fail the waiters.
          await client.close().catch(() => undefined);
          throw new HubError(
            "HUB_SESSION_CLOSED",
            `hub session closed while connecting to ${this.url} — the connection was discarded`,
          );
        }
        this.client = client;
        return client;
      } catch (e) {
        if (e instanceof HubError) throw e;
        // Connect failure must release the half-built client/transport too —
        // the session stays reusable, nothing may linger.
        await client.close().catch(() => undefined);
        throw diagnoseTransportFailure(e, this.url, this.timeoutMs);
      } finally {
        if (this.connecting === connected) this.connecting = null;
      }
    })();
    this.connecting = connected;
    return connected;
  }

  private async drop(client: Client): Promise<void> {
    if (this.client === client) this.client = null;
    if (this.connecting !== null) void this.connecting.catch(() => undefined);
    this.connecting = null;
    await client.close().catch(() => undefined);
  }
}

/** context.read through a resident HubSession (the notifier's incremental readLog leg). */
export async function hubReadVia(
  session: HubSession,
  taskId: string,
  sinceVersion?: number,
): Promise<HubReadResult> {
  return (await session.call("context.read", {
    task_id: taskId,
    ...(sinceVersion !== undefined ? { since_version: sinceVersion } : {}),
  })) as HubReadResult;
}

/** Minimal structural view of a tool result (the SDK's callTool return union also has task-shaped variants). */
interface ToolResultLike {
  isError?: boolean | undefined; // explicit undefined allowed: exactOptionalPropertyTypes
  content?: unknown;
  [key: string]: unknown; // the task-shaped union member carries no isError/content at all
}

/**
 * Decode the tool result text payload. Success → the store's JSON object.
 * isError → HubError with the first line's code prefix ("TASK_NOT_FOUND: …"
 * from StoreError mapping, "MCP error -32602: …" from zod envelope checks).
 */
function unwrapToolResult(result: ToolResultLike): unknown {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.find((b) => b.type === "text")?.text ?? "";
  if (result.isError === true) {
    const firstLine = text.split("\n")[0] ?? "";
    const colon = firstLine.indexOf(":");
    const code = colon === -1 ? firstLine : firstLine.slice(0, colon).trim();
    const message = colon === -1 ? firstLine : firstLine.slice(colon + 1).trim();
    throw new HubError(code.length > 0 ? code : "UNKNOWN_ERROR", message.length > 0 ? message : firstLine);
  }
  return JSON.parse(text); // success payloads are always JSON.stringify(storeResult)
}

/**
 * tut CLI → Hub HTTP thin client.
 * Input/result types mirror the MCP tool schemas in src/mcp.ts (same source
 * of truth — the CLI layer never invents its own shape).
 *
 * `url` is the Hub BASE url (e.g. http://127.0.0.1:3001); every call appends
 * /mcp and speaks MCP over Streamable HTTP with a FRESH SDK Client per call —
 * the Hub serves /mcp statelessly, so there is no session
 * to reuse and each call connects and closes cleanly.
 *
 * Tool errors (isError results with code-first text, e.g. "TASK_NOT_FOUND: …")
 * throw HubError carrying the parsed first-line code so CLI callers can exit
 * non-zero with a parseable stderr line.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Cast, ContextRecord, Flow, Warning } from "./types.js";

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
 * One stateless tool call: a fresh Client + StreamableHTTPClientTransport per
 * invocation, connected, called, and closed within this function — callers
 * never manage client lifecycle or leak sessions.
 */
async function callHubTool(url: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(mcpEndpoint(url));
  const client = new Client({ name: "tut-cli", version: "0.1.0" });
  try {
    // Same exactOptionalPropertyTypes gap as the server side (src/http.ts):
    // the SDK's optional `sessionId` getter includes undefined, the Transport
    // interface doesn't — cast rather than weaken the tsconfig.
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const result = await client.callTool({ name, arguments: args });
    return unwrapToolResult(result);
  } finally {
    await client.close().catch(() => undefined); // DELETE /mcp 405 on the stateless Hub is tolerated
  }
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

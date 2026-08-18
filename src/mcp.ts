/**
 * Context Hub MCP surface: the 5 tools of system-design 4.1.
 *
 * Thin adapter over the Store: every handler maps 1:1 to
 * a Store call, no business logic here. Result mapping follows the schema
 * field by field; error mapping: StoreError → tool result with
 * isError: true and text prefixed with the error code so agents can parse it.
 *
 * Schema philosophy: zod declares the envelope shape, the Store remains the
 * single validation authority for field content (non-empty summary/body etc.)
 * — envelope violations are caught by zod and (SDK 1.30, empirically
 * verified) surface as isError tool results with parseable text
 * ("MCP error -32602: ..."), the same first-line-readable shape StoreError
 * code prefixes produce; neither error kind is opaque to agents. content_type
 * and verdict accept any string (write-free principle, plan decisions 6/9):
 * a review with a nonsense verdict lands in the log with needs_attention, it
 * is never a write rejection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Store, StoreError } from "./store.js";
import type { Payload } from "./types.js";

/**
 * Run a Store operation and shape it as a tool result. Success → the result
 * object as machine-parseable JSON text. StoreError → isError with
 * "<CODE>: <message>" (first line is exactly the code prefix). Anything else
 * → isError with a generic message (no stack traces leaked to agents).
 */
async function runTool(op: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await op();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) {
    if (e instanceof StoreError) {
      return { content: [{ type: "text", text: `${e.code}: ${e.message}` }], isError: true };
    }
    console.error("[context-hub] unexpected error in tool handler:", e);
    return {
      content: [{ type: "text", text: "INTERNAL_ERROR: unexpected server error" }],
      isError: true,
    };
  }
}

const STATUS_ENUM = z.enum([
  "designing",
  "implementing",
  "reviewing",
  "revising",
  "pending_approval",
  "approved",
  "closed",
]);

/**
 * Workflow variant enum (system-design 3.1): full = design → implement →
 * review → human approval; direct = design already exists, start at
 * implementing (design records become reference notes); solo = small change,
 * review phase skipped (code_changes goes straight to human approval).
 */
const FLOW_ENUM = z.enum(["full", "direct", "solo"]);

/** Per-task cast (system-design 4.1): role → agent routing overrides. */
const CAST_ROLES_ENUM = z.enum(["architect", "executor", "reviewer"]);
const castSchema = z.record(CAST_ROLES_ENUM, z.string()).optional();

/** Payload envelope as a raw zod schema: extend-only passthrough (context-design 2.3/5). */
const payloadSchema = z
  .object({
    summary: z.string().optional(),
    body: z.string().optional(),
    verdict: z.string().optional(),
    commits: z.array(z.string()).optional(),
    ref_version: z.number().optional(),
    ack: z.boolean().optional(),
    decision: z.string().optional(),
  })
  .passthrough();

export function createMcpServer(store: Store): McpServer {
  const server = new McpServer({ name: "tut-context-hub", version: "0.1.0" });

  server.registerTool(
    "context.create",
    {
      description:
        "Create a new task in the shared Context Hub and get its task_id — call this before publishing any " +
        "context for a unit of work. Returns { task_id, status, version } with version 0 (creation writes no " +
        "record); the returned status follows the flow: \"designing\" for full/solo, \"implementing\" for direct. " +
        "flow picks the transition table and is immutable after creation (change = a new task): full = design → " +
        "implement → review → human approval (default); direct = the design already exists, work starts at " +
        "implementing (later design records are reference notes, no transition); solo = small change exempt from " +
        "review — code_changes goes straight to pending_approval (a review record in solo is a visible out-of-table " +
        "anomaly). role is the creator's role label (convention: \"architect\" | \"executor\" | \"reviewer\" | " +
        "\"human\"). cast optionally overrides the agent each role routes to for THIS task (role → agent name, " +
        "e.g. {executor: \"pi\"}); it is a routing parameter only — it never restricts who may publish — and is " +
        "immutable after creation, like flow.",
      inputSchema: {
        title: z.string(),
        description: z.string(),
        creator: z.string(),
        role: z.string(),
        flow: FLOW_ENUM.optional(),
        cast: castSchema,
      },
    },
    async (input) =>
      runTool(() =>
        store.createTask({
          title: input.title,
          description: input.description,
          creator: input.creator,
          role: input.role,
          ...(input.flow !== undefined ? { flow: input.flow } : {}),
          ...(input.cast !== undefined ? { cast: input.cast } : {}),
        }),
      ),
  );

  server.registerTool(
    "context.publish",
    {
      description:
        "Append a context record (design, code_changes, review, revision, note, decision — any content_type) to a " +
        "task. Appends are unconditional: no flow/role/order check ever rejects a write; only basic validity " +
        "(task exists, summary/body non-empty) errors. role convention: \"architect\" | \"executor\" | \"reviewer\" | " +
        "\"human\". For review records, payload.verdict must be exactly \"pass\" | \"fail_code\" | \"fail_design\" — " +
        "these exact strings drive the state machine; any other value still lands but sets needs_attention. " +
        "Returns { task_id, version, status, needs_attention, warnings? } for task scope, or { task_id, version } " +
        "for the project scope.",
      inputSchema: {
        task_id: z.string(),
        role: z.string(),
        content_type: z.string(),
        payload: payloadSchema,
        agent: z.string().optional(),
        model: z.string().optional(),
        expected_version: z.number().int().min(0).optional(),
      },
    },
    async (input) =>
      runTool(() =>
        store.append(input.task_id, {
          role: input.role,
          content_type: input.content_type,
          payload: input.payload as Payload, // cast: zod types summary/body optional, Store enforces non-empty
          // absent agent → no agent field on the record (decision 2b)
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.expected_version !== undefined ? { expected_version: input.expected_version } : {}),
        }),
      ),
  );

  server.registerTool(
    "context.read",
    {
      description:
        "Read a task's full record sequence plus its derived status; pass since_version to fetch only records at or " +
        "after that version for incremental sync. Returns { task_id, title, description, flow, cast?, status, versions } — " +
        "description is the task's requirement text from creation; flow is always present for task scope (normalized to " +
        "\"full\") and cast appears only when the task was created with one; the project scope has no status/flow/cast keys.",
      inputSchema: {
        task_id: z.string(),
        // Deliberately tighter than the Store contract (>= 0): record versions start at 1, so 0 is meaningless as a filter.
        since_version: z.number().int().min(1).optional(),
      },
    },
    async (input) =>
      runTool(() =>
        input.since_version !== undefined
          ? store.readTask(input.task_id, input.since_version)
          : store.readTask(input.task_id),
      ),
  );

  server.registerTool(
    "context.list",
    {
      description:
        "List all tasks with their derived status (optionally filtered by status). Returns { tasks: [...] } where " +
        "each entry carries task_id/title/updated_at/status/waiting_for/needs_attention/version plus flow (normalized " +
        "\"full\") and cast? when present; the project scope entry carries scope \"project\" instead of a status " +
        "and is only shown unfiltered.",
      inputSchema: {
        status: STATUS_ENUM.optional(),
      },
    },
    async (input) =>
      runTool(async () => ({
        tasks: input.status !== undefined ? await store.listTasks(input.status) : await store.listTasks(),
      })),
  );

  server.registerTool(
    "context.decide",
    {
      description:
        "Record a human decision — approve, reject, or close — on a task; this is the manual approval gate. " +
        "Appends a decision record (role \"human\", by as agent) and returns { task_id, status }; close is valid " +
        "from any state, approve/reject apply at pending_approval.",
      inputSchema: {
        task_id: z.string(),
        decision: z.enum(["approve", "reject", "close"]),
        by: z.string(),
        reason: z.string().optional(),
      },
    },
    async (input) => {
      const hasReason = typeof input.reason === "string" && input.reason.trim().length > 0;
      const reason = hasReason ? (input.reason as string) : "";
      // First non-empty line guards against a leading blank line producing an empty summary.
      const summary = hasReason
        ? ((reason.split("\n").find((line) => line.trim().length > 0)) ?? `decision: ${input.decision}`)
        : `decision: ${input.decision}`;
      const body = hasReason ? reason : `${input.by} decided ${input.decision}`;
      return runTool(async () => {
        const result = await store.append(input.task_id, {
          role: "human",
          content_type: "decision",
          agent: input.by,
          payload: { summary, body, decision: input.decision },
        });
        // Task scope → { task_id, status }; project scope (no derived status) → { task_id, version }.
        return result.status !== undefined
          ? { task_id: result.task_id, status: result.status }
          : { task_id: result.task_id, version: result.version };
      });
    },
  );

  return server;
}

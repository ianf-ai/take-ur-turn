/**
 * Context Hub MCP surface: create, publish, read, list, decide.
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
 * and verdict accept any string (write-free principle):
 * a review with a nonsense verdict lands in the log with needs_attention, it
 * is never a write rejection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Store, StoreError } from "./store.js";
import { worktreePathWarning } from "./checkout-warning.js";
import type { CheckoutRoute, Payload } from "../protocol/types.js";

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
 * Workflow variant enum: full = design → implement →
 * review → human approval; direct = design already exists, start at
 * implementing (design records become reference notes); solo = small change,
 * starts implementing, design/review phases skipped (code_changes goes straight to human approval).
 */
const FLOW_ENUM = z.enum(["full", "direct", "solo"]);

/** Per-task cast: legacy string or parameterized route. */
const CAST_ROLES_ENUM = z.enum(["architect", "executor", "reviewer"]);
const agentRouteSchema = z.union([
  z.string(),
  z.object({ agent: z.string(), args: z.array(z.string()) }),
]);
const castSchema = z.record(CAST_ROLES_ENUM, agentRouteSchema).optional();

/** Payload envelope as a raw zod schema: extend-only passthrough. */
const exitConditionItemSchema = z
  .object({
    id: z.number().int().min(1),
    verdict: z.enum(["满足", "不满足", "外部阻塞", "已批准延后"]),
    evidence: z.string(),
  })
  .passthrough();

/** Lossless raw-JSON union for exit_conditions. Every branch must return the
 *  INPUT VALUE ITSELF: zod object/record parses rebuild their output and copy
 *  passthrough keys via plain assignment, which silently drops legal JSON own
 *  keys such as "__proto__" (JSON.parse creates them as data properties; the
 *  assignment hits the prototype setter instead). So arrays ride through
 *  z.array(z.unknown()) — a fresh outer array over the ORIGINAL item objects —
 *  and objects ride through z.any() + a refinement, which never rebuilds. The
 *  trailing z.object passthrough branch never parses (any+refine already
 *  matched every object); it exists only to keep the "object" branch visible
 *  in tool discovery. */
const rawJsonValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.any().refine(
    (v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v),
    { message: "expected a JSON object" },
  ),
  z.object({}).passthrough(),
]);

/** Order matters: the raw union comes FIRST so every legal JSON value rides
 *  to the Store by reference; the canonical array branch below it never
 *  parses (any array already matched z.array(z.unknown()) above) and serves
 *  tool-discovery documentation of the canonical item shape only. Acceptance
 *  is unchanged — the canonical shape is a subset of the raw array branch —
 *  and malformed shapes stay diagnosable by the record lint, never rejected
 *  here. An array/unknown shorthand alone would lose the loose branches in
 *  this SDK's discovery output, so the explicit enumeration stays. */
const exitConditionsFieldSchema = z
  .union([rawJsonValueSchema, z.array(exitConditionItemSchema)])
  .optional();

const payloadSchema = z
  .object({
    summary: z.string().optional(),
    body: z.string().optional(),
    verdict: z.string().optional(),
    commits: z.array(z.string()).optional(),
    ref_version: z.number().optional(),
    ack: z.boolean().optional(),
    decision: z.string().optional(),
    exit_conditions: exitConditionsFieldSchema,
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
        "record); the returned status follows the flow: \"designing\" for full, \"implementing\" for direct/solo. " +
        "flow picks the transition table and is immutable after creation (change = a new task): full = design → " +
        "implement → review → human approval (default); direct = the design already exists, work starts at " +
        "implementing (later design records are reference notes, no transition); solo = small change, starts " +
        "implementing (design records are reference notes), exempt from review — code_changes goes straight to " +
        "pending_approval (a review record in solo is a visible out-of-table " +
        "anomaly). role is the creator's role label (convention: \"architect\" | \"executor\" | \"reviewer\" | " +
        "\"human\"). cast optionally overrides the agent command each role routes to for THIS task (role → route, " +
        "e.g. {executor: \"pi\"}); it is a routing parameter only — it never restricts who may publish — and is " +
        "immutable after creation, like flow. A route may be a legacy bare string or " +
        "{agent, args} with ordered shell-neutral argv words; parameterized values are " +
        "preserved without interpretation. checkout optionally freezes the execution checkout for this task: " +
        "{kind: \"current\"} preserves the anchor checkout; {kind: \"worktree\", path, ref?} points at a " +
        "pre-created worktree (path required — ref alone never launches, it may only annotate a path). " +
        "TUT does not create or remove git worktrees automatically; create warns (non-blocking) when the " +
        "path does not exist yet. Side effects: writes task metadata; the Notifier may subsequently launch an " +
        "agent and append a launch note in auto mode. Creation itself does not launch agents or clean up execution resources.",
      inputSchema: {
        title: z.string(),
        description: z.string(),
        creator: z.string(),
        role: z.string(),
        flow: FLOW_ENUM.optional(),
        cast: castSchema,
        checkout: z.union([
          z.object({ kind: z.literal("current") }),
          z
            .object({
              kind: z.literal("worktree"),
              path: z.string().optional(),
              ref: z.string().optional(),
            })
            .refine((route) => route.path !== undefined, {
              message: "worktree checkout requires a path; ref alone is not accepted (ref may only annotate a path)",
            }),
        ]).optional(),
      },
    },
    async (input) =>
      runTool(async () => {
        const result = await store.createTask({
          title: input.title,
          description: input.description,
          creator: input.creator,
          role: input.role,
          ...(input.flow !== undefined ? { flow: input.flow } : {}),
          ...(input.cast !== undefined ? { cast: input.cast } : {}),
          ...(input.checkout !== undefined ? { checkout: input.checkout as CheckoutRoute } : {}),
        });
        // Non-blocking typo mitigation: the route is frozen and never
        // repaired, so surface a missing path right at create time.
        const warning = [result.warning, worktreePathWarning(input.checkout as CheckoutRoute | undefined)].filter(Boolean).join("\n") || undefined;
        return warning === undefined ? result : { ...result, warning };
      }),
  );

  server.registerTool(
    "context.publish",
    {
      description:
        "Append a context record (design, code_changes, review, revision, note, decision — any content_type) to a " +
        "task. Appends are unconditional: no flow/role/order check ever rejects a write; only basic validity " +
        "(task exists, summary/body non-empty) errors. role convention: \"architect\" | \"executor\" | \"reviewer\" | " +
        "\"human\". For review records, payload.verdict must be exactly \"pass\" | \"blocked_external\" | " +
        "\"fail_code\" | \"fail_design\" (blocked_external: code fine, verification blocked on external conditions " +
        "— derives like pass) — these exact strings drive the state machine; any other value still lands but sets " +
        "needs_attention. payload.exit_conditions is the optional per-item exit-condition verdict array: canonical " +
        "items carry id (1-based position over the description's effective acceptance-condition sequence), verdict " +
        "(\"满足\" | \"不满足\" | \"外部阻塞\" | \"已批准延后\") and a non-placeholder evidence string, with extension keys " +
        "preserved; the raw JSON branch of the field exists only so miswritten material still saves — it is " +
        "diagnosed by the record lint, never a write rejection. The field feeds the diagnostic layer only; the " +
        "overall payload.verdict keeps being published independently and still derives the state. Returns " +
        "{ task_id, version, status, needs_attention, warnings? } for task scope, or " +
        "{ task_id, version } for the project scope. Side effects: appends an immutable record and updates metadata; " +
        "the derived change may cause the Notifier to notify, launch an agent, append a launch note, or clean up round execution resources.",
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
          // absent agent → no agent field on the record
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
        "\"full\"), cast and checkout appear only when the task was created with them; the project scope has no " +
        "status/flow/cast/checkout keys. Side effects: read-only; no record or metadata writes, agent launches, " +
        "launch notes, or cleanup.",
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
        "\"full\"), cast? and checkout? when present; the project scope entry carries scope \"project\" instead of " +
        "a status and is only shown unfiltered. Side effects: read-only; no record or metadata writes, agent launches, " +
        "launch notes, or cleanup.",
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
        "from any state, approve/reject apply at pending_approval. Side effects: appends an immutable human decision " +
        "and updates metadata; the Notifier may notify, launch an agent and append a launch note after reject, " +
        "or clean up round execution resources on handoff/closure.",
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

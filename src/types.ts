/**
 * Frozen seam contract. Any change here goes back to the Architect.
 * Sources: system-design.md §3 / §4.2, context-design.md §2.
 */

/** task_id of the project scope — derivation skips it (system-design 3.1). */
export const PROJECT_TASK_ID = "project";

/** Known content types (context-design 2.2). Unknown types must stay representable in records. */
export type ContentType =
  | "design"
  | "code_changes"
  | "review"
  | "revision"
  | "note"
  | "decision"
  | (string & {}); // accepts any string, keeps literal autocomplete (system-design 4.1: any content_type is accepted)

export type Status =
  | "designing"
  | "implementing"
  | "reviewing"
  | "revising"
  | "pending_approval"
  | "approved"
  | "closed";

/** system-design 3.1. Only meaningful on review records (context-design 2.3). */
export type Verdict = "pass" | "fail_code" | "fail_design";

/**
 * Workflow variant (system-design 3.1): selects the transition table.
 * Set at create time, immutable in meta.json afterwards; absent = "full"
 * (existing tasks and existing call sites need zero migration).
 */
export type Flow = "full" | "direct" | "solo";

/** A command route with explicit argv semantics (agent-command.ts). */
export interface AgentCommand {
  agent: string;
  args: string[];
}

/** Legacy bare agent name or a parameterized command. */
export type AgentRoute = string | AgentCommand;

/**
 * The two canonical launch doors and the legacy POSIX entry.  The request is
 * deliberately smaller than LaunchInvocation: it is the caller's intent
 * before route, target, naming, and execution context have been resolved.
 */
export type LaunchVia = "start-next" | "auto" | "legacy";

/** Route precedence is observable in the launch marker and must stay explicit. */
export type LaunchRouteSource =
  | "task-cast"
  | "workspace-project"
  | "workspace-user"
  | "builtin-default"
  | "legacy-explicit";

export interface LaunchRequest {
  kind: "round";
  task_id: string;
  role: string;
  fresh: boolean;
  via: LaunchVia;
  /** Undefined means no explicit route; an empty array is never canonical. */
  explicit_route_values?: string[];
}

/** The portable, task-record-safe subset of a launch plan. */
export interface LaunchMarkerProjection {
  protocol_version: 2;
  role: string;
  base_version: number;
  via: Exclude<LaunchVia, "legacy">;
  route: AgentCommand;
  route_source: LaunchRouteSource;
  target_kind: string;
  target_digest: string;
}

export interface LaunchAnchor {
  workspace_id: string;
  cwd: string;
  pane_id: string;
}

/**
 * Task-frozen checkout routing.  `current` keeps the legacy anchor checkout;
 * `worktree` names an already-created checkout.  The route is metadata, not a
 * git lifecycle instruction: automatic worktree creation remains out of scope.
 */
export type CheckoutRoute =
  | { kind: "current" }
  | { kind: "worktree"; path?: string; ref?: string };

export interface ExecutionContext {
  /** Herdr anchor; absent only for a dry-run/legacy degraded preview. */
  anchor?: LaunchAnchor;
  /** Caller cwd captured at the launcher boundary; never used as a birth anchor. */
  caller_cwd?: string;
  hubRoot: string;
  routingRoot: string;
  checkoutRoot: string;
  checkout: CheckoutRoute;
  context: { kind: "shared" };
  source: "anchor" | "project-root" | "placeholder" | "legacy";
}

export interface LaunchNaming {
  tab_label: string;
  pane_label: string;
}

/** POSIX keeps a bare executable; Windows target fields are added by its port. */
export interface PosixDirectPlan {
  executable: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * One immutable plan shared by the parent marker and the child launcher.
 * Platform-specific private fields are intentionally optional here: the
 * Windows target resolver and pane-runner add their fields without widening
 * the public Context Hub schema.
 */
export interface LaunchInvocation {
  protocol_version: 2;
  kind: "round";
  task_id: string;
  role: string;
  fresh: boolean;
  via: LaunchVia;
  base_version: number;
  hub_url: string;
  route: AgentCommand;
  route_source: LaunchRouteSource;
  context: ExecutionContext;
  naming: LaunchNaming;
  prompt: string;
  posix_direct?: PosixDirectPlan;
  resolved_target?: {
    kind: "native" | "node-entry";
    executable: string;
    prefix_args: string[];
    source_path: string;
  };
  effective_agent?: {
    executable: string;
    args: string[];
    env: Record<string, string>;
  };
  /** Omitted for the legacy thin-shim transport, which has no approval gate. */
  marker_projection?: LaunchMarkerProjection;
}

/**
 * Per-task cast (system-design 4.1): role → agent route, a ROUTING parameter
 * only — it tells the launcher which agent to raise for each role. Not a
 * participation roster (write freedom unchanged) and NOT consumed by
 * derivation (state-machine input signature untouched). Partial maps are
 * legal: missing roles fall back to the default lineup. Immutable in meta
 * after create, same as flow. Bare strings remain the on-disk compatibility
 * shape; parameterized commands use {agent,args}.
 */
export type Cast = Partial<Record<"architect" | "executor" | "reviewer", AgentRoute>>;

export type WaitingFor = "human" | "none" | `agent:${string}`;

/** Payload envelope (context-design 2.3) + extension fields the plan consumes. */
export interface Payload {
  summary: string;
  body: string;
  /** Review only. Missing/invalid verdict ⇒ no transition + needs_attention — never a write rejection (write-free principle). */
  verdict?: Verdict;
  commits?: string[];
  ref_version?: number;
  /** Note with ack === true clears warnings accumulated so far (preceding records only). */
  ack?: boolean;
  /** Decision only: the value of a human decision. */
  decision?: "approve" | "reject" | "close";
  /** Envelope is extend-only (context-design 2.3 / 5); derive ignores fields it does not consume. */
  [key: string]: unknown;
}

/** Single record, system-design 4.2. Named ContextRecord to avoid shadowing TS's built-in Record<K, V>. */
export interface ContextRecord {
  /** Starts at 1 and increments; create produces no record (version 0). */
  version: number;
  task_id: string;
  role: string;
  agent?: string;
  model?: string;
  content_type: ContentType;
  /** ISO 8601 UTC, generated by store on append; derive never consumes it (stays out of the contract). */
  timestamp: string;
  payload: Payload;
}

/**
 * Warning code vocabulary — shared with test/fixtures/sequences.json ($comment there mirrors this list).
 * Warnings are structured {version, code}; message text never enters the contract.
 */
export type WarningCode =
  | "OUT_OF_TABLE" // record does not fit current state: no fold, needs_attention
  | "CLOSED_ABSORB" // non-note/non-close record after closed: stays closed + needs_attention
  | "INVALID_VERDICT" // review with missing/invalid verdict: no transition + needs_attention
  | "VERSION_GAP" // version skips (e.g. v1 then v3): fold by version order anyway
  | "VERSION_DUPLICATE"; // repeated version: fold by version order anyway

export interface Warning {
  /** Version of the record responsible for the warning. */
  version: number;
  code: WarningCode;
}

/** Derivation output, system-design 3.1/3.2. needs_attention is an overlay flag, not an 8th status. */
export interface DerivedState {
  status: Status;
  waiting_for: WaitingFor;
  needs_attention: boolean;
  warnings: Warning[];
}

/**
 * Exact signature of derive (frozen seam, additive flow parameter). Pure:
 * no IO, no timestamp consumption, idempotent. flow selects the transition
 * table (system-design 3.1); absent = "full" (backward compatible).
 * Returns null for project scope (task_id "project").
 */
export type DeriveFn = (
  task_id: string,
  records: readonly ContextRecord[],
  flow?: Flow,
) => DerivedState | null;

/** Error codes — mcp.ts maps these to MCP errors; message text is not part of the contract. */
export const ErrorCode = {
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

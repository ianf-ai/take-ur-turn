/** Frozen v2 launch wire types. No runtime or compatibility-facade dependencies. */

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
  | "config-project"
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

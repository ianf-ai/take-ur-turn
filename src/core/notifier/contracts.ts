/** Shared state and injection contracts. No host implementation dependencies. */
import type { LaunchMode, LaunchCatchup } from '../common/config.js';
import type { ContextRecord, Cast, CheckoutRoute, AgentRoute, LaunchInvocation, LaunchMarkerProjection, LaunchRouteSource } from '../common/types.js';
import type { LaunchVia, NoteWake } from '../launcher/launch.js';
import type { WorkspaceConfigSnapshot } from '../common/workspace.js';
import type { PlatformExecutionPlan } from '../launcher/target-resolver.js';
import type { Channel, Notification } from '../common/channels.js';
export interface NotifyOptions {
  /** Hub BASE url (default http://127.0.0.1:3001); /state is appended. */
  url: string;
  /** Poll interval in seconds (default 5). */
  interval: number;
  /** Local port for the agent-event listener (default 3002). */
  eventPort: number;
  /** Stall timeout in minutes for agent:*-waiting tasks (default 30). */
  stallTimeoutMin: number;
  /**
   * Seconds after a successful launch with no matching working event before
   * the launch is alerted (default 300).  This is intentionally independent
   * from the long stall watchdog above: launch visibility is a short fuse.
   */
  workingTimeoutSec?: number;
  /** Programmatic spelling kept as an additive alias for callers that name the launch stage. */
  launchWorkingTimeoutSec?: number;
}

/** The frozen /state task fields (notify is top-level). `version`
 *  is optional so an older hub without it —
 *  or a test fixture — still type-checks; the merge log below simply no-ops. */
export interface StateTask {
  task_id: string;
  title: string;
  status: string;
  updated_at: string;
  needs_attention: boolean;
  waiting_for: string;
  version?: number;
  pending_since?: string | null;
  round_count?: number;
  /** Task's per-role cast overrides (absent on older hubs/fixtures). */
  cast?: Cast;
  /** Task-frozen checkout route (absent on older hubs/fixtures = current). */
  checkout?: CheckoutRoute;
}

/** The optional /state `auto` section: the launch whitelist.
 *  launch_roles is optional only for tolerance — an older hub or a fixture
 *  without it behaves as an empty whitelist (withhold all). */
export interface StateAuto {
  remediate?: "off" | "enter-repress";
  launch_roles?: string[];
}

export interface StateResponse {
  flow_mode: string;
  tasks: StateTask[];
  /** Storage-degraded tasks (system-design 4.3): ids that failed to
   *  fold. Optional — absent means none degraded (consumers treat absence as
   *  healthy); present only when non-empty on a corruption-aware hub. Older hubs/fixtures
   * without the key behave as "no degraded ids". */
  degraded?: string[];
  /** Optional channel config; interpreted by createChannels. */
  notify?: unknown;
  /** Optional auto-enablement config; the launch whitelist. */
  auto?: StateAuto;
}

export interface AgentEvent {
  /**
   * working / blocked / done are the agent-status events (Herdr signal
   * source).  delivery_giveup is emitted by the LAUNCHER (7.2.1): its
   * bounded delivery attempt is unconfirmed. Optional v2 evidence explains
   * the reason, but never proves prompt consumption.
   */
  event: "working" | "blocked" | "done" | "delivery_giveup";
  agent: string;
  pane: string;
  /** Optional v2 evidence is validated atomically; old fields are historical diagnostics. */
  delivery_v2?: unknown;
  box?: "held" | "cleared" | "unknown";
  transport?: boolean;
  probe?: "observed" | "failed" | "unavailable" | "not-attempted";
}

/** A pane-list row consumed by the done-event sweep. */
export interface PaneSnapshot {
  pane_id: string;
  label: string;
  /** Optional Herdr metadata retained for one-shot launch anchoring. */
  tab_id?: string;
  workspace_id?: string;
  cwd?: string;
  agent_status?: string;
}

/**
 * Event→task routing maps (agent-keyed). Empirically (herdr 0.8) the
 * pane.agent_status_changed payload carries NO task_id — the herdr plugin
 * resolves pane_id → pane label and passes it as `pane`. Two maps:
 *   - labelToAgent: pane label → agent identity. Agent-named panes (label ==
 *     agent, the fresh-session convention): identity is the label itself.
 *     Legacy workspace labels are RETIRED — the round
 *     pane prefix lookup (a½) and agent names cover every live consumer.
 *   - roleToAgent: role → default-lineup agent (cast-less tasks), resolved
 *     through the three-level chain (cwd as project root).
 */
export interface RoutingMaps {
  labelToAgent: Map<string, string>;
  roleToAgent: Map<string, string>;
}

/** Host-specific injection types are bound by the facade; shared consumers need no host imports. */
export interface NotifierDeps<Runtime = unknown, Remediation = unknown, Diagnostics = unknown> {
  readLaunchMode?(configRoot: string): Promise<LaunchMode>;
  /**
   * Strict startup-catchup switch reader (config key launch.catchup,
   * default "off"). Injectable for tests; a throw is logged as ONE visible
   * line and withholds the catchup pass (fail-visible, never a crash).
   */
  readLaunchCatchup?(configRoot: string): Promise<LaunchCatchup>;
  /** Task description reader for anchored checkout (defaults to context.read). */
  readTaskDescription?(taskId: string): Promise<string | undefined>;
  headlessRuntime?: Runtime;
  fetchState(url: string): Promise<StateResponse>;
  /** Backward-compatible injected launch seam for existing callers/tests. */
  launch(taskId: string, role: string, agent: string, args?: string[]): Promise<string>;
  /** Canonical launch seam: receives the same frozen invocation as the marker. */
  launchInvocation?(invocation: LaunchInvocation): Promise<string>;
  /**
   * Close-edge pane cleanup: reap `<task_id>.*`
   * for a task the poll just observed entering `closed`. Best-effort — a
   * rejection is logged as ONE line, never notified and never rethrown into
   * the compare. Injectable for tests.
   */
  cleanupPanes(taskId: string): Promise<void>;
  /** One best-effort host report per observed approval/attention edge. */
  relayHostStatus?(report: HostStatusReport, notify: unknown): Promise<void>;
  /** Full task log used by auto launch de-duplication; injectable for tests. */
  readLog(taskId: string): Promise<ContextRecord[]>;
  /**
   * Incremental readLog: pull the records the wire contract of
   * context.read's since_version returns for `sinceVersion` — INCLUSIVE
   * (version ≥ sinceVersion), exactly what a real Hub answers; 0 means
   * "everything" (the default wiring omits the field on the wire). The
   * notifier passes cached.version + 1 once a cache exists:
   * the inclusive wire parameter must be one PAST the cached maximum or
   * every quiet round would re-fetch and re-read the last record. The
   * notifier merges the reply into its per-task in-memory log cache and
   * serves dedup/generation scans from the merged view. Injectable for tests.
   */
  readLogSince?(taskId: string, sinceVersion: number): Promise<{ versions: ContextRecord[] }>;
  /** Append the optimistic launch marker before calling the launcher. */
  markLaunched(taskId: string, role: string, baseVersion: number, via: LaunchVia, projection?: LaunchMarkerProjection): Promise<unknown>;
  channelsFor(notifyCfg: unknown): Channel[];
  now(): number;
  log(line: string): void;
  /**
   * Pre-check for the auto door: resolve the launch target (cast →
   * workspace → routes) and verify the agent is on PATH. Runs BEFORE the
   * launch marker — a failure must leave no trace. Injectable for tests.
   */
  resolveTarget?(taskId: string, role: string): Promise<AgentRoute>;
  /** Canonical target seam retaining route provenance (and, on Windows, the
   * once-resolved platform plan) for the marker and the invocation. */
  resolveTargetWithSource?(
    taskId: string,
    role: string,
    projectRoot?: string,
    workspaceSnapshot?: WorkspaceConfigSnapshot,
  ): Promise<{ route: AgentRoute; source: LaunchRouteSource; plan?: PlatformExecutionPlan }>;
  /**
   * Routing maps for the event→task mapping (agent-keyed). Refreshed
   * every poll so workspace.json edits apply without a notifier restart.
   * Injectable for tests.
   */
  loadRouting?(): Promise<RoutingMaps>;
  /**
   * Pane inventory for the done-event sweep (herdr pane list). Injectable
   * for tests; the default spawns the real CLI.
   */
  listPanes?(): Promise<PaneSnapshot[]>;
  /**
   * Independent Herdr inventory for canonical launch anchoring.  Unlike the
   * done sweep, rows must carry workspace_id and cwd on the selected system
   * pane.  It is separate so a minimal sweep fixture can never become an
   * accidental birth anchor.
   */
  listAnchorPanes?(): Promise<PaneSnapshot[]>;
  /**
   * Visible-screen read of one pane for the done-event sweep (herdr pane
   * read --source visible). Injectable for tests.
   */
  readPane?(paneId: string): Promise<string>;
  remediator?: Remediation;
  remediationAudit?(taskId: string, role: string): Diagnostics;
}

export interface HostStatusReport {
  task_id: string;
  status: "pending_approval" | "needs_attention";
  waiting_for: string;
}

/** Callbacks into the single engine/cache/notification owners; never a second snapshot. */
export interface LaneContext {
  readonly snapshot: ReadonlyMap<string, StateTask> | null;
  log(line: string): void;
  sendAll(msg: Notification): Promise<void>;
  fullLog(taskId: string, entry?: StateTask): Promise<ContextRecord[]>;
  requestCompare(): Promise<void>;
  markProgress(taskId: string, now: number): void;
  autoLaunchFailed(task: StateTask, role: string, error: unknown): Promise<void>;
  autoLaunchSkipped(task: StateTask, role: string, version: number | undefined): Promise<void>;
  deferNoteWake(task: StateTask, wake: NoteWake, reason?: string): void;
  awaitSweepBarrier(taskId: string): Promise<void>;
  autoGateReason(task: StateTask): string | null;
  autoLaunch(task: StateTask, role: string, wake?: NoteWake): Promise<void>;
}

export interface TuiLanePort {
  refreshRouting(): Promise<void>;
  setRemediationMode(mode: "off" | "enter-repress"): void;
  retireObsoleteWorkingWatches(tasks: ReadonlyMap<string, StateTask>): Promise<void>;
  reportHostStatus(task: StateTask, status: HostStatusReport["status"], notify: unknown): void;
  cleanupClosedTask(taskId: string): void;
  awaitSweepBarrier(taskId: string): Promise<void>;
  launch(task: StateTask, role: string, baseVersion: number, wake?: NoteWake): Promise<void>;
}

export interface DetachedLanePort {
  observe(state: StateResponse): Promise<void>;
  reconcilePresence(tasks: ReadonlyMap<string, StateTask>): void;
  reconcileHeadlessDeliveries(state: StateResponse, now: number): Promise<void>;
  runStartupCatchup(state: StateResponse): Promise<void>;
  scanHumanWake(taskId: string, records: ContextRecord[], lower: number, upper: number): void;
  filterStoppedWakes(wakes: Map<string, NoteWake>): void;
  takeReadyWake(task: StateTask, state: StateResponse): NoteWake | undefined;
  coalesceBusy(task: StateTask, role: string, wake?: NoteWake): boolean;
  allowsNoteWake(taskId: string): boolean;
  autoLaunchHeadless(task: StateTask, role: string): Promise<void>;
  closeTask(task: StateTask): Promise<boolean>;
}


// --- notifier ----------------------------------------------------------------------

/**
 * Trust whitelist check: role-keyed array
 * membership in /state's `auto.launch_roles`. Absent, empty, or structurally
 * malformed (defensive against an older hub) → NOT whitelisted: the
 * conservative default withholds every auto launch.
 */
export function autoWhitelisted(auto: StateAuto | undefined, role: string): boolean {
  const roles = auto?.launch_roles;
  return Array.isArray(roles) && roles.includes(role);
}

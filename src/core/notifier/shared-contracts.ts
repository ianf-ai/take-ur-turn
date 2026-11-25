/** Host-neutral state, signals and injection contracts. */
import type { LaunchMode } from '../common/config.js';
import type { ContextRecord, Cast, CheckoutRoute, Flow, LaunchMarkerProjection } from '../../protocol/types.js';
import type { LaunchVia, NoteWake } from '../launcher/launch.js';
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
  /** The task's workflow flow, normalized (current hubs always send it per
   *  /state entry; absent on older hubs/fixtures = the "full" default).
   *  Selects the transition table for the launch dedup round boundary —
   *  consumers must thread it, never replay a direct/solo log under the
   *  full table (a plain worker note would misread as a reviewing→revising
   *  flip and wrongly clear a valid same-round marker). */
  flow?: Flow;
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
  /** Hub completeness evidence; absent/true cannot authorize completion consumption. */
  truncated?: boolean;
  /** Storage-degraded tasks: ids that failed to
   *  fold. Optional — absent means none degraded (consumers treat absence as
   *  healthy); present only when non-empty on a corruption-aware hub. Older hubs/fixtures
   * without the key behave as "no degraded ids". */
  degraded?: string[];
  /** Permanent manifest IDs; current disappearance evidence is carried separately. */
  pruned?: string[];
  /** Latest audit event per task; IDs distinguish a new prune after restoration. */
  prune_events?: Array<{ task_id: string; event_id: string; in_progress?: boolean }>;
  /** Optional channel config; interpreted by createChannels. */
  notify?: unknown;
  /** Optional auto-enablement config; the launch whitelist. */
  auto?: StateAuto;
}

export interface HostStatusReport {
  task_id: string;
  status: "pending_approval" | "needs_attention";
  waiting_for: string;
}

export interface SharedNotifierDeps {
  readLaunchMode?(configRoot: string): Promise<LaunchMode>;
  fetchState(url: string): Promise<StateResponse>;
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
}

export type ProgressSignal = { kind: 'progress'; task_id: string; observed_at: number };
export type RefreshSignal = { kind: 'refresh'; task_id?: string };
export type NotifierSignal = ProgressSignal | RefreshSignal;
export interface NotifierSignalSink {
  progress(signal: ProgressSignal): void;
  refresh(signal: RefreshSignal): Promise<void>;
}
export type NotifierConfigurationFacts = Readonly<{
  flow_mode: StateResponse['flow_mode'];
  auto: StateResponse['auto'];
}>;
export interface InteractiveLanePort {
  refreshBindings(): Promise<void>;
  acceptConfiguration(facts: NotifierConfigurationFacts): void;
  reconcileObservers(tasks: ReadonlyMap<string, StateTask>): Promise<void>;
  reportStatusEdge(task: StateTask, status: HostStatusReport['status'], notify: unknown): void;
  cleanupTaskResources(taskId: string): void;
  awaitTaskArchive(taskId: string): Promise<void>;
  launch(task: StateTask, role: string, baseVersion: number, wake?: NoteWake): Promise<void>;
}
export interface AgentEventEndpoint {
  accept(value: unknown): { status: number; body: Record<string, unknown> };
}
export interface NotifierPorts {
  interactive: InteractiveLanePort;
  detached: DetachedLanePort;
  agentEvents: AgentEventEndpoint;
}
export interface NotifierLaneContext {
  readonly snapshot: ReadonlyMap<string, StateTask> | null;
  log(line: string): void;
  sendAll(msg: Notification): Promise<void>;
  fullLog(taskId: string, entry?: StateTask): Promise<ContextRecord[]>;
  autoLaunchFailed(task: StateTask, role: string, error: unknown): Promise<void>;
  autoLaunchSkipped(task: StateTask, role: string, version: number | undefined): Promise<void>;
  deferNoteWake(task: StateTask, wake: NoteWake, reason?: string): void;
  autoGateReason(task: StateTask): string | null;
  autoLaunch(task: StateTask, role: string, wake?: NoteWake): Promise<void>;
  signals: NotifierSignalSink;
  awaitTaskArchive(taskId: string): Promise<void>;
}

export interface DetachedLanePort {
  /** Verified completed, notes-only markers; absent keeps log-only dedup. */
  completedLaunches?(task: StateTask, records: readonly ContextRecord[]): ReadonlySet<number>;
  observe(state: StateResponse): Promise<void>;
  reconcilePresence(tasks: ReadonlyMap<string, StateTask>): void;
  reconcileHeadlessDeliveries(state: StateResponse, now: number): Promise<void>;
  runStartupCatchup(state: StateResponse): Promise<void>;
  scanHumanWake(taskId: string, records: ContextRecord[], lower: number, upper: number): void;
  filterStoppedWakes(wakes: Map<string, NoteWake>): void;
  /** Whether a catch-up launch may act for the task: no observed stop
   *  boundary; a human instruction scanned after it; or a genuinely new
   *  round started after it (currentRoundStartedAt — the caller supplies the
   *  current round's flip timestamp from the same log read it dedups on). */
  catchupAllowed(taskId: string, currentRoundStartedAt?: number): boolean;
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

/** Herdr-owned raw events, routing, injections and legacy lane port. */
import type { AgentRoute, LaunchInvocation, LaunchRouteSource } from '../../protocol/types.js';
import type { WorkspaceConfigSnapshot } from '../../core/common/workspace.js';
import type { PlatformExecutionPlan } from '../../core/launcher/target-resolver.js';
import type { NoteWake } from '../../core/launcher/launch.js';
import type { NotifierLaneContext, StateTask, HostStatusReport } from '../../core/notifier/shared-contracts.js';

export interface AgentEvent {
  /**
   * working / blocked / done are the agent-status events (Herdr signal
   * source).  delivery_giveup is emitted by the launcher: its
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

export interface HerdrNotifierDeps<Remediation = unknown, Diagnostics = unknown> {
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

export interface HerdrLaneContext extends Pick<NotifierLaneContext,
  'snapshot' | 'log' | 'sendAll' | 'fullLog' | 'autoLaunchFailed' | 'autoLaunchSkipped' | 'deferNoteWake'> {
  requestCompare(): Promise<void>;
  markProgress(taskId: string, now: number): void;
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

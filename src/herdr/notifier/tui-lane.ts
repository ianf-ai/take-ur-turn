/** Herdr-only launch planning, child chains, auxiliary events and pane cleanup.
 * Done sweeps register their barriers synchronously and never join compare.
 * All event/working timers are owned here and disarmed by close(). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnterRepress, RemediationAttempts, type Remediator } from '../launcher/remediator.js';
import { createRemediationAudit, type DeliveryDiagnostics } from '../launcher/delivery.js';
import { parseDeliveryV2, giveUpGuidance } from '../launcher/escalation.js';
import { runInternalLaunch, runInternalLaunchInvocation, DEFAULT_CHILD_TIMEOUT_MS } from '../launcher/process.js';
import { requireBirthAnchor, resolveExecutionContext } from '../launcher/anchor.js';
import { HerdrClient } from '../launcher/legacy-herdr-client.js';
import { rigLabel, rigEnvironment, unscopedLabel } from '../../core/hub/rig.js';
import { commandHead, commandArgs } from '../../core/common/agent-command.js';
import { launchBlocked, resolveLaunchTargetWithSource, type NoteWake } from '../../core/launcher/launch.js';
import { buildLaunchInvocation } from '../../core/launcher/invocation.js';
import { AgentTargetError, UnsupportedWindowsShimError, planForPlatform, resolvePosixTargetPresence, type PlatformExecutionPlan } from '../../core/launcher/target-resolver.js';
import { KNOWN_ROLES, defaultUserConfigDir, readWorkspaceConfigSnapshot, resolveAgentRouteFromSnapshot, resolveTabLabelTemplateFromSnapshot, type WorkspaceConfigSnapshot } from '../../core/common/workspace.js';
import type { AgentCommand, AgentRoute, Cast, ContextRecord, ExecutionContext, LaunchInvocation, LaunchRequest, LaunchRouteSource } from '../../core/common/types.js';
import type { LaunchMode } from '../../core/common/config.js';
import type { AgentEvent, PaneSnapshot, StateTask, RoutingMaps, NotifyOptions, NotifierDeps, LaneContext, HostStatusReport } from '../../core/notifier/contracts.js';
type TuiDeps = Pick<NotifierDeps<unknown, Remediator, DeliveryDiagnostics>,
  'now' | 'fetchState' | 'launch' | 'launchInvocation' | 'markLaunched' | 'cleanupPanes' |
  'relayHostStatus' | 'loadRouting' | 'resolveTarget' | 'resolveTargetWithSource' |
  'listPanes' | 'listAnchorPanes' | 'readPane' | 'remediator' | 'remediationAudit'>;

/** Only a complete v2 block explains the outcome; legacy fields are diagnostic. */
function deliveryGiveUpHint(evt: Pick<AgentEvent, "delivery_v2">): string {
  const evidence = parseDeliveryV2(evt.delivery_v2);
  return `reason=${evidence?.reason ?? "unknown"} — ${giveUpGuidance()}`;
}

const GIVE_UP_NOTIFICATION_LIMIT = 1024;

interface WorkingWatch {
  task: StateTask;
  role: string;
  agent: string;
  /** Version of the launch marker, when the Hub returned one. */
  launchVersion?: number;
  timer: ReturnType<typeof setTimeout>;
}

interface InFlightLaunch {
  task: StateTask;
  role: string;
  agent: string;
  launchVersion?: number;
}

/** Rate-limit bookkeeping for one unmatched-event source (unmatched-event rate limit). */
interface UnmatchedSource {
  /** When the last degradation line was emitted for this source. */
  lastEmitAt: number;
  /** Events suppressed since the last emit (aggregate payload). */
  suppressed: number;
  byEvent: Map<string, number>;
  /** Fires at window expiry — `lastEmitAt + WINDOW` — flushing any pending
   *  aggregate (a silent flapping source still gets its line) and evicting
   *  the now-idle source entry. One timer per source at most. */
  flushTimer?: ReturnType<typeof setTimeout> | undefined;
}

/** Auto-door pre-check: resolve the routed agent, retain provenance, prove the target. */
async function defaultResolveTargetWithSource(
  url: string,
  taskId: string,
  role: string,
  projectRoot?: string,
  workspaceSnapshot?: WorkspaceConfigSnapshot,
): Promise<{ route: AgentRoute; source: LaunchRouteSource; plan?: PlatformExecutionPlan }> {
  const configuredRoot = projectRoot ?? process.env.TUT_PROJECT_ROOT;
  const target = await resolveLaunchTargetWithSource(
    url,
    taskId,
    role,
    workspaceSnapshot !== undefined
      ? { workspaceSnapshot }
      : configuredRoot !== undefined && configuredRoot.length > 0
        ? { projectRoot: configuredRoot }
        : {},
  );
  const route: AgentRoute = target.args !== undefined
    ? { agent: target.agent, args: [...target.args] }
    : target.agent;
  const agent = typeof route === "string" ? route : route.agent;
  // Target proof mirrors the human door: POSIX proves PATH presence before
  // the marker; Windows resolves its structured target once and carries the
  // whole plan forward (no second where.exe pass).
  let plan: PlatformExecutionPlan | undefined;
  try {
    if (process.platform === "win32") {
      plan = await planForPlatform(
        typeof route === "string" ? { agent: route, args: [] } : { agent: route.agent, args: [...route.args] },
        process.env,
      );
    } else {
      await resolvePosixTargetPresence(agent);
    }
  } catch (e) {
    if (e instanceof UnsupportedWindowsShimError || e instanceof AgentTargetError) {
      throw new Error(`routed agent '${agent}' fails its target pre-check: ${(e as Error).message}`);
    }
    throw e;
  }
  return {
    route,
    source: target.route_source ?? (target.cast?.[role as keyof Cast] === undefined ? "builtin-default" : "task-cast"),
    ...(plan !== undefined ? { plan } : {}),
  };
}

function routeSourceForTask(task: StateTask, role: string): LaunchRouteSource {
  return task.cast?.[role as keyof Cast] === undefined ? "builtin-default" : "task-cast";
}

function renderTabLabel(template: string, role: string, taskId: string, agent: string): string {
  const rendered = template
    .replaceAll("{role}", role)
    .replaceAll("{task}", taskId)
    .replaceAll("{agent}", agent);
  if (rendered.length === 0 || /[\u0000\r\n]/u.test(rendered)) {
    throw new Error("naming.tab_label renders to an invalid label");
  }
  return rendered;
}

/**
 * Freeze the auto-launch request after the state/dedup/preflight gates.  The
 * caller supplies the one-shot context snapshot; this planner only renders
 * the route and naming values from that snapshot into the invocation.
 * `preResolvedPlan` (from the default target resolver on Windows) keeps the
 * structured target single-resolved; injected test resolvers fall back to
 * the pure POSIX plan build.
 */
async function buildAutoInvocation(
  task: StateTask,
  role: string,
  route: AgentRoute,
  routeSource: LaunchRouteSource,
  baseVersion: number,
  hubUrl: string,
  context: ExecutionContext,
  workspaceSnapshot: WorkspaceConfigSnapshot,
  environment: NodeJS.ProcessEnv,
  preResolvedPlan?: PlatformExecutionPlan,
): Promise<LaunchInvocation> {
  const normalized: AgentCommand = { agent: commandHead(route), args: commandArgs(route) };
  const plan = preResolvedPlan ?? await planForPlatform(normalized, environment);
  const agentPlan = plan.platform === "posix" ? plan.posix_direct : plan.effective_agent;
  agentPlan.env = { ...agentPlan.env, ...rigEnvironment(context.hubRoot, hubUrl, environment.TUT_EVENT_PORT_URL || "http://127.0.0.1:3002/agent-event") };
  const template = resolveTabLabelTemplateFromSnapshot(workspaceSnapshot);
  const skillPath = fileURLToPath(new URL(`../../../skills/${role}.md`, import.meta.url));
  const request: LaunchRequest = {
    kind: "round",
    task_id: task.task_id,
    role,
    fresh: false,
    via: "auto",
  };
  return buildLaunchInvocation({
    request,
    base_version: baseVersion,
    hub_url: hubUrl,
    route: normalized,
    route_source: routeSource,
    context,
    naming: {
      tab_label: renderTabLabel(template, role, task.task_id, normalized.agent),
      pane_label: rigLabel(`${task.task_id}.${role}`, context.hubRoot),
    },
    prompt: `轮到你了（role: ${role}）：请用 Context Hub 读取任务 ${task.task_id} 的完整上下文（context.read），按你的 role skill（${skillPath}）开始本轮工作，完成后发布相应记录（context.publish）。`,
    ...(plan.platform === "posix"
      ? { posix_direct: plan.posix_direct }
      : { resolved_target: plan.resolved_target, effective_agent: plan.effective_agent }),
  });
}

/**
 * Compatibility export for callers that still provide a positional route.
 * Production Notifier auto mode uses spawnLaunchInvocation below, so the
 * route is not re-resolved or re-encoded at the child boundary.
 */
export async function spawnLaunch(
  taskId: string,
  role: string,
  agent: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await runInternalLaunch(
    [taskId, role, agent, ...args],
    { env, teeStderr: (chunk) => process.stderr.write(chunk) },
  );
  if (result.error !== undefined) throw result.error;
  if (result.timedOut === true) {
    throw new Error(`tut launch ${taskId} ${role} exceeded the child liveness budget (${DEFAULT_CHILD_TIMEOUT_MS}ms) and was killed`);
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim();
    throw new Error(`tut launch ${taskId} ${role} exited ${result.code ?? `signal ${result.signal}`}${tail ? `: ${tail}` : ""}`);
  }
  return result.stdout.trim();
}

/** Canonical Notifier child boundary: process.execPath + absolute dist/cli.js. */
export async function spawnLaunchInvocation(
  invocation: LaunchInvocation,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await runInternalLaunchInvocation(
    invocation,
    { env, teeStderr: (chunk) => process.stderr.write(chunk) },
  );
  if (result.error !== undefined) throw result.error;
  if (result.timedOut === true) {
    throw new Error(`tut launch ${invocation.task_id} ${invocation.role} exceeded the child liveness budget (${DEFAULT_CHILD_TIMEOUT_MS}ms) and was killed`);
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim();
    throw new Error(`tut launch ${invocation.task_id} ${invocation.role} exited ${result.code ?? `signal ${result.signal}`}${tail ? `: ${tail}` : ""}`);
  }
  return result.stdout.trim();
}

/**
 * Close-edge cleanup child: the same internal
 * `launch --cleanup <task_id>` boundary `tut decide close` spawns
 * synchronously — the notifier adds the consumer-side edge so a close that
 * landed through ANY entrance (including MCP decide) still reaps the task's
 * panes. Unlike the launch children there is no stderr tee: the daemon's
 * contract for this path is ONE diagnostic line, carried by the thrown
 * error's message (the child's stderr tail rides along).
 */
export async function spawnCleanupPanes(taskId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const result = await runInternalLaunch(["--cleanup", taskId], { env });
  if (result.error !== undefined) {
    throw new Error(`cannot run internal launcher: ${result.error.message}`);
  }
  if (result.timedOut === true) {
    throw new Error(`launch --cleanup ${taskId} exceeded the child liveness budget (${DEFAULT_CHILD_TIMEOUT_MS}ms) and was killed`);
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim();
    throw new Error(`launch --cleanup ${taskId} exited ${result.code ?? `signal ${result.signal}`}${tail ? `: ${tail}` : ""}`);
  }
}

function versionOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
}

/** Unmatched (reverse-lookup-miss) events from one source (pane+
 *  agent) emit their degradation line/notify once per window; the rest of
 *  the window only counts toward the next aggregate line. */
const UNMATCHED_EVENT_WINDOW_MS = 60_000;

/**
 * Default routing loader — exported for the fixture-driven chain test.
 * ONE workspace snapshot per call feeds every role — the
 * three-level chain reads (project + user workspace.json) happen once per
 * poll, not once per role (0.6.0 resolved each role independently: 3 roles ×
 * the same disk files every 5s). Optional root overrides keep tests hermetic.
 */
export async function defaultLoadRouting(
  opts?: { projectRoot?: string; userConfigDir?: string },
): Promise<RoutingMaps> {
  const labelToAgent = new Map<string, string>();
  const roleToAgent = new Map<string, string>();
  const snapshot = await readWorkspaceConfigSnapshot({
    ...(opts?.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    ...(opts?.userConfigDir !== undefined ? { userConfigDir: opts.userConfigDir } : {}),
  });
  for (const role of KNOWN_ROLES) {
    const resolved = await resolveAgentRouteFromSnapshot(role, undefined, snapshot); // never touches the filesystem again
    const agent = commandHead(resolved.route);
    roleToAgent.set(role, agent);
    labelToAgent.set(agent, agent); // agent-named pane → identity
  }
  return { labelToAgent, roleToAgent };
}

// --- done-event pane sweep (supply hardening) ---------------------------------------
// The final screen of a task's round panes is archived into the notify log
// when the agent's done event arrives — "agent did the work but never
// published" stays traceable even after the next round's launcher reaps
// the pane. Lines mirror the launcher's read primitive (--source visible,
// the only source reliable from birth).

const SWEEP_READ_LINES = 40;

const herdrClient = new HerdrClient();

async function defaultListPanes(): Promise<PaneSnapshot[]> {
  return (await herdrClient.paneList()).panes.map((pane) => ({
    pane_id: pane.pane_id,
    label: pane.label ?? "",
    ...(pane.tab_id !== undefined ? { tab_id: pane.tab_id } : {}),
    ...(pane.workspace_id !== undefined ? { workspace_id: pane.workspace_id } : {}),
    ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
    ...(pane.agent_status !== undefined ? { agent_status: pane.agent_status } : {}),
  }));
}

async function defaultReadPane(paneId: string): Promise<string> {
  return await herdrClient.paneRead(paneId, { source: "visible", lines: SWEEP_READ_LINES });
}

export class TuiLane {
  private readonly workingTimeoutMs: number;

  private remediationMode: "off" | "enter-repress" = "off";

  private readonly remediator: Remediator;

  private readonly remediationAttempts = new RemediationAttempts();

  private readonly remediationAudit: (taskId: string, role: string) => DeliveryDiagnostics;

  private closed = false;

  /** Routing maps for the event reverse lookup; null until first load. */
  private routing: RoutingMaps | null = null;

  /** Rate-limit state per unmatched-event source (key: pane + agent). */
  private unmatchedSources = new Map<string, UnmatchedSource>();

  /** Successful auto launches waiting for their first working signal. */
  private workingWatches = new Map<string, WorkingWatch>();

  /** Launches whose launcher promise has not returned yet. */
  private inFlightLaunches = new Map<string, InFlightLaunch>();

  /** Working signals observed while the launcher was still completing. */
  private earlyWorkingSignals = new Map<string, AgentEvent>();

  /**
   * Delivery give-ups observed while the launcher was still completing
   * (the launcher emits the event before its child exits, so in the real
   * auto sequence the give-up ALWAYS beats the launch return).  Consumed
   * when the launch returns: the short working fuse is NOT armed — the
   * give-up alert already reported this round's fate, and a generic
   * "no working signal" alarm five minutes later would be a false
   * duplicate.  Entry is dropped if the launch fails (nothing to suppress).
   */
  private earlyGiveUps = new Map<string, AgentEvent>();

  /** Working events that arrived before the next poll exposed their task. */
  private unresolvedWorkingEvents = new Set<string>();

  /**
   * Done-sweep barriers, per task: taskId → in-flight sweep promise.
   * autoLaunch awaits its OWN task's barrier at every launch-gating point,
   * so a poll compare racing the sweep cannot launch the next round (whose
   * launcher reaps the panes) before the screens are archived. The sweep
   * itself runs OUTSIDE the compare queue on purpose: a queue-serialized
   * sweep would deadlock against an in-flight compare whose autoLaunch is
   * already parked on it (the job could never start — the queue is busy).
   */
  private sweepBarriers = new Map<string, Promise<void>>();

  /**
   * Per task+role launcher-child chains (post-marker stage):
   * each new round's child waits for the previous one, but the chain runs
   * OFF the compare queue — a wedged launcher child can no longer freeze
   * every compare; it drags at most its own task.
   */
  private launchChains = new Map<string, Promise<void>>();

  private timers = new Set<ReturnType<typeof setTimeout>>();

  /** FIFO-bounded alert deduplication; old attempts may notify again after eviction. */
  private giveUpNotifications = new Set<string>();

  /** Resolved (non-optional) loaders built from deps. */
  private readonly routingLoader: () => Promise<RoutingMaps>;

  private readonly targetResolver: (taskId: string, role: string) => Promise<AgentRoute>;

  private readonly targetSourceResolver: (
    taskId: string,
    role: string,
    projectRoot?: string,
    workspaceSnapshot?: WorkspaceConfigSnapshot,
  ) => Promise<{ route: AgentRoute; source: LaunchRouteSource; plan?: PlatformExecutionPlan }>;

  private readonly paneLister: () => Promise<PaneSnapshot[]>;

  private readonly anchorPaneLister: () => Promise<PaneSnapshot[]>;

  private readonly paneReader: (paneId: string) => Promise<string>;

  constructor(
    private readonly options: NotifyOptions,
    private readonly rigRoot: string,
    private readonly context: Pick<LaneContext,
      'snapshot' | 'log' | 'sendAll' | 'fullLog' | 'requestCompare' | 'markProgress' |
      'autoLaunchFailed' | 'autoLaunchSkipped' | 'deferNoteWake'>,
    private readonly deps: TuiDeps,
    private readonly launchModeReader: (root: string) => Promise<LaunchMode>,
  ) {
    const workingTimeoutSec = options.workingTimeoutSec ?? options.launchWorkingTimeoutSec ?? 300;
    this.workingTimeoutMs = Math.max(0, Number.isFinite(workingTimeoutSec) ? workingTimeoutSec : 300) * 1000;
    this.remediator = deps.remediator ?? createEnterRepress();
    this.remediationAudit = deps.remediationAudit ?? ((taskId, role) => createRemediationAudit({ env: { ...process.env, TUT_PROJECT_ROOT: rigRoot }, task_id: taskId, role, stderr: text => this.context.log(text.trimEnd()) }));
    this.routingLoader = deps.loadRouting ?? defaultLoadRouting;
    this.targetResolver = deps.resolveTarget ?? (async (taskId, role) => (await defaultResolveTargetWithSource(options.url, taskId, role)).route);
    this.targetSourceResolver = deps.resolveTargetWithSource !== undefined
      ? (taskId, role, projectRoot, workspaceSnapshot) => deps.resolveTargetWithSource!(taskId, role, projectRoot, workspaceSnapshot)
      : deps.resolveTarget === undefined
        ? (taskId, role, projectRoot, workspaceSnapshot) => defaultResolveTargetWithSource(options.url, taskId, role, projectRoot, workspaceSnapshot)
        : async (taskId, role) => ({ route: await this.targetResolver(taskId, role), source: 'builtin-default' as const });
    this.paneLister = deps.listPanes ?? defaultListPanes;
    this.anchorPaneLister = deps.listAnchorPanes ?? defaultListPanes;
    this.paneReader = deps.readPane ?? defaultReadPane;
  }
  private get stateUrl(): string { return this.options.url.replace(/\/+$/, '') + '/state'; }
  private get intervalMs(): number { return Math.max(1, this.options.interval) * 1000; }
  private get eventPort(): number { return this.options.eventPort; }
  setRemediationMode(mode: 'off' | 'enter-repress'): void { this.remediationMode = mode; }
  async refreshRouting(): Promise<void> {
    try { this.routing = await this.routingLoader(); }
    catch (e) { this.context.log(`routing map reload failed: ${(e as Error).message}; keeping previous`); }
  }
  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.workingWatches.clear(); this.inFlightLaunches.clear(); this.launchChains.clear();
    this.earlyWorkingSignals.clear(); this.earlyGiveUps.clear(); this.unresolvedWorkingEvents.clear();
    this.giveUpNotifications.clear(); this.sweepBarriers.clear(); this.unmatchedSources.clear();
  }

  // --- launch → working visibility -----------------------------------------------

  private workingWatchKey(taskId: string, role: string): string {
    return `${taskId}\u0000${role}`;
  }

  private armWorkingWatch(task: StateTask, role: string, agent: string, launchVersion?: number): void {
    if (this.closed) return;
    const key = this.workingWatchKey(task.task_id, role);
    const previous = this.workingWatches.get(key);
    if (previous !== undefined) {
      clearTimeout(previous.timer);
      this.timers.delete(previous.timer);
    }

    let watch!: WorkingWatch;
    const timer = setTimeout(() => {
      this.workingWatches.delete(key);
      this.timers.delete(timer);
      void this.handleWorkingTimeout(key, watch);
    }, this.workingTimeoutMs);
    watch = { task, role, agent, ...(launchVersion !== undefined ? { launchVersion } : {}), timer };
    this.workingWatches.set(key, watch);
    this.timers.add(timer);
  }

  private async launchGenerationSuperseded(
    taskId: string,
    launchVersion: number,
    entry?: StateTask,
  ): Promise<boolean | undefined> {
    try {
      const records = await this.context.fullLog(taskId, entry);
      return records.some(
        (record) => record.version > launchVersion && record.content_type !== "note",
      );
    } catch (e) {
      this.context.log(
        `[${taskId}] could not inspect launch generation v${launchVersion}: ${(e as Error).message}`,
      );
      return undefined;
    }
  }

  async retireObsoleteWorkingWatches(currentTasks: ReadonlyMap<string, StateTask>): Promise<void> {
    for (const [key, watch] of this.workingWatches) {
      const current = currentTasks.get(watch.task.task_id);
      if (current === undefined || current.waiting_for !== `agent:${watch.role}`) {
        this.clearWorkingWatch(key);
        continue;
      }
      // The launch marker is the generation anchor. Ordinary task-scope notes
      // also advance the task version but do not start a new round, so inspect
      // the full log before retiring a watch. Only a later non-note record
      // proves that the task has progressed beyond this launch generation.
      const launchVersion = watch.launchVersion;
      if (launchVersion === undefined || current.version === undefined || current.version <= launchVersion) continue;
      const superseded = await this.launchGenerationSuperseded(watch.task.task_id, launchVersion, current);
      // A failed diagnostic read must not turn a still-valid watch into a
      // silent timeout. The timer remains armed and the next poll retries.
      if (superseded !== true) continue;
      this.clearWorkingWatch(key);
      this.context.log(`[${watch.task.task_id}] retired stale ${watch.role} working watch at task version ${current.version}`);
    }
  }

  private clearWorkingWatch(key: string): WorkingWatch | undefined {
    const watch = this.workingWatches.get(key);
    if (watch === undefined) return undefined;
    clearTimeout(watch.timer);
    this.timers.delete(watch.timer);
    this.workingWatches.delete(key);
    return watch;
  }

  private roundRoleFromPane(taskId: string, pane: string): string | undefined {
    const label = unscopedLabel(pane.trim(), this.rigRoot) ?? pane.trim();
    const prefix = `${taskId}.`;
    if (!label.startsWith(prefix)) return undefined;
    const role = label.slice(prefix.length).split(".", 1)[0];
    return role !== undefined && role.length > 0 ? role : undefined;
  }

  private async workingWatchForEvent(evt: AgentEvent, taskId: string): Promise<{ key: string; watch: WorkingWatch } | undefined> {
    const task = this.context.snapshot?.get(taskId);
    const paneRole = this.roundRoleFromPane(taskId, evt.pane);
    for (const [key, watch] of this.workingWatches) {
      if (watch.task.task_id !== taskId) continue;
      if (task?.waiting_for !== `agent:${watch.role}`) continue;
      if (paneRole !== undefined && watch.role !== paneRole) continue;
      // A prefix can still resolve a legacy/suffixed pane to the task, but a
      // working watch may only be cleared by the exact current round key.
      if (paneRole !== undefined && (unscopedLabel(evt.pane.trim(), this.rigRoot) ?? evt.pane.trim()) !== `${taskId}.${watch.role}`) continue;
      if (watch.launchVersion !== undefined && task?.version !== undefined && task.version > watch.launchVersion) {
        const superseded = await this.launchGenerationSuperseded(taskId, watch.launchVersion);
        // Notes advance task.version without changing the launch generation;
        // a non-note after the marker retires the watch. Unknown generation
        // status is treated as stale for event matching so no event can clear
        // a fuse while its provenance is unreadable.
        if (superseded !== false) continue;
      }
      // Herdr normally supplies the recognized agent identity. Empty is
      // tolerated for older signal sources; a non-empty mismatch must not
      // clear another agent's launch fuse.
      if (evt.agent.length > 0 && evt.agent !== watch.agent) continue;
      if (paneRole === undefined && task?.waiting_for !== `agent:${watch.role}`) continue;
      if (this.workingWatches.get(key) !== watch) continue;
      return { key, watch };
    }
    return undefined;
  }

  private async inFlightLaunchForEvent(evt: AgentEvent, taskId: string): Promise<{ key: string; launch: InFlightLaunch } | undefined> {
    const task = this.context.snapshot?.get(taskId);
    const paneRole = this.roundRoleFromPane(taskId, evt.pane);
    for (const [key, launch] of this.inFlightLaunches) {
      if (launch.task.task_id !== taskId) continue;
      if (task?.waiting_for !== `agent:${launch.role}`) continue;
      if (paneRole !== undefined && launch.role !== paneRole) continue;
      if (paneRole !== undefined && (unscopedLabel(evt.pane.trim(), this.rigRoot) ?? evt.pane.trim()) !== `${taskId}.${launch.role}`) continue;
      if (launch.launchVersion !== undefined && task?.version !== undefined && task.version > launch.launchVersion) {
        const superseded = await this.launchGenerationSuperseded(taskId, launch.launchVersion);
        if (superseded !== false) continue;
      }
      if (evt.agent.length > 0 && evt.agent !== launch.agent) continue;
      if (this.inFlightLaunches.get(key) !== launch) continue;
      return { key, launch };
    }
    return undefined;
  }

  private workingEventMatchesCurrentTask(evt: AgentEvent, taskId: string): boolean {
    const task = this.context.snapshot?.get(taskId);
    if (task === undefined || !task.waiting_for.startsWith("agent:")) return false;
    const currentRole = task.waiting_for.slice("agent:".length);
    const paneRole = this.roundRoleFromPane(taskId, evt.pane);
    if (paneRole !== undefined) {
      return paneRole === currentRole && (unscopedLabel(evt.pane.trim(), this.rigRoot) ?? evt.pane.trim()) === `${taskId}.${currentRole}`;
    }
    // Bare task-id panes and agent-named panes are the legacy/identity paths;
    // resolveEventTask already validated the task/agent relationship before
    // this helper is reached.
    return true;
  }

  private async handleWorkingSignal(evt: AgentEvent, taskId: string): Promise<void> {
    const hit = await this.workingWatchForEvent(evt, taskId);
    if (hit === undefined) {
      const inFlight = await this.inFlightLaunchForEvent(evt, taskId);
      if (inFlight !== undefined) {
        this.context.markProgress(taskId, this.deps.now());
        if (taskId !== evt.pane) {
          this.context.log(`working event pane '${evt.pane}' resolved to task ${taskId} (role-pane mapping)`);
        }
        this.earlyWorkingSignals.set(inFlight.key, evt);
        this.context.log(`[${taskId}] working signal arrived while ${inFlight.launch.role} launch was still completing`);
      } else if (this.workingEventMatchesCurrentTask(evt, taskId)) {
        // Stall-clock policy: an UNWATCHED working event no longer
        // refreshes the stall watchdog — the realistic failure was herdr
        // status flapping (working↔blocked oscillation with no hub progress)
        // renewing the clock forever.  Only real progress renews: the first
        // working after a launch (the watch-hit path above, or the in-flight
        // path) and any updated_at/version advance (checkStalls).
        if (taskId !== evt.pane) {
          this.context.log(`working event pane '${evt.pane}' resolved to task ${taskId} (role-pane mapping)`);
        }
      }
      return;
    }
    this.context.markProgress(taskId, this.deps.now());
    if (taskId !== evt.pane) {
      this.context.log(`working event pane '${evt.pane}' resolved to task ${taskId} (role-pane mapping)`);
    }
    this.clearWorkingWatch(hit.key);
    this.context.log(`[${taskId}] working signal received for ${hit.watch.role} (agent ${evt.agent || hit.watch.agent})`);
    void this.context.sendAll({
      title: `TUT ${taskId}: agent working`,
      body: `${hit.watch.task.title} — working signal received for ${hit.watch.role} in pane ${taskId}.${hit.watch.role}; launch hand-off is alive`,
      task_id: taskId,
    });
  }

  /**
   * Escalate an unconfirmed delivery immediately through configured channels.
   * A valid v2 block supplies the reason; every event uses conditional manual
   * guidance without interpreting legacy box evidence as permission.
   *
   * Deliberately does NOT mark progress: a give-up is the opposite of
   * progress, so the stall watchdog keeps its clock as the backstop
   * reminder.  A matching live working watch IS disarmed — the give-up
   * alert is the "no working signal" report with better precision than the
   * generic short fuse; if the human presses Enter afterwards, the late
   * working signal still marks progress like any unwatched round.
   */
  private async handleDeliveryGiveUp(evt: AgentEvent, taskId: string | null): Promise<void> {
    const receivedAt = new Date(this.deps.now()).toISOString();
    if (taskId === null) {
      // Same rate-limited degradation as the other unmatched events.
      const agg = this.rateLimitUnmatched(evt);
      if (agg !== null) {
        this.context.log(`delivery give-up event pane '${evt.pane}' matches no task (4.4 convention broken)${agg}`);
        void this.context.sendAll({
          title: `TUT ${evt.pane}: prompt delivery gave up`,
          body: `Prompt delivery to pane ${evt.pane} gave up — ${deliveryGiveUpHint(evt)}; received_at=${receivedAt}`,
        });
      }
      return;
    }
    const hit = await this.workingWatchForEvent(evt, taskId);
    if (hit !== undefined) {
      this.clearWorkingWatch(hit.key);
      this.context.log(`[${taskId}] delivery give-up received for ${hit.watch.role}; short working fuse disarmed (this alert replaces it)`);
    } else {
      // Real auto ordering: the launcher child emits this event BEFORE it
      // exits, so the give-up beats the launch return — no live watch yet.
      // Record against the in-flight launch so the fuse is never armed for
      // this round (same shape as earlyWorkingSignals). No markProgress:
      // the stall watchdog keeps its clock.
      const inFlight = await this.inFlightLaunchForEvent(evt, taskId);
      if (inFlight !== undefined) {
        this.earlyGiveUps.set(inFlight.key, evt);
        this.context.log(`[${taskId}] delivery give-up arrived while the ${inFlight.launch.role} launch was still completing; short fuse will not be armed`);
      }
    }
    const paneRole = this.roundRoleFromPane(taskId, evt.pane);
    const evidence = parseDeliveryV2(evt.delivery_v2);
    if (this.remediationMode === "enter-repress" && evidence && paneRole) {
      const task = this.context.snapshot?.get(taskId);
      const eligible = (current: StateTask | undefined) => !!task && !!current &&
        current.status === task.status && current.waiting_for === `agent:${paneRole}` && !current.needs_attention &&
        (paneRole === 'architect' ? current.status === 'designing' :
          paneRole === 'reviewer' ? current.status === 'reviewing' : ['implementing', 'revising'].includes(current.status));
      let stopped = false;
      const canAct = async () => {
        if (stopped || this.closed || this.remediationMode !== 'enter-repress' || !eligible(this.context.snapshot?.get(taskId))) {
          stopped = true;
          return false;
        }
        try {
          // Read through HTTP without running another compare/launch cycle.
          // Notes may advance version while the same role round remains active.
          const latest = await this.deps.fetchState(`${this.stateUrl}?include=closed`);
          const enabled = (latest.auto?.remediate ?? (latest.flow_mode === 'auto' ? 'enter-repress' : 'off')) === 'enter-repress';
          stopped = this.closed || this.remediationMode !== 'enter-repress' || !enabled || (latest.degraded ?? []).includes(taskId) ||
            !eligible(latest.tasks.find(t => t.task_id === taskId)) || !eligible(this.context.snapshot?.get(taskId));
        } catch { stopped = true; }
        return !stopped;
      };
      if (await canAct()) {
        const claim = this.remediationAttempts.claim(evidence.attempt_id);
        if (claim === 'duplicate') return;
        if (claim === 'full') {
          this.context.log(`[${taskId}] remediation attempt capacity reached; escalating manually without another key`);
        } else try {
          const sink = this.remediationAudit(taskId, paneRole);
          const recordAction = async (remediation: import('../launcher/remediator.js').RemediationEvidence) => {
            sink.emit(`remediation pane=${evidence.pane_id} delivery_v2=${JSON.stringify({ ...evidence, remediation })}`);
            await sink.flush();
          };
          const remediation = await this.remediator.remediate({ agent: evt.agent, pane: evt.pane, evidence, canAct, recordAction });
          sink.emit(`remediation pane=${evidence.pane_id} delivery_v2=${JSON.stringify({ ...evidence, remediation })}`);
          await sink.flush();
          if (remediation.result === "working-observed") {
            await this.handleWorkingSignal(evt, taskId);
            await this.context.sendAll({
              title: `TUT ${taskId}: machine remediation`,
              body: `${taskId} — 机器补救：机器代按 Enter 后观察到 working（${remediation.strategy}）；非输入消费证明`, task_id: taskId
            });
            return;
          }
          if (remediation.action === "machine-enter") this.context.log(`[${taskId}] 二次 give-up：机器代按 Enter 后未确认翻转，升级人工，不再补按`);
        } catch (error) {
          this.context.log(`[${taskId}] remediation failed; escalating manually: ${(error as Error).message}`);
        }
      }
    }
    const notificationKey = JSON.stringify([taskId, evt.pane, evt.agent,
      evidence?.attempt_id ?? this.context.snapshot?.get(taskId)?.version ?? 0]);
    if (this.giveUpNotifications.has(notificationKey)) return;
    this.giveUpNotifications.add(notificationKey);
    if (this.giveUpNotifications.size > GIVE_UP_NOTIFICATION_LIMIT) {
      this.giveUpNotifications.delete(this.giveUpNotifications.values().next().value!);
    }
    const roleSeg = paneRole !== undefined ? ` for ${paneRole}` : "";
    const via = taskId !== evt.pane ? ` (pane ${evt.pane})` : "";
    const hint = deliveryGiveUpHint(evt);
    this.context.log(`[${taskId}] delivery gave up${roleSeg}${via} — ${hint}`);
    const title = this.context.snapshot?.get(taskId)?.title ?? taskId;
    await this.context.sendAll({
      title: `TUT ${taskId}: prompt delivery gave up`,
      body: `${taskId}: ${title} — prompt delivery${roleSeg}${via} gave up: ${hint}; received_at=${receivedAt}`,
      task_id: taskId,
    });
  }

  private async handleWorkingTimeout(key: string, watch: WorkingWatch): Promise<void> {
    // A publish/decision may have advanced or closed the task while the
    // signal was in flight. In that case the workflow itself is evidence of
    // progress; do not raise a stale launch alarm.
    const current = this.context.snapshot?.get(watch.task.task_id);
    if (current === undefined || current.waiting_for !== `agent:${watch.role}`) return;
    const seconds = Math.ceil(this.workingTimeoutMs / 1000);
    this.context.log(`[${watch.task.task_id}] launch working timeout for ${watch.role} after ${seconds}s; no working signal observed`);
    await this.context.sendAll({
      title: `TUT ${watch.task.task_id}: launch attempt completed; delivery confirmation is not implied — no working signal`,
      body: `${watch.task.title} — ${watch.role} launch attempt completed via tut launch, but no working signal arrived within ${seconds}s; intervene manually`,
      task_id: watch.task.task_id,
    });
    // Keep the key in the method signature so a future repeated-watch policy
    // cannot accidentally alert a replacement round.
    void key;
  }

  private queueUnresolvedWorkingEvent(evt: AgentEvent): void {
    const key = `${evt.agent}\u0000${evt.pane}`;
    if (this.unresolvedWorkingEvents.has(key)) return;
    this.unresolvedWorkingEvents.add(key);
    void this.context.requestCompare()
      .then(async () => {
        this.unresolvedWorkingEvents.delete(key);
        const taskId = this.resolveEventTask(evt.pane);
        if (taskId !== null) {
          await this.handleWorkingSignal(evt, taskId);
          return;
        }
        // Still unmatched after the catch-up compare — rate-limited.
        const agg = this.rateLimitUnmatched(evt);
        if (agg !== null) {
          this.context.log(`working event pane '${evt.pane}' resolves to no task; stall refresh skipped${agg}`);
        }
      })
      .catch((e: unknown) => {
        this.unresolvedWorkingEvents.delete(key);
        this.context.log(`working event pane '${evt.pane}' could not be re-resolved: ${(e as Error).message}`);
      });
  }

  // --- agent events ------------------------------------------------------------------

  /**
   * Event→task mapping. The event pane is resolved as
   *   (a) pane label IS a task_id (legacy work-pane convention; validated
   *       against the snapshot, not string-guessed) → full mapping, else
   *   (a½) fresh-session round pane `<task_id>.<role>` (4.4): task_ids carry
   *       no dots (slug alphabet [a-z0-9-]), so the prefix before the LAST
   *       dot is the task_id; validated against the snapshot like (a) →
   *       direct hit — sharper than the identity chain (role is in the label,
   *       no cast resolution), else
   *   (b) agent identity: the pane label denotes an agent (agent-named pane
   *       or a legacy label) → the tasks currently waiting_for agent:<role>
   *       whose routed agent (task cast ?? default lineup) IS that identity;
   *       unique → use it, several → latest updated_at with an ambiguity log
   *       line, none → no mapping.
   * Edge (4.4 note): an agent named exactly like a live task_id wins level
   * (a) — accepted, priority declared, no anti-collision mechanism.
   */
  private resolveEventTask(pane: string): string | null {
    const snap = this.context.snapshot;
    if (snap === null) return null;
    const label = unscopedLabel(pane.trim(), this.rigRoot) ?? pane.trim();
    if (snap.has(label)) return label; // (a) 4.4: work pane named after its task
    // (a½) round pane <task_id>.<role>. Slugs do not contain dots, but walk
    // every dot from the right so a legacy label with an extra suffix still
    // gets the strongest task-prefix hit instead of falling through to the
    // less precise agent-identity map.
    for (let dot = label.lastIndexOf("."); dot > 0; dot = label.lastIndexOf(".", dot - 1)) {
      const prefix = label.slice(0, dot);
      if (snap.has(prefix)) return prefix;
    }
    const identity = this.routing?.labelToAgent.get(label);
    if (identity === undefined) return null;
    const roleToAgent = this.routing?.roleToAgent;
    const waiting = [...snap.values()].filter((t) => {
      if (!t.waiting_for.startsWith("agent:")) return false;
      const role = t.waiting_for.slice("agent:".length);
      const castRoute = t.cast?.[role as keyof Cast];
      const expected = castRoute !== undefined ? commandHead(castRoute) : roleToAgent?.get(role);
      return expected === identity;
    });
    if (waiting.length === 0) return null;
    if (waiting.length > 1) {
      // Ambiguity: take the most recently updated.
      waiting.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
      this.context.log(
        `event pane '${pane}' (agent '${identity}') has ${waiting.length} waiting tasks (${waiting
          .map((t) => t.task_id)
          .join(", ")}); using latest ${waiting[0]?.task_id}`,
      );
    }
    return waiting[0]?.task_id ?? null;
  }

  /**
   * Unmatched-event rate limit: reverse-lookup-miss events from one
   * source (pane+agent) keep their FIRST degradation line/notify of a window
   * exactly as before; further events inside the window (default 60s) are
   * only counted — the pending count flushes as ONE aggregate log line when
   * the next event escapes the window (suffixed to its emitting line) or the
   * fallback timer fires at window expiry — one window after the last EMIT,
   * so a mid-window burst cannot push the deadline out (sources that go
   * silent still get their aggregate). The timer also evicts the idle source
   * entry after firing, keeping `timers`/`unmatchedSources` bounded over long
   * runs. Returns the suffix for the emitting
   * line ("" for a plain first event) or null when this event is suppressed
   * (no log, no channel notify; the caller's immediate-compare side effect
   * is deliberately NOT suppressed). Matched events never pass through here.
   */
  private rateLimitUnmatched(evt: AgentEvent): string | null {
    if (this.closed) return null;
    const key = `${evt.pane}\u0000${evt.agent}`;
    const now = this.deps.now();
    let source = this.unmatchedSources.get(key);
    if (source === undefined) {
      source = { lastEmitAt: Number.NEGATIVE_INFINITY, suppressed: 0, byEvent: new Map() };
      this.unmatchedSources.set(key, source);
    }
    if (now - source.lastEmitAt < UNMATCHED_EVENT_WINDOW_MS) {
      source.suppressed += 1;
      source.byEvent.set(evt.event, (source.byEvent.get(evt.event) ?? 0) + 1);
      this.armUnmatchedFlushTimer(key, source, now); // no-op when already armed
      return null;
    }
    const suffix = source.suppressed > 0
      ? ` (+${source.suppressed} suppressed in window: ${this.describeUnmatchedMix(source)})`
      : "";
    source.lastEmitAt = now;
    source.suppressed = 0;
    source.byEvent.clear();
    this.clearUnmatchedFlushTimer(source);
    // Arm even with nothing pending: the expiry callback doubles as idle-source
    // eviction, so a source that emits once and goes silent is also reclaimed.
    this.armUnmatchedFlushTimer(key, source, now);
    return suffix;
  }

  /**
   * Arms the per-source fallback timer to fire exactly when the current
   * window expires: `lastEmitAt + UNMATCHED_EVENT_WINDOW_MS - now` from now
   * (clamped at 0) — NOT a fresh full window from the arming moment, so a
   * burst arriving mid-window is still flushed on the original schedule. On
   * expiry the callback (log-only) flushes any pending aggregate, removes its
   * own handle from `timers` (spent handles must not linger), and deletes the
   * — by then idle — source entry: a future event from this source escapes
   * the expired window and starts fresh, so neither structure grows across
   * long runs.
   */
  private armUnmatchedFlushTimer(key: string, source: UnmatchedSource, now: number): void {
    if (source.flushTimer !== undefined) return;
    const delay = Math.max(0, source.lastEmitAt + UNMATCHED_EVENT_WINDOW_MS - now);
    const [pane, agent] = key.split("\u0000");
    const timer = setTimeout(() => {
      source.flushTimer = undefined;
      this.timers.delete(timer);
      if (source.suppressed > 0) {
        this.context.log(
          `unmatched events pane '${pane}' (agent '${agent}'): ` +
          `${source.suppressed} further event(s) suppressed in the rate-limit window (${this.describeUnmatchedMix(source)})`,
        );
        source.suppressed = 0;
        source.byEvent.clear();
      }
      // Evict the idle entry (guard: only delete what we still own — close()
      // clears the map outright, a replaced entry is not ours to take).
      if (this.unmatchedSources.get(key) === source) this.unmatchedSources.delete(key);
    }, delay);
    this.timers.add(timer);
    source.flushTimer = timer;
  }

  private describeUnmatchedMix(source: UnmatchedSource): string {
    return [...source.byEvent.entries()].map(([event, count]) => `${event}×${count}`).join(", ");
  }

  private clearUnmatchedFlushTimer(source: UnmatchedSource): void {
    if (source.flushTimer === undefined) return;
    clearTimeout(source.flushTimer);
    this.timers.delete(source.flushTimer);
    source.flushTimer = undefined;
  }

  /** Handles a validated event; safe to call from the HTTP handler directly. */
  receiveEvent(evt: AgentEvent): void {
    if (this.closed) return;
    if (/\.(architect|executor|reviewer)-[a-f0-9]{8}$/.test(evt.pane.trim()) && unscopedLabel(evt.pane.trim(), this.rigRoot) === undefined) return;
    const taskId = this.resolveEventTask(evt.pane);
    switch (evt.event) {
      case "working":
        if (taskId !== null) {
          void this.handleWorkingSignal(evt, taskId).catch((e: unknown) => {
            this.context.log(`working event handling failed: ${(e as Error).message}`);
          });
        } else {
          // A signal can beat the next /state poll (especially on a fresh
          // launch). Give the snapshot one compare to catch up before
          // declaring the prefix reverse lookup broken.
          this.queueUnresolvedWorkingEvent(evt);
        }
        return;
      case "blocked": {
        // No stall refresh: a blocked event is not progress — this
        // stuck alert is the timely signal, and the stall watchdog stays the
        // stallMs backstop instead of being renewed by status flapping.
        // blocked is an追加触发 immediate compare (system-design 6.1):
        // the stuck agent may have just published; a compare picks it up now.
        // The UNMATCHED degradation (log + notify) is rate-limited
        // per source — the immediate compare above is never suppressed.
        if (taskId !== null) {
          void this.context.sendAll({
            title: `TUT ${taskId}: agent stuck`,
            body: `Agent ${evt.agent} appears blocked in pane ${evt.pane}${taskId !== evt.pane ? ` (task ${taskId})` : ""}`,
            // task_id only when a task was really resolved — an unmatched pane
            // name is not a task id, and the body already carries it.
            task_id: taskId,
          });
        } else {
          const agg = this.rateLimitUnmatched(evt);
          if (agg !== null) {
            this.context.log(`blocked event pane '${evt.pane}' matches no task (4.4 convention broken)${agg}`);
            void this.context.sendAll({
              title: `TUT ${evt.pane}: agent stuck`,
              body: `Agent ${evt.agent} appears blocked in pane ${evt.pane}`,
            });
          }
        }
        void this.context.requestCompare();
        return;
      }
      case "done":
        void this.handleDone(evt, taskId);
        return;
      case "delivery_giveup":
        void this.handleDeliveryGiveUp(evt, taskId);
        return;
    }
  }

  /**
   * done → pane sweep + immediate compare + cross-validation: the sweep
   * first — the task's round panes are archived into the log BEFORE the
   * compare can trigger the next round's launcher (which reaps them); the
   * per-task sweep barrier (see sweepBarriers) additionally parks any
   * concurrently-running compare's autoLaunch for this task until the sweep
   * settles, closing the poll-races-the-sweep window. Then the event pane is
   * resolved to a task (4.4 naming, or the role-pane reverse lookup); if
   * that task's waiting_for did not advance, wait one interval (or ≥2s) and
   * recheck — only still-no-advance notifies "Agent stopped but did not
   * publish context". Unresolvable pane degrades to a single compare.
   */
  private async handleDone(evt: AgentEvent, taskId: string | null): Promise<void> {
    if (taskId === null) {
      // The degradation LINE is rate-limited per source; the
      // degrading compare itself always runs.
      const agg = this.rateLimitUnmatched(evt);
      if (agg !== null) {
        this.context.log(`done event pane '${evt.pane}' matches no task (4.4 convention broken); degrading to compare${agg}`);
      }
      await this.context.requestCompare();
      return;
    }
    const atEvent = this.context.snapshot?.get(taskId);
    if (atEvent === undefined) {
      // Resolved a moment ago but gone from the snapshot now — degrade.
      this.context.log(`done event pane '${evt.pane}' resolved task ${taskId} no longer present; degrading to compare`);
      await this.context.requestCompare();
      return;
    }
    await this.runDoneSweep(taskId);
    const via = taskId !== evt.pane ? ` (pane ${evt.pane})` : "";
    const wfAtEvent = atEvent.waiting_for;
    await this.context.requestCompare(); // may coalesce with a concurrent tick (one action)
    const immediate = this.context.snapshot?.get(taskId);
    if (immediate !== undefined && immediate.waiting_for !== wfAtEvent) return; // published in time
    if (this.closed) return;
    const delayMs = Math.max(this.intervalMs, 2000);
    const timer = setTimeout(() => {
      // Spent handles must not linger: this was the one timer that
      // never removed itself from `timers` — every done-without-publish
      // recheck leaked a handle for the process lifetime.
      this.timers.delete(timer);
      void this.context.requestCompare()
        .then(() => {
          const later = this.context.snapshot?.get(taskId);
          if (later !== undefined && later.waiting_for === wfAtEvent) {
            void this.context.sendAll({
              title: `TUT ${taskId}: agent stopped without publishing`,
              body: `Agent ${evt.agent} stopped but did not publish context${via} (waiting_for still ${wfAtEvent}); run \`tut read ${taskId}\``,
              task_id: taskId,
            });
          }
        })
        .catch(() => undefined);
    }, delayMs);
    this.timers.add(timer);
  }

  /**
   * Runs the task's done sweep under a per-task barrier: the barrier is
   * registered SYNCHRONOUSLY before the first await, so any autoLaunch that
   * starts after the done event lands will see it. The sweep never rejects
   * (best-effort semantics live inside sweepTaskPanes); an unexpected throw
   * is still caught so a parked autoLaunch can never hang on it.
   */
  private async runDoneSweep(taskId: string): Promise<void> {
    const sweep = this.sweepTaskPanes(taskId).catch((e: unknown) => {
      this.context.log(`[${taskId}] done sweep failed unexpectedly: ${(e as Error).message}`);
    });
    this.sweepBarriers.set(taskId, sweep);
    await sweep;
    if (this.sweepBarriers.get(taskId) === sweep) this.sweepBarriers.delete(taskId);
  }

  /** Awaits the task's in-flight done sweep, if any (no-op otherwise). */
  async awaitSweepBarrier(taskId: string): Promise<void> {
    const barrier = this.sweepBarriers.get(taskId);
    if (barrier !== undefined) await barrier;
  }

  /**
   * Done-event pane sweep (supply hardening): archive the final visible
   * screen of every pane labeled `<taskId>.*` into the notify log — the
   * "agent did the work but never published" evidence trail. EVERY content
   * line carries the same parseable ISO timestamp and the pane label (the
   * header is a separator, never the lines' only timestamp carrier — lines
   * must stay self-describing when read away from their header). Scoped
   * strictly to the task's round-pane namespace (4.4): panes of other
   * tasks, system panes (tut-hub/tut-notify), and unlabeled panes are never
   * read. Best-effort: a failed inventory logs a note; a failed read logs
   * per pane and moves on — the sweep must never break the done flow (and
   * settling — success OR recorded failure — is what releases the barrier).
   */
  private async sweepTaskPanes(taskId: string): Promise<void> {
    // runDoneSweep registers its barrier synchronously while this read awaits.
    try {
      if (await this.launchModeReader(path.join(this.rigRoot, '.context-hub')) !== 'tui') return;
    } catch (e) {
      this.context.log(`[${taskId}] done sweep skipped: launch mode unreadable (${(e as Error).message})`); return;
    }
    let panes: PaneSnapshot[];
    try {
      panes = await this.paneLister();
    } catch (e) {
      this.context.log(`[${taskId}] done sweep skipped: pane list failed (${(e as Error).message})`);
      return;
    }
    // Prefix match is exact at the namespace boundary: task slugs carry no
    // dots (slug alphabet [a-z0-9-]), so `${taskId}.` cannot span into a
    // longer task's namespace (t1. never matches t1-long.*).
    const scoped = panes.filter((p) => (unscopedLabel(p.label, this.rigRoot) ?? "").startsWith(`${taskId}.`));
    if (scoped.length === 0) {
      this.context.log(`[${taskId}] done sweep: no round panes left to snapshot`);
      return;
    }
    const at = new Date(this.deps.now()).toISOString();
    for (const pane of scoped) {
      let screen: string;
      try {
        screen = await this.paneReader(pane.pane_id);
      } catch (e) {
        this.context.log(`[${taskId}] done sweep: pane '${pane.label}' (${pane.pane_id}) read failed (${(e as Error).message})`);
        continue;
      }
      this.context.log(`[${taskId}] done sweep — pane '${pane.label}' (${pane.pane_id}) final screen @ ${at}:`);
      const lines = screen.replace(/\n+$/, "").split("\n");
      if (lines.length === 1 && lines[0] === "") {
        this.context.log(`[${taskId}] sweep ${at} ${pane.label} | (empty screen)`);
        continue;
      }
      for (const line of lines) {
        this.context.log(`[${taskId}] sweep ${at} ${pane.label} | ${line}`);
      }
    }
  }

  /**
   * Hand the launcher child to a per task+role chain that runs OFF the
   * compare queue.  Round N+1's child waits for round N's — the
   * queue used to provide this ordering by blocking; now only this task's
   * chain waits.  The chain promise is registered synchronously so a
   * same-key hand-off can never double-spawn.
   */
  private spawnTrackedLaunch(
    task: StateTask,
    role: string,
    agent: string,
    args: string[],
    invocation: LaunchInvocation,
    launchVersion: number | undefined,
  ): void {
    const launchKey = this.workingWatchKey(task.task_id, role);
    const previous = this.launchChains.get(launchKey);
    const run = (async () => {
      if (previous !== undefined) await previous.catch(() => undefined);
      if (this.closed) return;
      await this.runLaunchChild(launchKey, task, role, agent, args, invocation, launchVersion);
    })();
    this.launchChains.set(launchKey, run);
    const reap = (): void => {
      if (this.launchChains.get(launchKey) === run) this.launchChains.delete(launchKey);
    };
    run.then(reap, reap);
  }

  /** Await one launcher child and process its outcome (autoLaunch's former
   *  post-marker tail, now detached from the compare queue). */
  private async runLaunchChild(
    launchKey: string,
    task: StateTask,
    role: string,
    agent: string,
    args: string[],
    invocation: LaunchInvocation,
    launchVersion: number | undefined,
  ): Promise<void> {
    this.inFlightLaunches.set(launchKey, { task, role, agent, ...(launchVersion !== undefined ? { launchVersion } : {}) });
    try {
      const out = this.deps.launchInvocation !== undefined
        ? await this.deps.launchInvocation(invocation)
        : args.length > 0
          ? await this.deps.launch(task.task_id, role, agent, args)
          : await this.deps.launch(task.task_id, role, agent);
      this.inFlightLaunches.delete(launchKey);
      // Dry-run output is often multi-line (provisioning preview + delivery
      // preview); log EVERY line so the pane log shows the full launch preview.
      for (const line of out.trim().split("\n")) {
        this.context.log(`tut launch (${task.task_id}, ${role})${line ? ` → ${line}` : ""}`);
      }
      // A delivery give-up that landed while this launch was in flight has
      // already escalated this round's fate through the channels; arming the
      // short fuse now would re-alarm the same round five minutes later as a
      // generic "no working signal". Consume the record either way.
      const earlyGiveUp = this.earlyGiveUps.get(launchKey);
      this.earlyGiveUps.delete(launchKey);
      if (earlyGiveUp !== undefined) {
        this.context.log(`[${task.task_id}] short working fuse not armed: delivery gave up while the launch was completing (give-up alert already sent)`);
      } else {
        this.armWorkingWatch(task, role, agent, launchVersion);
      }
      this.context.log(
        `[${task.task_id}] launch attempt completed; delivery confirmation is not implied for ${role}; waiting for working signal within ${Math.ceil(this.workingTimeoutMs / 1000)}s`,
      );
      await this.context.sendAll({
        title: `TUT ${task.task_id}: auto-launched ${role}`,
        body: `${task.title} — status: ${task.status}; launch attempt completed; delivery confirmation is not implied for ${role} via tut launch (pane: ${task.task_id}.${role}); waiting for the agent's working signal`,
        task_id: task.task_id,
      });
      // A real launcher can still be awaiting its final verification while
      // the newborn agent has already emitted working. Preserve that event so
      // the post-launch fuse is not armed after the useful signal and then
      // allowed to fire falsely.
      const early = this.earlyWorkingSignals.get(launchKey);
      if (early !== undefined) {
        this.earlyWorkingSignals.delete(launchKey);
        await this.handleWorkingSignal(early, task.task_id);
      }
    } catch (e) {
      this.inFlightLaunches.delete(launchKey);
      this.earlyWorkingSignals.delete(launchKey);
      this.earlyGiveUps.delete(launchKey);
      await this.context.autoLaunchFailed(task, role, e);
    }
  }

  reportHostStatus(task: StateTask, status: HostStatusReport["status"], notify: unknown): void {
    const report = { task_id: task.task_id, status, waiting_for: task.waiting_for };
    void Promise.resolve().then(() => this.deps.relayHostStatus!(report, notify)).catch((e: unknown) => {
      this.context.log(`[${task.task_id}] host status relay failed: ${(e as Error).message}`);
    });
  }

  /**
   * Hand the close-cleanup child OFF the compare queue, mirroring
   * the auto-launch child's detachment: the compare returns
   * immediately, so a wedged or slow cleanup child cannot block other
   * tasks' diffs. Observability is exactly one log line either way — no
   * desktop notification (the human closed the task themselves; this is
   * housekeeping, not news) and no Hub writes (a cleanup record would
   * re-trigger compares and notification loops). Failure is terminal for
   * the panes — orphan recovery does not exist (4.4) — so the line carries
   * the manual retry command.
   */
  cleanupClosedTask(taskId: string): void {
    void this.deps.cleanupPanes(taskId).then(
      () => {
        this.context.log(`[${taskId}] closed — pane cleanup done (launch --cleanup)`);
      },
      (e: unknown) => {
        this.context.log(`[${taskId}] pane cleanup after close failed: ${(e as Error).message} — panes may remain; rerun: tut launch --cleanup ${taskId}`);
      },
    );
  }

  async launch(task: StateTask, role: string, baseVersion: number, noteWake?: NoteWake): Promise<void> {
    if (this.closed) return;
    // Resolve the Herdr snapshot and the workspace declaration snapshot before
    // planning the route.  Both are frozen at this planner boundary, so
    // naming, routing and birth cannot drift if focus, files, or environment
    // changes after this point.
    const environment = { ...process.env, ...rigEnvironment(this.rigRoot, this.stateUrl.replace(/\/state$/, ""), `http://127.0.0.1:${this.eventPort}/agent-event`) };
    let executionContext: ExecutionContext;
    try {
      executionContext = await resolveExecutionContext({
        client: { paneList: this.anchorPaneLister },
        caller_cwd: process.cwd(),
        env: environment,
        dry_run: environment.TUT_DRY_RUN === "1",
        ...(task.checkout !== undefined ? { checkout: task.checkout } : {}),
      });
    } catch (e) {
      await this.context.autoLaunchFailed(task, role, new Error(`context planning failed: ${(e as Error).message}`));
      return;
    }
    const projectRoot = executionContext.routingRoot.startsWith("<")
      ? executionContext.caller_cwd ?? process.cwd()
      : executionContext.routingRoot;
    let workspaceSnapshot: WorkspaceConfigSnapshot;
    try {
      workspaceSnapshot = await readWorkspaceConfigSnapshot({
        projectRoot,
        userConfigDir: defaultUserConfigDir(environment),
        ...(executionContext.checkout.kind === "worktree" && !executionContext.hubRoot.startsWith("<")
          ? { fallbackProjectRoot: executionContext.hubRoot }
          : {}),
      });
    } catch (e) {
      await this.context.autoLaunchFailed(task, role, new Error(`workspace planning failed: ${(e as Error).message}`));
      return;
    }
    if (environment.TUT_DRY_RUN !== "1") {
      try {
        requireBirthAnchor(executionContext);
      } catch (e) {
        // No marker, no launch: a live auto door has the same mutation guard
        // as the legacy child, while cleanup/sweep remain best-effort paths.
        await this.context.autoLaunchFailed(task, role, e);
        return;
      }
    }

    // Pre-check BEFORE the marker (order: dedup → precheck → mark → launch,
    // same as tut start-next): resolve the routed agent (cast → workspace →
    // routes) and require it on PATH. A failure leaves no trace — the human's
    // start-next (or the next auto round) is not blocked.
    let route: AgentRoute;
    let routeSource: LaunchRouteSource;
    let preResolvedPlan: PlatformExecutionPlan | undefined;
    try {
      const resolved = await this.targetSourceResolver(task.task_id, role, projectRoot, workspaceSnapshot);
      route = resolved.route;
      routeSource = resolved.source === "builtin-default" ? routeSourceForTask(task, role) : resolved.source;
      preResolvedPlan = resolved.plan;
    } catch (e) {
      await this.context.autoLaunchFailed(task, role, new Error(`precheck failed: ${(e as Error).message}`));
      return;
    }
    const agent = commandHead(route);
    const args = commandArgs(route);

    let invocation: LaunchInvocation;
    try {
      invocation = await buildAutoInvocation(
        task,
        role,
        route,
        routeSource,
        baseVersion,
        this.stateUrl.replace(/\/state$/u, ""),
        executionContext,
        workspaceSnapshot,
        environment,
        preResolvedPlan,
      );
    } catch (e) {
      await this.context.autoLaunchFailed(task, role, new Error(`invocation planning failed: ${(e as Error).message}`));
      return;
    }
    // Done-sweep barrier (2/3, post-planning): a done event may have landed
    // while readLog/precheck/invocation planning were in flight — re-check
    // immediately before the marker. From the resolution of this await to
    // the markLaunched call the code is one synchronous continuation (no
    // macrotask boundary), so a later done event cannot slip between this
    // check and the marker.
    await this.awaitSweepBarrier(task.task_id);
    if (this.closed) return;
    let launchVersion: number | undefined;
    try {
      const marker = await this.deps.markLaunched(task.task_id, role, baseVersion, "auto", invocation.marker_projection);
      launchVersion = versionOf(marker) ?? task.version;
    } catch (e) {
      // A manual start-next or another notifier may have won the optimistic
      // append race. Re-read once: if its marker is now present, converge on
      // the same harmless skipped outcome instead of reporting a false error.
      // Deliberately NO /state entry here: the poll's entry is
      // stale by construction — the winner's marker landed after fetchState —
      // so a coverage skip must not fire; the entry-less pull is always
      // incremental since cached.version + 1 and therefore sees the marker.
      try {
        const after = await this.context.fullLog(task.task_id);
        const afterBlocked = launchBlocked(after, role, noteWake);
        if (afterBlocked.blocked) {
          await this.context.autoLaunchSkipped(task, role, afterBlocked.noteVersion);
          return;
        }
      } catch {
        // Keep the original append error as the actionable failure.
      }
      if (noteWake !== undefined && e instanceof Error &&
        (("code" in e && e.code === "VERSION_CONFLICT") || e.message.includes("VERSION_CONFLICT"))) {
        this.context.deferNoteWake(task, noteWake);
        return;
      }
      await this.context.autoLaunchFailed(task, role, e);
      return;
    }

    // Done-sweep barrier (3/3, pre-spawn): even if a razor-thin interleaving
    // let the marker slip past, the LAUNCH itself (the pane-reaping action)
    // still waits for the sweep.
    await this.awaitSweepBarrier(task.task_id);
    // Post-marker stage: the launcher child runs OUTSIDE the
    // drain queue.  Everything above (gate → dedup → marker) stays queued —
    // a follow-up compare always observes the marker — but the child itself
    // is handed off below, so a wedged or slow launcher can no longer freeze
    // every other task's compares and notifications; a hung launch drags at
    // most its own task, and the child liveness backstop (runNodeCommand)
    // eventually settles it into the failure path.
    if (this.closed) return;
    this.spawnTrackedLaunch(task, role, agent, args, invocation, launchVersion);
  }
}

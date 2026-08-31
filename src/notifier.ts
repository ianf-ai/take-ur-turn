/**
 * Notifier (system-design ch. 6). `tut notify` runs runNotify below as a daemon in a
 * dedicated pane (8.2): stdout/stderr is the log, crashes are visible.
 *
 * State routing remains a pure HTTP consumer of GET {url}/state (flow_mode AND
 * the optional `notify` channel config both come from /state, each cycle).
 * The auto launch branch additionally uses the shared launch module to read
 * and append launch provenance in the Hub before it invokes the launcher.
 * In-memory state is still only a snapshot: restart re-baselines
 * and the first successful fetch establishes it with NO notifications,
 * afterwards changes are edge-triggered.
 *
 * Execution model: ONE async queue serializes all "compare + gate + act" — the
 * poll interval and agent events both only enqueue "run one compare"; requests
 * arriving in the same macrotask coalesce into a single run. Concurrent entry
 * points therefore cannot double-notify or double-launch.
 *
 * Auto-mode gate: waiting_for "agent:*" with
 * needs_attention false ALREADY fully encodes "launchable" — a task awaiting a
 * human decision always carries waiting_for "human", which never reaches the
 * launch branch. The only legal pending_approval → revising path is
 * decision(reject), i.e. a human HAS acted, so auto-launch must fire there or
 * the review-revision loop breaks every round. Transitions INTO waiting_for
 * "human" notify the human ("pending human decision") instead.
 *
 * Launch whitelist: the auto branch checks /state's
 * `auto.launch_roles` (role-keyed) AFTER the gate and BEFORE the duplicate
 * check / marker append — not whitelisted ⇒ no launch, NO launch marker (a
 * withheld round must never block the human's `tut start-next`), notify the
 * human instead. Absent/empty list withholds everything (conservative default).
 *
 * Observability: acting stays edge-triggered, but every auto-mode poll
 * also logs ONE decision line per agent:*-waiting task (who it waits for,
 * each gate check, the dedup result, the action this poll takes and why) so
 * a silently-withheld round is greppable and the timeline rebuildable;
 * flow_mode is logged on change and echoed periodically; reverse-lookup-miss
 * agent events are rate-limited per source (first of a window degrades as
 * before, the rest aggregate) so an unlabeled pane's status flapping cannot
 * flood the notify log.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createChannels, type Channel, type Notification } from "./channels.js";
import {
  launchBlocked,
  latestRecordVersion,
  markLaunched as appendLaunchMarker,
  readLaunchLog,
  resolveLaunchTargetWithSource,
  type LaunchVia,
} from "./launch.js";
import { commandHead, commandArgs } from "./agent-command.js";
import type { GiveUpBoxEvidence, GiveUpProbeEvidence } from "./launcher/escalation.js";
import { giveUpGuidance } from "./launcher/escalation.js";
import { assertLaunchStateGate, bindLaunchBaseVersion, buildLaunchInvocation } from "./launcher/invocation.js";
import {
  AgentTargetError,
  UnsupportedWindowsShimError,
  planForPlatform,
  resolvePosixTargetPresence,
  type PlatformExecutionPlan,
} from "./launcher/target-resolver.js";
import { runInternalLaunch, runInternalLaunchInvocation, spawnDirect } from "./launcher/process.js";
import { requireBirthAnchor, resolveExecutionContext } from "./launcher/anchor.js";
import { HerdrClient } from "./launcher/herdr-client.js";
import type { AgentCommand, AgentRoute, Cast, CheckoutRoute, ContextRecord, ExecutionContext, LaunchInvocation, LaunchMarkerProjection, LaunchRequest, LaunchRouteSource } from "./types.js";
import {
  KNOWN_ROLES,
  defaultUserConfigDir,
  readWorkspaceConfigSnapshot,
  resolveAgentRoute,
  resolveTabLabelTemplateFromSnapshot,
  type WorkspaceConfigSnapshot,
} from "./workspace.js";

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
  /** Task's per-role cast overrides (absent on older hubs/fixtures). */
  cast?: Cast;
  /** Task-frozen checkout route (absent on older hubs/fixtures = current). */
  checkout?: CheckoutRoute;
}

/** The optional /state `auto` section: the launch whitelist.
 *  launch_roles is optional only for tolerance — an older hub or a fixture
 *  without it behaves as an empty whitelist (withhold all). */
export interface StateAuto {
  launch_roles?: string[];
}

export interface StateResponse {
  flow_mode: string;
  tasks: StateTask[];
  /** Optional channel config; interpreted by createChannels. */
  notify?: unknown;
  /** Optional auto-enablement config; the launch whitelist. */
  auto?: StateAuto;
}

export interface AgentEvent {
  /**
   * working / blocked / done are the agent-status events (Herdr signal
   * source).  delivery_giveup is emitted by the LAUNCHER (7.2.1): its
   * bounded submit-retry window exhausted.  What happened to the prompt
   * is in the optional evidence fields below — the alert copy follows
   * them, never a fixed "press Enter" claim.
   */
  event: "working" | "blocked" | "done" | "delivery_giveup";
  agent: string;
  pane: string;
  /** Give-up evidence (7.2.1 additive fields, launcher-emitted only):
   *  the last input-box observation and the last Enter transport result;
   *  `probe` is the relay's diagnostic visibility.  Legacy give-up
   *  events without them degrade to the conservative inspect-the-pane
   *  hint. */
  box?: GiveUpBoxEvidence;
  transport?: boolean;
  probe?: GiveUpProbeEvidence;
}

/**
 * Give-up alert copy follows the launcher's three-state evidence
 * discipline word for word (7.2.1 step 5) by consuming the SAME
 * single-source guidance as the launcher's stderr (giveUpGuidance).
 * The required core evidence pair `box + transport` is ATOMIC: only a
 * complete, well-typed pair may drive the copy — a half-valid payload
 * (one field present, the other missing or ill-typed) or box=unknown
 * itself degrades to the conservative inspect-the-pane hint, never a
 * blind "press Enter".  `probe` stays optional and never gates the
 * copy.
 */
function deliveryGiveUpHint(evt: Pick<AgentEvent, "box" | "transport">): string {
  const box = evt.box;
  if ((box !== "held" && box !== "cleared" && box !== "unknown") || typeof evt.transport !== "boolean" || box === "unknown") {
    return `box evidence unavailable — ${giveUpGuidance("unknown")}`;
  }
  return giveUpGuidance(box);
}

/** A pane-list row consumed by the done-event sweep (system-design 4.4). */
export interface PaneSnapshot {
  pane_id: string;
  label: string;
  /** Optional Herdr metadata retained for one-shot launch anchoring. */
  tab_id?: string;
  workspace_id?: string;
  cwd?: string;
  agent_status?: string;
}

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

export interface NotifierDeps {
  fetchState(url: string): Promise<StateResponse>;
  /** Backward-compatible injected launch seam for existing callers/tests. */
  launch(taskId: string, role: string, agent: string, args?: string[]): Promise<string>;
  /** Canonical launch seam: receives the same frozen invocation as the marker. */
  launchInvocation?(invocation: LaunchInvocation): Promise<string>;
  /** Full task log used by auto launch de-duplication; injectable for tests. */
  readLog(taskId: string): Promise<ContextRecord[]>;
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
}

// --- defaults --------------------------------------------------------------------

function stateUrlOf(url: string): string {
  return `${url.replace(/\/+$/, "")}/state`;
}

async function defaultFetchState(url: string): Promise<StateResponse> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as StateResponse;
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
  const template = resolveTabLabelTemplateFromSnapshot(workspaceSnapshot);
  const skillPath = fileURLToPath(new URL(`../skills/${role}.md`, import.meta.url));
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
      pane_label: `${task.task_id}.${role}`,
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
  if (result.code !== 0) {
    const tail = result.stderr.trim();
    throw new Error(`launch.sh ${taskId} ${role} exited ${result.code ?? `signal ${result.signal}`}${tail ? `: ${tail}` : ""}`);
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
  if (result.code !== 0) {
    const tail = result.stderr.trim();
    throw new Error(`launch.sh ${invocation.task_id} ${invocation.role} exited ${result.code ?? `signal ${result.signal}`}${tail ? `: ${tail}` : ""}`);
  }
  return result.stdout.trim();
}

function defaultLog(line: string): void {
  process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
}

function versionOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
}

/** Keep approval alerts useful in desktop surfaces with a bounded title body. */
const PENDING_APPROVAL_TITLE_LIMIT = 72;

/** Unmatched (reverse-lookup-miss) events from one source (pane+
 *  agent) emit their degradation line/notify once per window; the rest of
 *  the window only counts toward the next aggregate line. */
const UNMATCHED_EVENT_WINDOW_MS = 60_000;

/** An unchanged flow_mode is re-echoed at most this often, so the
 *  tail of the notify log always answers "what mode are we in". */
const FLOW_MODE_ECHO_INTERVAL_MS = 5 * 60_000;

function truncatePendingApprovalTitle(title: string): string {
  return title.length <= PENDING_APPROVAL_TITLE_LIMIT
    ? title
    : `${title.slice(0, PENDING_APPROVAL_TITLE_LIMIT)}…`;
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

/** Default routing loader — exported for the fixture-driven chain test. */
export async function defaultLoadRouting(): Promise<RoutingMaps> {
  const labelToAgent = new Map<string, string>();
  const roleToAgent = new Map<string, string>();
  for (const role of KNOWN_ROLES) {
    const route = await resolveAgentRoute(role); // three-level chain from cwd; never throws
    const agent = commandHead(route);
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

// --- loopback Host guard (mirrors src/http.ts) -------------------------------------
// Duplicated rather than imported: http.ts is a Hub-side module and the
// notifier must stay an independent consumer.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostHostname(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
    return host.slice(0, colon);
  }
  return host;
}

function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (host === undefined) return true; // HTTP/1.0-style clients tolerated (same as http.ts)
  return LOOPBACK_HOSTS.has(hostHostname(host.toLowerCase()));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const EVENT_BODY_LIMIT = 64 * 1024;

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error(`body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// --- notifier ----------------------------------------------------------------------

/**
 * Trust whitelist check: role-keyed array
 * membership in /state's `auto.launch_roles`. Absent, empty, or structurally
 * malformed (defensive against an older hub) → NOT whitelisted: the
 * conservative default withholds every auto launch.
 */
function autoWhitelisted(auto: StateAuto | undefined, role: string): boolean {
  const roles = auto?.launch_roles;
  return Array.isArray(roles) && roles.includes(role);
}

export class Notifier {
  private readonly stateUrl: string;
  private readonly intervalMs: number;
  private readonly stallMs: number;
  private readonly workingTimeoutMs: number;
  private readonly eventPort: number;
  private readonly deps: NotifierDeps;

  private snapshot: Map<string, StateTask> | null = null;
  /** Tasks whose pending_approval entry edge has already been notified. */
  private pendingApprovalTasks = new Set<string>();
  private channels: Channel[] = createChannels(undefined);
  private consecutiveFailures = 0;
  /** Routing maps for the event reverse lookup; null until first load. */
  private routing: RoutingMaps | null = null;
  /** Last observed flow_mode; null before the first successful fetch. */
  private lastFlowMode: string | null = null;
  /** When the last flow_mode line (change or echo) was logged. */
  private lastModeEchoAt = 0;
  /** Rate-limit state per unmatched-event source (key: pane + agent). */
  private unmatchedSources = new Map<string, UnmatchedSource>();

  // Serial-compare queue: `pending` coalesces, `drain` is the in-flight cycle.
  private pending = false;
  private drain: Promise<void> | null = null;

  // Stall watchdog (in-memory): updated_at is treated as an opaque
  // string — ANY change (including note appends, accepted heuristic) resets.
  private lastUpdatedAt = new Map<string, string>();
  private lastProgressAt = new Map<string, number>();
  private stallNotified = new Set<string>();

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

  private server: Server | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
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

  constructor(options: NotifyOptions, deps: Partial<NotifierDeps> = {}) {
    this.stateUrl = stateUrlOf(options.url);
    this.intervalMs = Math.max(1, options.interval) * 1000;
    this.stallMs = Math.max(0, options.stallTimeoutMin) * 60_000;
    const workingTimeoutSec = options.workingTimeoutSec ?? options.launchWorkingTimeoutSec ?? 300;
    this.workingTimeoutMs = Math.max(0, Number.isFinite(workingTimeoutSec) ? workingTimeoutSec : 300) * 1000;
    this.eventPort = options.eventPort;
    this.routingLoader = deps.loadRouting ?? defaultLoadRouting;
    this.targetResolver = deps.resolveTarget ?? (async (taskId, role) => (await defaultResolveTargetWithSource(options.url, taskId, role)).route);
    this.targetSourceResolver = deps.resolveTargetWithSource !== undefined
      ? (taskId, role, projectRoot, workspaceSnapshot) => deps.resolveTargetWithSource!(taskId, role, projectRoot, workspaceSnapshot)
      : deps.resolveTarget === undefined
        ? (taskId, role, projectRoot, workspaceSnapshot) => defaultResolveTargetWithSource(options.url, taskId, role, projectRoot, workspaceSnapshot)
        : async (taskId, role) => ({
            route: await this.targetResolver(taskId, role),
            source: "builtin-default" as const,
          });
    this.paneLister = deps.listPanes ?? defaultListPanes;
    this.anchorPaneLister = deps.listAnchorPanes ?? defaultListPanes;
    this.paneReader = deps.readPane ?? defaultReadPane;
    const canonicalLaunch = deps.launchInvocation
      ?? (deps.launch === undefined ? (invocation: LaunchInvocation) => spawnLaunchInvocation(invocation) : undefined);
    this.deps = {
      fetchState: deps.fetchState ?? defaultFetchState,
      launch: deps.launch ?? spawnLaunch,
      ...(canonicalLaunch !== undefined ? { launchInvocation: canonicalLaunch } : {}),
      readLog: deps.readLog ?? ((taskId) => readLaunchLog(options.url, taskId)),
      markLaunched: deps.markLaunched ?? ((taskId, role, baseVersion, via, projection) => appendLaunchMarker(options.url, taskId, role, baseVersion, via, projection)),
      channelsFor: deps.channelsFor ?? createChannels,
      now: deps.now ?? (() => Date.now()),
      log: deps.log ?? defaultLog,
    };
  }

  private log(line: string): void {
    this.deps.log(`tut: notify: ${line}`);
  }

  /** Schedules one compare; same-macrotask requests coalesce into one run. */
  requestCompare(): Promise<void> {
    this.pending = true;
    if (this.drain === null) {
      this.drain = (async () => {
        // Yield once so tick+event requests arriving in the same macrotask
        // collapse into a single compare ("同拍只行动一次").
        await Promise.resolve();
        try {
          while (this.pending) {
            this.pending = false;
            await this.compareAndAct();
          }
        } finally {
          this.drain = null;
        }
      })();
    }
    return this.drain;
  }

  private async compareAndAct(): Promise<void> {
    let state: StateResponse;
    try {
      state = await this.deps.fetchState(this.stateUrl);
    } catch (e) {
      // Poll failure: one stderr line per consecutive failure RUN, snapshot
      // kept, same interval, no notification, no crash (§3).
      if (this.consecutiveFailures === 0) {
        this.log(`poll failed: ${(e as Error).message}; keeping snapshot, retrying next interval`);
      }
      this.consecutiveFailures += 1;
      return;
    }
    this.consecutiveFailures = 0;
    // Channel set rebuilt from /state's notify key EVERY poll.
    this.channels = this.deps.channelsFor(state.notify);
    // routing maps refreshed every poll too — workspace.json edits apply
    // without restart; a failed load keeps the previous maps (events before
    // the first successful load degrade to the no-mapping path).
    try {
      this.routing = await this.routingLoader();
    } catch (e) {
      this.log(`routing map reload failed: ${(e as Error).message}; keeping previous`);
    }

    const prev = this.snapshot;
    const now = this.deps.now();
    this.snapshot = new Map(state.tasks.map((t) => [t.task_id, t]));
    // A task omitted from /state has left the observable workflow. Forget its
    // approval edge so a later reappearance can notify again.
    for (const taskId of this.pendingApprovalTasks) {
      if (!this.snapshot.has(taskId)) this.pendingApprovalTasks.delete(taskId);
    }
    await this.retireObsoleteWorkingWatches(this.snapshot);
    // Mode visibility — a switch logs immediately, an unchanged mode
    // is re-echoed periodically (below the baseline branch so the baseline
    // line itself stays the first mode statement of a session).
    this.observeFlowMode(state.flow_mode, now);

    if (prev === null) {
      // First successful fetch: baseline, no notifications.
      for (const t of state.tasks) {
        this.lastUpdatedAt.set(t.task_id, t.updated_at);
        this.lastProgressAt.set(t.task_id, now);
        if (t.status === "pending_approval") this.pendingApprovalTasks.add(t.task_id);
      }
      this.log(`baseline: ${state.tasks.length} task(s), flow_mode=${state.flow_mode}`);
      // Decision lines on the baseline poll too — a task that is
      // ALREADY agent-waiting when the notifier (re)starts is exactly the
      // silent-door shape; its "no action, and why" must be visible.
      if (state.flow_mode === "auto") await this.logAutoDecisions(null, state);
      return;
    }

    // Per-poll decision lines precede this poll's acting — the line
    // announces the launch (or the reason there will be none) first.
    if (state.flow_mode === "auto") await this.logAutoDecisions(prev, state);
    try {
      for (const after of state.tasks) {
        await this.diffTask(prev.get(after.task_id), after, state.flow_mode, state.auto);
      }
      this.checkStalls(state.tasks, now);
    } catch (e) {
      // compare/act itself should never throw; if it does, log and survive.
      this.log(`compare failed unexpectedly: ${(e as Error).message}`);
    }
  }

  private async diffTask(
    before: StateTask | undefined,
    after: StateTask,
    flowMode: string,
    auto: StateAuto | undefined,
  ): Promise<void> {
    const pendingApprovalEntering = this.updatePendingApprovalEdge(after);
    // A task absent from the previous snapshot counts as waiting_for "none"
    // before, so brand-new tasks notify (absent → agent:* is a change) but a
    // snapshot-miss with waiting_for "none" stays silent.
    const beforeWf = before?.waiting_for ?? "none";
    const wfChanged = beforeWf !== after.waiting_for;
    const attentionRising = after.needs_attention && before?.needs_attention !== true;

    // Merge log (log-only, no behavior change): version jumped
    // by more than 1 → intermediate rounds landed between polls and were never
    // observed as separate snapshots — including same-endpoint merges (e.g.
    // code_changes + fail review both landing: executor→reviewer→executor,
    // waiting_for unchanged end-to-end, a full round silently swallowed).
    // Not gated on wfChanged for exactly that reason.
    // before absent (new task) or version field absent (older hub) → ignore.
    if (
      before?.version !== undefined &&
      after.version !== undefined &&
      after.version - before.version > 1
    ) {
      this.log(
        `[${after.task_id}] ${after.version - before.version} transitions merged between polls (v${before.version}→v${after.version})`,
      );
    }

    if (attentionRising) {
      // Anomaly notification ONLY; suppresses the same-tick flow notification.
      // Never contains warnings content — /state has none; the
      // human runs `tut read` for the cause.
      await this.sendAll({
        title: `TUT ${after.task_id}: needs attention`,
        body: `${after.title} — status: ${after.status}: run \`tut read ${after.task_id}\` for warnings`,
        task_id: after.task_id,
      });
      return;
    }
    if (pendingApprovalEntering) {
      // Approval is a first-class state edge rather than a side effect of
      // waiting_for. This also covers snapshots where the task was already
      // waiting for a human before it entered pending_approval.
      await this.notifyPendingApproval(after, flowMode);
      return;
    }
    if (!wfChanged) return;
    if (after.waiting_for === "none") return; // human closed / wound down — silent (§3)

    if (flowMode !== "auto") {
      // manual: notify only — task, status, who moves next. The round pane is
      // named `<task_id>.<role>` (fresh-session convention, 4.4); human-waiting
      // states have no agent pane, so the segment is omitted there.
      const paneSeg = after.waiting_for.startsWith("agent:")
        ? `; pane: ${after.task_id}.${after.waiting_for.slice("agent:".length)}`
        : "";
      await this.sendAll({
        title: `TUT ${after.task_id}: waiting for ${after.waiting_for}`,
        body: `${after.title} — status: ${after.status}; waiting for: ${after.waiting_for}${paneSeg}`,
        task_id: after.task_id,
      });
      return;
    }

    // --- auto branch gate (see module doc for the exact rule) ---
    const gated = this.autoGateReason(after);
    if (gated !== null) {
      await this.sendAll({
        title: `TUT ${after.task_id}: human decision needed`,
        body: `${after.title} — status: ${after.status}; waiting for: ${after.waiting_for}; auto launch withheld (${gated})`,
        task_id: after.task_id,
      });
      return;
    }
    const role = after.waiting_for.slice("agent:".length);
    // --- auto-mode launch whitelist ---
    // Order is pinned: gate → WHITELIST → dedup (launch note) → markLaunched →
    // launch. A withheld round must NOT append a launch marker — the human's
    // `tut start-next` for the same round would hit ALREADY_LAUNCHED otherwise.
    // Absent/empty/malformed whitelist withholds everything (conservative
    // default; the enabler fills launch_roles in explicitly).
    if (!autoWhitelisted(auto, role)) {
      this.log(
        `[${after.task_id}] auto launch withheld: role '${role}' not in launch whitelist (config.json auto.launch_roles)`,
      );
      await this.sendAll({
        title: `TUT ${after.task_id}: auto launch withheld`,
        body: `${after.title} — status: ${after.status}; waiting for: ${after.waiting_for}; auto launch withheld: role '${role}' not in launch whitelist (config.json auto.launch_roles)`,
        task_id: after.task_id,
      });
      return;
    }
    await this.autoLaunch(after, role);
  }

  /** Track the pending_approval edge independently of waiting_for changes. */
  private updatePendingApprovalEdge(task: StateTask): boolean {
    if (task.status !== "pending_approval") {
      this.pendingApprovalTasks.delete(task.task_id);
      return false;
    }
    const entering = !this.pendingApprovalTasks.has(task.task_id);
    this.pendingApprovalTasks.add(task.task_id);
    return entering;
  }

  /** Notify through the existing channels and the notifier pane log. */
  private async notifyPendingApproval(task: StateTask, flowMode: string): Promise<void> {
    const title = flowMode === "auto"
      ? `TUT ${task.task_id}: human decision needed`
      : `TUT ${task.task_id}: waiting for human`;
    const taskTitle = truncatePendingApprovalTitle(task.title);
    const command = `tut decide ${task.task_id} --decision approve --by <your-name>`;
    const approvalHint = `run \`${command}\` (replace \`<your-name>\` with your identity; use \`--decision reject\` to request revisions)`;
    const body = flowMode === "auto"
      ? `${taskTitle} — status: ${task.status}; waiting for: ${task.waiting_for}; waiting for approval; auto launch withheld (pending human decision); ${approvalHint}`
      : `${taskTitle} — status: ${task.status}; waiting for: ${task.waiting_for}; waiting for approval; ${approvalHint}`;
    await this.sendAll({ title, body, task_id: task.task_id });
  }

  /**
   * The auto gate, as one rule: launch ONLY when
   *   (1) waiting_for starts with "agent:" (role = the suffix), and
   *   (2) needs_attention is false.
   * Everything else withholds: waiting_for "human" (a decision is pending —
   * including pending_approval) reports "pending human decision". Previous
   * status is deliberately NOT consulted: pending_approval → revising can only
   * happen via decision(reject) — a human has already acted, and the only legal
   * revising → reviewing → pending_approval cycle relies on the executor being
   * auto-launched there. Returns the withhold reason, or null to launch.
   */
  private autoGateReason(after: StateTask): string | null {
    if (after.needs_attention) return "needs_attention set";
    if (!after.waiting_for.startsWith("agent:")) {
      if (after.waiting_for === "human") return "pending human decision";
      return `waiting_for ${after.waiting_for} is not launchable`;
    }
    return null;
  }

  /**
   * Per-poll auto-gate observability: in auto mode every poll logs ONE
   * decision line per agent:*-waiting task — who it waits for, each gate
   * check (decision gate / needs_attention / whitelist), the launch dedup
   * result, and the action this poll will (not) take with its reason.
   * Acting itself stays edge-triggered and unchanged; the line exists so a
   * "should have launched but zero marker zero action" round is diagnosable
   * from the log alone (e.g. the task was already agent-waiting at baseline,
   * or the waiting_for edge never fired across a manual→auto switch).
   * Dedup observation re-reads the task log once per candidate per poll
   * (local HTTP — the price of a truthful per-round 查重 result); withheld
   * candidates (gate or whitelist) are not read at all.
   */
  private async logAutoDecisions(prev: ReadonlyMap<string, StateTask> | null, state: StateResponse): Promise<void> {
    for (const task of state.tasks) {
      if (!task.waiting_for.startsWith("agent:")) continue;
      const role = task.waiting_for.slice("agent:".length);
      const gate = this.autoGateReason(task);
      const whitelisted = autoWhitelisted(state.auto, role);
      let dedup = gate !== null ? "n/a (gate withheld)" : "n/a (not whitelisted)";
      if (gate === null && whitelisted) {
        try {
          const records = await this.deps.readLog(task.task_id);
          const blocked = launchBlocked(records, role);
          dedup = blocked.blocked ? `launched@v${blocked.noteVersion}` : "fresh";
        } catch (e) {
          dedup = `unreadable (${(e as Error).message})`;
        }
      }
      let action: string;
      if (gate !== null) {
        action = `withheld (gate: ${gate})`;
      } else if (!whitelisted) {
        action = `withheld (role '${role}' not in launch whitelist)`;
      } else if (dedup === "fresh") {
        if (prev === null) {
          action = "none (baseline poll; acting is edge-triggered)";
        } else {
          const beforeWf = prev.get(task.task_id)?.waiting_for ?? "none";
          action = beforeWf !== task.waiting_for
            ? `launch (waiting_for edge ${beforeWf} → ${task.waiting_for})`
            : "none (no waiting_for edge since last poll)";
        }
      } else if (dedup.startsWith("launched@")) {
        action = `none (already launched; ${dedup})`;
      } else {
        action = `none this poll; an edge would re-read the log (dedup ${dedup})`;
      }
      this.log(
        `[${task.task_id}] auto-decision: waiting_for=${task.waiting_for}` +
          ` | gate=${gate === null ? "pass" : `blocked (${gate})`}` +
          ` | needs_attention=${task.needs_attention}` +
          ` | whitelist=${whitelisted ? "pass" : `fail ('${role}' not in launch_roles)`}` +
          ` | dedup=${dedup} | action=${action}`,
      );
    }
  }

  /**
   * flow_mode visibility: a mode switch logs one line immediately; an
   * unchanged mode is re-echoed periodically (default 5 min) so the tail of
   * the notify log always answers "what mode are we in". The first
   * successful fetch stays silent here — the baseline line already carries
   * flow_mode.
   */
  private observeFlowMode(mode: string, now: number): void {
    if (this.lastFlowMode === null) {
      this.lastFlowMode = mode;
      this.lastModeEchoAt = now;
      return;
    }
    if (mode !== this.lastFlowMode) {
      this.log(`flow_mode changed: ${this.lastFlowMode} → ${mode}`);
      this.lastFlowMode = mode;
      this.lastModeEchoAt = now;
      return;
    }
    if (now - this.lastModeEchoAt >= FLOW_MODE_ECHO_INTERVAL_MS) {
      this.log(`flow_mode echo: ${mode}`);
      this.lastModeEchoAt = now;
    }
  }

  private async autoLaunch(task: StateTask, role: string): Promise<void> {
    const request: LaunchRequest = {
      kind: "round",
      task_id: task.task_id,
      role,
      fresh: false,
      via: "auto",
    };
    try {
      assertLaunchStateGate(request, task);
    } catch (e) {
      await this.autoLaunchFailed(task, role, e);
      return;
    }
    // Done-sweep barrier (1/3, entry): this task's final-screen evidence must
    // be archived (or its failure recorded) before this round's launch
    // machinery starts — the launcher reaps the very panes the sweep reads.
    await this.awaitSweepBarrier(task.task_id);
    let records: ContextRecord[];
    try {
      records = await this.deps.readLog(task.task_id);
    } catch (e) {
      await this.autoLaunchFailed(task, role, e);
      return;
    }

    let baseVersion: number;
    try {
      baseVersion = bindLaunchBaseVersion(task.version, latestRecordVersion(records));
    } catch (e) {
      await this.autoLaunchFailed(task, role, e);
      return;
    }

    const blocked = launchBlocked(records, role);
    if (blocked.blocked) {
      await this.autoLaunchSkipped(task, role, blocked.noteVersion);
      return;
    }

    // Resolve the Herdr snapshot and the workspace declaration snapshot before
    // planning the route.  Both are frozen at this planner boundary, so
    // naming, routing and birth cannot drift if focus, files, or environment
    // changes after this point.
    const environment = { ...process.env };
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
      await this.autoLaunchFailed(task, role, new Error(`context planning failed: ${(e as Error).message}`));
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
      await this.autoLaunchFailed(task, role, new Error(`workspace planning failed: ${(e as Error).message}`));
      return;
    }
    if (environment.TUT_DRY_RUN !== "1") {
      try {
        requireBirthAnchor(executionContext);
      } catch (e) {
        // No marker, no launch: a live auto door has the same mutation guard
        // as the legacy child, while cleanup/sweep remain best-effort paths.
        await this.autoLaunchFailed(task, role, e);
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
      await this.autoLaunchFailed(task, role, new Error(`precheck failed: ${(e as Error).message}`));
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
      await this.autoLaunchFailed(task, role, new Error(`invocation planning failed: ${(e as Error).message}`));
      return;
    }
    // Done-sweep barrier (2/3, post-planning): a done event may have landed
    // while readLog/precheck/invocation planning were in flight — re-check
    // immediately before the marker. From the resolution of this await to
    // the markLaunched call the code is one synchronous continuation (no
    // macrotask boundary), so a later done event cannot slip between this
    // check and the marker.
    await this.awaitSweepBarrier(task.task_id);
    let launchVersion: number | undefined;
    try {
      const marker = await this.deps.markLaunched(task.task_id, role, baseVersion, "auto", invocation.marker_projection);
      launchVersion = versionOf(marker) ?? task.version;
    } catch (e) {
      // A manual start-next or another notifier may have won the optimistic
      // append race. Re-read once: if its marker is now present, converge on
      // the same harmless skipped outcome instead of reporting a false error.
      try {
        const after = await this.deps.readLog(task.task_id);
        const afterBlocked = launchBlocked(after, role);
        if (afterBlocked.blocked) {
          await this.autoLaunchSkipped(task, role, afterBlocked.noteVersion);
          return;
        }
      } catch {
        // Keep the original append error as the actionable failure.
      }
      await this.autoLaunchFailed(task, role, e);
      return;
    }

    // Done-sweep barrier (3/3, pre-spawn): even if a razor-thin interleaving
    // let the marker slip past, the LAUNCH itself (the pane-reaping action)
    // still waits for the sweep.
    await this.awaitSweepBarrier(task.task_id);
    const launchKey = this.workingWatchKey(task.task_id, role);
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
        this.log(`launch.sh (${task.task_id}, ${role})${line ? ` → ${line}` : ""}`);
      }
      // A delivery give-up that landed while this launch was in flight has
      // already escalated this round's fate through the channels; arming the
      // short fuse now would re-alarm the same round five minutes later as a
      // generic "no working signal". Consume the record either way.
      const earlyGiveUp = this.earlyGiveUps.get(launchKey);
      this.earlyGiveUps.delete(launchKey);
      if (earlyGiveUp !== undefined) {
        this.log(`[${task.task_id}] short working fuse not armed: delivery gave up while the launch was completing (give-up alert already sent)`);
      } else {
        this.armWorkingWatch(task, role, agent, launchVersion);
      }
      this.log(
        `[${task.task_id}] launch succeeded for ${role}; waiting for working signal within ${Math.ceil(this.workingTimeoutMs / 1000)}s`,
      );
      await this.sendAll({
        title: `TUT ${task.task_id}: auto-launched ${role}`,
        body: `${task.title} — status: ${task.status}; launch succeeded for ${role} via launch.sh (pane: ${task.task_id}.${role}); waiting for the agent's working signal`,
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
      await this.autoLaunchFailed(task, role, e);
    }
  }

  private async autoLaunchSkipped(task: StateTask, role: string, noteVersion: number | undefined): Promise<void> {
    const suffix = noteVersion === undefined ? "" : ` at v${noteVersion}`;
    this.log(`auto launch skipped (already launched): ${task.task_id} (${role}${suffix})`);
    await this.sendAll({
      title: `TUT ${task.task_id}: auto launch skipped (already launched)`,
      body: `${task.title} — ${role} was already launched${suffix}; no new publish since`,
      task_id: task.task_id,
    });
  }

  private async autoLaunchFailed(task: StateTask, role: string, error: unknown): Promise<void> {
    const message = (error as Error).message;
    this.log(`launch failed for ${task.task_id} (${role}): ${message}`);
    await this.sendAll({
      title: `TUT ${task.task_id}: auto launch failed`,
      body: `${task.title} — launch.sh ${role} failed: ${message}; intervene manually`,
      task_id: task.task_id,
    });
  }

  // --- launch → working visibility -----------------------------------------------

  private workingWatchKey(taskId: string, role: string): string {
    return `${taskId}\u0000${role}`;
  }

  private armWorkingWatch(task: StateTask, role: string, agent: string, launchVersion?: number): void {
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

  private async launchGenerationSuperseded(taskId: string, launchVersion: number): Promise<boolean | undefined> {
    try {
      const records = await this.deps.readLog(taskId);
      return records.some(
        (record) => record.version > launchVersion && record.content_type !== "note",
      );
    } catch (e) {
      this.log(
        `[${taskId}] could not inspect launch generation v${launchVersion}: ${(e as Error).message}`,
      );
      return undefined;
    }
  }

  private async retireObsoleteWorkingWatches(currentTasks: ReadonlyMap<string, StateTask>): Promise<void> {
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
      const superseded = await this.launchGenerationSuperseded(watch.task.task_id, launchVersion);
      // A failed diagnostic read must not turn a still-valid watch into a
      // silent timeout. The timer remains armed and the next poll retries.
      if (superseded !== true) continue;
      this.clearWorkingWatch(key);
      this.log(`[${watch.task.task_id}] retired stale ${watch.role} working watch at task version ${current.version}`);
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
    const label = pane.trim();
    const prefix = `${taskId}.`;
    if (!label.startsWith(prefix)) return undefined;
    const role = label.slice(prefix.length).split(".", 1)[0];
    return role !== undefined && role.length > 0 ? role : undefined;
  }

  private async workingWatchForEvent(evt: AgentEvent, taskId: string): Promise<{ key: string; watch: WorkingWatch } | undefined> {
    const task = this.snapshot?.get(taskId);
    const paneRole = this.roundRoleFromPane(taskId, evt.pane);
    for (const [key, watch] of this.workingWatches) {
      if (watch.task.task_id !== taskId) continue;
      if (task?.waiting_for !== `agent:${watch.role}`) continue;
      if (paneRole !== undefined && watch.role !== paneRole) continue;
      // A prefix can still resolve a legacy/suffixed pane to the task, but a
      // working watch may only be cleared by the exact current round key.
      if (paneRole !== undefined && evt.pane.trim() !== `${taskId}.${watch.role}`) continue;
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
    const task = this.snapshot?.get(taskId);
    const paneRole = this.roundRoleFromPane(taskId, evt.pane);
    for (const [key, launch] of this.inFlightLaunches) {
      if (launch.task.task_id !== taskId) continue;
      if (task?.waiting_for !== `agent:${launch.role}`) continue;
      if (paneRole !== undefined && launch.role !== paneRole) continue;
      if (paneRole !== undefined && evt.pane.trim() !== `${taskId}.${launch.role}`) continue;
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
    const task = this.snapshot?.get(taskId);
    if (task === undefined || !task.waiting_for.startsWith("agent:")) return false;
    const currentRole = task.waiting_for.slice("agent:".length);
    const paneRole = this.roundRoleFromPane(taskId, evt.pane);
    if (paneRole !== undefined) {
      return paneRole === currentRole && evt.pane.trim() === `${taskId}.${currentRole}`;
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
        this.markProgress(taskId, this.deps.now());
        if (taskId !== evt.pane) {
          this.log(`working event pane '${evt.pane}' resolved to task ${taskId} (role-pane mapping)`);
        }
        this.earlyWorkingSignals.set(inFlight.key, evt);
        this.log(`[${taskId}] working signal arrived while ${inFlight.launch.role} launch was still completing`);
      } else if (this.workingEventMatchesCurrentTask(evt, taskId)) {
        this.markProgress(taskId, this.deps.now());
        if (taskId !== evt.pane) {
          this.log(`working event pane '${evt.pane}' resolved to task ${taskId} (role-pane mapping)`);
        }
      }
      return;
    }
    this.markProgress(taskId, this.deps.now());
    if (taskId !== evt.pane) {
      this.log(`working event pane '${evt.pane}' resolved to task ${taskId} (role-pane mapping)`);
    }
    this.clearWorkingWatch(hit.key);
    this.log(`[${taskId}] working signal received for ${hit.watch.role} (agent ${evt.agent || hit.watch.agent})`);
    void this.sendAll({
      title: `TUT ${taskId}: agent working`,
      body: `${hit.watch.task.title} — working signal received for ${hit.watch.role} in pane ${taskId}.${hit.watch.role}; launch hand-off is alive`,
      task_id: taskId,
    });
  }

  /**
   * Delivery give-up escalation (7.2.1): the launcher exhausted its bounded
   * submit-retry window and the submit stayed unconfirmed — whether the
   * prompt still sits in the pane's input box is exactly what the event's
   * evidence fields (box/transport/probe) report.  Escalate through the
   * configured channels IMMEDIATELY (the gap this closes: without it,
   * nobody outside the machine learns until the 30-minute stall watchdog
   * fires); the alert copy branches on that evidence per
   * deliveryGiveUpHint — never a blind "press Enter".
   *
   * Deliberately does NOT mark progress: a give-up is the opposite of
   * progress, so the stall watchdog keeps its clock as the backstop
   * reminder.  A matching live working watch IS disarmed — the give-up
   * alert is the "no working signal" report with better precision than the
   * generic short fuse; if the human presses Enter afterwards, the late
   * working signal still marks progress like any unwatched round.
   */
  private async handleDeliveryGiveUp(evt: AgentEvent, taskId: string | null): Promise<void> {
    if (taskId === null) {
      // Same rate-limited degradation as the other unmatched events.
      const agg = this.rateLimitUnmatched(evt);
      if (agg !== null) {
        this.log(`delivery give-up event pane '${evt.pane}' matches no task (4.4 convention broken)${agg}`);
        void this.sendAll({
          title: `TUT ${evt.pane}: prompt delivery gave up`,
          body: `Prompt delivery to pane ${evt.pane} gave up — ${deliveryGiveUpHint(evt)}`,
        });
      }
      return;
    }
    const hit = await this.workingWatchForEvent(evt, taskId);
    if (hit !== undefined) {
      this.clearWorkingWatch(hit.key);
      this.log(`[${taskId}] delivery give-up received for ${hit.watch.role}; short working fuse disarmed (this alert replaces it)`);
    } else {
      // Real auto ordering: the launcher child emits this event BEFORE it
      // exits, so the give-up beats the launch return — no live watch yet.
      // Record against the in-flight launch so the fuse is never armed for
      // this round (same shape as earlyWorkingSignals). No markProgress:
      // the stall watchdog keeps its clock.
      const inFlight = await this.inFlightLaunchForEvent(evt, taskId);
      if (inFlight !== undefined) {
        this.earlyGiveUps.set(inFlight.key, evt);
        this.log(`[${taskId}] delivery give-up arrived while the ${inFlight.launch.role} launch was still completing; short fuse will not be armed`);
      }
    }
    const paneRole = this.roundRoleFromPane(taskId, evt.pane);
    const roleSeg = paneRole !== undefined ? ` for ${paneRole}` : "";
    const via = taskId !== evt.pane ? ` (pane ${evt.pane})` : "";
    const hint = deliveryGiveUpHint(evt);
    this.log(`[${taskId}] delivery gave up${roleSeg}${via} — ${hint}`);
    const title = this.snapshot?.get(taskId)?.title ?? taskId;
    await this.sendAll({
      title: `TUT ${taskId}: prompt delivery gave up`,
      body: `${title} — prompt delivery${roleSeg}${via} gave up: ${hint}`,
      task_id: taskId,
    });
  }

  private async handleWorkingTimeout(key: string, watch: WorkingWatch): Promise<void> {
    // A publish/decision may have advanced or closed the task while the
    // signal was in flight. In that case the workflow itself is evidence of
    // progress; do not raise a stale launch alarm.
    const current = this.snapshot?.get(watch.task.task_id);
    if (current === undefined || current.waiting_for !== `agent:${watch.role}`) return;
    const seconds = Math.ceil(this.workingTimeoutMs / 1000);
    this.log(`[${watch.task.task_id}] launch working timeout for ${watch.role} after ${seconds}s; no working signal observed`);
    await this.sendAll({
      title: `TUT ${watch.task.task_id}: launch succeeded but no working signal`,
      body: `${watch.task.title} — ${watch.role} was launched via launch.sh, but no working signal arrived within ${seconds}s; intervene manually`,
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
    void this.requestCompare()
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
          this.log(`working event pane '${evt.pane}' resolves to no task; stall refresh skipped${agg}`);
        }
      })
      .catch((e: unknown) => {
        this.unresolvedWorkingEvents.delete(key);
        this.log(`working event pane '${evt.pane}' could not be re-resolved: ${(e as Error).message}`);
      });
  }

  private async sendAll(msg: Notification): Promise<void> {
    // stdout IS the run log for the dedicated pane (system-design 8.2) — every
    // notification send is visible here, not only on the desktop banner.
    this.log(`${msg.task_id ? `[${msg.task_id}] ` : ""}${msg.title}`);
    for (const ch of this.channels) {
      try {
        await ch.send(msg);
      } catch (e) {
        this.log(`channel ${ch.name} failed: ${(e as Error).message}`);
      }
    }
  }

  // --- stall watchdog (§3 超时兜底; no-signal-source degradation) -----------------

  private markProgress(taskId: string, now: number): void {
    this.lastProgressAt.set(taskId, now);
    this.stallNotified.delete(taskId);
  }

  private checkStalls(tasks: readonly StateTask[], now: number): void {
    for (const t of tasks) {
      if (this.lastUpdatedAt.get(t.task_id) !== t.updated_at) {
        // Any updated_at append resets the timer (note appends included —
        // accepted heuristic).
        this.lastUpdatedAt.set(t.task_id, t.updated_at);
        this.markProgress(t.task_id, now);
        continue;
      }
      if (!t.waiting_for.startsWith("agent:")) {
        this.markProgress(t.task_id, now);
        continue;
      }
      const last = this.lastProgressAt.get(t.task_id);
      if (last === undefined) {
        this.markProgress(t.task_id, now);
        continue;
      }
      if (now - last >= this.stallMs && !this.stallNotified.has(t.task_id)) {
        this.stallNotified.add(t.task_id);
        void this.sendAll({
          title: `TUT ${t.task_id}: possibly stalled`,
          body: `${t.title} — waiting for ${t.waiting_for} with no update for ${Math.round(this.stallMs / 60_000)} min (updated_at ${t.updated_at})`,
          task_id: t.task_id,
        });
      }
    }
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
    const snap = this.snapshot;
    if (snap === null) return null;
    const label = pane.trim();
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
      this.log(
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
        this.log(
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
    const taskId = this.resolveEventTask(evt.pane);
    switch (evt.event) {
      case "working":
        if (taskId !== null) {
          void this.handleWorkingSignal(evt, taskId).catch((e: unknown) => {
            this.log(`working event handling failed: ${(e as Error).message}`);
          });
        } else {
          // A signal can beat the next /state poll (especially on a fresh
          // launch). Give the snapshot one compare to catch up before
          // declaring the prefix reverse lookup broken.
          this.queueUnresolvedWorkingEvent(evt);
        }
        return;
      case "blocked": {
        // An observed signal refreshes the stall timer too (judgment: a stuck
        // agent is alive; a stall reminder right after this would be noise).
        // blocked is an追加触发 immediate compare (system-design 6.1):
        // the stuck agent may have just published; a compare picks it up now.
        // The UNMATCHED degradation (log + notify) is rate-limited
        // per source — the immediate compare above is never suppressed.
        if (taskId !== null) {
          this.markProgress(taskId, this.deps.now());
          void this.sendAll({
            title: `TUT ${taskId}: agent stuck`,
            body: `Agent ${evt.agent} appears blocked in pane ${evt.pane}${taskId !== evt.pane ? ` (task ${taskId})` : ""}`,
            // task_id only when a task was really resolved — an unmatched pane
            // name is not a task id, and the body already carries it.
            task_id: taskId,
          });
        } else {
          const agg = this.rateLimitUnmatched(evt);
          if (agg !== null) {
            this.log(`blocked event pane '${evt.pane}' matches no task (4.4 convention broken)${agg}`);
            void this.sendAll({
              title: `TUT ${evt.pane}: agent stuck`,
              body: `Agent ${evt.agent} appears blocked in pane ${evt.pane}`,
            });
          }
        }
        void this.requestCompare();
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
        this.log(`done event pane '${evt.pane}' matches no task (4.4 convention broken); degrading to compare${agg}`);
      }
      await this.requestCompare();
      return;
    }
    const atEvent = this.snapshot?.get(taskId);
    if (atEvent === undefined) {
      // Resolved a moment ago but gone from the snapshot now — degrade.
      this.log(`done event pane '${evt.pane}' resolved task ${taskId} no longer present; degrading to compare`);
      await this.requestCompare();
      return;
    }
    await this.runDoneSweep(taskId);
    const via = taskId !== evt.pane ? ` (pane ${evt.pane})` : "";
    const wfAtEvent = atEvent.waiting_for;
    await this.requestCompare(); // may coalesce with a concurrent tick (one action)
    const immediate = this.snapshot?.get(taskId);
    if (immediate !== undefined && immediate.waiting_for !== wfAtEvent) return; // published in time
    const delayMs = Math.max(this.intervalMs, 2000);
    const timer = setTimeout(() => {
      void this.requestCompare()
        .then(() => {
          const later = this.snapshot?.get(taskId);
          if (later !== undefined && later.waiting_for === wfAtEvent) {
            void this.sendAll({
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
      this.log(`[${taskId}] done sweep failed unexpectedly: ${(e as Error).message}`);
    });
    this.sweepBarriers.set(taskId, sweep);
    await sweep;
    if (this.sweepBarriers.get(taskId) === sweep) this.sweepBarriers.delete(taskId);
  }

  /** Awaits the task's in-flight done sweep, if any (no-op otherwise). */
  private async awaitSweepBarrier(taskId: string): Promise<void> {
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
    let panes: PaneSnapshot[];
    try {
      panes = await this.paneLister();
    } catch (e) {
      this.log(`[${taskId}] done sweep skipped: pane list failed (${(e as Error).message})`);
      return;
    }
    // Prefix match is exact at the namespace boundary: task slugs carry no
    // dots (slug alphabet [a-z0-9-]), so `${taskId}.` cannot span into a
    // longer task's namespace (t1. never matches t1-long.*).
    const scoped = panes.filter((p) => p.label.startsWith(`${taskId}.`));
    if (scoped.length === 0) {
      this.log(`[${taskId}] done sweep: no round panes left to snapshot`);
      return;
    }
    const at = new Date(this.deps.now()).toISOString();
    for (const pane of scoped) {
      let screen: string;
      try {
        screen = await this.paneReader(pane.pane_id);
      } catch (e) {
        this.log(`[${taskId}] done sweep: pane '${pane.label}' (${pane.pane_id}) read failed (${(e as Error).message})`);
        continue;
      }
      this.log(`[${taskId}] done sweep — pane '${pane.label}' (${pane.pane_id}) final screen @ ${at}:`);
      const lines = screen.replace(/\n+$/, "").split("\n");
      if (lines.length === 1 && lines[0] === "") {
        this.log(`[${taskId}] sweep ${at} ${pane.label} | (empty screen)`);
        continue;
      }
      for (const line of lines) {
        this.log(`[${taskId}] sweep ${at} ${pane.label} | ${line}`);
      }
    }
  }

  // --- event HTTP listener (loopback Host guard mirrors src/http.ts) ---------------

  async startEventServer(): Promise<void> {
    if (this.server !== null) return;
    const server = createServer((req, res) => {
      void this.handleEventRequest(req, res).catch((e: unknown) => {
        this.log(`event request failed: ${(e as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        if (!res.writableEnded) res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onListenError = (e: Error): void => {
        const code = (e as NodeJS.ErrnoException).code;
        // Visible in the dedicated pane: listener occupied is fatal (8.2).
        reject(new Error(`cannot listen on 127.0.0.1:${this.eventPort}: ${code !== undefined ? `${code} — ` : ""}${e.message}`));
      };
      server.once("error", onListenError);
      server.listen(this.eventPort, "127.0.0.1", () => {
        server.off("error", onListenError);
        server.on("error", (e) => this.log(`event listener error: ${(e as Error).message}`));
        resolve();
      });
    });
    this.server = server;
    this.log(`listening for agent events on http://127.0.0.1:${this.eventPort}/agent-event`);
  }

  private async handleEventRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackHost(req)) {
      sendJson(res, 403, { error: "forbidden: Host header must be a loopback host" });
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/agent-event") {
      sendJson(res, 404, { error: `not found: ${req.method} ${pathname}` });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed: use POST /agent-event" }));
      return;
    }
    const raw = await readBody(req, EVENT_BODY_LIMIT);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log("ignoring event with invalid JSON body");
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }
    const evt = parsed as {
      event?: unknown;
      agent?: unknown;
      pane?: unknown;
      box?: unknown;
      transport?: unknown;
      probe?: unknown;
    };
    if (typeof evt.event !== "string" || typeof evt.agent !== "string" || typeof evt.pane !== "string") {
      this.log("ignoring event with invalid shape (need string event/agent/pane)");
      sendJson(res, 400, { error: "invalid event shape" });
      return;
    }
    if (evt.event !== "working" && evt.event !== "blocked" && evt.event !== "done" && evt.event !== "delivery_giveup") {
      this.log(`ignoring unknown event: ${evt.event}`);
      sendJson(res, 200, { ok: true, ignored: true });
      return;
    }
    // Give-up evidence (7.2.1 additive fields): the required core pair
    // box + transport is normalized ATOMICALLY — both pass through only
    // when both are well-typed; a half-valid payload degrades to no
    // evidence (conservative hint), never to a trusted box.  probe is
    // optional and independent; legacy three-field bodies and typo'd
    // fields drop out the same way.
    const box = evt.box;
    const transport = evt.transport;
    const atomic = (box === "held" || box === "cleared" || box === "unknown") && typeof transport === "boolean";
    const probe =
      evt.probe === "observed" || evt.probe === "failed" || evt.probe === "unavailable" ? evt.probe : undefined;
    this.receiveEvent({
      event: evt.event,
      agent: evt.agent,
      pane: evt.pane,
      ...(atomic ? { box } : {}),
      ...(atomic ? { transport } : {}),
      ...(probe === undefined ? {} : { probe }),
    });
    sendJson(res, 200, { ok: true });
  }

  // --- lifecycle ---------------------------------------------------------------------

  /** Starts the poll loop: one immediate baseline compare, then each interval. */
  startPolling(): void {
    if (this.pollTimer !== null) return;
    void this.requestCompare();
    this.pollTimer = setInterval(() => void this.requestCompare(), this.intervalMs);
  }

  async close(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.workingWatches.clear();
    this.inFlightLaunches.clear();
    this.earlyWorkingSignals.clear();
    this.earlyGiveUps.clear();
    this.unresolvedWorkingEvents.clear();
    this.pendingApprovalTasks.clear();
    this.sweepBarriers.clear();
    this.unmatchedSources.clear();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

// --- daemon entry -------------------------------------------------------------------

/**
 * `tut notify` daemon: starts the event listener first (EADDRINUSE rejects —
 * caller prints and exits non-zero, visible in the dedicated pane), then the
 * poll loop, then parks until SIGINT/SIGTERM.
 */
export async function runNotify(options: NotifyOptions): Promise<void> {
  const notifier = new Notifier(options);
  await notifier.startEventServer();
  notifier.startPolling();
  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      void notifier.close().then(
        () => resolve(),
        () => resolve(),
      );
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

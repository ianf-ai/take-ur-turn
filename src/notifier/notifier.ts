import { createEnterRepress, RemediationAttempts, type Remediator } from '../remediator.js';
import { createRemediationAudit, type DeliveryDiagnostics } from '../launcher/delivery.js';
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
 * points therefore cannot double-notify or double-launch. The auto launcher
 * child is the one deliberate exception: it runs on a per task+role
 * chain OFF the queue once the launch marker is appended, so a wedged or slow
 * launcher child cannot freeze every other task's compares; the child itself
 * is bounded by a liveness backstop (runNodeCommand timeout → kill → failure
 * path), and herdr control commands carry their own per-command timeout. The
 * close-edge cleanup child (fired on the observed transition into
 * `closed`) is the same kind of exception — detached from the queue, bounded
 * by the same backstop, best-effort with one log line as its whole output.
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

import { canonicalRoot, resolveRigRoot } from "../hub/rig-discovery.js";
import { rigLabel, rigEnvironment, unscopedLabel } from "../hub/rig.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createChannels, type Channel, type Notification } from "../common/channels.js";
import {
  launchBlocked,
  latestRecordVersion,
  markLaunched as appendLaunchMarker,
  readLaunchLog,
  resolveLaunchTargetWithSource,
  type LaunchVia,
} from "../launcher/launch.js";
import { commandHead, commandArgs } from "../common/agent-command.js";
import type { GiveUpBoxEvidence, GiveUpProbeEvidence } from "../launcher/escalation.js";
import { giveUpGuidance, parseDeliveryV2 } from "../launcher/escalation.js";
import { assertLaunchStateGate, bindLaunchBaseVersion, buildLaunchInvocation } from "../launcher/invocation.js";
import {
  AgentTargetError,
  UnsupportedWindowsShimError,
  planForPlatform,
  resolvePosixTargetPresence,
  type PlatformExecutionPlan,
} from "../launcher/target-resolver.js";
import { runInternalLaunch, runInternalLaunchInvocation, DEFAULT_CHILD_TIMEOUT_MS } from "../launcher/process.js";
import { requireBirthAnchor, resolveExecutionContext } from "../launcher/anchor.js";
import { relayHostStatus, type HostStatusReport } from "./host-relay.js";
import { HerdrClient } from "../launcher/legacy-herdr-client.js";
import { HUB_FETCH_TIMEOUT_MS, HubSession, hubReadVia } from "../hub/hub-client.js";
import type { AgentCommand, AgentRoute, Cast, CheckoutRoute, ContextRecord, ExecutionContext, LaunchInvocation, LaunchMarkerProjection, LaunchRequest, LaunchRouteSource } from "../common/types.js";
import {
  KNOWN_ROLES,
  defaultUserConfigDir,
  readWorkspaceConfigSnapshot,
  resolveAgentRouteFromSnapshot,
  resolveTabLabelTemplateFromSnapshot,
  type WorkspaceConfigSnapshot,
} from "../common/workspace.js";

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
  box?: GiveUpBoxEvidence;
  transport?: boolean;
  probe?: GiveUpProbeEvidence;
}

/** Only a complete v2 block explains the outcome; legacy fields are diagnostic. */
function deliveryGiveUpHint(evt: Pick<AgentEvent, "delivery_v2">): string {
  const evidence = parseDeliveryV2(evt.delivery_v2);
  return `${evidence ? `reason=${evidence.reason} — ` : ""}${giveUpGuidance()}`;
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
  /**
   * Close-edge pane cleanup (system-design 4.4): reap `<task_id>.*`
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
  remediator?: Remediator;
  remediationAudit?(taskId: string, role: string): DeliveryDiagnostics;
}

// --- defaults --------------------------------------------------------------------

function stateUrlOf(url: string): string {
  return `${url.replace(/\/+$/, "")}/state`;
}

async function defaultFetchState(url: string): Promise<StateResponse> {
  // Every Hub fetch is bounded — a wedged/half-open hub
  // connection fails diagnosably within the timeout instead of pinning the
  // compare cycle indefinitely (poll failure handling keeps the snapshot).
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`GET ${url} timed out after ${HUB_FETCH_TIMEOUT_MS}ms`);
    }
    throw e;
  }
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
  const agentPlan = plan.platform === "posix" ? plan.posix_direct : plan.effective_agent;
  agentPlan.env = { ...agentPlan.env, ...rigEnvironment(context.hubRoot, hubUrl, environment.TUT_EVENT_PORT_URL || "http://127.0.0.1:3002/agent-event") };
  const template = resolveTabLabelTemplateFromSnapshot(workspaceSnapshot);
  const skillPath = fileURLToPath(new URL(`../../skills/${role}.md`, import.meta.url));
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
 * Close-edge cleanup child (system-design 4.4): the same internal
 * `launch --cleanup <task_id>` boundary `tut decide close` spawns
 * synchronously — the notifier adds the consumer-side edge so a close that
 * landed through ANY entrance (MCP decide, 4.1) still reaps the task's
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

/** One entry of the per-task log cache (see Notifier.logCache for the protocol). */
interface LogCacheEntry {
  /** Highest synced record version (0 = synced an empty log). */
  version: number;
  /** Merged records in audit order (ascending version; equal versions keep arrival order). */
  records: ContextRecord[];
  /** /state entry signature at the last successful sync; null when that pull ran without a /state entry. */
  sig: string | null;
}

/**
 * Fold-visible /state signature of a task entry: the
 * fields /state re-derives from the record set every poll — status,
 * waiting_for, needs_attention — plus updated_at (bumped by every
 * store-mediated write). External damage that changes what the fold would
 * produce (a same-version duplicate, a repair) changes this signature
 * WITHOUT advancing /state's version field, which is exactly the signal the
 * cache uses to order a full re-sync; a legit append changes it too, but
 * appends advance the version, and the cache only falls back on a signature
 * change at an UNCHANGED version. Tasks whose /state entry carries no
 * version (older hubs / fixtures) never take the signature path.
 */
function stateTaskSig(task: StateTask): string {
  return JSON.stringify([task.status, task.waiting_for, task.needs_attention, task.updated_at]);
}

/** Structural deep-equality of two records: identity for the
 * merge — a record is "the same one" only when every field and the whole
 * payload match. The wire carries no file names, so full-record equivalence
 * is the strongest identity available; two DIFFERENT records sharing a
 * version (VERSION_DUPLICATE shape) compare unequal and both stay. */
function recordsEqual(a: ContextRecord, b: ContextRecord): boolean {
  const av = a as unknown as Record<string, unknown>;
  const bv = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  for (const key of keys) {
    if (!jsonEquivalent(av[key], bv[key])) return false;
  }
  return true;
}

function jsonEquivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEquivalent(item, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!jsonEquivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

export class Notifier {
  private readonly stateUrl: string;
  private readonly intervalMs: number;
  private readonly stallMs: number;
  private readonly workingTimeoutMs: number;
  private readonly eventPort: number;
  private readonly rigRoot = resolveRigRoot();
  private readonly deps: NotifierDeps;

  /**
   * Resident Hub MCP session: connected lazily on the first
   * incremental readLog and reused for every later one — one TCP connection
   * and one MCP handshake for the notifier's lifetime instead of a fresh
   * session per candidate per poll. Dropped (and reconnected on the next
   * call) on any transport-level failure; closed in close().
   */
  private hubSession: HubSession | null = null;
  /**
   * Per-task merged task log: records ≤ version came from earlier
   * pulls, records above arrive via readLogSince. Serves launchBlocked /
   * latestRecordVersion / generation scans without re-pulling history.
   * Entries are dropped when a task leaves tasks∪degraded (vanished/deleted),
   * when /state reports a version BELOW the cached one (history rewound
   * externally — the merge would otherwise keep phantom records forever), or
   * when the task's /state-visible shape changed WITHOUT
   * a version advance (same-version duplicate landed externally, a repair
   * rewrote the fold): such records are unreachable through an incremental
   * pull (their version is ≤ the cached max), so the entry is dropped and the
   * next pull is a FULL re-sync — and, additionally, when a previously
   * needs_attention task's attention CLEARED between polls: records that
   * landed invisibly while the anomaly was set (no /state field changed) are
   * recovered by that full re-sync exactly when the launch gate starts
   * consulting the cache again. `sig` is the /state entry signature the last
   * successful sync ran under (null when that pull had no /state entry at
   * hand — e.g. the marker-race re-read); a null/stale sig never lets a
   * quiet-round skip through, so the worst case is one extra full pull.
   */
  private logCache = new Map<string, LogCacheEntry>();

  private snapshot: Map<string, StateTask> | null = null;
  private remediationMode: "off" | "enter-repress" = "off";
  private readonly remediator: Remediator;
  private readonly remediationAttempts = new RemediationAttempts();
  private readonly remediationAudit: (taskId: string, role: string) => DeliveryDiagnostics;
  private closed = false;
  /** Tasks whose pending_approval entry edge has already been notified. */
  private pendingApprovalTasks = new Set<string>();
  /** Degraded ids as of the last successful poll (system-design 4.3);
   *  null before the first fetch. */
  private lastDegraded: Set<string> | null = null;
  /** Currently-degraded ids whose entering edge has already been alerted
   *  (exactly-once per degraded stay; cleared on the recovery edge so a
   *  later re-corruption alerts again). */
  private degradedAlerted = new Set<string>();
  /** Vanished ids whose disappearance edge has already been alerted
   *  (cleared when the directory comes back). */
  private vanishedAlerted = new Set<string>();
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
  /**
   * Per task+role launcher-child chains (post-marker stage):
   * each new round's child waits for the previous one, but the chain runs
   * OFF the compare queue — a wedged launcher child can no longer freeze
   * every compare; it drags at most its own task.
   */
  private launchChains = new Map<string, Promise<void>>();

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
    this.remediator = deps.remediator ?? createEnterRepress();
    this.remediationAudit = deps.remediationAudit ?? ((taskId, role) => createRemediationAudit({
      env: { ...process.env, TUT_PROJECT_ROOT: this.rigRoot },
      task_id: taskId, role, stderr: text => this.log(text.trimEnd()),
    }));
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
    // Incremental readLog wiring: an explicitly injected readLog
    // keeps the full-pull contract its tests rely on; otherwise the default
    // resident-session incremental pull is installed (an injected
    // readLogSince always wins over the default). The parameter is the wire
    // contract verbatim — INCLUSIVE version ≥ sinceVersion; 0 means
    // "everything", translated to an omitted field (the wire schema is
    // since_version ≥ 1 or absent). fullLog supplies cached.version + 1 once
    // a cache exists, so the inclusive contract still fetches
    // strictly-new records.
    const defaultReadLogSince = (taskId: string, sinceVersion: number): Promise<{ versions: ContextRecord[] }> =>
      hubReadVia(
        this.ensureHubSession(),
        taskId,
        sinceVersion > 0 ? sinceVersion : undefined,
      ).then((res) => ({ versions: res.versions }));
    const readLogSince =
      deps.readLogSince !== undefined
        ? deps.readLogSince
        : deps.readLog === undefined
          ? defaultReadLogSince
          : undefined;
    this.deps = {
      fetchState: deps.fetchState ?? defaultFetchState,
      launch: deps.launch ?? spawnLaunch,
      cleanupPanes: deps.cleanupPanes ?? ((taskId) => spawnCleanupPanes(taskId, { ...process.env, TUT_HUB_ROOT: this.rigRoot })),
      relayHostStatus: deps.relayHostStatus ?? relayHostStatus,
      ...(canonicalLaunch !== undefined ? { launchInvocation: canonicalLaunch } : {}),
      readLog: deps.readLog ?? ((taskId) => readLaunchLog(options.url, taskId)),
      ...(readLogSince !== undefined ? { readLogSince } : {}),
      markLaunched: deps.markLaunched ?? ((taskId, role, baseVersion, via, projection) => appendLaunchMarker(options.url, taskId, role, baseVersion, via, projection)),
      channelsFor: deps.channelsFor ?? createChannels,
      now: deps.now ?? (() => Date.now()),
      log: deps.log ?? defaultLog,
    };
  }

  /** The resident Hub session, connected on first use. */
  private ensureHubSession(): HubSession {
    this.hubSession ??= new HubSession(this.stateUrl.replace(/\/state$/u, ""), { clientName: "tut-notifier" });
    return this.hubSession;
  }

  /**
   * Full task log for dedup / base-version / generation scans, incremental
   * when readLogSince is wired.
   * Governed protocol, driven by the task's /state entry when the caller has
   * one (the poll's candidate/generation scans always do):
   *
   *   - quiet round (cache covers entry.version AND the entry's fold-visible
   *     signature matches the one the cache last synced under): the merged
   *     records are served from memory — ZERO Hub log requests/responses, the
   *     §4 "≤ bytes added since the previous round" gate reads 0 on a silent
   *     poll. An entry without a version (older hub) can never
   *     be proven covered, so it always pulls.
   *   - otherwise: one context.read at since_version = cached.version + 1 —
   *     the INCLUSIVE wire contract therefore fetches strictly-new versions
   *     and never re-reads the cached tail. No cache yet → 0 =
   *     full pull. The reply merges by record identity (deep equality), so
   *     same-version DIFFERENT records all survive and fold in audit order;
   *     a rewind or signature change has already dropped the
   *     entry in reconcileLogCache, making the next pull a full re-sync.
   *
   * A failed pull throws with the cache untouched — callers already treat a
   * read failure as "unreadable" and retry next poll.
   */
  private async fullLog(taskId: string, entry?: StateTask): Promise<ContextRecord[]> {
    const incremental = this.deps.readLogSince;
    if (incremental === undefined) return await this.deps.readLog(taskId);
    const cached = this.logCache.get(taskId);
    if (
      cached !== undefined &&
      entry !== undefined &&
      entry.version !== undefined &&
      cached.version >= entry.version &&
      cached.sig !== null &&
      cached.sig === stateTaskSig(entry)
    ) {
      return cached.records; // quiet round — /state already covers the cached history
    }
    // Exclusive lower bound → inclusive wire parameter: cached.version + 1.
    // A dropped/stale cache (no entry, signature mismatch, rewind) starts at 0.
    const lowerBound = cached?.version ?? 0;
    const since = lowerBound > 0 ? lowerBound + 1 : 0;
    const res = await incremental(taskId, since);
    let merged: ContextRecord[];
    let maxVersion = lowerBound;
    if (cached === undefined) {
      merged = [...res.versions];
    } else {
      merged = [...cached.records];
      for (const record of res.versions) {
        // Identity dedup only: a record already present verbatim
        // is skipped; a DIFFERENT record at an already-cached version survives
        // — the wire's same-version duplicates are distinct audit records and
        // must all reach launchBlocked / the generation scans.
        if (!merged.some((m) => recordsEqual(m, record))) merged.push(record);
      }
      merged.sort((a, b) => a.version - b.version); // stable: equal versions keep arrival order
    }
    for (const record of res.versions) maxVersion = Math.max(maxVersion, record.version);
    this.logCache.set(taskId, { version: maxVersion, records: merged, sig: entry !== undefined ? stateTaskSig(entry) : cached?.sig ?? null });
    return merged;
  }

  /**
   * Log-cache housekeeping: entries for ids no longer known to
   * /state are dropped (vanished/deleted — a later reappearance must not
   * serve phantom history), a task whose /state version fell BELOW the
   * cached version had its history rewound externally — drop it so the next
   * pull starts from zero — and a task whose fold-visible
   * /state signature changed at an UNCHANGED version had records land that
   * an incremental pull can never reach (same-version duplicates, repairs):
   * drop it too, forcing a full re-sync on the next pull. Version advances
   * keep the entry (the delta is exactly what since_version fetches); entries
   * without a /state version (older hubs) only take the vanished path.
   *
   * Attention-clearing edge: `prev` is the previous
   * poll's snapshot. A task observed needs_attention=true last poll and false
   * now had its anomaly resolved — and while attention was set, same-version
   * records could land with NO /state-visible change at all (status,
   * waiting_for, needs_attention already true, updated_at untouched by
   * external writes): the signature rule cannot see them, and the resolving
   * record (an ack) ADVANCES the version, so the incremental pull at
   * cached.version + 1 fetches only the ack — the invisible records stay
   * unreachable forever. Evicting on the clearing edge makes the next pull a
   * FULL re-sync: whatever landed during the anomalous stay is recovered
   * exactly when the launch gate starts consulting the cache again (a
   * needs_attention task is gate-withheld, so the stale window is never
   * acted on). The edge is rare (once per anomaly lifetime) and never fires
   * for clean tasks — the quiet-round zero-request gate is untouched.
   */
  private reconcileLogCache(state: StateResponse, prev: ReadonlyMap<string, StateTask> | null): void {
    if (this.logCache.size === 0) return;
    const known = new Set<string>([...state.tasks.map((t) => t.task_id), ...(state.degraded ?? [])]);
    for (const [taskId, entry] of this.logCache) {
      if (!known.has(taskId)) {
        this.logCache.delete(taskId);
        continue;
      }
      const task = state.tasks.find((t) => t.task_id === taskId);
      if (task?.version === undefined) continue;
      if (entry.version > task.version) {
        this.logCache.delete(taskId); // rewind
        continue;
      }
      if (prev?.get(taskId)?.needs_attention === true && task.needs_attention === false) {
        this.logCache.delete(taskId); // attention cleared — recover anything that landed invisibly while set
        continue;
      }
      if (task.version === entry.version && entry.sig !== null && entry.sig !== stateTaskSig(task)) {
        this.logCache.delete(taskId); // shape changed under the same version — full re-sync next pull
      }
    }
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
    const prevDegraded = this.lastDegraded;
    const now = this.deps.now();
    this.snapshot = new Map(state.tasks.map((t) => [t.task_id, t]));
    this.remediationMode = state.auto?.remediate ?? (state.flow_mode === "auto" ? "enter-repress" : "off");
    this.lastDegraded = new Set(state.degraded ?? []);
    this.reconcileLogCache(state, prev);
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
      // First successful fetch: baseline, no workflow notifications — but a
      // task ALREADY degraded at startup is exactly the silent-loss shape the
      // degraded listing exists to kill, so its entering edge alerts here (the notifier cannot
      // know it was degraded before it started watching).
      await this.diffDegraded(null, prevDegraded, this.lastDegraded, state);
      for (const t of state.tasks) {
        this.lastUpdatedAt.set(t.task_id, t.updated_at);
        this.lastProgressAt.set(t.task_id, now);
        if (t.status === "pending_approval") this.pendingApprovalTasks.add(t.task_id);
      }
      this.log(
        `baseline: ${state.tasks.length} task(s), flow_mode=${state.flow_mode}` +
          ((state.degraded?.length ?? 0) > 0 ? `, degraded=${state.degraded!.length}` : ""),
      );
      // Decision lines on the baseline poll too — a task that is
      // ALREADY agent-waiting when the notifier (re)starts is exactly the
      // silent-door shape; its "no action, and why" must be visible.
      if (state.flow_mode === "auto") await this.logAutoDecisions(null, state);
      return;
    }

    try {
      // Recovery bookkeeping runs FIRST so this poll knows which tasks just
      // re-entered tasks[] from degraded / vanished — the recovery edge is a
      // log line only (system-design 6.1), and that verdict must gate both the
      // auto-decision lines and diffTask below.
      const recoveredThisTick = await this.diffDegraded(prev, prevDegraded, this.lastDegraded, state);
      // Per-poll decision lines precede this poll's acting — the line
      // announces the launch (or the reason there will be none) first.
      if (state.flow_mode === "auto") await this.logAutoDecisions(prev, state, recoveredThisTick);
      for (const after of state.tasks) {
        // A task that just left degraded or came back from vanished is NOT a
        // new task: prev has no entry for it (it was absent from tasks[]), so
        // diffTask would fire waiting-for / approval notifications and even
        // an auto launch off a first-sight `before === undefined`. The
        // recovery tick records the recovery log line only; the NEXT tick
        // diffs against this tick's snapshot entry, so genuine later state
        // changes flow through the existing edges as usual. (Records cannot
        // change while a task is degraded — append refuses until the storage
        // chain folds — so nothing real is swallowed by one quiet poll.)
        if (recoveredThisTick.has(after.task_id)) {
          // Stall-clock restart: the watchdog kept
          // the pre-degradation lastProgressAt — nothing could refresh it
          // while the task was invisible (degraded or vanished). Running
          // that stale clock into checkStalls below would fire "possibly
          // stalled" on the very tick that must stay log-only. Restart from
          // NOW; markProgress also clears stallNotified, so a genuine stall
          // after recovery alerts again after one full fresh threshold.
          this.lastUpdatedAt.set(after.task_id, after.updated_at);
          this.markProgress(after.task_id, now);
          continue;
        }
        await this.diffTask(prev.get(after.task_id), after, state.flow_mode, state.auto, state.notify);
      }
      this.checkStalls(state.tasks, now);
    } catch (e) {
      // compare/act itself should never throw; if it does, log and survive.
      this.log(`compare failed unexpectedly: ${(e as Error).message}`);
    }
  }

  /**
   * Degraded / disappearance edges on the task-SET level (system-design
   * 4.3 + 6.1). Storage corruption never silently vanishes a task again:
   * entering `degraded` alerts exactly once per stay (re-corruption after a
   * repair alerts again — the recovery edge cleared the bookkeeping), the
   * recovery edge (back in tasks[]) is a log line only (no re-alert), and a
   * task known from the previous snapshot that is absent from BOTH tasks and
   * degraded now has vanished — its directory disappeared; that alerts once
   * with copy clearly distinct from storage corruption (close does not apply:
   * there is no log left to append to). prevTasks may be null (baseline —
   * nothing known before, so only degraded entering edges fire).
   *
   * Returns the set of tasks that re-entered tasks[] THIS poll (left
   * degraded, or reappeared after a vanished stay): their recovery edge is a
   * log line only — compareAndAct suppresses their diffTask/auto-decision
   * acting so a repaired task is never mistaken for a brand-new one.
   */
  private async diffDegraded(
    prevTasks: ReadonlyMap<string, StateTask> | null,
    prevDegraded: ReadonlySet<string> | null,
    degradedNow: ReadonlySet<string>,
    state: StateResponse,
  ): Promise<Set<string>> {
    const recoveredIntoTasks = new Set<string>();
    // Rising: newly degraded (first sight included — baseline passes null prev).
    for (const taskId of degradedNow) {
      if (this.degradedAlerted.has(taskId)) continue;
      this.degradedAlerted.add(taskId);
      await this.sendAll({
        title: `TUT ${taskId}: storage degraded`,
        body:
          `task ${taskId} failed to fold in /state — storage corruption (meta.json or record files). ` +
          `Repair only through the supported entries: corrupt meta.json → tut repair-meta ${taskId} (rebuilds operation state, records untouched); ` +
          `corrupt record → fetch the original bytes from an external snapshot and register via tut recover-record ${taskId} ` +
          `(the corrupt original stays on disk byte-for-byte). decide close is unavailable until the storage chain parses again. ` +
          `Never delete records (AGENTS.md invariant). Class-level diagnosis: tut doctor.`,
        task_id: taskId,
      });
    }
    // Falling: left degraded. Back in tasks[] = repaired — log line only.
    for (const taskId of [...this.degradedAlerted]) {
      if (degradedNow.has(taskId)) continue;
      this.degradedAlerted.delete(taskId);
      if (state.tasks.some((t) => t.task_id === taskId)) {
        this.log(`[${taskId}] left degraded — storage repaired; back in tasks[]`);
        recoveredIntoTasks.add(taskId);
      }
      // else: it vanished while degraded — the disappearance edge below reports it.
    }
    // Disappearance: known before (tasks or degraded), absent from both now.
    const knownNow = new Set<string>([...state.tasks.map((t) => t.task_id), ...degradedNow]);
    const knownBefore = new Set<string>([
      ...(prevTasks?.keys() ?? []),
      ...(prevDegraded ?? []),
    ]);
    // Anything present again clears its vanish bookkeeping FIRST — a restored
    // directory re-arms the alert for a future disappearance.
    for (const taskId of knownNow) {
      if (this.vanishedAlerted.delete(taskId)) {
        this.log(`[${taskId}] reappeared in /state (directory restored)`);
        if (state.tasks.some((t) => t.task_id === taskId)) recoveredIntoTasks.add(taskId);
      }
    }
    for (const taskId of knownBefore) {
      if (knownNow.has(taskId)) continue;
      if (this.vanishedAlerted.has(taskId)) continue;
      this.vanishedAlerted.add(taskId);
      await this.sendAll({
        title: `TUT ${taskId}: task directory vanished`,
        body:
          `task ${taskId} was in the previous /state snapshot but is absent from both tasks and degraded now — ` +
          `its directory disappeared (storage has no index; likely deleted or moved). ` +
          `decide close does not apply — there is no log left to append to. Restore the directory from backup/git; ` +
          `after restore it reappears in tasks[] (corrupt files inside → the storage-degraded path).`,
        task_id: taskId,
      });
    }
    return recoveredIntoTasks;
  }

  private async diffTask(
    before: StateTask | undefined,
    after: StateTask,
    flowMode: string,
    auto: StateAuto | undefined,
    notify: unknown,
  ): Promise<void> {
    // Close-edge pane cleanup (system-design 4.4): `tut decide close`
    // keeps its synchronous cleanup child, but the decision may land through
    // ANY entrance (4.1: decide is callable from any MCP client) — this
    // consumer-side edge covers them all. Transition-edge ONLY: `before` must
    // exist and not be closed; a task already closed at baseline / first
    // sight must NOT fire, or every restart would spawn one launcher child
    // per historical closed task. Closed is absorbing (3.2), so the edge
    // fires at most once per task per notifier run. Placed above the
    // notification branches: the close itself stays notification-silent (the
    // waiting_for → "none" early return below), and a rising needs_attention
    // must not swallow the reap either.
    if (before !== undefined && before.status !== "closed" && after.status === "closed") {
      this.cleanupClosedTask(after.task_id);
    }
    const pendingApprovalEntering = this.updatePendingApprovalEdge(after);
    // A task absent from the previous snapshot counts as waiting_for "none"
    // before, so brand-new tasks notify (absent → agent:* is a change) but a
    // snapshot-miss with waiting_for "none" stays silent.
    const beforeWf = before?.waiting_for ?? "none";
    const wfChanged = beforeWf !== after.waiting_for;
    const attentionRising = after.needs_attention && before?.needs_attention !== true;
    // Reuse the existing edge bookkeeping. Detach I/O just like cleanup:
    // failure is logged once and never retried by subsequent quiet polls.
    if (pendingApprovalEntering) this.reportHostStatus(after, "pending_approval", notify);
    if (attentionRising) this.reportHostStatus(after, "needs_attention", notify);

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
      // Anomaly notification; suppresses the same-tick FLOW notification
      // (the waiting_for edge below) but never the approval edge: a
      // task entering pending_approval with needs_attention set in the same
      // poll gets BOTH — the human must still receive the decide guidance,
      // or the approval chain is lost until a restart. Never contains
      // warnings content — /state has none; the human runs `tut read` for
      // the cause.
      await this.sendAll({
        title: `TUT ${after.task_id}: needs attention`,
        body: `${after.title} — status: ${after.status}: run \`tut read ${after.task_id}\` for warnings`,
        task_id: after.task_id,
      });
      if (pendingApprovalEntering) {
        await this.notifyPendingApproval(after, flowMode);
      }
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

  private reportHostStatus(task: StateTask, status: HostStatusReport["status"], notify: unknown): void {
    const report = { task_id: task.task_id, status, waiting_for: task.waiting_for };
    void Promise.resolve().then(() => this.deps.relayHostStatus!(report, notify)).catch((e: unknown) => {
      this.log(`[${task.task_id}] host status relay failed: ${(e as Error).message}`);
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
  private cleanupClosedTask(taskId: string): void {
    void this.deps.cleanupPanes(taskId).then(
      () => {
        this.log(`[${taskId}] closed — pane cleanup done (launch --cleanup)`);
      },
      (e: unknown) => {
        this.log(`[${taskId}] pane cleanup after close failed: ${(e as Error).message} — panes may remain; rerun: tut launch --cleanup ${taskId}`);
      },
    );
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
  private async logAutoDecisions(
    prev: ReadonlyMap<string, StateTask> | null,
    state: StateResponse,
    recoveredIntoTasks?: ReadonlySet<string>,
  ): Promise<void> {
    for (const task of state.tasks) {
      if (!task.waiting_for.startsWith("agent:")) continue;
      const role = task.waiting_for.slice("agent:".length);
      const gate = this.autoGateReason(task);
      const whitelisted = autoWhitelisted(state.auto, role);
      let dedup = gate !== null ? "n/a (gate withheld)" : "n/a (not whitelisted)";
      if (gate === null && whitelisted) {
        try {
          const records = await this.fullLog(task.task_id, task);
          const blocked = launchBlocked(records, role);
          dedup = blocked.blocked ? `launched@v${blocked.noteVersion}` : "fresh";
        } catch (e) {
          dedup = `unreadable (${(e as Error).message})`;
        }
      }
      // Recovery tick: the first tasks[] sight after a
      // degraded / vanished stay suppresses flow edges below — the decision
      // line must say so instead of announcing a launch that will not happen.
      const recoveryEdge = recoveredIntoTasks?.has(task.task_id) === true;
      let action: string;
      if (recoveryEdge) {
        action = "none (recovery edge — first tasks[] sight after degraded/vanished; flow edges suppressed this poll)";
      } else if (gate !== null) {
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
        // Edge-on-this-poll leftover: with an edge on THIS poll the
        // action is not "none" — autoLaunch re-reads the log inside its own
        // dedup stage and acts on that read, not on this poll's failed one.
        const edge = prev !== null
          && (prev.get(task.task_id)?.waiting_for ?? "none") !== task.waiting_for;
        action = edge
          ? `launch attempt this poll (dedup re-read inside autoLaunch; poll read ${dedup})`
          : `none this poll; an edge would re-read the log (dedup ${dedup})`;
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
      records = await this.fullLog(task.task_id, task);
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
      // Deliberately NO /state entry here: the poll's entry is
      // stale by construction — the winner's marker landed after fetchState —
      // so a coverage skip must not fire; the entry-less pull is always
      // incremental since cached.version + 1 and therefore sees the marker.
      try {
        const after = await this.fullLog(task.task_id);
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
    // Post-marker stage: the launcher child runs OUTSIDE the
    // drain queue.  Everything above (gate → dedup → marker) stays queued —
    // a follow-up compare always observes the marker — but the child itself
    // is handed off below, so a wedged or slow launcher can no longer freeze
    // every other task's compares and notifications; a hung launch drags at
    // most its own task, and the child liveness backstop (runNodeCommand)
    // eventually settles it into the failure path.
    this.spawnTrackedLaunch(task, role, agent, args, invocation, launchVersion);
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
        this.log(`tut launch (${task.task_id}, ${role})${line ? ` → ${line}` : ""}`);
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
        `[${task.task_id}] launch attempt completed; delivery confirmation is not implied for ${role}; waiting for working signal within ${Math.ceil(this.workingTimeoutMs / 1000)}s`,
      );
      await this.sendAll({
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
      body: `${task.title} — tut launch ${role} failed: ${message}; intervene manually`,
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

  private async launchGenerationSuperseded(
    taskId: string,
    launchVersion: number,
    entry?: StateTask,
  ): Promise<boolean | undefined> {
    try {
      const records = await this.fullLog(taskId, entry);
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
      const superseded = await this.launchGenerationSuperseded(watch.task.task_id, launchVersion, current);
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
    const label = unscopedLabel(pane.trim(), this.rigRoot) ?? pane.trim();
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
    const task = this.snapshot?.get(taskId);
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
    const task = this.snapshot?.get(taskId);
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
        this.markProgress(taskId, this.deps.now());
        if (taskId !== evt.pane) {
          this.log(`working event pane '${evt.pane}' resolved to task ${taskId} (role-pane mapping)`);
        }
        this.earlyWorkingSignals.set(inFlight.key, evt);
        this.log(`[${taskId}] working signal arrived while ${inFlight.launch.role} launch was still completing`);
      } else if (this.workingEventMatchesCurrentTask(evt, taskId)) {
        // Stall-clock policy: an UNWATCHED working event no longer
        // refreshes the stall watchdog — the realistic failure was herdr
        // status flapping (working↔blocked oscillation with no hub progress)
        // renewing the clock forever.  Only real progress renews: the first
        // working after a launch (the watch-hit path above, or the in-flight
        // path) and any updated_at/version advance (checkStalls).
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
    const evidence = parseDeliveryV2(evt.delivery_v2);
    if (this.remediationMode === "enter-repress" && evidence && paneRole) {
      const task = this.snapshot?.get(taskId);
      const eligible = (current: StateTask | undefined) => !!task && !!current &&
        current.status === task.status && current.waiting_for === `agent:${paneRole}` && !current.needs_attention &&
        (paneRole === 'architect' ? current.status === 'designing' :
          paneRole === 'reviewer' ? current.status === 'reviewing' : ['implementing', 'revising'].includes(current.status));
      let stopped = false;
      const canAct = async () => {
        if (stopped || this.closed || this.remediationMode !== 'enter-repress' || !eligible(this.snapshot?.get(taskId))) {
          stopped = true;
          return false;
        }
        try {
          // Read through HTTP without running another compare/launch cycle.
          // Notes may advance version while the same role round remains active.
          const latest = await this.deps.fetchState(this.stateUrl);
          const enabled = (latest.auto?.remediate ?? (latest.flow_mode === 'auto' ? 'enter-repress' : 'off')) === 'enter-repress';
          stopped = this.closed || this.remediationMode !== 'enter-repress' || !enabled || (latest.degraded ?? []).includes(taskId) ||
            !eligible(latest.tasks.find(t => t.task_id === taskId)) || !eligible(this.snapshot?.get(taskId));
        } catch { stopped = true; }
        return !stopped;
      };
      if (await canAct()) {
        const claim = this.remediationAttempts.claim(evidence.attempt_id);
        if (claim === 'duplicate') return;
        if (claim === 'full') {
          this.log(`[${taskId}] remediation attempt capacity reached; escalating manually without another key`);
        } else try {
          const sink = this.remediationAudit(taskId, paneRole);
          const recordAction = async (remediation: import('../remediator.js').RemediationEvidence) => {
            sink.emit(`remediation pane=${evidence.pane_id} delivery_v2=${JSON.stringify({ ...evidence, remediation })}`);
            await sink.flush();
          };
          const remediation = await this.remediator.remediate({ agent: evt.agent, pane: evt.pane, evidence, canAct, recordAction });
          sink.emit(`remediation pane=${evidence.pane_id} delivery_v2=${JSON.stringify({ ...evidence, remediation })}`);
          await sink.flush();
          if (remediation.result === "working-observed") {
            await this.handleWorkingSignal(evt, taskId);
            await this.sendAll({ title: `TUT ${taskId}: machine remediation`,
              body: `${taskId} — 机器补救：机器代按 Enter 后观察到 working（${remediation.strategy}）；非输入消费证明`, task_id: taskId });
            return;
          }
          if (remediation.action === "machine-enter") this.log(`[${taskId}] 二次 give-up：机器代按 Enter 后未确认翻转，升级人工，不再补按`);
        } catch (error) {
          this.log(`[${taskId}] remediation failed; escalating manually: ${(error as Error).message}`);
        }
      }
    }
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
    if (/\.(architect|executor|reviewer)-[a-f0-9]{8}$/.test(evt.pane.trim()) && unscopedLabel(evt.pane.trim(), this.rigRoot) === undefined) return;
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
        // No stall refresh: a blocked event is not progress — this
        // stuck alert is the timely signal, and the stall watchdog stays the
        // stallMs backstop instead of being renewed by status flapping.
        // blocked is an追加触发 immediate compare (system-design 6.1):
        // the stuck agent may have just published; a compare picks it up now.
        // The UNMATCHED degradation (log + notify) is rate-limited
        // per source — the immediate compare above is never suppressed.
        if (taskId !== null) {
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
      // Spent handles must not linger: this was the one timer that
      // never removed itself from `timers` — every done-without-publish
      // recheck leaked a handle for the process lifetime.
      this.timers.delete(timer);
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
    const scoped = panes.filter((p) => (unscopedLabel(p.label, this.rigRoot) ?? "").startsWith(`${taskId}.`));
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
      res.end(JSON.stringify({ error: "method not allowed: use POST /agent-event", hub_root: canonicalRoot(this.rigRoot), hub_url: this.stateUrl.replace(/\/state$/, "") }));
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
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "invalid event shape" });
      return;
    }
    const evt = parsed as {
      event?: unknown;
      agent?: unknown;
      pane?: unknown;
      delivery_v2?: unknown;
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
    // Preserve well-typed legacy diagnostics without using them as guidance.
    const box = evt.box;
    const transport = evt.transport;
    const atomic = (box === "held" || box === "cleared" || box === "unknown") && typeof transport === "boolean";
    const probe =
      evt.probe === "observed" ||
      evt.probe === "failed" ||
      evt.probe === "unavailable" ||
      evt.probe === "not-attempted"
        ? evt.probe
        : undefined;
    const deliveryV2 = parseDeliveryV2(evt.delivery_v2);
    this.receiveEvent({
      ...(deliveryV2 === undefined ? {} : { delivery_v2: deliveryV2 }),
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
    this.closed = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.workingWatches.clear();
    this.inFlightLaunches.clear();
    this.launchChains.clear();
    this.earlyWorkingSignals.clear();
    this.earlyGiveUps.clear();
    this.unresolvedWorkingEvents.clear();
    this.pendingApprovalTasks.clear();
    this.degradedAlerted.clear();
    this.vanishedAlerted.clear();
    this.sweepBarriers.clear();
    this.unmatchedSources.clear();
    this.logCache.clear();
    const session = this.hubSession;
    this.hubSession = null;
    if (session !== null) await session.close().catch(() => undefined);
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

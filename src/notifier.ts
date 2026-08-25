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
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createChannels, type Channel, type Notification } from "./channels.js";
import {
  launchBlocked,
  latestRecordVersion,
  markLaunched as appendLaunchMarker,
  readLaunchLog,
  resolveLaunchTarget,
  type LaunchVia,
} from "./launch.js";
import { commandHead, commandArgs } from "./agent-command.js";
import type { AgentRoute, Cast, ContextRecord } from "./types.js";
import { KNOWN_ROLES, resolveAgentRoute } from "./workspace.js";

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
  event: "working" | "blocked" | "done";
  agent: string;
  pane: string;
}

/** A pane-list row consumed by the done-event sweep (system-design 4.4). */
export interface PaneSnapshot {
  pane_id: string;
  label: string;
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

export interface NotifierDeps {
  fetchState(url: string): Promise<StateResponse>;
  /** Launch with the same executable + ordered argv tail used by start-next. */
  launch(taskId: string, role: string, agent: string, args?: string[]): Promise<string>;
  /** Full task log used by auto launch de-duplication; injectable for tests. */
  readLog(taskId: string): Promise<ContextRecord[]>;
  /** Append the optimistic launch marker before calling launch.sh. */
  markLaunched(taskId: string, role: string, baseVersion: number, via: LaunchVia): Promise<unknown>;
  channelsFor(notifyCfg: unknown): Channel[];
  now(): number;
  log(line: string): void;
  /**
   * Pre-check for the auto door: resolve the launch target (cast →
   * workspace → routes) and verify the agent is on PATH. Runs BEFORE the
   * launch marker — a failure must leave no trace. Injectable for tests.
   */
  resolveTarget?(taskId: string, role: string): Promise<AgentRoute>;
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

/** Plain-name CLI presence check via `which` — never runs the agent itself. */
function commandOnPath(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [name], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/** Auto-door pre-check: resolve the routed agent, require it on PATH. */
async function defaultResolveTarget(url: string, taskId: string, role: string): Promise<AgentRoute> {
  const target = await resolveLaunchTarget(url, taskId, role);
  if (!(await commandOnPath(target.agent))) {
    throw new Error(`routed agent '${target.agent}' is not on PATH`);
  }
  return target.args !== undefined ? { agent: target.agent, args: [...target.args] } : target.agent;
}

/**
 * Runs scripts/launch.sh <task_id> <role>. The environment is passed through
 * unchanged so TUT_DRY_RUN=1 makes launch.sh print the command instead of
 * calling Herdr (the script tests use exactly this).
 * Resolves with captured stdout (the DRY-RUN line / launcher output).
 *
 * Path note: one directory up from this module (../scripts/launch.sh —
 * module-relative, resolving inside the repo from both src/ and dist/).
 */
const LAUNCH_SCRIPT_URL = new URL("../scripts/launch.sh", import.meta.url);

/** Runs scripts/launch.sh <task_id> <role> <agent...>. The environment
 *  defaults to this process's (passed through unchanged so TUT_DRY_RUN=1
 *  makes launch.sh print the command instead of running it); injectable for
 *  tests. The child's stderr is TEED live to this process's stderr (the
 *  notify pane — 8.2: stdout/stderr is the log): launch.sh's delivery
 *  diagnostics (`tut-delivery t=<ms> …`) must survive a SUCCESSFUL launch
 *  too, or the next swallowed-Enter incident leaves no timeline. On
 *  failure the reject message still carries the tail (duplicated in the
 *  pane on that rare path — loud is fine). */
export async function spawnLaunch(
  taskId: string,
  role: string,
  agent: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const script = fileURLToPath(LAUNCH_SCRIPT_URL);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(script, [taskId, role, agent, ...args], {
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const tail = stderr.trim();
        reject(new Error(`launch.sh ${taskId} ${role} exited ${code ?? `signal ${signal}`}${tail ? `: ${tail}` : ""}`));
      }
    });
  });
}

function defaultLog(line: string): void {
  process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
}

function versionOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
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

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code ?? `signal ${signal}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function parsePaneSnapshots(raw: string): PaneSnapshot[] {
  try {
    const out = JSON.parse(raw) as { result?: { panes?: unknown }; panes?: unknown };
    const panes = (out?.result?.panes ?? out?.panes) as Array<{ pane_id?: unknown; label?: unknown }> | undefined;
    if (!Array.isArray(panes)) return [];
    return panes
      .filter((p) => typeof p?.pane_id === "string")
      .map((p) => ({ pane_id: p.pane_id as string, label: typeof p.label === "string" ? p.label : "" }));
  } catch {
    return [];
  }
}

async function defaultListPanes(): Promise<PaneSnapshot[]> {
  return parsePaneSnapshots(await runCapture("herdr", ["pane", "list"]));
}

async function defaultReadPane(paneId: string): Promise<string> {
  return await runCapture("herdr", ["pane", "read", paneId, "--source", "visible", "--lines", String(SWEEP_READ_LINES)]);
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
  private channels: Channel[] = createChannels(undefined);
  private consecutiveFailures = 0;
  /** Routing maps for the event reverse lookup; null until first load. */
  private routing: RoutingMaps | null = null;

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
  private readonly paneLister: () => Promise<PaneSnapshot[]>;
  private readonly paneReader: (paneId: string) => Promise<string>;

  constructor(options: NotifyOptions, deps: Partial<NotifierDeps> = {}) {
    this.stateUrl = stateUrlOf(options.url);
    this.intervalMs = Math.max(1, options.interval) * 1000;
    this.stallMs = Math.max(0, options.stallTimeoutMin) * 60_000;
    const workingTimeoutSec = options.workingTimeoutSec ?? options.launchWorkingTimeoutSec ?? 300;
    this.workingTimeoutMs = Math.max(0, Number.isFinite(workingTimeoutSec) ? workingTimeoutSec : 300) * 1000;
    this.eventPort = options.eventPort;
    this.routingLoader = deps.loadRouting ?? defaultLoadRouting;
    this.targetResolver = deps.resolveTarget ?? ((taskId, role) => defaultResolveTarget(options.url, taskId, role));
    this.paneLister = deps.listPanes ?? defaultListPanes;
    this.paneReader = deps.readPane ?? defaultReadPane;
    this.deps = {
      fetchState: deps.fetchState ?? defaultFetchState,
      launch: deps.launch ?? spawnLaunch,
      readLog: deps.readLog ?? ((taskId) => readLaunchLog(options.url, taskId)),
      markLaunched: deps.markLaunched ?? ((taskId, role, baseVersion, via) => appendLaunchMarker(options.url, taskId, role, baseVersion, via)),
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
    await this.retireObsoleteWorkingWatches(this.snapshot);

    if (prev === null) {
      // First successful fetch: baseline, no notifications.
      for (const t of state.tasks) {
        this.lastUpdatedAt.set(t.task_id, t.updated_at);
        this.lastProgressAt.set(t.task_id, now);
      }
      this.log(`baseline: ${state.tasks.length} task(s), flow_mode=${state.flow_mode}`);
      return;
    }

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

  private async autoLaunch(task: StateTask, role: string): Promise<void> {
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

    const blocked = launchBlocked(records, role);
    if (blocked.blocked) {
      await this.autoLaunchSkipped(task, role, blocked.noteVersion);
      return;
    }

    // Pre-check BEFORE the marker (order: dedup → precheck → mark → launch,
    // same as tut start-next): resolve the routed agent (cast → workspace →
    // routes) and require it on PATH. A failure leaves no trace — the human's
    // start-next (or the next auto round) is not blocked.
    let route: AgentRoute;
    try {
      route = await this.targetResolver(task.task_id, role);
    } catch (e) {
      await this.autoLaunchFailed(task, role, new Error(`precheck failed: ${(e as Error).message}`));
      return;
    }
    const agent = commandHead(route);
    const args = commandArgs(route);

    // Done-sweep barrier (2/3, post-precheck): a done event may have landed
    // while readLog/precheck were in flight — re-check before the marker.
    // From the resolution of this await to the markLaunched call the code is
    // one synchronous continuation (no macrotask boundary), so a later done
    // event can no longer slip between this check and the marker.
    await this.awaitSweepBarrier(task.task_id);
    const baseVersion = latestRecordVersion(records);
    let launchVersion: number | undefined;
    try {
      const marker = await this.deps.markLaunched(task.task_id, role, baseVersion, "auto");
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
      const out = args.length > 0
        ? await this.deps.launch(task.task_id, role, agent, args)
        : await this.deps.launch(task.task_id, role, agent);
      this.inFlightLaunches.delete(launchKey);
      // Dry-run output is often multi-line (provisioning preview + delivery
      // preview); log EVERY line so the pane log shows the full launch preview.
      for (const line of out.trim().split("\n")) {
        this.log(`launch.sh (${task.task_id}, ${role})${line ? ` → ${line}` : ""}`);
      }
      this.armWorkingWatch(task, role, agent, launchVersion);
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
        this.log(`working event pane '${evt.pane}' resolves to no task; stall refresh skipped`);
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
        const known = taskId !== null;
        if (known) this.markProgress(taskId, this.deps.now());
        else this.log(`blocked event pane '${evt.pane}' matches no task (4.4 convention broken)`);
        // blocked is an追加触发 immediate compare (system-design 6.1):
        // the stuck agent may have just published; a compare picks it up now.
        void this.requestCompare();
        void this.sendAll({
          title: `TUT ${known ? taskId : evt.pane}: agent stuck`,
          body: `Agent ${evt.agent} appears blocked in pane ${evt.pane}${known && taskId !== evt.pane ? ` (task ${taskId})` : ""}`,
          // task_id only when a task was really resolved — an unmatched pane
          // name is not a task id, and the body already carries it.
          ...(known ? { task_id: taskId } : {}),
        });
        return;
      }
      case "done":
        void this.handleDone(evt, taskId);
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
      this.log(`done event pane '${evt.pane}' matches no task (4.4 convention broken); degrading to compare`);
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
    const evt = parsed as { event?: unknown; agent?: unknown; pane?: unknown };
    if (typeof evt.event !== "string" || typeof evt.agent !== "string" || typeof evt.pane !== "string") {
      this.log("ignoring event with invalid shape (need string event/agent/pane)");
      sendJson(res, 400, { error: "invalid event shape" });
      return;
    }
    if (evt.event !== "working" && evt.event !== "blocked" && evt.event !== "done") {
      this.log(`ignoring unknown event: ${evt.event}`);
      sendJson(res, 200, { ok: true, ignored: true });
      return;
    }
    this.receiveEvent({ event: evt.event, agent: evt.agent, pane: evt.pane });
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
    this.unresolvedWorkingEvents.clear();
    this.sweepBarriers.clear();
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

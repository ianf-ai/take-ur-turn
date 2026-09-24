import { rigLabel } from "../hub/rig.js";
import { DEFAULT_NOTIFIER_EVENT_URL, resolveNotifierEventEndpoint, resolveRigRoot } from "../hub/rig-discovery.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBlocked, latestRecordVersion, markLaunched, readLaunchLog } from "../launcher/launch.js";
import { assertLaunchStateGate, bindLaunchBaseVersion, buildLaunchInvocation } from "../launcher/invocation.js";
import { AgentTargetError, UnsupportedWindowsShimError, resolvePlatformExecutionPlan } from "../launcher/target-resolver.js";
import { DEFAULT_CHILD_TIMEOUT_MS, cliEntryPath, runInternalLaunch, runInternalLaunchInvocation } from "../launcher/process.js";
import { parseLaunchEntry, runLaunchEntry } from "../launcher/entry.js";
import { requireBirthAnchor, resolveExecutionContext } from "../launcher/anchor.js";
import { KNOWN_ROLES, UNKNOWN_ROLE_AGENT, defaultUserConfigDir, readWorkspaceConfigSnapshot, resolveAgentRoute, resolveAgentRouteWithSource, resolveTabLabelTemplateFromSnapshot } from "../common/workspace.js";
import { formatAgentRoute } from "../common/agent-command.js";
import { hubCreate, hubDecide, hubList, hubPublish, hubRead, type HubListResult, type HubReadResult } from "../hub/hub-client.js";
import type { Cast, CheckoutRoute, LaunchRequest } from "../common/types.js";
import { worktreePathWarning } from "../common/checkout-warning.js";
import { DEFAULT_HUB_URL, cliFetchInit, printJson, sleepMs, clampPollInterval, ATTENTION_MARKER, colWidth, padRow, failWith, stateFetchErrorLine, formatCast } from "./shared.js";
import { type ParsedArgs } from "./args.js";

/** Shape of GET /state consumed by start-next/watch (six-field entries plus the additive version, see http.ts). */
interface StateSnapshot {
  tasks?: Array<{
    task_id: string;
    status?: string;
    waiting_for?: string;
    needs_attention?: boolean;
    version?: number;
    cast?: Cast;
    checkout?: CheckoutRoute;
  }>;
}

/** GET <hub>/state and status-check; throws on fetch/HTTP failure (callers own the message). */
async function fetchStateSnapshot(url: string): Promise<StateSnapshot> {
  const res = await fetch(new URL("/state", url), cliFetchInit({ headers: { Connection: "close" } }));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as StateSnapshot;
}

/**
 * No-arg default: from one /state snapshot, the tasks waiting for an agent
 * (waiting_for "agent:<role>"). An anomalous needs_attention combination is
 * still listed for truthful selection diagnostics, then withheld by the
 * canonical launch gate.
 */
function agentWaitingTasks(state: StateSnapshot): Array<NonNullable<StateSnapshot["tasks"]>[number]> {
  return (state.tasks ?? []).filter((t) => (t.waiting_for ?? "").startsWith("agent:"));
}

/**
 * Task selection shared by start-next and watch (watch's alignment
 * requirement): explicit task_id wins (must exist in /state); no-arg default
 * resolves the single task waiting for an agent (zero/multiple are
 * list-and-fail branch exits — never guess). Prints its own diagnostics;
 * `handled` is the process exit code.
 */
function selectTargetTask(
  state: StateSnapshot,
  explicitTaskId: string | undefined,
): { entry: NonNullable<StateSnapshot["tasks"]>[number] } | { handled: number } {
  const tasks = state.tasks ?? [];
  let taskId = explicitTaskId;
  if (taskId === undefined) {
    const candidates = agentWaitingTasks(state);
    if (candidates.length === 0) {
      process.stderr.write("tut: no task is waiting for an agent\n");
      const humanWaiting = tasks.filter((t) => t.waiting_for === "human");
      if (humanWaiting.length > 0) {
        const rows = humanWaiting.map((t) => [t.task_id, t.waiting_for ?? "human"]);
        const widths = [colWidth("task_id", rows, 0), colWidth("waiting_for", rows, 1)];
        process.stderr.write("tasks waiting for a human:\n");
        for (const row of rows) process.stderr.write(`  ${padRow(row, widths)}\n`);
      }
      return { handled: 1 };
    }
    if (candidates.length > 1) {
      // List, never guess. The `!!` column mirrors
      // tut status's attention notation.
      const rows = candidates.map((t) => [
        t.task_id,
        t.waiting_for ?? "",
        t.needs_attention === true ? ATTENTION_MARKER : "",
      ]);
      const widths = [colWidth("task_id", rows, 0), colWidth("waiting_for", rows, 1), colWidth("att", rows, 2)];
      process.stderr.write(`tut: ${candidates.length} tasks are waiting for an agent — pass a task_id explicitly:\n`);
      process.stderr.write(`${padRow(["task_id", "waiting_for", "att"], widths)}\n`);
      for (const row of rows) process.stderr.write(`${padRow(row, widths)}\n`);
      return { handled: 1 };
    }
    const selected = candidates[0];
    if (selected === undefined) return { handled: 1 }; // unreachable: length checked above
    taskId = selected.task_id;
  }
  const entry = tasks.find((t) => t.task_id === taskId);
  if (entry === undefined) {
    process.stderr.write(`tut: TASK_NOT_FOUND: no task ${taskId} in /state\n`);
    return { handled: 1 };
  }
  return { entry };
}

/** Prefer explicit producer configuration. Otherwise bind a manual launch to
 *  its verified workspace Notifier; on failure keep the legacy URL and say so. */
export async function ensureNotifierEventUrl(environment: NodeJS.ProcessEnv, hubUrl: string, hubRoot: string): Promise<void> {
  const explicit = environment.TUT_EVENT_PORT_URL;
  if (explicit !== undefined && explicit.length > 0) return;
  try {
    environment.TUT_EVENT_PORT_URL = await resolveNotifierEventEndpoint(hubUrl, hubRoot);
  } catch (error) {
    environment.TUT_EVENT_PORT_URL = DEFAULT_NOTIFIER_EVENT_URL;
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim() || "unknown discovery error";
    process.stderr.write(`tut: WARNING: notifier endpoint discovery failed; escalation will use ${DEFAULT_NOTIFIER_EVENT_URL}: ${reason}\n`);
  }
}

/** Internal launch command.  It is intentionally not part of the public
 * workflow parser: route tokens after task_id/role belong to the launcher. */
async function runLaunch(parsed: Extract<ParsedArgs, { command: "launch" }>): Promise<number> {
  const entry = parseLaunchEntry(parsed.args);
  if ("error" in entry) {
    process.stderr.write(`tut: launch: ${entry.error}\n`);
    return 1;
  }
  const previousEventUrl = process.env.TUT_EVENT_PORT_URL;
  try {
    if (entry.kind === "round") {
      const environment = { ...process.env };
      const hubUrl = entry.invocation?.hub_url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL;
      const hubRoot = entry.invocation?.context.hubRoot ?? resolveRigRoot();
      await ensureNotifierEventUrl(environment, hubUrl, hubRoot);
      process.env.TUT_EVENT_PORT_URL = environment.TUT_EVENT_PORT_URL;
    }
    return await runLaunchEntry(entry);
  } catch (e) {
    process.stderr.write(`tut: launch: ${(e as Error).message}\n`);
    return 1;
  } finally {
    if (previousEventUrl === undefined) delete process.env.TUT_EVENT_PORT_URL;
    else process.env.TUT_EVENT_PORT_URL = previousEventUrl;
  }
}

async function runStartNext(parsed: Extract<ParsedArgs, { command: "start-next" }>): Promise<number> {
  let state: StateSnapshot;
  try {
    state = await fetchStateSnapshot(parsed.url);
  } catch (e) {
    process.stderr.write(stateFetchErrorLine(parsed.url, e));
    return 1;
  }
  // No-arg default: resolve the task_id first (zero/multiple are branch
  // exits), then fall through — the explicit path below is the ONLY path
  // (guard via launch note, --force, spawn all unchanged for both ways in).
  const target = selectTargetTask(state, parsed.task_id);
  if ("handled" in target) return target.handled;
  const entry = target.entry;
  const taskId = entry.task_id;
  const waitingFor = entry.waiting_for ?? "none";
  const role = waitingFor.startsWith("agent:") ? waitingFor.slice("agent:".length) : "";
  if (role.length === 0) {
    process.stderr.write(
      `tut: task ${taskId} is waiting for "${waitingFor}" (status: ${entry.status ?? "?"}), not an agent — nothing to start\n`,
    );
    return 1;
  }

  const request: LaunchRequest = {
    kind: "round",
    task_id: taskId,
    role,
    fresh: parsed.fresh,
    via: "start-next",
  };
  try {
    assertLaunchStateGate(request, entry);
  } catch (e) {
    process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }

  let records;
  try {
    records = await readLaunchLog(parsed.url, taskId);
  } catch (e) {
    return failWith(e, parsed.url);
  }
  let baseVersion: number;
  try {
    baseVersion = bindLaunchBaseVersion(entry.version, latestRecordVersion(records));
  } catch (e) {
    process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }
  const blocked = launchBlocked(records, role);
  if (blocked.blocked && !parsed.force) {
    process.stderr.write(
      `tut: ALREADY_LAUNCHED: ${role} launched at v${blocked.noteVersion ?? "?"}, no new publish since; inspect this round and outstanding control calls before considering --force\n`,
    );
    return 1;
  }

  // Pre-checks, BEFORE the marker (failure leaves no trace — a plain retry
  // works, no --force): resolve one normalized route, build one immutable
  // invocation, then require its executable on PATH.  The child receives the
  // invocation as one JSON argv item; it is never asked to resolve the route
  // a second time.
  const launchEnvironment = { ...process.env };
  let invocation: ReturnType<typeof buildLaunchInvocation>;
  try {
    // Freeze the Herdr anchor and routing root before the marker.  The
    // internal child receives this snapshot and must not rediscover a
    // focused/different workspace during lifecycle execution.
    const executionContext = await resolveExecutionContext({
      caller_cwd: process.cwd(),
      env: launchEnvironment,
      dry_run: launchEnvironment.TUT_DRY_RUN === "1",
      ...(entry.checkout !== undefined ? { checkout: entry.checkout } : {}),
    });
    await ensureNotifierEventUrl(launchEnvironment, parsed.url, executionContext.hubRoot);
    const projectRoot = executionContext.routingRoot.startsWith("<")
      ? executionContext.caller_cwd ?? process.cwd()
      : executionContext.routingRoot;
    const workspaceSnapshot = await readWorkspaceConfigSnapshot({
      projectRoot,
      userConfigDir: defaultUserConfigDir(launchEnvironment),
      ...(executionContext.checkout.kind === "worktree" && !executionContext.hubRoot.startsWith("<")
        ? { fallbackProjectRoot: executionContext.hubRoot }
        : {}),
    });
    const resolved = await resolveAgentRouteWithSource(
      role,
      entry.cast,
      { workspaceSnapshot },
    );
    const route = typeof resolved.route === "string"
      ? { agent: resolved.route, args: [] }
      : { agent: resolved.route.agent, args: [...resolved.route.args] };
    // Target resolution happens after route selection and before the marker:
    // POSIX proves PATH presence (which + executable regular file), Windows
    // resolves its structured target and refuses shims.  Any failure leaves
    // no trace — a plain retry works, no --force needed.
    let plan: Awaited<ReturnType<typeof resolvePlatformExecutionPlan>>;
    try {
      plan = await resolvePlatformExecutionPlan(route, { environment: launchEnvironment });
    } catch (e) {
      if (e instanceof UnsupportedWindowsShimError || e instanceof AgentTargetError) {
        throw new Error(
          e instanceof UnsupportedWindowsShimError
            ? (e as Error).message
            : `agent '${route.agent}' (routed for ${role} on ${taskId}) is not on PATH — ${(e as Error).message}`,
        );
      }
      throw e;
    }
    const template = resolveTabLabelTemplateFromSnapshot(workspaceSnapshot);
    const tabLabel = template
      .replaceAll("{role}", role)
      .replaceAll("{task}", taskId)
      .replaceAll("{agent}", route.agent);
    if (tabLabel.length === 0 || /[\u0000\r\n]/u.test(tabLabel)) {
      throw new Error("naming.tab_label renders to an invalid label");
    }
    const skillPath = fileURLToPath(new URL(`../../skills/${role}.md`, import.meta.url));
    invocation = buildLaunchInvocation({
      request,
      base_version: baseVersion,
      hub_url: parsed.url,
      route,
      route_source: resolved.source,
      context: executionContext,
      naming: { tab_label: tabLabel, pane_label: rigLabel(`${taskId}.${role}`, executionContext.hubRoot) },
      prompt: `轮到你了（role: ${role}）：请用 Context Hub 读取任务 ${taskId} 的完整上下文（context.read），按你的 role skill（${skillPath}）开始本轮工作，完成后发布相应记录（context.publish）。`,
      ...(plan.platform === "posix"
        ? { posix_direct: plan.posix_direct }
        : { resolved_target: plan.resolved_target, effective_agent: plan.effective_agent }),
    });
  } catch (e) {
    process.stderr.write(`tut: cannot resolve launch target for ${role} on ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }

  if (launchEnvironment.TUT_DRY_RUN !== "1") {
    try {
      requireBirthAnchor(invocation.context);
    } catch (e) {
      process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
      return 1;
    }
  }

  // Fail closed: the marker must win the optimistic-concurrency race before
  // the launcher is called. A VERSION_CONFLICT therefore cannot cause a
  // second pane prompt.
  try {
    await markLaunched(parsed.url, taskId, role, baseVersion, "start-next", invocation.marker_projection);
  } catch (e) {
    return failWith(e, parsed.url);
  }

  // --fresh is already frozen in the invocation.  The child receives no raw
  // route values, so there is no second parse or route-source drift. Carry
  // the same environment snapshot across the manual boundary as well: a
  // moved TUT_EVENT_PORT_URL must reach delivery give-up escalation.
  const run = await runInternalLaunchInvocation(invocation, { env: launchEnvironment });
  if (run.error !== undefined) {
    process.stderr.write(`tut: cannot run internal launcher ${cliEntryPath()}: ${run.error.message}\n`);
    process.stderr.write("tut: inspect the target pane, this round, and outstanding control calls before any manual retry\n");
    return 1;
  }
  if (run.stdout.length > 0) process.stdout.write(run.stdout.endsWith("\n") ? run.stdout : `${run.stdout}\n`);
  if (run.stderr.length > 0) process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);
  if (run.code !== 0) {
    process.stderr.write(`tut: launcher exited with code ${run.code}\n`);
    process.stderr.write("tut: inspect the target pane, this round, and outstanding control calls before any manual retry\n");
    return 1;
  }
  process.stdout.write(`start-next: launch attempt completed; delivery confirmation is not implied (${role} for ${taskId} via tut launch)\n`);
  return 0;
}

// --- tut watch -------------------------------------------------------------------

/** Watch exit codes: three distinguishable situations + the shared operational-error code. */
const WATCH_EXIT_ROUND = 0;
const WATCH_EXIT_ERROR = 1;
const WATCH_EXIT_TERMINAL = 2;
const WATCH_EXIT_ATTENTION = 3;

type WatchOutcome = "round" | "terminal" | "attention";

/** terminal outranks attention: a closed task carrying leftover warnings is still over. */
function classifyWatch(entry: NonNullable<StateSnapshot["tasks"]>[number]): WatchOutcome {
  if (entry.status === "approved" || entry.status === "closed") return "terminal";
  if (entry.needs_attention === true) return "attention";
  return "round";
}

/** Any derived-field move counts as a change; version bumps on every append, so it is the primary signal. */
function watchChanged(
  before: NonNullable<StateSnapshot["tasks"]>[number],
  after: NonNullable<StateSnapshot["tasks"]>[number],
): boolean {
  return (
    before.version !== after.version ||
    before.status !== after.status ||
    before.waiting_for !== after.waiting_for ||
    before.needs_attention !== after.needs_attention
  );
}

/**
 * tut watch [<task_id>] — the official round-watcher: polls /state until the
 * task's derived state moves, then exits 0 (round boundary — someone's turn,
 * the pending_approval human gate included), 2 (terminal approved/closed) or
 * 3 (needs attention). Replaces the hand-written `while sleep` loops (whose
 * pattern mistakes once misreported state): a transient fetch failure is
 * retried (one throttled stderr line per outage), never mistaken for a state
 * change, and the baseline snapshot is classified immediately — a task
 * already terminal or flagged needs no waiting and exits at once.
 */
async function runWatch(parsed: Extract<ParsedArgs, { command: "watch" }>): Promise<number> {
  const intervalSec = clampPollInterval("watch", parsed.interval);
  const intervalMs = intervalSec * 1000;
  let state: StateSnapshot;
  try {
    state = await fetchStateSnapshot(parsed.url);
  } catch (e) {
    process.stderr.write(stateFetchErrorLine(parsed.url, e));
    return WATCH_EXIT_ERROR;
  }
  const target = selectTargetTask(state, parsed.task_id);
  if ("handled" in target) return target.handled;
  type Task = NonNullable<StateSnapshot["tasks"]>[number];
  let entry: Task = target.entry;

  const report = (outcome: WatchOutcome): number => {
    const at = `v${entry.version ?? "?"}`;
    const status = entry.status ?? "?";
    if (outcome === "terminal") {
      process.stdout.write(`watch: ${entry.task_id} reached terminal state: ${status} (${at})\n`);
      return WATCH_EXIT_TERMINAL;
    }
    if (outcome === "attention") {
      process.stdout.write(`watch: ${entry.task_id} needs attention (status=${status}, ${at}) — inspect with: tut read ${entry.task_id}\n`);
      return WATCH_EXIT_ATTENTION;
    }
    process.stdout.write(
      `watch: ${entry.task_id} advanced to ${at} (status=${status}, waiting_for=${entry.waiting_for ?? "?"}) — round boundary\n`,
    );
    return WATCH_EXIT_ROUND;
  };

  // Baseline classification: an already-terminal or already-flagged task has
  // nothing to wait for — exit at once with the corresponding code.
  const baseline = classifyWatch(entry);
  if (baseline !== "round") return report(baseline);
  process.stderr.write(
    `watch: ${entry.task_id} v${entry.version ?? "?"} (status=${entry.status ?? "?"}, waiting_for=${entry.waiting_for ?? "?"}) — polling every ${intervalSec}s\n`,
  );

  let fetchOk = true;
  for (;;) {
    await sleepMs(intervalMs);
    let next: StateSnapshot;
    try {
      next = await fetchStateSnapshot(parsed.url);
      fetchOk = true;
    } catch (e) {
      // A dead hub reads as "keep waiting", never as a state change (the
      // classic hand-loop bug): one throttled warning per outage, then retry.
      if (fetchOk) {
        process.stderr.write(`watch: hub unreachable, retrying: ${(e as Error).message}\n`);
        fetchOk = false;
      }
      continue;
    }
    const fresh = (next.tasks ?? []).find((t) => t.task_id === entry.task_id);
    if (fresh === undefined) {
      // Records are append-only; a task cannot leave /state. Fatal, not retryable.
      process.stderr.write(`watch: task ${entry.task_id} disappeared from /state — aborting\n`);
      return WATCH_EXIT_ERROR;
    }
    if (!watchChanged(entry, fresh)) {
      entry = fresh; // re-baseline; updated_at churn alone is not a change signal
      continue;
    }
    entry = fresh;
    return report(classifyWatch(entry));
  }
}

async function runCreate(parsed: Extract<ParsedArgs, { command: "create" }>): Promise<number> {
  try {
    // Non-blocking typo mitigation: the route is frozen and never repaired,
    // so surface a missing worktree path right at create time (stderr keeps
    // stdout machine-parseable; the task is still created).
    const warning = worktreePathWarning(parsed.checkout);
    if (warning !== undefined) process.stderr.write(`${warning}\n`);
    // Same non-blocking discipline: a free-form creator role outside
    // the conventional set is almost certainly a typo, and everything
    // downstream of an unknown role is a silent fallback (workspace routing
    // resolves it to the UNKNOWN_ROLE_AGENT builtin; no skills/<role>.md
    // ships). Visible at create — the last cheap moment to catch it.
    if (!([...KNOWN_ROLES, "human"] as readonly string[]).includes(parsed.role)) {
      process.stderr.write(
        `warning: role '${parsed.role}' is outside the conventional set (${[...KNOWN_ROLES, "human"].join("|")}) — ` +
        `routing for unknown roles falls back to the '${UNKNOWN_ROLE_AGENT}' builtin and no skills/${parsed.role}.md ships; the task is still created\n`,
      );
    }
    printJson(
      await hubCreate(parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL, {
        title: parsed.title,
        description: parsed.description,
        creator: parsed.creator,
        role: parsed.role,
        ...(parsed.flow !== undefined ? { flow: parsed.flow } : {}),
        ...(parsed.cast !== undefined ? { cast: parsed.cast } : {}),
        ...(parsed.checkout !== undefined ? { checkout: parsed.checkout } : {}),
      }),
    );
    return 0;
  } catch (e) {
    return failWith(e, parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
  }
}

async function runPublish(parsed: Extract<ParsedArgs, { command: "publish" }>): Promise<number> {
  let body = parsed.body;
  if (body === undefined && parsed.payloadFile !== undefined) {
    // --payload-file: the WHOLE file is the body; --summary still names it.
    try {
      body = await readFile(parsed.payloadFile, "utf8");
    } catch (e) {
      process.stderr.write(`tut: cannot read --payload-file ${parsed.payloadFile}: ${(e as Error).message}\n`);
      return 1;
    }
  }
  try {
    const result = await hubPublish(parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL, {
      task_id: parsed.task_id,
      role: parsed.role,
      content_type: parsed.content_type,
      payload: {
        summary: parsed.summary,
        body: body ?? "",
        ...(parsed.verdict !== undefined ? { verdict: parsed.verdict } : {}),
        ...(parsed.commits !== undefined ? { commits: parsed.commits } : {}),
        ...(parsed.refVersion !== undefined ? { ref_version: parsed.refVersion } : {}),
      },
      ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.expectedVersion !== undefined ? { expected_version: parsed.expectedVersion } : {}),
    });
    printJson(result);
    return 0;
  } catch (e) {
    return failWith(e, parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
  }
}

/** Human rendering of context.read: header block + one row per record. */
function renderRead(result: HubReadResult): string {
  const rows = result.versions.map((r) => [
    String(r.version),
    r.content_type,
    r.role,
    String(r.payload?.summary ?? "").split("\n")[0] ?? "",
  ]);
  const widths = [
    colWidth("version", rows, 0),
    colWidth("type", rows, 1),
    colWidth("role", rows, 2),
  ];
  const lines = [
    `task:    ${result.task_id}`,
    `title:   ${result.title}`,
    // The requirement text from creation: one line, even when the
    // description itself is multi-line (--json shows it verbatim).
    ...(result.description !== undefined
      ? [`desc:    ${result.description.split("\n")[0] ?? ""}`]
      : []),
    ...(result.flow !== undefined
      ? [`flow:    ${result.flow}${result.cast !== undefined ? ` (cast: ${formatCast(result.cast)})` : ""}`]
      : []),
    ...(result.status !== undefined ? [`status:  ${result.status}`] : []),
    `records: ${result.versions.length}`,
    "",
    padRow(["version", "type", "role", "summary"], [...widths, 0]),
    ...rows.map((r) => padRow(r, widths)),
  ];
  return `${lines.join("\n")}\n`;
}

async function runRead(parsed: Extract<ParsedArgs, { command: "read" }>): Promise<number> {
  try {
    const result = await hubRead(parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL, parsed.task_id, parsed.sinceVersion);
    if (parsed.json) printJson(result);
    else process.stdout.write(renderRead(result));
    return 0;
  } catch (e) {
    return failWith(e, parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
  }
}

/** Human rendering of context.list: one row per task ("att" marks needs_attention). */
function renderList(result: HubListResult): string {
  if (result.tasks.length === 0) return "no tasks\n";
  const rows = result.tasks.map((t) => [
    t.task_id,
    t.scope === "project" ? "project" : (t.status ?? "-"),
    t.scope === "project" ? "-" : (t.waiting_for ?? "-"),
    t.scope === "project" ? "-" : (t.needs_attention === true ? "yes" : ""),
    t.title,
  ]);
  const widths = [
    colWidth("task_id", rows, 0),
    colWidth("status", rows, 1),
    colWidth("waiting_for", rows, 2),
    colWidth("att", rows, 3),
  ];
  const lines = [padRow(["task_id", "status", "waiting_for", "att", "title"], [...widths, 0]), ...rows.map((r) => padRow(r, widths))];
  return `${lines.join("\n")}\n`;
}

async function runList(parsed: Extract<ParsedArgs, { command: "list" }>): Promise<number> {
  try {
    const result = await hubList(parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL, parsed.status);
    if (parsed.json) printJson(result);
    else process.stdout.write(renderList(result));
    return 0;
  } catch (e) {
    return failWith(e, parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
  }
}

async function runDecide(parsed: Extract<ParsedArgs, { command: "decide" }>): Promise<number> {
  let result: unknown;
  try {
    result = await hubDecide(parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL, {
      task_id: parsed.task_id,
      decision: parsed.decision,
      by: parsed.by,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    });
  } catch (e) {
    return failWith(e, parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
  }
  printJson(result);
  // decide(close) hooks the fresh-session lifecycle: reap the task's round
  // panes (`<task_id>.*`) via the launcher —
  // the single place that knows herdr (system-design 4.4 / 7.2). Best-effort
  // by design: cleanup warnings surface on stderr but never fail the decide
  // itself — approval must not be blocked by the terminal container.
  if (parsed.decision === "close") {
    const run = await runInternalLaunch(["--cleanup", parsed.task_id]);
    if (run.error !== undefined) {
      process.stderr.write(`tut: cannot run internal launcher ${cliEntryPath()}: ${run.error.message} (pane cleanup skipped)\n`);
    } else if (run.timedOut === true) {
      process.stderr.write(
        `tut: launch --cleanup ${parsed.task_id} exceeded the child liveness budget (${DEFAULT_CHILD_TIMEOUT_MS}ms) and was killed (task is closed regardless)\n`,
      );
    } else if (run.code !== 0) {
      process.stderr.write(`tut: pane cleanup exited with code ${run.code} (task is closed regardless)\n`);
    }
    if (run.stdout.length > 0) process.stdout.write(run.stdout.endsWith("\n") ? run.stdout : `${run.stdout}\n`);
    if (run.stderr.length > 0) process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);
  }
  return 0;
}

/** Stable default body when tut ack carries no --note (always non-empty). */
const ACK_DEFAULT_NOTE =
  "Anomalies reviewed and handled; derived needs_attention clears on the next state pass.";

/** Summary of an ack note: the --note's first line kept short, or stable text. */
function ackSummary(note: string | undefined): string {
  const firstLine = note?.split("\n")[0] ?? "";
  if (firstLine.length === 0) return "ack: anomalies handled";
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 72)}…`;
}

/**
 * tut ack <task_id> [--note <text>] — human acknowledgement that a task's
 * anomalies have been handled. One hubPublish with fixed role/content_type
 * and payload { summary, body, ack: true }: the note is append-only like any
 * record, the derived reset happens in the state machine — the
 * CLI never reads /state first and never duplicates derivation logic, so
 * acking a clean task is a harmless idempotent note.
 */
async function runAck(parsed: Extract<ParsedArgs, { command: "ack" }>): Promise<number> {
  try {
    printJson(
      await hubPublish(parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL, {
        task_id: parsed.task_id,
        role: "human",
        content_type: "note",
        payload: { summary: ackSummary(parsed.note), body: parsed.note ?? ACK_DEFAULT_NOTE, ack: true },
      }),
    );
    return 0;
  } catch (e) {
    return failWith(e, parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
  }
}

/**
 * tut assign <role> <agent> — change which agent occupies a role seat,
 * writing the PROJECT-level .context-hub/workspace.json (cwd — the same
 * root the three-level chain reads as L1). Missing file → initialized from
 * the currently effective lineup (all three roles resolved through the
 * chain, cast-less) before the target role is rewritten; a corrupt file is
 * never clobbered (exit 1, nothing written). Read-modify-write of the
 * parsed object so $comment and unknown keys survive untouched. Write is
 * atomic (temp sibling + rename, store.ts's pattern).
 */
async function runAssign(parsed: Extract<ParsedArgs, { command: "assign" }>): Promise<number> {
  const root = process.cwd();
  const dir = path.join(root, ".context-hub");
  const file = path.join(dir, "workspace.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      process.stderr.write(`tut: assign: cannot read ${file}: ${err.message}; nothing written\n`);
      return 1;
    }
    // Missing file → seed all three roles from the currently effective
    // lineup (user level and built-ins — L1 is this very file), so the new
    // file captures the full roster, not just the edited seat.
    const seeded: Record<string, unknown> = {};
    for (const role of KNOWN_ROLES) {
      const route = await resolveAgentRoute(role);
      if (typeof route === "string") seeded[role] = { agent: route };
      else seeded[role] = { agent: route.agent, args: [...route.args] };
    }
    raw = { roles: seeded };
  }
  const roles = (raw as { roles?: unknown })?.roles;
  // An array IS typeof "object", so `{"roles": []}` used to slip
  // through this guard — the later property write landed on the array and
  // JSON.stringify silently dropped it (exit 0 with a success message,
  // nothing written). Arrays are rejected explicitly at every level.
  if (
    typeof raw !== "object" || raw === null || Array.isArray(raw) ||
    typeof roles !== "object" || roles === null || Array.isArray(roles)
  ) {
    process.stderr.write(`tut: assign: ${file} is malformed (expected an object with a "roles" object); nothing written\n`);
    return 1;
  }
  const entry = (roles as Record<string, unknown>)[parsed.role];
  if (Array.isArray(entry) || (entry !== undefined && entry !== null && typeof entry !== "object")) {
    process.stderr.write(`tut: assign: ${file}: roles.${parsed.role} is not an object; nothing written\n`);
    return 1;
  }
  const routeFields = typeof parsed.agent === "string"
    ? { agent: parsed.agent }
    : { agent: parsed.agent.agent, args: [...parsed.agent.args] };
  const next =
    entry === undefined || entry === null
      ? routeFields
      : (() => {
          const existing = entry as Record<string, unknown>;
          const { args: _staleArgs, ...withoutArgs } = existing;
          return { ...withoutArgs, ...routeFields };
        })();
  (roles as Record<string, unknown>)[parsed.role] = next;

  const temp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => undefined);
    process.stderr.write(`tut: assign: cannot write ${file}: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`assign: ${parsed.role} → ${formatAgentRoute(parsed.agent)} (${file})\n`);
  return 0;
}

export { runStartNext, runLaunch, runWatch, runCreate, runPublish, runRead, runList, runDecide, runAck, runAssign };

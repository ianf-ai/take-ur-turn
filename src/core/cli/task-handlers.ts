import { ensureNotifierEventUrl } from "../launcher/event-endpoint.js";
import { resolveRigRoot, resolveLegacyLaunchHubUrl } from "../../hub/rig-discovery.js";
import { readFile } from "node:fs/promises";
import { writeConfigRole, configPath } from "../common/config.js";
import { objectOf, parseConfigRoles } from "../common/config-intent.js";
import path from "node:path";
import { assertLaunchStateGate } from "../../protocol/launch-policy.js";
import { parseLaunchEntry } from "../launcher/entry-parse.js";
import { KNOWN_ROLES, UNKNOWN_ROLE_AGENT, readWorkspaceConfigSnapshot, resolveAgentRouteFromSnapshot } from "../common/workspace.js";
import { formatAgentRoute } from "../../protocol/agent-command.js";
import { hubCreate, hubDecide, hubList, hubPublish, hubRead, type HubListResult, type HubReadResult } from "../../hub/hub-client.js";
import type { Cast, CheckoutRoute, Flow, LaunchRequest } from "../../protocol/types.js";
import { worktreePathWarning } from "../../hub/checkout-warning.js";
import { DEFAULT_HUB_URL, cliFetchInit, printJson, sleepMs, clampPollInterval, ATTENTION_MARKER, colWidth, padRow, failWith, stateFetchErrorLine, formatCast } from "./shared.js";
import { type ParsedArgs } from "./args.js";
import type { TaskHostPort } from "./host-ports.js";

/** Shape of GET /state consumed by start-next/watch (six-field entries plus the additive version/flow, see http.ts). */
interface StateSnapshot {
  tasks?: Array<{
    task_id: string;
    status?: string;
    waiting_for?: string;
    needs_attention?: boolean;
    version?: number;
    title?: string;
    cast?: Cast;
    checkout?: CheckoutRoute;
    flow?: Flow;
  }>;
}

/** GET <hub>/state and status-check; throws on fetch/HTTP failure (callers own the message). */
async function fetchStateSnapshot(url: string, includeClosed = false): Promise<StateSnapshot> {
  const res = await fetch(new URL(includeClosed ? "/state?include=closed" : "/state", url), cliFetchInit({ headers: { Connection: "close" } }));
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

export { ensureNotifierEventUrl } from "../launcher/event-endpoint.js";

/** Internal launch command.  It is intentionally not part of the public
 * workflow parser: route tokens after task_id/role belong to the launcher. */
async function runLaunch(parsed: Extract<ParsedArgs, { command: "launch" }>, host: TaskHostPort): Promise<number> {
  const entry = parseLaunchEntry(parsed.args);
  if ("error" in entry) {
    process.stderr.write(`tut: launch: ${entry.error}\n`);
    return 1;
  }
  // Register this launch with its owning power service when a session
  // marker is inherited. The host records process identity for later
  // cleanup; registration is best-effort and a no-op without the marker.
  await host.registerLaunch(`launch:${entry.kind}`);
  const previousEventUrl = process.env.TUT_EVENT_PORT_URL;
  const previousHubUrl = process.env.TUT_HUB_URL;
  try {
    if (entry.kind === "round") {
      const environment = { ...process.env };
      const hubRoot = entry.invocation?.context.hubRoot ?? resolveRigRoot();
      const hubUrl = entry.invocation?.hub_url ?? await resolveLegacyLaunchHubUrl(process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL, hubRoot);
      process.env.TUT_HUB_URL = hubUrl;
      await ensureNotifierEventUrl(environment, hubUrl, hubRoot);
      process.env.TUT_EVENT_PORT_URL = environment.TUT_EVENT_PORT_URL;
    }
    return await host.launch(entry);
  } catch (e) {
    process.stderr.write(`tut: launch: ${(e as Error).message}\n`);
    return 1;
  } finally {
    if (previousHubUrl === undefined) delete process.env.TUT_HUB_URL;
    else process.env.TUT_HUB_URL = previousHubUrl;
    if (previousEventUrl === undefined) delete process.env.TUT_EVENT_PORT_URL;
    else process.env.TUT_EVENT_PORT_URL = previousEventUrl;
  }
}

async function runStartNext(parsed: Extract<ParsedArgs, { command: "start-next" }>, host: TaskHostPort): Promise<number> {
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

  return await host.startNext(parsed, entry, request);
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
    state = await fetchStateSnapshot(parsed.url, true);
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
      next = await fetchStateSnapshot(parsed.url, true);
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
    // Preserve the local path hint even when the Hub is unreachable.
    const checkoutWarning = worktreePathWarning(parsed.checkout);
    if (checkoutWarning) process.stderr.write(`${checkoutWarning}\n`);
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
    const result = await hubCreate(parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL, {
      title: parsed.title,
      description: parsed.description,
      creator: parsed.creator,
      role: parsed.role,
      ...(parsed.flow !== undefined ? { flow: parsed.flow } : {}),
      ...(parsed.cast !== undefined ? { cast: parsed.cast } : {}),
      ...(parsed.checkout !== undefined ? { checkout: parsed.checkout } : {}),
    });
    for (const warning of result.warning?.split("\n") ?? []) {
      if (warning !== checkoutWarning) process.stderr.write(`${warning}\n`);
    }
    printJson(result);
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
  // --exit-conditions-file: read + JSON.parse BEFORE the request. An
  // unreadable file or a JSON syntax error must fail locally — no publish
  // request, no version advance. A legal-JSON wrong SHAPE is not checked
  // here: it is submitted verbatim and diagnosed by the record lint.
  let exitConditions: unknown;
  if (parsed.exitConditionsFile !== undefined) {
    try {
      exitConditions = JSON.parse(await readFile(parsed.exitConditionsFile, "utf8")) as unknown;
    } catch (e) {
      process.stderr.write(`tut: cannot read or parse --exit-conditions-file ${parsed.exitConditionsFile}: ${(e as Error).message}\n`);
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
        // Field set ONLY when the flag was given — an absent flag must not
        // create the key (old-record replay shape stays byte-compatible);
        // JSON.parse never yields undefined for a legal document, so null and
        // every other raw value ride through as the explicit field value.
        ...(parsed.exitConditionsFile !== undefined ? { exit_conditions: exitConditions } : {}),
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

async function runDecide(parsed: Extract<ParsedArgs, { command: "decide" }>, host: TaskHostPort): Promise<number> {
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
  // After a successful close, ask the host to clean up task resources.
  // Cleanup warnings surface on stderr but never fail the decision itself.
  if (parsed.decision === "close") {
    await host.cleanupTask(parsed.task_id);
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

/** tut assign writes only config; legacy declarations are read under its mutex. */
async function runAssign(parsed: Extract<ParsedArgs, { command: "assign" }>): Promise<number> {
  const root = resolveRigRoot();
  const dir = path.join(root, ".context-hub");
  try {
    await writeConfigRole(dir, parsed.role, parsed.agent, async () => {
      let legacy: Record<string, unknown> = {};
      try {
        legacy = objectOf(JSON.parse(await readFile(path.join(dir, "workspace.json"), "utf8")), "workspace");
        parseConfigRoles(legacy.roles);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const roles = { ...((legacy.roles ?? {}) as Record<string, unknown>) };
      // Preserve the effective compatibility roster once, including argv and extensions.
      const snapshot = await readWorkspaceConfigSnapshot({ projectRoot: root });
      for (const role of KNOWN_ROLES) {
        const { route } = await resolveAgentRouteFromSnapshot(role, undefined, snapshot);
        const existing = Object.hasOwn(roles, role) ? objectOf(roles[role], `workspace.roles.${role}`) : {};
        roles[role] = { ...existing, ...(typeof route === "string" ? { agent: route } : route) };
      }
      return { ...legacy, roles };
    });
  } catch (error) {
    process.stderr.write(`tut: assign: ${(error as Error).message}; nothing written\n`);
    return 1;
  }
  process.stdout.write(`assign: ${parsed.role} → ${formatAgentRoute(parsed.agent)} (${configPath(dir)})\n`);
  return 0;
}

export { runStartNext, runLaunch, runWatch, runCreate, runPublish, runRead, runList, runDecide, runAck, runAssign };

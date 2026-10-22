/**
 * `tut down` — stop THIS rig's standalone services (power.mode=standalone).
 *
 * Reads .context-hub/power.json and stops in reverse start order
 * (notifier → usage watcher → hub). Signaling is IDENTITY-GATED and
 * GROUP-SCOPED:
 *   - a live pid is not ownership: before any signal to a live recorded
 *     leader, the process-start fingerprint (start_token) must prove the pid
 *     is still the same instance this file was written about — a recycled
 *     pid (another rig, a run, any user process) is never signaled;
 *   - a live group under a DEAD recorded leader is equally not ownership:
 *     attribution is impossible (dead pids have no derivable token, and a
 *     retired numeric pgid can be reused by any later process group) —
 *     refused visibly, never signaled;
 *   - liveness, grace, escalation, and completion all track the recorded
 *     PROCESS GROUP, so a verified leader that exits first never masks
 *     stubborn group members;
 *   - stopped_at is written only after every service is verified stopped
 *     (groups gone, endpoints no longer answering) — a failed down never
 *     records completion, and a retry re-verifies instead of trusting the
 *     marker or missing pids.
 *
 * Runs are NEVER terminated: every run is an independent detached process
 * group, so it survives the rig going down; down names the survivors in
 * its output instead of touching them (the documented run-survival
 * semantics). In herdr mode (the default) down refuses with a pointer to
 * the herdr shutdown path — never a silent no-op.
 */

import { readPowerModeForSwitch } from "../../core/common/config.js";
import { canonicalRoot, resolveRigRoot, probeHub, probeNotifier, notifierMatches } from "../../core/hub/rig-discovery.js";
import { RunReadStore, type RunEntry } from "../../core/hub/run-store.js";
import { powerStatePath, processAlive, groupAlive, processStartToken, readPowerState, writePowerState, readPowerMembers, prunePowerMembers, type ServiceFacts, type PowerState, type PowerMember } from "./standalone-up.js";
import path from "node:path";
import { sleepMs } from "../../core/cli/shared.js";

/** TUT_DOWN_GRACE_MS (read per call) bounds the SIGTERM grace window —
 *  test/ops knob, the same discipline as TUT_UP_HUB_WAIT_MS. */
function downGraceMs(): number {
  const parsed = Number(process.env.TUT_DOWN_GRACE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3_000;
}

/** SIGKILL re-check window after escalation (bounded, no knob: it only
 *  covers the kernel retiring an already-signaled group). */
const KILL_RECHECK_MS = 1_500;

type StopOutcome = "stopped" | "already-stopped" | "forced" | "failed" | "no-pid" | "stale-pid" | "unverified";

/**
 * Signal a recorded process GROUP. No positive-pid fallback: a failed group
 * signal means the group is gone (ESRCH — nothing to signal) or not ours to
 * signal (EPERM/other — a bare-pid kill could hit an unrelated process).
 */
function signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): "signaled" | "gone" | "error" {
  try {
    process.kill(-pgid, signal);
    return "signaled";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "error";
  }
}

async function groupGoneBy(pgid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if (!groupAlive(pgid)) return true;
    if (Date.now() >= deadline) return false;
    await sleepMs(100);
  }
}

/**
 * Positive attribution for a group whose recorded leader is DEAD: a live
 * registry member with matching pid, pgid, power session AND start token
 * proves the group still contains this rig's own tree (our processes never
 * join foreign sessions; foreign processes never carry the session marker
 * nor register). Unregistrable groups stay unattributed — refuse.
 */
async function attributeLeftoverGroup(storageDir: string, pgid: number, session: string | null | undefined): Promise<PowerMember | undefined> {
  if (session === undefined) return undefined;
  for (const member of await readPowerMembers(storageDir)) {
    if (member.pgid !== pgid || member.power_session !== session || member.start_token === null) continue;
    if (!processAlive(member.pid)) continue;
    if ((await processStartToken(member.pid)) === member.start_token) return member;
  }
  return undefined;
}

/** The shared group ladder: TERM → grace → KILL → verify. Completion tracks
 * the whole group, never just the leader. */
async function signalGroupLadder(name: string, pid: number, pgid: number): Promise<StopOutcome> {
  const term = signalGroup(pgid, "SIGTERM");
  if (term === "gone") return "already-stopped";
  if (term === "error") return "failed";
  const grace = downGraceMs();
  if (await groupGoneBy(pgid, grace)) {
    process.stdout.write(`down: ${name} stopped (pid ${pid}, group SIGTERM after <=${grace}ms)\n`);
    return "stopped";
  }
  if (signalGroup(pgid, "SIGKILL") === "gone" && !groupAlive(pgid)) {
    process.stdout.write(`down: ${name} force-killed (pid ${pid}, group SIGKILL after ${grace}ms grace)\n`);
    return "forced";
  }
  if (await groupGoneBy(pgid, KILL_RECHECK_MS)) {
    process.stdout.write(`down: ${name} force-killed (pid ${pid}, group SIGKILL after ${grace}ms grace)\n`);
    return "forced";
  }
  return "failed";
}

/**
 * One service, identity-gated and group-scoped:
 *
 *  group gone            → already-stopped (no signal, whatever holds the pid);
 *  leader DEAD, group alive → leftover-group handling: attribution via the
 *                          power member registry (a live, token-verified
 *                          member of THIS rig's session) enables controlled
 *                          cleanup through the same group ladder ;
 *                          without positive attribution the group is
 *                          UNATTRIBUTABLE — refuse, visibly, never signal
 *                         stale records, other rigs, runs);
 *  leader alive, token mismatch → stale-pid: the pid was RECYCLED — never
 *                          signal, the live thing is not ours;
 *  leader alive, no token/unverifiable → unverified: conservative refusal;
 *  leader alive, token match → ours — the group ladder; the group-scoped
 *                          wait covers a leader that exits first while
 *                          stubborn members hold the group.
 */
async function stopService(name: string, facts: ServiceFacts, storageDir: string): Promise<StopOutcome> {
  if (facts.pid === null) return "no-pid";
  const pgid = facts.pgid ?? facts.pid;
  if (!groupAlive(pgid)) return "already-stopped";
  if (!processAlive(facts.pid)) {
    const member = await attributeLeftoverGroup(storageDir, pgid, facts.power_session);
    if (member === undefined) {
      process.stderr.write(
        `tut: down: ${name} still has a live process group at pgid ${pgid} but its recorded leader (pid ${facts.pid}) is gone and no live member verifies against this rig's power registry — the group can no longer be attributed to this rig (a retired pgid can be reused by any later process group); NOT signaling. Inspect it by hand (ps -o pid,pgid,command -g ${pgid}) and stop it yourself if you confirm it is this rig's leftover (kill -TERM -${pgid})\n`,
      );
      return "unverified";
    }
    process.stdout.write(
      `down: ${name}'s leader (pid ${facts.pid}) is gone but member pid ${member.pid} (${member.kind}) verifies against this rig's power registry — cleaning up the leftover group (pgid ${pgid})\n`,
    );
    return signalGroupLadder(name, facts.pid, pgid);
  }
  const token = await processStartToken(facts.pid);
  if (facts.start_token === null || facts.start_token === undefined || token === null) {
    process.stderr.write(
      `tut: down: ${name} pid ${facts.pid} is alive but its identity cannot be verified (no start token on record${token === null ? " or unreadable on this platform" : ""}) — NOT signaling; verify by hand or rerun tut up to refresh facts\n`,
    );
    return "unverified";
  }
  if (token !== facts.start_token) {
    process.stderr.write(
      `tut: down: ${name} pid ${facts.pid} no longer matches the recorded process (pid was recycled; the live process is not this rig's ${name}) — NOT signaling; refresh facts with tut up or verify by hand\n`,
    );
    return "stale-pid";
  }
  // Leader verified ours: address the GROUP — liveness, grace, escalation,
  // and completion all track the whole group, never just the leader.
  return signalGroupLadder(name, facts.pid, pgid);
}

/** Runs that will outlive the rig — named, never killed (the documented
 *  run-survival semantics: each run is its own detached process group). */
function survivingRuns(runs: RunEntry[]): RunEntry[] {
  return runs.filter((run) => run.status === "running" && run.pid_alive === true);
}

/** The human-facing rig report for down. */
export interface DownReport {
  exitCode: number;
  services: { name: string; outcome: StopOutcome }[];
  survivors: { run_id: string; pid?: number; task_id?: string }[];
}

/** Outcome classes that make the stop INCOMPLETE (visible failure). */
function incomplete(outcome: StopOutcome): boolean {
  return outcome === "failed" || outcome === "stale-pid" || outcome === "unverified";
}

/** Endpoint-level proof that a recorded service is still serving THIS rig. */
async function endpointsStillServing(root: string, state: PowerState): Promise<string[]> {
  const serving: string[] = [];
  if ((await probeHub(state.hub.url))?.root === root) serving.push(`hub (${state.hub.url}/state)`);
  if (notifierMatches(await probeNotifier(`http://127.0.0.1:${state.notifier.event_port}/agent-event`), root, state.hub.url)) {
    serving.push(`notifier (event port ${state.notifier.event_port})`);
  }
  return serving;
}

/**
 * Verified stop: every recorded process group is gone AND neither endpoint
 * answers as this rig anymore. This — not a marker or a missing pid — is
 * what "already stopped" means on a retry.
 */
async function rigFullyStopped(root: string, state: PowerState): Promise<boolean> {
  if (state.hub.pid !== null && groupAlive(state.hub.pgid ?? state.hub.pid)) return false;
  if (state.notifier.pid !== null && groupAlive(state.notifier.pgid ?? state.notifier.pid)) return false;
  if (state.watcher != null && state.watcher.pid !== null && groupAlive(state.watcher.pgid ?? state.watcher.pid)) return false;
  return (await endpointsStillServing(root, state)).length === 0;
}

/** Core engine (no process exit): stop the recorded rig, report facts. */
export async function stopStandaloneRig(root: string, state: PowerState): Promise<DownReport> {
  const storageDir = path.join(root, ".context-hub");
  const runs = await new RunReadStore(storageDir).snapshot().catch(() => [] as RunEntry[]);
  const survivors = survivingRuns(runs);
  if (survivors.length > 0) {
    process.stdout.write(
      `down: ${survivors.length} run(s) keep running — down never stops runs (independent process groups survive the rig):\n`,
    );
    for (const run of survivors) {
      const task = run.task_id !== undefined ? ` task ${run.task_id}` : "";
      const pid = run.pid !== undefined ? ` pid ${run.pid}` : "";
      process.stdout.write(`down:   run ${run.run_id}${pid}${task}\n`);
    }
  } else {
    process.stdout.write("down: no running runs\n");
  }

  const services: DownReport["services"] = [];
  // Reverse start order: hub → notifier → watcher becomes notifier → watcher → hub.
  services.push({ name: "notifier", outcome: await stopService("notifier", state.notifier, storageDir) });
  if (state.watcher != null) {
    services.push({ name: "usage watcher", outcome: await stopService("usage watcher", state.watcher, storageDir) });
  }
  services.push({ name: "hub", outcome: await stopService("hub", state.hub, storageDir) });

  // Fail-visible edges: a service without recorded facts is only stoppable
  // via its endpoint evidence; one that refused to die, or whose identity
  // could not be established, is a hard failure.
  for (const service of services) {
    if (service.outcome === "no-pid") {
      process.stderr.write(`tut: down: ${service.name} has no pid recorded in ${powerStatePath(storageDir)} — judging by its endpoint below; stop it by hand if it is still running\n`);
    } else if (service.outcome === "failed") {
      process.stderr.write(`tut: down: ${service.name} did not stop (group still alive after SIGKILL) — inspect pid and stop it by hand\n`);
    }
  }
  const stillServing = await endpointsStillServing(root, state);
  for (const endpoint of stillServing) {
    process.stderr.write(`tut: down: ${endpoint} still answers for this workspace after down — a service we cannot address is still running; stop it by hand\n`);
  }

  // : the completion marker is written ONLY for a verified full stop. A
  // failed down leaves the facts untouched so the retry re-derives everything.
  const failed = services.some((s) => incomplete(s.outcome)) || stillServing.length > 0;
  if (!failed) {
    await writePowerState(storageDir, { ...state, stopped_at: new Date().toISOString() });
    await prunePowerMembers(storageDir).catch(() => undefined); // the tree is gone; drop the advisory registry
    process.stdout.write(`down: standalone rig for ${root} stopped\n`);
  } else {
    process.stdout.write("down: NOT recording a stop — the rig is not verified fully stopped (rerun tut down after fixing the above)\n");
  }
  return {
    exitCode: failed ? 1 : 0,
    services,
    survivors: survivors.map((r) => ({ run_id: r.run_id, ...(r.pid !== undefined ? { pid: r.pid } : {}), ...(r.task_id !== undefined ? { task_id: r.task_id } : {}) })),
  };
}

/** `tut down [--root <dir>]` — the CLI handler body. */
export async function runDownCommand(parsed: { root?: string }): Promise<number> {
  const root = parsed.root !== undefined ? canonicalRoot(parsed.root) : resolveRigRoot();
  const storageDir = path.join(root, ".context-hub");

  // : the power switch reads ONLY the power key — unrelated config damage
  // never blocks a stop.
  let mode: "herdr" | "standalone";
  try {
    mode = await readPowerModeForSwitch(storageDir);
  } catch (error) {
    process.stderr.write(`tut: down: ${(error as Error).message}\n`);
    return 1;
  }
  if (mode !== "standalone") {
    process.stderr.write(
      "tut: down: power.mode is herdr (the default) — the rig lives in herdr panes (tut-sys tab: tut-hub-*, tut-notify-*); stop it there: Ctrl-C inside those panes, or herdr pane close <pane-id>\n",
    );
    process.stderr.write(
      "tut: down: tut down manages standalone rigs only — to run the power switch without herdr: tut config set power.mode standalone, then tut up (and tut down stops it)\n",
    );
    return 1;
  }

  let state: PowerState | undefined;
  try {
    state = await readPowerState(storageDir);
  } catch (error) {
    process.stderr.write(`tut: down: ${(error as Error).message}\n`);
    return 1;
  }
  if (state === undefined) {
    process.stdout.write(`down: no standalone power state at ${powerStatePath(storageDir)} — nothing to stop\n`);
    return 0;
  }
  if (state.stopped_at !== undefined) {
    // : a recorded stop is trusted ONLY when re-verified now (groups gone,
    // endpoints silent). Anything else falls through to a real stop pass.
    if (await rigFullyStopped(root, state)) {
      process.stdout.write(`down: standalone rig already stopped (stopped_at ${state.stopped_at})\n`);
      return 0;
    }
    process.stdout.write(`down: power state records a stop (stopped_at ${state.stopped_at}) but the rig still answers — re-stopping from the recorded facts\n`);
  }
  const report = await stopStandaloneRig(root, state);
  return report.exitCode;
}

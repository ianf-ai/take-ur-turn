/**
 * Startup launch catchup (config key `launch.catchup`, default "off").
 *
 * Edge-triggered acting has exactly one blind spot: a waiting_for=agent:*
 * edge that lands while the Notifier is OFFLINE is folded into the startup
 * baseline snapshot (`prev === null` ⇒ "no edge"), so the round never
 * launches and — the live incident behind this module — stays stuck until a
 * human rescues it by hand. When the switch is "on", the baseline poll (the
 * tail of the observation loop's first iteration, after headless
 * restore/syncNew/observe) re-judges every in-registry agent-waiting
 * candidate ONCE through the SAME gates and the SAME autoLaunch path an
 * edge takes:
 *
 *   gate (needs_attention / launchable waiting_for)
 *     → whitelist (role-keyed auto.launch_roles)
 *     → launchBlocked dedup on the same merged task-log view
 *       → autoLaunch (which re-runs every gate internally, appends the
 *         marker, and hands the launcher child off exactly like an edge).
 *
 * dedup semantics are unchanged: a task holding a valid launch marker is
 * NOT a catchup candidate — it is skipped with an audit line only (no
 * notification, no second marker, launchBlocked stays the single source of
 * truth). A task whose log cannot be read still gets the launch attempt:
 * autoLaunch re-reads the log inside its own dedup stage and its failure
 * path is the fail-visible notification ("intervene manually").
 *
 * Observability: ONE `catchup-decision` log line per agent-waiting task
 * scanned (gate / whitelist / dedup / action), mirroring the per-poll
 * auto-decision lines so the whole startup pass is greppable. Audit
 * honesty: a check the pass never ran is reported as `n/a (gate withheld)`,
 * never as a verdict — a gate-blocked candidate's whitelist field must not
 * claim the role is absent from launch_roles when it was never consulted.
 * The pass is one-shot by construction (the Notifier disarms its guard
 * before running it); nothing here ever joins the steady-state poll.
 */

import { launchBlocked } from "../launcher/launch.js";
import type { ContextRecord } from "../common/types.js";
import type { StateAuto, StateResponse, StateTask } from "./contracts.js";

/** The Notifier-owned seams the catchup pass runs on (all bound methods). */
export interface LaunchCatchupSeams {
  /** The auto gate verdict for a task (null = pass) — the edge path's check. */
  gateOf(task: StateTask): string | null;
  /** The auto launch whitelist check (role-keyed, /state auto.launch_roles). */
  whitelisted(auto: StateAuto | undefined, role: string): boolean;
  /** Cached/incremental task log read — the same merged view the edge path dedups on. */
  readLog(taskId: string, task: StateTask): Promise<ContextRecord[]>;
  /** The edge launch path itself (gate + dedup + marker re-checked inside). */
  launch(task: StateTask, role: string): Promise<void>;
  log(line: string): void;
}

/**
 * One startup catchup pass over `state.tasks`. Serial per candidate (it runs
 * inside the compare queue; the post-marker launcher child is detached by
 * autoLaunch itself, so a slow launcher cannot block the pass).
 */
export async function runLaunchCatchup(state: StateResponse, seams: LaunchCatchupSeams): Promise<void> {
  for (const task of state.tasks) {
    if (!task.waiting_for.startsWith("agent:")) continue; // not a catchup question
    const role = task.waiting_for.slice("agent:".length);
    const gate = seams.gateOf(task);
    // The whitelist is consulted only when the gate passes; a short-circuited
    // check is reported as n/a, never mis-reported as a whitelist rejection.
    let whitelistField: string;
    let whitelisted = false;
    if (gate !== null) {
      whitelistField = "n/a (gate withheld)";
    } else {
      whitelisted = seams.whitelisted(state.auto, role);
      whitelistField = whitelisted ? "pass" : `fail ('${role}' not in launch_roles)`;
    }
    let dedup = gate !== null ? "n/a (gate withheld)" : whitelisted ? "pending" : "n/a (not whitelisted)";
    if (gate === null && whitelisted) {
      try {
        const records = await seams.readLog(task.task_id, task);
        const blocked = launchBlocked(records, role);
        dedup = blocked.blocked ? `launched@v${blocked.noteVersion}` : "fresh";
      } catch (e) {
        dedup = `unreadable (${(e as Error).message})`;
      }
    }
    let action: string;
    let launch = false;
    if (gate !== null) {
      action = `none (gate: ${gate})`;
    } else if (!whitelisted) {
      action = `none (role '${role}' not in launch whitelist)`;
    } else if (dedup === "fresh") {
      action = "launch (startup catchup)";
      launch = true;
    } else if (dedup.startsWith("launched@")) {
      action = `none (already launched; ${dedup})`;
    } else {
      // Unreadable pre-read: still hand the candidate to autoLaunch — its
      // internal dedup re-read decides, and a genuinely broken read fails
      // visibly through the auto-launch-failed notification.
      action = `launch attempt (catchup; dedup re-read inside autoLaunch; pre-read ${dedup})`;
      launch = true;
    }
    seams.log(
      `[${task.task_id}] catchup-decision: waiting_for=${task.waiting_for}` +
        ` | gate=${gate === null ? "pass" : `blocked (${gate})`}` +
        ` | whitelist=${whitelistField}` +
        ` | dedup=${dedup} | action=${action}`,
    );
    if (launch) await seams.launch(task, role);
  }
}

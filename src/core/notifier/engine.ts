/**
 * One serialized compare queue and one successful /state snapshot.
 * Gate → whitelist → dedup → lane planning/marker stays on this queue.
 * TUI children and done sweeps stay off it; lanes never advance the snapshot.
 * The shared cache and notification clocks each have a single injected owner.
 */
import path from 'node:path';
import { readConfigFile, type LaunchMode } from '../common/config.js';
import { HUB_FETCH_TIMEOUT_MS } from '../hub/hub-client.js';
import { launchBlocked, isWakeNote, latestRecordVersion, type NoteWake } from '../launcher/launch.js';
import { assertLaunchStateGate, bindLaunchBaseVersion } from '../launcher/invocation.js';
import type { ContextRecord, LaunchRequest } from '../common/types.js';
import type { StateTask, StateResponse, StateAuto, NotifyOptions, NotifierDeps, TuiLanePort, DetachedLanePort } from './contracts.js';
import { autoWhitelisted } from './contracts.js';
import type { NotifierLogCache } from './log-cache.js';
import type { NotifierNotifications } from './notifications.js';

export function stateUrlOf(url: string): string {
  return `${url.replace(/\/+$/, "")}/state`;
}

export async function defaultFetchState(url: string): Promise<StateResponse> {
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

/** An unchanged flow_mode is re-echoed at most this often, so the
 *  tail of the notify log always answers "what mode are we in". */
const FLOW_MODE_ECHO_INTERVAL_MS = 5 * 60_000;

export class NotifierEngine {
  private readonly stateUrl: string;

  private readonly intervalMs: number;

  /** Failed scans and pre-marker version races retain their exclusive lower bound independently of
   * /state snapshots. One interval per task, retried on the next eligible poll. */
  private pendingNoteScans = new Map<string, { version: number; status: string; waiting_for: string }>();

  private currentSnapshot: Map<string, StateTask> | null = null;
  get snapshot(): ReadonlyMap<string, StateTask> | null { return this.currentSnapshot; }

  /** Degraded ids as of the last successful poll (system-design 4.3);
   *  null before the first fetch. */
  private lastDegraded: Set<string> | null = null;

  private consecutiveFailures = 0;

  /** Last observed flow_mode; null before the first successful fetch. */
  private lastFlowMode: string | null = null;

  /** When the last flow_mode line (change or echo) was logged. */
  private lastModeEchoAt = 0;

  // Serial-compare queue: `pending` coalesces, `drain` is the in-flight cycle.
  private pending = false;

  private drain: Promise<void> | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    options: NotifyOptions,
    private readonly rigRoot: string,
    private readonly deps: Pick<NotifierDeps, 'fetchState' | 'now' | 'log'>,
    private readonly launchModeReader: (root: string) => Promise<LaunchMode>,
    private readonly logs: NotifierLogCache,
    private readonly notifications: NotifierNotifications,
    private readonly tui: TuiLanePort,
    private readonly detached: DetachedLanePort,
  ) {
    this.stateUrl = stateUrlOf(options.url);
    this.intervalMs = Math.max(1, options.interval) * 1000;
  }
  private closed = false;
  close(): void {
    this.closed = true;
    this.pending = false;
    if (this.pollTimer !== null) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.pendingNoteScans.clear();
  }


  log(line: string): void {
    this.deps.log(`tut: notify: ${line}`);
  }

  /** Schedules one compare; same-macrotask requests coalesce into one run. */
  requestCompare(): Promise<void> {
    if (this.closed) return Promise.resolve();
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
      state = await this.deps.fetchState(`${this.stateUrl}?include=closed`);
    } catch (e) {
      // Poll failure: one stderr line per consecutive failure RUN, snapshot
      // kept, same interval, no notification, no crash (§3).
      if (this.consecutiveFailures === 0) {
        this.log(`poll failed: ${(e as Error).message}; keeping snapshot, retrying next interval`);
      }
      this.consecutiveFailures += 1;
      return;
    }
    if (this.closed) return;
    this.consecutiveFailures = 0;
    // Channel set rebuilt from /state's notify key EVERY poll.
    this.notifications.configure(state);
    // routing maps refreshed every poll too — workspace.json edits apply
    // without restart; a failed load keeps the previous maps (events before
    // the first successful load degrade to the no-mapping path).
    await this.tui.refreshRouting();

    // /state deliberately falls back to manual for broken config. Preserve
    // that safe gate, but make the configuration failure visible on Channel
    // as well as the Hub's stderr, including a corrupt startup baseline.
    if (state.flow_mode === 'manual' && this.lastFlowMode !== 'manual') {
      const configRoot = path.join(this.rigRoot, '.context-hub');
      void readConfigFile(configRoot).then(async outcome => {
        if (outcome.status !== 'invalid') return;
        const body = `Launch configuration ${path.join(configRoot, 'config.json')} is unreadable or corrupt; automatic launch withheld; repair the configuration before explicitly waking a task.`;
        this.log(body);
        await this.notifications.sendAll({ title: 'TUT: invalid launch configuration', body });
      }).catch(e => this.log(`configuration diagnostic failed: ${(e as Error).message}`));
    }
    await this.detached.observe(state);
    if (this.closed) return;
    const prev = this.currentSnapshot;
    const prevDegraded = this.lastDegraded;
    const now = this.deps.now();
    this.currentSnapshot = new Map(state.tasks.map((t) => [t.task_id, t]));
    // An absent/degraded task loses online wake permission. Recovery is a
    // new observation baseline, never a replay of a parked pre-recovery note.
    this.detached.reconcilePresence(this.currentSnapshot);
    // Do not carry a failed scan across a round/gate/mode change or a missing
    // task. Recovery and startup still establish baselines, never replay notes.
    for (const [taskId, scan] of this.pendingNoteScans) {
      const task = this.currentSnapshot.get(taskId);
      if (state.flow_mode !== "auto" || task === undefined || task.needs_attention ||
        task.status !== scan.status || task.waiting_for !== scan.waiting_for ||
        !autoWhitelisted(state.auto, task.waiting_for.slice("agent:".length)) ||
        task.version === undefined || task.version < (prev?.get(taskId)?.version ?? scan.version)) {
        this.pendingNoteScans.delete(taskId);
      }
    }
    this.tui.setRemediationMode(state.auto?.remediate ?? (state.flow_mode === "auto" ? "enter-repress" : "off"));
    this.lastDegraded = new Set(state.degraded ?? []);
    this.logs.reconcileLogCache(state, prev);
    await this.detached.reconcileHeadlessDeliveries(state, now);
    // A task omitted from /state has left the observable workflow. Forget its
    // approval edge so a later reappearance can notify again.
    this.notifications.reconcilePresence(this.currentSnapshot);
    await this.tui.retireObsoleteWorkingWatches(this.currentSnapshot);
    // Mode visibility — a switch logs immediately, an unchanged mode
    // is re-echoed periodically (below the baseline branch so the baseline
    // line itself stays the first mode statement of a session).
    this.observeFlowMode(state.flow_mode, now);

    if (prev === null) {
      // First successful fetch: baseline, no workflow notifications — but a
      // task ALREADY degraded at startup is exactly the silent-loss shape the
      // degraded listing exists to kill, so its entering edge alerts here (the notifier cannot
      // know it was degraded before it started watching).
      await this.notifications.diffDegraded(null, prevDegraded, this.lastDegraded, state);
      this.notifications.baseline(state.tasks, now);
      this.log(
        `baseline: ${state.tasks.length} task(s), flow_mode=${state.flow_mode}` +
        ((state.degraded?.length ?? 0) > 0 ? `, degraded=${state.degraded!.length}` : ""),
      );
      // Decision lines on the baseline poll too — a task that is
      // ALREADY agent-waiting when the notifier (re)starts is exactly the
      // silent-door shape; its "no action, and why" must be visible.
      if (state.flow_mode === "auto") await this.logAutoDecisions(null, state);
      // Startup launch catchup (launch.catchup, default off): the ONE gated
      // call point at the tail of the startup observation pass — see
      // runStartupCatchup / launch-catchup.ts. Off stays byte-silent.
      await this.detached.runStartupCatchup(state);
      return;
    }

    try {
      // Recovery bookkeeping runs FIRST so this poll knows which tasks just
      // re-entered tasks[] from degraded / vanished — the recovery edge is a
      // log line only (system-design 6.1), and that verdict must gate both the
      // auto-decision lines and diffTask below.
      const recoveredThisTick = await this.notifications.diffDegraded(prev, prevDegraded, this.lastDegraded, state);
      // Per-poll decision lines precede this poll's acting — the line
      // announces the launch (or the reason there will be none) first.
      const noteWakes = state.flow_mode === "auto"
        ? await this.logAutoDecisions(prev, state, recoveredThisTick) : new Map<string, NoteWake>();
      // An observed stop cancels earlier candidates: without a human
      // instruction registered after the stop boundary, a bare note edge
      // must not relaunch.
      this.detached.filterStoppedWakes(noteWakes);
      const newApprovals = new Set<string>();
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
          this.notifications.recovered(after, now);
          continue;
        }
        // Headless coalescing: a parked candidate launches when its run
        // finishes; the pending human note version rides along as the wake.
        const readyWake = this.detached.takeReadyWake(after, state);
        await this.diffTask(prev.get(after.task_id), after, state.flow_mode, state.auto, state.notify,
          noteWakes.get(after.task_id) ?? readyWake, newApprovals);
      }
      if (newApprovals.size > 0) await this.notifications.notifyPendingApprovals(state, newApprovals);
      this.notifications.completeApprovals(newApprovals);
      this.notifications.checkStalls(state.tasks, now);
    } catch (e) {
      // Unsent Channel edges remain queued, without resetting observed Host edges.
      // compare/act itself should never throw; if it does, log and survive.
      this.log(`compare failed unexpectedly: ${(e as Error).message}`);
    }
  }

  private async diffTask(
    before: StateTask | undefined,
    after: StateTask,
    flowMode: string,
    auto: StateAuto | undefined,
    notify: unknown,
    noteWake: NoteWake | undefined,
    newApprovals: Set<string>,
  ): Promise<void> {
    // Close-edge pane cleanup: `tut decide close`
    // keeps its synchronous cleanup child, but the decision may land through
    // ANY entrance (decide is callable from any MCP client) — this
    // consumer-side edge covers them all. Transition-edge ONLY: `before` must
    // exist and not be closed; a task already closed at baseline / first
    // sight must NOT fire, or every restart would spawn one launcher child
    // per historical closed task. Closed is absorbing, so the edge
    // fires at most once per task per notifier run. Placed above the
    // notification branches: the close itself stays notification-silent (the
    // waiting_for → "none" early return below), and a rising needs_attention
    // must not swallow the reap either.
    if (before !== undefined && before.status !== "closed" && after.status === "closed") {
      if (await this.detached.closeTask(after)) this.tui.cleanupClosedTask(after.task_id);
    }
    const pendingApprovalEntering = this.notifications.updatePendingApprovalEdge(after);
    if (this.notifications.hasPendingApprovalNotification(after.task_id)) newApprovals.add(after.task_id);
    // A task absent from the previous snapshot counts as waiting_for "none"
    // before, so brand-new tasks notify (absent → agent:* is a change) but a
    // snapshot-miss with waiting_for "none" stays silent.
    const beforeWf = before?.waiting_for ?? "none";
    const wfChanged = beforeWf !== after.waiting_for;
    const attentionRising = after.needs_attention && before?.needs_attention !== true;
    // Reuse the existing edge bookkeeping. Detach I/O just like cleanup:
    // failure is logged once and never retried by subsequent quiet polls.
    if (pendingApprovalEntering) this.tui.reportHostStatus(after, "pending_approval", notify);
    if (attentionRising) this.tui.reportHostStatus(after, "needs_attention", notify);

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
      // warnings content; the human runs `tut read` for
      // the cause.
      await this.notifications.sendAll({
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
      return;
    }
    if (!wfChanged && !noteWake) return;
    if (after.waiting_for === "none") return; // human closed / wound down — silent (§3)

    if (flowMode !== "auto") {
      // manual: notify only — task, status, who moves next. The round pane is
      // named `<task_id>.<role>` (fresh-session convention, 4.4); human-waiting
      // states have no agent pane, so the segment is omitted there.
      const paneSeg = after.waiting_for.startsWith("agent:")
        ? `; pane: ${after.task_id}.${after.waiting_for.slice("agent:".length)}`
        : "";
      await this.notifications.sendAll({
        title: `TUT ${after.task_id}: waiting for ${after.waiting_for}`,
        body: `${after.title} — status: ${after.status}; waiting for: ${after.waiting_for}${paneSeg}`,
        task_id: after.task_id,
      });
      return;
    }

    // --- auto branch gate (see module doc for the exact rule) ---
    const gated = this.autoGateReason(after);
    if (gated !== null) {
      await this.notifications.sendAll({
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
      await this.notifications.sendAll({
        title: `TUT ${after.task_id}: auto launch withheld`,
        body: `${after.title} — status: ${after.status}; waiting for: ${after.waiting_for}; auto launch withheld: role '${role}' not in launch whitelist (config.json auto.launch_roles)`,
        task_id: after.task_id,
      });
      return;
    }
    await this.autoLaunch(after, role, noteWake);
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
  autoGateReason(after: StateTask): string | null {
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
  ): Promise<Map<string, NoteWake>> {
    const noteWakes = new Map<string, NoteWake>();
    for (const task of state.tasks) {
      if (!task.waiting_for.startsWith("agent:")) continue;
      const role = task.waiting_for.slice("agent:".length);
      const gate = this.autoGateReason(task);
      const whitelisted = autoWhitelisted(state.auto, role);
      let dedup = gate !== null ? "n/a (gate withheld)" : "n/a (not whitelisted)";
      if (gate === null && whitelisted) {
        const beforeVersion = this.pendingNoteScans.get(task.task_id)?.version ?? prev?.get(task.task_id)?.version;
        const afterVersion = task.version;
        const scanNotes = !recoveredIntoTasks?.has(task.task_id) && beforeVersion !== undefined &&
          afterVersion !== undefined && afterVersion > beforeVersion;
        try {
          const records = await this.logs.fullLog(task.task_id, task);
          this.pendingNoteScans.delete(task.task_id);
          if (scanNotes) {
            // Keep this cutoff across read retries: observing stop cancels
            // earlier candidates, not instructions issued after the request.
            this.detached.scanHumanWake(task.task_id, records, beforeVersion, afterVersion);
            const version = records.reduce((max, record) =>
              record.version > beforeVersion && record.version <= afterVersion && isWakeNote(record)
                ? Math.max(max, record.version) : max, 0);
            if (version > 0) noteWakes.set(task.task_id, { version });
          }
          const blocked = launchBlocked(records, role, noteWakes.get(task.task_id));
          dedup = blocked.blocked ? `launched@v${blocked.noteVersion}` : "fresh";
        } catch (e) {
          dedup = `unreadable (${(e as Error).message})`;
          if (scanNotes) this.pendingNoteScans.set(task.task_id, {
            version: beforeVersion, status: task.status, waiting_for: task.waiting_for,
          });
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
            : noteWakes.has(task.task_id) ? "launch (non-ack note edge)" : "none (no waiting_for edge since last poll)";
        }
      } else if (dedup.startsWith("launched@")) {
        action = `none (already launched; ${dedup})`;
      } else {
        // Edge-on-this-poll leftover: with an edge on THIS poll the
        // action is not "none" — autoLaunch re-reads the log inside its own
        // dedup stage and acts on that read, not on this poll's failed one.
        const edge = prev !== null
          && ((prev.get(task.task_id)?.waiting_for ?? "none") !== task.waiting_for || noteWakes.has(task.task_id));
        action = edge
          ? `launch attempt this poll (dedup re-read inside autoLaunch; poll read ${dedup})`
          : `none this poll; an edge would re-read the log (dedup ${dedup})`;
      }
      this.log(
        `[${task.task_id}] auto-decision: waiting_for=${task.waiting_for}` +
        ` | gate=${gate === null ? "pass" : `blocked (${gate})`}` +
        ` | needs_attention=${task.needs_attention}` +
        ` | whitelist=${whitelisted ? "pass" : `fail ('${role}' not in launch_roles)`}` +
        ` | dedup=${dedup} | action=${action}` + (noteWakes.has(task.task_id) ? ` | trigger=non-ack note edge | note-version=v${noteWakes.get(task.task_id)!.version}` : "") +
        (this.pendingNoteScans.has(task.task_id) ? ` | note-scan=pending after v${this.pendingNoteScans.get(task.task_id)!.version}; retry next eligible poll` : ""),
      );
    }
    return noteWakes;
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

  deferNoteWake(task: StateTask, noteWake: NoteWake, reason = "pre-marker version race"): void {
    this.pendingNoteScans.set(task.task_id, {
      version: noteWake.version - 1, status: task.status, waiting_for: task.waiting_for,
    });
    this.log(`[${task.task_id}] note wake v${noteWake.version} deferred: ${reason}; retry next eligible poll`);
  }

  async autoLaunch(task: StateTask, role: string, noteWake?: NoteWake): Promise<void> {
    if (this.closed) return;
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
    if (this.detached.coalesceBusy(task, role, noteWake)) return;
    let mode: LaunchMode;
    try { mode = await this.launchModeReader(path.join(this.rigRoot, '.context-hub')); }
    catch (e) { await this.autoLaunchFailed(task, role, e); return; }
    if (mode === 'detached') {
      await this.tui.awaitSweepBarrier(task.task_id);
      if (noteWake !== undefined && !this.detached.allowsNoteWake(task.task_id)) return;
      await this.detached.autoLaunchHeadless(task, role);
      return;
    }
    // Done-sweep barrier (1/3, entry): this task's final-screen evidence must
    // be archived (or its failure recorded) before this round's launch
    // machinery starts — the launcher reaps the very panes the sweep reads.
    await this.tui.awaitSweepBarrier(task.task_id);
    let records: ContextRecord[];
    try {
      records = await this.logs.fullLog(task.task_id, task);
    } catch (e) {
      if (noteWake !== undefined) this.deferNoteWake(task, noteWake, "log read failed before marker");
      await this.autoLaunchFailed(task, role, e);
      return;
    }

    const blocked = launchBlocked(records, role, noteWake);
    // A covering marker can have arrived after /state. It already registered
    // this note attempt, even though binding the now-stale state would fail.
    if (noteWake !== undefined && blocked.blocked) {
      await this.autoLaunchSkipped(task, role, blocked.noteVersion);
      return;
    }
    let baseVersion: number;
    try {
      baseVersion = bindLaunchBaseVersion(task.version, latestRecordVersion(records));
    } catch (e) {
      if (noteWake !== undefined && task.version !== undefined && latestRecordVersion(records) > task.version) {
        this.deferNoteWake(task, noteWake);
        return;
      }
      await this.autoLaunchFailed(task, role, e);
      return;
    }

    if (blocked.blocked) {
      await this.autoLaunchSkipped(task, role, blocked.noteVersion);
      return;
    }

    await this.tui.launch(task, role, baseVersion, noteWake);
  }

  async autoLaunchSkipped(task: StateTask, role: string, noteVersion: number | undefined): Promise<void> {
    const suffix = noteVersion === undefined ? "" : ` at v${noteVersion}`;
    this.log(`auto launch skipped (already launched): ${task.task_id} (${role}${suffix})`);
    await this.notifications.sendAll({
      title: `TUT ${task.task_id}: auto launch skipped (already launched)`,
      body: `${task.title} — ${role} was already launched${suffix}; no new publish since`,
      task_id: task.task_id,
    });
  }

  async autoLaunchFailed(task: StateTask, role: string, error: unknown): Promise<void> {
    const message = (error as Error).message;
    this.log(`launch failed for ${task.task_id} (${role}): ${message}`);
    await this.notifications.sendAll({
      title: `TUT ${task.task_id}: auto launch failed`,
      body: `${task.title} — tut launch ${role} failed: ${message}; intervene manually`,
      task_id: task.task_id,
    });
  }

  // --- lifecycle ---------------------------------------------------------------------

  /** Starts the poll loop: one immediate baseline compare, then each interval. */
  startPolling(): void {
    if (this.closed || this.pollTimer !== null) return;
    void this.requestCompare();
    this.pollTimer = setInterval(() => void this.requestCompare(), this.intervalMs);
  }
}

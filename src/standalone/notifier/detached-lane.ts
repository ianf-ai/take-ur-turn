/** Detached wake/version boundaries and read-only run observation.
 * Reuses HeadlessRuntime and the engine's log cache; owns no poll or timers.
 * close() drops observer state, never stops managed runs. */
import path from 'node:path';
import { readLaunchCheckout, type LaunchMode, type LaunchCatchup } from '../../core/common/config.js';
import { HubError } from '../../core/hub/hub-client.js';
import type { ContextRecord } from '../../core/common/types.js';
import type { NoteWake } from '../../core/launcher/launch.js';
import type { StateTask, StateResponse, NotifyOptions, NotifierDeps, LaneContext } from '../../core/notifier/contracts.js';
import { autoWhitelisted } from '../../core/notifier/contracts.js';
import { runLaunchCatchup } from '../../core/notifier/launch-catchup.js';
import { buildHeadlessPlan, headlessGeneration, humanInstruction } from '../launcher-headless/plan.js';
import type { HeadlessRuntime } from '../launcher-headless/runtime.js';

export class DetachedLane {
  /** One-shot guard for the startup catchup pass (launch.catchup); disarmed on first use. */
  private catchupArmed = true;

  private readonly humanWakeVersions = new Map<string, number>();

  private readonly headlessStopBoundaries = new Map<string, number>();

  private readonly headlessPending = new Map<string, { role: string; humanVersion: number }>();

  /** Independent of /state snapshot so a failed Hub read keeps its lower bound. */
  private deliveryVersions = new Map<string, { processed: number; seen: number }>();

  constructor(
    private readonly options: NotifyOptions,
    private readonly rigRoot: string,
    private readonly context: Pick<LaneContext,
      'log' | 'fullLog' | 'awaitSweepBarrier' | 'autoLaunchFailed' | 'autoLaunchSkipped' |
      'autoGateReason' | 'autoLaunch'>,
    private readonly deps: Pick<NotifierDeps, 'now' | 'readLog'>,
    private readonly headless: HeadlessRuntime,
    private readonly launchModeReader: (root: string) => Promise<LaunchMode>,
    private readonly catchupReader: (root: string) => Promise<LaunchCatchup>,
    private readonly readTaskDescription: (taskId: string) => Promise<string | undefined>,
  ) { }
  private readonly checkoutModeReader = readLaunchCheckout;
  private get stateUrl(): string { return this.options.url.replace(/\/+$/, '') + '/state'; }
  private get eventPort(): number { return this.options.eventPort; }
  private closed = false;
  close(): void {
    this.closed = true;
    this.catchupArmed = false;
    this.humanWakeVersions.clear(); this.headlessStopBoundaries.clear();
    this.headlessPending.clear(); this.deliveryVersions.clear();
  }
  async observe(state: StateResponse): Promise<void> {
    if (this.closed) return;
    this.headless.restore();
    this.headless.syncNew();
    const headlessObserved = await this.headless.observe({
      now: this.deps.now(), stallMs: Math.max(0, this.options.stallTimeoutMin) * 60_000,
      tasks: new Map(state.tasks.map(t => [t.task_id, t])),
    });
    if (this.closed) return;
    for (const stop of headlessObserved.stopped) {
      this.headlessPending.delete(stop.task_id);
      this.humanWakeVersions.delete(stop.task_id);
      this.headlessStopBoundaries.set(stop.task_id, Date.parse(stop.requested_at));
    }
  }
  reconcilePresence(tasks: ReadonlyMap<string, StateTask>): void {
    for (const map of [this.humanWakeVersions, this.headlessPending, this.headlessStopBoundaries]) {
      for (const taskId of map.keys()) if (!tasks.has(taskId)) map.delete(taskId);
    }
  }
  scanHumanWake(taskId: string, records: ContextRecord[], lower: number, upper: number): void {
    const stopBoundary = this.headlessStopBoundaries.get(taskId);
    const humanVersion = records.filter(r => r.version > lower && r.version <= upper && humanInstruction(r) &&
      (stopBoundary === undefined || Date.parse(r.timestamp) >= stopBoundary)).reduce((max, r) => Math.max(max, r.version), 0);
    if (humanVersion) this.humanWakeVersions.set(taskId, humanVersion);
    else if (!this.headlessPending.has(taskId)) this.humanWakeVersions.delete(taskId);
  }
  filterStoppedWakes(wakes: Map<string, NoteWake>): void {
    for (const taskId of this.headlessStopBoundaries.keys()) {
      if (!this.humanWakeVersions.has(taskId)) wakes.delete(taskId);
    }
  }
  takeReadyWake(task: StateTask, state: StateResponse): NoteWake | undefined {
    const pending = this.headlessPending.get(task.task_id);
    if (pending && (state.flow_mode !== 'auto' || task.needs_attention || task.waiting_for !== `agent:${pending.role}` || !autoWhitelisted(state.auto, pending.role))) this.headlessPending.delete(task.task_id);
    const ready = this.headlessPending.has(task.task_id) && !this.headless.busy(task.task_id);
    if (!ready) return undefined;
    this.humanWakeVersions.set(task.task_id, Math.max(pending!.humanVersion, this.humanWakeVersions.get(task.task_id) ?? 0));
    this.headlessPending.delete(task.task_id);
    return { version: pending!.humanVersion };
  }
  coalesceBusy(task: StateTask, role: string, noteWake?: NoteWake): boolean {
    if (!this.headless.busy(task.task_id)) return false;
    if (noteWake !== undefined && !this.humanWakeVersions.has(task.task_id) && !this.headlessPending.has(task.task_id)) return true;
    this.headlessPending.set(task.task_id, { role, humanVersion: this.humanWakeVersions.get(task.task_id) ?? 0 });
    this.context.log(`detached task=${task.task_id}: previous run not complete; candidate coalesced`);
    return true;
  }
  allowsNoteWake(taskId: string): boolean { return this.humanWakeVersions.has(taskId); }
  /** Returns whether historical resource ownership also calls for TUI cleanup. */
  async closeTask(after: StateTask): Promise<boolean> {
    this.headlessPending.delete(after.task_id);
    // close-stop audit: confirm the version of the decision(close) that
    // TRANSITIONED the task into closed — the FIRST close record, never a
    // later idempotent re-decision, and never the task's latest version
    // (which may carry later notes).
    let closeVersion: number | undefined;
    try {
      const records = await this.context.fullLog(after.task_id, after).catch(() => []);
      closeVersion = records.reduce((min, r) => (r.content_type === "decision" && (r.payload as { decision?: unknown }).decision === "close" ? (min === undefined ? r.version : Math.min(min, r.version)) : min), undefined as number | undefined);
    } catch { closeVersion = undefined; }
    this.headless.closeTask(after.task_id, closeVersion);
    // Resource ownership, not the current config switch, chooses cleanup.
    const records = this.headless.knows(after.task_id) ? await this.context.fullLog(after.task_id, after).catch(() => []) : [];
    const launches = records.filter(r => r.content_type === 'note' && r.payload.launch !== undefined);
    // Markers keep the wire spelling, independent of normalized configuration.
    return launches.length === 0 || launches.some(r => (r.payload.launch as { launch_mode?: string }).launch_mode !== 'headless');

  }

  async reconcileHeadlessDeliveries(state: StateResponse, now: number): Promise<void> {
    let mode: LaunchMode;
    try { mode = await this.launchModeReader(path.join(this.rigRoot, '.context-hub')); }
    catch (e) {
      this.deliveryVersions.clear();
      this.context.log(`detached delivery observation skipped: ${(e as Error).message}`); return;
    }
    if (mode !== 'detached') { this.deliveryVersions.clear(); return; }
    const present = new Set(state.tasks.map(t => t.task_id));
    for (const id of this.deliveryVersions.keys()) if (!present.has(id)) this.deliveryVersions.delete(id);
    for (const task of state.tasks) {
      const version = task.version;
      if (version === undefined || !this.headless.knows(task.task_id)) { this.deliveryVersions.delete(task.task_id); continue; }
      const boundary = this.deliveryVersions.get(task.task_id);
      if (!boundary || version < boundary.seen) {
        this.deliveryVersions.set(task.task_id, { processed: version, seen: version }); continue;
      }
      boundary.seen = version;
      if (version <= boundary.processed) continue;
      // Occupancy can outlive an unreadable completion. Keep the interval,
      // but do not repeatedly pull Hub history while evidence is pending.
      if (this.headless.busy(task.task_id)) continue;
      try {
        const records = await this.context.fullLog(task.task_id, task);
        if (await this.headless.reconcileDeliveries(task.task_id, records, boundary.processed, version, now)) {
          boundary.processed = version;
        }
      } catch (e) {
        this.context.log(`detached delivery context check failed task=${task.task_id}: ${(e as Error).message}; retry next poll`);
      }
    }
  }

  /**
   * Startup launch catchup (launch.catchup, default off). Runs ONCE per
   * notifier lifetime, at the tail of the baseline poll — the first
   * successful fetch, after headless restore/syncNew/observe and after the
   * baseline auto-decision lines. The pass itself lives in
   * launch-catchup.ts: gate → whitelist → launchBlocked dedup → the same
   * autoLaunch path an edge takes. Discipline:
   *   - "off" (the default) is byte-silent — the pre-catchup notifier;
   *   - a switch/mode read failure is ONE visible log line and NO catchup
   *     (fail-visible; never a silent fallthrough to launching);
   *   - the pass is HEADLESS-ONLY: a non-detached launch_mode returns
   *     silently BEFORE the flow-mode skip line and any candidate scan, so
   *     the TUI lane's startup output stays byte-identical to the
   *     pre-catchup notifier in auto AND manual alike ("tui 档行为零变化");
   *   - the guard disarms before any await: one-shot by construction, no
   *     periodic retry — a later config flip applies to the NEXT restart.
   */
  async runStartupCatchup(state: StateResponse): Promise<void> {
    if (!this.catchupArmed || this.closed) return;
    this.catchupArmed = false;
    let mode: LaunchCatchup;
    try {
      mode = await this.catchupReader(path.join(this.rigRoot, ".context-hub"));
    } catch (e) {
      this.context.log(`launch catchup withheld: ${(e as Error).message}`);
      return;
    }
    if (mode !== "on") return;
    // The repair is scoped to the headless lane: a TUI startup round must
    // stay byte-identical to the pre-catchup notifier — no marker, no
    // launcher, no catchup log byte, in auto AND manual alike — so the mode
    // gate sits BEFORE the flow-mode skip line and any candidate scan.
    let launchMode: LaunchMode;
    try {
      launchMode = await this.launchModeReader(path.join(this.rigRoot, ".context-hub"));
    } catch (e) {
      this.context.log(`launch catchup withheld: ${(e as Error).message}`);
      return;
    }
    if (launchMode !== "detached") return;
    if (state.flow_mode !== "auto") {
      this.context.log("launch catchup skipped: flow_mode is not auto");
      return;
    }
    await runLaunchCatchup(state, {
      gateOf: (task) => this.context.autoGateReason(task),
      whitelisted: autoWhitelisted,
      readLog: (taskId, task) => this.context.fullLog(taskId, task),
      launch: (task, role) => this.context.autoLaunch(task, role),
      log: (line) => this.context.log(line),
    });
  }

  async autoLaunchHeadless(task: StateTask, role: string): Promise<void> {
    if (this.closed) return;
    try {
      const records = await this.context.fullLog(task.task_id, task);
      const onlineHumanVersion = this.humanWakeVersions.get(task.task_id) ?? 0;
      const generation = headlessGeneration(records, role, onlineHumanVersion);
      if (generation.blocked) {
        await this.context.autoLaunchSkipped(task, role, generation.marker);
        return;
      }
      // Anchored checkout (design 7.6): freeze launch.checkout once for this
      // decision, and fetch the description only when anchoring needs it —
      // rig (default) keeps the exact pre-existing plan path.
      const launchCheckout = await this.checkoutModeReader(path.join(this.rigRoot, '.context-hub'));
      const description = launchCheckout === 'anchored' ? await this.readTaskDescription(task.task_id) : undefined;
      const plan = await buildHeadlessPlan({
        task, role, records, onlineHumanVersion, hubRoot: this.rigRoot,
        hubUrl: this.stateUrl.replace(/\/state$/u, ''), eventUrl: `http://127.0.0.1:${this.eventPort}/agent-event`, runs: this.headless.runs(), description, launchCheckout
      });
      await this.context.awaitSweepBarrier(task.task_id);
      if (this.closed) return;
      try { await this.headless.mark(plan); }
      catch (e) {
        if ((e instanceof HubError && e.code === "VERSION_CONFLICT") || (e as Error).message.includes("VERSION_CONFLICT")) {
          const latest = await this.deps.readLog(task.task_id);
          const covered = headlessGeneration(latest, role, onlineHumanVersion);
          if (covered.blocked) { await this.context.autoLaunchSkipped(task, role, covered.marker); return; }
        }
        throw e;
      }
      await this.context.awaitSweepBarrier(task.task_id);
      if (this.closed) return;
      this.headless.launch(plan);
      this.humanWakeVersions.delete(task.task_id);
      this.headlessStopBoundaries.delete(task.task_id);
    } catch (e) { await this.context.autoLaunchFailed(task, role, e); }
  }
}

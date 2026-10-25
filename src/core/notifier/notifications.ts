import { createChannels, type Channel, type Notification } from '../common/channels.js';
import type { NotifierDeps, StateTask, StateResponse } from './contracts.js';

/** Keep approval alerts useful in desktop surfaces with a bounded title body. */
const PENDING_APPROVAL_TITLE_LIMIT = 72;

function truncatePendingApprovalTitle(title: string): string {
  return title.length <= PENDING_APPROVAL_TITLE_LIMIT
    ? title
    : `${title.slice(0, PENDING_APPROVAL_TITLE_LIMIT)}…`;
}

export class NotifierNotifications {
  /** Observed approval edges; Host relay attempts must never be retried. */
  private pendingApprovalTasks = new Set<string>();

  /** Channel approval edges awaiting an aggregate send, independent of Host relay. */
  private pendingApprovalNotifications = new Set<string>();

  /** Currently-degraded ids whose entering edge has already been alerted
   *  (exactly-once per degraded stay; cleared on the recovery edge so a
   *  later re-corruption alerts again). */
  private degradedAlerted = new Set<string>();

  /** Vanished ids whose disappearance edge has already been alerted
   *  (cleared when the directory comes back). */
  private vanishedAlerted = new Set<string>();

  private channels: Channel[] = createChannels(undefined);

  // Stall watchdog (in-memory): updated_at is treated as an opaque
  // string — ANY change (including note appends, accepted heuristic) resets.
  private lastUpdatedAt = new Map<string, string>();

  private lastProgressAt = new Map<string, number>();

  private stallNotified = new Set<string>();

  constructor(private readonly stallMs: number, private readonly deps: Pick<NotifierDeps, 'now' | 'log' | 'channelsFor'>) { }
  private log(line: string): void { this.deps.log(line); }
  hasPendingApprovalNotification(taskId: string): boolean { return this.pendingApprovalNotifications.has(taskId); }
  completeApprovals(taskIds: ReadonlySet<string>): void {
    for (const taskId of taskIds) this.pendingApprovalNotifications.delete(taskId);
  }
  configure(state: StateResponse): void { this.channels = this.deps.channelsFor(state.notify); }
  reconcilePresence(tasks: ReadonlyMap<string, StateTask>): void {
    for (const taskId of this.pendingApprovalTasks) {
      if (!tasks.has(taskId)) { this.pendingApprovalTasks.delete(taskId); this.pendingApprovalNotifications.delete(taskId); }
    }
  }
  baseline(tasks: readonly StateTask[], now: number): void {
    for (const t of tasks) {
      this.lastUpdatedAt.set(t.task_id, t.updated_at);
      this.lastProgressAt.set(t.task_id, now);
      if (t.status === 'pending_approval') this.pendingApprovalTasks.add(t.task_id);
    }
  }
  recovered(task: StateTask, now: number): void { this.lastUpdatedAt.set(task.task_id, task.updated_at); this.markProgress(task.task_id, now); }
  close(): void {
    this.pendingApprovalTasks.clear(); this.pendingApprovalNotifications.clear();
    this.degradedAlerted.clear(); this.vanishedAlerted.clear();
    this.lastUpdatedAt.clear(); this.lastProgressAt.clear(); this.stallNotified.clear();
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
  async diffDegraded(
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

  /** Track the pending_approval edge independently of waiting_for changes. */
  updatePendingApprovalEdge(task: StateTask): boolean {
    if (task.status !== "pending_approval") {
      this.pendingApprovalTasks.delete(task.task_id);
      this.pendingApprovalNotifications.delete(task.task_id);
      return false;
    }
    const entering = !this.pendingApprovalTasks.has(task.task_id);
    this.pendingApprovalTasks.add(task.task_id);
    if (entering) this.pendingApprovalNotifications.add(task.task_id);
    return entering;
  }

  /** One approval edge notification carries the complete pending queue. */
  async notifyPendingApprovals(state: StateResponse, entering: ReadonlySet<string>): Promise<void> {
    const pending = state.tasks.filter(task => task.status === "pending_approval");
    const first = pending[0]!;
    const title = pending.length === 1
      ? (state.flow_mode === "auto" ? `TUT ${first.task_id}: human decision needed` : `TUT ${first.task_id}: waiting for human`)
      : `TUT: ${pending.length} tasks waiting for approval`;
    const body = pending.map(task => {
      const since = typeof task.pending_since === "string" ? Date.parse(task.pending_since) : NaN;
      const duration = Number.isFinite(since) ? `${Math.floor(Math.max(0, this.deps.now() - since) / 1000)}s` : "unknown";
      const marker = entering.has(task.task_id) ? "[\u65b0] " : "";
      const gate = state.flow_mode === "auto" ? "; auto launch withheld (pending human decision)" : "";
      return `${marker}${task.task_id}: ${truncatePendingApprovalTitle(task.title)} - status: pending_approval; waiting for: ${task.waiting_for}; waiting for approval; pending: ${duration}${gate}; run \`tut decide ${task.task_id} --decision approve --by <your-name>\` (replace \`<your-name>\` with your identity; use \`--decision reject\` to request revisions)`;
    }).join("\n");
    await this.sendAll({
      title, body, task_id: pending.find(task => entering.has(task.task_id))!.task_id,
      ...(pending.length > 1 ? { task_ids: pending.map(task => task.task_id) } : {})
    });
  }

  async sendAll(msg: Notification): Promise<void> {
    // stdout IS the run log for the dedicated pane — every
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

  markProgress(taskId: string, now: number): void {
    this.lastProgressAt.set(taskId, now);
    this.stallNotified.delete(taskId);
  }

  checkStalls(tasks: readonly StateTask[], now: number): void {
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
}

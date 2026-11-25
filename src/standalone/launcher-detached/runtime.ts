import {verifySession,selectSession} from '../../agents/public/index.js';
import {sessionReadServices} from '../../core/run/session-services.js';
import {encodeContract} from '../../agents/public/index.js';
/** Run ownership and observation. No log content reads, pane events, or process kills. */
import { RepeatedDiagnostics, diagnosticLedger } from '../../core/logging/repeated-diagnostics.js';
import { HubError, hubPublish } from '../../hub/hub-client.js';
import { RunStore, probe, complete, type RunMeta } from '../../core/run/store.js';
import { startRun, stopRun, StartRunError } from '../../core/run/control.js';
import { sessionOccupants, taskOccupants, withAdmissionLock } from '../../core/run/admission.js';
import { closeStopAuditId, hasCloseStopAudit, effectiveCloseDecisionVersion, publishCloseStopAudit, type CloseStopAuditInput } from '../../core/run/close-audit.js';
import type { ContextRecord, LaunchVia } from '../../protocol/types.js';
import type { Notification } from '../../core/common/channels.js';
import { type HeadlessPlan, type HeadlessTask } from './plan.js';

/** Terminal result of one admission+spawn attempt, for one-shot callers
 *  (the CLI manual door) that must exit on real evidence. */
export type HeadlessLaunchOutcome =
  | { kind: 'launched'; run_id: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

export class AttemptNotifications {
  private readonly keys = new Set<string>();
  async once(key: string, send: () => Promise<void>): Promise<void> {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    if (this.keys.size > 1024) this.keys.delete(this.keys.values().next().value!);
    await send();
  }
}
interface Owned {
  task: HeadlessTask; role: string; agent: string; attempt: string; run?: string;
  starting?: boolean; uncertain?: boolean; rootSeen?: boolean; stopSeen?: boolean;
  intentOnly?: boolean;
  startedAt?: string;
}
export interface HeadlessRuntimeDeps {
  send(msg: Notification): Promise<void>; log(line: string): void;
  now?: () => number;
  read(task: string): Promise<ContextRecord[]>;
  /** Hub base URL for close-stop audit notes. Absent (injected test
   *  runtimes) skips the Hub publish with an explicit log line. */
  hubUrl?: string;
  /** In-lock staleness revalidation for auto launches: throws when the
   *  task's Hub state (close/approval/role/attention) or the generation
   *  marker ownership changed while the plan waited for admission. */
  revalidate?: (taskId: string, role: string, attemptId: string) => Promise<void>;
  start?: typeof startRun; stop?: typeof stopRun;
}
export interface HeadlessObservation {
  now: number; stallMs: number;
  tasks: ReadonlyMap<string, { status: string; version?: number }>;
  /** Explicitly supplied only for a successful /state?include=closed snapshot. */
  completeView?: boolean;
  degraded?: ReadonlySet<string>;
}
export class HeadlessRuntime {
  readonly store: RunStore;
  private readonly diagnostics: RepeatedDiagnostics;
  private readonly occupied = new Map<string, Owned>();
  private readonly notices = new AttemptNotifications();
  private readonly starting = new Set<Promise<void>>();
  private readonly stopping = new Set<string>();
  private initialized = false;
  private readonly known = new Set<string>();
  // Completion work must survive a Hub read failure without retaining occupancy.
  private readonly completions = new Map<string, { owned: Owned; meta: RunMeta }>();
  // Replaced seats may still need metadata recovery before completion is known.
  private readonly pendingCompletions = new Map<string, Owned>();
  private readonly silence = new Map<string, { mtime: number; since: number; alerted: boolean }>();
  knows(task: string): boolean { return this.known.has(task); }
  constructor(root: string, private readonly deps: HeadlessRuntimeDeps) {
    this.store = new RunStore(root);
    this.diagnostics = new RepeatedDiagnostics(line => this.deps.log(line), () => (this.deps.now ?? Date.now)(), undefined, undefined, diagnosticLedger(root, 'detached-runtime'));
  }
  busy(task: string): boolean { return this.occupied.has(task); }
  /** Rebuild occupancy and successful completion checks, never failures or old notes. */
  restore(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.syncNew(true);
  }
  /** Incremental ownership sync: a CLI-started managed resume is a new
   *  incomplete headless run the one-time restore could never see. Each poll
   *  picks up such runs — INCLUDING runs whose meta is not readable yet but
   *  whose PENDING startup intent already reserves the task (an uncertain
   *  handshake stays owned; close must find it) — so observe() and closeTask()
   *  cover them.
   *
   *  Seat coordination: a pending intent may take over a seat whose run
   *  has COMPLETED (the CLI legitimately admitted a new attempt between our
   *  polls; the old seat just hasn't been reaped by observe() yet) — the same
   *  poll's close then sees the CURRENT reservation. A live/unknown existing
   *  run is never overwritten. A pending intent that later becomes
   *  KNOWN-FAILED releases the seat it had adopted — pending/uncertain
   *  and other live reservations stay conservatively held. */
  syncNew(initial = false): void {
    const previousRuns = new Set([...this.occupied.values()].map(owned => owned.run));
    for (const result of this.store.readManyMetas(this.store.list())) {
      const { id } = result;
      const meta = result.kind === 'meta' ? result.meta : undefined;
      if (meta === undefined) {
        // A persisted pending headless intent keeps the reservation
        // attributable regardless of poll timing; known-failed intents
        // never occupy — and release a seat they had adopted earlier.
        try {
          const intent = this.store.readStartIntent(id);
          this.known.add(intent.task_id);
          const existing = this.occupied.get(intent.task_id);
          // Preserve this attempt's local handshake, but let another attempt
          // that already won admission replace a candidate waiting for the lock.
          if (existing?.starting && existing.attempt === intent.headless.attempt_id) continue;
          let existingMeta: RunMeta | undefined;
          if (existing?.run !== undefined) {
            try {
              const candidate = this.store.read(existing.run);
              assertOwnership(existing, candidate);
              existingMeta = candidate;
            } catch { /* Unknown is not proof that a seat can be replaced. */ }
          }
          const existingComplete = existingMeta !== undefined && complete(existingMeta);
          if (intent.startup === 'failed') {
            if (existing !== undefined && existing.run === id) {
              this.occupied.delete(intent.task_id);
              this.deps.log(`detached run ${id}: startup intent confirmed failed; releasing adopted reservation (task ${intent.task_id})`);
            }
          } else if (existing?.run !== id && (existing === undefined || existing.run === undefined || existingComplete)) {
            this.replaceSeat(intent.task_id, { task: {task_id:intent.task_id,title:intent.task_id}, role:intent.headless.role, agent:intent.headless.route.agent, attempt:intent.headless.attempt_id, run:id, uncertain:true, intentOnly:true }, existingMeta);
            this.deps.log(`detached run ${id}: adopted pending startup intent (task ${intent.task_id}, role ${intent.headless.role}${existingComplete ? ', replacing completed seat' : ''}); handshake unconfirmed; inspect tut ps`);
          }
        } catch { /* Legacy/manual incomplete run has no headless ownership. */ }
        if (initial && !this.store.isQuarantined(id)) this.deps.log(`detached run ${id}: incomplete/unreadable; inspect tut ps`);
        continue;
      }
      if (!meta.task_id || !meta.headless) continue;
      this.known.add(meta.task_id);
      if (complete(meta)) {
        this.silence.delete(id);
        // Preserve cold-start completion checks and checks for a seat replaced
        // by a managed resume before observe() can reap the previous run.
        if (initial || previousRuns.has(id)) {
          const h = meta.headless;
          this.queueCompletion({ task: { task_id: meta.task_id, title: meta.task_id },
            role: h.role, agent: h.route.agent, attempt: h.attempt_id, run: id }, meta);
        }
        continue;
      }
      const existing = this.occupied.get(meta.task_id);
      if (existing !== undefined && (existing.run === id || existing.attempt === meta.headless.attempt_id)) continue;
      // Newest incomplete run wins the seat; admission makes overlaps rare,
      //  and tut ps keeps any older incomplete run visible for diagnosis.
      if (existing === undefined || (existing.startedAt ?? '') < meta.started_at) {
        this.replaceSeat(meta.task_id, { task: {task_id:meta.task_id,title:meta.task_id}, role:meta.headless.role, agent:meta.headless.route.agent, attempt:meta.headless.attempt_id, run:id,
          rootSeen:!!meta.root_exited_at, stopSeen:!!meta.stop_request, startedAt: meta.started_at });
      }
    }
  }
  private replaceSeat(taskId: string, next: Owned, previousMeta?: RunMeta): void {
    const previous = this.occupied.get(taskId);
    if (previous?.run && previous.run !== next.run) {
      this.silence.delete(previous.run);
      if (previousMeta && complete(previousMeta)) this.queueCompletion(previous, previousMeta);
      else if (!this.completions.has(previous.run)) this.pendingCompletions.set(previous.run, previous);
    }
    this.occupied.set(taskId, next);
  }
  runs(): RunMeta[] {
    return this.store.readManyMetas(this.store.list()).flatMap(result => result.kind === 'meta' ? [result.meta] : []);
  }
  /** Positive run evidence for notes-only recovery. The persisted recovery
   * marker bounds this to one replacement, including across restarts. */
  recoverableLaunches(taskId: string, records: readonly ContextRecord[]): ReadonlySet<number> {
    const inventory = this.store.readManyMetas(this.store.list());
    if (inventory.some(result => result.kind === 'error' && this.archiveBlocksRecovery(result.id, taskId))) return new Set();
    const runs = inventory.flatMap(result => result.kind === 'meta' && result.meta.task_id === taskId ? [result.meta] : []);
    if (runs.some(meta => !complete(meta))) return new Set();
    const recovered = new Set<number>();
    for (const record of records) {
      const marker = launchMarker(record);
      if (record.task_id !== taskId || marker?.launch_mode !== 'headless' || !marker.attempt_id ||
          (record.payload.launch as { recovery_of_version?: unknown }).recovery_of_version !== undefined) continue;
      const matches = runs.filter(meta => meta.headless !== undefined && meta.headless.attempt_id === marker.attempt_id &&
        meta.headless.role === marker.role && meta.headless.base_version === marker.base_version);
      if (matches.length !== 1) continue;
      const meta = matches[0]!;
      if (meta.status !== 'exited' || !complete(meta) || meta.stop_request || meta.exit_code !== 0 || meta.exit_signal ||
          (meta.input_delivery && meta.input_delivery.status !== 'complete')) continue;
      const start = Date.parse(meta.started_at), end = Date.parse(meta.ended_at!);
      const markedAt = Date.parse(record.timestamp);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(markedAt) || markedAt > start || end < start ||
          record.version !== marker.base_version + 1) continue;
      const next = records.filter(r => r.task_id === taskId && r.version > record.version && launchMarker(r)?.role === marker.role)
        .reduce((upper, r) => Math.min(upper, r.version), Infinity);
      if (records.some(r => r.task_id === taskId && r.version > marker.base_version && r.version < next && r.role === marker.role && isDelivery(r))) continue;
      // A note from this worker during this run distinguishes a yielded turn
      // from an empty exit. Ack, other roles and post-exit notes do not count.
      if (!records.some(r => r.task_id === taskId && r.version > record.version && r.version < next &&
          r.role === marker.role && r.content_type === 'note' && r.payload.ack !== true && r.payload.launch === undefined &&
          Date.parse(r.timestamp) >= start && Date.parse(r.timestamp) <= end)) continue;
      recovered.add(record.version);
    }
    return recovered;
  }
  /** Missing meta is not always unknown occupancy: failed startup intents
   * and settled quarantine are retained audit facts, not live reservations.
   * A pending intent is relevant only to its proven task; unparseable or
   * unassignable evidence keeps the conservative recovery veto. */
  private archiveBlocksRecovery(id: string, taskId: string): boolean {
    if (this.store.isQuarantined(id)) return false;
    try {
      const intent = this.store.readStartIntent(id);
      return intent.startup !== 'failed' && intent.task_id === taskId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    try {
      const intent = this.store.readResumeIntent(id);
      if (intent.startup === 'failed') return false;
      const source = this.store.read(intent.from_run_id);
      return source.task_id === undefined || source.task_id === taskId;
    } catch { return true; }
  }
  async mark(plan: HeadlessPlan, via: LaunchVia = 'auto'): Promise<void> {
    await hubPublish(plan.hubUrl, {task_id:plan.task_id,role:'human',content_type:'note',expected_version:plan.base_version,
      payload:{summary:`launch: ${plan.role} (base v${plan.base_version})`,body:`Recorded headless launch of ${plan.role} via ${via}; attempt_id=${plan.attempt_id}.`,
        launch:{protocol_version:2,role:plan.role,base_version:plan.base_version,via,route:plan.route,route_source:plan.route_source,
          target_kind:plan.target_kind ?? 'headless-posix',target_digest:plan.target_digest,launch_mode:'headless',attempt_id:plan.attempt_id,trigger_version:plan.trigger_version,
          ...(plan.recovery_of_version === undefined ? {} : {recovery_of_version:plan.recovery_of_version})}}});
  }
  /** Reserve synchronously before detached handshake, preventing a second writer. */
  launch(plan: HeadlessPlan): void {
    if (plan.checkout_fallback === true) {
      // Anchored mode found no 工作区 declaration: the fallback is explicit,
      // auditable, and never a silent guess.
      this.deps.log(`detached checkout fallback: no 工作区 declaration in description for task ${plan.task_id}; spawn cwd stays at rig root ${plan.hubRoot}`);
    }
    const run = this.launchAttempt(plan);
    this.starting.add(run);
    void run.finally(() => this.starting.delete(run));
  }
  /** One-shot manual door (tut start-next): await the admission+spawn attempt
   *  and report its outcome, so the CLI exits on real evidence (run id, skip
   *  reason, or failure) instead of racing a detached handshake. */
  async launchAndSettle(plan: HeadlessPlan): Promise<HeadlessLaunchOutcome> {
    let outcome: HeadlessLaunchOutcome | undefined;
    const run = this.launchAttempt(plan, (found) => { outcome = found; });
    this.starting.add(run);
    try { await run; } finally { this.starting.delete(run); }
    return outcome ?? { kind: 'failed', reason: 'launch attempt ended without an outcome' };
  }
  private launchAttempt(plan: HeadlessPlan, onOutcome?: (outcome: HeadlessLaunchOutcome) => void): Promise<void> {
    const owned: Owned = { task:{task_id:plan.task_id,title:plan.title},role:plan.role,agent:plan.route.agent,attempt:plan.attempt_id,starting:true };
    this.known.add(plan.task_id);
    this.occupied.set(plan.task_id,owned);
    return this.start(plan,owned,onOutcome);
  }
  private async start(plan: HeadlessPlan, owned: Owned, onOutcome?: (outcome: HeadlessLaunchOutcome) => void): Promise<void> {
    try {
      // admission: re-verify cross-process occupancy AND freshness under
      // the rig lock before spawn. A manual resume (or any launcher) that
      // reserved first wins; a task that closed / changed role / gained
      // attention / had another attempt serve this generation while this
      // plan waited is stale and is dropped without a give-up notification.
      const id = await withAdmissionLock(this.store, async () => {
        if (this.deps.revalidate !== undefined) {
          try {
            await this.deps.revalidate(plan.task_id, plan.role, plan.attempt_id);
          } catch (e) {
            throw new AdmissionStale(`plan is stale: ${(e as Error).message}`);
          }
        }
        const taskBusy = taskOccupants(this.store, plan.task_id);
        if (taskBusy.length > 0) throw new AdmissionCovered(`task ${plan.task_id} already has incomplete run(s): ${taskBusy.map(o => o.run_id).join(', ')}`);
        const identity=plan.ownership.session_identity??plan.sessionPlan?.admission;
        if (identity?.session_id !== undefined) {
          const sessionBusy = sessionOccupants(this.store, { agent: identity.agent, session_id: identity.session_id });
          if (sessionBusy.length > 0) throw new AdmissionCovered(`session already held by: ${sessionBusy.map(o => o.run_id).join(', ')}`);
        }
        if (plan.profile&&plan.sessionRef) {
          const source=this.store.read(plan.sessionRef.source_run_id);
          if(!complete(source))throw new AdmissionStale('source completion changed before spawn');
          if(source.task_id!==plan.task_id||source.cwd!==plan.checkoutRoot||source.headless?.role!==plan.role||JSON.stringify(source.headless.route)!==JSON.stringify(plan.route))throw new AdmissionStale('source task/role/route/checkout changed before spawn');
          if(plan.sourceRun&&(source.contract!==plan.sourceRun.contract||source.headless?.contract!==plan.sourceRun.headless?.contract))throw new AdmissionStale('source contract snapshot changed before spawn');
          const selected=selectSession(plan.profile,source);
          if(selected.status!=='selected'||selected.session.session_id!==plan.sessionRef.session_id)throw new AdmissionStale('source identity changed before spawn');
          const verified=await verifySession(plan.profile,plan.sessionRef,plan.sessionReads??sessionReadServices({env:plan.env}));
          if(verified.status!=='verified')throw new AdmissionStale(`native session changed before spawn: ${'reason' in verified?verified.reason:'verification failed'}`);
        }
        return await (this.deps.start ?? startRun)(this.store,plan.argv,plan.checkoutRoot,plan.task_id,{...(plan.profile?{profile:encodeContract(plan.profile)}:{}),...(plan.invocation?{invocation:plan.invocation,input:plan.invocation.input}:{}),env:plan.env,headless:plan.ownership,...(plan.checkout !== undefined ? {checkout:plan.checkout} : {})});
      });
      owned.run = id; owned.starting = false;
      this.deps.log(`detached started task=${plan.task_id} role=${plan.role} attempt_id=${plan.attempt_id} run_id=${id}; ${plan.ownership.session_reason}; tut attach ${id}`);
      onOutcome?.({ kind: 'launched', run_id: id });
    } catch (e) {
      owned.starting = false;
      if (e instanceof AdmissionCovered || e instanceof AdmissionStale) {
        // The winner (typically a manual resume) represents the same round;
        // release only this candidate, not a winner already discovered by sync.
        if (this.occupied.get(plan.task_id) === owned) this.occupied.delete(plan.task_id);
        this.deps.log(`detached launch skipped task=${plan.task_id} role=${plan.role} attempt_id=${plan.attempt_id}: ${e.message}`);
        onOutcome?.({ kind: 'skipped', reason: e.message });
        return;
      }
      onOutcome?.({ kind: 'failed', reason: (e as Error).message });
      if (e instanceof Error && e.name === 'StartRunError' && typeof (e as StartRunError).runId === 'string' && typeof (e as StartRunError).uncertain === 'boolean') {
        owned.run = (e as StartRunError).runId; owned.uncertain = (e as StartRunError).uncertain;
      }
      else owned.uncertain = true;
      if (!owned.uncertain && this.occupied.get(plan.task_id) === owned) this.occupied.delete(plan.task_id);
      await this.report(owned,owned.uncertain ? 'startup-unconfirmed' : 'spawn-failed',undefined,(e as Error).message);
    }
  }
  async observe(options?: HeadlessObservation): Promise<{ ended: string[]; stopped: { task_id: string; requested_at: string }[] }> {
    const ended: string[] = []; const stopped: { task_id: string; requested_at: string }[] = [];
    for (const [taskId,owned] of this.occupied) {
      if (owned.starting || !owned.run) continue;
      try {
        const meta = this.store.read(owned.run);
        assertOwnership(owned, meta);
        if (meta.stop_request && !owned.stopSeen) {
          owned.stopSeen = true;
          stopped.push({ task_id: taskId, requested_at: meta.stop_request.requested_at });
        }
        const rootExited = !!meta.root_exited_at || !!meta.ended_at;
        if (rootExited && !owned.rootSeen) {
          owned.rootSeen = true;
          if (!meta.stop_request && (meta.exit_signal || (meta.exit_code !== undefined && meta.exit_code !== 0))) await this.report(owned,'root-failed',meta);
        }
        // Input delivery can settle in a later metadata transaction than exit.
        // Its failure must remain observable after the root edge was consumed.
        if (meta.input_delivery?.status==='failed') await this.report(owned,'input-failed',meta,meta.input_delivery.error);
        if (complete(meta)) {
          this.occupied.delete(taskId); ended.push(taskId);
          this.silence.delete(owned.run);
          this.queueCompletion(owned, meta);
        } else if (meta.stop_request?.result?.success === false || probe(meta.supervisor_pid) !== true) {
          this.silence.delete(owned.run);
          await this.report(owned,'run-unconfirmed',meta);
        } else if (options) {
          // A reservation is provisional, unlike a known failed/uncertain
          // launcher handshake. Matching metadata plus a live supervisor lets
          // it enter normal observation without resetting stop/root edges.
          if (owned.intentOnly && meta.status === 'running') {
            delete owned.intentOnly;
            delete owned.uncertain;
            owned.startedAt = meta.started_at;
          }
          await this.observeSilence(owned, meta, options);
        }
      } catch (e) { this.silence.delete(owned.run); await this.report(owned,'run-unconfirmed',undefined,(e as Error).message); }
    }
    await this.reconcileCompletions(options);
    return {ended,stopped};
  }
  private queueCompletion(owned: Owned, meta: RunMeta): void {
    this.pendingCompletions.delete(meta.run_id);
    if (!meta.stop_request && meta.exit_code === 0 && !meta.exit_signal && (!meta.input_delivery||meta.input_delivery.status==='complete')) this.completions.set(meta.run_id, { owned, meta });
  }
  private async reconcileCompletions(view?: HeadlessObservation): Promise<void> {
    // Absence in an incomplete/failed view proves nothing. Other observers above
    // still run, independently of completion applicability or persisted results.
    if (!view?.completeView) return;
    const applicable = (task: string) => view.tasks.has(task) && !view.degraded?.has(task);
    for (const [id, owned] of this.pendingCompletions) {
      if (!applicable(owned.task.task_id)) continue;
      try {
        const meta = this.store.read(id);
        assertOwnership(owned, meta);
        await this.diagnostics.recover(`completion-meta:${id}`);
        if (complete(meta)) this.queueCompletion(owned, meta);
      } catch (e) { await this.diagnostics.repeat(`completion-meta:${id}`, (e as Error).message, `detached completion metadata check failed run=${id}: ${(e as Error).message}`); }
    }
    const reads = new Map<string, Promise<ContextRecord[]>>();
    for (const [id, { owned, meta }] of this.completions) {
      const task = owned.task.task_id;
      if (!applicable(task)) continue;
      try {
        if (this.store.readCompletionCheck(meta)) { this.completions.delete(id); continue; }
        if (view.tasks.get(task)!.status === 'closed') {
          const version = view.tasks.get(task)!.version;
          await this.store.claimCompletionCheck(meta, { outcome: 'ignored-closed', ...(version !== undefined ? { evidence_version: version } : {}) });
          this.completions.delete(id);
          await this.diagnostics.recover(`completion-result:${id}`);
          continue;
        }
      } catch (e) {
        await this.diagnostics.repeat(`completion-result:${id}`, (e as Error).message, `detached completion result check failed run=${id}: ${(e as Error).message}`);
        continue;
      }
      let records: ContextRecord[];
      try {
        if (!reads.has(task)) reads.set(task, this.deps.read(task));
        records = await reads.get(task)!;
        await this.diagnostics.recover(`completion-context:${task}:${id}`);
      } catch (e) {
        if (!(e instanceof HubError && e.code === 'TASK_NOT_FOUND')) {
          await this.diagnostics.repeat(`completion-context:${task}:${id}`, (e as Error).message, `detached completion context check failed task=${task} run_id=${id}: ${(e as Error).message}`);
        }
        continue;
      }
      try {
        const base = meta.headless!.base_version;
        const next = records.filter(r => r.task_id === task && r.version > base && launchMarker(r)?.role === owned.role && launchMarker(r)!.base_version > base)
          .reduce((upper, r) => Math.min(upper, launchMarker(r)!.base_version), Infinity);
        const delivery = records.find(r => r.task_id === task && r.version > base && r.version <= next && r.role === owned.role && isDelivery(r));
        const closed = effectiveCloseDecisionVersion(records.filter(r => r.task_id === task));
        const outcome = closed !== undefined ? 'ignored-closed' : delivery ? 'delivered' : 'missing-delivery-notification-reserved';
        const claimed = await this.store.claimCompletionCheck(meta, { outcome,
          evidence_version: records.reduce((max, r) => r.task_id === task ? Math.max(max, r.version) : max, 0),
          ...(outcome === 'delivered' ? { delivery_version: delivery!.version } : {}) });
        await this.diagnostics.recover(`completion-result:${id}`);
        this.completions.delete(id);
        if (claimed && outcome === 'missing-delivery-notification-reserved') await this.report(owned, 'stopped-without-publish', meta);
      } catch (e) { await this.diagnostics.repeat(`completion-result:${id}`, (e as Error).message, `detached completion result check failed run=${id}: ${(e as Error).message}`); }
    }
  }
  private async observeSilence(owned: Owned, meta: RunMeta, options: { now: number; stallMs: number; tasks: ReadonlyMap<string, { status: string }> }): Promise<void> {
    const id = meta.run_id;
    if (owned.uncertain || meta.status !== 'running' || meta.root_exited_at || meta.ended_at || meta.stop_request ||
        !options.tasks.has(owned.task.task_id) || options.tasks.get(owned.task.task_id)!.status === 'closed') {
      this.silence.delete(id); return;
    }
    try {
      const { mtimeMs } = this.store.logInfo(id);
      await this.diagnostics.recover(`log-info:${id}`);
      const previous = this.silence.get(id);
      if (!previous || previous.mtime !== mtimeMs || options.now < previous.since) {
        this.silence.set(id, { mtime: mtimeMs, since: options.now, alerted: false }); return;
      }
      if (previous.alerted || options.now - previous.since < options.stallMs) return;
      previous.alerted = true; // Reserve the edge before any async send, including failures.
      const body = `task_id=${owned.task.task_id}; role=${owned.role}; attempt_id=${owned.attempt}; run_id=${id}; reason=suspected-blocked/silent; log mtime unchanged for ${options.now - previous.since}ms; long silence may mean thinking or waiting, not confirmed blocked; observed_at=${new Date(options.now).toISOString()}; inspect tut ps / tut attach ${id}`;
      this.deps.log(body);
      try { await this.deps.send({ title: `TUT ${owned.task.task_id}: detached silent`, body, task_id: owned.task.task_id }); }
      catch (e) { this.deps.log(`detached silence notification failed: ${(e as Error).message}`); }
    } catch (e) {
      this.silence.delete(id);
      await this.diagnostics.repeat(`log-info:${id}`, (e as Error).message, `detached log observation failed run_id=${id}: ${(e as Error).message}`);
    }
  }
  /** True consumes the interval; false defers until run evidence is complete. */
  async reconcileDeliveries(task: string, records: ContextRecord[], lower: number, upper: number, now: number): Promise<boolean> {
    if (!this.knows(task)) return true;
    if (this.busy(task)) return false;
    const deliveries = records.filter(r => r.task_id === task && r.version > lower && r.version <= upper && isDelivery(r));
    if (!deliveries.length) return true;
    // Refresh only on a delivery edge. A failed/incomplete inventory is unknown,
    // never proof of absence (including a lost startup handshake).
    const runs: RunMeta[] = [];
    let inventory;
    try {
      // Keep normal inventory on the batch transport. Only failed slots
      // need the separate repair-disposition check below.
      inventory = this.store.readManyMetas(this.store.list());
    } catch (e) {
      await this.diagnostics.repeat('delivery-inventory', (e as Error).message, `detached delivery observation unknown: ${(e as Error).message}`);
      throw e;
    }
    await this.diagnostics.recover('delivery-inventory');
    let failure: unknown;
    for (const result of inventory) {
      const scope = `delivery-inventory:${result.id}`;
      if (result.kind === 'error') {
        if (this.store.isQuarantined(result.id)) continue;
        // Inventory is rig-wide. An unreadable run cannot be attributed to
        // the task whose delivery happened to trigger this scan.
        await this.diagnostics.repeat(scope, (result.error as Error).message, `detached delivery observation unknown run_id=${result.id}: ${(result.error as Error).message}`);
        failure ??= result.error;
      } else {
        await this.diagnostics.recover(scope);
        if (result.meta.task_id === task && result.meta.headless) runs.push(result.meta);
      }
    }
    if (failure !== undefined) throw failure; // Retain the delivery interval.
    if (runs.some(m => !complete(m))) return false;
    for (const record of deliveries) {
      // An unparseable newer marker is an unknown round, not permission to
      // attribute a legacy/TUI delivery to an older headless attempt.
      const preceding = records.filter(r => r.task_id === task && r.version < record.version && r.content_type === 'note' && r.payload.launch !== undefined)
        .sort((a,b) => b.version - a.version)[0];
      const marker = preceding && launchMarker(preceding);
      if (!marker || marker.launch_mode !== 'headless' || marker.role !== record.role) continue;
      const ownedRun = runs.find(m => m.headless!.attempt_id === marker.attempt_id && m.headless!.role === marker.role && m.headless!.base_version === marker.base_version);
      if (!ownedRun) continue;
      const at = Date.parse(record.timestamp);
      const intervals = runs.map(m => ({ start: Date.parse(m.started_at), end: Date.parse(m.ended_at!) }));
      if (!Number.isFinite(at) || at > now || !Number.isFinite(Date.parse(preceding!.timestamp)) || at < Date.parse(preceding!.timestamp) || intervals.some(i => !Number.isFinite(i.start) || !Number.isFinite(i.end) || i.end < i.start) || at < Date.parse(ownedRun.started_at)) {
        await this.diagnostics.repeat(`delivery-timeline:${task}:${record.version}`, ownedRun.run_id, `detached delivery observation unknown task=${task} version=${record.version} run_id=${ownedRun.run_id}: inconsistent timeline`); continue;
      }
      await this.diagnostics.recover(`delivery-timeline:${task}:${record.version}`);
      if (intervals.some(i => i.start <= at && at <= i.end)) continue;
      try {
        await this.notices.once(`ghost:${task}:${record.version}`, async () => {
          const body = `task_id=${task}; role=${record.role}; version=${record.version}; attempt_id=${marker.attempt_id}; run_id=${ownedRun.run_id}; reason=ghost-delivery; record_at=${record.timestamp}; observed_at=${new Date(now).toISOString()}; no owned run covers the delivery timestamp (round ended_at=${ownedRun.ended_at}); inspect tut read ${task} / tut ps / tut attach ${ownedRun.run_id}`;
          if (await this.diagnostics.claim(`ghost:${task}:${record.version}`, 'ghost-delivery', body)) {
            this.deps.log(body);
          }
        });
      } catch (e) { this.deps.log(`detached delivery notification failed: ${(e as Error).message}`); }
    }
    return true;
  }
  closeTask(taskId: string, closeVersion?: number): void {
    const atClose = this.occupied.get(taskId);
    if (!atClose || this.stopping.has(taskId)) return;
    this.stopping.add(taskId);
    // A close arriving during startup waits for that very handshake, outside
    // the compare queue, then uses only the cooperative stop protocol.
    // the consumption is audited to the closed task (best-effort, deduped
    // by audit_id; failures logged, never retried blind, never rollback).
    void (async () => {
      await Promise.all([...this.starting]);
      // A queued local candidate may have yielded admission to a CLI run.
      // Consume that current reservation, not the candidate captured at close.
      try { this.syncNew(); }
      catch (e) { this.deps.log(`detached close ${taskId}: ownership sync failed (${(e as Error).message}); using known reservation`); }
      const owned = this.occupied.get(taskId) ?? atClose;
      const base: CloseStopAuditInput = { task_id: taskId, ...(closeVersion !== undefined ? { close_version: closeVersion } : {}),
        ...(owned.run !== undefined ? { run: { run_id: owned.run, attempt_id: owned.attempt } } : {}) };
      if (!owned.run) {
        this.deps.log(`detached close ${taskId}: startup unconfirmed`);
        await this.auditCloseStop({ ...base, failure: 'startup unconfirmed: no run id at close time' });
        return;
      }
      try {
        const result = await (this.deps.stop ?? stopRun)(this.store,owned.run);
        this.deps.log(`detached close ${taskId} run_id=${owned.run}: ${result.result}`);
        const meta = result.meta;
        const stop = meta.stop_request;
        await this.auditCloseStop({
          ...base,
          meta,
          stop: {
            requested: result.requested,
            success: result.success,
            result: result.result,
            ...(stop !== undefined && stop.id !== undefined ? { request_id: stop.id } : {}),
            ...(stop !== undefined && stop.requested_at !== undefined ? { requested_at: stop.requested_at } : {}),
            ...(stop?.result?.completed_at !== undefined ? { completed_at: stop.result.completed_at } : {}),
            ...(stop !== undefined ? { phase: stop.phase } : {}),
            ...(stop?.result?.outcome !== undefined ? { outcome: stop.result.outcome } : {}),
          },
        });
      } catch (e) {
        this.deps.log(`detached close ${taskId}: ${(e as Error).message}; inspect tut ps / tut attach ${owned.run}`);
        await this.auditCloseStop({ ...base, failure: `stop attempt failed: ${(e as Error).message}` });
      }
    })().finally(() => this.stopping.delete(taskId));
  }
  /** Best-effort close-stop audit: confirm the close version from the log,
   *  dedup by audit_id, publish once, log the outcome. */
  private async auditCloseStop(input: CloseStopAuditInput): Promise<void> {
    if (this.deps.hubUrl === undefined) {
      this.deps.log(`close-stop audit ${input.task_id}: no hub URL configured on this runtime; audit skipped`);
      return;
    }
    let records: ContextRecord[] = [];
    try {
      records = await this.deps.read(input.task_id);
      if (input.close_version === undefined) {
        const confirmed = effectiveCloseDecisionVersion(records);
        if (confirmed !== undefined) input = { ...input, close_version: confirmed };
      }
    } catch (e) {
      this.deps.log(`close-stop audit ${input.task_id}: task log unreadable (${(e as Error).message}); close version unconfirmed`);
    }
    const auditId = closeStopAuditId(input);
    if (hasCloseStopAudit(records, auditId)) {
      this.deps.log(`close-stop audit ${input.task_id}: ${auditId} already recorded; skipping duplicate`);
      return;
    }
    try {
      const outcome = await publishCloseStopAudit(this.deps.hubUrl, input, records);
      this.deps.log(outcome.skipped
        ? `close-stop audit ${input.task_id}: ${auditId} already recorded`
        : `close-stop audit ${input.task_id} recorded at v${outcome.version} (${auditId})`);
    } catch (e) {
      this.deps.log(`close-stop audit ${input.task_id} unconfirmed (Hub error: ${(e as Error).message}); stop outcome above stands, audit not retried`);
    }
  }
  private async report(owned: Owned, reason: string, meta?: RunMeta, detail?: string): Promise<void> {
    const diagnostic = reason === 'run-unconfirmed' || reason === 'stopped-without-publish';
    // Failure key is shared by spawn/error/root observations of one attempt.
    const key = `headless:${owned.attempt}:${diagnostic ? reason : 'give-up'}`;
    try {
      await this.notices.once(key,async () => {
        const body = `${owned.task.title}; task_id=${owned.task.task_id}; role=${owned.role}; agent=${owned.agent}; attempt_id=${owned.attempt}; reason=${reason}; received_at=${new Date().toISOString()}${owned.run ? `; run_id=${owned.run}` : ''}${meta?.exit_code !== undefined ? `; exit_code=${meta.exit_code}` : ''}${meta?.exit_signal ? `; signal=${meta.exit_signal}` : ''}${detail ? `; ${detail}` : ''}; inspect tut ps / tut attach${owned.run ? ` ${owned.run}` : ''} and task context; explicitly wake after resolving.`;
        if (diagnostic) {
          if (await this.diagnostics.claim(key, reason, body)) this.deps.log(body);
          return;
        }
        this.deps.log(body);
        await this.deps.send({title:`TUT ${owned.task.task_id}: detached give-up`,body,task_id:owned.task.task_id});
      });
    } catch (e) { this.deps.log(`detached notification failed attempt_id=${owned.attempt}: ${(e as Error).message}`); }
  }
}
export { complete };

function assertOwnership(owned: Owned, meta: RunMeta): void {
  if (meta.run_id !== owned.run || meta.task_id !== owned.task.task_id || meta.headless?.attempt_id !== owned.attempt ||
      meta.headless.role !== owned.role || meta.headless.route.agent !== owned.agent) throw new Error('ownership identity changed');
}

class AdmissionCovered extends Error {
  constructor(message: string) { super(message); this.name = 'AdmissionCovered'; }
}
class AdmissionStale extends Error {
  constructor(message: string) { super(message); this.name = 'AdmissionStale'; }
}

function isDelivery(record: ContextRecord): boolean {
  return ['architect', 'executor', 'reviewer'].includes(record.role) && ['design', 'code_changes', 'revision', 'review'].includes(record.content_type);
}
interface ObservationMarker { role: string; base_version: number; launch_mode?: string; attempt_id?: string }
function launchMarker(record: ContextRecord): ObservationMarker | undefined {
  if (record.content_type !== 'note') return;
  const m = record.payload.launch as Partial<ObservationMarker> | undefined;
  if (!m || !['architect','executor','reviewer'].includes(m.role ?? '') || !Number.isSafeInteger(m.base_version) || m.base_version! < 0 || m.base_version! >= record.version) return;
  return m as ObservationMarker;
}

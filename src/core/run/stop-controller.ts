import { RunStore, probe, type RunMeta } from './store.js';
import { assertRunIdentity } from './validation.js';
import { STOP_SCOPE, type RootExit, type StopOutcome, type SignalAttempt } from './protocol.js';

export interface ControllerOptions {
  cooperativeMs?: number; graceMs?: number; verifyMs?: number;
  now?: () => number; kill?: typeof process.kill;
}
/** Owned only by the original supervisor and its actual ChildProcess lifecycle.
 * Each step is bounded IO; no metadata lock spans a signal wait. */
export class StopController {
  private readonly now: () => number;
  private readonly kill: typeof process.kill;
  private requestId: string | undefined;
  private deadline = 0;
  constructor(private readonly store: RunStore, private readonly initial: RunMeta,
    private readonly rootExit: () => RootExit | undefined, private readonly options: ControllerOptions = {}) {
    this.now = options.now ?? (() => performance.now()); this.kill = options.kill ?? process.kill;
  }
  private read(): RunMeta { const m = this.store.read(this.initial.run_id); assertRunIdentity(m, this.initial); return m; }
  private async update(fn: (m: RunMeta) => RunMeta): Promise<RunMeta> {
    return this.store.updateMeta(this.initial.run_id, m => {
      assertRunIdentity(m, this.initial);
      if (m.stop_request?.id !== this.requestId) throw new Error('stop request identity changed');
      return fn(m);
    });
  }
  private async finish(outcome: StopOutcome, error?: string): Promise<void> {
    const exit = this.rootExit(); const alive = probe(-this.initial.pgid, this.kill);
    const success = outcome !== 'incomplete' && exit !== undefined && alive === false;
    if (!success) outcome = 'incomplete';
    const completed_at = new Date().toISOString();
    await this.update(m => ({ ...m, ...(success ? { ended_at: completed_at } : {}),
      ...(exit?.code !== null && exit?.code !== undefined ? { exit_code: exit.code } : {}), ...(exit?.signal ? { exit_signal: exit.signal } : {}),
      stop_request: { ...m.stop_request!, phase: success ? 'completed' : 'incomplete', result: {
        outcome, success, completed_at, root_exited: exit !== undefined, group_alive: alive,
        ...(exit?.code !== null && exit?.code !== undefined ? { exit_code: exit.code } : {}), ...(exit?.signal ? { exit_signal: exit.signal } : {}),
        scope: STOP_SCOPE, descendants_check: 'not-performed', ...(error ? { error } : {}),
      } },
    }));
  }
  private async send(signal: SignalAttempt['signal']): Promise<boolean> {
    const m = this.read();
    if (m.stop_request?.result) return false;
    if (signal === 'SIGINT' && this.rootExit()) return false;
    const alive = probe(-this.initial.pgid, this.kill);
    if (alive === null) throw new Error('process group liveness unknown before signal');
    if (alive === false) return false;
    const target = signal === 'SIGINT' ? this.initial.pid : -this.initial.pgid;
    const attempt: SignalAttempt = { signal, target, intended_at: new Date().toISOString(), delivery: 'uncertain' };
    await this.update(m => ({ ...m, stop_request: { ...m.stop_request!, signals: [...m.stop_request!.signals, attempt] } }));
    // Re-check actual child exit after the intent write: never signal a dead
    // root's reused positive PID. An intent without syscall evidence stays uncertain.
    this.read();
    if (signal === 'SIGINT' && this.rootExit()) return false;
    const group = probe(-this.initial.pgid, this.kill);
    if (group === null) throw new Error('process group liveness unknown after intent');
    if (group === false) return false;
    let error: Error | undefined;
    try { this.kill(target, signal); attempt.delivery = 'sent'; attempt.sent_at = new Date().toISOString(); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') attempt.delivery = 'esrch';
      else { error = e as Error; attempt.delivery = 'error'; attempt.error = error.message; }
    }
    // Deadlines are monotonic, measured from the syscall, not subsequent disk IO.
    this.deadline = this.now() + (signal === 'SIGINT' ? this.options.cooperativeMs ?? 5000 : signal === 'SIGTERM' ? this.options.graceMs ?? 5000 : this.options.verifyMs ?? 2000);
    await this.update(m => ({ ...m, stop_request: { ...m.stop_request!, signals: m.stop_request!.signals.map(a => a.signal === signal ? attempt : a) } }));
    if (error) throw error;
    return true;
  }
  private async enter(phase: 'cooperative' | 'term' | 'kill', reason?: 'leader-already-exited'): Promise<void> {
    this.deadline = this.now() + (phase === 'cooperative' ? this.options.cooperativeMs ?? 5000 : phase === 'term' ? this.options.graceMs ?? 5000 : this.options.verifyMs ?? 2000);
    await this.update(m => ({ ...m, stop_request: { ...m.stop_request!, phase, accepted_at: m.stop_request!.accepted_at ?? new Date().toISOString(), ...(reason ? { reason } : {}) } }));
    await this.send(phase === 'cooperative' ? 'SIGINT' : phase === 'term' ? 'SIGTERM' : 'SIGKILL');
  }
  async step(): Promise<void> {
    const current = this.read(); const request = current.stop_request;
    if (!request || request.result) return;
    if (this.requestId === undefined) {
      this.requestId = request.id;
      if (request.phase !== 'requested') { await this.finish('incomplete', 'uncertain previous control phase; not replayed'); return; }
      const group = probe(-this.initial.pgid, this.kill);
      if (group === null) { await this.finish('incomplete', 'process group liveness unknown'); return; }
      if (this.rootExit() && group === false) { await this.finish('already-ended'); return; }
      if (this.rootExit()) await this.enter('term', 'leader-already-exited');
      else await this.enter('cooperative');
      return;
    }
    if (request.id !== this.requestId) throw new Error('stop request identity changed');
    const group = probe(-this.initial.pgid, this.kill);
    if (group === null) { await this.finish('incomplete', 'process group liveness unknown'); return; }
    if (this.rootExit() && group === false) {
      const sent = request.signals.filter(s => s.delivery === 'sent');
      await this.finish(sent.some(s => s.signal === 'SIGKILL') ? 'forced-kill' : sent.some(s => s.signal === 'SIGTERM') ? 'forced-term' : sent.some(s => s.signal === 'SIGINT') ? 'cooperative' : 'already-ended');
      return;
    }
    if (this.now() < this.deadline) return;
    if (group === false) { await this.finish('incomplete', 'group absent but actual root exit unconfirmed'); return; }
    if (request.phase === 'cooperative') await this.enter('term');
    else if (request.phase === 'term') await this.enter('kill');
    else await this.finish('incomplete', 'process group still present after SIGKILL budget');
  }
  /** A write/signal failure never becomes success. If this write also fails,
   * the supervisor exits with on-disk uncertain intent and a log diagnostic. */
  async fail(error: Error): Promise<void> {
    const m = this.read(); if (!m.stop_request || m.stop_request.result) return;
    this.requestId = m.stop_request.id; await this.finish('incomplete', error.message);
  }
}

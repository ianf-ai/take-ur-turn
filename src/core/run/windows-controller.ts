import { RunStore } from './store.js';
import { assertRunIdentity } from './validation.js';
import { WINDOWS_ACTIONS, WINDOWS_SCOPE, windowsMeta, type WindowsRunMeta, type WindowsObservation, type WindowsReceipt, type WindowsAction, type WindowsStopResult } from './windows-protocol.js';
export interface WindowsBroker {
    readonly nextSeq: number;
    observe(): Promise<WindowsObservation>;
    action(action: WindowsAction, operation: string): Promise<WindowsReceipt>;
}
/** One live supervisor owns this instance. No restart can reconstruct its authority. */
export class WindowsStopController {
    private active: Promise<void> | undefined;
    private requestId: string | undefined;
    private deadline = 0;
    constructor(private store: RunStore, private initial: WindowsRunMeta, private broker: WindowsBroker, private options: {
        now?: () => number;
        budgets?: [
            number,
            number,
            number
        ];
    } = {}) { }
    private now(): number { return this.options.now?.() ?? performance.now(); }
    private read(): WindowsRunMeta { const m = windowsMeta(this.store.read(this.initial.run_id)); assertRunIdentity(m, this.initial); return m; }
    private update(fn: (m: WindowsRunMeta) => WindowsRunMeta): Promise<WindowsRunMeta> {
        return this.store.updateMeta(this.initial.run_id, value => {
            const m = windowsMeta(value);
            assertRunIdentity(m, this.initial);
            if (m.stop_request?.id !== this.requestId)
                throw new Error('stop request identity changed');
            return fn(m);
        }).then(windowsMeta);
    }
    /** Concurrent close/stop/poll callers share the same in-flight step. */
    step(): Promise<void> {
        return this.active ??= this.advance().catch(async (e) => { await this.fail(e as Error); }).finally(() => { this.active = undefined; });
    }
    private async finish(outcome: WindowsStopResult['outcome'], observation?: WindowsObservation, error?: string): Promise<void> {
        const completed_at = new Date().toISOString();
        const success = outcome !== 'incomplete' && observation?.root_exited === true && observation.job_empty;
        await this.update(m => ({ ...m, ...(success ? { ended_at: completed_at } : {}),
            ...(observation?.exit_code !== undefined ? { exit_code: observation.exit_code } : {}),
            windows: { ...m.windows, ...(error ? { error } : {}) },
            stop_request: { ...m.stop_request!, phase: success ? 'completed' : 'incomplete', result: {
                    outcome: success ? outcome : 'incomplete', success, completed_at,
                    root_exited: observation?.root_exited ?? false, group_alive: observation ? !observation.job_empty : null,
                    scope: WINDOWS_SCOPE, descendants_check: 'job-members-only', ...(error ? { error } : {}),
                    ...(observation?.exit_code !== undefined ? { exit_code: observation.exit_code } : {}),
                } },
        }));
    }
    async fail(error: Error): Promise<void> {
        const m = this.read();
        if (!m.stop_request || m.stop_request.result)
            return;
        this.requestId = m.stop_request.id;
        // Never turn a lost receipt into success, even if a subsequent probe appears empty.
        await this.finish('incomplete', undefined, error.message);
    }
    private async advance(): Promise<void> {
        const m = this.read();
        const r = m.stop_request;
        if (!r || r.result)
            return;
        if (!this.requestId) {
            this.requestId = r.id;
            if (r.phase !== 'requested' || r.actions.length)
                throw new Error('delivery-uncertain: previous intent is not replayed');
        }
        if (r.id !== this.requestId)
            throw new Error('stop request identity changed');
        if (r.actions.some(a => a.delivery !== 'sent'))
            throw new Error('delivery-uncertain: action receipt missing');
        const observation = await this.broker.observe();
        if (observation.root_exited && observation.job_empty) {
            const delivered = r.actions.filter(a => a.receipt?.targets.length).at(-1)?.action;
            await this.finish(delivered === 'taskkill-tree-force' ? 'forced-kill' : delivered === 'taskkill-tree' ? 'forced-term' : delivered === 'break' ? 'forced-break' : 'already-ended', observation);
            return;
        }
        if (r.actions.length && this.now() < this.deadline)
            return;
        if (r.actions.length === 3) {
            await this.finish('incomplete', observation, 'owned Job still present after force budget');
            return;
        }
        const index = r.actions.length;
        const action = WINDOWS_ACTIONS[index]!;
        const seq = this.broker.nextSeq;
        await this.update(m => {
            if (m.stop_request!.actions.length !== index)
                throw new Error('Windows action sequence changed');
            return { ...m, stop_request: { ...m.stop_request!, accepted_at: m.stop_request!.accepted_at ?? new Date().toISOString(),
                    phase: (['cooperative', 'term', 'kill'] as const)[index]!,
                    actions: [...m.stop_request!.actions, { action, seq, operation: r.id, intended_at: new Date().toISOString(), delivery: 'uncertain' }] } };
        });
        const start = this.now();
        const receipt = await this.broker.action(action, r.id);
        this.deadline = this.now() + (this.options.budgets ?? [5000, 5000, 2000])[index]!;
        await this.update(m => ({ ...m, stop_request: { ...m.stop_request!, actions: m.stop_request!.actions.map(a => a.seq === seq ? {
                    ...a, delivery: 'sent', receipt, elapsed_ms: Math.max(0, this.now() - start),
                } : a) } }));
    }
}

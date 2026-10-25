import type { RunMeta } from './store.js';
export const WINDOWS_PROTOCOL = 'windows-console-v1';
export const WINDOWS_SCOPE = 'root-and-owned-job';
export const WINDOWS_ACTIONS = ['break', 'taskkill-tree', 'taskkill-tree-force'] as const;
export type WindowsAction = typeof WINDOWS_ACTIONS[number];
export interface WindowsIdentity {
    attempt_id: string;
    broker_pid: number;
    broker_creation_time: string;
    root_creation_time: string;
    job_id: string;
}
export interface BrokerBinding {
    protocol: typeof WINDOWS_PROTOCOL;
    run_id: string;
    attempt_id: string;
    broker_pid: number;
    broker_creation_time: string;
    nonce: string;
}
export interface WindowsObservation {
    root_exited: boolean;
    job_empty: boolean;
    exit_code?: number;
}
export interface WindowsReceipt {
    targets: {
        pid: number;
        creation_time: string;
        return_code: number;
    }[];
}
export interface WindowsActionAttempt {
    action: WindowsAction;
    seq: number;
    operation: string;
    intended_at: string;
    delivery: 'uncertain' | 'sent' | 'error';
    elapsed_ms?: number;
    receipt?: WindowsReceipt;
    error?: string;
}
export interface WindowsState {
    identity: WindowsIdentity;
    observation?: WindowsObservation & {
        observed_at: string;
    };
    error?: string;
}
export interface WindowsStopResult {
    outcome: 'forced-break' | 'forced-term' | 'forced-kill' | 'already-ended' | 'incomplete';
    success: boolean;
    completed_at: string;
    root_exited: boolean;
    group_alive: boolean | null;
    scope: typeof WINDOWS_SCOPE;
    descendants_check: 'job-members-only';
    exit_code?: number;
    error?: string;
}
export interface WindowsStopRequest {
    id: string;
    requested_at: string;
    requested_by: string;
    phase: 'requested' | 'cooperative' | 'term' | 'kill' | 'completed' | 'incomplete';
    accepted_at?: string;
    signals: [];
    actions: WindowsActionAttempt[];
    result?: WindowsStopResult;
}
export interface WindowsRunMeta extends RunMeta {
    control_protocol: typeof WINDOWS_PROTOCOL;
    windows: WindowsState;
    stop_request?: WindowsStopRequest;
}
export function windowsMeta(m: RunMeta): WindowsRunMeta {
    if (m.control_protocol !== WINDOWS_PROTOCOL)
        throw new Error('unsupported Windows control protocol');
    return m as WindowsRunMeta;
}
const date = (s: unknown): boolean => typeof s === 'string' && Number.isFinite(Date.parse(s));
const nativeTime = (s: unknown): boolean => typeof s === 'string' && /^\d+$/.test(s);
const exitCode = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 0xffffffff;
const hex = (s: unknown): boolean => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
export function validateWindowsMeta(meta: RunMeta): void {
    const m = windowsMeta(meta);
    const w = m.windows;
    const i = w?.identity;
    if (!i || typeof i.attempt_id !== 'string' || !i.attempt_id || !Number.isSafeInteger(i.broker_pid) || i.broker_pid <= 1 || i.broker_pid === m.pid ||
        !nativeTime(i.broker_creation_time) || !nativeTime(i.root_creation_time) || !hex(i.job_id))
        throw new Error('invalid Windows identity');
    if (w.observation && (!date(w.observation.observed_at) || typeof w.observation.root_exited !== 'boolean' || typeof w.observation.job_empty !== 'boolean' || (w.observation.exit_code !== undefined && !exitCode(w.observation.exit_code))))
        throw new Error('invalid Windows observation');
    const r = m.stop_request;
    if (!r)
        return;
    if (!hex(r.id) || !date(r.requested_at) || !r.requested_by || r.requested_at !== m.stopped_at || r.requested_by !== m.stopped_by || m.status !== 'stopped' ||
        !['requested', 'cooperative', 'term', 'kill', 'completed', 'incomplete'].includes(r.phase) || !Array.isArray(r.signals) || r.signals.length || !Array.isArray(r.actions) || r.actions.length > 3)
        throw new Error('invalid Windows stop request');
    let seq = 0;
    for (const [index, a] of r.actions.entries()) {
        if (a.action !== WINDOWS_ACTIONS[index] || !Number.isSafeInteger(a.seq) || a.seq <= seq || a.operation !== r.id || !date(a.intended_at) ||
            !['uncertain', 'sent', 'error'].includes(a.delivery) || (a.delivery === 'sent' && !a.receipt) || (a.elapsed_ms !== undefined && (!Number.isFinite(a.elapsed_ms) || a.elapsed_ms < 0)))
            throw new Error('invalid Windows action evidence');
        if (a.receipt && (!Array.isArray(a.receipt.targets) || a.receipt.targets.some(t => !Number.isSafeInteger(t.pid) || t.pid <= 1 || !nativeTime(t.creation_time) || !Number.isSafeInteger(t.return_code))))
            throw new Error('invalid Windows native receipt');
        seq = a.seq;
    }
    const result = r.result;
    if (result) {
        if (!['forced-break', 'forced-term', 'forced-kill', 'already-ended', 'incomplete'].includes(result.outcome) || typeof result.success !== 'boolean' ||
            !date(result.completed_at) || result.scope !== WINDOWS_SCOPE || result.descendants_check !== 'job-members-only' ||
            typeof result.root_exited !== 'boolean' || ![true, false, null].includes(result.group_alive) || result.success !== (result.outcome !== 'incomplete') ||
            (result.success && (!m.ended_at || !result.root_exited || result.group_alive !== false || r.phase !== 'completed' || r.actions.some(a => a.delivery !== 'sent'))) ||
            (!result.success && r.phase !== 'incomplete'))
            throw new Error('invalid Windows stop result');
    }
    else if (r.phase === 'completed' || r.phase === 'incomplete')
        throw new Error('Windows terminal phase without result');
}

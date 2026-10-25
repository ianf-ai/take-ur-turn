/** Additive on-disk control protocol. No process-table/descendant observation. */
export const CONTROL_PROTOCOL = 'cooperative-v1';
export const STOP_SCOPE = 'root-and-original-group';
export interface RootExit { code: number | null; signal: NodeJS.Signals | null }
export type StopOutcome = 'cooperative' | 'forced-break' | 'forced-term' | 'forced-kill' | 'already-ended' | 'incomplete';
export interface SignalAttempt {
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'; target: number; intended_at: string;
  delivery: 'uncertain' | 'sent' | 'esrch' | 'error'; sent_at?: string; error?: string;
}
export interface PersistedStopResult {
  outcome: StopOutcome; success: boolean; completed_at: string;
  root_exited: boolean; group_alive: boolean | null; exit_code?: number; exit_signal?: string;
  scope: typeof STOP_SCOPE | 'root-and-owned-job'; descendants_check: 'not-performed' | 'job-members-only'; error?: string;
}
export interface StopRequest {
  id: string; requested_at: string; requested_by: string;
  phase: 'requested' | 'cooperative' | 'term' | 'kill' | 'completed' | 'incomplete';
  accepted_at?: string; reason?: 'leader-already-exited';
  signals: SignalAttempt[]; result?: PersistedStopResult;
}

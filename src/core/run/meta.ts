/** Shared persisted metadata; independent of storage and protocol validation. */
import type { StopRequest } from './protocol.js';

export interface HeadlessOwnership {
  contract?:string;
  session_identity?:{agent:string;session_id:string};
  schema: 1; role: string; attempt_id: string; base_version: number; trigger_version: number;
  route: { agent: string; args: string[] }; route_source: string;
  resume_from_run_id?: string; designated_session_id?: string; session_reason: string;
}

export interface HeadlessStartIntent { task_id: string; headless: HeadlessOwnership; cwd: string; startup: "pending" | "failed" }

/** Provenance of a resumed run: which run it continues, which native session
 *  identity was used, and who asked. Additive; never process authority. */
export interface ResumeSource {
  schema: 1; from_run_id: string; agent: string; session_id: string;
  identity: 'observed' | 'designated' | 'argv';
  requested_at: string; requested_by: string; task_id?: string;
}

/** Persisted before the resumed process is spawned: an uncertain handshake
 *  stays attributable to its session identity. */
export interface ResumeStartIntent { contract?:string|null; schema: 1; from_run_id: string; agent: string; session_id: string; cwd: string; startup: 'pending' | 'failed' }

export interface RunMeta {
  contract?:string|null;
  [key: string]: unknown;
  run_id: string; task_id?: string; pid: number; pgid: number; argv: string[];
  started_at: string; status: 'running' | 'stopped' | 'exited';
  supervisor_pid: number; cwd: string;
  /** Anchored checkout landing point validated from the 工作区 declaration (additive). */
  checkout?: string;
  headless?: HeadlessOwnership; root_exited_at?: string;
  input_delivery?: import('./input-types.js').InputDelivery;
  agent_session_id?: string; exit_code?: number; exit_signal?: string; ended_at?: string;
  stopped_by?: string; stopped_at?: string;
  identity_probe?: string; identity_ack?: string;
  control_protocol?: string; stop_request?: StopRequest;
  windows?: WindowsState;
  resume?: ResumeSource;
}

export interface WindowsIdentity {
    attempt_id: string;
    broker_pid: number;
    broker_creation_time: string;
    root_creation_time: string;
    job_id: string;
}

export interface WindowsObservation {
    input_delivery?: import('./input-types.js').InputDelivery;
    root_exited: boolean;
    job_empty: boolean;
    exit_code?: number;
}

export interface WindowsState {
    identity: WindowsIdentity;
    observation?: WindowsObservation & {
        observed_at: string;
    };
    error?: string;
}

/** Shared session facts; no public-facade back edge. */
import type {ExactSessionRef} from './runtime-contract.js';
export type Invalid={status:'invalid';code:string;reason:string};
export type Unavailable={status:'unavailable';reason:string};
export interface PriorRunView {contract?:string|null;resume?:{agent:string;session_id:string};run_id:string;task_id?:string;cwd:string;argv:string[];agent_session_id?:string;headless?:{contract?:string;session_identity?:{agent:string;session_id:string};role:string;route:{agent:string;args:string[]};designated_session_id?:string;windows?:{target?:{agent:string};pi_session?:import('./runtime-contract.js').StoreLocation}}}
export type SessionResult={status:'none';code?:string;reason?:string}|Unavailable|Invalid|{status:'selected';session:ExactSessionRef}|{status:'verified';session:ExactSessionRef};

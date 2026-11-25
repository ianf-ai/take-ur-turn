/** Frozen invocation facts; these interfaces neither launch nor write records. */
import type { FrozenProfile, ProfileKey } from './registry.js';
import type { Capability, ExtractionRule, Mode, NativeRoute, Platform } from './types.js';
export interface Route { agent:string; args:string[] }
export interface StoreLocation {
  storage_layout:'flat'|'cwd-encoded'; session_directory:string;
  source:'cli'|'environment'|'default'; launch_cwd:string;
  session_file?:string; header_cwd?:string;
}
export interface ExactSessionRef {
  profile:ProfileKey; agent:string; session_id:string;
  identity_source:'observed'|'designated'|'argv'; source_run_id:string;
  task_id?:string; role?:string; route:Route; cwd:string; store?:StoreLocation;
  evidence:{via:'RunStore';run_id:string;field:'agent_session_id'|'headless.designated_session_id'|'plain-selector'};
}
export interface EnvironmentFacts {
  home:string; env:Record<string,string|undefined>; designated_id?:string; native_session_base?:string;
  windows_target?:{agent:string;executable:string;prefix_args:string[]};
}
export interface SessionPlan {
  identity_source:'observed'|'designated'|'argv'; designated_id?:string; expected_id?:string;
  capture:Capability<ExtractionRule>; store?:StoreLocation;
  resume_provenance?:{from_run_id:string;identity:'observed'|'designated'|'argv'};
  admission:{agent:string;session_id?:string;selectors:NativeRoute|null};
}
export type InvokeInput={mode:Mode;profile:FrozenProfile;route:Route;platform:Platform;
  checkoutRoot:string;prompt:string;environmentFacts:EnvironmentFacts;sessionRef?:ExactSessionRef;entry:'auto'|'manual'} &
  ({origin:'managed';plain?:never}|{origin:'plain-legacy';plain:{source_run_id:string;argv:string[]}});
export interface Invocation {executable:string;argv:string[];cwd:string;envPatch:Record<string,string|undefined>;sessionPlan:SessionPlan}

export interface UsageCandidate {session_file:string;start_line:number;end_line:number;window_start:string;window_end:string;turn_id?:string;input_tokens:number;output_tokens:number;total_tokens:number;cost_usd:number|null}

/** Basic calls carry no observed or designated native session claim. */
export type BasicSessionPlan=Omit<SessionPlan,'identity_source'>&{identity_source:'none'};
export type InvocationInput={kind:'none'}|{kind:'stdin';encoding:'utf8';text:string};
export type ReadyInvocation=Omit<Invocation,'sessionPlan'>&{logicalArgv:string[];sessionPlan:SessionPlan|BasicSessionPlan;input:InvocationInput;key:ProfileKey};

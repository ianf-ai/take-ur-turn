/** Source reading returns evidence; the watcher alone adjudicates attribution. */
import path from 'node:path';
import {usageSourceKey} from './usage-context.js';
import type { FrozenProfile, ProfileKey } from './registry.js';
import type { Platform } from './types.js';
import type { Route, StoreLocation } from './runtime-contract.js';
import { parseUsageSession, measureUsageSession, type NativeSession } from './usage-session.js';
import {piUsageDirectory} from './native/pi/usage-directory.js';
export {piUsageDirectory} from './native/pi/usage-directory.js';
export { headerExcluded, projectUsageRow } from './usage-session.js';
export type { UsageCandidate } from './runtime-contract.js';
import type { UsageCandidate } from './runtime-contract.js';
export interface RoundRef {
 task_id:string;role:string;agent:string;route:Route;cwd:string;
 launch_version:number;delivery_version:number;launch_ts:string;delivery_ts:string;
 attempt_id?:string;run_id?:string;native_session_id?:string;
 pi_session?:StoreLocation&{session_id:string};
}
export type UsageSessionRef={profile:FrozenProfile;round:RoundRef}&
 ({attribution:'legacy-cwd-window-v1'}|{attribution:'exact-session-window-v1';run_id:string;native_session_id:string;identity_source:'observed'|'designated'|'argv'});
export interface SourceEvidence {source:string;native_schema:string;complete_through_line:number;partial_tail:boolean;profile:ProfileKey;run_id?:string;native_session_id?:string}
export interface UsageProblem {source?:string;status:'pending'|'unresolved'|'invalid'|'error';code:string;reason:string;cause_code?:string}
export type ReadUsageResult=
 |{status:'measured';candidates:[UsageCandidate,...UsageCandidate[]];sourceEvidence:SourceEvidence[];problems:UsageProblem[]}
 |{status:'unsupported'|'pending'|'unresolved'|'invalid'|'error';code:string;reason:string;sourceEvidence:SourceEvidence[];problems:UsageProblem[]};
export interface UsageRunFact {
 run_id:string;task_id?:string;cwd:string;argv:string[];agent_session_id?:string;
 headless?:{role:string;attempt_id:string;base_version:number;route:Route;designated_session_id?:string;windows?:{schema?:number;target:{agent:string;executable?:string;prefix_args?:string[]};logical_argv?:string[];pi_session?:StoreLocation&{session_id:string}}};
}
export interface ReadServices {
 readonly facts:{home:string;auditCwd:string;profileRoot?:string;platform:Platform;piRoot?:string;codexRoot?:string;piEnv:Record<string,string|undefined>};
 list(root:string,pattern:string,signal?:AbortSignal):Promise<string[]>;
 readLines(file:string,maxBytes:number|undefined,signal?:AbortSignal):Promise<{lines:string[];partial:boolean}>;
 readSettings(file:string,signal?:AbortSignal):Promise<string|undefined>;
 readHead(file:string,maxBytes:number,signal?:AbortSignal):Promise<string>;
 readRun(runId:string,signal?:AbortSignal):Promise<UsageRunFact>;
 readRunLog(runId:string,signal?:AbortSignal):Promise<{absolute_path:string;lines:string[];partial:boolean}>;
 /** Optional metadata-only cache adapter uses the same parser, never another scanner. */
 loadSession?(file:string,profile:FrozenProfile,signal?:AbortSignal):Promise<NativeSession>;
 /** Watcher cache of compact per-window outcomes; native rows need not survive a pass. */
 readSessionUsage?(file:string,ref:UsageSessionRef):Promise<SessionUsage>;
 signal?:AbortSignal;
}
async function sourceRoots(ref:UsageSessionRef,services:ReadServices):Promise<string[]> {
 const roots:string[]=[];
 for(const root of ref.profile.value.usage.source!.roots) {
  if(root.kind==='run-log')continue;
  if(root.kind==='hook'||root.layout==='cwd-slash-encoded')roots.push(await piUsageDirectory(ref.round,services));
  else {
   const paths=services.facts.platform==='win32'?path.win32:path.posix;
   const override=root.option==='codexRoot'?services.facts.codexRoot:services.facts.piRoot;
   const directory=override??paths.join(services.facts.home,...root.home_parts);
   roots.push(paths.isAbsolute(directory)?directory:paths.resolve(services.facts.auditCwd,directory));
  }
 }
 return [...new Set(roots)];
}
function invalidRef(ref:UsageSessionRef,services:ReadServices):string|undefined {
 const r=ref.round,paths=ref.profile.platform==='win32'?path.win32:path.posix;
 if(services.facts.platform!==ref.profile.platform||!paths.isAbsolute(r.cwd)||!paths.isAbsolute(services.facts.home))return 'usage-profile-platform-or-cwd-mismatch';
 if(!r.task_id||!r.role||!r.route?.agent||!Array.isArray(r.route.args)||!Number.isInteger(r.launch_version)||r.launch_version<1||!Number.isInteger(r.delivery_version)||r.delivery_version<=r.launch_version||!Number.isFinite(Date.parse(r.launch_ts))||!Number.isFinite(Date.parse(r.delivery_ts))||Date.parse(r.launch_ts)>Date.parse(r.delivery_ts))return 'invalid-round-facts';
 if(r.agent!==ref.profile.id)return 'usage-agent-mismatch';
 if(ref.profile.platform==='posix'&&!ref.profile.value.match.supported_executable_names.includes(path.posix.basename(r.route.agent)))return 'usage-route-mismatch';
 if(ref.attribution!==ref.profile.value.usage.attribution)return 'usage-attribution-mismatch';
 if(ref.attribution==='exact-session-window-v1'&&(!ref.run_id||!ref.native_session_id||ref.run_id!==r.run_id||ref.native_session_id!==r.native_session_id||!r.attempt_id))return 'usage-exact-identity-unavailable';
 return undefined;
}
export interface SessionUsage {sourceEvidence:SourceEvidence[];problems:UsageProblem[];candidates:UsageCandidate[]}
export function sessionUsage(ref:UsageSessionRef,session:NativeSession,fromLog=false):SessionUsage {
 const source=ref.profile.value.usage.source!,file=session.file;
 const sourceEvidence:SourceEvidence[]=[],problems:UsageProblem[]=[],candidates:UsageCandidate[]=[];
 const addProblem=(source:string,status:UsageProblem['status'],code:string,reason:string)=>{problems.push({source,status,code,reason});};
  const version=session.header?.version;
  sourceEvidence.push({source:file,native_schema:source.header.type+'/'+(typeof version==='number'||typeof version==='string'&&/^[a-zA-Z0-9_.-]{1,64}$/u.test(version)?version:'unknown'),complete_through_line:session.complete_lines,partial_tail:session.partial,profile:ref.profile.key,
   ...(ref.attribution==='exact-session-window-v1'?{run_id:ref.run_id,native_session_id:ref.native_session_id}:{})});
  if(ref.attribution==='exact-session-window-v1'&&!fromLog) {
   if(!source.header.id||session.header?.id!==ref.native_session_id){addProblem(file,'unresolved','SOURCE_IDENTITY_MISMATCH','usage-source-session-mismatch');return {sourceEvidence,problems,candidates};}
  }
  try {candidates.push(...measureUsageSession(session,{cwd:ref.round.cwd,launch_ts:ref.round.launch_ts,ts:ref.round.delivery_ts,...(ref.round.pi_session?{pi_session:ref.round.pi_session}:{})},{platform:ref.profile.platform==='win32'?'win32':'linux'}));}
  catch(e){addProblem(file,'invalid','SOURCE_WINDOW_INVALID',(e as Error).message);}
 return {sourceEvidence,problems,candidates};
}
export async function readUsage(ref:UsageSessionRef,services:ReadServices):Promise<ReadUsageResult> {
 const sourceEvidence:SourceEvidence[]=[],problems:UsageProblem[]=[];
 const failure=(status:'unsupported'|'pending'|'unresolved'|'invalid'|'error',code:string,reason:string):ReadUsageResult=>({status,code,reason,sourceEvidence,problems});
 const addProblem=(source:string,status:UsageProblem['status'],code:string,reason:string,error?:unknown)=>{const cause=(error as NodeJS.ErrnoException)?.code;const paths=ref.profile.platform==='win32'?path.win32:path.posix;problems.push({...(paths.isAbsolute(source)?{source}:{}),status,code,reason,...(cause?{cause_code:cause}:{})});};
 const c=ref.profile.value.usage.capability;
 if(c.tier==='unsupported')return failure('unsupported','CAPABILITY_UNSUPPORTED',c.reason);
 const invalid=invalidRef(ref,services);if(invalid)return failure('invalid','USAGE_REF_INVALID',invalid);
 if(ref.attribution==='exact-session-window-v1') {
  try {
   const run=await services.readRun(ref.run_id,services.signal),r=ref.round;
   const observed=ref.identity_source==='observed'?run.agent_session_id:run.headless?.designated_session_id;
   if(run.run_id!==ref.run_id||run.task_id!==r.task_id||run.cwd!==r.cwd||run.headless?.role!==r.role||run.headless?.attempt_id!==r.attempt_id||JSON.stringify(run.headless?.route)!==JSON.stringify(r.route)||observed!==ref.native_session_id)return failure('unresolved','USAGE_RUN_MISMATCH','usage-exact-identity-mismatch');
  }catch(e){addProblem(ref.run_id,'error','USAGE_RUN_READ_ERROR',(e as Error).message,e);return failure('error','USAGE_RUN_READ_ERROR',(e as Error).message);}
 }
 if(c.tier==='assisted'&&c.hook==='opencode-usage-v1')return failure('unsupported','USAGE_SOURCE_UNVERIFIED','usage-source-unverified');
 const source=ref.profile.value.usage.source;if(!source)return failure('unsupported','USAGE_SOURCE_UNVERIFIED','usage-source-unverified');
 const candidates:UsageCandidate[]=[];
 const result=():ReadUsageResult=>{
  if(candidates.length)return {status:'measured',candidates:candidates as [UsageCandidate,...UsageCandidate[]],sourceEvidence,problems};
  if(problems.length){const first=problems[0]!;return failure(first.status,'USAGE_SOURCE_PROBLEMS',first.reason);}
  return failure('pending','USAGE_WINDOW_PENDING','missing_session_or_end');
 };
 const timedOut=()=>problems.at(-1)?.cause_code==='LOCAL_IO_TIMEOUT';
 const readOne=async(file:string,fromLog?:{lines:string[];partial:boolean})=>{
  let session:NativeSession;
  try {
   if(services.signal?.aborted)throw services.signal.reason??Error('usage-read-aborted');
   if(!fromLog&&services.readSessionUsage) {
    const measured=await services.readSessionUsage(file,ref);
    sourceEvidence.push(...measured.sourceEvidence);problems.push(...measured.problems);candidates.push(...measured.candidates);
    return;
   }
   if(fromLog)session=parseUsageSession(fromLog.lines.join('\n')+'\n'+(fromLog.partial?'{':''),file,ref.profile,services.facts.profileRoot);
   else if(services.loadSession)session=await services.loadSession(file,ref.profile,services.signal);
   else {const raw=await services.readLines(file,undefined,services.signal);session=parseUsageSession(raw.lines.join('\n')+'\n'+(raw.partial?'{':''),file,ref.profile,services.facts.profileRoot);}
   if(session.profile.digest!==ref.profile.digest||usageSourceKey(session.profile)!==usageSourceKey(ref.profile))throw Error('usage-cache-profile-mismatch');
  }catch(e){addProblem(file,'error','SOURCE_UNREADABLE',(e as Error).message,e);return;}
  const measured=sessionUsage(ref,session,!!fromLog);
  sourceEvidence.push(...measured.sourceEvidence);problems.push(...measured.problems);candidates.push(...measured.candidates);
 };
 try {
  const seen=new Set<string>();
  let roots:string[];try{roots=await sourceRoots(ref,services);}catch(e){addProblem('usage-root','invalid','SOURCE_ROOT_INVALID',(e as Error).message,e);return failure('invalid','USAGE_ROOT_INVALID',(e as Error).message);}
  for(const root of roots) {
   let files:string[];try{files=await services.list(root,source.path_pattern,services.signal);}catch(e){addProblem(root,'error','SOURCE_DIRECTORY_UNREADABLE',(e as Error).message,e);if(timedOut())return result();continue;}
   for(const file of files) {if(seen.has(file))continue;seen.add(file);await readOne(file);if(timedOut())return result();}
  }
  if(source.roots.some(root=>root.kind==='run-log')) {
   if(ref.attribution!=='exact-session-window-v1')return failure('unresolved','USAGE_RUN_REQUIRED','usage-exact-identity-unavailable');
   const log=await services.readRunLog(ref.run_id,services.signal);if(!seen.has(log.absolute_path)){seen.add(log.absolute_path);await readOne(log.absolute_path,log);}
  }
 }catch(e){addProblem('usage-source','error','USAGE_READ_ERROR',(e as Error).message,e);}
 // A later source failure must not erase earlier claims needed by the watcher.
 return result();
}

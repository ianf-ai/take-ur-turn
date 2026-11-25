/** Capability facade. All returned handles are opaque and bound to one frozen snapshot. */
import {profileSource,agentProfiles,type ProfileSourceSnapshot} from '../registry.js';
import {handleFor,profileFor,basicFor,bindingFor,frozenFacts,type ContractHandle} from '../handles.js';
import {invoke,captureSession} from '../interpreter.js';
import {prepareWindowsInvocation} from '../native/prepare-windows.js';
import {stringMatches} from '../projection.js';
import path from 'node:path';
import {prepareBasicInvocation} from '../basic.js';
import type {StoreLocation} from '../runtime-contract.js';
import {randomUUID} from 'node:crypto';
import {legacyFailure,profileArgv} from '../legacy.js';
import {parsePlain} from '../native/plain.js';
import {plainSessionFailure} from '../native/plain-compat.js';
import {validateResumeSource} from '../run-contract.js';
import {type RoundRef} from '../usage.js';
import type {Platform} from '../types.js';
import type {ExactSessionRef,InvokeInput} from '../runtime-contract.js';
export {encodeContract,decodeContract,type ContractHandle} from '../handles.js';
export type {ProfileSourceSnapshot} from '../registry.js';
export {withContractBindings} from '../registry.js';
export type {ExactSessionRef,SessionPlan,BasicSessionPlan,StoreLocation} from '../runtime-contract.js';
export type {RoundRef,ReadUsageResult} from '../usage.js';
export type {ReadServices} from './usage.js';
import type {Invalid,Unavailable,PriorRunView,SessionResult} from '../session-contract.js';
export type {Invalid,Unavailable,PriorRunView,SessionResult} from '../session-contract.js';
export {resolveContract} from '../selection.js';
export type InvocationFacts=Omit<InvokeInput,'profile'|'platform'>;
export async function prepareInvocation(handle:ContractHandle,facts:InvocationFacts) {
 const basic=bindingFor(handle);
 if(basic) {
  try {const result=prepareBasicInvocation(handle,basic.binding,facts,basic.verifiedTarget);return result.status==='ready'?{...result,invocation:frozenFacts(result.invocation)}:result;}
  catch(error){return {status:'invalid' as const,code:'INVOCATION_PREPARATION_INVALID',reason:(error as Error).message};}
 }
 const profile=profileFor(handle),input={...facts,environmentFacts:{...facts.environmentFacts,designated_id:facts.environmentFacts.designated_id??randomUUID()},profile,platform:handle.platform} as InvokeInput;
 try {
  const result=await invoke(input);
  if(result.status!=='ready')return result.status==='unsupported'?{status:'unavailable' as const,reason:result.reason}:{...result,reason:legacyFailure(profile,result).message};
  const invocation=handle.platform==='win32'?prepareWindowsInvocation(input,result.invocation):result.invocation;
  return {status:'ready' as const,invocation:frozenFacts({...invocation,logicalArgv:[input.environmentFacts.windows_target?.agent??result.invocation.executable,...result.invocation.argv],sessionPlan:{...invocation.sessionPlan,admission:{...invocation.sessionPlan.admission,agent:handle.identity}},input:{kind:'none' as const},key:handle.key})};
 }catch(error){return {status:'invalid' as const,code:'INVOCATION_PREPARATION_INVALID',reason:(error as Error).message};}
}
export function observeSession(handle:ContractHandle,boundedLine:string):string|undefined {return basicFor(handle)?undefined:captureSession(profileFor(handle),boundedLine);}
/** The caller has already checked completion, task/role/route/cwd and authorization. */
export function selectSession(handle:ContractHandle,run:PriorRunView):SessionResult {
 const eligibility=validateResumeSource(handle,run);
 if(eligibility.status!=='compatible')return eligibility;
 if(basicFor(handle))return {status:'unavailable',reason:'RESUME_UNAVAILABLE'};
 const p=profileFor(handle).value,c=p.session;
 if(p.invoke.resume.tier==='unsupported'||c.verify_resume.tier==='unsupported')return {status:'unavailable',reason:'resume-unavailable'};
 let id:string|undefined,identity:ExactSessionRef['identity_source']=c.resume_identity;
 if(identity==='observed')id=run.agent_session_id;
 else if(run.headless)id=run.headless.designated_session_id;
 else {try{id=parsePlain(profileFor(handle),run.argv).session_id;identity='argv';}catch(error){const failure=plainSessionFailure(profileFor(handle),error);return {status:'invalid',...failure};}}
 const grammar=c.legacy_plain_argv;
 if(id&&(run.resume&&run.resume.session_id!==id||run.headless?.session_identity&&run.headless.session_identity.session_id!==id))return {status:'invalid',code:'SESSION_IDENTITY_CONFLICT',reason:'observed/designated identity conflicts with the reserved session'};
 if(!id)return {status:'none',code:`${handle.id}-session-unavailable`,reason:`source run ${run.run_id} (${handle.id}) recorded no observed agent_session_id; exact session identity unavailable`};
 if((identity!=='observed'||grammar.tier==='declarative'&&grammar.spec!=='codex')&&!stringMatches(id,c.id_validation))return {status:'invalid',code:`${handle.id}-session-unavailable`,reason:`source run ${run.run_id} (${handle.id}) recorded no valid observed agent_session_id; exact session identity unavailable`};
 let route=run.headless?.route;
 if(!route){try{const parsed=parsePlain(profileFor(handle),run.argv);const grammar=c.legacy_plain_argv;route={agent:parsed.agent,args:grammar.tier==='declarative'&&grammar.spec==='pi'?parsed.head.slice(1):parsed.optionTokens};}catch(error){return {status:'invalid',...plainSessionFailure(profileFor(handle),error)};}}
 return {status:'selected',session:frozenFacts({profile:handle.key,agent:handle.id,session_id:id,identity_source:identity,source_run_id:run.run_id,route,cwd:run.cwd,...(run.headless?.windows?.pi_session?{store:run.headless.windows.pi_session}:{}),...(run.task_id?{task_id:run.task_id}:{}),...(run.headless?{role:run.headless.role}:{}),evidence:{via:'RunStore',run_id:run.run_id,field:identity==='observed'?'agent_session_id':identity==='argv'?'plain-selector':'headless.designated_session_id'}})};
}
export type {SessionReadServices} from '../session-read-services.js';
import type {SessionReadServices} from '../session-read-services.js';
export async function verifySession(handle:ContractHandle,session:ExactSessionRef,services:SessionReadServices):Promise<SessionResult> {
 if(basicFor(handle))return {status:'unavailable',reason:'RESUME_UNAVAILABLE'};
 const p=profileFor(handle),rule=p.value.session.verify_resume,c=p.value.session;
 const invalid=(code:string,reason:string):Invalid=>({status:'invalid',code,reason});
 if(session.profile.digest!==handle.digest||session.profile.id!==handle.id||session.profile.revision!==handle.revision||session.agent!==handle.id)return invalid('SESSION_PROFILE_MISMATCH','session-contract-mismatch');
 const field=session.identity_source==='observed'?'agent_session_id':session.identity_source==='argv'?'plain-selector':'headless.designated_session_id';
 if(!session.session_id||!session.source_run_id||session.evidence?.via!=='RunStore'||session.evidence.run_id!==session.source_run_id||session.evidence.field!==field)return invalid('SESSION_SOURCE_INVALID','session-source-mismatch');
 if(session.identity_source!=='argv'&&session.identity_source!==c.resume_identity)return invalid('SESSION_IDENTITY_MISMATCH','session-identity-mismatch');
 const grammar=c.legacy_plain_argv;
 if((session.identity_source!=='observed'||grammar.tier==='declarative'&&grammar.spec!=='codex')&&!stringMatches(session.session_id,c.id_validation))return invalid('SESSION_ID','invalid-session-id');
 if(rule.tier==='unsupported')return {status:'unavailable',reason:rule.reason};
 if(rule.tier==='assisted') {
  if(rule.hook!=='pi-store-v1')return invalid('SESSION_VERIFIER_INVALID','session-verifier-unavailable');
  const {verifyNativeSession}=await import('../native/pi/verify-session.js');
  const result=await verifyNativeSession(session,handle.platform,services);
  if(!result.ok)return invalid(`${handle.id}-session-not-found`,result.reason);
  if(result.store)session=frozenFacts({...session,store:result.store});
 }
 return {status:'verified',session:frozenFacts(session)};
}
export {bindUsage,readUsage} from './usage.js';
export type {UsageRef} from './usage.js';

/** Host selects a frozen source; consumers never inspect compiled profiles. */
export const contractSource=profileSource;
export function invocationCommand(handle:ContractHandle,route:{agent:string}):string {return basicFor(handle)?.command.executable??route.agent;}
export function invocationEnvironment(handle:ContractHandle,cwd:string):Record<string,string> {
 if(basicFor(handle))return {PWD:cwd};
 const c=profileFor(handle).value.invoke.cwd;return c.tier==='declarative'?Object.fromEntries(c.spec.env_sync.map(k=>[k,cwd])):{};
}
/** Compatibility helpers for historical plain-run API and synchronous argv tests. */
export const legacyInvocationArgv=profileArgv;
export function continuitySession(handle:ContractHandle,run:PriorRunView):SessionResult {
 return selectSession(handle,run);
}

export type ReadyInvocation=Awaited<ReturnType<typeof prepareInvocation>> extends infer R?R extends {status:'ready';invocation:infer I}?I:never:never;

export function validateNativeLaunch(target:{agent:string},store:StoreLocation&{session_id:string}|undefined,designated:string|undefined):void {
 if(target.agent!=='pi')return;
 if(!store||!['flat','cwd-encoded'].includes(store.storage_layout)||!path.win32.isAbsolute(store.session_directory)||!path.win32.isAbsolute(store.launch_cwd)||store.session_id!==designated)throw Error('Windows pi run lacks a frozen session location/identity');
}

export function legacySessionFromLine(line:string,agent='codex'):string|undefined {
 const p=agentProfiles.get(agent)??agentProfiles.get('codex');return p?captureSession(p,line):undefined;
}

export {resolveRunContract,resolveResumeContract,runSessionIdentities,captureContract,occupiedSessions} from '../run-contract.js';
export {parsePlainCodexArgv,parsePlainPiArgv,parsePlainOpencodeArgv,SessionContractError,type PlainCodexParse,type PlainPiParse,type PlainOpencodeParse} from '../native/plain-compat.js';
export {piSessionDirFor,readPiSessionHead,verifyPiSession,type PiSessionHead} from '../native/pi/posix-session.js';

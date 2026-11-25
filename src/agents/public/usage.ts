/** Usage interpretation and cache proofs. Native rows never cross this facade. */
import path from 'node:path';
import {handleFor,profileFor,basicFor,frozenFacts,type ContractHandle} from '../handles.js';
import {registryFromSnapshot,withAgentProfileSnapshot,type ProfileSourceSnapshot} from '../registry.js';
import {resolveContract} from '../selection.js';
import {bindWindowsPi} from '../native/usage-windows.js';
import {parseUsageSession,sameUsageCwd,type NativeSession} from '../usage-session.js';
import {readUsage as readNative,sessionUsage,type RoundRef,type UsageSessionRef,type ReadServices as NativeServices,type SessionUsage,type UsageRunFact} from '../usage.js';
export {withAgentProfileSnapshot};
export type {RoundRef,ReadUsageResult,SourceEvidence,UsageProblem,SessionUsage,UsageRunFact} from '../usage.js';
export {instant,vector} from '../usage-session.js';

declare const refBrand:unique symbol,sourceBrand:unique symbol,proofBrand:unique symbol;
export interface UsageRef {readonly [refBrand]:true;readonly key:string}
export interface UsageSource {readonly [sourceBrand]:true;readonly key:string}
export interface UsageProof {readonly [proofBrand]:true}
const refs=new WeakMap<UsageRef,UsageSessionRef>(),sources=new WeakMap<UsageSource,NativeSession>();
const proofs=new WeakMap<UsageProof,{excluded:boolean;cwd:unknown;schemaAccepted:boolean;starts:number[]}>();
const internalRef=(ref:UsageRef)=>{const r=refs.get(ref);if(!r)throw Error('USAGE_REF_INVALID');return r;};
const internalSource=(source:UsageSource)=>{const s=sources.get(source);if(!s)throw Error('USAGE_SOURCE_INVALID');return s;};
export type ReadServices=Omit<NativeServices,'loadSession'|'readSessionUsage'>&{
 loadSource?(file:string,handle:ContractHandle,signal?:AbortSignal):Promise<UsageSource>;
 readSource?(file:string,ref:UsageRef):Promise<SessionUsage>;
};
export function bindUsage(handle:ContractHandle,round:RoundRef,identity?:{run_id:string;native_session_id:string;identity_source:'observed'|'designated'|'argv'}) {
 if(basicFor(handle))return {status:'unavailable' as const,reason:'not-declared'};
 const p=profileFor(handle),c=p.value.usage;
 if(c.capability.tier==='unsupported')return {status:'unavailable' as const,reason:c.capability.reason};
 if(!c.readable_formats.includes('task-usage-v1'))return {status:'unavailable' as const,reason:'usage-format-unavailable'};
 if(c.attribution==='exact-session-window-v1'&&!identity)return {status:'invalid' as const,code:'USAGE_IDENTITY_REQUIRED',reason:'usage-exact-identity-unavailable'};
 const facts=identity?{run_id:identity.run_id,native_session_id:identity.native_session_id,identity_source:identity.identity_source}:undefined;
 const ref=Object.freeze({key:JSON.stringify([handle.sourceKey,round,facts])}) as UsageRef;
 refs.set(ref,{profile:p,round:frozenFacts(round),attribution:c.attribution,...facts} as UsageSessionRef);
 return {status:'bound' as const,ref};
}
export function usageCachePolicy(ref:UsageRef) {
 const r=internalRef(ref);return {sourceKey:handleFor(r.profile).sourceKey,reusable:r.profile.platform==='posix'&&r.attribution==='legacy-cwd-window-v1'};
}
export function parseUsageSource(text:string,file:string,handle:ContractHandle):UsageSource {
 const source=Object.freeze({key:handle.sourceKey}) as UsageSource;
 sources.set(source,parseUsageSession(text,file,profileFor(handle)));return source;
}
export async function readUsage(ref:UsageRef,services:ReadServices) {
 const r=internalRef(ref);
 return readNative(r,{...services,
  ...(services.loadSource?{loadSession:async(file:string,p:import('../registry.js').FrozenProfile,signal?:AbortSignal)=>internalSource(await services.loadSource!(file,handleFor(p),signal))}:{}),
  ...(services.readSource?{readSessionUsage:(file:string)=>services.readSource!(file,ref)}:{})
 });
}
export function measureUsageSource(source:UsageSource,refs:readonly UsageRef[]) {
 const session=internalSource(source),outcomes=refs.map(ref=>{
  if(usageCachePolicy(ref).sourceKey!==source.key)throw Error('usage-cache-profile-mismatch');
  return sessionUsage(internalRef(ref),session);
 });
 const versions=session.profile.value.usage.source?.header.accepted_versions;
 const proof=Object.freeze({}) as UsageProof;
 proofs.set(proof,{excluded:session.excluded,cwd:session.header?.cwd,schemaAccepted:!versions?.length||versions.includes(session.header?.version as string|number),starts:session.rows.filter(r=>r.start).map(r=>typeof r.ts==='string'?Date.parse(r.ts):NaN)});
 return {outcomes,proof};
}
export function usageSourceNeutral(proof:UsageProof,ref:UsageRef):boolean {
 const hit=proofs.get(proof),r=internalRef(ref);if(!hit||r.attribution!=='legacy-cwd-window-v1')return false;
 if(hit.excluded)return true;
 try{if(!sameUsageCwd(hit.cwd,r.round.cwd,{platform:r.profile.platform==='win32'?'win32':'linux'}))return true;}catch{return false;}
 return hit.schemaAccepted&&hit.starts.every(ts=>Number.isFinite(ts)&&(ts<Date.parse(r.round.launch_ts)||ts>Date.parse(r.round.delivery_ts)));
}
/** Stable ordering retains the historical cross-reader diagnostic precedence. */
export function usageContracts(snapshot:ProfileSourceSnapshot,platform:'posix'|'win32'):ContractHandle[] {
 return registryFromSnapshot(snapshot).all(platform).sort((a,b)=>Number(b.value.usage.accounting?.mode==='sum-deduplicated')-Number(a.value.usage.accounting?.mode==='sum-deduplicated')).map(handleFor);
}
export function usageAvailability(agent:unknown,snapshot:ProfileSourceSnapshot,platform:'posix'|'win32'='posix') {
 if(typeof agent!=='string')return {status:'invalid' as const,reason:'missing_route'};
 const resolved=resolveContract({agent},snapshot,platform);
 if(resolved.status!=='resolved')return resolved;
 const h=resolved.handle;
 if(basicFor(h))return {status:'unavailable' as const,reason:'not-declared',capability:'unavailable' as const};
 const c=profileFor(h).value.usage.capability;
 if(c.tier==='unsupported')return {status:'unavailable' as const,reason:c.reason,capability:'unsupported' as const};
 if(!profileFor(h).value.usage.readable_formats.includes('task-usage-v1'))return {status:'unavailable' as const,reason:'usage-format-unavailable',capability:'unavailable' as const};
 return {status:'available' as const,handle:h};
}
/** A delivery supplies launch facts; only this contract layer interprets native identity. */
export function bindUsageRun(handle:ContractHandle,round:RoundRef,runs:readonly UsageRunFact[]) {
 if(basicFor(handle))return bindUsage(handle,round);
 const p=profileFor(handle);
 if(p.value.usage.attribution!=='exact-session-window-v1')return bindUsage(handle,round);
 const matches=runs.filter(run=>run.task_id===round.task_id&&run.headless?.role===round.role&&run.headless.attempt_id===round.attempt_id);
 if(matches.length!==1)return {status:'invalid' as const,code:'USAGE_IDENTITY_REQUIRED',reason:'usage-exact-identity-unavailable'};
 const run=matches[0]!,observed=p.value.session.resume_identity==='observed',id=observed?run.agent_session_id:run.headless?.designated_session_id;
 if(!id)return {status:'invalid' as const,code:'USAGE_IDENTITY_REQUIRED',reason:'usage-exact-identity-unavailable'};
 return bindUsage(handle,{...round,run_id:run.run_id,native_session_id:id},{run_id:run.run_id,native_session_id:id,identity_source:observed?'observed':'designated'});
}
export function usageResultReason(result:import('../usage.js').ReadUsageResult):string|undefined {
 return result.status==='measured'?undefined:result.code==='USAGE_ROOT_INVALID'?'invalid_pi_session_directory':result.reason;
}
export function usageNeedsRun(handle:ContractHandle):boolean {return !basicFor(handle)&&profileFor(handle).value.usage.attribution==='exact-session-window-v1';}
export {bindWindowsPi as bindLegacyUsageRounds};
/** Audit labels may vary in case; only registered profile IDs are canonicalized.
 * Unknown labels, paths and binding references retain their exact identity.
 */
export function normalizeUsageAgent(agent:string|undefined,root?:string):string|undefined {
 return typeof agent==='string'?registryFromSnapshot(sourcePort(root)).get(agent.toLowerCase())?.id??agent:agent;
}
/** Sidecar readability is a format capability, distinct from live measurement. */
export function usageReadable(agent:unknown,format='task-usage-v1',root?:string):agent is string {
 return typeof agent==='string'&&registryFromSnapshot((sourcePort(root))).get(agent)?.value.usage.readable_formats.some(f=>f===format)===true;
}
import {profileSource as sourcePort} from '../registry.js';

/** Probe native-turn calibration uses the same interpreter without exposing native rows. */
export async function readProbeUsage(handle:ContractHandle,round:RoundRef,run:UsageRunFact,services:ReadServices) {
 const binding=bindUsageRun(handle,round,[run]);if(binding.status!=='bound')return binding;
 let ref=binding.ref,result=await readUsage(ref,services);
 if(result.status==='pending') {
  const starts:string[]=[];
  for(const evidence of result.sourceEvidence) {
   const raw=await services.readLines(evidence.source,undefined,services.signal);
   const native=parseUsageSession(raw.lines.join('\n')+'\n'+(raw.partial?'{':''),evidence.source,profileFor(handle));
   const r=internalRef(ref);
   if(native.excluded||!sameUsageCwd(native.header!.cwd,round.cwd,{platform:handle.platform==='win32'?'win32':'linux'}))continue;
   if(r.attribution==='exact-session-window-v1'&&profileFor(handle).value.usage.source?.header.id&&native.header?.id!==r.native_session_id)continue;
   for(const row of native.rows)if(row.start&&typeof row.ts==='string'&&Date.parse(row.ts)>=Date.parse(round.launch_ts)&&Date.parse(row.ts)<=Date.parse(round.delivery_ts))starts.push(row.ts);
  }
  if(starts.length===1){const rebound=bindUsageRun(handle,{...round,delivery_ts:starts[0]!},[run]);if(rebound.status==='bound'){ref=rebound.ref;result=await readUsage(ref,services);}}
 }
 return {status:'read' as const,result,replay:await readUsage(ref,services)};
}
/** Compatibility input for existing injected scan loaders; never retained by the consumer. */
export function usageSourceFromLegacy(value:unknown,handle:ContractHandle):UsageSource {
 const native=value as import('./transition.js').NativeSession&{legacy_profile?:boolean};
 const profile=native.legacy_profile&&native.agent===handle.id?handle:native.profile;
 if(profile?.sourceKey!==handle.sourceKey)throw Error('usage-cache-profile-mismatch');
 const source=Object.freeze({key:handle.sourceKey}) as UsageSource;
 sources.set(source,{...native,profile:profileFor(profile)});return source;
}
/** Historical root-option defaults are native knowledge, shared by CLI and watcher. */
export function usageAuditDefaults(platform:NodeJS.Platform,home:string,env:Record<string,string|undefined>) {
 const paths=platform==='win32'?path.win32:path.posix;
 return {...(platform==='win32'?{platform,home,piEnv:{PI_CODING_AGENT_SESSION_DIR:env.PI_CODING_AGENT_SESSION_DIR,PI_CODING_AGENT_DIR:env.PI_CODING_AGENT_DIR}}:{piRoot:paths.join(home,'.pi/agent/sessions')}),codexRoot:paths.join(home,'.codex/sessions')};
}
export function usageProbeRoot(home:string,env:Record<string,string|undefined>):string {
 return path.join(env.CODEX_HOME??path.join(home,'.codex'),'sessions');
}

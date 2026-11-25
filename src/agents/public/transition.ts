import {windowsPiRouteArgs} from '../native/pi/windows-session.js';
import {prepareWindowsPiSession} from '../native/pi/invocation.js';
/** TRANSITION: legacy consumer adapters. Delete when the legacy consumer adapters retire.
 * Only these adapters translate old call shapes. Compiled profile.value never leaves agents.
 */
import {ProfileRegistry as Registry,agentProfiles as profiles,loadAgentProfiles as load,withAgentProfileSnapshot} from '../registry.js';
import {handleFor,profileFor,type ContractHandle} from '../handles.js';
import * as interpreter from '../interpreter.js';
import * as legacy from '../legacy.js';
import * as plain from '../native/plain.js';
import * as usage from '../usage.js';
import * as sessions from '../usage-session.js';
import type {InvokeInput as InternalInvokeInput} from '../runtime-contract.js';
import type {Platform} from '../types.js';
export {withAgentProfileSnapshot};
export {profilePlatform} from '../registry.js';
export type {ProfileKey,ProfileDiagnostic} from '../registry.js';
export type FrozenProfile=ContractHandle;
export type InvokeInput=Omit<InternalInvokeInput,'profile'>&{profile:ContractHandle};
export type UsageSessionRef=Omit<usage.UsageSessionRef,'profile'>&{profile:ContractHandle;run_id?:string;native_session_id?:string;identity_source?:'observed'|'designated'|'argv'};
export type NativeSession=Omit<sessions.NativeSession,'profile'>&{profile:ContractHandle};
export type ReadServices=Omit<usage.ReadServices,'loadSession'|'readSessionUsage'>&{
 loadSession?(file:string,profile:ContractHandle,signal?:AbortSignal):Promise<NativeSession>;
 readSessionUsage?(file:string,ref:UsageSessionRef):Promise<usage.SessionUsage>;
};
export class ProfileRegistry {
 #registry:Registry;
 constructor(values:unknown[],diagnostics:import('../registry.js').ProfileDiagnostic[]=[]) {this.#registry=new Registry(values,diagnostics);}
 static forRoot(root?:string):ProfileRegistry {
  const registry=load(root);let result=registries.get(registry);
  if(!result){result=new ProfileRegistry([]);result.#registry=registry;registries.set(registry,result);}
  return result;
 }
 get diagnostics(){return this.#registry.diagnostics;}
 get(id:string,platform:Platform='posix'){const p=this.#registry.get(id,platform);return p&&handleFor(p);}
 match(executable:string,platform:Platform='posix',verifiedTarget?:string){const p=this.#registry.match(executable,platform,verifiedTarget);return p&&handleFor(p);}
 all(platform:Platform='posix'){return this.#registry.all(platform).map(handleFor);}
}
const registries=new WeakMap<Registry,ProfileRegistry>();
export const loadAgentProfiles=(root?:string):ProfileRegistry=>ProfileRegistry.forRoot(root);
export const agentProfiles={
 get diagnostics(){return profiles.diagnostics;},
 get(id:string,platform:Platform='posix',root?:string){const p=profiles.get(id,platform,root);return p&&handleFor(p);},
 match(executable:string,platform:Platform='posix',target?:string,root?:string){const p=profiles.match(executable,platform,target,root);return p&&handleFor(p);},
 all(platform:Platform='posix',root?:string){return profiles.all(platform,root).map(handleFor);}
};
/** Temporary projections, deliberately separate from the opaque handle. */
type LegacySessionPolicy=Pick<import('../types.js').SessionContract,'fresh_identity'|'resume_identity'|'verify_resume'|'legacy_plain_argv'>;
export function legacySessionPolicy(handle:ContractHandle):LegacySessionPolicy;
export function legacySessionPolicy(handle:ContractHandle|undefined):LegacySessionPolicy|undefined;
export function legacySessionPolicy(handle:ContractHandle|undefined){if(!handle)return undefined;const {fresh_identity,resume_identity,verify_resume,legacy_plain_argv}=profileFor(handle).value.session;return Object.freeze({fresh_identity,resume_identity,verify_resume,legacy_plain_argv});}
export const legacySessionIdValid=(handle:ContractHandle,value:unknown)=>interpreter.stringMatches(value,profileFor(handle).value.session.id_validation);
export const legacyRoutePolicy=(handle:ContractHandle)=>profileFor(handle).value.invoke.route;
export const legacyExecutableNames=(handle:ContractHandle)=>profileFor(handle).value.match.supported_executable_names;
export const usageReadable=(agent:unknown,format='task-usage-v1',root?:string):agent is string=>typeof agent==='string'&&profiles.get(agent,'posix',root)?.value.usage.readable_formats.some(f=>f===format)===true;
export const usageCapability=(agent:string,root?:string)=>{const c=profiles.get(agent,'posix',root)?.value.usage.capability;return !c?{tier:'unsupported' as const,reason:'profile-unregistered'}:c.tier==='unsupported'?{tier:c.tier,reason:c.reason}:{tier:c.tier};};
export const invoke=(input:InvokeInput)=>interpreter.invoke({...input,profile:profileFor(input.profile)} as InternalInvokeInput);
export const renderInvocation=(input:Omit<Parameters<typeof interpreter.renderInvocation>[0],'profile'>&{profile:ContractHandle})=>interpreter.renderInvocation({...input,profile:profileFor(input.profile)});
export const captureSession=(profile:ContractHandle,line:string)=>interpreter.captureSession(profileFor(profile),line);
export const profileArgv=(route:{agent:string;args:readonly string[]},prompt:string,session?:string,profile=agentProfiles.match(route.agent))=>legacy.profileArgv(route,prompt,session,profile&&profileFor(profile));
export const profileEnv=(profile:ContractHandle|undefined,cwd:string)=>legacy.profileEnv(profile&&profileFor(profile),cwd);
export const legacyFailure=(profile:ContractHandle,f:interpreter.Failure)=>legacy.legacyFailure(profileFor(profile),f);
export {PlainArgvError} from '../native/plain.js';
export const parsePlain=(profile:ContractHandle,argv:readonly string[])=>plain.parsePlain(profileFor(profile),argv);
const internalRef=(ref:UsageSessionRef)=>({...ref,profile:profileFor(ref.profile)}) as usage.UsageSessionRef;
export const parseUsageSession=(text:string,file:string,profile:ContractHandle,root?:string):NativeSession=>({...sessions.parseUsageSession(text,file,profileFor(profile),root),profile});
export const measureUsageSession=(session:NativeSession,...args:Parameters<typeof sessions.measureUsageSession> extends [unknown,...infer R]?R:never)=>sessions.measureUsageSession({...session,profile:profileFor(session.profile)},...args);
export const sessionUsage=(ref:UsageSessionRef,session:NativeSession,fromLog=false)=>usage.sessionUsage(internalRef(ref),{...session,profile:profileFor(session.profile)},fromLog);
export const readUsage=(ref:UsageSessionRef,services:ReadServices)=>usage.readUsage(internalRef(ref),{...services,
 ...(services.loadSession?{loadSession:async(file:string,p:import('../registry.js').FrozenProfile,signal?:AbortSignal)=>{const s=await services.loadSession!(file,handleFor(p),signal);return {...s,profile:profileFor(s.profile)};}}:{}),
 ...(services.readSessionUsage?{readSessionUsage:(file:string,r:usage.UsageSessionRef)=>services.readSessionUsage!(file,{...r,profile:handleFor(r.profile)})}:{})
} as usage.ReadServices);
export {piUsageDirectory} from '../usage.js';
export {sameUsageCwd,instant,vector} from '../usage-session.js';
export {stringMatches,valueAt,guardsMatch,type Failure} from '../projection.js';
export {probeArgs} from '../native/route.js';
export type {RoundRef,ReadUsageResult,SessionUsage,SourceEvidence,UsageProblem} from '../usage.js';
export type {ExactSessionRef,SessionPlan,StoreLocation,UsageCandidate} from '../runtime-contract.js';

/** Serialize an authoring artifact for the isolated legacy probe (delete when the isolated legacy probe retires). */
export const profileArtifact=(handle:ContractHandle):string=>JSON.stringify(profileFor(handle).value);

/** Storage-option parsing keeps its original position before invocation validation. */
export function legacyWindowsRouteFacts(target:import('../windows-target-contract.js').LegacyWindowsTarget|undefined,args:string[]) {
 return target?.agent==='pi'?windowsPiRouteArgs(args):undefined;
}
export function legacyWindowsSession(input:{target?:import('../windows-target-contract.js').LegacyWindowsTarget;cwd:string;env:NodeJS.ProcessEnv;routeFacts?:ReturnType<typeof windowsPiRouteArgs>;id?:string;designated?:string;previous:()=>import('../native/pi/windows-session.js').WindowsPiSession|undefined}) {
 if(input.target?.agent!=='pi')return undefined;
 return prepareWindowsPiSession(input);
}

/** Data-only catalogs; workspace declarations never load executable modules. */
import { readFileSync, lstatSync } from 'node:fs';
import {contentKey} from './content-key.js';
import {bindUsageContext} from './usage-context.js';
import {legacyUsagePeerId} from './native/usage-compat.js';
import path from 'node:path';
import { validateProfile } from './schema.js';
import type { AgentProfile, Platform } from './types.js';
export interface ProfileKey { readonly id:string; readonly revision:string; readonly digest:string }
export interface FrozenProfile { readonly key:ProfileKey; readonly id:string; readonly revision:string; readonly digest:string; readonly platform:Platform; readonly value:AgentProfile }
export interface ProfileDiagnostic { id:string; code:'PROFILE_INVALID'|'PROFILE_AMBIGUOUS'; reason:string }
function freeze<T>(v:T):T { if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v; }
export function profilePlatform(platform:NodeJS.Platform):Platform|undefined {return platform==='win32'?'win32':platform==='darwin'||platform==='linux'?'posix':undefined;}
export class ProfileRegistry {
 readonly diagnostics:ProfileDiagnostic[]=[];
 private readonly profiles=new Map<string,AgentProfile>();
 private readonly expanded=new Map<string,FrozenProfile>();
 private readonly targetClaims:{id:string;names:string[];identities:string[];platforms?:readonly Platform[]}[]=[];
 constructor(values:unknown[], diagnostics:ProfileDiagnostic[]=[]) {
  this.diagnostics.push(...diagnostics);
  for(const d of diagnostics)if(!d.id.startsWith('('))this.targetClaims.push({id:d.id,names:[d.id],identities:[d.id]});
  const ids=new Set<string>();
  for(const raw of values) {
   const id=typeof raw==='object'&&raw!==null&&'id' in raw?String(raw.id):'(unknown)';
   // Invalid declarations still own their advertised targets; a basic alias
   // cannot turn a broken native safety contract into an unguarded invocation.
   const match=raw&&typeof raw==='object'&&'match' in raw?raw.match as {supported_executable_names?:unknown;platform_target_identity?:{win32?:unknown}}|null:undefined;
   const names=Array.isArray(match?.supported_executable_names)?match.supported_executable_names.filter((n):n is string=>typeof n==='string'&&n.length>0):[];
   const target=match?.platform_target_identity?.win32;
   const claim:{id:string;names:string[];identities:string[];platforms?:readonly Platform[]}={id,names:names.length?names:[id],identities:[id,...(typeof target==='string'?[target]:[])]};
   this.targetClaims.push(claim);
   if(ids.has(id)){for(const c of this.targetClaims)if(c.id===id)delete c.platforms;this.profiles.delete(id);this.diagnostics.push({id,code:'PROFILE_AMBIGUOUS',reason:'duplicate profile id'});continue;}
   ids.add(id);
   try{const profile=validateProfile(raw);this.profiles.set(id,profile);claim.platforms=profile.evidence.platforms;}catch(e){this.diagnostics.push({id,code:'PROFILE_INVALID',reason:(e as Error).message});}
  }
  for(const platform of ['posix','win32'] as const) {
   const matches=new Map<string,string[]>();
   for(const p of this.profiles.values()) {
    if(!p.evidence.platforms.includes(platform))continue;
    const keys=platform==='win32' ? (p.match.platform_target_identity?[p.match.platform_target_identity.win32]:[]) : p.match.supported_executable_names;
    for(const key of new Set(keys))matches.set(key,[...(matches.get(key)??[]),p.id]);
   }
   const ambiguous=new Set([...matches.values()].filter(ids=>ids.length>1).flat());
   for(const p of this.profiles.values()) {
    if(!p.evidence.platforms.includes(platform))continue;
    if(ambiguous.has(p.id)){this.diagnostics.push({id:p.id,code:'PROFILE_AMBIGUOUS',reason:`ambiguous ${platform==='win32'?'verified target':'executable'} on ${platform}`});continue;}
    try {
     const value=structuredClone(p),override=p.platform_overrides[platform];
     if(override?.invoke)Object.assign(value.invoke,override.invoke);
     if(override?.usage)Object.assign(value.usage,override.usage);
     value.platform_overrides={};validateProfile(value);
     const key={id:p.id,revision:p.revision,digest:contentKey(value)};
     this.expanded.set(`${p.id}:${platform}`,freeze({key,...key,platform,value}));
    }catch(e){this.diagnostics.push({id:p.id,code:'PROFILE_INVALID',reason:`${platform}: ${(e as Error).message}`});}
   }
  }
  for(const profile of this.expanded.values()) {
   const peerId=legacyUsagePeerId(profile.id,profile.value.usage.attribution);
   const header=peerId?this.expanded.get(`${peerId}:posix`)?.value.usage.source?.header:undefined;
   bindUsageContext(profile,header);
  }
  freeze(this.diagnostics);
 }
 targetClaim(executable:string,platform:Platform,verifiedTarget?:string):string|undefined {
  const normalize=(name:string)=>platform==='win32'?path.win32.basename(name).toLowerCase().replace(/\.(?:exe|com|cmd|bat|ps1)$/u,''):path.posix.basename(name);
  const name=normalize(executable);
  return this.targetClaims.find(c=>(c.platforms===undefined||c.platforms.includes(platform))&&(c.names.some(n=>normalize(n)===name)||verifiedTarget!==undefined&&c.identities.includes(verifiedTarget)))?.id;
 }
 get(id:string,platform:Platform='posix'):FrozenProfile|undefined{return this.expanded.get(`${id}:${platform}`);}
 match(executable:string,platform:Platform='posix',verifiedTarget?:string):FrozenProfile|undefined {
  // On Windows the host must supply its already verified native target.
  if(platform==='win32')return verifiedTarget?this.all(platform).find(p=>p.value.match.platform_target_identity?.win32===verifiedTarget):undefined;
  const name=path.basename(executable);
  return this.all(platform).find(p=>p.value.match.supported_executable_names.includes(name));
 }
 all(platform:Platform='posix'):FrozenProfile[]{return [...this.expanded.values()].filter(p=>p.platform===platform);}
}
function bundledValues():unknown[] {
 const root=new URL('./profiles/',import.meta.url),values:unknown[]=[];
 const catalog:unknown=JSON.parse(readFileSync(new URL('catalog.json',root),'utf8'));
 if(!catalog||typeof catalog!=='object'||Array.isArray(catalog))throw Error('invalid bundled profile catalog');
 for(const [id,file] of Object.entries(catalog)) {
  try {
   if(typeof file!=='string'||!/^\.\.\/native\/[a-z][a-z0-9-]*\/profile\.json$/u.test(file))throw Error('catalog path must be a bundled JSON leaf');
   const url=new URL(file,root);if(!lstatSync(url).isFile())throw Error('catalog entry must be a regular file');
   const p=JSON.parse(readFileSync(url,'utf8'));if(p.id!==id)throw Error('catalog/profile id mismatch');values.push(p);
  }catch {values.push({id});}
 }
 return values;
}
const bundled=bundledValues();
const builtinRegistry=new ProfileRegistry(bundled);
/** Valid native knowledge is platform-scoped; untrusted broken claims stay conservative. */
export function bundledNativeTargetClaim(executable:string,platform:Platform,verifiedTarget?:string):string|undefined {
 return builtinRegistry.targetClaim(executable,platform,verifiedTarget);
}
/** A basic alias cannot replace an existing native contract's safety rules. */
export function assertBasicTargetUnclaimed(executable:string,platform:Platform,verifiedTarget?:string,registry:ProfileRegistry=builtinRegistry):void {
 const id=bundledNativeTargetClaim(executable,platform,verifiedTarget)??registry.targetClaim(executable,platform,verifiedTarget);
 if(id!==undefined)throw Error(`BINDING_NATIVE_CONFLICT: native contract '${id}' protects this executable; select its native route instead of a basic alias`);
}
export interface ProfileSourceSnapshot { readonly bindings?:unknown; readonly bindingError?:string; readonly values: readonly unknown[]; readonly diagnostics: readonly ProfileDiagnostic[]; readonly overridden: readonly string[] }
export interface ProfileSourcePort {
 load(root?:string): ProfileSourceSnapshot;
 withSnapshot<T>(root:string,action:()=>T):T;
}
let sourcePort:ProfileSourcePort|undefined;
export function configureProfileSource(port:ProfileSourcePort):void { sourcePort=port; }
const compiled=new WeakMap<ProfileSourceSnapshot,ProfileRegistry>();
export function loadAgentProfiles(root?:string):ProfileRegistry {
 if(!sourcePort)return builtinRegistry;
 return registryFromSnapshot(sourcePort.load(root));
}
export function registryFromSnapshot(snapshot:ProfileSourceSnapshot):ProfileRegistry {
 let registry=compiled.get(snapshot);
 if(!registry){registry=new ProfileRegistry([...bundled.filter(raw=>!snapshot.overridden.includes((raw as AgentProfile).id)),...snapshot.values],[...snapshot.diagnostics]);compiled.set(snapshot,registry);}
 return registry;
}
/** A config view shares the source's compiled registry; bindings do not reparse profiles. */
export function withContractBindings(source:ProfileSourceSnapshot,bindings:unknown):ProfileSourceSnapshot {
 const snapshot={...source,bindings};
 compiled.set(snapshot,registryFromSnapshot(source));return snapshot;
}
export function withAgentProfileSnapshot<T>(root:string,action:()=>T):T {return sourcePort?sourcePort.withSnapshot(root,action):action();}
/** Resolve the owning rig at the call boundary, including worktree workers. */
export const agentProfiles={
 get diagnostics():ProfileDiagnostic[]{return loadAgentProfiles().diagnostics;},
 get(id:string,platform:Platform='posix',root?:string):FrozenProfile|undefined{return loadAgentProfiles(root).get(id,platform);},
 match(executable:string,platform:Platform='posix',verifiedTarget?:string,root?:string):FrozenProfile|undefined{return loadAgentProfiles(root).match(executable,platform,verifiedTarget);},
 all(platform:Platform='posix',root?:string):FrozenProfile[]{return loadAgentProfiles(root).all(platform);}
};
export function usageReadable(agent:unknown,format='task-usage-v1',root?:string):agent is string {
 return typeof agent==='string'&&agentProfiles.get(agent,'posix',root)?.value.usage.readable_formats.some(f=>f===format)===true;
}
export function usageCapability(agent:string,root?:string) {
 return agentProfiles.get(agent,'posix',root)?.value.usage.capability??{tier:'unsupported' as const,reason:'profile-unregistered'};
}

export function profileSource(root?:string):ProfileSourceSnapshot {return sourcePort?.load(root)??{values:[],diagnostics:[],overridden:[]};}

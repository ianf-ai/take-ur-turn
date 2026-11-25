import {ProfileRegistry,assertBasicTargetUnclaimed,type FrozenProfile,type ProfileKey} from './registry.js';
import {usageContextFor,usageSourceKey,bindUsageContext} from './usage-context.js';
import type {Platform} from './types.js';
import {validateInvocationBinding,type InvocationBinding} from './binding.js';
import {contentKey} from './content-key.js';
import {legacyBasicBinding} from './legacy-basic.js';
declare const contractBrand:unique symbol;
export interface ContractHandle {
 readonly [contractBrand]:true;
 readonly sourceKey:string;readonly source:'snapshot'|'binding';readonly identity:string;readonly key:ProfileKey;readonly id:string;readonly revision:string;readonly digest:string;readonly platform:Platform;
 readonly capabilities:Readonly<{invoke:boolean;resume:boolean;observe:boolean;usage:boolean}>;
}
const profiles=new WeakMap<ContractHandle,FrozenProfile>(),handles=new WeakMap<FrozenProfile,ContractHandle>();
export function handleFor(profile:FrozenProfile):ContractHandle {
 let handle=handles.get(profile);if(handle)return handle;
 const p=profile.value;
 handle=Object.freeze({sourceKey:usageSourceKey(profile),source:'snapshot' as const,identity:p.invoke.route==='passthrough'?profile.id:p.invoke.route,key:profile.key,id:profile.id,revision:profile.revision,digest:profile.digest,platform:profile.platform,capabilities:Object.freeze({invoke:p.invoke.run.tier!=='unsupported',resume:p.invoke.resume.tier!=='unsupported'&&p.session.verify_resume.tier!=='unsupported',observe:p.session.capture.tier!=='unsupported',usage:p.usage.capability.tier!=='unsupported'})}) as ContractHandle;
 profiles.set(handle,profile);handles.set(profile,handle);return handle;
}
interface BasicContract {binding:InvocationBinding;verifiedTarget?:string;legacy?:unknown}
const bindings=new WeakMap<ContractHandle,BasicContract>();
export const basicFor=(handle:ContractHandle)=>bindings.get(handle)?.binding;
export function bindingFor(handle:ContractHandle):BasicContract|undefined {return bindings.get(handle);}
export function basicHandleFor(raw:unknown,platform:Platform,verifiedTarget?:string):ContractHandle {
 const binding=validateInvocationBinding(raw);
 if(!['posix','win32'].includes(platform)||verifiedTarget!==undefined&&(typeof verifiedTarget!=='string'||!verifiedTarget||verifiedTarget.includes('\0')))throw Error('BINDING_TARGET_INVALID');
 assertBasicTargetUnclaimed(binding.command.executable,platform,verifiedTarget);
 const digest=contentKey(binding),key=frozenFacts({id:binding.id,revision:'basic-v1',digest});
 const sourceKey=contentKey({kind:'basic',key,platform,...(verifiedTarget!==undefined?{verifiedTarget}:{})});
 const handle=frozenFacts({sourceKey,source:'binding',identity:`binding:${binding.id}`,key,...key,platform,capabilities:{invoke:true,resume:false,observe:false,usage:false}}) as ContractHandle;
 bindings.set(handle,frozenFacts({binding,...(verifiedTarget!==undefined?{verifiedTarget}:{})}));
 return handle;
}
/** Decode the historical grammar and preserve the exact historical digest/token. */
function legacyBasicHandle(raw:unknown,platform:Platform):ContractHandle {
 const binding=legacyBasicBinding(raw,platform);
 assertBasicTargetUnclaimed(binding.command.executable,platform);
 const key=frozenFacts({id:binding.id,revision:'basic-v1',digest:contentKey(raw)});
 const handle=frozenFacts({sourceKey:key.digest,source:'binding',identity:`binding:${binding.id}`,key,...key,platform,capabilities:{invoke:true,resume:false,observe:false,usage:false}}) as ContractHandle;
 bindings.set(handle,frozenFacts({binding,legacy:raw}));return handle;
}
export function profileFor(handle:ContractHandle):FrozenProfile {const profile=profiles.get(handle);if(!profile)throw Error('CONTRACT_HANDLE_INVALID');return profile;}
/** Opaque transport token: the receiver recompiles and validates all content. */
export function encodeContract(handle:ContractHandle):string {
 const basic=bindingFor(handle);
 if(basic&&'legacy' in basic)return JSON.stringify({schema:1,key:handle.key,platform:handle.platform,basic:basic.legacy});
 if(basic)return JSON.stringify({schema:2,kind:'basic',interpreter:'basic-v1',key:handle.key,platform:handle.platform,sourceKey:handle.sourceKey,...basic});
 const p=profileFor(handle);return JSON.stringify({schema:1,key:p.key,platform:p.platform,profile:p.value,usagePeer:usageContextFor(p).peerHeader,sourceKey:handle.sourceKey});
}
export function decodeContract(token:unknown):ContractHandle {
 try {
  if(typeof token!=='string')throw Error();
  const raw=JSON.parse(token);if(!raw||!['posix','win32'].includes(raw.platform))throw Error();
  if(raw.schema===2) {
   if(raw.kind!=='basic'||raw.interpreter!=='basic-v1'||Object.keys(raw).some(k=>!['schema','kind','interpreter','key','platform','sourceKey','binding','verifiedTarget'].includes(k)))throw Error();
   const handle=basicHandleFor(raw.binding,raw.platform,raw.verifiedTarget);
   if(raw.key?.id!==handle.id||raw.key?.revision!==handle.revision||raw.key?.digest!==handle.digest||raw.sourceKey!==handle.sourceKey)throw Error();
   return handle;
  }
  if(raw.schema!==1)throw Error();
  if(raw.basic){const handle=legacyBasicHandle(raw.basic,raw.platform);if(raw.key?.id!==handle.id||raw.key?.revision!==handle.revision||raw.key?.digest!==handle.digest)throw Error();return handle;}
  const p=new ProfileRegistry([raw.profile]).get(raw.key?.id,raw.platform);
  if(!p||p.digest!==raw.key?.digest||p.revision!==raw.key?.revision)throw Error();
  if('usagePeer' in raw)bindUsageContext(p,raw.usagePeer);
  if(raw.sourceKey!==undefined&&raw.sourceKey!==usageSourceKey(p))throw Error();
  return handleFor(p);
 }catch {throw Error('CONTRACT_CODEC_INVALID');}
}

/** Freeze newly produced facts without retaining aliases into a caller's mutable data. */
export function frozenFacts<T>(value:T):T {
 const copy=structuredClone(value);
 const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}};
 freeze(copy);return copy;
}

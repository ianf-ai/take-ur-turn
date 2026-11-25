/** Compile a selected declaration without runtime I/O or facade back edges. */
import {registryFromSnapshot,type ProfileSourceSnapshot} from './registry.js';
import {handleFor,basicHandleFor,type ContractHandle} from './handles.js';
import {resolveBindingReference} from './binding.js';
import {assertBasicTargetUnclaimed} from './registry.js';
import {protectedNativeCommand} from './native/protection.js';
import type {Platform} from './types.js';
import type {Invalid} from './session-contract.js';
export function resolveContract(selection:{agent:string;verifiedTarget?:string},snapshot:ProfileSourceSnapshot,platform:Platform):{status:'resolved';handle:ContractHandle}|Invalid {
 const registry=registryFromSnapshot(snapshot);
 if(selection.agent.startsWith('binding:')) {
  const id=selection.agent.slice(8),bindings=snapshot.bindings;
  try {
   if(snapshot.bindingError)return {status:'invalid',code:'BINDING_SOURCE_INVALID',reason:snapshot.bindingError};
   const binding=resolveBindingReference(selection.agent,[],bindings)!;
   assertBasicTargetUnclaimed(binding.command.executable,platform,selection.verifiedTarget,registry);
   if(protectedNativeCommand(binding.command.executable,binding.command.argv,platform,selection.verifiedTarget))throw Error('BINDING_NATIVE_CONFLICT');
   const handle=basicHandleFor(binding,platform,selection.verifiedTarget);
   return {status:'resolved',handle};
  }catch(error){return {status:'invalid',code:'BINDING_INVALID',reason:(error as Error).message};}
 }
 const profile=registry.match(selection.agent,platform,selection.verifiedTarget);
 return profile?{status:'resolved',handle:handleFor(profile)}:{status:'invalid',code:'CONTRACT_UNAVAILABLE',reason:registry.diagnostics.map(d=>d.reason).join('; ')||'profile-unregistered'};
}

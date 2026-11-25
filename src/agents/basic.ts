/** Basic invocation compilation. No filesystem, process, discovery or Hub effects. */
import path from 'node:path';
import {assertBasicExecutable} from './basic-executable.js';
import {protectedNativeCommand} from './native/protection.js';
import {bindingShape,type InvocationBinding} from './binding.js';
import {assertBasicTargetUnclaimed} from './registry.js';
import type {ContractHandle} from './handles.js';
import type {InvokeInput,ReadyInvocation} from './runtime-contract.js';
export function prepareBasicInvocation(handle:ContractHandle,binding:InvocationBinding,facts:Omit<InvokeInput,'profile'|'platform'>,verifiedTarget?:string):
 {status:'ready';invocation:ReadyInvocation}|{status:'invalid';code:string;reason:string}|{status:'unavailable';reason:string} {
 const invalid=(code:string,reason=code)=>({status:'invalid' as const,code,reason});
 if(facts.mode==='resume')return {status:'unavailable',reason:'resume-unavailable'};
 if(facts.mode!=='run'||!['auto','manual'].includes(facts.entry)||facts.origin!=='managed'||facts.sessionRef||!facts.environmentFacts||!facts.route||facts.route.agent!==handle.identity||!Array.isArray(facts.route.args)||!facts.route.args.every(a=>typeof a==='string'&&!a.includes('\0'))||typeof facts.prompt!=='string'||facts.prompt.includes('\0'))return invalid('BINDING_INVOCATION_FACTS_INVALID');
 const paths=handle.platform==='win32'?path.win32:path.posix;
 if(typeof facts.checkoutRoot!=='string'||!paths.isAbsolute(facts.checkoutRoot)||facts.checkoutRoot.includes('\0')||typeof facts.environmentFacts.home!=='string'||!paths.isAbsolute(facts.environmentFacts.home))return invalid('INVOCATION_CWD_INVALID');
 if(facts.route.args.length&&!binding.command.argv.some(w=>typeof w!=='string'&&w.slot==='args'))return invalid('BINDING_ARGS_SLOT_REQUIRED','command.argv: route args require an args slot');
 if(binding.input.kind==='stdin'&&Buffer.byteLength(facts.prompt,'utf8')>64*1024)return invalid('BINDING_INPUT_TOO_LARGE','stdin prompt exceeds 64 KiB UTF-8');
 const target=facts.environmentFacts.windows_target;
  const commandArgs=binding.command.argv.flatMap(v=>typeof v==='string'?[v]:v.slot==='args'?facts.route.args:[]);
  if(protectedNativeCommand(binding.command.executable,commandArgs,handle.platform,target?.agent)||target&&protectedNativeCommand(target.executable,[...target.prefix_args,...commandArgs],handle.platform))return invalid('BINDING_NATIVE_CONFLICT');
  assertBasicExecutable(target?.executable??binding.command.executable);
  let executable=binding.command.executable;
 let argv=binding.command.argv.flatMap(word=>typeof word==='string'?[word]:word.slot==='args'?[...facts.route.args]:[facts.prompt]);
 if(handle.platform==='win32') {
  const target=facts.environmentFacts.windows_target;
  if(!target||target.agent!==(verifiedTarget??path.win32.basename(binding.command.executable).replace(/\.exe$/i,''))||!paths.isAbsolute(target.executable)||!bindingShape.shape.command.shape.executable.safeParse(target.executable).success||!Array.isArray(target.prefix_args)||!target.prefix_args.every(a=>typeof a==='string'&&!a.includes('\0')))return invalid('BINDING_WINDOWS_TARGET_INVALID');
  assertBasicTargetUnclaimed(target.executable,handle.platform,target.agent);
  executable=target.executable;argv=[...target.prefix_args,...argv];
 }
 return {status:'ready',invocation:{executable,argv,logicalArgv:[target?.agent??binding.command.executable,...argv],cwd:facts.checkoutRoot,envPatch:{PWD:facts.checkoutRoot},
  input:binding.input.kind==='stdin'?{kind:'stdin',encoding:'utf8',text:facts.prompt}:{kind:'none'},key:handle.key,
  sessionPlan:{identity_source:'none',capture:{tier:'unsupported',reason:'basic-session-unavailable'},admission:{agent:handle.identity,selectors:null}}
 }};
}

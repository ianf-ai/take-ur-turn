import path from 'node:path';
import type {Invocation,InvokeInput} from '../runtime-contract.js';
import {windowsPiRouteArgs} from './pi/windows-session.js';
import {prepareWindowsPiSession} from './pi/invocation.js';
import {physicalWindowsArgv} from './windows-invocation.js';
/** Complete the same native preparation used by the existing Windows planner. */
export function prepareWindowsInvocation(input:InvokeInput,logical:Invocation):Invocation {
 const target=input.environmentFacts.windows_target;
 if(!target||!path.win32.isAbsolute(target.executable)||target.executable.includes('\0')||!Array.isArray(target.prefix_args)||!target.prefix_args.every(arg=>typeof arg==='string'&&!arg.includes('\0')))throw Error('Windows run lacks a valid frozen logical/physical launch identity');
 let store=logical.sessionPlan.store;
 if(target.agent==='pi') {
  const previous=input.sessionRef?.store;
  if(input.mode==='resume'&&previous&&(!['flat','cwd-encoded'].includes(previous.storage_layout)||!path.win32.isAbsolute(previous.session_directory)))throw Error('Windows pi run lacks a frozen session location/identity');
  store=prepareWindowsPiSession({cwd:input.checkoutRoot,env:input.environmentFacts.env,home:input.environmentFacts.home,routeFacts:windowsPiRouteArgs(input.route.args),
   ...(input.mode==='resume'?{id:input.sessionRef!.session_id}:{}),...(logical.sessionPlan.designated_id?{designated:logical.sessionPlan.designated_id}:{}),verifyFrozenFile:true,
   previous:()=>previous?{...previous,session_id:input.sessionRef!.session_id}:undefined});
 }
 return {...logical,executable:target.executable,argv:physicalWindowsArgv(target,[target.agent,...logical.argv],target.agent==='pi'?store:undefined).slice(1),
  sessionPlan:{...logical.sessionPlan,...(store?{store}:{})}};
}

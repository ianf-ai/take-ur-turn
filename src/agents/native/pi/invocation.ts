/** Shared directory preparation for legacy planning and the capability facade. */
import path from 'node:path';
import {windowsPiSessionLocation,verifyWindowsPiSession,verifyWindowsPiContinuation,type WindowsPiSession,type windowsPiRouteArgs} from './windows-session.js';
export interface WindowsPiInvocationFacts {
 cwd:string;env:NodeJS.ProcessEnv;routeFacts?:ReturnType<typeof windowsPiRouteArgs>;
 id?:string;designated?:string;home?:string;verifyFrozenFile?:boolean;
 previous:()=>WindowsPiSession|undefined;
}
export function prepareWindowsPiSession(input:WindowsPiInvocationFacts):WindowsPiSession {
 if(input.id) {
  const previous=input.previous();
  if(!previous||previous.launch_cwd!==path.win32.resolve(input.cwd))throw Error('Windows pi continuation has no matching frozen session directory');
  return input.verifyFrozenFile?verifyWindowsPiContinuation(previous,input.id,input.cwd):verifyWindowsPiSession(previous,input.id);
 }
 return {...windowsPiSessionLocation(input.cwd,input.env,input.routeFacts?.directory,input.home===undefined?{}:{home:input.home}),session_id:input.designated!};
}

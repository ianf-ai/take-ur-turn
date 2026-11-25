/** Physical target resolution stays in the host; known native safety checks remain here. */
import path from 'node:path';
import {isPiWindowsName,recoverPiShim,verifyPiTarget} from './pi/windows-target.js';
import {isCodexWindowsName,verifyCodexTarget} from './codex/windows-target.js';
import type {WindowsTargetServices,PhysicalTarget,LegacyWindowsTarget} from '../windows-target-contract.js';
export async function resolveLegacyWindowsTarget(agent:string,_env:NodeJS.ProcessEnv,io:WindowsTargetServices):Promise<LegacyWindowsTarget> {
 const name=path.win32.basename(agent).toLowerCase(),isPi=isPiWindowsName(name)&& (name!=='cli.js'||/@earendil-works[\\/]pi-coding-agent[\\/]/i.test(agent)),isCodex=isCodexWindowsName(name);

 const explicit=path.win32.isAbsolute(agent);
 if(!explicit&&/[\\/]/u.test(agent))throw Error('Windows detached agent paths must be absolute');
 let target:PhysicalTarget;
 try{target=await io.resolve(agent,explicit);}catch(error){
  const shimPath=io.shimPath(error);
  if(!shimPath||!isPi||path.win32.basename(shimPath).toLowerCase()!=='pi.cmd')throw error;
  target=await recoverPiShim(shimPath,io);
 }
 return isCodex?verifyCodexTarget(target):isPi?verifyPiTarget(target,io):{...target,agent:path.win32.basename(agent).replace(/\.exe$/i,'')};
}

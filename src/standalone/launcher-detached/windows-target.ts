/** Physical target probes stay in the host; native admission is an agents contract. */
import {readFile,stat} from 'node:fs/promises';
import {resolveWindowsExecutableTarget} from '../../core/launcher/target/windows.js';
import {UnsupportedWindowsShimError,type WindowsTargetDeps} from '../../core/launcher/target/types.js';
import {withFsProbeBudget,probeTimeoutMs} from '../../core/launcher/target/probe.js';
import {resolveLegacyWindowsTarget} from '../../agents/public/native-compat.js';
export {npmPiShim} from '../../agents/public/native-compat.js';
export interface DetachedWindowsTargetDeps extends WindowsTargetDeps {readText?:(file:string)=>Promise<string>}
export async function resolveDetachedWindowsTarget(agent:string,env:NodeJS.ProcessEnv,deps:DetachedWindowsTargetDeps={}) {
 const environment={...env,PATH:env.PATH??Object.entries(env).find(([k])=>k.toUpperCase()==='PATH')?.[1]??'',PATHEXT:env.PATHEXT??Object.entries(env).find(([k])=>k.toUpperCase()==='PATHEXT')?.[1]};
 return resolveLegacyWindowsTarget(agent,env,{
  nodeExecutable:deps.nodeExecutable??process.execPath,
  readText:file=>withFsProbeBudget(()=>(deps.readText??(f=>readFile(f,'utf8')))(file),probeTimeoutMs(environment)),
  regular:async file=>{if(!(await withFsProbeBudget(signal=>(deps.stat??(f=>stat(f)))(file,signal),probeTimeoutMs(environment))).isFile())throw Error(`not a regular Windows target: ${file}`);},
  resolve:(command,explicit)=>resolveWindowsExecutableTarget(command,{...deps,environment,...(explicit?{candidates:async()=>[command]}:{})}),
  shimPath:error=>error instanceof UnsupportedWindowsShimError?error.shimPath:undefined
 });
}

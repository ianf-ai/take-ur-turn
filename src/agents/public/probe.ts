/** Native diagnostic projections; callers do not inspect profile or session grammars. */
import {ProfileRegistry,registryFromSnapshot,type ProfileSourceSnapshot} from '../registry.js';
import {handleFor,profileFor,basicFor,type ContractHandle} from '../handles.js';
import {stringMatches} from '../projection.js';
import {probeArgs} from '../native/route.js';
import type {AgentProfile} from '../types.js';
import type {UsageRunFact} from '../usage.js';
export function probeProfile(id:string,snapshot:ProfileSourceSnapshot,platform:'posix'|'win32',candidate?:AgentProfile) {
 const registry=candidate?new ProfileRegistry([candidate]):registryFromSnapshot(snapshot),profile=registry.get(id,platform);
 if(!profile)throw Error(registry.diagnostics.filter(d=>d.id===id||d.id==='(workspace)').map(d=>`${d.code}: ${d.reason}`).join('; ')||`未注册档案或未支持当前平台：${id}`);
 return handleFor(profile);
}
export function probeDefaultRoute(handle:ContractHandle) {
 const p=profileFor(handle).value;return {agent:p.match.supported_executable_names[0]!,args:[...probeArgs(p.invoke.route)]};
}
export const probeArtifact=(handle:ContractHandle)=>JSON.stringify(profileFor(handle).value);
export function probeSession(handle:ContractHandle,run:UsageRunFact):{status:'observed';id:string}|{status:'unavailable';reason:string} {
 if(basicFor(handle))return {status:'unavailable',reason:'not-declared'};
 const c=profileFor(handle).value.session;
 if(c.capture.tier==='unsupported'&&c.fresh_identity!=='designated')return {status:'unavailable',reason:c.capture.reason};
 const id=c.resume_identity==='observed'?run.agent_session_id:run.headless?.designated_session_id;
 if(!id||!stringMatches(id,c.id_validation))throw Error('没有可验证的原生 session 身份；请检查 session.capture / id_validation');
 return {status:'observed',id};
}

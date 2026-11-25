/** Decode run snapshots and project occupancy; no authorization or Store access. */
import path from 'node:path';
import {registryFromSnapshot,type ProfileSourceSnapshot} from './registry.js';
import {decodeContract,encodeContract,handleFor,profileFor,basicFor,type ContractHandle} from './handles.js';
import type {Platform} from './types.js';
import type {PriorRunView,Invalid,Unavailable} from './session-contract.js';

type Resolution={status:'resolved';handle:ContractHandle}|Invalid;
function runBindingFailure(handle:ContractHandle,run:PriorRunView):Invalid|undefined {
 if(basicFor(handle))return undefined;
 const p=profileFor(handle).value,target=run.headless?.windows?.target;
 if(handle.platform==='win32') {
  if(!target||p.match.platform_target_identity?.win32!==target.agent)return {status:'invalid',code:'CONTRACT_INVALID',reason:'frozen native target conflicts with run contract'};
 } else if(run.argv?.length&&!p.match.supported_executable_names.includes(path.posix.basename(run.argv[0]??''))) {
  return {status:'invalid',code:'unsupported-agent',reason:'recorded executable conflicts with native contract; shell wrappers refuse explicitly'};
 }
 return undefined;
}
export function resolveRunContract(run:PriorRunView,snapshot:ProfileSourceSnapshot|(()=>ProfileSourceSnapshot),platform:Platform):Resolution {
 try {
  const token=run.headless?.contract??run.contract;
  if(token===null)throw Error('run contract capture was explicitly disabled');
  let handle:ContractHandle|undefined;
  if(token!==undefined&&token!==null) {
   handle=decodeContract(token);
   if(run.contract!==undefined&&run.headless?.contract!==undefined) {
    const other=decodeContract(run.contract);
    if(other.digest!==handle.digest||other.platform!==handle.platform)throw Error('conflicting run contract snapshots');
   }
   if(handle.platform!==platform)throw Error('run contract platform mismatch');
  } else {
   const registry=registryFromSnapshot(typeof snapshot==='function'?snapshot():snapshot),target=run.headless?.windows?.target;
   const profile=registry.match(run.headless?.route?.agent??run.argv[0]??'',platform,target?.agent);
   if(!profile)return {status:'invalid',code:registry.diagnostics.length?'CONTRACT_INVALID':'unsupported-agent',reason:registry.diagnostics.map(d=>d.reason).join('; ')||'native session contract unavailable; shell wrappers and unknown agents refuse explicitly'};
   handle=handleFor(profile);
  }
  const mismatch=runBindingFailure(handle,run);if(mismatch)return mismatch;
  return {status:'resolved',handle};
 }catch(error){return {status:'invalid',code:'CONTRACT_INVALID',reason:(error as Error).message};}
}

/** Validate historical evidence against an already selected operation handle.
 * Missing legacy snapshots use that handle; this never reads live configuration. */
export function validateResumeSource(handle:ContractHandle,run:PriorRunView):{status:'compatible'}|Invalid|Unavailable {
 let prior=handle;
 if(run.contract!==undefined||run.headless?.contract!==undefined) {
  const resolved=resolveRunContract(run,()=>{throw Error('source contract snapshot missing');},handle.platform);
  if(resolved.status!=='resolved')return resolved;
  prior=resolved.handle;
 } else {
  const mismatch=runBindingFailure(handle,run);if(mismatch)return mismatch;
 }
 if(!prior.capabilities.resume)return {status:'unavailable',reason:'RESUME_UNAVAILABLE'};
 if(prior.identity!==handle.identity)return {status:'invalid',code:'SESSION_IDENTITY_CONFLICT',reason:'current contract conflicts with the source session authority'};
 if(!handle.capabilities.resume)return {status:'unavailable',reason:'RESUME_UNAVAILABLE'};
 return {status:'compatible'};
}
/** Freeze legacy capture before IPC; explicit basic/invalid snapshots never guess a parser. */
export function captureContract(executable:string,snapshot:ProfileSourceSnapshot):string|null {
 const registry=registryFromSnapshot(snapshot);
 if(registry.diagnostics.some(d=>d.id===path.basename(executable)))return null;
 const profile=registry.match(executable)??registry.get('codex');
 return profile?encodeContract(handleFor(profile)):null;
}
/** Projection only. The admission lock and the occupancy decision stay in core. */
export function occupiedSessions(handle:ContractHandle,run:PriorRunView):readonly {agent:string;session_id:string}[] {
 if(basicFor(handle))return [];
 const ids=new Set([run.agent_session_id,run.headless?.designated_session_id,run.headless?.session_identity?.session_id,run.resume?.session_id].filter((v):v is string=>!!v));
 const {argv}=run;const resume=argv.indexOf('resume');
 for(let i=1;i<argv.length;i++){if(argv[i-1]==='--session-id'||resume!==-1&&i>resume&&i<argv.length-1)ids.add(argv[i]!);}
 const grammar=profileFor(handle).value.session.legacy_plain_argv;
 if(grammar.tier==='declarative'&&grammar.spec==='opencode'&&argv[1]==='run'){const separator=argv.indexOf('--',2);if(separator>=4&&argv[separator-2]==='--session')ids.add(argv[separator-1]!);}
 return [...ids].map(session_id=>({agent:handle.identity,session_id}));
}

export function runSessionIdentities(run:PriorRunView,snapshot:ProfileSourceSnapshot):readonly {agent:string;session_id:string}[] {
 const platform=run.headless?.windows?'win32':'posix';
 const resolved=resolveRunContract(run,snapshot,platform);
 if(resolved.status==='resolved')return occupiedSessions(resolved.handle,run);
 if(resolved.code!=='unsupported-agent')throw Error(`${resolved.code}: ${resolved.reason}`);
 // Plain Windows native aliases have no managed target envelope, so they
 // remain ineligible for continuation. Their argv can still conservatively
 // reserve a native identity; dropping the .exe alias would admit overlap.
 const executable=run.argv[0]??'';
 if(!run.headless?.windows&&run.contract===undefined&&run.headless?.contract===undefined&&/^[a-z]:[\\/].*\.(?:exe|com)$/iu.test(executable)) {
  const registry=registryFromSnapshot(snapshot),id=registry.targetClaim(executable,'win32');
  const profile=id===undefined?undefined:registry.get(id,'win32');
  if(profile)return occupiedSessions(handleFor(profile),run);
 }
 // Unprofiled legacy captures were conservative occupancy evidence. Retain
 // that safety boundary, without granting them a continuation capability.
 return [run.agent_session_id,run.headless?.designated_session_id,run.headless?.session_identity?.session_id,run.resume?.session_id].filter((id):id is string=>!!id).map(session_id=>({agent:run.resume?.agent??'',session_id}));
}

/** A new continuation operation sees current configuration. The source's
 * snapshot still bounds what its evidence can authorize; execution freezes
 * the returned handle and never resolves it again after admission waits. */
export function resolveResumeContract(run:PriorRunView,source:ProfileSourceSnapshot|(()=>ProfileSourceSnapshot),platform:Platform):Resolution {
 let snapshot:ProfileSourceSnapshot|undefined;
 const current=()=>snapshot??=typeof source==='function'?source():source;
 const prior=resolveRunContract(run,current,platform);
 if(prior.status!=='resolved'||!prior.handle.capabilities.resume)return prior;
 const {contract:_,headless,...facts}=run;
 let historicalHeadless:PriorRunView['headless'];
 if(headless){const {contract:__,...rest}=headless;historicalHeadless=rest;}
 const selected=resolveRunContract({...facts,...(historicalHeadless?{headless:historicalHeadless}:{})},current,platform);
 if(selected.status==='resolved'&&selected.handle.identity!==prior.handle.identity)return {status:'invalid',code:'SESSION_IDENTITY_CONFLICT',reason:'current contract conflicts with the source session authority'};
 return selected;
}

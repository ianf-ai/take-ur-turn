import {agentProfiles,parseUsageSession,measureUsageSession} from '../../../dist/agents/public/transition.js';
import {localFs} from '../lib/io.mjs';
export async function readSession(file,agent,options={}) {
 const profile=typeof agent==='string'?agentProfiles.get(agent,(options.platform??process.platform)==='win32'?'win32':'posix',options.root):agent;
 if(!profile)throw Error('unsupported_agent');
 return {...parseUsageSession(await localFs(options).readFile(file,'utf8'),file,profile,options.root),legacy_profile:typeof agent==='string'};
}
export function measure(session,round,options={}) {
 const platform=(options.platform??process.platform)==='win32'?'win32':'posix';
 if(session.legacy_profile&&session.profile.platform!==platform)session={...session,profile:agentProfiles.get(session.agent,platform,options.root)??session.profile};
 return measureUsageSession(session,round,options);
}

import {piUsageDirectory,sameUsageCwd as sameCwd} from '../../../dist/agents/public/transition.js';
import {attributeMatches} from '../lib/rounds.mjs';
import os from 'node:os';
export {bindLegacyUsageRounds as bindWindowsPi} from '../../../dist/agents/public/usage.js';
export function attribute(rounds,sessions,options={}) {
 return attributeMatches(rounds.map(round=>{
  if(round.problem)return {round,reason:round.problem,candidates:[]};
  const candidates=[],errors=[];
  for(const s of sessions.filter(s=>s.agent===round.agent&&!s.excluded&&sameCwd(s.header.cwd,round.cwd,options))) {
   if((options.platform??process.platform)==='win32'&&round.agent==='pi'&&options.piCandidates&&!options.piCandidates.get(round)?.has(s.file))continue;
   try{candidates.push(...measure(s,round,options));}catch(e){errors.push(e.message);}
  }
  return {round,candidates,reason:candidates.length>1?'ambiguous_sessions':errors.length?[...new Set(errors)].sort().join(','):candidates.length?undefined:'missing_session_or_end'};
 }));
}
export async function piDirectory(round,options,deps={}) {
 return piUsageDirectory({cwd:round.cwd,route:{agent:round.agent??'pi',args:round.route_args??[]},...(round.pi_session?{pi_session:round.pi_session}:{})},{
  facts:{home:options.home??os.homedir(),platform:(options.platform??process.platform)==='win32'?'win32':'posix',...(options.piRoot!==undefined?{piRoot:options.piRoot}:{}),piEnv:options.piEnv??process.env},
  readSettings:async file=>{try{return await (deps.readSettings??(file=>localFs(options).readFile(file,'utf8')))(file);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
 });
}

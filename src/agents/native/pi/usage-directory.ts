/** Native session-root precedence; no environment or filesystem discovery here. */
import path from 'node:path';
import type {Route,StoreLocation} from '../../runtime-contract.js';
import type {Platform} from '../../types.js';
import {windowsPiEncodedCwd,windowsPiRouteArgs,windowsPiSessionLocation,resolveWindowsPiPath} from './windows-session.js';
interface DirectoryReadServices {
 readonly facts:{platform:Platform;home:string;piRoot?:string;piEnv:Record<string,string|undefined>};
 readSettings(file:string,signal?:AbortSignal):Promise<string|undefined>;
 signal?:AbortSignal;
}
export async function piUsageDirectory(round:{cwd:string;route:Route;pi_session?:StoreLocation&{session_id:string}},services:DirectoryReadServices):Promise<string> {
 const f=services.facts;
 if(f.platform!=='win32')return path.join(f.piRoot??path.join(f.home,'.pi','agent','sessions'),`--${round.cwd.replace(/^\//u,'').replaceAll('/','-')}--`);
 if(round.pi_session)return f.piRoot===undefined?round.pi_session.session_directory:round.pi_session.storage_layout==='flat'?f.piRoot:path.win32.join(f.piRoot,windowsPiEncodedCwd(round.cwd));
 const env=f.piEnv,directory=windowsPiRouteArgs(round.route.args).directory;
 if(f.piRoot!==undefined)return directory||env.PI_CODING_AGENT_SESSION_DIR?f.piRoot:path.win32.join(f.piRoot,windowsPiEncodedCwd(round.cwd));
 const settings=new Map<string,string|undefined>();
 if(!directory&&!env.PI_CODING_AGENT_SESSION_DIR) {
  const agentDir=env.PI_CODING_AGENT_DIR?resolveWindowsPiPath(env.PI_CODING_AGENT_DIR,round.cwd,f.home):path.win32.join(f.home,'.pi','agent');
  for(const file of [path.win32.join(agentDir,'settings.json'),path.win32.join(round.cwd,'.pi','settings.json')])settings.set(file,await services.readSettings(file,services.signal));
 }
 return windowsPiSessionLocation(round.cwd,env,directory,{home:f.home,readSettings:file=>settings.get(file)}).session_directory;
}

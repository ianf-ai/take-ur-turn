import path from 'node:path';
import type {ExactSessionRef} from '../../runtime-contract.js';
import type {Platform} from '../../types.js';
import type {SessionReadServices} from '../../session-read-services.js';
import {piSessionDirFor,verifyPiSession} from './posix-session.js';
import {verifyWindowsPiSession} from './windows-session.js';
/** Adapt bounded async reads to the existing native verifiers; never duplicate identity policy. */
export async function verifyNativeSession(session:ExactSessionRef,platform:Platform,io:SessionReadServices):Promise<{ok:true;store?:ExactSessionRef['store']}|{ok:false;reason:string}> {
 const paths=platform==='win32'?path.win32:path.posix;
 try {
  const base=io.nativeSessionBase??io.env?.PI_CODING_AGENT_SESSION_DIR??(io.home?paths.join(io.home,'.pi','agent','sessions'):undefined);
  let resolved=paths.resolve(session.cwd),directory:string;
  if(platform==='win32') {
   if(!session.store||session.store.launch_cwd!==resolved)return {ok:false,reason:'frozen Windows pi cwd differs from run cwd'};
   directory=session.store.session_directory;
  } else {
   if(!base||!paths.isAbsolute(base))return {ok:false,reason:'pi session store unavailable'};
   try{resolved=await io.realpath?.(resolved)??resolved;}catch{/* Legacy falls back to resolve. */}
   directory=piSessionDirFor(session.cwd,base,()=>resolved);
  }
  const entries=(await io.entries(directory)).filter(name=>name.endsWith('.jsonl')&&paths.basename(name)===name);
  const heads=new Map<string,string|undefined>();
  for(const name of entries) {
   const file=paths.join(directory,name),head=await io.readHead(file,8192);
   heads.set(file,head!==undefined&&Buffer.byteLength(head)<=8192?head:undefined);
  }
  if(platform==='posix')return verifyPiSession(base!,session.cwd,session.session_id,{entries:()=>entries,head:file=>heads.get(file),realpath:()=>resolved});
  const verified=verifyWindowsPiSession(session.store!,session.session_id,{entries:()=>entries,header:file=>{
   const text=heads.get(file),end=text?.indexOf('\n');if(text===undefined||end===undefined||end<0)return undefined;
   try{return JSON.parse(text.slice(0,end));}catch{return undefined;}
  }});
  if(session.store?.session_file&&verified.session_file!==session.store.session_file)return {ok:false,reason:'pi session file changed since planning'};
  return {ok:true,store:verified};
 }catch(e){return {ok:false,reason:(e as Error).message};}
}

/** Rig/filesystem adapter. Contract compilation lives behind agents/public. */
import {readFileSync,lstatSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {resolveRigRoot} from '../../hub/rig-discovery.js';
import {validateProfile,type ProfileSourceSnapshot,type ProfileDiagnostic} from '../../agents/public/configuration.js';
const emptySnapshot:ProfileSourceSnapshot={values:[],diagnostics:[],overridden:[]};
interface CachedFile { stamp:string; text:string }
interface CachedRegistry { files:Map<string,CachedFile>; fingerprint:string; snapshot:ProfileSourceSnapshot }
// Bounded across rigs; the async snapshot keeps an in-flight pass alive even
// when another caller refreshes or evicts its workspace entry.
const workspaceCache=new Map<string,CachedRegistry>();
const snapshots=new AsyncLocalStorage<{root:string;snapshot:ProfileSourceSnapshot}>();
export function withAgentProfileSnapshot<T>(root:string, action:()=>T):T {
 root=path.resolve(root);
 return snapshots.run({root,snapshot:loadProfileSource(root)},action);
}
/** A frozen snapshot for one workspace. An invalid override disables that id,
 * rather than silently running the bundled contract in its place. */
export function loadProfileSource(root=resolveRigRoot()):ProfileSourceSnapshot {
 root=path.resolve(root);
 const active=snapshots.getStore();if(active?.root===root)return active.snapshot;
 const previous=workspaceCache.get(root);
 const directory=path.join(root,'.context-hub','agents'),values:unknown[]=[],diagnostics:ProfileDiagnostic[]=[];
 let files:string[];
 try {files=readdirSync(directory).filter(file=>file.endsWith('.json')).sort();}
 catch(e) {
  if((e as NodeJS.ErrnoException).code==='ENOENT'){workspaceCache.delete(root);return emptySnapshot;}
  return {values:[],overridden:[],diagnostics:[{id:'(workspace)',code:'PROFILE_INVALID',reason:`${directory}: ${(e as Error).message}`}]};
 }
 if(!files.length){workspaceCache.delete(root);return emptySnapshot;}
 const nextFiles=new Map<string,CachedFile>();
 const contents=files.map(file=>{
  const full=path.join(directory,file);
  try {
   const st=lstatSync(full);if(!st.isFile())throw Error('profile must be a regular JSON file');
   const stamp=[st.dev,st.ino,st.mode,st.size,st.mtimeMs,st.ctimeMs].join(':');
   const cached=previous?.files.get(file);
   const text=cached?.stamp===stamp?cached.text:readFileSync(full,'utf8');
   nextFiles.set(file,{stamp,text});return {file,text};
  }catch(e){return {file,error:(e as Error).message};}
 });
 const fingerprint=createHash('sha256').update(JSON.stringify(contents)).digest('hex');
 if(previous?.fingerprint===fingerprint){previous.files=nextFiles;return previous.snapshot;}
 const overridden=new Set<string>();
 for(const entry of contents) {
  const {file}=entry;
  let id=path.basename(file,'.json');
  try {
   const full=path.join(directory,file);
   if(entry.error!==undefined)throw Error(entry.error);
   const raw:unknown=JSON.parse(entry.text!);
   if(raw&&typeof raw==='object'&&'id' in raw&&typeof raw.id==='string')id=raw.id;
   overridden.add(id);
   // Keep malformed values in the registry so duplicate ids still fail closed.
   try {validateProfile(raw);values.push(raw);}
   catch(e) {values.push(raw);diagnostics.push({id,code:'PROFILE_INVALID',reason:`${full}: ${(e as Error).message}`});}
  } catch(e) {overridden.add(id);values.push({id});diagnostics.push({id,code:'PROFILE_INVALID',reason:`${path.join(directory,file)}: ${(e as Error).message}`});}
 }
 const snapshot:ProfileSourceSnapshot={values,diagnostics,overridden:[...overridden]};
 workspaceCache.delete(root);workspaceCache.set(root,{files:nextFiles,fingerprint,snapshot});
 if(workspaceCache.size>32)workspaceCache.delete(workspaceCache.keys().next().value!);
 return snapshot;
}

/** Explicit operation boundary for the public compiler; legacy registry caches stay independent. */
export async function readContractSource(root=resolveRigRoot()):Promise<ProfileSourceSnapshot> {
 // Legacy catalog reads do not load mutable config infrastructure.
 const {readConfigFile,configPath}=await import('../common/config.js');
 root=path.resolve(root);
 const profiles=loadProfileSource(root),outcome=await readConfigFile(path.join(root,'.context-hub'));
 const copy=structuredClone({...profiles,...(outcome.status==='ok'?{bindings:outcome.config.agent_bindings}:outcome.status==='invalid'?{bindingError:`cannot read agent_bindings: ${configPath(path.join(root,'.context-hub'))} is unreadable or corrupt`}:{})});
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
 freeze(copy);return copy;
}

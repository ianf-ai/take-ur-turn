/** Configuration port for setup. Task records remain exclusively in Hub Store. */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, lstat, writeFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import {checkSetupProfile,SetupRouteMismatch,type AgentProfile} from '../../agents/public/configuration.js';
export {SetupRouteMismatch};
import { RunStore } from '../run/store.js';

export class AgentSetupStore {
 readonly directory:string;
 constructor(readonly root:string,private readonly lock:()=>Promise<()=>void>=()=>new RunStore(root).lockAdmission()) {this.directory=path.join(root,'.context-hub','agents');}
 file(id:string):string {
  if(!/^[a-z][a-z0-9-]{0,63}$/u.test(id))throw Error('PROFILE_INVALID：id 需为小写字母开头，后接字母、数字或连字符，最多 64 字符');
  return path.join(this.directory,id+'.json');
 }
 async assertAvailable(id:string):Promise<void> {
  const target=this.file(id);let files:string[];
  try {
   if(!(await lstat(this.directory)).isDirectory())throw Error('PROFILE_INVALID：agents 必须是普通目录');
   files=await readdir(this.directory);
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  for(const file of files.filter(f=>f.endsWith('.json'))) {
   if(path.join(this.directory,file)===target)throw Error(`档案已存在：${target}；setup 不覆盖现有配置`);
   const full=path.join(this.directory,file);
   if(!(await lstat(full)).isFile())continue;
   let raw;try {raw=JSON.parse(await readFile(full,'utf8'));}catch {continue;}
   if(raw?.id===id)throw Error(`PROFILE_AMBIGUOUS：${file} 已声明 ${id}；请先人工核对配置`);
  }
 }
 check(profile:AgentProfile):void {
  checkSetupProfile(this.root,profile);
 }
 async install(profile:AgentProfile,signal?:AbortSignal):Promise<string> {
  signal?.throwIfAborted();
  // Join the existing rig-wide admission mutex: registry validation and
  // publication must be one transaction, including different profile ids.
  const unlock=await this.lock();
  try {
   signal?.throwIfAborted();
   this.check(profile);await this.assertAvailable(profile.id);
   await mkdir(this.directory,{recursive:true});
   const target=this.file(profile.id),temporary=target+'.'+randomUUID()+'.tmp';
   try {
    await writeFile(temporary,JSON.stringify(profile,null,2)+'\n',{mode:0o600,flag:'wx'});
    signal?.throwIfAborted();
    // Publish the complete file without replacing any existing configuration.
    await link(temporary,target);
   }finally {await unlink(temporary).catch(()=>undefined);}
   return target;
  }finally {unlock();}
 }
}

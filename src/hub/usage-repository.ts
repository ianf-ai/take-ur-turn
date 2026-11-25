/** The sole usage sidecar writer. The watcher supplies its bounded I/O ports
 * and retains the canonical-root lock through pending mutations. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export interface UsageIO {
 lstat(file:string):Promise<{isDirectory():boolean;isFile():boolean;isSymbolicLink():boolean}>;
 read(file:string):Promise<string>;
 write(file:string,bytes:string):Promise<unknown>;
 unlink(file:string):Promise<unknown>;
 rename(from:string,to:string):Promise<unknown>;
 allow(check:()=>Promise<boolean>):Promise<boolean>;
 validate(value:unknown):unknown;
}
function missing(e:unknown):boolean{return (e as NodeJS.ErrnoException).code==='ENOENT';}
export class UsageRepository {
 constructor(readonly root:string,private readonly io:UsageIO){}
 async taskDirectory(id:string):Promise<string> {
  if(!/^[a-z0-9][a-z0-9._-]*$/u.test(id)||id==='project')throw Error('unsafe_task_id');
  let current=this.root;
  for(const component of ['.context-hub','tasks',id]) {
   current=path.join(current,component);const st=await this.io.lstat(current);
   if(!st.isDirectory()||st.isSymbolicLink())throw Error('unsafe_task_directory');
  }
  return current;
 }
 async readDirectory(dir:string):Promise<unknown|null> {
  const file=path.join(dir,'usage.json');
  try{const st=await this.io.lstat(file);if(!st.isFile()||st.isSymbolicLink())throw Error('unsafe_usage_file');return this.io.validate(JSON.parse(await this.io.read(file)));}
  catch(e){if(missing(e))return null;throw e;}
 }
 async read(id:string):Promise<unknown|null>{return this.readDirectory(await this.taskDirectory(id));}
 async commit(id:string,value:unknown,mayCommit:()=>Promise<boolean>=async()=>true):Promise<boolean> {
  const dir=await this.taskDirectory(id),file=path.join(dir,'usage.json');
  await this.readDirectory(dir);
  const bytes=JSON.stringify(this.io.validate(value),null,2)+'\n';
  try{if(await this.io.read(file)===bytes)return false;}catch(e){if(!missing(e))throw e;}
  if(!await this.io.allow(mayCommit))return false;
  const tmp=path.join(dir,`.usage-${process.pid}-${randomUUID()}.tmp`);
  try {
   await this.io.write(tmp,bytes);
   if(!await this.io.allow(mayCommit))return false;
   await this.taskDirectory(id);await this.io.rename(tmp,file);return true;
  }finally{await this.io.unlink(tmp).catch(e=>{if(!missing(e))throw e;});}
 }
}

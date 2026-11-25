/** Bounded read-only I/O; native interpretation stays behind agents/public. */
import {open,readdir,realpath} from 'node:fs/promises';
import os from 'node:os';
import type {SessionReadServices} from '../../agents/public/index.js';

export function sessionReadServices(facts:{nativeSessionBase?:string|undefined;env?:NodeJS.ProcessEnv|undefined}={}):SessionReadServices {
 return {
  home:os.homedir(),
  env:Object.freeze({...facts.env??process.env}),
  ...(facts.nativeSessionBase?{nativeSessionBase:facts.nativeSessionBase}:{}),
  entries:directory=>readdir(directory),
  realpath,
  async readHead(file,maxBytes) {
   const fd=await open(file,'r');
   try {
    if(!(await fd.stat()).isFile())return undefined;
    const bytes=Buffer.alloc(maxBytes);
    const {bytesRead}=await fd.read(bytes,0,maxBytes,0);
    return bytes.subarray(0,bytesRead).toString('utf8');
   } finally {await fd.close();}
  }
 };
}

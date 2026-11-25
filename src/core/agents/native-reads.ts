/** Bounded native-file reads; interpretation belongs to agents. */
import {closeSync,fstatSync,openSync,readSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import os from 'node:os';
import type {NativeReadPort} from '../../agents/public/configuration.js';
export const nativeReads:NativeReadPort={
 head(file){let fd:number|undefined;try{fd=openSync(file,'r');const bytes=Buffer.alloc(8192);const n=readSync(fd,bytes,0,bytes.length,0);return bytes.subarray(0,n).toString('utf8');}catch{return undefined;}finally{if(fd!==undefined)closeSync(fd);}},
 home:()=>os.homedir(),platform:()=>process.platform,entries:readdirSync,realpath:realpathSync,
 readSettings(file){try{return readFileSync(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}},
 header(file){let fd:number|undefined;try{fd=openSync(file,'r');if(!fstatSync(fd).isFile())return undefined;const bytes=Buffer.alloc(8192);const n=readSync(fd,bytes,0,bytes.length,0);const end=bytes.subarray(0,n).indexOf(10);if(end<0)return undefined;return JSON.parse(bytes.subarray(0,end).toString('utf8'));}catch{return undefined;}finally{if(fd!==undefined)closeSync(fd);}}
};

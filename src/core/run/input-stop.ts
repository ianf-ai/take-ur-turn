import {assertRunIdentity} from './validation.js';
import {randomBytes} from 'node:crypto';
import type {RunStore} from './store.js';
import type {RunMeta} from './meta.js';
/** The owning supervisor initiates the existing stop ladder; never a foreign PID. */
export async function stopAfterInputFailure(store:RunStore,id:string,initial:RunMeta):Promise<RunMeta> {
 return store.updateMeta(id,m=>{
  assertRunIdentity(m,initial);
  if(m.stop_request||m.ended_at)return m;
  const at=new Date().toISOString(),by=`supervisor:pid=${process.pid}`;
  return {...m,status:'stopped',stopped_at:at,stopped_by:by,stop_request:{id:randomBytes(16).toString('hex'),requested_at:at,requested_by:by,phase:'requested',signals:[],actions:[]}};
 });
}

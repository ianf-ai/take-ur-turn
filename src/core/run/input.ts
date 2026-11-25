/** One bounded UTF-8 delivery. Completion proves bytes + EOF, never model consumption. */
import type { Writable } from 'node:stream';
import type {InvocationInput,InputDelivery} from './input-types.js';
export type {InvocationInput,InputDelivery} from './input-types.js';
export function validateInput(input:InvocationInput|undefined):void {
 if(input===undefined)return;
 if(input.kind==='none')return;
 if(input.kind!=='stdin'||input.encoding!=='utf8'||typeof input.text!=='string'||Buffer.byteLength(input.text,'utf8')>65536)throw Error('invalid or oversized invocation input (64 KiB limit)');
}
export function deliverInput(stream:Writable,text:string,budgetMs=30000) {
 const bytes=Buffer.byteLength(text,'utf8');
 let state:InputDelivery={status:'pending',bytes};
 const finish=(error?:string)=>{if(state.status!=='pending')return;state={status:error?'failed':'complete',bytes,...(error?{error}:{})};clearTimeout(timer);if(error)stream.destroy();};
 const timer=setTimeout(()=>finish('input write timeout'),budgetMs);
 // end() honors Writable backpressure and sends EOF after the buffered bytes.
 stream.on('error',error=>finish(error.message));
 stream.once('close',()=>{if(state.status==='pending')finish('input closed before delivery');});
 stream.end(Buffer.from(text,'utf8'),(error?:Error|null)=>finish(error?.message));
 return {get state(){return state;},cancel:(reason:string)=>finish(reason)};
}

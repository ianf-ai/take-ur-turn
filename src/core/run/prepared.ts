/** The OS runner consumes the prepared facts; old plain run requests remain compatible. */
import {decodeContract} from '../../agents/public/index.js';
import type {ReadyInvocation} from '../../agents/public/index.js';
import type {InvocationInput} from './input-types.js';
interface PreparedStart {invocation?:ReadyInvocation;argv:string[];cwd:string;profile?:string|null;input?:InvocationInput}
export function consumeInvocation<T extends PreparedStart>(request:T):T {
 const invocation=request.invocation;
 if(!invocation)return request;
 const argv=[invocation.executable,...invocation.argv];
 if(JSON.stringify(argv)!==JSON.stringify(request.argv)||invocation.cwd!==request.cwd||!request.profile)throw Error('prepared invocation differs from start request');
 const handle=decodeContract(request.profile);
 if(handle.key.id!==invocation.key.id||handle.key.digest!==invocation.key.digest||handle.key.revision!==invocation.key.revision)throw Error('prepared invocation contract mismatch');
 return {...request,argv,cwd:invocation.cwd,input:invocation.input};
}

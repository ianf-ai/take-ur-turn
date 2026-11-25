/** Compatibility exits only: parsing and token generation live in the interpreter. */
import { randomUUID } from 'node:crypto';
import { agentProfiles, type FrozenProfile } from './registry.js';
import { renderInvocation, type Failure } from './interpreter.js';
import {messages as codexMessages} from './native/codex/errors.js';
import {messages as piMessages} from './native/pi/errors.js';
import {messages as opencodeMessages} from './native/opencode/errors.js';
const messages:Record<string,Partial<Record<string,(f:Failure)=>string>>>={codex:codexMessages,pi:piMessages,opencode:opencodeMessages};
export function legacyFailure(profile:FrozenProfile,f:Failure):Error {return new Error(messages[profile.id]?.[f.code]?.(f)??`${f.code}: ${f.reason}`);}
export function profileArgv(route:{agent:string;args:readonly string[]},prompt:string,session?:string,profile=agentProfiles.match(route.agent)):string[] {
 if(!profile)throw new Error(`unsupported-headless-agent: ${route.agent}; detached launch unsupported; explicitly select launch_mode=tui`);
 const sessionId=profile.value.session.fresh_identity==='designated'?session??randomUUID():session;
 const result=renderInvocation({profile,mode:session?'resume':'run',route,checkoutRoot:'',prompt,...(sessionId!==undefined?{sessionId}:{})});
 if(result.status!=='ready')throw legacyFailure(profile,result);
 return [result.invocation.executable,...result.invocation.argv];
}
export function profileEnv(profile:FrozenProfile|undefined,cwd:string):Record<string,string> {
 const c=profile?.value.invoke.cwd;return c?.tier==='declarative'?Object.fromEntries(c.spec.env_sync.map(k=>[k,cwd])):{};
}

/** Historical parser exits and diagnostic wording live with the native grammar. */
import {agentProfiles,type FrozenProfile} from '../registry.js';
import {parsePlain,PlainArgvError} from './plain.js';
import {legacyFailure} from '../legacy.js';
export class SessionContractError extends Error {
 constructor(message:string,readonly reason:string){super(message);this.name='ResumeError';}
}
export function plainSessionFailure(profile:FrozenProfile,error:unknown):{code:string;reason:string} {
 if(!(error instanceof PlainArgvError))throw error;
 const agent=profile.id,e=error,base=`unsupported plain ${agent} argv`;
 const messages:Record<string,string>={
  MISSING_VALUE:`${base}: missing value for ${e.token}`,
  OPTION:profile.value.invoke.route==='codex'?`${base} option: ${e.token} (unknown option — refusing to guess its scope)`:`${base} option: ${e.token}`,
  POSITIONALS:`${base}: ${e.count} positional arguments — cannot tell prompt from session selectors`,
  SHAPE:`${base}: expected run <options> [--session <id>] -- <prompt>`,
  ROUTE:`${base}: ${e.failure?legacyFailure(profile,e.failure).message:''}`,
  DUPLICATE_SELECTOR:`${base}: duplicate --session-id`,SELECTOR_ID:`${base}: --session-id without an exact uuid`,
  SELECTOR:`${base} selector: ${e.token} (only TUT-built --session-id forms are resumable)`,
  POSITIONAL:`${base} positional: ${e.token} (only the trailing prompt after -- is positional)`,
  IDENTITY_MISSING:`plain ${agent} run carries no exact --session-id identity; not resumable`,
  SELECTOR_TAIL:`${base}: tokens between --session-id and the prompt separator`
 };
 return {code:e.code==='IDENTITY_MISSING'?`${agent}-identity-unavailable`:`${agent}-argv-unrecoverable`,reason:messages[e.code]??e.message};
}
function legacyPlain(agent:string,argv:readonly string[]) {
 const profile=agentProfiles.get(agent)!;
 try{return parsePlain(profile,argv);}catch(error){const failure=plainSessionFailure(profile,error);throw new SessionContractError(failure.reason,failure.code);}
}
export interface PlainCodexParse {agent:string;optionTokens:string[]}
export interface PlainPiParse {agent:string;head:string[];session_id:string}
export interface PlainOpencodeParse {agent:string;optionTokens:string[]}
export function parsePlainCodexArgv(argv:readonly string[]):PlainCodexParse {const p=legacyPlain('codex',argv);return {agent:p.agent,optionTokens:p.optionTokens};}
export function parsePlainOpencodeArgv(argv:readonly string[]):PlainOpencodeParse {const p=legacyPlain('opencode',argv);return {agent:p.agent,optionTokens:p.optionTokens};}
export function parsePlainPiArgv(argv:readonly string[]):PlainPiParse {const p=legacyPlain('pi',argv);return {agent:p.agent,head:p.head,session_id:p.session_id!};}

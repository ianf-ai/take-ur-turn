/** Conservative parsers for historical native argv, independent of managed templates. */
import type { FrozenProfile } from '../registry.js';
import { stringMatches, type Failure } from '../projection.js';
import { parseRoute, selects, codexRootValues, codexRootFlags, codexSharedValues, codexSharedFlags, piValues } from './route.js';
export interface PlainArgs {agent:string;optionTokens:string[];head:string[];session_id?:string}
export class PlainArgvError extends Error {
 constructor(readonly code:string,readonly token='',readonly count=0,readonly failure?:Failure){super(code);}
}
export function parsePlain(profile:FrozenProfile,argv:readonly string[]):PlainArgs {
 const c=profile.value.session.legacy_plain_argv;
 if(c.tier!=='declarative')throw new PlainArgvError('UNSUPPORTED');
 const policy=c.spec,agent=argv[0]!,optionTokens:string[]=[],head:string[]=[];
 const bad=(code:string,token='',count=0):never=>{throw new PlainArgvError(code,token,count);};
 if(policy==='opencode') {
  const separator=argv.indexOf('--',2);
  if(argv[1]!=='run'||separator<2||argv.length!==separator+2)bad('SHAPE');
  optionTokens.push(...argv.slice(2,separator));
  if(optionTokens.at(-2)==='--session'&&stringMatches(optionTokens.at(-1),profile.value.session.id_validation))optionTokens.splice(-2);
  const r=parseRoute(profile.value.invoke.route,optionTokens);
  if(r.status!=='ready')throw new PlainArgvError('ROUTE','',0,r);
  return {agent,optionTokens,head};
 }
 let sessionIndex=-1,sawCommand=false,positionals=0;
 for(let i=1;i<argv.length;i++) {
  const token=argv[i]!;
  if(policy==='pi'&&token==='--')break;
  if(policy==='codex') {
   if(token==='exec'&&!sawCommand){sawCommand=true;continue;}
   if(token==='resume')continue;
  }
  if(policy==='pi'&&token==='--session-id') {
   if(sessionIndex!==-1)bad('DUPLICATE_SELECTOR');
   sessionIndex=i;const id=argv[++i];
   if(!stringMatches(id,profile.value.session.id_validation))bad('SELECTOR_ID');continue;
  }
  if(selects(token,policy))bad('SELECTOR',token);
  const name=policy==='codex'?token.split('=',1)[0]!:token;
  const values=policy==='codex'?[...codexRootValues,...codexSharedValues,'--color']:[...piValues,'--mode'];
  const flags=policy==='codex'?[...codexRootFlags.filter(n=>n!=='--dangerously-bypass-approvals-and-sandbox'),...codexSharedFlags]:['--print','-p'];
  if(values.includes(name)||flags.includes(name)) {
   optionTokens.push(token);
   if(values.includes(name)&&!token.includes('=')){const v=argv[++i];if(v===undefined)bad('MISSING_VALUE',name);optionTokens.push(v!);}
   continue;
  }
  if(token.startsWith('-'))bad('OPTION',token);
  if(policy==='pi')bad('POSITIONAL',token);
  positionals++;
 }
 if(policy==='codex') {
  if(positionals>(argv.includes('resume')?2:1))bad('POSITIONALS','',positionals);
  return {agent,optionTokens,head};
 }
 if(sessionIndex===-1)bad('IDENTITY_MISSING');
 if(argv[sessionIndex+2]!=='--')bad('SELECTOR_TAIL');
 return {agent,optionTokens,head:argv.slice(0,sessionIndex),session_id:argv[sessionIndex+1]!};
}

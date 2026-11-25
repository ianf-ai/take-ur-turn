import path from 'node:path';
import { windowsPiRouteArgs } from './native/pi/windows-session.js';
import { parsePlain, PlainArgvError } from './native/plain.js';
import type { InvokeInput, Invocation } from './runtime-contract.js';
/** Finite argv and JSON-line interpreters. No process or Hub side effects. */
import type { FrozenProfile } from './registry.js';
export { valueAt, guardsMatch, stringMatches, type Failure } from './projection.js';
import { valueAt, guardsMatch, stringMatches, type Failure } from './projection.js';
import { parseRoute } from './native/route.js';
import { commandWords } from './template.js';
const fail=(code:string,token='',option=token):Failure=>({status:'invalid',code,reason:code,token,option});
export function renderInvocation(input:{profile:FrozenProfile;mode:'run'|'resume';route:{agent:string;args:readonly string[]};checkoutRoot:string;prompt:string;sessionId?:string}): {status:'ready';invocation:{executable:string;argv:string[];cwd:string;envPatch:Record<string,string>}}|Failure {
 const {profile,mode,route}=input,p=profile.value,c=p.invoke[mode];
 if(c.tier!=='declarative')return {status:'unsupported',code:'CAPABILITY_UNSUPPORTED',reason:c.tier==='unsupported'?c.reason:'invoke-hook-unavailable'};
 if(p.invoke.cwd.tier!=='declarative')return {status:'unsupported',code:'CAPABILITY_UNSUPPORTED',reason:'cwd-unavailable'};
 const parsed=parseRoute(p.invoke.route,route.args);if(parsed.status!=='ready')return parsed;
 // Only observed-native selectors previously validated by the old parser gain
 // an explicit managed grammar check (Codex historically accepts any string).
 if(input.sessionId!==undefined&&p.session.legacy_plain_argv.tier==='declarative'&&p.session.legacy_plain_argv.spec==='opencode'&&!stringMatches(input.sessionId,p.session.id_validation)&&p.session.resume_identity==='observed')return fail('SESSION_ID');
 // Native parsers know which words are options and which are consumed values.
 const optionIndices=parsed.optionIndices?new Set(parsed.optionIndices):undefined;
 const bound=(binding:typeof p.invoke.model):string[]=>{
  if(binding.tier!=='declarative')return [];
  let result:string[]=[];
  for(let i=0;i<route.args.length;i++) {
   if(optionIndices&&!optionIndices.has(i))continue;
   const token=route.args[i]!,name=token.split('=',1)[0]!;
   const n=binding.spec.names.find(n=>n===name||n.length===2&&!token.startsWith('--')&&token.startsWith(n));
   if(!n)continue;
   let value=token===n?route.args[++i]:token.slice(n.length+(token[n.length]==='='?1:0));
   if(binding.spec.syntax==='config-assignment') {
    const prefix=binding.spec.key+'=';if(!value?.startsWith(prefix))continue;value=value.slice(prefix.length);
   }
   if(value!==undefined)result=[value];
  }
  return result;
 };
 const slots:Record<string,string[]>={...parsed.groups,executable:[route.agent],prompt:[input.prompt],cwd:[input.checkoutRoot],session:input.sessionId===undefined?[]:[input.sessionId],model:bound(p.invoke.model),effort:bound(p.invoke.effort)};
 const argv:string[]=[];
 for(const word of commandWords(c.spec).slice(1)) {
  if(!word.startsWith('{')){argv.push(word);continue;}
  const key=word.slice(1,-1),values=slots[key]??[];
  if(!values.length&&['session','model','effort'].includes(key))return fail(key==='session'?'SESSION_ID_REQUIRED':'TEMPLATE_VALUE_REQUIRED',key);
  argv.push(...values);
 }
 const envPatch=Object.fromEntries(p.invoke.cwd.spec.env_sync.map(k=>[k,input.checkoutRoot]));
 return {status:'ready',invocation:{executable:route.agent,argv,cwd:input.checkoutRoot,envPatch}};
}

function sameRoute(a:{agent:string;args:readonly string[]},b:{agent:string;args:readonly string[]}):boolean {
 return a.agent===b.agent&&JSON.stringify(a.args)===JSON.stringify(b.args);
}
export async function invoke(input:InvokeInput):Promise<{status:'ready';invocation:Invocation}|Failure> {
 const {profile,platform,route,checkoutRoot,sessionRef,environmentFacts:facts}=input;
 const p=profile.value,paths=platform==='win32'?path.win32:path.posix;
 if(!['run','resume'].includes(input.mode)||!['auto','manual'].includes(input.entry)||!['managed','plain-legacy'].includes(input.origin)||!facts||!route||typeof route.agent!=='string'||!Array.isArray(route.args)||!route.args.every(a=>typeof a==='string')||typeof input.prompt!=='string')return fail('INVOCATION_FACTS_INVALID');
 const capability=p.invoke[input.mode];
 if(capability.tier==='unsupported')return {status:'unsupported',code:'CAPABILITY_UNSUPPORTED',reason:capability.reason};
 if(platform!==profile.platform)return fail('PROFILE_PLATFORM_MISMATCH');
 if(typeof checkoutRoot!=='string'||typeof facts.home!=='string'||!paths.isAbsolute(checkoutRoot)||!paths.isAbsolute(facts.home))return fail('INVOCATION_CWD_INVALID');
 const matches=platform==='win32'
  ? !!facts.windows_target&&!!p.match.platform_target_identity&&facts.windows_target.agent===p.match.platform_target_identity.win32
  : p.match.supported_executable_names.includes(path.posix.basename(route.agent));
 if(!matches)return fail('PROFILE_ROUTE_MISMATCH');
 if(input.origin==='plain-legacy'&&(input.mode!=='resume'||input.entry!=='manual'))return fail('PLAIN_ORIGIN_INVALID');
 let identity:'observed'|'designated'|'argv'=p.session.resume_identity;
 let id:string|undefined;
 if(input.mode==='resume') {
  if(!sessionRef)return fail('SESSION_SOURCE_REQUIRED');
  const key=sessionRef.profile;
  if(!key||key.id!==profile.id||key.revision!==profile.revision||key.digest!==profile.digest)return fail('SESSION_PROFILE_MISMATCH');
  if(!sessionRef.route||!sameRoute(sessionRef.route,route)||sessionRef.cwd!==checkoutRoot||sessionRef.agent!==profile.id)return fail('SESSION_BINDING_MISMATCH');
  const evidence=sessionRef.evidence;
  if(typeof sessionRef.source_run_id!=='string'||!sessionRef.source_run_id||evidence?.via!=='RunStore'||evidence.run_id!==sessionRef.source_run_id)return fail('SESSION_SOURCE_INVALID');
  identity=sessionRef.identity_source;
  if(!['observed','designated','argv'].includes(identity))return fail('SESSION_IDENTITY_MISMATCH');
  const field=identity==='observed'?'agent_session_id':identity==='argv'?'plain-selector':'headless.designated_session_id';
  if(evidence.field!==field||input.origin==='managed'&&identity!==p.session.resume_identity)return fail('SESSION_IDENTITY_MISMATCH');
  if(typeof sessionRef.session_id!=='string'||!sessionRef.session_id)return fail('SESSION_ID');
  id=sessionRef.session_id;
 } else if(p.session.fresh_identity==='designated') {
  id=facts.designated_id;
  if(typeof id!=='string'||!id)return fail('SESSION_ID_REQUIRED');
  identity='designated';
 } else identity='observed';
 let rendered:ReturnType<typeof renderInvocation>;
 if(input.origin==='plain-legacy') {
  if(!input.plain||!Array.isArray(input.plain.argv))return fail('PLAIN_SOURCE_REQUIRED');
  if(input.plain.source_run_id!==sessionRef!.source_run_id)return fail('PLAIN_SOURCE_MISMATCH');
  let parsed;
  try{parsed=parsePlain(profile,input.plain.argv);}catch(e){if(e instanceof PlainArgvError)return e.failure??fail('PLAIN_ARGV_INVALID',e.token);return fail('PLAIN_ARGV_INVALID');}
  const grammar=p.session.legacy_plain_argv;
  if(grammar.tier!=='declarative')return {status:'unsupported',code:'CAPABILITY_UNSUPPORTED',reason:'plain-argv-unavailable'};
  const preserve=grammar.spec==='pi';
  const projection={agent:parsed.agent,args:preserve?parsed.head.slice(1):parsed.optionTokens};
  if(!sameRoute(projection,route)||parsed.agent!==input.plain.argv[0])return fail('PLAIN_ROUTE_MISMATCH');
  if(preserve) {
   if(identity!=='argv'||parsed.session_id!==id)return fail('PLAIN_IDENTITY_MISMATCH');
   rendered={status:'ready',invocation:{executable:parsed.head[0]!,argv:[...parsed.head.slice(1),'--session-id',id!,'--',input.prompt],cwd:checkoutRoot,envPatch:{}}};
  } else {
   if(identity!=='observed')return fail('PLAIN_IDENTITY_MISMATCH');
   rendered=renderInvocation({profile,mode:'resume',route,checkoutRoot,prompt:input.prompt,sessionId:id!});
  }
 } else {
  const cwd=p.invoke.cwd;
  const prepared=platform==='win32'&&cwd.tier==='declarative'&&cwd.spec.prepare.tier==='assisted'&&cwd.spec.prepare.hook==='pi-windows-location-v1'
   ? {...route,args:windowsPiRouteArgs(route.args).args}:route;
  rendered=renderInvocation({profile,mode:input.mode,route:prepared,checkoutRoot,prompt:input.prompt,...(id!==undefined?{sessionId:id}:{})});
 }
 if(rendered.status!=='ready')return rendered;
 const cwd=p.invoke.cwd;
 if(cwd.tier!=='declarative')return {status:'unsupported',code:'CAPABILITY_UNSUPPORTED',reason:'cwd-unavailable'};
 return {status:'ready',invocation:{...rendered.invocation,envPatch:Object.fromEntries(cwd.spec.env_sync.map(k=>[k,checkoutRoot])),sessionPlan:{
  identity_source:identity,...(p.session.fresh_identity==='designated'&&id!==undefined?{designated_id:id}:{}),...(input.mode==='resume'?{expected_id:id!}:{}),
  capture:p.session.capture,...(sessionRef?.store?{store:sessionRef.store}:{}),
  ...(sessionRef?{resume_provenance:{from_run_id:sessionRef.source_run_id,identity}}:{}),
  admission:{agent:profile.id,...(id!==undefined?{session_id:id}:{}),selectors:p.session.legacy_plain_argv.tier==='declarative'?p.session.legacy_plain_argv.spec:null}
 }}};
}
export function captureSession(profile:FrozenProfile,line:string):string|undefined {
 const c=profile.value.session.capture;if(c.tier!=='declarative'||line.length>c.spec.max_line_chars)return undefined;
 const r=c.spec;
 try {
  if(r.kind==='json-line'){const event:unknown=JSON.parse(line);const id=valueAt(event,r.path);return guardsMatch(event,r.guards)&&stringMatches(id,r.rule)?id:undefined;}
  const match=new RegExp(r.pattern.pattern,r.pattern.flags).exec(line);const id=match?.[r.group];return id!==undefined&&id.length<=r.pattern.max_length?id:undefined;
 }catch{return undefined;}
}

/** Infer data contracts from operator samples, without a native-agent catalog. */
import path from 'node:path';
import { commandWords } from './template.js';
import { profileSchema, validateProfile } from './schema.js';
import { captureSession } from './interpreter.js';
import { ProfileRegistry } from './registry.js';
import type { AgentProfile, ExtractionRule, Guard, PathRef, RoutePolicy, UsageContract } from './types.js';

export type SetupQuestion = 'run' | 'resume' | 'session' | 'usage';
export class SetupSampleError extends Error {
 constructor(readonly question:SetupQuestion,message:string) {super(message);}
}
export interface CommandSample { executable:string; words:string[]; route?:RoutePolicy }
const projections=['{args}','{options}','{root}','{parent}','{shared}','{nonroot}'];
export function parseCommandSample(sample:string,question:'run'|'resume'):CommandSample {
 try {
  // The shared template language has no shell escaping, expansion or pipelines.
  if(/[\\`$|;&<>\r\n]/u.test(sample))throw Error('不支持 shell 转义、变量、管道或重定向；请粘贴一条直接调用 CLI 的命令');
  const words=commandWords(sample);
  // Optional operator declaration, not executable-name recognition. Policies
  // and allowed slots are still owned by the existing profile schema.
  let route:RoutePolicy|undefined;
  if(words[0]!.startsWith('@'))route=profileSchema.shape.invoke.shape.route.parse(words.shift()!.slice(1));
  if(!words.length||!words[0])throw Error('规则声明后需要原生 CLI 命令');
  if(words[0]!.startsWith('{')||words[0]!.includes('='))throw Error('开头需要原生 CLI 可执行文件，不能是环境赋值或占位符');
  if(words.filter(w=>w==='TUT_PROMPT'||w==='{prompt}').length!==1)throw Error('请把提示词替换为 TUT_PROMPT，并让它单独占一个参数（可加引号）');
  if(words.some(w=>w.includes('TUT_PROMPT')&&w!=='TUT_PROMPT'))throw Error('TUT_PROMPT 必须单独占一个参数，不能写成 --prompt=TUT_PROMPT');
  if(words.some(w=>w.includes('TUT_SESSION')&&w!=='TUT_SESSION'))throw Error('TUT_SESSION 必须单独占一个参数，不能写成 --session=TUT_SESSION');
  const normalized=words.map(w=>w==='TUT_PROMPT'?'{prompt}':w==='TUT_SESSION'?'{session}':w);
  const slots=normalized.filter(w=>w.startsWith('{'));
  if(slots.some(w=>['{executable}','{model}','{effort}'].includes(w)))throw Error('该占位符需要额外的 executable/model/effort 绑定声明');
  if(question==='run'&&(!route||route==='passthrough')&&slots.some(w=>!['{prompt}','{session}','{args}','{options}','{cwd}'].includes(w)))throw Error('作用域或原生默认槽需要在 run 样例前用 @<route> 显式声明规则');
  if(new Set(slots).size!==slots.length||slots.includes('{args}')&&slots.includes('{options}'))throw Error('占位符重复或参数集合重叠，请只保留一个插值位置');
  if(route&&route!=='passthrough'&&!normalized.some(w=>projections.includes(w)))throw Error('已声明原生参数规则；请在样例中明确标记参数分组位置，不能猜测作用域');
  template(normalized); // Check that fixed words can round-trip through the existing language.
  return {executable:words[0]!,words:normalized,...(route?{route}:{})};
 }catch(e){throw new SetupSampleError(question,`没看懂 ${question} 样例：${(e as Error).message}`);}
}
function leaves(value:unknown,at:PathRef=[]):{path:PathRef;value:string}[] {
 if(typeof value==='string')return [{path:at,value}];
 if(!value||typeof value!=='object')return [];
 return Object.entries(value).flatMap(([key,v])=>leaves(v,[...at,Array.isArray(value)?Number(key):key]));
}
function quote(word:string):string {
 if(word==='')return "''";
 if(!/[\s'"]/u.test(word))return word;
 if(!word.includes("'"))return `'${word}'`;
 if(!word.includes('"'))return `"${word}"`;
 throw Error('一个参数同时含两种引号；现有模板无法无损表达，请简化样例');
}
function template(words:string[]):string {
 const result=[...words];
 if(!result.some(w=>projections.includes(w))) {
  const separator=result.indexOf('--'),prompt=result.indexOf('{prompt}');
  result.splice(separator<0?prompt:separator,0,'{args}');
 }
 return result.map(quote).join(' ');
}
export function unsupportedUsage():UsageContract {
 return {capability:{tier:'unsupported',reason:'operator-skipped-usage'},readable_formats:[],source:null,
  attribution:'exact-session-window-v1',accounting:null,cost:{kind:'unavailable',reason:'operator-skipped-usage'}};
}
/** A path answer supplies the existing declarative usage contract, never code. */
export function declarationUsage(raw:unknown):UsageContract {
 const value=raw as UsageContract;
 if(!value||value.capability?.tier!=='declarative')throw new SetupSampleError('usage','usage 文件必须声明 declarative 的 source、accounting、attribution、cost；不能用路径猜计数语义或加载 hook');
 return value;
}
export function inferProfile(id:string,run:CommandSample,resume:CommandSample,output:string,usage=unsupportedUsage()):AgentProfile {
 if(run.executable!==resume.executable)throw new SetupSampleError('resume','run 与 resume 的可执行文件不同，请使用同一个原生 CLI');
 const route=run.route??'passthrough';
 if(resume.route&&resume.route!==route)throw new SetupSampleError('resume','resume 的参数规则必须与 run 的显式声明一致');
 for(const [question,sample] of [['run',run],['resume',resume]] as const) {
  if(route!=='passthrough'&&!sample.words.some(w=>projections.includes(w)))throw new SetupSampleError(question,'请标记额外参数的分组位置；原生参数规则不会把所有参数猜放到提示词前');
 }
 let event:unknown;
 try {event=JSON.parse(output);}catch {throw new SetupSampleError('session','没看懂 session 样例：需要一行完整 JSON 输出（不是日志路径）；请保留原字段，把会话 ID 标成 TUT_SESSION，或使用 resume 中的真实 ID');}
 const values=leaves(event).filter(v=>v.path.length>0);
 const marked=values.filter(v=>v.value==='TUT_SESSION');
 let candidates=marked.length?marked:values.filter(v=>resume.words.includes(v.value)&&!['{prompt}','{session}'].includes(v.value));
 if(!candidates.length&&values.some(v=>resume.words.some(w=>w.startsWith('-')&&w!==v.value&&w.endsWith('='+v.value))))throw new SetupSampleError('resume','resume 中的会话 ID 嵌在选项内；请改成独立参数，例如 --session TUT_SESSION，现有模板不支持局部插值');
 // Streaming events often repeat the same identity in nested payloads. A
 // unique shallowest occurrence of that one value needs no extra question.
 if(candidates.length>1&&new Set(candidates.map(v=>v.value)).size===1) {
  const depth=Math.min(...candidates.map(v=>v.path.length));candidates=candidates.filter(v=>v.path.length===depth);
 }
 if(candidates.length!==1)throw new SetupSampleError('session',`没看懂 session 样例：找到 ${candidates.length} 个会话 ID 候选；请仅把会话 ID 那个值替换为 TUT_SESSION`);
 const selected=candidates[0]!;
 if(!resume.words.includes('{session}')&&!resume.words.includes(selected.value))throw new SetupSampleError('resume','resume 中找不到独立的会话 ID 参数；请把它替换为 TUT_SESSION（不支持 --session=ID 形式）');
 const resumeWords=resume.words.map(w=>w===selected.value?'{session}':w);
 if(resumeWords.filter(w=>w==='{session}').length!==1)throw new SetupSampleError('resume','resume 必须且只能有一个独立的会话 ID 参数');
 const runWords=run.words.map(w=>w===selected.value?'{session}':w);
 if(runWords.filter(w=>w==='{session}').length>1)throw new SetupSampleError('run','run 有多个会话 ID 位置，无法判断新会话的指定方式');
 const designated=runWords.includes('{session}');
 // Do not infer a provider-specific id grammar from one example.
 const rule={pattern:'^[a-zA-Z0-9_-]{1,256}$',flags:'u' as const,max_length:256};
 const guards:Guard[]=[{path:selected.path,op:'string'}];
 if(event&&typeof event==='object'&&!Array.isArray(event)&&'type' in event&&typeof event.type==='string'&&event.type!=='TUT_SESSION')guards.unshift({path:['type'],op:'eq',value:event.type});
 const capture:ExtractionRule={kind:'json-line',guards,path:selected.path,rule,max_line_chars:1048576,first:'legacy-first-buffer'};
 const p:AgentProfile={schema_version:2,id,revision:`setup-${Date.now()}`,
  evidence:{baseline_commit:'operator-samples',native_versions:[],platforms:['posix'],references:[],note:'Inferred from operator run/resume/session samples; validated by native probe before installation.'},
  match:{supported_executable_names:[path.basename(run.executable)],platform_target_identity:null},
  invoke:{run:{tier:'declarative',spec:template(runWords)},resume:{tier:'declarative',spec:template(resumeWords)},route,
   model:{tier:'unsupported',reason:'binding-not-declared'},effort:{tier:'unsupported',reason:'binding-not-declared'},
   cwd:{tier:'declarative',spec:{spawn:'checkoutRoot',env_sync:['PWD'],native_precedence:['process.cwd','native-default'],path:'host-resolve',prepare:{tier:'declarative',spec:{kind:'none'}}}}},
  session:{fresh_identity:designated?'designated':'native-observed',capture:{tier:'declarative',spec:capture},id_validation:rule,resume_identity:'observed',
   verify_resume:{tier:'declarative',spec:{kind:'observed-identity',store:'not-required'}},legacy_plain_argv:{tier:'unsupported',reason:'plain-argv-not-declared'}},
  usage,platform_overrides:{}};
 try {validateProfile({...p,invoke:{...p.invoke,resume:{tier:'unsupported',reason:'validate-run'}},usage:unsupportedUsage()});}catch(e){throw new SetupSampleError('run',`PROFILE_INVALID：run 模板或参数规则无效：${(e as Error).message}；作用域槽需在 run 前用 @<route> 显式声明现有规则`);}
 try {validateProfile({...p,usage:unsupportedUsage()});}catch(e){throw new SetupSampleError('resume',`PROFILE_INVALID：resume 模板或参数规则无效：${(e as Error).message}`);}
 try {validateProfile(p);}catch(e){throw new SetupSampleError('usage',`PROFILE_INVALID：${(e as Error).message}`);}
 const profile=new ProfileRegistry([p]).get(id);
 if(!profile)throw new SetupSampleError('session','PROFILE_INVALID：无法创建 session 捕获规则');
 if(selected.value!=='TUT_SESSION'&&captureSession(profile,output)!==selected.value)throw new SetupSampleError('session','session ID 格式无法由现有安全规则表示；支持字母、数字、下划线和连字符，最多 256 字符');
 return p;
}

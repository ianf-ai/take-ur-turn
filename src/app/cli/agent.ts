import {validateInvocationBinding} from '../../agents/public/configuration.js';
import {readDeclaration} from './agent-declaration.js';
import {encodeContract} from '../../agents/public/index.js';
import '../agents.js';
import {contractSource,withContractBindings,resolveContract,type ContractHandle} from '../../agents/public/index.js';
import {probeProfile,probeDefaultRoute,probeArtifact,probeSession} from '../../agents/public/probe.js';
import {readProbeUsage,usageProbeRoot,type ReadServices} from '../../agents/public/usage.js';

import { writeAgentBinding } from "../../core/common/config.js";
import type { AgentBinding } from "../../core/common/config-intent.js";

/** Save invocation declarations without launching the agent. */
export async function runAgentAdd(id: string, binding: AgentBinding | {from:string}): Promise<number> {
  try {
    const root = path.join(resolveRigRoot(), ".context-hub");
    const declaration="from" in binding ? validateInvocationBinding(await readDeclaration(binding.from),id) : binding;
    await writeAgentBinding(root, id, declaration);
    process.stdout.write(`agent: saved ${id} invocation declaration (${path.join(root, "config.json")})\n`);
    process.stdout.write(`Next: tut assign executor binding:${id}\nThen: tut start-next <task-id>\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`tut: agent add: ${(error as Error).message}\n`);
    return 1;
  }
}

/** Native contract smoke checks. All run/task evidence stays in a new external rig. */
import { constants, closeSync, readFileSync, readSync, fstatSync } from 'node:fs';
import { access, mkdtemp, mkdir, writeFile, readdir, readFile, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { resolveRigRoot } from '../../hub/rig-discovery.js';
import { Store } from '../../hub/store.js';
import { RunStore, complete, delay, type RunMeta } from '../../core/run/store.js';
import { startRun, stopRun, StartRunError } from '../../core/run/control.js';
import { planResume } from '../../core/run/resume.js';
import { buildHeadlessPlan } from '../../standalone/launcher-detached/plan.js';
import type { AgentProfile } from '../../agents/public/configuration.js';
import { resolveAgentRoute } from '../../core/common/workspace.js';
import { normalizeAgentRoute } from '../../protocol/agent-command.js';

export interface ProbeCheck { name:'fresh'|'session'|'resume'|'usage'; ok:boolean; reason:string; status?:'passed'|'failed'|'skipped'|'unavailable' }
export interface ProbeReport { id:string; checks:ProbeCheck[]; evidence?:string; profile?:{revision:string;digest:string} }
const exec=promisify(execFile);
const names=['fresh','session','resume','usage'] as const;
const message=(e:unknown)=>e instanceof Error?e.message:String(e);

async function executableOnPath(executable:string,root:string,env:NodeJS.ProcessEnv):Promise<string> {
 if(process.platform==='win32')return executable; // native target resolver owns PATHEXT/wrappers
 const candidates=path.isAbsolute(executable)||executable.includes(path.sep)?[path.resolve(root,executable)]
  :(env.PATH??'').split(path.delimiter).map(dir=>path.resolve(root,dir,executable));
 for(const file of candidates)try {await access(file,constants.X_OK);return file;}catch { /* next */ }
 throw Error(`找不到可执行文件 ${executable}；请安装原生 CLI 或修正 PATH / workspace 角色命令`);
}
async function probeRoute(profile:ContractHandle,root:string,env:NodeJS.ProcessEnv) {
 const snapshot=contractSource(root);
 for(const role of ['executor','architect','reviewer']) {
  const route=normalizeAgentRoute(await resolveAgentRoute(role,undefined,{projectRoot:root}));
  let verifiedTarget:string|undefined;
  if(profile.platform==='win32') {
   try {verifiedTarget=(await (await import('../../standalone/launcher-detached/windows-target.js')).resolveDetachedWindowsTarget(route.agent,env)).agent;}
   catch {continue;}
  }
  const selected=resolveContract({agent:route.agent,...(verifiedTarget?{verifiedTarget}:{})},snapshot,profile.platform);
  if(selected.status==='resolved'&&selected.handle.id===profile.id)
   return {...route,agent:await executableOnPath(route.agent,root,env)};
 }
 const fallback=probeDefaultRoute(profile);
 return {...fallback,agent:await executableOnPath(fallback.agent,root,env)};
}
/** Bound native error evidence and redact common credential forms. */
function nativeFailureTail(store:RunStore,id:string):string {
 let fd:number|undefined;
 try {
  fd=store.openLog(id);
  const size=fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,4096));
  const length=readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));
  return buffer.subarray(0,length).toString('utf8').replace(/[\x00-\x08\x0b-\x1f\x7f]/gu,'')
   .replace(/(Bearer\s+|(?:api[_-]?key|access[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu,'$1[redacted]')
   .replace(/(https?:\/\/)[^/\s@]+@/giu,'$1[redacted]@');
 }catch{return '(native log tail unavailable)';}
 finally {if(fd!==undefined)closeSync(fd);}
}
async function finished(store:RunStore,id:string,timeoutMs:number,signal?:AbortSignal):Promise<RunMeta> {
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline) {signal?.throwIfAborted();const meta=store.read(id);if(complete(meta)) {
  if(meta.exit_code!==0||meta.exit_signal){
   const native=nativeFailureTail(store,id);
   throw Error(`原生 CLI 退出失败 (${meta.exit_code??meta.exit_signal}); run=${id}${native?`; native output (last 4096 bytes): ${native}`:''}`);
  }
  return meta;
 }await delay(100);}
 const stopped=await stopRun(store,id);
 throw Error(`等待原生 CLI 超时 (${timeoutMs}ms)；停止结果 ${JSON.stringify(stopped)}；run=${id}`);
}
function log(store:RunStore,id:string):{absolute_path:string;lines:string[];partial:boolean} {
 const fd=store.openLog(id);
 try {const text=readFileSync(fd,'utf8'),lines=text.split('\n'),partial=lines.at(-1)!=='';lines.pop();return {absolute_path:store.logPath(id),lines,partial};}
 finally {closeSync(fd);}
}
/** Read native sources through the same readUsage interpreter as the watcher. */
function services(store:RunStore,cwd:string,env:NodeJS.ProcessEnv):ReadServices {
 return {
  facts:{home:os.homedir(),auditCwd:cwd,profileRoot:store.hubRoot,platform:process.platform==='win32'?'win32':'posix',codexRoot:usageProbeRoot(os.homedir(),env),piEnv:{...env}},
  async list(root,pattern) {
   const parts=pattern.split('/');
   function matches(names:string[],i=0,j=0):boolean {
    if(j===parts.length)return i===names.length;
    if(parts[j]==='**')return matches(names,i,j+1)||(i<names.length&&matches(names,i+1,j));
    const segment=new RegExp('^'+parts[j]!.split('*').map(s=>s.replaceAll('.','\\.')).join('.*')+'$');
    return i<names.length&&segment.test(names[i]!)&&matches(names,i+1,j+1);
   }
   const files:string[]=[];
   async function walk(dir:string):Promise<void> {
    let entries;try {entries=await readdir(dir,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {if(files.length>=10000)throw Error('usage 来源超过 10000 项');const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()&&matches(path.relative(root,file).split(path.sep)))files.push(file);}
   }
   await walk(root);return files;
  },
  async readLines(file) {const text=await readFile(file,'utf8'),lines=text.split('\n'),partial=lines.at(-1)!=='';lines.pop();return {lines,partial};},
  async readSettings(file) {try{return await readFile(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}},
  async readHead(file,maxBytes) {const handle=await open(file,'r');try {const b=Buffer.alloc(maxBytes),r=await handle.read(b,0,maxBytes,0);return b.subarray(0,r.bytesRead).toString('utf8');}finally {await handle.close();}},
  async readRun(id) {return store.read(id);},
  async readRunLog(id) {return log(store,id);}
 };
}
export async function probeAgent(id:string,options:{root?:string;env?:NodeJS.ProcessEnv;timeoutMs?:number;onCheck?:(check:ProbeCheck)=>void;candidate?:AgentProfile;route?:{agent:string;args:string[]};signal?:AbortSignal}={}):Promise<ProbeReport> {
 const root=options.root??resolveRigRoot(),env={...(options.env??process.env)},report:ProbeReport={id,checks:[]};
 const add=(name:ProbeCheck['name'],ok:boolean,reason:string,status:NonNullable<ProbeCheck['status']>=ok?'passed':'failed')=>{const check={name,ok,reason,status};report.checks.push(check);options.onCheck?.(check);};
 let stage:ProbeCheck['name']='fresh';
 let active:{store:RunStore;id:string}|undefined;
 const checkCancelled=()=>options.signal?.throwIfAborted();
 const launch=async(...args:Parameters<typeof startRun>):Promise<string>=>{
  checkCancelled();
  try {const runId=await startRun(...args);active={store:args[0],id:runId};return runId;}
  catch(e){if(e instanceof StartRunError)active={store:args[0],id:e.runId};throw e;}
 };
 try {
  checkCancelled();
  const platform=process.platform==='win32'?'win32':'posix';
  const snapshot=contractSource(root);
  const config=await (await import('../../core/common/config.js')).readConfigFile(path.join(root,'.context-hub'));
  const selected=resolveContract({agent:id.startsWith('binding:')?id:`binding:${id}`},withContractBindings(snapshot,config.status==='ok'?config.config.agent_bindings:undefined),platform);
  if(!options.candidate&&(id.startsWith('binding:')||config.status==='ok'&&config.config.agent_bindings&&Object.hasOwn(config.config.agent_bindings,id))&&selected.status!=='resolved')throw Error(selected.reason);
  const profile=!options.candidate&&selected.status==='resolved'?selected.handle:probeProfile(id,snapshot,platform,options.candidate);
  if(!profile.capabilities.observe&&!profile.capabilities.resume&&!profile.capabilities.usage) {
   add('fresh',false,'仅声明调用；诊断未启动模型，发车资格不变','skipped');
   for(const name of names.slice(1))add(name,true,'未声明该增强能力（未计量，不补零）','unavailable');
   return report;
  }
  report.profile={revision:profile.revision,digest:profile.digest};
  const route=options.route?{...options.route,agent:await executableOnPath(options.route.agent,root,env)}:await probeRoute(profile,root,env);
  const evidence=await realpath(await mkdtemp(path.join(os.tmpdir(),'tut-agent-probe-')));report.evidence=evidence;
  // Repository-location variables belong to the caller's checkout, not this
  // isolated native run. Git init needs no identity, commit, hook or network.
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])delete env[key];
  await exec('git',['-C',evidence,'init','--quiet','--template='],{env,timeout:10000,...(options.signal?{signal:options.signal}:{})});
  // Config declarations are data; task/run writes below use their Store ports.
  await mkdir(path.join(evidence,'.context-hub','agents'),{recursive:true});
  await writeFile(path.join(evidence,'.context-hub','agents',id+'.json'),probeArtifact(profile),{mode:0o600});
  const tasks=new Store(path.join(evidence,'.context-hub')),runs=new RunStore(evidence);
  const task=await tasks.createTask({title:`agent-probe-${id}`,description:'Isolated native CLI contract smoke probe; no approval or model-memory claim.',creator:'tut agent probe',role:'executor',flow:'direct',cast:{executor:route}});
  const plan=await buildHeadlessPlan({task:{...task,title:`probe ${id}`,flow:'direct',cast:{executor:route}},role:'executor',records:[],hubRoot:evidence,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:1',launchCheckout:'rig',env:{...env,TUT_PROJECT_ROOT:evidence}});
  const prompt='这是隔离的原生 CLI 接入检查。请简短回复；不要读写文件、调用工具或发布 Context Hub 记录。';
  const argv=plan.argv.map(arg=>arg===plan.prompt?prompt:arg);
  if(plan.ownership.windows)plan.ownership.windows.logical_argv=plan.ownership.windows.logical_argv.map(arg=>arg===plan.prompt?prompt:arg);
  const runId=await launch(runs,argv,plan.checkoutRoot,task.task_id,{profile:encodeContract(plan.profile!),env:plan.env,headless:plan.ownership});
  const first=await finished(runs,runId,options.timeoutMs??120000,options.signal);
  checkCancelled();
  add('fresh',true,`原生 CLI 退出 0；run=${runId}；cwd=${first.cwd}`);stage='session';
  checkCancelled();
  const observation=probeSession(profile,first),sampleRuns=[first];
  if(observation.status==='unavailable')add('session',true,observation.reason,'unavailable');
  else add('session',true,`原生身份 ${observation.id}`);
  stage='resume';checkCancelled();
  if(!profile.capabilities.resume)add('resume',true,'未声明原生续接','unavailable');
  else if(observation.status==='unavailable')add('resume',false,'未运行：没有可验证的原生 session','skipped');
  else {
   const resume=await planResume(runs,runId,{instruction:prompt,env:plan.env});
   const resumedId=await launch(runs,resume.argv,resume.cwd,task.task_id,{profile:encodeContract(resume.profile!),env:resume.env,headless:{...resume.headless!,base_version:0,trigger_version:0},resume:resume.resume});
   const second=await finished(runs,resumedId,options.timeoutMs??120000,options.signal);
   checkCancelled();
   const secondSession=probeSession(profile,second);
   if(secondSession.status!=='observed'||secondSession.id!==observation.id)throw Error('resume 没有确认同一 session；不能把 fresh 当成成功续接');
   add('resume',true,`新 run=${resumedId}；同一 session；原生 CLI 退出 0（身份验证，不声称模型记忆已验收）`);
   sampleRuns.push(second);
  }
  stage='usage';
  checkCancelled();
  const io=services(runs,evidence,env),results=[];
  let unavailableUsage=false;
  for(const [i,run] of sampleRuns.entries()) {
   checkCancelled();
   const round={task_id:run.task_id!,role:run.headless!.role,agent:profile.id,route:run.headless!.route,cwd:run.cwd,
    launch_version:1+i*2,delivery_version:2+i*2,launch_ts:run.started_at,delivery_ts:run.ended_at!,attempt_id:run.headless!.attempt_id};
   const measured=await readProbeUsage(profile,round,run,io);
   checkCancelled();
   if(measured.status==='unavailable') {unavailableUsage=true;results.push(`声明不支持：${measured.reason}（未计量，不补零）`);continue;}
   if(measured.status!=='read')throw Error(measured.reason);
   const {result,replay}=measured;
   if(result.status==='unsupported'){unavailableUsage=true;results.push(`声明不支持：${result.reason}（未计量，不补零）`);continue;}
   if(result.status!=='measured'||result.candidates.length!==1||result.problems.length)throw Error(`usage ${result.status}: ${result.status==='measured'?JSON.stringify(result.problems):result.reason}`);
   if(JSON.stringify(result)!==JSON.stringify(replay))throw Error('usage 重放结果不一致');
   const value=result.candidates[0];results.push(`${value.total_tokens} tokens, cost=${value.cost_usd??'unknown'}, ${value.session_file}:${value.start_line}-${value.end_line}`);
  }
  add('usage',true,results.join('; '),unavailableUsage?'unavailable':'passed');
  await tasks.append(task.task_id,{role:'executor',content_type:'note',payload:{summary:`agent probe ${id}`,body:report.checks.map(c=>`${c.name}: ${c.reason}`).join('\n')}});
 }catch(e) {
  if(options.signal?.aborted) {
   let cleanup='';
   if(active) {
    try {
     if(!complete(active.store.read(active.id))) {
      const stopped=await stopRun(active.store,active.id);
      cleanup=`；run=${active.id}；停止${stopped.success?'已确认':'未确认'}：${stopped.result}`;
     }
    }catch(error){cleanup=`；run=${active.id}；停止未确认：${message(error)}`;}
   }
   for(const name of names)if(!report.checks.some(check=>check.name===name))add(name,false,`已取消，未继续验证${cleanup}`,'skipped');
  }else {add(stage,false,message(e));for(const name of names.slice(names.indexOf(stage)+1))add(name,false,`未运行：${stage} 未通过`,'skipped');}
 }
 return report;
}
export async function runAgentProbe(id:string):Promise<number> {
 process.stdout.write(`Agent ${id}：显式诊断可能启动原生 CLI/模型；未声明能力如实报告，probe 不改变发车资格。四项为接入 smoke；正式交付及记忆验收另行核验。\n`);
 const report=await probeAgent(id,{onCheck:check=>process.stdout.write(`${check.status==='skipped'?'−':check.ok?'✓':'✗'} ${check.name}: ${check.reason}\n`)});
 if(report.profile)process.stdout.write(`档案：${id}@${report.profile.revision} ${report.profile.digest}\n`);
 if(report.evidence)process.stdout.write(`证据保留：${report.evidence}\n`);
 return report.checks.some(check=>check.status==='failed'||!check.status&&!check.ok)?1:0;
}

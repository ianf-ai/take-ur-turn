import { readFileSync, closeSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, unlink, readFile, access, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureReaper, reapFixtureRuns } from '../../helpers/fixture-reaper.js';
import { agentProfiles } from '../../../src/agents/registry.js';
import { startServer } from '../../../src/hub/server.js';
import { hubCreate, hubPublish, hubRead } from '../../../src/hub/hub-client.js';
import { RunStore, complete, delay, probe } from '../../../src/core/run/store.js';
import { loadAgentProfiles } from '../../../src/agents/registry.js';
import { parseArgs } from '../../../src/core/cli/args.js';
import { writeNodeExecutable } from '../../helpers/executable.js';
const exec=promisify(execFile),cli=path.resolve('dist/cli.js');
const fixtureChildren = new FixtureReaper();
const roots: string[] = [];
afterEach(async () => {
 try { await fixtureChildren.reap(); }
 finally { await reapFixtureRuns(roots.splice(0)); }
});
async function fixture(measured=false) {
 const root=await mkdtemp(path.join(os.tmpdir(),'tut-drop-in-e2e-')),bin=path.join(root,'bin');
 roots.push(root);
 await mkdir(bin);await mkdir(path.join(root,'.context-hub','agents'),{recursive:true});
 const profile=structuredClone(agentProfiles.get('opencode')!.value);profile.id='fictional';profile.match.supported_executable_names=['fictional'];
 if(measured) {
  profile.usage=structuredClone(agentProfiles.get('codex')!.value.usage);profile.usage.attribution='exact-session-window-v1';
  const source=profile.usage.source!;source.roots=[{kind:'run-log',via:'RunStore',run_id:'round.run_id'}];source.header.id=['payload','id'];
  profile.usage.capability={tier:'declarative',spec:structuredClone(source)};
 }
 await writeFile(path.join(root,'.context-hub','agents','fictional.json'),JSON.stringify(profile));
 const client=path.resolve('dist/hub/hub-client.js');
 await writeFile(path.join(bin,'fictional'),`#!/usr/bin/env node
const args=process.argv.slice(2),index=args.indexOf('--session');
const session=index<0?'ses_'+require('node:crypto').randomUUID().replaceAll('-',''):args[index+1];
if(process.env.TUT_FIXTURE_USAGE)console.log(JSON.stringify({type:'session_meta',payload:{cwd:process.cwd(),id:session,cli_version:'fixture'}}));
if(!process.env.TUT_FIXTURE_NO_SESSION)console.log(JSON.stringify({type:'step_start',timestamp:Date.now(),sessionID:session}));
console.log(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD,argv:args}));
if(process.env.TUT_FIXTURE_READY_FILE)require('node:fs').writeFileSync(process.env.TUT_FIXTURE_READY_FILE,JSON.stringify({cwd:process.cwd(),pid:process.pid}));
if(process.env.TUT_FIXTURE_HOLD)setInterval(()=>{},1000);
if(process.env.TUT_FIXTURE_USAGE) {
const timestamp=new Date().toISOString(),turn_id=require('node:crypto').randomUUID();
for(const payload of [{type:'task_started',turn_id},{type:'token_count',info:{total_token_usage:{input_tokens:2,output_tokens:1,total_tokens:process.env.TUT_FIXTURE_BAD_USAGE?0:3}}},{type:'task_complete',turn_id}])console.log(JSON.stringify({type:'event_msg',timestamp,payload}));
}
const prompt=args.at(-1),match=prompt.match(/读取任务 ([a-z0-9-]+) 的/);
if(match)import(${JSON.stringify(client)}).then(async({hubPublish})=>{await hubPublish(process.env.TUT_HUB_URL,{task_id:match[1],role:'executor',content_type:index<0?'code_changes':'revision',payload:{summary:'protocol fixture delivery',body:'Protocol fixture only; no model or memory claim.',...(index<0?{}:{ref_version:3})}});}).catch(e=>{console.error(e);process.exitCode=1;});
`,{mode:0o700});
 return {root,env:{...process.env,TUT_HUB_ROOT:root,TUT_HUB_URL:'http://127.0.0.1:1',TUT_EVENT_PORT_URL:'http://127.0.0.1:1',PATH:bin+path.delimiter+process.env.PATH,PWD:'/foreign-parent'}};
}
async function waitRun(store:RunStore,index:number) {
 const deadline=Date.now()+15000;
 while(Date.now()<deadline) {const runs=store.list().map(id=>store.read(id)).sort((a,b)=>a.started_at.localeCompare(b.started_at));const run=runs[index];if(run&&complete(run))return run;await delay(100);}
 throw Error('fixture run did not complete');
}
describe.skipIf(process.platform==='win32')('workspace native probe and real start-next (protocol fixture)',()=>{
 it('arbitrates concurrent explicit profile imports and starts the surviving executable through the real Hub',async()=>{
  const {root,env}=await fixture(),brandnew=path.join(root,'bin','brandnew');await copyFile(path.join(root,'bin','fictional'),brandnew);
  const base=JSON.parse(await readFile(path.join(root,'.context-hub','agents','fictional.json'),'utf8'));
  const installer=path.resolve('dist/app/agent-setup-store.js');
  const code=`import ${JSON.stringify(path.resolve('dist/app/agents.js'))};import {agentSetupStore} from ${JSON.stringify(installer)};import {writeFile,access} from 'node:fs/promises';import {setTimeout} from 'node:timers/promises';const [root,raw]=process.argv.slice(1),p=JSON.parse(raw);await writeFile(root+'/ready-'+p.id,'ready');for(;;){try{await access(root+'/go');break;}catch{await setTimeout(10);}}try{await agentSetupStore(root).install(p);console.log(JSON.stringify({id:p.id,ok:true}));}catch(e){console.log(JSON.stringify({id:p.id,ok:false,error:e.message}));}`;
  const children=['first','second'].map(id=>exec(process.execPath,['--input-type=module','-e',code,root,JSON.stringify({...base,id,match:{supported_executable_names:['brandnew'],platform_target_identity:null}})],{env,timeout:15000}));
  const deadline=Date.now()+10000;let ready=false;
  while(Date.now()<deadline){try{await Promise.all(['first','second'].map(id=>access(root+'/ready-'+id)));ready=true;break;}catch{await delay(20);}}
  await writeFile(root+'/go','go');const results=(await Promise.all(children)).map(r=>JSON.parse(r.stdout));expect(ready).toBe(true);
  expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.find(r=>!r.ok).error).toContain('PROFILE_AMBIGUOUS');
  const winner=results.find(r=>r.ok).id,registry=loadAgentProfiles(root);expect(registry.match(brandnew)?.id).toBe(winner);expect(registry.diagnostics).toEqual([]);
  await writeFile(path.join(root,'.context-hub','config.json'),JSON.stringify({flow_mode:'manual',launch_mode:'detached'}));
  const server=await startServer({root:path.join(root,'.context-hub'),port:0});env.TUT_HUB_URL=server.url;
  try {
   const task=await hubCreate(server.url,{title:'concurrent setup survivor',description:'Protocol fixture verifies the surviving installed profile can start.',creator:'test',role:'executor',flow:'direct',cast:{executor:{agent:'brandnew',args:['--auto']}}});
   await exec(process.execPath,[cli,'start-next',task.task_id,'--url',server.url],{cwd:root,env,timeout:20000});
   const run=await waitRun(new RunStore(root),0);expect(run.exit_code).toBe(0);expect(run.agent_session_id).toMatch(/^ses_/u);expect((await hubRead(server.url,task.task_id)).status).toBe('reviewing');
  }finally {await server.close();}
 },30000);
 it('gives the unchanged Codex route a real isolated Git cwd without adding a bypass',async()=>{
  const {root,env}=await fixture(),codex=path.join(root,'bin','codex'),home=path.join(root,'codex-home');await mkdir(home);
  await writeFile(path.join(root,'.context-hub','workspace.json'),JSON.stringify({roles:{executor:{agent:codex,args:[]}}}));
  await writeFile(codex,`#!/usr/bin/env node
const args=process.argv.slice(2),git=require('node:child_process').execFileSync;
if(args.includes('--skip-git-repo-check'))throw Error('unexpected bypass');
const gitRoot=git('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
if(gitRoot!==process.cwd())throw Error('probe cwd is not its own Git root');
const session=args.includes('resume')?args.at(-2):require('node:crypto').randomUUID();
console.log(JSON.stringify({type:'thread.started',thread_id:session}));
console.log(JSON.stringify({gitRoot,cwd:process.cwd(),argv:args}));
`,{mode:0o700});
  const result=await exec(process.execPath,[cli,'agent','probe','codex'],{cwd:root,env:{...env,CODEX_HOME:home,GIT_DIR:path.join(root,'caller-only.git'),GIT_WORK_TREE:root},timeout:20000}).catch(e=>e);
  for(const name of ['fresh','session','resume'])expect(result.stdout).toContain('✓ '+name+':');
  // This fixture tests the repository precondition, not native token sources.
  expect(result.stdout).toContain('✗ usage:');
  const evidence=result.stdout.match(/证据保留：([^\n]+)/u)![1]!,store=new RunStore(evidence);
  const runs=store.list().map(id=>store.read(id));expect(runs).toHaveLength(2);
  const fresh=runs.find(r=>!r.resume)!;expect(fresh.argv.slice(0,3)).toEqual([codex,'exec','--json']);
  for(const run of runs) {
   const fd=store.openLog(run.run_id);let lines:string[];try{lines=readFileSync(fd,'utf8').trim().split('\n');}finally{closeSync(fd);}
   const facts=lines.map(line=>JSON.parse(line)).find(row=>row.gitRoot);
   expect(facts.gitRoot).toBe(run.cwd);expect(facts.cwd).toBe(evidence);expect(facts.argv).not.toContain('--skip-git-repo-check');
  }
 },25000);
 it('runs all four CLI checks without an install/catalog change, and reports unsupported usage honestly',async()=>{
  const {root,env}=await fixture();const output=await exec(process.execPath,[cli,'agent','probe','fictional'],{cwd:root,env,timeout:20000}).catch(e=>{throw Error(e.stdout+'\n'+e.stderr);});
  for(const name of ['fresh','session','resume','usage'])expect(output.stdout).toContain('✓ '+name+':');
  expect(output.stdout).toContain('声明不支持');expect(output.stdout).toContain('未计量，不补零');expect(output.stdout).toContain('证据保留：');
 },25000);
 it('measures fresh/resume native windows and repeats the shared reader; bad counters fail',async()=>{
  const {root,env}=await fixture(true);
  const good=await exec(process.execPath,[cli,'agent','probe','fictional'],{cwd:root,env:{...env,TUT_FIXTURE_USAGE:'1'},timeout:20000}).catch(e=>{throw Error(e.stdout+'\n'+e.stderr);});
  expect(good.stdout).toContain('✓ usage:');expect(good.stdout).toContain('tokens, cost=unknown');expect(good.stdout).not.toContain('声明不支持');
  const bad=await exec(process.execPath,[cli,'agent','probe','fictional'],{cwd:root,env:{...env,TUT_FIXTURE_USAGE:'1',TUT_FIXTURE_BAD_USAGE:'1'},timeout:20000}).catch(e=>e);
  expect(bad.code).toBe(1);expect(bad.stdout).toContain('✗ usage:');
 },30000);
 it('explains a session failure and marks dependent checks as not run',async()=>{
  const {root,env}=await fixture();const result=await exec(process.execPath,[cli,'agent','probe','fictional'],{cwd:root,env:{...env,TUT_FIXTURE_NO_SESSION:'1'},timeout:20000}).catch(e=>e);
  expect(result.code).toBe(1);expect(result.stdout).toContain('✓ fresh:');expect(result.stdout).toContain('✗ session:');expect(result.stdout).toContain('未运行：session 未通过');
 },25000);
 it('uses the drop-in through actual Hub start-next fresh, fail_code and automatic same-role resume',async()=>{
  const {root,env}=await fixture(true);Object.assign(env,{TUT_FIXTURE_USAGE:'1'});await writeFile(path.join(root,'.context-hub','config.json'),JSON.stringify({flow_mode:'manual',launch_mode:'detached'}));
  const server=await startServer({root:path.join(root,'.context-hub'),port:0});env.TUT_HUB_URL=server.url;
  try {
   const task=await hubCreate(server.url,{title:'drop-in acceptance',description:'Isolated protocol fixture; fresh and resume transport checks.',creator:'test',role:'executor',flow:'direct',cast:{executor:{agent:'fictional',args:['--auto']}}});
   const store=new RunStore(root);
   await exec(process.execPath,[cli,'start-next',task.task_id,'--url',server.url],{cwd:root,env,timeout:20000});
   const first=await waitRun(store,0);expect(first.exit_code).toBe(0);expect(first.agent_session_id).toMatch(/^ses_/u);expect((await hubRead(server.url,task.task_id)).status).toBe('reviewing');
   await hubPublish(server.url,{task_id:task.task_id,role:'reviewer',content_type:'review',payload:{summary:'protocol fixture requests next round',body:'Transport fixture, not independent model review.',verdict:'fail_code',ref_version:2}});
   await exec(process.execPath,[cli,'start-next',task.task_id,'--url',server.url],{cwd:root,env,timeout:20000});
   const second=await waitRun(store,1);expect(second.exit_code).toBe(0);expect(second.agent_session_id).toBe(first.agent_session_id);expect(second.headless?.resume_from_run_id).toBe(first.run_id);expect(second.headless?.session_reason).toBe('resume: exact native role session');expect(second.cwd).toBe(first.cwd);
   expect((await hubRead(server.url,task.task_id)).status).toBe('reviewing');
   const probe=await exec(process.execPath,[cli,'agent','probe','fictional'],{cwd:root,env,timeout:20000});
   for(const name of ['fresh','session','resume','usage'])expect(probe.stdout).toContain('✓ '+name+':');
   expect(probe.stdout).toContain('tokens, cost=unknown');
  }finally {await server.close();}
 },30000);
});

it('reports basic enhancements unavailable without calling a model or changing the declaration',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'tut-probe-basic-'));await mkdir(path.join(root,'.context-hub'));
 const file=path.join(root,'.context-hub','config.json'),binding={executable:'worker-x',args:[],prompt:{kind:'argv',index:0}};
 const {writeAgentBinding}=await import('../../../src/core/common/config.js');
 await writeAgentBinding(path.join(root,'.context-hub'),'worker-x',binding as import('../../../src/core/common/config-intent.js').AgentBinding);
 const bytes=await readFile(file,'utf8');
 const {probeAgent}=await import(path.resolve('dist/app/cli/agent.js')) as typeof import('../../../src/app/cli/agent.js');
 const report=await probeAgent('worker-x',{root});
 expect(report.checks.map(c=>[c.name,c.status])).toEqual([['fresh','skipped'],['session','unavailable'],['resume','unavailable'],['usage','unavailable']]);
 expect(report.checks[3]!.reason).toContain('未计量');expect(report.evidence).toBeUndefined();
 expect(await readFile(file,'utf8')).toBe(bytes);await expect(access(path.join(root,'.context-hub','agents'))).rejects.toThrow();
});

it('keeps failed checks distinct from dependent skipped checks and leaves the source contract intact',async()=>{
 const {root,env}=await fixture();let id='fictional',file=path.join(root,'.context-hub','agents',id+'.json');
 if(process.platform==='win32') {
  // The shared status assertion needs a runnable Windows fixture. The
  // extensionless POSIX script/OpenCode profile above intentionally lacks it.
  const executable=path.join(root,'bin','fictional');
  writeNodeExecutable(path.join(root,'bin','codex'),await readFile(executable,'utf8'));
  const profile=structuredClone(agentProfiles.get('codex')!.value);
  // Keep the existing supported native identity and dialect; this is a
  // protocol fixture for the status distinction, not a new Windows contract.
  id=profile.id;file=path.join(root,'.context-hub','agents',id+'.json');
  await writeFile(file,JSON.stringify(profile));
 }
 const before=await readFile(file,'utf8');
 const {probeAgent}=await import(path.resolve('dist/app/cli/agent.js')) as typeof import('../../../src/app/cli/agent.js');
 const report=await probeAgent(id,{root,env:{...env,TUT_FIXTURE_NO_SESSION:'1'},timeoutMs:10000});
 expect(report.checks.map(c=>c.status)).toEqual(['passed','failed','skipped','skipped']);
 expect(await readFile(file,'utf8')).toBe(before);
});

describe('noninteractive declaration import',()=>{
 async function invoke(root:string,args:string[],stdin?:string,extraEnv:NodeJS.ProcessEnv={}) {
  const {spawn}=await import('node:child_process');
  return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
   const child=fixtureChildren.track(spawn(process.execPath,[cli,...args],{cwd:root,env:{...process.env,TUT_HUB_ROOT:root,TUT_USER_CONFIG_DIR:path.join(root,'user'),...extraEnv},stdio:['pipe','pipe','pipe']}));
   let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(stdin);
  });
 }
 const binding={schema_version:1,id:'worker-x',command:{executable:'/not installed/worker-cli',argv:['literal $HOME','*.txt',{slot:'args'},{slot:'prompt'}]},input:{kind:'argv'}};
 it.each(['stdin','file'] as const)('saves from %s without TTY, samples, executable probing or model calls',async source=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tut-agent-add-')),file=path.join(root,'import.json');await writeFile(file,JSON.stringify(binding));
  const result=await invoke(root,['agent','add','worker-x','--from',source==='stdin'?'-':file],source==='stdin'?JSON.stringify(binding):undefined);
  expect(result).toMatchObject({code:0,stderr:''});expect(result.stdout).toContain('tut assign executor binding:worker-x');
  const config=JSON.parse(await readFile(path.join(root,'.context-hub','config.json'),'utf8'));
  expect(config.agent_bindings['worker-x']).toEqual(binding);
  expect(await invoke(root,['assign','executor','binding:worker-x','--model','chosen'])).toMatchObject({code:0});
  await expect(access(path.join(root,'.context-hub','runs'))).rejects.toThrow();
  await expect(access(path.join(root,'.context-hub','agents'))).rejects.toThrow();
  await unlink(file); // imported file is no longer the configuration source
  const saved=await readFile(path.join(root,'.context-hub','config.json'),'utf8');
  const bad=await invoke(root,['agent','add','worker-x','--from','-'],JSON.stringify({...binding,command:{...binding.command,argv:[{slot:'prompt'},{slot:'prompt'}]}}));
  expect(bad.code).toBe(1);expect(bad.stderr).toContain('command.argv.1');
  expect(await readFile(path.join(root,'.context-hub','config.json'),'utf8')).toBe(saved);
 });
 it('setup is optional guidance/import and never runs a probe',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tut-agent-setup-import-'));
  expect(await invoke(root,['agent','setup','worker-x'])).toMatchObject({code:0,stderr:''});
  expect(await invoke(root,['agent','setup','worker-x','--from','-'],JSON.stringify(binding))).toMatchObject({code:0,stderr:''});
  const before=await readFile(path.join(root,'.context-hub','config.json'),'utf8');
  // A basic binding without native enhancement cannot be mistaken for a full profile.
  const result=await invoke(root,['agent','probe','worker-x']);expect(result.code).toBe(0);expect(result.stdout).toContain('未声明该增强能力');
  expect(await readFile(path.join(root,'.context-hub','config.json'),'utf8')).toBe(before);
  expect((await invoke(root,['assign','executor','binding:codex'])).code).toBe(1);
 });
 it('imports a complete native declaration without probing and retains protected scope checks',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tut-native-import-'));
  const profile=structuredClone(agentProfiles.get('opencode')!.value);
  profile.id='new-native';profile.match.supported_executable_names=['new-native-cli'];
  const result=await invoke(root,['agent','setup','new-native','--from','-'],JSON.stringify(profile));
  expect(result).toMatchObject({code:0,stderr:''});
  expect(JSON.parse(await readFile(path.join(root,'.context-hub','agents','new-native.json'),'utf8'))).toEqual(profile);
  expect(new RunStore(root).list()).toEqual([]);
  const protectedProfile=structuredClone(agentProfiles.get('codex')!.value);
  protectedProfile.invoke.route='passthrough';
  const denied=await invoke(root,['agent','setup','codex','--from','-'],JSON.stringify(protectedProfile));
  expect(denied.code).toBe(1);
  await expect(access(path.join(root,'.context-hub','agents','codex.json'))).rejects.toThrow();
 });
 it('never borrows a same-name builtin profile for a basic binding probe',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tut-binding-no-probe-fallback-'));
  // Even a regressed resolver must hit an inert test executable, never an installed model.
  const bin=path.join(root,'inert-bin');await mkdir(bin);await writeFile(path.join(bin,'codex'),'#!/bin/sh\nexit 91\n',{mode:0o700});
  const value={...binding,id:'codex'};
  expect((await invoke(root,['agent','add','codex','--from','-'],JSON.stringify(value))).code).toBe(0);
  const report=await invoke(root,['agent','probe','codex'],undefined,{PATH:bin});
  expect(report.code).toBe(0);expect(report.stdout).toContain('诊断未启动模型');expect(report.stdout).toContain('未声明该增强能力');
  await expect(access(path.join(root,'.context-hub','runs'))).rejects.toThrow();
 });
 it.each(['argv:1','stdin'])('keeps the legacy --prompt %s add → assign path usable',async prompt=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tut-legacy-binding-cli-'));
  const added=await invoke(root,['agent','add','legacy','--prompt',prompt,'--','external-cli','run','--quiet']);
  expect(added).toMatchObject({code:0,stderr:''});expect(added.stdout).toContain('assign executor binding:legacy');
  expect(await invoke(root,['assign','executor','binding:legacy'])).toMatchObject({code:0,stderr:''});
  const {resolveAgentRouteWithSource}=await import('../../../src/core/common/workspace.js');
  const selected=await resolveAgentRouteWithSource('executor',undefined,{projectRoot:root});
  expect(selected.route).toBe('binding:legacy');
  expect(selected.binding).toEqual({schema_version:1,id:'legacy',command:{executable:'external-cli',argv:prompt==='stdin'?['run','--quiet']:['run',{slot:'prompt'},'--quiet']},input:prompt==='stdin'?{kind:'stdin',encoding:'utf8'}:{kind:'argv'}});
  const before=await readFile(path.join(root,'.context-hub','config.json'),'utf8');
  expect((await invoke(root,['agent','add','legacy','--prompt','argv:99','--','external-cli','run'])).code).toBe(1);
  expect(await readFile(path.join(root,'.context-hub','config.json'),'utf8')).toBe(before);
 });
 // This native fixture uses a POSIX shebang; declaration import tests above run on both platforms.
 it.skipIf(process.platform==='win32').each(['429 rate limit','not logged in','network connection failed'])('keeps declarations and native error evidence after %s',async nativeError=>{
  const {root,env}=await fixture();
  const script=path.join(root,'bin','fictional');await writeFile(script,`#!/usr/bin/env node\nconsole.error(${JSON.stringify(nativeError)});console.error('api_key=secret-value');process.exit(1);\n`,{mode:0o700});
  const declaration={...binding,command:{...binding.command,executable:script}};
  expect((await invoke(root,['agent','add','worker-x','--from','-'],JSON.stringify(declaration))).code).toBe(0);
  const before=await readFile(path.join(root,'.context-hub','config.json'),'utf8');
  const result=await exec(process.execPath,[cli,'agent','probe','fictional'],{cwd:root,env,timeout:20000}).catch(e=>e);
  expect(result.code).toBe(1);expect(result.stdout).toContain(nativeError);expect(result.stdout).not.toContain('secret-value');expect(result.stdout).toContain('[redacted]');
  expect(await readFile(path.join(root,'.context-hub','config.json'),'utf8')).toBe(before);
 });
});

describe.skipIf(process.platform==='win32')('explicit optional probe cancellation',()=>{
 it.each(['running','fresh-complete'] as const)('settles its own run and does not start resume when cancelled at %s',async stage=>{
  const {root,env}=await fixture(),controller=new AbortController(),ready=path.join(root,'ready.json');
  if(stage==='running')Object.assign(env,{TUT_FIXTURE_HOLD:'1',TUT_FIXTURE_READY_FILE:ready});
  const {probeAgent}=await import(path.resolve('dist/app/cli/agent.js')) as typeof import('../../../src/app/cli/agent.js');
  const before=await readFile(path.join(root,'.context-hub','agents','fictional.json'),'utf8');
  const outcome=probeAgent('fictional',{root,env,signal:controller.signal,timeoutMs:120000,onCheck:check=>{if(stage==='fresh-complete'&&check.name==='fresh'&&check.ok)controller.abort();}});
  try {
   if(stage==='running') {
    const deadline=Date.now()+10000;let found=false;
    while(Date.now()<deadline){try{await access(ready);found=true;break;}catch{await delay(20);}}
    expect(found).toBe(true);controller.abort();
   }
   const report=await outcome;expect(report.evidence).toBeDefined();
   const runs=new RunStore(report.evidence!),ids=runs.list();expect(ids).toHaveLength(1);
   expect(complete(runs.read(ids[0]!))).toBe(true);expect(probe(-runs.read(ids[0]!).pgid)).toBe(false);
   expect(report.checks.find(c=>c.name==='resume')?.reason).toContain('已取消');
   expect(await readFile(path.join(root,'.context-hub','agents','fictional.json'),'utf8')).toBe(before);
  }finally {controller.abort();await outcome;}
 },20000);
});

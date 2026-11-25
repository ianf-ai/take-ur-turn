import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunStore, type RunMeta } from '../../../src/core/run/store.js';
import { buildHeadlessPlan, previousSession } from '../../../src/standalone/launcher-detached/plan.js';
import { planResume, piSessionDirFor } from '../../../src/core/run/resume.js';
import { describe, it, expect, vi } from 'vitest';
import { agentProfiles, ProfileRegistry, type FrozenProfile } from '../../../src/agents/registry.js';
import { invoke } from '../../../src/agents/interpreter.js';
import { parseUsageSession, measureUsageSession } from '../../../src/agents/usage-session.js';
import { readUsage, type ReadServices, type UsageSessionRef } from '../../../src/agents/usage.js';
import type { InvokeInput, ExactSessionRef } from '../../../src/agents/runtime-contract.js';
const at=(s:number)=>`2026-01-01T00:00:${String(s).padStart(2,'0')}.000Z`;
const request=(profile:FrozenProfile):InvokeInput=>({profile,mode:'run',origin:'managed',entry:'auto',platform:'posix',route:{agent:profile.value.match.supported_executable_names[0]!,args:[]},checkoutRoot:'/checkout',prompt:'new',environmentFacts:{home:'/home',env:{}}});
const session=(p:FrozenProfile):ExactSessionRef=>({profile:p.key,agent:p.id,session_id:'ses_ABC123',identity_source:'observed',source_run_id:'source',route:{agent:'opencode',args:['--auto']},cwd:'/checkout',evidence:{via:'RunStore',run_id:'source',field:'agent_session_id'}});
const clone=(id:string)=>structuredClone(agentProfiles.get(id)!.value);
const codexRows=(header:unknown)=>[header,{type:'event_msg',timestamp:at(10),payload:{type:'task_started',turn_id:'t'}},{type:'event_msg',timestamp:at(20),payload:{type:'token_count',info:{total_token_usage:{input_tokens:7,output_tokens:3,total_tokens:10}}}},{type:'event_msg',timestamp:at(30),payload:{type:'task_complete',turn_id:'t'}}];
const jsonl=(rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const round={task_id:'task',role:'executor',agent:'codex',route:{agent:'codex',args:[]},cwd:'/checkout',launch_version:1,delivery_version:2,launch_ts:at(9),delivery_ts:at(20)};
function services(files:Record<string,string>):ReadServices {
 return {facts:{home:'/home',auditCwd:'/checkout',platform:'posix',codexRoot:'/sessions',piEnv:{}},list:async()=>Object.keys(files),readLines:async file=>{const lines=files[file]!.split('\n'),partial=lines.at(-1)!.length>0;lines.pop();return {lines,partial};},readSettings:async()=>undefined,readHead:async()=>'',readRun:async()=>{throw Error('unexpected run');},readRunLog:async()=>{throw Error('unexpected log');}};
}
describe('closed profile contracts',()=>{
 it('isolates actual Windows target collisions in either catalog order',()=>{
  const a=clone('pi'),b=clone('pi');b.id='other-pi';b.match.supported_executable_names=['other-pi'];
  for(const values of [[a,b],[b,a]]) {
   const registry=new ProfileRegistry([...values,clone('codex')]);
   expect(registry.match('cli.js','win32','pi')).toBeUndefined();
   expect(registry.diagnostics.filter(d=>d.code==='PROFILE_AMBIGUOUS')).toHaveLength(2);
   expect(registry.get('pi','posix')).toBeDefined();expect(registry.get('other-pi','posix')).toBeDefined();
   expect(registry.match('codex.exe','win32','codex')?.id).toBe('codex');
  }
 });
 it('passes a designated id directly through arbitrary selector templates',async()=>{
  const value=clone('pi');value.id='custom-pi';value.match.supported_executable_names=['custom-pi'];
  for(const mode of ['run','resume'] as const)if(value.invoke[mode].tier==='declarative')value.invoke[mode].spec=value.invoke[mode].spec.replace('--session-id','--conversation-id');
  const p=new ProfileRegistry([value]).get('custom-pi')!,id='96b72f6c-e9c0-4d5d-94fa-a91611f02198';
  const input={...request(p),environmentFacts:{home:'/home',env:{},designated_id:id}};
  const fresh=await invoke(input);expect(fresh.status).toBe('ready');if(fresh.status!=='ready')return;
  expect(fresh.invocation.executable).toBe('custom-pi');expect(fresh.invocation.argv[0]).not.toBe('custom-pi');
  expect(fresh.invocation.argv[fresh.invocation.argv.indexOf('--conversation-id')+1]).toBe(id);
  expect(fresh.invocation.sessionPlan.designated_id).toBe(id);
  const ref:ExactSessionRef={...session(p),route:input.route,session_id:id,identity_source:'designated',evidence:{via:'RunStore',run_id:'source',field:'headless.designated_session_id'}};
  const resumed=await invoke({...input,mode:'resume',sessionRef:ref});expect(resumed.status).toBe('ready');
  if(resumed.status==='ready')expect(resumed.invocation.sessionPlan.expected_id).toBe(id);
 });
 it('rejects missing or mismatched resume provenance and route facts',async()=>{
  const p=agentProfiles.get('opencode')!,base={...request(p),mode:'resume' as const,route:{agent:'opencode',args:['--auto']}};
  const invalid=[base,{...base,sessionRef:{...session(p),cwd:'/elsewhere'}},{...base,sessionRef:{...session(p),profile:{...p.key,digest:'other'}}},{...base,sessionRef:{...session(p),evidence:{via:'RunStore' as const,run_id:'different',field:'agent_session_id' as const}}},{...base,sessionRef:session(p),route:{agent:'unknown',args:['--auto']}},{...base,sessionRef:session(p),checkoutRoot:''},{...base,sessionRef:session(p),platform:'win32' as const}];
  for(const input of invalid)expect((await invoke(input)).status).toBe('invalid');
  expect((await invoke({...base,sessionRef:{...session(p),session_id:123}} as unknown as InvokeInput)).status).toBe('invalid');
  expect((await invoke({...base,checkoutRoot:123,sessionRef:session(p)} as unknown as InvokeInput)).status).toBe('invalid');
  const valid=await invoke({...base,sessionRef:session(p)});expect(valid.status).toBe('ready');
  if(valid.status==='ready')expect([valid.invocation.executable,...valid.invocation.argv].filter(x=>x==='opencode')).toHaveLength(1);
  expect((await invoke({...base,origin:'plain-legacy',entry:'auto',plain:{source_run_id:'source',argv:[]},sessionRef:session(p)})).status).toBe('invalid');
 });
 it('preserves Pi plain head independently of managed route acceptance',async()=>{
  const p=agentProfiles.get('pi')!,id='96b72f6c-e9c0-4d5d-94fa-a91611f02198';
  const head=['pi','--model','--session-id']; // legal historical value, managed grammar rejects selector scanning
  const ref:ExactSessionRef={...session(p),route:{agent:'pi',args:head.slice(1)},session_id:id,identity_source:'argv',evidence:{via:'RunStore',run_id:'source',field:'plain-selector'}};
  const result=await invoke({...request(p),mode:'resume',origin:'plain-legacy',entry:'manual',route:ref.route,sessionRef:ref,plain:{source_run_id:'source',argv:[...head,'--session-id',id,'--','old']}});
  expect(result.status).toBe('ready');if(result.status==='ready')expect(result.invocation.argv).toEqual([...head.slice(1),'--session-id',id,'--','new']);
 });
 it('interprets same-type headers only through their frozen field mappings',()=>{
  const a=clone('codex'),b=clone('codex');a.id='usage-a';b.id='usage-b';a.match.supported_executable_names=['usage-a'];b.match.supported_executable_names=['usage-b'];
  for(const [profile,key] of [[a,'a'],[b,'b']] as const) {
   const source=profile.usage.source!;source.header.cwd=[key,'cwd'];source.header.version=[key,'version'];source.header.id=[key,'id'];source.header.accepted_versions=[1];source.header.exclude.any=[{path:[key,'excluded'],op:'truthy'}];
   if(profile.usage.capability.tier==='declarative')profile.usage.capability.spec=structuredClone(source);
  }
  for(const order of [[a,b],[b,a]])for(const value of order) {
   const p=new ProfileRegistry(order).get(value.id)!,key=value.id==='usage-a'?'a':'b';
   const header={type:'session_meta',[key]:{cwd:'/checkout',version:1,id:key,excluded:false},[key==='a'?'b':'a']:{cwd:'/wrong',version:2,id:'wrong',excluded:true}};
   const parsed=parseUsageSession(jsonl(codexRows(header)),'/sessions/s.jsonl',p);
   expect(parsed.header).toMatchObject({cwd:'/checkout',version:1,id:key,excluded:false});
   expect(measureUsageSession(parsed,{cwd:'/checkout',launch_ts:at(9),ts:at(20)})[0]?.total_tokens).toBe(10);
   (header[key] as {excluded:boolean}).excluded=true;
   expect(parseUsageSession(jsonl(codexRows(header)),'/sessions/s.jsonl',p).excluded).toBe(true);
  }
 });
 it('returns every candidate and all bad-source/partial evidence through one read port',async()=>{
  const profile=agentProfiles.get('codex')!,ref:UsageSessionRef={profile,round,attribution:'legacy-cwd-window-v1'},raw=jsonl(codexRows({type:'session_meta',payload:{cwd:'/checkout'}}));
  const single=await readUsage(ref,services({'/sessions/a.jsonl':raw}));expect(single.status).toBe('measured');
  const multi=await readUsage(ref,services({'/sessions/a.jsonl':raw,'/sessions/b.jsonl':raw,'/sessions/bad.jsonl':'{bad}\n','/sessions/partial.jsonl':raw+'{'}));
  expect(multi.status).toBe('measured');if(multi.status!=='measured')return;
  expect(multi.candidates).toHaveLength(2);expect(multi.sourceEvidence).toHaveLength(3);
  expect(multi.sourceEvidence.find(e=>e.source.endsWith('partial.jsonl'))).toMatchObject({partial_tail:true,complete_through_line:4,profile:profile.key});
  expect(multi.problems.map(p=>p.code)).toEqual(['SOURCE_UNREADABLE','SOURCE_WINDOW_INVALID']);
  expect(multi.problems.map(p=>p.reason)).toEqual(['invalid_jsonl_line:1','partial_jsonl_tail']);
 });
 it('retains file candidates when a subsequent run-log read fails, including timeouts',async()=>{
  const value=clone('codex');value.usage.attribution='exact-session-window-v1';value.usage.source!.header.id=['payload','id'];value.usage.source!.roots.push({kind:'run-log',via:'RunStore',run_id:'round.run_id'});if(value.usage.capability.tier==='declarative')value.usage.capability.spec=structuredClone(value.usage.source!);
  const profile=new ProfileRegistry([value]).get('codex')!,ref:UsageSessionRef={profile,round:{...round,run_id:'run',attempt_id:'attempt',native_session_id:'native'},attribution:'exact-session-window-v1',run_id:'run',native_session_id:'native',identity_source:'observed'};
  const io=services({'/sessions/a.jsonl':jsonl(codexRows({type:'session_meta',payload:{cwd:'/checkout',id:'native'}}))});
  io.readRun=async()=>({run_id:'run',task_id:'task',cwd:'/checkout',argv:[],agent_session_id:'native',headless:{role:'executor',attempt_id:'attempt',base_version:0,route:round.route}});
  io.readRunLog=async()=>({absolute_path:'/runs/run/log',lines:[],partial:false});
  const control=await readUsage(ref,io);expect(control.status).toBe('measured');
  if(control.status!=='measured')throw Error('missing control candidate');
  expect(control.candidates[0]).toMatchObject({input_tokens:7,output_tokens:3,total_tokens:10});expect(control.sourceEvidence).toHaveLength(2);
  for(const failure of [Object.assign(Error('native log unreadable'),{code:'EACCES'}),Error('native log read failed'),Object.assign(Error('native log deadline'),{code:'LOCAL_IO_TIMEOUT'})]) {
   let reads=0;io.readRunLog=async()=>{reads++;throw failure;};
   const result=await readUsage(ref,io);expect(reads).toBe(1);expect(result.status).toBe('measured');
   if(result.status!=='measured')throw Error('lost preceding file candidate');
   expect(result.candidates).toEqual(control.candidates);expect(result.sourceEvidence).toEqual(control.sourceEvidence.slice(0,1));
   expect(result.problems).toEqual([{status:'error',code:'USAGE_READ_ERROR',reason:failure.message,...('code' in failure?{cause_code:failure.code}:{})}]);
  }
 });
 it('returns a timeout immediately without scanning another source',async()=>{
  const io=services({'/sessions/a.jsonl':'','/sessions/b.jsonl':''});let reads=0;
  io.readLines=async()=>{reads++;throw Object.assign(Error('deadline'),{code:'LOCAL_IO_TIMEOUT'});};
  const result=await readUsage({profile:agentProfiles.get('codex')!,round,attribution:'legacy-cwd-window-v1'},io);
  expect(reads).toBe(1);expect(result).toMatchObject({status:'error',problems:[{cause_code:'LOCAL_IO_TIMEOUT',source:'/sessions/a.jsonl'}]});
 });
 it('leaves the unverified OpenCode usage hook unsupported without reading sources',async()=>{
  const value=clone('opencode');value.usage.capability={tier:'assisted',hook:'opencode-usage-v1'};
  const profile=new ProfileRegistry([value]).get('opencode')!;
  const io=services({});io.readRun=async()=>({run_id:'run',task_id:'task',cwd:'/checkout',argv:[],agent_session_id:'ses_ABC123',headless:{role:'executor',attempt_id:'attempt',base_version:0,route:{agent:'opencode',args:['--auto']}}});
  io.list=async()=>{throw Error('unverified source must not be scanned');};
  const result=await readUsage({profile,round:{...round,agent:'opencode',route:{agent:'opencode',args:['--auto']},attempt_id:'attempt',run_id:'run',native_session_id:'ses_ABC123'},attribution:'exact-session-window-v1',run_id:'run',native_session_id:'ses_ABC123',identity_source:'observed'},io);
  expect(result).toMatchObject({status:'unsupported',code:'USAGE_SOURCE_UNVERIFIED',reason:'usage-source-unverified'});
 });
 it('requires matching RunStore facts and native header identity for exact sources',async()=>{
  const value=clone('codex');value.usage.attribution='exact-session-window-v1';value.usage.source!.header.id=['payload','id'];if(value.usage.capability.tier==='declarative')value.usage.capability.spec=structuredClone(value.usage.source!);
  const profile=new ProfileRegistry([value]).get('codex')!,ref:UsageSessionRef={profile,round:{...round,run_id:'run',attempt_id:'attempt',native_session_id:'native'},attribution:'exact-session-window-v1',run_id:'run',native_session_id:'native',identity_source:'observed'};
  const io=services({'/sessions/a.jsonl':jsonl(codexRows({type:'session_meta',payload:{cwd:'/checkout',id:'native'}}))});
  const run={run_id:'run',task_id:'task',cwd:'/checkout',argv:[],agent_session_id:'native',headless:{role:'executor',attempt_id:'attempt',base_version:0,route:round.route}};io.readRun=async()=>run;
  const measured=await readUsage(ref,io);expect(measured.status).toBe('measured');expect(measured.sourceEvidence[0]).toMatchObject({run_id:'run',native_session_id:'native'});

  const mixed=clone('codex');mixed.usage.attribution='exact-session-window-v1';mixed.usage.source!.header.id=['payload','id'];mixed.usage.source!.roots.push({kind:'run-log',via:'RunStore',run_id:'round.run_id'},{kind:'run-log',via:'RunStore',run_id:'round.run_id'});if(mixed.usage.capability.tier==='declarative')mixed.usage.capability.spec=structuredClone(mixed.usage.source!);
  const mixedProfile=new ProfileRegistry([mixed]).get('codex')!;
  io.readLines=async()=>({lines:codexRows({type:'session_meta',payload:{cwd:'/checkout',id:'different'}}).map(r=>JSON.stringify(r)),partial:false});
  io.readRunLog=async()=>({absolute_path:'/run/log',lines:codexRows({type:'session_meta',payload:{cwd:'/checkout'}}).map(r=>JSON.stringify(r)),partial:false});
  const joined=await readUsage({...ref,profile:mixedProfile},io);expect(joined.status).toBe('measured');if(joined.status==='measured')expect(joined.candidates).toHaveLength(1);
  expect(joined.problems[0]?.code).toBe('SOURCE_IDENTITY_MISMATCH');expect(joined.sourceEvidence).toHaveLength(2);
  run.agent_session_id='different';expect(await readUsage(ref,io)).toMatchObject({status:'unresolved',code:'USAGE_RUN_MISMATCH'});
 });
});

describe.skipIf(process.platform==='win32')('host profile continuity',()=>{
 it('keeps aliases and custom designated identities across fresh, automatic, managed and plain resumes',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tut-profile-continuity-'));
  try {
   const observed=clone('opencode');observed.id='custom-observed';observed.match.supported_executable_names=['oc-alias','oc-other'];
   const designated=clone('pi');designated.id='custom-designated';designated.match.supported_executable_names=['designated-alias'];
   for(const mode of ['run','resume'] as const)if(designated.invoke[mode].tier==='declarative')designated.invoke[mode].spec=designated.invoke[mode].spec.replace('--session-id','--conversation-id');
   const registry=new ProfileRegistry([observed,designated]);
   vi.spyOn(await import('../../../src/agents/registry.js'),'registryFromSnapshot').mockReturnValue(registry);
   vi.spyOn(agentProfiles,'match').mockImplementation((exe,platform,target)=>registry.match(exe,platform,target));
   const store=new RunStore(root),base=path.join(root,'sessions');
   for(const executable of ['oc-alias','oc-other','designated-alias']) {
    const bin=path.join(root,executable);await writeFile(bin,'#!/bin/sh\nexit 0\n',{mode:0o700});
    const profile=registry.match(bin)!,isDesignated=profile.id==='custom-designated';
    const task={task_id:executable,title:'continuity',version:0,flow:'direct' as const,cast:{executor:{agent:bin,args:isDesignated?[]:['--auto']}}};
    const input={task,role:'executor',records:[],hubRoot:root,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:1',env:{PI_CODING_AGENT_SESSION_DIR:base},launchCheckout:'rig' as const};
    const fresh=await buildHeadlessPlan(input),id=isDesignated?fresh.ownership.designated_session_id!:'ses_ALIAS123';
    expect(fresh.profile?.id).toBe(profile.id);expect(fresh.argv[0]).toBe(bin);
    if(isDesignated)expect(fresh.argv[fresh.argv.indexOf('--conversation-id')+1]).toBe(id);
    const runId=store.create();
    const meta:RunMeta={run_id:runId,task_id:task.task_id,pid:2147483000,pgid:2147483000,supervisor_pid:2147482999,argv:fresh.argv,cwd:root,started_at:at(0),ended_at:at(1),status:'exited',exit_code:0,...(!isDesignated?{agent_session_id:id}:{}),headless:fresh.ownership};
    await store.initialize(runId,meta);
    expect(previousSession([store.read(runId)],task,'executor',fresh.route,root).id).toBe(id);
    if(isDesignated) {
     const dir=piSessionDirFor(root,base);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,id+'.jsonl'),JSON.stringify({type:'session',id,cwd:root})+'\n');
    }
    const auto=await buildHeadlessPlan({...input,runs:[store.read(runId)]});
    expect(auto.sessionPlan?.expected_id).toBe(id);expect(auto.ownership.resume_from_run_id).toBe(runId);expect(auto.checkoutRoot).toBe(root);
    const managed=await planResume(store,runId,{instruction:'managed',env:{},piSessionsBase:base});
    expect(managed.profile?.id).toBe(profile.id);expect(managed.session.session_id).toBe(id);expect(managed.argv[0]).toBe(bin);expect(managed.cwd).toBe(root);
    const wrapperId=store.create();await store.initialize(wrapperId,{...meta,run_id:wrapperId,argv:['sh','-c','native agent']});
    await expect(planResume(store,wrapperId,{env:{},piSessionsBase:base})).rejects.toMatchObject({reason:'unsupported-agent'});
    const plainId=store.create(),plain={...meta,run_id:plainId};delete plain.headless;
    // Historical Pi plain grammar is independent of the managed selector template.
    if(isDesignated)plain.argv=[bin,'--session-id',id,'--','old'];
    await store.initialize(plainId,plain);
    const manual=await planResume(store,plainId,{instruction:'plain',env:{},piSessionsBase:base});
    expect(manual.session.session_id).toBe(id);expect(manual.profile?.id).toBe(profile.id);expect(manual.argv[0]).toBe(bin);expect(manual.cwd).toBe(root);
   }
  } finally {vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
 });
});

describe.skipIf(process.platform==='win32')('plain supervisor capture through the public codec',()=>{
 it.each(['workspace','disabled'] as const)('preserves %s capture without a managed plan',async mode=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tut-plain-capture-'));
  await import(path.resolve('dist/app/agents.js'));
  const {startRun}=await import(path.resolve('dist/core/run/control.js')) as typeof import('../../../src/core/run/control.js');
  const directory=path.join(root,'.context-hub','agents');await mkdir(directory,{recursive:true});
  const executable=path.join(root,'raw-agent');
  if(mode==='workspace') {
   const profile=clone('opencode');profile.id='raw-agent';profile.match.supported_executable_names=['raw-agent'];
   await writeFile(path.join(directory,'raw-agent.json'),JSON.stringify(profile));
  } else await writeFile(path.join(directory,'codex.json'),JSON.stringify({id:'codex'}));
  const event=mode==='workspace'?{type:'step_start',timestamp:1,sessionID:'ses_RAW123'}:{type:'thread.started',thread_id:'must-not-fallback'};
  await writeFile(executable,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(event))});\n`,{mode:0o700});
  const store=new RunStore(root),id=await startRun(store,[executable],root);
  const deadline=Date.now()+5000;
  while(!store.read(id).ended_at&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  const run=store.read(id);expect(run.ended_at).toBeDefined();expect(run.exit_code).toBe(0);
  expect(run.agent_session_id).toBe(mode==='workspace'?'ses_RAW123':undefined);
 });
});

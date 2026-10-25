import { planForPlatform } from '../src/core/launcher/target-resolver.js';
import { stopWindowsFixtureRuns } from './helpers/run-cleanup.js';
import { writeNodeExecutable, writePiPackageFixture } from './helpers/executable.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, chmodSync, closeSync, readSync, fstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { readLaunchMode, writeConfigKey, parseConfigValue, readFlowMode } from '../src/core/common/config.js';
import { buildHeadlessPlan, headlessGeneration, nativeArgv, previousSession } from '../src/standalone/launcher-headless/plan.js';
import { AttemptNotifications, HeadlessRuntime, complete } from '../src/standalone/launcher-headless/runtime.js';
import { RunStore, delay, probe, type RunMeta } from '../src/core/run/store.js';
import { startRun, stopRun, attachRun } from '../src/core/run/control.js';
import { startServer, type RunningServer } from '../src/core/hub/server.js';
import { hubCreate, hubRead, hubPublish } from '../src/core/hub/hub-client.js';
import { Notifier, type StateTask, type NotifierDeps } from '../src/core/notifier/notifier.js';
import { headlessLaunchSelected } from '../src/core/run/launch-entry.js';
import type { WindowsOwnership } from '../src/standalone/launcher-headless/windows-plan.js';
import { verifyWindowsPiSession } from '../src/core/run/windows-pi-session.js';
import type { ContextRecord, LaunchInvocation } from '../src/core/common/types.js';

// Isolated audit fixtures deliberately remain outside the source repository.
const WINDOWS = process.platform === 'win32';
const roots: string[] = []; const notifiers: Notifier[] = []; const servers: RunningServer[] = []; const runs: {store:RunStore;id:string}[] = [];
function root() { const r=realpathSync(mkdtempSync(path.join(os.tmpdir(),'tut-headless-'))); roots.push(r); return r; }
function config(r:string,value:unknown) { mkdirSync(path.join(r,'.context-hub'),{recursive:true});writeFileSync(path.join(r,'.context-hub/config.json'),JSON.stringify(value)); }
function record(version:number,content_type='note',role='human',payload:Record<string,unknown>={}):ContextRecord { return {version,task_id:'t',content_type,role,timestamp:new Date().toISOString(),payload:{summary:'fixture',body:'fixture',...payload}}; }
async function until(fn:()=>boolean|Promise<boolean>,ms=process.platform === 'win32' ? 45_000 : 5000) { const end=performance.now()+ms;while(!await fn()){if(performance.now()>end)throw new Error('condition timed out');await delay(25);} }
function fixture(r:string,code:string,name='codex') { const bin=path.join(r,'bin');mkdirSync(bin,{recursive:true});const file=path.join(bin,name);return writeNodeExecutable(file, code); }
function log(store:RunStore,id:string) {const fd=store.openLog(id);try{const b=Buffer.alloc(fstatSync(fd).size);readSync(fd,b);return b.toString();}finally{closeSync(fd);}}
afterEach(async()=>{
  const ownedRoots=roots.splice(0);
  try {
    for(const n of notifiers.splice(0)) await n.close();
    await stopWindowsFixtureRuns(ownedRoots);
  } finally {
    for(const {store,id} of runs.splice(0)) {try{if(process.platform!=='win32'&&!complete(store.read(id))) await stopRun(store,id);}catch{}}
    for(const s of servers.splice(0))await s.close();
    vi.unstubAllEnvs();
    // Archives remain on disk; release per-test bookkeeping even after failure.
  }
});

describe('strict launch configuration',()=>{
  it('defaults without writes and preserves sibling/unknown values on set',async()=>{
    const r=root(), c=path.join(r,'.context-hub');expect(await readLaunchMode(c)).toBe('tui');expect(existsSync(c)).toBe(false);
    config(r,{flow_mode:'auto',auto:{launch_roles:['executor'],extra:3},unknown:{keep:true}});
    const before=readFileSync(path.join(c,'config.json'),'utf8');expect(await readLaunchMode(c)).toBe('tui');expect(readFileSync(path.join(c,'config.json'),'utf8')).toBe(before);
    await writeConfigKey(c,{key:'launch_mode',value:'tui'});expect(await readLaunchMode(c)).toBe('tui');
    await writeConfigKey(c,{key:'launch_mode',value:'detached'});expect(await readLaunchMode(c)).toBe('detached');
    expect(JSON.parse(readFileSync(path.join(c,'config.json'),'utf8'))).toMatchObject({auto:{extra:3},unknown:{keep:true}});
    for(const v of ['','TUI','null','headless '])expect(parseConfigValue('launch_mode',v).ok).toBe(false);
    expect(parseConfigValue('launch_mode','headless')).toMatchObject({ok:true});
  });
  it.each([null,'','bad',1,false,[],{}])('rejects present invalid key %j without breaking flow reads',async v=>{
    const r=root();config(r,{flow_mode:'auto',launch_mode:v});await expect(readLaunchMode(path.join(r,'.context-hub'))).rejects.toThrow('launch_mode');expect(await readFlowMode(path.join(r,'.context-hub'))).toBe('auto');
  });
  it('rejects corrupt and unreadable files',async()=>{
    const r=root(),c=path.join(r,'.context-hub');config(r,{});writeFileSync(path.join(c,'config.json'),'{');await expect(readLaunchMode(c)).rejects.toThrow('corrupt');
    const r2=root();mkdirSync(path.join(r2,'config.json'));await expect(readLaunchMode(r2)).rejects.toThrow('unreadable');
  });
});
describe('headless generation and argv',()=>{
  it('only online human instructions advance a launched generation; old markers still count',()=>{
    const content=record(1,'design','architect'),marker=record(2,'note','human',{launch:{role:'executor',base_version:1}}),human=record(3);
    expect(headlessGeneration([content,marker,human],'executor')).toMatchObject({blocked:true});
    expect(headlessGeneration([content,marker,human],'executor',3)).toMatchObject({blocked:false,trigger:3});
    for(const r of [record(3,'note','executor'),record(3,'note','human',{ack:true}),record(3,'note','human',{launch:{role:'reviewer'}})])expect(headlessGeneration([content,marker,r],'executor',3).blocked).toBe(true);
    expect(headlessGeneration([content,marker,human,record(4,'note','human',{launch:{role:'executor'}})],'executor',3).blocked).toBe(true);
  });
  it('preserves model/config args once and a Unicode prompt as one argv item',()=>{
    const p='任务 空格🙂';expect(nativeArgv({agent:'codex',args:['-m','model','-c','model_reasoning_effort=high']},p)).toEqual(['codex','-m','model','-c','model_reasoning_effort=high','exec','--json',p]);
    expect(nativeArgv({agent:'codex',args:['exec','--json','-m','model']},p,'12345678')).toEqual(['codex','-m','model','exec','resume','--json','12345678',p]);
    expect(nativeArgv({agent:'pi',args:['--model','model']},p,'12345678')).toEqual(['pi','--model','model','--print','--mode','json','--session-id','12345678','--',p]);
    for(const a of ['resume','review','--last','--cd','--worktree'])expect(()=>nativeArgv({agent:'codex',args:[a]},p)).toThrow();
    expect(()=>nativeArgv({agent:'other',args:[]},p)).toThrow('unsupported-headless-agent');
    expect(()=>nativeArgv({agent:'pi',args:['--continue']},p)).toThrow('session');
    expect(()=>nativeArgv({agent:'pi',args:['--model','model','extra-prompt']},p)).toThrow('positional');
  });
  it('separates three roots, routes and process environments without mutation',async()=>{
    const hub=root(), routing=root(), checkout=root();const agent=fixture(hub,'');config(routing,{flow_mode:'manual'});
    writeFileSync(path.join(routing,'.context-hub/workspace.json'),JSON.stringify({roles:{executor:{agent,args:['-m','test']}}}));
    const baseEnv={...process.env,TUT_PROJECT_ROOT:routing,TUT_HUB_ROOT:'wrong'};const snapshot=JSON.stringify(baseEnv);
    const task={task_id:'t',title:'t',version:1,checkout:{kind:'worktree' as const,path:checkout}};
    const [a,b]=await Promise.all([buildHeadlessPlan({task,role:'executor',records:[record(1,'design','architect')],hubRoot:hub,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:2',env:baseEnv}),buildHeadlessPlan({task:{...task,task_id:'other'},role:'executor',records:[record(1,'design','architect')],hubRoot:hub,hubUrl:'http://127.0.0.1:3',eventUrl:'http://127.0.0.1:4',env:baseEnv})]);
    expect(a).toMatchObject({hubRoot:hub,routingRoot:routing,checkoutRoot:checkout,route_source:'workspace-project'});expect(a.env.TUT_HUB_ROOT).toBe(hub);expect(a.env.TUT_HUB_URL).not.toBe(b.env.TUT_HUB_URL);expect(JSON.stringify(baseEnv)).toBe(snapshot);
    expect(a.prompt.replaceAll('\\','/')).toContain('/skills/executor.md');expect(a.argv.at(-1)).toBe(a.prompt);
  });
  it('resumes only an exact ended task/role/route/checkout session',()=>{
    const route={agent:'codex',args:[]};const m={run_id:'old',task_id:'t',cwd:'/checkout',started_at:'2026-01-01',ended_at:'2026-01-02',agent_session_id:'exact-session',headless:{role:'executor',route}} as unknown as RunMeta;
    expect(previousSession([m],{task_id:'t',title:'t'},'executor',route,'/checkout')).toMatchObject({id:'exact-session',run:'old'});
    for(const role of ['architect','reviewer'])expect(previousSession([m],{task_id:'t',title:'t'},role,route,'/checkout').id).toBeUndefined();
    expect(previousSession([m],{task_id:'other',title:'t'},'executor',route,'/checkout').id).toBeUndefined();expect(previousSession([m],{task_id:'t',title:'t'},'executor',route,'/changed').id).toBeUndefined();
    expect(previousSession([m],{task_id:'t',title:'t'},'executor',{...route,args:['-m','new']},'/checkout').id).toBeUndefined();
  });
  it('reserves failure keys before async sends and evicts FIFO at 1024',async()=>{
    const notices=new AttemptNotifications();let calls=0;let release!:()=>void;const pending=new Promise<void>(r=>release=r);
    const first=notices.once('a',async()=>{calls++;await pending;});await notices.once('a',async()=>{calls++;});expect(calls).toBe(1);release();await first;
    for(let i=0;i<1024;i++)await notices.once(`k${i}`,async()=>{});await notices.once('a',async()=>{calls++;});expect(calls).toBe(2);
  });
});

// Source modules exercise policy; the actual detached supervisor is the built
// same-package module used in installed execution (never a PATH tut).
const builtControl = await import(path.resolve('dist/core/run/control.js')) as typeof import('../src/core/run/control.js');
const HELD_AGENT = `const fs=require('node:fs');console.log('ready');setInterval(()=>{if(fs.existsSync(process.env.TUT_FIXTURE_RELEASE))process.exit(0)},20);setTimeout(()=>process.exit(124),180000).unref();`;
async function realHarness(code:string, launchMode:unknown='headless', extra:Partial<NotifierDeps>={}, nativePi=false) {
  const r=root();
  // A real verified Pi entry exercises Windows continuity and root-exit/Job
  // separation without claiming automatic Windows Codex session capture.
  const piHeader = `const fs0=require('node:fs'),path0=require('node:path'),a0=process.argv.slice(2);
    const id0=a0[a0.indexOf('--session-id')+1],dir0=a0[a0.indexOf('--session-dir')+1];
    if(!id0||!dir0)throw Error('missing frozen Pi session');
    fs0.mkdirSync(dir0,{recursive:true});const file0=path0.join(dir0,id0+'.jsonl');
    if(!fs0.existsSync(file0))fs0.writeFileSync(file0,JSON.stringify({type:'session',id:id0,cwd:process.cwd()})+'\\n');
  `;
  const agent=WINDOWS&&nativePi ? writePiPackageFixture(path.join(r,'bin'),piHeader+code+';setTimeout(()=>process.exit(124),180000).unref();') : fixture(r,code);const releaseFile=path.join(r,'fixture-release');vi.stubEnv('TUT_FIXTURE_RELEASE',releaseFile);
  config(r,{flow_mode:'auto',auto:{launch_roles:['executor','reviewer']},...(launchMode==='missing'?{}:{launch_mode:launchMode})});
  vi.stubEnv('PI_CODING_AGENT_DIR',path.join(r,'pi-home'));vi.stubEnv('PI_CODING_AGENT_SESSION_DIR',path.join(r,'sessions'));
  vi.stubEnv('TUT_HUB_ROOT',r);vi.stubEnv('TUT_PROJECT_ROOT',r);
  const server=await startServer({root:path.join(r,'.context-hub'),port:0});servers.push(server);
  const messages:{title:string;body:string}[]=[];const logs:string[]=[];
  const runtime=new HeadlessRuntime(r,{start:builtControl.startRun,stop:builtControl.stopRun,send:async msg=>{messages.push(msg);},log:line=>logs.push(line),read:async id=>(await hubRead(server.url,id)).versions});
  const forbidden=vi.fn(async()=>{throw new Error('Herdr was called');});
  const notifier=new Notifier({url:server.url,eventPort:1,interval:1,stallTimeoutMin:0},{headlessRuntime:runtime,channelsFor:()=>[{name:'recording',send:async msg=>{messages.push(msg);}}],log:line=>logs.push(line),listAnchorPanes:forbidden,listPanes:forbidden,launch:forbidden,cleanupPanes:forbidden,remediator:{remediate:forbidden},relayHostStatus:async()=>{},
    ...(extra.launchInvocation && !extra.resolveTargetWithSource ? {
      resolveTargetWithSource:async()=>({route:agent,source:'task-cast' as const,plan:await planForPlatform({agent,args:[]},{platform:'linux'})}),
    } : {}),...extra});notifiers.push(notifier);
  await notifier.requestCompare();
  const task=await hubCreate(server.url,{title:'headless fixture',description:'isolated protocol fixture',flow:'direct',creator:'test',role:'human',cast:{executor:agent,reviewer:agent}});
  const tick=()=>notifier.requestCompare();
  const metas=()=>{
    const actual=runtime.runs().filter(m=>m.task_id===task.task_id);
    for(const m of actual) if(WINDOWS&&!complete(m)) {
      if(m.windows?.error) throw new Error(`native fixture ${m.run_id}: ${m.windows.error}`);
      if(probe(m.supervisor_pid)===false) throw new Error(`native fixture ${m.run_id}: supervisor gone before committed completion`);
    }
    return actual;
  };
  const collect=()=>{for(const m of metas())if(!runs.some(v=>v.id===m.run_id))runs.push({store:runtime.store,id:m.run_id});};
  const note=async(role='human',payload:Record<string,unknown>={})=>hubPublish(server.url,{task_id:task.task_id,role,content_type:'note',payload:{summary:'fixture instruction',body:'isolated test instruction',...payload}});
  return {r,agent,server,runtime,notifier,messages,logs,forbidden,task,tick,metas,collect,note,release:()=>writeFileSync(releaseFile,'')};
}

describe('headless real Hub, marker, supervisor and process protocol',()=>{
  it.each(['detached', 'headless'])('starts in %s mode, appears in ps/attach, wakes exactly once on human note with exact resume',async mode=>{
    const h=await realHarness(`console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'})); console.log(JSON.stringify({argv:process.argv.slice(2),root:process.env.TUT_HUB_ROOT,cwd:process.cwd()}));`,mode,{},WINDOWS);
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();
    expect(h.metas()[0]!.headless).toMatchObject({role:'executor',base_version:0,trigger_version:0});
    const listing=builtControl.listRuns(h.runtime.store);expect(listing.runs[0]).toMatchObject({task_id:h.task.task_id,status:'exited'});
    let output='';await builtControl.attachRun(h.runtime.store,h.metas()[0]!.run_id,new Writable({write(chunk,_,done){output+=chunk.toString();done();}}));const environmentLine=output.split(/\r?\n/).find(line=>line.includes('"root":'));expect(JSON.parse(environmentLine!)).toMatchObject({root:h.r});expect(output).toContain('thread.started');
    await h.note();await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(2);
    if(WINDOWS) {
      const first=h.metas()[0]!,second=h.metas()[1]!;
      const frozen=(first.headless as WindowsOwnership).windows!.pi_session!;
      expect(frozen.session_directory).toBe(path.join(h.r,'sessions'));
      const session=verifyWindowsPiSession(frozen,first.headless!.designated_session_id!);
      expect(session.header_cwd).toBe(h.r);
      expect(second.headless!.designated_session_id).toBe(first.headless!.designated_session_id);
      const logical=(second.headless as WindowsOwnership).windows!.logical_argv;
      expect(logical).toContain('--session-id');expect(logical).toContain(session.session_id);
      expect(second.argv).toContain(session.session_id);
    } else {
      expect(h.metas()[1]!.argv).toContain('resume');expect(h.metas()[1]!.argv).toContain('12345678-1234-1234-1234-123456789abc');
    }
    expect(h.metas()[1]!.headless!.resume_from_run_id).toBe(h.metas()[0]!.run_id);
    const markers=(await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch);
    expect(markers).toHaveLength(2);expect(markers[0]!.payload.launch).toMatchObject({launch_mode:'headless',attempt_id:h.metas()[0]!.headless!.attempt_id});expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?180_000:5000);
  it('coalesces multiple human notes while old run is active and waits for full group completion',async()=>{
    const h=await realHarness(HELD_AGENT);
    await h.tick();await until(()=>h.metas().length===1);h.collect();await h.note();await h.note();await h.tick();expect(h.metas()).toHaveLength(1);expect(h.runtime.busy(h.task.task_id)).toBe(true);h.release();
    await until(()=>!!h.metas()[0]!.ended_at);await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));await h.tick();expect(h.metas()).toHaveLength(2);expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?180_000:5000);
  it('does not wake on worker notes, ack, launch markers, manual mode or config switch alone',async()=>{
    const h=await realHarness(`process.exit(0)`);await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();
    await h.note('executor');await h.tick();await h.note('human',{ack:true});await h.tick();expect(h.metas()).toHaveLength(1);
    config(h.r,{flow_mode:'manual',auto:{launch_roles:['executor']},launch_mode:'tui'});await h.note();await h.tick();config(h.r,{flow_mode:'auto',auto:{launch_roles:['executor']},launch_mode:'headless'});await h.tick();expect(h.metas()).toHaveLength(1);
  },WINDOWS?180_000:5000);
  it('notifier close leaves a detached run alive; cold baseline observes without replay',async()=>{
    const h=await realHarness(HELD_AGENT);await h.tick();await until(()=>h.metas().length===1);h.collect();await h.notifier.close();expect(probe(h.metas()[0]!.pid)).toBe(true);
    const coldMessages:unknown[]=[];const restored=new HeadlessRuntime(h.r,{start:builtControl.startRun,send:async msg=>{coldMessages.push(msg);},log:()=>{},read:async()=>[]});restored.restore();expect(restored.busy(h.task.task_id)).toBe(true);h.release();await until(()=>!!h.metas()[0]!.ended_at);await restored.observe();expect(restored.busy(h.task.task_id)).toBe(false);
    const cold=new HeadlessRuntime(h.r,{send:async msg=>{coldMessages.push(msg);},log:()=>{},read:async()=>[]});cold.restore();await cold.observe();expect(cold.busy(h.task.task_id)).toBe(false);
  },WINDOWS?180_000:5000);
  it('reports actual spawn failure (broken interpreter) with attempt identity, once',async()=>{
    const h=await realHarness('');writeFileSync(h.agent,'#!/nonexistent/tut-e2-interpreter\n');chmodSync(h.agent,0o700);
    if(process.platform==='win32') {
      // An invalid .exe reaches the real suspended CreateProcessW boundary.
      // The Windows control plane preserves an uncertain start intent and its marker, rather than
      // treating an unconfirmed broker handshake as a safe retry.
      await h.tick();await until(()=>h.messages.some(m=>m.body.includes('reason=startup-unconfirmed')));await h.tick();await h.tick();
      const notices=h.messages.filter(m=>m.body.includes('reason=startup-unconfirmed'));
      expect(notices).toHaveLength(1);expect(notices[0]!.body).toContain('target CreateProcessW');
      expect(h.runtime.runs()).toHaveLength(0);
      const listed=builtControl.listRuns(h.runtime.store);expect(listed.errors).toHaveLength(1);
      const intent=h.runtime.store.readStartIntent(h.runtime.store.list()[0]!);
      expect(intent.startup).toBe('pending');
      const markers=(await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch);
      expect(markers).toHaveLength(1);expect(markers[0]!.payload.launch).toMatchObject({attempt_id:intent.headless.attempt_id});
      expect(notices[0]!.body).toContain(`attempt_id=${intent.headless.attempt_id}`);
      return;
    }
    await h.tick();await until(()=>h.messages.some(m=>m.body.includes('reason=spawn-failed')));await h.tick();await h.tick();
    const failures=h.messages.filter(m=>m.title.includes('give-up'));expect(failures).toHaveLength(1);expect(failures[0]!.body).toContain('attempt_id=');expect(failures[0]!.body).toContain(h.task.task_id);expect(failures[0]!.body).not.toContain('Enter');expect(h.runtime.runs()).toHaveLength(0);expect(builtControl.listRuns(h.runtime.store).errors).toHaveLength(1);
  },WINDOWS?180_000:5000);
  it('reports immediate nonzero exit once; exit zero is a missing-publish diagnostic',async()=>{
    for(const exit of [7,0]) {
      const h=await realHarness(`process.exit(${exit});`);await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();await h.tick();
      expect(h.messages.filter(m=>m.title.includes('give-up'))).toHaveLength(exit?1:0);expect(h.messages.some(m=>m.body.includes(exit?'exit_code=7':'stopped-without-publish'))).toBe(true);
    }
  },WINDOWS?180_000:5000);
  it('observes root nonzero before lingering group exits; close uses cooperative stop and no pane cleanup',async()=>{
    const h=await realHarness(`const {spawn}=require('child_process');spawn(process.execPath,['-e',"console.log('child ready');setTimeout(()=>process.exit(124),120000)"],{detached:process.platform==='win32',stdio:'inherit'}).unref();process.exit(9);`,'headless',{},WINDOWS);
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.root_exited_at);await h.tick();
    expect(h.metas()[0]!.ended_at).toBeUndefined();if(WINDOWS)expect(h.metas()[0]!.windows!.observation).toMatchObject({root_exited:true,job_empty:false});expect(h.runtime.busy(h.task.task_id)).toBe(true);expect(h.messages.filter(m=>m.body.includes('exit_code=9'))).toHaveLength(1);
    await h.note();await h.tick();expect(h.metas()).toHaveLength(1);
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'human',content_type:'decision',payload:{summary:'close fixture',body:'isolated test close',decision:'close'}});await h.tick();
    await until(()=>!!h.metas()[0]!.ended_at,WINDOWS?90_000:7000);expect(h.metas()[0]!.stop_request?.result).toMatchObject({success:true,scope:WINDOWS?'root-and-owned-job':'root-and-original-group',descendants_check:WINDOWS?'job-members-only':'not-performed'});await h.tick();expect(h.metas()).toHaveLength(1);expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?180_000:10000);
  it('explicit stop cancels pending human wake and is not an unexpected failure',async()=>{
    const h=await realHarness(`console.log('ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>log(h.runtime.store,h.metas()[0]!.run_id).includes('ready'));
    await h.note();await h.tick();await builtControl.stopRun(h.runtime.store,h.metas()[0]!.run_id);await h.tick();await h.tick();expect(h.metas()).toHaveLength(1);expect(h.messages.filter(m=>m.title.includes('give-up'))).toHaveLength(0);
  },WINDOWS?180_000:5000);
  it.each([false,true])('preserves new notes after successful stop on its first observed tick (read retry=%s)',async retry=>{
    let fail=false;let url='';
    const readLog=async(id:string)=>{if(fail)throw new Error('temporary post-stop log failure');return (await hubRead(url,id)).versions;};
    const h=await realHarness(`console.log('ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`,'headless',{readLog});url=h.server.url;
    await h.tick();await until(()=>h.metas().length===1);h.collect();const first=h.metas()[0]!;
    await until(()=>log(h.runtime.store,first.run_id).includes('ready'));
    await h.note();await h.tick(); // Old candidate must be cancelled by stop.
    expect((await builtControl.stopRun(h.runtime.store,first.run_id)).success).toBe(true);
    await h.note();const latest=await h.note(); // No poll between stop and new instructions.
    if(retry){fail=true;await h.tick();expect(h.metas()).toHaveLength(1);fail=false;}
    await h.tick();await until(()=>h.metas().length===2);h.collect();
    const second=h.metas()[1]!;
    expect(second.headless!.trigger_version).toBe(latest.version);
    expect(Date.parse(second.started_at)).toBeGreaterThanOrEqual(Date.parse(h.runtime.store.read(first.run_id).ended_at!));
    await h.tick();await h.tick();expect(h.metas()).toHaveLength(2);
    expect(h.messages.filter(m=>m.title.includes('give-up'))).toHaveLength(0);
  },WINDOWS?180_000:5000);
  it('does not revive an unseen instruction issued before stop; a later new instruction works',async()=>{
    const h=await realHarness(`console.log('ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);
    await h.tick();await until(()=>h.metas().length===1);h.collect();const first=h.metas()[0]!;
    await until(()=>log(h.runtime.store,first.run_id).includes('ready'));
    await h.note();await delay(10); // Deliberately do not poll this old note.
    expect((await builtControl.stopRun(h.runtime.store,first.run_id)).success).toBe(true);
    await h.tick();await h.tick();expect(h.metas()).toHaveLength(1);
    await h.note();await h.tick();await until(()=>h.metas().length===2);h.collect();
  },WINDOWS?180_000:5000);
  it('invalid mode refuses without marker; later human edge reads fixed mode fresh',async()=>{
    const h=await realHarness('',null);await h.tick();expect((await hubRead(h.server.url,h.task.task_id)).versions).toHaveLength(0);expect(h.messages.some(m=>m.body.includes('invalid launch_mode'))).toBe(true);
    config(h.r,{flow_mode:'auto',auto:{launch_roles:['executor']},launch_mode:'headless'});await h.note();await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?180_000:5000);
});

describe('headless decision seams',()=>{
  it.each(['missing', 'tui'])('auto and manual doors both select tui for launch_mode=%s',async mode=>{
    const tui: LaunchInvocation[]=[];
    const h=await realHarness('',mode,{
      launchInvocation:async invocation=>{tui.push(invocation);return 'launched';},
      listAnchorPanes:async()=>[{pane_id:'fixture:anchor',label:'tut-hub',workspace_id:'fixture',cwd:process.env.TUT_HUB_ROOT!}],
    });
    expect(await headlessLaunchSelected(h.r)).toBe(false);
    await h.tick();await until(()=>tui.length===1);
    expect(tui[0]!.route).toEqual({agent:h.agent,args:[]});
    expect(h.metas()).toHaveLength(0);
    const markers=(await hubRead(h.server.url,h.task.task_id)).versions;
    expect(markers).toHaveLength(1);
    expect(markers[0]!.payload.launch).not.toHaveProperty('launch_mode');
  },WINDOWS?180_000:5000);
  it('missing launch_mode and missing anchor reports failure without falling back to headless',async()=>{
    const h=await realHarness('','missing',{listAnchorPanes:async()=>[]});
    await h.tick();
    expect(h.metas()).toHaveLength(0);
    expect((await hubRead(h.server.url,h.task.task_id)).versions).toHaveLength(0);
    expect(h.messages.some(m=>m.title.includes('auto launch failed') && m.body.includes('anchor'))).toBe(true);
  },WINDOWS?180_000:5000);
  it.each(['detached', 'headless'])('%s selects detached at both doors',async mode=>{
    const h=await realHarness('',mode);expect(await headlessLaunchSelected(h.r)).toBe(true);
    await h.tick();await until(()=>h.metas().length===1);h.collect();
    expect(h.forbidden).not.toHaveBeenCalled();
    await until(()=>!!h.metas()[0]!.ended_at);
  },WINDOWS?180_000:5000);
  it('reads mode on observation and launch; switches to TUI then headless on legal rounds',async()=>{
    const tui:unknown[]=[];const reader=vi.fn(readLaunchMode);
    const h=await realHarness(`console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'}));`, 'headless',{
      readLaunchMode:reader,launchInvocation:async p=>{tui.push(p);return 'launched';},resolveTargetWithSource:async()=>({route:'codex',source:'task-cast',plan:await planForPlatform({agent:'codex',args:[]},{platform:'linux'})}),
      listAnchorPanes:async()=>[{pane_id:'fixture:anchor',label:'tut-hub',workspace_id:'fixture',cwd:process.env.TUT_HUB_ROOT!}],
    });
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();expect(reader.mock.calls.length).toBeGreaterThanOrEqual(3);
    const beforeSwitch = reader.mock.calls.length;
    config(h.r,{flow_mode:'auto',auto:{launch_roles:['executor','reviewer']},launch_mode:'tui'});await h.tick();expect(reader).toHaveBeenCalledTimes(beforeSwitch + 1);
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});await h.tick();await until(()=>tui.length===1);expect(reader).toHaveBeenCalledTimes(beforeSwitch + 3);
    config(h.r,{flow_mode:'auto',auto:{launch_roles:['executor','reviewer']},launch_mode:'headless'});
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'reviewer',content_type:'review',payload:{summary:'fixture revision request',body:'fixture revision request',verdict:'fail_code'}});await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));expect(reader).toHaveBeenCalledTimes(beforeSwitch + 5);expect(tui).toHaveLength(1);
  },WINDOWS?180_000:5000);
  it('does not launch a new role while the preceding role run remains alive',async()=>{
    const h=await realHarness(HELD_AGENT);await h.tick();await until(()=>h.metas().length===1);h.collect();
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});await h.tick();expect(h.metas()).toHaveLength(1);h.release();
    await until(()=>!!h.metas()[0]!.ended_at);await h.tick();await until(()=>h.metas().length===2);h.collect();expect(h.metas()[1]!.headless!.role).toBe('reviewer');expect(h.metas()[1]!.headless!.resume_from_run_id).toBeUndefined();await until(()=>h.metas().every(m=>!!m.ended_at));
  },WINDOWS?180_000:5000);
  it('re-reads a marker conflict once and skips the covered generation without spawn',async()=>{
    const h=await realHarness('');const original=h.runtime.mark.bind(h.runtime);const mark=vi.spyOn(h.runtime,'mark').mockImplementation(async p=>{await original(p);await original(p);});
    await h.tick();expect(mark).toHaveBeenCalledTimes(1);expect(h.metas()).toHaveLength(0);expect(h.logs.some(l=>l.includes('already launched'))).toBe(true);
  },WINDOWS?180_000:5000);
  it('retains a failed note-read interval and launches once after read recovery',async()=>{
    let fail=false;let url='';const read=vi.fn(async(id:string)=>{if(fail)throw new Error('read failed');return (await hubRead(url,id)).versions;});
    const h=await realHarness('process.exit(0)','headless',{readLog:read});url=h.server.url;
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();await h.note();fail=true;await h.tick();expect(h.metas()).toHaveLength(1);fail=false;await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));await h.tick();expect(h.metas()).toHaveLength(2);
  },WINDOWS?180_000:5000);
  it('cold restart blocks an unresolved startup intent and does not retry a known spawn failure',async()=>{
    const r=root(),store=new RunStore(r);const intent={task_id:'t',cwd:r,headless:{schema:1 as const,role:'executor',attempt_id:'12345678-1234-1234-1234-123456789abc',base_version:0,trigger_version:0,route:{agent:'codex',args:[]},route_source:'task-cast',session_reason:'fresh'}};
    const pending=store.create();await store.writeStartIntent(pending,{...intent,startup:'pending'});
    const messages:unknown[]=[];const runtime=new HeadlessRuntime(r,{send:async m=>{messages.push(m);},log:()=>{},read:async()=>[]});runtime.restore();expect(runtime.busy('t')).toBe(true);await runtime.observe();await runtime.observe();expect(messages).toHaveLength(1);
    const r2=root(),s2=new RunStore(r2),failed=s2.create();await s2.writeStartIntent(failed,{...intent,cwd:r2,startup:'failed'});const cold=new HeadlessRuntime(r2,{send:async()=>{},log:()=>{},read:async()=>[]});cold.restore();expect(cold.busy('t')).toBe(false);
  },WINDOWS?180_000:5000);
  it.each([{flow_mode:'manual',auto:{launch_roles:['executor']}},{flow_mode:'auto',auto:{launch_roles:[]}}])('keeps manual/whitelist gates before marker for %j',async cfg=>{
    const h=await realHarness('');config(h.r,cfg);await h.tick();expect(h.metas()).toHaveLength(0);expect((await hubRead(h.server.url,h.task.task_id)).versions).toHaveLength(0);expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?180_000:5000);
});


describe('broken config fail-visible projection',()=>{
  it('alerts when /state safely falls back from auto to manual for a broken file',async()=>{
    const h=await realHarness('');writeFileSync(path.join(h.r,'.context-hub/config.json'),'{');await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(0);expect((await hubRead(h.server.url,h.task.task_id)).versions).toHaveLength(0);
    await until(()=>h.messages.some(m=>m.title==='TUT: invalid launch configuration'));
    expect(h.messages.filter(m=>m.title==='TUT: invalid launch configuration')).toHaveLength(1);
    expect(h.messages.some(m=>m.body.includes('unreadable or corrupt'))).toBe(true);
  });
});

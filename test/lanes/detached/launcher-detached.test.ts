import { nativeFixtureTimeoutMs } from '../../environment.js';
import { planForPlatform } from '../../../src/core/launcher/target-resolver.js';
import { reapFixtureRuns } from '../../helpers/fixture-reaper.js';
import { writeNodeExecutable, writePiPackageFixture } from '../../helpers/executable.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, chmodSync, closeSync, readSync, fstatSync } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Writable } from 'node:stream';
import { readLaunchMode, writeConfigKey, parseConfigValue, readFlowMode } from '../../../src/core/common/config.js';
import { buildHeadlessPlan, headlessGeneration, nativeArgv, previousSession } from '../../../src/standalone/launcher-detached/plan.js';
import { AttemptNotifications, HeadlessRuntime, complete } from '../../../src/standalone/launcher-detached/runtime.js';
import { RunStore, delay, probe, type RunMeta } from '../../../src/core/run/store.js';
import { startRun, stopRun, attachRun } from '../../../src/core/run/control.js';
import { startServer, type RunningServer } from '../../../src/hub/server.js';
import { hubCreate, hubRead, hubPublish } from '../../../src/hub/hub-client.js';
import { Notifier, type StateTask, type NotifierDeps } from '../../../src/core/notifier/notifier.js';
import { headlessLaunchSelected } from '../../../src/standalone/launcher-detached/start-next.js';
import type { WindowsOwnership } from '../../../src/core/run/windows-launch.js';
import { verifyWindowsPiSession } from '../../../src/agents/public/native-compat.js';
import * as checkoutProvider from '../../../src/core/launcher/checkout-provider.js';
import { writeAgentBinding, writeConfigRole } from '../../../src/core/common/config.js';
import { parseAgentBinding } from '../../../src/core/common/config-intent.js';
import type { ContextRecord, LaunchInvocation } from '../../../src/protocol/types.js';
import { launchBlocked } from '../../../src/core/launcher/launch.js';

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
    try { for(const n of notifiers.splice(0)) await n.close(); }
    finally { await reapFixtureRuns(ownedRoots); }
  } finally {
    runs.splice(0);
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
const builtControl = await import(path.resolve('dist/core/run/control.js')) as typeof import('../../../src/core/run/control.js');
const HELD_AGENT = `const fs=require('node:fs');console.log('ready');setInterval(()=>{if(fs.existsSync(process.env.TUT_FIXTURE_RELEASE))process.exit(0)},20);setTimeout(()=>process.exit(124),180000).unref();`;
async function realHarness(code:string, launchMode:unknown='headless', extra:Partial<NotifierDeps>={}, nativePi=false, opts:{flow?:'full'|'direct'|'solo';description?:string;agent?:string;args?:string[]}={}) {
  const r=root();
  // A real verified Pi entry exercises Windows continuity and root-exit/Job
  // separation without claiming automatic Windows Codex session capture.
  const piHeader = `const fs0=require('node:fs'),path0=require('node:path'),a0=process.argv.slice(2);
    const id0=a0[a0.indexOf('--session-id')+1],dir0=a0[a0.indexOf('--session-dir')+1];
    if(!id0||!dir0)throw Error('missing frozen Pi session');
    fs0.mkdirSync(dir0,{recursive:true});const file0=path0.join(dir0,id0+'.jsonl');
    if(!fs0.existsSync(file0))fs0.writeFileSync(file0,JSON.stringify({type:'session',id:id0,cwd:process.cwd()})+'\\n');
  `;
  const agent=WINDOWS&&nativePi ? writePiPackageFixture(path.join(r,'bin'),piHeader+code+';setTimeout(()=>process.exit(124),180000).unref();') : fixture(r,code,opts.agent);const releaseFile=path.join(r,'fixture-release');vi.stubEnv('TUT_FIXTURE_RELEASE',releaseFile);
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
  const agentRoute = opts.args ? {agent,args:opts.args} : agent;
  const task=await hubCreate(server.url,{title:'headless fixture',description:opts.description??'isolated protocol fixture',flow:opts.flow??'direct',creator:'test',role:'human',cast:{executor:agentRoute,reviewer:agentRoute}});
  const tick=()=>notifier.requestCompare();
  const metas=()=>runtime.runs().filter(m=>m.task_id===task.task_id).map(snapshot=>{
    let m=snapshot;
    if(WINDOWS&&!complete(m)) {
      if(m.windows?.error) throw new Error(`native fixture ${m.run_id}: ${m.windows.error}`);
      if(probe(m.supervisor_pid)===false) {
        // Completion can commit while the native liveness probe is running.
        // Match the run/cooperative fixtures: reject only a fresh incomplete snapshot.
        m=runtime.store.read(m.run_id);
        if(!complete(m)) throw new Error(`native fixture ${m.run_id}: ${m.windows?.error??'supervisor gone before committed completion'}`);
      }
    }
    return m;
  });
  const collect=()=>{for(const m of metas())if(!runs.some(v=>v.id===m.run_id))runs.push({store:runtime.store,id:m.run_id});};
  const note=async(role='human',payload:Record<string,unknown>={})=>hubPublish(server.url,{task_id:task.task_id,role,content_type:'note',payload:{summary:'fixture instruction',body:'isolated test instruction',...payload}});
  return {r,agent,server,runtime,notifier,messages,logs,forbidden,task,tick,metas,collect,note,release:()=>writeFileSync(releaseFile,'')};
}

describe('headless real Hub, marker, supervisor and process protocol',()=>{
  it.skipIf(WINDOWS)('captures OpenCode fresh JSONL, resumes its exact session and publishes both rounds through Hub',async()=>{
    const h=await realHarness(String.raw`
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      const args=process.argv.slice(2),sep=args.indexOf('--');
      if(args[0]!=='run'||!args.includes('--auto')||args[args.indexOf('--format')+1]!=='json'||sep!==args.length-2)throw Error('invalid native invocation');
      const selected=args.indexOf('--session'),id=selected<0?'ses_'+crypto.randomUUID().replaceAll('-',''):args[selected+1];
      const file=path.join(process.cwd(),id+'.memory');
      const memory=selected<0?crypto.randomUUID():fs.readFileSync(file,'utf8');
      if(selected<0)fs.writeFileSync(file,memory);
      const frame=JSON.stringify({type:'step_start',timestamp:Date.now(),sessionID:id})+'\n';
      process.stdout.write(frame.slice(0,20));
      setTimeout(async()=>{
        process.stdout.write(frame.slice(20));
        console.log(JSON.stringify({type:'text',timestamp:Date.now(),sessionID:id,part:{text:memory}}));
        const {hubPublish}=await import(${JSON.stringify(path.resolve('dist/hub/hub-client.js'))});
        await hubPublish(process.env.TUT_HUB_URL,{task_id:process.env.TUT_FIXTURE_TASK,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture protocol evidence'}});
      },30);
    `,'detached',{},false,{flow:'solo',agent:'opencode',args:['--model','fixture/model','--auto']});
    vi.stubEnv('TUT_FIXTURE_TASK',h.task.task_id);
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);
    const first=h.metas()[0]!;
    expect(first.exit_code).toBe(0);expect(first.agent_session_id).toMatch(/^ses_[a-z0-9]+$/);
    expect(first.argv).not.toContain('--session');expect(first.headless!.designated_session_id).toBeUndefined();
    const firstRecords=await hubRead(h.server.url,h.task.task_id);
    expect(firstRecords.status).toBe('pending_approval');
    expect(firstRecords.versions.some(r=>r.content_type==='code_changes')).toBe(true);
    await h.tick(); // Observe the approval boundary before the next executor round.
    // A real human reject is the solo workflow's second executor round.
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'human',content_type:'decision',payload:{decision:'reject',summary:'fixture revision',body:'repeat the isolated fixture round'}});
    await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));
    const second=h.metas()[1]!;
    expect(second.exit_code).toBe(0);expect(second.agent_session_id).toBe(first.agent_session_id);
    expect(second.argv).toContain('--session');expect(second.argv).toContain(first.agent_session_id);
    expect(second.headless).toMatchObject({resume_from_run_id:first.run_id,session_reason:'resume: exact native role session'});
    const text=(m:RunMeta)=>log(h.runtime.store,m.run_id).split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(e=>e.type==='text').part.text;
    expect(text(second)).toBe(text(first));
    const final=await hubRead(h.server.url,h.task.task_id);
    expect(final.status).toBe('pending_approval');expect(final.versions.filter(r=>r.content_type==='code_changes')).toHaveLength(2);
    expect(h.forbidden).not.toHaveBeenCalled();
  },10000);

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
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('coalesces multiple human notes while old run is active and waits for full group completion',async()=>{
    const h=await realHarness(HELD_AGENT);
    await h.tick();await until(()=>h.metas().length===1);h.collect();await h.note();await h.note();await h.tick();expect(h.metas()).toHaveLength(1);expect(h.runtime.busy(h.task.task_id)).toBe(true);h.release();
    await until(()=>!!h.metas()[0]!.ended_at);await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));await h.tick();expect(h.metas()).toHaveLength(2);expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('does not wake on worker notes, ack, launch markers, manual mode or config switch alone',async()=>{
    const h=await realHarness(`process.exit(0)`);await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();
    await h.note('executor');await h.tick();await h.note('human',{ack:true});await h.tick();expect(h.metas()).toHaveLength(1);
    config(h.r,{flow_mode:'manual',auto:{launch_roles:['executor']},launch_mode:'tui'});await h.note();await h.tick();config(h.r,{flow_mode:'auto',auto:{launch_roles:['executor']},launch_mode:'headless'});await h.tick();expect(h.metas()).toHaveLength(1);
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('notifier close leaves a detached run alive; cold baseline observes without replay',async()=>{
    const h=await realHarness(HELD_AGENT);await h.tick();await until(()=>h.metas().length===1);h.collect();await h.notifier.close();expect(probe(h.metas()[0]!.pid)).toBe(true);
    const coldMessages:unknown[]=[];const restored=new HeadlessRuntime(h.r,{start:builtControl.startRun,send:async msg=>{coldMessages.push(msg);},log:()=>{},read:async()=>[]});restored.restore();expect(restored.busy(h.task.task_id)).toBe(true);h.release();await until(()=>!!h.metas()[0]!.ended_at);await restored.observe();expect(restored.busy(h.task.task_id)).toBe(false);
    const cold=new HeadlessRuntime(h.r,{send:async msg=>{coldMessages.push(msg);},log:()=>{},read:async()=>[]});cold.restore();await cold.observe();expect(cold.busy(h.task.task_id)).toBe(false);
  },WINDOWS?nativeFixtureTimeoutMs:5000);
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
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('reports immediate nonzero exit once; exit zero is a missing-publish diagnostic',async()=>{
    for(const exit of [7,0]) {
      const h=await realHarness(`process.exit(${exit});`);await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();await h.tick();
      expect(h.messages.filter(m=>m.title.includes('give-up'))).toHaveLength(exit?1:0);expect(exit?h.messages.some(m=>m.body.includes('exit_code=7')):h.logs.some(l=>l.includes('stopped-without-publish'))).toBe(true);
    }
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('observes root nonzero before lingering group exits; close uses cooperative stop and no pane cleanup',async()=>{
    const h=await realHarness(`const {spawn}=require('child_process');spawn(process.execPath,['-e',"console.log('child ready');setTimeout(()=>process.exit(124),120000)"],{detached:process.platform==='win32',stdio:'inherit'}).unref();process.exit(9);`,'headless',{},WINDOWS);
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.root_exited_at);await h.tick();
    expect(h.metas()[0]!.ended_at).toBeUndefined();if(WINDOWS)expect(h.metas()[0]!.windows!.observation).toMatchObject({root_exited:true,job_empty:false});expect(h.runtime.busy(h.task.task_id)).toBe(true);expect(h.messages.filter(m=>m.body.includes('exit_code=9'))).toHaveLength(1);
    await h.note();await h.tick();expect(h.metas()).toHaveLength(1);
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'human',content_type:'decision',payload:{summary:'close fixture',body:'isolated test close',decision:'close'}});await h.tick();
    await until(()=>!!h.metas()[0]!.ended_at,WINDOWS?90_000:7000);expect(h.metas()[0]!.stop_request?.result).toMatchObject({success:true,scope:WINDOWS?'root-and-owned-job':'root-and-original-group',descendants_check:WINDOWS?'job-members-only':'not-performed'});await h.tick();expect(h.metas()).toHaveLength(1);expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:10000);
  it('explicit stop cancels pending human wake and is not an unexpected failure',async()=>{
    const h=await realHarness(`console.log('ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>log(h.runtime.store,h.metas()[0]!.run_id).includes('ready'));
    await h.note();await h.tick();await builtControl.stopRun(h.runtime.store,h.metas()[0]!.run_id);await h.tick();await h.tick();expect(h.metas()).toHaveLength(1);expect(h.messages.filter(m=>m.title.includes('give-up'))).toHaveLength(0);
  },WINDOWS?nativeFixtureTimeoutMs:5000);
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
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('does not revive an unseen instruction issued before stop; a later new instruction works',async()=>{
    const h=await realHarness(`console.log('ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);
    await h.tick();await until(()=>h.metas().length===1);h.collect();const first=h.metas()[0]!;
    await until(()=>log(h.runtime.store,first.run_id).includes('ready'));
    await h.note();await delay(10); // Deliberately do not poll this old note.
    expect((await builtControl.stopRun(h.runtime.store,first.run_id)).success).toBe(true);
    await h.tick();await h.tick();expect(h.metas()).toHaveLength(1);
    await h.note();await h.tick();await until(()=>h.metas().length===2);h.collect();
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('invalid mode refuses without marker; later human edge reads fixed mode fresh',async()=>{
    const h=await realHarness('',null);await h.tick();expect((await hubRead(h.server.url,h.task.task_id)).versions).toHaveLength(0);expect(h.messages.some(m=>m.body.includes('invalid launch_mode'))).toBe(true);
    config(h.r,{flow_mode:'auto',auto:{launch_roles:['executor']},launch_mode:'headless'});await h.note();await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:5000);
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
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('missing launch_mode and missing anchor reports failure without falling back to headless',async()=>{
    const h=await realHarness('','missing',{listAnchorPanes:async()=>[]});
    await h.tick();
    expect(h.metas()).toHaveLength(0);
    expect((await hubRead(h.server.url,h.task.task_id)).versions).toHaveLength(0);
    expect(h.messages.some(m=>m.title.includes('auto launch failed') && m.body.includes('anchor'))).toBe(true);
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it.each(['detached', 'headless'])('%s selects detached at both doors',async mode=>{
    const h=await realHarness('',mode);expect(await headlessLaunchSelected(h.r)).toBe(true);
    await h.tick();await until(()=>h.metas().length===1);h.collect();
    expect(h.forbidden).not.toHaveBeenCalled();
    await until(()=>!!h.metas()[0]!.ended_at);
  },WINDOWS?nativeFixtureTimeoutMs:5000);
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
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('does not launch a new role while the preceding role run remains alive',async()=>{
    const h=await realHarness(HELD_AGENT);await h.tick();await until(()=>h.metas().length===1);h.collect();
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});await h.tick();expect(h.metas()).toHaveLength(1);h.release();
    await until(()=>!!h.metas()[0]!.ended_at);await h.tick();await until(()=>h.metas().length===2);h.collect();expect(h.metas()[1]!.headless!.role).toBe('reviewer');expect(h.metas()[1]!.headless!.resume_from_run_id).toBeUndefined();await until(()=>h.metas().every(m=>!!m.ended_at));
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('re-reads a marker conflict once and skips the covered generation without spawn',async()=>{
    const h=await realHarness('');const original=h.runtime.mark.bind(h.runtime);const mark=vi.spyOn(h.runtime,'mark').mockImplementation(async p=>{await original(p);await original(p);});
    await h.tick();expect(mark).toHaveBeenCalledTimes(1);expect(h.metas()).toHaveLength(0);expect(h.logs.some(l=>l.includes('already launched'))).toBe(true);
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('retains a failed note-read interval and launches once after read recovery',async()=>{
    let fail=false;let url='';const read=vi.fn(async(id:string)=>{if(fail)throw new Error('read failed');return (await hubRead(url,id)).versions;});
    const h=await realHarness('process.exit(0)','headless',{readLog:read});url=h.server.url;
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();await h.note();fail=true;await h.tick();expect(h.metas()).toHaveLength(1);fail=false;await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));await h.tick();expect(h.metas()).toHaveLength(2);
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it('cold restart blocks an unresolved startup intent and does not retry a known spawn failure',async()=>{
    const r=root(),store=new RunStore(r);const intent={task_id:'t',cwd:r,headless:{schema:1 as const,role:'executor',attempt_id:'12345678-1234-1234-1234-123456789abc',base_version:0,trigger_version:0,route:{agent:'codex',args:[]},route_source:'task-cast',session_reason:'fresh'}};
    const pending=store.create();await store.writeStartIntent(pending,{...intent,startup:'pending'});
    const messages:unknown[]=[],logs:string[]=[];const runtime=new HeadlessRuntime(r,{send:async m=>{messages.push(m);},log:l=>logs.push(l),read:async()=>[]});runtime.restore();expect(runtime.busy('t')).toBe(true);await runtime.observe();await runtime.observe();expect(messages).toEqual([]);expect(logs.filter(l=>l.includes('reason=run-unconfirmed'))).toHaveLength(1);
    const r2=root(),s2=new RunStore(r2),failed=s2.create();await s2.writeStartIntent(failed,{...intent,cwd:r2,startup:'failed'});const cold=new HeadlessRuntime(r2,{send:async()=>{},log:()=>{},read:async()=>[]});cold.restore();expect(cold.busy('t')).toBe(false);
  },WINDOWS?nativeFixtureTimeoutMs:5000);
  it.each([{flow_mode:'manual',auto:{launch_roles:['executor']}},{flow_mode:'auto',auto:{launch_roles:[]}}])('keeps manual/whitelist gates before marker for %j',async cfg=>{
    const h=await realHarness('');config(h.r,cfg);await h.tick();expect(h.metas()).toHaveLength(0);expect((await hubRead(h.server.url,h.task.task_id)).versions).toHaveLength(0);expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:5000);
});


describe('catch-up edge recovery on the detached lane',()=>{
  it('scopes startup and resume reservations while retaining unknown-archive recovery protection',async()=>{
    const h=await realHarness(HELD_AGENT,'detached');
    await h.tick();await until(()=>h.metas().length===1);h.collect();
    await until(()=>log(h.runtime.store,h.metas()[0]!.run_id).includes('ready'));
    await h.note('executor');h.release();await until(()=>h.metas().every(m=>!!m.ended_at));
    const records=(await hubRead(h.server.url,h.task.task_id)).versions;
    const meta=h.metas()[0]!,store=h.runtime.store;
    const fresh=()=>launchBlocked(records,'executor',undefined,'direct',h.runtime.recoverableLaunches(h.task.task_id,records)).blocked===false;
    const ownership=()=>({...meta.headless!,attempt_id:randomUUID(),base_version:0,trigger_version:0});
    const foreign=store.create();
    await store.writeStartIntent(foreign,{task_id:'unrelated-task',headless:ownership(),cwd:h.r,startup:'pending'});
    expect(fresh()).toBe(true);
    const related=store.create();
    const relatedIntent={task_id:h.task.task_id,headless:ownership(),cwd:h.r,startup:'pending' as const};
    await store.writeStartIntent(related,relatedIntent);
    expect(fresh()).toBe(false);
    await store.writeStartIntent(related,{...relatedIntent,startup:'failed'});
    expect(fresh()).toBe(true);
    const resume=store.create();
    const resumeIntent={schema:1 as const,from_run_id:meta.run_id,agent:'codex',session_id:'fixture-session',cwd:h.r,startup:'pending' as const};
    await store.writeResumeIntent(resume,resumeIntent);
    expect(fresh()).toBe(false);
    await store.writeResumeIntent(resume,{...resumeIntent,startup:'failed'});
    expect(fresh()).toBe(true);
    const foreignSource=await builtControl.startRun(store,[process.execPath,'-e','process.exit(0)'],h.r,'unrelated-task');
    runs.push({store,id:foreignSource});await until(()=>complete(store.read(foreignSource)));
    const foreignResume=store.create();
    await store.writeResumeIntent(foreignResume,{...resumeIntent,from_run_id:foreignSource});
    expect(fresh()).toBe(true);
    const unknownSource=store.create(),unknownResume=store.create();
    await store.writeStartIntent(unknownSource,{...relatedIntent,startup:'failed'});
    await store.writeResumeIntent(unknownResume,{...resumeIntent,from_run_id:unknownSource});
    expect(fresh()).toBe(false);
    await store.writeResumeIntent(unknownResume,{...resumeIntent,from_run_id:unknownSource,startup:'failed'});
    expect(fresh()).toBe(true);
    const unknown=store.create();
    expect(fresh()).toBe(false);
    expect(store.list()).toContain(unknown);
    expect(store.readStartIntent(related).startup).toBe('failed');
    expect(store.readResumeIntent(resume).startup).toBe('failed');
  },WINDOWS?nativeFixtureTimeoutMs:15000);

  it.each(['full','direct'] as const)('%s reviewer recovers once alongside a confirmed failed startup archive',async flow=>{
    const h=await realHarness(HELD_AGENT,'detached',{},false,{flow});
    if(flow==='full') await hubPublish(h.server.url,{task_id:h.task.task_id,role:'architect',content_type:'design',payload:{summary:'fixture design',body:'fixture design'}});
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});
    await h.tick();await until(()=>h.metas().length===1);h.collect();
    await until(()=>log(h.runtime.store,h.metas()[0]!.run_id).includes('ready'));
    await h.note('reviewer');h.release();await until(()=>h.metas().every(m=>!!m.ended_at));
    const records=(await hubRead(h.server.url,h.task.task_id)).versions;
    const before=launchBlocked(records,'reviewer',undefined,flow,h.runtime.recoverableLaunches(h.task.task_id,records));
    expect(before.blocked).toBe(false);
    const owned=h.metas()[0]!.headless!;
    let failedId:string|undefined;
    try {
      await builtControl.startRun(h.runtime.store,[path.join(h.r,'missing-executable')],h.r,'unrelated-failed-task',{
        headless:{...owned,attempt_id:randomUUID(),base_version:0,trigger_version:0},
      });
      throw new Error('missing executable unexpectedly started');
    } catch(error) {
      expect(error).toMatchObject({uncertain:false});
      failedId=(error as {runId:string}).runId;
    }
    const failed=h.runtime.store.readStartIntent(failedId!);
    expect(failed).toMatchObject({task_id:'unrelated-failed-task',startup:'failed'});
    expect(launchBlocked(records,'reviewer',undefined,flow,h.runtime.recoverableLaunches(h.task.task_id,records))).toEqual(before);
    for(let i=0;i<4&&h.metas().length<2;i++) await h.tick();
    await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));
    expect(h.metas()[1]!.headless!.role).toBe('reviewer');
    await h.tick();await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(2);
    const final=(await hubRead(h.server.url,h.task.task_id)).versions;
    expect(final.filter(r=>r.payload.launch)).toHaveLength(2);
    expect(h.runtime.store.readStartIntent(failedId!)).toEqual(failed);
    expect(h.runtime.store.list()).toContain(failedId);
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:15000);

  it('withholds notes-only recovery on uncertain, failed, stopped, delivered or mismatched evidence',async()=>{
    const h=await realHarness(HELD_AGENT,'detached');
    await h.tick();await until(()=>h.metas().length===1);h.collect();
    await until(()=>log(h.runtime.store,h.metas()[0]!.run_id).includes('ready'));
    await h.note('executor');h.release();await until(()=>h.metas().every(m=>!!m.ended_at));
    const records=(await hubRead(h.server.url,h.task.task_id)).versions;
    const meta=h.metas()[0]!;
    const inventory=vi.spyOn(h.runtime.store,'readManyMetas');
    const evidence=(m:RunMeta)=>inventory.mockReturnValue([{kind:'meta',id:m.run_id,meta:m}]);
    try {
      evidence(meta);
      expect([...h.runtime.recoverableLaunches(h.task.task_id,records)]).toEqual([1]);
      for(const changed of [
        {...meta,ended_at:undefined}, {...meta,exit_code:1}, {...meta,exit_signal:'SIGTERM'},
        {...meta,stop_request:{}}, {...meta,input_delivery:{status:'pending'}},
        {...meta,task_id:'another-task'}, {...meta,headless:{...meta.headless,role:'reviewer'}},
        {...meta,headless:{...meta.headless,base_version:99}},
        {...meta,headless:{...meta.headless,attempt_id:'other-attempt'}},
      ] as RunMeta[]) {
        evidence(changed);
        expect([...h.runtime.recoverableLaunches(h.task.task_id,records)]).toEqual([]);
      }
      inventory.mockReturnValue([{kind:'error',id:meta.run_id,error:new Error('unreadable metadata'),origin:'file'}]);
      expect([...h.runtime.recoverableLaunches(h.task.task_id,records)]).toEqual([]);
      inventory.mockReturnValue([{kind:'meta',id:meta.run_id,meta},{kind:'meta',id:'duplicate',meta:{...meta,run_id:'duplicate'}}]);
      expect([...h.runtime.recoverableLaunches(h.task.task_id,records)]).toEqual([]);
      evidence(meta);
      const delivery={...record(records.length+1,'code_changes','executor'),task_id:h.task.task_id};
      expect([...h.runtime.recoverableLaunches(h.task.task_id,[...records,delivery])]).toEqual([]);
      for(const patch of [{ack:true},{launch:{}},{summary:'other role'}]) {
        const changed=records.map(r=>r.role==='executor'?{...r,...(patch.summary?{role:'reviewer'}:{}),payload:{...r.payload,...patch}}:r);
        expect([...h.runtime.recoverableLaunches(h.task.task_id,changed)]).toEqual([]);
      }
      const late=records.map(r=>r.role==='executor'?{...r,timestamp:new Date(Date.parse(meta.ended_at!)+1000).toISOString()}:r);
      expect([...h.runtime.recoverableLaunches(h.task.task_id,late)]).toEqual([]);
    } finally { inventory.mockRestore(); }
  },WINDOWS?nativeFixtureTimeoutMs:15000);

  it.each(['executor','reviewer'])('recovers an exited %s marker after notes-only progress without a new instruction',async role=>{
    const h=await realHarness(HELD_AGENT,'detached');
    if(role==='reviewer') await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});
    await h.tick();await until(()=>h.metas().length===1);h.collect();
    await until(()=>log(h.runtime.store,h.metas()[0]!.run_id).includes('ready'));
    await h.note(role);
    await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(1); // A progress note cannot duplicate a live run.
    const secondRelease=path.join(h.r,'recovery-release');
    vi.stubEnv('TUT_FIXTURE_RELEASE',secondRelease);
    h.release();await until(()=>h.metas().every(m=>!!m.ended_at));
    const before=(await hubRead(h.server.url,h.task.task_id)).versions;
    const originalMarker=before.find(r=>r.payload.launch)!;
    expect(launchBlocked(before,role,undefined,'direct',h.runtime.recoverableLaunches(h.task.task_id,before)))
      .toEqual({blocked:false,recoveryVersion:originalMarker.version});
    for(let i=0;i<4&&h.metas().length<2;i++) await h.tick();
    await until(()=>h.metas().length===2);h.collect();
    await until(()=>log(h.runtime.store,h.metas()[1]!.run_id).includes('ready'));
    await h.note(role); // Even another notes-only yield cannot retry the recovery itself.
    writeFileSync(secondRelease,'');
    await until(()=>h.metas().every(m=>!!m.ended_at));
    expect(h.metas()[1]!.headless!.role).toBe(role);
    const records=(await hubRead(h.server.url,h.task.task_id)).versions;
    expect(records.filter(r=>(r.payload.launch as {role?:string}|undefined)?.role===role)).toHaveLength(2);
    expect(records.filter(r=>r.payload.launch).at(-1)!.payload.launch).toMatchObject({recovery_of_version:originalMarker.version});
    const cold=new HeadlessRuntime(h.r,{read:async()=>records,log:()=>{},send:async()=>{}});
    expect(launchBlocked(records,role,undefined,'direct',cold.recoverableLaunches(h.task.task_id,records)).blocked).toBe(true);
    // A second successful exit without delivery must not cause a restart loop.
    await h.note(role);await h.tick();await h.tick();await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(2);
    await h.note();await h.tick(); // A new human instruction re-arms the turn normally.
    await until(()=>h.metas().length===3);h.collect();
    await until(()=>h.metas().every(m=>!!m.ended_at));
    const rearmed=(await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch).at(-1)!;
    expect((rearmed.payload.launch as {recovery_of_version?:number}).recovery_of_version).toBeUndefined();
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:15000);

  it.each([
    ['full', false], ['direct', false], ['full', true], ['direct', true],
  ] as const)('%s reviewer relaunches after approval/reject cycles (merged polls=%s), including an exited run without delivery',async(flow,merged)=>{
    const h=await realHarness('process.exit(0)','detached',{},false,{flow});
    const publish=async(role:string,content_type:string,payload:Record<string,unknown>={})=>hubPublish(h.server.url,{
      task_id:h.task.task_id,role,content_type,payload:{summary:'fixture round',body:'fixture round',...payload},
    });
    if(flow==='full') await publish('architect','design');
    await publish('executor','code_changes');
    await h.tick();
    await until(()=>h.metas().length===1);h.collect();
    await until(()=>h.metas().every(m=>!!m.ended_at));
    await h.tick();
    // Exiting without a delivery does not itself authorize an automatic retry.
    await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(1);
    for(let cycle=0;cycle<2;cycle++) {
      const review=await publish('reviewer','review',{
        verdict:'pass',body:'## 退出条件逐条核验\n1. 满足 — fixture protocol completed\n## 超出规格的改动\n无',
      });
      expect(review).toMatchObject({status:'pending_approval',needs_attention:false});
      if(!merged) await h.tick();
      const rejected=await publish('human','decision',{decision:'reject'});
      expect(rejected).toMatchObject({status:'revising',needs_attention:false});
      if(!merged) {
        await h.tick();
        await until(()=>h.metas().length===cycle*2+2);h.collect();
        await until(()=>h.metas().every(m=>!!m.ended_at));
        await h.tick();
        expect(h.metas().at(-1)!.headless!.role).toBe('executor');
      }
      const revised=await publish('executor','revision',{ref_version:rejected.version});
      expect(revised).toMatchObject({status:'reviewing',needs_attention:false});
      await h.tick();
      if(merged) await h.tick(); // Same waiting_for endpoint: the second quiet poll catches up.
      const count=merged?cycle+2:cycle*2+3;
      await until(()=>h.metas().length===count);h.collect();
      await until(()=>h.metas().every(m=>!!m.ended_at));
      expect(h.metas().at(-1)).toMatchObject({status:'exited',headless:{role:'reviewer'}});
      await h.tick();await h.tick();await h.tick();
      expect(h.metas()).toHaveLength(count);
    }
    const records=(await hubRead(h.server.url,h.task.task_id)).versions;
    expect(records.filter(r=>(r.payload.launch as {role?:string}|undefined)?.role==='reviewer')).toHaveLength(3);
    expect(records.filter(r=>r.content_type==='review')).toHaveLength(2);
    expect(headlessGeneration(records,'reviewer',0,flow).blocked).toBe(true);
    if(merged) expect(h.logs.filter(l=>l.includes('action=launch (catch-up)'))).toHaveLength(2);
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:20000);

  it('a swallowed note-edge spawn on the revision round recovers through the catch-up net',async()=>{
    const h=await realHarness('process.exit(0)');
    // Round 0: executor launches, delivers nothing; the marker at v1 stays valid.
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();
    // Executor delivery → reviewing; the reviewer round launches and completes.
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});
    await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));await h.tick();
    // A worker note flips reviewing → revising in ONE poll (the same shape as
    // the 2026-10-26 supportedFixes flip). Its note-edge wake is vetoed on
    // the detached lane (only a human instruction advances a generation) —
    // the spawn is swallowed SILENTLY: announcement said launch, no marker,
    // no failure notice.
    await h.note('executor');await h.tick();
    expect(h.metas()).toHaveLength(2);
    // Quiet polls: gate/whitelist/round-scoped dedup all green, zero marker,
    // zero action → the second consecutive quiet poll launches the round.
    await h.tick();await h.tick();
    await until(()=>h.metas().length===3);h.collect();
    const markers=(await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch);
    expect(markers).toHaveLength(3);
    expect(h.metas()[2]!.headless).toMatchObject({role:'executor'});
    expect(h.logs.some(l=>l.includes('action=launch (catch-up)'))).toBe(true);
    await until(()=>h.metas().every(m=>!!m.ended_at));
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:20000);
  it('a solo round keeps its marker through a plain worker note: the dedup boundary follows the real flow and the net stays silent',async()=>{
    const h=await realHarness('process.exit(0)','headless',{},false,{flow:'solo'});
    // Round 0: executor launches (marker v1), completes, delivers → pending_approval.
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});
    await h.tick(); // solo: human-waiting — nothing may launch
    expect(h.metas()).toHaveLength(1);
    // Human reject → implementing (solo rework): the rework round launches (marker v4) and completes.
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'human',content_type:'decision',payload:{summary:'rework',body:'rework',decision:'reject'}});
    await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>!!h.metas()[1]!.ended_at);await h.tick();
    expect(h.metas()[1]!.headless).toMatchObject({role:'executor'});
    // A PLAIN executor progress note: solo derives no flip from it — the
    // rework-round marker stays valid, the swallowed note-edge wake is not
    // rescued into a duplicate launch.
    await h.note('executor');
    await h.tick(); // the note-edge wake is vetoed on the detached lane (worker note) — swallowed
    await h.tick();await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(2);
    const markers=(await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch);
    expect(markers).toHaveLength(2);
    const line=h.logs.filter(l=>l.includes('auto-decision')).at(-1);
    expect(line).toContain('dedup=launched@v4');
    expect(h.logs.some(l=>l.includes('action=launch (catch-up)'))).toBe(false);
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:20000);
  it('a stop cancels the coalesced next-role candidate: the catch-up net withholds it; a new instruction or round launches exactly once',async()=>{
    const h=await realHarness(`console.log('ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);
    // Round 0: executor run alive, marker at v1.
    await h.tick();await until(()=>h.metas().length===1);h.collect();
    await until(()=>log(h.runtime.store,h.metas()[0]!.run_id).includes('ready'));
    // Executor delivery → reviewing: the reviewer candidate coalesces behind the live run.
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});
    await h.tick();
    expect(h.metas()).toHaveLength(1);
    expect(h.logs.some(l=>l.includes('candidate coalesced'))).toBe(true);
    // Stop the executor run: the parked reviewer candidate is cancelled.
    expect((await builtControl.stopRun(h.runtime.store,h.metas()[0]!.run_id)).success).toBe(true);
    await until(()=>!!h.metas()[0]!.ended_at);
    await h.tick(); // the stop is observed: boundary set; quiet poll 1
    // Three more quiet polls: the net must NOT revive the cancelled candidate.
    await h.tick();await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(1);
    expect((await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch)).toHaveLength(1);
    expect(h.logs.some(l=>l.includes('catch-up withheld: an observed stop cancelled this round\'s launch'))).toBe(true);
    // A plain worker note neither flips a round nor re-arms the cancelled candidate.
    await h.note('reviewer');await h.tick();await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(1);
    expect((await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch)).toHaveLength(1);
    // A NEW human instruction after the stop re-arms acting: the reviewer launches exactly once.
    await h.note();await h.tick();await until(()=>h.metas().length===2,WINDOWS?90_000:15_000);h.collect();
    expect(h.metas()[1]!.headless).toMatchObject({role:'reviewer'});
    await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(2);
    expect((await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch)).toHaveLength(2);
    // Wind the fixture down deterministically (the reviewer run stays alive by design).
    expect((await builtControl.stopRun(h.runtime.store,h.metas()[1]!.run_id)).success).toBe(true);
    await until(()=>h.metas().every(m=>!!m.ended_at),WINDOWS?90_000:15_000);
    // A NEW legitimate round after the stop launches exactly once through the
    // ordinary waiting_for edge (untouched by the stop-cancellation gate).
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'reviewer',content_type:'review',payload:{summary:'fixture revision request',body:'fixture revision request',verdict:'fail_code'}});
    await h.tick();await until(()=>h.metas().length===3,WINDOWS?90_000:15_000);h.collect();
    expect(h.metas()[2]!.headless).toMatchObject({role:'executor'});
    await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(3);
    expect((await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch)).toHaveLength(3);
    expect((await builtControl.stopRun(h.runtime.store,h.metas()[2]!.run_id)).success).toBe(true);
    await until(()=>h.metas().every(m=>!!m.ended_at),WINDOWS?90_000:15_000);
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:20000);
  it('a post-stop new round merged into one poll recovers through the catch-up net without any new instruction',async()=>{
    const h=await realHarness(`console.log('ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);
    // Round 0: executor run alive, marker at v1; stopped mid-round.
    await h.tick();await until(()=>h.metas().length===1);h.collect();
    await until(()=>log(h.runtime.store,h.metas()[0]!.run_id).includes('ready'));
    expect((await builtControl.stopRun(h.runtime.store,h.metas()[0]!.run_id)).success).toBe(true);
    await until(()=>!!h.metas()[0]!.ended_at);
    // A genuinely NEW round lands before any poll sees the stop: delivery +
    // fail_code review coalesce into one poll (the waiting_for endpoint is
    // unchanged end-to-end, so no observable edge exists) — the revision
    // round can only recover through the catch-up net, and the old stop must
    // not starve it: the cancelled candidate belonged to a round whose flip
    // predates the stop; this round's flip postdates it.
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'reviewer',content_type:'review',payload:{summary:'fixture revision request',body:'fixture revision request',verdict:'fail_code'}});
    await h.tick(); // stop observed AND the new round first seen in the same poll: quiet poll 1
    await h.tick(); // quiet poll 2 → the catch-up fires for the NEW round
    await until(()=>h.metas().length===2,WINDOWS?90_000:15_000);h.collect();
    expect(h.metas()[1]!.headless).toMatchObject({role:'executor'});
    expect(h.logs.some(l=>l.includes('action=launch (catch-up)'))).toBe(true);
    expect(h.logs.some(l=>l.includes('catch-up withheld'))).toBe(false);
    expect((await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch)).toHaveLength(2);
    await h.tick();await h.tick(); // exactly once — no repeat
    expect(h.metas()).toHaveLength(2);
    expect((await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch)).toHaveLength(2);
    expect((await builtControl.stopRun(h.runtime.store,h.metas()[1]!.run_id)).success).toBe(true);
    await until(()=>h.metas().every(m=>!!m.ended_at),WINDOWS?90_000:15_000);
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:20000);
  it("a solo marker conflict converges on skipped: the re-read follows the task's real flow",async()=>{
    const h=await realHarness('process.exit(0)','headless',{},false,{flow:'solo'});
    // The original discriminating solo sequence: a reference design record
    // first (an in-table no-transition reference in solo's implementing),
    // then the round-0 marker. Under the full default table that same design
    // record flips designing→implementing — without it the full replay never
    // leaves designing and the discrimination below collapses.
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'architect',content_type:'design',payload:{summary:'fixture reference design',body:'fixture reference design'}});
    // Round 0: executor launches (marker v2), completes, delivers → pending_approval.
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});
    await h.tick(); // solo: human-waiting — nothing launches
    expect(h.metas()).toHaveLength(1);
    // Human reject → implementing: the rework round races — a competitor
    // wins the optimistic append (v5 marker) and even appends a plain worker
    // note (v6) before our marker lands. Under the real solo table the v5
    // marker covers this round (the v6 note flips nothing); replayed under
    // the full default the v6 note reads as a reviewing→revising flip, the
    // boundary jumps past v5, and the covered conflict would be reported as
    // a launch failure instead of a skipped round.
    const original=h.runtime.mark.bind(h.runtime);
    const mark=vi.spyOn(h.runtime,'mark');
    mark.mockImplementation(async plan=>{
      if(mark.mock.calls.length===1){
        await hubPublish(h.server.url,{task_id:h.task.task_id,role:'human',content_type:'note',payload:{summary:'launch: executor (base v4)',body:'launch',launch:{role:'executor',base_version:4,via:'auto'}}});
        await h.note('executor');
      }
      return await original(plan);
    });
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'human',content_type:'decision',payload:{summary:'rework',body:'rework',decision:'reject'}});
    await h.tick(); // reject edge → launch → our marker loses the race → conflict re-read
    await h.tick();await h.tick();
    expect(h.metas()).toHaveLength(1); // no second spawn
    expect((await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch)).toHaveLength(2); // round-0 v2 + the competitor's v5 — ours never landed
    const skipped=h.messages.filter(m=>m.title.includes('auto launch skipped (already launched)'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.body).toContain('at v5');
    expect(h.messages.filter(m=>m.title.includes('auto launch failed'))).toHaveLength(0);
    expect(h.logs.some(l=>l.includes('deferred'))).toBe(false);
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:20000);
  it('a real lint-flagged review recovers through a real supportedFixes correction note and the revision round auto-launches without start-next',async()=>{
    const h=await realHarness('process.exit(0)','headless',{},false,{
      description:'## 要改变的行为\nfixture 行为\n## 验收场景\n1. 逐条退出条件由 review 判定\n2. 自动发车不依赖 start-next\n',
    });
    const state=async()=>{
      const res=await fetch(`${h.server.url}/state`);
      return ((await res.json()) as {tasks:{task_id:string;status:string;needs_attention:boolean;waiting_for:string}[]}).tasks.find(t=>t.task_id===h.task.task_id)!;
    };
    // Round 0: executor launches (marker v1), completes, delivers → reviewing; the reviewer round launches (marker v3) and completes.
    await h.tick();await until(()=>h.metas().length===1);h.collect();await until(()=>!!h.metas()[0]!.ended_at);await h.tick();
    await hubPublish(h.server.url,{task_id:h.task.task_id,role:'executor',content_type:'code_changes',payload:{summary:'fixture delivery',body:'fixture delivery'}});
    await h.tick();await until(()=>h.metas().length===2);h.collect();await until(()=>h.metas().every(m=>!!m.ended_at));await h.tick();
    // A REAL review whose body the Hub lint rejects (both machine-readable
    // review sections missing): warnings + supportedFixes, needs_attention.
    const review=await hubPublish(h.server.url,{task_id:h.task.task_id,role:'reviewer',content_type:'review',
      payload:{summary:'fail_code（正文缺机器可识别小节）',body:'## 总体评价\nfixture review without the required sections',verdict:'fail_code'}});
    expect(review.needs_attention).toBe(true);
    const codes=review.warnings?.map(w=>w.code)??[];
    expect(codes).toContain('REVIEW_EXIT_CONDITIONS_INCOMPLETE');
    expect(codes).toContain('REVIEW_SCOPE_SECTION_MISSING');
    const fix=review.warnings!.find(w=>w.code==='REVIEW_EXIT_CONDITIONS_INCOMPLETE')!.supportedFixes![0]!;
    expect(fix.record).toMatchObject({role:'reviewer',content_type:'note',ref_version:review.version});
    // REAL derivation: fail_code → revising, and the lint warning holds the
    // task for the human (needs_attention) — NOT a pending_approval transit.
    expect(await state()).toMatchObject({status:'revising',needs_attention:true,waiting_for:'human'});
    await h.tick(); // human-waiting: nothing launches
    expect(h.metas()).toHaveLength(2);
    // The REAL correction note (supportedFixes shape): same role, ref_version
    // → the linted review, valid machine-readable sections.
    const correction=await hubPublish(h.server.url,{task_id:h.task.task_id,role:'reviewer',content_type:'note',
      payload:{summary:'补齐 review 的机器可识别小节',ref_version:review.version,
        body:'## 退出条件逐条核验\n1. 满足 — fixture 证据：review 链路以真实 lint 与修正 note 闭环\n2. 满足 — fixture 证据：revision 轮由 catch-up 自动发车，无需 start-next\n## 超出规格的改动\n无'}});
    expect(correction.needs_attention).toBe(false);
    expect(await state()).toMatchObject({status:'revising',needs_attention:false,waiting_for:'agent:executor'});
    // One poll: the waiting_for edge + note edge fire, but the detached lane
    // vetoes the worker-note wake — the spawn is swallowed silently.
    await h.tick();
    expect(h.metas()).toHaveLength(2);
    expect(h.logs.some(l=>l.includes('action=launch (waiting_for edge human → agent:executor)'))).toBe(true);
    // Two quiet polls → the catch-up net launches the revision round once.
    await h.tick();await h.tick();
    await until(()=>h.metas().length===3);h.collect();
    const markers=(await hubRead(h.server.url,h.task.task_id)).versions.filter(r=>r.payload.launch);
    expect(markers).toHaveLength(3);
    expect(h.metas()[2]!.headless).toMatchObject({role:'executor'});
    expect(h.logs.some(l=>l.includes('action=launch (catch-up)'))).toBe(true);
    await until(()=>h.metas().every(m=>!!m.ended_at));
    expect(h.forbidden).not.toHaveBeenCalled();
  },WINDOWS?nativeFixtureTimeoutMs:30000);
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

// Minimal declarations are exercised through the same planner/runtime, without onboarding UI.
import {encodeContract,decodeContract,resolveContract,prepareInvocation} from '../../../src/agents/public/index.js';
import {deliverInput} from '../../../src/core/run/input.js';
import {planResume} from '../../../src/core/run/resume.js';
describe('basic shared invocation',()=>{
  function binding(executable:string,kind:'argv'|'stdin'='argv') {
    return {schema_version:1,id:'worker-x',command:{executable,argv:[{slot:'args'},...(kind==='argv'?[{slot:'prompt'}]:[])] as (string|{slot:string})[]},input:kind==='argv'?{kind}:{kind,encoding:'utf8'}};
  }
  it.each([['argv',false],['stdin',false],['argv',true],['stdin',true]] as const)('freezes the selected %s binding through planner awaits (explicit=%s); the next operation sees the update',async(kind,explicit)=>{
    const r=root(),before=path.join(r,'worker-before.exe'),after=path.join(r,'worker-after.exe');
    // Planner-only physical files: this timing test never spawns either target.
    for(const file of [before,after])writeFileSync(file,'',{mode:0o755});
    const oldBinding=binding(before,kind);oldBinding.command.argv.unshift('before value');
    const nextKind=kind==='argv'?'stdin':'argv';
    const nextBinding=binding(after,nextKind);nextBinding.command.argv.unshift('after value');
    const contextDir=path.join(r,'.context-hub');
    await writeAgentBinding(contextDir,'worker-x',parseAgentBinding(oldBinding));
    await writeConfigRole(contextDir,'executor','binding:worker-x',async()=>({roles:{}}));
    const original=checkoutProvider.resolveCheckout;
    const boundary=vi.spyOn(checkoutProvider,'resolveCheckout').mockImplementationOnce(async input=>{
      const selected=await original(input);
      // Config's real write port changes entry, fixed args and input after the
      // operation selected its workspace snapshot, before contract compilation.
      await writeAgentBinding(contextDir,'worker-x',parseAgentBinding(nextBinding));
      return selected;
    });
    try {
      const input={task:{task_id:'binding-freeze',title:'binding freeze',version:0},role:'executor',records:[],hubRoot:r,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:2',launchCheckout:'rig' as const,...(explicit?{explicitRoute:{agent:'binding:worker-x',args:[]}}:{})};
      const current=await buildHeadlessPlan(input),next=await buildHeadlessPlan(input);
      expect(current.argv).toEqual([before,'before value',...(kind==='argv'?[current.prompt]:[])]);
      expect(current.invocation!.input).toEqual(kind==='stdin'?{kind:'stdin',encoding:'utf8',text:current.prompt}:{kind:'none'});
      expect(next.argv).toEqual([after,'after value',...(nextKind==='argv'?[next.prompt]:[])]);
      expect(next.invocation!.input).toEqual(nextKind==='stdin'?{kind:'stdin',encoding:'utf8',text:next.prompt}:{kind:'none'});
      expect(current.ownership.contract).not.toEqual(next.ownership.contract);
      expect(new RunStore(r).list()).toEqual([]);
    } finally {boundary.mockRestore();}
  });
  it.skipIf(WINDOWS).each(['argv','stdin'] as const)('runs real %s input with literal arguments, checkout, Hub environment and no native continuity',async kind=>{
    const r=root(),agent=fixture(r,`
      const fs=require('node:fs');let text='';
      const finish=()=>console.log(JSON.stringify({argv:process.argv.slice(2),text,cwd:process.cwd(),pwd:process.env.PWD,hub:process.env.TUT_HUB_ROOT,url:process.env.TUT_HUB_URL}));
      ${kind==='stdin'?"process.stdin.setEncoding('utf8');process.stdin.on('data',c=>text+=c);process.stdin.on('end',finish);":"finish();"}
    `,'worker with spaces');
    const declaration=binding(agent,kind);declaration.command.argv.unshift('two words','&|🙂','');
    config(r,{flow_mode:'manual',agent_bindings:{'worker-x':declaration}});
    const task={task_id:'basic',title:'basic',version:0,cast:{executor:{agent:'binding:worker-x',args:['--flag','value']}}};
    const inherited={...process.env,PWD:'/foreign',TUT_HUB_ROOT:'/foreign'};
    const input={task,role:'executor',records:[],hubRoot:r,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:2',env:inherited,launchCheckout:'rig' as const};
    const plan=await buildHeadlessPlan(input),store=new RunStore(r);
    expect(plan.profile!.capabilities).toEqual({invoke:true,resume:false,observe:false,usage:false});
    expect(decodeContract(encodeContract(plan.profile!)).key).toEqual(plan.profile!.key);
    expect(inherited.PWD).toBe('/foreign');expect(inherited.TUT_HUB_ROOT).toBe('/foreign');
    const runtime=new HeadlessRuntime(r,{start:builtControl.startRun,stop:builtControl.stopRun,send:async()=>{},log:()=>{},read:async()=>[]});
    const launched=await runtime.launchAndSettle(plan);expect(launched.kind).toBe('launched');if(launched.kind!=='launched')return;
    runs.push({store,id:launched.run_id});await until(()=>complete(store.read(launched.run_id)));
    const meta=store.read(launched.run_id),output=JSON.parse(log(store,launched.run_id).trim());
    expect(output).toMatchObject({cwd:r,pwd:r,hub:r,url:input.hubUrl,text:kind==='stdin'?plan.prompt:''});
    expect(output.argv).toEqual(['two words','&|🙂','',...task.cast.executor.args,...(kind==='argv'?[plan.prompt]:[])]);
    if(kind==='stdin')expect(meta.input_delivery).toEqual({status:'complete',bytes:Buffer.byteLength(plan.prompt)});
    expect(meta.agent_session_id).toBeUndefined();
    const next=await buildHeadlessPlan({...input,runs:[meta]});
    expect(next.ownership.resume_from_run_id).toBeUndefined();expect(next.ownership.designated_session_id).toBeUndefined();
    expect(next.ownership.session_reason).toContain('not configured');
    const before=store.list();await expect(planResume(store,meta.run_id,{instruction:'continue'})).rejects.toThrow('RESUME_UNAVAILABLE');expect(store.list()).toEqual(before);
  });
  it.each([
    {command:{executable:'/bin/unknown',argv:[{slot:'prompt'},{slot:'prompt'}]}},
    {command:{executable:'/bin/bash',argv:[{slot:'prompt'}]}},
    {command:{executable:'/usr/bin/codex',argv:[{slot:'prompt'}]}},
    {input:{kind:'stdin',encoding:'utf8'}},
  ])('rejects invalid declarations before any runtime side effect',async patch=>{
    const r=root();config(r,{flow_mode:'manual',agent_bindings:{'worker-x':{...binding('/bin/unknown'),...patch}}});
    await expect(buildHeadlessPlan({task:{task_id:'basic',title:'basic',version:0,cast:{executor:'binding:worker-x'}},role:'executor',records:[],hubRoot:r,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:2',launchCheckout:'rig'})).rejects.toThrow();
    expect(new RunStore(r).list()).toEqual([]);
  });
  it('rejects dropped args and oversized UTF-8 stdin before launch',async()=>{
    for(const kind of ['argv','stdin'] as const){
      const b=binding('/bin/worker',kind);if(kind==='argv')b.command.argv=[{slot:'prompt'}];
      const r=resolveContract({agent:'binding:worker-x'},{values:[],overridden:[],diagnostics:[],bindings:{'worker-x':b}},'posix');expect(r.status).toBe('resolved');if(r.status!=='resolved')return;
      const result=await prepareInvocation(r.handle,{mode:'run',origin:'managed',entry:'auto',route:{agent:'binding:worker-x',args:kind==='argv'?['must preserve']:[]},checkoutRoot:'/checkout',prompt:kind==='stdin'?'🙂'.repeat(20000):'prompt',environmentFacts:{home:'/home',env:{}}});
      expect(result).toMatchObject({status:'invalid'});
    }
  });
  it('records timeout, EPIPE, early exit and cancellation without resending input',async()=>{
    const cases=['timeout','EPIPE','early exit','stop'];
    for(const reason of cases){
      const sink=new Writable({write(_chunk,_encoding,callback){if(reason==='EPIPE')callback(Object.assign(Error('EPIPE'),{code:'EPIPE'}));}});
      const delivery=deliverInput(sink,'one input',10);
      if(reason==='early exit'||reason==='stop')delivery.cancel(reason);
      await until(()=>delivery.state.status==='failed');
      expect(delivery.state.error).toContain(reason==='timeout'?'timeout':reason);
    }
  });
  it.skipIf(WINDOWS)('keeps stdin runs under the existing cooperative group stop protocol',async()=>{
    const r=root(),agent=fixture(r,"process.stdin.resume();setInterval(()=>{},1000)",'worker-stop');
    config(r,{flow_mode:'manual',agent_bindings:{'worker-x':binding(agent,'stdin')}});
    const plan=await buildHeadlessPlan({task:{task_id:'basic-stop',title:'basic',version:0,cast:{executor:'binding:worker-x'}},role:'executor',records:[],hubRoot:r,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:2',launchCheckout:'rig'});
    const store=new RunStore(r),id=await builtControl.startRun(store,plan.argv,r,plan.task_id,{profile:encodeContract(plan.profile!),input:plan.invocation!.input,headless:plan.ownership,env:plan.env});runs.push({store,id});
    const result=await stopRun(store,id);expect(result.success).toBe(true);expect(complete(store.read(id))).toBe(true);expect(probe(-store.read(id).pgid)).toBe(false);
  });
});

describe('basic shell-source admission',()=>{
  it.each(['/bin/ksh','/bin/csh','/bin/tcsh','/bin/sh','/bin/bash','/bin/dash','/bin/ash','/bin/mksh','C:\\tools\\pwsh.exe','C:\\tools\\wrapper.cmd'])('refuses %s before marker or run creation',async executable=>{
    const r=root();config(r,{flow_mode:'manual',agent_bindings:{'worker-x':{schema_version:1,id:'worker-x',command:{executable,argv:['-c',{slot:'prompt'}]},input:{kind:'argv'}}}});
    const server=await startServer({root:path.join(r,'.context-hub'),port:0});servers.push(server);
    const created=await hubCreate(server.url,{title:'shell rejection',description:'isolated fixture',creator:'test',role:'human',flow:'direct',cast:{executor:'binding:worker-x'}});
    const runtime=new HeadlessRuntime(r,{start:builtControl.startRun,send:async()=>{},log:()=>{},read:async()=>[]});
    await expect((async()=>{
      const plan=await buildHeadlessPlan({task:{task_id:created.task_id,title:'shell rejection',version:0,cast:{executor:'binding:worker-x'}},role:'executor',records:[],hubRoot:r,hubUrl:server.url,eventUrl:'http://127.0.0.1:2',launchCheckout:'rig'});
      await runtime.mark(plan);await runtime.launchAndSettle(plan);
    })()).rejects.toThrow('BINDING_SHELL_UNSUPPORTED');
    expect((await hubRead(server.url,created.task_id)).versions).toEqual([]);
    expect(runtime.store.list()).toEqual([]);
  });
});

it.skipIf(WINDOWS)('revalidates automatic POSIX continuity under admission using the frozen plan and rejects changed store evidence',async()=>{
  const {piSessionDirFor}=await import('../../../src/agents/public/index.js');
  const r=root(),agent=fixture(r,'','pi'),base=path.join(r,'sessions');config(r,{flow_mode:'manual'});
  const task={task_id:'pi-chain',title:'chain',version:0,cast:{executor:{agent,args:[]}}};
  const input={task,role:'executor',records:[],hubRoot:r,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:2',env:{...process.env,PI_CODING_AGENT_SESSION_DIR:base},launchCheckout:'rig' as const};
  const fresh=await buildHeadlessPlan(input),store=new RunStore(r),source=store.create(),sid=fresh.ownership.designated_session_id!;
  await store.initialize(source,{run_id:source,task_id:task.task_id,pid:2147483000,pgid:2147483000,supervisor_pid:2147482999,argv:fresh.argv,cwd:r,
    started_at:'2026-01-01T00:00:00.000Z',ended_at:'2026-01-01T00:01:00.000Z',status:'exited',exit_code:0,headless:fresh.ownership});
  const directory=piSessionDirFor(r,base);mkdirSync(directory,{recursive:true});const file=path.join(directory,'one.jsonl');
  writeFileSync(file,JSON.stringify({type:'session',id:sid,cwd:r})+'\n');
  const plan=await buildHeadlessPlan({...input,runs:[store.read(source)]});
  expect(plan.sessionRef?.session_id).toBe(sid);
  const before=readFileSync(path.join(store.directory(source),'meta.json'));
  const agents=path.join(r,'.context-hub','agents');mkdirSync(agents,{recursive:true});writeFileSync(path.join(agents,'pi.json'),'{broken');
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR',path.join(r,'changed'));
  const start=vi.fn(async()=> 'fixture-run');
  const runtime=new HeadlessRuntime(r,{start,send:async()=>{},log:()=>{},read:async()=>[]});
  expect(await runtime.launchAndSettle(plan)).toEqual({kind:'launched',run_id:'fixture-run'});expect(start).toHaveBeenCalledTimes(1);
  writeFileSync(file,JSON.stringify({type:'session',id:sid,cwd:'/other'})+'\n');
  expect(await runtime.launchAndSettle(plan)).toMatchObject({kind:'skipped',reason:expect.stringContaining('native session changed')});
  expect(start).toHaveBeenCalledTimes(1);expect(store.list()).toEqual([source]);expect(readFileSync(path.join(store.directory(source),'meta.json'))).toEqual(before);
  await expect(buildHeadlessPlan({...input,runs:[store.read(source)]})).rejects.toThrow();
  writeFileSync(file,JSON.stringify({type:'session',id:sid,cwd:r})+'\n');
  await store.updateMeta(source,m=>({...m,task_id:'other-task'}));
  expect(await runtime.launchAndSettle(plan)).toMatchObject({kind:'skipped',reason:expect.stringContaining('source task/role/route/checkout changed')});
  expect(start).toHaveBeenCalledTimes(1);
});

it.skipIf(WINDOWS)('reserves automatic observed sessions in pending intent and meta before the first native event',async()=>{
  const {selectSession}=await import('../../../src/agents/public/index.js');
  const {sessionOccupants}=await import('../../../src/core/run/admission.js');
  const r=root(),agent=fixture(r,'setInterval(()=>{},1000);','codex');config(r,{flow_mode:'manual'});
  const task={task_id:'observed-chain',title:'chain',version:0,cast:{executor:{agent,args:[]}}};
  const input={task,role:'executor',records:[],hubRoot:r,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:2',launchCheckout:'rig' as const};
  const fresh=await buildHeadlessPlan(input),store=new RunStore(r),source=store.create(),sid='thread-reserved';
  const meta:RunMeta={run_id:source,task_id:task.task_id,pid:2147483000,pgid:2147483000,supervisor_pid:2147482999,argv:fresh.argv,cwd:r,
    started_at:'2026-01-01T00:00:00.000Z',ended_at:'2026-01-01T00:01:00.000Z',status:'exited',exit_code:0,headless:fresh.ownership,agent_session_id:sid};
  await store.initialize(source,meta);
  const plan=await buildHeadlessPlan({...input,runs:[store.read(source)]});
  expect(plan.ownership.session_identity).toEqual({agent:'codex',session_id:sid});
  const pending=store.create();await store.writeStartIntent(pending,{task_id:task.task_id,cwd:r,headless:plan.ownership,startup:'pending'});
  expect(sessionOccupants(store,{agent:'another-alias',session_id:sid})).toMatchObject([{run_id:pending,via:'intent'}]);
  await store.writeStartIntent(pending,{task_id:task.task_id,cwd:r,headless:plan.ownership,startup:'failed'});
  const runtime=new HeadlessRuntime(r,{start:builtControl.startRun,send:async()=>{},log:()=>{},read:async()=>[]});
  const launched=await runtime.launchAndSettle(plan);expect(launched.kind).toBe('launched');if(launched.kind!=='launched')throw Error('not launched');
  runs.push({store,id:launched.run_id});
  const live=store.read(launched.run_id);
  expect(live.agent_session_id).toBeUndefined();
  expect(store.readStartIntent(launched.run_id).headless.session_identity).toEqual({agent:'codex',session_id:sid});
  expect(sessionOccupants(store,{agent:'another-alias',session_id:sid})).toMatchObject([{run_id:launched.run_id,via:'meta'}]);
  expect(selectSession(plan.profile!,{...live,agent_session_id:'thread-different'})).toMatchObject({status:'invalid',code:'SESSION_IDENTITY_CONFLICT'});
});

describe.skipIf(WINDOWS)('automatic continuity source contract admission',()=>{
  async function setup() {
    const api=await import('../../../src/agents/public/index.js');
    const r=root(),agent=fixture(r,'','codex');config(r,{flow_mode:'manual'});
    const task={task_id:'source-contract',title:'source contract',version:0,cast:{executor:{agent,args:[]}}};
    const input={task,role:'executor',records:[],hubRoot:r,hubUrl:'http://127.0.0.1:1',eventUrl:'http://127.0.0.1:2',launchCheckout:'rig' as const};
    const fresh=await buildHeadlessPlan(input),store=new RunStore(r),source=store.create();
    const native=JSON.parse(fresh.ownership.contract!).profile;
    const token=(profile:unknown)=>{
      const selected=api.resolveContract({agent},{values:[profile],diagnostics:[],overridden:['codex']},'posix');
      if(selected.status!=='resolved')throw Error(selected.reason);
      return api.encodeContract(selected.handle);
    };
    const capture=structuredClone(native);capture.invoke.resume={tier:'unsupported',reason:'not configured'};
    const captureToken=token(capture);
    const original:RunMeta={run_id:source,task_id:task.task_id,pid:2147483000,pgid:2147483000,supervisor_pid:2147482999,argv:fresh.argv,cwd:r,
      started_at:'2026-01-01T00:00:00.000Z',ended_at:'2026-01-01T00:01:00.000Z',status:'exited',exit_code:0,headless:fresh.ownership,agent_session_id:'thread-source-contract'};
    await store.initialize(source,original);
    const start=vi.fn(async()=> 'fixture-run');
    const runtime=new HeadlessRuntime(r,{start,send:async()=>{},log:()=>{},read:async()=>[]});
    const mark=vi.spyOn(runtime,'mark').mockResolvedValue(undefined);
    return {api,r,agent,input,fresh,store,source,native,token,captureToken,original,start,runtime,mark};
  }
  it.each(['basic','capture-only'] as const)('starts a new invocation without the captured old chain for a %s source',async kind=>{
    const h=await setup();
    let contract=h.captureToken;
    if(kind==='basic') {
      const selected=h.api.resolveContract({agent:'binding:worker-x'},{values:[],diagnostics:[],overridden:[],bindings:{'worker-x':{
        schema_version:1,id:'worker-x',command:{executable:'worker-x',argv:[{slot:'prompt'}]},input:{kind:'argv'}
      }}},'posix');
      if(selected.status!=='resolved')throw Error(selected.reason);
      contract=h.api.encodeContract(selected.handle);
    }
    await h.store.updateMeta(h.source,m=>({...m,headless:{...m.headless!,contract}}));
    const plan=await buildHeadlessPlan({...h.input,runs:[h.store.read(h.source)]});
    expect(plan.ownership.session_reason).toBe('fresh: native resume not configured');
    expect(plan.sessionRef).toBeUndefined();expect(plan.sourceRun).toBeUndefined();
    expect(plan.ownership.resume_from_run_id).toBeUndefined();expect(plan.ownership.session_identity).toBeUndefined();
    expect(plan.argv).not.toContain(h.original.agent_session_id);expect(plan.argv).not.toContain('resume');
    await h.runtime.mark(plan);
    expect(await h.runtime.launchAndSettle(plan)).toEqual({kind:'launched',run_id:'fixture-run'});
    expect(h.mark).toHaveBeenCalledTimes(1);expect(h.start).toHaveBeenCalledTimes(1);
  });
  it.each(['corrupt','conflicting','authority-changed','authority-changed-without-current-resume'] as const)('rejects a %s source before marker or spawn, without fresh fallback',async kind=>{
    const h=await setup();let contract='broken';
    if(kind.startsWith('authority-changed')) {
      const selected=h.api.resolveContract({agent:'opencode'},h.api.contractSource(h.r),'posix');if(selected.status!=='resolved')throw Error('missing native');
      const previous=JSON.parse(h.api.encodeContract(selected.handle)).profile;previous.id='codex';previous.match.supported_executable_names=['codex'];
      contract=h.token(previous);
    } else if(kind==='conflicting')contract=h.fresh.ownership.contract!;
    await h.store.updateMeta(h.source,m=>({...m,...(kind==='conflicting'?{contract:h.captureToken}:{}),headless:{...m.headless!,contract}}));
    if(kind==='authority-changed-without-current-resume') {
      const directory=path.join(h.r,'.context-hub','agents');mkdirSync(directory,{recursive:true});
      writeFileSync(path.join(directory,'codex.json'),JSON.stringify(JSON.parse(h.captureToken).profile));
    }
    const launch=async()=>{
      const plan=await buildHeadlessPlan({...h.input,runs:[h.store.read(h.source)]});
      await h.runtime.mark(plan);return h.runtime.launchAndSettle(plan);
    };
    await expect(launch()).rejects.toThrow(kind.startsWith('authority-changed')?'SESSION_IDENTITY_CONFLICT':'CONTRACT_INVALID');
    expect(h.mark).not.toHaveBeenCalled();expect(h.start).not.toHaveBeenCalled();expect(h.store.list()).toEqual([h.source]);
  });
  it.each(['corrupt','capture-only','valid-revision','top-level','legacy-added'] as const)('refuses %s source snapshot drift after planning under admission',async kind=>{
    const h=await setup();
    if(kind==='legacy-added')await h.store.updateMeta(h.source,m=>{const {contract:_,...headless}=m.headless!;return {...m,headless};});
    const plan=await buildHeadlessPlan({...h.input,runs:[h.store.read(h.source)]});
    expect(plan.sessionRef?.session_id).toBe(h.original.agent_session_id);
    const changed=structuredClone(h.native);changed.revision+='-changed';
    await h.store.updateMeta(h.source,m=>({...m,...(kind==='top-level'?{contract:h.fresh.ownership.contract!}:{headless:{...m.headless!,contract:
      kind==='corrupt'?'broken':kind==='capture-only'?h.captureToken:kind==='valid-revision'?h.token(changed):h.fresh.ownership.contract!}})}));
    const directory=path.join(h.r,'.context-hub','agents');mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,'codex.json'),'{broken');
    expect(await h.runtime.launchAndSettle(plan)).toMatchObject({kind:'skipped',reason:expect.stringContaining('source contract snapshot changed')});
    expect(h.start).not.toHaveBeenCalled();
  });
});

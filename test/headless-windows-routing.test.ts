import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';

// Host facts are already injected below; metadata carries fake PIDs. Keep
// these routing tests at that boundary instead of recompiling a native reader
// for each fake run. Native safe reads have their own Windows test suite.
vi.mock('../src/core/hub/windows-run-file.js', async original => ({
  ...await original<typeof import('../src/core/hub/windows-run-file.js')>(),
  readWindowsRunMeta: (file: string) => readFileSync(file),
}));
const seams = vi.hoisted(() => ({ support: vi.fn(), start: vi.fn(), headers: new Map<string, {id:string;cwd:string}>() }));
vi.mock('../src/core/run/control.js', async original => ({
  ...await original<typeof import('../src/core/run/control.js')>(), requireRunPlatform: seams.support, startRun: seams.start,
}));
// Exercise the production planner from BOTH doors, replacing only host facts:
// Windows executable files and the platform capability owned by the run-control unit. No model
// process is started, so these assertions are not Windows live evidence.
vi.mock('../src/standalone/launcher-headless/plan.js', async original => {
  const actual = await original<typeof import('../src/standalone/launcher-headless/plan.js')>();
  return { ...actual, buildHeadlessPlan: (input: Parameters<typeof actual.buildHeadlessPlan>[0]) => actual.buildHeadlessPlan({
    ...input, platform:'win32', windowsDeps: {
      candidates:async()=>['C:\\node22\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js'],
      nodeExecutable:'C:\\node22\\node.exe', stat:async()=>({isFile:()=>true} as Stats),
      readText:async()=>JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.4.0',bin:{pi:'dist/cli.js'}}),
    },
  }) };
});
vi.mock('../src/core/run/windows-pi-session.js', async original => {
  const actual=await original<typeof import('../src/core/run/windows-pi-session.js')>();
  return {...actual, verifyWindowsPiSession:(location: Parameters<typeof actual.verifyWindowsPiSession>[0], id:string) => actual.verifyWindowsPiSession(location,id,{
    entries:()=>[...seams.headers.keys()],header:file=>{const head=seams.headers.get(path.win32.basename(file));return head?{type:'session',...head}:undefined;},
  })};
});

import { startServer, type RunningServer } from '../src/core/hub/server.js';
import { hubCreate, hubPublish, hubRead } from '../src/core/hub/hub-client.js';
import { runStartNextHeadless } from '../src/core/run/launch-entry.js';
import { Notifier } from '../src/core/notifier/notifier.js';
import { HeadlessRuntime } from '../src/standalone/launcher-headless/runtime.js';
import { buildHeadlessPlan, previousSession } from '../src/standalone/launcher-headless/plan.js';
import { planResume, executeManagedResume } from '../src/core/run/resume.js';
import { RunStore, delay, type RunMeta } from '../src/core/run/store.js';
import { StartRunError, type StartOptions } from '../src/core/run/control.js';
import type { WindowsOwnership } from '../src/standalone/launcher-headless/windows-plan.js';

const servers:RunningServer[]=[],notifiers:Notifier[]=[];
beforeEach(()=>{
  seams.support.mockReset();seams.start.mockReset();seams.headers.clear();
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR','C:\\sessions');
  vi.stubEnv('TUT_CONTINUITY_ROLES','executor,reviewer');
  seams.start.mockImplementation(async(store:RunStore,argv:string[],cwd:string,taskId:string,options:StartOptions)=>{
    const id=store.create();
    const ownership=options.headless as WindowsOwnership;
    const session=ownership.windows?.pi_session;
    if(session)seams.headers.set(`${session.session_id}.jsonl`,{id:session.session_id,cwd:session.launch_cwd});
    await store.initialize(id,{run_id:id,pid:32123,pgid:32123,supervisor_pid:32124,task_id:taskId,argv,cwd,headless:ownership,
      started_at:new Date().toISOString(),status:'exited',ended_at:new Date().toISOString(),exit_code:0});
    return id;
  });
});
afterEach(async()=>{
  for(const n of notifiers.splice(0))await n.close();
  for(const s of servers.splice(0))await s.close();
  vi.unstubAllEnvs();vi.restoreAllMocks();
  // Audit fixtures are isolated in tmp and retained, never erased.
});
async function rig(flow='manual',catchup='off') {
  const root=mkdtempSync(path.join(os.tmpdir(),'tut-win-routing-'));
  mkdirSync(path.join(root,'.context-hub'));
  writeFileSync(path.join(root,'.context-hub','config.json'),JSON.stringify({flow_mode:flow,launch_mode:'detached',launch:{catchup},auto:{launch_roles:['executor','reviewer']}}));
  vi.stubEnv('TUT_HUB_ROOT',root);vi.stubEnv('TUT_PROJECT_ROOT',root);
  const server=await startServer({root:path.join(root,'.context-hub'),port:0});servers.push(server);
  const task=await hubCreate(server.url,{title:'Windows routing fixture',description:'isolated Windows planning contract',flow:'direct',creator:'test',role:'human',cast:{executor:{agent:'pi',args:['--model','glm-5.3']},reviewer:'pi'}});
  const store=new RunStore(root);
  const taskView=async()=>{
    const read=await hubRead(server.url,task.task_id);
    return {task_id:task.task_id,title:'Windows routing fixture',version:read.versions.at(-1)?.version??0,cast:read.cast!};
  };
  const manual=async(role='executor',fresh=false)=>runStartNextHeadless({hubUrl:server.url,role,force:false,fresh,rigRoot:root,task:await taskView()});
  const markers=async()=>(await hubRead(server.url,task.task_id)).versions.filter(r=>r.payload.launch);
  const publish=(role:string,type:string,extra={})=>hubPublish(server.url,{task_id:task.task_id,role,content_type:type,payload:{summary:'fixture',body:'fixture',...extra}});
  return {root,server,task,store,manual,markers,publish,taskView};
}
function notifier(h:Awaited<ReturnType<typeof rig>>) {
  const lines:string[]=[];
  const forbidden=vi.fn(async()=>{throw new Error('unexpected TUI call');});
  const runtime=new HeadlessRuntime(h.root,{send:async()=>{},log:l=>lines.push(l),read:async id=>(await hubRead(h.server.url,id)).versions});
  const n=new Notifier({url:h.server.url,eventPort:1,interval:1,stallTimeoutMin:0},{headlessRuntime:runtime,channelsFor:()=>[],log:l=>lines.push(l),listAnchorPanes:forbidden,listPanes:forbidden,launch:forbidden,cleanupPanes:forbidden,remediator:{remediate:forbidden},relayHostStatus:async()=>{}});
  notifiers.push(n);return {n,runtime,lines,forbidden};
}
async function until(predicate:()=>boolean|Promise<boolean>) {const end=Date.now()+3000;while(!await predicate()){if(Date.now()>end)throw new Error('timed out');await delay(10);}}

describe('Windows routing across real Hub / shared manual and auto doors',()=>{
  it('preserves a WSL session directory through manual launch and exact revision continuation',async()=>{
    const h=await rig();vi.stubEnv('PI_CODING_AGENT_SESSION_DIR','/mnt/d/sessions');
    expect(await h.manual()).toBe(0);
    const first=seams.start.mock.calls[0]!;
    expect(first[1][first[1].indexOf('--session-dir')+1]).toBe('D:\\sessions');
    await h.publish('executor','code_changes');await h.publish('reviewer','review',{verdict:'fail_code'});
    expect(await h.manual()).toBe(0);
    const next=seams.start.mock.calls[1]!;
    expect(next[1][next[1].indexOf('--session-dir')+1]).toBe('D:\\sessions');
    expect(next[4].headless.designated_session_id).toBe(first[4].headless.designated_session_id);
  });
  it.each(['session','agentDir'])('refuses a %s file URL before marker or spawn',async source=>{
    const h=await rig();
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR',source==='session'?'file:///D:/sessions':'');
    if(source==='agentDir')vi.stubEnv('PI_CODING_AGENT_DIR','file:///D:/pi');
    expect(await h.manual()).toBe(1);expect(await h.markers()).toHaveLength(0);expect(seams.start).not.toHaveBeenCalled();
  });
  it('manual success waits for the controller ACK; a marker alone is not launch evidence',async()=>{
    const h=await rig();const start=seams.start.getMockImplementation()!;
    let release!:()=>void;const ack=new Promise<void>(resolve=>{release=resolve;});
    seams.start.mockImplementation(async(...args:unknown[])=>{await ack;return start(...args);});
    let settled=false;const pending=h.manual().then(code=>{settled=true;return code;});
    await until(()=>seams.start.mock.calls.length===1);expect(await h.markers()).toHaveLength(1);expect(settled).toBe(false);
    release();expect(await pending).toBe(0);expect(h.store.list()).toHaveLength(1);
  });
  it('concurrent manual doors race the versioned marker and start only once',async()=>{
    const h=await rig();const results=await Promise.all([h.manual(),h.manual()]);
    expect(results.sort()).toEqual([0,1]);expect(await h.markers()).toHaveLength(1);expect(seams.start).toHaveBeenCalledTimes(1);
  });
  it('manual freezes logical route, physical argv, session directory and Windows marker; dedup does not spawn twice',async()=>{
    const h=await rig();expect(await h.manual()).toBe(0);
    expect(seams.support).toHaveBeenCalledWith('win32');
    expect(seams.start).toHaveBeenCalledTimes(1);
    const meta=h.store.read(h.store.list()[0]!);const win=(meta.headless as WindowsOwnership).windows!;
    expect(meta.argv.slice(0,2)).toEqual(['C:\\node22\\node.exe','C:\\node22\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js']);
    expect(meta.headless?.route).toEqual({agent:'pi',args:['--model','glm-5.3']});
    expect(meta.argv).toContain('glm-5.3');expect(meta.argv.at(-1)).toContain('完整上下文');
    expect(win.logical_argv[0]).toBe('pi');expect(win.pi_session?.session_directory).toBe('C:\\sessions');
    const markers=await h.markers();expect(markers).toHaveLength(1);
    expect(markers[0]!.payload.launch).toMatchObject({target_kind:'headless-windows',launch_mode:'headless',via:'start-next',route:{agent:'pi'}});
    expect(await h.manual()).toBe(1);expect(seams.start).toHaveBeenCalledTimes(1);
  });
  it('same-role revision and re-review reuse their own exact sessions; fresh and role changes isolate sessions',async()=>{
    const h=await rig();await h.manual();
    const executor=h.store.read(h.store.list()[0]!).headless!.designated_session_id;
    await h.publish('executor','code_changes');await h.manual('reviewer');
    const reviewer=seams.start.mock.calls[1]![4].headless.designated_session_id;
    expect(reviewer).not.toBe(executor);
    await h.publish('reviewer','review',{verdict:'fail_code'});expect(await h.manual()).toBe(0);
    expect(seams.start.mock.calls[2]![4].headless.designated_session_id).toBe(executor);
    await h.publish('executor','revision',{ref_version:4});expect(await h.manual('reviewer')).toBe(0);
    expect(seams.start.mock.calls[3]![4].headless.designated_session_id).toBe(reviewer);
    await h.publish('reviewer','review',{verdict:'fail_code'});expect(await h.manual('executor',true)).toBe(0);
    expect(seams.start.mock.calls[4]![4].headless.designated_session_id).not.toBe(executor);
  });
  it('missing source session and absent run-control capability refuse before marker/spawn',async()=>{
    const h=await rig();await h.manual();await h.publish('executor','code_changes');await h.publish('reviewer','review',{verdict:'fail_code'});
    seams.headers.clear();const before=(await h.markers()).length;
    expect(await h.manual()).toBe(1);expect((await h.markers()).length).toBe(before);expect(seams.start).toHaveBeenCalledTimes(1);
    seams.support.mockImplementation(()=>{throw new Error('Windows controller missing');});
    expect(await h.manual('executor',true)).toBe(1);expect((await h.markers()).length).toBe(before);
  });
  it.each(['executor,reviewer','','executor reviewer'])('keeps the detached comma-separated continuity semantics: %j',async value=>{
    const route={agent:'pi',args:[]};const m={run_id:'old',task_id:'t',cwd:'C:\\repo',started_at:'2026-01-01',ended_at:'2026-01-02',headless:{role:'executor',route,designated_session_id:'exact'}} as unknown as RunMeta;
    expect(previousSession([m],{task_id:'t',title:'t'},'executor',route,m.cwd,value).id).toBe(value==='executor,reviewer'?'exact':undefined);
    expect(previousSession([m],{task_id:'t',title:'t'},'architect',route,m.cwd,value).id).toBeUndefined();
  });
  it('managed manual resume uses the frozen Windows target/storage despite environment changes, and emits Windows evidence',async()=>{
    const h=await rig();await h.manual();const from=h.store.list()[0]!;
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR','C:\\changed');
    const plan=await planResume(h.store,from,{platform:'win32',hubUrl:h.server.url});
    expect(plan.argv[0]).toBe('C:\\node22\\node.exe');expect(plan.argv).toContain('C:\\sessions');expect(plan.argv).not.toContain('C:\\changed');
    expect(plan.from.argv.at(-1)).not.toBe(plan.prompt); // source evidence was not mutated
    const result=await executeManagedResume(h.store,plan,{hubUrl:h.server.url,hubRoot:h.root});
    expect(result.run_id).not.toBe(from);
    expect((await h.markers()).at(-1)!.payload.launch).toMatchObject({target_kind:'headless-windows',via:'manual',resume_from_run_id:from});
    expect((await h.markers()).at(-1)!.payload.launch).toHaveProperty('target_digest');
  });
  it('rechecks a Windows session under admission before manual resume writes a marker',async()=>{
    const h=await rig();await h.manual();
    const plan=await planResume(h.store,h.store.list()[0]!,{platform:'win32',hubUrl:h.server.url});
    seams.headers.clear();
    await expect(executeManagedResume(h.store,plan,{hubUrl:h.server.url,hubRoot:h.root})).rejects.toThrow('refusing fresh-session fallback');
    expect(await h.markers()).toHaveLength(1);expect(seams.start).toHaveBeenCalledTimes(1);
  });
  it('auto/manual launch admission releases a candidate if its session disappears before spawn',async()=>{
    const h=await rig();await h.manual();await h.publish('executor','code_changes');await h.publish('reviewer','review',{verdict:'fail_code'});
    const records=(await hubRead(h.server.url,h.task.task_id)).versions;
    const plan=await buildHeadlessPlan({task:await h.taskView(),role:'executor',records,hubRoot:h.root,hubUrl:h.server.url,eventUrl:'http://127.0.0.1:1',runs:h.store.list().map(id=>h.store.read(id))});
    const runtime=new HeadlessRuntime(h.root,{send:async()=>{},log:()=>{},read:async()=>records});
    await runtime.mark(plan);seams.headers.clear();
    expect(await runtime.launchAndSettle(plan)).toMatchObject({kind:'skipped'});
    expect(runtime.busy(h.task.task_id)).toBe(false);expect(seams.start).toHaveBeenCalledTimes(1);
  });
  it('auto catchup repairs an offline edge once, restores Windows run ownership and respects approval gates',async()=>{
    const h=await rig('auto','on');const {n,forbidden}=notifier(h);
    await n.requestCompare();await until(()=>seams.start.mock.calls.length===1);await until(()=>h.store.list().length===1);
    await n.requestCompare();await n.requestCompare();expect(seams.start).toHaveBeenCalledTimes(1);
    expect((await h.markers())[0]!.payload.launch).toMatchObject({target_kind:'headless-windows',via:'auto'});
    await h.publish('executor','code_changes');await n.requestCompare();await until(()=>seams.start.mock.calls.length===2);
    await h.publish('reviewer','review',{verdict:'pass'});await n.requestCompare();await n.requestCompare();
    expect(seams.start).toHaveBeenCalledTimes(2);expect(forbidden).not.toHaveBeenCalled();
    const restarted=notifier(h);await restarted.n.requestCompare();expect(seams.start).toHaveBeenCalledTimes(2);
  });
  it('manual flow and non-whitelisted roles never auto-catchup',async()=>{
    const h=await rig('manual','on');const {n}=notifier(h);await n.requestCompare();expect(seams.start).not.toHaveBeenCalled();
    writeFileSync(path.join(h.root,'.context-hub','config.json'),JSON.stringify({flow_mode:'auto',launch_mode:'detached',launch:{catchup:'on'},auto:{launch_roles:[]}}));
    const restarted=notifier(h);await restarted.n.requestCompare();expect(seams.start).not.toHaveBeenCalled();expect(await h.markers()).toHaveLength(0);
  });
  it('uncertain startup preserves persisted occupancy across restart and never reports success or retries the generation',async()=>{
    const h=await rig('auto','on');
    seams.start.mockImplementation(async(store:RunStore,_argv:string[],cwd:string,taskId:string,options:StartOptions)=>{
      const id=store.create();await store.writeStartIntent(id,{task_id:taskId,headless:options.headless!,cwd,startup:'pending'});
      throw new StartRunError('ACK lost',id,true);
    });
    const {n,runtime}=notifier(h);await n.requestCompare();await until(()=>seams.start.mock.calls.length===1);
    await until(()=>runtime.busy(h.task.task_id));await n.requestCompare();expect(seams.start).toHaveBeenCalledTimes(1);
    await n.close();const restarted=notifier(h);await restarted.n.requestCompare();await restarted.n.requestCompare();
    expect(restarted.runtime.busy(h.task.task_id)).toBe(true);expect(seams.start).toHaveBeenCalledTimes(1);
    expect(await h.manual()).toBe(1);
  });
  it('a target-resolution failure cannot leave a launch marker',async()=>{
    const h=await rig();
    await expect(buildHeadlessPlan({task:{...await h.taskView(),cast:{executor:'bash'}},role:'executor',records:[],hubRoot:h.root,hubUrl:h.server.url,eventUrl:'http://127.0.0.1:1'})).rejects.toThrow('unsupported-headless-agent');
    expect(await h.markers()).toHaveLength(0);expect(seams.start).not.toHaveBeenCalled();
  });
});

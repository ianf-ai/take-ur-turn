import { stopWindowsFixtureRuns } from './helpers/run-cleanup.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { RunStore, delay, probe, type RunMeta } from '../src/core/run/store.js';
import { complete } from '../src/core/run/store.js';
import { windowsMeta } from '../src/core/run/windows-protocol.js';
const WINDOWS=process.platform==='win32';
const cli = path.resolve('dist/cli.js'); const exec = promisify(execFile);
const roots: string[] = []; const groups: number[] = []; const views: ChildProcess[] = [];
function root() { const r = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'run-coop-'))); roots.push(r); return r; }
function env(r: string) { return { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1' }; }
function invoke(r: string, args: string[]) { return exec(process.execPath, [cli, ...args], { cwd: r, env: env(r), timeout: WINDOWS?90_000:18000 }); }
async function until(fn: () => boolean, timeout = WINDOWS?60_000:5000) { const end = performance.now() + timeout; while (!fn()) { if (performance.now() > end) throw new Error('condition timed out'); await delay(10); } }
async function start(r: string, code: string) {
  actorRoots.add(r);
  const finite=WINDOWS?code+';setTimeout(()=>process.exit(124),180000).unref();':code;
  const id = (await invoke(r, ['run', '--', process.execPath, '-e', finite])).stdout.trim(); const store = new RunStore(r); const meta = store.read(id); groups.push(meta.pgid);
  const log = () => readFileSync(path.join(store.directory(id), 'log'), 'utf8');
  return { id, store, meta, log };
}
const actorRoots=new Set<string>();
function readRun(store:RunStore,id:string):RunMeta {
  let m=store.read(id);
  if(WINDOWS&&!complete(m)) {
    if(m.windows?.error)throw new Error(`native fixture ${id}: ${m.windows.error}`);
    if(probe(m.supervisor_pid)===false) {
      // The supervisor may commit completion between the first read and the
      // liveness probe. Confirm failure against a fresh committed snapshot.
      m=store.read(id);
      if(!complete(m))throw new Error(`native fixture ${id}: ${m.windows?.error??'supervisor gone before committed completion'}`);
    }
  }
  return m;
}
function groupAlive(f:Awaited<ReturnType<typeof start>>):boolean|null {
  const m=readRun(f.store,f.id);
  return WINDOWS?(complete(m)?false:m.windows?.observation?!m.windows.observation.job_empty:null):probe(-m.pgid);
}
function childPid(log: string): number { return Number(/child-ready=(\d+)/.exec(log)![1]); }
afterEach(async () => {
  const ownRoots=roots.splice(0),ownGroups=groups.splice(0),ownViews=views.splice(0),actors=[...actorRoots];actorRoots.clear();
  for(const v of ownViews)if(v.exitCode===null)v.kill('SIGINT');
  try { await stopWindowsFixtureRuns(actors); }
  finally {
    if(!WINDOWS)for(const group of ownGroups){try{process.kill(-group,'SIGKILL');}catch{}}
    await delay(180);
    if(!WINDOWS)for(const r of ownRoots)rmSync(r,{recursive:true,force:true});
  }
});

it('root SIGINT lets a cooperative agent reap its own detached child; unrelated run stays alive', async () => {
  const r = root(); const other = await start(r, 'setInterval(()=>{},1000)');
  const f = await start(r, `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',"console.log('child-ready='+process.pid); setTimeout(()=>process.exit(124),180000)"],{detached:true,stdio:'inherit'}); process.on(process.platform==='win32'?'SIGBREAK':'SIGINT',()=>{console.log('root-int'); c.once('exit',()=>{process.stdout.write('reaped-tail🙂'); process.exit(0)}); c.kill('SIGTERM')}); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('child-ready=')); const pid = childPid(f.log()); groups.push(pid);
  const result = await invoke(r, ['stop', f.id]); expect(result.stdout).toContain(WINDOWS?'forced-break':'cooperative'); expect(probe(pid)).toBe(false); expect(groupAlive(f)).toBe(false); expect(groupAlive(other)).toBe(true);
  const stop = f.store.read(f.id).stop_request!;
  if(WINDOWS) {
    const request=windowsMeta(f.store.read(f.id)).stop_request!;
    expect(request.signals).toEqual([]);expect(request.actions).toMatchObject([{action:'break',delivery:'sent'}]);
    expect(request.result).toMatchObject({outcome:'forced-break',success:true,root_exited:true,group_alive:false,scope:'root-and-owned-job',descendants_check:'job-members-only'});
  } else {
    expect(stop.signals.map(s => [s.target, s.signal, s.delivery])).toEqual([[f.meta.pid, 'SIGINT', 'sent']]);
    expect(stop.result).toMatchObject({ outcome: 'cooperative', root_exited: true, group_alive: false, descendants_check: 'not-performed' });
  }
  expect((await invoke(r, ['attach', f.id])).stdout).toContain('reaped-tail🙂');
},WINDOWS?180_000:5000);
it('ignoring root INT waits the full cooperative budget before original-group TERM', async () => {
  const r = root(); const f = await start(r, `process.on(process.platform==='win32'?'SIGBREAK':'SIGINT',()=>console.log('int-ignored')); console.log('ready'); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('ready'));
  const begin = performance.now(); const result = await invoke(r, ['stop', f.id]); expect(performance.now() - begin).toBeGreaterThanOrEqual(WINDOWS?10000:5000);
  expect(result.stdout).toContain(WINDOWS?'forced-kill':'forced-term'); expect(f.log()).toContain('int-ignored');
  if(WINDOWS)expect(windowsMeta(f.store.read(f.id)).stop_request!.actions.map(a=>a.action)).toEqual(['break','taskkill-tree','taskkill-tree-force']);
  else expect(f.store.read(f.id).stop_request!.signals.map(s => [s.target, s.signal])).toEqual([[f.meta.pid, 'SIGINT'], [-f.meta.pgid, 'SIGTERM']]);
},WINDOWS?180_000:10000);
it('a root exiting during cooperation leaves time for its original-group child; attach waits and drains child tail', async () => {
  const r = root(),release=path.join(r,'child-release');
  const child=WINDOWS?`const fs=require('fs');console.log('child-ready='+process.pid);setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){console.log('child-tail');process.exit(0)}},10);setTimeout(()=>process.exit(124),180000).unref();`:`process.on('SIGUSR1',()=>setTimeout(()=>{console.log('child-tail'); process.exit(0)},700)); console.log('child-ready='+process.pid); setInterval(()=>{},1000)`;
  const f = await start(r, `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:${WINDOWS},stdio:'inherit'});process.on(process.platform==='win32'?'SIGBREAK':'SIGINT',()=>{if(process.platform!=='win32')c.kill('SIGUSR1');process.exit(0)});setInterval(()=>{},1000)`);
  await until(() => f.log().includes('child-ready='));
  const view = spawn(process.execPath, [cli, 'attach', f.id], { cwd: r, env: env(r), stdio: ['ignore', 'pipe', 'pipe'] }); views.push(view); let output = ''; let ended = false;
  view.stdout!.on('data', chunk => { output += chunk.toString(); }); const viewed = new Promise<number | null>(resolve => view.once('exit', code => { ended = true; resolve(code); }));
  const stopping = invoke(r, ['stop', f.id]);
  // Attach the rejection handler immediately while we inspect the live child.
  const stopOutcome=stopping.then(value=>({value}),error=>({error}));
  try {
    await until(() => probe(f.meta.pid) === false); expect(groupAlive(f)).toBe(true); expect(f.store.read(f.id).ended_at).toBeUndefined(); expect(ended).toBe(false);
    if(WINDOWS)writeFileSync(release,'release');
    const stopped=await stopOutcome;if('error' in stopped)throw stopped.error;expect(await viewed).toBe(0); expect(output).toContain('child-tail');
    if(WINDOWS)expect(windowsMeta(f.store.read(f.id)).stop_request!.actions).toMatchObject([{action:'break',delivery:'sent'}]);
    else expect(f.store.read(f.id).stop_request!.signals).toHaveLength(1);
  } catch (error) {
    // Drain this CLI before owning cleanup, preserving both the behavioral
    // failure and any native stop error instead of losing it to a timeout.
    const stopped=await stopOutcome;
    if('error' in stopped && stopped.error!==error)throw new AggregateError([error,stopped.error],
      `root/child fixture ${f.id}: ${String(error)}; stop CLI: ${String(stopped.error)}`);
    throw error;
  }
},WINDOWS?180_000:5000);
it('stop CLI exit does not cancel the one accepted request; concurrent/repeated calls share its durable result', async () => {
  const r = root(); const f = await start(r, `let n=0; process.on(process.platform==='win32'?'SIGBREAK':'SIGINT',()=>{console.log('INT '+(++n)); setTimeout(()=>{console.log('finished'); process.exit(0)},600)}); console.log('ready'); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('ready'));
  const caller = spawn(process.execPath, [cli, 'stop', f.id], { cwd: r, env: env(r), stdio: 'ignore' }); views.push(caller);
  await until(() => f.store.read(f.id).stop_request !== undefined);
  const request = f.store.read(f.id).stop_request!; const gone = new Promise<void>(resolve => caller.once('exit', () => resolve())); caller.kill('SIGTERM'); await gone;
  const shared = await invoke(r, ['stop', f.id]); expect(shared.stdout).toContain(WINDOWS?'forced-break':'cooperative');
  const final = f.store.read(f.id); expect(final.stop_request!.id).toBe(request.id); expect(final.stopped_at).toBe(request.requested_at); if(WINDOWS)expect(windowsMeta(final).stop_request!.actions).toMatchObject([{action:'break',delivery:'sent'}]);else expect(final.stop_request!.signals).toHaveLength(1);
  await invoke(r, ['stop', f.id]); expect(f.store.read(f.id).stop_request).toEqual(final.stop_request); expect(f.log().match(/INT 1/g)).toHaveLength(1);
},WINDOWS?180_000:5000);
it('uncooperative detached-child counterexample stays externally detectable; output claims only original-group scope', async () => {
  const r = root(); const f = await start(r, `const {spawn}=require('child_process'); spawn(process.execPath,['-e',"console.log('child-ready='+process.pid); setTimeout(()=>process.exit(124),180000)"],{detached:true,stdio:'inherit'}); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('child-ready=')); const pid = childPid(f.log()); groups.push(pid);
  const stopped = await invoke(r, ['stop', f.id]);
  expect(stopped.stdout).toContain(WINDOWS?'scope=root-and-owned-job':'scope=root-and-original-group');expect(stopped.stdout).toContain(WINDOWS?'descendants_check=job-members-only':'descendants_check=not-performed');
  expect(groupAlive(f)).toBe(false);expect(probe(pid)).toBe(!WINDOWS);
  // Windows detached consoles remain in the owned Job; POSIX keeps its
  // deliberate original-group containment counterexample.
  expect(f.store.read(f.id).stop_request!.result!.descendants_check).toBe(WINDOWS?'job-members-only':'not-performed');
},WINDOWS?180_000:5000);

import { stopWindowsFixtureRuns } from './helpers/run-cleanup.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, rmSync, chmodSync, existsSync, closeSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { RunStore, probe, delay, type RunMeta } from '../src/core/run/store.js';
import { listRuns, stopRun, attachRun, requirePosix } from '../src/core/run/control.js';
import { sessionFromLine } from '../src/core/run/supervisor.js';
import { parseArgs } from '../src/core/cli/args.js';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { complete } from '../src/core/run/store.js';

const WINDOWS = process.platform === 'win32';
const aborts: AbortController[] = [];
const attachedViews: Promise<unknown>[] = [];
const startedRoots = new Set<string>();
const cli = path.resolve('dist/cli.js');
const exec = promisify(execFile);
const roots: string[] = []; const groups: number[] = []; const views: ChildProcess[] = [];
function root(): string { const r = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tut-run-'))); roots.push(r); return r; }
function env(r: string): NodeJS.ProcessEnv { return { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1' }; }
async function invoke(r: string, args: string[]) { return exec(process.execPath, [cli, ...args], { cwd: r, env: env(r), timeout: WINDOWS ? 90_000 : 20000 }); }
async function until(fn: () => boolean, ms = WINDOWS ? 60_000 : 5000, pollMs = 20): Promise<void> { const end = performance.now() + ms; while (!fn()) { if (performance.now() > end) throw new Error('condition timed out'); await delay(pollMs); } }
async function start(r: string, code: string, args: string[] = []): Promise<{ id: string; store: RunStore; meta: RunMeta }> {
  startedRoots.add(r);
  const finite = WINDOWS ? code + ';setTimeout(()=>process.exit(124),180000).unref();' : code;
  const result = await invoke(r, ['run', '--', process.execPath, '-e', finite, ...args]);
  const id = result.stdout.trim(); const store = new RunStore(r); const meta = readRun(store,id); groups.push(meta.pgid);
  return { id, store, meta };
}
function log(r: string, id: string): string { return readFileSync(path.join(r, '.context-hub/runs', id, 'log'), 'utf8'); }
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
function groupAlive(store:RunStore,id:string):boolean|null {
  const m=readRun(store,id);
  if(!WINDOWS)return probe(-m.pgid);
  if(complete(m))return false;
  return m.windows?.observation ? !m.windows.observation.job_empty : null;
}
afterEach(async () => {
  const ownedRoots=roots.splice(0),ownedGroups=groups.splice(0),ownedViews=views.splice(0),actorRoots=[...startedRoots];
  startedRoots.clear();
  for(const a of aborts.splice(0))a.abort();
  await Promise.allSettled(attachedViews.splice(0));
  // ChildProcess owns its original handle; never interpret a Windows PID as
  // a POSIX group. Always drain bookkeeping even if owning cleanup refuses.
  for(const v of ownedViews)if(v.exitCode===null)v.kill('SIGINT');
  try { await stopWindowsFixtureRuns(actorRoots); }
  finally {
    if(!WINDOWS)for(const g of ownedGroups){try{process.kill(-g,'SIGKILL');}catch{}}
    await delay(180);
    // Retain all native archives, including failed publication/cleanup bytes.
    if(!WINDOWS)for(const r of ownedRoots)rmSync(r,{force:true,recursive:true});
  }
});

describe('offline run protocol', () => {
  it('preserves raw argv and rejects invalid wrapper arguments', () => {
    const argv = ['', 'a b', '"quoted"', '$HOME', '--task', 'x'];
    expect(parseArgs(['run', '--task=t', '--', 'agent', ...argv])).toEqual({ command: 'run', task_id: 't', argv: ['agent', ...argv], fixPreflight: false });
    for (const args of [['run', 'agent'], ['run', '--'], ['run', '--task=', '--', 'agent'], ['run', '--bad', '--', 'agent'], ['run', '--task=a', '--task=b', '--', 'agent'], ['ps', '--json=1'], ['attach'], ['stop', 'a', 'b']]) expect(parseArgs(args).command).toBe('usage');
  },WINDOWS?180_000:5000);
  it('starts without Hub, survives CLI, merges stdout/stderr and records real exit codes', async () => {
    const r = root(); const args = ['', 'a b', '"quote"', '$dollar', '--task'];
    const { id, store, meta } = await start(r, `console.log(JSON.stringify(process.argv.slice(1))); console.error('stderr'); setTimeout(()=>{console.log('later'); process.exit(7)},350)`, ['--', ...args]);
    expect(id).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{8}$/); expect(meta.pid).toBe(meta.pgid); expect(meta.pid).not.toBe(meta.supervisor_pid);
    expect(meta.cwd).toBe(realpathSync(r)); expect(meta.argv.slice(-args.length)).toEqual(args);
    await until(() => log(r, id).includes('\n'));
    expect(JSON.parse(log(r, id).split('\n')[0]!)).toEqual(args);
    await until(() => readRun(store,id).status === 'exited');
    expect(store.read(id).exit_code).toBe(7); expect(log(r, id)).toContain('stderr\nlater\n');
    const result = JSON.parse((await invoke(r, ['ps', '--json'])).stdout);
    expect(result.runs[0]).toMatchObject({ status: 'exited', pid_alive: false, group_alive: false });
    if(!WINDOWS) {
      expect((statSync(store.directory(id)).mode & 0o777)).toBe(0o700);
      expect((statSync(path.join(store.directory(id), 'log')).mode & 0o777)).toBe(0o600);
    } else {
      // Windows mode bits are not POSIX permissions/ACL evidence.
      expect(meta.control_protocol).toBe('windows-console-v1');
      expect(statSync(store.directory(id)).isDirectory()).toBe(true);
      expect(statSync(path.join(store.directory(id),'log')).isFile()).toBe(true);
    }
  },WINDOWS?180_000:5000);
  it('captures immediate exit without overwriting it with running; ENOENT stays incomplete', async () => {
    const r = root(); const { id, store } = await start(r, 'process.exit(0)');
    await until(() => readRun(store,id).status === 'exited'); expect(store.read(id).exit_code).toBe(0);
    const before=store.list();
    await expect(invoke(r, ['run', '--', '/missing-tut-test-command'])).rejects.toThrow();
    const result=listRuns(store);expect(result.runs).toHaveLength(1);
    if(WINDOWS) {
      // Native executable existence is checked before a reservation is made.
      expect(result.errors).toHaveLength(0);expect(store.list()).toEqual(before);
      expect(JSON.parse((await invoke(r,['ps','--json'])).stdout).errors).toEqual([]);
    } else {
      expect(result.errors).toHaveLength(1);
      await expect(invoke(r, ['ps', '--json'])).rejects.toMatchObject({ stdout: expect.stringContaining('incomplete') });
    }
  },WINDOWS?180_000:5000);
  it('run → ps → two attach views → stop; Ctrl-C only closes one view', async () => {
    const r = root(); const { id, store, meta } = await start(r, `console.log('初始'); console.error('err'); process.stdout.write('半行'); setInterval(()=>console.log(' tick'),120); process.on(process.platform==='win32'?'SIGBREAK':'SIGINT',()=>{process.stdout.write('尾部🙂'); process.exit(0)})`);
    const output = ['', ''];
    const abort=new AbortController();aborts.push(abort);
    let localView:Promise<{code:number}|{error:unknown}>|undefined;
    if(WINDOWS) localView=attachRun(store,id,new Writable({write(chunk,_,done){output[0]+=chunk.toString();done();}}),abort.signal).then(code=>({code}),error=>({error}));
    if(localView)attachedViews.push(localView);
    for (let i = WINDOWS?1:0; i < 2; i++) {
      const v = spawn(process.execPath, [cli, 'attach', id], { cwd: r, env: env(r), stdio: ['ignore', 'pipe', 'pipe'] }); views.push(v);
      v.stdout!.on('data', chunk => { output[i] += chunk.toString(); });
    }
    await until(() => output.every(s => s.includes('tick')));
    if(WINDOWS) {
      // Windows ChildProcess.kill is force termination, not keyboard Ctrl-C.
      // Exercise the actual attach AbortSignal/130 contract for one view.
      abort.abort();expect(await localView).toEqual({code:130});
    } else {
      const first=views[0]!;const exited=new Promise<number|null>(resolve=>first.once('exit',resolve));first.kill('SIGINT');expect(await exited).toBe(130);
    }
    const before = output[1]!.length; await until(() => output[1]!.length > before); expect(groupAlive(store,id)).toBe(true);
    expect(JSON.parse((await invoke(r, ['ps', '--json'])).stdout).runs[0].status).toBe('running');
    await invoke(r, ['stop', id]); expect(groupAlive(store,id)).toBe(false);
    await until(() => output[1]!.includes('尾部🙂'));
    await until(() => readRun(store,id).ended_at !== undefined);
    expect(store.read(id)).toMatchObject({ status: 'stopped', exit_code: 0, stopped_by: expect.any(String) });
    const stoppedAt = store.read(id).stopped_at;
    await invoke(r, ['stop', id]); expect(store.read(id).stopped_at).toBe(stoppedAt);
  },WINDOWS?180_000:5000);
  it('uses the production 5+5s grace then kills a TERM-ignoring leader and child', async () => {
    const r = root();
    const { id, store, meta } = await start(r, `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});if(process.platform==='win32')process.on('SIGBREAK',()=>{}); console.log('child ready'); setTimeout(()=>process.exit(124),180000)"],{stdio:'inherit'}); process.on('SIGINT',()=>{});if(process.platform==='win32')process.on('SIGBREAK',()=>{}); process.on('SIGTERM',()=>{}); console.log('child='+c.pid); setInterval(()=>{},1000)`);
    await until(() => log(r, id).includes('child ready'));
    const started=performance.now();
    const observe=(pending:ReturnType<typeof invoke>)=>pending.then(value=>({value}),error=>({error}));
    const stopping=observe(invoke(r,['stop',id]));
    let concurrent: ReturnType<typeof observe> | undefined;
    let joinedRequest: string | undefined;
    try {
      if (WINDOWS) {
        // Join a committed, still-pending request. A fixed sleep races the
        // first caller's native challenge + safe publication while it owns
        // stop.lock; that tests lock contention rather than request dedup.
        await until(() => {
          const request = readRun(store,id).stop_request;
          if (!request) return false;
          expect(request.result).toBeUndefined();
          joinedRequest = request.id;
          return true;
        }, 60_000, 250);
      } else await delay(600);
      concurrent=observe(invoke(r,['stop',id]));
      expect(groupAlive(store,id)).toBe(true);
      const results=await Promise.all([stopping,concurrent]);
      for(const result of results)if('error' in result)throw result.error;
    } finally {await Promise.all([stopping,...(concurrent ? [concurrent] : [])]);}
    expect(performance.now()-started).toBeGreaterThanOrEqual(10000);expect(groupAlive(store,id)).toBe(false);
    if(WINDOWS)expect(store.read(id).stop_request).toMatchObject({id:joinedRequest,signals:[],actions:[{action:'break'},{action:'taskkill-tree'},{action:'taskkill-tree-force'}],result:{success:true,outcome:'forced-kill',scope:'root-and-owned-job',descendants_check:'job-members-only'}});
  }, WINDOWS?180_000:20000);
  it('keeps tracking descendants when the leader exits before stop', async () => {
    const r = root();
    const { id, store, meta } = await start(r, `const {spawn}=require('child_process'); spawn(process.execPath,['-e',"console.log('descendant ready'); setTimeout(()=>process.exit(124),180000)"],{detached:process.platform==='win32',stdio:'inherit'}).unref(); process.exit(3)`);
    await until(() => log(r, id).includes('descendant ready'));
    await until(()=>probe(meta.pid)===false);if(WINDOWS)await until(()=>groupAlive(store,id)===true);expect(groupAlive(store,id)).toBe(true); expect(readRun(store,id).status).toBe('running');
    await invoke(r, ['stop', id]); expect(groupAlive(store,id)).toBe(false);
    await until(() => readRun(store,id).ended_at !== undefined); expect(store.read(id).exit_code).toBe(3);
  },WINDOWS?180_000:5000);
  it('replays exactly the last 50 lines, preserves partial UTF-8 and honors backpressure without writes', async () => {
    const r = root(); const { id, store } = await start(r, `for(let i=0;i<80;i++) console.log('line'+i); process.stdout.write('半行🙂')`);
    await until(() => readRun(store,id).ended_at !== undefined);
    const snapshot = readdirSync(store.directory(id)).map(f => [f, statSync(path.join(store.directory(id), f)).mtimeMs]);
    let text = ''; const output = new Writable({ highWaterMark: 1, write(chunk, _, done) { text += chunk.toString(); setTimeout(done, 2); } });
    expect(await attachRun(store, id, output)).toBe(0); expect(text).toBe(Array.from({length:49}, (_, i)=>`line${i+31}\n`).join('')+'半行🙂');
    listRuns(store);
    expect(readdirSync(store.directory(id)).map(f => [f, statSync(path.join(store.directory(id), f)).mtimeMs])).toEqual(snapshot);
  },WINDOWS?180_000:5000);
  it('rejects paths, symlinks and dangerous metadata, exposes healthy entries beside broken ones', async () => {
    const r = root(); const { id, store } = await start(r, ''); await until(() => readRun(store,id).ended_at !== undefined);
    for (const invalid of ['..', '/tmp', '../x', id+'/x', 'a']) expect(() => store.read(invalid)).toThrow('invalid run-id');
    const bad = store.create(); writeFileSync(path.join(store.directory(bad), 'meta.json'), '{');
    const linked = store.create(); symlinkSync(path.join(store.directory(id), 'meta.json'), path.join(store.directory(linked), 'meta.json'));
    expect(listRuns(store).errors).toHaveLength(2);
    for (const pgid of [0, -1, 1, process.pid]) {
      writeFileSync(path.join(store.directory(bad), 'meta.json'), JSON.stringify({ ...store.read(id), run_id: bad, pgid }));
      await expect(stopRun(store, bad)).rejects.toThrow();
      expect(existsSync(path.join(store.directory(bad), 'stop.lock'))).toBe(false);
    }
    const r2 = root(); mkdirSync(path.join(r2, '.context-hub')); symlinkSync(r, path.join(r2, '.context-hub/runs'),WINDOWS?'junction':'dir');
    expect(() => new RunStore(r2).create()).toThrow('unsafe');
  },WINDOWS?180_000:5000);
  it('fails before spawn on unwritable storage and never creates runs for empty ps', async () => {
    const r = root(); expect(JSON.parse((await invoke(r, ['ps', '--json'])).stdout)).toEqual({ runs: [], errors: [], quarantined: [] }); expect(existsSync(path.join(r, '.context-hub'))).toBe(false);
    if (process.platform === 'win32') {
      // chmod does not deny Windows directory writes. A real regular file
      // at the storage-directory path must fail before spawning the command.
      writeFileSync(path.join(r, '.context-hub'), 'not a directory');
      await expect(invoke(r, ['run', '--', process.execPath, '-e', "require('fs').writeFileSync('SPAWNED','x')"])).rejects.toThrow();
      expect(readFileSync(path.join(r, '.context-hub'), 'utf8')).toBe('not a directory');
      expect(existsSync(path.join(r, 'SPAWNED'))).toBe(false);
    } else {
      mkdirSync(path.join(r, '.context-hub')); chmodSync(path.join(r, '.context-hub'), 0o500);
      try { await expect(invoke(r, ['run', '--', process.execPath, '-e', "require('fs').writeFileSync('SPAWNED','x')"])).rejects.toThrow(); expect(existsSync(path.join(r, 'SPAWNED'))).toBe(false); }
      finally { chmodSync(path.join(r, '.context-hub'), 0o700); }
    }
  },WINDOWS?180_000:5000);
  it('preserves unknown fields under concurrent cross-process metadata writers', async () => {
    const r = root(); const { id, store } = await start(r, 'setInterval(()=>{},1000)');
    const module = path.resolve('dist/core/run/store.js');
    const writers=await Promise.allSettled(Array.from({ length: 8 }, (_, i) => exec(process.execPath, ['--input-type=module', '-e', `
      import {RunStore} from ${JSON.stringify(pathToFileURL(module).href)};
      const store=new RunStore(${JSON.stringify(r)}),deadline=Date.now()+60000;let callbacks=0,attempts=0;
      for(;;){try{attempts++;await store.updateMeta(${JSON.stringify(id)},m=>{callbacks++;return {...m,field${i}:${i}}});break;}
        catch(e){if(process.platform!=='win32'||!/^meta lock in-progress or unverifiable for /.test(e.message)||callbacks||Date.now()>=deadline)throw e;await new Promise(r=>setTimeout(r,50));}}
      console.log(JSON.stringify({writer:${i},callbacks,attempts}));
    `],{timeout:WINDOWS?90000:20000})));
    // Only pre-callback lock acquisition contention is retried on Windows;
    // publication/identity errors and repeated update callbacks must still fail.
    for(const writer of writers)if(writer.status==='rejected')throw writer.reason;
    expect(writers.map(w=>w.status==='fulfilled'?JSON.parse(w.value.stdout).callbacks:undefined)).toEqual(Array(8).fill(1));
    for (let i = 0; i < 8; i++) expect(store.read(id)[`field${i}`]).toBe(i);
    await invoke(r, ['stop', id]); expect(store.read(id).field7).toBe(7);
  },WINDOWS?180_000:5000);
  it('refuses identity-unverified stale snapshots without signaling the live unrelated group', async () => {
    const r = root(); const { id, store, meta } = await start(r, 'setInterval(()=>{},1000)');
    if(WINDOWS) {
      // Model a stale CLIENT read, not corruption of the live supervisor's
      // own on-disk identity (which legitimately fails the Windows Job closed).
      const original=readRun(store,id);
      const snapshot=vi.spyOn(store,'read').mockReturnValue({...original,supervisor_pid:process.pid});
      try { await expect(stopRun(store,id,{identityMs:50})).rejects.toThrow('original supervisor unavailable'); }
      finally { snapshot.mockRestore(); }
      expect(probe(meta.pid)).toBe(true);
      expect(store.read(id).supervisor_pid).toBe(meta.supervisor_pid);
      expect(store.read(id).stop_request).toBeUndefined();
      return;
    }
    // An alive but non-supervising PID cannot answer a fresh nonce.
    await store.updateMeta(id, m => ({ ...m, supervisor_pid: process.pid }));
    await expect(stopRun(store, id, { identityMs: 50 })).rejects.toThrow(WINDOWS?'original supervisor unavailable':'caller/supervisor');
    expect(groupAlive(store,id)).toBe(true);
    await store.updateMeta(id, m => ({ ...m, supervisor_pid: meta.supervisor_pid }));
  },WINDOWS?180_000:5000);
  it('captures only native complete session events; fast supplementary writes survive exit/stop', async () => {
    expect(sessionFromLine('{"type":"thread.started","thread_id":"019abcde-12345678"}')).toBe('019abcde-12345678');
    expect(sessionFromLine('session id: guess')).toBeUndefined(); expect(sessionFromLine('{"session_id":"guess"}')).toBeUndefined();
    const r = root(); const { id, store } = await start(r, `console.log(JSON.stringify({type:'thread.started',thread_id:'019abcde-12345678'})); setInterval(()=>{},1000)`);
    if(WINDOWS) {
      await until(()=>log(r,id).includes('thread.started'));
      expect(JSON.parse(log(r,id).split(/\r?\n/)[0]!)).toEqual({type:'thread.started',thread_id:'019abcde-12345678'});
      expect(readRun(store,id).agent_session_id).toBeUndefined();
    } else await until(() => store.read(id).agent_session_id !== undefined);
    await invoke(r, ['stop', id]);
    await until(() => readRun(store,id).ended_at !== undefined);
    expect(store.read(id).agent_session_id).toBe(WINDOWS?undefined:'019abcde-12345678');
  },WINDOWS?180_000:5000);
  it('distinguishes EPERM from ESRCH and rejects Windows before group operations', () => {
    const fail = (code: string) => (() => { throw Object.assign(new Error(code), { code }); }) as typeof process.kill;
    const modeledPid=process.platform==='win32'?2147483000:-345;
    expect(probe(modeledPid, fail('EPERM'))).toBeNull(); expect(probe(modeledPid, fail('ESRCH'))).toBe(false);
    if(process.platform==='win32') {
      const kill=vi.fn() as unknown as typeof process.kill;
      expect(probe(-345,kill)).toBeNull();expect(kill).not.toHaveBeenCalled();
    }
    expect(() => probe(-1)).toThrow(); expect(() => requirePosix('win32')).toThrow('POSIX');
  },WINDOWS?180_000:5000);
});

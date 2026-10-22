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

const cli = path.resolve('dist/cli.js');
const exec = promisify(execFile);
const roots: string[] = []; const groups: number[] = []; const views: ChildProcess[] = [];
function root(): string { const r = mkdtempSync(path.join(os.tmpdir(), 'tut-run-')); roots.push(r); return r; }
function env(r: string): NodeJS.ProcessEnv { return { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1' }; }
async function invoke(r: string, args: string[]) { return exec(process.execPath, [cli, ...args], { cwd: r, env: env(r), timeout: 20000 }); }
async function until(fn: () => boolean, ms = 5000): Promise<void> { const end = performance.now() + ms; while (!fn()) { if (performance.now() > end) throw new Error('condition timed out'); await delay(20); } }
async function start(r: string, code: string, args: string[] = []): Promise<{ id: string; store: RunStore; meta: RunMeta }> {
  const result = await invoke(r, ['run', '--', process.execPath, '-e', code, ...args]);
  const id = result.stdout.trim(); const store = new RunStore(r); const meta = store.read(id); groups.push(meta.pgid);
  return { id, store, meta };
}
function log(r: string, id: string): string { return readFileSync(path.join(r, '.context-hub/runs', id, 'log'), 'utf8'); }
afterEach(async () => {
  for (const v of views.splice(0)) v.kill('SIGINT');
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch {} }
  await delay(180); // supervisors reap their own command and finish metadata
  for (const r of roots.splice(0)) rmSync(r, { force: true, recursive: true });
});

describe('offline run protocol', () => {
  it('preserves raw argv and rejects invalid wrapper arguments', () => {
    const argv = ['', 'a b', '"quoted"', '$HOME', '--task', 'x'];
    expect(parseArgs(['run', '--task=t', '--', 'agent', ...argv])).toEqual({ command: 'run', task_id: 't', argv: ['agent', ...argv], fixPreflight: false });
    for (const args of [['run', 'agent'], ['run', '--'], ['run', '--task=', '--', 'agent'], ['run', '--bad', '--', 'agent'], ['run', '--task=a', '--task=b', '--', 'agent'], ['ps', '--json=1'], ['attach'], ['stop', 'a', 'b']]) expect(parseArgs(args).command).toBe('usage');
  });
  it('starts without Hub, survives CLI, merges stdout/stderr and records real exit codes', async () => {
    const r = root(); const args = ['', 'a b', '"quote"', '$dollar', '--task'];
    const { id, store, meta } = await start(r, `console.log(JSON.stringify(process.argv.slice(1))); console.error('stderr'); setTimeout(()=>{console.log('later'); process.exit(7)},350)`, ['--', ...args]);
    expect(id).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{8}$/); expect(meta.pid).toBe(meta.pgid); expect(meta.pid).not.toBe(meta.supervisor_pid);
    expect(meta.cwd).toBe(realpathSync(r)); expect(meta.argv.slice(-args.length)).toEqual(args);
    await until(() => log(r, id).includes('\n'));
    expect(JSON.parse(log(r, id).split('\n')[0]!)).toEqual(args);
    await until(() => store.read(id).status === 'exited');
    expect(store.read(id).exit_code).toBe(7); expect(log(r, id)).toContain('stderr\nlater\n');
    const result = JSON.parse((await invoke(r, ['ps', '--json'])).stdout);
    expect(result.runs[0]).toMatchObject({ status: 'exited', pid_alive: false, group_alive: false });
    expect((statSync(store.directory(id)).mode & 0o777)).toBe(0o700);
    expect((statSync(path.join(store.directory(id), 'log')).mode & 0o777)).toBe(0o600);
  });
  it('captures immediate exit without overwriting it with running; ENOENT stays incomplete', async () => {
    const r = root(); const { id, store } = await start(r, 'process.exit(0)');
    await until(() => store.read(id).status === 'exited'); expect(store.read(id).exit_code).toBe(0);
    await expect(invoke(r, ['run', '--', '/missing-tut-test-command'])).rejects.toThrow();
    const result = listRuns(store); expect(result.runs).toHaveLength(1); expect(result.errors).toHaveLength(1);
    await expect(invoke(r, ['ps', '--json'])).rejects.toMatchObject({ stdout: expect.stringContaining('incomplete') });
  });
  it('run → ps → two attach views → stop; Ctrl-C only closes one view', async () => {
    const r = root(); const { id, store, meta } = await start(r, `console.log('初始'); console.error('err'); process.stdout.write('半行'); setInterval(()=>console.log(' tick'),120); process.on('SIGINT',()=>{process.stdout.write('尾部🙂'); process.exit(0)})`);
    const output = ['', ''];
    for (let i = 0; i < 2; i++) {
      const v = spawn(process.execPath, [cli, 'attach', id], { cwd: r, env: env(r), stdio: ['ignore', 'pipe', 'pipe'] }); views.push(v);
      v.stdout!.on('data', chunk => { output[i] += chunk.toString(); });
    }
    await until(() => output.every(s => s.includes('tick')));
    const first = views[0]!; const exited = new Promise<number | null>(resolve => first.once('exit', resolve)); first.kill('SIGINT'); expect(await exited).toBe(130);
    const before = output[1]!.length; await until(() => output[1]!.length > before); expect(probe(-meta.pgid)).toBe(true);
    expect(JSON.parse((await invoke(r, ['ps', '--json'])).stdout).runs[0].status).toBe('running');
    await invoke(r, ['stop', id]); expect(probe(-meta.pgid)).toBe(false);
    await until(() => output[1]!.includes('尾部🙂'));
    await until(() => store.read(id).ended_at !== undefined);
    expect(store.read(id)).toMatchObject({ status: 'stopped', exit_code: 0, stopped_by: expect.any(String) });
    const stoppedAt = store.read(id).stopped_at;
    await invoke(r, ['stop', id]); expect(store.read(id).stopped_at).toBe(stoppedAt);
  });
  it('uses the production 5+5s grace then kills a TERM-ignoring leader and child', async () => {
    const r = root();
    const { id, meta } = await start(r, `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('child ready'); setInterval(()=>{},1000)"],{stdio:'inherit'}); process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); console.log('child='+c.pid); setInterval(()=>{},1000)`);
    await until(() => log(r, id).includes('child ready'));
    const started = performance.now(); const stopping = invoke(r, ['stop', id]);
    await delay(600); const concurrent = invoke(r, ['stop', id]);
    expect(probe(-meta.pgid)).toBe(true);
    await stopping; await concurrent; expect(performance.now() - started).toBeGreaterThanOrEqual(10000); expect(probe(-meta.pgid)).toBe(false);
  }, 20000);
  it('keeps tracking descendants when the leader exits before stop', async () => {
    const r = root();
    const { id, store, meta } = await start(r, `const {spawn}=require('child_process'); spawn(process.execPath,['-e',"console.log('descendant ready'); setInterval(()=>{},1000)"],{stdio:'inherit'}).unref(); process.exit(3)`);
    await until(() => log(r, id).includes('descendant ready'));
    expect(probe(meta.pid)).toBe(false); expect(probe(-meta.pgid)).toBe(true); expect(store.read(id).status).toBe('running');
    await invoke(r, ['stop', id]); expect(probe(-meta.pgid)).toBe(false);
    await until(() => store.read(id).ended_at !== undefined); expect(store.read(id).exit_code).toBe(3);
  });
  it('replays exactly the last 50 lines, preserves partial UTF-8 and honors backpressure without writes', async () => {
    const r = root(); const { id, store } = await start(r, `for(let i=0;i<80;i++) console.log('line'+i); process.stdout.write('半行🙂')`);
    await until(() => store.read(id).ended_at !== undefined);
    const snapshot = readdirSync(store.directory(id)).map(f => [f, statSync(path.join(store.directory(id), f)).mtimeMs]);
    let text = ''; const output = new Writable({ highWaterMark: 1, write(chunk, _, done) { text += chunk.toString(); setTimeout(done, 2); } });
    expect(await attachRun(store, id, output)).toBe(0); expect(text).toBe(Array.from({length:49}, (_, i)=>`line${i+31}\n`).join('')+'半行🙂');
    listRuns(store);
    expect(readdirSync(store.directory(id)).map(f => [f, statSync(path.join(store.directory(id), f)).mtimeMs])).toEqual(snapshot);
  });
  it('rejects paths, symlinks and dangerous metadata, exposes healthy entries beside broken ones', async () => {
    const r = root(); const { id, store } = await start(r, ''); await until(() => store.read(id).ended_at !== undefined);
    for (const invalid of ['..', '/tmp', '../x', id+'/x', 'a']) expect(() => store.read(invalid)).toThrow('invalid run-id');
    const bad = store.create(); writeFileSync(path.join(store.directory(bad), 'meta.json'), '{');
    const linked = store.create(); symlinkSync(path.join(store.directory(id), 'meta.json'), path.join(store.directory(linked), 'meta.json'));
    expect(listRuns(store).errors).toHaveLength(2);
    for (const pgid of [0, -1, 1, process.pid]) {
      writeFileSync(path.join(store.directory(bad), 'meta.json'), JSON.stringify({ ...store.read(id), run_id: bad, pgid }));
      await expect(stopRun(store, bad)).rejects.toThrow();
      expect(existsSync(path.join(store.directory(bad), 'stop.lock'))).toBe(false);
    }
    const r2 = root(); mkdirSync(path.join(r2, '.context-hub')); symlinkSync(r, path.join(r2, '.context-hub/runs'));
    expect(() => new RunStore(r2).create()).toThrow('unsafe');
  });
  it('fails before spawn on unwritable storage and never creates runs for empty ps', async () => {
    const r = root(); expect(JSON.parse((await invoke(r, ['ps', '--json'])).stdout)).toEqual({ runs: [], errors: [], quarantined: [] }); expect(existsSync(path.join(r, '.context-hub'))).toBe(false);
    mkdirSync(path.join(r, '.context-hub')); chmodSync(path.join(r, '.context-hub'), 0o500);
    try { await expect(invoke(r, ['run', '--', process.execPath, '-e', "require('fs').writeFileSync('SPAWNED','x')"])).rejects.toThrow(); expect(existsSync(path.join(r, 'SPAWNED'))).toBe(false); }
    finally { chmodSync(path.join(r, '.context-hub'), 0o700); }
  });
  it('preserves unknown fields under concurrent cross-process metadata writers', async () => {
    const r = root(); const { id, store } = await start(r, 'setInterval(()=>{},1000)');
    const module = path.resolve('dist/core/run/store.js');
    await Promise.all(Array.from({ length: 8 }, (_, i) => exec(process.execPath, ['--input-type=module', '-e', `import {RunStore} from ${JSON.stringify('file://'+module)}; await new RunStore(${JSON.stringify(r)}).updateMeta(${JSON.stringify(id)},m=>({...m,field${i}:${i}}))`])));
    for (let i = 0; i < 8; i++) expect(store.read(id)[`field${i}`]).toBe(i);
    await invoke(r, ['stop', id]); expect(store.read(id).field7).toBe(7);
  });
  it('refuses identity-unverified stale snapshots without signaling the live unrelated group', async () => {
    const r = root(); const { id, store, meta } = await start(r, 'setInterval(()=>{},1000)');
    // An alive but non-supervising PID cannot answer a fresh nonce.
    await store.updateMeta(id, m => ({ ...m, supervisor_pid: process.pid }));
    await expect(stopRun(store, id, { identityMs: 50 })).rejects.toThrow('caller/supervisor');
    expect(probe(-meta.pgid)).toBe(true);
    await store.updateMeta(id, m => ({ ...m, supervisor_pid: meta.supervisor_pid }));
  });
  it('captures only native complete session events; fast supplementary writes survive exit/stop', async () => {
    expect(sessionFromLine('{"type":"thread.started","thread_id":"019abcde-12345678"}')).toBe('019abcde-12345678');
    expect(sessionFromLine('session id: guess')).toBeUndefined(); expect(sessionFromLine('{"session_id":"guess"}')).toBeUndefined();
    const r = root(); const { id, store } = await start(r, `console.log(JSON.stringify({type:'thread.started',thread_id:'019abcde-12345678'})); setInterval(()=>{},1000)`);
    await until(() => store.read(id).agent_session_id !== undefined); await invoke(r, ['stop', id]);
    await until(() => store.read(id).ended_at !== undefined); expect(store.read(id).agent_session_id).toBe('019abcde-12345678');
  });
  it('distinguishes EPERM from ESRCH and rejects Windows before group operations', () => {
    const fail = (code: string) => (() => { throw Object.assign(new Error(code), { code }); }) as typeof process.kill;
    expect(probe(-345, fail('EPERM'))).toBeNull(); expect(probe(-345, fail('ESRCH'))).toBe(false);
    expect(() => probe(-1)).toThrow(); expect(() => requirePosix('win32')).toThrow('POSIX');
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { RunStore, delay, probe, type RunMeta } from '../src/core/run/store.js';
const exec = promisify(execFile);
const cli = path.resolve('dist/cli.js');
const storeUrl = pathToFileURL(path.resolve('dist/core/run/store.js')).href;
const worker = path.resolve('test/fixtures/run-lock-process.mjs');
const observer = pathToFileURL(path.resolve('test/fixtures/run-lock-observer.mjs')).href;
const roots: string[] = []; const groups: number[] = []; const children: ChildProcess[] = [];
function root() { const r = mkdtempSync(path.join(os.tmpdir(), 'run-lock-')); roots.push(r); return r; }
async function until(fn: () => boolean, budget = 3000) { const end = performance.now() + budget; while (!fn()) { if (performance.now() >= end) throw new Error('lock handshake timed out'); await delay(10); } }
function child(root: string, id: string, role: string, mode = 'empty') {
  const process = spawn(globalThis.process.execPath, [worker, storeUrl, root, id, role, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(process);
  let stdout = ''; let stderr = '';
  process.stdout!.on('data', data => { stdout += data.toString(); }); process.stderr!.on('data', data => { stderr += data.toString(); });
  const ended = new Promise<number | null>((resolve, reject) => { process.once('exit', resolve); process.once('error', reject); });
  const messages = () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; raw?: string; message?: string });
  return { process, ended, messages, stderr: () => stderr,
    wait: async (kind: string) => { await until(() => messages().some(m => m.kind === kind)); return messages().find(m => m.kind === kind)!; } };
}
afterEach(async () => {
  for (const p of children.splice(0)) if (p.exitCode === null && p.signalCode === null) { p.kill('SIGCONT'); p.kill('SIGKILL'); }
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch {} }
  await delay(180);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function fixture() {
  const r = root(); const store = new RunStore(r); const id = store.create();
  const meta: RunMeta = { run_id: id, pid: 900001, pgid: 900001, supervisor_pid: 900002, cwd: path.resolve(r), argv: ['fixture'], status: 'running', started_at: new Date().toISOString(), preserved: 'yes' };
  await store.initialize(id, meta); return { r, store, id };
}
it.each(['empty', 'partial'])('a real competitor survives the %s owner publication window and merges both writers', async mode => {
  const { r, store, id } = await fixture();
  const owner = child(r, id, 'owner', mode); await owner.wait('window');
  const file = path.join(store.directory(id), 'meta.lock'); const initial = mode === 'empty' ? '' : '{"pid":';
  expect(readFileSync(file, 'utf8')).toBe(initial); const inode = statSync(file).ino;
  const contender = child(r, id, 'contender'); const observation = await contender.wait('observed'); expect(observation.raw).toBe(initial);
  // Release only after another OS process really read the incomplete owner.
  expect(statSync(file).ino).toBe(inode); expect(readFileSync(file, 'utf8')).toBe(initial);
  owner.process.kill('SIGCONT'); expect(await owner.ended).toBe(0);
  expect(await contender.ended, JSON.stringify(contender.messages())).toBe(0);
  expect(store.read(id)).toMatchObject({ owner_done: true, contender_done: true, preserved: 'yes' });
  expect(existsSync(file)).toBe(false);
});
it('the original supervisor survives real lock initialization contention and can still stop its agent exactly once', async () => {
  const r = root(); const observed = path.join(r, 'supervisor-observation');
  const env = { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1', RUN_LOCK_OBSERVED: observed,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${observer}`].filter(Boolean).join(' ') };
  const code = `process.on('SIGUSR2',()=>console.log(JSON.stringify({type:'thread.started',thread_id:'lock-session-12345'}))); process.on('SIGINT',()=>{console.log('INT once'); process.exit(0)}); console.log('ready'); setInterval(()=>{},1000)`;
  const id = (await exec(process.execPath, [cli, 'run', '--', process.execPath, '-e', code], { cwd: r, env, timeout: 8000 })).stdout.trim();
  const store = new RunStore(r); const meta = store.read(id); groups.push(meta.pgid);
  const log = () => readFileSync(path.join(store.directory(id), 'log'), 'utf8'); await until(() => log().includes('ready'));
  const owner = child(r, id, 'owner'); await owner.wait('window');
  process.kill(meta.pid, 'SIGUSR2');
  // This witness comes from the actual detached monitor, not a timing guess.
  await until(() => existsSync(observed)); expect(readFileSync(observed, 'utf8')).toBe('observed-empty-owner');
  owner.process.kill('SIGCONT'); expect(await owner.ended).toBe(0);
  await until(() => store.read(id).agent_session_id === 'lock-session-12345');
  expect(probe(meta.supervisor_pid)).toBe(true); expect(probe(-meta.pgid)).toBe(true); expect(store.read(id).owner_done).toBe(true);
  const stopped = await exec(process.execPath, [cli, 'stop', id], { cwd: r, env, timeout: 18000 }); expect(stopped.stdout).toContain('cooperative');
  const final = store.read(id); expect(final).toMatchObject({ owner_done: true, agent_session_id: 'lock-session-12345', status: 'stopped' });
  expect(final.stop_request!.signals.map(s => [s.target, s.signal, s.delivery])).toEqual([[meta.pid, 'SIGINT', 'sent']]);
  expect(log().match(/INT once/g)).toHaveLength(1); expect(log()).not.toContain('[tut supervisor]'); expect(probe(-meta.pgid)).toBe(false);
  await exec(process.execPath, [cli, 'stop', id], { cwd: r, env, timeout: 8000 }); expect(store.read(id).stop_request).toEqual(final.stop_request);
});
it.each(['', '{"pid":', 'null', '{"pid":2147483647}', '{"pid":0,"token":"unknown"}'])('persistent unverifiable owner %j waits only its bounded budget and is never stolen', async raw => {
  const { store, id } = await fixture(); const file = path.join(store.directory(id), 'meta.lock'); writeFileSync(file, raw); const inode = statSync(file).ino;
  const started = performance.now(); await expect(store.lock(id, 'meta', 50)).rejects.toThrow('cannot verify');
  expect(performance.now() - started).toBeGreaterThanOrEqual(45); expect(statSync(file).ino).toBe(inode); expect(readFileSync(file, 'utf8')).toBe(raw);
});

it('a valid owner that can only be probed as EPERM is never recovered or overwritten', async () => {
  const { store, id } = await fixture(); const file = path.join(store.directory(id), 'meta.lock');
  const owner = JSON.stringify({ pid: 2147483646, token: 'permission-denied-owner' }); writeFileSync(file, owner); const inode = statSync(file).ino;
  const original = process.kill;
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 2147483646) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    return original(pid, signal);
  });
  try {
    await expect(store.lock(id, 'meta', 50)).rejects.toThrow('in-progress');
    expect(kill.mock.calls.every(([pid, signal]) => pid === 2147483646 && signal === 0)).toBe(true);
    expect(statSync(file).ino).toBe(inode); expect(readFileSync(file, 'utf8')).toBe(owner);
  } finally { kill.mockRestore(); }
});

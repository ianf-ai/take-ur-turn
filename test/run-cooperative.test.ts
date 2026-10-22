import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { RunStore, delay, probe, type RunMeta } from '../src/core/run/store.js';
const cli = path.resolve('dist/cli.js'); const exec = promisify(execFile);
const roots: string[] = []; const groups: number[] = []; const views: ChildProcess[] = [];
function root() { const r = mkdtempSync(path.join(os.tmpdir(), 'run-coop-')); roots.push(r); return r; }
function env(r: string) { return { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1' }; }
function invoke(r: string, args: string[]) { return exec(process.execPath, [cli, ...args], { cwd: r, env: env(r), timeout: 18000 }); }
async function until(fn: () => boolean, timeout = 5000) { const end = performance.now() + timeout; while (!fn()) { if (performance.now() > end) throw new Error('condition timed out'); await delay(10); } }
async function start(r: string, code: string) {
  const id = (await invoke(r, ['run', '--', process.execPath, '-e', code])).stdout.trim(); const store = new RunStore(r); const meta = store.read(id); groups.push(meta.pgid);
  const log = () => readFileSync(path.join(store.directory(id), 'log'), 'utf8');
  return { id, store, meta, log };
}
function childPid(log: string): number { return Number(/child-ready=(\d+)/.exec(log)![1]); }
afterEach(async () => {
  for (const v of views.splice(0)) { if (v.exitCode === null) v.kill('SIGINT'); }
  for (const group of groups.splice(0)) { try { process.kill(-group, 'SIGKILL'); } catch {} }
  await delay(180);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it('root SIGINT lets a cooperative agent reap its own detached child; unrelated run stays alive', async () => {
  const r = root(); const other = await start(r, 'setInterval(()=>{},1000)');
  const f = await start(r, `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',"console.log('child-ready='+process.pid); setInterval(()=>{},1000)"],{detached:true,stdio:'inherit'}); process.on('SIGINT',()=>{console.log('root-int'); c.once('exit',()=>{process.stdout.write('reaped-tail🙂'); process.exit(0)}); c.kill('SIGTERM')}); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('child-ready=')); const pid = childPid(f.log()); groups.push(pid);
  const result = await invoke(r, ['stop', f.id]); expect(result.stdout).toContain('cooperative'); expect(probe(pid)).toBe(false); expect(probe(-f.meta.pgid)).toBe(false); expect(probe(-other.meta.pgid)).toBe(true);
  const stop = f.store.read(f.id).stop_request!; expect(stop.signals.map(s => [s.target, s.signal, s.delivery])).toEqual([[f.meta.pid, 'SIGINT', 'sent']]);
  expect(stop.result).toMatchObject({ outcome: 'cooperative', root_exited: true, group_alive: false, descendants_check: 'not-performed' });
  expect((await invoke(r, ['attach', f.id])).stdout).toContain('reaped-tail🙂');
});
it('ignoring root INT waits the full cooperative budget before original-group TERM', async () => {
  const r = root(); const f = await start(r, `process.on('SIGINT',()=>console.log('int-ignored')); console.log('ready'); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('ready'));
  const begin = performance.now(); const result = await invoke(r, ['stop', f.id]); expect(performance.now() - begin).toBeGreaterThanOrEqual(5000);
  expect(result.stdout).toContain('forced-term'); expect(f.log()).toContain('int-ignored');
  expect(f.store.read(f.id).stop_request!.signals.map(s => [s.target, s.signal])).toEqual([[f.meta.pid, 'SIGINT'], [-f.meta.pgid, 'SIGTERM']]);
}, 10000);
it('a root exiting during cooperation leaves time for its original-group child; attach waits and drains child tail', async () => {
  const r = root(); const f = await start(r, `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',"process.on('SIGUSR1',()=>setTimeout(()=>{console.log('child-tail'); process.exit(0)},700)); console.log('child-ready='+process.pid); setInterval(()=>{},1000)"],{stdio:'inherit'}); process.on('SIGINT',()=>{c.kill('SIGUSR1'); process.exit(0)}); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('child-ready='));
  const view = spawn(process.execPath, [cli, 'attach', f.id], { cwd: r, env: env(r), stdio: ['ignore', 'pipe', 'pipe'] }); views.push(view); let output = ''; let ended = false;
  view.stdout!.on('data', chunk => { output += chunk.toString(); }); const viewed = new Promise<number | null>(resolve => view.once('exit', code => { ended = true; resolve(code); }));
  const stopping = invoke(r, ['stop', f.id]);
  await until(() => probe(f.meta.pid) === false); expect(probe(-f.meta.pgid)).toBe(true); expect(f.store.read(f.id).ended_at).toBeUndefined(); expect(ended).toBe(false);
  await stopping; expect(await viewed).toBe(0); expect(output).toContain('child-tail');
  expect(f.store.read(f.id).stop_request!.signals).toHaveLength(1);
});
it('stop CLI exit does not cancel the one accepted request; concurrent/repeated calls share its durable result', async () => {
  const r = root(); const f = await start(r, `let n=0; process.on('SIGINT',()=>{console.log('INT '+(++n)); setTimeout(()=>{console.log('finished'); process.exit(0)},600)}); console.log('ready'); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('ready'));
  const caller = spawn(process.execPath, [cli, 'stop', f.id], { cwd: r, env: env(r), stdio: 'ignore' }); views.push(caller);
  await until(() => f.store.read(f.id).stop_request !== undefined);
  const request = f.store.read(f.id).stop_request!; const gone = new Promise<void>(resolve => caller.once('exit', () => resolve())); caller.kill('SIGTERM'); await gone;
  const shared = await invoke(r, ['stop', f.id]); expect(shared.stdout).toContain('cooperative');
  const final = f.store.read(f.id); expect(final.stop_request!.id).toBe(request.id); expect(final.stopped_at).toBe(request.requested_at); expect(final.stop_request!.signals).toHaveLength(1);
  await invoke(r, ['stop', f.id]); expect(f.store.read(f.id).stop_request).toEqual(final.stop_request); expect(f.log().match(/INT 1/g)).toHaveLength(1);
});
it('uncooperative detached-child counterexample stays externally detectable; output claims only original-group scope', async () => {
  const r = root(); const f = await start(r, `const {spawn}=require('child_process'); spawn(process.execPath,['-e',"console.log('child-ready='+process.pid); setInterval(()=>{},1000)"],{detached:true,stdio:'inherit'}); setInterval(()=>{},1000)`);
  await until(() => f.log().includes('child-ready=')); const pid = childPid(f.log()); groups.push(pid);
  const stopped = await invoke(r, ['stop', f.id]);
  expect(stopped.stdout).toContain('scope=root-and-original-group'); expect(stopped.stdout).toContain('descendants_check=not-performed');
  expect(probe(-f.meta.pgid)).toBe(false); expect(probe(pid)).toBe(true); // deliberate failure-of-containment witness, cleaned only by finally
  expect(f.store.read(f.id).stop_request!.result!.descendants_check).toBe('not-performed');
});

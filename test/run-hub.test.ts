import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/core/hub/server.js';
import { hubCreate, hubDecide, hubRead } from '../src/core/hub/hub-client.js';
import { RunStore, delay, probe } from '../src/core/run/store.js';
const exec = promisify(execFile); const cli = path.resolve('dist/cli.js');
const roots: string[] = []; const cleanup: (() => Promise<unknown>)[] = []; const groups: number[] = [];
function root(): string { const r = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'run-hub-'))); roots.push(r); return r; }
function invoke(r: string, url: string, args: string[]) { return exec(process.execPath, [cli, ...args], { cwd: r, env: { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: url }, timeout: 10000 }); }
afterEach(async () => {
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch {} }
  await delay(200);
  for (const fn of cleanup.splice(0)) await fn();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it('associates closed tasks using include=closed and writes exactly one project stop audit, leaving task records unchanged', async () => {
  const r = root(); const hub = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); cleanup.push(() => hub.close());
  const t = await hubCreate(hub.url, { title: 'closed association', description: 'test', creator: 'fixture', role: 'human' });
  await hubDecide(hub.url, { task_id: t.task_id, decision: 'close', by: 'fixture' });
  const launched = await invoke(r, hub.url, ['run', '--task', t.task_id, '--', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  expect(launched.stderr).toBe('');
  const id = launched.stdout.trim(); const store = new RunStore(r); groups.push(store.read(id).pgid);
  expect(store.read(id).task_id).toBe(t.task_id);
  await invoke(r, hub.url, ['stop', id]); await invoke(r, hub.url, ['stop', id]);
  const audit = await hubRead(hub.url, 'project'); expect(audit.versions).toHaveLength(1);
  expect(audit.versions[0]).toMatchObject({ role: 'human', agent: 'tut', content_type: 'note', payload: { run_id: id, task_id: t.task_id, success: true } });
  expect(audit.versions[0]!.payload.ack).toBeUndefined(); expect(audit.versions[0]!.payload.decision).toBeUndefined(); expect(audit.versions[0]!.payload.launch).toBeUndefined();
  expect((await hubRead(hub.url, t.task_id)).versions).toHaveLength(1);
});
it('foreign Hub cannot receive audit or block local runs/stops', async () => {
  const r = root(); const foreign = root(); const hub = await startServer({ root: path.join(foreign, '.context-hub'), port: 0 }); cleanup.push(() => hub.close());
  const launched = await invoke(r, hub.url, ['run', '--task', 'unverified', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  expect(launched.stderr).toContain('unverified'); const id = launched.stdout.trim(); const store = new RunStore(r); const pgid = store.read(id).pgid; groups.push(pgid);
  const stopped = await invoke(r, hub.url, ['stop', id]); expect(stopped.stderr).toContain('note unconfirmed'); expect(probe(-pgid)).toBe(false);
  await expect(hubRead(hub.url, 'project')).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
});
it('hanging Hub response has bounded impact; ps and attach never contact it', async () => {
  const r = root(); const requests: string[] = [];
  const server = http.createServer((req, _res) => { requests.push(req.url!); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const began = performance.now();
  const launched = await invoke(r, url, ['run', '--task=x', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  expect(performance.now() - began).toBeLessThan(3500); expect(launched.stderr).toContain('unverified');
  const id = launched.stdout.trim(); const store = new RunStore(r); groups.push(store.read(id).pgid);
  const stopped = await invoke(r, url, ['stop', id]); expect(stopped.stderr).toContain('unconfirmed');
  const count = requests.length; await invoke(r, url, ['ps', '--json']); await invoke(r, url, ['attach', id]);
  expect(requests).toHaveLength(count); expect(requests.every(u => u === '/state?include=closed')).toBe(true);
}, 10000);

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, mkdtempSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HeadlessRuntime } from '../src/standalone/launcher-headless/runtime.js';
import { StartRunError } from '../src/core/run/control.js';
import { RunStore, type HeadlessOwnership, type RunMeta } from '../src/core/run/store.js';
import { Store } from '../src/core/hub/store.js';
import { Notifier, type StateResponse } from '../src/core/notifier/notifier.js';
import type { Notification } from '../src/core/common/channels.js';

const START = '2026-01-01T00:00:00.000Z';
const END = '2026-01-01T00:01:00.000Z';
const NOW = Date.parse('2100-01-01T00:00:00.000Z');
const notifiers: Notifier[] = [];
afterEach(async () => { for (const n of notifiers.splice(0)) await n.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tut-w3-'));
  const hub = new Store(path.join(root, '.context-hub'));
  const { task_id: task } = await hub.createTask({ title: 'observation', description: 'isolated fixture', creator: 'test', role: 'human', flow: 'direct' });
  const messages: Notification[] = [], logs: string[] = [];
  const read = vi.fn(async (id: string) => (await hub.readTask(id)).versions);
  const deps = { send: async (m: Notification) => { messages.push(m); }, log: (l: string) => { logs.push(l); }, read };
  const runtime = new HeadlessRuntime(root, deps);
  const append = async (type: string, role = 'executor', payload: Record<string, unknown> = {}) => {
    await hub.append(task, { role, content_type: type, payload: { summary: 'fixture', body: 'fixture', ...payload } });
    return (await hub.readTask(task)).versions.at(-1)!;
  };
  const run = async (patch: { [K in keyof RunMeta]?: RunMeta[K] | undefined } = {}, base = 0, marker = true) => {
    const h: HeadlessOwnership = { schema: 1, role: 'executor', attempt_id: randomUUID(), base_version: base, trigger_version: base, route: { agent: 'codex', args: [] }, route_source: 'task-cast', session_reason: 'fixture' };
    const id = runtime.store.create();
    const meta: RunMeta = { run_id: id, task_id: task, pid: 2147483000, pgid: 2147483000, supervisor_pid: process.pid, argv: ['fixture'], cwd: root, started_at: START, status: 'exited', ended_at: END, exit_code: 0, headless: h };
    for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete meta[key]; else meta[key] = value; }
    await runtime.store.initialize(id, meta);
    closeSync(runtime.store.openLog(id, true));
    if (marker) await append('note', 'human', { launch: { role: meta.headless?.role ?? 'executor', base_version: base, launch_mode: 'headless', attempt_id: meta.headless?.attempt_id } });
    return meta;
  };
  const reasons = (reason: string) => messages.filter(m => m.body.includes(`reason=${reason}`));
  return { root, hub, task, runtime, read, deps, append, run, messages, logs, reasons };
}

describe('successful completion reconciliation', () => {
  it('restores an exit during downtime, retries failed Hub reads without busy or duplicate reads', async () => {
    const f = await fixture(); await f.run();
    f.runtime.restore(); expect(f.runtime.busy(f.task)).toBe(false);
    f.read.mockRejectedValueOnce(new Error('offline'));
    await f.runtime.observe(); expect(f.reasons('stopped-without-publish')).toHaveLength(0);
    await f.runtime.observe(); await f.runtime.observe();
    expect(f.reasons('stopped-without-publish')).toHaveLength(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect((await f.hub.readTask(f.task)).versions).toHaveLength(1);
  });
  it.each(['design', 'code_changes', 'revision', 'review'])('counts same-role %s but not later-round delivery', async type => {
    const f = await fixture(); await f.run(); await f.append(type);
    f.runtime.restore(); await f.runtime.observe(); expect(f.reasons('stopped-without-publish')).toHaveLength(0);
    const g = await fixture(); const first = await g.run();
    await g.run({}, 1); await g.append(type);
    g.runtime.restore(); await g.runtime.observe();
    expect(g.reasons('stopped-without-publish')).toHaveLength(1);
    expect(g.reasons('stopped-without-publish')[0]!.body).toContain(first.run_id);
    expect(g.read).toHaveBeenCalledTimes(1);
  });
  it.each(['note', 'wrong-role', 'old-version'])('does not count %s as this round delivery', async kind => {
    const f = await fixture();
    if (kind === 'old-version') await f.append('code_changes');
    await f.run({}, kind === 'old-version' ? 1 : 0);
    if (kind !== 'old-version') await f.append(kind === 'note' ? 'note' : 'code_changes', kind === 'wrong-role' ? 'reviewer' : 'executor');
    f.runtime.restore(); await f.runtime.observe(); expect(f.reasons('stopped-without-publish')).toHaveLength(1);
  });
  it('uses the same retry path online and does not release a root-exited group early', async () => {
    const f = await fixture(); const m = await f.run({ ended_at: undefined, status: 'running', root_exited_at: END });
    f.runtime.restore(); await f.runtime.observe(); expect(f.runtime.busy(f.task)).toBe(true); expect(f.read).not.toHaveBeenCalled();
    await f.runtime.store.updateMeta(m.run_id, m => ({ ...m, ended_at: END, status: 'exited' }));
    f.read.mockRejectedValueOnce(new Error('offline'));
    await f.runtime.observe(); expect(f.runtime.busy(f.task)).toBe(false);
    await f.runtime.observe(); await f.runtime.observe(); expect(f.reasons('stopped-without-publish')).toHaveLength(1);
  });
  it.each([false, true])('keeps the previous completion check when ownership sync adopts a pending resume (reverse inventory=%s)', async reverse => {
    const f = await fixture();
    const old = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    f.runtime.restore();
    await f.runtime.store.updateMeta(old.run_id, m => ({ ...m, status: 'exited', ended_at: END, exit_code: 0 }));
    const next = f.runtime.store.create();
    await f.runtime.store.writeStartIntent(next, { task_id: f.task, cwd: f.root, startup: 'pending',
      headless: { ...old.headless!, attempt_id: randomUUID(), base_version: 1, trigger_version: 1 } });
    if (reverse) vi.spyOn(f.runtime.store, 'list').mockImplementation(() => [next, old.run_id]);
    f.runtime.syncNew();
    f.read.mockRejectedValueOnce(new Error('offline'));
    await f.runtime.observe();
    expect(f.runtime.busy(f.task)).toBe(true);
    expect(f.reasons('stopped-without-publish')).toHaveLength(0);
    f.runtime.syncNew(); await f.runtime.observe();
    expect(f.reasons('stopped-without-publish')).toHaveLength(1);
    expect(f.reasons('stopped-without-publish')[0]!.body).toContain(old.run_id);
    f.runtime.syncNew(); await f.runtime.observe();
    expect(f.reasons('stopped-without-publish')).toHaveLength(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.runtime.busy(f.task)).toBe(true);
  });
  it.each(['pending', 'running'] as const)('retains completion across a failed old meta read and a new %s seat', async kind => {
    const f = await fixture();
    const old = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    await f.runtime.store.writeStartIntent(old.run_id, { task_id: f.task, cwd: f.root, startup: 'pending', headless: old.headless! });
    f.runtime.restore();
    await f.runtime.store.updateMeta(old.run_id, m => ({ ...m, status: 'exited', ended_at: END, exit_code: 0 }));
    const next = kind === 'pending' ? f.runtime.store.create() : (await f.run({ status: 'running', ended_at: undefined, exit_code: undefined, started_at: END }, 1)).run_id;
    if (kind === 'pending') await f.runtime.store.writeStartIntent(next, { task_id: f.task, cwd: f.root, startup: 'pending',
      headless: { ...old.headless!, attempt_id: randomUUID(), base_version: 1, trigger_version: 1 } });
    vi.spyOn(f.runtime.store, 'list').mockReturnValue([old.run_id, next]);
    const original = f.runtime.store.read.bind(f.runtime.store);
    let failures = 0;
    const read = vi.spyOn(f.runtime.store, 'read').mockImplementation(id => {
      if (id === old.run_id && (kind === 'running' || failures++ === 0)) throw new Error('old meta temporarily unreadable');
      return original(id);
    });
    f.runtime.syncNew();
    await f.runtime.observe();
    expect(f.runtime.busy(f.task)).toBe(true);
    expect(f.reasons('stopped-without-publish')).toHaveLength(kind === 'pending' ? 1 : 0);
    read.mockRestore();
    for (let i = 0; i < 3; i++) { f.runtime.syncNew(); await f.runtime.observe(); }
    expect(f.reasons('stopped-without-publish')).toHaveLength(1);
    expect(f.reasons('stopped-without-publish')[0]!.body).toContain(old.run_id);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.runtime.busy(f.task)).toBe(true);
  });
  it('excludes manual and unsuccessful runs, and reserves a failed notification', async () => {
    const f = await fixture(); await f.run({ headless: undefined }, 0, false); await f.run({ exit_code: 2 });
    f.runtime.restore(); await f.runtime.observe(); expect(f.messages).toHaveLength(0);
    const g = await fixture(); await g.run(); const send = vi.fn(async () => { throw new Error('channel offline'); });
    const cold = new HeadlessRuntime(g.root, { ...g.deps, send }); cold.restore(); await cold.observe(); await cold.observe();
    expect(send).toHaveBeenCalledTimes(1); expect(g.logs.some(l => l.includes('notification failed'))).toBe(true);
  });
});

describe('log mtime silence edges', () => {
  it.each([
    ['success', false], ['success', true],
    ['uncertain', false], ['uncertain', true],
    ['failed', false], ['failed', true],
  ] as const)('keeps local handshake outcome %s authoritative across ownership sync=%s', async (outcome, interleave) => {
    const f = await fixture();
    const headless: HeadlessOwnership = { schema: 1, role: 'executor', attempt_id: randomUUID(), base_version: 0, trigger_version: 0,
      route: { agent: 'codex', args: [] }, route_source: 'task-cast', session_reason: 'fixture' };
    const runtime = new HeadlessRuntime(f.root, { ...f.deps, start: async (store, argv, cwd) => {
      const id = store.create(); closeSync(store.openLog(id, true));
      await store.writeStartIntent(id, { task_id: f.task, headless, cwd, startup: 'pending' });
      if (interleave) runtime.syncNew(); // The start closure still owns an unresolved handshake.
      if (outcome === 'failed') {
        await store.writeStartIntent(id, { task_id: f.task, headless, cwd, startup: 'failed' });
        throw new StartRunError('confirmed spawn failure', id, false);
      }
      await store.initialize(id, { run_id: id, task_id: f.task, headless, status: 'running', started_at: START,
        pid: 2147483000, pgid: 2147483000, supervisor_pid: process.pid, argv, cwd });
      if (interleave) runtime.syncNew(); // Matching metadata does not settle the local IPC handshake.
      if (outcome === 'uncertain') throw new StartRunError('IPC startup acknowledgement was lost', id, true);
      return id;
    } });
    runtime.restore();
    const info = vi.spyOn(runtime.store, 'logInfo');
    runtime.launch({ task_id: f.task, title: f.task, role: 'executor', attempt_id: headless.attempt_id,
      base_version: 0, trigger_version: 0, hubRoot: f.root, routingRoot: f.root, checkoutRoot: f.root,
      hubUrl: 'http://127.0.0.1:1', route: headless.route, route_source: 'task-cast', argv: ['fixture'],
      prompt: 'fixture', env: {}, ownership: headless, target_digest: 'sha256:fixture' });
    await vi.waitFor(() => expect(f.logs.some(l => l.includes(outcome === 'success' ? 'headless started' :
      outcome === 'uncertain' ? 'reason=startup-unconfirmed' : 'reason=spawn-failed'))).toBe(true));
    for (const now of [100, 120, 150]) {
      runtime.syncNew();
      await runtime.observe({ now, stallMs: 10, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    }
    expect(runtime.busy(f.task)).toBe(outcome !== 'failed');
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(outcome === 'success' ? 1 : 0);
    if (outcome !== 'success') expect(info).not.toHaveBeenCalled();
    if (outcome === 'uncertain') expect(f.reasons('startup-unconfirmed')).toHaveLength(1);
  });
  it('observes silence after adopting a real supervisor startup reservation', async () => {
    const control = await import(path.resolve('dist/core/run/control.js')) as typeof import('../src/core/run/control.js');
    const f = await fixture(); f.runtime.restore();
    const headless: HeadlessOwnership = { schema: 1, role: 'executor', attempt_id: randomUUID(), base_version: 0, trigger_version: 0,
      route: { agent: 'codex', args: [] }, route_source: 'task-cast', session_reason: 'fixture' };
    const write = f.runtime.store.writeStartIntent.bind(f.runtime.store);
    vi.spyOn(f.runtime.store, 'writeStartIntent').mockImplementation(async (id, intent) => {
      await write(id, intent);
      f.runtime.syncNew(); // Observe the actual pre-fork reservation window.
      expect(f.runtime.busy(f.task)).toBe(true);
    });
    const id = await control.startRun(f.runtime.store, [process.execPath, '-e',
      "process.on('SIGINT',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000)"], f.root, f.task, { headless });
    try {
      await vi.waitFor(() => {
        const fd = f.runtime.store.openLog(id);
        try { expect(readFileSync(fd, 'utf8')).toContain('ready'); } finally { closeSync(fd); }
      }, { timeout: 3000 });
      expect(f.runtime.store.read(id).control_protocol).toBe('cooperative-v1');
      for (const now of [100, 120, 150]) {
        f.runtime.syncNew();
        await f.runtime.observe({ now, stallMs: 10, tasks: new Map([[f.task, { status: 'implementing' }]]) });
      }
      expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
    } finally {
      expect((await control.stopRun(f.runtime.store, id)).success).toBe(true);
    }
  });
  it.each(['identity', 'supervisor', 'unreadable'] as const)('keeps an adopted reservation unarmed with %s uncertainty', async kind => {
    const f = await fixture(); f.runtime.restore();
    const id = f.runtime.store.create();
    const headless: HeadlessOwnership = { schema: 1, role: 'executor', attempt_id: randomUUID(), base_version: 0, trigger_version: 0,
      route: { agent: 'codex', args: [] }, route_source: 'task-cast', session_reason: 'fixture' };
    await f.runtime.store.writeStartIntent(id, { task_id: f.task, headless, cwd: f.root, startup: 'pending' });
    f.runtime.syncNew();
    closeSync(f.runtime.store.openLog(id, true));
    await f.runtime.store.initialize(id, { run_id: id, task_id: f.task,
      headless: kind === 'identity' ? { ...headless, role: 'reviewer' } : headless,
      status: 'running', started_at: START, pid: 2147483000, pgid: 2147483000,
      supervisor_pid: kind === 'supervisor' ? 2147483001 : process.pid, argv: ['fixture'], cwd: f.root });
    if (kind === 'unreadable') vi.spyOn(f.runtime.store, 'read').mockImplementation(() => { throw new Error('unreadable'); });
    const info = vi.spyOn(f.runtime.store, 'logInfo');
    for (const now of [0, 100, 200]) {
      f.runtime.syncNew();
      await f.runtime.observe({ now, stallMs: 10, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    }
    expect(info).not.toHaveBeenCalled();
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(0);
    expect(f.runtime.busy(f.task)).toBe(true);
  });
  it('arms an adopted pending run only after matching live metadata, and rearms after output', async () => {
    const f = await fixture(); f.runtime.restore();
    const id = f.runtime.store.create();
    const headless: HeadlessOwnership = { schema: 1, role: 'executor', attempt_id: randomUUID(), base_version: 0, trigger_version: 0,
      route: { agent: 'codex', args: [] }, route_source: 'task-cast', session_reason: 'fixture' };
    await f.runtime.store.writeStartIntent(id, { task_id: f.task, headless, cwd: f.root, startup: 'pending' });
    const tick = async (now: number) => {
      f.runtime.syncNew();
      await f.runtime.observe({ now, stallMs: 10, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    };
    await tick(0); await tick(20);
    expect(f.runtime.busy(f.task)).toBe(true);
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(0);
    closeSync(f.runtime.store.openLog(id, true));
    await f.runtime.store.initialize(id, { run_id: id, task_id: f.task, headless, status: 'running', started_at: START,
      pid: 2147483000, pgid: 2147483000, supervisor_pid: process.pid, argv: ['fixture'], cwd: f.root });
    await tick(100); await tick(120); await tick(150);
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
    const fd = f.runtime.store.openLog(id, true); writeFileSync(fd, 'new output'); closeSync(fd);
    utimesSync(path.join(f.runtime.store.directory(id), 'log'), 100, 100);
    await tick(200); await tick(220); await tick(250);
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(2);
  });
  it('samples once per tick; output resets silence, Hub notes do not', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    f.runtime.restore(); const info = vi.spyOn(f.runtime.store, 'logInfo');
    const tick = (now: number) => f.runtime.observe({ now, stallMs: 60_000, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    await tick(0); await tick(59_999); expect(f.reasons('suspected-blocked/silent')).toHaveLength(0);
    await f.append('note'); await tick(60_000); await tick(90_000); expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
    const fd = f.runtime.store.openLog(m.run_id, true); writeFileSync(fd, 'new output'); closeSync(fd);
    utimesSync(path.join(f.runtime.store.directory(m.run_id), 'log'), 100, 100);
    await tick(100_000); await tick(159_999); await tick(160_000); await tick(200_000);
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(2); expect(info).toHaveBeenCalledTimes(8);
    expect(f.read).not.toHaveBeenCalled();
  });
  it('zero means next valid comparison, read failure recovery and restart establish new baselines', async () => {
    const f = await fixture(); await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    f.runtime.restore(); const tick = (now: number, stallMs = 0) => f.runtime.observe({ now, stallMs, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    await tick(0); expect(f.messages).toHaveLength(0); await tick(0); expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
    const spy = vi.spyOn(f.runtime.store, 'logInfo'); spy.mockImplementationOnce(() => { throw new Error('unreadable'); });
    await tick(100); await tick(1_000_000, 100); expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
    await tick(1_000_100, 100); expect(f.reasons('suspected-blocked/silent')).toHaveLength(2);
    const cold = new HeadlessRuntime(f.root, f.deps); cold.restore();
    await cold.observe({ now: 2_000_000, stallMs: 0, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(2);
  });
  it.each(['root-exited', 'closed', 'unknown'])('does not arm for %s', async kind => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined, ...(kind === 'root-exited' ? { root_exited_at: END } : {}) });
    f.runtime.restore();
    if (kind === 'unknown') vi.spyOn(f.runtime.store, 'read').mockImplementation(() => { throw new Error('unknown'); });
    const info = vi.spyOn(f.runtime.store, 'logInfo');
    for (const now of [0, 100, 200]) await f.runtime.observe({ now, stallMs: 0, tasks: new Map([[f.task, { status: kind === 'closed' ? 'closed' : 'implementing' }]]) });
    expect(info).not.toHaveBeenCalled(); expect(f.reasons('suspected-blocked/silent')).toHaveLength(0); expect(m.run_id).toBeTruthy();
  });
  it('active stop and completed stop never produce silence or successful-exit diagnostics', async () => {
    const f = await fixture();
    const stop = { id: 'a'.repeat(32), requested_at: END, requested_by: 'fixture', phase: 'requested' as const, signals: [] };
    const m = await f.run({ control_protocol: 'cooperative-v1', stopped_at: END, stopped_by: 'fixture', stop_request: stop, status: 'stopped', ended_at: undefined });
    f.runtime.restore(); const info = vi.spyOn(f.runtime.store, 'logInfo');
    for (const now of [0, 100]) await f.runtime.observe({ now, stallMs: 0, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    expect(f.runtime.busy(f.task)).toBe(true);
    await f.runtime.store.updateMeta(m.run_id, meta => ({ ...meta, ended_at: END, stop_request: { ...stop, phase: 'completed', result: { outcome: 'cooperative', success: true, completed_at: END, root_exited: true, group_alive: false, scope: 'root-and-original-group', descendants_check: 'not-performed' } } }));
    await f.runtime.observe(); const cold = new HeadlessRuntime(f.root, f.deps); cold.restore(); await cold.observe();
    expect(f.runtime.busy(f.task)).toBe(false); expect(info).not.toHaveBeenCalled(); expect(f.messages).toHaveLength(0);
  });
  it('a missing log is diagnosed and restoring the ordinary file starts a new silence baseline', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const log = path.join(f.runtime.store.directory(m.run_id), 'log'); f.runtime.restore();
    const tick = (now: number) => f.runtime.observe({ now, stallMs: 100, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    await tick(0); renameSync(log, `${log}.saved`);
    await tick(1000); expect(f.reasons('suspected-blocked/silent')).toHaveLength(0);
    expect(f.logs.some(l => l.includes('headless log observation failed') && l.includes('ENOENT'))).toBe(true);
    renameSync(`${log}.saved`, log); await tick(2000); await tick(2099);
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(0);
    await tick(2100); expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
  });
  it.skipIf(process.platform === 'win32')('FIFO without a writer is rejected within a bounded child; other tasks still compare and launch', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const log = path.join(f.runtime.store.directory(m.run_id), 'log');
    renameSync(log, `${log}.original`); // Preserve the original isolated log.
    execFileSync('mkfifo', [log]);
    // A synchronous open regression must time out only this child, never Vitest.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [root, task, id] = process.argv.slice(1);
      process.env.TUT_HUB_ROOT = root;
      process.env.TUT_PROJECT_ROOT = root;
      const { RunStore } = await import(pathToFileURL(path.resolve('dist/core/run/store.js')));
      const { Store } = await import(pathToFileURL(path.resolve('dist/core/hub/store.js')));
      const { Notifier } = await import(pathToFileURL(path.resolve('dist/core/notifier/notifier.js')));
      const { HeadlessRuntime } = await import(pathToFileURL(path.resolve('dist/standalone/launcher-headless/runtime.js')));
      const store = new RunStore(root), hub = new Store(path.join(root, '.context-hub'));
      let rejected = '';
      try { store.logInfo(id); } catch (e) { rejected = e.message; }
      const logs = [], messages = []; let launches = 0;
      const read = async id => (await hub.readTask(id)).versions;
      const runtime = new HeadlessRuntime(root, { read, log: l => logs.push(l), send: async m => messages.push(m) });
      const row = (task_id, version) => ({ task_id, title: task_id, version, status: 'implementing', waiting_for: 'agent:executor', needs_attention: false, updated_at: new Date().toISOString() });
      const tasks = [row(task, 1)];
      const n = new Notifier({ url: 'http://127.0.0.1:1', eventPort: 1, interval: 5, stallTimeoutMin: 0 }, {
        headlessRuntime: runtime, fetchState: async () => ({ flow_mode: 'auto', auto: { launch_roles: ['executor'] }, tasks }),
        readLog: read, readLaunchMode: async () => 'tui', resolveTarget: async () => process.execPath,
        listAnchorPanes: async () => [{ pane_id: 'fixture:anchor', label: 'tut-hub', workspace_id: 'fixture', cwd: root }],
        loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
        launch: async () => { launches++; return 'launched'; },
        markLaunched: async (task, role, base) => hub.append(task, { role: 'human', content_type: 'note', payload: { summary: 'fixture', body: 'fixture', launch: { role, base_version: base } } }),
        channelsFor: () => [{ name: 'fixture', send: async m => messages.push(m) }],
        log: l => logs.push(l), relayHostStatus: async () => {},
      });
      await n.requestCompare();
      const other = await hub.createTask({ title: 'other', description: 'fixture', creator: 'test', role: 'human', flow: 'direct' });
      tasks.push(row(other.task_id, 0));
      await n.requestCompare();
      for (let i = 0; i < 20 && launches === 0; i++) await new Promise(r => setTimeout(r, 5));
      await n.close();
      console.log(JSON.stringify({ rejected, logs, messages, launches }));
    `, f.root, f.task, m.run_id], { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' });
    const result = JSON.parse(output);
    expect(result.rejected).toContain('not a regular run file');
    expect(result.logs.filter((l: string) => l.includes('headless log observation failed') && l.includes('not a regular'))).toHaveLength(2);
    expect(result.messages.some((m: Notification) => m.body.includes('reason=suspected-blocked/silent'))).toBe(false);
    expect(result.launches).toBe(1);
  });
  it('RunStore rejects a symlink and a non-regular log without reading content', async () => {
    const f = await fixture(); const id = f.runtime.store.create();
    symlinkSync('/dev/null', path.join(f.runtime.store.directory(id), 'log'));
    expect(() => f.runtime.store.logInfo(id)).toThrow();
    const id2 = f.runtime.store.create();
    const { mkdirSync } = await import('node:fs'); mkdirSync(path.join(f.runtime.store.directory(id2), 'log'));
    expect(() => f.runtime.store.logInfo(id2)).toThrow('not a regular');
  });
});

async function notifierFixture(f: Awaited<ReturnType<typeof fixture>>) {
  vi.stubEnv('TUT_HUB_ROOT', f.root);
  let version = (await f.hub.readTask(f.task)).versions.length;
  let mode: 'headless' | 'tui' = 'headless', present = true, now = NOW;
  const state = (): StateResponse => ({ flow_mode: 'manual', tasks: present ? [{ task_id: f.task, title: f.task, version, status: 'implementing', waiting_for: 'agent:executor', needs_attention: false, updated_at: String(version) }] : [], degraded: present ? [] : [f.task] });
  const read = vi.fn(async (id: string) => (await f.hub.readTask(id)).versions);
  const launch = vi.fn(async () => 'launched');
  const n = new Notifier({ url: 'http://127.0.0.1:1', eventPort: 1, interval: 5, stallTimeoutMin: 30 }, {
    headlessRuntime: f.runtime, fetchState: async () => state(), readLog: read, readLaunchMode: async () => mode,
    loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }), now: () => now,
    channelsFor: () => [{ name: 'fixture', send: f.deps.send }], log: f.deps.log, launch, relayHostStatus: async () => {},
  }); notifiers.push(n);
  return { n, read, launch, tick: () => n.requestCompare(), version: (v: number) => { version = v; }, mode: (m: typeof mode) => { mode = m; }, present: (v: boolean) => { present = v; }, now: (v: number) => { now = v; } };
}

describe('delivery timeline and Notifier version intervals', () => {
  it('alerts once for late delivery, excludes note/decision and caps reads at the state version', async () => {
    const f = await fixture(); await f.run(); const h = await notifierFixture(f); await h.tick();
    await f.append('note', 'human'); await f.append('decision', 'human', { decision: 'approve' }); const delivery = await f.append('code_changes');
    h.version(delivery.version - 1); await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(0);
    h.version(delivery.version); await h.tick(); await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(1);
    expect(h.read).toHaveBeenCalledTimes(2); expect(h.launch).not.toHaveBeenCalled();
  });
  it('retains a failed read interval and resets on mode change, disappearance and rollback', async () => {
    const f = await fixture(); await f.run(); const h = await notifierFixture(f); await h.tick();
    const r = await f.append('code_changes'); h.version(r.version); h.read.mockRejectedValueOnce(new Error('Hub offline'));
    await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(0); await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(1);
    for (const reset of ['mode', 'missing', 'rollback']) {
      if (reset === 'mode') { h.mode('tui'); await h.tick(); }
      if (reset === 'missing') { h.present(false); await h.tick(); }
      if (reset === 'rollback') { h.version(0); await h.tick(); }
      const later = await f.append('revision'); h.version(later.version); h.mode('headless'); h.present(true);
      if (reset === 'rollback') { // A rewind establishes a baseline at 0; a new version after it is a genuine new edge.
        h.version(0); await h.tick(); h.present(false); await h.tick(); h.present(true); h.version(later.version);
      }
      await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(1);
    }
  });
  it('retains a delivery interval when run metadata is temporarily unreadable', async () => {
    const f = await fixture(); await f.run(); const h = await notifierFixture(f); await h.tick();
    const r = await f.append('code_changes'); h.version(r.version);
    // Fail the whole poll: ownership sync and delivery inventory both read metadata.
    const read = vi.spyOn(f.runtime.store, 'read').mockImplementation(() => { throw new Error('run unreadable'); });
    await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(0);
    read.mockRestore();
    await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(1);
    await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(1);
  });
  it.each([false, true])('online completed run retains the delivery interval across observe read failure=%s', async fail => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const h = await notifierFixture(f); await h.tick();
    await f.runtime.store.updateMeta(m.run_id, meta => ({ ...meta, ended_at: END, status: 'exited', exit_code: 0 }));
    const r = await f.append('code_changes'); h.version(r.version);
    const read = fail ? vi.spyOn(f.runtime.store, 'read').mockImplementation(() => { throw new Error('observe temporarily unreadable'); }) : undefined;
    await h.tick();
    expect(f.runtime.busy(f.task)).toBe(fail);
    expect(f.reasons('ghost-delivery')).toHaveLength(fail ? 0 : 1);
    if (fail) expect(h.read).not.toHaveBeenCalled();
    read?.mockRestore();
    await h.tick(); await h.tick();
    expect(f.runtime.busy(f.task)).toBe(false); expect(f.reasons('ghost-delivery')).toHaveLength(1);
    expect(h.read).toHaveBeenCalledTimes(1); // no new version or quiet full pulls needed
  });
  it('defers active and unknown runs without repeatedly pulling Hub history, then checks the retained upper bound', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const h = await notifierFixture(f); await h.tick();
    const normal = await f.append('code_changes'); h.version(normal.version);
    await h.tick(); await h.tick();
    const readMeta = vi.spyOn(f.runtime.store, 'read').mockImplementationOnce(() => { throw new Error('unknown'); });
    await h.tick(); readMeta.mockRestore();
    expect(f.reasons('ghost-delivery')).toHaveLength(0); expect(h.read).not.toHaveBeenCalled();
    await f.runtime.store.updateMeta(m.run_id, meta => ({ ...meta, ended_at: normal.timestamp, status: 'exited', exit_code: 0 }));
    await new Promise(resolve => setTimeout(resolve, 2));
    const late = await f.append('revision');
    await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(0);
    h.version(late.version); await h.tick(); await h.tick();
    expect(f.reasons('ghost-delivery')).toHaveLength(1); expect(h.read).toHaveBeenCalledTimes(2);
  });
  it('publish then exit in one observation window is covered (including equal boundaries)', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const h = await notifierFixture(f); await h.tick(); const r = await f.append('code_changes');
    await f.runtime.store.updateMeta(m.run_id, meta => ({ ...meta, started_at: r.timestamp, ended_at: r.timestamp, status: 'exited', exit_code: 0 }));
    h.version(r.version); await h.tick(); expect(f.reasons('ghost-delivery')).toHaveLength(0); expect(f.reasons('stopped-without-publish')).toHaveLength(0);
  });
  it.each([{ role: 'executor' }, { role: 'executor', base_version: 1 }, { role: 'executor', base_version: 1, launch_mode: 'tui' }])('does not look past a newer legacy/TUI marker %j', async launch => {
    const f = await fixture(); await f.run(); await f.append('code_changes');
    const h = await notifierFixture(f); await h.tick();
    await f.append('note', 'human', { launch }); const r = await f.append('revision'); h.version(r.version); await h.tick();
    expect(f.reasons('ghost-delivery')).toHaveLength(0);
  });
  it('unknown inventory and malformed timestamps cannot establish absence', async () => {
    const f = await fixture(); await f.run(); f.runtime.restore(); const r = await f.append('code_changes');
    const records = (await f.hub.readTask(f.task)).versions;
    await f.runtime.reconcileDeliveries(f.task, records.map(x => x === records.at(-1) ? { ...x, timestamp: 'bad' } : x), 1, r.version, NOW);
    const spy = vi.spyOn(f.runtime.store, 'read').mockImplementation(() => { throw new Error('unreadable'); });
    await expect(f.runtime.reconcileDeliveries(f.task, records, 1, r.version, NOW)).rejects.toThrow('unreadable'); spy.mockRestore();
    expect(f.reasons('ghost-delivery')).toHaveLength(0); expect(f.logs.filter(l => l.includes('unknown'))).toHaveLength(2);
  });
  it('Hub notes renew only stall, output renews only silence in the same Notifier poll', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const h = await notifierFixture(f); await h.tick();
    h.now(NOW + 1_800_000); const note = await f.append('note'); h.version(note.version); await h.tick();
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(1); expect(f.messages.filter(m => m.title.includes('stalled'))).toHaveLength(0);
    utimesSync(path.join(f.runtime.store.directory(m.run_id), 'log'), 123, 123);
    h.now(NOW + 3_600_000); await h.tick();
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(1); expect(f.messages.filter(m => m.title.includes('stalled'))).toHaveLength(1);
  });
  it.each(['tui', 'manual', 'foreign'])('24h pure %s task has no reconciliation false positives', async kind => {
    const f = await fixture();
    if (kind === 'manual') await f.run({ headless: undefined }, 0, false);
    if (kind === 'foreign') {
      const other = await fixture(); const m = await other.run();
      await f.append('note', 'human', { launch: { role: 'executor', base_version: 0, launch_mode: 'headless', attempt_id: m.headless!.attempt_id } });
    }
    const h = await notifierFixture(f); if (kind === 'tui') h.mode('tui'); await h.tick();
    for (let step = 1; step <= 17_280; step++) {
      h.now(NOW + step * 5000);
      if (step % 4320 === 0) { const r = await f.append('revision'); h.version(r.version); }
      await h.tick();
    }
    expect(f.reasons('stopped-without-publish')).toHaveLength(0); expect(f.reasons('ghost-delivery')).toHaveLength(0);
    expect(f.messages.some(m => m.title.includes('stalled'))).toBe(true); expect(h.launch).not.toHaveBeenCalled();
  }, 30_000);
  it('24h hermetic five-second observation: TUI, legacy, manual, foreign rig and mixed rounds have zero reconciliation false positives', async () => {
    // Real Store/RunStore fixtures; synthetic clock, not a live 24h soak.
    const f = await fixture(); await f.run({ ended_at: '2099-01-01T00:00:00Z' }); await f.append('code_changes');
    const h = await notifierFixture(f); h.mode('tui'); await h.tick();
    const foreignRoot = mkdtempSync(path.join(os.tmpdir(), 'tut-w3-foreign-')); const foreign = new RunStore(foreignRoot);
    const foreignId = foreign.create(); const own = f.runtime.runs()[0]!;
    await foreign.initialize(foreignId, { ...own, run_id: foreignId, headless: { ...own.headless!, attempt_id: randomUUID() } });
    const foreignAttempt = foreign.read(foreignId).headless!.attempt_id;
    for (let step = 1; step <= 17_280; step++) {
      h.now(NOW + step * 5000);
      if (step % 2880 === 0) {
        const phase = step / 2880;
        h.mode(phase === 1 ? 'tui' : 'headless');
        if (phase === 2) await f.append('note', 'human', { launch: { role: 'executor', base_version: (await f.hub.readTask(f.task)).versions.length } }); // legacy
        if (phase === 3) await f.append('note', 'human', { launch: { role: 'executor', base_version: (await f.hub.readTask(f.task)).versions.length, launch_mode: 'headless', attempt_id: foreignAttempt } });
        if (phase === 4) await f.run({ headless: undefined }, 0, false); // manual run proves no headless identity
        if (phase === 5) h.mode('tui');
        if (phase === 6) h.mode('headless');
        const r = await f.append('revision'); h.version(r.version);
      }
      await h.tick();
    }
    expect(f.reasons('stopped-without-publish')).toHaveLength(0); expect(f.reasons('ghost-delivery')).toHaveLength(0);
    expect(f.messages.some(m => m.title.includes('stalled'))).toBe(true); // channels remain live
    expect(h.launch).not.toHaveBeenCalled();
  }, 30_000);
});

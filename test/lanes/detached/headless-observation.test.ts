import { START, END, NOW, fixture, notifierFixture, windowsInventory } from '../../helpers/headless-observation.js';
import { describe, expect, it, vi } from 'vitest';
import { closeSync, lstatSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HeadlessRuntime } from '../../../src/standalone/launcher-detached/runtime.js';
import { HubError } from '../../../src/hub/hub-client.js';
import { StartRunError } from '../../../src/core/run/control.js';
import { RunStore, type HeadlessOwnership, type RunMeta } from '../../../src/core/run/store.js';
import type { Notification } from '../../../src/core/common/channels.js';


/** Fault injection models the metadata contract on both native transports. */
function metaReadFault(store: RunStore, reader: (id: string) => RunMeta, once = false) {
  const read = vi.spyOn(store, 'read');
  if (once) read.mockImplementationOnce(reader); else read.mockImplementation(reader);
  const batch = vi.spyOn(store, 'readManyMetas').mockImplementation(ids => ids.map(id => {
    try { return { id, kind: 'meta' as const, meta: store.read(id) }; }
    catch (error) { return { id, kind: 'error' as const, error: error as NodeJS.ErrnoException, origin: 'file' as const }; }
  }));
  return { mockRestore() { batch.mockRestore(); read.mockRestore(); } };
}

function completionView(f: { task: string }, status = 'implementing') {
  return { now: NOW, stallMs: 60_000, completeView: true, tasks: new Map([[f.task, { status }]]) };
}

describe('successful completion reconciliation', () => {
  it('restores an exit during downtime, retries failed Hub reads without busy or duplicate reads', async () => {
    const f = await fixture(); await f.run();
    f.runtime.restore(); expect(f.runtime.busy(f.task)).toBe(false);
    f.read.mockRejectedValueOnce(new Error('offline'));
    await f.runtime.observe(completionView(f)); expect(f.diagnostics('stopped-without-publish')).toHaveLength(0);
    await f.runtime.observe(completionView(f)); await f.runtime.observe(completionView(f));
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect((await f.hub.readTask(f.task)).versions).toHaveLength(1);
  });
  it.each(['design', 'code_changes', 'revision', 'review'])('counts same-role %s but not later-round delivery', async type => {
    const f = await fixture(); await f.run(); await f.append(type);
    f.runtime.restore(); await f.runtime.observe(completionView(f)); expect(f.diagnostics('stopped-without-publish')).toHaveLength(0);
    const g = await fixture(); const first = await g.run();
    await g.run({}, 1); await g.append(type);
    g.runtime.restore(); await g.runtime.observe(completionView(g));
    expect(g.diagnostics('stopped-without-publish')).toHaveLength(1);
    expect(g.diagnostics('stopped-without-publish')[0]!.body).toContain(first.run_id);
    expect(g.read).toHaveBeenCalledTimes(1);
  });
  it.each(['note', 'wrong-role', 'old-version'])('does not count %s as this round delivery', async kind => {
    const f = await fixture();
    if (kind === 'old-version') await f.append('code_changes');
    await f.run({}, kind === 'old-version' ? 1 : 0);
    if (kind !== 'old-version') await f.append(kind === 'note' ? 'note' : 'code_changes', kind === 'wrong-role' ? 'reviewer' : 'executor');
    f.runtime.restore(); await f.runtime.observe(completionView(f)); expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
  });
  it('uses the same retry path online and does not release a root-exited group early', async () => {
    const f = await fixture(); const m = await f.run({ ended_at: undefined, status: 'running', root_exited_at: END });
    f.runtime.restore(); await f.runtime.observe(completionView(f)); expect(f.runtime.busy(f.task)).toBe(true); expect(f.read).not.toHaveBeenCalled();
    await f.runtime.store.updateMeta(m.run_id, m => ({ ...m, ended_at: END, status: 'exited' }));
    f.read.mockRejectedValueOnce(new Error('offline'));
    await f.runtime.observe(completionView(f)); expect(f.runtime.busy(f.task)).toBe(false);
    await f.runtime.observe(completionView(f)); await f.runtime.observe(completionView(f)); expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
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
    await f.runtime.observe(completionView(f));
    expect(f.runtime.busy(f.task)).toBe(true);
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(0);
    f.runtime.syncNew(); await f.runtime.observe(completionView(f));
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
    expect(f.diagnostics('stopped-without-publish')[0]!.body).toContain(old.run_id);
    f.runtime.syncNew(); await f.runtime.observe(completionView(f));
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
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
    const read = metaReadFault(f.runtime.store, id => {
      if (id === old.run_id && (kind === 'running' || failures++ === 0)) throw new Error('old meta temporarily unreadable');
      return original(id);
    });
    f.runtime.syncNew();
    await f.runtime.observe(completionView(f));
    expect(f.runtime.busy(f.task)).toBe(true);
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(kind === 'pending' ? 1 : 0);
    read.mockRestore();
    for (let i = 0; i < 3; i++) { f.runtime.syncNew(); await f.runtime.observe(completionView(f)); }
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
    expect(f.diagnostics('stopped-without-publish')[0]!.body).toContain(old.run_id);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.runtime.busy(f.task)).toBe(true);
  });
  it('excludes manual and unsuccessful runs, and reserves a failed report', async () => {
    const f = await fixture(); await f.run({ headless: undefined }, 0, false); await f.run({ exit_code: 2 });
    f.runtime.restore(); await f.runtime.observe(completionView(f)); expect(f.messages).toHaveLength(0);
    const g = await fixture(); await g.run();
    const log = vi.fn((line: string) => { g.logs.push(line); if (line.includes('reason=stopped-without-publish')) throw new Error('report offline'); });
    const cold = new HeadlessRuntime(g.root, { ...g.deps, log }); cold.restore(); await cold.observe(completionView(g)); await cold.observe(completionView(g));
    expect(g.diagnostics('stopped-without-publish')).toHaveLength(1);
    expect(g.logs.some(l => l.includes('notification failed'))).toBe(true);
    expect(g.messages).toEqual([]);
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
    await vi.waitFor(() => expect(f.logs.some(l => l.includes(outcome === 'success' ? 'detached started' :
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
    const control = await import(path.resolve('dist/core/run/control.js')) as typeof import('../../../src/core/run/control.js');
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
      "process.on('SIGINT',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000);setTimeout(()=>process.exit(124),120000).unref()"], f.root, f.task, { headless });
    try {
      await vi.waitFor(() => {
        const fd = f.runtime.store.openLog(id);
        try { expect(readFileSync(fd, 'utf8')).toContain('ready'); } finally { closeSync(fd); }
      }, { timeout: 3000 });
      expect(f.runtime.store.read(id).control_protocol).toBe(process.platform === 'win32' ? 'windows-console-v1' : 'cooperative-v1');
      for (const now of [100, 120, 150]) {
        f.runtime.syncNew();
        await f.runtime.observe({ now, stallMs: 10, tasks: new Map([[f.task, { status: 'implementing' }]]) });
      }
      expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
    } finally {
      expect((await control.stopRun(f.runtime.store, id)).success).toBe(true);
    }
  }, process.platform === 'win32' ? 90000 : 5000);
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
    if (kind === 'unreadable') metaReadFault(f.runtime.store, () => { throw new Error('unreadable'); });
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
    utimesSync(f.runtime.store.logPath(id), 100, 100);
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
    utimesSync(f.runtime.store.logPath(m.run_id), 100, 100);
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
    if (kind === 'unknown') metaReadFault(f.runtime.store, () => { throw new Error('unknown'); });
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
    const log = f.runtime.store.logPath(m.run_id); f.runtime.restore();
    const tick = (now: number) => f.runtime.observe({ now, stallMs: 100, tasks: new Map([[f.task, { status: 'implementing' }]]) });
    await tick(0); renameSync(log, `${log}.saved`);
    await tick(1000); expect(f.reasons('suspected-blocked/silent')).toHaveLength(0);
    expect(f.logs.some(l => l.includes('detached log observation failed') && l.includes('ENOENT'))).toBe(true);
    renameSync(`${log}.saved`, log); await tick(2000); await tick(2099);
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(0);
    await tick(2100); expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
  });
  it.skipIf(process.platform === 'win32')('FIFO without a writer is rejected within a bounded child; other tasks still compare and launch', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const log = f.runtime.store.logPath(m.run_id);
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
      const { Store } = await import(pathToFileURL(path.resolve('dist/hub/store.js')));
      const { Notifier } = await import(pathToFileURL(path.resolve('dist/core/notifier/notifier.js')));
      const { HeadlessRuntime } = await import(pathToFileURL(path.resolve('dist/standalone/launcher-detached/runtime.js')));
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
    expect(result.logs.filter((l: string) => l.includes('detached log observation failed') && l.includes('not a regular'))).toHaveLength(1);
    expect(result.messages.some((m: Notification) => m.body.includes('reason=suspected-blocked/silent'))).toBe(false);
    expect(result.launches).toBe(1);
  });
  it('RunStore rejects a symlink and a non-regular log without reading content', async () => {
    const f = await fixture(); const id = f.runtime.store.create();
    const target = path.join(f.root, 'real-log-target'); writeFileSync(target, 'must not be observed');
    const linked = f.runtime.store.logPath(id); symlinkSync(target, linked);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(() => f.runtime.store.logInfo(id)).toThrow();
    const id2 = f.runtime.store.create();
    const { mkdirSync } = await import('node:fs'); mkdirSync(f.runtime.store.logPath(id2));
    expect(() => f.runtime.store.logInfo(id2)).toThrow('not a regular');
  });
});

describe('delivery timeline and Notifier version intervals', () => {
  it('alerts once for late delivery, excludes note/decision and caps reads at the state version', async () => {
    const f = await fixture(); await f.run(); const h = await notifierFixture(f); await h.tick();
    await f.append('note', 'human'); await f.append('decision', 'human', { decision: 'approve' }); const delivery = await f.append('code_changes');
    h.version(delivery.version - 1); await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(0);
    h.version(delivery.version); await h.tick(); await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(1);
    expect(h.read).toHaveBeenCalledTimes(2); expect(h.launch).not.toHaveBeenCalled();
  });
  it('retains a failed read interval and resets on mode change, disappearance and rollback', async () => {
    const f = await fixture(); await f.run(); const h = await notifierFixture(f); await h.tick();
    const r = await f.append('code_changes'); h.version(r.version); h.read.mockRejectedValueOnce(new Error('Hub offline'));
    await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(0); await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(1);
    for (const reset of ['mode', 'missing', 'rollback']) {
      if (reset === 'mode') { h.mode('tui'); await h.tick(); }
      if (reset === 'missing') { h.present(false); await h.tick(); }
      if (reset === 'rollback') { h.version(0); await h.tick(); }
      const later = await f.append('revision'); h.version(later.version); h.mode('detached'); h.present(true);
      if (reset === 'rollback') { // A rewind establishes a baseline at 0; a new version after it is a genuine new edge.
        h.version(0); await h.tick(); h.present(false); await h.tick(); h.present(true); h.version(later.version);
      }
      await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(1);
    }
  });
  it('retains a delivery interval when run metadata is temporarily unreadable', async () => {
    const f = await fixture(); await f.run(); const h = await notifierFixture(f); await h.tick();
    const r = await f.append('code_changes'); h.version(r.version);
    // Fail the whole poll: ownership sync and delivery inventory both read metadata.
    const read = metaReadFault(f.runtime.store, () => { throw new Error('run unreadable'); });
    for (let i=0; i<5; i++) await h.tick();
    expect(f.diagnostics('ghost-delivery')).toHaveLength(0);
    expect(f.logs.filter(line => line.includes('delivery observation unknown'))).toHaveLength(1);
    expect(f.logs.filter(line => line.includes('delivery context check failed'))).toHaveLength(0);
    read.mockRestore();
    await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(1);
    await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(1);
  });
  it.each([false, true])('online completed run retains the delivery interval across observe read failure=%s', async fail => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const h = await notifierFixture(f); await h.tick();
    await f.runtime.store.updateMeta(m.run_id, meta => ({ ...meta, ended_at: END, status: 'exited', exit_code: 0 }));
    const r = await f.append('code_changes'); h.version(r.version);
    const read = fail ? metaReadFault(f.runtime.store, () => { throw new Error('observe temporarily unreadable'); }) : undefined;
    await h.tick();
    expect(f.runtime.busy(f.task)).toBe(fail);
    expect(f.diagnostics('ghost-delivery')).toHaveLength(fail ? 0 : 1);
    if (fail) expect(h.read).not.toHaveBeenCalled();
    read?.mockRestore();
    await h.tick(); await h.tick();
    expect(f.runtime.busy(f.task)).toBe(false); expect(f.diagnostics('ghost-delivery')).toHaveLength(1);
    expect(h.read).toHaveBeenCalledTimes(1); // no new version or quiet full pulls needed
  });
  it('defers active and unknown runs without repeatedly pulling Hub history, then checks the retained upper bound', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const h = await notifierFixture(f); await h.tick();
    const normal = await f.append('code_changes'); h.version(normal.version);
    await h.tick(); await h.tick();
    const readMeta = metaReadFault(f.runtime.store, () => { throw new Error('unknown'); }, true);
    await h.tick(); readMeta.mockRestore();
    expect(f.diagnostics('ghost-delivery')).toHaveLength(0); expect(h.read).not.toHaveBeenCalled();
    await f.runtime.store.updateMeta(m.run_id, meta => ({ ...meta, ended_at: normal.timestamp, status: 'exited', exit_code: 0 }));
    await new Promise(resolve => setTimeout(resolve, 2));
    const late = await f.append('revision');
    await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(0);
    h.version(late.version); await h.tick(); await h.tick();
    expect(f.diagnostics('ghost-delivery')).toHaveLength(1); expect(h.read).toHaveBeenCalledTimes(2);
  });
  it('publish then exit in one observation window is covered (including equal boundaries)', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const h = await notifierFixture(f); await h.tick(); const r = await f.append('code_changes');
    await f.runtime.store.updateMeta(m.run_id, meta => ({ ...meta, started_at: r.timestamp, ended_at: r.timestamp, status: 'exited', exit_code: 0 }));
    h.version(r.version); await h.tick(); expect(f.diagnostics('ghost-delivery')).toHaveLength(0); expect(f.diagnostics('stopped-without-publish')).toHaveLength(0);
  });
  it.each([{ role: 'executor' }, { role: 'executor', base_version: 1 }, { role: 'executor', base_version: 1, launch_mode: 'tui' }])('does not look past a newer legacy/TUI marker %j', async launch => {
    const f = await fixture(); await f.run(); await f.append('code_changes');
    const h = await notifierFixture(f); await h.tick();
    await f.append('note', 'human', { launch }); const r = await f.append('revision'); h.version(r.version); await h.tick();
    expect(f.diagnostics('ghost-delivery')).toHaveLength(0);
  });
  it('unknown inventory and malformed timestamps cannot establish absence', async () => {
    const f = await fixture(); await f.run(); f.runtime.restore(); const r = await f.append('code_changes');
    const records = (await f.hub.readTask(f.task)).versions;
    await f.runtime.reconcileDeliveries(f.task, records.map(x => x === records.at(-1) ? { ...x, timestamp: 'bad' } : x), 1, r.version, NOW);
    const spy = metaReadFault(f.runtime.store, () => { throw new Error('unreadable'); });
    await expect(f.runtime.reconcileDeliveries(f.task, records, 1, r.version, NOW)).rejects.toThrow('unreadable'); spy.mockRestore();
    expect(f.diagnostics('ghost-delivery')).toHaveLength(0); expect(f.logs.filter(l => l.includes('unknown'))).toHaveLength(2);
  });
  it('Hub notes renew only stall, output renews only silence in the same Notifier poll', async () => {
    const f = await fixture(); const m = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined });
    const h = await notifierFixture(f); await h.tick();
    h.now(NOW + 1_800_000); const note = await f.append('note'); h.version(note.version); await h.tick();
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(1); expect(f.messages.filter(m => m.title.includes('stalled'))).toHaveLength(0);
    utimesSync(f.runtime.store.logPath(m.run_id), 123, 123);
    h.now(NOW + 3_600_000); await h.tick();
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(1); expect(f.messages.filter(m => m.title.includes('stalled'))).toHaveLength(1);
  });

});

describe('repeated missing run diagnostics preserve observation work', () => {
  it('retries every poll, emits only first/summary/recovery, and reports a new run or cause immediately', async () => {
    const f = await fixture(); await f.run(); const delivery = await f.append('revision');
    let now = NOW;
    const runtime = new HeadlessRuntime(f.root, { ...f.deps, now: () => now });
    runtime.restore();
    let cause = 'missing run-a';
    const batch = vi.spyOn(runtime.store, 'readManyMetas').mockImplementation(ids => ids.map(id => ({
      id, kind: 'error' as const, origin: 'file' as const, error: new Error(cause),
    })));
    const records = (await f.hub.readTask(f.task)).versions;
    for (let poll = 0; poll <= 60; poll++) {
      now = NOW + poll * 5000;
      await expect(runtime.reconcileDeliveries(f.task, records, 1, delivery.version, now)).rejects.toThrow(cause);
    }
    expect(batch).toHaveBeenCalledTimes(61);
    const failed = () => f.logs.filter(line => line.includes('delivery observation unknown'));
    expect(failed()).toHaveLength(2);
    expect(failed()[1]).toContain('diagnostic=summary');
    expect(failed()[1]).toContain('count=61');
    cause = 'missing run-b';
    await expect(runtime.reconcileDeliveries(f.task, records, 1, delivery.version, now)).rejects.toThrow(cause);
    expect(failed().at(-1)).toContain(cause);
    cause = 'permission run-b';
    await expect(runtime.reconcileDeliveries(f.task, records, 1, delivery.version, now)).rejects.toThrow(cause);
    expect(failed().at(-1)).toContain(cause);
    expect(f.messages).toHaveLength(0);
    batch.mockRestore();
    await runtime.reconcileDeliveries(f.task, records, 1, delivery.version, now);
    expect(failed().at(-1)).toContain('diagnostic=recovered');
    expect((await f.hub.readTask(f.task)).versions).toEqual(records);
    expect(runtime.busy(f.task)).toBe(false);
  });
});
import {stopAfterInputFailure} from '../../../src/core/run/input-stop.js';
import {StopController} from '../../../src/core/run/stop-controller.js';
describe('input failure is independent of the root exit observation',()=>{
  it.skipIf(process.platform==='win32').each([false,true])('reports once when input settles after exit zero (observe before stop=%s)',async observeBeforeStop=>{
    const f=await fixture();
    const initial=await f.run({status:'running',ended_at:undefined,exit_code:undefined,input_delivery:{status:'pending',bytes:10}});
    f.runtime.restore();
    await f.runtime.store.updateMeta(initial.run_id,m=>({...m,root_exited_at:END,exit_code:0}));
    await f.runtime.observe();expect(f.messages).toEqual([]);
    await f.runtime.store.updateMeta(initial.run_id,m=>({...m,input_delivery:{status:'failed',bytes:10,error:'input EPIPE after root exit'}}));
    if(observeBeforeStop){await f.runtime.observe();await f.runtime.observe();}
    await stopAfterInputFailure(f.runtime.store,initial.run_id,initial);
    const controller=new StopController(f.runtime.store,initial,()=>({code:0,signal:null}),{kill:()=>{throw Object.assign(Error('gone'),{code:'ESRCH'});}});
    await controller.step();
    const stopped=f.runtime.store.read(initial.run_id);
    expect(stopped.stop_request?.result).toMatchObject({success:true,outcome:'already-ended'});
    expect(stopped.input_delivery?.status).toBe('failed');
    await f.runtime.observe();await f.runtime.observe();
    expect(f.runtime.busy(f.task)).toBe(false);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.title).toContain('give-up');
    expect(f.messages[0]!.body).toContain('input EPIPE after root exit');
    expect(f.reasons('input-failed')).toHaveLength(1);
    expect(f.diagnostics('stopped-without-publish')).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
  });
});

describe('persistent completion consumption', () => {
  it('keeps run archives byte-for-byte after real prune and restarts with a smaller quiet baseline', async () => {
    const f = await fixture(); const run = await f.run();
    await f.append('decision', 'human', { decision: 'close' });
    const metaFile = path.join(f.runtime.store.directory(run.run_id), 'meta.json');
    const beforeMeta = readFileSync(metaFile), beforeLog = readFileSync(f.runtime.store.logPath(run.run_id));
    const { Notifier } = await import('../../../src/core/notifier/notifier.js');
    const { startServer } = await import('../../../src/hub/server.js');
    const server = await startServer({ root: path.join(f.root, '.context-hub'), port: 0 });
    vi.stubEnv('TUT_HUB_ROOT', f.root);
    const make = () => new Notifier({ url: server.url, eventPort: 1, interval: 5, stallTimeoutMin: 30 }, {
      headlessRuntime: new HeadlessRuntime(f.root, f.deps),
      fetchState: async url => (await fetch(url)).json() as Promise<import('../../../src/core/notifier/notifier.js').StateResponse>, readLog: f.read, readLaunchMode: async () => 'detached', now: () => NOW,
      loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
      channelsFor: () => [{ name: 'fixture', send: f.deps.send }], log: f.deps.log, relayHostStatus: async () => {},
    });
    const online = make();
    try {
      await online.requestCompare(); expect(f.logs.some(line => line.includes('baseline: 1 task(s)'))).toBe(true);
      const result = await fetch(`${server.url}/prune`, { method: 'POST', body: JSON.stringify({ task_id: f.task, by: 'test', reason: 'fixture disposal' }) });
      expect(result.status).toBe(200);
      await online.requestCompare(); await online.requestCompare();
      for (let restart = 0; restart < 2; restart++) {
        const notifier = make();
        try { await notifier.requestCompare(); await notifier.requestCompare(); }
        finally { await notifier.close(); }
      }
      expect(f.logs.filter(line => line.includes('baseline: 0 task(s)'))).toHaveLength(2);
      expect(f.logs.filter(line => /stopped-without-publish|incomplete-unreadable|task not found|completion context check failed/.test(line))).toEqual([]);
      expect(f.messages).toEqual([]); expect(f.read).not.toHaveBeenCalled();
      expect(readFileSync(metaFile)).toEqual(beforeMeta); expect(readFileSync(f.runtime.store.logPath(run.run_id))).toEqual(beforeLog);
    } finally { await online.close(); await server.close(); }
  });

  it('silences 83 closed and 7 missing histories through four independent Notifiers', async () => {
    const f = await fixture();
    const closed: string[] = [];
    for (let i = 0; i < 28; i++) {
      const task = await f.hub.createTask({ title: `closed-${i}`, description: 'fixture', creator: 'test', role: 'human', flow: 'direct' });
      await f.hub.append(task.task_id, { role: 'human', content_type: 'decision', payload: { summary: 'close', body: 'fixture', decision: 'close' } });
      closed.push(task.task_id);
    }
    const histories: RunMeta[] = [];
    for (let i = 0; i < 90; i++) histories.push(await f.run({ task_id: i < 83 ? closed[i % 28]! : `missing-${i % 3}` }, 0, false));
    const active = await f.run(); await f.append('code_changes');
    const before = histories.map(m => ({ meta: readFileSync(path.join(f.runtime.store.directory(m.run_id), 'meta.json'), 'utf8'), log: readFileSync(f.runtime.store.logPath(m.run_id), 'utf8') }));
    const records = await Promise.all(closed.map(id => f.hub.readTask(id)));
    const state = { flow_mode: 'manual', truncated: false, tasks: [...closed.map(task_id => ({ task_id, title: task_id, version: 1, status: 'closed' as const, waiting_for: 'none', needs_attention: false, updated_at: END })),
      { task_id: f.task, title: f.task, version: 2, status: 'implementing' as const, waiting_for: 'agent:executor', needs_attention: false, updated_at: END }], degraded: ['degraded-fixture'] };
    const { Notifier } = await import('../../../src/core/notifier/notifier.js');
    vi.stubEnv('TUT_HUB_ROOT', f.root);
    for (let restart = 0; restart < 4; restart++) {
      const runtime = new HeadlessRuntime(f.root, f.deps);
      const n = new Notifier({ url: 'http://127.0.0.1:1', eventPort: 1, interval: 5, stallTimeoutMin: 30 }, {
        headlessRuntime: runtime, fetchState: async url => { expect(url).toContain('include=closed'); return state; },
        readLog: f.read, readLaunchMode: async () => 'detached', now: () => NOW,
        loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
        channelsFor: () => [{ name: 'echo', send: async m => { f.logs.push(`[task] ${m.title}: ${m.body}`); f.messages.push(m); } }],
        log: f.deps.log, relayHostStatus: async () => {},
      });
      try { for (let poll = 0; poll < 5; poll++) await n.requestCompare(); }
      finally { await n.close(); }
      expect(runtime.store.readCompletionCheck(active)?.outcome).toBe('delivered');
    }
    expect(f.logs.filter(l => /stopped-without-publish|completion context check failed/.test(l))).toEqual([]);
    expect(f.messages.filter(m => m.title.includes('detached diagnostic'))).toEqual([]);
    expect(f.read.mock.calls.every(([id]) => id === f.task)).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(1);
    for (const [i, m] of histories.entries()) {
      expect(readFileSync(path.join(f.runtime.store.directory(m.run_id), 'meta.json'), 'utf8')).toBe(before[i]!.meta);
      expect(readFileSync(f.runtime.store.logPath(m.run_id), 'utf8')).toBe(before[i]!.log);
      expect(f.runtime.store.readCompletionCheck(m)?.outcome).toBe(i < 83 ? 'ignored-closed' : undefined);
    }
    expect(await Promise.all(closed.map(id => f.hub.readTask(id)))).toEqual(records);
  });

  it.each(['delivered', 'missing', 'report-failed'] as const)('does not read or report a consumed %s run after rebuilding', async kind => {
    const f = await fixture(); const m = await f.run();
    if (kind === 'delivered') await f.append('code_changes');
    const send = vi.fn(f.deps.send);
    const log = (line: string) => { f.logs.push(line); if (kind === 'report-failed' && line.includes('reason=stopped-without-publish')) throw new Error('offline report'); };
    for (let i = 0; i < 4; i++) {
      const runtime = new HeadlessRuntime(f.root, { ...f.deps, send, log }); runtime.restore();
      await runtime.observe(completionView(f)); await runtime.observe(completionView(f));
    }
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(kind === 'delivered' ? 0 : 1);
    const saved = new RunStore(f.root).readCompletionCheck(m)!;
    expect(saved.outcome).toBe(kind === 'delivered' ? 'delivered' : 'missing-delivery-notification-reserved');
    expect(saved).toMatchObject({ run_id: m.run_id, task_id: f.task, attempt_id: m.headless!.attempt_id, role: 'executor', base_version: 0, ended_at: END });
    if (kind === 'delivered') expect(saved.delivery_version).toBe(2);
  });

  it('keeps absence, degraded and incomplete snapshots pending and resumes on a trustworthy active view', async () => {
    const f = await fixture(); const m = await f.run(); f.runtime.restore();
    for (let i = 0; i < 5; i++) {
      await f.runtime.observe();
      await f.runtime.observe({ ...completionView(f), completeView: false });
      await f.runtime.observe({ ...completionView(f), tasks: new Map() });
      await f.runtime.observe({ ...completionView(f, 'closed'), degraded: new Set([f.task]) });
    }
    expect(f.read).not.toHaveBeenCalled(); expect(f.logs).toEqual([]);
    expect(f.runtime.store.readCompletionCheck(m)).toBeUndefined();
    await f.runtime.observe(completionView(f));
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
  });

  it('quietly defers structured TASK_NOT_FOUND races, but retains bounded diagnostics for other Hub faults', async () => {
    const f = await fixture(); const m = await f.run(); f.runtime.restore();
    f.read.mockRejectedValue(new HubError('TASK_NOT_FOUND', 'gone'));
    for (let i = 0; i < 10; i++) await f.runtime.observe(completionView(f));
    expect(f.logs).toEqual([]); expect(f.runtime.store.readCompletionCheck(m)).toBeUndefined();
    // A message substring must not classify an unrelated error as task absence.
    f.read.mockRejectedValue(new HubError('HUB_TIMEOUT', 'TASK_NOT_FOUND is just text'));
    for (let i = 0; i < 5; i++) await f.runtime.observe(completionView(f));
    expect(f.logs.filter(l => l.includes('completion context check failed'))).toHaveLength(1);
    f.read.mockImplementation(async id => (await f.hub.readTask(id)).versions);
    await f.runtime.observe(completionView(f));
    expect(f.runtime.store.readCompletionCheck(m)?.outcome).toBe('missing-delivery-notification-reserved');
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
  });

  it('uses a newly read close even when the state view is stale', async () => {
    const f = await fixture(); const m = await f.run();
    await f.append('decision', 'human', { decision: 'close' });
    f.runtime.restore(); await f.runtime.observe(completionView(f));
    expect(f.messages).toEqual([]); expect(f.runtime.store.readCompletionCheck(m)?.outcome).toBe('ignored-closed');
  });

  it('does not send before a failed result write, recovers storage, and admits a separate attempt', async () => {
    const f = await fixture(); const old = await f.run(); f.runtime.restore();
    const claim = vi.spyOn(f.runtime.store, 'claimCompletionCheck').mockRejectedValue(new Error('disk full'));
    await f.runtime.observe(completionView(f)); await f.runtime.observe(completionView(f));
    expect(f.messages).toEqual([]); expect(f.runtime.busy(f.task)).toBe(false);
    expect(f.runtime.store.readCompletionCheck(old)).toBeUndefined();
    claim.mockRestore(); await f.runtime.observe(completionView(f));
    const next = await f.run({}, 1);
    const cold = new HeadlessRuntime(f.root, f.deps); cold.restore(); await cold.observe(completionView(f));
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(2);
    expect(new RunStore(f.root).readCompletionCheck(next)?.attempt_id).toBe(next.headless!.attempt_id);
  });

  it('allows only one of two simultaneous runtime consumers to report', async () => {
    const f = await fixture(); const m = await f.run();
    const a = new HeadlessRuntime(f.root, f.deps), b = new HeadlessRuntime(f.root, f.deps);
    a.restore(); b.restore();
    await Promise.all([a.observe(completionView(f)), b.observe(completionView(f))]);
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
    expect(new RunStore(f.root).readCompletionCheck(m)?.outcome).toBe('missing-delivery-notification-reserved');
  });

  it('serializes reservations across processes and survives disappearance before reporting', async () => {
    const f = await fixture(); const m = await f.run();
    const { spawn } = await import('node:child_process');
    const code = `
      const { RunStore } = await import('./dist/core/run/store.js');
      const s = new RunStore(process.argv[1]); const m = s.read(process.argv[2]);
      const won = await s.claimCompletionCheck(m, { outcome: 'missing-delivery-notification-reserved' });
      process.stdout.write(JSON.stringify(won));
      process.exit(0); // Simulate loss before emitting the diagnostic report.
    `;
    const child = () => new Promise<boolean>((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', code, f.root, m.run_id], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error = ''; p.stdout.on('data', data => { output += data; }); p.stderr.on('data', data => { error += data; });
      p.on('error', reject); p.on('exit', exit => exit === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
    });
    expect((await Promise.all([child(), child()])).sort()).toEqual([false, true]);
    const cold = new HeadlessRuntime(f.root, f.deps); cold.restore(); await cold.observe(completionView(f));
    expect(f.read).not.toHaveBeenCalled(); expect(f.messages).toEqual([]);
  });

  it.each(['json', 'schema', 'identity', 'ended', 'outcome'] as const)('preserves a corrupt %s sidecar while other tasks continue', async kind => {
    const f = await fixture(); const bad = await f.run();
    await f.runtime.store.claimCompletionCheck(bad, { outcome: 'missing-delivery-notification-reserved' });
    const file = path.join(f.runtime.store.directory(bad.run_id), 'completion-check.json');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (kind === 'schema') value.schema = 2;
    if (kind === 'identity') value.attempt_id = randomUUID();
    if (kind === 'ended') value.ended_at = START;
    if (kind === 'outcome') value.outcome = 'unknown';
    const raw = kind === 'json' ? '{' : JSON.stringify(value); writeFileSync(file, raw);
    const other = await f.hub.createTask({ title: 'other', description: 'fixture', creator: 'test', role: 'human', flow: 'direct' });
    const good = await f.run({ task_id: other.task_id }, 0, false);
    f.runtime.restore(); const view = completionView(f); view.tasks.set(other.task_id, { status: 'implementing' });
    await f.runtime.observe(view); await f.runtime.observe(view);
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
    expect(f.diagnostics('stopped-without-publish')[0]!.task_id).toBe(other.task_id);
    expect(f.read.mock.calls.map(([id]) => id)).toEqual([other.task_id]);
    expect(f.runtime.store.readCompletionCheck(good)?.outcome).toBe('missing-delivery-notification-reserved');
    await expect(f.runtime.store.claimCompletionCheck(bad, { outcome: 'ignored-closed' })).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('refuses sidecar links and non-regular files without retiring evidence', async () => {
    const f = await fixture(); const a = await f.run(), b = await f.run();
    const target = path.join(f.root, 'target'); writeFileSync(target, 'keep');
    const linked = path.join(f.runtime.store.directory(a.run_id), 'completion-check.json'); symlinkSync(target, linked);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(f.runtime.store.directory(b.run_id), 'completion-check.json'));
    f.runtime.restore(); await f.runtime.observe(completionView(f));
    expect(f.read).not.toHaveBeenCalled(); expect(f.messages).toEqual([]);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true); expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(() => f.runtime.store.readCompletionCheck({ ...a, run_id: '../escape' })).toThrow('invalid run-id');
  });

  it('refuses changed completion facts under the write lock and treats read failures as pending', async () => {
    const f = await fixture(); const m = await f.run();
    await f.runtime.store.updateMeta(m.run_id, current => ({ ...current, ended_at: START }));
    await expect(f.runtime.store.claimCompletionCheck(m, { outcome: 'ignored-closed' })).rejects.toThrow('identity changed');
    f.runtime.restore();
    const read = vi.spyOn(f.runtime.store, 'readCompletionCheck').mockImplementation(() => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); });
    await f.runtime.observe(completionView(f)); expect(f.read).not.toHaveBeenCalled(); expect(f.messages).toEqual([]);
    read.mockRestore(); await f.runtime.observe(completionView(f)); expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
  });
});

describe('completion filtering preserves other observation mechanisms', () => {
  it('a consumed history does not suppress run-unconfirmed, nonzero give-up, silence or stall', async () => {
    const f = await fixture(); const history = await f.run();
    await f.runtime.store.claimCompletionCheck(history, { outcome: 'ignored-closed' });
    const live = await f.run({ status: 'running', ended_at: undefined, exit_code: undefined }, 1);
    const h = await notifierFixture(f); await h.tick();
    h.now(NOW + 1_800_000); await h.tick();
    expect(f.reasons('suspected-blocked/silent')).toHaveLength(1);
    expect(f.messages.filter(m => m.title.includes('stalled'))).toHaveLength(1);
    await f.runtime.store.updateMeta(live.run_id, m => ({ ...m, supervisor_pid: 2147483001 }));
    await h.tick(); expect(f.diagnostics('run-unconfirmed')).toHaveLength(1);
    await f.runtime.store.updateMeta(live.run_id, m => ({ ...m, root_exited_at: END, ended_at: END, status: 'exited', exit_code: 2 }));
    await h.tick(); expect(f.reasons('root-failed')).toHaveLength(1);
    expect(f.messages.some(m => m.title.includes('give-up'))).toBe(true);
    expect(f.diagnostics('stopped-without-publish')).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
  });

  it('a failed /state suspends completion checks until a successful complete snapshot', async () => {
    const f = await fixture(); const m = await f.run();
    const { Notifier } = await import('../../../src/core/notifier/notifier.js');
    vi.stubEnv('TUT_HUB_ROOT', f.root); let offline = true; let truncated: boolean | undefined;
    const n = new Notifier({ url: 'http://127.0.0.1:1', eventPort: 1, interval: 5, stallTimeoutMin: 30 }, {
      headlessRuntime: f.runtime, fetchState: async () => {
        if (offline) throw new Error('state unavailable');
        return { flow_mode: 'manual', ...(truncated !== undefined ? { truncated } : {}), tasks: [{ task_id: f.task, title: f.task, status: 'implementing', waiting_for: 'agent:executor', needs_attention: false, updated_at: END }] };
      },
      readLog: f.read, readLaunchMode: async () => 'detached', now: () => NOW,
      loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
      channelsFor: () => [{ name: 'fixture', send: f.deps.send }], log: f.deps.log, relayHostStatus: async () => {},
    });
    try {
      for (let i = 0; i < 3; i++) await n.requestCompare();
      expect(f.read).not.toHaveBeenCalled(); expect(f.runtime.store.readCompletionCheck(m)).toBeUndefined();
      offline = false; await n.requestCompare();
      truncated = true; await n.requestCompare();
      expect(f.read).not.toHaveBeenCalled(); expect(f.runtime.store.readCompletionCheck(m)).toBeUndefined();
      truncated = false; await n.requestCompare(); expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
    } finally { await n.close(); }
  });

  it('a persisted completion does not disarm another task launch working-timeout', async () => {
    const f = await fixture(); const history = await f.run();
    await f.runtime.store.claimCompletionCheck(history, { outcome: 'ignored-closed' });
    const { Notifier } = await import('../../../src/core/notifier/notifier.js');
    const { normalizeAgentRoute } = await import('../../../src/protocol/agent-command.js');
    const { posixDirectPlanFor } = await import('../../../src/core/launcher/target-resolver.js');
    vi.stubEnv('TUT_HUB_ROOT', f.root);
    let tasks: import('../../../src/core/notifier/notifier.js').StateTask[] = [];
    const launch = vi.fn(async () => 'launched');
    vi.useFakeTimers();
    const n = new Notifier({ url: 'http://127.0.0.1:1', eventPort: 1, interval: 5, stallTimeoutMin: 30, workingTimeoutSec: 5 }, {
      headlessRuntime: f.runtime, fetchState: async () => ({ flow_mode: 'auto', auto: { launch_roles: ['executor'] }, tasks }),
      readLog: async () => [], readLaunchMode: async () => 'tui', readLaunchCatchup: async () => 'off', now: () => NOW,
      resolveTargetWithSource: async () => ({ route: 'pi', source: 'builtin-default', plan: { platform: 'posix', posix_direct: posixDirectPlanFor(normalizeAgentRoute('pi'), process.env) } }),
      listAnchorPanes: async () => [{ pane_id: 'anchor', label: 'tut-hub', cwd: f.root, workspace_id: 'fixture' }],
      loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
      markLaunched: async () => ({ version: 1 }), launch,
      channelsFor: () => [{ name: 'fixture', send: f.deps.send }], log: f.deps.log, relayHostStatus: async () => {},
    });
    try {
      await n.requestCompare();
      tasks = [{ task_id: 'watch', title: 'watch', status: 'implementing', waiting_for: 'agent:executor', needs_attention: false, updated_at: END }];
      await n.requestCompare(); expect(launch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.logs.some(l => l.includes('launch working timeout'))).toBe(true);
      expect(f.messages.some(m => m.title.includes('no working signal'))).toBe(true);
      expect(f.runtime.store.readCompletionCheck(history)?.outcome).toBe('ignored-closed');
    } finally { await n.close(); vi.useRealTimers(); }
  });
});

describe('diagnostic output hygiene', () => {
  it('emits one report line and no channel echo beside quarantined archives across restarts', async () => {
    const f = await fixture();
    await f.run();
    const broken = f.runtime.store.create();
    writeFileSync(path.join(f.runtime.store.directory(broken), 'meta.json'), JSON.stringify({ pid: 2147483000, pgid: 2147483000, status: 'exited' }));
    const { repairRun } = await import('../../../src/core/run/repair.js');
    expect((await repairRun(f.runtime.store, broken)).disposition).toBe('quarantined');
    const record = await f.append('code_changes');
    const records = (await f.hub.readTask(f.task)).versions;
    f.deps.send = async message => { f.messages.push(message); f.logs.push(`${message.title}: ${message.body}`); };
    for (let restart = 0; restart < 3; restart++) {
      const runtime = new HeadlessRuntime(f.root, { ...f.deps, now: () => NOW + restart * 1000 });
      runtime.restore();
      await runtime.reconcileDeliveries(f.task, records, 1, record.version, NOW);
      await runtime.reconcileDeliveries(f.task, records, 1, record.version, NOW);
    }
    expect(f.diagnostics('ghost-delivery')).toHaveLength(1);
    expect(f.logs.filter(l => l.includes('reason=ghost-delivery'))).toHaveLength(1);
    expect(f.messages).toEqual([]);
    expect(f.logs.some(l => l.includes('detached diagnostic'))).toBe(false);
    expect(f.logs.filter(l => /delivery observation unknown|delivery-inventory|ENOENT/.test(l))).toEqual([]);
    expect(f.runtime.store.isQuarantined(broken)).toBe(true);
  });
  it('still reports genuine unreadable runs once, without assigning them to an observed task', async () => {
    const f = await fixture(); await f.run();
    const broken = f.runtime.store.create();
    const record = await f.append('revision');
    const records = (await f.hub.readTask(f.task)).versions;
    for (let restart = 0; restart < 3; restart++) {
      const runtime = new HeadlessRuntime(f.root, { ...f.deps, now: () => NOW + restart * 1000 });
      runtime.restore();
      await expect(runtime.reconcileDeliveries(f.task, records, 1, record.version, NOW)).rejects.toThrow('ENOENT');
    }
    const failures = f.logs.filter(l => l.includes('delivery observation unknown'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`run_id=${broken}`);
    expect(failures[0]).not.toContain(`task=${f.task}`);
    expect(f.messages).toEqual([]);
  });
  it('logs a stopped-without-publish diagnostic without a channel echo', async () => {
    const f = await fixture(); await f.run();
    f.deps.send = async message => { f.messages.push(message); f.logs.push(`${message.title}: ${message.body}`); };
    f.runtime.restore();
    await f.runtime.observe(completionView(f));
    await f.runtime.observe(completionView(f));
    expect(f.diagnostics('stopped-without-publish')).toHaveLength(1);
    expect(f.logs.filter(l => l.includes('reason=stopped-without-publish'))).toHaveLength(1);
    expect(f.messages).toEqual([]);
  });
});

describe('Windows delivery inventory transport', () => {
  it('keeps healthy runs batched and classifies only failed slots without hiding real faults', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await f.run();
    f.runtime.restore();
    const record = await f.append('code_changes');
    const records = (await f.hub.readTask(f.task)).versions;
    const disposition = vi.spyOn(f.runtime.store, 'isQuarantined');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    windowsInventory.enabled = true; windowsInventory.single = 0; windowsInventory.batch = 0;
    try {
      // Real Windows branch, with only native file transport replaced by
      // filesystem-backed counters. This is not a Windows native smoke.
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await f.runtime.reconcileDeliveries(f.task, records, 0, record.version, NOW);
      expect(windowsInventory).toMatchObject({ single: 0, batch: 1 });
      expect(disposition).not.toHaveBeenCalled();
      const isolated = f.runtime.store.create();
      writeFileSync(path.join(f.runtime.store.directory(isolated), 'meta.json.broken'), '{preserved');
      await f.runtime.reconcileDeliveries(f.task, records, 0, record.version, NOW);
      expect(windowsInventory).toMatchObject({ single: 0, batch: 2 });
      expect(disposition).toHaveBeenLastCalledWith(isolated);
      expect(f.logs.filter(l => /delivery observation unknown|ENOENT/.test(l))).toEqual([]);
      const broken = f.runtime.store.create();
      writeFileSync(path.join(f.runtime.store.directory(broken), 'meta.json'), '{damaged');
      writeFileSync(path.join(f.runtime.store.directory(broken), 'meta.json.broken'), '{old marker');
      await expect(f.runtime.reconcileDeliveries(f.task, records, 0, record.version, NOW)).rejects.toThrow();
      expect(windowsInventory).toMatchObject({ single: 1, batch: 3 });
      const failures = f.logs.filter(l => l.includes('delivery observation unknown'));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(`run_id=${broken}`);
      expect(failures[0]).not.toContain(`task=${f.task}`);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      windowsInventory.enabled = false;
    }
  });
});

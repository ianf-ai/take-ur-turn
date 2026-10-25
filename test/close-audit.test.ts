import { stopWindowsFixtureRuns } from './helpers/run-cleanup.js';
import { writeNodeExecutable } from './helpers/executable.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore, type HeadlessOwnership } from '../src/core/run/store.js';
import { startRun, stopRun } from '../src/core/run/control.js';
import { HeadlessRuntime } from '../src/standalone/launcher-headless/runtime.js';
import { createHeadlessRevalidate } from '../src/core/notifier/notifier.js';
import { effectiveCloseDecisionVersion, closeStopAuditId, hasCloseStopAudit } from '../src/core/run/close-audit.js';
import type { ContextRecord } from '../src/core/common/types.js';
import { startServer, type RunningServer } from '../src/core/hub/server.js';
import { hubCreate, hubRead, hubPublish, hubDecide } from '../src/core/hub/hub-client.js';

// Source modules exercise policy; the actual detached supervisor is the built
// same-package module used in installed execution (never a PATH tut).
const builtControl = await import(path.resolve('dist/core/run/control.js')) as typeof import('../src/core/run/control.js');

const roots: string[] = []; const servers: RunningServer[] = []; const groups: number[] = [];
afterEach(async () => {
  const ownedRoots = roots.splice(0);
  try { if (process.platform === 'win32') await stopWindowsFixtureRuns(ownedRoots); }
  finally {
  for (const g of groups.splice(0)) { if(process.platform!=='win32')try { process.kill(-g, 'SIGKILL'); } catch { /* reaped */ } }
  for (const s of servers.splice(0)) await s.close();
  }
});
function root(): string { const r = mkdtempSync(path.join(os.tmpdir(), 'tut-close-audit-')); roots.push(r); return r; }
async function until(fn: () => boolean, ms = process.platform === 'win32' ? 45000 : 8000): Promise<void> { const end = performance.now() + ms; while (!fn()) { if (performance.now() > end) throw new Error('condition timed out'); await new Promise(r => setTimeout(r, 25)); } }
function fixtureAgent(r: string): string {
  const bin = path.join(r, 'bin'); mkdirSync(bin, { recursive: true });
  return writeNodeExecutable(path.join(bin, 'codex'), process.platform === 'win32' ? 'setTimeout(()=>{},120000)' : 'setTimeout(()=>{},30000)');
}

function heldAgent(r: string, name: string) {
  const releaseFile = path.join(r, name + '-release');
  const agent = writeNodeExecutable(path.join(r, name), `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)}))process.exit(0)},20);setTimeout(()=>process.exit(124),120000).unref()`);
  return { agent, release: () => writeFileSync(releaseFile, '') };
}

function ownership(role: string, taskId: string): HeadlessOwnership {
  return { schema: 1, role, attempt_id: crypto.randomUUID(), base_version: 1, trigger_version: 1,
    route: { agent: 'codex', args: [] }, route_source: 'task-cast', session_reason: 'fixture' };
}

async function spawnManaged(store: RunStore, agent: string, cwd: string, taskId: string, role: string): Promise<string> {
  const id = await builtControl.startRun(store, [agent, 'sleep', '30'], cwd, taskId, { headless: ownership(role, taskId) });
  groups.push(store.read(id).pgid);
  return id;
}

describe('the effective close version is the one that CLOSED the task', () => {
  function decision(version: number): ContextRecord { return { version, task_id: 't', role: 'human', content_type: 'decision', timestamp: 't', payload: { summary: 's', body: 'b', decision: 'close', by: 'test-user' } }; }
  function note(version: number): ContextRecord { return { version, task_id: 't', role: 'human', content_type: 'note', timestamp: 't', payload: { summary: 's', body: 'b' } }; }
  it('the FIRST close wins; later idempotent closes and notes never displace it', () => {
    expect(effectiveCloseDecisionVersion([decision(2)])).toBe(2);
    expect(effectiveCloseDecisionVersion([decision(2), note(3), decision(5), note(6), decision(9)])).toBe(2);
    expect(effectiveCloseDecisionVersion([note(1)])).toBeUndefined();
  });
  it('audit_id and dedup stay stable across later repeated closes', () => {
    const input = { task_id: 't', close_version: effectiveCloseDecisionVersion([decision(2), note(3), decision(5)])!, run: { run_id: 'r1' } };
    const auditId = closeStopAuditId(input);
    expect(auditId).toBe('close-stop:v2:r1');
    const laterView = [decision(2), note(3), decision(5), note(7)];
    const rederived = closeStopAuditId({ ...input, close_version: effectiveCloseDecisionVersion(laterView)! });
    expect(rederived).toBe(auditId);
    const auditNote: ContextRecord = { version: 8, task_id: 't', role: 'human', content_type: 'note', timestamp: 't', payload: { summary: 's', body: 'b', operation: 'close-stop', audit_id: auditId } };
    expect(hasCloseStopAudit(laterView.concat([auditNote]), auditId)).toBe(true);
  });
  it('real Hub: a repeated close keeps the audit pinned to the first close', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'two closes', description: 'b', creator: 'test-user', role: 'executor' });
    await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
    const firstClose = effectiveCloseDecisionVersion((await hubRead(server.url, created.task_id)).versions);
    expect(firstClose).toBeDefined();
    await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'someone-else' });
    const agent = fixtureAgent(r);
    const runId = await spawnManaged(store, agent, r, created.task_id, 'executor');
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      stop: builtControl.stopRun, send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url,
    });
    runtime.restore();
    runtime.closeTask(created.task_id); // no explicit version — derived from the log
    await until(() => store.read(runId).ended_at !== undefined);
    await until(() => logs.some(l => l.includes('close-stop audit')));
    const after = await hubRead(server.url, created.task_id);
    const audits = after.versions.filter(v => (v.payload as { operation?: string }).operation === 'close-stop');
    expect(audits).toHaveLength(1);
    expect((audits[0]!.payload as { close_version?: number }).close_version).toBe(firstClose);
    expect((audits[0]!.payload as { ref_version?: number }).ref_version).toBe(firstClose);
  });
});

describe('close-stop audit (real Hub integration)', () => {
  it('cooperative stop publishes an audited note with the close version, run facts, and no state change', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'close audit task', description: 'body', creator: 'test-user', role: 'executor' });
    await hubPublish(server.url, { task_id: created.task_id, role: 'executor', content_type: 'code_changes', payload: { summary: 's', body: 'b', commits: ['a1b2c3d'] } });
    await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
    const closeVersion = (await hubRead(server.url, created.task_id)).versions
      .filter(v => v.content_type === 'decision' && (v.payload as { decision?: string }).decision === 'close')
      .reduce((max, v) => Math.max(max, v.version), 0);
    const agent = fixtureAgent(r);
    const runId = await spawnManaged(store, agent, r, created.task_id, 'executor');

    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      start: builtControl.startRun, stop: builtControl.stopRun,
      send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions,
      hubUrl: server.url,
    });
    runtime.restore();
    expect(runtime.busy(created.task_id)).toBe(true);
    runtime.closeTask(created.task_id, closeVersion);
    await until(() => store.read(runId).ended_at !== undefined);
    await until(() => logs.some(l => l.includes('close-stop audit') && l.includes('recorded at v')));

    const after = await hubRead(server.url, created.task_id);
    expect(after.status).toBe('closed');
    const audit = after.versions.filter(v => v.role === 'human' && (v.payload as { operation?: string }).operation === 'close-stop');
    expect(audit).toHaveLength(1);
    const payload = audit[0]!.payload as Record<string, unknown>;
    expect(payload.run_id).toBe(runId);
    expect(payload.close_version).toBe(closeVersion);
    expect(payload.stop_success).toBe(true);
    expect(payload.scope).toBe(process.platform === 'win32' ? 'root-and-owned-job' : 'root-and-original-group');
    expect(payload.descendants_check).toBe(process.platform === 'win32' ? 'job-members-only' : 'not-performed');
    expect(payload.ref_version).toBe(closeVersion);
    expect(audit[0]!.agent).toBe('tut');
    expect(audit[0]!.content_type).toBe('note');
    // No decision/ack/launch was manufactured and the task stays closed.
    expect(after.versions.some(v => v.content_type === 'decision' && v.version > closeVersion)).toBe(false);
    expect((await hubRead(server.url, created.task_id)).status).toBe('closed');
  });

  it('a double observation neither double-stops nor double-audits (dedup by audit_id)', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'dedup', description: 'b', creator: 'test-user', role: 'executor' });
    await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
    const agent = fixtureAgent(r);
    const runId = await spawnManaged(store, agent, r, created.task_id, 'executor');
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      stop: builtControl.stopRun, send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url,
    });
    runtime.restore();
    runtime.closeTask(created.task_id);
    await until(() => store.read(runId).ended_at !== undefined);
    await until(() => logs.some(l => l.includes('close-stop audit')));
    // Second observation of the same close: deduped, one audit total.
    runtime.closeTask(created.task_id);
    await until(() => logs.filter(l => l.includes('close-stop audit')).length >= 2);
    const after = await hubRead(server.url, created.task_id);
    expect(after.versions.filter(v => (v.payload as { operation?: string }).operation === 'close-stop')).toHaveLength(1);
  });

  it('already-ended runs audit an honest already-ended outcome; failures audit errors without fabrication', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'ended', description: 'b', creator: 'test-user', role: 'executor' });
    await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
    const held = heldAgent(r, 'done-agent'); const agent = held.agent;
    const runId = await builtControl.startRun(store, [agent], r, created.task_id, { headless: ownership('executor', created.task_id) });
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      stop: builtControl.stopRun, send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url,
    });
    runtime.restore();
    expect(runtime.busy(created.task_id)).toBe(true); held.release();
    await until(() => store.read(runId).ended_at !== undefined); // occupied but already ended
    runtime.closeTask(created.task_id);
    await until(() => logs.some(l => l.includes('close-stop audit')));
    const after = await hubRead(server.url, created.task_id);
    const audit = after.versions.find(v => (v.payload as { operation?: string }).operation === 'close-stop')!;
    expect((audit.payload as { stop_result?: string }).stop_result).toContain('already-ended');
    expect((audit.payload as { stop_success?: boolean }).stop_success).toBe(true);
  });

  it('Hub failures keep the local stop and its log line; nothing retries blindly', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const store = new RunStore(r);
    const agent = fixtureAgent(r);
    const runId = await spawnManaged(store, agent, r, 'offline-task', 'executor');
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      stop: builtControl.stopRun, send: async () => {}, log: line => logs.push(line),
      read: async () => { throw new Error('hub down'); },
      hubUrl: 'http://127.0.0.1:1',
    });
    runtime.restore();
    runtime.closeTask('offline-task');
    await until(() => store.read(runId).ended_at !== undefined);
    await until(() => logs.some(l => l.includes('close-stop audit') && (l.includes('unconfirmed') || l.includes('unreadable'))));
    expect(logs.some(l => l.includes('already recorded'))).toBe(false);
    // The stop itself succeeded regardless of the audit channel.
    expect(store.read(runId).stop_request?.result?.success).toBe(true);
  });
});

describe('syncNew discovers CLI-started managed resumes', () => {
  it.each(['running', 'pending', 'after-close', 'unreadable-inventory'] as const)('closes the admitted winner while a local attempt waits for the lock (sync=%s)', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async (syncAt) => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'admission winner', description: 'b', creator: 'test-user', role: 'executor' });
    const task = created.task_id;
    const logs: string[] = [];
    const start = vi.fn(builtControl.startRun);
    const stop = vi.fn(builtControl.stopRun);
    const runtime = new HeadlessRuntime(r, { start, stop, send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url });
    runtime.restore();
    const local = ownership('executor', task);
    const unlock = await store.lockAdmission();
    let locked = true;
    let winner: string | undefined;
    if (process.platform === 'win32') {
      // This fixture deliberately holds admission across a real native spawn
      // and Hub close, which can exceed the production 5s default. Give only
      // its queued contender a bounded caller budget; use the real lock and
      // keep all winner/stop/audit assertions below unchanged.
      const lockAdmission = runtime.store.lockAdmission.bind(runtime.store);
      vi.spyOn(runtime.store, 'lockAdmission').mockImplementation(() => lockAdmission(30_000));
    }
    try {
      runtime.launch({ task_id: task, title: task, role: local.role, attempt_id: local.attempt_id,
        base_version: 0, trigger_version: 0, hubRoot: r, routingRoot: r, checkoutRoot: r, hubUrl: server.url,
        route: local.route, route_source: local.route_source, argv: ['must-not-spawn'], prompt: 'fixture', env: {},
        target_digest: 'sha256:fixture', ownership: local });
      if (syncAt === 'pending') {
        const writeIntent = store.writeStartIntent.bind(store);
        vi.spyOn(store, 'writeStartIntent').mockImplementation(async (...args) => {
          await writeIntent(...args);
          runtime.syncNew(); // The other attempt already owns admission, but has no meta yet.
        });
      }
      winner = await spawnManaged(store, fixtureAgent(r), r, task, 'executor');
      expect(store.read(winner).headless!.attempt_id).not.toBe(local.attempt_id);
      if (syncAt === 'running' || syncAt === 'unreadable-inventory') runtime.syncNew();
      await hubDecide(server.url, { task_id: task, decision: 'close', by: 'test-user' });
      if (syncAt === 'unreadable-inventory') {
        const inventory = runtime.store.list.bind(runtime.store);
        vi.spyOn(runtime.store, 'list').mockImplementation(() => {
          if (logs.some(l => l.includes('detached launch skipped'))) throw new Error('inventory temporarily unreadable');
          return inventory();
        });
      }
      runtime.closeTask(task);
      runtime.closeTask(task); // Same close while waiting must not duplicate consumption.
      unlock();
      locked = false;
      await until(() => logs.some(l => l.includes('detached launch skipped')));
      if (process.platform === 'win32') {
        // Await the actual stop observer, whose production terminal window is
        // 60s. The fixture's 45s polling window must not race that observer or
        // add synchronous native meta reads while it is still making progress.
        await until(() => stop.mock.results.length === 1);
        expect((await stop.mock.results[0]!.value).success).toBe(true);
      }
      await until(() => logs.some(l => l.includes('close-stop audit') && l.includes('recorded at v')));
      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop.mock.calls[0]![1]).toBe(winner);
      expect(store.read(winner).ended_at).toBeDefined();
      expect(store.read(winner).stop_request?.result?.success).toBe(true);
      expect(runtime.busy(task)).toBe(true); // Losing startup did not delete the winner's seat.
      const audits = (await hubRead(server.url, task)).versions.filter(v => v.payload.operation === 'close-stop');
      expect(audits).toHaveLength(1);
      expect(audits[0]!.payload.run_id).toBe(winner);
      expect(audits[0]!.payload.stop_success).toBe(true);
      expect(logs.some(l => l.includes('startup unconfirmed'))).toBe(false);
    } finally {
      if (locked) unlock();
      if (winner && !store.read(winner).ended_at) await builtControl.stopRun(store, winner);
    }
  });
  it('restore misses them; syncNew picks the run up for observation and close', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'sync', description: 'b', creator: 'test-user', role: 'executor' });
    const agent = fixtureAgent(r);
    const logs: string[] = [];
    const stop = vi.fn(builtControl.stopRun);
    const runtime = new HeadlessRuntime(r, {
      stop, send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url,
    });
    runtime.restore();
    expect(runtime.busy(created.task_id)).toBe(false);
    // A CLI resume spawns AFTER the notifier's one-time restore.
    const runId = await spawnManaged(store, agent, r, created.task_id, 'executor');
    expect(runtime.busy(created.task_id)).toBe(false);
    runtime.syncNew();
    expect(runtime.busy(created.task_id)).toBe(true);
    // Close finds the CLI-started run through the synced ownership.
    const closed = await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
    runtime.closeTask(created.task_id);
    if (process.platform === 'win32') {
      await until(() => stop.mock.results.length === 1);
      expect((await stop.mock.results[0]!.value).success).toBe(true);
    }
    await until(() => store.read(runId).ended_at !== undefined);
    await until(() => logs.some(l => l.includes('close-stop audit')));
    const after = await hubRead(server.url, created.task_id);
    expect((after.versions.find(v => (v.payload as { operation?: string }).operation === 'close-stop')!.payload as { run_id?: string }).run_id).toBe(runId);
  });
});

describe('closure: the production revalidate factory (state+log consistency)', () => {
  it('a task log read failure is NOT permission to launch', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const created = await hubCreate(server.url, { title: 'logfail', description: 'b', creator: 'test-user', role: 'executor', flow: 'direct' });
    const revalidate = createHeadlessRevalidate({
      stateUrl: `${server.url}/state`,
      fetchState: async (url: string) => await (await fetch(url)).json() as never,
      readLog: async () => { throw new Error('simulated transport failure'); },
    });
    await expect(revalidate(created.task_id, 'executor', 'attempt-x')).rejects.toThrow(/unreadable, cannot confirm gate freshness/);
    // And through the runtime: zero spawn, skip logged, no give-up noise.
    const logs: string[] = []; const started: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      start: (async (...args: unknown[]) => { started.push(String(args.length)); throw new Error('must not spawn'); }) as unknown as typeof startRun,
      send: async () => {}, log: line => logs.push(line), read: async () => [],
      revalidate,
    });
    runtime.launch({ task_id: created.task_id, title: 't', role: 'executor', attempt_id: 'attempt-x', base_version: 0, trigger_version: 0, hubRoot: r, routingRoot: r, checkoutRoot: r, hubUrl: server.url, route: { agent: 'x', args: [] }, route_source: 'task-cast', argv: ['x'], prompt: 'p', env: {}, target_digest: 'sha256:x', ownership: ownership('executor', created.task_id) } as never);
    await until(() => logs.some(l => l.includes('detached launch skipped')));
    expect(started).toHaveLength(0);
  });

  it('a close landing between the state read and the log read refuses (log carries the close)', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const created = await hubCreate(server.url, { title: 'closegap', description: 'b', creator: 'test-user', role: 'executor', flow: 'direct' });
    let stateReads = 0;
    const revalidate = createHeadlessRevalidate({
      stateUrl: `${server.url}/state`,
      fetchState: async (url: string) => {
        const snapshot = await (await fetch(url)).json() as never;
        stateReads++;
        if (stateReads === 1) {
          await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
        }
        return snapshot;
      },
      readLog: async (taskId: string) => (await hubRead(server.url, taskId)).versions,
    });
    await expect(revalidate(created.task_id, 'executor', 'attempt-y')).rejects.toThrow(/closed|close decision|consistent gate/);
    expect(stateReads).toBeGreaterThanOrEqual(1);
  });

  it('a healthy task with its own marker attempt passes the production gate', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const created = await hubCreate(server.url, { title: 'healthy', description: 'b', creator: 'test-user', role: 'executor', flow: 'direct' });
    const own = ownership('executor', created.task_id);
    await hubPublish(server.url, { task_id: created.task_id, role: 'human', content_type: 'note', payload: { summary: 'launch', body: 'b', launch: { protocol_version: 2, role: 'executor', base_version: 0, via: 'auto', route: { agent: 'x', args: [] }, route_source: 'task-cast', target_kind: 'headless-posix', launch_mode: 'headless', attempt_id: own.attempt_id, trigger_version: 0 } } });
    const revalidate = createHeadlessRevalidate({
      stateUrl: `${server.url}/state`,
      fetchState: async (url: string) => await (await fetch(url)).json() as never,
      readLog: async (taskId: string) => (await hubRead(server.url, taskId)).versions,
    });
    await expect(revalidate(created.task_id, 'executor', own.attempt_id)).resolves.toBeUndefined();
    await expect(revalidate(created.task_id, 'executor', 'another-attempt')).rejects.toThrow(/another attempt/);
  });
});

describe('seat takeover: a pending intent takes over a COMPLETED seat in the same poll as close', () => {
  it('old run completes between polls; new pending arrives; syncNew hands the seat over and close audits the new reservation', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'seat handover', description: 'b', creator: 'test-user', role: 'executor', flow: 'direct' });
    const held = heldAgent(r, 'short-agent'); const shortAgent = held.agent;
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      stop: builtControl.stopRun, send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url,
    });
    // Poll N: the notifier holds a live old run (short-lived: it completes on
    // its own between polls — exactly this takeover sequence).
    const oldRun = await spawnManaged(store, shortAgent, r, created.task_id, 'executor');
    runtime.restore();
    expect(runtime.busy(created.task_id)).toBe(true);
    // Between polls: the old run COMPLETES and the CLI admits a NEW attempt
    // whose meta is not readable yet (pending headless-start intent).
    held.release(); await until(() => store.read(oldRun).ended_at !== undefined);
    const newOwn = ownership('executor', created.task_id);
    const pending = store.create();
    await store.writeStartIntent(pending, { task_id: created.task_id, headless: newOwn, cwd: r, startup: 'pending' });
    // Poll N+1 (production order): syncNew THEN observe THEN the close edge.
    runtime.syncNew();
    expect(runtime.busy(created.task_id)).toBe(true);
    await runtime.observe(); // reaps the completed old seat — the NEW reservation must survive
    expect(runtime.busy(created.task_id)).toBe(true);
    await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
    runtime.closeTask(created.task_id);
    await until(() => logs.some(l => l.includes('close-stop audit')));
    const after = await hubRead(server.url, created.task_id);
    const audit = after.versions.find(v => (v.payload as { operation?: string }).operation === 'close-stop')!;
    expect((audit.payload as { run_id?: string }).run_id).toBe(pending); // the CURRENT reservation, not the old run
    expect((audit.payload as { failure?: string }).failure).toContain('stop attempt failed'); // honest: no meta to stop
  });
});

describe('an adopted pending intent that becomes KNOWN-FAILED releases the seat', () => {
  it('pending adopted → known-failed → busy false, and a fresh candidate can launch; pending stays held otherwise', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root(); const store = new RunStore(r);
    const own = ownership('executor', 'failed-intent-task');
    const pending = store.create();
    await store.writeStartIntent(pending, { task_id: 'failed-intent-task', headless: own, cwd: r, startup: 'pending' });
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, { send: async () => {}, log: line => logs.push(line), read: async () => [] });
    runtime.syncNew();
    expect(runtime.busy('failed-intent-task')).toBe(true);
    // The handshake resolves as KNOWN-FAILED (startRun's failure path rewrites the intent).
    await store.writeStartIntent(pending, { task_id: 'failed-intent-task', headless: own, cwd: r, startup: 'failed' });
    runtime.syncNew();
    expect(runtime.busy('failed-intent-task')).toBe(false);
    expect(logs.some(l => l.includes('releasing adopted reservation'))).toBe(true);
    // A fresh auto candidate for the task is no longer blocked by the ghost seat.
    const agent = fixtureAgent(r);
    const started: string[] = [];
    const launchy = new HeadlessRuntime(r, {
      start: (async (...args: Parameters<typeof startRun>) => { const id = await builtControl.startRun(...args); started.push(id); return id; }) as typeof startRun,
      send: async () => {}, log: () => {}, read: async () => [],
    });
    launchy.launch({ task_id: 'failed-intent-task', title: 't', role: 'executor', attempt_id: crypto.randomUUID(), base_version: 0, trigger_version: 0, hubRoot: r, routingRoot: r, checkoutRoot: r, hubUrl: 'http://127.0.0.1:1', route: { agent, args: [] }, route_source: 'task-cast', argv: [agent], prompt: 'p', env: process.env, target_digest: 'sha256:x', ownership: ownership('executor', 'failed-intent-task') } as never);
    await until(() => started.length === 1);
    await stopRun(store, started[0]!);
    // Pending (not failed) still holds: a second uncertain intent keeps its seat.
    const still = store.create();
    await store.writeStartIntent(still, { task_id: 'held-task', headless: ownership('executor', 'held-task'), cwd: r, startup: 'pending' });
    runtime.syncNew();
    expect(runtime.busy('held-task')).toBe(true);
  });
});

describe('online-created pending startup intents enter ownership via syncNew', () => {
  it('a pending intent adopted after restore is closed with an honest unconfirmed audit; a later meta keeps ownership', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'intent sync', description: 'b', creator: 'test-user', role: 'executor' });
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      stop: builtControl.stopRun, send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url,
    });
    runtime.restore();
    expect(runtime.busy(created.task_id)).toBe(false);
    // A CLI-side headless reservation lands AFTER the one-time restore: run
    // directory exists, meta not yet readable, pending headless-start intent.
    const own = ownership('executor', created.task_id);
    const pending = store.create();
    await store.writeStartIntent(pending, { task_id: created.task_id, headless: own, cwd: r, startup: 'pending' });
    expect(runtime.busy(created.task_id)).toBe(false);
    runtime.syncNew();
    expect(runtime.busy(created.task_id)).toBe(true);
    expect(logs.some(l => l.includes('adopted pending startup intent'))).toBe(true);
    // Close finds the reservation and audits honestly (no meta → stop attempt fails).
    await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
    runtime.closeTask(created.task_id);
    await until(() => logs.some(l => l.includes('close-stop audit')));
    const after = await hubRead(server.url, created.task_id);
    const audit = after.versions.find(v => (v.payload as { operation?: string }).operation === 'close-stop')!;
    expect((audit.payload as { failure?: string }).failure).toContain('stop attempt failed');
    expect((audit.payload as { run_id?: string }).run_id).toBe(pending);
  });
  it('a pending intent whose meta later appears transitions to normal observation', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const store = new RunStore(r);
    const own = ownership('executor', 'late-meta-task');
    const pending = store.create();
    await store.writeStartIntent(pending, { task_id: 'late-meta-task', headless: own, cwd: r, startup: 'pending' });
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(r, { send: async () => {}, log: line => logs.push(line), read: async () => [] });
    runtime.restore();
    expect(runtime.busy('late-meta-task')).toBe(true);
    // The handshake completes: meta appears with the SAME attempt id.
    const at = new Date().toISOString();
    closeSync(store.openLog(pending, true));
    await store.initialize(pending, { run_id: pending, task_id: 'late-meta-task', pid: 900501, pgid: 900501, argv: ['agent'], cwd: r, supervisor_pid: 900502, started_at: at, status: 'running', control_protocol: 'cooperative-v1', headless: own });
    runtime.syncNew();
    expect(runtime.busy('late-meta-task')).toBe(true);
    // Completion releases the seat through normal observation.
    await store.updateMeta(pending, m => ({ ...m, ended_at: new Date().toISOString() }));
    await runtime.observe();
    expect(runtime.busy('late-meta-task')).toBe(false);
  });
});

describe('auto launch admission', () => {
  it('a stale plan (state/generation changed while waiting for admission) is dropped with zero spawn', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'stale', description: 'b', creator: 'test-user', role: 'executor', flow: 'direct' });
    // The two accepted launches only prove that staleness is task-local.
    // On Windows, serial default stops of timer-held agents also exercise
    // native escalation and can consume this case's entire 120s budget.
    // Release both fixtures together after the admission assertions instead;
    // the winner/close cases above still exercise real stop + audit behavior.
    const held = process.platform === 'win32' ? heldAgent(r, 'stale-agent') : undefined;
    const agent = held?.agent ?? fixtureAgent(r);
    const logs: string[] = [];
    const started: string[] = [];
    const revalidations: { task: string; role: string; attempt: string }[] = [];
    const realStart = builtControl.startRun;
    const own = ownership('executor', created.task_id);
    // Simulate a manual resume marker from ANOTHER attempt landing while the
    // auto plan waits for the admission lock.
    await hubPublish(server.url, { task_id: created.task_id, role: 'human', content_type: 'note', payload: { summary: 'launch', body: 'b', launch: { protocol_version: 2, role: 'executor', base_version: 0, via: 'manual', route: { agent, args: [] }, route_source: 'task-cast', target_kind: 'headless-posix', launch_mode: 'headless', attempt_id: '11111111-2222-3333-4444-555555555555', trigger_version: 0 } } });
    const runtime = new HeadlessRuntime(r, {
      start: (async (...args: Parameters<typeof startRun>) => { const id = await realStart(...args); started.push(id); return id; }) as typeof startRun,
      send: async () => {}, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url,
      revalidate: async (taskId, role, attemptId) => {
        revalidations.push({ task: taskId, role, attempt: attemptId });
        const state = await (await fetch(`${server.url}/state?include=closed`)).json() as { tasks?: { task_id?: string; status?: string; waiting_for?: string; needs_attention?: boolean }[] };
        const entry = state.tasks?.find(t => t.task_id === taskId);
        if (entry === undefined) throw new Error('task left /state');
        if (['pending_approval', 'approved', 'closed'].includes(entry.status ?? '')) throw new Error(`task is ${entry.status}`);
        if (entry.needs_attention) throw new Error('needs_attention');
        if (entry.waiting_for !== `agent:${role}`) throw new Error(`waiting_for ${entry.waiting_for}`);
        const records = await hubRead(server.url, taskId);
        let markerAttempt: string | undefined; let markerVersion = 0;
        for (const record of records.versions) {
          const launch = record.content_type === 'note' ? (record.payload as { launch?: { role?: string; attempt_id?: string } }).launch : undefined;
          if (launch?.role === role && record.version >= markerVersion) { markerVersion = record.version; markerAttempt = launch.attempt_id; }
        }
        if (markerAttempt !== undefined && markerAttempt !== attemptId) throw new Error(`generation already served by attempt ${markerAttempt}`);
      },
    });
    const plan = {
      task_id: created.task_id, title: 'stale', role: 'executor', attempt_id: own.attempt_id,
      base_version: 0, trigger_version: 0, hubRoot: r, routingRoot: r, checkoutRoot: r, hubUrl: server.url,
      route: { agent, args: [] }, route_source: 'task-cast', argv: [agent], prompt: 'p',
      env: process.env, target_digest: 'sha256:x',
      ownership: own,
    } as Parameters<HeadlessRuntime['launch']>[0];
    runtime.launch(plan);
    await until(() => logs.some(l => l.includes('detached launch skipped') && l.includes('stale')));
    expect(started).toHaveLength(0);
    expect(revalidations).toHaveLength(1);
    // A fresh plan with the CURRENT marker's own attempt passes revalidation.
    const fresh = { ...plan, attempt_id: '11111111-2222-3333-4444-555555555555', ownership: { ...own, attempt_id: '11111111-2222-3333-4444-555555555555' } } as Parameters<HeadlessRuntime['launch']>[0];
    // These are positive controls, not competing admissions: a native spawn
    // can hold the real lock longer than the next caller's default 5s wait.
    // Await each terminal outcome so a refusal fails here instead of polling
    // for two "started" lines that can never arrive. Keep POSIX as before.
    if (held) expect(await runtime.launchAndSettle(fresh)).toMatchObject({ kind: 'launched' });
    else runtime.launch(fresh);
    // An UNRELATED task's plan is not punished by this task's staleness.
    const otherTask = await hubCreate(server.url, { title: 'other', description: 'b', creator: 'test-user', role: 'executor', flow: 'direct' });
    const otherOwn = ownership('executor', otherTask.task_id);
    const otherPlan = { ...fresh, task_id: otherTask.task_id, title: 'other', ownership: otherOwn } as Parameters<HeadlessRuntime['launch']>[0];
    if (held) expect(await runtime.launchAndSettle(otherPlan)).toMatchObject({ kind: 'launched' });
    else runtime.launch(otherPlan);
    await until(() => logs.filter(l => l.includes('detached started')).length >= 2);
    expect(started).toHaveLength(2);
    if (held) {
      held.release();
      await until(() => started.every(id => store.read(id).ended_at !== undefined));
      for (const id of started) {
        const meta = store.read(id);
        expect(meta.exit_code).toBe(0);
        expect(meta.stop_request).toBeUndefined();
      }
    } else {
      await stopRun(store, started[0]!);
      await stopRun(store, started[1]!);
    }
  });
  it('a CLI-reserved task makes the auto launch skip without a give-up notification', { timeout: process.platform === 'win32' ? 120000 : 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const agent = fixtureAgent(r);
    // A managed run for the task already exists (e.g. a manual resume).
    const runId = await spawnManaged(store, agent, r, 'covered-task', 'executor');
    const messages: { title: string }[] = []; const logs: string[] = [];
    const started: string[] = [];
    const runtime = new HeadlessRuntime(r, {
      start: async (...args: Parameters<typeof startRun>) => { started.push(args[2]); return builtControl.startRun(...args); },
      send: async msg => { messages.push(msg); }, log: line => logs.push(line),
      read: async id => (await hubRead(server.url, id)).versions, hubUrl: server.url,
    });
    const plan = {
      task_id: 'covered-task', title: 'covered', role: 'executor', attempt_id: crypto.randomUUID(),
      base_version: 1, trigger_version: 1, hubRoot: r, routingRoot: r, checkoutRoot: r, hubUrl: server.url,
      route: { agent, args: [] }, route_source: 'task-cast', argv: [agent], prompt: 'p',
      env: process.env, target_digest: 'sha256:x',
      ownership: ownership('executor', 'covered-task'),
    } as Parameters<HeadlessRuntime['launch']>[0];
    runtime.launch(plan);
    await until(() => logs.some(l => l.includes('detached launch skipped')));
    expect(started).toHaveLength(0);
    expect(messages).toHaveLength(0); // covered ≠ give-up
    await stopRun(store, runId);
  });
});

void startRun; void vi;

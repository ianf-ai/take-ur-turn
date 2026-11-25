import { afterEach, vi } from 'vitest';
import { closeSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HeadlessRuntime } from '../../src/standalone/launcher-detached/runtime.js';
import type { HeadlessOwnership, RunMeta } from '../../src/core/run/store.js';
import { Store } from '../../src/hub/store.js';
import { Notifier, type StateResponse } from '../../src/core/notifier/notifier.js';
import type { Notification } from '../../src/core/common/channels.js';

// Policy/clock fixtures carry an explicit impossible PID. Keep that modeled
// boundary cheap; the real supervisor case and native safety cases stay native.
const windowsInventoryState = vi.hoisted(() => ({ enabled: false, single: 0, batch: 0 }));
vi.mock('../../src/hub/windows-run-file.js', async original => {
  const actual = await original<typeof import('../../src/hub/windows-run-file.js')>();
  return { ...actual, readWindowsRunMeta: (file: string) => {
    if (windowsInventoryState.enabled) { windowsInventoryState.single++; return readFileSync(file); }
    const raw = readFileSync(file);
    try { if (JSON.parse(raw.toString()).pid === 2147483000) return raw; } catch { /* actual reader classifies malformed data */ }
    // Completion policy fixtures use the same impossible-PID archive. Keep
    // their sidecar reads synthetic too; native path safety has separate cases.
    if (path.basename(file) === 'completion-check.json') {
      try { if (JSON.parse(readFileSync(path.join(path.dirname(file), 'meta.json'), 'utf8')).pid === 2147483000) return raw; }
      catch { /* unknown archives still use the native boundary */ }
    }
    return actual.readWindowsRunMeta(file);
  }, readWindowsRunMetas: (...args: Parameters<typeof actual.readWindowsRunMetas>) => {
    if (!windowsInventoryState.enabled) return actual.readWindowsRunMetas(...args);
    windowsInventoryState.batch++;
    const [files, decode] = args;
    return files.map(({ i, file }) => {
      try { return { i, kind: 'meta', meta: decode(readFileSync(file), i) }; }
      catch (error) { return { i, kind: 'error', error, origin: 'file' }; }
    });
  } };
});

export const windowsInventory = windowsInventoryState;

export const START = '2026-01-01T00:00:00.000Z';
export const END = '2026-01-01T00:01:00.000Z';
export const NOW = Date.parse('2100-01-01T00:00:00.000Z');
const notifiers: Notifier[] = [];
afterEach(async () => { for (const n of notifiers.splice(0)) await n.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

export async function fixture() {
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
  const diagnostics = (reason: string) => logs.filter(body => body.includes(`reason=${reason}`))
    .map(body => ({ body, task_id: /task_id=([^;]+)/.exec(body)?.[1] }));
  return { root, hub, task, runtime, read, deps, append, run, messages, logs, reasons, diagnostics };
}

export async function notifierFixture(f: Awaited<ReturnType<typeof fixture>>) {
  vi.stubEnv('TUT_HUB_ROOT', f.root);
  let version = (await f.hub.readTask(f.task)).versions.length;
  let mode: 'detached' | 'tui' = 'detached', present = true, now = NOW;
  const state = (): StateResponse => ({ flow_mode: 'manual', truncated: false, tasks: present ? [{ task_id: f.task, title: f.task, version, status: 'implementing', waiting_for: 'agent:executor', needs_attention: false, updated_at: String(version) }] : [], degraded: present ? [] : [f.task] });
  const read = vi.fn(async (id: string) => (await f.hub.readTask(id)).versions);
  const launch = vi.fn(async () => 'launched');
  const n = new Notifier({ url: 'http://127.0.0.1:1', eventPort: 1, interval: 5, stallTimeoutMin: 30 }, {
    headlessRuntime: f.runtime, fetchState: async () => state(), readLog: read, readLaunchMode: async () => mode,
    loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }), now: () => now,
    channelsFor: () => [{ name: 'fixture', send: f.deps.send }], log: f.deps.log, launch, relayHostStatus: async () => {},
  }); notifiers.push(n);
  return { n, read, launch, tick: () => n.requestCompare(), version: (v: number) => { version = v; }, mode: (m: typeof mode) => { mode = m; }, present: (v: boolean) => { present = v; }, now: (v: number) => { now = v; } };
}


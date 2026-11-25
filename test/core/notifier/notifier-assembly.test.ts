/** Only assembly gaps: runtime identity and configuration intake timing. */
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadlessRuntimeDeps } from '../../../src/standalone/launcher-detached/runtime.js';
import type { HeadlessPlan } from '../../../src/standalone/launcher-detached/plan.js';
import type { LegacyNotifierDeps as LegacyDeps, LaneContext } from '../../../src/app/notifier/compat-contracts.js';
import type { NotifierDeps } from '../../../src/core/notifier/notifier.js';
import type { StateResponse, StateTask } from '../../../src/core/notifier/shared-contracts.js';

const seam = vi.hoisted(() => ({ constructed: vi.fn(), plan: vi.fn() }));
vi.mock('../../../src/standalone/host-entry.js', async original => {
  const actual = await original<typeof import('../../../src/standalone/host-entry.js')>();
  return { ...actual, HeadlessRuntime: class extends actual.HeadlessRuntime {
    constructor(root: string, deps: HeadlessRuntimeDeps) {
      super(root, deps);
      seam.constructed(this, root, deps);
    }
  } };
});
vi.mock('../../../src/standalone/launcher-detached/plan.js', async original => ({
  ...await original<typeof import('../../../src/standalone/launcher-detached/plan.js')>(),
  buildHeadlessPlan: seam.plan,
}));

import { Notifier } from '../../../src/core/notifier/notifier.js';
import { HeadlessRuntime } from '../../../src/standalone/launcher-detached/runtime.js';
import type { Remediator } from '../../../src/herdr/launcher/remediator.js';
import type { DeliveryDiagnostics } from '../../../src/herdr/launcher/delivery.js';
import type { TuiLane } from '../../../src/herdr/notifier/tui-lane.js';
import type { NotifierLogCache } from '../../../src/core/notifier/log-cache.js';
import type { NotifierNotifications } from '../../../src/core/notifier/notifications.js';

// Both generic and specialized old flat constructors remain assignable.
const legacyCompatible = (deps: Partial<LegacyDeps<HeadlessRuntime, Remediator, DeliveryDiagnostics>>) => new Notifier(options, deps);
const options = { url: 'http://127.0.0.1:39999', interval: 5, eventPort: 39998, stallTimeoutMin: 30 };
const task: StateTask = { task_id: 'identity', title: 'identity', status: 'implementing', waiting_for: 'agent:executor',
  needs_attention: false, updated_at: '2026-10-29T00:00:00Z', flow: 'direct' };
const open: Notifier[] = [];
type Owner = { detached: { headless: HeadlessRuntime; observe(state: StateResponse): Promise<void>; reconcileHeadlessDeliveries(state: StateResponse, now: number): Promise<void> }; tui: TuiLane;
  logs: NotifierLogCache; notifications: NotifierNotifications };
const owner = (n: Notifier) => n as unknown as Owner;

beforeEach(() => { seam.constructed.mockClear(); seam.plan.mockReset(); });
afterEach(async () => { for (const n of open.splice(0)) await n.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fixture(extra: Partial<NotifierDeps> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tut-notifier-assembly-'));
  vi.stubEnv('TUT_HUB_ROOT', root);
  let state: StateResponse = { flow_mode: 'auto', auto: { launch_roles: ['executor'] }, tasks: [] };
  const fetchState = vi.fn(async () => state);
  const log = vi.fn();
  const readLog = vi.fn(async () => []);
  const notifier = legacyCompatible({ fetchState, log, readLog, readLaunchMode: async () => 'detached',
    readLaunchCatchup: async () => 'off', loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
    channelsFor: () => [], cleanupPanes: async () => {}, ...extra });
  open.push(notifier);
  return { root, notifier, fetchState, readLog, log, set: (next: StateResponse) => { state = next; } };
}

describe('Notifier assembly identity', () => {
  it.each([false, true])('uses exactly the selected runtime through observe/mark/launch/closeTask (injected=%s)', async injected => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tut-notifier-runtime-'));
    const supplied = injected ? new HeadlessRuntime(root, { send: async () => {}, log: () => {}, read: async () => [] }) : undefined;
    const f = fixture(supplied ? { headlessRuntime: supplied } : {});
    const lane = owner(f.notifier).detached;
    const runtime = supplied ?? seam.constructed.mock.calls[0]![0] as HeadlessRuntime;
    expect(seam.constructed).toHaveBeenCalledTimes(injected ? 0 : 1);
    expect(lane.headless).toBe(runtime);
    expect(lane.headless.store).toBe(runtime.store);
    const observe = vi.spyOn(runtime, 'observe').mockResolvedValue({ ended: [], stopped: [] });
    const mark = vi.spyOn(runtime, 'mark').mockResolvedValue();
    const launch = vi.spyOn(runtime, 'launch').mockImplementation(() => {});
    const closeTask = vi.spyOn(runtime, 'closeTask').mockImplementation(() => {});
    const plan = { task_id: task.task_id, role: 'executor' } as HeadlessPlan;
    seam.plan.mockResolvedValue(plan);
    await f.notifier.requestCompare();
    f.set({ flow_mode: 'auto', auto: { launch_roles: ['executor'] }, tasks: [task] });
    await f.notifier.requestCompare();
    expect(mark).toHaveBeenCalledExactlyOnceWith(plan);
    expect(launch).toHaveBeenCalledExactlyOnceWith(plan);
    expect(observe).toHaveBeenCalledTimes(2);
    for (const method of [observe, mark, launch]) expect(method.mock.contexts.every(c => c === runtime)).toBe(true);
    f.set({ flow_mode: 'auto', tasks: [{ ...task, status: 'closed', waiting_for: 'none' }] });
    await f.notifier.requestCompare();
    expect(closeTask).toHaveBeenCalledExactlyOnceWith(task.task_id, undefined);
    expect(closeTask.mock.contexts[0]).toBe(runtime);
    expect(seam.constructed).toHaveBeenCalledTimes(injected ? 0 : 1);
  });

  it('constructs the default once with the original callback and fresh-state revalidate paths', async () => {
    const f = fixture();
    const [runtime, root, callbacks] = seam.constructed.mock.calls[0] as [HeadlessRuntime, string, HeadlessRuntimeDeps];
    expect(seam.constructed).toHaveBeenCalledTimes(1);
    expect(root).toBe(realpathSync(f.root));
    expect(callbacks.hubUrl).toBe(options.url);
    const o = owner(f.notifier);
    expect(o.detached.headless).toBe(runtime);
    const read = vi.spyOn(o.logs, 'readLog').mockResolvedValue([]);
    const full = vi.spyOn(o.logs, 'fullLog').mockResolvedValue([]);
    const send = vi.spyOn(o.notifications, 'sendAll').mockResolvedValue();
    await callbacks.read(task.task_id);
    expect(read).toHaveBeenCalledExactlyOnceWith(task.task_id);
    expect(full).not.toHaveBeenCalled();
    await callbacks.send({ title: 'callback', body: 'callback' });
    expect(send).toHaveBeenCalledExactlyOnceWith({ title: 'callback', body: 'callback' });
    callbacks.log('callback');
    expect(f.log).toHaveBeenCalledWith('tut: notify: callback');
    f.set({ flow_mode: 'auto', tasks: [task] });
    await callbacks.revalidate!(task.task_id, 'executor', 'attempt');
    expect(full).toHaveBeenCalledExactlyOnceWith(task.task_id);
    expect(f.fetchState).toHaveBeenCalledWith(`${options.url}/state?include=closed`);
    f.set({ flow_mode: 'auto', tasks: [{ ...task, status: 'closed' }] });
    await expect(callbacks.revalidate!(task.task_id, 'executor', 'attempt')).rejects.toThrow('task is closed');
  });

  it('keeps configuration intake after observe and the unique snapshot update, before delivery and observer reconciliation', async () => {
    const f = fixture();
    const o = owner(f.notifier);
    const order: string[] = [];
    const active = { ...task };
    let finish!: () => void;
    const observing = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(o.tui, 'refreshRouting').mockImplementation(async () => { order.push('bindings'); });
    vi.spyOn(o.detached, 'observe').mockImplementation(() => { order.push('observe'); return observing; });
    const accept = vi.spyOn(o.tui, 'setRemediationMode').mockImplementation(mode => {
      expect((o.tui as unknown as { context: Pick<LaneContext, 'snapshot'> }).context.snapshot?.get(task.task_id)).toBe(active);
      order.push(`configuration:${mode}`);
    });
    vi.spyOn(o.detached, 'reconcileHeadlessDeliveries').mockImplementation(async () => { order.push('deliveries'); });
    vi.spyOn(o.tui, 'retireObsoleteWorkingWatches').mockImplementation(async () => { order.push('observers'); });
    f.set({ flow_mode: 'auto', tasks: [active] }); // undefined auto retains auto remediation default
    const pending = f.notifier.requestCompare();
    // Ledger recovery may perform disk I/O before routing. Wait for the
    // actual observe boundary rather than assuming a fixed microtask count.
    await vi.waitFor(() => expect(order).toEqual(['bindings', 'observe']));
    expect(accept).not.toHaveBeenCalled();
    finish(); await pending;
    expect(order).toEqual(['bindings', 'observe', 'configuration:enter-repress', 'deliveries', 'observers']);
    order.length = 0;
    f.set({ flow_mode: 'auto', auto: { remediate: 'off' }, tasks: [active] });
    await f.notifier.requestCompare();
    expect(order).toEqual(['bindings', 'observe', 'configuration:off', 'deliveries', 'observers']);
  });
});

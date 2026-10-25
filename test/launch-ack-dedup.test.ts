import { planForPlatform } from '../src/core/launcher/target-resolver.js';
import { fixtureExecutable } from "./helpers/executable.js";
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Notifier, type StateResponse } from '../src/core/notifier/notifier.js';
import { HeadlessRuntime } from '../src/standalone/launcher-headless/runtime.js';
import type { ContextRecord } from '../src/core/common/types.js';

const notifiers: Notifier[] = [];
afterEach(async () => {
  for (const notifier of notifiers.splice(0)) await notifier.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['tui', 'detached'] as const)('%s: ack returning waiting_for to reviewer cannot repeat a launched delivery; new content can', async mode => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tut-ack-dedup-'));
  vi.stubEnv('TUT_HUB_ROOT', root);
  vi.stubEnv('TUT_PROJECT_ROOT', root);
  vi.stubEnv('TUT_USER_CONFIG_DIR', path.join(root, 'user-config'));
  const record = (version: number, content_type: string, payload: ContextRecord['payload']): ContextRecord => ({
    version, task_id: 't', role: content_type === 'note' ? 'human' : 'executor',
    content_type, timestamp: new Date(version * 1000).toISOString(), payload,
  });
  const records = [
    record(1, 'code_changes', { summary: 'delivery', body: 'delivery' }),
    record(2, 'note', { summary: 'launch', body: 'launch', launch: { role: 'reviewer', base_version: 1, via: 'start-next' } }),
  ];
  // An attention interruption hides the waiting agent. Ack exposes it again
  // without creating another delivery for the reviewer.
  const entry = {
    task_id: 't', title: 'ack fixture', status: 'reviewing', version: 2,
    waiting_for: 'human', needs_attention: true, updated_at: new Date(2000).toISOString(),
    cast: { reviewer: fixtureExecutable(path.resolve(import.meta.dirname, 'bin/codex')).replaceAll('\\', '/') },
  };
  const state: StateResponse = { flow_mode: 'auto', auto: { launch_roles: ['reviewer'] }, tasks: [entry] };
  const runtime = new HeadlessRuntime(root, { log: () => {}, send: async () => {}, read: async () => [...records] });
  const mark = vi.spyOn(runtime, 'mark').mockResolvedValue(undefined);
  const headlessLaunch = vi.spyOn(runtime, 'launch').mockImplementation(() => {});
  const paneLaunch = vi.fn(async () => 'launched');
  const paneMark = vi.fn(async () => ({ version: entry.version + 1 }));
  const logs: string[] = [];
  const notifier = new Notifier({ url: 'http://hub.test', eventPort: 1, interval: 1, stallTimeoutMin: 0 }, {
    fetchState: async () => structuredClone(state), readLog: async () => [...records],
    readLaunchMode: async () => mode, headlessRuntime: runtime,
    launchInvocation: paneLaunch, markLaunched: paneMark,
    // Dedup is the subject; supply an already-frozen modeled host plan.
    resolveTargetWithSource: async () => ({ route: entry.cast.reviewer, source: 'task-cast', plan: await planForPlatform({ agent: entry.cast.reviewer, args: [] }, { platform: 'linux' }) }),
    loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
    listAnchorPanes: async () => [{ pane_id: 'fixture:anchor', label: 'tut-hub', workspace_id: 'fixture', cwd: root }],
    channelsFor: () => [], log: line => logs.push(line),
  });
  notifiers.push(notifier);
  await notifier.requestCompare();
  records.push(record(3, 'note', { summary: 'ack', body: 'ack', ack: true }));
  Object.assign(entry, { version: 3, waiting_for: 'agent:reviewer', needs_attention: false });
  await notifier.requestCompare();
  await notifier.requestCompare();
  expect(paneLaunch).not.toHaveBeenCalled();
  expect(headlessLaunch).not.toHaveBeenCalled();
  expect(paneMark).not.toHaveBeenCalled();
  expect(mark).not.toHaveBeenCalled();
  expect(logs.some(line => line.includes('auto launch skipped (already launched)'))).toBe(true);

  // A normal fail_code → revision cycle supplies new content and must permit
  // the next review round, even though the old launch marker still exists.
  records.push({ ...record(4, 'review', { summary: 'fix requested', body: 'fix requested', verdict: 'fail_code' }), role: 'reviewer' });
  Object.assign(entry, { version: 4, status: 'revising', waiting_for: 'agent:executor' });
  await notifier.requestCompare();
  records.push(record(5, 'revision', { summary: 'new delivery', body: 'new delivery' }));
  Object.assign(entry, { version: 5, status: 'reviewing', waiting_for: 'agent:reviewer' });
  await notifier.requestCompare();
  expect(mode === 'tui' ? paneLaunch : headlessLaunch, logs.join('\n')).toHaveBeenCalledTimes(1);
  expect(mode === 'tui' ? paneMark : mark).toHaveBeenCalledTimes(1);
});

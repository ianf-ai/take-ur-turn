import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestHandler } from '../../../src/hub/http.js';
import { Notifier, type StateResponse } from '../../../src/core/notifier/notifier.js';
import type { RecordIO } from '../../../src/hub/store/record-io.js';
import type { FoldCache } from '../../../src/hub/store/fold-cache.js';
import { Store, type PruneTaskInput } from '../../../src/hub/store.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, cp: vi.fn(actual.cp), rm: vi.fn(actual.rm), open: vi.fn(actual.open) };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let tmp: string, root: string, store: Store;
const input = { by: 'test human', reason: 'authorized fixture disposal' };
const directory = (id: string) => path.join(root, 'tasks', id);
const manifest = () => path.join(root, 'tasks', '.pruned.jsonl');
const entries = () => readFileSync(manifest(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
async function closed(title = 'closed task') {
  const { task_id } = await store.createTask({ title, description: 'fixture', creator: 'test', role: 'human', flow: 'direct' });
  await store.append(task_id, { role: 'human', content_type: 'decision', payload: { summary: 'close', body: 'authorized fixture closure', decision: 'close' } });
  return task_id;
}
function tree(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(tree(full)).map(([key, value]) => [path.join(entry.name, key), value]) : [[entry.name, readFileSync(full).toString('base64')]];
  }));
}

beforeEach(() => {
  vi.mocked(fs.cp).mockImplementation(actualFs.cp);
  vi.mocked(fs.rm).mockImplementation(actualFs.rm);
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  tmp = mkdtempSync(path.join(os.tmpdir(), 'tut-prune-'));
  root = path.join(tmp, '.context-hub'); store = new Store(root);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(tmp, { recursive: true, force: true }); });

describe('closed-task prune Store boundary', () => {
  it('syncs an append-only intent before removing the task, retaining runs and reserving its identity', async () => {
    const id = await closed();
    mkdirSync(path.join(root, 'runs', 'run-fixture'), { recursive: true });
    writeFileSync(path.join(root, 'runs', 'run-fixture', 'meta.json'), JSON.stringify({ task_id: id }));
    const runs = tree(path.join(root, 'runs'));
    const prior = JSON.stringify({ task_id: 'previous', ...input }) + '\n';
    writeFileSync(manifest(), prior);
    const remove = actualFs.rm;
    vi.mocked(fs.rm).mockImplementationOnce(async (...args) => {
      expect(entries().at(-1)).toMatchObject({ task_id: id, ...input });
      expect(existsSync(directory(id))).toBe(true);
      return remove(...args);
    });
    const result = await store.pruneTask(id, input);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readFileSync(manifest(), 'utf8').startsWith(prior)).toBe(true);
    expect(entries()).toHaveLength(2);
    expect(existsSync(directory(id))).toBe(false);
    expect(tree(path.join(root, 'runs'))).toEqual(runs);
    expect(await store.snapshotTasks()).toEqual({ tasks: [], degraded: [] });
    expect(await new Store(root).snapshotTasks()).toEqual({ tasks: [], degraded: [] });
    const recreated = await new Store(root).createTask({ title: 'closed task', description: 'new', creator: 'test', role: 'human' });
    expect(recreated.task_id).not.toBe(id);
    await expect(store.pruneTask(id, input)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('copies every task byte, including sidecars and nested material, before audit/removal', async () => {
    const id = await closed();
    mkdirSync(path.join(directory(id), 'nested'));
    writeFileSync(path.join(directory(id), 'nested', 'bytes'), Buffer.from([0, 255, 42]));
    writeFileSync(path.join(directory(id), 'usage.json'), '{"fixture":true}\n');
    const before = tree(directory(id));
    const archive = path.join(tmp, 'backup with spaces');
    const result = await store.pruneTask(id, { ...input, archive });
    expect(result.archive).toBe(await fs.realpath(path.join(archive, id)));
    expect(tree(result.archive!)).toEqual(before);
    expect(entries()[0].archive).toBe(result.archive);
    expect(existsSync(directory(id))).toBe(false);
  });

  it.each(['implementing', 'approved'] as const)('refuses %s without trusting a forged closed metadata cache', async status => {
    const { task_id: id } = await store.createTask({ title: 'active', description: 'fixture', creator: 'test', role: 'human', flow: 'solo' });
    if (status === 'approved') {
      await store.append(id, { role: 'executor', content_type: 'code_changes', payload: { summary: 'code', body: 'fixture' } });
      await store.append(id, { role: 'human', content_type: 'decision', payload: { summary: 'approve', body: 'fixture', decision: 'approve' } });
    }
    const meta = path.join(directory(id), 'meta.json');
    writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), status: 'closed' }));
    const before = tree(directory(id));
    await expect(store.pruneTask(id, input)).rejects.toThrow(/only closed.*finish the task first/);
    expect(tree(directory(id))).toEqual(before);
    expect(existsSync(manifest())).toBe(false);
  });

  it('replays eligibility from records even after a warm closed cache', async () => {
    const id = await closed(); await store.readTask(id);
    const file = path.join(directory(id), 'v001.decision.json');
    const record = JSON.parse(readFileSync(file, 'utf8')); record.payload.decision = 'reject';
    writeFileSync(file, JSON.stringify(record));
    await expect(store.pruneTask(id, input)).rejects.toThrow(/only closed/);
    expect(existsSync(manifest())).toBe(false);
  });

  it('rejects missing tasks, project scope, unsafe paths and missing operator/reason', async () => {
    await expect(store.pruneTask('unknown', input)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(store.pruneTask('project', input)).rejects.toThrow(/project scope cannot/);
    await expect(store.pruneTask('../outside', input)).rejects.toThrow(/task_id/);
    const id = await closed();
    for (const bad of [{ reason: 'x' }, { by: 'x' }, { ...input, reason: ' ' }, { ...input, by: 2 }, { ...input, archive: 3 }, { ...input, archive: 'relative' }]) {
      await expect(store.pruneTask(id, bad as PruneTaskInput)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(new Store(root, { readOnly: true }).pruneTask(id, input)).rejects.toThrow(/read-only/);
    expect(existsSync(directory(id))).toBe(true); expect(existsSync(manifest())).toBe(false);
  });

  it('retains the source on copy failure and refuses existing/internal archive destinations', async () => {
    const id = await closed(), before = tree(directory(id));
    vi.mocked(fs.cp).mockRejectedValueOnce(new Error('copy fault'));
    const archive = path.join(tmp, 'backup');
    await expect(store.pruneTask(id, { ...input, archive })).rejects.toThrow(/archive failed.*copy fault/);
    expect(tree(directory(id))).toEqual(before);
    await expect(store.pruneTask(id, { ...input, archive })).rejects.toThrow(/archive failed/);
    await expect(store.pruneTask(id, { ...input, archive: path.join(root, 'bad-archive') })).rejects.toThrow(/outside the Hub/);
    expect(existsSync(manifest())).toBe(false);
  });

  it('refuses archive paths entering Hub storage through a symlink and task symlinks', async () => {
    const id = await closed();
    const alias = path.join(tmp, 'hub-alias'); symlinkSync(root, alias, 'junction');
    await expect(store.pruneTask(id, { ...input, archive: path.join(alias, 'backup') })).rejects.toThrow(/outside the Hub/);
    const external = path.join(tmp, 'external-task'); renameSync(directory(id), external);
    symlinkSync(external, directory(id), 'junction');
    const before = tree(external);
    await expect(store.pruneTask(id, input)).rejects.toThrow(/real task directory/);
    expect(tree(external)).toEqual(before); expect(existsSync(manifest())).toBe(false);
  });

  it('retains the task when manifest append or sync fails', async () => {
    const id = await closed(), before = tree(directory(id));
    mkdirSync(manifest());
    await expect(store.pruneTask(id, input)).rejects.toThrow(/cannot append prune manifest; task retained/);
    rmSync(manifest(), { recursive: true });
    const actualOpen = actualFs.open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const file = await actualOpen(...args);
      vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('sync fault'));
      return file;
    });
    await expect(store.pruneTask(id, input)).rejects.toThrow(/sync fault/);
    expect(tree(directory(id))).toEqual(before);
  });

  it('keeps a failed removal intent and appends a fresh one on retry without rewriting history', async () => {
    const id = await closed();
    vi.mocked(fs.rm).mockRejectedValueOnce(new Error('remove fault'));
    await expect(store.pruneTask(id, input)).rejects.toThrow(/intent recorded but removal failed/);
    expect(existsSync(directory(id))).toBe(true);
    const prior = readFileSync(manifest(), 'utf8');
    await store.pruneTask(id, input);
    expect(readFileSync(manifest(), 'utf8').startsWith(prior)).toBe(true);
    expect(entries()).toHaveLength(2);
  });

  it('serializes disposal with appends and parallel pruning through the shared manifest', async () => {
    const id = await closed();
    let copying!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { copying = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const actualCopy = actualFs.cp;
    vi.mocked(fs.cp).mockImplementationOnce(async (...args) => { copying(); await gate; return actualCopy(...args); });
    const prune = store.pruneTask(id, { ...input, archive: path.join(tmp, 'backup') });
    await entered;
    const append = store.append(id, { role: 'human', content_type: 'note', payload: { summary: 'late', body: 'late' } });
    const appendResult = append.then(() => null, error => error as Error);
    release(); await prune; expect(await appendResult).toMatchObject({ code: 'TASK_NOT_FOUND' });
    const ids = await Promise.all(Array.from({ length: 5 }, (_, i) => closed(`parallel ${i}`)));
    await Promise.all(ids.map(task => store.pruneTask(task, input)));
    expect(entries().map(entry => entry.task_id).sort()).toEqual([id, ...ids].sort());
  });

  it('preserves a torn last line and separates the next complete intent', async () => {
    const id = await closed(); writeFileSync(manifest(), '{"task_id":');
    await store.pruneTask(id, input);
    expect(readFileSync(manifest(), 'utf8').startsWith('{"task_id":\n')).toBe(true);
    expect(await store.readPrunedTaskIds()).toEqual([id]);
  });

  it('keeps legacy intent identities stable across restart and distinguishes identical appended retries', async () => {
    await closed();
    const legacy = JSON.stringify({ task_id: 'legacy-task', timestamp: '2026-11-05T00:00:00Z', ...input }) + '\n';
    writeFileSync(manifest(), legacy);
    const first = await store.readPruneEvents();
    expect(await new Store(root).readPruneEvents()).toEqual(first);
    appendFileSync(manifest(), legacy);
    const second = await store.readPruneEvents();
    expect(second[0]?.task_id).toBe('legacy-task');
    expect(second[0]?.event_id).not.toBe(first[0]?.event_id);
    expect(readFileSync(manifest(), 'utf8')).toBe(legacy + legacy);
    expect(await store.readPrunedTaskIds()).toEqual(['legacy-task']);
  });

  it('keeps concurrent snapshots quiet while the audited directory is being removed', async () => {
    const id = await closed();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(fs.rm).mockImplementationOnce(async (...args) => {
      // The manifest must already be readable at the point /state omits it.
      expect(await store.readPrunedTaskIds()).toEqual([id]);
      expect(await store.snapshotTasks()).toEqual({ tasks: [], degraded: [] });
      return actualFs.rm(...args);
    });
    await store.pruneTask(id, input);
    expect(await store.snapshotTasks()).toEqual({ tasks: [], degraded: [] });
    expect(stderr).not.toHaveBeenCalled();
  });
});


/** Real HTTP handler and Notifier, with barriers only at the storage seams. */
function stateReader() {
  const handler = createRequestHandler({ store, root });
  return () => new Promise<StateResponse>((resolve, reject) => {
    let status = 0;
    handler({ method: 'GET', url: '/state?include=closed', headers: { host: '127.0.0.1' } } as IncomingMessage, {
      writeHead(code: number) { status = code; },
      end(body: string) {
        if (status !== 200) reject(new Error(`HTTP ${status}: ${body}`));
        else resolve(JSON.parse(body) as StateResponse);
      },
    } as unknown as ServerResponse);
  });
}
function observedNotifier(fetchState: () => Promise<StateResponse>) {
  vi.stubEnv('TUT_HUB_ROOT', tmp);
  const messages: string[] = [], logs: string[] = [];
  const readLog = vi.fn(async (id: string) => (await store.readTask(id)).versions);
  const launch = vi.fn(async () => 'launched');
  const notifier = new Notifier({ url: 'http://127.0.0.1:1', eventPort: 1, interval: 5, stallTimeoutMin: 30 }, {
    fetchState, readLog, launch, readLaunchMode: async () => 'tui', readLaunchCatchup: async () => 'off',
    loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
    channelsFor: () => [{ name: 'fixture', send: async message => { messages.push(message.title); } }],
    log: line => logs.push(line), relayHostStatus: async () => {}, cleanupPanes: async () => {},
    listPanes: async () => [], readPane: async () => '',
  });
  return { notifier, messages, logs, readLog, launch };
}
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { enter, entered, gate, release };
}

describe.each(['manual', 'auto'] as const)('prune observation consistency (%s)', mode => {
  it.each(['after-meta', 'after-fold', 'after-collection', 'during-audit-read', 'during-removal'] as const)('never exposes a worker candidate when a snapshot overlaps prune %s', async stage => {
    const id = await closed();
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ flow_mode: mode, auto: { launch_roles: ['executor'] } }));
    const readState = stateReader();
    let nextView: StateResponse | undefined;
    const observer = observedNotifier(async () => {
      if (nextView !== undefined) { const view = nextView; nextView = undefined; return view; }
      return readState();
    });
    const paused = barrier(), removing = barrier();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const internals = store as unknown as { io: RecordIO; foldCache: FoldCache };
    try {
      await observer.notifier.requestCompare();
      if (stage === 'during-audit-read') {
        const original = store.readPruneEvents.bind(store);
        vi.spyOn(store, 'readPruneEvents').mockImplementationOnce(async () => {
          const result = await original(); paused.enter(); await paused.gate; return result;
        });
      } else if (stage === 'after-collection') {
        const original = store.snapshotTasks.bind(store);
        vi.spyOn(store, 'snapshotTasks').mockImplementationOnce(async () => {
          const result = await original(); paused.enter(); await paused.gate; return result;
        });
      } else if (stage === 'after-fold') {
        const original = internals.foldCache.derivedFor.bind(internals.foldCache);
        vi.spyOn(internals.foldCache, 'derivedFor').mockImplementationOnce(async (...args) => {
          const result = await original(...args); paused.enter(); await paused.gate; return result;
        });
      } else {
        const original = internals.io.taskDirNames.bind(internals.io);
        vi.spyOn(internals.io, 'taskDirNames').mockImplementationOnce(async (...args) => {
          paused.enter(); await paused.gate; return original(...args);
        });
      }
      let overlapped!: StateResponse;
      const pendingView = readState(); await paused.entered;
      let prune: Promise<unknown>;
      if (stage === 'during-removal') {
        vi.mocked(fs.rm).mockImplementationOnce(async (...args) => { removing.enter(); await removing.gate; return actualFs.rm(...args); });
        prune = store.pruneTask(id, input); await removing.entered;
      } else {
        prune = store.pruneTask(id, input); await prune;
      }
      paused.release(); overlapped = await pendingView;
      expect(overlapped.tasks.every(task => task.task_id !== id || (task.status === 'closed' && task.waiting_for === 'none'))).toBe(true);
      expect(overlapped.tasks).toEqual([]);
      // Feed this exact raced HTTP response to the observer that saw closed.
      nextView = overlapped;
      await observer.notifier.requestCompare();
      removing.release(); await prune;
      await observer.notifier.requestCompare();
      expect((await readState()).tasks).toEqual([]);
      expect(observer.messages).toEqual([]); expect(observer.readLog).not.toHaveBeenCalled(); expect(observer.launch).not.toHaveBeenCalled();
      expect(observer.logs.filter(line => /context check failed|task not found|launch failed/.test(line))).toEqual([]);
      expect(stderr).not.toHaveBeenCalled();
    } finally { paused.release(); removing.release(); await observer.notifier.close(); }
  });

  it.each([false, true])('rearms after archive restoration (restart=%s) and permits a new audited prune', async restart => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    const id = await closed();
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ flow_mode: mode, auto: { launch_roles: ['executor'] } }));
    const readState = stateReader();
    let observer = observedNotifier(readState);
    try {
      await observer.notifier.requestCompare();
      const first = await store.pruneTask(id, { ...input, archive: path.join(tmp, 'backup') });
      await observer.notifier.requestCompare(); expect(observer.messages).toEqual([]);
      await actualFs.cp(first.archive!, directory(id), { recursive: true });
      await observer.notifier.requestCompare();
      if (restart) {
        await observer.notifier.close(); observer = observedNotifier(readState);
        await observer.notifier.requestCompare();
      }
      await actualFs.rename(directory(id), path.join(tmp, 'unexpectedly-moved'));
      await observer.notifier.requestCompare(); await observer.notifier.requestCompare();
      expect(observer.messages).toEqual([`TUT ${id}: task directory vanished`]);
      await actualFs.cp(first.archive!, directory(id), { recursive: true });
      await observer.notifier.requestCompare();
      const second = await store.pruneTask(id, input);
      expect(second.timestamp).toBe(first.timestamp); expect(second.prune_id).not.toBe(first.prune_id);
      await observer.notifier.requestCompare(); await observer.notifier.requestCompare();
      expect(observer.messages).toEqual([`TUT ${id}: task directory vanished`]);
      expect(await store.readPrunedTaskIds()).toEqual([id]);
      expect(observer.readLog).not.toHaveBeenCalled(); expect(observer.launch).not.toHaveBeenCalled();
    } finally { await observer.notifier.close(); }
  });
});

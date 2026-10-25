import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../../dist/core/hub/store.js';
import { startServer } from '../../../dist/core/hub/server.js';
import { constants } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { windowsPiEncodedCwd } from '../../../dist/core/run/windows-pi-session.js';
import { writeConfigKey } from '../../../dist/core/common/config.js';
import { run, collect, lock, lockPath } from './audit.mjs';
// Real native fixture directory: legacy POSIX encoding is not a Windows filename.
const fixtureCwdDirectory = root => process.platform === 'win32' ? windowsPiEncodedCwd(root) : `--${root.slice(1).replaceAll('/', '-')}--`;
// Scale both the requested deadline and injected wait; preserve the strict
// timeout-before-settlement assertions while ordinary NTFS reads have slack.
const ioDeadline = process.platform === 'win32' ? 250 : 25;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'usage-stall-test-')));
  const store = new Store(path.join(root, '.context-hub'));
  await store.whenSwept;
  await writeConfigKey(path.join(root, '.context-hub'), { key: 'usage_audit', value: 'on' });
  const { task_id: id } = await store.createTask({ title: 'Measured', description: 'test', creator: 'test', role: 'human', flow: 'direct' });
  await store.append(id, { role: 'human', content_type: 'note', payload: { summary: 'launch', body: 'test', launch: { role: 'executor', base_version: 0, route: { agent: 'pi', args: [] } } } });
  await store.append(id, { role: 'executor', content_type: 'code_changes', payload: { summary: 'done', body: 'test' } });
  const task = await store.readTask(id), [launch, delivery] = task.versions;
  const dir = path.join(root, 'pi', fixtureCwdDirectory(root));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const bytes = [
    { type: 'session', version: 3, cwd: root, timestamp: launch.timestamp },
    { type: 'message', timestamp: launch.timestamp, message: { role: 'user' } },
    { type: 'message', timestamp: new Date(Date.parse(delivery.timestamp) + 100).toISOString(), message: { role: 'assistant', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, totalTokens: 37, cost: { total: 0.125 } } } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(file, bytes);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(lockPath(root), { force: true }); });
  return { root, id, file, bytes, store, hub: { list: () => store.listTasks(), read: id => store.readTask(id) },
    options: { root, piRoot: path.join(root, 'pi'), codexRoot: path.join(root, 'codex'), watch: true, requestTimeoutMs: ioDeadline, intervalMs: 5, timeoutMs: 2000 } };
}

function capture(t) {
  const lines = [], original = process.stderr.write;
  process.stderr.write = text => { lines.push(String(text)); return true; };
  t.after(() => { process.stderr.write = original; });
  return lines;
}

// Rescue the injected wait so the old implementation fails assertions instead
// of hanging the runner. Each selected call is pending past the I/O deadline.
for (const gate of [1, 2, 3]) test(`configuration wait at gate ${gate} counts a failure and recovers`, async t => {
  const f = await fixture(t), lines = capture(t), ac = new AbortController();
  let checks = 0, reports = 0;
  await run({ ...f.options, signal: ac.signal }, {
    enabled: async () => { if (++checks === gate) await delay(ioDeadline + 115); return true; },
    collect: async () => [],
    report: () => { if (++reports >= 2) ac.abort(); },
    setInterval: fn => { fn(); return setInterval(fn, 5); },
  });
  assert.match(lines.join(''), /pass failed.*LOCAL_IO_TIMEOUT/);
  assert.ok(lines.some(l => l.startsWith('{') && JSON.parse(l).consecutive_failures > 0));
  assert.equal(reports, 2);
});

for (const operation of ['config-read', 'readdir', 'stat', 'readFile', 'usage-read', 'task-lstat']) {
  test(`pending ${operation} fails the pass before recovery and preserves successful accounting`, async t => {
    const f = await fixture(t), lines = capture(t), ac = new AbortController();
    // Establish a valid snapshot so a failed read must not replace it.
    await collect({ ...f.options, watch: false }, { hub: f.hub });
    const usage = path.join(f.root, '.context-hub', 'tasks', f.id, 'usage.json');
    const before = await fs.readFile(usage, 'utf8');
    const method = operation === 'config-read' || operation === 'usage-read' ? 'readFile' : operation === 'task-lstat' ? 'lstat' : operation;
    const original = fs[method];
    let injected = false, sawFailureBeforeRelease = false, settled;
    fs[method] = async (...args) => {
      const target = String(args[0]);
      const selected = operation === 'config-read' ? path.basename(target) === 'config.json' : operation === 'usage-read' ? target === usage
        : operation === 'task-lstat' ? target === path.dirname(usage) : target === f.file || (operation === 'readdir' && target.startsWith(path.join(f.root, 'pi') + path.sep));
      if (selected && !injected) {
        injected = true;
        await (settled = delay(ioDeadline + 115).then(() => { sawFailureBeforeRelease = lines.some(l => /pass failed.*LOCAL_IO_TIMEOUT/.test(l)); }));
      }
      return original.apply(fs, args);
    };
    syncBuiltinESMExports();
    t.after(() => { fs[method] = original; syncBuiltinESMExports(); });
    await run({ ...f.options, signal: ac.signal }, { hub: f.hub, report: () => ac.abort() });
    await settled;
    assert.ok(injected);
    assert.ok(sawFailureBeforeRelease, 'deadline must count the failed pass before the injected I/O resolves');
    assert.equal(await fs.readFile(usage, 'utf8'), before);
    assert.equal(JSON.parse(await fs.readFile(usage, 'utf8')).total.total_tokens, 37);
  });
}

test('heartbeat fingerprints progress and visibly warns when a pass stops advancing', async t => {
  const f = await fixture(t), lines = capture(t), ac = new AbortController();
  let passes = 0;
  await run({ ...f.options, stallTimeoutMs: 30, signal: ac.signal }, {
    enabled: async () => true,
    collect: async () => { if (++passes === 2) await delay(100); return []; },
    report: () => { if (passes === 2) ac.abort(); },
    setInterval: fn => { fn(); return setInterval(fn, 5); },
  });
  const beats = lines.filter(l => l.startsWith('{')).map(JSON.parse).filter(b => b.event === 'heartbeat');
  assert.ok(beats.some(b => b.pass_id === 2 && b.phase === 'collect'));
  assert.ok(beats.every(b => Number.isFinite(Date.parse(b.last_progress_at))));
  assert.match(lines.join(''), /PASS_STALLED/);
});

test('success-time freeze warns even while failed passes keep making progress, then clears on recovery', async t => {
  const f = await fixture(t), lines = capture(t), ac = new AbortController();
  let tick, passes = 0, failingSince;
  await run({ ...f.options, stallTimeoutMs: 30, signal: ac.signal }, {
    enabled: async () => true,
    setInterval: fn => { tick = fn; return setInterval(fn, 5); },
    collect: async () => {
      passes++;
      if (passes === 1) { failingSince = Date.now(); return []; }
      if (Date.now() - failingSince < 100) throw Error('transient failure');
      return [];
    },
    report: () => {},
    sleep: async () => { tick(); if (passes > 2 && Date.now() - failingSince >= 110) ac.abort(); await delay(5); },
  });
  const beats = lines.filter(l => l.startsWith('{')).map(JSON.parse).filter(b => b.event === 'heartbeat');
  assert.match(lines.join(''), /PASS_STALLED/);
  assert.ok(new Set(beats.map(b => b.pass_id)).size > 2);
  assert.ok(beats.some(b => b.stalled && b.consecutive_failures > 0));
  assert.equal(beats.at(-1).stalled, false);
  assert.equal(beats.at(-1).consecutive_failures, 0);
});

for (const method of ['writeFile', 'rename', 'unlink']) test(`timed-out ${method} keeps the writer lock until settlement, then recovers`, async t => {
  const f = await fixture(t), lines = capture(t), ac = new AbortController();
  const original = fs[method];
  let injected = false, finish, began;
  const entered = new Promise(resolve => { began = resolve; });
  fs[method] = async (...args) => {
    if (!injected && path.basename(String(args[0])).startsWith('.usage-')) {
      injected = true; began();
      await new Promise(resolve => { finish = resolve; });
    }
    return original.apply(fs, args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs[method] = original; syncBuiltinESMExports(); });
  let passes = 0, reports = 0;
  const running = run({ ...f.options, signal: ac.signal }, {
    hub: f.hub,
    collect: (options, deps) => { passes++; return collect(options, deps); },
    report: () => { reports++; ac.abort(); },
    setInterval: fn => setInterval(fn, 5),
  });
  try {
    await entered;
    await delay(ioDeadline + 45);
    assert.match(lines.join(''), /LOCAL_IO_TIMEOUT/);
    assert.ok(lines.some(l => l.startsWith('{') && JSON.parse(l).consecutive_failures === 1));
    assert.equal(passes, 1); assert.equal(reports, 0);
    await assert.rejects(lock(f.root), /audit_locked/);
  } finally { finish(); await running; }
  assert.equal(reports, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.context-hub', 'tasks', f.id, 'usage.json'), 'utf8')).total.total_tokens, 37);
  await assert.rejects(fs.stat(lockPath(f.root)), { code: 'ENOENT' });
});

async function until(predicate, ms = 5000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > ms) throw Error('test wait deadline'); await delay(10); }
}
function child(t, args) {
  const proc = spawn(process.execPath, args, { env: { ...process.env, UV_THREADPOOL_SIZE: '4' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', b => { stdout += b; }); proc.stderr.on('data', b => { stderr += b; });
  const closed = once(proc, 'close');
  const rescue = setTimeout(() => proc.kill('SIGKILL'), 8000);
  t.after(async () => { clearTimeout(rescue); if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await closed; });
  return { proc, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

// Real native waits, isolated from the test runner's libuv pool. The parent
// opens only its own FIFO fixtures, releases the injection, then checks reuse.
for (const mode of ['pool', 'fifo']) test(`native ${mode} stall is visible and the same watcher resumes`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const blockers = Array.from({ length: 4 }, (_, i) => path.join(f.root, `blocker-${i}`));
  if (mode === 'pool') for (const file of blockers) execFileSync('mkfifo', [file]);
  const worker = `
    import fs from 'node:fs/promises';
    import { execFileSync } from 'node:child_process';
    import { Store } from ${JSON.stringify(new URL('../../../dist/core/hub/store.js', import.meta.url).href)};
    import { run } from ${JSON.stringify(new URL('./audit.mjs', import.meta.url).href)};
    import { files } from ${JSON.stringify(new URL('./sessions.mjs', import.meta.url).href)};
    const f = JSON.parse(process.argv[1]), mode = process.argv[2];
    const store = new Store(f.root + '/.context-hub'); await store.whenSwept;
    const ac = new AbortController(); let passes = 0, swapped = false;
    await run({ ...f.options, requestTimeoutMs: 60, timeoutMs: 6000, signal: ac.signal }, {
      hub: { list: () => store.listTasks(), read: id => store.readTask(id) },
      setInterval: fn => setInterval(fn, 10),
      files: async root => {
        const found = await files(root);
        if (mode === 'fifo' && passes === 1 && !swapped && found.includes(f.file)) {
          swapped = true; await fs.unlink(f.file); execFileSync('mkfifo', [f.file]);
          console.log('INJECTED');
        }
        return found;
      },
      report: () => {
        if (++passes === 1 && mode === 'pool') {
          for (let i = 0; i < 4; i++) void fs.open(f.root + '/blocker-' + i, 'r').then(h => h.close());
          console.log('INJECTED');
        }
        if (passes >= 2) { console.log('RECOVERED'); ac.abort(); }
      },
    });
  `;
  const w = child(t, ['--input-type=module', '-e', worker, JSON.stringify({ root: f.root, file: f.file, options: f.options }), mode]);
  await until(() => w.stdout.includes('INJECTED'));
  // On pre-fix code this assertion times out; the child's rescue prevents a hang.
  await until(() => /pass failed.*LOCAL_IO_TIMEOUT/.test(w.stderr));
  const handles = [];
  try {
    for (const file of mode === 'pool' ? blockers : [f.file]) handles.push(await fs.open(file, constants.O_RDWR | constants.O_NONBLOCK));
    if (mode === 'fifo') {
      await fs.writeFile(f.file + '.replacement', f.bytes);
      await fs.rename(f.file + '.replacement', f.file);
    }
    await delay(40);
  } finally { for (const h of handles) await h.close(); }
  const [code] = await w.closed;
  assert.equal(code, 0, w.stderr);
  assert.match(w.stdout, /RECOVERED/);
  assert.ok(w.stderr.split('\n').filter(l => l.startsWith('{')).map(JSON.parse).every(b => Number.isInteger(b.pass_id) && typeof b.phase === 'string'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.context-hub', 'tasks', f.id, 'usage.json'), 'utf8')).total.total_tokens, 37);
});

test('SIGKILL and restart reconcile deliveries through a temporary live Hub on the first pass', async t => {
  const f = await fixture(t), server = await startServer({ root: path.join(f.root, '.context-hub'), port: 0 });
  t.after(() => server.close());
  const args = ['scripts/usage-audit/run.mjs', '--root', f.root, '--url', server.url, '--pi-root', f.options.piRoot, '--codex-root', f.options.codexRoot];
  const watcher = child(t, [...args, '--watch']);
  await until(() => watcher.stdout.includes(f.id));
  watcher.proc.kill('SIGKILL'); await watcher.closed;
  const { task_id: late } = await f.store.createTask({ title: 'Late', description: 'test', creator: 'test', role: 'human', flow: 'direct' });
  await f.store.append(late, { role: 'human', content_type: 'note', payload: { summary: 'launch', body: 'test', launch: { role: 'executor', base_version: 0, route: { agent: 'pi', args: [] } } } });
  await f.store.append(late, { role: 'executor', content_type: 'code_changes', payload: { summary: 'done', body: 'test' } });
  const laterTask = await f.store.readTask(late);
  const rows = f.bytes.trim().split('\n').map(JSON.parse);
  rows[1].timestamp = laterTask.versions[0].timestamp;
  rows[2].timestamp = new Date(Date.parse(laterTask.versions[1].timestamp) + 100).toISOString();
  await fs.appendFile(f.file, rows.slice(1).map(r => JSON.stringify(r)).join('\n') + '\n');
  const fresh = child(t, [...args, '--backfill']);
  const [code] = await fresh.closed;
  assert.equal(code, 0, fresh.stderr);
  assert.ok(fresh.stdout.split('\n').filter(Boolean).map(JSON.parse).some(r => r.task_id === late && r.total.total_tokens === 37));
  assert.ok(fresh.stdout.split('\n').filter(Boolean).map(JSON.parse).some(r => r.task_id === f.id && r.total.total_tokens === 37));
  await assert.rejects(fs.stat(lockPath(f.root)), { code: 'ENOENT' });
});

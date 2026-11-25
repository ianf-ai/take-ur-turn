import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../../dist/hub/store.js';
import { startServer } from '../../../dist/hub/server.js';
import { constants } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { windowsPiEncodedCwd } from '../../../dist/agents/public/native-compat.js';
import { writeConfigKey } from '../../../dist/core/common/config.js';
import { run, collect, lock, lockPath, TIMEOUT_PASS_LIMIT } from './audit.mjs';
import { localIO } from './io.mjs';
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
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(lockPath(root), { force: true }); await fs.rm(lockPath(root)+'.cursor.json', { force: true }); });
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

for (const gate of ['startup', 'entry', 'exit']) test(`ten consecutive ${gate} config timeouts terminate with structured evidence`, async t => {
  const f = await fixture(t), lines = capture(t);
  let checks = 0, collected = false, waits = 0, released = 0;
  await assert.rejects(run({ ...f.options, timeoutMs: Infinity }, {
    enabled: () => {
      checks++;
      if (gate === 'startup' || (gate === 'entry' && checks > 1) || (gate === 'exit' && collected)) {
        collected = false;
        return new Promise(() => {});
      }
      return true;
    },
    lock: async () => async () => { released++; },
    collect: async () => { collected = true; return []; },
    report: () => {},
    sleep: async () => { waits++; },
  }), { code: 'WATCHER_TIMEOUT_LIMIT' });
  const events = lines.filter(l => l.startsWith('{')).map(JSON.parse);
  const stalls = events.filter(e => e.event === 'IO_STALLED');
  assert.equal(stalls.length, TIMEOUT_PASS_LIMIT);
  assert.deepEqual(stalls.map(e => e.pass_id), Array.from({ length: TIMEOUT_PASS_LIMIT }, (_, i) => i + 1));
  assert.deepEqual(stalls.map(e => e.consecutive_timeouts), stalls.map(e => e.pass_id));
  for (const e of stalls) {
    assert.equal(e.code, 'LOCAL_IO_TIMEOUT');
    assert.equal(e.target, path.join(f.root, '.context-hub', 'config.json'));
    assert.ok(e.elapsed_ms >= ioDeadline - 1);
    assert.equal(e.timeout_ms, ioDeadline);
  }
  assert.equal(events.at(-1).event, 'WATCHER_TIMEOUT_LIMIT');
  assert.equal(events.at(-1).limit, 10);
  assert.equal(waits, 9);
  assert.equal(released, gate === 'startup' ? 0 : 1);
});

test('nine hung real config reads recover in place without changing task records', async t => {
  const f = await fixture(t), lines = capture(t), ac = new AbortController();
  const original = fs.readFile, pending = [], signals = [], taskBefore = await f.store.readTask(f.id);
  let checks = 0, reports = 0;
  fs.readFile = (...args) => {
    if (String(args[0]) === path.join(f.root, '.context-hub', 'config.json') && ++checks < TIMEOUT_PASS_LIMIT) {
      signals.push(args[1].signal);
      return new Promise(resolve => pending.push(() => resolve('{"flow_mode":"manual","usage_audit":"off"}')));
    }
    return original.apply(fs, args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.readFile = original; syncBuiltinESMExports(); });
  await run({ ...f.options, timeoutMs: Infinity, signal: ac.signal }, {
    hub: f.hub,
    report: () => { reports++; ac.abort(); },
  });
  // Late results must not resume an abandoned pass or turn off this watcher.
  for (const settle of pending) settle();
  await delay(0);
  assert.equal(reports, 1);
  assert.equal(pending.length, 9);
  assert.ok(signals.every(signal => signal instanceof AbortSignal && signal.aborted));
  assert.equal(lines.filter(l => l.includes('"event":"IO_STALLED"')).length, 9);
  assert.doesNotMatch(lines.join(''), /WATCHER_TIMEOUT_LIMIT/);
  assert.deepEqual(await f.store.readTask(f.id), taskBefore);
  assert.equal(JSON.parse(await original(path.join(f.root, '.context-hub', 'tasks', f.id, 'usage.json'), 'utf8')).total.total_tokens, 37);
});

for (const interrupt of ['success', 'other-error']) test(`${interrupt} breaks the consecutive timeout streak`, async t => {
  const f = await fixture(t), lines = capture(t), ac = new AbortController();
  let passes = 0;
  await run({ ...f.options, requestTimeoutMs: 2, timeoutMs: Infinity, signal: ac.signal }, {
    enabled: async () => true,
    collect: async options => {
      passes++;
      if (passes === 10) {
        if (interrupt === 'other-error') throw Error('ordinary transient failure');
        return [];
      }
      if (passes === 20) { ac.abort(); return []; }
      return localIO('session-read', options, () => new Promise(() => {}), false, f.file);
    },
    report: () => {},
    sleep: async () => {},
  });
  assert.equal(passes, 20);
  const stalls = lines.filter(l => l.startsWith('{')).map(JSON.parse).filter(e => e.event === 'IO_STALLED');
  assert.deepEqual(stalls.map(e => e.consecutive_timeouts), [...Array.from({ length: 9 }, (_, i) => i + 1), ...Array.from({ length: 9 }, (_, i) => i + 1)]);
  assert.ok(stalls.every(e => e.target === f.file));
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
    logHeartbeat: line => lines.push(line),
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

test('success-time freeze warns even while failed passes keep making progress, then clears on recovery', {
  skip: ['dev-mac', 'win32-gate'].includes(process.env.TUT_TEST_PROFILE ?? '') ? 'measure: real-clock freeze/recovery latency' : false,
}, async t => {
  const f = await fixture(t), lines = capture(t), ac = new AbortController();
  let tick, passes = 0, failingSince;
  await run({ ...f.options, stallTimeoutMs: 30, signal: ac.signal }, {
    logHeartbeat: line => lines.push(line),
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
  assert.match(lines.join(''), /PASS_SUCCESS_OVERDUE/);
  assert.doesNotMatch(lines.join(''), /PASS_STALLED/);
  assert.ok(new Set(beats.map(b => b.pass_id)).size > 2);
  assert.ok(beats.some(b => b.success_overdue && b.consecutive_failures > 0));
  assert.equal(beats.at(-1).stalled, false);
  assert.equal(beats.at(-1).success_overdue, false);
  assert.equal(beats.at(-1).consecutive_failures, 0);
});

test('advancing calibration and adaptive planned sleep never report PASS_STALLED; overdue sleep does', async t => {
  const f=await fixture(t),lines=capture(t),ac=new AbortController();let tick;
  // Drive the clock and heartbeat together. A requested 5ms OS timer may
  // legitimately resume after the 30ms stall threshold on Windows.
  let clock=Date.now(),monotonic=0;
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(performance,'now',()=>monotonic);
  const advance=ms=>{clock+=ms;monotonic+=ms;};
  await run({...f.options,stallTimeoutMs:30,signal:ac.signal},{
    logHeartbeat:line=>lines.push(line),enabled:async()=>true,
    setInterval:fn=>{tick=fn;},
    collect:async options=>{for(let i=0;i<12;i++){advance(5);options.onProgress('scan');tick();}return [];},
    sleep:async wait=>{
      assert.ok(wait>=50);advance(40);tick();
      const beats=lines.filter(l=>l.startsWith('{')).map(JSON.parse);
      assert.ok(beats.some(b=>b.planned_sleep));assert.doesNotMatch(lines.join(''),/PASS_STALLED/);
      advance(wait);tick();ac.abort();
    },report:()=>{},
  });
  assert.match(lines.join(''),/PASS_STALLED/);
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
  let passes = 0, reports = 0, tick;
  const running = run({ ...f.options, signal: ac.signal }, {
    hub: f.hub,
    collect: (options, deps) => { passes++; return collect(options, deps); },
    report: () => { reports++; ac.abort(); },
    setInterval: fn => { tick = fn; return setInterval(fn, 5); },
  });
  try {
    await entered;
    // Synchronize on timeout accounting, then drive the injected heartbeat.
    // A timer callback need not run within a fixed 45ms scheduling margin.
    await until(() => lines.some(line => line.includes('LOCAL_IO_TIMEOUT')));
    tick();
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
function child(t, args, env = {}) {
  const proc = spawn(process.execPath, args, { env: { ...process.env, UV_THREADPOOL_SIZE: '4', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', b => { stdout += b; }); proc.stderr.on('data', b => { stderr += b; });
  const closed = once(proc, 'close');
  const rescue = setTimeout(() => proc.kill('SIGKILL'), 8000);
  t.after(async () => { clearTimeout(rescue); if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await closed; });
  return { proc, closed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test('managed CLI persists all ten HTTP timeouts and its terminal reason before self-termination', async t => {
  const f = await fixture(t);
  const peer = createServer(() => {}); // Accept each request, never send headers.
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve)); });
  const w = child(t, ['scripts/usage-audit/run.mjs', '--watch', '--root', f.root,
    '--url', `http://127.0.0.1:${peer.address().port}`, '--interval-ms', '1'],
  { TUT_POWER_SESSION: 'test-managed-http-timeout', TUT_USAGE_AUDIT_TIMEOUT_MS: '60' });
  const [code, signal] = await w.closed;
  assert.equal(code, process.platform === 'win32' ? 1 : null);
  assert.equal(signal, process.platform === 'win32' ? null : 'SIGTERM');
  assert.equal(w.stdout, ''); assert.equal(w.stderr, '');
  const log = await fs.readFile(path.join(f.root, '.context-hub/logs/diagnostics/usage-audit.log'), 'utf8');
  const events = log.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'IO_STALLED').length, 10);
  assert.equal(events.at(-1).event, 'WATCHER_TIMEOUT_LIMIT');
  assert.equal(events.at(-1).consecutive_timeouts, 10);
  assert.match(log, /usage-audit: WATCHER_TIMEOUT_LIMIT: 10 consecutive passes timed out/);
});

for (const managed of [false, true]) for (const mode of ['config-fifo', 'pool']) test(`CLI terminates nonzero after ten native ${mode} timeouts without external rescue (managed=${managed})`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), config = path.join(f.root, '.context-hub', 'config.json');
  const server = await startServer({ root: path.join(f.root, '.context-hub'), port: 0 });
  t.after(() => server.close());
  const args = [];
  if (mode === 'config-fifo') {
    await fs.unlink(config);
    execFileSync('mkfifo', [config]);
  } else {
    const blockers = Array.from({ length: 4 }, (_, i) => path.join(f.root, `blocked-${i}`));
    for (const file of blockers) execFileSync('mkfifo', [file]);
    // Occupy all native workers only after the lock is claimed, at collect's
    // first config read. Subsequent config and lock-release reads cannot run.
    const preload = path.join(f.root, 'block-pool.mjs');
    await fs.writeFile(preload, `import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.readFile; let checks = 0;
      fs.readFile = async (...args) => {
        const value = await original.apply(fs, args);
        if (String(args[0]) === ${JSON.stringify(config)} && ++checks === 3)
          for (const file of ${JSON.stringify(blockers)}) void fs.open(file, 'r');
        return value;
      };
      syncBuiltinESMExports();`);
    args.push('--import', preload);
  }
  const w = child(t, [...args, 'scripts/usage-audit/run.mjs', '--watch', '--root', f.root,
    '--url', server.url, '--interval-ms', '5'], { TUT_USAGE_AUDIT_TIMEOUT_MS: '60', TUT_POWER_SESSION: managed ? 'test-managed-native-timeout' : '' });
  const [code, signal] = await w.closed;
  assert.equal(signal, 'SIGTERM', w.stderr); // shell status 143; never the rescue's SIGKILL
  assert.equal(code, null, w.stderr);
  if (managed) assert.equal(w.stderr, '');
  else {
    const events = w.stderr.split('\n').filter(l => l.startsWith('{')).map(JSON.parse);
    assert.equal(events.filter(e => e.event === 'IO_STALLED').length, 10);
    assert.equal(events.at(-1).event, 'WATCHER_TIMEOUT_LIMIT');
    assert.equal(events.at(-1).consecutive_timeouts, 10);
  }
  assert.equal(w.stdout, '');
  if (mode === 'pool') {
    if (!managed) assert.match(w.stderr, /lock release read timed out/);
    // The untouched lock is now stale; the original self-healing protocol
    // can reclaim it after the process is observably dead.
    const release = await lock(f.root);
    await release();
  }
  await assert.rejects(fs.stat(lockPath(f.root)), { code: 'ENOENT' });
});

// Real native waits, isolated from the test runner's libuv pool. The parent
// opens only its own FIFO fixtures, releases the injection, then checks reuse.
for (const mode of ['pool', 'fifo']) test(`native ${mode} stall is visible and the same watcher resumes`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const blockers = Array.from({ length: 4 }, (_, i) => path.join(f.root, `blocker-${i}`));
  if (mode === 'pool') for (const file of blockers) execFileSync('mkfifo', [file]);
  const worker = `
    import fs from 'node:fs/promises';
    import { execFileSync } from 'node:child_process';
    import { Store } from ${JSON.stringify(new URL('../../../dist/hub/store.js', import.meta.url).href)};
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

/** Real Windows regression tests. Run against the built package with node --test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rename, symlink, rm, stat, realpath, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { openRunFile } from '../dist/core/hub/run-file.js';
import { createWindowsRunFileSession, readWindowsRunMeta, statWindowsRunFile } from '../dist/core/hub/windows-run-file.js';
import { RunReadStore } from '../dist/core/hub/run-store.js';
import { RunStore } from '../dist/core/run/store.js';
import { listRuns, attachRun } from '../dist/core/run/control.js';
import { complete } from '../dist/core/run/store.js';
import { ensureConfig, readConfig, writeConfigKey } from '../dist/core/common/config.js';

const windows = process.platform === 'win32';
const id = '20261023T000000000Z-abcd1234';
const options = { skip: !windows, timeout: 120000 };
async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tut-win-read-'));
  try {
    const hub = path.join(root, '.context-hub');
    const dir = path.join(hub, 'runs', id);
    await mkdir(dir, { recursive: true });
    const meta = { run_id: id, pid: process.pid, pgid: process.pid, supervisor_pid: process.pid + 1,
      argv: ['node', '中😀'], cwd: root, started_at: '2026-10-23T00:00:00Z', status: 'exited', ended_at: '2026-10-23T00:00:01Z' };
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    await writeFile(path.join(dir, 'log'), '中😀\r\n\npartial');
    await fn({ root, hub, dir, meta, log: path.join(dir, 'log') });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('logInfo observes regular log attributes and refuses linked, dangling and non-regular logs', { timeout: 30000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tut-log-info-')));
  const store = new RunStore(root), runId = store.create();
  const log = path.join(store.directory(runId), 'log');
  const target = path.join(root, 'target');
  // Attribute queries must also work on logs exceeding the metadata read cap.
  const original = Buffer.alloc(2 * 1024 * 1024, 0x61);
  try {
    await writeFile(log, original);
    await utimes(log, new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T12:34:56Z'));
    const before = await stat(log);
    assert.equal(store.logInfo(runId).mtimeMs, before.mtimeMs);
    if (windows) {
      const info = statWindowsRunFile(log);
      assert.equal(info.size, original.length);
      assert.equal(info.mtimeMs, before.mtimeMs);
      assert.equal(info.isFile(), true);
    }
    assert.deepEqual(await readFile(log), original);
    await rename(log, target);
    await symlink(target, log, 'file');
    assert.throws(() => store.logInfo(runId));
    assert.deepEqual(await readFile(target), original);
    await rm(log);
    await symlink(path.join(root, 'absent'), log, 'file');
    assert.throws(() => store.logInfo(runId));
    await rm(log);
    await mkdir(log);
    assert.throws(() => store.logInfo(runId), /not a regular/);
    assert.deepEqual(await readFile(target), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows logInfo refuses an ancestor junction and leaves its target unchanged', options, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tut-log-ancestor-')));
  try {
    const target = path.join(root, 'target'); await mkdir(target);
    const store = new RunStore(target), runId = store.create();
    const log = path.join(store.directory(runId), 'log'); await writeFile(log, 'untouched');
    const linked = path.join(root, 'linked'); await symlink(target, linked, 'junction');
    assert.throws(() => new RunStore(linked).logInfo(runId), /not a regular/);
    assert.equal(await readFile(log, 'utf8'), 'untouched');
    // .NET FILETIME and Node's seconds/nanoseconds conversion can round a
    // fractional millisecond differently; fixed whole-ms mtime is exact above.
    assert.ok(Math.abs(store.logInfo(runId).mtimeMs - (await stat(log)).mtimeMs) < 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('config replacement coexists with a safe reader, stays bounded and retains queued keys', { timeout: 30000 }, () => fixture(async ({ hub: fixtureHub }) => {
  // The positive case must not include macOS's /var -> /private/var link.
  const hub = await realpath(fixtureHub);
  await ensureConfig(hub);
  const file = path.join(hub, 'config.json'), before = await readFile(file);
  let handle = await openRunFile(file);
  try {
    if (windows) {
      const start = performance.now();
      await assert.rejects(writeConfigKey(hub, { key: 'usage_audit', value: 'on' }),
        e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
      assert.ok(performance.now() - start < 5000);
      assert.deepEqual(await readFile(file), before);
      assert.equal((await readConfig(hub)).usage_audit, undefined);
    } else {
      await writeConfigKey(hub, { key: 'usage_audit', value: 'on' });
      const old = Buffer.alloc(before.length);
      assert.equal((await handle.read(old, 0, old.length, 0)).bytesRead, before.length);
      assert.deepEqual(old, before);
    }
    await handle.close(); handle = await openRunFile(file);
    const first = writeConfigKey(hub, { key: 'usage_audit', value: 'on' });
    const second = writeConfigKey(hub, { key: 'launch.catchup', value: 'on' });
    // A transient reader releases inside the SAME publication attempt.
    await new Promise(resolve => setTimeout(resolve, 100));
    await handle.close(); handle = undefined;
    await Promise.all([first, second]);
    assert.equal((await readConfig(hub)).usage_audit, 'on');
    assert.equal((await readConfig(hub)).launch.catchup, 'on');
  } finally { await handle?.close(); }
}));

test('Windows native reader: bytes, identity, read-only sharing and bounded requests', options, () => fixture(async ({ log, dir }) => {
  const before = await stat(log);
  const handle = await openRunFile(log);
  try {
    const s = await handle.stat();
    assert.equal(s.size, before.size); assert.equal(s.dev, before.dev); assert.equal(s.ino, before.ino);
    const buffer = Buffer.alloc(3);
    assert.equal((await handle.read(buffer, 0, 3, 1)).bytesRead, 3);
    assert.deepEqual(buffer, (await readFile(log)).subarray(1, 4));
    await assert.rejects(handle.read(Buffer.alloc(1), 0, 1048577, 0), RangeError);
    // Both leaf and every ancestor are pinned, including while no read is active.
    for (const name of [log, dir, path.dirname(dir)]) {
      await assert.rejects(rename(name, name + '-moved'), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
    }
    await appendFile(log, '\r\nappend'); // ShareWrite permits the real logger.
    assert.equal((await handle.stat()).size, before.size + 8);
  } finally { await handle.close(); }
  await rename(log, log + '-moved'); // Handles really are released by close.
}));

test('safe metadata handles coexist with atomic publication and retain the original bytes', { timeout: 120000 }, async () => {
  // Real safe opens reject macOS /var -> /private/var, including temp roots.
  const { realpath } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tut-meta-share-')));
  const store = new RunStore(root);
  const runId = store.create();
  const meta = { run_id: runId, pid: process.pid, pgid: process.pid, supervisor_pid: process.pid + 1,
    argv: ['fixture'], cwd: root, started_at: new Date().toISOString(), status: 'running' };
  let handle;
  try {
    await store.initialize(runId, meta);
    const file = path.join(store.directory(runId), 'meta.json');
    const original = await readFile(file);
    handle = await openRunFile(file);
    const start = performance.now();
    if (windows) {
      await assert.rejects(store.updateMeta(runId, m => ({ ...m, identity_probe: 'while-held' })),
        e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
      assert.deepEqual(await readFile(file), original);
    } else {
      await store.updateMeta(runId, m => ({ ...m, identity_probe: 'while-held' }));
      assert.equal(store.read(runId).identity_probe, 'while-held');
    }
    assert.ok(performance.now() - start < 5000, 'publication must fail visibly without hanging');
    const buffer = Buffer.alloc(original.length);
    assert.equal((await handle.read(buffer, 0, buffer.length, 0)).bytesRead, original.length);
    assert.deepEqual(buffer, original);
    await handle.close(); handle = undefined;
    await store.updateMeta(runId, m => ({ ...m, identity_probe: 'after-close' }));
    assert.equal(store.read(runId).identity_probe, 'after-close');
  } finally { await handle?.close(); await rm(root, { recursive: true, force: true }); }
});

test('Windows atomic publication yields to a transient safe reader', options, () => fixture(async ({ root, dir, meta }) => {
  const store = new RunStore(root);
  let handle = await openRunFile(path.join(dir, 'meta.json'));
  try {
    const updating = store.updateMeta(id, m => ({ ...m, identity_probe: 'transient-reader' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    await handle.close(); handle = undefined;
    await updating;
    assert.equal(store.read(id).identity_probe, 'transient-reader');
    assert.equal(store.read(id).run_id, meta.run_id);
  } finally { await handle?.close(); }
}));

test('Windows native stop ladder commits complete metadata while safe readers poll', options, async () => {
  const { startRun, stopRun } = await import('../dist/core/run/control-windows.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'tut-publish-ladder-'));
  const store = new RunStore(root);
  // Retain the archive as evidence; the test-owned target has a finite lifetime.
  const runId = await startRun(store, [process.execPath, '-e',
    'process.on("SIGBREAK",()=>console.log("break received"));console.log("ready");setTimeout(()=>{},120000)'], root);
  const dir = store.directory(runId);
  const deadline = performance.now() + 30000;
  while (!(await readFile(path.join(dir, 'log'), 'utf8')).includes('ready')) {
    assert.ok(performance.now() < deadline, 'target readiness deadline');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // A real PowerShell safe read compiles a bridge per metadata poll. Allow the
  // acceptance observer to wait for the native budgets plus that I/O cost;
  // the production defaults and control-stage budgets remain unchanged.
  const result = await stopRun(store, runId, { waitMs: 90000 });
  assert.equal(result.success, true);
  assert.deepEqual(result.meta.stop_request.actions.map(a => a.action), ['break', 'taskkill-tree', 'taskkill-tree-force']);
  assert.equal(result.meta.stop_request.result.outcome, 'forced-kill');
  assert.equal(complete(store.read(runId)), true);
  console.log(JSON.stringify({ probe: 'native_stop_ladder', root, run_id: runId, complete: true, result: result.meta.stop_request.result }));
});

test('Windows broker loss commits its error while safe metadata reads poll', options, async () => {
  const { startRun } = await import('../dist/core/run/control-windows.js');
  const { probe } = await import('../dist/core/run/store.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'tut-publish-broker-loss-'));
  const store = new RunStore(root);
  const runId = await startRun(store, [process.execPath, '-e', 'console.log("ready");setTimeout(()=>{},30000)'], root);
  const initial = store.read(runId);
  process.kill(initial.windows.identity.broker_pid); // This test's own broker only.
  let meta;
  const deadline = performance.now() + 45000;
  while (!(meta = store.read(runId)).windows.error) {
    assert.ok(performance.now() < deadline, 'committed broker-loss error deadline');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(complete(meta), false);
  console.log(JSON.stringify({ probe: 'committed_broker_loss', root, run_id: runId, error: meta.windows.error, complete: complete(meta) }));
  while (probe(initial.pid) !== false) {
    assert.ok(performance.now() < deadline, 'finite target exit deadline');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});

test('Windows native reader rejects junctions, symlinks and unsafe names without target bytes', options, () => fixture(async ({ root, dir, log }) => {
  const outside = path.join(root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'log'), 'OUTSIDE_SECRET');
  const junction = path.join(root, 'junction'); await symlink(outside, junction, 'junction');
  await assert.rejects(openRunFile(path.join(junction, 'log')), { code: 'EUNSAFEPATH' });
  const link = path.join(dir, 'link'); await symlink(path.join(outside, 'log'), link, 'file');
  await assert.rejects(openRunFile(link), { code: 'EUNSAFEPATH' });
  for (const file of [log + ':secret', '\\\\.\\NUL', '\\\\?\\' + log, 'C:\\NUL', 'C:\\CON.txt', 'C:\\a\\..\\log', log + '.', log + ' ', '\\\\server\\share\\log']) {
    await assert.rejects(openRunFile(file), { code: 'EUNSAFEPATH' });
  }
  await assert.rejects(openRunFile(path.join(dir, 'missing')), { code: 'ENOENT' });
  await assert.rejects(openRunFile(dir), { code: 'EUNSAFEPATH' });
}));

test('Windows RunReadStore preserves byte cursors, errors, bounded tail and missing file semantics', options, () => fixture(async ({ hub, dir, log }) => {
  const store = new RunReadStore(hub);
  const raw = await readFile(log); const chunks = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const page = await store.readLogRange(id, cursor, 3);
    assert.equal(page.from, cursor); assert.equal(page.size, raw.length);
    chunks.push(Buffer.from(page.data, 'base64')); cursor = page.next;
  }
  assert.deepEqual(Buffer.concat(chunks), raw);
  assert.equal((await store.readLogRange(id, raw.length)).data, '');
  await assert.rejects(store.readLogRange(id, raw.length + 1), { code: 'RANGE_NOT_SATISFIABLE' });
  await assert.rejects(store.readLogRange(id, 0, 65537), RangeError);
  const [run] = await store.snapshot();
  assert.equal(run.degraded, false); assert.equal(run.log_available, true);
  assert.deepEqual(run.log_tail, ['中😀', '', 'partial']);
  await writeFile(log, '😀'.repeat(30000) + '中');
  const huge = (await store.snapshot())[0];
  assert.equal(huge.log_truncated, true); assert.equal(huge.log_tail.join('').includes('�'), false);
  assert.ok(Buffer.byteLength(huge.log_tail.join('\n')) <= 65536);
  await writeFile(path.join(dir, 'meta.json'), 'x'.repeat(1048577));
  assert.throws(() => readWindowsRunMeta(path.join(dir, 'meta.json')), { code: 'EFBIG' });
  await rm(log);
  assert.ok((await store.snapshot())[0].issues.some(i => i.code === 'log_missing'));
}));

test('Windows ps/attach retain unknown group state, raw CRLF/UTF-8/tail and backpressure', options, () => fixture(async ({ root, log, dir }) => {
  const store = new RunStore(root);
  // The legacy snapshot still reports unknown group liveness. The Windows native
  // attach contract requires an explicit Windows envelope, so use declared
  // completed policy input for the byte-reader checks below, not a fake live
  // process or an implied successful native stop.
  const legacy = listRuns(store);
  assert.equal(legacy.errors.length, 0); assert.equal(legacy.runs[0].group_alive, null);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const invoke = promisify(execFile);
  const env = { ...process.env, TUT_HUB_ROOT: root };
  const legacyCliPs = await invoke(process.execPath, [cli, 'ps', '--json'], { env, timeout: 30000 });
  assert.equal(JSON.parse(legacyCliPs.stdout).runs[0].group_alive, null);
  await store.updateMeta(id, meta => ({ ...meta, pid: 2147483000, pgid: 2147483000, supervisor_pid: 2147482999,
    control_protocol: 'windows-console-v1', exit_code: 0,
    windows: { identity: { attempt_id: '11111111-1111-4111-8111-111111111111', broker_pid: 2147482998,
      broker_creation_time: '100', root_creation_time: '200', job_id: 'a'.repeat(32) },
      observation: { root_exited: true, job_empty: true, exit_code: 0, observed_at: '2026-10-23T00:00:01Z' } } }));
  const beforeMeta = await readFile(path.join(dir, 'meta.json'));
  const line = i => `line${i}:${'中😀'.repeat(300)}\r\n`;
  const bytes = Buffer.from(Array.from({ length: 80 }, (_, i) => line(i)).join('') + '半行🙂');
  await writeFile(log, bytes);
  const ps = listRuns(store);
  assert.equal(ps.errors.length, 0); assert.equal(ps.runs[0].group_alive, false);
  const chunks = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, done) { chunks.push(chunk); setTimeout(done, 5); } });
  assert.equal(await attachRun(store, id, output), 0);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(Array.from({ length: 49 }, (_, i) => line(i + 31)).join('') + '半行🙂'));
  assert.ok(chunks.length > 1);
  const cliPs = await invoke(process.execPath, [cli, 'ps', '--json'], { env, timeout: 30000 });
  assert.equal(JSON.parse(cliPs.stdout).runs[0].group_alive, false);
  const cliAttach = await invoke(process.execPath, [cli, 'attach', id], { env, timeout: 30000, encoding: 'buffer' });
  assert.deepEqual(cliAttach.stdout, Buffer.concat(chunks));
  assert.deepEqual(await readFile(log), bytes); assert.deepEqual(await readFile(path.join(dir, 'meta.json')), beforeMeta);
}));

test('Windows board and log HTTP endpoints consume the safe reader', options, () => fixture(async ({ hub, log, dir }) => {
  const { startServer } = await import('../dist/core/hub/server.js');
  const running = await startServer({ root: hub, port: 0 });
  try {
    const board = await fetch(running.url + '/board');
    assert.equal(board.status, 200); assert.match(await board.text(), /任务与运行/);
    const response = await fetch(running.url + '/runs');
    assert.equal(response.status, 200);
    const { runs } = await response.json();
    assert.equal(runs[0].degraded, false); assert.equal(runs[0].log_available, true);
    assert.deepEqual(runs[0].log_tail, ['中😀', '', 'partial']);
    const page = await fetch(running.url + `/runs/${id}/log?from=1&limit=3`);
    assert.equal(page.status, 200);
    const range = await page.json();
    assert.equal(range.next, 4); assert.deepEqual(Buffer.from(range.data, 'base64'), (await readFile(log)).subarray(1, 4));
    await rm(log); await symlink(path.join(dir, 'meta.json'), log, 'file');
    const unsafe = await fetch(running.url + `/runs/${id}/log`);
    assert.equal(unsafe.status, 500); assert.equal((await unsafe.text()).includes(dir), false);
    const degraded = (await (await fetch(running.url + '/runs')).json()).runs[0];
    assert.ok(degraded.issues.some(i => i.code === 'unsafe_path')); assert.equal(degraded.log_available, false);
  } finally { await running.close(); }
}));

test('Windows conflicting ancestor delete intent makes the reader fail visibly', options, () => fixture(async ({ dir, log }) => {
  const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public static class DeleteIntent { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFileW(string n,uint a,uint s,IntPtr p,uint d,uint f,IntPtr t); }'
$p=([Console]::ReadLine() | ConvertFrom-Json)
$h=[DeleteIntent]::CreateFileW([string]$p.file,0x10000,7,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
if ($h.IsInvalid) { throw 'delete-intent open failed' }
try { [Console]::WriteLine('held'); $null=[Console]::ReadLine() } finally { $h.Dispose() }
`;
  const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('holder startup timeout')); }, 15000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('holder exited')); });
      child.stdout.once('data', b => { clearTimeout(timer); String(b).trim() === 'held' ? resolve() : reject(new Error('holder failed')); });
      child.stdin.write(JSON.stringify({ file: dir }) + '\n');
    });
    await assert.rejects(openRunFile(log), { code: 'EUNSAFEPATH' });
  } finally {
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end('\n');
    });
  }
  const file = await openRunFile(log); await file.close();
}));

test('Windows four-run snapshots load through the real board poller within its unchanged deadline', options, () => fixture(async ({ root, hub, meta, dir }) => {
  const { startServer } = await import('../dist/core/hub/server.js');
  const { BOARD_CORE_SCRIPT } = await import('../dist/core/hub/board-client.js');
  await writeFile(path.join(dir, 'log'), 'ordinary short log\r\n');
  for (let i = 1; i < 4; i++) {
    const runId = `20261023T00000000${i}Z-abcd1234`;
    const runDir = path.join(hub, 'runs', runId);
    await mkdir(runDir);
    await writeFile(path.join(runDir, 'meta.json'), JSON.stringify({ ...meta, run_id: runId }));
    await writeFile(path.join(runDir, 'log'), 'ordinary short log\r\n');
  }
  const running = await startServer({ root: hub, port: 0 });
  const context = vm.createContext({ setTimeout, clearTimeout, AbortController, Date, fetch });
  vm.runInContext(BOARD_CORE_SCRIPT, context);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = performance.now();
      let poller;
      try {
        const state = await new Promise(resolve => {
          poller = context.createPoller(running.url + '/runs', 'runs',
            value => path.resolve(value).toLowerCase() === path.resolve(root).toLowerCase(), resolve);
        });
        const elapsed = Math.round(performance.now() - start);
        console.log(JSON.stringify({ probe: 'actual_board_poller', attempt, elapsed_ms: elapsed, error: state.error, runs: state.snapshot?.runs.length }));
        assert.equal(state.error, null); assert.ok(state.lastSuccess);
        assert.equal(state.snapshot.runs.length, 4);
        assert.ok(state.snapshot.runs.every(r => !r.degraded && r.log_available));
        assert.ok(elapsed < 5000, `board deadline exceeded: ${elapsed}ms`);
        // Continue from a run selected out of the actual board snapshot.
        const page = await fetch(running.url + `/runs/${state.snapshot.runs[0].run_id}/log?from=0&limit=3`);
        assert.equal(page.status, 200);
        const range = await page.json();
        assert.equal(range.next, 3); assert.equal(Buffer.from(range.data, 'base64').toString(), 'ord');
      } finally { poller?.stop(); }
    }
  } finally { await running.close(); }
}));

test('Windows snapshot session releases chains between files, recovers on independent opens and closes active chains on EOF', options, () => fixture(async ({ root, dir, log }) => {
  const session = createWindowsRunFileSession();
  const moved = dir + '-moved';
  try {
    const first = await session.open(log); await first.close();
    await rename(dir, moved); await rename(moved, dir); // close ack already released ALL ancestors.
    const outside = path.join(root, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'log'), 'OUTSIDE_SECRET');
    const junction = path.join(root, 'junction'); await symlink(outside, junction, 'junction');
    await assert.rejects(session.open(path.join(junction, 'log')), { code: 'EUNSAFEPATH' });
    const next = await session.open(log);
    assert.equal((await next.stat()).size, (await stat(log)).size);
    await session.close(); // Also closes a file the consumer did not close first.
    await rename(dir, moved); await rename(moved, dir);
    await assert.rejects(next.stat(), { code: 'EIO' });
    await assert.rejects(session.open(log), { code: 'EIO' });
  } finally { await session.close(); }
}));

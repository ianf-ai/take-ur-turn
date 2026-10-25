import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../../dist/core/hub/store.js';
import { RunStore } from '../../../dist/core/run/store.js';
import { parse } from '../run.mjs';
import { piDirectory, bindWindowsPi } from '../lib/paths.mjs';
import { extract, attribute } from '../lib/rounds.mjs';
import { readSession } from '../lib/sessions.mjs';
import { collect, loadUsage, merge } from '../lib/audit.mjs';

const options = { platform: 'win32', home: 'C:\\Users\\测试', piEnv: {} };
const cwd = 'D:\\work\\项目 space';
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const attempt = '33333333-3333-4333-8333-333333333333';
const T = n => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)).toISOString();
const launch = (version, n, a = attempt) => ({ version, role: 'human', content_type: 'note', timestamp: T(n),
  payload: { launch: { role: 'executor', base_version: version - 1, attempt_id: a, route: { agent: 'pi', args: [] }, target_kind: 'headless-windows' } } });
const delivery = (version, n) => ({ version, role: 'executor', content_type: version === 2 ? 'code_changes' : 'revision', timestamp: T(n), payload: {} });
const task = versions => ({ task_id: 'one', checkout: { kind: 'worktree', path: cwd }, versions });
const frozen = (directory = 'D:\\flat', storage_layout = 'flat') => ({ session_directory: directory, storage_layout, launch_cwd: cwd, session_id: id, source: 'cli' });
const windowsLaunch = session => ({ schema: 1, target: { agent: 'pi', kind: 'node-entry', executable: 'C:\\node22\\node.exe',
  prefix_args: ['C:\\node22\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js'], version: '1.4.0' },
  logical_argv: ['pi', '--session-id', session.session_id, '--', 'test prompt'], pi_session: session });
const run = (session = frozen(), a = attempt, base_version = 0) => ({ task_id: 'one', cwd, headless: {
  role: 'executor', attempt_id: a, base_version, route: { agent: 'pi', args: [] }, designated_session_id: id, windows: windowsLaunch(session)
} });
const head = (sessionId = id, directory = cwd) => ({ type: 'session', version: 3, id: sessionId, cwd: directory, timestamp: T(0) });
const user = n => ({ type: 'message', id: `u${n}`, timestamp: T(n), message: { role: 'user' } });
const assistant = (n, stopReason = 'stop', cost = 0.125) => ({ type: 'message', id: `a${n}`, timestamp: T(n), message: {
  role: 'assistant', stopReason, usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, totalTokens: 37,
    ...(cost === undefined ? {} : { cost: { total: cost } }) }
} });
async function temp(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'usage-windows-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function writeSession(root, rows, name = 'session.jsonl', tail = '') {
  const file = path.join(root, name);
  await fs.writeFile(file, rows.map(r => JSON.stringify(r)).join('\r\n') + '\r\n' + tail);
  return readSession(file, 'pi');
}
function saveRun(runs, record, nativeCwd) {
  const runId = runs.create();
  runs.write(runId, { ...record, run_id: runId, pid: 100001, pgid: 100001, supervisor_pid: 100002,
    argv: ['C:\\node22\\node.exe', ...record.headless.windows.target.prefix_args], cwd: nativeCwd,
    started_at: T(0), ended_at: T(100), status: 'exited', exit_code: 0,
    headless: { ...record.headless, schema: 1, trigger_version: 0, route_source: 'task-cast', session_reason: 'test' } });
  return runId;
}

test('Windows default cwd encoding, UNC, environment final directory and CLI precedence use the routing unit rules', async () => {
  for (const [directory, slug] of [
    [cwd, '--D--work-项目 space--'],
    ['\\\\server\\share\\项目', '---server-share-项目--'],
    ['C:/repo/space here', '--C--repo-space here--']
  ]) {
    assert.equal(await piDirectory({ cwd: directory }, options, { readSettings: async () => undefined }), path.win32.join(options.home, '.pi', 'agent', 'sessions', slug));
  }
  for (const value of ['/d/sessions', '/mnt/d/sessions', '/cygdrive/d/sessions']) {
    const env = { PI_CODING_AGENT_SESSION_DIR: value };
    assert.equal(await piDirectory({ cwd }, { ...options, piEnv: env }), 'D:\\sessions');
    assert.equal(await piDirectory({ cwd, route_args: ['--session-dir', 'relative'] }, { ...options, piEnv: env }), path.win32.join(cwd, 'relative'));
  }
  assert.equal(await piDirectory({ cwd }, { ...options, piEnv: { PI_CODING_AGENT_SESSION_DIR: '~\\custom' } }), path.win32.join(options.home, 'custom'));
  await assert.rejects(piDirectory({ cwd }, { ...options, piEnv: { PI_CODING_AGENT_SESSION_DIR: 'file:///D:/sessions' } }), /unsupported/);
  assert.equal(await piDirectory({ cwd }, { ...options, piEnv: { PI_CODING_AGENT_DIR: 'D:\\agent' } }, { readSettings: async () => undefined }), 'D:\\agent\\sessions\\--D--work-项目 space--');
  await assert.rejects(piDirectory({ cwd }, options, { readSettings: async () => '{"sessionDir":"unproven"}' }), /requires explicit/);
});

test('TUT audit root stays a parent; frozen flat overrides do not acquire another cwd directory', async () => {
  assert.equal(await piDirectory({ cwd }, { ...options, piRoot: 'E:\\audit' }), 'E:\\audit\\--D--work-项目 space--');
  assert.equal(await piDirectory({ cwd, route_args: ['--session-dir', 'D:\\native'] }, { ...options, piRoot: 'E:\\audit' }), 'E:\\audit');
  assert.equal(await piDirectory({ cwd }, { ...options, piRoot: 'E:\\audit', piEnv: { PI_CODING_AGENT_SESSION_DIR: 'D:\\native' } }), 'E:\\audit');
  assert.equal(await piDirectory({ cwd, pi_session: frozen() }, { ...options, piEnv: { PI_CODING_AGENT_SESSION_DIR: 'E:\\changed' } }), 'D:\\flat');
  assert.equal(await piDirectory({ cwd, pi_session: frozen() }, { ...options, piRoot: 'E:\\audit' }), 'E:\\audit');
  assert.equal(await piDirectory({ cwd, pi_session: frozen('D:\\encoded', 'cwd-encoded') }, { ...options, piRoot: 'E:\\audit' }), 'E:\\audit\\--D--work-项目 space--');
  const win = parse(['--backfill'], { PI_CODING_AGENT_SESSION_DIR: 'D:\\flat' }, { ...options, cwd });
  assert.equal(win.piRoot, undefined);
  assert.equal(win.piEnv.PI_CODING_AGENT_SESSION_DIR, 'D:\\flat');
  assert.equal(win.codexRoot, path.win32.join(options.home, '.codex', 'sessions'));
  const posix = parse(['--backfill'], { PI_CODING_AGENT_SESSION_DIR: '/ignored' }, { platform: 'darwin', home: '/home/test', cwd: '/repo' });
  assert.equal(posix.piRoot, '/home/test/.pi/agent/sessions');
  assert.equal(posix.piEnv, undefined);
});

test('Windows exact run association refuses missing, duplicate, route, UUID and cwd conflicts', () => {
  for (const [runs, reason] of [
    [[], 'missing_windows_run'], [[run(), run()], 'ambiguous_windows_run'],
    [[run({ ...frozen(), session_id: otherId })], 'invalid_windows_session'],
    [[run({ ...frozen(), launch_cwd: 'D:\\other' })], 'invalid_windows_session'],
    [[{ ...run(), cwd: 'D:\\other' }], 'invalid_windows_session'],
    [[{ ...run(), headless: { ...run().headless, route: { agent: 'pi', args: ['--model', 'different'] } } }], 'invalid_windows_session']
  ]) {
    const rounds = extract(task([launch(1, 5), delivery(2, 30)]), 'C:\\hub', options);
    bindWindowsPi(rounds, runs);
    assert.equal(rounds[0].problem, reason);
  }
});

test('Windows CRLF same-file continuation counts unique assistant IDs once per round, with native null cost', async t => {
  const root = await temp(t);
  const nextAttempt = '44444444-4444-4444-8444-444444444444';
  const rounds = extract(task([launch(1, 5), delivery(2, 30), launch(3, 50, nextAttempt), delivery(4, 70)]), 'C:\\hub', options);
  bindWindowsPi(rounds, [run(), run(frozen(), nextAttempt, 2)]);
  const rows = [head(), user(10), assistant(20, 'toolUse'), assistant(20, 'toolUse'), assistant(40), user(60), assistant(80, 'stop', null)];
  const session = await writeSession(root, rows);
  const wrongId = await writeSession(root, [head(otherId), user(10), assistant(40)], 'unrelated.jsonl');
  const wrongCwd = await writeSession(root, [head(id, 'D:\\elsewhere'), user(10), assistant(40)], 'other-project.jsonl');
  const matches = attribute(rounds, [session, wrongId, wrongCwd], options);
  assert.deepEqual(matches.map(m => m.reason), [undefined, undefined]);
  assert.deepEqual(matches.map(m => m.candidates[0].total_tokens), [74, 37]);
  assert.deepEqual(matches.map(m => m.candidates[0].cost_usd), [0.25, null]);
  const ledger = merge(null, matches);
  assert.deepEqual(ledger.total, { rounds: 2, total_tokens: 111, cost_usd: null, complete: true });
  assert.equal(ledger.rounds[0].pi_session, undefined);
  assert.equal(ledger.rounds[0].windows_attempt, undefined);
  assert.deepEqual(merge(ledger, matches), ledger);
  assert.deepEqual(merge(ledger, matches, Date.parse(T(50))), ledger);
});

test('Windows missing end, partial tail and missing usage remain unresolved; concurrent claims do not duplicate tokens', async t => {
  const root = await temp(t);
  const rounds = extract(task([launch(1, 5), delivery(2, 30)]), 'C:\\hub', options);
  bindWindowsPi(rounds, [run()]);
  for (const [rows, tail, reason] of [
    [[head(), user(10), assistant(20, 'toolUse')], '', 'missing_session_or_end'],
    [[head(), user(10), assistant(40)], '{', 'partial_jsonl_tail'],
    [[head(), user(10), { ...assistant(40), message: { role: 'assistant', stopReason: 'stop' } }], '', 'missing_usage']
  ]) {
    const s = await writeSession(root, rows, 'broken.jsonl', tail);
    const matches = attribute(rounds, [s], options);
    assert.equal(matches[0].reason, reason);
    assert.equal(merge(null, matches).total.complete, false);
    assert.equal(merge(null, matches).rounds.length, 0);
  }
  const s = await writeSession(root, [head(), user(10), assistant(40)]);
  const both = attribute([...rounds, { ...rounds[0], task_id: 'another' }], [s], options);
  assert.deepEqual(both.map(m => m.reason), ['overlapping_rounds', 'overlapping_rounds']);
});

test('Windows collect discovers frozen flat files once, preserves successful ledger on disappearance and reports corruption', async t => {
  const root = await temp(t), store = new Store(path.join(root, '.context-hub'));
  await store.whenSwept;
  const { task_id } = await store.createTask({ title: 'Windows audit', description: 'test', role: 'human', creator: 'test', flow: 'direct' });
  const history = { ...task([launch(1, 5), delivery(2, 30)]), task_id };
  const hub = { list: async () => [{ task_id }], read: async () => history };
  const s = await writeSession(root, [head(), user(10), assistant(40)]);
  const dirs = [];
  let reads = 0, missing = false;
  const deps = { hub, runs: async () => [{ ...run(), task_id }],
    files: async dir => { dirs.push(dir); return missing ? [] : [s.file, s.file]; },
    readSession: async (file, agent) => { reads++; return readSession(file, agent); } };
  const config = { ...options, root, codexRoot: 'C:\\codex', piEnv: { PI_CODING_AGENT_SESSION_DIR: 'E:\\changed' } };
  const [first] = await collect(config, deps);
  assert.equal(first.total.total_tokens, 37);
  assert.deepEqual(dirs, ['D:\\flat']);
  assert.equal(reads, 1);
  assert.equal((await collect(config, deps))[0].changed, false);
  assert.equal(reads, 1);
  missing = true;
  const [lost] = await collect(config, deps);
  assert.equal(lost.total.complete, false);
  assert.deepEqual(lost.unresolved, [{ delivery_version: 2, launch_version: 1, reason: 'missing_session_or_end', preserved: true }]);
  assert.equal(lost.total.total_tokens, 37);
  missing = false;
  await fs.writeFile(s.file, 'broken JSON\r\n');
  const [broken, diagnostic] = await collect(config, deps);
  assert.equal(broken.unresolved[0].reason, 'unreadable_session_candidate');
  assert.match(diagnostic.diagnostic.reason, /invalid_jsonl_line/);
  const ledger = await loadUsage(path.join(root, '.context-hub', 'tasks', task_id));
  assert.equal(ledger.rounds.length, 1);
  assert.equal(ledger.total.complete, false);
  const denied = await collect(config, { ...deps, files: async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); } });
  assert.equal(denied[0].unresolved[0].reason, 'unreadable_session_candidate');
  assert.equal(denied[1].diagnostic.reason, 'EACCES');
});

test('Windows collection reads frozen session evidence through the real RunStore API', async t => {
  const root = await temp(t), store = new Store(path.join(root, '.context-hub'));
  await store.whenSwept;
  const { task_id } = await store.createTask({ title: 'RunStore usage', description: 'test', role: 'human', creator: 'test', flow: 'direct' });
  const launchCwd = path.win32.resolve(root);
  const history = { ...task([launch(1, 5), delivery(2, 30)]), task_id, checkout: { kind: 'worktree', path: launchCwd } };
  const runs = new RunStore(root), runId = runs.create();
  const ownership = run().headless;
  runs.write(runId, { run_id: runId, task_id, pid: 100001, pgid: 100001, supervisor_pid: 100002,
    argv: ['pi'], cwd: root, started_at: T(0), ended_at: T(90), status: 'exited', exit_code: 0,
    headless: { ...ownership, schema: 1, trigger_version: 0, route_source: 'task-cast', session_reason: 'test',
      windows: windowsLaunch({ ...frozen(), launch_cwd: launchCwd, session_directory: root }) } });
  await writeSession(root, [head(id, root), user(10), assistant(40)]);
  const hub = { list: async () => [{ task_id }], read: async () => history };
  const config = { ...options, root, codexRoot: path.join(root, 'codex') };
  const [report] = await collect(config, { hub });
  assert.equal(report.total.total_tokens, 37);
  assert.equal(report.total.complete, true);
  assert.equal((await collect(config, { hub }))[0].changed, false);
});

test('Windows supported Pi routes use frozen target identity through RunStore, multi-round collect and persisted usage', async t => {
  for (const agent of ['pi', 'pi.cmd', 'C:\\node22\\pi.cmd', 'C:\\node22\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js']) {
    await t.test(agent, async t => {
      const root = await temp(t), store = new Store(path.join(root, '.context-hub'));
      await store.whenSwept;
      const { task_id } = await store.createTask({ title: 'Pi route', description: 'test', role: 'human', creator: 'test', flow: 'direct' });
      const launchCwd = path.win32.resolve(root), nextAttempt = otherId;
      const route = { agent, args: ['--model', 'test-model', '--session-dir', root] };
      const versions = [launch(1, 5), delivery(2, 30), launch(3, 50, nextAttempt), delivery(4, 70)];
      for (const v of versions) {
        if (v.payload.launch) v.payload.launch.route = route;
        else v.agent = 'pi';
      }
      const history = { ...task(versions), task_id, checkout: { kind: 'worktree', path: launchCwd } };
      const runs = new RunStore(root), session = { ...frozen(root), launch_cwd: launchCwd };
      for (const [a, base] of [[attempt, 0], [nextAttempt, 2]]) {
        const record = run(session, a, base);
        saveRun(runs, { ...record, task_id, headless: { ...record.headless, route } }, root);
      }
      await writeSession(root, [head(id, launchCwd), user(10), assistant(20, 'toolUse'), assistant(20, 'toolUse'),
        assistant(40), user(60), assistant(80, 'stop', null)]);
      const hub = { list: async () => [{ task_id }], read: async () => history };
      let reads = 0;
      const deps = { hub, readSession: async (...args) => { reads++; return readSession(...args); } };
      const config = { ...options, root, codexRoot: path.join(root, 'codex') };
      const [report] = await collect(config, deps);
      assert.deepEqual(report.total, { rounds: 2, total_tokens: 111, cost_usd: null, complete: true });
      assert.equal(reads, 1);
      const ledger = await loadUsage(path.join(root, '.context-hub', 'tasks', task_id));
      assert.deepEqual(ledger.rounds.map(r => [r.agent, r.total_tokens]), [['pi', 74], ['pi', 37]]);
      assert.equal(ledger.rounds[0].windows_attempt, undefined);
      assert.equal((await collect(config, deps))[0].changed, false);
      assert.equal(reads, 1);
    });
  }
});

test('Windows collection refuses route, args, target and delivery identity conflicts before reading sessions', async t => {
  const root = await temp(t), store = new Store(path.join(root, '.context-hub'));
  await store.whenSwept;
  const { task_id } = await store.createTask({ title: 'Pi conflicts', description: 'test', role: 'human', creator: 'test', flow: 'direct' });
  const launchCwd = path.win32.resolve(root), history = { ...task([launch(1, 5), delivery(2, 30)]), task_id,
    checkout: { kind: 'worktree', path: launchCwd } };
  history.versions[0].payload.launch.route = { agent: 'pi.cmd', args: [] };
  history.versions[1].agent = 'pi';
  const record = run({ ...frozen(root), launch_cwd: launchCwd });
  record.headless.route.agent = 'pi.cmd';
  const runs = new RunStore(root), runId = saveRun(runs, { ...record, task_id }, root), valid = runs.read(runId);
  const cases = [
    [r => { r.headless.route.agent = 'C:\\other\\cli.js'; }, 'invalid_windows_session'],
    [r => { r.headless.route.args = ['--model', 'different']; }, 'invalid_windows_session'],
    [r => { delete r.headless.windows.target; }, 'invalid_windows_session'],
    [r => { r.headless.windows.target.agent = 'unknown'; }, 'invalid_windows_session'],
    [r => { r.headless.windows.target.agent = 'codex'; }, 'invalid_windows_session'],
    [r => { r.headless.windows.logical_argv[0] = 'codex'; }, 'invalid_windows_session'],
    [r => { r.headless.windows.target.executable = 'node.exe'; }, 'invalid_windows_session'],
    [() => { history.versions[1].agent = 'codex'; }, 'agent_conflict']
  ];
  for (const [mutate, reason] of cases) {
    history.versions[1].agent = 'pi';
    const changed = structuredClone(valid);
    mutate(changed);
    runs.write(runId, changed);
    const [report] = await collect({ ...options, root }, {
      hub: { list: async () => [{ task_id }], read: async () => history },
      files: async () => { assert.fail('conflicting identity must not discover sessions'); }
    });
    assert.equal(report.unresolved[0].reason, reason);
    const ledger = await loadUsage(path.join(root, '.context-hub', 'tasks', task_id));
    assert.equal(ledger.total.complete, false);
    assert.equal(ledger.rounds.length, 0);
  }
});

test('Windows multi-root collection keeps per-round candidate scope, explicit overrides and preserved missing usage', async t => {
  const root = await temp(t), store = new Store(path.join(root, '.context-hub'));
  await store.whenSwept;
  const a = await store.createTask({ title: 'Frozen A', description: 'test', role: 'human', creator: 'test', flow: 'direct' });
  const b = await store.createTask({ title: 'Frozen B', description: 'test', role: 'human', creator: 'test', flow: 'direct' });
  const dirA = path.join(root, 'A'), dirB = path.join(root, 'B');
  await fs.mkdir(dirA); await fs.mkdir(dirB);
  const launchCwd = path.win32.resolve(root);
  const histories = [
    { ...task([launch(1, 5), delivery(2, 30), launch(3, 50, otherId), delivery(4, 70)]), task_id: a.task_id },
    { ...task([launch(1, 5), delivery(2, 30)]), task_id: b.task_id }
  ];
  for (const h of histories) h.checkout.path = launchCwd;
  const runs = new RunStore(root);
  for (const [task_id, directory, sessionId, aId, base] of [
    [a.task_id, dirA, id, attempt, 0], [a.task_id, dirA, id, otherId, 2], [b.task_id, dirB, otherId, attempt, 0]
  ]) {
    const record = run({ ...frozen(directory), launch_cwd: launchCwd, session_id: sessionId }, aId, base);
    record.headless.designated_session_id = sessionId;
    const runId = saveRun(runs, { ...record, task_id }, root);
    if (task_id === b.task_id) b.runId = runId;
  }
  const rows = [head(id, launchCwd), user(10), assistant(40), user(60), assistant(80)];
  await writeSession(dirB, rows, 'copy-of-A.jsonl');
  const hub = { list: async () => histories.map(h => ({ task_id: h.task_id })), read: async id => histories.find(h => h.task_id === id) };
  const config = { ...options, root }, deps = { hub };
  const ledgerA = () => loadUsage(path.join(root, '.context-hub', 'tasks', a.task_id));
  await collect(config, deps);
  assert.equal((await ledgerA()).total.rounds, 0);
  assert.deepEqual((await ledgerA()).unresolved.map(u => u.reason), ['missing_session_or_end', 'missing_session_or_end']);
  const original = await writeSession(dirA, rows);
  await collect(config, deps);
  assert.deepEqual((await ledgerA()).total, { rounds: 2, total_tokens: 74, cost_usd: 0.25, complete: true });
  assert.equal((await ledgerA()).rounds[0].session_file, original.file);
  // Even identical UUID/cwd at both original roots must stay directory-scoped.
  const bRun = runs.read(b.runId);
  bRun.headless.designated_session_id = id;
  bRun.headless.windows.pi_session.session_id = id;
  runs.write(b.runId, bRun);
  const both = await collect(config, deps);
  assert.deepEqual(both.map(r => r.total.complete), [true, true]);
  assert.deepEqual(both.map(r => r.total.total_tokens), [74, 37]);
  // Remove only a temporary session fixture. Hub task records stay immutable.
  await fs.unlink(original.file);
  await collect(config, deps);
  assert.equal((await ledgerA()).total.total_tokens, 74);
  assert.equal((await ledgerA()).total.complete, false);
  assert.ok((await ledgerA()).unresolved.every(u => u.preserved && u.reason === 'missing_session_or_end'));
  // An explicit override authorizes B's copy for A; B uses a different UUID
  // again so that the shared-root case has two independent native sessions.
  bRun.headless.designated_session_id = otherId;
  bRun.headless.windows.pi_session.session_id = otherId;
  runs.write(b.runId, bRun);
  await writeSession(dirB, [head(otherId, launchCwd), user(10), assistant(40)], 'B.jsonl');
  let reads = 0, discovers = 0;
  const override = { ...options, root, piRoot: dirB };
  const counted = { hub, files: async dir => { discovers++; const { files } = await import('../lib/sessions.mjs'); return files(dir); },
    readSession: async (...args) => { reads++; return readSession(...args); } };
  const shared = await collect(override, counted);
  assert.deepEqual(shared.map(r => r.total.complete), [true, true]);
  assert.deepEqual(shared.map(r => r.total.total_tokens), [74, 37]);
  assert.equal(discovers, 1); assert.equal(reads, 2);
  assert.equal((await ledgerA()).rounds[0].session_file, path.join(dirB, 'copy-of-A.jsonl'));
  assert.ok((await collect(override, counted)).every(r => r.changed === false));
  assert.equal(reads, 2);
  await writeSession(dirB, rows, 'another-copy-of-A.jsonl');
  await collect(override, counted);
  assert.ok((await ledgerA()).unresolved.every(u => u.preserved && u.reason === 'ambiguous_sessions'));
  assert.equal((await ledgerA()).total.complete, false);
});

import { writeNodeExecutable, fixtureHeadlessOwnership } from './helpers/executable.js';
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../src/core/hub/server.js';
import { hubCreate, hubDecide } from '../src/core/hub/hub-client.js';
import { RunStore } from '../src/core/run/store.js';

const cli = path.resolve('dist/cli.js');
const built = await import(path.resolve('dist/core/run/control.js')) as typeof import('../src/core/run/control.js');
const servers: RunningServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
// Audit/run fixtures stay outside the repository and survive for diagnosis.
function write(file: string, content: string) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }
async function fixture(head = 'ref: refs/heads/wrong') {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tut-task-worktree-')));
  const hub = path.join(root, 'hub'), wt = path.join(root, 'wt'), cwd = path.join(wt, 'src');
  const common = path.join(hub, '.git'), gitdir = path.join(common, 'worktrees/unit');
  mkdirSync(cwd, { recursive: true }); mkdirSync(path.join(common, 'objects'), { recursive: true });
  write(path.join(common, 'HEAD'), 'ref: refs/heads/main');
  write(path.join(common, 'refs/heads/expected'), 'a'.repeat(40));
  write(path.join(common, 'refs/heads/wrong'), 'b'.repeat(40));
  write(path.join(wt, '.git'), `gitdir: ${gitdir}`);
  write(path.join(gitdir, 'commondir'), '../..');
  write(path.join(gitdir, 'gitdir'), path.join(wt, '.git'));
  write(path.join(gitdir, 'HEAD'), head);
  const codexFile = path.join(root, 'bin/codex');
  const codex = writeNodeExecutable(codexFile, `console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread-123'}));`);
  const server = await startServer({ root: path.join(hub, '.context-hub'), port: 0 }); servers.push(server);
  const env = { ...process.env, TUT_HUB_ROOT: hub, TUT_HUB_URL: server.url };
  const store = new RunStore(hub);
  return { root, hub, wt, cwd, gitdir, codex, server, env, store };
}
async function run(cwd: string, argv: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, out, err }));
  });
}
async function finished(store: RunStore, id: string) {
  const deadline = Date.now() + (process.platform === 'win32' ? 45000 : 8000);
  while (store.read(id).ended_at === undefined) {
    if (Date.now() > deadline) throw new Error(`fixture run did not finish: ${id}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
// Session capture is outside this advisory test. Windows' monitor does not
// parse Codex JSON; seed this producer fact from the exact event the neutral
// child really emitted, then exercise native managed resume and the real gate.
async function seedWindowsSourceSession(store: RunStore, id: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const lines = readFileSync(path.join(store.directory(id), 'log'), 'utf8').trim().split('\n');
  const events = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  expect(events).toContainEqual({ type: 'thread.started', thread_id: 'fixture-thread-123' });
  await store.updateMeta(id, meta => ({ ...meta, agent_session_id: 'fixture-thread-123' }));
}

async function task(f: Awaited<ReturnType<typeof fixture>>, ref?: string, description = 'fixture') {
  return await hubCreate(f.server.url, { title: 'worktree task', description, creator: 'fixture', role: 'executor', flow: 'direct',
    checkout: { kind: 'worktree', path: f.wt, ...(ref === undefined ? {} : { ref }) } });
}
async function plainResume(f: Awaited<ReturnType<typeof fixture>>, cwd: string, argv: string[], env: NodeJS.ProcessEnv) {
  const before = f.store.list(); const source = argv[1]!; const bytes = readFileSync(path.join(f.store.directory(source), 'meta.json'));
  const result = await run(cwd, argv, env);
  if (process.platform !== 'win32') return result;
  expect(result.code).toBe(1); expect(result.err).toContain('windows-launch-unavailable'); expect(result.out).toBe('');
  expect(f.store.list()).toEqual(before); expect(readFileSync(path.join(f.store.directory(source), 'meta.json'))).toEqual(bytes);
  return undefined;
}
function successful(result: Awaited<ReturnType<typeof run>>) {
  expect(result.code, result.err).toBe(0);
  expect(result.out).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{8}\n$/);
}

describe('associated CLI worktree preflight through a real Hub', () => {
  it.each([false, true])('run and plain resume warn on an attached wrong branch from a subdirectory (fix=%s)', { timeout: process.platform === 'win32' ? 120_000 : 30_000 }, async fix => {
    const f = await fixture(); const created = await task(f, 'expected');
    const headBefore = readFileSync(path.join(f.gitdir, 'HEAD'), 'utf8');
    const flags = fix ? ['--fix-preflight'] : [];
    const first = await run(f.cwd, ['run', '--task', created.task_id, ...flags, '--', f.codex, 'exec', '--json', 'fixture'], f.env);
    successful(first); await finished(f.store, first.out.trim());
    const second = await plainResume(f, f.hub, ['resume', first.out.trim(), ...flags], f.env);
    if (second) { successful(second); await finished(f.store, second.out.trim()); }
    for (const result of second ? [first, second] : [first]) {
      expect(result.err).toContain('worktree-consistency');
      expect(result.err).toContain(`task ${created.task_id} checkout.ref`);
      expect(result.err).toContain("switch -- 'expected'");
      expect(f.store.read(result.out.trim()).cwd).toBe(f.cwd);
    }
    expect(readFileSync(path.join(f.gitdir, 'HEAD'), 'utf8')).toBe(headBefore);
  });

  it.each(['matching', 'no-task', 'no-ref', 'offline', 'foreign', 'nested'])('keeps %s evidence honest and never invents a mismatch', { timeout: process.platform === 'win32' ? 120_000 : 30_000 }, async mode => {
    const f = await fixture('ref: refs/heads/expected');
    const created = await task(f, mode === 'no-ref' ? undefined : 'expected');
    let cwd = f.cwd;
    const env = { ...f.env };
    if (mode === 'offline') { await f.server.close(); env.TUT_HUB_URL = 'http://127.0.0.1:1'; }
    if (mode === 'foreign') { env.TUT_HUB_ROOT = path.join(f.root, 'foreign-hub'); mkdirSync(env.TUT_HUB_ROOT); }
    if (mode === 'nested') { mkdirSync(path.join(cwd, '.git')); }
    const store = new RunStore(env.TUT_HUB_ROOT);
    const first = await run(cwd, ['run', ...(mode === 'no-task' ? [] : ['--task', created.task_id]), '--', f.codex, 'exec', '--json', 'fixture'], env);
    successful(first); await finished(store, first.out.trim());
    const second = await plainResume({ ...f, store }, cwd, ['resume', first.out.trim()], env);
    if (second) { successful(second); await finished(store, second.out.trim()); }
    for (const result of second ? [first, second] : [first]) {
      expect(result.err).not.toContain('worktree-consistency');
      if (mode === 'matching' || mode === 'nested') expect(result.err).not.toContain('task consistency unverified');
      else expect(result.err).toContain('task consistency unverified');
    }
  });

  it.each(['frozen', 'declared'])('reports %s branch mismatch for managed resume and preserves the closed-task gate', { timeout: process.platform === 'win32' ? 120_000 : 30_000 }, async mode => {
    const f = await fixture(); const created = await task(f, mode === 'frozen' ? 'expected' : undefined, `工作区：${process.platform === 'win32' ? f.wt.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/') : f.wt}（分支 expected）`);
    // Anchored provenance belongs to this source run; current policy need not
    // be changed for diagnostics to use its declaration on resume.
    const source = await built.startRun(f.store, [f.codex, 'exec', '--json', 'fixture'], f.cwd, created.task_id, {
      env: f.env, ...(mode === 'declared' ? { checkout: f.wt } : {}), headless: await fixtureHeadlessOwnership({ schema: 1, role: 'executor', attempt_id: crypto.randomUUID(), base_version: 0, trigger_version: 0,
        route: { agent: f.codex, args: [] }, route_source: 'task-cast', session_reason: 'fixture' }, [f.codex, 'exec', '--json', 'fixture'], f.env),
    });
    await finished(f.store, source); await seedWindowsSourceSession(f.store, source);
    const result = await run(f.hub, ['resume', source, '--fix-preflight'], f.env);
    successful(result); await finished(f.store, result.out.trim()); await seedWindowsSourceSession(f.store, result.out.trim());
    expect(result.err).toContain(`task ${created.task_id} ${mode === 'declared' ? 'declared branch' : 'checkout.ref'}`);
    expect(result.err).toContain("switch -- 'expected'");
    expect(f.store.read(result.out.trim()).cwd).toBe(f.cwd);
    await hubDecide(f.server.url, { task_id: created.task_id, decision: 'close', by: 'fixture' });
    const count = f.store.list().length;
    const closed = await run(f.hub, ['resume', result.out.trim()], f.env);
    expect(closed.code).toBe(1);
    expect(closed.out).toBe(''); expect(closed.err).toMatch(/closed|gate/i);
    expect(f.store.list()).toHaveLength(count);
    expect(readFileSync(path.join(f.gitdir, 'HEAD'), 'utf8')).toBe('ref: refs/heads/wrong');
  });
});

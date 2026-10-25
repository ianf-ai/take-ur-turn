import { writeNodeExecutable } from './helpers/executable.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RunStore } from '../src/core/run/store.js';
import { stopWindowsFixtureRuns } from './helpers/run-cleanup.js';

const cli = path.resolve('dist/cli.js');
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); const owned = roots.splice(0);
  await stopWindowsFixtureRuns(owned);
  if (process.platform !== 'win32') for (const r of owned) rmSync(r, { recursive: true, force: true });
});
function root(): string { const r = mkdtempSync(path.join(os.tmpdir(), 'tut-preflight-cli-')); roots.push(r); return r; }

function nodeCheckout(r: string): void {
  writeFileSync(path.join(r, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { dep: '1.0.0' } }));
  writeFileSync(path.join(r, 'package-lock.json'), JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', dependencies: { dep: '1.0.0' } } } }));
}

/** A fake npm: creates node_modules (simulating a half-applied install) and
 *  then exits NONZERO — or exits 0 and prints to stdout. */
function fakeNpm(r: string, behavior: 'fail-after-create' | 'ok-noisy'): string {
  const dir = path.join(r, 'fakebin'); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, behavior === 'ok-noisy' ? 'npm-noisy' : 'npm-fail');
  return writeNodeExecutable(file, `
    require('node:fs').mkdirSync('node_modules', { recursive: true });
    console.log('NPM-STDOUT ${behavior}');
    process.exit(${behavior === 'fail-after-create' ? 3 : 0});
  `);
}

interface CliResult { code: number | null; out: string; err: string }
function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.once('exit', code => resolve({ code, out, err }));
  });
}

describe('a failed repair step never starts an agent, even when artifacts exist', () => {
  it('run --fix-preflight with a half-applied failing npm: exit 1, zero new runs, honest diagnostics', { timeout: process.platform === 'win32' ? 90000 : 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'fail-after-create');
    const store = new RunStore(r);
    const result = await runCli(r, ['run', '--fix-preflight', '--', process.execPath, '-e', ''], { TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1', TUT_PREFLIGHT_NPM: npm });
    expect(result.code).toBe(1);
    expect(result.err).toContain('preflight fix step failed');
    expect(result.err).toContain('exit 3');
    expect(store.list()).toHaveLength(0); // zero agent / marker / run
    expect(existsSync(path.join(r, 'node_modules'))).toBe(true); // the half-applied artifact exists…
  });

  it('doctor --fix-preflight with a failing step exits 1 instead of reporting success', { timeout: process.platform === 'win32' ? 90000 : 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'fail-after-create');
    const storage = path.join(r, 'storage'); mkdirSync(storage, { recursive: true });
    const result = await runCli(r, ['doctor', '--fix-preflight', '--root', storage, '--url', 'http://127.0.0.1:1'], { TUT_HUB_ROOT: r, TUT_PREFLIGHT_NPM: npm });
    expect(result.code).toBe(1);
    expect(result.err).toContain('preflight fix step failed');
  });

  it('a successful repair still starts the run', { timeout: process.platform === 'win32' ? 90000 : 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'ok-noisy');
    const store = new RunStore(r);
    const result = await runCli(r, ['run', '--fix-preflight', '--', process.execPath, '-e', ''], { TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1', TUT_PREFLIGHT_NPM: npm });
    expect(result.code).toBe(0);
    expect(store.list()).toHaveLength(1);
    await completed(store, store.list()[0]!);
  });
});

describe('repair output never pollutes the machine-readable stdout', () => {
  it('detached worktree warnings stay on stderr and do not block run or resume, even with --fix-preflight', { timeout: process.platform === 'win32' ? 90000 : 30_000 }, async () => {
    const r = root();
    const cwd = path.join(r, 'src'); mkdirSync(cwd);
    const gitdir = path.join(r, 'repo', 'worktrees', 'unit');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(r, '.git'), `gitdir: ${gitdir}\n`);
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(r, '.git')}\n`);
    const head = `${'a'.repeat(40)}\n`;
    writeFileSync(path.join(gitdir, 'HEAD'), head);
    const codex = writeNodeExecutable(path.join(r, 'codex'), `console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture-thread-123'}));`);
    const store = new RunStore(r);
    const env = { TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1' };
    const first = await runCli(cwd, ['run', '--fix-preflight', '--', codex, 'exec', '--json', 'fixture prompt'], env);
    expect(first.code).toBe(0);
    expect(first.err).toContain('detached HEAD');
    expect(first.err).toContain('switch <intended-branch>');
    expect(first.out).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{8}\n$/);
    const id = first.out.trim();
    await until(() => store.read(id).ended_at !== undefined);
    const bytes = readFileSync(path.join(store.directory(id), 'meta.json'));
    const second = await runCli(r, ['resume', id, '--fix-preflight'], env);
    if (process.platform === 'win32') {
      expect(second.code).toBe(1); expect(second.err).toContain('windows-launch-unavailable'); expect(second.out).toBe('');
      expect(store.list()).toEqual([id]); expect(readFileSync(path.join(store.directory(id), 'meta.json'))).toEqual(bytes);
      return;
    }
    expect(second.code).toBe(0);
    expect(second.err).toContain('detached HEAD');
    expect(second.out).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{8}\n$/);
    await until(() => store.read(second.out.trim()).ended_at !== undefined);
    expect(readFileSync(path.join(gitdir, 'HEAD'), 'utf8')).toBe(head);
  });

  it('a noisy successful npm leaves stdout as exactly the run-id line; npm output lands on stderr', { timeout: process.platform === 'win32' ? 90000 : 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'ok-noisy');
    const store = new RunStore(r);
    const result = await runCli(r, ['run', '--fix-preflight', '--', process.execPath, '-e', ''], { TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1', TUT_PREFLIGHT_NPM: npm });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{8}\n$/); // strictly one run-id line
    expect(result.err).toContain('NPM-STDOUT'); // visible on stderr
    await completed(store, store.list()[0]!);
  });

  it('doctor --json --fix-preflight stdout stays a single parseable JSON document', { timeout: process.platform === 'win32' ? 90000 : 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'ok-noisy');
    const storage = path.join(r, 'storage'); mkdirSync(storage, { recursive: true });
    const result = await runCli(r, ['doctor', '--json', '--fix-preflight', '--root', storage, '--url', 'http://127.0.0.1:1', '--checkout', r], { TUT_HUB_ROOT: r, TUT_PREFLIGHT_NPM: npm });
    expect(JSON.parse(result.out).checks).toBeInstanceOf(Array);
    expect(result.err).toContain('NPM-STDOUT');
  });
});

async function until(fn: () => boolean, ms = process.platform === 'win32' ? 45000 : 8000): Promise<void> { const end = performance.now() + ms; while (!fn()) { if (performance.now() > end) throw new Error('condition timed out'); await new Promise(res => setTimeout(res, 25)); } }
async function completed(store: RunStore, id: string): Promise<void> {
  try { await until(() => store.read(id).ended_at !== undefined); }
  catch (cause) { throw new Error(`preflight fixture ${id} did not complete: ${JSON.stringify(store.read(id))}`, { cause }); }
}
void readFileSync;

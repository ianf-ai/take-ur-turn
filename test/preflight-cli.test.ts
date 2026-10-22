import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RunStore } from '../src/core/run/store.js';

const cli = path.resolve('dist/cli.js');
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
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
  const script = behavior === 'fail-after-create'
    ? '#!/bin/sh\nmkdir -p "$PWD/node_modules"\nNPM-STDOUT-PARTIAL\nexit 3\n'
    : '#!/bin/sh\nmkdir -p "$PWD/node_modules"\necho "NPM-STDOUT added 1 package"\nexit 0\n';
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
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
  it('run --fix-preflight with a half-applied failing npm: exit 1, zero new runs, honest diagnostics', { timeout: 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'fail-after-create');
    const store = new RunStore(r);
    const result = await runCli(r, ['run', '--fix-preflight', '--', 'true'], { TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1', TUT_PREFLIGHT_NPM: npm });
    expect(result.code).toBe(1);
    expect(result.err).toContain('preflight fix step failed');
    expect(result.err).toContain('exit 3');
    expect(store.list()).toHaveLength(0); // zero agent / marker / run
    expect(path.join(r, 'node_modules')).toBeTruthy(); // the half-applied artifact exists…
  });

  it('doctor --fix-preflight with a failing step exits 1 instead of reporting success', { timeout: 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'fail-after-create');
    const storage = path.join(r, 'storage'); mkdirSync(storage, { recursive: true });
    const result = await runCli(r, ['doctor', '--fix-preflight', '--root', storage, '--url', 'http://127.0.0.1:1'], { TUT_HUB_ROOT: r, TUT_PREFLIGHT_NPM: npm });
    expect(result.code).toBe(1);
    expect(result.err).toContain('preflight fix step failed');
  });

  it('a successful repair still starts the run', { timeout: 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'ok-noisy');
    const store = new RunStore(r);
    const result = await runCli(r, ['run', '--fix-preflight', '--', 'true'], { TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1', TUT_PREFLIGHT_NPM: npm });
    expect(result.code).toBe(0);
    expect(store.list()).toHaveLength(1);
    await until(() => store.read(store.list()[0]!).ended_at !== undefined);
  });
});

describe('repair output never pollutes the machine-readable stdout', () => {
  it('a noisy successful npm leaves stdout as exactly the run-id line; npm output lands on stderr', { timeout: 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'ok-noisy');
    const store = new RunStore(r);
    const result = await runCli(r, ['run', '--fix-preflight', '--', 'true'], { TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1', TUT_PREFLIGHT_NPM: npm });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{8}\n$/); // strictly one run-id line
    expect(result.err).toContain('NPM-STDOUT'); // visible on stderr
    await until(() => store.read(store.list()[0]!).ended_at !== undefined);
  });

  it('doctor --json --fix-preflight stdout stays a single parseable JSON document', { timeout: 30_000 }, async () => {
    const r = root(); nodeCheckout(r);
    const npm = fakeNpm(r, 'ok-noisy');
    const storage = path.join(r, 'storage'); mkdirSync(storage, { recursive: true });
    const result = await runCli(r, ['doctor', '--json', '--fix-preflight', '--root', storage, '--url', 'http://127.0.0.1:1', '--checkout', r], { TUT_HUB_ROOT: r, TUT_PREFLIGHT_NPM: npm });
    expect(JSON.parse(result.out).checks).toBeInstanceOf(Array);
    expect(result.err).toContain('NPM-STDOUT');
  });
});

async function until(fn: () => boolean, ms = 8000): Promise<void> { const end = performance.now() + ms; while (!fn()) { if (performance.now() > end) throw new Error('condition timed out'); await new Promise(res => setTimeout(res, 25)); } }
void readFileSync;

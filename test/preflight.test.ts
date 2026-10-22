import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  preflightCheckout, nextPreflightFixStep, fixPreflight, renderPreflightReport,
  type PreflightFixRunner, type PreflightFixStep,
} from '../src/core/preflight/index.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function dir(): string { const r = mkdtempSync(path.join(os.tmpdir(), 'tut-preflight-')); roots.push(r); return r; }
function write(file: string, content: string): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }

describe('preflight inspection', () => {
  it('non-Node directories are not-applicable and never gated', () => {
    const r = dir();
    const report = preflightCheckout(r);
    expect(report).toMatchObject({ applicable: false, ok: true, isTutCheckout: false });
    expect(report.items.every(i => i.status === 'not-applicable')).toBe(true);
  });

  it('Node checkout with dependencies but no node_modules reports missing with absolute path and lockfile-aware fix', () => {
    const r = dir();
    write(path.join(r, 'package.json'), JSON.stringify({ name: 'app', dependencies: { left: '1.0.0' } }));
    write(path.join(r, 'package-lock.json'), '{}');
    const report = preflightCheckout(r);
    expect(report.applicable).toBe(true);
    expect(report.ok).toBe(false);
    const modules = report.items.find(i => i.check === 'node-modules')!;
    expect(modules.status).toBe('missing');
    expect(modules.detail).toContain(path.join(r, 'node_modules'));
    expect(modules.fix).toContain(`cd '${r}' && npm ci`);
  });

  it('no supported lockfile downgrades to manual guidance (never guesses a package manager)', () => {
    const r = dir();
    write(path.join(r, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { x: '1' } }));
    const report = preflightCheckout(r);
    const modules = report.items.find(i => i.check === 'node-modules')!;
    expect(modules.status).toBe('missing');
    expect(modules.fix).not.toContain('npm ci');
    expect(modules.fix).toContain('manually');
    // And the automated fix plan stays empty — no step is supported.
    expect(nextPreflightFixStep(report)).toBeNull();
  });

  it('healthy node_modules passes; empty dependency blocks are not-applicable', () => {
    const r = dir();
    write(path.join(r, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
    expect(preflightCheckout(r).items.find(i => i.check === 'node-modules')!.status).toBe('not-applicable');
    mkdirSync(path.join(r, 'node_modules'));
    write(path.join(r, 'package2.json'), '');
    const r2 = dir();
    write(path.join(r2, 'package.json'), JSON.stringify({ name: 'app', dependencies: { y: '2' } }));
    mkdirSync(path.join(r2, 'node_modules'));
    expect(preflightCheckout(r2).items.find(i => i.check === 'node-modules')!.status).toBe('ok');
  });

  it('TUT source checkout without dist reports missing artifacts with build fix', () => {
    const r = dir();
    write(path.join(r, 'package.json'), JSON.stringify({ name: 'take-ur-turn', dependencies: { zod: '^3' } }));
    mkdirSync(path.join(r, 'node_modules'));
    const report = preflightCheckout(r);
    expect(report.isTutCheckout).toBe(true);
    const dist = report.items.find(i => i.check === 'tut-dist')!;
    expect(dist.status).toBe('missing');
    expect(dist.detail).toContain(path.join(r, 'dist/cli.js'));
    expect(dist.fix).toContain('npm run build');
    expect(nextPreflightFixStep(report)).toMatchObject({ argv: ['npm', 'run', 'build'], cwd: r });
    // Present artifacts pass.
    write(path.join(r, 'dist/cli.js'), '#!/usr/bin/env node\n');
    write(path.join(r, 'dist/core/run/supervisor.js'), '');
    expect(preflightCheckout(r).items.find(i => i.check === 'tut-dist')!.status).toBe('ok');
  });

  it('invalid manifests and permission damage are errors, not missing', () => {
    const r = dir();
    write(path.join(r, 'package.json'), '{ not json');
    const report = preflightCheckout(r);
    expect(report.ok).toBe(false);
    expect(report.items.find(i => i.check === 'node-manifest')!.status).toBe('error');
    const r2 = dir();
    write(path.join(r2, 'package.json'), JSON.stringify({ name: 'a', dependencies: { b: '1' } }));
    mkdirSync(path.join(r2, 'node_modules'));
    chmodSync(path.join(r2, 'node_modules'), 0o000);
    try {
      if (process.getuid?.() === 0) return; // root ignores permission bits
      const report2 = preflightCheckout(r2);
      expect(report2.items.find(i => i.check === 'node-modules')!.status).toBe('error');
    } finally {
      chmodSync(path.join(r2, 'node_modules'), 0o755);
    }
  });
});

describe('preflight fix loop', () => {
  it('runs install then build in the checkout cwd, re-checks, stops on failure, never touches manifests', async () => {
    const r = dir();
    write(path.join(r, 'package.json'), JSON.stringify({ name: 'take-ur-turn', dependencies: { z: '1' } }));
    write(path.join(r, 'package-lock.json'), '{}');
    const before = readFileSync(path.join(r, 'package.json'), 'utf8');
    const steps: PreflightFixStep[] = [];
    const runner: PreflightFixRunner = async (step) => {
      steps.push(step);
      expect(step.cwd).toBe(r);
      if (step.argv[1] === 'ci') {
        mkdirSync(path.join(r, 'node_modules'), { recursive: true }); // install succeeds
        return { code: 0, signal: null };
      }
      if (step.argv[1] === 'run') {
        write(path.join(r, 'dist/cli.js'), 'x');
        write(path.join(r, 'dist/core/run/supervisor.js'), 'x');
        return { code: 0, signal: null };
      }
      return { code: 1, signal: null };
    };
    const result = await fixPreflight(r, runner);
    expect(steps.map(s => s.argv.join(' '))).toEqual(['npm ci', 'npm run build']);
    expect(result.report.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(readFileSync(path.join(r, 'package.json'), 'utf8')).toBe(before); // manifest untouched
  });

  it('stops at the first failing step and reports honestly', async () => {
    const r = dir();
    write(path.join(r, 'package.json'), JSON.stringify({ name: 'app', dependencies: { z: '1' } }));
    write(path.join(r, 'package-lock.json'), '{}');
    const result = await fixPreflight(r, async (step) => ({ code: 2, signal: null }));
    expect(result.executed).toHaveLength(1);
    expect(result.failure).toMatchObject({ code: 2 });
    expect(result.report.ok).toBe(false);
    expect(renderPreflightReport(result.report)).toContain('node-modules');
  });

  it('a real smoke: local minimal package repaired with an offline install', { timeout: 60_000 }, async () => {
    // A no-network fixture package: the lockfile points at a packed tarball on
    // disk, so `npm ci` needs no registry. Proves the real runner spawns npm
    // with the right cwd and the recheck flips the verdict.
    const r = dir();
    const pkgDir = path.join(r, 'lib-pkg');
    write(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'tut-preflight-fixture-lib', version: '1.0.0', main: 'index.js' }));
    write(path.join(pkgDir, 'index.js'), 'module.exports = 1;\n');
    const manifest = {
      name: 'tut-preflight-smoke',
      version: '1.0.0',
      dependencies: { 'tut-preflight-fixture-lib': 'file:./tut-preflight-fixture-lib-1.0.0.tgz' },
    };
    write(path.join(r, 'package.json'), JSON.stringify(manifest));
    const { execFileSync } = await import('node:child_process');
    // npx/vitest leak npm_config_* into the environment; a clean env keeps the
    // child npm from inheriting this repo's script-allowance policy.
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_config_')));
    const run = (args: string[], cwd: string) => execFileSync('npm', args, { cwd, stdio: 'ignore', env: cleanEnv });
    run(['pack', './lib-pkg'], r);
    run(['install', '--package-lock-only', '--ignore-scripts', '--offline'], r);
    const before = preflightCheckout(r);
    expect(before.items.find(i => i.check === 'node-modules')!.status).toBe('missing');
    const result = await fixPreflight(r, async (step) => {
      if (step.argv[1] !== 'ci') return { code: 1, signal: null };
      try {
        run(['ci', '--offline', '--ignore-scripts'], step.cwd);
        return { code: 0, signal: null };
      } catch {
        return { code: 1, signal: null };
      }
    });
    expect(result.report.items.find(i => i.check === 'node-modules')!.status).toBe('ok');
  });
});

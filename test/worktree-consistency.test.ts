import { writeNodeExecutable } from './helpers/executable.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutContainsCwd, inspectWorktree } from '../src/core/preflight/worktree.js';
import { fixPreflight, preflightCheckout } from '../src/core/preflight/index.js';
import { preflightCheckFrom, renderDoctorReport, runDoctor } from '../src/core/doctor/index.js';
import { buildHeadlessPlan } from '../src/standalone/launcher-headless/plan.js';
import { resolveWorkspaceSnapshot } from '../src/herdr/launcher/anchor.js';

const roots: string[] = [];
const oldOid = 'a'.repeat(40), newOid = 'b'.repeat(40);
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function write(file: string, text: string) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tut-consistency-'))); roots.push(root);
  const main = path.join(root, 'main'), wt = path.join(root, "person's worktree");
  const common = path.join(main, '.git'), gitdir = path.join(common, 'worktrees', 'unit');
  mkdirSync(path.join(common, 'objects'), { recursive: true });
  write(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(common, 'refs/heads/main'), oldOid);
  write(path.join(common, 'refs/heads/topic'), newOid);
  write(path.join(wt, '.git'), `gitdir: ${path.relative(wt, gitdir)}\n`);
  write(path.join(gitdir, 'HEAD'), 'ref: refs/heads/topic\n');
  write(path.join(gitdir, 'commondir'), '../..\n');
  write(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`);
  return { root, main, wt, common, gitdir };
}
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), readFileSync(file).toString('base64')];
    }));
}

describe('report-only linked worktree consistency', () => {
  it('finds the nearest checkout from subdirectories without moving the Node preflight target', async () => {
    const f = fixture(); const cwd = path.join(f.wt, 'src', 'deep'); mkdirSync(cwd, { recursive: true });
    write(path.join(f.wt, 'package.json'), JSON.stringify({ dependencies: { example: '*' } }));
    const state = { hub_root: f.main, flow_mode: 'manual', tasks: [{ task_id: 'unit', checkout: { kind: 'worktree', path: f.wt, ref: 'topic' } }] };
    for (const head of ['ref: refs/heads/topic', 'ref: refs/heads/main', oldOid]) {
      write(path.join(f.gitdir, 'HEAD'), head);
      const before = snapshot(f.root);
      const expectedStatus = head.endsWith('/topic') ? 'ok' : 'warn';
      const report = preflightCheckout(cwd, [{ ref: 'topic', source: 'task ref' }]);
      expect(report.checkout).toBe(cwd);
      expect(report.items[0]!.status).toBe(expectedStatus);
      expect(report.items.find(i => i.check === 'node-manifest')!.status).toBe('not-applicable');
      expect(report.ok).toBe(true); // parent package dependencies must not gate this cwd
      const doctor = await runDoctor({
        root: path.join(f.main, '.context-hub'), hubRoot: f.main, checkout: cwd,
        environment: { TUT_USER_CONFIG_DIR: path.join(f.root, 'user') },
        resolveTarget: async () => { throw new Error('fixture agent absent'); },
        fetchImpl: (async () => new Response(JSON.stringify(state))) as typeof fetch,
      });
      const check = doctor.checks.find(c => c.name === 'preflight')!;
      expect(JSON.parse(JSON.stringify(check)).status).toBe(expectedStatus);
      if (expectedStatus === 'warn') {
        expect(renderDoctorReport(doctor)).toContain("switch -- 'topic'");
        expect(check.details.join(' ')).toContain('task unit checkout.ref');
      }
      expect(snapshot(f.root)).toEqual(before);
    }
  });

  it('stops at nested repository boundaries, including damaged entries, and excludes sibling paths', () => {
    const f = fixture(); const nested = path.join(f.wt, 'nested');
    const cwd = path.join(nested, 'src'); mkdirSync(cwd, { recursive: true });
    write(path.join(f.gitdir, 'HEAD'), oldOid);
    mkdirSync(path.join(nested, '.git'));
    expect(inspectWorktree(cwd).status).toBe('not-applicable');
    expect(checkoutContainsCwd(f.wt, cwd)).toBe(false);
    rmSync(path.join(nested, '.git'), { recursive: true });
    write(path.join(nested, '.git'), 'broken pointer');
    expect(inspectWorktree(cwd).detail).toContain('invalid .git pointer');
    expect(inspectWorktree(cwd).detail).not.toContain('detached HEAD');
    expect(checkoutContainsCwd(f.wt, cwd)).toBe(false);
    const first = path.join(f.wt, 'first'), second = path.join(f.wt, 'second');
    mkdirSync(first); mkdirSync(second);
    expect(checkoutContainsCwd(first, second)).toBe(false);
    mkdirSync(path.join(f.main, 'src'));
    expect(inspectWorktree(path.join(f.main, 'src')).status).toBe('not-applicable');
  });

  it('reports detached HEAD through doctor text/JSON, without gating or repairing even in fix mode', async () => {
    const f = fixture(); write(path.join(f.gitdir, 'HEAD'), oldOid);
    const before = snapshot(f.root);
    const report = preflightCheckout(f.wt, [{ ref: 'topic', source: 'task checkout.ref' }]);
    expect(report.ok).toBe(true);
    expect(report.items[0]).toMatchObject({ check: 'worktree-consistency', status: 'warn' });
    expect(report.items[0]!.detail).toContain('detached HEAD');
    expect(report.items[0]!.detail).toContain(newOid);
    expect(report.items[0]!.fix).toContain("switch -- 'topic'");
    expect(report.items[0]!.fix).toContain("person'\\''s worktree");
    const check = preflightCheckFrom(report);
    expect(check.status).toBe('warn');
    expect(JSON.parse(JSON.stringify(check)).details.join(' ')).toContain('detached HEAD');
    expect(renderDoctorReport({ ok: true, checks: [check] })).toContain('result: ok — 1 warning(s), 0 failing');
    const runner = vi.fn();
    const result = await fixPreflight(f.wt, runner);
    expect(result.executed).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
    expect(snapshot(f.root)).toEqual(before);
  });

  it('accepts attached matching branches, packed refs and full commit IDs; labels main/non-Git/separate gitdir not applicable', () => {
    const f = fixture();
    expect(inspectWorktree(f.wt, [{ ref: 'refs/heads/topic', source: 'declared branch' }]).status).toBe('ok');
    rmSync(path.join(f.common, 'refs/heads/topic'));
    write(path.join(f.common, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${newOid} refs/heads/topic\n`);
    expect(inspectWorktree(f.wt, [{ ref: newOid, source: 'frozen ref' }]).status).toBe('ok');
    expect(inspectWorktree(f.wt).detail).toContain('no task ref supplied');
    expect(inspectWorktree(f.main).status).toBe('not-applicable');
    expect(inspectWorktree(f.root).status).toBe('not-applicable');
    expect(inspectWorktree(path.join(f.root, 'missing')).status).toBe('not-applicable');
    const separate = path.join(f.root, 'separate');
    write(path.join(separate, '.git'), `gitdir: ${f.common}`);
    expect(inspectWorktree(separate).status).toBe('not-applicable');
  });

  it('warns on wrong branch even when both tips match, and on frozen commit mismatch', () => {
    const f = fixture(); write(path.join(f.common, 'refs/heads/other'), newOid);
    const mismatch = inspectWorktree(f.wt, [{ ref: 'other', source: 'declared branch' }]);
    expect(mismatch.status).toBe('warn');
    expect(mismatch.detail).toContain('differs from declared branch refs/heads/other');
    expect(inspectWorktree(f.wt, [{ ref: oldOid, source: 'frozen ref' }]).status).toBe('warn');
  });

  it.each(['missing', 'broken-pointer', 'cycle', 'malformed-head', 'unsupported-ref'])('reports unknown or unresolved metadata without crashing: %s', kind => {
    const f = fixture();
    if (kind === 'missing') rmSync(path.join(f.common, 'refs/heads/topic'));
    if (kind === 'broken-pointer') write(path.join(f.gitdir, 'gitdir'), '/missing/.git');
    if (kind === 'cycle') write(path.join(f.common, 'refs/heads/topic'), 'ref: refs/heads/topic');
    if (kind === 'malformed-head') write(path.join(f.gitdir, 'HEAD'), 'not-a-head');
    const check = inspectWorktree(f.wt, kind === 'unsupported-ref' ? [{ ref: 'topic~1', source: 'task ref' }] : []);
    expect(check.status).toBe('warn');
    expect(check.fix).toContain('switch');
    expect(preflightCheckout(f.wt).ok).toBe(true);
  });

  it('doctor consumes matching frozen refs only from an ownership-verified Hub', async () => {
    const f = fixture();
    const doctor = (hubRoot: string) => runDoctor({
      root: path.join(f.main, '.context-hub'), hubRoot: f.main, checkout: f.wt,
      environment: { TUT_USER_CONFIG_DIR: path.join(f.root, 'user') },
      resolveTarget: async () => { throw new Error('fixture agent absent'); },
      fetchImpl: (async () => new Response(JSON.stringify({
        hub_root: hubRoot, flow_mode: 'manual', tasks: [{ task_id: 'unit', checkout: { kind: 'worktree', path: path.relative(f.main, f.wt), ref: 'main' } }],
      }))) as typeof fetch,
    });
    const check = (await doctor(f.main)).checks.find(c => c.name === 'preflight')!;
    expect(check.status).toBe('warn');
    expect(check.details.join(' ')).toContain('task unit checkout.ref');
    expect((await doctor('/foreign')).checks.find(c => c.name === 'preflight')!.status).toBe('ok');
  });
});

describe('launch advisories', () => {
  it('headless plan still succeeds for a detached frozen route and prints switch guidance before any launch', async () => {
    const f = fixture(); write(path.join(f.gitdir, 'HEAD'), oldOid);
    const executable = writeNodeExecutable(path.join(f.root, 'bin', 'codex'), '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = snapshot(f.root);
    const plan = await buildHeadlessPlan({
      task: { task_id: 'unit', title: 'unit', version: 0, checkout: { kind: 'worktree', path: f.wt, ref: 'topic' }, cast: { executor: executable } },
      role: 'executor', records: [], hubRoot: f.main, hubUrl: 'http://127.0.0.1:3001', eventUrl: 'http://127.0.0.1:3002/agent-event', launchCheckout: 'rig',
    });
    expect(plan.checkoutRoot).toBe(f.wt);
    expect(stderr.mock.calls.flat().join('')).toContain('detached HEAD');
    expect(stderr.mock.calls.flat().join('')).toContain("switch -- 'topic'");
    expect(snapshot(f.root)).toEqual(before);
  });

  it('anchored existing branch gate stays strict and includes advisory guidance', async () => {
    const f = fixture(); write(path.join(f.gitdir, 'HEAD'), oldOid);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(buildHeadlessPlan({
      task: { task_id: 'unit', title: 'unit', version: 0, description: `工作区：${process.platform === 'win32' ? f.wt.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/') : f.wt}（分支 topic）` },
      role: 'executor', records: [], hubRoot: f.main, hubUrl: 'http://127.0.0.1:3001', eventUrl: 'http://127.0.0.1:3002/agent-event', launchCheckout: 'anchored',
    })).rejects.toThrow('branch mismatch');
    expect(stderr.mock.calls.flat().join('')).toContain('declared branch');
    expect(stderr.mock.calls.flat().join('')).toContain("switch -- 'topic'");
  });

  it('TUI context resolution reports a frozen branch mismatch without changing the selection', async () => {
    const f = fixture();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const snapshot = await resolveWorkspaceSnapshot({
      caller_cwd: f.main, env: {}, checkout: { kind: 'worktree', path: f.wt, ref: 'main' },
      client: { paneList: async () => ({ panes: [{ pane_id: 'w1:p0', label: 'tut-hub', workspace_id: 'w1', cwd: f.main }] }) },
    });
    expect(snapshot.checkoutRoot).toBe(f.wt);
    expect(stderr.mock.calls.flat().join('')).toContain('task checkout.ref');
    expect(stderr.mock.calls.flat().join('')).toContain("switch -- 'main'");
  });
});

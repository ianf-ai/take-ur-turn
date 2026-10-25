import { writeNodeExecutable } from './helpers/executable.js';
/** Anchored headless checkout.
 *  Covers the five acceptance scenarios and the review v5 closure conditions:
 *  parallel isolation (including space-containing declared paths that are a
 *  prefix of another valid checkout), fail-visible refusals (missing path,
 *  non-worktree, branch mismatch — with and without a TaskMeta route),
 *  malformed/unterminated branch notes, pseudo-repositories rejected, real
 *  relative gitdir pointers resolved against the declared checkout, the
 *  no-declaration fallback audit line, byte-identical rig default, and the
 *  additive RunMeta `checkout` visible in /runs. Worktree shapes are
 *  fabricated on disk exactly as git lays them out, plus real-git pins. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, unlinkSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFlowMode, readLaunchCheckout } from '../src/core/common/config.js';
import { parseWorkspaceDeclaration, validateWorkspaceAnchor } from '../src/standalone/launcher-headless/checkout-anchor.js';
import { buildHeadlessPlan } from '../src/standalone/launcher-headless/plan.js';
import { HeadlessRuntime, complete } from '../src/standalone/launcher-headless/runtime.js';
import { RunStore, delay, validateMeta, type RunMeta } from '../src/core/run/store.js';
import { stopRun } from '../src/core/run/control.js';
import { startServer, type RunningServer } from '../src/core/hub/server.js';
import { hubCreate, hubRead } from '../src/core/hub/hub-client.js';
import { Notifier } from '../src/core/notifier/notifier.js';
import type { ContextRecord } from '../src/core/common/types.js';

// Isolated audit fixtures deliberately remain outside the source repository.
// The declaration grammar is POSIX-rooted. On Windows use the current-drive
// root spelling, which still resolves to this test's actual temporary checkout.
const declaredPath = (file: string) => path.sep === '\\' ? file.replaceAll('\\', '/').replace(/^[a-z]:/i, '') : file;
const roots: string[] = []; const notifiers: Notifier[] = []; const servers: RunningServer[] = []; const runs: { store: RunStore; id: string }[] = [];
function root() { const r = mkdtempSync(path.join(os.tmpdir(), 'tut-anchored-')); roots.push(r); return r; }
function config(r: string, value: unknown) { mkdirSync(path.join(r, '.context-hub'), { recursive: true }); writeFileSync(path.join(r, '.context-hub/config.json'), JSON.stringify(value)); }
function record(version: number, content_type = 'note', role = 'human'): ContextRecord { return { version, task_id: 't', content_type, role, timestamp: new Date().toISOString(), payload: { summary: 'fixture', body: 'fixture' } }; }
async function until(fn: () => boolean | Promise<boolean>, ms = process.platform === 'win32' ? 45_000 : 5000) { const end = performance.now() + ms; while (!await fn()) { if (performance.now() > end) throw new Error('condition timed out'); await delay(25); } }
function fixture(r: string, code: string, name = 'codex') { const bin = path.join(r, 'bin'); mkdirSync(bin, { recursive: true }); const file = path.join(bin, name); return writeNodeExecutable(file, code); }
/** A minimal valid repository layout (git's own markers): HEAD + objects/ + refs/. */
function repoLayout(gitDir: string, branch: string) {
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  mkdirSync(path.join(gitDir, 'objects'));
  mkdirSync(path.join(gitDir, 'refs'));
}
/** Fabricate a main-repo checkout (.git is a directory with a full repo layout). */
function fakeMainCheckout(parent: string, name: string, branch: string) {
  const dir = path.join(parent, name); mkdirSync(dir, { recursive: true });
  repoLayout(path.join(dir, '.git'), branch);
  return dir;
}
/** Fabricate a linked git worktree exactly as git lays it out on disk:
 *  `<wt>/.git` pointer → gitdir with HEAD/commondir/gitdir → common repo. */
function fakeWorktree(parent: string, name: string, branch: string, mainBranch = 'main') {
  const main = path.join(parent, `${name}-main`); mkdirSync(main, { recursive: true });
  repoLayout(path.join(main, '.git'), mainBranch);
  const wt = path.join(parent, name); mkdirSync(wt, { recursive: true });
  const gitdir = path.join(main, '.git', 'worktrees', name); mkdirSync(gitdir, { recursive: true });
  writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
  writeFileSync(path.join(gitdir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`);
  return wt;
}
function planEnv(hub: string) { return { ...process.env, PATH: `${path.join(hub, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` }; }
afterEach(async () => {
  for (const n of notifiers.splice(0)) await n.close();
  for (const { store, id } of runs.splice(0)) { try { if (!complete(store.read(id))) await stopRun(store, id); } catch { /* already terminal */ } }
  for (const s of servers.splice(0)) await s.close();
  vi.unstubAllEnvs();
  // No audit records or runs are deleted; temp roots survive for diagnosis.
});

describe('launch.checkout strict config read', () => {
  it('defaults to rig without writes and accepts only exact strings', async () => {
    const r = root(), c = path.join(r, '.context-hub');
    expect(await readLaunchCheckout(c)).toBe('rig');
    config(r, { flow_mode: 'manual' }); expect(await readLaunchCheckout(c)).toBe('rig');
    config(r, { flow_mode: 'manual', launch: { checkout: 'anchored' } }); expect(await readLaunchCheckout(c)).toBe('anchored');
    config(r, { flow_mode: 'manual', launch: {} }); expect(await readLaunchCheckout(c)).toBe('rig');
  });
  it.each([null, '', 'ANCHORED', 'anchored ', 1, false, [], {}, 'rig/anchored'])('rejects invalid checkout value %j without breaking flow reads', async v => {
    const r = root(); config(r, { flow_mode: 'auto', launch: { checkout: v } });
    await expect(readLaunchCheckout(path.join(r, '.context-hub'))).rejects.toThrow('launch.checkout');
    expect(await readFlowMode(path.join(r, '.context-hub'))).toBe('auto');
  });
  it('rejects a non-object launch section and corrupt files', async () => {
    const r = root(); config(r, { flow_mode: 'manual', launch: 'anchored' }); await expect(readLaunchCheckout(path.join(r, '.context-hub'))).rejects.toThrow('launch.checkout');
    const r2 = root(); mkdirSync(path.join(r2, '.context-hub'), { recursive: true }); writeFileSync(path.join(r2, '.context-hub/config.json'), '{');
    await expect(readLaunchCheckout(path.join(r2, '.context-hub'))).rejects.toThrow('corrupt');
  });
});

describe('workspace declaration parsing', () => {
  it('finds the canonical task-book line with branch note and trailing prose', () => {
    const description = '## 授权与工作区\n授权来源：owner。\n工作区：/w/unit-a（分支 owner/unit-a），合入由驱动 approve 后执行。\n\n## 要改变的行为\n修复。';
    expect(parseWorkspaceDeclaration(description)).toEqual({ status: 'declared', path: '/w/unit-a', branch: 'owner/unit-a' });
  });
  it('keeps space-containing paths whole instead of truncating to a prefix', () => {
    expect(parseWorkspaceDeclaration('工作区：/w/checkout intended（分支 feature/intended），合入由驱动执行。'))
      .toEqual({ status: 'declared', path: '/w/checkout intended', branch: 'feature/intended' });
    expect(parseWorkspaceDeclaration('工作区：/w/checkout intended')).toEqual({ status: 'declared', path: '/w/checkout intended' });
    expect(parseWorkspaceDeclaration('工作区：/w/a b c（分支 feat）')).toEqual({ status: 'declared', path: '/w/a b c', branch: 'feat' });
  });
  it('refuses branch notes that were written but malformed', () => {
    expect(() => parseWorkspaceDeclaration('工作区：/w/a（分支 feat')).toThrow('malformed');
    expect(() => parseWorkspaceDeclaration('工作区：/w/a (分支 feat')).toThrow('malformed');
    expect(() => parseWorkspaceDeclaration('工作区：/w/a（分支）')).toThrow('malformed');
    expect(() => parseWorkspaceDeclaration('工作区：/w/a（分支 ）')).toThrow('malformed');
  });
  it('accepts ASCII parens, omitted branch notes, and non-branch parentheticals', () => {
    expect(parseWorkspaceDeclaration('工作区：/w/a (分支 feat)')).toEqual({ status: 'declared', path: '/w/a', branch: 'feat' });
    expect(parseWorkspaceDeclaration('工作区：/w/a')).toEqual({ status: 'declared', path: '/w/a' });
    expect(parseWorkspaceDeclaration('工作区：/w/a（备注 其他）')).toEqual({ status: 'declared', path: '/w/a' });
    expect(parseWorkspaceDeclaration('工作区：  /w/a（分支 b）')).toEqual({ status: 'declared', path: '/w/a', branch: 'b' });
    expect(parseWorkspaceDeclaration('工作区：/w/a，合入由驱动 approve 后执行。')).toEqual({ status: 'declared', path: '/w/a' });
  });
  it('returns none for descriptions without the declaration line', () => {
    expect(parseWorkspaceDeclaration('## 要改变的行为\n正文没有声明。')).toEqual({ status: 'none' });
    expect(parseWorkspaceDeclaration('前置工作区：/w/a').status).toBe('none');
  });
  it('refuses malformed lines and ambiguous distinct declarations', () => {
    expect(() => parseWorkspaceDeclaration('工作区：relative/path')).toThrow('malformed');
    expect(() => parseWorkspaceDeclaration('工作区：/w/a（分支 x）\n工作区：/w/b（分支 y）')).toThrow('ambiguous');
    expect(parseWorkspaceDeclaration('工作区：/w/a（分支 x）\n工作区：/w/a（分支 x）')).toEqual({ status: 'declared', path: '/w/a', branch: 'x' });
  });
});

describe('workspace anchor validation (git layouts, no git execution)', () => {
  it('accepts a linked worktree and a main-repo checkout with matching branch', async () => {
    const r = root(); const wt = fakeWorktree(r, 'unit-a', 'owner/unit-a');
    await expect(validateWorkspaceAnchor({ path: wt, branch: 'owner/unit-a' })).resolves.toBe(wt);
    const main = fakeMainCheckout(r, 'repo', 'main');
    await expect(validateWorkspaceAnchor({ path: main, branch: 'main' })).resolves.toBe(main);
    await expect(validateWorkspaceAnchor({ path: wt })).resolves.toBe(wt);
  });
  it('refuses missing path, non-worktree directory, and dangling gitdir', async () => {
    const r = root();
    await expect(validateWorkspaceAnchor({ path: path.join(r, 'gone') })).rejects.toThrow('does not exist');
    const plain = path.join(r, 'plain'); mkdirSync(plain); await expect(validateWorkspaceAnchor({ path: plain })).rejects.toThrow('not a git worktree');
    const wt = fakeWorktree(r, 'dangling', 'b'); writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/worktrees/x\n');
    await expect(validateWorkspaceAnchor({ path: wt })).rejects.toThrow('gitdir');
  });
  it('refuses pseudo-repositories: a bare HEAD proves nothing', async () => {
    const r = root();
    const pseudoMain = path.join(r, 'pseudo-main'); mkdirSync(path.join(pseudoMain, '.git'), { recursive: true });
    writeFileSync(path.join(pseudoMain, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await expect(validateWorkspaceAnchor({ path: pseudoMain })).rejects.toThrow('not a valid git repository');
    const thin = path.join(r, 'thin'); mkdirSync(thin);
    const thinMain = path.join(r, 'thin-main'); repoLayout(path.join(thinMain, '.git'), 'main');
    const thinGitdir = path.join(thinMain, '.git', 'worktrees', 'thin');
    mkdirSync(thinGitdir, { recursive: true }); writeFileSync(path.join(thinGitdir, 'HEAD'), 'ref: refs/heads/b\n'); // no commondir, no repo layout
    writeFileSync(path.join(thin, '.git'), `gitdir: ${thinGitdir}\n`);
    await expect(validateWorkspaceAnchor({ path: thin })).rejects.toThrow('not a valid git repository');
    const brokenCommon = fakeWorktree(r, 'broken-common', 'b');
    const brokenGitdir = path.join(r, 'broken-common-main', '.git', 'worktrees', 'broken-common');
    writeFileSync(path.join(brokenGitdir, 'commondir'), '../../../nowhere\n');
    await expect(validateWorkspaceAnchor({ path: brokenCommon })).rejects.toThrow('not a valid git repository');
  });
  it('resolves a relative gitdir pointer against the declared checkout, not the caller cwd', async () => {
    const r = root(); const main = fakeMainCheckout(r, 'relative-main', 'main');
    const wt = path.join(r, 'elsewhere', 'relative-wt'); mkdirSync(path.dirname(wt), { recursive: true }); mkdirSync(wt);
    const gitdir = path.join(main, '.git', 'worktrees', 'relative-wt'); mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(wt, '.git'), 'gitdir: ../../relative-main/.git/worktrees/relative-wt\n');
    writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/feature/relative\n');
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(wt, '.git')}\n`);
    // The calling cwd (this test process's worktree) is unrelated to the
    // declaration; success proves the pointer resolved against the checkout.
    await expect(validateWorkspaceAnchor({ path: wt, branch: 'feature/relative' })).resolves.toBe(wt);
    await expect(validateWorkspaceAnchor({ path: wt, branch: 'wrong' })).rejects.toThrow('branch mismatch: declared wrong, actual feature/relative');
  });
  it('names the exact branch mismatch, including detached heads', async () => {
    const r = root(); const wt = fakeWorktree(r, 'unit-b', 'owner/real');
    await expect(validateWorkspaceAnchor({ path: wt, branch: 'owner/declared' })).rejects.toThrow('branch mismatch: declared owner/declared, actual owner/real');
    writeFileSync(path.join(r, 'unit-b-main', '.git', 'worktrees', 'unit-b', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    await expect(validateWorkspaceAnchor({ path: wt, branch: 'owner/declared' })).rejects.toThrow('actual (detached)');
  });
  it('accepts fabricated separate-git-dir checkouts (pointer to a complete repository)', async () => {
    const r = root();
    const repo = path.join(r, 'sep-repo'); repoLayout(repo, 'main');
    const checkout = path.join(r, 'sep-checkout'); mkdirSync(checkout);
    writeFileSync(path.join(checkout, '.git'), `gitdir: ${repo}\n`); // no commondir — a whole-repository pointer
    await expect(validateWorkspaceAnchor({ path: checkout, branch: 'main' })).resolves.toBe(checkout);
    await expect(validateWorkspaceAnchor({ path: checkout, branch: 'other' })).rejects.toThrow('branch mismatch: declared other, actual main');
  });
  it('pins the fabricated layout against real git (main checkout and linked worktree)', async () => {
    const r = root(); const main = path.join(r, 'real-main'); mkdirSync(main);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execSync('git init --initial-branch=main', { cwd: main, stdio: 'ignore', env });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd: main, stdio: 'ignore', env });
    await expect(validateWorkspaceAnchor({ path: main, branch: 'main' })).resolves.toBe(main);
    const wt = path.join(r, 'real-wt');
    execSync(`git worktree add -b owner/real-branch "${wt}"`, { cwd: main, stdio: 'ignore', env });
    await expect(validateWorkspaceAnchor({ path: wt, branch: 'owner/real-branch' })).resolves.toBe(wt);
    const pseudo = path.join(r, 'real-pseudo'); mkdirSync(path.join(pseudo, '.git'), { recursive: true });
    writeFileSync(path.join(pseudo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await expect(validateWorkspaceAnchor({ path: pseudo })).rejects.toThrow('not a valid git repository');
  });
  it('accepts real separate-git-dir checkouts, absolute and relative, branch-checked (review v12 N1)', async () => {
    const r = root(); const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const gitdir = path.join(r, 'separate-gitdir');
    const checkout = path.join(r, 'separate-checkout');
    execSync(`git init --initial-branch=main --separate-git-dir="${gitdir}" "${checkout}"`, { cwd: r, stdio: 'ignore', env });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', { cwd: checkout, stdio: 'ignore', env });
    // Absolute pointer (git's default): validation and plan both succeed from
    // an unrelated process cwd; branch mismatch still refuses.
    await expect(validateWorkspaceAnchor({ path: checkout, branch: 'main' })).resolves.toBe(checkout);
    await expect(validateWorkspaceAnchor({ path: checkout, branch: 'nope' })).rejects.toThrow('branch mismatch: declared nope, actual main');
    // Relative pointer: rewritten by hand, resolved against the declared checkout.
    unlinkSync(path.join(checkout, '.git')); // Git for Windows marks its pointer file read-only.
    writeFileSync(path.join(checkout, '.git'), 'gitdir: ../separate-gitdir\n');
    await expect(validateWorkspaceAnchor({ path: checkout, branch: 'main' })).resolves.toBe(checkout);
    // The same declaration anchors a real plan (cwd/checkout = declared path).
    const hub = root(); fixture(hub, ''); config(hub, { flow_mode: 'manual', launch: { checkout: 'anchored' } });
    const plan = await buildHeadlessPlan({ task: { task_id: 't', title: 't', version: 1 }, role: 'executor',
      records: [record(1, 'design', 'architect')], hubRoot: hub, hubUrl: 'http://127.0.0.1:1', eventUrl: 'http://127.0.0.1:2', env: planEnv(hub),
      description: `## 授权与工作区\n工作区：${declaredPath(checkout)}（分支 main），合入由驱动 approve 后执行。` });
    expect(plan.checkoutRoot).toBe(checkout); expect(plan.checkout).toBe(checkout);
  });
});

describe('anchored plan resolution', () => {
  const declaration = (wt: string, branch: string) => `## 授权与工作区\n工作区：${declaredPath(wt)}（分支 ${branch}），合入由驱动 approve 后执行。`;
  const base = (hub: string, taskId: string) => ({ task: { task_id: taskId, title: taskId, version: 1 }, role: 'executor', records: [record(1, 'design', 'architect')], hubRoot: hub, hubUrl: 'http://127.0.0.1:1', eventUrl: 'http://127.0.0.1:2', env: planEnv(hub) });
  it('isolates two tasks anchored at distinct declared worktrees', async () => {
    const hub = root(); fixture(hub, ''); const r2 = root();
    const a = fakeWorktree(r2, 'unit-a', 'owner/a'), b = fakeWorktree(r2, 'unit-b', 'owner/b');
    config(hub, { flow_mode: 'manual', launch: { checkout: 'anchored' } });
    const make = (taskId: string, wt: string, branch: string) => buildHeadlessPlan({ ...base(hub, taskId), description: declaration(wt, branch) });
    const [pa, pb] = await Promise.all([make('a', a, 'owner/a'), make('b', b, 'owner/b')]);
    expect(pa.checkoutRoot).toBe(a); expect(pa.checkout).toBe(a); expect(pa.checkout_fallback).toBeUndefined();
    expect(pb.checkoutRoot).toBe(b); expect(pb.checkout).toBe(b);
    expect(pa.target_digest).not.toBe(pb.target_digest);
  });
  it('anchors the full space-containing declaration, not a prefix checkout (review regression)', async () => {
    const hub = root(); fixture(hub, ''); const r2 = root();
    // `prefix` is a real main checkout; the declared worktree is `prefix intended`,
    // a linked worktree of the same repository whose name extends it with a space.
    const prefix = fakeMainCheckout(r2, 'prefix', 'main');
    const target = path.join(r2, 'prefix intended'); mkdirSync(target);
    const gitdir = path.join(prefix, '.git', 'worktrees', 'intended'); mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(target, '.git'), `gitdir: ${gitdir}\n`);
    writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/feature/intended\n');
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    writeFileSync(path.join(gitdir, 'gitdir'), `${path.join(target, '.git')}\n`);
    config(hub, { flow_mode: 'manual', launch: { checkout: 'anchored' } });
    const plan = await buildHeadlessPlan({ ...base(hub, 't'), description: declaration(target, 'feature/intended') });
    expect(plan.checkoutRoot).toBe(target); expect(plan.checkout).toBe(target);
    expect(plan.checkoutRoot).not.toBe(prefix);
  });
  it('refuses fail-visibly per validation item: missing path, non-worktree, branch mismatch', async () => {
    const hub = root(); fixture(hub, ''); const r2 = root();
    const missing = path.join(r2, 'gone'); const plain = path.join(r2, 'plain'); mkdirSync(plain);
    const wrong = fakeWorktree(r2, 'wrong', 'owner/other');
    config(hub, { flow_mode: 'manual', launch: { checkout: 'anchored' } });
    const attempt = (wt: string, branch: string) => buildHeadlessPlan({ ...base(hub, 't'), description: declaration(wt, branch) });
    await expect(attempt(missing, 'x')).rejects.toThrow('does not exist');
    await expect(attempt(plain, 'x')).rejects.toThrow('not a git worktree');
    await expect(attempt(wrong, 'owner/declared')).rejects.toThrow('branch mismatch: declared owner/declared, actual owner/other');
    await expect(attempt('relative/path', 'x')).rejects.toThrow('malformed');
    await expect(buildHeadlessPlan({ ...base(hub, 't') })).rejects.toThrow('description unavailable');
  });
  it('applies the declaration checks to TaskMeta worktree tasks with the same path', async () => {
    const hub = root(); fixture(hub, ''); const r2 = root();
    const main = fakeMainCheckout(r2, 'taskmeta-main', 'main'); // TaskMeta target on branch main
    config(hub, { flow_mode: 'manual', launch: { checkout: 'anchored' } });
    const withMeta = { task: { task_id: 't', title: 't', version: 1, checkout: { kind: 'worktree' as const, path: main } } };
    // Same path, declared branch does not match the actual branch → refuse.
    await expect(buildHeadlessPlan({ ...base(hub, 't'), ...withMeta, description: declaration(main, 'feature/required') }))
      .rejects.toThrow('branch mismatch: declared feature/required, actual main');
    // Same path, non-worktree sibling → refuse via the declaration's checks.
    const plain = path.join(r2, 'plain2'); mkdirSync(plain);
    await expect(buildHeadlessPlan({ ...base(hub, 't'), task: { task_id: 't', title: 't', version: 1, checkout: { kind: 'worktree', path: plain } }, description: declaration(plain, 'x') }))
      .rejects.toThrow('not a git worktree');
    // Same path, correct declaration → lands there with checkout registered.
    const plan = await buildHeadlessPlan({ ...base(hub, 't'), ...withMeta, description: declaration(main, 'main') });
    expect(plan.checkoutRoot).toBe(main); expect(plan.checkout).toBe(main); expect(plan.checkout_fallback).toBeUndefined();
  });
  it('refuses differing TaskMeta and declaration paths instead of silently substituting', async () => {
    const hub = root(); fixture(hub, ''); const r2 = root();
    const meta = fakeWorktree(r2, 'meta-wt', 'owner/meta'), other = fakeWorktree(r2, 'other-wt', 'owner/other');
    config(hub, { flow_mode: 'manual', launch: { checkout: 'anchored' } });
    await expect(buildHeadlessPlan({ ...base(hub, 't'), description: declaration(other, 'owner/other'), task: { task_id: 't', title: 't', version: 1, checkout: { kind: 'worktree', path: meta } } }))
      .rejects.toThrow('conflicts with the task\'s frozen checkout route');
  });
  it('falls back to the rig root with an audit line when no declaration exists (TaskMeta included)', async () => {
    const hub = root(); fixture(hub, ''); const r2 = root();
    const meta = fakeWorktree(r2, 'meta-wt2', 'owner/meta');
    config(hub, { flow_mode: 'manual', launch: { checkout: 'anchored' } });
    const plan = await buildHeadlessPlan({ ...base(hub, 't'), description: '## 要改变的行为\n无声明。' });
    expect(plan.checkoutRoot).toBe(hub); expect(plan.checkout).toBeUndefined(); expect(plan.checkout_fallback).toBe(true);
    const taskMetaPlan = await buildHeadlessPlan({ ...base(hub, 't'), description: '## 要改变的行为\n无声明。', task: { task_id: 't', title: 't', version: 1, checkout: { kind: 'worktree', path: meta } } });
    expect(taskMetaPlan.checkoutRoot).toBe(hub); expect(taskMetaPlan.checkout_fallback).toBe(true);
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(hub, { send: async () => {}, log: line => logs.push(line), read: async () => [], start: async () => '20261018T000000000Z-00000000' });
    runtime.launch(plan);
    expect(logs.some(l => l.includes('detached checkout fallback') && l.includes('工作区') && l.includes(hub))).toBe(true);
  });
  it('keeps the rig default byte-identical: no new fields, no config dependency', async () => {
    const hub = root(); fixture(hub, '');
    const plan = await buildHeadlessPlan({ ...base(hub, 't'), description: declaration('/w/ignored', 'x') });
    expect(plan.checkoutRoot).toBe(hub); expect('checkout' in plan).toBe(false); expect('checkout_fallback' in plan).toBe(false);
    config(hub, { flow_mode: 'auto' }); // unrelated keys must not flip the policy
    const again = await buildHeadlessPlan({ ...base(hub, 't'), description: declaration('/w/ignored', 'x') });
    expect(again.checkoutRoot).toBe(hub); expect('checkout' in again).toBe(false);
  });
  it('refuses the launch when the config value is illegal (self-read path)', async () => {
    const hub = root(); fixture(hub, ''); config(hub, { flow_mode: 'manual', launch: { checkout: 'everywhere' } });
    await expect(buildHeadlessPlan({ ...base(hub, 't'), description: '工作区：/w/a' })).rejects.toThrow('launch.checkout');
  });
});

// The real supervisor is the built same-package module used in installed execution.
const builtControl = await import(path.resolve('dist/core/run/control.js')) as typeof import('../src/core/run/control.js');

describe('RunMeta checkout field and /runs projection (real chain)', () => {
  it('spawns two anchored runs in their own worktrees and projects checkout in /runs', async () => {
    const hub = root();
    const agent = fixture(hub, `console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'})); console.log(process.cwd());`);
    const r2 = root(); const a = fakeWorktree(r2, 'run-a', 'owner/a'), b = fakeWorktree(r2, 'run-b', 'owner/b');
    const store = new RunStore(hub);
    const ownership = (attempt: string) => ({ schema: 1 as const, role: 'executor', attempt_id: attempt, base_version: 0, trigger_version: 0, route: { agent, args: [] as string[] }, route_source: 'builtin-default', session_reason: 'fresh: fixture' });
    const idA = await builtControl.startRun(store, [agent], a, 'task-a', { headless: ownership('01234567-89ab-cdef-0123-456789abc001'), checkout: a });
    const idB = await builtControl.startRun(store, [agent], b, 'task-b', { headless: ownership('01234567-89ab-cdef-0123-456789abc002'), checkout: b });
    runs.push({ store, id: idA }, { store, id: idB });
    await until(() => complete(store.read(idA)) && complete(store.read(idB)));
    const ma = store.read(idA), mb = store.read(idB);
    expect(ma.checkout).toBe(a); expect(ma.cwd).toBe(a); expect(mb.checkout).toBe(b); expect(mb.cwd).toBe(b);
    const server = await startServer({ root: path.join(hub, '.context-hub'), port: 0 }); servers.push(server);
    const response = await fetch(`${server.url}/runs`); const body = await response.json() as { runs: { run_id: string; checkout?: string }[] };
    expect(body.runs.find(e => e.run_id === idA)?.checkout).toBe(a);
    expect(body.runs.find(e => e.run_id === idB)?.checkout).toBe(b);
  });
  it('rejects relative or non-string checkout values in meta validation', () => {
    const valid: RunMeta = { run_id: 'x', pid: 2, pgid: 2, argv: ['x'], cwd: '/tmp', started_at: new Date().toISOString(), status: 'running', supervisor_pid: 3 };
    expect(() => validateMeta({ ...valid, checkout: 'relative/path' }, 'x')).toThrow('invalid optional run metadata');
    expect(() => validateMeta({ ...valid, checkout: 3 }, 'x')).toThrow('invalid optional run metadata');
    expect(validateMeta({ ...valid, checkout: '/w/a' }, 'x').checkout).toBe('/w/a');
  });
});

describe('notifier anchored end-to-end (real Hub, marker, spawn)', () => {
  const harness = async (extraConfig: Record<string, unknown>, description: string) => {
    const hub = root();
    const agent = fixture(hub, `console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'})); console.log(process.cwd());`);
    config(hub, { flow_mode: 'auto', launch_mode: 'headless', auto: { launch_roles: ['executor', 'reviewer'] }, ...extraConfig });
    vi.stubEnv('TUT_HUB_ROOT', hub); vi.stubEnv('TUT_PROJECT_ROOT', hub);
    const server = await startServer({ root: path.join(hub, '.context-hub'), port: 0 }); servers.push(server);
    const logs: string[] = [];
    const runtime = new HeadlessRuntime(hub, { start: builtControl.startRun, stop: builtControl.stopRun, send: async () => {}, log: line => logs.push(line), hubUrl: server.url, read: async id => (await hubRead(server.url, id)).versions });
    const forbidden = vi.fn(async () => { throw new Error('Herdr was called'); });
    const notifier = new Notifier({ url: server.url, eventPort: 1, interval: 1, stallTimeoutMin: 0 }, { headlessRuntime: runtime, channelsFor: () => [], log: line => logs.push(line), listAnchorPanes: forbidden, listPanes: forbidden, launch: forbidden, cleanupPanes: forbidden, remediator: { remediate: forbidden }, relayHostStatus: async () => {} });
    notifiers.push(notifier); await notifier.requestCompare();
    const task = await hubCreate(server.url, { title: 'anchored fixture', description, flow: 'direct', creator: 'test', role: 'human', cast: { executor: agent, reviewer: agent } });
    return { hub, agent, server, runtime, notifier, logs, task };
  };
  it('launches an anchored task in its declared worktree with meta.checkout recorded', async () => {
    const hub = root(); const wt = fakeWorktree(hub, 'declared-wt', 'owner/declared');
    const h = await harness({ launch: { checkout: 'anchored' } }, `## 授权与工作区\n工作区：${declaredPath(wt)}（分支 owner/declared），合入由驱动 approve 后执行。`);
    await h.notifier.requestCompare();
    await until(() => h.runtime.runs().some(m => m.task_id === h.task.task_id));
    const meta = h.runtime.runs().find(m => m.task_id === h.task.task_id)!; runs.push({ store: h.runtime.store, id: meta.run_id });
    await until(() => complete(h.runtime.store.read(meta.run_id)));
    expect(meta.cwd).toBe(wt); expect(meta.checkout).toBe(wt);
  });
  it('audits the rig-root fallback through the notifier chain', async () => {
    const h = await harness({ launch: { checkout: 'anchored' } }, '## 要改变的行为\n无工作区声明。');
    await h.notifier.requestCompare();
    await until(() => h.runtime.runs().some(m => m.task_id === h.task.task_id && complete(h.runtime.store.read(m.run_id))));
    const meta = h.runtime.runs().find(m => m.task_id === h.task.task_id)!; runs.push({ store: h.runtime.store, id: meta.run_id });
    expect(meta.cwd).toBe(realpathSync(h.hub)); expect('checkout' in meta).toBe(false);
    expect(h.logs.some(l => l.includes('detached checkout fallback') && l.includes(h.task.task_id))).toBe(true);
  });
});

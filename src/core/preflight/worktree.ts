/** Advisory inspection of linked worktrees. Reads Git metadata only; never
 * executes Git, repairs metadata, or grants permission to change branches. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { PreflightItem } from './index.js';

export interface WorktreeExpectation {
  ref: string;
  source: string;
}

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
const absent = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

function readOptional(file: string): string | undefined {
  try { return readFileSync(file, 'utf8').trim(); }
  catch (error) { if (absent(error)) return undefined; throw error; }
}

/** Find the nearest checkout boundary without changing the execution cwd.
 * Stop at any .git entry, including a damaged entry or a nested repository;
 * never borrow an outer repository's identity past that boundary. */
export function findCheckoutRoot(cwd: string): string | undefined {
  let candidate: string;
  try { candidate = realpathSync(cwd); }
  catch (error) { if (absent(error)) return undefined; throw error; }
  for (;;) {
    try { lstatSync(path.join(candidate, '.git')); return candidate; }
    catch (error) { if (!absent(error)) throw error; }
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

/** A task path covers its subdirectories, but not an embedded repository or
 * a sibling directory. Resolve symlinks before comparing either boundary. */
export function checkoutContainsCwd(checkout: string, cwd: string): boolean {
  const relative = path.relative(realpathSync(checkout), realpathSync(cwd));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const root = findCheckoutRoot(checkout);
  return root !== undefined && root === findCheckoutRoot(cwd);
}

function safeRef(ref: string): boolean {
  return ref.startsWith('refs/') && !/[\s\\~^:?*\[\x00-\x1f\x7f]/u.test(ref)
    && !ref.includes('..') && !ref.includes('@{')
    && ref.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Loose refs override packed refs. Follow symbolic refs with a bounded
 * depth; unsupported formats are unknown, never inferred to be healthy. */
function resolveRef(common: string, ref: string, depth = 0): string | undefined {
  if (!safeRef(ref) || depth >= 8) throw new Error(`unsupported or cyclic ref: ${ref}`);
  const loose = readOptional(path.join(common, ref));
  if (loose !== undefined) {
    if (oid.test(loose)) return loose.toLowerCase();
    if (loose.startsWith('ref: ')) return resolveRef(common, loose.slice(5), depth + 1);
    throw new Error(`invalid ref contents: ${ref}`);
  }
  const packed = readOptional(path.join(common, 'packed-refs'));
  for (const line of packed?.split(/\r?\n/u) ?? []) {
    const [hash, name] = line.split(' ');
    if (name === ref) {
      if (hash === undefined || !oid.test(hash)) throw new Error(`invalid packed ref: ${ref}`);
      return hash.toLowerCase();
    }
  }
  return undefined;
}

export function inspectWorktree(checkout: string, expectations: readonly WorktreeExpectation[] = []): PreflightItem {
  let root = path.resolve(checkout);
  const item = (status: PreflightItem['status'], detail: string, fix?: string): PreflightItem => ({
    check: 'worktree-consistency', status, detail, ...(fix === undefined ? {} : { fix }),
  });
  let branch: string | undefined;
  const guidance = (): string => {
    const target = expectations.find(e => !oid.test(e.ref) && safeRef(e.ref.startsWith('refs/') ? e.ref : `refs/heads/${e.ref}`)
      && (!e.ref.startsWith('refs/') || e.ref.startsWith('refs/heads/')))?.ref ?? branch;
    const command = target === undefined
      ? `git -C ${quote(root)} switch <intended-branch>`
      : `git -C ${quote(root)} switch -- ${quote(target.replace(/^refs\/heads\//u, ''))}`;
    return `inspect status and preserve changes/reflogs first; after confirming the intended branch, run ${command} by hand (POSIX shell example); TUT never switches or repairs Git metadata`;
  };
  try {
    const found = findCheckoutRoot(checkout);
    if (found === undefined) return item('not-applicable', `${root}: no enclosing .git entry (not a linked worktree)`);
    root = found;
    const dotGit = path.join(root, '.git');
    const info = lstatSync(dotGit);
    if (info.isDirectory()) return item('not-applicable', `${root}: main checkout (not a linked worktree)`);
    if (!info.isFile()) throw new Error('.git is not a regular file or directory');
    const pointer = /^gitdir: (.+)$/u.exec(readFileSync(dotGit, 'utf8').trim());
    if (!pointer) throw new Error('invalid .git pointer');
    const gitdir = path.resolve(root, pointer[1]!);
    const commonPointer = readOptional(path.join(gitdir, 'commondir'));
    if (commonPointer === undefined) {
      if (lstatSync(path.join(gitdir, 'objects')).isDirectory() && lstatSync(path.join(gitdir, 'refs')).isDirectory()) {
        return item('not-applicable', `${root}: separate Git directory (not a linked worktree)`);
      }
      throw new Error('missing commondir');
    }
    if (!commonPointer) throw new Error('empty commondir');
    const common = path.resolve(gitdir, commonPointer);
    const backPointer = readOptional(path.join(gitdir, 'gitdir'));
    if (!backPointer || realpathSync(path.resolve(gitdir, backPointer)) !== realpathSync(dotGit)) {
      throw new Error('worktree gitdir back-pointer does not match checkout');
    }
    const head = readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
    const match = /^ref: (refs\/heads\/.+)$/u.exec(head);
    branch = match?.[1];
    const problems: string[] = [];
    let headOid: string | undefined;
    if (branch !== undefined) {
      headOid = resolveRef(common, branch);
      if (headOid === undefined) problems.push(`HEAD branch ${branch} is unresolved (possibly unborn)`);
    } else if (oid.test(head)) {
      headOid = head.toLowerCase();
      problems.push(`detached HEAD at ${headOid}`);
    } else {
      throw new Error(`invalid or unsupported HEAD: ${head}`);
    }
    for (const expected of expectations) {
      if (oid.test(expected.ref)) {
        if (headOid !== expected.ref.toLowerCase()) problems.push(`HEAD ${headOid ?? 'unknown'} differs from ${expected.source} ${expected.ref}`);
        continue;
      }
      const expectedBranch = expected.ref.startsWith('refs/') ? expected.ref : `refs/heads/${expected.ref}`;
      // Task refs are hints, not necessarily branches. Do not pretend to
      // interpret arbitrary revision expressions or annotated tag objects.
      if (!expectedBranch.startsWith('refs/heads/') || !safeRef(expectedBranch)) {
        problems.push(`cannot verify ${expected.source} ${expected.ref}: only branch names and full commit IDs are supported`);
        continue;
      }
      const expectedOid = resolveRef(common, expectedBranch);
      if (expectedOid === undefined) problems.push(`${expected.source} ${expected.ref} is unresolved`);
      if (branch !== expectedBranch || headOid !== expectedOid) {
        problems.push(`HEAD ${branch ?? '(detached)'} at ${headOid ?? 'unknown'} differs from ${expected.source} ${expectedBranch} at ${expectedOid ?? 'unknown'}`);
      }
    }
    const evidence = `${root}: HEAD=${branch ?? '(detached)'} ${headOid ?? 'unknown'}; ${expectations.length ? expectations.map(e => `${e.source}=${e.ref}`).join(', ') : 'no task ref supplied; checked attached branch only'}`;
    return problems.length ? item('warn', `${evidence}; ${problems.join('; ')}`, guidance()) : item('ok', evidence);
  } catch (error) {
    return item('warn', `${root}: worktree consistency unknown: ${(error as Error).message}`, guidance());
  }
}

export function reportWorktreeWarning(item: PreflightItem, log: (line: string) => void = line => { process.stderr.write(`${line}\n`); }): void {
  if (item.status === 'warn') log(`checkout preflight warning [${item.check}]: ${item.detail}\n  guidance: ${item.fix}`);
}

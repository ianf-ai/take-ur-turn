/** Headless anchored checkout: parse and validate the task book's workspace
 *  declaration line.
 *
 *  The machine-readable convention is a line starting with「工作区：」followed
 *  by a POSIX absolute path and an optional「（分支 <name>）」parenthetical
 *  (full-width or ASCII parens; the branch note may be omitted). The path may
 *  contain spaces and runs to the first delimiter — a parenthetical opener,
 *  a list separator (，,;；), or end of line; ordinary trailing remarks and
 *  non-branch parentheticals stay legal. A branch note that was written but
 *  is malformed (unterminated, empty name) is refused, never silently
 *  dropped; a present-but-malformed declaration line is refused too.
 *
 *  Validation proves three things before any marker or spawn — the path
 *  exists, it is a git worktree, and the worktree's current branch matches
 *  the declaration. Worktree validity is proven from the filesystem exactly
 *  as git lays it out (never by executing git): a main checkout needs
 *  `.git/{HEAD,objects,refs}`; a `.git` pointer file resolves against the
 *  declared checkout and must target either a linked worktree's gitdir
 *  (HEAD/commondir/gitdir plus a valid common dir) or a separate-git-dir
 *  repository (a complete layout on its own — `git init --separate-git-dir`).
 *  Any failure refuses the launch with the specific mismatch named; no
 *  declaration line at all falls back to the rig root with one audit line.
 */

import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** One parsed「工作区：」declaration. */
export interface WorkspaceDeclaration {
  /** POSIX absolute path exactly as declared (normalized only lexically). */
  path: string;
  /** Declared branch from the「（分支 <name>）」note, when present. */
  branch?: string;
}

export type DeclarationParse =
  | { status: "none" }
  | ({ status: "declared" } & WorkspaceDeclaration);

const DECLARATION_PREFIX = "工作区：";
// Delimiters that end the path token: a parenthetical opener (branch note or
// ordinary remark) or a list separator before trailing prose.
const PATH_DELIMITERS = ["（", "(", "，", ",", "；", ";"] as const;

function malformed(line: string, reason: string): Error {
  return new Error(
    `anchored checkout: malformed 工作区 declaration line: "${line.trim()}" (${reason}; expected ${DECLARATION_PREFIX}<absolute-path>（分支 <branch>）)`,
  );
}

function parseDeclarationLine(line: string): WorkspaceDeclaration {
  const rest = line.slice(DECLARATION_PREFIX.length).trimStart();
  const delimiterIndex = PATH_DELIMITERS.map((d) => rest.indexOf(d)).reduce(
    (min, i) => (i !== -1 && (min === -1 || i < min) ? i : min),
    -1,
  );
  const declaredPath = (delimiterIndex === -1 ? rest : rest.slice(0, delimiterIndex)).trimEnd();
  if (!declaredPath.startsWith("/")) throw malformed(line, "path is not absolute");
  let branch: string | undefined;
  if (delimiterIndex !== -1) {
    const opener = rest[delimiterIndex]!;
    if (opener === "（" || opener === "(") {
      // The parenthetical must close on this line. Anything after the close
      // is trailing prose; an unterminated note that was clearly written is
      // refused rather than silently treated as omitted.
      const close = [rest.indexOf("）", delimiterIndex), rest.indexOf(")", delimiterIndex)]
        .reduce<number>((min, i) => (i !== -1 && (min === -1 || i < min) ? i : min), -1);
      if (close === -1) throw malformed(line, "unterminated parenthetical");
      const content = rest.slice(delimiterIndex + 1, close).trim();
      if (content.startsWith("分支")) {
        branch = content.slice("分支".length).trim();
        if (branch.length === 0) throw malformed(line, "empty branch note");
      }
      // Any other parenthetical is an ordinary remark — the branch note was
      // genuinely omitted, and the remark is not a path fragment.
    }
    // A list separator: everything after it is trailing prose.
  }
  return { path: declaredPath, ...(branch !== undefined ? { branch } : {}) };
}

/** Parse the declaration line. Throws on a present-but-malformed line or on
 *  multiple distinct declarations (ambiguous input is refused, not guessed). */
export function parseWorkspaceDeclaration(description: string): DeclarationParse {
  const lines = description.split(/\r?\n/u).filter((line) => line.startsWith(DECLARATION_PREFIX));
  if (lines.length === 0) return { status: "none" };
  const declarations = lines.map((line) => parseDeclarationLine(line));
  const distinct = new Map(declarations.map((d) => [`${d.path}\u0000${d.branch ?? ""}`, d]));
  if (distinct.size > 1) {
    throw new Error(
      `anchored checkout: ambiguous 工作区 declaration (${distinct.size} distinct declarations in the description); refuse to guess`,
    );
  }
  return { status: "declared", ...declarations[0]! };
}

/** Require a readable description and return its declaration parse. */
export function requireDeclaration(description: string | undefined): DeclarationParse {
  if (description === undefined) {
    throw new Error("anchored checkout: task description unavailable; cannot resolve the 工作区 declaration");
  }
  return parseWorkspaceDeclaration(description);
}

/** Git's own minimal repository markers: a HEAD file plus objects/ and refs/. */
async function requireRepositoryLayout(dir: string, label: string): Promise<void> {
  const missing: string[] = [];
  for (const [name, kind] of [["HEAD", "file"] as const, ["objects", "dir"] as const, ["refs", "dir"] as const]) {
    const entry = path.join(dir, name);
    const info = await lstat(entry).catch(() => undefined);
    if (info === undefined || (kind === "file" ? !info.isFile() : !info.isDirectory())) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`anchored checkout: ${label} is not a valid git repository: ${dir} (missing ${missing.join("/")})`);
  }
}

async function readSmallFile(file: string): Promise<string> {
  return await readFile(file, "utf8");
}

/** Read the worktree's current branch from HEAD (no git execution). */
async function worktreeHead(checkoutRoot: string): Promise<string> {
  const dotGit = path.join(checkoutRoot, ".git");
  const info = await lstat(dotGit).catch(() => undefined);
  if (info === undefined) {
    throw new Error(`anchored checkout: 工作区 declaration path is not a git worktree: ${checkoutRoot} (no .git)`);
  }
  let headFile: string;
  if (info.isDirectory()) {
    // Main checkout: .git itself must be a repository.
    await requireRepositoryLayout(dotGit, "main checkout .git");
    headFile = path.join(dotGit, "HEAD");
  } else if (info.isFile()) {
    // `.git` is a "gitdir: <target>" pointer; a relative target resolves
    // against the declared checkout (git's own base), never against the
    // calling process's cwd. The target is either a linked worktree's
    // management dir (carries commondir plus a gitdir back-pointer) or a
    // separate-git-dir main worktree's repository itself (complete layout,
    // no commondir) — `git init --separate-git-dir` produces the latter.
    const pointer = (await readSmallFile(dotGit)).trim();
    const match = /^gitdir:\s*(.+)$/u.exec(pointer);
    if (match === null) {
      throw new Error(`anchored checkout: 工作区 declaration path is not a git worktree: ${checkoutRoot} (unreadable .git pointer)`);
    }
    const gitdir = path.isAbsolute(match[1]!) ? match[1]! : path.resolve(checkoutRoot, match[1]!);
    const gitdirInfo = await lstat(gitdir).catch(() => undefined);
    if (gitdirInfo === undefined || !gitdirInfo.isDirectory()) {
      throw new Error(`anchored checkout: worktree gitdir is missing or invalid: ${gitdir}`);
    }
    const commondirFile = path.join(gitdir, "commondir");
    const commonInfo = await lstat(commondirFile).catch(() => undefined);
    if (commonInfo !== undefined && commonInfo.isFile()) {
      // Linked worktree: a real gitdir carries commondir plus a gitdir
      // back-pointer; a directory with only a HEAD proves nothing.
      const backPointer = await lstat(path.join(gitdir, "gitdir")).catch(() => undefined);
      if (backPointer === undefined || !backPointer.isFile()) {
        throw new Error(`anchored checkout: worktree gitdir is missing required entries (HEAD/commondir/gitdir): ${gitdir}`);
      }
      const common = (await readSmallFile(commondirFile)).trim();
      const commonDir = path.isAbsolute(common) ? common : path.resolve(gitdir, common);
      await requireRepositoryLayout(commonDir, "worktree common dir");
    } else {
      // Separate gitdir: the pointer target IS the whole repository.
      await requireRepositoryLayout(gitdir, "separate gitdir");
    }
    headFile = path.join(gitdir, "HEAD");
  } else {
    throw new Error(`anchored checkout: 工作区 declaration path is not a git worktree: ${checkoutRoot} (.git is not a file or directory)`);
  }
  let head: string;
  try {
    head = (await readSmallFile(headFile)).trim();
  } catch {
    throw new Error(`anchored checkout: cannot read worktree HEAD: ${headFile}`);
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/u.exec(head);
  return ref !== null ? ref[1]! : "(detached)";
}

/** Validate one declaration: path exists, is a git worktree, branch matches.
 *  Returns the normalized absolute landing point on success. */
export async function validateWorkspaceAnchor(declaration: WorkspaceDeclaration): Promise<string> {
  const checkoutRoot = path.resolve(declaration.path);
  const info = await stat(checkoutRoot).catch(() => undefined);
  if (info === undefined) {
    throw new Error(`anchored checkout: 工作区 declaration path does not exist: ${declaration.path}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`anchored checkout: 工作区 declaration path is not a directory: ${declaration.path}`);
  }
  const actualBranch = await worktreeHead(checkoutRoot);
  if (declaration.branch !== undefined && actualBranch !== declaration.branch) {
    throw new Error(`anchored checkout: branch mismatch: declared ${declaration.branch}, actual ${actualBranch}`);
  }
  return checkoutRoot;
}

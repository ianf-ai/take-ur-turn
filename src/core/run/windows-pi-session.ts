/** Pi 1.4.0 Windows session locations; no process control or Hub dependency. */
import { closeSync, fstatSync, openSync, readSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WindowsPiSessionLocation {
  storage_layout: 'flat' | 'cwd-encoded';
  session_directory: string;
  source: 'cli' | 'environment' | 'default';
  launch_cwd: string;
}
export interface WindowsPiSession extends WindowsPiSessionLocation {
  session_id: string;
  session_file?: string;
  header_cwd?: string;
}

const VALUE_OPTIONS = new Set(['--provider','--model','--api-key','--system-prompt','--append-system-prompt','--name','-n','--models','--tools','-t','--exclude-tools','-xt','--thinking','--extension','-e','--skill','--prompt-template','--theme','--use-theme','--tui-mode','--mode']);

/** Remove only the storage option; the native argv builder still owns every
 *  session selector and positional refusal. Option values stay literal. */
export function windowsPiRouteArgs(args: readonly string[]): { args: string[]; directory?: string } {
  const rest: string[] = [];
  let directory: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--session-dir' || token.startsWith('--session-dir=')) {
      if (directory !== undefined) throw new Error('duplicate pi --session-dir');
      directory = token === '--session-dir' ? args[++i] : token.slice('--session-dir='.length);
      if (!directory || directory.includes('\0')) throw new Error('pi --session-dir requires a nonempty path');
    } else {
      rest.push(token);
      if (VALUE_OPTIONS.has(token) && args[i + 1] !== undefined) rest.push(args[++i]!);
    }
  }
  return { args: rest, ...(directory !== undefined ? { directory } : {}) };
}

/** Pi 1.4.0's Windows shell-drive normalization precedes tilde expansion
 *  and resolution. Do not fold junctions or reinterpret unsupported URLs. */
export function resolveWindowsPiPath(value: string, cwd: string, home: string): string {
  // Pi also accepts file URLs. Until this leaf can prove the same Windows
  // URL decoding on every supported Node version, require a native path
  // rather than turning file:///D:/... into <cwd>\\file:\\D:\\... .
  if (/^file:/iu.test(value)) throw new Error('unsupported Windows pi file URL; use an explicit native Windows path');
  let normalized = value;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu.exec(value);
    if (drive) normalized = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll('/', '\\') ?? ''}`;
  }
  const expanded = normalized === '~' ? home : /^~[\\/]/u.test(normalized) ? path.win32.join(home, normalized.slice(2)) : normalized;
  if (expanded.includes('\0') || /^[a-z]:(?:$|[^\\/])/iu.test(expanded)) throw new Error(`ambiguous Windows pi path: ${value}`);
  return path.win32.resolve(cwd, expanded);
}
export function windowsPiEncodedCwd(cwd: string): string {
  if (!path.win32.isAbsolute(cwd)) throw new Error('Windows pi cwd must be absolute');
  return `--${path.win32.resolve(cwd).replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
}

export function windowsPiSessionLocation(cwd: string, env: NodeJS.ProcessEnv, directory?: string, options: {
  home?: string; readSettings?: (file: string) => string | undefined;
} = {}): WindowsPiSessionLocation {
  const home = options.home ?? os.homedir();
  const launch_cwd = path.win32.resolve(cwd);
  if (!path.win32.isAbsolute(cwd)) throw new Error('Windows pi cwd must be absolute');
  const custom = directory || env.PI_CODING_AGENT_SESSION_DIR;
  if (custom) return { storage_layout: 'flat', session_directory: resolveWindowsPiPath(custom, launch_cwd, home), source: directory ? 'cli' : 'environment', launch_cwd };
  const agentDir = env.PI_CODING_AGENT_DIR ? resolveWindowsPiPath(env.PI_CODING_AGENT_DIR, launch_cwd, home) : path.win32.join(home, '.pi', 'agent');
  const readSettings = options.readSettings ?? ((file: string) => {
    try { return readFileSync(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  });
  // A settings value is not necessarily effective: Pi owns project trust and
  // merge policy. Refuse ambiguity instead of silently selecting another dir.
  for (const file of [path.win32.join(agentDir, 'settings.json'), path.win32.join(launch_cwd, '.pi', 'settings.json')]) {
    const raw = readSettings(file);
    if (raw === undefined) continue;
    const settings = JSON.parse(raw) as { sessionDir?: unknown };
    if (settings.sessionDir) throw new Error(`pi settings sessionDir requires explicit --session-dir or PI_CODING_AGENT_SESSION_DIR to freeze the effective directory (${file})`);
  }
  return { storage_layout: 'cwd-encoded', session_directory: path.win32.join(agentDir, 'sessions', windowsPiEncodedCwd(launch_cwd)), source: 'default', launch_cwd };
}

/** Exact first-line identity check. No search outside the frozen directory,
 *  no session bodies, and no fallback to --continue or a newly created ID. */
export function verifyWindowsPiSession(location: WindowsPiSessionLocation, id: string, io: {
  entries?: (directory: string) => string[];
  header?: (file: string) => { id?: unknown; cwd?: unknown; type?: unknown } | undefined;
} = {}): WindowsPiSession {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) throw new Error('invalid pi session ID');
  const entries = (io.entries ?? readdirSync)(location.session_directory);
  const header = io.header ?? ((file: string) => {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      if (!fstatSync(fd).isFile()) return undefined;
      const bytes = Buffer.alloc(8192);
      const n = readSync(fd, bytes, 0, bytes.length, 0);
      const end = bytes.subarray(0, n).indexOf(10);
      if (end < 0) return undefined;
      return JSON.parse(bytes.subarray(0, end).toString('utf8')) as { id?: unknown; cwd?: unknown; type?: unknown };
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  });
  const matches: WindowsPiSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') || path.win32.basename(entry) !== entry) continue;
    const file = path.win32.join(location.session_directory, entry);
    const head = header(file);
    if (head?.type !== 'session' || head.id !== id) continue;
    if (typeof head.cwd !== 'string' || !path.win32.isAbsolute(head.cwd) || path.win32.resolve(head.cwd) !== location.launch_cwd) throw new Error(`pi session ${id} cwd missing or different; refusing ambiguous project identity`);
    matches.push({ ...location, session_id: id, session_file: file, header_cwd: head.cwd });
  }
  if (matches.length !== 1) throw new Error(`pi session ${id}: expected one exact file in ${location.session_directory}, found ${matches.length}; refusing fresh-session fallback`);
  return matches[0]!;
}

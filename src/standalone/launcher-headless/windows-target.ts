/** Detached Windows targets. Logical routes never become shell commands. */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveWindowsExecutableTarget } from '../../core/launcher/target/windows.js';
import { UnsupportedWindowsShimError, type ResolvedAgentTarget, type WindowsTargetDeps } from '../../core/launcher/target/types.js';
import { withFsProbeBudget, probeTimeoutMs } from '../../core/launcher/target/probe.js';

export interface DetachedWindowsTarget extends ResolvedAgentTarget {
  agent: 'pi' | 'codex';
  version?: string;
}
export interface DetachedWindowsTargetDeps extends WindowsTargetDeps {
  readText?: (file: string) => Promise<string>;
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_ENTRIES = ['dist/cli.js', 'dist/bundle/cli.js'];

/** Only the standard npm cmd-shim for the verified Pi package is translated.
 *  It is compared as data, never evaluated; additional commands are refused. */
export function npmPiShim(entry: string): string {
  return `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${entry}" %*
`;
}

export async function resolveDetachedWindowsTarget(agent: string, env: NodeJS.ProcessEnv, deps: DetachedWindowsTargetDeps = {}): Promise<DetachedWindowsTarget> {
  const name = path.win32.basename(agent).toLowerCase();
  const isPi = name === 'pi' || name === 'pi.cmd' || name === 'cli.js';
  const isCodex = name === 'codex' || name === 'codex.exe';
  if (!isPi && !isCodex) throw new Error(`unsupported-headless-agent: ${agent}; Windows detached supports pi 1.4.0 and native codex`);
  // Environment keys are case-insensitive on Windows (Node may supply Path).
  const environment = { ...env, PATH: env.PATH ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '',
    PATHEXT: env.PATHEXT ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATHEXT')?.[1] };
  const read = (file: string) => withFsProbeBudget(() => (deps.readText ?? (f => readFile(f, 'utf8')))(file), probeTimeoutMs(environment));
  const fileStat = deps.stat ?? ((file: string) => stat(file));
  const regular = async (file: string) => {
    if (!(await withFsProbeBudget(signal => fileStat(file, signal), probeTimeoutMs(environment))).isFile()) throw new Error(`not a regular Windows target: ${file}`);
  };
  const explicit = path.win32.isAbsolute(agent);
  if (!explicit && /[\\/]/u.test(agent)) throw new Error('Windows detached agent paths must be absolute');
  let target: ResolvedAgentTarget;
  try {
    target = await resolveWindowsExecutableTarget(agent, { ...deps, environment,
      ...(explicit ? { candidates: async () => [agent] } : {}) });
  } catch (error) {
    if (!(error instanceof UnsupportedWindowsShimError) || !isPi || path.win32.basename(error.shimPath).toLowerCase() !== 'pi.cmd') throw error;
    const shim = (await read(error.shimPath)).replace(/\r\n/gu, '\n');
    const entries = ['node_modules', '..'].flatMap(root => PI_ENTRIES.map(entry =>
      `${root}\\${PI_PACKAGE.replace('/', '\\')}\\${entry.replaceAll('/', '\\')}`));
    const relative = entries.find(entry => {
      const legacy = npmPiShim(entry);
      const current = legacy.replace('  SET PATHEXT=%PATHEXT:;.JS;=;%\n', '')
        .replace('& "%_prog%" ', '& set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  ');
      // Older cmd-shim releases interpolate an empty shebang-args slot,
      // producing two spaces before the script instead of one.
      const legacyEmptyArgs = legacy.replace('& "%_prog%" ', '& "%_prog%"  ');
      return shim === legacy || shim === legacyEmptyArgs || shim === current;
    });
    if (!relative) throw new Error(`unsupported Windows pi wrapper: ${error.shimPath}; expected the unmodified npm pi.cmd shim`);
    const script = path.win32.resolve(path.win32.dirname(error.shimPath), relative);
    target = { kind: 'node-entry', executable: deps.nodeExecutable ?? process.execPath, prefix_args: [script], source_path: script };
  }
  if (isCodex) {
    if (target.kind !== 'native') throw new Error('Windows detached codex requires a native executable');
    return { ...target, agent: 'codex' };
  }
  const script = target.prefix_args[0];
  const entry = script && PI_ENTRIES.find(relative => script.toLowerCase().endsWith(`\\${relative.replaceAll('/', '\\')}`));
  if (target.kind !== 'node-entry' || !script || !entry) {
    throw new Error('Windows detached pi requires a verified package CLI JS entry');
  }
  const packageRoot = script.slice(0, -entry.length - 1);
  const manifest = JSON.parse(await read(path.win32.join(packageRoot, 'package.json'))) as { name?: unknown; version?: unknown; bin?: { pi?: unknown } };
  if (manifest.name !== PI_PACKAGE || manifest.version !== '1.4.0' || typeof manifest.bin?.pi !== 'string' || !PI_ENTRIES.includes(manifest.bin.pi)) {
    throw new Error('unsupported Windows pi package: expected @earendil-works/pi-coding-agent 1.4.0 with a known CLI JS bin');
  }
  if (!path.win32.isAbsolute(target.executable) || path.win32.basename(target.executable).toLowerCase() !== 'node.exe') throw new Error('Windows pi requires an absolute node.exe executable');
  await regular(script);
  await regular(target.executable);
  return { ...target, agent: 'pi', version: '1.4.0' };
}

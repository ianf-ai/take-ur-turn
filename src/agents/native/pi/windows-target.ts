import path from 'node:path';
import type {WindowsTargetServices,PhysicalTarget,LegacyWindowsTarget} from '../../windows-target-contract.js';
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

export const isPiWindowsName=(name:string)=>name==='pi'||name==='pi.cmd'||name==='cli.js';
export async function recoverPiShim(shimPath:string,io:WindowsTargetServices):Promise<PhysicalTarget> {
 const read=io.readText;
    const shim = (await read(shimPath)).replace(/\r\n/gu, '\n');
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
    if (!relative) throw new Error(`unsupported Windows pi wrapper: ${shimPath}; expected the unmodified npm pi.cmd shim`);
    const script = path.win32.resolve(path.win32.dirname(shimPath), relative);
    return { kind: 'node-entry', executable: io.nodeExecutable, prefix_args: [script], source_path: script };
}
export async function verifyPiTarget(target:PhysicalTarget,io:WindowsTargetServices):Promise<LegacyWindowsTarget> {
 const read=io.readText,regular=io.regular;
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

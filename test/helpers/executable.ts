import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HeadlessOwnership } from '../../src/core/run/store.js';
import type { WindowsOwnership } from '../../src/standalone/launcher-headless/windows-plan.js';
import { resolveDetachedWindowsTarget } from '../../src/standalone/launcher-headless/windows-target.js';

/** Use the real host, even in tests which override process.platform. */
export function fixtureExecutable(file: string): string {
  return path.sep === '\\' ? `${file}.exe` : file;
}

/** A shell:false fixture with the same Node body on both real hosts. */
export function writeNodeExecutable(file: string, source: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  if (path.sep !== '\\') {
    writeFileSync(file, '#!/usr/bin/env node\n' + source);
    chmodSync(file, 0o755);
    return file;
  }
  copyFileSync(path.resolve(import.meta.dirname, '../bin/herdr.exe'), file + '.exe');
  // A failed owning supervisor must not leave a neutral fixture alive forever.
  writeFileSync(file + '.cjs', source + '\n;setTimeout(()=>process.exit(124),180000).unref();\n');
  writeFileSync(path.join(path.dirname(file), '.node-path'), process.execPath);
  return (file + '.exe').replaceAll('\\', '/');
}

/** Verified, local Pi package layout for Windows planner fixtures. No model code. */
export function writePiPackageFixture(bin: string, source = ''): string {
  if (path.sep !== '\\') return writeNodeExecutable(path.join(bin, 'pi'), source);
  const packageRoot = path.join(bin, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0', bin: { pi: 'dist/cli.js' } }));
  writeFileSync(path.join(packageRoot, 'dist/cli.js'), source);
  writeFileSync(path.join(bin, 'pi.cmd'), npmPiShim('node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js'));
  return path.join(bin, 'pi.cmd').replaceAll('\\', '/');
}
import { npmPiShim } from '../../src/standalone/launcher-headless/windows-target.js';

/** Produce the same frozen Windows envelope as the planner, without starting
 * any model. POSIX fixtures keep their existing producer shape unchanged. */
export async function fixtureHeadlessOwnership(headless: HeadlessOwnership, argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<WindowsOwnership> {
  if (path.sep !== '\\' || 'windows' in headless) return headless;
  const target = await resolveDetachedWindowsTarget(argv[0]!, env);
  return { ...headless, windows: { schema: 1, target, logical_argv: [target.agent, ...argv.slice(1)] } };
}

import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  if (process.platform !== 'win32') return;
  const testRoot = fileURLToPath(new URL('.', import.meta.url));
  const bin = path.join(testRoot, 'bin');
  // Windows PowerShell's .NET Framework ships this compiler. No npm package
  // or downloaded binary is needed; source and argv quoting are inspectable.
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', `/out:${path.join(bin, 'herdr.exe')}`, path.join(testRoot, 'fixtures', 'cli-forwarder.cs')]);
  writeFileSync(path.join(bin, '.node-path'), process.execPath);
  for (const name of ['pi', 'codex', 'l1-agent', 'l2-agent']) copyFileSync(path.join(bin, 'herdr.exe'), path.join(bin, `${name}.exe`));
}

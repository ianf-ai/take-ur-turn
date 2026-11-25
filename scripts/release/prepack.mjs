import { rmSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { packageRoot as root, inputs, toolchain, outputs, smokeTar } from './package-integrity.mjs';

const npm = (args, options = {}) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: 'inherit', ...options });
const before = inputs(root), tools = toolchain(root);
// tsc alone leaves retired or obsolete modules in place.
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
npm(['run', 'build']);
if (JSON.stringify(before) !== JSON.stringify(inputs(root)) || JSON.stringify(tools) !== JSON.stringify(toolchain(root))) throw Error('integrity: inputs changed during build');
writeFileSync(path.join(root, 'dist/build-integrity.json'), JSON.stringify({ schema: 1, packager_sha256: createHash('sha256').update(readFileSync(process.env.npm_execpath)).digest('hex'), inputs: before, toolchain: tools, outputs: outputs(root) }, null, 2) + '\n');
execFileSync(process.execPath, ['scripts/release/assert-release.js'], { cwd: root, stdio: 'inherit' });
// Also cover npm publish and --dry-run, whose lifecycle may not leave a tar
// on disk. --ignore-scripts prevents recursive lifecycle execution.
const temp = mkdtempSync(path.join(os.tmpdir(), 'tut-prepack-'));
try {
  const result = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp, '--dry-run=false'], { encoding: 'utf8', stdio: 'pipe' }));
  const packed = (Array.isArray(result) ? result : Object.values(result))[0];
  if (!packed?.filename) throw Error('integrity: npm pack returned no tarball');
  const digest = smokeTar(root, path.join(temp, packed.filename));
  console.log(`prepack: clean build and packed watcher --help verified; candidate sha256:${digest}`);
} finally { rmSync(temp, { recursive: true, force: true }); }

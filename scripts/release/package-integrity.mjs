import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, mkdtempSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function tree(root, relative, result) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) tree(root, file, result);
    else if (entry.isFile()) result[file] = hash(readFileSync(path.join(root, file)));
    else throw Error(`integrity: nonregular input ${file}`);
  }
}
export function inputs(root) {
  const result = {};
  for (const dir of ['src', 'skills', 'scripts']) tree(root, dir, result);
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) result[file] = hash(readFileSync(path.join(root, file)));
  return result;
}
export function toolchain(root) {
  const compiler = {};
  tree(root, 'node_modules/typescript/lib', compiler);
  tree(root, 'node_modules/@types/node', compiler);
  return { node: process.version, node_sha256: hash(readFileSync(process.execPath)),
    typescript: JSON.parse(readFileSync(path.join(root, 'node_modules/typescript/package.json'))).version,
    compiler_sha256: hash(JSON.stringify(compiler)) };
}
export function outputs(root) {
  const result = {};
  tree(root, 'dist', result);
  delete result['dist/build-integrity.json'];
  return result;
}
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function verifyBuild(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'dist/build-integrity.json'), 'utf8'));
  if (manifest.schema !== 1 || !equal(manifest.inputs, inputs(root)) || !equal(manifest.toolchain, toolchain(root)) || !equal(manifest.outputs, outputs(root))) {
    throw Error('integrity: source/toolchain/dist content differs from the clean build');
  }
  return manifest;
}
export function smokeTar(root, tar) {
  const expected = verifyBuild(root), temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tut-package-smoke-')));
  try {
    execFileSync('tar', ['-xzf', tar, '-C', temp], { stdio: 'pipe' });
    const unpacked = path.join(temp, 'package');
    const actual = JSON.parse(readFileSync(path.join(unpacked, 'dist/build-integrity.json'), 'utf8'));
    if (!equal(actual, expected) || !equal(outputs(unpacked), expected.outputs)) throw Error('integrity: tar dist differs from the clean build');
    for (const [file, digest] of Object.entries(expected.inputs)) {
      if ((file === 'package.json' || /^(scripts\/usage-audit\/|skills\/)/u.test(file)) && (!existsSync(path.join(unpacked, file)) || hash(readFileSync(path.join(unpacked, file))) !== digest)) {
        throw Error(`integrity: tar runtime input differs: ${file}`);
      }
    }
    symlinkSync(path.join(root, 'node_modules'), path.join(unpacked, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    // Static imports link the entire watcher graph before its CLI branch runs.
    const help = execFileSync(process.execPath, [path.join(unpacked, 'scripts/usage-audit/run.mjs'), '--help'], { encoding: 'utf8', timeout: 15_000 });
    if (!help.includes('usage-audit --watch | --since ISO8601 | --backfill | --recover') || !help.includes('--root PROJECT_ROOT')) throw Error('integrity: watcher --help did not actually render');
    return hash(readFileSync(tar));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

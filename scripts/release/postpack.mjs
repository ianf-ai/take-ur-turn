import path from 'node:path';
import { readFileSync } from 'node:fs';
import { packageRoot as root, verifyBuild, smokeTar } from './package-integrity.mjs';

verifyBuild(root);
if (process.env.npm_command === 'pack' && process.env.npm_config_dry_run !== 'true') {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const filename = `${pkg.name.replace(/^@/u, '').replaceAll('/', '-')}-${pkg.version}.tgz`;
  const tar = path.resolve(process.env.INIT_CWD ?? root, process.env.npm_config_pack_destination ?? '.', filename);
  console.log(`postpack: final tar watcher --help verified; sha256:${smokeTar(root, tar)}`);
}

#!/usr/bin/env node
/** Stable public entry for the core CLI dispatcher. */
import { main } from './core/cli.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export * from './core/cli.js';

// Direct-invocation guard (`node dist/cli.js ...`, or the `tut` bin symlink
// created by `npm link`); imports for tests do not run main. Both sides go
// through realpath: the bin symlink must also fire main, and Node's ESM
// loader may or may not realpath import.meta.url depending on
// --preserve-symlinks — comparing realpaths covers every combination.
const scriptPath = process.argv[1];
function invokedAsScript(): boolean {
  if (scriptPath === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(scriptPath);
  } catch {
    return false;
  }
}
if (invokedAsScript()) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`tut: ${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}

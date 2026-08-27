#!/usr/bin/env node
// Hard gate before `npm pack` / `npm publish`: refuse to ship without a real
// build. Guards against the 0.5.0 incident (published from an unbuilt
// worktree — 18-file tarball with no dist/).
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");

if (!existsSync(cli)) {
  console.error(`assert-release: dist/cli.js is missing — run \`npm run build\` first`);
  process.exit(1);
}
const size = statSync(cli).size;
if (size < 10_000) {
  console.error(
    `assert-release: dist/cli.js is suspiciously small (${size} bytes) — the build likely did not complete. Run \`npm run build\` and retry.`,
  );
  process.exit(1);
}
console.log(`assert-release: ok (${size} bytes)`);

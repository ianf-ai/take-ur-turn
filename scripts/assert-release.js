#!/usr/bin/env node
// Hard gate before `npm pack` / `npm publish`: refuse to ship without a real,
// complete build. Guards against the 0.5.0 incident (published from an unbuilt
// worktree — 18-file tarball with no dist/) and against partial tarballs.
//
// Every entry below is a runtime contract artifact, not a build extra: missing
// ones do NOT fail at install time — they fail later, at every use. The
// launcher runners are rendered into pane commands by absolute path
// (src/launcher/shell-renderer.ts defaultPaneRuntime), so a missing runner
// flash-crashes each agent pane at birth; skills role files are rendered into
// kickoff prompts by absolute path (src/launcher/compat.ts promptFor) and read
// by the notifier (src/notifier.ts), so a missing file launches agents without
// their role skill. That is the same packaging-risk class as 0.5.0, so the
// gate enumerates all of them explicitly.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// dist/cli.js keeps the 10KB heuristic from the 0.5.0 incident; the runners
// only need to exist, be regular files (symlinks to regular files count —
// statSync follows them; a directory passes neither test), and be non-empty.
const RUNTIME_ENTRIES = [
  {
    rel: path.join("dist", "cli.js"),
    why: "bin entry (package.json bin)",
    minBytes: 10_000,
  },
  {
    rel: path.join("dist", "launcher", "pane-runner.js"),
    why: "rendered into pane commands by absolute path (src/launcher/shell-renderer.ts defaultPaneRuntime) — missing means every pane birth flash-crashes",
    minBytes: 1,
  },
  {
    rel: path.join("dist", "launcher", "probe-runner.js"),
    why: "agent-birth probe entry, rendered into pane commands by absolute path (src/launcher/shell-renderer.ts defaultPaneRuntime)",
    minBytes: 1,
  },
  ...["architect", "executor", "reviewer", "host"].map((role) => ({
    rel: path.join("skills", `${role}.md`),
    why: `role skill rendered into ${role} kickoff prompts by absolute path (src/launcher/compat.ts promptFor)`,
    minBytes: 1,
  })),
];

let failed = false;
for (const { rel, why, minBytes } of RUNTIME_ENTRIES) {
  const file = path.join(root, rel);
  if (!existsSync(file)) {
    console.error(`assert-release: ${rel} is missing (${why}). Run \`npm run build\` first and check the package.json "files" list.`);
    failed = true;
    continue;
  }
  const st = statSync(file); // follows symlinks: a link to a regular file counts
  if (!st.isFile()) {
    console.error(`assert-release: ${rel} is not a regular file (${why}). Check the package.json "files" list.`);
    failed = true;
    continue;
  }
  const size = st.size;
  if (size < minBytes) {
    console.error(
      `assert-release: ${rel} is suspiciously small (${size} bytes, expected >= ${minBytes}) — the build likely did not complete. Run \`npm run build\` and retry.`,
    );
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`assert-release: ok (${RUNTIME_ENTRIES.length} runtime entries present and non-empty)`);

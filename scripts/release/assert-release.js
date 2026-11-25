#!/usr/bin/env node
// Hard gate before `npm pack` / `npm publish`: refuse to ship without a real,
// complete build. Guards against the 0.5.0 incident (published from an unbuilt
// worktree — 18-file tarball with no dist/) and against partial tarballs.
//
// Every entry below is a runtime contract artifact, not a build extra: missing
// ones do NOT fail at install time — they fail later, at every use. The
// launcher runners are rendered into pane commands by absolute path
// (src/herdr/launcher/shell-renderer.ts defaultPaneRuntime), so a missing runner
// flash-crashes each agent pane at birth; skills role files are rendered into
// kickoff prompts by absolute path (src/herdr/launcher/compat.ts promptFor) and read
// by the notifier (src/core/notifier/notifier.ts), so a missing file launches agents without
// their role skill. That is the same packaging-risk class as 0.5.0, so the
// gate enumerates all of them explicitly.
import { existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The public bin and legacy core entry forward to the app dispatcher.
// All must exist and be substantial enough to catch empty/truncated builds.
// The runners still only
// need to exist, be regular files (symlinks to regular files count —
// statSync follows them; a directory passes neither test), and be non-empty.
const RUNTIME_ENTRIES = [
  {rel:path.join("skills","agent-onboarding.md"),why:"schema-rendered declaration authoring instructions",minBytes:1},
  ...['basic.js','public/usage.js','public/probe.js','public/diagnostics.js','public/index.js','public/transition.js','public/configuration.js','public/declarations.js','public/native-compat.js','profiles/catalog.json','binding.schema.json','profile.schema.json',...['codex','pi','opencode'].map(id=>`native/${id}/profile.json`)].map(file=>({rel:path.join('dist','agents',file),why:'agents public contract and native runtime assets',minBytes:1})),
  {rel:path.join('dist','app','agents.js'),why:'profile and native read-port composition',minBytes:1},
  ...["broker.ps1", "native.cs"].map(name => ({
    rel: path.join("scripts", "windows-run", name),
    why: "Windows run broker loads this fixed native helper from the installed package",
    minBytes: 1,
  })),
  {
    rel: path.join("dist", "cli.js"),
    why: "bin entry (package.json bin)",
    minBytes: 200,
  },
  {
    rel: path.join("dist", "herdr", "launcher", "pane-runner.js"),
    why: "rendered into pane commands by absolute path (src/herdr/launcher/shell-renderer.ts defaultPaneRuntime) — missing means every pane birth flash-crashes",
    minBytes: 1,
  },
  {
    rel: path.join("dist", "core", "cli.js"),
    why: "legacy executable CLI entry",
    minBytes: 200,
  },
  {
    rel: path.join("dist", "app", "cli.js"),
    why: "application CLI dispatcher loaded by the public and legacy entries",
    minBytes: 2_000,
  },
  ...["architect", "executor", "reviewer", "host"].map((role) => ({
    rel: path.join("skills", `${role}.md`),
    why: `role skill rendered into ${role} kickoff prompts by absolute path (src/herdr/launcher/compat.ts promptFor)`,
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
// Retirement regression gate: tsc does not remove stale build products.
for (const dir of ["dist/launcher", "dist/herdr/launcher"]) {
  for (const name of existsSync(path.join(root, dir)) ? readdirSync(path.join(root, dir)) : []) {
    if (/^probe-(runner|channel)\.(?:js|d\.ts|map|js\.map|d\.ts\.map)$/.test(name)) {
      console.error(`assert-release: retired artifact ${dir}/${name} must not enter the package; remove stale build products and rebuild.`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);

for(const dir of ['dist/core/agents']) {
 for(const name of existsSync(path.join(root,dir))?readdirSync(path.join(root,dir)):[]) {
  if(!/^(?:setup-store|profile-source|native-reads)\.(?:js|d\.ts|js\.map)$/.test(name)) {
   console.error(`assert-release: retired artifact ${dir}/${name} must not enter the package`);process.exitCode=1;
  }
 }
}
for(const name of ['codex-argv','opencode-argv'])for(const extension of ['js','d.ts','js.map']) {
 const file=`dist/standalone/launcher-detached/${name}.${extension}`;
 if(existsSync(path.join(root,file))){console.error(`assert-release: retired artifact ${file} must not enter the package`);process.exitCode=1;}
}


for(const extension of ['js','d.ts','js.map']) {
 const file=`dist/core/run/windows-pi-session.${extension}`;
 if(existsSync(path.join(root,file))){console.error(`assert-release: retired artifact ${file} must not enter the package`);process.exitCode=1;}
}

if(!process.exitCode)console.log(`assert-release: ok (${RUNTIME_ENTRIES.length} runtime entries present and non-empty)`);

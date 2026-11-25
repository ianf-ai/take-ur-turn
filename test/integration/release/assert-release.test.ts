import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const GATE_SCRIPT = fileURLToPath(new URL("../../../scripts/release/assert-release.js", import.meta.url));

/**
 * The gate resolves the package root from its own location, so each case gets
 * a fresh fake root: the gate script is copied into <root>/scripts/release/ and the
 * dist/skills files under test are materialized around it.
 */
async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tut-assert-release-"));
  await mkdir(path.join(root, "scripts", "release"), { recursive: true });
  await copyFile(GATE_SCRIPT, path.join(root, "scripts", "release", "assert-release.js"));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

/** Complete, healthy fixture — individual cases delete/shrink one entry. */
const HEALTHY_FILES: Record<string, string> = {
  "scripts/windows-run/broker.ps1": "# broker\n",
  "scripts/windows-run/native.cs": "// native helper\n",
  ...Object.fromEntries(['basic.js','public/usage.js','public/probe.js','public/diagnostics.js','public/index.js','public/transition.js','public/configuration.js','public/declarations.js','public/native-compat.js','profiles/catalog.json','binding.schema.json','profile.schema.json',...['codex','pi','opencode'].map(id=>`native/${id}/profile.json`)].map(file=>[`dist/agents/${file}`,'export {};\n'])),
  'dist/app/agents.js':'export {};\n',
  'skills/agent-onboarding.md':'declaration authoring instructions\n',
  "dist/core/cli.js": `export {};\n${"x".repeat(201)}`,
  "dist/app/cli.js": `export {};\n${"x".repeat(2_001)}`,
  "dist/cli.js": `#!/usr/bin/env node\n${"x".repeat(10_001)}`,
  "dist/herdr/launcher/pane-runner.js": "export {};\n",
  "skills/architect.md": "# architect\n",
  "skills/executor.md": "# executor\n",
  "skills/reviewer.md": "# reviewer\n",
  "skills/host.md": "# host\n",
};

async function runGate(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(root, "scripts", "release", "assert-release.js")], {
      cwd: root,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const roots: string[] = [];
function freshRoot(files: Record<string, string>): Promise<string> {
  return makeRoot(files).then((root) => {
    roots.push(root);
    return root;
  });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("scripts/release/assert-release.js release gate", () => {
  it.each(['broker.ps1', 'native.cs'])('requires the installed Windows helper %s', async name => {
    const files = { ...HEALTHY_FILES };
    delete files[`scripts/windows-run/${name}`];
    const result = await runGate(await freshRoot(files));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(name);
  });
  it("requires the basic compiler runtime module", async()=>{
    const files={...HEALTHY_FILES};delete files['dist/agents/basic.js'];
    const result=await runGate(await freshRoot(files));
    expect(result.code).toBe(1);expect(result.stderr).toContain(path.join('dist','agents','basic.js'));
  });
  it("passes when every runtime entry exists and is non-empty", async () => {
    const root = await freshRoot(HEALTHY_FILES);
    const result = await runGate(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("assert-release: ok");
  });

  it("fails when dist/cli.js is missing (the 0.5.0 incident shape)", async () => {
    const files = { ...HEALTHY_FILES };
    delete files["dist/cli.js"];
    const root = await freshRoot(files);
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(path.join("dist", "cli.js"));
  });

  it.each(["core", "app"].flatMap(dir => ["", "truncated"].map(content => [dir, content])))("rejects a missing/undersized %s CLI entry (%s)", async (dir, content) => {
    const files = { ...HEALTHY_FILES };
    if (content) files[`dist/${dir}/cli.js`] = content;
    else delete files[`dist/${dir}/cli.js`];
    const result = await runGate(await freshRoot(files));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(path.join('dist', dir!, 'cli.js'));
  });

  it("fails when dist/herdr/launcher/pane-runner.js is missing (absolute-path pane contract)", async () => {
    const files = { ...HEALTHY_FILES };
    delete files["dist/herdr/launcher/pane-runner.js"];
    const root = await freshRoot(files);
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pane-runner.js");
  });

  // Deletion regression: every emitted artifact must be rejected in dirty dist.
  it.each(["probe-runner", "probe-channel"].flatMap(name =>
    ["js", "d.ts", "map", "js.map", "d.ts.map"].map(ext => `${name}.${ext}`)))
  ("rejects retired artifact %s", async name => {
    const root = await freshRoot({ ...HEALTHY_FILES, [`dist/launcher/${name}`]: "stale" });
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`retired artifact dist/launcher/${name}`);
  });

  it('rejects a retired probe in the new herdr zone too', async () => {
    const root = await freshRoot({ ...HEALTHY_FILES, 'dist/herdr/launcher/probe-runner.js': 'stale' });
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('retired artifact dist/herdr/launcher/probe-runner.js');
  });

  it("fails when a skills role file is missing (kickoff prompt contract)", async () => {
    const files = { ...HEALTHY_FILES };
    delete files["skills/executor.md"];
    const root = await freshRoot(files);
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(path.join("skills", "executor.md"));
  });

  it("fails when a runner exists but is empty (non-empty assertion)", async () => {
    const root = await freshRoot({ ...HEALTHY_FILES, "dist/herdr/launcher/pane-runner.js": "" });
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pane-runner.js");
    expect(result.stderr).toContain("suspiciously small");
  });

  it("fails when a runner path is a directory (its nonzero size would pass a bare non-empty check)", async () => {
    const root = await freshRoot(HEALTHY_FILES);
    const runner = path.join(root, "dist", "herdr", "launcher", "pane-runner.js");
    await rm(runner);
    await mkdir(runner);
    await writeFile(path.join(runner, "placeholder.js"), "export {};\n"); // non-empty directory content
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pane-runner.js");
    expect(result.stderr).toContain("not a regular file");
  });

  it("accepts a symlink pointing at a regular file (statSync follows links)", async () => {
    const root = await freshRoot(HEALTHY_FILES);
    const launcher = path.join(root, "dist", "herdr", "launcher");
    await copyFile(path.join(launcher, "pane-runner.js"), path.join(launcher, "pane-runner.real.js"));
    await rm(path.join(launcher, "pane-runner.js"));
    await symlink(path.join(launcher, "pane-runner.real.js"), path.join(launcher, "pane-runner.js"));
    const result = await runGate(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("assert-release: ok");
  });

  it("fails when dist/cli.js is present but undersized (the original 10KB heuristic)", async () => {
    const root = await freshRoot({ ...HEALTHY_FILES, "dist/cli.js": "#!/usr/bin/env node\nsmall" });
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(path.join("dist", "cli.js"));
    expect(result.stderr).toContain("suspiciously small");
  });

  it("names every missing entry in one run instead of stopping at the first", async () => {
    const files = { ...HEALTHY_FILES };
    delete files["dist/herdr/launcher/pane-runner.js"];
    delete files["skills/host.md"];
    const root = await freshRoot(files);
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pane-runner.js");
    expect(result.stderr).toContain(path.join("skills", "host.md"));
  });
});


it('prepack replaces stale dist, fingerprints content, and smokes the final tar including its actual help', async () => {
  const repository=fileURLToPath(new URL('../../../',import.meta.url));
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'tut-pack-integrity-')));roots.push(root);
  for(const dir of ['src','skills','scripts'])await cp(path.join(repository,dir),path.join(root,dir),{recursive:true});
  for(const file of ['package.json','package-lock.json','tsconfig.json','README.md','LICENSE'])await copyFile(path.join(repository,file),path.join(root,file));
  await symlink(await realpath(path.join(repository,'node_modules')),path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
  await mkdir(path.join(root,'dist/agents/public'),{recursive:true});
  await writeFile(path.join(root,'dist/agents/public/usage.js'),'export {}; // old dist without readUsage');
  await writeFile(path.join(root,'dist/retired.js'),'stale build residue');
  const cache=path.join(root,'npm-cache'),destination=path.join(root,'packed');await mkdir(destination);
  const env={...process.env,npm_config_cache:cache,npm_config_update_notifier:'false'};
  const npmCommand=process.env.npm_execpath?process.execPath:'npm';
  const npmArgs=process.env.npm_execpath?[process.env.npm_execpath]:[];
  const packed=await execFileAsync(npmCommand,[...npmArgs,'pack','--foreground-scripts','--pack-destination',destination],{cwd:root,env,maxBuffer:8*1024*1024});
  expect(packed.stdout+packed.stderr).toContain('postpack: final tar watcher --help verified');
  await expect(stat(path.join(root,'dist/retired.js'))).rejects.toThrow();
  const manifest=JSON.parse(await readFile(path.join(root,'dist/build-integrity.json'),'utf8'));
  expect(manifest.toolchain.node_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.inputs['src/agents/usage.ts']).toMatch(/^[a-f0-9]{64}$/);
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const tar=path.join(destination,`${pkg.name}-${pkg.version}.tgz`);
  const checker=path.join(root,'scripts/release/package-integrity.mjs');
  const runCheck=()=>execFileAsync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(pathToFileURL(checker).href)});m.smokeTar(${JSON.stringify(root)},${JSON.stringify(tar)});`],{cwd:root,env});
  await runCheck();
  const source=path.join(root,'src/agents/usage.ts'),before=await readFile(source,'utf8'),stamp=await stat(source);
  await writeFile(source,before.replace('export function sessionUsage','export function missingUsage'));await utimes(source,stamp.atime,stamp.mtime);
  await expect(runCheck()).rejects.toThrow();await writeFile(source,before);
  // Even a self-consistent output manifest cannot hide a broken ESM link or
  // an entry that exits zero without rendering --help.
  const usage=path.join(root,'dist/agents/public/usage.js'),original=await readFile(usage,'utf8');
  const moduleUrl=new URL('../../../scripts/release/package-integrity.mjs',import.meta.url).href;
  const integrity=await import(moduleUrl);
  for(const [file,content] of [[usage,original.replace('export async function readUsage','async function readUsage')],[path.join(root,'scripts/usage-audit/run.mjs'),'export {};\n']] as [string,string][]) {
    const saved=await readFile(file,'utf8');await writeFile(file,content!);
    manifest.inputs=integrity.inputs(root);manifest.outputs=integrity.outputs(root);
    await writeFile(path.join(root,'dist/build-integrity.json'),JSON.stringify(manifest));
    await execFileAsync(npmCommand,[...npmArgs,'pack','--ignore-scripts','--pack-destination',destination],{cwd:root,env,maxBuffer:8*1024*1024});
    await expect(runCheck()).rejects.toThrow();await writeFile(file,saved);
  }
},120_000);

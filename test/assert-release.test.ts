import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const GATE_SCRIPT = fileURLToPath(new URL("../scripts/assert-release.js", import.meta.url));

/**
 * The gate resolves the package root from its own location, so each case gets
 * a fresh fake root: the gate script is copied into <root>/scripts/ and the
 * dist/skills files under test are materialized around it.
 */
async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tut-assert-release-"));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await copyFile(GATE_SCRIPT, path.join(root, "scripts", "assert-release.js"));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

/** Complete, healthy fixture — individual cases delete/shrink one entry. */
const HEALTHY_FILES: Record<string, string> = {
  "dist/cli.js": `#!/usr/bin/env node\n${"x".repeat(10_001)}`,
  "dist/launcher/pane-runner.js": "export {};\n",
  "dist/launcher/probe-runner.js": "export {};\n",
  "skills/architect.md": "# architect\n",
  "skills/executor.md": "# executor\n",
  "skills/reviewer.md": "# reviewer\n",
  "skills/host.md": "# host\n",
};

async function runGate(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(root, "scripts", "assert-release.js")], {
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

describe("scripts/assert-release.js release gate", () => {
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
    expect(result.stderr).toContain("dist/cli.js");
  });

  it("fails when dist/launcher/pane-runner.js is missing (absolute-path pane contract)", async () => {
    const files = { ...HEALTHY_FILES };
    delete files["dist/launcher/pane-runner.js"];
    const root = await freshRoot(files);
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pane-runner.js");
  });

  it("fails when dist/launcher/probe-runner.js is missing", async () => {
    const files = { ...HEALTHY_FILES };
    delete files["dist/launcher/probe-runner.js"];
    const root = await freshRoot(files);
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("probe-runner.js");
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
    const root = await freshRoot({ ...HEALTHY_FILES, "dist/launcher/pane-runner.js": "" });
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pane-runner.js");
    expect(result.stderr).toContain("suspiciously small");
  });

  it("fails when a runner path is a directory (its nonzero size would pass a bare non-empty check)", async () => {
    const root = await freshRoot(HEALTHY_FILES);
    const runner = path.join(root, "dist", "launcher", "pane-runner.js");
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
    const launcher = path.join(root, "dist", "launcher");
    await copyFile(path.join(launcher, "pane-runner.js"), path.join(launcher, "probe-runner.real.js"));
    await rm(path.join(launcher, "probe-runner.js"));
    await symlink(path.join(launcher, "probe-runner.real.js"), path.join(launcher, "probe-runner.js"));
    const result = await runGate(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("assert-release: ok");
  });

  it("fails when dist/cli.js is present but undersized (the original 10KB heuristic)", async () => {
    const root = await freshRoot({ ...HEALTHY_FILES, "dist/cli.js": "#!/usr/bin/env node\nsmall" });
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("dist/cli.js");
    expect(result.stderr).toContain("suspiciously small");
  });

  it("names every missing entry in one run instead of stopping at the first", async () => {
    const files = { ...HEALTHY_FILES };
    delete files["dist/launcher/pane-runner.js"];
    delete files["skills/host.md"];
    const root = await freshRoot(files);
    const result = await runGate(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("pane-runner.js");
    expect(result.stderr).toContain(path.join("skills", "host.md"));
  });
});

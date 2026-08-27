// pane-runner (dist/launcher/pane-runner.js) — the encoded-form execution
// target (launcher port design §3.3).  These tests pin the argv contract,
// payload validation, shell/file-association shim refusal, and the fixed
// exit-code table.
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import {
  PaneRunnerPayloadError,
  PaneRunnerTargetError,
  decodePaneRunnerPayload,
  runPaneRunner,
  signalExitCode,
  spawnPlanFor,
  validatePaneRunnerPayload,
  type PaneRunnerPayload,
} from "../src/launcher/pane-runner.js";
import { encodePaneRunnerPayload } from "../src/launcher/shell-renderer.js";

const run = promisify(execFile);
const RUNNER = path.resolve(import.meta.dirname, "../dist/launcher/pane-runner.js");
const TRASH: string[] = [];

function tmpdir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tut-pane-runner-"));
  TRASH.push(dir);
  return realpathSync(dir); // process.cwd() in children reports the REAL path (/private/var on macOS)
}

afterAll(() => {
  for (const dir of TRASH) rmSync(dir, { recursive: true, force: true });
});

/** Build a payload whose target is `node -e <script>` in a temp cwd. */
function nodePayload(script: string, env: Record<string, string> = {}, cwd?: string): PaneRunnerPayload {
  return {
    protocol_version: 1,
    cwd: cwd ?? tmpdir(),
    executable: process.execPath,
    args: ["-e", script],
    env,
    purpose: "agent",
  };
}

const tokenOf = (payload: PaneRunnerPayload): string =>
  encodePaneRunnerPayload({
    cwd: payload.cwd,
    executable: payload.executable,
    args: payload.args,
    env: payload.env,
    dialect: "posix",
    purpose: payload.purpose as "agent" | "service",
  });

/** Invoke the BUILT runner (build must have produced dist/) and report code+stderr. */
async function runBuilt(argv: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const r = await run(process.execPath, [RUNNER, ...argv]);
    return { code: 0, stderr: r.stderr, stdout: r.stdout };
  } catch (error) {
    const e = error as { code?: number; stderr?: string; stdout?: string };
    return { code: e.code ?? 1, stderr: e.stderr ?? "", stdout: e.stdout ?? "" };
  }
}

// --- payload validation ----------------------------------------------------------------

describe("pane-runner payload contract", () => {
  const valid = {
    protocol_version: 1,
    cwd: "/repo",
    executable: "pi",
    args: ["a", ""],
    env: { A: "1", EMPTY: "" },
    purpose: "service",
  };

  it("accepts the full shape, empty-string arg and empty-string env value included", () => {
    expect(validatePaneRunnerPayload(valid)).toEqual(valid);
    expect(validatePaneRunnerPayload({ ...valid, purpose: "pane-runner" }).purpose).toBe("pane-runner");
  });

  it("rejects unknown fields, unknown protocol versions, and bad shapes", () => {
    expect(() => validatePaneRunnerPayload({ ...valid, shell: "true" })).toThrowError(PaneRunnerPayloadError);
    expect(() => validatePaneRunnerPayload({ ...valid, protocol_version: 2 })).toThrowError(/protocol_version/);
    expect(() => validatePaneRunnerPayload({ ...valid, cwd: "" })).toThrowError(/cwd/);
    expect(() => validatePaneRunnerPayload({ ...valid, cwd: "rel/ative" })).toThrowError(/absolute/);
    expect(() => validatePaneRunnerPayload({ ...valid, executable: "" })).toThrowError(/executable/);
    expect(() => validatePaneRunnerPayload({ ...valid, args: "no" })).toThrowError(/args/);
    expect(() => validatePaneRunnerPayload({ ...valid, args: ["a\nb"] })).toThrowError(/NUL\/CR\/LF/);
    expect(() => validatePaneRunnerPayload({ ...valid, env: { "bad-name": "1" } })).toThrowError(/portable/);
    expect(() => validatePaneRunnerPayload({ ...valid, purpose: "shell" })).toThrowError(/purpose/);
  });

  it("decode: base64url only, JSON only", () => {
    expect(() => decodePaneRunnerPayload("has=padding=")).toThrowError(PaneRunnerPayloadError);
    expect(() => decodePaneRunnerPayload("!!!")).toThrowError(PaneRunnerPayloadError);
    expect(() => decodePaneRunnerPayload(Buffer.from("not json", "utf8").toString("base64url"))).toThrowError(/JSON/);
    const token = Buffer.from(JSON.stringify(valid), "utf8").toString("base64url");
    expect(decodePaneRunnerPayload(token)).toEqual(valid);
  });
});

// --- spawn dispatch --------------------------------------------------------------------

describe("spawn dispatch by target form", () => {
  const payload = (executable: string): PaneRunnerPayload => ({
    protocol_version: 1, cwd: "C:\\w", executable, args: ["--flag", "v"], env: {}, purpose: "agent",
  });

  it(".cmd/.bat/.ps1/.sh shims are refused closed with an actionable message", () => {
    expect(() => spawnPlanFor(payload("C:\\npm\\npm.cmd"))).toThrowError(/\.cmd.*native executable.*Node entry/s);
    expect(() => spawnPlanFor(payload("C:\\x\\tool.bat"))).toThrowError(/\.bat.*native executable.*Node entry/s);
    expect(() => spawnPlanFor(payload("C:\\x\\a.ps1"))).toThrowError(PaneRunnerTargetError);
    expect(() => spawnPlanFor(payload("/usr/x/a.sh"))).toThrowError(/\.sh.*native executable.*Node entry/s);
  });

  it("PE executables and Node entries spawn directly with the raw argv order", () => {
    expect(spawnPlanFor(payload("C:\\pi\\pi.exe"))).toEqual({ file: "C:\\pi\\pi.exe", args: ["--flag", "v"] });
    expect(spawnPlanFor(payload("/usr/local/bin/pi"))).toEqual({ file: "/usr/local/bin/pi", args: ["--flag", "v"] });
  });
});

// --- exit-code table (built entry, real child processes) -------------------------------

describe("pane-runner exit codes and child fidelity (built dist entry)", () => {
  it("child receives executable/args/cwd/env byte-for-byte; code 0 passes through", async () => {
    const cwd = tmpdir();
    const script =
      "const a=process.argv.slice(1);process.stdout.write(JSON.stringify({argv:a,cwd:process.cwd(),v:process.env.TUT_PR_V,empty:process.env.TUT_PR_EMPTY}));";
    const payload = {
      protocol_version: 1,
      cwd,
      executable: process.execPath,
      args: ["-e", script, "sp ace", ""],
      env: { TUT_PR_V: "va lue", TUT_PR_EMPTY: "" },
      purpose: "agent" as const,
    };
    const r = await runBuilt(["--payload", tokenOf(payload)]);
    expect(r.code).toBe(0);
    // `node -e script sp\ ace ""` presents argv[1..] as the user args.
    const seen = JSON.parse(r.stdout) as { argv: string[]; cwd: string; v: string; empty: string };
    expect(seen.argv).toEqual(["sp ace", ""]);
    expect(seen.cwd).toBe(cwd);
    expect(seen.v).toBe("va lue");
    expect(seen.empty).toBe(""); // empty env value is a value, not a deletion
  }, 20_000);

  it("a non-zero child code passes through unchanged", async () => {
    const r = await runBuilt(["--payload", tokenOf(nodePayload("process.exit(42)"))]);
    expect(r.code).toBe(42);
  }, 20_000);

  it("signal termination maps to 128+N", async () => {
    const r = await runBuilt(["--payload", tokenOf(nodePayload("process.kill(process.pid, 'SIGTERM')"))]);
    expect(r.code).toBe(143);
    expect(signalExitCode("SIGKILL")).toBe(137);
    expect(signalExitCode(null)).toBe(1);
  }, 20_000);

  it("argv contract violations and payload errors exit 64 with actionable stderr", async () => {
    expect((await runBuilt([])).code).toBe(64);
    expect((await runBuilt(["--payload"])).code).toBe(64);
    expect((await runBuilt(["--payload", "e30", "extra"])).code).toBe(64);
    const bad = await runBuilt(["--payload", Buffer.from('{"protocol_version":9}', "utf8").toString("base64url")]);
    expect(bad.code).toBe(64);
    expect(bad.stderr).toContain("protocol_version");
    expect(bad.stderr).toContain("pane-runner:");
  }, 20_000);

  it("missing executable exits 127; non-executable target exits 126", async () => {
    const dir = tmpdir();
    const missing = { protocol_version: 1, cwd: dir, executable: path.join(dir, "no-such-exe"), args: [], env: {}, purpose: "agent" as const };
    expect((await runBuilt(["--payload", tokenOf(missing)])).code).toBe(127);
    const noExec = path.join(dir, "plain.txt");
    writeFileSync(noExec, "data", { mode: 0o644 });
    const denied = { protocol_version: 1, cwd: dir, executable: noExec, args: [], env: {}, purpose: "agent" as const };
    expect((await runBuilt(["--payload", tokenOf(denied)])).code).toBe(126);
  }, 20_000);

  it(".ps1 shim refusal exits 126 before any spawn", async () => {
    const dir = tmpdir();
    const shim = { protocol_version: 1, cwd: dir, executable: "C:\\tools\\agent.ps1", args: [], env: {}, purpose: "agent" as const };
    const r = await runBuilt(["--payload", tokenOf(shim)]);
    expect(r.code).toBe(126);
    expect(r.stderr).toContain(".ps1");
  }, 20_000);
});

// --- injected spawn seam: the wrap/dispatch shapes without Windows ----------------------

describe("runPaneRunner spawn seam", () => {
  interface Seen {
    file: string;
    args: string[];
    options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean | undefined; stdio: unknown };
  }

  const makeSpawn = (seen: Seen[]) =>
    ((file: string, args: readonly string[], options: unknown) => {
      const o = options as Seen["options"];
      seen.push({ file, args: [...args], options: { cwd: o.cwd, env: o.env, shell: o.shell, stdio: o.stdio } });
      const child = new EventEmitter() as EventEmitter & { once: EventEmitter["once"] };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }) as never;

  it("the child env is the parent env overlaid by the payload env, shell:false, stdio inherit", async () => {
    const seen: Seen[] = [];
    const payload = nodePayload("x", { PI_SKIP_VERSION_CHECK: "1" });
    const code = await runPaneRunner(["--payload", tokenOf(payload)], {
      spawnFn: makeSpawn(seen),
      env: { PATH: "/bin", BASE: "1" },
    });
    expect(code).toBe(0);
    expect(seen[0]?.file).toBe(process.execPath);
    expect(seen[0]?.options.cwd).toBe(payload.cwd);
    expect(seen[0]?.options.env).toEqual({ PATH: "/bin", BASE: "1", PI_SKIP_VERSION_CHECK: "1" });
    expect(seen[0]?.options.shell).toBe(false);
    expect(seen[0]?.options.stdio).toBe("inherit");
  });

  it("a .cmd payload is refused before spawn", async () => {
    const seen: Seen[] = [];
    const code = await runPaneRunner(
      ["--payload", tokenOf({ protocol_version: 1, cwd: tmpdir(), executable: "C:\\npm\\npm.cmd", args: ["-v"], env: {}, purpose: "agent" })],
      { spawnFn: makeSpawn(seen), env: {} },
    );
    expect(code).toBe(126);
    expect(seen).toHaveLength(0);
  });
});

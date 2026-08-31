/**
 * Platform target resolution (launcher port design §3) — the unit-3 seam.
 *
 * Windows resolver fixtures inject where/stat/readHeader so every candidate
 * class (.exe/.com/extensionless PE/node entry/.cmd/.bat/.ps1/.sh/other
 * extension/directory/stale/not-found/where-failure) is covered without a
 * Windows host.  POSIX fixtures run the REAL `which` against a temp PATH
 * (extensionless shebang, symlink, native stub, missing) and inject which
 * results only for distro-variance rows (non-executable, directory).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The start-next wiring test mocks the Hub client the same way as
// test/cli-start-next.test.ts: the door must fail its Windows target pre-check
// BEFORE the launch marker (hubPublish must never fire).
vi.mock("../src/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub-client.js")>()),
  hubPublish: vi.fn(),
  hubRead: vi.fn(),
}));

import { main } from "../src/cli.js";
import { hubPublish, hubRead } from "../src/hub-client.js";

import {
  AgentTargetError,
  UnsupportedWindowsShimError,
  planForPlatform,
  resolvePlatformExecutionPlan,
  resolvePosixTargetPresence,
  resolveWindowsExecutableTarget,
  selfUpdatePolicyFor,
  type ProbeResult,
  type WindowsTargetDeps,
} from "../src/launcher/target-resolver.js";
import { buildLaunchInvocation, deserializeLaunchInvocation, serializeLaunchInvocation, targetDigest } from "../src/launcher/invocation.js";
import { runLaunchEntry } from "../src/launcher/entry.js";
import type { AgentCommand, LaunchInvocation } from "../src/types.js";

// --- Windows fixtures --------------------------------------------------------------

/** where.exe stdout: CRLF lines, where order, exactly as the real tool prints. */
const whereOk = (lines: string[], code = 0): ProbeResult => ({ code, stdout: `${lines.join("\r\n")}\r\n` });

const regularFile = (mode = 0o100755): Stats =>
  ({ isFile: () => true, isDirectory: () => false, mode }) as unknown as Stats;
const directoryStat = (): Stats =>
  ({ isFile: () => false, isDirectory: () => true, mode: 0o040755 }) as unknown as Stats;

const windowsDeps = (overrides: Partial<WindowsTargetDeps> = {}): WindowsTargetDeps => ({
  where: async () => whereOk(["C:\\npm\\pi.exe"]),
  stat: async () => regularFile(),
  ...overrides,
});

describe("Windows executable target resolver", () => {
  it("resolves a native .exe by absolute path with no prefix args", async () => {
    await expect(
      resolveWindowsExecutableTarget("pi", windowsDeps({ where: async () => whereOk(["C:\\Program Files\\TUT\\pi.exe"]) })),
    ).resolves.toEqual({
      kind: "native",
      executable: "C:\\Program Files\\TUT\\pi.exe",
      prefix_args: [],
      source_path: "C:\\Program Files\\TUT\\pi.exe",
    });
  });

  it("resolves a native .com target the same way", async () => {
    await expect(
      resolveWindowsExecutableTarget("old", windowsDeps({ where: async () => whereOk(["C:\\dos\\old.com"]) })),
    ).resolves.toMatchObject({ kind: "native", executable: "C:\\dos\\old.com", prefix_args: [] });
  });

  it("accepts an extensionless target only with a PE (MZ) header", async () => {
    const deps = windowsDeps({ where: async () => whereOk(["C:\\tools\\pi"]) });
    await expect(resolveWindowsExecutableTarget("pi", { ...deps, readHeader: async () => Buffer.from([0x4d, 0x5a]) }))
      .resolves.toMatchObject({ kind: "native", executable: "C:\\tools\\pi" });
    await expect(resolveWindowsExecutableTarget("pi", { ...deps, readHeader: async () => Buffer.from([0x7f, 0x45]) }))
      .rejects.toBeInstanceOf(AgentTargetError);
  });

  it("production default adapters resolve a real extensionless MZ file (no readHeader injection)", async () => {
    // A real file literally named `C:\pi-mz` inside the temp dir: the name is
    // already a win32 absolute path, so path.win32.resolve keeps it byte-for-byte
    // while the production fs.stat/fs.open adapters find it relative to cwd.
    const dir = mkdtempSync(path.join(os.tmpdir(), "tut-mz-default-"));
    const candidate = "C:\\pi-mz";
    const prevCwd = process.cwd();
    try {
      writeFileSync(path.join(dir, candidate), Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x00, 0x00]));
      process.chdir(dir);
      // ONLY where is injected (it does not exist on POSIX hosts); stat and
      // readHeader run the production defaults against the real file.
      await expect(
        resolveWindowsExecutableTarget("pi", { where: async () => whereOk([candidate]) }),
      ).resolves.toEqual({
        kind: "native",
        executable: candidate,
        prefix_args: [],
        source_path: candidate,
      });
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("production default adapters reject non-MZ and empty extensionless files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tut-mz-negative-"));
    const prevCwd = process.cwd();
    try {
      writeFileSync(path.join(dir, "C:\\pi-elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      writeFileSync(path.join(dir, "C:\\pi-empty"), Buffer.alloc(0));
      process.chdir(dir);
      await expect(resolveWindowsExecutableTarget("pi", { where: async () => whereOk(["C:\\pi-elf"]) }))
        .rejects.toThrowError(/C:\\pi-elf.*no PE header/u);
      await expect(resolveWindowsExecutableTarget("pi", { where: async () => whereOk(["C:\\pi-empty"]) }))
        .rejects.toThrowError(/C:\\pi-empty.*no PE header/u);
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps production header-read failures into the actionable AgentTargetError contract", async () => {
    const error = await resolveWindowsExecutableTarget("pi", {
      where: async () => whereOk(["C:\\gone\\pi"]),
      stat: async () => regularFile(), // stat says a file is there …
      // … and the PRODUCTION readHeader then fails to open it.
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentTargetError);
    const message = (error as Error).message;
    expect(message).toContain("'pi'");                  // route agent
    expect(message).toContain("C:\\gone\\pi");        // candidate path
    expect(message).toContain("header read failed");   // reason
    expect((error as AgentTargetError).hint).toContain("native executable"); // fix advice
  });

  it("runs direct Node entries (.js/.mjs/.cjs) with the Node executable and script prefix", async () => {
    for (const ext of [".js", ".mjs", ".cjs"]) {
      await expect(
        resolveWindowsExecutableTarget("agent", windowsDeps({
          where: async () => whereOk([`C:\\npm\\agent${ext}`]),
          nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        })),
      ).resolves.toEqual({
        kind: "node-entry",
        executable: "C:\\Program Files\\nodejs\\node.exe",
        prefix_args: [`C:\\npm\\agent${ext}`],
        source_path: `C:\\npm\\agent${ext}`,
      });
    }
  });

  it.each([".cmd", ".bat", ".ps1", ".sh"])("refuses the %s shim with an actionable message", async (ext) => {
    const promise = resolveWindowsExecutableTarget("pi", windowsDeps({
      where: async () => whereOk([`C:\\npm\\pi${ext}`]),
    }));
    await expect(promise).rejects.toBeInstanceOf(UnsupportedWindowsShimError);
    await expect(promise).rejects.toThrowError(/'pi'/u);
    await expect(promise).rejects.toThrowError(/pi\.cmd|pi\.bat|pi\.ps1|pi\.sh/u);
    await expect(promise).rejects.toThrowError(/native executable/u);
  });

  it("never skips an only-shim first candidate to guess a later .exe", async () => {
    const error = await resolveWindowsExecutableTarget("pi", windowsDeps({
      where: async () => whereOk(["C:\\npm\\pi.cmd", "C:\\Program Files\\pi\\pi.exe"]),
      stat: async (candidate) => {
        if (candidate === "C:\\npm\\pi.cmd") return regularFile();
        throw new Error("the later candidate must never be examined");
      },
    })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedWindowsShimError);
    expect((error as UnsupportedWindowsShimError).shimPath).toBe("C:\\npm\\pi.cmd");
  });

  it("walks past a non-PE extensionless candidate and classifies the later .cmd shim", async () => {
    const error = await resolveWindowsExecutableTarget("pi", windowsDeps({
      where: async () => whereOk(["C:\\npm\\pi", "C:\\npm\\pi.cmd"]),
      readHeader: async () => Buffer.from([0x23, 0x21]),
    })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedWindowsShimError);
    expect((error as UnsupportedWindowsShimError).shimPath).toBe("C:\\npm\\pi.cmd");
    expect((error as Error).message).toContain(".cmd");
    expect((error as Error).message).not.toContain("no PE header");
  });

  it("returns an earlier .exe without examining a later extensionless candidate", async () => {
    const statCandidates: string[] = [];
    const result = await resolveWindowsExecutableTarget("pi", windowsDeps({
      where: async () => whereOk(["C:\\Program Files\\pi.exe", "C:\\npm\\pi"]),
      stat: async (candidate) => {
        statCandidates.push(candidate);
        return regularFile();
      },
      readHeader: async () => { throw new Error("later extensionless candidate must not be read"); },
    }));
    expect(result).toMatchObject({ kind: "native", executable: "C:\\Program Files\\pi.exe" });
    expect(statCandidates).toEqual(["C:\\Program Files\\pi.exe"]);
  });

  it("reports every untrusted where.exe candidate in the final AgentTargetError", async () => {
    const extensionless = "C:\\npm\\pi";
    const directory = "C:\\tools\\pi.exe";
    const stale = "C:\\gone\\pi.com";
    const error = await resolveWindowsExecutableTarget("pi", windowsDeps({
      where: async () => whereOk([extensionless, directory, stale]),
      stat: async (candidate) => {
        if (candidate === extensionless) return regularFile();
        if (candidate === directory) return directoryStat();
        throw new Error("ENOENT: no such file");
      },
      readHeader: async () => Buffer.from([0x7f, 0x45]),
    })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentTargetError);
    expect((error as AgentTargetError).agent).toBe("pi");
    expect((error as AgentTargetError).hint).toContain("native executable");
    expect((error as Error).message).toContain(extensionless);
    expect((error as Error).message).toContain(directory);
    expect((error as Error).message).toContain(stale);
  });

  it("maps other file-association extensions (.py) to the shim refusal", async () => {
    await expect(
      resolveWindowsExecutableTarget("pyagent", windowsDeps({ where: async () => whereOk(["C:\\tools\\pyagent.py"]) })),
    ).rejects.toBeInstanceOf(UnsupportedWindowsShimError);
  });

  it("reports not-found, where failure, non-file, and stale candidates as distinct AgentTargetErrors", async () => {
    await expect(resolveWindowsExecutableTarget("pi", windowsDeps({ where: async () => whereOk([], 1) })))
      .rejects.toThrowError(/not found via where\.exe/u);
    await expect(
      resolveWindowsExecutableTarget("pi", windowsDeps({ where: async () => ({ code: null, stdout: "", error: new Error("ENOENT") }) })),
    ).rejects.toThrowError(/where\.exe failed/u);
    await expect(
      resolveWindowsExecutableTarget("pi", windowsDeps({ where: async () => whereOk(["C:\\npm\\pi"]), stat: async () => directoryStat() })),
    ).rejects.toThrowError(/non-file/u);
    await expect(
      resolveWindowsExecutableTarget("pi", windowsDeps({ where: async () => whereOk(["C:\\gone\\pi.exe"]), stat: async () => { throw new Error("ENOENT: no such file"); } })),
    ).rejects.toThrowError(/unavailable/u);
  });
});

// --- POSIX which preflight ----------------------------------------------------------

describe("POSIX which presence preflight", () => {
  const savedPath = process.env.PATH;
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env.PATH = savedPath;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixtureBin(setup: (bin: string) => void): string {
    const bin = mkdtempSync(path.join(os.tmpdir(), "tut-posix-target-"));
    tempDirs.push(bin);
    setup(bin);
    process.env.PATH = `${bin}:${savedPath}`;
    return bin;
  }

  it("accepts an extensionless shebang script, a symlink, and a native stub — via the real which", async () => {
    const bin = fixtureBin((dir) => {
      writeFileSync(path.join(dir, "shebang-agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(path.join(dir, "real-native"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      symlinkSync(path.join(dir, "real-native"), path.join(dir, "linked-agent"));
    });
    for (const agent of ["shebang-agent", "linked-agent", "real-native"]) {
      const proof = await resolvePosixTargetPresence(agent);
      expect(proof.agent).toBe(agent);
      expect(proof.candidate.startsWith(bin)).toBe(true);
    }
  });

  it("fails a missing agent with the agent name, which result, and a fix hint", async () => {
    fixtureBin(() => { /* empty bin */ });
    const error = await resolvePosixTargetPresence("ghost-agent-x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentTargetError);
    expect((error as Error).message).toContain("agent 'ghost-agent-x' not on PATH");
    expect((error as Error).message).toContain("which");
    expect((error as AgentTargetError).hint).toContain("install");
  });

  it("rejects which candidates that are not executable regular files (distro-variance rows)", async () => {
    const bin = fixtureBin((dir) => {
      writeFileSync(path.join(dir, "plain-file"), "not executable\n", { mode: 0o644 });
    });
    await expect(
      resolvePosixTargetPresence("plain-file", { which: async () => ({ code: 0, stdout: `${path.join(bin, "plain-file")}\n` }) }),
    ).rejects.toThrowError(/not executable/u);
    await expect(
      resolvePosixTargetPresence("dir-agent", { which: async () => ({ code: 0, stdout: `${bin}\n` }) }),
    ).rejects.toThrowError(/not a regular file/u);
    await expect(
      resolvePosixTargetPresence("broken-agent", { which: async () => ({ code: 0, stdout: `${path.join(bin, "vanished")}\n` }) }),
    ).rejects.toThrowError(/unusable which candidate/u);
    await expect(
      resolvePosixTargetPresence("spawn-fail-agent", { which: async () => ({ code: null, stdout: "", error: new Error("which: ENOENT") }) }),
    ).rejects.toThrowError(/which failed/u);
  });

  it("keeps the POSIX plan on the bare route agent — the which path never enters it", async () => {
    const bin = fixtureBin((dir) => {
      writeFileSync(path.join(dir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    });
    const route: AgentCommand = { agent: "pi", args: ["--flag", "with space"] };
    const plan = await resolvePlatformExecutionPlan(route, { environment: {} });
    expect(plan).toEqual({
      platform: "posix",
      posix_direct: { executable: "pi", args: ["--flag", "with space"], env: { PI_SKIP_VERSION_CHECK: "1" } },
    });
    expect(JSON.stringify(plan)).not.toContain(bin);
  });

  it("fails the POSIX door plan before returning when presence fails", async () => {
    await expect(resolvePlatformExecutionPlan({ agent: "ghost-door", args: [] }, { environment: {} }))
      .rejects.toBeInstanceOf(AgentTargetError);
  });
});

// --- frozen policy + Windows plans ---------------------------------------------------

describe("self-update policy and the Windows platform plan", () => {
  const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : { TUT_SUPPRESS_AGENT_UPDATE: value });

  it("freezes the suppression policy by bare agent name once", () => {
    expect(selfUpdatePolicyFor("codex", ["--model", "fast"], env("1")).args)
      .toEqual(["--model", "fast", "-c", "check_for_update_on_startup=false"]);
    expect(selfUpdatePolicyFor("pi", ["--model", "x"], env("1")).env).toEqual({ PI_SKIP_VERSION_CHECK: "1" });
    expect(selfUpdatePolicyFor("other", ["keep"], env("1"))).toEqual({ args: ["keep"], env: {} });
    expect(selfUpdatePolicyFor("codex", ["keep"], env("0")).args).toEqual(["keep"]);
    expect(selfUpdatePolicyFor("pi", [], env("0")).env).toEqual({});
  });

  it("builds the Windows plan from the structured target: prefix args, suppression tail, frozen env", async () => {
    const native = await planForPlatform(
      { agent: "codex", args: ["--model", "gpt-5.6"] },
      {
        environment: { TUT_SUPPRESS_AGENT_UPDATE: "1" },
        platform: "win32",
        windowsDeps: windowsDeps({ where: async () => whereOk(["C:\\codex\\codex.exe"]) }),
      },
    );
    expect(native).toEqual({
      platform: "windows",
      resolved_target: { kind: "native", executable: "C:\\codex\\codex.exe", prefix_args: [], source_path: "C:\\codex\\codex.exe" },
      effective_agent: {
        executable: "C:\\codex\\codex.exe",
        args: ["--model", "gpt-5.6", "-c", "check_for_update_on_startup=false"],
        env: {},
      },
    });

    const nodeEntry = await planForPlatform(
      { agent: "pi", args: ["--model", "glm"] },
      {
        environment: {},
        platform: "win32",
        windowsDeps: windowsDeps({
          where: async () => whereOk(["C:\\npm\\pi.mjs"]),
          nodeExecutable: "C:\\node\\node.exe",
        }),
      },
    );
    expect(nodeEntry).toEqual({
      platform: "windows",
      resolved_target: { kind: "node-entry", executable: "C:\\node\\node.exe", prefix_args: ["C:\\npm\\pi.mjs"], source_path: "C:\\npm\\pi.mjs" },
      effective_agent: {
        executable: "C:\\node\\node.exe",
        args: ["C:\\npm\\pi.mjs", "--model", "glm"],
        env: { PI_SKIP_VERSION_CHECK: "1" },
      },
    });
  });
});

// --- marker projection over the Windows private plan ----------------------------------

function windowsPlan(): LaunchInvocation {
  const route: AgentCommand = { agent: "pi", args: ["--model", "glm"] };
  const target = { kind: "native" as const, executable: "C:\\pi\\pi.exe", prefix_args: [], source_path: "C:\\pi\\pi.exe" };
  const effective = { executable: "C:\\pi\\pi.exe", args: ["--model", "glm"], env: { PI_SKIP_VERSION_CHECK: "1" } };
  return buildLaunchInvocation({
    request: { kind: "round", task_id: "t-win", role: "executor", fresh: false, via: "start-next" },
    base_version: 3,
    hub_url: "http://127.0.0.1:3001",
    route,
    route_source: "task-cast",
    context: {
      anchor: { workspace_id: "w1", cwd: "C:\\work\\project", pane_id: "w1:p1" },
      hubRoot: "C:\\work\\project",
      routingRoot: "C:\\work\\project",
      checkoutRoot: "C:\\work\\project",
      checkout: { kind: "current" },
      context: { kind: "shared" },
      source: "anchor",
    },
    naming: { tab_label: "TUT executor", pane_label: "t-win.executor" },
    prompt: "round",
    resolved_target: target,
    effective_agent: effective,
  });
}

describe("marker projection over the Windows platform plan", () => {
  it("carries target_kind native and a digest over the Windows private input only", () => {
    const invocation = windowsPlan();
    const marker = invocation.marker_projection;
    expect(marker?.target_kind).toBe("native");
    expect(marker?.target_digest).toBe(targetDigest({
      route: { agent: "pi", args: ["--model", "glm"] },
      target_kind: "native",
      resolved_target: { kind: "native", executable: "C:\\pi\\pi.exe", prefix_args: [], source_path: "C:\\pi\\pi.exe" },
      effective_agent: { executable: "C:\\pi\\pi.exe", args: ["--model", "glm"], env: { PI_SKIP_VERSION_CHECK: "1" } },
    }));
    // The portable marker never carries machine-local paths or env values.
    expect(JSON.stringify(marker)).not.toContain("pi.exe");
    expect(JSON.stringify(marker)).not.toContain("PI_SKIP_VERSION_CHECK");
  });

  it("round-trips the Windows invocation through the child transport", () => {
    const invocation = windowsPlan();
    const decoded = deserializeLaunchInvocation(serializeLaunchInvocation(invocation));
    expect(decoded.resolved_target).toEqual(invocation.resolved_target);
    expect(decoded.effective_agent).toEqual(invocation.effective_agent);
    expect(decoded.posix_direct).toBeUndefined();
  });
});

// --- wiring: Windows plans refuse Herdr mutation before any lifecycle step -----------

describe("compat boundary with a Windows platform plan", () => {
  const FIXTURE_BIN = path.resolve(import.meta.dirname, "bin");
  const savedEnv: Record<string, string | undefined> = {};
  let herdrLog = "";
  let errText = "";

  beforeEach(() => {
    herdrLog = path.join(mkdtempSync(path.join(os.tmpdir(), "tut-win-refuse-")), "herdr.log");
    for (const key of ["TUT_DRY_RUN", "TUT_SUPPRESS_AGENT_UPDATE", "TUT_HERDR_EXECUTABLE", "TUT_HERDR_PANES", "TUT_HERDR_LOG", "TUT_DELIVERY_DIAG", "TUT_PANE_SHELL"]) {
      savedEnv[key] = process.env[key];
    }
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errText += String(chunk);
      return true;
    });
    process.env.TUT_SUPPRESS_AGENT_UPDATE = "1";
    process.env.TUT_HERDR_EXECUTABLE = path.join(FIXTURE_BIN, "herdr"); // any accidental call lands in the fixture log
    process.env.TUT_HERDR_PANES = "[]";
    process.env.TUT_HERDR_LOG = herdrLog;
    process.env.TUT_DELIVERY_DIAG = "0";
    delete process.env.TUT_DRY_RUN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    errText = "";
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("renders the Windows plan through the pane dialect renderer instead of refusing it", async () => {
    // The shell-renderer unit closed the last Windows gap: a Windows platform
    // plan now renders like any other.  powershell5 (the Windows default)
    // with a non-empty env takes the encoded pane-runner form.
    process.env.TUT_DRY_RUN = "1";
    process.env.TUT_PANE_SHELL = "powershell5";
    const outText: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outText.push(String(chunk));
      return true;
    });
    try {
      const invocation = windowsPlan();
      const code = await runLaunchEntry({
        kind: "round",
        request: { kind: "round", task_id: "t-win", role: "executor", fresh: false, via: "start-next" },
        invocation,
      });
      expect(code).toBe(0);
      const text = outText.join("");
      expect(text).toContain("pane run <root> & ");
      expect(text).not.toContain("cd --"); // no POSIX form under powershell5
      const token = /--payload '([A-Za-z0-9_-]+)'/u.exec(text)?.[1] ?? "";
      expect(JSON.parse(Buffer.from(token, "base64url").toString("utf8"))).toEqual({
        protocol_version: 1,
        cwd: "C:\\work\\project",
        executable: "C:\\pi\\pi.exe",
        args: ["--model", "glm"],
        env: { PI_SKIP_VERSION_CHECK: "1" },
        purpose: "agent",
      });
      // Dry-run preview makes no mutation: discovery pane list only.
      const lines = (existsSync(herdrLog) ? readFileSync(herdrLog, "utf8") : "").split("\n").filter((l) => l.length > 0);
      expect(lines.every((l) => l === "pane list")).toBe(true);
    } finally {
      out.mockRestore();
    }
  });

  it("an unknown TUT_PANE_SHELL fails before ANY Herdr call, including discovery", async () => {
    process.env.TUT_PANE_SHELL = "fish";
    const code = await runLaunchEntry({
      kind: "round",
      request: { kind: "round", task_id: "t-win", role: "executor", fresh: false, via: "start-next" },
      invocation: windowsPlan(),
    });
    expect(code).toBe(1);
    expect(errText).toContain("TUT_PANE_SHELL 'fish'");
    // Zero control-plane calls: the dialect is resolved before discovery.
    expect(existsSync(herdrLog) ? readFileSync(herdrLog, "utf8") : "").toBe("");
  });

  it("an unknown TUT_PANE_SHELL fails before ANY Herdr call on the legacy entry path too", async () => {
    // The legacy entry carries no pre-constructed invocation: planning
    // itself (buildLegacyInvocation → resolveExecutionContext) performs the
    // first Herdr discovery.  The dialect gate must still win that race —
    // a bad TUT_PANE_SHELL exits with zero control-plane calls.  Regression
    // for the unit-6 first-review finding.
    const savedPath = process.env.PATH;
    process.env.TUT_PANE_SHELL = "fish";
    // The explicit route keeps even a regressed run off the Hub fetch; the
    // PATH prepend keeps the fixture herdr first if anything does run.
    process.env.PATH = `${FIXTURE_BIN}:${savedPath ?? ""}`;
    try {
      const code = await runLaunchEntry({
        kind: "round",
        request: {
          kind: "round",
          task_id: "t-win",
          role: "executor",
          fresh: false,
          via: "legacy",
          explicit_route_values: ["pi", "--model", "glm"],
        },
      });
      expect(code).toBe(1);
      expect(errText).toContain("TUT_PANE_SHELL 'fish'");
      expect(errText).toContain("expected one of posix, powershell5, pwsh, cmd");
      // Zero control-plane calls: not even the discovery that would have
      // planned this legacy invocation may fire.
      expect(existsSync(herdrLog) ? readFileSync(herdrLog, "utf8") : "").toBe("");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("a valid dialect resolved on the legacy entry path drives the renderer and birth", async () => {
    // Normal legacy launch (no pre-constructed invocation): the dialect
    // resolved before planning is the same one that renders the pane
    // command — pwsh configured, pwsh rendered (never the host-default
    // POSIX form), and the birth pane-run text carries this plan's payload.
    const saved: Record<string, string | undefined> = {};
    for (const key of ["PATH", "TUT_DRY_RUN", "TUT_USER_CONFIG_DIR", "TUT_HUB_URL"]) {
      saved[key] = process.env[key];
    }
    const outText: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outText.push(String(chunk));
      return true;
    });
    const userConfig = mkdtempSync(path.join(os.tmpdir(), "tut-legacy-dialect-"));
    process.env.PATH = `${FIXTURE_BIN}:${saved.PATH ?? ""}`; // fixture `pi` satisfies the legacy preflight
    process.env.TUT_DRY_RUN = "1";
    // Deterministic: hub down → degrade current/default (dummy task id; a
    // live hub on the default port must not leak its real /state here).
    process.env.TUT_HUB_URL = "http://127.0.0.1:1";
    process.env.TUT_USER_CONFIG_DIR = path.join(userConfig, "no-config");
    process.env.TUT_PANE_SHELL = "pwsh";
    try {
      const code = await runLaunchEntry({
        kind: "round",
        request: {
          kind: "round",
          task_id: "t-win",
          role: "executor",
          fresh: false,
          via: "legacy",
          explicit_route_values: ["pi", "--model", "glm"],
        },
      });
      expect(code).toBe(0);
      const text = outText.join("");
      const paneRun = text.split("\n").find((line) => line.includes("pane run <root>")) ?? "";
      // pwsh encoded pane-runner form: no `&&`, no POSIX sq, no cd --.
      expect(paneRun).toContain("--payload '");
      expect(paneRun).toContain("$global:LASTEXITCODE = $LASTEXITCODE");
      expect(text).not.toContain("cd --"); // the host default (posix) never renders
      // The birth command text is the pwsh-encoded form of THIS plan.
      const token = /--payload '([A-Za-z0-9_-]+)'/u.exec(paneRun)?.[1] ?? "";
      expect(JSON.parse(Buffer.from(token, "base64url").toString("utf8"))).toEqual({
        protocol_version: 1,
        cwd: "<cwd>", // dry-run placeholder anchor — honest preview
        executable: "pi",
        args: ["--model", "glm"],
        env: { PI_SKIP_VERSION_CHECK: "1" },
        purpose: "agent",
      });
    } finally {
      out.mockRestore();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(userConfig, { recursive: true, force: true });
    }
  });
});

// --- wiring: start-next on Windows resolves where.exe and refuses shims pre-marker ---

describe("start-next Windows target pre-check (before the marker)", () => {
  const FIXTURE_BIN = path.resolve(import.meta.dirname, "bin");
  const savedEnv: Record<string, string | undefined> = {};
  const savedPlatform = process.platform;
  let errText = "";

  it("only-shim where.exe fixture → exit 1, shim message, no launch note, no spawn", async () => {
    // A fake where.exe on PATH answering with the npm .cmd shim — a POSIX
    // shebang script named where.exe proves the direct argv spawn (no cmd /c).
    const bin = mkdtempSync(path.join(os.tmpdir(), "tut-where-fixture-"));
    for (const key of ["PATH", "TUT_DRY_RUN", "TUT_HERDR_EXECUTABLE", "TUT_HERDR_PANES", "TUT_HUB_URL", "TUT_USER_CONFIG_DIR"]) {
      savedEnv[key] = process.env[key];
    }
    writeFileSync(path.join(bin, "where.exe"), "#!/bin/sh\necho 'C:\\\\npm\\\\pi.cmd'\nexit 0\n", { mode: 0o755 });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errText += String(chunk);
      return true;
    });
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.PATH = `${bin}:${FIXTURE_BIN}:${savedEnv.PATH ?? ""}`;
    process.env.TUT_DRY_RUN = "1";
    process.env.TUT_HERDR_EXECUTABLE = path.join(FIXTURE_BIN, "herdr");
    process.env.TUT_HERDR_PANES = "[]";
    process.env.TUT_HUB_URL = "http://127.0.0.1:1";
    process.env.TUT_USER_CONFIG_DIR = path.join(bin, "no-config");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flow_mode: "manual", tasks: [{ task_id: "t-win", status: "implementing", waiting_for: "agent:executor", cast: { executor: "pi" } }] }) })),
    );
    vi.mocked(hubRead).mockResolvedValue({ task_id: "t-win", title: "Win", status: "implementing", versions: [] });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t-win", version: 1, status: "implementing", needs_attention: false });

    try {
      const code = await main(["start-next", "t-win", "--url", "http://hub.test"]);
      expect(code).toBe(1);
      expect(errText).toContain("cannot resolve launch target");
      expect(errText).toContain("C:\\npm\\pi.cmd");
      expect(errText).toContain("native executable");
      expect(vi.mocked(hubPublish)).not.toHaveBeenCalled(); // 无痕: the marker never lands
    } finally {
      vi.unstubAllGlobals();
      vi.mocked(hubRead).mockReset();
      vi.mocked(hubPublish).mockReset();
      out.mockRestore();
      err.mockRestore();
      errText = "";
      Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("real extensionless MZ file passes the default pre-check, THEN the marker; the child renders the Windows plan (dry-run, no mutation)", async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "tut-where-mz-"));
    const mzDir = mkdtempSync(path.join(os.tmpdir(), "tut-mz-wiring-"));
    for (const key of ["PATH", "TUT_DRY_RUN", "TUT_HERDR_EXECUTABLE", "TUT_HERDR_PANES", "TUT_HERDR_LOG", "TUT_HUB_URL", "TUT_USER_CONFIG_DIR", "TUT_DELIVERY_DIAG"]) {
      savedEnv[key] = process.env[key];
    }
    // The fake where.exe answers with the literal `C:\pi-mz` file that really
    // exists in mzDir; stat/readHeader run the PRODUCTION defaults against it
    // (cwd is mzDir during the run).
    writeFileSync(path.join(bin, "where.exe"), "#!/bin/sh\necho 'C:\\\\pi-mz'\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(mzDir, "C:\\pi-mz"), Buffer.from([0x4d, 0x5a, 0x00, 0x01]));
    const herdrLog = path.join(mzDir, "herdr.log");
    const outText: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outText.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errText += String(chunk);
      return true;
    });
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.PATH = `${bin}:${FIXTURE_BIN}:${savedEnv.PATH ?? ""}`;
    process.env.TUT_DRY_RUN = "1";
    process.env.TUT_HERDR_EXECUTABLE = path.join(FIXTURE_BIN, "herdr");
    process.env.TUT_HERDR_PANES = "[]";
    process.env.TUT_HERDR_LOG = herdrLog;
    process.env.TUT_HUB_URL = "http://127.0.0.1:1";
    process.env.TUT_USER_CONFIG_DIR = path.join(mzDir, "no-config");
    process.env.TUT_DELIVERY_DIAG = "0";
    const prevCwd = process.cwd();
    process.chdir(mzDir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flow_mode: "manual", tasks: [{ task_id: "t-mz", status: "implementing", waiting_for: "agent:executor" }] }) })),
    );
    vi.mocked(hubRead).mockResolvedValue({ task_id: "t-mz", title: "MZ", status: "implementing", versions: [] });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t-mz", version: 1, status: "implementing", needs_attention: false });

    try {
      const code = await main(["start-next", "t-mz", "--url", "http://hub.test"]);
      // Pre-check PASSED with the production header adapter (real MZ file),
      // so the flow reaches the marker and the internal child; the child now
      // RENDERS the Windows plan (POSIX dialect by platform default here) all
      // the way to the dry-run birth preview — no refusal left anywhere.
      expect(code).toBe(0);
      expect(errText).not.toContain("cannot resolve launch target");
      expect(errText).not.toContain("refusing");
      expect(vi.mocked(hubPublish)).toHaveBeenCalledTimes(1); // marker AFTER resolution
      const childOut = outText.join("");
      // The real chain: where.exe's candidate C:\pi-mz + suppression env, rendered
      // by the platform-default dialect (posix here) from the placeholder anchor.
      expect(childOut).toContain(
        "pane run <root> cd -- '<cwd>' && env 'PI_SKIP_VERSION_CHECK=1' 'C:\\pi-mz'",
      );
      // Read-only discovery (pane list) is legal; NO mutation command anywhere.
      const herdrLines = (existsSync(herdrLog) ? readFileSync(herdrLog, "utf8") : "")
        .split("\n").filter((line) => line.length > 0);
      expect(herdrLines.every((line) => line === "pane list")).toBe(true);
    } finally {
      process.chdir(prevCwd);
      vi.unstubAllGlobals();
      vi.mocked(hubRead).mockReset();
      vi.mocked(hubPublish).mockReset();
      out.mockRestore();
      err.mockRestore();
      errText = "";
      Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(bin, { recursive: true, force: true });
      rmSync(mzDir, { recursive: true, force: true });
    }
  });

  it("a non-MZ extensionless file fails the default pre-check BEFORE the marker", async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "tut-where-elf-"));
    const elfDir = mkdtempSync(path.join(os.tmpdir(), "tut-elf-wiring-"));
    for (const key of ["PATH", "TUT_DRY_RUN", "TUT_HERDR_EXECUTABLE", "TUT_HERDR_PANES", "TUT_HUB_URL", "TUT_USER_CONFIG_DIR"]) {
      savedEnv[key] = process.env[key];
    }
    writeFileSync(path.join(bin, "where.exe"), "#!/bin/sh\necho 'C:\\\\pi-elf'\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(elfDir, "C:\\pi-elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errText += String(chunk);
      return true;
    });
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.PATH = `${bin}:${FIXTURE_BIN}:${savedEnv.PATH ?? ""}`;
    process.env.TUT_DRY_RUN = "1";
    process.env.TUT_HERDR_EXECUTABLE = path.join(FIXTURE_BIN, "herdr");
    process.env.TUT_HERDR_PANES = "[]";
    process.env.TUT_HUB_URL = "http://127.0.0.1:1";
    process.env.TUT_USER_CONFIG_DIR = path.join(elfDir, "no-config");
    const prevCwd = process.cwd();
    process.chdir(elfDir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flow_mode: "manual", tasks: [{ task_id: "t-elf", status: "implementing", waiting_for: "agent:executor" }] }) })),
    );
    vi.mocked(hubRead).mockResolvedValue({ task_id: "t-elf", title: "ELF", status: "implementing", versions: [] });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t-elf", version: 1, status: "implementing", needs_attention: false });

    try {
      const code = await main(["start-next", "t-elf", "--url", "http://hub.test"]);
      expect(code).toBe(1);
      expect(errText).toContain("cannot resolve launch target");
      expect(errText).toContain("no PE header");
      expect(errText).toContain("C:\\pi-elf");
      expect(vi.mocked(hubPublish)).not.toHaveBeenCalled(); // 无痕
    } finally {
      process.chdir(prevCwd);
      vi.unstubAllGlobals();
      vi.mocked(hubRead).mockReset();
      vi.mocked(hubPublish).mockReset();
      out.mockRestore();
      err.mockRestore();
      errText = "";
      Object.defineProperty(process, "platform", { value: savedPlatform, configurable: true });
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(bin, { recursive: true, force: true });
      rmSync(elfDir, { recursive: true, force: true });
    }
  });
});

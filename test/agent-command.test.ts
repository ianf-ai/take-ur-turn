import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  AgentCommandError,
  formatAgentRoute,
  normalizeAgentRoute,
  parseAgentInvocation,
  parseAgentRoute,
  validateAgentRoute,
} from "../src/agent-command.js";
import { parseArgs } from "../src/cli.js";
import { resolveAgent, resolveAgentRoute } from "../src/workspace.js";
import { Store } from "../src/store.js";
import { resolveLaunchTarget } from "../src/launch.js";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const RESOLVER = path.join(ROOT, "scripts", "tut-resolve.mjs");
const LAUNCHER = path.join(ROOT, "scripts", "launch.sh");
const FIXTURE_BIN = path.join(ROOT, "test", "bin");

describe("AgentRoute parser", () => {
  it("keeps bare names as strings and parameterized commands as ordered argv", () => {
    expect(parseAgentRoute("  pi  ")).toBe("pi");
    const route = parseAgentRoute("codex --model gpt-5.6 --sandbox workspace-write --search");
    expect(route).toEqual({
      agent: "codex",
      args: ["--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"],
    });
    expect(formatAgentRoute(route)).toBe("codex --model gpt-5.6 --sandbox workspace-write --search");
    expect(normalizeAgentRoute("pi")).toEqual({ agent: "pi", args: [] });
  });

  it("rejects empty words and shell syntax instead of interpreting it", () => {
    for (const value of ["", "   ", "codex ''", "codex;touch", "codex $(whoami)", "codex *.md", "codex --x=a\\b", "codex #comment", "codex !history"]) {
      expect(() => parseAgentRoute(value)).toThrow(AgentCommandError);
    }
    expect(parseAgentInvocation(["codex", "--model", "gpt-5.6"])).toEqual({
      agent: "codex",
      args: ["--model", "gpt-5.6"],
    });
    expect(() => parseAgentInvocation(["codex", ""])).toThrow(AgentCommandError);
    expect(() => parseAgentInvocation(["codex", "   "])).toThrow(AgentCommandError);
    expect(() => validateAgentRoute({ agent: "codex", args: [""] })).toThrow(AgentCommandError);
    expect(() => validateAgentRoute({ agent: "codex", args: ["--model", "gpt 5"] })).toThrow(AgentCommandError);
  });
});

describe("CLI command routes", () => {
  const createArgs = ["--title", "route task", "--description", "desc", "--creator", "host", "--role", "human"];

  it("accepts repeated parameterized --cast and legacy comma shorthand", () => {
    const parsed = parseArgs([
      "create",
      ...createArgs,
      "--cast",
      "executor=codex --model gpt-5.6 --sandbox workspace-write --search",
      "--cast=reviewer=pi",
    ]);
    expect(parsed).toEqual({
      command: "create",
      title: "route task",
      description: "desc",
      creator: "host",
      role: "human",
      cast: {
        executor: { agent: "codex", args: ["--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"] },
        reviewer: "pi",
      },
    });

    const legacy = parseArgs(["create", ...createArgs, "--cast", "executor=pi,reviewer=codex"]);
    expect(legacy).toMatchObject({ cast: { executor: "pi", reviewer: "codex" } });
  });

  it("treats all argv after assign's role as the command value", () => {
    expect(parseArgs(["assign", "executor", "codex", "--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"])).toEqual({
      command: "assign",
      role: "executor",
      agent: { agent: "codex", args: ["--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"] },
    });
  });

  it("rejects empty or whitespace argv after assign's role instead of dropping it", () => {
    expect(parseArgs(["assign", "executor", "codex", ""])).toMatchObject({ command: "usage" });
    expect(parseArgs(["assign", "executor", "codex", "   "])).toMatchObject({ command: "usage" });
  });
});

describe("TS / plain-node route parser parity", () => {
  it("preserves the same already-separated argv values", async () => {
    const values = ["codex", "--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"];
    const mjs = await run(process.execPath, [RESOLVER, "parse-invocation", ...values]);
    expect(mjs.stdout.split("\n")).toEqual(values);
    expect(parseAgentInvocation(values)).toEqual({ agent: values[0], args: values.slice(1) });
  });

  it("rejects the same empty, comment, and history tokens in both implementations", async () => {
    for (const value of ["", "   ", "#comment", "!history"]) {
      expect(() => parseAgentInvocation(["codex", value])).toThrow(AgentCommandError);
      const expected = value.length === 0
        ? "must be a non-empty token"
        : value.trim().length === 0
          ? "must not contain whitespace"
          : "not a shell-neutral token";
      await expect(run(process.execPath, [RESOLVER, "parse-invocation", "codex", value])).rejects.toMatchObject({
        stderr: expect.stringContaining(expected),
      });
    }
  });
});

describe("route propagation through workspace and Store", () => {
  it("passes the complete cast route through the shared launch target", async () => {
    const route = { agent: "codex", args: ["--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ tasks: [{ task_id: "route-task", cast: { executor: route } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    try {
      await expect(resolveLaunchTarget("http://hub.test", "route-task", "executor")).resolves.toEqual({
        agent: "codex",
        args: route.args,
        cast: { executor: route },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves route args through L1 and keeps the old display wrapper", async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "tut-route-project-"));
    const user = mkdtempSync(path.join(os.tmpdir(), "tut-route-user-"));
    try {
      const dir = path.join(project, ".context-hub");
      const route = { agent: "codex", args: ["--model", "gpt-5.6", "--search"] };
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "workspace.json"), JSON.stringify({ roles: { executor: route } }));
      expect(await resolveAgentRoute("executor", undefined, { projectRoot: project, userConfigDir: user })).toEqual(route);
      expect(await resolveAgent("executor", undefined, { projectRoot: project, userConfigDir: user })).toBe(
        "codex --model gpt-5.6 --search",
      );
      const mjs = await run(process.execPath, [RESOLVER, "resolve", "executor"], {
        env: { ...process.env, TUT_PROJECT_ROOT: project, TUT_USER_CONFIG_DIR: user },
      });
      expect(mjs.stdout).toBe("codex --model gpt-5.6 --search");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  it("stores a parameterized cast and exposes it unchanged on read/list", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tut-route-store-"));
    try {
      const store = new Store(root);
      const cast = { executor: { agent: "codex", args: ["--model", "gpt-5.6", "--search"] }, reviewer: "pi" };
      const created = await store.createTask({ title: "route store", description: "desc", creator: "host", role: "human", cast });
      const read = await store.readTask(created.task_id);
      expect(read.cast).toEqual(cast);
      expect((await store.listTasks()).find((entry) => entry.task_id === created.task_id)?.cast).toEqual(cast);
      const meta = JSON.parse(readFileSync(path.join(root, "tasks", created.task_id, "meta.json"), "utf8")) as { cast: unknown };
      expect(meta.cast).toEqual(cast);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("launcher argv boundary", () => {
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
    TUT_DRY_RUN: "1",
    TUT_USER_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "tut-route-empty-")),
    ...extra,
  });

  it("passes ordered args and appends codex suppression after user -c", async () => {
    const result = await run(LAUNCHER, ["route-launch", "executor", "codex", "--model", "gpt-5.6", "--sandbox", "workspace-write", "--search", "-c", "check_for_update_on_startup=true"], { env: env() });
    expect(result.stdout).toContain("pane run <root> codex --model gpt-5.6 --sandbox workspace-write --search -c check_for_update_on_startup=true -c check_for_update_on_startup=false");
  });

  it("supports a legacy raw command string and pi suppression", async () => {
    const result = await run(LAUNCHER, ["route-launch", "executor", "pi --model fast --search"], { env: env() });
    expect(result.stdout).toContain("pane run <root> env PI_SKIP_VERSION_CHECK=1 pi --model fast --search");
  });

  it("rejects injection tokens before pane birth", async () => {
    for (const args of [
      ["route-semicolon", "executor", "codex;touch", "owned"],
      ["route-comment", "executor", "codex", "#comment"],
      ["route-history", "executor", "codex", "!history"],
    ]) {
      await expect(run(LAUNCHER, args, { env: env() })).rejects.toMatchObject({
        stderr: expect.stringContaining("invalid agent command"),
      });
    }
  });

  it("rejects empty and whitespace argv before pane birth", async () => {
    for (const args of [
      ["route-empty", "executor", "codex", ""],
      ["route-space", "executor", "codex", "   "],
    ]) {
      await expect(run(LAUNCHER, args, { env: env() })).rejects.toMatchObject({
        stderr: expect.stringContaining("invalid agent command"),
      });
    }
  });
});

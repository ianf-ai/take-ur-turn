import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  HerdrClient,
  HerdrClientError,
  resolveHerdrExecutable,
  type HerdrPane,
} from "../../../src/herdr/launcher/legacy-herdr-client.js";
import {
  requireBirthAnchor,
  resolveExecutionContext,
  resolveWorkspaceSnapshot,
  selectAnchor,
} from "../../../src/herdr/launcher/anchor.js";
import { buildLaunchInvocation, deserializeLaunchInvocation, serializeLaunchInvocation } from "../../../src/core/launcher/invocation.js";
import type { DirectSpawn } from "../../../src/herdr/launcher/process.js";
import type { ExecutionContext, LaunchRequest } from "../../../src/protocol/types.js";
import {
  readWorkspaceConfigSnapshot,
  resolveAgentRouteWithSource,
  resolveTabLabelTemplateFromSnapshot,
} from "../../../src/core/common/workspace.js";

interface SpawnedCall {
  file: string;
  args: string[];
  options?: Parameters<DirectSpawn>[2];
}

interface SpawnReply {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

function directFixture(replyFor: (args: readonly string[]) => SpawnReply): {
  calls: SpawnedCall[];
  spawnFn: DirectSpawn;
} {
  const calls: SpawnedCall[] = [];
  const spawnFn: DirectSpawn = (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const reply = replyFor(args);
    queueMicrotask(() => {
      if (reply.stdout !== undefined) child.stdout.end(reply.stdout);
      else child.stdout.end();
      if (reply.stderr !== undefined) child.stderr.end(reply.stderr);
      else child.stderr.end();
      if (reply.error !== undefined) {
        child.emit("error", reply.error);
        return;
      }
      child.emit("close", reply.code ?? 0, reply.signal ?? null);
    });
    return child;
  };
  return { calls, spawnFn };
}

function pane(overrides: Partial<HerdrPane> & Pick<HerdrPane, "pane_id">): HerdrPane {
  return { ...overrides };
}

describe("Herdr control-plane client", () => {
  it("keeps every control value as one direct argv item and normalizes responses", async () => {
    const fixture = directFixture((args) => {
      if (args[0] === "pane" && args[1] === "list") {
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                { pane_id: "p1", label: "tut-hub", tab_id: "tab1", workspace_id: "w1", cwd: path.resolve("/work"), agent_status: "idle" },
                { label: "malformed row" },
              ],
            },
          }),
        };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: JSON.stringify({ result: { tabs: [{ id: "tab1", label: "TUT executor", pane_count: 1 }] } }) };
      }
      if (args[0] === "tab" && args[1] === "create") {
        return { stdout: JSON.stringify({ result: { tab: { tab_id: "tab2" }, root_pane: { pane_id: "root2" } } }) };
      }
      if (args[0] === "pane" && args[1] === "split") {
        return { stdout: JSON.stringify({ result: { pane: { pane_id: "split2" } } }) };
      }
      if (args[0] === "pane" && args[1] === "read") return { stdout: "visible screen\n" };
      return { stdout: JSON.stringify({ result: { type: "ok" } }) };
    });
    const client = new HerdrClient({ executable: "herdr-test", env: { TEST_ENV: "yes" }, spawnFn: fixture.spawnFn });

    await expect(client.paneList()).resolves.toEqual({
      panes: [{
        pane_id: "p1",
        label: "tut-hub",
        tab_id: "tab1",
        workspace_id: "w1",
        cwd: path.resolve("/work"),
        agent_status: "idle",
      }],
    });
    await expect(client.tabList("w 1")).resolves.toEqual({ tabs: [{ tab_id: "tab1", label: "TUT executor", pane_count: 1 }] });
    await expect(client.tabCreate({
      workspaceId: "w 1",
      cwd: "/work/project with space",
      label: "TUT reviewer & 评审",
      noFocus: true,
    })).resolves.toEqual({ tabId: "tab2", rootPaneId: "root2" });
    await expect(client.paneSplit({
      current: true,
      direction: "right",
      noFocus: true,
      cwd: "/work/project with space",
    })).resolves.toEqual({ paneId: "split2" });
    await expect(client.paneMove("split2", {
      tabId: "tab2",
      split: "down",
      ratio: 0.5,
      noFocus: true,
      targetPane: "root2",
    })).resolves.toEqual({ ok: true, response: { result: { type: "ok" } } });
    await expect(client.paneRename("split2", "task.executor & 评审")).resolves.toMatchObject({ ok: true });
    await expect(client.paneRun("split2", "codex --model gpt 5 & echo done")).resolves.toMatchObject({ ok: true });
    await expect(client.paneRead("split2", { source: "visible", lines: 40 })).resolves.toBe("visible screen\n");
    await expect(client.paneSendText("split2", "轮到你了 & keep this as one arg")).resolves.toMatchObject({ ok: true });
    await expect(client.paneSendKeys("split2", "Ctrl+C", "Enter")).resolves.toMatchObject({ ok: true });
    await expect(client.paneClose("split2")).resolves.toMatchObject({ ok: true });

    expect(fixture.calls.map((call) => call.args)).toEqual([
      ["pane", "list"],
      ["tab", "list", "--workspace", "w 1"],
      ["tab", "create", "--workspace", "w 1", "--cwd", "/work/project with space", "--label", "TUT reviewer & 评审", "--no-focus"],
      ["pane", "split", "--current", "--direction", "right", "--no-focus", "--cwd", "/work/project with space"],
      ["pane", "move", "split2", "--tab", "tab2", "--split", "down", "--ratio", "0.5", "--no-focus", "--target-pane", "root2"],
      ["pane", "rename", "split2", "task.executor & 评审"],
      ["pane", "run", "split2", "codex --model gpt 5 & echo done"],
      ["pane", "read", "split2", "--source", "visible", "--lines", "40"],
      ["pane", "send-text", "split2", "轮到你了 & keep this as one arg"],
      ["pane", "send-keys", "split2", "Ctrl+C", "Enter"],
      ["pane", "close", "split2"],
    ]);
    for (const call of fixture.calls) expect(call.options?.shell).toBe(false);
    expect(fixture.calls.every((call) => call.file === "herdr-test")).toBe(true);
  });

  it("uses one stable error shape for spawn, exit, and malformed JSON failures", async () => {
    const exitFixture = directFixture(() => ({ code: 23, stderr: "permission denied\n" }));
    const exitClient = new HerdrClient({ spawnFn: exitFixture.spawnFn });
    await expect(exitClient.paneClose("p1")).rejects.toMatchObject({
      name: "HerdrClientError",
      code: "EXIT_ERROR",
      operation: "herdr pane close",
      args: ["pane", "close", "p1"],
      exitCode: 23,
      stderr: "permission denied\n",
    });

    const malformedFixture = directFixture(() => ({ stdout: "not json" }));
    const malformedClient = new HerdrClient({ spawnFn: malformedFixture.spawnFn });
    await expect(malformedClient.paneList()).rejects.toMatchObject({
      name: "HerdrClientError",
      code: "INVALID_RESPONSE",
      operation: "herdr pane list",
      args: ["pane", "list"],
    });

    const spawnFixture = directFixture(() => ({ error: new Error("ENOENT") }));
    const spawnClient = new HerdrClient({ spawnFn: spawnFixture.spawnFn });
    await expect(spawnClient.paneRead("p1")).rejects.toMatchObject({
      name: "HerdrClientError",
      code: "SPAWN_ERROR",
      operation: "herdr pane read",
    });
  });

  it("rejects shell-boundary-invalid arguments before spawning", async () => {
    const spawnFn = vi.fn<DirectSpawn>(() => {
      throw new Error("must not spawn");
    });
    const client = new HerdrClient({ spawnFn });
    expect(() => client.command(["pane", "send-text", "p1", "bad\u0000value"])).toThrowError(HerdrClientError);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("uses herdr.exe for a Windows default and honors one configured executable", async () => {
    const fixture = directFixture(() => ({ stdout: JSON.stringify({ result: { panes: [] } }) }));
    expect(resolveHerdrExecutable({ platform: "win32", env: {} })).toBe("herdr.exe");
    const defaultClient = new HerdrClient({ platform: "win32", env: { PATH: "C:\\herdr" }, spawnFn: fixture.spawnFn });
    await defaultClient.paneList();
    expect(fixture.calls[0]?.file).toBe("herdr.exe");

    const configured = new HerdrClient({
      platform: "win32",
      env: { TUT_HERDR_EXECUTABLE: "/opt/tut/herdr.exe" },
      spawnFn: fixture.spawnFn,
    });
    await configured.paneList();
    expect(fixture.calls[1]?.file).toBe("/opt/tut/herdr.exe");
    expect(fixture.calls.every((call) => call.options?.shell === false)).toBe(true);
  });
});

describe("herdr command liveness backstop", () => {
  /** A child that never closes on its own; kill() is the only way out. */
  function hungChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
    const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    (child as unknown as { kill: () => boolean }).kill = () => {
      child.emit("close", null, "SIGKILL");
      return true;
    };
    return child;
  }

  it("kills a hung control command at the default timeout and reports timedOut", async () => {
    vi.useFakeTimers();
    try {
      const client = new HerdrClient({ spawnFn: () => hungChild() });
      const pending = client.command(["pane", "list"]);
      await vi.advanceTimersByTimeAsync(10_000); // DEFAULT_HERDR_TIMEOUT_MS
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("TUT_HERDR_TIMEOUT_MS overrides the window (env escape hatch)", async () => {
    vi.useFakeTimers();
    try {
      const client = new HerdrClient({ env: { TUT_HERDR_TIMEOUT_MS: "5000" }, spawnFn: () => hungChild() });
      const pending = client.command(["pane", "list"]);
      await vi.advanceTimersByTimeAsync(4_999);
      const early = await Promise.race([pending, Promise.resolve("still-pending")]);
      expect(early).toBe("still-pending"); // window not yet exhausted
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("verb helpers surface HerdrClientError TIMEOUT — a failure return, not a hang", async () => {
    vi.useFakeTimers();
    try {
      const client = new HerdrClient({ spawnFn: () => hungChild() });
      const attempt = client.paneList();
      attempt.catch(() => undefined); // handled from the start — fake-timer flush may settle it before `rejects` attaches
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(attempt).rejects.toMatchObject({
        name: "HerdrClientError",
        code: "TIMEOUT",
        operation: "herdr pane list",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a really stopped herdr child (kill -STOP shape) is killed and settled within the window", async () => {
    // Real process, real timers: executable pointed at node, the "herdr
    // command" stops itself — SIGKILL still reaches a stopped process.
    const client = new HerdrClient({ executable: process.execPath, timeoutMs: 400 });
    const result = await client.command([
      "-e",
      process.platform === "win32" ? "setInterval(() => {}, 100);" : "process.kill(process.pid, 'SIGSTOP'); setInterval(() => {}, 100);",
    ]);
    expect(result.timedOut).toBe(true);
    expect(result.code === null || result.code !== 0).toBe(true);
  }, 10_000);
});

describe("workspace config planner snapshot", () => {
  it("freezes route and naming together so later file edits cannot split the plan", async () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), "tut-workspace-snapshot-project-"));
    const userConfigDir = mkdtempSync(path.join(os.tmpdir(), "tut-workspace-snapshot-user-"));
    try {
      mkdirSync(path.join(projectRoot, ".context-hub"), { recursive: true });
      writeFileSync(
        path.join(projectRoot, ".context-hub", "workspace.json"),
        JSON.stringify({
          roles: { executor: { agent: "codex", args: ["--model", "old"] } },
          naming: { tab_label: "OLD {task}" },
        }),
        "utf8",
      );
      writeFileSync(
        path.join(userConfigDir, "workspace.json"),
        JSON.stringify({ roles: { reviewer: { agent: "pi" } }, naming: { tab_label: "USER {role}" } }),
        "utf8",
      );

      const snapshot = await readWorkspaceConfigSnapshot({ projectRoot, userConfigDir });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.roles)).toBe(true);
      expect(Object.isFrozen(snapshot.roles[0])).toBe(true);
      expect(Object.isFrozen((snapshot.roles[0].executor as { args: string[] }).args)).toBe(true);

      writeFileSync(
        path.join(projectRoot, ".context-hub", "workspace.json"),
        JSON.stringify({ roles: { executor: { agent: "pi" } }, naming: { tab_label: "NEW {task}" } }),
        "utf8",
      );
      const route = await resolveAgentRouteWithSource("executor", undefined, { workspaceSnapshot: snapshot });
      expect(route).toEqual({ route: { agent: "codex", args: ["--model", "old"] }, source: "workspace-project" });
      expect(resolveTabLabelTemplateFromSnapshot(snapshot)).toBe("OLD {task}");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(userConfigDir, { recursive: true, force: true });
    }
  });
});

describe("Herdr anchor and execution context", () => {
  const hub = pane({ pane_id: "hub-pane", label: "tut-hub", workspace_id: "hub-workspace", cwd: path.resolve("/hub/project") });
  const notify = pane({ pane_id: "notify-pane", label: "tut-notify", workspace_id: "notify-workspace", cwd: path.resolve("/notify/project") });
  const unrelated = pane({ pane_id: "foreign-pane", label: "unrelated-project", workspace_id: "foreign-workspace", cwd: path.resolve("/foreign/project") });

  it("selects only the exact fallback chain and keeps values from one pane row", () => {
    expect(selectAnchor([unrelated, hub, notify], "foreign-pane")).toEqual({ anchor: {
      workspace_id: "hub-workspace",
      cwd: path.resolve("/hub/project"),
      pane_id: "hub-pane",
    }, source: "tut-hub" });
    expect(selectAnchor([unrelated, notify], "foreign-pane")).toEqual({ anchor: {
      workspace_id: "notify-workspace",
      cwd: path.resolve("/notify/project"),
      pane_id: "notify-pane",
    }, source: "tut-notify" });
    expect(selectAnchor([unrelated], "foreign-pane")).toEqual({ anchor: {
      workspace_id: "foreign-workspace",
      cwd: path.resolve("/foreign/project"),
      pane_id: "foreign-pane",
    }, source: "split-base" });
    expect(selectAnchor([unrelated], "missing-pane")).toBeUndefined();
    expect(selectAnchor([pane({ pane_id: "bad", label: "tut-hub", cwd: path.resolve("/half-anchor") })], "bad")).toBeUndefined();
  });

  it("captures caller cwd once, resolves routing independently, and reuses one pane-list result", async () => {
    const source = { paneList: vi.fn(async () => ({ panes: [unrelated, hub] })) };
    const snapshot = await resolveWorkspaceSnapshot({
      client: source,
      caller_cwd: path.resolve("/caller/root"),
      env: {
        TUT_PROJECT_ROOT: "routing-root",
        TUT_USER_CONFIG_DIR: path.resolve("/user/tut"),
        TUT_SPLIT_BASE: "foreign-pane",
      },
      dry_run: false,
    });

    expect(snapshot).toMatchObject({
      anchor: { workspace_id: hub.workspace_id, cwd: hub.cwd, pane_id: hub.pane_id },
      caller_cwd: path.resolve("/caller/root"),
      hubRoot: path.resolve("/hub/project"),
      routingRoot: path.resolve("/caller/root/routing-root"),
      checkoutRoot: path.resolve("/hub/project"),
      checkout: { kind: "current" },
      context: { kind: "shared" },
      source: "anchor",
    });
    expect(source.paneList).toHaveBeenCalledTimes(1);
    expect(snapshot.routingRoot).not.toBe(snapshot.hubRoot);
  });

  it("does not turn caller cwd, project root, or an unreadable list into a live anchor", async () => {
    const source = { paneList: vi.fn(async () => [unrelated]) };
    const live = await resolveExecutionContext({
      client: source,
      caller_cwd: path.resolve("/caller/root"),
      env: { TUT_PROJECT_ROOT: path.resolve("/external/routing"), TUT_SPLIT_BASE: "not-present" },
      dry_run: false,
    });
    expect(live.anchor).toBeUndefined();
    expect(live.hubRoot).toBe("<hub-root>");
    expect(live.routingRoot).toBe(path.resolve("/external/routing"));
    expect(live.checkoutRoot).toBe("<checkout-root>");
    expect(() => requireBirthAnchor(live)).toThrow("no anchor pane found");

    const broken = await resolveExecutionContext({
      client: { paneList: async () => { throw new Error("herdr unavailable"); } },
      caller_cwd: path.resolve("/caller/root"),
      env: { TUT_PROJECT_ROOT: path.resolve("/external/routing") },
      dry_run: false,
    });
    expect(broken.anchor).toBeUndefined();
    expect(broken.routingRoot).toBe(path.resolve("/external/routing"));

    const unparseable = await resolveExecutionContext({
      client: { paneList: async () => ({ panes: "not an array" } as never) },
      caller_cwd: path.resolve("/caller/root"),
      env: {},
      dry_run: false,
    });
    expect(unparseable.anchor).toBeUndefined();
  });

  it("uses a placeholder only for dry-run discovery and preserves caller cwd through invocation transport", async () => {
    const snapshot = await resolveWorkspaceSnapshot({
      client: { paneList: async () => [] },
      caller_cwd: path.resolve("/caller/root"),
      env: { TUT_PROJECT_ROOT: "routes" },
      dry_run: true,
    });
    expect(snapshot).toMatchObject({
      anchor: { workspace_id: "<workspace>", cwd: "<cwd>", pane_id: "<anchor>" },
      caller_cwd: path.resolve("/caller/root"),
      hubRoot: "<hub-root>",
      routingRoot: path.resolve("/caller/root/routes"),
      checkoutRoot: "<checkout-root>",
      source: "placeholder",
    });
    expect(() => requireBirthAnchor(snapshot)).toThrow("no anchor pane found");

    const request: LaunchRequest = { kind: "round", task_id: "t1", role: "executor", fresh: false, via: "start-next" };
    const invocation = buildLaunchInvocation({
      request,
      base_version: 1,
      hub_url: "http://127.0.0.1:3001",
      route: "pi",
      route_source: "builtin-default",
      context: snapshot,
      naming: { tab_label: "TUT executor", pane_label: "t1.executor" },
      prompt: "doorbell",
      posix_direct: { executable: "pi", args: [], env: {} },
    });
    expect(deserializeLaunchInvocation(serializeLaunchInvocation(invocation)).context.caller_cwd).toBe(path.resolve("/caller/root"));
  });

  it("supports the listPanes compatibility name and resolves it once", async () => {
    const listPanes = vi.fn(async () => ({ panes: [notify] }));
    const context = await resolveExecutionContext({ client: { listPanes } });
    expect(context.anchor).toEqual({ workspace_id: notify.workspace_id, cwd: notify.cwd, pane_id: notify.pane_id });
    expect(listPanes).toHaveBeenCalledTimes(1);
  });
});

describe("manual and automatic launch owning intent", () => {
  it.each(["current", "worktree"] as const)("freezes the same rig route/display and refuses corrupt rig config for %s", async kind => {
    const { TuiLane } = await import("../../../src/herdr/notifier/tui-lane.js");
    const { rigLabel } = await import("../../../src/hub/rig-identity.js");
    const { runStartNextTui } = await import("../../../src/herdr/launcher/start-next.js");
    const target = await import("../../../src/core/launcher/target-resolver.js");
    const launch = await import("../../../src/core/launcher/launch.js");
    const child = await import("../../../src/herdr/launcher/process.js");
    const base = mkdtempSync(path.join(os.tmpdir(), "tut-owning-intent-"));
    const rigRoot = path.join(base, "rig"), foreignRoot = path.join(base, "foreign"), checkoutRoot = path.join(base, "checkout");
    const cwd = process.cwd();
    const ownFile = path.join(rigRoot, ".context-hub", "config.json");
    for (const root of [rigRoot, foreignRoot, checkoutRoot]) mkdirSync(path.join(root, ".context-hub"), { recursive: true });
    const own = { flow_mode: "manual", roles: { executor: { agent: "pi", args: ["--model", "one", "--model", "two"] } }, naming: { tab_label: "RIG {role} {agent}" } };
    writeFileSync(ownFile, JSON.stringify(own));
    writeFileSync(path.join(foreignRoot, ".context-hub", "config.json"), JSON.stringify({ flow_mode: "manual", roles: { executor: { agent: "codex", args: ["--model", "foreign"] } }, naming: { tab_label: "FOREIGN" } }));
    writeFileSync(path.join(foreignRoot, ".context-hub", "workspace.json"), JSON.stringify({ roles: { executor: { agent: "legacy" } } }));
    vi.stubEnv("TUT_HUB_ROOT", rigRoot);
    vi.stubEnv("TUT_PROJECT_ROOT", foreignRoot);
    vi.stubEnv("TUT_USER_CONFIG_DIR", path.join(base, "absent-user"));
    vi.stubEnv("TUT_EVENT_PORT_URL", "http://127.0.0.1:1/agent-event");
    const panes = [{ pane_id: "fixture-anchor", label: rigLabel("tut-hub", rigRoot), workspace_id: "fixture", cwd: rigRoot }];
    vi.spyOn(HerdrClient.prototype, "paneList").mockResolvedValue({ panes });
    const proof = vi.spyOn(target, "resolvePlatformExecutionPlan").mockImplementation(async route => ({ platform: "posix", posix_direct: { executable: route.agent, args: route.args, env: {} } }));
    vi.spyOn(launch, "readLaunchLog").mockResolvedValue([]);
    const manualMark = vi.spyOn(launch, "markLaunched").mockResolvedValue({ task_id: "intent-fixture", version: 1 });
    const manualSpawn = vi.spyOn(child, "runInternalLaunchInvocation").mockResolvedValue({ code: 0, signal: null, stdout: "", stderr: "" });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const autoMark = vi.fn(async () => ({ version: 1 }));
    const autoSpawn = vi.fn(async (_invocation: import("../../../src/protocol/types.js").LaunchInvocation) => "planned");
    const failed = vi.fn(async (..._args: unknown[]) => {});
    const task: import("../../../src/core/notifier/shared-contracts.js").StateTask = {
      task_id: "intent-fixture", title: "fixture", status: "implementing", waiting_for: "agent:executor", needs_attention: false, updated_at: "2026-11-01T00:00:00Z", version: 0, flow: "direct",
      checkout: kind === "current" ? { kind: "current" } : { kind: "worktree", path: checkoutRoot },
    };
    const lane = new TuiLane({ url: "http://127.0.0.1:1", interval: 5, eventPort: 1, stallTimeoutMin: 30 }, rigRoot, {
      snapshot: new Map([[task.task_id, task]]), log: () => {}, sendAll: async () => {}, fullLog: async () => [], autoLaunchFailed: failed,
      autoLaunchSkipped: async () => {}, deferNoteWake: () => {}, requestCompare: async () => {}, markProgress: () => {},
    }, {
      now: () => 0, fetchState: async () => ({ flow_mode: "auto", tasks: [task] }), markLaunched: autoMark,
      launch: async () => { throw new Error("unexpected legacy launch"); }, launchInvocation: autoSpawn, cleanupPanes: async () => {},
      listAnchorPanes: async () => panes,
      resolveTargetWithSource: async (_id, role, _root, snapshot) => {
        const resolved = await resolveAgentRouteWithSource(role, task.cast, { workspaceSnapshot: snapshot! });
        const route = typeof resolved.route === "string" ? { agent: resolved.route, args: [] } : resolved.route;
        return { ...resolved, plan: { platform: "posix", posix_direct: { executable: route.agent, args: route.args, env: {} } } };
      },
    }, async () => "tui");
    try {
      process.chdir(foreignRoot);
      expect(await runStartNextTui({ url: "http://127.0.0.1:1", force: false }, task, { kind: "round", task_id: task.task_id, role: "executor", fresh: false, via: "start-next" })).toBe(0);
      await lane.launch(task, "executor", 0);
      expect(failed).not.toHaveBeenCalled();
      const manual = manualSpawn.mock.calls[0]![0], auto = autoSpawn.mock.calls[0]![0];
      expect(manual.route).toEqual(own.roles.executor);
      expect(auto.route).toEqual(manual.route);
      expect(auto.naming).toEqual(manual.naming);
      expect(auto.naming.tab_label).toBe("RIG executor pi");
      expect(auto.context.checkoutRoot).toBe(kind === "current" ? rigRoot : checkoutRoot);
      expect(auto.marker_projection?.route_source).toBe("config-project");
      expect(manualMark).toHaveBeenCalledTimes(1);
      expect(autoMark).toHaveBeenCalledTimes(1);
      proof.mockClear(); manualMark.mockClear(); manualSpawn.mockClear(); autoMark.mockClear(); autoSpawn.mockClear();
      // Corruption after a candidate was selected must still stop planning before proof/marker/spawn.
      writeFileSync(ownFile, "{broken");
      task.cast = { executor: "codex" };
      expect(await runStartNextTui({ url: "http://127.0.0.1:1", force: false }, task, { kind: "round", task_id: task.task_id, role: "executor", fresh: false, via: "start-next" })).toBe(1);
      await lane.launch(task, "executor", 0);
      expect(errors.mock.calls.map(call => String(call[0])).join("\n")).toContain("unreadable or corrupt");
      expect(failed).toHaveBeenCalledTimes(1);
      expect(String(failed.mock.calls[0]![2])).toContain("unreadable or corrupt");
      expect(proof).not.toHaveBeenCalled();
      expect(manualMark).not.toHaveBeenCalled(); expect(autoMark).not.toHaveBeenCalled();
      expect(manualSpawn).not.toHaveBeenCalled(); expect(autoSpawn).not.toHaveBeenCalled();
    } finally {
      lane.close(); process.chdir(cwd); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true });
    }
  });
});

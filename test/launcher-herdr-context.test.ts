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
} from "../src/launcher/herdr-client.js";
import {
  requireBirthAnchor,
  resolveExecutionContext,
  resolveWorkspaceSnapshot,
  selectAnchor,
} from "../src/launcher/anchor.js";
import { buildLaunchInvocation, deserializeLaunchInvocation, serializeLaunchInvocation } from "../src/launcher/invocation.js";
import type { DirectSpawn } from "../src/launcher/process.js";
import type { ExecutionContext, LaunchRequest } from "../src/types.js";
import {
  readWorkspaceConfigSnapshot,
  resolveAgentRouteWithSource,
  resolveTabLabelTemplateFromSnapshot,
} from "../src/workspace.js";

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
                { pane_id: "p1", label: "tut-hub", tab_id: "tab1", workspace_id: "w1", cwd: "/work", agent_status: "idle" },
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
        cwd: "/work",
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
  const hub = pane({ pane_id: "hub-pane", label: "tut-hub", workspace_id: "hub-workspace", cwd: "/hub/project" });
  const notify = pane({ pane_id: "notify-pane", label: "tut-notify", workspace_id: "notify-workspace", cwd: "/notify/project" });
  const unrelated = pane({ pane_id: "foreign-pane", label: "unrelated-project", workspace_id: "foreign-workspace", cwd: "/foreign/project" });

  it("selects only the exact fallback chain and keeps values from one pane row", () => {
    expect(selectAnchor([unrelated, hub, notify], "foreign-pane")).toEqual({ anchor: {
      workspace_id: "hub-workspace",
      cwd: "/hub/project",
      pane_id: "hub-pane",
    }, source: "tut-hub" });
    expect(selectAnchor([unrelated, notify], "foreign-pane")).toEqual({ anchor: {
      workspace_id: "notify-workspace",
      cwd: "/notify/project",
      pane_id: "notify-pane",
    }, source: "tut-notify" });
    expect(selectAnchor([unrelated], "foreign-pane")).toEqual({ anchor: {
      workspace_id: "foreign-workspace",
      cwd: "/foreign/project",
      pane_id: "foreign-pane",
    }, source: "split-base" });
    expect(selectAnchor([unrelated], "missing-pane")).toBeUndefined();
    expect(selectAnchor([pane({ pane_id: "bad", label: "tut-hub", cwd: "/half-anchor" })], "bad")).toBeUndefined();
  });

  it("captures caller cwd once, resolves routing independently, and reuses one pane-list result", async () => {
    const source = { paneList: vi.fn(async () => ({ panes: [unrelated, hub] })) };
    const snapshot = await resolveWorkspaceSnapshot({
      client: source,
      caller_cwd: "/caller/root",
      env: {
        TUT_PROJECT_ROOT: "routing-root",
        TUT_USER_CONFIG_DIR: "/user/tut",
        TUT_SPLIT_BASE: "foreign-pane",
      },
      dry_run: false,
    });

    expect(snapshot).toMatchObject({
      anchor: { workspace_id: hub.workspace_id, cwd: hub.cwd, pane_id: hub.pane_id },
      caller_cwd: "/caller/root",
      hubRoot: "/hub/project",
      routingRoot: "/caller/root/routing-root",
      checkoutRoot: "/hub/project",
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
      caller_cwd: "/caller/root",
      env: { TUT_PROJECT_ROOT: "/external/routing", TUT_SPLIT_BASE: "not-present" },
      dry_run: false,
    });
    expect(live.anchor).toBeUndefined();
    expect(live.hubRoot).toBe("<hub-root>");
    expect(live.routingRoot).toBe("/external/routing");
    expect(live.checkoutRoot).toBe("<checkout-root>");
    expect(() => requireBirthAnchor(live)).toThrow("no anchor pane found");

    const broken = await resolveExecutionContext({
      client: { paneList: async () => { throw new Error("herdr unavailable"); } },
      caller_cwd: "/caller/root",
      env: { TUT_PROJECT_ROOT: "/external/routing" },
      dry_run: false,
    });
    expect(broken.anchor).toBeUndefined();
    expect(broken.routingRoot).toBe("/external/routing");

    const unparseable = await resolveExecutionContext({
      client: { paneList: async () => ({ panes: "not an array" } as never) },
      caller_cwd: "/caller/root",
      env: {},
      dry_run: false,
    });
    expect(unparseable.anchor).toBeUndefined();
  });

  it("uses a placeholder only for dry-run discovery and preserves caller cwd through invocation transport", async () => {
    const snapshot = await resolveWorkspaceSnapshot({
      client: { paneList: async () => [] },
      caller_cwd: "/caller/root",
      env: { TUT_PROJECT_ROOT: "routes" },
      dry_run: true,
    });
    expect(snapshot).toMatchObject({
      anchor: { workspace_id: "<workspace>", cwd: "<cwd>", pane_id: "<anchor>" },
      caller_cwd: "/caller/root",
      hubRoot: "<hub-root>",
      routingRoot: "/caller/root/routes",
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
    expect(deserializeLaunchInvocation(serializeLaunchInvocation(invocation)).context.caller_cwd).toBe("/caller/root");
  });

  it("supports the listPanes compatibility name and resolves it once", async () => {
    const listPanes = vi.fn(async () => ({ panes: [notify] }));
    const context = await resolveExecutionContext({ client: { listPanes } });
    expect(context.anchor).toEqual({ workspace_id: notify.workspace_id, cwd: notify.cwd, pane_id: notify.pane_id });
    expect(listPanes).toHaveBeenCalledTimes(1);
  });
});

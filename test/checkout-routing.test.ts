import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveExecutionContext } from "../src/launcher/anchor.js";
import { buildLaunchInvocation, serializeLaunchInvocation, validateLaunchInvocation } from "../src/launcher/invocation.js";
import { Store } from "../src/store.js";
import { readWorkspaceConfigSnapshot, resolveAgentRouteWithSource, resolveTabLabelTemplateFromSnapshot } from "../src/workspace.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeWorkspace(root: string, body: unknown): void {
  const dir = path.join(root, ".context-hub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "workspace.json"), `${JSON.stringify(body)}\n`, "utf8");
}

const paneSource = {
  paneList: async () => ({
    panes: [{
      pane_id: "w1:p0",
      label: "tut-hub",
      workspace_id: "w1",
      cwd: "/hub/project",
      agent_status: "idle",
    }],
  }),
};

describe("task checkout metadata and execution routing", () => {
  it("freezes a worktree route in meta and exposes it through read/list", async () => {
    const root = tempRoot("tut-checkout-store-");
    const store = new Store(root);
    const checkout = { kind: "worktree" as const, path: "/worktrees/task-a", ref: "task-a" };
    const created = await store.createTask({
      title: "Checkout Task",
      description: "d",
      creator: "host",
      role: "human",
      flow: "direct",
      checkout,
    });

    const onDisk = JSON.parse(readFileSync(path.join(root, "tasks", created.task_id, "meta.json"), "utf8")) as { checkout?: unknown };
    expect(onDisk.checkout).toEqual(checkout);
    expect((await store.readTask(created.task_id)).checkout).toEqual(checkout);
    expect((await store.listTasks()).find((entry) => entry.task_id === created.task_id)?.checkout).toEqual(checkout);
  });

  it("rejects an empty worktree route before creating a task directory", async () => {
    const root = tempRoot("tut-checkout-invalid-");
    const store = new Store(root);
    await expect(store.createTask({
      title: "Invalid Checkout",
      description: "d",
      creator: "host",
      role: "human",
      checkout: { kind: "worktree" },
    })).rejects.toThrow(/requires a path; ref alone is not accepted/u);
    expect(existsSync(path.join(root, "tasks", "invalid-checkout"))).toBe(false);
  });

  it("rejects a ref-only worktree route — it could never launch", async () => {
    const root = tempRoot("tut-checkout-refonly-");
    const store = new Store(root);
    await expect(store.createTask({
      title: "Ref Only",
      description: "d",
      creator: "host",
      role: "human",
      checkout: { kind: "worktree", ref: "task-a" },
    })).rejects.toThrow(/requires a path; ref alone is not accepted/u);
    // A ref next to a path stays accepted: annotation, not a substitute.
    const created = await store.createTask({
      title: "Path With Ref",
      description: "d",
      creator: "host",
      role: "human",
      checkout: { kind: "worktree", path: "/worktrees/a", ref: "task-a" },
    });
    expect((await store.readTask(created.task_id)).checkout).toEqual({ kind: "worktree", path: "/worktrees/a", ref: "task-a" });
  });

  it("routes two direct tasks concurrently to separate checkout roots with one shared Hub root", async () => {
    const root = tempRoot("tut-checkout-parallel-");
    const store = new Store(root);
    const [taskA, taskB] = await Promise.all([
      store.createTask({ title: "Parallel A", description: "d", creator: "host", role: "human", flow: "direct", checkout: { kind: "worktree", path: "/worktrees/a" } }),
      store.createTask({ title: "Parallel B", description: "d", creator: "host", role: "human", flow: "direct", checkout: { kind: "worktree", path: "/worktrees/b" } }),
    ]);
    const [metaA, metaB] = await Promise.all([
      store.readTask(taskA.task_id),
      store.readTask(taskB.task_id),
    ]);
    const [contextA, contextB] = await Promise.all([
      resolveExecutionContext({ client: paneSource, caller_cwd: "/caller", env: {}, dry_run: false, ...(metaA.checkout !== undefined ? { checkout: metaA.checkout } : {}) }),
      resolveExecutionContext({ client: paneSource, caller_cwd: "/caller", env: {}, dry_run: false, ...(metaB.checkout !== undefined ? { checkout: metaB.checkout } : {}) }),
    ]);

    expect(contextA.hubRoot).toBe("/hub/project");
    expect(contextB.hubRoot).toBe("/hub/project");
    expect(contextA.checkoutRoot).toBe("/worktrees/a");
    expect(contextB.checkoutRoot).toBe("/worktrees/b");
    expect(contextA.checkoutRoot).not.toBe(contextB.checkoutRoot);
    expect(contextA.checkout).toEqual(metaA.checkout);
    expect(contextB.checkout).toEqual(metaB.checkout);
  });

  it("keeps a worktree route in the private child invocation and changes no marker fields", async () => {
    const context = await resolveExecutionContext({
      client: paneSource,
      caller_cwd: "/caller",
      env: {},
      dry_run: false,
      checkout: { kind: "worktree", path: "/worktrees/a" },
    });
    const invocation = buildLaunchInvocation({
      request: { kind: "round", task_id: "task-a", role: "executor", fresh: false, via: "start-next" },
      base_version: 0,
      hub_url: "http://127.0.0.1:3001",
      route: "node",
      route_source: "builtin-default",
      context,
      prompt: "work",
      posix_direct: { executable: "node", args: [], env: {} },
    });
    const roundTrip = validateLaunchInvocation(JSON.parse(serializeLaunchInvocation(invocation)));
    expect(roundTrip.context.checkout).toEqual({ kind: "worktree", path: "/worktrees/a" });
    expect(roundTrip.marker_projection).not.toHaveProperty("checkoutRoot");
    expect(roundTrip.marker_projection).not.toHaveProperty("hubRoot");
  });
});

describe("workspace L1 fallback from a worktree to the shared Hub root", () => {
  it("uses Hub-root workspace declarations when the checkout has no L1 file", async () => {
    const hubRoot = tempRoot("tut-checkout-hub-");
    const worktreeRoot = tempRoot("tut-checkout-worktree-");
    const userRoot = tempRoot("tut-checkout-user-");
    writeWorkspace(hubRoot, {
      roles: { executor: { agent: "hub-executor" } },
      naming: { tab_label: "Hub {role}" },
    });

    const snapshot = await readWorkspaceConfigSnapshot({
      projectRoot: worktreeRoot,
      fallbackProjectRoot: hubRoot,
      userConfigDir: userRoot,
    });
    expect((await resolveAgentRouteWithSource("executor", undefined, { workspaceSnapshot: snapshot })).route).toBe("hub-executor");
    expect(resolveTabLabelTemplateFromSnapshot(snapshot)).toBe("Hub {role}");
  });

  it("lets a checkout-local L1 declaration override the Hub fallback per field", async () => {
    const hubRoot = tempRoot("tut-checkout-hub-override-");
    const worktreeRoot = tempRoot("tut-checkout-worktree-override-");
    const userRoot = tempRoot("tut-checkout-user-override-");
    writeWorkspace(hubRoot, {
      roles: { architect: { agent: "hub-architect" }, executor: { agent: "hub-executor" } },
      naming: { tab_label: "Hub {role}" },
    });
    writeWorkspace(worktreeRoot, {
      roles: { executor: { agent: "worktree-executor" } },
    });

    const snapshot = await readWorkspaceConfigSnapshot({
      projectRoot: worktreeRoot,
      fallbackProjectRoot: hubRoot,
      userConfigDir: userRoot,
    });
    expect((await resolveAgentRouteWithSource("executor", undefined, { workspaceSnapshot: snapshot })).route).toBe("worktree-executor");
    expect((await resolveAgentRouteWithSource("architect", undefined, { workspaceSnapshot: snapshot })).route).toBe("hub-architect");
    expect(resolveTabLabelTemplateFromSnapshot(snapshot)).toBe("Hub {role}");
  });
});

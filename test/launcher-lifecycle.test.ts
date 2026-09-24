import { describe, expect, it, vi } from "vitest";
import type { LaunchInvocation } from "../src/common/types.js";
import type { HerdrCommandResult, HerdrPane } from "../src/launcher/legacy-herdr-client.js";
import { birthPane } from "../src/launcher/birth.js";
import {
  cleanupTaskPanes,
  planReap,
  planRoundLifecycle,
  runRoundLifecycle,
  taskPaneLabel,
  type LifecycleClient,
} from "../src/launcher/lifecycle.js";

const anchor = { workspace_id: "w1", cwd: "/repo", pane_id: "w1:p1" };

function pane(pane_id: string, label: string, agent_status?: string, tab_id = "w1:t1"): HerdrPane {
  return {
    pane_id,
    label,
    workspace_id: "w1",
    cwd: "/repo",
    tab_id,
    ...(agent_status === undefined ? {} : { agent_status }),
  };
}

function invocation(role: string, fresh = false, pane_label = taskPaneLabel("t1", role)): Pick<LaunchInvocation, "task_id" | "role" | "fresh" | "naming"> {
  return {
    task_id: "t1",
    role,
    fresh,
    naming: { tab_label: `TUT ${role}`, pane_label },
  };
}

function result(stdout = "", code = 0): HerdrCommandResult {
  return { code, signal: null, stdout, stderr: "" };
}

function lifecycleFixture(initial: HerdrPane[]): {
  client: LifecycleClient;
  panes: HerdrPane[];
  closed: string[];
  lists: () => number;
} {
  const panes = [...initial];
  const closed: string[] = [];
  let lists = 0;
  return {
    panes,
    closed,
    lists: () => lists,
    client: {
      listPanes: async () => {
        lists += 1;
        return { panes: [...panes], usable: true };
      },
      closePane: async (paneId) => {
        closed.push(paneId);
        const index = panes.findIndex((item) => item.pane_id === paneId);
        if (index >= 0) panes.splice(index, 1);
        return result();
      },
    },
  };
}

describe("launcher lifecycle policy", () => {
  it("a turn-complete (done) seat continues — the agent process is alive and waiting for the next prompt", async () => {
    // F1 live evidence: pi reports agent_status=done the moment it finishes a
    // turn while its node.exe stays in the foreground process group. The
    // hand-off to the next same-role round happens exactly then, so a "done"
    // seat is the canonical continuation target, not a corpse.
    const fixture = lifecycleFixture([pane("p6", "t1.executor", "done")]);
    const onContinuation = vi.fn(async () => true);
    const onBirth = vi.fn(async () => "new-pane");

    const outcome = await runRoundLifecycle({
      invocation: invocation("executor"),
      client: fixture.client,
      onContinuation,
      onBirth,
    });

    expect(outcome.kind).toBe("continuation");
    expect(outcome.pane_id).toBe("p6");
    expect(onBirth).not.toHaveBeenCalled();
    expect(fixture.closed).toEqual([]);
    expect(
      planRoundLifecycle(fixture.panes, { task_id: "t1", role: "executor", fresh: false }),
    ).toMatchObject({ branch: "continuation", continuation: { pane_id: "p6" } });
  });

  it("planReap protects done continuity seats and still closes done non-continuity panes", () => {
    const planned = planReap(
      [
        pane("arch-done", "t1.architect", "done"),
        pane("exec-done", "t1.executor", "done"),
      ],
      { task_id: "t1", continuityRoles: new Set(["executor", "reviewer"]) },
    );

    expect(planned.keptContinuity.map((item) => item.pane_id)).toEqual(["exec-done"]);
    expect(planned.close.map((item) => item.pane_id)).toEqual(["arch-done"]);
  });

  it("same-role continuation is the full branch: one exact live key, no reap or birth", async () => {
    const fixture = lifecycleFixture([pane("p6", "t1.executor", "working")]);
    const onContinuation = vi.fn(async () => true);
    const onBirth = vi.fn(async () => "new-pane");
    const stderr: string[] = [];

    const outcome = await runRoundLifecycle({
      invocation: invocation("executor"),
      client: fixture.client,
      onContinuation,
      onBirth,
      stderr: (text) => stderr.push(text),
    });

    expect(outcome.kind).toBe("continuation");
    expect(outcome.pane_id).toBe("p6");
    expect(onContinuation).toHaveBeenCalledWith(expect.objectContaining({ pane_id: "p6" }));
    expect(onBirth).not.toHaveBeenCalled();
    expect(fixture.closed).toEqual([]);
    expect(stderr.join(" ")).toContain("same-role continuation");
    expect(planRoundLifecycle(fixture.panes, {
      task_id: "t1",
      role: "executor",
      fresh: false,
    })).toMatchObject({ branch: "continuation", continuation: { pane_id: "p6" } });
  });

  it("role change uses narrowed reap: corpses close, continuity seats remain, working seats are skipped", async () => {
    const fixture = lifecycleFixture([
      pane("architect", "t1.architect", "idle"),
      pane("executor", "t1.executor", "working"),
      pane("dead", "t1.reviewer", "unknown"),
    ]);
    const stderr: string[] = [];
    const outcome = await runRoundLifecycle({
      invocation: invocation("reviewer"),
      client: fixture.client,
      onContinuation: vi.fn(async () => true),
      onBirth: vi.fn(async () => "new-reviewer"),
      stderr: (text) => stderr.push(text),
    });

    expect(outcome).toMatchObject({ kind: "birth", pane_id: "new-reviewer" });
    expect(fixture.closed).toEqual(["architect", "dead"]);
    expect(stderr.join(" ")).toContain("t1.executor");
    expect(stderr.join(" ")).toContain("still working");
  });

  it("working survivor triggers the unique addressing-key guard instead of a second birth", async () => {
    const fixture = lifecycleFixture([pane("p6", "t1.executor", "working")]);
    const onBirth = vi.fn(async () => "should-not-exist");
    const stderr: string[] = [];
    const outcome = await runRoundLifecycle({
      invocation: invocation("executor"),
      client: fixture.client,
      continuityRoles: "",
      onContinuation: vi.fn(async () => true),
      onBirth,
      stderr: (text) => stderr.push(text),
    });

    expect(outcome.kind).toBe("duplicate");
    expect(onBirth).not.toHaveBeenCalled();
    expect(fixture.closed).toEqual([]);
    expect(stderr.join(" ")).toContain("refusing to birth a second pane under the same label");
  });

  it("rejects a pane label that is not the exact task_id.role addressing key before discovery", async () => {
    const listPanes = vi.fn(async () => ({ panes: [], usable: true }));
    const onBirth = vi.fn(async () => "should-not-exist");
    const outcome = await runRoundLifecycle({
      invocation: invocation("executor", false, "TUT executor"),
      client: { listPanes, closePane: vi.fn(async () => result()) },
      onContinuation: vi.fn(async () => true),
      onBirth,
    });

    expect(outcome.kind).toBe("failed");
    expect(listPanes).not.toHaveBeenCalled();
    expect(onBirth).not.toHaveBeenCalled();
  });

  it("--fresh force-closes the exact role namespace, including working panes, before birth", async () => {
    const fixture = lifecycleFixture([
      pane("old-idle", "t1.executor", "idle"),
      pane("old-working", "t1.executor", "working"),
      pane("other", "t1.reviewer", "idle"),
    ]);
    const outcome = await runRoundLifecycle({
      invocation: invocation("executor", true),
      client: fixture.client,
      onContinuation: vi.fn(async () => true),
      onBirth: vi.fn(async () => "fresh-pane"),
    });

    expect(outcome).toMatchObject({ kind: "birth", pane_id: "fresh-pane" });
    expect(fixture.closed).toEqual(["old-idle", "old-working"]);
    expect(fixture.panes.map((item) => item.pane_id)).toEqual(["other"]);
  });

  it("planReap keeps task-prefix hygiene and classifies working, continuity, and dead panes", () => {
    const planned = planReap(
      [
        pane("work", "t1.architect", "working"),
        pane("keep", "t1.executor", "blocked"),
        pane("dead", "t1.reviewer", "unknown"),
        pane("foreign", "t10.executor", "idle"),
      ],
      { task_id: "t1", continuityRoles: new Set(["executor", "reviewer"]) },
    );

    expect(planned.working.map((item) => item.pane_id)).toEqual(["work"]);
    expect(planned.keptContinuity.map((item) => item.pane_id)).toEqual(["keep"]);
    expect(planned.close.map((item) => item.pane_id)).toEqual(["dead"]);
  });

  it("cleanup is unconditional and best effort across working and continuity panes", async () => {
    const fixture = lifecycleFixture([
      pane("working", "t1.executor", "working"),
      pane("idle", "t1.reviewer", "idle"),
      pane("foreign", "t2.executor", "idle"),
    ]);
    await cleanupTaskPanes({ task_id: "t1", client: fixture.client });
    expect(fixture.closed).toEqual(["working", "idle"]);
  });

  it("cleanup warns when pane inventory rejects and leaves exit handling to the caller", async () => {
    const stderr: string[] = [];
    const closePane = vi.fn(async () => result());
    const client: LifecycleClient = {
      listPanes: async () => {
        throw new Error("herdr not found");
      },
      closePane,
    };

    await cleanupTaskPanes({ task_id: "t1", client, stderr: (text) => stderr.push(text) });

    expect(closePane).not.toHaveBeenCalled();
    expect(stderr.join(" ")).toContain("pane list failed: herdr not found");
    expect(stderr.join(" ")).toContain("no panes were closed");
    expect(stderr.join(" ")).toContain("retry cleanup");
  });

  it("cleanup warns when pane inventory is explicitly unusable", async () => {
    const stderr: string[] = [];
    const closePane = vi.fn(async () => result());
    const client: LifecycleClient = {
      listPanes: async () => ({ panes: [], usable: false, error: "unparseable pane list" }),
      closePane,
    };

    await cleanupTaskPanes({ task_id: "t1", client, stderr: (text) => stderr.push(text) });

    expect(closePane).not.toHaveBeenCalled();
    expect(stderr.join(" ")).toContain("pane list failed: unparseable pane list");
    expect(stderr.join(" ")).toContain("no panes were closed");
  });
});


describe("zero-mutation pane lists are merged (spawn count)", () => {
  it("a plain birth with nothing to close performs ONE full pane list (was three)", async () => {
    const fixture = lifecycleFixture([pane("foreign", "t2.executor", "idle")]);
    const outcome = await runRoundLifecycle({
      invocation: invocation("executor"),
      client: fixture.client,
      onContinuation: vi.fn(async () => true),
      onBirth: vi.fn(async () => "new-pane"),
    });
    expect(outcome).toMatchObject({ kind: "birth", pane_id: "new-pane" });
    expect(fixture.lists()).toBe(1); // continuation check serves reap AND survivor verify
  });

  it("a role-change reap that closes panes re-lists once for the survivor check (two total, was three)", async () => {
    const fixture = lifecycleFixture([
      pane("architect", "t1.architect", "idle"),
      pane("executor", "t1.executor", "working"),
      pane("dead", "t1.reviewer", "unknown"),
    ]);
    const outcome = await runRoundLifecycle({
      invocation: invocation("reviewer"),
      client: fixture.client,
      onContinuation: vi.fn(async () => true),
      onBirth: vi.fn(async () => "new-reviewer"),
    });
    expect(outcome).toMatchObject({ kind: "birth", pane_id: "new-reviewer" });
    expect(fixture.closed).toEqual(["architect", "dead"]);
    expect(fixture.lists()).toBe(2); // fresh discovery + post-close verification
  });

  it("--fresh (live) lists twice: forced close, then reap on the post-close state (was three)", async () => {
    const fixture = lifecycleFixture([
      pane("old-idle", "t1.executor", "idle"),
      pane("old-working", "t1.executor", "working"),
      pane("other", "t1.reviewer", "idle"),
    ]);
    const outcome = await runRoundLifecycle({
      invocation: invocation("executor", true),
      client: fixture.client,
      onContinuation: vi.fn(async () => true),
      onBirth: vi.fn(async () => "fresh-pane"),
    });
    expect(outcome).toMatchObject({ kind: "birth", pane_id: "fresh-pane" });
    expect(fixture.closed).toEqual(["old-idle", "old-working"]);
    expect(fixture.lists()).toBe(2);
  });

  it("--fresh dry-run closes nothing, so every phase reuses ONE list (was two)", async () => {
    const fixture = lifecycleFixture([pane("old-idle", "t1.executor", "idle")]);
    const outcome = await runRoundLifecycle({
      invocation: invocation("executor", true),
      client: fixture.client,
      dryRun: true,
      onContinuation: vi.fn(async () => true),
      onBirth: vi.fn(async () => "fresh-pane"),
    });
    expect(outcome).toMatchObject({ kind: "birth", pane_id: "fresh-pane" });
    expect(fixture.closed).toEqual([]);
    expect(fixture.lists()).toBe(1);
  });

  it("the addressing-key guard reads the reused snapshot — one list, no birth", async () => {
    const fixture = lifecycleFixture([pane("p6", "t1.executor", "working")]);
    const onBirth = vi.fn(async () => "should-not-exist");
    const outcome = await runRoundLifecycle({
      invocation: invocation("executor"),
      client: fixture.client,
      continuityRoles: "",
      onContinuation: vi.fn(async () => true),
      onBirth,
    });
    expect(outcome.kind).toBe("duplicate");
    expect(onBirth).not.toHaveBeenCalled();
    expect(fixture.lists()).toBe(1);
  });

  it("an unusable snapshot never serves reuse — each phase retries fresh", async () => {
    let calls = 0;
    const client: LifecycleClient = {
      listPanes: async () => {
        calls += 1;
        return calls === 1
          ? { panes: [], usable: false, error: "transient" }
          : { panes: [], usable: true };
      },
      closePane: vi.fn(async () => result()),
    };
    const outcome = await runRoundLifecycle({
      invocation: invocation("executor"),
      client,
      onContinuation: vi.fn(async () => true),
      onBirth: vi.fn(async () => "new-pane"),
    });
    expect(outcome).toMatchObject({ kind: "birth", pane_id: "new-pane" });
    expect(calls).toBeGreaterThanOrEqual(2); // the dead snapshot was not cached as truth
  });
});

describe("launcher pane birth", () => {
  it("adopts the tab-create root through direct argv and does not split the anchor", async () => {
    const calls: string[][] = [];
    const client = {
      command: vi.fn(async (args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === "tab" && args[1] === "create") {
          return result(JSON.stringify({ result: {
            root_pane: { pane_id: "root1" },
            tab: { tab_id: "tab1", label: "TUT executor" },
          } }));
        }
        return result();
      }),
    };

    await expect(birthPane({
      client,
      anchor,
      birthCwd: "/repo",
      tabLabel: "TUT executor",
      paneLabel: "t1.executor",
      commandText: "env PI_SKIP_VERSION_CHECK=1 pi",
    })).resolves.toBe("root1");

    expect(calls).toEqual([
      ["tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "TUT executor", "--no-focus"],
      ["pane", "rename", "root1", "t1.executor"],
      ["pane", "run", "root1", "env PI_SKIP_VERSION_CHECK=1 pi"],
    ]);
  });

  it("tab recovery uses tab list plus pane list when create output is unparseable", async () => {
    const calls: string[][] = [];
    const client = {
      command: vi.fn(async (args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === "tab" && args[1] === "create") return result("created\n");
        if (args[0] === "tab" && args[1] === "list") {
          return result(JSON.stringify({ result: { tabs: [{ tab_id: "tab1", label: "TUT executor" }] } }));
        }
        if (args[0] === "pane" && args[1] === "list") {
          return result(JSON.stringify({ result: { panes: [{ pane_id: "root1", tab_id: "tab1", agent_status: "idle" }] } }));
        }
        return result();
      }),
    };

    await expect(birthPane({
      client,
      anchor,
      birthCwd: "/repo",
      tabLabel: "TUT executor",
      paneLabel: "t1.executor",
      commandText: "pi",
    })).resolves.toBe("root1");

    expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(1);
    expect(calls).toContainEqual(["tab", "list", "--workspace", "w1"]);
    expect(calls).toContainEqual(["pane", "list"]);
    expect(calls).not.toContainEqual(["pane", "split", "w1:p1", "--direction", "right", "--no-focus", "--cwd", "/repo"]);
  });

  it("signal-terminated tab create recovers the existing tab and never issues a second create", async () => {
    const calls: string[][] = [];
    const client = {
      command: vi.fn(async (args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === "tab" && args[1] === "create") return { code: null, signal: "SIGTERM" as NodeJS.Signals, stdout: "", stderr: "" };
        if (args[0] === "tab" && args[1] === "list") {
          return result(JSON.stringify({ result: { tabs: [{ tab_id: "tab1", label: "TUT executor" }] } }));
        }
        if (args[0] === "pane" && args[1] === "list") {
          return result(JSON.stringify({ result: { panes: [{ pane_id: "root1", tab_id: "tab1", agent_status: "idle" }] } }));
        }
        return result();
      }),
    };
    const stderr: string[] = [];

    await expect(birthPane({
      client,
      anchor,
      birthCwd: "/repo",
      tabLabel: "TUT executor",
      paneLabel: "t1.executor",
      commandText: "pi",
      stderr: (text) => stderr.push(text),
    })).resolves.toBe("root1");

    expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(1);
    expect(calls).toContainEqual(["tab", "list", "--workspace", "w1"]);
    expect(calls).toContainEqual(["pane", "rename", "root1", "t1.executor"]);
    expect(calls).toContainEqual(["pane", "run", "root1", "pi"]);
    expect(stderr.join(" ")).toContain("signal SIGTERM");
    expect(stderr.join(" ")).toContain("tab id recovered via tab list");
  });

  it("signal-terminated tab create refuses birth when tab recovery misses", async () => {
    const calls: string[][] = [];
    const client = {
      command: vi.fn(async (args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === "tab" && args[1] === "create") return { code: null, signal: "SIGTERM" as NodeJS.Signals, stdout: "", stderr: "" };
        if (args[0] === "tab" && args[1] === "list") return result(JSON.stringify({ result: { tabs: [] } }));
        return result();
      }),
    };
    const stderr: string[] = [];

    await expect(birthPane({
      client,
      anchor,
      birthCwd: "/repo",
      tabLabel: "TUT executor",
      paneLabel: "t1.executor",
      commandText: "pi",
      stderr: (text) => stderr.push(text),
    })).resolves.toBeUndefined();

    expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(1);
    expect(calls.some((args) => args[0] === "pane" && args[1] === "split")).toBe(false);
    expect(stderr.join(" ")).toContain("refusing a second create");
    expect(stderr.join(" ")).toContain("inspect the tab manually");
  });

  it("fallback splits the frozen anchor and bounded sweep closes a lagged tab root", async () => {
    const calls: string[][] = [];
    let paneLists = 0;
    const client = {
      command: vi.fn(async (args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === "tab" && args[1] === "create") {
          if (calls.filter((item) => item[0] === "tab" && item[1] === "create").length === 1) return result("failed", 1);
          return result(JSON.stringify({ result: { tab: { tab_id: "tab2" } } }));
        }
        if (args[0] === "pane" && args[1] === "split") return result(JSON.stringify({ result: { pane: { pane_id: "split1" } } }));
        if (args[0] === "pane" && args[1] === "list") {
          paneLists += 1;
          const rows = paneLists === 2 ? [{ pane_id: "root2", tab_id: "tab2" }] : [];
          return result(JSON.stringify({ result: { panes: rows } }));
        }
        return result();
      }),
    };

    await expect(birthPane({
      client,
      anchor,
      birthCwd: "/repo",
      tabLabel: "TUT executor",
      paneLabel: "t1.executor",
      commandText: "pi",
      env: { TUT_ROOT_SWEEP_RETRIES: "2", TUT_ROOT_SWEEP_RETRY_MS: "0" },
    })).resolves.toBe("split1");

    expect(calls).toContainEqual(["pane", "split", "w1:p1", "--direction", "right", "--no-focus", "--cwd", "/repo"]);
    expect(calls).toContainEqual(["tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "TUT executor", "--no-focus"]);
    expect(calls).toContainEqual(["pane", "move", "split1", "--tab", "tab2", "--split", "down"]);
    expect(calls).toContainEqual(["pane", "close", "root2"]);
    expect(paneLists).toBe(3); // two bounded retry probes + one post-run sweep
  });
});

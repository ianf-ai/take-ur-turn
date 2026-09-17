/**
 * Production-default liveness budget evidence at the
 * Notifier boundary.  NO per-call timeoutMs override exists anywhere on this
 * path — spawnLaunch/spawnLaunchInvocation do not even expose one, so any
 * caller (including these tests and the real Notifier) is always on the
 * default budget.
 *
 * The OS child boundary (../src/launcher/process.js) is the only mocked
 * module: the default-window kill itself is proven in launcher-entry.test.ts
 * (fake-clock wedged child at exactly DEFAULT_CHILD_TIMEOUT_MS, plus the real
 * SIGSTOP child).  Here the REAL notifier code above that boundary must
 * (a) translate the default-budget failure return into the budget-exceeded
 * throw, and (b) carry it into the existing autoLaunchFailed alert path when
 * a Notifier runs on its production launch defaults (no launch deps
 * injected).
 */
import { describe, expect, it, vi } from "vitest";

const sent: { title: string; body: string; task_id?: string }[] = [];
vi.mock("../src/channels.js", () => ({
  createChannels: () => [
    { name: "desktop", send: async (msg: { title: string; body: string; task_id?: string }) => { sent.push(msg); } },
  ],
}));

vi.mock("../src/launcher/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/launcher/process.js")>()),
  // The default-budget failure return proven by launcher-entry.test.ts: the
  // backstop SIGKILLed the wedged launcher child once DEFAULT_CHILD_TIMEOUT_MS
  // elapsed (the shape Test A settles as — never a pending promise).
  runInternalLaunchInvocation: () =>
    Promise.resolve({ code: null, signal: "SIGKILL" as const, stdout: "", stderr: "", timedOut: true as const }),
}));

import { DEFAULT_CHILD_TIMEOUT_MS } from "../src/launcher/process.js";
import { Notifier, spawnLaunchInvocation, type StateResponse } from "../src/notifier.js";
import { buildLaunchInvocation } from "../src/launcher/invocation.js";

function invocation() {
  return buildLaunchInvocation({
    request: {
      kind: "round",
      task_id: "budget-unit",
      role: "executor",
      fresh: false,
      via: "auto",
    },
    base_version: 0,
    hub_url: "http://127.0.0.1:3001",
    route: { agent: "codex", args: ["--model", "gpt-5.6"] },
    route_source: "task-cast",
    context: {
      anchor: { workspace_id: "w1", cwd: "/work/project", pane_id: "p1" },
      hubRoot: "/work/project",
      routingRoot: "/work/project",
      checkoutRoot: "/work/project",
      checkout: { kind: "current" },
      context: { kind: "shared" },
      source: "anchor",
    },
    naming: { tab_label: "TUT executor budget-unit", pane_label: "budget-unit.executor" },
    prompt: "round prompt",
    posix_direct: {
      executable: "codex",
      args: ["--model", "gpt-5.6"],
      env: {},
    },
  });
}

describe("production default launcher budget through the Notifier boundary", () => {
  it("spawnLaunchInvocation translates the default-budget kill into the budget-exceeded throw", async () => {
    await expect(spawnLaunchInvocation(invocation())).rejects.toThrow(
      `tut launch budget-unit executor exceeded the child liveness budget (${DEFAULT_CHILD_TIMEOUT_MS}ms) and was killed`,
    );
  });

  it("a default-budget launcher kill reaches the existing autoLaunchFailed alert path (production launch defaults)", async () => {
    vi.useRealTimers(); // the off-queue launch chain settles via microtasks, not clock games
    sent.length = 0;
    const logs: string[] = [];
    let current: StateResponse = {
      flow_mode: "auto",
      auto: { launch_roles: ["executor"] },
      tasks: [{
        task_id: "budget-unit",
        title: "budget unit",
        status: "designing",
        updated_at: "2026-09-01T00:00:00.000Z",
        needs_attention: false,
        waiting_for: "agent:architect",
      }],
    };
    // No launch/launchInvocation deps: the Notifier runs its production
    // canonical boundary — the REAL spawnLaunchInvocation exercised above.
    const notifier = new Notifier(
      { url: "http://hub.test", interval: 5, eventPort: 0, stallTimeoutMin: 30 },
      {
        fetchState: async () => current,
        readLog: async (): Promise<never[]> => [],
        resolveTargetWithSource: async () => ({ route: { agent: "codex", args: ["--model", "gpt-5.6"] }, source: "task-cast" }),
        markLaunched: async (_taskId: string, _role: string, baseVersion: number) => ({ version: baseVersion + 1 }),
        now: () => 0,
        log: (line: string) => {
          logs.push(line);
        },
        loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
        listAnchorPanes: async () => [{
          pane_id: "fixture:anchor",
          label: "tut-hub",
          workspace_id: "fixture-workspace",
          cwd: "/fixture/workspace",
        }],
      },
    );
    try {
      await notifier.requestCompare(); // baseline
      current = {
        ...current,
        tasks: [{ ...current.tasks[0]!, status: "implementing", waiting_for: "agent:executor", updated_at: "2026-09-01T00:01:00.000Z" }],
      };
      await notifier.requestCompare(); // edge → gate → marker → child handed off the queue

      await vi.waitFor(() => {
        expect(sent.filter((m) => m.title.includes("auto launch failed"))).toHaveLength(1);
      });
      const failed = sent.find((m) => m.title.includes("auto launch failed"))!;
      expect(failed.task_id).toBe("budget-unit");
      expect(failed.body).toContain(`exceeded the child liveness budget (${DEFAULT_CHILD_TIMEOUT_MS}ms)`);
      expect(logs.some((l) => l.includes("launch failed for budget-unit (executor)") && l.includes(`(${DEFAULT_CHILD_TIMEOUT_MS}ms)`))).toBe(true);
    } finally {
      await notifier.close();
    }
  });
});

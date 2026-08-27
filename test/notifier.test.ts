/**
 * Notifier unit tests: fake-clock-driven compare loop, mocked channels,
 * injected fetch/launch/now. The event HTTP listener is exercised for real on an
 * ephemeral port (loopback Host guard mirrors http.test.ts's raw-socket
 * technique because fetch cannot override the Host header).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Recording mock for the channel factory: notifier.ts must build its channel
// set from /state's notify value EVERY poll.
const h = vi.hoisted(() => {
  const sent: { name: string; msg: { title: string; body: string; task_id?: string } }[] = [];
  const channelsSeen: unknown[] = [];
  return { sent, channelsSeen };
});
vi.mock("../src/channels.js", () => ({
  createChannels: (cfg: unknown) => {
    h.channelsSeen.push(cfg);
    return [
      { name: "desktop", send: async (msg: { title: string; body: string; task_id?: string }) => { h.sent.push({ name: "desktop", msg }); } },
      { name: "webhook", send: async (msg: { title: string; body: string; task_id?: string }) => { h.sent.push({ name: "webhook", msg }); } },
    ];
  },
}));

import { Notifier, runNotify, spawnLaunch, type StateResponse, type StateTask } from "../src/notifier.js";
import { launchBlocked } from "../src/launch.js";
import type { AgentRoute, ContextRecord } from "../src/types.js";
import { HANDLERS, parseArgs } from "../src/cli.js";

const U1 = "2026-08-15T10:00:00.000Z";
const U2 = "2026-08-15T10:05:00.000Z";
const U3 = "2026-08-15T10:10:00.000Z";

/** Tests that exercise the auto branch POSITIVELY whitelist
 *  every standard role; withholding cases pin the exact narrower list (or none). */
const ALL_ROLES = { launch_roles: ["architect", "executor", "reviewer"] };
const TEST_ANCHOR = {
  pane_id: "fixture:anchor",
  label: "tut-hub",
  workspace_id: "fixture-workspace",
  cwd: "/fixture/workspace",
};

function task(overrides: Partial<StateTask> & { task_id: string }): StateTask {
  return {
    title: `title of ${overrides.task_id}`,
    status: "designing",
    updated_at: U1,
    needs_attention: false,
    waiting_for: "agent:architect",
    ...overrides,
  };
}

function state(
  tasks: StateTask[],
  opts?: { flow_mode?: string; notify?: unknown; auto?: StateResponse["auto"] },
): StateResponse {
  const res: StateResponse = { flow_mode: opts?.flow_mode ?? "manual", tasks };
  if (opts?.notify !== undefined) res.notify = opts.notify;
  if (opts?.auto !== undefined) res.auto = opts.auto;
  return res;
}

interface HarnessOpts {
  flowMode?: string;
  notify?: unknown;
  /** auto-mode launch whitelist (state.auto.launch_roles); omitted = no auto key. */
  autoRoles?: string[];
  interval?: number;
  stallMin?: number;
  workingTimeoutSec?: number;
  eventPort?: number;
  realLaunch?: boolean;
  launch?: (taskId: string, role: string, agent: string, args?: string[]) => Promise<string>;
  readLog?: (taskId: string) => Promise<ContextRecord[]>;
  /** Agent the injected launch pre-check resolves (default "pi"). */
  agent?: string;
  /** Complete route the injected launch pre-check resolves. */
  route?: AgentRoute;
  /** Routing maps for event→task mapping tests; omitted = empty maps (no role panes). */
  routing?: { labelToAgent?: Record<string, string>; roleToAgent?: Record<string, string> };
  /** Use the REAL chain loader (defaultLoadRouting: cwd L1 + TUT_USER_CONFIG_DIR L2). */
  realRouting?: boolean;
  /** Pane inventory served to the done-event sweep (default: none). */
  panes?: { pane_id: string; label: string }[];
  /** Screen content readPane serves per pane id (default: empty). */
  screens?: Record<string, string>;
  /** When set, listPanes rejects (degradation path). */
  listPanesFails?: string;
  /** Pane ids whose readPane rejects (per-pane degradation path). */
  readPaneFails?: string[];
  /** Shared ordering probe: milestone names pushed as they happen (sweep-list-start / sweep-read:<id> / marker / launch). */
  order?: string[];
  /** Artificial pane-list delay inside the done sweep, fake-timer ms (concurrency-barrier tests). */
  sweepDelayMs?: number;
}

const openNotifiers: Notifier[] = [];

function makeHarness(opts: HarnessOpts = {}) {
  let current: StateResponse = state([], {
    ...(opts.flowMode !== undefined ? { flow_mode: opts.flowMode } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
    ...(opts.autoRoles !== undefined ? { auto: { launch_roles: opts.autoRoles } } : {}),
  });
  let failing = false;
  let nowMs = 0;
  const logs: string[] = [];
  const launches: { taskId: string; role: string; agent: string; args?: string[] }[] = [];
  const sweptReads: string[] = [];
  let sweepLists = 0;
  let fetches = 0;
  const notifier = new Notifier(
    {
      url: "http://127.0.0.1:3001",
      interval: opts.interval ?? 5,
      eventPort: opts.eventPort ?? 3999,
      stallTimeoutMin: opts.stallMin ?? 30,
      ...(opts.workingTimeoutSec !== undefined ? { workingTimeoutSec: opts.workingTimeoutSec } : {}),
    },
    {
      fetchState: async (url: string) => {
        if (failing) throw new Error(`connect ECONNREFUSED ${url}`);
        fetches += 1;
        return current;
      },
      ...(opts.launch !== undefined
        ? { launch: opts.launch }
        : opts.realLaunch === true
          ? {}
          : {
              launch: async (taskId: string, role: string, agent: string, args: string[] = []) => {
                opts.order?.push("launch");
                launches.push({ taskId, role, agent, ...(args.length > 0 ? { args: [...args] } : {}) });
                return "launched";
              },
            }),
      // launch pre-check (hermetic): the real default hits GET /state of the hub
      // url + `which` — tests inject a fixed resolution instead.
      resolveTarget: async () => opts.route ?? opts.agent ?? "pi",
      // Auto-launch provenance is exercised with dedicated injected-deps
      // tests below; the legacy state-only harness keeps an empty log so its
      // synthetic state transitions remain independently focused.
      readLog: opts.readLog ?? (async (taskId: string): Promise<ContextRecord[]> => {
        const version = current.tasks.find((candidate) => candidate.task_id === taskId)?.version ?? 0;
        return Array.from({ length: version }, (_, index) => ({
          version: index + 1,
          task_id: taskId,
          role: "human",
          content_type: "note",
          timestamp: U1,
          payload: { summary: "synthetic state version", body: "synthetic state version" },
        }));
      }),
      markLaunched: async (_taskId: string, _role: string, baseVersion: number, _via: "start-next" | "auto"): Promise<unknown> => {
        opts.order?.push("marker");
        return { version: baseVersion + 1 };
      },
      // Hermetic event→task mapping: tests that don't declare routing get empty maps
      // (the real default reads the three-level chain — cwd L1 + TUT_USER_CONFIG_DIR L2).
      ...(opts.realRouting === true
        ? {}
        : {
            loadRouting: async () => ({
              labelToAgent: new Map(Object.entries(opts.routing?.labelToAgent ?? {})),
              roleToAgent: new Map(Object.entries(opts.routing?.roleToAgent ?? {})),
            }),
          }),
      now: () => nowMs,
      log: (line: string) => {
        logs.push(line);
      },
      // Done-event sweep (hermetic: never spawns the real herdr — the pane
      // inventory is a fixture; reads are recorded for scoping assertions).
      listPanes: async () => {
        if (opts.listPanesFails !== undefined) throw new Error(opts.listPanesFails);
        sweepLists += 1;
        opts.order?.push("sweep-list-start");
        if (opts.sweepDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, opts.sweepDelayMs));
        }
        opts.order?.push("sweep-list-end");
        return opts.panes ?? [];
      },
      // Anchor discovery is intentionally a separate seam from the minimal
      // done-sweep inventory.  The synthetic system row is the legal anchor
      // used by auto-launch tests; sweep fixtures remain label-only.
      listAnchorPanes: async () => [{
        pane_id: "fixture:anchor",
        label: "tut-hub",
        workspace_id: "fixture-workspace",
        cwd: "/fixture/workspace",
      }],
      readPane: async (paneId: string) => {
        if (opts.readPaneFails?.includes(paneId)) throw new Error(`fixture read failure for ${paneId}`);
        sweptReads.push(paneId);
        opts.order?.push(`sweep-read:${paneId}`);
        return opts.screens?.[paneId] ?? "";
      },
    },
  );
  openNotifiers.push(notifier);
  return {
    notifier,
    set(next: StateResponse): void {
      current = next;
    },
    setFailing(value: boolean): void {
      failing = value;
    },
    at(ms: number): void {
      nowMs = ms;
    },
    logs,
    launches,
    sweptReads,
    sweepListCount: () => sweepLists,
    fetchCount: () => fetches,
    titles: () => h.sent.map((s) => s.msg.title),
    flush: async (rounds = 20): Promise<void> => {
      for (let i = 0; i < rounds; i++) await Promise.resolve();
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

/** Titles of desktop-channel deliveries — exactly one entry per notification. */
function titlesMatching(fragment: string): string[] {
  return h.sent
    .filter((s) => s.name === "desktop")
    .map((s) => s.msg.title)
    .filter((t) => t.includes(fragment));
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.sent.length = 0;
  h.channelsSeen.length = 0;
});

afterEach(async () => {
  for (const n of openNotifiers.splice(0)) await n.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- compare loop -------------------------------------------------------------------

describe("compare loop (poll /state)", () => {
  it("first successful fetch establishes the baseline silently", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer" })]));
    await hz.notifier.requestCompare();
    expect(h.sent).toEqual([]);
    expect(hz.logs.some((l) => l.includes("baseline"))).toBe(true);
  });

  it("manual mode: waiting_for change notifies task, status, waiting_for, pane=task_id", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare(); // baseline: designing / agent:architect
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })]));
    await hz.notifier.requestCompare();
    expect(titlesMatching("waiting for agent:executor")).toHaveLength(1); // one notification...
    expect(h.sent).toHaveLength(2); // ...delivered via both channels
    const msg = h.sent[0]!.msg;
    expect(msg.body).toContain("status: implementing");
    expect(msg.body).toContain("pane: t1.executor"); // fresh round pane naming (4.4)
    expect(msg.task_id).toBe("t1");
  });

  it("manual mode: human-waiting notifications carry NO pane segment (no agent pane to name)", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "pending_approval", waiting_for: "human", updated_at: U2 })]));
    await hz.notifier.requestCompare();
    expect(titlesMatching("waiting for human")).toHaveLength(1);
    expect(h.sent[0]!.msg.body).not.toContain("pane:");
  });

  it("waiting_for → none is silent (human closed the task)", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "closed", waiting_for: "none", updated_at: U2 })]));
    await hz.notifier.requestCompare();
    expect(h.sent).toEqual([]);
  });

  it("a task appearing after baseline notifies (absent → agent:*)", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare(); // empty baseline
    hz.set(state([task({ task_id: "new1", status: "designing", waiting_for: "agent:architect" })]));
    await hz.notifier.requestCompare();
    expect(titlesMatching("waiting for agent:architect")).toHaveLength(1);
  });

  it("poll failure: one stderr line per consecutive run, snapshot kept, no notify, no crash", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare();
    hz.setFailing(true);
    await hz.notifier.requestCompare();
    await hz.notifier.requestCompare();
    expect(hz.logs.filter((l) => l.includes("poll failed"))).toHaveLength(1);
    expect(h.sent).toEqual([]);
    // Recovery: the pre-failure snapshot is still the comparison base — the
    // change is detected WITHOUT re-baselining (restart semantics apply
    // to process restarts, not failed polls).
    hz.setFailing(false);
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })]));
    await hz.notifier.requestCompare();
    expect(hz.logs.filter((l) => l.includes("poll failed"))).toHaveLength(1);
    expect(titlesMatching("waiting for agent:executor")).toHaveLength(1);
  });

  it("startPolling: immediate baseline, then one compare per interval", async () => {
    const hz = makeHarness({ interval: 5 });
    hz.notifier.startPolling();
    await hz.flush();
    expect(hz.fetchCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await hz.flush();
    expect(hz.fetchCount()).toBe(4);
  });

  it("channel set is rebuilt from /state's notify key every poll", async () => {
    const cfgA = { channels: ["desktop"] };
    const cfgB = { channels: ["webhook"], webhook_url: "http://127.0.0.1:9/hook" };
    const hz = makeHarness({ notify: cfgA });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1" })], { notify: cfgB }));
    await hz.notifier.requestCompare();
    // [0] is the constructor's pre-baseline default (createChannels(undefined));
    // every poll afterwards rebuilds from that poll's notify value.
    expect(h.channelsSeen.slice(-2)).toEqual([cfgA, cfgB]);
  });
});

// --- pending approval edge ----------------------------------------------------------

describe("pending_approval notifications", () => {
  it("detects the status edge even when waiting_for is already human, truncates the title, and logs once", async () => {
    const longTitle = `${"Approval title ".repeat(8)}tail`;
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", title: longTitle, status: "reviewing", waiting_for: "human" })]));
    await hz.notifier.requestCompare(); // baseline: human-waiting, not pending_approval

    hz.set(state([task({
      task_id: "t1",
      title: longTitle,
      status: "pending_approval",
      waiting_for: "human",
      updated_at: U2,
    })]));
    await hz.notifier.requestCompare();
    await hz.notifier.requestCompare(); // same pending state: no repeated alert

    expect(titlesMatching("waiting for human")).toHaveLength(1);
    expect(h.sent).toHaveLength(2); // desktop + webhook
    const msg = h.sent[0]!.msg;
    expect(msg.task_id).toBe("t1");
    expect(msg.body).toContain(`${longTitle.slice(0, 72)}…`);
    expect(msg.body).not.toContain(longTitle);
    expect(msg.body).toContain("status: pending_approval");
    expect(msg.body).toContain("waiting for approval");
    expect(msg.body).toContain("tut decide t1 --decision approve --by <your-name>");
    expect(msg.body).toContain("replace `<your-name>` with your identity");
    expect(msg.body).toContain("--decision reject");
    expect(parseArgs(["decide", "t1", "--decision", "approve", "--by", "alice"])).toMatchObject({
      command: "decide",
      task_id: "t1",
      decision: "approve",
      by: "alice",
    });
    expect(hz.logs.filter((line) => line.includes("TUT t1: waiting for human"))).toHaveLength(1);
  });

  it("does not notify for a pending baseline or replay it after a flow-mode change", async () => {
    const hz = makeHarness({ flowMode: "manual" });
    const pending = task({ task_id: "t1", status: "pending_approval", waiting_for: "human" });
    hz.set(state([pending], { flow_mode: "manual" }));
    await hz.notifier.requestCompare(); // existing pending task: silent baseline
    hz.set(state([pending], { flow_mode: "auto" }));
    await hz.notifier.requestCompare(); // mode change is not a status edge
    expect(h.sent).toEqual([]);
  });

  it("resets the edge after leaving pending_approval so a later entry notifies again", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer" })]));
    await hz.notifier.requestCompare();

    hz.set(state([task({ task_id: "t1", status: "pending_approval", waiting_for: "human", updated_at: U2 })]));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "approved", waiting_for: "human", updated_at: U3 })]));
    await hz.notifier.requestCompare(); // leaves pending_approval; no flow edge
    hz.set(state([task({ task_id: "t1", status: "pending_approval", waiting_for: "human", updated_at: "2026-08-15T10:15:00.000Z" })]));
    await hz.notifier.requestCompare();

    expect(titlesMatching("waiting for human")).toHaveLength(2);
    expect(h.sent).toHaveLength(4); // two approval edges × two channels
  });

  it("uses the existing auto-mode human gate channels for the approval edge", async () => {
    const hz = makeHarness({ flowMode: "auto" });
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "human" })], { flow_mode: "auto" }));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "pending_approval", waiting_for: "human", updated_at: U2 })], { flow_mode: "auto" }));
    await hz.notifier.requestCompare();

    expect(hz.launches).toEqual([]);
    expect(titlesMatching("human decision needed")).toHaveLength(1);
    expect(h.sent[0]!.msg.body).toContain("waiting for approval");
    expect(h.sent[0]!.msg.body).toContain("auto launch withheld");
  });
});

// --- version-jump merge log (log-only, no behavior change) -------------------------

describe("version jump merge log", () => {
  it("logs one merge line when waiting_for changed and version jumped >1; notification unchanged", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", status: "designing", waiting_for: "agent:architect", version: 1 })]));
    await hz.notifier.requestCompare(); // baseline v1
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U2, version: 4 })]));
    await hz.notifier.requestCompare();
    expect(hz.logs.filter((l) => l.includes("transitions merged"))).toEqual([
      "tut: notify: [t1] 3 transitions merged between polls (v1→v4)",
    ]);
    // Behavior unchanged: exactly the usual one manual flow notification.
    expect(titlesMatching("waiting for agent:reviewer")).toHaveLength(1);
    expect(h.sent).toHaveLength(2); // both channels, nothing extra
  });

  it("no merge line when version advances by exactly 1", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", status: "designing", waiting_for: "agent:architect", version: 1 })]));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2, version: 2 })]));
    await hz.notifier.requestCompare();
    expect(hz.logs.some((l) => l.includes("transitions merged"))).toBe(false);
    expect(titlesMatching("waiting for agent:executor")).toHaveLength(1);
  });

  it("same-endpoint merge logs too: big jump with unchanged waiting_for (round swallowed)", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 1 })]));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "revising", waiting_for: "agent:executor", updated_at: U2, version: 3 })]));
    await hz.notifier.requestCompare();
    // executor→reviewer→executor landed within one poll window: end-to-end the
    // endpoint matches, so no notification fires — the merge line is the only
    // diagnostic trace of the swallowed round (review fix: not gated on wfChanged).
    expect(hz.logs.filter((l) => l.includes("transitions merged"))).toEqual([
      "tut: notify: [t1] 2 transitions merged between polls (v1→v3)",
    ]);
    expect(h.sent).toEqual([]);
  });

  it("no merge line when the task was absent from the previous snapshot (before ignored)", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare(); // empty baseline
    hz.set(state([task({ task_id: "new1", status: "designing", waiting_for: "agent:architect", version: 5 })]));
    await hz.notifier.requestCompare();
    expect(hz.logs.some((l) => l.includes("transitions merged"))).toBe(false);
    expect(titlesMatching("waiting for agent:architect")).toHaveLength(1); // absent → agent:* still notifies
  });

  it("no merge line when the version field is absent (older hub / version-less fixture)", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", status: "designing", waiting_for: "agent:architect" })]));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U2, version: 4 })]));
    await hz.notifier.requestCompare();
    expect(hz.logs.some((l) => l.includes("transitions merged"))).toBe(false);
    expect(titlesMatching("waiting for agent:reviewer")).toHaveLength(1);
  });
});

// --- needs_attention ------------------------------------------------------------------

describe("needs_attention handling", () => {
  it("rising edge notifies the anomaly and suppresses the same-tick flow notification", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "human", needs_attention: true, updated_at: U2 })]));
    await hz.notifier.requestCompare();
    expect(titlesMatching("needs attention")).toHaveLength(1);
    expect(h.sent[0]!.msg.body).toContain("tut read t1");
    // Suppressed: no flow notification for the same transition.
    expect(titlesMatching("waiting for")).toHaveLength(0);
    expect(h.sent).toHaveLength(2); // anomaly via both channels, nothing else
  });

  it("in auto mode an anomaly also means: no launch, notify human instead", async () => {
    const hz = makeHarness({ flowMode: "auto" });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "human", needs_attention: true, updated_at: U2 })], { flow_mode: "auto" }));
    await hz.notifier.requestCompare();
    expect(titlesMatching("needs attention")).toHaveLength(1);
    expect(hz.launches).toEqual([]);
  });

  it("an already-set needs_attention does not re-notify while unchanged", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare();
    const attention = state([task({ task_id: "t1", status: "implementing", waiting_for: "human", needs_attention: true, updated_at: U2 })]);
    hz.set(attention);
    await hz.notifier.requestCompare();
    hz.set(attention);
    await hz.notifier.requestCompare();
    expect(titlesMatching("needs attention")).toHaveLength(1);
  });
});

// --- auto-mode gate (/state-only reading) -----------------------------------

describe("auto-mode gate", () => {
  it("fails closed when the state task version and launch log version diverge", async () => {
    const order: string[] = [];
    const hz = makeHarness({
      flowMode: "auto",
      autoRoles: ["executor"],
      order,
      readLog: async (taskId): Promise<ContextRecord[]> => [
        {
          version: 2,
          task_id: taskId,
          role: "executor",
          content_type: "code_changes",
          timestamp: U2,
          payload: { summary: "newer state", body: "newer state" },
        },
      ],
    });
    await hz.notifier.requestCompare();
    hz.set(
      state(
        [task({ task_id: "t-race", status: "implementing", waiting_for: "agent:executor", version: 1, updated_at: U2 })],
        { flow_mode: "auto", auto: ALL_ROLES },
      ),
    );
    await hz.notifier.requestCompare();

    expect(hz.launches).toEqual([]);
    expect(order).not.toContain("marker");
    expect(order).not.toContain("launch");
    expect(hz.logs.some((line) => line.includes("state/log version mismatch: state v1, log v2"))).toBe(true);
    expect(titlesMatching("auto launch failed")).toHaveLength(1);
  });

  it("launches via launch.sh for an agent:* hand-off and notifies 'auto-launched'", async () => {
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"] });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();
    expect(hz.launches).toEqual([{ taskId: "t1", role: "executor", agent: "pi" }]);
    expect(titlesMatching("auto-launched executor")).toHaveLength(1);
    expect(titlesMatching("waiting for")).toHaveLength(0); // manual-style notify not used in auto
  });

  it("passes a parameterized cast to the auto launcher with complete ordered args", async () => {
    const route = { agent: "codex", args: ["--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"] };
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"], route });
    await hz.notifier.requestCompare();
    hz.set(
      state(
        [task({ task_id: "t-args", status: "implementing", waiting_for: "agent:executor", updated_at: U2, cast: { executor: route } })],
        { flow_mode: "auto", auto: ALL_ROLES },
      ),
    );
    await hz.notifier.requestCompare();

    expect(hz.launches).toEqual([{ taskId: "t-args", role: "executor", agent: "codex", args: route.args }]);
    expect(titlesMatching("auto-launched executor")).toHaveLength(1);
  });

  it("reports auto launch and agent working as two separate stages", async () => {
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"], workingTimeoutSec: 5 });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();

    expect(titlesMatching("auto-launched executor")).toHaveLength(1);
    expect(titlesMatching("agent working")).toHaveLength(0);
    expect(hz.logs.some((line) => line.includes("launch succeeded") && line.includes("working signal"))).toBe(true);

    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(titlesMatching("agent working")).toHaveLength(1);
    expect(titlesMatching("launch succeeded but no working signal")).toHaveLength(0);
    expect(hz.logs.some((line) => line.includes("working signal received"))).toBe(true);
  });

  it("alerts when a successful auto launch misses its short working fuse", async () => {
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"], workingTimeoutSec: 5 });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();

    await vi.advanceTimersByTimeAsync(4_999);
    await hz.flush();
    expect(titlesMatching("launch succeeded but no working signal")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await hz.flush();
    expect(titlesMatching("launch succeeded but no working signal")).toHaveLength(1);
    expect(hz.logs.some((line) => line.includes("launch working timeout"))).toBe(true);
  });

  it("working before the fuse expires suppresses the timeout alert", async () => {
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"], workingTimeoutSec: 5 });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();

    await vi.advanceTimersByTimeAsync(4_000);
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await hz.flush();
    expect(titlesMatching("agent working")).toHaveLength(1);
    expect(titlesMatching("launch succeeded but no working signal")).toHaveLength(0);
  });

  it("keeps the launch watch across an ordinary note and still times out without working", async () => {
    let records: ContextRecord[] = [];
    const hz = makeHarness({
      flowMode: "auto",
      autoRoles: ["executor"],
      workingTimeoutSec: 5,
      readLog: async () => records,
    });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();

    records = [
      {
        version: 1,
        task_id: "t1",
        role: "human",
        content_type: "note",
        timestamp: U1,
        payload: {
          summary: "launch: executor (base v0)",
          body: "launch",
          launch: { role: "executor", base_version: 0, via: "auto" },
        },
      },
      {
        version: 2,
        task_id: "t1",
        role: "human",
        content_type: "note",
        timestamp: U2,
        payload: { summary: "operator note", body: "still working" },
      },
    ];
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();

    await vi.advanceTimersByTimeAsync(5_000);
    await hz.flush();
    expect(titlesMatching("launch succeeded but no working signal")).toHaveLength(1);
  });

  it("keeps the launch watch across an ordinary note so the current pane can clear it", async () => {
    let records: ContextRecord[] = [];
    const hz = makeHarness({
      flowMode: "auto",
      autoRoles: ["executor"],
      workingTimeoutSec: 5,
      readLog: async () => records,
    });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();

    records = [
      {
        version: 1,
        task_id: "t1",
        role: "human",
        content_type: "note",
        timestamp: U1,
        payload: {
          summary: "launch: executor (base v0)",
          body: "launch",
          launch: { role: "executor", base_version: 0, via: "auto" },
        },
      },
      {
        version: 2,
        task_id: "t1",
        role: "human",
        content_type: "note",
        timestamp: U2,
        payload: { summary: "operator note", body: "still working" },
      },
    ];
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();

    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(titlesMatching("agent working")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await hz.flush();
    expect(titlesMatching("launch succeeded but no working signal")).toHaveLength(0);
  });

  it("keeps a working signal that arrives while launch.sh is still returning", async () => {
    let launchStarted!: () => void;
    let finishLaunch!: (output: string) => void;
    const started = new Promise<void>((resolve) => {
      launchStarted = resolve;
    });
    const launchFinished = new Promise<string>((resolve) => {
      finishLaunch = resolve;
    });
    const hz = makeHarness({
      flowMode: "auto",
      autoRoles: ["executor"],
      workingTimeoutSec: 5,
      launch: async () => {
        launchStarted();
        return launchFinished;
      },
    });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    const compare = hz.notifier.requestCompare();
    await started;

    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(titlesMatching("agent working")).toHaveLength(0); // launch stage has not returned yet

    finishLaunch("launched");
    await compare;
    await hz.flush();
    expect(titlesMatching("auto-launched executor")).toHaveLength(1);
    expect(titlesMatching("agent working")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await hz.flush();
    expect(titlesMatching("launch succeeded but no working signal")).toHaveLength(0);
  });

  it("retires an old-role watch before a late working event can refresh the task", async () => {
    const hz = makeHarness({
      flowMode: "auto",
      autoRoles: ["executor", "reviewer"],
      workingTimeoutSec: 5,
      stallMin: 0.001,
    });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2, version: 1 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare(); // executor watch

    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U3, version: 1 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare(); // executor watch retired, reviewer watch armed

    hz.at(50);
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(titlesMatching("agent working")).toHaveLength(0);

    // The stale executor event must not move the stall clock forward.
    hz.at(61);
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await hz.flush();
    expect(titlesMatching("launch succeeded but no working signal")).toHaveLength(1);
    expect(titlesMatching("agent working")).toHaveLength(0);
  });

  it("does not let a suffixed old same-role pane clear the new round watch", async () => {
    let records: ContextRecord[] = [];
    const hz = makeHarness({
      flowMode: "auto",
      autoRoles: ["executor"],
      workingTimeoutSec: 5,
      readLog: async () => records,
    });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare(); // round 1 executor watch

    records = [
      {
        version: 1,
        task_id: "t1",
        role: "human",
        content_type: "note",
        timestamp: U1,
        payload: {
          summary: "launch: executor (base v0)",
          body: "launch",
          launch: { role: "executor", base_version: 0, via: "auto" },
        },
      },
    ];
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U3, version: 1 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare(); // retire round 1
    records = [
      ...records,
      {
        version: 2,
        task_id: "t1",
        role: "human",
        content_type: "note",
        timestamp: U2,
        payload: {
          summary: "launch: reviewer (base v1)",
          body: "launch",
          launch: { role: "reviewer", base_version: 1, via: "auto" },
        },
      },
      {
        version: 3,
        task_id: "t1",
        role: "reviewer",
        content_type: "review",
        timestamp: U3,
        payload: { summary: "reviewed", body: "review" },
      },
      {
        version: 4,
        task_id: "t1",
        role: "human",
        content_type: "note",
        timestamp: U3,
        payload: { summary: "round handoff", body: "next executor round" },
      },
    ];
    hz.set(state([task({ task_id: "t1", status: "revising", waiting_for: "agent:executor", updated_at: U3, version: 4 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare(); // round 2 executor watch

    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "t1.executor.old" });
    await hz.flush();
    expect(titlesMatching("agent working")).toHaveLength(0);

    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(titlesMatching("agent working")).toHaveLength(1);
  });

  it("auto mode skips a role whose launch marker is still the latest task action", async () => {
    let current = state([task({ task_id: "t1", status: "designing", waiting_for: "agent:architect" })], { flow_mode: "auto", auto: ALL_ROLES });
    const records: ContextRecord[] = [
      {
        version: 1,
        task_id: "t1",
        role: "human",
        content_type: "note",
        timestamp: U1,
        payload: {
          summary: "launch: executor (base v0)",
          body: "launch",
          launch: { role: "executor", base_version: 0, via: "auto" },
        },
      },
    ];
    const launches: string[] = [];
    const notifier = new Notifier(
      { url: "http://hub", interval: 5, eventPort: 3999, stallTimeoutMin: 30 },
      {
        fetchState: async () => current,
        readLog: async () => records,
        markLaunched: async () => {
          throw new Error("must not append when blocked");
        },
        launch: async (_taskId, role) => {
          launches.push(role);
          return "launched";
        },
        resolveTarget: async () => "pi",
        now: () => 0,
        log: (line) => h.sent.push({ name: "log", msg: { title: line, body: "" } }),
        listAnchorPanes: async () => [TEST_ANCHOR],
      },
    );
    openNotifiers.push(notifier);
    await notifier.requestCompare();
    current = state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES });
    await notifier.requestCompare();

    expect(launches).toEqual([]);
    expect(titlesMatching("auto launch skipped (already launched)")).toHaveLength(1);
    expect(titlesMatching("auto-launched")).toHaveLength(0);
  });

  it("auto mode records the marker before invoking the launcher", async () => {
    let current = state([task({ task_id: "t1", status: "designing", waiting_for: "agent:architect" })], { flow_mode: "auto", auto: ALL_ROLES });
    const order: string[] = [];
    const notifier = new Notifier(
      { url: "http://hub", interval: 5, eventPort: 3999, stallTimeoutMin: 30 },
      {
        fetchState: async () => current,
        readLog: async () => [],
        markLaunched: async () => {
          order.push("mark");
        },
        launch: async () => {
          order.push("spawn");
          return "launched";
        },
        resolveTarget: async () => "pi",
        now: () => 0,
        log: () => undefined,
        listAnchorPanes: async () => [TEST_ANCHOR],
      },
    );
    openNotifiers.push(notifier);
    await notifier.requestCompare();
    current = state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES });
    await notifier.requestCompare();

    expect(order).toEqual(["mark", "spawn"]);
  });

  it("auto mode re-reads after a marker conflict and converges to skipped", async () => {
    let current = state([task({ task_id: "t1", status: "designing", waiting_for: "agent:architect" })], { flow_mode: "auto", auto: ALL_ROLES });
    let reads = 0;
    const launches: string[] = [];
    const winner: ContextRecord = {
      version: 1,
      task_id: "t1",
      role: "human",
      content_type: "note",
      timestamp: U1,
      payload: { summary: "launch", body: "launch", launch: { role: "executor", base_version: 0, via: "start-next" } },
    };
    const notifier = new Notifier(
      { url: "http://hub", interval: 5, eventPort: 3999, stallTimeoutMin: 30 },
      {
        fetchState: async () => current,
        readLog: async () => {
          reads += 1;
          return reads === 1 ? [] : [winner];
        },
        markLaunched: async () => {
          throw new Error("VERSION_CONFLICT: lost launch race");
        },
        launch: async () => {
          launches.push("spawn");
          return "launched";
        },
        resolveTarget: async () => "pi",
        now: () => 0,
        log: () => undefined,
        listAnchorPanes: async () => [TEST_ANCHOR],
      },
    );
    openNotifiers.push(notifier);
    await notifier.requestCompare();
    current = state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES });
    await notifier.requestCompare();

    expect(reads).toBe(2);
    expect(launches).toEqual([]);
    expect(titlesMatching("auto launch skipped (already launched)")).toHaveLength(1);
    expect(titlesMatching("auto launch failed")).toHaveLength(0);
  });

  it("transition INTO pending_approval notifies the human and does not launch", async () => {
    const hz = makeHarness({ flowMode: "auto" });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "pending_approval", waiting_for: "human", updated_at: U2 })], { flow_mode: "auto" }));
    await hz.notifier.requestCompare();
    expect(hz.launches).toEqual([]);
    expect(titlesMatching("human decision needed")).toHaveLength(1);
  });

  it("pending_approval → revising after decision(reject) LAUNCHES in auto", async () => {
    // The only legal pending_approval → revising path is decision(reject) — a
    // human has already acted. waiting_for "human" already encodes "no
    // decision → no start" (it never reaches the launch branch), so the
    // previous-status check is dropped: withholding here would stall the auto
    // loop every review-revision round.
    const hz = makeHarness({ flowMode: "auto" });
    hz.set(state([task({ task_id: "t1", status: "pending_approval", waiting_for: "human" })]));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "revising", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();
    expect(hz.launches).toEqual([{ taskId: "t1", role: "executor", agent: "pi" }]);
    expect(titlesMatching("auto-launched executor")).toHaveLength(1);
    expect(titlesMatching("human decision needed")).toHaveLength(0);
  });

  it("target pre-check failure fails the auto launch BEFORE the marker or spawn", async () => {
    // The pre-check seam throws exactly what the production default resolver
    // wrapper produces for a Windows target refusal (AgentTargetError message
    // carried by "fails its target pre-check"); the canonical auto path must
    // route it to autoLaunchFailed — no marker append, no launcher spawn.
    const logs: string[] = [];
    const calls: string[] = [];
    let cur = state([task({ task_id: "t1", status: "designing", waiting_for: "agent:architect" })], { flow_mode: "auto", auto: ALL_ROLES });
    const notifier = new Notifier(
      { url: "http://x:1", interval: 5, eventPort: 3999, stallTimeoutMin: 30 },
      {
        fetchState: async () => cur,
        readLog: async () => [],
        markLaunched: async () => {
          calls.push("marker");
          return { version: 1 };
        },
        launch: async () => {
          calls.push("launch");
          return "launched";
        },
        resolveTargetWithSource: async () => {
          calls.push("precheck");
          throw new Error(
            "routed agent 'pi' fails its target pre-check: agent 'pi' resolves to a Windows shim (C:\\npm\\pi.cmd) — TUT does not execute .cmd shims",
          );
        },
        now: () => 0,
        log: (l: string) => {
          logs.push(l);
        },
        listAnchorPanes: async () => [TEST_ANCHOR],
      },
    );
    openNotifiers.push(notifier);
    await notifier.requestCompare(); // baseline
    cur = state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES });
    await notifier.requestCompare(); // gate passes → pre-check throws internally

    expect(calls).toEqual(["precheck"]); // neither the marker nor the launcher ran
    expect(titlesMatching("auto launch failed")).toHaveLength(1);
    expect(logs.some((l) => l.includes("precheck failed") && l.includes("Windows shim"))).toBe(true);
  });

  it("launch failure is logged and notified, never thrown", async () => {
    const logs: string[] = [];
    let cur = state([task({ task_id: "t1", status: "designing", waiting_for: "agent:architect" })], { flow_mode: "auto", auto: ALL_ROLES });
    const notifier = new Notifier(
      { url: "http://x:1", interval: 5, eventPort: 3999, stallTimeoutMin: 30 },
      {
        fetchState: async () => cur,
        readLog: async () => [],
        markLaunched: async () => undefined,
        launch: async () => {
          throw new Error("herdr not found");
        },
        resolveTarget: async () => "pi",
        now: () => 0,
        log: (l: string) => {
          logs.push(l);
        },
        listAnchorPanes: async () => [TEST_ANCHOR],
      },
    );
    openNotifiers.push(notifier);
    await notifier.requestCompare(); // baseline
    cur = state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES });
    await notifier.requestCompare(); // gate passes → launch throws internally
    expect(titlesMatching("auto launch failed")).toHaveLength(1);
    expect(logs.some((l) => l.includes("launch failed") && l.includes("herdr not found"))).toBe(true);
  });

  it("TUT_DRY_RUN=1: real launch.sh prints the herdr command; auto-launched notify fires", async () => {
    vi.useRealTimers(); // real child process, no clock needed
    const previous = process.env.TUT_DRY_RUN;
    process.env.TUT_DRY_RUN = "1";
    try {
      const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"], realLaunch: true });
      await hz.notifier.requestCompare(); // baseline: designing / agent:architect
      hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
      await hz.notifier.requestCompare();
      // launch.sh TUT_DRY_RUN output: the pre-check resolved executor →
      // agent 'pi' (passed as the 3rd arg); the prompt names the task id;
      // delivery is send-text + Enter (not pane run). Dry-run may open with
      // provisioning preview/skip lines when no live pane matches the agent —
      // assert on the send-text line, independent of line order.
      const launchLines = hz.logs.filter((l) => l.includes("launch.sh (t1, executor)"));
      expect(launchLines.length).toBeGreaterThan(0);
      const sendText = launchLines.find((l) => l.includes("DRY-RUN: herdr pane send-text"));
      expect(sendText).toBeDefined();
      expect(sendText).toContain("(agent 'pi', label");
      expect(sendText).toContain("t1");
      expect(titlesMatching("auto-launched executor")).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.TUT_DRY_RUN;
      else process.env.TUT_DRY_RUN = previous;
    }
  });
});

// --- auto-mode launch whitelist -----------------------------------------------------

describe("auto-mode launch whitelist", () => {
  it("whitelisted role proceeds exactly as before: launch + auto-launched notify", async () => {
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"] });
    await hz.notifier.requestCompare();
    hz.set(
      state(
        [task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })],
        { flow_mode: "auto", auto: { launch_roles: ["executor"] } },
      ),
    );
    await hz.notifier.requestCompare();
    expect(hz.launches).toEqual([{ taskId: "t1", role: "executor", agent: "pi" }]);
    expect(titlesMatching("auto-launched executor")).toHaveLength(1);
    expect(titlesMatching("auto launch withheld")).toHaveLength(0);
  });

  it("non-whitelisted role: no launch, NO launch marker — a later manual start-next would not hit ALREADY_LAUNCHED (pinned)", async () => {
    // Simulated hub log: markLaunched appends into it exactly as the real
    // optimistic marker would — the withheld round must leave it untouched.
    const log: ContextRecord[] = [];
    const marks: string[] = [];
    const logs: string[] = [];
    const launchRoles: string[] = [];
    let current = state(
      [task({ task_id: "t1", status: "designing", waiting_for: "agent:architect" })],
      { flow_mode: "auto", auto: { launch_roles: ["architect"] } },
    );
    const notifier = new Notifier(
      { url: "http://hub", interval: 5, eventPort: 3999, stallTimeoutMin: 30 },
      {
        fetchState: async () => current,
        readLog: async () => [...log],
        markLaunched: async (taskId, role, baseVersion) => {
          marks.push(`${taskId}:${role}`);
          log.push({
            version: baseVersion + 1,
            task_id: taskId,
            role: "human",
            content_type: "note",
            timestamp: U1,
            payload: {
              summary: `launch: ${role} (base v${baseVersion})`,
              body: "launch",
              launch: { role, base_version: baseVersion, via: "auto" },
            },
          });
        },
        launch: async (_taskId, role) => {
          launchRoles.push(role);
          return "launched";
        },
        loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
        now: () => 0,
        log: (line) => {
          logs.push(line);
        },
      },
    );
    openNotifiers.push(notifier);
    await notifier.requestCompare(); // baseline: architect whitelisted, but no change yet
    current = state(
      [task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })],
      { flow_mode: "auto", auto: { launch_roles: ["architect"] } }, // executor NOT whitelisted
    );
    await notifier.requestCompare();

    expect(launchRoles).toEqual([]); // no launch
    expect(marks).toEqual([]); // and NO launch marker appended
    // The pinned consequence: over the same task log, the
    // start-next dedup guard finds no marker → the human's `tut start-next`
    // for this round is NOT blocked by ALREADY_LAUNCHED.
    expect(launchBlocked(log, "executor")).toEqual({ blocked: false });
    // The human is told why, both as a notification and as a log line.
    expect(titlesMatching("auto launch withheld")).toHaveLength(1);
    const withheld = h.sent.find((s) => s.msg.title.includes("auto launch withheld"))!;
    expect(withheld.msg.body).toContain("role 'executor' not in launch whitelist (config.json auto.launch_roles)");
    expect(withheld.msg.task_id).toBe("t1");
    expect(logs.some((l) => l.includes("auto launch withheld") && l.includes("'executor'"))).toBe(true);
  });

  it("absent or empty whitelist withholds everything (conservative default)", async () => {
    const hz1 = makeHarness({ flowMode: "auto" }); // no auto key at all (pre-whitelist hub)
    await hz1.notifier.requestCompare();
    hz1.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto" }));
    await hz1.notifier.requestCompare();
    expect(hz1.launches).toEqual([]);
    expect(titlesMatching("auto launch withheld")).toHaveLength(1);

    const hz2 = makeHarness({ flowMode: "auto", autoRoles: [] }); // explicit empty list
    await hz2.notifier.requestCompare();
    hz2.set(
      state(
        [task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })],
        { flow_mode: "auto", auto: { launch_roles: [] } },
      ),
    );
    await hz2.notifier.requestCompare();
    expect(hz2.launches).toEqual([]);
    expect(titlesMatching("auto launch withheld")).toHaveLength(2); // cumulative across both harnesses
  });

  it("order: the needs_attention gate fires BEFORE the whitelist — a gated, whitelisted role still withholds at the gate", async () => {
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"] });
    // attention already set at baseline (attentionRising false), so the change
    // reaches the auto branch — and its first check (the gate), not the whitelist.
    hz.set(
      state(
        [task({ task_id: "t1", status: "implementing", waiting_for: "agent:architect", needs_attention: true })],
        { flow_mode: "auto", auto: { launch_roles: ["executor"] } },
      ),
    );
    await hz.notifier.requestCompare();
    hz.set(
      state(
        [task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", needs_attention: true, updated_at: U2 })],
        { flow_mode: "auto", auto: { launch_roles: ["executor"] } },
      ),
    );
    await hz.notifier.requestCompare();
    expect(titlesMatching("human decision needed")).toHaveLength(1);
    expect(h.sent.find((s) => s.msg.title.includes("human decision needed"))!.msg.body).toContain("needs_attention set");
    expect(titlesMatching("auto launch withheld")).toHaveLength(0); // not the whitelist notification
    expect(hz.launches).toEqual([]);
  });

  it("the whitelist is read fresh from each poll (a config edit applies without restart)", async () => {
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["architect"] });
    hz.set(
      state(
        [task({ task_id: "t1", status: "designing", waiting_for: "agent:architect" })],
        { flow_mode: "auto", auto: { launch_roles: ["architect"] } },
      ),
    );
    await hz.notifier.requestCompare(); // baseline
    hz.set(
      state(
        [task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })],
        { flow_mode: "auto", auto: { launch_roles: ["architect"] } },
      ),
    );
    await hz.notifier.requestCompare(); // executor withheld
    expect(hz.launches).toEqual([]);
    // launch_roles edited on disk → the next poll's /state snapshot carries it;
    // the following reviewer hand-off (review phase) now auto-launches.
    hz.set(
      state(
        [task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U3 })],
        { flow_mode: "auto", auto: { launch_roles: ["architect", "reviewer"] } },
      ),
    );
    await hz.notifier.requestCompare();
    expect(hz.launches).toEqual([{ taskId: "t1", role: "reviewer", agent: "pi" }]);
  });
});

// --- queue serialization ------------------------------------------------------------------

describe("serial compare queue", () => {
  it("tick and done-event in the same macrotask coalesce into ONE compare+act", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare(); // baseline (fetch #1)
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })]));
    const tick = hz.notifier.requestCompare(); // simulates the interval tick
    hz.notifier.receiveEvent({ event: "done", agent: "codex", pane: "t1" }); // same 拍
    await tick;
    await hz.flush();
    expect(hz.fetchCount()).toBe(2); // baseline + exactly ONE compare
    expect(titlesMatching("waiting for agent:executor")).toHaveLength(1);
    expect(titlesMatching("stopped without publishing")).toHaveLength(0);
  });
});

// --- stall watchdog -------------------------------------------------------------------------

describe("stall watchdog", () => {
  it("notifies once when an agent:* task's updated_at stalls past the timeout", async () => {
    const hz = makeHarness({ stallMin: 30 });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare(); // baseline at t=0
    hz.at(30 * 60_000);
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(1);
    hz.at(45 * 60_000);
    await hz.notifier.requestCompare(); // dedup: no second reminder
    expect(titlesMatching("possibly stalled")).toHaveLength(1);
  });

  it("any updated_at append (e.g. a note) resets the stall timer", async () => {
    const hz = makeHarness({ stallMin: 30 });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.at(29 * 60_000);
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(0);
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })]));
    hz.at(30 * 60_000); // the poll that observes the append resets the timer
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(0);
    hz.at(60 * 60_000); // 30 min since the reset → fires
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(1);
  });

  it("tasks not waiting on an agent never stall", async () => {
    const hz = makeHarness({ stallMin: 30 });
    hz.set(state([task({ task_id: "t1", status: "pending_approval", waiting_for: "human" })]));
    await hz.notifier.requestCompare();
    hz.at(10 * 60 * 60_000);
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(0);
  });

  it("a working event refreshes the internal timer (signal-source observability)", async () => {
    const hz = makeHarness({ stallMin: 30 });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.at(25 * 60_000);
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "working", agent: "codex", pane: "t1" });
    hz.at(35 * 60_000); // 35 min since baseline but only 10 min since the signal
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(0);
  });
});

// --- agent events ------------------------------------------------------------------------------

describe("agent events", () => {
  it("blocked → 'agent stuck' notification with task_id + immediate compare (known pane)", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "blocked", agent: "codex", pane: "t1" });
    await hz.flush();
    expect(titlesMatching("agent stuck")).toHaveLength(1);
    const stuck = h.sent.find((s) => s.msg.title.includes("agent stuck"));
    expect(stuck?.msg.body).toContain("codex");
    expect(stuck?.msg.task_id).toBe("t1"); // real task pane → task_id applies
    expect(hz.fetchCount()).toBe(2); // blocked enqueues a compare (6.1 追加触发)
  });

  it("blocked with an unmatched pane notifies without task_id (pane name is not a task id)", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "blocked", agent: "codex", pane: "who-is-this" });
    await hz.flush();
    expect(titlesMatching("agent stuck")).toHaveLength(1);
    const stuck = h.sent.find((s) => s.msg.title.includes("agent stuck"));
    expect(stuck?.msg.task_id).toBeUndefined(); // omitted — body already names the pane
    expect(stuck?.msg.body).toContain("who-is-this");
    expect(hz.logs.some((l) => l.includes("matches no task"))).toBe(true);
    expect(hz.fetchCount()).toBe(2); // compare still triggered
  });

  it("done + waiting_for advanced by the immediate compare → no cross-validation notify", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U2 })]));
    hz.notifier.receiveEvent({ event: "done", agent: "codex", pane: "t1" });
    await hz.flush();
    expect(hz.fetchCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await hz.flush();
    expect(titlesMatching("stopped without publishing")).toHaveLength(0);
    expect(titlesMatching("waiting for agent:reviewer")).toHaveLength(1); // flow notify as usual
  });

  it("done with no advance → delayed recheck still no advance → 'stopped without publishing'", async () => {
    const hz = makeHarness(); // interval 5s → recheck delay 5s
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "done", agent: "codex", pane: "t1" });
    await hz.flush();
    expect(hz.fetchCount()).toBe(2); // immediate compare ran
    await vi.advanceTimersByTimeAsync(4_999); // before the delay: nothing yet
    expect(hz.fetchCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1); // delay elapses → recheck
    await hz.flush();
    expect(hz.fetchCount()).toBe(3);
    const stopped = h.sent.find((s) => s.msg.title.includes("stopped without publishing"));
    expect(stopped).toBeDefined();
    expect(stopped?.msg.body).toContain("codex");
    expect(stopped?.msg.body).toContain("agent:executor");
  });

  it("done, advance lands WITHIN the recheck window → no notify", async () => {
    const hz = makeHarness();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "done", agent: "codex", pane: "t1" });
    await hz.flush();
    expect(titlesMatching("stopped without publishing")).toHaveLength(0);
    // The publish lands before the 5s recheck fires.
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U2 })]));
    await vi.advanceTimersByTimeAsync(5_000);
    await hz.flush();
    expect(titlesMatching("stopped without publishing")).toHaveLength(0);
  });

  it("done with a pane matching no task degrades to a single compare (4.4 broken)", async () => {
    const hz = makeHarness();
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "done", agent: "codex", pane: "nope" });
    await hz.flush();
    expect(hz.fetchCount()).toBe(2);
    expect(hz.logs.some((l) => l.includes("matches no task"))).toBe(true);
    // No task resolved → no sweep: the pane inventory is never even listed.
    expect(hz.sweepListCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await hz.flush();
    expect(h.sent).toEqual([]);
  });
});

// --- done-event pane sweep (supply hardening) ---------------------------------------

describe("done-event pane sweep: final screens archived into the notify log", () => {
  const T1_EXEC = { pane_id: "w11:p6", label: "t1.executor" };
  const T1_REV = { pane_id: "w11:p3", label: "t1.reviewer" };
  const INVENTORY = [
    { pane_id: "w11:p2", label: "tut-hub" }, // system pane — never swept
    T1_EXEC,
    { pane_id: "w11:p7", label: "t2.executor" }, // ANOTHER task — never swept
    { pane_id: "w11:p1", label: "" }, // the human's unlabeled pane — never swept
    T1_REV,
  ];

  it("snapshots every <T>.* pane with timestamp + label into the log; other panes are never read", async () => {
    const hz = makeHarness({
      panes: INVENTORY,
      screens: {
        "w11:p6": "pi finished the round\n╭──────────╮\n│ done, published │",
        "w11:p3": "idle reviewer seat",
      },
    });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.at(Date.parse("2026-08-23T13:45:02.000Z"));
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "t1.executor" });
    await hz.flush();

    // Positive: BOTH t1.* panes archived, header carries timestamp + label + pane id.
    const AT = "2026-08-23T13:45:02.000Z";
    expect(hz.sweptReads).toEqual(["w11:p6", "w11:p3"]);
    expect(hz.logs.some((l) => l.includes(`[t1] done sweep — pane 't1.executor' (w11:p6) final screen @ ${AT}:`))).toBe(true);
    expect(hz.logs.some((l) => l === `tut: notify: [t1] sweep ${AT} t1.executor | pi finished the round`)).toBe(true);
    expect(hz.logs.some((l) => l === `tut: notify: [t1] sweep ${AT} t1.executor | │ done, published │`)).toBe(true);
    expect(hz.logs.some((l) => l === `tut: notify: [t1] sweep ${AT} t1.reviewer | idle reviewer seat`)).toBe(true);

    // Per-line contract (design: 每行带时间戳与 pane 标签): EVERY screen-content
    // line — multi-line and empty alike — carries a parseable ISO timestamp
    // and the pane label itself; the header is never their only carrier.
    const contentLines = hz.logs.filter((l) => l.includes("] sweep "));
    expect(contentLines.length).toBeGreaterThanOrEqual(3);
    for (const line of contentLines) {
      const m = line.match(/\] sweep (\S+) (\S+) \| /);
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe(AT);
      expect(Number.isNaN(Date.parse(m?.[1] ?? ""))).toBe(false); // parseable ISO
      expect(m?.[2]).toMatch(/^t1\.(executor|reviewer)$/); // pane label on every line
    }

    // Negative: the other task's pane, the system pane, and the unlabeled
    // pane were never read (readPane was called for t1 panes only).
    expect(hz.sweptReads.some((id) => id === "w11:p7" || id === "w11:p2" || id === "w11:p1")).toBe(false);
    expect(hz.logs.some((l) => l.includes("t2.") || l.includes("tut-hub"))).toBe(false);

    // The done flow itself is intact: immediate compare ran.
    expect(hz.fetchCount()).toBe(2);
  });

  it("a task_id prefix never spans into a longer task's namespace (t1. ≠ t1-long.)", async () => {
    const hz = makeHarness({
      panes: [{ pane_id: "w11:p9", label: "t1-long.executor" }],
      screens: { "w11:p9": "other task's seat" },
    });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(hz.sweptReads).toEqual([]);
    expect(hz.logs.some((l) => l.includes("no round panes left to snapshot"))).toBe(true);
  });

  it("an empty screen is logged as an explicit empty observation, not silence", async () => {
    const hz = makeHarness({ panes: [T1_EXEC], screens: {} });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.at(Date.parse("2026-08-23T13:45:02.000Z"));
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(hz.sweptReads).toEqual(["w11:p6"]);
    expect(hz.logs.some((l) => l === "tut: notify: [t1] sweep 2026-08-23T13:45:02.000Z t1.executor | (empty screen)")).toBe(true);
    expect(Number.isNaN(Date.parse("2026-08-23T13:45:02.000Z"))).toBe(false); // parseable, same stamp as the header
  });

  it("pane list failure skips the sweep with a note — the done flow (compare + recheck) survives", async () => {
    const hz = makeHarness({ listPanesFails: "herdr not found" });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("done sweep skipped: pane list failed"))).toBe(true);
    expect(hz.fetchCount()).toBe(2); // immediate compare still ran
    await vi.advanceTimersByTimeAsync(5_000); // recheck fires
    await hz.flush();
    expect(hz.fetchCount()).toBe(3);
    const stopped = h.sent.find((s) => s.msg.title.includes("stopped without publishing"));
    expect(stopped).toBeDefined(); // cross-validation intact
  });

  it("one pane's read failure logs per pane and does not block the others", async () => {
    const hz = makeHarness({
      panes: [T1_EXEC, T1_REV],
      screens: { "w11:p3": "reviewer seat" },
      readPaneFails: ["w11:p6"],
    });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.at(Date.parse("2026-08-23T13:45:02.000Z"));
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("pane 't1.executor' (w11:p6) read failed"))).toBe(true);
    expect(hz.logs.some((l) => l === "tut: notify: [t1] sweep 2026-08-23T13:45:02.000Z t1.reviewer | reviewer seat")).toBe(true);
  });

  it("concurrency barrier: a poll racing the delayed sweep cannot launch the next round first — sweep reads archive BEFORE marker/launch", async () => {
    // The reviewer's probe scenario: done event starts its sweep (pane list
    // blocked on a slow herdr), a poll compare fires concurrently and sees
    // the publish — WITHOUT the barrier the auto launch (and its pane-reaping
    // launcher) would overtake the sweep and the screen evidence is lost.
    const order: string[] = [];
    const hz = makeHarness({
      flowMode: "auto",
      autoRoles: ALL_ROLES.launch_roles,
      panes: [{ pane_id: "w11:p6", label: "t1.executor" }],
      screens: { "w11:p6": "final screen" },
      order,
      sweepDelayMs: 50,
    });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare(); // baseline

    // The publish lands (not yet observed) and the agent exits — the done
    // sweep starts, and a poll compare fires while its pane list is in flight.
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "t1.executor" });
    await hz.flush();
    void hz.notifier.requestCompare(); // the racing poll
    await hz.flush();

    expect(order).toContain("sweep-list-start");
    expect(order).not.toContain("marker"); // launch machinery parked behind the sweep
    expect(order).not.toContain("launch");

    await vi.advanceTimersByTimeAsync(50); // the delayed inventory lands; sweep completes
    await hz.flush();
    await vi.waitFor(() => expect(order).toContain("launch"));

    // THE closing order: sweep read archived BEFORE this task's marker and launch.
    expect(order.indexOf("sweep-read:w11:p6")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("sweep-read:w11:p6")).toBeLessThan(order.indexOf("marker"));
    expect(order.indexOf("marker")).toBeLessThan(order.indexOf("launch"));

    // The existing done cross-validation is intact: the compare observed the
    // advance → no "stopped without publishing".
    await vi.advanceTimersByTimeAsync(10_000);
    await hz.flush();
    expect(titlesMatching("stopped without publishing")).toHaveLength(0);
    expect(titlesMatching("auto-launched reviewer")).toHaveLength(1); // the parked round did launch
  });
});

// --- event→task mapping (role-pane reverse lookup) ----------------------------------

describe("defaultLoadRouting: the real loader reads the three-level chain (cwd L1 + TUT_USER_CONFIG_DIR L2)", () => {
  it("L1 fixture defines the maps; L2 covers roles L1 lacks; legacy labels absent", async () => {
    const { defaultLoadRouting } = await import("../src/notifier.js");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const l1 = mkdtempSync(path.join(os.tmpdir(), "tut-nr-l1-"));
    const l2 = mkdtempSync(path.join(os.tmpdir(), "tut-nr-l2-"));
    mkdirSync(path.join(l1, ".context-hub"), { recursive: true });
    writeFileSync(path.join(l1, ".context-hub", "workspace.json"), JSON.stringify({
      roles: { executor: { agent: "pi" }, architect: { label: "arch", agent: "codex" } },
    }));
    writeFileSync(path.join(l2, "workspace.json"), JSON.stringify({
      roles: { reviewer: { agent: "codex" } },
    }));
    const prevCwd = process.cwd();
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.chdir(l1);
    process.env.TUT_USER_CONFIG_DIR = l2;
    try {
      const maps = await defaultLoadRouting();
      expect(maps.roleToAgent.get("executor")).toBe("pi"); // L1
      expect(maps.roleToAgent.get("architect")).toBe("codex"); // L1 (legacy shape tolerated, .agent read)
      expect(maps.roleToAgent.get("reviewer")).toBe("codex"); // L2 per-role fallback
      expect(maps.labelToAgent.get("pi")).toBe("pi"); // agent-named pane → identity
      expect(maps.labelToAgent.get("codex")).toBe("codex");
      // Legacy label mapping RETIRED — "arch" is not a key.
      expect(maps.labelToAgent.has("arch")).toBe(false);
    } finally {
      process.chdir(prevCwd);
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
      rmSync(l1, { recursive: true, force: true });
      rmSync(l2, { recursive: true, force: true });
    }
  });

  it("no config anywhere → built-in DEFAULT_ROLES with agent-named identities only", async () => {
    const { defaultLoadRouting } = await import("../src/notifier.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const empty = mkdtempSync(path.join(os.tmpdir(), "tut-nr-empty-"));
    const prevCwd = process.cwd();
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.chdir(empty);
    process.env.TUT_USER_CONFIG_DIR = path.join(empty, "l2");
    try {
      const maps = await defaultLoadRouting();
      expect(maps.roleToAgent.get("architect")).toBe("codex");
      expect(maps.roleToAgent.get("executor")).toBe("pi");
      expect(maps.roleToAgent.get("reviewer")).toBe("codex");
      expect([...maps.labelToAgent.keys()].sort()).toEqual(["codex", "pi"]); // identities only
    } finally {
      process.chdir(prevCwd);
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("custom tab-label template regression: template output never enters event→task lookups", () => {
  it("template-bearing config: T.role prefix hit + bare-agent identity chain both resolve; maps carry no template keys", async () => {
    // Under a CUSTOM tab-label template the
    // pane addressing inputs stay template-free — pinned against a fixture
    // that actually carries naming.tab_label (same vector as the launcher
    // test in cli-assign-launch.test.ts).
    const { defaultLoadRouting } = await import("../src/notifier.js");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const l1 = mkdtempSync(path.join(os.tmpdir(), "tut-tmpl-l1-"));
    const l2 = mkdtempSync(path.join(os.tmpdir(), "tut-tmpl-l2-"));
    mkdirSync(path.join(l1, ".context-hub"), { recursive: true });
    writeFileSync(path.join(l1, ".context-hub", "workspace.json"), JSON.stringify({
      naming: { tab_label: "[{task}] {agent}" },
      roles: { executor: { agent: "pi" } },
    }));
    const prevCwd = process.cwd();
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.chdir(l1);
    process.env.TUT_USER_CONFIG_DIR = l2; // empty L2 — roles/template come from L1
    try {
      // The loader itself: roles resolve from the chain; no RENDERED template
      // string may become a lookup key.
      const maps = await defaultLoadRouting();
      expect(maps.roleToAgent.get("executor")).toBe("pi"); // L1 fixture
      expect([...maps.labelToAgent.keys()].sort()).toEqual(["codex", "pi"]); // identities only
      expect(maps.labelToAgent.has("[t1] pi")).toBe(false); // template output ∉ lookup keys

      // Behavioral pin under the SAME fixture: prefix hit + identity chain.
      const hz = makeHarness({ realRouting: true }); // defaultLoadRouting reads the fixture chain
      hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
      await hz.notifier.requestCompare(); // baseline; routing loaded from cwd L1
      hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "t1.executor" }); // (a½) prefix hit
      await hz.flush();
      expect(hz.logs.some((l) => l.includes("working event pane 't1.executor' resolved to task t1"))).toBe(true);
      hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "pi" }); // (b) bare agent name → identity chain
      await hz.flush();
      expect(hz.logs.some((l) => l.includes("working event pane 'pi' resolved to task t1"))).toBe(true);
    } finally {
      process.chdir(prevCwd);
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
      rmSync(l1, { recursive: true, force: true });
      rmSync(l2, { recursive: true, force: true });
    }
  });
});

describe("event→task mapping (agent-keyed panes)", () => {
  // Routing maps mirroring a workspace chain resolving architect=codex,
  // executor=pi, reviewer=codex (agent-keyed; legacy labels are retired —
  // label→agent identity (agent-named panes) +
  // role→default agent.
  const ROUTING = {
    labelToAgent: { codex: "codex", pi: "pi" },
    roleToAgent: { architect: "codex", executor: "pi", reviewer: "codex" },
  };

  it("matches a parameterized cast by its executable head for a bare agent pane", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(
      state([
        task({
          task_id: "cast-event",
          status: "implementing",
          waiting_for: "agent:executor",
          cast: { executor: { agent: "codex", args: ["--model", "gpt-5.6", "--search"] } },
        }),
      ]),
    );
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "working", agent: "codex", pane: "codex" });
    await hz.flush();

    expect(hz.logs.some((l) => l.includes("working event pane 'codex' resolved to task cast-event"))).toBe(true);
  });

  it("retries a round-pane prefix after a working event beats the first state snapshot", async () => {
    const hz = makeHarness({ routing: ROUTING });
    // The task is already in the Hub, but the notifier has not polled it yet.
    // This is the live fresh-pane race: the event carries the exact
    // <task_id>.<role> label before the next /state snapshot exists locally.
    hz.set(state([task({ task_id: "late-one", status: "implementing", waiting_for: "agent:executor" })]));
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "late-one.executor" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("working event pane 'late-one.executor' resolved to task late-one"))).toBe(true);
    expect(hz.logs.some((l) => l.includes("resolves to no task; stall refresh skipped"))).toBe(false);
  });

  it("fresh round pane `<task_id>.<role>`: prefix hit maps directly — no cast/identity resolution needed", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "fresh-one", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "fresh-one.executor" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("resolved to task fresh-one"))).toBe(true);
  });

  it("first round after tut create: designing/waiting agent:architect — `<task_id>.architect` events hit the task via the prefix path from round one", async () => {
    // The task is created on the initiating side BEFORE delivery, so
    // the architect's first pane carries the `<task_id>.architect` label and
    // the prefix reverse lookup hits the task directly on the very first round —
    // the old bare-name kickoff round needed the identity chain instead.
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "kick-one", status: "designing", waiting_for: "agent:architect", cast: { architect: "pi" } })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "kick-one.architect" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("working event pane 'kick-one.architect' resolved to task kick-one"))).toBe(true);
    hz.notifier.receiveEvent({ event: "blocked", agent: "pi", pane: "kick-one.architect" });
    await hz.flush();
    const stuck = h.sent.find((s) => s.msg.title.includes("agent stuck"));
    expect(stuck).toBeDefined();
    expect(stuck?.msg.task_id).toBe("kick-one"); // blocked alert names the task
  });

  it("round-pane prefix not in the snapshot (task gone) → identity chain fallback; no identity → no mapping", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    // "ghost-x.reviewer" — dotted, but its prefix is no live task and the
    // label denotes no agent: resolves to nothing.
    hz.notifier.receiveEvent({ event: "done", agent: "who", pane: "ghost-x.reviewer" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("done event pane 'ghost-x.reviewer' matches no task"))).toBe(true);
    expect(titlesMatching("stopped without publishing")).toHaveLength(0);
  });

  it("dotted label whose prefix IS the waiting task wins even when the label also names an agent-shaped suffix", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "blocked", agent: "pi", pane: "t1.architect" }); // role in label ≠ waiting role — prefix still maps
    await hz.flush();
    const stuck = h.sent.find((s) => s.msg.title.includes("agent stuck"));
    expect(stuck).toBeDefined();
    expect(stuck?.msg.task_id).toBe("t1");
  });

  it("working on a role pane refreshes the stall timer of the waiting task", async () => {
    const hz = makeHarness({ stallMin: 30, routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare(); // baseline, label→role map loaded
    hz.at(25 * 60_000);
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "pi" }); // bare agent-named pane → identity chain (legacy)
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("resolved to task t1"))).toBe(true);
    hz.at(35 * 60_000); // 35 min since baseline, only 10 min since the signal
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(0);
  });

  it("pane name colliding with a task_id AND an agent identity: 4.4 (task) wins over the identity chain", async () => {
    // "pi" is the executor's routed agent, AND a task literally named "pi" is
    // waiting on reviewer — the snapshot hit (4.4) must take priority; the
    // identity lookup would wrongly resolve to the reviewer-waiting task.
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "pi", status: "reviewing", waiting_for: "agent:reviewer" })]));
    await hz.notifier.requestCompare(); // baseline, identity map loaded
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "pi" });
    await hz.flush();
    await vi.advanceTimersByTimeAsync(5_001); // recheck delay elapses (interval 5s)
    await hz.flush();
    const cross = titlesMatching("stopped without publishing");
    expect(cross).toHaveLength(1);
    expect(cross[0]).toContain("pi"); // resolved to the task named "pi" via the snapshot hit
  });

  it("working on a role pane with no waiting task degrades: no stall refresh", async () => {
    const hz = makeHarness({ stallMin: 30, routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer" })]));
    await hz.notifier.requestCompare();
    hz.at(25 * 60_000);
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "pi" }); // bare agent-named pane → identity chain (legacy) // executor not waited on
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("resolves to no task"))).toBe(true);
    hz.at(31 * 60_000); // executor signal must NOT have refreshed t1 (waiting reviewer)
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(1);
  });

  it("blocked on a role pane resolves the waiting task: stuck notice carries task_id", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "blocked", agent: "pi", pane: "pi" });
    await hz.flush();
    const stuck = h.sent.find((s) => s.msg.title.includes("agent stuck"));
    expect(stuck).toBeDefined();
    expect(stuck?.msg.title).toContain("t1");
    expect(stuck?.msg.task_id).toBe("t1");
    expect(stuck?.msg.body).toContain("pane pi");
    expect(hz.logs.some((l) => l.includes("matches no task"))).toBe(false);
  });

  it("done on a role pane with waiting_for advanced by the compare → no cross-validation notify", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U2 })]));
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "pi" });
    await hz.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await hz.flush();
    expect(titlesMatching("stopped without publishing")).toHaveLength(0);
    expect(titlesMatching("waiting for agent:reviewer")).toHaveLength(1);
  });

  it("done on a role pane without publish → 'stopped without publishing' names the resolved task", async () => {
    const hz = makeHarness({ routing: ROUTING }); // interval 5s → recheck delay 5s
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "pi" });
    await hz.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await hz.flush();
    const stopped = h.sent.find((s) => s.msg.title.includes("stopped without publishing"));
    expect(stopped).toBeDefined();
    expect(stopped?.msg.task_id).toBe("t1");
    expect(stopped?.msg.body).toContain("pane pi");
    expect(stopped?.msg.body).toContain("agent:executor");
  });

  it("ambiguity: several tasks waiting on the role → latest updated_at wins + log line", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(
      state([
        task({ task_id: "t-old", status: "implementing", waiting_for: "agent:executor", updated_at: U1 }),
        task({ task_id: "t-new", status: "implementing", waiting_for: "agent:executor", updated_at: U3 }),
      ]),
    );
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "pi" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("2 waiting tasks") && l.includes("t-new"))).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await hz.flush();
    const stopped = h.sent.find((s) => s.msg.title.includes("stopped without publishing"));
    expect(stopped).toBeDefined();
    expect(stopped?.msg.task_id).toBe("t-new");
  });

  it("role pane label with no role entry behaves like an unknown pane (degrade)", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "done", agent: "codex", pane: "some-scratch-pane" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("matches no task"))).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await hz.flush();
    expect(h.sent).toEqual([]); // degrade: compare only, no cross-validation
  });

  it("cast hit: a task routing executor to codex is matched by the codex pane, not the pi pane", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(
      state([
        task({ task_id: "t-cast", status: "implementing", waiting_for: "agent:executor", cast: { executor: "codex" } }),
      ]),
    );
    await hz.notifier.requestCompare();
    // pi is the DEFAULT executor agent, but t-cast routes executor → codex:
    // the pi pane must NOT match, the codex pane must.
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "pi" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("resolves to no task"))).toBe(true);
    hz.notifier.receiveEvent({ event: "working", agent: "codex", pane: "codex" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("resolved to task t-cast"))).toBe(true);
  });

  it("agent-named pane matches the default lineup; legacy label matches the same identity", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    // 'pi' is the agent-named pane; 'exec' is the legacy label
    // — both denote the same agent identity and resolve the same task.
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "pi" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("resolved to task t1"))).toBe(true);
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "pi" }); // bare agent-named pane → identity chain (legacy)
    await hz.flush();
    expect(hz.logs.filter((l) => l.includes("resolved to task t1")).length).toBe(2);
  });

  it("ambiguity across identities: two executor-waiting tasks, one cast-routed — only the matching one resolves", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(
      state([
        task({ task_id: "t-default", status: "implementing", waiting_for: "agent:executor", updated_at: U1 }),
        task({ task_id: "t-cast", status: "implementing", waiting_for: "agent:executor", cast: { executor: "codex" }, updated_at: U3 }),
      ]),
    );
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "pi" });
    await hz.flush();
    // pi matches ONLY t-default (t-cast routes to codex) — no ambiguity.
    expect(hz.logs.some((l) => l.includes("2 waiting tasks"))).toBe(false);
    expect(hz.logs.some((l) => l.includes("resolved to task t-default"))).toBe(true);
  });
});

// --- event HTTP listener ------------------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(
  port: number,
  method: string,
  pathname: string,
  body: string,
  host?: string,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: host === undefined ? {} : { host }, // lowercase; node sends it as Host
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

function noHostRequest(port: number, pathname: string, body: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let raw = "";
    sock.on("connect", () => sock.write(`POST ${pathname} HTTP/1.0\r\nContent-Length: ${body.length}\r\n\r\n${body}`));
    sock.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    sock.on("end", () => {
      const statusLine = raw.split("\r\n", 1)[0] ?? "";
      resolve({ status: Number.parseInt(statusLine.split(" ", 3)[1] ?? "0", 10), body: raw });
    });
    sock.once("error", reject);
  });
}

describe("event HTTP listener (loopback Host guard mirrors src/http.ts)", () => {
  async function startListenerHarness(): Promise<{ hz: Harness; port: number }> {
    vi.useRealTimers();
    const port = await freePort();
    const hz = makeHarness({ eventPort: port });
    await hz.notifier.startEventServer();
    return { hz, port };
  }

  it("accepts a valid done event on POST /agent-event and enqueues a compare", async () => {
    const { hz, port } = await startListenerHarness();
    // state already advanced so the cross-validation early-exits (no timer)
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U2 })]));
    await hz.notifier.requestCompare(); // baseline
    const res = await rawRequest(port, "POST", "/agent-event", JSON.stringify({ event: "done", agent: "codex", pane: "t1" }));
    expect(res.status).toBe(200);
    expect(res.body).toContain('"ok":true');
    await hz.flush();
    expect(hz.fetchCount()).toBe(2);
  });

  it("tolerates an absent Host header (HTTP/1.0-style raw socket)", async () => {
    const { hz, port } = await startListenerHarness();
    const res = await noHostRequest(port, "/agent-event", JSON.stringify({ event: "working", agent: "a", pane: "t1" }));
    expect(res.status).toBe(200);
  });

  it("rejects a non-loopback Host with 403", async () => {
    const { port } = await startListenerHarness();
    const res = await rawRequest(port, "POST", "/agent-event", "{}", "evil.example.com");
    expect(res.status).toBe(403);
    expect(res.body).toContain("forbidden");
  });

  it("invalid JSON → 400, ignored", async () => {
    const { hz, port } = await startListenerHarness();
    const res = await rawRequest(port, "POST", "/agent-event", "not json at all");
    expect(res.status).toBe(400);
    await hz.flush();
    expect(hz.fetchCount()).toBe(0);
  });

  it("unknown event → 200 ignored, no compare; wrong shape → 400", async () => {
    const { hz, port } = await startListenerHarness();
    const unknown = await rawRequest(port, "POST", "/agent-event", JSON.stringify({ event: "zzz", agent: "a", pane: "p" }));
    expect(unknown.status).toBe(200);
    expect(unknown.body).toContain("ignored");
    const badShape = await rawRequest(port, "POST", "/agent-event", JSON.stringify({ event: "done", agent: 1, pane: "p" }));
    expect(badShape.status).toBe(400);
    await hz.flush();
    expect(hz.fetchCount()).toBe(0);
  });

  it("wrong path → 404; GET → 405", async () => {
    const { port } = await startListenerHarness();
    expect((await rawRequest(port, "POST", "/other", "{}")).status).toBe(404);
    expect((await rawRequest(port, "GET", "/agent-event", "")).status).toBe(405);
  });
});

// --- runNotify / cli wiring ----------------------------------------------------------------------

describe("runNotify and cli wiring", () => {
  it("EADDRINUSE on the event port rejects with a visible error mentioning the port", async () => {
    vi.useRealTimers();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      await expect(
        runNotify({ url: "http://127.0.0.1:9", interval: 5, eventPort: port, stallTimeoutMin: 30 }),
      ).rejects.toThrow(new RegExp(`EADDRINUSE.*|.*${port}`));
      await expect(
        runNotify({ url: "http://127.0.0.1:9", interval: 5, eventPort: port, stallTimeoutMin: 30 }),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("HANDLERS.notify exits 1 with a stderr line when the event port is occupied", async () => {
    vi.useRealTimers();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;
    const stderrLines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
      stderrLines.push(String(c));
      return true;
    }) as typeof process.stderr.write);
    try {
      const parsed = parseArgs(["notify", "--event-port", String(port)]);
      expect(parsed.command).toBe("notify");
      const code = await HANDLERS.notify(parsed as Extract<ReturnType<typeof parseArgs>, { command: "notify" }>);
      expect(code).toBe(1);
      expect(stderrLines.some((l) => l.includes("tut: notify:") && l.includes(String(port)))).toBe(true);
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("spawnLaunch stderr tee (delivery diagnostics reach the notify pane)", () => {
  it(
    "tees launch.sh stderr live while resolving stdout on success — tut-delivery lines survive a SUCCESSFUL launch",
    async () => {
      // rationale: the swallowed-Enter lottery is caught by the
      // step-timestamped diagnostics on launch.sh's stderr — which the
      // default launcher used to DISCARD on success. The tee forwards every
      // chunk to this process's stderr (the notify pane, 8.2: stdio is the
      // log) while the promise still resolves with stdout ("").
      vi.useRealTimers();
      const FIXTURE_BIN = path.join(path.resolve(import.meta.dirname, ".."), "test", "bin");
      const log = path.join(os.tmpdir(), `tut-tee-${process.pid}.log`);
      rmSync(log, { force: true });
      const seen: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
        seen.push(String(c));
        return true;
      }) as typeof process.stderr.write);
      try {
        const out = await spawnLaunch("t-tee", "executor", "pi", [], {
          ...process.env,
          PATH: `${FIXTURE_BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          TUT_HERDR_LOG: log,
          TUT_HERDR_PANES: JSON.stringify([
            { pane_id: "w9:p0", label: "hub", workspace_id: "w9", cwd: "/x", agent_status: "idle" },
          ]),
          TUT_SPLIT_BASE: "w9:p0",
          TUT_HUB_URL: "http://127.0.0.1:1", // hub down: file chain + stderr note
          TUT_USER_CONFIG_DIR: path.join(os.tmpdir(), `tut-tee-l2-${process.pid}`),
          TUT_READY_POLL_MS: "20",
          TUT_READY_FLOOR_MS: "0",
          TUT_READY_TIMEOUT_MS: "4000",
          TUT_TEXT_LAND_TIMEOUT_MS: "200",
          TUT_SUBMIT_TIMEOUT_MS: "100",
          TUT_HERDR_READ_SCRIPT: JSON.stringify([
            "",
            "",
            "pi TUI ready — status 0.0%",
            "pi TUI ready — status 0.0%",
            "pi TUI ready ▎prompt",
            "working — round started",
          ]),
        });
        expect(out).toBe(""); // stdout consumed as before
        const text = seen.join("");
        expect(text).toContain("tut-delivery t="); // diagnostics were tee'd
        expect(text).toContain("gate-release pane=FIX:root1");
        expect(text).toContain("submit-confirmed pane=FIX:root1 attempt=1");
        // The birth really ran against the fixture (not a dry-run).
        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        expect(lines).toContain("pane run FIX:root1 cd -- '/x' && env 'PI_SKIP_VERSION_CHECK=1' 'pi'");
      } finally {
        spy.mockRestore();
        rmSync(log, { force: true });
      }
    },
    20_000,
  );
});

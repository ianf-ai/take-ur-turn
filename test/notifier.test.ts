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

// Recording mock for the channel factory: notifier.ts must build its channel
// set from /state's notify value EVERY poll (decision 6).
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

import { Notifier, runNotify, type StateResponse, type StateTask } from "../src/notifier.js";
import { launchBlocked } from "../src/launch.js";
import type { ContextRecord } from "../src/types.js";
import { HANDLERS, parseArgs } from "../src/cli.js";

const U1 = "2026-08-15T10:00:00.000Z";
const U2 = "2026-08-15T10:05:00.000Z";
const U3 = "2026-08-15T10:10:00.000Z";

/** Tests that exercise the auto branch POSITIVELY whitelist
 *  every standard role; withholding cases pin the exact narrower list (or none). */
const ALL_ROLES = { launch_roles: ["architect", "executor", "reviewer"] };

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
  eventPort?: number;
  realLaunch?: boolean;
  /** Agent the injected launch pre-check resolves (default "pi"). */
  agent?: string;
  /** Routing maps for event→task mapping tests; omitted = empty maps (no role panes). */
  routing?: { labelToAgent?: Record<string, string>; roleToAgent?: Record<string, string> };
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
  const launches: { taskId: string; role: string; agent: string }[] = [];
  let fetches = 0;
  const notifier = new Notifier(
    {
      url: "http://127.0.0.1:3001",
      interval: opts.interval ?? 5,
      eventPort: opts.eventPort ?? 3999,
      stallTimeoutMin: opts.stallMin ?? 30,
    },
    {
      fetchState: async (url: string) => {
        if (failing) throw new Error(`connect ECONNREFUSED ${url}`);
        fetches += 1;
        return current;
      },
      ...(opts.realLaunch === true
        ? {}
        : {
            launch: async (taskId: string, role: string, agent: string) => {
              launches.push({ taskId, role, agent });
              return "launched";
            },
          }),
      // launch pre-check (hermetic): the real default hits GET /state of the hub
      // url + `which` — tests inject a fixed resolution instead.
      resolveTarget: async () => opts.agent ?? "pi",
      // Auto-launch provenance is exercised with dedicated injected-deps
      // tests below; the legacy state-only harness keeps an empty log so its
      // synthetic state transitions remain independently focused.
      readLog: async (_taskId: string): Promise<ContextRecord[]> => [],
      markLaunched: async (_taskId: string, _role: string, _baseVersion: number, _via: "start-next" | "auto"): Promise<void> => undefined,
      // Hermetic event→task mapping: tests that don't declare routing get empty maps
      // (the real default reads scripts/workspace.json).
      loadRouting: async () => ({
        labelToAgent: new Map(Object.entries(opts.routing?.labelToAgent ?? {})),
        roleToAgent: new Map(Object.entries(opts.routing?.roleToAgent ?? {})),
      }),
      now: () => nowMs,
      log: (line: string) => {
        logs.push(line);
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
  it("first successful fetch establishes the baseline silently (decision 8)", async () => {
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
    expect(msg.body).toContain("pane: t1");
    expect(msg.task_id).toBe("t1");
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
    // change is detected WITHOUT re-baselining (decision 7 restart semantics
    // apply to process restarts, not failed polls).
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

  it("channel set is rebuilt from /state's notify key every poll (decision 6)", async () => {
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

// --- auto-mode gate (decision 4; /state-only reading) -----------------------------------

describe("auto-mode gate", () => {
  it("launches via launch.sh for an agent:* hand-off and notifies 'auto-launched'", async () => {
    const hz = makeHarness({ flowMode: "auto", autoRoles: ["executor"] });
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor", updated_at: U2 })], { flow_mode: "auto", auto: ALL_ROLES }));
    await hz.notifier.requestCompare();
    expect(hz.launches).toEqual([{ taskId: "t1", role: "executor", agent: "pi" }]);
    expect(titlesMatching("auto-launched executor")).toHaveLength(1);
    expect(titlesMatching("waiting for")).toHaveLength(0); // manual-style notify not used in auto
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
      expect(sendText).toContain("(agent 'pi')");
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
    await vi.advanceTimersByTimeAsync(10_000);
    await hz.flush();
    expect(h.sent).toEqual([]);
  });
});

// --- event→task mapping (role-pane reverse lookup) ----------------------------------

describe("event→task mapping (agent-keyed panes)", () => {
  // Routing maps mirroring a workspace.json of architect=codex, executor=pi,
  // reviewer=codex with legacy labels arch/exec/review: label→agent identity
  // (both agent-named panes and legacy labels) + role→default agent.
  const ROUTING = {
    labelToAgent: { arch: "codex", exec: "pi", review: "codex", codex: "codex", pi: "pi" },
    roleToAgent: { architect: "codex", executor: "pi", reviewer: "codex" },
  };

  it("working on a role pane refreshes the stall timer of the waiting task", async () => {
    const hz = makeHarness({ stallMin: 30, routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare(); // baseline, label→role map loaded
    hz.at(25 * 60_000);
    await hz.notifier.requestCompare();
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "exec" });
    await hz.flush();
    expect(hz.logs.some((l) => l.includes("resolved to task t1"))).toBe(true);
    hz.at(35 * 60_000); // 35 min since baseline, only 10 min since the signal
    await hz.notifier.requestCompare();
    expect(titlesMatching("possibly stalled")).toHaveLength(0);
  });

  it("pane name colliding with a task_id AND a role label: 4.4 (task) wins over label→role", async () => {
    // "exec" is the executor role label, AND a task literally named "exec" is waiting
    // on reviewer — the snapshot hit (4.4) must take priority; the role lookup
    // would wrongly resolve to the reviewer-waiting task.
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "exec", status: "reviewing", waiting_for: "agent:reviewer" })]));
    await hz.notifier.requestCompare(); // baseline, label→role map loaded
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "exec" });
    await hz.flush();
    await vi.advanceTimersByTimeAsync(5_001); // recheck delay elapses (interval 5s)
    await hz.flush();
    const cross = titlesMatching("stopped without publishing");
    expect(cross).toHaveLength(1);
    expect(cross[0]).toContain("exec"); // resolved to the task named "exec" via the snapshot hit
  });

  it("working on a role pane with no waiting task degrades: no stall refresh", async () => {
    const hz = makeHarness({ stallMin: 30, routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer" })]));
    await hz.notifier.requestCompare();
    hz.at(25 * 60_000);
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "exec" }); // executor not waited on
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
    hz.notifier.receiveEvent({ event: "blocked", agent: "pi", pane: "exec" });
    await hz.flush();
    const stuck = h.sent.find((s) => s.msg.title.includes("agent stuck"));
    expect(stuck).toBeDefined();
    expect(stuck?.msg.title).toContain("t1");
    expect(stuck?.msg.task_id).toBe("t1");
    expect(stuck?.msg.body).toContain("exec");
    expect(hz.logs.some((l) => l.includes("matches no task"))).toBe(false);
  });

  it("done on a role pane with waiting_for advanced by the compare → no cross-validation notify", async () => {
    const hz = makeHarness({ routing: ROUTING });
    hz.set(state([task({ task_id: "t1", status: "implementing", waiting_for: "agent:executor" })]));
    await hz.notifier.requestCompare();
    hz.set(state([task({ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", updated_at: U2 })]));
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "exec" });
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
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "exec" });
    await hz.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await hz.flush();
    const stopped = h.sent.find((s) => s.msg.title.includes("stopped without publishing"));
    expect(stopped).toBeDefined();
    expect(stopped?.msg.task_id).toBe("t1");
    expect(stopped?.msg.body).toContain("pane exec");
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
    hz.notifier.receiveEvent({ event: "done", agent: "pi", pane: "exec" });
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
    hz.notifier.receiveEvent({ event: "working", agent: "pi", pane: "exec" });
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

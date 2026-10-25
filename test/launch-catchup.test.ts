import { writeNodeExecutable } from './helpers/executable.js';
/**
 * launch.catchup (Notifier startup catchup) — the offline-window repair:
 * a waiting_for=agent:* edge that landed while the Notifier was down is
 * folded into the baseline snapshot and, without catchup, never launches.
 *
 * Coverage mirrors the reviewed closure conditions:
 *  - the pass function (runLaunchCatchup) is unit-tested on plain seams —
 *    audit honesty (a gate-short-circuited whitelist check reports n/a,
 *    never a false "not in launch_roles"), actions, and dedup handoff;
 *  - the Notifier wiring is exercised against a REAL isolated Hub + real
 *    HeadlessRuntime + fixture agent (no model calls): headless + on
 *    catches up (run + marker + audit line, one-shot), off does nothing,
 *    a valid marker never double-launches, and — the TUI boundary —
 *    tui + on leaves the startup round byte-clean (no marker, no launcher
 *    call, no catchup notification/log; the TUI-path spies stay uncalled);
 *  - the config engine (parse/round-trip/fail-visible reads).
 *
 * Requires a prior `npm run build` (the headless supervisor is the built
 * same-package module, exactly like installed execution — same discipline
 * as launcher-headless.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Notifier, type StateResponse, type StateTask } from "../src/core/notifier/notifier.js";
import { runLaunchCatchup } from "../src/core/notifier/launch-catchup.js";
import type { ContextRecord } from "../src/core/common/types.js";
import { parseConfigValue, readLaunchCatchup, writeConfigKey } from "../src/core/common/config.js";
import { startServer, type RunningServer } from "../src/core/hub/server.js";
import { hubCreate, hubPublish, hubRead } from "../src/core/hub/hub-client.js";
import { HeadlessRuntime } from "../src/standalone/launcher-headless/runtime.js";
import { delay } from "../src/core/run/store.js";

// Source modules exercise policy; the actual detached supervisor is the built
// same-package module used in installed execution (never a PATH tut).
const builtControl = await import(path.resolve("dist/core/run/control.js")) as typeof import("../src/core/run/control.js");

const U1 = "2026-08-15T10:00:00.000Z";
const ALL_ROLES = { launch_roles: ["architect", "executor", "reviewer"] };

function task(overrides: Partial<StateTask> & { task_id: string }): StateTask {
  return {
    title: `title of ${overrides.task_id}`,
    status: "implementing",
    updated_at: U1,
    needs_attention: false,
    waiting_for: "agent:executor",
    version: 1,
    ...overrides,
  };
}

function plainNote(version: number, taskId: string): ContextRecord {
  return {
    version,
    task_id: taskId,
    role: "human",
    content_type: "note",
    timestamp: U1,
    payload: { summary: "plain note", body: "plain note" },
  };
}

function launchMarkerNote(version: number, taskId: string, role: string, baseVersion: number): ContextRecord {
  return {
    version,
    task_id: taskId,
    role: "human",
    content_type: "note",
    timestamp: U1,
    payload: {
      summary: `launch: ${role} (base v${baseVersion})`,
      body: "launch",
      launch: { role, base_version: baseVersion, via: "auto" },
    },
  };
}

// --- the pass function (plain seams) --------------------------------------------------

describe("runLaunchCatchup pass semantics", () => {
  interface PureOpts {
    candidate?: StateTask;
    gate?: string | null;
    inWhitelist?: boolean;
    records?: ContextRecord[];
    readLogFails?: string;
  }

  async function runPure(opts: PureOpts = {}) {
    const lines: string[] = [];
    const launched: { taskId: string; role: string }[] = [];
    const state: StateResponse = {
      flow_mode: "auto",
      tasks: [opts.candidate ?? task({ task_id: "t1" })],
      auto: ALL_ROLES,
    };
    await runLaunchCatchup(state, {
      gateOf: () => opts.gate ?? null,
      whitelisted: () => opts.inWhitelist ?? true,
      readLog: async () => {
        if (opts.readLogFails !== undefined) throw new Error(opts.readLogFails);
        return opts.records ?? [plainNote(1, "t1")];
      },
      launch: async (t, role) => { launched.push({ taskId: t.task_id, role }); },
      log: (line) => { lines.push(line); },
    });
    return { lines, launched };
  }

  it("a gate-blocked candidate whose role IS whitelisted reports whitelist=n/a — never a false 'not in launch_roles'", async () => {
    const { lines, launched } = await runPure({
      candidate: task({ task_id: "t1", needs_attention: true }),
      gate: "needs_attention set",
      inWhitelist: true, // the role is on the list; the check simply never ran
    });
    expect(launched).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("gate=blocked (needs_attention set)");
    expect(lines[0]).toContain("whitelist=n/a (gate withheld)");
    expect(lines[0]).not.toContain("not in launch_roles"); // the false diagnosis is gone
    expect(lines[0]).toContain("action=none (gate: needs_attention set)");
  });

  it("a role genuinely absent from the list is still reported as a whitelist rejection", async () => {
    const { lines, launched } = await runPure({ inWhitelist: false });
    expect(launched).toEqual([]);
    expect(lines[0]).toContain("gate=pass");
    expect(lines[0]).toContain("whitelist=fail ('executor' not in launch_roles)");
    expect(lines[0]).toContain("action=none (role 'executor' not in launch whitelist)");
  });

  it("a fresh candidate launches through the seam with the catchup audit line", async () => {
    const { lines, launched } = await runPure();
    expect(launched).toEqual([{ taskId: "t1", role: "executor" }]);
    expect(lines[0]).toContain("gate=pass | whitelist=pass | dedup=fresh");
    expect(lines[0]).toContain("action=launch (startup catchup)");
  });

  it("a valid launch marker withholds the candidate: dedup verdict in the line, no launch call", async () => {
    const { lines, launched } = await runPure({ records: [plainNote(1, "t1"), launchMarkerNote(2, "t1", "executor", 1)] });
    expect(launched).toEqual([]);
    expect(lines[0]).toContain("dedup=launched@v2");
    expect(lines[0]).toContain("action=none (already launched; launched@v2)");
  });

  it("an unreadable pre-read still hands the candidate to autoLaunch (its internal re-read decides)", async () => {
    const { lines, launched } = await runPure({ readLogFails: "EISDIR" });
    expect(launched).toEqual([{ taskId: "t1", role: "executor" }]);
    expect(lines[0]).toContain("action=launch attempt (catchup; dedup re-read inside autoLaunch; pre-read unreadable (EISDIR))");
  });

  it("non-agent-waiting tasks are not catchup questions: no line, no launch", async () => {
    const { lines, launched } = await runPure({ candidate: task({ task_id: "t1", waiting_for: "human", status: "pending_approval" }) });
    expect(lines).toEqual([]);
    expect(launched).toEqual([]);
  });
});

// --- the Notifier wiring (real Hub + real headless runtime) ---------------------------

const roots: string[] = [];
const notifiers: Notifier[] = [];
const servers: RunningServer[] = [];

interface RigOpts {
  /** config.json content; flow_mode defaults to auto, auto whitelist to ALL_ROLES. */
  config?: Record<string, unknown>;
}

/** Real isolated rig: tmp root, fixture agent (no model), real server,
 *  real HeadlessRuntime with the BUILT supervisor. The TUI-path seams are
 *  forbidden spies — their call count is the "no launcher invocation" proof. */
async function makeRig(opts: RigOpts = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tut-catchup-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const agentFile = path.join(bin, "codex");
  const agent = writeNodeExecutable(agentFile, `console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-1111-1111-111111111111'}));`);
  mkdirSync(path.join(root, ".context-hub"), { recursive: true });
  writeFileSync(path.join(root, ".context-hub", "config.json"), JSON.stringify({
    flow_mode: "auto",
    auto: ALL_ROLES,
    ...(opts.config ?? {}),
  }));
  vi.stubEnv("TUT_HUB_ROOT", root);
  vi.stubEnv("TUT_PROJECT_ROOT", root);
  const server = await startServer({ root: path.join(root, ".context-hub"), port: 0 });
  servers.push(server);
  const logs: string[] = [];
  const messages: { title: string; body: string }[] = [];
  const runtime = new HeadlessRuntime(root, {
    start: builtControl.startRun,
    stop: builtControl.stopRun,
    send: async (msg) => { messages.push(msg); },
    log: (line) => { logs.push(line); },
    read: async (id) => (await hubRead(server.url, id)).versions,
  });
  const forbidden = vi.fn(async () => { throw new Error("TUI path must not be touched by startup catchup"); });
  const notifier = new Notifier(
    { url: server.url, eventPort: 1, interval: 1, stallTimeoutMin: 0 },
    {
      headlessRuntime: runtime,
      channelsFor: () => [{ name: "desktop", send: async (msg) => { messages.push(msg); } }],
      log: (line) => { logs.push(line); },
      listAnchorPanes: forbidden,
      listPanes: forbidden,
      launch: forbidden,
      cleanupPanes: forbidden,
      remediator: { remediate: forbidden },
      relayHostStatus: async () => {},
    },
  );
  notifiers.push(notifier);
  // The offline window: the task exists BEFORE the notifier's first poll.
  const created = await hubCreate(server.url, {
    title: "offline-window fixture",
    description: "isolated catchup test task",
    creator: "test",
    role: "human",
    flow: "direct",
    cast: { executor: agent },
  });
  const taskId = created.task_id;
  const runsOf = () => runtime.runs().filter((m) => m.task_id === taskId);
  const markers = async () => (await hubRead(server.url, taskId)).versions.filter((r) => r.payload.launch !== undefined);
  return { root, server, runtime, notifier, logs, messages, forbidden, taskId, runsOf, markers };
}

async function until(fn: () => boolean | Promise<boolean>, ms = process.platform === "win32" ? 45000 : 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!await fn()) {
    if (performance.now() > end) throw new Error("condition timed out");
    await delay(25);
  }
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  for (const n of notifiers.splice(0)) await n.close().catch(() => undefined);
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // No audit records or runs are deleted; temp roots survive for diagnosis.
});

describe("launch.catchup wiring (headless-only repair)", () => {
  it.each(["detached", "headless"])("%s + on: the missed offline edge gets its round — run + marker + audit line — exactly once", async (mode) => {
    const rig = await makeRig({ config: { launch_mode: mode, launch: { catchup: "on" } } }); // subject is headless-only repair — pinned explicit
    await rig.notifier.requestCompare(); // baseline folds the waiting edge; catchup must repair it

    await until(() => rig.runsOf().length === 1);
    await until(() => rig.runsOf().every((m) => m.ended_at !== undefined));
    const run = rig.runsOf()[0]!;
    expect(run.headless).toMatchObject({ role: "executor" });
    expect(await rig.markers()).toHaveLength(1);
    const line = rig.logs.find((l) => l.includes(`[${rig.taskId}] catchup-decision:`));
    expect(line).toBeDefined();
    expect(line).toContain("waiting_for=agent:executor");
    expect(line).toContain("gate=pass | whitelist=pass | dedup=fresh");
    expect(line).toContain("action=launch (startup catchup)");

    // one-shot: quiet polls never re-run the pass (no wake note, no new run)
    await rig.notifier.requestCompare();
    await rig.notifier.requestCompare();
    expect(rig.runsOf()).toHaveLength(1);
    expect(await rig.markers()).toHaveLength(1);
    expect(rig.logs.filter((l) => l.includes("catchup-decision:"))).toHaveLength(1);
    expect(rig.forbidden).not.toHaveBeenCalled();
  });

  it("default off (no launch section): the same startup state produces no run, no marker, no catchup bytes", async () => {
    const rig = await makeRig(); // catchup key absent → off
    await rig.notifier.requestCompare();
    await new Promise((resolve) => setTimeout(resolve, 100)); // nothing async may be in flight

    expect(rig.runsOf()).toEqual([]);
    expect(await rig.markers()).toEqual([]);
    expect(rig.messages).toEqual([]);
    expect(rig.logs.some((l) => l.includes("catchup-decision:") || l.includes("launch catchup"))).toBe(false);
    // the baseline itself is unchanged (baseline line + auto-decision line)
    expect(rig.logs.some((l) => l.includes("baseline:") && l.includes("flow_mode=auto"))).toBe(true);
    expect(rig.logs.some((l) => l.includes("action=none (baseline poll; acting is edge-triggered)"))).toBe(true);
  });

  it("headless + on with a pre-existing valid marker: dedup holds — no second run, no second marker", async () => {
    const rig = await makeRig({ config: { launch_mode: "headless", launch: { catchup: "on" } } });
    // the round was already served while the notifier was down
    await hubPublish(rig.server.url, {
      task_id: rig.taskId,
      role: "human",
      content_type: "note",
      payload: {
        summary: "launch: executor (base v1)",
        body: "Recorded launch of executor via auto at task log base version 1.",
        launch: { role: "executor", base_version: 1, via: "auto" },
      },
    });
    const servedAt = `v${(await rig.markers())[0]!.version}`; // where the served marker actually landed
    await rig.notifier.requestCompare();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(rig.runsOf()).toEqual([]);
    expect(await rig.markers()).toHaveLength(1); // the pre-existing one only
    const line = rig.logs.find((l) => l.includes(`[${rig.taskId}] catchup-decision:`));
    expect(line).toContain(`dedup=launched@${servedAt}`);
    expect(line).toContain(`action=none (already launched; launched@${servedAt})`);
  });

  it("tui + on: the startup round stays byte-clean — no marker, no launcher call, no catchup notification/log", async () => {
    const rig = await makeRig({ config: { launch_mode: "tui", launch: { catchup: "on" } } });
    await rig.notifier.requestCompare();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(rig.runsOf()).toEqual([]); // no headless run either
    expect(await rig.markers()).toEqual([]); // no launch marker appended
    expect(rig.messages).toEqual([]); // no notification of any kind
    expect(rig.logs.some((l) => l.includes("catchup-decision:") || l.includes("launch catchup"))).toBe(false); // zero catchup log bytes
    expect(rig.forbidden).not.toHaveBeenCalled(); // launch / listAnchorPanes / listPanes / remediator untouched
    // the TUI baseline output is exactly the pre-catchup shape
    expect(rig.logs.some((l) => l.includes("baseline:") && l.includes("flow_mode=auto"))).toBe(true);
    expect(rig.logs.some((l) => l.includes("action=none (baseline poll; acting is edge-triggered)"))).toBe(true);
  });

  it("tui + on + manual: the startup round matches the pre-catchup baseline — no catchup log at all", async () => {
    const rig = await makeRig({ config: { launch_mode: "tui", flow_mode: "manual", launch: { catchup: "on" } } });
    await rig.notifier.requestCompare();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(rig.runsOf()).toEqual([]);
    expect(await rig.markers()).toEqual([]);
    expect(rig.messages).toEqual([]);
    expect(rig.forbidden).not.toHaveBeenCalled();
    // the manual skip line must NOT appear before the silent TUI return
    expect(rig.logs.some((l) => l.includes("catchup-decision:") || l.includes("launch catchup"))).toBe(false);
    // and the whole startup output is the pre-catchup manual baseline shape
    expect(rig.logs.some((l) => l.includes("baseline:") && l.includes("flow_mode=manual"))).toBe(true);
    expect(rig.logs.some((l) => l.includes("auto-decision:"))).toBe(false); // manual mode never logs decision lines
  });

  it("manual flow_mode with the switch on: one visible skip line, no run", async () => {
    const rig = await makeRig({ config: { launch_mode: "headless", flow_mode: "manual", launch: { catchup: "on" } } });
    await rig.notifier.requestCompare();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(rig.runsOf()).toEqual([]);
    expect(await rig.markers()).toEqual([]);
    expect(rig.logs.some((l) => l.includes("launch catchup skipped: flow_mode is not auto"))).toBe(true);
    expect(rig.logs.some((l) => l.includes("catchup-decision:"))).toBe(false);
  });

  it("an illegal switch value is fail-visible: ONE withheld line, no catchup round", async () => {
    const rig = await makeRig({ config: { launch: { catchup: "sometimes" } } });
    await rig.notifier.requestCompare();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(rig.runsOf()).toEqual([]);
    expect(await rig.markers()).toEqual([]);
    expect(rig.logs.some((l) => l.includes("launch catchup withheld: invalid launch.catchup"))).toBe(true);
    expect(rig.logs.some((l) => l.includes("catchup-decision:"))).toBe(false);
  });
});

// --- config engine -------------------------------------------------------------------

describe("launch.catchup config engine", () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tut-catchup-cfg-"));
    root = path.join(tmp, ".context-hub");
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parseConfigValue accepts off/on and rejects anything else with the domain", () => {
    expect(parseConfigValue("launch.catchup", "on")).toEqual({ ok: true, assignment: { key: "launch.catchup", value: "on" } });
    expect(parseConfigValue("launch.catchup", "off")).toEqual({ ok: true, assignment: { key: "launch.catchup", value: "off" } });
    const bad = parseConfigValue("launch.catchup", "maybe");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('expected "off" | "on"');
  });

  it("readLaunchCatchup: missing file / absent key default off; illegal value throws", async () => {
    expect(await readLaunchCatchup(root)).toBe("off"); // no config.json at all
    expect(existsSync(path.join(root, "config.json"))).toBe(false); // the default read writes nothing
    const file = path.join(root, "config.json");
    writeFileSync(file, JSON.stringify({ flow_mode: "auto" }), "utf8");
    expect(await readLaunchCatchup(root)).toBe("off"); // no launch section
    writeFileSync(file, JSON.stringify({ flow_mode: "auto", launch: { catchup: "on" } }), "utf8");
    expect(await readLaunchCatchup(root)).toBe("on");
    writeFileSync(file, JSON.stringify({ flow_mode: "auto", launch: { catchup: "sometimes" } }), "utf8");
    await expect(readLaunchCatchup(root)).rejects.toThrow('invalid launch.catchup (expected "off" | "on")');
    writeFileSync(file, JSON.stringify({ flow_mode: "auto", launch: 3 }), "utf8");
    await expect(readLaunchCatchup(root)).rejects.toThrow('invalid launch.catchup (expected "off" | "on")');
    writeFileSync(file, "{ not json", "utf8");
    await expect(readLaunchCatchup(root)).rejects.toThrow("unreadable or corrupt");
  });

  it("writeConfigKey round-trips and preserves launch-section siblings + top-level keys", async () => {
    const file = path.join(root, "config.json");
    writeFileSync(file, JSON.stringify({ flow_mode: "auto", launch_mode: "tui", launch: { other: true }, future: 3 }), "utf8");

    await writeConfigKey(root, { key: "launch.catchup", value: "on" });
    const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({ flow_mode: "auto", launch_mode: "tui", future: 3, launch: { other: true, catchup: "on" } });
    expect(await readLaunchCatchup(root)).toBe("on");

    await writeConfigKey(root, { key: "launch.catchup", value: "off" });
    expect(await readLaunchCatchup(root)).toBe("off");
  });
});

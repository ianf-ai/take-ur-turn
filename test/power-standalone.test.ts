/**
 * Power lifecycle integration (power.mode=standalone + tut down).
 *
 * Real processes against the built dist CLI (the rig-isolation convention):
 * up's detached children are REAL `node dist/cli.js serve|notify` processes,
 * down addresses real process groups on POSIX and creation-verified service
 * trees on Windows; runs use their native process container. Token-query gates
 * delay the real OS query; they never invent process identities.
 * Requires `npm run build` before the suite (same as rig-isolation).
 *
 * Covers the acceptance scenarios:
 *   - standalone full journey (up → probes alive → down → all stopped →
 *     idempotent repeat), with fact preservation across idempotent ups;
 *   - multi-rig isolation (two roots, independent up/down);
 *   - run survival (down never stops runs; survivors are named);
 *   - down edges (herdr refusal, nothing-to-stop, corrupt power.json,
 *     injected sleeper stop via SIGTERM, SIGKILL escalation, already-stopped).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { main } from "../src/cli.js";
import { runDoctor } from "../src/core/doctor/index.js";
import { adoptService } from "../src/standalone/power/reconcile.js";
import { type PowerState, readPowerState, writePowerState, processStartToken } from "../src/standalone/power/standalone-up.js";

import { stopWindowsService, terminateWindowsProcess, windowsProcesses, type WindowsProcess } from "../src/standalone/power/windows.js";
import * as windowsPower from "../src/standalone/power/windows.js";
import { writeNodeExecutable } from "./helpers/executable.js";
import { stopWindowsFixtureRuns } from "./helpers/run-cleanup.js";

const WINDOWS = process.platform === "win32";
const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "dist", "cli.js");
const SAVED_CWD = process.cwd();
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ["TUT_UP_CLI_SELF", "TUT_UP_HUB_WAIT_MS", "TUT_UP_NOTIFY_WAIT_MS", "TUT_DOWN_GRACE_MS"]) {
  SAVED_ENV[key] = process.env[key];
}
const TRASH: string[] = [];
const STRAY_PIDS: number[] = [];
const OWNED_CHILDREN = new Map<number, ChildProcess>();
const NATIVE_IDENTITIES = new Map<number, WindowsProcess>();

// PGIDs describe POSIX groups only. Windows fixtures exercise the approved
// creation-identity/tree contract; they must never fabricate a positive PGID.
function serviceScope(pid: number | null): { pgid: number | null; process_scope?: "windows-tree" } {
  return WINDOWS ? { pgid: null, process_scope: "windows-tree" } : { pgid: pid };
}

function rememberServices(state: PowerState): void {
  if (!WINDOWS) return;
  for (const facts of [state.hub, state.notifier, state.watcher]) {
    if (facts?.pid && /^windows:[1-9]\d*$/.test(facts.start_token ?? "")) {
      NATIVE_IDENTITIES.set(facts.pid, { pid: facts.pid, parent: 0, token: facts.start_token!, command: null });
    }
  }
}

/** A standalone-mode TUT project root with a realpath-safe path. */
function makeRig(tag: string, usageAudit: "on" | "off" = "off"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `tut-power-${tag}-`));
  TRASH.push(dir);
  mkdirSync(path.join(dir, ".context-hub"), { recursive: true });
  writeFileSync(path.join(dir, ".context-hub", "config.json"), JSON.stringify({ flow_mode: "manual", usage_audit: usageAudit, power: { mode: "standalone" } }));
  process.env.TUT_UP_CLI_SELF = CLI;
  process.chdir(dir);
  return dir;
}

function captureIo(): { out: () => string; err: () => string; restore: () => void } {
  let outText = "";
  let errText = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    outText += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errText += String(chunk);
    return true;
  });
  return { out: () => outText, err: () => errText, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

function alive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function killPid(pid: number | null | undefined): Promise<void> {
  if (pid === null || pid === undefined || !alive(pid)) return;
  if (WINDOWS) {
    const child = OWNED_CHILDREN.get(pid);
    // Node's ChildProcess owns the original Windows process handle. For a
    // detached service we only terminate a handle matching its recorded birth.
    if (child) child.kill("SIGKILL");
    else {
      const identity = NATIVE_IDENTITIES.get(pid);
      if (!identity) throw new Error(`power fixture cannot attribute cleanup PID ${pid}`);
      await terminateWindowsProcess(identity);
    }
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 25));
    if (alive(pid)) throw new Error(`power fixture PID ${pid} did not exit`);
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

function readState(root: string): PowerState {
  const state = JSON.parse(readFileSync(path.join(root, ".context-hub", "power.json"), "utf8")) as PowerState;
  rememberServices(state);
  return state;
}

/** A real detached sleeper as a stand-in service process group. */
function sleeper(script: string): number {
  const finiteScript = WINDOWS ? script + ";setTimeout(() => process.exit(124), 180000).unref();" : script;
  const child = spawn(process.execPath, ["-e", finiteScript], { detached: true, stdio: "ignore" });
  child.unref();
  STRAY_PIDS.push(child.pid!);
  OWNED_CHILDREN.set(child.pid!, child);
  return child.pid!;
}

/** A guaranteed-dead, guaranteed-unique pid (spawned then reaped). */
function deadPid(): number {
  // Reap before returning: blocking on alive() prevents an async child's
  // exit callback from running and can return a still-observable zombie.
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", timeout: 2000 });
  if (child.error) throw child.error;
  if (child.status !== 0 || !child.pid) throw new Error("dead-pid fixture did not exit successfully");
  return child.pid;
}

/** Windows counterpart of the POSIX group-leader matrix. A real live tree
 * is captured and stopped; an already orphaned descendant cannot be attributed
 * by a dead numeric parent. The completed-state shortcut only checks recorded
 * leaders/endpoints, so it deliberately makes no orphan-container guarantee. */
async function windowsLeaderMatrix(): Promise<void> {
  const start = async (tag: string) => {
    const root = makeRig(tag);
    const handoff = path.join(root, "child.json");
    const go = path.join(root, "leader-exit");
    const script = path.join(root, "leader.cjs");
    writeFileSync(script, `
      const fs = require("node:fs"), cp = require("node:child_process");
      const child = cp.spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(124),180000)"], {detached:true,stdio:"ignore"});
      child.unref();
      fs.writeFileSync(${JSON.stringify(handoff)}, JSON.stringify({pid:child.pid}));
      setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) process.exit(0); }, 25);
      setTimeout(()=>process.exit(124),180000).unref();
    `);
    const leader = spawn(process.execPath, [script], {detached:true,stdio:"ignore"});
    leader.unref();
    OWNED_CHILDREN.set(leader.pid!, leader);
    STRAY_PIDS.push(leader.pid!);
    let child: {pid:number} | undefined;
    for (let i=0;i<200&&!child;i++) {
      await new Promise(resolve=>setTimeout(resolve,25));
      try { child=JSON.parse(readFileSync(handoff,"utf8")); } catch { /* pending */ }
    }
    expect(child).toBeDefined();
    const rows = await windowsProcesses();
    const descendant = rows.find(row=>row.pid===child!.pid)!;
    expect(descendant?.parent).toBe(leader.pid);
    expect(descendant.token).toMatch(/^windows:\d+$/);
    NATIVE_IDENTITIES.set(descendant.pid,descendant);
    STRAY_PIDS.push(descendant.pid);
    const token=await processStartToken(leader.pid!);
    expect(token).toMatch(/^windows:\d+$/);
    return {root,go,leader:leader.pid!,child:descendant.pid,token};
  };
  const record = (tree: Awaited<ReturnType<typeof start>>, token: string|null, completed=false) => {
    writeFileSync(path.join(tree.root,".context-hub","power.json"),JSON.stringify({
      mode:"standalone",started_at:new Date().toISOString(),
      hub:{url:"http://127.0.0.1:1",port:1,pid:tree.leader,...serviceScope(tree.leader),started_at:new Date().toISOString(),start_token:token},
      notifier:{event_port:1,pid:null,pgid:null,started_at:new Date().toISOString(),start_token:null},
      ...(completed?{stopped_at:"2026-01-01T00:00:00.000Z"}:{})
    }));
  };
  const tree=await start("native-leader-live");
  record(tree,tree.token);
  const io=captureIo();
  try {
    expect(await main(["down"])).toBe(0);
    expect(io.out()).toContain("Windows identity-verified tree");
    expect(alive(tree.leader)).toBe(false);
    expect(alive(tree.child)).toBe(false);
  } finally {io.restore();}
  for(const tokenKind of ["no-token","wrong-token","real-token"] as const) {
    for(const completed of [false,true]) {
      const orphan=await start(`native-leader-${tokenKind}-${completed}`);
      writeFileSync(orphan.go,"exit original leader");
      for(let i=0;i<200&&alive(orphan.leader);i++) await new Promise(resolve=>setTimeout(resolve,25));
      expect(alive(orphan.leader)).toBe(false);
      expect(alive(orphan.child)).toBe(true);
      record(orphan,tokenKind==="no-token"?null:tokenKind==="wrong-token"?"windows:0":orphan.token,completed);
      const io=captureIo();
      try {
        expect(await main(["down"])).toBe(completed?0:1);
        if(completed) {
          expect(io.out()).toContain("already stopped");
          expect(readState(orphan.root).stopped_at).toBe("2026-01-01T00:00:00.000Z");
        } else {
          expect(io.err()).toContain(tokenKind==="no-token"?"no Windows creation token recorded":"no Job Object container to attribute orphan descendants (documented-gap)");
          expect(io.out()).toContain("NOT recording a stop");
          expect(readState(orphan.root).stopped_at).toBeUndefined();
        }
        expect(alive(orphan.child)).toBe(true);
      } finally {io.restore();await killPid(orphan.child);}
    }
  }
}

/** Delay one native identity query while another real actor makes progress.
 * Always release and join up before removing the spy or cleaning the rig. */
async function overlapWindowsUp(pid: number, duringProbe: () => Promise<void>): Promise<void> {
  const actual = windowsPower.windowsStartToken;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; release(); }, 30_000);
  const probe = vi.spyOn(windowsPower, "windowsStartToken").mockImplementation(async candidate => {
    if (candidate === pid) { entered = true; await gate; }
    return actual(candidate);
  });
  const up = main(["up"]);
  try {
    for (let i = 0; i < 400 && !entered; i++) await new Promise(resolve => setTimeout(resolve, 25));
    expect(entered).toBe(true);
    await duringProbe();
    expect(timedOut).toBe(false);
    release();
    expect(await up).toBe(0);
  } finally {
    release();
    await up.catch(() => undefined);
    clearTimeout(deadline);
    probe.mockRestore();
  }
}

/** Real notifier → launch --cleanup → native forwarder → neutral Node helper.
 * The Windows power unit deliberately has no Job container for power services: after losing the
 * leader, Windows must refuse the orphan tree rather than trust POSIX registry
 * PGIDs. POSIX callers below retain their original registry-cleanup assertions. */
async function windowsCleanupChain(phase: "single" | "before-registration" | "after-registration" | "overlap"): Promise<void> {
  const root = makeRig(`native-chain-${phase}`);
  const storage = path.join(root, ".context-hub");
  const handoff = path.join(root, "native-helper.json");
  const release = path.join(root, "helper-release");
  const fixture = writeNodeExecutable(path.join(root, "herdr-fixture"), `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(handoff)}, JSON.stringify({pid:process.pid,ppid:process.ppid}));
    const hold = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(hold); process.exit(0); } }, 50);
  `);
  const oldExecutable = process.env.TUT_HERDR_EXECUTABLE;
  process.env.TUT_HERDR_EXECUTABLE = fixture;
  // Advisory POSIX history must remain byte-identical even with an overlap.
  const registry = path.join(storage, "power-members.jsonl");
  const originalRegistry = '{corrupt\n' + JSON.stringify({pid:1,pgid:2,power_session:"unrelated",kind:"x",registered_at:new Date().toISOString(),start_token:"ps:x"}) + "\n";
  writeFileSync(registry, originalRegistry);
  const io = captureIo();
  try {
    const { Store } = await import("../src/core/hub/store.js");
    const { hubPublish } = await import("../src/core/hub/hub-client.js");
    const task = await new Store(storage).createTask({ title: "native power cleanup fixture", description: "temporary", creator: "test", role: "human", flow: "direct" });
    expect(await main(["up"])).toBe(0);
    const first = readState(root);
    expect(first.notifier.pgid).toBeNull();
    expect(first.notifier.process_scope).toBe("windows-tree");
    expect(first.notifier.power_session).toBeTruthy();
    const repeat = async () => {
      expect(await main(["up"])).toBe(0);
      const next = readState(root);
      expect(next.notifier.pid).toBe(first.notifier.pid);
      expect(next.notifier.start_token).toBe(first.notifier.start_token);
      expect(next.notifier.power_session).toBe(first.notifier.power_session);
      expect(readFileSync(registry, "utf8")).toBe(originalRegistry);
    };
    if (phase === "before-registration") await repeat();
    let chain!: { pid: number; ppid: number };
    const closeAndCapture = async () => {
      await hubPublish(first.hub.url, { task_id: task.task_id, role: "human", content_type: "decision", expected_version: 0,
        payload: { summary: "close fixture", body: "exercise real notifier cleanup", decision: "close" } });
      for (let i = 0; i < 300 && !chain; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { chain = JSON.parse(readFileSync(handoff, "utf8")); } catch { /* handoff pending */ }
      }
      expect(chain).toBeDefined();
      // The native executable adds a parent. Verify the entire real ancestry
      // while its leader lives, retaining each creation identity for cleanup.
      const rows = await windowsProcesses();
      let row = rows.find(candidate => candidate.pid === chain.pid)!;
      expect(row?.parent).toBe(chain.ppid);
      const lineage = new Set<number>();
      while (row && row.pid !== first.notifier.pid && !lineage.has(row.pid)) {
        lineage.add(row.pid);
        expect(row.token).toMatch(/^windows:\d+$/);
        NATIVE_IDENTITIES.set(row.pid, row);
        STRAY_PIDS.push(row.pid);
        const parent = rows.find(candidate => candidate.pid === row.parent)!;
        expect(parent?.token).toMatch(/^windows:\d+$/);
        expect(BigInt(row.token!.slice(8)) >= BigInt(parent.token!.slice(8))).toBe(true);
        row = parent;
      }
      expect(row?.pid).toBe(first.notifier.pid);
      expect(lineage.size).toBeGreaterThanOrEqual(3);
      expect(readFileSync(registry, "utf8")).toBe(originalRegistry);
    };
    if (phase === "overlap") {
      await overlapWindowsUp(first.notifier.pid!, closeAndCapture);
      expect(readState(root).notifier.power_session).toBe(first.notifier.power_session);
    } else {
      await closeAndCapture();
      if (phase === "after-registration") await repeat();
    }
    await killPid(first.notifier.pid); // verified original leader only
    expect(alive(chain.pid)).toBe(true);
    expect(await main(["down"])).toBe(1);
    expect(io.err()).toContain("no Job Object container to attribute orphan descendants (documented-gap)");
    expect(io.out()).toContain("NOT recording a stop");
    expect(readState(root).stopped_at).toBeUndefined();
    expect(alive(chain.pid)).toBe(true);
    expect(readFileSync(registry, "utf8")).toBe(originalRegistry);
  } finally {
    io.restore();
    if (oldExecutable === undefined) delete process.env.TUT_HERDR_EXECUTABLE;
    else process.env.TUT_HERDR_EXECUTABLE = oldExecutable;
    // Join the neutral fixture before the identity-verified fallback cleanup.
    writeFileSync(release, "release");
  }
}

beforeEach(() => {
  delete process.env.TUT_UP_HUB_WAIT_MS;
  delete process.env.TUT_UP_NOTIFY_WAIT_MS;
  delete process.env.TUT_DOWN_GRACE_MS;
});

afterEach(async () => {
  process.chdir(SAVED_CWD);
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const roots = TRASH.splice(0);
  const errors: unknown[] = [];
  try { await stopWindowsFixtureRuns(roots); } catch (error) { errors.push(error); }
  for (const root of roots) {
    // Public down runs before state deletion; the fallback addresses only
    // service identities captured from this rig, never a numeric PID sweep.
    const io = captureIo();
    try {
      process.chdir(root);
      await main(["down"]).catch(() => undefined);
    } catch { /* fallback below */ }
    finally { io.restore(); process.chdir(SAVED_CWD); }
    let state: PowerState | undefined;
    try { state = readState(root); } catch { /* absent/corrupt fixture state */ }
    for (const pid of [state?.hub.pid, state?.notifier.pid, state?.watcher?.pid]) {
      try { await killPid(pid); } catch (error) { errors.push(error); }
    }
  }
  // Owned sleepers include deliberately stale/null-token rejection fixtures.
  for (const pid of STRAY_PIDS.splice(0)) {
    try { await killPid(pid); } catch (error) { errors.push(error); }
  }
  OWNED_CHILDREN.clear();
  NATIVE_IDENTITIES.clear();
  if (errors.length) throw new AggregateError(errors, "power fixture cleanup unverified; roots retained");
  for (const root of roots) {
    // Let libuv drain original child-handle close callbacks while Windows
    // releases cwd handles; synchronous retry loops prevent that progress.
    if (WINDOWS) await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

describe("standalone full journey (real hub + notifier + down)", () => {
  it("up provisions detached services with recorded facts; down stops them; repeat down is idempotent", async () => {
    const root = makeRig("journey", "on"); // usage_audit on: the watcher rides the journey too
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(0);
      const first = readState(root);
      expect(first.mode).toBe("standalone");
      expect(first.hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(alive(first.hub.pid)).toBe(true);
      expect(alive(first.notifier.pid)).toBe(true);
      expect(first.hub.pgid).toBe(WINDOWS ? null : first.hub.pid);
      if (WINDOWS) {
        for (const facts of [first.hub, first.notifier, first.watcher!]) {
          expect(facts.process_scope).toBe("windows-tree");
          expect(facts.start_token).toMatch(/^windows:\d+$/);
        }
      }
      expect(first.watcher?.pid).toBeDefined();
      expect(alive(first.watcher?.pid ?? null)).toBe(true); // the third service is live too
      // Both services answer for THIS root (the probe discipline).
      const state = await (await fetch(`${first.hub.url}/state`)).json() as { hub_root: string };
      expect(state.hub_root).toBe(realpathSync(root));
      const event = await fetch(`http://127.0.0.1:${first.notifier.event_port}/agent-event`);
      expect(event.status).toBe(405);
      expect((event.headers.get("allow") ?? "").toUpperCase()).toContain("POST");

      // Idempotent second up: services reused, process facts AND power
      // sessions preserved (the live trees still carry them — see registry policy).
      expect(await main(["up"])).toBe(0);
      expect(io.out()).toContain("hub already running");
      expect(io.out()).toContain("notify already listening");
      const second = readState(root);
      expect(second.hub.pid).toBe(first.hub.pid);
      expect(second.notifier.pid).toBe(first.notifier.pid);
      expect(second.hub.power_session).toBe(first.hub.power_session);
      expect(second.notifier.power_session).toBe(first.notifier.power_session);

      // Down stops everything, records the stop, exits 0.
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("standalone rig");
      expect(alive(first.hub.pid)).toBe(false);
      expect(alive(first.notifier.pid)).toBe(false);
      expect(alive(first.watcher?.pid ?? null)).toBe(false);
      const stopped = readState(root);
      expect(stopped.stopped_at).toBeDefined();
      expect(await fetch(`${first.hub.url}/state`).catch(() => undefined)).toBeUndefined();

      // Repeated down: idempotent no-op.
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("already stopped");
    } finally { io.restore(); }
  }, WINDOWS ? 180_000 : 90_000);
});

describe("multi-rig isolation (two roots)", () => {
  it("two rigs take distinct port pairs; downing one leaves the other serving", async () => {
    const rootA = makeRig("a");
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(0);
      const a = readState(rootA);
      const rootB = makeRig("b");
      expect(await main(["up"])).toBe(0);
      const b = readState(rootB);
      expect(b.hub.url).not.toBe(a.hub.url);

      // Down A: B's services must keep answering with B's identity.
      process.chdir(rootA);
      expect(await main(["down"])).toBe(0);
      expect(alive(a.hub.pid)).toBe(false);
      const bState = await (await fetch(`${b.hub.url}/state`)).json() as { hub_root: string };
      expect(bState.hub_root).toBe(realpathSync(rootB));
      const bEvent = await fetch(`http://127.0.0.1:${b.notifier.event_port}/agent-event`);
      expect(bEvent.status).toBe(405);

      process.chdir(rootB);
      const downB = await main(["down"]);
      expect(downB, JSON.stringify({ root: rootB, stdout: io.out(), stderr: io.err(), state: readState(rootB) })).toBe(0);
      expect(alive(b.hub.pid)).toBe(false);
    } finally { io.restore(); }
  }, WINDOWS ? 240_000 : 120_000);
});

describe("run survival (down never stops runs)", () => {
  it("a live run survives down and is named in the output", async () => {
    const root = makeRig("runs");
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(0);
      // A real run (its own detached process group) via the built CLI.
      const { stdout } = await exec(process.execPath, [CLI, "run", "--", process.execPath, "-e", "setTimeout(() => {}, 120000)"], { cwd: root });
      const runId = stdout.trim().split("\n").pop()!.trim();
      const meta = JSON.parse(readFileSync(path.join(root, ".context-hub", "runs", runId, "meta.json"), "utf8")) as { pid: number };
      expect(alive(meta.pid)).toBe(true);

      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("keep running");
      expect(io.out()).toContain(runId);
      expect(alive(meta.pid)).toBe(true); // THE assertion: the run outlived the rig
      expect(existsSync(path.join(root, ".context-hub", "runs", runId, "meta.json"))).toBe(true);
      if (WINDOWS) await stopWindowsFixtureRuns([root]);
      else await killPid(meta.pid);
    } finally { io.restore(); }
  }, WINDOWS ? 180_000 : 90_000);
});

describe("down edges (injected state, no full rig)", () => {
  it("herdr mode (default and explicit) refuses with the pane pointer, never silently", async () => {
    const root = makeRig("herdr-down");
    writeFileSync(path.join(root, ".context-hub", "config.json"), JSON.stringify({ flow_mode: "manual" }));
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(1);
      expect(io.err()).toContain("power.mode is herdr");
      expect(io.err()).toContain("herdr pane close");
      expect(io.err()).toContain("tut config set power.mode standalone");
      writeFileSync(path.join(root, ".context-hub", "config.json"), JSON.stringify({ flow_mode: "manual", power: { mode: "herdr" } }));
      expect(await main(["down"])).toBe(1);
    } finally { io.restore(); }
  });

  it("standalone mode with no power.json: nothing to stop, exit 0", async () => {
    const root = makeRig("empty-down");
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("nothing to stop");
    } finally { io.restore(); }
  });

  it("corrupt power.json fails visibly", async () => {
    const root = makeRig("corrupt-down");
    writeFileSync(path.join(root, ".context-hub", "power.json"), "{corrupt");
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(1);
      expect(io.err()).toContain("corrupt JSON");
    } finally { io.restore(); }
  });

  it("stops injected sleeper process groups via SIGTERM and reports services without facts", async () => {
    const root = makeRig("inject-term");
    const notifierPid = sleeper("setTimeout(() => {}, 60000)");
    const state = {
      mode: "standalone",
      started_at: new Date().toISOString(),
      hub: { url: "http://127.0.0.1:1", port: 1, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null }, // verified-but-not-ours: no facts to signal
      notifier: { event_port: 1, pid: notifierPid, ...serviceScope(notifierPid), started_at: new Date().toISOString(), start_token: await processStartToken(notifierPid) },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    process.env.TUT_DOWN_GRACE_MS = "400";
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("notifier stopped");
      expect(alive(notifierPid)).toBe(false);
      expect(io.err()).toContain("no pid recorded"); // hub entry without facts: fail-visible note
      expect(readState(root).stopped_at).toBeDefined();
    } finally { io.restore(); }
  });

  it("a recycled pid (stale record, wrong start token) is never signaled — visible refusal", async () => {
    const root = makeRig("inject-stale");
    const innocent = sleeper("setTimeout(() => {}, 60000)"); // a live, unrelated process under the recorded pid
    const state = {
      mode: "standalone",
      started_at: new Date().toISOString(),
      hub: { url: "http://127.0.0.1:1", port: 1, pid: innocent, ...serviceScope(innocent), started_at: "2026-01-01T00:00:00.000Z", start_token: WINDOWS ? "windows:0" : "ps:Wed Jan  1 00:00:00 2020" },
      notifier: { event_port: 1, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(1);
      expect(io.err()).toContain(WINDOWS ? "service PID identity changed" : "no longer matches the recorded process");
      expect(io.err()).toContain(WINDOWS ? "stop unverified" : "NOT signaling");
      expect(io.out()).toContain("NOT recording a stop");
      expect(alive(innocent)).toBe(true); // THE assertion: the unrelated process survives
      expect(readState(root).stopped_at).toBeUndefined();
    } finally { io.restore(); }
  });

  it("an unverifiable identity (no recorded token) conservatively refuses to signal", async () => {
    const root = makeRig("inject-unverified");
    const innocent = sleeper("setTimeout(() => {}, 60000)");
    const state = {
      mode: "standalone",
      started_at: new Date().toISOString(),
      hub: { url: "http://127.0.0.1:1", port: 1, pid: innocent, ...serviceScope(innocent), started_at: new Date().toISOString(), start_token: null },
      notifier: { event_port: 1, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(1);
      expect(io.err()).toContain(WINDOWS ? "no Windows creation token recorded" : "identity cannot be verified");
      expect(io.err()).toContain(WINDOWS ? "stop unverified" : "NOT signaling");
      expect(alive(innocent)).toBe(true);
    } finally { io.restore(); }
  });

  it("escalates to SIGKILL when a service ignores SIGTERM", async () => {
    const root = makeRig("inject-kill");
    const stubbornPid = sleeper("process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)");
    const deadNotifier = deadPid();
    const state = {
      mode: "standalone",
      started_at: new Date().toISOString(),
      hub: { url: "http://127.0.0.1:1", port: 1, pid: stubbornPid, ...serviceScope(stubbornPid), started_at: new Date().toISOString(), start_token: await processStartToken(stubbornPid) },
      notifier: { event_port: 1, pid: deadNotifier, ...serviceScope(deadNotifier), ...(WINDOWS ? { stopped_at: new Date().toISOString() } : {}), started_at: new Date().toISOString(), start_token: WINDOWS ? "windows:0" : "ps:Wed Jan  1 00:00:00 2020" },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    process.env.TUT_DOWN_GRACE_MS = "300";
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain(WINDOWS ? "Windows identity-verified tree" : "force-killed");
      expect(alive(stubbornPid)).toBe(false);
    } finally { io.restore(); }
  });

  it("a leader that exits first never masks stubborn group members (group-scoped stop)", async () => {
    if (WINDOWS) { await windowsLeaderMatrix(); return; }
    const root = makeRig("inject-group");
    // A real detached service group: leader + a stubborn child in the SAME group.
    const handoff = path.join(root, "group.json");
    writeFileSync(path.join(root, "leader.mjs"), [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)"], { stdio: "ignore" });`,
      'child.unref();',
      'writeFileSync(process.argv[2], JSON.stringify({ leader: process.pid, child: child.pid }));',
      '// variant A: stay alive until SIGTERM (leader exits on TERM, child ignores it)',
      'process.on("SIGTERM", () => process.exit(0));',
      'setInterval(() => {}, 1000);',
      '',
    ].join("\n"));
    spawn(process.execPath, [path.join(root, "leader.mjs"), handoff], { detached: true, stdio: "ignore" }).unref();
    let group: { leader: number; child: number } | undefined;
    for (let i = 0; i < 50 && group === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { group = JSON.parse(readFileSync(handoff, "utf8")) as { leader: number; child: number }; } catch { /* not written yet */ }
    }
    expect(group).toBeDefined();
    const { leader, child } = group!;
    expect(alive(child)).toBe(true);
    const state = {
      mode: "standalone",
      started_at: new Date().toISOString(),
      hub: { url: "http://127.0.0.1:1", port: 1, pid: leader, ...serviceScope(leader), started_at: new Date().toISOString(), start_token: await processStartToken(leader) },
      notifier: { event_port: 1, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    process.env.TUT_DOWN_GRACE_MS = "300";
    const io = captureIo();
    try {
      // Variant A: leader alive now, exits on TERM; the stubborn child forces escalation.
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain(WINDOWS ? "Windows identity-verified tree" : "force-killed");
      expect(alive(child)).toBe(false); // THE assertion: the masked member was escalated, not skipped
    } finally { io.restore(); }
    // Variant B — the reviewer's verification matrix (review v11): a live group whose
    // recorded leader already exited is UNATTRIBUTABLE (dead pids have no
    // derivable token; a retired pgid can name any later process group).
    // All four stale-record combos — token null/wrong × stopped_at on/off —
    // plus the strongest case (a token captured from the real leader before
    // it died) must refuse: member survives, exit 1, visible reason, and no
    // false "stopped".
    const leaderScript2 = [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync, existsSync } from "node:fs";',
      `const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)"], { stdio: "ignore" });`,
      'child.unref();',
      'const handoff = process.argv[2];',
      'writeFileSync(handoff, JSON.stringify({ leader: process.pid, child: child.pid }));',
      '// hold the group until the test has captured the start token (go-file handshake)',
      'const go = handoff + ".go";',
      'for (let i = 0; i < 200 && !existsSync(go); i++) await new Promise((r) => setTimeout(r, 50));',
      'process.exit(0); // leader exits on demand; the member holds the group',
      '',
    ].join("\n");
    for (const tokenKind of ["no-token", "wrong-token", "real-token"] as const) {
      for (const recordedStop of [false, true]) {
        const root2 = makeRig(`f1-dead-${tokenKind}-${recordedStop ? "stopped" : "active"}`);
        writeFileSync(path.join(root2, "leader.mjs"), leaderScript2);
        const handoff2 = path.join(root2, "group.json");
        const leader = spawn(process.execPath, [path.join(root2, "leader.mjs"), handoff2], { detached: true, stdio: "ignore" });
        leader.unref();
        let group2: { leader: number; child: number } | undefined;
        for (let i = 0; i < 50 && group2 === undefined; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          try { group2 = JSON.parse(readFileSync(handoff2, "utf8")) as { leader: number; child: number }; } catch { /* not written yet */ }
        }
        expect(group2).toBeDefined();
        const leader2 = group2!.leader;
        const realToken = await processStartToken(leader2); // captured while the leader lives (go-file held)
        writeFileSync(`${handoff2}.go`, ""); // release the leader
        for (let i = 0; i < 100 && alive(leader2); i++) await new Promise((resolve) => setTimeout(resolve, 50));
        expect(alive(leader2)).toBe(false); // leader really exited first
        expect(alive(group2!.child)).toBe(true); // the member holds the group
        const token = tokenKind === "no-token" ? null : tokenKind === "wrong-token" ? "ps:Wed Jan  1 00:00:00 2020" : realToken;
        writeFileSync(path.join(root2, ".context-hub", "power.json"), JSON.stringify({
          mode: "standalone",
          started_at: "2026-01-01T00:00:00.000Z",
          hub: { url: "http://127.0.0.1:1", port: 1, pid: null, pgid: null, started_at: "2026-01-01T00:00:00.000Z", start_token: null },
          notifier: { event_port: 1, pid: leader2, ...serviceScope(leader2), started_at: "2026-01-01T00:00:00.000Z", ...(token !== null ? { start_token: token } : { start_token: null }) },
          ...(recordedStop ? { stopped_at: "2026-01-01T00:00:00.000Z" } : {}),
        }));
        const io2 = captureIo();
        try {
          const code = await main(["down"]);
          expect(code).toBe(1);
          expect(io2.err()).toContain("can no longer be attributed");
          expect(io2.err()).toContain("NOT signaling");
          expect(io2.out()).not.toContain("force-killed");
          expect(io2.out()).toContain("NOT recording a stop");
          expect(alive(group2!.child)).toBe(true); // THE assertion: the member survives every stale-record combo
        } finally {
          io2.restore();
          await killPid(group2!.child);
        }
      }
    }
  }, WINDOWS ? 180_000 : 60_000);

  it("a recorded stop with dead pids reports already stopped without side effects", async () => {
    const root = makeRig("already");
    const hubPid = deadPid();
    const notifierPid = deadPid();
    const state = {
      mode: "standalone",
      started_at: new Date().toISOString(),
      hub: { url: "http://127.0.0.1:1", port: 1, pid: hubPid, ...serviceScope(hubPid), started_at: new Date().toISOString() },
      notifier: { event_port: 1, pid: notifierPid, ...serviceScope(notifierPid), started_at: new Date().toISOString() },
      stopped_at: new Date().toISOString(),
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("already stopped");
      expect(io.out()).not.toContain("stopped (pid"); // no service was signaled
    } finally { io.restore(); }
  });
});

describe("a failed down never records completion; retries re-verify (real services)", () => {
  it("null-pid facts with live endpoints: repeated downs fail, never claim stopped; real stop then idempotent", async () => {
    const root = makeRig("f2");
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(0);
      const real = readState(root);
      expect(alive(real.hub.pid)).toBe(true);
      // The reviewer's repro shape: endpoints alive, pid facts lost.
      writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify({
        mode: "standalone",
        started_at: new Date().toISOString(),
        hub: { url: real.hub.url, port: real.hub.port, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null },
        notifier: { event_port: real.notifier.event_port, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null },
      }));
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(await main(["down"])).toBe(1);
        expect(io.out()).not.toContain("already stopped");
        expect(io.out()).toContain("NOT recording a stop");
        expect(io.err()).toContain("still answers");
        expect(readState(root).stopped_at).toBeUndefined();
      }
      // Manual stop of the real services, then down verifies and records.
      await killPid(real.notifier.pid);
      await killPid(real.hub.pid);
      for (let i = 0; i < 50 && (alive(real.hub.pid) || alive(real.notifier.pid)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await main(["down"])).toBe(0);
      expect(readState(root).stopped_at).toBeDefined();
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("already stopped");
    } finally { io.restore(); }
  }, WINDOWS ? 180_000 : 90_000);
});

describe("a failed up reaps everything it raised (no unmanageable leftovers)", () => {
  it("final state write failure: spawned hub/notifier are stopped, ports closed, no false state", async () => {
    const root = makeRig("f3-write");
    mkdirSync(path.join(root, ".context-hub", "power.json")); // the state path is a directory → rename fails
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(1);
      // The pids this run printed are dead — parsed from up's own output.
      const pids = [...io.out().matchAll(/standalone pid (\d+)/g)].map((m) => Number(m[1]));
      expect(pids).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const pid of pids) expect(alive(pid)).toBe(false);
      const hubUrl = io.out().match(/hub serving on (\S+)/)?.[1];
      expect(hubUrl).toBeDefined();
      expect(await fetch(`${hubUrl}/state`).catch(() => undefined)).toBeUndefined();
      expect(io.err()).toMatch(WINDOWS ? /EISDIR|EPERM|EEXIST/ : /EISDIR/);
    } finally { io.restore(); }
  }, WINDOWS ? 180_000 : 60_000);

  it("notifier log open failure: the already-spawned hub is reaped too", async () => {
    const root = makeRig("f3-log");
    mkdirSync(path.join(root, ".context-hub", "power-notify.log")); // openSync(log, "a") throws EISDIR
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(1);
      const hubPid = Number(io.out().match(/standalone pid (\d+)/)?.[1]);
      expect(Number.isFinite(hubPid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(hubPid)).toBe(false); // THE assertion: the half-born hub did not survive
      const hubUrl = io.out().match(/hub serving on (\S+)/)?.[1];
      expect(await fetch(`${hubUrl}/state`).catch(() => undefined)).toBeUndefined();
    } finally { io.restore(); }
  }, WINDOWS ? 180_000 : 60_000);
});

describe("real notifier leftover group (registry-attributed cleanup)", () => {
  it("a close-cleanup launch child survives its dead leader and down cleans it via the power registry", async () => {
    if (WINDOWS) { await windowsCleanupChain("single"); return; }
    const root = makeRig("f4r1");
    // A harmless herdr fixture: reports its pid/ppid, ignores SIGTERM (the
    // hang shape), persists until killed — exactly the reviewer's chain.
    const handoff = path.join(root, "herdr-child.json");
    const fixture = path.join(root, "herdr-fixture");
    writeFileSync(fixture, "#!/usr/bin/env node\n" +
      'const fs = require("node:fs");\n' +
      'fs.writeFileSync(process.env.TUT_TEST_HANDOFF, JSON.stringify({ pid: process.pid, ppid: process.ppid }));\n' +
      'process.on("SIGTERM", () => {});\n' +
      'setInterval(() => {}, 1000);\n', { mode: 0o755 });
    process.env.TUT_HERDR_EXECUTABLE = fixture;
    process.env.TUT_TEST_HANDOFF = handoff;
    process.env.TUT_DOWN_GRACE_MS = "300";
    const io = captureIo();
    try {
      // A task that exists before up; closing it drives the real notifier →
      // `launch --cleanup` child chain (spawnDirect: same process group).
      const { Store } = await import("../src/core/hub/store.js");
      const { hubPublish } = await import("../src/core/hub/hub-client.js");
      const task = await new Store(path.join(root, ".context-hub")).createTask({
        title: "Leftover cleanup fixture", description: "temporary", creator: "test", role: "human", flow: "direct",
      });
      expect(await main(["up"])).toBe(0);
      const state = readState(root);
      expect(state.notifier.power_session).toBeDefined();
      await hubPublish(state.hub.url, {
        task_id: task.task_id, role: "human", content_type: "decision", expected_version: 0,
        payload: { summary: "close fixture", body: "close to exercise notifier cleanup", decision: "close" },
      });
      let chain: { pid: number; ppid: number } | undefined;
      for (let i = 0; i < 200 && chain === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try { chain = JSON.parse(readFileSync(handoff, "utf8")) as { pid: number; ppid: number }; } catch { /* not yet */ }
      }
      expect(chain).toBeDefined(); // the notifier spawned the real cleanup chain
      const launcher = chain!.ppid;
      const helper = chain!.pid;
      // The hang shape: freeze both children, kill ONLY the notifier leader.
      process.kill(launcher, "SIGSTOP");
      process.kill(helper, "SIGSTOP");
      process.kill(state.notifier.pid!, "SIGKILL");
      for (let i = 0; i < 100 && alive(state.notifier.pid); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(alive(state.notifier.pid)).toBe(false);
      expect(alive(launcher)).toBe(true); // the leftover group is leaderless

      // down must attribute the group through the registry and clean it.
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("verifies against this rig's power registry");
      expect(io.out()).toContain("cleaning up the leftover group");
      expect(alive(launcher)).toBe(false);
      expect(alive(helper)).toBe(false); // the TERM-immune frozen member died by escalation
      expect(readState(root).stopped_at).toBeDefined();
      expect(existsSync(path.join(root, ".context-hub", "power-members.jsonl"))).toBe(false); // pruned on verified stop
    } finally {
      io.restore();
      delete process.env.TUT_HERDR_EXECUTABLE;
      delete process.env.TUT_TEST_HANDOFF;
    }
  }, WINDOWS ? 240_000 : 120_000);

  it("registry round-trip tolerates corrupt lines; up never rewrites it (no lost-append window)", async () => {
    const root = makeRig("registry");
    const { appendPowerMember, readPowerMembers } = await import("../src/standalone/power/standalone-up.js");
    const storageDir = path.join(root, ".context-hub");
    writeFileSync(path.join(storageDir, "power-members.jsonl"), "{corrupt\n" + JSON.stringify({ pid: 1, pgid: 2, power_session: "other", kind: "x", registered_at: new Date().toISOString(), start_token: "ps:x" }) + "\n");
    await appendPowerMember(storageDir, { pid: deadPid(), pgid: 1, power_session: "stale-dead", kind: "launch:cleanup", registered_at: new Date().toISOString(), start_token: WINDOWS ? "windows:0" : "ps:Wed Jan  1 00:00:00 2020" }); // retireable junk — must still not be touched
    const members = await readPowerMembers(storageDir);
    expect(members).toHaveLength(2); // corrupt line skipped, both well-formed lines kept
    expect(members.filter((m: { power_session: string }) => m.power_session === "other")).toHaveLength(1);
    const beforeUp = readFileSync(path.join(storageDir, "power-members.jsonl"), "utf8");
    // up NEVER rewrites the registry — a read-filter-rewrite races
    // with concurrent launch appends (lost update deletes a fresh live
    // member). Stale lines (dead pids, tokenless) linger harmlessly until
    // the verified-stop prune; the file must be BYTE-IDENTICAL across an up
    // even when it contains retireable junk.
    expect(await main(["up"])).toBe(0);
    expect(readFileSync(path.join(storageDir, "power-members.jsonl"), "utf8")).toBe(beforeUp); // untouched: no rewrite, no lost append window
  });
});

describe("an idempotent up keeps reused-service sessions and live member registration", () => {
  for (const phase of ["before-registration", "after-registration"] as const) {
    it(`repeat up ${phase} preserves attribution: leaderless leftover group still cleans up`, async () => {
    if (WINDOWS) { await windowsCleanupChain(phase); return; }
      const root = makeRig(`f4r2-${phase === "before-registration" ? "before" : "after"}`);
      const handoff = path.join(root, "herdr-child.json");
      const fixture = path.join(root, "herdr-fixture");
      writeFileSync(fixture, "#!/usr/bin/env node\n" +
        'const fs = require("node:fs");\n' +
        'fs.writeFileSync(process.env.TUT_TEST_HANDOFF, JSON.stringify({ pid: process.pid, ppid: process.ppid }));\n' +
        'process.on("SIGTERM", () => {});\n' +
        'setInterval(() => {}, 1000);\n', { mode: 0o755 });
      process.env.TUT_HERDR_EXECUTABLE = fixture;
      process.env.TUT_TEST_HANDOFF = handoff;
      process.env.TUT_DOWN_GRACE_MS = "300";
      const io = captureIo();
      try {
        const { Store } = await import("../src/core/hub/store.js");
        const { hubPublish } = await import("../src/core/hub/hub-client.js");
        const task = await new Store(path.join(root, ".context-hub")).createTask({
          title: "power fixture", description: "temporary", creator: "test", role: "human", flow: "direct",
        });
        expect(await main(["up"])).toBe(0);
        const first = readState(root);
        const notifySession = first.notifier.power_session;
        expect(notifySession).toBeDefined();

        let chain: { pid: number; ppid: number } | undefined;
        if (phase === "before-registration") {
          // Repeat up BEFORE the close drives any child: sessions must bind to
          // the reused trees, not to the up invocation.
          expect(await main(["up"])).toBe(0);
          expect(io.out()).toContain("notify already listening");
          const afterRepeat = readState(root);
          expect(afterRepeat.notifier.pid).toBe(first.notifier.pid);
          expect(afterRepeat.notifier.power_session).toBe(notifySession); // NOT rotated
          await hubPublish(first.hub.url, {
            task_id: task.task_id, role: "human", content_type: "decision", expected_version: 0,
            payload: { summary: "close fixture", body: "close to exercise notifier cleanup", decision: "close" },
          });
          for (let i = 0; i < 200 && chain === undefined; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            try { chain = JSON.parse(readFileSync(handoff, "utf8")) as { pid: number; ppid: number }; } catch { /* not yet */ }
          }
        } else {
          await hubPublish(first.hub.url, {
            task_id: task.task_id, role: "human", content_type: "decision", expected_version: 0,
            payload: { summary: "close fixture", body: "close to exercise notifier cleanup", decision: "close" },
          });
          for (let i = 0; i < 200 && chain === undefined; i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            try { chain = JSON.parse(readFileSync(handoff, "utf8")) as { pid: number; ppid: number }; } catch { /* not yet */ }
          }
          // Repeat up AFTER the member registered and froze: the live registry
          // line must survive the maintenance pass.
          const { readPowerMembers } = await import("../src/standalone/power/standalone-up.js");
          const membersBefore = await readPowerMembers(path.join(root, ".context-hub"));
          expect(membersBefore.some((m: { pid: number }) => m.pid === chain!.ppid)).toBe(true);
          process.kill(chain!.ppid, "SIGSTOP");
          process.kill(chain!.pid, "SIGSTOP");
          expect(await main(["up"])).toBe(0);
          const membersAfter = await readPowerMembers(path.join(root, ".context-hub"));
          expect(membersAfter.some((m: { pid: number }) => m.pid === chain!.ppid)).toBe(true); // live member kept 
          const afterRepeat = readState(root);
          expect(afterRepeat.notifier.power_session).toBe(notifySession); // NOT rotated
        }
        expect(chain).toBeDefined();
        const launcher = chain!.ppid;
        const helper = chain!.pid;
        if (phase === "before-registration") {
          process.kill(launcher, "SIGSTOP");
          process.kill(helper, "SIGSTOP");
        }
        process.kill(first.notifier.pid!, "SIGKILL");
        for (let i = 0; i < 100 && alive(first.notifier.pid); i++) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(alive(launcher)).toBe(true); // the leftover group is leaderless

        expect(await main(["down"])).toBe(0);
        expect(io.out()).toContain("verifies against this rig's power registry");
        expect(alive(launcher)).toBe(false);
        expect(alive(helper)).toBe(false);
        expect(readState(root).stopped_at).toBeDefined();
      } finally {
        io.restore();
        delete process.env.TUT_HERDR_EXECUTABLE;
        delete process.env.TUT_TEST_HANDOFF;
      }
    }, WINDOWS ? 240_000 : 150_000);
  }
});

describe("an up overlapping a real launch registration never loses the member", () => {
  it("second up frozen mid-flight while the close-cleanup child registers: the line survives, the leaderless group still cleans up", async () => {
    if (WINDOWS) { await windowsCleanupChain("overlap"); return; }
    const root = makeRig("f4r3");
    const handoff = path.join(root, "herdr-child.json");
    const fixture = path.join(root, "herdr-fixture");
    writeFileSync(fixture, "#!/usr/bin/env node\n" +
      'const fs = require("node:fs");\n' +
      'fs.writeFileSync(process.env.TUT_TEST_HANDOFF, JSON.stringify({ pid: process.pid, ppid: process.ppid }));\n' +
      'process.on("SIGTERM", () => {});\n' +
      'setInterval(() => {}, 1000);\n', { mode: 0o755 });
    process.env.TUT_HERDR_EXECUTABLE = fixture;
    process.env.TUT_TEST_HANDOFF = handoff;
    process.env.TUT_DOWN_GRACE_MS = "300";
    const io = captureIo();
    try {
      const { Store } = await import("../src/core/hub/store.js");
      const { hubPublish } = await import("../src/core/hub/hub-client.js");
      const { readPowerMembers } = await import("../src/standalone/power/standalone-up.js");
      const task = await new Store(path.join(root, ".context-hub")).createTask({
        title: "power fixture", description: "temporary", creator: "test", role: "human", flow: "direct",
      });
      expect(await main(["up"])).toBe(0);
      const first = readState(root);

      // A PATH-injected ps delegate: forwards every call to /bin/ps, but the
      // ONE probe of the frozen pid (the live notifier) blocks until release —
      // pinning the second up mid-flight exactly across the registration.
      const binDir = path.join(root, "bin");
      mkdirSync(binDir, { recursive: true });
      const ready = path.join(root, "ps-ready");
      const release = path.join(root, "ps-release");
      const frozenPid = String(first.notifier.pid);
      writeFileSync(path.join(binDir, "ps"), "#!/usr/bin/env node\n" +
        'const fs = require("node:fs"), cp = require("node:child_process");\n' +
        "const a = process.argv.slice(2);\n" +
        "(async () => {\n" +
        "  if (a[0] === \"-p\" && a[1] === process.env.TUT_TEST_PS_PID) {\n" +
        "    fs.writeFileSync(process.env.TUT_TEST_PS_READY, \"ready\");\n" +
        "    while (!fs.existsSync(process.env.TUT_TEST_PS_RELEASE)) await new Promise((r) => setTimeout(r, 5));\n" +
        "  }\n" +
        "  const r = cp.spawnSync(\"/bin/ps\", a, { encoding: \"utf8\" });\n" +
        "  process.stdout.write(r.stdout || \"\"); process.stderr.write(r.stderr || \"\"); process.exitCode = r.status ?? 1;\n" +
        "})();\n", { mode: 0o755 });

      const savedPath = process.env.PATH;
      process.env.PATH = [binDir, savedPath].join(path.delimiter);
      process.env.TUT_TEST_PS_PID = frozenPid;
      process.env.TUT_TEST_PS_READY = ready;
      process.env.TUT_TEST_PS_RELEASE = release;
      let upPromise: Promise<number> | undefined;
      let chain: { pid: number; ppid: number } | undefined;
      try {
        upPromise = main(["up"]); // second up — will freeze verifying the reused notifier
        for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(existsSync(ready)).toBe(true); // the up is frozen mid-flight
        // While it is frozen, the real notifier spawns launch --cleanup and
        // the child appends its registry line.
        await hubPublish(first.hub.url, {
          task_id: task.task_id, role: "human", content_type: "decision", expected_version: 0,
          payload: { summary: "close fixture", body: "close to exercise notifier cleanup", decision: "close" },
        });
        for (let i = 0; i < 200 && chain === undefined; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          try { chain = JSON.parse(readFileSync(handoff, "utf8")) as { pid: number; ppid: number }; } catch { /* not yet */ }
        }
        expect(chain).toBeDefined(); // registered DURING the up's window
        const membersMid = await readPowerMembers(path.join(root, ".context-hub"));
        expect(membersMid.some((m: { pid: number }) => m.pid === chain!.ppid)).toBe(true);
        writeFileSync(release, "release"); // let the up finish
        expect(await upPromise).toBe(0);
      } finally {
        delete process.env.TUT_TEST_PS_PID;
        delete process.env.TUT_TEST_PS_READY;
        delete process.env.TUT_TEST_PS_RELEASE;
        process.env.PATH = savedPath;
      }
      // THE assertion : the concurrently registered member survived.
      const membersAfter = await readPowerMembers(path.join(root, ".context-hub"));
      expect(membersAfter.some((m: { pid: number }) => m.pid === chain!.ppid)).toBe(true);

      const launcher = chain!.ppid;
      const helper = chain!.pid;
      process.kill(launcher, "SIGSTOP");
      process.kill(helper, "SIGSTOP");
      process.kill(first.notifier.pid!, "SIGKILL");
      for (let i = 0; i < 100 && alive(first.notifier.pid); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await main(["down"])).toBe(0); // attribution held → safe escalation cleanup
      expect(io.out()).toContain("verifies against this rig's power registry");
      expect(alive(launcher)).toBe(false);
      expect(alive(helper)).toBe(false);
      expect(readState(root).stopped_at).toBeDefined();
    } finally {
      io.restore();
      delete process.env.TUT_HERDR_EXECUTABLE;
      delete process.env.TUT_TEST_HANDOFF;
    }
  }, WINDOWS ? 240_000 : 150_000);
});

describe("watcher lifecycle across down/up and standalone watcher exit", () => {
  it("usage_audit=on: up → down → up respawns a live watcher; a lone watcher exit also recovers", async () => {
    const root = makeRig("f6-cycle", "on");
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(0);
      const first = readState(root);
      const firstWatcher = first.watcher?.pid;
      expect(firstWatcher).toBeDefined();
      expect(alive(firstWatcher ?? null)).toBe(true);

      // Normal down stops it; the next up must RESPAWN (not "already running").
      expect(await main(["down"])).toBe(0);
      expect(alive(firstWatcher ?? null)).toBe(false);
      expect(await main(["up"])).toBe(0);
      const second = readState(root);
      expect(second.watcher?.pid).toBeDefined();
      expect(alive(second.watcher?.pid ?? null)).toBe(true); // THE assertion: a live watcher after the restart
      expect(io.out()).not.toContain(`usage watcher already running (pid ${firstWatcher})`); // the dead one is never misreported
      expect(second.watcher?.pid).not.toBe(firstWatcher);

      // A lone watcher exit (rig otherwise up) also recovers on the next up.
      await killPid(second.watcher?.pid);
      for (let i = 0; i < 50 && alive(second.watcher?.pid ?? null); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await main(["up"])).toBe(0);
      const third = readState(root);
      expect(third.watcher?.pid).not.toBe(second.watcher?.pid);
      expect(alive(third.watcher?.pid ?? null)).toBe(true);
    } finally { io.restore(); }
  }, WINDOWS ? 240_000 : 120_000);

  it("a LIVE watcher keeps its facts when the token probe transiently fails (ps frozen)", async () => {
    const root = makeRig("f6-transient", "on");
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(0);
      const first = readState(root);
      const watcherPid = first.watcher?.pid;
      expect(watcherPid).toBeDefined();
      if (WINDOWS) {
        await overlapWindowsUp(watcherPid!, async () => {
          expect(alive(watcherPid)).toBe(true);
          expect(readState(root).watcher?.start_token).toBe(first.watcher?.start_token);
        });
        expect(io.out()).toContain(`up: usage watcher already running (pid ${watcherPid})`);
        expect(readState(root).watcher).toEqual(first.watcher);
        expect(alive(watcherPid)).toBe(true);
        return;
      }
      // Same ps-delegate freeze as above, keyed on the watcher pid.
      const binDir = path.join(root, "bin");
      mkdirSync(binDir, { recursive: true });
      const ready = path.join(root, "ps-ready");
      const release = path.join(root, "ps-release");
      writeFileSync(path.join(binDir, "ps"), "#!/usr/bin/env node\n" +
        'const fs = require("node:fs"), cp = require("node:child_process");\n' +
        "const a = process.argv.slice(2);\n" +
        "(async () => {\n" +
        "  if (a[0] === \"-p\" && a[1] === process.env.TUT_TEST_PS_PID) {\n" +
        "    fs.writeFileSync(process.env.TUT_TEST_PS_READY, \"ready\");\n" +
        "    while (!fs.existsSync(process.env.TUT_TEST_PS_RELEASE)) await new Promise((r) => setTimeout(r, 5));\n" +
        "  }\n" +
        "  const r = cp.spawnSync(\"/bin/ps\", a, { encoding: \"utf8\" });\n" +
        "  process.stdout.write(r.stdout || \"\"); process.stderr.write(r.stderr || \"\"); process.exitCode = r.status ?? 1;\n" +
        "})();\n", { mode: 0o755 });
      const savedPath = process.env.PATH;
      process.env.PATH = [binDir, savedPath].join(path.delimiter);
      process.env.TUT_TEST_PS_PID = String(watcherPid);
      process.env.TUT_TEST_PS_READY = ready;
      process.env.TUT_TEST_PS_RELEASE = release;
      let upPromise: Promise<number> | undefined;
      try {
        upPromise = main(["up"]); // will stall verifying the live watcher's token
        for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(existsSync(ready)).toBe(true);
        writeFileSync(release, "release");
        expect(await upPromise).toBe(0);
      } finally {
        delete process.env.TUT_TEST_PS_PID;
        delete process.env.TUT_TEST_PS_READY;
        delete process.env.TUT_TEST_PS_RELEASE;
        process.env.PATH = savedPath;
      }
      // THE assertion: the LIVE watcher's facts survived the transient failure.
      expect(io.out()).toContain(`up: usage watcher already running (pid ${watcherPid})`);
      expect(readState(root).watcher?.pid).toBe(watcherPid);
      expect(alive(watcherPid ?? null)).toBe(true);
    } finally { io.restore(); }
  }, WINDOWS ? 240_000 : 120_000);
});


describe("power drift detection and explicit adoption", () => {
  it.each(["default", "custom"])("%s ports: reports dead registrations read-only, requires opt-in, preserves adoption facts, and down stops the services", async (ports) => {
    const root = makeRig("drift");
    const storage = path.join(root, ".context-hub");
    const upArgs: string[] = [];
    if (ports === "custom") {
      const { createServer } = await import("node:net");
      const servers = [createServer(), createServer()];
      for (const server of servers) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      upArgs.push("--url", `http://127.0.0.1:${(servers[0]!.address() as { port: number }).port}`, "--event-port", String((servers[1]!.address() as { port: number }).port));
      for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const io = captureIo();
    try {
      expect(await main(["up", ...upArgs])).toBe(0);
      const original = (await readPowerState(storage))!;
      rememberServices(original);
      STRAY_PIDS.push(original.hub.pid!, original.notifier.pid!);
      const dead = deadPid();
      await writePowerState(storage, { ...original,
        hub: { ...original.hub, pid: dead, ...serviceScope(dead) },
        notifier: { ...original.notifier, pid: dead, ...serviceScope(dead) },
      });
      const before = readFileSync(path.join(storage, "power.json"), "utf8");
      const report = await runDoctor({ root: storage, hubRoot: root, url: original.hub.url });
      const power = report.checks.find(check => check.name === "power")!;
      expect(power.status).toBe("warn");
      expect(power.summary).toContain("power drift");
      expect(power.details.join("\n")).toContain(`registered PID ${dead} is dead`);
      expect(power.details.filter(line => line.includes("unregistered"))).toHaveLength(2);
      expect(readFileSync(path.join(storage, "power.json"), "utf8")).toBe(before);

      expect(await main(["up", "--adopt", "--dry-run"])).toBe(0);
      expect(io.out()).toContain("[dry-run] would adopt");
      expect(readFileSync(path.join(storage, "power.json"), "utf8")).toBe(before);
      expect(alive(original.hub.pid)).toBe(true);
      expect(await main(["up", ...upArgs])).toBe(0);
      expect(io.err()).toContain("power drift");
      const unowned = (await readPowerState(storage))!;
      expect(unowned.hub.pid).toBeNull();
      expect(unowned.notifier.pid).toBeNull();
      expect(unowned.hub.adopted).toBeUndefined();
      expect(await main(["down"])).toBe(1);
      expect(alive(original.hub.pid)).toBe(true);
      expect(alive(original.notifier.pid)).toBe(true);

      expect(await main(["up", "--adopt"])).toBe(0);
      const adopted = (await readPowerState(storage))!;
      expect(adopted.hub.pid).toBe(original.hub.pid);
      expect(adopted.notifier.pid).toBe(original.notifier.pid);
      for (const name of ["hub", "notifier"] as const) {
        expect(adopted[name].adopted).toBe(true);
        expect(adopted[name].session_inherited).toBe(false);
        expect(adopted[name].start_token).toBe(await processStartToken(original[name].pid!));
        expect(adopted[name].power_session).toBeTruthy();
        expect(adopted[name].power_session).not.toBe(original[name].power_session);
      }
      expect(io.out()).toContain("TUT_POWER_SESSION cannot be injected");
      if (WINDOWS) {
        expect(adopted.hub.pgid).toBeNull();
        expect(adopted.notifier.pgid).toBeNull();
        expect(adopted.hub.process_scope).toBe("windows-tree");
        expect(adopted.notifier.process_scope).toBe("windows-tree");
      }
      expect(await main(["up", "--adopt"])).toBe(0);
      expect((await readPowerState(storage))!.hub).toEqual(adopted.hub);
      expect((await readPowerState(storage))!.notifier).toEqual(adopted.notifier);
      const adoptedReport = await runDoctor({ root: storage, hubRoot: root, url: original.hub.url });
      const adoptedCheck = adoptedReport.checks.find(check => check.name === "power")!;
      expect(adoptedCheck.status).toBe("ok");
      expect(adoptedCheck.details.join("\n")).toContain("session_inherited=false");
      expect(await main(["down"])).toBe(0);
      expect(alive(original.hub.pid)).toBe(false);
      expect(alive(original.notifier.pid)).toBe(false);
    } finally { io.restore(); }
  }, WINDOWS ? 180_000 : 30_000);

  it("refuses foreign-root adoption without writing state or stopping either service", async () => {
    const owner = makeRig("adopt-owner");
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(0);
      const live = readState(owner);
      const other = makeRig("adopt-foreign");
      expect(await main(["up", "--adopt", "--url", live.hub.url])).toBe(1);
      expect(io.err()).toMatch(/foreign hub.*workspace mismatch/);
      expect(existsSync(path.join(other, ".context-hub", "power.json"))).toBe(false);
      expect(alive(live.hub.pid)).toBe(true);
      expect(alive(live.notifier.pid)).toBe(true);
      await expect(adoptService("hub", live.hub.url, other, live.hub.url)).rejects.toThrow("ownership verification failed");
    } finally { io.restore(); }
  }, WINDOWS ? 60_000 : 15_000);

  it("refuses adopting a same-root listener in the caller's shared group", async () => {
    const root = makeRig("adopt-shared");
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hub_root: realpathSync(root) }));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    try {
      const url = `http://127.0.0.1:${port}`;
      if (WINDOWS) {
        // Windows has no caller PGID. Listener adoption records its actual
        // creation identity; the stop boundary must still protect the caller.
        const facts = await adoptService("hub", url, root, url);
        expect(facts.pid).toBe(process.pid);
        expect(facts.pgid).toBeNull();
        expect(facts.process_scope).toBe("windows-tree");
        expect(facts.start_token).toBe(await processStartToken(process.pid));
        await expect(stopWindowsService(root, facts.pid!, facts.start_token)).rejects.toThrow("service PID belongs to a run or the caller");
        expect(existsSync(path.join(root, ".context-hub", "power.json"))).toBe(false);
      } else {
        await expect(adoptService("hub", url, root, url)).rejects.toThrow("not an independent process-group leader");
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("requires the Hub handshake even when a notifier claims the requested root", async () => {
    const root = makeRig("adopt-notifier-handshake");
    const { createServer } = await import("node:http");
    let url = "";
    const server = createServer((req, res) => {
      const event = req.url === "/agent-event";
      res.writeHead(event ? 405 : 200, { "Content-Type": "application/json", ...(event ? { Allow: "POST" } : {}) });
      res.end(JSON.stringify({ hub_root: event ? realpathSync(root) : path.join(root, "foreign"), hub_url: url }));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await expect(adoptService("notifier", `${url}/agent-event`, root, url)).rejects.toThrow("ownership verification failed");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("rejects --adopt in herdr mode", async () => {
    const root = makeRig("adopt-herdr");
    writeFileSync(path.join(root, ".context-hub", "config.json"), JSON.stringify({ power: { mode: "herdr" } }));
    const io = captureIo();
    try {
      expect(await main(["up", "--adopt", "--dry-run"])).toBe(1);
      expect(io.err()).toContain("--adopt requires power.mode=standalone");
    } finally { io.restore(); }
  });
});

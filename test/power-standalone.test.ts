/**
 * Power lifecycle integration (power.mode=standalone + tut down).
 *
 * Real processes against the built dist CLI (the rig-isolation convention):
 * up's detached children are REAL `node dist/cli.js serve|notify` processes,
 * down's signals land on real process groups, runs are real `tut run`
 * process groups. No mocks of our own code; the only stubs are none.
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
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { main } from "../src/cli.js";
import { processStartToken } from "../src/standalone/power/standalone-up.js";

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

function killPid(pid: number | null | undefined): void {
  if (pid === null || pid === undefined || !alive(pid)) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

function readState(root: string): { mode: string; started_at: string; hub: { url: string; port: number; pid: number; pgid: number; power_session?: string | null }; notifier: { event_port: number; pid: number; power_session?: string | null }; stopped_at?: string; watcher?: { pid: number } | null } {
  return JSON.parse(readFileSync(path.join(root, ".context-hub", "power.json"), "utf8"));
}

/** A real detached sleeper as a stand-in service process group. */
function sleeper(script: string): number {
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  child.unref();
  STRAY_PIDS.push(child.pid!);
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
  for (const root of TRASH.splice(0)) {
    // Best-effort rig stop before deleting the state down would need.
    const io = captureIo();
    try {
      process.chdir(root);
      await main(["down"]).catch(() => undefined);
    } catch { /* cleanup only */ }
    finally { io.restore(); }
    try {
      const state = readState(root);
      killPid(state.hub?.pid);
      killPid(state.notifier?.pid);
      killPid(state.watcher?.pid);
    } catch { /* no state */ }
    rmSync(root, { recursive: true, force: true });
  }
  for (const pid of STRAY_PIDS.splice(0)) killPid(pid);
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
      expect(first.hub.pgid).toBe(first.hub.pid); // detached ⇒ group leader
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
  }, 90_000);
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
      expect(await main(["down"])).toBe(0);
      expect(alive(b.hub.pid)).toBe(false);
    } finally { io.restore(); }
  }, 120_000);
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
      killPid(meta.pid);
    } finally { io.restore(); }
  }, 90_000);
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
      notifier: { event_port: 1, pid: notifierPid, pgid: notifierPid, started_at: new Date().toISOString(), start_token: await processStartToken(notifierPid) },
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
      hub: { url: "http://127.0.0.1:1", port: 1, pid: innocent, pgid: innocent, started_at: "2026-01-01T00:00:00.000Z", start_token: "ps:Wed Jan  1 00:00:00 2020" },
      notifier: { event_port: 1, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(1);
      expect(io.err()).toContain("no longer matches the recorded process");
      expect(io.err()).toContain("NOT signaling");
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
      hub: { url: "http://127.0.0.1:1", port: 1, pid: innocent, pgid: innocent, started_at: new Date().toISOString(), start_token: null },
      notifier: { event_port: 1, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(1);
      expect(io.err()).toContain("identity cannot be verified");
      expect(io.err()).toContain("NOT signaling");
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
      hub: { url: "http://127.0.0.1:1", port: 1, pid: stubbornPid, pgid: stubbornPid, started_at: new Date().toISOString(), start_token: await processStartToken(stubbornPid) },
      notifier: { event_port: 1, pid: deadNotifier, pgid: deadNotifier, started_at: new Date().toISOString(), start_token: "ps:Wed Jan  1 00:00:00 2020" },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    process.env.TUT_DOWN_GRACE_MS = "300";
    const io = captureIo();
    try {
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("force-killed");
      expect(alive(stubbornPid)).toBe(false);
    } finally { io.restore(); }
  });

  it("a leader that exits first never masks stubborn group members (group-scoped stop)", async () => {
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
      hub: { url: "http://127.0.0.1:1", port: 1, pid: leader, pgid: leader, started_at: new Date().toISOString(), start_token: await processStartToken(leader) },
      notifier: { event_port: 1, pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null },
    };
    writeFileSync(path.join(root, ".context-hub", "power.json"), JSON.stringify(state));
    process.env.TUT_DOWN_GRACE_MS = "300";
    const io = captureIo();
    try {
      // Variant A: leader alive now, exits on TERM; the stubborn child forces escalation.
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("force-killed");
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
          notifier: { event_port: 1, pid: leader2, pgid: leader2, started_at: "2026-01-01T00:00:00.000Z", ...(token !== null ? { start_token: token } : { start_token: null }) },
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
          killPid(group2!.child);
        }
      }
    }
  }, 60_000);

  it("a recorded stop with dead pids reports already stopped without side effects", async () => {
    const root = makeRig("already");
    const hubPid = deadPid();
    const notifierPid = deadPid();
    const state = {
      mode: "standalone",
      started_at: new Date().toISOString(),
      hub: { url: "http://127.0.0.1:1", port: 1, pid: hubPid, pgid: hubPid, started_at: new Date().toISOString() },
      notifier: { event_port: 1, pid: notifierPid, pgid: notifierPid, started_at: new Date().toISOString() },
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
      killPid(real.notifier.pid);
      killPid(real.hub.pid);
      for (let i = 0; i < 50 && (alive(real.hub.pid) || alive(real.notifier.pid)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await main(["down"])).toBe(0);
      expect(readState(root).stopped_at).toBeDefined();
      expect(await main(["down"])).toBe(0);
      expect(io.out()).toContain("already stopped");
    } finally { io.restore(); }
  }, 90_000);
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
      expect(io.err()).toContain("EISDIR");
    } finally { io.restore(); }
  }, 60_000);

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
  }, 60_000);
});

describe("real notifier leftover group (registry-attributed cleanup)", () => {
  it("a close-cleanup launch child survives its dead leader and down cleans it via the power registry", async () => {
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
      process.kill(state.notifier.pid, "SIGKILL");
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
  }, 120_000);

  it("registry round-trip tolerates corrupt lines; up never rewrites it (no lost-append window)", async () => {
    const root = makeRig("registry");
    const { appendPowerMember, readPowerMembers } = await import("../src/standalone/power/standalone-up.js");
    const storageDir = path.join(root, ".context-hub");
    writeFileSync(path.join(storageDir, "power-members.jsonl"), "{corrupt\n" + JSON.stringify({ pid: 1, pgid: 2, power_session: "other", kind: "x", registered_at: new Date().toISOString(), start_token: "ps:x" }) + "\n");
    await appendPowerMember(storageDir, { pid: deadPid(), pgid: 1, power_session: "stale-dead", kind: "launch:cleanup", registered_at: new Date().toISOString(), start_token: "ps:Wed Jan  1 00:00:00 2020" }); // retireable junk — must still not be touched
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
        process.kill(first.notifier.pid, "SIGKILL");
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
    }, 150_000);
  }
});

describe("an up overlapping a real launch registration never loses the member", () => {
  it("second up frozen mid-flight while the close-cleanup child registers: the line survives, the leaderless group still cleans up", async () => {
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
      process.env.PATH = `${binDir}:${savedPath}`;
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
      process.kill(first.notifier.pid, "SIGKILL");
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
  }, 150_000);
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
      killPid(second.watcher?.pid);
      for (let i = 0; i < 50 && alive(second.watcher?.pid ?? null); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await main(["up"])).toBe(0);
      const third = readState(root);
      expect(third.watcher?.pid).not.toBe(second.watcher?.pid);
      expect(alive(third.watcher?.pid ?? null)).toBe(true);
    } finally { io.restore(); }
  }, 120_000);

  it("a LIVE watcher keeps its facts when the token probe transiently fails (ps frozen)", async () => {
    const root = makeRig("f6-transient", "on");
    const io = captureIo();
    try {
      expect(await main(["up"])).toBe(0);
      const first = readState(root);
      const watcherPid = first.watcher?.pid;
      expect(watcherPid).toBeDefined();
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
      process.env.PATH = `${binDir}:${savedPath}`;
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
  }, 120_000);
});

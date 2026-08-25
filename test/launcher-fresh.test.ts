// Fresh-session launcher coverage:
// birth anchoring (tut-hub → tut-notify → TUT_SPLIT_BASE → loud fail),
// lifecycle hooks (three-branch round hand-off: same-role continuation /
// role-change fresh birth with the narrowed reap / --fresh; --cleanup), the
// adopt-root birth + its anchored split fallback, the addressing-key guard,
// and dry-run placeholders. The REAL scripts/launch.sh runs against the
// fixture herdr (test/bin/herdr — argv logged to TUT_HERDR_LOG, scripted
// JSON out); assertions read the log and the child's stdio.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPTS_DIR = path.resolve(import.meta.dirname, "../scripts");
const LAUNCH_SH = path.join(SCRIPTS_DIR, "launch.sh");
const FIXTURE_BIN = path.join(path.resolve(import.meta.dirname, ".."), "test", "bin");
const NODE_DIR = path.dirname(process.execPath);
const runLaunch = promisify(execFile);

// Hermetic workspace chain: a fixture L1 project root
// (all-pi roster, default naming) pinned via TUT_PROJECT_ROOT, and an empty
// L2 pinned via TUT_USER_CONFIG_DIR — the repo's live .context-hub config
// and the machine's ~/.config/tut never enter these tests.
const CHAIN_ROOT = mkdtempSync(path.join(os.tmpdir(), "tut-fresh-chain-"));
mkdirSync(path.join(CHAIN_ROOT, ".context-hub"), { recursive: true });
writeFileSync(
  path.join(CHAIN_ROOT, ".context-hub", "workspace.json"),
  `${JSON.stringify({ roles: { architect: { agent: "pi" }, executor: { agent: "pi" }, reviewer: { agent: "pi" } } }, null, 2)}\n`,
  "utf8",
);
const EMPTY_L2 = mkdtempSync(path.join(os.tmpdir(), "tut-fresh-l2-"));
afterAll(() => {
  rmSync(CHAIN_ROOT, { recursive: true, force: true });
  rmSync(EMPTY_L2, { recursive: true, force: true });
});

const HUB_PANE = { pane_id: "w11:p2", label: "tut-hub", workspace_id: "w11", cwd: "/repo", tab_id: "w11:t2", agent_status: "idle" };
const NOTIFY_PANE = { pane_id: "w11:p4", label: "tut-notify", workspace_id: "w11", cwd: "/repo", tab_id: "w11:t3", agent_status: "idle" };

// Screen timelines for the closed-loop delivery (7.2.1):
// the born branch consumes 4 reads (base + 2 boot empties + the stable
// pair that releases the gate), then land-confirm sees the prompt text,
// then the submit verify sees the reaction. The continuation branch starts
// at the seat's live screen (no gate): snapshot → text lands → reaction.
const BORN_SCREENS = JSON.stringify(["", "", "pi ready", "pi ready", "pi ready ▎prompt", "working"]);
const CONT_SCREENS = JSON.stringify(["idle seat", "idle seat ▎prompt", "working"]);

/** Closed-loop delivery tail on $pane (success shape): exactly one
 *  send-text, a land-confirm read between the text and the Enter, exactly
 *  ONE Enter, only verify reads after it, log ends on those reads. */
const expectDelivered = (lines: string[], pane: string) => {
  const sendIdx = lines.findIndex((l) => l.startsWith(`pane send-text ${pane} `));
  expect(sendIdx).toBeGreaterThanOrEqual(0);
  const enterIdx = lines.indexOf(`pane send-keys ${pane} Enter`);
  expect(enterIdx).toBeGreaterThan(sendIdx);
  expect(lines.slice(sendIdx + 1, enterIdx).length).toBeGreaterThanOrEqual(1); // land-confirm ran
  expect(lines.slice(sendIdx + 1, enterIdx).every((l) => l.startsWith(`pane read ${pane}`))).toBe(true);
  expect(lines.filter((l) => l === `pane send-keys ${pane} Enter`)).toHaveLength(1);
  expect(lines.slice(enterIdx + 1).length).toBeGreaterThanOrEqual(1); // the verifying read
  expect(lines.slice(enterIdx + 1).every((l) => l.startsWith(`pane read ${pane}`))).toBe(true);
};

/** Env with the fixture herdr first on PATH; panes/fixtures parameterized.
 *  The workspace chain is pinned hermetically: TUT_PROJECT_ROOT → the L1
 *  fixture, TUT_USER_CONFIG_DIR → an empty L2 (chain falls to the fixture). */
const env = (panes: unknown[], extra: Record<string, string> = {}, dryRun = false): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
  TUT_HERDR_PANES: JSON.stringify(panes),
  TUT_HUB_URL: "http://127.0.0.1:1", // deterministic: hub down → file chain + stderr note
  TUT_PROJECT_ROOT: CHAIN_ROOT,
  TUT_USER_CONFIG_DIR: EMPTY_L2,
  ...(dryRun ? { TUT_DRY_RUN: "1" } : {}),
  TUT_READY_POLL_MS: "20",
  TUT_READY_FLOOR_MS: "0",
  TUT_READY_TIMEOUT_MS: "300",
  TUT_TEXT_LAND_TIMEOUT_MS: "200",
  TUT_SUBMIT_TIMEOUT_MS: "100",
  TUT_SUBMIT_RETRY_MS: "60",
  TUT_SUBMIT_RETRY_TIMEOUT_MS: "400",
  ...extra,
});

/** Log lines captured from the fixture herdr for one launch.sh run. */
async function runLogged(
  args: string[],
  panes: unknown[],
  extra: Record<string, string> = {},
  dryRun = false,
): Promise<{ lines: string[]; stdout: string; stderr: string; code: number }> {
  const log = path.join(os.tmpdir(), `tut-fresh-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  rmSync(log, { force: true });
  try {
    const r = await runLaunch(LAUNCH_SH, args, { env: env(panes, { TUT_HERDR_LOG: log, ...extra }, dryRun) });
    return {
      lines: readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0),
      stdout: r.stdout,
      stderr: r.stderr,
      code: 0,
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    let lines: string[] = [];
    try {
      lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
    } catch {
      /* launcher may fail before any herdr call */
    }
    return { lines, stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  } finally {
    rmSync(log, { force: true });
  }
}

// --- birth anchoring ----------------------------------------------------------------

describe("birth anchor: tut-hub → tut-notify → TUT_SPLIT_BASE → loud fail", () => {
  it("anchors on the tut-hub pane's (workspace_id, cwd) — flags land on tab create", async () => {
    // A foreign pane is FIRST in the list (a historical cross-project
    // mis-anchoring incident); the anchor must still be the tut-hub pane,
    // never list position.
    const foreign = { pane_id: "wP:p1", label: "", workspace_id: "wP", cwd: "/other/project", agent_status: "idle" };
    const r = await runLogged(["t1", "executor", "pi"], [foreign, HUB_PANE], {
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT executor --no-focus");
    expect(r.lines).toContain("pane rename FIX:root1 t1.executor"); // pane label: fixed addressing key
    // The foreign workspace/cwd must not leak into the birth.
    expect(r.lines.some((l) => l.includes("wP") || l.includes("/other/project"))).toBe(false);
  });

  it("falls back to tut-notify when no tut-hub pane exists", async () => {
    const r = await runLogged(["t1", "executor", "pi"], [NOTIFY_PANE], {
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT executor --no-focus");
  });

  it("falls back to $TUT_SPLIT_BASE (escape hatch) when no system pane matches", async () => {
    const esc = { pane_id: "w7:p9", label: "custom", workspace_id: "w7", cwd: "/esc", agent_status: "idle" };
    const r = await runLogged(["t1", "executor", "pi"], [esc], {
      TUT_SPLIT_BASE: "w7:p9",
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.lines).toContain("tab create --workspace w7 --cwd /esc --label TUT executor --no-focus");
  });

  it("no anchor at all → loud error, nothing born (live); placeholders in dry-run", async () => {
    const stray = { pane_id: "wP:p1", label: "", workspace_id: "wP", cwd: "/other/project", agent_status: "idle" };
    const live = await runLogged(["t1", "executor", "pi"], [stray]);
    expect(live.code).toBe(1);
    expect(live.stderr).toContain("no anchor pane found");
    expect(live.stderr).toContain("TUT_SPLIT_BASE");
    // Read-only pane-list lookups are fine; NOTHING was born (no create/split/run).
    expect(live.lines.some((l) => l.startsWith("tab create") || l.startsWith("pane split") || l.startsWith("pane run"))).toBe(false);

    const dry = await runLogged(["t1", "executor", "pi"], [stray], {}, true);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("--workspace <workspace> --cwd <cwd> --label TUT executor");
  });

  it("dry-run without any herdr on PATH still previews with placeholders", async () => {
    // Only a pi stub on PATH (no herdr at all): the preview must degrade to
    // placeholder anchors instead of failing.
    const bin = mkdtempSync(path.join(os.tmpdir(), "tut-nostub-"));
    try {
      writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const noHerdr = {
        ...process.env,
        PATH: `${bin}:${NODE_DIR}:/usr/bin:/bin`,
        TUT_DRY_RUN: "1",
        TUT_HUB_URL: "http://127.0.0.1:1",
        TUT_PROJECT_ROOT: CHAIN_ROOT, // hermetic chain even without herdr
        TUT_USER_CONFIG_DIR: EMPTY_L2,
      };
      const { stdout } = await runLaunch(LAUNCH_SH, ["t2", "reviewer", "pi"], { env: noHerdr });
      expect(stdout).toContain("DRY-RUN: birth: herdr tab create --workspace <workspace> --cwd <cwd> --label TUT reviewer --no-focus");
      expect(stdout).toContain("DRY-RUN: birth: herdr pane rename <root> t2.reviewer"); // pane label fixed
      expect(stdout).toContain("(agent 'pi', label 't2.reviewer')");
      // Closed-loop preview: land-confirm + verified-submit lines with
      // their knobs, both for the born branch.
      expect(stdout).toContain("DRY-RUN: text-land check <label:t2.reviewer> (timeout 5000ms; on timeout submit anyway)");
      expect(stdout).toContain("DRY-RUN: submit verify <label:t2.reviewer> (verify 3000ms by input-box-cleared; then bounded Enter resend loop — interval 1500ms within 30000ms; exhaustion → manual-fallback note, still exit 0)");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

// --- lifecycle: round hand-off (three branches, same-role-continuity edition) ---------

describe("round hand-off: role change births fresh (narrowed reap)", () => {
  it("architect (idle, non-continuity) reaped (original behavior); the LIVE executor seat is KEPT (narrowing); prompt goes ONLY to the new pane", async () => {
    const panes = [
      HUB_PANE,
      { pane_id: "w11:p5", label: "t1.architect", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
      { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
      // A bare agent-name pane (the task's architect agent) — with the
      // kickoff namespace retired, TUT mechanisms never touch these.
      { pane_id: "w11:p8", label: "pi", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
    ];
    const r = await runLogged(["t1", "reviewer", "pi"], panes, {
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.lines).toContain("pane close w11:p5"); // non-continuity role, idle → the original reap preserved
    expect(r.lines).not.toContain("pane close w11:p6"); // LIVE continuity seat — the deliberate Δ vs the original full reap
    expect(r.stderr).toContain("live continuity work seat"); // visible choice, pane log auditable
    expect(r.lines).not.toContain("pane close w11:p8"); // bare agent pane — out of scope
    // The fresh birth happened for the new role, adopt-root complete.
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT reviewer --no-focus");
    expect(r.lines).toContain("pane rename FIX:root1 t1.reviewer");
    // The prompt went ONLY to the newborn pane — never the surviving seat.
    const sends = r.lines.filter((l) => l.startsWith("pane send-text"));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatch(/^pane send-text FIX:root1 /);
    expectDelivered(r.lines, "FIX:root1");
  });

  it("prefix hygiene: a task_id that prefixes another task's id does NOT match its panes (and never continues into them)", async () => {
    const panes = [
      HUB_PANE,
      { pane_id: "w11:p9", label: "t1-long.executor", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
    ];
    const r = await runLogged(["t1", "executor", "pi"], panes, {
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("same-role continuation"); // t1-long.executor ≠ t1.executor (exact label)
    expect(r.lines).not.toContain("pane close w11:p9"); // "t1." ≠ "t1-long." — slug alphabet has no dots
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT executor --no-focus");
  });
});

describe("same-role continuation: live `<T>.<role>` seat + continuity role → deliver only", () => {
  it("idle executor seat (revision scene): no reap, no birth, no gate — closed-loop delivery straight in", async () => {
    const r = await runLogged(["t1", "executor", "pi"], [
      HUB_PANE,
      { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
    ], { TUT_HERDR_READ_SCRIPT: CONT_SCREENS });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("same-role continuation — delivering to existing pane w11:p6");
    // Deliver-only: no lifecycle mutation, no birth sequence. The readiness
    // GATE is the born-pane mechanism — but the closed loop (snapshot /
    // land-confirm / verify reads) applies here too: reads are expected,
    // close/create/split/rename are not.
    expect(
      r.lines.some((l) =>
        l.startsWith("pane close") || l.startsWith("tab create") || l.startsWith("pane split") || l.startsWith("pane rename"),
      ),
    ).toBe(false);
    const sends = r.lines.filter((l) => l.startsWith("pane send-text"));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatch(/^pane send-text w11:p6 轮到你了（role: executor）/);
    // NO gate: the snapshot read sits directly before the send-text (a born
    // pane would show the 4-read boot/paint gate sequence instead).
    const sendIdx = r.lines.findIndex((l) => l.startsWith("pane send-text w11:p6"));
    expect(r.lines[sendIdx - 1]).toMatch(/^pane read w11:p6 /);
    expectDelivered(r.lines, "w11:p6");
  });

  it("idle reviewer seat likewise (re-review scene)", async () => {
    const r = await runLogged(["t1", "reviewer", "pi"], [
      HUB_PANE,
      { pane_id: "w11:p3", label: "t1.reviewer", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
    ], { TUT_HERDR_READ_SCRIPT: CONT_SCREENS });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("same-role continuation — delivering to existing pane w11:p3");
    expect(r.lines.some((l) => l.startsWith("pane close") || l.startsWith("tab create"))).toBe(false);
    expectDelivered(r.lines, "w11:p3");
  });

  it("working / blocked seats are live too — the prompt queues in the TUI input loop", async () => {
    for (const status of ["working", "blocked"]) {
      const r = await runLogged(["t1", "executor", "pi"], [
        HUB_PANE,
        { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: status },
      ], { TUT_HERDR_READ_SCRIPT: CONT_SCREENS });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("same-role continuation — delivering to existing pane w11:p6");
      expect(r.lines.some((l) => l.startsWith("pane close") || l.startsWith("tab create"))).toBe(false);
      expectDelivered(r.lines, "w11:p6");
    }
  });

  it("dry-run previews the continuation — no mutating herdr call at all (discovery list only)", async () => {
    const r = await runLogged(
      ["t1", "executor", "pi"],
      [
        HUB_PANE,
        { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
      ],
      {},
      true,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DRY-RUN: herdr pane send-text w11:p6");
    expect(r.stdout).toContain("DRY-RUN: text-land check w11:p6 (timeout 200ms; on timeout submit anyway)");
    expect(r.stdout).toContain("DRY-RUN: herdr pane send-keys w11:p6 Enter");
    expect(r.stdout).toContain("DRY-RUN: submit verify w11:p6 (verify 100ms by input-box-cleared; then bounded Enter resend loop — interval 60ms within 400ms; exhaustion → manual-fallback note, still exit 0)");
    expect(r.stderr).toContain("same-role continuation");
    expect(r.lines.every((l) => l === "pane list")).toBe(true); // read-only discovery, nothing else
  });
});

describe("narrowed reap (birth branch): continuity seats survive, corpses and non-continuity roles go", () => {
  it("dead continuity panes are reaped (done AND missing agent_status); working still skipped with a warning", async () => {
    const r = await runLogged(
      ["t1", "reviewer", "pi"],
      [
        HUB_PANE,
        { pane_id: "w11:p5", label: "t1.architect", workspace_id: "w11", cwd: "/repo", agent_status: "working" },
        { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "done" }, // dead corpse
        { pane_id: "w11:p7", label: "t1.reviewer", workspace_id: "w11", cwd: "/repo" }, // agent_status missing = dead
      ],
      { TUT_HERDR_READ_SCRIPT: BORN_SCREENS },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("pane 't1.architect' (w11:p5) still working"); // the original working-skip semantics survive
    expect(r.lines).not.toContain("pane close w11:p5");
    expect(r.lines).toContain("pane close w11:p6"); // done corpse — continuity does not protect the dead
    expect(r.lines).toContain("pane close w11:p7"); // missing-field corpse likewise
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT reviewer --no-focus"); // birth proceeded
  });

  it("TUT_CONTINUITY_ROLES=\"\" restores the full reap (escape/test knob)", async () => {
    const r = await runLogged(
      ["t1", "reviewer", "pi"],
      [
        HUB_PANE,
        { pane_id: "w11:p5", label: "t1.architect", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
        { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
      ],
      { TUT_CONTINUITY_ROLES: "", TUT_HERDR_READ_SCRIPT: BORN_SCREENS },
    );
    expect(r.code).toBe(0);
    expect(r.lines).toContain("pane close w11:p5"); // full reap: every non-working pane of the task
    expect(r.lines).toContain("pane close w11:p6");
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT reviewer --no-focus");
  });
});

describe("--fresh (explicit outside perspective) + addressing-key guard", () => {
  it("force-closes the role's own panes (idle AND working), then births + gated delivery to the newborn only", async () => {
    const r = await runLogged(
      ["--fresh", "t1", "executor", "pi"],
      [
        HUB_PANE,
        { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
        { pane_id: "w11:p9", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "working" },
      ],
      { TUT_HERDR_READ_SCRIPT: BORN_SCREENS },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("--fresh — force-closing panes labeled 't1.executor'");
    expect(r.stderr).not.toContain("same-role continuation"); // fresh bypasses continuation by design
    expect(r.lines).toContain("pane close w11:p6"); // idle seat
    expect(r.lines).toContain("pane close w11:p9"); // working seat — the explicit choice authorizes it
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT executor --no-focus");
    expect(r.lines).toContain("pane rename FIX:root1 t1.executor");
    expect(r.lines.some((l) => l.startsWith("pane read"))).toBe(true); // readiness gate — born pane
    const sends = r.lines.filter((l) => l.startsWith("pane send-text"));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatch(/^pane send-text FIX:root1 /);
    expectDelivered(r.lines, "FIX:root1");
  });

  it("idempotent with no target pane — an ordinary birth", async () => {
    const r = await runLogged(["--fresh", "t2", "reviewer", "pi"], [HUB_PANE], {
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("--fresh");
    expect(r.lines.some((l) => l.startsWith("pane close"))).toBe(false);
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT reviewer --no-focus");
  });

  it("guard: a live `<T>.<role>` survivor of the reap aborts loudly — never a second pane under the same label", async () => {
    // Continuity disabled (the knob) + a working seat: the reap must skip it
    // (the working warning), and the birth must refuse to join it with a twin.
    const r = await runLogged(
      ["t1", "executor", "pi"],
      [
        HUB_PANE,
        { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "working" },
      ],
      { TUT_CONTINUITY_ROLES: "" },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("still working");
    expect(r.stderr).toContain("refusing to birth a second pane under the same label");
    expect(
      r.lines.some((l) => l.startsWith("tab create") || l.startsWith("pane split") || l.startsWith("pane run") || l.startsWith("pane send-text")),
    ).toBe(false); // zero birth, zero delivery
  });
});

// --- lifecycle: --cleanup (decide-close hook) -----------------------------------------

describe("--cleanup <task_id>: unconditional reap, best-effort", () => {
  it("closes this task's round panes even when working (live continuity seats included — the task is closed); bare agent panes are never touched; exit 0", async () => {
    const panes = [
      HUB_PANE,
      { pane_id: "w11:p5", label: "t9.executor", workspace_id: "w11", cwd: "/repo", agent_status: "working" },
      { pane_id: "w11:p6", label: "t9.reviewer", workspace_id: "w11", cwd: "/repo", agent_status: "idle" }, // live continuity seat
      { pane_id: "w11:p8", label: "pi", workspace_id: "w11", cwd: "/repo", agent_status: "idle" }, // bare agent pane
    ];
    const r = await runLogged(["--cleanup", "t9"], panes);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("pane close w11:p5"); // unconditional — task is closed
    expect(r.lines).toContain("pane close w11:p6"); // continuity protects mid-task, never past close
    expect(r.lines).not.toContain("pane close w11:p8"); // bare agent pane — out of scope
    expect(r.stderr).toContain("reaping panes of task 't9'");
  });

  it("a pane close failure is a warning, not a failure (decide must succeed regardless)", async () => {
    const panes = [
      HUB_PANE,
      { pane_id: "w11:p5", label: "t9.reviewer", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
    ];
    const r = await runLogged(["--cleanup", "t9"], panes, { TUT_HERDR_FAIL: "pane:close" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("pane close w11:p5 (label 't9.reviewer') failed — continuing");
  });

  it("cleanup never touches panes outside the task's namespace (unlabeled/foreign tasks stay)", async () => {
    const panes = [
      HUB_PANE,
      NOTIFY_PANE,
      { pane_id: "w11:p1", label: "", workspace_id: "w11", cwd: "/repo", agent_status: "idle" }, // human's
      { pane_id: "w11:p7", label: "t8.executor", workspace_id: "w11", cwd: "/repo", agent_status: "idle" }, // another task
    ];
    const r = await runLogged(["--cleanup", "t9"], panes);
    expect(r.code).toBe(0);
    expect(r.lines).not.toContain("pane close w11:p1");
    expect(r.lines).not.toContain("pane close w11:p2");
    expect(r.lines).not.toContain("pane close w11:p4");
    expect(r.lines).not.toContain("pane close w11:p7");
  });
});

// --- self-update suppression at launch (supply hardening) -------------------------

describe("self-update suppression: the agent run command disables startup update checks", () => {
  it("codex birth runs with the startup update check off — the registered self-update race cannot start; the closed-loop delivery completes", async () => {
    // Fixture-level simulation of the incident scenario: the pane paints
    // normally (BORN_SCREENS) BECAUSE the run command carries the
    // suppression — the six-minute npm self-update window is prevented at
    // the source, so the delivered prompt is not starved.
    const r = await runLogged(["t1", "executor", "codex"], [HUB_PANE], {
      TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.lines).toContain("pane run FIX:root1 codex -c check_for_update_on_startup=false");
    expect(r.lines).toContain("pane rename FIX:root1 t1.executor");
    expectDelivered(r.lines, "FIX:root1");
  });

  it("pi birth carries the documented env opt-out (PI_SKIP_VERSION_CHECK)", async () => {
    const r = await runLogged(["t1", "executor", "pi"], [HUB_PANE], {
      TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.lines).toContain("pane run FIX:root1 env PI_SKIP_VERSION_CHECK=1 pi");
    expectDelivered(r.lines, "FIX:root1");
  });

  it("fallback split birth carries the same suppression (one run-command code path)", async () => {
    const r = await runLogged(["t1", "executor", "codex"], [HUB_PANE], {
      TUT_HERDR_FAIL: "pane:rename:1",
      TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("falling back to the anchored split sequence");
    expect(r.lines).toContain("pane run FIX:p1 codex -c check_for_update_on_startup=false");
  });

  it("unknown agents pass through unchanged; the presence check probes the BARE agent name", async () => {
    // A temp bin with a stubagent stub: unknown to the suppression map → raw
    // command; command -v must check 'stubagent', not the wrapped form.
    const bin = mkdtempSync(path.join(os.tmpdir(), "tut-supp-unk-"));
    try {
      writeFileSync(path.join(bin, "stubagent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const r = await runLogged(["t1", "executor", "stubagent"], [HUB_PANE], {
        TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
        PATH: `${bin}:${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
      });
      expect(r.code).toBe(0);
      expect(r.lines).toContain("pane run FIX:root1 stubagent");

      // Presence check: an agent not on PATH fails the birth with the BARE
      // name in the message (the wrapped form is never what is probed).
      const miss = await runLogged(["t1", "executor", "ghost-agent"], [HUB_PANE], {});
      expect(miss.code).toBe(1);
      expect(miss.stderr).toContain("agent 'ghost-agent' not on PATH");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("TUT_SUPPRESS_AGENT_UPDATE=0 restores the raw agent command (escape knob)", async () => {
    const r = await runLogged(["t1", "executor", "pi"], [HUB_PANE], {
      TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
      TUT_SUPPRESS_AGENT_UPDATE: "0",
    });
    expect(r.code).toBe(0);
    expect(r.lines).toContain("pane run FIX:root1 pi");
  });

  it("dry-run preview shows the suppressed run command", async () => {
    const r = await runLogged(["t1", "executor", "codex"], [HUB_PANE], {}, true);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DRY-RUN: birth: herdr pane run <root> codex -c check_for_update_on_startup=false");
  });
});

// --- adopt-root fallback ---------------------------------------------------------------

describe("adopt-root fallback: anchored split sequence when root adoption fails", () => {
  it("pane rename failure → close the failed root, split the anchor (--cwd), move into the tab, rename, run", async () => {
    // pane:rename:1 — only the ROOT adoption rename fails; the fallback's
    // own rename (FIX:p1) succeeds.
    // A root pane already sits in the fallback tab (pane list is static in
    // the fixture) — the fallback must close it (root-pane hygiene).
    const panes = [
      HUB_PANE,
      { pane_id: "FIX:root1", label: "", workspace_id: "w11", cwd: "/repo", tab_id: "FIX:t1", agent_status: "idle" },
    ];
    const r = await runLogged(["t1", "executor", "pi"], panes, {
      TUT_HERDR_FAIL: "pane:rename:1",
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("falling back to the anchored split sequence");
    expect(r.lines).toContain("tab create --workspace w11 --cwd /repo --label TUT executor --no-focus");
    expect(r.lines).toContain("pane close FIX:root1"); // failed adoption root removed
    expect(r.lines).toContain("pane split w11:p2 --direction right --no-focus --cwd /repo"); // anchored split
    expect(r.lines).toContain("pane move FIX:p1 --tab FIX:t1 --split down");
    // the fallback tab's stray panes are swept — FIX:root1 matches again (idempotent close, same target)
    expect(r.lines).toContain("pane rename FIX:p1 t1.executor");
    expect(r.lines).toContain("pane run FIX:p1 env PI_SKIP_VERSION_CHECK=1 pi");
    expectDelivered(r.lines, "FIX:p1");
  });

  it("tab create failure (no tab, no root) → split, tab create retried in the fallback; both failing exits 1", async () => {
    const r = await runLogged(["t1", "executor", "pi"], [HUB_PANE], { TUT_HERDR_FAIL: "tab:create" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("herdr tab create returned no tab id");
    expect(r.lines).toContain("pane split w11:p2 --direction right --no-focus --cwd /repo"); // anchored anyway
  });
});

// --- tab-create edge: unparseable-but-successful create ----------------------

describe("tab create exit 0 + unparseable output: tab list recovery, no second create", () => {
  it("recovers the tab id by label via tab list — exactly ONE create, birth sequence completes", async () => {
    // The tab create's output is raw non-JSON (exit 0) — the tab exists but
    // the response carries no ids. tab list must reclaim it; a blind second
    // create would orphan the first tab (the registered accident).
    const r = await runLogged(["t1", "executor", "pi"], [
      HUB_PANE,
      { pane_id: "FIX:root1", label: "", workspace_id: "w11", cwd: "/repo", tab_id: "FIX:t1", agent_status: "idle" },
    ], {
      TUT_HERDR_TAB_CREATE_RAW: "created a tab (human-readable, not JSON)",
      TUT_HERDR_TABS: JSON.stringify([{ label: "TUT executor", tab_id: "FIX:t1" }]),
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    // THE assertion (closing condition): exactly one tab create call.
    expect(r.lines.filter((l) => l.startsWith("tab create"))).toHaveLength(1);
    expect(r.stderr).toContain("tab id recovered via tab list ('FIX:t1')");
    // Root discovery fell to channel 2 (pane list by tab_id) and the birth
    // sequence completed on the recovered tab's root pane.
    expect(r.lines).toContain("pane rename FIX:root1 t1.executor");
    expect(r.lines).toContain("pane run FIX:root1 env PI_SKIP_VERSION_CHECK=1 pi");
    expectDelivered(r.lines, "FIX:root1");
  });

  it("recovery misses too → NO second create (refusal, the first tab is not orphaned)", async () => {
    const r = await runLogged(["t1", "executor", "pi"], [HUB_PANE], {
      TUT_HERDR_TAB_CREATE_RAW: "created a tab",
      TUT_HERDR_TABS: "[]", // tab list does not know it either
      TUT_HERDR_FAIL: "pane:rename", // force the adoption off the happy path into the fallback
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing a second create");
    // Exactly one create (the unparseable success) — never a twin.
    expect(r.lines.filter((l) => l.startsWith("tab create"))).toHaveLength(1);
  });
});

// --- fallback root cleanup vs pane-list lag -----------------------------------

describe("fallback root cleanup survives pane-list lag (bounded retry + post-run sweep)", () => {
  it("lagged list misses the fresh tab's root → bounded re-list retry closes it after the lag clears", async () => {
    // Primary create FAILS (exit 1) so the fallback creates the tab itself;
    // its shipped root (FIX:root2) is discoverable only via pane list, and
    // the first 4 list calls serve the stale view (no FIX:root2).
    const r = await runLogged(["t1", "executor", "pi"], [
      HUB_PANE,
      { pane_id: "FIX:root2", label: "", workspace_id: "w11", cwd: "/repo", tab_id: "FIX:t2", agent_status: "idle" },
    ], {
      TUT_HERDR_FAIL: "tab:create:1",
      TUT_HERDR_PANES_LAG: JSON.stringify([HUB_PANE]), // stale view: the new tab's root is invisible
      // Lists before the sweep: entry anchor + continuation probe + cleanup
      // scan + addressing-key guard; the first TWO sweep attempts stay stale
      // too, so the third (lag-expired) re-list is what finds the root.
      TUT_HERDR_LIST_LAG_POLLS: "6",
      TUT_ROOT_SWEEP_RETRY_MS: "10",
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("falling back to the anchored split sequence");
    // THE closing condition: the empty root was finally closed — and the
    // close appears only after the lag-expired re-list (≥5 pane lists in).
    const closeIdx = r.lines.findIndex((l) => l === "pane close FIX:root2");
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    const listsBeforeClose = r.lines.slice(0, closeIdx).filter((l) => l === "pane list").length;
    expect(listsBeforeClose).toBeGreaterThanOrEqual(5);
    // The fallback sequence itself completed.
    expect(r.lines).toContain("pane split w11:p2 --direction right --no-focus --cwd /repo");
    expect(r.lines).toContain("pane move FIX:p1 --tab FIX:t2 --split down");
    expect(r.lines).toContain("pane rename FIX:p1 t1.executor");
    expectDelivered(r.lines, "FIX:p1");
  });
});

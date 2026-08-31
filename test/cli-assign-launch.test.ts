import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../src/cli.js";

// tut assign + workspace chain — parse layer first; this file also has the
// handler (temp project root) and launch.sh chain-resolution tests (fixture
// L1/L2 via TUT_PROJECT_ROOT / TUT_USER_CONFIG_DIR.

/**
 * The repo's scripts/ dir from this test file's own location (the launcher
 * under test resolves the same dir correctly via its own module-relative
 * path — cli.ts's LAUNCH_SCRIPT idiom).
 */
const SCRIPTS_DIR = path.resolve(import.meta.dirname, "../scripts");

// tut assign (parse)

describe("tut assign (parse)", () => {
  it("parses role + agent positionals", () => {
    expect(parseArgs(["assign", "architect", "pi"])).toEqual({
      command: "assign",
      role: "architect",
      agent: "pi",
    });
  });

  it("role must be one of the three; agent non-empty", () => {
    expect(parseArgs(["assign", "boss", "pi"]).command).toBe("usage");
    expect(parseArgs(["assign", "architect"]).command).toBe("usage");
    expect(parseArgs(["assign"]).command).toBe("usage");
  });
});

// --- tut assign handler ------------------------------------------------------------

/** Capture process stdout/stderr into strings for the duration of a handler run. */
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
  return {
    out: () => outText,
    err: () => errText,
    restore: () => {
      out.mockRestore();
      err.mockRestore();
    },
  };
}

describe("tut assign handler (temp project root, project-level .context-hub/workspace.json)", () => {
  // assign writes the PROJECT-level file under cwd (the chain's L1 root).
  // Each test chdirs into a fresh temp project; TUT_USER_CONFIG_DIR points
  // at an empty temp dir so the "currently effective lineup" for a missing
  // file is exactly DEFAULT_ROLES — hermetic against the repo's live
  // .context-hub config and the machine's ~/.config/tut.
  let project: string;
  let userDir: string;
  let io: ReturnType<typeof captureIo>;
  let prevCwd: string;
  let prevUserDir: string | undefined;

  const wsFile = (): string => path.join(project, ".context-hub", "workspace.json");

  beforeEach(() => {
    project = mkdtempSync(path.join(os.tmpdir(), "tut-assign-proj-"));
    userDir = mkdtempSync(path.join(os.tmpdir(), "tut-assign-l2-"));
    prevCwd = process.cwd();
    prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.chdir(project);
    process.env.TUT_USER_CONFIG_DIR = userDir;
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    process.chdir(prevCwd);
    if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
    else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
    rmSync(project, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("missing file → initialized from the effective lineup (all three roles = DEFAULT_ROLES) with the target rewritten", async () => {
    const code = await main(["assign", "executor", "codex"]);

    expect(code).toBe(0);
    expect(io.out()).toContain("assign: executor → codex (");
    const after = JSON.parse(readFileSync(wsFile(), "utf8")) as { roles: Record<string, { agent: string }> };
    // Full roster captured, not just the edited seat (design: 三 role 全量落盘).
    expect(after.roles).toEqual({
      architect: { agent: "codex" },
      executor: { agent: "codex" }, // rewritten target
      reviewer: { agent: "codex" },
    });
  });

  it("existing file: read-modify-write preserves $comment, unknown keys, and sibling roles; rewrites only the target", async () => {
    mkdirSync(path.dirname(wsFile()), { recursive: true });
    writeFileSync(wsFile(), `${JSON.stringify({
      $comment: "keep me",
      experimental: { keep: true },
      roles: {
        architect: { agent: "codex" },
        executor: { agent: "pi", hint: "keep-me" },
        reviewer: { agent: "codex" },
      },
    }, null, 2)}\n`);

    const code = await main(["assign", "executor", "codex"]);

    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(wsFile(), "utf8")) as {
      $comment: string;
      experimental: unknown;
      roles: Record<string, Record<string, unknown>>;
    };
    expect(after.$comment).toBe("keep me");
    expect(after.experimental).toEqual({ keep: true });
    expect(after.roles.executor).toEqual({ agent: "codex", hint: "keep-me" });
    expect(after.roles.architect).toEqual({ agent: "codex" });
    expect(after.roles.reviewer).toEqual({ agent: "codex" });
  });

  it("legacy {label, agent} entry tolerated: only .agent is rewritten, label key left untouched", async () => {
    mkdirSync(path.dirname(wsFile()), { recursive: true });
    writeFileSync(wsFile(), `${JSON.stringify({
      roles: { executor: { label: "exec", agent: "pi" } },
    }, null, 2)}\n`);

    const code = await main(["assign", "executor", "codex"]);

    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(wsFile(), "utf8")) as { roles: Record<string, Record<string, unknown>> };
    expect(after.roles.executor).toEqual({ label: "exec", agent: "codex" }); // stale key survives, .agent wins
  });

  it("corrupt file: exit 1, clear message, file not clobbered", async () => {
    mkdirSync(path.dirname(wsFile()), { recursive: true });
    const corrupt = "{ not json";
    writeFileSync(wsFile(), corrupt);

    const code = await main(["assign", "executor", "codex"]);

    expect(code).toBe(1);
    expect(io.err()).toContain("tut: assign:");
    expect(readFileSync(wsFile(), "utf8")).toBe(corrupt); // untouched
  });

  it("malformed roles (not an object): exit 1, nothing written", async () => {
    mkdirSync(path.dirname(wsFile()), { recursive: true });
    const malformed = '{ "roles": "nope" }';
    writeFileSync(wsFile(), malformed);

    const code = await main(["assign", "executor", "codex"]);

    expect(code).toBe(1);
    expect(io.err()).toContain("malformed");
    expect(readFileSync(wsFile(), "utf8")).toBe(malformed);
  });
});

// --- launch.sh resolution ------------------------------------------------------
// The REAL script with TUT_DRY_RUN=1: it prints the herdr command instead of
// running it; a missing label→pane mapping is tolerated in dry-run, so no live
// Herdr panes are required (a live Herdr merely upgrades the target to an id).

const LAUNCH_SH = path.join(SCRIPTS_DIR, "launch.sh");
const runLaunch = promisify(execFile);
// Dry-run env with a hermetic chain: no TUT_PROJECT_ROOT (L1 skipped — the
// anchor is a dry-run placeholder), empty L2 — naming/roles fall to defaults.
const CHAIN_L2 = mkdtempSync(path.join(os.tmpdir(), "tut-assign-chain-"));
const dryRunEnv = {
  ...process.env,
  TUT_DRY_RUN: "1",
  // Deterministic: hub down → degrade current/default; a live hub on the
  // default port must never leak its real /state (cast!) into these
  // resolution-chain assertions with dummy task ids.
  TUT_HUB_URL: "http://127.0.0.1:1",
  TUT_USER_CONFIG_DIR: CHAIN_L2,
} as NodeJS.ProcessEnv;

describe("launch.sh agent resolution (cast → three-level chain: TUT_PROJECT_ROOT → TUT_USER_CONFIG_DIR → defaults)", () => {
  // Chain fixtures: L1 project root (partial roster — executor only, so
  // per-role fallback is exercisable) and an L2 user dir (full roster with
  // distinct agents). The repo's seed file and the machine's real user
  // config are never read.
  const L1 = mkdtempSync(path.join(os.tmpdir(), "tut-res-l1-"));
  const L2 = mkdtempSync(path.join(os.tmpdir(), "tut-res-l2-"));
  const EMPTY_L2 = mkdtempSync(path.join(os.tmpdir(), "tut-res-empty-"));
  mkdirSync(path.join(L1, ".context-hub"), { recursive: true });
  writeFileSync(path.join(L1, ".context-hub", "workspace.json"), `${JSON.stringify({
    roles: { executor: { agent: "l1-agent" } },
  })}\n`);
  writeFileSync(path.join(L2, "workspace.json"), `${JSON.stringify({
    roles: { architect: { agent: "l2-agent" }, executor: { agent: "l2-agent" }, reviewer: { agent: "l2-agent" } },
  })}\n`);

  const chainEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...dryRunEnv,
    TUT_PROJECT_ROOT: L1,
    TUT_USER_CONFIG_DIR: L2,
    ...extra,
  });

  it("explicit agent (3rd arg, the form tut start-next / auto use): dry-run shows the agent, the tab template label, and the fixed pane label", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], { env: chainEnv() });

    expect(stdout).toContain("DRY-RUN");
    // Anchor may be real (a live herdr) or the dry-run placeholder — assert
    // only the label segment, which is deterministic either way.
    expect(stdout).toContain("--label TUT executor --no-focus");
    expect(stdout).toContain("DRY-RUN: birth: herdr pane rename <root> t1.executor"); // pane label fixed (4.4)
    expect(stdout).toContain("(agent 'pi', label 't1.executor')");
    expect(stdout).toContain("t1");
    expect(stdout).toContain("context.read");
  });

  it("self-resolution without the 3rd arg: L1 hit (TUT_PROJECT_ROOT fixture)", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor"], { env: chainEnv() });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("(agent 'l1-agent',"); // L1 fixture: executor → l1-agent
  });

  it("L1 lacks the role → per-role fallback to L2 (architect not in L1, L2 has it)", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "architect"], { env: chainEnv() });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("(agent 'l2-agent',"); // per-role: architect falls to L2
  });

  it("both levels lack/corrupt → built-in DEFAULT_ROLES (corrupt L1, empty L2)", async () => {
    const corruptL1 = mkdtempSync(path.join(os.tmpdir(), "tut-res-corrupt-"));
    mkdirSync(path.join(corruptL1, ".context-hub"), { recursive: true });
    writeFileSync(path.join(corruptL1, ".context-hub", "workspace.json"), "{ not json");
    try {
      const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor"], {
        env: chainEnv({ TUT_PROJECT_ROOT: corruptL1, TUT_USER_CONFIG_DIR: EMPTY_L2 }),
      });

      expect(stdout).toContain("DRY-RUN");
      expect(stdout).toContain("(agent 'pi',"); // corrupt L1 = absent; empty L2 = absent → DEFAULT_ROLES.executor
    } finally {
      rmSync(corruptL1, { recursive: true, force: true });
    }
  });

  it("role in no level: unknown roles fall back to codex (parity with the chain's final fallback)", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "boss"], {
      env: chainEnv({ TUT_PROJECT_ROOT: EMPTY_L2, TUT_USER_CONFIG_DIR: EMPTY_L2 }),
    });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("(agent 'codex',"); // the chain always yields an agent
  });

  it("custom naming.tab_label fixture: tab label renders the template, pane label stays byte-exact <task_id>.<role>", async () => {
    // custom-template regression: a custom template may
    // reshape the TAB label, but must never leak into the pane addressing
    // key — both pinned in one vector under a template-bearing fixture.
    const tplL1 = mkdtempSync(path.join(os.tmpdir(), "tut-res-tpl-"));
    mkdirSync(path.join(tplL1, ".context-hub"), { recursive: true });
    writeFileSync(path.join(tplL1, ".context-hub", "workspace.json"), `${JSON.stringify({
      naming: { tab_label: "[{task}] {agent}" },
      roles: { executor: { agent: "pi" } },
    })}\n`);
    try {
      const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], { env: chainEnv({ TUT_PROJECT_ROOT: tplL1 }) });

      expect(stdout).toContain("DRY-RUN");
      expect(stdout).toContain("--label [t1] pi --no-focus"); // template rendered ({task}/{agent})
      expect(stdout).not.toContain("--label TUT executor"); // default template NOT in play
      expect(stdout).toContain("DRY-RUN: birth: herdr pane rename <root> t1.executor"); // pane label fixed, byte-exact
      expect(stdout).toContain("(agent 'pi', label 't1.executor')");
    } finally {
      rmSync(tplL1, { recursive: true, force: true });
    }
  });
});

describe("launch.sh round entry (prompt delivery regression guard)", () => {
  it("delivers the round prompt verbatim in dry-run (first round after create uses the same entry)", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "architect", "pi"], { env: dryRunEnv });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("(agent 'pi', label 't1.architect')");
    expect(stdout).toContain("轮到你了（role: architect）");
    expect(stdout).toContain("t1");
  });
});

// --- skills reachability: the round prompt must name the installed skill -----
// The Agent's cwd is the target project, so "按你的 role skill" alone left
// Executor/Reviewer without a reachable skill file. The script resolves its
// own location (SCRIPT_DIR/.. = TUT root) — proven here by running the REAL
// launcher from a temp cwd outside the repo, parameterized over all three
// conventional roles.
describe("launch.sh round prompt embeds the absolute installed skill path", () => {
  const TUT_ROOT = path.resolve(SCRIPTS_DIR, "..");
  const TRASH: string[] = [];

  afterEach(() => {
    for (const dir of TRASH.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each(["architect", "executor", "reviewer"])(
    "role %s: prompt names TUT's installed skills/<role>.md from a non-TUT cwd",
    async (role) => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-assign-cwd-"));
      TRASH.push(tmp);

      const { stdout } = await runLaunch(LAUNCH_SH, ["t9", role], { env: dryRunEnv, cwd: tmp });

      expect(stdout).toContain("DRY-RUN");
      // The existing round-prompt contract stays intact: task id, role, and
      // the context.read / context.publish wording.
      expect(stdout).toContain(`轮到你了（role: ${role}）`);
      expect(stdout).toContain("t9");
      expect(stdout).toContain("context.read");
      expect(stdout).toContain("context.publish");
      // The skill reference is the absolute installed path, reachable from
      // the caller's cwd — not a cwd-relative accident.
      const skillAbs = path.join(TUT_ROOT, "skills", `${role}.md`);
      expect(path.isAbsolute(skillAbs)).toBe(true);
      expect(stdout).toContain(skillAbs);
      expect(stdout).not.toContain(path.join(tmp, "skills"));
      expect(existsSync(skillAbs)).toBe(true);
      expect(readFileSync(skillAbs, "utf8").length).toBeGreaterThan(0);
    },
  );
});

// --- fresh-session round birth: cleanup preview + anchored birth --------------------
// The REAL script in dry-run against the fixture herdr: the round hand-off
// previews (1) the lifecycle cleanup of this task's stale panes and (2) the
// adopt-root birth anchored to the tut-hub pane's (workspace, cwd) — never a
// reuse of an existing same-agent pane.

describe("launch.sh fresh-session round hand-off (cleanup + birth preview)", () => {
  const FIXTURE_BIN = path.join(path.resolve(import.meta.dirname, ".."), "test", "bin");
  const NODE_DIR = path.dirname(process.execPath);
  const HUB_PANE = { pane_id: "w11:p2", label: "tut-hub", workspace_id: "w11", cwd: "/repo", tab_id: "w11:t2", agent_status: "idle" };
  const fixtureEnv = (panes: unknown[], extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...dryRunEnv,
    PATH: `${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
    TUT_HERDR_PANES: JSON.stringify(panes),
    TUT_USER_CONFIG_DIR: CHAIN_L2,
    ...extra,
  });

  it("no reuse: a same-agent pane is ignored; the round births a NEW `<task_id>.<role>` pane", async () => {
    // An agent-named pane exists (the pre-fresh mechanism would have reused it)
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], {
      env: fixtureEnv([HUB_PANE, { pane_id: "w2:p1", label: "pi", workspace_id: "w11", cwd: "/repo", agent_status: "idle" }]),
    });

    expect(stdout).not.toContain("send-text w2:p1"); // the existing pane receives NOTHING
    expect(stdout).toContain("DRY-RUN: birth: herdr tab create --workspace w11 --cwd /repo --label TUT executor --no-focus");
    expect(stdout).toContain("DRY-RUN: birth: herdr pane rename <root> t1.executor");
    expect(stdout).toContain("DRY-RUN: birth: herdr pane run <root> cd -- '/repo' && env 'PI_SKIP_VERSION_CHECK=1' 'pi'");
    expect(stdout).toContain("DRY-RUN: ready-probe <label:t1.executor> (born pane");
    expect(stdout).toContain("(agent 'pi', label 't1.executor')");
  });

  it("cleanup preview: non-continuity idle panes close; a live continuity seat is KEPT; working ones are skipped with a warning", async () => {
    const { stdout, stderr } = await runLaunch(LAUNCH_SH, ["t1", "reviewer", "pi"], {
      env: fixtureEnv([
        HUB_PANE,
        { pane_id: "w11:p5", label: "t1.architect", workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
        { pane_id: "w11:p6", label: "t1.executor", workspace_id: "w11", cwd: "/repo", agent_status: "working" },
      ]),
    });

    expect(stdout).toContain("DRY-RUN: cleanup: herdr pane close w11:p5 (label 't1.architect')"); // idle, non-continuity → closed (the original shape)
    expect(stdout).not.toContain("w11:p6"); // working → NOT closed (warning on stderr instead)
    expect(stderr).toContain("pane 't1.executor' (w11:p6) still working — left open for the next lifecycle hook");
  });

  it("legacy labels (arch/exec/review) are no longer lookup keys — no rename hint, no hit", async () => {
    const { stdout, stderr } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], {
      env: fixtureEnv([HUB_PANE, { pane_id: "w1:p1", label: "exec", workspace_id: "w11", cwd: "/repo", agent_status: "idle" }]),
    });

    expect(stdout).not.toContain("send-text w1:p1"); // the legacy-labeled pane is not a target
    expect(stderr).not.toContain("legacy label"); // and no rename hint is offered
    expect(stdout).toContain("DRY-RUN: birth: herdr tab create --workspace w11 --cwd /repo --label TUT executor");
  });

  it("agent not on PATH → dry-run tolerates with a skip note (real failure path errors)", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "no-such-cli-x"], {
      env: fixtureEnv([HUB_PANE]),
    });

    expect(stdout).toContain("DRY-RUN: birth skipped: agent 'no-such-cli-x' not on PATH");
  });
});

/** Prompt head-fragments for every role, embedded in fixture screens: the
 *  text-match landing criterion (7.2.1 step 3) only accepts a screen that
 *  actually shows the sent text. */
const PROMPT_MARK =
  "轮到你了（role: architect）：请用 轮到你了（role: executor）：请用 轮到你了（role: reviewer）：请用 开始本轮工作，完成后发布相应记录（context.publish）。 （tut delivery A1B2C3D4）";

// --- closed-loop delivery (land-confirm + verified submit) ------------
// The REAL script against the fixture herdr (non-dry-run): birth runs for
// real (adopt-root), the ready-probe polls `pane read` until the receiver
// UI is up, then the CLOSED-LOOP tail — send-text → land-confirm read →
// Enter → out-of-band relay/read → submit-verify by the INPUT-BOX-CLEARED criterion, with a long
// bounded loop of clocked Enter resends when the box keeps holding the
// text. Screen TIMELINES (TUT_HERDR_READ_SCRIPT) script the pre-text
// receiver (boot empties → painted UI); TUT_HERDR_READ_ENTER_SCRIPT
// scripts the post-text screens by ENTER COUNT (each Enter swallowed
// until the k-th commits — causal, poll-cadence-independent). Fast knobs
// keep tests quick; defaults 250/1500/15000, 5000/3000 and
// 1500/30000 (retry interval / resend window).

describe("launch.sh delivery tail (birth → ready-probe → send-text → land-confirm → relay-verified submit)", () => {
  const FIXTURE_BIN = path.join(path.resolve(import.meta.dirname, ".."), "test", "bin");
  const NODE_DIR = path.dirname(process.execPath);
  const ANCHOR_PANE = { pane_id: "w9:p0", label: "hub", workspace_id: "w9", cwd: "/x", agent_status: "idle" };

  const BORN_SCREENS = JSON.stringify([
    "",
    "",
    "pi TUI ready — status 0.0%",
    "pi TUI ready — status 0.0%",
    "pi TUI ready — status 0.0%",
    "pi TUI ready — status 0.0%",
    `pi TUI ready ▎${PROMPT_MARK}`,
    "working — round started",
  ]);

  /** Env running the real launch.sh against the fixture herdr + fixture agent CLIs. */
  const liveEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
    TUT_HERDR_PANES: JSON.stringify([ANCHOR_PANE]),
    TUT_SPLIT_BASE: "w9:p0", // escape-hatch anchor (no tut-hub pane in the fixture)
    TUT_HUB_URL: "http://127.0.0.1:1", // deterministic: no hub, file chain + stderr note
    TUT_USER_CONFIG_DIR: CHAIN_L2, // hermetic chain (L1 root /x does not exist)
    TUT_DELIVERY_NONCE: "A1B2C3D4",
    TUT_READY_POLL_MS: "20",
    TUT_READY_FLOOR_MS: "0",
    TUT_READY_TIMEOUT_MS: "4000",
    TUT_TEXT_LAND_TIMEOUT_MS: "200",
    TUT_SUBMIT_TIMEOUT_MS: "100",
    TUT_SUBMIT_RETRY_MS: "40",
    // ONE shared submit budget (was a 400ms retry window on top of a 100ms
    // initial one). Under full-suite load each fixture call costs real
    // latency; the budget absorbs it without weakening any assertion.
    TUT_SUBMIT_RETRY_TIMEOUT_MS: "800",
    ...extra,
  });

  it(
    "born success: gate reads → send-text → land-confirm read → ONE Enter → verify read — full order, no extra Enter",
    async () => {
      const log = path.join(os.tmpdir(), `tut-born-ready-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stdout, stderr } = await runLaunch(
          LAUNCH_SH,
          ["t1", "architect", "pi"], // first-round form: an ordinary round hand-off
          {
            env: liveEnv({ TUT_HERDR_LOG: log, TUT_HERDR_READ_SCRIPT: BORN_SCREENS }),
          },
        );
        expect(stdout).toBe(""); // real mode: herdr envelopes are consumed, not echoed
        expect(stderr).not.toContain("resending"); // no resend on the happy path

        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        // Birth (real, against the fixture): anchored tab create + adopt the
        // shipped root pane (rename + run) — no split, no move.
        const createIdx = lines.findIndex((l) => l === "tab create --workspace w9 --cwd /x --label TUT architect --no-focus");
        expect(createIdx).toBeGreaterThanOrEqual(0);
        const runIdx = lines.findIndex((l) => l.startsWith("pane run FIX:root1 ") && l.includes("probe-runner.js"));
        expect(runIdx).toBeGreaterThan(createIdx);
        expect(lines).toContain("pane rename FIX:root1 t1.architect"); // round pane label from round one
        // FULL closed-loop order (design 斨1). Gate: exactly 6 reads (base
        // + 2 boot empties + the four-sample quiescence run).
        const isRead = (l: string) => l.startsWith("pane read FIX:root1");
        const firstRead = lines.findIndex(isRead);
        expect(firstRead).toBe(runIdx + 1);
        const sendTextIdx = lines.findIndex((l) => l.startsWith("pane send-text FIX:root1"));
        expect(sendTextIdx).toBe(firstRead + 6); // base + poll + paint + quiescence run
        const enterIdx = lines.findIndex((l) => l === "pane send-keys FIX:root1 Enter");
        // Land-confirm: exactly one read between the text and the Enter.
        expect(enterIdx).toBe(sendTextIdx + 2);
        expect(lines[sendTextIdx]).toBe(`pane send-text FIX:root1 轮到你了（role: architect）：请用 Context Hub 读取任务 t1 的完整上下文（context.read），按你的 role skill（${path.resolve(SCRIPTS_DIR, "../skills/architect.md")}）开始本轮工作，完成后发布相应记录（context.publish）。 （tut delivery A1B2C3D4）`);
        // Exactly ONE Enter (success on first try), followed by one relay
        // read and the existing verify read. This fixture has no birth relay,
        // so the compatibility path records unavailable and never injects
        // probe text into the foreground TUI.
        expect(lines.filter((l) => l === "pane send-keys FIX:root1 Enter")).toHaveLength(1);
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 轮到你了"))).toHaveLength(1); // prompt never re-sent
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 printf 'TUT-DELIVERY-PROBE-"))).toHaveLength(0);
        expect(lines[enterIdx + 1]).toMatch(/^pane read FIX:root1 /u); // relay read
        expect(lines[enterIdx + 2]).toMatch(/^pane read FIX:root1 /u); // submit verify read
        expect(lines).toHaveLength(enterIdx + 3);
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it("round hand-off live: cleanup pass, anchored birth, gated delivery — full order", async () => {
    const log = path.join(os.tmpdir(), `tut-live-delivery-${process.pid}.log`);
    rmSync(log, { force: true });
    try {
      const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], {
        env: liveEnv({ TUT_HERDR_LOG: log, TUT_HERDR_READ_SCRIPT: BORN_SCREENS }),
      });
      expect(stdout).toBe("");
      const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
      // Order: (stale-pane scan) → birth → probe → closed-loop delivery.
      // Exact pane-list call counts are not contractual; relative order is.
      const lastList = lines.map((l) => l === "pane list").lastIndexOf(true);
      const createIdx = lines.findIndex((l) => l === "tab create --workspace w9 --cwd /x --label TUT executor --no-focus");
      expect(createIdx).toBeGreaterThan(lastList);
      expect(lines).toContain("pane rename FIX:root1 t1.executor");
      const runIdx = lines.findIndex((l) => l.startsWith("pane run FIX:root1 ") && l.includes("probe-runner.js"));
      expect(runIdx).toBeGreaterThan(createIdx);
      const sendTextIdx = lines.findIndex((l) => l.startsWith("pane send-text FIX:root1"));
      expect(lines[sendTextIdx]).toBe(`pane send-text FIX:root1 轮到你了（role: executor）：请用 Context Hub 读取任务 t1 的完整上下文（context.read），按你的 role skill（${path.resolve(SCRIPTS_DIR, "../skills/executor.md")}）开始本轮工作，完成后发布相应记录（context.publish）。 （tut delivery A1B2C3D4）`);
      // The closed loop: gate reads precede the text, ONE Enter, one relay
      // read, then the verify read.
      expect(lines.slice(runIdx + 1, sendTextIdx).every((l) => l.startsWith("pane read FIX:root1"))).toBe(true);
      expect(lines.slice(runIdx + 1, sendTextIdx).length).toBe(6);
      expect(lines.filter((l) => l === "pane send-keys FIX:root1 Enter")).toHaveLength(1);
      const enterIdx = lines.indexOf("pane send-keys FIX:root1 Enter");
      expect(lines.slice(sendTextIdx + 1, enterIdx).length).toBe(1); // land-confirm read
      expect(lines[enterIdx + 1]).toMatch(/^pane read FIX:root1 /u);
      expect(lines[enterIdx + 2]).toMatch(/^pane read FIX:root1 /u);
      expect(lines).toHaveLength(enterIdx + 3);
    } finally {
      rmSync(log, { force: true });
    }
  });

  it(
    "codex-shaped fail-recover: first Enter swallowed → clocked resend → the second Enter commits",
    async () => {
      // The fail-recover shape, scripted CAUSALLY by Enter count: the text
      // lands (0-Enter screen = the composer holding it), the FIRST Enter
      // is swallowed by the post-first-frame init window (screen unchanged,
      // box holds), the SECOND commits (the bottom region changes — the
      // composer let go). The loop resends Enter ONLY — never the text —
      // and confirms on the box clearing, not on "any change".
      const boot = JSON.stringify(["", "", "codex shell", "codex shell", "codex shell", "codex shell"]);
      const enterScreens = JSON.stringify([
        `codex shell ▎${PROMPT_MARK}`,
        `codex shell ▎${PROMPT_MARK}`,
        "codex working — round started",
      ]);
      const log = path.join(os.tmpdir(), `tut-fail-recover-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stderr } = await runLaunch(LAUNCH_SH, ["t-fr", "architect", "pi"], {
          env: liveEnv({
            TUT_HERDR_LOG: log,
            TUT_HERDR_READ_SCRIPT: boot,
            TUT_HERDR_READ_ENTER_SCRIPT: enterScreens,
          }),
        });
        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 轮到你了"))).toHaveLength(1);
        expect(lines.filter((l) => l === "pane send-keys FIX:root1 Enter")).toHaveLength(2);
        expect(stderr).toContain("resending Enter (attempt 2)");
        expect(stderr).toContain("input box cleared on FIX:root1 — submit confirmed (attempt 2)");
        expect(stderr).not.toContain("submit not confirmed"); // recovered, not exhausted
        // The confirming read is the LAST herdr call — the loop stopped.
        expect(lines[lines.length - 1]).toMatch(/^pane read FIX:root1 /);
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it(
    "multi-swallow recovery: FOUR swallowed Enters, the fifth commits — the loop resends until the box clears",
    async () => {
      // The acceptance scenario for the loop resend: the swallow window
      // outlives several Enter attempts (the observed race shape — it
      // outlived even the idle readiness signal). Every Enter-indexed
      // screen holds the composer text until screens[5] lets go; the loop
      // must keep resending Enter on the clock, never re-send the text,
      // and confirm on the box clearing at attempt 5.
      const boot = JSON.stringify(["", "", "codex shell", "codex shell", "codex shell", "codex shell"]);
      const enterScreens = JSON.stringify([
        `codex shell ▎${PROMPT_MARK}`,
        `codex shell ▎${PROMPT_MARK}`,
        `codex shell ▎${PROMPT_MARK}`,
        `codex shell ▎${PROMPT_MARK}`,
        `codex shell ▎${PROMPT_MARK}`,
        "codex working — round started",
      ]);
      const log = path.join(os.tmpdir(), `tut-multi-swallow-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stderr } = await runLaunch(LAUNCH_SH, ["t-ms", "architect", "pi"], {
          env: liveEnv({
            TUT_HERDR_LOG: log,
            TUT_HERDR_READ_SCRIPT: boot,
            TUT_HERDR_READ_ENTER_SCRIPT: enterScreens,
            TUT_SUBMIT_TIMEOUT_MS: "40",
            TUT_SUBMIT_RETRY_TIMEOUT_MS: "2000",
          }),
        });
        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 轮到你了"))).toHaveLength(1); // text never re-sent
        expect(lines.filter((l) => l === "pane send-keys FIX:root1 Enter")).toHaveLength(5);
        expect(stderr).toContain("resending Enter (attempt 5)");
        expect(stderr).toContain("input box cleared on FIX:root1 — submit confirmed (attempt 5)");
        expect(stderr).not.toContain("submit not confirmed");
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it(
    "an unavailable birth relay keeps the compatibility box-cleared path safe",
    async () => {
      const boot = JSON.stringify(["", "", "codex shell", "codex shell", "codex shell", "codex shell"]);
      const enterScreens = JSON.stringify([`codex shell ▎${PROMPT_MARK}`, "working"]);
      const log = path.join(os.tmpdir(), `tut-probe-fail-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stderr } = await runLaunch(LAUNCH_SH, ["t-pf", "architect", "pi"], {
          env: liveEnv({
            TUT_HERDR_LOG: log,
            TUT_HERDR_READ_SCRIPT: boot,
            TUT_HERDR_READ_ENTER_SCRIPT: enterScreens,
          }),
        });
        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 轮到你了"))).toHaveLength(1);
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 printf 'TUT-DELIVERY-PROBE-"))).toHaveLength(0);
        expect(lines.filter((l) => l === "pane send-keys FIX:root1 Enter")).toHaveLength(1);
        expect(stderr).toMatch(/probe-result pane=FIX:root1 attempt=1 .*dispatch=unavailable found=false /u);
        expect(stderr).toMatch(/submit-confirmed pane=FIX:root1 attempt=1 phase=verify /u);
        expect(stderr).not.toContain("submit not confirmed");
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it(
    "resend window exhaustion: box never clears → clocked bounded resends, manual-fallback note, STILL EXIT 0",
    async () => {
      // Nothing ever lets go of the text (dead screen): the loop resends
      // Enter on the clock inside the ONE shared budget (the 40ms initial
      // window only consumes part of it — no window is re-armed), then
      // points the human at the input box and still exits 0 — a failure
      // exit would re-enter (duplicate birth), the worse outcome the
      // design rejects.
      const boot = JSON.stringify(["", "", "ui", "ui", "ui", "ui"]);
      const enterScreens = JSON.stringify([`ui ▎${PROMPT_MARK}`]); // last screen repeats: held forever
      const log = path.join(os.tmpdir(), `tut-exhaust-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stderr } = await runLaunch(LAUNCH_SH, ["t-ex", "architect", "pi"], {
          env: liveEnv({
            TUT_HERDR_LOG: log,
            TUT_HERDR_READ_SCRIPT: boot,
            TUT_HERDR_READ_ENTER_SCRIPT: enterScreens,
            TUT_SUBMIT_TIMEOUT_MS: "40",
            TUT_SUBMIT_RETRY_TIMEOUT_MS: "1000",
          }),
        });
        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 轮到你了"))).toHaveLength(1); // text still sent once
        const enters = lines.filter((l) => l === "pane send-keys FIX:root1 Enter");
        expect(enters.length).toBeGreaterThanOrEqual(3); // the initial Enter + clocked resends, all inside one budget
        expect(stderr).toContain("submit not confirmed on FIX:root1 within 1000ms after");
        // Evidence-honest guidance, timing-dependent which one: a tail read
        // keeps the box "held" (manual-Enter note), but an in-flight last
        // Enter (legal: started inside, returned past the deadline)
        // honestly degrades the evidence to unknown (check-the-pane note).
        // Both are correct; a blind Enter hint must never appear.
        expect(
          stderr.includes("press Enter there manually to start the round") ||
            stderr.includes("inspect the pane and press Enter there manually only if the prompt is still visible"),
        ).toBe(true);
        // Tail shape is timing-legal BOTH ways: a normal exhaustion ends on
        // an observation read, but an Enter that STARTED inside the budget
        // may legitimately return after it (in-flight tail — no probe or
        // read may follow it past the deadline). Assert the real invariants
        // instead of freezing the tail: the run still exits 0 (execFile
        // rejects any non-zero exit, so reaching these lines IS that check)
        // and the resends are bounded.
        const last = lines[lines.length - 1] ?? "";
        expect(last.startsWith("pane read FIX:root1 ") || last === "pane send-keys FIX:root1 Enter").toBe(true);
        // Hard bound: resends are ≥ TUT_SUBMIT_RETRY_MS (40ms) apart inside
        // the 1000ms budget → at most 1 + ⌊1000/40⌋ Enters can ever fire.
        expect(enters.length).toBeLessThanOrEqual(26);
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it(
    "land-confirm timeout degrades to the honest never-landed path: observe-only wait, zero Enter, give-up + escalation",
    async () => {
      // The prompt text never appears within TUT_TEXT_LAND_TIMEOUT_MS (the
      // screen repaints WITHOUT the text — the old any-change criterion
      // took that as a landed prompt): honest stderr note, then the submit
      // loop runs degraded (box evidence stays unknown until the text is
      // seen), resends Enter on the clock, and gives up with
      // land-never-observed — still exit 0.
      const screens = JSON.stringify([
        "",
        "",
        "ui",
        "ui",
        "ui",
        "ui",
        "ui",
        "ui",
        "submitted — round started",
      ]);
      const log = path.join(os.tmpdir(), `tut-land-to-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stderr } = await runLaunch(LAUNCH_SH, ["t-lt", "architect", "pi"], {
          env: liveEnv({ TUT_HERDR_LOG: log, TUT_HERDR_READ_SCRIPT: screens, TUT_TEXT_LAND_TIMEOUT_MS: "80" }),
        });
        expect(stderr).toContain("prompt text not observed on FIX:root1 within 80ms — the receiver may not accept input yet; entering the no-blind-Enter wait (Enter only after the text is observed)");
        expect(stderr).toContain("submit not confirmed on FIX:root1 within 800ms after 0 Enters");
        expect(stderr).toContain("the prompt text was never observed on screen; no Enter was sent");
        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        expect(lines.filter((l) => l === "pane send-keys FIX:root1 Enter")).toHaveLength(0); // NO blind Enter onto a possibly-modal screen
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 轮到你了"))).toHaveLength(1); // text never re-sent
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it(
    "probe timeout degrades to delivering anyway — every closed-loop step notes and degrades, exit 0",
    async () => {
      const log = path.join(os.tmpdir(), `tut-ready-timeout-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stderr } = await runLaunch(LAUNCH_SH, ["t-to", "architect", "pi"], {
          env: liveEnv({
            TUT_HERDR_LOG: log,
            TUT_HERDR_PANE_READ: "", // never paints → every step times out
            TUT_READY_TIMEOUT_MS: "120",
            TUT_SUBMIT_TIMEOUT_MS: "20",
            TUT_SUBMIT_RETRY_TIMEOUT_MS: "1200",
          }),
        });
        // All three degradation notes, in the pipeline's order.
        expect(stderr).toContain("not observed ready within 120ms — delivering anyway");
        expect(stderr).toContain("prompt text not observed on FIX:root1 within 200ms — the receiver may not accept input yet; entering the no-blind-Enter wait (Enter only after the text is observed)");
        expect(stderr).toContain("submit not confirmed on FIX:root1 within 1200ms after 0 Enters");
        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        expect(lines.filter((l) => l.startsWith("pane send-text FIX:root1 轮到你了"))).toHaveLength(1);
        // The text never appeared, so NO Enter ever fired (the blind-Enter
        // lesson): the wait loop burns the budget on reads only.
        expect(lines.filter((l) => l === "pane send-keys FIX:root1 Enter")).toHaveLength(0);
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );
});

// --- step-timestamped delivery diagnostics (decoupled observer) -------------

describe("launch.sh delivery diagnostics (tut-delivery timeline)", () => {
  const FIXTURE_BIN = path.join(path.resolve(import.meta.dirname, ".."), "test", "bin");
  const NODE_DIR = path.dirname(process.execPath);
  const ANCHOR_PANE = { pane_id: "w9:p0", label: "hub", workspace_id: "w9", cwd: "/x", agent_status: "idle" };

  const liveEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
    TUT_HERDR_PANES: JSON.stringify([ANCHOR_PANE]),
    TUT_SPLIT_BASE: "w9:p0",
    TUT_HUB_URL: "http://127.0.0.1:1",
    TUT_USER_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "tut-diag-l2-")),
    TUT_DELIVERY_NONCE: "A1B2C3D4",
    TUT_READY_POLL_MS: "20",
    TUT_READY_FLOOR_MS: "0",
    TUT_READY_TIMEOUT_MS: "4000",
    TUT_TEXT_LAND_TIMEOUT_MS: "200",
    TUT_SUBMIT_TIMEOUT_MS: "100",
    TUT_SUBMIT_RETRY_MS: "40",
    // ONE shared submit budget; sized like the delivery-tail describe above
    // to absorb fixture-call latency under full-suite load.
    TUT_SUBMIT_RETRY_TIMEOUT_MS: "800",
    ...extra,
  });

  it(
    "every delivery step lands a tut-delivery line; timestamps are epoch-ms and non-decreasing",
    async () => {
      const log = path.join(os.tmpdir(), `tut-diag-on-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stderr } = await runLaunch(LAUNCH_SH, ["t-dg", "architect", "pi"], {
          env: liveEnv({
            TUT_HERDR_LOG: log,
            TUT_HERDR_READ_SCRIPT: JSON.stringify([
              "",
              "",
              "pi TUI ready — status 0.0%",
              "pi TUI ready — status 0.0%",
              "pi TUI ready — status 0.0%",
              "pi TUI ready — status 0.0%",
              // One non-matching repaint first: the land loop's read line is
              // part of the covered event chain, then the fragment matches.
              "pi TUI ready — repaint",
              `pi TUI ready ▎${PROMPT_MARK}`,
              "working — round started",
            ]),
          }),
        });
        const diagLines = stderr.split("\n").filter((l) => l.startsWith("tut-delivery "));
        expect(diagLines.length).toBeGreaterThanOrEqual(8);
        // The chain is fully covered: gate → send-text → land → enter →
        // verify reads → confirm (放弃/give-up covered by the exhaustion
        // test above via its stderr note).
        const events = diagLines.map((l) => l.replace(/^tut-delivery t=\d+ /, ""));
        expect(events.some((e) => e.startsWith("gate-start pane=FIX:root1"))).toBe(true);
        expect(events.some((e) => e.startsWith("read pane=FIX:root1 step=gate "))).toBe(true);
        expect(events.some((e) => e.startsWith("gate-release pane=FIX:root1"))).toBe(true);
        expect(events.some((e) => e.startsWith("send-text pane=FIX:root1 branch=born "))).toBe(true);
        expect(events.some((e) => /^probe-send pane=FIX:root1 attempt=1 phase=initial marker=TUT-DELIVERY-PROBE-[0-9A-F]{8}$/u.test(e))).toBe(true);
        expect(events.some((e) => /^probe-result pane=FIX:root1 attempt=1 phase=initial marker=TUT-DELIVERY-PROBE-[0-9A-F]{8} dispatch=unavailable found=false /u.test(e))).toBe(true);
        expect(events.some((e) => e.startsWith("read pane=FIX:root1 step=land "))).toBe(true);
        expect(events.some((e) => e.startsWith("land-observed pane=FIX:root1"))).toBe(true);
        expect(events.some((e) => e.startsWith("enter pane=FIX:root1 attempt=1 "))).toBe(true);
        expect(events.some((e) => e.startsWith("read pane=FIX:root1 step=verify "))).toBe(true);
        expect(events.some((e) => e.startsWith("submit-confirmed pane=FIX:root1 attempt=1"))).toBe(true);
        // Timestamps: epoch-ms digits, non-decreasing — the timeline is
        // reconstructible by aligning it with the notify-pane log.
        const ts = diagLines.map((l) => Number(l.match(/^tut-delivery t=(\d+)/)?.[1] ?? Number.NaN));
        expect(ts.every((t) => Number.isFinite(t) && t > 1_000_000_000_000)).toBe(true);
        // Adjacent-pair traversal: no optional indexed access (repo runs
        // with noUncheckedIndexedAccess), the guard doubles as narrowing.
        let prev: number | undefined;
        for (const t of ts) {
          if (prev !== undefined) expect(t).toBeGreaterThanOrEqual(prev);
          prev = t;
        }
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it(
    "diagnostics are decoupled: TUT_DELIVERY_DIAG=0 silences the lines, the delivery is identical",
    async () => {
      // The same swallowed-once-then-commit scenario with the diagnostics
      // off: same Enter count, same success — observation never gates
      // behavior (the loop ignores the diag lines entirely).
      const boot = JSON.stringify(["", "", "codex shell", "codex shell", "codex shell", "codex shell"]);
      const enterScreens = JSON.stringify([
        `codex shell ▎${PROMPT_MARK}`,
        `codex shell ▎${PROMPT_MARK}`,
        "codex working — round started",
      ]);
      const runOnce = async (knob: string) => {
        const log = path.join(os.tmpdir(), `tut-diag-${knob}-${process.pid}.log`);
        rmSync(log, { force: true });
        try {
          const r = await runLaunch(LAUNCH_SH, ["t-dc", "architect", "pi"], {
            env: liveEnv({
              TUT_HERDR_LOG: log,
              TUT_HERDR_READ_SCRIPT: boot,
              TUT_HERDR_READ_ENTER_SCRIPT: enterScreens,
              TUT_DELIVERY_DIAG: knob,
            }),
          });
          return {
            diag: r.stderr.split("\n").filter((l) => l.startsWith("tut-delivery ")).length,
            confirmed: r.stderr.includes("input box cleared on FIX:root1 — submit confirmed (attempt 2)"),
            lines: readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0),
          };
        } finally {
          rmSync(log, { force: true });
        }
      };
      const on = await runOnce("1");
      const off = await runOnce("0");
      expect(on.diag).toBeGreaterThan(0);
      expect(off.diag).toBe(0);
      const shape = (lines: string[]) => ({
        promptTexts: lines.filter((l) => l.startsWith("pane send-text FIX:root1 轮到你了")).length,
        probeTexts: lines.filter((l) => l.startsWith("pane send-text FIX:root1 printf 'TUT-DELIVERY-PROBE-")).length,
        enters: lines.filter((l) => l === "pane send-keys FIX:root1 Enter").length,
      });
      expect(shape(on.lines)).toEqual({ promptTexts: 1, probeTexts: 0, enters: 2 });
      expect(shape(off.lines)).toEqual(shape(on.lines)); // identical delivery
      expect(off.confirmed).toBe(true); // off still succeeds the same way
    },
    20_000,
  );

  it(
    "diagnostics persist to <root>/.context-hub/delivery.log with task/role context; stderr keeps its original shape",
    async () => {
      // Pane scrollback is finite and can flush mid-incident — the durable
      // copy lives under the project root (TUT_PROJECT_ROOT here; live the
      // anchor-cwd chain root serves the same role). One file for all
      // tasks: every persisted line carries task=/role= so concurrent
      // tasks stay distinguishable. The stderr line stays byte-shaped as
      // before (the notify pane tees it; the timeline tests parse it).
      const proj = mkdtempSync(path.join(os.tmpdir(), "tut-diag-persist-"));
      const log = path.join(os.tmpdir(), `tut-diag-persist-${process.pid}.log`);
      rmSync(log, { force: true });
      const boot = JSON.stringify([
        "",
        "",
        "ui",
        "ui",
        "ui",
        "ui",
        `ui ▎${PROMPT_MARK}`,
        "working — round started",
      ]);
      try {
        const { stderr } = await runLaunch(LAUNCH_SH, ["t-pr", "architect", "pi"], {
          env: liveEnv({
            TUT_PROJECT_ROOT: proj,
            TUT_HERDR_LOG: log,
            TUT_HERDR_READ_SCRIPT: boot,
          }),
        });
        const fileLines = readFileSync(path.join(proj, ".context-hub", "delivery.log"), "utf8")
          .split("\n")
          .filter((l) => l.length > 0);
        expect(fileLines.length).toBeGreaterThan(0);
        expect(fileLines.every((l) => /^tut-delivery t=\d+ task=t-pr role=architect /.test(l))).toBe(true);
        // Same event stream on both sinks, same order — the file is the
        // durable copy of the stderr line, event fields included.
        const errDiag = stderr.split("\n").filter((l) => l.startsWith("tut-delivery "));
        expect(errDiag.length).toBe(fileLines.length);
        expect(
          errDiag.every((l, i) => {
            const fileTail = fileLines[i]?.replace(/^tut-delivery t=\d+ task=t-pr role=architect /, "");
            return l.startsWith("tut-delivery t=") && !l.includes("task=") && l.replace(/^tut-delivery t=\d+ /, "") === fileTail;
          }),
        ).toBe(true);
      } finally {
        rmSync(proj, { recursive: true, force: true });
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it(
    "TUT_DELIVERY_DIAG=0 writes nothing to disk either — one switch silences both sinks",
    async () => {
      const proj = mkdtempSync(path.join(os.tmpdir(), "tut-diag-disk-off-"));
      try {
        await runLaunch(LAUNCH_SH, ["t-po", "architect", "pi"], {
          env: liveEnv({
            TUT_PROJECT_ROOT: proj,
            TUT_DELIVERY_DIAG: "0",
            TUT_READY_TIMEOUT_MS: "100",
            TUT_TEXT_LAND_TIMEOUT_MS: "80",
            TUT_SUBMIT_RETRY_TIMEOUT_MS: "200",
          }),
        });
        expect(existsSync(path.join(proj, ".context-hub", "delivery.log"))).toBe(false);
        expect(existsSync(path.join(proj, ".context-hub"))).toBe(false); // not even the dir — lazy setup
      } finally {
        rmSync(proj, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

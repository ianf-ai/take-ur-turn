import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../src/cli.js";

// tut assign + workspace.json — parse layer first; this file also has the
// handler and launch.sh resolution tests.

/**
 * The repo's scripts/ dir from this test file's own location — NOT
 * repo by one level in every layout;
 * the handler under test resolves the same dir correctly via its own
 * module-relative URL (cli.ts's LAUNCH_SCRIPT idiom).
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

const WS_FILE = path.join(SCRIPTS_DIR, "workspace.json");
const HIDDEN_FILE = `${WS_FILE}.hidden`;

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

describe("tut assign handler (real scripts/workspace.json, snapshotted)", () => {
  // The handler targets the repo's real scripts/workspace.json (module-relative
  // scriptsDir — the CLI never depends on cwd). Snapshot before, restore after:
  // tests may seed variants (unknown keys, missing entries, corruption) on top.
  let backup: string;
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    backup = readFileSync(WS_FILE, "utf8");
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    writeFileSync(WS_FILE, backup);
  });

  it("sets roles.<role>.agent and prints the confirmation line", async () => {
    const code = await main(["assign", "executor", "codex"]);

    expect(code).toBe(0);
    expect(io.out()).toContain("assign: executor → codex (pane label 'exec')");
    const after = JSON.parse(readFileSync(WS_FILE, "utf8")) as { roles: Record<string, { label: string; agent: string }> };
    expect(after.roles.executor).toEqual({ label: "exec", agent: "codex" });
  });

  it("preserves $comment, unknown top-level keys, unknown entry keys, and sibling roles", async () => {
    const seeded = JSON.parse(backup) as { $comment: string; roles: Record<string, Record<string, unknown>> } & Record<string, unknown>;
    seeded.experimental = { keep: true }; // unknown top-level key must survive
    seeded.roles.executor = {
      ...seeded.roles.executor,
      hint: "keep-me", // unknown key inside the role entry must survive
    };
    writeFileSync(WS_FILE, `${JSON.stringify(seeded, null, 2)}\n`);

    const code = await main(["assign", "executor", "codex"]);

    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(WS_FILE, "utf8")) as {
      $comment: string;
      experimental: unknown;
      roles: Record<string, Record<string, unknown>>;
    };
    expect(after.$comment).toBe(seeded.$comment);
    expect(after.experimental).toEqual({ keep: true });
    expect(after.roles.executor).toEqual({ label: "exec", agent: "codex", hint: "keep-me" });
    expect(after.roles.architect).toEqual(seeded.roles.architect);
    expect(after.roles.reviewer).toEqual(seeded.roles.reviewer);
  });

  it("label is never modified by assign (physical seat belongs to herdr rename)", async () => {
    const seeded = JSON.parse(backup) as { roles: Record<string, { label: string; agent: string }> };
    const reviewer = seeded.roles.reviewer!; // the repo file always seeds all three roles
    reviewer.label = "custom-seat"; // a renamed pane, not the default
    writeFileSync(WS_FILE, `${JSON.stringify(seeded, null, 2)}\n`);

    const code = await main(["assign", "reviewer", "pi"]);

    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(WS_FILE, "utf8")) as { roles: Record<string, { label: string; agent: string }> };
    expect(after.roles.reviewer).toEqual({ label: "custom-seat", agent: "pi" });
  });

  it("creates a missing role entry with the label resolved via the frozen fallback order", async () => {
    const seeded = JSON.parse(backup) as { roles: Record<string, unknown> };
    delete seeded.roles.reviewer;
    writeFileSync(WS_FILE, `${JSON.stringify(seeded, null, 2)}\n`);

    const code = await main(["assign", "reviewer", "pi"]);

    expect(code).toBe(0);
    // workspace entry absent → resolveRole falls back (routes.json: reviewer → review)
    expect(io.out()).toContain("assign: reviewer → pi (pane label 'review')");
    const after = JSON.parse(readFileSync(WS_FILE, "utf8")) as { roles: Record<string, { label: string; agent: string }> };
    expect(after.roles.reviewer).toEqual({ label: "review", agent: "pi" });
  });

  it("corrupt workspace.json: exit 1, clear message, file not clobbered", async () => {
    const corrupt = "{ not json";
    writeFileSync(WS_FILE, corrupt);

    const code = await main(["assign", "executor", "codex"]);

    expect(code).toBe(1);
    expect(io.err()).toContain("tut: assign:");
    expect(readFileSync(WS_FILE, "utf8")).toBe(corrupt); // untouched
  });

  it("missing workspace.json: exit 1 with a clear message", async () => {
    renameSync(WS_FILE, HIDDEN_FILE);
    try {
      const code = await main(["assign", "executor", "codex"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("tut: assign:");
    } finally {
      renameSync(HIDDEN_FILE, WS_FILE);
    }
  });
});

// --- launch.sh resolution ------------------------------------------------------
// The REAL script with TUT_DRY_RUN=1: it prints the herdr command instead of
// running it; a missing label→pane mapping is tolerated in dry-run, so no live
// Herdr panes are required (a live Herdr merely upgrades the target to an id).

const LAUNCH_SH = path.join(SCRIPTS_DIR, "launch.sh");
const runLaunch = promisify(execFile);
const dryRunEnv = { ...process.env, TUT_DRY_RUN: "1" } as NodeJS.ProcessEnv;

describe("launch.sh agent resolution (cast → workspace agent → routes → defaults)", () => {
  it("explicit agent (3rd arg, the form tut start-next / auto use): dry-run shows the agent-keyed target", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], { env: dryRunEnv });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("(agent 'pi')");
    expect(stdout).toContain("t1");
    expect(stdout).toContain("context.read");
  });

  it("self-resolution without the 3rd arg: falls to the file chain (workspace.json agent)", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor"], { env: dryRunEnv });

    expect(stdout).toContain("DRY-RUN");
    // workspace.json executor agent = pi (both committed and live lineups agree)
    expect(stdout).toContain("(agent 'pi')");
  });

  it("workspace.json absent: routes.json value is read as the agent name (legacy semantics)", async () => {
    renameSync(WS_FILE, HIDDEN_FILE);
    try {
      const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor"], { env: dryRunEnv });

      expect(stdout).toContain("DRY-RUN");
      expect(stdout).toContain("(agent 'exec')"); // routes.json: executor → "exec" ≡ agent name now
    } finally {
      renameSync(HIDDEN_FILE, WS_FILE);
    }
  });

  it("role in neither file: DEFAULT_ROLES agent (no error) — unknown roles fall back to codex", async () => {
    renameSync(WS_FILE, HIDDEN_FILE);
    try {
      const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "boss"], { env: dryRunEnv });

      expect(stdout).toContain("DRY-RUN");
      expect(stdout).toContain("(agent 'codex')"); // defaults map fallback — the chain always yields an agent
    } finally {
      renameSync(HIDDEN_FILE, WS_FILE);
    }
  });
});

describe("launch.sh --new entry (regression guard for the resolution edit)", () => {
  it("still delivers the prompt verbatim in dry-run", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["--new", "arch", "新任务需求一句话"], { env: dryRunEnv });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("(label 'arch')");
    expect(stdout).toContain("新任务需求一句话");
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

// --- agent-keyed pane lookup + on-demand provisioning -------------------------------

describe("launch.sh pane lookup (agent-keyed, legacy transition, on-demand provisioning)", () => {
  const FIXTURE_BIN = path.join(path.resolve(import.meta.dirname, ".."), "test", "bin");
  const NODE_DIR = path.dirname(process.execPath);
  const fixtureEnv = (panes: unknown[]): NodeJS.ProcessEnv => ({
    ...dryRunEnv,
    PATH: `${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
    TUT_HERDR_PANES: JSON.stringify(panes),
  });

  it("agent-named pane hit: the pane labeled with the agent name is the target", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], {
      env: fixtureEnv([{ pane_id: "w2:p1", label: "pi" }]),
    });

    expect(stdout).toContain("DRY-RUN");
    // Delivery is literal text + an explicit Enter — no ready-probe (the
    // pane already exists, its TUI is live).
    expect(stdout).toContain("herdr pane send-text w2:p1 (agent 'pi')");
    expect(stdout).toContain("herdr pane send-keys w2:p1 Enter");
    expect(stdout).not.toContain("ready-probe");
  });

  it("legacy label hit: arch/exec/review pane still receives the round (zero migration) + stderr hint", async () => {
    const { stdout, stderr } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], {
      env: fixtureEnv([{ pane_id: "w1:p1", label: "exec" }]),
    });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain("herdr pane send-text w1:p1 (agent 'pi')"); // same pane hit as before agent-keyed lookup
    expect(stdout).toContain("herdr pane send-keys w1:p1 Enter");
    expect(stderr).toContain("legacy label");
    expect(stderr).toContain("herdr pane rename w1:p1 pi");
  });

  it("pane miss → on-demand provisioning sequence previewed in dry-run (split → tab → move → rename → run)", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], {
      env: fixtureEnv([{ pane_id: "w0:p0", label: "hub" }]), // no pi / no exec pane
    });

    expect(stdout).toContain("DRY-RUN: provision pane for agent 'pi': herdr pane split w0:p0 --direction right --no-focus");
    expect(stdout).toContain("DRY-RUN: provision: herdr tab create --label pi");
    expect(stdout).toContain("DRY-RUN: provision: herdr pane move <new> --tab <pi> --split down");
    expect(stdout).toContain("DRY-RUN: provision: herdr pane rename <new> pi");
    expect(stdout).toContain("DRY-RUN: provision: herdr pane run <new> pi");
    expect(stdout).toContain("<agent:pi>"); // placeholder target — nothing was actually run
    // Born-pane delivery carries the readiness gate before the text.
    expect(stdout).toContain("DRY-RUN: ready-probe <agent:pi> (born pane");
    expect(stdout).toContain("DRY-RUN: herdr pane send-text <agent:pi> (agent 'pi')");
    expect(stdout).toContain("DRY-RUN: herdr pane send-keys <agent:pi> Enter");
  });

  it("pane miss + agent not on PATH → dry-run tolerates with a skip note (real failure path errors)", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "no-such-cli-a7"], {
      env: fixtureEnv([{ pane_id: "w0:p0", label: "hub" }]),
    });

    expect(stdout).toContain("DRY-RUN: provision skipped: agent 'no-such-cli-a7' not on PATH");
    expect(stdout).toContain("<agent:no-such-cli-a7>");
  });
});

// --- readiness-gated delivery (send-text + send-keys Enter) -----------------------
// The REAL script against the fixture herdr (non-dry-run): provisioning runs
// for real (fixture), the ready-probe polls `pane read` until the born pane's
// receiver UI is up (output changed from the baseline and stable), then the
// prompt goes out as literal text committed by a discrete Enter. Fast probe
// knobs keep the tests quick; the defaults are 250/1500/15000.

describe("launch.sh delivery tail (ready-probe → send-text → send-keys Enter)", () => {
  const FIXTURE_BIN = path.join(path.resolve(import.meta.dirname, ".."), "test", "bin");
  const NODE_DIR = path.dirname(process.execPath);

  /** Env running the real launch.sh against the fixture herdr + fixture agent CLIs. */
  const liveEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
    TUT_HERDR_PANES: JSON.stringify([{ pane_id: "w0:p0", label: "hub" }]), // no pi pane → provisioning
    TUT_SPLIT_BASE: "w0:p0",
    TUT_READY_POLL_MS: "20",
    TUT_READY_FLOOR_MS: "0",
    TUT_READY_TIMEOUT_MS: "4000",
    ...extra,
  });

  it(
    "born pane: waits for the receiver UI (empty polls first), then send-text + Enter — in that order",
    async () => {
      const log = path.join(os.tmpdir(), `tut-born-ready-${process.pid}.log`);
      rmSync(log, { force: true });
      try {
        const { stdout } = await runLaunch(
          LAUNCH_SH,
          ["--new", "pi", "delivery smoke: please confirm"],
          {
            env: liveEnv({
              TUT_HERDR_LOG: log,
              // boot window: the first 2 reads are empty, then the UI paints
              TUT_HERDR_READ_EMPTY_POLLS: "2",
              TUT_HERDR_PANE_READ: "pi TUI ready — status 0.0%",
            }),
          },
        );
        expect(stdout).toBe(""); // real mode: herdr envelopes are consumed, not echoed

        const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
        // Provisioning (real, against the fixture) raised the pane and ran the agent.
        const runIdx = lines.findIndex((l) => l === "pane run FIX:p1 pi");
        expect(runIdx).toBeGreaterThanOrEqual(0);
        // The ready-probe polled at least 3 times (2 empty + stable pair after paint).
        const readLines = lines.filter((l) => l.startsWith("pane read FIX:p1"));
        expect(readLines.length).toBeGreaterThanOrEqual(3);
        const lastRead = lines.map((l) => l.startsWith("pane read")).lastIndexOf(true);
        // Delivery: literal text, then the Enter commit — and nothing after.
        expect(lines[lastRead + 1]).toBe("pane send-text FIX:p1 delivery smoke: please confirm");
        expect(lines[lastRead + 2]).toBe("pane send-keys FIX:p1 Enter");
        expect(lines).toHaveLength(lastRead + 3);
      } finally {
        rmSync(log, { force: true });
      }
    },
    15_000,
  );

  it("existing pane: no ready-probe — straight to send-text + Enter", async () => {
    const log = path.join(os.tmpdir(), `tut-live-delivery-${process.pid}.log`);
    rmSync(log, { force: true });
    try {
      const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "executor", "pi"], {
        env: liveEnv({
          TUT_HERDR_LOG: log,
          TUT_HERDR_PANES: JSON.stringify([{ pane_id: "w2:p1", label: "pi" }]),
        }),
      });
      expect(stdout).toBe("");
      const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
      expect(lines).toEqual([
        "pane list",
        `pane send-text w2:p1 轮到你了（role: executor）：请用 Context Hub 读取任务 t1 的完整上下文（context.read），按你的 role skill（${path.resolve(SCRIPTS_DIR, "../skills/executor.md")}）开始本轮工作，完成后发布相应记录（context.publish）。`,
        "pane send-keys w2:p1 Enter",
      ]);
    } finally {
      rmSync(log, { force: true });
    }
  });

  it("probe timeout degrades to delivering anyway, with the stderr note", async () => {
    const log = path.join(os.tmpdir(), `tut-ready-timeout-${process.pid}.log`);
    rmSync(log, { force: true });
    try {
      const { stderr } = await runLaunch(LAUNCH_SH, ["--new", "pi", "timeout-path"], {
        env: liveEnv({
          TUT_HERDR_LOG: log,
          TUT_HERDR_PANE_READ: "", // never paints → timeout
          TUT_READY_TIMEOUT_MS: "120",
        }),
      });
      expect(stderr).toContain("not observed ready within 120ms — delivering anyway");
      const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
      expect(lines.at(-2)).toBe("pane send-text FIX:p1 timeout-path");
      expect(lines.at(-1)).toBe("pane send-keys FIX:p1 Enter");
    } finally {
      rmSync(log, { force: true });
    }
  },
  15_000);
});

import { scopedFixture, agentFixture } from "./rig-fixtures.js";
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

  it("roles as an ARRAY is rejected explicitly — no silent drop, no success message", async () => {
    mkdirSync(path.dirname(wsFile()), { recursive: true });
    // An array IS typeof "object": this shape used to slip the guard, the
    // seat write landed on the array, and JSON.stringify dropped it —
    // exit 0 with a success line while nothing was written.
    const arrayRoles = '{ "roles": [] }\n';
    writeFileSync(wsFile(), arrayRoles);

    const code = await main(["assign", "executor", "pi"]);

    expect(code).toBe(1);
    expect(io.err()).toContain('malformed (expected an object with a "roles" object)');
    expect(io.out()).not.toContain("assign:"); // the success line never prints
    expect(readFileSync(wsFile(), "utf8")).toBe(arrayRoles); // byte-untouched
  });

  it("a top-level array and an array-valued seat are both rejected", async () => {
    mkdirSync(path.dirname(wsFile()), { recursive: true });
    const topLevel = "[]\n";
    writeFileSync(wsFile(), topLevel);
    let code = await main(["assign", "executor", "pi"]);
    expect(code).toBe(1);
    expect(io.err()).toContain("malformed");
    expect(readFileSync(wsFile(), "utf8")).toBe(topLevel);

    io.restore();
    const io2 = captureIo();
    try {
      const seatArray = '{ "roles": { "executor": ["pi"] } }\n';
      writeFileSync(wsFile(), seatArray);
      code = await main(["assign", "executor", "codex"]);
      expect(code).toBe(1);
      expect(io2.err()).toContain("roles.executor is not an object");
      expect(readFileSync(wsFile(), "utf8")).toBe(seatArray);
    } finally {
      io2.restore();
    }
  });
});

// --- launch.sh resolution ------------------------------------------------------
// The REAL script with TUT_DRY_RUN=1: it prints the herdr command instead of
// running it. An explicitly empty fixture inventory pins the placeholder
// anchor regardless of whether the developer has a live Herdr rig.

const LAUNCH_SH = path.join(SCRIPTS_DIR, "launch.sh");
const runLaunch = promisify(execFile);
// Dry-run env with a hermetic chain: no TUT_PROJECT_ROOT (L1 skipped — the
// anchor is a dry-run placeholder), empty L2 — naming/roles fall to defaults.
const CHAIN_L2 = mkdtempSync(path.join(os.tmpdir(), "tut-assign-chain-"));
const dryRunEnv = {
  ...process.env,
  TUT_DRY_RUN: "1",
  TUT_HERDR_EXECUTABLE: path.resolve(import.meta.dirname, "bin/herdr"),
  TUT_HERDR_PANES: "[]",
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
    // With no anchor, labels use the placeholder Hub root, never the
    // caller cwd or TUT_PROJECT_ROOT (which only selects routing config).
    expect(stdout).toContain("--workspace <workspace> --cwd <cwd>");
    expect(stdout).toContain("--label TUT executor --no-focus");
    expect(stdout).toContain(scopedFixture("DRY-RUN: birth: herdr pane rename <root> t1.executor", "<hub-root>")); // pane label fixed (4.4)
    expect(stdout).toContain(scopedFixture("(agent 'pi', label 't1.executor')", "<hub-root>"));
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

  it("custom naming.tab_label fixture: tab label renders the template, pane label keeps its task/role key and Hub-root suffix", async () => {
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
      expect(stdout).toContain(scopedFixture("DRY-RUN: birth: herdr pane rename <root> t1.executor", "<hub-root>")); // pane label fixed, byte-exact
      expect(stdout).toContain(scopedFixture("(agent 'pi', label 't1.executor')", "<hub-root>"));
    } finally {
      rmSync(tplL1, { recursive: true, force: true });
    }
  });
});

describe("launch.sh round entry (prompt delivery regression guard)", () => {
  it("delivers the round prompt with a placeholder Hub-root label when no anchor exists", async () => {
    const { stdout } = await runLaunch(LAUNCH_SH, ["t1", "architect", "pi"], { env: dryRunEnv });

    expect(stdout).toContain("DRY-RUN");
    expect(stdout).toContain(scopedFixture("(agent 'pi', label 't1.architect')", "<hub-root>"));
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
    expect(stdout).toContain(scopedFixture("DRY-RUN: birth: herdr pane rename <root> t1.executor", "/repo"));
    expect(stdout).toContain(agentFixture("DRY-RUN: birth: herdr pane run <root> cd -- '/repo' && env 'PI_SKIP_VERSION_CHECK=1' 'pi'", "/repo", "http://127.0.0.1:1"));
    expect(stdout).toContain(scopedFixture("DRY-RUN: status-before <label:t1.executor> via herdr pane list", "/repo"));
    expect(stdout).toContain(scopedFixture("(agent 'pi', label 't1.executor')", "/repo"));
  });

  it("cleanup preview: non-continuity idle panes close; a live continuity seat is KEPT; working ones are skipped with a warning", async () => {
    const { stdout, stderr } = await runLaunch(LAUNCH_SH, ["t1", "reviewer", "pi"], {
      env: fixtureEnv([
        HUB_PANE,
        { pane_id: "w11:p5", label: scopedFixture("t1.architect", "/repo"), workspace_id: "w11", cwd: "/repo", agent_status: "idle" },
        { pane_id: "w11:p6", label: scopedFixture("t1.executor", "/repo"), workspace_id: "w11", cwd: "/repo", agent_status: "working" },
      ]),
    });

    expect(stdout).toContain(scopedFixture("DRY-RUN: cleanup: herdr pane close w11:p5 (label 't1.architect')", "/repo")); // idle, non-continuity → closed (the original shape)
    expect(stdout).not.toContain("w11:p6"); // working → NOT closed (warning on stderr instead)
    expect(stderr).toContain(scopedFixture("pane 't1.executor' (w11:p6) still working — left open for the next lifecycle hook", "/repo"));
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

// --- single delivery attempt with bounded status observation ------------

describe('launch.sh delivery confirmation v2 delivery integration', () => {
  const fixtureBin = path.resolve(import.meta.dirname, 'bin');
  it.each(['architect', 'executor'])('birth %s sends once, observes working, never confirms', async role => {
    const log = path.join(os.tmpdir(), `tut-launch-${role}-${process.pid}.log`);
    rmSync(log, { force: true });
    try {
      const { stderr } = await runLaunch(LAUNCH_SH, ['t1', role, 'pi'], { env: {
        ...process.env, PATH: `${fixtureBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        TUT_HUB_URL: 'http://127.0.0.1:1', TUT_USER_CONFIG_DIR: CHAIN_L2,
        TUT_HERDR_PANES: JSON.stringify([{ pane_id: 'w9:p0', label: 'hub', workspace_id: 'w9', cwd: '/x', agent_status: 'idle' }]),
        TUT_SPLIT_BASE: 'w9:p0', TUT_HERDR_LOG: log,
        TUT_STATUS_FLIP_TIMEOUT_MS: '2000', TUT_STATUS_POLL_MS: '10',
      } });
      const lines = readFileSync(log, 'utf8').trim().split('\n');
      const text = lines.findIndex(l => l.startsWith('pane send-text FIX:root1 '));
      expect(text).toBeGreaterThan(0);
      expect(lines[text]).not.toContain('tut delivery');
      expect(lines[text - 1]).toBe('pane list');
      expect(lines.slice(text + 1)).toEqual(['pane send-keys FIX:root1 Enter', 'pane list']);
      expect(lines.filter(l => l.startsWith('pane send-text '))).toHaveLength(1);
      expect(lines.some(l => l.startsWith('pane read '))).toBe(false);
      expect(lines.some(l => l.includes('probe-runner'))).toBe(false);
      expect(stderr).toContain('working-observed');
      expect(stderr).toContain('attribution-unavailable');
      expect(stderr).toContain('launch attempt completed; delivery confirmation is not implied');
      expect(stderr).not.toContain('submit-confirmed');
      expect(stderr).not.toContain('--force');
      const evidence = JSON.parse(stderr.split('\n').find(l => l.includes('delivery_v2='))!.split('delivery_v2=')[1]!);
      expect(evidence).toMatchObject({ schema: 2, text_calls: 1, enter_calls: 1, status_flip: true, submit_confirmed: false });
    } finally { rmSync(log, { force: true }); }
  });
});

it('delivery confirmation v2 producer sends the exact frozen evidence to stderr, event and delivery.log', async () => {
  const { createServer } = await import('node:http');
  const received: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200).end('ok'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const root = mkdtempSync(path.join(os.tmpdir(), 'tut-launch-event-'));
  const log = path.join(root, 'herdr.log');
  try {
    const { stderr } = await runLaunch(LAUNCH_SH, ['t1', 'architect', 'pi'], { env: {
      ...process.env, PATH: `${path.resolve(import.meta.dirname, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TUT_HUB_URL: 'http://127.0.0.1:1', TUT_EVENT_PORT_URL: `http://127.0.0.1:${port}/agent-event`,
      TUT_USER_CONFIG_DIR: CHAIN_L2, TUT_PROJECT_ROOT: root,
      TUT_HERDR_PANES: JSON.stringify([{ pane_id: 'w9:p0', label: 'hub', workspace_id: 'w9', cwd: '/x', agent_status: 'idle' }]),
      TUT_SPLIT_BASE: 'w9:p0', TUT_HERDR_LOG: log,
      TUT_STATUS_FLIP_TIMEOUT_MS: '2000', TUT_STATUS_POLL_MS: '10',
    } });
    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(Object.keys(event).sort()).toEqual(['agent', 'delivery_v2', 'event', 'pane']);
    expect(event).toMatchObject({ event: 'delivery_giveup', agent: 'pi', pane: scopedFixture('t1.architect', '/x') });
    const serialized = JSON.stringify(event.delivery_v2);
    expect(stderr).toContain(`delivery_v2=${serialized}`);
    expect(readFileSync(path.join(root, '.context-hub/delivery.log'), 'utf8')).toContain(`delivery_v2=${serialized}`);
    expect(serialized).not.toContain('轮到你了');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

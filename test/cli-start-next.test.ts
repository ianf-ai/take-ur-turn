import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// start-next (no-arg default + first-round doorbell after tut create) — parse
// layer first; handler behavior below.
//
// start-next handler: global fetch is stubbed with a synthetic /state because a REAL
// hub can never show needs_attention together with waiting_for "agent:*" —
// derivation forces waiting_for "human" whenever warnings exist
// (state-machine WAITING_FOR override), and the `!!` marks are exactly about
// that combination. The launch-log seam (readLaunchLog/markLaunched) goes
// through hub-client, mocked the same way as test/cli.test.ts; the launcher
// itself is the REAL scripts/launch.sh run under TUT_DRY_RUN=1.
vi.mock("../src/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub-client.js")>()),
  hubCreate: vi.fn(),
  hubPublish: vi.fn(),
  hubRead: vi.fn(),
  hubList: vi.fn(),
  hubDecide: vi.fn(),
}));

import { main, parseArgs } from "../src/cli.js";
import { hubDecide, hubPublish, hubRead } from "../src/hub-client.js";

// --- parse -----------------------------------------------------------------------

describe("start-next optional task_id (parse)", () => {
  it("start-next with no positional parses with undefined task_id", () => {
    const parsed = parseArgs(["start-next"]);
    expect(parsed).toEqual({ command: "start-next", url: "http://127.0.0.1:3001", force: false, fresh: false });
  });

  it("start-next keeps explicit task_id and flags", () => {
    expect(parseArgs(["start-next", "t1", "--url", "http://x:1", "--force"])).toEqual({
      command: "start-next",
      task_id: "t1",
      url: "http://x:1",
      force: true,
      fresh: false,
    });
  });

  it("--fresh parses and is orthogonal to --force (pane policy vs dedup bypass)", () => {
    expect(parseArgs(["start-next", "t1", "--fresh"])).toEqual({
      command: "start-next",
      task_id: "t1",
      url: "http://127.0.0.1:3001",
      force: false,
      fresh: true,
    });
    expect(parseArgs(["start-next", "t1", "--force", "--fresh"])).toEqual({
      command: "start-next",
      task_id: "t1",
      url: "http://127.0.0.1:3001",
      force: true,
      fresh: true,
    });
  });

  it("extra positionals rejected", () => {
    expect(parseArgs(["start-next", "t1", "t2"]).command).toBe("usage");
  });
});

describe("tut new retired (parse)", () => {
  it("`new` is an unknown command — usage error with a machine-parseable message", () => {
    expect(parseArgs(["new", "做一个防重复启动的机制"])).toEqual({
      command: "usage",
      error: "unknown command: new",
    });
  });
});

// --- handler helpers -------------------------------------------------------------

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
  return { out: () => outText, err: () => errText, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

/** /state task fixture — only the fields start-next consumes. */
interface StateTask {
  task_id: string;
  status: string;
  waiting_for: string;
  needs_attention?: boolean;
  /** Per-task cast overrides (absent on older hubs/fixtures). */
  cast?: Record<string, string>;
}

/** Stub global fetch to serve this /state body for every call. */
function stubState(tasks: StateTask[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flow_mode: "manual", tasks }) })),
  );
}

/** Run fn with TUT_DRY_RUN=1, restoring the previous value after. */
async function withDryRun<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TUT_DRY_RUN;
  process.env.TUT_DRY_RUN = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TUT_DRY_RUN;
    else process.env.TUT_DRY_RUN = prev;
  }
}

/**
 * Run fn with the fixture herdr first on PATH serving an EMPTY pane list —
 * hermetic launcher tests: no real pane list enters the cleanup scan or the
 * anchor resolution (deterministic placeholder anchor in the dry-run
 * preview), and the fixture `pi` stub keeps the PATH pre-check hermetic.
 */
async function withFixtureHerdr<T>(fn: () => Promise<T>): Promise<T> {
  const FIXTURE_BIN = path.resolve(import.meta.dirname, "bin"); // test/bin — this file's own dir
  const prevPath = process.env.PATH;
  const prevPanes = process.env.TUT_HERDR_PANES;
  const prevHub = process.env.TUT_HUB_URL;
  process.env.PATH = `${FIXTURE_BIN}:${prevPath}`;
  process.env.TUT_HERDR_PANES = "[]";
  process.env.TUT_HUB_URL = "http://127.0.0.1:1";
  try {
    return await fn();
  } finally {
    process.env.PATH = prevPath;
    if (prevPanes === undefined) delete process.env.TUT_HERDR_PANES;
    else process.env.TUT_HERDR_PANES = prevPanes;
    if (prevHub === undefined) delete process.env.TUT_HUB_URL;
    else process.env.TUT_HUB_URL = prevHub;
  }
}

// --- start-next handler ---------------------------------------------------------

describe("start-next no-arg default (handler, /state stubbed)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    vi.unstubAllGlobals();
    vi.mocked(hubRead).mockReset();
    vi.mocked(hubPublish).mockReset();
  });

  it("unique agent-waiting task is selected and runs the exact explicit path (marker + launch note)", async () => {
    stubState([
      { task_id: "t-human", status: "pending_approval", waiting_for: "human" },
      { task_id: "t-unique", status: "implementing", waiting_for: "agent:executor" },
    ]);
    vi.mocked(hubRead).mockResolvedValue({
      task_id: "t-unique",
      title: "Unique",
      status: "implementing",
      versions: [],
    });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t-unique", version: 1, status: "implementing", needs_attention: false });

    // Hermetic chain for the pre-check's agent resolution: clean L1 (temp
    // cwd) + pinned empty L2 → DEFAULT_ROLES.executor = pi, independent of
    // the repo's live config and the machine's user-level one.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-snext-chain-"));
    const prevCwd = process.cwd();
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.chdir(tmp);
    process.env.TUT_USER_CONFIG_DIR = path.join(tmp, "user-config");
    let code: number;
    try {
      code = await withDryRun(() => main(["start-next", "--url", "http://hub.test"]));
    } finally {
      process.chdir(prevCwd);
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("DRY-RUN"); // real launch.sh honored the passthrough env
    expect(out).toContain("(agent 'pi', label 't-unique.executor')"); // fresh round pane (4.4)
    expect(out).toContain("t-unique");
    expect(out).toContain("launched executor for t-unique via launch.sh");
    expect(out).not.toContain("[!!]"); // clean task: no attention marker
    // The auto-selected id flows into the launch-note guard path verbatim.
    expect(vi.mocked(hubPublish)).toHaveBeenCalledWith("http://hub.test", {
      task_id: "t-unique",
      role: "human",
      content_type: "note",
      payload: expect.objectContaining({ launch: { role: "executor", base_version: 0, via: "start-next" } }),
      expected_version: 0,
    });
  });

  it("marks the launched line [!!] when the selected task needs attention", async () => {
    stubState([{ task_id: "t-att", status: "implementing", waiting_for: "agent:executor", needs_attention: true }]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "t-att", title: "Att", status: "implementing", versions: [] });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t-att", version: 1, status: "implementing", needs_attention: true });

    const code = await withDryRun(() => main(["start-next"]));

    expect(code).toBe(0);
    expect(io.out()).toContain("launched executor for t-att via launch.sh [!!]");
  });

  it("no-arg selection still honors the duplicate-launch guard (no spawn, no marker append)", async () => {
    stubState([{ task_id: "t-dup", status: "implementing", waiting_for: "agent:executor" }]);
    vi.mocked(hubRead).mockResolvedValue({
      task_id: "t-dup",
      title: "Dup",
      status: "implementing",
      versions: [
        {
          version: 1,
          task_id: "t-dup",
          role: "architect",
          content_type: "design",
          timestamp: "2026-08-17T00:00:00.000Z",
          payload: { summary: "design", body: "design" },
        },
        {
          version: 2,
          task_id: "t-dup",
          role: "human",
          content_type: "note",
          timestamp: "2026-08-17T00:01:00.000Z",
          payload: {
            summary: "launch: executor (base v1)",
            body: "launch",
            launch: { role: "executor", base_version: 1, via: "start-next" },
          },
        },
      ],
    });

    const code = await main(["start-next", "--url", "http://hub.test"]);

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toContain("tut: ALREADY_LAUNCHED: executor launched at v2");
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled();
    expect(io.out()).not.toContain("DRY-RUN");
  });

  it("zero candidates exits 1 listing the human-waiting tasks", async () => {
    stubState([
      { task_id: "t-approval", status: "pending_approval", waiting_for: "human" },
      { task_id: "t-closed", status: "closed", waiting_for: "none" },
    ]);

    const code = await main(["start-next", "--url", "http://hub.test"]);

    expect(code).toBe(1);
    const err = io.err();
    expect(err.split("\n")[0]).toBe("tut: no task is waiting for an agent");
    expect(err).toContain("t-approval"); // brief human-waiting list...
    expect(err).toContain("human");
    expect(err).not.toContain("t-closed"); // ...human-waiting only
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled();
    expect(io.out()).not.toContain("DRY-RUN");
  });

  it("multiple candidates exits 1 listing them with the !! attention column", async () => {
    stubState([
      { task_id: "t-two", status: "reviewing", waiting_for: "agent:reviewer" },
      { task_id: "t-one", status: "implementing", waiting_for: "agent:executor", needs_attention: true },
      { task_id: "t-human", status: "pending_approval", waiting_for: "human" },
    ]);

    const code = await main(["start-next", "--url", "http://hub.test"]);

    expect(code).toBe(1);
    const err = io.err();
    expect(err).toContain("pass a task_id explicitly"); // hint, never guess
    expect(err).toContain("task_id");
    expect(err).toContain("waiting_for");
    expect(err).toContain("att");
    expect(err).toContain("t-one");
    expect(err).toContain("t-two");
    expect(err).toContain("agent:executor  !!"); // att column marks the anomalous candidate
    expect(err.split("\n").some((line) => line.includes("t-two") && !line.includes("!!"))).toBe(true);
    expect(err).not.toContain("t-human"); // human-waiting tasks are not candidates
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled();
    expect(io.out()).not.toContain("DRY-RUN");
  });
});

// --- first round after tut create (doorbell delivery via start-next) -------------
// The task is created on the initiating side, then the
// first round is an ORDINARY round — start-next routes by waiting_for, the
// pane is `<task_id>.<role>` from round one, and the prompt is the round
// doorbell (task_id + skill path only; the requirement lives in the Hub).

describe("first round after tut create (doorbell, real launch.sh under TUT_DRY_RUN)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    vi.unstubAllGlobals();
    vi.mocked(hubRead).mockReset();
    vi.mocked(hubPublish).mockReset();
  });

  it("designing/waiting architect task → launch.sh <task_id> architect; doorbell prompt carries no requirement body", async () => {
    // A full-flow task freshly created by the initiating side (status
    // designing, waiting on the architect, cast all-pi). The title and
    // description live ONLY in the Hub — they must not leak into the
    // delivery (the doorbell criterion).
    stubState([
      { task_id: "kick-one", status: "designing", waiting_for: "agent:architect", cast: { architect: "pi" } },
    ]);
    vi.mocked(hubRead).mockResolvedValue({
      task_id: "kick-one",
      title: "Doorbell First Round",
      status: "designing",
      versions: [],
    });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "kick-one", version: 1, status: "designing", needs_attention: false });

    // Hermetic chain: a temp L1 carrying a task-bearing tab template (the
    // real task_id must render — never a literal "new") + an empty pinned
    // L2; the fixture herdr (pi stub on PATH, empty pane list) keeps the
    // dry-run preview deterministic. TUT_PROJECT_ROOT pins launch.sh's L1.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-first-round-"));
    mkdirSync(path.join(tmp, ".context-hub"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".context-hub", "workspace.json"),
      `${JSON.stringify({ naming: { tab_label: "TUT {task} {role}" }, roles: { architect: { agent: "pi" } } })}\n`,
      "utf8",
    );
    const prevCwd = process.cwd();
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    const prevProjectRoot = process.env.TUT_PROJECT_ROOT;
    process.chdir(tmp);
    process.env.TUT_USER_CONFIG_DIR = path.join(tmp, "user-config");
    process.env.TUT_PROJECT_ROOT = tmp;
    let code: number;
    try {
      code = await withFixtureHerdr(() => withDryRun(() => main(["start-next", "--url", "http://hub.test"])));
    } finally {
      process.chdir(prevCwd);
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
      if (prevProjectRoot === undefined) delete process.env.TUT_PROJECT_ROOT;
      else process.env.TUT_PROJECT_ROOT = prevProjectRoot;
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("DRY-RUN"); // real launch.sh honored the passthrough env
    // Round hand-off form from round one: launch.sh receives <task_id> architect
    expect(out).toContain("(agent 'pi', label 'kick-one.architect')"); // pane label = <task_id>.<role> (4.4)
    // The tab label renders the REAL task_id (no kickoff "new" literal anywhere).
    expect(out).toContain("--label TUT kick-one architect --no-focus");
    expect(out).not.toContain("TUT new");
    // The prompt is the ordinary round doorbell: task_id + role + the
    // INSTALLED architect skill (absolute path, reachable from any cwd).
    expect(out).toContain("轮到你了（role: architect）");
    expect(out).toContain("kick-one");
    const skillAbs = path.resolve(import.meta.dirname, "../skills/architect.md");
    expect(out).toContain(skillAbs);
    expect(existsSync(skillAbs)).toBe(true);
    expect(readFileSync(skillAbs, "utf8").length).toBeGreaterThan(0);
    // Doorbell criterion: no title/description substance in the delivery.
    expect(out).not.toContain("Doorbell First Round");
    expect(out).not.toContain("防重复启动");
    // The launch marker was appended for the architect round (dedup anchor).
    expect(vi.mocked(hubPublish)).toHaveBeenCalledWith("http://hub.test", {
      task_id: "kick-one",
      role: "human",
      content_type: "note",
      payload: expect.objectContaining({ launch: { role: "architect", base_version: 0, via: "start-next" } }),
      expected_version: 0,
    });
  });

  it("launcher failure forwards child stderr, exits 1, and points at --force (the marker was already appended)", async () => {
    stubState([
      { task_id: "kick-fail", status: "designing", waiting_for: "agent:architect", cast: { architect: "pi" } },
    ]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "kick-fail", title: "F", status: "designing", versions: [] });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "kick-fail", version: 1, status: "designing", needs_attention: false });

    // Live launcher against the fixture herdr whose pane list fails — the
    // anchor cannot resolve and the launcher fails loudly AFTER the marker.
    const code = await withFixtureHerdr(() => {
      const prev = process.env.TUT_DRY_RUN;
      delete process.env.TUT_DRY_RUN;
      process.env.TUT_HERDR_FAIL = "pane:list";
      return main(["start-next", "kick-fail", "--url", "http://hub.test"]).finally(() => {
        delete process.env.TUT_HERDR_FAIL;
        if (prev !== undefined) process.env.TUT_DRY_RUN = prev;
      });
    });

    expect(code).toBe(1);
    const err = io.err();
    expect(err).toContain("no anchor pane found"); // launch.sh's stderr forwarded
    expect(err).toContain("tut: launcher exited with code 1");
    expect(err).toContain("relaunch with --force");
    // The marker went in BEFORE the launcher — exactly one publish happened.
    expect(vi.mocked(hubPublish)).toHaveBeenCalledTimes(1);
  });
});

// --- start-next --fresh (pane-policy flag pass-through) ---

describe("start-next --fresh: parsed and passed to the launcher (orthogonal to --force)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    vi.unstubAllGlobals();
    vi.mocked(hubRead).mockReset();
    vi.mocked(hubPublish).mockReset();
  });

  it("--fresh reaches launch.sh as a leading flag: the live same-role seat is force-closed and reborn (no continuation)", async () => {
    stubState([
      { task_id: "t-fresh", status: "revising", waiting_for: "agent:executor", cast: { executor: "pi" } },
    ]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "t-fresh", title: "F", status: "revising", versions: [] });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t-fresh", version: 1, status: "revising", needs_attention: false });

    // LIVE launcher against the fixture herdr: a live idle same-role seat
    // plus an anchor. WITHOUT the flag the launcher would continue into the
    // seat (deliver-only, "same-role continuation" note); WITH the flag it
    // must force-close and rebirth — the stderr notes are the discriminator.
    const code = await withFixtureHerdr(() => {
      const prev = process.env.TUT_DRY_RUN;
      delete process.env.TUT_DRY_RUN;
      process.env.TUT_HERDR_PANES = JSON.stringify([
        { pane_id: "w1:p0", label: "tut-hub", workspace_id: "w1", cwd: "/repo", agent_status: "idle" },
        { pane_id: "w1:p1", label: "t-fresh.executor", workspace_id: "w1", cwd: "/repo", agent_status: "idle" },
      ]);
      // The fixture herdr's closes-are-effective semantics live in the LOG
      // (its per-invocation shared state) — without it a closed pane
      // resurrects in later lists and trips the launcher's guard.
      const herdrLog = path.join(os.tmpdir(), `tut-snext-fresh-${process.pid}-${Date.now()}.log`);
      rmSync(herdrLog, { force: true });
      process.env.TUT_HERDR_LOG = herdrLog;
      // Closed-loop birth-delivery timeline: boot → paint (gate
      // releases) → prompt text lands → submit reaction; fast knobs.
      process.env.TUT_HERDR_READ_SCRIPT = JSON.stringify([
        "",
        "",
        "pi ready",
        "pi ready",
        "pi ready ▎prompt",
        "working",
      ]);
      process.env.TUT_READY_POLL_MS = "20";
      process.env.TUT_READY_FLOOR_MS = "0";
      process.env.TUT_READY_TIMEOUT_MS = "300";
      process.env.TUT_TEXT_LAND_TIMEOUT_MS = "200";
      process.env.TUT_SUBMIT_TIMEOUT_MS = "100";
      process.env.TUT_SUBMIT_RETRIES = "2";
      return main(["start-next", "t-fresh", "--fresh", "--url", "http://hub.test"]).finally(() => {
        rmSync(herdrLog, { force: true });
        delete process.env.TUT_HERDR_LOG;
        delete process.env.TUT_HERDR_READ_SCRIPT;
        delete process.env.TUT_READY_POLL_MS;
        delete process.env.TUT_READY_FLOOR_MS;
        delete process.env.TUT_READY_TIMEOUT_MS;
        delete process.env.TUT_TEXT_LAND_TIMEOUT_MS;
        delete process.env.TUT_SUBMIT_TIMEOUT_MS;
        delete process.env.TUT_SUBMIT_RETRIES;
        if (prev !== undefined) process.env.TUT_DRY_RUN = prev;
      });
    });

    expect(code).toBe(0);
    expect(io.err()).toContain("--fresh — force-closing panes labeled 't-fresh.executor'");
    expect(io.err()).not.toContain("same-role continuation"); // the flag bypassed the seat
    expect(io.out()).toContain("start-next: launched executor for t-fresh via launch.sh");
    // Pane policy ≠ dedup policy: the launch marker was appended as usual.
    expect(vi.mocked(hubPublish)).toHaveBeenCalledWith("http://hub.test", {
      task_id: "t-fresh",
      role: "human",
      content_type: "note",
      payload: expect.objectContaining({ launch: { role: "executor", base_version: 0, via: "start-next" } }),
      expected_version: 0,
    });
  });
});

// --- decide close → pane cleanup hook (fresh-session lifecycle, 4.4) -----------------

describe("tut decide (close spawns launch.sh --cleanup; approve does not)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    vi.mocked(hubDecide).mockReset();
  });

  it("decide close → launcher --cleanup runs (dry-run passthrough) and the decide still exits 0", async () => {
    vi.mocked(hubDecide).mockResolvedValue({ task_id: "t-gone", status: "closed" });

    const code = await withFixtureHerdr(() =>
      withDryRun(async () => {
        process.env.TUT_HERDR_PANES = JSON.stringify([
          { pane_id: "w1:p1", label: "t-gone.executor", workspace_id: "w1", cwd: "/repo", agent_status: "working" },
        ]);
        return main(["decide", "t-gone", "--decision", "close", "--by", "host", "--url", "http://hub.test"]);
      }),
    );

    expect(code).toBe(0);
    expect(io.out()).toContain('"status":"closed"'); // the decision result is printed
    // The cleanup hook ran the REAL launcher in dry-run: the task's round
    // pane is reaped UNCONDITIONALLY (working included — the task is closed).
    expect(io.out()).toContain("DRY-RUN: cleanup: herdr pane close w1:p1 (label 't-gone.executor')");
  });

  it("decide approve → no cleanup spawn (the task may still be consulted)", async () => {
    vi.mocked(hubDecide).mockResolvedValue({ task_id: "t-ok", status: "approved" });

    const code = await withFixtureHerdr(() =>
      withDryRun(() => main(["decide", "t-ok", "--decision", "approve", "--by", "host", "--url", "http://hub.test"])),
    );

    expect(code).toBe(0);
    expect(io.out()).not.toContain("DRY-RUN");
    expect(io.out()).not.toContain("cleanup");
  });

  it("cleanup failure never fails the decide (best-effort: warning only)", async () => {
    vi.mocked(hubDecide).mockResolvedValue({ task_id: "t-gone2", status: "closed" });

    const code = await withFixtureHerdr(() => {
      const prev = process.env.TUT_DRY_RUN;
      delete process.env.TUT_DRY_RUN; // live launcher against the fixture…
      process.env.TUT_HERDR_FAIL = "pane:list"; // …whose pane list fails → herdr layer errors
      return main(["decide", "t-gone2", "--decision", "close", "--by", "host", "--url", "http://hub.test"]).finally(() => {
        delete process.env.TUT_HERDR_FAIL;
        if (prev !== undefined) process.env.TUT_DRY_RUN = prev;
      });
    });

    expect(code).toBe(0); // the decision succeeded regardless
    // The hook ran (reaping note); the failing pane list (stderr swallowed by
    // the launcher's tolerant pane_list_json) yielded no closable panes and
    // no error surfaced — --cleanup is best-effort end to end.
    expect(io.err()).toContain("reaping panes of task 't-gone2'");
    expect(io.err()).not.toContain("pane cleanup exited with code");
    expect(io.out()).toContain('"status":"closed"');
  });
});

// --- start-next pre-checks (before the marker — failure leaves no trace) ----------

describe("start-next pre-check (resolve + PATH, BEFORE the launch marker)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    vi.unstubAllGlobals();
    vi.mocked(hubRead).mockReset();
    vi.mocked(hubPublish).mockReset();
  });

  it("routed agent not on PATH → exit 1, NO launch note appended, no spawn", async () => {
    // The stubbed /state carries a cast routing executor to a command that
    // cannot exist on PATH — the pre-check must fail before markLaunched.
    stubState([{ task_id: "t-pre", status: "implementing", waiting_for: "agent:executor", cast: { executor: "no-such-cli-x" } }]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "t-pre", title: "Pre", status: "implementing", versions: [] });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t-pre", version: 1, status: "implementing", needs_attention: false });

    const code = await withDryRun(() => main(["start-next", "t-pre", "--url", "http://hub.test"]));

    expect(code).toBe(1);
    expect(io.err()).toContain("agent 'no-such-cli-x' (routed for executor on t-pre) is not on PATH");
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled(); // 无痕: no launch marker
    expect(io.out()).not.toContain("DRY-RUN");
  });
});

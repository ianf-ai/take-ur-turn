import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// start-next (no-arg default) + tut new — parse layer first; handler
// behavior below.
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
import { hubPublish, hubRead } from "../src/hub-client.js";

// --- parse -----------------------------------------------------------------------

describe("start-next optional task_id (parse)", () => {
  it("start-next with no positional parses with undefined task_id", () => {
    const parsed = parseArgs(["start-next"]);
    expect(parsed).toEqual({ command: "start-next", url: "http://127.0.0.1:3001", force: false });
  });

  it("start-next keeps explicit task_id and flags", () => {
    expect(parseArgs(["start-next", "t1", "--url", "http://x:1", "--force"])).toEqual({
      command: "start-next",
      task_id: "t1",
      url: "http://x:1",
      force: true,
    });
  });

  it("extra positionals rejected", () => {
    expect(parseArgs(["start-next", "t1", "t2"]).command).toBe("usage");
  });
});

describe("tut new (parse)", () => {
  it("parses a quoted requirement as the single positional", () => {
    expect(parseArgs(["new", "需要一个防重复启动的机制"])).toEqual({
      command: "new",
      requirement: "需要一个防重复启动的机制",
    });
  });

  it("--pane optional, equals form accepted", () => {
    expect(parseArgs(["new", "需求一句话", "--pane=arch2"])).toEqual({
      command: "new",
      requirement: "需求一句话",
      pane: "arch2",
    });
  });

  it("missing requirement or extra positional → usage", () => {
    expect(parseArgs(["new"]).command).toBe("usage");
    expect(parseArgs(["new", "a", "b"]).command).toBe("usage");
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

    const code = await withDryRun(() => main(["start-next", "--url", "http://hub.test"]));

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("DRY-RUN"); // real launch.sh honored the passthrough env
    expect(out).toContain("(agent 'pi')"); // executor routes to its agent pane
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

// --- tut new handler ----------------------------------------------------------------

describe("tut new (handler, real launch.sh under TUT_DRY_RUN)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
  });

  it("delivers the kickoff prompt to the default architect agent pane (label = agent name)", async () => {
    // Deterministic default lineup: hide workspace.json + routes.json so the
    // architect agent resolves through DEFAULT_ROLES (codex) regardless of
    // the repo's live workspace state.
    const WS = path.resolve(import.meta.dirname, "../scripts/workspace.json");
    const RT = path.resolve(import.meta.dirname, "../scripts/routes.json");
    const { renameSync: rn, existsSync: ex } = await import("node:fs");
    const moved: Array<[string, string]> = [];
    for (const f of [WS, RT]) if (ex(f)) { rn(f, `${f}.a7hide`); moved.push([`${f}.a7hide`, f]); }
    let code: number;
    try {
      code = await withDryRun(() => main(["new", "做一个防重复启动的机制"]));
    } finally {
      for (const [from, to] of moved) rn(from, to);
    }

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("DRY-RUN"); // real launch.sh --new honored the passthrough env
    expect(out).toContain("(label 'codex')"); // default architect agent → pane label = agent name
    expect(out).toContain("新任务：做一个防重复启动的机制。"); // prompt template carries the requirement
    expect(out).toContain("skills/architect.md");
    expect(out).toContain("start-new: delivered to pane 'codex'");
  });

  it("kickoff prompt embeds the ABSOLUTE installed architect skill path (run from a non-TUT cwd)", async () => {
    // The receiving Agent's cwd is the target project, not the TUT repo — the
    // old cwd-relative "skills/architect.md" was unreachable there. Run the
    // real handler with cwd = a temp dir outside the repo (the cli-up
    // process.chdir idiom) and prove the prompt names the installed file.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-newtask-cwd-"));
    const prevCwd = process.cwd();
    process.chdir(tmp);
    const io = captureIo();
    try {
      const code = await withDryRun(() => main(["new", "TUT 仓库外项目的需求"]));

      expect(code).toBe(0);
      const out = io.out();
      const skillAbs = path.resolve(import.meta.dirname, "../skills/architect.md");
      expect(path.isAbsolute(skillAbs)).toBe(true);
      expect(out).toContain(skillAbs); // exactly the installed copy, not a cwd accident
      expect(out).not.toContain(path.join(tmp, "skills")); // cwd-drift regression guard
      expect(existsSync(skillAbs)).toBe(true); // reachable and readable from any cwd
      expect(readFileSync(skillAbs, "utf8").length).toBeGreaterThan(0);
    } finally {
      io.restore();
      process.chdir(prevCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--pane overrides the resolved label", async () => {
    const code = await withDryRun(() => main(["new", "需求一句话", "--pane", "arch2"]));

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("(label 'arch2')");
    expect(out).toContain("需求一句话");
    expect(out).toContain("start-new: delivered to pane 'arch2'");
  });

  it("launcher failure (no such pane, no dry-run) forwards child stderr and exits 1", async () => {
    const prev = process.env.TUT_DRY_RUN;
    delete process.env.TUT_DRY_RUN;
    let code: number;
    try {
      code = await main(["new", "需求", "--pane", "no-such-pane-tut-test"]);
    } finally {
      if (prev !== undefined) process.env.TUT_DRY_RUN = prev;
    }

    expect(code).toBe(1);
    const err = io.err();
    expect(err).toContain("no pane labeled 'no-such-pane-tut-test'"); // launch.sh's stderr forwarded
    expect(err).toContain("tut: launcher exited with code 1");
    expect(io.out()).not.toContain("delivered");
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
    stubState([{ task_id: "t-pre", status: "implementing", waiting_for: "agent:executor", cast: { executor: "no-such-cli-a7" } }]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "t-pre", title: "Pre", status: "implementing", versions: [] });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t-pre", version: 1, status: "implementing", needs_attention: false });

    const code = await withDryRun(() => main(["start-next", "t-pre", "--url", "http://hub.test"]));

    expect(code).toBe(1);
    expect(io.err()).toContain("agent 'no-such-cli-a7' (routed for executor on t-pre) is not on PATH");
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled(); // 无痕: no launch marker
    expect(io.out()).not.toContain("DRY-RUN");
  });
});

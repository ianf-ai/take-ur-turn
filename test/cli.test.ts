import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The context-subcommand handler tests mock ONLY the hub-client layer: their
// frozen parse shapes carry no --url, so the handlers always target the
// default hub URL — not reachable in tests. The real client against a real
// hub is covered in test/hub-client.test.ts; mode/start-next take --url and
// are tested against a real server below.
vi.mock("../src/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub-client.js")>()),
  hubCreate: vi.fn(),
  hubPublish: vi.fn(),
  hubRead: vi.fn(),
  hubList: vi.fn(),
  hubDecide: vi.fn(),
}));

import { USAGE, main, parseArgs, notifyHealthy } from "../src/cli.js";
import { hubCreate, hubDecide, hubList, hubPublish, hubRead, HubError } from "../src/hub-client.js";
import { Notifier } from "../src/notifier.js";
import { startServer, type RunningServer } from "../src/server.js";
import { Store } from "../src/store.js";
import http from "node:http";

/**
 * Hermetic workspace chain for agent-resolving handler tests: chdir into
 * an empty temp project root (no L1 file) and pin TUT_USER_CONFIG_DIR to
 * an empty temp dir (no L2 file) — resolution falls
 * to the built-in DEFAULT_ROLES regardless of the repo's live config or the
 * machine's user-level config. The launch.sh subprocess inherits both (cwd
 * is irrelevant to the script — its chain rides TUT_PROJECT_ROOT/anchor —
 * and TUT_USER_CONFIG_DIR rides the env).
 */
async function withCleanChain<T>(fn: () => Promise<T>): Promise<T> {
  const prevCwd = process.cwd();
  const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
  const prevHerdr = process.env.TUT_HERDR_EXECUTABLE;
  const prevPanes = process.env.TUT_HERDR_PANES;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-cli-chain-"));
  process.chdir(tmp);
  process.env.TUT_USER_CONFIG_DIR = path.join(tmp, "user-config");
  process.env.TUT_HERDR_EXECUTABLE = path.resolve(import.meta.dirname, "bin/herdr");
  process.env.TUT_HERDR_PANES = "[]";
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
    else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
    if (prevHerdr === undefined) delete process.env.TUT_HERDR_EXECUTABLE;
    else process.env.TUT_HERDR_EXECUTABLE = prevHerdr;
    if (prevPanes === undefined) delete process.env.TUT_HERDR_PANES;
    else process.env.TUT_HERDR_PANES = prevPanes;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Migrated from http.test.ts and extended to the
// nine-command parser with both flag forms, plus the handler-wiring
// tests.

describe("cli arg parsing (pure parseArgs)", () => {
  it("parses serve with --port and --root", () => {
    expect(parseArgs(["serve", "--port", "4123", "--root", "/tmp/hub"])).toEqual({
      command: "serve",
      port: 4123,
      root: "/tmp/hub",
    });
  });

  it("serves with --port=0 (equals form, ephemeral port)", () => {
    expect(parseArgs(["serve", "--port=0"])).toEqual({
      command: "serve",
      port: 0,
      root: ".context-hub",
    });
  });

  it("defaults root to .context-hub and leaves port undefined", () => {
    expect(parseArgs(["serve"])).toEqual({ command: "serve", root: ".context-hub" });
  });

  it("usage on no arguments", () => {
    expect(parseArgs([])).toEqual({ command: "usage" });
  });

  it("usage on unknown command", () => {
    expect(parseArgs(["bogus"])).toEqual({ command: "usage", error: "unknown command: bogus" });
  });

  it("usage on unknown flag", () => {
    expect(parseArgs(["serve", "--nope"])).toEqual({ command: "usage", error: "unknown argument: --nope" });
  });

  it("usage on missing or non-numeric --port value", () => {
    expect(parseArgs(["serve", "--port"])).toEqual({
      command: "usage",
      error: "--port requires a value",
    });
    expect(parseArgs(["serve", "--port", "abc"]).command).toBe("usage");
  });

  it("usage on missing --root value", () => {
    expect(parseArgs(["serve", "--root"])).toEqual({ command: "usage", error: "--root requires a value" });
  });

  // --- notify -----------------------------------------------------------------

  it("notify defaults url/interval/event-port/stall-timeout", () => {
    expect(parseArgs(["notify"])).toEqual({
      command: "notify",
      url: "http://127.0.0.1:3001",
      interval: 5,
      eventPort: 3002,
      stallTimeoutMin: 30,
    });
  });

  it("notify overrides all flags, equals form included", () => {
    expect(parseArgs(["notify", "--url", "http://127.0.0.1:9/", "--interval=1", "--event-port", "3100", "--stall-timeout", "5"])).toEqual({
      command: "notify",
      url: "http://127.0.0.1:9/",
      interval: 1,
      eventPort: 3100,
      stallTimeoutMin: 5,
    });
  });

  it("notify accepts a configurable launch→working short fuse", () => {
    expect(parseArgs(["notify", "--working-timeout=17"])).toEqual({
      command: "notify",
      url: "http://127.0.0.1:3001",
      interval: 5,
      eventPort: 3002,
      stallTimeoutMin: 30,
      workingTimeoutSec: 17,
    });
    expect(parseArgs(["notify", "--launch-working-timeout", "19"])).toMatchObject({
      command: "notify",
      workingTimeoutSec: 19,
    });
  });

  // --- mode / start-next -------------------------------------------------------

  it("mode parses both values and validates", () => {
    expect(parseArgs(["mode", "auto"])).toEqual({ command: "mode", mode: "auto", url: "http://127.0.0.1:3001" });
    expect(parseArgs(["mode", "manual", "--url", "http://x:1"])).toEqual({ command: "mode", mode: "manual", url: "http://x:1" });
    expect(parseArgs(["mode", "banana"]).command).toBe("usage");
    expect(parseArgs(["mode"]).command).toBe("usage");
  });

  it("start-next parses task_id and flags; no-arg is valid", () => {
    expect(parseArgs(["start-next", "auth-refactor"])).toEqual({
      command: "start-next",
      task_id: "auth-refactor",
      url: "http://127.0.0.1:3001",
      force: false,
      fresh: false,
    });
    expect(parseArgs(["start-next", "auth-refactor", "--force"])).toEqual({
      command: "start-next",
      task_id: "auth-refactor",
      url: "http://127.0.0.1:3001",
      force: true,
      fresh: false,
    });
    expect(parseArgs(["start-next", "auth-refactor", "--force=1"]).command).toBe("usage");
    expect(parseArgs(["start-next", "auth-refactor", "--force", "extra"])).toEqual({
      command: "usage",
      error: "unexpected argument: extra",
    });
    expect(parseArgs(["start-next"])).toEqual({
      command: "start-next",
      url: "http://127.0.0.1:3001",
      force: false,
      fresh: false,
    });
  });

  // --- context commands --------------------------------------------------------

  it("create requires all four flags", () => {
    expect(parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R"])).toEqual({
      command: "create",
      title: "T",
      description: "D",
      creator: "C",
      role: "R",
    });
    expect(parseArgs(["create", "--title", "T"]).command).toBe("usage");
  });

  it("create parses --flow in both forms and validates the enum", () => {
    expect(parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R", "--flow", "direct"])).toEqual({
      command: "create",
      title: "T",
      description: "D",
      creator: "C",
      role: "R",
      flow: "direct",
    });
    expect(parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R", "--flow=solo"])).toEqual({
      command: "create",
      title: "T",
      description: "D",
      creator: "C",
      role: "R",
      flow: "solo",
    });
    // full is explicit-able too; absent stays absent (default)
    const fullExplicit = parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R", "--flow", "full"]);
    expect(fullExplicit.command === "create" && fullExplicit.flow).toBe("full");
    const fullDefault = parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R"]);
    expect(fullDefault.command === "create" && fullDefault.flow).toBeUndefined();
    expect(
      parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R", "--flow", "turbo"]),
    ).toEqual({ command: "usage", error: "--flow must be full|direct|solo, got: turbo" });
  });

  it("publish parses positional + flags, both forms, commits split", () => {
    const parsed = parseArgs([
      "publish", "auth-refactor",
      "--role", "executor", "--content-type=code_changes", "--summary", "done",
      "--body", "the body", "--commits", "a1b2c3d, e4f5a6b",
      "--ref-version", "3", "--expected-version=2", "--agent", "pi", "--model", "glm",
    ]);
    expect(parsed).toEqual({
      command: "publish",
      task_id: "auth-refactor",
      role: "executor",
      content_type: "code_changes",
      summary: "done",
      body: "the body",
      commits: ["a1b2c3d", "e4f5a6b"],
      refVersion: 3,
      expectedVersion: 2,
      agent: "pi",
      model: "glm",
    });
  });

  it("publish accepts --payload-file instead of --body", () => {
    const parsed = parseArgs(["publish", "t1", "--role", "r", "--content-type", "note", "--summary", "s", "--payload-file", "/tmp/b.md"]);
    expect(parsed.command === "publish" && parsed.payloadFile).toBe("/tmp/b.md");
    expect(parsed.command === "publish" && parsed.body).toBeUndefined();
  });

  it("publish rejects missing/mutually-exclusive body forms and bad numbers", () => {
    const base = ["publish", "t1", "--role", "r", "--content-type", "note", "--summary", "s"];
    expect(parseArgs([...base]).command).toBe("usage");
    expect(parseArgs([...base, "--body", "b", "--payload-file", "f"]).command).toBe("usage");
    expect(parseArgs([...base, "--body", "b", "--ref-version", "x"]).command).toBe("usage");
    expect(parseArgs(["publish", "--role", "r", "--content-type", "t", "--summary", "s", "--body", "b"]).command).toBe("usage");
  });

  it("read parses --json boolean and --since-version", () => {
    expect(parseArgs(["read", "t1", "--json"])).toEqual({ command: "read", task_id: "t1", json: true });
    expect(parseArgs(["read", "t1", "--since-version", "3", "--json"])).toEqual({
      command: "read",
      task_id: "t1",
      sinceVersion: 3,
      json: true,
    });
    expect(parseArgs(["read", "t1", "--json=1"]).command).toBe("usage");
  });

  it("list parses optional status and json", () => {
    expect(parseArgs(["list"])).toEqual({ command: "list", json: false });
    expect(parseArgs(["list", "--status", "implementing", "--json"])).toEqual({ command: "list", status: "implementing", json: true });
  });

  it("status takes no positionals and only the --json boolean", () => {
    expect(parseArgs(["status"])).toEqual({ command: "status", json: false });
    expect(parseArgs(["status", "--json"])).toEqual({ command: "status", json: true });
    expect(parseArgs(["status", "extra"])).toEqual({ command: "usage", error: "unexpected argument: extra" });
    expect(parseArgs(["status", "--nope"])).toEqual({ command: "usage", error: "unknown argument: --nope" });
    expect(parseArgs(["status", "--json=1"]).command).toBe("usage");
    expect(parseArgs(["status", "--status", "x"]).command).toBe("usage"); // list's flag is not status's
  });

  it("decide validates decision enum and requires by", () => {
    expect(parseArgs(["decide", "t1", "--decision", "approve", "--by", "alice", "--reason", "ok"])).toEqual({
      command: "decide",
      task_id: "t1",
      decision: "approve",
      by: "alice",
      reason: "ok",
    });
    expect(parseArgs(["decide", "t1", "--decision", "bogus", "--by", "alice"]).command).toBe("usage");
    expect(parseArgs(["decide", "t1", "--decision", "close"]).command).toBe("usage");
  });

  it("ack parses the task_id positional and optional --note in both forms", () => {
    expect(parseArgs(["ack", "t1"])).toEqual({ command: "ack", task_id: "t1" });
    expect(parseArgs(["ack", "t1", "--note", "checked the duplicate-version warning"])).toEqual({
      command: "ack",
      task_id: "t1",
      note: "checked the duplicate-version warning",
    });
    expect(parseArgs(["ack", "t1", "--note=fixed by hand"])).toEqual({
      command: "ack",
      task_id: "t1",
      note: "fixed by hand",
    });
  });

  it("ack usage errors: missing/extra positional, unknown flag, missing/duplicate/empty note", () => {
    expect(parseArgs(["ack"])).toEqual({ command: "usage", error: "ack requires a task_id" });
    expect(parseArgs(["ack", "t1", "extra"])).toEqual({ command: "usage", error: "unexpected argument: extra" });
    expect(parseArgs(["ack", "t1", "--json"])).toEqual({ command: "usage", error: "unknown argument: --json" });
    expect(parseArgs(["ack", "t1", "--note"])).toEqual({ command: "usage", error: "--note requires a value" });
    expect(parseArgs(["ack", "t1", "--note", "a", "--note", "b"]).command).toBe("usage");
    expect(parseArgs(["ack", "t1", "--note="])).toEqual({
      command: "usage",
      error: "--note requires a non-empty value",
    });
    expect(parseArgs(["ack", "t1", "--note", ""])).toEqual({
      command: "usage",
      error: "--note requires a non-empty value",
    });
  });

  it("rejects duplicate flags", () => {
    expect(parseArgs(["serve", "--port", "1", "--port", "2"]).command).toBe("usage");
  });

  it("rejects extra positionals with 'unexpected argument'", () => {
    expect(parseArgs(["mode", "auto", "extra"])).toEqual({ command: "usage", error: "unexpected argument: extra" });
    expect(parseArgs(["start-next", "t1", "extra"])).toEqual({ command: "usage", error: "unexpected argument: extra" });
    expect(parseArgs(["read", "t1", "extra", "--json"])).toEqual({ command: "usage", error: "unexpected argument: extra" });
    expect(parseArgs(["decide", "t1", "extra", "--decision", "approve", "--by", "alice"])).toEqual({
      command: "usage",
      error: "unexpected argument: extra",
    });
    expect(parseArgs(["publish", "t1", "extra", "--role", "r", "--content-type", "note", "--summary", "s", "--body", "b"])).toEqual({
      command: "usage",
      error: "unexpected argument: extra",
    });
  });

  it("USAGE documents all seventeen subcommands", () => {
    for (const cmd of ["serve", "notify", "mode", "config", "start-next", "watch", "create", "publish", "read", "list", "status", "decide", "ack", "assign", "up", "skill", "init"]) {
      expect(USAGE).toContain(`tut ${cmd}`);
    }
  });
});

// --- handler wiring -----------------------------------------------------------------

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

describe("context handlers (hub-client mocked: wiring + output contract)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    for (const fn of [hubCreate, hubPublish, hubRead, hubList, hubDecide]) {
      vi.mocked(fn).mockReset();
    }
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
  });

  it("create calls hubCreate on the default URL and prints compact JSON", async () => {
    vi.mocked(hubCreate).mockResolvedValue({ task_id: "wire-task", status: "designing", version: 0 });

    const code = await main(["create", "--title", "Wire Task", "--description", "D", "--creator", "C", "--role", "R"]);

    expect(code).toBe(0);
    expect(io.out()).toBe('{"task_id":"wire-task","status":"designing","version":0}\n');
    expect(vi.mocked(hubCreate)).toHaveBeenCalledWith("http://127.0.0.1:3001", {
      title: "Wire Task",
      description: "D",
      creator: "C",
      role: "R",
    });
  });

  it("create --flow passes through and the per-flow status prints; absent flow stays out of the call", async () => {
    vi.mocked(hubCreate).mockResolvedValue({ task_id: "direct-task", status: "implementing", version: 0 });

    const code = await main(["create", "--title", "Wire Direct", "--description", "D", "--creator", "C", "--role", "R", "--flow", "direct"]);

    expect(code).toBe(0);
    expect(io.out()).toBe('{"task_id":"direct-task","status":"implementing","version":0}\n');
    expect(vi.mocked(hubCreate)).toHaveBeenCalledWith("http://127.0.0.1:3001", {
      title: "Wire Direct",
      description: "D",
      creator: "C",
      role: "R",
      flow: "direct",
    });

    io.restore();
    const io2 = captureIo();
    try {
      vi.mocked(hubCreate).mockResolvedValue({ task_id: "plain-task", status: "designing", version: 0 });
      const plain = await main(["create", "--title", "Plain", "--description", "D", "--creator", "C", "--role", "R"]);
      expect(plain).toBe(0);
      expect(vi.mocked(hubCreate)).toHaveBeenLastCalledWith("http://127.0.0.1:3001", {
        title: "Plain",
        description: "D",
        creator: "C",
        role: "R",
      });
    } finally {
      io2.restore();
    }
  });

  it("publish --payload-file uses the WHOLE file as payload.body (--summary stays separate)", async () => {
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t1", version: 2, status: "implementing", needs_attention: false });
    const payloadFile = path.join(os.tmpdir(), `tut-cli-payload-${process.pid}.md`);
    writeFileSync(payloadFile, "# body line one\nbody line two\n", "utf8");

    try {
      const code = await main([
        "publish", "t1", "--role", "executor", "--content-type", "code_changes", "--summary", "done",
        "--payload-file", payloadFile, "--commits", "a1b2c3d", "--expected-version", "1",
      ]);

      expect(code).toBe(0);
      expect(vi.mocked(hubPublish)).toHaveBeenCalledWith("http://127.0.0.1:3001", {
        task_id: "t1",
        role: "executor",
        content_type: "code_changes",
        payload: {
          summary: "done",
          body: "# body line one\nbody line two\n",
          commits: ["a1b2c3d"],
        },
        expected_version: 1,
      });
      expect(io.out()).toContain('"version":2');
    } finally {
      rmSync(payloadFile, { force: true });
    }
  });

  it("publish with an unreadable --payload-file exits 1 without calling the hub", async () => {
    const code = await main([
      "publish", "t1", "--role", "r", "--content-type", "note", "--summary", "s",
      "--payload-file", "/nonexistent/nope.md",
    ]);

    expect(code).toBe(1);
    expect(io.err()).toContain("--payload-file");
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled();
  });

  it("HubError exits 1 with the code as the FIRST stderr line", async () => {
    vi.mocked(hubRead).mockRejectedValue(new HubError("TASK_NOT_FOUND", "task not found: t1"));

    const code = await main(["read", "t1"]);

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("TASK_NOT_FOUND: task not found: t1");
  });

  it("read renders a human table by default (summary first line only)", async () => {
    vi.mocked(hubRead).mockResolvedValue({
      task_id: "t1",
      title: "Render Task",
      status: "implementing",
      versions: [
        {
          version: 1,
          task_id: "t1",
          role: "architect",
          content_type: "design",
          timestamp: "2026-08-15T00:00:00.000Z",
          payload: { summary: "first summary line\nsecond summary line", body: "b" },
        },
      ],
    });

    const code = await main(["read", "t1"]);

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("task:    t1");
    expect(out).toContain("title:   Render Task");
    expect(out).toContain("status:  implementing");
    expect(out).toContain("version");
    expect(out).toContain("design");
    expect(out).toContain("architect");
    expect(out).toContain("first summary line");
    expect(out).not.toContain("second summary line");
  });

  it("read renders the description line (first line of the requirement text)", async () => {
    vi.mocked(hubRead).mockResolvedValue({
      task_id: "t1",
      title: "Solo Task",
      description: "Fix the off-by-one\nin the pagination helper.",
      status: "pending_approval",
      versions: [],
    });

    const code = await main(["read", "t1"]);

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("desc:    Fix the off-by-one");
    expect(out).not.toContain("in the pagination helper."); // first line only; --json shows it verbatim
  });

  it("read --json prints the raw result as JSON", async () => {
    const result = { task_id: "t1", title: "T", status: "designing", versions: [] };
    vi.mocked(hubRead).mockResolvedValue(result);

    const code = await main(["read", "t1", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(io.out())).toEqual(result);
  });

  it("list renders a human table (project scope marked, att flag) and --json prints raw", async () => {
    vi.mocked(hubList).mockResolvedValue({
      tasks: [
        { task_id: "t1", title: "Task One", updated_at: "x", status: "implementing", waiting_for: "agent:executor", needs_attention: false },
        { task_id: "t2", title: "Task Two", updated_at: "x", status: "reviewing", waiting_for: "human", needs_attention: true },
        { task_id: "project", title: "project", updated_at: "x", scope: "project" },
      ],
    });

    const human = await main(["list"]);
    expect(human).toBe(0);
    const out = io.out();
    expect(out).toContain("task_id");
    expect(out).toContain("waiting_for");
    expect(out).toContain("t1");
    expect(out).toContain("agent:executor");
    expect(out).toContain("Task One");
    expect(out).toContain("yes"); // needs_attention marker
    expect(out).toContain("project");

    io.restore();
    const io2 = captureIo();
    try {
      const json = await main(["list", "--json"]);
      expect(json).toBe(0);
      expect(JSON.parse(io2.out()).tasks).toHaveLength(3);
    } finally {
      io2.restore();
    }
  });

  it("list renders an explicit empty state", async () => {
    vi.mocked(hubList).mockResolvedValue({ tasks: [] });

    const code = await main(["list", "--status", "closed"]);

    expect(code).toBe(0);
    expect(io.out()).toBe("no tasks\n");
  });

  // Shared fixture for the status view: two attention tasks (newest first),
  // then normal tasks by updated_at desc with a task_id tiebreak, a closed
  // task in the mix, and a project-scope entry that must never appear.
  const STATUS_FIXTURE = {
    tasks: [
      { task_id: "att-old", title: "Older Anomaly", updated_at: "2026-08-16T12:00:00.000Z", status: "designing", waiting_for: "human", needs_attention: true },
      { task_id: "att-new", title: "Newer Anomaly", updated_at: "2026-08-16T13:00:00.000Z", status: "reviewing", waiting_for: "human", needs_attention: true },
      { task_id: "normal-stale", title: "Quiet Task", updated_at: "2026-08-15T08:00:00.000Z", status: "implementing", waiting_for: "agent:executor", needs_attention: false },
      { task_id: "tie-b", title: "Tie B", updated_at: "2026-08-16T09:00:00.000Z", status: "approved", waiting_for: "human", needs_attention: false },
      { task_id: "tie-a", title: "Tie A (closed)", updated_at: "2026-08-16T09:00:00.000Z", status: "closed", waiting_for: "none", needs_attention: false },
      { task_id: "normal-fresh", title: "Fresh Task", updated_at: "2026-08-16T13:30:00.000Z", status: "implementing", waiting_for: "agent:executor", needs_attention: false },
      { task_id: "project", title: "project", updated_at: "2026-08-16T23:00:00.000Z", scope: "project" as const },
    ],
  };
  const STATUS_ORDER = ["att-new", "att-old", "normal-fresh", "tie-a", "tie-b", "normal-stale"];

  it("status renders summary counts + table with attention first, updated_at desc, task_id tiebreak", async () => {
    vi.mocked(hubList).mockResolvedValue(STATUS_FIXTURE);

    const code = await main(["status"]);

    expect(code).toBe(0);
    const out = io.out();
    // Summary: totals exclude the project scope entry.
    expect(out).toContain("6 tasks, 2 needs attention, 1 closed");
    // Column headers and per-task fields.
    for (const header of ["att", "task_id", "status", "waiting_for", "updated_at", "title"]) {
      expect(out).toContain(header);
    }
    expect(out).toContain("2026-08-16T13:30:00.000Z");
    expect(out).toContain("Fresh Task");
    expect(out).toContain("agent:executor");
    // Fixed row order: attention first (newest first), then updated_at desc,
    // task_id ascending as the stable tiebreak (tie-a < tie-b).
    const rowOrder = STATUS_ORDER.map((id) => out.indexOf(id));
    expect(rowOrder).toEqual([...rowOrder].sort((a, b) => a - b));
    for (const i of [1, 2, 3, 4, 5]) {
      expect(rowOrder[i]).toBeGreaterThan(rowOrder[i - 1]!);
    }
    // Anomaly marker only on the attention rows.
    expect(out).toContain("!!");
    expect(out.split("!!").length - 1).toBe(2);
    // project scope never renders.
    expect(out).not.toContain("23:00:00");
  });

  it("status --json prints the same filtered/sorted snapshot with entries passed through verbatim", async () => {
    vi.mocked(hubList).mockResolvedValue(STATUS_FIXTURE);

    const code = await main(["status", "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(io.out()) as { tasks: Array<Record<string, unknown>> };
    expect(parsed.tasks.map((t) => t.task_id)).toEqual(STATUS_ORDER);
    // Verbatim passthrough: each entry equals its fixture object, no added or
    // derived fields (no warnings, no recomputed status).
    const byId = new Map(STATUS_FIXTURE.tasks.map((t) => [t.task_id, t]));
    for (const entry of parsed.tasks) {
      expect(entry).toEqual(byId.get(entry.task_id as string));
    }
  });

  it("status on an empty hub and on a project-only hub both render 'no tasks' with exit 0", async () => {
    vi.mocked(hubList).mockResolvedValueOnce({ tasks: [] });
    let code = await main(["status"]);
    expect(code).toBe(0);
    expect(io.out()).toBe("no tasks\n");

    io.restore();
    const io2 = captureIo();
    try {
      vi.mocked(hubList).mockResolvedValueOnce({ tasks: [{ task_id: "project", title: "project", updated_at: "x", scope: "project" }] });
      code = await main(["status"]);
      expect(code).toBe(0);
      expect(io2.out()).toBe("no tasks\n");
    } finally {
      io2.restore();
    }
  });

  it("status HubError exits 1 with the code line; ordinary errors exit 1 with a tut: line", async () => {
    vi.mocked(hubList).mockRejectedValueOnce(new HubError("HUB_DOWN", "boom"));
    let code = await main(["status"]);
    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("HUB_DOWN: boom");

    io.restore();
    const io2 = captureIo();
    try {
      vi.mocked(hubList).mockRejectedValueOnce(new Error("fetch failed"));
      code = await main(["status", "--json"]);
      expect(code).toBe(1);
      expect(io2.err().split("\n")[0]).toBe("tut: fetch failed");
    } finally {
      io2.restore();
    }
  });

  it("decide passes decision/by/reason through and prints the result", async () => {
    vi.mocked(hubDecide).mockResolvedValue({ task_id: "t1", status: "approved" });

    const code = await main(["decide", "t1", "--decision", "approve", "--by", "alice", "--reason", "ship it"]);

    expect(code).toBe(0);
    expect(io.out()).toBe('{"task_id":"t1","status":"approved"}\n');
    expect(vi.mocked(hubDecide)).toHaveBeenCalledWith("http://127.0.0.1:3001", {
      task_id: "t1",
      decision: "approve",
      by: "alice",
      reason: "ship it",
    });
  });

  it("ack publishes the fixed human ack note (default body) and prints compact JSON", async () => {
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t1", version: 3, status: "reviewing", needs_attention: false });

    const code = await main(["ack", "t1"]);

    expect(code).toBe(0);
    expect(io.out()).toBe('{"task_id":"t1","version":3,"status":"reviewing","needs_attention":false}\n');
    expect(vi.mocked(hubPublish)).toHaveBeenCalledWith("http://127.0.0.1:3001", {
      task_id: "t1",
      role: "human",
      content_type: "note",
      payload: {
        summary: "ack: anomalies handled",
        body: "Anomalies reviewed and handled; derived needs_attention clears on the next state pass.",
        ack: true,
      },
    });
  });

  it("ack --note becomes the body and its first line the summary (long lines clamp)", async () => {
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t1", version: 2, needs_attention: false });
    const long = "x".repeat(80);

    await main(["ack", "t1", "--note=first line is the summary\nsecond line is context"]);
    expect(vi.mocked(hubPublish)).toHaveBeenLastCalledWith("http://127.0.0.1:3001", {
      task_id: "t1",
      role: "human",
      content_type: "note",
      payload: {
        summary: "first line is the summary",
        body: "first line is the summary\nsecond line is context",
        ack: true,
      },
    });

    await main(["ack", "t1", "--note", long]);
    expect(vi.mocked(hubPublish)).toHaveBeenLastCalledWith("http://127.0.0.1:3001", {
      task_id: "t1",
      role: "human",
      content_type: "note",
      payload: { summary: `${"x".repeat(72)}…`, body: long, ack: true },
    });
  });

  it("ack HubError exits 1 with the code as the FIRST stderr line", async () => {
    vi.mocked(hubPublish).mockRejectedValue(new HubError("TASK_NOT_FOUND", "task not found: ghost"));

    const code = await main(["ack", "ghost"]);

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("TASK_NOT_FOUND: task not found: ghost");
  });

  it("ack against an unreachable hub exits 1 with a plain tut: message", async () => {
    vi.mocked(hubPublish).mockRejectedValue(new Error("fetch failed"));

    const code = await main(["ack", "t1"]);

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("tut: fetch failed");
  });
});

describe("mode / start-next handlers (real hub)", () => {
  let tmp: string;
  let root: string;
  let running: RunningServer;
  let baseUrl: string;
  let io: ReturnType<typeof captureIo>;

  beforeEach(async () => {
    vi.mocked(hubRead).mockReset();
    vi.mocked(hubPublish).mockReset();
    tmp = mkdtempSync(path.join(os.tmpdir(), "tut-cli-"));
    root = path.join(tmp, ".context-hub");
    running = await startServer({ root, port: 0 });
    baseUrl = running.url;
    io = captureIo();
  });

  afterEach(async () => {
    io.restore();
    await running.close().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("mode switches flow_mode via POST /mode, prints the echo, /state reflects it", async () => {
    const code = await main(["mode", "auto", "--url", baseUrl]);

    expect(code).toBe(0);
    expect(io.out()).toContain('"flow_mode":"auto"');
    const state = (await (await fetch(`${baseUrl}/state`)).json()) as { flow_mode: string };
    expect(state.flow_mode).toBe("auto");
  });

  it("mode against an unreachable hub exits 1 with a clear message", async () => {
    const code = await main(["mode", "auto", "--url", "http://127.0.0.1:9"]);

    expect(code).toBe(1);
    expect(io.err()).toContain("cannot reach Hub");
  });

  it("start-next extracts the role from waiting_for and runs launch.sh (TUT_DRY_RUN passthrough)", async () => {
    const store = new Store(root);
    const created = await store.createTask({ title: "Start Next Task", description: "d", creator: "t", role: "architect" });
    await store.append(created.task_id, { role: "architect", content_type: "design", payload: { summary: "s", body: "b" } });
    // now implementing → waiting_for agent:executor
    vi.mocked(hubRead).mockResolvedValue({
      task_id: created.task_id,
      title: "Start Next Task",
      status: "implementing",
      versions: [
        {
          version: 1,
          task_id: created.task_id,
          role: "architect",
          content_type: "design",
          timestamp: "2026-08-17T00:00:00.000Z",
          payload: { summary: "design", body: "design" },
        },
      ],
    });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: created.task_id, version: 1, status: "implementing", needs_attention: false });

    const prev = process.env.TUT_DRY_RUN;
    process.env.TUT_DRY_RUN = "1";
    let code: number;
    try {
      code = await withCleanChain(() => main(["start-next", created.task_id, "--url", baseUrl]));
    } finally {
      if (prev === undefined) delete process.env.TUT_DRY_RUN;
      else process.env.TUT_DRY_RUN = prev;
    }

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("DRY-RUN"); // launch.sh honored the passthrough env
    expect(out).toContain("(agent 'pi', label"); // DEFAULT_ROLES: executor → pi (chain L3)
    expect(out).toContain(created.task_id);
    expect(out).toContain(`launched executor for ${created.task_id}`);
  });

  it("start-next blocks a duplicate launch before appending or spawning", async () => {
    vi.mocked(hubRead).mockResolvedValue({
      task_id: "already-task",
      title: "Already launched",
      status: "implementing",
      versions: [
        {
          version: 1,
          task_id: "already-task",
          role: "architect",
          content_type: "design",
          timestamp: "2026-08-17T00:00:00.000Z",
          payload: { summary: "design", body: "design" },
        },
        {
          version: 2,
          task_id: "already-task",
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
    const store = new Store(root);
    const created = await store.createTask({ title: "Duplicate Task", description: "d", creator: "t", role: "architect" });
    await store.append(created.task_id, { role: "architect", content_type: "design", payload: { summary: "s", body: "b" } });
    await store.append(created.task_id, { role: "human", content_type: "note", payload: { summary: "operator note", body: "operator note" } });

    const code = await main(["start-next", created.task_id, "--url", baseUrl]);

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toContain("tut: ALREADY_LAUNCHED: executor launched at v2");
    expect(io.err()).toContain("use --force to relaunch");
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled();
    expect(io.out()).not.toContain("DRY-RUN");
  });

  it("start-next --force appends a fresh marker and launches despite a duplicate", async () => {
    vi.mocked(hubRead).mockResolvedValue({
      task_id: "force-task",
      title: "Force task",
      status: "implementing",
      versions: [
        {
          version: 1,
          task_id: "force-task",
          role: "architect",
          content_type: "design",
          timestamp: "2026-08-17T00:00:00.000Z",
          payload: { summary: "design", body: "design" },
        },
        {
          version: 2,
          task_id: "force-task",
          role: "human",
          content_type: "note",
          timestamp: "2026-08-17T00:01:00.000Z",
          payload: { summary: "launch", body: "launch", launch: { role: "executor", base_version: 1, via: "auto" } },
        },
      ],
    });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "force-task", version: 3, status: "implementing", needs_attention: false });
    const store = new Store(root);
    const created = await store.createTask({ title: "Force Task", description: "d", creator: "t", role: "architect" });
    await store.append(created.task_id, { role: "architect", content_type: "design", payload: { summary: "s", body: "b" } });
    await store.append(created.task_id, { role: "human", content_type: "note", payload: { summary: "operator note", body: "operator note" } });

    const prev = process.env.TUT_DRY_RUN;
    process.env.TUT_DRY_RUN = "1";
    try {
      const code = await main(["start-next", created.task_id, "--url", baseUrl, "--force"]);
      expect(code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.TUT_DRY_RUN;
      else process.env.TUT_DRY_RUN = prev;
    }

    expect(vi.mocked(hubPublish)).toHaveBeenCalledWith(baseUrl, {
      task_id: created.task_id,
      role: "human",
      content_type: "note",
      payload: expect.objectContaining({
        launch: expect.objectContaining({ role: "executor", base_version: 2, via: "start-next", protocol_version: 2 }),
      }),
      expected_version: 2,
    });
    expect(io.out()).toContain("DRY-RUN");
  });

  it("start-next does not spawn when the launch marker append loses the version race", async () => {
    vi.mocked(hubRead).mockResolvedValue({
      task_id: "race-task",
      title: "Race task",
      status: "implementing",
      versions: [
        {
          version: 1,
          task_id: "race-task",
          role: "architect",
          content_type: "design",
          timestamp: "2026-08-17T00:00:00.000Z",
          payload: { summary: "design", body: "design" },
        },
      ],
    });
    vi.mocked(hubPublish).mockRejectedValue(new HubError("VERSION_CONFLICT", "expected_version 1 does not match current version 2"));
    const store = new Store(root);
    const created = await store.createTask({ title: "Race Task", description: "d", creator: "t", role: "architect" });
    await store.append(created.task_id, { role: "architect", content_type: "design", payload: { summary: "s", body: "b" } });

    // Deterministic routing for the launch pre-check: clean chain (no L1,
    // no L2) so executor resolves through DEFAULT_ROLES (pi, on PATH)
    // regardless of the repo's live config or the machine's user-level one.
    const prevCwd = process.cwd();
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    const chainTmp = mkdtempSync(path.join(os.tmpdir(), "tut-cli-race-"));
    process.chdir(chainTmp);
    process.env.TUT_USER_CONFIG_DIR = path.join(chainTmp, "user-config");
    let code: number;
    try {
      code = await main(["start-next", created.task_id, "--url", baseUrl]);
    } finally {
      process.chdir(prevCwd);
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
      rmSync(chainTmp, { recursive: true, force: true });
    }

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("VERSION_CONFLICT: expected_version 1 does not match current version 2");
    expect(io.out()).not.toContain("DRY-RUN");
  });

  it("start-next on a task waiting for a human exits 1 explaining there is nothing to start", async () => {
    const store = new Store(root);
    const created = await store.createTask({ title: "Human Gate", description: "d", creator: "t", role: "architect" });
    await store.append(created.task_id, { role: "architect", content_type: "design", payload: { summary: "s", body: "b" } });
    await store.append(created.task_id, { role: "executor", content_type: "code_changes", payload: { summary: "s", body: "b" } });
    await store.append(created.task_id, { role: "reviewer", content_type: "review", payload: { summary: "s", body: "b", verdict: "pass" } });
    // now pending_approval → waiting_for human

    const code = await main(["start-next", created.task_id, "--url", baseUrl]);

    expect(code).toBe(1);
    expect(io.err()).toContain("waiting for \"human\"");
    expect(io.err()).toContain("nothing to start");
  });

  it("start-next on a task absent from /state exits 1 with TASK_NOT_FOUND as the first stderr line", async () => {
    const code = await main(["start-next", "ghost-task", "--url", baseUrl]);

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("tut: TASK_NOT_FOUND: no task ghost-task in /state");
  });
});

// The up notify probe treats ONLY a 405 carrying
// the notifier's real feature (Allow header naming POST) as "notifier
// present". Verified live against the REAL notifier event server here — the
// discriminating feature is what notifier.ts actually sends, not a stub's say-so.
describe("up notify probe tighten (405 + Allow: POST)", () => {
  it("real notifier event server: GET /agent-event → 405 with Allow: POST, and the probe says healthy", async () => {
    const notifier = new Notifier({ url: "http://127.0.0.1:1", interval: 60, eventPort: 3291, stallTimeoutMin: 30 });
    await notifier.startEventServer(); // event listener only — no polling loop
    try {
      const res = await fetch("http://127.0.0.1:3291/agent-event", { headers: { Host: "127.0.0.1:3291" } });
      expect(res.status).toBe(405);
      expect((res.headers.get("allow") ?? "").toUpperCase()).toContain("POST");
      expect(await notifyHealthy("http://127.0.0.1:3291/agent-event")).toBe(true);
    } finally {
      await notifier.close();
    }
  });

  it("bare 405 without the Allow feature counts as down — an unrelated service no longer masks provisioning", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("method not allowed");
    });
    await new Promise<void>((resolve) => server.listen(3292, "127.0.0.1", resolve));
    try {
      const res = await fetch("http://127.0.0.1:3292/agent-event");
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBeNull(); // no Allow header at all
      expect(await notifyHealthy("http://127.0.0.1:3292/agent-event")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("405 with an Allow header that does NOT include POST still counts as down", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
      res.end("method not allowed");
    });
    await new Promise<void>((resolve) => server.listen(3292, "127.0.0.1", resolve));
    try {
      expect(await notifyHealthy("http://127.0.0.1:3292/agent-event")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a refused port counts as down (probe never throws)", async () => {
    expect(await notifyHealthy("http://127.0.0.1:9/agent-event")).toBe(false);
  });
});

// --- --url override (context + approval commands) -----------------------------------
// Additive revision: every hub-client command accepts --url (Hub BASE url,
// default http://127.0.0.1:3001). The parsed field is OPTIONAL — the default
// is applied in the handler, so the earlier parse assertions above stay
// byte-identical (the zero-migration guarantee this way has direct evidence).

describe("--url parse (both flag forms; absent → undefined, default in handler)", () => {
  it("create/list/status/decide/ack parse --url value and --url=value", () => {
    expect(
      parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R", "--url", "http://127.0.0.1:9"]),
    ).toEqual({ command: "create", title: "T", description: "D", creator: "C", role: "R", url: "http://127.0.0.1:9" });
    expect(parseArgs(["list", "--url=http://x:1"])).toEqual({ command: "list", json: false, url: "http://x:1" });
    expect((parseArgs(["status", "--url", "http://x:1", "--json"]) as { url?: string }).url).toBe("http://x:1");
    expect((parseArgs(["decide", "t1", "--decision", "approve", "--by", "i", "--url=http://x:1"]) as { url?: string }).url).toBe("http://x:1");
    expect((parseArgs(["ack", "t1", "--url", "http://x:1"]) as { url?: string }).url).toBe("http://x:1");
  });

  it("publish/read/up parse --url alongside their other flags", () => {
    const pub = parseArgs([
      "publish", "t1", "--role", "r", "--content-type", "note", "--summary", "s", "--body", "b", "--url", "http://x:1",
    ]);
    expect(pub.command).toBe("publish");
    expect((pub as { url?: string }).url).toBe("http://x:1");
    expect(parseArgs(["read", "t1", "--since-version", "2", "--url=http://x:1"])).toEqual({
      command: "read",
      task_id: "t1",
      sinceVersion: 2,
      json: false,
      url: "http://x:1",
    });
    expect(parseArgs(["up", "--url", "http://127.0.0.1:9", "--dry-run"])).toEqual({
      command: "up",
      dryRun: true,
      url: "http://127.0.0.1:9",
    });
  });

  it("absent --url stays undefined in the parsed shape (handler applies the default)", () => {
    expect(parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R"])).toEqual({
      command: "create",
      title: "T",
      description: "D",
      creator: "C",
      role: "R",
    });
    expect(parseArgs(["list"])).toEqual({ command: "list", json: false });
    expect(parseArgs(["status"])).toEqual({ command: "status", json: false });
    expect(parseArgs(["up"])).toEqual({ command: "up", dryRun: false });
  });
});

describe("--url handler wiring (hub-client mocked, one command per call)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    for (const fn of [hubCreate, hubPublish, hubRead, hubList, hubDecide]) {
      vi.mocked(fn).mockReset();
    }
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
  });

  it("create/publish/read/list/status/decide/ack all forward --url to their hub-client call", async () => {
    const override = "http://127.0.0.1:3009";
    vi.mocked(hubCreate).mockResolvedValue({ task_id: "u1", status: "designing", version: 0 });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "u1", version: 2, status: "implementing", needs_attention: false });
    vi.mocked(hubRead).mockResolvedValue({ task_id: "u1", title: "U", versions: [] });
    vi.mocked(hubList).mockResolvedValue({ tasks: [] });
    vi.mocked(hubDecide).mockResolvedValue({ task_id: "u1", status: "approved" });

    await main(["create", "--title", "U", "--description", "D", "--creator", "C", "--role", "R", "--url", override]);
    expect(vi.mocked(hubCreate)).toHaveBeenCalledWith(override, expect.anything());

    await main(["publish", "u1", "--role", "executor", "--content-type", "note", "--summary", "s", "--body", "b", "--url", override]);
    expect(vi.mocked(hubPublish)).toHaveBeenCalledWith(override, expect.anything());

    await main(["read", "u1", "--url", override]);
    expect(vi.mocked(hubRead)).toHaveBeenCalledWith(override, "u1", undefined);

    await main(["list", "--url", override]);
    expect(vi.mocked(hubList)).toHaveBeenCalledWith(override, undefined);

    await main(["status", "--url", override]);
    expect(vi.mocked(hubList)).toHaveBeenLastCalledWith(override);

    await main(["decide", "u1", "--decision", "approve", "--by", "alice", "--url", override]);
    expect(vi.mocked(hubDecide)).toHaveBeenCalledWith(override, expect.anything());

    await main(["ack", "u1", "--url", override]);
    expect(vi.mocked(hubPublish)).toHaveBeenLastCalledWith(override, expect.anything());
  });
});

// --- --cast parse + create wiring ----------------------------------------------------

describe("tut create --cast (parse + hubCreate wiring)", () => {
  it("parses comma-separated role=agent pairs, both flag forms", () => {
    expect(
      parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R", "--cast", "executor=pi,reviewer=codex"]),
    ).toEqual({ command: "create", title: "T", description: "D", creator: "C", role: "R", cast: { executor: "pi", reviewer: "codex" } });
    expect(
      (parseArgs(["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R", "--cast=architect=codex"]) as { cast?: unknown }).cast,
    ).toEqual({ architect: "codex" });
  });

  it("rejects unknown roles, malformed pairs, and empty agents", () => {
    const base = ["create", "--title", "T", "--description", "D", "--creator", "C", "--role", "R"] as const;
    expect(parseArgs([...base, "--cast", "boss=x"]).command).toBe("usage");
    expect(parseArgs([...base, "--cast", "executorpi"]).command).toBe("usage");
    expect(parseArgs([...base, "--cast", "executor="]).command).toBe("usage");
  });

  it("runCreate forwards cast to hubCreate (absent cast stays off the wire)", async () => {
    vi.mocked(hubCreate).mockResolvedValue({ task_id: "c1", status: "designing", version: 0 });
    const io = captureIo();
    try {
      await main(["create", "--title", "Cast", "--description", "D", "--creator", "C", "--role", "R", "--cast", "executor=pi"]);
      expect(vi.mocked(hubCreate)).toHaveBeenCalledWith("http://127.0.0.1:3001", {
        title: "Cast",
        description: "D",
        creator: "C",
        role: "R",
        cast: { executor: "pi" },
      });

      vi.mocked(hubCreate).mockClear();
      await main(["create", "--title", "Plain", "--description", "D", "--creator", "C", "--role", "R"]);
      expect(vi.mocked(hubCreate)).toHaveBeenCalledWith("http://127.0.0.1:3001", {
        title: "Plain",
        description: "D",
        creator: "C",
        role: "R",
      });
    } finally {
      io.restore();
    }
  });
});

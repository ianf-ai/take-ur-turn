// These tests isolate provisioning/probes; real endpoint selection has its own integration suite.
vi.mock("../src/hub/rig-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub/rig-discovery.js")>()),
  resolveUpHub: async (url: string, _explicit: boolean, _root: string, eventPort?: number) => ({ url, eventPort: eventPort ?? 3002 }),
  discoverHub: async () => undefined,
}));

import { scopedFixture } from "./rig-fixtures.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

// The seed hint reads the project scope through the hub-client layer; mock
// ONLY hubRead (the up handler's one hub-client call) so the hint branches are
// drivable without a live MCP endpoint — the same pattern as test/cli.test.ts.
vi.mock("../src/hub/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub/hub-client.js")>()),
  hubRead: vi.fn(),
}));

import { herdrPaneList, main, parseArgs } from "../src/cli.js";
import { hubRead, HubError, type HubReadResult } from "../src/hub/hub-client.js";
import type { ContextRecord } from "../src/common/types.js";

// tut up — parse layer first; behavior tests below drive the real
// handler through main() with:
//   - herdr stubbed by PATH injection (test/bin/herdr fixture: logs argv to
//     $TUT_HERDR_LOG, scripted JSON out — no process-internal mocks);
//   - fetch stubbed per test (probes target fixed 127.0.0.1 ports; the stub
//     can read the fixture log to simulate the spawned pane coming up);
//   - process.chdir into temp project dirs (cwd guardrail is step 0);
//   - TUT_UP_CLI_SELF pointing at a dist-style self (the src-layout guard
//     would otherwise fire, since these tests import the handler from src/).
// Real herdr syntax the fixture mirrors was verified live:
// split has no title/command arg → the flow is split → rename → run.

const REPO = path.resolve(import.meta.dirname, "..");
const TEST_BIN = path.join(REPO, "test", "bin");
const NODE_BIN_DIR = path.dirname(process.execPath);
const SAVED_CWD = process.cwd();
const SAVED_PATH = process.env.PATH ?? "";
const SAVED_LOG = process.env.TUT_HERDR_LOG;
const SAVED_PANES = process.env.TUT_HERDR_PANES;
const SAVED_FAIL = process.env.TUT_HERDR_FAIL;
const SAVED_REQUIRE_PANE_ID = process.env.TUT_HERDR_REQUIRE_PANE_ID;
const SAVED_HERDR_PANE_ID = process.env.HERDR_PANE_ID;
const SAVED_LAG_POLLS = process.env.TUT_HERDR_LIST_LAG_POLLS;
const SAVED_LAG_SET = process.env.TUT_HERDR_PANES_LAG;
const SAVED_WAIT = process.env.TUT_UP_HUB_WAIT_MS;
const SAVED_NOTIFY_WAIT = process.env.TUT_UP_NOTIFY_WAIT_MS;
const SAVED_SELF = process.env.TUT_UP_CLI_SELF;
const TRASH: string[] = [];
let fixtureRoot = process.cwd();
let fixtureHub = "http://127.0.0.1:3001";
let fixtureEvent = "http://127.0.0.1:3002/agent-event";
async function runUp(args: string[]): Promise<number> {
  const url = args.indexOf("--url"), port = args.indexOf("--event-port");
  fixtureHub = url < 0 ? "http://127.0.0.1:3001" : args[url + 1]!;
  fixtureEvent = "http://127.0.0.1:" + (port < 0 ? "3002" : args[port + 1]) + "/agent-event";
  return main(args);
}
function serviceFixture(text: string): string {
  const env = "TUT_HUB_ROOT=" + fixtureRoot + " TUT_HUB_URL=" + fixtureHub + " TUT_EVENT_PORT_URL=" + fixtureEvent;
  if (text.includes("pane split") && !text.startsWith("up: [dry-run]")) return text + " --env TUT_HUB_ROOT=" + fixtureRoot + " --env TUT_HUB_URL=" + fixtureHub + " --env TUT_EVENT_PORT_URL=" + fixtureEvent;
  return text.replace(/&& (?:TUT_EVENT_PORT_URL=\S+ )?node /, "&& " + env + " node ");
}

function makeProject(withPackageJson: boolean): { project: string; logPath: string; self: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tut-up-"));
  TRASH.push(dir);
  if (withPackageJson) writeFileSync(path.join(dir, "package.json"), '{"name":"up-probe"}\n', "utf8");
  else mkdirSync(path.join(dir, ".context-hub"));
  // process.cwd() after chdir reports the REAL path (/private/var on macOS) —
  // every expected command string is built from cwd, so hand out the realpath.
  const project = realpathSync(dir);
  fixtureRoot = project;
  // The provision target these tests model: a built dist/cli.js inside the
  // project (the path need not exist — it only rides inside command strings).
  const self = path.join(project, "dist", "cli.js");
  process.env.TUT_UP_CLI_SELF = self;
  return { project, logPath: path.join(project, "herdr.log"), self };
}

/** A project-scope read result with the given records (seed-hint fixture). */
function projectRead(records: ContextRecord[]): HubReadResult {
  return { task_id: "project", title: "project", versions: records };
}

/** One project-scope note record (minimal valid ContextRecord). */
function projectNote(summary: string, body = ""): ContextRecord {
  return {
    version: 1,
    task_id: "project",
    role: "human",
    content_type: "note",
    timestamp: "2026-08-17T00:00:00.000Z",
    payload: { summary, body },
  };
}

/** Fixture herdr (plus codex/pi fixtures) first on PATH; system dirs after. */
function useFixtureHerdr(logPath: string, panes?: unknown[]): void {
  process.env.PATH = `${TEST_BIN}:${NODE_BIN_DIR}:/usr/bin:/bin`;
  process.env.TUT_HERDR_LOG = logPath;
  if (panes === undefined) delete process.env.TUT_HERDR_PANES;
  else process.env.TUT_HERDR_PANES = JSON.stringify(panes.map((value) => {
    const pane = value as Record<string, unknown>;
    if (typeof pane.label !== "string" || !/^tut-(hub|notify)(-[a-f0-9]{8})?$/.test(pane.label)) return pane;
    // Shared fixtures are declared before each temporary project exists.
    return { ...pane, label: scopedFixture(pane.label.replace(/-[a-f0-9]{8}$/, ""), path.dirname(logPath)) };
  }));
}

function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

function logLines(logPath: string): string[] {
  const text = readLog(logPath).trim();
  return text.length === 0 ? [] : text.split("\n");
}

/** Capture process stdout/stderr into strings for the duration of a handler run. */
function captureIo(onError?: (text: string) => void): { out: () => string; err: () => string; restore: () => void } {
  let outText = "";
  let errText = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    outText += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errText += String(chunk);
    onError?.(String(chunk));
    return true;
  });
  return { out: () => outText, err: () => errText, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

function responseJson(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(typeof obj === "object" && obj !== null && "flow_mode" in obj ? { hub_root: fixtureRoot, ...obj } : obj), { status });
}

const refused = (): Promise<Response> => Promise.reject(new TypeError("fetch failed"));

/** Stub global fetch with a url-string dispatcher; returns the spy. */
function stubFetch(impl: (url: string) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown): Promise<Response> => {
    const response = await impl(String(input));
    if (response.status !== 405) return response;
    return new Response(JSON.stringify({ hub_root: fixtureRoot, hub_url: fixtureHub }), { status: 405, headers: response.headers });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/**
 * Log-aware probes: /state turns healthy (flow_mode + tasks shape) once the
 * fixture log shows the serve pane command was run; /agent-event answers the
 * notifier's real 405 (+ Allow: POST, the probe feature) once the notify
 * command was run — simulating the spawned panes coming up.
 */
function logAwareProbes(logPath: string): (url: string) => Promise<Response> {
  return (url) => {
    const logged = readLog(logPath);
    if (url.includes(":3001/state")) {
      return logged.includes(" serve") ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] })) : refused();
    }
    if (url.includes(":3002/agent-event")) {
      return logged.includes(" notify")
        ? Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }))
        : refused();
    }
    return refused();
  };
}

beforeEach(() => {
  // Default: readable empty project scope (hint = "unseeded" branch unless
  // a test overrides hubRead).
  vi.mocked(hubRead).mockResolvedValue(projectRead([]));
});

afterEach(() => {
  process.chdir(SAVED_CWD);
  process.env.PATH = SAVED_PATH;
  if (SAVED_LOG === undefined) delete process.env.TUT_HERDR_LOG;
  else process.env.TUT_HERDR_LOG = SAVED_LOG;
  if (SAVED_PANES === undefined) delete process.env.TUT_HERDR_PANES;
  else process.env.TUT_HERDR_PANES = SAVED_PANES;
  if (SAVED_FAIL === undefined) delete process.env.TUT_HERDR_FAIL;
  else process.env.TUT_HERDR_FAIL = SAVED_FAIL;
  if (SAVED_REQUIRE_PANE_ID === undefined) delete process.env.TUT_HERDR_REQUIRE_PANE_ID;
  else process.env.TUT_HERDR_REQUIRE_PANE_ID = SAVED_REQUIRE_PANE_ID;
  if (SAVED_HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = SAVED_HERDR_PANE_ID;
  if (SAVED_LAG_POLLS === undefined) delete process.env.TUT_HERDR_LIST_LAG_POLLS;
  else process.env.TUT_HERDR_LIST_LAG_POLLS = SAVED_LAG_POLLS;
  if (SAVED_LAG_SET === undefined) delete process.env.TUT_HERDR_PANES_LAG;
  else process.env.TUT_HERDR_PANES_LAG = SAVED_LAG_SET;
  if (SAVED_WAIT === undefined) delete process.env.TUT_UP_HUB_WAIT_MS;
  else process.env.TUT_UP_HUB_WAIT_MS = SAVED_WAIT;
  if (SAVED_NOTIFY_WAIT === undefined) delete process.env.TUT_UP_NOTIFY_WAIT_MS;
  else process.env.TUT_UP_NOTIFY_WAIT_MS = SAVED_NOTIFY_WAIT;
  if (SAVED_SELF === undefined) delete process.env.TUT_UP_CLI_SELF;
  else process.env.TUT_UP_CLI_SELF = SAVED_SELF;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(hubRead).mockReset();
  for (const dir of TRASH.splice(0)) {
    // All success, timeout, early-return and dry-run paths release ownership.
    expect(existsSync(path.join(dir, ".context-hub/up.lock"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tut up (parse)", () => {
  it("no args, --dry-run boolean only", () => {
    expect(parseArgs(["up"])).toEqual({ command: "up", dryRun: false });
    expect(parseArgs(["up", "--dry-run"])).toEqual({ command: "up", dryRun: true });
  });

  it("positionals and unknown flags rejected", () => {
    expect(parseArgs(["up", "extra"]).command).toBe("usage");
    expect(parseArgs(["up", "--nope"]).command).toBe("usage");
  });
});

describe("tut up (behavior)", () => {
  it("cwd guardrail: refuses in a bare directory before any probe or spawn", async () => {
    const io = captureIo();
    try {
      const bare = mkdtempSync(path.join(os.tmpdir(), "tut-up-bare-"));
      TRASH.push(bare);
      process.env.TUT_UP_CLI_SELF = path.join(REPO, "dist", "cli.js"); // pass the src-layout guard
      process.chdir(bare);
      const fetchMock = stubFetch(() => refused());

      const code = await runUp(["up"]);

      expect(code).toBe(1);
      // The remediation is concrete (tut init onboards — the missing piece
      // is the layout marker, not the directory), never the old misleading
      // "run from project root" alone.
      expect(io.err()).toContain("no package.json or .context-hub/");
      expect(io.err()).toContain("tut init");
      expect(io.err()).not.toContain("run tut up from the project root");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      io.restore();
    }
  });

  it("workspace-lineup hint: L1 and L2 both missing → prints the migration pointer (never a write)", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, []);
    process.chdir(project);
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.env.TUT_USER_CONFIG_DIR = path.join(project, "empty-l2"); // hermetic: no user-level file
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);

      expect(code).toBe(0);
      expect(io.out()).toContain("up: no workspace lineup config found");
      expect(io.out()).toContain("using built-in defaults (architect=codex, executor=pi, reviewer=codex)");
      // Light path first: tut assign is the primary customization hint,
      // the full cp comes after it (the advanced route).
      const out = io.out();
      const assignIdx = out.indexOf("to customize: tut assign <role> <agent>");
      const cpIdx = out.indexOf(`cp ${path.join(REPO, "scripts", "workspace.json")} ${path.join(project, ".context-hub", "workspace.json")}`);
      expect(assignIdx).toBeGreaterThanOrEqual(0);
      expect(cpIdx).toBeGreaterThan(assignIdx);
      expect(existsSync(path.join(project, ".context-hub", "workspace.json"))).toBe(false); // a hint, never a write
    } finally {
      io.restore();
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
    }
  });

  it("workspace-lineup hint: project-level config present → silent", async () => {
    const { project, logPath } = makeProject(false); // .context-hub/ exists, no package.json needed
    writeFileSync(
      path.join(project, ".context-hub", "workspace.json"),
      `${JSON.stringify({ roles: { executor: { agent: "pi" } } })}\n`,
      "utf8",
    );
    useFixtureHerdr(logPath, []);
    process.chdir(project);
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.env.TUT_USER_CONFIG_DIR = path.join(project, "empty-l2");
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);

      expect(code).toBe(0);
      expect(io.out()).not.toContain("no workspace lineup config found");
    } finally {
      io.restore();
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
    }
  });

  it("dev-layout guard: self under src/ exits 1 before any probe, spawn, or pane read", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath);
    process.env.TUT_UP_CLI_SELF = path.join(project, "src", "cli.ts");
    process.chdir(project);
    const fetchMock = stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("running from src layout");
      expect(io.err()).toContain("npm run build");
      expect(io.err()).toContain("dist/cli.js is the provision target");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logLines(logPath)).toEqual([]); // herdr pane list never ran either
    } finally {
      io.restore();
    }
  });

  it("provisions hub+notify into the tut-sys tab: split → tab create → move --ratio 0.5 → close root → rename → run", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "FIX:p0", label: "exec" }]);
    process.chdir(project);
    stubFetch(logAwareProbes(logPath));
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      const splitLine = serviceFixture(`pane split --current --direction right --no-focus --cwd ${project}`);
      expect(logLines(logPath)).toEqual([
        "pane list",
        splitLine,
        `tab create --label tut-sys --no-focus --cwd ${project}`,
        "pane move FIX:p1 --tab FIX:t1 --split down --ratio 0.5 --no-focus",
        "pane close FIX:root1", // tab create ships an empty root — cleaned up
        scopedFixture("pane rename FIX:p1 tut-hub", fixtureRoot),
        serviceFixture(`pane run FIX:p1 cd ${project} && node ${self} serve`),
        "pane list", // report-time id resolution (fresh by-label lookup)
        splitLine,
        // second sys pane splits the hub pane explicitly — even halves, no
        // reliance on move's default target semantics
        "pane move FIX:p2 --tab FIX:t1 --split down --ratio 0.5 --no-focus --target-pane FIX:p1",
        scopedFixture("pane rename FIX:p2 tut-notify", fixtureRoot),
        serviceFixture(`pane run FIX:p2 cd ${project} && node ${self} notify`),
        "pane list", // report-time id resolution
        "pane list", // final uniqueness check
      ]);
      expect(io.out()).toContain("up: hub serving on http://127.0.0.1:3001 (pane FIX:p1, tab tut-sys");
      expect(io.out()).toContain("up: notify running (pane FIX:p2, tab tut-sys)");
      // Role panes are never provisioned here — even with a preset 'exec'
      // pane and all agents on PATH, the loop is gone; the on-demand note fires.
      expect(io.out()).toContain("up: agent panes are on-demand — launchers raise them at hand-off");
    } finally {
      io.restore();
    }
  });

  it("pane id in the success report comes from a fresh by-label lookup (split-time ids go stale on a move)", async () => {
    // Pane ids are window-scoped: moving the split pane into the sys tab's
    // window re-addresses it. Scripted with list lag — the entry snapshot
    // (list #1) shows no sys panes so provisioning runs fresh, while later
    // lists serve the pane under its POST-MOVE id with the label applied.
    // The success report must carry the CURRENT id, not the split-time one.
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w1H:p2", label: scopedFixture("tut-hub", fixtureRoot), tab_id: "w1H" }]);
    process.env.TUT_HERDR_LIST_LAG_POLLS = "1";
    process.env.TUT_HERDR_PANES_LAG = "[]";
    process.chdir(project);
    stubFetch(logAwareProbes(logPath));
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(io.out()).toContain("up: hub serving on http://127.0.0.1:3001 (pane w1H:p2, tab tut-sys");
      expect(io.out()).not.toContain("pane FIX:p1, tab tut-sys"); // the stale split-time id is gone
      // The fresh lookup was real: a second pane list call sits after the
      // provisioning sequence.
      const lines = logLines(logPath);
      expect(lines.filter((l) => l === "pane list").length).toBeGreaterThanOrEqual(2);
    } finally {
      io.restore();
    }
  });

  it("herdrPaneList extracts the optional tab_id (sys-pane discovery off pane list alone)", async () => {
    const { logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w5:p1", label: scopedFixture("tut-hub", fixtureRoot), tab_id: "w5:t2" },
      { pane_id: "w1:p0" },
    ]);
    try {
      const listing = await herdrPaneList();
      expect(listing).toEqual({
        panes: [
          { pane_id: "w5:p1", label: scopedFixture("tut-hub", fixtureRoot), tab_id: "w5:t2" },
          { pane_id: "w1:p0" },
        ],
      });
    } finally {
      // restore PATH/env is afterEach's job; nothing extra here
    }
  });

  it("dead sys pane reuse: labelled tut-hub pane reruns in place (no split/tab work); healthy notify side takes zero action", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w5:p1", label: scopedFixture("tut-hub", fixtureRoot), tab_id: "w5:t2" },
      { pane_id: "w6:p1", label: scopedFixture("tut-notify", fixtureRoot), tab_id: "w5:t2" },
      { pane_id: "w1:p0", label: "exec" },
    ]);
    process.chdir(project);
    // hub down until its pane reruns serve; notify probe healthy from the start
    stubFetch((url) =>
      url.includes(":3001/state")
        ? readLog(logPath).includes(" serve")
          ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }))
          : refused()
        : Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } })),
    );
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual([
        "pane list",
        serviceFixture(`pane run w5:p1 cd ${project} && node ${self} serve`),
        "pane list", // report-time id resolution (by label)
        "pane list", // final uniqueness check
      ]);
      expect(io.out()).toContain("up: hub serving on http://127.0.0.1:3001 (pane w5:p1, tab tut-sys, reused");
      expect(io.out()).toContain("up: notify already listening");
    } finally {
      io.restore();
    }
  });

  it("dead-pane reuse, mirror case: hub healthy, labelled tut-notify pane dead → rerun in place only", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w6:p1", label: scopedFixture("tut-notify", fixtureRoot), tab_id: "w6:t1" }]);
    process.chdir(project);
    // The reused pane's notifier must actually come up: the event probe is
    // log-aware (405 once the rerun is logged) — the success report waits
    // for the port to answer, a pane run alone is no longer enough.
    stubFetch((url) => {
      if (url.includes(":3001/state")) return Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }));
      if (url.includes(":3002/agent-event")) {
        return readLog(logPath).includes("pane run w6:p1")
          ? Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }))
          : refused();
      }
      return refused();
    });
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual([
        "pane list",
        serviceFixture(`pane run w6:p1 cd ${project} && node ${self} notify`),
        "pane list", // report-time id resolution (by label)
        "pane list", // final uniqueness check
      ]);
      expect(io.out()).toContain("up: hub already running");
      expect(io.out()).toContain("up: notify running (pane w6:p1, tab tut-sys, reused)");
    } finally {
      io.restore();
    }
  });

  it("notify joins an existing tut-sys tab: no tab create, no root close, move targets the hub pane", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w5:p1", label: scopedFixture("tut-hub", fixtureRoot), tab_id: "w5:t2" }]);
    process.chdir(project);
    // Log-aware event probe: the fresh pane's notifier binds once its run
    // line is logged (the success report is gated on the probe).
    stubFetch((url) => {
      if (url.includes(":3001/state")) return Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }));
      if (url.includes(":3002/agent-event")) {
        return readLog(logPath).includes("pane run FIX:p1")
          ? Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }))
          : refused();
      }
      return refused();
    });
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      const log = logLines(logPath);
      expect(log).toEqual([
        "pane list",
        serviceFixture(`pane split --current --direction right --no-focus --cwd ${project}`),
        "pane move FIX:p1 --tab w5:t2 --split down --ratio 0.5 --no-focus --target-pane w5:p1",
        scopedFixture("pane rename FIX:p1 tut-notify", fixtureRoot),
        serviceFixture(`pane run FIX:p1 cd ${project} && node ${self} notify`),
        "pane list", // report-time id resolution (by label)
        "pane list", // final uniqueness check
      ]);
      expect(log.filter((l) => l.startsWith("tab create") || l.startsWith("pane close")).length).toBe(0);
      expect(io.out()).toContain("up: hub already running");
      expect(io.out()).toContain("up: notify running (pane FIX:p1, tab tut-sys)");
    } finally {
      io.restore();
    }
  });

  it("move failure exits 1 with an orphan-pane cleanup hint (no rename/run after it)", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath);
    process.env.TUT_HERDR_FAIL = "pane:move";
    process.chdir(project);
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("could not move pane FIX:p1 into tab tut-sys");
      expect(io.err()).toContain("herdr pane close FIX:p1");
      expect(logLines(logPath)).toEqual([
        "pane list",
        serviceFixture(`pane split --current --direction right --no-focus --cwd ${project}`),
        `tab create --label tut-sys --no-focus --cwd ${project}`,
        "pane move FIX:p1 --tab FIX:t1 --split down --ratio 0.5 --no-focus",
      ]);
    } finally {
      io.restore();
    }
  });

  it("missing HERDR_PANE_ID explains the interactive-pane remedy after split failure", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath);
    delete process.env.HERDR_PANE_ID;
    process.env.TUT_HERDR_REQUIRE_PANE_ID = "1";
    process.chdir(project);
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("--current requires HERDR_PANE_ID");
      expect(io.err()).toContain("interactive Herdr pane");
      expect(io.err()).toContain("HERDR_PANE_ID");
      expect(io.err()).toContain("valid pane id");
      expect(io.err()).toContain("unset/empty");
      expect(logLines(logPath)).toEqual([
        "pane list",
        serviceFixture(`pane split --current --direction right --no-focus --cwd ${project}`),
      ]);
    } finally {
      io.restore();
    }
  });

  it("idempotent: hub + notify up → reads only, all skips, exit 0", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w8:p1", label: "arch" },
      { pane_id: "w7:p1", label: "exec" },
      { pane_id: "w9:p1", label: "review" },
    ]);
    process.chdir(project);
    stubFetch((url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }))
        : Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } })),
    );
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual(["pane list", "pane list"]); // initial snapshot + final uniqueness check
      expect(io.out()).toContain("up: hub already running");
      expect(io.out()).toContain("up: notify already listening");
      expect(io.out()).toContain("up: agent panes are on-demand");
      // Tail activation block (final wording): pure intent, no paths.
      expect(io.out()).toContain("up: activate a Host — tell any coding-agent session in this repo:");
      expect(io.out()).toContain("「担任 TUT Host，全程驱动这个任务：<你的需求>」");
      expect(io.out()).toContain("drive this task end to end");
    } finally {
      io.restore();
    }
  });

  it("--dry-run prints the full tut-sys provisioning plan (tab create/move/close/rename/run); nothing mutating", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath); // no preset panes → hub + notify down
    process.chdir(project);
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual(["pane list"]); // probes + list only, zero mutating calls
      const out = io.out();
      // hub plan: full sequence, tab created fresh → root close included
      expect(out).toContain(scopedFixture("up: [dry-run] would provision the tut-hub pane into tab tut-sys:", fixtureRoot));
      expect(out).toContain(serviceFixture(`up: [dry-run]   pane split --current --direction right --no-focus --cwd ${project}`));
      expect(out).toContain(`up: [dry-run]   tab create --label tut-sys --no-focus --cwd ${project}`);
      expect(out).toContain("up: [dry-run]   pane move <new-pane> --tab <new-tab> --split down --ratio 0.5 --no-focus");
      expect(out).toContain("up: [dry-run]   pane close <root-pane>");
      expect(out).toContain(scopedFixture("up: [dry-run]   pane rename <new-pane> tut-hub", fixtureRoot));
      expect(out).toContain(serviceFixture(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} serve`));
      // notify plan: tab now planned-known → no tab create/close, move targets the hub pane
      expect(out).toContain(scopedFixture("up: [dry-run] would provision the tut-notify pane into tab tut-sys:", fixtureRoot));
      expect(out).toContain(
        "up: [dry-run]   pane move <new-pane> --tab <new-tab> --split down --ratio 0.5 --no-focus --target-pane <tut-hub-pane>",
      );
      expect(out).toContain(scopedFixture("up: [dry-run]   pane rename <new-pane> tut-notify", fixtureRoot));
      expect(out).toContain(serviceFixture(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} notify`));
      // No role-pane actions, just the on-demand note.
      expect(out).toContain("up: agent panes are on-demand — launchers raise them at hand-off");
      // The activation block prints in dry-run too (ruling: --dry-run 同样打印).
      expect(out).toContain("up: activate a Host — tell any coding-agent session in this repo:");
      expect(out).toContain("「担任 TUT Host，全程驱动这个任务：<你的需求>」");
      expect(out).not.toContain("invariants seed"); // hub down → hint suppressed in dry-run
    } finally {
      io.restore();
    }
  });

  it("shape checks: 2xx /state without flow_mode+tasks and a non-405 event port both count as down", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath);
    process.chdir(project);
    stubFetch((url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ tasks: [] })) // 200 but not our hub's shape
        : Promise.resolve(new Response("no", { status: 404 })), // port answers, wrong service
    );
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);

      expect(code).toBe(0);
      expect(io.out()).toContain(serviceFixture(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} serve`));
      expect(io.out()).toContain(serviceFixture(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} notify`));
    } finally {
      io.restore();
    }
  });

  it("405 tighten: bare 405 without the Allow: POST feature counts as down — notify provisioning proceeds", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath);
    process.chdir(project);
    stubFetch((url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] })) // hub fine
        : Promise.resolve(new Response("no", { status: 405 })), // bare 405, no Allow header
    );
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);

      expect(code).toBe(0);
      expect(io.out()).not.toContain("notify already listening");
      expect(io.out()).toContain(serviceFixture(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} notify`));
    } finally {
      io.restore();
    }
  });

  it("without Herdr on PATH: prints the manual command list, exits 0, spawns nothing", async () => {
    const { project, logPath, self } = makeProject(false); // .context-hub/ alone satisfies the guardrail
    process.env.PATH = `${NODE_BIN_DIR}:/usr/bin:/bin`; // no fixture dir, no real herdr (/opt/homebrew/bin)
    process.env.TUT_HERDR_LOG = logPath;
    process.chdir(project);
    const fetchMock = stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(existsSync(logPath)).toBe(false); // herdr never ran → no log
      expect(fetchMock).toHaveBeenCalledTimes(2); // both probes still happened
      expect(io.out()).toContain("start manually");
      expect(io.out()).toContain(serviceFixture(`up:   cd ${project} && node ${self} serve`));
      expect(io.out()).toContain(serviceFixture(`up:   cd ${project} && node ${self} notify`));
      expect(io.out()).toContain("up: agent panes are on-demand");
      expect(io.out()).not.toContain("would split"); // not a dry-run — a degradation note
      expect(io.out()).not.toContain("invariants seed"); // hub down → no hint
    } finally {
      io.restore();
    }
  });

  it("up never provisions role panes — an agent missing from PATH is no longer up's business", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath); // herdr usable, no preset panes
    process.chdir(project);
    stubFetch((url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }))
        : Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } })),
    );
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(io.err()).not.toContain("not on PATH"); // no agent-PATH checks in up anymore
      expect(io.out()).toContain("up: agent panes are on-demand");
      // Only hub + notify pane ops ever ran (plus the initial list read).
      expect(logLines(logPath).filter((l) => l.startsWith("pane run")).length).toBe(0);
    } finally {
      io.restore();
    }
  });

  it("waits for /state after provisioning serve; staying unhealthy exits 1 before notify provisioning", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath);
    process.env.TUT_UP_HUB_WAIT_MS = "300"; // shorten the 10s default (per-call knob)
    process.chdir(project);
    stubFetch(() => refused()); // /state never turns healthy
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("stayed unhealthy for 300ms");
      const splitLine = serviceFixture(`pane split --current --direction right --no-focus --cwd ${project}`);
      expect(logLines(logPath)).toEqual([
        "pane list",
        splitLine,
        `tab create --label tut-sys --no-focus --cwd ${project}`,
        "pane move FIX:p1 --tab FIX:t1 --split down --ratio 0.5 --no-focus",
        "pane close FIX:root1",
        scopedFixture("pane rename FIX:p1 tut-hub", fixtureRoot),
        serviceFixture(`pane run FIX:p1 cd ${project} && node ${self} serve`),
      ]);
      expect(io.out()).not.toContain("notify"); // aborted before step 2
    } finally {
      io.restore();
    }
  });
});

describe("tut up invariants-seed hint", () => {
  /** Hub-healthy, notify-healthy probes (the idempotent scenario). */
  function healthyProbes(): (url: string) => Promise<Response> {
    return (url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }))
        : Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }));
  }

  it.each(["empty", "missing"])("%s project scope is explained once at startup, not on subsequent up calls", async (state) => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, []);
    process.chdir(project);
    stubFetch(logAwareProbes(logPath));
    if (state === "missing") {
      vi.mocked(hubRead).mockRejectedValue(new HubError("TASK_NOT_FOUND", "task not found: project"));
    } else {
      vi.mocked(hubRead).mockResolvedValue(projectRead([]));
    }
    const io = captureIo();
    try {
      expect(await runUp(["up"])).toBe(0);
      expect(io.out()).toContain("project scope is empty");
      expect(io.out()).toContain("this is normal");
      expect(io.out()).not.toContain("tut publish project");
      for (let round = 0; round < 3; round++) {
        expect(await runUp(["up"])).toBe(0);
      }
      expect(io.out().match(/project scope is empty/g)).toHaveLength(1);
      expect(hubRead).toHaveBeenCalledTimes(4);

      // Once records arrive, the existing seed guidance works again.
      vi.mocked(hubRead).mockResolvedValue(projectRead([projectNote("ADR", "append-only")]));
      expect(await runUp(["up"])).toBe(0);
      expect(io.out().match(/no invariants seed/g)).toHaveLength(1);
      vi.mocked(hubRead).mockResolvedValue(projectRead([projectNote("不变量", "记录永不删除")]));
      expect(await runUp(["up"])).toBe(0);
      expect(io.out().match(/no invariants seed/g)).toHaveLength(1);
      expect(io.out().match(/project scope is empty/g)).toHaveLength(1);
    } finally {
      io.restore();
    }
  });

  it("already-running services do not explain an empty scope", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, []);
    process.chdir(project);
    stubFetch(healthyProbes());
    const io = captureIo();
    try {
      expect(await runUp(["up"])).toBe(0);
      expect(io.out()).not.toContain("project scope is empty");
      expect(io.out()).not.toContain("invariants seed");
    } finally {
      io.restore();
    }
  });

  it("a project note mentioning 不变量 (summary or body) suppresses the hint", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w8:p1", label: "arch" },
      { pane_id: "w7:p1", label: "exec" },
      { pane_id: "w9:p1", label: "review" },
    ]);
    process.chdir(project);
    stubFetch(healthyProbes());
    vi.mocked(hubRead).mockResolvedValue(
      projectRead([projectNote("工作约定", "记录永不删除等不变量见 AGENTS.md")]),
    );
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(io.out()).not.toContain("invariants seed");
    } finally {
      io.restore();
    }
  });

  it("a project note whose payload never mentions 不变量 does NOT suppress the hint", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w8:p1", label: "arch" },
      { pane_id: "w7:p1", label: "exec" },
      { pane_id: "w9:p1", label: "review" },
    ]);
    process.chdir(project);
    stubFetch(healthyProbes());
    vi.mocked(hubRead).mockResolvedValue(projectRead([projectNote("ADR：append-only 日志", "状态由序列派生")]));
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(io.out()).toContain("no invariants seed");
      expect(io.out()).toContain("tut publish project --role human --content-type note");
      expect(io.out()).toContain("never auto-published");
      expect(io.out()).not.toContain("project scope is empty");
    } finally {
      io.restore();
    }
  });

  it("read failing for another reason stays silent (no nag, exit still 0)", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w8:p1", label: "arch" },
      { pane_id: "w7:p1", label: "exec" },
      { pane_id: "w9:p1", label: "review" },
    ]);
    process.chdir(project);
    stubFetch(healthyProbes());
    vi.mocked(hubRead).mockRejectedValue(new HubError("MCP error", "connection closed"));
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(0);
      expect(io.out()).not.toContain("invariants seed");
      expect(io.out()).not.toContain("project scope is empty");
    } finally {
      io.restore();
    }
  });

  it("--dry-run with the hub reachable prints the hint too (reads allowed); hub down prints nothing", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w8:p1", label: "arch" },
      { pane_id: "w7:p1", label: "exec" },
      { pane_id: "w9:p1", label: "review" },
    ]);
    process.chdir(project);
    stubFetch((url) => url.includes(":3001/state")
      ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] })) : refused());
    let io = captureIo();
    try {
      expect(await runUp(["up", "--dry-run"])).toBe(0);
      expect(io.out()).toContain("project scope is empty");
    } finally {
      io.restore();
    }

    stubFetch(() => refused());
    io = captureIo();
    try {
      expect(await runUp(["up", "--dry-run"])).toBe(0);
      expect(io.out()).not.toContain("invariants seed");
      expect(vi.mocked(hubRead).mock.calls.length).toBe(1); // only the reachable run read
    } finally {
      io.restore();
    }
  });
});

// --- tut up --url (non-default local hub) ------------------------------------------
// --url retargets the whole provisioning: probes, serve --port, the health
// wait and the seed check. Byte-identical behavior when the flag is absent is
// pinned by every test above (exact command strings, default 3001).

describe("tut up --url (non-default local hub)", () => {
  it("rejects a non-loopback --url before any probe, spawn, or pane read", async () => {
    const { project } = makeProject(true);
    process.env.PATH = `${NODE_BIN_DIR}:/usr/bin:/bin`; // no herdr, no agents
    process.chdir(project);
    const fetchMock = stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--url", "http://example.com:3001"]);

      expect(code).toBe(1);
      // The example must NOT teach the event port (3002) — it used to.
      expect(io.err()).toContain(
        "--url must be an http loopback URL with an explicit port (e.g. http://127.0.0.1:3003), got: http://example.com:3001",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      io.restore();
    }
  });

  it("rejects a loopback --url without an explicit port (serve needs a concrete port)", async () => {
    const { project } = makeProject(true);
    process.env.PATH = `${NODE_BIN_DIR}:/usr/bin:/bin`;
    process.chdir(project);
    const fetchMock = stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--url", "http://127.0.0.1"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("--url must be an http loopback URL with an explicit port");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      io.restore();
    }
  });

  it("dry-run: probes hit the override url and the printed commands carry --port/--url", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath); // no preset panes → everything down, dry-run lists actions
    process.chdir(project);
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return refused();
    });
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run", "--url", "http://127.0.0.1:3101"]);

      expect(code).toBe(0);
      // The probe went to the override hub, never to the default 3001.
      expect(seen).toContain("http://127.0.0.1:3101/state");
      expect(seen.some((u) => u.startsWith("http://127.0.0.1:3001"))).toBe(false);
      // Printed pane commands target the override: serve binds the parsed
      // port, notify polls the override url.
      expect(io.out()).toContain(serviceFixture(`pane run <new-pane> cd ${project} && node ${self} serve --port 3101`));
      expect(io.out()).toContain(serviceFixture(`pane run <new-pane> cd ${project} && node ${self} notify --url http://127.0.0.1:3101`));
      expect(io.out()).not.toContain("serve --port 3001");
      expect(logLines(logPath)).toEqual(["pane list"]); // reads only, nothing mutated
    } finally {
      io.restore();
    }
  });

  it("healthy hub at the override url: already-running echo, seed hint carries --url, nothing provisioned", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w1:p1", label: "arch" },
      { pane_id: "w1:p2", label: "exec" },
      { pane_id: "w1:p3", label: "review" },
    ]);
    process.chdir(project);
    vi.mocked(hubRead).mockResolvedValue(projectRead([projectNote("ADR", "append-only")]));
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes(":3101/state")) {
        return Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }));
      }
      if (url.includes(":3002/agent-event")) {
        return Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }));
      }
      return refused();
    });
    const io = captureIo();
    try {
      const code = await runUp(["up", "--url", "http://127.0.0.1:3101"]);

      expect(code).toBe(0);
      expect(io.out()).toContain("up: hub already running (http://127.0.0.1:3101/state)");
      expect(io.out()).toContain("up: notify already listening");
      // Seed hint (hubRead mocked to an unseeded project scope) targets the
      // same hub: the printed publish command carries --url.
      expect(io.out()).toContain("no invariants seed");
      expect(io.out()).toContain(`--url http://127.0.0.1:3101`);
      expect(io.out()).not.toContain("would split");
      expect(seen.some((u) => u.startsWith("http://127.0.0.1:3001"))).toBe(false);
      expect(logLines(logPath)).toEqual(["pane list", "pane list"]); // initial snapshot + final uniqueness check
    } finally {
      io.restore();
    }
  });
});


// --- shell dialect renderer integration (unit 6) --------------------------------------
// The service commands are PaneCommands now: POSIX keeps the legacy bytes
// (pinned above, unchanged), PowerShell dialects never see &&, cmd picks the
// safe direct form or the encoded pane-runner, and a bad TUT_PANE_SHELL
// fails the whole up run before any probe.

describe("up service commands through the pane dialect renderer", () => {
  const SAVED_PANE_SHELL = process.env.TUT_PANE_SHELL;

  afterEach(() => {
    if (SAVED_PANE_SHELL === undefined) delete process.env.TUT_PANE_SHELL;
    else process.env.TUT_PANE_SHELL = SAVED_PANE_SHELL;
    vi.unstubAllGlobals();
  });

  it("TUT_PANE_SHELL=powershell5: pane run carries the script-block form — no && anywhere", async () => {
    const { project, logPath, self } = makeProject(true);
    process.chdir(project);
    useFixtureHerdr(logPath);
    process.env.TUT_PANE_SHELL = "powershell5";
    stubFetch((url) => (url.includes("/state") || url.includes("/agent-event") ? refused() : refused()));
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);
      expect(code).toBe(0);
      const run = logLines(logPath).find((l) => l.startsWith("pane run"));
      expect(run).toBeUndefined(); // dry-run logs no pane run; assert on the preview text
      const out = io.out();
      const serveLine = out.split("\n").find((l) => l.includes("pane run"));
      expect(serveLine).toBeDefined();
      expect(serveLine).toContain("pane-runner.js");
      expect(serveLine).not.toContain("&&");
      const token = /--payload '([A-Za-z0-9_-]+)'/u.exec(serveLine ?? "")?.[1] ?? "";
      expect(JSON.parse(Buffer.from(token, "base64url").toString("utf8"))).toMatchObject({ cwd: project, args: [self, "serve"], env: { TUT_HUB_URL: fixtureHub, TUT_EVENT_PORT_URL: fixtureEvent } });
    } finally {
      io.restore();
      process.chdir(SAVED_CWD);
    }
  });

  it("TUT_PANE_SHELL=cmd: safe project cwd takes the cd /d direct form", async () => {
    const { project, logPath, self } = makeProject(true);
    process.chdir(project);
    useFixtureHerdr(logPath);
    process.env.TUT_PANE_SHELL = "cmd";
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);
      expect(code).toBe(0);
      const serveLine = io.out().split("\n").find((l) => l.includes("pane run"));
      expect(serveLine).toContain("pane-runner.js");
      const token = /--payload "([A-Za-z0-9_-]+)"/u.exec(serveLine ?? "")?.[1] ?? "";
      expect(JSON.parse(Buffer.from(token, "base64url").toString("utf8"))).toMatchObject({ cwd: project, args: [self, "serve"], env: { TUT_HUB_URL: fixtureHub, TUT_EVENT_PORT_URL: fixtureEvent } });
    } finally {
      io.restore();
      process.chdir(SAVED_CWD);
    }
  });

  it("TUT_PANE_SHELL=cmd with an unsafe cwd (% in path) switches to the encoded runner", async () => {
    // A project dir containing % : cmd must never see it unencoded.
    const base = mkdtempSync(path.join(os.tmpdir(), "tut-up-100%25-"));
    const project = realpathSync(base);
    TRASH.push(base);
    writeFileSync(path.join(base, "package.json"), '{"name":"up-cmd-enc"}\n', "utf8");
    const self = path.join(project, "dist", "cli.js");
    process.env.TUT_UP_CLI_SELF = self;
    process.chdir(project);
    const logPath = path.join(project, "herdr.log");
    useFixtureHerdr(logPath);
    process.env.TUT_PANE_SHELL = "cmd";
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);
      expect(code).toBe(0);
      // "serve" lives only inside the payload token now — take the first
      // pane-run preview line (serve) by position, not by content.
      const serveLine = io.out().split("\n").find((l) => l.includes("pane run"));
      expect(serveLine).toBeDefined();
      expect(serveLine).not.toContain("cd /d");
      expect(serveLine).toMatch(/--payload "[A-Za-z0-9_-]+"/u);
      const token = /--payload "([A-Za-z0-9_-]+)"/u.exec(serveLine ?? "")?.[1] ?? "";
      const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(payload.cwd).toBe(project); // the % lives only inside the payload
      expect(payload.purpose).toBe("service");
      expect(payload.args).toEqual([self, "serve"]);
    } finally {
      io.restore();
      process.chdir(SAVED_CWD);
    }
  });

  it("an unknown TUT_PANE_SHELL fails the run before any herdr probe", async () => {
    const { project, logPath } = makeProject(true);
    process.chdir(project);
    useFixtureHerdr(logPath);
    process.env.TUT_PANE_SHELL = "csh";
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);
      expect(code).toBe(1);
      expect(io.err()).toContain("TUT_PANE_SHELL 'csh'");
      expect(logLines(logPath)).toEqual([]); // not even pane list ran
    } finally {
      io.restore();
      process.chdir(SAVED_CWD);
    }
  });
});

// --- up --event-port -------------------------------------------------------------
// The event port is one value across the whole up chain: the probe, the
// rendered notify command, and the collision pre-check all derive from it.
// Default flags keep the byte-pinned legacy commands (every test above).

describe("tut up --event-port (parse)", () => {
  it("absent stays undefined; both flag forms parse; non-integers rejected", () => {
    expect(parseArgs(["up"])).toEqual({ command: "up", dryRun: false });
    expect(parseArgs(["up", "--event-port", "3105"])).toEqual({ command: "up", dryRun: false, eventPort: 3105 });
    expect(parseArgs(["up", "--event-port=3105", "--dry-run"])).toEqual({ command: "up", dryRun: true, eventPort: 3105 });
    expect(parseArgs(["up", "--event-port", "notaport"]).command).toBe("usage");
  });
});

describe("up port-conflict pre-check", () => {
  it("up --url :3002 (the old broken example) is refused before any probe or spawn", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath);
    process.chdir(project);
    const fetchMock = stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--url", "http://127.0.0.1:3002"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("the hub port and the notifier event port are both 3002");
      expect(io.err()).toContain("notify would die with EADDRINUSE");
      // Correct examples, none of which collides with the event port.
      expect(io.err()).toContain("--url http://127.0.0.1:3011");
      expect(io.err()).toContain("--event-port 3005");
      expect(fetchMock).not.toHaveBeenCalled(); // pre-check, not post-mortem
      expect(logLines(logPath)).toEqual([]); // no pane read either
    } finally {
      io.restore();
    }
  });

  it("matrix: --event-port equal to the hub port is refused from either side", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath);
    process.chdir(project);
    const fetchMock = stubFetch(() => refused());
    let io = captureIo();
    try {
      // default hub 3001, event port moved ONTO it
      let code = await runUp(["up", "--event-port", "3001"]);
      expect(code).toBe(1);
      expect(io.err()).toContain("the hub port and the notifier event port are both 3001");
      io.restore();

      io = captureIo();
      // both explicitly equal
      code = await runUp(["up", "--url", "http://127.0.0.1:3003", "--event-port", "3003"]);
      expect(code).toBe(1);
      expect(io.err()).toContain("the hub port and the notifier event port are both 3003");
      io.restore();

      io = captureIo();
      // a DIFFERENT event port with the collision-url passes the pre-check
      // (proceeds to the normal dry-run path — exit 0, no collision error)
      code = await runUp(["up", "--url", "http://127.0.0.1:3002", "--event-port", "3005", "--dry-run"]);
      expect(code).toBe(0);
      expect(io.err()).not.toContain("cannot share one port");
      // dry-run still probes: hub state + default event port (double-notifier
      // check) + the moved event port.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      io.restore();
    }
  });
});

describe("up --event-port full chain (render/probe same source)", () => {
  it("dry-run: the probe hits the moved port and the notify command carries --event-port + TUT_EVENT_PORT_URL", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath); // no preset panes → everything down, dry-run lists actions
    process.chdir(project);
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return refused();
    });
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run", "--event-port", "3105"]);

      expect(code).toBe(0);
      // Probes: the moved port is the provisioning target; the default port
      // is probed exactly once — the double-notifier coexistence check.
      expect(seen.filter((u) => u.endsWith("/agent-event"))).toEqual([
        "http://127.0.0.1:3002/agent-event", // coexistence check (refused → no warning)
        "http://127.0.0.1:3105/agent-event", // the actual provisioning probe
      ]);
      // Rendered command: the port rides the notify command explicitly and
      // TUT_EVENT_PORT_URL is exported into the pane (launchers the notifier
      // spawns escalate to the port it actually listens on). serve untouched.
      expect(io.out()).toContain(
        serviceFixture(`pane run <new-pane> cd ${project} && TUT_EVENT_PORT_URL=http://127.0.0.1:3105/agent-event node ${self} notify --event-port 3105`),
      );
      expect(io.out()).toContain(serviceFixture(`pane run <new-pane> cd ${project} && node ${self} serve`));
    } finally {
      io.restore();
    }
  });

  it("healthy notifier on the moved port: already-listening echo names it, nothing provisioned", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w1:p1", label: scopedFixture("tut-hub", fixtureRoot), tab_id: "w1:t1" }]);
    process.chdir(project);
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes(":3001/state")) return Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }));
      if (url.includes(":3105/agent-event")) {
        return Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }));
      }
      return refused(); // the default event port is DOWN → no double-notifier noise
    });
    const io = captureIo();
    try {
      const code = await runUp(["up", "--event-port", "3105"]);

      expect(code).toBe(0);
      expect(io.out()).toContain("up: hub already running (http://127.0.0.1:3001/state)");
      expect(io.out()).toContain("up: notify already listening (http://127.0.0.1:3105/agent-event)");
      expect(seen.some((u) => u.includes(":3105/agent-event"))).toBe(true); // probed the moved port
      expect(logLines(logPath)).toEqual(["pane list", "pane list"]); // initial snapshot + final uniqueness check
    } finally {
      io.restore();
    }
  });

  it("another rig on the default event port does not block or warn on fresh provisioning", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath); // no preset panes → notify provisioning plans
    process.chdir(project);
    stubFetch((url) => {
      if (url.includes(":3001/state")) return Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }));
      if (url.includes(":3002/agent-event")) {
        return Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }));
      }
      return refused(); // :3105 is down → provisioning proceeds there
    });
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run", "--event-port", "3105"]);

      expect(code).toBe(0);
      expect(io.err()).not.toContain("another notifier");
      // Non-blocking: the moved-port plan still prints.
      expect(io.out()).toContain(`node ${self} notify --event-port 3105`);
    } finally {
      io.restore();
    }
  });

  it("default flags retain default ports with explicit rig environment", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath);
    process.chdir(project);
    stubFetch(() => refused());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run"]);

      expect(code).toBe(0);
      const out = io.out();
      expect(out).toContain(serviceFixture(`pane run <new-pane> cd ${project} && node ${self} serve`));
      expect(out).toContain(serviceFixture(`pane run <new-pane> cd ${project} && node ${self} notify`));
      expect(out).not.toContain("--event-port");
      expect(out).toContain("TUT_EVENT_PORT_URL=http://127.0.0.1:3002/agent-event");
    } finally {
      io.restore();
    }
  });
});

// --- up occupied notify pane -----------------------------------------------------
// The review's live fixture: tut-hub/tut-notify panes exist, the default
// event port answers 405 (old notifier alive in the labelled pane), the
// moved port refuses. provisionSysPane used to take the labelled pane for
// dead, `pane run` into the occupied pane (swallowed by the foreground
// notifier), and report "notify running" + exit 0 — false success. Guards:
// the pre-flight refuses the known-occupied shape without any pane run; the
// post-run probe gates every success report (spawn ok ≠ listening).

describe("up occupied notify pane", () => {
  /** The review fixture: sys panes present, old notifier alive on 3002, 3105 down. */
  const OCCUPIED_FIXTURE = [
    { pane_id: "w1:p1", label: scopedFixture("tut-hub", fixtureRoot), tab_id: "w1:t1" },
    { pane_id: "w6:p1", label: scopedFixture("tut-notify", fixtureRoot), tab_id: "w1:t1" },
  ];

  function occupiedProbes(): (url: string) => Promise<Response> {
    return (url) => {
      if (url.includes(":3001/state")) return Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }));
      if (url.includes(":3002/agent-event")) {
        return Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }));
      }
      return refused(); // the moved port is down
    };
  }

  it("occupied reuse refused: no pane run at all, exit 1, actionable stop-first remedy", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, OCCUPIED_FIXTURE);
    process.chdir(project);
    stubFetch(occupiedProbes());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--event-port", "3105"]);

      expect(code).toBe(1);
      // Refused WITHOUT any pane mutation — not even the hub step ran (fail fast).
      expect(logLines(logPath)).toEqual(["pane list"]);
      expect(io.err()).toContain("cannot start the notifier on http://127.0.0.1:3105/agent-event");
      expect(io.err()).toContain("still listening on http://127.0.0.1:3002/agent-event");
      expect(io.err()).toContain("herdr pane close w6:p1"); // the exact reuse-candidate pane
      expect(io.err()).toContain("drop --event-port");
      expect(io.err()).toContain("rerun tut up");
      expect(io.out()).not.toContain("notify running");
      expect(io.out()).not.toContain("hub already running"); // nothing provisioned, nothing echoed past the refusal
    } finally {
      io.restore();
    }
  });

  it("the same occupied fixture under --dry-run refuses identically (the plan could not execute)", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, OCCUPIED_FIXTURE);
    process.chdir(project);
    stubFetch(occupiedProbes());
    const io = captureIo();
    try {
      const code = await runUp(["up", "--dry-run", "--event-port", "3105"]);

      expect(code).toBe(1);
      expect(logLines(logPath)).toEqual(["pane list"]);
      expect(io.err()).toContain("cannot start the notifier on http://127.0.0.1:3105/agent-event");
      // The misleading "would reuse pane" plan is gone — dry-run predicts the refusal.
      expect(io.out()).not.toContain("would reuse pane w6:p1");
      expect(io.out()).not.toContain("notify");
    } finally {
      io.restore();
    }
  });

  it("no over-fire: the moved port already answering → warning + already-listening echo, exit 0", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, OCCUPIED_FIXTURE);
    process.chdir(project);
    stubFetch((url) => {
      if (url.includes(":3001/state")) return Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }));
      if (url.includes(":3002/agent-event") || url.includes(":3105/agent-event")) {
        return Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }));
      }
      return refused();
    });
    const io = captureIo();
    try {
      const code = await runUp(["up", "--event-port", "3105"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual(["pane list", "pane list"]); // initial snapshot + final uniqueness check
      expect(io.out()).toContain("up: hub already running (http://127.0.0.1:3001/state)");
      expect(io.out()).toContain("up: notify already listening (http://127.0.0.1:3105/agent-event)");
      expect(io.err()).toContain("another notifier is already listening on http://127.0.0.1:3002/agent-event");
      expect(io.err()).not.toContain("cannot start the notifier");
    } finally {
      io.restore();
    }
  });

  it("reused pane that never binds: 'ran but never answered' failure instead of false success", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w6:p1", label: scopedFixture("tut-notify", fixtureRoot), tab_id: "w6:t1" }]);
    process.env.TUT_UP_NOTIFY_WAIT_MS = "300"; // shorten the 10s default (per-call knob)
    process.chdir(project);
    // The event port never answers — the pane is occupied or the notifier
    // died; either way `pane run` "succeeded" without a listener.
    stubFetch((url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }))
        : refused(),
    );
    const io = captureIo();
    try {
      const code = await runUp(["up"]);

      expect(code).toBe(1);
      expect(logLines(logPath)).toEqual([
        "pane list",
        serviceFixture(`pane run w6:p1 cd ${project} && node ${self} notify`),
      ]);
      expect(io.err()).toContain("notify pane w6:p1 ran but http://127.0.0.1:3002/agent-event never answered");
      expect(io.err()).toContain("occupied");
      expect(io.err()).toContain("herdr pane close w6:p1");
      expect(io.out()).not.toContain("notify running");
    } finally {
      io.restore();
    }
  });

  it("moved-port reuse into an undetectably occupied pane: the probe gate catches it, exit 1", async () => {
    // Nothing answers on the default port — the pre-flight cannot know the
    // pane is occupied (e.g. the old notifier runs on yet another port). The
    // post-run probe is the backstop: the run is swallowed, the moved port
    // never answers → failure, never "notify running".
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w6:p1", label: scopedFixture("tut-notify", fixtureRoot), tab_id: "w6:t1" }]);
    process.env.TUT_UP_NOTIFY_WAIT_MS = "300";
    process.chdir(project);
    stubFetch((url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }))
        : refused(), // 3002 AND the moved 3105 never answer
    );
    const io = captureIo();
    try {
      const code = await runUp(["up", "--event-port", "3105"]);

      expect(code).toBe(1);
      expect(logLines(logPath)).toEqual([
        "pane list",
        serviceFixture(`pane run w6:p1 cd ${project} && TUT_EVENT_PORT_URL=http://127.0.0.1:3105/agent-event node ${self} notify --event-port 3105`),
      ]);
      expect(io.err()).toContain("notify pane w6:p1 ran but http://127.0.0.1:3105/agent-event never answered");
      expect(io.err()).not.toContain("cannot start the notifier"); // pre-flight stayed silent (nothing on 3002)
      expect(io.out()).not.toContain("notify running");
    } finally {
      io.restore();
    }
  });

  it("moved-port fresh provisioning is verified by the event-port probe before success", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w5:p1", label: scopedFixture("tut-hub", fixtureRoot), tab_id: "w5:t2" }]);
    process.chdir(project);
    stubFetch((url) => {
      if (url.includes(":3001/state")) return Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }));
      if (url.includes(":3105/agent-event")) {
        // the fresh pane's notifier binds once its command ran
        return readLog(logPath).includes(" notify --event-port 3105")
          ? Promise.resolve(new Response("no", { status: 405, headers: { Allow: "POST" } }))
          : refused();
      }
      return refused(); // default event port down → no coexistence warning
    });
    const io = captureIo();
    try {
      const code = await runUp(["up", "--event-port", "3105"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual([
        "pane list",
        serviceFixture(`pane split --current --direction right --no-focus --cwd ${project}`),
        "pane move FIX:p1 --tab w5:t2 --split down --ratio 0.5 --no-focus --target-pane w5:p1",
        scopedFixture("pane rename FIX:p1 tut-notify", fixtureRoot),
        serviceFixture(`pane run FIX:p1 cd ${project} && TUT_EVENT_PORT_URL=http://127.0.0.1:3105/agent-event node ${self} notify --event-port 3105`),
        "pane list", // report-time id resolution
        "pane list", // final uniqueness check
      ]);
      expect(io.out()).toContain("up: hub already running (http://127.0.0.1:3001/state)");
      expect(io.out()).toContain("up: notify running (pane FIX:p1, tab tut-sys)");
      expect(io.err()).not.toContain("another notifier");
    } finally {
      io.restore();
    }
  });
});

describe("up rig namespaces", () => {
  it("does not reuse another root's system panes in the same Herdr inventory", async () => {
    const first = makeProject(true);
    const second = makeProject(true);
    process.chdir(second.project);
    useFixtureHerdr(second.logPath);
    process.env.TUT_HERDR_PANES = JSON.stringify([
      { pane_id: "other-hub", label: scopedFixture("tut-hub", first.project), tab_id: "other-tab" },
      { pane_id: "other-notify", label: scopedFixture("tut-notify", first.project), tab_id: "other-tab" },
    ]);
    stubFetch(() => refused());
    const io = captureIo();
    try {
      expect(await runUp(["up", "--url", "http://127.0.0.1:3011", "--event-port", "3012", "--dry-run"])).toBe(0);
      expect(io.out()).toContain(scopedFixture("pane rename <new-pane> tut-hub", second.project));
      expect(io.out()).toContain(scopedFixture("pane rename <new-pane> tut-notify", second.project));
      expect(io.out()).not.toContain("reuse pane other-");
      expect(io.out()).not.toContain("--tab other-tab");
      expect(io.out()).toContain("TUT_HUB_URL=http://127.0.0.1:3011");
      expect(io.out()).toContain("TUT_EVENT_PORT_URL=http://127.0.0.1:3012/agent-event");
    } finally { io.restore(); }
  });
});


describe("up final diagnostics", () => {
  it.each([false, true])("foreign startup lock: dry-run=%s skips final uniqueness diagnostics", async (dryRun) => {
    const { project, logPath } = makeProject(false);
    process.chdir(project);
    const label = scopedFixture("demo.executor", project);
    useFixtureHerdr(logPath, [
      { pane_id: "winner", label }, { pane_id: "loser", label },
    ]);
    // A real live process owns the lock; no process.kill or lock mocks.
    const owner = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdout.write('ready');"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(owner, "exit");
    const lock = path.join(project, ".context-hub/up.lock");
    const io = captureIo();
    try {
      await once(owner.stdout, "data");
      const record = JSON.stringify({ pid: owner.pid, started_at: new Date().toISOString() });
      writeFileSync(lock, record);
      const fetch = stubFetch(async (url) => url.includes("/state")
        ? responseJson({ flow_mode: "manual", tasks: [] })
        : new Response("", { status: 405, headers: { Allow: "POST" } }));
      expect(await runUp(dryRun ? ["up", "--dry-run"] : ["up"])).toBe(dryRun ? 0 : 1);
      expect(readFileSync(lock, "utf8")).toBe(record);
      expect(io.err()).not.toContain("duplicate pane label");
      expect(logLines(logPath)).toEqual(dryRun ? ["pane list"] : []);
      if (dryRun) {
        expect(io.err()).not.toContain("another up");
        expect(fetch).toHaveBeenCalled();
      } else {
        expect(io.err()).toContain(`another up (pid ${owner.pid})`);
        expect(io.err()).toContain(`if you confirm no other tut up instance is running, remove the lock file ${lock} and retry`);
        expect(fetch).not.toHaveBeenCalled();
      }
    } finally {
      io.restore();
      owner.stdin.end();
      await exited;
      rmSync(lock, { force: true });
    }
  });

  it.each(["tut-hub", "demo.executor"])("rejects duplicate %s labels appearing after the first snapshot", async (label) => {
    const { project, logPath } = makeProject(true);
    process.chdir(project);
    useFixtureHerdr(logPath, []);
    const scoped = scopedFixture(label, project);
    stubFetch(async (url) => {
      // The initial snapshot is already read before the service probes.
      process.env.TUT_HERDR_PANES = JSON.stringify([
        { pane_id: "winner", label: scoped }, { pane_id: "loser", label: scoped },
      ]);
      return url.includes("/state")
        ? responseJson({ flow_mode: "manual", tasks: [] })
        : new Response("", { status: 405, headers: { Allow: "POST" } });
    });
    const lockOwners: number[] = [];
    const io = captureIo((text) => {
      if (text.includes("duplicate pane label")) {
        lockOwners.push(JSON.parse(readFileSync(path.join(project, ".context-hub/up.lock"), "utf8")).pid);
      }
    });
    try {
      expect(await runUp(["up"])).toBe(1);
      expect(io.err()).toContain(`duplicate pane label ${scoped}: winner, loser`);
      expect(lockOwners).toEqual([process.pid]);
      expect(logLines(logPath)).toEqual(["pane list", "pane list"]);
      expect(io.out()).not.toContain("up: activate a Host");
      expect(existsSync(path.join(project, ".context-hub/up.lock"))).toBe(false);
    } finally { io.restore(); }
  });

  it("ignores other rigs' duplicate base-name labels in the final non-dry-run check", async () => {
    const other = makeProject(true);
    const { project, logPath } = makeProject(true);
    process.chdir(project);
    useFixtureHerdr(logPath, []);
    stubFetch(async (url) => {
      process.env.TUT_HERDR_PANES = JSON.stringify(
        ["tut-hub", "tut-notify", "demo.executor"].flatMap((label) => [
          { pane_id: `own-${label}`, label: scopedFixture(label, project) },
          { pane_id: `foreign-one-${label}`, label: scopedFixture(label, other.project) },
          { pane_id: `foreign-two-${label}`, label: scopedFixture(label, other.project) },
        ]),
      );
      return url.includes("/state")
        ? responseJson({ flow_mode: "manual", tasks: [] })
        : new Response("", { status: 405, headers: { Allow: "POST" } });
    });
    const io = captureIo();
    try {
      expect(await runUp(["up"])).toBe(0);
      expect(logLines(logPath)).toEqual(["pane list", "pane list"]);
      expect(io.err()).not.toContain("duplicate pane label");
      expect(io.out()).toContain("up: activate a Host");
      expect(existsSync(path.join(project, ".context-hub/up.lock"))).toBe(false);
    } finally { io.restore(); }
  });

  it("accepts an IPv6 loopback URL and prints the expected host relay label", async () => {
    const { project, logPath } = makeProject(true);
    process.chdir(project);
    useFixtureHerdr(logPath, []);
    stubFetch(async (url) => url.includes("/state")
      ? responseJson({ flow_mode: "manual", tasks: [] })
      : new Response("", { status: 405, headers: { Allow: "POST" } }));
    const io = captureIo();
    try {
      expect(await runUp(["up", "--url", "http://[::1]:3003"])).toBe(0);
      expect(io.err()).not.toContain("--url must be");
      expect(io.out()).toContain(`expected host relay label: ${scopedFixture("tut-hub", project).replace("tut-hub", "tut-host")}`);
    } finally { io.restore(); }
  });

  it("warns once when a new system tab has no workspace anchor", async () => {
    const { project, logPath } = makeProject(true);
    process.chdir(project);
    useFixtureHerdr(logPath, []);
    delete process.env.HERDR_PANE_ID;
    stubFetch(logAwareProbes(logPath));
    const io = captureIo();
    try {
      expect(await runUp(["up"])).toBe(0);
      expect(io.err().match(/workspace pinning unavailable/g)).toHaveLength(1);
    } finally { io.restore(); }
  });
});


it.each(["", "   ", "w1"])("handles system-tab workspace anchor %j", async (workspaceId) => {
  const { project, logPath } = makeProject(true);
  process.chdir(project);
  process.env.HERDR_PANE_ID = "anchor:p1";
  useFixtureHerdr(logPath, [{ pane_id: "anchor:p1", workspace_id: workspaceId }]);
  stubFetch(logAwareProbes(logPath));
  const io = captureIo();
  try {
    expect(await runUp(["up"])).toBe(0);
    const tabCreate = logLines(logPath).filter((line) => line.startsWith("tab create"));
    expect(tabCreate).toHaveLength(1);
    if (workspaceId === "w1") {
      expect(tabCreate[0]).toContain("--workspace w1");
      expect(io.err()).not.toContain("workspace pinning unavailable");
    } else {
      expect(tabCreate[0]).not.toContain("--workspace");
      expect(io.err().match(/workspace pinning unavailable/g)).toHaveLength(1);
    }
  } finally { io.restore(); }
});

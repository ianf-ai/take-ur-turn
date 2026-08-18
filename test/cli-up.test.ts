import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The seed hint reads the project scope through the hub-client layer; mock
// ONLY hubRead (the up handler's one hub-client call) so the hint branches are
// drivable without a live MCP endpoint — the same pattern as test/cli.test.ts.
vi.mock("../src/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub-client.js")>()),
  hubRead: vi.fn(),
}));

import { herdrPaneList, main, parseArgs } from "../src/cli.js";
import { hubRead, HubError, type HubReadResult } from "../src/hub-client.js";
import type { ContextRecord } from "../src/types.js";

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
const SAVED_WAIT = process.env.TUT_UP_HUB_WAIT_MS;
const SAVED_SELF = process.env.TUT_UP_CLI_SELF;
const TRASH: string[] = [];

function makeProject(withPackageJson: boolean): { project: string; logPath: string; self: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tut-up-"));
  TRASH.push(dir);
  if (withPackageJson) writeFileSync(path.join(dir, "package.json"), '{"name":"up-probe"}\n', "utf8");
  else mkdirSync(path.join(dir, ".context-hub"));
  // process.cwd() after chdir reports the REAL path (/private/var on macOS) —
  // every expected command string is built from cwd, so hand out the realpath.
  const project = realpathSync(dir);
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
  else process.env.TUT_HERDR_PANES = JSON.stringify(panes);
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

function responseJson(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status });
}

const refused = (): Promise<Response> => Promise.reject(new TypeError("fetch failed"));

/** Stub global fetch with a url-string dispatcher; returns the spy. */
function stubFetch(impl: (url: string) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown): Promise<Response> => impl(String(input)));
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
  if (SAVED_WAIT === undefined) delete process.env.TUT_UP_HUB_WAIT_MS;
  else process.env.TUT_UP_HUB_WAIT_MS = SAVED_WAIT;
  if (SAVED_SELF === undefined) delete process.env.TUT_UP_CLI_SELF;
  else process.env.TUT_UP_CLI_SELF = SAVED_SELF;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(hubRead).mockReset();
  for (const dir of TRASH.splice(0)) rmSync(dir, { recursive: true, force: true });
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

      const code = await main(["up"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("run tut up from the project root");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      io.restore();
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
      const code = await main(["up"]);

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
      const code = await main(["up"]);

      expect(code).toBe(0);
      const splitLine = `pane split --current --direction right --no-focus --cwd ${project}`;
      expect(logLines(logPath)).toEqual([
        "pane list",
        splitLine,
        `tab create --label tut-sys --no-focus --cwd ${project}`,
        "pane move FIX:p1 --tab FIX:t1 --split down --ratio 0.5 --no-focus",
        "pane close FIX:root1", // tab create ships an empty root — cleaned up
        "pane rename FIX:p1 tut-hub",
        `pane run FIX:p1 cd ${project} && node ${self} serve`,
        splitLine,
        // second sys pane splits the hub pane explicitly — even halves, no
        // reliance on move's default target semantics
        "pane move FIX:p2 --tab FIX:t1 --split down --ratio 0.5 --no-focus --target-pane FIX:p1",
        "pane rename FIX:p2 tut-notify",
        `pane run FIX:p2 cd ${project} && node ${self} notify`,
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

  it("herdrPaneList extracts the optional tab_id (sys-pane discovery off pane list alone)", async () => {
    const { logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w5:p1", label: "tut-hub", tab_id: "w5:t2" },
      { pane_id: "w1:p0" },
    ]);
    try {
      const listing = await herdrPaneList();
      expect(listing).toEqual({
        panes: [
          { pane_id: "w5:p1", label: "tut-hub", tab_id: "w5:t2" },
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
      { pane_id: "w5:p1", label: "tut-hub", tab_id: "w5:t2" },
      { pane_id: "w6:p1", label: "tut-notify", tab_id: "w5:t2" },
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
      const code = await main(["up"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual(["pane list", `pane run w5:p1 cd ${project} && node ${self} serve`]);
      expect(io.out()).toContain("up: hub serving on http://127.0.0.1:3001 (pane w5:p1, tab tut-sys, reused");
      expect(io.out()).toContain("up: notify already listening");
    } finally {
      io.restore();
    }
  });

  it("dead-pane reuse, mirror case: hub healthy, labelled tut-notify pane dead → rerun in place only", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w6:p1", label: "tut-notify", tab_id: "w6:t1" }]);
    process.chdir(project);
    stubFetch((url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }))
        : refused(),
    );
    const io = captureIo();
    try {
      const code = await main(["up"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual(["pane list", `pane run w6:p1 cd ${project} && node ${self} notify`]);
      expect(io.out()).toContain("up: hub already running");
      expect(io.out()).toContain("up: notify running (pane w6:p1, tab tut-sys, reused)");
    } finally {
      io.restore();
    }
  });

  it("notify joins an existing tut-sys tab: no tab create, no root close, move targets the hub pane", async () => {
    const { project, logPath, self } = makeProject(true);
    useFixtureHerdr(logPath, [{ pane_id: "w5:p1", label: "tut-hub", tab_id: "w5:t2" }]);
    process.chdir(project);
    stubFetch((url) =>
      url.includes(":3001/state")
        ? Promise.resolve(responseJson({ flow_mode: "manual", tasks: [] }))
        : refused(),
    );
    const io = captureIo();
    try {
      const code = await main(["up"]);

      expect(code).toBe(0);
      const log = logLines(logPath);
      expect(log).toEqual([
        "pane list",
        `pane split --current --direction right --no-focus --cwd ${project}`,
        "pane move FIX:p1 --tab w5:t2 --split down --ratio 0.5 --no-focus --target-pane w5:p1",
        "pane rename FIX:p1 tut-notify",
        `pane run FIX:p1 cd ${project} && node ${self} notify`,
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
      const code = await main(["up"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("could not move pane FIX:p1 into tab tut-sys");
      expect(io.err()).toContain("herdr pane close FIX:p1");
      expect(logLines(logPath)).toEqual([
        "pane list",
        `pane split --current --direction right --no-focus --cwd ${project}`,
        `tab create --label tut-sys --no-focus --cwd ${project}`,
        "pane move FIX:p1 --tab FIX:t1 --split down --ratio 0.5 --no-focus",
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
      const code = await main(["up"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual(["pane list"]); // the only herdr call is the read
      expect(io.out()).toContain("up: hub already running");
      expect(io.out()).toContain("up: notify already listening");
      expect(io.out()).toContain("up: agent panes are on-demand");
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
      const code = await main(["up", "--dry-run"]);

      expect(code).toBe(0);
      expect(logLines(logPath)).toEqual(["pane list"]); // probes + list only, zero mutating calls
      const out = io.out();
      // hub plan: full sequence, tab created fresh → root close included
      expect(out).toContain("up: [dry-run] would provision the tut-hub pane into tab tut-sys:");
      expect(out).toContain(`up: [dry-run]   pane split --current --direction right --no-focus --cwd ${project}`);
      expect(out).toContain(`up: [dry-run]   tab create --label tut-sys --no-focus --cwd ${project}`);
      expect(out).toContain("up: [dry-run]   pane move <new-pane> --tab <new-tab> --split down --ratio 0.5 --no-focus");
      expect(out).toContain("up: [dry-run]   pane close <root-pane>");
      expect(out).toContain("up: [dry-run]   pane rename <new-pane> tut-hub");
      expect(out).toContain(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} serve`);
      // notify plan: tab now planned-known → no tab create/close, move targets the hub pane
      expect(out).toContain("up: [dry-run] would provision the tut-notify pane into tab tut-sys:");
      expect(out).toContain(
        "up: [dry-run]   pane move <new-pane> --tab <new-tab> --split down --ratio 0.5 --no-focus --target-pane <tut-hub-pane>",
      );
      expect(out).toContain("up: [dry-run]   pane rename <new-pane> tut-notify");
      expect(out).toContain(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} notify`);
      // No role-pane actions, just the on-demand note.
      expect(out).toContain("up: agent panes are on-demand — launchers raise them at hand-off");
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
      const code = await main(["up", "--dry-run"]);

      expect(code).toBe(0);
      expect(io.out()).toContain(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} serve`);
      expect(io.out()).toContain(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} notify`);
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
      const code = await main(["up", "--dry-run"]);

      expect(code).toBe(0);
      expect(io.out()).not.toContain("notify already listening");
      expect(io.out()).toContain(`up: [dry-run]   pane run <new-pane> cd ${project} && node ${self} notify`);
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
      const code = await main(["up"]);

      expect(code).toBe(0);
      expect(existsSync(logPath)).toBe(false); // herdr never ran → no log
      expect(fetchMock).toHaveBeenCalledTimes(2); // both probes still happened
      expect(io.out()).toContain("start manually");
      expect(io.out()).toContain(`up:   cd ${project} && node ${self} serve`);
      expect(io.out()).toContain(`up:   cd ${project} && node ${self} notify`);
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
      const code = await main(["up"]);

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
      const code = await main(["up"]);

      expect(code).toBe(1);
      expect(io.err()).toContain("stayed unhealthy for 300ms");
      const splitLine = `pane split --current --direction right --no-focus --cwd ${project}`;
      expect(logLines(logPath)).toEqual([
        "pane list",
        splitLine,
        `tab create --label tut-sys --no-focus --cwd ${project}`,
        "pane move FIX:p1 --tab FIX:t1 --split down --ratio 0.5 --no-focus",
        "pane close FIX:root1",
        "pane rename FIX:p1 tut-hub",
        `pane run FIX:p1 cd ${project} && node ${self} serve`,
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

  it("hub reachable + empty project scope → prints the exact publish command as a hint", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w8:p1", label: "arch" },
      { pane_id: "w7:p1", label: "exec" },
      { pane_id: "w9:p1", label: "review" },
    ]);
    process.chdir(project);
    stubFetch(healthyProbes());
    vi.mocked(hubRead).mockResolvedValue(projectRead([]));
    const io = captureIo();
    try {
      const code = await main(["up"]);

      expect(code).toBe(0);
      expect(hubRead).toHaveBeenCalledWith("http://127.0.0.1:3001", "project");
      expect(io.out()).toContain("no invariants seed");
      expect(io.out()).toContain(
        "tut publish project --role human --content-type note --summary '不变量种子：记录永不删除；写入永不拒绝≠许可；预写答案的评测材料不入库'",
      );
      expect(io.out()).toContain("never auto-published");
    } finally {
      io.restore();
    }
  });

  it("fresh hub (project scope TASK_NOT_FOUND) also counts as unseeded → hint", async () => {
    const { project, logPath } = makeProject(true);
    useFixtureHerdr(logPath, [
      { pane_id: "w8:p1", label: "arch" },
      { pane_id: "w7:p1", label: "exec" },
      { pane_id: "w9:p1", label: "review" },
    ]);
    process.chdir(project);
    stubFetch(healthyProbes());
    vi.mocked(hubRead).mockRejectedValue(new HubError("TASK_NOT_FOUND", "task not found: project"));
    const io = captureIo();
    try {
      const code = await main(["up"]);

      expect(code).toBe(0);
      expect(io.out()).toContain("no invariants seed");
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
      const code = await main(["up"]);

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
      const code = await main(["up"]);

      expect(code).toBe(0);
      expect(io.out()).toContain("no invariants seed");
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
      const code = await main(["up"]);

      expect(code).toBe(0);
      expect(io.out()).not.toContain("invariants seed");
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
    stubFetch(healthyProbes());
    let io = captureIo();
    try {
      expect(await main(["up", "--dry-run"])).toBe(0);
      expect(io.out()).toContain("no invariants seed");
    } finally {
      io.restore();
    }

    stubFetch(() => refused());
    io = captureIo();
    try {
      expect(await main(["up", "--dry-run"])).toBe(0);
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
      const code = await main(["up", "--url", "http://example.com:3001"]);

      expect(code).toBe(1);
      expect(io.err()).toContain(
        "--url must be an http loopback URL with an explicit port (e.g. http://127.0.0.1:3002), got: http://example.com:3001",
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
      const code = await main(["up", "--url", "http://127.0.0.1"]);

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
      const code = await main(["up", "--dry-run", "--url", "http://127.0.0.1:3101"]);

      expect(code).toBe(0);
      // The probe went to the override hub, never to the default 3001.
      expect(seen).toContain("http://127.0.0.1:3101/state");
      expect(seen.some((u) => u.startsWith("http://127.0.0.1:3001"))).toBe(false);
      // Printed pane commands target the override: serve binds the parsed
      // port, notify polls the override url.
      expect(io.out()).toContain(`pane run <new-pane> cd ${project} && node ${self} serve --port 3101`);
      expect(io.out()).toContain(`pane run <new-pane> cd ${project} && node ${self} notify --url http://127.0.0.1:3101`);
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
      const code = await main(["up", "--url", "http://127.0.0.1:3101"]);

      expect(code).toBe(0);
      expect(io.out()).toContain("up: hub already running (http://127.0.0.1:3101/state)");
      expect(io.out()).toContain("up: notify already listening");
      // Seed hint (hubRead mocked to an unseeded project scope) targets the
      // same hub: the printed publish command carries --url.
      expect(io.out()).toContain("no invariants seed");
      expect(io.out()).toContain(`--url http://127.0.0.1:3101`);
      expect(io.out()).not.toContain("would split");
      expect(seen.some((u) => u.startsWith("http://127.0.0.1:3001"))).toBe(false);
      expect(logLines(logPath)).toEqual(["pane list"]); // all three role labels preset → skips only
    } finally {
      io.restore();
    }
  });
});

// start-next × launch_mode routing — the headless side of the switch, plus
// the discriminating tui-side cases, all against the REAL config-file read
// (nothing mocked here): explicit headless routes to the headless door;
// missing key, flow-mode-only config and explicit tui all keep the shipped
// manual pane chain (缺省=现状); a corrupt file fails closed. The tui side's
// behavioral breadth stays in test/cli-start-next.test.ts; this file pins
// that ONE switch selects between the two doors.
//
// The spawn leg is intercepted at startRun (vi.mock): the headless door's
// evidence is the runs/<id> reservation it creates plus the argv/env it
// hands down — no agent process is ever started.
vi.mock("../src/core/hub/rig-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/hub/rig-discovery.js")>()),
  resolveCliHubUrl: async (url: string) => url,
}));

vi.mock("../src/core/hub/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/hub/hub-client.js")>()),
  hubPublish: vi.fn(),
  hubRead: vi.fn(),
}));

vi.mock("../src/core/run/control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/run/control.js")>()),
  startRun: vi.fn(),
}));

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { HubError, hubPublish, hubRead } from "../src/core/hub/hub-client.js";
import { startRun } from "../src/core/run/control.js";
import * as preflight from "../src/core/preflight/index.js";
import type { AgentRoute, CheckoutRoute, ContextRecord } from "../src/core/common/types.js";

interface StateTask {
  task_id: string;
  status: string;
  waiting_for: string;
  needs_attention?: boolean;
  version?: number;
  title?: string;
  cast?: Record<string, AgentRoute>;
  checkout?: CheckoutRoute;
}

function stubState(tasks: StateTask[]): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      requested.push(typeof input === "string" ? input : String(input));
      return { ok: true, status: 200, json: async () => ({ flow_mode: "manual", tasks }) };
    }),
  );
  return requested;
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

/** Rig configurations under test. "missing" = no config file at all;
 *  "flow-only" = a legal config without the launch_mode key. */
type RigMode = "missing" | "flow-only" | "headless" | "tui" | "corrupt";

/** A real rig root whose .context-hub/config.json carries the switch under
 *  test, cwd + TUT_HUB_ROOT pinned to it, and a pi-only PATH: the headless
 *  door must succeed with NO herdr executable reachable — the tui chain
 *  could not even list panes here, so success itself is the discriminator. */
async function withRig<T>(mode: RigMode, fn: (rig: string) => Promise<T>, opts: { piStub?: boolean; prefix?: string } = {}): Promise<T> {
  const rig = mkdtempSync(path.join(os.tmpdir(), opts.prefix ?? "tut-snext-hl-"));
  mkdirSync(path.join(rig, ".context-hub"), { recursive: true });
  if (mode !== "missing") {
    const body =
      mode === "corrupt" ? "{not json"
        : mode === "flow-only" ? '{"flow_mode":"manual"}\n'
          : `{"flow_mode":"manual","launch_mode":"${mode}"}\n`;
    writeFileSync(path.join(rig, ".context-hub", "config.json"), body, "utf8");
  }
  if (opts.piStub !== false) {
    const bin = path.join(rig, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const prevCwd = process.cwd();
  const prevHubRoot = process.env.TUT_HUB_ROOT;
  const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
  const prevProjectRoot = process.env.TUT_PROJECT_ROOT;
  const prevPath = process.env.PATH;
  process.chdir(rig);
  process.env.TUT_HUB_ROOT = rig;
  process.env.TUT_USER_CONFIG_DIR = path.join(rig, "user-config");
  delete process.env.TUT_PROJECT_ROOT;
  // System bin dirs stay reachable (which/sh for preflights) without the
  // user's PATH — herdr is never installed there, so the headless door's
  // "no herdr contact" discriminator still holds.
  const binDirs = [path.dirname(process.execPath), "/usr/bin", "/bin"];
  if (opts.piStub !== false) binDirs.unshift(path.join(rig, "bin"));
  process.env.PATH = binDirs.join(path.delimiter);
  try {
    return await fn(rig);
  } finally {
    process.chdir(prevCwd);
    if (prevHubRoot === undefined) delete process.env.TUT_HUB_ROOT;
    else process.env.TUT_HUB_ROOT = prevHubRoot;
    if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
    else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
    if (prevProjectRoot === undefined) delete process.env.TUT_PROJECT_ROOT;
    else process.env.TUT_PROJECT_ROOT = prevProjectRoot;
    process.env.PATH = prevPath;
    rmSync(rig, { recursive: true, force: true });
  }
}

/** Fresh-state records: one non-note delivery at v1 (generation trigger). */
function cleanRecords(taskId: string) {
  return [
    {
      version: 1,
      task_id: taskId,
      role: "architect",
      content_type: "design",
      timestamp: "2026-10-18T00:00:00.000Z",
      payload: { summary: "design", body: "design" },
    },
  ];
}

/** A v2 headless launch marker covering the v1 generation. */
function coveredRecords(taskId: string) {
  return [
    ...cleanRecords(taskId),
    {
      version: 2,
      task_id: taskId,
      role: "human",
      content_type: "note",
      timestamp: "2026-10-18T00:00:01.000Z",
      payload: {
        summary: "launch: executor (base v1)",
        body: "launch",
        launch: {
          protocol_version: 2,
          role: "executor",
          base_version: 1,
          via: "auto",
          launch_mode: "headless",
          attempt_id: "11111111-2222-3333-4444-555555555555",
          trigger_version: 1,
        },
      },
    },
  ];
}

interface CapturedSpawn {
  id: string;
  argv: string[];
  cwd: string;
  task_id: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  headless: Record<string, unknown> | undefined;
}

/** Seed one COMPLETED same-role headless run into the rig's run store, so
 *  native session continuity has real previous evidence to find. */
function seedCompletedRun(rig: string, taskId: string): { runId: string; sessionId: string } {
  const canonical = realpathSync(rig);
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-deadbeef`;
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const dir = path.join(canonical, ".context-hub", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    run_id: runId,
    task_id: taskId,
    pid: 424242,
    pgid: 424242,
    supervisor_pid: 424243,
    argv: ["pi", "--print"],
    started_at: "2026-10-18T00:00:00.000Z",
    status: "exited",
    cwd: canonical,
    headless: {
      schema: 1,
      role: "executor",
      attempt_id: "11111111-1111-1111-1111-111111111111",
      base_version: 1,
      trigger_version: 1,
      route: { agent: "pi", args: [] },
      route_source: "builtin-default",
      session_reason: "fresh: no previous headless role run",
      designated_session_id: sessionId,
    },
    ended_at: "2026-10-18T00:05:00.000Z",
    exit_code: 0,
  }), "utf8");
  return { runId, sessionId };
}

describe("start-next headless routing (real launch_mode reads)", () => {
  let io: ReturnType<typeof captureIo>;
  let captured: CapturedSpawn | undefined;

  beforeEach(() => {
    io = captureIo();
    captured = undefined;
    vi.mocked(startRun).mockImplementation(async (store, argv, cwd, task_id, options) => {
      const id = store.create();
      captured = { id, argv: [...argv], cwd, task_id, env: options?.env, headless: options?.headless as Record<string, unknown> | undefined };
      return id;
    });
  });

  afterEach(() => {
    io.restore();
    vi.unstubAllGlobals();
    vi.mocked(hubRead).mockReset();
    vi.mocked(hubPublish).mockReset();
    vi.mocked(startRun).mockReset();
  });

  it.each([
    ["http://hub.test"],
    ["http://hub.test/"],
  ] as const)(
    "explicit headless routes start-next through the headless door (run on disk, no herdr reachable, url=%s)",
    async (hubUrl) => {
      const requested = stubState([{ task_id: "hl-1", status: "implementing", waiting_for: "agent:executor", version: 1, title: "HL One" }]);
      vi.mocked(hubRead).mockResolvedValue({ task_id: "hl-1", title: "HL One", status: "implementing", versions: cleanRecords("hl-1") });
      vi.mocked(hubPublish).mockResolvedValue({ task_id: "hl-1", version: 2, status: "implementing", needs_attention: false });

      let code: number | undefined;
      let rig: string | undefined;
      let runOnDisk = false;
      await withRig("headless", async (r) => {
        rig = realpathSync(r); // canonical form, as resolveRigRoot sees it (before cleanup)
        code = await main(["start-next", "hl-1", "--url", hubUrl]);
        runOnDisk = existsSync(path.join(r, ".context-hub", "runs", captured!.id));
      });

      expect(code).toBe(0);
      expect(captured).toBeDefined();
      // Acceptance: runs/<id> lands on disk under the rig's .context-hub, and a
      // trailing-slash base URL never collapses into //state.
      expect(runOnDisk).toBe(true);
      expect(requested.every((url) => !url.includes("//state"))).toBe(true);
      expect(requested.some((url) => url.startsWith("http://hub.test/state"))).toBe(true); // revalidate gate reached
      expect(io.out()).toContain(
        `start-next: headless launch attempt completed; delivery confirmation is not implied (executor for hl-1 via headless run ${captured!.id}`,
      );
      // The spawn is the routed headless agent argv in the checkout root.
      expect(captured!.argv[0]).toContain("pi");
      expect(captured!.argv).toContain("--print");
      expect(captured!.cwd).toBe(rig);
      expect(captured!.task_id).toBe("hl-1");
      expect(captured!.headless).toMatchObject({ role: "executor", base_version: 1, route_source: "builtin-default" });
      expect(captured!.env).toMatchObject({
        TUT_HUB_ROOT: rig,
        TUT_HUB_URL: hubUrl,
        TUT_EVENT_PORT_URL: "http://127.0.0.1:1/agent-event", // test/setup.ts's explicit pin wins over discovery, like the tui door
      });
      // The launch note carries the v2 headless marker with manual-door provenance.
      const publish = vi.mocked(hubPublish).mock.calls[0]!;
      expect(publish[0]).toBe(hubUrl);
      expect(publish[1].role).toBe("human");
      expect((publish[1].payload as { launch?: Record<string, unknown> }).launch).toMatchObject({
        protocol_version: 2,
        role: "executor",
        base_version: 1,
        via: "start-next",
        launch_mode: "headless",
        target_kind: "headless-posix",
        trigger_version: 1,
      });
    },
  );

  it.each([
    ["relative", "1.0.0-sample", false],
    ["absolute", "1.0.0-sample", false],
    ["relative", "1-0-0-sample", true],
    ["absolute", "1-0-0-sample", true],
  ] as const)(
    "worktree preflight matches doctor for the frozen %s path %s (healthy=%s)",
    async (form, name, healthy) => {
      await withRig("headless", async (r) => {
        const rig = realpathSync(r);
        // Two similarly-named checkouts exist side by side, one dotted and
        // one dashed. Only the dashed checkout is built; resolving against
        // caller cwd would miss BOTH.
        for (const sibling of ["1.0.0-sample", "1-0-0-sample"]) {
          const checkout = path.join(rig, ".worktrees", sibling);
          mkdirSync(path.join(checkout, "node_modules"), { recursive: true });
          mkdirSync(path.join(checkout, "dist"));
          writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "take-ur-turn", dependencies: { zod: "^3" } }));
          writeFileSync(path.join(checkout, "dist/cli.js"), "");
          if (sibling === "1-0-0-sample") {
            mkdirSync(path.join(checkout, "dist/core/run"), { recursive: true });
            writeFileSync(path.join(checkout, "dist/core/run/supervisor.js"), "");
          }
        }
        process.chdir(path.join(rig, ".worktrees", "1-0-0-sample"));
        const checkout = path.join(rig, ".worktrees", name);
        const task = {
          task_id: "worktree-preflight", title: "Worktree preflight", version: 1,
          status: "implementing", waiting_for: "agent:executor",
          checkout: { kind: "worktree" as const, path: form === "absolute" ? checkout : path.join(".worktrees", name) },
        };
        stubState([task]);
        vi.mocked(hubRead).mockResolvedValue({ ...task, versions: cleanRecords(task.task_id) });
        vi.mocked(hubPublish).mockResolvedValue({ task_id: task.task_id, version: 2, status: "implementing", needs_attention: false });

        // Instrument the shared preflight boundary without changing its
        // result: compare the actual checkout and artifact paths inspected
        // by each entry, rather than inferring them from launch output.
        const inspect = preflight.preflightCheckout;
        const inspected: preflight.PreflightReport[] = [];
        const spy = vi.spyOn(preflight, "preflightCheckout").mockImplementation((root) => {
          const report = inspect(root);
          inspected.push(report);
          return report;
        });
        try {
          expect(await main(["start-next", task.task_id, "--url", "http://hub.test"])).toBe(healthy ? 0 : 1);
          expect(inspected).toHaveLength(1);
          const launchReport = inspected[0]!;
          expect(launchReport.checkout).toBe(checkout);
          expect(launchReport.ok).toBe(healthy);
          if (healthy) {
            expect(captured?.cwd).toBe(checkout);
            expect(hubPublish).toHaveBeenCalledTimes(1);
          } else {
            expect(io.err()).toContain(path.join(checkout, "dist/core/run/supervisor.js"));
            expect(captured).toBeUndefined();
            expect(hubPublish).not.toHaveBeenCalled();
            expect(existsSync(path.join(rig, ".context-hub/runs"))).toBe(false);
          }

          const offset = io.out().length;
          // Other doctor checks can fail in this synthetic offline rig;
          // only the checkout preflight verdict is under comparison.
          await main(["doctor", "--json", "--root", path.join(rig, ".context-hub"), "--checkout", checkout, "--url", "http://hub.test"]);
          const doctor = JSON.parse(io.out().slice(offset));
          expect(doctor.checks.find((check: { name: string }) => check.name === "preflight").status).toBe(healthy ? "ok" : "fail");
          expect(inspected).toHaveLength(2);
          expect(inspected[1]).toEqual(launchReport);
        } finally {
          spy.mockRestore();
        }
      }, { prefix: "tut worktree 路径 " });
    },
  );

  it.each([
    ["tui"],
    ["missing"],
    ["flow-only"],
  ] as const)(
    "launch_mode=%s keeps start-next on the shipped pane chain (dry-run launcher, no headless marker)",
    async (mode) => {
      stubState([{ task_id: "tui-1", status: "implementing", waiting_for: "agent:executor", version: 0 }]);
      vi.mocked(hubRead).mockResolvedValue({ task_id: "tui-1", title: "TUI", status: "implementing", versions: [] });
      vi.mocked(hubPublish).mockResolvedValue({ task_id: "tui-1", version: 1, status: "implementing", needs_attention: false });

      const FIXTURE_BIN = path.resolve(import.meta.dirname, "bin");
      let code: number | undefined;
      await withRig(
        mode,
        async () => {
          const prevPath = process.env.PATH;
          const prevPanes = process.env.TUT_HERDR_PANES;
          const prevHub = process.env.TUT_HUB_URL;
          const prevDry = process.env.TUT_DRY_RUN;
          process.env.PATH = `${FIXTURE_BIN}:${prevPath}`;
          process.env.TUT_HERDR_PANES = "[]";
          process.env.TUT_HUB_URL = "http://127.0.0.1:1";
          process.env.TUT_DRY_RUN = "1";
          try {
            code = await main(["start-next", "tui-1", "--url", "http://hub.test"]);
          } finally {
            process.env.PATH = prevPath;
            if (prevPanes === undefined) delete process.env.TUT_HERDR_PANES;
            else process.env.TUT_HERDR_PANES = prevPanes;
            if (prevHub === undefined) delete process.env.TUT_HUB_URL;
            else process.env.TUT_HUB_URL = prevHub;
            if (prevDry === undefined) delete process.env.TUT_DRY_RUN;
            else process.env.TUT_DRY_RUN = prevDry;
          }
        },
        { piStub: false },
      );

      expect(code).toBe(0);
      const out = io.out();
      expect(out).toContain("DRY-RUN"); // the pane chain ran (fixture herdr, empty list)
      expect(out).toContain("launch attempt completed; delivery confirmation is not implied (executor for tui-1 via tut launch)");
      expect(out).not.toContain("via headless run");
      expect(captured).toBeUndefined(); // startRun never reached: no headless spawn
      const launch = (vi.mocked(hubPublish).mock.calls[0]![1].payload as { launch?: Record<string, unknown> }).launch;
      expect(launch).toMatchObject({ protocol_version: 2, role: "executor", base_version: 0, via: "start-next" });
      expect(launch).not.toHaveProperty("launch_mode");
    },
  );

  it.each(['tut-snext-hl-', "tut checkout ' $HOME; & -"])(
    'preflight manual guidance repairs dependencies and dist, then start-next succeeds (%s)', { timeout: 30_000 }, async prefix => {
    stubState([{ task_id: 'repair', status: 'implementing', waiting_for: 'agent:executor', version: 1 }]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: 'repair', title: 'Repair', status: 'implementing', versions: cleanRecords('repair') });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: 'repair', version: 2, status: 'implementing', needs_attention: false });
    await withRig('headless', async rig => {
      mkdirSync(path.join(rig, 'dep'));
      writeFileSync(path.join(rig, 'dep/package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
      const build = `node -e "const f=require('fs');f.mkdirSync('dist/core/run',{recursive:true});f.writeFileSync('dist/cli.js','');f.writeFileSync('dist/core/run/supervisor.js','')"`;
      writeFileSync(path.join(rig, 'package.json'), JSON.stringify({ name: 'take-ur-turn', version: '1.0.0', dependencies: { dep: 'file:./dep' }, scripts: { build } }));
      writeFileSync(path.join(rig, 'package-lock.json'), JSON.stringify({
        name: 'take-ur-turn', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: {
          '': { name: 'take-ur-turn', version: '1.0.0', dependencies: { dep: 'file:./dep' } },
          dep: { name: 'dep', version: '1.0.0' },
          'node_modules/dep': { resolved: 'dep', link: true },
        },
      }));
      expect(await main(['start-next', 'repair', '--url', 'http://hub.test'])).toBe(1);
      expect(hubPublish).not.toHaveBeenCalled();
      expect(captured).toBeUndefined();
      const guidance = io.err();
      expect(guidance).not.toContain('--fix-preflight');
      expect(guidance).toContain('then retry the launch');
      const steps = [...guidance.matchAll(/    fix: (.+)/gu)].map(match => match[1]!);
      const checkoutWord = `'${realpathSync(rig).split("'").join("'\\''")}'`;
      expect(steps).toEqual([`cd ${checkoutWord} && npm ci`, `cd ${checkoutWord} && npm run build`]);
      // npm/npx exports its own effective config to children. Keep the
      // fixture independent of the invoking user's install policy.
      const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key)));
      for (const step of steps) {
        await promisify(execFile)('/bin/sh', ['-c', step], {
          env: {
            ...childEnv, npm_config_cache: path.join(rig, 'npm-cache'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
            npm_config_userconfig: path.join(rig, 'empty-user-npmrc'), npm_config_globalconfig: path.join(rig, 'empty-global-npmrc'),
          },
        });
      }
      expect(await main(['start-next', 'repair', '--url', 'http://hub.test'])).toBe(0);
      expect(captured).toBeDefined();
      expect(hubPublish).toHaveBeenCalledTimes(1);
    }, { prefix });
  });

  it("a corrupt launch_mode config fails closed: no marker, no spawn", async () => {
    stubState([{ task_id: "hl-bad", status: "implementing", waiting_for: "agent:executor", version: 0 }]);

    let code: number | undefined;
    await withRig("corrupt", async () => {
      code = await main(["start-next", "hl-bad", "--url", "http://hub.test"]);
    });

    expect(code).toBe(1);
    expect(io.err()).toContain("cannot read launch_mode");
    expect(io.err()).toContain("unreadable or corrupt");
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled();
    expect(captured).toBeUndefined();
  });

  it("headless door honors the generation guard: covered marker → ALREADY_LAUNCHED, no marker, no spawn", async () => {
    stubState([{ task_id: "hl-dup", status: "implementing", waiting_for: "agent:executor", version: 2 }]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "hl-dup", title: "Dup", status: "implementing", versions: coveredRecords("hl-dup") });

    let code: number | undefined;
    await withRig("headless", async () => {
      code = await main(["start-next", "hl-dup", "--url", "http://hub.test"]);
    });

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("tut: ALREADY_LAUNCHED: executor launched at v2, no new publish since; inspect this round and outstanding control calls before considering --force");
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled();
    expect(captured).toBeUndefined();
  });

  it("--force bypasses the headless generation guard and launches a fresh attempt", async () => {
    // The rig's state and log must evolve like a real hub would after the
    // forced marker append — the in-lock revalidation gate re-reads both and
    // refuses a gate it cannot see reflected (a stale mock is not a pass).
    const published: ContextRecord[] = [];
    let stateVersion = 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          flow_mode: "manual",
          tasks: [{ task_id: "hl-force", status: "implementing", waiting_for: "agent:executor", version: stateVersion }],
        }),
      })),
    );
    vi.mocked(hubPublish).mockImplementation(async (_url, input) => {
      published.push({
        version: ++stateVersion,
        task_id: input.task_id,
        role: input.role,
        content_type: input.content_type,
        timestamp: new Date().toISOString(),
        payload: input.payload as ContextRecord["payload"],
      });
      return { task_id: input.task_id, version: stateVersion, status: "implementing", needs_attention: false };
    });
    vi.mocked(hubRead).mockImplementation(async () => ({
      task_id: "hl-force",
      title: "Force",
      status: "implementing",
      versions: [...coveredRecords("hl-force"), ...published],
    }));

    let code: number | undefined;
    let runOnDisk = false;
    await withRig("headless", async (r) => {
      code = await main(["start-next", "hl-force", "--force", "--url", "http://hub.test"]);
      runOnDisk = captured !== undefined && existsSync(path.join(r, ".context-hub", "runs", captured.id));
    });

    expect(code).toBe(0);
    expect(captured).toBeDefined();
    expect(runOnDisk).toBe(true);
    const publish = vi.mocked(hubPublish).mock.calls[0]!;
    expect(publish[1].expected_version).toBe(2); // re-based on the covering marker's version
    expect((publish[1].payload as { launch?: Record<string, unknown> }).launch).toMatchObject({ role: "executor", base_version: 2, via: "start-next" });
  });

  it("without --fresh, a completed same-role run is continued (native session resume)", async () => {
    stubState([{ task_id: "hl-cont", status: "implementing", waiting_for: "agent:executor", version: 1 }]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "hl-cont", title: "Cont", status: "implementing", versions: cleanRecords("hl-cont") });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "hl-cont", version: 2, status: "implementing", needs_attention: false });

    let code: number | undefined;
    let seeded: { runId: string; sessionId: string } | undefined;
    await withRig("headless", async (r) => {
      seeded = seedCompletedRun(r, "hl-cont");
      code = await main(["start-next", "hl-cont", "--url", "http://hub.test"]);
    });

    expect(code).toBe(0);
    expect(captured).toBeDefined();
    const argv = captured!.argv;
    const session = argv[argv.indexOf("--session-id") + 1];
    expect(session).toBe(seeded!.sessionId); // pi continues the exact native role session
    expect(captured!.headless).toMatchObject({
      designated_session_id: seeded!.sessionId,
      resume_from_run_id: seeded!.runId,
    });
  });

  it("with --fresh, the manual plan withholds session continuity (brand-new native session)", async () => {
    stubState([{ task_id: "hl-fr", status: "implementing", waiting_for: "agent:executor", version: 1 }]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "hl-fr", title: "Fresh", status: "implementing", versions: cleanRecords("hl-fr") });
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "hl-fr", version: 2, status: "implementing", needs_attention: false });

    let code: number | undefined;
    let seeded: { runId: string; sessionId: string } | undefined;
    await withRig("headless", async (r) => {
      seeded = seedCompletedRun(r, "hl-fr");
      code = await main(["start-next", "hl-fr", "--fresh", "--url", "http://hub.test"]);
    });

    expect(code).toBe(0);
    expect(captured).toBeDefined();
    const argv = captured!.argv;
    const session = argv[argv.indexOf("--session-id") + 1];
    expect(session).toBeDefined();
    expect(session).not.toBe(seeded!.sessionId); // a NEW designated session, not the completed one
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured!.headless).not.toHaveProperty("resume_from_run_id");
    expect(captured!.headless).toMatchObject({ designated_session_id: session, session_reason: "fresh: explicit new-session request" });
  });

  it("marker VERSION_CONFLICT converges on the already-launched outcome instead of a false error", async () => {
    stubState([{ task_id: "hl-race", status: "implementing", waiting_for: "agent:executor", version: 1 }]);
    vi.mocked(hubRead)
      .mockResolvedValueOnce({ task_id: "hl-race", title: "Race", status: "implementing", versions: cleanRecords("hl-race") })
      .mockResolvedValueOnce({ task_id: "hl-race", title: "Race", status: "implementing", versions: coveredRecords("hl-race") });
    vi.mocked(hubPublish).mockRejectedValueOnce(new HubError("VERSION_CONFLICT", "expected 1, got 2; re-read the task log"));

    let code: number | undefined;
    await withRig("headless", async () => {
      code = await main(["start-next", "hl-race", "--url", "http://hub.test"]);
    });

    expect(code).toBe(1);
    expect(io.err()).toContain("tut: ALREADY_LAUNCHED: executor launched at v2");
    expect(io.err()).toContain("another launcher won the race");
    expect(captured).toBeUndefined();
  });

  it("pre-marker plan failure leaves no trace: executable missing → exit 1, no marker, no run dir", async () => {
    stubState([{ task_id: "hl-nopi", status: "implementing", waiting_for: "agent:executor", version: 1 }]);
    vi.mocked(hubRead).mockResolvedValue({ task_id: "hl-nopi", title: "NoPi", status: "implementing", versions: cleanRecords("hl-nopi") });

    let code: number | undefined;
    await withRig("headless", async () => {
      code = await main(["start-next", "hl-nopi", "--url", "http://hub.test"]);
    }, { piStub: false });

    expect(code).toBe(1);
    expect(io.err()).toContain("headless executable not on PATH or not executable: pi");
    expect(vi.mocked(hubPublish)).not.toHaveBeenCalled();
    expect(captured).toBeUndefined();
  });
});

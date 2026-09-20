import { rigLabel } from "../src/rig.js";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  buildLaunchInvocation,
  deserializeLaunchInvocation,
  explicitRouteFromValues,
  serializeLaunchInvocation,
  targetDigest,
  validateLaunchInvocation,
} from "../src/launcher/invocation.js";
import { parseLaunchEntry, runLaunchEntry } from "../src/launcher/entry.js";
import { privateDigestOf } from "../src/launcher/compat.js";
import { cliEntryPath, DEFAULT_CHILD_TIMEOUT_MS, runInternalLaunchInvocation, runNodeCommand, type DirectSpawn } from "../src/launcher/process.js";
import { Notifier } from "../src/notifier.js";
import type { ContextRecord, LaunchInvocation } from "../src/types.js";

function invocation(): LaunchInvocation {
  return buildLaunchInvocation({
    request: {
      kind: "round",
      task_id: "unit-1",
      role: "executor",
      fresh: false,
      via: "start-next",
    },
    base_version: 12,
    hub_url: "http://127.0.0.1:3001",
    route: { agent: "pi", args: ["--model", "gpt-5.6"] },
    route_source: "task-cast",
    context: {
      anchor: { workspace_id: "w1", cwd: "/work/project", pane_id: "p1" },
      hubRoot: "/work/project",
      routingRoot: "/work/project",
      checkoutRoot: "/work/project",
      checkout: { kind: "current" },
      context: { kind: "shared" },
      source: "anchor",
    },
    naming: { tab_label: "TUT executor unit-1", pane_label: rigLabel("unit-1.executor", "/work/project") },
    prompt: "round prompt",
    posix_direct: {
      executable: "pi",
      args: ["--model", "gpt-5.6"],
      env: { PI_SKIP_VERSION_CHECK: "1" },
    },
  });
}

describe("internal launcher entry boundary", () => {
  it("captures undefined, single-value, and multi-argv legacy routes without rejoining them", () => {
    expect(parseLaunchEntry(["task", "executor"])).toEqual({
      kind: "round",
      request: { kind: "round", task_id: "task", role: "executor", fresh: false, via: "legacy" },
    });
    expect(parseLaunchEntry(["task", "executor", "pi --model gpt-5.6"])).toEqual({
      kind: "round",
      request: {
        kind: "round",
        task_id: "task",
        role: "executor",
        fresh: false,
        via: "legacy",
        explicit_route_values: ["pi --model gpt-5.6"],
      },
    });
    expect(parseLaunchEntry(["--fresh", "task", "executor", "pi", "--model", "gpt-5.6"])).toEqual({
      kind: "round",
      request: {
        kind: "round",
        task_id: "task",
        role: "executor",
        fresh: true,
        via: "legacy",
        explicit_route_values: ["pi", "--model", "gpt-5.6"],
      },
    });
  });

  it("gives explicit route values precedence and rejects shell-like tokens at the one parser", () => {
    expect(explicitRouteFromValues(["pi --model gpt-5.6"])).toEqual({
      agent: "pi",
      args: ["--model", "gpt-5.6"],
    });
    expect(explicitRouteFromValues(["pi", "--model", "gpt-5.6"])).toEqual({
      agent: "pi",
      args: ["--model", "gpt-5.6"],
    });
    expect(() => explicitRouteFromValues(["pi", "&&", "whoami"])).toThrow("invalid agent command");
  });
});

describe("LaunchInvocation and marker projection", () => {
  it("keeps the marker portable while the child receives the complete private plan", () => {
    const plan = invocation();
    expect(plan.marker_projection).toEqual({
      protocol_version: 2,
      role: "executor",
      base_version: 12,
      via: "start-next",
      route: { agent: "pi", args: ["--model", "gpt-5.6"] },
      route_source: "task-cast",
      target_kind: "posix-direct",
      target_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(plan.marker_projection)).not.toContain("/work/project");
    expect(JSON.stringify(plan.marker_projection)).not.toContain("PI_SKIP_VERSION_CHECK");
    expect(deserializeLaunchInvocation(serializeLaunchInvocation(plan))).toEqual(plan);
    expect(validateLaunchInvocation(JSON.parse(serializeLaunchInvocation(plan)))).toEqual(plan);
  });

  it("uses canonical JSON for a stable digest and detects a tampered private plan", () => {
    expect(targetDigest({ b: 2, a: { y: true, x: ["one", "two"] } })).toBe(
      targetDigest({ a: { x: ["one", "two"], y: true }, b: 2 }),
    );
    const tampered = invocation();
    tampered.posix_direct!.args.push("--changed");
    expect(() => deserializeLaunchInvocation(JSON.stringify(tampered))).toThrow("target digest");
  });
});

describe("internal Node process boundary", () => {
  it("spawns process.execPath with absolute dist/cli.js and one JSON invocation argv item", async () => {
    const seen: { file: string; args: string[]; options?: unknown } = { file: "", args: [] };
    const spawnFn: DirectSpawn = (file, args, options) => {
      seen.file = file;
      seen.args = [...args];
      seen.options = options;
      const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end("child stdout\n");
        child.stderr.end("child stderr\n");
        child.emit("close", 0, null);
      });
      return child;
    };

    const plan = invocation();
    const result = await runInternalLaunchInvocation(plan, { spawnFn });
    expect(result).toMatchObject({ code: 0, stdout: "child stdout\n", stderr: "child stderr\n" });
    expect(seen.file).toBe(process.execPath);
    expect(seen.args.slice(0, 3)).toEqual([cliEntryPath(), "launch", "--invocation"]);
    expect(seen.args).toHaveLength(4);
    expect(JSON.parse(seen.args[3]!)).toEqual(plan);
  });

  it("forwards an explicit stdio option instead of silently replacing it", async () => {
    let seenStdio: unknown;
    const spawnFn: DirectSpawn = (_file, _args, options) => {
      seenStdio = options?.stdio;
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    };

    const result = await runNodeCommand(["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      spawnFn,
    });

    expect(seenStdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  /** A wedged child in the SIGSTOP shape: never closes on its own — only
   *  SIGKILL (kill()) ends it.  Paired with a fake clock so the PRODUCTION
   *  default budget can be exercised without a real 120s wall wait. */
  function hungChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
    const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    (child as unknown as { kill: () => boolean }).kill = () => {
      child.emit("close", null, "SIGKILL");
      return true;
    };
    return child;
  }

  it("kills a stopped (SIGSTOP) child at the timeout backstop and settles as a timeout failure", async () => {
    // Real process, real timers: the child stops itself — the kill -STOP
    // shape.  SIGKILL reaches a stopped process;
    // the promise must settle as a failure return (timedOut), never hang.
    const spawnFn: DirectSpawn = (file, args) =>
      spawn(file, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const result = await runNodeCommand(
      ["-e", "process.kill(process.pid, 'SIGSTOP'); setInterval(() => {}, 100);"],
      { spawnFn, timeoutMs: 400 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.code === null || result.code !== 0).toBe(true);
  }, 10_000);

  it("kills a wedged child at the PRODUCTION default budget with no per-call override (default-budget evidence)", async () => {
    // Same wedged shape as the real-SIGSTOP test above, but NO timeoutMs is
    // injected: the window under test is exactly DEFAULT_CHILD_TIMEOUT_MS
    // (fake clock — no real 120s wait).  One ms before the deadline the
    // promise must still be pending; at the deadline the backstop kills the
    // child and settles as the failure return that feed autoLaunchFailed.
    vi.useFakeTimers();
    try {
      const spawnFn: DirectSpawn = () => hungChild();
      const pending = runNodeCommand(["launch", "budget-unit", "executor"], { spawnFn });
      await vi.advanceTimersByTimeAsync(DEFAULT_CHILD_TIMEOUT_MS - 1);
      const early = await Promise.race([pending.then(() => "settled"), Promise.resolve("still-pending")]);
      expect(early).toBe("still-pending"); // window pinned to the default constant
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(result.code).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a healthy child completes under the PRODUCTION default budget — the backstop never fires", async () => {
    // Real child, real timers, no timeout override: a healthy launch-shaped
    // child finishes in milliseconds, far inside DEFAULT_CHILD_TIMEOUT_MS —
    // settling at all (well under the test timeout) is the not-killed
    // evidence.  Full healthy launches run the same default path (no override
    // seam exists on spawnLaunch*) in notifier.test.ts's real-subprocess tee
    // and TUT_DRY_RUN launch tests.
    const result = await runNodeCommand([
      "-e",
      "setTimeout(() => { process.stdout.write('healthy child done'); }, 25);",
    ]);
    expect(result).toMatchObject({ code: 0, stdout: "healthy child done" });
    expect(result.timedOut).toBeUndefined();
  });

  it("a non-positive timeoutMs disables the backstop (explicit opt-out)", async () => {
    let closed = false;
    const spawnFn: DirectSpawn = () => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => {
        child.emit("close", 0, null);
        closed = true;
      });
      return child;
    };
    const result = await runNodeCommand(["--ok"], { spawnFn, timeoutMs: 0 });
    expect(result).toMatchObject({ code: 0 });
    expect(result.timedOut).toBeUndefined();
    expect(closed).toBe(true);
  });
});

describe("compat birth plan", () => {
  it("sends the frozen POSIX plan to herdr without reapplying process policy", async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "tut-launch-plan-"));
    const herdrLog = path.join(temp, "herdr.log");
    const fixtureBin = path.resolve(import.meta.dirname, "bin");
    const envKeys = [
      "TUT_DRY_RUN",
      "TUT_SUPPRESS_AGENT_UPDATE",
      "PATH",
      "TUT_HERDR_PANES",
      "TUT_HERDR_LOG",
      "TUT_DELIVERY_DIAG",
      "TUT_READY_POLL_MS",
      "TUT_READY_FLOOR_MS",
      "TUT_READY_TIMEOUT_MS",
      "TUT_TEXT_LAND_TIMEOUT_MS",
      "TUT_SUBMIT_TIMEOUT_MS",
      "TUT_SUBMIT_RETRY_MS",
      "TUT_SUBMIT_RETRY_TIMEOUT_MS",
    ];
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.TUT_SUPPRESS_AGENT_UPDATE = "1";
    delete process.env.TUT_DRY_RUN;
    process.env.PATH = fixtureBin + ":" + (previous.PATH ?? "");
    process.env.TUT_HERDR_PANES = "[]";
    process.env.TUT_HERDR_LOG = herdrLog;
    process.env.TUT_DELIVERY_DIAG = "0";
    process.env.TUT_READY_POLL_MS = "1";
    process.env.TUT_READY_FLOOR_MS = "0";
    process.env.TUT_READY_TIMEOUT_MS = "1";
    process.env.TUT_TEXT_LAND_TIMEOUT_MS = "1";
    process.env.TUT_SUBMIT_TIMEOUT_MS = "1";
    process.env.TUT_SUBMIT_RETRY_MS = "1";
    process.env.TUT_SUBMIT_RETRY_TIMEOUT_MS = "1";
    try {
      const base = invocation();
      const plan = buildLaunchInvocation({
        request: {
          kind: "round",
          task_id: "unit-1",
          role: "executor",
          fresh: false,
          via: "start-next",
        },
        base_version: base.base_version,
        hub_url: base.hub_url,
        route: { agent: "codex", args: ["--model", "fast"] },
        route_source: "task-cast",
        context: base.context,
        naming: base.naming,
        prompt: base.prompt,
        // Deliberately legal but different from the current process policy:
        // birth must not append codex's suppression flag.
        posix_direct: { executable: "codex", args: ["--model", "fast"], env: { PLAN_FLAG: "yes" } },
      });
      const code = await runLaunchEntry({
        kind: "round",
        request: {
          kind: "round",
          task_id: "unit-1",
          role: "executor",
          fresh: false,
          via: "start-next",
        },
        invocation: plan,
      });

      expect(code).toBe(0);
      const herdrLines = readFileSync(herdrLog, "utf8").split("\n").filter((line) => line.length > 0);
      const runLine = herdrLines.find((line) => line.startsWith("pane run FIX:root1 "));
      expect(runLine).toBeDefined();
      expect(runLine).toContain("probe-runner.js");
      const token = runLine?.match(/'--payload' '([A-Za-z0-9_-]+)'/u)?.[1];
      expect(token).toBeDefined();
      expect(JSON.parse(Buffer.from(token ?? "", "base64url").toString("utf8"))).toMatchObject({
        cwd: "/work/project",
        executable: "codex",
        args: ["--model", "fast"],
        env: { PLAN_FLAG: "yes" },
        purpose: "agent",
      });
      expect(plan.marker_projection?.target_digest).toBe(privateDigestOf(plan));
    } finally {
      output.mockRestore();
      errors.mockRestore();
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("Notifier canonical launch hand-off", () => {
  it("passes the frozen invocation and marker projection instead of a legacy route", async () => {
    let current = {
      flow_mode: "auto",
      auto: { launch_roles: ["executor"] },
      tasks: [{
        task_id: "notify-unit",
        title: "unit",
        status: "designing",
        updated_at: "2026-08-26T00:00:00.000Z",
        needs_attention: false,
        waiting_for: "agent:architect",
      }],
    };
    let captured: LaunchInvocation | undefined;
    let capturedMarker: unknown;
    const notifier = new Notifier(
      { url: "http://hub.test", interval: 5, eventPort: 0, stallTimeoutMin: 30 },
      {
        fetchState: async () => current,
        readLog: async (): Promise<ContextRecord[]> => [],
        resolveTargetWithSource: async () => ({ route: { agent: "codex", args: ["--model", "gpt-5.6"] }, source: "task-cast" }),
        markLaunched: async (_taskId, _role, _baseVersion, _via, projection) => {
          capturedMarker = projection;
          return { version: 1 };
        },
        launchInvocation: async (plan) => {
          captured = plan;
          return "planned";
        },
        launch: async () => {
          throw new Error("legacy launch seam used");
        },
        channelsFor: () => [],
        now: () => 0,
        log: () => undefined,
        loadRouting: async () => ({ labelToAgent: new Map(), roleToAgent: new Map() }),
        listAnchorPanes: async () => [{
          pane_id: "fixture:anchor",
          label: "tut-hub",
          workspace_id: "fixture-workspace",
          cwd: "/fixture/workspace",
        }],
      },
    );

    await notifier.requestCompare();
    current = {
      ...current,
      tasks: [{ ...current.tasks[0]!, status: "implementing", waiting_for: "agent:executor", updated_at: "2026-08-26T00:01:00.000Z" }],
    };
    await notifier.requestCompare();

    expect(captured).toBeDefined();
    expect(captured!.route).toEqual({ agent: "codex", args: ["--model", "gpt-5.6"] });
    expect(captured!.posix_direct?.args).toEqual(["--model", "gpt-5.6", "-c", "check_for_update_on_startup=false"]);
    expect(captured!.marker_projection).toEqual(capturedMarker);
    expect(captured!.marker_projection?.route_source).toBe("task-cast");
  });
});

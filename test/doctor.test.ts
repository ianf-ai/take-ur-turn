import * as rig from "../src/rig.js";
import { HerdrClient } from "../src/launcher/herdr-client.js";
// tut doctor (0.7.0) — report-only environment & assembly self-check.
// Module-stage discipline: the doctor module is exercised through runDoctor
// with injected seams (fetchImpl / resolveTarget) against real temp-dir
// fixtures — no real network, no dependence on which agents happen to be
// installed. The CLI wiring (tut doctor / repair-meta / recover-record
// commands) is a separate CLI-side task; the HTTP endpoints themselves are
// tested in http.test.ts.

import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentTargetError } from "../src/launcher/target-resolver.js";
import { Store } from "../src/store.js";
import {
  renderDoctorReport,
  runDoctor,
  type AgentChannelSeatVerdict,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
} from "../src/doctor.js";

// --- fixture helpers -------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-doctor-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface RecordInput {
  version: number;
  content_type?: string;
  role?: string;
}

function recordJson(taskId: string, input: RecordInput): string {
  return JSON.stringify({
    version: input.version,
    task_id: taskId,
    role: input.role ?? "executor",
    content_type: input.content_type ?? "note",
    timestamp: "2026-09-02T00:00:00.000Z",
    payload: { summary: `v${input.version}`, body: "fixture body" },
  });
}

function recordName(input: RecordInput): string {
  return `v${String(input.version).padStart(3, "0")}.${input.content_type ?? "note"}.json`;
}

function writeTask(
  root: string,
  taskId: string,
  opts: { records?: RecordInput[]; metaOverride?: string; extraFiles?: Record<string, string> } = {},
): void {
  const dir = path.join(root, "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  const records = opts.records ?? [];
  const meta =
    opts.metaOverride ??
    JSON.stringify({
      task_id: taskId,
      title: taskId,
      created_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z",
      version: records.length > 0 ? records[records.length - 1]!.version : 0,
    });
  writeFileSync(path.join(dir, "meta.json"), meta);
  for (const r of records) writeFileSync(path.join(dir, recordName(r)), recordJson(taskId, r));
  for (const [name, content] of Object.entries(opts.extraFiles ?? {})) writeFileSync(path.join(dir, name), content);
}

function healthyRoot(): string {
  // Conventional shape: <project>/.context-hub — the resolver chain's L1 is
  // <parent>/.context-hub/workspace.json, so the fixture must match it.
  const root = path.join(tmp, "proj", ".context-hub");
  mkdirSync(path.join(root, "tasks"), { recursive: true });
  writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual" }, null, 2));
  writeTask(root, "demo-task", { records: [{ version: 1 }, { version: 2, content_type: "code_changes" }] });
  return root;
}

/** Fresh env pointing the user-level workspace chain at an isolated dir. */
function fixtureEnv(): { env: NodeJS.ProcessEnv; userDir: string } {
  const userDir = path.join(tmp, "user-config");
  mkdirSync(userDir, { recursive: true });
  return { env: { TUT_USER_CONFIG_DIR: userDir }, userDir };
}

const RESOLVED_TARGET_OK = { platform: "posix", posix_direct: { agent: "stub" } } as unknown;

/** URL text of a fetch input across string | URL | Request shapes. */
function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  const url = (input as { url?: unknown } | null)?.url;
  return typeof url === "string" ? url : String(input);
}

function okResolveTarget(): NonNullable<DoctorOptions["resolveTarget"]> {
  return async () => RESOLVED_TARGET_OK as never;
}

/** fetch seam: hub /state answers healthy; event port answers the Notifier's
 *  405 + Allow: POST signature; everything else 404s. */
function healthyFetch(hubBody?: Record<string, unknown>): typeof fetch {
  return (async (input: unknown) => {
    const url = urlOf(input);
    if (url.includes("/state")) {
      return new Response(
        JSON.stringify(hubBody ?? { flow_mode: "manual", tasks: [{ task_id: "demo-task", needs_attention: false }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/agent-event")) {
      return new Response("method not allowed: use POST /agent-event", { status: 405, headers: { Allow: "POST" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function refusingFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed: connection refused");
  }) as typeof fetch;
}

function check(report: DoctorReport, name: string): DoctorCheck {
  const found = report.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

function baseOptions(root: string): DoctorOptions & { environment: NodeJS.ProcessEnv } {
  const { env } = fixtureEnv();
  return { root, environment: env, fetchImpl: healthyFetch(), resolveTarget: okResolveTarget() };
}

// --- healthy assembly ------------------------------------------------------------

describe("tut doctor (healthy assembly)", () => {
  it("reports ok with all eight checks green", async () => {
    const root = healthyRoot();
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      "hub",
      "notifier",
      "config",
      "agents",
      "storage",
      "paths",
      "platform",
      "agent-channel",
    ]);
    for (const c of report.checks) expect(c.status, c.name).toBe("ok");
    expect(check(report, "hub").summary).toContain("flow_mode=manual");
    expect(check(report, "storage").summary).toContain("1 task dir(s) scanned");
  });

  it("is report-only: the fixture tree is byte-identical after a run", async () => {
    const root = healthyRoot();
    const before = snapshotTree(root);
    await runDoctor(baseOptions(root));
    expect(snapshotTree(root)).toEqual(before);
  });
});

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(root, p)] = sha256Bytes(readFileSync(p));
    }
  };
  walk(root);
  return out;
}

// --- check 1: hub ------------------------------------------------------------------

describe("tut doctor hub check", () => {
  it("fails with tut serve guidance when the hub is down", async () => {
    const opts = baseOptions(healthyRoot());
    opts.fetchImpl = refusingFetch();
    const report = await runDoctor(opts);
    expect(report.ok).toBe(false);
    const hub = check(report, "hub");
    expect(hub.status).toBe("fail");
    expect(hub.fix).toContain("tut serve");
  });

  it("warns (not fails) on hub-reported degraded tasks", async () => {
    const opts = baseOptions(healthyRoot());
    opts.fetchImpl = healthyFetch({ flow_mode: "auto", tasks: [], degraded: ["demo-task"] });
    const report = await runDoctor(opts);
    const hub = check(report, "hub");
    expect(hub.status).toBe("warn");
    expect(hub.details.join(" ")).toContain("degraded");
  });

  it("fails on a 200 whose body is not a /state document", async () => {
    const opts = baseOptions(healthyRoot());
    opts.fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const report = await runDoctor(opts);
    expect(check(report, "hub").status).toBe("fail");
  });
});

// --- check 2: notifier -------------------------------------------------------------

describe("tut doctor notifier check", () => {
  it("warns (not fails) when nothing listens on the event port", async () => {
    const opts = baseOptions(healthyRoot());
    opts.fetchImpl = (async (input: unknown) => {
      const url = urlOf(input);
      if (url.includes("/agent-event")) throw new TypeError("refused");
      return healthyFetch()(input as never);
    }) as unknown as typeof fetch;
    const report = await runDoctor(opts);
    expect(report.ok).toBe(true);
    const notifier = check(report, "notifier");
    expect(notifier.status).toBe("warn");
    expect(notifier.fix).toContain("tut notify");
  });

  it("fails when a non-notifier service occupies the event port", async () => {
    const opts = baseOptions(healthyRoot());
    opts.fetchImpl = (async (input: unknown) => {
      const url = urlOf(input);
      if (url.includes("/agent-event")) return new Response("hello", { status: 200 });
      return healthyFetch()(input as never);
    }) as unknown as typeof fetch;
    const report = await runDoctor(opts);
    expect(report.ok).toBe(false);
    const notifier = check(report, "notifier");
    expect(notifier.status).toBe("fail");
    expect(notifier.summary).toContain("EADDRINUSE");
    expect(notifier.fix).toContain("TUT_EVENT_PORT_URL");
  });

  it("fails statically when the hub URL and event port collide", async () => {
    const opts = baseOptions(healthyRoot());
    opts.url = "http://127.0.0.1:3002"; // hub on the notifier's default event port
    const report = await runDoctor(opts);
    const notifier = check(report, "notifier");
    expect(notifier.status).toBe("fail");
    expect(notifier.summary).toContain("SAME");
  });
});

// --- check 3: config / workspace chain ----------------------------------------------

describe("tut doctor config check", () => {
  it("fails on a corrupt config.json with hand-fix guidance", async () => {
    const root = healthyRoot();
    writeFileSync(path.join(root, "config.json"), "{ not json");
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    const config = check(report, "config");
    expect(config.status).toBe("fail");
    expect(config.fix).toContain("config.json");
  });

  it("fails on a corrupt L1 workspace.json (the chain silently falls through)", async () => {
    const root = healthyRoot();
    writeFileSync(path.join(root, "workspace.json"), "{ broken");
    const report = await runDoctor(baseOptions(root));
    const config = check(report, "config");
    expect(config.status).toBe("fail");
    expect(config.details.join(" ")).toContain("falls through");
  });

  it("shows the effective three-level resolution and the unknown-role fallback", async () => {
    const root = healthyRoot();
    const { env, userDir } = fixtureEnv();
    writeFileSync(
      path.join(root, "workspace.json"),
      JSON.stringify({ roles: { executor: { agent: "node" }, auditor: { agent: "node" } } }),
    );
    writeFileSync(path.join(userDir, "workspace.json"), JSON.stringify({ roles: { reviewer: { agent: "node" } } }));
    const report = await runDoctor({
      root,
      environment: env,
      fetchImpl: healthyFetch(),
      resolveTarget: okResolveTarget(),
    });
    const config = check(report, "config");
    const text = config.details.join("\n");
    expect(text).toContain("L1 project");
    expect(text).toContain("executor=node");
    expect(text).toContain("L2 user");
    expect(text).toContain("reviewer=node");
    expect(text).toContain("effective architect → codex (builtin-default)");
    expect(text).toContain("effective executor → node (workspace-project)");
    expect(text).toContain("effective reviewer → node (workspace-user)");
    expect(text).toContain("unknown-role fallback");
    expect(config.status).toBe("warn"); // auditor is an unknown role
    // agents check covers the declared extra role too
    expect(check(report, "agents").details.join("\n")).toContain("node");
  });

  it("fails on bare-string role entries the chain silently drops", async () => {
    const root = healthyRoot();
    writeFileSync(path.join(root, "workspace.json"), JSON.stringify({ roles: { executor: "node" } }));
    const report = await runDoctor(baseOptions(root));
    const config = check(report, "config");
    expect(config.status).toBe("fail");
    expect(config.details.join("\n")).toContain("roles.executor: malformed");
    expect(config.details.join("\n")).toContain("silently treats it as absent");
    expect(report.ok).toBe(false);
  });
});

// --- check 4: agents ----------------------------------------------------------------

describe("tut doctor agents check", () => {
  it("fails with tut assign guidance when a routed agent is not on PATH", async () => {
    const opts = baseOptions(healthyRoot());
    opts.resolveTarget = async () => {
      throw new AgentTargetError("gone", "not on PATH (which exit 1, no candidate)", "install it");
    };
    const report = await runDoctor(opts);
    expect(report.ok).toBe(false);
    const agents = check(report, "agents");
    expect(agents.status).toBe("fail");
    expect(agents.fix).toContain("tut assign");
  });

  it("warns rather than fails when which itself is missing", async () => {
    const opts = baseOptions(healthyRoot());
    opts.resolveTarget = async () => {
      throw new AgentTargetError("pi", "cannot be probed (which is not installed on this system)", "install which");
    };
    const report = await runDoctor(opts);
    expect(report.ok).toBe(true);
    expect(check(report, "agents").status).toBe("warn");
  });
});

// --- check 5: storage ----------------------------------------------------------------

describe("tut doctor storage check", () => {
  it("flags corrupt meta as class A damage with a repair-meta fix", async () => {
    const root = healthyRoot();
    writeTask(root, "broken-meta", { records: [{ version: 1 }], metaOverride: "{ truncated" });
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    const storage = check(report, "storage");
    expect(storage.status).toBe("fail");
    expect(storage.summary).toContain("broken-meta");
    const text = storage.details.join("\n");
    expect(text).toContain("class A damage");
    expect(text).toContain("tut repair-meta broken-meta");
  });

  it("flags missing meta.json as class A damage", async () => {
    const root = healthyRoot();
    const dir = path.join(root, "tasks", "no-meta");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, recordName({ version: 1 })), recordJson("no-meta", { version: 1 }));
    const report = await runDoctor(baseOptions(root));
    expect(check(report, "storage").details.join("\n")).toContain("meta.json: missing");
  });

  it("flags corrupt records as class B damage with a recover-record fix", async () => {
    const root = healthyRoot();
    const dir = path.join(root, "tasks", "broken-record");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ task_id: "broken-record", title: "t", created_at: "x", updated_at: "x", version: 2 }));
    writeFileSync(path.join(dir, recordName({ version: 1 })), recordJson("broken-record", { version: 1 }));
    writeFileSync(path.join(dir, recordName({ version: 2, content_type: "review" })), "{ corrupt");
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    const text = check(report, "storage").details.join("\n");
    expect(text).toContain("class B damage");
    expect(text).toContain(`tut recover-record broken-record ${recordName({ version: 2, content_type: "review" })}`);
  });

  it("accepts a corrupt record with a verified recovery registration", async () => {
    const root = healthyRoot();
    const taskId = "recovered-task";
    const dir = path.join(root, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ task_id: taskId, title: "t", created_at: "x", updated_at: "x", version: 2 }));
    writeFileSync(path.join(dir, recordName({ version: 1 })), recordJson(taskId, { version: 1 }));
    const corruptBytes = Buffer.from("{ corrupt beyond repair");
    const recoveredBytes = Buffer.from(recordJson(taskId, { version: 2, content_type: "review" }), "utf8");
    const name = recordName({ version: 2, content_type: "review" });
    writeFileSync(path.join(dir, name), corruptBytes);
    writeFileSync(path.join(dir, `${name}.recovered`), recoveredBytes);
    writeFileSync(
      path.join(dir, "recovery.jsonl"),
      JSON.stringify({
        seq: 1,
        file: name,
        corrupt_sha256: sha256Bytes(corruptBytes),
        recovered_sha256: sha256Bytes(recoveredBytes),
        recovered_file: `${name}.recovered`,
        source: "test snapshot",
        registered_at: "2026-09-02T00:00:00.000Z",
      }) + "\n",
    );
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(true);
    const text = check(report, "storage").details.join("\n");
    expect(text).toContain("recovered (digest chain verifies)");
    expect(text).toContain("source: test snapshot");
  });

  it("voids the registration when the corrupt original was modified afterwards", async () => {
    const root = healthyRoot();
    const taskId = "voided-task";
    const dir = path.join(root, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ task_id: taskId, title: "t", created_at: "x", updated_at: "x", version: 1 }));
    const name = recordName({ version: 1 });
    const original = Buffer.from("{ corrupt");
    writeFileSync(path.join(dir, name), original);
    writeFileSync(path.join(dir, `${name}.recovered`), Buffer.from(recordJson(taskId, { version: 1 }), "utf8"));
    writeFileSync(
      path.join(dir, "recovery.jsonl"),
      JSON.stringify({
        seq: 1,
        file: name,
        corrupt_sha256: sha256Bytes(Buffer.from("{ different corruption")),
        recovered_sha256: sha256Bytes(readFileSync(path.join(dir, `${name}.recovered`))),
        recovered_file: `${name}.recovered`,
        source: "test",
        registered_at: "2026-09-02T00:00:00.000Z",
      }) + "\n",
    );
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    expect(check(report, "storage").details.join("\n")).toContain("registration void");
  });

  it("warns on version gaps (deleted records)", async () => {
    const root = healthyRoot();
    writeTask(root, "gappy", { records: [{ version: 1 }, { version: 3 }] });
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(true);
    const text = check(report, "storage").details.join("\n");
    expect(text).toContain("version gap (VERSION_GAP): v2..v2 missing");
  });

  it("warns on foreign directory names the hub ignores entirely", async () => {
    const root = healthyRoot();
    mkdirSync(path.join(root, "tasks", "Not A Task"), { recursive: true });
    const report = await runDoctor(baseOptions(root));
    expect(check(report, "storage").details.join("\n")).toContain("foreign directory name");
  });

  it("warns when the hub reports degraded the local scan cannot see", async () => {
    const opts = baseOptions(healthyRoot());
    opts.fetchImpl = healthyFetch({
      flow_mode: "manual",
      tasks: [],
      degraded: ["phantom-task"],
    });
    const report = await runDoctor(opts);
    const text = check(report, "storage").details.join("\n");
    expect(text).toContain("phantom-task");
    expect(text).toContain("classification authority");
  });

  it("states the class-C whole-deletion boundary", async () => {
    const report = await runDoctor(baseOptions(healthyRoot()));
    expect(check(report, "storage").details.join("\n")).toContain("Notifier's snapshot diff");
  });

  it("warns when delivery.log exceeds the rotation cap", async () => {
    const root = healthyRoot();
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x20);
    writeFileSync(path.join(root, "delivery.log"), big);
    const report = await runDoctor(baseOptions(root));
    expect(check(report, "storage").status).toBe("warn");
    expect(check(report, "storage").details.join("\n")).toContain("rotation");
  });
});

// --- check 6: paths -------------------------------------------------------------------

describe("tut doctor paths check", () => {
  it("warns on spaces, fails on shell metacharacters (posix)", async () => {
    const spaced = path.join(tmp, "pro ject", ".context-hub");
    mkdirSync(path.join(tmp, "pro ject"), { recursive: true });
    const reportSpaced = await runDoctor(baseOptions(spaced));
    expect(check(reportSpaced, "paths").status).toBe("warn");
    expect(check(reportSpaced, "paths").details.join("\n")).toContain("contains spaces");

    const hostile = path.join(tmp, "pro$ject", ".context-hub");
    mkdirSync(path.join(tmp, "pro$ject"), { recursive: true });
    const reportHostile = await runDoctor({ ...baseOptions(hostile), platform: "darwin" });
    expect(check(reportHostile, "paths").status).toBe("fail");
    expect(check(reportHostile, "paths").details.join("\n")).toContain("metacharacters");
  });

  it("warns when TUT_DELIVERY_PROBE_DIR overflows sun_path", async () => {
    const opts = baseOptions(healthyRoot());
    opts.environment = { ...opts.environment, TUT_DELIVERY_PROBE_DIR: `/tmp/${"d".repeat(85)}` };
    opts.platform = "darwin";
    const report = await runDoctor(opts);
    const paths = check(report, "paths");
    expect(paths.status).toBe("warn");
    expect(paths.details.join("\n")).toContain("sun_path");
  });
});

// --- check 7: platform -----------------------------------------------------------------

describe("tut doctor platform check", () => {
  it("warns below the Node engines floor", async () => {
    const opts = baseOptions(healthyRoot());
    opts.nodeVersion = "18.19.0";
    const report = await runDoctor(opts);
    expect(check(report, "platform").status).toBe("warn");
    expect(check(report, "platform").details.join("\n")).toContain(">=20");
  });

  it("fails on an unknown TUT_PANE_SHELL dialect", async () => {
    const opts = baseOptions(healthyRoot());
    opts.environment = { ...opts.environment, TUT_PANE_SHELL: "fish" };
    const report = await runDoctor(opts);
    const platform = check(report, "platform");
    expect(platform.status).toBe("fail");
    expect(platform.fix).toContain("TUT_PANE_SHELL");
  });

  it("lists env knobs and the TUT_SUBMIT_RETRY_TIMEOUT_MS hint", async () => {
    const report = await runDoctor(baseOptions(healthyRoot()));
    const text = check(report, "platform").details.join("\n");
    expect(text).toContain("TUT_SUBMIT_RETRY_TIMEOUT_MS unset");
    expect(text).toContain("TUT_SUBMIT_RETRY_TIMEOUT_MS raised");
  });
});

// --- check 8: agent channel -------------------------------------------------------------

describe("tut doctor agent-channel check", () => {
  function seatsOf(report: DoctorReport): AgentChannelSeatVerdict[] {
    return check(report, "agent-channel").seats ?? [];
  }

  function verdictOf(report: DoctorReport, role: string): AgentChannelSeatVerdict {
    const found = seatsOf(report).find((s) => s.role === role);
    if (found === undefined) throw new Error(`no seat verdict for ${role}`);
    return found;
  }

  it("marks codex sandbox seats infeasible with a stable machine-readable reason", async () => {
    const root = healthyRoot();
    const { env } = fixtureEnv();
    writeFileSync(
      path.join(root, "workspace.json"),
      JSON.stringify({
        roles: {
          executor: { agent: "node" },
          reviewer: { agent: "codex", args: ["--sandbox", "workspace-write"] },
        },
      }),
    );
    const report = await runDoctor({ root, environment: env, fetchImpl: healthyFetch(), resolveTarget: okResolveTarget() });
    const channel = check(report, "agent-channel");
    expect(channel.status).toBe("warn");
    expect(verdictOf(report, "reviewer")).toMatchObject({
      agent: "codex",
      code: "infeasible",
      reason: "sandbox-network-denied",
    });
    // non-codex seats carry no per-seat network evidence — unknown, not feasible
    expect(verdictOf(report, "executor")).toMatchObject({ code: "unknown", reason: "agent-posture-unverified" });
    expect(channel.details.join("\n")).toContain("codex --sandbox workspace-write denies outbound network");
    expect(channel.fix).toContain("danger-full-access");
    expect(channel.details.join("\n")).toContain("loopback UDS hub channel: infeasible (not-shipped)");
    expect(report.ok).toBe(true); // warn, not fail
  });

  it("reserves feasible for seats with per-seat evidence (codex danger-full-access only)", async () => {
    const root = healthyRoot();
    const { env } = fixtureEnv();
    writeFileSync(
      path.join(root, "workspace.json"),
      JSON.stringify({
        roles: {
          executor: { agent: "node" },
          reviewer: { agent: "codex", args: ["--sandbox=danger-full-access"] },
        },
      }),
    );
    const report = await runDoctor({ root, environment: env, fetchImpl: healthyFetch(), resolveTarget: okResolveTarget() });
    expect(check(report, "agent-channel").status).toBe("ok");
    expect(verdictOf(report, "reviewer")).toMatchObject({ code: "feasible", reason: "sandbox-allows-network" });
    // host-level loopback reachability is NOT seat evidence for non-codex
    expect(verdictOf(report, "executor")).toMatchObject({ code: "unknown", reason: "agent-posture-unverified" });
    // architect stays the builtin codex WITHOUT an explicit flag → honest unknown
    expect(verdictOf(report, "architect")).toMatchObject({ code: "unknown", reason: "sandbox-posture-unverified" });
  });

  it("exposes the UDS channel status as a stable machine-readable verdict", async () => {
    const report = await runDoctor(baseOptions(healthyRoot()));
    const channel = check(report, "agent-channel");
    expect(channel.uds).toMatchObject({ code: "infeasible", reason: "not-shipped" });
    expect(channel.uds?.evidence).toContain("no UDS channel exists");
    expect(channel.uds?.action).toContain("danger-full-access");
    // text output comes from the same verdict object (same-source contract)
    const line = channel.details.find((d) => d.startsWith("loopback UDS hub channel"));
    expect(line).toContain("infeasible (not-shipped)");
    expect(line).toContain(channel.uds?.evidence ?? "");
  });

  it("withholds the verdict (unknown/hub-unreachable) for every seat when the hub is down", async () => {
    const root = healthyRoot();
    const opts = baseOptions(root);
    opts.fetchImpl = refusingFetch();
    const report = await runDoctor(opts);
    expect(check(report, "hub").status).toBe("fail");
    for (const seat of seatsOf(report)) {
      expect(seat.code).toBe("unknown");
      expect(seat.reason).toBe("hub-unreachable");
    }
  });

  it("withholds the verdict (unknown/agent-cli-missing) when the seat's CLI is gone", async () => {
    const root = healthyRoot();
    const opts = baseOptions(root);
    opts.resolveTarget = async () => {
      throw new AgentTargetError("node", "not on PATH (which exit 1, no candidate)", "install it");
    };
    const report = await runDoctor(opts);
    for (const seat of seatsOf(report)) {
      expect(seat.code).toBe("unknown");
      expect(seat.reason).toBe("agent-cli-missing");
    }
  });

  it("reports unknown/sandbox-posture-unverified for codex without an explicit flag", async () => {
    const root = healthyRoot();
    const { env } = fixtureEnv();
    writeFileSync(path.join(root, "workspace.json"), JSON.stringify({ roles: { architect: { agent: "codex" } } }));
    const report = await runDoctor({ root, environment: env, fetchImpl: healthyFetch(), resolveTarget: okResolveTarget() });
    expect(verdictOf(report, "architect")).toMatchObject({ code: "unknown", reason: "sandbox-posture-unverified" });
    expect(check(report, "agent-channel").status).toBe("ok"); // unknown is honest, not a finding
  });
});

// --- rendering --------------------------------------------------------------------------

describe("renderDoctorReport", () => {
  it("renders numbered checks, fix lines, and the result line", async () => {
    const opts = baseOptions(healthyRoot());
    opts.fetchImpl = refusingFetch();
    const report = await runDoctor(opts);
    const text = renderDoctorReport(report);
    expect(text).toContain("tut doctor — report-only");
    expect(text).toContain("1. hub reachable [FAIL]");
    expect(text).toContain("fix: tut serve");
    expect(text).toContain("result: FAIL");
  });
});

// --- storage classification consistency with the Store -------------------------------

describe("doctor vs Store classification consistency (shared validators)", () => {
  /** The dual assertion: the same fixture must land in the Store's degraded
   *  list AND in doctor's failing findings — one authority, one verdict. */
  async function expectDamageSeenByBoth(
    root: string,
    taskId: string,
    textPattern: RegExp,
  ): Promise<void> {
    const snapshot = await new Store(root).snapshotTasks();
    expect(snapshot.degraded).toContain(taskId);
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    const text = check(report, "storage").details.join("\n");
    expect(text).toMatch(textPattern);
    expect(check(report, "storage").summary).toContain(taskId);
  }

  it("flags a record whose task_id belongs to another task (Store: degraded)", async () => {
    const root = healthyRoot();
    writeTask(root, "identity-crisis", {
      records: [{ version: 1 }],
      extraFiles: {
        [recordName({ version: 2 })]: JSON.stringify({
          version: 2,
          task_id: "some-other-task",
          role: "executor",
          content_type: "note",
          timestamp: "2026-09-02T00:00:00.000Z",
          payload: { summary: "v2", body: "fixture body" },
        }),
      },
    });
    await expectDamageSeenByBoth(root, "identity-crisis", /task_id must be identity-crisis.*class B damage/us);
  });

  it("flags a record with a blank payload.body (Store: degraded)", async () => {
    const root = healthyRoot();
    writeTask(root, "blank-body", {
      records: [{ version: 1 }],
      extraFiles: {
        [recordName({ version: 2 })]: JSON.stringify({
          version: 2,
          task_id: "blank-body",
          role: "executor",
          content_type: "note",
          timestamp: "2026-09-02T00:00:00.000Z",
          payload: { summary: "v2", body: "   " },
        }),
      },
    });
    await expectDamageSeenByBoth(root, "blank-body", /payload\.body must be a non-empty string.*class B damage/us);
  });

  it("flags meta missing created_at (Store: degraded, class A)", async () => {
    const root = healthyRoot();
    writeTask(root, "meta-no-created", {
      records: [{ version: 1 }],
      metaOverride: JSON.stringify({ task_id: "meta-no-created", title: "t", updated_at: "x", version: 1 }),
    });
    await expectDamageSeenByBoth(root, "meta-no-created", /created_at must be a non-empty string.*class A damage/us);
  });

  it("flags meta with an invalid flow / cast / checkout (Store: degraded, class A)", async () => {
    const rootA = healthyRoot();
    writeTask(rootA, "meta-bad-flow", {
      records: [{ version: 1 }],
      metaOverride: JSON.stringify({
        task_id: "meta-bad-flow", title: "t", created_at: "x", updated_at: "x", version: 1, flow: "bogus",
      }),
    });
    await expectDamageSeenByBoth(rootA, "meta-bad-flow", /flow must be full, direct, or solo.*class A damage/us);

    const rootB = healthyRoot();
    writeTask(rootB, "meta-bad-cast", {
      records: [{ version: 1 }],
      metaOverride: JSON.stringify({
        task_id: "meta-bad-cast", title: "t", created_at: "x", updated_at: "x", version: 1, cast: { executor: 42 },
      }),
    });
    await expectDamageSeenByBoth(rootB, "meta-bad-cast", /cast.*class A damage/us);

    const rootC = healthyRoot();
    writeTask(rootC, "meta-bad-checkout", {
      records: [{ version: 1 }],
      metaOverride: JSON.stringify({
        task_id: "meta-bad-checkout", title: "t", created_at: "x", updated_at: "x", version: 1,
        checkout: { kind: "elsewhere" },
      }),
    });
    await expectDamageSeenByBoth(rootC, "meta-bad-checkout", /checkout\.kind must be current or worktree.*class A damage/us);
  });

  it("refuses a recovery whose copy belongs to another task (Store stays degraded)", async () => {
    const root = healthyRoot();
    const taskId = "cross-task-recovery";
    const dir = path.join(root, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ task_id: taskId, title: "t", created_at: "x", updated_at: "x", version: 1 }));
    const name = recordName({ version: 1 });
    const corruptBytes = Buffer.from("{ corrupt");
    // A well-formed record — but for a DIFFERENT task: the Store's
    // recoveredRecordFor validates with taskId and must refuse it.
    const recoveredBytes = Buffer.from(recordJson("some-other-task", { version: 1 }), "utf8");
    writeFileSync(path.join(dir, name), corruptBytes);
    writeFileSync(path.join(dir, `${name}.recovered`), recoveredBytes);
    writeFileSync(
      path.join(dir, "recovery.jsonl"),
      JSON.stringify({
        file: name,
        corrupt_sha256: sha256Bytes(corruptBytes),
        recovered_sha256: sha256Bytes(recoveredBytes),
        recovered_file: `${name}.recovered`,
        source: "mistaken backup",
        registered_at: "2026-09-02T00:00:00.000Z",
      }) + "\n",
    );
    await expectDamageSeenByBoth(root, taskId, /task_id must be some-other-task|task_id must be cross-task-recovery.*class B damage/us);
  });
});

// --- bad-input isolation ---------------------------------------------------------------

describe("tut doctor bad-input isolation (never crashes, always reports)", () => {
  it("turns an invalid --url into a failing hub check with guidance", async () => {
    const opts = baseOptions(healthyRoot());
    opts.url = "not a url at all";
    const report = await runDoctor(opts);
    expect(report.ok).toBe(false);
    const hub = check(report, "hub");
    expect(hub.status).toBe("fail");
    expect(hub.summary).toContain("invalid hub URL");
    expect(typeof renderDoctorReport(report)).toBe("string"); // text mode renders too
  });

  it("turns an invalid TUT_EVENT_PORT_URL into a failing notifier check", async () => {
    const opts = baseOptions(healthyRoot());
    opts.environment = { ...opts.environment, TUT_EVENT_PORT_URL: "::::" };
    const report = await runDoctor(opts);
    expect(report.ok).toBe(false);
    const notifier = check(report, "notifier");
    expect(notifier.status).toBe("fail");
    expect(notifier.summary).toContain("invalid event-port URL");
    expect(notifier.fix).toContain("TUT_EVENT_PORT_URL");
  });

  it("classifies malformed workspace route args instead of casting them", async () => {
    const root = healthyRoot();
    writeFileSync(path.join(root, "workspace.json"), JSON.stringify({ roles: { executor: { agent: "node", args: "--flags" } } }));
    const report = await runDoctor(baseOptions(root));
    const config = check(report, "config");
    expect(config.status).toBe("fail");
    expect(config.details.join("\n")).toContain("roles.executor: malformed");
    expect(config.details.join("\n")).toContain("args must be an array");
    // the chain falls through to the builtin default instead of crashing
    expect(config.details.join("\n")).toContain("effective executor → pi (builtin-default)");
  });

  it("fails (not crashes) on a /state body with null task entries or a non-array auto.launch_roles", async () => {
    const malformed = [
      { flow_mode: "manual", tasks: [null] },
      { flow_mode: "manual", tasks: [], auto: { launch_roles: "architect" } },
      { flow_mode: "manual", tasks: [{ task_id: "" }] },
      { flow_mode: "manual", tasks: [], degraded: [42] },
      { flow_mode: "bogus", tasks: [] }, // out-of-domain flow_mode
      { flow_mode: "manual", tasks: [{ task_id: "t", needs_attention: "yes" }] }, // wrong-typed field
      { flow_mode: "manual", tasks: [{ task_id: "t", version: "2" }] }, // version not an integer
      { flow_mode: "manual", tasks: [{ task_id: "t", flow: "turbo" }] }, // task flow outside the enum
    ];
    for (const body of malformed) {
      const opts = baseOptions(healthyRoot());
      opts.fetchImpl = healthyFetch(body as unknown as Record<string, unknown>);
      const report = await runDoctor(opts);
      const hub = check(report, "hub");
      expect(hub.status, JSON.stringify(body)).toBe("fail");
      expect(hub.summary, JSON.stringify(body)).toContain("not a TUT /state document");
    }
  });

  it("converts an unexpected throw inside any check into that check's failure (runner guard)", async () => {
    const opts = baseOptions(healthyRoot());
    // An env whose every property access throws — every check that reads a
    // knob crashes; the report must still render with per-check failures.
    opts.environment = new Proxy({}, {
      get() {
        throw new Error("env boom");
      },
    }) as unknown as NodeJS.ProcessEnv;
    const report = await runDoctor(opts);
    expect(report.ok).toBe(false);
    const crashed = report.checks.filter((c) => c.summary.includes("internal error — this check crashed"));
    expect(crashed.length).toBeGreaterThan(0);
    const text = renderDoctorReport(report);
    expect(text).toContain("result: FAIL");
    expect(text).toContain("report-only");
  });
});

// --- recovery manifest semantics ---------------------------------------------------------

describe("tut doctor recovery manifest semantics (mirrors readRecoveryEntries)", () => {
  function recoveredFixture(root: string, manifestLines: string[]): void {
    const taskId = "manifest-task";
    const dir = path.join(root, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ task_id: taskId, title: "t", created_at: "x", updated_at: "x", version: 2 }));
    writeFileSync(path.join(dir, recordName({ version: 1 })), recordJson(taskId, { version: 1 }));
    const name = recordName({ version: 2, content_type: "review" });
    const corruptBytes = Buffer.from("{ corrupt beyond repair");
    const recoveredBytes = Buffer.from(recordJson(taskId, { version: 2, content_type: "review" }), "utf8");
    writeFileSync(path.join(dir, name), corruptBytes);
    writeFileSync(path.join(dir, `${name}.recovered`), recoveredBytes);
    writeFileSync(
      path.join(dir, "recovery.jsonl"),
      manifestLines.join("\n") + "\n",
    );
  }

  it("judges recovered (with an explicit warning) when a valid registration sits beside bad lines", async () => {
    const root = healthyRoot();
    const name = recordName({ version: 2, content_type: "review" });
    const dir = path.join(root, "tasks", "manifest-task");
    const corruptBytes = Buffer.from("{ corrupt beyond repair");
    const recoveredBytes = Buffer.from(recordJson("manifest-task", { version: 2, content_type: "review" }), "utf8");
    recoveredFixture(root, [
      "{ this line is garbage json",
      JSON.stringify({
        file: name,
        corrupt_sha256: sha256Bytes(corruptBytes),
        recovered_sha256: sha256Bytes(recoveredBytes),
        recovered_file: `${name}.recovered`,
        source: "test snapshot",
        registered_at: "2026-09-02T00:00:00.000Z",
      }),
    ]);
    void dir;
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(true); // recovered, warn-level
    const storage = check(report, "storage");
    expect(storage.status).toBe("warn");
    const text = storage.details.join("\n");
    expect(text).toContain("recovered (digest chain verifies)");
    expect(text).toContain("unparseable manifest line(s) skipped");
    expect(text).toContain("last valid registration");
  });

  it("fails with evidence and an action when recovery.jsonl exists but cannot be read", async () => {
    const root = healthyRoot();
    const taskId = "squatted-manifest";
    const dir = path.join(root, "tasks", taskId);
    mkdirSync(path.join(dir, "recovery.jsonl"), { recursive: true }); // a directory squats on the name — EISDIR
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ task_id: taskId, title: "t", created_at: "x", updated_at: "x", version: 1 }));
    writeFileSync(path.join(dir, recordName({ version: 1 })), recordJson(taskId, { version: 1 }));
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    const storage = check(report, "storage");
    expect(storage.status).toBe("fail");
    const text = storage.details.join("\n");
    expect(text).toContain("recovery.jsonl: unreadable");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("restore read access");
  });
});

// --- version-domain scan -------------------------------------------------------------------

describe("tut doctor version-domain scan (mirrors derive)", () => {
  it("warns on a leading gap (records start above v1)", async () => {
    const root = healthyRoot();
    writeTask(root, "leading-gap", { records: [{ version: 3 }] });
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(true);
    const text = check(report, "storage").details.join("\n");
    expect(text).toContain("version gap (VERSION_GAP): v1..v2 missing");
    expect(text).toContain("leading gap");
  });

  it("warns on duplicate versions (two files claiming one version)", async () => {
    const root = healthyRoot();
    const dir = path.join(root, "tasks", "dup-task");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ task_id: "dup-task", title: "t", created_at: "x", updated_at: "x", version: 2 }));
    writeFileSync(path.join(dir, "v001.note.json"), recordJson("dup-task", { version: 1 }));
    writeFileSync(path.join(dir, "v001.note.bis.json"), recordJson("dup-task", { version: 1 }));
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(true);
    const text = check(report, "storage").details.join("\n");
    expect(text).toContain("duplicate version (VERSION_DUPLICATE): v1 present in 2 files");
  });
});

// --- workspace route acceptance ----------------------------------------------------------

describe("tut doctor workspace route acceptance (production validators)", () => {
  function configText(report: DoctorReport): string {
    return check(report, "config").details.join("\n");
  }

  it("fails on a non-object top-level roles container (string/array)", async () => {
    const root = healthyRoot();
    writeFileSync(path.join(root, "workspace.json"), JSON.stringify({ roles: "codex --sandbox read-only" }));
    let report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    expect(check(report, "config").status).toBe("fail");
    expect(configText(report)).toContain("roles must be an object");

    const root2 = healthyRoot();
    writeFileSync(path.join(root2, "workspace.json"), JSON.stringify({ roles: [{ agent: "node" }] }));
    report = await runDoctor(baseOptions(root2));
    expect(check(report, "config").status).toBe("fail");
    expect(configText(report)).toContain("roles must be an object");
  });

  it("fails (not silently passes) on an illegal shell token in agent", async () => {
    const root = healthyRoot();
    // The round-2 review's exact probe: runDoctor used to return ok:true and
    // print this illegal route while resolution fell back to the builtin.
    writeFileSync(path.join(root, "workspace.json"), JSON.stringify({ roles: { executor: { agent: "codex;" } } }));
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    const config = check(report, "config");
    expect(config.status).toBe("fail");
    expect(configText(report)).toContain("roles.executor: malformed");
    expect(configText(report)).toContain("shell-neutral");
    expect(config.fix).toContain("tut assign executor");
    expect(typeof renderDoctorReport(report)).toBe("string");
  });

  it("fails on an illegal token inside args", async () => {
    const root = healthyRoot();
    writeFileSync(
      path.join(root, "workspace.json"),
      JSON.stringify({ roles: { reviewer: { agent: "codex", args: ["--sandbox", "read|write"] } } }),
    );
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(false);
    expect(configText(report)).toContain("roles.reviewer: malformed");
    expect(configText(report)).toContain("args[1]");
  });

  it("still parses multi-word command strings the way the chain does", async () => {
    const root = healthyRoot();
    writeFileSync(
      path.join(root, "workspace.json"),
      JSON.stringify({ roles: { reviewer: { agent: "codex --sandbox danger-full-access" } } }),
    );
    const report = await runDoctor(baseOptions(root));
    expect(check(report, "config").status).toBe("ok"); // naming/unknown-role warns aside, this entry is legal
    expect(configText(report)).toContain("reviewer=codex --sandbox danger-full-access");
  });
});

// --- manifest shape warnings ---------------------------------------------------------------

describe("tut doctor manifest shape warnings (schema-invalid lines)", () => {
  it("warns on schema-invalid lines even when no record is damaged", async () => {
    const root = healthyRoot();
    writeTask(root, "rotting-manifest", {
      records: [{ version: 1 }],
      extraFiles: { "recovery.jsonl": '{"file": 42}\n{"also":"wrong shape"}\n' },
    });
    const report = await runDoctor(baseOptions(root));
    const storage = check(report, "storage");
    expect(storage.status).toBe("warn");
    const text = storage.details.join("\n");
    expect(text).toContain("recovery.jsonl: 2 line(s) skipped (unparseable or wrong shape)");
    expect(text).toContain("the last valid one stands");
  });

  it("counts schema-invalid lines beside a valid registration (recovered still holds, warn visible)", async () => {
    const root = healthyRoot();
    const taskId = "mixed-manifest";
    const dir = path.join(root, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ task_id: taskId, title: "t", created_at: "x", updated_at: "x", version: 2 }));
    writeFileSync(path.join(dir, recordName({ version: 1 })), recordJson(taskId, { version: 1 }));
    const name = recordName({ version: 2, content_type: "review" });
    const corruptBytes = Buffer.from("{ corrupt beyond repair");
    const recoveredBytes = Buffer.from(recordJson(taskId, { version: 2, content_type: "review" }), "utf8");
    writeFileSync(path.join(dir, name), corruptBytes);
    writeFileSync(path.join(dir, `${name}.recovered`), recoveredBytes);
    writeFileSync(
      path.join(dir, "recovery.jsonl"),
      [
        '{"file": 42}', // valid JSON, wrong shape — counted now
        JSON.stringify({
          file: name,
          corrupt_sha256: sha256Bytes(corruptBytes),
          recovered_sha256: sha256Bytes(recoveredBytes),
          recovered_file: `${name}.recovered`,
          source: "test snapshot",
          registered_at: "2026-09-02T00:00:00.000Z",
        }),
      ].join("\n") + "\n",
    );
    const report = await runDoctor(baseOptions(root));
    expect(report.ok).toBe(true); // recovered holds, warn-level
    const storage = check(report, "storage");
    expect(storage.status).toBe("warn");
    const text = storage.details.join("\n");
    expect(text).toContain("recovered (digest chain verifies)");
    expect(text).toContain("1 line(s) skipped (unparseable or wrong shape)");
  });
});


describe("rig hash collision diagnosis", () => {
  it("reports distinct roots sharing a live system-label suffix", async () => {
    const hash = vi.spyOn(rig, "rigHash").mockReturnValue("deadbeef");
    const list = vi.spyOn(HerdrClient.prototype, "paneList").mockResolvedValue({ panes: [
      { pane_id: "a", label: "tut-hub-deadbeef", cwd: "/rig-one" },
      { pane_id: "b", label: "tut-notify-deadbeef", cwd: "/rig-two" },
    ] });
    try {
      const report = await runDoctor(baseOptions(healthyRoot()));
      expect(check(report, "paths").status).toBe("fail");
      expect(check(report, "paths").details.join("\n")).toContain("rigHash collision deadbeef: /rig-one <-> /rig-two");
      expect(report.ok).toBe(false);
    } finally { hash.mockRestore(); list.mockRestore(); }
  });

  it("does not mistake two services or task checkout paths for a collision", async () => {
    const hash = vi.spyOn(rig, "rigHash").mockReturnValue("deadbeef");
    const list = vi.spyOn(HerdrClient.prototype, "paneList").mockResolvedValue({ panes: [
      { pane_id: "a", label: "tut-hub-deadbeef", cwd: "/rig-one" },
      { pane_id: "b", label: "tut-notify-deadbeef", cwd: "/rig-one" },
      { pane_id: "c", label: "task.executor-deadbeef", cwd: "/checkout" },
    ] });
    try {
      expect(check(await runDoctor(baseOptions(healthyRoot())), "paths").status).toBe("ok");
    } finally { hash.mockRestore(); list.mockRestore(); }
  });
});

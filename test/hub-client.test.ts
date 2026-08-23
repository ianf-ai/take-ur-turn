/**
 * hub-client tests: the five CLI-equivalent functions
 * against a REAL startServer on an ephemeral port — same server the SDK e2e
 * suite drives, so these double as the "schema 同源" check: inputs pass
 * context.*'s zod envelopes and results match the store's JSON exactly.
 * isError results must surface as HubError with the first-line code.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { startServer, type RunningServer } from "../src/server.js";
import { hubCreate, hubDecide, hubList, hubPublish, hubRead, HubError } from "../src/hub-client.js";

let tmp: string;
let running: RunningServer;
let baseUrl: string;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-hubclient-"));
  const root = path.join(tmp, ".context-hub");
  running = await startServer({ root, port: 0 });
  baseUrl = running.url;
});

afterEach(async () => {
  await running.close().catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
});

describe("hub-client happy path (mirrors the MCP tool schemas)", () => {
  it("create → publish → read → list → decide walks the full lifecycle", async () => {
    const created = await hubCreate(baseUrl, {
      title: "Hub Client Task",
      description: "driven through the CLI thin client",
      creator: "tester",
      role: "architect",
    });
    expect(created).toEqual({ task_id: "hub-client-task", status: "designing", version: 0 });

    const published = await hubPublish(baseUrl, {
      task_id: created.task_id,
      role: "architect",
      content_type: "design",
      payload: { summary: "the design", body: "do the thing", ref_version: 0 },
    });
    expect(published).toEqual({
      task_id: created.task_id,
      version: 1,
      status: "implementing",
      needs_attention: false,
    });

    const read = await hubRead(baseUrl, created.task_id);
    expect(read.task_id).toBe(created.task_id);
    expect(read.title).toBe("Hub Client Task");
    expect(read.status).toBe("implementing");
    expect(read.versions).toHaveLength(1);
    expect(read.versions[0]?.content_type).toBe("design");
    expect(read.versions[0]?.payload.summary).toBe("the design");

    const listed = await hubList(baseUrl);
    const entry = listed.tasks.find((t) => t.task_id === created.task_id);
    expect(entry).toMatchObject({ status: "implementing", waiting_for: "agent:executor", needs_attention: false });

    const decided = await hubDecide(baseUrl, { task_id: created.task_id, decision: "close", by: "alice" });
    expect(decided).toEqual({ task_id: created.task_id, status: "closed" });
  });

  it("bootstrap: create → read exposes the full requirement — description verbatim, flow normalized, cast intact", async () => {
    // The architect's doorbell prompt carries only the task_id, so
    // the FIRST context.read after creation must yield the entire
    // requirement (description with acceptance criteria) plus the flow/cast
    // the initiating side chose — self-bootstrapping needs nothing else.
    const description = "任务创建改由发起侧执行：发起侧建任务后首轮即普通轮。\n验收：①flow/cast 为命令旗子；②首轮即普通轮；③测试覆盖。";
    const created = await hubCreate(baseUrl, {
      title: "Bootstrap Task",
      description,
      creator: "host",
      role: "human",
      flow: "full",
      cast: { architect: "pi", executor: "pi", reviewer: "pi" },
    });
    expect(created).toEqual({ task_id: "bootstrap-task", status: "designing", version: 0 });

    const read = await hubRead(baseUrl, created.task_id);
    expect(read.description).toBe(description); // verbatim, multi-line acceptance text included
    expect(read.flow).toBe("full");
    expect(read.cast).toEqual({ architect: "pi", executor: "pi", reviewer: "pi" });
    expect(read.status).toBe("designing"); // full flow: the first round waits on the architect
  });

  it("publish passes optional fields verbatim (agent/model/expected_version, payload envelope)", async () => {
    const created = await hubCreate(baseUrl, {
      title: "Verbatim Task",
      description: "d",
      creator: "tester",
      role: "architect",
    });

    const published = await hubPublish(baseUrl, {
      task_id: created.task_id,
      role: "reviewer",
      content_type: "review",
      payload: { summary: "s", body: "b", verdict: "pass", commits: ["a1b2c3d", "e4f5a6b"] },
      agent: "codex",
      model: "gpt",
      expected_version: 0,
    });
    expect(published.version).toBe(1);

    const read = await hubRead(baseUrl, created.task_id);
    const record = read.versions[0]!;
    expect(record.agent).toBe("codex");
    expect(record.model).toBe("gpt");
    expect(record.payload.verdict).toBe("pass");
    expect(record.payload.commits).toEqual(["a1b2c3d", "e4f5a6b"]);
  });

  it("read honors since_version; list honors the status filter and project scope", async () => {
    await hubPublish(baseUrl, {
      task_id: "project",
      role: "human",
      content_type: "note",
      payload: { summary: "project note", body: "b" },
    });
    const created = await hubCreate(baseUrl, { title: "Filtered Task", description: "d", creator: "t", role: "architect" });
    await hubPublish(baseUrl, {
      task_id: created.task_id,
      role: "architect",
      content_type: "design",
      payload: { summary: "s", body: "b" },
    });

    const since = await hubRead(baseUrl, created.task_id, 1);
    expect(since.versions.map((r) => r.version)).toEqual([1]);

    const unfiltered = await hubList(baseUrl);
    expect(unfiltered.tasks.map((t) => t.task_id)).toContain("project"); // scope entry included
    expect(unfiltered.tasks.find((t) => t.task_id === "project")?.scope).toBe("project");

    const filtered = await hubList(baseUrl, "implementing");
    expect(filtered.tasks.map((t) => t.task_id)).toEqual([created.task_id]); // filter + project excluded

    const none = await hubList(baseUrl, "closed");
    expect(none.tasks).toEqual([]);
  });

  // The exact arguments runAck passes (pinned in cli.test.ts): a fixed human
  // ack note over the same publish path — proves end-to-end (zod envelope →
  // Store → state machine) that the tut ack payload clears accumulated
  // warnings without touching the folded status.
  it("tut ack's note shape clears needs_attention/warnings, status unchanged (real hub)", async () => {
    const created = await hubCreate(baseUrl, {
      title: "Ack Anomaly Task",
      description: "d",
      creator: "tester",
      role: "architect",
    });
    // code_changes while designing → OUT_OF_TABLE warning, needs_attention set.
    const anomaly = await hubPublish(baseUrl, {
      task_id: created.task_id,
      role: "executor",
      content_type: "code_changes",
      payload: { summary: "too early", body: "code before design" },
    });
    expect(anomaly.needs_attention).toBe(true);
    expect((anomaly.warnings ?? []).map((w) => w.code)).toContain("OUT_OF_TABLE");

    const acked = await hubPublish(baseUrl, {
      task_id: created.task_id,
      role: "human",
      content_type: "note",
      payload: {
        summary: "ack: anomalies handled",
        body: "Anomalies reviewed and handled; derived needs_attention clears on the next state pass.",
        ack: true,
      },
    });
    expect(acked).toMatchObject({
      task_id: created.task_id,
      version: 2,
      status: "designing", // the ack note never folds a status change
      needs_attention: false,
    });
    expect(acked.warnings ?? []).toEqual([]); // key omitted when empty

    const read = await hubRead(baseUrl, created.task_id);
    expect(read.status).toBe("designing");
    expect(read.versions).toHaveLength(2);
    expect(read.versions[1]).toMatchObject({ role: "human", content_type: "note" });
    expect(read.versions[1]?.payload.ack).toBe(true);
  });
});

describe("error mapping (isError → HubError with the first-line code)", () => {
  it("TASK_NOT_FOUND from a publish to a ghost task", async () => {
    const err = await hubPublish(baseUrl, {
      task_id: "ghost-task",
      role: "executor",
      content_type: "note",
      payload: { summary: "s", body: "b" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).code).toBe("TASK_NOT_FOUND");
    expect((err as HubError).message).toContain("ghost-task");
  });

  it("VERSION_CONFLICT from an expected_version mismatch", async () => {
    const created = await hubCreate(baseUrl, { title: "Conflict Task", description: "d", creator: "t", role: "architect" });
    const err = await hubPublish(baseUrl, {
      task_id: created.task_id,
      role: "architect",
      content_type: "design",
      payload: { summary: "s", body: "b" },
      expected_version: 5,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).code).toBe("VERSION_CONFLICT");
  });

  it("VALIDATION_ERROR from a store-side summary check", async () => {
    const err = await hubPublish(baseUrl, {
      task_id: "project",
      role: "human",
      content_type: "note",
      payload: { summary: "", body: "b" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).code).toBe("VALIDATION_ERROR");
  });

  it("zod envelope violations still surface as HubError (parseable first line)", async () => {
    // since_version < 1 is tighter than the Store contract — the mcp.ts schema rejects it.
    const err = await hubRead(baseUrl, "project", 0).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).code.length).toBeGreaterThan(0);
  });
});

describe("transport shape", () => {
  it("tolerates a base url with a trailing slash", async () => {
    const created = await hubCreate(`${baseUrl}/`, {
      title: "Trailing Slash",
      description: "d",
      creator: "tester",
      role: "architect",
    });
    expect(created.task_id).toBe("trailing-slash");
  });

  it("is stateless per call — two sequential calls each open and close cleanly", async () => {
    const first = await hubCreate(baseUrl, { title: "Stateless One", description: "d", creator: "t", role: "architect" });
    const second = await hubCreate(baseUrl, { title: "Stateless Two", description: "d", creator: "t", role: "architect" });
    expect(first.task_id).not.toBe(second.task_id);

    const read = await hubRead(baseUrl, second.task_id); // a later call sees earlier writes
    expect(read.title).toBe("Stateless Two");
  });
});

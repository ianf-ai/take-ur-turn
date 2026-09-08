/**
 * hub-client tests: the five CLI-equivalent functions
 * against a REAL startServer on an ephemeral port — same server the SDK e2e
 * suite drives, so these double as the "schema 同源" check: inputs pass
 * context.*'s zod envelopes and results match the store's JSON exactly.
 * isError results must surface as HubError with the first-line code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { startServer, type RunningServer } from "../src/server.js";
import { hubCreate, hubDecide, hubList, hubPublish, hubRead, HubError, HubSession, hubReadVia } from "../src/hub-client.js";

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

describe("HubSession — resident connection reuse", () => {
  it("P2-1: close() racing the handshake discards the connection — no resurrection, no later calls, close is repeatable", async () => {
    // Deferred-handshake shape: the stub accepts the initialize POST but parks
    // the response; close() runs while the handshake is in flight; releasing
    // the gate must NOT resurrect the session (the old code published the
    // client unconditionally after connect and the waiting call proceeded).
    let sawInitialize = false;
    let releaseInitialize!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const stub = createServer((req, res) => {
      let body = "";
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        let msg: { method?: string; id?: number | string } = {};
        try {
          msg = JSON.parse(body) as { method?: string; id?: number | string };
        } catch {
          // tolerate non-JSON frames
        }
        if (msg.method === "initialize") {
          sawInitialize = true;
          void gate.then(() => {
            res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stub-session" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  serverInfo: { name: "stub", version: "0.0.0" },
                },
              }),
            );
          });
          return;
        }
        res.writeHead(202); // initialized notification / stray POSTs
        res.end();
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
    try {
      const session = new HubSession(url);
      const call = session.call("context.list", {});
      await vi.waitFor(() => {
        if (!sawInitialize) throw new Error("initialize POST not yet at the stub");
      });

      await session.close(); // the race under test: handshake still parked
      releaseInitialize(); // …and NOW the handshake completes

      await expect(call).rejects.toMatchObject({ code: "HUB_SESSION_CLOSED" });
      expect((session as unknown as { client: unknown }).client).toBeNull(); // nothing resurrected
      await expect(session.call("context.list", {})).rejects.toMatchObject({ code: "HUB_SESSION_CLOSED" }); // closed stays closed
      await expect(session.close()).resolves.toBeUndefined(); // repeatable
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  it("sequential reads reuse ONE MCP session: the handshake is paid once and connections stay flat", async () => {
    const created = await hubCreate(baseUrl, { title: "Session Reuse", description: "d", creator: "t", role: "architect" });
    await hubPublish(baseUrl, { task_id: created.task_id, role: "architect", content_type: "design", payload: { summary: "s", body: "b" } });

    let connections = 0;
    running.server.on("connection", () => {
      connections += 1;
    });

    const session = new HubSession(baseUrl, { clientName: "reuse-test" });
    try {
      const first = await hubReadVia(session, created.task_id);
      expect(first.versions).toHaveLength(1);
      const afterHandshake = connections;

      for (let i = 0; i < 5; i++) {
        const again = await hubReadVia(session, created.task_id, 1);
        expect(again.versions).toHaveLength(1);
      }
      // 5 further calls on the resident session: at most one extra socket
      // (keep-alive expiry worst case) — the 0.6.0 shape opened ≥3 per call.
      expect(connections - afterHandshake).toBeLessThanOrEqual(1);
    } finally {
      await session.close();
    }
  });

  it("a hub tool error keeps the session healthy — the next call still works", async () => {
    const session = new HubSession(baseUrl);
    try {
      await expect(hubReadVia(session, "ghost-task")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      const created = await session.call("context.create", {
        title: "After Error",
        description: "d",
        creator: "t",
        role: "architect",
      }) as { task_id: string };
      const read = await hubReadVia(session, created.task_id);
      expect(read.title).toBe("After Error");
    } finally {
      await session.close();
    }
  });

  it("since_version 0 semantics live in the CALLER (omitted field) — hubReadVia passes through what it gets", async () => {
    const created = await hubCreate(baseUrl, { title: "Since Zero", description: "d", creator: "t", role: "architect" });
    await hubPublish(baseUrl, { task_id: created.task_id, role: "architect", content_type: "design", payload: { summary: "s", body: "b" } });
    const session = new HubSession(baseUrl);
    try {
      const read = await hubReadVia(session, created.task_id); // absent = full read through the session
      expect(read.versions).toHaveLength(1);
    } finally {
      await session.close();
    }
  });
});

describe("fetch timeout + diagnosable transport errors", () => {
  it("a hub that accepts but never answers fails with HUB_TIMEOUT within the budget", async () => {
    const sink = createServer((_req, res) => {
      // accepted, then silence — the half-open/wedged shape
      void res;
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(sink.address() as { port: number }).port}`;
    try {
      const session = new HubSession(url, { timeoutMs: 300 });
      const t0 = Date.now();
      await expect(session.call("context.list", {})).rejects.toMatchObject({
        code: "HUB_TIMEOUT",
        message: expect.stringContaining("did not answer within 300ms"),
      });
      expect(Date.now() - t0).toBeLessThan(5_000);
      await session.close();
    } finally {
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });

  it("one-shot calls diagnose transport failures: a dead port fails HUB_UNREACHABLE fast", async () => {
    // (The silent-hub HUB_TIMEOUT shape is covered above through HubSession
    // with an injected 300ms budget — one-shots run the SAME timeoutFetch +
    // diagnoseTransportFailure machinery at the fixed 10s default.)
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const deadPort = (dead.address() as { port: number }).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    await expect(hubList(`http://127.0.0.1:${deadPort}`)).rejects.toMatchObject({
      code: "HUB_UNREACHABLE",
      message: expect.stringContaining(deadPort.toString()),
    });
  });

  it("a session dropped mid-life reconnects on the next call (self-heal, no retry of the failed call)", async () => {
    // Kill the hub, confirm the session's call fails diagnosably; restart a
    // hub on the SAME port; the NEXT call reconnects and succeeds.
    const root2 = path.join(tmp, ".context-hub-2");
    const first = await startServer({ root: root2, port: 0 });
    const port = Number(new URL(first.url).port);
    const session = new HubSession(first.url);
    const created = await session.call("context.create", {
      title: "Self Heal", description: "d", creator: "t", role: "architect",
    }) as { task_id: string };
    await first.close();

    await expect(hubReadVia(session, created.task_id)).rejects.toMatchObject({ code: expect.stringMatching(/^HUB_(UNREACHABLE|TIMEOUT|TRANSPORT_ERROR)$/u) });

    const second = await startServer({ root: root2, port });
    try {
      const read = await hubReadVia(session, created.task_id); // reconnects transparently
      expect(read.task_id).toBe(created.task_id);
    } finally {
      await session.close();
      await second.close();
    }
  });
});

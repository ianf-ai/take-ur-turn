/**
 * End-to-end tests: the REAL startServer on an ephemeral port
 * driven by the REAL SDK client over REAL HTTP (StreamableHTTPClientTransport).
 *
 * This file is the automated end-to-end acceptance walk: a full
 * task lifecycle through all 5 tools, the project-scope round trip, the frozen
 * /state cross-check, the parseable error surface, statelessness across
 * sequential clients, and concurrent publishes from one client.
 *
 * No vi.mock anywhere: Store, HTTP routing, MCP transport and client are all
 * production code. Fresh temp dir + fresh server per test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startServer, type RunningServer } from "../src/server.js";

let tmp: string;
let root: string;
let running: RunningServer;
let baseUrl: string;
const clients: Client[] = [];

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-e2e-"));
  root = path.join(tmp, ".context-hub");
  running = await startServer({ root, port: 0 });
  baseUrl = running.url;
});

afterEach(async () => {
  // Clients first (their DELETE /mcp gets a 405 the SDK tolerates), then the
  // listener, then the temp dir.
  await Promise.allSettled(clients.map((c) => c.close()));
  clients.length = 0;
  await running.close().catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
});

/** Connect a real SDK client to the server's /mcp endpoint (stateless mode). */
async function connectClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: "tut-e2e-client", version: "0.0.0" });
  // Same exactOptionalPropertyTypes gap as src/http.ts (server side): the SDK's
  // optional `sessionId` getter includes undefined, the Transport interface
  // doesn't — cast rather than weaken the tsconfig.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  clients.push(client);
  return client;
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | undefined;
}

/** callTool with the mcp.test.ts text/JSON extraction (handler output contract). */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const res = await client.callTool({ name, arguments: args });
  const blocks = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.find((b) => b.type === "text")?.text ?? "";
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined; // error texts ("CODE: message") are not JSON
  }
  return { isError: res.isError === true, text, json };
}

async function createTask(client: Client, title: string): Promise<string> {
  const out = await call(client, "context.create", {
    title,
    description: "task created by the e2e walk",
    creator: "tester",
    role: "architect",
  });
  expect(out.isError).toBe(false);
  const taskId = out.json?.task_id;
  expect(typeof taskId).toBe("string");
  return taskId as string;
}

async function readStatus(client: Client, taskId: string): Promise<string> {
  const out = await call(client, "context.read", { task_id: taskId });
  expect(out.isError).toBe(false);
  return out.json?.status as string;
}

describe("e2e: full lifecycle over HTTP (end-to-end acceptance walk)", () => {
  it("walks create → publish → read → … → decide(close) with the derived status at every step", async () => {
    const client = await connectClient();

    // --- create ------------------------------------------------------------
    const created = await call(client, "context.create", {
      title: "E2E Lifecycle Task",
      description: "end-to-end MCP acceptance walk over real HTTP",
      creator: "tester",
      role: "architect",
    });
    expect(created.isError).toBe(false);
    expect(created.json?.status).toBe("designing");
    expect(created.json?.version).toBe(0);
    const taskId = created.json?.task_id as string;

    // --- publish design → implementing --------------------------------------
    const design = await call(client, "context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "the design", body: "do the thing end to end" },
      agent: "codex",
    });
    expect(design.isError).toBe(false);
    expect(design.json?.version).toBe(1);
    expect(await readStatus(client, taskId)).toBe("implementing");

    // --- read: full sequence so far ------------------------------------------
    let read = await call(client, "context.read", { task_id: taskId });
    expect(read.isError).toBe(false);
    expect(read.json?.title).toBe("E2E Lifecycle Task");
    expect(read.json?.status).toBe("implementing");
    expect((read.json?.versions as unknown[]).map((r) => (r as { version: number }).version)).toEqual([1]);

    // --- publish code_changes WITH commits → reviewing ------------------------
    const code = await call(client, "context.publish", {
      task_id: taskId,
      role: "executor",
      content_type: "code_changes",
      payload: { summary: "implementation", body: "changed the files", commits: ["a1b2c3d"] },
      agent: "pi",
    });
    expect(code.isError).toBe(false);
    expect(code.json?.version).toBe(2);
    expect(code.json?.status).toBe("reviewing");
    expect(await readStatus(client, taskId)).toBe("reviewing");

    // --- commits reference round-trip ("含 commits 引用") ------------------------
    read = await call(client, "context.read", { task_id: taskId });
    {
      const versions = read.json?.versions as Array<{ version: number; payload?: { commits?: string[] } }>;
      expect(versions.map((r) => r.version)).toEqual([1, 2]);
      expect(versions[1]?.payload?.commits).toEqual(["a1b2c3d"]);
    }

    // --- review fail_code → revising ------------------------------------------
    const reviewFail = await call(client, "context.publish", {
      task_id: taskId,
      role: "reviewer",
      content_type: "review",
      payload: { summary: "issues found", body: "two nits", verdict: "fail_code", ref_version: 2 },
      agent: "codex",
    });
    expect(reviewFail.isError).toBe(false);
    expect(reviewFail.json?.version).toBe(3);
    expect(reviewFail.json?.status).toBe("revising");
    expect(await readStatus(client, taskId)).toBe("revising");

    // --- revision referencing the review → reviewing ---------------------------
    const revision = await call(client, "context.publish", {
      task_id: taskId,
      role: "executor",
      content_type: "revision",
      payload: { summary: "fixes applied", body: "addressed both nits", ref_version: 3 },
      agent: "pi",
    });
    expect(revision.isError).toBe(false);
    expect(revision.json?.version).toBe(4);
    expect(revision.json?.status).toBe("reviewing");
    expect(await readStatus(client, taskId)).toBe("reviewing");

    // --- review pass → pending_approval ----------------------------------------
    const reviewPass = await call(client, "context.publish", {
      task_id: taskId,
      role: "reviewer",
      content_type: "review",
      payload: { summary: "looks good", body: "ship it", verdict: "pass", ref_version: 4 },
      agent: "codex",
    });
    expect(reviewPass.isError).toBe(false);
    expect(reviewPass.json?.version).toBe(5);
    expect(reviewPass.json?.status).toBe("pending_approval");
    expect(await readStatus(client, taskId)).toBe("pending_approval");

    // --- decide approve → approved ----------------------------------------------
    const approve = await call(client, "context.decide", {
      task_id: taskId,
      decision: "approve",
      by: "alice",
    });
    expect(approve.isError).toBe(false);
    expect(approve.json).toEqual({ task_id: taskId, status: "approved" });
    expect(await readStatus(client, taskId)).toBe("approved");

    // --- decide close → closed ----------------------------------------------------
    const close = await call(client, "context.decide", {
      task_id: taskId,
      decision: "close",
      by: "alice",
      reason: "accepted and merged",
    });
    expect(close.isError).toBe(false);
    expect(close.json).toEqual({ task_id: taskId, status: "closed" });
    expect(await readStatus(client, taskId)).toBe("closed");

    // --- final read: the complete record sequence, versions 1..7 ------------------
    read = await call(client, "context.read", { task_id: taskId });
    {
      const versions = read.json?.versions as Array<{ version: number; content_type: string }>;
      expect(read.json?.status).toBe("closed");
      expect(versions.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(versions.map((r) => r.content_type)).toEqual([
        "design",
        "code_changes",
        "review",
        "revision",
        "review",
        "decision",
        "decision",
      ]);
    }

    // --- /state cross-check (frozen shape) -----------------------------
    const stateRes = await fetch(`${baseUrl}/state`);
    expect(stateRes.status).toBe(200);
    expect(stateRes.headers.get("content-type")).toBe("application/json");
    const state = (await stateRes.json()) as {
      flow_mode: string;
      tasks: Array<{ task_id: string; status: string; waiting_for: string }>;
    };
    expect(state.flow_mode).toBe("manual");
    const entry = state.tasks.find((t) => t.task_id === taskId);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("closed");
    expect(entry?.waiting_for).toBe("none");
  });
});

describe("e2e: project scope over HTTP", () => {
  it("publishes without create, lists with scope project, never appears in /state", async () => {
    const client = await connectClient();

    // publish to "project" without any create — must succeed (auto-create).
    const pub = await call(client, "context.publish", {
      task_id: "project",
      role: "human",
      content_type: "text/markdown",
      payload: { summary: "project note", body: "project-level conventions live here" },
    });
    expect(pub.isError).toBe(false);
    expect(pub.json?.task_id).toBe("project");
    expect(pub.json?.version).toBe(1);
    expect(pub.json).not.toHaveProperty("status"); // project scope: no derived state keys

    // read: no status key either.
    const read = await call(client, "context.read", { task_id: "project" });
    expect(read.isError).toBe(false);
    expect(read.json).not.toHaveProperty("status");

    // list (unfiltered) shows the project entry with scope "project".
    const list = await call(client, "context.list", {});
    expect(list.isError).toBe(false);
    const tasks = list.json?.tasks as Array<Record<string, unknown>>;
    const projectEntry = tasks.find((t) => t.task_id === "project");
    expect(projectEntry).toBeDefined();
    expect(projectEntry?.scope).toBe("project");
    expect(projectEntry).not.toHaveProperty("status");

    // /state excludes the project scope (system-design 4.3).
    const stateRes = await fetch(`${baseUrl}/state`);
    const state = (await stateRes.json()) as { tasks: Array<{ task_id: string }> };
    expect(state.tasks.map((t) => t.task_id)).not.toContain("project");
  });
});

describe("e2e: error surface over HTTP", () => {
  it("publish to a nonexistent task → isError with TASK_NOT_FOUND prefix", async () => {
    const client = await connectClient();
    const out = await call(client, "context.publish", {
      task_id: "ghost-task",
      role: "executor",
      content_type: "note",
      payload: { summary: "s", body: "b" },
    });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith("TASK_NOT_FOUND")).toBe(true);
  });

  it("expected_version mismatch → isError with VERSION_CONFLICT prefix", async () => {
    const client = await connectClient();
    const taskId = await createTask(client, "Version Conflict Task");
    const out = await call(client, "context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "s", body: "b" },
      expected_version: 5, // actual version is 0
    });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith("VERSION_CONFLICT")).toBe(true);
  });
});

describe("e2e: stateless server across sequential clients", () => {
  it("client B (new Client + new transport) sees the task client A created", async () => {
    const clientA = await connectClient();
    const taskId = await createTask(clientA, "Handoff Task");

    const clientB = await connectClient(); // fresh connect, zero shared session state
    const read = await call(clientB, "context.read", { task_id: taskId });
    expect(read.isError).toBe(false);
    expect(read.json?.task_id).toBe(taskId);
    expect(read.json?.title).toBe("Handoff Task");
    expect(read.json?.status).toBe("designing");
  });
});

describe("e2e: concurrent tool calls from one client", () => {
  it("5 concurrent publishes all land with contiguous versions 1..5", async () => {
    const client = await connectClient();

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        call(client, "context.publish", {
          task_id: "project",
          role: "human",
          content_type: "note",
          payload: { summary: `note ${i}`, body: `concurrent note number ${i}` },
        }),
      ),
    );

    for (const out of results) {
      expect(out.isError).toBe(false);
    }
    const landed = results.map((out) => out.json?.version as number).sort((a, b) => a - b);
    expect(landed).toEqual([1, 2, 3, 4, 5]);

    const read = await call(client, "context.read", { task_id: "project" });
    expect(read.isError).toBe(false);
    const versions = (read.json?.versions as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
  });
});

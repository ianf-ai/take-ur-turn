import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Handler-level tests for the 5 MCP tools. The REAL Store runs on
 * a temp dir (no vi.mock of store — real derive integration); tools are driven
 * through the SDK's InMemoryTransport client pair so the zod input schemas are
 * exercised end-to-end, exactly as a real MCP client would see them.
 */

import { createMcpServer } from "../src/mcp.js";
import { Store } from "../src/store.js";

let tmp: string;
let store: Store;
let client: Client;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-mcp-"));
  store = new Store(path.join(tmp, ".context-hub"));
  client = await connect();
});

afterEach(async () => {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const server = createMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: "tut-test-client", version: "0.0.0" });
  await c.connect(clientTransport);
  return c;
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | undefined;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
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

async function createTask(title = "mcp test task"): Promise<string> {
  const out = await call("context.create", {
    title,
    description: "task created by test",
    creator: "tester",
    role: "architect",
  });
  expect(out.isError).toBe(false);
  return out.json?.task_id as string;
}

describe("context.create", () => {
  it("returns task_id, status designing, version 0", async () => {
    const out = await call("context.create", {
      title: "Add login",
      description: "login flow",
      creator: "tester",
      role: "architect",
    });
    expect(out.isError).toBe(false);
    expect(typeof out.json?.task_id).toBe("string");
    expect(out.json?.status).toBe("designing");
    expect(out.json?.version).toBe(0);
  });

  it("round-trips a parameterized cast through create, read, and list", async () => {
    const cast = { executor: { agent: "codex", args: ["--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"] } };
    const created = await call("context.create", {
      title: "Parameterized route",
      description: "preserve ordered launch argv",
      creator: "tester",
      role: "architect",
      cast,
    });
    expect(created.isError).toBe(false);
    const taskId = created.json?.task_id as string;

    const read = await call("context.read", { task_id: taskId });
    expect(read.isError).toBe(false);
    expect(read.json?.cast).toEqual(cast);

    const listed = await call("context.list", {});
    const entry = (listed.json?.tasks as Array<Record<string, unknown>>).find((task) => task.task_id === taskId);
    expect(entry?.cast).toEqual(cast);
  });

  it("round-trips an explicit worktree checkout route through create, read, and list", async () => {
    const checkout = { kind: "worktree", path: "/worktrees/mcp-task", ref: "mcp-task" };
    const created = await call("context.create", {
      title: "Worktree route",
      description: "preserve task checkout",
      creator: "tester",
      role: "architect",
      flow: "direct",
      checkout,
    });
    expect(created.isError).toBe(false);
    const taskId = created.json?.task_id as string;
    expect((await call("context.read", { task_id: taskId })).json?.checkout).toEqual(checkout);
    const listed = await call("context.list", {});
    const entry = (listed.json?.tasks as Array<Record<string, unknown>>).find((task) => task.task_id === taskId);
    expect(entry?.checkout).toEqual(checkout);
  });

  it("rejects a worktree checkout without a path — ref alone is not accepted", async () => {
    for (const checkout of [{ kind: "worktree" }, { kind: "worktree", ref: "mcp-task" }]) {
      const out = await call("context.create", {
        title: "Invalid worktree route",
        description: "must fail validation",
        creator: "tester",
        role: "architect",
        checkout,
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("worktree checkout requires a path; ref alone is not accepted");
    }
  });

  it("warns without blocking when a worktree path does not exist yet", async () => {
    const created = await call("context.create", {
      title: "Typo route",
      description: "warn but create",
      creator: "tester",
      role: "architect",
      flow: "direct",
      checkout: { kind: "worktree", path: path.join(tmp, "no-such-worktree") },
    });
    expect(created.isError).toBe(false);
    expect(created.json?.task_id).toBeTruthy();
    expect(String(created.json?.warning)).toContain("does not exist yet");

    const existing = mkdtempSync(path.join(tmp, "real-worktree-"));
    try {
      const quiet = await call("context.create", {
        title: "Real route",
        description: "no warning",
        creator: "tester",
        role: "architect",
        flow: "direct",
        checkout: { kind: "worktree", path: existing },
      });
      expect(quiet.isError).toBe(false);
      expect(quiet.json).not.toHaveProperty("warning");
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });

  it("rejects a missing required field as an input-validation tool error", async () => {
    const out = await call("context.create", {
      title: "x",
      description: "y",
      creator: "z", // role missing → zod rejects before the handler runs
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("-32602");
    expect(out.text).toContain("role");
  });
});

describe("context.create flow (system-design 4.1)", () => {
  it("flow direct: create returns status implementing; read exposes the description", async () => {
    const out = await call("context.create", {
      title: "Direct MCP Task",
      description: "fix the launcher dry-run flag",
      creator: "tester",
      role: "architect",
      flow: "direct",
    });
    expect(out.isError).toBe(false);
    expect(out.json?.status).toBe("implementing"); // create output status derives per flow
    expect(out.json?.version).toBe(0);
    const taskId = out.json?.task_id as string;

    const read = await call("context.read", { task_id: taskId });
    expect(read.isError).toBe(false);
    expect(read.json?.description).toBe("fix the launcher dry-run flag"); // requirement visible without a design record
    expect(read.json?.status).toBe("implementing");
  });

  it("flow solo: code_changes goes straight to pending_approval; absent flow defaults to designing", async () => {
    const solo = await call("context.create", {
      title: "Solo MCP Task",
      description: "d",
      creator: "tester",
      role: "architect",
      flow: "solo",
    });
    const soloId = solo.json?.task_id as string;
    await call("context.publish", { task_id: soloId, role: "architect", content_type: "design", payload: { summary: "d", body: "d" } });
    const pub = await call("context.publish", { task_id: soloId, role: "executor", content_type: "code_changes", payload: { summary: "c", body: "c" } });
    expect(pub.isError).toBe(false);
    expect(pub.json?.status).toBe("pending_approval"); // review phase skipped

    const plain = await call("context.create", { title: "Plain MCP Task", description: "d", creator: "tester", role: "architect" });
    expect(plain.isError).toBe(false);
    expect(plain.json?.status).toBe("designing");
  });

  it("rejects an out-of-enum flow as an input-validation tool error", async () => {
    const out = await call("context.create", { title: "x", description: "y", creator: "z", role: "r", flow: "turbo" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("-32602");
    expect(out.text).toContain("flow");
  });
});

describe("context.publish + context.read", () => {
  it("publish design moves status to implementing and read round-trips the record", async () => {
    const taskId = await createTask();
    const pub = await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "the design", body: "long design body" },
      agent: "codex",
    });
    expect(pub.isError).toBe(false);
    expect(pub.json?.status).toBe("implementing");
    expect(pub.json?.needs_attention).toBe(false);
    expect(pub.json?.version).toBe(1);
    expect(pub.json?.warnings).toBeUndefined(); // omitted when empty

    const read = await call("context.read", { task_id: taskId });
    expect(read.isError).toBe(false);
    expect(read.json?.title).toBe("mcp test task");
    expect(read.json?.status).toBe("implementing");
    const versions = read.json?.versions as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(1);
    expect(versions[0]?.content_type).toBe("design");
    expect(versions[0]?.agent).toBe("codex");
    expect((versions[0]?.payload as Record<string, unknown>)?.summary).toBe("the design");
  });

  it("lands commits in the stored record payload", async () => {
    const taskId = await createTask();
    await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "d", body: "d" },
    });
    const pub = await call("context.publish", {
      task_id: taskId,
      role: "executor",
      content_type: "code_changes",
      payload: { summary: "impl", body: "did it", commits: ["abc123", "def456"], ref_version: 1 },
    });
    expect(pub.isError).toBe(false);

    const stored = await store.readTask(taskId);
    const last = stored.versions[stored.versions.length - 1]!;
    expect(last.payload.commits).toEqual(["abc123", "def456"]);
    expect(last.payload.ref_version).toBe(1);
  });

  it("omits the agent field on the record when not provided", async () => {
    const taskId = await createTask();
    await call("context.publish", {
      task_id: taskId,
      role: "executor",
      content_type: "note",
      payload: { summary: "n", body: "n" },
    });
    const stored = await store.readTask(taskId);
    expect(stored.versions[0] && "agent" in stored.versions[0]).toBe(false);
  });

  it("accepts an unknown content_type string (schema not restricted)", async () => {
    const taskId = await createTask();
    const pub = await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "brainstorm-idea",
      payload: { summary: "s", body: "b" },
    });
    expect(pub.isError).toBe(false);
    expect(pub.json?.status).toBe("designing"); // unknown type: no transition
    expect(pub.json?.needs_attention).toBe(true); // OUT_OF_TABLE warning
  });

  it("review with an invalid verdict succeeds with needs_attention true (write-free)", async () => {
    const taskId = await createTask();
    await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "d", body: "d" },
    });
    await call("context.publish", {
      task_id: taskId,
      role: "executor",
      content_type: "code_changes",
      payload: { summary: "c", body: "c" },
    });
    const review = await call("context.publish", {
      task_id: taskId,
      role: "reviewer",
      content_type: "review",
      payload: { summary: "review", body: "verdict is nonsense", verdict: "banana" },
    });
    expect(review.isError).toBe(false);
    expect(review.json?.needs_attention).toBe(true);
    expect(review.json?.status).toBe("reviewing"); // no transition on invalid verdict
    const warnings = review.json?.warnings as Array<Record<string, unknown>>;
    expect(warnings?.some((w) => w.code === "INVALID_VERDICT")).toBe(true);
  });

  it("errors on nonexistent task with TASK_NOT_FOUND", async () => {
    const out = await call("context.publish", {
      task_id: "no-such-task",
      role: "architect",
      content_type: "note",
      payload: { summary: "s", body: "b" },
    });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith("TASK_NOT_FOUND:")).toBe(true);
  });

  it("errors on missing summary with VALIDATION_ERROR (store-validated)", async () => {
    const taskId = await createTask();
    const out = await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "note",
      payload: { body: "b" }, // summary missing
    });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith("VALIDATION_ERROR:")).toBe(true);
  });

  it("errors on expected_version mismatch with VERSION_CONFLICT", async () => {
    const taskId = await createTask();
    const out = await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "d", body: "d" },
      expected_version: 7, // actual current version is 0
    });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith("VERSION_CONFLICT:")).toBe(true);
  });

  it("succeeds when expected_version matches the current version", async () => {
    const taskId = await createTask();
    const out = await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "d", body: "d" },
      expected_version: 0,
    });
    expect(out.isError).toBe(false);
    expect(out.json?.version).toBe(1);
  });

  it("read filters by since_version", async () => {
    const taskId = await createTask();
    await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "d", body: "d" },
    });
    await call("context.publish", {
      task_id: taskId,
      role: "executor",
      content_type: "code_changes",
      payload: { summary: "c", body: "c" },
    });
    const read = await call("context.read", { task_id: taskId, since_version: 2 });
    expect(read.isError).toBe(false);
    expect(read.json?.versions).toHaveLength(1);
    expect((read.json?.versions as Array<Record<string, unknown>>)[0]?.version).toBe(2);
  });

  it("read of a nonexistent task errors with TASK_NOT_FOUND", async () => {
    const out = await call("context.read", { task_id: "ghost" });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith("TASK_NOT_FOUND:")).toBe(true);
  });
});

describe("context.list", () => {
  it("wraps entries in { tasks: [...] } with derived fields passed through", async () => {
    const taskId = await createTask("list me");
    await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "d", body: "d" },
    });
    const out = await call("context.list", {});
    expect(out.isError).toBe(false);
    const tasks = out.json?.tasks as Array<Record<string, unknown>>;
    expect(Array.isArray(tasks)).toBe(true);
    const mine = tasks.find((t) => t.task_id === taskId);
    expect(mine?.title).toBe("list me");
    expect(mine?.status).toBe("implementing");
    expect(typeof mine?.updated_at).toBe("string");
    expect(mine?.waiting_for).toBe("agent:executor");
    expect(mine?.needs_attention).toBe(false);
  });

  it("filters by status", async () => {
    await createTask("stays designing");
    const other = await createTask("moves on");
    await call("context.publish", {
      task_id: other,
      role: "architect",
      content_type: "design",
      payload: { summary: "d", body: "d" },
    });
    const out = await call("context.list", { status: "implementing" });
    const tasks = out.json?.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task_id).toBe(other);
  });
});

describe("project scope", () => {
  it("publish without create succeeds and returns only { task_id, version }", async () => {
    const pub = await call("context.publish", {
      task_id: "project",
      role: "architect",
      content_type: "note",
      payload: { summary: "global note", body: "shared context" },
    });
    expect(pub.isError).toBe(false);
    expect(pub.json?.task_id).toBe("project");
    expect(pub.json?.version).toBe(1);
    expect(pub.json).not.toHaveProperty("status");
    expect(pub.json).not.toHaveProperty("needs_attention");
  });

  it("list shows the project scope with scope: project and no status", async () => {
    await call("context.publish", {
      task_id: "project",
      role: "architect",
      content_type: "note",
      payload: { summary: "s", body: "b" },
    });
    await createTask(); // a normal task alongside
    const out = await call("context.list", {});
    const tasks = out.json?.tasks as Array<Record<string, unknown>>;
    const project = tasks.find((t) => t.task_id === "project");
    expect(project?.scope).toBe("project");
    expect(project).not.toHaveProperty("status");
    expect(tasks.find((t) => t.task_id !== "project")).toBeTruthy();
  });

  it("read of project scope has no status key", async () => {
    await call("context.publish", {
      task_id: "project",
      role: "architect",
      content_type: "note",
      payload: { summary: "s", body: "b" },
    });
    const read = await call("context.read", { task_id: "project" });
    expect(read.isError).toBe(false);
    expect(read.json?.title).toBe("project");
    expect(read.json).not.toHaveProperty("status");
  });

  it("decide on project scope returns { task_id, version }", async () => {
    const out = await call("context.decide", { task_id: "project", decision: "close", by: "alice" });
    expect(out.isError).toBe(false);
    expect(out.json?.task_id).toBe("project");
    expect(typeof out.json?.version).toBe("number");
    expect(out.json).not.toHaveProperty("status");
  });
});

describe("context.decide", () => {
  async function taskAtPendingApproval(): Promise<string> {
    const taskId = await createTask("approval flow");
    await call("context.publish", {
      task_id: taskId,
      role: "architect",
      content_type: "design",
      payload: { summary: "d", body: "d" },
    });
    await call("context.publish", {
      task_id: taskId,
      role: "executor",
      content_type: "code_changes",
      payload: { summary: "c", body: "c" },
    });
    await call("context.publish", {
      task_id: taskId,
      role: "reviewer",
      content_type: "review",
      payload: { summary: "r", body: "r", verdict: "pass" },
    });
    const read = await call("context.read", { task_id: taskId });
    expect(read.json?.status).toBe("pending_approval");
    return taskId;
  }

  it("approve after review pass moves status to approved and lands the record", async () => {
    const taskId = await taskAtPendingApproval();
    const out = await call("context.decide", {
      task_id: taskId,
      decision: "approve",
      by: "alice",
      reason: "ship it\nlooks good overall",
    });
    expect(out.isError).toBe(false);
    expect(out.json?.task_id).toBe(taskId);
    expect(out.json?.status).toBe("approved");

    const stored = await store.readTask(taskId);
    const decision = stored.versions[stored.versions.length - 1]!;
    expect(decision.role).toBe("human");
    expect(decision.agent).toBe("alice"); // by lands in the agent field
    expect(decision.content_type).toBe("decision");
    expect(decision.payload.decision).toBe("approve");
    expect(decision.payload.summary).toBe("ship it"); // first line of reason
    expect(decision.payload.body).toBe("ship it\nlooks good overall");
  });

  it("reject at pending_approval moves status to revising and lands the record", async () => {
    const taskId = await taskAtPendingApproval();
    const out = await call("context.decide", { task_id: taskId, decision: "reject", by: "alice" });
    expect(out.isError).toBe(false);
    expect(out.json?.task_id).toBe(taskId);
    expect(out.json?.status).toBe("revising");

    const stored = await store.readTask(taskId);
    const decision = stored.versions[stored.versions.length - 1]!;
    expect(decision.role).toBe("human");
    expect(decision.agent).toBe("alice"); // by lands in the agent field
    expect(decision.payload.decision).toBe("reject");
  });

  it("close works from any state and synthesizes body when no reason given", async () => {
    const taskId = await createTask("close me"); // designing, nothing published
    const out = await call("context.decide", { task_id: taskId, decision: "close", by: "alice" });
    expect(out.isError).toBe(false);
    expect(out.json?.status).toBe("closed");

    const stored = await store.readTask(taskId);
    const decision = stored.versions[stored.versions.length - 1]!;
    expect(decision.payload.decision).toBe("close");
    expect(decision.payload.summary).toBe("decision: close");
    expect(decision.payload.body).toBe("alice decided close");
  });

  it("decide on a nonexistent task errors with TASK_NOT_FOUND", async () => {
    const out = await call("context.decide", { task_id: "ghost", decision: "approve", by: "alice" });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith("TASK_NOT_FOUND:")).toBe(true);
  });
});

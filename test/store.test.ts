import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Store-side tests. derive is mocked: a fixed
 * DerivedState is returned; real integration happens in seam.test.ts.
 */
vi.mock("../src/state-machine.js", () => ({
  derive: vi.fn(() => ({
    status: "designing",
    waiting_for: "agent:architect",
    needs_attention: false,
    warnings: [],
  })),
}));

import { Store, StoreError } from "../src/store.js";
import { derive } from "../src/state-machine.js";
import { ErrorCode, type ContextRecord, type Flow, type Payload } from "../src/types.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function newStore(): { store: Store; root: string } {
  const root = path.join(tmp, ".context-hub");
  return { store: new Store(root), root };
}

function taskDir(root: string, taskId: string): string {
  return path.join(root, "tasks", taskId);
}

function readMeta(root: string, taskId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(taskDir(root, taskId), "meta.json"), "utf8")) as Record<string, unknown>;
}

function recordFiles(root: string, taskId: string): string[] {
  return readdirSync(taskDir(root, taskId)).filter((f) => f !== "meta.json");
}

function readRecordFile(root: string, taskId: string, file: string): ContextRecord {
  return JSON.parse(readFileSync(path.join(taskDir(root, taskId), file), "utf8")) as ContextRecord;
}

const validPayload = (overrides: Partial<Payload> = {}): Payload => ({ summary: "a summary", body: "a body", ...overrides });

async function expectCode(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

describe("createTask", () => {
  it("slugifies the title and writes meta.json only", async () => {
    const { store, root } = newStore();
    const result = await store.createTask({ title: "Auth Refactor!", description: "d", creator: "alice", role: "agent:architect" });

    expect(result).toEqual({ task_id: "auth-refactor", status: "designing", version: 0 });
    expect(recordFiles(root, "auth-refactor")).toEqual([]);
    const meta = readMeta(root, "auth-refactor");
    expect(meta.version).toBe(0);
    expect(meta.title).toBe("Auth Refactor!");
  });

  it("gives a short suffix on slug collision", async () => {
    const { store, root } = newStore();
    const first = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });
    const second = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    expect(first.task_id).toBe("auth-refactor");
    expect(second.task_id).not.toBe("auth-refactor");
    expect(second.task_id).toMatch(/^auth-refactor-[a-z0-9]{4}$/);
    expect(existsSync(taskDir(root, second.task_id))).toBe(true);
    expect(existsSync(taskDir(root, first.task_id))).toBe(true);
  });

  it("reserves 'project': a task whose slug would be 'project' gets a suffix unconditionally", async () => {
    const { store, root } = newStore();
    const result = await store.createTask({ title: "Project", description: "d", creator: "alice", role: "agent:architect" });

    expect(result.task_id).not.toBe("project");
    expect(result.task_id).toMatch(/^project-[a-z0-9]{4}$/);
    expect(existsSync(taskDir(root, "project"))).toBe(false);
  });

  it("rejects empty title/description with VALIDATION_ERROR", async () => {
    const { store } = newStore();
    await expectCode(
      store.createTask({ title: "", description: "d", creator: "alice", role: "agent:architect" }),
      ErrorCode.VALIDATION_ERROR,
    );
    await expectCode(
      store.createTask({ title: "t", description: " ", creator: "alice", role: "agent:architect" }),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe("append", () => {
  it("happy path: increments version, writes the record with full schema and ISO 8601 UTC timestamp", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    const result = await store.append(task_id, {
      role: "agent:architect",
      content_type: "design",
      payload: validPayload(),
      agent: "codex",
      model: "gpt-5",
    });

    expect(result).toEqual({ task_id, version: 1, status: "designing", needs_attention: false });
    expect(recordFiles(root, task_id)).toEqual(["v001.design.json"]);
    const record = readRecordFile(root, task_id, "v001.design.json");
    expect(record.version).toBe(1);
    expect(record.task_id).toBe(task_id);
    expect(record.role).toBe("agent:architect");
    expect(record.content_type).toBe("design");
    expect(record.agent).toBe("codex");
    expect(record.model).toBe("gpt-5");
    expect(record.timestamp).toMatch(ISO_UTC);
    expect(record.payload).toEqual(validPayload());
    expect(readMeta(root, task_id).version).toBe(1);
  });

  it("agent/model are optional: omitted fields are absent from the record", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });

    const record = readRecordFile(root, task_id, "v001.design.json");
    expect("agent" in record).toBe(false);
    expect("model" in record).toBe(false);
  });

  it("expected_version: 0 passes for the first publish, current version passes afterwards", async () => {
    const { store } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    const first = await store.append(task_id, {
      role: "agent:architect",
      content_type: "design",
      payload: validPayload(),
      expected_version: 0,
    });
    const second = await store.append(task_id, {
      role: "agent:executor",
      content_type: "code_changes",
      payload: validPayload(),
      expected_version: 1,
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
  });

  it("expected_version mismatch throws VERSION_CONFLICT carrying the ErrorCode", async () => {
    const { store } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });

    await expectCode(
      store.append(task_id, {
        role: "agent:executor",
        content_type: "code_changes",
        payload: validPayload(),
        expected_version: 0,
      }),
      ErrorCode.VERSION_CONFLICT,
    );
  });

  it("parallel appends without expected_version: all succeed with contiguous, non-duplicated versions", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.append(task_id, { role: "agent:architect", content_type: "note", payload: validPayload({ summary: `note ${i}` }) }),
      ),
    );

    expect(results).toHaveLength(10);
    const read = await store.readTask(task_id);
    expect(read.versions.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(recordFiles(root, task_id)).toHaveLength(10);
  });

  it("parallel appends with the same expected_version: exactly one wins, the rest get VERSION_CONFLICT", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        store.append(task_id, {
          role: "agent:architect",
          content_type: "design",
          payload: validPayload(),
          expected_version: 0,
        }),
      ),
    );

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect((r.reason as StoreError).code).toBe(ErrorCode.VERSION_CONFLICT);
    }
    expect(recordFiles(root, task_id)).toEqual(["v001.design.json"]);
    expect(readMeta(root, task_id).version).toBe(1);
  });

  it("append to a nonexistent task throws TASK_NOT_FOUND", async () => {
    const { store } = newStore();
    await expectCode(
      store.append("ghost", { role: "agent:architect", content_type: "design", payload: validPayload() }),
      ErrorCode.TASK_NOT_FOUND,
    );
  });

  it("missing or empty summary/body throws VALIDATION_ERROR", async () => {
    const { store } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    await expectCode(
      store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload({ summary: "" }) }),
      ErrorCode.VALIDATION_ERROR,
    );
    await expectCode(
      store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload({ body: " " }) }),
      ErrorCode.VALIDATION_ERROR,
    );
    await expectCode(
      store.append(task_id, { role: "agent:architect", content_type: "design", payload: { body: "b" } as Payload }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it("review without verdict is never rejected — the record lands on disk", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    const result = await store.append(task_id, {
      role: "agent:reviewer",
      content_type: "review",
      payload: validPayload(), // no verdict — derivation-side concern, not a write rejection
    });

    expect(result.version).toBe(1);
    expect(recordFiles(root, task_id)).toEqual(["v001.review.json"]);
    expect(readRecordFile(root, task_id, "v001.review.json").payload.verdict).toBeUndefined();
  });

  it("sanitizes content_type into a legal filename ('a/b' → 'a-b')", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    await store.append(task_id, { role: "agent:architect", content_type: "a/b", payload: validPayload() });

    expect(recordFiles(root, task_id)).toEqual(["v001.a-b.json"]);
    expect(readRecordFile(root, task_id, "v001.a-b.json").content_type).toBe("a/b");
  });

  it("caches the derived status in meta.json exactly as derive returned it", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });

    const meta = readMeta(root, task_id);
    expect(meta.status).toBe("designing");
    expect(meta.waiting_for).toBe("agent:architect");
    expect(meta.needs_attention).toBe(false);
    expect(meta.warnings).toEqual([]);
  });
});

describe("project scope", () => {
  it("append without create succeeds, auto-creates the dir, and increments versions on further appends", async () => {
    const { store, root } = newStore();

    const first = await store.append("project", { role: "agent:architect", content_type: "note", payload: validPayload() });
    expect(first).toEqual({ task_id: "project", version: 1 });

    expect(existsSync(taskDir(root, "project"))).toBe(true);
    const meta = readMeta(root, "project");
    expect(meta.version).toBe(1);
    expect("status" in meta).toBe(false);
    expect("waiting_for" in meta).toBe(false);

    const second = await store.append("project", { role: "agent:executor", content_type: "note", payload: validPayload() });
    expect(second.version).toBe(2);

    const read = await store.readTask("project");
    expect("status" in read).toBe(false);
    expect(read.versions.map((r) => r.version)).toEqual([1, 2]);
  });

  it("listTasks includes project scope with scope:'project' and no status; status filter skips it", async () => {
    const { store, root } = newStore();
    await store.append("project", { role: "agent:architect", content_type: "note", payload: validPayload() });
    await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });

    const all = await store.listTasks();
    expect(all.map((t) => t.task_id)).toEqual(["auth-refactor", "project"]);

    const project = all.find((t) => t.task_id === "project");
    expect(project).toBeDefined();
    expect(project?.scope).toBe("project");
    expect("status" in (project ?? {})).toBe(false);
    expect(project?.updated_at).toMatch(ISO_UTC);

    const normal = all.find((t) => t.task_id === "auth-refactor");
    expect(normal?.status).toBe("designing");
    expect(normal?.waiting_for).toBe("agent:architect");
    expect(normal?.needs_attention).toBe(false);

    // version: every entry carries meta.version verbatim —
    // 0 for a create-only task, 1 for project after one append.
    expect(normal?.version).toBe(readMeta(root, "auth-refactor").version);
    expect(project?.version).toBe(readMeta(root, "project").version);
    expect(normal?.version).toBe(0);
    expect(project?.version).toBe(1);

    expect((await store.listTasks("designing")).map((t) => t.task_id)).toEqual(["auth-refactor"]);
    expect(await store.listTasks("implementing")).toEqual([]);
  });
});

describe("readTask", () => {
  it("readTask of a nonexistent task throws TASK_NOT_FOUND", async () => {
    const { store } = newStore();
    await expectCode(store.readTask("ghost"), ErrorCode.TASK_NOT_FOUND);
  });

  it("returns title, derived status, and versions filtered by since_version", async () => {
    const { store } = newStore();
    const { task_id } = await store.createTask({ title: "Auth Refactor", description: "d", creator: "alice", role: "agent:architect" });
    for (let i = 0; i < 3; i++) {
      await store.append(task_id, { role: "agent:architect", content_type: "note", payload: validPayload({ summary: `n${i}` }) });
    }

    const full = await store.readTask(task_id);
    expect(full.title).toBe("Auth Refactor");
    expect(full.status).toBe("designing");
    expect(full.versions.map((r) => r.version)).toEqual([1, 2, 3]);

    const since = await store.readTask(task_id, 2);
    expect(since.versions.map((r) => r.version)).toEqual([2, 3]);
    expect(since.versions.every((r) => r.task_id === task_id)).toBe(true);
  });

  it("returns the description from meta (additive revision)", async () => {
    const { store } = newStore();
    const { task_id } = await store.createTask({ title: "Described", description: "fix the launcher dry-run flag", creator: "alice", role: "agent:architect" });
    expect(await store.readTask(task_id)).toMatchObject({ description: "fix the launcher dry-run flag" });

    // Project scope carries no description (auto-created meta has none).
    await store.append("project", { role: "agent:architect", content_type: "note", payload: validPayload() });
    expect(await store.readTask("project")).not.toHaveProperty("description");
  });

  it("empty store lists no tasks", async () => {
    const { store } = newStore();
    expect(await store.listTasks()).toEqual([]);
  });
});

describe("task_id path traversal ", () => {
  it("readTask rejects traversal ids with VALIDATION_ERROR and touches nothing on disk", async () => {
    const { store, root } = newStore();
    await expectCode(store.readTask("../evil"), ErrorCode.VALIDATION_ERROR);
    await expectCode(store.readTask("../../outside/victim"), ErrorCode.VALIDATION_ERROR);
    await expectCode(store.readTask(".."), ErrorCode.VALIDATION_ERROR);
    await expectCode(store.readTask("a/b"), ErrorCode.VALIDATION_ERROR);
    await expectCode(store.readTask(".hidden"), ErrorCode.VALIDATION_ERROR);
    expect(existsSync(path.join(root, "tasks"))).toBe(false); // nothing was created while probing
    expect(existsSync(path.join(tmp, "evil"))).toBe(false);
    expect(existsSync(path.join(tmp, "outside"))).toBe(false);
  });

  it("append rejects traversal ids with VALIDATION_ERROR and writes nothing outside the root", async () => {
    const { store, root } = newStore();
    await expectCode(
      store.append("../../outside", { role: "agent:architect", content_type: "note", payload: validPayload() }),
      ErrorCode.VALIDATION_ERROR,
    );
    await expectCode(
      store.append("../evil", { role: "agent:architect", content_type: "note", payload: validPayload() }),
      ErrorCode.VALIDATION_ERROR,
    );
    // root is <tmp>/.context-hub, so "../.." from tasks/ would land at <tmp> — outside the root.
    expect(existsSync(path.join(tmp, "outside"))).toBe(false);
    expect(existsSync(path.join(tmp, "evil"))).toBe(false);
    expect(existsSync(path.join(root, "tasks"))).toBe(false);
  });

  it("listTasks skips directories whose names are not legal task ids", async () => {
    const { store, root } = newStore();
    await store.append("project", { role: "agent:architect", content_type: "note", payload: validPayload() });
    // Foreign directory with a meta.json inside — uppercase name never resolves to a task path.
    mkdirSync(path.join(root, "tasks", "Evil-Dir"), { recursive: true });
    writeFileSync(path.join(root, "tasks", "Evil-Dir", "meta.json"), JSON.stringify({ task_id: "Evil-Dir", title: "Evil", created_at: "x", updated_at: "x", version: 0 }));
    writeFileSync(path.join(root, "tasks", "Evil-Dir", "v001.note.json"), JSON.stringify({ version: 1, task_id: "Evil-Dir", role: "x", content_type: "note", timestamp: "x", payload: { summary: "s", body: "b" } }));

    expect((await store.listTasks()).map((t) => t.task_id)).toEqual(["project"]);
  });
});

describe("crash-window reconciliation", () => {
  it("an orphan record from a crash between record write and meta update is never overwritten", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Crash Window", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() }); // v1, meta.version = 1

    // Simulate the crash window: an orphan v002 note file exists on disk while meta.version is still 1.
    const orphan: ContextRecord = {
      version: 2,
      task_id,
      role: "agent:reviewer",
      content_type: "note",
      timestamp: "2026-08-15T09:00:00.000Z",
      payload: validPayload({ summary: "orphan from the crash window" }),
    };
    writeFileSync(path.join(taskDir(root, task_id), "v002.note.json"), JSON.stringify(orphan, null, 2), "utf8");
    expect(readMeta(root, task_id).version).toBe(1); // meta is stale, as after a crash

    const result = await store.append(task_id, { role: "agent:executor", content_type: "code_changes", payload: validPayload() });

    // Next append skips past the on-disk max instead of reusing (and overwriting) v002.
    expect(result.version).toBe(3);
    expect(recordFiles(root, task_id).sort()).toEqual(["v001.design.json", "v002.note.json", "v003.code_changes.json"]);
    expect(readRecordFile(root, task_id, "v002.note.json")).toEqual(orphan); // the orphan survived intact
    expect(readMeta(root, task_id).version).toBe(3); // staleness healed
  });
});

describe("corrupt files", () => {
  it("listTasks skips a task dir with corrupt meta.json and still lists the other tasks", async () => {
    const { store, root } = newStore();
    const good = await store.createTask({ title: "Good Task", description: "d", creator: "alice", role: "agent:architect" });
    await store.append("project", { role: "agent:architect", content_type: "note", payload: validPayload() });
    const bad = await store.createTask({ title: "Bad Task", description: "d", creator: "alice", role: "agent:architect" });

    writeFileSync(path.join(taskDir(root, bad.task_id), "meta.json"), "{ not json", "utf8");

    const listed = await store.listTasks();
    expect(listed.map((t) => t.task_id)).toEqual([good.task_id, "project"]);
  });

  it("readTask on a corrupt meta.json rejects with VALIDATION_ERROR naming the file", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Bad Task", description: "d", creator: "alice", role: "agent:architect" });
    writeFileSync(path.join(taskDir(root, task_id), "meta.json"), "not json at all", "utf8");

    await expect(store.readTask(task_id)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      message: expect.stringContaining("meta.json"),
    });
  });

  it("readTask rejects with VALIDATION_ERROR when a record file is corrupt", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Half Dead", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), "{ broken", "utf8");

    await expect(store.readTask(task_id)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      message: expect.stringContaining("v001.design.json"),
    });
  });
});

describe("atomic writes", () => {
  /**
   * Reconciliation normally makes the next version dodge any existing
   * file, so an in-process EEXIST can only occur when the final name appears
   * after maxOnDiskRecordVersion has run (cross-process race). Blinding the
   * reconciliation scan simulates exactly that window for the link-based
   * exclusive create.
   */
  function blindReconciliation(store: Store): void {
    (store as unknown as { maxOnDiskRecordVersion: () => Promise<number> }).maxOnDiskRecordVersion = async () => 0;
  }

  it("an existing same-name record file still yields VERSION_CONFLICT (link-based exclusive create)", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Race Lose", description: "d", creator: "alice", role: "agent:architect" });
    // The "other process" already created v001 under this name.
    writeFileSync(path.join(taskDir(root, task_id), "v001.note.json"), "{}", "utf8");
    blindReconciliation(store);

    await expectCode(
      store.append(task_id, { role: "agent:architect", content_type: "note", payload: validPayload() }),
      ErrorCode.VERSION_CONFLICT,
    );
    // The pre-existing file was not clobbered by the failed publish.
    expect(readFileSync(path.join(taskDir(root, task_id), "v001.note.json"), "utf8")).toBe("{}");
  });

  it("leaves no temp files behind after successful operations and after an EEXIST failure", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Temp Check", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    await store.append(task_id, { role: "agent:executor", content_type: "code_changes", payload: validPayload() });
    const noTemps = (id: string) => readdirSync(taskDir(root, id)).filter((f) => f.endsWith(".tmp"));

    expect(noTemps(task_id)).toEqual([]);

    // EEXIST failure path (see the regression test above for the setup rationale).
    writeFileSync(path.join(taskDir(root, task_id), "v003.note.json"), "{}", "utf8");
    blindReconciliation(store);
    await expectCode(
      store.append(task_id, { role: "agent:architect", content_type: "note", payload: validPayload() }),
      ErrorCode.VERSION_CONFLICT,
    );
    expect(noTemps(task_id)).toEqual([]);

    // Project scope meta auto-creation also goes through the atomic writeMeta path.
    await store.append("project", { role: "agent:architect", content_type: "note", payload: validPayload() });
    expect(noTemps("project")).toEqual([]);
  });
});

describe("construction .tmp sweep", () => {
  it("removes leftover <file>.<pid>.tmp siblings in task dirs, keeping real files intact", async () => {
    const { root } = newStore();
    const seed = new Store(root);
    const { task_id } = await seed.createTask({ title: "Sweep Target", description: "d", creator: "alice", role: "agent:architect" });
    await seed.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    // Simulate crash leftovers: one from writeMeta, one from writeRecordExclusive (foreign pids).
    writeFileSync(path.join(taskDir(root, task_id), "meta.json.999998.tmp"), "{}");
    writeFileSync(path.join(taskDir(root, task_id), "v002.note.json.999999.tmp"), "{}");

    const fresh = new Store(root); // construction kicks off the sweep
    await fresh.whenSwept;

    const remaining = readdirSync(taskDir(root, task_id));
    expect(remaining.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(remaining.filter((f) => f.endsWith(".json")).sort()).toEqual(["meta.json", "v001.design.json"]);
  });

  it("sweeps across every task dir, not just one", async () => {
    const { root } = newStore();
    const seed = new Store(root);
    const a = await seed.createTask({ title: "Task A", description: "d", creator: "alice", role: "agent:architect" });
    const b = await seed.createTask({ title: "Task B", description: "d", creator: "alice", role: "agent:architect" });
    writeFileSync(path.join(taskDir(root, a.task_id), "meta.json.111.tmp"), "{}");
    writeFileSync(path.join(taskDir(root, b.task_id), "meta.json.222.tmp"), "{}");

    const fresh = new Store(root);
    await fresh.whenSwept;

    expect(readdirSync(taskDir(root, a.task_id))).toEqual(["meta.json"]);
    expect(readdirSync(taskDir(root, b.task_id))).toEqual(["meta.json"]);
  });

  it("logs each removal to stderr (absolute path) and tolerates a missing tasks tree without throwing", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { root } = newStore();
      const seed = new Store(root);
      const { task_id } = await seed.createTask({ title: "Logged Sweep", description: "d", creator: "alice", role: "agent:architect" });
      writeFileSync(path.join(taskDir(root, task_id), "meta.json.333.tmp"), "{}");

      const fresh = new Store(path.join(root)); // same tree, sweep runs again over the leftover
      await fresh.whenSwept;

      const stderr = stderrWrite.mock.calls.flat().join("");
      expect(stderr).toContain("swept leftover temp file");
      expect(stderr).toContain(path.join(root, "tasks", task_id, "meta.json.333.tmp")); // absolute path

      // Missing tasks tree: sweep is a no-op, never a throw.
      const bare = new Store(path.join(tmp, "never-created-root"));
      await expect(bare.whenSwept).resolves.toBeUndefined();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("skips this process's own .<pid>.tmp files — they are in-flight writes racing the sweep, not leftovers", async () => {
    const { root } = newStore();
    const seed = new Store(root);
    const { task_id } = await seed.createTask({ title: "Own Pid Sweep", description: "d", creator: "alice", role: "agent:architect" });
    const own = `meta.json.${process.pid}.tmp`;
    writeFileSync(path.join(taskDir(root, task_id), own), "{}");
    writeFileSync(path.join(taskDir(root, task_id), "meta.json.777777.tmp"), "{}"); // foreign — swept

    const fresh = new Store(root); // construction sweep runs outside the write queue
    await fresh.whenSwept;

    const remaining = readdirSync(taskDir(root, task_id)).filter((f) => f.endsWith(".tmp"));
    expect(remaining).toEqual([own]); // own temp survives; the foreign one is gone
    rmSync(path.join(taskDir(root, task_id), own), { force: true }); // a real writer would rename it away
  });
});

describe("flow (system-design 3.1)", () => {
  // derive stays mocked in this file: flow-specific FOLDING is
  // covered by the per-flow golden vectors through the real store in
  // seam.test.ts; here we lock meta persistence and call-site passthrough.

  it("createTask lands flow in meta and passes it to derive; default create omits the key (absent = full)", async () => {
    const { store, root } = newStore();
    const direct = await store.createTask({ title: "Direct Task", description: "d", creator: "alice", role: "agent:architect", flow: "direct" });
    expect(direct.task_id).toBe("direct-task");
    expect(readMeta(root, "direct-task").flow).toBe("direct");
    expect(vi.mocked(derive)).toHaveBeenLastCalledWith("direct-task", [], "direct");

    const full = await store.createTask({ title: "Full Task", description: "d", creator: "alice", role: "agent:architect" });
    expect(full.task_id).toBe("full-task");
    const meta = readMeta(root, "full-task");
    expect("flow" in meta).toBe(false); // zero migration: default creates keep the legacy meta shape
    expect(vi.mocked(derive)).toHaveBeenLastCalledWith("full-task", [], undefined);
  });

  it("createTask rejects an unknown flow value with VALIDATION_ERROR", async () => {
    const { store, root } = newStore();
    await expectCode(
      store.createTask({ title: "Bad Flow", description: "d", creator: "alice", role: "agent:architect", flow: "turbo" as unknown as Flow }),
      ErrorCode.VALIDATION_ERROR,
    );
    expect(existsSync(taskDir(root, "bad-flow"))).toBe(false); // nothing landed
  });

  it("append and listTasks derive with the meta flow and never rewrite it", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Solo Task", description: "d", creator: "alice", role: "agent:architect", flow: "solo" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });

    const meta = readMeta(root, task_id);
    expect(meta.flow).toBe("solo"); // append does not touch flow (immutability by construction)
    expect(meta.version).toBe(1);
    expect(vi.mocked(derive)).toHaveBeenLastCalledWith(task_id, expect.anything(), "solo");

    // The list path reads meta.flow too (this is what /state derives through).
    await store.listTasks();
    expect(vi.mocked(derive)).toHaveBeenLastCalledWith(task_id, expect.anything(), "solo");
  });
});

// --- cast + flow exposure -------------------------------------------------------------

describe("cast in meta + flow/cast on read/list (immutable by construction)", () => {
  it("create with cast → readTask/listTasks expose it; flow always present (normalized)", async () => {
    const store = new Store(tmp);
    const created = await store.createTask({
      title: "Cast Task",
      description: "d",
      creator: "t",
      role: "architect",
      cast: { executor: "pi", reviewer: "codex" },
    });

    const read = await store.readTask(created.task_id);
    expect(read.flow).toBe("full"); // deferred registration item: always present, normalized
    expect(read.cast).toEqual({ executor: "pi", reviewer: "codex" });

    const list = await store.listTasks();
    const entry = list.find((t) => t.task_id === created.task_id);
    expect(entry?.flow).toBe("full");
    expect(entry?.cast).toEqual({ executor: "pi", reviewer: "codex" });
  });

  it("default create: flow \"full\", NO cast key; direct flow surfaces verbatim", async () => {
    const store = new Store(tmp);
    const plain = await store.createTask({ title: "Plain", description: "d", creator: "t", role: "architect" });
    const direct = await store.createTask({ title: "Direct", description: "d", creator: "t", role: "architect", flow: "direct" });

    expect(await store.readTask(plain.task_id)).not.toHaveProperty("cast");
    expect((await store.readTask(direct.task_id)).flow).toBe("direct");
  });

  it("cast survives appends unchanged (no write path touches it — constructional immutability)", async () => {
    const store = new Store(tmp);
    const created = await store.createTask({
      title: "Immutable Cast",
      description: "d",
      creator: "t",
      role: "architect",
      cast: { executor: "codex" },
    });
    await store.append(created.task_id, { role: "architect", content_type: "design", payload: { summary: "s", body: "b" } });
    await store.append(created.task_id, { role: "executor", content_type: "code_changes", payload: { summary: "s", body: "b" } });

    const read = await store.readTask(created.task_id);
    expect(read.cast).toEqual({ executor: "codex" }); // untouched by any append
  });

  it("invalid cast rejected at create: unknown role key / empty agent value", async () => {
    const store = new Store(tmp);
    await expect(
      store.createTask({ title: "Bad Key", description: "d", creator: "t", role: "architect", cast: { boss: "x" } as never }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      store.createTask({ title: "Bad Value", description: "d", creator: "t", role: "architect", cast: { executor: "  " } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("project scope: neither flow nor cast ever appears", async () => {
    const store = new Store(tmp);
    await store.append("project", { role: "human", content_type: "note", payload: { summary: "s", body: "b" } });
    const read = await store.readTask("project");
    expect(read).not.toHaveProperty("flow");
    expect(read).not.toHaveProperty("cast");
  });
});

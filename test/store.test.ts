import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Store-side tests. derive is spied but real (the store folds through
 * the real incremental exports), so statuses reflect the true transition
 * tables; state-machine golden vectors live in state-machine.test.ts.
 * DerivedState is returned; real integration happens in seam.test.ts.
 */
vi.mock("../src/state-machine.js", async (importOriginal) => {
  // derive stays spied (call passthrough assertions) but REAL — the store's
  // folds run through the real incremental fold exports, so meta
  // and list entries carry true derived state in this file.
  const actual = await importOriginal<typeof import("../src/state-machine.js")>();
  return { ...actual, derive: vi.fn(actual.derive) };
});

import { Store, StoreError } from "../src/store.js";
import { derive } from "../src/state-machine.js";
import { ErrorCode, type ContextRecord, type Flow, type Payload } from "../src/types.js";
import { createHash } from "node:crypto";

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

/**
 * Land a healthy record on disk WITHOUT folding it through the store
 * (cache protocol): corruption tests must arrange damage before
 * ANY fold caches the healthy name set — a live hub that already folded
 * healthy bytes only re-reads them on a name change or restart (the
 * readdir name list is the invalidation token; see store-cache.test.ts).
 */
function writeRecordDirect(root: string, taskId: string, record: ContextRecord): void {
  const name = `v${String(record.version).padStart(3, "0")}.${record.content_type.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
  writeFileSync(path.join(taskDir(root, taskId), name), JSON.stringify(record, null, 2) + "\n", "utf8");
}

/** A well-formed v1 design record for direct disk writes (writeRecordDirect). */
function directDesignRecord(taskId: string): ContextRecord {
  return {
    version: 1,
    task_id: taskId,
    role: "agent:architect",
    content_type: "design",
    timestamp: "2026-08-15T09:00:00.000Z",
    payload: validPayload(),
  };
}

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

    expect(result).toEqual({ task_id, version: 1, status: "implementing", needs_attention: false });
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
    expect(meta.status).toBe("implementing");
    expect(meta.waiting_for).toBe("agent:executor");
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
    (store as unknown as { taskDirNames: () => Promise<string[]> }).taskDirNames = async () => [];
  }

  it("an existing same-name record file still yields VERSION_CONFLICT (link-based exclusive create)", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Race Lose", description: "d", creator: "alice", role: "agent:architect" });
    // The "other process" already created v001 under this name. The content
    // must be a VALID record: the pre-write fold reads the directory before
    // the exclusive create, and a structurally-corrupt squatter would fail
    // as VALIDATION_ERROR before the EEXIST race is ever reached.
    const squatter: ContextRecord = {
      version: 1,
      task_id,
      role: "agent:architect",
      content_type: "note",
      timestamp: "2026-08-15T09:00:00.000Z",
      payload: validPayload(),
    };
    writeFileSync(path.join(taskDir(root, task_id), "v001.note.json"), JSON.stringify(squatter), "utf8");
    blindReconciliation(store);

    await expectCode(
      store.append(task_id, { role: "agent:architect", content_type: "note", payload: validPayload() }),
      ErrorCode.VERSION_CONFLICT,
    );
    // The pre-existing file was not clobbered by the failed publish.
    expect(readRecordFile(root, task_id, "v001.note.json")).toEqual(squatter);
  });

  it("leaves no temp files behind after successful operations and after an EEXIST failure", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Temp Check", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    await store.append(task_id, { role: "agent:executor", content_type: "code_changes", payload: validPayload() });
    const noTemps = (id: string) => readdirSync(taskDir(root, id)).filter((f) => f.endsWith(".tmp"));

    expect(noTemps(task_id)).toEqual([]);

    // EEXIST failure path (see the regression test above for the setup rationale).
    const squatter3: ContextRecord = {
      version: 3,
      task_id,
      role: "agent:architect",
      content_type: "note",
      timestamp: "2026-08-15T09:00:00.000Z",
      payload: validPayload(),
    };
    writeFileSync(path.join(taskDir(root, task_id), "v003.note.json"), JSON.stringify(squatter3), "utf8");
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
  /** Backdate a temp file's mtime past SWEEP_TMP_MAX_AGE_MS so it reads as a
   *  crash leftover, not another live process's in-flight write. */
  function ageTmp(filePath: string): void {
    const old = new Date(Date.now() - 120_000);
    utimesSync(filePath, old, old);
  }

  it("removes leftover <file>.<pid>.tmp siblings in task dirs, keeping real files intact", async () => {
    const { root } = newStore();
    const seed = new Store(root);
    const { task_id } = await seed.createTask({ title: "Sweep Target", description: "d", creator: "alice", role: "agent:architect" });
    await seed.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    // Simulate crash leftovers: one from writeMeta, one from writeRecordExclusive (foreign pids).
    const metaTmp = path.join(taskDir(root, task_id), "meta.json.999998.tmp");
    const recTmp = path.join(taskDir(root, task_id), "v002.note.json.999999.tmp");
    writeFileSync(metaTmp, "{}");
    writeFileSync(recTmp, "{}");
    ageTmp(metaTmp);
    ageTmp(recTmp);

    const fresh = new Store(root); // construction kicks off the sweep
    await fresh.whenSwept;

    const remaining = readdirSync(taskDir(root, task_id));
    expect(remaining.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(remaining.filter((f) => f.endsWith(".json")).sort()).toEqual(["meta.json", "v001.design.json"]);
  });

  it("keeps a FRESH foreign tmp — another live process's in-flight write is not a leftover", async () => {
    const { root } = newStore();
    const seed = new Store(root);
    const { task_id } = await seed.createTask({ title: "Fresh Foreign", description: "d", creator: "alice", role: "agent:architect" });
    const foreignFresh = path.join(taskDir(root, task_id), "meta.json.888888.tmp");
    writeFileSync(foreignFresh, "{}"); // mtime = now → plausibly in flight

    const fresh = new Store(root);
    await fresh.whenSwept;

    // The aged sweep leaves fresh foreign temps alone; only aged leftovers go.
    expect(readdirSync(taskDir(root, task_id)).filter((f) => f.endsWith(".tmp"))).toEqual(["meta.json.888888.tmp"]);
  });

  it("sweeps across every task dir, not just one", async () => {
    const { root } = newStore();
    const seed = new Store(root);
    const a = await seed.createTask({ title: "Task A", description: "d", creator: "alice", role: "agent:architect" });
    const b = await seed.createTask({ title: "Task B", description: "d", creator: "alice", role: "agent:architect" });
    const aTmp = path.join(taskDir(root, a.task_id), "meta.json.111.tmp");
    const bTmp = path.join(taskDir(root, b.task_id), "meta.json.222.tmp");
    writeFileSync(aTmp, "{}");
    writeFileSync(bTmp, "{}");
    ageTmp(aTmp);
    ageTmp(bTmp);

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
      const tmpFile = path.join(taskDir(root, task_id), "meta.json.333.tmp");
      writeFileSync(tmpFile, "{}");
      ageTmp(tmpFile);

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
    const foreign = path.join(taskDir(root, task_id), "meta.json.777777.tmp"); // foreign + aged — swept
    writeFileSync(foreign, "{}");
    ageTmp(foreign);

    const fresh = new Store(root); // construction sweep runs outside the write queue
    await fresh.whenSwept;

    const remaining = readdirSync(taskDir(root, task_id)).filter((f) => f.endsWith(".tmp"));
    expect(remaining).toEqual([own]); // own temp survives; the foreign one is gone
    rmSync(path.join(taskDir(root, task_id), own), { force: true }); // a real writer would rename it away
  });
});

describe("flow (system-design 3.1)", () => {
  // derive stays spied here; flow-specific FOLDING runs through the real
  // incremental fold — meta persistence and flow passthrough to the
  // fold are both exercised, golden vectors live in state-machine.test.ts.

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

  it("append and listTasks fold with the meta flow and never rewrite it", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Solo Task", description: "d", creator: "alice", role: "agent:architect", flow: "solo" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });

    const meta = readMeta(root, task_id);
    expect(meta.flow).toBe("solo"); // append does not touch flow (immutability by construction)
    expect(meta.version).toBe(1);
    expect(meta.status).toBe("implementing"); // real fold: solo design → implementing

    // solo skips the review phase — code_changes goes straight to the human
    // approval gate. This is the flow reaching the FOLD (append pre-write and
    // the list path use the same cached cursor chain).
    const landed = await store.append(task_id, { role: "agent:executor", content_type: "code_changes", payload: validPayload() });
    expect(landed.status).toBe("pending_approval");

    const listed = await store.listTasks();
    const entry = listed.find((t) => t.task_id === task_id);
    expect(entry?.status).toBe("pending_approval");
    expect(entry?.waiting_for).toBe("human");
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

// --- corruption tolerance + degraded visibility -----------------------------------

describe("append pre-write corruption exposure", () => {
  it("a corrupt sibling record rejects the append BEFORE anything lands, and retries never leak orphan files", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Brick Proof", description: "d", creator: "alice", role: "agent:architect" });
    // The only record on disk lands directly (uncached) and is corrupt —
    // every append's pre-write fold must hit it: cold (first fold) or the
    // extension read (the corrupt name is new to the cache).
    writeRecordDirect(root, task_id, directDesignRecord(task_id));
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), "{ broken", "utf8");

    const before = readdirSync(taskDir(root, task_id)).sort();
    for (let i = 0; i < 3; i += 1) {
      await expectCode(
        store.append(task_id, { role: "executor", content_type: "code_changes", payload: validPayload() }),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    // Nothing landed on any attempt: no new record file, no orphan, no temp.
    expect(readdirSync(taskDir(root, task_id)).sort()).toEqual(before);
  });

  it("a corrupt meta.json rejects appends too (append requires parseable operation state)", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Meta Dead", description: "d", creator: "alice", role: "agent:architect" });
    writeFileSync(path.join(taskDir(root, task_id), "meta.json"), "{ not json", "utf8");

    await expectCode(
      store.append(task_id, { role: "agent:architect", content_type: "note", payload: validPayload() }),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe("snapshotTasks degraded visibility (system-design 4.3)", () => {
  it("corrupt meta, missing meta, and corrupt records land in degraded — with a stderr warning per task", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { store, root } = newStore();
      const healthy = await store.createTask({ title: "Healthy", description: "d", creator: "alice", role: "agent:architect" });
      const badMeta = await store.createTask({ title: "Bad Meta", description: "d", creator: "alice", role: "agent:architect" });
      const badRecords = await store.createTask({ title: "Bad Records", description: "d", creator: "alice", role: "agent:architect" });
      // Direct disk write: the corruption below is the FIRST fold of this
      // name set (cache protocol — never fold the healthy bytes first).
      writeRecordDirect(root, badRecords.task_id, directDesignRecord(badRecords.task_id));
      // no-meta: a create interrupted between mkdir and writeMeta
      mkdirSync(path.join(root, "tasks", "no-meta-task"), { recursive: true });

      writeFileSync(path.join(taskDir(root, badMeta.task_id), "meta.json"), "{ broken", "utf8");
      writeFileSync(path.join(taskDir(root, badRecords.task_id), "v001.design.json"), "{ broken", "utf8");

      const snap = await store.snapshotTasks();
      expect(snap.tasks.map((t) => t.task_id)).toEqual([healthy.task_id]);
      expect(snap.degraded.sort()).toEqual([badMeta.task_id, badRecords.task_id, "no-meta-task"].sort());

      const stderr = stderrWrite.mock.calls.flat().join("");
      for (const id of [badMeta.task_id, badRecords.task_id, "no-meta-task"]) {
        expect(stderr).toContain(`task ${id} degraded`);
      }
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("one degraded task reports every corrupt record file in its warning", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { store, root } = newStore();
      const { task_id } = await store.createTask({ title: "Many Bad Records", description: "d", creator: "alice", role: "agent:architect" });
      writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), "{ broken one", "utf8");
      writeFileSync(path.join(taskDir(root, task_id), "v002.note.json"), "{ broken two", "utf8");

      const snap = await store.snapshotTasks();
      expect(snap.degraded).toEqual([task_id]);
      const stderr = stderrWrite.mock.calls.flat().join("");
      expect(stderr).toContain("v001.design.json");
      expect(stderr).toContain("v002.note.json");
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("a task that folds with warnings is a NORMAL entry (needs_attention), never degraded — 3.2 ≠ storage damage", async () => {
    const { store } = newStore();
    const { task_id } = await store.createTask({ title: "Odd Sequence", description: "d", creator: "alice", role: "agent:architect" });
    // derive is mocked in this file: simulate a fold WITH warnings (out-of-table
    // sequence — 3.2 semantics) and prove it stays a normal entry, not degraded.
    const defaultDerived = { status: "designing" as const, waiting_for: "agent:architect" as const, needs_attention: false, warnings: [] };
    const warned = { status: "designing" as const, waiting_for: "human" as const, needs_attention: true, warnings: [{ version: 1, code: "OUT_OF_TABLE" as const }] };
    const mocked = vi.mocked(derive);
    mocked.mockReturnValue(warned);
    try {
      // code_changes with no design → OUT_OF_TABLE in full flow, but it still folds.
      await store.append(task_id, { role: "executor", content_type: "code_changes", payload: validPayload() });

      const snap = await store.snapshotTasks();
      expect(snap.degraded).toEqual([]);
      const entry = snap.tasks.find((t) => t.task_id === task_id)!;
      expect(entry.needs_attention).toBe(true); // flow anomaly ≠ storage damage
      expect(entry.waiting_for).toBe("human");
    } finally {
      mocked.mockReturnValue(defaultDerived);
    }
  });

  it("healthy tree → degraded is an empty array (key absent on the HTTP layer)", async () => {
    const { store } = newStore();
    await store.createTask({ title: "Fine", description: "d", creator: "alice", role: "agent:architect" });
    const snap = await store.snapshotTasks();
    expect(snap.degraded).toEqual([]);
    expect(snap.tasks).toHaveLength(1);
  });
});

describe("readRecords name-pattern tightening", () => {
  it("a corrupt foreign .json file in the task dir is ignored — only v<digits>.<type>.json names fold", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Foreign File", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    writeFileSync(path.join(taskDir(root, task_id), "notes.json"), "{ broken"); // foreign, corrupt — must not brick the task
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json.recovered"), "x"); // recovery copy shape — never folds directly

    const read = await store.readTask(task_id);
    expect(read.versions).toHaveLength(1);
    const snap = await store.snapshotTasks();
    expect(snap.degraded).toEqual([]);
  });
});

describe("structural artifact validation", () => {
  /** Create a task with one healthy record (landed directly on disk — never
   *  folded through this store, so the damage below is what the FIRST fold
   *  sees), then overwrite v001 with structurally-broken content — the exact
   *  damage class P1-2 targets (syntactically-valid JSON that must never
   *  reach derive). */
  async function malformedRecordTask(store: Store, root: string, title: string, build: (taskId: string) => string): Promise<string> {
    const { task_id } = await store.createTask({ title, description: "d", creator: "alice", role: "agent:architect" });
    writeRecordDirect(root, task_id, directDesignRecord(task_id));
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), build(task_id), "utf8");
    return task_id;
  }

  const MALFORMED_RECORDS: [name: string, build: (taskId: string) => string][] = [
    ["empty object", () => "{}"],
    ["note without payload (the derive TypeError repro)", () => JSON.stringify({ content_type: "note" })],
    ["array", () => "[1,2,3]"],
    [
      "string version",
      (taskId) => JSON.stringify({ version: "1", task_id: taskId, role: "r", content_type: "note", timestamp: "t", payload: { summary: "s", body: "b" } }),
    ],
    [
      "payload without summary",
      (taskId) => JSON.stringify({ version: 1, task_id: taskId, role: "r", content_type: "note", timestamp: "t", payload: { body: "b" } }),
    ],
    // Whitespace-only fields: the write door's
    // requireNonEmptyString uses trim() — the read side must not legalize
    // what append refuses.
    [
      "whitespace role",
      (taskId) => JSON.stringify({ version: 1, task_id: taskId, role: " ", content_type: "note", timestamp: "t", payload: { summary: "s", body: "b" } }),
    ],
    [
      "whitespace content_type",
      (taskId) => JSON.stringify({ version: 1, task_id: taskId, role: "r", content_type: "\t", timestamp: "t", payload: { summary: "s", body: "b" } }),
    ],
    [
      "whitespace timestamp",
      (taskId) => JSON.stringify({ version: 1, task_id: taskId, role: "r", content_type: "note", timestamp: " \t ", payload: { summary: "s", body: "b" } }),
    ],
    [
      "whitespace task_id",
      () => JSON.stringify({ version: 1, task_id: " ", role: "r", content_type: "note", timestamp: "t", payload: { summary: "s", body: "b" } }),
    ],
  ];

  for (const [name, build] of MALFORMED_RECORDS) {
    it(`a syntactically-valid but malformed record (${name}) lands the task in degraded, never in tasks[]`, async () => {
      const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const { store, root } = newStore();
        const task_id = await malformedRecordTask(store, root, `Malformed ${name}`, build);

        const snap = await store.snapshotTasks();
        expect(snap.degraded).toEqual([task_id]);
        expect(snap.tasks.map((t) => t.task_id)).not.toContain(task_id);
        expect(stderrWrite.mock.calls.flat().join("")).toContain("degraded");

        // The append door refuses honestly (pre-write fold) and leaks nothing.
        const before = recordFiles(root, task_id);
        await expectCode(store.append(task_id, { role: "agent:architect", content_type: "note", payload: validPayload() }), ErrorCode.VALIDATION_ERROR);
        expect(recordFiles(root, task_id)).toEqual(before); // zero orphans
      } finally {
        stderrWrite.mockRestore();
      }
    });
  }

  it("a cross-task record squatted into the directory is structural damage (directory identity)", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Identity", description: "d", creator: "alice", role: "agent:architect" });
    const foreign = await store.createTask({ title: "Foreign", description: "d", creator: "alice", role: "agent:architect" });
    // Both records land directly on disk (uncached): the squat below is what
    // the first fold of this directory sees.
    writeRecordDirect(root, task_id, directDesignRecord(task_id));
    writeRecordDirect(root, foreign.task_id, directDesignRecord(foreign.task_id));
    writeFileSync(
      path.join(taskDir(root, task_id), "v001.design.json"),
      readFileSync(path.join(taskDir(root, foreign.task_id), "v001.design.json"), "utf8"),
      "utf8",
    );

    expect((await store.snapshotTasks()).degraded).toEqual([task_id]);
  });

  it("a malformed meta (bad flow enum / string version / missing title) degrades the task and stays repairable", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { store, root } = newStore();
      const { task_id } = await store.createTask({ title: "Bad Meta Shape", description: "d", creator: "alice", role: "agent:architect" });
      await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
      const metaPath = path.join(taskDir(root, task_id), "meta.json");
      const base = readMeta(root, task_id);

      for (const mutate of [
        (m: Record<string, unknown>) => { m.flow = "bogus"; },
        (m: Record<string, unknown>) => { m.version = "3"; },
        (m: Record<string, unknown>) => { delete m.title; },
        // Whitespace timestamps: meta's created_at /
        // updated_at use the same trim() emptiness definition as repairMeta's
        // write-side validation — read and write domains cannot drift apart.
        (m: Record<string, unknown>) => { m.created_at = "   "; },
        (m: Record<string, unknown>) => { m.updated_at = " \t "; },
      ]) {
        const mutated = { ...base };
        mutate(mutated);
        writeFileSync(metaPath, JSON.stringify(mutated), "utf8");
        const snap = await store.snapshotTasks();
        expect(snap.degraded).toEqual([task_id]);
        expect(snap.tasks.map((t) => t.task_id)).not.toContain(task_id);

        // The A-class door heals it every time: rebuild → back in tasks[].
        const repaired = await store.repairMeta(task_id, { title: "Bad Meta Shape" });
        expect(repaired.version).toBe(1);
        expect((await store.snapshotTasks()).degraded).toEqual([]);
      }
      expect(stderrWrite.mock.calls.flat().join("")).toContain("degraded");
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("recovery refuses a source that parses but is structurally broken; consumption rejects a hand-registered malformed copy", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Bad Recovery", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    const original = readFileSync(path.join(taskDir(root, task_id), "v001.design.json"));
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), "{ broken", "utf8");

    // Source parses as JSON but is not a well-formed record → registration refused.
    const badSource = path.join(tmp, "bad-source.json");
    writeFileSync(badSource, JSON.stringify({ version: 1, task_id, role: "r", content_type: "design", timestamp: "t" }));
    await expectCode(store.recoverRecord(task_id, { record_file: "v001.design.json", from_path: badSource }), ErrorCode.VALIDATION_ERROR);

    // A hand-written registration whose copy is structurally garbage: the
    // digest chain may verify, but the fold rejects the stand-in — degraded.
    const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
    const copyBytes = Buffer.from(JSON.stringify({ version: 1, task_id, role: "r", content_type: "design", timestamp: "t" }));
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json.recovered"), copyBytes);
    const corruptSha = sha("{ broken");
    writeFileSync(
      path.join(taskDir(root, task_id), "recovery.jsonl"),
      JSON.stringify({
        seq: 1,
        file: "v001.design.json",
        corrupt_sha256: corruptSha,
        recovered_sha256: sha(copyBytes),
        recovered_file: "v001.design.json.recovered",
        source: "hand-written",
        registered_at: "2026-08-31T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );
    expect((await store.snapshotTasks()).degraded).toEqual([task_id]);
    // …and the same shape recovers fine once the copy is well-formed.
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json.recovered"), original);
    writeFileSync(
      path.join(taskDir(root, task_id), "recovery.jsonl"),
      JSON.stringify({
        seq: 1,
        file: "v001.design.json",
        corrupt_sha256: corruptSha,
        recovered_sha256: sha(original),
        recovered_file: "v001.design.json.recovered",
        source: "hand-written",
        registered_at: "2026-08-31T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );
    expect((await store.snapshotTasks()).degraded).toEqual([]);
  });

  it("an unreadable recovery manifest (directory squatting on the name) degrades the task with a diagnosable error", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { store, root } = newStore();
      const { task_id } = await store.createTask({ title: "Manifest Squat", description: "d", creator: "alice", role: "agent:architect" });
      await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
      writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), "{ broken", "utf8");
      mkdirSync(path.join(taskDir(root, task_id), "recovery.jsonl")); // EISDIR — not an empty manifest

      const snap = await store.snapshotTasks();
      expect(snap.degraded).toEqual([task_id]);
      expect(stderrWrite.mock.calls.flat().join("")).toContain("cannot read recovery manifest");
    } finally {
      stderrWrite.mockRestore();
    }
  });
});

describe("repairMeta (A-class, system-design 4.3)", () => {
  it("rebuilds a corrupt meta: version = max on-disk record version (server-computed), caller fields honored", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Original", description: "orig", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    await store.append(task_id, { role: "executor", content_type: "code_changes", payload: validPayload() });
    const originalRecord = readRecordFile(root, task_id, "v002.code_changes.json");
    writeFileSync(path.join(taskDir(root, task_id), "meta.json"), "{ broken", "utf8");

    const result = await store.repairMeta(task_id, {
      title: "Rebuilt Title",
      description: "recovered from notifier snapshot",
      creator: "alice",
      created_at: "2026-08-30T08:00:00.000Z",
      flow: "full",
    });

    expect(result.task_id).toBe(task_id);
    expect(result.version).toBe(2); // max disk record version, not caller input
    const meta = readMeta(root, task_id);
    expect(meta.title).toBe("Rebuilt Title");
    expect(meta.version).toBe(2);
    expect(meta.created_at).toBe("2026-08-30T08:00:00.000Z");
    // records untouched — append-only invariant
    expect(readRecordFile(root, task_id, "v002.code_changes.json")).toEqual(originalRecord);
    // the task is back: append works again
    const appended = await store.append(task_id, { role: "human", content_type: "decision", payload: { ...validPayload(), decision: "close" } });
    expect(appended.version).toBe(3);
  });

  it("refuses a readable meta (repair is not an overwrite path) and 404s a missing dir", async () => {
    const { store } = newStore();
    const { task_id } = await store.createTask({ title: "Healthy", description: "d", creator: "alice", role: "agent:architect" });
    await expectCode(store.repairMeta(task_id, { title: "rogue" }), ErrorCode.VALIDATION_ERROR);
    await expectCode(store.repairMeta("no-such-task", { title: "x" }), ErrorCode.TASK_NOT_FOUND);
  });

  it("meta rebuild on a task whose records are ALSO corrupt: repair lands, no status, stays degraded (B-class pending)", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { store, root } = newStore();
      const { task_id } = await store.createTask({ title: "Double Damage", description: "d", creator: "alice", role: "agent:architect" });
      await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
      writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), "{ broken", "utf8");
      writeFileSync(path.join(taskDir(root, task_id), "meta.json"), "{ broken", "utf8");

      const result = await store.repairMeta(task_id, { title: "Rebuilt" });
      expect(result.version).toBe(1);
      expect(result).not.toHaveProperty("status"); // refold failed — no derived cache
      const snap = await store.snapshotTasks();
      expect(snap.degraded).toEqual([task_id]); // A fixed, B still open
      expect(stderrWrite.mock.calls.flat().join("")).toContain("remains degraded");
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("missing meta.json in an existing dir is repairable (create interrupted between mkdir and writeMeta)", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Interrupted", description: "d", creator: "alice", role: "agent:architect" });
    rmSync(path.join(taskDir(root, task_id), "meta.json"));
    const snap1 = await store.snapshotTasks();
    expect(snap1.degraded).toEqual([task_id]);

    const result = await store.repairMeta(task_id, { title: "Interrupted", flow: "full" });
    expect(result.version).toBe(0);
    const snap2 = await store.snapshotTasks();
    expect(snap2.degraded).toEqual([]);
    expect(snap2.tasks.map((t) => t.task_id)).toEqual([task_id]);
  });

  it("defaults: title falls back to task_id, flow to full, created_at to repair time; project scope rejects flow/cast/title", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Defaults", description: "d", creator: "alice", role: "agent:architect" });
    writeFileSync(path.join(taskDir(root, task_id), "meta.json"), "null", "utf8");

    const result = await store.repairMeta(task_id, {});
    expect(result.version).toBe(0);
    const meta = readMeta(root, task_id);
    expect(meta.title).toBe(task_id);
    expect(meta.flow).toBe("full");
    expect(typeof meta.created_at).toBe("string");

    await store.append("project", { role: "human", content_type: "note", payload: validPayload() });
    writeFileSync(path.join(root, "tasks", "project", "meta.json"), "{ broken", "utf8");
    await expectCode(store.repairMeta("project", { flow: "full" }), ErrorCode.VALIDATION_ERROR);
    const repaired = await store.repairMeta("project", {});
    expect(repaired.version).toBe(1);
    expect(readMeta(root, "project").title).toBe("project");
  });
});

describe("recoverRecord (B-class, system-design 4.3)", () => {
  async function corruptOneRecord(store: Store, root: string, title: string): Promise<{ task_id: string; recordFile: string; original: Buffer }> {
    // Healthy record lands DIRECTLY on disk (never folded through this
    // store) so the corruption below is what every fold of this directory
    // sees — the live-cache blind spot for in-place edits is pinned
    // separately in store-cache.test.ts.
    const { task_id } = await store.createTask({ title, description: "d", creator: "alice", role: "agent:architect" });
    writeRecordDirect(root, task_id, directDesignRecord(task_id));
    const recordFile = "v001.design.json";
    const original = readFileSync(path.join(taskDir(root, task_id), recordFile));
    writeFileSync(path.join(taskDir(root, task_id), recordFile), "{ broken beyond parse", "utf8");
    return { task_id, recordFile, original };
  }

  it("registers recovery from an external snapshot: fold uses the copy, the corrupt original stays byte-for-byte", async () => {
    const { store, root } = newStore();
    const { task_id, recordFile, original } = await corruptOneRecord(store, root, "Recoverable");
    expect((await store.snapshotTasks()).degraded).toEqual([task_id]);

    // External snapshot: the original bytes, held by the human.
    const snapshotPath = path.join(tmp, "external-snapshot.json");
    writeFileSync(snapshotPath, original);

    const result = await store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath, source: "nightly backup" });
    expect(result).toEqual({ task_id, record_file: recordFile, seq: 1, recovered_file: `${recordFile}.recovered` });

    // The corrupt original is PRESERVED (pinned evidence), the copy sits next to it.
    const corruptBytes = readFileSync(path.join(taskDir(root, task_id), recordFile));
    expect(corruptBytes.toString("utf8")).toBe("{ broken beyond parse");

    // Registration line landed in recovery.jsonl with both digests.
    const line = JSON.parse(readFileSync(path.join(taskDir(root, task_id), "recovery.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ seq: 1, file: recordFile, recovered_file: `${recordFile}.recovered`, source: "nightly backup" });

    // The task folds again — readTask serves the recovered content.
    const snap = await store.snapshotTasks();
    expect(snap.degraded).toEqual([]);
    const read = await store.readTask(task_id);
    expect(read.versions).toHaveLength(1);
    expect(read.versions[0]!.payload.summary).toBe("a summary");
    // And the append door reopens.
    const appended = await store.append(task_id, { role: "human", content_type: "decision", payload: { ...validPayload(), decision: "close" } });
    expect(appended.version).toBe(2);
  });

  it("cross-task identity damage (P1-2 round 2): a JSON-valid original belonging to ANOTHER task is corruption — the right snapshot recovers it, bytes pinned, wrong-task source still refused", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Identity Damage", description: "d", creator: "alice", role: "agent:architect" });
    // Healthy record lands directly (uncached) — the squat below is the
    // first fold of this name set.
    writeRecordDirect(root, task_id, directDesignRecord(task_id));
    const original = readFileSync(path.join(taskDir(root, task_id), "v001.design.json"));

    // The squatter: a structurally VALID record — but it belongs to another
    // task. The fold's readRecords judges it damage via directory identity;
    // pre-fix, recoverRecord's original check OMITTED taskId and judged the
    // same bytes healthy ("parses — nothing to recover") — a one-way degraded
    // stay no correct snapshot could ever lift.
    const foreign = await store.createTask({ title: "Foreign Source", description: "d", creator: "alice", role: "agent:architect" });
    writeRecordDirect(root, foreign.task_id, directDesignRecord(foreign.task_id));
    const foreignBytes = readFileSync(path.join(taskDir(root, foreign.task_id), "v001.design.json"));
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), foreignBytes);
    expect((await store.snapshotTasks()).degraded).toEqual([task_id]);

    // A wrong-task snapshot is refused (source identity guard, unchanged) —
    // and the refusal leaves no registration behind, so it consumes nothing.
    const wrongSnap = path.join(tmp, "identity-wrong.json");
    writeFileSync(wrongSnap, foreignBytes);
    await expectCode(store.recoverRecord(task_id, { record_file: "v001.design.json", from_path: wrongSnap }), ErrorCode.VALIDATION_ERROR);

    // The human's snapshot holds THIS task's true v001 — registration lands,
    // the task returns to tasks[], and the cross-task original is pinned
    // byte-for-byte as evidence.
    const snapshotPath = path.join(tmp, "identity-snap.json");
    writeFileSync(snapshotPath, original);
    const result = await store.recoverRecord(task_id, { record_file: "v001.design.json", from_path: snapshotPath, source: "nightly backup" });
    expect(result).toEqual({ task_id, record_file: "v001.design.json", seq: 1, recovered_file: "v001.design.json.recovered" });
    expect((await store.snapshotTasks()).degraded).toEqual([]);
    const read = await store.readTask(task_id);
    expect(read.versions).toHaveLength(1);
    expect(read.versions[0]!.payload.summary).toBe("a summary");
    expect(readFileSync(path.join(taskDir(root, task_id), "v001.design.json"))).toEqual(foreignBytes); // pinned, untouched
  });

  it("digest chain: modifying the corrupt original after registration voids it — back to degraded", async () => {
    const { store, root } = newStore();
    const { task_id, recordFile, original } = await corruptOneRecord(store, root, "Tamper Original");
    const snapshotPath = path.join(tmp, "snap2.json");
    writeFileSync(snapshotPath, original);
    await store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath });
    expect((await store.snapshotTasks()).degraded).toEqual([]);

    // Someone edits the bad original after the fact — the registration no longer describes reality.
    // (cache protocol: the edit is in place, so a hub that already folded
    // the registered state re-verifies on restart or any name change — assert
    // through a fresh store, the honest cold reader.)
    writeFileSync(path.join(taskDir(root, task_id), recordFile), "{ broken differently", "utf8");
    const reopened = new Store(root);
    expect((await reopened.snapshotTasks()).degraded).toEqual([task_id]);
  });

  it("digest chain: modifying the .recovered copy after registration voids it too", async () => {
    const { store, root } = newStore();
    const { task_id, recordFile, original } = await corruptOneRecord(store, root, "Tamper Copy");
    const snapshotPath = path.join(tmp, "snap3.json");
    writeFileSync(snapshotPath, original);
    await store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath });

    writeFileSync(path.join(taskDir(root, task_id), `${recordFile}.recovered`), "{}", "utf8");
    expect((await store.snapshotTasks()).degraded).toEqual([task_id]);
  });

  it("registration is once-only: a second registration hits the EEXIST copy and refuses", async () => {
    const { store, root } = newStore();
    const { task_id, recordFile, original } = await corruptOneRecord(store, root, "Once Only");
    const snapshotPath = path.join(tmp, "snap4.json");
    writeFileSync(snapshotPath, original);
    await store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath });
    // The task folds now — but even re-corrupting cannot re-register: the copy is exclusive.
    writeFileSync(path.join(taskDir(root, task_id), recordFile), "{ broken again", "utf8");
    await expectCode(store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath }), ErrorCode.VALIDATION_ERROR);
  });

  it("refuses: healthy record, missing original, bad record_file shape, version/task mismatch in the source", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Guards", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });

    // healthy record — nothing to recover
    await expectCode(store.recoverRecord(task_id, { record_file: "v001.design.json", from_path: "/etc/hostname" }), ErrorCode.VALIDATION_ERROR);
    // not a record file name
    await expectCode(store.recoverRecord(task_id, { record_file: "meta.json", from_path: "/etc/hostname" }), ErrorCode.VALIDATION_ERROR);
    await expectCode(store.recoverRecord(task_id, { record_file: "../v001.design.json", from_path: "/etc/hostname" }), ErrorCode.VALIDATION_ERROR);
    // unknown task
    await expectCode(store.recoverRecord("no-such-task", { record_file: "v001.design.json", from_path: "/etc/hostname" }), ErrorCode.TASK_NOT_FOUND);

    // corrupt one record; the external snapshot holds the WRONG record (different version/task)
    const other = await store.createTask({ title: "Other", description: "d", creator: "alice", role: "agent:architect" });
    await store.append(other.task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
    const wrongSnap = path.join(tmp, "wrong.json");
    writeFileSync(wrongSnap, JSON.stringify(readRecordFile(root, other.task_id, "v001.design.json")));
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), "{ broken", "utf8");
    await expectCode(store.recoverRecord(task_id, { record_file: "v001.design.json", from_path: wrongSnap }), ErrorCode.VALIDATION_ERROR);
  });

  it("two-phase commit (P1-1): a manifest-write failure after the copy lands leaves a RETRYABLE orphan — the retry adopts the copy and completes the registration", async () => {
    const { store, root } = newStore();
    const { task_id, recordFile, original } = await corruptOneRecord(store, root, "Orphan Retry");
    const snapshotPath = path.join(tmp, "orphan-snap.json");
    writeFileSync(snapshotPath, original);

    // Fail the manifest append (phase 2 — the commit point) exactly once: the
    // .recovered copy has already landed when it throws.
    const internals = store as unknown as { appendRecoveryLine: (taskId: string, line: string) => Promise<void> };
    const realAppend = internals.appendRecoveryLine.bind(store);
    let calls = 0;
    const spy = vi.spyOn(internals, "appendRecoveryLine").mockImplementation(async (taskId: string, line: string) => {
      calls += 1;
      if (calls === 1) throw new Error("ENOSPC: manifest write failed");
      await realAppend(taskId, line);
    });
    try {
      await expect(store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath })).rejects.toThrow(
        /manifest write failed/,
      );
    } finally {
      spy.mockRestore();
    }

    // Orphan state: copy on disk, NO registration line, task still degraded.
    const dir = taskDir(root, task_id);
    expect(readdirSync(dir)).toContain(`${recordFile}.recovered`);
    expect(readdirSync(dir)).not.toContain("recovery.jsonl");
    expect((await store.snapshotTasks()).degraded).toEqual([task_id]);

    // I/O healed — the retry must NOT hit a final once-only refusal: it adopts
    // the byte-identical orphan and commits the registration line.
    const result = await store.recoverRecord(task_id, {
      record_file: recordFile,
      from_path: snapshotPath,
      source: "retry after I/O heal",
    });
    expect(result).toEqual({ task_id, record_file: recordFile, seq: 1, recovered_file: `${recordFile}.recovered` });

    // Exactly one copy (no second inconsistent copy), one valid line, task
    // back in tasks[], corrupt original byte-for-byte unchanged.
    expect(readdirSync(dir).filter((f) => f.endsWith(".recovered"))).toEqual([`${recordFile}.recovered`]);
    const lines = readFileSync(path.join(dir, "recovery.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 1, file: recordFile, source: "retry after I/O heal" });
    expect((await store.snapshotTasks()).degraded).toEqual([]);
    expect((await store.readTask(task_id)).versions).toHaveLength(1);
    expect(readFileSync(path.join(dir, recordFile), "utf8")).toBe("{ broken beyond parse");
  });

  it("an unregistered orphan copy with DIFFERENT bytes is refused with a clear conflict — never overwritten, never a second copy (P1-1)", async () => {
    const { store, root } = newStore();
    const { task_id, recordFile, original } = await corruptOneRecord(store, root, "Orphan Mismatch");
    // Hand-placed orphan from an interrupted registration, holding other bytes.
    writeFileSync(path.join(taskDir(root, task_id), `${recordFile}.recovered`), "{}", "utf8");
    // A VALID source for this file (right version/task) whose bytes differ from the orphan.
    const snapshotPath = path.join(tmp, "orphan-mismatch.json");
    writeFileSync(snapshotPath, JSON.stringify(JSON.parse(original.toString("utf8")), null, 4));

    await expectCode(store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath }), ErrorCode.VALIDATION_ERROR);

    const dir = taskDir(root, task_id);
    expect(readFileSync(path.join(dir, `${recordFile}.recovered`), "utf8")).toBe("{}"); // orphan untouched
    expect(existsSync(path.join(dir, "recovery.jsonl"))).toBe(false); // nothing committed
    expect(readdirSync(dir).filter((f) => f.endsWith(".recovered"))).toHaveLength(1); // no second copy
    expect((await store.snapshotTasks()).degraded).toEqual([task_id]);
  });

  it("a completed registration line still refuses re-registration up front (once-only verdict is the manifest, not the EEXIST)", async () => {
    const { store, root } = newStore();
    const { task_id, recordFile, original } = await corruptOneRecord(store, root, "Once Only Manifest");
    const snapshotPath = path.join(tmp, "once-manifest.json");
    writeFileSync(snapshotPath, original);
    await store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath });

    // Even with the original re-corrupted (digest chain voided), the
    // registration line stands — refusal comes from the manifest check.
    writeFileSync(path.join(taskDir(root, task_id), recordFile), "{ broken anew", "utf8");
    await expectCode(store.recoverRecord(task_id, { record_file: recordFile, from_path: snapshotPath }), ErrorCode.VALIDATION_ERROR);
    expect((await store.snapshotTasks()).degraded).toEqual([task_id]); // voided chain: degraded again
  });
});

describe("post-write degradation and close boundaries", () => {
  it("a post-landing bookkeeping failure never rejects the landed write: degraded success with needs_attention", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Post Write", description: "d", creator: "alice", role: "agent:architect" });
    // Force writeMeta to fail AFTER the record file lands (disk-full / permission shape).
    const writeMetaSpy = vi
      .spyOn(store as unknown as { writeMeta: (taskId: string, meta: unknown) => Promise<void> }, "writeMeta")
      .mockRejectedValue(new Error("ENOSPC: no space left on device"));
    try {
      const result = await store.append(task_id, { role: "agent:architect", content_type: "design", payload: validPayload() });
      // The write LANDED — the call must say so, honestly degraded.
      expect(result).toMatchObject({ task_id, version: 1, needs_attention: true });
      expect(recordFiles(root, task_id)).toEqual(["v001.design.json"]); // record is on disk
    } finally {
      writeMetaSpy.mockRestore();
    }
    // Next append heals the stale meta via crash-window reconciliation (version from disk max).
    const healed = await store.append(task_id, { role: "agent:architect", content_type: "note", payload: validPayload() });
    expect(healed.version).toBe(2);
  });

  it("decide close on a vanished directory is an honest TASK_NOT_FOUND (C-class: no log left to append to)", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Vanishing", description: "d", creator: "alice", role: "agent:architect" });
    rmSync(taskDir(root, task_id), { recursive: true, force: true });
    await expectCode(
      store.append(task_id, { role: "human", content_type: "decision", payload: { ...validPayload(), decision: "close" } }),
      ErrorCode.TASK_NOT_FOUND,
    );
  });

  it("decide close is unavailable while records are corrupt (B-class pending) and available again after recovery", async () => {
    const { store, root } = newStore();
    const { task_id } = await store.createTask({ title: "Close Gate", description: "d", creator: "alice", role: "agent:architect" });
    writeRecordDirect(root, task_id, directDesignRecord(task_id));
    const original = readFileSync(path.join(taskDir(root, task_id), "v001.design.json"));
    writeFileSync(path.join(taskDir(root, task_id), "v001.design.json"), "{ broken", "utf8");

    await expectCode(
      store.append(task_id, { role: "human", content_type: "decision", payload: { ...validPayload(), decision: "close" } }),
      ErrorCode.VALIDATION_ERROR,
    );

    const snapshotPath = path.join(tmp, "close-gate-snapshot.json");
    writeFileSync(snapshotPath, original);
    await store.recoverRecord(task_id, { record_file: "v001.design.json", from_path: snapshotPath, source: "backup" });
    const closed = await store.append(task_id, { role: "human", content_type: "decision", payload: { ...validPayload(), decision: "close" } });
    expect(closed.version).toBe(2);
    expect(recordFiles(root, task_id).sort()).toEqual(["recovery.jsonl", "v001.design.json", "v001.design.json.recovered", "v002.decision.json"].sort());
  });
});


describe("task ID dot hygiene", () => {
  it("normalizes dotted titles and rejects repair-created dotted IDs", async () => {
    const { store, root } = newStore();
    const created = await store.createTask({ title: "new.task", description: "d", creator: "human", role: "architect" });
    expect(created.task_id).toBe("new-task");
    mkdirSync(taskDir(root, "new.task"));
    await expectCode(store.repairMeta("new.task", {}), ErrorCode.VALIDATION_ERROR);
    expect(existsSync(path.join(taskDir(root, "new.task"), "meta.json"))).toBe(false);
  });

  it("reads, lists, derives and appends to a historical dotted task without rewriting records", async () => {
    const { store, root } = newStore();
    const created = await store.createTask({ title: "seed", description: "d", creator: "human", role: "architect" });
    const id = "old.task";
    mkdirSync(taskDir(root, id));
    writeFileSync(path.join(taskDir(root, id), "meta.json"), JSON.stringify({ ...readMeta(root, created.task_id), task_id: id }));
    writeRecordDirect(root, id, directDesignRecord(id));
    const recordPath = path.join(taskDir(root, id), "v001.design.json");
    const original = readFileSync(recordPath);
    expect(await store.readTask(id)).toMatchObject({ task_id: id, status: "implementing" });
    expect((await store.listTasks()).some((task) => task.task_id === id)).toBe(true);
    expect((await store.snapshotTasks()).tasks).toContainEqual(expect.objectContaining({ task_id: id, status: "implementing" }));
    await store.append(id, { role: "executor", content_type: "code_changes", payload: validPayload() });
    expect(await store.readTask(id)).toMatchObject({ task_id: id, status: "reviewing" });
    expect(readFileSync(recordPath)).toEqual(original);
  });
});

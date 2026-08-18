import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derive } from "../src/state-machine.js";
import { Store, StoreError, type AppendInput, type AppendResult, type CreateTaskInput } from "../src/store.js";
import { ErrorCode, type ContextRecord, type DerivedState, type Flow } from "../src/types.js";

/**
 * Seam integration: the REAL store on a temp dir
 * against the REAL derive — no vi.mock anywhere in this file. The golden
 * vectors are consumed a second time through the store (dual consumption):
 * whatever the two layers produce must agree with the frozen fixtures.
 *
 * Vectors carry an optional flow; createTask passes vector.flow through so
 * meta.json selects the transition table, and every surface (append result,
 * meta cache, readTask, replay) must agree with the per-flow expectation.
 *
 * Version semantics note: append assigns contiguous versions in append order,
 * so fixture records are appended sorted by version — for sequences the store
 * itself writes, "fold by version" and "fold by append order" coincide. The
 * out-of-table-ness of the fixture ARRAYS (out-of-order vectors) is derive's
 * direct concern and is covered by test/state-machine.test.ts.
 */

interface GoldenVector {
  name: string;
  task_id: string;
  flow?: Flow;
  records: ContextRecord[];
  expected: DerivedState | null;
}

const raw = JSON.parse(
  readFileSync(new URL("./fixtures/sequences.json", import.meta.url), "utf8"),
) as Array<Partial<GoldenVector> & { $comment?: string }>;

// Element 0 is the $comment preamble; every real vector carries a name.
const vectors = raw.filter((v): v is GoldenVector => typeof v.name === "string");

const isProjectVector = (v: GoldenVector): boolean => v.task_id === "project";

/** Appendable = sorted versions are exactly 1..N (what the store can itself write). */
function isAppendable(v: GoldenVector): boolean {
  const versions = v.records.map((r) => r.version).sort((a, b) => a - b);
  return versions.every((x, i) => x === i + 1);
}

/** createTask input for a vector: flow passed through when the vector declares one (absent = full). */
function vectorCreateInput(v: GoldenVector, description: string): CreateTaskInput {
  return {
    title: v.task_id,
    description,
    creator: "fixture",
    role: "agent:architect",
    ...(v.flow !== undefined ? { flow: v.flow } : {}),
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tut-seam-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function taskDir(root: string, taskId: string): string {
  return path.join(root, "tasks", taskId);
}

async function readMeta(root: string, taskId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(taskDir(root, taskId), "meta.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Cached derived state as stored in meta.json (the four derived fields). */
function cachedDerived(meta: Record<string, unknown>): {
  status: unknown;
  waiting_for: unknown;
  needs_attention: unknown;
  warnings: unknown;
} {
  return {
    status: meta.status,
    waiting_for: meta.waiting_for,
    needs_attention: meta.needs_attention,
    warnings: meta.warnings,
  };
}

/** All record files of a task straight from disk, sorted by version (replay input). */
async function readDiskRecords(root: string, taskId: string): Promise<ContextRecord[]> {
  const names = (await readdir(taskDir(root, taskId))).filter((n) => n !== "meta.json" && n.endsWith(".json"));
  const records: ContextRecord[] = [];
  for (const name of names) {
    records.push(JSON.parse(await readFile(path.join(taskDir(root, taskId), name), "utf8")) as ContextRecord);
  }
  records.sort((a, b) => a.version - b.version);
  return records;
}

/** Fixture record → append input (agent/model carried through when present). */
function toAppendInput(r: ContextRecord): AppendInput {
  const input: AppendInput = { role: r.role, content_type: r.content_type, payload: r.payload };
  if (r.agent !== undefined) input.agent = r.agent;
  if (r.model !== undefined) input.model = r.model;
  return input;
}

/** Compare a landed record with its fixture source, ignoring the store-generated timestamp. */
function stripTimestamp(r: ContextRecord): Omit<ContextRecord, "timestamp"> {
  const { timestamp: _timestamp, ...rest } = r;
  return rest;
}

function mustDerive(taskId: string, records: readonly ContextRecord[]): DerivedState {
  const derived = derive(taskId, records);
  if (derived === null) throw new Error(`derive unexpectedly returned null for task ${taskId}`);
  return derived;
}

// ---------------------------------------------------------------------------
// 1. Golden vectors through the store (dual consumption)
// ---------------------------------------------------------------------------

describe("golden vectors through the store (dual consumption)", () => {
  const nonProject = vectors.filter((v) => !isProjectVector(v));
  const structuralAll = nonProject.filter((v) => !isAppendable(v));
  const appendable = nonProject.filter((v) => isAppendable(v));

  it("covers every non-project vector except the structural-anomaly ones", () => {
    // Guard against fixture edits silently shrinking the dual-consumption net.
    expect(appendable).toHaveLength(nonProject.length - structuralAll.length);
  });

  for (const vector of appendable) {
    describe(vector.name, () => {
      it("store replay matches the frozen expectation on every surface", async () => {
        const root = path.join(tmp, ".context-hub");
        const store = new Store(root);
        const created = await store.createTask(vectorCreateInput(vector, "golden vector replay"));
        expect(created.task_id).toBe(vector.task_id);
        if (vector.flow === "direct") {
          // create output status follows the flow (system-design 4.1).
          expect(created.status).toBe("implementing");
        }

        const ordered = [...vector.records].sort((a, b) => a.version - b.version);
        let last: AppendResult | undefined;
        for (const record of ordered) {
          last = await store.append(vector.task_id, toAppendInput(record));
        }
        const expected = vector.expected as DerivedState;

        // Surface 1: the store-returned status of the final append.
        if (last !== undefined) {
          expect(last.status).toBe(expected.status);
          expect(last.needs_attention).toBe(expected.needs_attention);
          expect(last.warnings ?? []).toStrictEqual(expected.warnings);
        }

        // Surface 2: the meta.json cache — the full derived state.
        const meta = await readMeta(root, vector.task_id);
        expect(cachedDerived(meta)).toStrictEqual({
          status: expected.status,
          waiting_for: expected.waiting_for,
          needs_attention: expected.needs_attention,
          warnings: expected.warnings,
        });
        // flow lands in meta exactly as declared and never changes (immutability by construction).
        expect(meta.flow).toBe(vector.flow ?? undefined);

        // Surface 3: readTask — status, plus the landed records match the
        // fixture records (timestamp aside — the store generates it, decision 13).
        const read = await store.readTask(vector.task_id);
        expect(read.status).toBe(expected.status);
        expect(read.versions.map(stripTimestamp)).toStrictEqual(ordered.map(stripTimestamp));

        // Replay: derive over exactly what readTask returned agrees too.
        expect(derive(vector.task_id, read.versions, vector.flow)).toStrictEqual(expected);
      });
    });
  }
});

describe("golden vectors via the external-edit channel (version gap / duplicate)", () => {
  // The store only ever writes contiguous versions; these fixtures describe
  // externally modified storage (their own body text says so), which plan
  // matrix row 12 designates as a design-approved input channel.
  const structural = vectors.filter((v) => !isProjectVector(v) && !isAppendable(v));

  it("is exactly the five structural-anomaly vectors (4 full + 1 solo)", () => {
    expect(structural.map((v) => v.name).sort()).toEqual([
      "ack-note-keeps-own-structural-warning",
      "solo-version-gap-folds-with-warning",
      "version-duplicate-folds-with-warning",
      "version-gap-at-sequence-start",
      "version-gap-folds-with-warning",
    ]);
  });

  for (const vector of structural) {
    it(`${vector.name}: readTask derives from whatever is on disk`, async () => {
      const root = path.join(tmp, ".context-hub");
      const store = new Store(root);
      await store.createTask(vectorCreateInput(vector, "structural anomaly replay"));

      for (const record of vector.records) {
        const file = `v${String(record.version).padStart(3, "0")}.${String(record.content_type).replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
        await writeFile(path.join(taskDir(root, vector.task_id), file), JSON.stringify(record, null, 2), "utf8");
      }

      const expected = vector.expected as DerivedState;
      const read = await store.readTask(vector.task_id);
      expect(read.status).toBe(expected.status);
      expect(read.versions).toStrictEqual(vector.records.slice().sort((a, b) => a.version - b.version));
      expect(derive(vector.task_id, read.versions, vector.flow)).toStrictEqual(expected);
    });
  }
});

describe("golden vectors: project scope through the store", () => {
  it("project-scope-empty-null: with no create and no appends nothing exists — readTask has no status", async () => {
    const store = new Store(path.join(tmp, ".context-hub"));
    await expect(store.readTask("project")).rejects.toMatchObject({ code: ErrorCode.TASK_NOT_FOUND });
    expect(await store.listTasks()).toEqual([]);
  });

  it("project-scope-records-skipped: appends without create land, readTask returns no status", async () => {
    const root = path.join(tmp, ".context-hub");
    const store = new Store(root);
    const vector = vectors.find((v) => v.name === "project-scope-records-skipped");
    if (vector === undefined) throw new Error("fixture project-scope-records-skipped missing");

    for (const record of vector.records) {
      const result = await store.append("project", toAppendInput(record));
      expect(result.status).toBeUndefined(); // project scope carries no status semantics
    }

    const read = await store.readTask("project");
    expect("status" in read).toBe(false);
    expect(read.versions.map((r) => r.version)).toEqual([1, 2]);
    expect(read.versions.map(stripTimestamp)).toStrictEqual(
      vector.records.slice().sort((a, b) => a.version - b.version).map(stripTimestamp),
    );
    expect(derive("project", read.versions)).toBeNull(); // the fixture expectation, via real derive

    const meta = await readMeta(root, "project");
    expect(meta.version).toBe(2);
    expect("status" in meta).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Consistency property: cache === replay after EVERY append
// ---------------------------------------------------------------------------

describe("consistency property", () => {
  it("after each append: meta.json cache === derive(records on disk) === readTask status", async () => {
    const root = path.join(tmp, ".context-hub");
    const store = new Store(root);
    const { task_id } = await store.createTask({
      title: "Consistency Probe",
      description: "mixed sequence with out-of-table records and acks",
      creator: "fixture",
      role: "agent:architect",
    });

    // Mixed sequence: normal transitions, an out-of-table review, an ack that
    // clears it, a review pass, a human approve, an unknown content type
    // (out-of-table again), then close from approved.
    const sequence: AppendInput[] = [
      { role: "architect", content_type: "design", payload: { summary: "design", body: "## Selected approach\nProbe." } },
      { role: "reviewer", content_type: "review", payload: { summary: "too early", verdict: "pass", body: "out of sequence" } },
      { role: "human", content_type: "note", payload: { summary: "acknowledged", body: "reviewed, no action needed", ack: true } },
      { role: "executor", content_type: "code_changes", payload: { summary: "implemented", body: "as designed", commits: ["aaa1111"] } },
      { role: "reviewer", content_type: "review", payload: { summary: "pass", verdict: "pass", ref_version: 4, body: "no open issues" } },
      { role: "human", content_type: "decision", payload: { summary: "approved", decision: "approve", body: "ship it" } },
      { role: "executor", content_type: "custom_report", payload: { summary: "stray report", body: "unknown content type" } },
      { role: "human", content_type: "decision", payload: { summary: "closed", decision: "close", body: "done" } },
    ];

    for (let i = 0; i < sequence.length; i++) {
      const appendResult = await store.append(task_id, sequence[i]!);

      const diskRecords = await readDiskRecords(root, task_id);
      expect(diskRecords.map((r) => r.version)).toEqual(Array.from({ length: i + 1 }, (_, k) => k + 1));

      const replay = mustDerive(task_id, diskRecords); // derive(all records sorted by version)

      // cache === replay
      const meta = await readMeta(root, task_id);
      expect(cachedDerived(meta), `after append ${i + 1}`).toStrictEqual({
        status: replay.status,
        waiting_for: replay.waiting_for,
        needs_attention: replay.needs_attention,
        warnings: replay.warnings,
      });

      // readTask === replay
      const read = await store.readTask(task_id);
      expect(read.status, `after append ${i + 1}`).toBe(replay.status);

      // and the append result itself agrees
      expect(appendResult.status).toBe(replay.status);
      expect(appendResult.needs_attention).toBe(replay.needs_attention);
      expect(appendResult.warnings ?? []).toStrictEqual(replay.warnings);
    }

    // Terminal state of this sequence: closed with one surviving warning (v7).
    const final = mustDerive(task_id, await readDiskRecords(root, task_id));
    expect(final).toStrictEqual({
      status: "closed",
      waiting_for: "human",
      needs_attention: true,
      warnings: [{ version: 7, code: "OUT_OF_TABLE" }],
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent append end-state
// ---------------------------------------------------------------------------

describe("concurrent appends (single-writer queue)", () => {
  it("10 concurrent mixed appends: all succeed, versions 1..10 contiguous, final status === derive of full sorted list", async () => {
    const root = path.join(tmp, ".context-hub");
    const store = new Store(root);
    const { task_id } = await store.createTask({
      title: "Concurrency Probe",
      description: "concurrent mixed appends",
      creator: "fixture",
      role: "agent:architect",
    });

    const inputs: AppendInput[] = [
      { role: "architect", content_type: "design", payload: { summary: "design", body: "selected approach" } },
      { role: "executor", content_type: "note", payload: { summary: "note 1", body: "context" } },
      { role: "executor", content_type: "code_changes", payload: { summary: "implemented", body: "as designed", commits: ["bbb2222"] } },
      { role: "reviewer", content_type: "review", payload: { summary: "review", verdict: "pass", body: "fine" } },
      { role: "executor", content_type: "custom_report", payload: { summary: "report", body: "unknown type" } },
      { role: "executor", content_type: "revision", payload: { summary: "revision", body: "fixed", ref_version: 4, commits: ["ccc3333"] } },
      { role: "human", content_type: "decision", payload: { summary: "close", decision: "close", body: "closing early" } },
      { role: "human", content_type: "note", payload: { summary: "note 2", body: "post-close" } },
      { role: "reviewer", content_type: "review", payload: { summary: "late review", verdict: "fail_code", body: "issues" } },
      { role: "human", content_type: "decision", payload: { summary: "approve?", decision: "approve", body: "out of sequence" } },
    ];

    const results = await Promise.all(inputs.map((input) => store.append(task_id, input)));
    expect(results).toHaveLength(10);
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const read = await store.readTask(task_id);
    expect(read.versions.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const final = mustDerive(task_id, read.versions);
    expect(read.status).toBe(final.status);

    // Cache === replay holds at the terminal state too.
    const meta = await readMeta(root, task_id);
    expect(cachedDerived(meta)).toStrictEqual({
      status: final.status,
      waiting_for: final.waiting_for,
      needs_attention: final.needs_attention,
      warnings: final.warnings,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Recovery / replay from disk with a fresh Store instance
// ---------------------------------------------------------------------------

describe("recovery: a new Store on the same root derives identical results", () => {
  it("readTask and listTasks are pure functions of disk state", async () => {
    const root = path.join(tmp, ".context-hub");
    const first = new Store(root);
    const a = await first.createTask({ title: "Recovery A", description: "d", creator: "fixture", role: "agent:architect" });
    const b = await first.createTask({ title: "Recovery B", description: "d", creator: "fixture", role: "agent:architect" });
    await first.append(a.task_id, {
      role: "architect",
      content_type: "design",
      payload: { summary: "design", body: "selected approach" },
    });
    await first.append(a.task_id, {
      role: "executor",
      content_type: "code_changes",
      payload: { summary: "implemented", body: "as designed", commits: ["ddd4444"] },
    });
    await first.append("project", { role: "human", content_type: "note", payload: { summary: "seed", body: "project scope record" } });

    const readA1 = await first.readTask(a.task_id);
    const readB1 = await first.readTask(b.task_id);
    const readProject1 = await first.readTask("project");
    const list1 = await first.listTasks();

    const second = new Store(root); // no in-memory state carried over
    expect(await second.readTask(a.task_id)).toStrictEqual(readA1);
    expect(await second.readTask(b.task_id)).toStrictEqual(readB1);
    expect(await second.readTask("project")).toStrictEqual(readProject1);
    expect(await second.listTasks()).toStrictEqual(list1);

    expect(readA1.status).toBe("reviewing");
    expect(readB1.status).toBe("designing");
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-check via listTasks
// ---------------------------------------------------------------------------

describe("cross-check: listTasks agrees with derivation", () => {
  it("lists created tasks with correct status; project entry has scope and no status; filter excludes it", async () => {
    const store = new Store(path.join(tmp, ".context-hub"));
    const alpha = await store.createTask({ title: "Alpha Task", description: "d", creator: "fixture", role: "agent:architect" });
    const beta = await store.createTask({ title: "Beta Task", description: "d", creator: "fixture", role: "agent:architect" });
    await store.append(alpha.task_id, {
      role: "architect",
      content_type: "design",
      payload: { summary: "design", body: "selected approach" },
    });
    await store.append("project", { role: "human", content_type: "note", payload: { summary: "seed", body: "project scope record" } });

    const all = await store.listTasks();
    expect(all.map((t) => t.task_id)).toEqual(["alpha-task", "beta-task", "project"]);

    const alphaEntry = all.find((t) => t.task_id === alpha.task_id);
    expect(alphaEntry?.status).toBe("implementing");
    expect(alphaEntry?.waiting_for).toBe("agent:executor");
    expect(alphaEntry?.needs_attention).toBe(false);

    const betaEntry = all.find((t) => t.task_id === beta.task_id);
    expect(betaEntry?.status).toBe("designing");
    expect(betaEntry?.waiting_for).toBe("agent:architect");

    const projectEntry = all.find((t) => t.task_id === "project");
    expect(projectEntry?.scope).toBe("project");
    expect(projectEntry && "status" in projectEntry).toBe(false);

    // Status filter excludes the project-scope entry and non-matching tasks.
    expect((await store.listTasks("implementing")).map((t) => t.task_id)).toEqual(["alpha-task"]);
    expect(await store.listTasks("closed")).toEqual([]);

    // listTasks entries agree with readTask's derivation for the same tasks.
    expect((await store.readTask(alpha.task_id)).status).toBe(alphaEntry?.status);
    expect((await store.readTask(beta.task_id)).status).toBe(betaEntry?.status);

    // The store error type is the contract-bearing error (import sanity, no mocks involved).
    await expect(store.readTask("ghost")).rejects.toBeInstanceOf(StoreError);
  });
});

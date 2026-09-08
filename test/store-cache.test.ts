/**
 * Read-path cache protocol tests:
 * structural, readFile-counting assertions through a counting fs mock — the
 * gate table's "/state 构建记录读次数 = N 次 readdir + 仅新记录" in vitest form.
 *
 * Protocol under test (src/store.ts TaskFoldCache):
 *   - token hit (directory's fold-relevant names unchanged) → ZERO record reads
 *   - external record-file addition → ONLY the additions read, folded onto the cursor
 *   - deletion / non-record additions (recovery artifacts) → cold full re-read
 *   - in-place content edits are OUTSIDE the token's resolution (name list is
 *     the invalidation medium — pinned here as the designed boundary, with the
 *     two detection paths that DO see them: cold store, next name change)
 *   - per-task mutation queues: different tasks' appends never queue behind
 *     each other; same-task appends stay serialized; createTask keeps the
 *     global slug mutex
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Counting seam: every readFile/writeFile through node:fs/promises is counted
// (record-file reads by name pattern; meta reads separately; controllable
// write gates for the concurrency tests). Real fs still backs everything.
const fsm = vi.hoisted(() => ({
  recordReads: 0,
  metaReads: 0,
  workspaceReads: 0,
  slowWrites: new Map<string, () => Promise<void>>(),
  writeFileHits: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (p: unknown, ...rest: unknown[]) => {
      const s = String(p);
      // record files only: v<digits>.<type>.json — NOT .recovered/.tmp/meta
      if (/\/v\d+\.[a-zA-Z0-9._-]+\.json$/u.test(s)) fsm.recordReads += 1;
      if (s.endsWith("meta.json")) fsm.metaReads += 1;
      if (s.endsWith("workspace.json")) fsm.workspaceReads += 1;
      return (actual.readFile as (p: unknown, ...rest: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof actual.readFile,
    writeFile: (async (p: unknown, ...rest: unknown[]) => {
      const s = String(p);
      fsm.writeFileHits.push(s);
      const gate = fsm.slowWrites.get(s);
      if (gate !== undefined) await gate();
      return (actual.writeFile as (p: unknown, ...rest: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof actual.writeFile,
  };
});

import { Store } from "../src/store.js";
import type { ContextRecord } from "../src/types.js";

const payload = { summary: "s", body: "b" };

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-store-cache-"));
  root = path.join(tmp, ".context-hub");
  fsm.recordReads = 0;
  fsm.metaReads = 0;
  fsm.workspaceReads = 0;
  fsm.slowWrites.clear();
  fsm.writeFileHits.length = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function recordPath(taskId: string, version: number, type = "note"): string {
  return path.join(root, "tasks", taskId, `v${String(version).padStart(3, "0")}.${type}.json`);
}

/** Externally land a record file (another process / git pull). */
function externalRecord(taskId: string, version: number, type = "note"): void {
  const record: ContextRecord = {
    version,
    task_id: taskId,
    role: "executor",
    content_type: type,
    timestamp: new Date().toISOString(),
    payload,
  };
  writeFileSync(recordPath(taskId, version, type), JSON.stringify(record, null, 2) + "\n", "utf8");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("cache protocol: listTasks / snapshotTasks", () => {
  it("directory unchanged → the second listTasks reads ZERO record files (§4.4 regression guard)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Cache Me", description: "d", creator: "a", role: "human" });
    for (let i = 0; i < 5; i++) {
      await store.append("cache-me", { role: "executor", content_type: "note", payload });
    }
    fsm.recordReads = 0;
    const first = await store.listTasks();
    expect(first).toHaveLength(1);
    const coldReads = fsm.recordReads; // append already warmed the cache — but listTasks may fold cold if names changed; here they did not
    await store.listTasks();
    expect(fsm.recordReads).toBe(coldReads); // no ADDITIONAL record reads
    // And against a cache-less store the first list DOES read records:
    const fresh = new Store(root);
    fsm.recordReads = 0;
    await fresh.listTasks();
    expect(fsm.recordReads).toBe(5);
    // …while its second call reads none (the §4 gate, verbatim).
    fsm.recordReads = 0;
    await fresh.listTasks();
    expect(fsm.recordReads).toBe(0);
  });

  it("second snapshotTasks on an unchanged tree reads zero record files and one meta per task", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Snap A", description: "d", creator: "a", role: "human" });
    await store.createTask({ title: "Snap B", description: "d", creator: "a", role: "human" });
    await store.append("snap-a", { role: "executor", content_type: "note", payload });
    await store.snapshotTasks(); // warm
    fsm.recordReads = 0;
    fsm.metaReads = 0;
    const snap = await store.snapshotTasks();
    expect(snap.tasks).toHaveLength(2);
    expect(fsm.recordReads).toBe(0);
    expect(fsm.metaReads).toBe(2); // meta stays authoritative operation state — always re-read
  });

  it("external record addition invalidates the token: only the ADDED file is read, folded onto the cursor", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Ext Add", description: "d", creator: "a", role: "human" });
    for (let i = 1; i <= 4; i++) {
      await store.append("ext-add", { role: "executor", content_type: "note", payload });
    }
    await store.listTasks(); // warm (append bookkeeping already warm, but be explicit)
    externalRecord("ext-add", 5, "note");

    fsm.recordReads = 0;
    const listed = await store.listTasks();
    expect(fsm.recordReads).toBe(1); // exactly the addition
    // /state reports the disk-max version (5): an externally landed record
    // must lift the version version-diff consumers see (system-design 4.3),
    // so a governed pull surfaces it next round — meta.version itself stays
    // 4 and is healed on the next hub append (unchanged 0.6.0 semantics).
    expect(listed[0]!.version).toBe(5);
    // The externally appended note folds: status unchanged (note in designing), no warnings.
    expect(listed[0]!.needs_attention).toBe(false);
    // Steady state again: zero reads.
    fsm.recordReads = 0;
    await store.listTasks();
    expect(fsm.recordReads).toBe(0);
  });

  it("external addition that changes the derived status folds through the cursor (full-flow design → implementing)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Ext Design", description: "d", creator: "a", role: "human" });
    await store.listTasks();
    externalRecord("ext-design", 1, "design");

    const listed = await store.listTasks();
    expect(listed[0]!.status).toBe("implementing"); // incremental fold of v1 design
    expect(listed[0]!.waiting_for).toBe("agent:executor");
  });

  it("external DELETION forces the cold path (full re-read of what remains)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Ext Del", description: "d", creator: "a", role: "human" });
    for (let i = 1; i <= 3; i++) {
      await store.append("ext-del", { role: "executor", content_type: "note", payload });
    }
    await store.listTasks();
    rmSync(recordPath("ext-del", 3), { force: true });

    fsm.recordReads = 0;
    await store.listTasks();
    expect(fsm.recordReads).toBe(2); // cold re-read of the survivors, not an extension
    fsm.recordReads = 0;
    await store.listTasks();
    expect(fsm.recordReads).toBe(0);
  });

  it("project scope health probe is cached the same way (token hit reads nothing)", async () => {
    const store = new Store(root);
    await store.append("project", { role: "human", content_type: "note", payload });
    await store.append("project", { role: "human", content_type: "note", payload });
    await store.listTasks(); // warm
    fsm.recordReads = 0;
    const all = await store.listTasks();
    expect(all.find((t) => t.task_id === "project")).toBeDefined();
    expect(fsm.recordReads).toBe(0);
    externalRecord("project", 3, "note");
    fsm.recordReads = 0;
    await store.listTasks();
    expect(fsm.recordReads).toBe(1); // only the addition probed
  });
});

describe("cache protocol: append pre-write fold", () => {
  it("warm append reads ZERO record files regardless of sequence length (slope ≈ 0)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Warm Append", description: "d", creator: "a", role: "human" });
    for (let i = 0; i < 20; i++) {
      await store.append("warm-append", { role: "executor", content_type: "note", payload });
    }
    fsm.recordReads = 0;
    const landed = await store.append("warm-append", { role: "executor", content_type: "note", payload });
    expect(landed.version).toBe(21);
    expect(fsm.recordReads).toBe(0);
  });

  it("cold-store append folds the sequence once (then warm appends read nothing)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Cold Append", description: "d", creator: "a", role: "human" });
    for (let i = 1; i <= 6; i++) externalRecord("cold-append", i, "note");
    fsm.recordReads = 0;
    const landed = await store.append("cold-append", { role: "executor", content_type: "note", payload });
    expect(landed.version).toBe(7);
    expect(fsm.recordReads).toBe(6); // one cold pass
    fsm.recordReads = 0;
    await store.append("cold-append", { role: "executor", content_type: "note", payload });
    expect(fsm.recordReads).toBe(0);
  });

  it("a corrupt record arriving as a NEW name rejects the warm append before anything lands", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Warm Reject", description: "d", creator: "a", role: "human" });
    await store.append("warm-reject", { role: "executor", content_type: "note", payload });
    writeFileSync(recordPath("warm-reject", 2), "{ torn", "utf8"); // external torn write
    await expect(
      store.append("warm-reject", { role: "executor", content_type: "note", payload }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fsm.recordReads).toBe(1); // the extension read that found the damage
  });
});

describe("cache protocol: readTask since_version", () => {
  it("warm readTask since_version opens only files ≥ since_version", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Since Read", description: "d", creator: "a", role: "human" });
    for (let i = 0; i < 6; i++) {
      await store.append("since-read", { role: "executor", content_type: "note", payload });
    }
    await store.listTasks(); // warm the fold cache
    fsm.recordReads = 0;
    const read = await store.readTask("since-read", 4);
    expect(read.versions.map((r) => r.version)).toEqual([4, 5, 6]);
    expect(read.status).toBe("designing"); // from the cache cursor, no old-file reads
    expect(fsm.recordReads).toBe(3);
  });

  it("P1-1 (store leg): since_version = last+1 with nothing new reads ZERO record files and returns empty versions", async () => {
    // The notifier's governed pull passes cached.version + 1 against the
    // INCLUSIVE wire contract — with no new records that reads and returns
    // nothing (the old protocol passed the cached max itself and re-read
    // the tail every quiet round).
    const store = new Store(root);
    await store.createTask({ title: "Beyond Last", description: "d", creator: "a", role: "human" });
    await store.append("beyond-last", { role: "architect", content_type: "design", payload });
    await store.append("beyond-last", { role: "executor", content_type: "code_changes", payload });
    await store.append("beyond-last", { role: "executor", content_type: "note", payload });
    await store.readTask("beyond-last"); // warm
    fsm.recordReads = 0;
    const read = await store.readTask("beyond-last", 4); // last is 3 — nothing ≥ 4
    expect(read.versions).toEqual([]);
    expect(read.status).toBe("revising"); // v3 executor note in reviewing reclaims the turn — still derived, never from meta
    expect(fsm.recordReads).toBe(0);
    // v4 lands externally: the next since=4 read opens ONLY the new file.
    externalRecord("beyond-last", 4, "note");
    fsm.recordReads = 0;
    const delta = await store.readTask("beyond-last", 4);
    expect(delta.versions.map((r) => r.version)).toEqual([4]);
    expect(fsm.recordReads).toBe(1);
  });

  it("P2-2: alias record file names fold by their REAL name — versions, warnings shape, and status match a name-blind cold fold", async () => {
    // recordFileVersion accepts ANY v<digits>.<type>.json — v1.foreign.json is
    // a legal alias of v001.…: same version, and the file-name type segment
    // need not match the record's content_type. The cold readTask reuses the
    // records it already opened keyed by the REAL file name; synthesizing a
    // name back from content used to collapse the two files onto one key and
    // fold the wrong record twice (status designed "designing"
    // where the honest fold says "closed").
    const store = new Store(root);
    await store.createTask({ title: "Alias Fold", description: "d", creator: "a", role: "human" });
    const dir = path.join(root, "tasks", "alias-fold");
    const closeRecord: ContextRecord = {
      version: 1,
      task_id: "alias-fold",
      role: "human",
      content_type: "decision",
      timestamp: new Date().toISOString(),
      payload: { summary: "close", body: "b", decision: "close" },
    };
    const approveRecord: ContextRecord = {
      version: 1,
      task_id: "alias-fold",
      role: "human",
      content_type: "decision",
      timestamp: new Date().toISOString(),
      payload: { summary: "approve", body: "b", decision: "approve" },
    };
    writeFileSync(path.join(dir, "v001.decision.json"), JSON.stringify(closeRecord, null, 2) + "\n", "utf8");
    writeFileSync(path.join(dir, "v1.foreign.json"), JSON.stringify(approveRecord, null, 2) + "\n", "utf8");

    const read = await store.readTask("alias-fold");
    expect(read.versions).toHaveLength(2); // both files consumed — no alias swallowed
    expect(read.status).toBe("closed"); // close folds first; the duplicate approve hits CLOSED_ABSORB
    // Same-version different-content duplicate → structural warning visible on /state.
    const listed = await store.listTasks();
    expect(listed[0]!.needs_attention).toBe(true);
    // A second, cache-less Store must agree bit-for-bit (fold does not depend
    // on the alreadyRead reuse), and a THIRD read on the warm store too.
    const fresh = new Store(root);
    const freshRead = await fresh.readTask("alias-fold");
    expect(freshRead.status).toBe(read.status);
    expect(freshRead.versions).toEqual(read.versions);
    const again = await store.readTask("alias-fold");
    expect(again.status).toBe(read.status);
    expect(again.versions).toEqual(read.versions);
  });

  it("P2-2 (read-count leg): canonical since_version reads keep their optimization with the real-name reuse", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Alias Since", description: "d", creator: "a", role: "human" });
    externalRecord("alias-since", 1, "design");
    externalRecord("alias-since", 2, "code_changes");
    fsm.recordReads = 0;
    const read = await store.readTask("alias-since", 2); // cold: fold needs v1, response needs v2
    expect(read.versions.map((r) => r.version)).toEqual([2]);
    expect(read.status).toBe("reviewing");
    expect(fsm.recordReads).toBe(2); // v1 (fold) + v2 (response) — v2 is NOT read twice
    fsm.recordReads = 0;
    await store.readTask("alias-since", 2); // warm
    expect(fsm.recordReads).toBe(1); // only v2 opened
  });

  it("cold readTask since_version folds the full sequence once (status is derived, never trusted from meta)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Cold Since", description: "d", creator: "a", role: "human" });
    externalRecord("cold-since", 1, "design");
    externalRecord("cold-since", 2, "code_changes");
    fsm.recordReads = 0;
    const read = await store.readTask("cold-since", 2);
    expect(read.versions.map((r) => r.version)).toEqual([2]);
    expect(read.status).toBe("reviewing");
    expect(fsm.recordReads).toBe(2); // cold fold needed both; the response needed only v2
    // Warm: same call now reads only v2.
    fsm.recordReads = 0;
    await store.readTask("cold-since", 2);
    expect(fsm.recordReads).toBe(1);
  });

  it("audit order and version filtering are preserved (ascending, ≥ since_version)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Order Check", description: "d", creator: "a", role: "human" });
    for (let i = 0; i < 4; i++) {
      await store.append("order-check", { role: "executor", content_type: "note", payload });
    }
    const read = await store.readTask("order-check", 2);
    expect(read.versions.map((r) => r.version)).toEqual([2, 3, 4]);
  });
});

describe("cache protocol boundaries (pinned, by design)", () => {
  it("in-place content corruption of an already-folded file is invisible to a warm store — restart or deletion surfaces it", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Blind Spot", description: "d", creator: "a", role: "human" });
    await store.append("blind-spot", { role: "executor", content_type: "note", payload });
    writeFileSync(recordPath("blind-spot", 1), "{ rot", "utf8"); // same name, new bytes

    // Warm store: token hit — the fold is not re-run (name list unchanged).
    const warm = await store.snapshotTasks();
    expect(warm.degraded).toEqual([]); // the designed boundary: the token cannot see bytes
    // A fresh process (restart / CLI one-shot) folds the damage immediately.
    const fresh = new Store(root);
    const cold = await fresh.snapshotTasks();
    expect(cold.degraded).toEqual(["blind-spot"]);
    // Even a NEW record file (v2) does not surface v1's rot on the warm
    // store: the extension path reads only the ADDITION. (A deletion — or
    // restart — is what forces the cold re-read; pinned as the protocol.)
    externalRecord("blind-spot", 2, "note");
    const stillWarm = await store.snapshotTasks();
    expect(stillWarm.degraded).toEqual([]);
    rmSync(recordPath("blind-spot", 2), { force: true });
    const afterDeletion = await store.snapshotTasks();
    expect(afterDeletion.degraded).toEqual(["blind-spot"]); // cold path re-read v1 → rot surfaces
  });

  it("repairMeta with a different flow voids the cached cursor (flow selects the table)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Flow Swap", description: "d", creator: "a", role: "human" });
    externalRecord("flow-swap", 1, "code_changes");
    await store.listTasks(); // warm: FULL flow folds code_changes from designing → OUT_OF_TABLE warning
    const before = await store.listTasks();
    expect(before[0]!.needs_attention).toBe(true);
    expect(before[0]!.status).toBe("designing");

    // Rebuild meta as direct (records untouched) — the fold must re-run under
    // the new table: direct starts implementing, code_changes → reviewing.
    writeFileSync(path.join(root, "tasks", "flow-swap", "meta.json"), "{ broken", "utf8");
    await store.repairMeta("flow-swap", { flow: "direct" });
    const after = await store.listTasks();
    expect(after[0]!.status).toBe("reviewing"); // direct table through the SAME records
    expect(after[0]!.needs_attention).toBe(false);
  });
});

describe("per-task mutation queues", () => {
  it("appends to DIFFERENT tasks do not queue behind each other", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Lane One", description: "d", creator: "a", role: "human" });
    await store.createTask({ title: "Lane Two", description: "d", creator: "a", role: "human" });
    // Gate lane-one's RECORD write (the store writes temp-then-link, so the
    // gated path is the temp sibling); lane-two's append must complete while it waits.
    const gate = deferred();
    const gatedTemp = `${recordPath("lane-one", 1)}.${process.pid}.tmp`;
    fsm.slowWrites.set(gatedTemp, () => gate.promise);

    const slow = store.append("lane-one", { role: "executor", content_type: "note", payload });
    await vi.waitFor(() => {
      if (!fsm.writeFileHits.includes(gatedTemp)) throw new Error("gated write not started");
    });

    let fastDone = false;
    const fast = store.append("lane-two", { role: "executor", content_type: "note", payload }).then((r) => {
      fastDone = true;
      return r;
    });
    await vi.waitFor(() => {
      if (!fastDone) throw new Error("lane-two append still queued");
    });
    expect(fastDone).toBe(true); // did NOT wait for lane-one's gated write

    gate.resolve();
    const slowResult = await slow;
    expect(slowResult.version).toBe(1);
    expect((await fast).version).toBe(1);
  });

  it("appends to the SAME task stay serialized (version monotonicity under concurrency)", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Same Lane", description: "d", creator: "a", role: "human" });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.append("same-lane", { role: "executor", content_type: "note", payload })),
    );
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("concurrent createTask with the SAME title still yields distinct slugs (global mutex preserved)", async () => {
    const store = new Store(root);
    const created = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.createTask({ title: "Duel", description: "d", creator: "a", role: "human" }),
      ),
    );
    const ids = created.map((c) => c.task_id);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) expect(id).toMatch(/^duel(-[a-z0-9]{4})?$/u);
  });

  it("a queued lane is reclaimed — the task-tail map stays bounded", async () => {
    const store = new Store(root);
    await store.createTask({ title: "Reclaim", description: "d", creator: "a", role: "human" });
    await store.append("reclaim", { role: "executor", content_type: "note", payload });
    const tails = (store as unknown as { taskTails: Map<string, unknown> }).taskTails;
    expect(tails.size).toBe(0); // settled tail reclaimed, not accumulated
  });
});

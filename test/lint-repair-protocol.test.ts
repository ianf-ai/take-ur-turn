import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ContextRecord, Warning } from "../src/core/common/types.js";
import { foldWithLint } from "../src/core/hub/record-lint.js";
import { initialCursor } from "../src/core/hub/state-machine.js";
import { Store } from "../src/core/hub/store.js";

const spec = "## 验收场景\n1. first\n2. second";
const exit = "## 退出条件逐条核验\n1. 满足 — tested first\n2. 满足 — tested second";
const scope = "## 超出规格的改动\n无";
const complete = `${exit}\n${scope}`;
const rec = (version: number, content_type: string, role: string, body = complete, extra = {}): ContextRecord => ({
  task_id: "t", version, content_type, role, timestamp: "2026-10-16T00:00:00Z", payload: { summary: "s", body, ...extra },
});
const delivered = [rec(1, "design", "architect"), rec(2, "code_changes", "executor")];
const fold = (rs: ContextRecord[]) => foldWithLint(initialCursor("full"), rs, "full", spec);
const lint = (warnings: Warning[], code: string) => warnings.find(w => w.code === code)!;

describe("append-only repair sheets", () => {
  it("gives all four existing lint codes field locations and actionable append suggestions", () => {
    const rs = [...delivered, rec(3, "review", "Reviewer", "bad", { verdict: "fail_design" }),
      rec(4, "design", "architect"), rec(5, "code_changes", "executor")];
    const state = fold(rs);
    expect(state.status).toBe("reviewing");
    expect(state.needs_attention).toBe(true);
    expect(state.warnings.map(w => w.code)).toEqual(["NON_CANONICAL_ROLE", "REVIEW_EXIT_CONDITIONS_INCOMPLETE", "REVIEW_SCOPE_SECTION_MISSING", "EXPECTED_REVISION"]);
    for (const w of state.warnings) {
      expect(w.version).toBeGreaterThan(0);
      expect(w.location?.field).toBeTruthy();
      expect(w.correction).toMatchObject({ round: 1, limit: 2, exhausted: false });
      expect(w.supportedFixes?.length).toBeGreaterThan(0);
      for (const fix of w.supportedFixes!) {
        expect(fix.field).toBeTruthy(); expect(fix.instruction).toBeTruthy();
        expect(fix.record.role).toMatch(/^(reviewer|executor)$/);
        expect(fix.record.content_type).toMatch(/^(note|revision)$/);
      }
    }
    expect(lint(state.warnings, "REVIEW_EXIT_CONDITIONS_INCOMPLETE").supportedFixes![0]!.example).toContain("2. <满足");
    expect(lint(state.warnings, "EXPECTED_REVISION").supportedFixes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "payload.ref_version", example: 3, record: { role: "executor", content_type: "revision", ref_version: 3 } }),
    ]));
  });
  it("repairs a mixed-case review by a canonical note without replaying its verdict", () => {
    const rs = [...delivered, rec(3, "review", "Reviewer", "bad", { verdict: "pass" })];
    const original = JSON.stringify(rs);
    const result = fold([...rs, rec(4, "note", "reviewer", complete, { ref_version: 3 })]);
    expect(result).toMatchObject({ status: "pending_approval", needs_attention: false, warnings: [] });
    expect(JSON.stringify(rs)).toBe(original);
  });
  it("targets each review diagnostic independently; unrelated notes and roles do not count", () => {
    const rs = [...delivered, rec(3, "review", "reviewer", "bad", { verdict: "fail_code" }),
      rec(4, "note", "human", complete, { ref_version: 3 }),
      rec(5, "note", "reviewer", complete, { ref_version: 99 }), rec(6, "note", "reviewer")];
    expect(fold(rs).warnings.every(w => w.correction?.round === 1)).toBe(true);
    const partial = fold([...rs, rec(7, "note", "reviewer", exit, { ref_version: 3 })]);
    expect(partial.warnings).toMatchObject([{ code: "REVIEW_SCOPE_SECTION_MISSING", version: 7,
      correction: { root_version: 3, round: 2, exhausted: true } }]);
    expect(partial.warnings[0]!.message).toContain("修正轮耗尽");
    expect(partial.needs_attention).toBe(true);
    // Either the original warning or the latest failed correction is addressable.
    for (const ref_version of [3, 7]) {
      expect(fold([...rs, rec(7, "note", "reviewer", exit, { ref_version: 3 }),
        rec(8, "note", "reviewer", scope, { ref_version })]).warnings).toEqual([]);
    }
  });
  it("counts consecutive failed reviews, resets on success, and does not clear structural warnings", () => {
    const rs = [...delivered, rec(3, "review", "reviewer", "bad", { verdict: "fail_code" }),
      rec(4, "revision", "executor"), rec(5, "review", "reviewer", "bad", { verdict: "fail_code" })];
    expect(fold(rs).warnings).toHaveLength(2);
    expect(fold(rs).warnings.every(w => w.correction?.exhausted)).toBe(true);
    const valid = [...rs, rec(6, "revision", "executor"), rec(7, "review", "reviewer", complete, { verdict: "fail_code" })];
    expect(fold(valid).warnings).toEqual([]);
    const failedAgain = fold([...valid, rec(8, "revision", "executor"), rec(9, "review", "reviewer", "bad", { verdict: "pass" })]);
    expect(failedAgain.warnings.every(w => w.correction?.round === 1)).toBe(true);
    const outOfTable = fold([rec(1, "review", "reviewer", "bad"), rec(2, "note", "reviewer", complete, { ref_version: 1 })]);
    expect(outOfTable.warnings).toEqual([{ version: 1, code: "OUT_OF_TABLE" }]);
  });
  it("repairs EXPECTED_REVISION through a real reclaim and correctly referenced revision", () => {
    const rs = [...delivered, rec(3, "review", "reviewer", complete, { verdict: "fail_design" }),
      rec(4, "design", "architect"), rec(5, "code_changes", "executor"), rec(6, "note", "executor", "reclaim", { ref_version: 5 })];
    expect(fold(rs).warnings).toHaveLength(1); // reclaim alone is not a repair
    const wrong = [...rs, rec(7, "revision", "executor", complete, { ref_version: 1 })];
    expect(fold(wrong).warnings[0]).toMatchObject({ code: "EXPECTED_REVISION", correction: { round: 2, exhausted: true } });
    expect(fold([...rs, rec(7, "revision", "executor", complete, { ref_version: 3 })])).toMatchObject({
      status: "reviewing", needs_attention: false, warnings: [],
    });
  });
  it("counts role corrections and requires a canonical, explicitly referenced note to resolve", () => {
    const rs = [rec(1, "note", "Executor"), rec(2, "note", "human"), rec(3, "note", "EXECUTOR")];
    expect(fold(rs).warnings[0]).toMatchObject({ code: "NON_CANONICAL_ROLE", version: 3, correction: { round: 2, exhausted: true } });
    expect(fold([...rs, rec(4, "note", "executor")]).warnings).toHaveLength(1);
    expect(fold([...rs, rec(4, "note", "executor", "corrected", { ref_version: 1 })]).warnings).toEqual([]);
  });
  it.each(["ack", "close"])("%s resets the counter but still diagnoses the reset record itself", action => {
    const rs = [rec(1, "note", "Executor"), action === "ack"
      ? rec(2, "note", "EXECUTOR", complete, { ack: true })
      : rec(2, "decision", "EXECUTOR", complete, { decision: "close" })];
    expect(fold(rs).warnings).toMatchObject([{ version: 2, code: "NON_CANONICAL_ROLE", correction: { round: 1, exhausted: false } }]);
  });
  it("is identical at every incremental split and leaves prior cursor objects unchanged", () => {
    const rs = [...delivered, rec(3, "review", "Reviewer", "bad", { verdict: "fail_code" }),
      rec(4, "note", "reviewer", exit, { ref_version: 3 }), rec(5, "note", "reviewer", scope, { ref_version: 4 })];
    for (let i = 0; i <= rs.length; i++) {
      const cursor = fold(rs.slice(0, i)); const saved = JSON.stringify(cursor);
      expect(foldWithLint(cursor, rs.slice(i), "full", spec)).toEqual(fold(rs));
      expect(JSON.stringify(cursor)).toBe(saved);
    }
  });
});

describe("task descriptions do not impose repository-operation policy", () => {
  it.each(["请 push 分支", "开 PR", "merge to main", "发版", "git push origin HEAD", "release version 1", "合并分支并推送代码"])("does not warn for %s", text => {
    const result = foldWithLint(initialCursor("direct"), [], "direct", `${spec}\n${text}`);
    expect(result).toMatchObject({ status: "implementing", needs_attention: false, warnings: [] });
  });
});

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
it("Store create, append, list and cold replay accept repository operations without warnings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tut-repair-")); dirs.push(dir);
  const store = new Store(dir);
  const description = spec + "\n请 push 分支并开 PR，merge 后 release 发版";
  const created = await store.createTask({ title: "operations", description, creator: "human", role: "human", flow: "direct" });
  expect(created).toMatchObject({ version: 0, status: "implementing" });
  expect(created.needs_attention).not.toBe(true);
  expect(created.warnings ?? []).toEqual([]);
  expect(created.warning).toBeUndefined();
  for (const active of [store, new Store(dir)]) expect((await active.listTasks())[0]).toMatchObject({ needs_attention: false, warnings: [] });
  const deliveredResult = await store.append(created.task_id, { role: "executor", content_type: "code_changes", payload: { summary: "s", body: "landed" } });
  expect(deliveredResult).toMatchObject({ version: 1, status: "reviewing", needs_attention: false });
  expect(deliveredResult.warnings ?? []).toEqual([]);
  for (const active of [store, new Store(dir)]) {
    expect((await active.listTasks())[0]).toMatchObject({ needs_attention: false, warnings: [] });
    const task = await active.readTask(created.task_id);
    expect(task.description).toBe(description);
    expect(task.versions).toHaveLength(1);
  }
});

it("Store preserves repair counters across restart and reflects lamp removal in hot and cold readers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tut-repair-cache-")); dirs.push(dir);
  const store = new Store(dir);
  const { task_id } = await store.createTask({ title: "repairs", description: spec, creator: "human", role: "human", flow: "direct" });
  const append = (active: Store, content_type: string, role: string, body: string, extra = {}) => active.append(task_id, {
    content_type, role, payload: { summary: "s", body, ...extra },
  });
  await append(store, "code_changes", "executor", complete);
  const first = await append(store, "review", "reviewer", "bad", { verdict: "pass" });
  const restarted = new Store(dir);
  expect((await restarted.listTasks())[0]!.warnings).toEqual(first.warnings);
  const failed = await append(restarted, "note", "reviewer", "bad again", { ref_version: 2 });
  expect(failed.warnings!.every(w => w.correction?.exhausted)).toBe(true);
  for (const active of [store, restarted, new Store(dir)]) expect((await active.listTasks())[0]!.warnings).toEqual(failed.warnings);
  const fixed = await append(restarted, "note", "reviewer", complete, { ref_version: 2 });
  expect(fixed).toMatchObject({ status: "pending_approval", needs_attention: false });
  for (const active of [store, restarted, new Store(dir)]) expect((await active.listTasks())[0]).toMatchObject({ needs_attention: false, warnings: [] });
  const records = (await store.readTask(task_id)).versions;
  expect(records).toHaveLength(4);
  expect(records[1]!.payload.body).toBe("bad");
});

/**
 * Contract tests for the optional payload.exit_conditions field: source
 * selection, set-coverage semantics, fixed-valid-field format immunity, repair protocol,
 * cross-representation equivalence, and Store round-trips.
 *
 * Equivalence discipline: both representations are handwritten from the SAME
 * independently prepared verdict tuples — the prose body is written to the old
 * prose contract, the field array to the canonical item shape — and never
 * derived from one another. Only the intentionally divergent warning
 * presentation (location + supportedFixes) is excluded from comparison.
 *
 * The MCP/CLI seams are covered by mcp.test.ts / cli.test.ts respectively.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContextRecord, Flow, Warning } from "../../../src/protocol/types.js";
import { foldWithLint } from "../../../src/hub/record-lint.js";
import { initialCursor } from "../../../src/hub/state-machine.js";
import { EXIT_REVIEW_HEADING } from "../../../src/protocol/task-spec.js";
import { Store } from "../../../src/hub/store.js";

const spec = "## 验收场景\n1. first\n2. second";
const scopeOnly = "## 超出规格的改动\n无";
const exitBody = "## 退出条件逐条核验\n1. 满足 — first; evidence test\n2. 外部阻塞 — second; unavailable";
const completeBody = exitBody + "\n" + scopeOnly;

const rec = (version: number, content_type: string, role: string, payload: Record<string, unknown>): ContextRecord => ({
  task_id: "t", version, content_type, role, timestamp: "2026-10-27T00:00:00Z",
  payload: { summary: "s", ...payload } as ContextRecord["payload"],
});
const delivered = (): ContextRecord[] => [
  rec(1, "design", "architect", { body: completeBody }),
  rec(2, "code_changes", "executor", { body: completeBody }),
];
const reviewAt = (version: number, payload: Record<string, unknown>): ContextRecord =>
  rec(version, "review", "reviewer", payload);
const fold = (rs: ContextRecord[], flow: Flow = "full", description: string = spec) =>
  foldWithLint(initialCursor(flow), rs, flow, description);
const codes = (rs: ContextRecord[], flow?: Flow, description?: string) => fold(rs, flow, description).warnings.map(w => w.code);

/** A canonical complete two-item array for the two-condition baseline. */
const fullField = [
  { id: 1, verdict: "满足", evidence: "first covered by test" },
  { id: 2, verdict: "外部阻塞", evidence: "second blocked by env" },
];
const item = (over: Record<string, unknown>): Record<string, unknown> => ({ id: 1, verdict: "满足", evidence: "real evidence", ...over });

describe("exit_conditions field coverage", () => {
  it("a complete canonical array clears the coverage lint; scope stays body-based", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: fullField })];
    expect(codes(rs)).toEqual([]);
    expect(fold(rs)).toMatchObject({ status: "revising", needs_attention: false });
  });
  const placeholderEvidence: [string, unknown][] = ["", "TODO", "TBD", "待补充", "待填写", "待定", "...", "…", "无"]
    .map((p): [string, unknown] => [`placeholder evidence ${JSON.stringify(p)}`, [item({ evidence: p }), item({ id: 2 })]]);
  const incompleteCases: [string, unknown][] = [
    ["empty array", []],
    ["missing item", [item({})]],
    ["duplicate id does not add coverage", [item({}), item({ id: 1 })]],
    ["zero id", [item({ id: 0 }), item({ id: 2 })]],
    ["negative id", [item({ id: -1 }), item({ id: 2 })]],
    ["out-of-range id", [item({ id: 3 })]],
    ["non-integer id", [item({ id: 1.5 }), item({ id: 2 })]],
    ["numeric-string id", [item({ id: "1" }), item({ id: 2 })]],
    ["unknown verdict word", [item({ verdict: "satisfied" }), item({ id: 2 })]],
    ["non-string evidence", [item({ evidence: 42 }), item({ id: 2 })]],
    ...placeholderEvidence,
    ["explicit null", null],
    ["scalar number", 42],
    ["scalar string", "answered"],
    ["boolean", true],
    ["non-array object", { 1: "满足" }],
    ["array of non-objects", [null, "满足", 3, [1]]],
  ];
  it.each(incompleteCases)("does not count coverage from: %s", (_name, value) => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: value })];
    expect(codes(rs)).toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
  });
  it("counts every verdict word and ignores extension keys", () => {
    for (const verdict of ["满足", "不满足", "外部阻塞", "已批准延后"]) {
      const rs = [...delivered(), reviewAt(3, {
        verdict: "fail_code", body: scopeOnly,
        exit_conditions: [
          { id: 1, verdict, evidence: "e", extension: { deep: [1, { a: null }] } },
          { id: 2, verdict, evidence: "e" },
        ],
      })];
      expect(codes(rs)).not.toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
    }
  });
  it("invalid extra items never erase a complete set; array order is irrelevant", () => {
    const extras = [...fullField.slice().reverse(), item({ id: 99 }), item({ id: 1, verdict: "bogus" }), null, "str"];
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: extras })];
    expect(codes(rs)).not.toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
  });
  it("ids index the effective filtered sequence, not display numbers", () => {
    for (const description of [
      "## 验收场景\n① first；② second",
      "## 验收场景\n- first\n- second",
      "## 验收场景\n5. first\n9. second",
    ]) {
      const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: fullField })];
      expect(codes(rs, "full", description), description).not.toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
    }
    // Placeholder items are filtered from the baseline: N collapses to 1, so
    // id 1 alone completes coverage while id 2 is an out-of-range extra.
    const filtered = "## 验收场景\n1. first\n2. TODO";
    const one = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: [item({})] })];
    expect(codes(one, "full", filtered)).not.toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
    const twoOnly = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: [item({ id: 2 })] })];
    const w = fold(twoOnly, "full", filtered).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    expect(w.message).toBe("退出条件已判定 0 / 应判定 1");
  });
  it("partial coverage reports the existing count message and a field location without a fabricated section", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: [item({})] })];
    const w = fold(rs).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    expect(w.message).toBe("退出条件已判定 1 / 应判定 2");
    expect(w.location).toEqual({ field: "payload.exit_conditions" });
    expect(w.correction).toMatchObject({ root_version: 3, round: 1, limit: 2, exhausted: false });
  });
  it("the field fix example is a JSON string whose evidence stays placeholder (verbatim copy cannot clear)", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: [] })];
    const w = fold(rs).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    const fix = w.supportedFixes![0]!;
    expect(fix.field).toBe("payload.exit_conditions");
    expect(JSON.parse(fix.example as string)).toEqual([
      { id: 1, verdict: "满足", evidence: "待填写" },
      { id: 2, verdict: "满足", evidence: "待填写" },
    ]);
    const copied = [...rs, rec(4, "note", "reviewer", { body: scopeOnly, ref_version: 3, exit_conditions: JSON.parse(fix.example as string) })];
    expect(codes(copied)).toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
  });
  it("without a baseline the field adds no new gate", () => {
    expect(codes([...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: fullField })], "full", "legacy description")).toEqual([]);
  });
});

describe("independent per-record source selection", () => {
  it("field present: a complete body section never rescues an invalid field (no fallback)", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: completeBody, exit_conditions: [] })];
    expect(codes(rs)).toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
  });
  it("field present: partial field and complementary body answers are never merged", () => {
    const bodyHalf = "## 退出条件逐条核验\n2. 不满足 — second; gap";
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: bodyHalf + "\n" + scopeOnly, exit_conditions: [item({})] })];
    const w = fold(rs).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    expect(w.message).toBe("退出条件已判定 1 / 应判定 2");
  });
  it("field absent: the body branch survives verbatim for old records", () => {
    expect(codes([...delivered(), reviewAt(3, { verdict: "fail_code", body: completeBody })])).toEqual([]);
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: "## 退出条件逐条核验\n1. 满足 — only first" + "\n" + scopeOnly })];
    const w = fold(rs).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    expect(w.location).toEqual({ field: "payload.body", section: "退出条件逐条核验" });
  });
  it("format variants: with a fixed valid field, body formatting no longer changes classification", () => {
    const variants = [
      "## 退出条件逐条核验\n**1. 满足 — first**\n**2. 外部阻塞 — second**",
      "## 退出条件逐条核验\n`1. 满足 — first`\n`2. 外部阻塞 — second`",
      "## 退出条件逐条核验\n| # | 判定 | 证据 |\n|---|---|---|\n| 1 | 满足 | first |\n| 2 | 外部阻塞 | second |",
      "```\n## 退出条件逐条核验\n1. 满足 — first\n2. 外部阻塞 — second\n```",
      "自由段落：第一条满足，第二条外部阻塞，不再要求行格式。",
      "## 退出条件逐条核验\n1. 满足 — first\n## 退出条件逐条核验\n2. 外部阻塞 — second",
      "",
    ];
    for (const body of variants) {
      const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: body + "\n" + scopeOnly, exit_conditions: fullField })];
      expect(codes(rs), body).not.toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
      const broken = [...delivered(), reviewAt(3, { verdict: "fail_code", body: body + "\n" + scopeOnly, exit_conditions: [item({})] })];
      expect(codes(broken), body).toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
    }
  });
  it("an independently missing scope section still lints even with a complete field", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: "## 总体评价\nok", exit_conditions: fullField })];
    expect(codes(rs)).toEqual(["REVIEW_SCOPE_SECTION_MISSING"]);
  });
});

describe("field and body repair notes (append-only protocol)", () => {
  it("an old body-based review is repaired by a field note", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: "bad body" })];
    expect(codes(rs)).toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
    const fixed = [...rs, rec(4, "note", "reviewer", { body: scopeOnly, ref_version: 3, exit_conditions: fullField })];
    expect(codes(fixed)).toEqual([]);
  });
  it("a new field-based review is repaired by a body note (each note picks its own source)", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: [item({})] })];
    const fixed = [...rs, rec(4, "note", "reviewer", { body: completeBody, ref_version: 3 })];
    expect(codes(fixed)).toEqual([]);
  });
  it("a body-source coverage diagnostic prefers the field fix first; the body fix stays second", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: "old-format review body" })];
    const w = fold(rs).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    // The diagnosis keeps the body location; only the FIRST repair target moves to the field.
    expect(w.location).toEqual({ field: "payload.body", section: "退出条件逐条核验" });
    const [first, second] = w.supportedFixes!;
    expect(first!.field).toBe("payload.exit_conditions");
    expect(JSON.parse(first!.example as string)).toEqual([
      { id: 1, verdict: "满足", evidence: "待填写" },
      { id: 2, verdict: "满足", evidence: "待填写" },
    ]);
    expect(second!.field).toBe("payload.body");
    expect(second!.example).toContain("2. <满足");
    // Copying the suggested JSON verbatim keeps the lamp lit (placeholder evidence).
    const copied = [...rs, rec(4, "note", "reviewer", { body: scopeOnly, ref_version: 3, exit_conditions: JSON.parse(first!.example as string) })];
    expect(codes(copied)).toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
    // Real material in the suggested field repairs the OLD body-source review.
    const repaired = [...rs, rec(4, "note", "reviewer", { body: scopeOnly, ref_version: 3, exit_conditions: fullField })];
    expect(codes(repaired)).toEqual([]);
  });
  it("a field note does not clear the independent scope lint (materials verified separately)", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: "" })];
    const fixed = [...rs, rec(4, "note", "reviewer", { body: "", ref_version: 3, exit_conditions: fullField })];
    expect(codes(fixed)).toEqual(["REVIEW_SCOPE_SECTION_MISSING"]);
  });
  it("wrong reference or wrong role does not clear or count; a targeted-but-still-incomplete note is round 2", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: [] })];
    const wrongRef = [...rs, rec(4, "note", "reviewer", { body: scopeOnly, ref_version: 1, exit_conditions: fullField })];
    const w0 = fold(wrongRef).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    expect(w0).toMatchObject({ version: 3, correction: { round: 1, exhausted: false } });
    const byHuman = [...rs, rec(4, "note", "human", { body: scopeOnly, ref_version: 3, exit_conditions: fullField })];
    expect(codes(byHuman)).toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
    const failedAgain = [...rs, rec(4, "note", "reviewer", { body: scopeOnly, ref_version: 3, exit_conditions: [item({})] })];
    const w = fold(failedAgain).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    expect(w).toMatchObject({ version: 4, correction: { root_version: 3, round: 2, exhausted: true } });
    // Either the root diagnosis or the latest failed correction is addressable.
    for (const ref_version of [3, 4]) {
      expect(codes([...failedAgain, rec(5, "note", "reviewer", { body: scopeOnly, ref_version, exit_conditions: fullField })])).toEqual([]);
    }
  });
  it("recurrence after a successful repair restarts the round count; unrelated notes never count", () => {
    const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: [] }),
      rec(4, "note", "reviewer", { body: scopeOnly, ref_version: 3, exit_conditions: fullField }),
      rec(5, "revision", "executor", { body: completeBody, ref_version: 3 })];
    expect(codes(rs)).toEqual([]);
    const recurred = [...rs, reviewAt(6, { verdict: "pass", body: scopeOnly, exit_conditions: [item({})], ref_version: 5 })];
    const w = fold(recurred).warnings.find(x => x.code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE")!;
    expect(w).toMatchObject({ version: 6, correction: { root_version: 6, round: 1 } });
    const noisy = [...rs, rec(6, "note", "human", { body: completeBody })];
    expect(codes(noisy)).toEqual([]);
  });
  it.each([["ack", "note", { ack: true }], ["close", "decision", { decision: "close" }]] as const)(
    "%s clears accumulated diagnostics but still diagnoses its own role typo",
    (_name, content_type, extra) => {
      const rs = [...delivered(), reviewAt(3, { verdict: "fail_code", body: scopeOnly, exit_conditions: [] }),
        rec(4, content_type, "HUMAN", { body: scopeOnly, ...extra })];
      expect(codes(rs)).toEqual(["NON_CANONICAL_ROLE"]);
    },
  );
});

/** Warnings stripped of the intentionally field-vs-body divergent presentation
 * (location + supportedFixes): what remains must be representation-invariant. */
function skeleton(warnings: Warning[]) {
  return warnings.map(({ location: _l, supportedFixes: _f, ...rest }) => rest);
}
const projection = (c: ReturnType<typeof foldWithLint>) => ({
  status: c.status, needs_attention: c.needs_attention, waiting_for: c.waiting_for,
  warnings: skeleton(c.warnings), pendingFailDesign: c.pendingFailDesign, pending_since: c.pending_since,
  round_count: c.round_count, current_round_started_at: c.current_round_started_at,
});

/** One independently prepared verdict tuple set — the single material both
 *  representations are handwritten from. Never derived from the other form. */
interface Tuple { id: number; verdict: string; evidence: string }
const fullTuples: Tuple[] = [
  { id: 1, verdict: "满足", evidence: "first independently prepared evidence" },
  { id: 2, verdict: "外部阻塞", evidence: "second independently prepared evidence" },
];
const partialTuples: Tuple[] = [{ id: 1, verdict: "不满足", evidence: "gap on the first item only" }];
/** Handwritten prose representation (the pre-field prose contract). An empty
 *  tuple set renders no exit section at all — the zero-coverage prose shape. */
const bodyFrom = (tuples: Tuple[]): string => tuples.length
  ? `## ${EXIT_REVIEW_HEADING}\n` + tuples.map(t => `${t.id}. ${t.verdict} — ${t.evidence}`).join("\n") + "\n" + scopeOnly
  : scopeOnly;
/** Handwritten field representation of the same tuples. */
const fieldFrom = (tuples: Tuple[]): unknown => tuples.map(t => ({ ...t }));

/** Scenario record spec; `tuples` marks the records whose coverage material is
 *  rendered per representation (reviews and repair notes). */
interface Spec { type: string; role: string; tuples?: Tuple[]; extra?: Record<string, unknown> }
const render = (specs: Spec[], mode: "body" | "field"): ContextRecord[] =>
  specs.map((s, i) => rec(i + 1, s.type, s.role, {
    body: s.tuples === undefined ? completeBody : mode === "body" ? bodyFrom(s.tuples) : scopeOnly,
    ...(s.extra ?? {}),
    ...(s.tuples !== undefined && mode === "field" ? { exit_conditions: fieldFrom(s.tuples) } : {}),
  }));

const design: Spec = { type: "design", role: "architect" };
const cc: Spec = { type: "code_changes", role: "executor" };
const review = (tuples: Tuple[] | undefined, extra: Record<string, unknown>): Spec => ({ type: "review", role: "reviewer", ...(tuples !== undefined ? { tuples } : {}), extra });
const repairNote = (tuples: Tuple[] | undefined, ref_version: number): Spec => ({ type: "note", role: "reviewer", ...(tuples !== undefined ? { tuples } : {}), extra: { ref_version } });
const revision = (ref_version: number): Spec => ({ type: "revision", role: "executor", extra: { ref_version } });

describe("representation equivalence across flows, verdicts, repairs and prefixes", () => {
  const flows: Flow[] = ["full", "direct", "solo"];
  const verdicts = ["pass", "blocked_external", "fail_code", "fail_design", "nonsense", undefined] as const;
  it.each(flows)("flow %s: complete-coverage log, every verdict, same projection at every prefix", (flow) => {
    for (const verdict of verdicts) {
      const specs = [design, cc, review(fullTuples, { ...(verdict === undefined ? {} : { verdict }) }), revision(3), review(fullTuples, { verdict: "pass", ref_version: 4 })];
      const bodyLog = render(specs, "body");
      const fieldLog = render(specs, "field");
      for (let i = 0; i <= specs.length; i++) {
        expect(projection(fold(bodyLog.slice(0, i), flow)), `${flow} ${verdict} prefix ${i}`)
          .toEqual(projection(fold(fieldLog.slice(0, i), flow)));
      }
    }
  });
  it.each(flows)("flow %s: partial coverage, same-family repair chains, same projection at every prefix", (flow) => {
    const scenarios: [string, Spec[]][] = [
      ["partial review repaired by a same-representation note, then revision and re-review", [
        design, cc, review(partialTuples, { verdict: "fail_code" }), repairNote(fullTuples, 3), revision(3), review(fullTuples, { verdict: "pass", ref_version: 5 }),
      ]],
      ["targeted but still-partial repair exhausts round 2, then the latest-failure reference succeeds", [
        design, cc, review(partialTuples, { verdict: "fail_code" }), repairNote(partialTuples, 3), repairNote(fullTuples, 4),
      ]],
      ["untargeted repair attempt (wrong reference) changes nothing", [
        design, cc, review(partialTuples, { verdict: "fail_code" }), repairNote(fullTuples, 1),
      ]],
      ["fail_design debt armed by a complete review and cleared by the referenced revision", [
        design, cc, review(fullTuples, { verdict: "fail_design" }), design, cc, revision(3),
      ]],
      ["recurrence after a cleared repair restarts the round count", [
        design, cc, review(partialTuples, { verdict: "fail_code" }), repairNote(fullTuples, 3), revision(3),
        review(partialTuples, { verdict: "fail_code", ref_version: 5 }), repairNote(fullTuples, 6),
      ]],
      ["zero-coverage review (empty tuples) repaired by a complete note", [
        design, cc, review([], { verdict: "fail_code" }), repairNote(fullTuples, 3),
      ]],
    ];
    for (const [name, specs] of scenarios) {
      const bodyLog = render(specs, "body");
      const fieldLog = render(specs, "field");
      for (let i = 0; i <= specs.length; i++) {
        expect(projection(fold(bodyLog.slice(0, i), flow)), `${flow} ${name} prefix ${i}`)
          .toEqual(projection(fold(fieldLog.slice(0, i), flow)));
      }
    }
  });
  it("human gates stay put: out-of-table review needs a decision, closed absorbs, invalid verdict holds", () => {
    const scenarios: ContextRecord[][] = [
      [reviewAt(1, { body: completeBody, verdict: "pass", ref_version: 1 }), rec(2, "decision", "human", { body: "b", decision: "close" })],
      [rec(1, "decision", "human", { body: "b", decision: "close" }), reviewAt(2, { body: completeBody, verdict: "pass" })],
      [reviewAt(1, { body: completeBody, verdict: "pass" })],
      [rec(1, "design", "architect", { body: completeBody }), reviewAt(2, { body: completeBody, verdict: "fail_design" }), rec(3, "code_changes", "executor", { body: completeBody })],
    ];
    for (const scenario of scenarios) {
      const fieldized = scenario.map(r => rec(r.version, r.content_type, r.role, {
        ...(r.payload as Record<string, unknown>),
        ...("exit_conditions" in (r.payload as Record<string, unknown>) ? {} : { exit_conditions: fullField }),
      }));
      expect(projection(fold(scenario))).toEqual(projection(fold(fieldized)));
    }
  });
});

describe("mixed-source repair log: incremental splits and Store hot/cold derivation", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("every incremental split re-folds identically; hot and cold Store derivations agree at every prefix", async () => {
    // A log that MIXES sources: a body-sourced partial review repaired by a
    // body note, then a field-sourced partial review repaired by a field note,
    // closed by a complete field review.
    const specs: Spec[] = [
      design, cc,
      review(partialTuples, { verdict: "fail_code" }),            // body source (no field)
      repairNote(fullTuples, 3),                                  // body-family repair
      revision(3),
      { ...review(partialTuples, { verdict: "fail_code", ref_version: 5 }) }, // field source below
      repairNote(fullTuples, 6),                                  // field-family repair
      revision(6),
      review(fullTuples, { verdict: "pass", ref_version: 8 }),
    ];
    const dir = mkdtempSync(path.join(os.tmpdir(), "tut-mixed-")); dirs.push(dir);
    const store = new Store(dir);
    const { task_id } = await store.createTask({ title: "mixed repair log", description: spec, creator: "human", role: "human", flow: "direct" });

    // Rebuild the concrete records the same way the Store will land them:
    // body reps for the first repair round, field reps afterwards.
    const landed: ContextRecord[] = [];
    const hotFold = (s: Spec, mode: "body" | "field", version: number) => rec(version, s.type, s.role, {
      body: s.tuples === undefined ? completeBody : mode === "body" ? bodyFrom(s.tuples) : scopeOnly,
      ...(s.extra ?? {}),
      ...(s.tuples !== undefined && mode === "field" ? { exit_conditions: fieldFrom(s.tuples) } : {}),
    });
    const modes: ("body" | "field")[] = ["body", "body", "body", "body", "body", "field", "field", "field", "field"];
    for (const [i, s] of specs.entries()) {
      const mode = modes[i] ?? "field";
      const payload = {
        summary: "s",
        body: s.tuples === undefined ? completeBody : mode === "body" ? bodyFrom(s.tuples) : scopeOnly,
        ...(s.extra ?? {}),
        ...(s.tuples !== undefined && mode === "field" ? { exit_conditions: fieldFrom(s.tuples) } : {}),
      };
      await store.append(task_id, { role: s.role, content_type: s.type, payload: payload as never });
      landed.push(hotFold(s, mode, i + 1));
    }

    // Every incremental split of the landed log re-folds to the same state.
    const whole = fold(landed);
    for (let i = 0; i <= landed.length; i++) {
      const cursor = fold(landed.slice(0, i));
      expect(projection(foldWithLint(cursor, landed.slice(i), "full", spec)), `prefix ${i}`).toEqual(projection(whole));
    }

    // Hot (cache-warm, same process) vs cold (fresh Store over the same bytes)
    // must derive the identical task entry — warnings included verbatim: the
    // same records must produce the same diagnostic objects, not just counts.
    const coldReader = new Store(dir, { readOnly: true });
    const hotEntry = (await store.listTasks()).find(t => t.task_id === task_id)!;
    const coldEntry = (await coldReader.listTasks()).find(t => t.task_id === task_id)!;
    expect({ ...coldEntry, updated_at: hotEntry.updated_at }).toEqual({ ...hotEntry });
    expect(hotEntry).toMatchObject({ status: "pending_approval", needs_attention: false, warnings: [] });
    expect((await coldReader.readTask(task_id)).versions).toEqual((await store.readTask(task_id)).versions);
    // The field-sourced records keep their arrays verbatim; the body-sourced
    // round never grew a field key.
    const stored = (await coldReader.readTask(task_id)).versions;
    expect(Object.hasOwn(stored[2]!.payload, "exit_conditions")).toBe(false);
    expect(stored[5]!.payload.exit_conditions).toEqual(fieldFrom(partialTuples));
    expect(stored[8]!.payload.exit_conditions).toEqual(fieldFrom(fullTuples));
  });
});

describe("Store round-trip (hot and cold)", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("persists every raw shape verbatim and derives identically after a restart", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tut-exit-")); dirs.push(dir);
    const store = new Store(dir);
    const shapes: unknown[] = [
      fullField,
      [{ id: 1, verdict: "满足", evidence: "e", nested: { deep: [1, null, "x"] } }],
      [],
      null,
      42,
      "raw string",
      true,
      { not: "an array" },
      [{ id: "1", verdict: "满足", evidence: "e" }],
    ];
    const { task_id } = await store.createTask({ title: "exit conditions round trip", description: spec, creator: "human", role: "human", flow: "direct" });
    await store.append(task_id, { role: "executor", content_type: "code_changes", payload: { summary: "s", body: completeBody } });
    for (const [i, shape] of shapes.entries()) {
      const reviewVersion = 2 + i * 2;
      await store.append(task_id, {
        role: "reviewer", content_type: "review",
        payload: { summary: `review ${i}`, body: scopeOnly, verdict: "fail_code", ref_version: 2, exit_conditions: shape },
      });
      await store.append(task_id, { role: "executor", content_type: "revision", payload: { summary: "r", body: completeBody, ref_version: reviewVersion } });
    }
    const hot = await store.readTask(task_id);
    const cold = await new Store(dir).readTask(task_id);
    for (const read of [hot, cold]) {
      expect(read.versions.filter(r => r.content_type === "review").map(r => r.payload.exit_conditions)).toEqual(shapes);
    }
    // The last review's field ([{id:"1"}] — numeric-string id) keeps its lamp:
    // the trailing revision transitions but never clears the diagnostic.
    const entry = (await new Store(dir).listTasks()).find(t => t.task_id === task_id)!;
    expect(entry).toMatchObject({ status: "reviewing", needs_attention: true });
    expect(entry.warnings!.map(w => w.code)).toEqual(["REVIEW_EXIT_CONDITIONS_INCOMPLETE"]);
  });
});

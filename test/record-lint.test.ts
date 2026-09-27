import { describe, expect, it } from "vitest";
import type { ContextRecord, Flow } from "../src/common/types.js";
import { foldWithLint } from "../src/hub/record-lint.js";
import { initialCursor } from "../src/hub/state-machine.js";
const spec = "## 验收场景\n1. first\n2. second";
const scope = "\n## 超出规格的改动\n无";
const complete = "## 退出条件逐条核验\n1. 满足 — first; evidence test\n2. 外部阻塞 — second; unavailable" + scope;
function records(types: string[]): ContextRecord[] {
  return types.map((content_type, i) => ({ task_id: "t", version: i + 1, timestamp: "t", role: "executor", content_type,
    payload: { summary: "s", body: complete, ...(content_type === "review" ? { verdict: "fail_design" } : {}) } }));
}
const fold = (rs: ContextRecord[], flow: Flow = "full") => foldWithLint(initialCursor(flow), rs, flow, spec);
const codes = (rs: ContextRecord[], flow?: Flow) => fold(rs, flow).warnings.map(w => w.code);
describe("record diagnostic overlay", () => {
  it.each([['pass', 'pending_approval'], ['blocked_external', 'pending_approval'], ['fail_code', 'revising'], ['fail_design', 'designing']] as const)("preserves %s target and audits mixed-case role", (verdict, status) => {
    const rs = records(['design', 'code_changes', 'review']);
    rs[2]!.role = "Reviewer"; rs[2]!.payload = { summary: "s", verdict, body: "## 退出条件逐条核验\n1. 满足 — first" };
    expect(fold(rs)).toMatchObject({ status, needs_attention: true });
    expect(codes(rs)).toEqual(['NON_CANONICAL_ROLE', 'REVIEW_EXIT_CONDITIONS_INCOMPLETE', 'REVIEW_SCOPE_SECTION_MISSING']);
  });
  it.each(["", "1. 满足 — first\n1. 满足 — duplicate", "1. 满足 —\n2. 满足 — TODO", "3. 满足 — out of range", "1. first\n2. second", "```\n1. 满足 — example\n2. 满足 — example\n```", "> 1. 满足 — quote\n> 2. 满足 — quote", "1. 满足 — first\n## 问题列表\n2. 满足 — elsewhere"])("does not count invalid answers: %s", (body) => {
    const rs = records(['design', 'code_changes', 'review']);
    rs[2]!.payload.body = "## 退出条件逐条核验\n" + body + scope;
    expect(codes(rs)).toContain('REVIEW_EXIT_CONDITIONS_INCOMPLETE');
  });
  it.each(["", "## 超出规格的改动\n", "## 超出规格的改动\nTODO", "## 超出规格的改动\n- "])("requires real scope content: %s", (body) => {
    const rs = records(['review']); rs[0]!.payload.body = body;
    expect(codes(rs)).toContain('REVIEW_SCOPE_SECTION_MISSING');
  });
  it("accepts complete answers and a nonempty scope list without judging necessity", () => {
    const rs = records(['design', 'code_changes', 'review']);
    rs[2]!.payload.body = complete.replace('无', '- changed something; authorization and evidence');
    expect(codes(rs)).toEqual([]);
  });
  it("does not fabricate a baseline for legacy or duplicate descriptions", () => {
    for (const description of ['legacy', spec + '\n' + spec]) {
      expect(foldWithLint(initialCursor('full'), records(['review']), 'full', description).warnings.map(w => w.code)).toEqual(['OUT_OF_TABLE']);
    }
  });
  it("arms EXPECTED_REVISION only when the fail_design review rides a spec baseline (legacy fd exempt; host-md-skill shape)", () => {
    // shape: design → code_changes → review(fail_design) → design → code_changes (code_changes at implementing after fd design)
    const mk = (reviewBody: string) => { const rs = records(['design', 'code_changes', 'review', 'note', 'design', 'code_changes']); rs[2]!.payload.body = reviewBody; return rs; };
    // legacy: no baseline → no arm even though fd + later code_changes exist
    const legacy = foldWithLint(initialCursor("full"), mk("old-format fail_design body"), "full", "legacy description without spec section");
    expect(legacy.warnings.some(w => w.code === 'EXPECTED_REVISION')).toBe(false);
    // the gate is the description baseline alone: an old-format (sectionless)
    // fail_design body on a baseline description still arms — pins the semantics
    // against the alternative "the review itself must be structured"
    const baselineOldBody = foldWithLint(initialCursor("full"), mk("old-format fail_design body"), "full", spec);
    expect(baselineOldBody.warnings.some(w => w.code === 'EXPECTED_REVISION')).toBe(true);
    // mechanized: structured fd review arms the debt; the later code_changes warns
    const armed = foldWithLint(initialCursor("full"), mk(complete), "full", spec);
    expect(armed.warnings.some(w => w.code === 'EXPECTED_REVISION')).toBe(true);
  });
  it("tracks the active fail_design debt across design, ack and incorrect references", () => {
    const rs = records(['design', 'code_changes', 'review', 'note', 'design', 'code_changes']);
    rs[3]!.payload.ack = true;
    expect(fold(rs)).toMatchObject({ status: 'reviewing', pendingFailDesign: 3 });
    expect(fold(rs).warnings).toEqual([{version: 6, code: 'EXPECTED_REVISION', message: '应为 revision，并引用 fail_design review v3'}]);
    rs[5]!.content_type = 'revision'; rs[5]!.payload.ref_version = 3;
    expect(fold(rs).pendingFailDesign).toBeUndefined(); expect(codes(rs)).toEqual([]);
    rs[5]!.payload.ref_version = 1; expect(fold(rs).pendingFailDesign).toBe(3);
  });
  it("does not confuse an answered old round with a new debt", () => {
    const rs = records(['design', 'code_changes', 'review', 'design', 'revision', 'review', 'design', 'code_changes']);
    rs[4]!.payload.ref_version = 3;
    expect(fold(rs.slice(0, 5)).pendingFailDesign).toBeUndefined();
    expect(fold(rs).warnings).toEqual([{version: 8, code: 'EXPECTED_REVISION', message: '应为 revision，并引用 fail_design review v6'}]);
  });
  it.each(['full', 'direct', 'solo'] as const)("does not invent debt from out-of-table review in %s", (flow) => {
    expect(codes(records(['review', 'design', 'code_changes']), flow)).not.toContain('EXPECTED_REVISION');
  });
  it("expires the fail_design debt when a later review concludes the round", () => {
    // fd v3 arms → wrong code_changes v6 warns once → fail_code v7 ends the fd
    // round → the normal rework loop proceeds and nothing re-flags afterwards
    const rs = records(['design', 'code_changes', 'review', 'note', 'design', 'code_changes', 'review', 'revision', 'review']);
    rs[6]!.payload = { summary: 's', verdict: 'fail_code', body: complete };
    rs[7]!.payload.ref_version = 7;
    rs[8]!.payload = { summary: 's', verdict: 'pass', body: complete, ref_version: 7 };
    expect(fold(rs).warnings).toEqual([{version: 6, code: 'EXPECTED_REVISION', message: '应为 revision，并引用 fail_design review v3'}]);
    expect(fold(rs).pendingFailDesign).toBeUndefined();
  });
  it("ack clears previous warnings but not its own role typo or pending debt", () => {
    const rs = records(['design', 'code_changes', 'review', 'design', 'code_changes', 'note']);
    rs[5]!.payload.ack = true; rs[5]!.role = 'HUMAN';
    expect(codes(rs)).toEqual(['NON_CANONICAL_ROLE']); expect(fold(rs).pendingFailDesign).toBe(3);
  });
});

it("legacy old-format review on a frozen description: lint warns but records land and state advances (P1 back-compat)", () => {
  const oldFormatReview: ContextRecord = { task_id: "t", version: 4, timestamp: "t", role: "reviewer", content_type: "review",
    payload: { summary: "ok", body: "old-format body without structured sections", verdict: "pass", ref_version: 2 } };
  const out = foldWithLint(initialCursor("full"), records(["note", "design", "note"]), "full", spec)
    , after = foldWithLint({ status: "reviewing", prevVersion: 3, warnings: [] as never[] }, [oldFormatReview], "full", spec);
  const codes = after.warnings.filter((w) => w.version === 4).map((w) => w.code);
  expect(codes).toContain("REVIEW_EXIT_CONDITIONS_INCOMPLETE");
  expect(codes).toContain("REVIEW_SCOPE_SECTION_MISSING");
  expect(after.status).toBe("pending_approval"); // pass verdict advances normally (state machine untouched by lint)
});

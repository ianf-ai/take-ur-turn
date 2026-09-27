import type { ContextRecord, Flow, WarningCode } from "../common/types.js";
import { EXIT_REVIEW_HEADING, SCOPE_REVIEW_HEADING, exitConditions, isPlaceholder, listItems, sections } from "../common/task-spec.js";
import { foldOntoCursor, WAITING_FOR_BASE, type FoldCursor } from "./state-machine.js";

export interface LintCursor extends FoldCursor { pendingFailDesign?: number }

/** Diagnostic overlay: the existing fold remains the only authority for status. */
export function foldWithLint(cursor: LintCursor, records: readonly ContextRecord[], flow: Flow, description = "") {
  let current: LintCursor = { ...cursor, warnings: [...cursor.warnings] };
  const baseline = exitConditions(description);
  for (const record of [...records].sort((a, b) => a.version - b.version)) {
    const before = current.status;
    let pending = current.pendingFailDesign;
    const next = foldOntoCursor(current, [record], flow);
    const warn = (code: WarningCode, message: string) => next.warnings.push({ version: record.version, code, message });
    const canonical = record.role.toLowerCase();
    if (record.role !== canonical && ["architect", "executor", "reviewer", "human"].includes(canonical)) {
      warn("NON_CANONICAL_ROLE", `role 应使用精确小写 ${canonical}，保留原值 ${record.role}`);
    }
    if (record.content_type === "review") {
      const body = record.payload.body ?? "";
      const coverage = sections(body, EXIT_REVIEW_HEADING);
      const count = baseline.items.length;
      if (count) {
        const answered = new Set<number>();
        for (const item of coverage.length === 1 ? listItems(coverage[0]!) : []) {
          const answer = /^(满足|不满足|外部阻塞|已批准延后)\s*[—–:：-]\s*(.+)$/su.exec(item.text);
          if (item.number && item.number <= count && answer && !isPlaceholder(answer[2]!)) answered.add(item.number);
        }
        if (answered.size < count) warn("REVIEW_EXIT_CONDITIONS_INCOMPLETE", `退出条件已判定 ${answered.size} / 应判定 ${count}`);
      }
      // The over-engineering declaration rides the same baseline gate as the
      // coverage check: legacy reviews on descriptions without a spec section
      // stay exempt (back-compat — upgrades must not flip existing tasks).
      if (count) {
        const scope = sections(body, SCOPE_REVIEW_HEADING);
        if (scope.length !== 1 || isPlaceholder(scope[0]!.join("\n"), true) ||
            (listItems(scope[0]!).length > 0 && listItems(scope[0]!).every((item) => isPlaceholder(item.text, true)))) {
          warn("REVIEW_SCOPE_SECTION_MISSING", "缺少非空的超出规格的改动节（填写无或改动清单）");
        }
      }
      if (flow === "full" && before === "reviewing" && next.status === "designing" && record.payload.verdict === "fail_design" && count) pending = record.version;
      // A later review concluding the round (fail_code → revising, pass →
      // approval) makes the fail_design demand stale: without this the old
      // debt re-flags EXPECTED_REVISION on every future code_changes.
      else if (pending !== undefined && before === "reviewing" && next.status !== "designing") pending = undefined;
    }
    if (before === "implementing" && record.content_type === "code_changes" && pending !== undefined) {
      warn("EXPECTED_REVISION", `应为 revision，并引用 fail_design review v${pending}`);
    }
    if (record.content_type === "revision" && (before === "revising" || before === "implementing") &&
        next.status === "reviewing" && record.payload.ref_version === pending) pending = undefined;
    current = { status: next.status, prevVersion: next.prevVersion, warnings: next.warnings,
      ...(pending !== undefined ? { pendingFailDesign: pending } : {}) };
  }
  const needs_attention = current.warnings.length > 0;
  return { ...current, needs_attention, waiting_for: needs_attention ? "human" as const : WAITING_FOR_BASE[current.status] };
}

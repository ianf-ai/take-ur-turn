import type { ContextRecord, Flow, SupportedFix, Warning } from "../common/types.js";
import { EXIT_REVIEW_HEADING, SCOPE_REVIEW_HEADING, exitConditions, isPlaceholder, listItems, sections } from "../common/task-spec.js";
import { foldOntoCursor, WAITING_FOR_BASE, type FoldCursor } from "./state-machine.js";

type LintCode = "NON_CANONICAL_ROLE" | "REVIEW_EXIT_CONDITIONS_INCOMPLETE" | "REVIEW_SCOPE_SECTION_MISSING" | "EXPECTED_REVISION";
interface LintIssue {
  code: LintCode;
  role: string;
  root: number;
  last: number;
  round: number;
  requiredRef?: number;
}
export interface LintCursor extends FoldCursor {
  pendingFailDesign?: number;
  pending_since?: string | null;
  round_count?: number;
  lintIssues?: LintIssue[];
}

/** Diagnostic overlay: the existing fold remains the only authority for status. */
export function foldWithLint(cursor: LintCursor, records: readonly ContextRecord[], flow: Flow, description = "") {
  let current: LintCursor = { ...cursor, pending_since: cursor.pending_since ?? null,
    round_count: cursor.round_count ?? 0, warnings: [...cursor.warnings],
    lintIssues: (cursor.lintIssues ?? []).map(issue => ({ ...issue })) };
  const baseline = exitConditions(description);
  for (const record of [...records].sort((a, b) => a.version - b.version)) {
    const before = current.status;
    let pending = current.pendingFailDesign;
    const next = foldOntoCursor(current, [record], flow);
    let issues = current.lintIssues!;
    if ((record.content_type === "note" && record.payload.ack === true) ||
        (record.content_type === "decision" && record.payload.decision === "close")) issues = [];
    const canonical = record.role.toLowerCase();
    const clear = (issue: LintIssue) => {
      next.warnings = next.warnings.filter(w => !(w.code === issue.code && w.version === issue.last));
      issues = issues.filter(candidate => candidate !== issue);
    };
    const find = (code: LintCode) => issues.find(issue => issue.code === code && issue.role === canonical);
    const warn = (code: LintCode, message: string, location: NonNullable<Warning["location"]>, fixes: SupportedFix[], requiredRef?: number) => {
      const previous = find(code);
      const issue: LintIssue = { code, role: canonical, root: previous?.root ?? record.version,
        last: record.version, round: (previous?.round ?? 0) + 1,
        ...(requiredRef !== undefined ? { requiredRef } : {}) };
      if (previous) clear(previous);
      issues.push(issue);
      next.warnings.push({ version: record.version, code,
        message: message + (issue.round >= 2 ? "；修正轮耗尽，请人工处置" : ""), location, supportedFixes: fixes,
        correction: { root_version: issue.root, round: issue.round, limit: 2, exhausted: issue.round >= 2 } });
    };
    const correctionNote = record.content_type === "note" && record.payload.ack !== true;
    const targets = correctionNote ? issues.filter(issue =>
      issue.role === canonical && record.role === canonical &&
      (record.payload.ref_version === issue.root || record.payload.ref_version === issue.last)) : [];
    const noteFix = (field: string, instruction: string, example?: string): SupportedFix => ({ field, instruction,
      ...(example !== undefined ? { example } : {}),
      record: { role: canonical, content_type: "note", ref_version: record.version } });
    if (record.role !== canonical && ["architect", "executor", "reviewer", "human"].includes(canonical)) {
      warn("NON_CANONICAL_ROLE", `role 应使用精确小写 ${canonical}，保留原值 ${record.role}`,
        { field: "role" }, [noteFix("role", "追加同角色小写 note，ref_version 指向本诊断版本；保留原记录。", canonical)]);
    } else for (const issue of targets.filter(issue => issue.code === "NON_CANONICAL_ROLE")) clear(issue);

    // An explicit correction note replaces only the addressed diagnostics; it
    // does not replay the source record's verdict or any other transition.
    const reviewCodes = ["REVIEW_EXIT_CONDITIONS_INCOMPLETE", "REVIEW_SCOPE_SECTION_MISSING"] as const;
    for (const code of reviewCodes) {
      if (record.content_type !== "review" && !targets.some(issue => issue.code === code)) continue;
      if (!baseline.items.length) continue;
      const body = record.payload.body ?? "";
      let message: string | undefined;
      let heading: string;
      let example: string;
      if (code === "REVIEW_EXIT_CONDITIONS_INCOMPLETE") {
        heading = EXIT_REVIEW_HEADING;
        const coverage = sections(body, heading);
        const answered = new Set<number>();
        for (const item of coverage.length === 1 ? listItems(coverage[0]!) : []) {
          const answer = /^(满足|不满足|外部阻塞|已批准延后)\s*[—–:：-]\s*(.+)$/su.exec(item.text);
          if (item.number && item.number <= baseline.items.length && answer && !isPlaceholder(answer[2]!)) answered.add(item.number);
        }
        if (answered.size < baseline.items.length) message = `退出条件已判定 ${answered.size} / 应判定 ${baseline.items.length}`;
        example = `## ${heading}\n` + baseline.items.map((_, i) => `${i + 1}. <满足|不满足|外部阻塞|已批准延后> — <本项证据或理由>`).join("\n");
      } else {
        heading = SCOPE_REVIEW_HEADING;
        const scope = sections(body, heading);
        if (scope.length !== 1 || isPlaceholder(scope[0]!.join("\n"), true) ||
            (listItems(scope[0]!).length > 0 && listItems(scope[0]!).every(item => isPlaceholder(item.text, true)))) {
          message = "缺少非空的超出规格的改动节（填写无或改动清单）";
        }
        example = `## ${heading}\n无`;
      }
      if (message) warn(code, message, { field: "payload.body", section: heading }, [noteFix("payload.body",
        `追加 note 并引用诊断版本，填写唯一的「## ${heading}」节；正文用真实核验结果替换占位内容。`, example)]);
      else { const issue = find(code); if (issue) clear(issue); }
    }
    if (record.content_type === "review") {
      if (flow === "full" && before === "reviewing" && next.status === "designing" && record.payload.verdict === "fail_design" && baseline.items.length) pending = record.version;
      else if (pending !== undefined && before === "reviewing" && next.status !== "designing") pending = undefined;
    }
    const revisionIssue = find("EXPECTED_REVISION");
    const expected = pending ?? revisionIssue?.requiredRef;
    const validRevision = record.content_type === "revision" && (before === "revising" || before === "implementing") &&
      next.status === "reviewing" && record.payload.ref_version === expected;
    if (validRevision) {
      if (revisionIssue) clear(revisionIssue);
      if (record.payload.ref_version === pending) pending = undefined;
    } else if ((before === "implementing" && record.content_type === "code_changes" && pending !== undefined) ||
        (revisionIssue && pending === revisionIssue.requiredRef && record.content_type === "revision" && before !== "closed")) {
      const required = expected!;
      const target = { role: canonical, content_type: "revision", ref_version: required };
      warn("EXPECTED_REVISION", `应为 revision，并引用 fail_design review v${required}`,
        { field: "content_type" }, [
          { field: "content_type", example: "revision", record: target,
            instruction: "若已在 reviewing，先追加 executor 非 ack note 收回交付；在 implementing/revising 追加 revision，不改写原记录。" },
          { field: "payload.ref_version", example: required, record: target, instruction: "引用打回设计的 fail_design review 版本。" },
        ], required);
    }
    const delivered = before !== next.status &&
      (record.content_type === "code_changes" || record.content_type === "revision") &&
      (next.status === "reviewing" || next.status === "pending_approval");
    current = { status: next.status, prevVersion: next.prevVersion, warnings: next.warnings,
      ...(next.reviewGateWarnings?.length ? { reviewGateWarnings: next.reviewGateWarnings } : {}),
      lintIssues: issues,
      pending_since: next.status === "pending_approval"
        ? (before === "pending_approval" ? current.pending_since ?? "unknown"
          : Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : "unknown") : null,
      round_count: current.round_count! + (delivered ? 1 : 0),
      ...(pending !== undefined ? { pendingFailDesign: pending } : {}) };
  }
  const needs_attention = current.warnings.length > 0;
  return { ...current, needs_attention, waiting_for: needs_attention ? "human" as const : WAITING_FOR_BASE[current.status] };
}

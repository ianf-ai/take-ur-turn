import {
  PROJECT_TASK_ID,
  type ContextRecord,
  type DeriveFn,
  type DerivedState,
  type Flow,
  type Status,
  type WaitingFor,
  type Warning,
  type WarningCode,
} from "./types.js";

/**
 * Derivation (system-design 3.1-3.3). Pure function: no IO, no
 * timestamp consumption, no mutation of inputs. Folding only ever reads
 * content_type + the payload fields ack / verdict / decision;
 * everything else in payload is ignored.
 *
 * The transition table is selected by the task's flow ("full" | "direct"
 * | "solo", system-design 3.1 three-table definition); flow is absent = full,
 * so call sites that omit it are unchanged.
 */

/** Base waiting_for map (system-design 3.1) — flow-independent. */
const WAITING_FOR_BASE: Record<Status, WaitingFor> = {
  designing: "agent:architect",
  implementing: "agent:executor",
  reviewing: "agent:reviewer",
  revising: "agent:executor",
  pending_approval: "human",
  approved: "human",
  closed: "none",
};

/** Initial status of an empty sequence per flow (direct starts implementing). */
const INITIAL_STATUS: Record<Flow, Status> = {
  full: "designing",
  direct: "implementing",
  solo: "designing",
};

/** full review verdict targets (also serves solo's unreachable review row). */
const VERDICT_TARGET: Record<string, Status> = {
  pass: "pending_approval",
  fail_code: "revising",
  fail_design: "designing",
};

/**
 * direct review verdict targets: fail_design is ABSENT on purpose — direct has
 * no designing state, so a fail_design verdict is out-of-table there (the
 * human adjudicates: close, or supply a design); see system-design 3.1.
 */
const VERDICT_TARGET_DIRECT: Record<string, Status> = {
  pass: "pending_approval",
  fail_code: "revising",
};

/** One fold step: next status plus an optional warning for this record. */
function fold(status: Status, record: ContextRecord, flow: Flow): { status: Status; warning: WarningCode | null } {
  // note: never changes status, never warns, in any state (including closed).
  if (record.content_type === "note") {
    return { status, warning: null };
  }

  // closed is absorbing: everything except note and decision(close) warns.
  if (status === "closed") {
    if (record.content_type === "decision" && record.payload.decision === "close") {
      return { status, warning: null }; // idempotent, no warning (decision 3)
    }
    return { status, warning: "CLOSED_ABSORB" };
  }

  switch (record.content_type) {
    case "design":
      // direct: design in implementing is an in-table REFERENCE record — no
      // transition, no warning; in every other state it is out-of-table (the
      // same out-of-table semantics as full's non-designing states).
      if (flow === "direct") {
        return status === "implementing"
          ? { status, warning: null }
          : { status, warning: "OUT_OF_TABLE" };
      }
      return status === "designing"
        ? { status: "implementing", warning: null }
        : { status, warning: "OUT_OF_TABLE" };
    case "code_changes":
      // solo skips the review phase: implementing goes straight to the human
      // approval gate; the non-implementing states stay out-of-table as in full.
      if (flow === "solo") {
        return status === "implementing"
          ? { status: "pending_approval", warning: null }
          : { status, warning: "OUT_OF_TABLE" };
      }
      return status === "implementing"
        ? { status: "reviewing", warning: null }
        : { status, warning: "OUT_OF_TABLE" };
    case "review": {
      // solo: no review phase exists — a review record never fits the table
      // in ANY state (publishing one in a review-free flow is a visible
      // deviation). Out-of-table takes precedence over INVALID_VERDICT.
      if (flow === "solo") {
        return { status, warning: "OUT_OF_TABLE" };
      }
      // OUT_OF_TABLE takes precedence over INVALID_VERDICT: a review outside
      // reviewing is out-of-table and its verdict is not evaluated.
      if (status !== "reviewing") {
        return { status, warning: "OUT_OF_TABLE" };
      }
      // Own-property lookup only: indexing a plain object with values
      // like "constructor" / "__proto__" / "toString" would hit the prototype
      // chain and return a non-undefined function as the "target status".
      const verdict = record.payload.verdict;
      const table = flow === "direct" ? VERDICT_TARGET_DIRECT : VERDICT_TARGET;
      const target =
        typeof verdict === "string" && Object.hasOwn(table, verdict)
          ? table[verdict]
          : undefined;
      if (target !== undefined) {
        return { status: target, warning: null };
      }
      // direct fail_design: a LEGAL verdict whose row does not exist in this
      // flow — out-of-table (the human adjudicates), NOT invalid; that code is
      // reserved for values outside the verdict vocabulary.
      if (flow === "direct" && typeof verdict === "string" && Object.hasOwn(VERDICT_TARGET, verdict)) {
        return { status, warning: "OUT_OF_TABLE" };
      }
      return { status, warning: "INVALID_VERDICT" };
    }
    case "revision":
      // solo: revising is unreachable (no review loop) — a revision record
      // never fits the table in any state.
      if (flow === "solo") {
        return { status, warning: "OUT_OF_TABLE" };
      }
      return status === "revising"
        ? { status: "reviewing", warning: null }
        : { status, warning: "OUT_OF_TABLE" };
    case "decision": {
      const decision = record.payload.decision;
      // close is valid from ANY state (system-design 3.1); a decision record
      // with a missing/unknown value does not fit the table.
      if (decision === "close") {
        return { status: "closed", warning: null };
      }
      if ((decision === "approve" || decision === "reject") && status === "pending_approval") {
        // solo reject sends the work back to implementing (rework; a fresh
        // code_changes re-enters pending_approval) — full/direct enter the
        // revision loop instead.
        if (decision === "reject" && flow === "solo") {
          return { status: "implementing", warning: null };
        }
        return { status: decision === "approve" ? "approved" : "revising", warning: null };
      }
      return { status, warning: "OUT_OF_TABLE" };
    }
    default:
      // Unknown content_type: accepted but never in-table (system-design 4.1).
      return { status, warning: "OUT_OF_TABLE" };
  }
}

export const derive: DeriveFn = (
  task_id: string,
  records: readonly ContextRecord[],
  flow?: Flow,
): DerivedState | null => {
  if (task_id === PROJECT_TASK_ID) return null;
  const effectiveFlow: Flow = flow ?? "full";

  // Sort by version without mutating the input. Array#sort is stable (ES2019+),
  // so duplicate versions keep input order.
  const ordered = [...records].sort((a, b) => a.version - b.version);

  let status: Status = INITIAL_STATUS[effectiveFlow];
  const warnings: Warning[] = [];
  let prevVersion = 0;

  for (const record of ordered) {
    // ack (decision 2): clears warnings accumulated by PRECEDING records
    // only. Evaluated before this record's own structural/fold warnings are
    // pushed, so a note can never clear its own anomalies. No-op on a
    // clean state.
    if (record.content_type === "note" && record.payload.ack === true) {
      warnings.length = 0;
    }

    // Structural anomaly (warning order: structural before fold warning).
    if (record.version === prevVersion) {
      warnings.push({ version: record.version, code: "VERSION_DUPLICATE" });
    } else if (record.version !== prevVersion + 1) {
      warnings.push({ version: record.version, code: "VERSION_GAP" });
    }
    prevVersion = record.version;

    const step = fold(status, record, effectiveFlow);
    status = step.status;
    if (step.warning !== null) {
      warnings.push({ version: record.version, code: step.warning });
    }
  }

  const needsAttention = warnings.length > 0;
  return {
    status,
    waiting_for: needsAttention ? "human" : WAITING_FOR_BASE[status],
    needs_attention: needsAttention,
    warnings,
  };
};

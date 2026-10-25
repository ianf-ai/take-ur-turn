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
} from "../common/types.js";

/**
 * Derivation. Pure function: no IO, no
 * timestamp consumption, no mutation of inputs. Folding only ever reads
 * content_type + the payload fields ack / verdict / decision, plus the
 * record's role — solely for the reviewing-state executor-note exception row;
 * everything else in payload is ignored.
 *
 * The transition table is selected by the task's flow ("full" | "direct"
 * | "solo"); flow is absent = full,
 * so call sites that omit it are unchanged.
 */

/** Base waiting_for map — flow-independent. Exported for the store's cache-aware fold reconstruction. */
export const WAITING_FOR_BASE: Record<Status, WaitingFor> = {
  designing: "agent:architect",
  implementing: "agent:executor",
  reviewing: "agent:reviewer",
  revising: "agent:executor",
  pending_approval: "human",
  approved: "human",
  closed: "none",
};

/** Initial status of an empty sequence per flow (direct/solo start implementing). */
const INITIAL_STATUS: Record<Flow, Status> = {
  full: "designing",
  direct: "implementing",
  solo: "implementing",
};

/**
 * Full review verdict targets and the shared four-verdict vocabulary.
 * blocked_external targets pending_approval exactly like pass (code fine,
 * verification blocked on external
 * conditions — the external-verification decision belongs to the human at
 * the approval gate, so the derivation path is shared with pass).
 */
const VERDICT_TARGET: Record<string, Status> = {
  pass: "pending_approval",
  blocked_external: "pending_approval",
  fail_code: "revising",
  fail_design: "designing",
};

/**
 * direct review verdict targets: fail_design is ABSENT on purpose — direct has
 * no designing state, so a fail_design verdict is out-of-table there (the
 * human adjudicates at pending_approval).
 */
const VERDICT_TARGET_DIRECT: Record<string, Status> = {
  pass: "pending_approval",
  blocked_external: "pending_approval",
  fail_code: "revising",
};

/** One fold step: next status plus an optional warning for this record. */
function fold(status: Status, record: ContextRecord, flow: Flow): { status: Status; warning: WarningCode | null } {
  // note: never warns, in any state (including closed). The ONE transition
  // exception: a non-ack note from the executor while
  // reviewing hands the round back — the worker speaking up during the
  // review wait IS reclaiming the turn. Constraints, all four enforced by
  // this guard order: only in reviewing (any other state's note is the usual
  // mid-work supplement), only role=executor (reviewer/architect/human notes
  // are clarifications, not turn claims), never an ack note (anomaly-handling
  // confirmation outranks turn reclaim), and closed absorbs first-class below
  // — status "closed" fails this equality, so the exception never fires there.
  // solo has no reviewing state, so the row is unreachable there by construction.
  if (record.content_type === "note") {
    if (record.payload.ack !== true && record.role === "executor" && status === "reviewing") {
      return { status: "revising", warning: null };
    }
    return { status, warning: null };
  }

  // closed is absorbing: everything except note and decision(close) warns.
  if (status === "closed") {
    if (record.content_type === "decision" && record.payload.decision === "close") {
      return { status, warning: null }; // idempotent close, no warning
    }
    return { status, warning: "CLOSED_ABSORB" };
  }

  switch (record.content_type) {
    case "design":
      // direct/solo: design in implementing is an in-table REFERENCE record — no
      // transition, no warning; in every other state it is out-of-table (the
      // same out-of-table semantics as full's non-designing states).
      if (flow === "direct" || flow === "solo") {
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
      // Own-property lookup only: indexing a plain object with values
      // like "constructor" / "__proto__" / "toString" would hit the prototype
      // chain and return a non-undefined function as the "target status".
      const verdict = record.payload.verdict;
      const table = flow === "direct" ? VERDICT_TARGET_DIRECT : VERDICT_TARGET;
      if (typeof verdict === "string" && Object.hasOwn(VERDICT_TARGET, verdict)) {
        const target = flow !== "solo" && status === "reviewing" && Object.hasOwn(table, verdict)
          ? table[verdict] : undefined;
        return target !== undefined
          ? { status: target, warning: null }
          : { status: "pending_approval", warning: "OUT_OF_TABLE" };
      }
      // Invalid values retain the existing diagnostic precedence outside the
      // review row; only the four legal verdicts use the human-gate catch-all.
      return { status, warning: flow === "solo" || status !== "reviewing" ? "OUT_OF_TABLE" : "INVALID_VERDICT" };
    }
    case "revision":
      // solo: revising is unreachable (no review loop) — a revision record
      // never fits the table in any state.
      if (flow === "solo") {
        return { status, warning: "OUT_OF_TABLE" };
      }
      // full: fail_design → designing → design → implementing also accepts
      // revision: the envelope discipline requires a revision, not a second-round code_changes.
      // The table consumes only the current state/flow, not prior history.
      return status === "revising" || (flow === "full" && status === "implementing")
        ? { status: "reviewing", warning: null }
        : { status, warning: "OUT_OF_TABLE" };
    case "decision": {
      const decision = record.payload.decision;
      // close is valid from ANY state; a decision record
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
      // Unknown content_type: accepted but never in-table.
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
  const { prevVersion: _cursorInternal, reviewGateWarnings: _gateInternal, ...state } =
    foldOntoCursor(initialCursor(effectiveFlow), ordered, effectiveFlow);
  return state; // Cursor bookkeeping stays internal — derive's contract remains DerivedState.
};

/**
 * Resumable fold state (read-path cache): exactly the carried
 * state between derive's record steps. `status` is the folded status,
 * `prevVersion` the last folded record version (0 = nothing folded — the
 * structural-anomaly comparator), `warnings` the accumulated warnings, and
 * `reviewGateWarnings` the subset requiring a decision rather than ack.
 */
export interface FoldCursor {
  status: Status;
  prevVersion: number;
  warnings: Warning[];
  /** Exact warning objects (a subset of warnings), never keyed by non-unique version. Internal only. */
  reviewGateWarnings?: Warning[];
}

/** Cursor of an empty sequence per flow (direct/solo start implementing). */
export function initialCursor(flow: Flow): FoldCursor {
  return { status: INITIAL_STATUS[flow], prevVersion: 0, warnings: [] };
}

/**
 * Incremental sibling of derive: fold `records` — which must ALL
 * carry versions >= cursor.prevVersion (duplicates are diagnosed), in ascending order after the same
 * stable version sort derive applies — onto a resumed cursor. Byte-equal
 * semantics with folding the whole sequence at once: the cursor carries
 * everything the per-record fold reads. The incoming cursor's warnings array
 * is copied, never mutated (cursors are cached and shared; results escape to
 * callers), and the returned state's array is the new cursor's own.
 */
export function foldOntoCursor(
  cursor: FoldCursor,
  records: readonly ContextRecord[],
  flow: Flow,
): DerivedState & FoldCursor {
  const ordered = [...records].sort((a, b) => a.version - b.version);

  let status: Status = cursor.status;
  let warnings: Warning[] = [...cursor.warnings];
  let reviewGateWarnings = [...(cursor.reviewGateWarnings ?? [])];
  let prevVersion = cursor.prevVersion;

  for (const record of ordered) {
    const step = fold(status, record, flow);
    const isGateWarning = (warning: Warning) => reviewGateWarnings.includes(warning);
    // Clear only preceding warnings. Acknowledgement cannot replace a
    // decision at the review catch-all gate; unrelated warnings keep their
    // previous ack/close semantics and survive approve/reject.
    if (record.content_type === "decision" && record.payload.decision === "close") {
      warnings = [];
      reviewGateWarnings = [];
    } else if (record.content_type === "decision" && status === "pending_approval" && step.warning === null) {
      warnings = warnings.filter(warning => !isGateWarning(warning));
      reviewGateWarnings = [];
    } else if (record.content_type === "note" && record.payload.ack === true) {
      warnings = warnings.filter(isGateWarning);
    }

    // Structural anomaly (warning order: structural before fold warning).
    if (record.version === prevVersion) {
      warnings.push({ version: record.version, code: "VERSION_DUPLICATE" });
    } else if (record.version !== prevVersion + 1) {
      warnings.push({ version: record.version, code: "VERSION_GAP" });
    }
    prevVersion = record.version;

    status = step.status;
    if (step.warning !== null) {
      const warning: Warning = { version: record.version, code: step.warning };
      warnings.push(warning);
      if (record.content_type === "review" && step.warning === "OUT_OF_TABLE" &&
          typeof record.payload.verdict === "string" && Object.hasOwn(VERDICT_TARGET, record.payload.verdict)) {
        reviewGateWarnings.push(warning);
      }
    }
  }

  const needsAttention = warnings.length > 0;
  return {
    status,
    waiting_for: needsAttention ? "human" : WAITING_FOR_BASE[status],
    needs_attention: needsAttention,
    warnings,
    prevVersion,
    ...(reviewGateWarnings.length ? { reviewGateWarnings } : {}),
  };
}

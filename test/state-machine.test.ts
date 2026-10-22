import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { derive, foldOntoCursor, initialCursor } from "../src/core/hub/state-machine.js";
import { foldWithLint } from "../src/core/hub/record-lint.js";
import type { ContextRecord, DerivedState, Flow } from "../src/core/common/types.js";

/**
 * Golden vectors are the single source of truth ("double
 * consumption"). Expected values are NEVER copied into this file — they are
 * read from test/fixtures/sequences.json and asserted structurally.
 * Vectors carry an optional flow ("direct" | "solo"; absent = full) which
 * is passed straight through to derive — the same array drives all three
 * transition tables.
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

describe("derive: golden vectors (sequences.json)", () => {
  for (const vector of vectors) {
    describe(vector.name, () => {
      it("matches the expected derived state", () => {
        const actual = derive(vector.task_id, vector.records, vector.flow);
        expect(actual).toStrictEqual(vector.expected);
      });
    });
  }
});

describe("derive: unit properties beyond the fixtures", () => {
  const outOfOrder: ContextRecord[] = [
    {
      version: 2,
      task_id: "unit-order",
      role: "executor",
      content_type: "code_changes",
      timestamp: "2026-08-15T09:01:00Z",
      payload: { summary: "implemented", body: "as designed" },
    },
    {
      version: 1,
      task_id: "unit-order",
      role: "architect",
      content_type: "design",
      timestamp: "2026-08-15T09:00:00Z",
      payload: { summary: "design", body: "thin wrapper" },
    },
  ];

  it("is idempotent: the same input derives the same output twice", () => {
    const first = derive("unit-order", outOfOrder);
    const second = derive("unit-order", outOfOrder);
    expect(second).toStrictEqual(first);
    expect(first).toStrictEqual({
      status: "reviewing",
      waiting_for: "agent:reviewer",
      needs_attention: false,
      warnings: [],
    } satisfies DerivedState);
  });

  it("absent flow === explicit \"full\" (backward compat)", () => {
    expect(derive("unit-order", outOfOrder, "full")).toStrictEqual(derive("unit-order", outOfOrder));
  });

  it("does not mutate the input array (order) or its records", () => {
    const records = structuredClone(outOfOrder);
    derive("unit-order", records);
    expect(records).toStrictEqual(outOfOrder);
    expect(records[0]?.version).toBe(2);
    expect(records[1]?.version).toBe(1);
  });

  it("returns independent objects per call: mutating one result does not leak into the next", () => {
    const first = derive("unit-order", outOfOrder);
    first?.warnings.push({ version: 99, code: "OUT_OF_TABLE" });
    const second = derive("unit-order", outOfOrder);
    expect(second?.warnings).toStrictEqual([]);
  });

  it("ignores stray payload fields it does not consume (verdict on note, ack on design)", () => {
    const records: ContextRecord[] = [
      {
        version: 1,
        task_id: "unit-stray",
        role: "architect",
        content_type: "design",
        timestamp: "2026-08-15T09:00:00Z",
        payload: {
          summary: "design",
          body: "stray fields below",
          verdict: "fail_code",
          ack: true,
          decision: "close",
        },
      },
    ];
    expect(derive("unit-stray", records)).toStrictEqual({
      status: "implementing",
      waiting_for: "agent:executor",
      needs_attention: false,
      warnings: [],
    } satisfies DerivedState);
  });

  it("note with ack !== true does not clear accumulated warnings", () => {
    const records: ContextRecord[] = [
      {
        version: 1,
        task_id: "unit-ack-truthy",
        role: "architect",
        content_type: "design",
        timestamp: "2026-08-15T09:00:00Z",
        payload: { summary: "design", body: "fold" },
      },
      {
        version: 2,
        task_id: "unit-ack-truthy",
        role: "reviewer",
        content_type: "design",
        timestamp: "2026-08-15T09:01:00Z",
        payload: { summary: "duplicate design", body: "out of sequence" },
      },
      {
        version: 3,
        task_id: "unit-ack-truthy",
        role: "human",
        content_type: "note",
        timestamp: "2026-08-15T09:02:00Z",
        // ack must be exactly boolean true — "true" (string) is a no-op
        payload: { summary: "not an ack", body: "ack is a string here", ack: "true" as unknown as boolean },
      },
    ];
    expect(derive("unit-ack-truthy", records)).toStrictEqual({
      status: "implementing",
      waiting_for: "human",
      needs_attention: true,
      warnings: [{ version: 2, code: "OUT_OF_TABLE" }],
    } satisfies DerivedState);
  });

  it("structural warning on a record coexists with its fold warning, structural first", () => {
    // v3 design lands in implementing (out-of-table) AND after a version gap.
    const records: ContextRecord[] = [
      {
        version: 1,
        task_id: "unit-structural",
        role: "architect",
        content_type: "design",
        timestamp: "2026-08-15T09:00:00Z",
        payload: { summary: "design", body: "fold" },
      },
      {
        version: 3,
        task_id: "unit-structural",
        role: "architect",
        content_type: "design",
        timestamp: "2026-08-15T09:02:00Z",
        payload: { summary: "gap + wrong state", body: "double anomaly" },
      },
    ];
    expect(derive("unit-structural", records)).toStrictEqual({
      status: "implementing",
      waiting_for: "human",
      needs_attention: true,
      warnings: [
        { version: 3, code: "VERSION_GAP" },
        { version: 3, code: "OUT_OF_TABLE" },
      ],
    } satisfies DerivedState);
  });

  it("solo accepts code_changes after a launch note without a design record", () => {
    // Solo starts implementing; role is a label, not a derivation gate.
    const records: ContextRecord[] = [
      {
        version: 1,
        task_id: "solo-architect-direct-delivery",
        role: "human",
        content_type: "note",
        timestamp: "2026-08-27T04:42:40.511Z",
        payload: { summary: "launch: architect (base v0)", body: "launch note" },
      },
      {
        version: 2,
        task_id: "solo-architect-direct-delivery",
        role: "architect",
        content_type: "code_changes",
        timestamp: "2026-08-27T04:44:47.209Z",
        payload: { summary: "validation delivery", body: "ceremony delivery" },
      },
    ];

    expect(derive("solo-architect-direct-delivery", records, "solo")).toStrictEqual({
      status: "pending_approval",
      waiting_for: "human",
      needs_attention: false,
      warnings: [],
    } satisfies DerivedState);
  });
});

describe("out-of-table legal reviews enter the human gate", () => {
  function record(version: number, content_type: string, payload: Record<string, unknown> = {}): ContextRecord {
    return { version, task_id: "review-gate", role: content_type === "review" ? "reviewer" : "human",
      content_type, timestamp: "2026-10-21T00:00:00Z", payload: { summary: "gate", body: "gate regression", ...payload } as ContextRecord["payload"] };
  }
  const statuses = ["designing", "implementing", "reviewing", "revising", "pending_approval", "approved", "closed"] as const;
  const verdicts = ["pass", "blocked_external", "fail_code", "fail_design"] as const;

  for (const flow of ["full", "direct", "solo"] as const) {
    for (const status of statuses) {
      it(`${flow}/${status}: all legal verdicts use the table or the human catch-all; closed absorbs`, () => {
        for (const verdict of verdicts) {
          const inTable = status === "reviewing" && flow !== "solo" && !(flow === "direct" && verdict === "fail_design");
          const target = verdict === "fail_code" ? "revising" : verdict === "fail_design" ? "designing" : "pending_approval";
          const closed = status === "closed";
          const actual = foldOntoCursor({ status, warnings: [], prevVersion: 0 }, [record(1, "review", { verdict })], flow);
          expect(actual.status).toBe(closed ? "closed" : inTable ? target : "pending_approval");
          expect(actual.warnings).toEqual(inTable ? [] : [{ version: 1, code: closed ? "CLOSED_ABSORB" : "OUT_OF_TABLE" }]);
          expect(actual.needs_attention).toBe(!inTable);
          expect(actual.waiting_for).toBe(inTable && target !== "pending_approval" ? `agent:${target === "designing" ? "architect" : "executor"}` : "human");
        }
      });

      it(`${flow}/${status}: missing, invalid and prototype verdicts retain existing behavior`, () => {
        for (const verdict of [undefined, "bogus", "constructor", "__proto__", "toString"]) {
          const payload = verdict === undefined ? {} : { verdict };
          const actual = foldOntoCursor({ status, warnings: [], prevVersion: 0 }, [record(1, "review", payload)], flow);
          expect(actual.status).toBe(status);
          expect(actual.warnings).toEqual([{ version: 1, code: status === "closed" ? "CLOSED_ABSORB" :
            flow !== "solo" && status === "reviewing" ? "INVALID_VERDICT" : "OUT_OF_TABLE" }]);
        }
      });
    }
  }

  it.each(["approve", "reject", "close"])("direct fail_design: notes retain warnings until %s; cold and incremental agree", decision => {
    const records = [record(1, "code_changes"), record(2, "review", { verdict: "fail_design" }),
      record(3, "note"), record(4, "note", { ack: true }), record(5, "decision", { decision })];
    let cursor = initialCursor("direct");
    for (let i = 0; i < records.length; i++) {
      cursor = foldOntoCursor(cursor, [records[i]!], "direct");
      const whole = derive("review-gate", records.slice(0, i + 1), "direct");
      expect(cursor).toMatchObject(whole!);
      if (i >= 1 && i < 4) expect(whole).toEqual({ status: "pending_approval", waiting_for: "human", needs_attention: true,
        warnings: [{ version: 2, code: "OUT_OF_TABLE" }] });
    }
    expect(derive("review-gate", records, "direct")).toEqual({
      status: decision === "approve" ? "approved" : decision === "reject" ? "revising" : "closed",
      waiting_for: decision === "reject" ? "agent:executor" : decision === "close" ? "none" : "human",
      needs_attention: false, warnings: [],
    });
  });

  it("clears only gate warnings on approval, retains new structural anomalies, and never mutates a cached gate cursor", () => {
    const gate = foldOntoCursor(initialCursor("direct"), [record(1, "mystery"), record(2, "review", { verdict: "pass" })], "direct");
    const snapshot = structuredClone(gate);
    const ack = foldOntoCursor(gate, [record(3, "note", { ack: true })], "direct");
    expect(ack.warnings).toEqual([{ version: 2, code: "OUT_OF_TABLE" }]);
    const invalidDecision = foldOntoCursor(gate, [record(3, "decision", { decision: "bogus" })], "direct");
    expect(invalidDecision.warnings).toContainEqual({ version: 2, code: "OUT_OF_TABLE" });
    const approved = foldOntoCursor(gate, [record(4, "decision", { decision: "approve" })], "direct");
    expect(approved.status).toBe("approved");
    expect(approved.warnings).toEqual([{ version: 1, code: "OUT_OF_TABLE" }, { version: 4, code: "VERSION_GAP" }]);
    expect(gate).toEqual(snapshot);
  });

  for (const reviewFirst of [false, true]) {
    it.each(["approve", "reject", "ack", "close"] as const)(
      `duplicate versions, review ${reviewFirst ? "first" : "last"}: %s preserves warning origins across all fold paths`, action => {
        const other = record(2, "code_changes");
        const review = record(2, "review", { verdict: "fail_design" });
        const prefix = [record(1, "code_changes"), ...(reviewFirst ? [review, other] : [other, review])];
        const ending = action === "ack" ? record(3, "note", { ack: true }) : record(3, "decision", { decision: action });
        const records = [...prefix, ending];
        const outOfTable = { version: 2, code: "OUT_OF_TABLE" };
        const duplicate = { version: 2, code: "VERSION_DUPLICATE" };
        const expected = action === "close" ? [] : action === "ack" ? [outOfTable] :
          reviewFirst ? [duplicate, outOfTable] : [outOfTable, duplicate];
        const cold = derive("review-gate", records, "direct")!;
        expect(cold.warnings).toEqual(expected);
        const gate = foldOntoCursor(initialCursor("direct"), prefix, "direct");
        const reviewWarning = gate.reviewGateWarnings![0]!;
        const otherWarning = gate.warnings.find(w => w.code === "OUT_OF_TABLE" && w !== reviewWarning)!;
        expect(otherWarning).toEqual(reviewWarning); // same public shape, distinct occurrences
        expect(otherWarning).not.toBe(reviewWarning);
        const resumed = foldOntoCursor(gate, [ending], "direct");
        expect(resumed.warnings.includes(reviewWarning)).toBe(action === "ack");
        expect(resumed.warnings.includes(otherWarning)).toBe(action === "approve" || action === "reject");

        const spec = "## 验收场景\n1. preserve warning origins";
        const linted = foldWithLint(initialCursor("direct"), records, "direct", spec);
        expect(linted.warnings.filter(w => w.code === "OUT_OF_TABLE" || w.code === "VERSION_DUPLICATE")).toEqual(expected);
        expect(linted.warnings.filter(w => w.code.startsWith("REVIEW_")).map(w => w.code))
          .toEqual(action === "ack" || action === "close" ? [] :
            ["REVIEW_EXIT_CONDITIONS_INCOMPLETE", "REVIEW_SCOPE_SECTION_MISSING"]);

        for (let split = 0; split <= records.length; split++) {
          const head = foldOntoCursor(initialCursor("direct"), records.slice(0, split), "direct");
          // A cloned cache cursor must retain aliases between the warning
          // list and its protected subset, including at a duplicate boundary.
          const tail = foldOntoCursor(structuredClone(head), records.slice(split), "direct");
          const { prevVersion: _v, reviewGateWarnings: _gate, ...state } = tail;
          expect(state).toEqual(cold);
          const lintHead = foldWithLint(initialCursor("direct"), records.slice(0, split), "direct", spec);
          expect(foldWithLint(structuredClone(lintHead), records.slice(split), "direct", spec)).toEqual(linted);
        }
      },
    );
  }
});

describe("revision after fail_design rework", () => {
  function record(version: number, content_type: string, payload: Partial<ContextRecord["payload"]> = {}): ContextRecord {
    return {
      version,
      task_id: "design-rework",
      role: content_type === "design" ? "architect" : content_type === "review" ? "reviewer" : "executor",
      content_type,
      timestamp: "2026-09-19T00:00:00Z",
      payload: { summary: content_type, body: "Design rework regression", ...payload },
    };
  }

  const reviewing: DerivedState = {
    status: "reviewing",
    waiting_for: "agent:reviewer",
    needs_attention: false,
    warnings: [],
  };

  it("replays the full fail_design loop through revision without warnings", () => {
    const records = [
      record(1, "design"),
      record(2, "code_changes"),
      record(3, "review", { verdict: "fail_design" }),
      record(4, "design"),
      record(5, "revision", { ref_version: 3 }),
    ];
    expect(derive("design-rework", [], "full")?.status).toBe("designing");
    expect(derive("design-rework", records.slice(0, 3), "full")?.status).toBe("designing");
    expect(derive("design-rework", records.slice(0, 4), "full")?.status).toBe("implementing");
    expect(derive("design-rework", records, "full")).toStrictEqual(reviewing);
  });

  it("accepts full implementing revision without fail_design history or ref_version", () => {
    expect(derive("design-rework", [record(1, "design"), record(2, "revision")], "full"))
      .toStrictEqual(reviewing);
    expect(foldOntoCursor({ status: "implementing", prevVersion: 0, warnings: [] }, [record(1, "revision")], "full"))
      .toStrictEqual({ ...reviewing, prevVersion: 1 });
  });

  it("keeps direct implementing revision out of table", () => {
    expect(derive("design-rework", [record(1, "revision")], "direct")).toStrictEqual({
      status: "implementing",
      waiting_for: "human",
      needs_attention: true,
      warnings: [{ version: 1, code: "OUT_OF_TABLE" }],
    });
  });

  it.each(["designing", "reviewing", "pending_approval", "approved"] as const)(
    "keeps full revision out of table in %s (only revising and implementing accept it)", (status) => {
      expect(foldOntoCursor({ status, prevVersion: 0, warnings: [] }, [record(1, "revision")], "full"))
        .toStrictEqual({ status, prevVersion: 1, waiting_for: "human", needs_attention: true,
          warnings: [{ version: 1, code: "OUT_OF_TABLE" }] });
    },
  );

  it.each(["designing", "implementing", "reviewing", "revising", "pending_approval", "approved"] as const)(
    "keeps solo revision out of table in %s", (status) => {
      expect(foldOntoCursor({ status, prevVersion: 0, warnings: [] }, [record(1, "revision")], "solo"))
        .toStrictEqual({ status, prevVersion: 1, waiting_for: "human", needs_attention: true,
          warnings: [{ version: 1, code: "OUT_OF_TABLE" }] });
    },
  );

  it("preserves closed absorption for solo revision", () => {
    expect(foldOntoCursor({ status: "closed", prevVersion: 0, warnings: [] }, [record(1, "revision")], "solo"))
      .toStrictEqual({ status: "closed", prevVersion: 1, waiting_for: "human", needs_attention: true,
        warnings: [{ version: 1, code: "CLOSED_ABSORB" }] });
  });
});

describe("foldOntoCursor: incremental fold", () => {
  // foldOntoCursor is the store's cache-carrying fold — its contract is
  // EXACT equivalence with folding the whole sequence at once, at every
  // split point, under every flow. Proven two ways: all golden vectors at
  // every split, and randomized sequences over the full content-type /
  // payload-field alphabet (deterministic seed — reproducible failures).
  it("every golden vector, every split point: fold(prefix) + foldOntoCursor(rest) === derive(all)", () => {
    for (const vector of vectors) {
      if (vector.expected === null) continue;
      const ordered = [...vector.records].sort((a, b) => a.version - b.version);
      for (let split = 0; split <= ordered.length; split++) {
        const whole = derive(vector.task_id, ordered, vector.flow);
        const cursor = initialCursor(vector.flow ?? "full");
        const head = foldOntoCursor(cursor, ordered.slice(0, split), vector.flow ?? "full");
        const { prevVersion: _p, reviewGateWarnings: _headGate, ...headState } = head;
        expect(headState).toStrictEqual(derive(vector.task_id, ordered.slice(0, split), vector.flow));
        const tail = foldOntoCursor(
          head,
          ordered.slice(split),
          vector.flow ?? "full",
        );
        const { prevVersion: _q, reviewGateWarnings: _tailGate, ...tailState } = tail;
        expect(tailState).toStrictEqual(whole);
      }
    }
  });

  it("randomized sequences: every split point agrees with derive (deterministic seed)", () => {
    let seed = 0x2a2a2a2a;
    const rand = (): number => {
      // xorshift32 — deterministic, no deps
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 2 ** 32;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const contentTypes = ["design", "code_changes", "review", "revision", "decision", "note", "mystery"] as const;
    const flows: Flow[] = ["full", "direct", "solo"];
    const decisions = ["approve", "reject", "close"] as const;
    const verdicts = ["pass", "fail_code", "fail_design", "blocked_external", "nonsense"] as const;

    for (let trial = 0; trial < 200; trial++) {
      const flow = pick(flows);
      const length = 1 + Math.floor(rand() * 12);
      // Versions: mostly contiguous, sometimes gapped/duplicated (structural
      // anomaly warnings must survive the split too).
      const records: ContextRecord[] = [];
      let version = 0;
      for (let i = 0; i < length; i++) {
        const jump = rand();
        if (jump < 0.08) version += 2; // gap
        else if (jump < 0.14) version += 0; // duplicate
        else version += 1;
        const content_type = pick(contentTypes);
        records.push({
          version,
          task_id: "prop-task",
          role: pick(["architect", "executor", "reviewer", "human"]),
          content_type,
          timestamp: "2026-09-02T00:00:00.000Z",
          // The randomized domain deliberately includes out-of-vocabulary
          // verdicts (INVALID_VERDICT must survive a split) — wider than the
          // typed write-side vocabulary on purpose.
          payload: {
            summary: "s",
            body: "b",
            ...(content_type === "decision" ? { decision: pick(decisions) } : {}),
            ...(content_type === "review" ? { verdict: pick(verdicts) } : {}),
            ...(content_type === "note" && rand() < 0.2 ? { ack: true } : {}),
          } as ContextRecord["payload"],
        });
      }
      const ordered = [...records].sort((a, b) => a.version - b.version);
      const whole = derive("prop-task", ordered, flow);
      const split = Math.floor(rand() * (ordered.length + 1));
      const head = foldOntoCursor(initialCursor(flow), ordered.slice(0, split), flow);
      const tail = foldOntoCursor(head, ordered.slice(split), flow);
      const { prevVersion: _drop, reviewGateWarnings: _tailGate, ...tailState } = tail;
      expect(tailState).toStrictEqual(whole);
    }
  });

  it("foldOntoCursor never mutates the incoming cursor (cached cursors are shared)", () => {
    const cursor = initialCursor("full");
    cursor.warnings.push({ version: 1, code: "OUT_OF_TABLE" });
    const warningsBefore = [...cursor.warnings];
    const out = foldOntoCursor(cursor, [], "full");
    expect(out.warnings).toStrictEqual(warningsBefore);
    expect(out.warnings).not.toBe(cursor.warnings);
    expect(cursor.warnings).toStrictEqual(warningsBefore);
  });
});

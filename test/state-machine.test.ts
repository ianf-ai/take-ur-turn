import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { derive } from "../src/state-machine.js";
import type { ContextRecord, DerivedState, Flow } from "../src/types.js";

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
        content_type: "review",
        timestamp: "2026-08-15T09:01:00Z",
        payload: { summary: "early review", verdict: "pass", body: "out of sequence" },
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

  it("solo keeps an architect code_changes record out of table while designing", () => {
    // Regression case from an observed solo validation run: the launch note
    // leaves a new solo task in designing, so an architect's direct delivery
    // cannot skip the design-to-implementing transition.
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
      status: "designing",
      waiting_for: "human",
      needs_attention: true,
      warnings: [{ version: 2, code: "OUT_OF_TABLE" }],
    } satisfies DerivedState);
  });
});

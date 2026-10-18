import { describe, expect, it } from "vitest";
import { foldWithLint } from "../src/hub/record-lint.js";
import { derive, initialCursor } from "../src/hub/state-machine.js";
import type { ContextRecord, Flow } from "../src/common/types.js";

function record(version: number, content_type: string, payload: Partial<ContextRecord["payload"]> = {}): ContextRecord {
  return { version, task_id: "awareness", content_type, role: "human",
    timestamp: new Date(version * 1000).toISOString(), payload: { summary: "test", body: "test", ...payload } };
}

describe("state awareness projections", () => {
  it("reports unknown approval time without inventing a timestamp, including resumed cursors", () => {
    const delivery = record(1, "code_changes");
    const approval = { ...record(2, "review", { verdict: "pass" }), timestamp: "not-a-date" };
    const pending = foldWithLint(initialCursor("direct"), [delivery, approval], "direct");
    expect(pending).toMatchObject({ pending_since: "unknown", round_count: 1 });
    expect(foldWithLint(pending, [record(3, "note")], "direct").pending_since).toBe("unknown");
    expect(foldWithLint({ status: "pending_approval", prevVersion: 2, warnings: [] },
      [record(3, "note")], "direct").pending_since).toBe("unknown");
  });

  it.each<Flow>(["full", "direct", "solo"])("counts valid deliveries and keeps the actual approval entry time (%s)", flow => {
    let version = 0;
    const records: ContextRecord[] = [];
    const add = (kind: string, payload?: Partial<ContextRecord["payload"]>) => records.push(record(++version, kind, payload));
    const fold = () => foldWithLint(initialCursor(flow), records, flow);
    if (flow !== "direct") add("design");
    expect(fold()).toMatchObject({ round_count: 0, pending_since: null });
    add("code_changes");
    if (flow !== "solo") add("review", { verdict: "pass" });
    const entered = records.at(-1)!.timestamp;
    expect(fold()).toMatchObject({ round_count: 1, pending_since: entered });
    add("note");
    add("note", { ack: true });
    add("code_changes"); // out of table: not another delivery round
    expect(fold()).toMatchObject({ round_count: 1, pending_since: entered });
    add("decision", { decision: "reject" });
    expect(fold().pending_since).toBeNull();
    add(flow === "solo" ? "code_changes" : "revision");
    if (flow !== "solo") add("review", { verdict: "blocked_external" });
    expect(fold()).toMatchObject({ round_count: 2, pending_since: records.at(-1)!.timestamp });
    for (let split = 0; split <= records.length; split++) {
      const head = foldWithLint(initialCursor(flow), records.slice(0, split), flow);
      expect(foldWithLint(head, records.slice(split), flow)).toEqual(fold());
    }
  });

  it("close retires preceding fold/lint warnings without mutating records; later anomalies still have version pointers", () => {
    const records = [record(1, "review", { verdict: "pass" }), record(2, "note")];
    records[1]!.role = "Executor";
    const prior = foldWithLint(initialCursor("full"), records, "full");
    expect(prior.warnings.map(w => w.version)).toEqual([1, 2]);
    const close = record(3, "decision", { decision: "close" });
    const original = structuredClone(records);
    const retired = foldWithLint(prior, [close], "full");
    expect(retired).toMatchObject({ status: "closed", waiting_for: "none", needs_attention: false, warnings: [] });
    expect(foldWithLint(initialCursor("full"), [...records, close], "full")).toEqual(retired);
    expect(derive("awareness", [...records, close])).toMatchObject({ needs_attention: false, warnings: [] });
    expect(records).toEqual(original);
    expect(foldWithLint(retired, [record(4, "code_changes")], "full").warnings)
      .toEqual([{ version: 4, code: "CLOSED_ABSORB" }]);
  });
});

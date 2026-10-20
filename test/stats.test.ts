import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { collectStats } from "../src/stats.js";
import { Store } from "../src/hub/store.js";
import { main, parseArgs } from "../src/cli.js";
import type { Flow, Payload } from "../src/common/types.js";

let tmp: string, root: string, store: Store;
beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-stats-"));
  root = path.join(tmp, ".context-hub");
  store = new Store(root);
  await store.whenSwept;
});
afterEach(() => { vi.restoreAllMocks(); rmSync(tmp, { recursive: true, force: true }); });
const payload = (extra: Partial<Payload> = {}): Payload => ({ summary: "test", body: "test", ...extra });
async function task(title: string, flow: Flow = "direct") {
  return (await store.createTask({ title, description: "stats integration fixture", creator: "test", role: "human", flow })).task_id;
}
async function append(id: string, role: string, type: string, extra: Partial<Payload> = {}) {
  return store.append(id, { role, content_type: type, payload: payload(extra) });
}
async function delivery(id: string, role: string, type: string, agent = "codex", extra: Partial<Payload> = {}) {
  const base_version = (await store.readTask(id)).versions.at(-1)?.version ?? 0;
  const launch = await append(id, "human", "note", { launch: { role, base_version, route: { agent, args: [] } } });
  const done = await append(id, role, type, extra);
  const ts = (await store.readTask(id)).versions.find(v => v.version === done.version)!.timestamp;
  return { launch: launch.version, version: done.version, agent, role, ts };
}
type Delivery = Awaited<ReturnType<typeof delivery>>;
function usage(id: string, deliveries: Delivery[], unresolved: Array<{ delivery_version: number; reason: string; preserved?: boolean }> = []) {
  const rounds = deliveries.map((d, i) => ({ round: i + 1, agent: d.agent, role: d.role,
    launch_version: d.launch, delivery_version: d.version, input_tokens: 40 + i, output_tokens: 10, total_tokens: 50 + i,
    cost_usd: d.agent === "codex" ? null : 0.25, ts: d.ts, window_start: d.ts, window_end: d.ts,
    session_file: path.join(tmp, `session-${i}.jsonl`), start_line: 1, end_line: 2 }));
  const value = { schema_version: 1, rounds, unresolved, total: { rounds: rounds.length,
    total_tokens: rounds.reduce((n, r) => n + r.total_tokens, 0),
    cost_usd: rounds.some(r => r.cost_usd === null) ? null : rounds.reduce((n, r) => n + r.cost_usd!, 0), complete: !unresolved.length } };
  writeFileSync(path.join(root, "tasks", id, "usage.json"), JSON.stringify(value));
  return value;
}

/** Exercise the frozen producer validator in native ESM, independently of the stats reader. */
function validateWithProducer(value: unknown): void {
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { readFileSync } from 'node:fs';
    const { validateUsage } = await import(process.argv[1]);
    validateUsage(JSON.parse(readFileSync(0, 'utf8')));
  `, new URL("../scripts/usage-audit/lib/audit.mjs", import.meta.url).href],
  { input: JSON.stringify(value), stdio: ["pipe", "pipe", "pipe"] });
}
function fingerprint(dir: string): unknown {
  return readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name), stat = lstatSync(file);
    return [name, stat.mtimeMs, stat.isDirectory() ? fingerprint(file) : readFileSync(file, "utf8")];
  });
}

describe("local read-only stats", () => {
  it("distinguishes first pass, later pass, blocked verification, solo rework, and current blockers", async () => {
    await append("project", "human", "note");
    const revised = await task("revised");
    await delivery(revised, "executor", "code_changes");
    await delivery(revised, "reviewer", "review", "codex", { verdict: "fail_code" });
    await delivery(revised, "executor", "revision");
    await delivery(revised, "reviewer", "review", "codex", { verdict: "pass" });
    await append(revised, "human", "decision", { decision: "approve" });
    await append(revised, "human", "decision", { decision: "close" });
    // Neither a late pass nor a direct reference design is a delivery.
    await append(revised, "reviewer", "review", { verdict: "pass" });
    const external = await task("external");
    await append(external, "architect", "design");
    await delivery(external, "executor", "code_changes");
    await delivery(external, "reviewer", "review", "pi", { verdict: "blocked_external" });
    const first = await task("first");
    await delivery(first, "executor", "code_changes");
    await delivery(first, "reviewer", "review", "pi", { verdict: "pass" });
    const solo = await task("solo", "solo");
    // Solo design is a reference record, not an architect workflow delivery.
    await delivery(solo, "architect", "design");
    await delivery(solo, "executor", "code_changes");
    await append(solo, "human", "decision", { decision: "reject" });
    await delivery(solo, "executor", "code_changes");
    const report = await collectStats(root);
    expect(report.batch.task_count).toBe(4);
    expect(report.batch.reviews).toEqual({ pass: 2, blocked_external: 1, fail_code: 1, fail_design: 0 });
    expect(report.batch.review_pass_rate).toBe(0.5);
    expect(report.batch.first_review_pass_rate).toBeCloseTo(1 / 3);
    expect(report.batch.revision_rounds).toBe(2);
    expect(report.batch.per_role).toEqual({ executor: 6, reviewer: 4 });
    expect(report.batch.blockers).toEqual({ "pending_approval:human": 3 });
    expect(report.batch.usage).toMatchObject({ complete: false, coverage: { missing: 4 } });
    expect(report.tasks.find(t => t.task_id === solo)?.review_pass_rate).toBeNull();
    expect((await collectStats(root, [first, solo])).batch.first_review_pass_rate).toBe(1);
  });

  it("uses the full fail_design revision loop and excludes out-of-table direct/solo reviews", async () => {
    const full = await task("full", "full");
    await append(full, "architect", "design");
    await append(full, "executor", "code_changes");
    await append(full, "reviewer", "review", { verdict: "fail_design" });
    await append(full, "architect", "design");
    await append(full, "executor", "revision");
    const direct = await task("direct");
    await append(direct, "executor", "code_changes");
    await append(direct, "reviewer", "review", { verdict: "fail_design" });
    const solo = await task("solo", "solo");
    await append(solo, "architect", "design");
    await append(solo, "executor", "code_changes");
    await append(solo, "reviewer", "review", { verdict: "pass" });
    const report = await collectStats(root);
    expect(report.batch.reviews.fail_design).toBe(1);
    expect(report.batch.review_count).toBe(1);
    expect(report.batch.revision_rounds).toBe(1);
    expect(report.batch.blockers).toEqual({ "reviewing:agent:reviewer": 1, needs_attention: 2 });
    expect(report.tasks.find(t => t.task_id === full)?.per_role.architect).toBe(2);
  });

  it("keeps native agents separate, preserves null cost, and reports stale/preserved coverage", async () => {
    const id = await task("measured");
    const executor = await delivery(id, "executor", "code_changes", "pi");
    const reviewer = await delivery(id, "reviewer", "review", "codex", { verdict: "fail_code" });
    validateWithProducer(usage(id, [executor, reviewer]));
    let report = await collectStats(root);
    expect(report.batch.usage.by_agent).toEqual({
      pi: { rounds: 1, input_tokens: 40, output_tokens: 10, total_tokens: 50, cost_usd: 0.25 },
      codex: { rounds: 1, input_tokens: 41, output_tokens: 10, total_tokens: 51, cost_usd: null },
    });
    expect(report.tasks[0]?.usage.status).toBe("complete");
    await delivery(id, "executor", "revision", "pi");
    report = await collectStats(root);
    expect(report.tasks[0]?.usage.status).toBe("incomplete");
    usage(id, [executor, reviewer], [{ delivery_version: reviewer.version, reason: "missing_session_or_end", preserved: true }]);
    report = await collectStats(root);
    expect(report.tasks[0]?.usage).toMatchObject({ status: "incomplete", unresolved: 1 });
    expect(report.tasks[0]?.usage.by_agent.codex?.cost_usd).toBeNull();
  });

  it("retains producer-measured direct reference designs without adding a quality delivery", async () => {
    const id = await task("reference-design");
    await delivery(id, "architect", "design");
    await delivery(id, "executor", "code_changes");
    await delivery(id, "reviewer", "review", "codex", { verdict: "pass" });
    const history = await store.readTask(id);
    // Generate the sidecar with the actual audit extractor/merger, including its full native source shape.
    const sidecar = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      const { extract } = await import(process.argv[1]);
      const { merge, validateUsage } = await import(process.argv[2]);
      const task = JSON.parse(readFileSync(0, 'utf8'));
      const matches = extract(task, process.argv[3]).map(round => ({ round, candidates: [{
        input_tokens: 40, output_tokens: 10, total_tokens: 50, cost_usd: null,
        session_file: process.argv[3] + '/native.jsonl', window_start: round.ts, window_end: round.ts,
        start_line: 1, end_line: 2
      }] }));
      process.stdout.write(JSON.stringify(validateUsage(merge(null, matches))));
    `, new URL("../scripts/usage-audit/lib/rounds.mjs", import.meta.url).href,
    new URL("../scripts/usage-audit/lib/audit.mjs", import.meta.url).href, tmp],
    { input: JSON.stringify(history) }).toString();
    writeFileSync(path.join(root, "tasks", id, "usage.json"), sidecar);
    const before = fingerprint(root);
    const report = await collectStats(root);
    expect(report.tasks[0]?.usage).toMatchObject({ status: "complete", by_agent: { codex: { rounds: 3, total_tokens: 150 } } });
    expect(report.batch.usage).toMatchObject({ complete: true, coverage: { invalid: 0 }, by_agent: { codex: { rounds: 3, total_tokens: 150 } } });
    expect(report.tasks[0]?.review_count).toBe(1);
    expect(report.tasks[0]?.per_role).toEqual({ executor: 1, reviewer: 1 });
    expect(report.batch.review_count).toBe(1);
    expect(report.batch.per_role).toEqual({ executor: 1, reviewer: 1 });
    expect((await store.snapshotTasks()).tasks[0]?.needs_attention).toBe(false);
    expect(fingerprint(root)).toEqual(before);
  });

  it.each([
    "missing-session", "relative-session", "missing-start", "missing-end", "zero-start", "fractional-line", "reversed-lines", "equal-lines",
    "missing-round", "zero-round", "fractional-round", "missing-window", "missing-ts", "missing-window-end", "invalid-time", "non-string-time",
    "inverted-window", "delivery-before-window", "delivery-after-window",
  ])("rejects v1 source/window damage: %s", async kind => {
    const id = await task("damaged-source");
    const done = await delivery(id, "executor", "code_changes");
    const value = usage(id, [done]);
    validateWithProducer(value);
    const round = value.rounds[0]! as Record<string, unknown>;
    if (kind === "missing-session") delete round.session_file;
    if (kind === "relative-session") round.session_file = "relative.jsonl";
    if (kind === "missing-start") delete round.start_line;
    if (kind === "missing-end") delete round.end_line;
    if (kind === "zero-start") round.start_line = 0;
    if (kind === "fractional-line") round.end_line = 2.5;
    if (kind === "reversed-lines") { round.start_line = 3; round.end_line = 2; }
    if (kind === "equal-lines") round.end_line = round.start_line;
    if (kind === "missing-round") delete round.round;
    if (kind === "zero-round") round.round = 0;
    if (kind === "fractional-round") round.round = 1.5;
    if (kind === "missing-window") delete round.window_start;
    if (kind === "missing-ts") delete round.ts;
    if (kind === "missing-window-end") delete round.window_end;
    if (kind === "invalid-time") round.window_start = "invalid date";
    if (kind === "non-string-time") round.window_start = 0;
    if (kind === "inverted-window") { round.window_start = "2026-11-01T00:00:00Z"; round.window_end = "2026-01-01T00:00:00Z"; }
    if (kind === "delivery-before-window") round.window_start = new Date(Date.parse(done.ts) + 1).toISOString();
    if (kind === "delivery-after-window") round.window_end = new Date(Date.parse(done.ts) - 1).toISOString();
    expect(() => validateWithProducer(value)).toThrow();
    writeFileSync(path.join(root, "tasks", id, "usage.json"), JSON.stringify(value));
    const report = await collectStats(root);
    expect(report.tasks[0]?.usage).toMatchObject({ status: "invalid", by_agent: {} });
    expect(report.batch.usage).toMatchObject({ complete: false, coverage: { invalid: 1 }, by_agent: {} });
  });

  it.each(["json", "total", "negative", "duplicate", "attribution", "agent", "wrong-agent", "symlink"])("discloses invalid %s sidecars without manufacturing zero measurements", async kind => {
    const id = await task("invalid");
    const done = await delivery(id, "executor", "code_changes");
    const value = usage(id, [done]);
    const file = path.join(root, "tasks", id, "usage.json");
    if (kind === "json") writeFileSync(file, "{bad");
    else if (kind === "symlink") {
      const target = path.join(tmp, "sidecar");
      writeFileSync(target, JSON.stringify(value)); rmSync(file); symlinkSync(target, file);
    } else {
      if (kind === "total") value.total.total_tokens++;
      if (kind === "negative") value.rounds[0]!.input_tokens = -1;
      if (kind === "duplicate") value.rounds.push(value.rounds[0]!);
      if (kind === "attribution") value.rounds[0]!.delivery_version = done.launch;
      if (kind === "agent") value.rounds[0]!.agent = "unknown";
      if (kind === "wrong-agent") value.rounds[0]!.agent = "pi";
      writeFileSync(file, JSON.stringify(value));
    }
    const report = await collectStats(root);
    expect(report.tasks[0]?.usage).toMatchObject({ status: "invalid", by_agent: {} });
    expect(report.batch.usage.coverage.invalid).toBe(1);
    expect(report.batch.usage.complete).toBe(false);
  });

  it("reports degraded tasks, rejects unknown selection, and excludes project scope", async () => {
    const id = await task("broken");
    writeFileSync(path.join(root, "tasks", id, "meta.json"), "{broken");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const report = await collectStats(root);
    expect(report.batch).toMatchObject({ task_count: 0, degraded: [id], review_pass_rate: null, usage: { complete: false } });
    await expect(collectStats(root, ["unknown"])).rejects.toThrow("task not found");
    await expect(collectStats(root, ["project"])).rejects.toThrow("task not found");
  });

  it("does zero writes, including no startup temp sweeping, and no directory creation", async () => {
    const id = await task("readonly");
    const done = await delivery(id, "executor", "code_changes");
    usage(id, [done]);
    const residue = path.join(root, "tasks", id, "meta.json.999999999.tmp");
    writeFileSync(residue, "old temp");
    utimesSync(residue, new Date(0), new Date(0));
    const before = fingerprint(root);
    await collectStats(root); await collectStats(root, [id]);
    expect(fingerprint(root)).toEqual(before);
    const reader = new Store(root, { readOnly: true });
    await expect(reader.append(id, { role: "human", content_type: "note", payload: payload() })).rejects.toThrow("read-only");
    await expect(reader.createTask({ title: "no", description: "no", role: "human", creator: "test" })).rejects.toThrow("read-only");
    expect(fingerprint(root)).toEqual(before);
    const absent = path.join(tmp, "absent");
    expect((await collectStats(absent)).batch.task_count).toBe(0);
    expect(existsSync(absent)).toBe(false);
  });

  it("wires CLI selection/text/json offline and validates flags", async () => {
    const id = await task("cli");
    expect(parseArgs(["stats", id, "--root=" + root, "--json"])).toEqual({ command: "stats", tasks: [id], root, json: true });
    expect(parseArgs(["stats", "--url", "unused"]).command).toBe("usage");
    expect(parseArgs(["stats", "--json=true"]).command).toBe("usage");
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await main(["stats", id, "--root", root, "--json"])).toBe(0);
    expect(JSON.parse(output).batch.task_count).toBe(1);
    output = "";
    expect(await main(["stats", "--root", root])).toBe(0);
    expect(output).toContain("Batch: 1 tasks; review pass n/a");
    expect(output).toContain("Tokens by agent");
    expect(await main(["stats", "missing", "--root", root])).toBe(1);
    expect(network).not.toHaveBeenCalled();
  });
});

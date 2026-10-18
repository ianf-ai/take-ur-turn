import { Store, type ReadTaskResult, type TaskListEntry } from "./hub/store.js";
import { foldOntoCursor, initialCursor } from "./hub/state-machine.js";
import { validateAgentRoute } from "./common/agent-command.js";
import path from "node:path";
import type { ContextRecord } from "./common/types.js";

const VERDICTS = ["pass", "blocked_external", "fail_code", "fail_design"] as const;
type Verdict = typeof VERDICTS[number];
type Counts = Record<string, number>;
interface Tokens { rounds: number; input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number | null }
interface Usage { status: "missing" | "invalid" | "complete" | "incomplete"; by_agent: Record<string, Tokens>; unresolved: number; error?: string }
const counts = (): Counts => Object.create(null) as Counts;
const increment = (obj: Counts, key: string, amount = 1): void => { obj[key] = (obj[key] ?? 0) + amount; };
const rate = (passed: number, total: number): number | null => total ? passed / total : null;
function safeAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new Error("token aggregate overflow");
  return sum;
}
function addTokens(target: Record<string, Tokens>, agent: string, source: Tokens): void {
  const old = target[agent] ?? { rounds: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 };
  const cost = old.cost_usd === null || source.cost_usd === null ? null : old.cost_usd + source.cost_usd;
  if (cost !== null && !Number.isFinite(cost)) throw new Error("cost aggregate overflow");
  target[agent] = { rounds: safeAdd(old.rounds, source.rounds), input_tokens: safeAdd(old.input_tokens, source.input_tokens),
    output_tokens: safeAdd(old.output_tokens, source.output_tokens), total_tokens: safeAdd(old.total_tokens, source.total_tokens), cost_usd: cost };
}

/** Usage audit measures worker deliveries independently of workflow transitions. */
function isUsageDelivery(record: ContextRecord): boolean {
  return (record.role === "architect" && record.content_type === "design") ||
    (record.role === "executor" && ["code_changes", "revision"].includes(record.content_type)) ||
    (record.role === "reviewer" && record.content_type === "review");
}

/** Quality metrics count workflow advances; usage coverage follows the audit delivery contract. */
export function taskMetrics(task: ReadTaskResult, entry: TaskListEntry) {
  const flow = task.flow ?? "full";
  let cursor = initialCursor(flow);
  const reviews = { pass: 0, blocked_external: 0, fail_code: 0, fail_design: 0 };
  const per_role = counts();
  const usageDeliveries = new Set<number>();
  let first_review: Verdict | null = null;
  let revision_rounds = 0, codeDeliveries = 0;
  for (const record of [...task.versions].sort((a, b) => a.version - b.version)) {
    if (isUsageDelivery(record)) usageDeliveries.add(record.version);
    const before = cursor.status;
    cursor = foldOntoCursor(cursor, [record], flow);
    if (cursor.status === before) continue;
    if (record.content_type === "review") {
      const verdict = record.payload.verdict as Verdict;
      if (!VERDICTS.includes(verdict)) continue;
      reviews[verdict]++;
      first_review ??= verdict;
    }
    if (["design", "code_changes", "revision", "review"].includes(record.content_type)) {
      increment(per_role, record.role);
    }
    if (record.content_type === "revision") revision_rounds++;
    if (record.content_type === "code_changes" && ++codeDeliveries > 1 && flow === "solo") revision_rounds++;
  }
  const reviewCount = Object.values(reviews).reduce((a, b) => a + b, 0);
  return { task_id: task.task_id, title: task.title, flow, status: task.status, waiting_for: entry.waiting_for,
    needs_attention: entry.needs_attention === true, reviews, review_count: reviewCount,
    review_pass_rate: rate(reviews.pass, reviewCount), first_review, revision_rounds, per_role,
    // Internal audit delivery set, omitted from output; independent of per_role eligibility.
    usageDeliveries };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid usage object");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid usage counter");
  return value;
}

function instant(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("invalid usage timestamp");
  return Date.parse(value);
}

/** Frozen v1 source/window constraints from usage-audit's validateUsage; no producer schema change. */
function validateUsageSource(round: Record<string, unknown>): void {
  if (integer(round.round) < 1 || typeof round.session_file !== "string" || !path.isAbsolute(round.session_file) ||
    integer(round.start_line) < 1 || integer(round.end_line) <= (round.start_line as number)) {
    throw new Error("invalid usage source/line range");
  }
  const start = instant(round.window_start), ts = instant(round.ts), end = instant(round.window_end);
  if (start > ts || ts > end) throw new Error("invalid usage window");
}

/** Recompute totals, verify references, and keep missing measurements distinct from zero. */
function usageMetrics(raw: unknown, task: ReadTaskResult, deliveries: Set<number>): Usage {
  if (raw === null) return { status: "missing", by_agent: {}, unresolved: 0 };
  const usage = object(raw);
  if (usage.schema_version !== 1 || !Array.isArray(usage.rounds) || !Array.isArray(usage.unresolved)) throw new Error("invalid usage schema");
  const by_agent: Record<string, Tokens> = {};
  const launches = new Set<number>(), measured = new Set<number>();
  let total = 0, totalCost: number | null = 0;
  for (const item of usage.rounds) {
    const r = object(item);
    validateUsageSource(r);
    const launch = integer(r.launch_version), delivery = integer(r.delivery_version);
    const record = task.versions.find(v => v.version === delivery);
    const launchRecord = task.versions.find(v => v.version === launch);
    if (launch < 1 || delivery <= launch || launches.has(launch) || measured.has(delivery) || !deliveries.has(delivery) ||
      !launchRecord || launchRecord.payload.launch === undefined || r.role !== record?.role ||
      (r.agent !== "codex" && r.agent !== "pi")) throw new Error("invalid usage attribution");
    const marker = object(launchRecord.payload.launch);
    const route = marker.route === undefined ? record?.agent : validateAgentRoute(marker.route);
    const agent = typeof route === "string" ? route : route?.agent;
    if (marker.role !== r.role || agent !== r.agent) throw new Error("usage launch role/agent mismatch");
    launches.add(launch); measured.add(delivery);
    const input = integer(r.input_tokens), output = integer(r.output_tokens), tokens = integer(r.total_tokens);
    if (safeAdd(input, output) !== tokens) throw new Error("invalid usage token total");
    const cost = r.cost_usd;
    if (!(cost === null || typeof cost === "number" && Number.isFinite(cost) && cost >= 0)) throw new Error("invalid usage cost");
    addTokens(by_agent, r.agent, { rounds: 1, input_tokens: input, output_tokens: output, total_tokens: tokens, cost_usd: cost });
    total = safeAdd(total, tokens);
    totalCost = totalCost === null || cost === null ? null : totalCost + cost;
  }
  for (const u of usage.unresolved) {
    const item = object(u);
    if (integer(item.delivery_version) < 1 || typeof item.reason !== "string") throw new Error("invalid unresolved usage");
  }
  const declared = object(usage.total);
  if (declared.rounds !== usage.rounds.length || declared.total_tokens !== total || declared.cost_usd !== totalCost ||
    declared.complete !== (usage.unresolved.length === 0)) throw new Error("invalid usage totals");
  const complete = usage.unresolved.length === 0 && [...deliveries].every(v => measured.has(v));
  return { status: complete ? "complete" : "incomplete", by_agent, unresolved: usage.unresolved.length };
}

/** Store's read-only constructor skips startup sweeping; all IO remains behind Store. */
export async function collectStats(root: string, selected: readonly string[] = []) {
  const store = new Store(root, { readOnly: true });
  const snapshot = await store.snapshotTasks();
  const entries = snapshot.tasks.filter(t => t.scope !== "project" && (!selected.length || selected.includes(t.task_id)));
  const degraded = snapshot.degraded.filter(id => id !== "project" && (!selected.length || selected.includes(id)));
  for (const id of selected) {
    if (!entries.some(t => t.task_id === id) && !degraded.includes(id)) throw new Error(`task not found: ${id}`);
  }
  const tasks = [];
  for (const entry of entries) {
    const task = await store.readTask(entry.task_id);
    const { usageDeliveries, ...metrics } = taskMetrics(task, entry);
    let usage: Usage;
    try { usage = usageMetrics(await store.readUsage(entry.task_id), task, usageDeliveries); }
    catch (error) { usage = { status: "invalid", by_agent: {}, unresolved: 0, error: (error as Error).message }; }
    tasks.push({ ...metrics, usage });
  }
  const reviews = { pass: 0, blocked_external: 0, fail_code: 0, fail_design: 0 };
  const per_role = counts(), blockers = counts(), statuses = counts(), by_agent: Record<string, Tokens> = {};
  const usage_coverage = { complete: 0, incomplete: 0, missing: 0, invalid: 0 };
  let revision_rounds = 0, reviewedTasks = 0, firstPass = 0;
  for (const task of tasks) {
    for (const verdict of VERDICTS) reviews[verdict] += task.reviews[verdict];
    for (const [role, amount] of Object.entries(task.per_role)) increment(per_role, role, amount);
    for (const [agent, tokens] of Object.entries(task.usage.by_agent)) addTokens(by_agent, agent, tokens);
    increment(statuses, task.status ?? "unknown");
    if (task.status !== "closed") increment(blockers, task.needs_attention ? "needs_attention" : `${task.status}:${task.waiting_for}`);
    revision_rounds += task.revision_rounds;
    if (task.first_review !== null) reviewedTasks++;
    if (task.first_review === "pass") firstPass++;
    usage_coverage[task.usage.status]++;
  }
  const review_count = Object.values(reviews).reduce((a, b) => a + b, 0);
  return { definitions: {
    review_pass_rate: "pass / all accepted reviews; blocked_external is separate and is not a verified pass; no reviews = null",
    first_review_pass_rate: "tasks whose first accepted review is pass / tasks with an accepted review; solo tasks excluded",
    revision_rounds: "accepted revision deliveries plus subsequent solo code_changes after reject",
    per_role: "accepted design/code_changes/revision/review deliveries by recorded role; reference designs and out-of-table records excluded",
    blockers: "current open-task status:waiting_for, with needs_attention separate; closed tasks excluded",
    usage: "v1-validated measured worker rounds, including reference designs independently of quality metrics, grouped by agent; pi and codex native token accounting differ; missing/incomplete/invalid are not zero usage",
    batch: "all local hub tasks unless task IDs are supplied; project scope excluded; degraded tasks listed separately; live reads are not an atomic batch snapshot",
  }, tasks, batch: { task_count: tasks.length, degraded, statuses, reviews, review_count,
    review_pass_rate: rate(reviews.pass, review_count), first_review_pass_rate: rate(firstPass, reviewedTasks),
    reviewed_tasks: reviewedTasks, revision_rounds, per_role, blockers, usage: { by_agent, coverage: usage_coverage,
      complete: degraded.length === 0 && tasks.every(t => t.usage.status === "complete") } } };
}

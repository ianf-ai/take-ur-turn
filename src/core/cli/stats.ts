import { collectStats } from "../stats.js";
import type { ParsedArgs } from "./args.js";
import { printJson } from "./shared.js";

const percent = (n: number | null): string => n === null ? "n/a" : `${(100 * n).toFixed(1)}%`;
export async function runStats(parsed: Extract<ParsedArgs, { command: "stats" }>): Promise<number> {
  try {
    const report = await collectStats(parsed.root, parsed.tasks);
    if (parsed.json) printJson(report);
    else {
      for (const task of report.tasks) {
        process.stdout.write(`${task.task_id} (${task.title}): ${task.status}; review pass ${percent(task.review_pass_rate)}; revisions ${task.revision_rounds}; waiting ${task.waiting_for}; usage ${task.usage.status}\n`);
        process.stdout.write(`  per-role ${JSON.stringify(task.per_role)}; tokens by agent ${JSON.stringify(task.usage.by_agent)}\n`);
        if (task.usage.error) process.stdout.write(`  usage error: ${task.usage.error}\n`);
      }
      const b = report.batch;
      process.stdout.write(`Batch: ${b.task_count} tasks; review pass ${percent(b.review_pass_rate)}; first-review pass ${percent(b.first_review_pass_rate)}; revisions ${b.revision_rounds}\n`);
      process.stdout.write(`Per-role: ${JSON.stringify(b.per_role)}\nBlockers: ${JSON.stringify(b.blockers)}\nTokens by agent: ${JSON.stringify(b.usage.by_agent)}\nUsage coverage: ${JSON.stringify(b.usage.coverage)}; complete=${b.usage.complete}\n`);
      if (b.degraded.length) process.stdout.write(`Degraded tasks (excluded): ${b.degraded.join(", ")}\n`);
      for (const [key, definition] of Object.entries(report.definitions)) process.stdout.write(`${key}: ${definition}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`tut: stats failed: ${(error as Error).message}\n`);
    return 1;
  }
}

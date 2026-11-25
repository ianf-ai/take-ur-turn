/** Manual fallback for detached start-next: planning, preflight, marking
 *  and execution use the same standalone backend as automatic launches. */
import path from "node:path";
import { HubError } from "../../hub/hub-client.js";
import { resolveRigRoot } from "../../hub/rig-discovery.js";
import { ensureNotifierEventUrl } from "../../core/launcher/event-endpoint.js";
import { readLaunchMode } from "../../core/common/config.js";
import { readLaunchLog } from "../../core/launcher/launch.js";
import { buildHeadlessPlan, headlessGeneration } from "./plan.js";
import { HeadlessRuntime, type HeadlessLaunchOutcome } from "./runtime.js";
import { createHeadlessRevalidate } from "../../core/notifier/launch-revalidate.js";
import type { StateResponse } from "../../core/notifier/shared-contracts.js";
import type { Cast, CheckoutRoute, ContextRecord, Flow } from "../../protocol/types.js";

/** Both launch doors use the same strict policy and shipped tui default. */
export async function headlessLaunchSelected(rigRoot = resolveRigRoot()): Promise<boolean> {
  return await readLaunchMode(path.join(rigRoot, ".context-hub")) === "detached";
}

/** Bounded /state fetch for the in-lock revalidation gate (same contract as
 *  the Notifier's default leg: every Hub call fails diagnosably, never hangs). */
async function fetchStateJson(url: string): Promise<StateResponse> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Connection: "close" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as StateResponse;
}

/** The /state entry fields the headless plan consumes (see HeadlessTask). */
export interface HeadlessStartNextTask {
  task_id: string;
  title?: string;
  version?: number;
  cast?: Cast;
  checkout?: CheckoutRoute;
  /** The task's real flow — selects the dedup round-boundary table. */
  flow?: Flow;
  description?: string;
}

export interface HeadlessStartNextInput {
  hubUrl: string;
  role: string;
  force: boolean;
  /** Request a new invocation without the prior role session identity. */
  fresh?: boolean;
  rigRoot?: string;
  task: HeadlessStartNextTask;
  explicitRoute?: { agent: string; args: string[] };
}

/** Order mirrors the tui door and the auto path: dedup → precheck (plan,
 *  including checkout preflight) → marker → spawn. Every failure before the
 *  marker leaves no trace, so a plain retry works without --force. */
export async function runStartNextHeadless(input: HeadlessStartNextInput): Promise<number> {
  const { hubUrl, role, task } = input;
  const taskId = task.task_id;
  const rigRoot = input.rigRoot ?? resolveRigRoot();

  const runtime = new HeadlessRuntime(rigRoot, {
    // The manual door's operator is local: runtime diagnostics go to stderr;
    // channel notifications remain the Notifier process's job.
    log: (line) => process.stderr.write(`tut: ${line}\n`),
    send: async () => {},
    read: (id) => readLaunchLog(hubUrl, id),
    hubUrl,
    // The same production staleness gate the Notifier wires for auto launches.
    // URL-join through new URL so a trailing-slash --url cannot become //state.
    revalidate: createHeadlessRevalidate({
      stateUrl: new URL("/state", hubUrl).href,
      fetchState: fetchStateJson,
      readLog: (id) => readLaunchLog(hubUrl, id),
    }),
  });

  let records: ContextRecord[];
  try {
    records = await readLaunchLog(hubUrl, taskId);
  } catch (e) {
    process.stderr.write(`tut: cannot read the task log for ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }

  const completedWithoutDelivery = runtime.recoverableLaunches(taskId, records);
  const generation = headlessGeneration(records, role, 0, task.flow, completedWithoutDelivery);
  if (generation.blocked && !input.force) {
    process.stderr.write(
      `tut: ALREADY_LAUNCHED: ${role} launched at v${generation.marker}, no new publish since; inspect this round and outstanding control calls before considering --force\n`,
    );
    return 1;
  }
  if (input.fresh === true) {
    process.stderr.write(`tut: note: --fresh starts a new invocation without reusing a recorded session ID\n`);
  }

  const environment = { ...process.env };
  try {
    await ensureNotifierEventUrl(environment, hubUrl, rigRoot);
  } catch (e) {
    process.stderr.write(`tut: ${(e as Error).message}\n`);
    return 1;
  }
  const eventUrl = environment.TUT_EVENT_PORT_URL!;

  let plan;
  try {
    plan = await buildHeadlessPlan({
      task: {
        task_id: taskId,
        title: task.title ?? taskId,
        ...(task.version !== undefined ? { version: task.version } : {}),
        ...(task.cast !== undefined ? { cast: task.cast } : {}),
        ...(task.checkout !== undefined ? { checkout: task.checkout } : {}),
        ...(task.flow !== undefined ? { flow: task.flow } : {}),
        ...(task.description !== undefined ? { description: task.description } : {}),
      },
      role,
      records,
      completedWithoutDelivery,
      hubRoot: rigRoot,
      hubUrl,
      eventUrl,
      runs: runtime.runs(),
      ...(input.fresh === true ? { fresh_session: true } : {}),
      ...(input.explicitRoute !== undefined ? { explicitRoute: input.explicitRoute } : {}),
    });
  } catch (e) {
    process.stderr.write(`tut: cannot plan detached launch for ${role} on ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }

  try {
    await runtime.mark(plan, "start-next");
  } catch (e) {
    const conflict = (e instanceof HubError && e.code === "VERSION_CONFLICT") || String((e as Error).message).includes("VERSION_CONFLICT");
    if (conflict) {
      // Another launcher won the optimistic append race: converge on the same
      // harmless already-launched outcome instead of reporting a false error.
      try {
        const latest = await readLaunchLog(hubUrl, taskId);
        const covered = headlessGeneration(latest, role, 0, task.flow, runtime.recoverableLaunches(taskId, latest));
        if (covered.blocked) {
          process.stderr.write(
            `tut: ALREADY_LAUNCHED: ${role} launched at v${covered.marker}, no new publish since; another launcher won the race\n`,
          );
          return 1;
        }
      } catch {
        // Keep the original marker error as the actionable failure.
      }
    }
    process.stderr.write(`tut: cannot append the detached launch marker for ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }

  if (process.env.TUT_DRY_RUN === "1") {
    process.stdout.write(
      `detached start-next DRY-RUN for ${taskId} (${role}): marker appended; would spawn in ${plan.checkoutRoot}: ${plan.argv.join(" ")}\n`,
    );
    return 0;
  }

  const outcome: HeadlessLaunchOutcome = await runtime.launchAndSettle(plan);
  if (outcome.kind === "launched") {
    process.stdout.write(
      `start-next: detached launch attempt completed; delivery confirmation is not implied (${role} for ${taskId} via detached run ${outcome.run_id}; tut attach ${outcome.run_id})\n`,
    );
    return 0;
  }
  if (outcome.kind === "skipped") {
    process.stderr.write(`tut: LAUNCH_SKIPPED: ${outcome.reason}\n`);
    return 1;
  }
  process.stderr.write(`tut: detached launch failed: ${outcome.reason}; inspect tut ps and the task context\n`);
  return 1;
}

/** Production host bindings for shared task command handling. */
import { runStartNext as startNext, runLaunch as launch, runDecide as decide } from "../../core/cli/task-handlers.js";
import { headlessLaunchSelected, runStartNextHeadless, registerPowerMember } from "../../standalone/host-entry.js";
import { runLaunchEntry, runStartNextTui, cleanupTaskPanes } from "../../herdr/host-entry.js";
import type { TaskHostPort } from "../../core/cli/host-ports.js";
import type { ParsedArgs } from "../../core/cli/args.js";
import { assertLaunchStateGate, explicitRouteFromValues } from "../../protocol/launch-policy.js";
import { hubRead } from "../../hub/hub-client.js";
import { resolveRigRoot } from "../../hub/rig-discovery.js";
import type { StateResponse } from "../../core/notifier/shared-contracts.js";
export { ensureNotifierEventUrl, runWatch, runCreate, runPublish, runRead, runList, runAck, runAssign } from "../../core/cli/task-handlers.js";

const host: TaskHostPort = {
  registerLaunch: registerPowerMember,
  launch: async entry => {
    // Serialized invocations already freeze a Herdr target. Only the legacy
    // round door selects a backend from the workspace launch policy.
    if (entry.kind !== "round" || entry.invocation !== undefined || !await headlessLaunchSelected()) {
      return runLaunchEntry(entry);
    }
    const hubUrl = process.env.TUT_HUB_URL ?? "http://127.0.0.1:3001";
    const response = await fetch(new URL("/state", hubUrl), { signal: AbortSignal.timeout(10_000), headers: { Connection: "close" } });
    if (!response.ok) throw new Error(`GET /state → HTTP ${response.status}`);
    const state = await response.json() as StateResponse;
    const task = state.tasks.find(task => task.task_id === entry.request.task_id);
    assertLaunchStateGate(entry.request, task);
    const full = await hubRead(hubUrl, entry.request.task_id);
    const route = explicitRouteFromValues(entry.request.explicit_route_values);
    return runStartNextHeadless({
      hubUrl, rigRoot: resolveRigRoot(), role: entry.request.role, force: false,
      fresh: entry.request.fresh,
      task: { ...task!, ...(full.description !== undefined ? { description: full.description } : {}) },
      ...(route !== undefined ? { explicitRoute: route } : {}),
    });
  },
  cleanupTask: cleanupTaskPanes,
  startNext: async (parsed, entry, request) => {
    const { task_id: taskId, role } = request;
    // Both doors consume the same launch_mode policy: missing means tui;
    // explicit headless uses the shared headless planner and runtime.
    try {
      if (await headlessLaunchSelected()) {
        return await runStartNextHeadless({
          hubUrl: parsed.url,
          role,
          force: parsed.force,
          ...(parsed.fresh ? { fresh: true } : {}),
          task: {
            task_id: taskId,
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            ...(entry.version !== undefined ? { version: entry.version } : {}),
            ...(entry.cast !== undefined ? { cast: entry.cast } : {}),
            ...(entry.checkout !== undefined ? { checkout: entry.checkout } : {}),
            ...(entry.flow !== undefined ? { flow: entry.flow } : {}),
          },
        });
      }
    } catch (e) {
      process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
      return 1;
    }

    return await runStartNextTui(parsed, entry, request);
  },
};

export function runStartNext(parsed: Extract<ParsedArgs, { command: "start-next" }>): Promise<number> {
  return startNext(parsed, host);
}
export function runLaunch(parsed: Extract<ParsedArgs, { command: "launch" }>): Promise<number> {
  return launch(parsed, host);
}
export function runDecide(parsed: Extract<ParsedArgs, { command: "decide" }>): Promise<number> {
  return decide(parsed, host);
}

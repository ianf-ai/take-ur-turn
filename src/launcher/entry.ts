/** Internal `tut launch` entry boundary. */

import {
  deserializeLaunchInvocation,
  requestFromLegacyArgs,
} from "./invocation.js";
import { runCompatLaunch } from "./compat.js";
import type { LaunchInvocation, LaunchRequest } from "../types.js";

export type LaunchEntry =
  | { kind: "cleanup"; task_id: string }
  | { kind: "round"; request: LaunchRequest; invocation?: LaunchInvocation };

/** Parse the internal launch command without interpreting route arguments. */
export function parseLaunchEntry(args: readonly string[]): LaunchEntry | { error: string } {
  const values = [...args];
  if (values[0] === "--cleanup") {
    if (values.length !== 2 || values[1] === undefined || values[1].length === 0) {
      return { error: "usage: tut launch --cleanup <task_id>" };
    }
    return { kind: "cleanup", task_id: values[1] };
  }
  if (values[0] === "--invocation") {
    if (values.length !== 2 || values[1] === undefined) {
      return { error: "usage: tut launch --invocation <json>" };
    }
    try {
      const invocation = deserializeLaunchInvocation(values[1]);
      return {
        kind: "round",
        request: {
          kind: "round",
          task_id: invocation.task_id,
          role: invocation.role,
          fresh: invocation.fresh,
          via: invocation.via,
        },
        invocation,
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  let fresh = false;
  if (values[0] === "--fresh") {
    fresh = true;
    values.shift();
  }
  const taskId = values.shift();
  const role = values.shift();
  if (taskId === undefined || role === undefined || taskId.length === 0 || role.length === 0) {
    return { error: "usage: tut launch [--fresh] <task_id> <role> [<agent> [<arg>...]] | tut launch --cleanup <task_id>" };
  }
  try {
    return {
      kind: "round",
      request: requestFromLegacyArgs(taskId, role, fresh, values.length > 0 ? values : undefined),
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Extract a request from a parsed entry for caller/planner tests. */
export function requestOf(entry: LaunchEntry): LaunchRequest | undefined {
  return entry.kind === "round" ? entry.request : undefined;
}

/** Execute the parsed entry.  The runner is kept behind this seam so the
 * lifecycle/birth/delivery work units can replace the compatibility runner
 * without changing the CLI process boundary. */
export async function runLaunchEntry(entry: LaunchEntry): Promise<number> {
  return await runCompatLaunch(entry);
}

/** POSIX presence validation; never substitutes which output into a plan. */
import type { Stats } from "node:fs";
import { stat as fsStatPromises } from "node:fs/promises";
import { AgentTargetError } from "./types.js";
import type { PosixTargetDeps } from "./types.js";
import { probeExecutable } from "./probe.js";

const POSIX_PRESENCE_HINT =
  "install it, or correct the task cast when creating a new task; use tut assign to change the workspace lineup (task cast takes precedence; launch refused, no default fallback)";

const POSIX_WHICH_MISSING_HINT =
  "install which (e.g. `apt-get install which` / `apk add which`), or run TUT from an environment that provides it — the PATH presence preflight needs the which binary";

/**
 * Prove the bare route agent exists on PATH.  The which output path is used
 * only for this validation — it never replaces the bare executable in an
 * invocation or PaneCommand.
 */
export async function resolvePosixTargetPresence(
  routeAgent: string,
  deps: PosixTargetDeps = {},
): Promise<{ agent: string; candidate: string }> {
  const which = deps.which ?? ((agent: string) => probeExecutable("which", [agent]));
  const stat = deps.stat ?? ((candidate: string) => fsStatPromises(candidate));

  const probe = await which(routeAgent);
  if (probe.error !== undefined) {
    if ((probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      // The which BINARY itself is missing (minimal containers), which says
      // nothing about the agent — a dedicated hint, never "install the agent".
      throw new AgentTargetError(
        routeAgent,
        "cannot be probed (which is not installed on this system)",
        POSIX_WHICH_MISSING_HINT,
      );
    }
    throw new AgentTargetError(
      routeAgent,
      `cannot be probed (which failed: ${probe.error.message})`,
      POSIX_PRESENCE_HINT,
    );
  }
  const candidate = probe.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0);
  if (probe.code !== 0 || candidate === undefined) {
    throw new AgentTargetError(
      routeAgent,
      `not on PATH (which exit ${probe.code ?? "?"}, no candidate)`,
      POSIX_PRESENCE_HINT,
    );
  }

  let entry: Stats;
  try {
    entry = await stat(candidate);
  } catch (error) {
    throw new AgentTargetError(
      routeAgent,
      `has an unusable which candidate ('${candidate}': ${(error as Error).message})`,
      POSIX_PRESENCE_HINT,
    );
  }
  if (!entry.isFile()) {
    throw new AgentTargetError(
      routeAgent,
      `has a which candidate that is not a regular file ('${candidate}')`,
      POSIX_PRESENCE_HINT,
    );
  }
  if ((entry.mode & 0o111) === 0) {
    throw new AgentTargetError(
      routeAgent,
      `has a which candidate that is not executable ('${candidate}')`,
      POSIX_PRESENCE_HINT,
    );
  }
  return { agent: routeAgent, candidate };
}

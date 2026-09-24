/**
 * Create-time worktree path advisory.
 *
 * A worktree route is frozen immutable at create and TUT never runs git, so
 * a typo in the path would silently burn the task's every round.  This is a
 * best-effort, NON-BLOCKING check: the create faces print one warning line
 * when the path does not exist yet, and the task is still created.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import type { CheckoutRoute } from "./types.js";

/**
 * One-line warning for a worktree route whose path does not exist (resolved
 * against `cwd`, defaulting to the checking process's cwd — the same base the
 * launcher uses for relative paths).  Undefined for current routes, absent
 * paths, and paths that exist.
 */
export function worktreePathWarning(
  checkout: CheckoutRoute | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  if (checkout === undefined || checkout.kind !== "worktree" || checkout.path === undefined) return undefined;
  const resolved = path.resolve(cwd, checkout.path);
  if (existsSync(resolved)) return undefined;
  return (
    `warning: worktree checkout path '${checkout.path}' does not exist yet (resolved: ${resolved}) — ` +
    "prepare it before launch; the route is frozen at create and TUT never runs git worktree add"
  );
}

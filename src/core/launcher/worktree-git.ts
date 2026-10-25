/** Git transport policy shared by task launchers and managed resumes.
 *
 * Keep the policy in the worker's environment, never in the shared repository
 * config (linked worktrees share remotes). An empty allowlist rejects every
 * transport before Git can connect or ask a credential helper, including
 * explicit push URLs and remotes added after launch. Local add/commit still
 * work. Fetch/pull are intentionally blocked too.
 *
 * This is an inherited accident guard, not a sandbox against a worker that
 * deliberately removes the variable or uses another network client.
 */
import path from "node:path";
import { realpathSync } from "node:fs";

function canonical(root: string): string {
  try { return realpathSync(root); } catch { return path.resolve(root); }
}

export function worktreeGitEnvironment(context: {
  hubRoot: string;
  checkoutRoot: string;
}): Record<string, string> {
  // An unanchored preview is not evidence of a worktree checkout.
  if (context.hubRoot.startsWith("<") || context.checkoutRoot.startsWith("<")) return {};
  return canonical(context.hubRoot) === canonical(context.checkoutRoot)
    ? {}
    : { GIT_ALLOW_PROTOCOL: "" };
}

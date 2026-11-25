/** Herdr command adaptation from a shared checkout and environment. */
import type { ExecutionContext } from "../../protocol/launch-types.js";

/**
 * The single place a checkout root becomes the pane birth cwd.
 *
 * A placeholder checkoutRoot (dry-run without an anchor) keeps the
 * anchor-shaped placeholder so preview output stays honest.
 */
export function birthCwdOf(context: Pick<ExecutionContext, "checkoutRoot"> & { anchor?: ExecutionContext["anchor"] }): string {
  if (!context.checkoutRoot.startsWith("<")) return context.checkoutRoot;
  return context.anchor?.cwd ?? context.checkoutRoot;
}

/** Preserve environment insertion order and raw --env argv values. */
export function paneEnvArgs(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

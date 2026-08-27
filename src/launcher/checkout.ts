/**
 * Checkout seam (launcher port design §6).
 *
 * A launch has exactly one checkout route.  This period the provider always
 * answers `current`: hubRoot and checkoutRoot are the anchor cwd, the
 * Context Hub stays shared at hubRoot, and no git lifecycle is touched.  The
 * future worktree shape exists only as a pure-object route so later units
 * can widen the provider without re-designing the boundary; a non-current
 * selection is refused loudly today (fail closed, no silent degradation).
 *
 * `birthCwdOf` is the only consumer that turns a checkoutRoot into the pane
 * cwd used by tab create / pane split.
 */

import type { ExecutionContext } from "../types.js";

/**
 * Current checkout (this period) or the future worktree route.
 * `worktree` carries the path/ref pair the future provider will resolve;
 * nothing in this period reads, guesses, or executes those fields.
 */
export type CheckoutRoute =
  | { kind: "current" }
  | { kind: "worktree"; path?: string; ref?: string };

/** What one checkout resolution freezes for the execution context. */
export interface CheckoutSelection {
  /** Shared Context Hub root — invariant across checkout kinds. */
  hubRoot: string;
  /** Pane cwd source for birth; equals hubRoot while checkout is current. */
  checkoutRoot: string;
  checkout: CheckoutRoute;
}

export interface CheckoutProviderInput {
  /** Anchor cwd captured once by anchor discovery; undefined when absent. */
  anchorCwd?: string;
}

export interface CheckoutProvider {
  resolve(input: CheckoutProviderInput): Promise<CheckoutSelection>;
}

const PLACEHOLDER_SELECTION: CheckoutSelection = {
  hubRoot: "<hub-root>",
  checkoutRoot: "<checkout-root>",
  checkout: { kind: "current" },
};

/** The only provider this period: current — Hub and checkout share the anchor cwd. */
export const currentCheckoutProvider: CheckoutProvider = {
  resolve: async (input) =>
    input.anchorCwd === undefined
      ? PLACEHOLDER_SELECTION
      : { hubRoot: input.anchorCwd, checkoutRoot: input.anchorCwd, checkout: { kind: "current" } },
};

/**
 * Resolve the checkout selection for one launch.  Pure provider default;
 * a future provider is expected to stay side-effect free in this boundary
 * (no git execution — that lands with its own approved design).
 */
export async function resolveCheckout(
  input: CheckoutProviderInput,
  provider: CheckoutProvider = currentCheckoutProvider,
): Promise<CheckoutSelection> {
  return await provider.resolve(input);
}

/** Narrow a selection to what this period's ExecutionContext may carry. */
export function assertCurrentCheckout(selection: CheckoutSelection): asserts selection is CheckoutSelection & {
  checkout: { kind: "current" };
} {
  if (selection.checkout.kind !== "current") {
    throw new Error(
      `non-current checkout route '${selection.checkout.kind}' is not enabled in this period — the Context Hub stays at the shared hub root`,
    );
  }
}

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

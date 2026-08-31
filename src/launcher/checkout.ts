/**
 * Checkout seam (launcher port design §6).
 *
 * A launch has exactly one checkout route.  `current` keeps the existing
 * anchor checkout; `worktree` points at an already-created checkout.  The
 * Context Hub stays shared at hubRoot and this provider never creates, moves,
 * or removes a git worktree.
 *
 * `birthCwdOf` is the only consumer that turns a checkoutRoot into the pane
 * cwd used by tab create / pane split.
 */

import path from "node:path";
import type { CheckoutRoute, ExecutionContext } from "../types.js";

/**
 * Current checkout or an explicitly named, pre-created worktree route.
 * The route is carried as frozen metadata; this provider resolves a path but
 * never creates, guesses, or removes a worktree.
 */
export type { CheckoutRoute } from "../types.js";

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
  /** Caller cwd used only to resolve a relative explicit worktree path. */
  baseCwd?: string;
  /** Programmatic alias for baseCwd. */
  callerCwd?: string;
  /** Task-frozen route; absent means current for compatibility. */
  checkout?: CheckoutRoute;
  /** Programmatic alias for checkout. */
  checkoutRoute?: CheckoutRoute;
}

export interface CheckoutProvider {
  resolve(input: CheckoutProviderInput): Promise<CheckoutSelection>;
}

const PLACEHOLDER_SELECTION: CheckoutSelection = {
  hubRoot: "<hub-root>",
  checkoutRoot: "<checkout-root>",
  checkout: { kind: "current" },
};

function routeString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${field} must be a non-empty string without NUL/CR/LF`);
  }
  return value;
}

function routeOf(input: CheckoutProviderInput): CheckoutRoute {
  const requested = input.checkoutRoute ?? input.checkout;
  if (requested === undefined || requested.kind === "current") return { kind: "current" };
  if (requested.kind !== "worktree") throw new Error("unsupported checkout route");
  const checkoutPath = routeString(requested.path, "worktree checkout path");
  const ref = routeString(requested.ref, "worktree checkout ref");
  if (checkoutPath === undefined && ref === undefined) {
    throw new Error("worktree checkout requires an explicit path or ref");
  }
  return {
    kind: "worktree",
    ...(checkoutPath !== undefined ? { path: checkoutPath } : {}),
    ...(ref !== undefined ? { ref } : {}),
  };
}

/** The default provider resolves current and explicit pre-created worktree paths. */
export const currentCheckoutProvider: CheckoutProvider = {
  resolve: async (input) => {
    const route = routeOf(input);
    if (route.kind === "current") {
      return input.anchorCwd === undefined
        ? PLACEHOLDER_SELECTION
        : { hubRoot: input.anchorCwd, checkoutRoot: input.anchorCwd, checkout: route };
    }

    // This period intentionally accepts only the explicit path half of a
    // worktree route.  A ref alone would require git worktree automation,
    // which is a later lifecycle unit and must not be guessed here.
    if (route.path === undefined) {
      throw new Error("worktree checkout ref has no resolved path; automatic git worktree creation is not enabled");
    }
    const baseCwd = input.anchorCwd ?? input.baseCwd ?? input.callerCwd ?? process.cwd();
    const checkoutRoot = path.resolve(baseCwd, route.path);
    return {
      hubRoot: input.anchorCwd ?? "<hub-root>",
      checkoutRoot,
      checkout: {
        kind: "worktree",
        path: checkoutRoot,
        ...(route.ref !== undefined ? { ref: route.ref } : {}),
      },
    };
  },
};

/**
 * Resolve the checkout selection for one launch.  Providers stay side-effect
 * free in this boundary: this module does not execute git or inspect the
 * filesystem.
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

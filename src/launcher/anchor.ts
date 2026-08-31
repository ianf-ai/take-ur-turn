/**
 * Herdr anchor and execution-context discovery.
 *
 * The caller's cwd and the Herdr pane snapshot are captured once at the
 * launcher boundary.  `TUT_PROJECT_ROOT` only selects the workspace-routing
 * root; it is never a substitute for the Herdr anchor used for birth.
 */

import path from "node:path";
import { HerdrClient, type HerdrPane } from "./herdr-client.js";
import {
  resolveCheckout,
  type CheckoutProvider,
} from "./checkout.js";
import type { CheckoutRoute, ExecutionContext, LaunchAnchor } from "../types.js";

export type AnchorSource = "tut-hub" | "tut-notify" | "split-base";

export interface SelectedAnchor {
  anchor: LaunchAnchor;
  source: AnchorSource;
}

/** A flat immutable snapshot that can be passed to route/naming planners. */
export interface WorkspaceSnapshot extends ExecutionContext {
  /** Absolute cwd of the process which entered the launcher. */
  caller_cwd: string;
}

export interface PaneListSource {
  paneList?(): Promise<{ panes: HerdrPane[] } | HerdrPane[]>;
  listPanes?(): Promise<{ panes: HerdrPane[] } | HerdrPane[]>;
}

export interface ResolveExecutionContextOptions {
  /** Injected client/list source for tests or another Host implementation. */
  client?: PaneListSource;
  herdrClient?: PaneListSource;
  herdr?: PaneListSource;
  /** Explicit environment snapshot; defaults to process.env at call time. */
  env?: NodeJS.ProcessEnv;
  /** Explicit caller cwd; defaults to process.cwd() at call time. */
  caller_cwd?: string;
  callerCwd?: string;
  /** Explicit dry-run switch; otherwise TUT_DRY_RUN === "1". */
  dry_run?: boolean;
  dryRun?: boolean;
  /** Task-frozen checkout route; absent keeps the current checkout. */
  checkout?: CheckoutRoute;
  /** Programmatic alias for checkout. */
  checkoutRoute?: CheckoutRoute;
  /** Checkout seam; defaults to the explicit-path provider. */
  checkoutProvider?: CheckoutProvider;
}

const PLACEHOLDER_ANCHOR: LaunchAnchor = {
  workspace_id: "<workspace>",
  cwd: "<cwd>",
  pane_id: "<anchor>",
};

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function validAnchorFromPane(pane: HerdrPane | undefined): LaunchAnchor | undefined {
  if (pane === undefined || !nonEmpty(pane.pane_id) || !nonEmpty(pane.workspace_id) || !nonEmpty(pane.cwd)) return undefined;
  return {
    workspace_id: pane.workspace_id,
    cwd: pane.cwd,
    pane_id: pane.pane_id,
  };
}

function findValidSystemAnchor(panes: readonly HerdrPane[], label: "tut-hub" | "tut-notify"): LaunchAnchor | undefined {
  for (const pane of panes) {
    if (pane.label !== label) continue;
    const anchor = validAnchorFromPane(pane);
    if (anchor !== undefined) return anchor;
  }
  return undefined;
}

/**
 * Select an anchor without looking at list position, focus, tab labels, or
 * any workspace environment variable.  The pane row supplies all three
 * values together so workspace/cwd cannot drift across records.
 */
export function selectAnchor(panes: readonly HerdrPane[], splitBase?: string): SelectedAnchor | undefined {
  const hasSystemPane = panes.some((pane) => pane.label === "tut-hub" || pane.label === "tut-notify");
  const hub = findValidSystemAnchor(panes, "tut-hub");
  if (hub !== undefined) return { anchor: hub, source: "tut-hub" };

  const notify = findValidSystemAnchor(panes, "tut-notify");
  if (notify !== undefined) return { anchor: notify, source: "tut-notify" };

  if (!hasSystemPane && nonEmpty(splitBase)) {
    const escape = validAnchorFromPane(panes.find((pane) => pane.pane_id === splitBase));
    if (escape !== undefined) return { anchor: escape, source: "split-base" };
  }
  return undefined;
}

function projectRootOf(environment: NodeJS.ProcessEnv, callerCwd: string): string | undefined {
  const configured = environment.TUT_PROJECT_ROOT;
  return nonEmpty(configured) ? path.resolve(callerCwd, configured) : undefined;
}

async function panesFrom(source: PaneListSource): Promise<HerdrPane[]> {
  const result = source.paneList !== undefined
    ? await source.paneList()
    : source.listPanes !== undefined
      ? await source.listPanes()
      : [];
  if (Array.isArray(result)) return result;
  if (typeof result === "object" && result !== null && Array.isArray(result.panes)) return result.panes;
  return [];
}

/**
 * Resolve the complete one-shot workspace snapshot.  A failed/unparseable
 * pane list is intentionally equivalent to an unavailable anchor: live birth
 * will fail loudly, while dry-run receives placeholders for preview output.
 */
export async function resolveWorkspaceSnapshot(
  options: ResolveExecutionContextOptions = {},
): Promise<WorkspaceSnapshot> {
  const environment: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const caller = path.resolve(options.caller_cwd ?? options.callerCwd ?? process.cwd());
  const dryRun = options.dry_run ?? options.dryRun ?? environment.TUT_DRY_RUN === "1";
  const configuredRoot = projectRootOf(environment, caller);
  const source = options.client ?? options.herdrClient ?? options.herdr ?? new HerdrClient({ env: environment });

  let panes: HerdrPane[] = [];
  try {
    panes = await panesFrom(source);
  } catch {
    // Do not manufacture an anchor from caller cwd when Herdr discovery fails.
    panes = [];
  }

  const selected = selectAnchor(panes, environment.TUT_SPLIT_BASE);
  // The checkout seam is resolved inside the one-shot context snapshot:
  // current keeps hubRoot=checkoutRoot=anchor.cwd; a worktree changes only
  // checkoutRoot, while routingRoot still follows TUT_PROJECT_ROOT or the
  // shared hub root.  Include caller cwd only when an explicit route needs a
  // relative path; the no-route call shape stays backward compatible.
  const requestedCheckout = options.checkoutRoute ?? options.checkout;
  const checkoutInput = {
    ...(selected?.anchor.cwd !== undefined ? { anchorCwd: selected.anchor.cwd } : {}),
    ...(requestedCheckout !== undefined ? { checkout: requestedCheckout, baseCwd: caller } : {}),
  };
  const checkout = await resolveCheckout(
    checkoutInput,
    options.checkoutProvider,
  );
  const context: ExecutionContext = selected === undefined
    ? {
        ...(dryRun ? { anchor: PLACEHOLDER_ANCHOR } : {}),
        hubRoot: checkout.hubRoot,
        routingRoot: configuredRoot ?? "<routing-root>",
        checkoutRoot: checkout.checkoutRoot,
        checkout: checkout.checkout,
        context: { kind: "shared" },
        source: dryRun ? "placeholder" : "legacy",
        caller_cwd: caller,
      }
    : {
        anchor: selected.anchor,
        caller_cwd: caller,
        hubRoot: checkout.hubRoot,
        routingRoot: configuredRoot ?? checkout.hubRoot,
        checkoutRoot: checkout.checkoutRoot,
        checkout: checkout.checkout,
        context: { kind: "shared" },
        source: "anchor",
      };

  return {
    ...context,
    caller_cwd: caller,
  };
}

/** Context-only facade used by launch callers. */
export async function resolveExecutionContext(
  options: ResolveExecutionContextOptions = {},
): Promise<WorkspaceSnapshot> {
  return await resolveWorkspaceSnapshot(options);
}

/** Naming alias for consumers that call the value an invocation context. */
export const resolveInvocationContext = resolveExecutionContext;

/** Pure assertion for the mutation boundary; placeholders are allowed only in dry-run. */
export function requireBirthAnchor(context: ExecutionContext): LaunchAnchor {
  const anchor = context.anchor;
  if (anchor === undefined || [anchor.workspace_id, anchor.cwd, anchor.pane_id].some((value) => value.startsWith("<"))) {
    throw new Error("no anchor pane found (tut-hub / tut-notify / $TUT_SPLIT_BASE) — run tut up, or set TUT_SPLIT_BASE to a pane id");
  }
  return anchor;
}

/**
 * Checkout seam (launcher port design §6) — unit 3.
 *
 * This period the provider always answers `current`: hubRoot and
 * checkoutRoot share the anchor cwd, the Context Hub stays shared, and no
 * git lifecycle exists.  The future worktree shape is exercised only as a
 * pure-object alternate provider: the seam must show that a future checkout
 * changes ONLY the pane cwd source, never the shared Hub root — and that a
 * non-current selection is refused loudly today instead of degrading.
 */

import { vi, describe, expect, it } from "vitest";

import {
  assertCurrentCheckout,
  birthCwdOf,
  currentCheckoutProvider,
  resolveCheckout,
  type CheckoutProvider,
} from "../src/launcher/checkout.js";
import { resolveWorkspaceSnapshot, type PaneListSource } from "../src/launcher/anchor.js";
import type { HerdrPane } from "../src/launcher/herdr-client.js";

const hubPane: HerdrPane = {
  pane_id: "w1:p0",
  label: "tut-hub",
  workspace_id: "w1",
  cwd: "/hub/project",
  agent_status: "idle",
};

const anchoredSource: PaneListSource = { paneList: vi.fn(async () => ({ panes: [hubPane] })) };

describe("current checkout provider (this period)", () => {
  it("keeps hubRoot and checkoutRoot on the anchor cwd", async () => {
    await expect(resolveCheckout({ anchorCwd: "/hub/project" })).resolves.toEqual({
      hubRoot: "/hub/project",
      checkoutRoot: "/hub/project",
      checkout: { kind: "current" },
    });
  });

  it("answers placeholders when no anchor exists (dry-run/legacy preview)", async () => {
    await expect(resolveCheckout({})).resolves.toEqual({
      hubRoot: "<hub-root>",
      checkoutRoot: "<checkout-root>",
      checkout: { kind: "current" },
    });
  });

  it("flows through the one-shot workspace snapshot with an independent routingRoot", async () => {
    const provider = vi.fn(currentCheckoutProvider.resolve);
    const snapshot = await resolveWorkspaceSnapshot({
      client: anchoredSource,
      caller_cwd: "/caller/root",
      env: { TUT_PROJECT_ROOT: "/external/routing" },
      dry_run: false,
      checkoutProvider: { resolve: provider },
    });
    expect(snapshot).toMatchObject({
      hubRoot: "/hub/project",
      checkoutRoot: "/hub/project",
      routingRoot: "/external/routing",
      checkout: { kind: "current" },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith({ anchorCwd: "/hub/project" });
  });
});

describe("future worktree checkout (pure-object alternate only)", () => {
  const futureProvider: CheckoutProvider = {
    // Pure data: no spawn, no fs, no git — the only legal alternate fixture
    // shape this period (design §6: provider must stay side-effect free).
    resolve: async ({ anchorCwd }) => ({
      hubRoot: anchorCwd ?? "<hub-root>",
      checkoutRoot: "/worktrees/t-42",
      checkout: { kind: "worktree", ref: "t-42" } as const,
    }),
  };

  it("changes only the pane cwd source — the shared Hub root stays on the anchor", async () => {
    const selection = await resolveCheckout({ anchorCwd: "/hub/project" }, futureProvider);
    expect(selection.hubRoot).toBe("/hub/project"); // shared Context Hub invariant
    expect(selection.checkoutRoot).toBe("/worktrees/t-42"); // pane cwd source switches
    expect(selection.checkout).toEqual({ kind: "worktree", ref: "t-42" });

    // The birth cwd consumer reads the checkout root, not the anchor cwd.
    expect(birthCwdOf({
      checkoutRoot: selection.checkoutRoot,
      anchor: { workspace_id: "w1", cwd: "/hub/project", pane_id: "w1:p0" },
    })).toBe("/worktrees/t-42");
  });

  it("is refused loudly by the execution-context snapshot — no silent degradation", async () => {
    const source = { paneList: vi.fn(async () => ({ panes: [hubPane] })) };
    await expect(resolveWorkspaceSnapshot({
      client: source,
      caller_cwd: "/caller/root",
      env: {},
      dry_run: false,
      checkoutProvider: futureProvider,
    })).rejects.toThrowError(/non-current checkout route 'worktree'/u);
    // Anchor discovery only: the refusal happens before anything else runs.
    expect(source.paneList).toHaveBeenCalledTimes(1);
  });

  it("assertCurrentCheckout passes the current selection unchanged", () => {
    const selection = { hubRoot: "/h", checkoutRoot: "/h", checkout: { kind: "current" } as const };
    expect(() => assertCurrentCheckout(selection)).not.toThrow();
    expect(() =>
      assertCurrentCheckout({ hubRoot: "/h", checkoutRoot: "/wt", checkout: { kind: "worktree" } }),
    ).toThrowError(/not enabled in this period/u);
  });
});

describe("birthCwdOf placeholder behavior", () => {
  it("keeps the anchor-shaped placeholder when the checkout root is a preview placeholder", () => {
    expect(birthCwdOf({ checkoutRoot: "<checkout-root>", anchor: { workspace_id: "w", cwd: "<cwd>", pane_id: "p" } })).toBe("<cwd>");
    expect(birthCwdOf({ checkoutRoot: "<checkout-root>" })).toBe("<checkout-root>");
    expect(birthCwdOf({ checkoutRoot: "/real/checkout" })).toBe("/real/checkout");
  });
});

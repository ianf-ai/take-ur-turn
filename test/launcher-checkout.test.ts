/**
 * Checkout seam (launcher port design §6) — unit 3.
 *
 * The default provider supports current and explicit pre-created worktree
 * paths: hubRoot remains shared while checkoutRoot becomes the pane cwd.
 * There is still no git lifecycle in this seam.
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

  it("resolves an explicit worktree path without moving the shared Hub root", async () => {
    await expect(resolveCheckout({
      anchorCwd: "/hub/project",
      checkout: { kind: "worktree", path: "/worktrees/a", ref: "task-a" },
    })).resolves.toEqual({
      hubRoot: "/hub/project",
      checkoutRoot: "/worktrees/a",
      checkout: { kind: "worktree", path: "/worktrees/a", ref: "task-a" },
    });
  });

  it("resolves a relative worktree path against the captured anchor", async () => {
    await expect(resolveCheckout({
      anchorCwd: "/hub/project",
      baseCwd: "/caller",
      checkout: { kind: "worktree", path: "../worktrees/a" },
    })).resolves.toMatchObject({
      hubRoot: "/hub/project",
      checkoutRoot: "/hub/worktrees/a",
      checkout: { kind: "worktree", path: "/hub/worktrees/a" },
    });
  });

  it("refuses a ref-only route because git worktree creation is not automatic", async () => {
    await expect(resolveCheckout({
      anchorCwd: "/hub/project",
      checkout: { kind: "worktree", ref: "task-a" },
    })).rejects.toThrowError(/automatic git worktree creation is not enabled/u);
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

  it("flows a worktree through the execution-context snapshot", async () => {
    const source = { paneList: vi.fn(async () => ({ panes: [hubPane] })) };
    await expect(resolveWorkspaceSnapshot({
      client: source,
      caller_cwd: "/caller/root",
      env: {},
      dry_run: false,
      checkoutProvider: futureProvider,
    })).resolves.toMatchObject({
      hubRoot: "/hub/project",
      checkoutRoot: "/worktrees/t-42",
      checkout: { kind: "worktree", ref: "t-42" },
      routingRoot: "/hub/project",
    });
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

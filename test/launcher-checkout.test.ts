import path from "node:path";
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
} from "../src/core/launcher/checkout.js";
import { resolveWorkspaceSnapshot, type PaneListSource } from "../src/herdr/launcher/anchor.js";
import type { HerdrPane } from "../src/herdr/launcher/legacy-herdr-client.js";

const hubPane: HerdrPane = {
  pane_id: "w1:p0",
  label: "tut-hub",
  workspace_id: "w1",
  cwd: path.resolve("/hub/project"),
  agent_status: "idle",
};

const anchoredSource: PaneListSource = { paneList: vi.fn(async () => ({ panes: [hubPane] })) };

describe("current checkout provider (this period)", () => {
  it("keeps hubRoot and checkoutRoot on the anchor cwd", async () => {
    await expect(resolveCheckout({ anchorCwd: path.resolve("/hub/project") })).resolves.toEqual({
      hubRoot: path.resolve("/hub/project"),
      checkoutRoot: path.resolve("/hub/project"),
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
      anchorCwd: path.resolve("/hub/project"),
      checkout: { kind: "worktree", path: path.resolve("/worktrees/a"), ref: "task-a" },
    })).resolves.toEqual({
      hubRoot: path.resolve("/hub/project"),
      checkoutRoot: path.resolve("/worktrees/a"),
      checkout: { kind: "worktree", path: path.resolve("/worktrees/a"), ref: "task-a" },
    });
  });

  it("resolves a relative worktree path against the captured anchor", async () => {
    await expect(resolveCheckout({
      anchorCwd: path.resolve("/hub/project"),
      baseCwd: path.resolve("/caller"),
      checkout: { kind: "worktree", path: "../worktrees/a" },
    })).resolves.toMatchObject({
      hubRoot: path.resolve("/hub/project"),
      checkoutRoot: path.resolve("/hub/worktrees/a"),
      checkout: { kind: "worktree", path: path.resolve("/hub/worktrees/a") },
    });
  });

  it("refuses a ref-only route because git worktree creation is not automatic", async () => {
    await expect(resolveCheckout({
      anchorCwd: path.resolve("/hub/project"),
      checkout: { kind: "worktree", ref: "task-a" },
    })).rejects.toThrowError(/automatic git worktree creation is not enabled/u);
  });

  it("flows through the one-shot workspace snapshot with an independent routingRoot", async () => {
    const provider = vi.fn(currentCheckoutProvider.resolve);
    const snapshot = await resolveWorkspaceSnapshot({
      client: anchoredSource,
      caller_cwd: path.resolve("/caller/root"),
      env: { TUT_PROJECT_ROOT: path.resolve("/external/routing") },
      dry_run: false,
      checkoutProvider: { resolve: provider },
    });
    expect(snapshot).toMatchObject({
      hubRoot: path.resolve("/hub/project"),
      checkoutRoot: path.resolve("/hub/project"),
      routingRoot: path.resolve("/external/routing"),
      checkout: { kind: "current" },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith({ anchorCwd: path.resolve("/hub/project") });
  });
});

describe("future worktree checkout (pure-object alternate only)", () => {
  const futureProvider: CheckoutProvider = {
    // Pure data: no spawn, no fs, no git — the only legal alternate fixture
    // shape this period (design §6: provider must stay side-effect free).
    resolve: async ({ anchorCwd }) => ({
      hubRoot: anchorCwd ?? "<hub-root>",
      checkoutRoot: path.resolve("/worktrees/t-42"),
      checkout: { kind: "worktree", ref: "t-42" } as const,
    }),
  };

  it("changes only the pane cwd source — the shared Hub root stays on the anchor", async () => {
    const selection = await resolveCheckout({ anchorCwd: path.resolve("/hub/project") }, futureProvider);
    expect(selection.hubRoot).toBe(path.resolve("/hub/project")); // shared Context Hub invariant
    expect(selection.checkoutRoot).toBe(path.resolve("/worktrees/t-42")); // pane cwd source switches
    expect(selection.checkout).toEqual({ kind: "worktree", ref: "t-42" });

    // The birth cwd consumer reads the checkout root, not the anchor cwd.
    expect(birthCwdOf({
      checkoutRoot: selection.checkoutRoot,
      anchor: { workspace_id: "w1", cwd: path.resolve("/hub/project"), pane_id: "w1:p0" },
    })).toBe(path.resolve("/worktrees/t-42"));
  });

  it("flows a worktree through the execution-context snapshot", async () => {
    const source = { paneList: vi.fn(async () => ({ panes: [hubPane] })) };
    await expect(resolveWorkspaceSnapshot({
      client: source,
      caller_cwd: path.resolve("/caller/root"),
      env: {},
      dry_run: false,
      checkoutProvider: futureProvider,
    })).resolves.toMatchObject({
      hubRoot: path.resolve("/hub/project"),
      checkoutRoot: path.resolve("/worktrees/t-42"),
      checkout: { kind: "worktree", ref: "t-42" },
      routingRoot: path.resolve("/hub/project"),
    });
    expect(source.paneList).toHaveBeenCalledTimes(1);
  });

  it("assertCurrentCheckout passes the current selection unchanged", () => {
    const selection = { hubRoot: path.resolve("/h"), checkoutRoot: path.resolve("/h"), checkout: { kind: "current" } as const };
    expect(() => assertCurrentCheckout(selection)).not.toThrow();
    expect(() =>
      assertCurrentCheckout({ hubRoot: path.resolve("/h"), checkoutRoot: path.resolve("/wt"), checkout: { kind: "worktree" } }),
    ).toThrowError(/not enabled in this period/u);
  });
});

describe("birthCwdOf placeholder behavior", () => {
  it("keeps the anchor-shaped placeholder when the checkout root is a preview placeholder", () => {
    expect(birthCwdOf({ checkoutRoot: "<checkout-root>", anchor: { workspace_id: "w", cwd: "<cwd>", pane_id: "p" } })).toBe("<cwd>");
    expect(birthCwdOf({ checkoutRoot: "<checkout-root>" })).toBe("<checkout-root>");
    expect(birthCwdOf({ checkoutRoot: path.resolve("/real/checkout") })).toBe(path.resolve("/real/checkout"));
  });
});

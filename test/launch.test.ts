import { describe, expect, it, vi } from "vitest";
import type { ContextRecord } from "../src/types.js";

vi.mock("../src/hub-client.js", () => ({
  hubPublish: vi.fn(),
  hubRead: vi.fn(),
}));

import { hubPublish } from "../src/hub-client.js";
import { launchBlocked, markLaunched, resolveLaunchTarget } from "../src/launch.js";

function record(
  version: number,
  content_type: string,
  payload: Record<string, unknown> = {},
): ContextRecord {
  return {
    version,
    task_id: "launch-test",
    role: "human",
    content_type,
    timestamp: `2026-08-17T00:00:0${version}.000Z`,
    payload: { summary: content_type, body: "body", ...payload },
  };
}

function launch(version: number, role = "executor", via: "start-next" | "auto" = "start-next"): ContextRecord {
  return record(version, "note", {
    summary: `launch ${role}`,
    launch: { role, base_version: version - 1, via },
  });
}

describe("launchBlocked", () => {
  it("allows a role with no launch marker", () => {
    expect(launchBlocked([record(1, "design")], "executor")).toEqual({ blocked: false });
  });

  it("blocks when the role marker has no later content record", () => {
    expect(launchBlocked([record(1, "design"), launch(2)], "executor")).toEqual({ blocked: true, noteVersion: 2 });
  });

  it("allows a later round after any non-note content record", () => {
    expect(launchBlocked([record(1, "design"), launch(2), record(3, "code_changes")], "executor")).toEqual({ blocked: false });
  });

  it("uses the latest same-role marker and ignores other roles and notes", () => {
    const records = [
      record(1, "design"),
      launch(2, "reviewer"),
      record(3, "note", { ack: true }),
      launch(4, "executor", "auto"),
      record(5, "note", { summary: "ordinary note", body: "still same round" }),
    ];
    expect(launchBlocked(records, "reviewer")).toEqual({ blocked: true, noteVersion: 2 });
    expect(launchBlocked(records, "executor")).toEqual({ blocked: true, noteVersion: 4 });
  });

  it("sorts records by version so an out-of-order log is still deterministic", () => {
    expect(launchBlocked([record(3, "code_changes"), launch(2), record(1, "design")], "executor")).toEqual({ blocked: false });
  });
});

describe("markLaunched", () => {
  it("appends a human launch note with the observed version as the optimistic fence", async () => {
    vi.mocked(hubPublish).mockResolvedValue({ task_id: "t1", version: 4, status: "implementing", needs_attention: false });

    await markLaunched("http://hub", "t1", "executor", 3, "auto");

    expect(hubPublish).toHaveBeenCalledWith("http://hub", {
      task_id: "t1",
      role: "human",
      content_type: "note",
      payload: {
        summary: "launch: executor (base v3)",
        body: "Recorded launch of executor via auto at task log base version 3.",
        launch: { role: "executor", base_version: 3, via: "auto" },
      },
      expected_version: 3,
    });
  });
});

// --- resolveLaunchTarget (cast → workspace → routes → defaults) ---------------------

describe("resolveLaunchTarget", () => {
  it("cast hit overrides the file chain; partial cast falls back for unlisted roles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tasks: [
            { task_id: "other", cast: {} },
            { task_id: "t-cast", cast: { executor: "codex", reviewer: "zcode" } },
          ],
        }),
      })),
    );
    try {
      // Deterministic file chain: hide workspace.json + routes.json (rename
      // pattern of cli-assign-launch) so unlisted roles hit DEFAULT_ROLES.
      const { renameSync, existsSync } = await import("node:fs");
      const path = await import("node:path");
      const scripts = path.resolve(import.meta.dirname, "../scripts");
      const hidden: Array<[string, string]> = [];
      for (const f of [path.join(scripts, "workspace.json"), path.join(scripts, "routes.json")]) {
        if (existsSync(f)) {
          renameSync(f, `${f}.a7lt`);
          hidden.push([`${f}.a7lt`, f]);
        }
      }
      try {
        const hit = await resolveLaunchTarget("http://hub.test", "t-cast", "executor");
        expect(hit.agent).toBe("codex"); // from cast
        expect(hit.cast).toEqual({ executor: "codex", reviewer: "zcode" });

        const fallback = await resolveLaunchTarget("http://hub.test", "t-cast", "architect");
        expect(fallback.agent).toBe("codex"); // not in cast → DEFAULT_ROLES.architect
      } finally {
        for (const [from, to] of hidden) renameSync(from, to);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("task absent from /state → clear error; non-200 → clear error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tasks: [] }) })));
    await expect(resolveLaunchTarget("http://hub.test", "ghost", "executor")).rejects.toThrow("task ghost not in /state");
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    await expect(resolveLaunchTarget("http://hub.test", "t1", "executor")).rejects.toThrow("HTTP 503");
    vi.unstubAllGlobals();
  });
});

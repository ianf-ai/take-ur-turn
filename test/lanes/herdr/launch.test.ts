import { describe, expect, it, vi } from "vitest";
import type { ContextRecord } from "../../../src/protocol/types.js";

vi.mock("../../../src/hub/hub-client.js", () => ({
  hubPublish: vi.fn(),
  hubRead: vi.fn(),
}));

import { hubPublish } from "../../../src/hub/hub-client.js";
import { launchBlocked, markLaunched, resolveLaunchTarget } from "../../../src/core/launcher/launch.js";

function record(
  version: number,
  content_type: string,
  payload: Record<string, unknown> = {},
  role = "human",
): ContextRecord {
  return {
    version,
    task_id: "launch-test",
    role,
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
  it("releases only the completed marker verified by the detached owner", () => {
    const records = [launch(1), record(2, "note", {}, "executor"), record(3, "note", {}, "executor")];
    expect(launchBlocked(records, "executor", undefined, "direct")).toEqual({ blocked: true, noteVersion: 1 });
    expect(launchBlocked(records, "executor", undefined, "direct", new Set([1]))).toEqual({ blocked: false, recoveryVersion: 1 });
    expect(launchBlocked([...records, launch(4)], "executor", undefined, "direct", new Set([1]))).toEqual({ blocked: true, noteVersion: 4 });
    expect(launchBlocked(records, "executor", undefined, "direct", new Set([2]))).toEqual({ blocked: true, noteVersion: 1 });
  });
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

  it("extends only a verified new-note boundary and ignores markers of other roles", () => {
    const records = [record(1, "design"), launch(2), record(3, "note"), launch(4, "reviewer")];
    expect(launchBlocked(records, "executor")).toEqual({ blocked: true, noteVersion: 2 });
    expect(launchBlocked(records, "executor", { version: 3 })).toEqual({ blocked: false });
    expect(launchBlocked([...records].reverse(), "executor", { version: 3 })).toEqual({ blocked: false });
    expect(launchBlocked([...records, launch(5)], "executor", { version: 3 })).toEqual({ blocked: true, noteVersion: 5 });
    expect(launchBlocked([...records, launch(5)].reverse(), "executor", { version: 3 })).toEqual({ blocked: true, noteVersion: 5 });
    expect(launchBlocked([...records, launch(3)], "executor", { version: 3 })).toEqual({ blocked: true, noteVersion: 3 });
  });

  it.each([0, 1, 2, 4, 5, 6, NaN, 3.5])("does not extend dedup for invalid or ineligible note context v%s", version => {
    const records = [record(1, "design"), launch(2), record(3, "note"), record(4, "note", { ack: true }),
      record(5, "note", { launch: null })];
    expect(launchBlocked(records, "executor", { version })).toEqual({ blocked: true, noteVersion: 2 });
  });

  // --- round scoping: only the current waiting_for round dedups ------------

  it("round scoping: a previous round's marker never blocks the current round", () => {
    // An executor marker in round 0; the review round (review fail_code)
    // flips the role back to the executor — the old marker is before the
    // round boundary and must read as fresh.
    const records = [
      launch(1, "executor", "auto"),
      record(2, "code_changes"),
      launch(3, "reviewer", "auto"),
      record(4, "review", { verdict: "fail_code" }),
      record(5, "note"), // supportedFixes-style correction — notes never flip
      record(6, "note"),
    ];
    expect(launchBlocked(records, "executor")).toEqual({ blocked: false });
    expect(launchBlocked(records, "reviewer")).toEqual({ blocked: false });
  });

  it("round scoping: a same-round marker still blocks until content follows", () => {
    const records = [
      record(1, "review", { verdict: "fail_code" }), // the flip that starts the revision round
      record(2, "note"),
      launch(3, "executor", "auto"),
      record(4, "note"),
    ];
    expect(launchBlocked(records, "executor")).toEqual({ blocked: true, noteVersion: 3 });
  });

  it("round scoping: with no flip record at all the initial round still dedups", () => {
    expect(launchBlocked([launch(1, "executor", "auto")], "executor")).toEqual({ blocked: true, noteVersion: 1 });
  });

  it("round scoping: a verified new note still extends the boundary within its round", () => {
    const records = [record(1, "review", { verdict: "fail_code" }), launch(2, "executor", "auto"), record(3, "note")];
    expect(launchBlocked(records, "executor")).toEqual({ blocked: true, noteVersion: 2 });
    expect(launchBlocked(records, "executor", { version: 3 })).toEqual({ blocked: false });
    expect(launchBlocked(records, "executor", { version: 3 }, "full")).toEqual({ blocked: false });
  });

  // --- flow scoping: the boundary follows the task's real flow ----------------

  it("flow scoping: a real solo round keeps its same-round marker; the full default table would misread it", () => {
    // Legal solo sequence: architect reference design record (an in-table
    // no-transition reference in solo's implementing), executor marker,
    // code_changes → pending_approval, human reject → implementing (the
    // round's flip), executor marker, then a PLAIN executor progress note.
    // Solo has no reviewing state, so the note never flips anything and the
    // marker stays valid; replayed under the full default table the same note
    // reads as a reviewing→revising flip, moves the boundary past the marker,
    // and would wrongly clear it.
    const records = [
      record(1, "design", { summary: "reference design", body: "design" }, "architect"),
      launch(2, "executor", "auto"),
      record(3, "code_changes", {}, "executor"),
      record(4, "decision", { decision: "reject" }),
      launch(5, "executor", "auto"),
      record(6, "note", { summary: "progress", body: "mid-work note" }, "executor"),
    ];
    expect(launchBlocked(records, "executor", undefined, "solo")).toEqual({ blocked: true, noteVersion: 5 });
    // The full default table mis-derives the boundary (v6 reads as a
    // reviewing→revising note flip) — documenting why the default is only a
    // compatibility fallback for flow-less inputs, never a substitute.
    expect(launchBlocked(records, "executor", undefined, "full")).toEqual({ blocked: false });
    expect(launchBlocked(records, "executor", undefined, undefined)).toEqual({ blocked: false });
  });

  it("flow scoping: full and direct agree on the fail_code revision round", () => {
    const records = [
      record(1, "design", {}, "architect"),
      launch(2, "executor", "auto"),
      record(3, "code_changes", {}, "executor"),
      launch(4, "reviewer", "auto"),
      record(5, "review", { verdict: "fail_code" }, "reviewer"),
      launch(6, "executor", "auto"),
    ];
    for (const flow of [undefined, "full", "direct"] as const) {
      expect(launchBlocked(records, "executor", undefined, flow)).toEqual({ blocked: true, noteVersion: 6 });
      expect(launchBlocked(records, "reviewer", undefined, flow)).toEqual({ blocked: false });
    }
  });

  it.each(["full", "direct"] as const)("%s: reviewer markers expire across repeated approval/reject/revision cycles", flow => {
    const records = flow === "full" ? [record(1, "design", {}, "architect")] : [];
    const append = (type: string, payload = {}, role = "human") =>
      records.push(record(records.length + 1, type, payload, role));
    append("code_changes", {}, "executor");
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(launchBlocked(records, "reviewer", undefined, flow)).toEqual({ blocked: false });
      records.push(launch(records.length + 1, "reviewer", "auto"));
      expect(launchBlocked(records, "reviewer", undefined, flow)).toEqual({ blocked: true, noteVersion: records.length });
      append("review", { verdict: "pass" }, "reviewer");
      append("decision", { decision: "reject" });
      expect(launchBlocked(records, "executor", undefined, flow)).toEqual({ blocked: false });
      records.push(launch(records.length + 1, "executor", "auto"));
      append("revision", {}, "executor");
    }
    expect(launchBlocked([...records].reverse(), "reviewer", undefined, flow)).toEqual({ blocked: false });
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
  it("aborts a stalled /state request after the 10-second Hub budget", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const pending = resolveLaunchTarget("http://hub.test", "t1", "executor");
      const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(fetchMock).toHaveBeenCalledWith(new URL("http://hub.test/state"), {
        headers: { Connection: "close" },
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("cast hit overrides the file chain; partial cast falls back for unlisted roles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tasks: [
            { task_id: "other", cast: {} },
            { task_id: "t-cast", cast: { executor: "codex", reviewer: "codex" } },
          ],
        }),
      })),
    );
    try {
      // Deterministic chain: clean L1 (temp cwd — no .context-hub file) +
      // pinned empty L2, so roles not covered by the cast hit DEFAULT_ROLES
      // regardless of the repo's live config or the machine's user-level one.
      const { mkdtempSync, rmSync } = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-launch-chain-"));
      const prevCwd = process.cwd();
      const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
      process.chdir(tmp);
      process.env.TUT_USER_CONFIG_DIR = path.join(tmp, "user-config");
      try {
        const hit = await resolveLaunchTarget("http://hub.test", "t-cast", "executor");
        expect(hit.agent).toBe("codex"); // from cast
        expect(hit.cast).toEqual({ executor: "codex", reviewer: "codex" });

        const fallback = await resolveLaunchTarget("http://hub.test", "t-cast", "architect");
        expect(fallback.agent).toBe("codex"); // not in cast → DEFAULT_ROLES.architect
      } finally {
        process.chdir(prevCwd);
        if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
        else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
        rmSync(tmp, { recursive: true, force: true });
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

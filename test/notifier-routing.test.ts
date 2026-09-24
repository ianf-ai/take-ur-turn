/**
 * The default routing loader takes ONE workspace snapshot per call
 * and resolves every role from it — the three-level chain reads (project +
 * user workspace.json) happen once per poll, not once per role (0.6.0 read
 * the same files 3× every 5s). Structural: workspace.json reads are counted
 * through a counting fs mock; correctness: the maps reflect the chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const fsm = vi.hoisted(() => ({ workspaceReads: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (p: unknown, ...rest: unknown[]) => {
      // Count only SUCCESSFUL reads — a missing level is an ENOENT attempt,
      // not a file consumed.
      const result = await (actual.readFile as (p: unknown, ...rest: unknown[]) => Promise<unknown>)(p, ...rest);
      if (String(p).endsWith("workspace.json")) fsm.workspaceReads += 1;
      return result;
    }) as typeof actual.readFile,
  };
});

import { defaultLoadRouting } from "../src/notifier/notifier.js";

let tmp: string;
let projectRoot: string;
let userConfigDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-routing-"));
  projectRoot = path.join(tmp, "proj");
  userConfigDir = path.join(tmp, "user-config");
  mkdirSync(path.join(projectRoot, ".context-hub"), { recursive: true });
  mkdirSync(userConfigDir, { recursive: true });
  fsm.workspaceReads = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("defaultLoadRouting (single snapshot)", () => {
  it("resolves all three roles from ONE workspace read pass — not one per role", async () => {
    // L1 pins executor; L2 pins reviewer; architect falls through to the builtin default.
    writeFileSync(
      path.join(projectRoot, ".context-hub", "workspace.json"),
      JSON.stringify({ roles: { executor: { agent: "pi" } } }),
      "utf8",
    );
    writeFileSync(path.join(userConfigDir, "workspace.json"), JSON.stringify({ roles: { reviewer: { agent: "claude" } } }), "utf8");

    const maps = await defaultLoadRouting({ projectRoot, userConfigDir });
    // The two existing files, read exactly once each (0.6.0: per-role
    // resolveAgentRoute re-read them for every role — 2 files × 3 roles).
    expect(fsm.workspaceReads).toBe(2);
    expect(maps.roleToAgent.get("executor")).toBe("pi"); // L1
    expect(maps.roleToAgent.get("reviewer")).toBe("claude"); // L2
    expect(maps.roleToAgent.get("architect")).toBeDefined(); // builtin default
    expect(maps.labelToAgent.get("pi")).toBe("pi"); // agent-named pane identity
  });

  it("an empty chain (no workspace files anywhere) still resolves builtin defaults with zero workspace reads", async () => {
    const maps = await defaultLoadRouting({ projectRoot, userConfigDir });
    expect(fsm.workspaceReads).toBe(0);
    for (const role of ["architect", "executor", "reviewer"]) {
      expect(maps.roleToAgent.get(role)).toBeDefined();
    }
  });

  it("repeated polls keep the same cost: every call is one snapshot (steady 5s cadence structural bound)", async () => {
    writeFileSync(path.join(userConfigDir, "workspace.json"), JSON.stringify({ roles: { executor: { agent: "pi" } } }), "utf8");
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- cadence simulation
      await defaultLoadRouting({ projectRoot, userConfigDir });
    }
    expect(fsm.workspaceReads).toBe(5); // one read per poll — not five per poll
  });
});

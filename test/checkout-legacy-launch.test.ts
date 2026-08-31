/**
 * Routing-gap combination coverage: the create face and
 * the legacy positional launch door had only ever been tested apart. This
 * file joins them end to end with no mocks of our own code:
 *
 *   real Store (temp root) → real HTTP hub (startServer, ephemeral port)
 *   → task created with a worktree checkout via the real create handler
 *   → the REAL internal launch entry (`node dist/cli.js launch <task> <role>`
 *     — the door scripts/launch.sh forwards to) against the fixture herdr
 *   → the legacy door reads /state entry.checkout at planning and the pane
 *     is born with `cd -- '<worktree>'` — the checkout root, never the
 *     anchor cwd — while the Hub root stays shared.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { hubCreate } from "../src/hub-client.js";
import { startServer, type RunningServer } from "../src/server.js";

const runLaunch = promisify(execFile);
const DIST_CLI = path.resolve(import.meta.dirname, "../dist/cli.js");
const FIXTURE_BIN = path.resolve(import.meta.dirname, "bin");
const NODE_DIR = path.dirname(process.execPath);

// Hermetic workspace chain (same shape as launcher-fresh.test.ts): an L1
// project root with an all-pi roster, an empty L2 — the repo's live config
// and the machine's ~/.config/tut never enter this test.
const CHAIN_ROOT = mkdtempSync(path.join(os.tmpdir(), "tut-combo-chain-"));
const EMPTY_L2 = mkdtempSync(path.join(os.tmpdir(), "tut-combo-l2-"));
const ANCHOR_CWD = mkdtempSync(path.join(os.tmpdir(), "tut-combo-anchor-"));

afterAll(() => {
  for (const dir of [CHAIN_ROOT, EMPTY_L2, ANCHOR_CWD]) rmSync(dir, { recursive: true, force: true });
});

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

// Born-branch screen timeline: boot empties → stable pair releases the gate
// → text lands → submit reaction (mirrors launcher-fresh.test.ts).
const BORN_SCREENS = JSON.stringify(["", "pi ready", "pi ready", "pi ready", "pi ready ▎prompt （tut delivery A1B2C3D4）", "working"]);

describe("combination: create with a worktree path → legacy positional launch door", () => {
  it("births the pane at the task's checkout root, not the anchor cwd", { timeout: 30000 }, async () => {
    expect(existsSync(DIST_CLI)).toBe(true); // npm run build first — the launcher tests drive the built CLI

    // Real hub on an ephemeral port.
    const hubRoot = tempRoot("tut-combo-hub-");
    const server: RunningServer = await startServer({ root: hubRoot, port: 0 });

    // A REAL worktree directory (prepared by the caller — TUT never runs git).
    const worktree = tempRoot("tut-combo-worktree-");

    let taskId = "";
    let log = "";
    try {
      // ① Create face: task frozen to the worktree checkout (ref = annotation).
      const created = await hubCreate(server.url, {
        title: "Legacy Door Combo",
        description: "create → /state → legacy positional launch must land on the checkout root",
        creator: "host",
        role: "human",
        flow: "direct",
        checkout: { kind: "worktree", path: worktree, ref: "combo" },
      });
      taskId = created.task_id;

      // ② /state exposes the frozen route to both launch doors.
      const state = (await (await fetch(new URL("/state", server.url))).json()) as {
        tasks?: Array<{ task_id: string; checkout?: unknown }>;
      };
      const entry = state.tasks?.find((task) => task.task_id === taskId);
      expect(entry?.checkout).toEqual({ kind: "worktree", path: worktree, ref: "combo" });

      // ③ The legacy positional door (`tut launch <id> <role>`): real child
      //    process, real planning, fixture herdr control plane.
      log = path.join(os.tmpdir(), `tut-combo-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
      rmSync(log, { force: true });
      await runLaunch(
        process.execPath,
        [DIST_CLI, "launch", taskId, "executor"],
        {
          env: {
            ...process.env,
            PATH: `${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
            TUT_HERDR_PANES: JSON.stringify([{
              pane_id: "w1:p0",
              label: "tut-hub",
              workspace_id: "w1",
              cwd: ANCHOR_CWD,
              tab_id: "w1:t0",
              agent_status: "idle",
            }]),
            TUT_HERDR_LOG: log,
            TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
            TUT_HUB_URL: server.url,
            TUT_PROJECT_ROOT: CHAIN_ROOT,
            TUT_USER_CONFIG_DIR: EMPTY_L2,
            TUT_READY_POLL_MS: "20",
            TUT_DELIVERY_NONCE: "A1B2C3D4",
            TUT_READY_STABLE_POLLS: "2",
            TUT_READY_FLOOR_MS: "0",
            TUT_READY_TIMEOUT_MS: "300",
            TUT_TEXT_LAND_TIMEOUT_MS: "200",
            TUT_SUBMIT_TIMEOUT_MS: "100",
            TUT_SUBMIT_RETRY_MS: "60",
            TUT_SUBMIT_RETRY_TIMEOUT_MS: "400",
          },
        },
      );
      // execFile rejects on any non-zero exit — reaching here means the
      // whole door succeeded.
      const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0);

      // ④ The round landed as an addressed birth of the executor seat.
      expect(lines.some((line) => line.startsWith("tab create "))).toBe(true);
      expect(lines.some((line) => line.includes(`rename`) && line.includes(`${taskId}.executor`))).toBe(true);

      // THE assertion: the pane is born at the worktree checkout root —
      // the legacy door must not silently fall back to the anchor cwd.
      const runLine = lines.find((line) => line.startsWith("pane run "));
      expect(runLine).toBeDefined();
      expect(runLine).toContain(`cd -- '${worktree}'`);
      expect(runLine).not.toContain(`cd -- '${ANCHOR_CWD}'`);

      // ⑤ The prompt was delivered to the born pane (closed-loop tail ran).
      const pane = runLine?.split(" ")[2] ?? "";
      expect(lines.some((line) => line.startsWith(`pane send-text ${pane} 轮到你了`))).toBe(true);
      expect(lines).toContain(`pane send-keys ${pane} Enter`);
    } finally {
      await server.close().catch(() => undefined);
      rmSync(log, { force: true });
    }
  });
});

/** Minimal /state stub on an ephemeral port — for injecting hub failure
 *  shapes the real server never produces (non-2xx, 200 without the task). */
async function stubHub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

/** R2 follow-up (review v5 P1): an unreadable hub must degrade loudly, and a
 *  200 that does not know the task must refuse — neither may silently plan a
 *  current-checkout round, which would reopen the worktree isolation breach. */
describe("legacy door: /state metadata failure modes", () => {
  const MUTATION_PREFIXES = [
    "tab create ", "pane split ", "pane run ", "pane send-text ",
    "pane send-keys ", "pane rename ", "pane move ", "pane close ",
  ];

  function launchEnv(hubUrl: string, log: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${FIXTURE_BIN}:${NODE_DIR}:/usr/bin:/bin`,
      TUT_HERDR_PANES: JSON.stringify([{
        pane_id: "w1:p0",
        label: "tut-hub",
        workspace_id: "w1",
        cwd: ANCHOR_CWD,
        tab_id: "w1:t0",
        agent_status: "idle",
      }]),
      TUT_HERDR_LOG: log,
      TUT_HERDR_READ_SCRIPT: BORN_SCREENS,
      TUT_HUB_URL: hubUrl,
      TUT_PROJECT_ROOT: CHAIN_ROOT,
      TUT_USER_CONFIG_DIR: EMPTY_L2,
      TUT_READY_POLL_MS: "20",
      TUT_DELIVERY_NONCE: "A1B2C3D4",
      TUT_READY_STABLE_POLLS: "2",
      TUT_READY_FLOOR_MS: "0",
      TUT_READY_TIMEOUT_MS: "300",
      TUT_TEXT_LAND_TIMEOUT_MS: "200",
      TUT_SUBMIT_TIMEOUT_MS: "100",
      TUT_SUBMIT_RETRY_MS: "60",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "400",
    };
  }

  it("degrades LOUDLY on a non-2xx /state: one stderr line (URL + status), door stays open on current", { timeout: 30000 }, async () => {
    const hub = await stubHub((_req, res) => {
      res.statusCode = 503;
      res.end("unavailable");
    });
    const log = path.join(os.tmpdir(), `tut-combo-503-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
    rmSync(log, { force: true });
    try {
      const r = await runLaunch(process.execPath, [DIST_CLI, "launch", "legacy-door-degrade", "executor"], {
        env: launchEnv(hub.url, log),
      });
      // execFile resolving already proves exit 0: the compatibility door
      // stays open on the documented degradation path.
      // It must never be silent: exactly one stderr note naming URL and status.
      const notes = r.stderr.match(/launch: hub state unreadable at .*\n/gu) ?? [];
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(hub.url);
      expect(notes[0]).toContain("HTTP 503");
      expect(notes[0]).toContain("using current checkout");

      // The degraded round visibly ran on the CURRENT checkout (anchor cwd).
      const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0);
      expect(lines.some((line) => line.startsWith("tab create "))).toBe(true);
      const runLine = lines.find((line) => line.startsWith("pane run "));
      expect(runLine).toBeDefined();
      expect(runLine).toContain(`cd -- '${ANCHOR_CWD}'`);
    } finally {
      await hub.close().catch(() => undefined);
      rmSync(log, { force: true });
    }
  });

  it("refuses a 200 /state that does not know the task: non-zero exit, zero Herdr mutations", { timeout: 30000 }, async () => {
    const hub = await stubHub((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tasks: [{ task_id: "some-other-task" }] }));
    });
    const log = path.join(os.tmpdir(), `tut-combo-missing-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
    rmSync(log, { force: true });
    try {
      await expect(
        runLaunch(process.execPath, [DIST_CLI, "launch", "ghost-task", "executor"], {
          env: launchEnv(hub.url, log),
        }),
      ).rejects.toThrow(/not found in hub state/u);
      // Non-zero + refusal before ANY tab/pane mutation (the implementation
      // refuses before even the discovery pane list).
      const lines = existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0)
        : [];
      for (const prefix of MUTATION_PREFIXES) {
        expect(lines.some((line) => line.startsWith(prefix))).toBe(false);
      }
    } finally {
      await hub.close().catch(() => undefined);
      rmSync(log, { force: true });
    }
  });
});

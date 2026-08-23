/**
 * Integration verification — exercises the full acceptance criteria end to end.
 *
 * The whole stack against each other, no mocks of our own code:
 *   - real `tut serve` internals (startServer on an ephemeral port, temp root),
 *   - a real Notifier polling GET /state at --interval 1s with its real agent
 *     event listener on a random free port (loopback),
 *   - real CLI drivers: hub-client context ops over real MCP HTTP, plus the
 *     `tut mode` / `tut start-next` handlers through main(),
 *   - the real glue scripts (launch.sh via the notifier's auto branch and via
 *     start-next; on-agent-event.sh as a real child process).
 *
 * The only external thing replaced is the delivery endpoint: notifications are
 * captured by a local dummy webhook server wired through the REAL config path
 * (temp config.json carries notify {channels:["webhook"], webhook_url} → the
 * /state `notify` echo → createChannels) — exactly how a Feishu/Telegram hook
 * would be plugged in. The desktop channel is never in play.
 *
 * runNotify note: the daemon entry differs from what these tests drive only by
 * its signal-park loop — runNotify is literally startEventServer() +
 * startPolling() + park-until-SIGINT/SIGTERM (src/notifier.ts). Unparking it
 * inside a vitest worker would require emitting a process-level signal, which
 * would also hit vitest's own handlers, so each test runs the SAME Notifier
 * object runNotify builds, with default deps (real fetchState, real launch.sh
 * spawn, real createChannels) and closes it cleanly. runNotify's own entry is
 * pinned by test/notifier.test.ts's EADDRINUSE cases.
 *
 * scripts/mcp-smoke.mjs is deliberately NOT invoked here: it is a standalone
 * regression tool aimed at an externally started `tut serve` (its header says
 * so), and this file does not duplicate that role — coverage here is the
 * stack (notifier, channels, CLI handlers, scripts), not the acceptance walk.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer, type RunningServer } from "../src/server.js";
import { Notifier } from "../src/notifier.js";
import { hubCreate, hubDecide, hubPublish, hubRead } from "../src/hub-client.js";
import { main } from "../src/cli.js";

// --- shared harness -----------------------------------------------------------------

/** Exactly what the webhook channel POSTs (src/channels.ts Notification). */
interface WebhookPost {
  title: string;
  body: string;
  task_id?: string;
}

interface WebhookSink {
  posts: WebhookPost[];
  url: string;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function listenLoopback(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A random free high port per run for the notifier's event listener (fixed for its lifetime). */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await listenLoopback(probe);
  const { port } = probe.address() as AddressInfo;
  await closeServer(probe);
  return port;
}

/** Local dummy webhook: records every POSTed notification, always answers 200. */
async function startWebhookSink(): Promise<WebhookSink> {
  const posts: WebhookPost[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") {
        try {
          posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as WebhookPost);
        } catch {
          // The webhook channel always sends valid JSON; unparsable traffic is
          // not a notification and would show up below as a missing post.
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await listenLoopback(server);
  const { port } = server.address() as AddressInfo;
  return { posts, url: `http://127.0.0.1:${port}/hook`, close: () => closeServer(server) };
}

/** Capture process stdout/stderr into strings (same technique as cli.test.ts). */
function captureIo(): { out(): string; err(): string; restore(): void } {
  let outText = "";
  let errText = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    outText += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errText += String(chunk);
    return true;
  });
  return { out: () => outText, err: () => errText, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

/** LIFO cleanup registry — servers, notifiers, temp dirs, spies, env vars. */
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await Promise.resolve(cleanup()).catch(() => undefined);
  }
});

/** Set an env var for the rest of the test; registers its own cleanup. */
function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  cleanups.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function waitFor<T>(label: string, pred: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = pred();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    await sleep(25);
  }
}

interface StateView {
  flow_mode: string;
  tasks: Array<{
    task_id: string;
    title: string;
    status: string;
    updated_at: string;
    needs_attention: boolean;
    waiting_for: string;
  }>;
  notify?: unknown;
}

async function getState(baseUrl: string): Promise<StateView> {
  const res = await fetch(`${baseUrl}/state`);
  expect(res.ok).toBe(true);
  return (await res.json()) as StateView;
}

async function stateEntry(baseUrl: string, taskId: string): Promise<StateView["tasks"][number]> {
  const state = await getState(baseUrl);
  const entry = state.tasks.find((t) => t.task_id === taskId);
  expect(entry).toBeDefined();
  return entry!;
}

/** The stack under test: hub (port 0, temp root, notify-wired config); the
 *  notifier is attached separately so a test can prep state first and baseline it. */
interface Stack {
  baseUrl: string;
  sink: WebhookSink;
  posts: WebhookPost[];
  eventPort?: number;
  notifier?: Notifier;
  err(): string;
  out(): string;
}

async function startStack(): Promise<Stack> {
  const io = captureIo(); // restored last: the notifier may log until it closes
  cleanups.push(() => io.restore());
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-intstack-"));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, ".context-hub");
  mkdirSync(root, { recursive: true });
  const sink = await startWebhookSink();
  cleanups.push(() => sink.close());
  // REAL config path for channel selection:
  // config.json's notify field → /state echo → createChannels, every poll.
  // auto.launch_roles: the stack's auto-mode tests launch for
  // real, so the whitelist grants the standard roles — absent would withhold
  // everything by the conservative default.
  writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify(
      {
        flow_mode: "manual",
        notify: { channels: ["webhook"], webhook_url: sink.url },
        auto: { launch_roles: ["architect", "executor", "reviewer"] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const running: RunningServer = await startServer({ root, port: 0 });
  cleanups.push(() => running.close());
  return { baseUrl: running.url, sink, posts: sink.posts, err: io.err, out: io.out };
}

/** Attach the real notifier (1s poll, random event port) — the same object
 *  runNotify builds, with default deps: real fetch, real launch.sh, real channels. */
async function attachNotifier(stack: Stack): Promise<void> {
  const eventPort = await freePort();
  const notifier = new Notifier({ url: stack.baseUrl, interval: 1, eventPort, stallTimeoutMin: 30 });
  await notifier.startEventServer();
  notifier.startPolling();
  cleanups.push(() => notifier.close());
  stack.eventPort = eventPort;
  stack.notifier = notifier;
}

/** Hub alone (mode / start-next tests need no notifier). */
async function startHubOnly(): Promise<string> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-intstack-"));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const running = await startServer({ root: path.join(tmp, ".context-hub"), port: 0 });
  cleanups.push(() => running.close());
  return running.url;
}

/** Wait until the notifier's first successful poll logged its baseline (sync point). */
async function waitForBaseline(stack: Stack): Promise<void> {
  await waitFor("notifier baseline", () => (stack.err().includes("baseline") ? true : undefined));
}

async function createTask(baseUrl: string, title: string): Promise<string> {
  const created = await hubCreate(baseUrl, { title, description: "full-stack integration task", creator: "alice", role: "architect" });
  expect(created.status).toBe("designing");
  return created.task_id;
}

/** In-table publish (asserts the write stayed clean — no attention). */
async function publish(
  baseUrl: string,
  taskId: string,
  role: string,
  contentType: string,
  payload: { summary: string; body: string; verdict?: string; ref_version?: number },
): Promise<void> {
  const out = await hubPublish(baseUrl, { task_id: taskId, role, content_type: contentType, payload });
  expect(out.needs_attention).toBe(false);
}

/** POST a real agent event at the notifier's real HTTP listener. */
async function postAgentEvent(stack: Stack, event: "working" | "blocked" | "done", agent: string, pane: string): Promise<void> {
  const port = stack.eventPort;
  expect(port).toBeDefined();
  const res = await fetch(`http://127.0.0.1:${port}/agent-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, agent, pane }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
}

function waitForPost(stack: Stack, pred: (p: WebhookPost) => boolean, timeoutMs = 4000): Promise<WebhookPost> {
  return waitFor("webhook notification", () => stack.posts.find(pred), timeoutMs);
}

/** Run a real script as a child process (on-agent-event.sh). */
function runScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const ON_AGENT_EVENT = fileURLToPath(new URL("../scripts/on-agent-event.sh", import.meta.url));

// --- 1. full-stack notification sequence ----------------------------------------------

describe("integration: full stack (serve + notifier + CLI drivers)", () => {
  it(
    "lifecycle: notification sequence follows the state machine; pane = <task_id>.<role>; approve and close are silent",
    async () => {
      const stack = await startStack();
      // Seam 1 through the real path: /state echoes the config's notify field.
      expect((await getState(stack.baseUrl)).notify).toEqual({
        channels: ["webhook"],
        webhook_url: stack.sink.url,
      });
      await attachNotifier(stack);
      await waitForBaseline(stack);
      expect(stack.posts).toHaveLength(0); // baseline never notifies

      const id = await createTask(stack.baseUrl, "Integration Lifecycle");
      // create: absent → agent:architect is a change → notifies (status designing)
      await waitForPost(stack, (p) => p.title === `TUT ${id}: waiting for agent:architect`);

      await publish(stack.baseUrl, id, "architect", "design", { summary: "design", body: "the design" });
      await waitForPost(stack, (p) => p.title === `TUT ${id}: waiting for agent:executor`);

      await publish(stack.baseUrl, id, "executor", "code_changes", {
        summary: "implementation",
        body: "changed files",
        ref_version: 1,
      });
      await waitForPost(stack, (p) => p.title === `TUT ${id}: waiting for agent:reviewer`);

      await publish(stack.baseUrl, id, "reviewer", "review", {
        summary: "pass",
        body: "ship it",
        verdict: "pass",
        ref_version: 2,
      });
      await waitForPost(stack, (p) => p.title === `TUT ${id}: waiting for human`);

      // approve: waiting_for stays "human" (pending_approval → approved) — NO notification.
      const approved = await hubDecide(stack.baseUrl, { task_id: id, decision: "approve", by: "alice" });
      expect(approved.status).toBe("approved");
      // close: waiting_for → "none" (human pressed the key) — NO notification.
      const closed = await hubDecide(stack.baseUrl, { task_id: id, decision: "close", by: "alice", reason: "merged" });
      expect(closed.status).toBe("closed");
      const final = await stateEntry(stack.baseUrl, id);
      expect(final).toMatchObject({ status: "closed", waiting_for: "none", needs_attention: false });

      // One poll cycle margin past the final write: still exactly four posts.
      await sleep(1500);
      const posts = [...stack.posts];
      expect(posts).toHaveLength(4);
      expect(posts.map((p) => p.title)).toEqual([
        `TUT ${id}: waiting for agent:architect`,
        `TUT ${id}: waiting for agent:executor`,
        `TUT ${id}: waiting for agent:reviewer`,
        `TUT ${id}: waiting for human`,
      ]);
      // Every notification carries task/status/waiting_for; agent-waiting
      // ones carry the fresh round pane `<task_id>.<role>`, human-waiting
      // ones carry no pane segment (there is no agent pane to name).
      const expected: Array<[string, string, string | null]> = [
        ["designing", "agent:architect", `${id}.architect`],
        ["implementing", "agent:executor", `${id}.executor`],
        ["reviewing", "agent:reviewer", `${id}.reviewer`],
        ["pending_approval", "human", null],
      ];
      posts.forEach((post, i) => {
        const [status, waitingFor, pane] = expected[i]!;
        expect(post.task_id).toBe(id);
        expect(post.body).toContain(`status: ${status}`);
        expect(post.body).toContain(`waiting for: ${waitingFor}`);
        if (pane !== null) expect(post.body).toContain(`pane: ${pane}`);
        else expect(post.body).not.toContain("pane:");
      });
    },
    20_000,
  );

  // --- 2. needs_attention path ---------------------------------------------------------

  it(
    "out-of-table publish: anomaly notification says `tut read`, flow notification suppressed same tick",
    async () => {
      const stack = await startStack();
      await attachNotifier(stack);
      await waitForBaseline(stack);
      const id = await createTask(stack.baseUrl, "Attention Task");
      await waitForPost(stack, (p) => p.title === `TUT ${id}: waiting for agent:architect`);

      // code_changes while designing → OUT_OF_TABLE: status stays, attention set,
      // waiting_for overridden to "human" — rising edge wins the tick.
      const out = await hubPublish(stack.baseUrl, {
        task_id: id,
        role: "executor",
        content_type: "code_changes",
        payload: { summary: "too early", body: "code before design" },
      });
      expect(out.needs_attention).toBe(true);
      expect((out.warnings ?? []).map((w) => w.code)).toContain("OUT_OF_TABLE");

      const anomaly = await waitForPost(stack, (p) => p.title === `TUT ${id}: needs attention`);
      expect(anomaly.task_id).toBe(id);
      expect(anomaly.body).toContain(`tut read ${id}`); // the hint, not the warnings content
      expect(anomaly.body).toContain("status: designing");
      // Same-tick suppression: the agent:architect → human flow change said nothing.
      expect(stack.posts.filter((p) => p.title.includes("waiting for"))).toHaveLength(1); // the create one only
      // Edge-triggered: attention already set → later polls stay silent.
      await sleep(1400);
      expect(stack.posts).toHaveLength(2);
      const entry = await stateEntry(stack.baseUrl, id);
      expect(entry).toMatchObject({ status: "designing", waiting_for: "human", needs_attention: true });
    },
    12_000,
  );

  // --- 3. cross-validation via the real event endpoint -----------------------------------

  it(
    "done event with no advance → 'stopped without publishing' after the delay window",
    async () => {
      const stack = await startStack();
      const id = await createTask(stack.baseUrl, "Cross Validate Stall");
      await publish(stack.baseUrl, id, "architect", "design", { summary: "design", body: "the design" }); // implementing
      await attachNotifier(stack); // baseline: implementing / agent:executor, silent
      await waitForBaseline(stack);
      expect(stack.posts).toHaveLength(0);

      await postAgentEvent(stack, "done", "pi-executor", id); // pane name = task_id (4.4)

      // Recheck delay = max(interval 1s, 2s) = 2s; the alarm must be the ONLY new post.
      const stopped = await waitForPost(stack, (p) => p.title === `TUT ${id}: agent stopped without publishing`, 6000);
      expect(stopped.task_id).toBe(id);
      expect(stopped.body).toContain("pi-executor");
      expect(stopped.body).toContain("agent:executor"); // the waiting_for that never advanced
      expect(stopped.body).toContain(`tut read ${id}`);
      expect(stack.posts.filter((p) => p.title.includes("stopped without publishing"))).toHaveLength(1);
      // No flow notification fired alongside: the alarm is the only post at all.
      expect(stack.posts.filter((p) => p.title.includes("waiting for"))).toHaveLength(0);
    },
    12_000,
  );

  it(
    "done event followed by a publish within the window → no false alarm, exactly one transition notification",
    async () => {
      const stack = await startStack();
      const id = await createTask(stack.baseUrl, "Cross Validate Advance");
      await publish(stack.baseUrl, id, "architect", "design", { summary: "design", body: "the design" }); // implementing
      await attachNotifier(stack);
      await waitForBaseline(stack);
      expect(stack.posts).toHaveLength(0);

      await postAgentEvent(stack, "done", "pi-executor", id);
      // The advance lands right after the event — inside the recheck window.
      await publish(stack.baseUrl, id, "executor", "code_changes", {
        summary: "implementation",
        body: "changed files",
        ref_version: 1,
      });

      // Whether the event's own compare or the next tick saw the advance, the
      // transition notifies exactly ONCE (serial queue coalescing).
      await waitForPost(stack, (p) => p.title === `TUT ${id}: waiting for agent:reviewer`, 6000);
      await sleep(1600); // past the 2s recheck point measured from the event
      expect(stack.posts.filter((p) => p.title === `TUT ${id}: waiting for agent:reviewer`)).toHaveLength(1);
      expect(stack.posts.filter((p) => p.title.includes("stopped without publishing"))).toHaveLength(0);
    },
    12_000,
  );

  // --- 4. event/tick coalescing -----------------------------------------------------------

  it(
    "done event right after the poll that already saw the change → no duplicate transition notification",
    async () => {
      const stack = await startStack();
      const id = await createTask(stack.baseUrl, "Coalescing Task");
      await publish(stack.baseUrl, id, "architect", "design", { summary: "design", body: "the design" }); // implementing
      await attachNotifier(stack);
      await waitForBaseline(stack);
      expect(stack.posts).toHaveLength(0);

      await publish(stack.baseUrl, id, "executor", "code_changes", {
        summary: "implementation",
        body: "changed files",
        ref_version: 1,
      });
      // This wait PROVES a poll already saw implementing → reviewing.
      await waitForPost(stack, (p) => p.title === `TUT ${id}: waiting for agent:reviewer`);

      // Event arrives AFTER that poll: its compare must not re-notify, and the
      // next advance (within the recheck window) keeps the cross-validator quiet.
      await postAgentEvent(stack, "done", "pi-reviewer", id);
      await publish(stack.baseUrl, id, "reviewer", "review", {
        summary: "issues found",
        body: "fix the thing",
        verdict: "fail_code",
        ref_version: 2,
      });
      await waitForPost(stack, (p) => p.title === `TUT ${id}: waiting for agent:executor` && p.body.includes("status: revising"), 6000);

      await sleep(1600); // past the recheck point
      expect(stack.posts.filter((p) => p.title === `TUT ${id}: waiting for agent:reviewer`)).toHaveLength(1);
      expect(stack.posts.filter((p) => p.title.includes("stopped without publishing"))).toHaveLength(0);
      // Full ordered sequence: reviewing → revising (baseline covered implementing).
      expect(stack.posts.map((p) => p.title)).toEqual([
        `TUT ${id}: waiting for agent:reviewer`,
        `TUT ${id}: waiting for agent:executor`,
      ]);
      expect(stack.posts[1]!.body).toContain("status: revising");
    },
    14_000,
  );

  // --- 5. tut mode end-to-end -------------------------------------------------------------

  it("mode manual→auto→manual via the CLI path flips /state flow_mode (config keys preserved)", async () => {
    const baseUrl = await startHubOnly();
    const io = captureIo();
    cleanups.push(() => io.restore());

    expect(await main(["mode", "auto", "--url", baseUrl])).toBe(0);
    expect(io.out()).toContain('"flow_mode":"auto"');
    expect((await getState(baseUrl)).flow_mode).toBe("auto");

    expect(await main(["mode", "manual", "--url", baseUrl])).toBe(0);
    const state = await getState(baseUrl);
    expect(state.flow_mode).toBe("manual");
  });

  it(
    "auto mode + TUT_DRY_RUN: gate-passing hand-off runs launch.sh dry-run and notifies 'auto-launched'",
    async () => {
      const stack = await startStack();
      setEnv("TUT_DRY_RUN", "1"); // passes through the notifier's spawn to launch.sh
      // Hermetic launch path: fixture bin first on PATH — fixture pi satisfies
      // the routed-agent pre-check, fixture herdr answers pane list with no
      // panes — so launch.sh's dry-run needs no live Herdr session.
      setEnv("PATH", `${path.resolve(import.meta.dirname, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`);
      const id = await createTask(stack.baseUrl, "Auto Launch Task");
      await attachNotifier(stack); // baseline: designing / agent:architect (manual), silent
      await waitForBaseline(stack);
      expect(stack.posts).toHaveLength(0);
      setEnv("TUT_USER_CONFIG_DIR", mkdtempSync(path.join(os.tmpdir(), "tut-int-l2-"))); // hermetic L2

      expect(await main(["mode", "auto", "--url", stack.baseUrl])).toBe(0);
      // The notify config survived the key-preserving /mode write (seam 1 stays live in auto).
      expect((await getState(stack.baseUrl)).notify).toEqual({
        channels: ["webhook"],
        webhook_url: stack.sink.url,
      });

      // design → implementing hands off to agent:executor; gate passes
      // (prev status designing, no attention) → launch.sh executor (pane exec).
      await publish(stack.baseUrl, id, "architect", "design", { summary: "design", body: "the design" });
      const launched = await waitForPost(stack, (p) => p.title === `TUT ${id}: auto-launched executor`, 6000);
      expect(launched.body).toContain("status: implementing");
      expect(launched.body).toContain(`pane: ${id}.executor`);
      // The notifier's launch log carries launch.sh's dry-run stdout: the
      // chain routes executor → pi (DEFAULT_ROLES at the clean L2), and the
      // prompt names the task. Dry-run may open with provisioning
      // preview/skip lines — assert on the send-text line, independent of
      // line order.
      const launchLines = stack.err().split("\n").filter((l) => l.includes(`launch.sh (${id}, executor)`));
      expect(launchLines.length).toBeGreaterThan(0);
      const sendText = launchLines.find((l) => l.includes("DRY-RUN: herdr pane send-text"));
      expect(sendText).toBeDefined();
      expect(sendText).toContain("(agent 'pi', label");
      expect(sendText).toContain(id);
      // Auto branch does NOT also send the manual-style flow notification.
      expect(stack.posts.filter((p) => p.title.includes("waiting for agent:executor"))).toHaveLength(0);
    },
    12_000,
  );

  it(
    "auto mode: transition into pending_approval does NOT launch — it notifies the human instead",
    async () => {
      const stack = await startStack();
      setEnv("TUT_DRY_RUN", "1"); // even so, no launch may happen
      const id = await createTask(stack.baseUrl, "Auto Gate Task");
      await publish(stack.baseUrl, id, "architect", "design", { summary: "design", body: "the design" });
      await publish(stack.baseUrl, id, "executor", "code_changes", {
        summary: "implementation",
        body: "changed files",
        ref_version: 1,
      }); // reviewing / agent:reviewer
      await attachNotifier(stack);
      await waitForBaseline(stack);
      expect(stack.posts).toHaveLength(0);
      setEnv("TUT_USER_CONFIG_DIR", mkdtempSync(path.join(os.tmpdir(), "tut-int-l2-"))); // hermetic L2

      expect(await main(["mode", "auto", "--url", stack.baseUrl])).toBe(0);

      // review pass → pending_approval / waiting for human: gated.
      await publish(stack.baseUrl, id, "reviewer", "review", {
        summary: "pass",
        body: "ship it",
        verdict: "pass",
        ref_version: 2,
      });
      const gated = await waitForPost(stack, (p) => p.title === `TUT ${id}: human decision needed`, 6000);
      expect(gated.body).toContain("status: pending_approval");
      expect(gated.body).toContain("auto launch withheld");
      // No launch happened at all — no launcher log line, no auto-launched post.
      expect(stack.err().includes("launch.sh (")).toBe(false);
      expect(stack.posts.filter((p) => p.title.includes("auto-launched"))).toHaveLength(0);
    },
    15_000,
  );

  // --- 6. start-next via the CLI ------------------------------------------------------------

  it("start-next spawns launch.sh (TUT_DRY_RUN) naming the routed pane and the task", async () => {
    const baseUrl = await startHubOnly();
    const id = await createTask(baseUrl, "Start Next Integration");
    await publish(baseUrl, id, "architect", "design", { summary: "design", body: "the design" }); // → agent:executor

    setEnv("TUT_DRY_RUN", "1");
    setEnv("TUT_USER_CONFIG_DIR", mkdtempSync(path.join(os.tmpdir(), "tut-int-l2-"))); // hermetic L2
    const io = captureIo();
    cleanups.push(() => io.restore());

    expect(await main(["start-next", id, "--url", baseUrl])).toBe(0);
    const out = io.out();
    expect(out).toContain("DRY-RUN: herdr pane send-text"); // literal text + Enter commit
    expect(out).toContain("--label TUT executor"); // tab label: naming template (default)
    expect(out).toContain("(agent 'pi', label");
    expect(out).toContain(id); // the prompt tells the agent which task to read
    expect(out).toContain(`launched executor for ${id}`);
    const log = await hubRead(baseUrl, id);
    expect(log.versions.at(-1)?.payload.launch).toEqual({ role: "executor", base_version: 1, via: "start-next" });
  });

  // --- 7. on-agent-event.sh ------------------------------------------------------------------

  it(
    "on-agent-event.sh forwards a blocked event to the live notifier (child process, real port)",
    async () => {
      const stack = await startStack();
      const id = await createTask(stack.baseUrl, "Signal Source Task");
      await publish(stack.baseUrl, id, "architect", "design", { summary: "design", body: "the design" }); // implementing
      await attachNotifier(stack);
      await waitForBaseline(stack);
      expect(stack.posts).toHaveLength(0);

      const run = await runScript(ON_AGENT_EVENT, ["blocked", "codex", id], {
        ...process.env,
        TUT_EVENT_PORT_URL: `http://127.0.0.1:${stack.eventPort}/agent-event`,
      });
      expect(run.code).toBe(0);

      // Observable effect: the stuck-agent notification arrives via the webhook.
      const stuck = await waitForPost(stack, (p) => p.title === `TUT ${id}: agent stuck`, 4000);
      expect(stuck.body).toContain("codex");
      expect(stuck.body).toContain(id); // the pane
      expect(stuck.task_id).toBe(id);
    },
    12_000,
  );

  it("on-agent-event.sh exits 0 when the notifier port is unreachable (lost signal is acceptable)", async () => {
    const run = await runScript(ON_AGENT_EVENT, ["done", "codex", "some-task"], {
      ...process.env,
      TUT_EVENT_PORT_URL: "http://127.0.0.1:9/agent-event", // nothing listens there
    });
    expect(run.code).toBe(0);
  }, 8_000);
});

// --- --url real chain --------------------------------------------------------------
// The additive --url revision proven against a REAL hub on a REAL non-default
// (ephemeral) port: the CLI context commands round-trip through --url exactly
// like they do against the default 3001 — no mocks of our own code (the file's
// standing rule).
describe("--url real chain (context commands against an ephemeral-port hub)", () => {
  it("create → read → list round-trip via --url", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-urlchain-"));
    const root = path.join(tmp, ".context-hub");
    const running: RunningServer = await startServer({ root, port: 0 });
    const baseUrl = running.url;
    let outText = "";
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outText += String(chunk);
      return true;
    });
    try {
      expect(baseUrl).not.toBe("http://127.0.0.1:3001"); // ephemeral ⇒ non-default by construction

      expect(await main(["create", "--title", "url override roundtrip", "--description", "d", "--creator", "t", "--role", "architect", "--url", baseUrl])).toBe(0);
      const created = JSON.parse(outText.trim().split("\n")[0]!) as { task_id: string; status: string };
      expect(created.status).toBe("designing");

      outText = "";
      expect(await main(["read", created.task_id, "--url", baseUrl])).toBe(0);
      expect(outText).toContain("url override roundtrip");

      outText = "";
      expect(await main(["list", "--url", baseUrl, "--json"])).toBe(0);
      expect(outText).toContain(created.task_id);
    } finally {
      out.mockRestore();
      await running.close().catch(() => undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
// --- per-task cast routing (real hub, real CLI handlers, launcher dry-run) ------------

describe("cast routing end-to-end", () => {
  it("create --cast routes start-next to the cast agent; no-cast task stays on the default lineup", async () => {
    const baseUrl = await startHubOnly();
    const io = captureIo();
    const lastJson = (): any => JSON.parse(io.out().trim().split("\n").pop()!); // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      // Cast task: executor routed to codex (the default executor is pi — the
      // assertion can tell the cast apart from the default).
      await main([
        "create", "--title", "Cast Routing Task", "--description", "d", "--creator", "t", "--role", "architect",
        "--cast", "executor=codex", "--url", baseUrl,
      ]);
      const castId = lastJson().task_id as string;
      await main([
        "publish", castId, "--role", "architect", "--content-type", "design",
        "--summary", "s", "--body", "b", "--url", baseUrl,
      ]);
      lastJson(); // drain
      await main(["read", castId, "--json", "--url", baseUrl]);
      const read = lastJson() as { cast?: unknown; flow?: string };
      expect(read.cast).toEqual({ executor: "codex" }); // round-trips through the real hub
      expect(read.flow).toBe("full"); // deferred registration item on the real read path

      const prev = process.env.TUT_DRY_RUN;
      process.env.TUT_DRY_RUN = "1";
      // Hermetic chain for the no-cast task's resolution: clean L1 (temp
      // cwd) + pinned empty L2 → DEFAULT_ROLES (executor=pi), never the
      // repo's live .context-hub config or the machine's user-level one.
      const chainTmp = mkdtempSync(path.join(os.tmpdir(), "tut-cast-chain-"));
      const prevCwd = process.cwd();
      const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
      process.chdir(chainTmp);
      process.env.TUT_USER_CONFIG_DIR = path.join(chainTmp, "user-config");
      try {
        await main(["start-next", castId, "--url", baseUrl]);
        expect(io.out()).toContain("(agent 'codex', label"); // cast routed the round to codex

        // Regression (zero migration): a no-cast task routes through the
        // default chain (executor → pi via DEFAULT_ROLES).
        await main([
          "create", "--title", "Plain Routing Task", "--description", "d", "--creator", "t", "--role", "architect",
          "--url", baseUrl,
        ]);
        const plainId = lastJson().task_id as string;
        await main([
          "publish", plainId, "--role", "architect", "--content-type", "design",
          "--summary", "s", "--body", "b", "--url", baseUrl,
        ]);
        lastJson(); // drain
        await main(["start-next", plainId, "--url", baseUrl]);
        expect(io.out()).toContain("(agent 'pi', label");
      } finally {
        process.chdir(prevCwd);
        if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
        else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
        rmSync(chainTmp, { recursive: true, force: true });
        if (prev === undefined) delete process.env.TUT_DRY_RUN;
        else process.env.TUT_DRY_RUN = prev;
      }
    } finally {
      io.restore();
    }
  });
});

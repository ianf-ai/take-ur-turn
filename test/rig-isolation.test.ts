import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import { hubCreate, hubRead } from "../src/hub-client.js";
import { rigLabel, rigEnvironment, rigHash } from "../src/rig.js";
import { selectAnchor } from "../src/launcher/anchor.js";
import { buildLaunchInvocation } from "../src/launcher/invocation.js";
import { renderInvocationPaneCommand } from "../src/launcher/compat.js";
import { birthPane } from "../src/launcher/birth.js";
import { cleanupTaskPanes, runRoundLifecycle } from "../src/launcher/lifecycle.js";
import type { HerdrPane } from "../src/launcher/herdr-client.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const reporter = path.resolve("scripts/on-agent-event.mjs");

describe("rig isolation", () => {
  it("two simultaneous hubs receive only their own born workers' publishes and events", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "tut-two-rigs-"));
    const running: Awaited<ReturnType<typeof startServer>>[] = [];
    const eventServers: ReturnType<typeof createServer>[] = [];
    const received: unknown[][] = [[], []];
    const labels: string[] = [];
    const panes: HerdrPane[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const root = path.join(base, `rig${i}`);
        await mkdir(root);
        const hub = await startServer({ root: path.join(root, ".context-hub"), port: 0 });
        running.push(hub);
        const task = await hubCreate(hub.url, { title: "same task", description: "isolation", creator: "test", role: "executor", flow: "direct" });
        expect(task.task_id).toBe("same-task");
        const sink = createServer((req, res) => {
          let body = "";
          req.on("data", chunk => { body += String(chunk); });
          req.on("end", () => { received[i]!.push(JSON.parse(body)); res.end("ok"); });
        });
        eventServers.push(sink);
        await new Promise<void>(resolve => sink.listen(0, "127.0.0.1", resolve));
        const anchor = { workspace_id: `w${i}`, pane_id: `hub${i}`, cwd: root };
        panes.push({ ...anchor, label: rigLabel("tut-hub", root) });
        labels.push(rigLabel("tut-hub", root), rigLabel("tut-notify", root), rigLabel("same-task.executor", root));
      }
      // Both listeners must be live before either worker starts: otherwise
      // the first publish would only prove the single-rig path.
      for (let i = 0; i < 2; i++) {
        const root = path.join(base, `rig${i}`);
        const hub = running[i]!;
        const eventUrl = `http://127.0.0.1:${(eventServers[i]!.address() as AddressInfo).port}/agent-event`;
        const anchor = { workspace_id: `w${i}`, pane_id: `hub${i}`, cwd: root };
        const worker = `const {execFileSync}=require('node:child_process'); execFileSync(process.execPath, [${JSON.stringify(cli)}, 'publish', 'same-task', '--role', 'executor', '--content-type', 'note', '--summary', 'rig${i}', '--body', 'worker${i}']); execFileSync(process.execPath, [${JSON.stringify(reporter)}, 'working', 'node', ${JSON.stringify(rigLabel("same-task.executor", root))}]);`;
        const workerPath = path.join(root, "worker.cjs");
        await writeFile(workerPath, worker);
        const invocation = buildLaunchInvocation({
          request: { kind: "round", task_id: "same-task", role: "executor", fresh: false, via: "legacy" },
          base_version: 0, hub_url: hub.url, route: { agent: process.execPath, args: [workerPath] }, route_source: "builtin-default",
          context: { anchor, hubRoot: root, routingRoot: root, checkoutRoot: root, checkout: { kind: "current" }, context: { kind: "shared" }, source: "anchor" },
          naming: { tab_label: "TUT executor", pane_label: rigLabel("same-task.executor", root) }, prompt: "test",
          posix_direct: { executable: process.execPath, args: [workerPath], env: { TUT_EVENT_PORT_URL: eventUrl } },
        });
        const commandText = renderInvocationPaneCommand(invocation, "posix").command_text;
        const calls: string[][] = [];
        const paneId = await birthPane({
          anchor, birthCwd: root, tabLabel: "TUT executor", paneLabel: invocation.naming.pane_label,
          commandText, paneEnvironment: rigEnvironment(root, hub.url, eventUrl),
          client: { command: async (args: readonly string[]) => {
            calls.push([...args]);
            if (args[0] === "pane" && args[1] === "run") await exec("/bin/sh", ["-c", args[3]!], { env: { ...process.env, TUT_HUB_URL: "http://127.0.0.1:1", TUT_EVENT_PORT_URL: "http://127.0.0.1:1/agent-event" } });
            return { code: 0, signal: null, stderr: "", stdout: JSON.stringify({ result: { tab: { tab_id: `tab${i}` }, root_pane: { pane_id: `worker${i}` } } }) };
          } },
        });
        expect(paneId).toBe(`worker${i}`);
        expect(calls).toContainEqual(["pane", "rename", `worker${i}`, rigLabel("same-task.executor", root)]);
      }
      expect(new Set(labels).size).toBe(6);
      for (let i = 0; i < 2; i++) {
        const root = path.join(base, `rig${i}`);
        expect(selectAnchor([...panes].reverse(), undefined, root)?.anchor.pane_id).toBe(`hub${i}`);
        const records = (await hubRead(running[i]!.url, "same-task")).versions;
        expect(records.map(r => r.payload.summary)).toEqual([`rig${i}`]);
        expect(received[i]).toEqual([{ event: "working", agent: "node", pane: rigLabel("same-task.executor", root) }]);
      }
    } finally {
      await Promise.all(running.map(hub => hub.close()));
      await Promise.all(eventServers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      await rm(base, { recursive: true, force: true });
    }
  });

  it("continuation, --fresh and cleanup affect only the owning root", async () => {
    const own = "/rig-a", foreign = "/rig-b";
    const panes = [own, foreign].map((root, i) => ({ pane_id: `p${i}`, label: rigLabel("same.executor", root), agent_status: "done" }));
    const closed: string[] = [];
    const client = { listPanes: async () => panes.filter(p => !closed.includes(p.pane_id)), closePane: async (id: string) => { closed.push(id); } };
    const invocation = { task_id: "same", role: "executor", fresh: false, context: { hubRoot: own }, naming: { tab_label: "TUT executor", pane_label: rigLabel("same.executor", own) } };
    const continued = vi.fn(async () => true);
    await runRoundLifecycle({ invocation, client, onContinuation: continued, onBirth: async () => "new" });
    expect(continued).toHaveBeenCalledWith(panes[0]);
    await runRoundLifecycle({ invocation: { ...invocation, fresh: true }, client, onContinuation: continued, onBirth: async () => "new" });
    expect(closed).toEqual(["p0"]);
    await cleanupTaskPanes({ task_id: "same", hubRoot: own, client });
    expect(closed).toEqual(["p0"]);
    expect(rigHash(own)).toMatch(/^[a-f0-9]{8}$/);
  });
});

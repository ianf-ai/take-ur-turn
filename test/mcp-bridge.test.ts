import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runMcpBridge, type BridgeOptions } from "../src/mcp/stdio-bridge.js";
import { startServer, type RunningServer } from "../src/hub/server.js";
import { parseArgs, USAGE } from "../src/cli.js";

const realFetch = globalThis.fetch;
const preferred = "http://127.0.0.1:3001";
const discovered = "http://127.0.0.1:3003";
let tmp: string;
let own: string;
let foreign: string;
let servers: RunningServer[];
let routes: Map<string, string>;
let traffic: { url: string; method: string; body?: string }[];
let cleanup: (() => Promise<void>)[];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "tut-mcp-bridge-")));
  own = path.join(tmp, "own");
  foreign = path.join(tmp, "foreign");
  servers = []; routes = new Map(); traffic = []; cleanup = [];
  // The production discovery range is virtual. Only explicitly registered
  // ephemeral servers can receive HTTP; no developer rig is ever contacted.
  vi.stubGlobal("fetch", async (target: string | URL, init?: RequestInit) => {
    const url = new URL(target);
    traffic.push({ url: url.href, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const mapped = routes.get(url.origin);
    if (!mapped) throw new TypeError("fetch failed: isolated dead port");
    return realFetch(new URL(url.pathname, mapped), init);
  });
});
afterEach(async () => {
  await Promise.allSettled(cleanup.map(fn => fn()));
  await Promise.allSettled(servers.map(server => server.close()));
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});
async function hub(root = own, route = preferred) {
  const server = await startServer({ root: path.join(root, ".context-hub"), port: 0 });
  servers.push(server);
  routes.set(route, server.url);
  return server;
}
function bridge(overrides: Partial<BridgeOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let wire = "";
  output.on("data", chunk => { wire += chunk.toString(); });
  const logs: string[] = [];
  const controller = new AbortController();
  const result = runMcpBridge({ url: preferred, root: own, input, output,
    diagnostic: line => logs.push(line), heartbeatMs: 20, retryDelays: [5, 10, 20, 40, 80],
    signal: controller.signal, ...overrides });
  const client = new Client({ name: "stdio-test-client", version: "1.0" });
  const connected = () => client.connect(new StdioServerTransport(output, input));
  cleanup.push(async () => {
    controller.abort();
    await result;
    await client.close();
    input.destroy(); output.destroy();
  });
  // SDK clients may strip unknown serverInfo fields; assert the actual wire reply.
  const serverInfo = () => JSON.parse(wire.split("\n")[0]!).result.serverInfo;
  return { result, client, connected, logs, input, controller, serverInfo };
}
function data(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}

describe("workspace stdio MCP bridge", () => {
  it("advertises a strict CLI command", () => {
    expect(USAGE).toContain("tut mcp");
    expect(parseArgs(["mcp"])).toEqual({ command: "mcp" });
    expect(parseArgs(["mcp", "--url", preferred]).command).toBe("usage");
  });

  it("initializes over real stdio framing, lists the Hub's five tools, and persists create/read", async () => {
    await hub();
    const b = bridge();
    await b.connected();
    expect(b.client.getServerVersion()?.name).toBe("tut-context-hub");
    expect(b.serverInfo()).toEqual({ ...b.client.getServerVersion(), hubUrl: preferred, hubRoot: own });
    const tools = await b.client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      "context.create", "context.decide", "context.list", "context.publish", "context.read",
    ]);
    const created = data(await b.client.callTool({ name: "context.create", arguments: {
      title: "Bridge roundtrip", description: "stdio to HTTP", creator: "test", role: "executor", flow: "direct",
    } }));
    const read = data(await b.client.callTool({ name: "context.read", arguments: { task_id: created.task_id } }));
    expect(read).toMatchObject({ title: "Bridge roundtrip", description: "stdio to HTTP", status: "implementing" });
    const error = await b.client.callTool({ name: "context.read", arguments: { task_id: "missing" } });
    expect(error.isError).toBe(true);
    expect(b.logs.some(line => line.includes("RECONNECT"))).toBe(false);
    b.input.end();
    expect(await b.result).toBe(0);
  });

  it("runs the built CLI as a child stdio server using its pinned workspace root", async () => {
    const running = await hub();
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.resolve("dist/cli.js"), "mcp"], cwd: tmp,
      env: { PATH: process.env.PATH ?? "", TUT_HUB_URL: running.url, TUT_HUB_ROOT: own },
      stderr: "pipe" });
    const client = new Client({ name: "child-test", version: "1.0" });
    cleanup.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(5);
  });

  it("skips a foreign hub on virtual 3001 and discovers its own hub on 3003", async () => {
    await hub(foreign);
    await hub(own, discovered);
    const b = bridge();
    await b.connected();
    expect(b.serverInfo()).toEqual({ ...b.client.getServerVersion(), hubUrl: discovered, hubRoot: own });
    await b.client.listTools();
    expect(traffic.some(t => t.url === `${preferred}/mcp`)).toBe(false);
    expect(traffic.some(t => t.url === `${discovered}/mcp`)).toBe(true);
  });

  it("reports verified identity in the built CLI's raw initialize response", async () => {
    const running = await hub();
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), "mcp"], {
      cwd: own,
      env: { PATH: process.env.PATH ?? "", TUT_HUB_URL: running.url },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanup.push(async () => { if (child.exitCode === null) child.kill(); });
    const lines = createInterface({ input: child.stdout });
    const response = once(lines, "line");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "raw-test", version: "1" },
    } }) + "\n");
    const [line] = await response;
    expect(JSON.parse(line).result.serverInfo).toMatchObject({
      name: "tut-context-hub", hubUrl: running.url, hubRoot: own,
    });
    const exited = once(child, "exit");
    child.stdin.end();
    expect((await exited)[0]).toBe(0);
    lines.close();
  });

  it("fails closed when every candidate is foreign, without sending initialize", async () => {
    await hub(foreign);
    const b = bridge();
    expect(await b.result).toBe(2);
    expect(b.logs.join("\n")).toMatch(/MCP_INITIAL_CONNECTION.*No verified hub/);
    expect(traffic.some(t => t.url.endsWith("/mcp"))).toBe(false);
  });

  it("refuses missing identity and remote URLs without MCP traffic", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ tasks: [] })));
    const b = bridge({ discoveryUrls: [] });
    expect(await b.result).toBe(2);
    const remote = bridge({ url: "http://example.com:3001" });
    expect(await remote.result).toBe(2);
    expect(remote.logs.join("\n")).toContain("MCP_LOCAL_URL_REQUIRED");
  });

  it.each([preferred, discovered])("recovers an idle connection when the Hub returns at %s", async next => {
    const old = await hub();
    const b = bridge();
    await b.connected();
    routes.delete(preferred);
    await old.close();
    await vi.waitFor(() => expect(b.logs.some(line => line.includes("MCP_RECONNECT:"))).toBe(true));
    await hub(own, next);
    await vi.waitFor(() => expect(b.logs.some(line => line.includes("MCP_RECONNECTED:"))).toBe(true));
    expect((await b.client.listTools()).tools).toHaveLength(5);
  });

  it("never forwards to a port taken over by another workspace, then exits 3 on exhaustion", async () => {
    const old = await hub();
    const b = bridge({ heartbeatMs: 60_000 });
    await b.connected();
    await old.close();
    await hub(foreign);
    traffic.length = 0;
    await expect(b.client.listTools()).rejects.toThrow();
    expect(await b.result).toBe(3);
    expect(b.logs.join("\n")).toContain("MCP_RECONNECT_EXHAUSTED");
    expect(traffic.some(t => t.url.endsWith("/mcp"))).toBe(false);
  });

  it("does not replay a write whose response was lost", async () => {
    await hub();
    const b = bridge();
    await b.connected();
    const mappedFetch = globalThis.fetch;
    let loseResponse = true;
    vi.stubGlobal("fetch", async (target: string | URL, init?: RequestInit) => {
      const response = await mappedFetch(target, init);
      if (loseResponse && typeof init?.body === "string" && init.body.includes('"context.create"')) {
        loseResponse = false;
        await response.text(); // the real Hub committed; only the response is lost
        throw new TypeError("fetch failed: response lost");
      }
      return response;
    });
    await expect(b.client.callTool({ name: "context.create", arguments: {
      title: "Exactly once", description: "unknown outcome", creator: "test", role: "executor",
    } })).rejects.toThrow();
    await vi.waitFor(() => expect(b.logs.some(line => line.includes("MCP_RECONNECTED:"))).toBe(true));
    const list = data(await b.client.callTool({ name: "context.list", arguments: {} }));
    expect(list.tasks.filter((task: { title: string }) => task.title === "Exactly once")).toHaveLength(1);
    expect(traffic.filter(t => t.body?.includes('"context.create"'))).toHaveLength(1);
  });
});

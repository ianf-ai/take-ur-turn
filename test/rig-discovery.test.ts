import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";

// Virtualize only fixed port occupancy. HTTP/MCP below use real ephemeral
// servers, so this suite never binds or mutates a developer's live 3001 rig.
const availability = vi.hoisted(() => vi.fn(async (_port: number) => true));
vi.mock("../src/rig-discovery.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/rig-discovery.js")>();
  return { ...actual, resolveUpHub: (url: string, explicit: boolean, root: string, event?: number) =>
    actual.resolveUpHub(url, explicit, root, event, availability) };
});

import { canonicalRoot, portFree, probeHub, resolveCliHubUrl, resolveRigRoot, resolveUpHub } from "../src/rig-discovery.js";
import { startServer, type RunningServer } from "../src/server.js";
import { hubCreate, hubList } from "../src/hub-client.js";
import { main } from "../src/cli.js";
import { rigLabel } from "../src/rig.js";

const cwd = process.cwd();
const repo = path.resolve(import.meta.dirname, "..");
const realFetch = globalThis.fetch;
let tmp: string;
let a: string;
let b: string;
let servers: RunningServer[];
let endpoints: Map<string, string>;
let output: string;
let errors: string;
let log: string;
let provision: boolean;
let notifierIdentities: Map<string, { hub_root?: string; hub_url?: string }>;
let bServer: RunningServer | undefined;

function logText(): string { try { return readFileSync(log, "utf8"); } catch { return ""; } }
async function start(root: string): Promise<RunningServer> {
  const server = await startServer({ root: path.join(root, ".context-hub"), port: 0 });
  servers.push(server);
  return server;
}
async function seed(server: RunningServer, title: string): Promise<void> {
  await hubCreate(server.url, { title, description: "isolated rig fixture", creator: "tester", role: "executor", flow: "direct" });
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "tut-handshake-")));
  a = path.join(tmp, "a"); b = path.join(tmp, "b");
  mkdirSync(path.join(a, ".context-hub"), { recursive: true });
  mkdirSync(path.join(b, ".context-hub"), { recursive: true });
  process.chdir(b);
  for (const name of ["TUT_HUB_ROOT", "TUT_HUB_URL"]) vi.stubEnv(name, "");
  // Empty URL values are not part of this fixture's configuration.
  delete process.env.TUT_HUB_URL; delete process.env.TUT_HUB_ROOT;
  vi.stubEnv("PATH", `${path.join(repo, "test/bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`);
  vi.stubEnv("TUT_UP_CLI_SELF", path.join(repo, "dist/cli.js"));
  vi.stubEnv("TUT_USER_CONFIG_DIR", path.join(tmp, "user"));
  log = path.join(tmp, "herdr.log");
  vi.stubEnv("TUT_HERDR_LOG", log);
  vi.stubEnv("TUT_HERDR_PANES", JSON.stringify([
    { pane_id: "FOREIGN:hub", label: rigLabel("tut-hub", a), tab_id: "FOREIGN" },
    { pane_id: "FOREIGN:notify", label: rigLabel("tut-notify", a), tab_id: "FOREIGN" },
  ]));
  notifierIdentities = new Map([["3002", { hub_root: a, hub_url: "http://127.0.0.1:3001" }]]);
  servers = []; endpoints = new Map(); output = ""; errors = ""; provision = false; bServer = undefined;
  availability.mockReset().mockImplementation(async port => port !== 3001 && port !== 3002);
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => { errors += String(chunk); return true; });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/agent-event" && notifierIdentities.has(url.port)) {
      return new Response(JSON.stringify(notifierIdentities.get(url.port)), { status: 405, headers: { Allow: "POST" } });
    }
    if (url.hostname !== "127.0.0.1" || Number(url.port) < 3001 || Number(url.port) > 3200) {
      return realFetch(input, init);
    }
    if (provision && url.port === "3003" && !bServer && logText().includes(" serve --port 3003")) {
      bServer = await start(b);
      endpoints.set("3003", bServer.url);
    }
    if (url.pathname === "/agent-event") {
      if (url.port === "3004" && logText().includes(" notify --url http://127.0.0.1:3003 --event-port 3004")) {
        notifierIdentities.set("3004", { hub_root: b, hub_url: "http://127.0.0.1:3003" });
      }
      const identity = notifierIdentities.get(url.port);
      if (identity) return new Response(JSON.stringify(identity), { status: 405, headers: { Allow: "POST" } });
      throw new TypeError("fetch failed: virtual event port unbound");
    }
    const endpoint = endpoints.get(url.port);
    if (!endpoint) throw new TypeError("fetch failed: virtual port unbound");
    return realFetch(new URL(url.pathname, endpoint), init);
  });
});

afterEach(async () => {
  for (const server of servers) await server.close();
  process.chdir(cwd);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("Hub root handshake", () => {
  it("A at 3001: B up selects 3003/3004, namespaces panes, and default list keeps pools separate", async () => {
    const aServer = await start(a); await seed(aServer, "Only A");
    endpoints.set("3001", aServer.url); provision = true;
    const before = await hubList(aServer.url);
    expect(await main(["up"]), errors).toBe(0);
    expect(output).toContain("hub serving on http://127.0.0.1:3003");
    expect(logText()).toContain("--event-port 3004");
    expect(logText()).toContain(rigLabel("tut-hub", b));
    expect(logText()).not.toMatch(/pane (?:run|move|close|rename) FOREIGN:/);
    expect(bServer).toBeDefined();
    await seed(bServer!, "Only B");
    output = "";
    expect(await main(["list", "--json"]), errors).toBe(0);
    expect(output).toContain("only-b"); expect(output).not.toContain("only-a");
    const provisionLog = logText();
    expect(await main(["up"]), errors).toBe(0);
    expect(logText().slice(provisionLog.length)).not.toMatch(/pane (?:run|split|rename|move)/);
    process.chdir(a); output = "";
    expect(await main(["list", "--json"]), errors).toBe(0);
    expect(output).toContain("only-a"); expect(output).not.toContain("only-b");
    expect(await hubList(aServer.url)).toEqual(before);
  });

  it("explicit foreign --url rejects up, reads, and writes before pane/task mutations", async () => {
    const aServer = await start(a); await seed(aServer, "Only A"); endpoints.set("3001", aServer.url);
    const before = await hubList(aServer.url);
    for (const args of [["up"], ["list"], ["doctor"], ["create", "--title", "Forbidden", "--description", "d", "--creator", "t", "--role", "executor"]]) {
      const beforeLog = logText();
      expect(await main([...args, "--url=http://127.0.0.1:3001"])).toBe(1);
      expect(logText().slice(beforeLog.length)).toBe(args[0] === "doctor" ? "pane list\n" : "");
      expect(errors).toContain("foreign hub / workspace mismatch");
      expect(errors).toContain("tut up");
    }
    // Doctor scans labels read-only even while Hub identity is unverified.
    expect(logText()).toBe("pane list\n"); expect(await hubList(aServer.url)).toEqual(before);
  });

  it("single rig reuses default hub and notifier without pane mutations", async () => {
    const server = await start(b); endpoints.set("3001", server.url);
    notifierIdentities.set("3002", { hub_root: b, hub_url: "http://127.0.0.1:3001" });
    expect(await main(["up"]), errors).toBe(0);
    expect(output).toContain("hub already running (http://127.0.0.1:3001/state)");
    expect(logText()).not.toMatch(/pane (?:run|split|rename|move)/);
    expect(availability).not.toHaveBeenCalled();
    expect(output).toContain(`ownership check found hub for workspace ${b}`);
    expect(existsSync(path.join(b, ".context-hub/up.lock"))).toBe(false);
  });

  it("rechecks ownership after selecting ports and reuses a recovered orphan hub", async () => {
    const server = await start(b);
    availability.mockImplementation(async port => {
      // Initial discovery missed this hub. It recovers during pair selection.
      if (port === 3004) {
        endpoints.set("3101", server.url);
        notifierIdentities.set("3102", { hub_root: b, hub_url: "http://127.0.0.1:3101" });
      }
      return port !== 3001 && port !== 3002;
    });
    expect(await main(["up"]), errors).toBe(0);
    expect(output).toContain(`ownership check found hub for workspace ${b} at http://127.0.0.1:3101`);
    expect(output).toContain("notify already listening (http://127.0.0.1:3102/agent-event)");
    expect(logText()).not.toMatch(/pane (?:run|split|rename|move)/);
    expect(existsSync(path.join(b, ".context-hub/up.lock"))).toBe(false);
  });

  it("rejects a live startup owner before probes or pane mutations", async () => {
    const lock = path.join(b, ".context-hub/up.lock");
    const owner = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
    writeFileSync(lock, owner);
    expect(await main(["up"])).toBe(1);
    expect(errors).toContain(`pid ${process.pid}`);
    expect(errors).toContain(`workspace ${b}`);
    expect(availability).not.toHaveBeenCalled();
    expect(logText()).toBe("");
    expect(readFileSync(lock, "utf8")).toBe(owner);
  });

  it("holds the lock throughout port selection, then cleans it after provisioning", async () => {
    provision = true;
    let checked = false;
    availability.mockImplementation(async port => {
      if (!checked) {
        checked = true;
        const owner = JSON.parse(readFileSync(path.join(b, ".context-hub/up.lock"), "utf8"));
        expect(owner.pid).toBe(process.pid);
        expect(Number.isNaN(Date.parse(owner.started_at))).toBe(false);
        expect(await main(["up"])).toBe(1);
        expect(errors).toContain(`pid ${process.pid}`);
        expect(logText()).toBe("");
      }
      return port !== 3001 && port !== 3002;
    });
    expect(await main(["up"]), errors).toBe(0);
    expect(checked).toBe(true);
    expect(logText().match(/pane run .* serve --port 3003/g)).toHaveLength(1);
    expect(existsSync(path.join(b, ".context-hub/up.lock"))).toBe(false);
  });

  it("takes over a dead pid lock and removes it after normal provisioning", async () => {
    const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
    expect(child.status).toBe(0);
    const lock = path.join(b, ".context-hub/up.lock");
    writeFileSync(lock, JSON.stringify({ pid: child.pid, started_at: new Date().toISOString() }));
    provision = true;
    expect(await main(["up"]), errors).toBe(0);
    expect(bServer).toBeDefined();
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
  });

  it("cleans its startup lock when endpoint selection fails", async () => {
    availability.mockResolvedValue(false);
    expect(await main(["up"])).toBe(1);
    expect(errors).toContain("No free hub/notifier port pair");
    expect(existsSync(path.join(b, ".context-hub/up.lock"))).toBe(false);
  });

  it("explicit URL reuse and dry-run leave an existing live lock untouched", async () => {
    const server = await start(b); endpoints.set("3001", server.url);
    notifierIdentities.set("3002", { hub_root: b, hub_url: "http://127.0.0.1:3001" });
    const lock = path.join(b, ".context-hub/up.lock");
    const owner = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
    writeFileSync(lock, owner);
    expect(await main(["up", "--url", "http://127.0.0.1:3001"]), errors).toBe(0);
    expect(output).not.toContain("ownership check");
    expect(await main(["up", "--dry-run"]), errors).toBe(0);
    expect(readFileSync(lock, "utf8")).toBe(owner);
    expect(logText()).not.toMatch(/pane (?:run|split|rename|move)/);
  });

  it("discovers existing 3101/3002 rig without pane mutation or duplicate notifier", async () => {
    const server = await start(b); endpoints.set("3101", server.url);
    notifierIdentities.set("3002", { hub_root: b, hub_url: "http://127.0.0.1:3101" });
    vi.stubEnv("TUT_HERDR_PANES", JSON.stringify([
      { pane_id: "OWN:hub", label: rigLabel("tut-hub", b), tab_id: "OWN" },
      { pane_id: "OWN:notify", label: rigLabel("tut-notify", b), tab_id: "OWN" },
    ]));
    expect(await main(["up"]), errors).toBe(0);
    expect(output).toContain("hub already running (http://127.0.0.1:3101/state)");
    expect(output).toContain("notify already listening (http://127.0.0.1:3002/agent-event)");
    expect(logText()).not.toMatch(/pane (?:run|split|rename|move|close)/);
    // Identity discovery also works when the owned pane is not visible.
    vi.stubEnv("TUT_HERDR_PANES", "[]");
    expect(await main(["up"]), errors).toBe(0);
    expect(logText()).not.toMatch(/pane (?:run|split|rename|move|close)/);
  });

  it("does not attach a foreign notifier or start a duplicate when ownership is unknown", async () => {
    const server = await start(b); endpoints.set("3101", server.url);
    expect(await main(["up", "--event-port", "3002"])).toBe(1);
    expect(errors).toContain("foreign notifier"); expect(logText()).toBe("");
    notifierIdentities.set("3002", {});
    expect(await main(["up"])).toBe(1);
    expect(errors).toContain("cannot verify notifier ownership"); expect(logText()).toBe("");
  });

  it("refuses event-port moves while an owned notifier still runs, even without a pane", async () => {
    const server = await start(b); endpoints.set("3101", server.url);
    notifierIdentities.set("3002", { hub_root: b, hub_url: "http://127.0.0.1:3101" });
    expect(await main(["up", "--event-port", "3102"])).toBe(1);
    expect(errors).toContain("already listens on port 3002"); expect(logText()).toBe("");
  });

  it("inherits an out-of-range event endpoint but verifies its ownership", async () => {
    const server = await start(b); endpoints.set("3101", server.url);
    vi.stubEnv("TUT_EVENT_PORT_URL", "http://127.0.0.1:4302/agent-event");
    notifierIdentities.set("4302", { hub_root: b, hub_url: "http://localhost:3101" });
    expect(await main(["up"]), errors).toBe(0);
    expect(output).toContain("notify already listening (http://127.0.0.1:4302/agent-event)");
    expect(logText()).not.toMatch(/pane (?:run|split|rename|move|close)/);
  });

  it("refuses same-root stale Hub addresses and duplicate owned notifiers", async () => {
    const server = await start(b); endpoints.set("3101", server.url);
    notifierIdentities.set("3002", { hub_root: b, hub_url: "http://127.0.0.1:3001" });
    expect(await main(["up"])).toBe(1);
    expect(errors).toContain("cannot verify notifier ownership"); expect(logText()).toBe("");
    notifierIdentities.set("3002", { hub_root: b, hub_url: "http://127.0.0.1:3101" });
    notifierIdentities.set("3102", { hub_root: b, hub_url: "http://127.0.0.1:3101" });
    expect(await main(["up"])).toBe(1);
    expect(errors).toContain("multiple notifiers"); expect(logText()).toBe("");
  });

  it("discovers own hub beyond gaps; inherited foreign URL never redirects task reads", async () => {
    const server = await start(b); endpoints.set("3007", server.url);
    vi.stubEnv("TUT_HUB_URL", "http://127.0.0.1:3001");
    expect(await resolveCliHubUrl("http://127.0.0.1:3001", false)).toBe("http://127.0.0.1:3007");
    expect(await resolveUpHub("http://127.0.0.1:3001", false, b)).toEqual({ url: "http://127.0.0.1:3007", eventPort: 3008 });
  });

  it("subdirectories and symlinks resolve the same workspace; worktree env keeps shared Hub", async () => {
    const nested = path.join(b, "src", "deep"); mkdirSync(nested, { recursive: true });
    const alias = path.join(tmp, "alias"); symlinkSync(b, alias);
    expect(resolveRigRoot(nested, {})).toBe(b);
    expect(resolveRigRoot(alias, {})).toBe(b);
    expect(resolveRigRoot(nested, { TUT_HUB_ROOT: a })).toBe(a);
    const server = await start(a); vi.stubEnv("TUT_HUB_ROOT", a);
    expect(await resolveCliHubUrl(server.url, true)).toBe(server.url);
    expect(((await (await realFetch(`${server.url}/state`)).json()) as { hub_root: string }).hub_root).toBe(canonicalRoot(a));
  });

  it("missing/relative identity and invalid JSON cannot authorize explicit reuse", async () => {
    for (const body of [JSON.stringify({ flow_mode: "manual", tasks: [] }), JSON.stringify({ hub_root: "relative" }), "not json"]) {
      vi.stubGlobal("fetch", async () => new Response(body));
      expect(await probeHub("http://127.0.0.1:3001")).toEqual({});
      await expect(resolveCliHubUrl("http://127.0.0.1:3001", true)).rejects.toThrow("foreign hub");
      await expect(resolveUpHub("http://127.0.0.1:3001", true, b)).rejects.toThrow("identity handshake missing");
    }
  });

  it("no verified own hub fails with up guidance instead of reading a foreign pool", async () => {
    const server = await start(a); endpoints.set("3001", server.url);
    expect(await main(["list"])).toBe(1);
    expect(errors).toContain("No verified hub"); expect(errors).toContain("tut up");
  });

  it("skips occupied event ports, preserves explicit event override, and bounds exhaustion", async () => {
    availability.mockImplementation(async port => ![3001, 3002, 3004].includes(port));
    expect(await resolveUpHub("http://127.0.0.1:3001", false, b)).toEqual({ url: "http://127.0.0.1:3005", eventPort: 3006 });
    expect(await resolveUpHub("http://127.0.0.1:3001", false, b, 3900)).toEqual({ url: "http://127.0.0.1:3003", eventPort: 3900 });
    availability.mockResolvedValue(false);
    await expect(resolveUpHub("http://127.0.0.1:3001", false, b)).rejects.toThrow("No free hub/notifier port pair");
  });

  it("discovered hub cannot collide with an explicit event port", async () => {
    const server = await start(b); endpoints.set("3003", server.url);
    expect(await main(["up", "--event-port", "3003"])).toBe(1);
    expect(errors).toContain("both 3003"); expect(logText()).toBe("");
  });

  it("free default pair remains the first provisioning choice", async () => {
    availability.mockResolvedValue(true);
    expect(await resolveUpHub("http://127.0.0.1:3001", false, b)).toEqual({ url: "http://127.0.0.1:3001", eventPort: 3002 });
  });

  it("real port availability rejects occupied sockets and accepts released sockets", async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try { expect(await portFree(port)).toBe(false); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(await portFree(port)).toBe(true);
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { startServer, type RunningServer } from "../src/core/hub/server.js";
import { canonicalRoot, discoverHubs } from "../src/core/hub/rig-discovery.js";
import * as discovery from "../src/core/hub/rig-discovery.js";
import { Store } from "../src/core/hub/store.js";

const realFetch = globalThis.fetch;
let tmp: string;
let servers: RunningServer[];
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), "tut-hubs-")); servers = []; });
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  await Promise.all(servers.map(server => server.close()));
  await rm(tmp, { recursive: true, force: true });
});
async function start(name: string) {
  const root = path.join(tmp, name, ".context-hub");
  const store = new Store(root);
  await store.createTask({ title: name, description: "workspace fixture", creator: "test", role: "executor" });
  const server = await startServer({ root, port: 0 }); servers.push(server);
  return { ...server, root };
}

it("discovers verified local Hubs, includes itself and links to a second board with its own data using only reads", async () => {
  const a = await start("first"), b = await start("second");
  const before = await Promise.all([a, b].map(server => readdir(server.root, { recursive: true })));
  const append = vi.spyOn(Store.prototype, "append");
  const probes: { url: URL; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (Number(url.port) >= 3001 && Number(url.port) <= 3199) {
      probes.push({ url, init });
      if (url.port === "3001") return realFetch(new URL(url.pathname, a.url), init);
      if (url.port === "3003") return realFetch(new URL(url.pathname, b.url), init);
      throw new TypeError("offline fixture port");
    }
    return realFetch(input, init);
  });
  const res = await realFetch(a.url + "/hubs");
  expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  const hubs = await res.json() as { url: string; hub_root: string; port: number; is_self: boolean }[];
  expect(hubs).toContainEqual({ url: a.url, hub_root: canonicalRoot(path.dirname(a.root)), port: Number(new URL(a.url).port), is_self: true });
  const other = hubs.find(hub => hub.port === 3003)!;
  expect(other).toEqual({ url: "http://127.0.0.1:3003", hub_root: canonicalRoot(path.dirname(b.root)), port: 3003, is_self: false });
  expect(await (await fetch(other.url + "/board")).text()).toContain('id="workspace-tabs"');
  const state = await (await fetch(other.url + "/state")).json() as { tasks: { title: string }[] };
  expect(state.tasks.map(task => task.title)).toEqual(["second"]);
  expect(probes.every(({ url, init }) => url.hostname === "127.0.0.1" && Number(url.port) % 2 === 1 &&
    ["/state", "/board"].includes(url.pathname) && (!init?.method || init.method === "GET"))).toBe(true);
  expect(new Set(probes.filter(p => p.url.pathname === "/state").map(p => p.url.port)).size).toBe(100);
  expect(append).not.toHaveBeenCalled();
  expect(await Promise.all([a, b].map(server => readdir(server.root, { recursive: true })))).toEqual(before);
});

it("enforces GET/HEAD, no-store and Host guard before discovery, and falls back to an empty list on failure", async () => {
  const a = await start("first");
  const fetcher = vi.fn(async () => { throw new Error("offline"); });
  vi.stubGlobal("fetch", fetcher);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await realFetch(a.url + "/hubs", { method });
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const forbidden = await new Promise<number | undefined>((resolve, reject) => {
    http.get(a.url + "/hubs", { headers: { Host: "example.com" } }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  expect(forbidden).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  const head = await realFetch(a.url + "/hubs", { method: "HEAD" });
  expect(head.status).toBe(200); expect(await head.text()).toBe("");
  expect(head.headers.get("cache-control")).toBe("no-store");
  // Every candidate can be offline; the serving Hub still knows itself.
  expect(await (await realFetch(a.url + "/hubs")).json()).toEqual([
    { url: a.url, hub_root: canonicalRoot(path.dirname(a.root)), port: Number(new URL(a.url).port), is_self: true },
  ]);
  // A failure of the discovery operation itself must not turn /hubs into a 500.
  vi.spyOn(discovery, "discoverHubs").mockRejectedValueOnce(Error("discovery unavailable"));
  expect(await (await realFetch(a.url + "/hubs")).json()).toEqual([]);
});

it("excludes responders without an absolute identity and does not follow redirects", async () => {
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const port = new URL(String(input)).port;
    if (port === "3001") return new Response(JSON.stringify({ hub_root: "/verified" }));
    if (port === "3003") return new Response(JSON.stringify({ hub_root: "relative" }));
    if (port === "3005") return new Response("bad JSON");
    return new Response("", { status: 302, headers: { Location: "http://example.com" } });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await discoverHubs()).toEqual([{ url: "http://127.0.0.1:3001", hub_root: canonicalRoot("/verified"), port: 3001 }]);
  expect(fetcher).toHaveBeenCalledTimes(100);
  for (const [, init] of fetcher.mock.calls as unknown as [unknown, RequestInit][]) {
    expect(init.redirect).toBe("manual"); expect(init.signal).toBeInstanceOf(AbortSignal);
  }
});

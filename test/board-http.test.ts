import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { startServer, type RunningServer } from "../src/core/hub/server.js";
import { Store } from "../src/core/hub/store.js";
let root: string, tmp: string, running: RunningServer, store: Store;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tut-board-http-")); root = path.join(tmp, ".context-hub");
  store = new Store(root);
  await store.createTask({ title: "board task", description: "board test", creator: "test", role: "executor" });
  running = await startServer({ root, port: 0 });
});
afterEach(async () => { await running?.close(); await rm(tmp, { recursive: true, force: true }); });
it("serves packaged page and run projection with GET/HEAD, cache and method discipline", async () => {
  const before = await readdir(root);
  for (const endpoint of ["/board", "/runs"]) {
    const get = await fetch(running.url + endpoint);
    expect(get.status).toBe(200); expect(get.headers.get("cache-control")).toBe("no-store");
    const head = await fetch(running.url + endpoint, { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(head.headers.get("cache-control")).toBe("no-store"); expect(await head.text()).toBe("");
    const post = await fetch(running.url + endpoint, { method: "POST" });
    expect(post.status).toBe(405); expect(post.headers.get("allow")).toBe("GET, HEAD");
    const forbidden = await new Promise<number | undefined>((resolve, reject) => {
      http.get(running.url + endpoint, { headers: { Host: "example.com" } }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    expect(forbidden).toBe(403);
  }
  const runs = await (await fetch(running.url + "/runs")).json();
  const state = await (await fetch(running.url + "/state")).json() as { hub_root: string };
  expect(runs).toEqual({ hub_root: state.hub_root, runs: [] });
  expect(await readdir(root)).toEqual(before);
  expect((await fetch(running.url + "/board/other")).status).toBe(404);
  expect(await (await fetch(running.url + "/board")).text()).toContain("任务与运行");
});
it("returns failures honestly, preserves healthy neighbors and never writes task/meta/log", async () => {
  await mkdir(path.join(root, "runs"));
  for (const id of ["healthy", "bad"]) await mkdir(path.join(root, "runs", id));
  const file = path.join(root, "runs", "healthy", "meta.json");
  const bytes = JSON.stringify({ run_id: "healthy", pid: process.pid, pgid: process.pid, status: "running", argv: ["node"], started_at: new Date().toISOString() });
  await writeFile(file, bytes); await writeFile(path.join(root, "runs", "healthy", "log"), "tail");
  const append = vi.spyOn(Store.prototype, "append");
  try {
    const before = await store.readTask("board-task");
    const body = await (await fetch(running.url + "/runs")).json() as { runs: unknown[] };
    expect(body.runs).toHaveLength(2); expect(body.runs[0]).toMatchObject({ run_id: "healthy", degraded: false });
    expect(body.runs[1]).toMatchObject({ run_id: "bad", degraded: true });
    expect(await readFile(file, "utf8")).toBe(bytes); expect(await store.readTask("board-task")).toEqual(before);
    expect(append).not.toHaveBeenCalled();
  } finally { append.mockRestore(); }
  await rm(path.join(root, "runs"), { recursive: true }); await writeFile(path.join(root, "runs"), "invalid");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try { expect((await fetch(running.url + "/runs")).status).toBe(500); } finally { log.mockRestore(); }
});

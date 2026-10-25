import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import type { RunFile, RunFileOpener } from "../src/core/hub/run-file.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type RunningServer } from "../src/core/hub/server.js";
import { Store, type ReadTaskResult } from "../src/core/hub/store.js";
import { RunReadStore, type RunLogRange } from "../src/core/hub/run-store.js";

// Faults are injected around real file handles, including the kernel-safe open.
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));

// Observe the kernel-safe opener itself: Windows native handles do not go
// through node:fs.open. Every actual open/close still executes the product API.
const nativeBoundary = vi.hoisted(() => ({
  opened: undefined as ((file: string, handle: RunFile) => void) | undefined,
  afterOpen: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../src/core/hub/run-file.js', async original => {
  const actual = await original<typeof import('../src/core/hub/run-file.js')>();
  const wrap = (open: RunFileOpener) => async (file: string) => {
    try { const handle = await open(file); nativeBoundary.opened?.(file, handle); return handle; }
    finally { await nativeBoundary.afterOpen?.(); }
  };
  return { ...actual, openRunFile: wrap(actual.openRunFile),
    withRunFileSession: <T>(read: (open: RunFileOpener) => Promise<T>) => actual.withRunFileSession(open => read(wrap(open))),
  };
});
const RUN = "20261017T010203004Z-1234abcd";
let tmp: string, root: string, store: Store, running: RunningServer, client: Client;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "tut-kibitz-"));
  root = path.join(tmp, ".context-hub");
  store = new Store(root);
  await store.createTask({ title: "records", description: "full body", creator: "test", role: "human", flow: "direct",
    cast: { executor: { agent: "codex", args: ["-m", "test"] } }, checkout: { kind: "current" } });
  running = await startServer({ root, port: 0 });
  client = new Client({ name: "kibitz-test", version: "1" });
  // SDK optional sessionId typing predates exactOptionalPropertyTypes.
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url + "/mcp")) as unknown as Parameters<Client["connect"]>[0]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  nativeBoundary.opened = undefined; nativeBoundary.afterOpen = undefined;
  await client?.close();
  await running?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function request(endpoint: string, method = "GET", host?: string) {
  // Preserve raw dot segments/backslashes/bad percent escapes for validation tests.
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; bytes: Buffer }>((resolve, reject) => {
    const req = http.request(running.url, { path: endpoint, method, headers: host ? { Host: host } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, text: bytes.toString(), bytes });
      });
      res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}
async function statusBoth(endpoint: string, status: number) {
  const get = await request(endpoint), head = await request(endpoint, "HEAD");
  expect(get.status).toBe(status); expect(head.status).toBe(status);
  for (const response of [get, head]) {
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  }
  expect(head.text).toBe("");
  return get;
}
async function seedLog(bytes: Buffer | string, id = RUN) {
  const dir = path.join(root, "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "log"), bytes);
  return path.join(dir, "log");
}
async function seedUsage() {
  const bytes = await readFile(new URL("./fixtures/usage.json", import.meta.url));
  await writeFile(path.join(root, "tasks", "records", "usage.json"), bytes);
  return bytes;
}
async function page(from = 0, limit = 65536): Promise<RunLogRange> {
  const response = await request(`/runs/${RUN}/log?from=${from}&limit=${limit}`);
  expect(response.status).toBe(200);
  const result = JSON.parse(response.text) as RunLogRange;
  expect(result.encoding).toBe("base64");
  expect(Buffer.from(result.data, "base64").length).toBe(result.next - from);
  expect(result.eof).toBe(result.next === result.size);
  return result;
}
async function mcpRead(id: string) {
  const response = await client.callTool({ name: "context.read", arguments: { task_id: id } });
  expect(response.isError).not.toBe(true);
  const content = response.content as { type: string; text: string }[];
  return JSON.parse(content.find(block => block.type === "text")!.text) as ReadTaskResult;
}

it("returns the exact MCP context.read result, including empty/closed/project and appended records", async () => {
  const compare = async (id: string) => {
    const get = await statusBoth(`/tasks/${id}/versions`, 200);
    expect(JSON.parse(get.text)).toEqual(await mcpRead(id));
    return JSON.parse(get.text) as ReadTaskResult;
  };
  expect((await compare("records")).versions).toEqual([]);
  // Like context.read, a never-created project is missing, not an invented empty scope.
  await statusBoth("/tasks/project/versions", 404);
  expect((await client.callTool({ name: "context.read", arguments: { task_id: "project" } })).isError).toBe(true);
  expect(await readdir(path.join(root, "tasks"))).toEqual(["records"]);
  await store.append("records", { role: "executor", content_type: "code_changes", agent: "codex", model: "test-model",
    payload: { summary: "s", body: "# 正文\n<script> & \r\n😀", commits: ["abc123"], ref_version: 1,
      future: { nested: [null, { arbitrary: "retained" }] } } });
  const first = (await compare("records")).versions[0]!;
  expect(first).toMatchObject({ agent: "codex", model: "test-model", tut_version: expect.any(String),
    payload: { commits: ["abc123"], ref_version: 1, future: { nested: [null, { arbitrary: "retained" }] } } });
  await store.append("records", { role: "human", content_type: "decision", payload: { summary: "close", body: "close", decision: "close" } });
  const closed = await compare("records");
  expect(closed.status).toBe("closed"); expect(closed.versions.map(v => v.version)).toEqual([1, 2]);
  expect(closed.versions[0]).toEqual(first);
  await store.append("project", { role: "human", content_type: "note", payload: { summary: "p", body: "project body" } });
  const project = await compare("project");
  for (const field of ["flow", "status", "cast", "checkout"]) expect(project).not.toHaveProperty(field);
});

it("serves the usage fixture as an exact byte ruler, including formatting and unknown fields", async () => {
  const bytes = await seedUsage();
  // JSON equality would miss changes to whitespace, key order, escapes or numbers.
  expect((await statusBoth("/tasks/records/usage", 200)).bytes).toEqual(bytes);
  await store.append("records", { role: "human", content_type: "decision", payload: { summary: "close", body: "close", decision: "close" } });
  expect((await statusBoth("/tasks/records/usage", 200)).bytes).toEqual(bytes);
  const updated = Buffer.from('{ "schema_version": 1, "rounds": [] }\r\n');
  await writeFile(path.join(root, "tasks", "records", "usage.json"), updated);
  expect((await statusBoth("/tasks/records/usage", 200)).bytes).toEqual(updated);
});

it("returns 404 for missing usage or tasks, even with an orphan sidecar", async () => {
  await statusBoth("/tasks/records/usage", 404);
  await statusBoth("/tasks/missing/usage", 404);
  await mkdir(path.join(root, "tasks", "orphan"));
  await writeFile(path.join(root, "tasks", "orphan", "usage.json"), '{"schema_version":1,"rounds":[]}');
  await statusBoth("/tasks/orphan/usage", 404);
});

it("reports usage read failures as 500 without exposing storage paths", async () => {
  vi.spyOn(Store.prototype, "readUsageRaw").mockRejectedValue(Object.assign(new Error("secret storage path"), { code: "EACCES" }));
  expect((await statusBoth("/tasks/records/usage", 500)).text).toBe('{"error":"internal error"}');
});

it("reads legal legacy dotted task IDs through Store semantics", async () => {
  // Only a temporary fixture: simulate an existing legacy directory/meta.
  const dir = path.join(root, "tasks", "records");
  const bytes = await seedUsage();
  const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
  await rename(dir, path.join(root, "tasks", "legacy.v1"));
  await writeFile(path.join(root, "tasks", "legacy.v1", "meta.json"), JSON.stringify({ ...meta, task_id: "legacy.v1" }));
  expect(JSON.parse((await statusBoth("/tasks/legacy.v1/versions", 200)).text)).toEqual(await mcpRead("legacy.v1"));
  expect((await statusBoth("/tasks/legacy.v1/usage", 200)).bytes).toEqual(bytes);
});

it("round-trips arbitrary bytes with tiny ranges crossing UTF-8, CRLF and partial lines", async () => {
  const bytes = Buffer.concat([Buffer.from("中😀\r\n\npartial"), Buffer.from([0xff, 0x00, 0xc3])]);
  await seedLog(bytes);
  const chunks: Buffer[] = [];
  let cursor = 0;
  do {
    const p = await page(cursor, 2);
    expect(p.from).toBe(cursor); expect(p.size).toBe(bytes.length);
    chunks.push(Buffer.from(p.data, "base64")); cursor = p.next;
  } while (cursor < bytes.length);
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(Buffer.from((await page(1, 3)).data, "base64")).toEqual(bytes.subarray(1, 4));
  expect(await page(bytes.length)).toMatchObject({ next: bytes.length, data: "", eof: true });
  const beyond = await statusBoth(`/runs/${RUN}/log?from=${bytes.length + 1}`, 416);
  expect(JSON.parse(beyond.text)).toEqual({ code: "RANGE_NOT_SATISFIABLE", from: bytes.length + 1, size: bytes.length });
});

it("uses a bounded default/max page, short tail, and a distinct successful empty log", async () => {
  const bytes = Buffer.alloc(65539, 0xab);
  await seedLog(bytes);
  const result = JSON.parse((await statusBoth(`/runs/${RUN}/log`, 200)).text) as RunLogRange;
  expect(result).toMatchObject({ from: 0, next: 65536, size: bytes.length, eof: false });
  expect(Buffer.from(result.data, "base64")).toEqual(bytes.subarray(0, 65536));
  expect(await page()).toEqual(result);
  expect(Buffer.from((await page(65536)).data, "base64")).toEqual(bytes.subarray(65536));
  await seedLog("");
  expect(await page()).toEqual({ run_id: RUN, from: 0, next: 0, size: 0, eof: true, encoding: "base64", data: "" });
});

it.each(["running", "stopped", "exited"])("follows appended bytes with two independent cursors, even when meta status is %s", { timeout: process.platform === "win32" ? 60_000 : 5_000 }, async status => {
  const first = Buffer.concat([Buffer.from("line\n半行"), Buffer.from([0xf0, 0x9f])]);
  const added = Buffer.concat([Buffer.from([0x98, 0x80]), Buffer.from("后半\r\nend")]);
  const file = await seedLog(first);
  await writeFile(path.join(path.dirname(file), "meta.json"), JSON.stringify({ status }));
  async function drain(cursor: number, limit: number) {
    const chunks: Buffer[] = [];
    for (;;) {
      const p = await page(cursor, limit);
      chunks.push(Buffer.from(p.data, "base64")); cursor = p.next;
      if (p.eof) return { cursor, bytes: Buffer.concat(chunks) };
    }
  }
  const a = await drain(0, 3), b = await drain(0, 5);
  expect(a.bytes).toEqual(first); expect(b.bytes).toEqual(first);
  expect(await page(a.cursor)).toMatchObject({ next: a.cursor, data: "", eof: true });
  await appendFile(file, added);
  const nextA = await drain(a.cursor, 2), nextB = await drain(b.cursor, 4);
  expect(nextA.bytes).toEqual(added); expect(nextB.bytes).toEqual(added);
  expect(nextA.cursor).toBe(first.length + added.length); expect(nextB.cursor).toBe(nextA.cursor);
  expect((await drain(a.cursor, 7)).bytes).toEqual(added);
  expect(Buffer.concat([a.bytes, nextA.bytes])).toEqual(Buffer.concat([first, added]));
});

it.each(["from=", "from=-1", "from=1.2", "from=1e2", "from=1x", "from=+1", "from=9007199254740992",
  "from=0&from=1", "limit=", "limit=0", "limit=-1", "limit=1.5", "limit=1e2", "limit=2x",
  "limit=65537", "limit=9007199254740992", "limit=2&limit=2", "from=1?junk", "limit=1?junk",
  "from=1%0A", "limit=1%0D%0A"])("rejects invalid or ambiguous numeric parameters: %s", async query => {
  await statusBoth(`/runs/${RUN}/log?${query}`, 400);
});

it.each(["%", "%ZZ", "%2F", "a%2Fb", "a%5Cb", "a\\b", "%00", "records%0A", "..", "a/../records", "%252F", "UPPER", ""])("rejects invalid task/run segments before normalization: %s", async id => {
  await statusBoth(`/tasks/${id}/versions`, 400);
  await statusBoth(`/tasks/${id}/usage`, 400);
  await statusBoth(`/runs/${id}/log`, 400);
});

it("enforces GET/HEAD, no-store and the global loopback Host guard", async () => {
  await seedLog("data");
  await seedUsage();
  for (const endpoint of ["/tasks/records/versions", "/tasks/records/usage", `/runs/${RUN}/log`]) {
    await statusBoth(endpoint, 200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await request(endpoint, method);
      expect(res.status).toBe(405); expect(res.headers.allow).toBe("GET, HEAD");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    for (const host of ["example.com", "127.0.0.1.evil.test"]) {
      expect((await request(endpoint, "GET", host)).status).toBe(403);
      const head = await request(endpoint, "HEAD", host); expect(head.status).toBe(403); expect(head.text).toBe("");
    }
    for (const host of ["localhost:123", "127.0.0.1", "[::1]:123"]) expect((await request(endpoint, "GET", host)).status).toBe(200);
  }
  expect((await request("/tasks/records/other")).status).toBe(404);
  expect((await request(`/runs/${RUN}/log/stream`)).status).toBe(404);
});

it("reports missing resources without creating them; damaged task data is 500, never 400 or empty", async () => {
  await statusBoth("/tasks/missing/versions", 404);
  await statusBoth(`/runs/${RUN}/log`, 404); // no runs directory
  await mkdir(path.join(root, "runs")); await statusBoth(`/runs/${RUN}/log`, 404); // no run
  await mkdir(path.join(root, "runs", RUN)); await statusBoth(`/runs/${RUN}/log`, 404); // no log
  expect(await readdir(path.join(root, "runs", RUN))).toEqual([]);
  expect(await readdir(path.join(root, "tasks"))).toEqual(["records"]);
  await store.append("records", { role: "human", content_type: "note", payload: { summary: "s", body: "b" } });
  const dir = path.join(root, "tasks", "records");
  await writeFile(path.join(dir, "v001.note.json"), "{broken");
  const recordError = await statusBoth("/tasks/records/versions", 500);
  expect(recordError.text).toBe('{"error":"internal error"}');
  await writeFile(path.join(dir, "meta.json"), "{broken");
  expect((await statusBoth("/tasks/records/versions", 500)).text).toBe(recordError.text);
});

it("does not mutate any stored bytes, call append, probe a PID, or require valid meta", async () => {
  const log = await seedLog("evidence");
  await seedUsage();
  await writeFile(path.join(path.dirname(log), "meta.json"), "broken metadata");
  await store.append("records", { role: "human", content_type: "note", payload: { summary: "s", body: "b" } });
  async function tree(dir: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(result, await tree(file));
      else result[file] = (await readFile(file)).toString("base64");
    }
    return result;
  }
  const before = await tree(root);
  const append = vi.spyOn(Store.prototype, "append"), kill = vi.spyOn(process, "kill");
  await statusBoth("/tasks/records/versions", 200);
  await statusBoth("/tasks/records/usage", 200);
  await statusBoth("/tasks/project/usage", 404);
  await statusBoth("/tasks/missing/usage", 404);
  await statusBoth("/tasks/project/versions", 404);
  await statusBoth(`/runs/${RUN}/log`, 200);
  await statusBoth("/tasks/missing/versions", 404);
  expect(await tree(root)).toEqual(before);
  expect(append).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
});

it.each(["runs", "run", "log"])("rejects linked or non-ordinary %s paths without exposing bytes or absolute paths", async level => {
  const file = await seedLog("inside");
  const target = level === "runs" ? path.join(root, "runs") : level === "run" ? path.dirname(file) : file;
  const outside = path.join(tmp, "outside");
  await mkdir(outside); await writeFile(path.join(outside, "secret"), "SECRET");
  await rm(target, { recursive: true });
  await symlink(level === "log" ? path.join(outside, "secret") : outside, target);
  expect((await statusBoth(`/runs/${RUN}/log`, 500)).text).toBe('{"error":"internal error"}');
  await rm(target);
  if (level === "log") await mkdir(target); else await writeFile(target, "not directory");
  expect((await statusBoth(`/runs/${RUN}/log`, 500)).text).toBe('{"error":"internal error"}');
});

// Instrument all handles, including Linux's pinned ancestor FDs.
interface TrackedHandle { closed: boolean }
function instrumentOpen(onLog: (handle: RunFile) => void) {
  const handles: TrackedHandle[] = [];
  nativeBoundary.opened = (file, handle) => {
    const tracked = { closed: false }; handles.push(tracked);
    const close = handle.close.bind(handle);
    handle.close = async () => { await close(); tracked.closed = true; };
    if (/[/\\]log$/.test(file)) onLog(handle);
  };
  return handles;
}
function expectClosed(handles: TrackedHandle[]) {
  expect(handles.length).toBeGreaterThan(0);
  expect(handles.every(handle => handle.closed)).toBe(true);
}

it("bounds actual reads/allocations, handles legal short reads, and freezes size before concurrent append", async () => {
  const file = await seedLog(Buffer.alloc(2 * 1024 * 1024, 0x61));
  const reads: { requested: number; capacity: number; position: number; actual: number }[] = [];
  const handles = instrumentOpen(handle => {
    const original = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await original(buffer, offset, Math.min(7, length), position);
      reads.push({ requested: length, capacity: buffer.length, position, actual: result.bytesRead });
      return result;
    }) as typeof handle.read);
  });
  const p = await page(1000000, 31);
  expect(Buffer.from(p.data, "base64")).toEqual(Buffer.alloc(31, 0x61));
  expect(reads[0]!.position).toBe(1000000);
  expect(reads.every(r => r.requested <= 31 && r.capacity === 31)).toBe(true);
  expect(reads.reduce((n, r) => n + r.actual, 0)).toBe(31);
  expectClosed(handles);
  vi.restoreAllMocks();
  await seedLog("old");
  let appended = false;
  const appendHandles = instrumentOpen(handle => {
    const original = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation((async (...args: unknown[]) => {
      if (!appended) { await appendFile(file, "new"); appended = true; }
      return Reflect.apply(original, handle, args);
    }) as typeof handle.read);
  });
  expect(await page()).toMatchObject({ size: 3, next: 3, eof: true, data: Buffer.from("old").toString("base64") });
  expect(Buffer.from((await page(3)).data, "base64").toString()).toBe("new");
  expectClosed(appendHandles);
});

it.each(["EACCES", "EIO", "early-eof", "truncate"])("reports read fault %s honestly and closes all handles", async fault => {
  const file = await seedLog("original bytes");
  const handles = instrumentOpen(handle => {
    const original = handle.read.bind(handle);
    let calls = 0;
    vi.spyOn(handle, "read").mockImplementation((async (...args: unknown[]) => {
      if (fault === "early-eof") {
        if (calls++ === 0) return original(args[0] as Buffer, args[1] as number, 2, args[3] as number);
        return { bytesRead: 0, buffer: args[0] };
      }
      if (fault === "truncate") {
        const result = await Reflect.apply(original, handle, args);
        await truncate(file, 1);
        return result;
      }
      throw Object.assign(new Error(`secret path: ${file}`), { code: fault });
    }) as typeof handle.read);
  });
  for (const method of ["GET", "HEAD"]) {
    // Restore only temporary fixture bytes so both requests encounter the fault.
    await writeFile(file, "original bytes");
    const response = await request(`/runs/${RUN}/log`, method);
    expect(response.status).toBe(fault === "early-eof" || fault === "truncate" ? 409 : 500);
    if (method === "HEAD") expect(response.text).toBe("");
    else if (response.status === 409) expect(JSON.parse(response.text).code).toBe("LOG_CHANGED");
    else expect(response.text).toBe('{"error":"internal error"}');
    expectClosed(handles);
  }
});

it("closes handles on an out-of-range cursor and rejects unsafe direct Store inputs", async () => {
  await seedLog("x");
  const handles = instrumentOpen(() => {});
  await statusBoth(`/runs/${RUN}/log?from=9007199254740991`, 416);
  expectClosed(handles);
  const reader = new RunReadStore(root);
  for (const [from, limit] of [[-1, 1], [0, 0], [0, 65537], [1.5, 2], [Number.MAX_SAFE_INTEGER + 1, 2]]) {
    await expect(reader.readLogRange(RUN, from, limit)).rejects.toThrow("invalid log byte range");
  }
  await expect(reader.readLogRange("../outside", 0, 1)).rejects.toThrow("invalid run-id");
});

it("never leaks a target when the run directory is linked outside only during stat/open", async () => {
  const file = await seedLog("INSIDE");
  const dir = path.dirname(file), saved = path.join(tmp, "saved");
  const outside = path.join(tmp, "outside"); await mkdir(outside);
  await writeFile(path.join(outside, "log"), "OUTSIDE_SECRET");
  const target = await realpath(file), originalStat = files.lstat;
  let swapped = false, arranged = false, restored = false;
  const handles = instrumentOpen(() => {});
  async function restore() {
    if (swapped) { await rm(dir); await rename(saved, dir); swapped = false; restored = true; }
  }
  vi.spyOn(files, "lstat").mockImplementation((async (...args: Parameters<typeof files.lstat>) => {
    if (!arranged && String(args[0]) === target) {
      await rename(dir, saved); await symlink(outside, dir); swapped = true; arranged = true;
    }
    return originalStat(...args);
  }) as typeof files.lstat);
  nativeBoundary.afterOpen = restore;
  try {
    const response = await request(`/runs/${RUN}/log`);
    expect(arranged).toBe(true); expect(restored).toBe(true);
    expect(response.status).toBe(500); expect(response.text).toBe('{"error":"internal error"}');
    expect(handles.every(handle => handle.closed)).toBe(true);
  } finally { nativeBoundary.afterOpen = undefined; await restore(); }
});

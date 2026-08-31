/**
 * Routing + assembly tests (adds /mode, the /state notify
 * key, and the Host-guard edge cases): a REAL
 * startServer on an ephemeral port (port 0) backed by a temp-dir Store.
 *
 * Scope: HTTP routing and the frozen /state shape. POST /mcp is asserted
 * purely at the routing level (not 404/405) — full MCP-over-HTTP is
 * covered by e2e.mcp.test.ts (and hub-client.test.ts from the client side).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { startServer, type RunningServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { writeConfigKey } from "../src/config.js";

let tmp: string;
let root: string;
let store: Store;
let running: RunningServer;
let baseUrl: string;
let stderrWrite: MockInstance<typeof process.stderr.write>;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-http-"));
  root = path.join(tmp, ".context-hub");
  store = new Store(root);
  // One real task (create + one record) so /state has derived content …
  const created = await store.createTask({
    title: "Routing Task",
    description: "task created via the store for /state assertions",
    creator: "tester",
    role: "executor",
    cast: { executor: "pi" }, // exercises the cast? field on /state entries
  });
  await store.append(created.task_id, {
    role: "executor",
    content_type: "text/plain",
    payload: { summary: "note", body: "a record so the task has derived state" },
  });
  // … plus a project-scope record, to prove project is EXCLUDED from /state.
  await store.append("project", {
    role: "human",
    content_type: "text/markdown",
    payload: { summary: "project note", body: "project scope must not appear in /state" },
  });

  stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  running = await startServer({ root, port: 0 });
  baseUrl = running.url;
});

afterEach(async () => {
  stderrWrite.mockRestore();
  await running.close().catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /state (frozen shape)", () => {
  it("returns 200 application/json with flow_mode manual and eight-field task entries (flow always present)", async () => {
    const res = await fetch(`${baseUrl}/state`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { flow_mode: string; tasks: Record<string, unknown>[] };

    expect(body.flow_mode).toBe("manual");
    // Frozen top-level shape (plus the two additive optional keys):
    // with no notify/auto configured, exactly flow_mode + tasks.
    expect(Object.keys(body).sort()).toEqual(["flow_mode", "tasks"]);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks).toHaveLength(1);

    const entry = body.tasks[0]!;
    expect(Object.keys(entry).sort()).toEqual([
      "cast",
      "flow",
      "needs_attention",
      "status",
      "task_id",
      "title",
      "updated_at",
      "version",
      "waiting_for",
    ]);
    expect(entry.task_id).toBe("routing-task");
    expect(entry.title).toBe("Routing Task");
    expect(typeof entry.status).toBe("string");
    expect(typeof entry.updated_at).toBe("string");
    expect(typeof entry.needs_attention).toBe("boolean");
    expect(typeof entry.waiting_for).toBe("string");
    expect(entry.version).toBe(1); // one record appended in beforeEach → meta.version
    expect(entry.flow).toBe("full"); // always present, normalized
    expect(entry.cast).toEqual({ executor: "pi" }); // present when created with one
  });

  it("never includes the project scope entry", async () => {
    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as { tasks: { task_id: string }[] };

    expect(body.tasks.map((t) => t.task_id)).not.toContain("project");
  });

  it("exposes parameterized cast argv unchanged on the HTTP state seam", async () => {
    const cast = { executor: { agent: "codex", args: ["--model", "gpt-5.6", "--sandbox", "workspace-write", "--search"] } };
    const created = await store.createTask({
      title: "Parameterized HTTP task",
      description: "state route",
      creator: "tester",
      role: "architect",
      cast,
    });

    const res = await fetch(`${baseUrl}/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ task_id: string; cast?: unknown }> };
    expect(body.tasks.find((task) => task.task_id === created.task_id)?.cast).toEqual(cast);
  });

  it("exposes an explicit task checkout route on the HTTP state seam", async () => {
    const checkout = { kind: "worktree" as const, path: "/worktrees/http-task", ref: "http-task" };
    const created = await store.createTask({
      title: "Parameterized HTTP checkout",
      description: "state route",
      creator: "tester",
      role: "architect",
      checkout,
    });

    const res = await fetch(`${baseUrl}/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ task_id: string; checkout?: unknown }> };
    expect(body.tasks.find((task) => task.task_id === created.task_id)?.checkout).toEqual(checkout);
  });

  it("skips a task with a corrupt record file instead of 500ing ", async () => {
    // A second, healthy task so the listing still has derived content.
    const created = await store.createTask({
      title: "Healthy Task",
      description: "must survive a sibling task's corrupt record file",
      creator: "tester",
      role: "executor",
    });
    await store.append(created.task_id, {
      role: "executor",
      content_type: "text/plain",
      payload: { summary: "note", body: "healthy record" },
    });

    // Corrupt the routing task's only record file.
    const dir = path.join(root, "tasks", "routing-task");
    const recordFile = readdirSync(dir).find((f) => f.startsWith("v") && f.endsWith(".json"))!;
    writeFileSync(path.join(dir, recordFile), "{ not json");

    const res = await fetch(`${baseUrl}/state`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { task_id: string }[] };
    expect(body.tasks.map((t) => t.task_id)).toEqual([created.task_id]);

    // The skip is visible server-side: a one-line stderr warning naming the task.
    const stderr = stderrWrite.mock.calls.flat().join("");
    expect(stderr).toContain("routing-task");
  });
});

describe("GET /state optional notify key", () => {
  it("omits the key when config.json has no notify field", async () => {
    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("notify");
  });

  it("echoes the config notify field when present", async () => {
    const notify = { channels: ["desktop", "webhook"], webhook_url: "http://127.0.0.1:9/hook" };
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual", notify }, null, 2) + "\n", "utf8");

    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.notify).toEqual(notify);
    expect(body.flow_mode).toBe("manual");
  });

  it("omits the key (and stays 200) when config.json is corrupt", async () => {
    writeFileSync(path.join(root, "config.json"), "{ not json", "utf8");

    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.flow_mode).toBe("manual"); // single readConfig call → null → "manual" fallback
    expect(body).not.toHaveProperty("notify");
  });
});

describe("GET /state optional auto key", () => {
  it("omits the key when config.json has no auto section", async () => {
    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("auto");
  });

  it("echoes the validated auto section when present", async () => {
    writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ flow_mode: "auto", auto: { launch_roles: ["executor", "reviewer"] } }, null, 2) + "\n",
      "utf8",
    );

    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.auto).toEqual({ launch_roles: ["executor", "reviewer"] });
    expect(body.flow_mode).toBe("auto");
  });

  it("omits the key (and stays 200) when config.json is corrupt", async () => {
    writeFileSync(path.join(root, "config.json"), "{ not json", "utf8");

    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.flow_mode).toBe("manual");
    expect(body).not.toHaveProperty("auto");
  });

  it("omits the key on a malformed section while the rest of the config still applies", async () => {
    writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ flow_mode: "auto", auto: { launch_roles: "executor" } }, null, 2) + "\n",
      "utf8",
    );

    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.flow_mode).toBe("auto"); // a bad auto section does not invalidate the file
    expect(body).not.toHaveProperty("auto"); // …but its whitelist is not exposed either
  });

  it("picks up tut config set writes on the NEXT request — no restart (serve stays a compatible reader)", async () => {
    const before = (await (await fetch(`${baseUrl}/state`)).json()) as { flow_mode: string; auto?: unknown };
    expect(before.flow_mode).toBe("manual");
    expect(before.auto).toBeUndefined();

    // `tut config set` engine writes the file directly (no Hub round-trip);
    // the running serve must reflect it on the very next /state read.
    await writeConfigKey(root, { key: "flow_mode", value: "auto" });
    await writeConfigKey(root, { key: "auto.launch_roles", value: ["executor", "reviewer"] });

    const after = (await (await fetch(`${baseUrl}/state`)).json()) as { flow_mode: string; auto?: { launch_roles: string[] } };
    expect(after.flow_mode).toBe("auto");
    expect(after.auto).toEqual({ launch_roles: ["executor", "reviewer"] });
  });
});

describe("POST /mode", () => {
  function postMode(body: string): Promise<Response> {
    return fetch(`${baseUrl}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  it("switches flow_mode, echoes {flow_mode}, and /state reflects it on the next request", async () => {
    const res = await postMode('{"flow_mode":"auto"}');

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ flow_mode: "auto" });

    const state = (await (await fetch(`${baseUrl}/state`)).json()) as { flow_mode: string };
    expect(state.flow_mode).toBe("auto");
  });

  it("preserves unknown config keys (notify survives the switch)", async () => {
    const notify = { channels: ["desktop"] };
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual", notify }, null, 2) + "\n", "utf8");

    const res = await postMode('{"flow_mode":"auto"}');

    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual({ flow_mode: "auto", notify });
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]); // temp+rename, no leftovers
  });

  it("rejects an invalid flow_mode value with 400 and changes nothing", async () => {
    const res = await postMode('{"flow_mode":"banana"}');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    const onDisk = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as { flow_mode: string };
    expect(onDisk.flow_mode).toBe("manual");
  });

  it("rejects invalid JSON bodies with 400", async () => {
    const res = await postMode("{ not json");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("GET /mode → 405 with Allow: POST", async () => {
    const res = await fetch(`${baseUrl}/mode`);

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("corrupt config behind a switch → 500 with a generic body (no clobbering)", async () => {
    writeFileSync(path.join(root, "config.json"), "{ not json", "utf8");

    const res = await postMode('{"flow_mode":"auto"}');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe("{ not json");
  });
});

describe("routing", () => {
  it("unknown path → 404 JSON", async () => {
    const res = await fetch(`${baseUrl}/nope`);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("GET /mcp → 405 with Allow: POST", async () => {
    const res = await fetch(`${baseUrl}/mcp`);

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("DELETE /mcp → 405 with Allow: POST", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("POST /mcp is routed to the MCP branch (not 404/405)", async () => {
    // Routing-level assertion only: the response is either a 500 JSON or an
    // SDK-level protocol response. Either way
    // POST must not fall through to 404/405.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(405);
  });
});

describe("error responses ", () => {
  it("unexpected /state failure → 500 with generic body, no path leak to the client", async () => {
    // Make the tasks dir unreadable: listTasks' readdir throws EACCES (not a
    // tolerated StoreError), so handleState rejects into the last-resort guard.
    const tasksDir = path.join(root, "tasks");
    chmodSync(tasksDir, 0o000);
    try {
      const res = await fetch(`${baseUrl}/state`);

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("internal error");
      expect(JSON.stringify(body)).not.toContain(tmp); // absolute paths stay server-side
    } finally {
      chmodSync(tasksDir, 0o755); // restore so afterEach cleanup can remove the dir
    }
  });
});

describe("Host header guard", () => {
  it("accepts loopback Host values with a port", async () => {
    const host = new URL(baseUrl).host; // 127.0.0.1:<port>
    const res = await requestRaw("GET", "/state", host);
    expect(res.status).toBe(200);
  });

  it("accepts the IPv6 loopback [::1], with and without a port", async () => {
    expect((await requestRaw("GET", "/state", "[::1]")).status).toBe(200);
    expect((await requestRaw("GET", "/state", "[::1]:3001")).status).toBe(200);
  });

  it("tolerates an absent Host header (HTTP/1.0-style raw socket)", async () => {
    const res = await requestNoHost("/state");
    expect(res.status).toBe(200);
    expect(res.body).toContain('"flow_mode"');
  });

  it("rejects a non-loopback Host with 403", async () => {
    // fetch forbids overriding Host, so use a raw http.request.
    const res = await requestRaw("GET", "/state", "evil.example.com");
    expect(res.status).toBe(403);
    expect(res.body).toContain("forbidden");
  });
});

describe("startServer lifecycle", () => {
  it("resolves an actual-port url for port 0 and releases the port on close()", async () => {
    expect(new URL(baseUrl).port).not.toBe("0");
    expect(new URL(baseUrl).port).not.toBe("");

    const port = Number(new URL(baseUrl).port);
    await running.close();

    // The port is actually free again: a plain TCP listener can take it.
    const taker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      taker.once("error", reject);
      taker.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => taker.close(() => resolve()));
  });

  it("rejects with a clear error when the port is already in use (EADDRINUSE)", async () => {
    // Pick a definitely-free explicit port: reserve with a dummy socket, then race.
    const dummy = net.createServer();
    await new Promise<void>((resolve, reject) => {
      dummy.once("error", reject);
      dummy.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (dummy.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => dummy.close(() => resolve()));

    const first = await startServer({ root, port });
    try {
      await expect(startServer({ root, port })).rejects.toThrow(/already in use.*EADDRINUSE/);
    } finally {
      await first.close();
    }
  });
});

// cli arg parsing moved to test/cli.test.ts (nine-command skeleton).

// --- helpers ---------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
}

/** fetch cannot override the Host header, so the Host-guard tests go raw. */
function requestRaw(method: string, pathname: string, host: string): Promise<RawResponse> {
  const target = new URL(baseUrl);
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        method,
        path: pathname,
        headers: { host }, // deliberately lowercase; node sends it as Host
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.once("error", reject);
    req.end();
  });
}

/**
 * Truly Host-less request: node:http always injects a Host header, so the
 * absent-Host edge case (HTTP/1.0-style clients) needs a raw TCP socket.
 */
function requestNoHost(pathname: string): Promise<RawResponse> {
  const target = new URL(baseUrl);
  return new Promise<RawResponse>((resolve, reject) => {
    const sock = net.connect(Number(target.port), target.hostname);
    let raw = "";
    sock.on("connect", () => sock.write(`GET ${pathname} HTTP/1.0\r\n\r\n`));
    sock.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    sock.on("end", () => {
      const statusLine = raw.split("\r\n", 1)[0] ?? "";
      resolve({ status: Number.parseInt((statusLine.split(" ", 3)[1] ?? "0"), 10), body: raw });
    });
    sock.once("error", reject);
  });
}

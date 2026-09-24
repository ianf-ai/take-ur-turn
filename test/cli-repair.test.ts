/**
 * CLI wiring tests for the two storage-repair clients (system-design 4.3):
 * `tut repair-meta` and `tut recover-record`. Covers (a) parser discipline
 * through pure parseArgs, (b) the handler seam against a REAL hub on an
 * ephemeral port backed by a temp-dir Store with injected corruption — the
 * guidance spellings doctor.ts and notifier.ts print (repair-meta <id>
 * --title <t>; recover-record <id> <file> --from <p> --source <s>) run end
 * to end: corrupt → CLI repair → next /state clean, and (c) the four-value
 * verdict vocabulary on both surfaces this task widened (cli.ts USAGE and
 * the context.publish MCP tool description). The HTTP endpoints themselves
 * are covered in test/http.test.ts; the state machine's blocked_external
 * derivation rows in test/state-machine.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { DEFAULT_HUB_URL, USAGE, main, parseArgs } from "../src/cli.js";
import { createMcpServer } from "../src/mcp/server.js";
import { startServer, type RunningServer } from "../src/hub/server.js";
import { Store } from "../src/hub/store.js";

// --- parsing (pure parseArgs) ---------------------------------------------------

describe("tut repair-meta parsing", () => {
  it("requires only a task_id and defaults the hub url", () => {
    expect(parseArgs(["repair-meta", "repair-task"])).toEqual({
      command: "repair-meta",
      task_id: "repair-task",
      url: DEFAULT_HUB_URL,
    });
  });

  it("accepts every rebuild field in both flag forms, repeatable --cast", () => {
    expect(
      parseArgs([
        "repair-meta", "repair-task",
        "--title", "Repaired",
        "--description", "rebuilt from notifier snapshot",
        "--creator", "tester",
        "--created-at", "2026-09-07T00:00:00.000Z",
        "--flow", "direct",
        "--cast", "executor=pi",
        "--cast", "reviewer=codex --model gpt-5.6",
        "--checkout", "worktree:/tmp/wt",
        "--url", "http://127.0.0.1:3999",
      ]),
    ).toEqual({
      command: "repair-meta",
      task_id: "repair-task",
      title: "Repaired",
      description: "rebuilt from notifier snapshot",
      creator: "tester",
      createdAt: "2026-09-07T00:00:00.000Z",
      flow: "direct",
      cast: { executor: "pi", reviewer: { agent: "codex", args: ["--model", "gpt-5.6"] } },
      checkout: { kind: "worktree", path: "/tmp/wt" },
      url: "http://127.0.0.1:3999",
    });
    // Equals form parses the same surface (narrow the union before field access).
    const eqForm = parseArgs(["repair-meta", "t", "--title=one"]);
    expect(eqForm.command).toBe("repair-meta");
    expect(eqForm).toEqual({
      command: "repair-meta",
      task_id: "t",
      title: "one",
      url: DEFAULT_HUB_URL,
    });
  });

  it("usage on missing task_id, unknown flag, bad flow, bad cast, bad checkout", () => {
    expect(parseArgs(["repair-meta"])).toEqual({ command: "usage", error: "repair-meta requires a task_id" });
    expect(parseArgs(["repair-meta", "t", "--nope"])).toEqual({ command: "usage", error: "unknown argument: --nope" });
    expect(parseArgs(["repair-meta", "t", "--flow", "bogus"])).toEqual({
      command: "usage",
      error: "--flow must be full|direct|solo, got: bogus",
    });
    expect(parseArgs(["repair-meta", "t", "--cast", "boss=pi"]).command).toBe("usage");
    expect(parseArgs(["repair-meta", "t", "--checkout", "sideways"]).command).toBe("usage");
    expect(parseArgs(["repair-meta", "t", "extra"])).toEqual({ command: "usage", error: "unexpected argument: extra" });
  });
});

describe("tut recover-record parsing", () => {
  it("requires task_id + record file + --from, defaults the hub url", () => {
    expect(parseArgs(["recover-record", "repair-task", "v003.note.json", "--from", "/tmp/snap.json"])).toEqual({
      command: "recover-record",
      task_id: "repair-task",
      recordFile: "v003.note.json",
      from: "/tmp/snap.json",
      url: DEFAULT_HUB_URL,
    });
  });

  it("takes --source and --url in both flag forms", () => {
    expect(
      parseArgs([
        "recover-record", "t", "v001.note.json",
        "--from", "/tmp/a.json", "--source", "nightly backup", "--url", "http://127.0.0.1:3999",
      ]),
    ).toEqual({
      command: "recover-record",
      task_id: "t",
      recordFile: "v001.note.json",
      from: "/tmp/a.json",
      source: "nightly backup",
      url: "http://127.0.0.1:3999",
    });
    // Equals form parses the same surface (narrow the union before field access).
    const eqForm = parseArgs(["recover-record", "t", "v1.note.json", "--from=/f", "--source=s"]);
    expect(eqForm.command).toBe("recover-record");
    expect(eqForm).toEqual({
      command: "recover-record",
      task_id: "t",
      recordFile: "v1.note.json",
      from: "/f",
      source: "s",
      url: DEFAULT_HUB_URL,
    });
  });

  it("usage on missing pieces, extras, unknown flag", () => {
    expect(parseArgs(["recover-record"])).toEqual({ command: "usage", error: "recover-record requires a task_id" });
    expect(parseArgs(["recover-record", "t"])).toEqual({
      command: "usage",
      error: "recover-record requires a record file name (e.g. v003.note.json)",
    });
    expect(parseArgs(["recover-record", "t", "v001.note.json"])).toEqual({ command: "usage", error: "--from is required" });
    expect(parseArgs(["recover-record", "t", "v001.note.json", "--from", "/f", "extra"])).toEqual({
      command: "usage",
      error: "unexpected argument: extra",
    });
    expect(parseArgs(["recover-record", "t", "v001.note.json", "--from", "/f", "--nope"]).command).toBe("usage");
  });
});

// --- guidance surfaces ----------------------------------------------------------

describe("repair guidance and verdict vocabulary surfaces", () => {
  it("USAGE documents both repair subcommands and all four verdict values", () => {
    expect(USAGE).toContain("tut repair-meta <task_id>");
    expect(USAGE).toContain("tut recover-record <task_id> <record_file> --from <path>");
    expect(USAGE).toContain("[--verdict <pass|blocked_external|fail_code|fail_design>]");
  });

  it("context.publish's MCP description lists the four-value verdict vocabulary", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "tut-verdict-"));
    const server = createMcpServer(new Store(path.join(tmp, ".context-hub")));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "tut-verdict-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const publish = (tools.tools ?? []).find((t) => t.name === "context.publish");
      expect(publish?.description).toContain('"pass" | "blocked_external" | "fail_code" | "fail_design"');
    } finally {
      await client.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// --- handlers (real hub, injected corruption) ------------------------------------

function captureIo(): { out: () => string; err: () => string; restore: () => void } {
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

describe("repair-meta / recover-record handlers (real hub)", () => {
  let tmp: string;
  let root: string;
  let store: Store;
  let running: RunningServer;
  let baseUrl: string;
  let io: ReturnType<typeof captureIo>;
  let taskId: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tut-cli-repair-"));
    root = path.join(tmp, ".context-hub");
    store = new Store(root);
    const created = await store.createTask({
      title: "Repair Task",
      description: "task for the repair CLI seam",
      creator: "tester",
      role: "executor",
    });
    taskId = created.task_id;
    await store.append(taskId, {
      role: "executor",
      content_type: "text/plain",
      payload: { summary: "note", body: "a record so the task has derived state" },
    });
    running = await startServer({ root, port: 0 });
    baseUrl = running.url;
    process.env.TUT_HUB_ROOT = tmp;
    io = captureIo();
  });

  afterEach(async () => {
    delete process.env.TUT_HUB_ROOT;
    io.restore();
    await running.close().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  function taskDir(): string {
    return path.join(root, "tasks", taskId);
  }

  function recordFiles(): string[] {
    return readdirSync(taskDir()).filter((f) => /^v\d+\..*\.json$/u.test(f));
  }

  async function state(): Promise<{ tasks: Array<Record<string, unknown>>; degraded?: string[] }> {
    return (await (await fetch(`${baseUrl}/state`)).json()) as { tasks: Array<Record<string, unknown>>; degraded?: string[] };
  }

  it("repair-meta rebuilds a corrupt meta end to end (the doctor guidance spelling), task leaves degraded", async () => {
    writeFileSync(path.join(taskDir(), "meta.json"), "{ broken");
    expect((await state()).degraded).toEqual([taskId]);

    const code = await main(["repair-meta", taskId, "--title", "Repair Task", "--url", baseUrl]);

    expect(code).toBe(0);
    const out = JSON.parse(io.out()) as { task_id: string; version: number; status?: string };
    expect(out).toMatchObject({ task_id: taskId, version: 1 }); // server-computed from disk max
    const after = await state();
    expect(after.degraded).toBeUndefined();
    expect(after.tasks.map((t) => t.task_id)).toContain(taskId);
  });

  it("repair-meta backfills flow/cast/checkout and falls back to the task_id title when --title is omitted", async () => {
    writeFileSync(path.join(taskDir(), "meta.json"), "{ broken");

    const code = await main([
      "repair-meta", taskId,
      "--flow", "direct", "--cast", "executor=pi", "--checkout", "current",
      "--url", baseUrl,
    ]);

    expect(code).toBe(0);
    const after = await state();
    expect(after.degraded).toBeUndefined();
    const entry = after.tasks.find((t) => t.task_id === taskId);
    expect(entry?.flow).toBe("direct");
    expect(entry?.cast).toEqual({ executor: "pi" });
    expect(entry?.checkout).toEqual({ kind: "current" });
    expect(entry?.title).toBe(taskId); // title unavailable → task_id fallback (system-design 4.3)
  });

  it("repair-meta on a readable meta exits 1 with the HTTP 400 line (repair is not an overwrite path)", async () => {
    const code = await main(["repair-meta", taskId, "--title", "rogue overwrite", "--url", baseUrl]);

    expect(code).toBe(1);
    expect(io.err()).toContain("tut: repair-meta failed: HTTP 400:");
    expect(io.err()).toContain("readable — nothing to repair");
  });

  it("repair-meta on an unknown task exits 1 with the HTTP 404 line", async () => {
    const code = await main(["repair-meta", "ghost-task", "--url", baseUrl]);

    expect(code).toBe(1);
    expect(io.err()).toContain("tut: repair-meta failed: HTTP 404:");
    expect(io.err()).toContain("task not found: ghost-task");
  });

  it("recover-record registers recovery end to end (the doctor guidance spelling), corrupt bytes stay pinned", async () => {
    const recordFile = recordFiles()[0]!;
    const original = readFileSync(path.join(taskDir(), recordFile));
    const snapshotPath = path.join(tmp, "external-snapshot.json");
    writeFileSync(snapshotPath, original); // the human's external snapshot of the original bytes
    writeFileSync(path.join(taskDir(), recordFile), "{ broken");

    expect((await state()).degraded).toEqual([taskId]);

    const code = await main([
      "recover-record", taskId, recordFile,
      "--from", snapshotPath, "--source", "nightly backup",
      "--url", baseUrl,
    ]);

    expect(code).toBe(0);
    const out = JSON.parse(io.out()) as { task_id: string; record_file: string; seq: number; recovered_file: string };
    expect(out).toEqual({ task_id: taskId, record_file: recordFile, seq: 1, recovered_file: `${recordFile}.recovered` });
    const after = await state();
    expect(after.degraded).toBeUndefined();
    expect(after.tasks.map((t) => t.task_id)).toContain(taskId);
    // The corrupt original is still on disk, byte-for-byte; the copy landed next to it.
    expect(readFileSync(path.join(taskDir(), recordFile), "utf8")).toBe("{ broken");
    expect(readFileSync(path.join(taskDir(), `${recordFile}.recovered`)).equals(original)).toBe(true);
  });

  it("recover-record on a healthy record exits 1 with the HTTP 400 line", async () => {
    const recordFile = recordFiles()[0]!;

    const code = await main(["recover-record", taskId, recordFile, "--from", "/etc/hostname", "--url", baseUrl]);

    expect(code).toBe(1);
    expect(io.err()).toContain("tut: recover-record failed: HTTP 400:");
    expect(io.err()).toContain("parses — nothing to recover");
  });

  it("recover-record on an unknown task exits 1 with the HTTP 404 line", async () => {
    const code = await main(["recover-record", "ghost-task", "v001.note.json", "--from", "/tmp/x", "--url", baseUrl]);

    expect(code).toBe(1);
    expect(io.err()).toContain("tut: recover-record failed: HTTP 404:");
    expect(io.err()).toContain("task not found: ghost-task");
  });

  it("both subcommands against an unreachable hub exit 1 with the unified HUB_UNREACHABLE line", async () => {
    const deadUrl = "http://127.0.0.1:9";
    const repairCode = await main(["repair-meta", taskId, "--url", deadUrl]);
    const recoverCode = await main(["recover-record", taskId, "v001.note.json", "--from", "/tmp/x", "--url", deadUrl]);

    expect(repairCode).toBe(1);
    expect(recoverCode).toBe(1);
    for (const line of io.err().split("\n").filter((l) => l.startsWith("HUB_UNREACHABLE:"))) {
      expect(line).toContain(`cannot reach the Hub at ${deadUrl} (`);
      expect(line.endsWith("— start it with: tut serve")).toBe(true);
    }
    expect(io.err().split("\n").filter((l) => l.startsWith("HUB_UNREACHABLE:")).length).toBe(2);
  });
});

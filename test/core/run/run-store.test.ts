import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunReadStore } from "../../../src/hub/run-store.js";

// A configurable module facade lets fault injection use real filesystem I/O.
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

// Instrument the public file-opener seam on both hosts. Native Windows opens
// use PowerShell handles, so spying on node:fs.open alone misses actual reads.
const fileBoundary = vi.hoisted(() => ({ lengths: undefined as number[] | undefined, afterOpen: undefined as (() => Promise<void>) | undefined }));
vi.mock('../../../src/hub/run-file.js', async original => {
  const actual = await original<typeof import('../../../src/hub/run-file.js')>();
  const wrap = (open: import('../../../src/hub/run-file.js').RunFileOpener) => async (file: string) => {
    try {
      const handle = await open(file);
      if (/[/\\]log$/.test(file) && fileBoundary.lengths) {
        const read = handle.read.bind(handle);
        handle.read = (...args) => { fileBoundary.lengths!.push(args[2]); return read(...args); };
      }
      return handle;
    } finally { await fileBoundary.afterOpen?.(); }
  };
  return { ...actual, openRunFile: wrap(actual.openRunFile),
    withRunFileSession: <T>(read: (open: import('../../../src/hub/run-file.js').RunFileOpener) => Promise<T>) => actual.withRunFileSession(open => read(wrap(open))),
  };
});
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "tut-runs-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const errno = (code: string) => Object.assign(new Error(code), { code });
const meta = (id: string, extra: Record<string, unknown> = {}) => ({ run_id: id, pid: process.pid, pgid: process.pid, argv: ["node", "", "<script>"], started_at: "2026-10-17T00:00:00Z", status: "running", ...extra });
async function seed(id: string, extra: Record<string, unknown> = {}, log = "one\ntwo\n") {
  const dir = path.join(root, "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta(id, extra)));
  await writeFile(path.join(dir, "log"), log);
  return dir;
}

describe("read-only run projection", () => {
  it("does not create a missing runs directory; empty and hidden/non-directory entries are empty", async () => {
    expect(await new RunReadStore(root).snapshot()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    await mkdir(path.join(root, "runs"));
    await mkdir(path.join(root, "runs", ".tmp"));
    await writeFile(path.join(root, "runs", "file"), "ignored");
    expect(await new RunReadStore(root).snapshot()).toEqual([]);
  });
  it("keeps valid metadata, ignores additions, and never changes files or sends a nonzero signal", async () => {
    const dir = await seed("healthy", { task_id: "task", future_field: { anything: true } });
    const before = await readFile(path.join(dir, "meta.json"), "utf8");
    const kill = vi.spyOn(process, "kill");
    try {
      const [run] = await new RunReadStore(root).snapshot();
      expect(run).toMatchObject({ run_id: "healthy", status: "running", task_id: "task", pid_alive: true, degraded: false, issues: [], log_tail: ["one", "two"], log_truncated: false, log_available: true });
      expect(run!.argv_summary).toBe('["node","","<script>"]');
      expect(kill.mock.calls).toEqual([[process.pid, 0]]);
      expect(await readFile(path.join(dir, "meta.json"), "utf8")).toBe(before);
      expect(await readdir(dir)).toEqual(["log", "meta.json"]);
    } finally { kill.mockRestore(); }
  });
  it.each([
    { pid: 0 }, { pid: -1 }, { pid: 2.1 }, { pgid: 0 }, { pid: Number.MAX_SAFE_INTEGER + 1 },
    { run_id: "wrong" }, { argv: [] }, { argv: [""] }, { argv: ["node", 1] },
    { started_at: "unknown" }, { task_id: "" }, { status: "unknown" },
  ])("invalid consumed metadata is not invented: %j", async extra => {
    await seed("bad", extra);
    await seed("healthy");
    const probe = vi.fn();
    const runs = await new RunReadStore(root, probe).snapshot();
    const bad = runs.find(r => r.run_id === "bad")!;
    expect(bad).toMatchObject({ degraded: true, issues: [{ source: "meta", code: "meta_invalid" }], pid_alive: null, log_tail: ["one", "two"] });
    for (const field of ["pid", "status", "argv_summary", "task_id", "started_at"]) expect(bad).not.toHaveProperty(field);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(runs.find(r => r.run_id === "healthy")!.degraded).toBe(false);
  });
  it("exposes missing and malformed meta, absent log, and recovers without repair writes", async () => {
    const dir = await seed("bad");
    await writeFile(path.join(dir, "meta.json"), "{");
    expect((await new RunReadStore(root).snapshot())[0]!.issues).toContainEqual({ source: "meta", code: "meta_invalid" });
    await rm(path.join(dir, "meta.json"));
    expect((await new RunReadStore(root).snapshot())[0]!.issues).toContainEqual({ source: "meta", code: "meta_missing" });
    await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta("bad")));
    await rm(path.join(dir, "log"));
    expect((await new RunReadStore(root).snapshot())[0]).toMatchObject({ status: "running", degraded: true, log_available: false, log_tail: [], log_truncated: false });
    await writeFile(path.join(dir, "log"), "");
    expect((await new RunReadStore(root).snapshot())[0]).toMatchObject({ degraded: false, log_available: true, log_tail: [] });
  });
  it("reports a quarantine marker beside an absent meta as the terminal disposition, not meta_missing", async () => {
    const dir = await seed("20261016T175040618Z-2eef3709");
    await rm(path.join(dir, "meta.json"));
    await writeFile(path.join(dir, "meta.json.broken"), "{torn");
    let [run] = await new RunReadStore(root).snapshot();
    expect(run).toMatchObject({ run_id: "20261016T175040618Z-2eef3709", degraded: true, issues: [{ source: "meta", code: "meta_quarantined" }], log_available: true, log_tail: ["one", "two"] });
    await rename(path.join(dir, "meta.json.broken"), path.join(dir, "meta.json.broken.9e2f1ab0"));
    [run] = await new RunReadStore(root).snapshot();
    expect(run!.issues).toEqual([{ source: "meta", code: "meta_quarantined" }]);
    await rm(path.join(dir, "meta.json.broken.9e2f1ab0"));
    [run] = await new RunReadStore(root).snapshot();
    expect(run!.issues).toEqual([{ source: "meta", code: "meta_missing" }]);
  });
  it("keeps a valid adopted meta authoritative over a leftover quarantine marker", async () => {
    const dir = await seed("20261016T175040618Z-2eef3709");
    await writeFile(path.join(dir, "meta.json.broken"), "{torn");
    const [run] = await new RunReadStore(root).snapshot();
    expect(run!.degraded).toBe(false);
    expect(run!.issues).toEqual([]);
  });
  it("recovers the original started_at from a preserved meta copy, and nothing else", async () => {
    const id = "20261016T175040618Z-2eef3709";
    const dir = await seed(id);
    await rm(path.join(dir, "meta.json"));
    await writeFile(path.join(dir, "meta.json.broken"), JSON.stringify({ run_id: id, pid: 7, argv: ["x"], started_at: "2026-10-16T17:50:40.647Z", status: "exited", cwd: "/somewhere" }));
    const [run] = await new RunReadStore(root).snapshot();
    expect(run).toMatchObject({ run_id: id, degraded: true, started_at: "2026-10-16T17:50:40.647Z", issues: [{ source: "meta", code: "meta_quarantined" }] });
    expect(run).not.toHaveProperty("argv_summary");
    expect(run).not.toHaveProperty("status");
    expect(run).not.toHaveProperty("task_id");
    // A copy that does not carry this run's identity is not evidence.
    await writeFile(path.join(dir, "meta.json.broken"), JSON.stringify({ run_id: "other", started_at: "2026-10-16T17:50:40.647Z" }));
    expect((await new RunReadStore(root).snapshot())[0]).not.toHaveProperty("started_at");
    // Nor one whose start predates the id's embedded creation instant.
    await writeFile(path.join(dir, "meta.json.broken"), JSON.stringify({ run_id: id, started_at: "2026-10-15T00:00:00Z" }));
    expect((await new RunReadStore(root).snapshot())[0]).not.toHaveProperty("started_at");
    // A .hex-suffixed copy evidences the same way as the base name.
    await rm(path.join(dir, "meta.json.broken"));
    await writeFile(path.join(dir, "meta.json.broken.9e2f1ab0"), JSON.stringify({ run_id: id, started_at: "2026-10-16T17:50:40.647Z" }));
    expect((await new RunReadStore(root).snapshot())[0]).toHaveProperty("started_at", "2026-10-16T17:50:40.647Z");
  });
  it("never takes start evidence from the log: stdout timestamps may describe echoed data, not this run", async () => {
    // A child can print any JSON — a business row, or a protocol-shaped line —
    // whose timestamp describes the data's own time, not the moment it was
    // written. Even a stamp inside the creation→start window proves nothing,
    // and no shape check can attribute the line to this run's live emission,
    // so log bytes never fill started_at.
    const id = "20261026T122355505Z-41fd153b"; // id instant 12:23:55.505Z
    const dir = await seed(id, {}, '{"timestamp":"2026-10-26T12:23:55.654Z","order_id":"archived-business-row","value":17}\n');
    await rm(path.join(dir, "meta.json"));
    const expectBare = async (code: string) => {
      const [run] = await new RunReadStore(root).snapshot();
      expect(run).toMatchObject({ run_id: id, degraded: true, issues: [{ source: "meta", code }], log_available: true });
      expect(run).not.toHaveProperty("started_at");
    };
    // Ordinary business JSON whose stamp sits between the id's creation
    // instant and a later round boundary: plausible-looking, still not evidence.
    await expectBare("meta_missing");
    // An unparseable meta meets the same refusal.
    await writeFile(path.join(dir, "meta.json"), "{");
    await expectBare("meta_invalid");
    // Protocol-shaped lines are equally unattributable: an echoed session or
    // tool event carries its own historical clock, not this run's emission.
    await rm(path.join(dir, "meta.json"));
    await writeFile(path.join(dir, "log"), '{"type":"session","version":3,"id":"s","timestamp":"2026-10-26T12:23:55.654Z","cwd":"/x"}\n{"type":"tool_execution_start","toolName":"x","timestamp":1793015112100}\n');
    await expectBare("meta_missing");
    // A disposition's saved meta copy remains the one recoverable evidence.
    await writeFile(path.join(dir, "meta.json.broken"), JSON.stringify({ run_id: id, started_at: "2026-10-26T12:23:56.061Z" }));
    const [run] = await new RunReadStore(root).snapshot();
    expect(run).toMatchObject({ issues: [{ source: "meta", code: "meta_quarantined" }], started_at: "2026-10-26T12:23:56.061Z" });
  });
  it("reports PID false/unknown without changing status or degrading storage", async () => {
    await seed("run");
    for (const [code, alive] of [["ESRCH", false], ["EPERM", null], ["EIO", null]] as const) {
      const [run] = await new RunReadStore(root, () => { throw errno(code); }).snapshot();
      expect(run).toMatchObject({ status: "running", pid_alive: alive, degraded: false });
      expect(run!.issues).toEqual(code === "ESRCH" ? [] : [{ source: "pid", code: "pid_unknown" }]);
    }
  });
  it("uses chronological order, puts unknown last, and bounds the Unicode argv summary", async () => {
    await seed("old", { started_at: "2025-01-01", argv: ["😀".repeat(300)] });
    await seed("new");
    const dir = await seed("bad"); await writeFile(path.join(dir, "meta.json"), "{}");
    const runs = await new RunReadStore(root).snapshot();
    expect(runs.map(r => r.run_id)).toEqual(["new", "old", "bad"]);
    expect(Array.from(runs[1]!.argv_summary!)).toHaveLength(240);
    expect(runs[1]!.argv_summary!.endsWith("…")).toBe(true);
  });
  it("takes 20 LF/CRLF lines, preserves final partial line, and caps huge UTF-8 single lines at 64 KiB", async () => {
    await seed("lines", {}, Array.from({ length: 30 }, (_, i) => String(i)).join("\r\n"));
    let run = (await new RunReadStore(root).snapshot())[0]!;
    expect(run.log_tail).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 10)));
    expect(run.log_truncated).toBe(true);
    await writeFile(path.join(root, "runs", "lines", "log"), "😀".repeat(30000) + "中");
    run = (await new RunReadStore(root).snapshot())[0]!;
    expect(Buffer.byteLength(run.log_tail.join("\n"))).toBeLessThanOrEqual(65536);
    expect(run.log_tail.join("")).not.toContain("�");
    expect(run.log_tail[0]!.endsWith("中")).toBe(true);
    expect(run.log_truncated).toBe(true);
  });
  it("rejects symbolic links at the runs root, run directory, meta and log without leaking targets", async () => {
    const outside = path.join(root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret"), "SECRET");
    await symlink(outside, path.join(root, "runs"));
    await expect(new RunReadStore(root).snapshot()).rejects.toThrow();
    await rm(path.join(root, "runs")); await mkdir(path.join(root, "runs"));
    await symlink(outside, path.join(root, "runs", "linked"));
    const dir = await seed("files");
    for (const file of ["meta.json", "log"]) {
      await rm(path.join(dir, file)); await symlink(path.join(outside, "secret"), path.join(dir, file));
    }
    const runs = await new RunReadStore(root).snapshot();
    expect(runs.every(r => r.degraded && r.log_tail.length === 0)).toBe(true);
    expect(JSON.stringify(runs)).not.toContain("SECRET");
    expect(runs.find(r => r.run_id === "files")!.issues).toEqual([{ source: "meta", code: "unsafe_path" }, { source: "log", code: "unsafe_path" }]);
  });
  it("top-level type/read errors throw rather than masquerading as an empty list", async () => {
    await writeFile(path.join(root, "runs"), "not a directory");
    await expect(new RunReadStore(root).snapshot()).rejects.toThrow();
  });
});

it("preserves real empty lines while ignoring only the terminal newline", async () => {
  await seed("blank", {}, "\n");
  expect((await new RunReadStore(root).snapshot())[0]!.log_tail).toEqual([""]);
  await writeFile(path.join(root, "runs", "blank", "log"), "first\r\n\r\nlast\r\n");
  expect((await new RunReadStore(root).snapshot())[0]!.log_tail).toEqual(["first", "", "last"]);
});


it("bounds the actual log read even when the file contains megabytes", async () => {
  await seed("huge", {}, "x".repeat(2 * 1024 * 1024));
  const readCalls: number[] = [];
  fileBoundary.lengths = readCalls;
  try {
    const [run] = await new RunReadStore(root).snapshot();
    expect(readCalls).toEqual([65536]);
    expect(run!.log_tail[0]).toHaveLength(65536);
    expect(run!.log_truncated).toBe(true);
  } finally { fileBoundary.lengths = undefined; }
});

it("shows a run disappearing after enumeration as a local failure and keeps its neighbor", async () => {
  const dir = await seed("gone"); await seed("healthy");
  const original = files.readdir;
  const spy = vi.spyOn(files, "readdir").mockImplementationOnce((async (...args: Parameters<typeof files.readdir>) => {
    const entries = await original(...args);
    await rm(dir, { recursive: true });
    return entries;
  }) as typeof files.readdir);
  try {
    const runs = await new RunReadStore(root).snapshot();
    expect(runs.find(r => r.run_id === "gone")).toMatchObject({ degraded: true, issues: [{ source: "meta", code: "meta_missing" }] });
    expect(runs.find(r => r.run_id === "healthy")!.degraded).toBe(false);
  } finally { spy.mockRestore(); }
});

it("propagates an unreadable top-level directory instead of reporting empty", async () => {
  await mkdir(path.join(root, "runs"));
  const spy = vi.spyOn(files, "readdir").mockRejectedValueOnce(errno("EACCES"));
  try { await expect(new RunReadStore(root).snapshot()).rejects.toMatchObject({ code: "EACCES" }); }
  finally { spy.mockRestore(); }
});


it.each(["meta.json", "log"])("does not leak %s when a run directory is linked outside only during stat/open", async name => {
  const dir = await seed("raced", { argv: ["INSIDE_META_MARKER"] }, "INSIDE_LOG_MARKER");
  await seed("healthy");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "meta.json"), JSON.stringify(meta("raced", { argv: ["OUTSIDE_META_MARKER"] })));
  await writeFile(path.join(outside, "log"), "OUTSIDE_LOG_MARKER");
  const saved = path.join(root, "saved-run");
  const target = await files.realpath(path.join(dir, name));
  const originalStat = files.lstat;
  let swapped = false, arranged = false, restored = false;
  const restore = async () => {
    if (swapped) { await rm(dir); await rename(saved, dir); swapped = false; restored = true; }
  };
  const statSpy = vi.spyOn(files, "lstat").mockImplementation((async (...args: Parameters<typeof files.lstat>) => {
    // A real directory/symlink replacement after parent validation, not a fake stat.
    if (!arranged && String(args[0]) === target) {
      await rename(dir, saved); await symlink(outside, dir); swapped = true; arranged = true;
    }
    return originalStat(...args);
  }) as typeof files.lstat);
  fileBoundary.afterOpen = restore; // Restore before the caller re-checks its parent.
  try {
    const runs = await new RunReadStore(root).snapshot();
    expect(arranged).toBe(true); expect(restored).toBe(true);
    expect(JSON.stringify(runs)).not.toContain("OUTSIDE_");
    const raced = runs.find(r => r.run_id === "raced")!;
    expect(raced.degraded).toBe(true);
    expect(raced.issues).toContainEqual({ source: name === "log" ? "log" : "meta", code: "unsafe_path" });
    expect(runs.find(r => r.run_id === "healthy")!.degraded).toBe(false);
  } finally { statSpy.mockRestore(); fileBoundary.afterOpen = undefined; await restore(); }
});

describe('partitioned run output compatibility', () => {
  it('projects both layouts and reads the selected raw byte stream without rewriting legacy evidence', async () => {
    const id = '20261101T000000000Z-01234567';
    const legacy = await seed(id, {}, 'legacy\n');
    const reader = new RunReadStore(root);
    expect(Buffer.from((await reader.readLogRange(id)).data, 'base64').toString()).toBe('legacy\n');
    const output = path.join(root, 'logs', 'runs', id);
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'log'), 'partitioned\n');
    expect((await reader.snapshot())[0]!.log_tail).toEqual(['partitioned']);
    expect(Buffer.from((await reader.readLogRange(id)).data, 'base64').toString()).toBe('partitioned\n');
    await rm(path.join(output, 'log'));
    await expect(reader.readLogRange(id)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await reader.snapshot())[0]!.issues).toContainEqual({ source: 'log', code: 'log_missing' });
    expect(await readFile(path.join(legacy, 'log'), 'utf8')).toBe('legacy\n');
  });

  it('refuses unsafe new output ancestors instead of falling back to a healthy legacy log', async () => {
    const id = '20261101T000000000Z-01234567';
    await seed(id);
    await symlink(path.join(root, 'runs'), path.join(root, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
    const reader = new RunReadStore(root);
    await expect(reader.readLogRange(id)).rejects.toMatchObject({ code: 'ELOOP' });
    expect((await reader.snapshot())[0]!.issues).toContainEqual({ source: 'log', code: 'unsafe_path' });
  });

  it('allocates new logs separately and preserves the entire home when copied, including unknown content', async () => {
    const { RunStore } = await import('../../../src/core/run/store.js');
    const { writeFileSync, closeSync } = await import('node:fs');
    const { cp } = await import('node:fs/promises');
    const store = new RunStore(root);
    const id = store.create();
    const fd = store.openLog(id, true);
    try { writeFileSync(fd, 'raw output\n'); } finally { closeSync(fd); }
    await store.initialize(id, { ...meta(id), cwd: root, supervisor_pid: process.pid + 1, status: 'running' });
    const home = path.join(root, '.context-hub');
    await mkdir(path.join(home, 'tasks', 'preserved'), { recursive: true });
    for (const name of ['0001-note.json', 'usage.json']) await writeFile(path.join(home, 'tasks', 'preserved', name), '{"evidence":true}\n');
    await writeFile(path.join(home, 'config.json'), '{"flow_mode":"manual"}\n');
    await writeFile(path.join(home, 'runtime', 'unknown'), 'protected');
    await writeFile(path.join(home, '.DS_Store'), 'protected');
    const copiedRoot = path.join(root, 'copy');
    await cp(home, path.join(copiedRoot, '.context-hub'), { recursive: true });
    const copied = new RunStore(copiedRoot);
    expect(copied.read(id)).toEqual(store.read(id));
    expect(await readFile(copied.logPath(id), 'utf8')).toBe('raw output\n');
    expect((await new RunReadStore(path.join(copiedRoot, '.context-hub')).snapshot())[0]!.degraded).toBe(false);
    expect(await readdir(store.directory(id))).toEqual(['meta.json']);
    const release = await copied.lockAdmission(); release();
    for (const name of ['tasks/preserved/0001-note.json', 'tasks/preserved/usage.json', 'config.json', 'runtime/unknown', '.DS_Store']) {
      expect(await readFile(path.join(copiedRoot, '.context-hub', name))).toEqual(await readFile(path.join(home, name)));
    }
  });
});

it('the writer/read port observes a legacy run in place without allocating a new output directory', async () => {
  const { RunStore } = await import('../../../src/core/run/store.js');
  const { closeSync, readFileSync } = await import('node:fs');
  const id = '20261101T000000000Z-01234567';
  const dir = path.join(root, '.context-hub', 'runs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'log'), 'legacy stdout\n');
  const store = new RunStore(root);
  const fd = store.openLog(id);
  try { expect(readFileSync(fd, 'utf8')).toBe('legacy stdout\n'); } finally { closeSync(fd); }
  expect(store.logInfo(id).mtimeMs).toBeGreaterThan(0);
  expect(store.logPath(id)).toBe(path.join(dir, 'log'));
  expect(await readdir(path.join(root, '.context-hub'))).toEqual(['runs']);
});

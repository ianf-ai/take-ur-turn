/** Read-only projection of the wrapper's file protocol. No task or process writes. */
import { lstat, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { openRunFile } from "./run-file.js";
import { validateId } from "../run/store.js";

export const LOG_RANGE_LIMIT = 64 * 1024;

/** Byte cursors refer to the raw log, not Base64 characters or decoded text. */
export interface RunLogRange {
  run_id: string;
  from: number;
  next: number;
  size: number;
  eof: boolean;
  encoding: "base64";
  data: string;
}

export class RunLogRangeError extends Error {
  constructor(readonly code: "RANGE_NOT_SATISFIABLE" | "LOG_CHANGED", readonly from: number, readonly size: number) {
    super(code);
  }
}

export interface RunEntry {
  run_id: string;
  task_id?: string;
  argv_summary?: string;
  started_at?: string;
  status?: "running" | "stopped" | "exited";
  pid?: number;
  pid_alive: boolean | null;
  degraded: boolean;
  issues: { source: "meta" | "log" | "pid"; code: string }[];
  log_available: boolean;
  log_tail: string[];
  log_truncated: boolean;
  /** Anchored checkout landing point from run meta, when present (additive). */
  checkout?: string;
}

const TAIL_BYTES = 64 * 1024;
const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "";
const positivePid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && (pid as number) > 0;

// These identity checks detect ordinary replacement/disappearance. Security
// against a temporary ancestor link comes from openRunFile's kernel-enforced
// lookup, not from before/after checks of a mutable pathname.
// Canonicalize only the configured storage root (e.g. macOS /var -> /private/var).
interface Directory { file: string; dev: number; ino: number }
const unsafe = (): Error => Object.assign(new Error("unsafe path"), { code: "ELOOP" });
async function directory(file: string): Promise<Directory> {
  const stat = await lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
  return { file, dev: stat.dev, ino: stat.ino };
}
async function unchanged(dir: Directory): Promise<void> {
  const stat = await lstat(dir.file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== dir.dev || stat.ino !== dir.ino) throw unsafe();
}
async function regular(parent: Directory, name: string): Promise<FileHandle> {
  await unchanged(parent);
  const file = path.join(parent.file, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw unsafe();
  // The actual open rejects links in all components; NONBLOCK avoids FIFO hangs.
  const handle = await openRunFile(file);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw unsafe();
    await unchanged(parent);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
function issueCode(error: unknown, source: "meta" | "log"): string {
  const code = codeOf(error);
  return code === "ELOOP" || code === "ENOTDIR" || code === "EUNSAFEPATH" ? "unsafe_path" : code === "ENOENT" ? `${source}_missing` : `${source}_unreadable`;
}

export class RunReadStore {
  constructor(private readonly root: string, private readonly probe: (pid: number) => void = pid => process.kill(pid, 0)) {}

  /**
   * Read a bounded slice of a safely opened log without consulting meta or PID.
   * size/eof describe this request's fstat snapshot, never process completion.
   * Appends beyond size are left for the next request; detectable truncation is
   * an error (no partial page). All failures leave the caller's cursor unchanged.
   */
  async readLogRange(id: string, from = 0, limit = LOG_RANGE_LIMIT): Promise<RunLogRange> {
    validateId(id);
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > LOG_RANGE_LIMIT) {
      throw new RangeError("invalid log byte range");
    }
    const runs = await directory(path.join(await realpath(this.root), "runs"));
    const dir = await directory(path.join(runs.file, id));
    await unchanged(runs);
    const log = await regular(dir, "log");
    try {
      const size = (await log.stat()).size;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("unsupported log size");
      if (from > size) throw new RunLogRangeError("RANGE_NOT_SATISFIABLE", from, size);
      // Subtract before adding to avoid overflowing a safe cursor near MAX_SAFE_INTEGER.
      const buffer = Buffer.alloc(Math.min(limit, size - from));
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await log.read(buffer, read, buffer.length - read, from + read);
        if (bytesRead === 0) throw new RunLogRangeError("LOG_CHANGED", from, size);
        read += bytesRead;
      }
      if ((await log.stat()).size < size) throw new RunLogRangeError("LOG_CHANGED", from, size);
      await unchanged(runs);
      await unchanged(dir);
      const next = from + read;
      return { run_id: id, from, next, size, eof: next === size, encoding: "base64", data: buffer.toString("base64") };
    } finally { await log.close(); }
  }

  async snapshot(): Promise<RunEntry[]> {
    let runs: Directory;
    try { runs = await directory(path.join(await realpath(this.root), "runs")); }
    catch (error) { if (codeOf(error) === "ENOENT") return []; throw error; }
    const names = await readdir(runs.file, { withFileTypes: true });
    const result: RunEntry[] = [];
    // Sequential reads keep descriptors and memory bounded independently of run count.
    for (const entry of names) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      result.push(await this.readRun(runs, entry.name));
    }
    await unchanged(runs);
    return result.sort((a, b) => (b.started_at ? Date.parse(b.started_at) : -Infinity) -
      (a.started_at ? Date.parse(a.started_at) : -Infinity) || a.run_id.localeCompare(b.run_id));
  }

  private async readRun(runs: Directory, id: string): Promise<RunEntry> {
    const run: RunEntry = { run_id: id, pid_alive: null, degraded: false, issues: [], log_available: false, log_tail: [], log_truncated: false };
    const problem = (source: "meta" | "log", code: string): void => { run.degraded = true; run.issues.push({ source, code }); };
    let dir: Directory;
    try { await unchanged(runs); dir = await directory(path.join(runs.file, id)); }
    catch (error) { problem("meta", issueCode(error, "meta")); return run; }
    let metaFile: FileHandle | undefined;
    try {
      metaFile = await regular(dir, "meta.json");
      // Metadata is small by protocol; reject unbounded/corrupt input.
      const metaSize = (await metaFile.stat()).size;
      if (metaSize > 1024 * 1024) throw new SyntaxError("oversized meta");
      const metaBytes = Buffer.alloc(metaSize);
      const read = await metaFile.read(metaBytes, 0, metaBytes.length, 0);
      const m = JSON.parse(metaBytes.subarray(0, read.bytesRead).toString("utf8")) as Record<string, unknown> | null;
      if (!m || m.run_id !== id || !positivePid(m.pid) || !positivePid(m.pgid) ||
        !Array.isArray(m.argv) || !m.argv.length || typeof m.argv[0] !== "string" || !m.argv[0].length ||
        !m.argv.every(x => typeof x === "string") || typeof m.started_at !== "string" || !Number.isFinite(Date.parse(m.started_at)) ||
        !["running", "stopped", "exited"].includes(m.status as string) ||
        (m.task_id !== undefined && (typeof m.task_id !== "string" || !m.task_id.trim()))) throw new SyntaxError("invalid meta");
      const summary = Array.from(JSON.stringify(m.argv));
      run.argv_summary = summary.length > 240 ? summary.slice(0, 239).join("") + "…" : summary.join("");
      run.started_at = m.started_at;
      run.status = m.status as "running" | "stopped" | "exited";
      run.pid = m.pid;
      if (typeof m.task_id === "string") run.task_id = m.task_id;
      if (typeof m.checkout === "string" && m.checkout.length > 0) run.checkout = m.checkout;
      try { this.probe(m.pid); run.pid_alive = true; }
      catch (error) {
        if (codeOf(error) === "ESRCH") run.pid_alive = false;
        else run.issues.push({ source: "pid", code: "pid_unknown" });
      }
    } catch (error) { problem("meta", error instanceof SyntaxError ? "meta_invalid" : issueCode(error, "meta")); }
    finally { await metaFile?.close(); }
    let log: FileHandle | undefined;
    try {
      log = await regular(dir, "log");
      const size = (await log.stat()).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
      const { bytesRead } = await log.read(buffer, 0, buffer.length, start);
      let offset = 0;
      // Drop only leading UTF-8 continuation bytes from a partial character.
      if (start > 0) while (offset < bytesRead && (buffer[offset]! & 0xc0) === 0x80) offset++;
      let text = buffer.subarray(offset, bytesRead).toString("utf8");
      if (text.endsWith("\n")) text = text.slice(0, -1);
      const lines = bytesRead ? text.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line) : [];
      run.log_tail = lines.slice(-20);
      run.log_truncated = start > 0 || lines.length > 20;
      run.log_available = true;
    } catch (error) { problem("log", issueCode(error, "log")); }
    finally { await log?.close(); }
    try { await unchanged(runs); await unchanged(dir); }
    catch { return { run_id: id, pid_alive: null, degraded: true, issues: [{ source: "meta", code: "unsafe_path" }], log_available: false, log_tail: [], log_truncated: false }; }
    return run;
  }
}

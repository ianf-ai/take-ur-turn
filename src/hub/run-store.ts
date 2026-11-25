/** Read-only projection of the wrapper's file protocol. No task or process writes. */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { openRunFile, withRunFileSession, type RunFile, type RunFileOpener } from "./run-file.js";
import { QUARANTINE_BASE, validateId } from "../core/run/store.js";

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
async function regular(parent: Directory, name: string, open: RunFileOpener = openRunFile): Promise<RunFile> {
  await unchanged(parent);
  const file = path.join(parent.file, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw unsafe();
  // The actual open rejects links in all components; NONBLOCK avoids FIFO hangs.
  const handle = await open(file);
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
/** repair-run's terminal disposition marker (meta.json.broken[.<hex>]) beside an
 * absent meta.json. Name-based like repair's own evidence check; null when the
 * directory listing itself fails (unknowable — caller keeps the base code). */
async function quarantineMarker(dir: Directory): Promise<boolean | null> {
  try {
    const names = await readdir(dir.file);
    return names.some(name => name === QUARANTINE_BASE || name.startsWith(`${QUARANTINE_BASE}.`));
  } catch { return null; }
}
/** Preserved meta copies never feed the projection's identity fields. The one
 * field worth recovering is started_at — the run's own record of when it began,
 * preserved verbatim by repair-run's rename. Accepted only when a copy parses,
 * carries this run's id, and does not predate the id's embedded creation
 * instant (the supervisor records started_at after the directory exists).
 * Everything else about a broken archive stays unexposed. */
const MARKER_COPY_LIMIT = 64 * 1024;
const idInstant = (id: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/.exec(id);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!) : -Infinity;
};
async function quarantineStartEvidence(dir: Directory, id: string, open: RunFileOpener): Promise<string | undefined> {
  let names: string[];
  try { names = (await readdir(dir.file)).filter(name => name === QUARANTINE_BASE || name.startsWith(`${QUARANTINE_BASE}.`)).sort(); }
  catch { return undefined; }
  for (const name of names) {
    let file: RunFile | undefined;
    try {
      file = await regular(dir, name, open);
      const size = (await file.stat()).size;
      if (size > MARKER_COPY_LIMIT) continue;
      const bytes = Buffer.alloc(size);
      const read = await file.read(bytes, 0, size, 0);
      const m = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")) as Record<string, unknown> | null;
      if (!m || m.run_id !== id || typeof m.started_at !== "string" || !Number.isFinite(Date.parse(m.started_at))) continue;
      if (Date.parse(m.started_at) >= idInstant(id)) return m.started_at;
    } catch { /* a copy that cannot be trusted is simply not evidence */ }
    finally { await file?.close(); }
  }
  return undefined;
}
/** Why the log is never start evidence: it is the child's raw stdout and
 * stderr, so any JSON it contains — a business record, or even a
 * protocol-shaped event — may be echoed historical data whose timestamp
 * describes the data, not the moment this run wrote it. Nothing in storage
 * can verify that a log line was emitted by this run at its stamped time, so
 * log bytes are never used to fill started_at. The one recoverable evidence
 * is the disposition-preserved meta copy above, whose bytes repair-run
 * renamed verbatim out of this run's own meta.json and whose run_id is
 * cross-checked; runs without such a copy simply stay without started_at. */

/** Resolve only an absent output allocation to the legacy identity directory.
 * A corrupt/unsafe new allocation is an error, never grounds for fallback. */
async function logDirectory(root: string, id: string, legacy: Directory): Promise<Directory> {
  let current = root;
  try {
    for (const part of ['logs', 'runs', id]) {
      current = path.join(current, part);
      await directory(current);
    }
    return await directory(current);
  } catch (error) { if (codeOf(error) !== 'ENOENT') throw error; }
  return legacy;
}

export class RunReadStore {
  constructor(private readonly root: string, private readonly probe: (pid: number) => void = pid => process.kill(pid, 0)) {}

  /** Return startup evidence verbatim, without parsing metadata or probing a PID. */
  async readHeadlessStartRaw(id: string): Promise<Buffer> {
    validateId(id);
    const runs = await directory(path.join(await realpath(this.root), "runs"));
    const dir = await directory(path.join(runs.file, id));
    await unchanged(runs);
    const file = await regular(dir, "headless-start.json");
    try {
      const size = (await file.stat()).size;
      // Like run meta, startup metadata must not cause an unbounded allocation.
      if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024) throw new Error("unsupported headless-start size");
      const bytes = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const { bytesRead } = await file.read(bytes, read, size - read, read);
        if (bytesRead === 0) throw new Error("headless-start changed during read");
        read += bytesRead;
      }
      if ((await file.stat()).size !== size) throw new Error("headless-start changed during read");
      await unchanged(runs);
      await unchanged(dir);
      return bytes;
    } finally { await file.close(); }
  }

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
    const output = await logDirectory(await realpath(this.root), id, dir);
    const log = await regular(output, "log");
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
      await unchanged(output);
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
    // Sequential reads bound handles/memory. Windows also compiles its bridge
    // just once per snapshot, releasing each file's chain before the next open.
    await withRunFileSession(async open => {
      for (const entry of names) {
        if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
        result.push(await this.readRun(runs, entry.name, open));
      }
    });
    await unchanged(runs);
    return result.sort((a, b) => (b.started_at ? Date.parse(b.started_at) : -Infinity) -
      (a.started_at ? Date.parse(a.started_at) : -Infinity) || a.run_id.localeCompare(b.run_id));
  }

  private async readRun(runs: Directory, id: string, open: RunFileOpener): Promise<RunEntry> {
    const run: RunEntry = { run_id: id, pid_alive: null, degraded: false, issues: [], log_available: false, log_tail: [], log_truncated: false };
    const problem = (source: "meta" | "log", code: string): void => { run.degraded = true; run.issues.push({ source, code }); };
    let dir: Directory;
    try { await unchanged(runs); dir = await directory(path.join(runs.file, id)); }
    catch (error) { problem("meta", issueCode(error, "meta")); return run; }
    let metaFile: RunFile | undefined;
    try {
      metaFile = await regular(dir, "meta.json", open);
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
    } catch (error) {
      let code = error instanceof SyntaxError ? "meta_invalid" : issueCode(error, "meta");
      // A missing meta.json beside a quarantine marker is repair-run's terminal
      // disposition, not damage: report the disposition, not meta_missing. The
      // preserved meta bytes stay factual evidence of when the run began —
      // recover the original started_at (nothing else) from a copy that parses,
      // matches this run's id, and satisfies the protocol order.
      if (code === "meta_missing" && (await quarantineMarker(dir)) === true) {
        code = "meta_quarantined";
        const recovered = await quarantineStartEvidence(dir, id, open);
        if (recovered !== undefined) run.started_at = recovered;
      }
      problem("meta", code);
    }
    finally { await metaFile?.close(); }
    let log: RunFile | undefined;
    try {
      const output = await logDirectory(await realpath(this.root), id, dir);
      log = await regular(output, "log", open);
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
      await unchanged(output);
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

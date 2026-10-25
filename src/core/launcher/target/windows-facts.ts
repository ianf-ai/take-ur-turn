/** Streaming Windows facts; owns child lifetime, budgets and retained rows. */
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import path from "node:path";
import type { FactProbeChild, FactProbeExit, WindowsTargetDeps } from "./types.js";

/** The fact-probe child: stats every candidate in argv order and streams one
 * compact JSON row per newline-delimited line (`[index, resolvedPath, code,
 * …]`; codes: 0 ENOENT, 1 stat error, 2 exists-but-not-a-regular-file,
 * 3 regular file with extension, 4 regular extensionless file + two header
 * bytes + bytes actually read, 5 unresolvable, 6 header open/read failed),
 * flushed as soon as the candidate is probed — the parent consumes rows
 * incrementally, so a candidate's result is never hostage to later
 * candidates of the same batch .  Sync fs calls are
 * deliberate — the child carries no timers because a sync block (dead-UNC
 * SMB connect, writer-less FIFO open) freezes its own clock; termination is
 * entirely the parent's SIGKILL. */
const WINDOWS_FACT_PROBE_SCRIPT = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const emit = (row) => process.stdout.write(JSON.stringify(row) + '\\n');",
  "const args = process.argv.slice(1);",
  "for (let i = 0; i < args.length; i++) {",
  "  const raw = args[i];",
  "  let resolved;",
  "  try { resolved = path.win32.resolve(raw); } catch { emit([i, raw, 5]); continue; }",
  "  let st;",
  "  try { st = fs.statSync(resolved); }",
  "  catch (err) {",
  "    emit([i, resolved, err && err.code === 'ENOENT' ? 0 : 1, String((err && err.code) || (err && err.message) || err)]);",
  "    continue;",
  "  }",
  "  if (!st.isFile()) { emit([i, resolved, 2]); continue; }",
  "  if (path.win32.extname(resolved) !== '') { emit([i, resolved, 3]); continue; }",
  "  try {",
  "    const fd = fs.openSync(resolved, 'r');",
  "    try {",
  "      const b = Buffer.alloc(2);",
  "      const n = fs.readSync(fd, b, 0, 2, 0);",
  "      emit([i, resolved, 4, b[0], b[1], n]);",
  "    } finally { fs.closeSync(fd); }",
  "  } catch (err) { emit([i, resolved, 6, String((err && err.code) || (err && err.message) || err)]); }",
  "}",
].join("\n");

/** One candidate's fact as probed by the fact child. */
type WindowsCandidateFact =
  | { kind: "enoent" }
  | { kind: "error"; message: string }
  | { kind: "nonfile" }
  | { kind: "file"; header: Buffer | null; headerError: string | null };

/** The Windows resolver consumes only `isFile` from Stats (no exec-bit on
 * Windows), so fact-backed adapters serve a minimal Stats shape. */
function minimalStats(isFile: boolean): Stats {
  return { isFile: () => isFile } as unknown as Stats;
}

function enoentStatError(candidate: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, stat '${candidate}'`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

/** Production handle: one direct argv spawn (shell:false) of the fact
 * script, stdout split into complete lines as chunks arrive. */
export function spawnFactProbeDefault(argv: readonly string[]): FactProbeChild {
  let lineCallback: ((line: string) => void) | undefined;
  let endCallback: ((outcome: FactProbeExit) => void) | undefined;
  let ended = false;
  let buffer = "";
  const finish = (outcome: FactProbeExit): void => {
    if (ended) return;
    ended = true;
    endCallback?.(outcome);
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ["-e", WINDOWS_FACT_PROBE_SCRIPT, ...argv], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // spawn threw synchronously (engine unavailable, bad argv): report it
    // through the same terminal channel; the microtask lets the session
    // register its callbacks first.
    const failure = error as Error;
    queueMicrotask(() => finish({ kind: "error", error: failure }));
    return {
      kill() {},
      onLine(callback) {
        lineCallback = callback;
      },
      onEnd(callback) {
        endCallback = callback;
      },
    };
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) lineCallback?.(line);
    }
  });
  child.once("error", (error) => finish({ kind: "error", error }));
  child.once("close", (code) => finish({ kind: "exit", code }));
  return {
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone — the close event settles the outcome
      }
    },
    onLine(callback) {
      lineCallback = callback;
    },
    onEnd(callback) {
      endCallback = callback;
    },
  };
}

/** Maps one parsed fact row (`[index, resolved, code, …]`) to its fact. */
function factFromRow(row: [number, string, number, ...unknown[]]): WindowsCandidateFact | undefined {
  const [, resolved, code] = row;
  switch (code) {
    case 0: return { kind: "enoent" };
    case 1: return { kind: "error", message: typeof row[3] === "string" ? row[3] : "stat failed" };
    case 2: return { kind: "nonfile" };
    case 3: return { kind: "file", header: null, headerError: null };
    case 4: {
      const read = typeof row[5] === "number" ? row[5] : 0;
      const bytes: number[] = [];
      if (read > 0 && typeof row[3] === "number") bytes.push(row[3]);
      if (read > 1 && typeof row[4] === "number") bytes.push(row[4]);
      return { kind: "file", header: Buffer.from(bytes), headerError: null };
    }
    case 6: return { kind: "file", header: null, headerError: typeof row[3] === "string" ? row[3] : "header read failed" };
    default: return undefined; // 5 (unresolvable): the walk's own resolve rejects it first
  }
}

/** stat adapter serving the streaming fact session. */
export function statFromFacts(table: StreamingWindowsFactTable): NonNullable<WindowsTargetDeps["stat"]> {
  return async (candidate) => {
    const fact = await table.get(candidate);
    if (fact === undefined) throw new Error(`no fs probe fact for '${candidate}'`);
    switch (fact.kind) {
      case "enoent": throw enoentStatError(candidate);
      case "error": throw new Error(fact.message);
      case "nonfile": return minimalStats(false);
      case "file": return minimalStats(true);
    }
  };
}

/** readHeader adapter serving the streaming fact session. */
export function readHeaderFromFacts(table: StreamingWindowsFactTable): NonNullable<WindowsTargetDeps["readHeader"]> {
  return async (candidate, bytes) => {
    const fact = await table.get(candidate);
    if (fact?.kind !== "file") throw new Error(`no fs probe fact for '${candidate}'`);
    if (fact.headerError !== null) throw new Error(fact.headerError);
    if (fact.header === null) throw new Error(`no header bytes probed for '${candidate}'`);
    return fact.header.subarray(0, bytes);
  };
}

/** Chunk size for fact probes: one killable child per chunk keeps argv far
 * below the Windows 32K command-line ceiling and bounds one child's work,
 * while streaming rows + list-order lazy loading preserve the walk's early
 * exit (a definitive verdict in chunk 1 never probes chunk 2 — and kills
 * the still-scanning child mid-chunk). */
const FACT_PROBE_CHUNK_SIZE = 128;

/**
 * Facts for the whole candidate list, streamed from killable children —
 * the incremental, resumable isolation boundary the platform allows —
 * candidates never bleed into each other's fate.
 *
 * Rows are consumed as they arrive, so facts already received survive a
 * budget kill.  When the budget expires on a stalled child, the parent
 * SIGKILLs it, keeps the received rows, marks the candidate it stalled on
 * — plus the remainder of that candidate's directory (one dead share, one
 * fate: same-directory candidates would re-hang on the same connection,
 * burning one budget each for the same nothing) — as a bounded
 * unavailability, and resumes probing from the next directory.  dispose()
 * kills a still-scanning child the moment the walk has its definitive
 * verdict (native/node-entry/shim or terminal failure): candidates past
 * the verdict, dead UNC or not, are never probed at all.
 *
 * The budget is per child (matching TUT_PROBE_TIMEOUT_MS semantics for
 * where/which probes), clipped to the shared walk deadline. Dead directories
 * cannot accumulate unlimited budgets; every child is kernel-cleaned by
 * SIGKILL, never the main process's threadpool (Node fs has no
 * AbortSignal/cancellable stat; a pure Promise.race saves only the caller,
 * not the threadpool request).
 */
export class StreamingWindowsFactTable {
  private readonly facts = new Map<string, WindowsCandidateFact>();
  private readonly waiters = new Set<() => void>();
  private child?: FactProbeChild | undefined;
  private childTimer?: NodeJS.Timeout | undefined;
  private childBase = 0;
  private childArgv: readonly string[] = [];
  private childRows = 0;
  private nextStart = 0;
  private disposed = false;

  constructor(
    private readonly candidates: readonly string[],
    private readonly budgetMs: number,
    private readonly spawnChild: (argv: readonly string[]) => FactProbeChild,
    private readonly deadline: number,
  ) {}

  /** Facts for one (walk-resolved) candidate; starts or resumes a probing
   * child only for the chunks the walk actually reaches. */
  async get(candidate: string): Promise<WindowsCandidateFact | undefined> {
    for (;;) {
      const known = this.facts.get(candidate);
      if (known !== undefined) return known;
      if (this.child === undefined) {
        if (this.disposed || performance.now() >= this.deadline || this.nextStart >= this.candidates.length) return undefined;
        this.startChild();
      }
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
  }

  /** Stops a still-scanning child once the walk has its verdict. */
  dispose(): void {
    this.disposed = true;
    if (this.childTimer !== undefined) {
      clearTimeout(this.childTimer);
      this.childTimer = undefined;
    }
    const handle = this.child;
    if (handle !== undefined) {
      this.child = undefined;
      try {
        handle.kill();
      } catch {
        // already gone — nothing left to stop
      }
    }
    this.wake();
  }

  private startChild(): void {
    const base = this.nextStart;
    const argv = this.candidates.slice(base, base + FACT_PROBE_CHUNK_SIZE);
    const handle = this.spawnChild(argv);
    this.child = handle;
    this.childBase = base;
    this.childArgv = argv;
    this.childRows = 0;
    const startedAt = performance.now();
    const remainingMs = this.deadline - startedAt;
    const clippedByWalk = remainingMs < this.budgetMs;
    this.childTimer = setTimeout(() => this.expireChild(handle, startedAt, clippedByWalk),
      Math.ceil(Math.min(this.budgetMs, Math.max(1, remainingMs))));
    handle.onLine((line) => this.onRow(handle, line));
    handle.onEnd((outcome) => this.endChild(handle, outcome));
  }

  private onRow(handle: FactProbeChild, line: string): void {
    if (handle !== this.child) return; // stale: killed/expired/disposed child
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failChild(handle, "cannot be probed (unparseable candidate fs probe output)");
      return;
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== "number" || typeof parsed[1] !== "string" || typeof parsed[2] !== "number") {
      this.failChild(handle, "cannot be probed (malformed candidate fs probe output)");
      return;
    }
    const row = parsed as [number, string, number, ...unknown[]];
    this.childRows = Math.max(this.childRows, row[0] + 1);
    const fact = factFromRow(row);
    if (fact !== undefined) {
      this.facts.set(row[1], fact);
      this.wake();
    }
  }

  /** Budget expiry: the line stream stopped mid-candidate.  Keep every row
   * already received, mark the stalled candidate and its directory-mates as
   * bounded unavailability, and set the resume point past them. */
  private expireChild(handle: FactProbeChild, startedAt: number, clippedByWalk: boolean): void {
    if (handle !== this.child) return;
    this.childTimer = undefined;
    try {
      handle.kill();
    } catch {
      // already gone — nothing left to stop
    }
    const timeoutMessage = clippedByWalk
      ? `candidate fs probe reached walk deadline after waiting ${Math.round(performance.now() - startedAt)}ms`
      : `candidate fs probe timed out after ${this.budgetMs}ms`;
    const stalled = this.childBase + this.childRows;
    const end = this.childBase + this.childArgv.length;
    const stalledCandidate = stalled < end ? this.candidates[stalled] : undefined;
    if (stalledCandidate !== undefined) {
      this.markIndex(stalled, `${timeoutMessage} and was killed`);
      const stalledDir = path.win32.dirname(stalledCandidate);
      const skipMessage =
        `${timeoutMessage} (directory '${stalledDir}' unresponsive; ` +
        "same-directory candidates marked unavailable without further probes)";
      let next = stalled + 1;
      while (next < end) {
        const mate = this.candidates[next];
        if (mate === undefined || path.win32.dirname(mate) !== stalledDir) break;
        this.markIndex(next, skipMessage);
        next++;
      }
      this.nextStart = next;
    } else {
      this.nextStart = end;
    }
    this.retireChild(handle);
  }

  /** Natural exit (or spawn failure) of the live child. */
  private endChild(handle: FactProbeChild, outcome: FactProbeExit): void {
    if (handle !== this.child) return;
    const end = this.childBase + this.childArgv.length;
    this.nextStart = end;
    if (outcome.kind === "exit" && outcome.code === 0 && this.childRows >= this.childArgv.length) {
      this.retireChild(handle);
      return;
    }
    const message = outcome.kind === "error"
      ? `cannot be probed (candidate fs probe failed: ${outcome.error.message})`
      : outcome.code === 0
        ? `cannot be probed (candidate fs probe output incomplete: ${this.childRows}/${this.childArgv.length} rows)`
        : `cannot be probed (candidate fs probe exited ${outcome.code ?? "?"})`;
    for (let i = this.childBase + this.childRows; i < end; i++) {
      this.markIndex(i, message);
    }
    this.retireChild(handle);
  }

  /** Protocol failure: stop the child and mark its uncovered candidates. */
  private failChild(handle: FactProbeChild, message: string): void {
    if (handle !== this.child) return;
    try {
      handle.kill();
    } catch {
      // already gone — nothing left to stop
    }
    const end = this.childBase + this.childArgv.length;
    this.nextStart = end;
    for (let i = this.childBase + this.childRows; i < end; i++) {
      this.markIndex(i, message);
    }
    this.retireChild(handle);
  }

  /** Marks one candidate index as a bounded unavailability fact, keyed the
   * same way the child keys its rows (the walk resolves before asking). */
  private markIndex(index: number, message: string): void {
    const raw = this.candidates[index];
    if (raw === undefined) return;
    let resolved: string;
    try {
      resolved = path.win32.resolve(raw);
    } catch {
      return; // the walk rejects unresolvable candidates before any stat
    }
    this.facts.set(resolved, { kind: "error", message });
  }

  private retireChild(handle: FactProbeChild): void {
    if (handle !== this.child) return;
    if (this.childTimer !== undefined) {
      clearTimeout(this.childTimer);
      this.childTimer = undefined;
    }
    this.child = undefined;
    this.wake();
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
  }
}

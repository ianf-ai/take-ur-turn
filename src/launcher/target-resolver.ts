/**
 * Platform executable-target resolution (launcher port design §3).
 *
 * Windows uses a structured resolver over a self-enumerated candidate list:
 * PATH directories × PATHEXT extensions, generated inside Node as UTF-16
 * strings — no where.exe text output is decoded (CJK codepage usernames
 * cannot mojibake a path that never round-trips through a console codepage).
 * where.exe stays only as a fallback probe when PATH yields no directory.
 * The resolver returns a native executable or a direct Node entry, and
 * refuses shell/file-association shims (.cmd/.bat/.ps1/.sh and friends)
 * before any marker or Herdr mutation.  POSIX keeps the bare-name
 * direct-target contract: `which` is only a presence preflight — its output
 * path never enters an invocation, and PaneCommand/execvp keep the bare
 * route agent.  Both probe subprocesses (where.exe fallback, which) carry a
 * bounded timeout and are killed on expiry; the Windows filesystem facts
 * (candidate existence, extensionless PE header) stream out of killable
 * child processes under the same budget as newline-delimited JSON rows,
 * one row per candidate in argv order, consumed incrementally — a
 * candidate's result is never hostage to later candidates of its batch
 * (review v8 P1): on budget expiry the parent SIGKILLs the stalled child,
 * keeps every row already received, marks the candidate it stalled on plus
 * the remainder of that candidate's directory as a bounded unavailability,
 * and resumes probing from the next directory; when the walk reaches a
 * definitive native/node-entry/shim verdict it kills the still-scanning
 * child outright.  A dead UNC entry in PATH can neither stall the auto loop
 * for minutes, nor sink usable candidates that share its batch, nor hold
 * the main process's threadpool hostage.  Injected fs seams instead run
 * under a signal+race budget (withFsProbeBudget).
 *
 * This module also freezes the self-update suppression policy once per
 * plan so every launch door (start-next, Notifier auto, legacy compat)
 * expresses the same platform execution plan.
 */

import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { open as fsOpen, stat as fsStatPromises } from "node:fs/promises";
import path from "node:path";
import type {
  AgentCommand,
  AgentRoute,
  LaunchInvocation,
  PosixDirectPlan,
} from "../types.js";

/** A route target could not be resolved to an executable this launcher may run. */
export class AgentTargetError extends Error {
  /** The bare route agent whose target failed to resolve. */
  readonly agent: string;
  /** Machine-oriented reason (e.g. "no candidate", "not executable"). */
  readonly reason: string;
  /** Actionable fix advice for the human/agent reading the stderr line. */
  readonly hint: string;

  constructor(agent: string, reason: string, hint: string) {
    super(`agent '${agent}' ${reason} — ${hint}`);
    this.name = "AgentTargetError";
    this.agent = agent;
    this.reason = reason;
    this.hint = hint;
  }
}

/** Windows shim targets (.cmd/.bat/.ps1/.sh, file associations) are refused closed. */
export class UnsupportedWindowsShimError extends AgentTargetError {
  /** The shim path where.exe selected for the fail-closed refusal. */
  readonly shimPath: string;

  constructor(agent: string, shimPath: string, hint: string) {
    super(agent, `resolves to a Windows shim (${shimPath})`, hint);
    this.name = "UnsupportedWindowsShimError";
    this.shimPath = shimPath;
  }
}

/** Structured Windows target; never a shell command string. */
export interface ResolvedAgentTarget {
  kind: "native" | "node-entry";
  /** Absolute native path, or the Node executable for a direct entry. */
  executable: string;
  /** Ordered argv inserted before route args (the script path for node-entry). */
  prefix_args: string[];
  /** Absolute path of the file where.exe selected. */
  source_path: string;
}

export type EffectiveAgentPlan = NonNullable<LaunchInvocation["effective_agent"]>;

/** Unified platform execution plan carried by one frozen invocation. */
export type PlatformExecutionPlan =
  | { platform: "posix"; posix_direct: PosixDirectPlan }
  | { platform: "windows"; resolved_target: ResolvedAgentTarget; effective_agent: EffectiveAgentPlan };

const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1", ".sh"]);
const NODE_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_NATIVE_HINT =
  "install the native executable, or point the workspace/task cast at a direct Node entry route (node + script) with node.exe on PATH";
const POSIX_PRESENCE_HINT =
  "install it, or fix the task cast / workspace lineup";
const POSIX_WHICH_MISSING_HINT =
  "install which (e.g. `apt-get install which` / `apk add which`), or run TUT from an environment that provides it — the PATH presence preflight needs the which binary";

// ---------------------------------------------------------------------------
// Probe budget: subprocess probes are killed on expiry; filesystem
// probes are aborted and raced under the same budget.
// ---------------------------------------------------------------------------

/** A hung where.exe/which or a dead-UNC stat must return failure, not stall
 * the launch loop. */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
/** Total Windows PATH walk, including candidate discovery and all resumes. */
const DEFAULT_PROBE_WALK_TIMEOUT_MS = 24_000;

function probeWalkTimeoutMs(environment: NodeJS.ProcessEnv): number {
  const raw = environment.TUT_PROBE_WALK_TIMEOUT_MS;
  if (raw === undefined || !/^\d+$/u.test(raw)) return DEFAULT_PROBE_WALK_TIMEOUT_MS;
  return Math.min(Math.max(Number(raw), 250), 60_000);
}
const PROBE_TIMEOUT_MIN_MS = 250;
const PROBE_TIMEOUT_MAX_MS = 60_000;

/** Test/ops knob: bounded [250ms, 60s], garbage falls back to the default. */
function probeTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.TUT_PROBE_TIMEOUT_MS;
  if (raw === undefined || !/^\d+$/u.test(raw)) return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Math.min(Math.max(parsed, PROBE_TIMEOUT_MIN_MS), PROBE_TIMEOUT_MAX_MS);
}

/**
 * Run one filesystem probe under the shared probe budget.
 *
 * Termination is two-layered on purpose.  The AbortSignal goes into the
 * adapter FIRST: the default fs adapters reject on abort, so the threadpool
 * request's result is discarded — a terminable isolation boundary, not just
 * a race.  The race then guarantees the walk moves on within the budget even
 * when an injected adapter ignores the signal; its losing promise keeps only
 * the race's already-settled handlers (no unhandled rejection, no caller
 * wait), and with no real background operation behind a signal-ignoring
 * adapter there is nothing left uncontrolled.
 */
async function withFsProbeBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  budgetMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`filesystem probe timed out after ${budgetMs}ms and was aborted`));
        }, Math.ceil(budgetMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Injectable seams (fixtures inject candidate lists / which results)
// ---------------------------------------------------------------------------

export interface ProbeResult {
  code: number | null;
  stdout: string;
  error?: Error;
}

/** Default adapter: one direct argv spawn with shell:false and a bounded
 * probe budget — on expiry the child is SIGKILLed and the probe resolves as
 * a failure instead of hanging on a dead PATH entry (stale UNC, network
 * drive).  `options.timeoutMs` overrides the env knob for callers that
 * already resolved their budget from an injected environment. */
export function probeExecutable(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      resolve({ code: null, stdout, error: error as Error });
      return;
    }
    const timeoutMs = options.timeoutMs ?? probeTimeoutMs();
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone — the close event settles the promise
      }
      settled = true;
      resolve({ code: null, stdout, error: new Error(`probe timed out after ${timeoutMs}ms and was killed`) });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, error });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

export interface WindowsTargetDeps {
  /** Lists candidate paths in resolution order; defaults to the PATH+PATHEXT
   * self-enumeration with where.exe as the PATH-less fallback. */
  candidates?: (agent: string) => Promise<string[]>;
  /** Runs one fact-probe child over a chunk of candidates; defaults to a
   * direct node spawn of the built-in fact script.  Only the transport is
   * injected — streaming consumption, the budget kill, and the resume all
   * live in the resolver's session, so scripted runners (tests hanging a
   * child at a chosen candidate) exercise production behavior. */
  factProbe?: (argv: readonly string[]) => FactProbeChild;
  /** File facts for a candidate path.  The AbortSignal fires on budget
   * expiry — adapters that can honor it should reject on abort; every call
   * is additionally raced against the budget, so even a signal-ignoring
   * adapter returns control within the budget. */
  stat?: (candidate: string, signal?: AbortSignal) => Promise<Stats>;
  /** Reads leading file bytes for extensionless PE detection, under the
   * same budget + signal semantics as stat. */
  readHeader?: (candidate: string, bytes: number, signal?: AbortSignal) => Promise<Buffer>;
  /** Node executable for node-entry targets; defaults to process.execPath. */
  nodeExecutable?: string;
  /** Environment for PATH/PATHEXT enumeration; defaults to process.env. */
  environment?: NodeJS.ProcessEnv;
}

/**
 * Default header adapter: read only the leading bytes of the candidate via
 * the direct file API (open → positioned read → close).  The file is never
 * executed here and never read whole — two bytes are all PE detection needs.
 *
 * Termination note: Node's fsPromises APIs have no AbortSignal support for
 * open/stat, and the libuv threadpool is process-wide — an in-process fs
 * call that hangs on a dead UNC cannot be cancelled, only raced.  That is
 * why the production default (both stat and readHeader unset) does NOT use
 * this adapter directly: resolveWindowsExecutableTarget probes candidates
 * through killable streaming fact-probe children instead (see
 * StreamingWindowsFactTable).  This direct adapter only serves mixed
 * injection (tests overriding just one seam) under the race budget.
 */
async function readHeaderDefault(candidate: string, bytes: number): Promise<Buffer> {
  const handle = await fsOpen(candidate, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return bytesRead >= bytes ? buffer : buffer.subarray(0, Math.max(0, bytesRead));
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Windows candidate fact probe: streaming killable children
// ---------------------------------------------------------------------------

/** The fact-probe child: stats every candidate in argv order and streams one
 * compact JSON row per newline-delimited line (`[index, resolvedPath, code,
 * …]`; codes: 0 ENOENT, 1 stat error, 2 exists-but-not-a-regular-file,
 * 3 regular file with extension, 4 regular extensionless file + two header
 * bytes + bytes actually read, 5 unresolvable, 6 header open/read failed),
 * flushed as soon as the candidate is probed — the parent consumes rows
 * incrementally, so a candidate's result is never hostage to later
 * candidates of the same batch (review v8 P1).  Sync fs calls are
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

/** Terminal outcome of one fact-probe child, as the session observes it. */
export type FactProbeExit =
  | { kind: "exit"; code: number | null }
  | { kind: "error"; error: Error };

/** Transport handle for one fact-probe child.  Deliberately dumb — the
 * budget timer and the timeout bookkeeping live in the session, so the
 * handle only moves bytes and terminal events (tests script these to hang
 * a child at a chosen candidate). */
export interface FactProbeChild {
  /** Stops the child unconditionally (SIGKILL-equivalent); idempotent. */
  kill(): void;
  /** Delivers every complete stdout line, in emission order. */
  onLine(callback: (line: string) => void): void;
  /** Delivers the terminal outcome exactly once (natural exit or spawn
   * error); never fires after kill(). */
  onEnd(callback: (outcome: FactProbeExit) => void): void;
}

/** Production handle: one direct argv spawn (shell:false) of the fact
 * script, stdout split into complete lines as chunks arrive. */
function spawnFactProbeDefault(argv: readonly string[]): FactProbeChild {
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
function statFromFacts(table: StreamingWindowsFactTable): NonNullable<WindowsTargetDeps["stat"]> {
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
function readHeaderFromFacts(table: StreamingWindowsFactTable): NonNullable<WindowsTargetDeps["readHeader"]> {
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
class StreamingWindowsFactTable {
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
    this.childTimer = setTimeout(() => this.expireChild(handle), Math.ceil(Math.min(this.budgetMs, Math.max(1, this.deadline - performance.now()))));
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
  private expireChild(handle: FactProbeChild): void {
    if (handle !== this.child) return;
    this.childTimer = undefined;
    try {
      handle.kill();
    } catch {
      // already gone — nothing left to stop
    }
    const stalled = this.childBase + this.childRows;
    const end = this.childBase + this.childArgv.length;
    const stalledCandidate = stalled < end ? this.candidates[stalled] : undefined;
    if (stalledCandidate !== undefined) {
      this.markIndex(stalled, `candidate fs probe timed out after ${this.budgetMs}ms and was killed`);
      const stalledDir = path.win32.dirname(stalledCandidate);
      const skipMessage =
        `candidate fs probe timed out after ${this.budgetMs}ms (directory '${stalledDir}' unresponsive; ` +
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

export interface PosixTargetDeps {
  /** Runs `which <agent>`; defaults to a direct shell:false spawn under the
   * bounded probe timeout (a hung which is killed, not waited out). */
  which?: (agent: string) => Promise<ProbeResult>;
  /** File facts for the which candidate; defaults to fs.stat. */
  stat?: (candidate: string) => Promise<Stats>;
}

// ---------------------------------------------------------------------------
// Windows structured resolver (§3.1)
// ---------------------------------------------------------------------------

function whereLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("\u0000"));
}

/** The PATHEXT extension order; the Windows default mirrors where.exe. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

function pathextExtensions(environment: NodeJS.ProcessEnv): string[] {
  const raw = environment.PATHEXT ?? DEFAULT_PATHEXT;
  return raw.split(";").map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Strip padding/quote wrappers Windows PATH entries sometimes carry. */
function cleanPathEntry(raw: string): string {
  return raw.trim().replace(/^"+|"+$/gu, "");
}

/**
 * Generate the Windows candidate list from PATH × PATHEXT inside Node
 * (UTF-16 strings — no console codepage decode).  Per directory: PATHEXT
 * order first, then the extensionless name; directories in PATH order.
 * Pure path generation — existence is decided by the resolver's stat seam,
 * so tests inject without touching the filesystem.
 */
export function enumeratePathCandidates(agent: string, environment: NodeJS.ProcessEnv): string[] {
  const pathValue = environment.PATH ?? "";
  const extensions = pathextExtensions(environment);
  const candidates: string[] = [];
  for (const rawDir of pathValue.split(";")) {
    const dir = cleanPathEntry(rawDir);
    if (dir.length === 0) continue;
    // Lowercase the appended extension: PATHEXT spellings vary (.CMD/.Cmd),
    // and a deterministic case keeps cross-platform fixtures and shim
    // messages stable (Windows itself resolves extensions case-insensitively).
    for (const ext of extensions) candidates.push(path.win32.join(dir, `${agent}${ext.toLowerCase()}`));
    candidates.push(path.win32.join(dir, agent));
  }
  return candidates;
}

/**
 * The default candidate provider: PATH+PATHEXT self-enumeration, with
 * where.exe kept only as the fallback for a PATH-less environment (its
 * CreateProcess resolution still finds System32\where.exe with an empty
 * PATH, covering the one case self-enumeration cannot).
 */
async function defaultWindowsCandidates(agent: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<string[]> {
  const enumerated = enumeratePathCandidates(agent, environment);
  if (enumerated.length > 0) return enumerated;
  const probe = await probeExecutable("where.exe", [agent], { timeoutMs });
  if (probe.error !== undefined) {
    throw new AgentTargetError(
      agent,
      `cannot be resolved (where.exe fallback failed: ${probe.error.message})`,
      WINDOWS_NATIVE_HINT,
    );
  }
  const lines = whereLines(probe.stdout);
  if (probe.code !== 0 || lines.length === 0) {
    throw new AgentTargetError(
      agent,
      `not found via the where.exe fallback (exit ${probe.code ?? "?"})`,
      WINDOWS_NATIVE_HINT,
    );
  }
  return lines;
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRegularFile(entry: Stats): boolean {
  return entry.isFile();
}

/**
 * Resolve one route agent against the candidate list, in list order.
 *
 * Existence comes first: the self-enumerated list carries every generated
 * path, so classification (shim/native/node-entry) applies only to a
 * candidate that actually exists — a missing agent stays "not found"
 * instead of tripping a shim refusal on a path that is not there.  A
 * native executable or direct Node entry is a trustworthy result and
 * stops the walk; unsupported shims are a fail-closed refusal when
 * reached — never executed, never silently translated.
 */
export async function resolveWindowsExecutableTarget(
  routeAgent: string,
  deps: WindowsTargetDeps = {},
): Promise<ResolvedAgentTarget> {
  const environment = deps.environment ?? process.env;
  const fsProbeBudgetMs = probeTimeoutMs(environment);
  const walkBudgetMs = probeWalkTimeoutMs(environment);
  const deadline = performance.now() + walkBudgetMs;
  const remaining = (): number => {
    const ms = deadline - performance.now();
    if (ms <= 0) throw new AgentTargetError(routeAgent,
      `PATH walk timed out after ${walkBudgetMs}ms`, WINDOWS_NATIVE_HINT);
    return Math.min(fsProbeBudgetMs, ms);
  };
  const nodeExecutable = deps.nodeExecutable ?? process.execPath;
  const listCandidates = deps.candidates ?? ((agent: string) => defaultWindowsCandidates(agent, environment, remaining()));

  let candidates: string[];
  try {
    candidates = await withFsProbeBudget(() => listCandidates(routeAgent), remaining());
  } catch (error) {
    throw new AgentTargetError(routeAgent, `candidate discovery failed: ${(error as Error).message}`, WINDOWS_NATIVE_HINT);
  }
  remaining();

  // Production default (neither stat nor readHeader injected): serve every
  // candidate's facts from a streaming session backed by killable children
  // — a hung statSync/openSync inside one (dead-UNC SMB connect) cannot
  // cancel itself, but the parent SIGKILLs the stalled child, keeps the
  // rows it already streamed, marks the stalled candidate's directory as a
  // bounded unavailability, and resumes past it, so the main process's
  // threadpool is never held hostage and usable candidates sharing the
  // batch are never sunk (review v8 P1).  Injected seams (tests)
  // instead run per-candidate adapters under the signal+race budget of
  // withFsProbeBudget.
  const factTable = deps.stat === undefined && deps.readHeader === undefined && candidates.length > 0
    ? new StreamingWindowsFactTable(candidates, fsProbeBudgetMs, deps.factProbe ?? spawnFactProbeDefault, deadline)
    : undefined;
  const stat = deps.stat ?? (factTable !== undefined
    ? statFromFacts(factTable)
    : (candidate: string) => fsStatPromises(candidate));
  const readHeader = deps.readHeader ?? (factTable !== undefined ? readHeaderFromFacts(factTable) : readHeaderDefault);

  const rejected: string[] = [];
  let sawEvidence = false; // some candidate existed (or errored beyond ENOENT)
  try {
    for (const raw of candidates) {
      remaining();
      let candidate: string;
      try {
        candidate = path.win32.resolve(raw);
      } catch {
        rejected.push(`'${raw}': has an unsafely normalizable target`);
        continue;
      }

      let entry: Stats;
      try {
        // Bounded: a dead-UNC candidate stat cannot stall the walk.
        entry = await withFsProbeBudget((signal) => stat(candidate, signal), remaining());
      } catch (error) {
        if (isENOENT(error)) {
          // The candidate never existed — not an untrusted result, and not a
          // reason to mention it in the final error.
          continue;
        }
        sawEvidence = true;
        rejected.push(
          `resolves to an unavailable target ('${candidate}': ${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      remaining();
      sawEvidence = true;
      if (!isRegularFile(entry)) {
        rejected.push(`resolves to a non-file target ('${candidate}')`);
        continue;
      }

      const extension = path.win32.extname(candidate).toLowerCase();
      if (WINDOWS_SHIM_EXTENSIONS.has(extension)) {
        throw new UnsupportedWindowsShimError(
          routeAgent,
          candidate,
          `TUT does not execute ${extension} shims; ${WINDOWS_NATIVE_HINT}`,
        );
      }
      if (NATIVE_EXTENSIONS.has(extension)) {
        return { kind: "native", executable: candidate, prefix_args: [], source_path: candidate };
      }

      if (NODE_ENTRY_EXTENSIONS.has(extension)) {
        // A direct Node entry: Node runs the script itself; no file association,
        // no shebang reliance, no shell.
        return {
          kind: "node-entry",
          executable: nodeExecutable,
          prefix_args: [candidate],
          source_path: candidate,
        };
      }

      if (extension.length === 0) {
        // Extensionless targets are accepted only with a PE (MZ) header.  A
        // non-PE extensionless result is the common POSIX-shim shape on
        // Windows: skip it and let the next where.exe candidate decide.  The
        // default header adapter reads the real leading bytes; a read failure
        // is likewise an untrusted candidate rather than a reason to abandon
        // later candidates.
        let header: Buffer;
        try {
          header = await withFsProbeBudget((signal) => readHeader(candidate, 2, signal), remaining());
        } catch (error) {
          rejected.push(
            `header read failed for '${candidate}' (${error instanceof Error ? error.message : String(error)})`,
          );
          continue;
        }
        remaining();
        if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
          return { kind: "native", executable: candidate, prefix_args: [], source_path: candidate };
        }
        rejected.push(`resolves to an extensionless non-executable target ('${candidate}': no PE header)`);
        continue;
      }

      // Any other extension (.py, .pl, …) reaches Windows only through shell
      // file associations — same refusal class as npm command shims.
      throw new UnsupportedWindowsShimError(
        routeAgent,
        candidate,
        `files of type '${extension}' need a shell/file association to run; ${WINDOWS_NATIVE_HINT}`,
      );
    }

    remaining();
    if (!sawEvidence) {
      throw new AgentTargetError(
        routeAgent,
        `not found on PATH (no existing PATH+PATHEXT candidate for '${routeAgent}')`,
        WINDOWS_NATIVE_HINT,
      );
    }
    throw new AgentTargetError(
      routeAgent,
      `all candidates are untrusted: ${rejected.join("; ")}`,
      WINDOWS_NATIVE_HINT,
    );
  } finally {
    // The walk's verdict is definitive (native/node-entry/shim, or a
    // terminal failure): a still-scanning fact child stops here —
    // candidates past the verdict, dead UNC or not, are never probed
    // (review v8 P1: stop on definitive results).
    factTable?.dispose();
  }
}

// ---------------------------------------------------------------------------
// POSIX which presence preflight (§3.2)
// ---------------------------------------------------------------------------

/**
 * Prove the bare route agent exists on PATH.  The which output path is used
 * only for this validation — it never replaces the bare executable in an
 * invocation or PaneCommand.
 */
export async function resolvePosixTargetPresence(
  routeAgent: string,
  deps: PosixTargetDeps = {},
): Promise<{ agent: string; candidate: string }> {
  const which = deps.which ?? ((agent: string) => probeExecutable("which", [agent]));
  const stat = deps.stat ?? ((candidate: string) => fsStatPromises(candidate));

  const probe = await which(routeAgent);
  if (probe.error !== undefined) {
    if ((probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      // The which BINARY itself is missing (minimal containers), which says
      // nothing about the agent — a dedicated hint, never "install the agent".
      throw new AgentTargetError(
        routeAgent,
        "cannot be probed (which is not installed on this system)",
        POSIX_WHICH_MISSING_HINT,
      );
    }
    throw new AgentTargetError(
      routeAgent,
      `cannot be probed (which failed: ${probe.error.message})`,
      POSIX_PRESENCE_HINT,
    );
  }
  const candidate = probe.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0);
  if (probe.code !== 0 || candidate === undefined) {
    throw new AgentTargetError(
      routeAgent,
      `not on PATH (which exit ${probe.code ?? "?"}, no candidate)`,
      POSIX_PRESENCE_HINT,
    );
  }

  let entry: Stats;
  try {
    entry = await stat(candidate);
  } catch (error) {
    throw new AgentTargetError(
      routeAgent,
      `has an unusable which candidate ('${candidate}': ${(error as Error).message})`,
      POSIX_PRESENCE_HINT,
    );
  }
  if (!entry.isFile()) {
    throw new AgentTargetError(
      routeAgent,
      `has a which candidate that is not a regular file ('${candidate}')`,
      POSIX_PRESENCE_HINT,
    );
  }
  if ((entry.mode & 0o111) === 0) {
    throw new AgentTargetError(
      routeAgent,
      `has a which candidate that is not executable ('${candidate}')`,
      POSIX_PRESENCE_HINT,
    );
  }
  return { agent: routeAgent, candidate };
}

// ---------------------------------------------------------------------------
// Self-update suppression policy + platform plan builders (§5)
// ---------------------------------------------------------------------------

/** Normalize any AgentRoute form into the ordered { agent, args } command. */
export function normalizeRouteCommand(route: AgentRoute): AgentCommand {
  if (typeof route === "string") return { agent: route, args: [] };
  return { agent: route.agent, args: [...route.args] };
}

export interface SelfUpdatePolicy {
  args: string[];
  env: Record<string, string>;
}

/**
 * Freeze the agent self-update suppression policy once, keyed by the bare
 * route agent's logical name — never by a wrapped command or resolved path.
 */
export function selfUpdatePolicyFor(
  routeAgent: string,
  routeArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
): SelfUpdatePolicy {
  const suppress = environment.TUT_SUPPRESS_AGENT_UPDATE !== "0";
  if (!suppress) return { args: [...routeArgs], env: {} };
  if (routeAgent === "codex") {
    return { args: [...routeArgs, "-c", "check_for_update_on_startup=false"], env: {} };
  }
  if (routeAgent === "pi") {
    return { args: [...routeArgs], env: { PI_SKIP_VERSION_CHECK: "1" } };
  }
  return { args: [...routeArgs], env: {} };
}

/** Pure POSIX plan: the bare route agent plus the frozen policy. */
export function posixDirectPlanFor(
  route: AgentCommand,
  environment: NodeJS.ProcessEnv,
): PosixDirectPlan {
  const policy = selfUpdatePolicyFor(route.agent, route.args, environment);
  return { executable: route.agent, args: policy.args, env: policy.env };
}

/** Windows effective plan: resolved target prefix plus the frozen policy. */
function windowsEffectivePlanFor(
  target: ResolvedAgentTarget,
  route: AgentCommand,
  environment: NodeJS.ProcessEnv,
): EffectiveAgentPlan {
  const policy = selfUpdatePolicyFor(route.agent, route.args, environment);
  return {
    executable: target.executable,
    args: [...target.prefix_args, ...policy.args],
    env: policy.env,
  };
}

export interface PlatformPlanOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  windowsDeps?: WindowsTargetDeps;
}

/**
 * Build the platform plan without a POSIX presence preflight.
 *
 * POSIX stays pure (the bare-name plan carries nothing from which); Windows
 * resolves its structured target, which may throw before any mutation.
 */
export async function planForPlatform(
  route: AgentCommand,
  options: PlatformPlanOptions = {},
): Promise<PlatformExecutionPlan> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const target = await resolveWindowsExecutableTarget(route.agent, { ...options.windowsDeps, environment });
    return {
      platform: "windows",
      resolved_target: target,
      effective_agent: windowsEffectivePlanFor(target, route, environment),
    };
  }
  return { platform: "posix", posix_direct: posixDirectPlanFor(route, environment) };
}

export interface ResolvePlatformExecutionPlanOptions extends PlatformPlanOptions {
  posixDeps?: PosixTargetDeps;
}

/**
 * The door-facing resolution used by canonical planners (start-next and
 * Notifier auto) before the marker: prove the target first, then produce the
 * frozen plan.  Any target failure throws before marker or Herdr mutation.
 */
export async function resolvePlatformExecutionPlan(
  route: AgentCommand,
  options: ResolvePlatformExecutionPlanOptions = {},
): Promise<PlatformExecutionPlan> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    await resolvePosixTargetPresence(route.agent, options.posixDeps);
  }
  return await planForPlatform(route, options);
}

/** Spread helper: map one platform plan onto buildLaunchInvocation options. */
export function platformPlanFields(
  plan: PlatformExecutionPlan,
): Pick<LaunchInvocation, "posix_direct"> | Pick<LaunchInvocation, "resolved_target" | "effective_agent"> {
  return plan.platform === "posix"
    ? { posix_direct: plan.posix_direct }
    : { resolved_target: plan.resolved_target, effective_agent: plan.effective_agent };
}

/** Bounded subprocess and filesystem probes shared by target resolvers. */
import { spawn } from "node:child_process";
import { open as fsOpen } from "node:fs/promises";
import type { ProbeResult } from "./types.js";

/** A hung where.exe/which or a dead-UNC stat must return failure, not stall
 * the launch loop. */
const DEFAULT_PROBE_TIMEOUT_MS = 8000;

/** Total Windows PATH walk, including candidate discovery and all resumes. */
const DEFAULT_PROBE_WALK_TIMEOUT_MS = 24_000;

const PROBE_TIMEOUT_MIN_MS = 250;

const PROBE_TIMEOUT_MAX_MS = 60_000;

/** Total Windows PATH walk budget: bounded by the same
 * [PROBE_TIMEOUT_MIN_MS, PROBE_TIMEOUT_MAX_MS] window as TUT_PROBE_TIMEOUT_MS,
 * garbage falls back to the default. */
export function probeWalkTimeoutMs(environment: NodeJS.ProcessEnv): number {
  const raw = environment.TUT_PROBE_WALK_TIMEOUT_MS;
  if (raw === undefined || !/^\d+$/u.test(raw)) return DEFAULT_PROBE_WALK_TIMEOUT_MS;
  return Math.min(Math.max(Number(raw), PROBE_TIMEOUT_MIN_MS), PROBE_TIMEOUT_MAX_MS);
}

/** Test/ops knob: bounded [250ms, 60s], garbage falls back to the default. */
export function probeTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
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
export async function withFsProbeBudget<T>(
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
export async function readHeaderDefault(candidate: string, bytes: number): Promise<Buffer> {
  const handle = await fsOpen(candidate, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return bytesRead >= bytes ? buffer : buffer.subarray(0, Math.max(0, bytesRead));
  } finally {
    await handle.close();
  }
}

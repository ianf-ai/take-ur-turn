import { formatAgentRoute } from "../common/agent-command.js";
import { HubError } from "../hub/hub-client.js";
import type { Cast } from "../common/types.js";

/** Human rendering of a cast: "executor=pi, reviewer=codex" (insertion order). */
function formatCast(cast: Cast): string {
  return Object.entries(cast)
    .map(([role, route]) => `${role}=${formatAgentRoute(route)}`)
    .join(", ");
}

// --- single-source defaults ------------------------------------------------------
// Every parser default, handler fallback, rendered service command, and help
// text in this file derives from these three constants — re-forking a literal
// copy elsewhere re-introduces the drift this block removed (pinned by test:
// the quoted hub-url literal appears exactly once in this source).

/** Hub BASE url for every CLI default (`--url` absent everywhere). */
export const DEFAULT_HUB_URL = "http://127.0.0.1:3001";

/** The port `tut serve` binds by default — the port a --url-less call speaks to. */
const DEFAULT_HUB_PORT = 3001;

/**
 * Default notifier event-listener port. Single source for notify's `--event-port`
 * default and up's probe/provisioning target (render and probe must be
 * the same port).
 */
export const DEFAULT_EVENT_PORT = 3002;

// --- bounded CLI-side fetch (CLI half) -------------------------------------------

/**
 * Every CLI-side HTTP call waits at most this long: a half-open connection
 * fails in 10s with a diagnosable error instead of hanging for the fetch
 * default (~5 minutes). hub-client's MCP transport is the other half of the split.
 */
export const CLI_FETCH_TIMEOUT_MS = 10_000;

/** Shared fetch init for CLI-side calls: bounded abort deadline, socket closed after use. */
function cliFetchInit(extra: RequestInit = {}): RequestInit {
  return { ...extra, signal: AbortSignal.timeout(CLI_FETCH_TIMEOUT_MS) };
}

// --- handlers -----------------------------------------------------------------
// All twenty-one subcommands are wired (notify; mode/config/start-next/watch;
// doctor is the report-only self-check over src/doctor.ts; repair-meta /
// recover-record are the storage-repair clients of the 4.3 endpoints;
// ack reuses the context publish path as a fixed human ack note; status is a
// human overview over the context list path). Task creation is the
// initiating side's action (tut create); the first round is an ordinary
// round hand-off, so no kickoff-specific handler exists.
// Each handler receives the parsed command object and returns a process exit code.

type Handler<T> = (parsed: T) => Promise<number>;

// --- context/approval command handlers -------------------------------------------

/**
 * Uniform failure exit: HubError prints "CODE: message" so the first stderr
 * line is the machine-parseable code (the same discipline as the MCP tool
 * surface); a network-level failure with a known Hub url prints the unified
 * HUB_UNREACHABLE diagnosis; anything else (unreadable --payload-file,
 * ...) prints a plain one-liner. Always exit code 1.
 */
function failWith(e: unknown, url?: string): number {
  if (e instanceof HubError) {
    process.stderr.write(`${e.code}: ${e.message}\n`);
  } else if (url !== undefined && isHubUnreachable(e)) {
    process.stderr.write(hubUnreachableLine(url, e));
  } else {
    process.stderr.write(`tut: ${(e as Error).message}\n`);
  }
  return 1;
}

/**
 * Network-level failure classes that mean "the Hub did not answer": undici's
 * TypeError "fetch failed" (with the errno on .cause), plain connection-refused
 * messages from test/seam stubs, and aborted/timed-out requests (the CLI-side
 * 10s deadline). HTTP-level failures (5xx, wrong shape) are NOT this —
 * the hub answered, it is just unhealthy.
 */
function isHubUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  if (e.message.includes("fetch failed")) return true;
  if (/econnrefused|connection refused|econnreset|ehostunreach|enetunreach|enotfound|eai_again/iu.test(e.message)) return true;
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code !== undefined || cause.message.includes("fetch failed");
  }
  return false;
}

/** The one hub-unreachable flavor: code-first line + the tut serve remedy. */
function hubUnreachableLine(url: string, e: unknown): string {
  const cause = (e as { cause?: { code?: string } })?.cause;
  const detail = cause?.code ?? (e instanceof Error ? e.message : String(e));
  return `HUB_UNREACHABLE: cannot reach the Hub at ${url} (${detail}) — start it with: tut serve\n`;
}

/** /state fetch failure for start-next/watch: unified flavor when unreachable, command context otherwise. */
function stateFetchErrorLine(url: string, e: unknown): string {
  return isHubUnreachable(e)
    ? hubUnreachableLine(url, e)
    : `tut: cannot read state from ${url}: ${(e as Error).message}\n`;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Production floor for --interval (notify/watch): a 0s interval
 * self-excites against the hub (hundreds of full /state derivations per
 * second). TUT_TEST_INTERVAL_FLOOR_SEC is the dedicated TEST knob — unset in
 * production, it never changes the default floor; tests that need a tight
 * poll loop set it to 0 instead of loosening the production path.
 */
const MIN_POLL_INTERVAL_SEC = 1;

function pollIntervalFloorSec(): number {
  const raw = process.env.TUT_TEST_INTERVAL_FLOOR_SEC;
  return raw !== undefined && /^\d+$/u.test(raw) ? Number.parseInt(raw, 10) : MIN_POLL_INTERVAL_SEC;
}

/** Clamp to the floor with a visible note; explicit larger values pass through unchanged. */
function clampPollInterval(command: "notify" | "watch", seconds: number): number {
  const floor = pollIntervalFloorSec();
  if (seconds < floor) {
    process.stderr.write(`tut: ${command}: --interval ${seconds} is below the ${floor}s floor — clamped to ${floor}s\n`);
    return floor;
  }
  return seconds;
}

/** Column width of cell i across all rows (noUncheckedIndexedAccess-safe). */
function colWidth(header: string, rows: string[][], i: number): number {
  return Math.max(header.length, ...rows.map((r) => (r[i] ?? "").length));
}

/** Row of cells padded to the given widths, two-space gutters. */
function padRow(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
}

/** Anomaly marker for the status table — plain ASCII, no color dependence. */
const ATTENTION_MARKER = "!!";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { cliFetchInit, isHubUnreachable, hubUnreachableLine, printJson, sleepMs, DEFAULT_HUB_PORT, clampPollInterval, type Handler, ATTENTION_MARKER, colWidth, padRow, failWith, stateFetchErrorLine, formatCast };

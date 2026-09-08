/**
 * Readiness-gated prompt delivery and its decoupled diagnostics observer.
 *
 * Port of the legacy launch.sh delivery section (7.2.1 closed loop) and its known delivery-robustness lessons
 * historical baggage included: every degradation keeps going (only a send-text
 * failure is fatal), the text is never re-sent, Enter resends run on the
 * clock inside ONE shared monotonic budget (the initial observation window
 * and every resend spend the same deadline — no window is ever re-armed),
 * and budget exhaustion still reports success so the caller cannot
 * re-deliver a duplicated prompt.  Every phase window — the born gate, the
 * land confirmation, the submit budget — is a CLOCK deadline: asynchronous
 * control-call latency (herdr spawn delay) spends the same nominal window,
 * so a slow machine stretches nothing.  The born gate demands QUIESCENCE (N
 * consecutive identical samples — banner TUIs repaint in pauses), landing
 * demands a NEW INSTANCE of a fragment of the SENT TEXT in the composer's
 * bottom region that ENDS the screen's final rows, every prompt is delivered
 * with a per-delivery NONCE suffix (deliveryText) so the landing evidence is
 * causally attributable to THIS send-text, and
 * a textless snapshot confirms nothing — an UNSEEN text means NO Enter at
 * all: observe-only polling for a late landing (a born pane's wait may SLIDE
 * its deadline while the screen keeps changing — parallel cold starts have
 * measured echoes past the base window — capped at a fixed multiple), then
 * give-up with escalation if the text never appears.  The submit phase
 * anchors its side-effect budget at the moment the text is first observed
 * (nothing was sent during the wait, so a late landing inherits a full
 * window); confirmation is transport=true AND box=cleared AND the cleared
 * state SURVIVES one re-verification read a poll later (a startup repaint
 * that fools one read cannot fool two — the false-confirm shape where a
 * redraw above the composer flipped the bottom region while the text never
 * left the box).  Box evidence derives from the SAME bottom-suffix rule as
 * landing: the text is HELD while a sent fragment still ENDS the final rows
 * — a repaint that changes the bottom region but leaves the text at the
 * bottom edge is held, not cleared.  Enter resends skip the cleared state
 * (the text left the box; a resend could hit an already-started round) and
 * stop early when a held screen stays byte-identical for a bounded poll
 * streak (a receiver that never repaints once is frozen for Enter
 * purposes).  Human-facing wording follows the last evidence (transport /
 * box / probe): only box=held may claim the prompt is still sitting in the
 * composer.  The diagnostics are a pure observer — one `tut-delivery
 * t=<epoch-ms> …` line per delivery step to stderr and, best-effort, to
 * `<root>/.context-hub/delivery.log` (size-rotated, one generation kept);
 * the switch silences both sinks and no branch ever reads them back.
 *
 * This module never resolves routes or naming: it consumes the prompt frozen
 * in a LaunchInvocation.  All pane reads use the visible source (the `recent`
 * snapshots proved unreliable on freshly born panes); all control-plane calls
 * stay behind the caller's raw-argv client seam.
 */

import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { psq, type ShellDialect } from "./shell-renderer.js";
import type { GiveUpEvidence, GiveUpProbeEvidence } from "./escalation.js";
import { giveUpGuidance } from "./escalation.js";

// ---- shared helpers ---------------------------------------------------------

function envInt(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined || !/^\d+$/u.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Bottom region of a screen: its last `count` non-empty lines, trailing
 * whitespace trimmed, newline-joined — where the receiver's composer and its
 * chrome live.  This is the submit criterion's whole field of view,
 * live-calibrated on both TUIs.
 */
export function screenBottom(screen: string, count = 3): string {
  const lines = screen
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+$/u, ""))
    .filter((line) => line.length > 0);
  return lines.slice(-count).join("\n");
}

// ---- landing: the text-match criterion ---------------------------------------

/** Bounded slice length for a landing fragment: short enough to survive a
 *  narrow composer row and middle-elision, long enough to be selective.
 *  Matching itself is whitespace-insensitive, so wrapping CANNOT split a
 *  match — the cap only bounds the evidence. */
export const LANDING_FRAGMENT_MAX = 24;

/** Strip ALL whitespace: the composer wraps at arbitrary columns and
 *  indents, so containment is purely about the character sequence. */
const normalizeForLanding = (text: string): string => text.replace(/\s+/gu, "");

/** Reliable slice of one prompt line: `head` keeps the first `max` chars,
 *  `tail` the last — the tail of the last line is what stays visible when a
 *  tall composer scrolls (the cursor lives there), the head of the first
 *  line is what stays visible when it pins to the top. */
export function landingFragment(line: string, side: "head" | "tail", max = LANDING_FRAGMENT_MAX): string {
  const trimmed = line.trim();
  if (trimmed.length <= max) return trimmed;
  return side === "head" ? trimmed.slice(0, max) : trimmed.slice(-max);
}

/** Fragments of the SENT text used for landing containment matching: the
 *  head of the first non-empty line and the tail of the last one (a
 *  one-line prompt yields both ends of that line).  An empty/whitespace
 *  prompt yields no fragments — landing can then never be confirmed and
 *  the delivery degrades honestly (documented in 7.2.1 step 3). */
export function promptLandingFragments(prompt: string, max = LANDING_FRAGMENT_MAX): string[] {
  const lines = prompt.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const head = landingFragment(lines[0] ?? "", "head", max);
  const tail = landingFragment(lines[lines.length - 1] ?? "", "tail", max);
  return head === tail ? [head] : [head, tail];
}

/** Non-overlapping occurrence count of `needle` in `haystack` (both
 *  pre-normalized). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** Bounded, quote-free fragment text for the diag `frag=` field. */
const fragLabel = (fragment: string): string => fragment.slice(0, LANDING_FRAGMENT_MAX).replaceAll("'", "");

/** The final-rows suffix test shared by landing attribution and box-held
 *  evidence: does any fragment END the last non-empty row, or the join of
 *  the last two (healing a wrap straddling that pair)? */
function endsFinalRows(rows: readonly string[], fragments: readonly string[]): boolean {
  const last1 = normalizeForLanding(rows[rows.length - 1] ?? "");
  const last2 = normalizeForLanding(`${rows[rows.length - 2] ?? ""}${rows[rows.length - 1] ?? ""}`);
  return fragments.some((fragment) => {
    const f = normalizeForLanding(fragment);
    if (f.length === 0) return false;
    return (last1.length > 0 && last1.endsWith(f)) || (last2.length > 0 && last2.endsWith(f));
  });
}

function nonEmptyRows(screen: string): string[] {
  return screen
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+$/u, ""))
    .filter((line) => line.length > 0);
}

/** Landing attribution, bound to the COMPOSER by two conditions that must
 *  BOTH hold (immediate loop and late-landing wait share this one rule):
 *
 *  1. NEW INSTANCE: the fragment's occurrence count in the bottom region
 *     (last 3 non-empty lines, the submit criterion's own calibration)
 *     increased over the baseline's same region — old instances rendering
 *     unchanged prove nothing (spinner repaints keep the count flat).
 *  2. BOTTOM SUFFIX: the text the user typed renders at the screen's
 *     bottom EDGE (every supported TUI anchors the input there), so the
 *     fragment must END the last non-empty row — or the join of the last
 *     two, which heals a wrap straddling that pair.  A transcript row
 *     always has UI rows below it (composer, hints, chrome), so the join
 *     of the final rows ends with THOSE rows and can never produce this
 *     suffix: re-revealed old history (a modal hiding and resurfacing a
 *     transcript echo, however few UI rows follow it) is excluded.  When
 *     the geometry cannot be told apart from an occupied composer, the
 *     rule still refuses to fire — staying unlanded is the honest
 *     failure (an unlanded prompt is visible in the input box; a blind
 *     Enter onto a modal is not recoverable). */
export function newLandingInstance(latest: string, baseline: string, fragments: readonly string[]): number {
  if (fragments.length === 0 || latest.length === 0) return -1;
  const latestBottom = normalizeForLanding(screenBottom(latest, 3));
  if (latestBottom.length === 0) return -1;
  const baselineBottom = normalizeForLanding(screenBottom(baseline, 3));
  return fragments.findIndex((fragment) => {
    const f = normalizeForLanding(fragment);
    if (f.length === 0) return false;
    if (countOccurrences(latestBottom, f) <= countOccurrences(baselineBottom, f)) return false;
    return endsFinalRows(nonEmptyRows(latest), [fragment]);
  });
}

/** Evidence state of the receiver's input box, derived from the visible
 *  screen: `held` — a fragment of the SENT text still ENDS the screen's
 *  final rows (the same bottom-suffix rule that proved the landing; a
 *  repaint that changes the bottom region while the text stays at the
 *  bottom edge is still holding the text — the false-cleared shape caught
 *  live when a startup banner redraw flipped the region within 547ms of
 *  the Enter); `cleared` — a non-empty screen whose final rows no longer
 *  end with any sent fragment; `unknown` — the read was empty (a glitch):
 *  the box state is simply not observable. */
export type BoxState = "held" | "cleared" | "unknown";

/** The held-box predicate (see `BoxState`).  An empty screen never holds
 *  anything — emptiness is `unknown` at the call-site, never evidence. */
export function boxHoldsText(screen: string, fragments: readonly string[]): boolean {
  if (screen.length === 0) return false;
  const rows = nonEmptyRows(screen);
  if (rows.length === 0) return false;
  return endsFinalRows(rows, fragments);
}

/** Derive the three-state box evidence from one (probe-stripped) screen. */
export function boxEvidenceOf(screen: string, fragments: readonly string[]): BoxState {
  if (screen.length === 0) return "unknown";
  return boxHoldsText(screen, fragments) ? "held" : "cleared";
}

/**
 * Bounded tail for diag lines: last non-empty line, trailing whitespace
 * trimmed, capped at 40 chars, single quotes stripped — rides inside the
 * quoted tail='…' field (bounded, safe to log).
 */
export function diagTail(screen: string): string {
  const lines = nonEmptyRows(screen);
  const last = lines[lines.length - 1] ?? "";
  return last.slice(0, 40).replaceAll("'", "");
}

/** The per-delivery attribution suffix appended to every delivered prompt:
 *  the nonce makes THIS delivery's tail fragment unique, so a previous
 *  round's identical prompt (sitting in the composer or echoed in the
 *  transcript) can never satisfy the landing attribution — including the
 *  zero-UI-row modal-reveal geometry where a bare transcript line is
 *  byte-identical to an occupied composer row.  Same-line append: a
 *  newline in send-text would submit the composer. */
export function deliveryNonceSuffix(nonce: string): string {
  return ` （tut delivery ${nonce}）`;
}

/** The full text a delivery writes to the pane: the prompt plus its
 *  per-delivery nonce suffix (see above). */
export function deliveryText(prompt: string, nonce: string): string {
  return `${prompt}${deliveryNonceSuffix(nonce)}`;
}

/** Stable prefix for shell-level Enter delivery probes. */
export const DELIVERY_PROBE_PREFIX = "TUT-DELIVERY-PROBE-";

/**
 * Make a probe marker which is very unlikely to occur in the user's prompt.
 * Four random bytes keep the marker compact while giving the marker its
 * required eight-character random suffix.
 */
export function deliveryProbeMarker(avoid = ""): string {
  let marker: string;
  do {
    marker = `${DELIVERY_PROBE_PREFIX}${randomBytes(4).toString("hex").toUpperCase()}`;
  } while (avoid.includes(marker));
  return marker;
}

/**
 * The dialect-specific command executed by the birth-time relay.  POSIX keeps
 * a trailing newline for the shell's command-string contract; PowerShell and
 * cmd receive their native one-command forms.
 */
export function deliveryProbeCommand(marker: string, dialect: ShellDialect = "posix"): string {
  if (!/^TUT-DELIVERY-PROBE-[0-9A-F]{8}$/u.test(marker)) {
    throw new Error("invalid delivery probe marker");
  }
  switch (dialect) {
    case "posix":
      return `printf '${marker}'\n`;
    case "powershell5":
    case "pwsh":
      return `Write-Output ${psq(marker)}`;
    case "cmd":
      // The marker vocabulary contains no cmd metacharacters.  `echo(` also
      // works when command extensions are disabled and does not require an
      // input stream or a second key press.
      return `echo(${marker}`;
  }
}

/** Remove a probe's echo/command from a screen before applying the existing
 * input-box criterion. Probe output is deliberately an overlay: it must not
 * turn a held composer into a false "cleared" result.
 */
export function withoutDeliveryProbe(
  screen: string,
  markers: string | readonly string[],
  dialect: ShellDialect = "posix",
): string {
  const values = typeof markers === "string" ? [markers] : markers;
  return values.reduce((current, marker) => {
    const command = deliveryProbeCommand(marker, dialect);
    return current
      .replaceAll(command, "")
      .replaceAll(command.trimEnd(), "")
      .replaceAll(marker, "");
  }, screen);
}

/** The env knobs of the delivery loop, parsed once per delivery.  Every
 *  window- and cadence-class knob is clamped to ≥1: a zero window would
 *  skip its phase outright (every delivery degrading to give-up) while
 *  looking like a legal `\d+` value. */
export interface DeliveryKnobs {
  /** Poll cadence shared by every loop step.  Minimum 1: a zero cadence
   *  would divide every poll-count window by zero (Infinity loops, or NaN
   *  from 0/0) — the parse clamps it so all windows stay finite. */
  pollMs: number;
  /** Minimum 1 (window class: the floor may be tiny, never zero). */
  readyFloorMs: number;
  readyTimeoutMs: number;
  /** Quiescence depth: after the change from baseline, this many
   *  CONSECUTIVE identical samples must be seen before the gate releases
   *  (two were fooled by a banner TUI's drawing pauses ≥2×poll).  Clamped
   *  to ≥2 (one sample is not stability); N×poll is the quiescence window
   *  (default 4×250ms ≈ 1s). */
  readyStablePolls: number;
  textLandTimeoutMs: number;
  /** Attempt-1 initial observation sub-window — capped by the shared
   *  submit budget (the actual sub-window is min(now + this, deadline)). */
  submitTimeoutMs: number;
  submitRetryMs: number;
  /** The ONE submit-phase budget: from the first Enter to the last
   *  confirmation/give-up, monotonic, never re-armed after the initial
   *  window.  Minimum 1 like the legacy poll-count clamp. */
  submitRetryWindowMs: number;
}

/**
 * Parse the delivery knobs.  `TUT_SUBMIT_RETRIES` and
 * `TUT_SUBMIT_READY_TIMEOUT_MS` are deliberately absent: they are inert
 * legacy knobs, kept tolerated (never read, never fatal) so old launch
 * environments carrying them do not fail.
 */
export function parseDeliveryKnobs(environment: NodeJS.ProcessEnv): DeliveryKnobs {
  return {
    pollMs: Math.max(1, envInt(environment, "TUT_READY_POLL_MS", 250)),
    readyFloorMs: Math.max(1, envInt(environment, "TUT_READY_FLOOR_MS", 1500)),
    readyTimeoutMs: Math.max(1, envInt(environment, "TUT_READY_TIMEOUT_MS", 15000)),
    readyStablePolls: Math.max(2, envInt(environment, "TUT_READY_STABLE_POLLS", 4)),
    textLandTimeoutMs: Math.max(1, envInt(environment, "TUT_TEXT_LAND_TIMEOUT_MS", 5000)),
    submitTimeoutMs: Math.max(1, envInt(environment, "TUT_SUBMIT_TIMEOUT_MS", 3000)),
    submitRetryMs: Math.max(1, envInt(environment, "TUT_SUBMIT_RETRY_MS", 1500)),
    submitRetryWindowMs: Math.max(1, envInt(environment, "TUT_SUBMIT_RETRY_TIMEOUT_MS", 30000)),
  };
}

/** How many base submit windows a BORN pane's never-landed wait may span at
 *  most: parallel cold starts have measured the echo landing past
 *  the base window while the screen keeps painting; the wait deadline SLIDES
 *  by one window per observed screen change, capped here.  Two windows keep
 *  the worst-case phase sum (gate + land + extended wait + submit budget)
 *  inside the launcher's production orchestration budget. */
export const BORN_LANDWAIT_MAX_WINDOWS = 2;

/** Stop-loss floor: a with-text screen that stays byte-identical and
 *  held for this many consecutive polls means the receiver never repaints
 *  once — frozen for Enter purposes.  The effective threshold is
 *  max(this, 2/3 of the submit window in polls), so tiny test budgets never
 *  trigger it while production (40 × 250ms = 10s minimum, 20s at the
 *  default 30s window) stops well before burning the whole budget. */
export const HELD_STALL_GIVEUP_POLLS = 40;

/** Monotonic milliseconds — every phase budget's production time source
 *  (wall-clock independent; diagnostic epoch stamps keep Date.now). */
const monotonicNow = (): number => performance.now();

// ---- diagnostics: the decoupled dual-sink observer ---------------------------

export interface DeliveryDiagnostics {
  /** Emit one `tut-delivery t=<epoch-ms> <fields>` line to both sinks. */
  emit(fields: string): void;
  /** Wait for the durable sink to drain (best-effort appends are async). */
  flush(): Promise<void>;
}

/** Injectable filesystem seam for the durable sink; defaults to node:fs. */
export interface DiagnosticsFs {
  isDirectory(target: string): boolean;
  mkdir(dir: string): Promise<void>;
  append(file: string, text: string): Promise<void>;
  /** Current byte size of the log file; -1 when absent (rotation setup). */
  size(file: string): Promise<number>;
  /** Rotation move (log → log.1); a failure disables rotation, never the log. */
  rename(from: string, to: string): Promise<void>;
}

/** One rotated generation is kept (`delivery.log.1`); the active file never
 *  grows past this (the log used to be unbounded). */
export const DELIVERY_LOG_MAX_BYTES = 5 * 1024 * 1024;

const nodeFs: DiagnosticsFs = {
  isDirectory: (target) => {
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  },
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  append: (file, text) => appendFile(file, text, "utf8").then(() => undefined),
  size: async (file) => {
    try {
      return (await stat(file)).size;
    } catch {
      return -1;
    }
  },
  rename: (from, to) => rename(from, to).then(() => undefined),
};

export interface DeliveryDiagnosticsOptions {
  /** Defaults to the process env, read once at creation. */
  env?: NodeJS.ProcessEnv;
  /** Task/role context stamped on every persisted line; "?" when absent. */
  task_id?: string;
  role?: string;
  /**
   * Legacy chain-root fallback (the anchor cwd) used when TUT_PROJECT_ROOT
   * is unset or not a real directory; absent → stderr only.
   */
  persistRootFallback?: string;
  stderr?: (text: string) => void;
  clock?: () => number;
  fs?: DiagnosticsFs;
}

/**
 * Legacy switch semantics: diagnostics are on when TUT_DELIVERY_DIAG is unset
 * or exactly "1"; any other value silences both sinks.
 */
export function diagEnabled(environment: NodeJS.ProcessEnv): boolean {
  const raw = environment.TUT_DELIVERY_DIAG;
  return raw === undefined || raw === "1";
}

const silentDiagnostics: DeliveryDiagnostics = {
  emit: () => undefined,
  flush: async () => undefined,
};

/**
 * Build the dual-sink delivery observer.  Persistence is resolved lazily at
 * the first emitted line (a silenced or diag-free run touches no disk), and
 * the first failing append disables persistence for the rest of the run —
 * never the delivery, never the stderr line.  The durable file rotates by
 * size (one `.1` generation kept) and the write chain can never reject into
 * the caller: a diagnostics fault must not flip the launcher's exit 0 into
 * a duplicate-delivery-triggering failure.
 */
export function createDeliveryDiagnostics(options: DeliveryDiagnosticsOptions = {}): DeliveryDiagnostics {
  const environment = options.env ?? process.env;
  if (!diagEnabled(environment)) return silentDiagnostics;
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const clock = options.clock ?? Date.now;
  const fs = options.fs ?? nodeFs;
  const task = options.task_id ?? "?";
  const role = options.role ?? "?";

  let persistFile: string | undefined;
  let setupTried = false;
  let writes: Promise<void> = Promise.resolve();
  let logBytes = 0;
  let rotationUsable = true;

  const resolvePersistFile = async (): Promise<string | undefined> => {
    const configured = environment.TUT_PROJECT_ROOT;
    const root = configured !== undefined && configured.length > 0 && fs.isDirectory(configured)
      ? configured
      : options.persistRootFallback;
    if (root === undefined || root.length === 0) return undefined;
    const dir = path.join(root, ".context-hub");
    try {
      await fs.mkdir(dir);
    } catch {
      return undefined;
    }
    return path.join(dir, "delivery.log");
  };

  const persist = (now: number, fields: string): Promise<void> =>
    (async () => {
      if (!setupTried) {
        setupTried = true;
        persistFile = await resolvePersistFile();
        if (persistFile !== undefined) {
          try {
            const existing = await fs.size(persistFile);
            logBytes = Math.max(0, existing);
          } catch {
            rotationUsable = false;
          }
        }
      }
      if (persistFile === undefined) return;
      const line = `tut-delivery t=${now} task=${task} role=${role} ${fields}\n`;
      // The size cap counts BYTES (fs.size reports bytes): non-ASCII diag
      // fields (pane tails carry user text) make a line's byte length exceed
      // its character length, so the ledger tracks UTF-8 bytes throughout.
      const lineBytes = Buffer.byteLength(line, "utf8");
      try {
        if (rotationUsable && logBytes > 0 && logBytes + lineBytes > DELIVERY_LOG_MAX_BYTES) {
          try {
            await fs.rename(persistFile, `${persistFile}.1`);
            logBytes = 0;
          } catch {
            // Rotation is best-effort: keep appending to the same file.
            rotationUsable = false;
          }
        }
        await fs.append(persistFile, line);
        logBytes += lineBytes;
      } catch {
        // First failing append disables persistence for the run.
        persistFile = undefined;
      }
    })();

  return {
    emit(fields) {
      const now = clock();
      stderr(`tut-delivery t=${now} ${fields}\n`);
      writes = writes.then(() => persist(now, fields));
      // The chain tail is guarded here AND at flush: no diagnostics fault
      // may ever reject into the delivery caller (exit-0 invariant).
      void writes.catch(() => undefined);
    },
    async flush() {
      await writes.catch(() => undefined);
    },
  };
}

// ---- the delivery loop --------------------------------------------------------

/** Raw-argv pane control seam; failures are booleans/empty strings, never throws. */
export type DeliveryProbeDispatch = "sent" | "failed" | "unavailable";

export interface DeliveryClient {
  /** Visible-source read; "" on any failure (an empty read is a glitch). */
  readPane(paneId: string): Promise<string>;
  sendText(paneId: string, text: string): Promise<boolean>;
  sendKeys(paneId: string, key: string): Promise<boolean>;
  /**
   * Ask the birth-time shell relay to run a probe without writing to the
   * foreground Agent TUI.  Older panes may not have the relay; callers must
   * report that as `unavailable`, never fall back to sendText.
   */
  sendProbe?: (paneId: string, marker: string) => Promise<DeliveryProbeDispatch>;
}

export interface DeliveryOptions {
  client: DeliveryClient;
  diagnostics?: DeliveryDiagnostics;
  env?: NodeJS.ProcessEnv;
  /** Monotonic scheduling clock for every phase budget; production
   *  default is performance.now.  Diagnostic epoch timestamps keep their
   *  own Date.now-based clock — the two never mix. */
  clock?: () => number;
  delayFn?: (ms: number) => Promise<void>;
  stderr?: (text: string) => void;
  /** Dialect used by the shell relay; POSIX remains the compatibility default. */
  probeDialect?: ShellDialect;
  /**
   * Give-up escalation seam (7.2.1): invoked at most once per delivery,
   * when the bounded submit-retry window exhausts, AFTER the give-up diag
   * line, with the same evidence triple the diag line reports (box /
   * transport / probe) so the escalation event carries what the stderr
   * already says.  Awaited (an escalation POST must outlive the child's
   * short lifetime) but best-effort — a throwing or failing escalation
   * never changes the delivery outcome; the caller still exits 0.
   */
  onGiveUp?: (paneId: string, evidence: GiveUpEvidence) => Promise<void> | void;
  /**
   * Per-delivery nonce source for the attribution suffix appended to the
   * prompt (deliveryText).  Production default is a fresh 8-hex value per
   * delivery; tests pin it via TUT_DELIVERY_NONCE for deterministic
   * fixtures.
   */
  nonceFn?: () => string;
}

export interface DeliverPromptInput {
  paneId: string;
  prompt: string;
  /** born runs the readiness gate first; continuation snapshots and goes. */
  branch: "born" | "continuation";
}

export interface Delivery {
  /**
   * Deliver one prompt through the closed loop.  Only a send-text failure
   * returns false (nothing was delivered); every other outcome — including
   * window exhaustion — returns true so the caller exits 0 and never
   * re-triggers a duplicate delivery.
   */
  deliver(input: DeliverPromptInput): Promise<boolean>;
}

/** Bind the knobs and seams once; each delivery consumes the same binding. */
export function createDelivery(options: DeliveryOptions): Delivery {
  const client = options.client;
  const knobs = parseDeliveryKnobs(options.env ?? process.env);
  const diagnostics = options.diagnostics;
  const clock = options.clock ?? monotonicNow;
  const sleep = options.delayFn ?? delay;
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const diag = (fields: string): void => diagnostics?.emit(fields);
  const probeDialect = options.probeDialect ?? "posix";
  const probeMarkers = new Set<string>();
  const nonceEnv = options.env ?? process.env;
  const nonceFor = (): string => {
    const pinned = nonceEnv.TUT_DELIVERY_NONCE;
    if (pinned !== undefined && pinned.length > 0) return pinned;
    return randomBytes(4).toString("hex").toUpperCase();
  };

  interface ProbeResult {
    marker: string;
    dispatch: DeliveryProbeDispatch;
    found: boolean;
  }

  /** Honest probe evidence for "never observed": the budget ran out before
   *  this probe could run (or before its read could) — report unavailable,
   *  never a previous attempt's result. */
  const probeUnobserved = (): ProbeResult => ({ marker: "", dispatch: "unavailable", found: false });

  /** Wait until the freshly born pane shows its receiver: output changed
   *  from the `pane run` baseline and QUIESCENT — `readyStablePolls`
   *  consecutive identical samples (two were fooled by a banner TUI's
   *  drawing pauses) — no earlier than the floor, all inside ONE clock
   *  deadline (async control-call latency spends the same window, it no
   *  longer stretches a poll-count budget).  Timeout → deliver anyway
   *  (never worse). */
  const waitBornReady = async (paneId: string): Promise<string> => {
    const { pollMs, readyFloorMs, readyTimeoutMs, readyStablePolls } = knobs;
    diag(`gate-start pane=${paneId} floor_ms=${readyFloorMs} timeout_ms=${readyTimeoutMs} stable_polls=${readyStablePolls}`);
    const start = clock();
    const deadline = start + readyTimeoutMs;
    const baseline = await client.readPane(paneId);
    let previous = baseline;
    let latest = baseline;
    let stableRun = 0;
    let idx = 0;
    while (clock() < deadline) {
      await sleep(Math.min(pollMs, deadline - clock()));
      latest = await client.readPane(paneId);
      const changed = latest.length > 0 && latest !== baseline;
      stableRun = changed ? (latest === previous ? stableRun + 1 : 1) : 0;
      previous = latest;
      // A read that STARTED inside the deadline but RETURNED past it spent
      // the budget: it stays an observation (the read diag below), never a
      // release — the strict outcome is the gate timeout (deliver anyway,
      // unchanged).
      if (changed && clock() < deadline && stableRun >= readyStablePolls && clock() - start >= readyFloorMs) {
        diag(`gate-release pane=${paneId} idx=${idx} stable=${stableRun} len=${latest.length} tail='${diagTail(latest)}'`);
        return latest;
      }
      diag(`read pane=${paneId} step=gate idx=${idx} len=${latest.length} tail='${diagTail(latest)}'`);
      idx += 1;
    }
    stderr(
      `launch: born pane ${paneId} not observed ready within ${readyTimeoutMs}ms — delivering anyway (if the text idles in the input box, press Enter there manually)\n`,
    );
    diag(`gate-timeout pane=${paneId} idx=${idx} len=${latest.length}`);
    return latest;
  };

  /** The land outcome: the snapshot screen plus whether the SENT TEXT was
   *  actually observed on it — the submit phase's verification degrades
   *  honestly when it was not (7.2.1 step 3). */
  interface LandOutcome {
    screen: string;
    landed: boolean;
  }

  /** Poll the screen against the pre-send snapshot until a NEW INSTANCE
   *  of a fragment of the SENT TEXT appears in the COMPOSER REGION (last
   *  3 non-empty lines, count above the baseline's same region), inside
   *  ONE clock deadline (control-call latency spends the window).  Timeout
   *  → honest signal (the receiver may not accept input — or may be
   *  showing a modal): the submit phase enters its no-blind-Enter wait
   *  (Enter only after the text is observed; give-up + escalation if it
   *  never is). */
  const confirmTextLanded = async (paneId: string, baseline: string, prompt: string): Promise<LandOutcome> => {
    const { pollMs, textLandTimeoutMs } = knobs;
    const fragments = promptLandingFragments(prompt);
    diag(`land-start pane=${paneId} timeout_ms=${textLandTimeoutMs} frags=${fragments.length}`);
    const deadline = clock() + textLandTimeoutMs;
    let latest = baseline;
    let idx = 0;
    while (clock() < deadline) {
      await sleep(Math.min(pollMs, deadline - clock()));
      latest = await client.readPane(paneId);
      const matched = newLandingInstance(latest, baseline, fragments);
      // Same strict-deadline rule as the gate: a match returning past the
      // deadline is an observation only — a landing is never reported from
      // past the deadline; the honest outcome is the land timeout (a real
      // late landing is adopted by the submit phase's no-blind-Enter wait).
      if (matched >= 0 && clock() < deadline) {
        diag(`land-observed pane=${paneId} idx=${idx} len=${latest.length} frag='${fragLabel(fragments[matched] ?? "")}' tail='${diagTail(latest)}'`);
        return { screen: latest, landed: true };
      }
      diag(`read pane=${paneId} step=land idx=${idx} len=${latest.length} tail='${diagTail(latest)}'`);
      idx += 1;
    }
    stderr(
      `launch: prompt text not observed on ${paneId} within ${textLandTimeoutMs}ms — the receiver may not accept input yet; entering the no-blind-Enter wait (Enter only after the text is observed)\n`,
    );
    diag(`land-timeout pane=${paneId} idx=${idx} len=${latest.length}`);
    return { screen: latest, landed: false };
  };

  /**
   * The verified submit, split into its four phases: the degraded
   * never-landed wait, the informed initial Enter + observation window, the
   * clocked resend loop, and the shared give-up.  Phase 0 (degraded entry):
   * a textless screen never gets an Enter — the relay probe stays silent
   * too — only observe-only polls for a late landing (same NEW-instance
   * attribution rule) run here; a BORN pane may slide this wait's deadline
   * by one window per observed screen change (parallel cold-start echo
   * latency), capped at BORN_LANDWAIT_MAX_WINDOWS windows.  Phase 1
   * (landed): ONE Enter, then verify by the layered evidence — confirmed
   * only when the Enter's transport succeeded AND the box let go of the
   * text AND that cleared state survives one re-verification read a poll
   * later.  Phase 2: unconfirmed → resend Enter at most once per retry
   * interval inside the REMAINING shared budget (never in the cleared
   * state — the text already left the box; a resend could hit a started
   * round), stop early on a frozen held screen.  Exhaustion → the
   * evidence-based manual-fallback note and return (the caller still exits
   * 0).  The text is never re-sent.
   */
  const verifiedSubmit = async (
    paneId: string,
    withText: string,
    prompt: string,
    landed: boolean,
    baseline: string,
    branch: "born" | "continuation",
  ): Promise<void> => {
    const { pollMs, submitTimeoutMs, submitRetryMs, submitRetryWindowMs } = knobs;
    const fragments = promptLandingFragments(prompt);
    const boxOf = (screen: string): BoxState => boxEvidenceOf(screen, fragments);
    const start = clock();
    const probeField = (probe: ProbeResult): GiveUpProbeEvidence =>
      probe.dispatch === "unavailable" ? "unavailable" : probe.found ? "observed" : "failed";
    const evidence: SubmitEvidence = { transport: false, box: "unknown", probe: probeUnobserved() };
    /** Whether the sent text has been observed on screen.  False only
     *  after a land-confirm timeout; until a (late) landing is seen the
     *  box criterion is meaningless and stays unknown — the textless-
     *  snapshot cascade is structurally dead. */
    let hasLanded = landed;

    // ---- phase 0: the no-blind-Enter wait for a late landing -----------------
    if (!hasLanded) {
      stderr(
        `launch: prompt text never appeared on ${paneId} — no Enter will be sent until the text is observed (the receiver may be showing a dialog); bounded wait within the ${submitRetryWindowMs}ms budget, then give-up\n`,
      );
      diag(
        `land-wait pane=${paneId} budget_ms=${submitRetryWindowMs}${branch === "born" ? ` cap_windows=${BORN_LANDWAIT_MAX_WINDOWS}` : ""}`,
      );
      const cap = start + submitRetryWindowMs * (branch === "born" ? BORN_LANDWAIT_MAX_WINDOWS : 1);
      let waitDeadline = start + submitRetryWindowMs;
      let previous = withoutDeliveryProbe(withText, [...probeMarkers], probeDialect);
      let waitIdx = 0;
      while (!hasLanded && clock() < waitDeadline) {
        await sleep(Math.min(pollMs, waitDeadline - clock()));
        if (clock() >= waitDeadline) break; // budget spent: no new reads
        const latest = await client.readPane(paneId);
        const stripped = withoutDeliveryProbe(latest, [...probeMarkers], probeDialect);
        // SAME attribution rule as the immediate land loop: only a NEW
        // instance (occurrence count above the pre-send baseline) proves
        // THIS delivery — old scrollback/composer fragments never adopt.
        const matched = newLandingInstance(stripped, baseline, fragments);
        if (matched >= 0) {
          hasLanded = true;
          diag(`land-late pane=${paneId} phase=wait idx=${waitIdx} len=${latest.length} frag='${fragLabel(fragments[matched] ?? "")}' tail='${diagTail(latest)}'`);
        } else {
          diag(`read pane=${paneId} step=landwait idx=${waitIdx} len=${latest.length} box=unknown tail='${diagTail(latest)}'`);
          if (branch === "born" && stripped !== previous) {
            // The receiver is visibly alive (a cold start still painting):
            // slide the wait window — bounded by the cap, so a perpetual
            // repaint cannot wait forever.
            const slid = Math.min(clock() + submitRetryWindowMs, cap);
            if (slid > waitDeadline) {
              waitDeadline = slid;
              diag(`land-wait-extend pane=${paneId} idx=${waitIdx} deadline_ms=${Math.round(waitDeadline - start)} cap_ms=${Math.round(cap - start)}`);
            }
          }
        }
        previous = stripped;
        waitIdx += 1;
      }
      if (!hasLanded) {
        const elapsedMs = clock() - start;
        const extended = branch === "born" && elapsedMs > submitRetryWindowMs;
        stderr(
          `launch: submit not confirmed on ${paneId} within ${submitRetryWindowMs}ms after 0 Enters — the prompt text was never observed on screen; no Enter was sent${extended ? ` (wait ran ${Math.round(elapsedMs)}ms — the window slid while the screen kept changing)` : ""} — inspect the pane: if the text is visible in the input box, press Enter there manually; if it is gone, re-deliver the prompt manually\n`,
        );
        diag(
          `give-up pane=${paneId} attempts=0 window_ms=${submitRetryWindowMs} box=unknown transport=false probe=not-attempted elapsed_ms=${elapsedMs} budget_ms=${submitRetryWindowMs} reason=land-never-observed`,
        );
        try {
          await options.onGiveUp?.(paneId, { box: "unknown", transport: false, probe: "not-attempted" });
        } catch {
          // Escalation is best-effort: a failed notify degrades to the stderr
          // diagnostics and the stall watchdog, never to a changed outcome.
        }
        return;
      }
    }

    // ---- the submit phase anchors at the landing --------------------------------
    // No side effect ran during the wait above, so a late landing inherits a
    // FULL window; from here on the ONE deadline spans the initial window and
    // every resend and is never re-armed.
    const submitStart = clock();
    const deadline = submitStart + submitRetryWindowMs;
    const landwaitMs = submitStart - start;
    let attempt = 1;

    /**
     * Verify the Enter path after one send-keys. The relay request and its
     * read add no sleep to the existing submit cadence. A failed probe is
     * deliberately a non-fatal submit failure: the caller's bounded Enter
     * loop decides whether to try again. The probe is diagnostic only and
     * self-guards on the submit deadline: neither the relay request nor its
     * read may start at/past it — a skipped observation returns
     * `unavailable`, never a stale result.  A request that never went out
     * (dispatch ≠ sent) starts NO read, and a read that DID run feeds the
     * box evidence directly — one observation, never discarded.
     */
    const probeEnter = async (
      paneId2: string,
      attemptNo: number,
      phase: "initial" | "loop",
    ): Promise<ProbeResult> => {
      const marker = deliveryProbeMarker(prompt);
      probeMarkers.add(marker);
      if (clock() >= deadline) {
        diag(`probe-skip pane=${paneId2} attempt=${attemptNo} phase=${phase} reason=deadline marker=${marker}`);
        return probeUnobserved();
      }
      diag(`probe-send pane=${paneId2} attempt=${attemptNo} phase=${phase} marker=${marker}`);
      let dispatch: DeliveryProbeDispatch = "unavailable";
      if (client.sendProbe !== undefined) {
        try {
          dispatch = await client.sendProbe(paneId2, marker);
        } catch {
          dispatch = "failed";
        }
      }
      if (clock() >= deadline) {
        // The relay request started before the deadline but the budget is
        // spent: the marker's visibility was never observed, and starting the
        // read now would be a new side effect past the deadline.
        diag(`probe-skip pane=${paneId2} attempt=${attemptNo} phase=${phase} reason=deadline marker=${marker}`);
        return probeUnobserved();
      }
      if (dispatch !== "sent") {
        diag(`probe-result pane=${paneId2} attempt=${attemptNo} phase=${phase} marker=${marker} dispatch=${dispatch} found=false len=0 tail=''`);
        return { marker, dispatch, found: false };
      }
      const screen = await client.readPane(paneId2);
      const found = screen.includes(marker);
      const stripped = withoutDeliveryProbe(screen, [...probeMarkers], probeDialect);
      evidence.box = boxOf(stripped);
      diag(
        `probe-result pane=${paneId2} attempt=${attemptNo} phase=${phase} marker=${marker} dispatch=sent found=${found} len=${screen.length} tail='${diagTail(screen)}'`,
      );
      return { marker, dispatch, found };
    };

    /** Submit-phase evidence triple from the LATEST Enter: transport (the
     *  send-keys control call itself), box (derived from the probe-stripped
     *  screen — observe reads and probe reads alike feed it), probe (relay
     *  visibility, diagnostic only).  Every human-facing message is
     *  generated from it — only box=held may claim the prompt still sits
     *  in the composer. */
    interface SubmitEvidence {
      transport: boolean;
      box: BoxState;
      probe: ProbeResult;
    }

    /** One cadence observation: read the screen, strip the probe overlay,
     *  derive the box evidence, emit the read line, return the stripped
     *  screen (the stall tracker consumes it). */
    const observe = async (phase: "verify" | "loop", idx: number): Promise<string> => {
      const latest = await client.readPane(paneId);
      const stripped = withoutDeliveryProbe(latest, [...probeMarkers], probeDialect);
      evidence.box = boxOf(stripped);
      diag(
        `read pane=${paneId} step=${phase} idx=${idx} len=${latest.length} box=${evidence.box} probe=${probeField(evidence.probe)} tail='${diagTail(latest)}'`,
      );
      return stripped;
    };

    /** Post-confirm re-verification: a submit-confirmed stands only
     *  after ONE further observation, a poll apart, still shows the sent
     *  text gone from the bottom edge.  A startup repaint that fooled one
     *  read cannot fool two; a genuinely submitted round keeps the text
     *  gone.  A re-verification that cannot run (budget spent) or that sees
     *  the text back revokes the confirmation — the loop resumes. */
    const confirmRecheck = async (attemptNo: number): Promise<boolean> => {
      const now = clock();
      if (now < deadline) {
        await sleep(Math.min(pollMs, deadline - now));
      }
      if (clock() >= deadline) {
        diag(`confirm-revoked pane=${paneId} attempt=${attemptNo} reason=budget`);
        return false;
      }
      const latest = await client.readPane(paneId);
      if (clock() >= deadline) {
        // The re-verification read straddled the deadline: budget spent, so
        // the observation updates the evidence but the confirm cannot stand.
        const strippedLate = withoutDeliveryProbe(latest, [...probeMarkers], probeDialect);
        evidence.box = boxOf(strippedLate);
        diag(`confirm-revoked pane=${paneId} attempt=${attemptNo} reason=budget`);
        return false;
      }
      const stripped = withoutDeliveryProbe(latest, [...probeMarkers], probeDialect);
      const box = boxOf(stripped);
      evidence.box = box;
      diag(
        `read pane=${paneId} step=recheck idx=0 len=${latest.length} box=${box} probe=${probeField(evidence.probe)} tail='${diagTail(latest)}'`,
      );
      if (box === "cleared") {
        diag(`confirm-rechecked pane=${paneId} attempt=${attemptNo} box=cleared`);
        return true;
      }
      diag(`confirm-revoked pane=${paneId} attempt=${attemptNo} box=${box}`);
      return false;
    };

    // ---- phase 1: the informed initial Enter + observation window -------------
    diag(
      `submit pane=${paneId} phase=initial attempt=1 verify_ms=${submitTimeoutMs} retry_ms=${submitRetryMs} window_ms=${submitRetryWindowMs}`,
    );
    const firstTransport = await client.sendKeys(paneId, "Enter");
    if (!firstTransport) {
      stderr(`launch: herdr pane send-keys ${paneId} Enter failed (initial attempt)\n`);
    }
    evidence.transport = firstTransport;
    diag(`enter pane=${paneId} attempt=1 phase=initial`);
    // The probe self-guards on the deadline: a first Enter that returns at/
    // past it starts no relay request and no read.
    evidence.probe = await probeEnter(paneId, attempt, "initial");

    // The initial observation window is capped by the shared deadline —
    // never a budget of its own.
    const initialEnd = Math.min(submitStart + submitTimeoutMs, deadline);
    let idx = 0;
    for (;;) {
      const now = clock();
      if (now >= initialEnd) break;
      await sleep(Math.min(pollMs, initialEnd - now));
      if (clock() >= deadline) break; // budget spent: no new observation work
      await observe("verify", idx);
      if (evidence.transport && evidence.box === "cleared") {
        diag(`submit-confirmed pane=${paneId} attempt=${attempt} phase=verify idx=${idx}`);
        if (await confirmRecheck(attempt)) return;
      }
      idx += 1;
    }

    // Loop entry: the evidence-based degradation note (only box=held may
    // say the prompt is still in the composer).
    const entryElapsed = clock() - submitStart;
    if (evidence.box === "held") {
      stderr(
        `launch: input box still holds the text on ${paneId} after ${entryElapsed}ms — bounded Enter resend loop (interval ${submitRetryMs}ms, total budget ${submitRetryWindowMs}ms)\n`,
      );
    } else if (evidence.box === "cleared") {
      stderr(
        `launch: input box has released the text on ${paneId} but the submit is unconfirmed (last Enter transport=${evidence.transport}) — do not press Enter blindly; continuing bounded verification (interval ${submitRetryMs}ms, total budget ${submitRetryWindowMs}ms)\n`,
      );
    } else {
      stderr(
        `launch: input box state unknown on ${paneId} after ${entryElapsed}ms (screen read unavailable) — bounded Enter resend loop (interval ${submitRetryMs}ms, total budget ${submitRetryWindowMs}ms)\n`,
      );
    }
    diag(
      `loop-start pane=${paneId} attempts=${attempt} interval_ms=${submitRetryMs} window_ms=${submitRetryWindowMs} box=${evidence.box} transport=${evidence.transport} probe=${probeField(evidence.probe)}`,
    );

    const resendNote = (attemptNo: number): string => {
      if (evidence.box === "held") {
        return `launch: resending Enter (attempt ${attemptNo}) on ${paneId} — the prompt is still visible in the input box\n`;
      }
      return `launch: resending Enter (attempt ${attemptNo}) on ${paneId} — unconfirmed: screen read unavailable\n`;
    };

    // ---- phase 2: clocked resends inside the REMAINING budget -----------------
    // Every sleep and side effect runs on the clock; at/past the deadline
    // nothing new starts.  box=cleared never resends (the text already left
    // the box — a resend could hit a started round); a held screen frozen
    // byte-identical across the stall streak gives up early.
    const stallGiveupPolls = Math.max(
      HELD_STALL_GIVEUP_POLLS,
      Math.trunc((submitRetryWindowMs / pollMs) * 2 / 3),
    );
    let lastEnterAt = submitStart;
    let step = 0;
    let stallAnchor: string | undefined;
    let stallScreens = 0;
    let stalled = false;
    for (;;) {
      const now = clock();
      if (now >= deadline) break;
      await sleep(Math.min(pollMs, deadline - now));
      if (clock() >= deadline) break; // budget spent: no new reads, Enters, probes
      step += 1;
      const stripped = await observe("loop", step);
      if (evidence.box === "held") {
        if (stripped === stallAnchor) {
          stallScreens += 1;
        } else {
          stallAnchor = stripped;
          stallScreens = 1;
        }
        if (stallScreens >= stallGiveupPolls) {
          stalled = true;
          stderr(
            `launch: the screen on ${paneId} has not changed once across ${stallScreens} polls while holding the text — the receiver looks frozen; stopping the Enter loop early\n`,
          );
          diag(`held-stall pane=${paneId} polls=${stallScreens}`);
          break;
        }
      } else {
        stallAnchor = undefined;
        stallScreens = 0;
      }
      if (evidence.transport && evidence.box === "cleared") {
        stderr(`launch: input box cleared on ${paneId} — submit confirmed (attempt ${attempt})\n`);
        diag(`submit-confirmed pane=${paneId} attempt=${attempt} phase=loop idx=${step}`);
        if (await confirmRecheck(attempt)) return;
        continue;
      }
      if (clock() - lastEnterAt >= submitRetryMs && clock() < deadline && evidence.box !== "cleared") {
        attempt += 1;
        evidence.transport = await client.sendKeys(paneId, "Enter");
        if (!evidence.transport) {
          stderr(`launch: herdr pane send-keys ${paneId} Enter failed (attempt ${attempt})\n`);
        }
        stderr(resendNote(attempt));
        diag(`enter pane=${paneId} attempt=${attempt} phase=loop resend`);
        // Evidence from BEFORE this Enter may not outlive it: if the budget
        // ends before a fresh post-Enter observation, give-up must speak
        // from unknown/unavailable — never from the previous attempt's
        // held/observed view (the prompt may have committed in between).
        evidence.box = "unknown";
        evidence.probe = await probeEnter(paneId, attempt, "loop");
        lastEnterAt = clock();
      }
    }

    // Give-up: still exit 0 (a failure exit would re-deliver the prompt),
    // the text was never re-sent, and the manual hint follows the last
    // evidence — never a blind "press Enter".
    const reason =
      evidence.box === "held" ? "box-held" : evidence.box === "cleared" ? "box-cleared-unconfirmed" : "box-unknown";
    const elapsedMs = clock() - start;
    const notConfirmed = stalled
      ? `launch: submit not confirmed on ${paneId} after ${attempt} Enters — `
      : `launch: submit not confirmed on ${paneId} within ${submitRetryWindowMs}ms after ${attempt} Enters — `;
    if (evidence.box === "held") {
      stderr(`${notConfirmed}${giveUpGuidance("held")}\n`);
    } else if (evidence.box === "cleared") {
      stderr(`${notConfirmed}${giveUpGuidance("cleared")}\n`);
    } else {
      // Launcher-specific diagnostic prefix (the WHY: the screen read
      // failed) around the shared guidance — which stays byte-identical
      // to the notifier's alert copy.
      stderr(`${notConfirmed}screen read unavailable; ${giveUpGuidance("unknown")}\n`);
    }
    diag(
      `give-up pane=${paneId} attempts=${attempt} window_ms=${submitRetryWindowMs} box=${evidence.box} transport=${evidence.transport} probe=${probeField(evidence.probe)} elapsed_ms=${elapsedMs} budget_ms=${submitRetryWindowMs}${landwaitMs > 0 ? ` landwait_ms=${Math.round(landwaitMs)}` : ""} reason=${reason}`,
    );
    try {
      await options.onGiveUp?.(paneId, {
        box: evidence.box,
        transport: evidence.transport,
        probe: probeField(evidence.probe),
      } satisfies GiveUpEvidence);
    } catch {
      // Escalation is best-effort: a failed notify degrades to the stderr
      // diagnostics and the stall watchdog, never to a changed outcome.
    }
  };

  return {
    async deliver(input) {
      let baseline: string;
      if (input.branch === "born") {
        baseline = await waitBornReady(input.paneId);
      } else {
        // Continuation: the seat's UI is already up — no readiness gate, but
        // the SAME land-confirm + verified-submit loop (one delivery code
        // path, no drift).
        baseline = await client.readPane(input.paneId);
        diag(`read pane=${input.paneId} step=snapshot idx=0 len=${baseline.length} tail='${diagTail(baseline)}'`);
      }
      // The prompt is delivered with a per-delivery nonce suffix: the
      // landing attribution's causal anchor (7.2.1 step 3).  The text is
      // still sent exactly once.
      const sentText = deliveryText(input.prompt, nonceFor());
      const sent = await client.sendText(input.paneId, sentText);
      if (!sent) {
        stderr(`launch: herdr pane send-text ${input.paneId} failed\n`);
        return false;
      }
      diag(`send-text pane=${input.paneId} branch=${input.branch} len=${sentText.length}`);
      const land = await confirmTextLanded(input.paneId, baseline, sentText);
      await verifiedSubmit(input.paneId, land.screen, sentText, land.landed, baseline, input.branch);
      return true;
    },
  };
}

/**
 * Readiness-gated prompt delivery and its decoupled diagnostics observer.
 *
 * Port of the legacy launch.sh delivery section (7.2.1 closed loop) and its known delivery-robustness lessons
 * historical baggage included: every degradation keeps going (only a send-text
 * failure is fatal), the text is never re-sent, Enter resends run on the
 * clock inside ONE shared monotonic budget (the initial observation window
 * and every resend spend the same deadline — no window is ever re-armed),
 * and budget exhaustion still reports success so the caller cannot
 * re-deliver a duplicated prompt.  The born gate demands QUIESCENCE (N
 * consecutive identical samples — banner TUIs repaint in pauses), landing
 * demands a NEW INSTANCE of a fragment of the SENT TEXT in the composer's
 * bottom region that ENDS the screen's final rows (any change once let a
 * banner repaint pose as a landed prompt — the false-confirm cascade;
 * whole-screen totals once let a viewport scroll or modal reveal fake or
 * hide an instance; a bare position window once let a re-revealed
 * transcript echo fire a blind Enter), every prompt is delivered with a
 * per-delivery NONCE suffix (deliveryText) so the landing evidence is
 * causally attributable to THIS send-text — a previous round's
 * byte-identical prompt ends with a DIFFERENT nonce, which kills the
 * re-revealed-history false confirm even in the zero-UI-row geometry
 * where a bare transcript line is indistinguishable from an occupied
 * composer row by content alone, and
 * a textless snapshot confirms nothing — an UNSEEN text means NO Enter at
 * all (a live reproduction caught the blind Enter confirming a modal
 * dialog): observe-only polling for a late landing, then give-up with
 * escalation if the text never appears.  Human-facing
 * wording follows the last
 * evidence (transport / box / probe): only box=held may claim the prompt is
 * still sitting in the composer.  The diagnostics are a
 * pure observer — one `tut-delivery t=<epoch-ms> …` line per delivery step to
 * stderr and, best-effort, to `<root>/.context-hub/delivery.log`; the switch
 * silences both sinks and no branch ever reads them back.
 *
 * This module never resolves routes or naming: it consumes the prompt frozen
 * in a LaunchInvocation.  All pane reads use the visible source (the `recent`
 * snapshots proved unreliable on freshly born panes); all control-plane calls
 * stay behind the caller's raw-argv client seam.
 */

import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
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
  const rows = latest
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+$/u, ""))
    .filter((line) => line.length > 0);
  const last1 = normalizeForLanding(rows[rows.length - 1] ?? "");
  const last2 = normalizeForLanding(`${rows[rows.length - 2] ?? ""}${rows[rows.length - 1] ?? ""}`);
  return fragments.findIndex((fragment) => {
    const f = normalizeForLanding(fragment);
    if (f.length === 0) return false;
    if (countOccurrences(latestBottom, f) <= countOccurrences(baselineBottom, f)) return false;
    return (last1.length > 0 && last1.endsWith(f)) || (last2.length > 0 && last2.endsWith(f));
  });
}

/** Bounded, quote-free fragment text for the diag `frag=` field. */
const fragLabel = (fragment: string): string => fragment.slice(0, LANDING_FRAGMENT_MAX).replaceAll("'", "");

/** Evidence state of the receiver's input box, derived from the visible
 *  screen: `cleared` — the bottom region let go of the with-text snapshot;
 *  `held` — the region still matches (the prompt is still visible in the
 *  composer); `unknown` — the read was empty (a glitch): the box state is
 *  simply not observable. */
export type BoxState = "held" | "cleared" | "unknown";

/** Box evidence from one screen: empty reads are `unknown`, region change
 *  against the with-text snapshot is `cleared`, otherwise `held`. */
export function boxState(screen: string, signature: string): BoxState {
  if (screen.length === 0) return "unknown";
  return screenBottom(screen, 3) !== signature ? "cleared" : "held";
}

/**
 * Submit-confirmed box predicate: a NON-EMPTY screen whose bottom region no
 * longer matches the with-text snapshot's region.  Repaints above the region
 * do not count; an empty read is a glitch and never confirms.  Call-site
 * note: the predicate is only meaningful against a WITH-TEXT snapshot —
 * since text-match landing (7.2.1 step 3) the submit loop never feeds it a
 * textless signature (box evidence stays unknown until the text is seen),
 * so the historical empty-region false-positive window is structurally
 * unreachable in the live path.
 */
export function boxCleared(screen: string, signature: string): boolean {
  return boxState(screen, signature) === "cleared";
}

/**
 * Bounded tail for diag lines: last non-empty line, trailing whitespace
 * trimmed, capped at 40 chars, single quotes stripped — rides inside the
 * quoted tail='…' field (bounded, safe to log).
 */
export function diagTail(screen: string): string {
  const lines = screen
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+$/u, ""))
    .filter((line) => line.length > 0);
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

/** The env knobs of the delivery loop, parsed once per delivery. */
export interface DeliveryKnobs {
  /** Poll cadence shared by every loop step.  Minimum 1: a zero cadence
   *  would divide every poll-count window by zero (Infinity loops, or NaN
   *  from 0/0) — the parse clamps it so all windows stay finite. */
  pollMs: number;
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
  /** Minimum 1 like the legacy poll-count clamp. */
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
    readyFloorMs: envInt(environment, "TUT_READY_FLOOR_MS", 1500),
    readyTimeoutMs: envInt(environment, "TUT_READY_TIMEOUT_MS", 15000),
    readyStablePolls: Math.max(2, envInt(environment, "TUT_READY_STABLE_POLLS", 4)),
    textLandTimeoutMs: envInt(environment, "TUT_TEXT_LAND_TIMEOUT_MS", 5000),
    submitTimeoutMs: envInt(environment, "TUT_SUBMIT_TIMEOUT_MS", 3000),
    submitRetryMs: Math.max(1, envInt(environment, "TUT_SUBMIT_RETRY_MS", 1500)),
    submitRetryWindowMs: Math.max(1, envInt(environment, "TUT_SUBMIT_RETRY_TIMEOUT_MS", 30000)),
  };
}

/** Polls a window allows (legacy poll-count arithmetic, truncated). */
function pollsOf(windowMs: number, pollMs: number): number {
  return Math.trunc(windowMs / pollMs);
}

/** Monotonic milliseconds — the submit budget's production time source
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
}

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
 * never the delivery, never the stderr line.
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
      }
      if (persistFile === undefined) return;
      try {
        await fs.append(persistFile, `tut-delivery t=${now} task=${task} role=${role} ${fields}\n`);
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
    },
    async flush() {
      await writes;
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
  /** Monotonic scheduling clock for the submit-phase budget; production
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

  /**
   * Verify the Enter path after one send-keys. The relay request and its read
   * add no sleep to the existing submit cadence. A failed probe is deliberately
   * a non-fatal submit failure: the caller's bounded Enter loop decides whether
   * to try again. The probe is diagnostic only and self-guards on the submit
   * deadline: neither the relay request nor its read may start at/past it —
   * a skipped observation returns `unavailable`, never a stale result.
   */
  const probeEnter = async (paneId: string, prompt: string, attempt: number, phase: "initial" | "loop", deadline: number): Promise<ProbeResult> => {
    const marker = deliveryProbeMarker(prompt);
    probeMarkers.add(marker);
    if (clock() >= deadline) {
      diag(`probe-skip pane=${paneId} attempt=${attempt} phase=${phase} reason=deadline marker=${marker}`);
      return probeUnobserved();
    }
    diag(`probe-send pane=${paneId} attempt=${attempt} phase=${phase} marker=${marker}`);
    let dispatch: DeliveryProbeDispatch = "unavailable";
    if (client.sendProbe !== undefined) {
      try {
        dispatch = await client.sendProbe(paneId, marker);
      } catch {
        dispatch = "failed";
      }
    }
    if (clock() >= deadline) {
      // The relay request started before the deadline but the budget is
      // spent: the marker's visibility was never observed, and starting the
      // read now would be a new side effect past the deadline.
      diag(`probe-skip pane=${paneId} attempt=${attempt} phase=${phase} reason=deadline marker=${marker}`);
      return probeUnobserved();
    }
    const screen = await client.readPane(paneId);
    const found = dispatch === "sent" && screen.includes(marker);
    diag(
      `probe-result pane=${paneId} attempt=${attempt} phase=${phase} marker=${marker} dispatch=${dispatch} found=${found} len=${screen.length} tail='${diagTail(screen)}'`,
    );
    return { marker, dispatch, found };
  };

  /** Submit-phase evidence triple from the LATEST Enter: transport (the
   *  send-keys control call itself), box (derived from the probe-stripped
   *  screen), probe (relay visibility, diagnostic only).  Every
   *  human-facing message is generated from it — only box=held may claim
   *  the prompt still sits in the composer. */
  interface SubmitEvidence {
    transport: boolean;
    box: BoxState;
    probe: ProbeResult;
  }

  /** Wait until the freshly born pane shows its receiver: output changed
   *  from the `pane run` baseline and QUIESCENT — `readyStablePolls`
   *  consecutive identical samples (two were fooled by a banner TUI's
   *  drawing pauses) — no earlier than the floor (in legacy poll-count
   *  arithmetic).  Timeout → deliver anyway (never worse). */
  const waitBornReady = async (paneId: string): Promise<string> => {
    const { pollMs, readyFloorMs, readyTimeoutMs, readyStablePolls } = knobs;
    const maxPolls = pollsOf(readyTimeoutMs, pollMs);
    const floorPolls = pollsOf(readyFloorMs, pollMs);
    diag(`gate-start pane=${paneId} floor_ms=${readyFloorMs} timeout_ms=${readyTimeoutMs} stable_polls=${readyStablePolls}`);
    const baseline = await client.readPane(paneId);
    let previous = baseline;
    let latest = baseline;
    let stableRun = 0;
    let idx = 0;
    while (idx < maxPolls) {
      await sleep(pollMs);
      latest = await client.readPane(paneId);
      const changed = latest.length > 0 && latest !== baseline;
      stableRun = changed ? (latest === previous ? stableRun + 1 : 1) : 0;
      previous = latest;
      if (changed && stableRun >= readyStablePolls && idx >= floorPolls) {
        diag(`gate-release pane=${paneId} idx=${idx} stable=${stableRun} len=${latest.length} tail='${diagTail(latest)}'`);
        return latest;
      }
      diag(`read pane=${paneId} step=gate idx=${idx} len=${latest.length} tail='${diagTail(latest)}'`);
      idx += 1;
    }
    stderr(
      `launch: born pane ${paneId} not observed ready within ${maxPolls * pollMs}ms — delivering anyway (if the text idles in the input box, press Enter there)\n`,
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
   *  3 non-empty lines, count above the baseline's same region) — mere
   *  change no longer counts, whole-screen totals can not attribute a hit
   *  (a viewport scroll or modal reveal shifts old instances across the
   *  read window: 1→1 hides a real landing, 0→1 fabricates one), and
   *  text already rendered before the send proves nothing.  Timeout →
   *  honest signal (the receiver may not accept input — or may be showing
   *  a modal): the submit phase enters its no-blind-Enter wait (Enter
   *  only after the text is observed; give-up + escalation if it never
   *  is). */
  const confirmTextLanded = async (paneId: string, baseline: string, prompt: string): Promise<LandOutcome> => {
    const { pollMs, textLandTimeoutMs } = knobs;
    const fragments = promptLandingFragments(prompt);
    const maxPolls = pollsOf(textLandTimeoutMs, pollMs);
    diag(`land-start pane=${paneId} timeout_ms=${textLandTimeoutMs} frags=${fragments.length}`);
    let latest = baseline;
    let idx = 0;
    while (idx < maxPolls) {
      await sleep(pollMs);
      latest = await client.readPane(paneId);
      const matched = newLandingInstance(latest, baseline, fragments);
      if (matched >= 0) {
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

  /** Phase 0 (degraded entry): a textless screen never gets an Enter —
   *  the relay probe stays silent too — only observe-only polls for a
   *  late landing (same NEW-instance-vs-baseline attribution rule as the
   *  immediate loop: old scrollback/composer fragments never adopt) inside
   *  the SAME shared budget.  Phase 1 (landed): ONE
   *  Enter, then verify by the layered evidence — confirmed only when
   *  the Enter's transport succeeded AND the box let go of the text (the
   *  probe stays diagnostic: it never confirms, never blocks, never
   *  triggers a resend).  Phase 2: unconfirmed → resend Enter at most
   *  once per retry interval inside the REMAINING shared budget,
   *  verifying every poll — one monotonic deadline spans the whole
   *  submit phase (the initial window and every control call spend the
   *  same budget; nothing new starts at/past the deadline; a call
   *  already in flight only updates the last observation).
   *  Exhaustion → the evidence-based manual-fallback note and return (the
   *  caller still exits 0).  The text is never re-sent. */
  const verifiedSubmit = async (
    paneId: string,
    withText: string,
    prompt: string,
    landed: boolean,
    baseline: string,
  ): Promise<void> => {
    const { pollMs, submitTimeoutMs, submitRetryMs, submitRetryWindowMs } = knobs;
    const fragments = promptLandingFragments(prompt);
    let signature = screenBottom(withText, 3);
    /** Whether the sent text has been observed on screen.  False only
     *  after a land-confirm timeout; until a (late) landing is seen the
     *  box criterion is meaningless and stays unknown — the textless-
     *  snapshot cascade is structurally dead. */
    let hasLanded = landed;
    const start = clock();
    const deadline = start + submitRetryWindowMs;
    const probeField = (probe: ProbeResult): GiveUpProbeEvidence =>
      probe.dispatch === "unavailable" ? "unavailable" : probe.found ? "observed" : "failed";
    const evidence: SubmitEvidence = { transport: false, box: "unknown", probe: probeUnobserved() };

    // Degraded entry (land-confirm timed out): ONE rule — Enter is never
    // blind.  The textless screen may be a modal (a live reproduction
    // caught Enter confirming a trust dialog), so no Enter and no probe
    // fire until the TEXT ITSELF is observed.  Observe-only polls watch
    // for a late landing inside the SAME shared budget; the moment the
    // text appears, the live screen becomes the with-text baseline and
    // the landed path below takes over (informed Enter + verification).
    if (!hasLanded) {
      stderr(
        `launch: prompt text never appeared on ${paneId} — no Enter will be sent until the text is observed (the receiver may be showing a dialog); bounded wait within the ${submitRetryWindowMs}ms budget, then give-up\n`,
      );
      diag(`land-wait pane=${paneId} budget_ms=${submitRetryWindowMs}`);
      let waitIdx = 0;
      while (!hasLanded && clock() < deadline) {
        await sleep(Math.min(pollMs, deadline - clock()));
        if (clock() >= deadline) break; // budget spent: no new reads
        const latest = await client.readPane(paneId);
        const stripped = withoutDeliveryProbe(latest, [...probeMarkers], probeDialect);
        // SAME attribution rule as the immediate land loop: only a NEW
        // instance (occurrence count above the pre-send baseline) proves
        // THIS delivery — old scrollback/composer fragments never adopt.
        const matched = newLandingInstance(stripped, baseline, fragments);
        if (matched >= 0) {
          hasLanded = true;
          signature = screenBottom(stripped, 3);
          diag(`land-late pane=${paneId} phase=wait idx=${waitIdx} len=${latest.length} frag='${fragLabel(fragments[matched] ?? "")}' tail='${diagTail(latest)}'`);
        } else {
          diag(`read pane=${paneId} step=landwait idx=${waitIdx} len=${latest.length} box=unknown tail='${diagTail(latest)}'`);
        }
        waitIdx += 1;
      }
    }

    // Never observed the text → give up WITHOUT ever having touched the
    // receiver: honest reason, escalation seam unchanged (7.2.1 step 5).
    if (!hasLanded) {
      const elapsedMs = clock() - start;
      stderr(
        `launch: submit not confirmed on ${paneId} within ${submitRetryWindowMs}ms after 0 Enters — the prompt text was never observed on screen; no Enter was sent — inspect the pane: if the text is visible in the input box, press Enter there manually; if it is gone, re-deliver the prompt manually\n`,
      );
      diag(
        `give-up pane=${paneId} attempts=0 window_ms=${submitRetryWindowMs} box=unknown transport=false probe=unavailable elapsed_ms=${elapsedMs} budget_ms=${submitRetryWindowMs} reason=land-never-observed`,
      );
      try {
        await options.onGiveUp?.(paneId, { box: "unknown", transport: false, probe: "unavailable" });
      } catch {
        // Escalation is best-effort: a failed notify degrades to the stderr
        // diagnostics and the stall watchdog, never to a changed outcome.
      }
      return;
    }

    // Landed path (text observed at entry or adopted late): the wait above
    // may already have spent part of the shared budget — the deadline is
    // NEVER re-armed, only the initial observation window re-anchors.
    const submitStart = clock();
    let attempt = 1;
    if (submitStart >= deadline) {
      // Text seen but no budget left to Enter: the honest give-up speaks
      // from unknown and points at the pane (the text IS there).
      const elapsedMs = clock() - start;
      stderr(
        `launch: submit not confirmed on ${paneId} within ${submitRetryWindowMs}ms after 0 Enters — budget exhausted right after the text was observed; inspect the pane and press Enter there manually only if the prompt is still visible in the input box\n`,
      );
      diag(
        `give-up pane=${paneId} attempts=0 window_ms=${submitRetryWindowMs} box=unknown transport=false probe=unavailable elapsed_ms=${elapsedMs} budget_ms=${submitRetryWindowMs} reason=box-unknown`,
      );
      try {
        await options.onGiveUp?.(paneId, { box: "unknown", transport: false, probe: "unavailable" });
      } catch {
        // Escalation is best-effort, never a changed outcome.
      }
      return;
    }

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
    evidence.probe = await probeEnter(paneId, withText, attempt, "initial", deadline);

    /** One observation: read the screen, strip the probe overlay, derive
     *  the box evidence against the with-text baseline, emit the read
     *  line, decide confirmation — transport=true AND box=cleared, nothing
     *  else. */
    const observe = async (phase: "verify" | "loop", idx: number): Promise<boolean> => {
      const latest = await client.readPane(paneId);
      const stripped = withoutDeliveryProbe(latest, [...probeMarkers], probeDialect);
      evidence.box = boxState(stripped, signature);
      diag(
        `read pane=${paneId} step=${phase} idx=${idx} len=${latest.length} box=${evidence.box} probe=${probeField(evidence.probe)} tail='${diagTail(latest)}'`,
      );
      return evidence.transport && evidence.box === "cleared";
    };

    // Phase 1: the initial observation window, capped by the shared
    // deadline — never a budget of its own.
    const initialEnd = Math.min(submitStart + submitTimeoutMs, deadline);
    let idx = 0;
    for (;;) {
      const now = clock();
      if (now >= initialEnd) break;
      await sleep(Math.min(pollMs, initialEnd - now));
      if (clock() >= deadline) break; // budget spent: no new observation work
      if (await observe("verify", idx)) {
        diag(`submit-confirmed pane=${paneId} attempt=${attempt} phase=verify idx=${idx}`);
        return;
      }
      idx += 1;
    }

    // Loop entry: the evidence-based degradation note (only box=held may
    // say the prompt is still in the composer).
    const entryElapsed = clock() - start;
    if (evidence.box === "held") {
      stderr(
        `launch: input box still holds the text on ${paneId} after ${entryElapsed}ms — bounded Enter resend loop (interval ${submitRetryMs}ms, total budget ${submitRetryWindowMs}ms)\n`,
      );
    } else if (evidence.box === "cleared") {
      stderr(
        `launch: input box has released the text on ${paneId} but the initial Enter transport failed — do not press Enter blindly; continuing bounded verification (interval ${submitRetryMs}ms, total budget ${submitRetryWindowMs}ms)\n`,
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
      if (evidence.box === "cleared") {
        return `launch: resending Enter (attempt ${attemptNo}) on ${paneId} — unconfirmed: the text has left the input box (last Enter transport failed)\n`;
      }
      return `launch: resending Enter (attempt ${attemptNo}) on ${paneId} — unconfirmed: screen read unavailable\n`;
    };

    // Phase 2: clocked resends inside the REMAINING budget.  Every sleep
    // and side effect runs on the clock; at/past the deadline nothing new
    // starts.
    let lastEnterAt = submitStart;
    let step = 0;
    for (;;) {
      const now = clock();
      if (now >= deadline) break;
      await sleep(Math.min(pollMs, deadline - now));
      if (clock() >= deadline) break; // budget spent: no new reads, Enters, probes
      step += 1;
      if (await observe("loop", step)) {
        stderr(`launch: input box cleared on ${paneId} — submit confirmed (attempt ${attempt})\n`);
        diag(`submit-confirmed pane=${paneId} attempt=${attempt} phase=loop idx=${step}`);
        return;
      }
      if (clock() - lastEnterAt >= submitRetryMs && clock() < deadline) {
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
        evidence.probe = await probeEnter(paneId, withText, attempt, "loop", deadline);
        lastEnterAt = clock();
      }
    }

    // Give-up: still exit 0 (a failure exit would re-deliver the prompt),
    // the text was never re-sent, and the manual hint follows the last
    // evidence — never a blind "press Enter".
    const reason =
      evidence.box === "held" ? "box-held" : evidence.box === "cleared" ? "box-cleared-unconfirmed" : "box-unknown";
    const elapsedMs = clock() - start;
    const notConfirmed = `launch: submit not confirmed on ${paneId} within ${submitRetryWindowMs}ms after ${attempt} Enters — `;
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
      `give-up pane=${paneId} attempts=${attempt} window_ms=${submitRetryWindowMs} box=${evidence.box} transport=${evidence.transport} probe=${probeField(evidence.probe)} elapsed_ms=${elapsedMs} budget_ms=${submitRetryWindowMs} reason=${reason}`,
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
      await verifiedSubmit(input.paneId, land.screen, sentText, land.landed, baseline);
      return true;
    },
  };
}

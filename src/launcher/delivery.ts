/**
 * Readiness-gated prompt delivery and its decoupled diagnostics observer.
 *
 * Port of the legacy launch.sh delivery section (7.2.1 closed loop) and its known delivery-robustness lessons
 * historical baggage included: every degradation keeps going (only a send-text
 * failure is fatal), the text is never re-sent, Enter resends run on the
 * clock within a bounded window, and window exhaustion still reports success
 * so the caller cannot re-deliver a duplicated prompt.  The diagnostics are a
 * pure observer — one `tut-delivery t=<epoch-ms> …` line per delivery step to
 * stderr and, best-effort, to `<root>/.context-hub/delivery.log`; the switch
 * silences both sinks and no branch ever reads them back.
 *
 * This module never resolves routes or naming: it consumes the prompt frozen
 * in a LaunchInvocation.  All pane reads use the visible source (the `recent`
 * snapshots proved unreliable on freshly born panes); all control-plane calls
 * stay behind the caller's raw-argv client seam.
 */

import { statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

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

/**
 * Submit-confirmed predicate: a NON-EMPTY screen whose bottom region no
 * longer matches the with-text snapshot's region.  Repaints above the region
 * do not count; an empty read is a glitch and never confirms.  Degraded
 * note: when land-confirm timed out with an unpainted screen, the region
 * baseline is empty and any non-empty screen confirms — a known failure mode observed in live operations
 * false-positive window, kept behavior-equivalent by design (its fix is a
 * separate work unit).
 */
export function boxCleared(screen: string, signature: string): boolean {
  return screen.length > 0 && screenBottom(screen, 3) !== signature;
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

/** The env knobs of the delivery loop, parsed once per delivery. */
export interface DeliveryKnobs {
  /** Poll cadence shared by every loop step.  Minimum 1: a zero cadence
   *  would divide every poll-count window by zero (Infinity loops, or NaN
   *  from 0/0) — the parse clamps it so all windows stay finite. */
  pollMs: number;
  readyFloorMs: number;
  readyTimeoutMs: number;
  textLandTimeoutMs: number;
  submitTimeoutMs: number;
  /** Minimum 1 like the legacy poll-count clamp. */
  submitRetryMs: number;
  /** Minimum 1 like the legacy poll-count clamp. */
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

/** Polls a window allows, clamped to at least one (the submit windows). */
function pollsAtLeastOne(windowMs: number, pollMs: number): number {
  return Math.max(1, pollsOf(windowMs, pollMs));
}

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
export interface DeliveryClient {
  /** Visible-source read; "" on any failure (an empty read is a glitch). */
  readPane(paneId: string): Promise<string>;
  sendText(paneId: string, text: string): Promise<boolean>;
  sendKeys(paneId: string, key: string): Promise<boolean>;
}

export interface DeliveryOptions {
  client: DeliveryClient;
  diagnostics?: DeliveryDiagnostics;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  delayFn?: (ms: number) => Promise<void>;
  stderr?: (text: string) => void;
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
  const clock = options.clock ?? Date.now;
  const sleep = options.delayFn ?? delay;
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const diag = (fields: string): void => diagnostics?.emit(fields);

  /** Wait until the freshly born pane shows its receiver: output changed
   *  from the `pane run` baseline and stable for two consecutive polls, no
   *  earlier than the floor (in legacy poll-count arithmetic).  Timeout →
   *  deliver anyway (never worse). */
  const waitBornReady = async (paneId: string): Promise<string> => {
    const { pollMs, readyFloorMs, readyTimeoutMs } = knobs;
    const maxPolls = pollsOf(readyTimeoutMs, pollMs);
    const floorPolls = pollsOf(readyFloorMs, pollMs);
    diag(`gate-start pane=${paneId} floor_ms=${readyFloorMs} timeout_ms=${readyTimeoutMs}`);
    const baseline = await client.readPane(paneId);
    let previous = baseline;
    let latest = baseline;
    let idx = 0;
    while (idx < maxPolls) {
      await sleep(pollMs);
      latest = await client.readPane(paneId);
      if (latest.length > 0 && latest !== baseline && latest === previous && idx >= floorPolls) {
        diag(`gate-release pane=${paneId} idx=${idx} len=${latest.length} tail='${diagTail(latest)}'`);
        return latest;
      }
      diag(`read pane=${paneId} step=gate idx=${idx} len=${latest.length} tail='${diagTail(latest)}'`);
      previous = latest;
      idx += 1;
    }
    stderr(
      `launch: born pane ${paneId} not observed ready within ${maxPolls * pollMs}ms — delivering anyway (if the text idles in the input box, press Enter there)\n`,
    );
    diag(`gate-timeout pane=${paneId} idx=${idx} len=${latest.length}`);
    return latest;
  };

  /** Poll the screen against the pre-send snapshot until it CHANGES — the
   *  text has rendered in the receiver's input box.  Timeout → note and
   *  submit anyway; this step's output is the submit baseline. */
  const confirmTextLanded = async (paneId: string, baseline: string): Promise<string> => {
    const { pollMs, textLandTimeoutMs } = knobs;
    const maxPolls = pollsOf(textLandTimeoutMs, pollMs);
    diag(`land-start pane=${paneId} timeout_ms=${textLandTimeoutMs}`);
    let latest = baseline;
    let idx = 0;
    while (idx < maxPolls) {
      await sleep(pollMs);
      latest = await client.readPane(paneId);
      if (latest.length > 0 && latest !== baseline) {
        diag(`land-observed pane=${paneId} idx=${idx} len=${latest.length} tail='${diagTail(latest)}'`);
        return latest;
      }
      diag(`read pane=${paneId} step=land idx=${idx} len=${latest.length} tail='${diagTail(latest)}'`);
      idx += 1;
    }
    stderr(
      `launch: text landing not observed on ${paneId} within ${textLandTimeoutMs}ms — submitting anyway (if the text idles in the input box, press Enter there)\n`,
    );
    diag(`land-timeout pane=${paneId} idx=${idx} len=${latest.length}`);
    return latest;
  };

  /** Phase 1: ONE Enter, then verify by the cleared-box criterion.  Phase 2:
   *  the box still holds the text → resend Enter at most once per retry
   *  interval within the bounded window, verifying every poll — the resend
   *  runs on the clock (the swallow window can outlive the idle readiness
   *  signal) and only the box letting go of the text confirms.  Exhaustion →
   *  manual-fallback note and return (the caller still exits 0).  The text
   *  is never re-sent. */
  const verifiedSubmit = async (paneId: string, withText: string): Promise<void> => {
    const { pollMs, submitTimeoutMs, submitRetryMs, submitRetryWindowMs } = knobs;
    const maxPolls = pollsAtLeastOne(submitTimeoutMs, pollMs);
    const retryPolls = pollsAtLeastOne(submitRetryMs, pollMs);
    const windowPolls = pollsAtLeastOne(submitRetryWindowMs, pollMs);
    const signature = screenBottom(withText, 3);
    let attempt = 1;
    let sinceEnter = 0;
    diag(
      `submit pane=${paneId} phase=initial attempt=1 verify_ms=${submitTimeoutMs} retry_ms=${submitRetryMs} window_ms=${submitRetryWindowMs}`,
    );
    if (!(await client.sendKeys(paneId, "Enter"))) {
      stderr(`launch: herdr pane send-keys ${paneId} Enter failed (initial attempt)\n`);
    }
    diag(`enter pane=${paneId} attempt=1 phase=initial`);

    let idx = 0;
    while (idx < maxPolls) {
      await sleep(pollMs);
      sinceEnter += 1;
      const latest = await client.readPane(paneId);
      if (boxCleared(latest, signature)) {
        diag(`submit-confirmed pane=${paneId} attempt=${attempt} phase=verify idx=${idx}`);
        return;
      }
      diag(`read pane=${paneId} step=verify idx=${idx} len=${latest.length} box=held tail='${diagTail(latest)}'`);
      idx += 1;
    }

    stderr(
      `launch: input box still holds the text on ${paneId} after ${submitTimeoutMs}ms — bounded Enter resend loop (interval ${submitRetryMs}ms, window ${submitRetryWindowMs}ms)\n`,
    );
    diag(`loop-start pane=${paneId} attempts=${attempt} interval_ms=${submitRetryMs} window_ms=${submitRetryWindowMs}`);
    let step = 0;
    while (step < windowPolls) {
      await sleep(pollMs);
      sinceEnter += 1;
      step += 1;
      const latest = await client.readPane(paneId);
      if (boxCleared(latest, signature)) {
        stderr(`launch: input box cleared on ${paneId} — submit confirmed (attempt ${attempt})\n`);
        diag(`submit-confirmed pane=${paneId} attempt=${attempt} phase=loop idx=${step}`);
        return;
      }
      diag(`read pane=${paneId} step=loop idx=${step} len=${latest.length} box=held tail='${diagTail(latest)}'`);
      if (sinceEnter >= retryPolls) {
        attempt += 1;
        sinceEnter = 0;
        if (!(await client.sendKeys(paneId, "Enter"))) {
          stderr(`launch: herdr pane send-keys ${paneId} Enter failed (attempt ${attempt})\n`);
        }
        stderr(`launch: resending Enter (attempt ${attempt}) on ${paneId} — box still holds the text\n`);
        diag(`enter pane=${paneId} attempt=${attempt} phase=loop resend`);
      }
    }
    stderr(
      `launch: submit not confirmed on ${paneId} within ${submitRetryWindowMs}ms after ${attempt} Enters — the prompt sits in the input box; press Enter there manually to start the round\n`,
    );
    diag(`give-up pane=${paneId} attempts=${attempt} window_ms=${submitRetryWindowMs}`);
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
      const sent = await client.sendText(input.paneId, input.prompt);
      if (!sent) {
        stderr(`launch: herdr pane send-text ${input.paneId} failed\n`);
        return false;
      }
      diag(`send-text pane=${input.paneId} branch=${input.branch} len=${input.prompt.length}`);
      const withText = await confirmTextLanded(input.paneId, baseline);
      await verifiedSubmit(input.paneId, withText);
      return true;
    },
  };
}

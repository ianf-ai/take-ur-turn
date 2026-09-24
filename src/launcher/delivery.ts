/** Single attempt delivery. Status observation cannot establish input consumption. */
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentStatus, CallContext, DeliveryClientV2, GiveUpReason, PaneIdentity, ReadFault, SendResult, StatusSample, TransportFault } from "./herdr-client-v2.js";

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
      try { stderr(`tut-delivery t=${now} ${fields}\n`); } catch { /* diagnostics only */ }
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

/** Remediation is an audit trail, not optional delivery diagnostics. */
export function createRemediationAudit(options: DeliveryDiagnosticsOptions = {}): DeliveryDiagnostics {
  return createDeliveryDiagnostics({ ...options,
    env: { ...(options.env ?? process.env), TUT_DELIVERY_DIAG: "1" } });
}

export type DeliveryOutcome =
  | { kind: 'not-sent'; exitCode: 1; retry: 'inspect-first'; reason: 'text-not-sent' | 'delivery-budget-unavailable'; text: 'not-sent'; enter: 'not-attempted' }
  | { kind: 'unconfirmed'; exitCode: 0; retry: 'forbidden'; reason: GiveUpReason; text: 'not-sent' | 'sent' | 'uncertain'; enter: 'not-attempted' | 'sent' | 'not-sent' | 'uncertain' };

/** Hash only the normalized tail: diagnostics must never disclose prompt text. */
export function promptTailEvidence(prompt: string): { sha256: string; length: number } {
  const tail = prompt.replace(/\s/gu, '').slice(-80);
  return { sha256: createHash('sha256').update(tail).digest('hex'), length: tail.length };
}

export const BASELINE_READINESS_MS = 90_000;

export interface DeliveryEvidenceV2 {
  /** Present after baseline readiness waiting (unknown or born-working). */
  baseline_wait?: { budget_ms: number; elapsed_ms: number };
  remediation?: import('../remediator.js').RemediationEvidence;
  target?: PaneIdentity;
  prompt_tail?: { sha256: string; length: number };
  schema: 2;
  attempt_id: string;
  pane_id: string;
  reason: GiveUpReason;
  status_before: AgentStatus;
  status_last: AgentStatus;
  status_error: ReadFault | null;
  status_flip: boolean;
  submit_confirmed: false;
  attribution: 'unavailable';
  text_transport: 'not-sent' | 'sent' | 'uncertain';
  text_error: TransportFault | null;
  enter_error: TransportFault | null;
  enter_transport: 'not-attempted' | 'sent' | 'not-sent' | 'uncertain';
  text_calls: 0 | 1;
  enter_calls: 0 | 1;
  budget_ms: number;
  elapsed_ms: number | null;
  total_elapsed_ms: number;
  last_query_sequence: number | null;
  detector_source: null;
  detector_age_ms: null;
  server_epoch: null;
  agent_generation: null;
}

export interface DeliveryKnobs { readyMs: number; flipMs: number; pollMs: number; callMs: number }
export function parseDeliveryKnobs(env: NodeJS.ProcessEnv, warn: (text: string) => void = () => undefined): DeliveryKnobs {
  const integer = (key: string, fallback: number, max: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const n = /^\d+$/u.test(raw) ? Number(raw) : NaN;
    if (Number.isSafeInteger(n) && n >= 1 && n <= max) return n;
    warn(`invalid ${key}; using ${fallback}ms`);
    return fallback;
  };
  const flipMs = integer('TUT_STATUS_FLIP_TIMEOUT_MS', 30_000, 60_000);
  return { readyMs: integer('TUT_BASELINE_READY_TIMEOUT_MS', BASELINE_READINESS_MS, Number.MAX_SAFE_INTEGER), flipMs, pollMs: integer('TUT_STATUS_POLL_MS', Math.min(250, flipMs), flipMs),
    callMs: Math.min(integer('TUT_HERDR_TIMEOUT_MS', 10_000, Number.MAX_SAFE_INTEGER), 10_000) };
}

/** Bounded observer cleanup, including a callback that never settles. */
export async function boundedCleanup(action: () => Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(action).catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
  } finally { clearTimeout(timer); }
}

/** Shared bounded observation cadence for delivery confirmation. Callers validate samples before accepting them. */
export async function* deliveryStatusWindow<T>(options: {
  deadline: number; pollMs: number; now(): number; signal: AbortSignal;
  read(deadline: number): Promise<T>; sleep?: ((ms: number) => Promise<void>) | undefined;
}): AsyncGenerator<T> {
  while (!options.signal.aborted && options.now() < options.deadline) {
    yield await options.read(options.deadline);
    const remaining = options.deadline - options.now();
    if (remaining <= 0 || options.signal.aborted) break;
    const ms = Math.min(options.pollMs, remaining);
    if (options.sleep) await options.sleep(ms);
    else await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      options.signal.addEventListener('abort', done, { once: true });
      if (options.signal.aborted) done();
    });
  }
}

export interface DeliveryOptions {
  /** Disabled preserves the historical evidence bytes. */
  remediationEvidence?: boolean;
  client: DeliveryClientV2;
  env?: NodeJS.ProcessEnv;
  diagnostics?: DeliveryDiagnostics;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** The 170s launcher deadline, started before planning/birth. */
  deadlineMonoMs?: number;
  onGiveUp?: (paneId: string, evidence: Readonly<DeliveryEvidenceV2>) => Promise<void>;
  stderr?: (text: string) => void;
}
export interface DeliverPromptInput { target: PaneIdentity; prompt: string; branch: 'born' | 'continuation' }
export interface Delivery { deliver(input: DeliverPromptInput): Promise<DeliveryOutcome> }

export function createDelivery(options: DeliveryOptions): Delivery {
  const now = options.now ?? (() => performance.now());
  const emit = (text: string) => { try { options.diagnostics?.emit(text); } catch { /* observer only */ } };
  const write = (text: string) => { try { (options.stderr ?? (s => { process.stderr.write(s); }))(text); } catch { /* observer only */ } };
  const knobs = parseDeliveryKnobs({ ...(options.env ?? process.env) }, message => write(`launch: ${message}\n`));
  return { async deliver(input) {
    const start = now();
    const totalDeadline = options.deadlineMonoMs ?? start + 170_000;
    const target = Object.freeze({ ...input.target, agentSession: input.target.agentSession === null ? null : Object.freeze({ ...input.target.agentSession }) });
    const prompt = input.prompt;
    const attemptId = randomUUID();
    const signal = options.signal ?? new AbortController().signal;
    let sequence = 0;
    let t0: number | null = null;
    let text: SendResult['kind'] = 'not-sent';
    let textCalls: 0 | 1 = 0;
    let waitStart: number | undefined;
    let waitBudget = 0;
    let waitElapsed: number | undefined;
    let enter: DeliveryEvidenceV2['enter_transport'] = 'not-attempted';
    let textError: TransportFault | null = null;
    let enterError: TransportFault | null = null;
    let evidenceTarget = target;
    let baseline: AgentStatus = 'unknown';
    let last: AgentStatus = 'unknown';
    let statusError: ReadFault | null = null;
    let lastSequence: number | null = null;
    let flip = false;
    let terminal: DeliveryOutcome | undefined;
    const notSent = (reason: 'text-not-sent' | 'delivery-budget-unavailable'): DeliveryOutcome =>
      terminal ??= { kind: 'not-sent', exitCode: 1, retry: 'inspect-first', reason, text: 'not-sent', enter: 'not-attempted' };
    const finish = async (reason: GiveUpReason, finished = now()): Promise<DeliveryOutcome> => {
      if (terminal) return terminal;
      const sentText = text;
      terminal = Object.freeze({ kind: 'unconfirmed', exitCode: 0, retry: 'forbidden', reason, text: sentText, enter });
      const evidence: Readonly<DeliveryEvidenceV2> = Object.freeze({
        ...(options.remediationEvidence ? { target: evidenceTarget, prompt_tail: promptTailEvidence(prompt) } : {}),
        ...(waitStart === undefined ? {} : { baseline_wait: Object.freeze({ budget_ms: waitBudget,
          elapsed_ms: waitElapsed ?? Math.max(0, finished - waitStart) }) }),
        schema: 2, attempt_id: attemptId, pane_id: target.paneId, reason,
        status_before: baseline, status_last: last, status_error: statusError, status_flip: flip,
        submit_confirmed: false, attribution: 'unavailable', text_transport: sentText, text_error: textError,
        enter_transport: enter, enter_error: enterError, text_calls: textCalls, enter_calls: enter === 'not-attempted' ? 0 : 1,
        budget_ms: knobs.flipMs, elapsed_ms: enter === 'not-attempted' || t0 === null ? null : Math.max(0, finished - t0),
        total_elapsed_ms: Math.max(0, finished - start), last_query_sequence: lastSequence,
        detector_source: null, detector_age_ms: null, server_epoch: null, agent_generation: null,
      });
      if (flip) emit(`working-observed pane=${target.paneId} sequence=${lastSequence} attribution=unavailable`);
      emit(`give-up pane=${target.paneId} delivery_v2=${JSON.stringify(evidence)}`);
      write(`launch: delivery unconfirmed (${reason}); inspect the target pane and outstanding control calls before manual action; do not blindly press Enter or automatically resend.\n`);
      if (options.onGiveUp) await boundedCleanup(async () => {
        try { await options.onGiveUp!(target.paneId, evidence); }
        catch { write('launch: delivery give-up escalation failed; inspect the pane manually\n'); }
      }, 2000);
      return terminal;
    };
    const call = (deadline: number): CallContext => ({ attemptId, sequence: ++sequence,
      deadlineMonoMs: Math.min(deadline, now() + knobs.callMs), signal });
    const stopped = () => signal.aborted || now() >= totalDeadline;
    const send = async (kind: 'text' | 'enter', ctx: CallContext): Promise<SendResult> => {
      let result: SendResult;
      try { result = await (kind === 'text' ? options.client.sendText(target, prompt, ctx) : options.client.sendEnter(target, ctx)); }
      catch {
        result = { kind: 'uncertain', trace: { attemptId, sequence: ctx.sequence, startedMonoMs: now(), finishedMonoMs: now(), spawned: false, exitCode: null, signal: null, fault: 'INTERNAL' } };
      }
      if (result.trace.attemptId !== attemptId || result.trace.sequence !== ctx.sequence) {
        result = { kind: 'uncertain', trace: { ...result.trace, fault: 'INTERNAL' } };
      }
      // A proven no-spawn result remains not-sent; every other late result is uncertain.
      if (result.kind !== 'not-sent' && (signal.aborted || now() >= ctx.deadlineMonoMs || result.trace.finishedMonoMs >= ctx.deadlineMonoMs)) {
        result = { kind: 'uncertain', trace: { ...result.trace, fault: signal.aborted ? 'ABORTED' : 'TIMEOUT' } };
      }
      return result;
    };
    const read = async (deadline: number, phase: string): Promise<StatusSample> => {
      const ctx = call(deadline);
      let sample: StatusSample;
      try { sample = await options.client.readAgentStatus(target, ctx); }
      catch {
        sample = { ...ctx, startedMonoMs: now(), finishedMonoMs: now(), status: 'unknown', identity: null, paneRevision: null,
          error: 'INTERNAL', readSource: 'herdr-pane-list', detectorSource: null, detectorAgeMs: null, attribution: 'unavailable' };
      }
      if (signal.aborted) sample = { ...sample, status: 'unknown', error: 'ABORTED' };
      else if (now() >= ctx.deadlineMonoMs || sample.finishedMonoMs >= ctx.deadlineMonoMs || sample.startedMonoMs >= ctx.deadlineMonoMs)
        sample = { ...sample, status: 'unknown', error: 'LATE_RESULT' };
      else if (sample.attemptId !== attemptId || sample.sequence !== ctx.sequence)
        sample = { ...sample, status: 'unknown', error: 'WRONG_SEQUENCE' };
      // Late data never overwrites the last accepted observation.
      if (sample.error !== 'LATE_RESULT' && sample.error !== 'ABORTED' && sample.error !== 'WRONG_SEQUENCE') {
        last = sample.error === null ? sample.status : 'unknown'; statusError = sample.error; lastSequence = ctx.sequence;
      }
      if (phase !== 'baseline-wait') emit(`${phase} pane=${target.paneId} sequence=${ctx.sequence} started=${sample.startedMonoMs} finished=${sample.finishedMonoMs} status=${sample.status} error=${sample.error} identity=${JSON.stringify(sample.identity)} source=herdr-pane-list detector_source=null detector_age_ms=null`);
      return sample;
    };
    const invalidIdentity = (sample: StatusSample) => ['PANE_MISSING', 'PANE_DUPLICATE', 'IDENTITY_CHANGED'].includes(sample.error ?? '');
    if (stopped() || totalDeadline - now() < 2 * knobs.callMs + knobs.flipMs + 4000) return notSent('delivery-budget-unavailable');
    const readinessDeadline = Math.min(now() + knobs.readyMs, totalDeadline);
    let settling = false;
    let ready = false;
    for await (const before of deliveryStatusWindow({ deadline: readinessDeadline, pollMs: knobs.pollMs, now, signal,
      read: d => read(d, waitStart === undefined ? 'status-before' : 'baseline-wait'), sleep: options.sleep })) {
      if (signal.aborted) return finish('cancelled');
      if (invalidIdentity(before)) return finish('identity-invalid');
      baseline = before.error === null ? before.status : 'unknown';
      if (before.error === null && before.identity) evidenceTarget = before.identity;
      if (input.branch === 'born' && baseline === 'working') settling = true;
      if (baseline !== 'unknown' && (!settling || baseline === 'idle')) {
        ready = true;
        if (waitStart !== undefined) emit(`baseline-ready pane=${target.paneId} branch=${input.branch} status=${baseline}`);
        break;
      }
      if (waitStart === undefined) {
        waitStart = start;
        waitBudget = Math.max(0, readinessDeadline - start);
        emit(`baseline-wait-start pane=${target.paneId} branch=${input.branch} status=${baseline} budget_ms=${waitBudget}`);
      }
    }
    if (waitStart !== undefined) waitElapsed = Math.max(0, now() - waitStart);
    if (signal.aborted) return finish('cancelled');
    if (!ready) {
      // baseline reflects the final probe, including invalid samples. Never
      // revive an older working observation to authorize timeout delivery.
      const budgetUnavailable = stopped() || totalDeadline - now() < 2 * knobs.callMs + knobs.flipMs + 4000;
      const action = baseline === 'unknown' ? 'not-sent' : budgetUnavailable ? 'deadline' : 'fallback';
      emit(`baseline-wait-exhausted pane=${target.paneId} branch=${input.branch} status=${baseline} action=${action} elapsed_ms=${waitElapsed}`);
    }
    if (baseline === 'unknown') {
      return finish('baseline-unknown');
    }
    if (stopped() || totalDeadline - now() < 2 * knobs.callMs + knobs.flipMs + 4000) return finish('deadline');
    // Start the observation budget only after readiness releases the baseline.
    // Keep the working-baseline single-send/single-Enter terminal path intact.
    if (baseline !== 'working') t0 = now();
    const sendDeadline = t0 === null ? totalDeadline : Math.min(t0 + knobs.flipMs, totalDeadline);
    textCalls = 1;
    const sent = await send('text', call(sendDeadline));
    text = sent.kind; textError = sent.kind === 'sent' ? null : sent.trace.fault ?? 'INTERNAL';
    emit(`send-text pane=${target.paneId} transport=${text} error=${textError}`);
    if (text === 'not-sent') return notSent('text-not-sent');
    // text-uncertain retains the uncertain transport contract even when cancelled.
    if (text === 'uncertain') return finish('text-uncertain');
    if (stopped()) return finish(signal.aborted ? 'cancelled' : 'deadline');
    t0 ??= now();
    const deadline = Math.min(t0 + knobs.flipMs, totalDeadline);
    const entered = await send('enter', call(deadline));
    enter = entered.kind; enterError = enter === 'sent' ? null : entered.trace.fault ?? 'INTERNAL';
    emit(`enter pane=${target.paneId} transport=${enter} error=${enterError}`);
    if (signal.aborted) return finish('cancelled');
    if (enter !== 'sent') return finish(enter === 'not-sent' ? 'enter-not-sent' : 'enter-uncertain');
    if (baseline === 'working') return finish('baseline-working');
    let knownPost = false;
    for await (const sample of deliveryStatusWindow({ deadline, pollMs: knobs.pollMs, now, signal,
      read: d => read(d, 'status-observed'), sleep: options.sleep })) {
      if (signal.aborted) return finish('cancelled');
      const observedAt = now();
      if (observedAt >= deadline) break;
      if (invalidIdentity(sample)) return finish('identity-invalid');
      if (sample.error === null && sample.status !== 'unknown') {
        knownPost = true;
        if (sample.status === 'working') {
          flip = true;
          return finish('attribution-unavailable', observedAt);
        }
      }
    }
    return finish(signal.aborted ? 'cancelled' : knownPost ? 'deadline' : 'status-unavailable');
  } };
}

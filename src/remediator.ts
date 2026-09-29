/** Controlled, one-shot recovery. A status flip is observation, not consumption proof. */
import { createHerdrClient } from './launcher/legacy-herdr-client.js';
import { parseDeliveryV2 } from './launcher/escalation.js';
import { deliveryStatusWindow, parseDeliveryKnobs, promptTailEvidence, type DeliveryEvidenceV2 } from './launcher/delivery.js';
import type { CallContext, DeliveryClientV2, PaneIdentity, StatusSample } from './launcher/herdr-client-v2.js';

export const MAX_REMEDIATION_ATTEMPTS = 4096;
export const MAX_CONCURRENT_REMEDIATIONS = 64;

/** Never evict dedup evidence: once full, new attempts escalate without acting. */
export class RemediationAttempts {
  private readonly ids = new Set<string>();
  claim(id: string): 'new' | 'duplicate' | 'full' {
    if (this.ids.has(id)) return 'duplicate';
    if (this.ids.size >= MAX_REMEDIATION_ATTEMPTS) return 'full';
    this.ids.add(id);
    return 'new';
  }
}

export interface RemediationRequest {
  agent: string;
  pane: string;
  evidence: unknown;
  /** Recheck lifecycle/config after asynchronous preflight. */
  canAct(): boolean | Promise<boolean>;
  /** Append action evidence before issuing the control call. */
  recordAction?(evidence: RemediationEvidence): Promise<void>;
}
export interface RemediationEvidence {
  strategy: string;
  action: 'none' | 'machine-enter';
  result: 'skipped' | 'attempting' | 'working-observed' | 'give-up';
  enter_transport: 'not-attempted' | 'sent' | 'not-sent' | 'uncertain';
  status_flip: boolean;
  attribution: 'machine-remediation' | 'unavailable';
  reason: string;
  /** Accepted staging evidence; a viewport match alone never authorizes input. */
  staged_basis?: 'text-transport-sent' | 'codex-input-tail';
  reevaluated?: true;
}
export interface Remediator {
  remediate(request: RemediationRequest): Promise<RemediationEvidence>;
}
export interface EnterRepressOptions {
  client?: Pick<DeliveryClientV2, 'readAgentStatus' | 'sendEnter'>;
  /** Visible viewport; used only for the conservative Codex reevaluation gate. */
  readPane?: (id: string) => Promise<string>;
  matchesPane?: (id: string, label: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  stderr?: (text: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function targetOf(e: DeliveryEvidenceV2, agent: string): PaneIdentity | undefined {
  const t = e.target;
  if (!t || t.paneId !== e.pane_id ||
      (t.agentSession !== null && (!t.agentSession || t.agentSession.agent !== agent ||
        !['kind', 'value'].every(k => typeof t.agentSession?.[k as 'kind' | 'value'] === 'string' && t.agentSession[k as 'kind' | 'value'].length > 0))) ||
      ![t.terminalId, t.workspaceId].every(v => v === null || (typeof v === 'string' && v.length > 0))) return undefined;
  // Herdr may omit sessions; pane label and fresh classifiable status are checked before acting.
  return t;
}
const nonworking = (s: string) => ['idle', 'blocked', 'done'].includes(s);

/** Inspect only the last Codex composer, never a matching historical prompt. */
export function pendingCodexInput(screen: string, tail: DeliveryEvidenceV2['prompt_tail']): boolean {
  if (!tail || tail.length < 1 || tail.length > 80 || !/^[a-f0-9]{64}$/.test(tail.sha256)) return false;
  const lines = screen.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^› /u.test(lines[i]!)) start = i;
  if (start < 0) return false;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.trim() === '');
  if (end < 0) return false;
  const footer = rest.slice(end).filter(line => line.trim() !== '');
  // Anything between the candidate input and footer could be a response to
  // an already consumed historical prompt, so reject the whole snapshot.
  if (!footer.length || !footer.every(line => /^ {2}\? for shortcuts\b/u.test(line) || /^ {2}GPT-\S+.* · \S/u.test(line))) return false;
  const input = [lines[start]!.slice(2), ...rest.slice(0, end)].join('\n');
  const actual = promptTailEvidence(input);
  return actual.length === tail.length && actual.sha256 === tail.sha256;
}

export function createEnterRepress(options: EnterRepressOptions = {}): Remediator {
  const knobs = parseDeliveryKnobs(options.env ?? process.env, message => {
    try { (options.stderr ?? (text => { process.stderr.write(text); }))(`enter-repress: ${message}\n`); } catch { /* diagnostics only */ }
  });
  const herdr = createHerdrClient({ timeoutMs: knobs.callMs });
  const client = options.client ?? herdr.deliveryV2;
  const readPane = options.readPane ?? (id => herdr.readPane(id, { source: 'visible', lines: 80 }));
  const matchesPane = options.matchesPane ?? (async (id, label) => {
    const rows = (await herdr.listPanes()).panes.filter(p => p.pane_id === id);
    return rows.length === 1 && rows[0]!.label === label;
  });
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const used = new RemediationAttempts();
  const writeError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    try { (options.stderr ?? (text => { process.stderr.write(text); }))(`enter-repress: ${message}\n`); } catch { /* observer only */ }
    return message;
  };
  const busy = new Set<string>();
  return { async remediate(request) {
    const result: RemediationEvidence = { strategy: 'enter-repress', action: 'none', result: 'skipped',
      enter_transport: 'not-attempted', status_flip: false, attribution: 'unavailable', reason: 'evidence-insufficient' };
    const e = parseDeliveryV2(request.evidence);
    const unknownBaseline = e?.reason === 'baseline-unknown' && e.status_before === 'unknown';
    const reevaluate = e?.reason === 'attribution-unavailable' && e.status_flip && e.status_last === 'working' &&
      nonworking(e.status_before) && request.agent === 'codex';
    if (!e || (!reevaluate && !unknownBaseline && (e.reason !== 'deadline' || !nonworking(e.status_before) || !nonworking(e.status_last))) ||
        (!reevaluate && e.status_flip) || (!unknownBaseline && e.status_error !== null) ||
        ['PANE_MISSING', 'PANE_DUPLICATE', 'IDENTITY_CHANGED'].includes(e.status_error ?? '') ||
        e.text_transport !== 'sent' || e.enter_transport !== 'sent' ||
        e.text_error !== null || e.enter_error !== null || e.enter_calls !== 1 || e.last_query_sequence === null) return result;
    const target = targetOf(e, request.agent);
    if (!target || busy.has(e.pane_id)) return result;
    if (busy.size >= MAX_CONCURRENT_REMEDIATIONS) return { ...result, reason: 'concurrency-limit' };
    const claim = used.claim(e.attempt_id);
    if (claim !== 'new') return { ...result, reason: claim === 'full' ? 'attempt-capacity' : 'duplicate-attempt' };
    busy.add(e.pane_id);
    const controller = new AbortController();
    let sequence = 0;
    const call = (deadline = now() + knobs.callMs): CallContext => ({ attemptId: e.attempt_id, sequence: ++sequence,
      deadlineMonoMs: Math.min(deadline, now() + knobs.callMs), signal: controller.signal });
    let lastReadError: string | undefined;
    const read = async (deadline?: number): Promise<StatusSample | undefined> => {
      const ctx = call(deadline);
      let s: StatusSample;
      try { s = await client.readAgentStatus(target, ctx); }
      catch (error) { lastReadError = writeError(error); return undefined; }
      if (s.attemptId !== ctx.attemptId || s.sequence !== ctx.sequence ||
          now() >= ctx.deadlineMonoMs || s.finishedMonoMs >= ctx.deadlineMonoMs || s.startedMonoMs >= ctx.deadlineMonoMs) return undefined;
      if (s.error === null && (!s.identity || JSON.stringify(s.identity) !== JSON.stringify(target)))
        s = { ...s, status: 'unknown', error: 'IDENTITY_CHANGED' };
      if (s.error !== null) lastReadError = s.error;
      return s;
    };
    try {
      if (reevaluate) {
        // A historical working observation still vetoes an immediate key. Keep
        // the same attempt claim while collecting independent current evidence.
        await request.recordAction?.({ ...result });
        result.reevaluated = true;
        const deadline = now() + knobs.readyMs;
        let idleSince: number | undefined;
        let idleSamples = 0;
        let ready = false;
        for await (const sample of deliveryStatusWindow({ deadline, pollMs: knobs.pollMs, now,
          signal: controller.signal, read, sleep })) {
          if (!await request.canAct()) return { ...result, reason: 'lifecycle-changed' };
          if (now() >= deadline) break;
          if (sample && ['PANE_MISSING', 'PANE_DUPLICATE', 'IDENTITY_CHANGED'].includes(sample.error ?? ''))
            return { ...result, reason: `identity-invalid: ${sample.error}` };
          if (sample?.error !== null || sample.status !== 'idle') {
            idleSince = undefined; idleSamples = 0; continue;
          }
          idleSince ??= now();
          if (++idleSamples < 3 || now() - idleSince < 2000) continue;
          if (!await matchesPane(target.paneId, request.pane)) return { ...result, reason: 'pane-mismatch' };
          if (!pendingCodexInput(await readPane(target.paneId), e.prompt_tail)) continue;
          if (now() >= deadline) break;
          ready = true; break;
        }
        if (!ready) return { ...result, result: 'give-up', reason: 'reevaluation-deadline' };
      }
      if (unknownBaseline) {
        const deadline = now() + knobs.readyMs;
        let ready = false;
        for await (const sample of deliveryStatusWindow({ deadline, pollMs: knobs.pollMs, now,
          signal: controller.signal, read, sleep })) {
          if (!await request.canAct()) return { ...result, reason: 'lifecycle-changed' };
          if (now() >= deadline) break;
          if (sample && ['PANE_MISSING', 'PANE_DUPLICATE', 'IDENTITY_CHANGED'].includes(sample.error ?? ''))
            return { ...result, reason: `identity-invalid: ${sample.error}` };
          if (sample?.error === null && sample.status !== 'unknown') { ready = true; break; }
        }
        if (!ready) return { ...result, result: 'give-up', reason: 'baseline-unknown' };
      }
      if (!await request.canAct() || !await matchesPane(target.paneId, request.pane)) return { ...result, reason: 'pane-mismatch' };
      // The retry path requires both original sent transport and current input.
      result.staged_basis = reevaluate ? 'codex-input-tail' : 'text-transport-sent';
      if (reevaluate && !pendingCodexInput(await readPane(target.paneId), e.prompt_tail))
        return { ...result, reason: 'input-changed' };
      const before = await read();
      if (!before || before.error !== null || !(reevaluate ? before.status === 'idle' : nonworking(before.status)) || !await request.canAct()) return { ...result, reason: `status-or-lifecycle-changed${lastReadError ? `: ${lastReadError}` : ''}` };
      await request.recordAction?.({ ...result, action: 'machine-enter', result: 'attempting', reason: '机器代按 Enter' });
      if (reevaluate) {
        const final = await read();
        if (!final || final.error !== null || final.status !== 'idle') return { ...result, reason: 'status-changed' };
      }
      if (!await request.canAct()) return { ...result, reason: 'lifecycle-changed' };
      result.action = 'machine-enter'; result.result = 'give-up'; result.reason = 'deadline';
      const deadline = now() + knobs.flipMs;
      const ctx = call(deadline);
      const sent = await client.sendEnter(target, ctx);
      result.enter_transport = sent.kind;
      if (sent.trace.attemptId !== ctx.attemptId || sent.trace.sequence !== ctx.sequence ||
          now() >= ctx.deadlineMonoMs || sent.trace.finishedMonoMs >= ctx.deadlineMonoMs) result.enter_transport = 'uncertain';
      if (result.enter_transport !== 'sent') return { ...result, reason: 'enter-unconfirmed' };
      let knownPost = false;
      for await (const sample of deliveryStatusWindow({ deadline, pollMs: knobs.pollMs, now,
        signal: controller.signal, read, sleep })) {
        if (sample?.error === null && sample.status === 'working') return { ...result, result: 'working-observed', status_flip: true,
          attribution: 'machine-remediation', reason: 'working-observed' };
        if (!await request.canAct()) return { ...result, reason: 'lifecycle-changed' };
        if (sample && ['PANE_MISSING', 'PANE_DUPLICATE', 'IDENTITY_CHANGED'].includes(sample.error ?? ''))
          return { ...result, reason: `identity-invalid: ${sample.error}` };
        if (sample?.error === null && sample.status !== 'unknown') knownPost = true;
      }
      return { ...result, reason: knownPost ? 'deadline' : `status-unavailable${lastReadError ? `: ${lastReadError}` : ''}` };
    } catch (error) {
      if (result.action === 'machine-enter' && result.enter_transport === 'not-attempted') result.enter_transport = 'uncertain';
      return { ...result, reason: `control-error: ${writeError(error)}` };
    } finally {
      controller.abort();
      busy.delete(e.pane_id);
    }
  } };
}

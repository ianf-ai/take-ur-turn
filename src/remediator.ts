/** Controlled, one-shot recovery. A status flip is observation, not consumption proof. */
import { createHerdrClient } from './launcher/legacy-herdr-client.js';
import { parseDeliveryV2 } from './launcher/escalation.js';
import { deliveryStatusWindow, parseDeliveryKnobs, type DeliveryEvidenceV2 } from './launcher/delivery.js';
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
  /** Gate ② accepted explicit text delivery transport evidence. */
  staged_basis?: 'text-transport-sent';
}
export interface Remediator {
  remediate(request: RemediationRequest): Promise<RemediationEvidence>;
}
export interface EnterRepressOptions {
  client?: Pick<DeliveryClientV2, 'readAgentStatus' | 'sendEnter'>;
  /** @deprecated Retained for compatibility; screen content no longer authorizes remediation. */
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

export function createEnterRepress(options: EnterRepressOptions = {}): Remediator {
  const knobs = parseDeliveryKnobs(options.env ?? process.env, message => {
    try { (options.stderr ?? (text => { process.stderr.write(text); }))(`enter-repress: ${message}\n`); } catch { /* diagnostics only */ }
  });
  const herdr = createHerdrClient({ timeoutMs: knobs.callMs });
  const client = options.client ?? herdr.deliveryV2;
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
    if (!e || (!unknownBaseline && (e.reason !== 'deadline' || !nonworking(e.status_before) || !nonworking(e.status_last))) ||
        e.status_flip || (!unknownBaseline && e.status_error !== null) ||
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
      // Transport success establishes staged input; screen buffers are not authoritative.
      result.staged_basis = 'text-transport-sent';
      const before = await read();
      if (!before || before.error !== null || !nonworking(before.status) || !await request.canAct()) return { ...result, reason: `status-or-lifecycle-changed${lastReadError ? `: ${lastReadError}` : ''}` };
      await request.recordAction?.({ ...result, action: 'machine-enter', result: 'attempting', reason: '机器代按 Enter' });
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

import { describe, expect, it, vi } from 'vitest';
import { createEnterRepress, RemediationAttempts, MAX_REMEDIATION_ATTEMPTS, MAX_CONCURRENT_REMEDIATIONS, type Remediator, type RemediationRequest } from '../src/remediator.js';
import { createDelivery, promptTailEvidence, type DeliveryEvidenceV2 } from '../src/launcher/delivery.js';
import type { DeliveryClientV2, PaneIdentity, StatusSample } from '../src/launcher/herdr-client-v2.js';

const target: PaneIdentity = { paneId: 'p1', terminalId: 'term', workspaceId: 'w1',
  agentSession: { agent: 'codex', kind: 'session', value: 's1' }, serverEpoch: null, agentGeneration: null };
function fixture() {
  let time = 0;
  let working = false;
  let flip = true;
  let badStatus = false;
  const read = vi.fn(async (pane, ctx): Promise<StatusSample> => ({ ...ctx, startedMonoMs: time, finishedMonoMs: time,
    status: working ? 'working' : 'idle', identity: pane, paneRevision: 1, error: badStatus ? 'PANE_MISSING' : null,
    readSource: 'herdr-pane-list', detectorSource: null, detectorAgeMs: null, attribution: 'unavailable' }));
  const enter = vi.fn(async (_pane, ctx) => {
    working = flip;
    return { kind: 'sent' as const, trace: { ...ctx, startedMonoMs: time, finishedMonoMs: time, spawned: true, exitCode: 0, signal: null, fault: null } };
  });
  const text = vi.fn();
  const client: DeliveryClientV2 = { readAgentStatus: read, sendEnter: enter, sendText: text };
  const env = { TUT_STATUS_FLIP_TIMEOUT_MS: '10', TUT_STATUS_POLL_MS: '2', TUT_HERDR_TIMEOUT_MS: '10' };
  const evidence: DeliveryEvidenceV2 = { schema: 2, target, prompt_tail: promptTailEvidence('Task t1: please begin your executor round.'),
    attempt_id: 'attempt-1', pane_id: 'p1', reason: 'deadline', status_before: 'idle', status_last: 'idle',
    status_error: null, status_flip: false, submit_confirmed: false, attribution: 'unavailable',
    text_transport: 'sent', text_error: null, enter_transport: 'sent', enter_error: null, text_calls: 1, enter_calls: 1,
    budget_ms: 10, elapsed_ms: 10, total_elapsed_ms: 10, last_query_sequence: 5,
    detector_source: null, detector_age_ms: null, server_epoch: null, agent_generation: null };
  const screen = vi.fn(async () => 'Task t1: please begin\nyour executor round.');
  const matches = vi.fn(async () => true);
  const request: RemediationRequest = { agent: 'codex', pane: 't1.executor', evidence, canAct: () => true };
  const errors: string[] = [];
  const strategy: Remediator = createEnterRepress({ stderr: text => errors.push(text), client, readPane: screen, matchesPane: matches, env,
    now: () => time, sleep: async ms => { time += ms; } });
  return { strategy, errors, request, evidence, enter, text, read, screen, matches, client, env,
    setFlip: (value: boolean) => { flip = value; }, setWorking: () => { working = true; },
    setBadStatus: () => { badStatus = true; }, now: () => time, sleep: async (ms: number) => { time += ms; } };
}

describe('optional remediation session binding', () => {
  it.each([null, target.agentSession])('authorizes one audited Enter with session %j', async agentSession => {
    const f = fixture();
    f.evidence.target = { ...target, agentSession };
    const record = vi.fn(async () => { expect(f.enter).not.toHaveBeenCalled(); });
    f.request.recordAction = record;
    expect(await f.strategy.remediate(f.request)).toMatchObject({ action: 'machine-enter',
      result: 'working-observed', attribution: 'machine-remediation', staged_basis: 'text-transport-sent' });
    expect(f.matches).toHaveBeenCalledWith('p1', 't1.executor');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ staged_basis: 'text-transport-sent' }));
    await f.strategy.remediate(f.request);
    expect(f.enter).toHaveBeenCalledTimes(1);
    expect(f.text).not.toHaveBeenCalled();
  });
  it.each([
    undefined, {}, { agent: 'pi', kind: 'session', value: 's1' },
    { agent: 'codex', kind: '', value: 's1' }, { agent: 'codex', kind: 'session', value: '' },
  ])('rejects missing or invalid non-null session %j', async agentSession => {
    const f = fixture();
    f.request.evidence = { ...f.evidence, target: { ...target, agentSession } };
    expect(await f.strategy.remediate(f.request)).toMatchObject({ action: 'none', result: 'skipped' });
    expect(f.enter).not.toHaveBeenCalled();
  });
  it.each(['agent', 'kind', 'value'] as const)('rejects a changed non-null session %s', async field => {
    const f = fixture();
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => ({ ...await read(pane, ctx),
      identity: { ...target, agentSession: { ...target.agentSession!, [field]: 'changed' } } }));
    expect(await f.strategy.remediate(f.request)).toMatchObject({ action: 'none', result: 'skipped' });
    expect(f.enter).not.toHaveBeenCalled();
  });
  it.each(['pane-id', 'label', 'missing', 'unknown', 'identity-error', 'session-changed'])(
    'rejects %s without a session', async fault => {
      const f = fixture();
      f.evidence.target = { ...target, agentSession: null };
      if (fault === 'pane-id') f.evidence.pane_id = 'p2';
      if (fault === 'label') f.matches.mockResolvedValue(false);
      if (fault === 'missing') f.setBadStatus();
      if (fault === 'identity-error') {
        f.evidence.reason = 'baseline-unknown';
        f.evidence.status_before = f.evidence.status_last = 'unknown';
        f.evidence.status_error = 'IDENTITY_CHANGED';
      }
      if (fault === 'unknown' || fault === 'session-changed') {
        const read = f.read.getMockImplementation()!;
        f.read.mockImplementation(async (pane, ctx) => ({ ...await read(pane, ctx),
          ...(fault === 'unknown' ? { status: 'unknown' as const } : { identity: target }) }));
      }
      expect(await f.strategy.remediate(f.request)).toMatchObject({ action: 'none' });
      expect(f.enter).not.toHaveBeenCalled();
    });
  it('bounds persistent unknown status without a session and sends no key', async () => {
    const f = fixture();
    f.evidence.target = { ...target, agentSession: null };
    f.evidence.reason = 'baseline-unknown';
    f.evidence.status_before = f.evidence.status_last = 'unknown';
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => ({ ...await read(pane, ctx), status: 'unknown' }));
    expect(await f.strategy.remediate(f.request)).toMatchObject({ action: 'none', result: 'give-up', reason: 'baseline-unknown' });
    expect(f.now()).toBe(90_000);
    expect(f.enter).not.toHaveBeenCalled();
  });
});

describe('controlled Enter remediation', () => {
  it('awaits fresh lifecycle checks during unknown waiting and stops without a key', async () => {
    const f = fixture();
    f.evidence.reason = 'baseline-unknown';
    f.evidence.status_before = f.evidence.status_last = 'unknown';
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => ({ ...await read(pane, ctx), status: 'unknown' }));
    const checks = vi.fn(async () => checks.mock.calls.length < 3);
    f.request.canAct = checks;
    expect(await f.strategy.remediate(f.request)).toMatchObject({ reason: 'lifecycle-changed', action: 'none' });
    expect(checks).toHaveBeenCalledTimes(3);
    expect(f.enter).not.toHaveBeenCalled();
  });
  it('uses the shared readiness timeout knob for remediation', async () => {
    const f = fixture();
    f.evidence.reason = 'baseline-unknown';
    f.evidence.status_before = f.evidence.status_last = 'unknown';
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => ({ ...await read(pane, ctx), status: 'unknown' }));
    const strategy = createEnterRepress({ client: f.client, now: f.now, sleep: f.sleep,
      env: { ...f.env, TUT_BASELINE_READY_TIMEOUT_MS: '8' } });
    expect(await strategy.remediate(f.request)).toMatchObject({ reason: 'baseline-unknown' });
    expect(f.now()).toBe(8);
    expect(f.enter).not.toHaveBeenCalled();
  });
  it('rechecks a legacy unknown baseline caused by a transient read fault', async () => {
    const f = fixture();
    f.evidence.reason = 'baseline-unknown';
    f.evidence.status_before = f.evidence.status_last = 'unknown';
    f.evidence.status_error = 'STATUS_MISSING';
    expect(await f.strategy.remediate(f.request)).toMatchObject({ result: 'working-observed', attribution: 'machine-remediation' });
    expect(f.enter).toHaveBeenCalledTimes(1);
  });
  it('does not press Enter for a readiness give-up that never sent the prompt', async () => {
    const f = fixture();
    f.evidence.reason = 'baseline-unknown';
    f.evidence.status_before = f.evidence.status_last = 'unknown';
    f.evidence.text_calls = f.evidence.enter_calls = 0;
    f.evidence.text_transport = 'not-sent';
    f.evidence.enter_transport = 'not-attempted';
    f.evidence.elapsed_ms = null;
    f.evidence.baseline_wait = { budget_ms: 90_000, elapsed_ms: 90_000 };
    expect(await f.strategy.remediate(f.request)).toMatchObject({ result: 'skipped', reason: 'evidence-insufficient' });
    expect(f.enter).not.toHaveBeenCalled();
  });
  it('waits for an unknown baseline, then reruns all three gates before one machine Enter', async () => {
    const f = fixture();
    f.evidence.reason = 'baseline-unknown';
    f.evidence.status_before = f.evidence.status_last = 'unknown';
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => {
      const sample = await read(pane, ctx);
      if (f.now() < 6) {
        expect(f.enter).not.toHaveBeenCalled();
        expect(f.screen).not.toHaveBeenCalled();
        return { ...sample, status: 'unknown' };
      }
      return sample;
    });
    expect(await f.strategy.remediate(f.request)).toMatchObject({ result: 'working-observed', attribution: 'machine-remediation' });
    expect(f.now()).toBe(6);
    expect(f.matches).toHaveBeenCalledTimes(1);
    expect(f.screen).not.toHaveBeenCalled();
    expect(f.enter).toHaveBeenCalledTimes(1);
  });
  it('escalates after 90 seconds of unknown status without pressing a key', async () => {
    const f = fixture();
    f.evidence.reason = 'baseline-unknown';
    f.evidence.status_before = f.evidence.status_last = 'unknown';
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => ({ ...await read(pane, ctx), status: 'unknown' }));
    expect(await f.strategy.remediate(f.request)).toMatchObject({ result: 'give-up', reason: 'baseline-unknown', action: 'none' });
    expect(f.now()).toBe(90_000);
    expect(f.enter).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
  });
  it.each(['pane', 'working', 'lifecycle'])('rechecks %s after unknown baseline becomes classifiable', async condition => {
    const f = fixture();
    f.evidence.reason = 'baseline-unknown';
    f.evidence.status_before = f.evidence.status_last = 'unknown';
    if (condition === 'pane') f.matches.mockResolvedValue(false);
    if (condition === 'working') f.setWorking();
    if (condition === 'lifecycle') f.request.canAct = () => false;
    expect((await f.strategy.remediate(f.request)).result).toBe('skipped');
    expect(f.enter).not.toHaveBeenCalled();
  });
  it('swallowed Enter: one machine key, observed flip, original evidence unchanged', async () => {
    const f = fixture();
    const original = JSON.stringify(f.evidence);
    const recorded: unknown[] = [];
    f.request.recordAction = async evidence => {
      expect(f.enter).not.toHaveBeenCalled();
      recorded.push(evidence);
    };
    expect(await f.strategy.remediate(f.request)).toMatchObject({ strategy: 'enter-repress', action: 'machine-enter',
      result: 'working-observed', attribution: 'machine-remediation', status_flip: true });
    expect(f.enter).toHaveBeenCalledTimes(1);
    expect(f.text).not.toHaveBeenCalled();
    expect(JSON.stringify(f.evidence)).toBe(original);
    expect(recorded).toEqual([expect.objectContaining({ strategy: "enter-repress", action: "machine-enter",
      result: "attempting", reason: "机器代按 Enter" })]);
  });
  it.each(['pane', 'missing-evidence', 'identity', 'unknown-status', 'working', 'uncertain', 'already-flipped', 'lifecycle'])(
    '%s condition fails: zero keys', async condition => {
      const f = fixture();
      if (condition === 'pane') f.matches.mockResolvedValue(false);
      if (condition === 'missing-evidence') f.request.evidence = undefined;
      if (condition === 'identity') f.request.agent = 'pi';
      if (condition === 'unknown-status') f.setBadStatus();
      if (condition === 'working') f.setWorking();
      if (condition === 'uncertain') { f.evidence.enter_transport = 'uncertain'; f.evidence.enter_error = 'TIMEOUT'; }
      if (condition === 'already-flipped') f.evidence.status_flip = true;
      if (condition === 'lifecycle') f.request.canAct = () => false;
      expect((await f.strategy.remediate(f.request)).result).toBe('skipped');
      expect(f.enter).not.toHaveBeenCalled();
    });
  it.each(['empty', 'unrelated', 'read-error'] as const)('sent text authorizes one key with %s screen evidence', async screen => {
    const f = fixture();
    if (screen === 'read-error') f.screen.mockRejectedValue(new Error('alt-screen unavailable'));
    else f.screen.mockResolvedValue(screen === 'empty' ? '' : 'unrelated output');
    if (screen === 'unrelated') delete f.evidence.prompt_tail;
    const original = JSON.stringify(f.evidence);
    const record = vi.fn(async () => {});
    f.request.recordAction = record;
    expect(await f.strategy.remediate(f.request)).toMatchObject({ action: 'machine-enter',
      result: 'working-observed', attribution: 'machine-remediation', staged_basis: 'text-transport-sent' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ staged_basis: 'text-transport-sent' }));
    expect(f.enter).toHaveBeenCalledTimes(1);
    expect(f.text).not.toHaveBeenCalled();
    expect(f.screen).not.toHaveBeenCalled();
    expect(JSON.stringify(f.evidence)).toBe(original);
  });
  it.each(['uncertain', 'not-sent'] as const)('%s text transport never authorizes a key', async transport => {
    const f = fixture();
    f.evidence.text_transport = transport;
    f.evidence.enter_calls = 0;
    f.evidence.enter_transport = 'not-attempted';
    f.evidence.elapsed_ms = null;
    if (transport === 'uncertain') {
      f.evidence.reason = 'text-uncertain';
      f.evidence.text_error = 'TIMEOUT';
    } else f.evidence.text_calls = 0;
    expect(await f.strategy.remediate(f.request)).toMatchObject({ action: 'none', reason: 'evidence-insufficient' });
    expect(f.enter).not.toHaveBeenCalled();
    expect(f.text).not.toHaveBeenCalled();
  });
  it.each(['preflight', 'record-action'] as const)('rechecks lifecycle after %s before pressing', async phase => {
    const f = fixture();
    let active = true;
    f.request.canAct = async () => active;
    if (phase === 'preflight') {
      const read = f.read.getMockImplementation()!;
      f.read.mockImplementation(async (pane, ctx) => { active = false; return read(pane, ctx); });
    } else f.request.recordAction = async () => { active = false; };
    expect(await f.strategy.remediate(f.request)).toMatchObject({ action: 'none' });
    expect(f.enter).not.toHaveBeenCalled();
  });
  it('no flip produces a second give-up, repeated or concurrent events never press twice', async () => {
    const f = fixture(); f.setFlip(false);
    const results = await Promise.all([f.strategy.remediate(f.request), f.strategy.remediate(f.request)]);
    expect(results[0]).toMatchObject({ result: 'give-up', action: 'machine-enter', attribution: 'unavailable' });
    expect(results[1]?.result).toBe('skipped');
    await f.strategy.remediate(f.request);
    expect(f.enter).toHaveBeenCalledTimes(1);
  });
  it('identity disappearing between pane match and preflight rejects the action', async () => {
    const f = fixture(); f.matches.mockImplementation(async () => { f.setBadStatus(); return true; });
    expect((await f.strategy.remediate(f.request)).result).toBe('skipped');
    expect(f.enter).not.toHaveBeenCalled();
  });
  it('late status sample cannot authorize a key', async () => {
    const f = fixture(); f.read.mockImplementation(async (pane, ctx) => ({ ...ctx, startedMonoMs: 0,
      finishedMonoMs: ctx.deadlineMonoMs, status: 'idle', identity: pane, paneRevision: 1, error: null,
      readSource: 'herdr-pane-list', detectorSource: null, detectorAgeMs: null, attribution: 'unavailable' }));
    expect((await f.strategy.remediate(f.request)).result).toBe('skipped');
    expect(f.enter).not.toHaveBeenCalled();
  });
  it.each([null, target.agentSession])('launcher supplies consumable frozen evidence with session %j', async agentSession => {
    const deliveryTarget = { ...target, agentSession };
    const f = fixture(); f.setFlip(false);
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async (pane, ctx) => ({ ...await read(pane, ctx), status: 'working' }));
    f.text.mockImplementation(async (_pane, _text, ctx) => ({ kind: 'sent', trace: { ...ctx, startedMonoMs: f.now(),
      finishedMonoMs: f.now(), spawned: true, exitCode: 0, signal: null, fault: null } }));
    let evidence: DeliveryEvidenceV2 | undefined;
    await createDelivery({ remediationEvidence: true, client: f.client, env: f.env, now: f.now, sleep: f.sleep, stderr: () => {},
      onGiveUp: async (_pane, e) => { evidence = e; } }).deliver({ target: deliveryTarget, prompt: 'Task t1: please begin your executor round.', branch: 'born' });
    expect(evidence).toMatchObject({ reason: 'deadline', target: deliveryTarget, prompt_tail: f.evidence.prompt_tail,
      status_before: 'idle', baseline_wait: { elapsed_ms: 2 } });
    f.setFlip(true); f.enter.mockClear();
    expect((await f.strategy.remediate({ ...f.request, evidence })).result).toBe('working-observed');
    expect(f.enter).toHaveBeenCalledTimes(1);
  });
  it.each(['working', 'unknown'] as const)('born timeout evidence with %s baseline cannot authorize remediation', async status => {
    const f = fixture();
    const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => ({ ...await read(pane, ctx), status }));
    f.text.mockImplementation(async (_pane, _text, ctx) => ({ kind: 'sent', trace: { ...ctx, startedMonoMs: f.now(),
      finishedMonoMs: f.now(), spawned: true, exitCode: 0, signal: null, fault: null } }));
    let evidence: DeliveryEvidenceV2 | undefined;
    await createDelivery({ remediationEvidence: true, client: f.client,
      env: { ...f.env, TUT_BASELINE_READY_TIMEOUT_MS: '6' }, now: f.now, sleep: f.sleep, stderr: () => {},
      onGiveUp: async (_pane, e) => { evidence = e; } }).deliver({ target, prompt: 'probe', branch: 'born' });
    expect(evidence).toMatchObject({ reason: `baseline-${status}`, baseline_wait: { elapsed_ms: 6 },
      text_calls: status === 'working' ? 1 : 0 });
    f.enter.mockClear(); f.text.mockClear();
    f.read.mockImplementation(read);
    expect(await f.strategy.remediate({ ...f.request, evidence })).toMatchObject({ action: 'none' });
    expect(f.enter).not.toHaveBeenCalled(); expect(f.text).not.toHaveBeenCalled();
  });
});

describe('revision v5 safeguards', () => {
  it('attributes a valid working sample even when the task advances during the read', async () => {
    const f = fixture();
    const read = f.read.getMockImplementation()!;
    let active = true;
    f.request.canAct = () => active;
    f.read.mockImplementation(async (pane, ctx) => {
      const sample = await read(pane, ctx);
      if (f.enter.mock.calls.length) active = false;
      return sample;
    });
    expect(await f.strategy.remediate(f.request)).toMatchObject({ result: 'working-observed', attribution: 'machine-remediation' });
    expect(f.enter).toHaveBeenCalledTimes(1);
  });
  it.each(['TIMEOUT', 'INVALID_JSON', 'late', 'wrong-sequence', 'unknown', 'throw'])(
    'continues after a transient %s sample and observes working', async fault => {
      const f = fixture(); const read = f.read.getMockImplementation()!;
      let postReads = 0;
      f.read.mockImplementation(async (pane, ctx) => {
        const sample = await read(pane, ctx);
        if (f.enter.mock.calls.length && ++postReads === 1) {
          if (fault === 'throw') throw new Error('temporary IPC failure');
          if (fault === 'late') return { ...sample, finishedMonoMs: ctx.deadlineMonoMs };
          if (fault === 'wrong-sequence') return { ...sample, sequence: -1 };
          if (fault === 'unknown') return { ...sample, status: 'unknown' };
          return { ...sample, status: 'unknown', error: fault as 'TIMEOUT' | 'INVALID_JSON' };
        }
        return sample;
      });
      expect((await f.strategy.remediate(f.request)).result).toBe('working-observed');
      expect(postReads).toBe(2);
      expect(f.enter).toHaveBeenCalledTimes(1);
      if (fault === 'throw') expect(f.errors.join('')).toContain('temporary IPC failure');
    });
  it('waits to the deadline when every post-Enter read fails', async () => {
    const f = fixture(); const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => {
      const sample = await read(pane, ctx);
      return f.enter.mock.calls.length ? { ...sample, status: 'unknown', error: 'TIMEOUT' } : sample;
    });
    expect(await f.strategy.remediate(f.request)).toMatchObject({ result: 'give-up', reason: 'status-unavailable: TIMEOUT' });
    expect(f.now()).toBe(10);
    expect(f.enter).toHaveBeenCalledTimes(1);
    expect(f.read.mock.calls.length).toBeGreaterThan(2);
  });
  it('identity-invalid samples still stop observation immediately', async () => {
    const f = fixture(); const read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (pane, ctx) => {
      const sample = await read(pane, ctx);
      return f.enter.mock.calls.length ? { ...sample, status: 'unknown', error: 'IDENTITY_CHANGED' } : sample;
    });
    expect(await f.strategy.remediate(f.request)).toMatchObject({ result: 'give-up', reason: 'identity-invalid: IDENTITY_CHANGED' });
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it.each(['preflight', 'send'] as const)('preserves %s exception details in reason and stderr', async phase => {
    const f = fixture();
    if (phase === 'preflight') f.matches.mockRejectedValue(new Error('pane inventory refused'));
    else f.enter.mockRejectedValue(new Error('key dispatch refused'));
    const result = await f.strategy.remediate(f.request);
    expect(result.reason).toContain(phase === 'preflight' ? 'pane inventory refused' : 'key dispatch refused');
    expect(f.errors.join('')).toContain(result.reason.replace('control-error: ', ''));
    expect(f.enter).toHaveBeenCalledTimes(phase === 'preflight' ? 0 : 1);
  });
  it('caps dedup memory without evicting an old attempt', () => {
    const attempts = new RemediationAttempts();
    for (let i = 0; i < MAX_REMEDIATION_ATTEMPTS; i++) expect(attempts.claim(String(i))).toBe('new');
    expect(attempts.claim('overflow')).toBe('full');
    expect(attempts.claim('0')).toBe('duplicate');
    expect(attempts.claim('overflow')).toBe('full');
  });
  it('bounds concurrent panes and releases the slots after preflight ends', async () => {
    const f = fixture(); let release!: (value: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    f.matches.mockImplementation(() => gate);
    const request = (i: number) => ({ ...f.request, evidence: { ...f.evidence, attempt_id: `a-${i}`, pane_id: `p-${i}`,
      target: { ...target, paneId: `p-${i}` } } });
    const active = Array.from({ length: MAX_CONCURRENT_REMEDIATIONS }, (_, i) => f.strategy.remediate(request(i)));
    expect((await f.strategy.remediate(request(1000))).reason).toBe('concurrency-limit');
    release(false); await Promise.all(active);
    expect((await f.strategy.remediate(request(1001))).reason).toBe('pane-mismatch');
    expect(f.enter).not.toHaveBeenCalled();
  });
});

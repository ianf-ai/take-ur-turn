import { parseDeliveryV2 } from "../src/launcher/escalation.js";
import { describe, expect, it, vi } from "vitest";
import { createDelivery, parseDeliveryKnobs, createDeliveryDiagnostics, createRemediationAudit, diagEnabled, DELIVERY_LOG_MAX_BYTES, type DiagnosticsFs, type DeliveryEvidenceV2 } from "../src/launcher/delivery.js";
import type { AgentStatus, CallContext, DeliveryClientV2, PaneIdentity, ReadFault, SendResult, StatusSample } from "../src/launcher/herdr-client-v2.js";

function memoryFs(): {
  fs: DiagnosticsFs;
  dirs: string[];
  files: Map<string, string>;
  renames: Array<{ from: string; to: string }>;
  sizeOverrides: Map<string, number>;
  failAppendAfter: (count: number) => void;
} {
  const dirs: string[] = [];
  const files = new Map<string, string>();
  const renames: Array<{ from: string; to: string }> = [];
  const sizeOverrides = new Map<string, number>();
  let appendCalls = 0;
  let failFrom = Number.POSITIVE_INFINITY;
  return {
    dirs,
    files,
    renames,
    sizeOverrides,
    failAppendAfter: (count: number) => { failFrom = count; },
    fs: {
      isDirectory: (target) => target === "/proj" || target === "/anchor",
      mkdir: async (dir) => { dirs.push(dir); },
      append: async (file, text) => {
        appendCalls += 1;
        if (appendCalls > failFrom) throw new Error("disk full");
        files.set(file, (files.get(file) ?? "") + text);
      },
      // Byte-accurate like the real fs: size reports UTF-8 BYTES (stat semantics).
      size: async (file) =>
        sizeOverrides.get(file) ?? (files.has(file) ? Buffer.byteLength(files.get(file) ?? "", "utf8") : -1),
      rename: async (from, to) => {
        renames.push({ from, to });
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      },
    },
  };
}

describe("delivery diagnostics: decoupled dual sink", () => {
  it("TUT_DELIVERY_DIAG follows the legacy switch: on when unset or exactly 1, off otherwise", () => {
    expect(diagEnabled({})).toBe(true);
    expect(diagEnabled({ TUT_DELIVERY_DIAG: "1" })).toBe(true);
    expect(diagEnabled({ TUT_DELIVERY_DIAG: "0" })).toBe(false);
    expect(diagEnabled({ TUT_DELIVERY_DIAG: "true" })).toBe(false);
    expect(diagEnabled({ TUT_DELIVERY_DIAG: "2" })).toBe(false);
  });

  it("both sinks carry the same events; the file adds task/role context and keeps order", async () => {
    const stderr: string[] = [];
    const mem = memoryFs();
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      task_id: "t-pr",
      role: "architect",
      stderr: (text) => stderr.push(text),
      clock: () => 1_700_000_000_000,
      fs: mem.fs,
    });
    sink.emit("gate-start pane=p1");
    sink.emit("send-text pane=p1 branch=born len=9");
    await sink.flush();
    expect(stderr).toEqual([
      "tut-delivery t=1700000000000 gate-start pane=p1\n",
      "tut-delivery t=1700000000000 send-text pane=p1 branch=born len=9\n",
    ]);
    const file = mem.files.get("/proj/.context-hub/delivery.log") ?? "";
    expect(file).toBe(
      "tut-delivery t=1700000000000 task=t-pr role=architect gate-start pane=p1\n" +
      "tut-delivery t=1700000000000 task=t-pr role=architect send-text pane=p1 branch=born len=9\n",
    );
  });

  it("lazy persistence: nothing is created on disk until the first line; a silenced run touches nothing", async () => {
    const mem = memoryFs();
    const silent = createDeliveryDiagnostics({
      env: { TUT_DELIVERY_DIAG: "0", TUT_PROJECT_ROOT: "/proj" },
      fs: mem.fs,
    });
    silent.emit("gate-start pane=p1");
    await silent.flush();
    expect(mem.dirs).toHaveLength(0);
    // Enabled but never emitting: still nothing (lazy setup).
    const quiet = createDeliveryDiagnostics({ env: { TUT_PROJECT_ROOT: "/proj" }, fs: mem.fs });
    await quiet.flush();
    expect(mem.dirs).toHaveLength(0);
  });

  it("TUT_PROJECT_ROOT must be a real directory — otherwise the anchor-root fallback serves the durable tail", async () => {
    const mem = memoryFs();
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/not-a-dir" },
      persistRootFallback: "/anchor",
      task_id: "t",
      role: "executor",
      stderr: () => undefined,
      fs: mem.fs,
    });
    sink.emit("gate-release pane=p1");
    await sink.flush();
    expect(mem.files.has("/anchor/.context-hub/delivery.log")).toBe(true);
    expect(mem.files.has("/not-a-dir/.context-hub/delivery.log")).toBe(false);
  });

  it("no resolvable root → stderr only, never a delivery failure", async () => {
    const stderr: string[] = [];
    const sink = createDeliveryDiagnostics({ env: {}, stderr: (t) => stderr.push(t), fs: memoryFs().fs });
    sink.emit("gate-start pane=p1");
    await sink.flush();
    expect(stderr).toHaveLength(1);
  });

  it("the first failing append disables persistence for the run — stderr keeps its line", async () => {
    const stderr: string[] = [];
    const mem = memoryFs();
    mem.failAppendAfter(0);
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      stderr: (t) => stderr.push(t),
      fs: mem.fs,
    });
    sink.emit("first");
    sink.emit("second");
    sink.emit("third");
    await sink.flush();
    expect(stderr).toHaveLength(3); // the observer never loses the stderr timeline
    expect([...mem.files.values()].join("")).toBe(""); // nothing persisted after the failure
  });

  it("task/role default to ? when unknown (the persisted line stays parseable)", async () => {
    const mem = memoryFs();
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      clock: () => 42,
      stderr: () => undefined,
      fs: mem.fs,
    });
    sink.emit("gate-start pane=p1");
    await sink.flush();
    expect(mem.files.get("/proj/.context-hub/delivery.log")).toBe(
      "tut-delivery t=42 task=? role=? gate-start pane=p1\n",
    );
  });
});

describe("delivery diagnostics: rotation and the never-rejecting chain", () => {
  it("delivery.log rotates by size — one .1 generation kept, the active file restarts", async () => {
    const mem = memoryFs();
    mem.files.set("/proj/.context-hub/delivery.log", "OLD");
    mem.sizeOverrides.set("/proj/.context-hub/delivery.log", DELIVERY_LOG_MAX_BYTES + 10); // already over cap
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      clock: () => 7,
      stderr: () => undefined,
      fs: mem.fs,
    });
    sink.emit("first");
    sink.emit("second");
    await sink.flush();
    expect(mem.renames).toEqual([
      { from: "/proj/.context-hub/delivery.log", to: "/proj/.context-hub/delivery.log.1" },
    ]);
    expect(mem.files.get("/proj/.context-hub/delivery.log.1")).toBe("OLD");
    expect(mem.files.get("/proj/.context-hub/delivery.log")).toBe(
      "tut-delivery t=7 task=? role=? first\ntut-delivery t=7 task=? role=? second\n",
    );
  });

  it("rotation counts UTF-8 BYTES — multi-byte fields rotate before the byte cap, one .1 kept", async () => {
    // Non-ASCII diag fields (pane tails carry user text) make a line's byte
    // length exceed its character length.  The size ledger must count
    // BYTES (fs.size semantics), or a multibyte-heavy log overshoots the
    // cap before rotation fires.
    const mem = memoryFs();
    mem.files.set("/proj/.context-hub/delivery.log", "OLD");
    mem.sizeOverrides.set("/proj/.context-hub/delivery.log", DELIVERY_LOG_MAX_BYTES - 10); // 10 bytes left
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      clock: () => 7,
      stderr: () => undefined,
      fs: mem.fs,
    });
    // 30 CJK chars = 90 bytes: over the 10 remaining bytes in BYTES, well
    // under in characters — the old character-count check missed it.
    sink.emit(`tail='あ${"い".repeat(29)}'`);
    await sink.flush();
    expect(mem.renames).toEqual([
      { from: "/proj/.context-hub/delivery.log", to: "/proj/.context-hub/delivery.log.1" },
    ]);
    expect(mem.files.get("/proj/.context-hub/delivery.log.1")).toBe("OLD");
    const active = mem.files.get("/proj/.context-hub/delivery.log") ?? "";
    expect(active).toContain("あ"); // the multibyte line itself survived
    expect(Buffer.byteLength(active, "utf8")).toBeLessThanOrEqual(DELIVERY_LOG_MAX_BYTES);

    // A second overshoot rotates again — onto the SAME .1 name: at most one
    // rotated generation ever exists.  (The big line itself stays under the
    // cap; the FILE crosses it, so the NEXT append is what rotates.)
    sink.emit("y".repeat(DELIVERY_LOG_MAX_BYTES - 100));
    sink.emit("z");
    await sink.flush();
    expect(mem.renames).toHaveLength(2);
    expect(new Set(mem.renames.map((r) => r.to)).size).toBe(1); // one .1 target
    expect((mem.files.get("/proj/.context-hub/delivery.log") ?? "")).toContain("t=7 task=? role=? z");
  });

  it("a throwing fs seam never rejects flush — the exit-0 invariant survives diagnostics faults", async () => {
    const boom: DiagnosticsFs = {
      isDirectory: () => { throw new Error("stat exploded"); },
      mkdir: async () => undefined,
      append: async () => undefined,
      size: async () => -1,
      rename: async () => undefined,
    };
    const sink = createDeliveryDiagnostics({ env: { TUT_PROJECT_ROOT: "/proj" }, stderr: () => undefined, fs: boom });
    sink.emit("gate-start pane=p1");
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});


const target: PaneIdentity = { paneId: 'p1', terminalId: 't1', workspaceId: 'w1', agentSession: null, serverEpoch: null, agentGeneration: null };
function fixture(config: {
  text?: SendResult['kind']; enter?: SendResult['kind']; baseline?: AgentStatus;
  post?: AgentStatus[]; errors?: (ReadFault | null)[]; cost?: number;
  onCall?: (phase: string, ctx: CallContext) => void;
  deadline?: number; env?: NodeJS.ProcessEnv;
} = {}) {
  let time = 0;
  let reads = 0;
  const controller = new AbortController();
  const calls: { phase: string; ctx: CallContext; target: PaneIdentity; text?: string }[] = [];
  const events: Readonly<DeliveryEvidenceV2>[] = [];
  const logs: string[] = [];
  const send = async (phase: 'text' | 'enter', pane: PaneIdentity, ctx: CallContext, text?: string): Promise<SendResult> => {
    calls.push({ phase, ctx, target: pane, ...(text === undefined ? {} : { text }) });
    config.onCall?.(phase, ctx);
    const kind = config[phase] ?? 'sent';
    const start = time;
    time += config.cost ?? 0;
    return { kind, trace: { attemptId: ctx.attemptId, sequence: ctx.sequence, startedMonoMs: start, finishedMonoMs: time,
      spawned: kind !== 'not-sent', exitCode: kind === 'sent' ? 0 : 1, signal: null,
      fault: kind === 'sent' ? null : kind === 'not-sent' ? 'SPAWN_FAILED' : 'TIMEOUT' } };
  };
  const client: DeliveryClientV2 = {
    sendText: (pane, text, ctx) => send('text', pane, ctx, text),
    sendEnter: (pane, ctx) => send('enter', pane, ctx),
    async readAgentStatus(pane, ctx): Promise<StatusSample> {
      calls.push({ phase: 'read', ctx, target: pane });
      config.onCall?.('read', ctx);
      const start = time;
      time += config.cost ?? 0;
      const n = reads++;
      return { attemptId: ctx.attemptId, sequence: ctx.sequence, startedMonoMs: start, finishedMonoMs: time,
        status: n === 0 ? config.baseline ?? 'idle' : config.post?.[Math.min(n - 1, config.post.length - 1)] ?? 'idle',
        identity: pane, paneRevision: n, error: config.errors?.[n] ?? null,
        readSource: 'herdr-pane-list', detectorSource: null, detectorAgeMs: null, attribution: 'unavailable' };
    },
  };
  const delivery = createDelivery({ client, now: () => time, sleep: async ms => { time += ms; }, signal: controller.signal,
    deadlineMonoMs: config.deadline ?? 100_000,
    env: { TUT_STATUS_FLIP_TIMEOUT_MS: '10', TUT_STATUS_POLL_MS: '2', TUT_HERDR_TIMEOUT_MS: '10', ...config.env },
    diagnostics: { emit: s => logs.push(s), flush: async () => undefined }, stderr: () => undefined,
    onGiveUp: async (_, evidence) => { events.push(evidence); },
  });
  return { delivery, client, calls, events, logs, controller, advance: (ms: number) => { time += ms; },
    run: (branch: 'born' | 'continuation' = 'born') => delivery.deliver({ target, prompt: 'original prompt', branch }) };
}

function validEvidence(e: Readonly<DeliveryEvidenceV2>) {
  expect(e.submit_confirmed).toBe(false);
  expect(e.attribution).toBe('unavailable');
  expect(parseDeliveryV2(e)).toEqual(e);
  expect(e.text_calls).toBe(e.text_transport === 'not-sent' ? 0 : 1);
  expect(e.enter_calls).toBe(e.enter_transport === 'not-attempted' ? 0 : 1);
  expect(e.elapsed_ms === null).toBe(e.enter_calls === 0);
  for (const value of [e.budget_ms, e.total_elapsed_ms, e.elapsed_ms ?? 0]) {
    expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(e.text_transport !== 'uncertain').toBe(e.text_error === null);
  expect(['sent', 'not-attempted'].includes(e.enter_transport)).toBe(e.enter_error === null);
  if (e.status_flip) {
    expect(['idle', 'blocked', 'done']).toContain(e.status_before);
    expect(e.status_last).toBe('working'); expect(e.status_error).toBeNull();
    expect(e.enter_transport).toBe('sent'); expect(e.elapsed_ms).toBeLessThan(e.budget_ms);
  }
  if (e.reason === 'attribution-unavailable') expect(e.status_flip).toBe(true);
  if (e.reason === 'text-uncertain') { expect(e.text_transport).toBe('uncertain'); expect(e.enter_calls).toBe(0); }
  else expect(['sent', 'not-sent']).toContain(e.text_transport);
}

describe('delivery confirmation v2 single attempt', () => {
  it.each([
    ['working', 'working', 'idle'],
    ['unknown', 'working', 'unknown', 'idle'],
    ['working', 'blocked', 'done', 'idle'],
  ] as AgentStatus[][])('born waits for idle through %j with a single readiness budget', async (...states) => {
    const f = fixture({ baseline: states[0]!, post: [...states.slice(1), 'working'],
      env: { TUT_BASELINE_READY_TIMEOUT_MS: '20' } });
    expect(await f.run()).toMatchObject({ reason: 'attribution-unavailable' });
    expect(f.calls.map(c => c.phase)).toEqual([...states.map(() => 'read'), 'text', 'enter', 'read']);
    expect(f.calls.find(c => c.phase === 'text')?.text).toBe('original prompt');
    expect(f.events[0]).toMatchObject({ status_before: 'idle', status_flip: true,
      baseline_wait: { budget_ms: 20, elapsed_ms: (states.length - 1) * 2 }, elapsed_ms: 0 });
    expect(f.logs.filter(s => s.startsWith('baseline-wait-start'))).toHaveLength(1);
    validEvidence(f.events[0]!);
  });
  it.each(['working', 'blocked', 'done'] as const)('born timeout falls back to the actual %s baseline', async status => {
    const f = fixture({ baseline: 'working', post: [status], env: { TUT_BASELINE_READY_TIMEOUT_MS: '6' } });
    expect(await f.run()).toMatchObject({ reason: status === 'working' ? 'baseline-working' : 'deadline',
      exitCode: 0, retry: 'forbidden', text: 'sent', enter: 'sent' });
    expect(f.calls.slice(0, 5).map(c => c.phase)).toEqual(['read', 'read', 'read', 'text', 'enter']);
    if (status === 'working') expect(f.calls).toHaveLength(5);
    expect(f.events[0]).toMatchObject({ status_before: status, status_flip: false,
      baseline_wait: { budget_ms: 6, elapsed_ms: 6 } });
    expect(f.logs.some(s => s.startsWith('baseline-ready'))).toBe(false);
    expect(f.logs.find(s => s.startsWith('baseline-wait-exhausted'))).toContain('action=fallback');
    validEvidence(f.events[0]!);
  });
  it.each(['unknown', 'error', 'late', 'sequence'] as const)('never revives old working after a final %s sample', async fault => {
    const f = fixture({ baseline: 'working', post: ['unknown'], env: { TUT_BASELINE_READY_TIMEOUT_MS: '4' } });
    const read = f.client.readAgentStatus;
    let n = 0;
    f.client.readAgentStatus = async (...args) => {
      const sample = await read(...args);
      if (++n === 1) return sample;
      if (fault === 'late') { f.advance(2); return { ...sample, status: 'idle', finishedMonoMs: 4 }; }
      if (fault === 'sequence') return { ...sample, status: 'idle', sequence: 999 };
      if (fault === 'error') return { ...sample, status: 'idle', error: 'INVALID_JSON' };
      return sample;
    };
    expect(await f.run()).toMatchObject({ reason: 'baseline-unknown', text: 'not-sent', enter: 'not-attempted' });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'read']);
    expect(f.events[0]?.status_before).toBe('unknown');
    validEvidence(f.events[0]!);
  });
  it.each(['PANE_MISSING', 'PANE_DUPLICATE', 'IDENTITY_CHANGED', 'cancelled'] as const)('born settling stops on %s', async fault => {
    const f = fixture({ baseline: 'working', post: ['idle'],
      errors: fault === 'cancelled' ? [] : [null, fault],
      onCall: phase => { if (fault === 'cancelled' && phase === 'read' && f.calls.length === 2) f.controller.abort(); } });
    expect(await f.run()).toMatchObject({ reason: fault === 'cancelled' ? 'cancelled' : 'identity-invalid', text: 'not-sent' });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'read']);
    validEvidence(f.events[0]!);
  });
  it('born timeout preserves the total-budget reserve and per-call bounds', async () => {
    const f = fixture({ baseline: 'working', post: ['working'], deadline: 5000,
      env: { TUT_BASELINE_READY_TIMEOUT_MS: '1000' } });
    expect(await f.run()).toMatchObject({ reason: 'deadline', text: 'not-sent' });
    expect(f.calls.every(c => c.phase === 'read' && c.ctx.deadlineMonoMs <= 1000)).toBe(true);
    expect(f.events[0]?.total_elapsed_ms).toBe(1000);
  });
  it('born working to idle alone never counts as a post-delivery flip', async () => {
    const f = fixture({ baseline: 'working', post: ['idle'] });
    expect(await f.run()).toMatchObject({ reason: 'deadline' });
    expect(f.events[0]).toMatchObject({ status_before: 'idle', status_flip: false,
      baseline_wait: { elapsed_ms: 2 }, elapsed_ms: 10, total_elapsed_ms: 12 });
    validEvidence(f.events[0]!);
  });
  it('continuation unknown to working waits only until classification', async () => {
    const f = fixture({ baseline: 'unknown', post: ['working'] });
    expect(await f.run('continuation')).toMatchObject({ reason: 'baseline-working' });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'read', 'text', 'enter']);
    expect(f.events[0]?.baseline_wait?.elapsed_ms).toBe(2);
  });
  it('born transient read failure then working shares readiness until idle', async () => {
    const f = fixture({ errors: ['INVALID_JSON'], post: ['working', 'idle'],
      env: { TUT_BASELINE_READY_TIMEOUT_MS: '6' } });
    expect(await f.run()).toMatchObject({ reason: 'deadline' });
    expect(f.calls.slice(0, 5).map(c => c.phase)).toEqual(['read', 'read', 'read', 'text', 'enter']);
    expect(f.events[0]).toMatchObject({ status_before: 'idle', baseline_wait: { budget_ms: 6, elapsed_ms: 4 } });
    validEvidence(f.events[0]!);
  });
  it('uses the readiness knob and bounds diagnostics independently of poll count', async () => {
    const f = fixture({ baseline: 'unknown', post: ['unknown'], env: { TUT_BASELINE_READY_TIMEOUT_MS: '1000' } });
    await f.run();
    expect(f.calls).toHaveLength(500);
    expect(f.events[0]?.baseline_wait).toEqual({ budget_ms: 1000, elapsed_ms: 1000 });
    expect(f.logs).toHaveLength(4); // initial sample, wait start, exhausted, give-up
    expect(f.logs.filter(s => s.startsWith('baseline-wait-exhausted'))).toHaveLength(1);
    const ready = fixture({ baseline: 'unknown', post: ['unknown', 'idle', 'working'] });
    await ready.run();
    expect(ready.logs.filter(s => s.startsWith('baseline-ready'))).toHaveLength(1);
    expect(ready.logs.filter(s => s.startsWith('baseline-wait '))).toHaveLength(0);
  });
  it.each(['0', '-1', '1.5', 'oops', '9007199254740992'])('invalid readiness knob %s falls back with warning', raw => {
    const warn = vi.fn();
    expect(parseDeliveryKnobs({ TUT_BASELINE_READY_TIMEOUT_MS: raw }, warn).readyMs).toBe(90_000);
    expect(warn).toHaveBeenCalledWith('invalid TUT_BASELINE_READY_TIMEOUT_MS; using 90000ms');
    expect(parseDeliveryKnobs({ TUT_BASELINE_READY_TIMEOUT_MS: '1' }).readyMs).toBe(1);
  });
  it('reports invalid readiness configuration to stderr even with diagnostics disabled', async () => {
    const f = fixture({ post: ['working'] });
    const stderr = vi.fn();
    const d = createDelivery({ client: f.client, now: () => 0, stderr,
      env: { TUT_BASELINE_READY_TIMEOUT_MS: 'bad', TUT_DELIVERY_DIAG: '0' } });
    await d.deliver({ target, prompt: 'test', branch: 'born' });
    expect(stderr).toHaveBeenCalledWith('launch: invalid TUT_BASELINE_READY_TIMEOUT_MS; using 90000ms\n');
  });
  it.each(['born', 'continuation'] as const)('waits before all %s input and starts flip budget at classification', async branch => {
    const f = fixture({ baseline: 'unknown', post: [...Array<AgentStatus>(10).fill('unknown'), 'idle', 'working'],
      onCall: phase => { if (phase !== 'read') expect(f.calls.filter(c => c.phase === 'read')).toHaveLength(12); } });
    expect(await f.run(branch)).toMatchObject({ reason: 'attribution-unavailable', text: 'sent', enter: 'sent' });
    expect(f.calls.slice(0, 12).every(c => c.phase === 'read')).toBe(true);
    expect(f.calls.slice(12).map(c => c.phase)).toEqual(['text', 'enter', 'read']);
    expect(f.events[0]).toMatchObject({ baseline_wait: { budget_ms: 90_000, elapsed_ms: 22 },
      status_before: 'idle', status_last: 'working', status_flip: true, submit_confirmed: false,
      attribution: 'unavailable', elapsed_ms: 0, total_elapsed_ms: 22, budget_ms: 10 });
    expect(f.calls[12]?.ctx.deadlineMonoMs).toBe(32);
    validEvidence(f.events[0]!);
  });
  it.each([100_000, 5_000])('gives up honestly without any input when unknown exhausts readiness / total deadline %s', async deadline => {
    const f = fixture({ baseline: 'unknown', post: ['unknown'], deadline });
    expect(await f.run()).toEqual({ kind: 'unconfirmed', exitCode: 0, retry: 'forbidden',
      reason: 'baseline-unknown', text: 'not-sent', enter: 'not-attempted' });
    expect(f.calls.every(c => c.phase === 'read')).toBe(true);
    expect(f.calls.every(c => c.ctx.deadlineMonoMs <= deadline)).toBe(true);
    const duration = Math.min(90_000, deadline);
    expect(f.events[0]).toMatchObject({ baseline_wait: { budget_ms: duration, elapsed_ms: duration },
      text_calls: 0, text_transport: 'not-sent', text_error: null, enter_calls: 0, elapsed_ms: null,
      status_flip: false, total_elapsed_ms: duration });
    validEvidence(f.events[0]!);
    expect(parseDeliveryV2({ ...f.events[0], enter_calls: 1 })).toBeUndefined();
    expect(parseDeliveryV2({ ...f.events[0], text_transport: 'sent' })).toBeUndefined();
    expect(parseDeliveryV2({ ...f.events[0], baseline_wait: { budget_ms: -1, elapsed_ms: 0 } })).toBeUndefined();
  });
  it.each(['cancelled', 'identity-invalid'] as const)('stops readiness on %s without sending text or Enter', async reason => {
    let reads = 0;
    const f = fixture({ baseline: 'unknown', post: ['unknown'],
      errors: reason === 'identity-invalid' ? [null, 'IDENTITY_CHANGED'] : [],
      onCall: phase => { if (phase === 'read' && ++reads === 2 && reason === 'cancelled') f.controller.abort(); } });
    expect(await f.run()).toMatchObject({ reason, text: 'not-sent', enter: 'not-attempted' });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'read']);
    expect(f.events[0]?.baseline_wait).toBeDefined();
    validEvidence(f.events[0]!);
  });
  it('keeps the baseline-working terminal evidence and never waits or observes a flip', async () => {
    const f = fixture({ baseline: 'working' });
    expect(await f.run('continuation')).toEqual({ kind: 'unconfirmed', exitCode: 0, retry: 'forbidden',
      reason: 'baseline-working', text: 'sent', enter: 'sent' });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'text', 'enter']);
    expect(f.events[0]).toEqual({ schema: 2, attempt_id: expect.any(String), pane_id: 'p1',
      reason: 'baseline-working', status_before: 'working', status_last: 'working', status_error: null,
      status_flip: false, submit_confirmed: false, attribution: 'unavailable', text_transport: 'sent',
      text_error: null, enter_transport: 'sent', enter_error: null, text_calls: 1, enter_calls: 1,
      budget_ms: 10, elapsed_ms: 0, total_elapsed_ms: 0, last_query_sequence: 1,
      detector_source: null, detector_age_ms: null, server_epoch: null, agent_generation: null });
  });
  it('rejects a classifiable sample arriving at the readiness deadline', async () => {
    const f = fixture({ deadline: 5_000, baseline: 'unknown' });
    const read = f.client.readAgentStatus;
    let count = 0;
    f.client.readAgentStatus = async (...args) => {
      const sample = await read(...args);
      if (++count === 2) {
        f.advance(4_998);
        return { ...sample, status: 'idle', finishedMonoMs: 5_000 };
      }
      return sample;
    };
    expect(await f.run()).toMatchObject({ reason: 'baseline-unknown', text: 'not-sent' });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'read']);
    expect(f.events[0]?.status_before).toBe('unknown');
    validEvidence(f.events[0]!);
  });
  it('does not start input if readiness leaves insufficient launcher budget', async () => {
    const f = fixture({ deadline: 5_000, baseline: 'unknown', post: ['idle'],
      onCall: phase => { if (phase === 'read' && f.calls.length === 1) f.advance(1_000); } });
    expect(await f.run()).toMatchObject({ reason: 'deadline', text: 'not-sent' });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'read']);
    expect(f.events[0]?.baseline_wait?.elapsed_ms).toBe(1_002);
    validEvidence(f.events[0]!);
  });
  it.each(['born', 'continuation'] as const)('uses one contract for %s, including external-input working', async branch => {
    const f = fixture({ post: ['working'] });
    expect(await f.run(branch)).toEqual({ kind: 'unconfirmed', exitCode: 0, retry: 'forbidden', reason: 'attribution-unavailable', text: 'sent', enter: 'sent' });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'text', 'enter', 'read']);
    expect(f.calls[1]?.text).toBe('original prompt');
    expect(f.calls.map(c => c.ctx.sequence)).toEqual([1, 2, 3, 4]);
    expect(f.events).toHaveLength(1); validEvidence(f.events[0]!);
    expect(f.logs.join('\n')).toContain('working-observed');
    expect(f.logs.join('\n')).not.toContain('submit-confirmed');
    expect(f.logs.join('\n')).not.toContain('original prompt');
    expect(f.logs.find(s => s.startsWith('give-up'))).toContain(JSON.stringify(f.events[0]));
    expect(Object.isFrozen(f.events[0])).toBe(true);
  });
  it.each(['idle', 'blocked', 'done'] as const)('accepts a %s baseline as classifiable', async baseline => {
    const f = fixture({ baseline, post: ['working'] }); await f.run(); validEvidence(f.events[0]!);
  });
  it.each(['working'] as const)('sends Enter once even with %s baseline, then stops', async baseline => {
    const f = fixture({ baseline, post: ['working'] });
    expect(await f.run('continuation')).toMatchObject({ reason: `baseline-${baseline}`, exitCode: 0 });
    expect(f.calls.map(c => c.phase)).toEqual(['read', 'text', 'enter']); validEvidence(f.events[0]!);
  });
  it.each(['PANE_MISSING', 'PANE_DUPLICATE', 'IDENTITY_CHANGED'] as const)('stops with zero Enter on baseline %s', async error => {
    const f = fixture({ errors: [error] });
    expect(await f.run()).toMatchObject({ reason: 'identity-invalid' });
    expect(f.calls.map(c => c.phase)).toEqual(['read']); validEvidence(f.events[0]!);
  });
  it('ordinary baseline faults wait for a classifiable sample; Enter failure takes priority', async () => {
    const f = fixture({ errors: ['INVALID_JSON'], enter: 'uncertain', post: ['working'] });
    expect(await f.run('continuation')).toMatchObject({ reason: 'enter-uncertain' });
    expect(f.calls).toHaveLength(4); validEvidence(f.events[0]!);
  });
  it.each(['not-sent', 'uncertain'] as const)('text %s never sends Enter', async text => {
    const f = fixture({ text });
    expect(await f.run()).toMatchObject({ reason: `text-${text}`, exitCode: text === 'not-sent' ? 1 : 0 });
    expect(f.calls).toHaveLength(2); expect(f.events).toHaveLength(text === 'not-sent' ? 0 : 1);
    if (f.events[0]) validEvidence(f.events[0]);
  });
  it.each(['not-sent', 'uncertain'] as const)('Enter %s forbids retry and never observes later working', async enter => {
    const f = fixture({ enter, post: ['working'] });
    expect(await f.run()).toMatchObject({ reason: `enter-${enter}`, retry: 'forbidden', exitCode: 0 });
    expect(f.calls).toHaveLength(3); expect(f.events).toHaveLength(1); validEvidence(f.events[0]!);
  });
  it.each(['idle', 'done', 'unknown'] as const)('missed pulse / swallowed Enter ending in %s never confirms', async status => {
    const f = fixture({ post: [status] });
    expect(await f.run()).toMatchObject({ reason: status === 'unknown' ? 'status-unavailable' : 'deadline' });
    expect(f.calls.filter(c => c.phase === 'enter')).toHaveLength(1); validEvidence(f.events[0]!);
    expect(f.events[0]?.elapsed_ms).toBe(10);
  });
  it('continues ordinary post-query errors; identity change terminates immediately', async () => {
    const f = fixture({ errors: [null, 'INVALID_JSON', null, 'IDENTITY_CHANGED'], post: ['idle'] });
    expect(await f.run()).toMatchObject({ reason: 'identity-invalid' });
    expect(f.events[0]?.status_error).toBe('IDENTITY_CHANGED'); validEvidence(f.events[0]!);
  });
  it('refuses insufficient launch budget before any side effect', async () => {
    const f = fixture({ deadline: 4029 });
    expect(await f.run()).toMatchObject({ reason: 'delivery-budget-unavailable', exitCode: 1 });
    expect(f.calls).toHaveLength(0); expect(f.events).toHaveLength(0);
  });
  it('accounts for IPC time and rejects working returned exactly at or after deadline', async () => {
    for (const cost of [4, 5]) {
      const f = fixture({ cost, post: ['working'], env: { TUT_STATUS_FLIP_TIMEOUT_MS: '12' } });
      expect(await f.run()).toMatchObject({ reason: 'status-unavailable' });
      expect(f.events[0]?.status_flip).toBe(false); validEvidence(f.events[0]!);
    }
  });
  it('checks cancellation before text and after baseline', async () => {
    const f = fixture(); f.controller.abort();
    expect(await f.run()).toMatchObject({ kind: 'not-sent' }); expect(f.calls).toHaveLength(0);
    const g = fixture({ onCall: phase => { if (phase === 'read') g.controller.abort(); } });
    expect(await g.run()).toMatchObject({ reason: 'cancelled', enter: 'not-attempted' }); validEvidence(g.events[0]!);
  });
  it('cancels an Enter without retry or post observation', async () => {
    const f = fixture({ onCall: phase => { if (phase === 'enter') f.controller.abort(); } });
    expect(await f.run()).toMatchObject({ reason: 'cancelled', enter: 'uncertain' });
    expect(f.calls).toHaveLength(3); validEvidence(f.events[0]!);
  });
  it('wall-clock jumps and observer failures do not affect outcome', async () => {
    const wall = vi.spyOn(Date, 'now').mockReturnValue(-1e12);
    const f = fixture({ post: ['working'] });
    const delivery = createDelivery({ client: f.client, now: () => 0, env: {},
      diagnostics: { emit: () => { throw Error('observer'); }, flush: async () => { throw Error('flush'); } },
      onGiveUp: async () => { throw Error('post'); }, stderr: () => { throw Error('stderr'); } });
    expect(await delivery.deliver({ target, prompt: 'x', branch: 'born' })).toMatchObject({ reason: 'attribution-unavailable' });
    wall.mockRestore();
  });
  it('freezes target identity and ignores obsolete knobs', async () => {
    const f = fixture({ post: ['working'], env: { TUT_DELIVERY_NONCE: 'legacy', TUT_READY_TIMEOUT_MS: '999999', TUT_SUBMIT_RETRIES: '200' } });
    await f.run(); expect(Object.isFrozen(f.calls[0]?.target)).toBe(true); expect(f.calls).toHaveLength(4);
  });
  it('validates and caps all status knobs', () => {
    const warn = vi.fn();
    expect(parseDeliveryKnobs({ TUT_STATUS_FLIP_TIMEOUT_MS: '60001', TUT_STATUS_POLL_MS: '0', TUT_HERDR_TIMEOUT_MS: '0' }, warn))
      .toEqual({ readyMs: 90000, flipMs: 30000, pollMs: 250, callMs: 10000 });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(parseDeliveryKnobs({ TUT_STATUS_FLIP_TIMEOUT_MS: '1', TUT_STATUS_POLL_MS: '2', TUT_HERDR_TIMEOUT_MS: '99999' }))
      .toEqual({ readyMs: 90000, flipMs: 1, pollMs: 1, callMs: 10000 });
  });
});

describe('delivery through the real delivery confirmation v2 client cancellation seam', () => {
  it.each(['timeout', 'cancel'] as const)('%s settles a child that never closes; late server writes never resend', async mode => {
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const { HerdrClient } = await import('../src/launcher/legacy-herdr-client.js');
    const ctrl = new AbortController();
    const children: (import('node:child_process').ChildProcess & { stdout: InstanceType<typeof PassThrough>; stderr: InstanceType<typeof PassThrough> })[] = [];
    const calls: string[][] = [];
    const client = new HerdrClient({ spawnFn: (_exe, args) => {
      calls.push([...args]);
      const child = new EventEmitter() as typeof children[number];
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn(() => true);
      children.push(child);
      queueMicrotask(() => {
        child.emit('spawn');
        if (args[1] === 'send-keys') { if (mode === 'cancel') ctrl.abort(); return; }
        child.stdout.write(args[1] === 'list' ? JSON.stringify({ panes: [{ pane_id: 'p1', terminal_id: 't1', workspace_id: 'w1', agent_status: 'idle' }] }) : 'ok');
        child.emit('close', 0, null);
      });
      return child;
    } });
    const events: Readonly<DeliveryEvidenceV2>[] = [];
    const delivery = createDelivery({ client: client.deliveryV2, signal: ctrl.signal,
      env: { TUT_HERDR_TIMEOUT_MS: '20', TUT_STATUS_FLIP_TIMEOUT_MS: '100' }, stderr: () => undefined,
      onGiveUp: async (_, e) => { events.push(e); } });
    const result = await delivery.deliver({ target, prompt: 'one prompt', branch: 'born' });
    expect(result).toMatchObject({ exitCode: 0, retry: 'forbidden', reason: mode === 'cancel' ? 'cancelled' : 'enter-uncertain' });
    expect(calls.map(c => c[1])).toEqual(['list', 'send-text', 'send-keys']);
    expect(children[2]?.kill).toHaveBeenCalledWith('SIGKILL');
    const snapshot = JSON.stringify(events);
    children[2]?.stdout.write('ok'); children[2]?.emit('close', 0, null);
    children[2]?.emit('close', 0, null); // duplicate late callback
    await Promise.resolve();
    expect(JSON.stringify(events)).toBe(snapshot); expect(events).toHaveLength(1);
    expect(calls).toHaveLength(3); validEvidence(events[0]!);
  });
  it('ignores wrong-attempt status and send results', async () => {
    const f = fixture({ post: ['working'] });
    const original = f.client.readAgentStatus;
    f.client.readAgentStatus = async (...args) => ({ ...await original(...args), attemptId: 'another-attempt' });
    expect(await f.run()).toMatchObject({ reason: 'baseline-unknown' });
    expect(f.events[0]?.status_flip).toBe(false);
    const g = fixture(); const send = g.client.sendText;
    g.client.sendText = async (...args) => { const result = await send(...args); return { ...result, trace: { ...result.trace, sequence: 999 } }; };
    expect(await g.run()).toMatchObject({ reason: 'text-uncertain' }); expect(g.calls).toHaveLength(2);
  });
});

it('delivery confirmation v2 diagnostics disabled yields the same calls and terminal decision', async () => {
  const executions = [];
  for (const enabled of ['0', '1']) {
    const f = fixture({ post: ['working'] });
    const lines: string[] = [];
    const sink = createDeliveryDiagnostics({ env: { TUT_DELIVERY_DIAG: enabled }, stderr: s => lines.push(s) });
    const delivery = createDelivery({ client: f.client, now: () => 0, env: {}, diagnostics: sink, stderr: () => undefined });
    executions.push({ result: await delivery.deliver({ target, prompt: 'original', branch: 'born' }), phases: f.calls.map(c => c.phase) });
    expect(lines.length > 0).toBe(enabled === '1');
  }
  expect(executions[0]).toEqual(executions[1]);
});

it('delivery confirmation v2 deadline already reached starts no calls, even when the clock advances at the boundary', async () => {
  const f = fixture({ deadline: 0 });
  expect(await f.run()).toMatchObject({ kind: 'not-sent', retry: 'inspect-first' });
  expect(f.calls).toHaveLength(0);
});

it('delivery confirmation v2 diagnostic work cannot change the already frozen terminal evidence', async () => {
  const f = fixture({ post: ['working'] });
  let time = 0;
  let evidence: Readonly<DeliveryEvidenceV2> | undefined;
  const d = createDelivery({ client: f.client, now: () => time,
    env: { TUT_STATUS_FLIP_TIMEOUT_MS: '10' },
    diagnostics: { emit: line => { if (line.startsWith('working-observed')) time += 100; }, flush: async () => undefined },
    onGiveUp: async (_, e) => { evidence = e; }, stderr: () => undefined });
  expect(await d.deliver({ target, prompt: 'x', branch: 'born' })).toMatchObject({ reason: 'attribution-unavailable' });
  validEvidence(evidence!); expect(evidence?.elapsed_ms).toBe(0);
});


it('remediation audit retains stderr when diagnostics are off and persistence fails', async () => {
  const mem = memoryFs(); mem.failAppendAfter(0);
  const stderr: string[] = [];
  const sink = createRemediationAudit({ env: { TUT_DELIVERY_DIAG: '0', TUT_PROJECT_ROOT: '/proj' },
    fs: mem.fs, stderr: line => stderr.push(line) });
  sink.emit('remediation action=machine-enter reason=机器代按');
  await sink.flush();
  expect(stderr).toHaveLength(1);
  expect(stderr[0]).toContain('remediation action=machine-enter');
  expect(mem.files.size).toBe(0);
});

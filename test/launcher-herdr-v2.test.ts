import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { HerdrClient, paneIdentityFrom, type CallContext, type PaneIdentity } from '../src/launcher/legacy-herdr-client.js';
import type { DirectSpawn } from '../src/launcher/process.js';

const target = (): PaneIdentity => ({ paneId: 'p1', terminalId: 't1', workspaceId: 'w1',
  agentSession: { agent: 'codex', kind: 'session_id', value: 's1' }, serverEpoch: null, agentGeneration: null });
const call = (overrides: Partial<CallContext> = {}): CallContext => ({ attemptId: 'attempt', sequence: 1,
  deadlineMonoMs: performance.now() + 1000, signal: new AbortController().signal, ...overrides });
function fake(run: (child: ChildProcess & { stdout: PassThrough; stderr: PassThrough }) => void) {
  let child: ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  const spawnFn = vi.fn<DirectSpawn>(() => {
    child = new EventEmitter() as typeof child;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => run(child));
    return child;
  });
  return { client: new HerdrClient({ spawnFn }), spawnFn, child: () => child! };
}
function response(stdout: string, code = 0, signal: NodeJS.Signals | null = null) {
  return fake(child => { child.emit('spawn'); child.stdout.write(stdout); child.emit('close', code, signal); });
}
const pane = (extra: Record<string, unknown> = {}) => ({ pane_id: 'p1', terminal_id: 't1', workspace_id: 'w1',
  agent_session: { agent: 'codex', kind: 'session_id', value: 's1', source: 'hook' }, revision: 10, agent_status: 'idle', ...extra });

describe('delivery confirmation v2 transport contract (legacy methods remain separate)', () => {
  it.each(['', 'ok', '{"result":{"type":"ok"}}', '{"id":"cli:pane:send-text","result":{"type":"ok"}}'])('accepts known ACK %j', async ack => {
    const f = response(ack);
    expect(await f.client.deliveryV2.sendText(target(), '你好 $()\ntext', call())).toMatchObject({ kind: 'sent', trace: { spawned: true, exitCode: 0, fault: null } });
    expect(f.spawnFn.mock.calls[0]?.[1]).toEqual(['pane', 'send-text', 'p1', '你好 $()\ntext']);
    expect(f.spawnFn.mock.calls[0]?.[2]?.shell).toBe(false);
  });
  it.each(['garbage', '{', 'null', '{"ok":true}', '{"result":{"type":"ok"},"error":"failed"}', '{"result":{"type":"ok","success":false}}'])('rejects unknown/contradictory ACK %j', async ack => {
    expect(await response(ack).client.deliveryV2.sendEnter(target(), call())).toMatchObject({ kind: 'uncertain', trace: { fault: 'INVALID_ACK', spawned: true } });
  });
  it('does not start invalid, expired or cancelled calls', async () => {
    const f = response('ok');
    const cancelled = new AbortController(); cancelled.abort();
    for (const [ctx, text, fault] of [[call(), 'bad\0text', 'INVALID_ARGUMENT'],
      [call({ deadlineMonoMs: performance.now() - 1 }), 'text', 'NOT_STARTED'],
      [call({ signal: cancelled.signal }), 'text', 'ABORTED']] as const) {
      expect(await f.client.deliveryV2.sendText(target(), text, ctx)).toMatchObject({ kind: 'not-sent', trace: { spawned: false, fault } });
    }
    expect(f.spawnFn).not.toHaveBeenCalled();
  });
  it('classifies synchronous and asynchronous factual spawn failures', async () => {
    const sync = new HerdrClient({ spawnFn: () => { throw new Error('spawn failed'); } });
    const async = fake(child => child.emit('error', Object.assign(new Error('no executable'), { code: 'ENOENT' })));
    for (const client of [sync, async.client]) expect(await client.deliveryV2.sendEnter(target(), call())).toMatchObject({ kind: 'not-sent', trace: { spawned: false, fault: 'SPAWN_FAILED' } });
  });
  it.each([[7, null, 'EXIT_ERROR'], [null, 'SIGTERM', 'SIGNAL']] as const)('classifies started exit %s/%s', async (code, signal, fault) => {
    const f = fake(child => { child.emit('spawn'); child.emit('close', code, signal); });
    expect(await f.client.deliveryV2.sendEnter(target(), call())).toMatchObject({ kind: 'uncertain', trace: { spawned: true, fault } });
  });
  it('keeps an unclassified pre-spawn error uncertain', async () => {
    const f = fake(child => child.emit('error', new Error('unknown stage')));
    expect(await f.client.deliveryV2.sendEnter(target(), call())).toMatchObject({ kind: 'uncertain', trace: { fault: 'INTERNAL' } });
  });
  it('settles deadline without close, ignores late data/close and removes abort listener', async () => {
    const f = fake(child => child.emit('spawn'));
    const ctrl = new AbortController(); const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    const result = await f.client.deliveryV2.sendEnter(target(), call({ deadlineMonoMs: performance.now() + 20, signal: ctrl.signal }));
    expect(result).toMatchObject({ kind: 'uncertain', trace: { spawned: true, fault: 'TIMEOUT' } });
    expect(f.child().kill).toHaveBeenCalledWith('SIGKILL');
    f.child().stdout.write('ok'); f.child().emit('close', 0, null); ctrl.abort();
    expect(result.trace.fault).toBe('TIMEOUT'); expect(remove).toHaveBeenCalled();
    expect(f.child().stdout.listenerCount('data')).toBe(0);
  });
  it('cancels after spawn without pretending remote writes were undone', async () => {
    const ctrl = new AbortController();
    const f = fake(child => { child.emit('spawn'); ctrl.abort(); });
    expect(await f.client.deliveryV2.sendEnter(target(), call({ signal: ctrl.signal }))).toMatchObject({ kind: 'uncertain', trace: { spawned: true, fault: 'ABORTED' } });
  });
  it('checks the clock on close even when timeout callback has not run', async () => {
    const f = fake(child => { child.emit('spawn'); const end = performance.now() + 15;
      while (performance.now() < end) { /* delayed event loop */ }
      child.stdout.write('ok'); child.emit('close', 0, null);
    });
    expect(await f.client.deliveryV2.sendEnter(target(), call({ deadlineMonoMs: performance.now() + 5 }))).toMatchObject({ kind: 'uncertain', trace: { fault: 'TIMEOUT' } });
  });
  it('preserves permissive legacy ACK and never converts v2 through a boolean', async () => {
    const f = response('legacy free-form acknowledgement');
    expect(await f.client.sendText('p1', 'text')).toEqual({ ok: true });
    expect((await f.client.deliveryV2.sendText(target(), 'text', call())).kind).toBe('uncertain');
  });
});

describe('raw exact pane status and identity', () => {
  it.each(['idle', 'working', 'blocked', 'done', 'unknown'])('reads %s without attribution', async status => {
    const result = await response(JSON.stringify({ result: { panes: [pane({ agent_status: status })] } })).client.readAgentStatus(target(), call());
    expect(result).toMatchObject({ status, error: null, detectorSource: null, detectorAgeMs: null, attribution: 'unavailable',
      identity: { serverEpoch: null, agentGeneration: null } });
  });
  it.each([
    ['broken', 'INVALID_JSON'], ['{}', 'INVALID_SHAPE'], ['{"panes":null}', 'INVALID_SHAPE'],
    [JSON.stringify({ panes: [pane({ pane_id: 'p10', label: 'p1' })] }), 'PANE_MISSING'],
    [JSON.stringify({ panes: [pane(), { pane_id: 'p1' }] }), 'PANE_DUPLICATE'],
    [JSON.stringify({ panes: [pane({ agent_status: null })] }), 'STATUS_MISSING'],
    [JSON.stringify({ panes: [pane({ agent_status: 'busy' })] }), 'STATUS_INVALID'],
    [JSON.stringify({ panes: [pane({ terminal_id: 't2' })] }), 'IDENTITY_CHANGED'],
    [JSON.stringify({ panes: [pane({ terminal_id: null })] }), 'IDENTITY_CHANGED'],
    [JSON.stringify({ panes: [pane({ terminal_id: 42 })] }), 'IDENTITY_CHANGED'],
    [JSON.stringify({ panes: [pane({ workspace_id: 'w2' })] }), 'IDENTITY_CHANGED'],
    [JSON.stringify({ panes: [pane({ agent_session: { agent: 'codex', kind: 'session_id', value: 's2' } })] }), 'IDENTITY_CHANGED'],
    [JSON.stringify({ panes: [pane({ revision: -1 })] }), 'INVALID_SHAPE'],
  ])('reports exact error %s -> %s', async (stdout, error) => {
    expect(await response(stdout).client.readAgentStatus(target(), call())).toMatchObject({ status: 'unknown', error });
  });
  it('does not invent absent identity fields or use session source as detector source', () => {
    expect(paneIdentityFrom({ pane_id: 'p1' })).toEqual({ paneId: 'p1', terminalId: null, workspaceId: null, agentSession: null, serverEpoch: null, agentGeneration: null });
  });
  it('rejects revision regression within an attempt and retains the high water mark', async () => {
    let revision = 10;
    const f = fake(child => { child.emit('spawn'); child.stdout.write(JSON.stringify({ panes: [pane({ revision })] })); child.emit('close', 0, null); });
    const frozen = target();
    expect((await f.client.readAgentStatus(frozen, call())).error).toBeNull();
    revision = 9;
    expect((await f.client.readAgentStatus(frozen, call({ sequence: 2 }))).error).toBe('IDENTITY_CHANGED');
    revision = 8;
    expect((await f.client.readAgentStatus(frozen, call({ sequence: 3 }))).error).toBe('IDENTITY_CHANGED');
    expect((await f.client.readAgentStatus(frozen, call({ attemptId: 'next', sequence: 1 }))).error).toBeNull();
  });
  it('returns transport read faults rather than a rejection', async () => {
    expect(await response('', 3).client.readAgentStatus(target(), call())).toMatchObject({ status: 'unknown', error: 'EXIT_ERROR' });
  });
});

// Independent receiver: consumes bytes on a separate socket, never reads status,
// delivery diagnostics, or terminal screen rules. This is NOT a Herdr detector test.
describe('independent byte receiver and contract consumer', () => {
  it('records actual text before a failing control exit; one escalation, no Enter, exit 0', async () => {
    const { createServer } = await import('node:net');
    const { spawn } = await import('node:child_process');
    const records: { bytes: Buffer; received: number; enterConsumed: number | null }[] = [];
    const server = createServer(socket => {
      socket.on('data', bytes => {
        records.push({ bytes, received: performance.now(), enterConsumed: bytes.includes(13) ? performance.now() : null });
        socket.end('received');
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as import('node:net').AddressInfo;
    const calls: readonly string[][] = [];
    const spawnFn: DirectSpawn = (_file, args) => {
      (calls as string[][]).push([...args]);
      const bytes = args[1] === 'send-text' ? args[3]! : '\r';
      return spawn(process.execPath, ['-e', `
        const net = require('node:net');
        const socket = net.connect(Number(process.argv[1]), '127.0.0.1', () => socket.write(Buffer.from(process.argv[2], 'base64')));
        socket.on('data', () => { socket.destroy(); process.exit(Number(process.argv[3])); });
      `, String(address.port), Buffer.from(bytes).toString('base64'), args[1] === 'send-text' ? '7' : '0'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    };
    try {
      const client = new HerdrClient({ spawnFn }).deliveryV2;
      const result = await client.sendText(target(), 'independent truth 你好', call());
      let escalations = 0;
      // Minimal A seam consumer; B will integrate this branch into real delivery.
      const exitCode = result.kind === 'uncertain' ? (++escalations, 0) : 1;
      expect(result).toMatchObject({ kind: 'uncertain', trace: { spawned: true, fault: 'EXIT_ERROR' } });
      expect(Buffer.concat(records.map(r => r.bytes)).toString()).toBe('independent truth 你好');
      expect(records.every(r => r.enterConsumed === null)).toBe(true);
      expect(calls.map(c => c[1])).toEqual(['send-text']);
      expect(escalations).toBe(1); expect(exitCode).toBe(0);

    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

it('independently timestamps actual Enter bytes on a separate receiver channel', async () => {
  const { createServer } = await import('node:net');
  const { spawn } = await import('node:child_process');
  const bytes: Buffer[] = [];
  let consumedAt: number | null = null;
  const server = createServer(socket => socket.on('data', chunk => {
    bytes.push(chunk);
    if (chunk.includes(13)) consumedAt = performance.now();
    socket.end('received');
  }));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as import('node:net').AddressInfo;
  try {
    const client = new HerdrClient({ spawnFn: (_file, args) => spawn(process.execPath, ['-e', `
      const socket = require('node:net').connect(Number(process.argv[1]), '127.0.0.1', () => socket.write(Buffer.from(process.argv[2], 'hex')));
      socket.on('data', () => { socket.destroy(); process.stdout.write('ok'); });
    `, String(port), args[1] === 'send-keys' && args[3] === 'Enter' ? '0d' : '00'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false }) });
    const started = performance.now();
    expect((await client.deliveryV2.sendEnter(target(), call())).kind).toBe('sent');
    expect(Buffer.concat(bytes)).toEqual(Buffer.from([13]));
    expect(consumedAt).not.toBeNull(); expect(consumedAt!).toBeGreaterThanOrEqual(started);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each([null, undefined])('returns an invalid status sample for missing call %s', async missing => {
  const f = response('ok');
  await expect(f.client.readAgentStatus(target(), missing as unknown as CallContext))
    .resolves.toMatchObject({ status: 'unknown', error: 'INVALID_ARGUMENT', attemptId: '', sequence: 0 });
  expect(f.spawnFn).not.toHaveBeenCalled();
});

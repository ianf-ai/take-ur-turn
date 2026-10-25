import { afterEach, expect, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, closeSync, readFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { RunStore, complete, type RunMeta } from '../src/core/run/store.js';
import { WindowsStopController, type WindowsBroker } from '../src/core/run/windows-controller.js';
import { WINDOWS_PROTOCOL, windowsMeta, type WindowsRunMeta, type WindowsObservation, type BrokerBinding } from '../src/core/run/windows-protocol.js';
import { Writable } from 'node:stream';
import { stopRun, attachRun } from '../src/core/run/control-windows.js';
import { BrokerClient, MAX_BROKER_FRAME } from '../src/core/run/windows-broker.js';
import { taskOccupants } from '../src/core/run/admission.js';
import { requireRunPlatform } from '../src/core/run/control-contract.js';
vi.mock('../src/core/hub/windows-run-file.js', async original => ({
    ...await original<typeof import('../src/core/hub/windows-run-file.js')>(),
    readWindowsRunMeta: (file: string) => readFileSync(file),
}));
// Fake broker/controller assertions retain real Store writes. Native metadata
// handle security is exercised by windows-run-file.test.mjs, not this seam.
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0))
    rmSync(r, { recursive: true, force: true }); });
async function fixture(request = true) {
    // Resolve TMPDIR symlinks (/var -> /private/var): attach now opens
    // run files with NOFOLLOW_ANY, which rightly rejects symlinked ancestors.
    const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'tut-windows-'));
    roots.push(root);
    const store = new RunStore(root);
    const id = store.create();
    closeSync(store.openLog(id, true));
    const at = new Date().toISOString();
    const meta: WindowsRunMeta = { run_id: id, task_id: 'windows-test', pid: 900001, pgid: 900001, supervisor_pid: 900002, argv: ['fake.exe'], cwd: root, started_at: at, status: request ? 'stopped' : 'running', control_protocol: WINDOWS_PROTOCOL,
        windows: { identity: { attempt_id: 'test', broker_pid: 900003, broker_creation_time: '1234', root_creation_time: '1235', job_id: 'b'.repeat(32) } },
        ...(request ? { stopped_at: at, stopped_by: 'test', stop_request: { id: 'a'.repeat(32), requested_at: at, requested_by: 'test', phase: 'requested', signals: [], actions: [] } } : {}) };
    await store.initialize(id, meta);
    return { store, id, meta };
}
function environment(f: Awaited<ReturnType<typeof fixture>>) {
    let time = 0, seq = 0;
    let observation: WindowsObservation = { root_exited: false, job_empty: false };
    const calls: string[] = [];
    const broker: WindowsBroker = { get nextSeq() { return seq + 1; }, observe: vi.fn(async () => { seq++; return observation; }), action: vi.fn(async (action, operation) => {
            const m = windowsMeta(f.store.read(f.id));
            expect(m.stop_request!.actions.at(-1)).toMatchObject({ seq: seq + 1, operation, action, delivery: 'uncertain' });
            seq++;
            calls.push(action);
            return { targets: [{ pid: m.pid, creation_time: '1235', return_code: 0 }] };
        }) };
    const controller = new WindowsStopController(f.store, f.meta, broker, { now: () => time });
    return { controller, broker, calls, advance: (n: number) => { time += n; }, observe: (o: WindowsObservation) => { observation = o; } };
}
it('freezes the original POSIX source byte-for-byte and preserves the legacy platform guard', async () => {
    const original = readFileSync(new URL('../src/core/run/control-posix.ts', import.meta.url));
    expect(createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex')).toBe('c587f0b51c90a5498e78a10c9e12556fa2b609b8');
    expect(() => requireRunPlatform('win32')).not.toThrow();
});
it('serializes overlapping steps and performs Break /T /F once with separate budgets and durable intents', async () => {
    const f = await fixture();
    const e = environment(f);
    await Promise.all([e.controller.step(), e.controller.step(), e.controller.step()]);
    expect(e.calls).toEqual(['break']);
    e.advance(4999);
    await e.controller.step();
    expect(e.calls).toHaveLength(1);
    e.advance(1);
    await e.controller.step();
    expect(e.calls).toEqual(['break', 'taskkill-tree']);
    e.advance(5000);
    await e.controller.step();
    expect(e.calls).toEqual(['break', 'taskkill-tree', 'taskkill-tree-force']);
    e.observe({ root_exited: true, job_empty: true, exit_code: 3221225786 });
    await e.controller.step();
    expect(f.store.read(f.id).stop_request?.result).toMatchObject({ success: true, outcome: 'forced-kill', exit_code: 3221225786, scope: 'root-and-owned-job', descendants_check: 'job-members-only' });
    expect(complete(f.store.read(f.id))).toBe(true);
    await e.controller.step();
    expect(e.calls).toHaveLength(3);
});
it('records Break termination honestly; root exit alone never frees Job occupancy', async () => {
    const f = await fixture();
    const e = environment(f);
    await e.controller.step();
    e.observe({ root_exited: true, job_empty: false, exit_code: 0 });
    await e.controller.step();
    expect(complete(f.store.read(f.id))).toBe(false);
    e.observe({ root_exited: true, job_empty: true, exit_code: 3221225786 });
    await e.controller.step();
    expect(f.store.read(f.id).stop_request?.result?.outcome).toBe('forced-break');
    expect(e.calls).toHaveLength(1);
});
it.each(['delivery-uncertain: helper timeout', 'delivery-uncertain: write EPIPE', 'observer-lost: broker disconnected'])('%s retains occupation and never upgrades or replays', async (message) => {
    const f = await fixture();
    const e = environment(f);
    await e.controller.step();
    e.advance(5000);
    vi.mocked(e.broker.action).mockRejectedValueOnce(new Error(message));
    await e.controller.step();
    const m = windowsMeta(f.store.read(f.id));
    expect(m.stop_request!.actions[1]!.delivery).toBe('uncertain');
    expect(m.stop_request!.result).toMatchObject({ success: false, error: message });
    expect(taskOccupants(f.store, 'windows-test')).toHaveLength(1);
    e.advance(10000);
    await e.controller.step();
    expect(e.calls).toEqual(['break']);
    const replacement = environment(f);
    await replacement.controller.step();
    expect(replacement.calls).toHaveLength(0);
});
it('does not send after intent write failure; lost receipt persistence cannot become success', async () => {
    for (const failedWrite of [1, 2]) {
        const f = await fixture();
        const e = environment(f);
        let count = 0;
        const update = f.store.updateMeta.bind(f.store);
        vi.spyOn(f.store, 'updateMeta').mockImplementation((id, fn) => ++count === failedWrite ? Promise.reject(new Error('disk failed')) : update(id, fn));
        await e.controller.step();
        expect(e.calls).toHaveLength(failedWrite === 1 ? 0 : 1);
        expect(complete(f.store.read(f.id))).toBe(false);
        expect(f.store.read(f.id).stop_request?.result?.success).toBe(false);
    }
});
it('a fresh controller refuses existing action intents even if an observation would say empty', async () => {
    const f = await fixture();
    const e = environment(f);
    await e.controller.step();
    const fresh = environment(f);
    fresh.observe({ root_exited: true, job_empty: true, exit_code: 0 });
    await fresh.controller.step();
    expect(fresh.calls).toHaveLength(0);
    expect(f.store.read(f.id).stop_request?.result?.success).toBe(false);
});
it('concurrent CLI stop and close stop join one durable operation and return its same result', async () => {
    const f = await fixture(false);
    const e = environment(f);
    const update = f.store.updateMeta.bind(f.store);
    vi.spyOn(f.store, 'updateMeta').mockImplementation((id, fn) => update(id, m => { const next = fn(m); return { ...next, ...(next.identity_probe ? { identity_ack: next.identity_probe } : {}) }; }));
    const sleep = async () => { await e.controller.step(); e.observe({ root_exited: true, job_empty: true, exit_code: 1 }); await e.controller.step(); };
    const results = await Promise.all([stopRun(f.store, f.id, { probe: () => true, sleep }), stopRun(f.store, f.id, { probe: () => true, sleep })]);
    expect(results.map(r => r.success)).toEqual([true, true]);
    expect(results.filter(r => r.requested)).toHaveLength(1);
    expect(e.calls).toEqual(['break']);
    expect(results[0]!.meta.stop_request!.id).toBe(results[1]!.meta.stop_request!.id);
    const before = readFileSync(path.join(f.store.directory(f.id), 'meta.json'), 'utf8');
    expect((await stopRun(f.store, f.id)).requested).toBe(false);
    expect(readFileSync(path.join(f.store.directory(f.id), 'meta.json'), 'utf8')).toBe(before);
});
it('stale broker challenges cannot authorize a request, and lost supervisor cannot be adopted', async () => {
    const f = await fixture(false);
    let time = 0;
    await expect(stopRun(f.store, f.id, { probe: () => true, identityMs: 50, now: () => time, sleep: async (n) => { time += n; } })).rejects.toThrow('identity-unverified');
    expect(f.store.read(f.id).stop_request).toBeUndefined();
    await expect(stopRun(f.store, f.id, { probe: () => false })).rejects.toThrow('identity-unverified');
});
it('the default Windows observer waits for a committed terminal result beyond thirty seconds', async () => {
    const f = await fixture();
    const e = environment(f);
    await e.controller.step(); e.advance(5000); await e.controller.step();
    e.advance(5000); await e.controller.step();
    let time = 0;
    const result = await stopRun(f.store, f.id, { probe: () => true, now: () => time, sleep: async () => {
        time += 1000;
        if (time === 35000) {
            e.observe({ root_exited: true, job_empty: true, exit_code: 1 });
            await e.controller.step();
        }
    } });
    expect(time).toBe(35000);
    expect(result).toMatchObject({ success: true, requested: false });
    expect(e.calls).toEqual(['break', 'taskkill-tree', 'taskkill-tree-force']);
    expect(complete(result.meta)).toBe(true);
});
it.each([undefined, 0, 1000])('an unfinished Windows request stays bounded with waitMs=%s and is never rewritten', async waitMs => {
    const f = await fixture();
    const before = readFileSync(path.join(f.store.directory(f.id), 'meta.json'));
    let time = 0;
    const result = await stopRun(f.store, f.id, { ...(waitMs === undefined ? {} : { waitMs }),
        probe: () => true, now: () => time, sleep: async () => { time += 250; } });
    expect(result).toMatchObject({ success: false, requested: false });
    expect(result.result).toContain('incomplete: requested; request not restarted');
    if (waitMs === undefined) {
        expect(time).toBeGreaterThan(30000);
        expect(time).toBeLessThanOrEqual(60000);
    } else expect(time).toBe(waitMs);
    expect(readFileSync(path.join(f.store.directory(f.id), 'meta.json'))).toEqual(before);
});
class FakeSocket extends EventEmitter {
    written: Buffer[] = [];
    destroyed = false;
    write(value: Buffer, callback: (e?: Error) => void) { this.written.push(value); callback(); return true; }
    destroy() { this.destroyed = true; return this; }
}
const binding: BrokerBinding = { protocol: WINDOWS_PROTOCOL, run_id: 'r', attempt_id: 'a', broker_pid: 123, broker_creation_time: '1234', nonce: 'fresh' };
it.each(['write-first', 'error-first', 'close-first'] as const)('pipe loss preserves the first honest rejection (%s) without new control or takeover', async order => {
    const socket = new FakeSocket();
    let writeCallback!: (e?: Error) => void;
    vi.spyOn(socket, 'write').mockImplementation((frame, callback) => {
        socket.written.push(frame);
        writeCallback = callback;
        return true;
    });
    const client = new BrokerClient(socket as unknown as Socket, binding);
    const pending = client.observe().catch((error: Error) => error);
    const pipeError = new Error('write EPIPE');
    if (order === 'write-first') writeCallback(pipeError);
    else if (order === 'error-first') socket.emit('error', pipeError);
    else socket.emit('close');
    // The remaining callbacks cannot replace the first failure or reopen control.
    writeCallback(pipeError);
    socket.emit('error', pipeError);
    socket.emit('close');
    const failure = await pending as Error;
    expect(failure.message).toBe(order === 'write-first' ? 'delivery-uncertain: write EPIPE'
        : order === 'error-first' ? 'observer-lost: write EPIPE'
        : 'observer-lost: broker disconnected; target may still be alive');
    for (const operation of ['challenge', 'break', 'taskkill-tree', 'taskkill-tree-force'])
        await expect(client.request(operation)).rejects.toBe(failure);
    expect(socket.written).toHaveLength(1);
    expect(socket.destroyed).toBe(true);

    // Model the supervisor's durable error publication, then call the real stop
    // entry twice: a persisted observation failure cannot authorize a new stop.
    const f = await fixture(false);
    await f.store.updateMeta(f.id, m => ({ ...m, windows: { ...m.windows!, error: failure.message } }));
    const before = readFileSync(path.join(f.store.directory(f.id), 'meta.json'));
    for (let attempt = 0; attempt < 2; attempt++)
        await assert.rejects(stopRun(f.store, f.id, { probe: () => true }), { message: /^(observer-lost|delivery-uncertain):/ });
    expect(readFileSync(path.join(f.store.directory(f.id), 'meta.json'))).toEqual(before);
    expect(f.store.read(f.id).identity_probe).toBeUndefined();
    expect(f.store.read(f.id).stop_request).toBeUndefined();
    expect(complete(f.store.read(f.id))).toBe(false);
    expect(taskOccupants(f.store, 'windows-test')).toHaveLength(1);
});
it('rejects stale nonce / wrong sequence / malformed and oversized receipts, never resending', async () => {
    for (const mutation of [{ nonce: 'old' }, { seq: 2 }, { broker_creation_time: 'old' }]) {
        const socket = new FakeSocket();
        const client = new BrokerClient(socket as unknown as Socket, binding, 50);
        const pending = client.request('challenge');
        socket.emit('data', Buffer.from(JSON.stringify({ ...binding, seq: 1, value: { challenge: 'x' }, ...mutation }) + '\n'));
        await expect(pending).rejects.toThrow('identity-unverified');
        await expect(client.request('observe')).rejects.toThrow();
        expect(socket.written).toHaveLength(1);
    }
    const socket = new FakeSocket();
    const client = new BrokerClient(socket as unknown as Socket, binding, 50);
    const pending = client.request('observe');
    socket.emit('data', Buffer.alloc(MAX_BROKER_FRAME + 1));
    await expect(pending).rejects.toThrow('oversized');
});
it('handles split UTF-8 frames and poisons the channel after timeout so late replies cannot trigger escalation', async () => {
    const socket = new FakeSocket();
    const client = new BrokerClient(socket as unknown as Socket, binding, 10);
    const first = client.request('challenge');
    const bytes = Buffer.from(JSON.stringify({ ...binding, seq: 1, value: { challenge: '你好' } }) + '\n');
    for (const b of bytes)
        socket.emit('data', Buffer.from([b]));
    expect(await first).toEqual({ challenge: '你好' });
    await expect(client.request('break')).rejects.toThrow('delivery-uncertain');
    socket.emit('data', Buffer.from(JSON.stringify({ ...binding, seq: 2, value: { targets: [] } }) + '\n'));
    await expect(client.request('taskkill-tree')).rejects.toThrow('delivery-uncertain');
    expect(socket.written).toHaveLength(2);
});
it('Windows validation rejects reordered actions, fake POSIX result scopes and changed native identity', async () => {
    const f = await fixture();
    const e = environment(f);
    await e.controller.step();
    await expect(f.store.updateMeta(f.id, m => ({ ...m, stop_request: { ...windowsMeta(m).stop_request!, actions: [{ ...windowsMeta(m).stop_request!.actions[0]!, action: 'taskkill-tree-force' }] } } as RunMeta))).rejects.toThrow('action evidence');
    await f.store.updateMeta(f.id, m => ({ ...m, windows: { ...m.windows!, identity: { ...m.windows!.identity, broker_creation_time: '999' } } }));
    await expect(e.controller.step()).rejects.toThrow('identity');
});

// Interleave real file append and metadata completion with output backpressure.
it.each(['complete', 'observer-lost', 'stop-failed'] as const)('attach drains the final bytes before %s', async terminal => {
    const f = await fixture(terminal === 'stop-failed');
    const append = (bytes: Buffer | string) => {
        const fd = f.store.openLog(f.id, true);
        try { writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes) : bytes); } finally { closeSync(fd); }
    };
    append('first\n');
    const tail = Buffer.from('final 尾部 without newline');
    const chunks: Buffer[] = [];
    let writes = 0;
    const out = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        if (++writes !== 1) { callback(); return; }
        append(tail);
        const finish = terminal === 'stop-failed'
            ? environment(f).controller.fail(new Error('delivery-uncertain'))
            : f.store.updateMeta(f.id, m => terminal === 'complete'
                ? { ...m, status: 'exited', ended_at: new Date().toISOString() }
                : { ...m, windows: { ...m.windows!, error: 'observer-lost' } });
        void finish.then(() => callback(), callback);
    } });
    if (terminal === 'complete') expect(await attachRun(f.store, f.id, out)).toBe(0);
    else await expect(attachRun(f.store, f.id, out)).rejects.toThrow(/observer-lost|unconfirmed|delivery-uncertain/);
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([Buffer.from('first\n'), tail]));
    expect(writes).toBe(2);
});
it('attach honors cancellation while backpressured on the final drain', async () => {
    const f = await fixture(false); const abort = new AbortController();
    const append = (s: string) => { const fd = f.store.openLog(f.id, true); try { writeSync(fd, s); } finally { closeSync(fd); } };
    append('first\n'); let writes = 0;
    const out = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) {
        if (++writes === 1) {
            append('tail');
            void f.store.updateMeta(f.id, m => ({ ...m, status: 'exited', ended_at: new Date().toISOString() })).then(() => callback(), callback);
        } else setImmediate(() => { abort.abort(); callback(); });
    } });
    expect(await attachRun(f.store, f.id, out, abort.signal)).toBe(130);
    expect(writes).toBe(2);
});

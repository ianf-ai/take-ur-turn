import { afterEach, expect, it, vi } from 'vitest';
import type { RunMeta } from '../src/core/run/store.js';
import type { StartRequest } from '../src/core/run/supervisor.js';
import { WINDOWS_PROTOCOL } from '../src/core/run/windows-protocol.js';

const state = vi.hoisted(() => ({
    time: 0, meta: undefined as RunMeta | undefined, probeAt: 0,
    ackAt: 0, challenge: 'a'.repeat(64), replies: [] as string[],
    observations: 0, mismatch: false, closed: false,
}));
vi.mock('../src/core/run/store.js', async original => ({
    ...await original<typeof import('../src/core/run/store.js')>(),
    // Model each safe read's measured Windows startup cost, including reads
    // made inside the real controller and the locked observation RMW.
    RunStore: class {
        directory() { return 'unused'; }
        async initialize(_id: string, meta: RunMeta) { state.meta = structuredClone(meta); }
        read() { state.time += 1500; return structuredClone(state.meta!); }
        async updateMeta(_id: string, fn: (m: RunMeta) => RunMeta) {
            state.meta = fn(this.read());
            if (state.meta.identity_ack === state.challenge && !state.ackAt) state.ackAt = state.time;
            return structuredClone(state.meta);
        }
    },
    delay: async (ms: number) => { state.time += ms; },
}));
vi.mock('../src/core/run/windows-broker.js', () => ({
    launchBroker: async () => ({
        request: async (operation: string, payload?: { challenge: string }) => {
            if (operation === 'create-target') return {
                pid: 900001,
                identity: { attempt_id: 'test', broker_pid: 900003, broker_creation_time: '1234', root_creation_time: '1235', job_id: 'b'.repeat(32) },
            };
            expect(operation).toBe('challenge');
            state.replies.push(payload!.challenge);
            return { challenge: state.mismatch ? 'wrong' : payload!.challenge };
        },
        observe: async () => {
            if (++state.observations === 1) {
                // The caller publishes immediately after the supervisor's
                // top-of-loop read. The observation transaction sees it first.
                state.meta!.identity_probe = state.challenge;
                state.probeAt = state.time;
                return { root_exited: false, job_empty: false };
            }
            return { root_exited: true, job_empty: true, exit_code: 0 };
        },
        close: () => { state.closed = true; },
    }),
}));
import { supervise } from '../src/core/run/supervisor-windows.js';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });
async function run(mismatch = false) {
    Object.assign(state, { time: 0, meta: undefined, probeAt: 0, ackAt: 0, replies: [], observations: 0, mismatch, closed: false });
    // Exercise the loop without touching the test runner's IPC channel.
    const connected = Object.getOwnPropertyDescriptor(process, 'connected');
    Object.defineProperty(process, 'connected', { configurable: true, value: false });
    try {
        await supervise({ root: process.cwd(), id: '20261024T000000000Z-aaaaaaaa', argv: ['fake.exe'], cwd: process.cwd() } as StartRequest);
    } finally {
        if (connected) Object.defineProperty(process, 'connected', connected);
        else Reflect.deleteProperty(process, 'connected');
    }
}
it('answers a probe first seen by observation publication within the unchanged 7s identity window', async () => {
    await run();
    expect(state.replies).toEqual([state.challenge]);
    // Without handling the observation's returned snapshot, three redundant
    // reads defer the reply to the next poll: 7600ms with these same costs.
    expect(state.ackAt - state.probeAt).toBe(3000);
    expect(state.ackAt - state.probeAt).toBeLessThan(7000);
    expect(state.meta).toMatchObject({ control_protocol: WINDOWS_PROTOCOL, identity_ack: state.challenge, status: 'exited', exit_code: 0 });
    expect(state.meta!.stop_request).toBeUndefined();
    expect(state.closed).toBe(true);
});
it('a mismatched native receipt still fails closed without publishing an ack or stop request', async () => {
    await run(true);
    expect(state.replies).toEqual([state.challenge]);
    expect(state.ackAt).toBe(0);
    expect(state.meta!.identity_ack).toBeUndefined();
    expect(state.meta!.stop_request).toBeUndefined();
    expect(state.meta!.ended_at).toBeUndefined();
    expect(state.meta!.windows!.error).toContain('native broker challenge mismatch');
    expect(state.closed).toBe(true);
});

/** Real Win32 acceptance, executed only on Windows; neutral finite-lived targets. */
import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore, complete, delay, probe } from '../src/core/run/store.js';
const { startRun, stopRun } = await import(path.resolve('dist/core/run/control-windows.js')) as typeof import('../src/core/run/control-windows.js');
import { windowsMeta } from '../src/core/run/windows-protocol.js';
import { taskOccupants } from '../src/core/run/admission.js';
const native = it.skipIf(process.platform !== 'win32');
async function until(fn: () => boolean, ms = 45000) { const end = performance.now() + ms; while (!fn()) {
    if (performance.now() > end)
        throw new Error('native condition timed out');
    await delay(50);
} }
native('creates a hidden-console Job and merges concurrent stop/close requests with one Break', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tut-native-'));
    const store = new RunStore(root);
    try {
        const id = await startRun(store, [process.execPath, '-e', 'console.log("ready");setTimeout(()=>{},20000)'], root);
        const results = await Promise.all([stopRun(store, id), stopRun(store, id)]);
        expect(results.every(r => r.success)).toBe(true);
        expect(results.filter(r => r.requested)).toHaveLength(1);
        const r = windowsMeta(store.read(id)).stop_request!;
        expect(r.actions.map(a => a.action)).toEqual(['break']);
        expect(r.result?.outcome).toBe('forced-break');
        expect((await stopRun(store, id)).requested).toBe(false);
        expect(complete(store.read(id))).toBe(true);
    }
    finally {
        await delay(300);
        // Keep this native run archive for diagnosis; do not mask assertions with Windows CWD/handle cleanup errors.
    }
}, 90000);
native('runs the full Break /T /F ladder against a target that handles Break', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tut-native-'));
    const store = new RunStore(root);
    try {
        const id = await startRun(store, [process.execPath, '-e', 'process.on("SIGBREAK",()=>console.log("break received"));console.log("ready");setTimeout(()=>{},120000)'], root);
        await until(() => readFileSync(path.join(store.directory(id), 'log'), 'utf8').includes('ready'));
        const result = await stopRun(store, id);
        expect(result.success).toBe(true);
        const actions = windowsMeta(result.meta).stop_request!.actions;
        expect(actions.map(a => a.action)).toEqual(['break', 'taskkill-tree', 'taskkill-tree-force']);
        expect(actions.every(a => a.delivery === 'sent')).toBe(true);
        expect(result.meta.stop_request?.result?.outcome).toBe('forced-kill');
    }
    finally {
        await delay(300);
        // Keep this native run archive for diagnosis; do not mask assertions with Windows CWD/handle cleanup errors.
    }
}, 120000);
native('broker loss leaves the original target alive, refuses takeover, and keeps occupancy', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tut-native-'));
    const store = new RunStore(root);
    const id = await startRun(store, [process.execPath, '-e', 'console.log("ready");setTimeout(()=>{},30000)'], root, 'native-loss');
    const meta = windowsMeta(store.read(id));
    process.kill(meta.windows.identity.broker_pid); // fault injection into this test-owned broker only
    await until(() => !!windowsMeta(store.read(id)).windows.error);
    expect(probe(meta.pid)).toBe(true);
    expect(complete(store.read(id))).toBe(false);
    // Socket error/close and the pending write callback may win in either order.
    const before = readFileSync(path.join(store.directory(id), 'meta.json'));
    for (let attempt = 0; attempt < 2; attempt++)
        await expect(stopRun(store, id)).rejects.toThrow(/^(observer-lost|delivery-uncertain):/);
    expect(readFileSync(path.join(store.directory(id), 'meta.json'))).toEqual(before);
    expect(store.read(id).stop_request).toBeUndefined();
    expect(taskOccupants(store, 'native-loss')).toHaveLength(1);
    await until(() => probe(meta.pid) === false); // finite target exits itself, never an unowned recovery kill
    expect(complete(store.read(id))).toBe(false);
    // Keep this native run archive for diagnosis; do not mask assertions with Windows CWD/handle cleanup errors.
}, 90000);

native('rejects native nonce/sequence replay and retains occupation after a lost receipt', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/windows-protocol.mjs', import.meta.url))], { timeout: 150000 });
    expect(result.stdout).toContain('NATIVE_REPLAY');
    expect(result.stdout).toContain('NATIVE_TIMEOUT');
    expect(result.stdout).toContain('FINITE_TARGETS_EXITED');
}, 160000);

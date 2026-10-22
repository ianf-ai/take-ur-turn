import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore, type RunMeta } from '../src/core/run/store.js';
import { stopRun, attachRun } from '../src/core/run/control.js';
import { StopController } from '../src/core/run/stop-controller.js';
import { CONTROL_PROTOCOL, STOP_SCOPE, type RootExit } from '../src/core/run/protocol.js';
import { Writable } from 'node:stream';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
async function fixture(request = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'run-control-')); roots.push(root);
  const store = new RunStore(root); const id = store.create(); closeSync(store.openLog(id, true)); // no command process in these injected tests
  const at = new Date().toISOString();
  const meta: RunMeta = { run_id: id, pid: 900001, pgid: 900001, supervisor_pid: 900002, cwd: root, argv: ['fake'], status: request ? 'stopped' : 'running', started_at: at, extra: 'retained', control_protocol: CONTROL_PROTOCOL,
    ...(request ? { stopped_at: at, stopped_by: 'fixture', stop_request: { id: 'a'.repeat(32), requested_at: at, requested_by: 'fixture', phase: 'requested', signals: [] } } : {}) };
  await store.initialize(id, meta); return { store, id, meta };
}
function environment(f: Awaited<ReturnType<typeof fixture>>) {
  let time = 0; let group: boolean | null = true; let exit: RootExit | undefined;
  const calls: { target: number; signal: string; time: number }[] = [];
  const kill = vi.fn((target: number, signal: string | number = 0) => {
    if (signal === 0) {
      if (group === null) throw Object.assign(new Error('permission'), { code: 'EPERM' });
      if (!group) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    } else {
      expect(f.store.read(f.id).stop_request!.signals.at(-1)?.delivery).toBe('uncertain');
      calls.push({ target, signal: String(signal), time });
    }
    return true as const;
  });
  const controller = new StopController(f.store, f.meta, () => exit, { kill, now: () => time });
  return { controller, calls, kill, advance: (ms: number) => { time += ms; }, setGroup: (g: boolean | null) => { group = g; }, setExit: (e: RootExit) => { exit = e; } };
}
it('only signals the root INT, then group TERM/KILL after separate full budgets; final persistence defines completion', async () => {
  const f = await fixture(); const e = environment(f);
  await e.controller.step(); expect(e.calls).toEqual([{ target: 900001, signal: 'SIGINT', time: 0 }]);
  e.advance(4999); await e.controller.step(); expect(e.calls).toHaveLength(1);
  e.advance(1); await e.controller.step(); expect(e.calls[1]).toEqual({ target: -900001, signal: 'SIGTERM', time: 5000 });
  e.advance(4999); await e.controller.step(); expect(e.calls).toHaveLength(2);
  e.advance(1); await e.controller.step(); expect(e.calls[2]).toEqual({ target: -900001, signal: 'SIGKILL', time: 10000 });
  e.setExit({ code: null, signal: 'SIGKILL' }); e.setGroup(false); await e.controller.step();
  expect(f.store.read(f.id)).toMatchObject({ extra: 'retained', ended_at: expect.any(String), exit_signal: 'SIGKILL', stop_request: { phase: 'completed', result: { success: true, outcome: 'forced-kill', root_exited: true, group_alive: false, scope: STOP_SCOPE, descendants_check: 'not-performed' } } });
  await e.controller.step(); expect(e.calls).toHaveLength(3);
});
it('cooperative completion preserves actual exit and skips all group signals', async () => {
  const f = await fixture(); const e = environment(f); await e.controller.step();
  e.setExit({ code: 130, signal: null }); e.setGroup(false); await e.controller.step();
  expect(f.store.read(f.id).stop_request!.result).toMatchObject({ outcome: 'cooperative', success: true, exit_code: 130 });
  expect(e.calls).toHaveLength(1);
});
it('leader exits in cooperative grace but descendants retain the remaining cooperative time', async () => {
  const f = await fixture(); const e = environment(f); await e.controller.step();
  e.advance(10); e.setExit({ code: 2, signal: null }); await e.controller.step(); expect(e.calls).toHaveLength(1); expect(f.store.read(f.id).ended_at).toBeUndefined();
  e.advance(4989); await e.controller.step(); expect(e.calls).toHaveLength(1);
  e.setGroup(false); await e.controller.step(); expect(f.store.read(f.id).stop_request!.result!.outcome).toBe('cooperative');
});
it('already-exited leader never gets INT and goes directly to group TERM when descendants remain', async () => {
  const f = await fixture(); const e = environment(f); e.setExit({ code: 3, signal: null }); await e.controller.step();
  expect(e.calls).toEqual([{ target: -900001, signal: 'SIGTERM', time: 0 }]);
  expect(f.store.read(f.id).stop_request!.reason).toBe('leader-already-exited');
  e.setGroup(false); await e.controller.step(); expect(f.store.read(f.id).stop_request!.result!.outcome).toBe('forced-term');
});
it('the full KILL verification budget ends incomplete with a live group; code alone is never success', async () => {
  const f = await fixture(); const e = environment(f); await e.controller.step(); e.advance(5000); await e.controller.step(); e.advance(5000); await e.controller.step();
  e.setExit({ code: 0, signal: null }); e.advance(1999); await e.controller.step(); expect(f.store.read(f.id).stop_request!.result).toBeUndefined();
  e.advance(1); await e.controller.step(); expect(f.store.read(f.id).stop_request!.result).toMatchObject({ success: false, outcome: 'incomplete', group_alive: true }); expect(f.store.read(f.id).ended_at).toBeUndefined();
});
it('phase and intent write failures send no signal, syscall-record failure leaves uncertain evidence', async () => {
  for (const failedWrite of [1, 2, 3]) {
    const f = await fixture(); const e = environment(f); const update = f.store.updateMeta.bind(f.store); let n = 0;
    vi.spyOn(f.store, 'updateMeta').mockImplementation(async (id, fn) => { if (++n === failedWrite) throw new Error('disk failed'); return update(id, fn); });
    await expect(e.controller.step()).rejects.toThrow('disk failed');
    expect(e.calls).toHaveLength(failedWrite === 3 ? 1 : 0);
    if (failedWrite === 3) expect(f.store.read(f.id).stop_request!.signals[0]!.delivery).toBe('uncertain');
    await e.controller.fail(new Error('disk failed')); expect(f.store.read(f.id).stop_request!.result!.success).toBe(false);
  }
});
it('a failed final write cannot be observed as success; crashed control intents are never replayed', async () => {
  const f = await fixture(); const e = environment(f); await e.controller.step(); e.setExit({ code: 0, signal: null }); e.setGroup(false);
  const spy = vi.spyOn(f.store, 'updateMeta').mockRejectedValue(new Error('final write failed'));
  await expect(e.controller.step()).rejects.toThrow('final write failed'); expect(f.store.read(f.id).stop_request!.result).toBeUndefined();
  spy.mockRestore(); const recovered = environment(f); await recovered.controller.step();
  expect(recovered.calls).toHaveLength(0); expect(f.store.read(f.id).stop_request!.result!.success).toBe(false);
});
it('EPERM remains unknown; ESRCH never proves actual root exit and a failed signal is not success', async () => {
  const f = await fixture(); const e = environment(f); e.setGroup(null); await e.controller.step(); expect(e.calls).toHaveLength(0);
  expect(f.store.read(f.id).stop_request!.result).toMatchObject({ success: false, group_alive: null });
  const other = await fixture(); const gone = environment(other); gone.setGroup(false); await gone.controller.step(); gone.advance(5000); await gone.controller.step();
  expect(other.store.read(other.id).stop_request!.result).toMatchObject({ success: false, root_exited: false, group_alive: false });
  const third = await fixture(); const denied = environment(third); denied.kill.mockImplementation((_pid, signal = 0) => { if (signal !== 0) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return true; });
  await expect(denied.controller.step()).rejects.toThrow('denied'); await denied.controller.fail(new Error('denied'));
  expect(third.store.read(third.id).stop_request!.signals[0]!.delivery).toBe('error');
});
it('identity changes cannot receive a signal or an acknowledgement from the original controller', async () => {
  const f = await fixture(); const e = environment(f); await f.store.updateMeta(f.id, m => ({ ...m, started_at: new Date(Date.now() - 10000).toISOString() }));
  await expect(e.controller.step()).rejects.toThrow('identity'); expect(e.calls).toHaveLength(0);
});
it('CLI initial and request write failures persist no request and cannot trigger any signal', async () => {
  for (const failure of [1, 2]) {
    const f = await fixture(false); const original = f.store.updateMeta.bind(f.store); let count = 0;
    vi.spyOn(f.store, 'updateMeta').mockImplementation((id, fn) => { if (++count === failure) return Promise.reject(new Error('IO denied')); return original(id, m => { const next = fn(m); return { ...next, identity_ack: next.identity_probe! }; }); });
    await expect(stopRun(f.store, f.id, { probe: () => true })).rejects.toThrow('IO denied');
    expect(f.store.read(f.id).stop_request).toBeUndefined(); expect(existsSync(path.join(f.store.directory(f.id), 'stop.lock'))).toBe(false);
  }
});
it('stale supervisor cannot answer fresh nonce; unknown liveness cannot establish identity', async () => {
  const f = await fixture(false); let time = 0;
  await expect(stopRun(f.store, f.id, { probe: () => true, identityMs: 50, now: () => time, sleep: async ms => { time += ms; } })).rejects.toThrow('identity-unverified');
  expect(f.store.read(f.id).stop_request).toBeUndefined();
  await expect(stopRun(f.store, f.id, { probe: () => null })).rejects.toThrow('identity-unverified');
});
it('legacy active runs are untouched/unsupported, old terminal runs are read-only historical observations', async () => {
  const f = await fixture(false); await f.store.updateMeta(f.id, m => { const { control_protocol, ...legacy } = m; return legacy; });
  const bytes = readFileSync(path.join(f.store.directory(f.id), 'meta.json'), 'utf8');
  await expect(stopRun(f.store, f.id)).rejects.toThrow('legacy-control/unsupported'); expect(readFileSync(path.join(f.store.directory(f.id), 'meta.json'), 'utf8')).toBe(bytes);
  await f.store.updateMeta(f.id, m => ({ ...m, status: 'exited', ended_at: new Date().toISOString() }));
  const terminal = readFileSync(path.join(f.store.directory(f.id), 'meta.json'), 'utf8');
  expect((await stopRun(f.store, f.id)).result).toContain('historical'); expect(readFileSync(path.join(f.store.directory(f.id), 'meta.json'), 'utf8')).toBe(terminal);
});
it('pending requests wait for one result without resetting it; dead monitor or timeout cannot become success', async () => {
  const f = await fixture(); let time = 0;
  const before = readFileSync(path.join(f.store.directory(f.id), 'meta.json'), 'utf8');
  const result = await stopRun(f.store, f.id, { waitMs: 100, probe: () => true, now: () => time, sleep: async ms => { time += ms; } });
  expect(result).toMatchObject({ success: false, requested: false }); expect(result.result).toContain('not restarted');
  expect(readFileSync(path.join(f.store.directory(f.id), 'meta.json'), 'utf8')).toBe(before);
  expect((await stopRun(f.store, f.id, { probe: () => false })).result).toContain('supervisor lost');
});
it('normal exit racing request publication is observed without inventing a stop', async () => {
  const f = await fixture(false); const update = f.store.updateMeta.bind(f.store); let n = 0;
  vi.spyOn(f.store, 'updateMeta').mockImplementation((id, fn) => update(id, m => {
    const input: RunMeta = ++n === 2 ? { ...m, status: 'exited', ended_at: new Date().toISOString(), exit_code: 0 } : m;
    const next = fn(input); return { ...next, identity_ack: next.identity_probe! };
  }));
  expect(await stopRun(f.store, f.id, { probe: () => true })).toMatchObject({ success: true, requested: false }); expect(f.store.read(f.id).stopped_at).toBeUndefined();
});
it('new attach waits for monitor result, reports lost monitors instead of treating absent group as success', async () => {
  const f = await fixture(); const fd = f.store.openLog(f.id, true); closeSync(fd);
  const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
  await expect(attachRun(f.store, f.id, stream)).rejects.toThrow('supervisor lost');
});
it('reclaims only provably dead locks, with no changes to live/corrupt locks', async () => {
  const { store, id } = await fixture(false); const file = path.join(store.directory(id), 'meta.lock');
  writeFileSync(file, JSON.stringify({ pid: 2147483647, token: 'dead' })); await store.updateMeta(id, m => ({ ...m, recovered: true })); expect(store.read(id).recovered).toBe(true);
  const live = JSON.stringify({ pid: process.pid, token: 'live' }); writeFileSync(file, live);
  await expect(store.lock(id, 'meta', 20)).rejects.toThrow('in-progress'); expect(readFileSync(file, 'utf8')).toBe(live);
  writeFileSync(file, '{broken'); await expect(store.lock(id, 'meta', 20)).rejects.toThrow('cannot verify'); expect(readFileSync(file, 'utf8')).toBe('{broken');
});

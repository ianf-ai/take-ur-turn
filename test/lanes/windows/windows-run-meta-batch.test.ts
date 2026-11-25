import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWindowsRunMetas } from '../../../src/hub/windows-run-file.js';
import { RunStore, validateMeta, type RunMeta } from '../../../src/core/run/store.js';
import { sessionOccupants, taskOccupants } from '../../../src/core/run/admission.js';
import { HeadlessRuntime } from '../../../src/standalone/launcher-detached/runtime.js';

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof cp>(), spawnSync: vi.fn() }));
const spawn = vi.mocked(cp.spawnSync);
type Request = { v: number; batch: string; i: number; file: string };
const requests = (options: unknown): Request[] => String((options as { input: string }).input).trimEnd().split('\n').map(s => JSON.parse(s));
const frame = (r: Request, payload: object) => JSON.stringify({ v: 1, batch: r.batch, type: 'result', i: r.i, ...payload }) + '\n';
const done = (rs: Request[], k = rs.length, reason = 'eof') => JSON.stringify({ v: 1, batch: rs[0]!.batch, type: 'done', n: rs.length, k, reason }) + '\n';
const output = (stdout: string, extra = {}) => ({ pid: 123, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), status: 0, signal: null, output: [], ...extra }) as ReturnType<typeof cp.spawnSync>;
const files = (n: number) => Array.from({ length: n }, (_, i) => ({ i, file: `C:\\root\\${i}\\meta.json` }));
const data = (value: unknown) => ({ data: Buffer.from(JSON.stringify(value)).toString('base64') });
const single = vi.fn(() => ({ ok: true }));
const decode = (b: Buffer) => JSON.parse(b.toString());
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Windows authoritative batch transport', () => {
  it('uses an absolute OS executable, encoded script, data stdin and bounded options; empty scans do not spawn', () => {
    expect(readWindowsRunMetas([], decode, single)).toEqual([]); expect(spawn).not.toHaveBeenCalled();
    spawn.mockImplementation((exe, args, options) => {
      expect(String(exe)).toMatch(/System32\\WindowsPowerShell\\v1.0\\powershell.exe$/);
      expect(args).toContain('-EncodedCommand');
      expect(options).toMatchObject({ timeout: 15000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
      const rs = requests(options); expect(rs[0]!.batch).toMatch(/^[a-f0-9]{32}$/);
      return output(rs.map(r => frame(r, data({ i: r.i }))).join('') + done(rs));
    });
    expect(readWindowsRunMetas(files(3), decode, single).map(r => r.kind)).toEqual(['meta', 'meta', 'meta']);
    expect(spawn).toHaveBeenCalledTimes(1); expect(single).not.toHaveBeenCalled();
  });
  it.each(['EIO', 'ENOENT', 'EACCES', 'EUNSAFEPATH', 'EFBIG'])('keeps %s before bad done without replay', code => {
    spawn.mockImplementation((_e, _a, o) => { const rs = requests(o); return output(frame(rs[0]!, { error: code }) + frame(rs[1]!, data(2)) + '{broken}\n'); });
    const result = readWindowsRunMetas(files(2), decode, single);
    expect(result).toMatchObject([{ kind: 'error', error: { code }, origin: 'file' }, { kind: 'error', error: { code: 'EIO' }, origin: 'protocol' }]);
    expect(single).not.toHaveBeenCalled();
  });
  it.each(['base64', 'json', 'meta'])('freezes attributable %s failure before a corrupt later frame', kind => {
    spawn.mockImplementation((_e, _a, o) => { const rs = requests(o); return output(frame(rs[0]!, { data: kind === 'base64' ? '??' : Buffer.from(kind === 'json' ? '{' : '{}').toString('base64') }) + 'bad\n'); });
    const result = readWindowsRunMetas(files(2), (b, i) => kind === 'meta' ? validateMeta(decode(b), String(i)) : decode(b), single);
    expect(result[0]).toMatchObject({ kind: 'error', origin: 'file' }); expect(single).not.toHaveBeenCalled();
  });
  it.each(['wrong-batch', 'duplicate', 'reordered', 'truncated', 'bad-done', 'trailing', 'payload-type', 'both-payloads'])('stops at the first %s frame and never searches for later errors', kind => {
    spawn.mockImplementation((_e, _a, o) => {
      const rs = requests(o), first = frame(rs[0]!, data(0));
      const bad: Record<string, string> = {
        'wrong-batch': frame({ ...rs[1]!, batch: 'f'.repeat(32) }, data(1)),
        duplicate: frame(rs[0]!, data(1)), reordered: frame(rs[2]!, data(1)),
        truncated: '{', 'bad-done': done(rs, 1), trailing: done(rs),
        'payload-type': frame(rs[1]!, { data: 42 }), 'both-payloads': frame(rs[1]!, { ...data(1), error: 'EIO' }),
      };
      return output(first + bad[kind] + frame(rs[1]!, { error: 'ENOENT' }) + done(rs));
    });
    expect(readWindowsRunMetas(files(3), decode, single).every(r => r.kind === 'error' && r.origin === 'protocol')).toBe(true);
    expect(single).not.toHaveBeenCalled();
  });
  it.each(['nonzero', 'timeout', 'maxBuffer', 'signal', 'no-prefix'])('retains known errors on %s and rejects successful candidates', kind => {
    spawn.mockImplementation((_e, _a, o) => {
      const rs = requests(o);
      const extra = kind === 'nonzero' ? { status: 1 } : kind === 'signal' ? { status: null, signal: 'SIGTERM' } : { status: null, error: Object.assign(new Error(kind), { code: kind === 'timeout' ? 'ETIMEDOUT' : 'ENOBUFS' }) };
      return output(kind === 'no-prefix' ? '' : frame(rs[0]!, { error: 'ENOENT' }) + frame(rs[1]!, data(1)) + done(rs), extra);
    });
    const result = readWindowsRunMetas(files(2), decode, single);
    expect(result[0]).toMatchObject({ kind: 'error', error: { code: kind === 'no-prefix' ? 'EIO' : 'ENOENT' } });
    expect(result[1]).toMatchObject({ kind: 'error', origin: 'transport', error: { code: kind === 'timeout' ? 'ETIMEDOUT' : 'EIO' } });
    expect(single).not.toHaveBeenCalled();
  });
  it.each(['ENOENT', 'EACCES'])('only falls back after proven %s process creation failure', code => {
    spawn.mockReturnValue(output('', { pid: 0, status: null, error: Object.assign(new Error(code), { code }) }));
    expect(readWindowsRunMetas(files(2), decode, single).every(r => r.kind === 'meta')).toBe(true);
    expect(single).toHaveBeenCalledTimes(2);
  });
  it('does not interpret an empty failed process as unexecuted or bypass local path rejection', () => {
    spawn.mockReturnValue(output('', { status: 1 }));
    expect(readWindowsRunMetas([{ i: 0, file: 'C:\\NUL' }, ...files(1).map(f => ({ ...f, i: 1 }))], decode, single)).toMatchObject([
      { i: 0, kind: 'error', origin: 'local', error: { code: 'EUNSAFEPATH' } }, { i: 1, kind: 'error', origin: 'transport' },
    ]); expect(single).not.toHaveBeenCalled();
  });
  it('continues only a trusted budget suffix, retaining failures and original slot indices', () => {
    const opened: number[] = [];
    spawn.mockImplementation((_e, _a, o) => {
      const rs = requests(o); const k = Math.min(2, rs.length); opened.push(...rs.slice(0, k).map(r => r.i));
      return output(rs.slice(0, k).map(r => frame(r, r.i === 0 ? { error: 'EIO' } : data(r.i))).join('') + done(rs, k, k < rs.length ? 'budget' : 'eof'));
    });
    expect(readWindowsRunMetas(files(5), decode, single).map(r => r.kind)).toEqual(['error', 'meta', 'meta', 'meta', 'meta']);
    expect(opened).toEqual([0, 1, 2, 3, 4]); expect(spawn).toHaveBeenCalledTimes(3);
  });
  it.each([4096, 4097])('groups %i requests at the count boundary', n => {
    spawn.mockImplementation((_e, _a, o) => { const rs = requests(o); expect(rs.length).toBeLessThanOrEqual(4096); return output(rs.map(r => frame(r, data(1))).join('') + done(rs)); });
    expect(readWindowsRunMetas(files(n), decode, single)).toHaveLength(n); expect(spawn).toHaveBeenCalledTimes(Math.ceil(n / 4096));
  });
  it('groups by exact UTF-8 bytes at the 4MiB boundary including envelopes and newlines', () => {
    const counts: number[] = [];
    spawn.mockImplementation((_e, _a, o) => { const rs = requests(o); counts.push(rs.length); expect(Buffer.byteLength(String((o as { input: string }).input))).toBeLessThanOrEqual(4 * 1024 * 1024); return output(rs.map(r => frame(r, data(1))).join('') + done(rs)); });
    const long = files(180).map(r => ({ ...r, file: `C:\\${'中'.repeat(9000)}\\meta.json` }));
    readWindowsRunMetas(long, decode, single); expect(counts).toEqual([154, 26]);
  });
});

function completed(id: string): RunMeta {
  return { run_id: id, pid: 123, pgid: 123, supervisor_pid: 124, argv: ['pi'], cwd: path.resolve('.'), task_id: 't', started_at: '2026-01-01', ended_at: '2026-01-02', status: 'exited', exit_code: 0 };
}
function fakeWindowsStore(): RunStore {
  const store = new RunStore(path.resolve('.'));
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(store, 'directory').mockImplementation(id => `C:\\runs\\${id}`);
  return store;
}
describe('batch results enter the original consumer branches', () => {
  it.each(['task', 'session'])('preserves the %s pending intent on one-shot EIO followed by a bad frame; the next independent scan recovers', which => {
    const store = fakeWindowsStore(), id = '20261027T000000000Z-12345678';
    vi.spyOn(store, 'list').mockReturnValue([id, '20261027T000000001Z-12345678']);
    const reread = vi.spyOn(store, 'read').mockImplementation(id => completed(id));
    vi.spyOn(store, 'readResumeIntent').mockImplementation(() => { throw new Error('absent'); });
    vi.spyOn(store, 'readStartIntent').mockImplementation(run => { if (run !== id) throw new Error('absent'); return { task_id: 't', cwd: path.resolve('.'), startup: 'pending', headless: { designated_session_id: 'session' } } as ReturnType<RunStore['readStartIntent']>; });
    let attempts = 0;
    spawn.mockImplementation((_e, _a, o) => {
      const rs = requests(o); attempts++;
      return output(attempts === 1 ? frame(rs[0]!, { error: 'EIO' }) + '{broken}\n' : rs.map(r => frame(r, data(completed(store.list()[r.i]!)))).join('') + done(rs));
    });
    const occupants = () => which === 'task' ? taskOccupants(store, 't') : sessionOccupants(store, { agent: 'pi', session_id: 'session' });
    expect(occupants()).toMatchObject([{ run_id: id, via: 'intent' }]); expect(reread).not.toHaveBeenCalled();
    expect(occupants()).toEqual([]); expect(attempts).toBe(2);
  });
  it('does not accept complete data plus nonzero exit over a pending intent', () => {
    const store = fakeWindowsStore(); vi.spyOn(store, 'list').mockReturnValue(['a']);
    vi.spyOn(store, 'readStartIntent').mockReturnValue({ task_id: 't', startup: 'pending' } as ReturnType<RunStore['readStartIntent']>);
    spawn.mockImplementation((_e, _a, o) => { const rs = requests(o); return output(frame(rs[0]!, data(completed('a'))) + done(rs), { status: 1 }); });
    expect(taskOccupants(store, 't')).toMatchObject([{ run_id: 'a', via: 'intent' }]);
  });
  it('keeps local failures in their slots without opening them; duplicate ids retain distinct slots', () => {
    const store = fakeWindowsStore(); vi.spyOn(store, 'directory').mockImplementation(id => { if (id === 'bad') throw new Error('directory rejected'); return `C:\\runs\\${id}`; });
    spawn.mockImplementation((_e, _a, o) => { const rs = requests(o); expect(rs.map(r => r.i)).toEqual([0, 2]); return output(rs.map(r => frame(r, data(completed('a')))).join('') + done(rs)); });
    expect(store.readManyMetas(['a', 'bad', 'a']).map(r => r.kind)).toEqual(['meta', 'error', 'meta']);
  });
  it('POSIX calls the original read once per ordered slot and retains the exact error object', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const store = new RunStore('.'), error = new Error('original');
    const read = vi.spyOn(store, 'read').mockImplementation(id => { if (id === 'bad') throw error; return completed(id); });
    const result = store.readManyMetas(['b', 'bad', 'a']);
    expect(read.mock.calls).toEqual([['b'], ['bad'], ['a']]); expect(result[1]).toMatchObject({ error }); expect(spawn).not.toHaveBeenCalled();
  });
  it('runtime ignores projection failures but delivery inventory fails for an unrelated broken id', async () => {
    const runtime = new HeadlessRuntime('.', { send: async () => {}, log: () => {}, read: async () => [] });
    vi.spyOn(runtime.store, 'list').mockReturnValue(['foreign', 'a']);
    const error = new Error('foreign failed');
    vi.spyOn(runtime.store, 'readManyMetas').mockReturnValue([{ id: 'foreign', kind: 'error', error, origin: 'protocol' }, { id: 'a', kind: 'meta', meta: completed('a') }]);
    expect(runtime.runs()).toHaveLength(1);
    vi.spyOn(runtime, 'knows').mockReturnValue(true);
    await expect(runtime.reconcileDeliveries('t', [{ task_id: 't', version: 2, role: 'executor', content_type: 'code_changes', timestamp: '2026-01-01', payload: { summary: 'delivery', body: 'delivery' } }], 1, 2, Date.now())).rejects.toBe(error);
  });
  it('real RunStore POSIX roundtrip preserves safe single-read behavior', async () => {
    if (process.platform === 'win32') return;
    const store = new RunStore(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tut-batch-'))));
    const id = store.create(); await store.initialize(id, completed(id));
    expect(store.readManyMetas([id, 'invalid'])).toMatchObject([{ id, kind: 'meta', meta: completed(id) }, { id: 'invalid', kind: 'error' }]);
  });
});

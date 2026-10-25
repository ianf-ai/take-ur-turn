import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as processes from 'node:child_process';
import { createWindowsRunFileSession, openWindowsRunFile, readWindowsRunMeta } from '../src/core/hub/windows-run-file.js';
import { withRunFileSession } from '../src/core/hub/run-file.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const identity = { size: 4, dev: '123', ino: '456' };
function helper(respond: (request: Record<string, unknown>, send: (value: unknown) => void) => void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null,
    requests: [] as Record<string, unknown>[],
    kill: vi.fn(() => { child.signalCode = 'SIGTERM'; child.emit('exit'); return true; }),
  });
  let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString();
    let end;
    while ((end = input.indexOf('\n')) >= 0) {
      const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      child.requests.push(request);
      queueMicrotask(() => {
        const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
        if (request.op === 'close') send({ closed: true });
        else respond(request, send);
      });
    }
  });
  child.stdin.on('finish', () => { child.exitCode = 0; child.emit('exit'); });
  vi.spyOn(processes, 'spawn').mockReturnValue(child as unknown as ReturnType<typeof processes.spawn>);
  return child;
}

describe('Windows private read protocol', () => {
  it('keeps paths as UTF-8 data, returns bounded bytes, and closes the helper', async () => {
    const requests: Record<string, unknown>[] = [];
    const child = helper((request, send) => { requests.push(request); send(request.op === 'read' ? { data: 'AP8NCg==' } : identity); });
    const file = String.raw`C:\中\$literal'\log`;
    const f = await openWindowsRunFile(file);
    expect(requests[0]).toEqual({ op: 'open', file });
    expect((await f.stat()).size).toBe(4);
    const bytes = Buffer.alloc(7);
    expect(await f.read(bytes, 2, 4, 123)).toEqual({ bytesRead: 4 });
    expect(bytes.subarray(2, 6)).toEqual(Buffer.from([0, 255, 13, 10]));
    const args = vi.mocked(processes.spawn).mock.calls[0]!;
    expect(args[1]).not.toContain(file); // No script or argv interpolation.
    await f.close(); await f.close();
    expect(child.exitCode).toBe(0);
    await expect(f.stat()).rejects.toMatchObject({ code: 'EIO' });
  });
  it('reuses one compiled bridge for eight sequential files, closing each chain before the next', async () => {
    const child = helper((r, send) => send(r.op === 'read' ? { data: 'AP8NCg==' } : identity));
    await withRunFileSession(async open => {
      for (let i = 0; i < 8; i++) {
        const f = await open(`C:\\runs\\file${i}`);
        await expect(open('C:\\runs\\overlap')).rejects.toMatchObject({ code: 'EIO' });
        expect(await f.read(Buffer.alloc(4), 0, 4, 0)).toEqual({ bytesRead: 4 });
        await f.close();
        await expect(f.stat()).rejects.toMatchObject({ code: 'EIO' });
        expect(child.exitCode).toBeNull();
      }
    }, 'win32');
    expect(processes.spawn).toHaveBeenCalledTimes(1);
    expect(child.requests.map(r => r.op)).toEqual(Array.from({ length: 8 }, () => ['open', 'read', 'close']).flat());
    expect(child.exitCode).toBe(0);
  });
  it('closes a snapshot bridge on a caller exception even with a file still open', async () => {
    const child = helper((r, send) => send(identity));
    await expect(withRunFileSession(async open => {
      await open('C:\\runs\\log'); throw new Error('snapshot aborted');
    }, 'win32')).rejects.toThrow('snapshot aborted');
    expect(child.exitCode).toBe(0); // EOF, not leaked or retained in a global pool.
  });
  it('does not replay failed opens and only restarts for the next independent file', async () => {
    const failed = helper((r, send) => send({ error: 'EUNSAFEPATH' }));
    const session = createWindowsRunFileSession();
    await expect(session.open('C:\\runs\\bad')).rejects.toMatchObject({ code: 'EUNSAFEPATH' });
    expect(failed.requests).toEqual([{ op: 'open', file: 'C:\\runs\\bad' }]);
    const healthy = helper((r, send) => send(identity));
    const file = await session.open('C:\\runs\\healthy'); await file.close();
    await session.close();
    expect(failed.kill).toHaveBeenCalled(); expect(healthy.exitCode).toBe(0);
  });
  it.each([{ data: '%%%%' }, { data: 'eHh4eHg=' }, { size: 4 }, { error: 'EUNSAFEPATH' }])('fails closed on invalid/failing read envelopes: %j', async value => {
    const child = helper((r, send) => send(r.op === 'read' ? value : identity));
    const f = await openWindowsRunFile('C:\\runs\\log');
    await expect(f.read(Buffer.alloc(4), 0, 4, 0)).rejects.toThrow();
    await f.close();
    // Invalid byte payloads cannot escape the requested allocation.
    expect(child.exitCode !== null || child.kill.mock.calls.length > 0).toBe(true);
  });
  it('bounds helper startup and terminates on process death without a fallback', async () => {
    vi.useFakeTimers();
    const child = helper(() => {});
    const opening = openWindowsRunFile('C:\\runs\\log');
    const rejected = expect(opening).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    expect(child.kill).toHaveBeenCalled();
  });
  it('rejects a dead helper and unsafe synchronous paths', async () => {
    const child = helper(() => {});
    const opening = openWindowsRunFile('C:\\runs\\log');
    child.emit('error', new Error('unavailable'));
    await expect(opening).rejects.toMatchObject({ code: 'EIO' });
    expect(() => readWindowsRunMeta('C:\\runs\\meta.json:stream')).toThrow('EUNSAFEPATH');
  });
  it('bounds synchronous metadata and propagates structured errors', () => {
    const exec = vi.spyOn(processes, 'execFileSync').mockReturnValue('{"error":"ENOENT"}\n');
    expect(() => readWindowsRunMeta('C:\\runs\\meta.json')).toThrow('ENOENT');
    exec.mockReturnValue(JSON.stringify({ data: Buffer.from([0x00, 0xff]).toString('base64') }));
    expect(readWindowsRunMeta('C:\\runs\\meta.json')).toEqual(Buffer.from([0, 255]));
    expect(exec.mock.calls[0]![2]).toMatchObject({ timeout: 15000, maxBuffer: 1500000 });
  });
});

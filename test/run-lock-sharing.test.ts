import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../src/core/run/store.js';

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(platform = 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-sharing-')); roots.push(root);
  const store = new RunStore(root), id = store.create();
  const file = path.join(store.directory(id), 'meta.lock');
  // Fault injection models only the Windows error classification; all lock
  // ownership, deadlines and filesystem operations remain the real protocol.
  vi.stubGlobal('process', { ...process, platform });
  return { store, id, file };
}
const denied = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient Windows exclusive-create %s without deleting another owner', async code => {
  const { store, id, file } = fixture();
  const original = fs.openSync; let failures = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === file && failures++ < 2) throw denied(code);
    return original(...args);
  });
  const unlock = await store.lock(id, 'meta', 500);
  expect(failures).toBe(3);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(process.pid);
  unlock(); expect(fs.existsSync(file)).toBe(false);
});
it('preserves the original persistent Windows access error at the same deadline', async () => {
  const { store, id, file } = fixture(); const error = denied('EPERM');
  const original = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === file) throw error;
    return original(...args);
  });
  const start = performance.now();
  await expect(store.lock(id, 'meta', 60)).rejects.toBe(error);
  expect(performance.now() - start).toBeGreaterThanOrEqual(55);
  expect(performance.now() - start).toBeLessThan(1000);
  expect(fs.existsSync(file)).toBe(false);
});
it('does not reclaim a live owner after a transient Windows inspection error', async () => {
  const { store, id, file } = fixture();
  const owner = JSON.stringify({ pid: process.pid, token: 'still-owned' }); fs.writeFileSync(file, owner);
  const original = fs.lstatSync; let failures = 0;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (args[0] === file && failures++ === 0) throw denied('EACCES');
    return original(...args);
  }) as typeof fs.lstatSync);
  await expect(store.lock(id, 'meta', 60)).rejects.toThrow('in-progress');
  expect(failures).toBeGreaterThan(1);
  expect(fs.readFileSync(file, 'utf8')).toBe(owner);
});
it('keeps POSIX access failures immediate', async () => {
  const { store, id, file } = fixture('darwin'); const error = denied('EPERM');
  const original = fs.openSync; let calls = 0;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === file) { calls++; throw error; }
    return original(...args);
  });
  await expect(store.lock(id, 'meta', 500)).rejects.toBe(error);
  expect(calls).toBe(1);
});
it('allows a Windows metadata owner to finish beyond the POSIX two-second default', async () => {
  const { store, id, file } = fixture();
  const unlock = await store.lock(id, 'meta');
  const original = fs.readFileSync(file, 'utf8');
  const waiting = store.lock(id, 'meta');
  await new Promise(resolve => setTimeout(resolve, 2200));
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  unlock();
  const release = await waiting;
  expect(fs.readFileSync(file, 'utf8')).not.toBe(original);
  release();
});

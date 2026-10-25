import { afterEach, expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureConfig, readConfig, writeConfigKey } from '../src/core/common/config.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await files.rm(root, { recursive: true, force: true });
});
async function fixture(platform = 'win32') {
  const root = await files.mkdtemp(path.join(os.tmpdir(), 'config-publish-')); roots.push(root);
  await ensureConfig(root);
  await writeConfigKey(root, { key: 'flow_mode', value: 'auto' });
  const file = path.join(root, 'config.json'), before = await files.readFile(file);
  // Only error classification is modeled. Config RMW, queue and file bytes
  // use the real implementation on both hosts; native sharing is tested too.
  vi.stubGlobal('process', { ...process, platform });
  return { root, file, before };
}
const denied = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
it.each(['EPERM', 'EACCES', 'EBUSY'])('Windows %s retries the same complete temp while preserving queued config updates', async code => {
  const { root, file, before } = await fixture();
  const rename = files.rename; const attempts: string[] = [], bytes: Buffer[] = [];
  vi.spyOn(files, 'rename').mockImplementation(async (from, to) => {
    if (to === file && attempts.length < 3) {
      attempts.push(String(from)); bytes.push(await files.readFile(from));
      expect(await files.readFile(file)).toEqual(before);
      if (attempts.length < 3) throw denied(code);
    }
    return rename(from, to);
  });
  await Promise.all([writeConfigKey(root, { key: 'usage_audit', value: 'on' }),
    writeConfigKey(root, { key: 'launch.catchup', value: 'on' })]);
  expect(new Set(attempts).size).toBe(1);
  expect(bytes).toHaveLength(3);
  expect(bytes.every(b => b.equals(bytes[0]!))).toBe(true);
  expect(await readConfig(root)).toMatchObject({ flow_mode: 'auto', usage_audit: 'on', launch: { catchup: 'on' } });
  expect((await files.readdir(root)).filter(n => n.endsWith('.tmp'))).toEqual([]);
});
it('persistent Windows replacement failure is bounded, preserves the old config and does not poison the queue', async () => {
  const { root, before, file } = await fixture(); const error = denied('EPERM');
  const rename = vi.spyOn(files, 'rename').mockRejectedValue(error);
  const start = performance.now();
  await expect(writeConfigKey(root, { key: 'usage_audit', value: 'on' })).rejects.toBe(error);
  expect(performance.now() - start).toBeGreaterThanOrEqual(950);
  expect(performance.now() - start).toBeLessThan(2500);
  expect(rename.mock.calls.length).toBeGreaterThan(1);
  expect(await files.readFile(file)).toEqual(before);
  expect((await files.readdir(root)).filter(n => n.endsWith('.tmp'))).toEqual([]);
  rename.mockRestore();
  await writeConfigKey(root, { key: 'usage_audit', value: 'off' });
  expect(await readConfig(root)).toMatchObject({ flow_mode: 'auto', usage_audit: 'off' });
});
it('non-sharing Windows errors fail immediately without replacing the config', async () => {
  const { root, before, file } = await fixture(); const error = denied('ENOSPC');
  const rename = vi.spyOn(files, 'rename').mockRejectedValue(error);
  await expect(writeConfigKey(root, { key: 'usage_audit', value: 'on' })).rejects.toBe(error);
  expect(rename).toHaveBeenCalledTimes(1);
  expect(await files.readFile(file)).toEqual(before);
});
it.each(['darwin', 'linux'])('keeps %s sharing failures immediate and the previous cleanup behavior intact', async platform => {
  const { root, before, file } = await fixture(platform); const error = denied('EPERM');
  const rename = vi.spyOn(files, 'rename').mockRejectedValue(error);
  await expect(writeConfigKey(root, { key: 'usage_audit', value: 'on' })).rejects.toBe(error);
  expect(rename).toHaveBeenCalledTimes(1);
  expect(await files.readFile(file)).toEqual(before);
  expect((await files.readdir(root)).filter(n => n.endsWith('.tmp'))).toEqual([]);
});

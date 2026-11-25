import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withTemporaryDirectoryCleanup } from '../../helpers/temporary-directory.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  rm: vi.fn((...args: Parameters<typeof fs.rm>) => realRm(...args)),
}));
const { rm: realRm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

afterEach(() => vi.mocked(fs.rm).mockReset().mockImplementation(realRm));

it.each([false, true])('removes the real fixture directory after the body (fails=%s)', async fails => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tut-cleanup-'));
  const assertion = new Error('original assertion');
  const result = withTemporaryDirectoryCleanup(directory, async () => {
    writeFileSync(path.join(directory, 'fixture'), 'test');
    if (fails) throw assertion;
  });
  if (fails) await expect(result).rejects.toBe(assertion);
  else await result;
  expect(existsSync(directory)).toBe(false);
});

it('retains the original assertion and persistent EBUSY together', async () => {
  const assertion = new Error('no PE header assertion failed');
  const busy = Object.assign(new Error('fixture still busy'), { code: 'EBUSY' });
  vi.mocked(fs.rm).mockRejectedValueOnce(busy);
  const error = await withTemporaryDirectoryCleanup('test-owned-fixture', async () => {
    throw assertion;
  }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([assertion, busy]);
  expect(error.cause).toBe(assertion);
});

it('fails on persistent cleanup errors even when the assertions passed', async () => {
  const busy = Object.assign(new Error('fixture still busy'), { code: 'EBUSY' });
  vi.mocked(fs.rm).mockRejectedValueOnce(busy);
  await expect(withTemporaryDirectoryCleanup('test-owned-fixture', async () => {})).rejects.toBe(busy);
});

import { expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;
// No PowerShell on a host is a platform limitation, not native API evidence.
it.skipIf(!available).each([400, 4000])('bounds actual broker replay state after %i read-only requests', async polls => {
  const { stdout } = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./fixtures/windows-broker-cache.ps1', import.meta.url)), '-BrokerScript',
    fileURLToPath(new URL('../scripts/windows-run/broker.ps1', import.meta.url)), '-Polls', String(polls)], { timeout: 60000 });
  const result = JSON.parse(stdout.trim());
  expect(result).toMatchObject({ polls, cache_entries: 67, read_only_entries: 64, creates: 1, breaks: 1, observes: polls, replays: 'verified' });
  expect(result.retained_utf16_bytes).toBeLessThan(100000);
}, 65000);

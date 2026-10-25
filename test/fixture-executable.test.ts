import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import { fixtureExecutable } from './helpers/executable.js';

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const script = path.resolve(import.meta.dirname, 'bin/herdr');
  const file = process.platform === 'win32' ? fixtureExecutable(script) : process.execPath;
  return spawnSync(file, process.platform === 'win32' ? args : [script, ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, TUT_HERDR_LOG: '', TUT_HERDR_FAIL: '', ...env },
  });
}

it('the host fixture preserves raw argv, including quotes, empty values and Unicode', () => {
  for (const value of ['', 'sp ace', 'a"b', 'C:\\space dir\\', 'a\\"b', '评审 & | % !', 'line1\r\nline2']) {
    const result = run(['pane', 'rename', value, value]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result.pane).toEqual({ pane_id: value, label: value });
  }
}, 20000);

it('the host fixture forwards environment, stdout, stderr and a failing exit', () => {
  const panes = [{ pane_id: 'p', label: '评审\n"quoted"', cwd: 'C:\\space dir\\' }];
  const success = run(['pane', 'list'], { TUT_HERDR_PANES: JSON.stringify(panes) });
  expect(success.status, success.stderr).toBe(0);
  expect(JSON.parse(success.stdout).result.panes).toEqual(panes);
  const failure = run(['pane', 'list'], { TUT_HERDR_FAIL: 'pane:list' });
  expect(failure.status).toBe(1);
  expect(failure.stderr).toBe('fixture: simulated pane list failure\n');
});

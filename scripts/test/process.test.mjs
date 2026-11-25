import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runJob } from './process.mjs';

async function fixture(fn) {
  const resultsDir = mkdtempSync(path.join(tmpdir(), 'tut-watchdog-'));
  try { await fn(resultsDir); } finally { rmSync(resultsDir, { recursive: true, force: true }); }
}
test('preserves a natural failing process exit and its diagnostic output', async () => fixture(async resultsDir => {
  const result = await runJob({ id: 'failure', files: [], args: ['-e', "console.error('fixture failure');process.exit(7)"], budgetMs: 5000 }, { profile: 'fixture', resultsDir, output: false });
  assert.equal(result.exitCode, 7); assert.equal(result.naturalExitCode, 7);
  assert.equal(result.timedOut, false); assert.equal(result.interrupted, false);
  assert.match(readFileSync(path.join(resultsDir, 'failure.log'), 'utf8'), /fixture failure/);
}));
test('watchdog terminates a wedged child process rather than leaving the gate hung', { timeout: 15000 }, async () => fixture(async resultsDir => {
  const result = await runJob({ id: 'hang', files: [], args: ['-e', "console.log('watchdog fixture');setInterval(()=>{},1000)"], budgetMs: 1500 }, { profile: 'fixture', resultsDir, output: false });
  assert.equal(result.exitCode, 124); assert.equal(result.timedOut, true);
  assert.notEqual(result.naturalExitCode, 0);
  assert.match(readFileSync(path.join(resultsDir, 'hang.log'), 'utf8'), /watchdog fixture/);
}));
test('an exited root with inherited descendant pipes still yields a bounded watchdog receipt', { timeout: 15000 }, async () => fixture(async resultsDir => {
  const code = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3500)'],{detached:true,windowsHide:true,stdio:['ignore',1,2]});console.log('root exits');process.exit(0)";
  const result = await runJob({ id: 'orphan-pipe', files: [], args: ['-e', code], budgetMs: 1500 }, { profile: 'fixture', resultsDir, output: false });
  assert.equal(result.exitCode, 124); assert.equal(result.naturalExitCode, 0);
  assert.deepEqual(result.cleanup, { kind: 'root-already-exited', descendants: 'unverified' });
}));

test('test children do not inherit the worker rig identity or power registration authority', async () => fixture(async resultsDir => {
  const keys = ['TUT_POWER_SESSION', 'TUT_HUB_ROOT', 'TUT_PROJECT_ROOT', 'TUT_HUB_URL', 'TUT_EVENT_PORT_URL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'fixture-worker-' + key;
    const script = `console.log(JSON.stringify(${JSON.stringify(keys)}.map(key => process.env[key] ?? null)))`;
    const result = await runJob({ id: 'identity', files: [], args: ['-e', script], budgetMs: 5000 }, { profile: 'fixture', resultsDir, output: false });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(path.join(resultsDir, 'identity.log'), 'utf8')), keys.map(() => null));
    for (const key of keys) assert.equal(process.env[key], 'fixture-worker-' + key);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}));

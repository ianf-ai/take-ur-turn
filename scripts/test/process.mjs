import { spawn, spawnSync } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';

/** Run a single owned process tree. Exported so short-lived native fixtures
 * can verify watchdogs without waiting for a real suite budget to expire. */
export async function runJob(job, { profile, resultsDir, output = true }) {
  const report = path.join(resultsDir, `${job.id}.json`);
  const args = job.args ?? (job.engine === 'vitest' ? ['node_modules/vitest/vitest.mjs', 'run', ...job.files] : ['--test', '--test-concurrency=1', ...job.files]);
  const environment = { ...process.env, TUT_TEST_PROFILE: profile, TUT_TEST_REPORT_JSON: report };
  for (const key of ['TUT_POWER_SESSION', 'TUT_HUB_ROOT', 'TUT_PROJECT_ROOT', 'TUT_HUB_URL', 'TUT_EVENT_PORT_URL']) delete environment[key];
  const start = Date.now();
  if (output) console.log(`\n[${job.id}] ${job.files.length} files; watchdog ${job.budgetMs}ms`);
  return await new Promise(resolve => {
    const log = openSync(path.join(resultsDir, `${job.id}.log`), 'w');
    const child = spawn(process.execPath, args, { env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false, interrupted = false, rootExited = false;
    let cleanup;
    child.once('exit', () => {
      rootExited = true;
      if (timedOut || interrupted) { child.stdout.destroy(); child.stderr.destroy(); }
    });
    for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', data => { writeSync(log, data); if (output) target.write(data); });
    const kill = () => {
      if (!child.pid) return;
      // Never target a recyclable PID/group after the root has exited.
      if (rootExited) {
        cleanup = { kind: 'root-already-exited', descendants: 'unverified' };
        child.stdout.destroy(); child.stderr.destroy();
        return;
      }
      if (process.platform === 'win32') {
        const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
        cleanup = { kind: 'taskkill-tree', exitCode: result.status, error: result.error?.message };
        if (result.status !== 0) {
          cleanup.fallbackRootKill = child.kill('SIGKILL');
          child.stdout.destroy(); child.stderr.destroy();
        }
      }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    };
    const interrupt = () => { interrupted = true; kill(); };
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    const timer = setTimeout(() => { timedOut = true; if (output) console.error(`WATCHDOG: ${job.id} exceeded ${job.budgetMs}ms`); kill(); }, job.budgetMs);
    let spawnError;
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (code, signal) => {
      clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      closeSync(log);
      resolve({ id: job.id, files: job.files, elapsedMs: Date.now() - start, budgetMs: job.budgetMs, exitCode: timedOut ? 124 : interrupted ? 130 : code ?? 1, naturalExitCode: code, signal, timedOut, interrupted, ...(spawnError ? { spawnError } : {}), ...(cleanup ? { cleanup } : {}) });
    });
  });
}

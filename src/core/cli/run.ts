import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRigRoot, resolveCliHubUrl } from '../hub/rig-discovery.js';
import { RunStore } from '../run/store.js';
import { startRun, listRuns, attachRun, stopRun } from '../run/control.js';
import { repairRun } from '../run/repair.js';
import { planResume, executeResume, executeManagedResume, ResumeError } from '../run/resume.js';
import { preflightCheckout, renderPreflightReport, fixPreflight, envPreflightFixRunner } from '../preflight/index.js';
import type { ParsedArgs } from './args.js';

async function optionalHub(root: string, action: 'associate' | 'stop' | 'resume', payload: Record<string, unknown>): Promise<void> {
  await new Promise<void>(resolve => {
    execFile(process.execPath, [fileURLToPath(new URL('../run/hub-action.js', import.meta.url)), '--hub-action', root, action, JSON.stringify(payload)],
      { timeout: 2000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
        if (error) process.stderr.write(`tut: ${action === 'associate' ? 'task association unverified' : action === 'resume' ? 'resume note unconfirmed' : 'stop note unconfirmed'}: ${stderr.trim() || error.message}\n`);
        resolve();
      });
  });
}
/** checkout preflight gate: refuse (exit-worthy) when an applicable item
 *  is missing/error. --fix-preflight runs the SUPPORTED repairs first —
 *  bounded, visible, in-checkout only. A FAILED repair step always refuses
 *  (a half-applied install can leave artifacts on disk while the command
 *  itself failed — existence green is NOT success); only after no failure is
 *  the re-check consulted. Never silently installs or builds. */
async function preflightGate(checkout: string, fix: boolean): Promise<boolean> {
  const report = preflightCheckout(checkout);
  if (!report.applicable || report.ok) return true;
  if (fix) {
    const result = await fixPreflight(checkout, envPreflightFixRunner(process.env));
    if (result.failure !== undefined) {
      process.stderr.write(`tut: preflight fix step failed (${result.failure.step.argv.join(' ')}, exit ${result.failure.code ?? `signal ${result.failure.signal}`}); refusing — no agent was started\n`);
      process.stderr.write(`tut: ${renderPreflightReport(result.report)}\n`);
      return false;
    }
    if (result.report.ok) return true;
    process.stderr.write(`tut: ${renderPreflightReport(result.report)}\n`);
    return false;
  }
  process.stderr.write(`tut: ${renderPreflightReport(report)}\n`);
  return false;
}
export async function runProcessCommand(p: Extract<ParsedArgs, { command: 'run' | 'ps' | 'attach' | 'stop' | 'repair-run' }>): Promise<number> {
  const store = new RunStore(resolveRigRoot());
  if (p.command === 'repair-run') {
    let outcome;
    try { outcome = await repairRun(store, p.run_id); }
    catch (e) { process.stderr.write(`tut: repair-run failed: ${p.run_id}: ${(e as Error).message}\n`); return 1; }
    const line = `${p.run_id}: ${outcome.disposition}${'detail' in outcome ? ` — ${outcome.detail}` : ''}${'reason' in outcome ? ` — ${outcome.reason}` : ''}`;
    (outcome.disposition === 'refused' ? process.stderr : process.stdout).write(`${line}\n`);
    if (outcome.disposition === 'quarantined' || outcome.disposition === 'already-quarantined')
      process.stdout.write(`  run log preserved at ${store.directory(p.run_id)}/log — evidence material, never deleted\n`);
    return outcome.disposition === 'refused' ? 1 : 0;
  }
  if (p.command === 'run') {
    if (!(await preflightGate(process.cwd(), p.fixPreflight))) return 1;
    const id = await startRun(store, p.argv, process.cwd(), p.task_id);
    process.stdout.write(`${id}\n`);
    if (p.task_id !== undefined) await optionalHub(store.hubRoot, 'associate', { run_id: id, task_id: p.task_id });
    return 0;
  }
  if (p.command === 'ps') {
    const result = listRuns(store);
    if (p.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write('RUN-ID  TASK  STATUS  PID/ALIVE  PGID/ALIVE  STOP-PHASE/OUTCOME/SCOPE  STARTED  COMMAND\n');
      for (const m of result.runs) process.stdout.write(`${m.run_id}  ${m.task_id ?? '-'}  ${m.status}${m.stale ? ' (stale)' : ''}  ${m.pid}/${m.pid_alive ?? 'unknown'}  ${m.pgid}/${m.group_alive ?? 'unknown'}  ${m.stop_request?.phase ?? '-'}/${m.stop_request?.result?.outcome ?? '-'}/${m.stop_request?.result?.scope ?? 'root-and-original-group'}  ${m.started_at}  ${JSON.stringify(m.argv)}\n`);
      for (const q of result.quarantined) process.stdout.write(`${q.run_id}  -  quarantined  -/-  -/-  -/-/-  -  (isolated invalid meta; log preserved)\n`);
      for (const e of result.errors) process.stderr.write(`${e.run_id}: ${e.error}\n`);
    }
    return result.errors.length ? 1 : 0;
  }
  if (p.command === 'attach') {
    const abort = new AbortController(); const interrupt = () => abort.abort();
    process.on('SIGINT', interrupt);
    try { return await attachRun(store, p.run_id, process.stdout, abort.signal); }
    finally { process.off('SIGINT', interrupt); }
  }
  const stopped = await stopRun(store, p.run_id).catch(error => {
    let identity = '';
    try { const m = store.read(p.run_id); identity = ` pid=${m.pid} pgid=${m.pgid}`; } catch { /* preserve read failure */ }
    throw new Error(`${p.run_id}${identity}: ${(error as Error).message}`);
  });
  const detail = `${p.run_id} pid=${stopped.meta.pid} pgid=${stopped.meta.pgid}: ${stopped.result}`;
  (stopped.success ? process.stdout : process.stderr).write(`${detail}\n`);
  if (stopped.requested && stopped.meta.stop_request?.result) await optionalHub(store.hubRoot, 'stop', { run_id: p.run_id, ...(stopped.meta.task_id ? { task_id: stopped.meta.task_id } : {}),
    requested_at: stopped.meta.stopped_at, success: stopped.success, result: stopped.result, stop_request: stopped.meta.stop_request, scope: 'root-and-original-group', descendants_check: 'not-performed', pid: stopped.meta.pid, pgid: stopped.meta.pgid });
  return stopped.success ? 0 : 1;
}

/** tut resume <run-id> [instruction] [--fix-preflight] — . Stdout
 *  carries ONLY the new run-id; exit 0 means startup CONFIRMED (not task
 *  success). Managed resumes gate on the same-root Hub (role still waiting,
 *  no attention, not pending_approval/approved/closed) and append the manual
 *  launch marker BEFORE spawn, so auto cannot double-start the generation. */
export async function runResumeCommand(p: Extract<ParsedArgs, { command: 'resume' }>): Promise<number> {
  const store = new RunStore(resolveRigRoot());
  let plan;
  try {
    const hubUrl = await resolveCliHubUrl(process.env.TUT_HUB_URL ?? 'http://127.0.0.1:3001', false, resolveRigRoot()).catch(() => process.env.TUT_HUB_URL ?? 'http://127.0.0.1:3001');
    plan = await planResume(store, p.run_id, { ...(p.instruction !== undefined ? { instruction: p.instruction } : {}), hubUrl });
  } catch (e) {
    const suffix = e instanceof ResumeError ? ` (reason: ${e.reason})` : '';
    process.stderr.write(`tut: resume failed: ${(e as Error).message}${suffix}\n`);
    return 1;
  }
  if (!(await preflightGate(plan.cwd, p.fixPreflight))) return 1;
  try {
    let runId: string;
    if (plan.managed) {
      const hubUrl = await resolveCliHubUrl(process.env.TUT_HUB_URL ?? 'http://127.0.0.1:3001', false, resolveRigRoot());
      ({ run_id: runId } = await executeManagedResume(store, plan, { hubUrl, hubRoot: store.hubRoot }));
    } else {
      ({ run_id: runId } = await executeResume(store, plan));
    }
    process.stdout.write(`${runId}\n`);
    await optionalHub(store.hubRoot, 'resume', {
      operation: 'resume',
      audit_id: `resume:${plan.from_run_id}:${runId}`,
      from_run_id: plan.from_run_id,
      run_id: runId,
      ...(plan.task_id !== undefined ? { task_id: plan.task_id, role: plan.from.headless?.role } : {}),
      agent: plan.session.agent,
      session_id: plan.session.session_id,
      identity_source: plan.session.source,
      requested_at: plan.resume.requested_at,
      confirmed_at: new Date().toISOString(),
      status: 'confirmed',
    });
    return 0;
  } catch (e) {
    const message = (e as Error).message;
    const suffix = e instanceof ResumeError ? ` (reason: ${e.reason})` : '';
    process.stderr.write(`tut: resume failed: ${message}${suffix}\n`);
    await optionalHub(store.hubRoot, 'resume', {
      operation: 'resume',
      audit_id: `resume:${plan.from_run_id}:none`,
      from_run_id: plan.from_run_id,
      ...(plan.task_id !== undefined ? { task_id: plan.task_id, role: plan.from.headless?.role } : {}),
      agent: plan.session.agent,
      session_id: plan.session.session_id,
      identity_source: plan.session.source,
      requested_at: plan.resume.requested_at,
      status: e instanceof ResumeError && (e.reason === 'spawn-uncertain' || e.reason === 'session-busy' || e.reason === 'task-busy') ? 'unknown' : 'failed',
    }).catch(() => undefined);
    return 1;
  }
}

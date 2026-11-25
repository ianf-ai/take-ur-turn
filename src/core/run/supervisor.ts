import {stopAfterInputFailure} from './input-stop.js';
import {consumeInvocation} from './prepared.js';
import {deliverInput,validateInput,type InvocationInput} from './input.js';
import {decodeContract,observeSession,legacySessionFromLine} from '../../agents/public/index.js';
/** One detached supervisor per run. It is deliberately outside the command group. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { closeSync, fstatSync, readSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { RunStore, delay, probe, type RunMeta, type HeadlessOwnership, type ResumeSource } from './store.js';
import { CONTROL_PROTOCOL } from './protocol.js';
import { StopController } from './stop-controller.js';
import { assertRunIdentity } from './validation.js';
import { setProcessTitle } from '../common/process-title.js';

export interface StartRequest { invocation?:import('../../agents/public/index.js').ReadyInvocation; input?:InvocationInput; profile?: string|null; root: string; id: string; argv: string[]; cwd: string; task_id?: string; env?: NodeJS.ProcessEnv; headless?: HeadlessOwnership; resume?: ResumeSource; checkout?: string }

/** Recognize native JSONL session evidence; OpenCode frames are route-scoped. */
export const sessionFromLine=legacySessionFromLine;

async function supervise(r: StartRequest): Promise<void> {
  const store = new RunStore(r.root);
  const log = store.openLog(r.id, true);
  const reader = store.openLog(r.id);
  let child: ReturnType<typeof spawn> | undefined;
  let published = false;
  let controller: StopController | undefined;
  let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  try {
    const profile=r.profile?decodeContract(r.profile):undefined;
    r=consumeInvocation(r);
    validateInput(r.input);
    child = spawn(r.argv[0]!, r.argv.slice(1), { shell: false, detached: true, cwd: r.cwd, env: r.env ?? process.env, stdio: [r.input?.kind==='stdin'?'pipe':'ignore', log, log] });
    child.once('exit', (code, signal) => { outcome = { code, signal }; });
    await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
    child.unref();
    const meta: RunMeta = { ...(r.profile!==undefined?{contract:r.profile}:{}),run_id: r.id, ...(r.task_id !== undefined ? { task_id: r.task_id } : {}), pid: child.pid!, pgid: child.pid!,
      argv: r.argv, cwd: r.cwd, supervisor_pid: process.pid, started_at: new Date().toISOString(), status: 'running', control_protocol: CONTROL_PROTOCOL, ...(r.headless ? { headless: r.headless } : {}), ...(r.resume ? { resume: r.resume } : {}), ...(r.checkout !== undefined ? { checkout: r.checkout } : {}) };
    const delivery=r.input?.kind==='stdin'?deliverInput(child.stdin!,r.input.text):undefined;
    if(delivery)meta.input_delivery=delivery.state;
    child.once('exit',()=>delivery?.cancel('target exited before input delivery'));
    await store.initialize(r.id, meta);
    published = true;
    controller = new StopController(store, meta, () => outcome);
    if (process.connected) { process.send?.({ ok: true }, () => undefined); process.disconnect?.(); }
    closeSync(log);
    let cursor = 0; let pending = ''; let overflow = false; let session: string | undefined;
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      // Bounded incremental recognition; raw log bytes are never transformed.
      const end = fstatSync(reader).size;
      while (cursor < end) {
        const n = readSync(reader, buffer, 0, Math.min(buffer.length, end - cursor), cursor); if (!n) break;
        cursor += n;
        if (!session) {
          for (const part of decoder.write(buffer.subarray(0, n)).split(/(?<=\n)/u)) {
            pending += part;
            if (pending.length > 1024 * 1024) { overflow = true; pending = ''; }
            if (part.endsWith('\n')) {
              if (!overflow) session = (r.profile===null?undefined:profile?observeSession(profile,pending):sessionFromLine(pending, path.basename(r.argv[0]!))) ?? session;
              pending = ''; overflow = false;
            }
          }
        }
      }
      const current = store.read(r.id);
      assertRunIdentity(current, meta);
      if ((session && current.agent_session_id !== session) || current.identity_probe !== current.identity_ack) {
        await store.updateMeta(r.id, m => { assertRunIdentity(m, meta); return { ...m, ...(session ? { agent_session_id: session } : {}), ...(m.identity_probe ? { identity_ack: m.identity_probe } : {}) }; });
      }
      if (outcome && !current.root_exited_at) {
        await store.updateMeta(r.id, m => { assertRunIdentity(m, meta); return { ...m, root_exited_at: new Date().toISOString(),
          ...(outcome!.code !== null ? { exit_code: outcome!.code } : {}), ...(outcome!.signal ? { exit_signal: outcome!.signal } : {}) }; });
      }
      if(delivery) {
        if(current.stop_request)delivery.cancel('input cancelled by stop');
        if(current.input_delivery?.status!==delivery.state.status)await store.updateMeta(r.id,m=>{assertRunIdentity(m,meta);return {...m,input_delivery:delivery.state};});
        if(delivery.state.status==='failed')await stopAfterInputFailure(store,r.id,meta);
      }
      await controller.step();
      if (outcome && probe(-meta.pgid) === false) {
        if (fstatSync(reader).size > cursor) continue;
        const finished = await store.updateMeta(r.id, m => {
          assertRunIdentity(m, meta);
          // Re-read under lock: a CLI request can race the normal exit path.
          // The controller must merge a final result before the monitor exits.
          if (m.stop_request && !m.stop_request.result) return m;
          return { ...m, status: m.stopped_at ? 'stopped' : 'exited', ended_at: m.ended_at ?? new Date().toISOString(),
            ...(outcome!.code !== null ? { exit_code: outcome!.code } : {}), ...(outcome!.signal ? { exit_signal: outcome!.signal } : {}) };
        });
        if (finished.stop_request && !finished.stop_request.result) continue;
        return;
      }
      await delay(100);
    }
  } catch (e) {
    try { await controller?.fail(e as Error); } catch { /* Uncertain phase stays on disk; diagnostic below. */ }
    if (!published && child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Known group only; original error wins. */ } }
    if (process.connected) { process.send?.({ ok: false, error: (e as Error).message, uncertain: !!child?.pid }, () => undefined); process.disconnect?.(); }
    const diagnostic = store.openLog(r.id, true);
    try { writeSync(diagnostic, `\n[tut supervisor] ${(e as Error).message}\n`); } finally { closeSync(diagnostic); }
    process.exitCode = 1;
  } finally { try { closeSync(log); } catch { /* already closed */ } closeSync(reader); }
}
if (process.argv[2] === '--supervise') {
  setProcessTitle('tut-run'); // placeholder until the run id arrives over IPC
  const timeout = setTimeout(() => { process.exitCode = 1; process.disconnect?.(); }, 5000);
  process.once('message', (request: StartRequest) => { clearTimeout(timeout); setProcessTitle(`tut-run.${request.id}`); void supervise(request); });
}

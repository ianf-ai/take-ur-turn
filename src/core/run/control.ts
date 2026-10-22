import { fork } from 'node:child_process';
import { closeSync, fstatSync, readSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { RunStore, delay, probe, validateHeadlessOwnership, type RunMeta, type HeadlessOwnership, type ResumeSource } from './store.js';
import { quarantinedMarker } from './repair.js';
import { CONTROL_PROTOCOL, STOP_SCOPE } from './protocol.js';
import { assertRunIdentity } from './validation.js';

export function requirePosix(platform = process.platform): void {
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('run/stop require POSIX process groups (macOS/Linux)');
}
export interface StartOptions { env?: NodeJS.ProcessEnv; headless?: HeadlessOwnership; resume?: ResumeSource; checkout?: string }
export class StartRunError extends Error {
  constructor(message: string, readonly runId: string, readonly uncertain: boolean) { super(message); this.name = "StartRunError"; }
}
export async function startRun(store: RunStore, argv: string[], cwd: string, task_id?: string, options: StartOptions = {}): Promise<string> {
  requirePosix();
  if (!argv[0] || argv.some(s => s.includes('\0'))) throw new Error('command executable required; NUL is not permitted');
  if (options.headless) { validateHeadlessOwnership(options.headless); if (!task_id) throw new Error("headless ownership requires task_id"); }
  if (options.resume && !/^(\d{8}T\d{9}Z-[a-f0-9]{8})$/.test(options.resume.from_run_id)) throw new Error('resume source requires the original run id');
  const id = store.create();
  // Test writability before any command process can be started.
  closeSync(store.openLog(id, true));
  if (options.headless) await store.writeStartIntent(id,{task_id:task_id!,headless:options.headless,cwd,startup:'pending'});
  // Resume reservations persist before spawn under every flow: an
  // uncertain handshake must remain attributable to its session identity.
  if (options.resume) {
    await store.writeResumeIntent(id, { schema: 1, from_run_id: options.resume.from_run_id, agent: options.resume.agent,
      session_id: options.resume.session_id, cwd, startup: 'pending' });
  }
  const supervisor = fork(fileURLToPath(new URL('./supervisor.js', import.meta.url)), ['--supervise'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new StartRunError(`startup handshake timed out; inspect incomplete/uncertain run ${id}, do not retry blindly`, id, true)), 5000);
      function finish(error?: Error): void { clearTimeout(timeout); supervisor.removeAllListeners('message'); supervisor.removeAllListeners('exit'); error ? reject(error) : resolve(); }
      supervisor.once('error', e => finish(new StartRunError(e.message,id,false)));
      supervisor.once('exit', (code, signal) => finish(new StartRunError(`supervisor exited before startup confirmation (${code ?? signal}); inspect ${id}`, id, true)));
      supervisor.once('message', (message: { ok?: boolean; error?: string; uncertain?: boolean }) => finish(message.ok ? undefined : new StartRunError(`run ${id}: ${message.error ?? 'startup failed'}`, id, message.uncertain === true)));
      supervisor.send({ root: store.hubRoot, id, argv, cwd, ...(task_id !== undefined ? { task_id } : {}), ...(options.env ? {env:options.env} : {}), ...(options.headless ? {headless:options.headless} : {}), ...(options.resume ? {resume:options.resume} : {}), ...(options.checkout !== undefined ? {checkout:options.checkout} : {}) }, error => { if (error) finish(new StartRunError(error.message,id,true)); });
    });
    return id;
  } catch (e) {
    if (options.headless && e instanceof StartRunError && !e.uncertain) {
      await store.writeStartIntent(id,{task_id:task_id!,headless:options.headless,cwd,startup:'failed'});
    }
    if (options.resume && e instanceof StartRunError && !e.uncertain) {
      await store.writeResumeIntent(id, { schema: 1, from_run_id: options.resume.from_run_id, agent: options.resume.agent,
        session_id: options.resume.session_id, cwd, startup: 'failed' }).catch(() => undefined);
    }
    throw e;
  } finally {
    if (supervisor.connected) supervisor.disconnect();
    supervisor.unref();
  }
}
export function listRuns(store: RunStore): { runs: (RunMeta & { pid_alive: boolean | null; group_alive: boolean | null; stale: boolean; supervisor_alive: boolean | null })[]; errors: { run_id: string; error: string }[]; quarantined: { run_id: string; note: string }[] } {
  const runs: ReturnType<typeof listRuns>['runs'] = []; const errors: ReturnType<typeof listRuns>['errors'] = []; const quarantined: ReturnType<typeof listRuns>['quarantined'] = [];
  for (const id of store.list()) {
    try {
      const m = store.read(id); const group_alive = probe(-m.pgid);
      runs.push({ ...m, pid_alive: probe(m.pid), group_alive, supervisor_alive: probe(m.supervisor_pid), stale: !m.ended_at && (m.control_protocol === CONTROL_PROTOCOL ? probe(m.supervisor_pid) === false : m.status === 'running' && group_alive === false) });
    } catch (e) {
      // An isolated archive is a DISPOSITION, not unreadable damage: keep it
      // visible with its marker (stdout + exit 0), never as an error line.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const marker = quarantinedMarker(store, id);
        if (marker !== undefined) {
          quarantined.push({ run_id: id, note: `quarantined: invalid meta isolated as ${marker}; run log preserved` });
          continue;
        }
      }
      errors.push({ run_id: id, error: `incomplete/unreadable: ${(e as Error).message}` });
    }
  }
  return { runs, errors, quarantined };
}

export interface StopResult { meta: RunMeta; requested: boolean; success: boolean; result: string }
export interface StopOptions {
  identityMs?: number; waitMs?: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  probe?: typeof probe;
}
/** CLI only publishes a request. The original supervisor owns all signals. */
export async function stopRun(store: RunStore, id: string, options: StopOptions = {}): Promise<StopResult> {
  requirePosix();
  const now = options.now ?? (() => performance.now()); const sleep = options.sleep ?? delay;
  const alive = options.probe ?? probe;
  let requested = false;
  let meta = store.read(id);
  const initial = meta;
  const result = (success: boolean, reason: string): StopResult => ({ meta, requested, success, result: `${reason}; scope=${STOP_SCOPE}; descendants_check=not-performed` });
  const completed = (): StopResult | undefined => {
    const stop = meta.control_protocol === CONTROL_PROTOCOL ? meta.stop_request?.result : undefined;
    if (stop) return result(stop.success, `${stop.outcome}${stop.error ? ': ' + stop.error : ''}`);
    if (meta.ended_at || meta.status === 'exited') {
      if (meta.control_protocol === CONTROL_PROTOCOL && meta.stop_request) return result(false, 'incomplete: ended without final stop result');
      return result(true, `${meta.control_protocol === CONTROL_PROTOCOL ? 'already-ended' : 'legacy/group-only already-ended (historical evidence only)'}`);
    }
    return undefined;
  };
  const terminal = completed(); if (terminal) return terminal;
  if (meta.control_protocol !== CONTROL_PROTOCOL) throw new Error('legacy-control/unsupported: active run has no cooperative stop protocol');
  if (!meta.stop_request) {
    const unlock = await store.lock(id, 'stop', 100);
    try {
      meta = store.read(id); assertRunIdentity(meta, initial);
      const terminal = completed(); if (terminal) return terminal;
      if (!meta.stop_request) {
        if (meta.supervisor_pid === process.pid || meta.pid === process.pid) throw new Error('refusing caller/supervisor identity');
        if (alive(meta.supervisor_pid) !== true) throw new Error('identity-unverified: supervisor unavailable');
        const nonce = randomBytes(16).toString('hex');
        meta = await store.updateMeta(id, m => { assertRunIdentity(m, initial); return { ...m, identity_probe: nonce }; });
        const deadline = now() + (options.identityMs ?? 1500);
        for (;;) {
          meta = store.read(id); assertRunIdentity(meta, initial);
          const terminal = completed(); if (terminal) return terminal;
          if (meta.identity_ack === nonce) break;
          if (now() >= deadline) throw new Error('identity-unverified: supervisor did not acknowledge fresh challenge');
          if (alive(meta.supervisor_pid) === false) throw new Error('identity-unverified: supervisor lost during challenge');
          await sleep(25);
        }
        let newRequest = false;
        meta = await store.updateMeta(id, m => {
          assertRunIdentity(m, initial);
          if (m.ended_at || m.status === 'exited' || m.stop_request) return m;
          if (m.stopped_at) throw new Error('incomplete legacy stop evidence; refusing to restart request');
          const requested_at = new Date().toISOString(); const requested_by = `${userInfo().username}:pid=${process.pid}`;
          newRequest = true;
          return { ...m, status: 'stopped', stopped_at: requested_at, stopped_by: requested_by,
            stop_request: { id: randomBytes(16).toString('hex'), requested_at, requested_by, phase: 'requested', signals: [] } };
        });
        requested = newRequest;
      }
    } finally { unlock(); }
  }
  const terminalAfterRequest = completed(); if (terminalAfterRequest) return terminalAfterRequest;
  const requestId = meta.stop_request?.id;
  if (!requestId) return result(false, 'incomplete: no accepted request');
  const deadline = now() + (options.waitMs ?? 15000);
  for (;;) {
    meta = store.read(id); assertRunIdentity(meta, initial);
    if (meta.stop_request?.id !== requestId) throw new Error('stop request identity changed');
    const terminal = completed(); if (terminal) return terminal;
    if (alive(meta.supervisor_pid) === false) return result(false, `incomplete: supervisor lost in ${meta.stop_request.phase}; result unconfirmed`);
    if (now() >= deadline) return result(false, `incomplete: ${meta.stop_request.phase} in-progress; result unconfirmed (request not restarted)`);
    await sleep(50);
  }
}

/** Read-only byte cursor, including the final unterminated line. */
export async function attachRun(store: RunStore, id: string, output: Writable = process.stdout, signal?: AbortSignal): Promise<number> {
  store.read(id);
  const fd = store.openLog(id);
  const buffer = Buffer.alloc(64 * 1024);
  try {
    const size = fstatSync(fd).size;
    let start = size; let count = 0;
    // A trailing newline terminates a line; it does not create a 51st empty one.
    while (start > 0 && count <= 50) {
      const from = Math.max(0, start - buffer.length);
      const n = readSync(fd, buffer, 0, start - from, from);
      let found = false;
      for (let i = n - 1; i >= 0; i--) {
        if (buffer[i] === 10 && from + i !== size - 1) {
          count++; if (count === 50) { start = from + i + 1; found = true; break; }
        }
      }
      if (found) break;
      start = from;
    }
    let cursor = start;
    const drain = async (): Promise<void> => {
      const end = fstatSync(fd).size;
      if (end < cursor) throw new Error('append-only run log was truncated');
      while (cursor < end && !signal?.aborted) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, end - cursor), cursor);
        if (!n) break;
        cursor += n;
        // Copy: a backpressured stream may retain this chunk after write().
        if (!output.write(Buffer.from(buffer.subarray(0, n)))) await once(output, 'drain', signal ? { signal } : {});
      }
    };
    while (!signal?.aborted) {
      await drain();
      const m = store.read(id);
      if (m.control_protocol === CONTROL_PROTOCOL) {
        if (m.stop_request?.result?.success === false) { await drain(); throw new Error(`stop incomplete: ${m.stop_request.result.error ?? 'unconfirmed'}`); }
        if (m.ended_at && (!m.stop_request || m.stop_request.result)) { await drain(); return 0; }
        if (probe(m.supervisor_pid) === false) { await drain(); throw new Error('supervisor lost; run completion unconfirmed'); }
      } else if (probe(-m.pgid) === false) { await drain(); return 0; }
      await delay(100);
    }
    return 130;
  } catch (e) { if (signal?.aborted) return 130; throw e; }
  finally { closeSync(fd); }
}

import path from 'node:path';
import { fork } from 'node:child_process';
import { closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { RunStore, delay, probe, complete, validateHeadlessOwnership } from './store.js';
import { StartRunError, type StartOptions, type StopOptions, type StopResult } from './control-contract.js';
import { listRuns as posixList } from './control-posix.js';
import { assertRunIdentity } from './validation.js';
import { openRunFile, type RunFile } from '../hub/run-file.js';
import { WINDOWS_PROTOCOL, WINDOWS_SCOPE, windowsMeta } from './windows-protocol.js';
/** Resolve native executables once before reserving a run; shell/npm shims belong to the target planner. */
function nativeExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
    const hasPath = /[\\/]/.test(command) || path.isAbsolute(command);
    const candidates = hasPath ? [path.resolve(cwd, command)] : (env.PATH ?? env.Path ?? '').split(path.delimiter).map(dir => path.resolve(cwd, dir, command));
    for (const candidate of candidates) {
        for (const file of /\.(exe|com)$/i.test(candidate) ? [candidate] : [candidate + '.exe', candidate + '.com']) {
            try { if (statSync(file).isFile()) return file; } catch { /* Continue through PATH; never invoke a shell. */ }
        }
    }
    throw new Error('preflight-rejected: native executable not found; resolve npm shim before startRun');
}
export async function startRun(store: RunStore, argv: string[], cwd: string, task_id?: string, options: StartOptions = {}): Promise<string> {
    if (!argv[0] || argv.some(s => s.includes('\0')) || /\.(cmd|bat)$/i.test(argv[0]))
        throw new Error('preflight-rejected: native executable required (resolve npm shim before startRun)');
    argv = [nativeExecutable(argv[0]!, cwd, options.env ?? process.env), ...argv.slice(1)];
    if (options.headless) {
        validateHeadlessOwnership(options.headless);
        if (!task_id)
            throw new Error('headless ownership requires task_id');
    }
    const id = store.create();
    closeSync(store.openLog(id, true));
    if (options.headless)
        await store.writeStartIntent(id, { task_id: task_id!, headless: options.headless, cwd, startup: 'pending' });
    if (options.resume)
        await store.writeResumeIntent(id, { schema: 1, from_run_id: options.resume.from_run_id, agent: options.resume.agent, session_id: options.resume.session_id, cwd, startup: 'pending' });
    const supervisor = fork(fileURLToPath(new URL('./supervisor-windows.js', import.meta.url)), ['--supervise-windows'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => finish(new StartRunError('created-unacknowledged: Windows startup timed out; retain reservation', id, true)), 40000);
            function finish(e?: Error): void { if (settled)
                return; settled = true; clearTimeout(timer); e ? reject(e) : resolve(); }
            supervisor.once('error', e => finish(new StartRunError(e.message, id, false)));
            supervisor.once('exit', () => finish(new StartRunError('created-unacknowledged: Windows supervisor lost', id, true)));
            supervisor.once('message', (m: any) => finish(m.ok ? undefined : new StartRunError(m.error ?? 'Windows startup failed', id, m.uncertain !== false)));
            supervisor.send({ root: store.hubRoot, id, argv, cwd, task_id, ...options }, e => { if (e)
                finish(new StartRunError(e.message, id, true)); });
        });
        return id;
    }
    catch (e) {
        if (e instanceof StartRunError && !e.uncertain) {
            if (options.headless)
                await store.writeStartIntent(id, { task_id: task_id!, headless: options.headless, cwd, startup: 'failed' });
            if (options.resume)
                await store.writeResumeIntent(id, { schema: 1, from_run_id: options.resume.from_run_id, agent: options.resume.agent, session_id: options.resume.session_id, cwd, startup: 'failed' });
        }
        throw e;
    }
    finally {
        if (supervisor.connected)
            supervisor.disconnect();
        supervisor.unref();
    }
}
export function listRuns(store: RunStore): ReturnType<typeof posixList> {
    const result = posixList(store);
    for (const row of result.runs)
        if (row.control_protocol === WINDOWS_PROTOCOL) {
            const m = windowsMeta(row);
            const o = m.windows.observation;
            const fresh = probe(m.supervisor_pid) === true && o && Date.now() - Date.parse(o.observed_at) >= 0 && Date.now() - Date.parse(o.observed_at) < 2000;
            row.group_alive = complete(m) ? false : fresh ? !o.job_empty : null;
            row.pid_alive = complete(m) ? false : fresh ? !o.root_exited : null;
            row.stale = !complete(m) && (!fresh || !!m.windows.error);
        }
    return result;
}
export async function stopRun(store: RunStore, id: string, options: StopOptions = {}): Promise<StopResult> {
    let meta = windowsMeta(store.read(id));
    const initial = meta;
    const now = options.now ?? (() => performance.now());
    const sleep = options.sleep ?? delay;
    const alive = options.probe ?? probe;
    let requested = false;
    const result = (success: boolean, reason: string): StopResult => ({ meta, requested, success, result: `${reason}; scope=${WINDOWS_SCOPE}; descendants_check=job-members-only` });
    const terminal = (): StopResult | undefined => {
        const r = meta.stop_request?.result;
        if (r)
            return result(r.success, `${r.outcome}${r.error ? ': ' + r.error : ''}`);
        if (complete(meta))
            return result(true, 'already-ended');
        return undefined;
    };
    const read = (): void => { meta = windowsMeta(store.read(id)); assertRunIdentity(meta, initial); };
    let done = terminal();
    if (done)
        return done;
    if (!meta.stop_request) {
        // Wait through the first caller's bounded challenge, then join its request.
        const unlock = await store.lock(id, 'stop', (options.identityMs ?? 7000) + 2000);
        try {
            read();
            done = terminal();
            if (done)
                return done;
            if (!meta.stop_request) {
                if (meta.windows.error)
                    throw new Error(meta.windows.error);
                if (meta.supervisor_pid === process.pid || meta.pid === process.pid || alive(meta.supervisor_pid) !== true)
                    throw new Error('identity-unverified: original supervisor unavailable; target may still be alive');
                const nonce = randomBytes(32).toString('hex');
                await store.updateMeta(id, m => { assertRunIdentity(m, initial); return { ...m, identity_probe: nonce }; });
                const deadline = now() + (options.identityMs ?? 7000);
                for (;;) {
                    read();
                    done = terminal();
                    if (done)
                        return done;
                    if (meta.windows.error)
                        throw new Error(meta.windows.error);
                    if (meta.identity_ack === nonce)
                        break;
                    if (now() >= deadline || alive(meta.supervisor_pid) === false)
                        throw new Error('identity-unverified: broker challenge not acknowledged; no control sent');
                    await sleep(25);
                }
                meta = windowsMeta(await store.updateMeta(id, m => {
                    assertRunIdentity(m, initial);
                    if (complete(m) || m.stop_request)
                        return m;
                    const requested_at = new Date().toISOString();
                    const requested_by = `${userInfo().username}:pid=${process.pid}`;
                    requested = true;
                    return { ...m, status: 'stopped', stopped_at: requested_at, stopped_by: requested_by, stop_request: { id: randomBytes(16).toString('hex'), requested_at, requested_by, phase: 'requested', signals: [], actions: [] } };
                }));
            }
        }
        finally {
            unlock();
        }
    }
    const request = meta.stop_request?.id;
    // The 5+5+2s native stages also require safe metadata reads and durable
    // intent/receipt publication. Leave room to observe their committed result
    // after the ladder; explicit caller deadlines still take precedence.
    const deadline = now() + (options.waitMs ?? 60000);
    for (;;) {
        read();
        done = terminal();
        if (done)
            return done;
        if (meta.stop_request?.id !== request)
            throw new Error('stop request identity changed');
        if (meta.windows.error || alive(meta.supervisor_pid) === false)
            return result(false, meta.windows.error ?? 'observer-lost: target may still be alive; request not restarted');
        if (now() >= deadline)
            return result(false, `incomplete: ${meta.stop_request?.phase}; request not restarted`);
        await sleep(50);
    }
}
export async function attachRun(store: RunStore, id: string, output: Writable = process.stdout, signal?: AbortSignal): Promise<number> {
    // Windows keeps native read-only handles inside its helper for the whole
    // view, including backpressure waits; no ordinary open on the hot path.
    const log: RunFile = await openRunFile(store.directory(id) + '/log');
    const buffer = Buffer.alloc(65536);
    try {
        let cursor = (await log.stat()).size;
        const end = cursor;
        let lines = 0;
        let found = false;
        while (cursor > 0 && !found) {
            const from = Math.max(0, cursor - buffer.length);
            const { bytesRead: n } = await log.read(buffer, 0, cursor - from, from);
            for (let i = n - 1; i >= 0; i--)
                if (buffer[i] === 10 && from + i !== end - 1 && ++lines === 50) {
                    cursor = from + i + 1;
                    found = true;
                    break;
                }
            if (!found)
                cursor = from;
        }
        const drain = async (): Promise<void> => {
            const size = (await log.stat()).size;
            if (size < cursor)
                throw new Error('append-only run log was truncated');
            while (cursor < size && !signal?.aborted) {
                const { bytesRead: n } = await log.read(buffer, 0, Math.min(buffer.length, size - cursor), cursor);
                if (!n)
                    break;
                cursor += n;
                if (!output.write(Buffer.from(buffer.subarray(0, n))))
                    await once(output, 'drain', signal ? { signal } : {});
            }
        };
        for (;;) {
            await drain();
            if (signal?.aborted)
                return 130;
            const m = windowsMeta(store.read(id));
            if (complete(m)) {
                // Completion may have been published while the first drain was
                // backpressured. Read the final EOF before reporting success.
                await drain();
                return signal?.aborted ? 130 : 0;
            }
            if (m.windows.error || m.stop_request?.result?.success === false || probe(m.supervisor_pid) === false) {
                await drain();
                if (signal?.aborted) return 130;
                throw new Error(m.windows.error ?? 'observer-lost: run completion unconfirmed');
            }
            await delay(100);
        }
    }
    catch (e) {
        if (signal?.aborted)
            return 130;
        throw e;
    }
    finally {
        await log.close();
    }
}

import {stopAfterInputFailure} from './input-stop.js';
import {consumeInvocation} from './prepared.js';
import {validateInput} from './input.js';
import path from 'node:path';
import { closeSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { RunStore, delay } from './store.js';
import type { StartRequest } from './supervisor.js';
import { launchBroker, type BrokerClient, type CreatedTarget } from './windows-broker.js';
import { WINDOWS_PROTOCOL, windowsMeta, type WindowsRunMeta } from './windows-protocol.js';
import { WindowsStopController } from './windows-controller.js';
import { assertRunIdentity } from './validation.js';
export async function supervise(r: StartRequest): Promise<void> {
    const store = new RunStore(r.root);
    return store.withMetadataReads(() => superviseWithMetadataReads(r, store));
}
async function superviseWithMetadataReads(r: StartRequest, store: RunStore): Promise<void> {
    let broker: BrokerClient | undefined;
    let initial: WindowsRunMeta | undefined;
    let controller: WindowsStopController | undefined;
    try {
        r=consumeInvocation(r);
        validateInput(r.input);
        broker = await launchBroker(r.id, r.headless?.attempt_id);
        const job_id = randomBytes(16).toString('hex');
        const created: CreatedTarget = await broker.request('create-target', { argv: r.argv, cwd: r.cwd, env: r.env ?? process.env, log: store.logPath(r.id), ...(r.input?{input:r.input}:{}), job_id });
        initial = { ...(r.profile!==undefined?{contract:r.profile}:{}),run_id: r.id, pid: created.pid, pgid: created.pid, supervisor_pid: process.pid, argv: r.argv, cwd: r.cwd, started_at: new Date().toISOString(), status: 'running', control_protocol: WINDOWS_PROTOCOL,
            windows: { identity: created.identity }, ...(r.task_id ? { task_id: r.task_id } : {}), ...(r.headless ? { headless: r.headless } : {}), ...(r.resume ? { resume: r.resume } : {}), ...(r.checkout ? { checkout: r.checkout } : {}) };
        await store.initialize(r.id, initial);
        controller = new WindowsStopController(store, initial, broker);
        if (process.connected) {
            process.send?.({ ok: true });
            process.disconnect?.();
        }
        const acknowledge = async (current: WindowsRunMeta): Promise<void> => {
            if (!current.identity_probe || current.identity_probe === current.identity_ack)
                return;
            const challenge = current.identity_probe;
            const ack = await broker!.request('challenge', { challenge });
            if (ack.challenge !== challenge)
                throw new Error('identity-unverified: native broker challenge mismatch');
            await store.updateMeta(r.id, m => { assertRunIdentity(m, initial!); return { ...m, identity_ack: challenge }; });
        };
        for (;;) {
            let current = windowsMeta(await store.readAsync(r.id));
            assertRunIdentity(current, initial);
            await acknowledge(current);
            const observation = await broker.observe();
            if(r.input?.kind==='stdin'&&!observation.input_delivery)throw Error('identity-unverified: missing input observation');
            if(observation.root_exited&&observation.input_delivery?.status==='pending')observation.input_delivery={...observation.input_delivery,status:'failed',error:'target exited before input delivery'};
            current = windowsMeta(await store.updateMeta(r.id, value => {
                const m = windowsMeta(value);
                assertRunIdentity(m, initial!);
                return { ...m,
                    ...(observation.input_delivery?{input_delivery:observation.input_delivery}:{}),
                    windows: { ...m.windows, observation: { ...observation, observed_at: new Date().toISOString() } },
                    ...(observation.root_exited ? { root_exited_at: m.root_exited_at ?? new Date().toISOString(), exit_code: observation.exit_code! } : {}) };
            }));
            // The observation RMW can first see a caller's freshly published
            // probe. Answer it before further synchronous safe reads defer it
            // to the next poll and consume the caller's identity deadline.
            await acknowledge(current);
            if(current.input_delivery?.status==='failed')await stopAfterInputFailure(store,r.id,initial);
            await controller.step();
            current = windowsMeta(await store.readAsync(r.id));
            if (current.stop_request?.result?.success === false)
                return;
            if (observation.root_exited && observation.job_empty) {
                const done = await store.updateMeta(r.id, m => {
                    assertRunIdentity(m, initial!);
                    if (m.stop_request && !m.stop_request.result)
                        return m;
                    return { ...m, status: m.stopped_at ? 'stopped' : 'exited', ended_at: m.ended_at ?? new Date().toISOString() };
                });
                if (done.ended_at)
                    return;
            }
            await delay(100);
        }
    }
    catch (e) {
        const error = e as Error;
        if (initial) {
            try {
                await controller?.fail(error);
                await store.updateMeta(r.id, value => { const m = windowsMeta(value); assertRunIdentity(m, initial!); return { ...m, windows: { ...m.windows, error: error.message } }; });
            }
            catch { /* Original uncertain intent remains authoritative. */ }
        }
        if (process.connected) {
            process.send?.({ ok: false, error: error.message, uncertain: true });
            process.disconnect?.();
        }
        try {
            const fd = store.openLog(r.id, true);
            try {
                writeSync(fd, `\n[tut Windows supervisor] ${error.message}\n`);
            }
            finally {
                closeSync(fd);
            }
        }
        catch { /* Do not hide the failure by fabricating completion. */ }
        process.exitCode = 1;
    }
    finally {
        broker?.close();
    }
}
if (process.argv[2] === '--supervise-windows') {
    const timer = setTimeout(() => { process.disconnect?.(); process.exitCode = 1; }, 5000);
    process.once('message', (r: StartRequest) => { clearTimeout(timer); void supervise(r); });
}

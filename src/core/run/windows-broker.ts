/** Private, bounded UTF-8 transport. A timeout poisons the channel: no replay/reconnect. */
import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { delay } from './store.js';
import { WINDOWS_PROTOCOL, type BrokerBinding, type WindowsAction, type WindowsReceipt, type WindowsObservation, type WindowsIdentity } from './windows-protocol.js';
export const MAX_BROKER_FRAME = 1024 * 1024;
export class BrokerClient {
    private seq = 0;
    private pending: {
        seq: number;
        resolve: (value: any) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
    } | undefined;
    private bytes = Buffer.alloc(0);
    private failure: Error | undefined;
    constructor(private socket: Socket, readonly binding: BrokerBinding, private timeoutMs = 5000) {
        socket.on('data', chunk => this.receive(chunk));
        socket.on('error', e => this.fail(new Error(`observer-lost: ${e.message}`)));
        socket.on('close', () => this.fail(new Error('observer-lost: broker disconnected; target may still be alive')));
    }
    get nextSeq(): number { return this.seq + 1; }
    private fail(error: Error): void {
        // Preserve the first transport evidence. Pipe/helper loss may surface as
        // observer-lost (socket error/close) or delivery-uncertain (write callback
        // or missing receipt); either poisons the channel without replay.
        this.failure ??= error;
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(this.failure);
            this.pending = undefined;
        }
        this.socket.destroy();
    }
    close(): void { this.fail(new Error('observer-lost: channel closed')); }
    private receive(chunk: Buffer): void {
        this.bytes = Buffer.concat([this.bytes, chunk]);
        if (this.bytes.length > MAX_BROKER_FRAME) {
            this.fail(new Error('delivery-uncertain: oversized broker frame'));
            return;
        }
        let index: number;
        while ((index = this.bytes.indexOf(10)) !== -1) {
            const frame = this.bytes.subarray(0, index);
            this.bytes = this.bytes.subarray(index + 1);
            try {
                const reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
                if (!this.pending || reply.seq !== this.pending.seq || Object.entries(this.binding).some(([k, v]) => reply[k] !== v))
                    throw new Error('identity-unverified: unexpected/late broker receipt');
                const p = this.pending;
                this.pending = undefined;
                clearTimeout(p.timer);
                if (reply.error) {
                    const e = new Error(String(reply.error));
                    p.reject(e);
                    this.fail(e);
                    return;
                }
                p.resolve(reply.value);
            }
            catch (e) {
                this.fail(e as Error);
            }
        }
    }
    request(operation: string, payload: unknown = {}): Promise<any> {
        if (this.failure)
            return Promise.reject(this.failure);
        if (this.pending)
            return Promise.reject(new Error('broker command already in progress'));
        const seq = ++this.seq;
        const frame = Buffer.from(JSON.stringify({ ...this.binding, seq, operation, deadline_ms: this.timeoutMs, payload }) + '\n', 'utf8');
        if (frame.length > MAX_BROKER_FRAME)
            return Promise.reject(new Error('preflight-rejected: broker frame too large'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new Error('delivery-uncertain: broker/helper deadline exceeded; no escalation or replay')), this.timeoutMs);
            this.pending = { seq, resolve, reject, timer };
            this.socket.write(frame, e => { if (e)
                this.fail(new Error(`delivery-uncertain: ${e.message}`)); });
        });
    }
    async observe(): Promise<WindowsObservation> {
        const o = await this.request('observe');
        if (!o || typeof o.root_exited !== 'boolean' || typeof o.job_empty !== 'boolean' ||
            (o.root_exited && (!Number.isSafeInteger(o.exit_code) || o.exit_code < 0 || o.exit_code > 0xffffffff))) {
            this.fail(new Error('identity-unverified: invalid native observation'));
            throw this.failure;
        }
        return o;
    }
    async action(action: WindowsAction, operation: string): Promise<WindowsReceipt> {
        const r = await this.request(action, { operation });
        if (!r || !Array.isArray(r.targets) || r.targets.some((t: any) => !Number.isSafeInteger(t.pid) || t.pid <= 1 || !/^\d+$/.test(t.creation_time) || !Number.isSafeInteger(t.return_code))) {
            this.fail(new Error('delivery-uncertain: invalid native receipt'));
            throw this.failure;
        }
        return r;
    }
}
export async function launchBroker(run_id: string, attempt_id: string = randomUUID()): Promise<BrokerClient> {
    const nonce = randomBytes(32).toString('hex');
    const pipe = `tut-run-${randomBytes(24).toString('hex')}`;
    const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = fileURLToPath(new URL('../../../scripts/windows-run/broker.ps1', import.meta.url));
    const bootstrap = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Launch', '-Pipe', pipe, '-RunId', run_id, '-Attempt', attempt_id, '-Nonce', nonce], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const identity = await new Promise<{
        pid: number;
        created: string;
    }>((resolve, reject) => {
        let output = '';
        let error = '';
        let settled = false;
        const timer = setTimeout(() => finish(new Error('created-unacknowledged: broker bootstrap timed out')), 15000);
        function finish(e?: Error): void {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (e) {
                // Stop waiting without killing the broker or any possible target.
                bootstrap.stdout.destroy();
                bootstrap.stderr.destroy();
                bootstrap.unref();
                reject(e);
            }
            else {
                try {
                    const i = JSON.parse(output.trim());
                    if (!Number.isSafeInteger(i.pid) || i.pid <= 1 || !/^\d+$/.test(i.created))
                        throw new Error('invalid bootstrap identity');
                    resolve(i);
                }
                catch (e) {
                    reject(e);
                }
            }
        }
        bootstrap.stdout.on('data', c => { output += c.toString('utf8'); if (output.length > 4096)
            finish(new Error('invalid bootstrap output')); });
        bootstrap.stderr.on('data', c => { error = (error + c.toString('utf8')).slice(-4096); });
        bootstrap.once('error', e => finish(e));
        bootstrap.once('close', code => finish(code === 0 ? undefined : new Error(`broker bootstrap failed: ${error}`)));
    });
    const deadline = performance.now() + 15000;
    for (;;) {
        try {
            const socket = await new Promise<Socket>((resolve, reject) => {
                const s = connect(`\\\\.\\pipe\\${pipe}`);
                const timer = setTimeout(() => { s.destroy(); reject(new Error('pipe connect timeout')); }, 1000);
                s.once('connect', () => { clearTimeout(timer); resolve(s); });
                s.once('error', e => { clearTimeout(timer); s.destroy(); reject(e); });
            });
            return new BrokerClient(socket, { protocol: WINDOWS_PROTOCOL, run_id, attempt_id, broker_pid: identity.pid, broker_creation_time: identity.created, nonce });
        }
        catch (e) {
            if (performance.now() >= deadline)
                throw new Error(`created-unacknowledged: broker pipe unavailable: ${(e as Error).message}`);
            await delay(50);
        }
    }
}
export interface CreatedTarget {
    pid: number;
    identity: WindowsIdentity;
}

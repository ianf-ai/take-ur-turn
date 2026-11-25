/** Diagnostic files only. Each append reopens the active path under the same
 * cross-process rotation lock. No inherited file descriptors or copytruncate. */
import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export interface LogFs {
  mkdir(dir: string): Promise<void>;
  size(file: string): Promise<number>;
  append(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
  modified(file: string): Promise<number>;
  lock(file: string, work: () => Promise<void>): Promise<void>;
}
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';
async function remove(file: string): Promise<void> { try { await unlink(file); } catch (e) { if (!missing(e)) throw e; } }
async function lock(file: string, work: () => Promise<void>): Promise<void> {
  const lockFile = `${file}.lock`;
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const deadline = Date.now() + 1000;
  for (;;) {
    let handle;
    try { handle = await open(lockFile, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Serialize dead-owner retirement. Unknown, initializing and reused PIDs
      // remain protected; they cause bounded degradation rather than theft.
      let previous: string | undefined;
      try {
        previous = await readFile(lockFile, 'utf8');
        const { pid } = JSON.parse(previous);
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
              const reclaim = await open(`${lockFile}.reclaim`, 'wx', 0o600);
              try { if (await readFile(lockFile, 'utf8') === previous) await remove(lockFile); }
              finally { await reclaim.close(); await remove(`${lockFile}.reclaim`); }
              continue;
            }
          }
        }
      } catch { /* concurrent creation/retirement, or unknown owner */ }
      if (Date.now() >= deadline) throw new Error(`log lock unavailable: ${lockFile}`);
      await delay(5);
      continue;
    }
    try {
      await handle.writeFile(owner);
      await work();
    } finally {
      await handle.close();
      await remove(lockFile);
    }
    return;
  }
}
export const logFs: LogFs = {
  mkdir: async dir => { await mkdir(dir, { recursive: true }); },
  size: async file => { try { return (await stat(file)).size; } catch (e) { if (missing(e)) return -1; throw e; } },
  modified: async file => { try { return (await stat(file)).mtimeMs; } catch (e) { if (missing(e)) return -1; throw e; } },
  append: async (file, text) => { await appendFile(file, text, 'utf8'); },
  rename, remove, lock,
};

/** Bound UTF-8 without splitting a code point. The marker includes original bytes. */
export function boundedLogLine(text: string, limit = LOG_MAX_BYTES): string {
  const length = Buffer.byteLength(text);
  if (length <= limit) return text;
  const marker = ` [truncated original_bytes=${length}]\n`;
  const bytes = Buffer.from(text.slice(0, limit));
  let end = limit - Buffer.byteLength(marker);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, Math.max(0, end)).toString('utf8') + marker;
}

// Canonical path queues coordinate independent sink instances in one process;
// disk locks coordinate processes. Entries retire when the last write drains.
const queues = new Map<string, Promise<void>>();
export interface ManagedLogOptions {
  generations?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  fs?: LogFs;
  diagnostic?: (line: string) => void;
}
export class ManagedLog {
  private disabled = false;
  private pending = Promise.resolve();
  private queuedBytes = 0;
  private queuedCount = 0;
  private lostBytes = 0;
  private degradation: string | undefined;
  private readonly fs: LogFs;
  private readonly maxBytes: number;
  constructor(readonly file: string, private readonly options: ManagedLogOptions = {}) {
    this.fs = options.fs ?? logFs;
    this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  }
  get health(): { file: string; disabled: boolean; lostBytes: number; diagnostic: string | undefined } {
    return { file: this.file, disabled: this.disabled, lostBytes: this.lostBytes, diagnostic: this.degradation };
  }
  private fail(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.degradation = boundedLogLine(`tut: log degraded file=${this.file}; persistence disabled until restart; subsequent diagnostics discarded; lost_bytes>=${this.lostBytes}: ${(error as Error).message}\n`, 4096);
    try { (this.options.diagnostic ?? (s => { process.stderr.write(s); }))(this.degradation); } catch { /* diagnostic only */ }
  }
  write(text: string): void {
    if (this.disabled) { this.lostBytes += Buffer.byteLength(text); return; }
    if (text.length === 0) return;
    const line = boundedLogLine(text, this.maxBytes);
    const bytes = Buffer.byteLength(line);
    // Bound the queue even when storage stalls. Do not build a promise chain
    // per discarded message or recurse into the failed destination.
    if (this.queuedCount >= 1024 || this.queuedBytes + bytes > 2 * this.maxBytes) { this.lostBytes += bytes; this.fail(new Error('log backlog budget exceeded')); return; }
    this.queuedBytes += bytes; this.queuedCount++;
    let key = path.resolve(this.file);
    try { key = path.join(realpathSync(path.dirname(key)), path.basename(key)); } catch { /* first mkdir */ }
    const prior = queues.get(key) ?? Promise.resolve();
    const next = prior.then(async () => {
      if (this.disabled) { this.lostBytes += bytes; return; }
      try {
        await this.fs.mkdir(path.dirname(this.file));
        if (this.disabled) { this.lostBytes += bytes; return; }
        await this.fs.lock(this.file, async () => {
          if (this.disabled) { this.lostBytes += bytes; return; }
          const generations = this.options.generations ?? 2;
          const now = (this.options.now ?? Date.now)();
          for (let i = 1; i <= generations; i++) {
            const old = `${this.file}.${i}`;
            if (await this.fs.size(old) > this.maxBytes) throw new Error('existing old segment exceeds budget; stop old writers and inspect legacy log');
            const modified = await this.fs.modified(old);
            if (modified >= 0 && now - modified >= (this.options.maxAgeMs ?? LOG_MAX_AGE_MS)) await this.fs.remove(old);
          }
          const size = await this.fs.size(this.file);
          // Existing unmanaged oversized data needs an owner-confirmed cleanup,
          // not an automatic truncation or an oversized rotated generation.
          if (size > this.maxBytes) throw new Error('existing segment exceeds budget; stop old writers and inspect legacy log');
          if (size > 0 && size + bytes > this.maxBytes) {
            await this.fs.remove(`${this.file}.${generations}`);
            for (let i = generations - 1; i >= 1; i--) {
              if (await this.fs.size(`${this.file}.${i}`) >= 0) await this.fs.rename(`${this.file}.${i}`, `${this.file}.${i + 1}`);
            }
            await this.fs.rename(this.file, `${this.file}.1`);
          }
          if (this.disabled) { this.lostBytes += bytes; return; }
          await this.fs.append(this.file, line);
        });
      } catch (e) { this.lostBytes += bytes; this.fail(e); }
    }).finally(() => {
      this.queuedBytes -= bytes; this.queuedCount--;
      if (queues.get(key) === next) queues.delete(key);
    });
    queues.set(key, next);
    this.pending = next;
  }
  async flush(): Promise<void> {
    if (this.disabled) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.fail(new Error('log I/O drain deadline exceeded')); resolve(); }, 1000);
      void this.pending.then(() => { clearTimeout(timer); resolve(); });
    });
  }
}

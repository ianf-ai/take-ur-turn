/** Output-only state. Never use this cache to gate reads, retries or actions. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { logFs } from './managed-log.js';
export const DIAGNOSTIC_INTERVAL_MS = 5 * 60_000;
interface Seen { reason: string; line: string; first: number; last: number; reported: number; count: number }
export class RepeatedDiagnostics {
  private readonly entries = new Map<string, Seen>();
  private readonly claims = new Map<string, RepeatedDiagnostics>();
  private pending: Promise<unknown> = Promise.resolve();
  private degraded = false;
  constructor(private readonly emit: (line: string) => void, private readonly now: () => number = Date.now,
    private readonly capacity = 1024, private readonly ttl = 30 * 60_000, private readonly file?: string) { }
  get size(): number { return this.entries.size; }
  private report(output: string[], scope: string, entry: Seen, event: string): void {
    output.push(`${entry.line} | diagnostic=${event} scope=${scope} first_seen=${entry.first} last_seen=${entry.last} count=${entry.count}`);
  }
  repeat(scope: string, reason: string, line: string): void | Promise<void> {
    return this.repeatMany([{ scope, reason, line }]);
  }
  /** A poll's decisions share one locked ledger read and atomic replacement. */
  repeatMany(entries: readonly { scope: string; reason: string; line: string }[]): void | Promise<void> {
    if (entries.length === 0) return;
    return this.update(output => {
      for (const { scope, reason, line } of entries) this.touch(scope, reason, line, output);
    });
  }
  /** Reserve one diagnostic report across observers and process restarts. */
  claim(scope: string, reason: string, line: string): boolean | Promise<boolean> {
    const key = createHash('sha256').update(scope).digest('hex');
    let ledger = this.claims.get(key);
    if (!ledger) {
      // Bound cached handles, never the durable once-only evidence. Each key
      // owns a small atomic ledger, so historical reports cannot evict it.
      if (this.file && this.claims.size >= this.capacity) this.claims.delete(this.claims.keys().next().value!);
      ledger = new RepeatedDiagnostics(this.emit, this.now, 1, this.ttl,
        this.file ? path.join(`${this.file}.once`, `${key}.json`) : undefined);
    }
    this.claims.delete(key); this.claims.set(key, ledger);
    return ledger.update(output => ledger.touch(scope, reason, line, output, true));
  }
  private touch(scope: string, reason: string, line: string, output: string[], once = false): boolean {
    const now = this.now();
    // Periodic diagnostics use idle expiry and LRU retirement. Once-only
    // evidence stays intact in its independent ledger.
    for (const [key, value] of this.entries) {
      if (!once && !this.file && (now - value.last >= this.ttl || now < value.last)) {
        this.report(output, key, value, 'expired'); this.entries.delete(key);
      }
    }
    const key = createHash('sha256').update(scope).digest('hex');
    const fingerprint = createHash('sha256').update(reason).digest('hex');
    let seen = this.entries.get(key);
    if (seen && seen.reason !== fingerprint) {
      this.entries.delete(key); seen = undefined;
    }
    if (!seen) {
      if (!once && this.entries.size >= this.capacity) {
        const oldest = this.entries.entries().next().value;
        if (oldest) { this.report(output, oldest[0], oldest[1], 'evicted'); this.entries.delete(oldest[0]); }
      }
      seen = { reason: fingerprint, line: line.slice(0, 4096), first: now, last: now, reported: now, count: 1 };
      this.entries.set(key, seen);
      if (!once) output.push(line);
      return true;
    } else {
      seen.last = now; seen.count++; seen.line = line.slice(0, 4096);
      // Refresh LRU order without allocating a second entry.
      this.entries.delete(key); this.entries.set(key, seen);
      if (now < seen.reported) seen.reported = now;
      if (!once && now - seen.reported >= DIAGNOSTIC_INTERVAL_MS) { this.report(output, scope, seen, 'summary'); seen.reported = now; }
    }
    return false;
  }
  recover(scope: string): void | Promise<void> {
    return this.update(output => {
      const key = createHash('sha256').update(scope).digest('hex');
      const seen = this.entries.get(key);
      if (seen) { this.report(output, scope, seen, 'recovered'); this.entries.delete(key); }
    });
  }
  /** Shutdown releases memory; unresolved diagnostics remain in the ledger. */
  clear(): void { this.entries.clear(); this.claims.clear(); }
  private update<T>(change: (output: string[]) => T): T | Promise<T> {
    const apply = () => { const output: string[] = []; return { value: change(output), output }; };
    if (!this.file || this.degraded) {
      const result = apply(); for (const line of result.output) this.emit(line); return result.value;
    }
    const file = this.file;
    const work = this.pending.then(async () => {
      if (this.degraded) {
        const result = apply();
        for (const line of result.output) this.emit(line);
        return result.value;
      }
      let result: ReturnType<typeof apply> | undefined;
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await logFs.lock(file, async () => {
          let data: string | undefined;
          try {
            const info = await lstat(file);
            if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('invalid diagnostic ledger file');
            data = await readFile(file, 'utf8');
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          const entries = data === undefined ? [] : parseLedger(data, this.capacity);
          this.entries.clear(); for (const [key, seen] of entries) this.entries.set(key, seen);
          result = apply();
          const next = JSON.stringify({ schema: 1, entries: [...this.entries] });
          if (next === data || (data === undefined && this.entries.size === 0)) return;
          const temp = `${file}.${randomUUID()}.tmp`;
          try {
            const handle = await open(temp, 'wx', 0o600);
            try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
            await rename(temp, file);
          } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        });
      } catch (e) {
        if (!this.degraded) {
          this.degraded = true;
          this.emit(`diagnostic ledger unavailable file=${file}: ${(e as Error).message}; using process-local deduplication`);
        }
      }
      result ??= apply();
      for (const line of result.output) this.emit(line);
      return result.value;
    });
    this.pending = work.catch(() => {});
    return work;
  }
}

/** All consumers use the existing diagnostics destination; no configuration knob. */
export function diagnosticLedger(root: string, owner: 'notifier' | 'detached-runtime' | 'detached-lane'): string {
  return path.join(root, '.context-hub', 'logs', 'diagnostics', `repeated-${owner}.json`);
}
function parseLedger(data: string, capacity: number): [string, Seen][] {
  const value = JSON.parse(data);
  if (value?.schema !== 1 || !Array.isArray(value.entries) || value.entries.length > capacity) throw new Error('invalid diagnostic ledger');
  const keys = new Set<string>();
  for (const pair of value.entries) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('invalid diagnostic ledger entry');
    const [key, seen] = pair;
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || keys.has(key) ||
        typeof seen?.reason !== 'string' || !/^[a-f0-9]{64}$/.test(seen.reason) ||
        typeof seen.line !== 'string' || seen.line.length > 4096 ||
        ![seen.first, seen.last, seen.reported].every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) ||
        !Number.isSafeInteger(seen.count) || seen.count < 1) throw new Error('invalid diagnostic ledger entry');
    keys.add(key);
  }
  return value.entries;
}

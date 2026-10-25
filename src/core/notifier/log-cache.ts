import { HubSession, hubReadVia } from '../hub/hub-client.js';
import { readLaunchLog } from '../launcher/launch.js';
import type { ContextRecord } from '../common/types.js';
import type { NotifierDeps, StateTask, StateResponse } from './contracts.js';

/** One entry of the per-task log cache (see NotifierLogCache for the protocol). */
interface LogCacheEntry {
  /** Highest synced record version (0 = synced an empty log). */
  version: number;
  /** Merged records in audit order (ascending version; equal versions keep arrival order). */
  records: ContextRecord[];
  /** /state entry signature at the last successful sync; null when that pull ran without a /state entry. */
  sig: string | null;
}

/**
 * Fold-visible /state signature of a task entry: the
 * fields /state re-derives from the record set every poll — status,
 * waiting_for, needs_attention — plus updated_at (bumped by every
 * store-mediated write). External damage that changes what the fold would
 * produce (a same-version duplicate, a repair) changes this signature
 * WITHOUT advancing /state's version field, which is exactly the signal the
 * cache uses to order a full re-sync; a legit append changes it too, but
 * appends advance the version, and the cache only falls back on a signature
 * change at an UNCHANGED version. Tasks whose /state entry carries no
 * version (older hubs / fixtures) never take the signature path.
 */
function stateTaskSig(task: StateTask): string {
  return JSON.stringify([task.status, task.waiting_for, task.needs_attention, task.updated_at]);
}

/** Structural deep-equality of two records: identity for the
 * merge — a record is "the same one" only when every field and the whole
 * payload match. The wire carries no file names, so full-record equivalence
 * is the strongest identity available; two DIFFERENT records sharing a
 * version (VERSION_DUPLICATE shape) compare unequal and both stay. */
function recordsEqual(a: ContextRecord, b: ContextRecord): boolean {
  const av = a as unknown as Record<string, unknown>;
  const bv = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  for (const key of keys) {
    if (!jsonEquivalent(av[key], bv[key])) return false;
  }
  return true;
}

function jsonEquivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEquivalent(item, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!jsonEquivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

export class NotifierLogCache {
  /**
   * Resident Hub MCP session: connected lazily on the first
   * incremental readLog and reused for every later one — one TCP connection
   * and one MCP handshake for the notifier's lifetime instead of a fresh
   * session per candidate per poll. Dropped (and reconnected on the next
   * call) on any transport-level failure; closed in close().
   */
  private hubSession: HubSession | null = null;

  /**
   * Per-task merged task log: records ≤ version came from earlier
   * pulls, records above arrive via readLogSince. Serves launchBlocked /
   * latestRecordVersion / generation scans without re-pulling history.
   * Entries are dropped when a task leaves tasks∪degraded (vanished/deleted),
   * when /state reports a version BELOW the cached one (history rewound
   * externally — the merge would otherwise keep phantom records forever), or
   * when the task's /state-visible shape changed WITHOUT
   * a version advance (same-version duplicate landed externally, a repair
   * rewrote the fold): such records are unreachable through an incremental
   * pull (their version is ≤ the cached max), so the entry is dropped and the
   * next pull is a FULL re-sync — and, additionally, when a previously
   * needs_attention task's attention CLEARED between polls: records that
   * landed invisibly while the anomaly was set (no /state field changed) are
   * recovered by that full re-sync exactly when the launch gate starts
   * consulting the cache again. `sig` is the /state entry signature the last
   * successful sync ran under (null when that pull had no /state entry at
   * hand — e.g. the marker-race re-read); a null/stale sig never lets a
   * quiet-round skip through, so the worst case is one extra full pull.
   */
  private logCache = new Map<string, LogCacheEntry>();
  private closed = false;
  private readonly stateUrl: string;
  private readonly deps: Pick<NotifierDeps, 'readLog' | 'readLogSince'>;

  constructor(url: string, deps: Partial<NotifierDeps>) {
    this.stateUrl = url.replace(/\/+$/, '') + '/state';
    const readLogSince = deps.readLogSince ?? (deps.readLog === undefined
      ? (taskId: string, sinceVersion: number) => hubReadVia(this.ensureHubSession(), taskId, sinceVersion > 0 ? sinceVersion : undefined).then(res => ({ versions: res.versions }))
      : undefined);
    this.deps = { readLog: deps.readLog ?? (taskId => readLaunchLog(url, taskId)), ...(readLogSince === undefined ? {} : { readLogSince }) };
  }
  /** The uncached read is retained for runtime evidence/optimistic conflict checks. */
  readLog(taskId: string): Promise<ContextRecord[]> { return this.deps.readLog(taskId); }
  async close(): Promise<void> {
    this.closed = true;
    this.logCache.clear();
    const session = this.hubSession;
    this.hubSession = null;
    if (session !== null) await session.close().catch(() => undefined);
  }

  /** The resident Hub session, connected on first use. */
  private ensureHubSession(): HubSession {
    if (this.closed) throw new Error("notifier log cache is closed");
    this.hubSession ??= new HubSession(this.stateUrl.replace(/\/state$/u, ""), { clientName: "tut-notifier" });
    return this.hubSession;
  }

  /**
   * Full task log for dedup / base-version / generation scans, incremental
   * when readLogSince is wired.
   * Governed protocol, driven by the task's /state entry when the caller has
   * one (the poll's candidate/generation scans always do):
   *
   *   - quiet round (cache covers entry.version AND the entry's fold-visible
   *     signature matches the one the cache last synced under): the merged
   *     records are served from memory — ZERO Hub log requests/responses, the
   *     §4 "≤ bytes added since the previous round" gate reads 0 on a silent
   *     poll. An entry without a version (older hub) can never
   *     be proven covered, so it always pulls.
   *   - otherwise: one context.read at since_version = cached.version + 1 —
   *     the INCLUSIVE wire contract therefore fetches strictly-new versions
   *     and never re-reads the cached tail. No cache yet → 0 =
   *     full pull. The reply merges by record identity (deep equality), so
   *     same-version DIFFERENT records all survive and fold in audit order;
   *     a rewind or signature change has already dropped the
   *     entry in reconcileLogCache, making the next pull a full re-sync.
   *
   * A failed pull throws with the cache untouched — callers already treat a
   * read failure as "unreadable" and retry next poll.
   */
  async fullLog(taskId: string, entry?: StateTask): Promise<ContextRecord[]> {
    const incremental = this.deps.readLogSince;
    if (incremental === undefined) return await this.deps.readLog(taskId);
    const cached = this.logCache.get(taskId);
    if (
      cached !== undefined &&
      entry !== undefined &&
      entry.version !== undefined &&
      cached.version >= entry.version &&
      cached.sig !== null &&
      cached.sig === stateTaskSig(entry)
    ) {
      return cached.records; // quiet round — /state already covers the cached history
    }
    // Exclusive lower bound → inclusive wire parameter: cached.version + 1.
    // A dropped/stale cache (no entry, signature mismatch, rewind) starts at 0.
    const lowerBound = cached?.version ?? 0;
    const since = lowerBound > 0 ? lowerBound + 1 : 0;
    const res = await incremental(taskId, since);
    let merged: ContextRecord[];
    let maxVersion = lowerBound;
    if (cached === undefined) {
      merged = [...res.versions];
    } else {
      merged = [...cached.records];
      for (const record of res.versions) {
        // Identity dedup only: a record already present verbatim
        // is skipped; a DIFFERENT record at an already-cached version survives
        // — the wire's same-version duplicates are distinct audit records and
        // must all reach launchBlocked / the generation scans.
        if (!merged.some((m) => recordsEqual(m, record))) merged.push(record);
      }
      merged.sort((a, b) => a.version - b.version); // stable: equal versions keep arrival order
    }
    for (const record of res.versions) maxVersion = Math.max(maxVersion, record.version);
    if (!this.closed) this.logCache.set(taskId, { version: maxVersion, records: merged, sig: entry !== undefined ? stateTaskSig(entry) : cached?.sig ?? null });
    return merged;
  }

  /**
   * Log-cache housekeeping: entries for ids no longer known to
   * /state are dropped (vanished/deleted — a later reappearance must not
   * serve phantom history), a task whose /state version fell BELOW the
   * cached version had its history rewound externally — drop it so the next
   * pull starts from zero — and a task whose fold-visible
   * /state signature changed at an UNCHANGED version had records land that
   * an incremental pull can never reach (same-version duplicates, repairs):
   * drop it too, forcing a full re-sync on the next pull. Version advances
   * keep the entry (the delta is exactly what since_version fetches); entries
   * without a /state version (older hubs) only take the vanished path.
   *
   * Attention-clearing edge: `prev` is the previous
   * poll's snapshot. A task observed needs_attention=true last poll and false
   * now had its anomaly resolved — and while attention was set, same-version
   * records could land with NO /state-visible change at all (status,
   * waiting_for, needs_attention already true, updated_at untouched by
   * external writes): the signature rule cannot see them, and the resolving
   * record (an ack) ADVANCES the version, so the incremental pull at
   * cached.version + 1 fetches only the ack — the invisible records stay
   * unreachable forever. Evicting on the clearing edge makes the next pull a
   * FULL re-sync: whatever landed during the anomalous stay is recovered
   * exactly when the launch gate starts consulting the cache again (a
   * needs_attention task is gate-withheld, so the stale window is never
   * acted on). The edge is rare (once per anomaly lifetime) and never fires
   * for clean tasks — the quiet-round zero-request gate is untouched.
   */
  reconcileLogCache(state: StateResponse, prev: ReadonlyMap<string, StateTask> | null): void {
    if (this.logCache.size === 0) return;
    const known = new Set<string>([...state.tasks.map((t) => t.task_id), ...(state.degraded ?? [])]);
    for (const [taskId, entry] of this.logCache) {
      if (!known.has(taskId)) {
        this.logCache.delete(taskId);
        continue;
      }
      const task = state.tasks.find((t) => t.task_id === taskId);
      if (task?.version === undefined) continue;
      if (entry.version > task.version) {
        this.logCache.delete(taskId); // rewind
        continue;
      }
      if (prev?.get(taskId)?.needs_attention === true && task.needs_attention === false) {
        this.logCache.delete(taskId); // attention cleared — recover anything that landed invisibly while set
        continue;
      }
      if (task.version === entry.version && entry.sig !== null && entry.sig !== stateTaskSig(task)) {
        this.logCache.delete(taskId); // shape changed under the same version — full re-sync next pull
      }
    }
  }
}

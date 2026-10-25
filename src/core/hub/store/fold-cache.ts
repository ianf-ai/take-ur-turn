/** Internal cursor owner; metadata never substitutes for replayed records. */

import { PROJECT_TASK_ID, type ContextRecord, type Flow } from "../../common/types.js";
import { foldWithLint, type LintCursor } from "../record-lint.js";
import { WAITING_FOR_BASE, derive, initialCursor } from "../state-machine.js";
import { type TaskMeta, recordFileVersion, maxRecordVersionOf } from "./artifacts.js";
import type { RecordIO } from "./record-io.js";

/**
 * Per-task in-process read cache: the
 * fold cursor after the record set named by `token`. The TOKEN is the
 * sorted list of fold-relevant file names from the task directory's readdir
 * — record files (`v<n>.<type>.json`), `recovery.jsonl`, and `*.recovered`
 * copies. Anything that changes what the fold would consume — an appended
 * record, an external git pull adding files, a recovery registration, a
 * deletion — changes the token and invalidates the entry; a HEALTHY cache
 * hit folds zero record files. meta.json and `*.tmp` siblings are
 * deliberately NOT token inputs: meta.json is rewritten by every append
 * (its name never changes) and tmp files are transient in-flight writes.
 *
 * Trusted boundaries (task description: "不得信任 meta.json 作为读缓存"):
 * the cache trusts ONLY this process's own folds plus the directory name
 * list — never meta.json's derived fields. Known token: unchanged directory
 * → cursor reused. Extension (every cached name still present, additions
 * are record files with version > cursor.prevVersion): only the added files
 * are read and folded onto the cursor. Anything else — deletions, manifest
 * or recovered-copy additions, a gap in the added versions — falls back to a
 * full cold read. A fold failure never caches, so a corrupt new record
 * degrades on every poll until repaired, exactly like a cold store.
 *
 * In-place CONTENT edits that keep every file name (an external process
 * rewriting record bytes) are outside the token's resolution by design —
 * the name list is the specified invalidation medium; damage detection for
 * content mutations keeps its cold-path semantics (fresh processes, direct
 * readTask after cache misses, the digest chain at recovery time).
 */
interface TaskFoldCache {
  /** Sorted fold-relevant file names joined with "\n"; "" = empty task dir. */
  token: string;
  /** Fold cursor after that name set; null = project scope (probe only). */
  cursor: LintCursor | null;
  /** Projection inputs beyond the record-name token; absent for project scope. */
  specKey?: string;
  /** Project scope only: max record version the probe validated (extension floor). */
  probeMaxVersion: number;
}

/** Names that participate in folding (token inputs + read candidates). */
function isFoldRelevantName(name: string): boolean {
  return recordFileVersion(name) !== null || name === "recovery.jsonl" || name.endsWith(".recovered");
}

/** Invalidation token for a task directory's name list. */
export function foldTokenOf(names: readonly string[]): string {
  return names.filter(isFoldRelevantName).sort().join("\n");
}

/** @internal One cache per Store, shared by reads, appends and recovery. */
export class FoldCache {
  private foldCache = new Map<string, TaskFoldCache>();

  constructor(private readonly io: RecordIO) {}

  set(taskId: string, entry: TaskFoldCache): void {
    this.foldCache.set(taskId, entry);
  }

  delete(taskId: string): void {
    this.foldCache.delete(taskId);
  }

  /**
   * Cache-aware fold of a task-scope record set. Returns the
   * fold cursor after every fold-relevant file named in `names`.
   * `alreadyRead` — record contents keyed by the REAL file name they were
   * read from — are reused instead of re-read when they cover the needed
   * names. Keying by the real name, never by a name
   * synthesized back out of the record's content: `recordFileVersion`
   * accepts ANY `v<digits>.<type>.json` shape (v1.foreign.json is a legal
   * alias of v001.foreign.json), and a content-synthesized map would
   * mis-attribute an alias file's record to a canonical name — double-
   * folding one and skipping the other.
   *
   * Protocol (see TaskFoldCache): token hit → cursor reused, zero record
   * reads; pure record-file extension with versions beyond the cached fold
   * (cursor.prevVersion) → only the additions are read (deduplicated against
   * alreadyRead) and folded on; anything else → cold full read. Errors
   * propagate and never cache.
   */
  async foldCursorFor(
    taskId: string,
    flow: Flow,
    description: string | undefined,
    names: readonly string[],
    alreadyRead: ReadonlyMap<string, ContextRecord> = new Map(),
  ): Promise<LintCursor> {
    const token = foldTokenOf(names);
    const specKey = JSON.stringify([flow, description ?? ""]);
    const entry = this.foldCache.get(taskId);
    const cached = entry?.specKey === specKey ? entry : undefined;
    if (cached !== undefined && cached.token === token && cached.cursor !== null) {
      return cached.cursor; // hit — the directory's fold-relevant names are unchanged
    }

    const readByName = alreadyRead; // keyed by real file name (see doc above)

    if (cached !== undefined && cached.cursor !== null) {
      const foldedThrough = cached.cursor.prevVersion;
      // Extension check: nothing removed, and every addition is a record
      // file with a version beyond the cached fold. Non-record additions
      // (recovery.jsonl / *.recovered landing) force the cold path on
      // purpose — they change how corrupt originals fold.
      const cachedNames = cached.token.length === 0 ? [] : cached.token.split("\n");
      const currentSet = new Set(names.filter(isFoldRelevantName));
      const removed = cachedNames.some((name) => !currentSet.has(name));
      const additions = [...currentSet].filter((name) => !cachedNames.includes(name));
      const extensible =
        !removed &&
        additions.every((name) => {
          const version = recordFileVersion(name);
          return version !== null && version > foldedThrough;
        });
      if (extensible) {
        const unread = additions.filter((name) => !readByName.has(name));
        const loaded = new Map(
          unread.length === 0
            ? []
            : (await this.io.readNamedRecordsPaired(taskId, unread)).map(({ name, record }) => [name, record]),
        );
        const fresh = additions.map((name) => readByName.get(name) ?? loaded.get(name)!);
        const folded = foldWithLint(cached.cursor, fresh, flow, description);
        const next: LintCursor = folded;
        this.foldCache.set(taskId, { token, specKey, cursor: next, probeMaxVersion: next.prevVersion });
        return next;
      }
    }

    // Cold path: read every fold-relevant record name and fold.
    const recordNames = names.filter((name) => recordFileVersion(name) !== null);
    const unread = recordNames.filter((name) => !readByName.has(name));
    const loaded = new Map(
      unread.length === 0
        ? []
        : (await this.io.readNamedRecordsPaired(taskId, unread)).map(({ name, record }) => [name, record]),
    );
    const records = recordNames.map((name) => readByName.get(name) ?? loaded.get(name)!);
    const folded = foldWithLint(initialCursor(flow), records, flow, description);
    const cursor: LintCursor = folded;
    this.foldCache.set(taskId, { token, specKey, cursor, probeMaxVersion: cursor.prevVersion });
    return cursor;
  }

  /**
   * Project-scope health probe (no derivation), cache-aware exactly like
   * foldCursorFor: token hit → nothing read; record-file extension beyond
   * probeMaxVersion → only the additions validated; else cold validation of
   * every record name. Throws VALIDATION_ERROR on unrecovered corruption.
   */
  async probeRecords(taskId: string, names: readonly string[]): Promise<void> {
    const token = foldTokenOf(names);
    const cached = this.foldCache.get(taskId);
    if (cached !== undefined && cached.token === token && cached.cursor === null) {
      return; // hit — the directory's fold-relevant names are unchanged
    }

    const recordNames = () => names.filter((name) => recordFileVersion(name) !== null);

    if (cached !== undefined && cached.cursor === null) {
      const cachedNames = cached.token.length === 0 ? [] : cached.token.split("\n");
      const currentSet = new Set(names.filter(isFoldRelevantName));
      const removed = cachedNames.some((name) => !currentSet.has(name));
      const additions = [...currentSet].filter((name) => !cachedNames.includes(name));
      const extensible =
        !removed &&
        additions.every((name) => {
          const version = recordFileVersion(name);
          return version !== null && version > cached.probeMaxVersion;
        });
      if (extensible) {
        if (additions.length > 0) await this.io.readNamedRecords(taskId, additions); // validation only
        this.foldCache.set(taskId, {
          token,
          cursor: null,
          probeMaxVersion: Math.max(cached.probeMaxVersion, maxRecordVersionOf(additions)),
        });
        return;
      }
    }

    const namesToRead = recordNames();
    if (namesToRead.length > 0) await this.io.readNamedRecords(taskId, namesToRead); // validation only
    this.foldCache.set(taskId, { token, cursor: null, probeMaxVersion: maxRecordVersionOf(namesToRead) });
  }

  /** Derived state for a task from the cache-aware fold (null for project scope). */
  async derivedFor(
    taskId: string,
    flow: Flow | undefined,
    description: string | undefined,
    names: readonly string[],
    alreadyRead: ReadonlyMap<string, ContextRecord> = new Map(),
  ): Promise<(NonNullable<ReturnType<typeof derive>> & Pick<LintCursor, "pending_since" | "round_count">) | null> {
    if (taskId === PROJECT_TASK_ID) return null;
    const cursor = await this.foldCursorFor(taskId, flow ?? "full", description, names, alreadyRead);
    const needsAttention = cursor.warnings.length > 0;
    return {
      status: cursor.status,
      waiting_for: needsAttention ? "human" : WAITING_FOR_BASE[cursor.status],
      needs_attention: needsAttention,
      warnings: cursor.warnings,
      pending_since: cursor.pending_since ?? null,
      round_count: cursor.round_count ?? 0,
    };
  }

  /** Extend a project-scope probe cache entry by one just-landed file name. */
  rememberFoldToken(taskId: string, names: readonly string[], fileName: string): void {
    const cached = this.foldCache.get(taskId);
    if (cached === undefined || cached.cursor !== null) return; // only project probe entries update this way
    if (cached.token !== foldTokenOf(names)) return; // stale entry — let the next read rebuild
    this.foldCache.set(taskId, {
      token: foldTokenOf([...names, fileName]),
      cursor: null,
      probeMaxVersion: Math.max(cached.probeMaxVersion, recordFileVersion(fileName) ?? 0),
    });
  }
}

export function cacheDerived(meta: TaskMeta, derived: ReturnType<typeof derive> | null): void {
  if (!derived) return;
  meta.status = derived.status;
  meta.waiting_for = derived.waiting_for;
  meta.needs_attention = derived.needs_attention;
  meta.warnings = derived.warnings;
}

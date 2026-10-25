import { type Dirent, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode, PROJECT_TASK_ID, type ContextRecord, type Status } from "../common/types.js";
import { taskSpecWarning } from "../common/task-spec.js";
import { foldWithLint } from "./record-lint.js";
import { initialCursor } from "./state-machine.js";
import {
  StoreError,
  type TaskMeta,
  type CreateTaskInput,
  type CreateTaskResult,
  type AppendInput,
  type AppendResult,
  type ReadTaskResult,
  type TaskListEntry,
  type TaskSnapshot,
  type RepairMetaInput,
  type RepairMetaResult,
  type RecoverRecordInput,
  type RecoverRecordResult,
  TASK_ID_PATTERN,
  LEGACY_TASK_ID_PATTERN,
  requireNonEmptyString,
  requireValidFlow,
  requireValidCast,
  requireValidCheckout,
  requireValidTaskId,
  slugify,
  shortSuffix,
  recordFileName,
  recordFileVersion,
  maxRecordVersionOf,
  isErrnoException,
} from "./store/artifacts.js";
import { RecordIO, sweepTempFiles } from "./store/record-io.js";
import { FoldCache, cacheDerived, foldTokenOf } from "./store/fold-cache.js";
import { repairMeta, recoverRecord } from "./store/recovery.js";

export {
  StoreError,
  LEGACY_TASK_ID_PATTERN,
  recordFileVersion,
  validateRecordArtifact,
  validateMetaArtifact,
} from "./store/artifacts.js";
export type {
  CreateTaskInput,
  CreateTaskResult,
  AppendInput,
  AppendResult,
  ReadTaskResult,
  TaskListEntry,
  TaskSnapshot,
  RecoveryEntry,
  RepairMetaInput,
  RepairMetaResult,
  RecoverRecordInput,
  RecoverRecordResult,
} from "./store/artifacts.js";

/**
 * package.json version of the running build, stamped as `tut_version` onto
 * every record this store appends (system-design 4.2 — one write door, both
 * serve and CLI land here). Resolved lazily, once per process, relative to
 * the compiled module (dist/core/hub/../../../package.json; repo root under vitest).
 * Undefined (field omitted) when the manifest is missing or unreadable —
 * an honest gap, never a fabricated value. Dev-branch caveat: one manifest
 * version covers uncommitted changes, so it approximates the build identity.
 */
let buildTutVersion: string | undefined;

let buildTutVersionResolved = false;

function tutVersionOfBuild(): string | undefined {
  if (!buildTutVersionResolved) {
    buildTutVersionResolved = true;
    try {
      const manifestPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
      if (typeof manifest.version === "string" && manifest.version.length > 0) {
        buildTutVersion = manifest.version;
      }
    } catch {
      // manifest not found / unreadable → omit the field, never block the append
    }
  }
  return buildTutVersion;
}

/**
 * Sole public storage API and mutation queue owner. Internal modules perform
 * artifact validation, file operations, cached folds and queued recovery work.
 */
export class Store {
  readonly root: string;

  /** Construction-time best-effort temp sweep (disabled for read-only stores). */
  readonly whenSwept: Promise<void>;

  /** Global tail for slug-reserving mutations (createTask) — cross-task. */
  private globalTail: Promise<void> = Promise.resolve();
  /** Per-task mutation tails shared by append, repairMeta and recoverRecord. */
  private taskTails = new Map<string, Promise<void>>();
  private readonly io: RecordIO;
  private readonly foldCache: FoldCache;
  private readonly readOnly: boolean;

  constructor(root: string = ".context-hub", options: { readOnly?: boolean } = {}) {
    this.root = root;
    this.readOnly = options.readOnly === true;
    this.io = new RecordIO(root);
    this.foldCache = new FoldCache(this.io);
    this.whenSwept = options.readOnly ? Promise.resolve() : sweepTempFiles(this.io.tasksDir());
  }

  /** Usage audit sidecar, through the Store boundary; never repairs or writes. */
  async readUsage(taskId: string): Promise<unknown | null> {
    return this.io.readUsage(taskId);
  }

  /** Raw usage sidecar for HTTP readers; preserve every byte, without aggregation. */
  async readUsageRaw(taskId: string): Promise<Buffer> {
    return this.io.readUsageRaw(taskId);
  }

  /** Validate recovery inputs, then rebuild within the same queue as append. */
  async repairMeta(taskId: string, input: RepairMetaInput): Promise<RepairMetaResult> {
    return repairMeta(this.io, this.foldCache, taskId, input, (operation) => this.enqueue(taskId, operation));
  }

  /** Register recovery within the same queue as append and metadata repair. */
  async recoverRecord(taskId: string, input: RecoverRecordInput): Promise<RecoverRecordResult> {
    return recoverRecord(this.io, taskId, input, (operation) => this.enqueue(taskId, operation));
  }

  /** Create a task: writes meta.json only — no record, version 0. */
  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const title = requireNonEmptyString(input?.title, "title");
    const description = requireNonEmptyString(input?.description, "description");
    const creator = requireNonEmptyString(input?.creator, "creator");
    const role = requireNonEmptyString(input?.role, "role");
    const flow = requireValidFlow(input?.flow);
    const cast = requireValidCast(input?.cast);
    const checkout = requireValidCheckout(input?.checkout);

    return this.enqueue(null, async () => {
      const taskId = await this.uniqueSlug(slugify(title));
      requireValidTaskId(taskId, TASK_ID_PATTERN);
      await this.io.ensureTaskDir(taskId);
      const now = new Date().toISOString();
      const meta: TaskMeta = {
        task_id: taskId,
        title,
        description,
        creator,
        role,
        ...(flow !== undefined ? { flow } : {}), // absent = full; key stays out for default creates
        ...(cast !== undefined ? { cast } : {}), // absent = default lineup; key stays out for default creates
        ...(checkout !== undefined ? { checkout } : {}), // absent = current; key stays out for old creates
        created_at: now,
        updated_at: now,
        version: 0,
      };
      const seeded = foldWithLint(initialCursor(flow ?? "full"), [], flow ?? "full", description);
      cacheDerived(meta, seeded);
      // Seed the fold cache: a fresh task's directory holds no
      // fold-relevant names, so the empty token matches the first reader.
      this.foldCache.set(taskId, {
        token: "",
        specKey: JSON.stringify([flow ?? "full", description]),
        cursor: seeded,
        probeMaxVersion: 0,
      });
      await this.io.writeMeta(taskId, meta);
      const warning = [taskSpecWarning(description), ...seeded.warnings.map(w => w.message)].filter(Boolean).join("\n") || undefined;
      return { task_id: taskId, status: meta.status ?? "designing", version: 0 as const, ...(warning ? { warning } : {}),
        ...(seeded.warnings.length ? { needs_attention: true, warnings: structuredClone(seeded.warnings) } : {}) };
    });
  }

  /**
   * Append a record. Validates task existence and summary/body only — verdict and
   * everything else is never a rejection reason (write-free principle). Project scope
   * ("project") is created on first append and carries no status semantics.
   */
  async append(taskId: string, input: AppendInput): Promise<AppendResult> {
    requireNonEmptyString(taskId, "task_id");
    requireValidTaskId(taskId);
    requireNonEmptyString(input?.role, "role");
    requireNonEmptyString(input?.content_type, "content_type");
    if (input?.payload === null || typeof input?.payload !== "object") {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, "payload must be an object");
    }
    requireNonEmptyString(input.payload.summary, "payload.summary");
    requireNonEmptyString(input.payload.body, "payload.body");
    if (
      input?.expected_version !== undefined &&
      (typeof input.expected_version !== "number" || !Number.isInteger(input.expected_version) || input.expected_version < 0)
    ) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, "expected_version must be a non-negative integer");
    }

    return this.enqueue(taskId, async () => {
      const isProject = taskId === PROJECT_TASK_ID;
      let meta = await this.io.readMeta(taskId);
      if (!meta) {
        if (!isProject) {
          throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);
        }
        // Project scope lifecycle: no create, auto-create dir+meta on first append.
        await this.io.ensureTaskDir(taskId);
        const now = new Date().toISOString();
        meta = {
          task_id: taskId,
          title: PROJECT_TASK_ID,
          created_at: now,
          updated_at: now,
          version: 0,
        };
        await this.io.writeMeta(taskId, meta);
      }

      if (input.expected_version !== undefined && input.expected_version !== meta.version) {
        throw new StoreError(
          ErrorCode.VERSION_CONFLICT,
          `expected_version ${input.expected_version} does not match current version ${meta.version}`,
        );
      }
      // Crash-window reconciliation: a crash between writing the record
      // file and updating meta leaves meta.version stale; deriving the next
      // version from max(meta.version, max on-disk record version) heals the
      // staleness so the orphan record is never overwritten (append-only).
      const names = await this.io.taskDirNames(taskId);
      const newVersion = Math.max(meta.version, maxRecordVersionOf(names)) + 1;
      const timestamp = new Date().toISOString();

      const record: ContextRecord = {
        version: newVersion,
        task_id: taskId,
        role: input.role,
        content_type: input.content_type,
        timestamp,
        payload: input.payload,
      };
      if (input.agent !== undefined) record.agent = input.agent;
      if (input.model !== undefined) record.model = input.model;
      const tutVersion = tutVersionOfBuild();
      if (tutVersion !== undefined) record.tut_version = tutVersion;

      // PRE-WRITE fold: fold the on-disk sequence and derive the
      // post-append state BEFORE any byte lands. A corrupt existing record
      // (or anything else the fold needs) fails HERE — nothing is written, the
      // caller gets an honest error, and a retry cannot leak orphan record
      // files. Previously derive ran AFTER the record landed, so a corrupt
      // sibling record made every publish error while still appending a new
      // file per attempt: a permanently bricked task that leaked orphans.
      // The fold of the existing sequence is cache-aware — on a
      // warm cache this costs zero record-file reads regardless of sequence
      // length (the readdir above already produced the invalidation token);
      // a cold cache reads the sequence once and seeds the cursor.
      let derived: ReturnType<typeof foldWithLint> | null = null;
      if (!isProject) {
        // Hand-corrupted meta (non-string description) must not turn every
        // later publish into a pre-write TypeError: no string, no baseline.
        const description = typeof meta.description === "string" ? meta.description : undefined;
        const cursor = await this.foldCache.foldCursorFor(taskId, meta.flow ?? "full", description, names); // VALIDATION_ERROR on unrecovered corruption → nothing lands
        derived = foldWithLint(cursor, [record], meta.flow ?? "full", description);
      }

      const fileName = recordFileName(newVersion, input.content_type);
      await this.io.writeRecordExclusive(taskId, fileName, JSON.stringify(record, null, 2) + "\n");

      // The record has LANDED (link succeeded) — from here on this append can
      // never reject the write it already persisted (an error after
      // a landed write is the brick shape). Post-write bookkeeping failures
      // degrade honestly: return the landed version with needs_attention + a
      // stderr warning. The crash-window reconciliation above already heals a
      // stale meta on the next append, so meta staleness is not lost data.
      meta.version = newVersion;
      meta.updated_at = timestamp;
      try {
        if (isProject) {
          // No status semantics for project scope — strip any stale derived cache fields.
          delete meta.status;
          delete meta.waiting_for;
          delete meta.needs_attention;
          delete meta.warnings;
          // Project fold cache: probe-only (cursor null), token extended by
          // the name this append just landed (the record is by construction
          // well-formed — it passed the append door's own validation).
          this.foldCache.rememberFoldToken(taskId, names, fileName);
        } else {
          cacheDerived(meta, derived);
          if (derived !== null) {
            // Advance the fold cache across this landed record: same names
            // plus the new file, cursor = the fold this append already
            // computed. A post-bookkeeping failure path below skips this —
            // the cache then simply re-derives from the token on next read.
            this.foldCache.set(taskId, {
              token: foldTokenOf([...names, fileName]),
              cursor: derived,
              specKey: JSON.stringify([meta.flow ?? "full", meta.description ?? ""]),
              probeMaxVersion: derived.prevVersion,
            });
          }
        }
        await this.io.writeMeta(taskId, meta);
      } catch (e) {
        process.stderr.write(
          `tut: warning: ${taskId} v${newVersion} landed but post-write bookkeeping failed (${(e as Error).message}); ` +
            `returning the landed version with needs_attention\n`,
        );
        return { task_id: taskId, version: newVersion, needs_attention: true };
      }

      if (isProject) return { task_id: taskId, version: newVersion };
      const result: AppendResult = { task_id: taskId, version: newVersion };
      if (derived) {
        result.status = derived.status;
        result.needs_attention = derived.needs_attention;
        if (derived.warnings.length > 0) result.warnings = structuredClone(derived.warnings);
      }
      return result;
    });
  }

  /** Read a task: full records (filtered by sinceVersion) plus derived status.
   * With since_version set, record files whose NAME carries a
   * lower version are never opened — the response filter and the audit
   * order (ascending version) are unchanged. The derived status folds the
   * full sequence via the per-task cache: a warm cache supplies
   * the cursor without reading old files; a cold cache folds the whole
   * sequence once (the status is derived, never trusted from meta.json). */
  async readTask(taskId: string, sinceVersion?: number): Promise<ReadTaskResult> {
    requireNonEmptyString(taskId, "task_id");
    requireValidTaskId(taskId);
    if (
      sinceVersion !== undefined &&
      (typeof sinceVersion !== "number" || !Number.isInteger(sinceVersion) || sinceVersion < 0)
    ) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, "since_version must be a non-negative integer");
    }
    const meta = await this.io.readMeta(taskId);
    if (!meta) throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);

    const names = await this.io.taskDirNames(taskId);
    // Name-prefix skip: only open files whose version ≥ since_version.
    const readable = names.filter((name) => {
      const version = recordFileVersion(name);
      return version !== null && (sinceVersion === undefined || version >= sinceVersion);
    });
    // Read paired with the REAL file name — the fold below reuses exactly
    // these records keyed by that name (never synthesize a
    // name back from content; a legal alias name would mis-attribute).
    const readPaired = await this.io.readNamedRecordsPaired(taskId, readable);
    const records = readPaired.map((p) => p.record);
    const versions = sinceVersion === undefined ? records : records.filter((r) => r.version >= sinceVersion);
    const result: ReadTaskResult = { task_id: taskId, title: meta.title, versions };
    if (meta.description !== undefined) result.description = meta.description;
    if (taskId !== PROJECT_TASK_ID) {
      result.flow = meta.flow ?? "full"; // deferred registration item: always present, normalized
      if (meta.cast !== undefined) result.cast = meta.cast;
      if (meta.checkout !== undefined) result.checkout = meta.checkout;
      const derived = await this.foldCache.derivedFor(taskId, meta.flow, meta.description, names, new Map(readPaired.map((p) => [p.name, p.record])));
      if (derived) result.status = derived.status;
    }
    return result;
  }

  /**
   * List tasks by scanning tasks/ directories — no index.json to maintain.
   * Project scope is included with scope: "project" and no status; the status
   * filter skips project scope and non-matching tasks. Storage-corrupted
   * tasks (unreadable/unparseable meta or records) are skipped here — the
   * degraded-visible surface is snapshotTasks (system-design 4.3).
   */
  async listTasks(status?: Status): Promise<TaskListEntry[]> {
    const { tasks } = await this.collectTasks();
    if (status === undefined) return tasks;
    return tasks.filter(
      (entry) => entry.scope === "project" ? false : entry.status === status,
    );
  }

  /**
   * /state build (system-design 4.3): foldable task entries PLUS the degraded
   * list — tasks whose meta or record files failed to read/parse never
   * silently disappear from the state surface. Degraded collects storage-level
   * damage only (meta corrupt/missing, records unreadable/unparseable with no
   * valid recovery registration): a task that folds — even with warnings /
   * needs_attention — is a normal entry (that is 3.2 out-of-sequence
   * semantics, a different concern). A vanished directory is invisible to
   * this scan by construction (discovery is directory-only); consumers detect
   * disappearance by diffing tasks∪degraded against their previous snapshot.
   */
  async snapshotTasks(): Promise<TaskSnapshot> {
    return this.collectTasks();
  }

  /**
   * In-process async mutex serializing meta read-modify-write operations.
   * Two lanes: a GLOBAL queue for slug-reserving mutations
   * (createTask — slug uniqueness is a cross-task property) and PER-TASK
   * queues for everything else (append / repairMeta / recoverRecord): two
   * different tasks' writes no longer queue behind each other. Reads are
   * never queued (unchanged) — atomic rename/link keeps them consistent.
   */
  private enqueue<T>(key: string | null, op: () => Promise<T>): Promise<T> {
    if (this.readOnly) return Promise.reject(new Error("Store is read-only"));
    const prior = key === null ? this.globalTail : this.taskTails.get(key) ?? Promise.resolve();
    const run = prior.then(op);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    if (key === null) {
      this.globalTail = tail;
    } else {
      this.taskTails.set(key, tail);
      // Reclaim settled tails with nothing newer chained behind them: the
      // deletion runs strictly after resolution, so an enqueue racing it
      // either chains onto the settled promise it already read (still
      // ordered) or starts a fresh chain — and the map stays bounded instead
      // of growing with every task the process ever mutated.
      void tail.then(() => {
        if (this.taskTails.get(key) === tail) this.taskTails.delete(key);
      });
    }
    return run;
  }

  /**
   * Shared directory walk behind listTasks and snapshotTasks: foldable task
   * entries plus the degraded list (system-design 4.3). A task lands in
   * degraded — with a one-line stderr warning naming the damage — when its
   * meta cannot be read/parsed (including a missing meta.json in an existing
   * directory: a create interrupted between mkdir and writeMeta) or its
   * records cannot be read/parsed and no valid recovery registration stands
   * in for them. Anything that folds is a normal entry, warnings or not.
   * The per-task folds go through the fold cache — a warm /state
   * build reads ZERO record files (one readdir per task directory is the
   * invalidation token); only tasks whose name set changed since the last
   * fold read anything, and then only the additions.
   */
  private async collectTasks(): Promise<TaskSnapshot> {
    let entries: Dirent[];
    try {
      entries = await this.io.taskEntries();
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return { tasks: [], degraded: [] };
      throw e;
    }
    const out: TaskListEntry[] = [];
    const degraded: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      if (!LEGACY_TASK_ID_PATTERN.test(taskId)) continue; // foreign dir names never resolve to a task path
      let meta: TaskMeta | null = null;
      let metaOk = true;
      try {
        meta = await this.io.readMeta(taskId);
      } catch (e) {
        metaOk = false;
        process.stderr.write(`tut: warning: task ${taskId} degraded (meta unreadable/malformed): ${(e as Error).message}\n`);
      }
      if (!metaOk || meta === null) {
        // null = missing meta.json in an existing dir — operation state gone, same class.
        if (metaOk) {
          process.stderr.write(`tut: warning: task ${taskId} degraded (meta.json missing — create interrupted?): no parseable operation state\n`);
        }
        degraded.push(taskId);
        continue;
      }
      const names = await this.io.taskDirNames(taskId);
      if (taskId === PROJECT_TASK_ID) {
        let recordsOk = true;
        try {
          await this.foldCache.probeRecords(taskId, names); // project carries no derivation; this is a (cached) health probe only
        } catch (e) {
          recordsOk = false;
          process.stderr.write(`tut: warning: project scope degraded (records unreadable): ${(e as Error).message}\n`);
        }
        if (recordsOk) {
          out.push({ task_id: taskId, title: meta.title, updated_at: meta.updated_at, version: meta.version, scope: "project" });
        } else {
          degraded.push(taskId);
        }
        continue;
      }
      let derived: Awaited<ReturnType<FoldCache["derivedFor"]>>;
      try {
        derived = await this.foldCache.derivedFor(taskId, meta.flow, meta.description, names);
      } catch (e) {
        process.stderr.write(`tut: warning: task ${taskId} degraded (records unreadable/unparseable): ${(e as Error).message}\n`);
        degraded.push(taskId);
        continue;
      }
      if (!derived) continue;
      out.push({
        task_id: taskId,
        title: meta.title,
        updated_at: meta.updated_at,
        status: derived.status,
        waiting_for: derived.waiting_for,
        needs_attention: derived.needs_attention,
        pending_since: derived.pending_since ?? null,
        round_count: derived.round_count ?? 0,
        warnings: structuredClone(derived.warnings),
        // Disk-max version, not meta.version alone (system-design 4.3): an
        // out-of-band landed record (the corruption threat model itself)
        // must lift the reported version so version-diff consumers see it
        // without any quiet-round reads — the 0.6.0 tail re-read's
        // self-healing visibility at zero steady-state cost.
        version: Math.max(meta.version, maxRecordVersionOf(names)),
        flow: meta.flow ?? "full", // deferred registration item: always present, normalized
        ...(meta.cast !== undefined ? { cast: meta.cast } : {}),
        ...(meta.checkout !== undefined ? { checkout: meta.checkout } : {}),
      });
    }
    out.sort((a, b) => a.task_id.localeCompare(b.task_id));
    degraded.sort();
    return { tasks: out, degraded };
  }

  private async uniqueSlug(base: string): Promise<string> {
    await this.io.ensureTasksDir();
    let candidate = base;
    if (candidate === PROJECT_TASK_ID) candidate = `${base}-${shortSuffix()}`;
    while (await this.io.entryExists(path.join(this.io.tasksDir(), candidate))) {
      candidate = `${base}-${shortSuffix()}`;
    }
    return candidate;
  }
}

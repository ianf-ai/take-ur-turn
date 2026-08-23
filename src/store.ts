import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { type Dirent } from "node:fs";
import path from "node:path";
import {
  ErrorCode,
  PROJECT_TASK_ID,
  type Cast,
  type ContextRecord,
  type ContentType,
  type Flow,
  type Payload,
  type Status,
  type WaitingFor,
  type Warning,
} from "./types.js";
import { derive } from "./state-machine.js";

/**
 * File-backed store. API maps 1:1 to the MCP tools of
 * system-design 4.1: createTask → context.create, append → context.publish,
 * readTask → context.read, listTasks → context.list. decide maps onto append
 * and needs no separate store API.
 *
 * Concurrency: all meta read-modify-write mutations are serialized through an
 * in-process async mutex (single-writer queue, system-design 4.2). Zero
 * runtime dependencies beyond node:fs/promises / node:path.
 */

export class StoreError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export interface CreateTaskInput {
  title: string;
  description: string;
  creator: string;
  role: string;
  /** Workflow variant (system-design 3.1): absent = "full". */
  flow?: Flow;
  /** Per-task cast: role → agent routing overrides, absent roles use the default lineup. */
  cast?: Cast;
}

export interface CreateTaskResult {
  task_id: string;
  status: Status;
  version: 0;
}

export interface AppendInput {
  role: string;
  content_type: ContentType;
  payload: Payload;
  agent?: string;
  model?: string;
  expected_version?: number;
}

export interface AppendResult {
  task_id: string;
  version: number;
  status?: Status;
  needs_attention?: boolean;
  warnings?: Warning[];
}

export interface ReadTaskResult {
  task_id: string;
  title: string;
  /** The task's requirement text from meta (system-design 4.1). */
  description?: string;
  /** Workflow variant, always present for task scope and normalized to "full". */
  flow?: Flow;
  /** Per-task cast: present only when the task carries one. */
  cast?: Cast;
  status?: Status;
  versions: ContextRecord[];
}

export interface TaskListEntry {
  task_id: string;
  title: string;
  updated_at: string;
  scope?: "project";
  status?: Status;
  waiting_for?: WaitingFor;
  needs_attention?: boolean;
  /** Latest landed record version (meta.version). */
  version: number;
  /** Workflow variant, always present for task scope, normalized to "full". */
  flow?: Flow;
  /** Per-task cast: present only when the task carries one. */
  cast?: Cast;
}

/** meta.json on disk. Cached derived fields are absent for project scope. */
interface TaskMeta {
  task_id: string;
  title: string;
  description?: string;
  creator?: string;
  role?: string;
  /**
   * Workflow variant selecting the transition table. Written once at
   * create, never touched again — immutability is by construction (no write
   * path exists; append/read only read it). Absent = "full" (existing tasks
   * need zero migration); project scope never carries it.
   */
  flow?: Flow;
  /**
   * Per-task cast: role → agent routing. Written once at create, never
   * touched again — same immutability-by-construction as flow (no write path
   * exists). Absent on default creates and on project scope.
   */
  cast?: Cast;
  created_at: string;
  updated_at: string;
  /** Latest landed record version; 0 after create. */
  version: number;
  /* Derived-state cache; recomputable from the record sequence at any time. */
  status?: Status;
  waiting_for?: WaitingFor;
  needs_attention?: boolean;
  warnings?: Warning[];
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `${field} must be a non-empty string`);
  }
  return value;
}

/** Create-time flow validation: the value selects a transition table, so it must be a known one. */
function requireValidFlow(value: unknown): Flow {
  if (value !== undefined && value !== "full" && value !== "direct" && value !== "solo") {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `flow must be full, direct, or solo: ${String(value)}`);
  }
  return value as Flow;
}

const CAST_ROLES = ["architect", "executor", "reviewer"] as const;

/** Create-time cast validation: role keys limited to the three convention roles, agents non-empty strings. */
function requireValidCast(value: unknown): Cast | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, "cast must be an object of role=agent pairs");
  }
  const out: Cast = {};
  for (const [role, agent] of Object.entries(value as Record<string, unknown>)) {
    if (!(CAST_ROLES as readonly string[]).includes(role)) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, `cast role must be one of ${CAST_ROLES.join("|")}, got: ${role}`);
    }
    if (typeof agent !== "string" || agent.trim().length === 0) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, `cast agent for '${role}' must be a non-empty string`);
    }
    out[role as keyof Cast] = agent;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Legal task_id on disk: the same domain slugify produces (lowercase
 * alphanumerics plus "." / "_" / "-", starting alphanumeric; "project" passes,
 * which is correct). Blocking anything else at every public entry point stops
 * path traversal — "../evil" / "../../outside" must never reach path.join
 * against the store root (blocks path traversal).
 */
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function requireValidTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `task_id must match ${TASK_ID_PATTERN.source}: ${taskId}`);
  }
}

/** lowercase, hyphen-separated; reserved word "project" never returned as-is. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "task";
}

function shortSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/** Filename-safe content_type: "a/b" → "a-b". */
function sanitizeContentType(contentType: string): string {
  const sanitized = contentType.replace(/[^a-zA-Z0-9._-]/g, "-");
  return sanitized.length > 0 ? sanitized : "record";
}

function recordFileName(version: number, contentType: string): string {
  return `v${String(version).padStart(3, "0")}.${sanitizeContentType(contentType)}.json`;
}

function isErrnoException(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}

/**
 * Parse JSON from a store file, rethrowing SyntaxError as a contract
 * StoreError naming the file (a corrupt file must surface as
 * VALIDATION_ERROR, never a raw JSON.parse crash).
 */
function parseJsonFile<T>(raw: string, filePath: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `corrupt JSON in ${filePath}: ${(e as Error).message}`);
  }
}

/**
 * Temp-file sibling for an atomic write. The ".json.<pid>.tmp" suffix keeps it
 * out of readRecords / maxOnDiskRecordVersion (both filter on ".json").
 */
function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.tmp`;
}

/**
 * Best-effort sweep of leftover temp files in the tasks tree:
 * a crash between writeFile(temp) and rename/link
 * leaves `<file>.<pid>.tmp` siblings that no later run would otherwise clean.
 * Temp files owned by THIS process (`.<pid>.tmp`) are skipped — the sweep runs
 * outside the single-writer queue and must not race this process's own
 * in-flight writes; only other processes' orphans are swept. Every
 * step is tolerant — a missing tasks dir, a foreign file, or a temp that
 * vanishes mid-sweep (racing writer) is skipped silently; each removal is
 * logged to stderr (absolute path) like the store's other one-line warnings.
 */
async function sweepTempFiles(tasksDir: string): Promise<void> {
  const ownSuffix = `.${process.pid}.tmp`;
  let entries: Dirent[];
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch {
    return; // no tasks tree yet — nothing to sweep
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(tasksDir, entry.name);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".tmp")) continue;
      if (name.endsWith(ownSuffix)) continue; // ours — an in-flight write, not a leftover
      try {
        await unlink(path.join(dir, name));
        process.stderr.write(`tut: swept leftover temp file ${path.join(dir, name)}\n`);
      } catch {
        // already gone or a racing writer owns it — best effort only
      }
    }
  }
}

export class Store {
  readonly root: string;

  /**
   * Construction-time .tmp sweep. Fire-and-
   * forget best effort; exposed as a promise so callers/tests can await it
   * before asserting on the directory contents.
   */
  readonly whenSwept: Promise<void>;

  private tail: Promise<void> = Promise.resolve();

  constructor(root: string = ".context-hub") {
    this.root = root;
    this.whenSwept = sweepTempFiles(this.tasksDir());
  }

  /** Create a task: writes meta.json only — no record, version 0. */
  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const title = requireNonEmptyString(input?.title, "title");
    const description = requireNonEmptyString(input?.description, "description");
    const creator = requireNonEmptyString(input?.creator, "creator");
    const role = requireNonEmptyString(input?.role, "role");
    const flow = requireValidFlow(input?.flow);
    const cast = requireValidCast(input?.cast);

    return this.enqueue(async () => {
      const taskId = await this.uniqueSlug(slugify(title));
      const taskDir = this.taskDir(taskId);
      await mkdir(taskDir, { recursive: true });
      const now = new Date().toISOString();
      const meta: TaskMeta = {
        task_id: taskId,
        title,
        description,
        creator,
        role,
        ...(flow !== undefined ? { flow } : {}), // absent = full; key stays out for default creates
        ...(cast !== undefined ? { cast } : {}), // absent = default lineup; key stays out for default creates
        created_at: now,
        updated_at: now,
        version: 0,
      };
      this.cacheDerived(meta, derive(taskId, [], flow));
      await this.writeMeta(taskId, meta);
      return { task_id: taskId, status: meta.status ?? "designing", version: 0 as const };
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

    return this.enqueue(async () => {
      const isProject = taskId === PROJECT_TASK_ID;
      let meta = await this.readMeta(taskId);
      if (!meta) {
        if (!isProject) {
          throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);
        }
        // Project scope lifecycle: no create, auto-create dir+meta on first append.
        await mkdir(this.taskDir(taskId), { recursive: true });
        const now = new Date().toISOString();
        meta = {
          task_id: taskId,
          title: PROJECT_TASK_ID,
          created_at: now,
          updated_at: now,
          version: 0,
        };
        await this.writeMeta(taskId, meta);
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
      const newVersion = Math.max(meta.version, await this.maxOnDiskRecordVersion(taskId)) + 1;
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
      const fileName = recordFileName(newVersion, input.content_type);
      await this.writeRecordExclusive(taskId, fileName, JSON.stringify(record, null, 2) + "\n");

      meta.version = newVersion;
      meta.updated_at = timestamp;
      let derived = null;
      if (isProject) {
        // No status semantics for project scope — strip any stale derived cache fields.
        delete meta.status;
        delete meta.waiting_for;
        delete meta.needs_attention;
        delete meta.warnings;
      } else {
        derived = derive(taskId, await this.readRecords(taskId), meta.flow);
        this.cacheDerived(meta, derived);
      }
      await this.writeMeta(taskId, meta);

      if (isProject) return { task_id: taskId, version: newVersion };
      const result: AppendResult = { task_id: taskId, version: newVersion };
      if (derived) {
        result.status = derived.status;
        result.needs_attention = derived.needs_attention;
        if (derived.warnings.length > 0) result.warnings = derived.warnings;
      }
      return result;
    });
  }

  /** Read a task: full records (filtered by sinceVersion) plus derived status. */
  async readTask(taskId: string, sinceVersion?: number): Promise<ReadTaskResult> {
    requireNonEmptyString(taskId, "task_id");
    requireValidTaskId(taskId);
    if (
      sinceVersion !== undefined &&
      (typeof sinceVersion !== "number" || !Number.isInteger(sinceVersion) || sinceVersion < 0)
    ) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, "since_version must be a non-negative integer");
    }
    const meta = await this.readMeta(taskId);
    if (!meta) throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);

    const records = await this.readRecords(taskId);
    const versions = sinceVersion === undefined ? records : records.filter((r) => r.version >= sinceVersion);
    const result: ReadTaskResult = { task_id: taskId, title: meta.title, versions };
    if (meta.description !== undefined) result.description = meta.description;
    if (taskId !== PROJECT_TASK_ID) {
      result.flow = meta.flow ?? "full"; // deferred registration item: always present, normalized
      if (meta.cast !== undefined) result.cast = meta.cast;
      const derived = derive(taskId, records, meta.flow);
      if (derived) result.status = derived.status;
    }
    return result;
  }

  /**
   * List tasks by scanning tasks/ directories — no index.json to maintain.
   * Project scope is included with scope: "project" and no status; the status
   * filter skips project scope and non-matching tasks.
   */
  async listTasks(status?: Status): Promise<TaskListEntry[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.tasksDir(), { withFileTypes: true });
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return [];
      throw e;
    }
    const out: TaskListEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      if (!TASK_ID_PATTERN.test(taskId)) continue; // foreign dir names never resolve to a task path
      let meta: TaskMeta | null;
      try {
        meta = await this.readMeta(taskId);
      } catch (e) {
        // Corrupt meta.json must not poison the whole listing — skip the dir.
        if (e instanceof StoreError && e.code === ErrorCode.VALIDATION_ERROR) continue;
        throw e;
      }
      if (!meta) continue;
      if (taskId === PROJECT_TASK_ID) {
        if (status !== undefined) continue;
        out.push({ task_id: taskId, title: meta.title, updated_at: meta.updated_at, version: meta.version, scope: "project" });
        continue;
      }
      let records: ContextRecord[];
      try {
        records = await this.readRecords(taskId);
      } catch (e) {
        // Same tolerance for corrupt record files: skip the task with a
        // one-line stderr warning. readTask still propagates — a direct read
        // should tell the truth about the corruption.
        if (e instanceof StoreError && e.code === ErrorCode.VALIDATION_ERROR) {
          process.stderr.write(`tut: warning: skipping task ${taskId} in listing: ${e.message}\n`);
          continue;
        }
        throw e;
      }
      const derived = derive(taskId, records, meta.flow);
      if (!derived) continue;
      if (status !== undefined && derived.status !== status) continue;
      out.push({
        task_id: taskId,
        title: meta.title,
        updated_at: meta.updated_at,
        status: derived.status,
        waiting_for: derived.waiting_for,
        needs_attention: derived.needs_attention,
        version: meta.version,
        flow: meta.flow ?? "full", // deferred registration item: always present, normalized
        ...(meta.cast !== undefined ? { cast: meta.cast } : {}),
      });
    }
    out.sort((a, b) => a.task_id.localeCompare(b.task_id));
    return out;
  }

  // --- internals -----------------------------------------------------------

  private tasksDir(): string {
    return path.join(this.root, "tasks");
  }

  private taskDir(taskId: string): string {
    return path.join(this.tasksDir(), taskId);
  }

  private metaPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "meta.json");
  }

  /** In-process async mutex serializing all meta read-modify-write operations. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async uniqueSlug(base: string): Promise<string> {
    await mkdir(this.tasksDir(), { recursive: true });
    let candidate = base;
    if (candidate === PROJECT_TASK_ID) candidate = `${base}-${shortSuffix()}`;
    while (await this.dirExists(path.join(this.tasksDir(), candidate))) {
      candidate = `${base}-${shortSuffix()}`;
    }
    return candidate;
  }

  private async dirExists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return false;
      throw e;
    }
  }

  private async readMeta(taskId: string): Promise<TaskMeta | null> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(taskId), "utf8");
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return null;
      throw e;
    }
    return parseJsonFile<TaskMeta>(raw, this.metaPath(taskId));
  }

  /**
   * Write meta.json atomically: temp file in the same directory, then
   * fs.rename over the target (atomic on POSIX) — readers never observe
   * partial JSON.
   */
  private async writeMeta(taskId: string, meta: TaskMeta): Promise<void> {
    const target = this.metaPath(taskId);
    const temp = tempPathFor(target);
    try {
      await writeFile(temp, JSON.stringify(meta, null, 2) + "\n", "utf8");
      await rename(temp, target);
    } catch (e) {
      await unlink(temp).catch(() => undefined); // best-effort temp cleanup
      throw e;
    }
  }

  /**
   * Publish a record file exclusively: write the full content to a temp
   * file, then fs.link it onto the final name — link fails with EEXIST if the
   * name is already taken, preserving the append-only exclusive-create
   * guarantee atomically (same semantics as the old "wx" flag, but readers
   * never see partial JSON). EEXIST maps to VERSION_CONFLICT exactly as before.
   */
  private async writeRecordExclusive(taskId: string, fileName: string, content: string): Promise<void> {
    const final = path.join(this.taskDir(taskId), fileName);
    const temp = tempPathFor(final);
    try {
      await writeFile(temp, content, "utf8");
      await link(temp, final);
      await unlink(temp).catch(() => undefined); // temp published; unlink is best-effort
    } catch (e) {
      await unlink(temp).catch(() => undefined); // best-effort temp cleanup
      if (isErrnoException(e, "EEXIST")) {
        throw new StoreError(ErrorCode.VERSION_CONFLICT, `record file already exists: ${fileName}`);
      }
      throw e;
    }
  }

  /** Max record version present as a file in the task dir (0 when none) — crash-window reconciliation. */
  private async maxOnDiskRecordVersion(taskId: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.taskDir(taskId));
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return 0;
      throw e;
    }
    let max = 0;
    for (const name of names) {
      if (name === "meta.json" || !name.endsWith(".json")) continue;
      const match = /^v(\d+)\./.exec(name);
      if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
    }
    return max;
  }

  /** All record files of a task, sorted by version (derive never consumes timestamps). */
  private async readRecords(taskId: string): Promise<ContextRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.taskDir(taskId));
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return [];
      throw e;
    }
    const records: ContextRecord[] = [];
    for (const name of names) {
      if (name === "meta.json" || !name.endsWith(".json")) continue;
      const filePath = path.join(this.taskDir(taskId), name);
      records.push(parseJsonFile<ContextRecord>(await readFile(filePath, "utf8"), filePath));
    }
    records.sort((a, b) => a.version - b.version);
    return records;
  }

  private cacheDerived(meta: TaskMeta, derived: ReturnType<typeof derive> | null): void {
    if (!derived) return;
    meta.status = derived.status;
    meta.waiting_for = derived.waiting_for;
    meta.needs_attention = derived.needs_attention;
    meta.warnings = derived.warnings;
  }
}

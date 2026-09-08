import { appendFile, link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  ErrorCode,
  PROJECT_TASK_ID,
  type Cast,
  type CheckoutRoute,
  type ContextRecord,
  type ContentType,
  type Flow,
  type Payload,
  type Status,
  type WaitingFor,
  type Warning,
} from "./types.js";
import { AgentCommandError, validateAgentRoute } from "./agent-command.js";
import { WAITING_FOR_BASE, derive, foldOntoCursor, initialCursor, type FoldCursor } from "./state-machine.js";

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
  /** Per-task cast: role → agent route overrides, absent roles use the default lineup. */
  cast?: Cast;
  /** Task-frozen checkout route; absent preserves the legacy current checkout. */
  checkout?: CheckoutRoute;
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
  /** Task-frozen checkout route; absent preserves the legacy current checkout. */
  checkout?: CheckoutRoute;
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
  /** Task-frozen checkout route; absent preserves the legacy current checkout. */
  checkout?: CheckoutRoute;
}

/** /state build result (system-design 4.3): foldable tasks plus the degraded list. */
export interface TaskSnapshot {
  tasks: TaskListEntry[];
  /** Tasks whose meta or records failed to read/parse (storage-level damage,
   *  system-design 4.3 three-class protocol) — never silently skipped. */
  degraded: string[];
}

/** One recovery.jsonl registration line (system-design 4.3 B-class protocol). */
export interface RecoveryEntry {
  seq: number;
  /** Corrupt original file name, e.g. "v003.note.json". */
  file: string;
  corrupt_sha256: string;
  recovered_sha256: string;
  /** Recovered copy file name, e.g. "v003.note.json.recovered". */
  recovered_file: string;
  /** Where the recovered bytes came from (audit trail, human-supplied). */
  source: string;
  registered_at: string;
}

/** POST /repair-meta input: human-supplied rebuild fields for a corrupt meta (system-design 4.3 A-class). */
export interface RepairMetaInput {
  title?: string;
  description?: string;
  creator?: string;
  created_at?: string;
  flow?: Flow;
  cast?: Cast;
  checkout?: CheckoutRoute;
}

export interface RepairMetaResult {
  task_id: string;
  /** Server-computed from the max on-disk record version — never caller input. */
  version: number;
  /** Present iff the rebuilt task still folds (records healthy). */
  status?: Status;
}

/** POST /recover-record input (system-design 4.3 B-class registration). */
export interface RecoverRecordInput {
  /** Corrupt record file name within the task dir, e.g. "v003.note.json". */
  record_file: string;
  /** Path to the recovered original bytes (external snapshot — backup / shared repo / team git). */
  from_path: string;
  /** Provenance note for the audit trail. */
  source?: string;
}

export interface RecoverRecordResult {
  task_id: string;
  record_file: string;
  /** 1-based line number in recovery.jsonl. */
  seq: number;
  recovered_file: string;
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
   * Per-task cast: role → agent route. Written once at create, never
   * touched again — same immutability-by-construction as flow (no write path
   * exists). Absent on default creates and on project scope.
   */
  cast?: Cast;
  /** Task-frozen checkout route. Absent means the legacy current checkout. */
  checkout?: CheckoutRoute;
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

/** Create-time cast validation: role keys limited to the three convention roles. */
function requireValidCast(value: unknown): Cast | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, "cast must be an object of role=agent command pairs");
  }
  const out: Cast = {};
  for (const [role, route] of Object.entries(value as Record<string, unknown>)) {
    if (!(CAST_ROLES as readonly string[]).includes(role)) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, `cast role must be one of ${CAST_ROLES.join("|")}, got: ${role}`);
    }
    try {
      out[role as keyof Cast] = validateAgentRoute(route, `cast agent for '${role}'`);
    } catch (e) {
      const message = e instanceof AgentCommandError ? e.message : "invalid command route";
      throw new StoreError(ErrorCode.VALIDATION_ERROR, message);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Create-time checkout validation. The route is immutable metadata; it never runs git. */
function requireValidCheckout(value: unknown): CheckoutRoute | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, "checkout must be an object with kind current or worktree");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "current") return { kind: "current" };
  if (raw.kind !== "worktree") {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, "checkout.kind must be current or worktree");
  }

  const routeValue = (candidate: unknown, field: "path" | "ref"): string | undefined => {
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "string" || candidate.trim().length === 0 || /[\u0000\r\n]/u.test(candidate)) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, `checkout.${field} must be a non-empty string without NUL/CR/LF`);
    }
    return candidate;
  };
  const checkoutPath = routeValue(raw.path, "path");
  const ref = routeValue(raw.ref, "ref");
  if (checkoutPath === undefined) {
    // A ref-only route can never launch: the launcher resolves explicit
    // paths and never creates worktrees, so freezing one would create a
    // permanently unlaunchable task (checkout is immutable).  Ref rides
    // along as an annotation next to a path, never instead of one.
    throw new StoreError(
      ErrorCode.VALIDATION_ERROR,
      "worktree checkout requires a path; ref alone is not accepted (ref may only annotate a path)",
    );
  }
  return {
    kind: "worktree",
    path: checkoutPath,
    ...(ref !== undefined ? { ref } : {}),
  };
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Record file name pattern: consumption (readRecords) and the
 * crash-window scan (maxOnDiskRecordVersion) accept ONLY `v<digits>.<type>.json`
 * names — the exact shape recordFileName produces. meta.json, recovery.jsonl,
 * `*.json.recovered` copies, and foreign `.json` files never fold and never
 * count as versions. Returns the parsed version, or null for a non-record name.
 */
export function recordFileVersion(fileName: string): number | null {
  const match = /^v(\d+)\..+\.json$/.exec(fileName);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
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
 * Runtime artifact validation for a record about to enter the fold.
 * JSON.parse alone accepts far too much: `"{}"`, an array, or
 * `{"content_type":"note"}` (no payload) are syntactically fine but make
 * derive crash (payload.ack TypeError) or masquerade as a normal — merely
 * warning-carrying — tasks[] entry. Structural damage is STORAGE damage
 * (system-design 4.3): it must surface as VALIDATION_ERROR → degraded, never
 * reach derive, and never 500 a /state build. "Non-empty" uses the append
 * door's trim() definition everywhere: a
 * whitespace-only role/content_type/timestamp/task_id would silently
 * legalize damage the write side refuses. The same validator gates the
 * recovery channel (registration source and .recovered copies at
 * consumption), so a recovered stand-in is exactly as well-formed as a
 * normally landed record. Exported read-only for tut doctor: the
 * diagnostic scan classifies artifacts with the SAME validator so doctor and
 * /state can never disagree on what counts as damage.
 */
export function validateRecordArtifact(value: unknown, filePath: string, taskId?: string): ContextRecord {
  const fail = (detail: string): never => {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `malformed record ${filePath}: ${detail}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("not a record object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "number" || !Number.isInteger(record.version) || record.version < 1) {
    fail("version must be an integer ≥ 1");
  }
  if (typeof record.task_id !== "string" || record.task_id.trim().length === 0) {
    fail("task_id must be a non-empty string");
  }
  if (taskId !== undefined && record.task_id !== taskId) {
    fail(`task_id must be ${taskId} (directory identity), got ${record.task_id}`);
  }
  if (typeof record.role !== "string" || record.role.trim().length === 0) {
    fail("role must be a non-empty string");
  }
  if (typeof record.content_type !== "string" || record.content_type.trim().length === 0) {
    fail("content_type must be a non-empty string");
  }
  if (typeof record.timestamp !== "string" || record.timestamp.trim().length === 0) {
    fail("timestamp must be a non-empty string");
  }
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    fail("payload must be an object");
  }
  // Same shape the append door enforces on every write — a landed record
  // without summary/body could only come from damage.
  const p = payload as Record<string, unknown>;
  if (typeof p.summary !== "string" || p.summary.trim().length === 0) {
    fail("payload.summary must be a non-empty string");
  }
  if (typeof p.body !== "string" || p.body.trim().length === 0) {
    fail("payload.body must be a non-empty string");
  }
  return value as ContextRecord;
}

/**
 * Runtime artifact validation for meta.json. A
 * syntactically-valid but structurally-invalid meta (flow outside the enum,
 * non-integer version, missing title) previously slipped straight into
 * derive — selecting a nonexistent transition table row and producing a
 * garbage tasks[] entry instead of the honest degraded listing the design
 * promises for operation-state damage. Task identity is checked against the
 * directory name (a mismatched task_id is damage, not a rename); flow /
 * cast / checkout reuse the create-time validators so the read-side and
 * write-side domains can never drift apart. Unknown fields pass — the
 * additive-only surface stays forward-compatible. Exported read-only for
 * tut doctor, same rationale as validateRecordArtifact.
 */
export function validateMetaArtifact(value: unknown, filePath: string, taskId: string): TaskMeta {
  const fail = (detail: string): never => {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `malformed meta ${filePath}: ${detail}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("not an object");
  }
  const meta = value as Record<string, unknown>;
  if (meta.task_id !== taskId) {
    fail(`task_id must be ${taskId}`);
  }
  if (typeof meta.title !== "string" || meta.title.trim().length === 0) {
    fail("title must be a non-empty string");
  }
  if (typeof meta.created_at !== "string" || meta.created_at.trim().length === 0) {
    fail("created_at must be a non-empty string");
  }
  if (typeof meta.updated_at !== "string" || meta.updated_at.trim().length === 0) {
    fail("updated_at must be a non-empty string");
  }
  if (typeof meta.version !== "number" || !Number.isInteger(meta.version) || meta.version < 0) {
    fail("version must be an integer ≥ 0");
  }
  try {
    requireValidFlow(meta.flow);
    requireValidCast(meta.cast);
    requireValidCheckout(meta.checkout);
  } catch (e) {
    if (e instanceof StoreError) fail(e.message);
    throw e;
  }
  return value as TaskMeta;
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
 * in-flight writes. A temp owned by ANOTHER live process is in flight too.
 * Only temps older than SWEEP_TMP_MAX_AGE_MS are swept — a
 * healthy write finishes in milliseconds, so an aged tmp is a leftover from
 * a crashed/killed writer, not a racing one. Every step is tolerant — a
 * missing tasks dir, a foreign file, or a temp that vanishes mid-sweep
 * (racing writer) is skipped silently; each removal is logged to stderr
 * (absolute path) like the store's other one-line warnings.
 */
const SWEEP_TMP_MAX_AGE_MS = 60_000;

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
      const filePath = path.join(dir, name);
      try {
        const s = await stat(filePath);
        if (Date.now() - s.mtimeMs < SWEEP_TMP_MAX_AGE_MS) {
          continue; // fresh — plausibly another process's in-flight write, not a leftover
        }
      } catch {
        continue; // vanished mid-sweep — best effort only
      }
      try {
        await unlink(filePath);
        process.stderr.write(`tut: swept leftover temp file ${filePath}\n`);
      } catch {
        // already gone or a racing writer owns it — best effort only
      }
    }
  }
}

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
  cursor: FoldCursor | null;
  /** Project scope only: max record version the probe validated (extension floor). */
  probeMaxVersion: number;
}

/** Names that participate in folding (token inputs + read candidates). */
function isFoldRelevantName(name: string): boolean {
  return recordFileVersion(name) !== null || name === "recovery.jsonl" || name.endsWith(".recovered");
}

/** Invalidation token for a task directory's name list. */
function foldTokenOf(names: readonly string[]): string {
  return names.filter(isFoldRelevantName).sort().join("\n");
}

/** Max record version among a name list (0 when none). */
function maxRecordVersionOf(names: readonly string[]): number {
  let max = 0;
  for (const name of names) {
    const version = recordFileVersion(name);
    if (version !== null) max = Math.max(max, version);
  }
  return max;
}

export class Store {
  readonly root: string;

  /**
   * Construction-time .tmp sweep. Fire-and-
   * forget best effort; exposed as a promise so callers/tests can await it
   * before asserting on the directory contents.
   */
  readonly whenSwept: Promise<void>;

  /** Global tail for slug-reserving mutations (createTask) — cross-task. */
  private globalTail: Promise<void> = Promise.resolve();
  /** Per-task mutation tails: appends/repairs of different tasks never queue behind each other. */
  private taskTails = new Map<string, Promise<void>>();
  /** Per-task fold cache; see TaskFoldCache for the trust boundary. */
  private foldCache = new Map<string, TaskFoldCache>();

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
    const checkout = requireValidCheckout(input?.checkout);

    return this.enqueue(null, async () => {
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
        ...(checkout !== undefined ? { checkout } : {}), // absent = current; key stays out for old creates
        created_at: now,
        updated_at: now,
        version: 0,
      };
      this.cacheDerived(meta, derive(taskId, [], flow));
      // Seed the fold cache: a fresh task's directory holds no
      // fold-relevant names, so the empty token matches the first reader.
      this.foldCache.set(taskId, {
        token: "",
        cursor: initialCursor(flow ?? "full"),
        probeMaxVersion: 0,
      });
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

    return this.enqueue(taskId, async () => {
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
      const names = await this.taskDirNames(taskId);
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
      let derived: ReturnType<typeof foldOntoCursor> | null = null;
      if (!isProject) {
        const cursor = await this.foldCursorFor(taskId, meta.flow ?? "full", names); // VALIDATION_ERROR on unrecovered corruption → nothing lands
        derived = foldOntoCursor(cursor, [record], meta.flow ?? "full");
      }

      const fileName = recordFileName(newVersion, input.content_type);
      await this.writeRecordExclusive(taskId, fileName, JSON.stringify(record, null, 2) + "\n");

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
          this.rememberFoldToken(taskId, names, fileName);
        } else {
          this.cacheDerived(meta, derived);
          if (derived !== null) {
            // Advance the fold cache across this landed record: same names
            // plus the new file, cursor = the fold this append already
            // computed. A post-bookkeeping failure path below skips this —
            // the cache then simply re-derives from the token on next read.
            this.foldCache.set(taskId, {
              token: foldTokenOf([...names, fileName]),
              cursor: { status: derived.status, prevVersion: derived.prevVersion, warnings: derived.warnings },
              probeMaxVersion: derived.prevVersion,
            });
          }
        }
        await this.writeMeta(taskId, meta);
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
        if (derived.warnings.length > 0) result.warnings = derived.warnings;
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
    const meta = await this.readMeta(taskId);
    if (!meta) throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);

    const names = await this.taskDirNames(taskId);
    // Name-prefix skip: only open files whose version ≥ since_version.
    const readable = names.filter((name) => {
      const version = recordFileVersion(name);
      return version !== null && (sinceVersion === undefined || version >= sinceVersion);
    });
    // Read paired with the REAL file name — the fold below reuses exactly
    // these records keyed by that name (never synthesize a
    // name back from content; a legal alias name would mis-attribute).
    const readPaired = await this.readNamedRecordsPaired(taskId, readable);
    const records = readPaired.map((p) => p.record);
    const versions = sinceVersion === undefined ? records : records.filter((r) => r.version >= sinceVersion);
    const result: ReadTaskResult = { task_id: taskId, title: meta.title, versions };
    if (meta.description !== undefined) result.description = meta.description;
    if (taskId !== PROJECT_TASK_ID) {
      result.flow = meta.flow ?? "full"; // deferred registration item: always present, normalized
      if (meta.cast !== undefined) result.cast = meta.cast;
      if (meta.checkout !== undefined) result.checkout = meta.checkout;
      const derived = await this.derivedFor(taskId, meta.flow, names, new Map(readPaired.map((p) => [p.name, p.record])));
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
   * A-class recovery (system-design 4.3): rebuild a corrupt/missing meta.json
   * through the store's supported entry (HTTP POST /repair-meta). version is
   * SERVER-computed from the max on-disk record version (the same source the
   * append crash-window reconciliation uses) — caller input is not accepted,
   * so a rebuild can never clobber orphan records. Title/flow/etc. come from
   * the caller (the human's best available archive: notifier snapshots, read
   * responses, notes); unavailable fields fall back per design (title →
   * task_id, flow → full, created_at → repair time). Refuses a readable meta
   * (repair is not an overwrite path). If the records themselves are damaged
   * the rebuild still lands (operation state fixed) but no derived cache is
   * written — the task stays degraded until the B-class recovery resolves.
   */
  async repairMeta(taskId: string, input: RepairMetaInput): Promise<RepairMetaResult> {
    requireNonEmptyString(taskId, "task_id");
    requireValidTaskId(taskId);
    const title = input?.title !== undefined ? requireNonEmptyString(input.title, "title") : undefined;
    const description = input?.description !== undefined ? requireNonEmptyString(input.description, "description") : undefined;
    const creator = input?.creator !== undefined ? requireNonEmptyString(input.creator, "creator") : undefined;
    const createdAt = input?.created_at !== undefined ? requireNonEmptyString(input.created_at, "created_at") : undefined;
    const flow = requireValidFlow(input?.flow);
    const cast = requireValidCast(input?.cast);
    const checkout = requireValidCheckout(input?.checkout);

    const isProject = taskId === PROJECT_TASK_ID;
    if (isProject && (flow !== undefined || cast !== undefined || checkout !== undefined || title !== undefined)) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, "project scope carries no title/flow/cast/checkout — nothing to rebuild");
    }

    return this.enqueue(taskId, async () => {
      if (!(await this.dirExists(this.taskDir(taskId)))) {
        throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);
      }
      // The repair door is for BROKEN meta only — a readable meta must not be
      // overwritten through it (create-time fields are immutable; a "repair"
      // of healthy operation state would be a rogue write path).
      let readable: TaskMeta | null = null;
      let broken = false;
      try {
        readable = await this.readMeta(taskId);
      } catch (e) {
        if (e instanceof StoreError && e.code === ErrorCode.VALIDATION_ERROR) broken = true;
        else throw e;
      }
      if (!broken && readable !== null) {
        throw new StoreError(ErrorCode.VALIDATION_ERROR, `meta.json of ${taskId} is readable — nothing to repair`);
      }
      broken = true; // readMeta null (missing meta.json in an existing dir) is damage too

      const now = new Date().toISOString();
      const version = await this.maxOnDiskRecordVersion(taskId); // server-computed, never caller input
      // A rebuild may select a DIFFERENT flow than the damaged meta carried —
      // flow selects the transition table, so any cached cursor folded under
      // the old flow is void (cache discipline: token cannot see meta).
      this.foldCache.delete(taskId);
      const meta: TaskMeta = {
        task_id: taskId,
        title: isProject ? PROJECT_TASK_ID : (title ?? taskId),
        ...(description !== undefined ? { description } : {}),
        ...(creator !== undefined ? { creator } : {}),
        ...(isProject ? {} : { flow: flow ?? "full" }),
        ...(cast !== undefined ? { cast } : {}),
        ...(checkout !== undefined ? { checkout } : {}),
        created_at: createdAt ?? now,
        updated_at: now,
        version,
      };
      if (!isProject) {
        try {
          this.cacheDerived(meta, derive(taskId, await this.readRecords(taskId), meta.flow));
        } catch (e) {
          // Records damaged too — meta rebuild lands (A fixed), the task stays
          // degraded until B-class recovery resolves the records (4.3).
          process.stderr.write(
            `tut: warning: ${taskId} meta rebuilt but records still fail to fold (${(e as Error).message}); task remains degraded\n`,
          );
        }
      }
      await this.writeMeta(taskId, meta);
      return {
        task_id: taskId,
        version,
        ...(meta.status !== undefined ? { status: meta.status } : {}),
      };
    });
  }

  /**
   * B-class recovery registration (system-design 4.3): pin the corrupt bytes,
   * land the recovered bytes as an append-only `.recovered` copy, and append
   * the registration line to recovery.jsonl — the corrupt original is never
   * touched. The human supplies the recovered bytes from an external snapshot
   * (backup / shared repo / team git); the hub never fetches backups itself.
   * Registration is refused unless (a) the original exists and actually fails
   * artifact validation, and (b) the recovered copy passes the SAME
   * validation with the version matching the file name and the task — so a
   * successful registration always un-degrades the task on the next fold.
   * Tampering later (original modified, copy edited) voids the registration
   * at consumption time via the digest chain.
   *
   * Two-phase commit: the copy lands first, the registration
   * line commits second. A failure between the two (manifest I/O error) used
   * to leave an unregistered orphan copy that every retry hit as a FINAL
   * once-only EEXIST — a permanent brick built by the repair tool itself.
   * Now a retry re-reads the manifest: with no registration line for the
   * file, an existing copy whose bytes hash-match the supplied source is
   * ADOPTED and the registration completes; only a copy with DIFFERENT bytes
   * (or a completed registration) is refused — the append-only copy is never
   * rewritten, and no second inconsistent copy is ever created.
   */
  async recoverRecord(taskId: string, input: RecoverRecordInput): Promise<RecoverRecordResult> {
    requireNonEmptyString(taskId, "task_id");
    requireValidTaskId(taskId);
    const recordFile = requireNonEmptyString(input?.record_file, "record_file");
    if (recordFileVersion(recordFile) === null || recordFile.includes("/") || recordFile.includes("\\")) {
      throw new StoreError(
        ErrorCode.VALIDATION_ERROR,
        `record_file must be a record file name like v003.note.json within the task directory: ${recordFile}`,
      );
    }
    const fromPath = requireNonEmptyString(input?.from_path, "from_path");
    const source = input?.source !== undefined ? requireNonEmptyString(input.source, "source") : undefined;

    return this.enqueue(taskId, async () => {
      if (!(await this.dirExists(this.taskDir(taskId)))) {
        throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);
      }

      // The original must exist and actually be corrupt — recovery pins bad
      // bytes; registering a healthy (or missing) file has nothing to pin.
      // "Corrupt" is the SAME artifact validation the fold applies: a
      // syntactically-valid but structurally-invalid record is just as
      // unrecoverable for derive as broken JSON.
      const originalPath = path.join(this.taskDir(taskId), recordFile);
      let originalBytes: Buffer;
      try {
        originalBytes = await readFile(originalPath);
      } catch (e) {
        throw new StoreError(
          ErrorCode.VALIDATION_ERROR,
          `record ${recordFile} is missing or unreadable — recovery registration pins existing corrupt bytes: ${(e as Error).message}`,
        );
      }
      const corruptSha = sha256(originalBytes);
      let originalHealthy = true;
      try {
        // Directory identity included: a JSON-valid
        // record belonging to ANOTHER task is corruption for THIS directory
        // — the same verdict the fold's readRecords reaches. Without taskId
        // this check judged such originals healthy ("parses — nothing to
        // recover") and the task could never leave degradation.
        validateRecordArtifact(JSON.parse(originalBytes.toString("utf8")), originalPath, taskId);
      } catch {
        originalHealthy = false; // SyntaxError or structural StoreError — corrupt, exactly what recovery is for.
      }
      if (originalHealthy) {
        throw new StoreError(ErrorCode.VALIDATION_ERROR, `record ${recordFile} parses — nothing to recover`);
      }

      // Recovered bytes come from the human's external snapshot and must pass
      // the same artifact validation as a landed record (a
      // malformed source would register a stand-in the fold must reject).
      let recoveredBytes: Buffer;
      try {
        recoveredBytes = await readFile(fromPath);
      } catch (e) {
        throw new StoreError(
          ErrorCode.VALIDATION_ERROR,
          `cannot read recovery source ${fromPath}: ${(e as Error).message}`,
        );
      }
      const expectedVersion = recordFileVersion(recordFile)!;
      let recoveredRecord: ContextRecord;
      try {
        recoveredRecord = validateRecordArtifact(JSON.parse(recoveredBytes.toString("utf8")), fromPath);
      } catch (e) {
        const detail = e instanceof StoreError ? e.message : `not parseable JSON: ${(e as Error).message}`;
        throw new StoreError(ErrorCode.VALIDATION_ERROR, `recovery source ${fromPath} is not a well-formed record (${detail})`);
      }
      if (recoveredRecord.version !== expectedVersion || recoveredRecord.task_id !== taskId) {
        throw new StoreError(
          ErrorCode.VALIDATION_ERROR,
          `recovery source ${fromPath} does not match ${recordFile} of ${taskId}: expected version ${expectedVersion} / task_id ${taskId}, ` +
            `got version ${String(recoveredRecord.version)} / task_id ${String(recoveredRecord.task_id)}`,
        );
      }

      // Phase 0 — read the manifest BEFORE anything lands this call: a
      // completed registration line for this file is the once-only verdict
      // (the line is the commit point; a copy without its line is not final).
      const entries = await this.readRecoveryEntries(taskId);
      if (entries.some((entry) => entry.file === recordFile)) {
        throw new StoreError(
          ErrorCode.VALIDATION_ERROR,
          `recovered copy already exists for ${recordFile} — registration is once-only (recovery.jsonl and *.recovered are append-only)`,
        );
      }

      // Phase 1 — land the append-only copy: exclusive create, never
      // rewritten, never deleted. EEXIST is no longer a blind refusal: with
      // no registration line it is an orphan from an interrupted earlier
      // attempt, adopted iff its bytes are exactly what we are about to
      // register (adopting anything else would pin a false digest).
      const recoveredFile = `${recordFile}.recovered`;
      try {
        await this.writeRecordExclusive(taskId, recoveredFile, recoveredBytes);
      } catch (e) {
        if (e instanceof StoreError && e.code === ErrorCode.VERSION_CONFLICT) {
          let orphanBytes: Buffer;
          try {
            orphanBytes = await readFile(path.join(this.taskDir(taskId), recoveredFile));
          } catch (e2) {
            throw new StoreError(
              ErrorCode.VALIDATION_ERROR,
              `unregistered recovered copy ${recoveredFile} exists but is unreadable — resolve manually (append-only, never delete): ${(e2 as Error).message}`,
            );
          }
          if (sha256(orphanBytes) !== sha256(recoveredBytes)) {
            throw new StoreError(
              ErrorCode.VALIDATION_ERROR,
              `recovered copy ${recoveredFile} already exists with DIFFERENT bytes and no registration — the append-only copy cannot be rewritten, ` +
                `and the supplied source ${fromPath} does not match it; resolve the mismatch manually (never delete the copy)`,
            );
          }
          // Byte-identical orphan from an interrupted attempt — adopt it and
          // complete the registration below.
        } else {
          throw e;
        }
      }

      // Phase 2 — the registration line: the commit point of the recovery.
      const entry: RecoveryEntry = {
        seq: entries.length + 1,
        file: recordFile,
        corrupt_sha256: corruptSha,
        recovered_sha256: sha256(recoveredBytes),
        recovered_file: recoveredFile,
        source: source ?? "",
        registered_at: new Date().toISOString(),
      };
      await this.appendRecoveryLine(taskId, JSON.stringify(entry));
      return { task_id: taskId, record_file: recordFile, seq: entry.seq, recovered_file: recoveredFile };
    });
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

  /**
   * In-process async mutex serializing meta read-modify-write operations.
   * Two lanes: a GLOBAL queue for slug-reserving mutations
   * (createTask — slug uniqueness is a cross-task property) and PER-TASK
   * queues for everything else (append / repairMeta / recoverRecord): two
   * different tasks' writes no longer queue behind each other. Reads are
   * never queued (unchanged) — atomic rename/link keeps them consistent.
   */
  private enqueue<T>(key: string | null, op: () => Promise<T>): Promise<T> {
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
      entries = await readdir(this.tasksDir(), { withFileTypes: true });
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return { tasks: [], degraded: [] };
      throw e;
    }
    const out: TaskListEntry[] = [];
    const degraded: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      if (!TASK_ID_PATTERN.test(taskId)) continue; // foreign dir names never resolve to a task path
      let meta: TaskMeta | null = null;
      let metaOk = true;
      try {
        meta = await this.readMeta(taskId);
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
      const names = await this.taskDirNames(taskId);
      if (taskId === PROJECT_TASK_ID) {
        let recordsOk = true;
        try {
          await this.probeRecords(taskId, names); // project carries no derivation; this is a (cached) health probe only
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
      let derived: ReturnType<typeof derive> | null;
      try {
        derived = await this.derivedFor(taskId, meta.flow, names);
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
    return validateMetaArtifact(parseJsonFile(raw, this.metaPath(taskId)), this.metaPath(taskId), taskId);
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
  private async writeRecordExclusive(taskId: string, fileName: string, content: string | Buffer): Promise<void> {
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

  /**
   * Task directory name list (readdir). Missing directory → [] — the same
   * tolerance readRecords always had (a vanished task reads as an empty
   * sequence, never an error).
   */
  private async taskDirNames(taskId: string): Promise<string[]> {
    try {
      return await readdir(this.taskDir(taskId));
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return [];
      throw e;
    }
  }

  /** Max record version present as a file in the task dir (0 when none) — crash-window reconciliation. */
  private async maxOnDiskRecordVersion(taskId: string): Promise<number> {
    return maxRecordVersionOf(await this.taskDirNames(taskId));
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
  private async foldCursorFor(
    taskId: string,
    flow: Flow,
    names: readonly string[],
    alreadyRead: ReadonlyMap<string, ContextRecord> = new Map(),
  ): Promise<FoldCursor> {
    const token = foldTokenOf(names);
    const cached = this.foldCache.get(taskId);
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
            : (await this.readNamedRecordsPaired(taskId, unread)).map(({ name, record }) => [name, record]),
        );
        const fresh = additions.map((name) => readByName.get(name) ?? loaded.get(name)!);
        const folded = foldOntoCursor(cached.cursor, fresh, flow);
        const next: FoldCursor = { status: folded.status, prevVersion: folded.prevVersion, warnings: folded.warnings };
        this.foldCache.set(taskId, { token, cursor: next, probeMaxVersion: next.prevVersion });
        return next;
      }
    }

    // Cold path: read every fold-relevant record name and fold.
    const recordNames = names.filter((name) => recordFileVersion(name) !== null);
    const unread = recordNames.filter((name) => !readByName.has(name));
    const loaded = new Map(
      unread.length === 0
        ? []
        : (await this.readNamedRecordsPaired(taskId, unread)).map(({ name, record }) => [name, record]),
    );
    const records = recordNames.map((name) => readByName.get(name) ?? loaded.get(name)!);
    const folded = foldOntoCursor(initialCursor(flow), records, flow);
    const cursor: FoldCursor = { status: folded.status, prevVersion: folded.prevVersion, warnings: folded.warnings };
    this.foldCache.set(taskId, { token, cursor, probeMaxVersion: cursor.prevVersion });
    return cursor;
  }

  /**
   * Project-scope health probe (no derivation), cache-aware exactly like
   * foldCursorFor: token hit → nothing read; record-file extension beyond
   * probeMaxVersion → only the additions validated; else cold validation of
   * every record name. Throws VALIDATION_ERROR on unrecovered corruption.
   */
  private async probeRecords(taskId: string, names: readonly string[]): Promise<void> {
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
        if (additions.length > 0) await this.readNamedRecords(taskId, additions); // validation only
        this.foldCache.set(taskId, {
          token,
          cursor: null,
          probeMaxVersion: Math.max(cached.probeMaxVersion, maxRecordVersionOf(additions)),
        });
        return;
      }
    }

    const namesToRead = recordNames();
    if (namesToRead.length > 0) await this.readNamedRecords(taskId, namesToRead); // validation only
    this.foldCache.set(taskId, { token, cursor: null, probeMaxVersion: maxRecordVersionOf(namesToRead) });
  }

  /** Derived state for a task from the cache-aware fold (null for project scope). */
  private async derivedFor(
    taskId: string,
    flow: Flow | undefined,
    names: readonly string[],
    alreadyRead: ReadonlyMap<string, ContextRecord> = new Map(),
  ): Promise<ReturnType<typeof derive> | null> {
    if (taskId === PROJECT_TASK_ID) return null;
    const cursor = await this.foldCursorFor(taskId, flow ?? "full", names, alreadyRead);
    const needsAttention = cursor.warnings.length > 0;
    return {
      status: cursor.status,
      waiting_for: needsAttention ? "human" : WAITING_FOR_BASE[cursor.status],
      needs_attention: needsAttention,
      warnings: cursor.warnings,
    };
  }

  /** Extend a project-scope probe cache entry by one just-landed file name. */
  private rememberFoldToken(taskId: string, names: readonly string[], fileName: string): void {
    const cached = this.foldCache.get(taskId);
    if (cached === undefined || cached.cursor !== null) return; // only project probe entries update this way
    if (cached.token !== foldTokenOf(names)) return; // stale entry — let the next read rebuild
    this.foldCache.set(taskId, {
      token: foldTokenOf([...names, fileName]),
      cursor: null,
      probeMaxVersion: Math.max(cached.probeMaxVersion, recordFileVersion(fileName) ?? 0),
    });
  }

  /**
   * All record files of a task, sorted by version (derive never consumes timestamps).
   * Consumption is restricted to `v<digits>.<type>.json` names —
   * meta.json, recovery.jsonl, `*.recovered` copies, and foreign `.json`
   * files never fold. A record that fails to parse consults the recovery
   * registrations (system-design 4.3 B-class): the LAST registration for that
   * file stands in for the corrupt original iff the whole digest chain
   * verifies — original bytes still hash to corrupt_sha256 (post-hoc
   * modification voids the registration), the `.recovered` copy exists and
   * hashes to recovered_sha256, and the copy parses with the version matching
   * the file name. Any miss → the corruption is unrecovered and this throws
   * VALIDATION_ERROR (the task reports degraded through snapshotTasks; a
   * direct readTask tells the truth about the damage).
   */
  private async readRecords(taskId: string): Promise<ContextRecord[]> {
    const names = (await this.taskDirNames(taskId)).filter((name) => recordFileVersion(name) !== null);
    return await this.readNamedRecords(taskId, names);
  }

  /** Read + validate the given record file names (sorted by version), preserving WHICH file each record came from — callers that reuse records in a later fold must key them by the real name. The recovery chain applies per file exactly as in readRecords. */
  private async readNamedRecordsPaired(
    taskId: string,
    names: readonly string[],
  ): Promise<Array<{ name: string; record: ContextRecord }>> {
    const sorted = [...names].sort((a, b) => (recordFileVersion(a) ?? 0) - (recordFileVersion(b) ?? 0));
    const paired: Array<{ name: string; record: ContextRecord }> = [];
    const failures: StoreError[] = [];
    for (const name of sorted) {
      try {
        const version = recordFileVersion(name);
        if (version === null) continue;
        const filePath = path.join(this.taskDir(taskId), name);
        let bytes: Buffer;
        try {
          bytes = await readFile(filePath);
        } catch (e) {
          throw new StoreError(ErrorCode.VALIDATION_ERROR, `cannot read record ${filePath}: ${(e as Error).message}`);
        }
        let record: ContextRecord | null = null;
        let parseError: unknown = null;
        try {
          record = validateRecordArtifact(JSON.parse(bytes.toString("utf8")), filePath, taskId);
        } catch (e) {
          parseError = e; // broken JSON OR structurally invalid — either way unusable as-is
        }
        if (record === null) {
          record = await this.recoveredRecordFor(taskId, name, version, bytes);
          if (record === null) {
            const detail = parseError instanceof StoreError
              ? parseError.message
              : `corrupt JSON in ${filePath}: ${(parseError as Error).message}`;
            throw new StoreError(
              ErrorCode.VALIDATION_ERROR,
              `${detail} (no valid recovery registration — see tut recover-record / system-design 4.3)`,
            );
          }
        }
        paired.push({ name, record });
      } catch (error) {
        failures.push(
          error instanceof StoreError
            ? error
            : new StoreError(ErrorCode.VALIDATION_ERROR, `cannot validate record ${name}: ${(error as Error).message}`),
        );
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new StoreError(
        ErrorCode.VALIDATION_ERROR,
        `${failures.length} record files are invalid: ${failures.map((failure) => failure.message).join("; ")}`,
      );
    }
    return paired;
  }

  /** readNamedRecordsPaired without the names (consumers that never reuse). */
  private async readNamedRecords(taskId: string, names: readonly string[]): Promise<ContextRecord[]> {
    return (await this.readNamedRecordsPaired(taskId, names)).map((p) => p.record);
  }

  /** Parse recovery.jsonl (absent file → []). Malformed lines are skipped: a line that cannot parse can satisfy no digest check. A manifest that exists but cannot be READ (permissions, a directory squatting on the name) is a diagnosable storage error, not an empty manifest — it becomes VALIDATION_ERROR so the task reports degraded with the cause instead of silently ignoring its registrations. */
  private async readRecoveryEntries(taskId: string): Promise<RecoveryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.taskDir(taskId), "recovery.jsonl"), "utf8");
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return [];
      throw new StoreError(
        ErrorCode.VALIDATION_ERROR,
        `cannot read recovery manifest ${path.join(this.taskDir(taskId), "recovery.jsonl")}: ${(e as Error).message}`,
      );
    }
    const entries: RecoveryEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as RecoveryEntry;
        if (
          typeof parsed.file === "string" &&
          typeof parsed.corrupt_sha256 === "string" &&
          typeof parsed.recovered_sha256 === "string" &&
          typeof parsed.recovered_file === "string"
        ) {
          entries.push(parsed);
        }
      } catch {
        // skip malformed line
      }
    }
    return entries;
  }

  /**
   * Append one registration line to recovery.jsonl — the commit point of a
   * B-class recovery. Torn-line heal: if the manifest's last
   * line lacks its trailing newline (a crash mid-append), the new line is
   * prefixed with one so the torn remnant can never swallow it — the commit
   * point must be all-or-nothing per line, and a retry after an interrupted
   * append must find BOTH lines valid.
   */
  private async appendRecoveryLine(taskId: string, line: string): Promise<void> {
    const manifestPath = path.join(this.taskDir(taskId), "recovery.jsonl");
    let prefix = "";
    try {
      const existing = await readFile(manifestPath, "utf8");
      if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
    } catch {
      // absent manifest — this line is the first; no prefix needed
    }
    await appendFile(manifestPath, prefix + line + "\n", "utf8");
  }

  /**
   * Digest-chain consumption for one corrupt record (system-design 4.3):
   * the LAST registration for the file wins; every check must pass or the
   * record stays unusable (null). Derivation remains a pure function of the
   * directory contents — records + registrations + copies are all inputs.
   */
  private async recoveredRecordFor(
    taskId: string,
    fileName: string,
    version: number,
    corruptBytes: Buffer,
  ): Promise<ContextRecord | null> {
    const entries = await this.readRecoveryEntries(taskId);
    let match: RecoveryEntry | undefined;
    for (const entry of entries) {
      if (entry.file === fileName) match = entry; // last registration stands
    }
    if (match === undefined) return null;
    if (sha256(corruptBytes) !== match.corrupt_sha256) return null; // original touched after registration → registration void
    let copyBytes: Buffer;
    try {
      copyBytes = await readFile(path.join(this.taskDir(taskId), match.recovered_file));
    } catch {
      return null;
    }
    if (sha256(copyBytes) !== match.recovered_sha256) return null;
    try {
      // Same artifact validation as a directly-read record:
      // a registration whose copy is structurally garbage registers nothing.
      const record = validateRecordArtifact(JSON.parse(copyBytes.toString("utf8")), match.recovered_file, taskId);
      if (record.version === version) return record;
    } catch {
      // fall through
    }
    return null;
  }

  private cacheDerived(meta: TaskMeta, derived: ReturnType<typeof derive> | null): void {
    if (!derived) return;
    meta.status = derived.status;
    meta.waiting_for = derived.waiting_for;
    meta.needs_attention = derived.needs_attention;
    meta.warnings = derived.warnings;
  }
}

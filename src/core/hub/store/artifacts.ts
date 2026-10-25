/** Internal artifact shapes and validation. Public compatibility exports live in ../store.ts. */

import { createHash } from "node:crypto";
import {
  ErrorCode,
  type Cast,
  type CheckoutRoute,
  type ContextRecord,
  type ContentType,
  type Flow,
  type Payload,
  type Status,
  type WaitingFor,
  type Warning,
} from "../../common/types.js";
import { AgentCommandError, validateAgentRoute } from "../../common/agent-command.js";

/** Single error constructor shared by every internal module and the public facade. */
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
  warning?: string;
  needs_attention?: boolean;
  warnings?: Warning[];
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
  pending_since?: string | null;
  round_count?: number;
  warnings?: Warning[];
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

/** One recovery.jsonl registration line (system-design 4.3 record-recovery protocol). */
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

/** POST /repair-meta input: human-supplied rebuild fields for a corrupt meta (system-design 4.3 meta-rebuild). */
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

/** POST /recover-record input (system-design 4.3 record-recovery registration). */
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
export interface TaskMeta {
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

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `${field} must be a non-empty string`);
  }
  return value;
}

/** Create-time flow validation: the value selects a transition table, so it must be a known one. */
export function requireValidFlow(value: unknown): Flow {
  if (value !== undefined && value !== "full" && value !== "direct" && value !== "solo") {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `flow must be full, direct, or solo: ${String(value)}`);
  }
  return value as Flow;
}

export const CAST_ROLES = ["architect", "executor", "reviewer"] as const;

/** Create-time cast validation: role keys limited to the three convention roles. */
export function requireValidCast(value: unknown): Cast | undefined {
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
export function requireValidCheckout(value: unknown): CheckoutRoute | undefined {
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
 * New IDs exclude dots, the task/role label separator. Retain the historical
 * on-disk alphabet for reading, appending and repairing existing tasks.
 * Both patterns accept "project" and block separators at public entry points:
 * path traversal — "../evil" / "../../outside" must never reach path.join
 * against the store root (blocks path traversal).
 */
export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// Historical dotted IDs remain readable/appendable; never use this for new IDs.
export const LEGACY_TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function requireValidTaskId(taskId: string, pattern = LEGACY_TASK_ID_PATTERN): void {
  if (!pattern.test(taskId)) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `task_id must match ${pattern.source}: ${taskId}`);
  }
}

/** lowercase, hyphen-separated; reserved word "project" never returned as-is. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "task";
}

export function shortSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/** Filename-safe content_type: "a/b" → "a-b". */
export function sanitizeContentType(contentType: string): string {
  const sanitized = contentType.replace(/[^a-zA-Z0-9._-]/g, "-");
  return sanitized.length > 0 ? sanitized : "record";
}

export function recordFileName(version: number, contentType: string): string {
  return `v${String(version).padStart(3, "0")}.${sanitizeContentType(contentType)}.json`;
}

export function isErrnoException(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}

export function sha256(bytes: Buffer): string {
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
export function parseJsonFile<T>(raw: string, filePath: string): T {
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

/** Max record version among a name list (0 when none). */
export function maxRecordVersionOf(names: readonly string[]): number {
  let max = 0;
  for (const name of names) {
    const version = recordFileVersion(name);
    if (version !== null) max = Math.max(max, version);
  }
  return max;
}

/** Internal recovery actions. The facade supplies admission to its single per-task queue. */

import path from "node:path";
import { ErrorCode, PROJECT_TASK_ID, type ContextRecord } from "../../common/types.js";
import { TASK_SPEC_HEADINGS } from "../../common/task-spec.js";
import { foldWithLint } from "../record-lint.js";
import { initialCursor } from "../state-machine.js";
import {
  StoreError,
  type TaskMeta,
  type RecoveryEntry,
  type RepairMetaInput,
  type RepairMetaResult,
  type RecoverRecordInput,
  type RecoverRecordResult,
  TASK_ID_PATTERN,
  LEGACY_TASK_ID_PATTERN,
  requireNonEmptyString,
  requireValidTaskId,
  requireValidFlow,
  requireValidCast,
  requireValidCheckout,
  isErrnoException,
  recordFileVersion,
  sha256,
  validateRecordArtifact,
} from "./artifacts.js";
import type { RecordIO } from "./record-io.js";
import { cacheDerived, type FoldCache } from "./fold-cache.js";

/**
 * meta-rebuild recovery (system-design 4.3): rebuild a corrupt/missing meta.json
 * through the store's supported entry (HTTP POST /repair-meta). version is
 * SERVER-computed from the max on-disk record version (the same source the
 * append crash-window reconciliation uses) — caller input is not accepted,
 * so a rebuild can never clobber orphan records. Title/flow/etc. come from
 * the caller (the human's best available archive: notifier snapshots, read
 * responses, notes); unavailable fields fall back per design (title →
 * task_id, flow → full, created_at → repair time). Refuses a readable meta
 * (repair is not an overwrite path). If the records themselves are damaged
 * the rebuild still lands (operation state fixed) but no derived cache is
 * written — the task stays degraded until the record recovery resolves.
 */
export async function repairMeta(
  io: RecordIO,
  foldCache: FoldCache,
  taskId: string,
  input: RepairMetaInput,
  enqueue: (operation: () => Promise<RepairMetaResult>) => Promise<RepairMetaResult>,
): Promise<RepairMetaResult> {
  requireNonEmptyString(taskId, "task_id");
  // Validate path safety before inspecting disk; only an existing legacy
  // directory may opt out of the new-ID pattern.
  requireValidTaskId(taskId, LEGACY_TASK_ID_PATTERN);
  const pattern = taskId.includes(".") && await io.dirExists(io.taskDir(taskId))
    ? LEGACY_TASK_ID_PATTERN : TASK_ID_PATTERN;
  requireValidTaskId(taskId, pattern);
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

  return enqueue(async () => {
    if (!(await io.dirExists(io.taskDir(taskId)))) {
      throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);
    }
    // The repair door is for BROKEN meta only — a readable meta must not be
    // overwritten through it (create-time fields are immutable; a "repair"
    // of healthy operation state would be a rogue write path).
    let readable: TaskMeta | null = null;
    let broken = false;
    try {
      readable = await io.readMeta(taskId);
    } catch (e) {
      if (e instanceof StoreError && e.code === ErrorCode.VALIDATION_ERROR) broken = true;
      else throw e;
    }
    // Structural damage must not open a write door into a surviving frozen scope.
    let originalDescription: unknown;
    try {
      const raw: unknown = JSON.parse(await io.readText(io.metaPath(taskId)));
      if (raw !== null && typeof raw === "object" && "description" in raw) {
        originalDescription = raw.description;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isErrnoException(error, "ENOENT")) throw error;
    }
    const frozen = typeof originalDescription === "string" &&
      TASK_SPEC_HEADINGS.every(
        (heading) => originalDescription.split(/\r?\n/u).some((line) => line.trimEnd() === `## ${heading}`),
      );
    if (frozen && description !== undefined && description !== originalDescription) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR,
        "description has a frozen four-section scope — create a new task for scope changes (范围变更请新建任务)");
    }
    if (!broken && readable !== null) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, `meta.json of ${taskId} is readable — nothing to repair`);
    }
    const repairedDescription = frozen ? originalDescription as string : description;

    const now = new Date().toISOString();
    const version = await io.maxOnDiskRecordVersion(taskId); // server-computed, never caller input
    // A rebuild may select a DIFFERENT flow than the damaged meta carried —
    // flow selects the transition table, so any cached cursor folded under
    // the old flow is void (cache discipline: token cannot see meta).
    foldCache.delete(taskId);
    const meta: TaskMeta = {
      task_id: taskId,
      title: isProject ? PROJECT_TASK_ID : (title ?? taskId),
      ...(repairedDescription !== undefined ? { description: repairedDescription } : {}),
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
        cacheDerived(meta, foldWithLint(initialCursor(meta.flow ?? "full"), await io.readRecords(taskId), meta.flow ?? "full", meta.description));
      } catch (e) {
        // Records damaged too — meta rebuild lands (A fixed), the task stays
        // degraded until record recovery resolves the records (4.3).
        process.stderr.write(
          `tut: warning: ${taskId} meta rebuilt but records still fail to fold (${(e as Error).message}); task remains degraded\n`,
        );
      }
    }
    await io.writeMeta(taskId, meta);
    return {
      task_id: taskId,
      version,
      ...(meta.status !== undefined ? { status: meta.status } : {}),
    };
  });
}

/**
 * record-recovery registration (system-design 4.3): pin the corrupt bytes,
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
export async function recoverRecord(
  io: RecordIO,
  taskId: string,
  input: RecoverRecordInput,
  enqueue: (operation: () => Promise<RecoverRecordResult>) => Promise<RecoverRecordResult>,
): Promise<RecoverRecordResult> {
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

  return enqueue(async () => {
    if (!(await io.dirExists(io.taskDir(taskId)))) {
      throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);
    }

    // The original must exist and actually be corrupt — recovery pins bad
    // bytes; registering a healthy (or missing) file has nothing to pin.
    // "Corrupt" is the SAME artifact validation the fold applies: a
    // syntactically-valid but structurally-invalid record is just as
    // unrecoverable for derive as broken JSON.
    const originalPath = path.join(io.taskDir(taskId), recordFile);
    let originalBytes: Buffer;
    try {
      originalBytes = await io.readBytes(originalPath);
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
      recoveredBytes = await io.readBytes(fromPath);
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
    const entries = await io.readRecoveryEntries(taskId);
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
      await io.writeRecordExclusive(taskId, recoveredFile, recoveredBytes);
    } catch (e) {
      if (e instanceof StoreError && e.code === ErrorCode.VERSION_CONFLICT) {
        let orphanBytes: Buffer;
        try {
          orphanBytes = await io.readBytes(path.join(io.taskDir(taskId), recoveredFile));
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
    await io.appendRecoveryLine(taskId, JSON.stringify(entry));
    return { task_id: taskId, record_file: recordFile, seq: entry.seq, recovered_file: recoveredFile };
  });
}

/**
 * Digest-chain consumption for one corrupt record (system-design 4.3):
 * the LAST registration for the file wins; every check must pass or the
 * record stays unusable (null). Derivation remains a pure function of the
 * directory contents — records + registrations + copies are all inputs.
 */
export async function recoveredRecordFor(
  io: RecordIO,
  taskId: string,
  fileName: string,
  version: number,
  corruptBytes: Buffer,
): Promise<ContextRecord | null> {
  const entries = await io.readRecoveryEntries(taskId);
  let match: RecoveryEntry | undefined;
  for (const entry of entries) {
    if (entry.file === fileName) match = entry; // last registration stands
  }
  if (match === undefined) return null;
  if (sha256(corruptBytes) !== match.corrupt_sha256) return null; // original touched after registration → registration void
  let copyBytes: Buffer;
  try {
    copyBytes = await io.readBytes(path.join(io.taskDir(taskId), match.recovered_file));
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

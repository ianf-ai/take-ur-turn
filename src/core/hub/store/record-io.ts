/** Internal file operations. Store owns all mutation admission and queues; callers must use Store. */

import { appendFile, link, lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { type Dirent } from "node:fs";
import path from "node:path";
import { ErrorCode, type ContextRecord } from "../../common/types.js";
import {
  StoreError,
  type TaskMeta,
  type RecoveryEntry,
  isErrnoException,
  maxRecordVersionOf,
  parseJsonFile,
  recordFileVersion,
  requireValidTaskId,
  validateMetaArtifact,
  validateRecordArtifact,
} from "./artifacts.js";
import { recoveredRecordFor } from "./recovery.js";

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

export async function sweepTempFiles(tasksDir: string): Promise<void> {
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

/** @internal Never instantiate outside the Store implementation. */
export class RecordIO {
  constructor(private readonly root: string) {}

  async ensureTasksDir(): Promise<void> {
    await mkdir(this.tasksDir(), { recursive: true });
  }

  async ensureTaskDir(taskId: string): Promise<void> {
    await mkdir(this.taskDir(taskId), { recursive: true });
  }

  taskEntries(): Promise<Dirent[]> {
    return readdir(this.tasksDir(), { withFileTypes: true });
  }

  readBytes(filePath: string): Promise<Buffer> {
    return readFile(filePath);
  }

  readText(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  }

  // --- internals -----------------------------------------------------------

  tasksDir(): string {
    return path.join(this.root, "tasks");
  }

  taskDir(taskId: string): string {
    return path.join(this.tasksDir(), taskId);
  }

  metaPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "meta.json");
  }

  // Slug allocation must avoid every occupied entry, including dangling links.
  // Repair eligibility separately requires an actual directory.
  async entryExists(p: string): Promise<boolean> {
    try {
      await lstat(p);
      return true;
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return false;
      throw e;
    }
  }

  async dirExists(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isDirectory();
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return false;
      throw e;
    }
  }

  async readMeta(taskId: string): Promise<TaskMeta | null> {
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
  async writeMeta(taskId: string, meta: TaskMeta): Promise<void> {
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
  async writeRecordExclusive(taskId: string, fileName: string, content: string | Buffer): Promise<void> {
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
  async taskDirNames(taskId: string): Promise<string[]> {
    try {
      return await readdir(this.taskDir(taskId));
    } catch (e) {
      if (isErrnoException(e, "ENOENT")) return [];
      throw e;
    }
  }

  /** Max record version present as a file in the task dir (0 when none) — crash-window reconciliation. */
  async maxOnDiskRecordVersion(taskId: string): Promise<number> {
    return maxRecordVersionOf(await this.taskDirNames(taskId));
  }

  /**
   * All record files of a task, sorted by version (derive never consumes timestamps).
   * Consumption is restricted to `v<digits>.<type>.json` names —
   * meta.json, recovery.jsonl, `*.recovered` copies, and foreign `.json`
   * files never fold. A record that fails to parse consults the recovery
   * registrations (system-design 4.3 record-recovery): the LAST registration for that
   * file stands in for the corrupt original iff the whole digest chain
   * verifies — original bytes still hash to corrupt_sha256 (post-hoc
   * modification voids the registration), the `.recovered` copy exists and
   * hashes to recovered_sha256, and the copy parses with the version matching
   * the file name. Any miss → the corruption is unrecovered and this throws
   * VALIDATION_ERROR (the task reports degraded through snapshotTasks; a
   * direct readTask tells the truth about the damage).
   */
  async readRecords(taskId: string): Promise<ContextRecord[]> {
    const names = (await this.taskDirNames(taskId)).filter((name) => recordFileVersion(name) !== null);
    return await this.readNamedRecords(taskId, names);
  }

  /** Read + validate the given record file names (sorted by version), preserving WHICH file each record came from — callers that reuse records in a later fold must key them by the real name. The recovery chain applies per file exactly as in readRecords. */
  async readNamedRecordsPaired(
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
          record = await recoveredRecordFor(this, taskId, name, version, bytes);
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
  async readNamedRecords(taskId: string, names: readonly string[]): Promise<ContextRecord[]> {
    return (await this.readNamedRecordsPaired(taskId, names)).map((p) => p.record);
  }

  /** Parse recovery.jsonl (absent file → []). Malformed lines are skipped: a line that cannot parse can satisfy no digest check. A manifest that exists but cannot be READ (permissions, a directory squatting on the name) is a diagnosable storage error, not an empty manifest — it becomes VALIDATION_ERROR so the task reports degraded with the cause instead of silently ignoring its registrations. */
  async readRecoveryEntries(taskId: string): Promise<RecoveryEntry[]> {
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
   * record recovery. Torn-line heal: if the manifest's last
   * line lacks its trailing newline (a crash mid-append), the new line is
   * prefixed with one so the torn remnant can never swallow it — the commit
   * point must be all-or-nothing per line, and a retry after an interrupted
   * append must find BOTH lines valid.
   */
  async appendRecoveryLine(taskId: string, line: string): Promise<void> {
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

  /** Usage audit sidecar, through the Store boundary; never repairs or writes. */
  async readUsage(taskId: string): Promise<unknown | null> {
    requireValidTaskId(taskId);
    const file = path.join(this.taskDir(taskId), "usage.json");
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe usage file");
      return JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) return null;
      throw error;
    }
  }

  /** Raw usage sidecar for HTTP readers; preserve every byte, without aggregation. */
  async readUsageRaw(taskId: string): Promise<Buffer> {
    requireValidTaskId(taskId);
    if (!await this.readMeta(taskId)) {
      throw new StoreError(ErrorCode.TASK_NOT_FOUND, `task not found: ${taskId}`);
    }
    const file = path.join(this.taskDir(taskId), "usage.json");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe usage file");
    return readFile(file);
  }
}

/** Internal closed-task disposal. Store supplies the mutation queues. */
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { ErrorCode } from "../../protocol/types.js";
import { StoreError, isErrnoException } from "./artifacts.js";
import type { RecordIO } from "./record-io.js";

export interface PruneTaskInput {
  by: string;
  reason: string;
  /** Absolute archive parent directory; the copy lands at <archive>/<task_id>. */
  archive?: string;
}

export interface PruneTaskResult {
  prune_id: string;
  task_id: string;
  timestamp: string;
  by: string;
  reason: string;
  archive?: string;
}

export interface PruneEvent {
  task_id: string;
  event_id: string;
  in_progress?: boolean;
}

/** Resolve aliases even when the last path components do not exist yet. */
async function prospectiveRealpath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) throw error;
    return path.join(await prospectiveRealpath(path.dirname(target)), path.basename(target));
  }
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Pruned identities stay reserved so surviving run references cannot alias new tasks. */
export async function prunedTaskIds(io: RecordIO): Promise<Set<string>> {
  return new Set((await pruneEvents(io)).map(event => event.task_id));
}

/** Latest identifiable intent per task, separate from permanent ID reservation. */
export async function pruneEvents(io: RecordIO): Promise<PruneEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(io.tasksDir(), ".pruned.jsonl"), "utf8");
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return [];
    throw error;
  }
  const events = new Map<string, PruneEvent>();
  for (const [index, line] of raw.split("\n").entries()) {
    try {
      const entry: unknown = JSON.parse(line);
      if (entry !== null && typeof entry === "object" && "task_id" in entry && typeof entry.task_id === "string") {
        // Old intents have no UUID. Their immutable line position and bytes
        // still distinguish retries, including identical timestamped lines.
        const eventId = "prune_id" in entry && typeof entry.prune_id === "string" && entry.prune_id.length > 0
          ? entry.prune_id : createHash("sha256").update(`${index}:${line}`).digest("hex");
        events.set(entry.task_id, { task_id: entry.task_id, event_id: eventId });
      }
    } catch {
      // Preserve interrupted lines on disk; only complete JSON reserves an ID.
    }
  }
  return [...events.values()];
}

/** Durable append BEFORE removal; an entry records intent, including failed attempts. */
async function appendIntent(io: RecordIO, entry: PruneTaskResult): Promise<void> {
  const manifest = path.join(io.tasksDir(), ".pruned.jsonl");
  try {
    const info = await lstat(manifest);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("manifest must be a regular file");
  } catch (error) {
    if (!isErrnoException(error, "ENOENT")) throw error;
  }
  const file = await open(manifest, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const { size } = await file.stat();
    const last = Buffer.alloc(1);
    if (size > 0) await file.read(last, 0, 1, size - 1);
    const prefix = size > 0 && last[0] !== 10 ? "\n" : "";
    await file.writeFile(prefix + JSON.stringify(entry) + "\n", "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function disposeTask(io: RecordIO, taskId: string, input: PruneTaskInput, beforeRemove: () => void, onIntent: (id: string) => void): Promise<PruneTaskResult> {
  const source = io.taskDir(taskId);
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, "prune requires a real task directory, not a symlink");
  }
  let archive: string | undefined;
  if (input.archive !== undefined) {
    try {
      const archiveParent = await prospectiveRealpath(input.archive);
      const hub = await realpath(path.dirname(io.tasksDir()));
      if (within(hub, archiveParent)) throw new Error("archive must be outside the Hub storage directory");
      await mkdir(archiveParent, { recursive: true });
      archive = path.join(archiveParent, taskId);
      // Exclusive reservation: never merge into or overwrite an existing archive.
      await mkdir(archive, { mode: info.mode });
      for (const name of await readdir(source)) {
        await cp(path.join(source, name), path.join(archive, name), {
          recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
        });
      }
    } catch (error) {
      throw new StoreError(ErrorCode.VALIDATION_ERROR, `archive failed; task retained (any partial copy is retained too): ${(error as Error).message}`);
    }
  }
  const entry: PruneTaskResult = {
    prune_id: randomUUID(),
    task_id: taskId, timestamp: new Date().toISOString(), by: input.by, reason: input.reason,
    ...(archive !== undefined ? { archive } : {}),
  };
  onIntent(entry.prune_id);
  try {
    await appendIntent(io, entry);
  } catch (error) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `cannot append prune manifest; task retained: ${(error as Error).message}`);
  }
  try {
    beforeRemove();
    await rm(source, { recursive: true });
  } catch (error) {
    throw new StoreError(ErrorCode.VALIDATION_ERROR, `prune intent recorded but removal failed; inspect task before retrying: ${(error as Error).message}`);
  }
  return entry;
}

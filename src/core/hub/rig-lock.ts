/** Local startup coordination only; this is not a lock on Hub records. */
import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export function acquireRigStartLock(root: string): () => void {
  const directory = path.join(root, ".context-hub");
  const file = path.join(directory, "up.lock");
  mkdirSync(directory, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  for (;;) {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: string;
      let identity: ReturnType<typeof statSync>;
      try {
        identity = statSync(file);
        previous = readFileSync(file, "utf8");
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      let pid: number;
      try {
        const record = JSON.parse(previous);
        if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.started_at !== "string") throw new Error();
        pid = record.pid;
      } catch {
        throw new Error(`cannot verify startup lock ${file}; another up may be initializing it — retry, or inspect the lock before removing it`);
      }
      let alive = true;
      try { process.kill(pid, 0); }
      catch (probeError) {
        // EPERM and unknown failures cannot establish that the owner died.
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error(`another up (pid ${pid}) is provisioning workspace ${root}; wait for it to finish; if you confirm no other tut up instance is running, remove the lock file ${file} and retry`);
      // Serialize stale retirement too: two processes must not both observe
      // the dead owner and then unlink each other's replacement. This guard
      // exists only for synchronous metadata operations, never provisioning.
      const reclaim = `${file}.reclaim`;
      try { mkdirSync(reclaim); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error(`startup lock recovery in progress for workspace ${root}; retry, or inspect ${reclaim} if recovery was interrupted`);
      }
      try {
        const current = statSync(file);
        if (current.ino !== identity.ino || current.dev !== identity.dev || readFileSync(file, "utf8") !== previous) continue;
        unlinkSync(file);
      } catch (removeError) {
        if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
      } finally {
        rmdirSync(reclaim);
      }
      continue;
    }
    try { writeFileSync(fd, owner); }
    catch (error) { unlinkSync(file); throw error; }
    finally { closeSync(fd); }
    return () => {
      try { if (readFileSync(file, "utf8") === owner) unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
  }
}

/** Process evidence shared by standalone start, reconciliation and cleanup. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { windowsStartToken } from "./windows.js";

/** Best-effort liveness probe; EPERM still means alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Group liveness: ESRCH = the whole recorded group is gone (leader and
 *  every member); EPERM = exists but foreign (conservative: alive). */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// --- process identitya live pid is not ownership) --------------------------

const execFileAsync = promisify(execFile);

/** Linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot) —
 *  stable for the life of the process, changes on pid reuse. */
async function procfsStartToken(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces and parens — the fields resume after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = fields[19]; // overall field 22
    return starttime !== undefined && starttime.length > 0 ? `procfs:${starttime}` : null;
  } catch {
    return null;
  }
}

/** macOS: `ps -p <pid> -lstart=` (absolute start timestamp, whitespace
 *  normalized) — the same stability properties on the BSD side. */
async function psStartToken(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 2_000 });
    const normalized = stdout.trim().replace(/\s+/g, " ");
    return normalized.length > 0 ? `ps:${normalized}` : null;
  } catch {
    return null;
  }
}

/** The current start fingerprint of a live pid, or null when this platform
 *  cannot derive one — null NEVER means mismatch; callers treat it as
 *  identity-unverifiable (the conservative branch). */
export async function processStartToken(pid: number): Promise<string | null> {
  if (process.platform === "win32") return windowsStartToken(pid);
  if (process.platform === "linux") return procfsStartToken(pid);
  if (process.platform === "darwin") return psStartToken(pid);
  return null;
}

/** True only when the live pid provably IS the recorded instance: a token
 *  was recorded, the platform can re-derive it, and both agree. */
export async function pidMatchesStartToken(pid: number, recorded: string | null | undefined): Promise<boolean> {
  if (recorded === null || recorded === undefined) return false;
  return (await processStartToken(pid)) === recorded;
}

/** The process group id of a live pid (POSIX): /proc field 5 on Linux,
 *  `ps -o pgid=` on macOS — Node exposes neither getpgrp nor getpgid. */
export async function processPgid(pid: number): Promise<number | null> {
  if (process.platform === "win32") return null; // Windows has no POSIX pgid.
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const pgrp = Number(fields[2]); // overall field 5
      return Number.isSafeInteger(pgrp) && pgrp > 0 ? pgrp : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="], { timeout: 2_000 });
    const pgid = Number(stdout.trim());
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { windowsListenerPid } from "./windows.js";

const exec = promisify(execFile);

/** Kernel socket ownership, not a PID claimed by an HTTP responder. Ambiguous
 * listeners (including different bind addresses) deliberately fail closed. */
export async function listenerPid(port: number): Promise<number> {
  if (process.platform === "win32") return windowsListenerPid(port);
  const pids = new Set<number>();
  if (process.platform === "darwin") {
    const { stdout } = await exec("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 2_000 });
    for (const line of stdout.trim().split(/\s+/)) {
      if (/^\d+$/.test(line) && Number(line) > 0) pids.add(Number(line));
    }
  } else if (process.platform === "linux") {
    const inodes = new Set<string>();
    const observed = new Set<string>();
    for (const table of ["tcp", "tcp6"]) {
      const raw = await readFile(`/proc/net/${table}`, "utf8").catch(error => {
        if (table === "tcp6" && error.code === "ENOENT") return "";
        throw error;
      });
      for (const line of raw.trim().split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] === "0A" && parseInt(fields[1]!.split(":")[1]!, 16) === port && fields[9]) inodes.add(fields[9]);
      }
    }
    if (inodes.size) {
      for (const pid of (await readdir("/proc")).filter(name => /^\d+$/.test(name))) {
        const dir = `/proc/${pid}/fd`;
        for (const fd of await readdir(dir).catch(() => [] as string[])) {
          const target = await readlink(`${dir}/${fd}`).catch(() => "");
          if (target.startsWith("socket:[") && inodes.has(target.slice(8, -1))) {
            observed.add(target.slice(8, -1));
            pids.add(Number(pid));
          }
        }
      }
    }
    if (observed.size !== inodes.size) throw new Error(`cannot verify every listener owner on port ${port}; some socket owners are unreadable or changed`);
  } else {
    throw new Error("service adoption is supported only on macOS and Linux");
  }
  if (pids.size !== 1) throw new Error(`cannot identify a unique listener PID on port ${port} (found ${[...pids].join(", ") || "none"}); inspect the service manually`);
  return [...pids][0]!;
}

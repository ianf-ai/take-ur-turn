/** Kernel-enforced, read-only opens for run metadata and logs. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { release } from "node:os";

// Darwin ABI, present in macOS 11's XNU. Older kernels must fail closed.
// Node does not export it. Unlike O_NOFOLLOW it rejects *every* symlink in
// the kernel's pathname lookup, including an ancestor replaced during open.
// Do not combine the two flags: Darwin rejects that combination with EINVAL.
// https://github.com/apple-oss-distributions/xnu/blob/xnu-7195.50.7.100.1/bsd/sys/fcntl.h
const DARWIN_NOFOLLOW_ANY = 0x20000000;

/** Exported only as an internal OS seam; callers cannot request an unsafe fallback. */
export async function openRunFile(file: string, platform: NodeJS.Platform = process.platform, kernelRelease = release()): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK;
  if (platform === "darwin") {
    if (Number.parseInt(kernelRelease, 10) < 20 || !Number.isFinite(Number.parseInt(kernelRelease, 10))) {
      throw Object.assign(new Error("safe run file opens unavailable"), { code: "EUNSAFEPATH" });
    }
    return open(file, flags | DARWIN_NOFOLLOW_ANY);
  }
  if (platform !== "linux") throw Object.assign(new Error("safe run file opens unavailable"), { code: "EUNSAFEPATH" });

  // Linux has no O_NOFOLLOW_ANY in Node. Resolve one component at a time
  // relative to a held directory fd, never through the mutable parent path.
  // /proc/self/fd is kernel-owned; only that deliberate fd link is followed.
  // Renaming a directory cannot redirect subsequent lookups to its replacement.
  const parts = path.resolve(file).split(path.sep).filter(Boolean);
  const leaf = parts.pop()!;
  const dirs: FileHandle[] = [];
  let result: FileHandle | undefined;
  try {
    let dir = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    dirs.push(dir);
    for (const part of parts) {
      dir = await open(`/proc/self/fd/${dir.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      dirs.push(dir);
    }
    result = await open(`/proc/self/fd/${dir.fd}/${leaf}`, flags | constants.O_NOFOLLOW);
  } finally {
    // Keep all ancestors pinned until the leaf has opened; close on every exit.
    try { await Promise.all(dirs.map(dir => dir.close())); }
    catch (error) { await result?.close(); throw error; }
  }
  return result;
}

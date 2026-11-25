/** Cross-process config transaction mutex. Lock order: admission → config;
 * config transactions never acquire admission. Unknown/live owners are protected. */
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function lockConfig(file: string, waitMs = 5000): Promise<() => void> {
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const deadline = performance.now() + waitMs;
  const retryable = (error: unknown) => process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
  for (;;) {
    let fd: number | undefined;
    try { fd = openSync(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        const remaining = deadline - performance.now();
        if (!retryable(error) || remaining <= 0) throw error;
        await delay(Math.min(20, remaining)); continue;
      }
    }
    if (fd !== undefined) {
      try { writeFileSync(fd, owner); }
      catch (error) { unlinkSync(file); throw error; }
      finally { closeSync(fd); }
      return () => {
        if (readFileSync(file, "utf8") !== owner) throw new Error(`config lock ownership changed: ${file}`);
        unlinkSync(file);
      };
    }
    try {
      const identity = lstatSync(file);
      if (!identity.isFile() || identity.isSymbolicLink()) throw new Error(`unsafe config lock: ${file}`);
      const raw = readFileSync(file, "utf8");
      let previous: { pid?: unknown; token?: unknown } = {};
      try { previous = JSON.parse(raw) ?? {}; } catch { /* An initializing owner is protected. */ }
      let dead = false;
      if (Number.isSafeInteger(previous.pid) && (previous.pid as number) > 0 && typeof previous.token === "string") {
        try { process.kill(previous.pid as number, 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (dead) {
        const reclaim = `${file}.reclaim`;
        let held = false;
        try {
          mkdirSync(reclaim, { mode: 0o700 }); held = true;
          const current = lstatSync(file);
          if (current.dev === identity.dev && current.ino === identity.ino && readFileSync(file, "utf8") === raw) unlinkSync(file);
        } catch (error) {
          if (!["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        } finally { if (held) rmdirSync(reclaim); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (!retryable(error) || performance.now() >= deadline)) throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`config lock busy or unverifiable: ${file}`);
    await delay(Math.min(20, remaining));
  }
}

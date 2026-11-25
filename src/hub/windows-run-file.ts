import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { WINDOWS_RUN_FILE_SCRIPT, WINDOWS_RUN_META_BATCH_SCRIPT } from "./windows-run-file-source.js";
import type { RunFile, RunFileStat } from "./run-file-types.js";

const MAX_REPLY = 1500000; // Base64 for at most 1 MiB, plus the small envelope.
const fail = (code = "EIO"): Error => Object.assign(new Error(`Windows safe read: ${code}`), { code });
export function validateWindowsRunPath(file: string): void {
  if (!/^[a-z]:[\\/][^\\/]/i.test(file) || file.length > 30000) throw fail("EUNSAFEPATH");
  for (const part of file.slice(3).split(/[\\/]/)) {
    if (!part || part === "." || part === ".." || /[. ]$|[:*?"<>|\x00-\x1f]/.test(part) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw fail("EUNSAFEPATH");
  }
}
function command(script = WINDOWS_RUN_FILE_SCRIPT): [string, string[]] {
  // Use the OS installation, not a potentially shadowed PATH command.
  const system = process.env.SystemRoot ?? "C:\\Windows";
  return [path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]];
}
function reply(line: string): Record<string, unknown> {
  let value: Record<string, unknown>;
  try { value = JSON.parse(line); } catch { throw fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  if (typeof value.error === "string") throw fail(value.error);
  return value;
}
function stat(value: Record<string, unknown>): RunFileStat {
  const { size, dev, ino } = value;
  if (!Number.isSafeInteger(size) || (size as number) < 0 || typeof dev !== "string" || !/^\d+$/.test(dev) || typeof ino !== "string" || !/^\d+$/.test(ino)) throw fail();
  return { size: size as number, dev: Number(dev), ino: Number(ino), isFile: () => true };
}
function bytes(value: Record<string, unknown>, limit: number): Buffer {
  if (typeof value.data !== "string" || value.data.length > Math.ceil(limit / 3) * 4) throw fail();
  const data = Buffer.from(value.data, "base64");
  if (data.length > limit || data.toString("base64") !== value.data) throw fail();
  return data;
}

function once(file: string, statOnly = false): Record<string, unknown> {
  validateWindowsRunPath(file);
  const [exe, args] = command();
  const out = execFileSync(exe, args, { input: JSON.stringify({ file, once: true, statOnly }) + "\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 15000, maxBuffer: MAX_REPLY });
  const lines = out.trim().split(/\r?\n/);
  if (lines.length !== 1) throw fail();
  return reply(lines[0]!);
}
/** Synchronous metadata consumer (tut ps). Never returns a native handle. */
export function readWindowsRunMeta(file: string): Buffer {
  return bytes(once(file), 1024 * 1024);
}
export type WindowsMetaResult<T> =
  | { i: number; kind: 'meta'; meta: T }
  | { i: number; kind: 'error'; error: unknown; origin: 'local' | 'file' | 'protocol' | 'transport' };
const BATCH_INPUT = 4 * 1024 * 1024;
const BATCH_OUTPUT = 24 * 1024 * 1024;
const BATCH_BUFFER = 32 * 1024 * 1024;

/** Each slot has one authoritative attempt. Only proven unexecuted suffixes
 * may be continued; observed failures are absorbing even after a bad frame. */
export function readWindowsRunMetas<T>(
  files: readonly { i: number; file: string }[],
  decode: (data: Buffer, i: number) => T,
  single: (i: number) => T,
): WindowsMetaResult<T>[] {
  const results = new Map<number, WindowsMetaResult<T>>();
  const pending: { i: number; file: string }[] = [];
  for (const request of files) {
    try { validateWindowsRunPath(request.file); pending.push(request); }
    catch (error) { results.set(request.i, { i: request.i, kind: 'error', error, origin: 'local' }); }
  }
  let offset = 0;
  while (offset < pending.length) {
    const batch = randomBytes(16).toString('hex');
    const group: typeof pending = [];
    const input: string[] = [];
    let inputBytes = 0;
    for (let j = offset; j < pending.length && group.length < 4096; j++) {
      const request = pending[j]!;
      const line = JSON.stringify({ v: 1, batch, ...request }) + '\n';
      const length = Buffer.byteLength(line);
      if (inputBytes + length > BATCH_INPUT) break;
      group.push(request); input.push(line); inputBytes += length;
    }
    const [exe, args] = command(WINDOWS_RUN_META_BATCH_SCRIPT);
    const out = spawnSync(exe, args, { input: input.join(''), stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, timeout: 15000, maxBuffer: BATCH_BUFFER });
    const processError = out.error as NodeJS.ErrnoException | undefined;
    const stdout = out.stdout ?? Buffer.alloc(0), stderr = out.stderr ?? Buffer.alloc(0);
    // Empty output alone never proves the child did not execute.
    if (!out.pid && stdout.length === 0 && stderr.length === 0 &&
        ['ENOENT', 'EACCES'].includes(processError?.code ?? '')) {
      for (const { i } of group) {
        try { results.set(i, { i, kind: 'meta', meta: single(i) }); }
        catch (error) { results.set(i, { i, kind: 'error', error, origin: 'file' }); }
      }
      offset += group.length; continue;
    }
    const candidates = new Map<number, T>();
    let count = 0, cursor = 0, done = false, budget = false, malformed = false;
    while (cursor < stdout.length) {
      const end = stdout.indexOf(10, cursor);
      if (end < 0 || end + 1 > BATCH_OUTPUT) { malformed = true; break; }
      const frame = stdout.subarray(cursor, end + 1); cursor = end + 1;
      try {
        const value = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
        if (!value || Array.isArray(value) || value.v !== 1 || value.batch !== batch || done) throw fail();
        if (value.type === 'result') {
          if (frame.length > MAX_REPLY || count >= group.length || value.i !== group[count]!.i ||
              (Object.hasOwn(value, 'data') === Object.hasOwn(value, 'error'))) throw fail();
          const i = group[count]!.i;
          if (Object.hasOwn(value, 'error')) {
            if (typeof value.error !== 'string' || !['EUNSAFEPATH', 'EFBIG', 'ENOENT', 'EACCES', 'EIO'].includes(value.error)) throw fail();
            results.set(i, { i, kind: 'error', error: fail(value.error), origin: 'file' });
          } else {
            if (typeof value.data !== 'string') throw fail();
            try { candidates.set(i, decode(bytes(value, 1024 * 1024), i)); }
            catch (error) { results.set(i, { i, kind: 'error', error, origin: 'file' }); }
          }
          count++;
        } else if (value.type === 'done') {
          if (frame.length > 1024 || value.n !== group.length || value.k !== count ||
              !(value.reason === 'eof' && count === group.length || value.reason === 'budget' && count > 0 && count < group.length)) throw fail();
          done = true; budget = value.reason === 'budget';
        } else throw fail();
      } catch { malformed = true; break; }
    }
    const normal = !out.error && out.status === 0 && !out.signal;
    if (!malformed && done && normal) {
      for (const [i, meta] of candidates) results.set(i, { i, kind: 'meta', meta });
      offset += budget ? count : group.length;
    } else {
      const origin = normal ? 'protocol' : 'transport';
      const error = Object.assign(fail(processError?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'EIO'), {
        diagnostic: { status: out.status, signal: out.signal, code: processError?.code,
          message: processError?.message.slice(0, 512), stdout: stdout.subarray(0, 1024).toString('utf8'),
          stderr: stderr.subarray(0, 1024).toString('utf8') },
      });
      for (const { i } of group) if (!results.has(i)) results.set(i, { i, kind: 'error', error, origin });
      offset += group.length;
    }
  }
  return files.map(({ i }) => results.get(i)!);
}
/** Attribute-only observation on the same pinned, reparse-refusing chain.
 * No ReadFile call or metadata-size limit applies to a log activity query. */
export function statWindowsRunFile(file: string): RunFileStat & { mtimeMs: number } {
  const value = once(file, true);
  if (typeof value.mtimeMs !== 'number' || !Number.isFinite(value.mtimeMs)) throw fail();
  return { ...stat(value), mtimeMs: value.mtimeMs };
}

/** One transport per snapshot scope; at most one native file chain at a time.
 * close acknowledges that ALL file handles were disposed before reuse.
 */
function startBridge() {
  const [exe, args] = command();
  const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let pending: { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let terminal: Error | undefined, closed = false, buffered = "";
  const stop = (error: Error): void => {
    if (terminal) return;
    terminal = error;
    if (pending) { clearTimeout(pending.timer); pending.reject(terminal); pending = undefined; }
    child.stdin.destroy(); child.kill();
  };
  child.on("error", () => stop(fail()));
  child.stdin.on("error", () => stop(fail()));
  child.on("exit", () => { if (!closed) stop(fail()); });
  // Drain diagnostics without retaining arbitrary PowerShell error output.
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > MAX_REPLY) { stop(fail()); return; }
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, ""); buffered = buffered.slice(newline + 1);
      if (!pending) { stop(fail()); return; }
      const p = pending; pending = undefined; clearTimeout(p.timer);
      try { p.resolve(reply(line)); } catch (e) { p.reject(e as Error); stop(e as Error); }
    }
  });
  const request = (value: object): Promise<Record<string, unknown>> => {
    if (terminal || closed || pending) return Promise.reject(terminal ?? fail());
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(() => stop(fail("ETIMEDOUT")), 15000) };
      child.stdin.write(JSON.stringify(value) + "\n");
    });
  };
  let closing: Promise<void> | undefined;
  return { request, stop, get failed() { return !!terminal; },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      if (pending) stop(fail());
      if (!terminal) child.stdin.end(); // EOF also releases any active chain.
      // Bound cleanup even if PowerShell becomes unresponsive after a reply.
      closing = new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { child.kill(); resolve(); }, 1000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      return closing;
    },
  };
}

/** Request-scoped compiler reuse, with no global pool, cache, or live handles
 * retained after the snapshot. A failed operation is NEVER replayed; a later
 * independent file open can start a fresh bridge after the failed one exits.
 */
export function createWindowsRunFileSession() {
  let bridge: ReturnType<typeof startBridge> | undefined;
  let active = false, disposed = false;
  return {
    async open(file: string): Promise<RunFile> {
      validateWindowsRunPath(file);
      if (disposed || active) throw fail();
      active = true;
      const current = bridge ??= startBridge();
      const checked = async <T>(request: object, decode: (value: Record<string, unknown>) => T): Promise<T> => {
        try { return decode(await current.request(request)); }
        catch (e) { current.stop(e as Error); throw e; }
      };
      try { await checked({ op: "open", file }, stat); }
      catch (e) { await current.close(); bridge = undefined; active = false; throw e; }
      let closed = false;
      const ensureOpen = (): void => { if (closed || disposed) throw fail(); };
      return {
        async stat() { ensureOpen(); return checked({ op: "stat" }, stat); },
        async read(buffer, offset, length, position) {
          ensureOpen();
          if (![offset, length, position].every(Number.isSafeInteger) || offset < 0 || length < 0 || length > 1024 * 1024 || offset + length > buffer.length || position < 0) throw new RangeError("invalid bounded read");
          const data = await checked({ op: "read", from: position, count: length }, value => bytes(value, length));
          data.copy(buffer, offset); return { bytesRead: data.length };
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            if (!current.failed && !disposed) await checked({ op: "close" }, value => { if (value.closed !== true) throw fail(); });
          } finally {
            if (current.failed) { await current.close(); bridge = undefined; }
            active = false;
          }
        },
      };
    },
    async close() { disposed = true; await bridge?.close(); },
  };
}

/** Standalone capability (range/attach): owns and closes its helper too. */
export async function openWindowsRunFile(file: string): Promise<RunFile> {
  const session = createWindowsRunFileSession();
  try {
    const fileHandle = await session.open(file);
    return { stat: () => fileHandle.stat(), read: (...args) => fileHandle.read(...args),
      async close() { try { await fileHandle.close(); } finally { await session.close(); } },
    };
  } catch (e) { await session.close(); throw e; }
}

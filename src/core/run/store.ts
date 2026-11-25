/** Storage ownership: runs/<id> holds permanent identity, startup/stop and repair
 * evidence (RunStore/supervisor write; ps/resume/board/usage read), never TTL.
 * logs/runs/<id>/log holds raw output (supervisor writes; attach/board/usage
 * read); retain until an explicit retention transaction, respecting pins and
 * incomplete/measurement/latest-role protections. runtime/{runs,admission}
 * contains mutexes; only identity-checked owner recovery may retire them.
 * Unrecognized siblings remain protected; none of these ports sweep directories. */
/** Local run protocol only. Task/project records remain behind the Hub API. */
import { constants as C, closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { validateControlMeta } from './validation.js';
import type { HeadlessOwnership, HeadlessStartIntent, ResumeSource, ResumeStartIntent, RunMeta } from './meta.js';
import { readWindowsRunMeta, readWindowsRunMetas, statWindowsRunFile, createWindowsRunFileSession } from '../../hub/windows-run-file.js';

export type { HeadlessOwnership, HeadlessStartIntent, ResumeSource, ResumeStartIntent, RunMeta } from './meta.js';
/** A run is complete only with terminal evidence: ended_at present, and any
 *  stop request must have SUCCEEDED. "Stopped" alone, a failed stop, or a
 *  lost supervisor without ended_at are all incomplete. */
export function complete(meta: RunMeta): boolean {
  return !!meta.ended_at && (!meta.stop_request || meta.stop_request.result?.success === true);
}
export function validateResumeSource(r: ResumeSource): void {
  if (!r || r.schema !== 1 || !/^(\d{8}T\d{9}Z-[a-f0-9]{8})$/.test(r.from_run_id) || typeof r.agent !== 'string' || !r.agent ||
      typeof r.session_id !== 'string' || !r.session_id || !['observed','designated','argv'].includes(r.identity) ||
      typeof r.requested_at !== 'string' || !Number.isFinite(Date.parse(r.requested_at)) || typeof r.requested_by !== 'string' || !r.requested_by ||
      (r.task_id !== undefined && typeof r.task_id !== 'string')) throw new Error('invalid resume source');
}
/** Keep the additive association narrow; never accept process authority here. */
export function validateHeadlessOwnership(h: HeadlessOwnership): void {
  if(h?.session_identity!==undefined&&(!h.session_identity||typeof h.session_identity.agent!=='string'||!h.session_identity.agent||typeof h.session_identity.session_id!=='string'||!h.session_identity.session_id))throw new Error('invalid headless session identity');
  if (!h || h.schema !== 1 || !['architect','executor','reviewer'].includes(h.role) || typeof h.attempt_id !== 'string' || !/^[a-f0-9-]{36}$/.test(h.attempt_id) ||
      !Number.isSafeInteger(h.base_version) || h.base_version < 0 || !Number.isSafeInteger(h.trigger_version) || h.trigger_version < 0 || h.trigger_version > h.base_version ||
      !h.route || typeof h.route.agent !== 'string' || !h.route.agent || !Array.isArray(h.route.args) || !h.route.args.every(s => typeof s === 'string') ||
      typeof h.route_source !== 'string' || typeof h.session_reason !== 'string' ||
      (h.designated_session_id !== undefined && !/^[a-f0-9-]{36}$/.test(h.designated_session_id))) throw new Error('invalid headless ownership');
}
export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export function validPid(pid: unknown): pid is number { return Number.isSafeInteger(pid) && (pid as number) > 1; }
export function validateId(id: string): void {
  if (!/^\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(id)) throw new Error(`invalid run-id: ${id}`);
}
/** Quarantine evidence name base for isolated invalid metas (tut repair-run). */
export const QUARANTINE_BASE = 'meta.json.broken';
/** Leftover atomic-write artifacts of the meta write protocol. */
export const META_TMP_PATTERN = /^meta\.[a-f0-9]{24}\.tmp$/;
/** Safe inputs for archive repair classification — every byte here passed a
 *  link-refusing, regular-file-checked open under the meta lock. */
export type RepairMetaState =
  | { kind: 'absent'; isolatedMarker?: string }
  | { kind: 'unsafe'; reason: string }
  | { kind: 'bytes'; raw: string };
export interface RepairArtifact { name: string; raw: string; mtimeMs: number }
export type RepairDecision =
  | { action: 'already-valid' }
  | { action: 'already-quarantined' }
  | { action: 'adopt'; artifact: string }
  | { action: 'isolate' }
  | { action: 'refuse'; reason: string };
export type RepairApplied =
  | { applied: 'already-valid' }
  | { applied: 'already-quarantined' }
  | { applied: 'adopted'; adoptedFrom: string; isolatedAs?: string }
  | { applied: 'isolated'; isolatedAs: string }
  | { applied: 'refused'; reason: string };
export function validateMeta(value: unknown, id: string): RunMeta {
  const m = value as RunMeta | null;
  if (!m || m.run_id !== id || !validPid(m.pid) || m.pgid !== m.pid || !validPid(m.supervisor_pid) || m.supervisor_pid === m.pgid ||
      !Array.isArray(m.argv) || !m.argv.length || !m.argv.every(s => typeof s === 'string') || !m.argv[0] ||
      !['running', 'stopped', 'exited'].includes(m.status) || typeof m.started_at !== 'string' || !Number.isFinite(Date.parse(m.started_at)) ||
      typeof m.cwd !== 'string' || !path.isAbsolute(m.cwd) || (m.task_id !== undefined && typeof m.task_id !== 'string')) {
    throw new Error(`invalid meta/unsafe process identity for ${id}`);
  }
  for (const field of ['ended_at', 'stopped_at'] as const) {
    if (m[field] !== undefined && (typeof m[field] !== 'string' || !Number.isFinite(Date.parse(m[field])))) throw new Error(`invalid ${field} for ${id}`);
  }
  if ((m.exit_code !== undefined && (!Number.isSafeInteger(m.exit_code) || m.exit_code < 0)) ||
      (m.stopped_by !== undefined && typeof m.stopped_by !== 'string') ||
      (m.agent_session_id !== undefined && typeof m.agent_session_id !== 'string') ||
      (m.exit_signal !== undefined && typeof m.exit_signal !== 'string') ||
      (m.checkout !== undefined && (typeof m.checkout !== 'string' || !path.isAbsolute(m.checkout))) ||
      m.argv.some(s => s.includes('\0')) ||
      (m.status === 'stopped' && (!m.stopped_at || !m.stopped_by))) throw new Error(`invalid optional run metadata for ${id}`);
  if (m.headless !== undefined) validateHeadlessOwnership(m.headless);
  if (m.resume !== undefined) validateResumeSource(m.resume);
  if (m.root_exited_at !== undefined && (typeof m.root_exited_at !== "string" || !Number.isFinite(Date.parse(m.root_exited_at)))) throw new Error("invalid root_exited_at");
  validateControlMeta(m);
  return m;
}
export function probe(pid: number, kill: typeof process.kill = process.kill): boolean | null {
  if (!Number.isSafeInteger(pid) || Math.abs(pid) <= 1) throw new Error('unsafe process id');
  if (process.platform === 'win32' && pid < 0) return null;
  try { kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
}
function noLinkDirectory(file: string): void {
  const st = lstatSync(file);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe run directory: ${file}`);
}

export type RunMetaResult =
  | { id: string; kind: 'meta'; meta: RunMeta }
  | { id: string; kind: 'error'; error: unknown; origin: 'local' | 'file' | 'protocol' | 'transport' };

export type CompletionOutcome = 'delivered' | 'ignored-closed' | 'missing-delivery-notification-reserved';
export interface CompletionCheck {
  schema: 1;
  run_id: string; task_id: string; attempt_id: string; role: string; base_version: number;
  ended_at: string; processed_at: string; outcome: CompletionOutcome;
  evidence_version?: number;
  delivery_version?: number;
}
export type CompletionResult = Pick<CompletionCheck, 'outcome' | 'evidence_version' | 'delivery_version'>;

function completionIdentity(meta: RunMeta) {
  validateMeta(meta, meta.run_id);
  if (!complete(meta) || !meta.task_id || !meta.headless || meta.stop_request || meta.exit_code !== 0 || meta.exit_signal ||
      (meta.input_delivery && meta.input_delivery.status !== 'complete')) throw new Error('run is not a successful managed completion');
  return { run_id: meta.run_id, task_id: meta.task_id, attempt_id: meta.headless.attempt_id,
    role: meta.headless.role, base_version: meta.headless.base_version, ended_at: meta.ended_at! };
}
function validateCompletion(value: unknown, meta: RunMeta): CompletionCheck {
  const result = value as CompletionCheck | null;
  const identity = completionIdentity(meta);
  if (!result || result.schema !== 1 || Object.entries(identity).some(([key, v]) => result[key as keyof CompletionCheck] !== v) ||
      !['delivered', 'ignored-closed', 'missing-delivery-notification-reserved'].includes(result.outcome) ||
      typeof result.processed_at !== 'string' || !Number.isFinite(Date.parse(result.processed_at)) ||
      (result.evidence_version !== undefined && (!Number.isSafeInteger(result.evidence_version) || result.evidence_version < 0)) ||
      (result.delivery_version !== undefined && (!Number.isSafeInteger(result.delivery_version) || result.delivery_version <= identity.base_version)) ||
      (result.outcome === 'delivered' && (result.delivery_version === undefined || result.evidence_version === undefined || result.delivery_version > result.evidence_version)) ||
      (result.outcome !== 'delivered' && result.delivery_version !== undefined)) throw new Error('invalid completion check or mismatched run identity');
  return result;
}

export class RunStore {
  private readonly metadataReads = new AsyncLocalStorage<{ session: ReturnType<typeof createWindowsRunFileSession>; tail: Promise<void> }>();
  readonly root: string;
  constructor(readonly hubRoot: string) { this.root = path.join(hubRoot, '.context-hub', 'runs'); }
  private checkRoot(): void {
    noLinkDirectory(path.dirname(this.root)); noLinkDirectory(this.root);
  }
  directory(id: string): string {
    validateId(id); this.checkRoot();
    const dir = path.join(this.root, id); noLinkDirectory(dir); return dir;
  }
  create(): string {
    for (const dir of [path.dirname(this.root), this.root]) {
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      noLinkDirectory(dir);
    }
    for (;;) {
      const id = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`;
      try {
        mkdirSync(path.join(this.root, id), { mode: 0o700 });
        this.ensureDirectories(path.join(this.hubRoot, '.context-hub', 'logs', 'runs', id));
        this.ensureDirectories(path.join(this.hubRoot, '.context-hub', 'runtime', 'runs', id));
        return id;
      }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
  }
  list(): string[] {
    try { this.checkRoot(); return readdirSync(this.root).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  /** Isolation is settled only while meta.json is absent. Old evidence must
   *  never hide a newly damaged or unsafe meta; unknown remains reportable. */
  isQuarantined(id: string): boolean {
    try {
      const state = this.readRepairMetaState(id, this.directory(id));
      return state.kind === 'absent' && state.isolatedMarker !== undefined;
    } catch { return false; }
  }
  private open(id: string, name: string, flags: number): number {
    const fd = openSync(path.join(this.directory(id), name), flags | C.O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`not a regular run file: ${name}`);
      return fd;
    } catch (e) { closeSync(fd); throw e; }
  }
  private ensureDirectories(target: string): void {
    const base = path.join(this.hubRoot, '.context-hub');
    noLinkDirectory(base);
    let dir = base;
    for (const part of path.relative(base, target).split(path.sep)) {
      dir = path.join(dir, part);
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      noLinkDirectory(dir);
    }
  }
  /** New allocations own logs/runs/<id>; absent allocation means legacy layout.
   * Unsafe new paths never fall back to the old log. No file is moved. */
  logPath(id: string): string {
    const legacy = this.directory(id);
    let dir = path.join(this.hubRoot, '.context-hub');
    try {
      for (const part of ['logs', 'runs', id]) { dir = path.join(dir, part); noLinkDirectory(dir); }
      return path.join(dir, 'log');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return path.join(legacy, 'log');
  }
  openLog(id: string, append = false): number {
    const fd = openSync(this.logPath(id), (append ? C.O_WRONLY | C.O_APPEND | C.O_CREAT : C.O_RDONLY) | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
    try { if (!fstatSync(fd).isFile()) throw new Error('not a regular run file: log'); return fd; }
    catch (e) { closeSync(fd); throw e; }
  }
  /** Observe output activity without reading or retaining log content. */
  logInfo(id: string): { mtimeMs: number } {
    if (process.platform === 'win32') {
      try { return { mtimeMs: statWindowsRunFile(this.logPath(id)).mtimeMs }; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EUNSAFEPATH') {
          throw Object.assign(new Error('unsafe or not a regular run file: log', { cause: e }), { code: 'EUNSAFEPATH' });
        }
        throw e;
      }
    }
    // A FIFO without a writer must reach fstat instead of blocking the poll.
    const fd = this.openLog(id);
    try { return { mtimeMs: fstatSync(fd).mtimeMs }; }
    finally { closeSync(fd); }
  }
  /** Startup ownership survives a lost handshake; no environment is persisted. */
  readStartIntent(id: string): HeadlessStartIntent {
    const fd = this.open(id, 'headless-start.json', C.O_RDONLY);
    try {
      const value = JSON.parse(readFileSync(fd,'utf8')) as HeadlessStartIntent;
      if (!value || typeof value.task_id !== 'string' || !value.task_id || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || !['pending','failed'].includes(value.startup)) throw new Error('invalid headless startup intent');
      validateHeadlessOwnership(value.headless);
      return value;
    } finally { closeSync(fd); }
  }
  async writeStartIntent(id: string, intent: HeadlessStartIntent): Promise<void> {
    validateHeadlessOwnership(intent.headless);
    await this.writeIntentFile(id, 'headless-start.json', intent);
  }
  readResumeIntent(id: string): ResumeStartIntent {
    const fd = this.open(id, 'resume-start.json', C.O_RDONLY);
    try {
      const value = JSON.parse(readFileSync(fd, 'utf8')) as ResumeStartIntent;
      if (!value || value.schema !== 1 || !/^(\d{8}T\d{9}Z-[a-f0-9]{8})$/.test(value.from_run_id) || typeof value.agent !== 'string' ||
          typeof value.session_id !== 'string' || !value.session_id || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) ||
          !['pending','failed'].includes(value.startup)) throw new Error('invalid resume startup intent');
      return value;
    } finally { closeSync(fd); }
  }
  async writeResumeIntent(id: string, intent: ResumeStartIntent): Promise<void> {
    if (intent.schema !== 1 || !/^(\d{8}T\d{9}Z-[a-f0-9]{8})$/.test(intent.from_run_id) || typeof intent.agent !== 'string' ||
        typeof intent.session_id !== 'string' || !intent.session_id || typeof intent.cwd !== 'string' || !path.isAbsolute(intent.cwd) ||
        !['pending','failed'].includes(intent.startup)) throw new Error('invalid resume startup intent');
    await this.writeIntentFile(id, 'resume-start.json', intent);
  }
  /** Reservation files land atomically under the run's meta lock. */
  private async writeIntentFile(id: string, name: string, intent: object): Promise<void> {
    const unlock = await this.lock(id,'meta');
    try {
      const file = path.join(this.directory(id),`${name}.${randomBytes(12).toString('hex')}.tmp`);
      const fd = openSync(file,C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,0o600);
      try { writeFileSync(fd,JSON.stringify(intent)+'\n'); } finally { closeSync(fd); }
      renameSync(file,path.join(this.directory(id),name));
    } finally { unlock(); }
  }
  read(id: string): RunMeta {
    if (process.platform === 'win32') return validateMeta(JSON.parse(readWindowsRunMeta(path.join(this.directory(id), 'meta.json')).toString('utf8')), id);
    const fd = this.open(id, 'meta.json', C.O_RDONLY);
    try { return validateMeta(JSON.parse(readFileSync(fd, 'utf8')), id); } finally { closeSync(fd); }
  }
  /** Only an absent sidecar is unprocessed. Unsafe/corrupt evidence is never overwritten. */
  readCompletionCheck(meta: RunMeta): CompletionCheck | undefined {
    completionIdentity(meta);
    this.directory(meta.run_id);
    let raw: string;
    try { raw = this.readRepairFile(meta.run_id, 'completion-check.json').raw; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
    return validateCompletion(JSON.parse(raw), meta);
  }
  /** Reserve once across processes, before any notification. No Hub or Channel I/O under the lock. */
  async claimCompletionCheck(meta: RunMeta, result: CompletionResult): Promise<boolean> {
    const identity = completionIdentity(meta);
    const unlock = await this.lock(meta.run_id, 'meta');
    try {
      const current = await this.readMetadata(meta.run_id);
      if (JSON.stringify(completionIdentity(current)) !== JSON.stringify(identity)) throw new Error('completion identity changed before reservation');
      if (this.readCompletionCheck(current)) return false;
      const value = validateCompletion({ ...result, ...identity, schema: 1, processed_at: new Date().toISOString() }, current);
      const dir = this.directory(meta.run_id);
      const file = path.join(dir, `completion-check.${randomBytes(12).toString('hex')}.tmp`);
      const fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      try {
        // Atomic create-only publication also refuses an unexpected existing link/file.
        linkSync(file, path.join(dir, 'completion-check.json'));
        if (process.platform !== 'win32') {
          const directoryFd = openSync(dir, C.O_RDONLY | C.O_NOFOLLOW);
          try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        }
      } finally { unlinkSync(file); }
      return true;
    } finally { unlock(); }
  }
  /** Reuse the existing safe helper within a live protocol operation. Each
   * read still opens a fresh pinned chain and closes it before any write;
   * neither metadata nor handles are cached across reads. */
  async withMetadataReads<T>(action: () => Promise<T>): Promise<T> {
    if (process.platform !== 'win32' || this.metadataReads.getStore()) return action();
    const context = { session: createWindowsRunFileSession(), tail: Promise.resolve() };
    try { return await this.metadataReads.run(context, action); }
    finally { await context.tail; await context.session.close(); }
  }
  async readAsync(id: string): Promise<RunMeta> {
    if (!this.metadataReads.getStore()) return this.read(id);
    // Coordinate fresh native opens with atomic replacement. A delete-pending
    // target is a sharing refusal, not permission to retry an unsafe path.
    const unlock = await this.lock(id, 'meta');
    try { return await this.readMetadata(id); }
    finally { unlock(); }
  }
  private async readMetadata(id: string): Promise<RunMeta> {
    const context = this.metadataReads.getStore();
    if (!context) return this.read(id);
    const file = path.join(this.directory(id), 'meta.json');
    const read = context.tail.then(async () => {
      const handle = await context.session.open(file);
      try {
        const size = (await handle.stat()).size;
        if (size > 1024 * 1024) throw Object.assign(new Error('Windows safe read: EFBIG'), { code: 'EFBIG' });
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, 0);
        if (bytesRead !== size || (await handle.stat()).size < size) throw new Error('LOG_CHANGED');
        return validateMeta(JSON.parse(buffer.toString('utf8')), id);
      } finally { await handle.close(); }
    });
    // The helper is sequential even if an operation has concurrent readers.
    context.tail = read.then(() => {}, () => {});
    return read;
  }
  /** Ordered scan results; single-file transactions retain read() and its locks. */
  readManyMetas(ids: readonly string[]): RunMetaResult[] {
    if (process.platform !== 'win32') return ids.map(id => {
      try { return { id, kind: 'meta', meta: this.read(id) }; }
      catch (error) { return { id, kind: 'error', error, origin: 'file' }; }
    });
    const results: RunMetaResult[] = new Array(ids.length);
    const files: { i: number; file: string }[] = [];
    ids.forEach((id, i) => {
      try { files.push({ i, file: path.join(this.directory(id), 'meta.json') }); }
      catch (error) { results[i] = { id, kind: 'error', error, origin: 'local' }; }
    });
    for (const result of readWindowsRunMetas(files,
      (data, i) => validateMeta(JSON.parse(data.toString('utf8')), ids[i]!), i => this.read(ids[i]!))) {
      const { i, ...value } = result;
      results[i] = { id: ids[i]!, ...value };
    }
    return results;
  }
  lockPath(id: string, name: 'meta' | 'stop'): string {
    this.directory(id);
    return path.join(this.hubRoot, '.context-hub', 'runtime', 'runs', id, `${name}.lock`);
  }
  /** Exclusive file locks, with serialized, identity-checked dead-owner recovery. */
  async lock(id: string, name: 'meta' | 'stop', waitMs = process.platform === 'win32' && name === 'meta' ? 20000 : 2000): Promise<() => void> {
    // A Windows metadata transaction includes the bounded native read (15s)
    // and atomic publication retry (1s). The former POSIX 2s default could
    // make the original supervisor abandon a healthy concurrent writer.
    // Explicit caller deadlines, stop/admission locks and POSIX stay intact.
    this.directory(id);
    const dir = path.join(this.hubRoot, '.context-hub', 'runtime', 'runs', id);
    this.ensureDirectories(dir);
    const file = this.lockPath(id, name);
    return this.lockCompatible(path.join(this.directory(id), `${name}.lock`), file, waitMs, `${name} lock in-progress or unverifiable for ${id}`);
  }
  /** Rig-wide startup admission lock: serializes the verify→reserve→spawn
   *  critical section of resume and headless auto launches across processes. */
  async lockAdmission(waitMs = 5000): Promise<() => void> {
    for (const dir of [path.dirname(this.root), this.root]) {
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      noLinkDirectory(dir);
    }
    const runtime = path.join(this.hubRoot, '.context-hub', 'runtime');
    this.ensureDirectories(runtime);
    return this.lockCompatible(path.join(this.root, 'admission.lock'), path.join(runtime, 'admission.lock'), waitMs, `admission lock in-progress or unverifiable under ${this.root}`);
  }
  /** Old processes can reacquire their original mutex at any time. Until their
   * lifetime is explicitly retired, absence of that file is not a cutover proof.
   * Hold a compatibility mutex before the runtime mutex for the entire transaction;
   * keep one wait budget and release in reverse order. Never move an old lock. */
  private async lockCompatible(legacy: string, runtime: string, waitMs: number, busyMessage: string): Promise<() => void> {
    const deadline = performance.now() + waitMs;
    const releaseLegacy = await this.lockFile(legacy, waitMs, busyMessage);
    try {
      const releaseRuntime = await this.lockFile(runtime, Math.max(0, deadline - performance.now()), busyMessage);
      return () => { try { releaseRuntime(); } finally { releaseLegacy(); } };
    } catch (error) { releaseLegacy(); throw error; }
  }
  private async lockFile(file: string, waitMs: number, busyMessage: string): Promise<() => void> {
    const owner = JSON.stringify({ pid: process.pid, root: realpathSync(this.hubRoot), token: randomBytes(16).toString('hex') });
    const deadline = performance.now() + waitMs;
    let unverifiable = false;
    const retryable = (e: unknown): boolean => process.platform === 'win32' &&
      ['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '');
    for (;;) {
      let fd: number | undefined;
      try { fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          // A recently unlinked Windows lock can remain delete-pending while
          // a competitor closes its read handle. Never unlink to resolve it.
          const remaining = deadline - performance.now();
          if (!retryable(e) || remaining <= 0) throw e;
          await delay(Math.min(20, remaining)); continue;
        }
      }
      if (fd !== undefined) {
        try { writeFileSync(fd, owner); } finally { closeSync(fd); }
        return () => { if (readFileSync(file, 'utf8') !== owner) throw new Error(`lock ownership changed: ${file}`); unlinkSync(file); };
      }
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error(`unsafe lock: ${file}`);
        const raw = readFileSync(file, 'utf8');
        let previous: { pid?: unknown; token?: unknown; root?: unknown } | undefined;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
        } catch { /* The owner may still be between exclusive creation and publication. */ }
        unverifiable = !previous || !validPid(previous.pid) || typeof previous.token !== 'string';
        // An empty/partial owner is contention until the SAME deadline expires,
        // never evidence of a dead owner. In particular, do not reclaim it.
        if (previous && validPid(previous.pid) && typeof previous.token === 'string' && (probe(previous.pid) === false || (typeof previous.root === 'string' && path.isAbsolute(previous.root) && previous.root !== realpathSync(this.hubRoot)))) {
          const reclaim = `${file}.reclaim`;
          let held = false;
          try {
            mkdirSync(reclaim, { mode: 0o700 }); held = true;
            const current = lstatSync(file);
            if (st.ino === current.ino && st.dev === current.dev && readFileSync(file, 'utf8') === raw) unlinkSync(file);
          } catch (e) { if (!['EEXIST', 'ENOENT'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
          finally { if (held) rmdirSync(reclaim); }
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (!retryable(e) || performance.now() >= deadline)) throw e;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(unverifiable ? `cannot verify lock after ${waitMs}ms: ${file}` : busyMessage);
      await delay(Math.min(20, remaining));
    }
  }
  private write(id: string, meta: RunMeta): void | Promise<void> {
    validateMeta(meta, id);
    const dir = this.directory(id);
    const file = path.join(dir, `meta.${randomBytes(12).toString('hex')}.tmp`);
    // Refuse even an in-root meta symlink; rename must never silently retire it.
    try { if (lstatSync(path.join(dir, 'meta.json')).isSymbolicLink()) throw new Error('unsafe meta symlink'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(meta)}\n`); } finally { closeSync(fd); }
    const target = path.join(dir, 'meta.json');
    if (process.platform !== 'win32') { renameSync(file, target); return; }
    return this.publishWindowsMeta(file, target);
  }
  private async publishWindowsMeta(file: string, target: string): Promise<void> {
    // Safe readers pin Windows paths without sharing deletion. Yield only
    // the final atomic publication, under the same meta lock, so a transient
    // reader can close. Never unlink the target or rewrite the pending bytes.
    // Persistent contention reports the original error and keeps the artifact.
    const deadline = performance.now() + 1000;
    for (;;) {
      try {
        // Recheck after each yield: a link must never be silently retired.
        try { if (lstatSync(target).isSymbolicLink()) throw new Error('unsafe meta symlink'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        renameSync(file, target); return;
      } catch (e) {
        const remaining = deadline - performance.now();
        if (!['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '') || remaining <= 0) throw e;
        await delay(Math.min(20, remaining));
      }
    }
  }
  async initialize(id: string, meta: RunMeta): Promise<void> {
    const unlock = await this.lock(id, 'meta');
    try {
      try { await this.readMetadata(id); throw new Error(`meta already exists: ${id}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const publication = this.write(id, meta);
      if (publication) await publication;
    } finally { unlock(); }
  }
  async updateMeta(id: string, fn: (current: RunMeta) => RunMeta): Promise<RunMeta> {
    const unlock = await this.lock(id, 'meta');
    try {
      const next = fn(await this.readMetadata(id));
      const publication = this.write(id, next);
      if (publication) await publication;
      return next;
    } finally { unlock(); }
  }
  /** Supported repair channel for unreadable run archives: the whole
   *  disposition — safe meta read, artifact scan, decision, isolate/adopt —
   *  runs under the meta lock, so concurrent repairs serialize and never act
   *  on a stale snapshot. Every read refuses links (native bridge on Windows,
   *  O_NOFOLLOW on POSIX) and never
   *  waits on special files (O_NONBLOCK, then regular-file check — the same
   *  discipline as logInfo); no path deletes or overwrites evidence
   *  (isolation always moves meta.json to a FRESH evidence name). Artifacts
   *  are scanned LAZILY, so healthy and unsafe archives decide without ever
   *  touching unrelated files. The decision is the caller's pure
   *  classification over the safe inputs. */
  async repairArchive(id: string, decide: (meta: RepairMetaState, scanArtifacts: () => RepairArtifact[]) => RepairDecision): Promise<RepairApplied> {
    validateId(id);
    const unlock = await this.lock(id, 'meta');
    try {
      const dir = this.directory(id);
      const meta = this.readRepairMetaState(id, dir);
      let scanned: RepairArtifact[] | undefined;
      const scanArtifacts = (): RepairArtifact[] => {
        if (scanned !== undefined) return scanned;
        scanned = [];
        for (const name of readdirSync(dir).sort()) {
          if (!META_TMP_PATTERN.test(name)) continue;
          try {
            scanned.push({ name, ...this.readRepairFile(id, name) });
          } catch { /* links, non-regular, FIFOs and torn artifacts are never adoption evidence */ }
        }
        return scanned;
      };
      const decision = decide(meta, scanArtifacts);
      switch (decision.action) {
        case 'already-valid': return { applied: 'already-valid' };
        case 'already-quarantined': return { applied: 'already-quarantined' };
        case 'refuse': return { applied: 'refused', reason: decision.reason };
        case 'isolate': {
          if (meta.kind !== 'bytes') return { applied: 'refused', reason: `isolation requires readable regular meta.json bytes (state: ${meta.kind})` };
          return { applied: 'isolated', isolatedAs: this.isolateMetaEvidence(dir) };
        }
        case 'adopt': {
          if (!scanArtifacts().some(a => a.name === decision.artifact)) return { applied: 'refused', reason: `artifact ${decision.artifact} is not a readable regular file` };
          const isolatedAs = meta.kind === 'bytes' ? this.isolateMetaEvidence(dir) : undefined;
          renameSync(path.join(dir, decision.artifact), path.join(dir, 'meta.json'));
          return { applied: 'adopted', adoptedFrom: decision.artifact, ...(isolatedAs !== undefined ? { isolatedAs } : {}) };
        }
      }
    } finally { unlock(); }
  }
  private readRepairFile(id: string, name: string): { raw: string; mtimeMs: number } {
    if (process.platform === 'win32') {
      const file = path.join(this.directory(id), name);
      // Node's O_NOFOLLOW does not reject Windows symlinks. lstat supplies
      // the diagnostic (including dangling links); the native handle-relative
      // reader enforces reparse refusal even if the pathname changes after it.
      const st = lstatSync(file);
      if (st.isSymbolicLink()) throw Object.assign(new Error('symbolic link'), { code: 'ELOOP' });
      if (!st.isFile()) throw new Error(`not a regular run file: ${name}`);
      return { raw: readWindowsRunMeta(file).toString('utf8'), mtimeMs: st.mtimeMs };
    }
    const fd = this.open(id, name, C.O_RDONLY | C.O_NONBLOCK);
    try { return { raw: readFileSync(fd, 'utf8'), mtimeMs: fstatSync(fd).mtimeMs }; }
    finally { closeSync(fd); }
  }
  /** Link-refusing, non-blocking meta state for classification; a missing
   *  meta.json keeps any existing quarantine marker visible so re-runs stay
   *  idempotent. O_NONBLOCK so a writerless FIFO reaches the regular-file
   *  check instead of blocking the caller inside the lock. */
  private readRepairMetaState(id: string, dir: string): RepairMetaState {
    try {
      return { kind: 'bytes', raw: this.readRepairFile(id, 'meta.json').raw };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const message = (e as Error).message;
      if (code === 'ENOENT') {
        const isolatedMarker = readdirSync(dir).find(n => n === QUARANTINE_BASE || n.startsWith(`${QUARANTINE_BASE}.`));
        return isolatedMarker !== undefined ? { kind: 'absent', isolatedMarker } : { kind: 'absent' };
      }
      return { kind: 'unsafe', reason: code === 'ELOOP' ? 'symbolic link'
        : code === 'EISDIR' || message.includes('not a regular') ? 'not a regular file'
        : `unreadable (${message})` };
    }
  }
  /** Move the current meta.json aside under a FRESH evidence name — existing
   *  evidence is never overwritten, whatever created it. */
  private isolateMetaEvidence(dir: string): string {
    const existing = new Set(readdirSync(dir));
    let target = QUARANTINE_BASE;
    while (existing.has(target)) target = `${QUARANTINE_BASE}.${randomBytes(4).toString('hex')}`;
    renameSync(path.join(dir, 'meta.json'), path.join(dir, target));
    return target;
  }
}

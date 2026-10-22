/** Local run protocol only. Task/project records remain behind the Hub API. */
import { constants as C, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateControlMeta } from './validation.js';
import type { StopRequest } from './protocol.js';

export interface HeadlessOwnership {
  schema: 1; role: string; attempt_id: string; base_version: number; trigger_version: number;
  route: { agent: string; args: string[] }; route_source: string;
  resume_from_run_id?: string; designated_session_id?: string; session_reason: string;
}

export interface HeadlessStartIntent { task_id: string; headless: HeadlessOwnership; cwd: string; startup: "pending" | "failed" }

/** Provenance of a resumed run: which run it continues, which native session
 *  identity was used, and who asked. Additive; never process authority. */
export interface ResumeSource {
  schema: 1; from_run_id: string; agent: string; session_id: string;
  identity: 'observed' | 'designated' | 'argv';
  requested_at: string; requested_by: string; task_id?: string;
}

/** Persisted before the resumed process is spawned: an uncertain handshake
 *  stays attributable to its session identity. */
export interface ResumeStartIntent { schema: 1; from_run_id: string; agent: string; session_id: string; cwd: string; startup: 'pending' | 'failed' }

export interface RunMeta {
  [key: string]: unknown;
  run_id: string; task_id?: string; pid: number; pgid: number; argv: string[];
  started_at: string; status: 'running' | 'stopped' | 'exited';
  supervisor_pid: number; cwd: string;
  /** Anchored checkout landing point validated from the 工作区 declaration (additive). */
  checkout?: string;
  headless?: HeadlessOwnership; root_exited_at?: string;
  agent_session_id?: string; exit_code?: number; exit_signal?: string; ended_at?: string;
  stopped_by?: string; stopped_at?: string;
  identity_probe?: string; identity_ack?: string;
  control_protocol?: string; stop_request?: StopRequest;
  resume?: ResumeSource;
}
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

export class RunStore {
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
      try { mkdirSync(path.join(this.root, id), { mode: 0o700 }); return id; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
  }
  list(): string[] {
    try { this.checkRoot(); return readdirSync(this.root).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  private open(id: string, name: string, flags: number): number {
    const fd = openSync(path.join(this.directory(id), name), flags | C.O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`not a regular run file: ${name}`);
      return fd;
    } catch (e) { closeSync(fd); throw e; }
  }
  openLog(id: string, append = false): number {
    return this.open(id, 'log', append ? C.O_WRONLY | C.O_APPEND | C.O_CREAT : C.O_RDONLY);
  }
  /** Observe output activity without reading or retaining log content. */
  logInfo(id: string): { mtimeMs: number } {
    // A FIFO without a writer must reach fstat instead of blocking the poll.
    const fd = this.open(id, 'log', C.O_RDONLY | C.O_NONBLOCK);
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
    const value = JSON.parse(readFileSync(this.open(id, 'resume-start.json', C.O_RDONLY), 'utf8')) as ResumeStartIntent;
    if (!value || value.schema !== 1 || !/^(\d{8}T\d{9}Z-[a-f0-9]{8})$/.test(value.from_run_id) || typeof value.agent !== 'string' ||
        typeof value.session_id !== 'string' || !value.session_id || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) ||
        !['pending','failed'].includes(value.startup)) throw new Error('invalid resume startup intent');
    return value;
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
    const fd = this.open(id, 'meta.json', C.O_RDONLY);
    try { return validateMeta(JSON.parse(readFileSync(fd, 'utf8')), id); } finally { closeSync(fd); }
  }
  /** Exclusive file locks, with serialized, identity-checked dead-owner recovery. */
  async lock(id: string, name: 'meta' | 'stop', waitMs = 2000): Promise<() => void> {
    const file = path.join(this.directory(id), `${name}.lock`);
    return this.lockFile(file, waitMs, `${name} lock in-progress or unverifiable for ${id}`);
  }
  /** Rig-wide startup admission lock: serializes the verify→reserve→spawn
   *  critical section of resume and headless auto launches across processes. */
  async lockAdmission(waitMs = 5000): Promise<() => void> {
    for (const dir of [path.dirname(this.root), this.root]) {
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      noLinkDirectory(dir);
    }
    return this.lockFile(path.join(this.root, 'admission.lock'), waitMs, `admission lock in-progress or unverifiable under ${this.root}`);
  }
  private async lockFile(file: string, waitMs: number, busyMessage: string): Promise<() => void> {
    const owner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString('hex') });
    const deadline = performance.now() + waitMs;
    let unverifiable = false;
    for (;;) {
      let fd: number | undefined;
      try { fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      if (fd !== undefined) {
        try { writeFileSync(fd, owner); } finally { closeSync(fd); }
        return () => { if (readFileSync(file, 'utf8') !== owner) throw new Error(`lock ownership changed: ${file}`); unlinkSync(file); };
      }
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error(`unsafe lock: ${file}`);
        const raw = readFileSync(file, 'utf8');
        let previous: { pid?: unknown; token?: unknown } | undefined;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
        } catch { /* The owner may still be between exclusive creation and publication. */ }
        unverifiable = !previous || !validPid(previous.pid) || typeof previous.token !== 'string';
        // An empty/partial owner is contention until the SAME deadline expires,
        // never evidence of a dead owner. In particular, do not reclaim it.
        if (previous && validPid(previous.pid) && typeof previous.token === 'string' && probe(previous.pid) === false) {
          const reclaim = `${file}.reclaim`;
          let held = false;
          try {
            mkdirSync(reclaim, { mode: 0o700 }); held = true;
            const current = lstatSync(file);
            if (st.ino === current.ino && st.dev === current.dev && readFileSync(file, 'utf8') === raw) unlinkSync(file);
          } catch (e) { if (!['EEXIST', 'ENOENT'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
          finally { if (held) rmdirSync(reclaim); }
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(unverifiable ? `cannot verify lock after ${waitMs}ms: ${file}` : busyMessage);
      await delay(Math.min(20, remaining));
    }
  }
  private write(id: string, meta: RunMeta): void {
    validateMeta(meta, id);
    const dir = this.directory(id);
    const file = path.join(dir, `meta.${randomBytes(12).toString('hex')}.tmp`);
    // Refuse even an in-root meta symlink; rename must never silently retire it.
    try { if (lstatSync(path.join(dir, 'meta.json')).isSymbolicLink()) throw new Error('unsafe meta symlink'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const fd = openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(meta)}\n`); } finally { closeSync(fd); }
    renameSync(file, path.join(dir, 'meta.json'));
  }
  async initialize(id: string, meta: RunMeta): Promise<void> {
    const unlock = await this.lock(id, 'meta');
    try {
      try { this.read(id); throw new Error(`meta already exists: ${id}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      this.write(id, meta);
    } finally { unlock(); }
  }
  async updateMeta(id: string, fn: (current: RunMeta) => RunMeta): Promise<RunMeta> {
    const unlock = await this.lock(id, 'meta');
    try { const next = fn(this.read(id)); this.write(id, next); return next; } finally { unlock(); }
  }
  /** Supported repair channel for unreadable run archives: the whole
   *  disposition — safe meta read, artifact scan, decision, isolate/adopt —
   *  runs under the meta lock, so concurrent repairs serialize and never act
   *  on a stale snapshot. Every read refuses links (O_NOFOLLOW) and never
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
            const fd = this.open(id, name, C.O_RDONLY | C.O_NONBLOCK);
            try { scanned.push({ name, raw: readFileSync(fd, 'utf8'), mtimeMs: fstatSync(fd).mtimeMs }); } finally { closeSync(fd); }
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
  /** Link-refusing, non-blocking meta state for classification; a missing
   *  meta.json keeps any existing quarantine marker visible so re-runs stay
   *  idempotent. O_NONBLOCK so a writerless FIFO reaches the regular-file
   *  check instead of blocking the caller inside the lock. */
  private readRepairMetaState(id: string, dir: string): RepairMetaState {
    try {
      const fd = this.open(id, 'meta.json', C.O_RDONLY | C.O_NONBLOCK);
      try { return { kind: 'bytes', raw: readFileSync(fd, 'utf8') }; } finally { closeSync(fd); }
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

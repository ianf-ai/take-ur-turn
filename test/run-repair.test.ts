import { describe, expect, it } from 'vitest';
import { closeSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RunStore, probe, QUARANTINE_BASE, type RunMeta } from '../src/core/run/store.js';
import { repairRun as actualRepairRun, quarantinedMarker, type RepairOptions } from '../src/core/run/repair.js';
import { listRuns } from '../src/core/run/control.js';
import { parseArgs } from '../src/core/cli/args.js';
import { runDoctor } from '../src/core/doctor/index.js';

// Historical fixtures model POSIX groups. Windows cannot probe a negative
// PID; provide only the declared dead fixture-group facts via the public seam.
// Real positive-PID liveness and explicit unknown/permission cases stay real.
const fixtureProbe: typeof probe = (pid, kill) => process.platform === 'win32' && [-59089, -2147483000].includes(pid) ? false : probe(pid, kill);
const repairRun = (store: RunStore, id: string, options: RepairOptions = {}) => actualRepairRun(store, id, { probe: fixtureProbe, ...options });
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tut-repair-'));
  const store = new RunStore(root);
  /** Create a run dir and write meta BYTES directly (bypasses validation —
   *  the forensics shapes here are exactly what validateMeta rejects). */
  const rawRun = (metaFor: (id: string) => string, log = 'log line 1\nlog line 2\n'): string => {
    const id = store.create();
    const dir = store.directory(id);
    writeFileSync(path.join(dir, 'meta.json'), metaFor(id));
    const fd = store.openLog(id, true);
    try { writeFileSync(fd, log); } finally { closeSync(fd); }
    return id;
  };
  const validMeta = (id: string, patch: Partial<RunMeta> = {}): string => {
    const meta: RunMeta = { run_id: id, pid: 2147483000, pgid: 2147483000, supervisor_pid: 2147482999,
      argv: ['fixture'], cwd: root, started_at: '2026-10-16T17:50:40.647Z', status: 'exited', ended_at: '2026-10-16T17:51:00.000Z', exit_code: 0 };
    const merged = { ...meta, ...patch };
    for (const [key, value] of Object.entries(merged)) { if (value === undefined) delete (merged as Record<string, unknown>)[key]; }
    return `${JSON.stringify(merged)}\n`;
  };
  return { root, store, rawRun, validMeta };
}

/** The exact byte shape of the three 2026-10-16 bad archives: parseable JSON,
 *  terminal evidence, but no supervisor_pid / cwd — the prototype-era schema
 *  the landed protocol's validator rejects. Dead pids (Oct 16 processes). */
const legacyMeta = (id: string, patch: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ run_id: id, pid: 59089, pgid: 59089, argv: ['/opt/homebrew/bin/codex', 'exec'],
    started_at: '2026-10-16T17:50:40.647Z', status: 'exited', exit_code: 2, ...patch })}\n`;

/** A detached child that becomes its own live process-group leader;
 *  resolves only once the group is observably alive (spawn returns before
 *  the child starts — probing immediately would misjudge it dead). */
async function liveGroup(): Promise<{ pid: number; stop: () => void }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid!;
  for (let i = 0; i < 500; i++) {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 0); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') break; await sleep(2); }
  }
  return { pid, stop: () => { try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } } };
}

describe('tut repair-run: disposition of invalid run meta', () => {
  it('quarantines a legacy-shape invalid meta and preserves every evidence byte (acceptance 1)', async () => {
    const f = fixture();
    const id = f.rawRun(legacyMeta);
    const dir = f.store.directory(id);
    const metaBytes = readFileSync(path.join(dir, 'meta.json'), 'utf8');
    const logBefore = sha(readFileSync(path.join(dir, 'log')));

    const outcome = await repairRun(f.store, id);
    expect(outcome).toMatchObject({ disposition: 'quarantined', run_id: id });
    expect(existsSync(path.join(dir, 'meta.json'))).toBe(false);
    expect(quarantinedMarker(f.store, id)).toBe(QUARANTINE_BASE);
    // Byte-level preservation: the isolated meta is byte-identical, the log untouched.
    expect(readFileSync(path.join(dir, QUARANTINE_BASE), 'utf8')).toBe(metaBytes);
    expect(sha(readFileSync(path.join(dir, 'log')))).toBe(logBefore);
    // Idempotent: a second repair recognizes the already-isolated archive.
    expect(await repairRun(f.store, id)).toMatchObject({ disposition: 'already-quarantined' });
    expect(sha(readFileSync(path.join(dir, 'log')))).toBe(logBefore);
  });

  it('historical formats without supervisor evidence are disposable only in a terminal status', async () => {
    const f = fixture();
    // Terminal 'stopped' with stop evidence, dead pid/group → disposable (the third real archive's shape).
    const stopped = f.rawRun(id => legacyMeta(id, { status: 'stopped', stopped_at: '2026-10-16T17:51:49.944Z', stopped_by: 'owner', exit_code: 0 }));
    expect((await repairRun(f.store, stopped)).disposition).toBe('quarantined');
    // 'running' without supervisor evidence → conservative refusal, zero modification.
    const running = f.rawRun(id => legacyMeta(id, { status: 'running' }));
    const outcome = await repairRun(f.store, running);
    expect(outcome.disposition).toBe('refused');
    expect((outcome as { reason: string }).reason).toContain('status is not terminal');
    expect(existsSync(path.join(f.store.directory(running), 'meta.json'))).toBe(true);
  });

  it('tut ps shows the quarantine marker instead of unreadable, and the listing exits clean', async () => {
    const f = fixture();
    const good = f.rawRun(f.validMeta);
    const bad = f.rawRun(legacyMeta);
    expect((await repairRun(f.store, bad)).disposition).toBe('quarantined');
    const listing = listRuns(f.store);
    expect(listing.errors).toHaveLength(0);                    // no more unreadable
    expect(listing.runs.map(m => m.run_id)).toEqual([good]);   // the healthy run reads normally
    expect(listing.quarantined).toEqual([{ run_id: bad, note: expect.stringContaining(QUARANTINE_BASE) }]);
    expect(listing.quarantined[0]!.note).toContain('run log preserved');
    expect(JSON.parse(JSON.stringify(listing)).quarantined).toHaveLength(1); // --json keeps the marker
  });

  it('adopts a complete leftover write artifact (protocol repair), preserving the invalid bytes', async () => {
    const f = fixture();
    const id = f.store.create();
    const dir = f.store.directory(id);
    const fd = f.store.openLog(id, true); try { writeFileSync(fd, 'evidence\n'); } finally { closeSync(fd); }
    // A torn meta.json (truncated JSON) plus the complete artifact the atomic
    // write never landed — the power-loss timeline of write-tmp / lost rename.
    const torn = f.validMeta(id).slice(0, 40);
    writeFileSync(path.join(dir, 'meta.json'), torn);
    const artifact = `meta.${'a'.repeat(24)}.tmp`;
    writeFileSync(path.join(dir, artifact), f.validMeta(id, { ended_at: '2026-10-16T18:00:00.000Z' }));

    const outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('repaired');
    const restored = f.store.read(id); // the full validator passes on the adopted meta
    expect(restored.ended_at).toBe('2026-10-16T18:00:00.000Z');
    expect(sha(readFileSync(path.join(dir, 'log')))).toBe(sha('evidence\n'));
    // The torn bytes survive under the quarantine name.
    expect(readFileSync(path.join(dir, QUARANTINE_BASE), 'utf8')).toBe(torn);
    expect(listRuns(f.store).errors).toHaveLength(0);
  });

  it('never adopts a torn or foreign write artifact — quarantine is the only remaining disposition', async () => {
    const f = fixture();
    const tornArtifact = `meta.${'b'.repeat(24)}.tmp`;
    const foreignArtifact = `meta.${'c'.repeat(24)}.tmp`;
    const id = f.rawRun(id => {
      const dir = f.store.directory(id);
      writeFileSync(path.join(dir, tornArtifact), '{ torn');                    // unparseable artifact
      writeFileSync(path.join(dir, foreignArtifact), f.validMeta('other-run')); // foreign run_id
      return legacyMeta(id);
    });
    const dir = f.store.directory(id);

    expect((await repairRun(f.store, id)).disposition).toBe('quarantined');
    expect(existsSync(path.join(dir, tornArtifact))).toBe(true);   // artifacts kept as evidence
    expect(existsSync(path.join(dir, foreignArtifact))).toBe(true);
  });

  it('refuses to quarantine while any identifiable writer may be live', async () => {
    const f = fixture();
    const group = await liveGroup();
    try {
      // Live process group in the ORIGINAL meta: refused before any modification.
      const live = f.rawRun(id => legacyMeta(id, { pid: group.pid, pgid: group.pid }));
      let outcome = await repairRun(f.store, live);
      expect(outcome.disposition).toBe('refused');
      expect((outcome as { reason: string }).reason).toMatch(/alive|unknown/);
      expect(existsSync(path.join(f.store.directory(live), 'meta.json'))).toBe(true);

      // Dead group but a LIVE supervisor pid: the supervisor lives outside the
      // group and still writes session/end evidence after the group exits.
      const liveSupervisor = f.rawRun(id => legacyMeta(id, { supervisor_pid: process.pid }));
      outcome = await repairRun(f.store, liveSupervisor);
      expect(outcome.disposition).toBe('refused');
      expect((outcome as { reason: string }).reason).toContain(`supervisor ${process.pid} is alive`);
      expect(existsSync(path.join(f.store.directory(liveSupervisor), 'meta.json'))).toBe(true);

      // Probe unknown (e.g. EPERM): not provably dead → refused, zero modification.
      const unknown = f.rawRun(legacyMeta);
      outcome = await repairRun(f.store, unknown, { probe: () => null });
      expect(outcome.disposition).toBe('refused');
      expect((outcome as { reason: string }).reason).toContain('liveness unknown');
      expect(existsSync(path.join(f.store.directory(unknown), 'meta.json'))).toBe(true);
    } finally { group.stop(); }
  });

  it('refuses to adopt an artifact whose writers are alive, even beside a torn meta', async () => {
    const f = fixture();
    const groupA = await liveGroup();
    const groupB = await liveGroup();
    try {
      const id = f.store.create();
      const dir = f.store.directory(id);
      const fd = f.store.openLog(id, true); try { writeFileSync(fd, 'x'); } finally { closeSync(fd); }
      writeFileSync(path.join(dir, 'meta.json'), f.validMeta(id).slice(0, 40)); // torn
      const artifact = `meta.${'d'.repeat(24)}.tmp`;
      writeFileSync(path.join(dir, artifact), f.validMeta(id, { pid: groupA.pid, pgid: groupA.pid, supervisor_pid: groupB.pid }));

      const outcome = await repairRun(f.store, id);
      expect(outcome.disposition).toBe('refused');
      expect((outcome as { reason: string }).reason).toMatch(/supervisor|alive/);
      // Zero modification: torn meta, artifact and log all untouched, nothing isolated.
      expect(readFileSync(path.join(dir, 'meta.json'), 'utf8')).toBe(f.validMeta(id).slice(0, 40));
      expect(existsSync(path.join(dir, artifact))).toBe(true);
      expect(readdirSync(dir).some(n => n.startsWith(QUARANTINE_BASE))).toBe(false);
    } finally { groupA.stop(); groupB.stop(); }
  });

  it('adoption refuses when the parseable current meta has live or unknown writers, or a comparable-identity conflict', async () => {
    const f = fixture();
    const id = f.store.create();
    const dir = f.store.directory(id);
    const fd = f.store.openLog(id, true); try { writeFileSync(fd, 'x'); } finally { closeSync(fd); }
    const artifact = `meta.${'7'.repeat(24)}.tmp`;
    // Candidate carries the SAME live supervisor as the originals below, so the
    // refusal comes from the original-writer liveness gate itself — not from a
    // supervisor-identity conflict.
    writeFileSync(path.join(dir, artifact), f.validMeta(id, { supervisor_pid: process.pid }));
    const original = (patch: Record<string, unknown>): void =>
      writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify({ run_id: id, pid: 2147483000, pgid: 2147483000, supervisor_pid: process.pid,
        argv: ['fixture'], started_at: '2026-10-16T17:50:40.647Z', status: 'exited', ...patch })}\n`);
    const digest = (): [string, string][] => readdirSync(dir).sort().map(n => [n, sha(readFileSync(path.join(dir, n)))]);

    // Reviewer repro: original parseable, pid/pgid match the candidate, invalid
    // only for missing cwd — but its supervisor is a LIVE process.
    original({});
    const before = digest();
    let outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('refused');
    expect((outcome as { reason: string }).reason).toContain('current meta writers not provably dead');
    expect((outcome as { reason: string }).reason).toContain(`supervisor ${process.pid} is alive`);

    // Probe-unknown for the ORIGINAL supervisor only: still refused.
    outcome = await repairRun(f.store, id, { probe: p => (p === process.pid ? null : probe(p)) });
    expect(outcome.disposition).toBe('refused');
    expect((outcome as { reason: string }).reason).toContain('liveness unknown');
    // Both refusals modified nothing, byte for byte.
    expect(digest()).toEqual(before);

    // Reviewer's exact mismatch shape (original live supervisor, candidate dead
    // supervisor) is also refused — via the supervisor-identity conflict.
    writeFileSync(path.join(dir, artifact), f.validMeta(id));
    outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('refused');
    expect((outcome as { reason: string }).reason).toContain('supervisor_pid');
    writeFileSync(path.join(dir, artifact), f.validMeta(id, { supervisor_pid: process.pid }));

    // Comparable PGID conflict (supervisor dead on both sides): identity mismatch refuses.
    original({ supervisor_pid: 2147482999, pgid: 999999111 });
    outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('refused');
    expect((outcome as { reason: string }).reason).toContain('differs from current meta');

    // And a consistent, all-dead original still lets the artifact repair.
    writeFileSync(path.join(dir, artifact), f.validMeta(id));
    original({ supervisor_pid: 2147482999 });
    outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('repaired');
    expect(f.store.read(id).run_id).toBe(id);
    expect(sha(readFileSync(path.join(dir, 'log')))).toBe(sha('x'));
    // The refused attempts modified nothing: the artifact the final adopt
    // consumed is the one written at fixture setup, and the isolated original
    // is the last (consistent) original bytes.
    expect(readFileSync(path.join(dir, QUARANTINE_BASE), 'utf8')).toContain('"supervisor_pid":2147482999');
    expect(before.map(([n]) => n)).toContain(artifact);
  });

  it.skipIf(process.platform === 'win32')(': a writerless FIFO never blocks repair — meta, artifact beside bad meta, artifact beside healthy meta', async () => {
    // Bounded child (mirrors the logInfo FIFO test): a blocking open hangs the
    // child past the timeout and fails the test; timely completitions print JSON.
    const scenario = async (kind: 'meta-fifo' | 'bad-meta-artifact-fifo' | 'valid-meta-artifact-fifo'): Promise<{ ms: number; first: { disposition?: string; reason?: string }; second: { disposition?: string }; files: string[]; log: string }> => {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { closeSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
        import { execFileSync } from 'node:child_process';
        import os from 'node:os';
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        const [kind] = process.argv.slice(1);
        const { RunStore } = await import(pathToFileURL(path.resolve('dist/core/run/store.js')));
        const { repairRun } = await import(pathToFileURL(path.resolve('dist/core/run/repair.js')));
        const root = mkdtempSync(path.join(os.tmpdir(), 'tut-f5-'));
        const store = new RunStore(root);
        const id = store.create();
        const dir = store.directory(id);
        closeSync(store.openLog(id, true));
        const valid = JSON.stringify({ run_id: id, pid: 2147483000, pgid: 2147483000, supervisor_pid: 2147482999, argv: ['fixture'], cwd: root, started_at: '2026-10-16T17:50:40.647Z', status: 'exited', ended_at: '2026-10-16T17:51:00.000Z', exit_code: 0 }) + '\\n';
        const legacy = JSON.stringify({ run_id: id, pid: 59089, pgid: 59089, argv: ['x'], started_at: '2026-10-16T17:50:40.647Z', status: 'exited', exit_code: 2 }) + '\\n';
        const fifo = 'meta.${'9'.repeat(24)}.tmp';
        if (kind === 'meta-fifo') execFileSync('mkfifo', [path.join(dir, 'meta.json')]);
        if (kind === 'bad-meta-artifact-fifo') { writeFileSync(path.join(dir, 'meta.json'), legacy); execFileSync('mkfifo', [path.join(dir, fifo)]); }
        if (kind === 'valid-meta-artifact-fifo') { writeFileSync(path.join(dir, 'meta.json'), valid); execFileSync('mkfifo', [path.join(dir, fifo)]); }
        const t0 = Date.now();
        const first = await repairRun(store, id);
        const second = await repairRun(store, id); // proves the meta lock was released
        console.log(JSON.stringify({ ms: Date.now() - t0, first, second, files: readdirSync(dir), log: readFileSync(path.join(dir, 'log'), 'utf8') }));
      `, kind], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
      return JSON.parse(output);
    };

    const meta = await scenario('meta-fifo');
    expect(meta.first.disposition).toBe('refused');
    expect(meta.first.reason).toContain('not a regular file');
    expect(meta.second.disposition).toBe('refused'); // lock released; same verdict
    expect(meta.files).toContain('meta.json');       // the FIFO itself untouched
    expect(meta.ms).toBeLessThan(3000);

    const bad = await scenario('bad-meta-artifact-fifo');
    expect(bad.first.disposition).toBe('quarantined');     // FIFO skipped, legacy meta isolated
    expect(bad.second.disposition).toBe('already-quarantined');
    expect(bad.files.some(n => n.endsWith('.tmp'))).toBe(true); // FIFO not consumed/removed
    expect(bad.files).toContain('log');

    const healthy = await scenario('valid-meta-artifact-fifo');
    expect(healthy.first.disposition).toBe('already-valid');  // lazy scan: the FIFO is never even opened
    expect(healthy.second.disposition).toBe('already-valid');
    expect(healthy.files.some(n => n.endsWith('.tmp'))).toBe(true);
    expect(healthy.ms).toBeLessThan(3000);
  });

  it('refuses an unparseable meta without identity evidence, and a create-interrupted directory', async () => {
    const f = fixture();
    const torn = f.rawRun(() => '{"run_id": "20');
    const outcome = await repairRun(f.store, torn);
    expect(outcome.disposition).toBe('refused');
    expect((outcome as { reason: string }).reason).toContain('identity unknown');
    expect(existsSync(path.join(f.store.directory(torn), 'meta.json'))).toBe(true);

    const empty = f.store.create();
    const missing = await repairRun(f.store, empty);
    expect(missing.disposition).toBe('refused');
    expect((missing as { reason: string }).reason).toContain('create interrupted');
  });

  it('already-valid runs are a no-op', async () => {
    const f = fixture();
    const id = f.rawRun(f.validMeta);
    expect(await repairRun(f.store, id)).toMatchObject({ disposition: 'already-valid' });
    expect(readdirSync(f.store.directory(id)).some(n => n.startsWith(QUARANTINE_BASE))).toBe(false);
  });
});

describe('concurrent and locked dispositions serialize under the meta lock', () => {
  it('two racing repairs never act on a stale snapshot; original evidence survives exactly once', async () => {
    const f = fixture();
    const id = f.rawRun(legacyMeta);
    const dir = f.store.directory(id);
    const metaBytes = readFileSync(path.join(dir, 'meta.json'), 'utf8');

    const [a, b] = await Promise.all([repairRun(f.store, id), repairRun(f.store, id)]);
    const dispositions = [a.disposition, b.disposition].sort();
    // Serialized under the lock: exactly one isolation, the loser sees the finished state.
    expect(dispositions).toEqual(['already-quarantined', 'quarantined']);
    // The original bad bytes survive in exactly one evidence file, byte-identical.
    const markers = readdirSync(dir).filter(n => n.startsWith(QUARANTINE_BASE));
    expect(markers).toEqual([QUARANTINE_BASE]);
    expect(readFileSync(path.join(dir, QUARANTINE_BASE), 'utf8')).toBe(metaBytes);
    expect(listRuns(f.store).errors).toHaveLength(0);
  });

  it('a live meta-lock holder blocks repair — zero modification, honest refusal', async () => {
    const f = fixture();
    const id = f.rawRun(legacyMeta);
    const dir = f.store.directory(id);
    const before = readdirSync(dir).sort().map(n => [n, sha(readFileSync(path.join(dir, n)))]);

    const unlock = await f.store.lock(id, 'meta');
    try {
      const outcome = await repairRun(f.store, id);
      expect(outcome.disposition).toBe('refused');
      expect((outcome as { reason: string }).reason).toContain('repair did not run');
    } finally { unlock(); }
    // Byte-for-byte unchanged while the lock was (and stayed) held elsewhere.
    const after = readdirSync(dir).sort().map(n => [n, sha(readFileSync(path.join(dir, n)))]);
    expect(after).toEqual(before);
  });
});

describe('symbolic links are never followed into a false verdict', () => {
  it('a dangling meta link is unsafe rather than absent, even beside a valid artifact', async () => {
    const f = fixture();
    const id = f.store.create();
    const dir = f.store.directory(id);
    const target = path.join(f.root, 'missing-target.json');
    symlinkSync(target, path.join(dir, 'meta.json'));
    const artifact = path.join(dir, `meta.${'a'.repeat(24)}.tmp`);
    const bytes = f.validMeta(id);
    writeFileSync(artifact, bytes);
    const outcome = await repairRun(f.store, id);
    expect(outcome).toMatchObject({ disposition: 'refused', reason: expect.stringContaining('symbolic link') });
    expect(lstatSync(path.join(dir, 'meta.json')).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(artifact, 'utf8')).toBe(bytes);
    expect(readdirSync(dir).some(n => n.startsWith(QUARANTINE_BASE))).toBe(false);
  });

  it('a symlinked artifact is not adoption evidence; quarantine proceeds without touching the link target', async () => {
    const f = fixture();
    const id = f.rawRun(legacyMeta);
    const dir = f.store.directory(id);
    // Target carries the CURRENT run-id and a matching identity (dead writers):
    // following the link alone would yield a false 'repaired' — this test
    // isolates exactly that (reviewer's discriminating-target suggestion).
    const target = path.join(f.root, 'artifact-target.json');
    writeFileSync(target, f.validMeta(id, { pid: 59089, pgid: 59089 }));
    symlinkSync(target, path.join(dir, `meta.${'e'.repeat(24)}.tmp`));
    const targetBefore = sha(readFileSync(target));

    const outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('quarantined');           // NOT repaired through the link
    expect(sha(readFileSync(target))).toBe(targetBefore);      // target untouched
    expect(lstatSync(path.join(dir, `meta.${'e'.repeat(24)}.tmp`)).isSymbolicLink()).toBe(true); // link kept as evidence
  });

  it('a symlinked meta.json is refused (no false already-valid/repaired), link and target unchanged', async () => {
    const f = fixture();
    const id = f.store.create();
    const dir = f.store.directory(id);
    const fd = f.store.openLog(id, true); try { writeFileSync(fd, 'x'); } finally { closeSync(fd); }
    const target = path.join(f.root, 'meta-target.json');
    writeFileSync(target, f.validMeta(id));
    symlinkSync(target, path.join(dir, 'meta.json'));

    const outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('refused');
    expect((outcome as { reason: string }).reason).toMatch(/symbolic link|EUNSAFEPATH/);
    expect(lstatSync(path.join(dir, 'meta.json')).isSymbolicLink()).toBe(true); // link untouched
    expect(JSON.parse(readFileSync(target, 'utf8')).run_id).toBe(id);           // target untouched
    // And the protocol's own readers see it as unreadable — no false health anywhere.
    expect(listRuns(f.store).errors[0]!.error).toContain('incomplete/unreadable');
  });
});

describe('a missing meta with a complete artifact is recoverable (interrupted initialize)', () => {
  it('adopts the complete artifact of a first write interrupted before rename; log untouched', async () => {
    const f = fixture();
    const id = f.store.create();
    const dir = f.store.directory(id);
    const fd = f.store.openLog(id, true); try { writeFileSync(fd, 'first-write evidence\n'); } finally { closeSync(fd); }
    const artifact = `meta.${'f'.repeat(24)}.tmp`;
    writeFileSync(path.join(dir, artifact), f.validMeta(id));
    utimesSync(path.join(dir, artifact), 1, 1); // deterministic mtime ordering

    const outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('repaired');
    expect(f.store.read(id).run_id).toBe(id);                  // normal RunStore read works again
    expect(listRuns(f.store).errors).toHaveLength(0);          // ps is clean
    expect(sha(readFileSync(path.join(dir, 'log')))).toBe(sha('first-write evidence\n'));
    expect(readdirSync(dir).some(n => n.startsWith(QUARANTINE_BASE))).toBe(false); // nothing to isolate
  });

  it('torn, foreign and symlinked artifacts do not recover a missing meta', async () => {
    const f = fixture();
    const tornId = f.store.create();
    writeFileSync(path.join(f.store.directory(tornId), `meta.${'1'.repeat(24)}.tmp`), '{ torn');
    const outcome = await repairRun(f.store, tornId);
    expect(outcome.disposition).toBe('refused');
    expect((outcome as { reason: string }).reason).toContain('no adoptable complete artifact');

    const target = path.join(f.root, 'f4-target.json');
    const valid = f.store.create();
    writeFileSync(target, f.validMeta(valid));
    symlinkSync(target, path.join(f.store.directory(valid), `meta.${'2'.repeat(24)}.tmp`));
    const viaLink = await repairRun(f.store, valid);
    expect(viaLink.disposition).toBe('refused');
  });

  it('re-entering an interrupted adopt never overwrites earlier evidence', async () => {
    const f = fixture();
    const id = f.store.create();
    const dir = f.store.directory(id);
    const fd = f.store.openLog(id, true); try { writeFileSync(fd, 'x'); } finally { closeSync(fd); }
    // Simulate an earlier adopt that isolated the bad bytes but crashed before
    // promoting its artifact: evidence .broken on disk, artifact still present.
    writeFileSync(path.join(dir, QUARANTINE_BASE), 'earlier bad bytes');
    writeFileSync(path.join(dir, `meta.${'3'.repeat(24)}.tmp`), f.validMeta(id));

    const outcome = await repairRun(f.store, id);
    expect(outcome.disposition).toBe('repaired');
    expect(readFileSync(path.join(dir, QUARANTINE_BASE), 'utf8')).toBe('earlier bad bytes'); // preserved verbatim
    expect(f.store.read(id).run_id).toBe(id);
  });
});

describe('tut doctor: run-archive scan mounts the repair entry', () => {
  it('fails on invalid meta with the repair-run fix, reports quarantined archives as handled', async () => {
    const f = fixture();
    const bad = f.rawRun(legacyMeta);
    const quarantined = f.rawRun(legacyMeta);
    expect((await repairRun(f.store, quarantined)).disposition).toBe('quarantined');
    const good = f.rawRun(f.validMeta);

    const report = await runDoctor({ root: path.join(f.root, '.context-hub'), environment: {}, fetchImpl: async () => { throw new Error('offline'); },
      resolveTarget: () => { throw new Error('no agents in fixture'); } });
    const storage = report.checks.find(c => c.name === 'storage')!;
    expect(storage.status).toBe('fail');
    expect(storage.details.some(d => d.includes(`runs/${bad}: invalid meta`) && d.includes('tut ps reports incomplete/unreadable'))).toBe(true);
    expect(storage.details.some(d => d.includes(`tut repair-run ${bad}`))).toBe(true);
    expect(storage.details.some(d => d.includes(`runs/${quarantined}: quarantined (invalid meta isolated; run log preserved)`))).toBe(true);
    expect(storage.details.some(d => d.includes(`runs/${good}:`))).toBe(false); // healthy archives stay silent
  });

  it('reports a symlinked meta.json as unsafe damage instead of following it into health', async () => {
    const f = fixture();
    const id = f.store.create();
    const target = path.join(f.root, 'meta-target.json');
    writeFileSync(target, f.validMeta(id));
    symlinkSync(target, path.join(f.store.directory(id), 'meta.json'));

    const report = await runDoctor({ root: path.join(f.root, '.context-hub'), environment: {}, fetchImpl: async () => { throw new Error('offline'); },
      resolveTarget: () => { throw new Error('no agents in fixture'); } });
    const storage = report.checks.find(c => c.name === 'storage')!;
    expect(storage.status).toBe('fail');
    expect(storage.details.some(d => d.includes(`runs/${id}: meta.json is a symbolic link`))).toBe(true);
    expect(storage.details.some(d => d.includes('manual disposition required'))).toBe(true);
  });
});

describe('tut repair-run CLI surface', () => {
  it('parses repair-run like attach/stop: exactly one run-id, no flags', () => {
    expect(parseArgs(['repair-run', '20261016T175040618Z-2eef3709'])).toEqual({ command: 'repair-run', run_id: '20261016T175040618Z-2eef3709' });
    expect(parseArgs(['repair-run'])).toMatchObject({ command: 'usage' });
    expect(parseArgs(['repair-run', 'a', 'b'])).toMatchObject({ command: 'usage' });
    expect(parseArgs(['repair-run', 'x', '--json'])).toMatchObject({ command: 'usage' });
  });
});

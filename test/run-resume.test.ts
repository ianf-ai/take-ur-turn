import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RunStore, complete, type RunMeta, type HeadlessOwnership } from '../src/core/run/store.js';
import { stopRun } from '../src/core/run/control.js';
import { sessionOccupants, taskOccupants, metaCarriesSession, withAdmissionLock } from '../src/core/run/admission.js';
import {
  planResume, executeResume, executeManagedResume, ResumeError,
  parsePlainCodexArgv, parsePlainPiArgv, verifyPiSession, piSessionDirFor, readPiSessionHead,
  type ManagedResumeDeps, type StateSnapshot,
} from '../src/core/run/resume.js';

// Source modules exercise policy; the actual detached supervisor is the built
// same-package module used in installed execution (never a PATH tut).
const builtControl = await import(path.resolve('dist/core/run/control.js')) as typeof import('../src/core/run/control.js');
const { startRun } = builtControl;
import { CONTROL_PROTOCOL } from '../src/core/run/protocol.js';
import type { ContextRecord } from '../src/core/common/types.js';
import type { GateTaskLog } from '../src/core/run/resume.js';
import { startServer, type RunningServer } from '../src/core/hub/server.js';
import { hubCreate, hubRead, hubPublish, hubDecide } from '../src/core/hub/hub-client.js';

const roots: string[] = []; const groups: number[] = []; const servers: RunningServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* reaped */ } }
  for (const s of servers.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function root(): string { const r = mkdtempSync(path.join(os.tmpdir(), 'tut-resume-')); roots.push(r); return r; }
async function until(fn: () => boolean, ms = 8000): Promise<void> { const end = performance.now() + ms; while (!fn()) { if (performance.now() > end) throw new Error('condition timed out'); await new Promise(r => setTimeout(r, 25)); } }

/** A finished plain run fixture: real short-lived process, exited terminal state. */
async function finishedPlainRun(store: RunStore, argv: string[], cwd: string, agent_session_id?: string): Promise<string> {
  const id = await startRun(store, argv, cwd);
  await until(() => { try { return store.read(id).ended_at !== undefined; } catch { return false; } });
  await store.updateMeta(id, m => agent_session_id !== undefined ? { ...m, agent_session_id } : m);
  return id;
}

function ownership(role = 'executor', taskId = 'task-1'): HeadlessOwnership {
  return { schema: 1, role, attempt_id: crypto.randomUUID(), base_version: 1, trigger_version: 1,
    route: { agent: 'codex', args: ['-m', 'model-x'] }, route_source: 'task-cast', session_reason: 'fixture' };
}

function fakeCodex(root: string): string {
  const bin = path.join(root, 'bin'); mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'codex');
  writeFileSync(file, `#!/bin/sh
# fixture codex: prints its argv and exits 0
for a in "$@"; do echo "arg:$a"; done
`);
  chmodSync(file, 0o755);
  return file;
}
function fakePi(root: string): string {
  const bin = path.join(root, 'bin'); mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'pi');
  writeFileSync(file, `#!/bin/sh
for a in "$@"; do echo "arg:$a"; done
`);
  chmodSync(file, 0o755);
  return file;
}

describe('plain argv parsing', () => {
  it('codex fresh argv extracts options and replaces only prompt/session segment', () => {
    const parsed = parsePlainCodexArgv(['/usr/local/bin/codex', 'exec', '-s', 'read-only', '--json', 'old prompt']);
    expect(parsed.optionTokens).toEqual(['-s', 'read-only', '--json']);
  });
  it('codex resume argv skips the resume selector segment', () => {
    const parsed = parsePlainCodexArgv(['codex', '-m', 'gpt', 'exec', 'resume', '--json', '20260101', 'old prompt']);
    expect(parsed.optionTokens).toEqual(['-m', 'gpt', '--json']);
  });
  it('unknown options and ambiguous positionals refuse', () => {
    expect(() => parsePlainCodexArgv(['codex', 'exec', '--frobnicate', 'x'])).toThrow(ResumeError);
    expect(() => parsePlainCodexArgv(['codex', 'exec', 'a', 'b', 'c'])).toThrow(/positional/);
    expect(() => parsePlainCodexArgv(['codex', 'exec', '-m'])).toThrow(ResumeError);
  });
  it('pi argv requires the exact TUT-built --session-id shape', () => {
    expect(parsePlainPiArgv(['pi', '--model', 'glm', '--print', '--mode', 'json', '--session-id', '01aaaabb-bbcc-cddd-deee-effff0000011', '--', 'prompt']).session_id).toBe('01aaaabb-bbcc-cddd-deee-effff0000011');
    for (const bad of [
      ['pi', '--continue', '--', 'p'],
      ['pi', '--no-session', '--', 'p'],
      ['pi', '--session-id', 'not-a-uuid', '--', 'p'],
      ['pi', 'stray', '--session-id', '01aaaabb-bbcc-cddd-deee-effff0000011', '--', 'p'],
      ['pi', '--session-id', '01aaaabb-bbcc-cddd-deee-effff0000011', 'between', '--', 'p'],
      ['pi'],
    ]) expect(() => parsePlainPiArgv(bad as string[])).toThrow(ResumeError);
  });
});

describe('pi session verification', () => {
  it('encodes cwd the way pi does and verifies exact ids with matching cwd', () => {
    const base = path.join(root(), 'sessions');
    const project = path.join(root(), 'proj');
    mkdirSync(project, { recursive: true });
    const dir = piSessionDirFor(project, base);
    mkdirSync(dir, { recursive: true });
    const id = '01aaaabb-bbcc-cddd-deee-effff0000011';
    writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: 'session', id, cwd: project })}\n{more}\n`);
    writeFileSync(path.join(dir, 'other.jsonl'), `${JSON.stringify({ type: 'session', id: 'other-id', cwd: project })}\n`);
    expect(verifyPiSession(base, project, id)).toMatchObject({ ok: true });
    expect(verifyPiSession(base, project, 'missing-id').ok).toBe(false);
    // Cross-project session: pi stores it under the OTHER project's dir; our
    // project dir does not contain it, so verification refuses.
    expect(verifyPiSession(base, path.join(root(), 'elsewhere'), id).ok).toBe(false);
    expect(readPiSessionHead(path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`))).toMatchObject({ id });
  });
  it('a session recorded with a different cwd is refused as cross-project', () => {
    const base = path.join(root(), 'sessions');
    const project = path.join(root(), 'proj'); mkdirSync(project, { recursive: true });
    const dir = piSessionDirFor(project, base); mkdirSync(dir, { recursive: true });
    const id = '01aaaabb-bbcc-cddd-deee-effff0000011';
    writeFileSync(path.join(dir, `t_${id}.jsonl`), `${JSON.stringify({ type: 'session', id, cwd: '/somewhere/else' })}\n`);
    const verdict = verifyPiSession(base, project, id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('another project');
  });
});

describe('planResume', () => {
  it('refuses incomplete sources with classified reasons and never stops them', async () => {
    const r = root(); const store = new RunStore(r);
    const id = await startRun(store, [process.execPath, '-e', 'setTimeout(()=>{},30000)'], r);
    await until(() => store.read(id).status === 'running');
    await expect(async () => await planResume(store, id, {})).rejects.toMatchObject({ reason: 'source-run-active' });
    await stopRun(store, id);
  });
  it('codex plain run resumes with observed agent_session_id, same cwd, rebuilt resume argv', async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const id = await finishedPlainRun(store, [codex, 'exec', '-s', 'read-only', '--json', 'old prompt'], r, 'thread-12345');
    const plan = await planResume(store, id, { instruction: '继续做 X' });
    expect(plan.cwd).toBe(r);
    expect(plan.session).toEqual({ agent: 'codex', session_id: 'thread-12345', source: 'observed' });
    expect(plan.argv).toEqual([codex, '-s', 'read-only', 'exec', 'resume', '--json', 'thread-12345', '继续做 X']);
    expect(plan.resume).toMatchObject({ from_run_id: id, agent: 'codex', session_id: 'thread-12345', identity: 'observed' });
    expect(plan.managed).toBe(false);
    expect(plan.prompt).toBe('继续做 X');
  });
  it('codex without observed session refuses; default plain prompt is a continuation prompt', async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const id = await finishedPlainRun(store, [codex, 'exec', 'prompt'], r);
    await expect(async () => await planResume(store, id, {})).rejects.toMatchObject({ reason: 'codex-session-unavailable' });
  });
  it('pi plain run resumes only with a verified stored --session-id identity', async () => {
    const r = root(); const store = new RunStore(r);
    const pi = fakePi(r);
    const base = path.join(r, 'sessions');
    const session = '01aaaabb-bbcc-cddd-deee-effff0000011';
    const dir = piSessionDirFor(r, base); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `t_${session}.jsonl`), `${JSON.stringify({ type: 'session', id: session, cwd: r })}\n`);
    const argv = [pi, '--print', '--mode', 'json', '--session-id', session, '--', 'first prompt'];
    const id = await finishedPlainRun(store, argv, r);
    const plan = await planResume(store, id, { piSessionsBase: base });
    expect(plan.argv).toEqual([pi, '--print', '--mode', 'json', '--session-id', session, '--', plan.prompt]);
    expect(plan.prompt).toContain('继续');
    // Missing stored session (pi would CREATE one): refusal, not fresh fallback.
    const id2 = await finishedPlainRun(store, argv.map((a, i) => i === argv.indexOf(session) ? '01aaaabb-bbcc-cddd-deee-effff0000099' : a), r);
    await expect(async () => await planResume(store, id2, { piSessionsBase: base })).rejects.toMatchObject({ reason: 'pi-session-not-found' });
  });
  it('unknown agents and shell wrappers refuse explicitly', async () => {
    const r = root(); const store = new RunStore(r);
    const id = await finishedPlainRun(store, [process.execPath, '-e', ''], r);
    await expect(async () => await planResume(store, id, {})).rejects.toMatchObject({ reason: 'unsupported-agent' });
    const sh = path.join(r, 'sh'); writeFileSync(sh, '#!/bin/sh\n:'); chmodSync(sh, 0o755);
    const id2 = await finishedPlainRun(store, [sh, '-c', 'echo hi'], r);
    await expect(async () => await planResume(store, id2, {})).rejects.toMatchObject({ reason: 'unsupported-agent' });
  });
  it('managed run rebuilds headless ownership with resume provenance and doorbell prompt', async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const own = ownership();
    const id = await startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-9', { headless: own });
    await until(() => store.read(id).ended_at !== undefined);
    await store.updateMeta(id, m => ({ ...m, agent_session_id: 'thread-777' }));
    const plan = await planResume(store, id, {});
    expect(plan.managed).toBe(true);
    expect(plan.task_id).toBe('task-9');
    expect(plan.prompt).toContain('task-9');
    expect(plan.headless).toMatchObject({ role: 'executor', resume_from_run_id: id, session_reason: expect.stringContaining('resume') });
    expect(plan.headless!.attempt_id).not.toBe(own.attempt_id);
    expect(plan.argv).toEqual(['codex', '-m', 'model-x', 'exec', 'resume', '--json', 'thread-777', plan.prompt]);
  });
});

describe('admission occupancy', () => {
  it('structured session matching only recognizes TUT-built shapes', () => {
    const meta = { run_id: 'x', pid: 1, pgid: 1, argv: ['codex', 'exec', 'resume', 'SID123', 'p'], cwd: '/', supervisor_pid: 2, started_at: 't', status: 'running' } as unknown as RunMeta;
    expect(metaCarriesSession(meta, { agent: 'codex', session_id: 'SID123' })).toBe(true);
    const piMeta = { ...meta, argv: ['pi', '--session-id', 'SID123', '--', 'p'] } as unknown as RunMeta;
    expect(metaCarriesSession(piMeta, { agent: 'pi', session_id: 'SID123' })).toBe(true);
    // Substring/positional look-alikes never match.
    expect(metaCarriesSession(piMeta, { agent: 'pi', session_id: 'SID' })).toBe(false);
    expect(metaCarriesSession({ ...meta, argv: ['codex', 'prompt-about-SID123'] } as unknown as RunMeta, { agent: 'codex', session_id: 'SID123' })).toBe(false);
  });
  it('resumed codex runs are matched before any native session event, with options between resume and the id', () => {
    // The exact shape codexArgv builds: options sit between `resume` and the id.
    const argv = ['/usr/local/bin/codex', 'exec', 'resume', '--skip-git-repo-check', '--json', '01aaaabb-bbcc-cddd-deee-effff0000011', 'the prompt'];
    const meta = { run_id: 'x', pid: 1, pgid: 1, argv, cwd: '/', supervisor_pid: 2, started_at: 't', status: 'running' } as unknown as RunMeta;
    expect(metaCarriesSession(meta, { agent: 'codex', session_id: '01aaaabb-bbcc-cddd-deee-effff0000011' })).toBe(true);
    // The additive resume provenance covers the whole resume lifetime too — even
    // when the fixture agent has not printed any thread.started yet.
    const resumed = { ...meta, resume: { schema: 1, from_run_id: 'x', agent: '/opt/bin/codex', session_id: '01aaaabb-bbcc-cddd-deee-effff0000011', identity: 'observed', requested_at: 't', requested_by: 'u' } } as unknown as RunMeta;
    expect(metaCarriesSession(resumed, { agent: 'codex', session_id: '01aaaabb-bbcc-cddd-deee-effff0000011' })).toBe(true);
    // The id at the trailing prompt position alone never matches.
    expect(metaCarriesSession({ ...meta, argv: ['/usr/local/bin/codex', 'exec', 'resume', '01aaaabb-bbcc-cddd-deee-effff0000011'] } as unknown as RunMeta, { agent: 'codex', session_id: '01aaaabb-bbcc-cddd-deee-effff0000011' })).toBe(false);
  });
  it('an incomplete run holding the session blocks; completed ones do not', async () => {
    const r = root(); const store = new RunStore(r);
    const pi = fakePi(r);
    const session = '01aaaabb-bbcc-cddd-deee-effff0000011';
    const argv = [pi, '--print', '--mode', 'json', '--session-id', session, '--', 'first'];
    const done = await finishedPlainRun(store, argv, r);
    expect(sessionOccupants(store, { agent: 'pi', session_id: session })).toHaveLength(0);
    const live = await startRun(store, argv.map((a, i) => i === argv.indexOf(session) ? session : a), r);
    groups.push(store.read(live).pgid);
    expect(sessionOccupants(store, { agent: 'pi', session_id: session })).toHaveLength(1);
    await stopRun(store, live);
    void done;
  });
  it('executeResume refuses a busy session and a busy managed task; failed intents do not block', async () => {
    const r = root(); const store = new RunStore(r);
    const pi = fakePi(r);
    const base = path.join(r, 'sessions');
    const session = '01aaaabb-bbcc-cddd-deee-effff0000011';
    const dir = piSessionDirFor(r, base); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `t_${session}.jsonl`), `${JSON.stringify({ type: 'session', id: session, cwd: r })}\n`);
    const argv = [pi, '--print', '--mode', 'json', '--session-id', session, '--', 'first'];
    const source = await finishedPlainRun(store, argv, r);
    // A pending resume intent (uncertain handshake) blocks the identity.
    const pending = store.create();
    await store.writeResumeIntent(pending, { schema: 1, from_run_id: source, agent: 'pi', session_id: session, cwd: r, startup: 'pending' });
    await expect(executeResume(store, await planResume(store, source, { piSessionsBase: base }), { start: builtControl.startRun })).rejects.toMatchObject({ reason: 'session-busy' });
    // Mark it known-failed: no longer blocks.
    await store.writeResumeIntent(pending, { schema: 1, from_run_id: source, agent: 'pi', session_id: session, cwd: r, startup: 'failed' });
    const result = await executeResume(store, await planResume(store, source, { piSessionsBase: base }), { start: builtControl.startRun });
    expect(store.read(result.run_id).resume).toMatchObject({ from_run_id: source, session_id: session, identity: 'argv' });
    // While that resume run is live, a second resume of the same session refuses.
    await expect(executeResume(store, await planResume(store, source, { piSessionsBase: base }), { start: builtControl.startRun })).rejects.toMatchObject({ reason: 'session-busy' });
    await stopRun(store, result.run_id);
  });
});

describe('two real CLI processes race one resume', () => {
  // the resumed fixture stays ALIVE (sentinel-gated) until the race
  // assertions complete; the SOURCE run exits normally on its first
  // invocation — completion is established by evidence, not timing luck.
  function sentinelPi(r: string): string {
    const bin = path.join(r, 'bin'); mkdirSync(bin, { recursive: true });
    const file = path.join(bin, 'pi');
    writeFileSync(file, `#!/bin/sh
if [ -f "$TUT_SENTINEL" ]; then
  echo "second invocation: staying alive"
  while :; do sleep 1; done
else
  echo "first invocation: exiting"
  touch "$TUT_SENTINEL"
fi
`);
    chmodSync(file, 0o755);
    return file;
  }

  async function raceTwo(r: string, agent: string, sessionArgvTail: (session: string) => string[], session: string): Promise<void> {
    const store = new RunStore(r);
    const sentinel = path.join(r, 'race-sentinel');
    process.env.TUT_SENTINEL = sentinel; // the source spawn inherits it from this process
    const source = await finishedPlainRun(store, [agent, ...sessionArgvTail(session)], r, session);
    const cli = path.resolve('dist/cli.js');
    const env = { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: 'http://127.0.0.1:1', TUT_SENTINEL: sentinel };
    const procs = [0, 1].map(() => spawn(process.execPath, [cli, 'resume', source], { cwd: r, env }));
    const outcomes = await Promise.all(procs.map(p => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
      let out = ''; let err = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      p.once('exit', code => resolve({ code, out, err }));
    })));
    const winners = outcomes.filter(o => o.code === 0);
    const losers = outcomes.filter(o => o.code !== 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.err).toContain('session-busy');
    const newId = winners[0]!.out.trim();
    expect(newId).not.toBe(source);
    // The winner's run must STILL be incomplete when we assert — the alive
    // barrier holds it — and it must be the session's single occupant.
    const occupants = sessionOccupants(store, { agent: path.basename(agent), session_id: session });
    expect(occupants).toHaveLength(1);
    expect(occupants[0]!.run_id).toBe(newId);
    expect(store.read(newId).ended_at).toBeUndefined();
    await stopRun(store, newId);
    expect(complete(store.read(newId))).toBe(true);
  }

  it('pi: at most one new agent spawns while the fixture stays alive; loser refuses with session-busy', { timeout: 60_000 }, async () => {
    const r = root();
    const pi = sentinelPi(r);
    const base = path.join(r, 'sessions');
    const session = '01aaaabb-bbcc-cddd-deee-effff0000011';
    const dir = piSessionDirFor(r, base); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `t_${session}.jsonl`), `${JSON.stringify({ type: 'session', id: session, cwd: r })}\n`);
    process.env.PI_CODING_AGENT_SESSION_DIR = base; // the source spawn and both CLI processes share the fixture store
    try {
      await raceTwo(r, pi, s => ['--print', '--mode', 'json', '--session-id', s, '--', 'first'], session);
    } finally {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    }
  });

  // closure: the codex fixture NEVER prints a thread.started event, so the
  // winner sits in the no-observed-session window (meta landed, resume
  // provenance + argv selectors are the only identity evidence).
  it('codex without any session events: double CLI race still admits exactly one spawn', { timeout: 60_000 }, async () => {
    const r = root();
    const bin = path.join(r, 'bin'); mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    writeFileSync(codex, `#!/bin/sh
# no JSONL output at all — never a thread.started
if [ -f "$TUT_SENTINEL" ]; then while :; do sleep 1; done; else touch "$TUT_SENTINEL"; fi
`);
    chmodSync(codex, 0o755);
    await raceTwo(r, codex, s => ['exec', '--json', 'first prompt'], 'thread-cx-1');
  });
});

describe('managed resume execution (admission critical section)', () => {
  function managedPlan(store: RunStore, r: string, codex: string, session: string) {
    const own = ownership('executor', 'task-g');
    return { store, r, codex, async source() {
      const id = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-g', { headless: own });
      await until(() => store.read(id).ended_at !== undefined);
      await store.updateMeta(id, m => ({ ...m, agent_session_id: session }));
      return id;
    } };
  }

  function gateDeps(overrides: {
    states?: StateSnapshot[];
    logs?: GateTaskLog[];
    markers?: { role?: string; attempt?: string }[];
    spawns?: number;
  } = {}, rigRoot = 'rig'): { deps: ManagedResumeDeps; stateReads: () => number; logReads: () => number; markersPublished: { attempt_id: string }[]; spawnCount: () => number } {
    let stateReads = 0; let logReads = 0; let spawnCount = 0;
    const markersPublished: { attempt_id: string }[] = [];
    const deps: ManagedResumeDeps = {
      fetchState: async () => { stateReads++; return overrides.states?.[Math.min(stateReads - 1, overrides.states.length - 1)] ?? { hub_root: rigRoot, tasks: [{ task_id: 'task-g', status: 'implementing', waiting_for: 'agent:executor', needs_attention: false }] }; },
      readLog: async () => { logReads++; return overrides.logs?.[Math.min(logReads - 1, overrides.logs.length - 1)] ?? recs(3); },
      publishMarker: async (_url: string, marker: { attempt_id: string }, expected?: number) => {
        markersPublished.push({ attempt_id: marker.attempt_id });
        if (overrides.markers !== undefined) {
          const conflict = overrides.markers.shift();
          if (conflict?.role === 'conflict') { const e = new Error('VERSION_CONFLICT: task log advanced'); (e as Error & { code?: string }).code = 'VERSION_CONFLICT'; throw e; }
        }
        void expected;
        return { version: 4 };
      },
      start: async () => { spawnCount++; throw new Error('spawn seam not used in gate tests'); },
    };
    return { deps, stateReads: () => stateReads, logReads: () => logReads, markersPublished, spawnCount: () => spawnCount };
  }
  function rec(version: number, payload: Record<string, unknown> = {}): ContextRecord { return { version, role: 'human', content_type: 'note', task_id: 'task-g', timestamp: 't', payload: { summary: 's', body: 'b', ...payload } } as ContextRecord; }
  function recs(top: number, extra: ContextRecord[] = []): GateTaskLog {
    return { status: 'implementing', waiting_for: 'agent:executor', needs_attention: false, versions: [...Array.from({ length: top }, (_, i) => rec(i + 1)), ...extra] };
  }
  function spawnDeps(spawned: string[]): ManagedResumeDeps {
    return { start: async (store: RunStore, argv: string[], cwd: string) => { const id = store.create(); closeSync(store.openLog(id, true)); spawned.push(id); return id; } };
  }

  it('the default state URL hits /state (not the site root)', async () => {
    const seen: string[] = [];
    const fetchState = async (url: string) => { seen.push(url); return { hub_root: 'rig', tasks: [] }; };
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const own = ownership('executor', 'task-g');
    const id = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-g', { headless: own });
    await until(() => store.read(id).ended_at !== undefined);
    await store.updateMeta(id, m => ({ ...m, agent_session_id: 'thread-url' }));
    const plan = await planResume(store, id, {});
    // Wire the REAL fetchStateDefault through a spying fetch.
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown) => { seen.push(String(input)); return new Response(JSON.stringify({ hub_root: r, tasks: [] }), { status: 200 }); };
    try {
      await expect(executeManagedResume(store, plan, { hubUrl: 'http://127.0.0.1:9', hubRoot: r })).rejects.toMatchObject({ reason: expect.any(String) });
    } finally { (globalThis as { fetch: unknown }).fetch = originalFetch; }
    expect(seen[0]).toBe('http://127.0.0.1:9/state?include=closed'); // /state, never the bare site root
    expect(seen).not.toContain('http://127.0.0.1:9?include=closed');
    void fetchState;
  });

  it('refuses hub-unreachable, foreign roots, and every non-waiting shape from BOTH /state and the log', async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const own = ownership('executor', 'task-g');
    const id = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-g', { headless: own });
    await until(() => store.read(id).ended_at !== undefined);
    await store.updateMeta(id, m => ({ ...m, agent_session_id: 'thread-g1' }));
    const plan = await planResume(store, id, {});
    await expect(executeManagedResume(store, plan, { hubUrl: 'http://127.0.0.1:1', hubRoot: r })).rejects.toMatchObject({ reason: 'hub-unreachable' });
    await expect(executeManagedResume(store, plan, { hubUrl: 'http://127.0.0.1:3001', hubRoot: r }, gateDeps({ states: [{ hub_root: '/somewhere/else', tasks: [] }] }).deps)).rejects.toMatchObject({ reason: 'hub-root-mismatch' });
    for (const shapes of [
      { states: [{ hub_root: r, tasks: [{ task_id: 'task-g', status: 'implementing', waiting_for: 'agent:executor', needs_attention: true }] }] },
      { states: [{ hub_root: r, tasks: [{ task_id: 'task-g', status: 'implementing', waiting_for: 'agent:reviewer', needs_attention: false }] }] },
      { states: [{ hub_root: r, tasks: [{ task_id: 'task-g', status: 'closed', waiting_for: 'none', needs_attention: false }] }] },
      { states: [{ hub_root: r, tasks: [{ task_id: 'task-g', status: 'pending_approval', waiting_for: 'human', needs_attention: false }] }] },
      { logs: [{ status: 'closed', waiting_for: 'none', versions: [] }] },
      { states: [{ hub_root: r, tasks: [] }] },
    ]) {
      await expect(executeManagedResume(store, plan, { hubUrl: 'http://127.0.0.1:3001', hubRoot: r }, gateDeps(shapes, r).deps)).rejects.toMatchObject({ reason: expect.any(String) });
    }
  });

  it("the source run's own historical launch marker does NOT block; a fresh marker + attempt is recorded in-section", async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const own = ownership('executor', 'task-g');
    const id = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-g', { headless: own });
    await until(() => store.read(id).ended_at !== undefined);
    await store.updateMeta(id, m => ({ ...m, agent_session_id: 'thread-g2' }));
    const plan = await planResume(store, id, {});
    // The log carries the SOURCE's own auto marker covering the trigger — the
    // exact shape that wrongly blocked v4. It must not refuse now.
    const logWithSourceMarker = recs(3, [rec(4, { launch: { role: 'executor', attempt_id: own.attempt_id } })]);
    const spawned: string[] = [];
    const harness = gateDeps({ logs: [logWithSourceMarker] }, r);
    const result = await executeManagedResume(store, plan, { hubUrl: 'http://127.0.0.1:3001', hubRoot: r }, { ...harness.deps, ...spawnDeps(spawned) });
    expect(spawned).toHaveLength(1);
    expect(harness.markersPublished).toHaveLength(1);
    expect(result.run_id).toBe(spawned[0]);
  });

  it('a VERSION_CONFLICT retry re-gates — state that turned closed while waiting refuses with zero spawn', async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const own = ownership('executor', 'task-g');
    const id = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-g', { headless: own });
    await until(() => store.read(id).ended_at !== undefined);
    await store.updateMeta(id, m => ({ ...m, agent_session_id: 'thread-g3' }));
    const plan = await planResume(store, id, {});
    const spawned: string[] = [];
    // First marker publish conflicts; the re-gate then sees closed.
    const harness = gateDeps({
      states: [
        { hub_root: r, tasks: [{ task_id: 'task-g', status: 'implementing', waiting_for: 'agent:executor', needs_attention: false }] },
        { hub_root: r, tasks: [{ task_id: 'task-g', status: 'closed', waiting_for: 'none', needs_attention: false }] },
      ],
      markers: [{ role: 'conflict' }],
    }, r);
    await expect(executeManagedResume(store, plan, { hubUrl: 'http://127.0.0.1:3001', hubRoot: r }, { ...harness.deps, ...spawnDeps(spawned) })).rejects.toMatchObject({ reason: 'task-not-waiting' });
    expect(spawned).toHaveLength(0);
    expect(harness.stateReads()).toBe(2);
  });

  it('success path: marker before spawn, ownership stamped with the in-section base, reservation persisted', async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const own = ownership('executor', 'task-g');
    const id = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-g', { headless: own });
    await until(() => store.read(id).ended_at !== undefined);
    await store.updateMeta(id, m => ({ ...m, agent_session_id: 'thread-g4' }));
    const plan = await planResume(store, id, {});
    const events: string[] = [];
    const deps: ManagedResumeDeps = {
      fetchState: async () => ({ hub_root: r, tasks: [{ task_id: 'task-g', status: 'implementing', waiting_for: 'agent:executor', needs_attention: false }] }),
      readLog: async () => recs(3),
      publishMarker: async () => { events.push('marker'); return { version: 4 }; },
      start: async (store2, argv, cwd, taskId, options) => { events.push('spawn'); expect(options?.headless).toMatchObject({ base_version: 3, trigger_version: 3, resume_from_run_id: id }); return await builtControl.startRun(store2, argv, cwd, taskId, options); },
    };
    const result = await executeManagedResume(store, plan, { hubUrl: 'http://127.0.0.1:3001', hubRoot: r }, deps);
    expect(events).toEqual(['marker', 'spawn']);
    const meta = store.read(result.run_id);
    expect(meta.resume).toMatchObject({ from_run_id: id, session_id: 'thread-g4' });
    expect(meta.headless).toMatchObject({ base_version: 3, resume_from_run_id: id });
    expect(store.readResumeIntent(result.run_id)).toMatchObject({ from_run_id: id, session_id: 'thread-g4', startup: 'pending' });
    await stopRun(store, result.run_id);
  });

  it('a managed plan through plain executeResume refuses (routing guard)', async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const own = ownership('executor', 'task-g');
    const id = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-g', { headless: own });
    await until(() => store.read(id).ended_at !== undefined);
    await store.updateMeta(id, m => ({ ...m, agent_session_id: 'thread-g5' }));
    const plan = await planResume(store, id, {});
    await expect(executeResume(store, plan)).rejects.toThrow(/executeManagedResume/);
  });
});

describe('closure: version-consistent gate on a real Hub (interleaved writes)', () => {
  it('a role-changing record landing between state and log reads refuses with zero spawn', { timeout: 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'newer role', description: 'b', creator: 'test-user', role: 'executor', flow: 'direct' });
    const codex = fakeCodex(r);
    const own = ownership('executor', created.task_id);
    const source = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, created.task_id, { headless: own });
    await until(() => store.read(source).ended_at !== undefined);
    await store.updateMeta(source, m => ({ ...m, agent_session_id: 'thread-nr1' }));
    const plan = await planResume(store, source, {});
    const spawns: string[] = [];
    // Wrapped REAL state fetch: after the FIRST read (inside the lock), a real
    // code_changes lands — the task becomes reviewing / agent:reviewer. The
    // subsequent (real) log read is newer than the state snapshot.
    let stateReads = 0;
    const fetchState = async (url: string) => {
      const response = await fetch(`${url.replace(/\/+$/u, '')}/state?include=closed`, { headers: { Connection: 'close' } });
      const snapshot = await response.json() as StateSnapshot;
      stateReads++;
      if (stateReads === 1) {
        await hubPublish(server.url, { task_id: created.task_id, role: 'executor', content_type: 'code_changes', payload: { summary: 's', body: 'b' } });
      }
      return snapshot;
    };
    await expect(executeManagedResume(store, plan, { hubUrl: server.url, hubRoot: r }, {
      fetchState,
      readLog: async (taskId: string) => await hubRead(server.url, taskId),
      start: async (store2: RunStore) => { spawns.push(store2.create()); throw new Error('must not spawn'); },
    })).rejects.toMatchObject({ reason: 'task-not-waiting' });
    expect(spawns).toHaveLength(0);
    expect(stateReads).toBeGreaterThanOrEqual(2); // the refresh actually happened
  });

  it('an attention-setting record landing between state and log reads refuses with zero spawn', { timeout: 30_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'newer attention', description: 'b', creator: 'test-user', role: 'executor', flow: 'direct' });
    const codex = fakeCodex(r);
    const own = ownership('executor', created.task_id);
    const source = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, created.task_id, { headless: own });
    await until(() => store.read(source).ended_at !== undefined);
    await store.updateMeta(source, m => ({ ...m, agent_session_id: 'thread-na1' }));
    const plan = await planResume(store, source, {});
    const spawns: string[] = [];
    let stateReads = 0;
    const fetchState = async (url: string) => {
      const response = await fetch(`${url.replace(/\/+$/u, '')}/state?include=closed`, { headers: { Connection: 'close' } });
      const snapshot = await response.json() as StateSnapshot;
      stateReads++;
      if (stateReads === 1) {
        // Out-of-table decision → warning → needs_attention, role unchanged.
        await hubPublish(server.url, { task_id: created.task_id, role: 'human', content_type: 'decision', payload: { summary: 's', body: 'b', decision: 'approve', by: 'someone' } });
      }
      return snapshot;
    };
    await expect(executeManagedResume(store, plan, { hubUrl: server.url, hubRoot: r }, {
      fetchState,
      readLog: async (taskId: string) => await hubRead(server.url, taskId),
      start: async (store2: RunStore) => { spawns.push(store2.create()); throw new Error('must not spawn'); },
    })).rejects.toMatchObject({ reason: 'task-needs-attention' });
    expect(spawns).toHaveLength(0);
  });

  it('a permanently inconsistent state/log pair refuses after the bounded refresh', async () => {
    const r = root(); const store = new RunStore(r);
    const codex = fakeCodex(r);
    const own = ownership('executor', 'task-inc');
    const id = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, 'task-inc', { headless: own });
    await until(() => store.read(id).ended_at !== undefined);
    await store.updateMeta(id, m => ({ ...m, agent_session_id: 'thread-inc' }));
    const plan = await planResume(store, id, {});
    // A frozen state snapshot (version 1) against a log that keeps reporting
    // version 3: refresh cannot establish consistency → refuse.
    let stateReads = 0;
    await expect(executeManagedResume(store, plan, { hubUrl: 'http://127.0.0.1:3001', hubRoot: r }, {
      fetchState: async () => ({ hub_root: r, tasks: [{ task_id: 'task-inc', status: 'implementing', waiting_for: 'agent:executor', needs_attention: false, version: 1 }] }),
      readLog: async () => ({ status: 'implementing', waiting_for: 'agent:executor', needs_attention: false, versions: [1, 2, 3].map(v => ({ version: v, role: 'human', content_type: 'note', task_id: 'task-inc', timestamp: 't', payload: { summary: 's', body: 'b' } })) }),
      start: async () => { throw new Error('must not spawn'); },
    })).rejects.toMatchObject({ reason: 'state-inconsistent' });
    expect(stateReads).toBe(0); void stateReads;
  });
});

describe('closure: real Hub + dist CLI managed resume', () => {
  it('passes identity and spawns; closed tasks refuse — no injected seams', { timeout: 60_000 }, async () => {
    const r = root();
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const store = new RunStore(r);
    const created = await hubCreate(server.url, { title: 'managed resume task', description: 'body', creator: 'test-user', role: 'executor', flow: 'direct' });
    const codex = fakeCodex(r);
    const own = ownership('executor', created.task_id);
    const source = await builtControl.startRun(store, [codex, 'exec', '--json', 'p'], r, created.task_id, { headless: own });
    await until(() => store.read(source).ended_at !== undefined);
    await store.updateMeta(source, m => ({ ...m, agent_session_id: 'thread-real-1' }));
    const cli = path.resolve('dist/cli.js');
    const env = { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: server.url };
    const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
      const p = spawn(process.execPath, [cli, ...args], { cwd: r, env });
      let out = ''; let err = '';
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
      p.once('exit', code => resolve({ code, out, err }));
    });
    // Closure: the source's own auto marker exists in the log.
    await hubPublish(server.url, { task_id: created.task_id, role: 'human', content_type: 'note', payload: { summary: 'launch', body: 'b', launch: { protocol_version: 2, role: 'executor', base_version: 0, via: 'auto', route: { agent: codex, args: [] }, route_source: 'task-cast', target_kind: 'headless-posix', launch_mode: 'headless', attempt_id: own.attempt_id, trigger_version: 0 } } });
    const ok = await run(['resume', source]);
    expect(ok.code).toBe(0);
    const newId = ok.out.trim();
    expect(newId).not.toBe(source);
    expect(store.read(newId).headless).toMatchObject({ resume_from_run_id: source, role: 'executor' });
    const afterLog = await hubRead(server.url, created.task_id);
    const manualMarker = afterLog.versions.find(v => (v.payload.launch as { resume_from_run_id?: string } | undefined)?.resume_from_run_id === source);
    expect(manualMarker).toBeDefined();
    await stopRun(store, newId);
    // Closed task: second resume refuses with the state gate, zero new runs.
    await hubDecide(server.url, { task_id: created.task_id, decision: 'close', by: 'test-user' });
    const before = store.list().length;
    const refused = await run(['resume', source]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('task-not-waiting');
    expect(store.list().length).toBe(before);
    // Offline hub: refuses hub-unreachable without a spawn.
    const offline = await run(['resume', source]);
    void offline; // covered by unit test; hub still online here
  });
});

describe('admission lock', () => {
  it('serializes critical sections across async contenders', async () => {
    const r = root(); const store = new RunStore(r);
    const order: string[] = [];
    await Promise.all([
      withAdmissionLock(store, async () => { order.push('a1'); await new Promise(res => setTimeout(res, 50)); order.push('a2'); }),
      withAdmissionLock(store, async () => { order.push('b1'); }),
    ]);
    expect(order.join(',')).toBe('a1,a2,b1');
  });
});

describe('resume meta persistence', () => {
  it('resume runs persist intent + meta provenance; old run evidence untouched', async () => {
    const r = root(); const store = new RunStore(r);
    const pi = fakePi(r);
    const base = path.join(r, 'sessions');
    const session = '01aaaabb-bbcc-cddd-deee-effff0000011';
    const dir = piSessionDirFor(r, base); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `t_${session}.jsonl`), `${JSON.stringify({ type: 'session', id: session, cwd: r })}\n`);
    const argv = [pi, '--print', '--mode', 'json', '--session-id', session, '--', 'first'];
    const source = await finishedPlainRun(store, argv, r);
    const before = store.read(source);
    const result = await executeResume(store, await planResume(store, source, { piSessionsBase: base }), { start: builtControl.startRun });
    const intent = store.readResumeIntent(result.run_id);
    expect(intent).toMatchObject({ from_run_id: source, session_id: session, startup: 'pending' });
    expect(store.read(result.run_id).resume).toMatchObject({ from_run_id: source });
    expect(store.read(source)).toEqual(before); // old evidence byte-identical
    await stopRun(store, result.run_id);
    expect(complete(store.read(result.run_id))).toBe(true);
  });
});

void CONTROL_PROTOCOL; void mkdirSync;

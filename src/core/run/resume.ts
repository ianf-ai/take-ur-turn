/**
 * tut resume planning and execution: continue a COMPLETED
 * run's exact native session in a NEW run — new run-id, log, PID/PGID and
 * attempt; the old log/identity/stop evidence stay untouched.
 *
 * Admission contract (see admission.ts): a resume only spawns when no
 * incomplete run or pending intent holds the same session identity (and, for
 * managed runs, the same task in any role). The verify→reserve→spawn section
 * runs under the rig-wide admission lock; the persisted resume-start intent
 * keeps an uncertain handshake attributable. Nothing here implicitly stops
 * or kills the source run.
 *
 * Session identity:
 *  - codex: the run-observed agent_session_id (thread.started evidence
 *    captured by the supervisor). No blind --last, no fresh fallback.
 *  - pi: headless.designated_session_id, or a --session-id carried by a
 *    TUT-built plain argv — VERIFIED against the project's session store
 *    (exact id + matching cwd) before spawn, because pi's --session-id
 *    silently CREATES a missing session (a fake resume).
 *  - other agents / shell wrappers / unrecoverable argv shapes: explicit
 *    unsupported refusals with reasons.
 */
import { randomUUID } from 'node:crypto';
import { openSync, readSync, closeSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userInfo } from 'node:os';
import { RunStore, complete, validateHeadlessOwnership, type HeadlessOwnership, type ResumeSource, type RunMeta } from './store.js';
import { requirePosix, startRun, StartRunError } from './control.js';
import { sessionOccupants, taskOccupants, withAdmissionLock, type SessionIdentity } from './admission.js';
import { codexArgv } from '../../standalone/launcher-headless/codex-argv.js';
import { nativeArgv } from '../../standalone/launcher-headless/plan.js';
import type { ContextRecord } from '../common/types.js';

export class ResumeError extends Error {
  constructor(message: string, readonly reason: string) { super(message); this.name = 'ResumeError'; }
}

export interface SessionHandle {
  agent: string;
  session_id: string;
  source: ResumeSource['identity'];
}

export interface ResumePlan {
  from: RunMeta;
  from_run_id: string;
  cwd: string;
  argv: string[];
  prompt: string;
  session: SessionHandle;
  task_id?: string;
  managed: boolean;
  /** Rebuilt ownership for managed resumes; base/trigger versions are filled
   *  by the managed gate (they must reflect a fresh log read). */
  headless?: Omit<HeadlessOwnership, 'base_version' | 'trigger_version'> & { base_version?: number; trigger_version?: number };
  env: NodeJS.ProcessEnv;
  resume: ResumeSource;
}

export interface PlanResumeOptions {
  instruction?: string;
  hubUrl?: string;
  eventUrl?: string;
  now?: () => Date;
  /** Base of the pi session store (default ~/.pi/agent/sessions; test seam). */
  piSessionsBase?: string;
  env?: NodeJS.ProcessEnv;
}

const CONTINUATION_PROMPT = '继续这个 run 的工作：先核对并简要说明已有结果（本会话此前已完成的部分），然后继续原范围内尚未完成的工作；不要重新开始已经完成的部分。';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function requestedBy(): string {
  return `${userInfo().username}:pid=${process.pid}`;
}

// --- pi session store verification -------------------------------------------

/** pi encodes a cwd as `--<cwd with [\\/:] as '-'>--` under the session base
 *  (pi resolves the cwd first — realpath when it exists, resolve otherwise). */
export function piSessionDirFor(cwd: string, base: string): string {
  let resolved: string;
  try { resolved = realpathSync(path.resolve(cwd)); } catch { resolved = path.resolve(cwd); }
  const safe = `--${resolved.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
  return path.join(base, safe);
}

export interface PiSessionHead { id: string; cwd?: string }

/** Read the FIRST line of one session file: the session header carries id and
 *  cwd. Only the head is read (bounded); no session bodies, no other projects. */
export function readPiSessionHead(file: string): PiSessionHead | undefined {
  try {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const n = readSync(fd, buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, n).indexOf(10);
      const line = (newline === -1 ? buffer.subarray(0, n) : buffer.subarray(0, newline)).toString('utf8');
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'session') {
        const id = (parsed as { id?: unknown }).id;
        const cwd = (parsed as { cwd?: unknown }).cwd;
        if (typeof id === 'string') return { id, ...(typeof cwd === 'string' ? { cwd } : {}) };
      }
      return undefined;
    } finally { closeSync(fd); }
  } catch { return undefined; }
}

/** Verify an exact pi session exists for THIS project cwd. A missing or
 *  cross-project id is a refusal — never a fresh-session fallback. */
export function verifyPiSession(base: string, cwd: string, sessionId: string): { ok: true; file: string } | { ok: false; reason: string } {
  const dir = piSessionDirFor(cwd, base);
  let entries: string[];
  try {
    entries = readdirSync(dir).filter(name => name.endsWith('.jsonl'));
  } catch {
    return { ok: false, reason: `no pi session store for this project (${dir}) — cannot confirm session ${sessionId}` };
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    const head = readPiSessionHead(file);
    if (head?.id === sessionId) {
      if (head.cwd !== undefined && path.resolve(head.cwd) !== path.resolve(cwd)) {
        return { ok: false, reason: `session ${sessionId} belongs to another project (cwd ${head.cwd})` };
      }
      return { ok: true, file };
    }
  }
  return { ok: false, reason: `pi session ${sessionId} not found in ${dir} (pi --session-id would CREATE a new session — refusing)` };
}

// --- plain argv reconstruction -------------------------------------------------

export interface PlainCodexParse { agent: string; optionTokens: string[] }

/** Conservatively parse a plain `codex [exec] [opts] [session] prompt` argv.
 *  Exactly the shapes TUT itself builds parse; anything ambiguous refuses. */
export function parsePlainCodexArgv(argv: readonly string[]): PlainCodexParse {
  const agent = argv[0]!;
  const valueOptions = new Set(['-m', '--model', '-c', '--config', '-s', '--sandbox', '-a', '--ask-for-approval', '-p', '--profile',
    '--enable', '--disable', '--add-dir', '--local-provider', '--thread-source', '--cyber-access-program', '--output-schema', '-o', '--output-last-message', '--color']);
  const flagOptions = new Set(['--strict-config', '--oss', '--search', '--no-daemon', '--approve-for-me', '--skip-git-repo-check',
    '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json', '--dangerously-bypass-hook-trust']);
  const optionTokens: string[] = [];
  const positionals: string[] = [];
  let sawExec = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === 'exec' && !sawExec) { sawExec = true; continue; }
    if (token === 'resume') continue; // session selector segment is replaced wholesale
    const option = token.split('=', 1)[0]!;
    const attached = token.includes('=');
    if (valueOptions.has(option) || flagOptions.has(option)) {
      optionTokens.push(token);
      if (valueOptions.has(option) && !attached) {
        const value = argv[++i];
        if (value === undefined) throw new ResumeError(`unsupported plain codex argv: missing value for ${option}`, 'codex-argv-unrecoverable');
        optionTokens.push(value);
      }
      continue;
    }
    if (token.startsWith('-') || (token.startsWith('--') && token.length > 2)) {
      throw new ResumeError(`unsupported plain codex argv option: ${token} (unknown option — refusing to guess its scope)`, 'codex-argv-unrecoverable');
    }
    positionals.push(token);
  }
  // codex exec takes at most one prompt (fresh) or session+prompt (resume);
  // `resume` tokens were skipped above, so any extra positional is ambiguous.
  const expected = argv.includes('resume') ? 2 : 1;
  if (positionals.length > expected) {
    throw new ResumeError(`unsupported plain codex argv: ${positionals.length} positional arguments — cannot tell prompt from session selectors`, 'codex-argv-unrecoverable');
  }
  return { agent, optionTokens };
}

export interface PlainPiParse { agent: string; head: string[]; session_id: string }

/** Conservatively parse a plain pi argv built by TUT (`--session-id <uuid> --
 *  prompt`). Selector/ephemeral/unknown shapes refuse explicitly. */
export function parsePlainPiArgv(argv: readonly string[]): PlainPiParse {
  const agent = argv[0]!;
  const selector = /^(--(?:continue|resume|session|session-id|fork|no-session|session-dir)|-[cr])(?:=|$)/u;
  const valueOptions = new Set(['--provider', '--model', '--api-key', '--system-prompt', '--append-system-prompt', '--name', '-n',
    '--models', '--tools', '-t', '--exclude-tools', '-xt', '--thinking', '--extension', '-e', '--skill', '--prompt-template',
    '--theme', '--use-theme', '--tui-mode', '--mode']);
  const flagOptions = new Set(['--print', '-p']);
  let sessionIndex = -1;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') break; // everything after belongs to the prompt
    if (token === '--session-id') {
      if (sessionIndex !== -1) throw new ResumeError('unsupported plain pi argv: duplicate --session-id', 'pi-argv-unrecoverable');
      sessionIndex = i;
      const value = argv[++i];
      if (value === undefined || !UUID_RE.test(value)) throw new ResumeError('unsupported plain pi argv: --session-id without an exact uuid', 'pi-argv-unrecoverable');
      continue;
    }
    if (selector.test(token)) {
      throw new ResumeError(`unsupported plain pi argv selector: ${token} (only TUT-built --session-id forms are resumable)`, 'pi-argv-unrecoverable');
    }
    if (valueOptions.has(token)) {
      const value = argv[++i];
      if (value === undefined) throw new ResumeError(`unsupported plain pi argv: missing value for ${token}`, 'pi-argv-unrecoverable');
      continue;
    }
    if (flagOptions.has(token)) continue;
    if (token.startsWith('-')) {
      throw new ResumeError(`unsupported plain pi argv option: ${token}`, 'pi-argv-unrecoverable');
    }
    throw new ResumeError(`unsupported plain pi argv positional: ${token} (only the trailing prompt after -- is positional)`, 'pi-argv-unrecoverable');
  }
  if (sessionIndex === -1) throw new ResumeError('plain pi run carries no exact --session-id identity; not resumable', 'pi-identity-unavailable');
  // The head must be exactly argv[0..sessionIndex): everything between the
  // session id and `--` would be a prompt fragment we cannot replace safely.
  const afterSession = argv.slice(sessionIndex + 2);
  if (!(afterSession[0] === '--')) {
    throw new ResumeError('unsupported plain pi argv: tokens between --session-id and the prompt separator', 'pi-argv-unrecoverable');
  }
  return { agent, head: argv.slice(0, sessionIndex), session_id: argv[sessionIndex + 1]! };
}

// --- planning -------------------------------------------------------------------

export async function planResume(store: RunStore, fromRunId: string, opts: PlanResumeOptions = {}): Promise<ResumePlan> {
  requirePosix();
  let from: RunMeta;
  try {
    from = store.read(fromRunId);
  } catch (e) {
    throw new ResumeError(`source run ${fromRunId} is unreadable: ${(e as Error).message}`, 'source-unreadable');
  }
  if (!complete(from)) {
    const reason = from.status === 'running' ? 'source-run-active'
      : from.stop_request && !from.stop_request.result ? 'source-stop-incomplete'
      : 'source-run-incomplete';
    throw new ResumeError(`source run ${fromRunId} has no completion evidence (status=${from.status}${from.ended_at ? '' : ', no ended_at'}${from.stop_request ? `, stop ${from.stop_request.phase}` : ''}); resume accepts only completed runs — never implicitly stops the source`, reason);
  }
  const agent = path.basename(from.argv[0] ?? '');
  const managed = from.headless !== undefined;
  let session: SessionHandle;

  if (agent === 'codex') {
    if (!from.agent_session_id) {
      throw new ResumeError(`source run ${fromRunId} (codex) recorded no observed agent_session_id; exact session identity unavailable`, 'codex-session-unavailable');
    }
    session = { agent: 'codex', session_id: from.agent_session_id, source: 'observed' };
  } else if (agent === 'pi') {
    let id: string | undefined;
    let source: SessionHandle['source'];
    if (from.headless?.designated_session_id) { id = from.headless.designated_session_id; source = 'designated'; }
    else {
      try {
        const parsed = parsePlainPiArgv(from.argv);
        id = parsed.session_id;
        source = 'argv';
      } catch (e) {
        if (e instanceof ResumeError && e.reason === 'pi-identity-unavailable') {
          throw new ResumeError(`source run ${fromRunId} (pi) carries no exact session identity; not resumable`, 'pi-identity-unavailable');
        }
        throw e;
      }
    }
    const base = opts.piSessionsBase ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? path.join(os.homedir(), '.pi', 'agent', 'sessions');
    const verified = verifyPiSession(base, from.cwd, id);
    if (!verified.ok) throw new ResumeError(verified.reason, 'pi-session-not-found');
    session = { agent: 'pi', session_id: id, source: source! };
  } else {
    throw new ResumeError(`source run ${fromRunId} agent '${agent || '(none)'}' is not resumable: only codex/pi native sessions are supported; shell wrappers and unknown agents refuse explicitly`, 'unsupported-agent');
  }

  const prompt = opts.instruction !== undefined ? opts.instruction
    : managed ? `轮到你了（role: ${from.headless!.role}）：请用 Context Hub 读取任务 ${from.task_id} 的完整上下文（context.read），按你的 role skill 开始本轮工作，完成后发布相应记录（context.publish）。`
    : CONTINUATION_PROMPT;

  let argv: string[];
  if (managed) {
    argv = nativeArgv(from.headless!.route, prompt, session.session_id);
  } else if (agent === 'codex') {
    const parsed = parsePlainCodexArgv(from.argv);
    argv = codexArgv(parsed.agent, parsed.optionTokens, prompt, session.session_id);
  } else {
    const parsed = parsePlainPiArgv(from.argv);
    argv = [...parsed.head, '--session-id', session.session_id, '--', prompt];
  }

  const env = managed
    ? { ...(opts.env ?? process.env), TUT_HUB_ROOT: store.hubRoot, ...(opts.hubUrl !== undefined ? { TUT_HUB_URL: opts.hubUrl } : {}), ...(opts.eventUrl !== undefined ? { TUT_EVENT_PORT_URL: opts.eventUrl } : {}) }
    : (opts.env ?? process.env);

  const resume: ResumeSource = {
    schema: 1,
    from_run_id: fromRunId,
    agent,
    session_id: session.session_id,
    identity: session.source,
    requested_at: (opts.now ?? (() => new Date()))().toISOString(),
    requested_by: requestedBy(),
    ...(from.task_id !== undefined ? { task_id: from.task_id } : {}),
  };

  let headless: ResumePlan['headless'];
  if (managed) {
    const source = from.headless!;
    headless = {
      schema: 1,
      role: source.role,
      attempt_id: randomUUID(),
      route: source.route,
      route_source: source.route_source,
      session_reason: `resume: manual continuation of run ${fromRunId}`,
      resume_from_run_id: fromRunId,
      ...(agent === 'pi' ? { designated_session_id: session.session_id } : {}),
    };
  }

  return {
    from,
    from_run_id: fromRunId,
    cwd: from.cwd,
    argv,
    prompt,
    session,
    ...(from.task_id !== undefined ? { task_id: from.task_id } : {}),
    managed,
    ...(headless !== undefined ? { headless } : {}),
    env,
    resume,
  };
}

// --- managed gate + execution (one admission critical section) ----------------

export interface GateTaskLog {
  status?: string;
  waiting_for?: string;
  needs_attention?: boolean;
  versions: readonly ContextRecord[];
}

export interface ManagedResumeDeps {
  fetchState?: typeof fetchStateDefault;
  readLog?: (taskId: string) => Promise<GateTaskLog>;
  publishMarker?: (hubUrl: string, marker: {
    task_id: string; role: string; attempt_id: string; base_version: number; trigger_version: number;
    resume_from_run_id: string; route: { agent: string; args: string[] }; route_source: string;
  }, expectedVersion?: number) => Promise<{ version: number }>;
  start?: typeof startRun;
}

export interface StateTaskEntry {
  task_id?: unknown;
  status?: unknown;
  waiting_for?: unknown;
  needs_attention?: unknown;
  /** The log version /state's fold has processed; used for version
   *  consistency against a (possibly newer) log read. */
  version?: unknown;
}

export type StateSnapshot = { hub_root?: unknown; tasks?: StateTaskEntry[] };

async function fetchStateDefault(url: string): Promise<StateSnapshot> {
  const stateUrl = `${url.replace(/\/+$/u, '')}/state?include=closed`;
  const response = await fetch(stateUrl, { signal: AbortSignal.timeout(2000), redirect: 'error', headers: { Connection: 'close' } });
  if (!response.ok) throw new Error(`Hub state HTTP ${response.status} at ${stateUrl}`);
  return await response.json() as StateSnapshot;
}

function canonical(root: string): string {
  const resolved = path.resolve(root);
  try { return realpathSync(resolved); } catch { return resolved; }
}

/** Fresh in-lock state gate: same-root Hub online, task still waiting for
 *  the SAME role, no attention, not pending_approval/approved/closed — in
 *  BOTH the /state snapshot and the freshly read log (a log read can be
 *  newer than a polled /state entry; both must agree). */
function verifyManagedGate(plan: ResumePlan, input: { hubUrl: string; hubRoot: string }, state: StateSnapshot, log: GateTaskLog): void {
  if (plan.headless === undefined || plan.task_id === undefined) throw new Error('verifyManagedGate requires a managed plan');
  const hubRoot = state.hub_root;
  if (typeof hubRoot !== 'string' || !path.isAbsolute(hubRoot) || canonical(hubRoot) !== canonical(input.hubRoot)) {
    throw new ResumeError(`Hub at ${input.hubUrl} serves a different root (${String(hubRoot)}); refusing cross-root managed resume`, 'hub-root-mismatch');
  }
  const entry = state.tasks?.find(t => t.task_id === plan.task_id);
  if (entry === undefined) throw new ResumeError(`task ${plan.task_id} not visible on the Hub (degraded or foreign rig)`, 'task-unavailable');
  const refuseStatus = (where: string, status: string): ResumeError =>
    new ResumeError(`task ${plan.task_id} is ${status} (${where}); managed resume refused`, 'task-not-waiting');
  for (const [where, status] of [['/state', entry.status], ['task log', log.status]] as const) {
    if (typeof status === 'string' && ['pending_approval', 'approved', 'closed'].includes(status)) throw refuseStatus(where, status);
  }
  if (entry.needs_attention === true || log.needs_attention === true) throw new ResumeError(`task ${plan.task_id} has needs_attention set`, 'task-needs-attention');
  if (entry.waiting_for !== `agent:${plan.headless.role}`) {
    throw new ResumeError(`task ${plan.task_id} waits for '${String(entry.waiting_for)}', not agent:${plan.headless.role}; the run's round is no longer current`, 'task-not-waiting');
  }
}

async function publishManualMarker(
  hubUrl: string,
  marker: {
    task_id: string; role: string; attempt_id: string; base_version: number; trigger_version: number;
    resume_from_run_id: string; route: { agent: string; args: string[] }; route_source: string;
  },
  expectedVersion?: number,
): Promise<{ version: number }> {
  const { hubPublish } = await import('../hub/hub-client.js');
  const result = await hubPublish(hubUrl, {
    task_id: marker.task_id,
    role: 'human',
    content_type: 'note',
    ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
    payload: {
      summary: `launch: ${marker.role} resume (base v${marker.base_version})`,
      body: `Recorded manual resume launch of ${marker.role} for run ${marker.resume_from_run_id} via tut resume; attempt_id=${marker.attempt_id}. Operational marker recorded by tut — not a human approval or authorization.`,
      launch: {
        protocol_version: 2,
        role: marker.role,
        base_version: marker.base_version,
        via: 'manual',
        route: marker.route,
        route_source: marker.route_source,
        target_kind: 'headless-posix',
        launch_mode: 'headless',
        attempt_id: marker.attempt_id,
        trigger_version: marker.trigger_version,
        resume_from_run_id: marker.resume_from_run_id,
      },
    },
  });
  return { version: result.version };
}

/** Managed resume execution — the ENTIRE verify→reserve→spawn sequence runs
 *  under the rig admission lock: fresh state + log gate, occupancy
 *  scan, manual marker (optimistic, one bounded retry that RE-GATES), then
 *  spawn with the persisted reservation. A historical launch marker of a
 *  COMPLETED attempt never blocks an explicit manual resume: its
 *  in-flight concurrency is admission's job, and auto candidates keep their
 *  own generation dedup on the appended markers. */
export async function executeManagedResume(
  store: RunStore,
  plan: ResumePlan,
  input: { hubUrl: string; hubRoot: string },
  deps: ManagedResumeDeps = {},
): Promise<ResumeExecResult> {
  if (!plan.managed || plan.headless === undefined || plan.task_id === undefined) throw new Error('executeManagedResume requires a managed plan');
  const fetchState = deps.fetchState ?? fetchStateDefault;
  const readLog = deps.readLog ?? (async (taskId: string) => {
    const { hubRead } = await import('../hub/hub-client.js');
    return await hubRead(input.hubUrl, taskId);
  });
  const publishMarker = deps.publishMarker ?? publishManualMarker;
  const start = deps.start ?? startRun;
  const identity: SessionIdentity = { agent: plan.session.agent, session_id: plan.session.session_id };

  return await withAdmissionLock(store, async () => {
    // Bounded verify loop: the gate must be established from a
    // VERSION-CONSISTENT pair of (state snapshot, log read). A log that is
    // newer than the /state fold (a record landed between the two reads)
    // refreshes the state once; a marker conflict re-gates the same way. A
    // consistent pair that cannot be established refuses — a stale gate
    // never authorizes a spawn.
    for (let attempt = 0; attempt < 3; attempt++) {
      let state: StateSnapshot;
      try {
        state = await fetchState(input.hubUrl);
      } catch (e) {
        throw new ResumeError(`managed resume requires the same-root Hub online: ${(e as Error).message}`, 'hub-unreachable');
      }
      // Root verification precedes task lookup so a foreign hub reports as a
      // root mismatch, not as a missing task.
      const hubRootValue = state.hub_root;
      if (typeof hubRootValue !== 'string' || !path.isAbsolute(hubRootValue) || canonical(hubRootValue) !== canonical(input.hubRoot)) {
        throw new ResumeError(`Hub at ${input.hubUrl} serves a different root (${String(hubRootValue)}); refusing cross-root managed resume`, 'hub-root-mismatch');
      }
      const entry = state.tasks?.find(t => t.task_id === plan.task_id);
      if (entry === undefined) throw new ResumeError(`task ${plan.task_id} not visible on the Hub (degraded or foreign rig)`, 'task-unavailable');
      let log: GateTaskLog;
      try {
        log = await readLog(plan.task_id!);
      } catch (e) {
        throw new ResumeError(`cannot read task ${plan.task_id}: ${(e as Error).message}`, 'task-unreadable');
      }
      verifyManagedGate(plan, input, state, log);
      let base = 0;
      for (const record of log.versions) base = Math.max(base, record.version);
      const stateVersion = entry.version;
      if (typeof stateVersion === 'number' && Number.isSafeInteger(stateVersion) && base > stateVersion) {
        if (attempt < 2) continue; // the log is newer than the fold snapshot — refresh once, bounded
        throw new ResumeError(`cannot establish a version-consistent gate for ${plan.task_id}: the task log (v${base}) kept advancing past /state (v${stateVersion}); re-observe and retry`, 'state-inconsistent');
      }
      const sessionBusy = sessionOccupants(store, identity);
      if (sessionBusy.length > 0) {
        throw new ResumeError(`session ${plan.session.agent}/${plan.session.session_id} is held by: ${sessionBusy.map(o => `${o.run_id} (${o.detail})`).join(', ')}`, 'session-busy');
      }
      const taskBusy = taskOccupants(store, plan.task_id!);
      if (taskBusy.length > 0) {
        throw new ResumeError(`task ${plan.task_id} still has incomplete runs: ${taskBusy.map(o => `${o.run_id} (${o.detail})`).join(', ')}`, 'task-busy');
      }
      try {
        await publishMarker(input.hubUrl, {
          task_id: plan.task_id!,
          role: plan.headless!.role,
          attempt_id: plan.headless!.attempt_id,
          base_version: base,
          trigger_version: base,
          resume_from_run_id: plan.from_run_id,
          route: plan.headless!.route,
          route_source: plan.headless!.route_source,
        }, base);
      } catch (e) {
        const message = (e as Error).message;
        if ((e as { code?: string }).code === 'VERSION_CONFLICT' || message.includes('VERSION_CONFLICT')) {
          if (attempt < 2) continue; // bounded re-gate + retry under the same lock
          throw new ResumeError(`launch marker version conflict on ${plan.task_id}: the log kept advancing (another writer won); re-observe and retry`, 'marker-conflict');
        }
        throw new ResumeError(`launch marker publish failed: ${message}`, 'marker-failed');
      }
      const ownership: HeadlessOwnership = { ...plan.headless!, base_version: base, trigger_version: base } as HeadlessOwnership;
      validateHeadlessOwnership(ownership);
      try {
        const run_id = await start(store, plan.argv, plan.cwd, plan.task_id, { env: plan.env, headless: ownership, resume: plan.resume });
        return { run_id };
      } catch (e) {
        if (e instanceof StartRunError) {
          throw new ResumeError(`resume spawn failed for source ${plan.from_run_id}: ${e.message}${e.uncertain ? ' (startup UNCERTAIN — inspect the run, do not retry blindly)' : ''}`, e.uncertain ? 'spawn-uncertain' : 'spawn-failed');
        }
        throw e;
      }
    }
    throw new Error('unreachable');
  });
}

// --- execution (plain runs) ------------------------------------------------------

export interface ResumeExecResult { run_id: string }

export interface ResumeExecOptions {
  /** Spawn seam (tests inject the built dist module's startRun). */
  start?: typeof startRun;
}

/** Admit + spawn for PLAIN runs. The admission lock bounds verify→reserve→
 *  spawn; the resume intent persists before the fork (inside the lock). */
export async function executeResume(store: RunStore, plan: ResumePlan, options: ResumeExecOptions = {}): Promise<ResumeExecResult> {
  if (plan.managed) throw new Error('managed plans use executeManagedResume');
  const identity: SessionIdentity = { agent: plan.session.agent, session_id: plan.session.session_id };
  return await withAdmissionLock(store, async () => {
    const sessionBusy = sessionOccupants(store, identity);
    if (sessionBusy.length > 0) {
      throw new ResumeError(`session ${plan.session.agent}/${plan.session.session_id} is held by: ${sessionBusy.map(o => `${o.run_id} (${o.detail})`).join(', ')}`, 'session-busy');
    }
    try {
      const run_id = await (options.start ?? startRun)(store, plan.argv, plan.cwd, plan.task_id, {
        env: plan.env,
        resume: plan.resume,
      });
      return { run_id };
    } catch (e) {
      if (e instanceof StartRunError) {
        throw new ResumeError(`resume spawn failed for source ${plan.from_run_id}: ${e.message}${e.uncertain ? ' (startup UNCERTAIN — inspect the run, do not retry blindly)' : ''}`, e.uncertain ? 'spawn-uncertain' : 'spawn-failed');
      }
      throw e;
    }
  });
}

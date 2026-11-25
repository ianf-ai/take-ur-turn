/** Explicit continuation of a completed run. Authorization, completion and
 * verify→reserve→spawn admission remain here; native identity policy is agents'. */
import {realpathSync} from 'node:fs';
import {resolveResumeContract,contractSource,selectSession,verifySession,prepareInvocation,encodeContract,
 SessionContractError as ResumeError,type ContractHandle,type ExactSessionRef,type SessionPlan,type SessionReadServices} from '../../agents/public/index.js';
import {sessionReadServices} from './session-services.js';
export {SessionContractError as ResumeError,parsePlainCodexArgv,parsePlainPiArgv,parsePlainOpencodeArgv,
 piSessionDirFor,readPiSessionHead,verifyPiSession,type PiSessionHead,type PlainCodexParse,type PlainPiParse,type PlainOpencodeParse} from '../../agents/public/index.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { userInfo } from 'node:os';
import { RunStore, complete, validateHeadlessOwnership, type HeadlessOwnership, type ResumeSource, type RunMeta } from './store.js';
import { startRun, StartRunError } from './control.js';
import { requireHeadlessPlatform } from './platform.js';
import type { WindowsOwnership } from './windows-launch.js';
import { sessionOccupants, taskOccupants, withAdmissionLock, type SessionIdentity } from './admission.js';
import type { ContextRecord } from '../../protocol/types.js';
import { worktreeGitEnvironment } from '../launcher/worktree-git.js';

export interface SessionHandle {
  agent: string;
  session_id: string;
  source: ResumeSource['identity'];
}

export interface ResumePlan {
  profile?: ContractHandle;
  sessionRef?: ExactSessionRef;
  sessionReads?: SessionReadServices;
  sessionPlan?: import('../../agents/public/index.js').ReadyInvocation['sessionPlan'];
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
  headless?: Omit<WindowsOwnership, 'base_version' | 'trigger_version'> & { base_version?: number; trigger_version?: number };
  target_kind?: 'headless-posix' | 'headless-windows';
  target_digest?: string;
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
  platform?: NodeJS.Platform;
}

const CONTINUATION_PROMPT = '继续这个 run 的工作：先核对并简要说明已有结果（本会话此前已完成的部分），然后继续原范围内尚未完成的工作；不要重新开始已经完成的部分。';

function requestedBy(): string {
  return `${userInfo().username}:pid=${process.pid}`;
}

// --- planning -------------------------------------------------------------------

export async function planResume(store: RunStore, fromRunId: string, opts: PlanResumeOptions = {}): Promise<ResumePlan> {
  const platform = opts.platform ?? process.platform;
  requireHeadlessPlatform(platform);
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
  const windowsPlan = platform === 'win32' ? await import('./windows-launch.js') : undefined;
  const windows = windowsPlan && from.headless ? windowsPlan.readWindowsLaunch(from.headless) : undefined;
  if (platform === 'win32' && !windows) throw new ResumeError('Windows resume requires a managed run with frozen logical/physical identity', 'windows-launch-unavailable');
  const resolved=resolveResumeContract(from,()=>contractSource(store.hubRoot),platform==='win32'?'win32':'posix');
  if(resolved.status!=='resolved')throw new ResumeError(resolved.reason,resolved.code);
  const profile=resolved.handle,managed=from.headless!==undefined;
  const selected=selectSession(profile,from);
  if(selected.status!=='selected'&&selected.status!=='verified') {
    if(selected.status==='unavailable')throw new ResumeError('RESUME_UNAVAILABLE: native resume not configured','RESUME_UNAVAILABLE');
    throw new ResumeError(selected.reason??'exact session identity unavailable',selected.code??'session-unavailable');
  }
  const reads=sessionReadServices({nativeSessionBase:opts.piSessionsBase,env:opts.env});
  const verified=await verifySession(profile,selected.session,reads);
  if(verified.status!=='verified')throw new ResumeError('reason' in verified?verified.reason:'exact session identity unavailable','code' in verified?verified.code??'SESSION_INVALID':'RESUME_UNAVAILABLE');
  const sessionRef=verified.session;
  const session:SessionHandle={agent:profile.identity,session_id:sessionRef.session_id,source:sessionRef.identity_source};

  const prompt = opts.instruction !== undefined ? opts.instruction
    : managed ? `轮到你了（role: ${from.headless!.role}）：请用 Context Hub 读取任务 ${from.task_id} 的完整上下文（context.read），按你的 role skill 开始本轮工作，完成后发布相应记录（context.publish）。`
    : CONTINUATION_PROMPT;

  const result=await prepareInvocation(profile,{mode:'resume',route:sessionRef.route,checkoutRoot:from.cwd,prompt,entry:'manual',
    environmentFacts:{home:os.homedir(),env:opts.env??process.env,...(windows?{windows_target:windows.target}:{})},sessionRef,
    ...(managed?{origin:'managed' as const}:{origin:'plain-legacy' as const,plain:{source_run_id:from.run_id,argv:from.argv}})});
  if(result.status!=='ready')throw new ResumeError(result.reason,result.status==='invalid'?result.code:'RESUME_UNAVAILABLE');
  const invocation=result.invocation;
  const argv=[invocation.executable,...invocation.argv];
  if(windows){windows.logical_argv=invocation.logicalArgv;if(invocation.sessionPlan.store)windows.pi_session={...invocation.sessionPlan.store,session_id:session.session_id};}
  const env: NodeJS.ProcessEnv = managed
    ? { ...(opts.env ?? process.env), TUT_HUB_ROOT: store.hubRoot, ...(opts.hubUrl !== undefined ? { TUT_HUB_URL: opts.hubUrl } : {}), ...(opts.eventUrl !== undefined ? { TUT_EVENT_PORT_URL: opts.eventUrl } : {}), ...worktreeGitEnvironment({ hubRoot: store.hubRoot, checkoutRoot: from.cwd }) }
    : { ...(opts.env ?? process.env) };
  Object.assign(env,invocation.envPatch);

  const resume: ResumeSource = {
    schema: 1,
    from_run_id: fromRunId,
    agent:session.agent,
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
      contract:encodeContract(profile),
      session_identity:{agent:profile.identity,session_id:session.session_id},
      schema: 1,
      role: source.role,
      attempt_id: randomUUID(),
      route: source.route,
      route_source: source.route_source,
      session_reason: `resume: manual continuation of run ${fromRunId}`,
      resume_from_run_id: fromRunId,
      ...(invocation.sessionPlan.designated_id ? { designated_session_id: invocation.sessionPlan.designated_id } : {}),
      ...(windows ? { windows } : {}),
    };
  }

  return {
    profile,sessionRef,sessionReads:reads,
    sessionPlan:invocation.sessionPlan,
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
    ...(windows ? { target_kind: 'headless-windows' as const, target_digest: windowsPlan!.windowsLaunchDigest(store.hubRoot, from.cwd, argv) } : {}),
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
    target_kind?: 'headless-posix' | 'headless-windows'; target_digest?: string;
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
    target_kind?: 'headless-posix' | 'headless-windows'; target_digest?: string;
  },
  expectedVersion?: number,
): Promise<{ version: number }> {
  const { hubPublish } = await import('../../hub/hub-client.js');
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
        target_kind: marker.target_kind ?? 'headless-posix',
        ...(marker.target_digest ? { target_digest: marker.target_digest } : {}),
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
    const { hubRead } = await import('../../hub/hub-client.js');
    return await hubRead(input.hubUrl, taskId);
  });
  const publishMarker = deps.publishMarker ?? publishManualMarker;
  const start = deps.start ?? startRun;
  const identity: SessionIdentity = { agent: plan.session.agent, session_id: plan.session.session_id };

  return await withAdmissionLock(store, async () => {
    await reverifyResume(store,plan);
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
      await reverifyResume(store,plan);
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
          ...(plan.target_kind ? { target_kind: plan.target_kind } : {}),
          ...(plan.target_digest ? { target_digest: plan.target_digest } : {}),
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
        const run_id = await start(store, plan.argv, plan.cwd, plan.task_id, { ...(plan.profile?{profile:encodeContract(plan.profile)}:{}),env: plan.env, headless: ownership, resume: plan.resume });
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
    await reverifyResume(store,plan);
    const sessionBusy = sessionOccupants(store, identity);
    if (sessionBusy.length > 0) {
      throw new ResumeError(`session ${plan.session.agent}/${plan.session.session_id} is held by: ${sessionBusy.map(o => `${o.run_id} (${o.detail})`).join(', ')}`, 'session-busy');
    }
    try {
      const run_id = await (options.start ?? startRun)(store, plan.argv, plan.cwd, plan.task_id, {
        ...(plan.profile?{profile:encodeContract(plan.profile)}:{}),
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

/** Re-read completion and native evidence after waiting for the admission lock. */
async function reverifyResume(store:RunStore,plan:ResumePlan):Promise<void> {
 const source=store.read(plan.from_run_id);
 if(!complete(source))throw new ResumeError('source completion changed before spawn','source-run-incomplete');
 if(source.task_id!==plan.from.task_id||source.task_id!==plan.task_id||source.cwd!==plan.from.cwd||JSON.stringify(source.argv)!==JSON.stringify(plan.from.argv)||JSON.stringify(source.headless)!==JSON.stringify(plan.from.headless)||source.contract!==plan.from.contract)throw new ResumeError('source launch identity changed before spawn','SESSION_SOURCE_INVALID');
 if(plan.profile&&plan.sessionRef) {
  const selected=selectSession(plan.profile,source);
  if(selected.status!=='selected'||selected.session.session_id!==plan.sessionRef.session_id||selected.session.identity_source!==plan.sessionRef.identity_source)throw new ResumeError('source session identity changed before spawn','SESSION_SOURCE_INVALID');
  const result=await verifySession(plan.profile,plan.sessionRef,plan.sessionReads??sessionReadServices());
  if(result.status!=='verified')throw new ResumeError('reason' in result?result.reason:'session verification failed','code' in result?result.code??'SESSION_INVALID':'RESUME_UNAVAILABLE');
 }
}

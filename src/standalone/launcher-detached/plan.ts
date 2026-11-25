/** Headless planning has no pane, shell, or Herdr dependency. */
import { randomUUID, createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeAgentRoute } from '../../protocol/agent-command.js';
import { readLaunchCheckout, type LaunchCheckoutMode } from '../../core/common/config.js';
import { readWorkspaceConfigSnapshot, resolveAgentRouteWithSource } from '../../core/common/workspace.js';
import { resolveCheckout } from '../../core/launcher/checkout-provider.js';
import { worktreeGitEnvironment } from '../../core/launcher/worktree-git.js';
import { launchBlocked } from '../../core/launcher/launch.js';
import { preflightCheckout, renderPreflightReport } from '../../core/preflight/index.js';
import { inspectWorktree, reportWorktreeWarning, type WorktreeExpectation } from '../../core/preflight/worktree.js';
import { parseWorkspaceDeclaration, requireDeclaration, validateWorkspaceAnchor } from '../../core/launcher/checkout-anchor.js';
import type { AgentRoute, CheckoutRoute, ContextRecord, Flow } from '../../protocol/types.js';
import type { RunMeta } from '../../core/run/store.js';
import {resolveContract,encodeContract,contractSource,withContractBindings,prepareInvocation,continuitySession,invocationCommand,invocationEnvironment,legacyInvocationArgv,type ContractHandle,type SessionPlan,type ReadyInvocation,type ExactSessionRef,type SessionReadServices,verifySession} from '../../agents/public/index.js';
import {sessionReadServices} from '../../core/run/session-services.js';
import type { DetachedWindowsTargetDeps } from './windows-target.js';
import type { WindowsOwnership } from '../../core/run/windows-launch.js';
import { requireHeadlessPlatform } from '../../core/run/platform.js';

export interface HeadlessTask { task_id: string; title: string; version?: number; cast?: Record<string, AgentRoute>; checkout?: CheckoutRoute; description?: string | undefined; flow?: Flow }
export interface HeadlessPlan {
  profile?: ContractHandle;
  invocation?: ReadyInvocation;
  sessionPlan?: import('../../agents/public/index.js').ReadyInvocation['sessionPlan'];
  sessionRef?:ExactSessionRef;
  sessionReads?:SessionReadServices;
  sourceRun?:RunMeta;
  task_id: string; title: string; role: string; attempt_id: string; base_version: number; trigger_version: number;
  hubRoot: string; routingRoot: string; checkoutRoot: string; hubUrl: string;
  route: { agent: string; args: string[] }; route_source: string; argv: string[]; prompt: string;
  env: NodeJS.ProcessEnv; ownership: WindowsOwnership; target_digest: string;
  target_kind?: 'headless-posix' | 'headless-windows';
  recovery_of_version?: number;
  /** Anchored landing point validated from the description's 工作区 declaration. */
  checkout?: string;
  /** True when anchored mode found no declaration and fell back to the rig root. */
  checkout_fallback?: boolean;
}
export function humanInstruction(r: ContextRecord): boolean {
  return r.role === 'human' && r.content_type === 'note' && r.payload.ack !== true && r.payload.launch === undefined;
}
/** Only an online-observed human instruction may advance the note generation.
 *  The dedup boundary follows the task's real flow — replaying a direct/solo
 *  log under the full default table would misread a plain worker note as a
 *  reviewing→revising flip and wrongly clear a valid same-round marker. */
export function headlessGeneration(records: readonly ContextRecord[], role: string, onlineHumanVersion = 0, flow?: Flow, completedWithoutDelivery?: ReadonlySet<number>): { blocked: boolean; trigger: number; marker?: number; recoveryVersion?: number } {
  let trigger = 0; let marker: number | undefined;
  for (const r of records) {
    if (r.content_type !== 'note') trigger = Math.max(trigger, r.version);
    if (r.version === onlineHumanVersion && humanInstruction(r)) trigger = Math.max(trigger, r.version);
    const launch = r.content_type === 'note' ? r.payload.launch as { role?: string } | undefined : undefined;
    if (launch?.role === role) marker = Math.max(marker ?? 0, r.version);
  }
  // Use the manual door's dedup gate, retaining headless's narrower rule
  // that only an online human instruction can wake a note generation.
  const wake = records.some(r => r.version === onlineHumanVersion && humanInstruction(r))
    ? { version: onlineHumanVersion } : undefined;
  const decision = launchBlocked(records, role, wake, flow, completedWithoutDelivery);
  return { ...decision, trigger, ...(marker === undefined ? {} : { marker }) };
}

/** Parse options conservatively: positional prompts/subcommands and session selectors are not routes. */
export function nativeArgv(route: { agent: string; args: string[] }, prompt: string, session?: string): string[] {
  return legacyInvocationArgv(route,prompt,session);
}

export function previousSession(runs: readonly RunMeta[], task: HeadlessTask, role: string, route: { agent: string; args: string[] }, checkout: string, continuity = 'executor,reviewer', agent = path.basename(route.agent), selectedProfile?: ContractHandle): { id?: string; run?: string; reason: string } {
  if (role === 'architect' || !continuity.split(',').includes(role)) return { reason: 'fresh: role continuity disabled' };
  const previous = runs.filter(m => m.task_id === task.task_id && m.headless?.role === role).sort((a,b) => b.started_at.localeCompare(a.started_at))[0];
  if (!previous) return { reason: 'fresh: no previous headless role run' };
  if (!previous.ended_at || (previous.stop_request && !previous.stop_request.result?.success)) return { reason: 'fresh: previous completion unconfirmed' };
  if (previous.cwd !== checkout || JSON.stringify(previous.headless!.route) !== JSON.stringify(route)) return { reason: 'fresh: route or checkout changed' };
  const resolved=selectedProfile?{status:'resolved' as const,handle:selectedProfile}:resolveContract({agent:route.agent},contractSource(),'posix');
  if(resolved.status!=='resolved')throw Error(`${resolved.code}: ${resolved.reason}`);
  const selected=continuitySession(resolved.handle,previous);
  if(selected.status==='invalid')throw Error(`${selected.code}: ${selected.reason}`);
  return selected.status==='selected'||selected.status==='verified'?{id:selected.session.session_id,run:previous.run_id,reason:'resume: exact native role session'}:{reason:selected.status==='unavailable'?'fresh: native resume not configured':'fresh: native session identity unavailable'};
}
export async function buildHeadlessPlan(input: {
  task: HeadlessTask; role: string; records: readonly ContextRecord[]; onlineHumanVersion?: number;
  completedWithoutDelivery?: ReadonlySet<number>;
  hubRoot: string; hubUrl: string; eventUrl: string; runs?: readonly RunMeta[]; env?: NodeJS.ProcessEnv;
  /** Explicit new-session request (manual --fresh): withhold native session
   *  continuity for THIS plan only; auto launches never pass it. */
  fresh_session?: boolean;
  /** Positional route supplied to the legacy manual launch door. */
  explicitRoute?: { agent: string; args: string[] };
  /** Task description (anchored checkout source); callers may pass task.description instead. */
  description?: string | undefined;
  /** Frozen launch.checkout policy; absent means read it from <hubRoot>/.context-hub. */
  launchCheckout?: LaunchCheckoutMode | undefined;
  /** Platform/target seams for contract fixtures; production uses this host. */
  platform?: NodeJS.Platform;
  windowsDeps?: DetachedWindowsTargetDeps;
}): Promise<HeadlessPlan> {
  const platform = input.platform ?? process.platform;
  requireHeadlessPlatform(platform);
  const {task, role, hubRoot, hubUrl} = input;
  const env: NodeJS.ProcessEnv = {...(input.env ?? process.env), TUT_HUB_ROOT: hubRoot, TUT_HUB_URL: hubUrl, TUT_EVENT_PORT_URL: input.eventUrl};
  const routingRoot = env.TUT_PROJECT_ROOT ?? hubRoot;
  const workspaceSnapshot = await readWorkspaceConfigSnapshot({ projectRoot: routingRoot, fallbackProjectRoot: hubRoot });
  const resolved = input.explicitRoute !== undefined
    ? { route: input.explicitRoute, source: 'legacy-explicit' }
    : await resolveAgentRouteWithSource(role, task.cast, { workspaceSnapshot });
  const route = normalizeAgentRoute(resolved.route);
  const selection = await resolveCheckout({ anchorCwd: hubRoot, ...(task.checkout ? {checkout: task.checkout} : {}) });
  // Anchored checkout: the description declaration
  // is the ONLY anchoring source — a TaskMeta worktree route never exempts a
  // task from parsing and validating it. Same path → the declaration's three
  // checks govern; different paths → a configuration conflict refused with
  // both named, never a silent substitution. No declaration at all → rig
  // root + audit line (TaskMeta included). rig (default) never enters here.
  const launchCheckout = input.launchCheckout ?? await readLaunchCheckout(path.join(hubRoot, '.context-hub'));
  let checkoutRoot = selection.checkoutRoot;
  let checkout: string | undefined;
  let checkoutFallback: boolean | undefined;
  const expectations: WorktreeExpectation[] = [];
  if (selection.checkout.kind === 'worktree' && selection.checkout.ref !== undefined) {
    expectations.push({ ref: selection.checkout.ref, source: 'task checkout.ref' });
  }
  let advisoryReported = false;
  if (launchCheckout === 'anchored') {
    const declared = requireDeclaration(input.description ?? task.description);
    if (declared.status === 'declared') {
      if (selection.checkout.kind === 'worktree') {
        const declaredRoot = path.resolve(declared.path);
        if (selection.checkoutRoot !== declaredRoot) {
          throw new Error(`anchored checkout: declaration ${declaredRoot} conflicts with the task's frozen checkout route ${selection.checkoutRoot}; reconcile the task book or the task checkout before launching`);
        }
      }
      if (declared.branch !== undefined) expectations.push({ ref: declared.branch, source: 'declared branch' });
      // Report before the existing anchored validator, so its strict branch
      // gate retains its behavior while also offering manual switch guidance.
      reportWorktreeWarning(inspectWorktree(declared.path, expectations));
      advisoryReported = true;
      checkout = checkoutRoot = await validateWorkspaceAnchor(declared);
    } else {
      checkoutRoot = hubRoot; // no declaration → the rig root, TaskMeta included
      checkoutFallback = true;
      expectations.length = 0; // frozen route did not select the actual cwd
    }
  }
  if (!(await stat(checkoutRoot)).isDirectory()) throw new Error(`checkout is not a directory: ${checkoutRoot}`);
  await access(checkoutRoot, constants.X_OK);
  // Apply the selected contract environment before checkout preflight.
  const snapshot=withContractBindings(contractSource(hubRoot),workspaceSnapshot.bindings);
  // Explicit bindings compile for the target OS even before physical resolution.
  // Native routes retain their legacy preview until Windows identity is verified.
  const initialPlatform=route.agent.startsWith('binding:')&&platform==='win32'?'win32':'posix';
  const initialContract=resolveContract({agent:route.agent},snapshot,initialPlatform);
  if(route.agent.startsWith('binding:')&&initialContract.status!=='resolved')throw Error(initialContract.reason);
  const command=initialContract.status==='resolved'?invocationCommand(initialContract.handle,route):route.agent;
  if(initialContract.status==='resolved')Object.assign(env,invocationEnvironment(initialContract.handle,checkoutRoot));
  Object.assign(env, worktreeGitEnvironment({ hubRoot, checkoutRoot }));
  // checkout preflight (report-only here; auto never fixes): an applicable
  // missing item refuses BEFORE any marker or spawn, with repair guidance.
  const preflight = preflightCheckout(checkoutRoot, expectations);
  if (!advisoryReported) preflight.items.forEach(item => reportWorktreeWarning(item));
  if (preflight.applicable && !preflight.ok) throw new Error(renderPreflightReport(preflight, { manualOnly: true }));
  // Preflight existence/execute permissions only. A broken interpreter still
  // reaches the real spawn failure path, which owns give-up evidence.
  const windowsTarget = platform === 'win32' ? await (await import('./windows-target.js')).resolveDetachedWindowsTarget(command, env, input.windowsDeps) : undefined;
  const candidates = command.includes('/') ? [path.resolve(checkoutRoot,command)] : (env.PATH ?? '').split(path.delimiter).map(dir => path.resolve(checkoutRoot,dir,command));
  let present = false;
  for (const candidate of windowsTarget ? [] : candidates) {
    try { if ((await stat(candidate)).isFile()) { await access(candidate,constants.X_OK); present = true; break; } } catch { /* next PATH entry */ }
  }
  if (!windowsTarget && !present) throw new Error(`detached executable not on PATH or not executable: ${route.agent}`);
  const base = input.records.reduce((m,r) => Math.max(m,r.version),0);
  if (task.version === undefined || base !== task.version) throw new Error('detached task/log version unavailable or changed; re-observe before launching');
  const generation = headlessGeneration(input.records,role,input.onlineHumanVersion,input.task.flow,input.completedWithoutDelivery);
  const selected=platform==='win32'?resolveContract({agent:route.agent,...(windowsTarget?{verifiedTarget:windowsTarget.agent}:{})},snapshot,'win32'):initialContract;
  if(selected.status!=='resolved')throw Error(`unsupported-headless-agent: ${route.agent}; ${selected.reason}`);
  const profile=selected.handle;
  const session = input.fresh_session === true
    ? { reason: 'fresh: explicit new-session request' }
    : previousSession(input.runs ?? [],task,role,route,checkoutRoot,env.TUT_CONTINUITY_ROLES ?? 'executor,reviewer',windowsTarget?.agent,profile);
  const skill = fileURLToPath(new URL(`../../../skills/${role}.md`,import.meta.url));
  const prompt = `轮到你了（role: ${role}）：请用 Context Hub 读取任务 ${task.task_id} 的完整上下文（context.read），按你的 role skill（${skill}）开始本轮工作，完成后发布相应记录（context.publish）。`;
  const sourceRun=session.run?input.runs?.find(m=>m.run_id===session.run):undefined;
  const selectedSession=sourceRun?continuitySession(profile,sourceRun):undefined;
  let sessionRef=selectedSession?.status==='selected'||selectedSession?.status==='verified'?selectedSession.session:undefined;
  const sessionReads=sessionReadServices({env});
  if(sessionRef) {
    const verified=await verifySession(profile,sessionRef,sessionReads);
    if(verified.status!=='verified')throw Error('reason' in verified?verified.reason:'native session verification failed');
    sessionRef=verified.session;
  }
  const result=await prepareInvocation(profile,{mode:session.id?'resume':'run',origin:'managed',entry:'auto',route,checkoutRoot,prompt,
    environmentFacts:{home:os.homedir(),env,...(windowsTarget?{windows_target:windowsTarget}:{})},...(sessionRef?{sessionRef}:{})});
  if(result.status!=='ready')throw Error(result.reason);
  const invocation=result.invocation;
  Object.assign(env,invocation.envPatch);
  const argv=[invocation.executable,...invocation.argv];
  const designated=invocation.sessionPlan.designated_id;
  const windows=windowsTarget?{schema:1 as const,target:windowsTarget,logical_argv:invocation.logicalArgv,
    ...(invocation.sessionPlan.store?{pi_session:{...invocation.sessionPlan.store,session_id:designated!}}:{})}:undefined;
  if(windowsTarget)(await import('../../core/run/windows-broker.js')).preflightTargetFrame({argv,cwd:checkoutRoot,env,input:invocation.input},hubRoot);
  const attempt_id = randomUUID();
  const ownership: WindowsOwnership = { ...(invocation.sessionPlan.admission.session_id?{session_identity:{agent:profile.identity,session_id:invocation.sessionPlan.admission.session_id}}:{}),contract:encodeContract(profile),schema: 1,role,attempt_id,base_version: base,trigger_version:generation.trigger,route,route_source:resolved.source,session_reason:session.reason,
    ...(windows?{windows}:{}),
    ...(session.run ? {resume_from_run_id:session.run} : {}),...(designated ? {designated_session_id:designated} : {}) };
  const target_digest = `sha256:${createHash('sha256').update(JSON.stringify({hubRoot,checkoutRoot,argv})).digest('hex')}`;
  return {profile,...(sessionRef?{sessionRef,sessionReads,sourceRun:structuredClone(sourceRun!)}:{}),invocation,sessionPlan:invocation.sessionPlan,task_id:task.task_id,title:task.title,role,attempt_id,base_version:base,trigger_version:generation.trigger,hubRoot,routingRoot,checkoutRoot,hubUrl,route,route_source:resolved.source,argv,prompt,env,ownership,target_digest,target_kind:windowsTarget ? 'headless-windows' : 'headless-posix',
    ...(generation.recoveryVersion === undefined ? {} : {recovery_of_version:generation.recoveryVersion}),
    ...(checkout !== undefined ? {checkout} : {}), ...(checkoutFallback === true ? {checkout_fallback:true} : {})};
}

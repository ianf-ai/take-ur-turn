/** Headless planning has no pane, shell, or Herdr dependency. */
import { randomUUID, createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAgentRoute } from '../../core/common/agent-command.js';
import { readLaunchCheckout, type LaunchCheckoutMode } from '../../core/common/config.js';
import { resolveAgentRouteWithSource } from '../../core/common/workspace.js';
import { resolveCheckout } from '../../core/launcher/checkout.js';
import { worktreeGitEnvironment } from '../../core/launcher/worktree-git.js';
import { launchBlocked } from '../../core/launcher/launch.js';
import { preflightCheckout, renderPreflightReport } from '../../core/preflight/index.js';
import { inspectWorktree, reportWorktreeWarning, type WorktreeExpectation } from '../../core/preflight/worktree.js';
import { parseWorkspaceDeclaration, requireDeclaration, validateWorkspaceAnchor } from './checkout-anchor.js';
import type { AgentRoute, CheckoutRoute, ContextRecord } from '../../core/common/types.js';
import type { RunMeta } from '../../core/run/store.js';
import { codexArgv } from './codex-argv.js';
import type { DetachedWindowsTargetDeps } from './windows-target.js';
import type { WindowsOwnership } from './windows-plan.js';
import type { WindowsPiSession } from '../../core/run/windows-pi-session.js';
import { requireHeadlessPlatform } from './run-platform.js';

export interface HeadlessTask { task_id: string; title: string; version?: number; cast?: Record<string, AgentRoute>; checkout?: CheckoutRoute; description?: string | undefined }
export interface HeadlessPlan {
  task_id: string; title: string; role: string; attempt_id: string; base_version: number; trigger_version: number;
  hubRoot: string; routingRoot: string; checkoutRoot: string; hubUrl: string;
  route: { agent: string; args: string[] }; route_source: string; argv: string[]; prompt: string;
  env: NodeJS.ProcessEnv; ownership: WindowsOwnership; target_digest: string;
  target_kind?: 'headless-posix' | 'headless-windows';
  /** Anchored landing point validated from the description's 工作区 declaration. */
  checkout?: string;
  /** True when anchored mode found no declaration and fell back to the rig root. */
  checkout_fallback?: boolean;
}
export function humanInstruction(r: ContextRecord): boolean {
  return r.role === 'human' && r.content_type === 'note' && r.payload.ack !== true && r.payload.launch === undefined;
}
/** Only an online-observed human instruction may advance the note generation. */
export function headlessGeneration(records: readonly ContextRecord[], role: string, onlineHumanVersion = 0): { blocked: boolean; trigger: number; marker?: number } {
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
  return { blocked: launchBlocked(records, role, wake).blocked, trigger, ...(marker === undefined ? {} : { marker }) };
}

/** Parse options conservatively: positional prompts/subcommands and session selectors are not routes. */
export function nativeArgv(route: { agent: string; args: string[] }, prompt: string, session?: string): string[] {
  const agent = path.basename(route.agent);
  const args = [...route.args];
  if (agent === 'codex') return codexArgv(route.agent, args, prompt, session);
  if (agent === 'pi') {
    const selectors = /^(--(?:continue|resume|session|session-id|fork|no-session|session-dir)|-[cr])(?:=|$)/u;
    if (args.some(a => selectors.test(a))) throw new Error('detached pi route cannot select a session; TUT owns exact session identity');
    const values = new Set(['--provider','--model','--api-key','--system-prompt','--append-system-prompt','--name','-n','--models','--tools','-t','--exclude-tools','-xt','--thinking','--extension','-e','--skill','--prompt-template','--theme','--use-theme','--tui-mode']);
    let print = false; let json = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (!a.startsWith('-') || a === '--') throw new Error(`unsupported detached pi positional argument: ${a}`);
      if (values.has(a)) { if (args[++i] === undefined) throw new Error(`missing value for ${a}`); continue; }
      if (a === '--print' || a === '-p') print = true;
      if (args[i] === '--mode') { if (args[i + 1] !== 'json') throw new Error('detached pi requires --mode json'); json = true; i++; }
      else if (args[i]!.startsWith('--mode=')) { if (args[i] !== '--mode=json') throw new Error('detached pi requires --mode json'); json = true; }
    }
    return [route.agent, ...args, ...(!print ? ['--print'] : []), ...(!json ? ['--mode','json'] : []), '--session-id', session ?? randomUUID(), '--', prompt];
  }
  throw new Error(`unsupported-headless-agent: ${route.agent}; detached launch unsupported; explicitly select launch_mode=tui`);
}
export function previousSession(runs: readonly RunMeta[], task: HeadlessTask, role: string, route: { agent: string; args: string[] }, checkout: string, continuity = 'executor,reviewer', agent = path.basename(route.agent)): { id?: string; run?: string; reason: string } {
  if (role === 'architect' || !continuity.split(',').includes(role)) return { reason: 'fresh: role continuity disabled' };
  const previous = runs.filter(m => m.task_id === task.task_id && m.headless?.role === role).sort((a,b) => b.started_at.localeCompare(a.started_at))[0];
  if (!previous) return { reason: 'fresh: no previous headless role run' };
  if (!previous.ended_at || (previous.stop_request && !previous.stop_request.result?.success)) return { reason: 'fresh: previous completion unconfirmed' };
  if (previous.cwd !== checkout || JSON.stringify(previous.headless!.route) !== JSON.stringify(route)) return { reason: 'fresh: route or checkout changed' };
  const id = agent === 'codex' ? previous.agent_session_id : previous.headless!.designated_session_id;
  return id ? { id, run: previous.run_id, reason: 'resume: exact native role session' } : { reason: 'fresh: native session identity unavailable' };
}
export async function buildHeadlessPlan(input: {
  task: HeadlessTask; role: string; records: readonly ContextRecord[]; onlineHumanVersion?: number;
  hubRoot: string; hubUrl: string; eventUrl: string; runs?: readonly RunMeta[]; env?: NodeJS.ProcessEnv;
  /** Explicit new-session request (manual --fresh): withhold native session
   *  continuity for THIS plan only; auto launches never pass it. */
  fresh_session?: boolean;
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
  const resolved = await resolveAgentRouteWithSource(role, task.cast, { projectRoot: routingRoot, fallbackProjectRoot: hubRoot });
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
  Object.assign(env, worktreeGitEnvironment({ hubRoot, checkoutRoot }));
  // checkout preflight (report-only here; auto never fixes): an applicable
  // missing item refuses BEFORE any marker or spawn, with repair guidance.
  const preflight = preflightCheckout(checkoutRoot, expectations);
  if (!advisoryReported) preflight.items.forEach(item => reportWorktreeWarning(item));
  if (preflight.applicable && !preflight.ok) throw new Error(renderPreflightReport(preflight, { manualOnly: true }));
  // Preflight existence/execute permissions only. A broken interpreter still
  // reaches the real spawn failure path, which owns give-up evidence.
  const windowsTarget = platform === 'win32' ? await (await import('./windows-target.js')).resolveDetachedWindowsTarget(route.agent, env, input.windowsDeps) : undefined;
  const candidates = route.agent.includes('/') ? [path.resolve(checkoutRoot,route.agent)] : (env.PATH ?? '').split(path.delimiter).map(dir => path.resolve(checkoutRoot,dir,route.agent));
  let present = false;
  for (const candidate of windowsTarget ? [] : candidates) {
    try { if ((await stat(candidate)).isFile()) { await access(candidate,constants.X_OK); present = true; break; } } catch { /* next PATH entry */ }
  }
  if (!windowsTarget && !present) throw new Error(`detached executable not on PATH or not executable: ${route.agent}`);
  const base = input.records.reduce((m,r) => Math.max(m,r.version),0);
  if (task.version === undefined || base !== task.version) throw new Error('detached task/log version unavailable or changed; re-observe before launching');
  const generation = headlessGeneration(input.records,role,input.onlineHumanVersion);
  const session = input.fresh_session === true
    ? { reason: 'fresh: explicit new-session request' }
    : previousSession(input.runs ?? [],task,role,route,checkoutRoot,env.TUT_CONTINUITY_ROLES ?? 'executor,reviewer',windowsTarget?.agent);
  const skill = fileURLToPath(new URL(`../../../skills/${role}.md`,import.meta.url));
  const prompt = `轮到你了（role: ${role}）：请用 Context Hub 读取任务 ${task.task_id} 的完整上下文（context.read），按你的 role skill（${skill}）开始本轮工作，完成后发布相应记录（context.publish）。`;
  const windowsPlan = windowsTarget ? await import('./windows-plan.js') : undefined;
  const windowsPi = windowsTarget?.agent === 'pi' ? await import('../../core/run/windows-pi-session.js') : undefined;
  const piArgs = windowsPi?.windowsPiRouteArgs(route.args);
  const logicalArgv = nativeArgv(windowsTarget ? { agent: windowsTarget.agent, args: piArgs?.args ?? route.args } : route,prompt,session.id);
  const designated = (windowsTarget?.agent ?? path.basename(route.agent)) === 'pi' ? logicalArgv[logicalArgv.lastIndexOf('--session-id') + 1] : undefined;
  let piSession: WindowsPiSession | undefined;
  if (windowsTarget?.agent === 'pi') {
    if (session.id) {
      const source = input.runs?.find(m => m.run_id === session.run);
      const previous = source?.headless && windowsPlan!.readWindowsLaunch(source.headless).pi_session;
      if (!previous || previous.launch_cwd !== path.win32.resolve(checkoutRoot)) throw new Error('Windows pi continuation has no matching frozen session directory');
      piSession = windowsPi!.verifyWindowsPiSession(previous, session.id);
    } else {
      piSession = { ...windowsPi!.windowsPiSessionLocation(checkoutRoot, env, piArgs?.directory), session_id: designated! };
    }
  }
  const argv = windowsTarget ? windowsPlan!.physicalWindowsArgv(windowsTarget, logicalArgv, piSession) : logicalArgv;
  const attempt_id = randomUUID();
  const ownership: WindowsOwnership = { schema: 1,role,attempt_id,base_version: base,trigger_version:generation.trigger,route,route_source:resolved.source,session_reason:session.reason,
    ...(windowsTarget ? { windows: { schema: 1, target: windowsTarget, logical_argv: logicalArgv, ...(piSession ? { pi_session: piSession } : {}) } } : {}),
    ...(session.run ? {resume_from_run_id:session.run} : {}),...(designated ? {designated_session_id:designated} : {}) };
  const target_digest = `sha256:${createHash('sha256').update(JSON.stringify({hubRoot,checkoutRoot,argv})).digest('hex')}`;
  return {task_id:task.task_id,title:task.title,role,attempt_id,base_version:base,trigger_version:generation.trigger,hubRoot,routingRoot,checkoutRoot,hubUrl,route,route_source:resolved.source,argv,prompt,env,ownership,target_digest,target_kind:windowsTarget ? 'headless-windows' : 'headless-posix',
    ...(checkout !== undefined ? {checkout} : {}), ...(checkoutFallback === true ? {checkout_fallback:true} : {})};
}

/** Frozen route, self-update policy and platform execution plans. */
import type { AgentCommand, AgentRoute, LaunchInvocation, PosixDirectPlan } from "../../common/types.js";
import type { EffectiveAgentPlan, PlatformExecutionPlan, PlatformPlanOptions, ResolvedAgentTarget, ResolvePlatformExecutionPlanOptions, SelfUpdatePolicy } from "./types.js";
import { resolvePosixTargetPresence } from "./posix.js";
import { resolveWindowsExecutableTarget } from "./windows.js";

/** Normalize any AgentRoute form into the ordered { agent, args } command. */
export function normalizeRouteCommand(route: AgentRoute): AgentCommand {
  if (typeof route === "string") return { agent: route, args: [] };
  return { agent: route.agent, args: [...route.args] };
}

/**
 * Freeze the agent self-update suppression policy once, keyed by the bare
 * route agent's logical name — never by a wrapped command or resolved path.
 */
export function selfUpdatePolicyFor(
  routeAgent: string,
  routeArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
): SelfUpdatePolicy {
  const suppress = environment.TUT_SUPPRESS_AGENT_UPDATE !== "0";
  if (!suppress) return { args: [...routeArgs], env: {} };
  if (routeAgent === "codex") {
    return { args: [...routeArgs, "-c", "check_for_update_on_startup=false"], env: {} };
  }
  if (routeAgent === "pi") {
    return { args: [...routeArgs], env: { PI_SKIP_VERSION_CHECK: "1" } };
  }
  return { args: [...routeArgs], env: {} };
}

/** Pure POSIX plan: the bare route agent plus the frozen policy. */
export function posixDirectPlanFor(
  route: AgentCommand,
  environment: NodeJS.ProcessEnv,
): PosixDirectPlan {
  const policy = selfUpdatePolicyFor(route.agent, route.args, environment);
  return { executable: route.agent, args: policy.args, env: policy.env };
}

/** Windows effective plan: resolved target prefix plus the frozen policy. */
function windowsEffectivePlanFor(
  target: ResolvedAgentTarget,
  route: AgentCommand,
  environment: NodeJS.ProcessEnv,
): EffectiveAgentPlan {
  const policy = selfUpdatePolicyFor(route.agent, route.args, environment);
  return {
    executable: target.executable,
    args: [...target.prefix_args, ...policy.args],
    env: policy.env,
  };
}

/**
 * Build the platform plan without a POSIX presence preflight.
 *
 * POSIX stays pure (the bare-name plan carries nothing from which); Windows
 * resolves its structured target, which may throw before any mutation.
 */
export async function planForPlatform(
  route: AgentCommand,
  options: PlatformPlanOptions = {},
): Promise<PlatformExecutionPlan> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const target = await resolveWindowsExecutableTarget(route.agent, { ...options.windowsDeps, environment });
    return {
      platform: "windows",
      resolved_target: target,
      effective_agent: windowsEffectivePlanFor(target, route, environment),
    };
  }
  return { platform: "posix", posix_direct: posixDirectPlanFor(route, environment) };
}

/**
 * The door-facing resolution used by canonical planners (start-next and
 * Notifier auto) before the marker: prove the target first, then produce the
 * frozen plan.  Any target failure throws before marker or Herdr mutation.
 */
export async function resolvePlatformExecutionPlan(
  route: AgentCommand,
  options: ResolvePlatformExecutionPlanOptions = {},
): Promise<PlatformExecutionPlan> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    await resolvePosixTargetPresence(route.agent, options.posixDeps);
  }
  return await planForPlatform(route, options);
}

/** Spread helper: map one platform plan onto buildLaunchInvocation options. */
export function platformPlanFields(
  plan: PlatformExecutionPlan,
): Pick<LaunchInvocation, "posix_direct"> | Pick<LaunchInvocation, "resolved_target" | "effective_agent"> {
  return plan.platform === "posix"
    ? { posix_direct: plan.posix_direct }
    : { resolved_target: plan.resolved_target, effective_agent: plan.effective_agent };
}

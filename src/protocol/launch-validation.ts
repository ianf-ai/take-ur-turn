/** Internal pure validators shared by launch policy and the v2 codec. */
import { normalizeAgentRoute } from "./agent-command.js";
import { LaunchInvocationError } from "./launch-error.js";
import type {
  AgentCommand,
  AgentRoute,
  LaunchRouteSource,
  LaunchRequest,
  PosixDirectPlan,
  LaunchInvocation,
} from "./launch-types.js";

const ROUTE_SOURCES = new Set<LaunchRouteSource>([
  "task-cast",
  "config-project",
  "workspace-project",
  "workspace-user",
  "builtin-default",
  "legacy-explicit",
]);

export function assertFiniteVersion(version: number, field: string): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new LaunchInvocationError(`${field} must be a non-negative safe integer`);
  }
}

export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new LaunchInvocationError(`${field} must be a non-empty string without NUL/CR/LF`);
  }
}

export function assertRouteSource(value: unknown, field: string): asserts value is LaunchRouteSource {
  if (typeof value !== "string" || !ROUTE_SOURCES.has(value as LaunchRouteSource)) {
    throw new LaunchInvocationError(`${field} is not a recognized route source`);
  }
}

export function assertLaunchVia(value: unknown, field: string): asserts value is LaunchRequest["via"] {
  if (value !== "start-next" && value !== "auto" && value !== "legacy") {
    throw new LaunchInvocationError(`${field} is invalid`);
  }
}

export function cloneRoute(route: AgentRoute): AgentCommand {
  try {
    return normalizeAgentRoute(route);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid route";
    throw new LaunchInvocationError(message);
  }
}

export function clonePlan<T extends { executable: string; args: string[]; env: Record<string, string> }>(plan: T): T {
  assertNonEmptyString(plan.executable, "execution plan executable");
  if (!Array.isArray(plan.args)) throw new LaunchInvocationError("execution plan args must be an array");
  for (const [index, arg] of plan.args.entries()) assertNonEmptyString(arg, `execution plan args[${index}]`);
  if (typeof plan.env !== "object" || plan.env === null || Array.isArray(plan.env)) {
    throw new LaunchInvocationError("execution plan env must be an object");
  }
  for (const [key, value] of Object.entries(plan.env)) {
    assertNonEmptyString(key, "execution plan env key");
    if (typeof value !== "string" || /[\u0000\r\n]/u.test(value)) {
      throw new LaunchInvocationError(`execution plan env.${key} must be a string without NUL/CR/LF`);
    }
  }
  return {
    ...plan,
    args: [...plan.args],
    env: { ...plan.env },
  };
}

function defaultPosixPlan(route: AgentCommand): PosixDirectPlan {
  return { executable: route.agent, args: [...route.args], env: {} };
}

export function privateExecutionInputOf(
  route: AgentCommand,
  posix: PosixDirectPlan | undefined,
  resolvedTarget: LaunchInvocation["resolved_target"],
  effectiveAgent: LaunchInvocation["effective_agent"],
): Record<string, unknown> {
  if (resolvedTarget !== undefined || effectiveAgent !== undefined) {
    return {
      route,
      target_kind: resolvedTarget?.kind ?? "windows-direct",
      resolved_target: resolvedTarget,
      effective_agent: effectiveAgent,
    };
  }
  const direct = posix ?? defaultPosixPlan(route);
  return { route, target_kind: "posix-direct", posix_direct: direct };
}

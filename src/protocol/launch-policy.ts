/** Pure launch gates, portable marker projection and correlation policy. */
import { createHash } from "node:crypto";
import { parseAgentInvocation } from "./agent-command.js";
import { LaunchInvocationError } from "./launch-error.js";
import type {
  AgentCommand,
  AgentRoute,
  LaunchRequest,
  LaunchMarkerProjection,
  LaunchRouteSource,
  CheckoutRoute,
  ExecutionContext,
  LaunchNaming,
  PosixDirectPlan,
  LaunchInvocation,
} from "./launch-types.js";
import {
  assertFiniteVersion, assertNonEmptyString, assertRouteSource,
  cloneRoute, clonePlan, privateExecutionInputOf,
} from "./launch-validation.js";

/** Values accepted from the /state snapshot by the canonical launch doors. */
export interface LaunchStateTask {
  task_id: string;
  waiting_for?: string;
  status?: string;
  needs_attention?: boolean;
  version?: number;
  /** Task-frozen checkout route, absent on legacy state snapshots. */
  checkout?: CheckoutRoute;
}

/**
 * A deterministic JSON representation used only for correlation digests.
 * Object keys are sorted recursively; array order and string bytes are kept.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LaunchInvocationError("digest input contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new LaunchInvocationError("digest input contains an unsupported value");
}

/** Compute the opaque, portable launch-plan correlation digest. */
export function targetDigest(privateExecutionInput: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(privateExecutionInput), "utf8").digest("hex")}`;
}

export interface BuildLaunchInvocationOptions {
  request: LaunchRequest;
  base_version: number;
  hub_url: string;
  route: AgentRoute;
  route_source: LaunchRouteSource;
  context?: ExecutionContext;
  naming?: LaunchNaming;
  prompt?: string;
  /** POSIX plan is the first platform implementation; later ports add private fields. */
  posix_direct?: PosixDirectPlan;
  resolved_target?: LaunchInvocation["resolved_target"];
  effective_agent?: LaunchInvocation["effective_agent"];
}

/**
 * Bind a launch to the same state/log snapshot that selected its role.
 *
 * Older injected callers may omit the additive /state version; in that
 * compatibility case the log version remains the best available base.  A
 * real Hub always supplies the task version, so a present value is strict:
 * the optimistic marker must use exactly the state version that was checked.
 */
export function bindLaunchBaseVersion(stateVersion: number | undefined, logVersion: number): number {
  assertFiniteVersion(logVersion, "log_version");
  if (stateVersion === undefined) return logVersion;
  assertFiniteVersion(stateVersion, "state_version");
  if (stateVersion !== logVersion) {
    throw new LaunchInvocationError(
      `state/log version mismatch: state v${stateVersion}, log v${logVersion}`,
    );
  }
  return stateVersion;
}

/** Build the marker projection from the same normalized route as the invocation. */
export function buildMarkerProjection(
  options: Pick<BuildLaunchInvocationOptions, "request" | "base_version" | "route" | "route_source" | "posix_direct" | "resolved_target" | "effective_agent">,
): LaunchMarkerProjection {
  if (options.request.via === "legacy") {
    throw new LaunchInvocationError("legacy launch requests do not produce Hub markers");
  }
  assertFiniteVersion(options.base_version, "base_version");
  const route = cloneRoute(options.route);
  const posix = options.posix_direct === undefined ? undefined : clonePlan(options.posix_direct);
  if (posix !== undefined && posix.executable !== route.agent) {
    throw new LaunchInvocationError("posix_direct.executable must equal route.agent");
  }
  assertRouteSource(options.route_source, "route_source");
  const resolvedTarget = options.resolved_target === undefined
    ? undefined
    : {
        ...options.resolved_target,
        prefix_args: [...options.resolved_target.prefix_args],
      };
  const effectiveAgent = options.effective_agent === undefined ? undefined : clonePlan(options.effective_agent);
  const targetKind = resolvedTarget?.kind ?? "posix-direct";
  return {
    protocol_version: 2,
    role: options.request.role,
    base_version: options.base_version,
    via: options.request.via,
    route,
    route_source: options.route_source,
    target_kind: targetKind,
    target_digest: targetDigest(privateExecutionInputOf(route, posix, resolvedTarget, effectiveAgent)),
  };
}

/** Ensure the state snapshot still names the role the caller intends to launch. */
export function assertLaunchStateGate(request: LaunchRequest, task: LaunchStateTask | undefined): void {
  if (task === undefined || task.task_id !== request.task_id) {
    throw new LaunchInvocationError(`task ${request.task_id} is not present in the state snapshot`);
  }
  const expected = `agent:${request.role}`;
  if (task.waiting_for !== expected) {
    throw new LaunchInvocationError(
      `task ${request.task_id} is waiting for ${task.waiting_for ?? "none"}, not ${expected}`,
    );
  }
  if (task.needs_attention === true) {
    throw new LaunchInvocationError(`task ${request.task_id} has needs_attention set; launch is withheld`);
  }
  if (task.status !== undefined && !["designing", "implementing", "reviewing", "revising"].includes(task.status)) {
    throw new LaunchInvocationError(`task ${request.task_id} has non-launchable status ${task.status}`);
  }
}

/** Capture the raw trailing route values at the launch entry boundary. */
export function explicitRouteFromValues(values: readonly string[] | undefined): AgentCommand | undefined {
  if (values === undefined || values.length === 0) return undefined;
  try {
    return cloneRoute(parseAgentInvocation(values));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid agent invocation";
    throw new LaunchInvocationError(`invalid agent command: ${message}`);
  }
}

/** Build a request from the legacy internal launch positional boundary. */
export function requestFromLegacyArgs(
  taskId: string,
  role: string,
  fresh: boolean,
  explicitRouteValues: readonly string[] | undefined,
  via: LaunchRequest["via"] = "legacy",
): LaunchRequest {
  assertNonEmptyString(taskId, "task_id");
  assertNonEmptyString(role, "role");
  if (explicitRouteValues !== undefined && explicitRouteValues.length === 0) {
    throw new LaunchInvocationError("explicit route values must be undefined or non-empty");
  }
  return {
    kind: "round",
    task_id: taskId,
    role,
    fresh,
    via,
    ...(explicitRouteValues !== undefined ? { explicit_route_values: [...explicitRouteValues] } : {}),
  };
}

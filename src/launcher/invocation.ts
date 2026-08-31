/**
 * Launch request/invocation boundary.
 *
 * A caller supplies a small LaunchRequest.  The planner expands it exactly
 * once into an immutable LaunchInvocation.  The invocation is the only value
 * allowed to cross the internal Node child boundary; in particular, the
 * child does not re-read workspace config or parse a display command string.
 */

import { createHash } from "node:crypto";
import {
  normalizeAgentRoute,
  parseAgentInvocation,
  validateAgentRoute,
} from "../agent-command.js";
import type {
  AgentCommand,
  AgentRoute,
  CheckoutRoute,
  ExecutionContext,
  LaunchInvocation,
  LaunchMarkerProjection,
  LaunchNaming,
  LaunchRequest,
  LaunchRouteSource,
  PosixDirectPlan,
} from "../types.js";

export class LaunchInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchInvocationError";
  }
}

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

const PLACEHOLDER_CONTEXT: ExecutionContext = {
  hubRoot: "<hub-root>",
  routingRoot: "<routing-root>",
  checkoutRoot: "<checkout-root>",
  checkout: { kind: "current" },
  context: { kind: "shared" },
  source: "placeholder",
};

const PLACEHOLDER_NAMING: LaunchNaming = {
  tab_label: "TUT {role}",
  pane_label: "<task>.<role>",
};

const ROUTE_SOURCES = new Set<LaunchRouteSource>([
  "task-cast",
  "workspace-project",
  "workspace-user",
  "builtin-default",
  "legacy-explicit",
]);

function assertFiniteVersion(version: number, field: string): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new LaunchInvocationError(`${field} must be a non-negative safe integer`);
  }
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

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new LaunchInvocationError(`${field} must be a non-empty string without NUL/CR/LF`);
  }
}

function assertRouteSource(value: unknown, field: string): asserts value is LaunchRouteSource {
  if (typeof value !== "string" || !ROUTE_SOURCES.has(value as LaunchRouteSource)) {
    throw new LaunchInvocationError(`${field} is not a recognized route source`);
  }
}

function assertLaunchVia(value: unknown, field: string): asserts value is LaunchRequest["via"] {
  if (value !== "start-next" && value !== "auto" && value !== "legacy") {
    throw new LaunchInvocationError(`${field} is invalid`);
  }
}

function cloneRoute(route: AgentRoute): AgentCommand {
  try {
    return normalizeAgentRoute(route);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid route";
    throw new LaunchInvocationError(message);
  }
}

function clonePlan<T extends { executable: string; args: string[]; env: Record<string, string> }>(plan: T): T {
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

function privateExecutionInputOf(
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

/**
 * The sole planner entry.  All optional values are copied so the caller
 * cannot mutate the plan after it has been fenced and handed to the child.
 */
export function buildLaunchInvocation(options: BuildLaunchInvocationOptions): LaunchInvocation {
  const { request } = options;
  if (request.kind !== "round") throw new LaunchInvocationError("launch request kind must be round");
  assertLaunchVia(request.via, "request.via");
  assertNonEmptyString(request.task_id, "task_id");
  assertNonEmptyString(request.role, "role");
  assertNonEmptyString(options.hub_url, "hub_url");
  assertFiniteVersion(options.base_version, "base_version");
  if (request.explicit_route_values !== undefined && request.explicit_route_values.length === 0) {
    throw new LaunchInvocationError("explicit_route_values must be undefined or non-empty");
  }

  const route = cloneRoute(options.route);
  const posix = options.posix_direct === undefined ? undefined : clonePlan(options.posix_direct);
  if (posix !== undefined && posix.executable !== route.agent) {
    throw new LaunchInvocationError("posix_direct.executable must equal route.agent");
  }
  assertRouteSource(options.route_source, "route_source");
  const naming = options.naming === undefined ? PLACEHOLDER_NAMING : options.naming;
  assertNonEmptyString(naming.tab_label, "naming.tab_label");
  assertNonEmptyString(naming.pane_label, "naming.pane_label");
  const prompt = options.prompt ?? "";
  assertNonEmptyString(prompt, "prompt");
  const resolvedTarget = options.resolved_target === undefined
    ? undefined
    : { ...options.resolved_target, prefix_args: [...options.resolved_target.prefix_args] };
  const effectiveAgent = options.effective_agent === undefined ? undefined : clonePlan(options.effective_agent);
  const marker_projection = request.via === "legacy"
    ? undefined
    : buildMarkerProjection({
        request,
        base_version: options.base_version,
        route,
        route_source: options.route_source,
        ...(posix !== undefined ? { posix_direct: posix } : {}),
        ...(resolvedTarget !== undefined ? { resolved_target: resolvedTarget } : {}),
        ...(effectiveAgent !== undefined ? { effective_agent: effectiveAgent } : {}),
      });

  return {
    protocol_version: 2,
    kind: "round",
    task_id: request.task_id,
    role: request.role,
    fresh: request.fresh,
    via: request.via,
    base_version: options.base_version,
    hub_url: options.hub_url,
    route,
    route_source: options.route_source,
    context: options.context === undefined ? PLACEHOLDER_CONTEXT : structuredClone(options.context),
    naming: { ...naming },
    prompt,
    ...(posix !== undefined ? { posix_direct: posix } : {}),
    ...(resolvedTarget !== undefined ? { resolved_target: resolvedTarget } : {}),
    ...(effectiveAgent !== undefined ? { effective_agent: effectiveAgent } : {}),
    ...(marker_projection !== undefined ? { marker_projection } : {}),
  } as LaunchInvocation;
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

/** Serialize exactly one JSON argv item for the internal Node child. */
export function serializeLaunchInvocation(invocation: LaunchInvocation): string {
  validateLaunchInvocation(invocation);
  return JSON.stringify(invocation);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || /[\u0000\r\n]/u.test(item))) {
    throw new LaunchInvocationError(`${field} must be an array of strings`);
  }
  return [...value] as string[];
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LaunchInvocationError(`${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertNonEmptyString(key, `${field} key`);
    if (typeof item !== "string" || /[\u0000\r\n]/u.test(item)) throw new LaunchInvocationError(`${field}.${key} must be a string without NUL/CR/LF`);
    out[key] = item;
  }
  return out;
}

function cloneCheckout(value: unknown): CheckoutRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LaunchInvocationError("invocation.context.checkout must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "current") return { kind: "current" };
  if (raw.kind !== "worktree") {
    throw new LaunchInvocationError("invocation.context.checkout.kind must be current or worktree");
  }
  const routeString = (candidate: unknown, field: string): string | undefined => {
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "string" || candidate.trim().length === 0 || /[\u0000\r\n]/u.test(candidate)) {
      throw new LaunchInvocationError(`${field} must be a non-empty string without NUL/CR/LF`);
    }
    return candidate;
  };
  const checkoutPath = routeString(raw.path, "invocation.context.checkout.path");
  const ref = routeString(raw.ref, "invocation.context.checkout.ref");
  if (checkoutPath === undefined && ref === undefined) {
    throw new LaunchInvocationError("invocation.context.checkout worktree requires path or ref");
  }
  return {
    kind: "worktree",
    ...(checkoutPath !== undefined ? { path: checkoutPath } : {}),
    ...(ref !== undefined ? { ref } : {}),
  };
}

function validateExecutionContext(value: unknown): ExecutionContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LaunchInvocationError("invocation.context must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const field of ["hubRoot", "routingRoot", "checkoutRoot", "source"] as const) {
    assertNonEmptyString(raw[field], `invocation.context.${field}`);
  }
  if (raw.source !== "anchor" && raw.source !== "project-root" && raw.source !== "placeholder" && raw.source !== "legacy") {
    throw new LaunchInvocationError("invocation.context.source is invalid");
  }
  const checkout = raw.checkout;
  const checkoutRoute = cloneCheckout(checkout);
  const context = raw.context;
  if (typeof context !== "object" || context === null || (context as { kind?: unknown }).kind !== "shared") {
    throw new LaunchInvocationError("invocation.context.context.kind must be shared");
  }
  let anchor: ExecutionContext["anchor"];
  if (raw.anchor !== undefined) {
    if (typeof raw.anchor !== "object" || raw.anchor === null || Array.isArray(raw.anchor)) {
      throw new LaunchInvocationError("invocation.context.anchor must be an object");
    }
    const a = raw.anchor as Record<string, unknown>;
    assertNonEmptyString(a.workspace_id, "invocation.context.anchor.workspace_id");
    assertNonEmptyString(a.cwd, "invocation.context.anchor.cwd");
    assertNonEmptyString(a.pane_id, "invocation.context.anchor.pane_id");
    anchor = { workspace_id: a.workspace_id, cwd: a.cwd, pane_id: a.pane_id };
  }
  const hubRoot = raw.hubRoot as string;
  const routingRoot = raw.routingRoot as string;
  const checkoutRoot = raw.checkoutRoot as string;
  let callerCwd: string | undefined;
  if (raw.caller_cwd !== undefined) {
    assertNonEmptyString(raw.caller_cwd, "invocation.context.caller_cwd");
    callerCwd = raw.caller_cwd;
  }
  return {
    ...(anchor !== undefined ? { anchor } : {}),
    ...(callerCwd !== undefined ? { caller_cwd: callerCwd } : {}),
    hubRoot,
    routingRoot,
    checkoutRoot,
    checkout: checkoutRoute,
    context: { kind: "shared" },
    source: raw.source as ExecutionContext["source"],
  };
}

function validateInvocationMarker(value: unknown): LaunchMarkerProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LaunchInvocationError("invocation.marker_projection is required for canonical launches");
  }
  const raw = value as Record<string, unknown>;
  if (raw.protocol_version !== 2) throw new LaunchInvocationError("marker projection protocol_version must be 2");
  assertNonEmptyString(raw.role, "marker projection role");
  assertFiniteVersion(raw.base_version as number, "marker projection base_version");
  if (raw.via !== "start-next" && raw.via !== "auto") throw new LaunchInvocationError("marker projection via is invalid");
  const route = validateAgentRoute(raw.route);
  const routeObject = typeof route === "string" ? { agent: route, args: [] } : { agent: route.agent, args: [...route.args] };
  assertRouteSource(raw.route_source, "marker projection route_source");
  assertNonEmptyString(raw.target_kind, "marker projection target_kind");
  assertNonEmptyString(raw.target_digest, "marker projection target_digest");
  return {
    protocol_version: 2,
    role: raw.role,
    base_version: raw.base_version as number,
    via: raw.via,
    route: routeObject,
    route_source: raw.route_source as LaunchRouteSource,
    target_kind: raw.target_kind,
    target_digest: raw.target_digest,
  };
}

/** Validate and defensively copy a child invocation. */
export function validateLaunchInvocation(value: unknown): LaunchInvocation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LaunchInvocationError("launch invocation must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.protocol_version !== 2) throw new LaunchInvocationError("launch invocation protocol_version must be 2");
  if (raw.kind !== "round") throw new LaunchInvocationError("launch invocation kind must be round");
  assertLaunchVia(raw.via, "invocation.via");
  for (const field of ["task_id", "role", "hub_url", "prompt", "route_source"] as const) {
    assertNonEmptyString(raw[field], `invocation.${field}`);
  }
  assertRouteSource(raw.route_source, "invocation.route_source");
  if (typeof raw.fresh !== "boolean") throw new LaunchInvocationError("invocation.fresh must be boolean");
  assertFiniteVersion(raw.base_version as number, "invocation.base_version");
  const route = validateAgentRoute(raw.route);
  const routeObject = typeof route === "string" ? { agent: route, args: [] } : { agent: route.agent, args: [...route.args] };
  const context = validateExecutionContext(raw.context);
  if (typeof raw.naming !== "object" || raw.naming === null || Array.isArray(raw.naming)) {
    throw new LaunchInvocationError("invocation.naming must be an object");
  }
  const namingRaw = raw.naming as Record<string, unknown>;
  assertNonEmptyString(namingRaw.tab_label, "invocation.naming.tab_label");
  assertNonEmptyString(namingRaw.pane_label, "invocation.naming.pane_label");
  const posix = raw.posix_direct === undefined ? undefined : (() => {
    const p = raw.posix_direct;
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw new LaunchInvocationError("invocation.posix_direct must be an object");
    const po = p as Record<string, unknown>;
    assertNonEmptyString(po.executable, "invocation.posix_direct.executable");
    if (po.executable !== routeObject.agent) throw new LaunchInvocationError("invocation.posix_direct.executable must equal invocation.route.agent");
    return { executable: po.executable, args: stringArray(po.args, "invocation.posix_direct.args"), env: stringMap(po.env, "invocation.posix_direct.env") };
  })();
  const resolvedTarget = raw.resolved_target === undefined ? undefined : (() => {
    if (typeof raw.resolved_target !== "object" || raw.resolved_target === null || Array.isArray(raw.resolved_target)) throw new LaunchInvocationError("invocation.resolved_target must be an object");
    const t = raw.resolved_target as Record<string, unknown>;
    if (t.kind !== "native" && t.kind !== "node-entry") throw new LaunchInvocationError("invocation.resolved_target.kind is invalid");
    assertNonEmptyString(t.executable, "invocation.resolved_target.executable");
    assertNonEmptyString(t.source_path, "invocation.resolved_target.source_path");
    return { kind: t.kind, executable: t.executable, prefix_args: stringArray(t.prefix_args, "invocation.resolved_target.prefix_args"), source_path: t.source_path } as NonNullable<LaunchInvocation["resolved_target"]>;
  })();
  const effectiveAgent = raw.effective_agent === undefined ? undefined : (() => {
    if (typeof raw.effective_agent !== "object" || raw.effective_agent === null || Array.isArray(raw.effective_agent)) throw new LaunchInvocationError("invocation.effective_agent must be an object");
    const e = raw.effective_agent as Record<string, unknown>;
    assertNonEmptyString(e.executable, "invocation.effective_agent.executable");
    return { executable: e.executable, args: stringArray(e.args, "invocation.effective_agent.args"), env: stringMap(e.env, "invocation.effective_agent.env") };
  })();
  const marker = raw.marker_projection === undefined ? undefined : validateInvocationMarker(raw.marker_projection);
  if (raw.via !== "legacy" && marker === undefined) {
    throw new LaunchInvocationError("canonical launch invocation is missing marker_projection");
  }
  if (raw.via === "legacy" && marker !== undefined) {
    throw new LaunchInvocationError("legacy launch invocation must not carry marker_projection");
  }
  if (marker !== undefined) {
    if (marker.via !== raw.via || marker.role !== raw.role || marker.base_version !== raw.base_version) {
      throw new LaunchInvocationError("marker projection does not match invocation identity");
    }
    if (canonicalJson(marker.route) !== canonicalJson(routeObject) || marker.route_source !== raw.route_source) {
      throw new LaunchInvocationError("marker projection does not match invocation route");
    }
    const targetKind = resolvedTarget?.kind ?? "posix-direct";
    const digest = targetDigest(privateExecutionInputOf(routeObject, posix, resolvedTarget, effectiveAgent));
    if (marker.target_kind !== targetKind || marker.target_digest !== digest) {
      throw new LaunchInvocationError("marker projection target digest does not match invocation plan");
    }
  }
  return {
    protocol_version: 2,
    kind: "round",
    task_id: raw.task_id,
    role: raw.role,
    fresh: raw.fresh,
    via: raw.via as LaunchRequest["via"],
    base_version: raw.base_version as number,
    hub_url: raw.hub_url,
    route: routeObject,
    route_source: raw.route_source as LaunchRouteSource,
    context,
    naming: { tab_label: namingRaw.tab_label, pane_label: namingRaw.pane_label },
    prompt: raw.prompt,
    ...(posix !== undefined ? { posix_direct: posix } : {}),
    ...(resolvedTarget !== undefined ? { resolved_target: resolvedTarget } : {}),
    ...(effectiveAgent !== undefined ? { effective_agent: effectiveAgent } : {}),
    ...(marker !== undefined ? { marker_projection: marker } : {}),
  } as LaunchInvocation;
}

/** Decode one JSON argv item.  The caller owns the outer argv count check. */
export function deserializeLaunchInvocation(value: string): LaunchInvocation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LaunchInvocationError("launch invocation is not valid JSON");
  }
  return validateLaunchInvocation(parsed);
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

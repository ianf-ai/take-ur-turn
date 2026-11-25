/** Frozen v2 invocation construction and wire codec. Field order and rejection rules are compatibility contracts. */
import { validateAgentRoute } from "./agent-command.js";
import { LaunchInvocationError } from "./launch-error.js";
import { buildMarkerProjection, canonicalJson, targetDigest, type BuildLaunchInvocationOptions } from "./launch-policy.js";
import type {
  AgentCommand,
  CheckoutRoute,
  ExecutionContext,
  LaunchInvocation,
  LaunchMarkerProjection,
  LaunchNaming,
  LaunchRequest,
  LaunchRouteSource,
} from "./launch-types.js";
import {
  assertFiniteVersion, assertNonEmptyString, assertRouteSource, assertLaunchVia,
  cloneRoute, clonePlan, privateExecutionInputOf,
} from "./launch-validation.js";

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

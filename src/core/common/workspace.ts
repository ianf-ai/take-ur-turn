/** Rig intent resolution. config.roles is a complete authoritative roster;
 * workspace's legacy chain remains readable only while config.roles is absent. */

import {resolveBindingReference,type InvocationBinding} from '../../agents/public/declarations.js';
import {normalizeAgentRoute} from '../../protocol/agent-command.js';
import { readFile } from "node:fs/promises";
import { readConfigFile, configPath } from "./config.js";
import { parseConfigRoles } from "./config-intent.js";
export { KNOWN_ROLES } from "./config-intent.js";
import { homedir } from "node:os";
import path from "node:path";
import { AgentCommandError, formatAgentRoute, parseAgentRoute, validateAgentRoute } from "../../protocol/agent-command.js";
import type { AgentCommand, AgentRoute, Cast } from "../../protocol/types.js";

/** Built-in default lineup (L3). Role → agent; values frozen. */
export const DEFAULT_ROLES: Record<string, string> = {
  architect: "codex",
  executor: "pi",
  reviewer: "codex",
};

/** Final fallback for a role DEFAULT_ROLES does not know. Visible face: `tut create` warns (non-blocking) when the creator role is outside the conventional set — this fallback is what the warning explains. */
export const UNKNOWN_ROLE_AGENT = "codex";


/** Default tab-label template (naming.tab_label absent everywhere). */
export const DEFAULT_TAB_LABEL = "TUT {role}";

export interface ResolveOptions {
  /** Owning rig for config intent; independent of legacy workspace fallback. */
  rigRoot?: string;
  /** L1 project root (default: process cwd — same assumption as tut up's guardrail). */
  projectRoot?: string;
  /** Optional shared Hub root whose L1 declaration supplements the checkout L1. */
  fallbackProjectRoot?: string;
  /** L2 config dir (default: $TUT_USER_CONFIG_DIR, else ~/.config/tut). */
  userConfigDir?: string;
  /** A planner-bound config snapshot; when present no workspace files are read. */
  workspaceSnapshot?: WorkspaceConfigSnapshot;
}

/** Route plus the level that supplied it, for launch audit projections. */
export interface ResolvedAgentRoute {
  route: AgentRoute;
  binding?: InvocationBinding;
  source: "task-cast" | "config-project" | "workspace-project" | "workspace-user" | "builtin-default";
}

/** Default L2 dir: env override, else ~/.config/tut. */
export function defaultUserConfigDir(environment: NodeJS.ProcessEnv = process.env): string {
  const env = environment.TUT_USER_CONFIG_DIR;
  if (env !== undefined && env.length > 0) return env;
  return path.join(homedir(), ".config", "tut");
}

/**
 * The immutable workspace declaration consumed by one launch planner.  It is
 * deliberately separate from ExecutionContext: the latter is serialized into
 * the child invocation, while these parsed declarations stay parent-local and
 * never enter the Context Hub marker.
 */
export interface WorkspaceConfigSnapshot {
  readonly authoritative?: boolean;
  readonly bindings?: unknown;
  readonly projectRoot: string;
  readonly userConfigDir: string;
  readonly roles: readonly [Readonly<Record<string, AgentRoute>>, Readonly<Record<string, AgentRoute>>];
  readonly tabLabel: readonly [string | undefined, string | undefined];
}

/** Parsed workspace config file: roles per-key + naming.tab_label. */
interface WorkspaceLevels {
  /** role → route, per level (index 0 = L1, 1 = L2). */
  roles: [Record<string, AgentRoute>, Record<string, AgentRoute>];
  tabLabel: [string | undefined, string | undefined];
}

/** never-throw JSON read: any failure = absent level. */
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * roles.<role> entries → role → route map. Legacy `{label, agent}` entries
 * remain readable; new `{agent,args}` entries are normalized and invalid
 * routes make only that role absent so the chain can fall through.
 */
function parseRoles(raw: Record<string, unknown> | null): Record<string, AgentRoute> {
  const out: Record<string, AgentRoute> = Object.create(null);
  const roles = raw?.roles;
  if (roles === undefined || typeof roles !== "object" || roles === null || Array.isArray(roles)) return out;
  for (const [role, entry] of Object.entries(roles as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const fields = entry as Record<string, unknown>;
    const agent = fields.agent;
    try {
      if (typeof agent !== "string" || agent.length === 0) continue;
      out[role] = fields.args === undefined
        ? parseAgentRoute(agent, `workspace role '${role}'`)
        : validateAgentRoute({ agent, args: fields.args }, `workspace role '${role}'`);
    } catch (e) {
      // Workspace files are external declarations: a malformed role is
      // treated as absent and that role falls through to the next level.
      if (typeof agent === "string" && agent.startsWith("binding:")) throw e;
      if (!(e instanceof AgentCommandError)) continue;
    }
  }
  return out;
}

/** naming.tab_label when it is a non-empty string, else undefined. */
function parseTabLabel(raw: Record<string, unknown> | null): string | undefined {
  const naming = raw?.naming;
  if (naming === undefined || typeof naming !== "object" || naming === null || Array.isArray(naming)) return undefined;
  const label = (naming as Record<string, unknown>).tab_label;
  return typeof label === "string" && label.length > 0 ? label : undefined;
}

async function readLevels(
  projectRoot: string,
  userConfigDir: string,
  fallbackProjectRoot?: string,
): Promise<WorkspaceLevels> {
  const l1 = await readJson(path.join(projectRoot, ".context-hub", "workspace.json"));
  const fallback = fallbackProjectRoot !== undefined && path.resolve(fallbackProjectRoot) !== projectRoot
    ? await readJson(path.join(fallbackProjectRoot, ".context-hub", "workspace.json"))
    : null;
  const l2 = await readJson(path.join(userConfigDir, "workspace.json"));

  // A worktree may intentionally omit its own `.context-hub/` checkout.  Use
  // the shared Hub declaration as a supplemental L1: checkout-local values
  // win, while missing/corrupt fields fall back per role/template exactly as
  // the ordinary L1 → L2 chain does.
  const projectRoles = { ...parseRoles(fallback), ...parseRoles(l1) };
  const projectTabLabel = parseTabLabel(l1) ?? parseTabLabel(fallback);
  return {
    roles: [projectRoles, parseRoles(l2)],
    tabLabel: [projectTabLabel, parseTabLabel(l2)],
  };
}

function freezeData<T>(value:T):T {
  if(value && typeof value === 'object') {for(const v of Object.values(value)) freezeData(v);Object.freeze(value);}
  return value;
}

/** Resolve a selected logical route, retaining its identity for status/audit. */
export function resolveRouteBinding(route:AgentRoute, bindings:unknown):InvocationBinding|undefined {
  const command=normalizeAgentRoute(route);
  return resolveBindingReference(command.agent,command.args,bindings);
}

function freezeRoute(route: AgentRoute): AgentRoute {
  if (typeof route === "string") return route;
  const frozen: AgentCommand = {
    agent: route.agent,
    args: Object.freeze([...route.args]) as unknown as string[],
  };
  return Object.freeze(frozen) as AgentRoute;
}

function freezeRoleMap(routes: Record<string, AgentRoute>): Readonly<Record<string, AgentRoute>> {
  const frozen: Record<string, AgentRoute> = Object.create(null);
  for (const [role, route] of Object.entries(routes)) frozen[role] = freezeRoute(route);
  return Object.freeze(frozen);
}

/** Read and freeze both workspace levels once for a planner boundary. */
export async function readWorkspaceConfigSnapshot(
  opts: Omit<ResolveOptions, "workspaceSnapshot"> = {},
): Promise<WorkspaceConfigSnapshot> {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  const fallbackProjectRoot = opts.fallbackProjectRoot === undefined
    ? undefined
    : path.resolve(opts.fallbackProjectRoot);
  const userConfigDir = path.resolve(opts.userConfigDir ?? defaultUserConfigDir());
  // The shared rig selects intent; an execution checkout cannot replace it.
  const intentRoot = path.join(path.resolve(opts.rigRoot ?? fallbackProjectRoot ?? projectRoot), ".context-hub");
  const outcome = await readConfigFile(intentRoot);
  if (outcome.status === "invalid") throw new Error(`cannot read rig intent: ${configPath(intentRoot)} is unreadable or corrupt; repair it before launching`);
  const config = outcome.status === "ok" ? outcome.config : undefined;
  const authoritative = config !== undefined && Object.hasOwn(config, "roles");
  const levels: WorkspaceLevels = authoritative
    ? { roles: [parseConfigRoles(config.roles), {}], tabLabel: [parseTabLabel(config), undefined] }
    : await readLevels(projectRoot, userConfigDir, fallbackProjectRoot);
  // Display intent can move independently; the config section wins as a whole.
  if (config && Object.hasOwn(config, "naming")) levels.tabLabel = [parseTabLabel(config), undefined];
  return Object.freeze({
    authoritative,
    bindings: freezeData(structuredClone(config?.agent_bindings)),
    projectRoot,
    userConfigDir,
    roles: Object.freeze([freezeRoleMap(levels.roles[0]), freezeRoleMap(levels.roles[1])]) as readonly [
      Readonly<Record<string, AgentRoute>>,
      Readonly<Record<string, AgentRoute>>,
    ],
    tabLabel: Object.freeze([...levels.tabLabel]) as readonly [string | undefined, string | undefined],
  });
}

/** Short alias used by planner code that calls the value a workspace snapshot. */
export const readWorkspaceSnapshot = readWorkspaceConfigSnapshot;

/**
 * Resolve a role to its agent. Order (frozen): task cast → L1 project file
 * → L2 user file → DEFAULT_ROLES. Per-role fallback across levels.
 */
function parseRouteForResolution(route: AgentRoute, field: string): AgentRoute {
  return typeof route === "string" ? parseAgentRoute(route, field) : validateAgentRoute(route, field);
}

export async function resolveAgentRoute(role: string, cast?: Cast, opts: ResolveOptions = {}): Promise<AgentRoute> {
  return (await resolveAgentRouteWithSource(role, cast, opts)).route;
}

/**
 * Resolve a route without losing its provenance.  This is the planner-facing
 * sibling of resolveAgentRoute; the old function remains the compatibility
 * API used by callers that only need an AgentRoute.
 */
export async function resolveAgentRouteWithSource(
  role: string,
  cast?: Cast,
  opts: ResolveOptions = {},
): Promise<ResolvedAgentRoute> {
  const snapshot = opts.workspaceSnapshot ?? await readWorkspaceConfigSnapshot(opts);
  const selected=(route:AgentRoute,source:ResolvedAgentRoute["source"]):ResolvedAgentRoute => {
    const binding=resolveRouteBinding(route,snapshot.bindings);
    return {route,source,...(binding?{binding:freezeData(binding)}:{})};
  };
  const fromCast = cast?.[role as keyof Cast];
  if (fromCast !== undefined) {
    // A task cast is an explicit routing decision. Invalid input must stop at
    // the launch pre-check; silently falling through to a workspace/default
    // agent could launch the wrong executable and leave a misleading marker.
    return selected(parseRouteForResolution(fromCast, `cast role '${role}'`), "task-cast");
  }
  const project = Object.hasOwn(snapshot.roles[0], role) ? snapshot.roles[0][role] : undefined;
  if (project !== undefined) return selected(project, snapshot.authoritative ? "config-project" : "workspace-project");
  if (snapshot.authoritative) throw new Error(`config.roles has no role '${role}'; assign it explicitly or supply a task cast`);
  const user = snapshot.roles[1][role];
  if (user !== undefined) return selected(user, "workspace-user");
  return selected(DEFAULT_ROLES[role] ?? UNKNOWN_ROLE_AGENT, "builtin-default");
}

/** Resolve an already-snapshotted route without touching the filesystem. */
export async function resolveAgentRouteFromSnapshot(
  role: string,
  cast: Cast | undefined,
  snapshot: WorkspaceConfigSnapshot,
): Promise<ResolvedAgentRoute> {
  return await resolveAgentRouteWithSource(role, cast, { workspaceSnapshot: snapshot });
}

/**
 * Backward-compatible display wrapper. Existing callers that only know the
 * old string contract receive a bare name for legacy routes and a stable
 * shell-neutral display string for parameterized routes. Launch consumers use
 * resolveAgentRoute so args never need to be reparsed.
 */
export async function resolveAgent(role: string, cast?: Cast, opts: ResolveOptions = {}): Promise<string> {
  return formatAgentRoute(await resolveAgentRoute(role, cast, opts));
}

/**
 * Resolve the tab-label naming template (independent chain: L1 → L2 →
 * default "TUT {role}"). The consuming launch adapter renders the template
 * from the same frozen workspace snapshot as the route.
 */
export async function resolveTabLabelTemplate(opts: ResolveOptions = {}): Promise<string> {
  const snapshot = opts.workspaceSnapshot ?? await readWorkspaceConfigSnapshot(opts);
  return snapshot.tabLabel[0] ?? snapshot.tabLabel[1] ?? DEFAULT_TAB_LABEL;
}

/** Resolve naming from the same immutable config read as the route. */
export function resolveTabLabelTemplateFromSnapshot(snapshot: WorkspaceConfigSnapshot): string {
  return snapshot.tabLabel[0] ?? snapshot.tabLabel[1] ?? DEFAULT_TAB_LABEL;
}

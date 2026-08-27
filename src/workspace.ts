/**
 * Workspace lineup resolution — three-level chain.
 *
 * Single source for "which agent serves each role". Chain (per-field,
 * never-throw — a missing or corrupt file counts as that level being
 * absent, and reads fall through):
 *
 *   L1 project  <projectRoot>/.context-hub/workspace.json
 *   L2 user     <userConfigDir>/workspace.json   (TUT_USER_CONFIG_DIR, else ~/.config/tut)
 *   L3 built-in DEFAULT_ROLES
 *
 * roles fall back per role key (L1 defining executor only leaves architect
 * to L2/L3); `naming.tab_label` falls back independently (L1 → L2 →
 * "TUT {role}"). Entries may carry extra keys (the legacy {label, agent}
 * shape included) — only `.agent` is read. scripts/workspace.json in the
 * repo is a SEED (shape example) and is never read at runtime.
 *
 * TS consumers (assign / up / start-next / Notifier) resolve
 * through here; scripts/tut-resolve.mjs mirrors the exact chain for
 * launch.sh (plain node, zero-dep). Parity between the two implementations
 * is pinned by test (same fixture vectors, same output).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AgentCommandError, formatAgentRoute, parseAgentRoute, validateAgentRoute } from "./agent-command.js";
import type { AgentCommand, AgentRoute, Cast } from "./types.js";

/** Built-in default lineup (L3). Role → agent; values frozen. */
export const DEFAULT_ROLES: Record<string, string> = {
  architect: "codex",
  executor: "pi",
  reviewer: "codex",
};

/** Final fallback for a role DEFAULT_ROLES does not know (parity with tut-resolve.mjs). */
export const UNKNOWN_ROLE_AGENT = "codex";

export const KNOWN_ROLES = ["architect", "executor", "reviewer"] as const;

/** Default tab-label template (naming.tab_label absent everywhere). */
export const DEFAULT_TAB_LABEL = "TUT {role}";

export interface ResolveOptions {
  /** L1 project root (default: process cwd — same assumption as tut up's guardrail). */
  projectRoot?: string;
  /** L2 config dir (default: $TUT_USER_CONFIG_DIR, else ~/.config/tut). */
  userConfigDir?: string;
  /** A planner-bound config snapshot; when present no workspace files are read. */
  workspaceSnapshot?: WorkspaceConfigSnapshot;
}

/** Route plus the level that supplied it, for launch audit projections. */
export interface ResolvedAgentRoute {
  route: AgentRoute;
  source: "task-cast" | "workspace-project" | "workspace-user" | "builtin-default";
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
  const out: Record<string, AgentRoute> = {};
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

async function readLevels(projectRoot: string, userConfigDir: string): Promise<WorkspaceLevels> {
  const l1 = await readJson(path.join(projectRoot, ".context-hub", "workspace.json"));
  const l2 = await readJson(path.join(userConfigDir, "workspace.json"));
  return {
    roles: [parseRoles(l1), parseRoles(l2)],
    tabLabel: [parseTabLabel(l1), parseTabLabel(l2)],
  };
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
  const frozen: Record<string, AgentRoute> = {};
  for (const [role, route] of Object.entries(routes)) frozen[role] = freezeRoute(route);
  return Object.freeze(frozen);
}

/** Read and freeze both workspace levels once for a planner boundary. */
export async function readWorkspaceConfigSnapshot(
  opts: Omit<ResolveOptions, "workspaceSnapshot"> = {},
): Promise<WorkspaceConfigSnapshot> {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  const userConfigDir = path.resolve(opts.userConfigDir ?? defaultUserConfigDir());
  const levels = await readLevels(projectRoot, userConfigDir);
  return Object.freeze({
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
  const fromCast = cast?.[role as keyof Cast];
  if (fromCast !== undefined) {
    // A task cast is an explicit routing decision. Invalid input must stop at
    // the launch pre-check; silently falling through to a workspace/default
    // agent could launch the wrong executable and leave a misleading marker.
    return { route: parseRouteForResolution(fromCast, `cast role '${role}'`), source: "task-cast" };
  }
  const snapshot = opts.workspaceSnapshot ?? await readWorkspaceConfigSnapshot(opts);
  const project = snapshot.roles[0][role];
  if (project !== undefined) return { route: project, source: "workspace-project" };
  const user = snapshot.roles[1][role];
  if (user !== undefined) return { route: user, source: "workspace-user" };
  return { route: DEFAULT_ROLES[role] ?? UNKNOWN_ROLE_AGENT, source: "builtin-default" };
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
 * default "TUT {role}"). Rendering lives in scripts/tut-resolve.mjs
 * (`tab-label` subcommand) — the TS side has no tab-label consumer.
 */
export async function resolveTabLabelTemplate(opts: ResolveOptions = {}): Promise<string> {
  const snapshot = opts.workspaceSnapshot ?? await readWorkspaceConfigSnapshot(opts);
  return snapshot.tabLabel[0] ?? snapshot.tabLabel[1] ?? DEFAULT_TAB_LABEL;
}

/** Resolve naming from the same immutable config read as the route. */
export function resolveTabLabelTemplateFromSnapshot(snapshot: WorkspaceConfigSnapshot): string {
  return snapshot.tabLabel[0] ?? snapshot.tabLabel[1] ?? DEFAULT_TAB_LABEL;
}

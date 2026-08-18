/**
 * Workspace role mapping — frozen contract.
 *
 * Single source for "which label/agent serves each role". Parse order frozen:
 * scripts/workspace.json (roles.<role> = {label, agent}) → scripts/routes.json
 * (role → label, legacy) → DEFAULT_ROLES. All TS consumers (tut new / assign /
 * up) resolve through here; launch.sh mirrors the order in shell.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Cast } from "./types.js";

export interface WorkspaceRole {
  /** pane label the role routes to (physical seat managed via herdr rename) */
  label: string;
  /** which agent CLI occupies the seat (provisioning hint for tut up) */
  agent: string;
}

export const DEFAULT_ROLES: Record<string, WorkspaceRole> = {
  architect: { label: "arch", agent: "codex" },
  executor: { label: "exec", agent: "pi" },
  reviewer: { label: "review", agent: "codex" },
};

export const KNOWN_ROLES = ["architect", "executor", "reviewer"] as const;

export interface Workspace {
  roles: Partial<Record<string, WorkspaceRole>>;
}

/** scripts/ dir resolved module-relative — CLI never depends on cwd for this. */
export function scriptsDir(): string {
  return path.resolve(import.meta.dirname, "../scripts");
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readWorkspaceFile(dir: string): Promise<Workspace> {
  const raw = await readJson(path.join(dir, "workspace.json"));
  const roles = raw.roles;
  if (roles === undefined || typeof roles !== "object" || roles === null) return { roles: {} };
  const out: Workspace = { roles: {} };
  for (const [role, entry] of Object.entries(roles as Record<string, unknown>)) {
    if (typeof entry === "object" && entry !== null) {
      const { label, agent } = entry as Record<string, unknown>;
      if (typeof label === "string" && label.length > 0 && typeof agent === "string") {
        out.roles[role] = { label, agent };
      }
    }
  }
  return out;
}

async function readRoutesFile(dir: string): Promise<Record<string, string>> {
  const raw = await readJson(path.join(dir, "routes.json"));
  const out: Record<string, string> = {};
  for (const [role, label] of Object.entries(raw)) {
    if (typeof label === "string" && label.length > 0 && role !== "$comment") out[role] = label;
  }
  return out;
}

/**
 * Resolve a role to its seat. Order (frozen): workspace.json entry →
 * routes.json label (+ default agent) → DEFAULT_ROLES.
 *
 * @deprecated legacy: consumers migrate to resolveAgent — panes are now
 * agent-keyed (label = agent name); the {label, agent} shape and this
 * resolver stay for the transition period.
 */
export async function resolveRole(role: string, dir = scriptsDir()): Promise<WorkspaceRole> {
  const ws = await readWorkspaceFile(dir);
  const fromWs = ws.roles[role];
  if (fromWs !== undefined) return fromWs;
  const routes = await readRoutesFile(dir);
  const label = routes[role];
  if (label !== undefined) {
    return { label, agent: DEFAULT_ROLES[role]?.agent ?? "codex" };
  }
  return DEFAULT_ROLES[role] ?? { label: role, agent: "codex" };
}

/**
 * Routing chain, single source for both launch doors (start-next / auto):
 * task cast → workspace.json agent (label deprecated, agent-only entries
 * accepted) → routes.json value (legacy label read as an agent name) →
 * DEFAULT_ROLES. Returns the agent name the launcher should raise for `role`.
 */
export async function resolveAgent(role: string, cast?: Cast, dir = scriptsDir()): Promise<string> {
  const fromCast = cast?.[role as keyof Cast];
  if (typeof fromCast === "string" && fromCast.length > 0) return fromCast;
  const raw = await readJson(path.join(dir, "workspace.json"));
  const entry = raw.roles;
  if (entry !== undefined && typeof entry === "object" && entry !== null) {
    const seat = (entry as Record<string, unknown>)[role];
    if (typeof seat === "object" && seat !== null) {
      const agent = (seat as Record<string, unknown>).agent;
      if (typeof agent === "string" && agent.length > 0) return agent;
    }
  }
  const routes = await readRoutesFile(dir);
  if (routes[role] !== undefined) return routes[role]; // legacy value ≡ agent name
  return DEFAULT_ROLES[role]?.agent ?? "codex";
}

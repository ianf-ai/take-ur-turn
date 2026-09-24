import { readFile } from "node:fs/promises";
import path from "node:path";
import { autoSectionOf, configPath, readConfigFile } from "../../common/config.js";
import { AgentCommandError, parseAgentRoute, validateAgentRoute } from "../../common/agent-command.js";
import { DEFAULT_ROLES, KNOWN_ROLES, UNKNOWN_ROLE_AGENT, defaultUserConfigDir, resolveAgentRouteWithSource } from "../../common/workspace.js";
import type { AgentRoute } from "../../common/types.js";
import { worst, isErrnoException } from "../shared.js";
import type { DoctorCheck, DoctorContext, DoctorStatus } from "../types.js";

// --- check 3: config + workspace chain ------------------------------------------

type JsonRead =
  | { status: "missing" }
  | { status: "corrupt"; error: string }
  | { status: "unreadable"; error: string }
  | { status: "ok"; value: Record<string, unknown> };

async function readJsonDiagnostic(file: string): Promise<JsonRead> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if (isErrnoException(e, "ENOENT")) return { status: "missing" };
    return { status: "unreadable", error: (e as Error).message };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "corrupt", error: "not a JSON object" };
    }
    return { status: "ok", value: parsed as Record<string, unknown> };
  } catch (e) {
    return { status: "corrupt", error: (e as Error).message };
  }
}

/** Roles + naming as declared in ONE workspace file (doctor's own read: it
 *  must report what the chain silently discards). Route acceptance reuses
 *  the production chain's own validators (agent-command.ts) — an illegal
 *  shell token or wrong-shaped args is a FINDING here, never a silently
 *  displayed illegal route. */
interface WorkspaceView {
  roles: Record<string, AgentRoute>;
  tabLabel?: string;
  /** Per-role route problems with the validator's own message as evidence. */
  malformedRoles: Array<{ role: string; error: string }>;
  /** Top-level roles container is not an object — a fail-level finding. */
  rolesContainerError?: string;
  malformedNaming: boolean;
}

function workspaceViewOf(value: Record<string, unknown>): WorkspaceView {
  const roles: Record<string, AgentRoute> = {};
  const malformedRoles: Array<{ role: string; error: string }> = [];
  let rolesContainerError: string | undefined;
  const rawRoles = value.roles;
  if (rawRoles !== undefined) {
    if (typeof rawRoles !== "object" || rawRoles === null || Array.isArray(rawRoles)) {
      rolesContainerError = "roles must be an object of role=agent declarations";
    } else {
      for (const [role, entry] of Object.entries(rawRoles as Record<string, unknown>)) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          malformedRoles.push({
            role,
            error: "entry must be an {agent,args?} object (the chain drops bare strings and arrays)",
          });
          continue;
        }
        const fields = entry as Record<string, unknown>;
        if (typeof fields.agent !== "string" || fields.agent.length === 0) {
          malformedRoles.push({ role, error: "agent missing or empty" });
          continue;
        }
        try {
          // Same acceptance as the chain's parseRoles: agent string parsed as a
          // command (shell-neutral token grammar), or the explicit argv form.
          roles[role] = fields.args === undefined
            ? parseAgentRoute(fields.agent, `workspace role '${role}'`)
            : validateAgentRoute({ agent: fields.agent, args: fields.args }, `workspace role '${role}'`);
        } catch (e) {
          if (e instanceof AgentCommandError) {
            malformedRoles.push({ role, error: e.message });
            continue;
          }
          throw e;
        }
      }
    }
  }
  const naming = value.naming;
  let malformedNaming = false;
  let tabLabel: string | undefined;
  if (naming !== undefined) {
    if (typeof naming !== "object" || naming === null || Array.isArray(naming)) {
      malformedNaming = true;
    } else {
      const label = (naming as Record<string, unknown>).tab_label;
      if (label === undefined) {
        // absent is fine
      } else if (typeof label === "string" && label.length > 0) {
        tabLabel = label;
      } else {
        malformedNaming = true;
      }
    }
  }
  return {
    roles,
    ...(tabLabel !== undefined ? { tabLabel } : {}),
    malformedRoles,
    ...(rolesContainerError !== undefined ? { rolesContainerError } : {}),
    malformedNaming,
  };
}

/** formatAgentRoute equivalent without importing agent-command (display only). */
function displayRoute(route: AgentRoute): string {
  return typeof route === "string" ? route : [route.agent, ...route.args].join(" ");
}

/** Roles any workspace level declares (drives checks 4/8's role set). */
async function declaredWorkspaceRoles(ctx: DoctorContext): Promise<Set<string>> {
  const roles = new Set<string>(KNOWN_ROLES);
  for (const file of [ctx.l1WorkspaceFile, path.join(defaultUserConfigDir(ctx.env), "workspace.json")]) {
    const read = await readJsonDiagnostic(file);
    if (read.status === "ok") {
      for (const role of Object.keys(workspaceViewOf(read.value).roles)) roles.add(role);
    }
  }
  return roles;
}

async function checkConfig(ctx: DoctorContext): Promise<DoctorCheck> {
  const check: DoctorCheck = {
    name: "config",
    title: "config & workspace chain",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];

  // config.json — same reader tut config uses (missing = defaults, invalid = fail).
  const cfgFile = configPath(ctx.root);
  const cfg = await readConfigFile(ctx.root);
  if (cfg.status === "invalid") {
    statuses.push("fail");
    check.details.push(`${cfgFile}: unreadable or corrupt — serve falls back to flow_mode=manual and drops notify/auto silently`);
    check.fix = `fix the JSON by hand: ${cfgFile} (tut config get refuses corrupt files too)`;
  } else if (cfg.status === "missing") {
    check.details.push(`${cfgFile}: absent — defaults apply (flow_mode=manual)`);
  } else {
    const auto = autoSectionOf(cfg.config);
    check.details.push(
      `${cfgFile}: flow_mode=${cfg.config.flow_mode}` +
        (auto !== undefined ? `, auto.launch_roles=[${auto.launch_roles.join(",")}]` : "") +
        ("notify" in cfg.config ? `, notify=${JSON.stringify(cfg.config.notify)}` : ""),
    );
    if (auto === undefined && cfg.config.auto !== undefined) {
      statuses.push("warn");
      check.details.push("auto section present but malformed — reads as absent (auto mode withholds all launches)");
    }
    const notify = (cfg.config as Record<string, unknown>).notify;
    if (notify !== undefined && (typeof notify !== "object" || notify === null || Array.isArray(notify))) {
      statuses.push("warn");
      check.details.push("notify config is not an object — channels ignore it");
    }
  }

  // workspace.json L1/L2 — the chain treats corrupt files as absent; doctor
  // surfaces that fall-through so a typo'd declaration is not silent.
  const l1File = ctx.l1WorkspaceFile;
  const l2File = path.join(defaultUserConfigDir(ctx.env), "workspace.json");
  const declaredRoles = new Set<string>(KNOWN_ROLES);
  const levels: Array<{ label: string; file: string; read: JsonRead }> = [
    { label: "L1 project", file: l1File, read: await readJsonDiagnostic(l1File) },
    { label: "L2 user", file: l2File, read: await readJsonDiagnostic(l2File) },
  ];
  for (const level of levels) {
    if (level.read.status === "missing") {
      check.details.push(`${level.label} ${level.file}: absent — chain falls through`);
      continue;
    }
    if (level.read.status === "corrupt" || level.read.status === "unreadable") {
      statuses.push("fail");
      check.details.push(
        `${level.label} ${level.file}: ${level.read.status} (${level.read.error}) — resolution silently falls through this level`,
      );
      check.fix ??= `fix the JSON by hand: ${level.file} (tut assign never clobbers a file it cannot parse)`;
      continue;
    }
    const view = workspaceViewOf(level.read.value);
    if (view.rolesContainerError !== undefined) {
      statuses.push("fail");
      check.details.push(
        `${level.label} ${level.file}: roles: ${view.rolesContainerError} — resolution silently falls through this level`,
      );
      check.fix ??= `fix the JSON by hand: ${level.file} (tut assign never clobbers a file it cannot parse)`;
    }
    for (const problem of view.malformedRoles) {
      statuses.push("fail");
      check.details.push(
        `${level.label} roles.${problem.role}: malformed (${problem.error}) — the chain silently treats it as absent`,
      );
      check.fix ??= `fix the declaration by hand (${level.file}) or re-point the seat: tut assign ${problem.role} <command...>`;
    }
    if (view.malformedNaming) {
      statuses.push("warn");
      check.details.push(`${level.label} naming: malformed — template falls back`);
    }
    const roleKeys = Object.keys(view.roles);
    for (const role of roleKeys) declaredRoles.add(role);
    check.details.push(
      `${level.label} ${level.file}: ` +
        (roleKeys.length > 0 ? roleKeys.map((r) => `${r}=${displayRoute(view.roles[r]!)}`).join(", ") : "no role declarations") +
        (view.tabLabel !== undefined ? `; naming.tab_label='${view.tabLabel}'` : ""),
    );
  }

  // Effective resolution per role (cast is task-level, not global — not shown here).
  for (const role of [...declaredRoles].sort()) {
    const resolved = await resolveAgentRouteWithSource(role, undefined, {
      projectRoot: ctx.projectRoot,
      userConfigDir: defaultUserConfigDir(ctx.env),
    });
    const known = role in DEFAULT_ROLES;
    check.details.push(
      `effective ${role} → ${displayRoute(resolved.route)} (${resolved.source}` +
        (!known ? `, unknown-role fallback: not in the builtin lineup — resolves to ${UNKNOWN_ROLE_AGENT}` : "") +
        ")",
    );
    if (!known) statuses.push("warn");
  }
  check.status = worst(statuses);
  check.summary =
    check.status === "fail"
      ? "config/workspace files corrupt — see details (resolution is silently degraded)"
      : "config.json + workspace chain parsed; effective lineup above";
  return check;
}

export { checkConfig, declaredWorkspaceRoles };

import { AgentTargetError, normalizeRouteCommand } from "../../launcher/target-resolver.js";
import { defaultUserConfigDir, resolveAgentRouteWithSource } from "../../common/workspace.js";
import { worst } from "../shared.js";
import type { DoctorCheck, DoctorContext, DoctorStatus } from "../types.js";

// --- check 4: agents ------------------------------------------------------------

/** One distinct agent command's probe outcome (shared by checks 4 and 8). */
interface AgentProbe {
  status: DoctorStatus;
  /** The CLI itself is missing/unresolvable — channel verdicts are withheld. */
  missing: boolean;
  message: string;
}

async function checkAgents(
  ctx: DoctorContext,
  declaredRoles: Set<string>,
): Promise<{ check: DoctorCheck; probes: Map<string, AgentProbe> }> {
  const check: DoctorCheck = {
    name: "agents",
    title: "agent executables",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];
  // One probe per distinct command word — architect/reviewer often share codex.
  const probes = new Map<string, AgentProbe>();
  for (const role of [...declaredRoles].sort()) {
    const resolved = await resolveAgentRouteWithSource(role, undefined, {
      projectRoot: ctx.projectRoot,
      userConfigDir: defaultUserConfigDir(ctx.env),
    });
    const command = normalizeRouteCommand(resolved.route);
    let status: DoctorStatus;
    const cached = probes.get(command.agent);
    if (cached !== undefined) {
      status = cached.status;
    } else {
      try {
        const plan = await ctx.resolveTarget(command);
        const kind = plan.platform === "posix" ? "posix direct spawn" : (plan.resolved_target?.kind ?? "windows target");
        status = "ok";
        probes.set(command.agent, { status, missing: false, message: `${command.agent}: resolvable (${kind})` });
        check.details.push(`${command.agent}: resolvable (${kind})`);
      } catch (e) {
        if (e instanceof AgentTargetError) {
          status = e.reason.includes("which is not installed") ? "warn" : "fail";
          probes.set(command.agent, { status, missing: true, message: e.message });
          check.details.push(`${command.agent}: ${e.message}`);
        } else {
          status = "fail";
          probes.set(command.agent, { status, missing: true, message: (e as Error).message });
          check.details.push(`${command.agent}: resolution failed (${(e as Error).message})`);
        }
      }
    }
    statuses.push(status);
  }
  check.status = worst(statuses);
  const failing = [...probes.entries()].filter(([, p]) => p.status === "fail").map(([agent]) => agent);
  check.summary =
    check.status === "fail"
      ? `agent command(s) not usable: ${failing.join(", ")} — seats routing to them cannot launch`
      : `all routed agent commands resolvable (${[...probes.keys()].sort().join(", ")})`;
  if (check.status === "fail") {
    check.fix = "install the agent, or re-point the seat: tut assign <role> <command...>";
  }
  return { check, probes };
}

export { checkAgents };
export type { AgentProbe };

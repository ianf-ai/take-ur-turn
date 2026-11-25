import {networkPostureFor} from '../../../agents/public/diagnostics.js';
import { normalizeRouteCommand } from "../../launcher/target-resolver.js";
import { defaultUserConfigDir, resolveAgentRouteWithSource } from "../../common/workspace.js";
import { worst } from "../shared.js";
import type { AgentChannelSeatVerdict, AgentChannelUdsVerdict, DoctorCheck, DoctorContext, DoctorStatus } from "../types.js";
import type { AgentProbe } from "./agents.js";

// --- check 8: agent channel / network ---------------------------------------------

async function checkAgentChannel(
  ctx: DoctorContext,
  declaredRoles: Set<string>,
  hubReachable: boolean,
  probes: Map<string, AgentProbe>,
): Promise<DoctorCheck> {
  const check: DoctorCheck = {
    name: "agent-channel",
    title: "agent channel network",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];
  const seats: AgentChannelSeatVerdict[] = [];
  check.details.push(
    `agents reach the hub over MCP/HTTP at ${ctx.url}/mcp — an outbound-network-denying sandbox on an agent seat breaks its context tools with no error surfaced in the agent session or logs`,
  );
  for (const role of [...declaredRoles].sort()) {
    let resolved;
    try {
      resolved = await resolveAgentRouteWithSource(role, undefined, {
        projectRoot: ctx.projectRoot,
        userConfigDir: defaultUserConfigDir(ctx.env),
      });
    } catch(error) {
      statuses.push("fail");
      seats.push({role, agent: "binding unresolved", code: "unknown", reason: "agent-cli-missing", detail: (error as Error).message});
      check.details.push(`${role}: ${(error as Error).message}`);
      continue;
    }
    const command = normalizeRouteCommand(resolved.route);
    const probe = probes.get(command.agent);
    let verdict: AgentChannelSeatVerdict;
    if (probe?.missing) {
      verdict = {
        role,
        agent: command.agent,
        code: "unknown",
        reason: "agent-cli-missing",
        detail: `${command.agent} is not resolvable (see the agents check) — the channel verdict is withheld until the CLI exists`,
      };
    } else if (!hubReachable) {
      verdict = {
        role,
        agent: command.agent,
        code: "unknown",
        reason: "hub-unreachable",
        detail: "hub /state did not answer (see the hub check) — the loopback path cannot be verified end to end",
      };
    } else {
      const {warn,...posture}=networkPostureFor(command.agent,command.args);
      if(warn)statuses.push('warn');
      verdict={role,...posture};
    }
    seats.push(verdict);
    check.details.push(`${verdict.role}: ${verdict.code} (${verdict.reason}) — ${verdict.detail}`);
  }
  check.seats = seats;
  // The UDS mitigation channel's own status — machine-readable, honestly
  // negative: it does not exist in the current hub, so it cannot carry
  // anything; the loopback-UDS investigation stays open.
  const uds: AgentChannelUdsVerdict = {
    code: "infeasible",
    reason: "not-shipped",
    evidence:
      "no UDS channel exists in the current hub — HTTP/MCP on loopback is the only shipped transport (investigation open)",
    action:
      "for sandbox-denied seats: --sandbox danger-full-access or a network-allowing profile; a loopback UDS hub channel remains the registered mitigation direction",
  };
  check.uds = uds;
  check.details.push(`loopback UDS hub channel: ${uds.code} (${uds.reason}) — ${uds.evidence}; action: ${uds.action}`);
  check.status = worst(statuses);
  check.summary =
    check.status === "warn"
      ? "network-denying sandbox on codex seat(s) — see details"
      : `per-seat channel verdicts recorded (${seats.map((s) => `${s.role}=${s.code}`).join(", ")}); UDS: ${uds.code} (${uds.reason})`;
  if (check.status === "warn") {
    check.fix =
      "give TUT role seats full access (--sandbox danger-full-access) or a network-allowing profile; a loopback UDS hub channel is the registered mitigation direction (not yet shipped)";
  }
  return check;
}

export { checkAgentChannel };

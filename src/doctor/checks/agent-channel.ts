import path from "node:path";
import { normalizeRouteCommand } from "../../launcher/target-resolver.js";
import { defaultUserConfigDir, resolveAgentRouteWithSource } from "../../common/workspace.js";
import { worst } from "../shared.js";
import type { AgentChannelSeatVerdict, AgentChannelUdsVerdict, DoctorCheck, DoctorContext, DoctorStatus } from "../types.js";
import type { AgentProbe } from "./agents.js";

// --- check 8: agent channel / network ---------------------------------------------

/** Parse the effective --sandbox mode out of an argv (both `--sandbox X` and
 *  `--sandbox=X`); undefined when the flag is absent. */
function codexSandboxMode(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--sandbox") return args[i + 1];
    if (arg.startsWith("--sandbox=")) return arg.slice("--sandbox=".length);
  }
  return undefined;
}

function isCodexFamily(agent: string): boolean {
  const base = path.basename(agent).toLowerCase();
  return base === "codex" || base.startsWith("codex");
}

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
    `agents reach the hub over MCP/HTTP at ${ctx.url}/mcp — an outbound-network-denying sandbox on an agent seat breaks its context tools with no error surfaced in the pane`,
  );
  for (const role of [...declaredRoles].sort()) {
    const resolved = await resolveAgentRouteWithSource(role, undefined, {
      projectRoot: ctx.projectRoot,
      userConfigDir: defaultUserConfigDir(ctx.env),
    });
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
    } else if (isCodexFamily(command.agent)) {
      const mode = codexSandboxMode(command.args);
      if (mode === "danger-full-access") {
        verdict = {
          role,
          agent: command.agent,
          code: "feasible",
          reason: "sandbox-allows-network",
          detail:
            "codex --sandbox danger-full-access — the seat's own argv grants network; hub answered loopback from this machine",
        };
      } else if (mode === "read-only" || mode === "workspace-write") {
        statuses.push("warn");
        verdict = {
          role,
          agent: command.agent,
          code: "infeasible",
          reason: "sandbox-network-denied",
          detail: `codex --sandbox ${mode} denies outbound network — this seat's MCP/HTTP calls to the hub fail silently; hub-side writes from this role will simply never land`,
        };
      } else {
        verdict = {
          role,
          agent: command.agent,
          code: "unknown",
          reason: "sandbox-posture-unverified",
          detail:
            mode === undefined
              ? "codex without an explicit --sandbox flag — the codex-level default applies and cannot be verified statically"
              : `codex --sandbox ${mode} is not a recognized mode — verify its network posture`,
        };
      }
    } else {
      // Non-codex agents carry no flag doctor can read: host-level loopback
      // reachability is NOT seat evidence — the honest verdict is unknown.
      verdict = {
        role,
        agent: command.agent,
        code: "unknown",
        reason: "agent-posture-unverified",
        detail:
          `no per-seat network evidence for this agent family (no sandbox wrapper detected; host-level loopback says nothing about this seat)`,
      };
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

/** Native argv evidence for per-seat network diagnostics; no host I/O. */
import path from 'node:path';
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

export function networkPostureFor(agent:string,args:readonly string[]) {
 let warn=false;
 let verdict:{agent:string;code:'feasible'|'infeasible'|'unknown';reason:'sandbox-allows-network'|'sandbox-network-denied'|'sandbox-posture-unverified'|'agent-posture-unverified';detail:string};
 if (isCodexFamily(agent)) {
      const mode = codexSandboxMode(args);
      if (mode === "danger-full-access") {
        verdict = {
          agent: agent,
          code: "feasible",
          reason: "sandbox-allows-network",
          detail:
            "codex --sandbox danger-full-access — the seat's own argv grants network; hub answered loopback from this machine",
        };
      } else if (mode === "read-only" || mode === "workspace-write") {
        warn=true;
        verdict = {
          agent: agent,
          code: "infeasible",
          reason: "sandbox-network-denied",
          detail: `codex --sandbox ${mode} denies outbound network — this seat's MCP/HTTP calls to the hub fail silently; hub-side writes from this role will simply never land`,
        };
      } else {
        verdict = {
          agent: agent,
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
        agent: agent,
        code: "unknown",
        reason: "agent-posture-unverified",
        detail:
          `no per-seat network evidence for this agent family (no sandbox wrapper detected; host-level loopback says nothing about this seat)`,
      };
 }
 return {...verdict,warn};
}

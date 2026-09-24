import type { AgentCommand } from "../common/types.js";
import type { PlatformExecutionPlan } from "../launcher/target-resolver.js";

export type DoctorStatus = "ok" | "warn" | "fail";

/** The per-seat agent→hub channel conclusion. `unknown` is an
 *  honest verdict, not a gap — each reason names exactly what withheld it.
 *  `feasible` requires PER-SEAT evidence (the seat's own argv grants
 *  network); doctor's own loopback reachability is host evidence and never
 *  qualifies a seat it cannot speak for. */
export type AgentChannelCode = "feasible" | "infeasible" | "unknown";

export type AgentChannelReason =
  | "sandbox-allows-network" // feasible: codex --sandbox danger-full-access — the seat's own argv grants network
  | "sandbox-network-denied" // infeasible: codex --sandbox read-only / workspace-write denies outbound network
  | "hub-unreachable" // unknown: /state did not answer — the loopback path cannot be verified end to end
  | "agent-cli-missing" // unknown: the seat's CLI is not resolvable — nothing to carry a channel
  | "sandbox-posture-unverified" // unknown: codex without an explicit --sandbox flag — codex-level default, unverifiable statically
  | "agent-posture-unverified"; // unknown: non-codex agent — TUT holds no per-seat network evidence for this family

/** Stable machine-readable verdict for one agent seat (check 8, --json). */
export interface AgentChannelSeatVerdict {
  role: string;
  agent: string;
  code: AgentChannelCode;
  reason: AgentChannelReason;
  detail: string;
}

/** The loopback UDS hub channel's own machine-readable status:
 *  stable code/reason/evidence — not free text. */
export interface AgentChannelUdsVerdict {
  code: AgentChannelCode;
  reason: "not-shipped";
  evidence: string;
  action?: string;
}

export interface DoctorCheck {
  /** Stable check id (1..8 order preserved by the runner). */
  name: string;
  /** Human label. */
  title: string;
  status: DoctorStatus;
  /** One-line outcome. */
  summary: string;
  /** Additional lines (evidence, notes). */
  details: string[];
  /** Actionable guidance — commands the human can run. */
  fix?: string;
  /** Check 8 only: per-seat machine-readable channel verdicts. */
  seats?: AgentChannelSeatVerdict[];
  /** Check 8 only: the loopback UDS channel's own machine-readable status. */
  uds?: AgentChannelUdsVerdict;
}

export interface DoctorReport {
  /** True iff no check failed (warnings allowed). */
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /** Storage root (default `.context-hub` relative to cwd — same as serve/config). */
  root?: string;
  /** Owning rig root, independent of the storage diagnostic --root. */
  hubRoot?: string;
  /** Hub base URL (default http://127.0.0.1:3001). */
  url?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Node version to report (defaults to process.version). */
  nodeVersion?: string;
  /** Fetch seam (tests inject; production uses global fetch). */
  fetchImpl?: typeof fetch;
  /** Target-resolution seam over the launcher resolver (tests inject). */
  resolveTarget?: (command: AgentCommand) => Promise<PlatformExecutionPlan>;
}

interface DoctorContext {
  hubRoot: string;
  root: string;
  projectRoot: string;
  /** L1 workspace file as the resolver chain sees it: <parent>/.context-hub/workspace.json —
   *  identical to <root>/workspace.json for conventional roots (basename
   *  ".context-hub"), and the launcher's honest chain input otherwise. */
  l1WorkspaceFile: string;
  url: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeVersion: string;
  fetchImpl: typeof fetch;
  resolveTarget: (command: AgentCommand) => Promise<PlatformExecutionPlan>;
}

export type { DoctorContext };

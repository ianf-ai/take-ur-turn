/** Shared target contracts and the single error-class identities. */
import type { Stats } from "node:fs";
import type { LaunchInvocation, PosixDirectPlan } from "../../common/types.js";

/** A route target could not be resolved to an executable this launcher may run. */
export class AgentTargetError extends Error {
  /** The bare route agent whose target failed to resolve. */
  readonly agent: string;
  /** Machine-oriented reason (e.g. "no candidate", "not executable"). */
  readonly reason: string;
  /** Actionable fix advice for the human/agent reading the stderr line. */
  readonly hint: string;

  constructor(agent: string, reason: string, hint: string) {
    super(`agent '${agent}' ${reason} — ${hint}`);
    this.name = "AgentTargetError";
    this.agent = agent;
    this.reason = reason;
    this.hint = hint;
  }
}

/** Windows shim targets (.cmd/.bat/.ps1/.sh, file associations) are refused closed. */
export class UnsupportedWindowsShimError extends AgentTargetError {
  /** The shim path where.exe selected for the fail-closed refusal. */
  readonly shimPath: string;

  constructor(agent: string, shimPath: string, hint: string) {
    super(agent, `resolves to a Windows shim (${shimPath})`, hint);
    this.name = "UnsupportedWindowsShimError";
    this.shimPath = shimPath;
  }
}

/** Structured Windows target; never a shell command string. */
export interface ResolvedAgentTarget {
  kind: "native" | "node-entry";
  /** Absolute native path, or the Node executable for a direct entry. */
  executable: string;
  /** Ordered argv inserted before route args (the script path for node-entry). */
  prefix_args: string[];
  /** Absolute path of the file where.exe selected. */
  source_path: string;
}

export type EffectiveAgentPlan = NonNullable<LaunchInvocation["effective_agent"]>;

/** Unified platform execution plan carried by one frozen invocation. */
export type PlatformExecutionPlan =
  | { platform: "posix"; posix_direct: PosixDirectPlan }
  | { platform: "windows"; resolved_target: ResolvedAgentTarget; effective_agent: EffectiveAgentPlan };

export interface ProbeResult {
  code: number | null;
  stdout: string;
  error?: Error;
}

export interface WindowsTargetDeps {
  /** Lists candidate paths in resolution order; defaults to the PATH+PATHEXT
   * self-enumeration with where.exe as the PATH-less fallback. */
  candidates?: (agent: string) => Promise<string[]>;
  /** Runs one fact-probe child over a chunk of candidates; defaults to a
   * direct node spawn of the built-in fact script.  Only the transport is
   * injected — streaming consumption, the budget kill, and the resume all
   * live in the resolver's session, so scripted runners (tests hanging a
   * child at a chosen candidate) exercise production behavior. */
  factProbe?: (argv: readonly string[]) => FactProbeChild;
  /** File facts for a candidate path.  The AbortSignal fires on budget
   * expiry — adapters that can honor it should reject on abort; every call
   * is additionally raced against the budget, so even a signal-ignoring
   * adapter returns control within the budget. */
  stat?: (candidate: string, signal?: AbortSignal) => Promise<Stats>;
  /** Reads leading file bytes for extensionless PE detection, under the
   * same budget + signal semantics as stat. */
  readHeader?: (candidate: string, bytes: number, signal?: AbortSignal) => Promise<Buffer>;
  /** Node executable for node-entry targets; defaults to process.execPath. */
  nodeExecutable?: string;
  /** Environment for PATH/PATHEXT enumeration; defaults to process.env. */
  environment?: NodeJS.ProcessEnv;
}

/** Terminal outcome of one fact-probe child, as the session observes it. */
export type FactProbeExit =
  | { kind: "exit"; code: number | null }
  | { kind: "error"; error: Error };

/** Transport handle for one fact-probe child.  Deliberately dumb — the
 * budget timer and the timeout bookkeeping live in the session, so the
 * handle only moves bytes and terminal events (tests script these to hang
 * a child at a chosen candidate). */
export interface FactProbeChild {
  /** Stops the child unconditionally (SIGKILL-equivalent); idempotent. */
  kill(): void;
  /** Delivers every complete stdout line, in emission order. */
  onLine(callback: (line: string) => void): void;
  /** Delivers the terminal outcome exactly once (natural exit or spawn
   * error); never fires after kill(). */
  onEnd(callback: (outcome: FactProbeExit) => void): void;
}

export interface PosixTargetDeps {
  /** Runs `which <agent>`; defaults to a direct shell:false spawn under the
   * bounded probe timeout (a hung which is killed, not waited out). */
  which?: (agent: string) => Promise<ProbeResult>;
  /** File facts for the which candidate; defaults to fs.stat. */
  stat?: (candidate: string) => Promise<Stats>;
}

export interface SelfUpdatePolicy {
  args: string[];
  env: Record<string, string>;
}

export interface PlatformPlanOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  windowsDeps?: WindowsTargetDeps;
}

export interface ResolvePlatformExecutionPlanOptions extends PlatformPlanOptions {
  posixDeps?: PosixTargetDeps;
}

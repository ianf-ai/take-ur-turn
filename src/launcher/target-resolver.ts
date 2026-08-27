/**
 * Platform executable-target resolution (launcher port design §3).
 *
 * Windows uses a structured resolver over `where.exe`: it returns a native
 * executable or a direct Node entry, and refuses shell/file-association
 * shims (.cmd/.bat/.ps1/.sh and friends) before any marker or Herdr
 * mutation.  POSIX keeps the bare-name direct-target contract: `which` is
 * only a presence preflight — its output path never enters an invocation,
 * and PaneCommand/execvp keep the bare route agent.
 *
 * This module also freezes the self-update suppression policy once per
 * plan so every launch door (start-next, Notifier auto, legacy compat)
 * expresses the same platform execution plan.
 */

import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { open as fsOpen, stat as fsStatPromises } from "node:fs/promises";
import path from "node:path";
import type {
  AgentCommand,
  AgentRoute,
  LaunchInvocation,
  PosixDirectPlan,
} from "../types.js";

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

const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1", ".sh"]);
const NODE_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_NATIVE_HINT =
  "install the native executable, or point the workspace/task cast at a direct Node entry route (node + script) with node.exe on PATH";
const POSIX_PRESENCE_HINT =
  "install it, or fix the task cast / workspace lineup";

// ---------------------------------------------------------------------------
// Injectable seams (fixtures cover where.exe/which output variance)
// ---------------------------------------------------------------------------

export interface ProbeResult {
  code: number | null;
  stdout: string;
  error?: Error;
}

/** Default adapter: one direct argv spawn with shell:false. */
function probeExecutable(
  file: string,
  args: readonly string[],
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      resolve({ code: null, stdout, error: error as Error });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, stdout, error });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout });
    });
  });
}

export interface WindowsTargetDeps {
  /** Runs `where.exe <agent>`; defaults to a direct shell:false spawn. */
  where?: (agent: string) => Promise<ProbeResult>;
  /** File facts for a candidate path; defaults to fs.stat. */
  stat?: (candidate: string) => Promise<Stats>;
  /** Reads leading file bytes for extensionless PE detection. */
  readHeader?: (candidate: string, bytes: number) => Promise<Buffer>;
  /** Node executable for node-entry targets; defaults to process.execPath. */
  nodeExecutable?: string;
}

/**
 * Default header adapter: read only the leading bytes of the candidate via
 * the direct file API (open → positioned read → close).  The file is never
 * executed here and never read whole — two bytes are all PE detection needs.
 */
async function readHeaderDefault(candidate: string, bytes: number): Promise<Buffer> {
  const handle = await fsOpen(candidate, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return bytesRead >= bytes ? buffer : buffer.subarray(0, Math.max(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export interface PosixTargetDeps {
  /** Runs `which <agent>`; defaults to a direct shell:false spawn. */
  which?: (agent: string) => Promise<ProbeResult>;
  /** File facts for the which candidate; defaults to fs.stat. */
  stat?: (candidate: string) => Promise<Stats>;
}

// ---------------------------------------------------------------------------
// Windows structured resolver (§3.1)
// ---------------------------------------------------------------------------

function whereLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("\u0000"));
}

function isRegularFile(entry: Stats): boolean {
  return entry.isFile();
}

/**
 * Resolve one route agent against where.exe output, in where order.
 *
 * A native executable or direct Node entry is a trustworthy result and stops
 * the walk.  Broken candidates (including non-PE extensionless POSIX
 * shims) are skipped so a later where.exe result can still be classified.
 * Unsupported shell/file-association shims remain a fail-closed refusal when
 * reached; they are never executed or silently translated into another
 * command.
 */
export async function resolveWindowsExecutableTarget(
  routeAgent: string,
  deps: WindowsTargetDeps = {},
): Promise<ResolvedAgentTarget> {
  const where = deps.where ?? ((agent: string) => probeExecutable("where.exe", [agent]));
  const stat = deps.stat ?? ((candidate: string) => fsStatPromises(candidate));
  const readHeader = deps.readHeader ?? readHeaderDefault;
  const nodeExecutable = deps.nodeExecutable ?? process.execPath;

  const probe = await where(routeAgent);
  if (probe.error !== undefined) {
    throw new AgentTargetError(
      routeAgent,
      `cannot be resolved (where.exe failed: ${probe.error.message})`,
      WINDOWS_NATIVE_HINT,
    );
  }
  const candidates = whereLines(probe.stdout);
  if (probe.code !== 0 || candidates.length === 0) {
    throw new AgentTargetError(
      routeAgent,
      `not found via where.exe (exit ${probe.code ?? "?"})`,
      WINDOWS_NATIVE_HINT,
    );
  }

  const rejected: string[] = [];
  for (const raw of candidates) {
    let candidate: string;
    try {
      candidate = path.win32.resolve(raw);
    } catch {
      rejected.push(`'${raw}': has an unsafely normalizable target`);
      continue;
    }

    const extension = path.win32.extname(candidate).toLowerCase();
    if (WINDOWS_SHIM_EXTENSIONS.has(extension)) {
      throw new UnsupportedWindowsShimError(
        routeAgent,
        candidate,
        `TUT does not execute ${extension} shims; ${WINDOWS_NATIVE_HINT}`,
      );
    }

    let entry: Stats;
    try {
      entry = await stat(candidate);
    } catch (error) {
      rejected.push(
        `resolves to an unavailable target ('${candidate}': ${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (!isRegularFile(entry)) {
      rejected.push(`resolves to a non-file target ('${candidate}')`);
      continue;
    }

    if (NATIVE_EXTENSIONS.has(extension)) {
      return { kind: "native", executable: candidate, prefix_args: [], source_path: candidate };
    }

    if (NODE_ENTRY_EXTENSIONS.has(extension)) {
      // A direct Node entry: Node runs the script itself; no file association,
      // no shebang reliance, no shell.
      return {
        kind: "node-entry",
        executable: nodeExecutable,
        prefix_args: [candidate],
        source_path: candidate,
      };
    }

    if (extension.length === 0) {
      // Extensionless targets are accepted only with a PE (MZ) header.  A
      // non-PE extensionless result is the common POSIX-shim shape on
      // Windows: skip it and let the next where.exe candidate decide.  The
      // default header adapter reads the real leading bytes; a read failure
      // is likewise an untrusted candidate rather than a reason to abandon
      // later candidates.
      let header: Buffer;
      try {
        header = await readHeader(candidate, 2);
      } catch (error) {
        rejected.push(
          `header read failed for '${candidate}' (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) {
        return { kind: "native", executable: candidate, prefix_args: [], source_path: candidate };
      }
      rejected.push(`resolves to an extensionless non-executable target ('${candidate}': no PE header)`);
      continue;
    }

    // Any other extension (.py, .pl, …) reaches Windows only through shell
    // file associations — same refusal class as npm command shims.
    throw new UnsupportedWindowsShimError(
      routeAgent,
      candidate,
      `files of type '${extension}' need a shell/file association to run; ${WINDOWS_NATIVE_HINT}`,
    );
  }

  throw new AgentTargetError(
    routeAgent,
    `all where.exe candidates are untrusted: ${rejected.join("; ")}`,
    WINDOWS_NATIVE_HINT,
  );
}

// ---------------------------------------------------------------------------
// POSIX which presence preflight (§3.2)
// ---------------------------------------------------------------------------

/**
 * Prove the bare route agent exists on PATH.  The which output path is used
 * only for this validation — it never replaces the bare executable in an
 * invocation or PaneCommand.
 */
export async function resolvePosixTargetPresence(
  routeAgent: string,
  deps: PosixTargetDeps = {},
): Promise<{ agent: string; candidate: string }> {
  const which = deps.which ?? ((agent: string) => probeExecutable("which", [agent]));
  const stat = deps.stat ?? ((candidate: string) => fsStatPromises(candidate));

  const probe = await which(routeAgent);
  if (probe.error !== undefined) {
    throw new AgentTargetError(
      routeAgent,
      `cannot be probed (which failed: ${probe.error.message})`,
      POSIX_PRESENCE_HINT,
    );
  }
  const candidate = probe.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0);
  if (probe.code !== 0 || candidate === undefined) {
    throw new AgentTargetError(
      routeAgent,
      `not on PATH (which exit ${probe.code ?? "?"}, no candidate)`,
      POSIX_PRESENCE_HINT,
    );
  }

  let entry: Stats;
  try {
    entry = await stat(candidate);
  } catch (error) {
    throw new AgentTargetError(
      routeAgent,
      `has an unusable which candidate ('${candidate}': ${(error as Error).message})`,
      POSIX_PRESENCE_HINT,
    );
  }
  if (!entry.isFile()) {
    throw new AgentTargetError(
      routeAgent,
      `has a which candidate that is not a regular file ('${candidate}')`,
      POSIX_PRESENCE_HINT,
    );
  }
  if ((entry.mode & 0o111) === 0) {
    throw new AgentTargetError(
      routeAgent,
      `has a which candidate that is not executable ('${candidate}')`,
      POSIX_PRESENCE_HINT,
    );
  }
  return { agent: routeAgent, candidate };
}

// ---------------------------------------------------------------------------
// Self-update suppression policy + platform plan builders (§5)
// ---------------------------------------------------------------------------

/** Normalize any AgentRoute form into the ordered { agent, args } command. */
export function normalizeRouteCommand(route: AgentRoute): AgentCommand {
  if (typeof route === "string") return { agent: route, args: [] };
  return { agent: route.agent, args: [...route.args] };
}

export interface SelfUpdatePolicy {
  args: string[];
  env: Record<string, string>;
}

/**
 * Freeze the agent self-update suppression policy once, keyed by the bare
 * route agent's logical name — never by a wrapped command or resolved path.
 */
export function selfUpdatePolicyFor(
  routeAgent: string,
  routeArgs: readonly string[],
  environment: NodeJS.ProcessEnv,
): SelfUpdatePolicy {
  const suppress = environment.TUT_SUPPRESS_AGENT_UPDATE !== "0";
  if (!suppress) return { args: [...routeArgs], env: {} };
  if (routeAgent === "codex") {
    return { args: [...routeArgs, "-c", "check_for_update_on_startup=false"], env: {} };
  }
  if (routeAgent === "pi") {
    return { args: [...routeArgs], env: { PI_SKIP_VERSION_CHECK: "1" } };
  }
  return { args: [...routeArgs], env: {} };
}

/** Pure POSIX plan: the bare route agent plus the frozen policy. */
export function posixDirectPlanFor(
  route: AgentCommand,
  environment: NodeJS.ProcessEnv,
): PosixDirectPlan {
  const policy = selfUpdatePolicyFor(route.agent, route.args, environment);
  return { executable: route.agent, args: policy.args, env: policy.env };
}

/** Windows effective plan: resolved target prefix plus the frozen policy. */
function windowsEffectivePlanFor(
  target: ResolvedAgentTarget,
  route: AgentCommand,
  environment: NodeJS.ProcessEnv,
): EffectiveAgentPlan {
  const policy = selfUpdatePolicyFor(route.agent, route.args, environment);
  return {
    executable: target.executable,
    args: [...target.prefix_args, ...policy.args],
    env: policy.env,
  };
}

export interface PlatformPlanOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  windowsDeps?: WindowsTargetDeps;
}

/**
 * Build the platform plan without a POSIX presence preflight.
 *
 * POSIX stays pure (the bare-name plan carries nothing from which); Windows
 * resolves its structured target, which may throw before any mutation.
 */
export async function planForPlatform(
  route: AgentCommand,
  options: PlatformPlanOptions = {},
): Promise<PlatformExecutionPlan> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const target = await resolveWindowsExecutableTarget(route.agent, options.windowsDeps);
    return {
      platform: "windows",
      resolved_target: target,
      effective_agent: windowsEffectivePlanFor(target, route, environment),
    };
  }
  return { platform: "posix", posix_direct: posixDirectPlanFor(route, environment) };
}

export interface ResolvePlatformExecutionPlanOptions extends PlatformPlanOptions {
  posixDeps?: PosixTargetDeps;
}

/**
 * The door-facing resolution used by canonical planners (start-next and
 * Notifier auto) before the marker: prove the target first, then produce the
 * frozen plan.  Any target failure throws before marker or Herdr mutation.
 */
export async function resolvePlatformExecutionPlan(
  route: AgentCommand,
  options: ResolvePlatformExecutionPlanOptions = {},
): Promise<PlatformExecutionPlan> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    await resolvePosixTargetPresence(route.agent, options.posixDeps);
  }
  return await planForPlatform(route, options);
}

/** Spread helper: map one platform plan onto buildLaunchInvocation options. */
export function platformPlanFields(
  plan: PlatformExecutionPlan,
): Pick<LaunchInvocation, "posix_direct"> | Pick<LaunchInvocation, "resolved_target" | "effective_agent"> {
  return plan.platform === "posix"
    ? { posix_direct: plan.posix_direct }
    : { resolved_target: plan.resolved_target, effective_agent: plan.effective_agent };
}

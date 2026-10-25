/** Stable public facade for platform target resolution and frozen plans. */
export {
  AgentTargetError,
  UnsupportedWindowsShimError,
} from "./target/types.js";

export type {
  ResolvedAgentTarget,
  EffectiveAgentPlan,
  PlatformExecutionPlan,
  ProbeResult,
  WindowsTargetDeps,
  FactProbeExit,
  FactProbeChild,
  PosixTargetDeps,
  SelfUpdatePolicy,
  PlatformPlanOptions,
  ResolvePlatformExecutionPlanOptions,
} from "./target/types.js";

export {
  probeWalkTimeoutMs,
  probeExecutable,
} from "./target/probe.js";

export {
  enumeratePathCandidates,
  resolveWindowsExecutableTarget,
} from "./target/windows.js";

export {
  resolvePosixTargetPresence,
} from "./target/posix.js";

export {
  normalizeRouteCommand,
  selfUpdatePolicyFor,
  posixDirectPlanFor,
  planForPlatform,
  resolvePlatformExecutionPlan,
  platformPlanFields,
} from "./target/plan.js";

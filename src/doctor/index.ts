/**
 * tut doctor — environment & assembly self-check. REPORT-ONLY: checks never
 * modify anything; every problem comes with actionable guidance (usually a
 * command the human can run). Exit 0 = no failing check, 1 = at least one
 * failing check; warnings do not flip the exit code (they are advisory).
 *
 * Eight checks:
 *  1 hub           — GET /state (200 + shape) + flow_mode / auto whitelist echo
 *  2 notifier      — read-only discovery with Hub/notifier ownership pairing,
 *                    duplicate endpoints and explicit event-route diagnosis
 *  3 config        — config.json + workspace.json L1/L2 validity, three-level
 *                    chain resolution display (UNKNOWN_ROLE_AGENT fallback made
 *                    visible here — the chain's silent fall-through is by
 *                    design, its VISIBILITY is this check's job)
 *  4 agents        — resolveAgentRoute results + platform existence
 *                    classification (which/PATH+PATHEXT via the launcher's
 *                    own resolver; shim refusal guidance included)
 *  5 storage       — task-directory scan: corrupt meta (class A) / corrupt
 *                    records (class B, recovery-registry aware) / version
 *                    gaps; delivery.log size; the hub's degraded list is
 *                    cross-checked when reachable. Whole-directory
 *                    disappearance (class C) is by construction invisible to
 *                    any indexless scanner — the Notifier's snapshot diff is
 *                    that detection path (system-design 4.3); doctor says so
 *                    instead of pretending.
 *  6 paths         — project/hub path safety (spaces/metacharacters/non-ASCII)
 *  7 platform      — OS / shell dialect / Node version / Windows code-page
 *                    hint (human-side visibility) + env knobs in effect
 *  8 agent-channel — per-seat network verdicts for the agent→hub channel
 *                    machine-readable: feasible |
 *                    infeasible | unknown with stable reasons —
 *                    sandbox-allows-network (feasible: the seat's own
 *                    argv grants network — codex --sandbox
 *                    danger-full-access), sandbox-network-denied
 *                    (codex read-only/workspace-write), hub-unreachable,
 *                    agent-cli-missing, sandbox-posture-unverified (codex
 *                    without an explicit flag), agent-posture-unverified
 *                    (non-codex: host loopback is not seat evidence). The
 *                    loopback UDS hub channel carries its own machine-
 *                    readable verdict (infeasible/not-shipped) — it is the
 *                    registered investigation direction, not a shipped
 *                    surface, and doctor states that honestly instead of
 *                    probing it.
 *
 * Storage reads here are DIAGNOSTIC reads of the same files the Store owns
 * (the design routes "which file, which class" diagnosis to tut doctor,
 * system-design 4.3/6.1); doctor never writes and never bypasses Store for
 * operational read/write — the authoritative classification of a task
 * remains the running hub's (see the storage cross-check). Artifact
 * classification reuses the Store's own validators (shared exports):
 * what doctor calls damage is exactly what /state degrades.
 *
 * Robustness contract: a report-only diagnostic must never
 * crash on the bad inputs it exists to diagnose — invalid URLs, malformed
 * workspace entries and non-schema /state bodies become that check's failure
 * item, and an unexpected throw inside any check is converted the same way
 * by the runner's guard. runDoctor never rejects; the report always renders.
 */

import path from "node:path";
import { canonicalRoot, resolveRigRoot } from "../hub/rig-discovery.js";
import { resolvePlatformExecutionPlan } from "../launcher/target-resolver.js";
import { KNOWN_ROLES } from "../common/workspace.js";
import type { DoctorCheck, DoctorContext, DoctorOptions, DoctorReport, DoctorStatus } from "./types.js";
import { checkHub, type HubOutcome } from "./checks/hub.js";
import { checkNotifier } from "./checks/notifier.js";
import { checkConfig, declaredWorkspaceRoles } from "./checks/config.js";
import { checkAgents, type AgentProbe } from "./checks/agents.js";
import { checkStorage } from "./checks/storage.js";
import { checkPaths } from "./checks/paths.js";
import { checkPlatform } from "./checks/platform.js";
import { checkAgentChannel } from "./checks/agent-channel.js";

export { DOCTOR_HUB_TIMEOUT_MS, DOCTOR_EVENT_TIMEOUT_MS } from "./constants.js";
export type { DoctorStatus, AgentChannelCode, AgentChannelReason, AgentChannelSeatVerdict, AgentChannelUdsVerdict, DoctorCheck, DoctorReport, DoctorOptions } from "./types.js";

// --- runner -----------------------------------------------------------------------

/** A report-only diagnostic must never crash on the bad
 *  inputs it exists to diagnose. Boundary validation turns known bad shapes
 *  into precise failure items; this guard is the backstop — an unexpected
 *  throw inside any check becomes that check's failure with the raw error as
 *  evidence, so runDoctor never rejects and the report always renders. */
function crashedCheck(name: string, title: string, e: unknown): DoctorCheck {
  const message = e instanceof Error ? e.message : String(e);
  return {
    name,
    title,
    status: "fail",
    summary: `internal error — this check crashed instead of reporting (${message})`,
    details: [`doctor bug evidence: ${e instanceof Error ? e.stack ?? e.message : String(e)}`],
    fix: "this is a doctor bug, not your environment — report it with the details above (the run stays report-only)",
  };
}

async function guard(name: string, title: string, run: () => DoctorCheck | Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await run();
  } catch (e) {
    return crashedCheck(name, title, e);
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.environment ?? process.env;
  const root = path.resolve(options.root ?? ".context-hub");
  const projectRoot = path.dirname(root);
  let hubRoot: string = "unknown";
  let hubRootError: unknown;
  try { hubRoot = canonicalRoot(options.hubRoot ?? resolveRigRoot(process.cwd(), env)); }
  catch (error) { hubRootError = error; }
  const ctx: DoctorContext = {
    root,
    hubRoot,
    projectRoot,
    l1WorkspaceFile: path.join(projectRoot, ".context-hub", "workspace.json"),
    url: options.url ?? "http://127.0.0.1:3001",
    env,
    platform: options.platform ?? process.platform,
    nodeVersion: options.nodeVersion ?? process.version,
    fetchImpl: options.fetchImpl ?? fetch,
    resolveTarget: options.resolveTarget ?? ((command) => resolvePlatformExecutionPlan(command, { environment: env })),
  };

  let declaredRoles: Set<string>;
  try {
    declaredRoles = await declaredWorkspaceRoles(ctx);
  } catch {
    declaredRoles = new Set(KNOWN_ROLES); // the guarded config check reports the cause
  }
  let hub: HubOutcome;
  try {
    if (hubRootError !== undefined) throw hubRootError;
    hub = await checkHub(ctx);
  } catch (e) {
    hub = { check: crashedCheck("hub", "hub reachable", e), degraded: [] };
  }
  let agents: { check: DoctorCheck; probes: Map<string, AgentProbe> };
  try {
    agents = await checkAgents(ctx, declaredRoles);
  } catch (e) {
    agents = { check: crashedCheck("agents", "agent executables", e), probes: new Map() };
  }
  const checks: DoctorCheck[] = [
    hub.check,
    await guard("notifier", "notifier event port", () => checkNotifier(ctx, hub)),
    await guard("config", "config & workspace chain", () => checkConfig(ctx)),
    agents.check,
    await guard("storage", "storage health", () => checkStorage(ctx, hub)),
    await guard("paths", "path safety", () => checkPaths(ctx)),
    await guard("platform", "platform info", () => checkPlatform(ctx)),
    await guard("agent-channel", "agent channel network", () =>
      checkAgentChannel(ctx, declaredRoles, hub.check.status !== "fail", agents.probes),
    ),
  ];
  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

const STATUS_LABEL: Record<DoctorStatus, string> = { ok: "ok", warn: "WARN", fail: "FAIL" };

/** Human rendering (the `--json` surface is the DoctorReport itself). */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["tut doctor — report-only environment & assembly self-check", ""];
  let index = 0;
  for (const check of report.checks) {
    index += 1;
    lines.push(`${index}. ${check.title} [${STATUS_LABEL[check.status]}]`);
    lines.push(`   ${check.summary}`);
    for (const detail of check.details) lines.push(`   · ${detail}`);
    if (check.fix !== undefined) lines.push(`   fix: ${check.fix}`);
  }
  const failing = report.checks.filter((c) => c.status === "fail").length;
  const warnings = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    report.ok
      ? `result: ok — ${warnings} warning(s), 0 failing`
      : `result: FAIL — ${failing} failing check(s), ${warnings} warning(s)`,
  );
  return lines.join("\n");
}

/**
 * tut doctor — environment & assembly self-check. REPORT-ONLY: checks never
 * modify anything; every problem comes with actionable guidance (usually a
 * command the human can run). Exit 0 = no failing check, 1 = at least one
 * failing check; warnings do not flip the exit code (they are advisory).
 *
 * Eight checks:
 *  1 hub           — GET /state (200 + shape) + flow_mode / auto whitelist echo
 *  2 notifier      — event-port probe + single-instance (port ownership) and
 *                    hub/event-port collision (the same collision the launcher's precheck catches)
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
 *                    + delivery probe endpoint length (reusing the launcher's
 *                    own guard)
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

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { autoSectionOf, configPath, readConfigFile } from "./config.js";
import { AgentCommandError, parseAgentRoute, validateAgentRoute } from "./agent-command.js";
import { eventPortUrlOf } from "./launcher/escalation.js";
import { deliveryProbeEndpoint, ENDPOINT_PATH_MAX } from "./launcher/probe-channel.js";
import { resolvePaneShellDialect, PaneShellError } from "./launcher/shell-renderer.js";
import {
  AgentTargetError,
  normalizeRouteCommand,
  resolvePlatformExecutionPlan,
  type PlatformExecutionPlan,
} from "./launcher/target-resolver.js";
import {
  DEFAULT_ROLES,
  KNOWN_ROLES,
  UNKNOWN_ROLE_AGENT,
  defaultUserConfigDir,
  resolveAgentRouteWithSource,
} from "./workspace.js";
import {
  LEGACY_TASK_ID_PATTERN,
  recordFileVersion,
  StoreError,
  validateMetaArtifact,
  validateRecordArtifact,
} from "./store.js";
import type { AgentCommand, AgentRoute } from "./types.js";

export const DOCTOR_HUB_TIMEOUT_MS = 10_000;
export const DOCTOR_EVENT_TIMEOUT_MS = 5_000;

/** The delivery.log rotation cap (rotates at 5 MiB, keeping one .1) — an
 *  over-limit live log means rotation is failing (rename degradation). */
const DELIVERY_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Digests are 12 hex chars, so every probe endpoint filename is this long. */
const PROBE_BASENAME = "tut-probe-0123456789ab.sock";

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

function worst(statuses: DoctorStatus[]): DoctorStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

function isErrnoException(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- check 1: hub --------------------------------------------------------------

interface HubStateView {
  flow_mode?: string;
  tasks?: Array<{ task_id: string; needs_attention?: boolean }>;
  degraded?: string[];
  auto?: { launch_roles: string[] };
}

interface HubOutcome {
  check: DoctorCheck;
  /** The hub's degraded list when it answered (empty otherwise). */
  degraded: string[];
}

/** /state's own value domains (http.ts handleState): flow_mode selects the
 *  mode table; task entries carry typed fields. Doctor validates what the
 *  endpoint emits — an impersonating or drifted service fails loudly. */
const STATE_FLOW_MODES = new Set(["manual", "auto"]);
const STATE_TASK_FLOWS = new Set(["full", "direct", "solo"]);
const STATE_TASK_STRING_FIELDS = ["title", "status", "updated_at", "waiting_for"] as const;

/** Shape gate for a /state body: malformed
 *  documents — null task entries, non-array auto.launch_roles, wrong-typed
 *  task fields, out-of-domain flow values — are failure items with the
 *  offending field named, never a crash in the consumer. Returns null when
 *  the body is usable. */
function stateBodyProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "body is not an object";
  const body = value as Record<string, unknown>;
  if (typeof body.flow_mode !== "string" || !STATE_FLOW_MODES.has(body.flow_mode)) {
    return `flow_mode must be manual|auto, got: ${typeof body.flow_mode === "string" ? `'${body.flow_mode}'` : typeof body.flow_mode}`;
  }
  if (!Array.isArray(body.tasks)) return "tasks is not an array";
  for (const [i, entry] of body.tasks.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return `tasks[${i}] is not a task object`;
    const task = entry as Record<string, unknown>;
    if (typeof task.task_id !== "string" || task.task_id.length === 0) return `tasks[${i}].task_id missing or empty`;
    for (const field of STATE_TASK_STRING_FIELDS) {
      if (task[field] !== undefined && typeof task[field] !== "string") return `tasks[${i}].${field} must be a string`;
    }
    if (task.needs_attention !== undefined && typeof task.needs_attention !== "boolean") {
      return `tasks[${i}].needs_attention must be a boolean`;
    }
    if (task.version !== undefined &&
        (typeof task.version !== "number" || !Number.isInteger(task.version) || task.version < 0)) {
      return `tasks[${i}].version must be an integer ≥ 0`;
    }
    if (task.flow !== undefined && (typeof task.flow !== "string" || !STATE_TASK_FLOWS.has(task.flow))) {
      return `tasks[${i}].flow must be one of full|direct|solo`;
    }
    for (const field of ["cast", "checkout"] as const) {
      if (task[field] !== undefined &&
          (typeof task[field] !== "object" || task[field] === null || Array.isArray(task[field]))) {
        return `tasks[${i}].${field} must be an object`;
      }
    }
  }
  if (body.degraded !== undefined &&
      (!Array.isArray(body.degraded) || body.degraded.some((d) => typeof d !== "string"))) {
    return "degraded is not a string array";
  }
  if (body.auto !== undefined) {
    const auto = body.auto;
    if (typeof auto !== "object" || auto === null || Array.isArray(auto) ||
        !Array.isArray((auto as Record<string, unknown>).launch_roles) ||
        ((auto as Record<string, unknown>).launch_roles as unknown[]).some((r) => typeof r !== "string")) {
      return "auto.launch_roles is not a string array";
    }
  }
  return null;
}

async function checkHub(ctx: DoctorContext): Promise<HubOutcome> {
  const check: DoctorCheck = {
    name: "hub",
    title: "hub reachable",
    status: "ok",
    summary: "",
    details: [],
  };
  let hubUrl: URL;
  try {
    hubUrl = new URL(ctx.url);
  } catch (e) {
    check.status = "fail";
    check.summary = `invalid hub URL '${ctx.url}' (${(e as Error).message})`;
    check.details.push("a hub URL must be absolute, like http://127.0.0.1:3001");
    check.fix = "pass a valid --url (e.g. --url http://127.0.0.1:3001)";
    return { check, degraded: [] };
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hubUrl.hostname);
  if (!loopback) {
    check.status = "warn";
    check.details.push(
      `hub URL host '${hubUrl.hostname}' is not loopback — the hub's DNS-rebinding guard 403s non-loopback Host headers and sandboxed agents lose any loopback exemption`,
    );
  }
  let parsed: unknown = null;
  try {
    const res = await ctx.fetchImpl(new URL("/state", hubUrl), {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(DOCTOR_HUB_TIMEOUT_MS),
    });
    if (!res.ok) {
      check.status = "fail";
      check.summary = `hub answered HTTP ${res.status} on ${ctx.url}/state — not a healthy Context Hub`;
      check.fix = "tut serve   (or: tut up)";
      return { check, degraded: [] };
    }
    parsed = await res.json().catch(() => null);
  } catch (e) {
    check.status = "fail";
    check.summary = `cannot reach hub at ${ctx.url}/state (${(e as Error).message})`;
    check.fix = "tut serve   (or: tut up)";
    return { check, degraded: [] };
  }
  const problem = stateBodyProblem(parsed);
  if (problem !== null) {
    check.status = "fail";
    check.summary = `${ctx.url}/state answered 200 but the body is not a TUT /state document (${problem})`;
    check.fix = "tut serve   (restart on this port — another service may be impersonating the hub)";
    return { check, degraded: [] };
  }
  const body = parsed as HubStateView;
  const tasks = body.tasks ?? [];
  const attention = tasks.filter((t) => t.needs_attention === true).length;
  const degraded = body.degraded ?? [];
  check.summary =
    `reachable at ${ctx.url}/state — flow_mode=${body.flow_mode}, ${tasks.length} task(s)` +
    (attention > 0 ? `, ${attention} needs_attention` : "");
  check.details.push(
    `flow_mode=${body.flow_mode}` +
      (body.auto !== undefined
        ? `, auto.launch_roles=[${body.auto.launch_roles.join(",")}]`
        : ", auto whitelist unset (auto mode withholds all launches)"),
  );
  if (degraded.length > 0) {
    check.status = worst([check.status, "warn"]);
    check.details.push(`hub reports degraded (storage-damaged) tasks: ${degraded.join(", ")}`);
    check.details.push("class/file-level diagnosis: see the storage check below");
  }
  return { check, degraded };
}

// --- check 2: notifier ---------------------------------------------------------

type EventProbeOutcome = "notifier" | "refused" | "occupied";

/** Probe the agent-event port. Refused = nothing listens; occupied = something
 *  answers that is NOT the notifier (the notifier's documented non-POST answer
 *  is 405 with an Allow header naming POST). */
async function probeEventPort(
  ctx: DoctorContext,
  eventUrl: URL,
): Promise<{ outcome: EventProbeOutcome; detail: string }> {
  try {
    const res = await ctx.fetchImpl(eventUrl, {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(DOCTOR_EVENT_TIMEOUT_MS),
    });
    const allow = (res.headers.get("allow") ?? "").toUpperCase();
    if (res.status === 405 && allow.split(/[\s,]+/u).includes("POST")) {
      return { outcome: "notifier", detail: "answers 405 + Allow: POST (the Notifier's signature)" };
    }
    return { outcome: "occupied", detail: `answers HTTP ${res.status} — not the Notifier's 405 + Allow: POST signature` };
  } catch (e) {
    return { outcome: "refused", detail: (e as Error).message };
  }
}

async function checkNotifier(ctx: DoctorContext): Promise<DoctorCheck> {
  const check: DoctorCheck = {
    name: "notifier",
    title: "notifier event port",
    status: "ok",
    summary: "",
    details: [],
  };
  let eventUrl: URL;
  try {
    eventUrl = new URL(eventPortUrlOf(ctx.env));
  } catch (e) {
    check.status = "fail";
    check.summary = `invalid event-port URL from TUT_EVENT_PORT_URL ('${String(ctx.env.TUT_EVENT_PORT_URL)}'): ${(e as Error).message}`;
    check.details.push("the event-port URL must be absolute, like http://127.0.0.1:3002/agent-event");
    check.fix = "set TUT_EVENT_PORT_URL to a valid absolute URL or unset it";
    return check;
  }
  let hubUrl: URL | null = null;
  try {
    hubUrl = new URL(ctx.url);
  } catch {
    // the hub check reports the invalid hub URL; collision math is skipped
  }
  const eventOverridden = (ctx.env.TUT_EVENT_PORT_URL ?? "").length > 0;
  check.details.push(
    `event port: ${eventUrl.toString()} (TUT_EVENT_PORT_URL ${eventOverridden ? "override" : "unset or empty — default"})`,
  );
  // Static collision first (visible even with everything down):
  // the hub and the notifier's event listener cannot share one port.
  if (hubUrl !== null && eventUrl.port === hubUrl.port && eventUrl.hostname === hubUrl.hostname) {
    check.status = "fail";
    check.summary = `hub and notifier event port are the SAME (${hubUrl.port}) — tut notify would die with EADDRINUSE`;
    check.fix =
      "run the hub on another port (tut serve --port 3001 / tut up --url http://127.0.0.1:3001) or re-point TUT_EVENT_PORT_URL";
    return check;
  }
  const probe = await probeEventPort(ctx, eventUrl);
  if (probe.outcome === "notifier") {
    check.summary = `notifier listening on ${eventUrl.toString()} — single-instance holds (only one process can own the port)`;
    check.details.push(probe.detail);
    return check;
  }
  if (probe.outcome === "refused") {
    check.status = "warn";
    check.summary = `no notifier detected at ${eventUrl.toString()} — notifications and auto-flow are off until it runs`;
    check.details.push(probe.detail);
    check.fix = "tut notify   (or: tut up)";
    return check;
  }
  check.status = "fail";
  check.summary = `port ${eventUrl.port || "(default)"} is occupied by a non-notifier service — tut notify would die with EADDRINUSE`;
  check.details.push(probe.detail);
  if (hubUrl !== null && eventUrl.port === hubUrl.port) {
    check.details.push("the occupying service is on the hub's port — it may be the hub itself (the `up --url :3002` accident shape)");
  }
  check.fix = "free the port, or re-point the event port: TUT_EVENT_PORT_URL=http://127.0.0.1:<other-port>/agent-event tut notify";
  return check;
}

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

// --- check 5: storage -----------------------------------------------------------

interface TaskFinding {
  text: string;
  level: DoctorStatus;
  /** Repair entry this finding points at (A = repair-meta, B = recover-record). */
  fixCommand?: string;
}

interface TaskScan {
  status: DoctorStatus;
  findings: TaskFinding[];
}

/** Authoritative artifact classification: the SAME
 *  validators the Store's read path uses, shared via export — doctor must
 *  never call healthy what /state degrades. Returns null when valid, else
 *  the StoreError message (evidence for the finding). */
function recordArtifactProblem(value: unknown, fileName: string, taskId: string): string | null {
  try {
    validateRecordArtifact(value, fileName, taskId);
    return null;
  } catch (e) {
    if (e instanceof StoreError) return e.message;
    throw e;
  }
}

function metaArtifactProblem(value: unknown, fileName: string, taskId: string): string | null {
  try {
    validateMetaArtifact(value, fileName, taskId);
    return null;
  } catch (e) {
    if (e instanceof StoreError) return e.message;
    throw e;
  }
}

interface RecoveryLine {
  file: string;
  corrupt_sha256: string;
  recovered_sha256: string;
  recovered_file: string;
  source?: string;
}

/** recovery.jsonl lines as the Store's readRecoveryEntries sees them:
 *  BOTH syntax errors and schema-invalid lines (valid JSON, wrong field
 *  shapes — e.g. {"file":42}) are skipped by the Store; doctor counts them
 *  ALL as unparseable so a rotting manifest is never silently ignored. */
function parseRecoveryManifest(raw: string): { entries: RecoveryLine[]; unparseable: number } {
  const entries: RecoveryLine[] = [];
  let unparseable = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof parsed.file === "string" &&
        typeof parsed.corrupt_sha256 === "string" &&
        typeof parsed.recovered_sha256 === "string" &&
        typeof parsed.recovered_file === "string"
      ) {
        entries.push(parsed as unknown as RecoveryLine);
      } else {
        unparseable += 1; // schema-invalid line — skipped by the Store too
      }
    } catch {
      unparseable += 1;
    }
  }
  return { entries, unparseable };
}

/** recovery.jsonl as the Store's readRecoveryEntries sees it: an absent
 *  file is fine; a file that exists but cannot be READ is
 *  a diagnosable error (the Store turns it into VALIDATION_ERROR → degraded,
 *  so doctor must surface it, not swallow it as "no manifest");
 *  unparseable lines are SKIPPED, not fatal — the last VALID registration
 *  still stands. */
type ManifestRead =
  | { status: "absent" }
  | { status: "unreadable"; error: string }
  | { status: "ok"; entries: RecoveryLine[]; unparseable: number };

async function readRecoveryManifest(taskDir: string): Promise<ManifestRead> {
  let raw: string;
  try {
    raw = await readFile(path.join(taskDir, "recovery.jsonl"), "utf8");
  } catch (e) {
    if (isErrnoException(e, "ENOENT")) return { status: "absent" };
    return { status: "unreadable", error: (e as Error).message };
  }
  const { entries, unparseable } = parseRecoveryManifest(raw);
  return { status: "ok", entries, unparseable };
}

/** Mirror of the store's recovery consumption rule (system-design 4.3 B):
 *  the LAST valid registration for the file stands in iff the digest chain
 *  holds AND the copy passes the Store's own artifact validation for this
 *  task (same rule as recoveredRecordFor: a recovered
 *  stand-in is exactly as well-formed as a normally landed record). Doctor's
 *  copy is diagnostic — the hub remains the classification authority. */
async function recoveryVerdict(
  taskDir: string,
  taskId: string,
  fileName: string,
  corruptBytes: Buffer,
  manifest: ManifestRead,
): Promise<{ recovered: boolean; note: string; source?: string; manifestWarning?: string }> {
  const skipNote = (base: string): string =>
    manifest.status === "ok" && manifest.unparseable > 0
      ? `${base}; ${manifest.unparseable} unparseable manifest line(s) skipped`
      : base;
  if (manifest.status === "absent") return { recovered: false, note: "no recovery.jsonl" };
  if (manifest.status === "unreadable") {
    return {
      recovered: false,
      note: `recovery.jsonl unreadable (${manifest.error}) — the Store treats this as VALIDATION_ERROR (task stays degraded)`,
    };
  }
  const last = [...manifest.entries].reverse().find((e) => e.file === fileName);
  if (last === undefined) return { recovered: false, note: skipNote("no registration for this file") };
  if (sha256(corruptBytes) !== last.corrupt_sha256) {
    return { recovered: false, note: skipNote("registration void: corrupt original was modified after registration") };
  }
  let copyBytes: Buffer;
  try {
    copyBytes = await readFile(path.join(taskDir, last.recovered_file));
  } catch {
    return { recovered: false, note: skipNote("registered .recovered copy is missing") };
  }
  if (sha256(copyBytes) !== last.recovered_sha256) {
    return { recovered: false, note: skipNote("registered .recovered copy digest mismatch") };
  }
  try {
    const parsed: unknown = JSON.parse(copyBytes.toString("utf8"));
    const problem = recordArtifactProblem(parsed, last.recovered_file, taskId);
    if (problem !== null) return { recovered: false, note: skipNote(`recovered copy malformed: ${problem}`) };
    if ((parsed as { version?: unknown }).version !== recordFileVersion(fileName)) {
      return { recovered: false, note: skipNote("recovered copy version does not match the file name") };
    }
  } catch (e) {
    return { recovered: false, note: skipNote(`recovered copy unparseable: ${(e as Error).message}`) };
  }
  return {
    recovered: true,
    note: "recovered (digest chain verifies)",
    ...(last.source !== undefined ? { source: last.source } : {}),
    ...(manifest.unparseable > 0
      ? {
          manifestWarning:
            `${manifest.unparseable} unparseable manifest line(s) skipped — the Store consumes the last valid registration (readRecoveryEntries semantics)`,
        }
      : {}),
  };
}

async function scanTaskDir(taskDir: string, taskId: string): Promise<TaskScan> {
  const findings: TaskFinding[] = [];
  const statuses: DoctorStatus[] = [];

  // meta.json — class A damage surface. The Store's own meta validator
  // decides (task identity, required fields, flow/cast/checkout domains):
  // what doctor calls class A is exactly what /state degrades.
  let metaVersion: number | undefined;
  try {
    const raw = await readFile(path.join(taskDir, "meta.json"), "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      const problem = metaArtifactProblem(parsed, "meta.json", taskId);
      if (problem !== null) throw new Error(problem);
      metaVersion = (parsed as { version: number }).version;
    } catch (e) {
      statuses.push("fail");
      findings.push({
        text: `meta.json: malformed (${(e as Error).message}) — class A damage (records intact; task reports degraded)`,
        level: "fail",
        fixCommand: `tut repair-meta ${taskId} --title <title>   (version is rebuilt server-side from the record files)`,
      });
    }
  } catch (e) {
    statuses.push("fail");
    findings.push({
      text: `meta.json: ${isErrnoException(e, "ENOENT") ? "missing (create interrupted?)" : `unreadable (${(e as Error).message})`} — class A damage`,
      level: "fail",
      fixCommand: `tut repair-meta ${taskId} --title <title>   (version is rebuilt server-side from the record files)`,
    });
  }

  // record files — class B damage surface (recovery aware).
  let names: string[];
  try {
    names = await readdir(taskDir);
  } catch (e) {
    statuses.push("fail");
    findings.push({ text: `task dir unreadable: ${(e as Error).message}`, level: "fail" });
    return { status: worst(statuses), findings };
  }
  const recordNames = names
    .filter((n) => recordFileVersion(n) !== null)
    .sort((a, b) => recordFileVersion(a)! - recordFileVersion(b)!);
  // Version-domain scan mirrors derive's own classification (state-machine
  // prevVersion walk): leading gaps (records starting above
  // v1) and duplicate versions (multiple files claiming one version) are the
  // two shapes a plain adjacent-pair comparison misses.
  const byVersion = new Map<number, string[]>();
  for (const name of recordNames) {
    const v = recordFileVersion(name)!;
    byVersion.set(v, [...(byVersion.get(v) ?? []), name]);
  }
  // The walk is derive's own: prevVersion steps over the sorted FILES (one
  // file = one record), not over unique versions — grouping first would hide
  // duplicates by construction.
  let prevVersion = 0;
  for (const name of recordNames) {
    const v = recordFileVersion(name)!;
    if (v === prevVersion) {
      const namesForV = byVersion.get(v)!;
      statuses.push("warn");
      findings.push({
        text:
          `duplicate version (VERSION_DUPLICATE): v${v} present in ${namesForV.length} files (${namesForV.join(", ")}) — ` +
          "derive warns VERSION_DUPLICATE + needs_attention",
        level: "warn",
      });
    } else if (v !== prevVersion + 1) {
      statuses.push("warn");
      findings.push({
        text:
          `version gap (VERSION_GAP): v${prevVersion + 1}..v${v - 1} missing` +
          (prevVersion === 0
            ? ` — records start at v${v} (leading gap)`
            : ` between v${String(prevVersion).padStart(3, "0")} and ${name}`) +
          " — deleted records (append-only invariant) or interrupted writes; derive warns VERSION_GAP + needs_attention",
        level: "warn",
      });
    }
    prevVersion = v;
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  // recovery.jsonl once, with the Store's read semantics:
  // unreadable is a diagnosable failure, unparseable lines are skipped.
  const manifest = await readRecoveryManifest(taskDir);
  if (manifest.status === "unreadable") {
    statuses.push("fail");
    findings.push({
      text:
        `recovery.jsonl: unreadable (${manifest.error}) — the Store's readRecoveryEntries turns this into VALIDATION_ERROR (task stays degraded); registrations cannot be consumed`,
      level: "fail",
      fixCommand: `restore read access to tasks/${taskId}/recovery.jsonl (fix permissions / clear whatever squats on the name) — recoveries are dead until then`,
    });
  }
  // Bad manifest lines are visible even with NO damaged records: a rotting
  // manifest warns on its own — the Store's skip
  // semantics are unchanged, only their visibility is doctor's to add.
  if (manifest.status === "ok" && manifest.unparseable > 0) {
    statuses.push("warn");
    findings.push({
      text:
        `recovery.jsonl: ${manifest.unparseable} line(s) skipped (unparseable or wrong shape) — the Store consumes only well-formed registrations; the last valid one stands`,
      level: "warn",
    });
  }
  const registered = manifest.status === "ok" ? new Set(manifest.entries.map((e) => e.file)) : null;
  for (const name of recordNames) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(taskDir, name));
    } catch (e) {
      statuses.push("fail");
      findings.push({
        text: `${name}: unreadable (${(e as Error).message}) — class B damage`,
        level: "fail",
        fixCommand: `tut recover-record ${taskId} ${name} --from <external-snapshot-path> --source <origin>   (corrupt bytes stay pinned)`,
      });
      continue;
    }
    let problem: string | null;
    try {
      problem = recordArtifactProblem(JSON.parse(bytes.toString("utf8")), name, taskId);
    } catch (e) {
      problem = (e as Error).message;
    }
    if (problem === null) continue;
    const verdict = await recoveryVerdict(taskDir, taskId, name, bytes, manifest);
    if (verdict.recovered) {
      findings.push({
        text:
          `${name}: corrupt on disk but ${verdict.note}${verdict.source !== undefined ? ` (source: ${verdict.source})` : ""}` +
          (verdict.manifestWarning !== undefined ? ` — WARNING: ${verdict.manifestWarning}` : ""),
        level: verdict.manifestWarning !== undefined ? "warn" : "ok",
      });
      if (verdict.manifestWarning !== undefined) statuses.push("warn");
      continue;
    }
    statuses.push("fail");
    findings.push({
      text: `${name}: corrupt (${problem}) and unrecovered — ${verdict.note} — class B damage`,
      level: "fail",
      fixCommand: `tut recover-record ${taskId} ${name} --from <external-snapshot-path> --source <origin>   (corrupt bytes stay pinned)`,
    });
  }
  // Orphan recovered copies (registration lost) never fold — visible here.
  // With an unreadable manifest the registration set is unknowable: skip
  // rather than misreport every copy as orphan (the unreadable finding above
  // already fails the task).
  for (const name of names) {
    if (registered !== null && name.endsWith(".recovered") && !registered.has(name.slice(0, -".recovered".length))) {
      statuses.push("warn");
      findings.push({
        text: `${name}: recovered copy without a matching registration line — never consumed by the fold`,
        level: "warn",
      });
    }
  }
  // meta.version vs on-disk max — the crash window the store heals itself.
  if (metaVersion !== undefined && versions.length > 0) {
    const maxOnDisk = versions[versions.length - 1]!;
    if (metaVersion !== maxOnDisk) {
      findings.push({
        text: `meta.version=${metaVersion} vs on-disk max v${maxOnDisk} — crash-window skew; the next append reconciles from the disk max`,
        level: "ok",
      });
    }
  }
  return { status: worst(statuses), findings };
}

async function checkStorage(ctx: DoctorContext, hub: HubOutcome): Promise<DoctorCheck> {
  const check: DoctorCheck = {
    name: "storage",
    title: "storage health",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];
  const tasksDir = path.join(ctx.root, "tasks");
  let entries;
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch (e) {
    if (isErrnoException(e, "ENOENT")) {
      check.summary = `no storage yet (${ctx.root} absent) — run tut init / tut serve from the project root, or pass --root`;
      return check;
    }
    check.status = "fail";
    check.summary = `cannot read ${tasksDir}: ${(e as Error).message}`;
    return check;
  }
  const taskDirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  let scanned = 0;
  const damaged: string[] = [];
  for (const name of taskDirNames.sort()) {
    // Same task-id domain the store enforces; anything else is invisible to
    // the hub by construction — surfacing it is exactly doctor's job.
    if (!LEGACY_TASK_ID_PATTERN.test(name)) {
      statuses.push("warn");
      check.details.push(`tasks/${name}: foreign directory name — the hub ignores it entirely`);
      continue;
    }
    scanned += 1;
    const scan = await scanTaskDir(path.join(tasksDir, name), name);
    for (const finding of scan.findings) {
      check.details.push(`tasks/${name}: ${finding.text}`);
      if (finding.fixCommand !== undefined) check.details.push(`  fix: ${finding.fixCommand}`);
    }
    if (scan.status === "fail") {
      statuses.push("fail");
      damaged.push(name);
    } else if (scan.status === "warn") {
      statuses.push("warn");
    }
  }
  // Leftover temp files — crash residue the store sweeps opportunistically.
  const tmpCount = entries.filter((e) => e.isFile() && e.name.includes(".tmp")).length;
  if (tmpCount > 0) {
    check.details.push(`${tmpCount} leftover temp file(s) under tasks/ — crash residue; the hub sweeps aged temps on its next append`);
  }
  // delivery.log — rotates at 5 MiB (one .1 generation kept).
  for (const logName of ["delivery.log", "delivery.log.1"]) {
    try {
      const info = await stat(path.join(ctx.root, logName));
      if (logName === "delivery.log" && info.size > DELIVERY_LOG_MAX_BYTES) {
        statuses.push("warn");
        check.details.push(
          `${logName}: ${info.size} bytes exceeds the ${DELIVERY_LOG_MAX_BYTES}-byte rotation cap — rotation is failing (check write/rename errors)`,
        );
      } else {
        check.details.push(`${logName}: ${info.size} bytes`);
      }
    } catch {
      // absent — fine
    }
  }
  // Cross-check against the hub's own view when it answered.
  if (hub.check.status !== "fail") {
    const unseenByDoctor = hub.degraded.filter((id) => !damaged.includes(id));
    if (unseenByDoctor.length > 0) {
      statuses.push("warn");
      check.details.push(
        `hub reports degraded but this scan finds no damage: ${unseenByDoctor.join(", ")} — the hub is the classification authority; with shared validators this means a race (files changed between reads) or a hub-side read error (see the hub's stderr)`,
      );
    }
  }
  check.status = worst(statuses);
  check.summary =
    damaged.length > 0
      ? `${scanned} task dir(s) scanned — damaged: ${damaged.join(", ")} (class + fix in details)`
      : `${scanned} task dir(s) scanned — no storage-level damage`;
  check.details.push(
    "boundary: a whole deleted task directory is invisible to any indexless scanner — the Notifier's snapshot diff is that detection path (system-design 4.3 C)",
  );
  return check;
}

// --- check 6: paths --------------------------------------------------------------

function pathHazards(p: string, platform: NodeJS.Platform): string[] {
  const hazards: string[] = [];
  if (/\s/u.test(p)) hazards.push("contains spaces");
  if (/[^\x00-\x7f]/u.test(p)) hazards.push("contains non-ASCII characters");
  if (platform === "win32") {
    if (/[%!^&()<>'"]/u.test(p)) hazards.push("contains cmd/pwsh metacharacters");
  } else {
    if (/['"\\$`;&|<>]/u.test(p)) hazards.push("contains shell metacharacters");
  }
  return hazards;
}

function checkPaths(ctx: DoctorContext): DoctorCheck {
  const check: DoctorCheck = {
    name: "paths",
    title: "path safety & probe endpoints",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];
  let hazardFound = false;
  for (const [label, p] of [
    ["storage root", ctx.root],
    ["project root", ctx.projectRoot],
    ["home", homedir()],
  ] as const) {
    const hazards = pathHazards(p, ctx.platform);
    if (hazards.length > 0) {
      hazardFound = true;
      const severe = hazards.some((h) => h.includes("metacharacters"));
      statuses.push(severe ? "fail" : "warn");
      check.details.push(`${label} ${p}: ${hazards.join(", ")}`);
    }
  }
  if (!hazardFound) {
    check.details.push("storage/project/home paths: ASCII, no spaces or metacharacters");
  } else {
    check.fix = "prefer an ASCII, space-free project path; quoting is hardened, but path edges remain the classic breakage class";
  }
  // Probe endpoint length — evaluate exactly what a real birth would derive,
  // so the verdict matches the launcher guard's own behavior.
  const configuredDir = ctx.env.TUT_DELIVERY_PROBE_DIR;
  try {
    const endpoint = deliveryProbeEndpoint("doctor-self-check", "executor", ctx.env, ctx.platform, ctx.root);
    if (ctx.platform !== "win32") {
      const configuredTooLong =
        configuredDir !== undefined &&
        configuredDir.length > 0 &&
        Buffer.byteLength(path.join(configuredDir, PROBE_BASENAME), "utf8") > ENDPOINT_PATH_MAX;
      if (configuredTooLong) {
        statuses.push("warn");
        check.details.push(
          `TUT_DELIVERY_PROBE_DIR overflows the ${ENDPOINT_PATH_MAX}-byte sun_path limit — probe endpoints fall back to ${path.dirname(endpoint)}`,
        );
      } else {
        check.details.push(`delivery probe endpoint fits: ${endpoint}`);
      }
    } else {
      check.details.push(`delivery probe named pipe: ${endpoint}`);
    }
  } catch (e) {
    statuses.push("fail");
    check.details.push(`delivery probe endpoint cannot be derived: ${(e as Error).message}`);
  }
  check.status = worst(statuses);
  check.summary = check.status === "fail" ? "path/probe-endpoint hazards — see details" : "path safety prechecks passed";
  return check;
}

// --- check 7: platform -----------------------------------------------------------

function checkPlatform(ctx: DoctorContext): DoctorCheck {
  const check: DoctorCheck = {
    name: "platform",
    title: "platform info",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];
  const major = Number.parseInt(ctx.nodeVersion.replace(/^v/u, "").split(".")[0] ?? "0", 10);
  check.summary = `${ctx.platform} / node ${ctx.nodeVersion}`;
  check.details.push(`os: ${ctx.platform}; node: ${ctx.nodeVersion} (engines: >=20)`);
  if (major < 20) {
    statuses.push("warn");
    check.details.push("node below the engines floor (>=20) — unsupported territory");
  }
  try {
    const dialect = resolvePaneShellDialect(ctx.env, ctx.platform);
    check.details.push(
      `pane shell dialect: ${dialect}${ctx.env.TUT_PANE_SHELL !== undefined ? " (TUT_PANE_SHELL)" : " (platform default)"}`,
    );
  } catch (e) {
    if (e instanceof PaneShellError) {
      statuses.push("fail");
      check.details.push(`${e.message} — birth-time resolution fails loud on unknown dialects`);
      check.fix = "unset TUT_PANE_SHELL or set it to one of posix, powershell5, pwsh, cmd";
    }
  }
  if (ctx.platform === "win32") {
    const nonAscii = [homedir(), ctx.projectRoot, ctx.env.USERNAME ?? ""].some((p) => /[^\x00-\x7f]/u.test(p));
    if (nonAscii) {
      statuses.push("warn");
      check.details.push(
        "non-ASCII user/path on Windows: console code pages can mojibake text-probed agent paths. TUT's launcher self-enumerates PATH+PATHEXT in-process (unaffected); avoid routing agent paths through external text tools",
      );
    } else {
      check.details.push("windows paths ASCII-only — no code-page hazard flagged");
    }
  }
  // Env knobs in effect (delivery-facing, one line each).
  for (const [name, value] of [
    ["TUT_EVENT_PORT_URL", ctx.env.TUT_EVENT_PORT_URL],
    ["TUT_DELIVERY_PROBE_DIR", ctx.env.TUT_DELIVERY_PROBE_DIR],
    ["TUT_SUBMIT_RETRY_TIMEOUT_MS", ctx.env.TUT_SUBMIT_RETRY_TIMEOUT_MS],
  ] as const) {
    check.details.push(value !== undefined ? `${name}=${value}` : `${name} unset (default in effect)`);
  }
  if (ctx.env.TUT_SUBMIT_RETRY_TIMEOUT_MS === undefined) {
    check.details.push(
      "knob hint: slow agent cold starts under parallel delivery can need TUT_SUBMIT_RETRY_TIMEOUT_MS raised above the 30000 default (system-design 7.2.1)",
    );
  }
  check.status = worst(statuses);
  return check;
}

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
  const ctx: DoctorContext = {
    root,
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
    await guard("notifier", "notifier event port", () => checkNotifier(ctx)),
    await guard("config", "config & workspace chain", () => checkConfig(ctx)),
    agents.check,
    await guard("storage", "storage health", () => checkStorage(ctx, hub)),
    await guard("paths", "path safety & probe endpoints", () => checkPaths(ctx)),
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

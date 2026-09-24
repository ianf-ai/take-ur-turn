import { readConfig, autoSectionOf } from '../common/config.js';
/**
 * POSIX-compatible launcher execution used by the internal `launch` entry.
 *
 * This module keeps the legacy planning behavior available while birth,
 * lifecycle, and the closed-loop delivery live behind dedicated seams. All
 * Herdr/utility calls cross a direct argv boundary; the caller never spawns
 * a .sh file.
 */

import { rigLabel, rigEnvironment } from "../hub/rig.js";
import { canonicalRoot, resolveRigRoot } from "../hub/rig-discovery.js";
import {
  buildLaunchInvocation,
  explicitRouteFromValues,
  targetDigest,
} from "./invocation.js";
import {
  AgentTargetError,
  planForPlatform,
  resolvePosixTargetPresence,
  type PlatformExecutionPlan,
} from "./target-resolver.js";
import { birthPane } from "./birth.js";
import { cleanupTaskPanes, runRoundLifecycle, type LifecycleClient } from "./lifecycle.js";
import {
  createDelivery,
  createDeliveryDiagnostics,
  boundedCleanup,
  type DeliveryEvidenceV2,
  parseDeliveryKnobs,
  type DeliveryOutcome,
} from "./delivery.js";
import { DELIVERY_GIVEUP_EVENT, eventPortUrlOf, postAgentEvent, type GiveUpEvidence } from "./escalation.js";
import { birthCwdOf } from "./checkout.js";
import {
  renderPaneCommand,
  resolvePaneShellDialect,
  type PaneCommand,
  type RenderedPaneCommand,
  type ShellDialect,
} from "./shell-renderer.js";
import { normalizeAgentRoute } from "../common/agent-command.js";
import {
  defaultUserConfigDir,
  readWorkspaceConfigSnapshot,
  resolveAgentRouteWithSource,
  resolveTabLabelTemplateFromSnapshot,
  type WorkspaceConfigSnapshot,
} from "../common/workspace.js";
import { requireBirthAnchor, resolveExecutionContext } from "./anchor.js";
import { paneIdentityFrom, type PaneIdentity } from "./herdr-client-v2.js";
import { HerdrClient } from "./legacy-herdr-client.js";
import type {
  AgentCommand,
  AgentRoute,
  CheckoutRoute,
  ExecutionContext,
  LaunchInvocation,
  LaunchNaming,
  LaunchRequest,
  LaunchRouteSource,
} from "../common/types.js";
import type { LaunchEntry } from "./entry.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrPane } from "./legacy-herdr-client.js";
import type { LaunchAnchor } from "../common/types.js";

interface HerdrResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const DEFAULT_HUB_URL = "http://127.0.0.1:3001";
const herdrClient = new HerdrClient();

function dryRun(): boolean {
  return process.env.TUT_DRY_RUN === "1";
}

async function herdr(args: readonly string[]): Promise<HerdrResult> {
  return await herdrClient.command(args);
}

async function paneList(): Promise<{ panes: HerdrPane[]; usable: boolean; error?: string }> {
  try {
    // Keep the raw identity fields that the legacy tolerant pane adapter drops.
    const response = await herdrClient.command(["pane", "list"]);
    if (response.code !== 0) throw new Error("pane list failed");
    let parsed;
    try { parsed = JSON.parse(response.stdout); } catch { throw new Error("pane list returned invalid JSON"); }
    if (parsed === null || typeof parsed !== "object" || parsed.error || parsed.result?.error) throw new Error("invalid pane list");
    const rows = Array.isArray(parsed) ? parsed : (parsed.result ?? parsed).panes;
    if (!Array.isArray(rows)) throw new Error("invalid pane list");
    return { panes: rows.filter(row => row && typeof row.pane_id === "string"), usable: true };
  } catch (error) {
    return { panes: [], usable: false, error: (error as Error).message };
  }
}

const lifecycleClient: LifecycleClient = {
  listPanes: async () => await paneList(),
  closePane: async (paneId) => await herdr(["pane", "close", paneId]),
};

/** Render one invocation's platform plan into the pane command text.
 *
  POSIX keeps the bare executable, Windows plans carry their resolved
  absolute target; both render through the same dialect renderer. */
export function renderInvocationPaneCommand(
  invocation: LaunchInvocation,
  dialect: ShellDialect,
): RenderedPaneCommand {
  const plan = invocation.posix_direct !== undefined
    ? invocation.posix_direct
    : invocation.effective_agent !== undefined
      ? invocation.effective_agent
      : undefined;
  if (plan === undefined) {
    throw new Error("invocation has no platform execution plan — refusing to birth a pane");
  }
  const agentCommand: PaneCommand = {
    cwd: birthCwdOf(invocation.context),
    executable: plan.executable,
    args: plan.args,
    env: { ...plan.env, ...rigEnvironment(invocation.context.hubRoot, invocation.hub_url, plan.env.TUT_EVENT_PORT_URL || process.env.TUT_EVENT_PORT_URL || "http://127.0.0.1:3002/agent-event") },
    dialect,
    purpose: "agent",
  };
  return renderPaneCommand(agentCommand);
}

function renderTabLabel(template: string, role: string, taskId: string, agent: string): string {
  const rendered = template
    .replaceAll("{role}", role)
    .replaceAll("{task}", taskId)
    .replaceAll("{agent}", agent);
  if (rendered.length === 0 || /[\u0000\r\n]/u.test(rendered)) {
    throw new Error("naming.tab_label renders to an invalid label");
  }
  return rendered;
}

async function routeForRequest(
  request: LaunchRequest,
  context?: ExecutionContext,
  workspaceSnapshot?: WorkspaceConfigSnapshot,
  taskMetadata?: TaskLaunchMetadata,
): Promise<{ route: AgentCommand; source: LaunchRouteSource }> {
  const explicit = explicitRouteFromValues(request.explicit_route_values);
  if (explicit !== undefined) return { route: explicit, source: "legacy-explicit" };
  const cast = taskMetadata?.cast;
  const resolved = await resolveAgentRouteWithSource(
    request.role,
    cast,
    ...(workspaceSnapshot !== undefined
      ? [{ workspaceSnapshot }]
      : context !== undefined && !context.routingRoot.startsWith("<")
        ? [{ projectRoot: context.routingRoot }]
      : process.env.TUT_PROJECT_ROOT !== undefined && process.env.TUT_PROJECT_ROOT.length > 0
        ? [{ projectRoot: process.env.TUT_PROJECT_ROOT }]
      : []),
  );
  return { route: normalizeAgentRoute(resolved.route), source: resolved.source };
}

interface TaskLaunchMetadata {
  cast?: Record<string, AgentRoute>;
  checkout?: CheckoutRoute;
}

/** One metadata read for the legacy launch compatibility door, with the
 *  failure modes kept apart: an unreadable hub degrades (documented compat
 *  policy — loudly, see buildLegacyInvocation), while a 200 that does not
 *  know the task must never be read as "current checkout / default lineup". */
type TaskMetadataOutcome =
  | { kind: "ok"; metadata: TaskLaunchMetadata }
  | { kind: "hub-unreadable"; detail: string }
  | { kind: "task-missing" }
  | { kind: "hub-foreign"; detail: string };

export async function taskLaunchMetadata(taskId: string, hubUrl: string, rigRoot: string = resolveRigRoot()): Promise<TaskMetadataOutcome> {
  let response: Response;
  try {
    response = await fetch(new URL("/state", hubUrl));
  } catch (error) {
    return { kind: "hub-unreadable", detail: `fetch failed: ${(error as Error).message}` };
  }
  if (!response.ok) {
    return { kind: "hub-unreadable", detail: `HTTP ${response.status}` };
  }
  let state: { hub_root?: unknown; tasks?: Array<{ task_id: string; cast?: Record<string, AgentRoute>; checkout?: CheckoutRoute }> };
  try {
    state = (await response.json()) as typeof state;
  } catch (error) {
    return { kind: "hub-unreadable", detail: `/state returned unparseable JSON: ${(error as Error).message}` };
  }
  // Ownership handshake (hub-root): the legacy door must not plan a round against
  // another workspace's hub just because it answers on the default port —
  // records would land in the wrong workspace silently. Only a hub that
  // names a different (non-empty) root is foreign; hubs too old to expose
  // hub_root stay on the documented degraded path.
  if (typeof state.hub_root === "string" && state.hub_root.length > 0) {
    const served = canonicalRoot(state.hub_root);
    if (served !== canonicalRoot(rigRoot)) {
      return { kind: "hub-foreign", detail: `hub at ${hubUrl} serves ${served}, expected ${canonicalRoot(rigRoot)}` };
    }
  }
  const task = state.tasks?.find((entry) => entry.task_id === taskId);
  if (task === undefined) return { kind: "task-missing" };
  return {
    kind: "ok",
    metadata: {
      ...(task.cast !== undefined ? { cast: task.cast } : {}),
      ...(task.checkout !== undefined ? { checkout: task.checkout } : {}),
    },
  };
}

/** POSIX presence preflight through the structured target resolver. */
async function agentOnPath(agent: string): Promise<boolean> {
  try {
    await resolvePosixTargetPresence(agent);
    return true;
  } catch (error) {
    if (!(error instanceof AgentTargetError)) throw error;
    process.stderr.write(`launch: ${(error as Error).message}\n`);
    return false;
  }
}

function promptFor(role: string, taskId: string): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "skills");
  return `轮到你了（role: ${role}）：请用 Context Hub 读取任务 ${taskId} 的完整上下文（context.read），按你的 role skill（${path.join(root, `${role}.md`)}）开始本轮工作，完成后发布相应记录（context.publish）。`;
}

async function buildLegacyInvocation(request: LaunchRequest, invocation?: LaunchInvocation): Promise<LaunchInvocation> {
  if (invocation !== undefined) return invocation;
  // Resolve the Herdr snapshot once.  Route/naming and birth consume this
  // same context; no later phase is allowed to rediscover the anchor.
  const environment = { ...process.env };
  const hubUrl = environment.TUT_HUB_URL ?? DEFAULT_HUB_URL;
  const outcome = await taskLaunchMetadata(request.task_id, hubUrl);
  if (outcome.kind === "task-missing") {
    // A well-formed 200 that does not know the task is a caller error, not
    // a hub outage: planning a round for a nonexistent task would launch it
    // outside its (unknown) checkout — the exact silent worktree isolation breach
    // this door was closed for.  Refuse before any Herdr mutation (cli.ts
    // catches and prints this as the single stderr line, exit 1).
    throw new Error(
      `task '${request.task_id}' not found in hub state at ${hubUrl} — refusing to plan a round (create the task or fix the task id)`,
    );
  }
  if (outcome.kind === "hub-foreign") {
    // Same isolation breach, ownership flavor: the answering hub belongs to
    // another workspace. Refuse loudly instead of launching with foreign
    // checkout/cast metadata (run 'tut up' without --url in the intended
    // workspace, or pass --url for that workspace's hub).
    throw new Error(
      `hub ownership mismatch — ${outcome.detail} — refusing to plan a round for task '${request.task_id}'`,
    );
  }
  if (outcome.kind === "hub-unreadable") {
    // Documented compat degradation (system-design 7.x): the legacy door
    // stays open when the hub is down/unreadable, but never silently —
    // one stderr line names the URL and the reason before current/default
    // is assumed.
    process.stderr.write(
      `launch: hub state unreadable at ${hubUrl} (${outcome.detail}) — task checkout/cast not applied, using current checkout and default lineup\n`,
    );
  }
  const metadata = outcome.kind === "ok" ? outcome.metadata : undefined;
  const context = await resolveExecutionContext({
    caller_cwd: process.cwd(),
    env: environment,
    dry_run: environment.TUT_DRY_RUN === "1",
    client: new HerdrClient({ env: environment }),
    ...(metadata?.checkout !== undefined ? { checkout: metadata.checkout } : {}),
  });
  const routingRoot = context.routingRoot.startsWith("<")
    ? context.caller_cwd ?? process.cwd()
    : context.routingRoot;
  const workspaceSnapshot = await readWorkspaceConfigSnapshot({
    projectRoot: routingRoot,
    userConfigDir: defaultUserConfigDir(environment),
    ...(context.checkout.kind === "worktree" && !context.hubRoot.startsWith("<")
      ? { fallbackProjectRoot: context.hubRoot }
      : {}),
  });
  const route = await routeForRequest(request, context, workspaceSnapshot, metadata);
  // A cast is an explicit choice. Refuse before lifecycle mutation, including
  // continuation of an existing pane, when its executable is unavailable.
  if (route.source === "task-cast" && process.platform !== "win32") {
    await resolvePosixTargetPresence(route.route.agent);
  }
  const template = resolveTabLabelTemplateFromSnapshot(workspaceSnapshot);
  const naming: LaunchNaming = {
    tab_label: renderTabLabel(template, request.role, request.task_id, route.route.agent),
    pane_label: rigLabel(`${request.task_id}.${request.role}`, context.hubRoot),
  };
  // One platform plan from the shared policy: POSIX stays pure (presence is
  // proved at birth per the legacy compat error path); Windows resolves its
  // structured target here, before any marker/tab mutation.
  const plan: PlatformExecutionPlan = await planForPlatform(route.route, { environment });
  return buildLaunchInvocation({
    request,
    base_version: 0,
    hub_url: hubUrl,
    route: route.route,
    route_source: route.source,
    context,
    naming,
    prompt: promptFor(request.role, request.task_id),
    ...(plan.platform === "posix"
      ? { posix_direct: plan.posix_direct }
      : { resolved_target: plan.resolved_target, effective_agent: plan.effective_agent }),
  });
}

export async function runCompatLaunch(entry: LaunchEntry): Promise<number> {
  return await runCompatLaunchImpl(entry);
}

/**
 * Bind the give-up escalation to the round's identity (route agent + pane
 * label) once per launch.  Never throws: a failed POST is diagnosed to
 * stderr and dropped — the stderr diagnostics and the stall watchdog remain
 * as the degradation path.
 */
function createGiveUpEscalation(options: {
  agent: string;
  pane: string;
  env: NodeJS.ProcessEnv;
}): (paneId: string, evidence: Readonly<DeliveryEvidenceV2>) => Promise<void> {
  const url = eventPortUrlOf(options.env);
  return async (_paneId, evidence) => {
    // The existing serializer accepts arbitrary additive fields at runtime.
    // C owns widening its legacy-only TypeScript input and consumer parser.
    const event = { event: DELIVERY_GIVEUP_EVENT, agent: options.agent,
      pane: options.pane, delivery_v2: evidence };
    const dispatch = await postAgentEvent(event as typeof event & GiveUpEvidence, url);
    if (dispatch !== "sent") {
      process.stderr.write(
        `launch: delivery give-up escalation to ${url} failed (event dropped; stderr diagnostics and the stall watchdog remain)\n`,
      );
    }
  };
}

async function runCompatLaunchImpl(entry: LaunchEntry): Promise<number> {
  const deadlineMonoMs = performance.now() + 170_000;
  if (entry.kind === "cleanup") {
    process.stderr.write(`launch: cleanup — reaping panes of task '${entry.task_id}' requested (best-effort; inventory failures may leave panes open)\n`);
    await cleanupTaskPanes({
      task_id: entry.task_id,
      hubRoot: process.env.TUT_HUB_ROOT ?? process.cwd(),
      client: lifecycleClient,
      dryRun: dryRun(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
    return 0;
  }
  // Resolve the pane dialect BEFORE any Herdr discovery or mutation — an
  // unknown TUT_PANE_SHELL must fail the launch with zero control-plane
  // calls, and rendering errors likewise never land mid-birth.  The gate
  // must also precede buildLegacyInvocation: the legacy entry (no
  // pre-constructed invocation) runs Herdr pane discovery while planning,
  // so planning itself is the first control-plane call the gate must beat.
  let dialect: ShellDialect;
  try {
    dialect = resolvePaneShellDialect(process.env);
  } catch (error) {
    process.stderr.write(`launch: ${(error as Error).message}\n`);
    return 1;
  }
  const invocation = await buildLegacyInvocation(entry.request, entry.invocation);
  let rendered: RenderedPaneCommand;
  try {
    rendered = renderInvocationPaneCommand(invocation, dialect);
  } catch (error) {
    process.stderr.write(`launch: ${(error as Error).message}\n`);
    return 1;
  }
  // The child consumes the exact context frozen by the planner.  In
  // particular, do not run another pane-list lookup here: a changed/focused
  // Herdr workspace must not move a birth away from the selected anchor.
  let anchor: LaunchAnchor | undefined;
  try {
    // Dry-run is allowed to carry the explicit placeholder for preview output.
    // Live launches must reject before pane discovery, reaping, delivery, or birth:
    // those operations are all downstream of the anchor mutation boundary.
    anchor = dryRun() ? invocation.context.anchor : requireBirthAnchor(invocation.context);
  } catch (error) {
    process.stderr.write(`launch: ${(error as Error).message}\n`);
    return 1;
  }
  // Dual-sink delivery observer (stderr + <root>/.context-hub/delivery.log):
  // the durable root falls back from TUT_PROJECT_ROOT to the anchor-derived
  // hub root — the legacy chain-root rule — and stays off in dry-run where
  // the context is a placeholder.
  const diagnostics = createDeliveryDiagnostics({
    env: process.env,
    task_id: invocation.task_id,
    role: invocation.role,
    ...(invocation.context.hubRoot.startsWith("<") ? {} : { persistRootFallback: invocation.context.hubRoot }),
  });
  const client = herdrClient.deliveryV2;
  // Give-up escalation: every unconfirmed attempt posts the frozen evidence. The
  // launcher posts a delivery_giveup agent event so the notifier escalates
  // through the configured channels immediately instead of leaving the
  // round silent until the stall watchdog.  The event's pane field carries
  // the round-pane LABEL (<task_id>.<role>) — the notifier's reverse-lookup
  // key — not the herdr pane id.  Dry-run emits nothing.
  const escalateGiveUp = dryRun()
    ? undefined
    : createGiveUpEscalation({
        agent: invocation.route.agent,
        pane: invocation.naming.pane_label,
        env: { ...process.env, ...(invocation.posix_direct ?? invocation.effective_agent)?.env },
      });
  const config = dryRun() ? null : await readConfig(path.join(invocation.context.hubRoot, ".context-hub"));
  const remediationMode = autoSectionOf(config)?.remediate ?? (config?.flow_mode === "auto" ? "enter-repress" : "off");
  const delivery = createDelivery({
    remediationEvidence: remediationMode === "enter-repress",
    client,
    diagnostics,
    env: process.env,
    deadlineMonoMs,
    ...(escalateGiveUp !== undefined ? { onGiveUp: escalateGiveUp } : {}),
  });
  try {
    return await runDeliveredRound(entry, invocation, anchor, delivery, rendered.command_text);
  } finally {
    await boundedCleanup(() => diagnostics.flush(), 2000);
  }
}

/** Boolean lifecycle seam means handled, never confirmed. Preserve/log the outcome here. */
function handled(outcome: DeliveryOutcome): boolean {
  try {
    if (outcome.exitCode === 0) process.stderr.write("launch attempt completed; delivery confirmation is not implied\n");
    else process.stderr.write(`launch: ${outcome.reason}; inspect the pane before another attempt\n`);
  } catch { /* Diagnostic failure must not invite another delivery. */ }
  return outcome.exitCode === 0;
}
function previewDelivery(pane: string, textPreview: string, branch: 'born' | 'continuation'): void {
  process.stdout.write(`DRY-RUN: status-before ${pane} via herdr pane list (wait up to ${parseDeliveryKnobs(process.env).readyMs}ms before any input; ${branch === 'born' ? 'born: after working wait for idle, timeout uses final probe (unknown or invalid: no input)' : 'continuation: first classifiable baseline, working sends immediately'}; bounded by launcher deadline)\n`);
  process.stdout.write(textPreview);
  process.stdout.write(`DRY-RUN: herdr pane send-keys ${pane} Enter (at most once)\n`);
  process.stdout.write(`DRY-RUN: status-observed ${pane} via herdr pane list; TUT_STATUS_FLIP_TIMEOUT_MS=${process.env.TUT_STATUS_FLIP_TIMEOUT_MS ?? "30000"}, TUT_STATUS_POLL_MS=${process.env.TUT_STATUS_POLL_MS ?? "250"}; bounded monotonic deadline; working-observed requires manual inspection (attribution unavailable)\n`);
}

async function runDeliveredRound(
  entry: LaunchEntry,
  invocation: LaunchInvocation,
  anchor: LaunchAnchor | undefined,
  delivery: ReturnType<typeof createDelivery>,
  commandText: string,
): Promise<number> {
  if (entry.kind !== "round") return 1;
  const route = invocation.route;
  // The pane command text was rendered from the frozen platform plan before
  // any mutation; the POSIX plan still drives the legacy presence preflight.
  const plan = invocation.posix_direct;
  const birthExecutable = plan?.executable ?? invocation.effective_agent?.executable;
  const birthCwd = birthCwdOf(invocation.context);
  const tabLabel = invocation.naming.tab_label;
  const paneLabel = invocation.naming.pane_label;
  const continuitySetting = process.env.TUT_CONTINUITY_ROLES;
  const lifecycle = await runRoundLifecycle({
    invocation,
    client: lifecycleClient,
    dryRun: dryRun(),
    ...(continuitySetting === undefined ? {} : { continuityRoles: continuitySetting }),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    onContinuation: async (existing) => {
      if (dryRun()) {
        previewDelivery(existing.pane_id, `DRY-RUN: herdr pane send-text ${existing.pane_id} "${invocation.prompt}"\n`, 'continuation');
        return true;
      }
      return handled(await delivery.deliver({ target: paneIdentityFrom(existing as unknown as Record<string, unknown>), prompt: invocation.prompt, branch: "continuation" }));
    },
    onBirth: async () => {
      const birthAnchor = anchor ?? invocation.context.anchor;
      if (birthAnchor === undefined) {
        process.stderr.write("launch: no anchor pane found (tut-hub / tut-notify / $TUT_SPLIT_BASE) — run tut up, or set TUT_SPLIT_BASE to a pane id\n");
        return undefined;
      }
      return await birthPane({
        client: herdrClient,
        anchor: birthAnchor,
        birthCwd,
        tabLabel,
        paneLabel,
        commandText,
        ...(birthExecutable !== undefined ? { executable: birthExecutable } : {}),
        dryRun: dryRun(),
        env: process.env,
        paneEnvironment: rigEnvironment(invocation.context.hubRoot, invocation.hub_url, (invocation.posix_direct ?? invocation.effective_agent)?.env.TUT_EVENT_PORT_URL || process.env.TUT_EVENT_PORT_URL || "http://127.0.0.1:3002/agent-event"),
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        ...(entry.invocation === undefined && plan !== undefined
          ? {
              preflightAgent: async () => await agentOnPath(plan.executable),
              preflightAgentName: plan.executable,
            }
          : {}),
      });
    },
  });
  if (lifecycle.kind === "continuation") return lifecycle.delivered ? 0 : 1;
  if (lifecycle.kind !== "birth" || lifecycle.pane_id === undefined) return 1;
  if (dryRun()) {
    const target = `<label:${paneLabel}>`;
    previewDelivery(target, `DRY-RUN: herdr pane send-text ${target} (agent '${route.agent}', label '${paneLabel}') "${invocation.prompt}"\n`, 'born');
    return 0;
  }
  // Capture the created pane's available identity before freezing the attempt.
  // This is target selection, never a readiness check.
  const snapshot = await paneList();
  const matches = snapshot.panes.filter(p => p.pane_id === lifecycle.pane_id);
  if (!snapshot.usable || matches.length !== 1) return 1;
  const target: PaneIdentity = paneIdentityFrom(matches[0] as unknown as Record<string, unknown>);
  return handled(await delivery.deliver({ target, prompt: invocation.prompt, branch: "born" })) ? 0 : 1;
}

/** Recompute the digest from a private plan for child/marker consistency tests. */
export function privateDigestOf(invocation: LaunchInvocation): string | undefined {
  if (invocation.marker_projection === undefined) return undefined;
  if (invocation.posix_direct !== undefined) {
    return targetDigest({ route: invocation.route, target_kind: "posix-direct", posix_direct: invocation.posix_direct });
  }
  return invocation.marker_projection.target_digest;
}

/**
 * POSIX-compatible launcher execution used by the internal `launch` entry.
 *
 * This module keeps the legacy planning behavior available while birth,
 * lifecycle, and the closed-loop delivery live behind dedicated seams. All
 * Herdr/utility calls cross a direct argv boundary; the caller never spawns
 * a .sh file.
 */

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
  type DeliveryClient,
  type DeliveryProbeDispatch,
} from "./delivery.js";
import { createDeliveryProbeChannel, deliveryProbeEndpoint } from "./probe-channel.js";
import { DELIVERY_GIVEUP_EVENT, eventPortUrlOf, postAgentEvent, type GiveUpEvidence } from "./escalation.js";
import { birthCwdOf } from "./checkout.js";
import {
  renderPaneCommand,
  defaultPaneRuntime,
  encodePaneRunnerPayload,
  resolvePaneShellDialect,
  type PaneCommand,
  type RenderedPaneCommand,
  type ShellDialect,
} from "./shell-renderer.js";
import { normalizeAgentRoute } from "../agent-command.js";
import {
  defaultUserConfigDir,
  readWorkspaceConfigSnapshot,
  resolveAgentRouteWithSource,
  resolveTabLabelTemplateFromSnapshot,
  type WorkspaceConfigSnapshot,
} from "../workspace.js";
import { requireBirthAnchor, resolveExecutionContext } from "./anchor.js";
import { HerdrClient } from "./herdr-client.js";
import type {
  AgentCommand,
  AgentRoute,
  CheckoutRoute,
  ExecutionContext,
  LaunchInvocation,
  LaunchNaming,
  LaunchRequest,
  LaunchRouteSource,
} from "../types.js";
import type { LaunchEntry } from "./entry.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrPane } from "./herdr-client.js";
import type { LaunchAnchor } from "../types.js";

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
    return { panes: (await herdrClient.paneList()).panes, usable: true };
  } catch (error) {
    return { panes: [], usable: false, error: (error as Error).message };
  }
}

const lifecycleClient: LifecycleClient = {
  listPanes: async () => await paneList(),
  closePane: async (paneId) => await herdr(["pane", "close", paneId]),
};

/** Delivery seam: every read is a visible-source read, every send a raw
 *  argv call; failures degrade to ""/false inside the delivery module. */
export function createDeliveryClient(
  command: (args: readonly string[]) => Promise<HerdrResult>,
  options: { probe?: (paneId: string, marker: string) => Promise<DeliveryProbeDispatch> } = {},
): DeliveryClient {
  return {
    readPane: async (paneId) => {
      const result = await command(["pane", "read", paneId, "--source", "visible", "--lines", "40"]);
      return result.code === 0 ? result.stdout : "";
    },
    sendText: async (paneId, text) => (await command(["pane", "send-text", paneId, text])).code === 0,
    sendKeys: async (paneId, key) => (await command(["pane", "send-keys", paneId, key])).code === 0,
    ...(options.probe === undefined ? {} : { sendProbe: options.probe }),
  };
}

/** Render one invocation's platform plan into the pane command text.
 *
  POSIX keeps the bare executable, Windows plans carry their resolved
  absolute target; both render through the same dialect renderer. */
function renderInvocationPaneCommand(
  invocation: LaunchInvocation,
  dialect: ShellDialect,
  probeEndpoint?: string,
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
    env: plan.env,
    dialect,
    purpose: "agent",
  };
  if (probeEndpoint === undefined) return renderPaneCommand(agentCommand);

  const runtime = defaultPaneRuntime();
  const probeRunnerEntry = runtime.probeRunnerEntry;
  if (probeRunnerEntry === undefined) throw new Error("probe relay runtime entry is unavailable");
  const relayCommand: PaneCommand = {
    cwd: agentCommand.cwd,
    executable: runtime.nodeExecutable,
    args: [
      probeRunnerEntry,
      "--socket", probeEndpoint,
      "--dialect", dialect,
      "--payload", encodePaneRunnerPayload(agentCommand),
    ],
    env: {},
    dialect,
    purpose: "agent",
  };
  return renderPaneCommand(relayCommand, runtime);
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
  | { kind: "task-missing" };

async function taskLaunchMetadata(taskId: string, hubUrl: string): Promise<TaskMetadataOutcome> {
  let response: Response;
  try {
    response = await fetch(new URL("/state", hubUrl));
  } catch (error) {
    return { kind: "hub-unreadable", detail: `fetch failed: ${(error as Error).message}` };
  }
  if (!response.ok) {
    return { kind: "hub-unreadable", detail: `HTTP ${response.status}` };
  }
  let state: { tasks?: Array<{ task_id: string; cast?: Record<string, AgentRoute>; checkout?: CheckoutRoute }> };
  try {
    state = (await response.json()) as typeof state;
  } catch (error) {
    return { kind: "hub-unreadable", detail: `/state returned unparseable JSON: ${(error as Error).message}` };
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
  const template = resolveTabLabelTemplateFromSnapshot(workspaceSnapshot);
  const naming: LaunchNaming = {
    tab_label: renderTabLabel(template, request.role, request.task_id, route.route.agent),
    pane_label: `${request.task_id}.${request.role}`,
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
}): (paneId: string, evidence: GiveUpEvidence) => Promise<void> {
  const url = eventPortUrlOf(options.env);
  return async (_paneId, evidence) => {
    const dispatch = await postAgentEvent(
      {
        event: DELIVERY_GIVEUP_EVENT,
        agent: options.agent,
        pane: options.pane,
        box: evidence.box,
        transport: evidence.transport,
        ...(evidence.probe === undefined ? {} : { probe: evidence.probe }),
      },
      url,
    );
    if (dispatch !== "sent") {
      process.stderr.write(
        `launch: delivery give-up escalation to ${url} failed (event dropped; stderr diagnostics and the stall watchdog remain)\n`,
      );
    }
  };
}

async function runCompatLaunchImpl(entry: LaunchEntry): Promise<number> {
  if (entry.kind === "cleanup") {
    process.stderr.write(`launch: cleanup — reaping panes of task '${entry.task_id}' requested (best-effort; inventory failures may leave panes open)\n`);
    await cleanupTaskPanes({
      task_id: entry.task_id,
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
  const probeEndpoint = dryRun()
    ? undefined
    : deliveryProbeEndpoint(invocation.task_id, invocation.role, process.env, process.platform);
  try {
    rendered = renderInvocationPaneCommand(invocation, dialect, probeEndpoint);
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
  const probeChannel = probeEndpoint === undefined ? undefined : createDeliveryProbeChannel({ endpoint: probeEndpoint });
  const client = createDeliveryClient(herdr, {
    ...(probeChannel === undefined ? {} : { probe: async (_paneId, marker) => await probeChannel.send(marker) }),
  });
  // Give-up escalation (7.2.1): when the submit-retry window exhausts, the
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
        env: process.env,
      });
  const delivery = createDelivery({
    client,
    diagnostics,
    env: process.env,
    probeDialect: dialect,
    ...(escalateGiveUp !== undefined ? { onGiveUp: escalateGiveUp } : {}),
  });
  try {
    return await runDeliveredRound(entry, invocation, anchor, delivery, rendered.command_text);
  } finally {
    await diagnostics.flush();
  }
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
        process.stdout.write(`DRY-RUN: herdr pane send-text ${existing.pane_id} "${invocation.prompt}"\n`);
        process.stdout.write(`DRY-RUN: text-land check ${existing.pane_id} (timeout ${process.env.TUT_TEXT_LAND_TIMEOUT_MS ?? "5000"}ms; prompt-fragment match, NEW instance vs pre-send baseline; prompt carries a per-delivery nonce suffix for attribution)\n`);
        process.stdout.write(`DRY-RUN: on land: herdr pane send-keys ${existing.pane_id} Enter\n`);
        process.stdout.write(`DRY-RUN: on land: delivery probe ${existing.pane_id} (out-of-band shell relay + one read; never writes probe text to the Agent TUI; diagnostic only — never confirms nor blocks the submit)\n`);
        process.stdout.write(`DRY-RUN: on land: submit verify ${existing.pane_id} (ONE monotonic budget: ${process.env.TUT_SUBMIT_RETRY_TIMEOUT_MS ?? "30000"}ms total from the first Enter; initial observation ≤ min(${process.env.TUT_SUBMIT_TIMEOUT_MS ?? "3000"}ms, budget) by transport+box-cleared; bounded Enter resend loop — interval ${process.env.TUT_SUBMIT_RETRY_MS ?? "1500"}ms within the remaining budget, probe diagnostic-only; exhaustion → evidence-based manual-fallback note, still exit 0)\n`);
        process.stdout.write(`DRY-RUN: on land-timeout: NO Enter, NO probe — observe-only wait for a late landing (same new-instance rule) within the remaining ${process.env.TUT_SUBMIT_RETRY_TIMEOUT_MS ?? "30000"}ms budget; exhausted without the text → give-up reason=land-never-observed (attempts=0) + escalation\n`);
        return true;
      }
      return await delivery.deliver({ paneId: existing.pane_id, prompt: invocation.prompt, branch: "continuation" });
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
    process.stdout.write(`DRY-RUN: ready-probe ${target} (born pane; floor ${process.env.TUT_READY_FLOOR_MS ?? "1500"}ms, timeout ${process.env.TUT_READY_TIMEOUT_MS ?? "15000"}ms, quiescence ${process.env.TUT_READY_STABLE_POLLS ?? "4"}×poll identical samples)\n`);
    process.stdout.write(`DRY-RUN: herdr pane send-text ${target} (agent '${route.agent}', label '${paneLabel}') "${invocation.prompt}"\n`);
    process.stdout.write(`DRY-RUN: text-land check ${target} (timeout ${process.env.TUT_TEXT_LAND_TIMEOUT_MS ?? "5000"}ms; prompt-fragment match, NEW instance vs pre-send baseline; prompt carries a per-delivery nonce suffix for attribution)\n`);
    process.stdout.write(`DRY-RUN: on land: herdr pane send-keys ${target} Enter\n`);
    process.stdout.write(`DRY-RUN: on land: delivery probe ${target} (out-of-band shell relay + one read; never writes probe text to the Agent TUI; diagnostic only — never confirms nor blocks the submit)\n`);
    process.stdout.write(`DRY-RUN: on land: submit verify ${target} (ONE monotonic budget: ${process.env.TUT_SUBMIT_RETRY_TIMEOUT_MS ?? "30000"}ms total from the first Enter; initial observation ≤ min(${process.env.TUT_SUBMIT_TIMEOUT_MS ?? "3000"}ms, budget) by transport+box-cleared; bounded Enter resend loop — interval ${process.env.TUT_SUBMIT_RETRY_MS ?? "1500"}ms within the remaining budget, probe diagnostic-only; exhaustion → evidence-based manual-fallback note, still exit 0)\n`);
    process.stdout.write(`DRY-RUN: on land-timeout: NO Enter, NO probe — observe-only wait for a late landing (same new-instance rule) within the remaining ${process.env.TUT_SUBMIT_RETRY_TIMEOUT_MS ?? "30000"}ms budget; exhausted without the text → give-up reason=land-never-observed (attempts=0) + escalation\n`);
    return 0;
  }
  return (await delivery.deliver({ paneId: lifecycle.pane_id, prompt: invocation.prompt, branch: "born" })) ? 0 : 1;
}

/** Recompute the digest from a private plan for child/marker consistency tests. */
export function privateDigestOf(invocation: LaunchInvocation): string | undefined {
  if (invocation.marker_projection === undefined) return undefined;
  if (invocation.posix_direct !== undefined) {
    return targetDigest({ route: invocation.route, target_kind: "posix-direct", posix_direct: invocation.posix_direct });
  }
  return invocation.marker_projection.target_digest;
}

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
import { createDelivery, createDeliveryDiagnostics, type DeliveryClient } from "./delivery.js";
import { birthCwdOf } from "./checkout.js";
import {
  renderPaneCommand,
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
): DeliveryClient {
  return {
    readPane: async (paneId) => {
      const result = await command(["pane", "read", paneId, "--source", "visible", "--lines", "40"]);
      return result.code === 0 ? result.stdout : "";
    },
    sendText: async (paneId, text) => (await command(["pane", "send-text", paneId, text])).code === 0,
    sendKeys: async (paneId, key) => (await command(["pane", "send-keys", paneId, key])).code === 0,
  };
}

const deliveryClient = createDeliveryClient(herdr);

/** Render one invocation's platform plan into the pane command text.
 *
  POSIX keeps the bare executable, Windows plans carry their resolved
  absolute target; both render through the same dialect renderer. */
function renderInvocationPaneCommand(invocation: LaunchInvocation, dialect: ShellDialect): RenderedPaneCommand {
  const plan = invocation.posix_direct !== undefined
    ? invocation.posix_direct
    : invocation.effective_agent !== undefined
      ? invocation.effective_agent
      : undefined;
  if (plan === undefined) {
    throw new Error("invocation has no platform execution plan — refusing to birth a pane");
  }
  const command: PaneCommand = {
    cwd: birthCwdOf(invocation.context),
    executable: plan.executable,
    args: plan.args,
    env: plan.env,
    dialect,
    purpose: "agent",
  };
  return renderPaneCommand(command);
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
): Promise<{ route: AgentCommand; source: LaunchRouteSource }> {
  const explicit = explicitRouteFromValues(request.explicit_route_values);
  if (explicit !== undefined) return { route: explicit, source: "legacy-explicit" };
  let cast: Record<string, AgentRoute> | undefined;
  const hubUrl = process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL;
  try {
    const response = await fetch(new URL("/state", hubUrl));
    if (response.ok) {
      const state = (await response.json()) as { tasks?: Array<{ task_id: string; cast?: Record<string, AgentRoute> }> };
      cast = state.tasks?.find((task) => task.task_id === request.task_id)?.cast;
    }
  } catch {
    process.stderr.write(`launch: hub unreachable at ${hubUrl} — cast not readable, using the default lineup\n`);
  }
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
  const context = await resolveExecutionContext({
    caller_cwd: process.cwd(),
    env: environment,
    dry_run: environment.TUT_DRY_RUN === "1",
    client: new HerdrClient({ env: environment }),
  });
  const routingRoot = context.routingRoot.startsWith("<")
    ? context.caller_cwd ?? process.cwd()
    : context.routingRoot;
  const workspaceSnapshot = await readWorkspaceConfigSnapshot({
    projectRoot: routingRoot,
    userConfigDir: defaultUserConfigDir(environment),
  });
  const route = await routeForRequest(request, context, workspaceSnapshot);
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
    hub_url: environment.TUT_HUB_URL ?? DEFAULT_HUB_URL,
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
  const delivery = createDelivery({ client: deliveryClient, diagnostics, env: process.env });
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
        process.stdout.write(`DRY-RUN: text-land check ${existing.pane_id} (timeout ${process.env.TUT_TEXT_LAND_TIMEOUT_MS ?? "5000"}ms; on timeout submit anyway)\n`);
        process.stdout.write(`DRY-RUN: herdr pane send-keys ${existing.pane_id} Enter\n`);
        process.stdout.write(`DRY-RUN: submit verify ${existing.pane_id} (verify ${process.env.TUT_SUBMIT_TIMEOUT_MS ?? "3000"}ms by input-box-cleared; then bounded Enter resend loop — interval ${process.env.TUT_SUBMIT_RETRY_MS ?? "1500"}ms within ${process.env.TUT_SUBMIT_RETRY_TIMEOUT_MS ?? "30000"}ms; exhaustion → manual-fallback note, still exit 0)\n`);
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
    process.stdout.write(`DRY-RUN: ready-probe ${target} (born pane; floor ${process.env.TUT_READY_FLOOR_MS ?? "1500"}ms, timeout ${process.env.TUT_READY_TIMEOUT_MS ?? "15000"}ms)\n`);
    process.stdout.write(`DRY-RUN: herdr pane send-text ${target} (agent '${route.agent}', label '${paneLabel}') "${invocation.prompt}"\n`);
    process.stdout.write(`DRY-RUN: text-land check ${target} (timeout ${process.env.TUT_TEXT_LAND_TIMEOUT_MS ?? "5000"}ms; on timeout submit anyway)\n`);
    process.stdout.write(`DRY-RUN: herdr pane send-keys ${target} Enter\n`);
    process.stdout.write(`DRY-RUN: submit verify ${target} (verify ${process.env.TUT_SUBMIT_TIMEOUT_MS ?? "3000"}ms by input-box-cleared; then bounded Enter resend loop — interval ${process.env.TUT_SUBMIT_RETRY_MS ?? "1500"}ms within ${process.env.TUT_SUBMIT_RETRY_TIMEOUT_MS ?? "30000"}ms; exhaustion → manual-fallback note, still exit 0)\n`);
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

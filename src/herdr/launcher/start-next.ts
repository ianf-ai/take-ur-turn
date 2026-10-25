import { fileURLToPath } from "node:url";
import { rigLabel } from "../../core/hub/rig.js";
import { launchBlocked, latestRecordVersion, markLaunched, readLaunchLog } from "../../core/launcher/launch.js";
import { bindLaunchBaseVersion, buildLaunchInvocation } from "../../core/launcher/invocation.js";
import { ensureNotifierEventUrl } from "../../core/launcher/event-endpoint.js";
import { AgentTargetError, UnsupportedWindowsShimError, resolvePlatformExecutionPlan } from "../../core/launcher/target-resolver.js";
import { cliEntryPath, runInternalLaunchInvocation } from "./process.js";
import { requireBirthAnchor, resolveExecutionContext } from "./anchor.js";
import { defaultUserConfigDir, readWorkspaceConfigSnapshot, resolveAgentRouteWithSource, resolveTabLabelTemplateFromSnapshot } from "../../core/common/workspace.js";
import { failWith } from "../../core/cli/shared.js";
import type { Cast, CheckoutRoute, LaunchRequest } from "../../core/common/types.js";

export async function runStartNextTui(parsed: { url: string; force: boolean }, entry: { version?: number; cast?: Cast; checkout?: CheckoutRoute }, request: LaunchRequest): Promise<number> {
  const { task_id: taskId, role } = request;
  let records;
  try {
    records = await readLaunchLog(parsed.url, taskId);
  } catch (e) {
    return failWith(e, parsed.url);
  }
  let baseVersion: number;
  try {
    baseVersion = bindLaunchBaseVersion(entry.version, latestRecordVersion(records));
  } catch (e) {
    process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }
  const blocked = launchBlocked(records, role);
  if (blocked.blocked && !parsed.force) {
    process.stderr.write(
      `tut: ALREADY_LAUNCHED: ${role} launched at v${blocked.noteVersion ?? "?"}, no new publish since; inspect this round and outstanding control calls before considering --force\n`,
    );
    return 1;
  }

  // Pre-checks, BEFORE the marker (failure leaves no trace — a plain retry
  // works, no --force): resolve one normalized route, build one immutable
  // invocation, then require its executable on PATH.  The child receives the
  // invocation as one JSON argv item; it is never asked to resolve the route
  // a second time.
  const launchEnvironment = { ...process.env };
  let invocation: ReturnType<typeof buildLaunchInvocation>;
  try {
    // Freeze the Herdr anchor and routing root before the marker.  The
    // internal child receives this snapshot and must not rediscover a
    // focused/different workspace during lifecycle execution.
    const executionContext = await resolveExecutionContext({
      caller_cwd: process.cwd(),
      env: launchEnvironment,
      dry_run: launchEnvironment.TUT_DRY_RUN === "1",
      ...(entry.checkout !== undefined ? { checkout: entry.checkout } : {}),
    });
    await ensureNotifierEventUrl(launchEnvironment, parsed.url, executionContext.hubRoot);
    const projectRoot = executionContext.routingRoot.startsWith("<")
      ? executionContext.caller_cwd ?? process.cwd()
      : executionContext.routingRoot;
    const workspaceSnapshot = await readWorkspaceConfigSnapshot({
      projectRoot,
      userConfigDir: defaultUserConfigDir(launchEnvironment),
      ...(executionContext.checkout.kind === "worktree" && !executionContext.hubRoot.startsWith("<")
        ? { fallbackProjectRoot: executionContext.hubRoot }
        : {}),
    });
    const resolved = await resolveAgentRouteWithSource(
      role,
      entry.cast,
      { workspaceSnapshot },
    );
    const route = typeof resolved.route === "string"
      ? { agent: resolved.route, args: [] }
      : { agent: resolved.route.agent, args: [...resolved.route.args] };
    // Target resolution happens after route selection and before the marker:
    // POSIX proves PATH presence (which + executable regular file), Windows
    // resolves its structured target and refuses shims.  Any failure leaves
    // no trace — a plain retry works, no --force needed.
    let plan: Awaited<ReturnType<typeof resolvePlatformExecutionPlan>>;
    try {
      plan = await resolvePlatformExecutionPlan(route, { environment: launchEnvironment });
    } catch (e) {
      if (e instanceof UnsupportedWindowsShimError || e instanceof AgentTargetError) {
        throw new Error(
          e instanceof UnsupportedWindowsShimError
            ? (e as Error).message
            : `agent '${route.agent}' (routed for ${role} on ${taskId}) is not on PATH — ${(e as Error).message}`,
        );
      }
      throw e;
    }
    const template = resolveTabLabelTemplateFromSnapshot(workspaceSnapshot);
    const tabLabel = template
      .replaceAll("{role}", role)
      .replaceAll("{task}", taskId)
      .replaceAll("{agent}", route.agent);
    if (tabLabel.length === 0 || /[\u0000\r\n]/u.test(tabLabel)) {
      throw new Error("naming.tab_label renders to an invalid label");
    }
    const skillPath = fileURLToPath(new URL(`../../../skills/${role}.md`, import.meta.url));
    invocation = buildLaunchInvocation({
      request,
      base_version: baseVersion,
      hub_url: parsed.url,
      route,
      route_source: resolved.source,
      context: executionContext,
      naming: { tab_label: tabLabel, pane_label: rigLabel(`${taskId}.${role}`, executionContext.hubRoot) },
      prompt: `轮到你了（role: ${role}）：请用 Context Hub 读取任务 ${taskId} 的完整上下文（context.read），按你的 role skill（${skillPath}）开始本轮工作，完成后发布相应记录（context.publish）。`,
      ...(plan.platform === "posix"
        ? { posix_direct: plan.posix_direct }
        : { resolved_target: plan.resolved_target, effective_agent: plan.effective_agent }),
    });
  } catch (e) {
    process.stderr.write(`tut: cannot resolve launch target for ${role} on ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }

  if (launchEnvironment.TUT_DRY_RUN !== "1") {
    try {
      requireBirthAnchor(invocation.context);
    } catch (e) {
      process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
      return 1;
    }
  }

  // Fail closed: the marker must win the optimistic-concurrency race before
  // the launcher is called. A VERSION_CONFLICT therefore cannot cause a
  // second pane prompt.
  try {
    await markLaunched(parsed.url, taskId, role, baseVersion, "start-next", invocation.marker_projection);
  } catch (e) {
    return failWith(e, parsed.url);
  }

  // --fresh is already frozen in the invocation.  The child receives no raw
  // route values, so there is no second parse or route-source drift. Carry
  // the same environment snapshot across the manual boundary as well: a
  // moved TUT_EVENT_PORT_URL must reach delivery give-up escalation.
  const run = await runInternalLaunchInvocation(invocation, { env: launchEnvironment });
  if (run.error !== undefined) {
    process.stderr.write(`tut: cannot run internal launcher ${cliEntryPath()}: ${run.error.message}\n`);
    process.stderr.write("tut: inspect the target pane, this round, and outstanding control calls before any manual retry\n");
    return 1;
  }
  if (run.stdout.length > 0) process.stdout.write(run.stdout.endsWith("\n") ? run.stdout : `${run.stdout}\n`);
  if (run.stderr.length > 0) process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);
  if (run.code !== 0) {
    process.stderr.write(`tut: launcher exited with code ${run.code}\n`);
    process.stderr.write("tut: inspect the target pane, this round, and outstanding control calls before any manual retry\n");
    return 1;
  }
  process.stdout.write(`start-next: launch attempt completed; delivery confirmation is not implied (${role} for ${taskId} via tut launch)\n`);
  return 0;
}

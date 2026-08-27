/**
 * Round-pane lifecycle policy.
 *
 * This module owns the stateful part of a round hand-off, but deliberately
 * does not know how a pane receives a prompt or how an agent command is
 * rendered.  The caller supplies a frozen LaunchInvocation and callbacks for
 * continuation delivery and pane birth.  Keeping the policy here makes the
 * three lifecycle branches testable without rebuilding route, naming, or
 * execution context.
 */

import type { LaunchInvocation } from "../types.js";
import type { HerdrPane } from "./herdr-client.js";

export type LifecyclePane = HerdrPane;

export interface PaneListSnapshot {
  panes: LifecyclePane[];
  usable: boolean;
  error?: string;
}

/** The low-level seam is intentionally small so another Host can replace Herdr. */
export interface LifecycleClient {
  listPanes(): Promise<PaneListSnapshot | readonly LifecyclePane[]>;
  closePane(paneId: string): Promise<unknown>;
}

export interface LifecycleWriters {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface ReapPlan {
  close: LifecyclePane[];
  working: LifecyclePane[];
  keptContinuity: LifecyclePane[];
}

export interface RoundLifecyclePlan {
  branch: "continuation" | "birth";
  continuation?: LifecyclePane;
  reap: ReapPlan;
}

export interface RoundLifecycleResult {
  kind: "continuation" | "birth" | "duplicate" | "failed";
  pane?: LifecyclePane;
  pane_id?: string;
  reason?: string;
  delivered?: boolean;
}

export interface RoundLifecycleOptions extends LifecycleWriters {
  invocation: Pick<LaunchInvocation, "task_id" | "role" | "fresh" | "naming">;
  client: LifecycleClient;
  /** Defaults to the product's executor/reviewer continuity set. */
  continuityRoles?: ReadonlySet<string> | string;
  /** Dry-run still performs discovery, but never closes a pane. */
  dryRun?: boolean;
  onContinuation(pane: LifecyclePane): Promise<boolean>;
  /** Returns undefined when birth failed, and a pane id on success. */
  onBirth(): Promise<string | undefined>;
}

export interface CleanupOptions extends LifecycleWriters {
  task_id: string;
  client: LifecycleClient;
  dryRun?: boolean;
}

export const DEFAULT_CONTINUITY_ROLES = "executor reviewer";

function write(writer: ((text: string) => void) | undefined, fallback: (text: string) => void, text: string): void {
  (writer ?? fallback)(text);
}

function normalizeList(value: PaneListSnapshot | readonly LifecyclePane[]): PaneListSnapshot {
  if (Array.isArray(value)) return { panes: [...value], usable: true };
  const snapshot = value as PaneListSnapshot;
  if (Array.isArray(snapshot.panes)) {
    const error = snapshot.error;
    return {
      panes: [...snapshot.panes],
      usable: snapshot.usable !== false,
      ...(error === undefined ? {} : { error }),
    };
  }
  return { panes: [], usable: false, error: "pane list returned no panes" };
}

async function list(client: LifecycleClient): Promise<PaneListSnapshot> {
  try {
    return normalizeList(await client.listPanes());
  } catch (error) {
    return { panes: [], usable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Parse the space-separated continuity override. An empty string means reap all. */
export function continuityRoleSet(value?: string): Set<string> {
  const raw = value ?? DEFAULT_CONTINUITY_ROLES;
  return new Set(raw.split(/\s+/u).filter((role) => role.length > 0));
}

export function paneIsAlive(pane: Pick<LifecyclePane, "agent_status">): boolean {
  return pane.agent_status === "idle" || pane.agent_status === "working" || pane.agent_status === "blocked";
}

export function taskPaneLabel(taskId: string, role: string): string {
  return `${taskId}.${role}`;
}

export function isTaskPane(taskId: string, label: string | undefined): boolean {
  return typeof label === "string" && label.startsWith(`${taskId}.`);
}

export function roleFromTaskPane(taskId: string, label: string | undefined): string | undefined {
  if (!isTaskPane(taskId, label)) return undefined;
  return label!.slice(taskId.length + 1);
}

export function livePanesForLabel(panes: readonly LifecyclePane[], label: string): LifecyclePane[] {
  return panes.filter((pane) => pane.label === label && paneIsAlive(pane));
}

/**
 * Pure narrowed-reap decision. Working panes are always retained in normal
 * hand-offs; live continuity seats are retained too. Dead seats and all
 * non-continuity, non-working task panes are closed.
 */
export function planReap(
  panes: readonly LifecyclePane[],
  options: {
    task_id: string;
    continuityRoles: ReadonlySet<string>;
    mode?: "reap" | "force";
    onlyRole?: string;
    skipLabel?: string;
  },
): ReapPlan {
  const mode = options.mode ?? "reap";
  const close: LifecyclePane[] = [];
  const working: LifecyclePane[] = [];
  const keptContinuity: LifecyclePane[] = [];
  const prefix = `${options.task_id}.`;

  for (const pane of panes) {
    const label = pane.label;
    if (label === undefined || !label.startsWith(prefix)) continue;
    if (options.onlyRole !== undefined && label !== taskPaneLabel(options.task_id, options.onlyRole)) continue;
    if (mode === "force") {
      close.push(pane);
      continue;
    }
    if (options.skipLabel !== undefined && label === options.skipLabel) continue;
    if (pane.agent_status === "working") {
      working.push(pane);
      continue;
    }
    const role = roleFromTaskPane(options.task_id, label);
    if (role !== undefined && paneIsAlive(pane) && options.continuityRoles.has(role)) {
      keptContinuity.push(pane);
      continue;
    }
    close.push(pane);
  }
  return { close, working, keptContinuity };
}

/** Pure plan for a single inventory snapshot. I/O execution is separate. */
export function planRoundLifecycle(
  panes: readonly LifecyclePane[],
  options: {
    task_id: string;
    role: string;
    pane_label?: string;
    fresh: boolean;
    continuityRoles?: ReadonlySet<string> | string;
  },
): RoundLifecyclePlan {
  const continuity = typeof options.continuityRoles === "string"
    ? continuityRoleSet(options.continuityRoles)
    : options.continuityRoles ?? continuityRoleSet();
  const label = options.pane_label ?? taskPaneLabel(options.task_id, options.role);
  const candidates = livePanesForLabel(panes, label);
  const continuation = candidates[0];
  if (!options.fresh && continuity.has(options.role) && candidates.length === 1 && continuation !== undefined) {
    return { branch: "continuation", continuation, reap: { close: [], working: [], keptContinuity: [] } };
  }
  const reapOptions = {
    task_id: options.task_id,
    continuityRoles: continuity,
    ...(options.fresh ? { skipLabel: label } : {}),
  };
  return {
    branch: "birth",
    reap: planReap(panes, reapOptions),
  };
}

async function closePlanned(
  plan: ReapPlan,
  options: {
    client: LifecycleClient;
    dryRun: boolean;
    stdout: ((text: string) => void) | undefined;
    stderr: ((text: string) => void) | undefined;
  },
): Promise<void> {
  for (const pane of plan.working) {
    write(
      options.stderr,
      (text) => process.stderr.write(text),
      `launch: pane '${pane.label ?? ""}' (${pane.pane_id}) still working — left open for the next lifecycle hook\n`,
    );
  }
  for (const pane of plan.keptContinuity) {
    write(
      options.stderr,
      (text) => process.stderr.write(text),
      `launch: pane '${pane.label ?? ""}' (${pane.pane_id}) is a live continuity work seat — kept for same-role continuation\n`,
    );
  }
  for (const pane of plan.close) {
    if (options.dryRun) {
      write(
        options.stdout,
        (text) => process.stdout.write(text),
        `DRY-RUN: cleanup: herdr pane close ${pane.pane_id} (label '${pane.label ?? ""}')\n`,
      );
      continue;
    }
    try {
      const result = await options.client.closePane(pane.pane_id);
      const failed = typeof result === "object" && result !== null && (
        ("code" in result && (result as { code?: unknown }).code !== 0)
        || ("error" in result && (result as { error?: unknown }).error !== undefined)
      );
      if (failed) {
        write(
          options.stderr,
          (text) => process.stderr.write(text),
          `launch: pane close ${pane.pane_id} (label '${pane.label ?? ""}') failed — continuing\n`,
        );
      }
    } catch {
      write(
        options.stderr,
        (text) => process.stderr.write(text),
        `launch: pane close ${pane.pane_id} (label '${pane.label ?? ""}') failed — continuing\n`,
      );
    }
  }
}

/** Execute continuation/birth lifecycle policy around caller-owned delivery. */
export async function runRoundLifecycle(options: RoundLifecycleOptions): Promise<RoundLifecycleResult> {
  const taskId = options.invocation.task_id;
  const role = options.invocation.role;
  const paneLabel = options.invocation.naming.pane_label;
  const expectedLabel = taskPaneLabel(taskId, role);
  if (paneLabel !== expectedLabel) {
    const reason = `pane label '${paneLabel}' does not match addressing key '${expectedLabel}'`;
    write(options.stderr, (text) => process.stderr.write(text), `launch: ${reason}\n`);
    return { kind: "failed", reason };
  }
  const dryRun = options.dryRun === true;
  const continuity = typeof options.continuityRoles === "string"
    ? continuityRoleSet(options.continuityRoles)
    : options.continuityRoles ?? continuityRoleSet();

  if (!options.invocation.fresh && continuity.has(role)) {
    const snapshot = await list(options.client);
    if (snapshot.usable) {
      const candidates = livePanesForLabel(snapshot.panes, paneLabel);
      if (candidates.length > 1) {
        const first = candidates[0]!;
        write(
          options.stderr,
          (text) => process.stderr.write(text),
          `launch: multiple live panes carry addressing key '${paneLabel}' — refusing ambiguous continuation\n`,
        );
        return { kind: "duplicate", pane: first, reason: "multiple live continuation panes" };
      }
      const existing = candidates[0];
      if (existing !== undefined) {
        write(
          options.stderr,
          (text) => process.stderr.write(text),
          `launch: same-role continuation — delivering to existing pane ${existing.pane_id} (label '${paneLabel}')\n`,
        );
        const delivered = await options.onContinuation(existing);
        return { kind: "continuation", pane: existing, pane_id: existing.pane_id, delivered };
      }
    }
  }

  if (options.invocation.fresh) {
    write(
      options.stderr,
      (text) => process.stderr.write(text),
      `launch: --fresh — force-closing panes labeled '${paneLabel}' (explicit fresh choice, working included)\n`,
    );
    const forced = await list(options.client);
    if (!forced.usable && !dryRun) {
      const reason = forced.error ?? "pane list unavailable";
      write(options.stderr, (text) => process.stderr.write(text), `launch: cannot inspect panes for --fresh: ${reason}\n`);
      return { kind: "failed", reason };
    }
    await closePlanned(
      planReap(forced.panes, { task_id: taskId, continuityRoles: continuity, mode: "force", onlyRole: role }),
      { client: options.client, dryRun, stdout: options.stdout, stderr: options.stderr },
    );
  }

  const reap = await list(options.client);
  if (!reap.usable && !dryRun) {
    const reason = reap.error ?? "pane list unavailable";
    write(options.stderr, (text) => process.stderr.write(text), `launch: cannot inspect panes before birth: ${reason}\n`);
    return { kind: "failed", reason };
  }
  const reapOptions = {
    task_id: taskId,
    continuityRoles: continuity,
    ...(options.invocation.fresh ? { skipLabel: paneLabel } : {}),
  };
  const reapPlan = planReap(reap.panes, reapOptions);
  await closePlanned(reapPlan, { client: options.client, dryRun, stdout: options.stdout, stderr: options.stderr });

  if (!dryRun) {
    const after = await list(options.client);
    if (!after.usable) {
      const reason = after.error ?? "pane list unavailable";
      write(options.stderr, (text) => process.stderr.write(text), `launch: cannot verify pane addressing key '${paneLabel}': ${reason}\n`);
      return { kind: "failed", reason };
    }
    const survivor = livePanesForLabel(after.panes, paneLabel)[0];
    if (survivor !== undefined) {
      write(
        options.stderr,
        (text) => process.stderr.write(text),
        `launch: live pane '${paneLabel}' (${survivor.pane_id}) survived the reap — refusing to birth a second pane under the same label (use --fresh to force-close it)\n`,
      );
      return { kind: "duplicate", pane: survivor, reason: "live addressing-key survivor" };
    }
  }

  const paneId = await options.onBirth();
  if (paneId === undefined) return { kind: "failed", reason: "pane birth failed" };
  return { kind: "birth", pane_id: paneId };
}

/** Cleanup hook: unconditional, best-effort close of a task namespace. */
export async function cleanupTaskPanes(options: CleanupOptions): Promise<void> {
  const snapshot = await list(options.client);
  if (!snapshot.usable) {
    const reason = snapshot.error ?? "pane list unavailable";
    write(
      options.stderr,
      (text) => process.stderr.write(text),
      `launch: cleanup could not inspect task '${options.task_id}' — pane list failed: ${reason}; no panes were closed, check Herdr availability and retry cleanup\n`,
    );
    return;
  }
  const plan = planReap(snapshot.panes, {
    task_id: options.task_id,
    continuityRoles: new Set(),
    mode: "force",
  });
  await closePlanned(plan, {
    client: options.client,
    dryRun: options.dryRun === true,
    stdout: options.stdout,
    stderr: options.stderr,
  });
}

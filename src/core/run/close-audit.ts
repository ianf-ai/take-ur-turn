/**
 * Close-stop audit: the consumer-side audit note appended to
 * the CLOSED task after the Notifier's closeTask consumed decision(close) by
 * stopping the owned run. The stop itself is the run protocol's cooperative protocol; this
 * module only RECORDS what actually happened — success, incompleteness, or
 * failure — and never fabricates a stop.
 *
 * Record shape: role=human, agent=tut, content_type=note, ref_version → the
 * version of the effective decision(close) (confirmed from the log, never the
 * task's latest version which may include later notes). The body states
 * explicitly that this is a system operation audit, not a human
 * authorization/decision/ack/launch. A note in a closed task neither
 * transitions state nor wakes anything (closed is absorbing; waiting_for
 * stays "none").
 *
 * Dedup: audit_id is a stable function of (close version, run/attempt), and
 * the publisher checks the task log for an existing identical audit_id before
 * appending — a double observation of the same close must not double-stop nor
 * double-audit. Hub failures are best-effort: logged locally, never retried
 * blind, and never roll back the decision or the stop result.
 */
import { hubPublish } from "../hub/hub-client.js";
import type { ContextRecord } from "../common/types.js";
import type { RunMeta } from "./store.js";

export const CLOSE_STOP_OPERATION = "close-stop";

export interface CloseStopAuditStop {
  requested: boolean;
  success: boolean;
  /** One-line stop outcome string (from stopRun's StopResult / meta). */
  result: string;
  request_id?: string;
  requested_at?: string;
  completed_at?: string;
  phase?: string;
  outcome?: string;
}

export interface CloseStopAuditInput {
  task_id: string;
  /** Version of the effective decision(close) record, when confirmed. */
  close_version?: number;
  run?: { run_id: string; attempt_id?: string };
  /** The final run meta, when a run was observed. */
  meta?: RunMeta;
  stop?: CloseStopAuditStop;
  /** Honest failure detail (stop threw / startup unconfirmed / …). */
  failure?: string;
}

/** Stable association: the close version plus the run (or bare attempt). */
export function closeStopAuditId(input: Pick<CloseStopAuditInput, "close_version" | "run">): string {
  const target = input.run?.run_id ?? (input.run?.attempt_id !== undefined ? `attempt:${input.run.attempt_id}` : "no-run");
  return `${CLOSE_STOP_OPERATION}:v${input.close_version ?? "unknown"}:${target}`;
}

/** The audit record payload — additive, machine-readable fields up front. */
export function closeStopAuditPayload(input: CloseStopAuditInput): {
  summary: string;
  body: string;
  [key: string]: unknown;
} {
  const auditId = closeStopAuditId(input);
  const meta = input.meta;
  const stop = input.stop;
  const windows = meta?.control_protocol === 'windows-console-v1';
  const scope = windows ? 'root-and-owned-job' : 'root-and-original-group';
  const descendants = windows ? 'job-members-only' : 'not-performed';
  const lines = [
    "System stop audit recorded by tut after consuming decision(close): the owned run was stopped through the existing cooperative stop protocol.",
    "This is an operation audit, not a human authorization, decision, ack, or launch; it does not reopen or advance the task.",
    "",
    `task_id=${input.task_id}`,
    `close_version=${input.close_version ?? "unconfirmed"}`,
  ];
  if (input.run !== undefined) {
    lines.push(`run_id=${input.run.run_id}`);
    if (input.run.attempt_id !== undefined) lines.push(`attempt_id=${input.run.attempt_id}`);
  }
  if (meta !== undefined) {
    lines.push(`pid=${meta.pid}`, `pgid=${meta.pgid}`);
    if (meta.exit_code !== undefined) lines.push(`exit_code=${meta.exit_code}`);
    if (meta.exit_signal !== undefined) lines.push(`exit_signal=${meta.exit_signal}`);
  }
  if (stop !== undefined) {
    lines.push(
      `stop_requested=${stop.requested}`,
      `stop_success=${stop.success}`,
      `stop_result=${stop.result}`,
    );
    if (stop.request_id !== undefined) lines.push(`stop_request_id=${stop.request_id}`);
    if (stop.requested_at !== undefined) lines.push(`stop_requested_at=${stop.requested_at}`);
    if (stop.completed_at !== undefined) lines.push(`stop_completed_at=${stop.completed_at}`);
    if (stop.phase !== undefined) lines.push(`stop_phase=${stop.phase}`);
    if (stop.outcome !== undefined) lines.push(`stop_outcome=${stop.outcome}`);
  }
  if (input.failure !== undefined) lines.push(`failure=${input.failure}`);
  lines.push(`scope=${scope}`, `descendants_check=${descendants}`);
  return {
    summary: `close-stop audit${input.run !== undefined ? `: run ${input.run.run_id}` : ""}${input.stop !== undefined ? (input.stop.success ? " (stopped)" : " (unconfirmed)") : ""}`,
    body: lines.join("\n"),
    operation: CLOSE_STOP_OPERATION,
    audit_id: auditId,
    task_id: input.task_id,
    ...(input.close_version !== undefined ? { close_version: input.close_version } : {}),
    ...(input.run?.run_id !== undefined ? { run_id: input.run.run_id } : {}),
    ...(input.run?.attempt_id !== undefined ? { attempt_id: input.run.attempt_id } : {}),
    ...(meta !== undefined ? { pid: meta.pid, pgid: meta.pgid } : {}),
    ...(meta?.exit_code !== undefined ? { exit_code: meta.exit_code } : {}),
    ...(meta?.exit_signal !== undefined ? { exit_signal: meta.exit_signal } : {}),
    ...(stop !== undefined
      ? {
          stop_requested: stop.requested,
          stop_success: stop.success,
          stop_result: stop.result,
          ...(stop.request_id !== undefined ? { stop_request_id: stop.request_id } : {}),
          ...(stop.requested_at !== undefined ? { stop_requested_at: stop.requested_at } : {}),
          ...(stop.completed_at !== undefined ? { stop_completed_at: stop.completed_at } : {}),
          ...(stop.phase !== undefined ? { stop_phase: stop.phase } : {}),
          ...(stop.outcome !== undefined ? { stop_outcome: stop.outcome } : {}),
        }
      : {}),
    ...(input.failure !== undefined ? { failure: input.failure } : {}),
    scope,
    descendants_check: descendants,
  };
}

/** True when the log already carries this audit (double-observation dedup). */
export function hasCloseStopAudit(records: readonly ContextRecord[], auditId: string): boolean {
  return records.some(
    (record) =>
      record.role === "human" &&
      record.content_type === "note" &&
      (record.payload as { operation?: unknown }).operation === CLOSE_STOP_OPERATION &&
      (record.payload as { audit_id?: unknown }).audit_id === auditId,
  );
}

/** The version of the decision(close) that transitioned the task INTO
 *  closed — the FIRST close record (closed is absorbing and close is valid
 *  from any state, so every later close is an idempotent re-decision that
 *  caused no transition). Later closes must never displace the effective
 *  one: audit_id/ref_version pin the causal stop. */
export function effectiveCloseDecisionVersion(records: readonly ContextRecord[]): number | undefined {
  let version: number | undefined;
  for (const record of records) {
    if (record.content_type === "decision" && (record.payload as { decision?: unknown }).decision === "close") {
      version = version === undefined ? record.version : Math.min(version, record.version);
    }
  }
  return version;
}

/** @deprecated Use effectiveCloseDecisionVersion — kept temporarily for
 *  source compatibility; returns the LATEST close, which is wrong for audit
 *  causality when repeated closes exist. */
export function latestCloseDecisionVersion(records: readonly ContextRecord[]): number | undefined {
  let version: number | undefined;
  for (const record of records) {
    if (record.content_type === "decision" && (record.payload as { decision?: unknown }).decision === "close") {
      version = Math.max(version ?? 0, record.version);
    }
  }
  return version;
}

export interface CloseStopPublishDeps {
  /** Publishes the note (injectable; default = one-shot hubPublish). */
  publish?: typeof hubPublish;
}

/** Append the audit note to the closed task. Throws on Hub failure — the
 *  caller decides how to surface it (one log line, never a blind retry). */
export async function publishCloseStopAudit(
  hubUrl: string,
  input: CloseStopAuditInput,
  records: readonly ContextRecord[],
  deps: CloseStopPublishDeps = {},
): Promise<{ skipped: true } | { skipped: false; version: number }> {
  const auditId = closeStopAuditId(input);
  if (hasCloseStopAudit(records, auditId)) return { skipped: true };
  const publish = deps.publish ?? hubPublish;
  const result = await publish(hubUrl, {
    task_id: input.task_id,
    role: "human",
    content_type: "note",
    // agent=tut marks the system writer without impersonating a human author.
    agent: "tut",
    payload: {
      ...closeStopAuditPayload(input),
      ...(input.close_version !== undefined ? { ref_version: input.close_version } : {}),
    },
  });
  return { skipped: false, version: result.version };
}

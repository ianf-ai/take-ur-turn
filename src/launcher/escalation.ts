/** Best-effort delivery escalation. Exit zero does not confirm consumption. */
import type { DeliveryEvidenceV2 } from "./delivery.js";
import { DEFAULT_NOTIFIER_EVENT_URL } from "../hub/rig-discovery.js";

/** Historical input-box diagnostics; never authorize manual submission. */
export type GiveUpBoxEvidence = "held" | "cleared" | "unknown";

/** Historical relay values accepted only for old event parsing. */
export type GiveUpProbeEvidence = "observed" | "failed" | "unavailable" | "not-attempted";

/** Legacy event evidence retained for compatibility only. */
export interface GiveUpEvidence {
  box: GiveUpBoxEvidence;
  transport: boolean;
  probe?: GiveUpProbeEvidence;
}

/** Historical box arguments are accepted but never authorize an Enter. */
export function giveUpGuidance(_box?: GiveUpBoxEvidence): string {
  return "delivery unconfirmed; inspect the target pane. Press Enter manually once only after confirming the target is still the expected Agent, the prompt remains in the input box, and no control calls are outstanding; if the box is empty or work has started, inspect this round first — do not press Enter blindly or automatically resend";
}

const transportFaults = new Set(["INVALID_ARGUMENT", "NOT_STARTED", "SPAWN_FAILED", "EXIT_ERROR", "SIGNAL", "TIMEOUT", "ABORTED", "INVALID_ACK", "INTERNAL"]);
const readFaults = new Set([...transportFaults, "INVALID_JSON", "INVALID_SHAPE", "PANE_MISSING", "PANE_DUPLICATE", "IDENTITY_CHANGED", "STATUS_MISSING", "STATUS_INVALID", "LATE_RESULT", "WRONG_SEQUENCE"]);
const reasons = new Set(["text-uncertain", "enter-not-sent", "enter-uncertain", "identity-invalid", "baseline-working", "baseline-unknown", "attribution-unavailable", "status-unavailable", "deadline", "cancelled"]);
const statuses = new Set(["idle", "working", "blocked", "done", "unknown"]);
const member = (set: Set<string>, value: unknown): boolean => typeof value === "string" && set.has(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Validate the optional block atomically; malformed additions do not reject an event. */
export function parseDeliveryV2(value: unknown): DeliveryEvidenceV2 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.schema !== 2 || typeof v.attempt_id !== "string" || !v.attempt_id.trim() ||
      typeof v.pane_id !== "string" || !v.pane_id.trim() || !member(reasons, v.reason) ||
      !member(statuses, v.status_before) || !member(statuses, v.status_last) ||
      !(v.status_error === null || member(readFaults, v.status_error)) || typeof v.status_flip !== "boolean" ||
      v.submit_confirmed !== false || v.attribution !== "unavailable" || (v.text_calls !== 0 && v.text_calls !== 1) ||
      (v.enter_calls !== 0 && v.enter_calls !== 1) || !nonnegative(v.budget_ms) || !nonnegative(v.total_elapsed_ms) ||
      !(v.last_query_sequence === null || (typeof v.last_query_sequence === "number" && Number.isSafeInteger(v.last_query_sequence) && v.last_query_sequence > 0)) ||
      v.detector_source !== null || v.detector_age_ms !== null || v.server_epoch !== null || v.agent_generation !== null) return undefined;
  if (v.baseline_wait !== undefined) {
    const wait = v.baseline_wait as Record<string, unknown> | null;
    if (!wait || typeof wait !== 'object' || Array.isArray(wait) ||
        !nonnegative(wait.budget_ms) || !nonnegative(wait.elapsed_ms)) return undefined;
  }
  if (v.text_calls === 0) {
    if (v.text_transport !== 'not-sent' || v.text_error !== null || v.enter_calls !== 0 || v.status_flip ||
        !['baseline-unknown', 'identity-invalid', 'cancelled', 'deadline'].includes(String(v.reason))) return undefined;
  } else if (v.reason === "text-uncertain") {
    if (v.text_transport !== "uncertain" || !member(transportFaults, v.text_error) || v.enter_calls !== 0) return undefined;
  } else if (v.text_transport !== "sent" || v.text_error !== null) return undefined;
  if (v.enter_calls === 0) {
    if (v.enter_transport !== "not-attempted" || v.enter_error !== null || v.elapsed_ms !== null) return undefined;
  } else {
    if (!nonnegative(v.elapsed_ms)) return undefined;
    if (v.enter_transport === "sent") {
      if (v.enter_error !== null) return undefined;
    } else if ((v.enter_transport !== "not-sent" && v.enter_transport !== "uncertain") || !member(transportFaults, v.enter_error)) return undefined;
  }
  if (v.status_flip && (!(v.status_before === "idle" || v.status_before === "blocked" || v.status_before === "done") ||
      v.status_last !== "working" || v.enter_transport !== "sent" || v.status_error !== null ||
      !nonnegative(v.elapsed_ms) || v.elapsed_ms >= v.budget_ms)) return undefined;
  if (v.reason === "attribution-unavailable" && !v.status_flip) return undefined;
  return v as unknown as DeliveryEvidenceV2;
}

/** The event emitted when a delivery attempt remains unconfirmed. */
export const DELIVERY_GIVEUP_EVENT = "delivery_giveup" as const;

const DEFAULT_EVENT_URL = DEFAULT_NOTIFIER_EVENT_URL;
const ESCALATION_TIMEOUT_MS = 2000;

/** Same resolution rule as on-agent-event.mjs: env override, else default. */
export function eventPortUrlOf(environment: NodeJS.ProcessEnv): string {
  const configured = environment.TUT_EVENT_PORT_URL;
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_EVENT_URL;
}

export type EscalationDispatch = "sent" | "failed";

/**
 * One best-effort agent-event POST.  Connection failures, timeouts and
 * non-2xx replies resolve to "failed" (diagnosed by the caller); only a
 * programming error of the injected fetch seam can throw.
 */
export async function postAgentEvent(
  evt: { event: string; agent: string; pane: string } & Partial<GiveUpEvidence> & { delivery_v2?: DeliveryEvidenceV2 },
  url: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<EscalationDispatch> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? ESCALATION_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
      signal: controller.signal,
    });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivery give-up escalation: the launcher's voice on the Notifier's event
 * port (system-design 7.2.1 step 5, consumed by 6.1).  When the bounded
 * submit-retry window exhausts, the round prompt sits unconsumed in the
 * pane's input box and the agent never started; the launcher still exits 0
 * (a failure exit would re-trigger duplicate delivery), so without this
 * event the only immediate trace is the stderr diagnostics line forwarded
 * to the notify pane — nobody outside the machine learns until the 30-minute
 * stall watchdog fires.
 *
 * Transport mirrors scripts/on-agent-event.mjs (the canonical signal-source
 * entry): POST {event, agent, pane} as JSON with a 2s AbortController
 * timeout; URL resolution is TUT_EVENT_PORT_URL (non-empty override) over
 * the http://127.0.0.1:3002/agent-event default.  The body ADDITIVELY
 * carries the give-up evidence (box / transport / probe — the same triple
 * the give-up diag line reports): the event vocabulary is frozen, additive
 * fields are the documented integration path (7.2.1 step 5), so older
 * consumers still validate the three base fields.  Best-effort, never
 * throws: a lost escalation degrades to the existing stderr diagnostics +
 * stall watchdog, never to a changed delivery outcome.
 */

/** Last input-box observation carried by the give-up event (7.2.1
 *  three-state discipline): only box=held may claim the prompt still sits
 *  in the composer. */
export type GiveUpBoxEvidence = "held" | "cleared" | "unknown";

/** Relay visibility for the last Enter (diagnostic only — never a submit
 *  confirmation). */
export type GiveUpProbeEvidence = "observed" | "failed" | "unavailable";

/**
 * Evidence fields on a delivery_giveup event body.  `box` is the last
 * input-box observation, `transport` the last Enter control call's
 * outcome; `probe` is optional — legacy payloads and producers without a
 * relay omit it, and consumers must degrade conservatively on ANY missing
 * field (box evidence unknown → inspect the pane first).
 */
export interface GiveUpEvidence {
  box: GiveUpBoxEvidence;
  transport: boolean;
  probe?: GiveUpProbeEvidence;
}

/**
 * The three-state actionable guidance, word for word THE contract shared
 * by the launcher's give-up stderr and the notifier's alert copy (7.2.1
 * step 5): only box=held may direct a manual Enter; cleared means the
 * text left the box but the submit is unconfirmed — the round may
 * already have started, never a blind Enter; unknown degrades to the
 * conservative inspect-the-pane hint.  Callers add their own truthful,
 * source-specific diagnostic prefixes around these strings (the launcher
 * knows WHY a reading failed, the notifier only knows evidence is
 * absent); the guidance itself lives here so the two channels cannot
 * drift.
 */
export function giveUpGuidance(box: GiveUpBoxEvidence): string {
  if (box === "held") {
    return "the prompt is still visible in the input box; press Enter there manually to start the round";
  }
  if (box === "cleared") {
    return "the text has left the input box but the submit is unconfirmed; check whether the round has already started before pressing anything — do not press Enter blindly";
  }
  return "inspect the pane and press Enter there manually only if the prompt is still visible in the input box";
}

/** The event emitted when a delivery's submit-retry window exhausts. */
export const DELIVERY_GIVEUP_EVENT = "delivery_giveup" as const;

const DEFAULT_EVENT_URL = "http://127.0.0.1:3002/agent-event";
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
  evt: { event: string; agent: string; pane: string } & GiveUpEvidence,
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

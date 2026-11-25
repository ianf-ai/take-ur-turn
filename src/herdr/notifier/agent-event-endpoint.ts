/** Decode the legacy raw hook at the Herdr boundary, retaining atomic evidence rules. */
import { parseDeliveryV2 } from '../launcher/escalation.js';
import type { AgentEvent } from './contracts.js';
import type { AgentEventEndpoint } from '../../core/notifier/shared-contracts.js';

export function createAgentEventEndpoint(receiveEvent: (event: AgentEvent) => void, log: (line: string) => void): AgentEventEndpoint {
  return {
    accept(parsed) {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: 400, body: { error: "invalid event shape" } };
      }
      const evt = parsed as {
        event?: unknown;
        agent?: unknown;
        pane?: unknown;
        delivery_v2?: unknown;
        box?: unknown;
        transport?: unknown;
        probe?: unknown;
      };
      if (typeof evt.event !== "string" || typeof evt.agent !== "string" || typeof evt.pane !== "string") {
        log("ignoring event with invalid shape (need string event/agent/pane)");
        return { status: 400, body: { error: "invalid event shape" } };
      }
      if (evt.event !== "working" && evt.event !== "blocked" && evt.event !== "done" && evt.event !== "delivery_giveup") {
        log(`ignoring unknown event: ${evt.event}`);
        return { status: 200, body: { ok: true, ignored: true } };
      }
      // Preserve well-typed legacy diagnostics without using them as guidance.
      const box = evt.box;
      const transport = evt.transport;
      const atomic = (box === "held" || box === "cleared" || box === "unknown") && typeof transport === "boolean";
      const probe =
        evt.probe === "observed" ||
          evt.probe === "failed" ||
          evt.probe === "unavailable" ||
          evt.probe === "not-attempted"
          ? evt.probe
          : undefined;
      const deliveryV2 = parseDeliveryV2(evt.delivery_v2);
      receiveEvent({
        ...(deliveryV2 === undefined ? {} : { delivery_v2: deliveryV2 }),
        event: evt.event,
        agent: evt.agent,
        pane: evt.pane,
        ...(atomic ? { box } : {}),
        ...(atomic ? { transport } : {}),
        ...(probe === undefined ? {} : { probe }),
      });
      return { status: 200, body: { ok: true } };
    },
  };
}

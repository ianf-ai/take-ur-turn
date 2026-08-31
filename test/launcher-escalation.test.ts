// Unit coverage for the delivery give-up escalation module (7.2.1): URL
// resolution shares the on-agent-event.mjs rule, the POST is best-effort,
// and the body is the three-field JSON the event endpoint validates PLUS
// the additive give-up evidence (box/transport, probe optional) — the
// documented integration path for a frozen event vocabulary.
import { describe, expect, it } from "vitest";
import {
  DELIVERY_GIVEUP_EVENT,
  eventPortUrlOf,
  giveUpGuidance,
  postAgentEvent,
  type GiveUpEvidence,
} from "../src/launcher/escalation.js";

describe("event port URL resolution", () => {
  it("defaults to the local notifier event endpoint", () => {
    expect(eventPortUrlOf({})).toBe("http://127.0.0.1:3002/agent-event");
  });
  it("TUT_EVENT_PORT_URL (non-empty) overrides; empty string falls back to the default", () => {
    expect(eventPortUrlOf({ TUT_EVENT_PORT_URL: "http://127.0.0.1:4711/agent-event" })).toBe(
      "http://127.0.0.1:4711/agent-event",
    );
    expect(eventPortUrlOf({ TUT_EVENT_PORT_URL: "" })).toBe("http://127.0.0.1:3002/agent-event");
  });
});

// The three-state guidance is THE word-for-word contract shared by the
// launcher's give-up stderr and the notifier's alert copy (7.2.1 step 5).
// Full-string equality pins each text: any wording change must land HERE
// and is then immediately visible to both channels — no independent
// near-copies on either side (review R2 P2).
describe("giveUpGuidance single source (word-for-word three-state contract)", () => {
  it("held — the only state that may direct a manual Enter", () => {
    expect(giveUpGuidance("held")).toBe(
      "the prompt is still visible in the input box; press Enter there manually to start the round",
    );
  });

  it("cleared — submit unconfirmed, never a blind Enter", () => {
    expect(giveUpGuidance("cleared")).toBe(
      "the text has left the input box but the submit is unconfirmed; check whether the round has already started before pressing anything — do not press Enter blindly",
    );
  });

  it("unknown — conservative inspect-the-pane hint", () => {
    expect(giveUpGuidance("unknown")).toBe(
      "inspect the pane and press Enter there manually only if the prompt is still visible in the input box",
    );
  });
});

describe("postAgentEvent", () => {
  const EVT = {
    event: DELIVERY_GIVEUP_EVENT,
    agent: "pi",
    pane: "t1.executor",
    box: "held",
    transport: true,
    probe: "observed",
  } as const;

  it("POSTs the event JSON with evidence fields and reports sent on 2xx", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const dispatch = await postAgentEvent(EVT, "http://127.0.0.1:3999/agent-event", {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      },
    });
    expect(dispatch).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3999/agent-event");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe(JSON.stringify(EVT));
  });

  it("omits the optional probe field when absent (additive body, legacy consumers still validate)", async () => {
    const evidence: GiveUpEvidence = { box: "unknown", transport: false };
    const calls: { init: RequestInit }[] = [];
    await postAgentEvent(
      { event: DELIVERY_GIVEUP_EVENT, agent: "pi", pane: "t1.executor", ...evidence },
      "http://127.0.0.1:3999/agent-event",
      {
        fetchImpl: async (_url, init) => {
          calls.push({ init: init ?? {} });
          return new Response("{}", { status: 200 });
        },
      },
    );
    expect(calls[0]!.init.body).toBe(
      JSON.stringify({ event: DELIVERY_GIVEUP_EVENT, agent: "pi", pane: "t1.executor", box: "unknown", transport: false }),
    );
  });

  it("reports failed on a non-2xx response (diagnosed by the caller, never thrown)", async () => {
    const dispatch = await postAgentEvent(EVT, "http://127.0.0.1:3999/agent-event", {
      fetchImpl: async () => new Response("{}", { status: 500 }),
    });
    expect(dispatch).toBe("failed");
  });

  it("reports failed when the transport rejects (connection refused etc.)", async () => {
    const dispatch = await postAgentEvent(EVT, "http://127.0.0.1:3999/agent-event", {
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(dispatch).toBe("failed");
  });

  it("aborts via the controller when the endpoint never answers (timeout wiring)", async () => {
    const dispatch = await postAgentEvent(EVT, "http://127.0.0.1:3999/agent-event", {
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }),
    });
    expect(dispatch).toBe("failed");
  });
});

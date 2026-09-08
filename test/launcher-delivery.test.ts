// Unit coverage for the ported delivery loop and its dual-sink diagnostics
// (launcher port unit 5, plus the shared-submit-budget / evidence-layering
// rework). The named behaviors from the design's must-cover list are tested
// here against injectable seams — including a virtual clock whose time is
// consumed by sleeps AND control calls alike, which is how the ONE-deadline
// property is pinned. The launch.sh fixture regressions
// (test/cli-assign-launch.test.ts, test/launcher-fresh.test.ts) remain the
// end-to-end authority.
import { describe, expect, it } from "vitest";
import {
  boxEvidenceOf,
  boxHoldsText,
  createDelivery,
  createDeliveryDiagnostics,
  DELIVERY_LOG_MAX_BYTES,
  deliveryProbeCommand,
  deliveryProbeMarker,
  diagEnabled,
  diagTail,
  LANDING_FRAGMENT_MAX,
  landingFragment,
  newLandingInstance,
  parseDeliveryKnobs,
  promptLandingFragments,
  screenBottom,
  withoutDeliveryProbe,
  type DeliveryClient,
  type DeliveryDiagnostics,
  type DiagnosticsFs,
} from "../src/launcher/delivery.js";
import { createDeliveryClient } from "../src/launcher/compat.js";
import type { GiveUpEvidence } from "../src/launcher/escalation.js";
import { giveUpGuidance } from "../src/launcher/escalation.js";

// ---- harness -------------------------------------------------------------------

/** Fast knobs: 1ms poll so every window is an exact poll count. */
const FAST = {
  TUT_DELIVERY_NONCE: "A1B2C3D4",
  TUT_READY_POLL_MS: "1",
  TUT_READY_FLOOR_MS: "0",
  TUT_READY_TIMEOUT_MS: "10",
  TUT_TEXT_LAND_TIMEOUT_MS: "4",
  TUT_SUBMIT_TIMEOUT_MS: "2",
  TUT_SUBMIT_RETRY_MS: "2",
  TUT_SUBMIT_RETRY_TIMEOUT_MS: "8",
};

/**
 * Virtual monotonic clock. Sleeps advance it; tests may also hand it to the
 * fake client so every control call burns time too — the submit budget then
 * has to fit BOTH, which is exactly the property the shared-deadline design
 * claims.
 */
function virtualClock(start = 0) {
  let t = start;
  const sleeps: Array<{ at: number; ms: number }> = [];
  return {
    now: (): number => t,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push({ at: t, ms });
      t += ms;
    },
    advance: (ms: number): void => {
      t += ms;
    },
    time: (): number => t,
    sleeps: (): Array<{ at: number; ms: number }> => sleeps,
  };
}
type VirtualClock = ReturnType<typeof virtualClock>;

/**
 * Fake delivery client with the fixture's causal screen model: pre-text
 * reads (gate baseline + polls, or the continuation snapshot) serve `pre`
 * in order (last repeats); post-text reads are indexed by ENTER COUNT
 * (`post[enters]`, last repeats) — independent of poll cadence. An out-of-band
 * probe is consumed by the one read immediately after its request and can be
 * made to succeed/fail independently of the screen timeline. With a virtual
 * clock every control call records its START time and burns `costMs`.
 */
function fakeClient(options: {
  pre: string[];
  post?: string[];
  /** Adversarial fixture: post-text reads consume this list sequentially
   *  (last repeats), fully decoupled from Enter count — the screen keeps
   *  changing while Enters are never consumed by the receiver. */
  postReads?: string[];
  failSendText?: boolean;
  failSendKeys?: boolean;
  probeResults?: boolean[];
  /** Per-request relay dispatch override — "failed"/"unavailable" requests
   *  never went out, so no probe read follows them. */
  probeDispatch?: Array<import("../src/launcher/delivery.js").DeliveryProbeDispatch>;
  clock?: VirtualClock;
  /** Uniform cost per control call. */
  costMs?: number;
  /** Per-kind cost override — lets a single call (e.g. the first Enter)
   *  consume the whole budget. */
  costs?: Partial<Record<"read" | "send-text" | "send-probe" | "send-keys", number>>;
}): {
  client: DeliveryClient;
  calls: string[];
  enters: () => number;
  timed: () => Array<{ at: number; call: string }>;
} {
  const calls: string[] = [];
  const timed: Array<{ at: number; call: string }> = [];
  const spend = (kind: string, call: string): void => {
    if (options.clock === undefined) return;
    timed.push({ at: options.clock.time(), call });
    options.clock.advance(options.costs?.[kind as "read" | "send-text" | "send-probe" | "send-keys"] ?? options.costMs ?? 0);
  };
  let preIdx = 0;
  let postReadIdx = 0;
  let enters = 0;
  let textSent = false;
  let probeCount = 0;
  let pendingProbe: { marker: string; echo: boolean } | undefined;
  const client: DeliveryClient = {
    readPane: async () => {
      spend("read", "read");
      calls.push("read");
      if (!textSent) {
        const screen = options.pre[Math.min(preIdx, options.pre.length - 1)] ?? "";
        preIdx += 1;
        return screen;
      }
      let screen: string;
      if (options.postReads !== undefined) {
        screen = options.postReads[Math.min(postReadIdx, options.postReads.length - 1)] ?? "";
        postReadIdx += 1;
      } else {
        screen = options.post?.[Math.min(enters, (options.post ?? [""]).length - 1)] ?? "";
      }
      if (pendingProbe === undefined) return screen;
      const probe = pendingProbe;
      pendingProbe = undefined;
      return probe.echo ? `${screen}\n${probe.marker}` : screen;
    },
    sendText: async (_paneId, text) => {
      spend("send-text", "send-text");
      calls.push(`send-text prompt len=${text.length}`);
      textSent = true;
      return options.failSendText !== true;
    },
    sendProbe: async (_paneId, marker) => {
      spend("send-probe", "send-probe");
      probeCount += 1;
      const dispatch = options.probeDispatch?.[probeCount - 1] ?? "sent";
      calls.push(`send-probe marker=${marker}`);
      if (dispatch !== "sent") return dispatch;
      const result = options.probeResults?.[probeCount - 1] ?? true;
      pendingProbe = { marker, echo: result };
      return "sent";
    },
    sendKeys: async (_paneId, key) => {
      spend("send-keys", `send-keys ${key}`);
      calls.push(`send-keys ${key}`);
      enters += 1;
      return options.failSendKeys !== true;
    },
  };
  return { client, calls, enters: () => enters, timed: () => timed };
}

/**
 * Collect the diagnostics lines via the real dual-sink observer (stderr
 * only): lines keep the full `tut-delivery t=<vt> …` shape so tests can
 * pin virtual-time stamps of individual events.
 */
function lineSink(clock: () => number = () => 0): { diagnostics: DeliveryDiagnostics; lines: () => string[] } {
  const lines: string[] = [];
  const diagnostics = createDeliveryDiagnostics({
    env: {},
    stderr: (text) => lines.push(text.replace(/\n$/u, "")),
    clock,
    fs: { isDirectory: () => false, mkdir: async () => undefined, append: async () => undefined, size: async () => -1, rename: async () => undefined },
  });
  return { diagnostics, lines: () => lines };
}

function harness(
  fake: ReturnType<typeof fakeClient>,
  env: NodeJS.ProcessEnv = {},
  onGiveUp?: (paneId: string, evidence: GiveUpEvidence) => Promise<void> | void,
  clock: VirtualClock = virtualClock(),
): {
  delivery: ReturnType<typeof createDelivery>;
  diagnostics: DeliveryDiagnostics;
  lines: () => string[];
  errors: () => string[];
  vt: VirtualClock;
} {
  const vt = clock;
  const sink = lineSink(vt.now);
  const errors: string[] = [];
  return {
    diagnostics: sink.diagnostics,
    lines: sink.lines,
    errors: () => errors,
    vt,
    delivery: createDelivery({
      client: fake.client,
      diagnostics: sink.diagnostics,
      env: { ...FAST, ...env },
      clock: vt.now,
      delayFn: vt.sleep,
      stderr: (text) => errors.push(text),
      ...(onGiveUp !== undefined ? { onGiveUp } : {}),
    }),
  };
}

const fields = (lines: string[]): string[] => lines.map((line) => line.replace(/^tut-delivery t=\d+ /u, ""));
/** Virtual-time stamp of the first diagnostics line containing `needle`. */
const tOf = (lines: string[], needle: string): number =>
  Number(lines.find((line) => line.includes(needle))?.match(/^tut-delivery t=(\d+) /u)?.[1] ?? Number.NaN);
const promptSends = (calls: string[]): string[] => calls.filter((call) => call.startsWith("send-text prompt"));
const probeSends = (calls: string[]): string[] => calls.filter((call) => call.startsWith("send-probe"));
const normalizeMarkers = (lines: string[]): string[] => lines.map((line) => line.replace(/TUT-DELIVERY-PROBE-[0-9A-F]{8}/gu, "TUT-DELIVERY-PROBE-<random>"));

// ---- pure helpers ---------------------------------------------------------------

describe("delivery screen helpers", () => {
  it("screenBottom takes the last non-empty lines with trailing whitespace trimmed", () => {
    expect(screenBottom("a\nb\nc\nd  \n\ne\n", 3)).toBe("c\nd\ne");
    expect(screenBottom("  x \ty\r\n", 3)).toBe("  x \ty");
    expect(screenBottom("", 3)).toBe("");
    // Whitespace-only lines drop out entirely (the awk NF rule).
    expect(screenBottom("a\n   \nb", 3)).toBe("a\nb");
  });

  it("box evidence: the SAME bottom-suffix rule as landing decides held vs cleared — an empty read is unknown", () => {
    const frags = promptLandingFragments("hello （tut delivery A1B2C3D4）");
    // Held: a sent fragment (whitespace-normalized) ends the last row — or
    // the join of the last two (wrap healing).
    expect(boxHoldsText("ui ▎hello （tut delivery A1B2C3D4）", frags)).toBe(true);
    expect(boxHoldsText("ui ▎hel\n    lo （tut delivery A1B2C3D4）", frags)).toBe(true);
    // Cleared: non-empty screen whose final rows no longer end with any
    // fragment — even when a transcript echo of the text sits ABOVE the
    // composer chrome.
    expect(boxHoldsText("hello （tut delivery A1B2C3D4） (echo)\n›\n? help", frags)).toBe(false);
    expect(boxHoldsText("working", frags)).toBe(false);
    // Repaints above the 3-line region do not matter either way; the text
    // at the bottom edge is the only evidence.
    expect(boxHoldsText("repaint\nx\ny\nz ▎hello （tut delivery A1B2C3D4）", frags)).toBe(true);
    // An empty read is a glitch: never held, and the three-state derivation
    // reports unknown.
    expect(boxHoldsText("", frags)).toBe(false);
    expect(boxEvidenceOf("", frags)).toBe("unknown");
    expect(boxEvidenceOf("ui ▎hello （tut delivery A1B2C3D4）", frags)).toBe("held");
    expect(boxEvidenceOf("working", frags)).toBe("cleared");
  });

  it("a repaint that changes the bottom region while the text still ENDS the final rows is HELD, not cleared", () => {
    // The live false-confirm: a startup banner redraw flipped the bottom
    // region within 547ms of the Enter — the old region-diff criterion said
    // cleared; the suffix rule keeps the text provably in the composer.
    const frags = promptLandingFragments("hello （tut delivery A1B2C3D4）");
    const withText = "pi loading…\n▎hello （tut delivery A1B2C3D4）";
    const repainted = "[Context] loaded 42 files…\n▎hello （tut delivery A1B2C3D4）";
    expect(screenBottom(repainted, 3)).not.toBe(screenBottom(withText, 3)); // the old criterion WOULD clear
    expect(boxEvidenceOf(repainted, frags)).toBe("held"); // the suffix rule refuses
  });

  it("landing fragments: head of the first non-empty line, tail of the last, bounded, whitespace-only prompts yield none", () => {
    expect(promptLandingFragments("hello")).toEqual(["hello"]);
    expect(promptLandingFragments("  first line  \n\n   \nlast line\n")).toEqual(["first line", "last line"]);
    // A long single line yields BOTH ends (either may survive scrolling);
    // when head and tail coincide (all-same chars) they dedupe to one.
    const long = "x".repeat(60);
    expect(promptLandingFragments(long)).toEqual(["x".repeat(LANDING_FRAGMENT_MAX)]);
    expect(promptLandingFragments(`${"a".repeat(30)}${"z".repeat(30)}`)).toEqual(["a".repeat(LANDING_FRAGMENT_MAX), "z".repeat(LANDING_FRAGMENT_MAX)]);
    expect(promptLandingFragments(`${"a".repeat(30)}\n${"b".repeat(30)}`)).toEqual(["a".repeat(24), "b".repeat(24)]);
    expect(landingFragment("truncate me please, thanks", "head")).toBe("truncate me please, than");
    expect(landingFragment("truncate me please, thanks", "tail")).toBe("uncate me please, thanks");
    expect(promptLandingFragments("   \n\t\n")).toEqual([]);
    expect(promptLandingFragments("")).toEqual([]);
  });

  it("landing attribution: NEW instance in the bottom region AND the fragment ENDS the screen's final rows", () => {
    // The composer is bottom-anchored: typed text ends the last row (or
    // the join of the last two, healing a wrap on that pair).
    const wrapped = "header\n  pi TUI ready ▎hel\n    lo";
    expect(newLandingInstance(wrapped, "header", ["hello"])).toBe(0);
    expect(newLandingInstance(`${wrapped}\n? help`, "header", ["hello"])).toBe(-1); // chrome row below: fail-safe
    // A transcript row re-revealed ABOVE composer chrome never ends the
    // final rows — the whole-screen 0→1 fake increment stays dead (v11②).
    expect(
      newLandingInstance("idle seat\nhello (old transcript revealed)\nchrome a\nchrome b\nchrome c", "trust modal", ["hello"]),
    ).toBe(-1);
    // …and even with only 0-2 UI rows below it (the modal-reveal geometry):
    expect(newLandingInstance("session\nhello (old transcript revealed)\n›\n? help", "trust modal", ["hello"])).toBe(-1);
    expect(newLandingInstance("idle seat\nhello (old transcript revealed)\n›", "trust modal", ["hello"])).toBe(-1);
    // Same-count repaints prove nothing (the old instance stays rendered).
    expect(newLandingInstance("spinner frame ▎hello", "seat ▎hello （tut delivery A1B2C3D4）", ["hello"])).toBe(-1);
    // A genuine second instance that also ends the screen lands.
    expect(newLandingInstance("seat ▎hello hello", "seat ▎hello （tut delivery A1B2C3D4）", ["hello"])).toBe(0);
    expect(newLandingInstance("no trace of it here", "", ["hello"])).toBe(-1);
    expect(newLandingInstance("", "hello", ["hello"])).toBe(-1);
    expect(newLandingInstance("whatever", "", [])).toBe(-1);
    expect(newLandingInstance("  \n\t\n", "", ["hello"])).toBe(-1);
  });

  it("diagTail: last non-empty line, trimmed, capped at 40, single quotes stripped", () => {
    expect(diagTail("a\n  bcd  \n\nef'g")).toBe("efg");
    expect(diagTail("x".repeat(50))).toBe("x".repeat(40));
    expect(diagTail("")).toBe("");
  });
});

describe("delivery knobs", () => {
  it("defaults and parsing follow the documented knob set", () => {
    expect(parseDeliveryKnobs({})).toEqual({
      pollMs: 250,
      readyFloorMs: 1500,
      readyTimeoutMs: 15000,
      readyStablePolls: 4,
      textLandTimeoutMs: 5000,
      submitTimeoutMs: 3000,
      submitRetryMs: 1500,
      submitRetryWindowMs: 30000,
    });
    expect(parseDeliveryKnobs({ TUT_READY_POLL_MS: "20", TUT_SUBMIT_RETRY_MS: "0" })).toMatchObject({
      pollMs: 20,
      submitRetryMs: 1, // clamped like the legacy poll-count minimum
    });
  });

  it("TUT_READY_POLL_MS=0 (and illegal values) never yields a zero cadence — every window stays finite", () => {
    // Zero is a well-formed \d+ the parser used to accept verbatim, and a
    // zero cadence makes window/poll infinite (or NaN) in every loop.  The
    // parse clamps to 1ms; junk/non-numeric values keep falling back.
    expect(parseDeliveryKnobs({ TUT_READY_POLL_MS: "0" }).pollMs).toBe(1);
    expect(parseDeliveryKnobs({ TUT_READY_POLL_MS: "000" }).pollMs).toBe(1);
    expect(parseDeliveryKnobs({ TUT_READY_POLL_MS: "" }).pollMs).toBe(250);
    expect(parseDeliveryKnobs({ TUT_READY_POLL_MS: "-5" }).pollMs).toBe(250);
    expect(parseDeliveryKnobs({ TUT_READY_POLL_MS: "abc" }).pollMs).toBe(250);
    // All-zero knobs on a zero cadence cannot produce NaN counts either
    // (0/0): the cadence clamp keeps every division finite.  The window
    // knobs clamp to ≥1 as well: a zero window used to skip its
    // phase outright while looking like a legal \d+ value.
    expect(parseDeliveryKnobs({
      TUT_READY_POLL_MS: "0",
      TUT_READY_FLOOR_MS: "0",
      TUT_READY_TIMEOUT_MS: "0",
      TUT_READY_STABLE_POLLS: "0",
      TUT_TEXT_LAND_TIMEOUT_MS: "0",
      TUT_SUBMIT_TIMEOUT_MS: "0",
      TUT_SUBMIT_RETRY_MS: "0",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "0",
    })).toEqual({
      pollMs: 1,
      readyFloorMs: 1, // ≥1 clamp: never a zero window
      readyTimeoutMs: 1,
      readyStablePolls: 2, // clamped to the two-sample minimum: one sample is not stability
      textLandTimeoutMs: 1,
      submitTimeoutMs: 1,
      submitRetryMs: 1,
      submitRetryWindowMs: 1,
    });
    // Junk stable-poll values fall back to the default 4.
    expect(parseDeliveryKnobs({ TUT_READY_STABLE_POLLS: "abc" }).readyStablePolls).toBe(4);
    expect(parseDeliveryKnobs({ TUT_READY_STABLE_POLLS: "" }).readyStablePolls).toBe(4);
    expect(parseDeliveryKnobs({ TUT_READY_STABLE_POLLS: "-1" }).readyStablePolls).toBe(4);
    expect(parseDeliveryKnobs({ TUT_READY_STABLE_POLLS: "1" }).readyStablePolls).toBe(2); // minimum
  });

  it("TUT_SUBMIT_RETRIES and TUT_SUBMIT_READY_TIMEOUT_MS are inert legacy knobs — carrying them changes nothing", async () => {
    // The fixture-level live variant lives in cli-start-next tests; here the
    // parse itself ignores them, and a full delivery with them set produces
    // the identical call sequence as without.
    const without = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "working"] });
    const withLegacy = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "working"] });
    const a = harness(without);
    const b = harness(withLegacy, { TUT_SUBMIT_RETRIES: "2", TUT_SUBMIT_READY_TIMEOUT_MS: "999" });
    await a.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    await b.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(withLegacy.calls.map((call) => call.replace(/TUT-DELIVERY-PROBE-[0-9A-F]{8}/gu, "TUT-DELIVERY-PROBE-<random>"))).toEqual(
      without.calls.map((call) => call.replace(/TUT-DELIVERY-PROBE-[0-9A-F]{8}/gu, "TUT-DELIVERY-PROBE-<random>")),
    );
    expect(normalizeMarkers(fields(b.lines()))).toEqual(normalizeMarkers(fields(a.lines())));
  });
});

// ---- the closed loop (named design tests) ----------------------------------------

describe("born readiness uses the visible QUIESCENT baseline", () => {
  it("releases only after change-from-baseline + FOUR consecutive identical samples (default quiescence) + the floor poll", async () => {
    const fake = fakeClient({ pre: ["", "", "ui", "ui", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "working"] });
    const h = harness(fake);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    // Gate: base read + poll("") + paint("ui") + the four-sample quiescence run.
    expect(fake.calls.slice(0, 6)).toEqual(["read", "read", "read", "read", "read", "read"]);
    expect(fields(h.lines())[0]).toBe("gate-start pane=p1 floor_ms=1 timeout_ms=10 stable_polls=4"); // FAST floor 0 clamps to ≥1
    expect(fields(h.lines())).toContain("gate-release pane=p1 idx=4 stable=4 len=2 tail='ui'");
    // The gate-release screen is the land baseline: the very next read after
    // send-text sees the landed prompt text and observes the land immediately.
    expect(fields(h.lines())).toContain("land-observed pane=p1 idx=0 len=33 frag=' （tut delivery A1B2C3D4）' tail='ui ▎hello （tut delivery A1B2C3D4）'");
  });

  it("a continuously-changing screen never reaches quiescence — the gate holds until timeout, then delivers anyway", async () => {
    // The banner-repaint shape: frames alternate forever, no run of 4
    // identical samples ever accumulates (the old two-sample gate released
    // on the first pause ≥2×poll).
    const fake = fakeClient({ pre: ["", "banner a", "banner b", "banner a", "banner b", "banner a", "banner b", "banner a", "banner b"], post: [""] });
    const h = harness(fake, { TUT_READY_TIMEOUT_MS: "8" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // degradation never fails the launch
    expect(h.errors().join("")).toContain("not observed ready within 8ms — delivering anyway");
    expect(fields(h.lines())).toContain("gate-timeout pane=p1 idx=8 len=8");
    expect(fields(h.lines()).some((l) => l.startsWith("gate-release"))).toBe(false);
  });

  it("TUT_READY_STABLE_POLLS=2 restores the legacy stable-pair release", async () => {
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "working"] });
    const h = harness(fake, { TUT_READY_STABLE_POLLS: "2" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(fields(h.lines())).toContain("gate-start pane=p1 floor_ms=1 timeout_ms=10 stable_polls=2");
    expect(fields(h.lines())).toContain("gate-release pane=p1 idx=2 stable=2 len=2 tail='ui'");
  });

  it("an unchanged-from-baseline screen never releases — timeout degrades to delivering anyway", async () => {
    const fake = fakeClient({ pre: ["base", "base", "base"], post: [""] });
    const h = harness(fake, { TUT_READY_TIMEOUT_MS: "3", TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "2" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // degradation never fails the launch
    expect(h.errors().join("")).toContain("not observed ready within 3ms — delivering anyway");
    expect(fields(h.lines())).toContain("gate-timeout pane=p1 idx=3 len=4");
  });

  it("the floor holds the gate even when the screen is stable before it", async () => {
    // Stable paint at polls 0-1, floor at poll 2: no release until idx>=2.
    const fake = fakeClient({ pre: ["", "ui", "ui", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "working"] });
    const h = harness(fake, { TUT_READY_FLOOR_MS: "3" }); // floor = 3 polls
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    const release = fields(h.lines()).find((l) => l.startsWith("gate-release"));
    expect(release).toBe("gate-release pane=p1 idx=3 stable=4 len=2 tail='ui'");
  });

  it("reads use the visible source with 40 lines through the raw-argv compat seam", async () => {
    const argv: string[][] = [];
    const client = createDeliveryClient(async (args) => {
      argv.push([...args]);
      if (args[1] === "read") return { code: 0, signal: null, stdout: "screen", stderr: "" };
      return { code: 0, signal: null, stdout: "", stderr: "" };
    });
    expect(await client.readPane("p1")).toBe("screen");
    expect(await client.sendText("p1", "text with spaces")).toBe(true);
    expect(await client.sendKeys("p1", "Enter")).toBe(true);
    expect(argv[0]).toEqual(["pane", "read", "p1", "--source", "visible", "--lines", "40"]);
    expect(argv[1]).toEqual(["pane", "send-text", "p1", "text with spaces"]);
    expect(argv[2]).toEqual(["pane", "send-keys", "p1", "Enter"]);
    // A failing read degrades to "" (glitch), failing sends to false.
    const failing = createDeliveryClient(async () => ({ code: 1, signal: null, stdout: "x", stderr: "e" }));
    expect(await failing.readPane("p1")).toBe("");
    expect(await failing.sendText("p1", "t")).toBe(false);
    expect(await failing.sendKeys("p1", "Enter")).toBe(false);
  });
});

describe("verified submit retries Enter until the bottom composer clears", () => {
  it("healthy path: ONE Enter, the verify read confirms, no resend, no loop", async () => {
    const fake = fakeClient({ pre: ["", "", "ui", "ui", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "working"] });
    const h = harness(fake);
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(fake.calls.filter((c) => c === "send-keys Enter")).toHaveLength(1);
    expect(fields(h.lines())).toContain("submit-confirmed pane=p1 attempt=1 phase=verify idx=0");
    expect(h.errors().join("")).not.toContain("resending");
    expect(fields(h.lines()).some((l) => l.startsWith("loop-start"))).toBe(false);
  });

  it("swallowed first Enter → clocked resend loop → the second Enter commits", async () => {
    // post[enters]: after Enter1 the composer still holds; after Enter2 it
    // lets go — the causal fixture shape (observed live-race window).
    const fake = fakeClient({ pre: ["", "", "ui", "ui", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "ui ▎hello （tut delivery A1B2C3D4）", "working"] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(fake.enters()).toBe(2);
    expect(h.errors().join("")).toContain("resending Enter (attempt 2)");
    expect(h.errors().join("")).toContain("input box cleared on p1 — submit confirmed (attempt 2)");
    expect(fields(h.lines())).toContain("submit-confirmed pane=p1 attempt=2 phase=loop idx=2");
    // The text was sent exactly once — resends are Enter only.
    expect(promptSends(fake.calls)).toHaveLength(1);
  });

  it("multi-swallow: the loop keeps resending on the clock until the box clears", async () => {
    const held = "codex shell ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: [held, held, held, held, held, "working"] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "12" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(fake.enters()).toBe(5);
    expect(promptSends(fake.calls)).toHaveLength(1); // text never re-sent
    expect(probeSends(fake.calls)).toHaveLength(5);
    expect(fields(h.lines()).some((l) => /^submit-confirmed pane=p1 attempt=5 phase=loop/u.test(l))).toBe(true);
  });

  it("an empty read is a glitch: box=unknown, it never confirms and the give-up hint says so", async () => {
    // The text DID land (post[0]); after the Enter every read comes back
    // empty — box=unknown forever, no confirm, honest check-the-pane hint.
    const fake = fakeClient({ pre: ["", "", "ui", "ui", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", ""] });
    const h = harness(fake, { TUT_SUBMIT_RETRY_TIMEOUT_MS: "3" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // read failures degrade, never fail the launch
    expect(fields(h.lines())).toContain("land-observed pane=p1 idx=0 len=33 frag=' （tut delivery A1B2C3D4）' tail='ui ▎hello （tut delivery A1B2C3D4）'");
    const lines = fields(h.lines());
    expect(lines.some((l) => l.includes("box=unknown"))).toBe(true);
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(h.errors().join("")).toContain(`screen read unavailable; ${giveUpGuidance("unknown")}`);
  });

  it("transport=false never confirms: box cleared + probe visible still loops, then gives up honestly", async () => {
    // A failed send-keys is a transport failure — no box repaint or probe
    // echo may paper over it (the reversed authority would double-Enter).
    // box=cleared + transport=false never resends — the text already
    // left the box, a resend could hit an already-started round; verification
    // observes on cadence until the budget ends.
    const fake = fakeClient({ pre: ["", "", "ui", "ui", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "working"], failSendKeys: true });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // degradation never fails the launch
    expect(h.errors().join("")).toContain("herdr pane send-keys p1 Enter failed (initial attempt)");
    expect(h.errors().join("")).not.toContain("herdr pane send-keys p1 Enter failed (attempt 2)"); // no resend on cleared
    expect(fake.enters()).toBe(1); // the ONE failed Enter — never re-attempted in the cleared state
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(lines.some((l) => l.includes("box=cleared") && l.includes("probe=observed"))).toBe(true);
    // The loop-entry note (not the give-up line — the last post-Enter read
    // leaves box=unknown here) carries the cleared-state warning.
    expect(h.errors().join("")).toContain("do not press Enter blindly");
    expect(lines.some((l) => l.startsWith("give-up pane=p1 ") && l.includes("transport=false") && l.includes("attempts=1"))).toBe(true);
  });
});

describe("Enter echo verification", () => {
  it("uses the required random marker, dialect commands, and targeted cleanup", () => {
    const marker = deliveryProbeMarker("the user's prompt");
    const otherMarker = "TUT-DELIVERY-PROBE-DEADBEEF";
    expect(marker).toMatch(/^TUT-DELIVERY-PROBE-[0-9A-F]{8}$/u);
    expect(deliveryProbeCommand(marker)).toBe(`printf '${marker}'\n`);
    expect(deliveryProbeCommand(marker, "powershell5")).toBe(`Write-Output '${marker}'`);
    expect(deliveryProbeCommand(marker, "pwsh")).toBe(`Write-Output '${marker}'`);
    expect(deliveryProbeCommand(marker, "cmd")).toBe(`echo(${marker}`);
    expect(withoutDeliveryProbe(`held composer\n${otherMarker}\n${marker}\n`, marker)).toBe(`held composer\n${otherMarker}\n\n`);
  });

  it("adds one out-of-band probe request/read per Enter without sending probe text to the TUI", async () => {
    const fake = fakeClient({ pre: ["seat"], post: ["seat ▎hello （tut delivery A1B2C3D4）", "working"] });
    const h = harness(fake, { TUT_READY_TIMEOUT_MS: "1" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    expect(promptSends(fake.calls)).toHaveLength(1);
    expect(probeSends(fake.calls)).toHaveLength(1);
    expect(fake.calls.filter((call) => call.startsWith("send-text")).every((call) => !call.includes("TUT-DELIVERY-PROBE-"))).toBe(true);
    expect(fake.calls.slice(3, 5)).toEqual([expect.stringMatching(/^send-keys Enter$/u), expect.stringMatching(/^send-probe marker=TUT-DELIVERY-PROBE-[0-9A-F]{8}$/u)]);
    expect(fields(h.lines()).some((line) => /^probe-send pane=p1 attempt=1 phase=initial marker=TUT-DELIVERY-PROBE-[0-9A-F]{8}$/u.test(line))).toBe(true);
    expect(fields(h.lines()).some((line) => /^probe-result pane=p1 attempt=1 phase=initial marker=TUT-DELIVERY-PROBE-[0-9A-F]{8} dispatch=sent found=true /u.test(line))).toBe(true);
  });

  it("a failed probe never blocks confirmation: transport=true + box cleared confirms without resend", async () => {
    // The human ruling: the relay probe is diagnostic only.  Its failure
    // says nothing about the Enter itself — the submit confirms on the
    // transport+box evidence alone and the loop stops.
    const fake = fakeClient({ pre: ["seat"], post: ["seat ▎hello （tut delivery A1B2C3D4）", "working"], probeResults: [false] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_MS: "1" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    expect(fake.enters()).toBe(1); // NO resend — a probe failure is not an Enter failure
    expect(promptSends(fake.calls)).toHaveLength(1);
    expect(probeSends(fake.calls)).toHaveLength(1);
    const lines = fields(h.lines());
    expect(lines.some((line) => line.includes("probe-result pane=p1 attempt=1") && line.includes("found=false"))).toBe(true);
    expect(lines.some((line) => line.includes("box=cleared") && line.includes("probe=failed"))).toBe(true);
    expect(lines).toContain("submit-confirmed pane=p1 attempt=1 phase=verify idx=0");
    expect(h.errors().join("")).not.toContain("resending");
  });

  it("a failed probe with the box held neither confirms nor resends early — the clock alone drives retries", async () => {
    const fake = fakeClient({
      pre: ["seat"],
      post: ["seat ▎hello （tut delivery A1B2C3D4）", "seat ▎hello （tut delivery A1B2C3D4）", "working"],
      probeResults: [false, true],
    });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "8" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    expect(fake.enters()).toBe(2);
    expect(probeSends(fake.calls)).toHaveLength(2);
    const lines = h.lines();
    // The first Enter is retried only after the retry interval, probe
    // failure or not; the second attempt (transport=true) then confirms.
    expect(tOf(lines, "enter pane=p1 attempt=2 ") - tOf(lines, "enter pane=p1 attempt=1 ")).toBeGreaterThanOrEqual(2);
    expect(lines.some((line) => line.includes("probe-result pane=p1 attempt=1") && line.includes("found=false"))).toBe(true);
    expect(fields(lines).some((l) => /^submit-confirmed pane=p1 attempt=2 phase=loop/u.test(l))).toBe(true);
  });
});

// ---- ONE shared monotonic budget for the whole submit phase ----------------------

describe("the submit phase spends ONE shared monotonic budget", () => {
  it("the initial observation consumes budget; the retry loop inherits only the remainder (exhaustion, not re-arm)", async () => {
    // post[5] would commit a 5th Enter — reachable ONLY if the retry loop
    // re-armed a fresh window after the initial one (the old additive
    // behavior).  Under the shared deadline the budget is spent first.
    const held = "seat ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["seat"], post: [held, held, held, held, held, "working"] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "4", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "10" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true); // exhaustion still exits 0
    const lines = h.lines();
    const tSubmit = tOf(lines, "submit pane=p1 ");
    const deadline = tSubmit + 10;
    // Resends fire on the clock cadence inside the remaining budget: the
    // initial window already consumed 4ms, so attempt 2 lands at +5, then
    // every +2 — and NOTHING fires at/after the deadline.
    expect([1, 2, 3, 4].map((n) => tOf(lines, `enter pane=p1 attempt=${n} `))).toEqual([
      tSubmit,
      tSubmit + 5,
      tSubmit + 7,
      tSubmit + 9,
    ]);
    expect(fake.enters()).toBe(4);
    const giveUp = fields(lines).find((l) => l.startsWith("give-up pane=p1 "));
    // Honest evidence: the last Enter (attempt 4) landed at the budget edge
    // and no cadence observe followed it — but its PROBE read did run fresh
    // after it (probe reads feed the box evidence), so give-up speaks
    // from the freshest truth: the box still holds the text.
    expect(giveUp).toBe("give-up pane=p1 attempts=4 window_ms=10 box=held transport=true probe=observed elapsed_ms=10 budget_ms=10 reason=box-held");
    // Budget invariants: every sleep ends within the deadline, total
    // elapsed never exceeds the configured budget.
    expect(vtWithinDeadline(h, deadline)).toBe(true);
    expect(h.vt.time()).toBeLessThanOrEqual(deadline);
    expect(fields(lines).some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(promptSends(fake.calls)).toHaveLength(1);
  });

  it("a late attempt commits inside the remaining budget — confirmation, not exhaustion", async () => {
    const held = "seat ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["seat"], post: [held, held, held, "working"] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "4", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "10" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    const lines = h.lines();
    const tSubmit = tOf(lines, "submit pane=p1 ");
    expect(fields(lines)).toContain("submit-confirmed pane=p1 attempt=3 phase=loop idx=4");
    expect(fake.enters()).toBe(3);
    // Confirmed at +8 < the 10ms budget: the retry loop only ever got the
    // remainder after the initial window.
    expect(h.vt.time()).toBeLessThanOrEqual(tSubmit + 10);
    expect(fields(lines).some((l) => l.startsWith("give-up"))).toBe(false);
  });

  it("control-call latency burns the same budget: fewer Enters fit and nothing new starts past the deadline", async () => {
    // Each herdr call costs 2ms of virtual time (relay request + reads
    // included — NOT just sleeps).  The probe of the resent Enter is
    // skipped once the budget is spent; the send-keys itself started
    // before the deadline and its late return may only update the last
    // observation.
    const vt = virtualClock();
    const fake = fakeClient({ pre: ["seat"], post: ["seat ▎hello （tut delivery A1B2C3D4）"], clock: vt, costMs: 2 });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "10" }, undefined, vt);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = h.lines();
    const tSubmit = tOf(lines, "submit pane=p1 ");
    const deadline = tSubmit + 10;
    // Costless calls would fit ~6 Enters into 10ms; with 2ms per call only
    // the initial + one resend fit — the non-sleep time consumed the budget.
    expect(fake.enters()).toBe(2);
    expect(probeSends(fake.calls)).toHaveLength(1); // the resent Enter's probe was skipped past the deadline
    expect(fake.timed().every((e) => e.at < deadline)).toBe(true);
    expect(vt.sleeps().every((s) => s.at + s.ms <= deadline)).toBe(true);
    const giveUp = fields(lines).find((l) => l.startsWith("give-up pane=p1 "));
    expect(giveUp).toContain("attempts=2");
    expect(giveUp).toContain("budget_ms=10");
    // Total overrun over the deadline stays within ONE in-flight call.
    expect(h.vt.time()).toBeLessThanOrEqual(deadline + 2);
    expect(Number(giveUp?.match(/elapsed_ms=(\d+)/u)?.[1])).toBeLessThanOrEqual(12);
  });

  it("the FIRST Enter returning past the deadline starts no probe, no read, no sleep (P1)", async () => {
    // The first sendKeys itself consumes the whole 10ms budget: the probe
    // after it must not start (no relay request, no probe read), the
    // observation loop must not sleep, and the delivery must converge to
    // the honest unknown give-up.
    const vt = virtualClock();
    const fake = fakeClient({
      pre: ["seat"],
      post: ["seat ▎hello （tut delivery A1B2C3D4）"],
      clock: vt,
      costs: { "send-text": 2, read: 2, "send-keys": 20, "send-probe": 2 },
    });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "10" }, undefined, vt);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = h.lines();
    const tSubmit = tOf(lines, "submit pane=p1 ");
    const deadline = tSubmit + 10;
    // Call START times: the Enter started before the deadline; nothing was
    // started after it.
    const enterStarts = fake.timed().filter((e) => e.call.startsWith("send-keys"));
    expect(enterStarts.map((e) => e.at)).toEqual([tSubmit]);
    expect(fake.timed().every((e) => e.at < deadline)).toBe(true);
    expect(fake.timed().filter((e) => e.call === "send-probe")).toHaveLength(0);
    expect(fake.timed().filter((e) => e.call === "read")).toHaveLength(2); // snapshot + land read only, no probe read
    expect(h.vt.sleeps().every((s) => s.at + s.ms <= deadline)).toBe(true);
    expect(fields(lines).some((l) => l.includes("probe-skip") && l.includes("reason=deadline"))).toBe(true);
    const giveUp = fields(lines).find((l) => l.startsWith("give-up pane=p1 "));
    expect(giveUp).toBe("give-up pane=p1 attempts=1 window_ms=10 box=unknown transport=true probe=unavailable elapsed_ms=20 budget_ms=10 reason=box-unknown");
    expect(h.errors().join("")).toContain(giveUpGuidance("unknown"));
  });

  it("a relay request that pushes past the deadline is never followed by its probe read (P1)", async () => {
    // The probe contains TWO control calls: the sendProbe may start inside
    // the budget, but if it returns past the deadline its read must not
    // start either — visibility stays honestly unavailable.
    const vt = virtualClock();
    const fake = fakeClient({
      pre: ["seat"],
      post: ["seat ▎hello （tut delivery A1B2C3D4）"],
      clock: vt,
      costs: { "send-text": 2, read: 2, "send-keys": 2, "send-probe": 8 },
    });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "8" }, undefined, vt);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = h.lines();
    const deadline = tOf(lines, "submit pane=p1 ") + 8;
    // sendProbe started inside the budget; the probe's read never ran.
    const probeStart = fake.timed().find((e) => e.call === "send-probe")?.at ?? Number.NaN;
    expect(probeStart).toBeLessThan(deadline);
    expect(fake.timed().filter((e) => e.call === "read")).toHaveLength(2); // snapshot + land read only
    expect(fake.timed().every((e) => e.at < deadline)).toBe(true);
    const giveUp = fields(lines).find((l) => l.startsWith("give-up pane=p1 "));
    expect(giveUp).toContain("probe=unavailable");
    expect(giveUp).toContain("reason=box-unknown");
  });

  it("the LAST resend crossing the deadline never reuses pre-Enter evidence — honest unknown give-up (P2)", async () => {
    // The resend's sendKeys starts before the deadline but returns past it:
    // no post-Enter read/probe is allowed, so give-up must NOT reuse the
    // previous attempt's box=held/probe=observed and must NOT hint a blind
    // Enter — the prompt may have committed in between.
    const vt = virtualClock();
    const fake = fakeClient({
      pre: ["seat"],
      post: ["seat ▎hello （tut delivery A1B2C3D4）"],
      clock: vt,
      costs: { "send-text": 2, read: 2, "send-keys": 20, "send-probe": 2 },
    });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "30" }, undefined, vt);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = h.lines();
    const tSubmit = tOf(lines, "submit pane=p1 ");
    const deadline = tSubmit + 30;
    expect(fake.enters()).toBe(2); // the resend was started (before the deadline)
    const resendStart = fake.timed().filter((e) => e.call.startsWith("send-keys"))[1]?.at ?? Number.NaN;
    expect(resendStart).toBeLessThan(deadline);
    expect(fake.timed().every((e) => e.at < deadline)).toBe(true); // nothing new started past it
    const fieldsLines = fields(lines);
    const giveUp = fieldsLines.find((l) => l.startsWith("give-up pane=p1 "));
    expect(giveUp).toBe("give-up pane=p1 attempts=2 window_ms=30 box=unknown transport=true probe=unavailable elapsed_ms=47 budget_ms=30 reason=box-unknown");
    // The UNKNOWN guidance — never held/manual-Enter.
    expect(h.errors().join("")).toContain(`screen read unavailable; ${giveUpGuidance("unknown")}`);
    expect(h.errors().join("")).not.toContain(giveUpGuidance("held"));
    expect(fieldsLines.some((l) => l.startsWith("give-up") && l.includes("box=held"))).toBe(false);
  });
});

/** Every virtual sleep finished within the deadline. */
function vtWithinDeadline(h: { vt: VirtualClock }, deadline: number): boolean {
  return h.vt.sleeps().every((s) => s.at + s.ms <= deadline);
}

// ---- give-up: three evidence states, never a duplicated prompt -------------------

describe("give-up does not duplicate the prompt and speaks the evidence", () => {
  it("held: bounded clocked resends, press-Enter note, still reports success", async () => {
    const held = "ui ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: [held], probeResults: [false, false] });
    const givenUp: GiveUpEvidence[] = [];
    const h = harness(
      fake,
      { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "5" },
      (_paneId, evidence) => {
        givenUp.push(evidence);
      },
    );
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // exit 0: a failure exit would re-trigger duplicate delivery
    expect(promptSends(fake.calls)).toHaveLength(1); // the prompt is never duplicated
    // Clock cadence inside a 5ms budget: initial Enter + one resend.
    expect(fake.enters()).toBe(2);
    const errors = h.errors().join("");
    expect(errors).toContain("submit not confirmed on p1 within 5ms after 2 Enters");
    expect(errors).toContain(giveUpGuidance("held"));
    const lines = fields(h.lines());
    expect(lines).toContain(
      "give-up pane=p1 attempts=2 window_ms=5 box=held transport=true probe=failed elapsed_ms=5 budget_ms=5 reason=box-held",
    );
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    // The escalation carries the SAME evidence the diag line reports.
    expect(givenUp).toEqual([{ box: "held", transport: true, probe: "failed" }]);
  });

  it("cleared but unconfirmed: confirm-round-first note — never a blind Enter", async () => {
    // post[0] = the landed composer (the land-confirm baseline); after the
    // FAILED Enter the box reads cleared — but transport=false means the
    // submit stays unconfirmed and the hint must say so.
    const fake = fakeClient({ pre: ["", "", "ui", "ui", "ui", "ui"], post: ["ui ▎hello （tut delivery A1B2C3D4）", "working"], failSendKeys: true });
    const givenUp: GiveUpEvidence[] = [];
    const h = harness(
      fake,
      { TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" },
      (_paneId, evidence) => {
        givenUp.push(evidence);
      },
    );
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    expect(promptSends(fake.calls)).toHaveLength(1);
    const errors = h.errors().join("");
    expect(errors).toContain("submit not confirmed on p1 within 4ms after");
    expect(errors).toContain(giveUpGuidance("cleared"));
    expect(errors).not.toContain(giveUpGuidance("held"));
    expect(errors).not.toContain("press Enter there manually");
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("give-up pane=p1 ") && l.includes("box=cleared") && l.includes("transport=false") && l.includes("reason=box-cleared-unconfirmed"))).toBe(true);
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    // Escalation evidence: the box let go but the Enter transport failed —
    // exactly what the notifier's cleared-branch copy must reflect.
    expect(givenUp).toEqual([{ box: "cleared", transport: false, probe: "observed" }]);
  });

  it("an unreadable textless screen degrades to the never-landed give-up — check-pane-first, never a blind Enter", async () => {
    const fake = fakeClient({ pre: [""], post: [""] });
    const givenUp: GiveUpEvidence[] = [];
    const h = harness(
      fake,
      { TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" },
      (_paneId, evidence) => {
        givenUp.push(evidence);
      },
    );
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    expect(promptSends(fake.calls)).toHaveLength(1);
    const errors = h.errors().join("");
    expect(errors).toContain("submit not confirmed on p1 within 4ms after 0 Enters");
    expect(errors).toContain("no Enter was sent — inspect the pane: if the text is visible in the input box, press Enter there manually; if it is gone, re-deliver the prompt manually");
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("give-up pane=p1 ") && l.includes("reason=land-never-observed"))).toBe(true);
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    // Escalation evidence degrades honestly: the never-landed path sent no
    // Enter and ran no probe — box unknown is what forces the notifier's
    // conservative copy, and the probe reports not-attempted (a never-run
    // probe is not relay evidence).
    expect(givenUp).toEqual([{ box: "unknown", transport: false, probe: "not-attempted" }]);
  });

  it("window exhaustion escalates exactly once through the onGiveUp seam (7.2.1)", async () => {
    const held = "seat ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["seat"], post: [held] });
    const givenUp: Array<{ paneId: string; evidence: GiveUpEvidence }> = [];
    const linesAtEscalation: string[][] = [];
    const h = harness(
      fake,
      { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "5" },
      async (paneId, evidence) => {
        // Capture only: assertions inside this callback would be swallowed by
        // the best-effort try/catch around the seam.
        linesAtEscalation.push(fields(h.lines()));
        givenUp.push({ paneId, evidence });
      },
    );
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true); // the escalation never changes the delivery outcome
    expect(givenUp.map((g) => g.paneId)).toEqual(["p1"]); // exactly once
    // Ordering: the give-up diag line already exists when the escalation fires.
    expect(linesAtEscalation[0]?.some((line) => line.includes("give-up pane=p1 attempts=2 window_ms=5"))).toBe(true);
    // The event body evidence matches the diag line's triple (held case).
    expect(givenUp[0]?.evidence).toEqual({ box: "held", transport: true, probe: "observed" });
  });

  it("a confirmed submit never escalates", async () => {
    const fake = fakeClient({ pre: ["seat"], post: ["seat ▎hello （tut delivery A1B2C3D4）", "working"] });
    const givenUp: string[] = [];
    const h = harness(fake, {}, (paneId) => {
      givenUp.push(paneId);
    });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(givenUp).toEqual([]);
  });

  it("a throwing escalation is swallowed — best-effort, delivery outcome unchanged", async () => {
    const held = "seat ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["seat"], post: [held] });
    const h = harness(
      fake,
      { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "5" },
      async () => {
        throw new Error("escalation transport exploded");
      },
    );
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true); // still exit-0 semantics
    expect(fields(h.lines())).toContain("give-up pane=p1 attempts=2 window_ms=5 box=held transport=true probe=observed elapsed_ms=5 budget_ms=5 reason=box-held");
  });
});

// ---- the banner-repaint false-confirm cascade is dead (7.2.1 step 3) ----------------

describe("a banner repaint can no longer pose as a landed prompt", () => {
  it("banner repaints do not satisfy landing: land times out honestly, no textless with-text snapshot exists", async () => {
    // The reported cascade: a slow-start TUI's banner repaints (the screen
    // CHANGES) while not accepting input.  The old any-change landing took
    // the repaint as the landed text; the text-match criterion keeps
    // polling for the actual prompt text and times out honestly.
    const fake = fakeClient({
      pre: ["", "", "banner", "banner", "banner", "banner"],
      post: ["banner v2"], // repaints forever, never shows the prompt
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "3", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines).toContain("land-start pane=p1 timeout_ms=3 frags=2");
    expect(lines.some((l) => l.startsWith("land-observed"))).toBe(false);
    expect(lines).toContain("land-timeout pane=p1 idx=3 len=9");
    expect(h.errors().join("")).toContain("the receiver may not accept input yet; entering the no-blind-Enter wait (Enter only after the text is observed)");
    expect(fake.enters()).toBe(0); // the modal lesson: no Enter without the text
  });

  it("entry A: a gate-timeout empty baseline plus a prompt-less first paint never satisfies landing", async () => {
    // The R1 entry A: gate timeout returns "" as the baseline, so under
    // the old any-change criterion the TUI's first painted frame (which
    // never contains the prompt) satisfied "landing".  Text-match landing
    // needs the FRAGMENT — a prompt-less first paint keeps polling.
    const fake = fakeClient({
      pre: [""], // gate timeout: never paints, baseline stays ""
      postReads: ["first frame painted", "second frame repaints"], // changes, never the prompt
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "3" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("gate-timeout"))).toBe(true);
    expect(lines.some((l) => l.startsWith("land-observed"))).toBe(false);
    expect(lines).toContain("land-timeout pane=p1 idx=2 len=21");
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(fake.enters()).toBe(0); // no blind Enter onto a possibly-modal screen
  });

  it("entry B: a textless last read can no longer produce an empty-signature cleared confirm", async () => {
    // The R1 entry B: land timeout with an empty last read used to feed
    // signature="" into boxState (any non-empty screen "cleared").  The
    // never-landed path never consults the box: evidence stays unknown.
    const fake = fakeClient({
      pre: [""],
      postReads: [""], // every post-text read is empty (read glitch)
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "3" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.includes("box=cleared"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
    expect(fake.enters()).toBe(0);
  });

  it("the textless-snapshot cascade is dead: repaints flip no box evidence, no submit-confirmed, give-up says land-never-observed", async () => {
    // Under the old logic the textless snapshot's empty bottom region made
    // every repaint read "cleared" → false submit-confirmed.  Now box
    // evidence stays unknown until the text is seen; the banner keeps
    // repainting and the loop gives up honestly.
    const fake = fakeClient({
      pre: ["", "", "banner", "banner", "banner", "banner"],
      post: ["banner v2", "banner v3"], // keeps repainting after each Enter
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(lines.some((l) => l.includes("box=unknown"))).toBe(true);
    expect(lines.some((l) => l.includes("box=cleared"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
    expect(h.errors().join("")).toContain("if the text is visible in the input box, press Enter there manually; if it is gone, re-deliver the prompt manually");
    expect(h.errors().join("")).not.toContain("press Enter there manually to start the round");
  });

  it("a late landing inside the submit budget adopts the live baseline — an INFORMED Enter then confirms", async () => {
    // The TUI finishes initializing AFTER the text was sent: the third
    // post-text READ (decoupled from Enter count — the adversarial
    // fixture) finally shows the composer holding the text.  The wait
    // phase adopts it as the live with-text baseline (land-late) and only
    // THEN fires the first Enter — informed, never blind — and the commit
    // clears the box: a REAL confirm in exactly the scenario that used to
    // produce a false one or a swallowed-Enter lottery.
    const fake = fakeClient({
      pre: ["", "", "banner", "banner", "banner", "banner"],
      postReads: ["banner v2", "banner v3", "composer ▎hello （tut delivery A1B2C3D4）", "working"],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "12" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-wait pane=p1 "))).toBe(true);
    expect(lines.some((l) => /^land-late pane=p1 phase=wait /u.test(l))).toBe(true);
    expect(lines.some((l) => /^submit-confirmed pane=p1 attempt=1 /u.test(l))).toBe(true);
    expect(fake.enters()).toBe(1); // the ONLY Enter fired after the text was seen
    expect(lines.some((l) => l.startsWith("give-up"))).toBe(false);
    expect(promptSends(fake.calls)).toHaveLength(1); // the text was never re-sent
  });

  it("review ①: baseline already holds the prompt fragment — unrelated repaints/modal NEVER trigger a landing or an Enter", async () => {
    // Same-role continuation: the previous round's prompt is byte-identical
    // and still visible.  A spinner repaint and then a modal change the
    // screen WITHOUT adding a new prompt instance — the old
    // change+presence criterion turned that into land-observed → blind
    // Enter → false confirm.  Attribution kills the chain: no landing, no
    // Enter, honest give-up.
    const fake = fakeClient({
      pre: ["idle seat ▎hello （tut delivery 00000000）"], // baseline holds the OLD instance
      postReads: ["spinner frame ▎hello", "trust modal accepted"],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true); // still exit-0 semantics
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-observed"))).toBe(false);
    expect(lines.some((l) => l.startsWith("land-late"))).toBe(false);
    expect(fake.enters()).toBe(0); // the modal lesson: no Enter without a NEW instance
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
  });

  it("review ②: after land-timeout an old fragment persisting on screen is never adopted as a late landing", async () => {
    // The wait path used to ignore the baseline entirely: any surviving
    // old fragment (scrollback/composer) was adopted as land-late and
    // fired an informed-looking Enter that was still blind.  With the
    // shared attribution rule the old instance proves nothing — the wait
    // exhausts and gives up with attempts=0.
    const fake = fakeClient({
      pre: ["idle seat ▎hello （tut delivery 00000000）"],
      postReads: ["", "idle seat ▎hello (old, still in scrollback)"],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-timeout pane=p1 idx=2 "))).toBe(true);
    expect(lines.some((l) => l.startsWith("land-late"))).toBe(false);
    expect(lines.some((l) => l.includes("step=landwait") && l.includes("box=unknown"))).toBe(true);
    expect(fake.enters()).toBe(0);
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
  });

  it("review v11 ①: viewport shift — the landing pushes the old instance out of the read window (total still 1) and MUST still land", async () => {
    // Whole-screen occurrence counting missed this real landing: baseline
    // shows the previous round's prompt in the transcript (above the
    // bottom rows); the new prompt lands in the composer and scrolls the
    // old echo out of the 40-line viewport — whole-screen total stays 1,
    // but the COMPOSER REGION gained the instance (0→1).  The bottom is
    // the anchored evidence: land, ONE informed Enter, confirm.
    const fake = fakeClient({
      pre: ["idle seat", "hello (old transcript echo)", "chrome 1", "chrome 2", "chrome 3"],
      postReads: [["idle seat", "chrome 1", "chrome 2", "composer ▎hello （tut delivery A1B2C3D4）"].join("\n"), "working"],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "10" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-observed pane=p1 idx=0 ") && l.includes("frag=' （tut delivery A1B2C3D4）'") && l.includes("tail='composer ▎hello （tut delivery A1B2C3D4）'"))).toBe(true);
    expect(fake.enters()).toBe(1); // the informed Enter — exactly one
    expect(lines.some((l) => /^submit-confirmed pane=p1 attempt=1 /u.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("give-up"))).toBe(false);
  });

  it("review v11 ②: viewport shift — a modal reveal surfacing OLD history above the composer (0→1 whole-screen) NEVER lands", async () => {
    // The mirror flaw: baseline screen is a modal hiding the old
    // transcript echo (bottom count 0); send-text is NOT accepted; the
    // modal later closes and the old instance reappears ABOVE the
    // composer rows (whole-screen 0→1).  Bottom-region attribution gives
    // no landing, no Enter, honest give-up — where whole-screen counting
    // produced land-observed → Enter → false confirm.
    const fake = fakeClient({
      pre: ["trust modal — Enter to confirm", "modal footer"],
      postReads: ["", ["idle seat", "hello (old transcript revealed)", "chrome a", "chrome b", "chrome c"].join("\n")],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-observed"))).toBe(false);
    expect(lines.some((l) => l.startsWith("land-late"))).toBe(false);
    expect(lines.some((l) => l.startsWith("land-timeout"))).toBe(true);
    expect(fake.enters()).toBe(0);
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
  });

  it("modal reveal with only 1-2 UI rows below the old instance — immediate path never lands, zero Enter", async () => {
    // The reviewer's built-repro geometry: send-text ignored while the
    // trust modal is up; the reveal surfaces the old transcript echo with
    // just the composer placeholder and a help row below it.  The bottom-3
    // window alone would contain the echo; the bottom-suffix condition
    // refuses it (the final rows end with ›/? help, not the fragment).
    const repro = ["session", "hello (old transcript revealed)", "›", "? help"].join("\n");
    const fake = fakeClient({
      pre: ["trust modal — Enter to confirm", "modal footer"],
      postReads: [repro, repro],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-observed"))).toBe(false);
    expect(lines.some((l) => l.startsWith("land-late"))).toBe(false);
    expect(fake.enters()).toBe(0);
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
  });

  it("the same modal-reveal shape on the LATE path is never adopted as a late landing", async () => {
    // Land-confirm times out first (empty reads), then the reveal shows
    // the old echo with ONE ui row below it — the late-landing wait runs
    // the same attribution rule and refuses it; the wait exhausts into the
    // attempts=0 give-up through the unchanged escalation seam.
    const fake = fakeClient({
      pre: ["trust modal — Enter to confirm", "modal footer"],
      postReads: ["", ["idle seat", "hello (old transcript revealed)", "›"].join("\n")],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-timeout"))).toBe(true);
    expect(lines.some((l) => l.startsWith("land-late"))).toBe(false);
    expect(lines.some((l) => l.includes("step=landwait") && l.includes("box=unknown"))).toBe(true);
    expect(fake.enters()).toBe(0);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
  });

  it("zero-row reveal, immediate: modal reveal leaving the old marker as the LAST row (0 UI rows below) never lands", async () => {
    // The undecidable geometry, disarmed by the nonce: the revealed old
    // transcript line ends with the PREVIOUS delivery's nonce, so this
    // delivery's tail fragment has zero occurrences in the bottom region —
    // the new-instance condition refuses it without any TUI assumptions.
    const fake = fakeClient({
      pre: ["trust modal — Enter to confirm", "modal footer"],
      postReads: ["old transcript ▎hello （tut delivery 00000000）"],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-observed"))).toBe(false);
    expect(lines.some((l) => l.startsWith("land-late"))).toBe(false);
    expect(fake.enters()).toBe(0);
    expect(lines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
  });

  it("zero-row reveal, late: the wait path refuses the same nonce-less reveal and gives up with attempts=0", async () => {
    const fake = fakeClient({
      pre: ["trust modal — Enter to confirm", "modal footer"],
      postReads: ["", "old transcript ▎hello （tut delivery 00000000）"],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-timeout"))).toBe(true);
    expect(lines.some((l) => l.startsWith("land-late"))).toBe(false);
    expect(fake.enters()).toBe(0);
    expect(lines.filter((l) => l.startsWith("give-up pane=p1 "))[0]).toContain("reason=land-never-observed");
  });

  it("positive attribution: old history present but THIS prompt genuinely lands anew — recovery and confirm survive", async () => {
    // The re-delivery appends the same prompt next to the old instance:
    // the occurrence count grows above the baseline, the landing is
    // attributable, the informed Enter commits, the box clears — the full
    // honest recovery, preserved.
    const fake = fakeClient({
      pre: ["idle seat ▎hello （tut delivery 00000000）"],
      postReads: ["idle seat ▎hello （tut delivery 00000000） + hello （tut delivery A1B2C3D4）", "working"],
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "10" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines).toContain(
      "land-observed pane=p1 idx=0 len=72 frag=' （tut delivery A1B2C3D4）' tail='idle seat ▎hello （tut delivery 00000000）'",
    );
    expect(lines.some((l) => /^submit-confirmed pane=p1 attempt=1 /u.test(l))).toBe(true);
    expect(fake.enters()).toBe(1);
  });
});

describe("delivery degrades after read timeouts but fails send-text", () => {
  it("only a send-text failure is fatal — nothing else was delivered", async () => {
    const fake = fakeClient({ pre: ["ui"], post: ["working"], failSendText: true });
    const h = harness(fake);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(false);
    expect(h.errors().join("")).toContain("launch: herdr pane send-text p1 failed\n");
    expect(fake.calls.filter((c) => c === "send-keys Enter")).toHaveLength(0); // no submit after a failed send
  });

  it("gate timeout → land timeout → submit budget: every step notes and keeps going", async () => {
    const fake = fakeClient({ pre: [""], post: [""] });
    const h = harness(fake, { TUT_READY_TIMEOUT_MS: "2", TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "2" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const errors = h.errors().join("");
    expect(errors).toContain("not observed ready within 2ms — delivering anyway");
    expect(errors).toContain("prompt text not observed on p1 within 2ms — the receiver may not accept input yet; entering the no-blind-Enter wait (Enter only after the text is observed)");
    expect(errors).toContain("submit not confirmed on p1 within 2ms after 0 Enters");
    // The text never appeared, so NO Enter ever fired (the blind-Enter
    // lesson): the wait loop burns the budget on reads only.
    expect(fake.enters()).toBe(0);
  });
});

describe("same-role continuation skips the born readiness gate but runs the same land/submit loop", () => {
  it("snapshot read → send-text → land → verified submit; no gate diagnostics", async () => {
    const fake = fakeClient({ pre: ["idle seat"], post: ["idle seat ▎hello （tut delivery A1B2C3D4）", "working"] });
    const h = harness(fake);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("gate-start"))).toBe(false);
    expect(lines[0]).toBe("read pane=p1 step=snapshot idx=0 len=9 tail='idle seat'");
    expect(lines).toContain("send-text pane=p1 branch=continuation len=29");
    expect(lines).toContain("land-observed pane=p1 idx=0 len=40 frag=' （tut delivery A1B2C3D4）' tail='idle seat ▎hello （tut delivery A1B2C3D4）'");
    expect(lines).toContain("submit-confirmed pane=p1 attempt=1 phase=verify idx=0");
    expect(fake.calls[0]).toBe("read"); // the snapshot sits directly before the text
    expect(fake.calls[1]).toBe("send-text prompt len=29");
  });

  it("a swallowed continuation Enter gets the same bounded resend loop (one delivery code path)", async () => {
    const fake = fakeClient({ pre: ["idle seat"], post: ["idle seat ▎hello （tut delivery A1B2C3D4）", "idle seat ▎hello （tut delivery A1B2C3D4）", "working"] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(fake.enters()).toBe(2);
    expect(h.errors().join("")).toContain("resending Enter (attempt 2)");
  });
});

// ---- a zero poll cadence stays bounded ----------------------------------------

describe("a zero poll cadence stays bounded (TUT_READY_POLL_MS=0)", () => {
  // Regression shape from the unit-5 review: a zero cadence used to make
  // window/poll infinite, so a holding screen never ended the loop.  If that
  // returns, these tests hang until the runner timeout instead of passing.
  // The harness's virtual clock keeps the clamped 1ms cadence instant and
  // deterministic.
  it("born: readiness, land and submit/retry all return within finite windows; exhaustion still exits 0 with the never-landed fallback", async () => {
    // The screen never changes and never clears: gate, land and submit each
    // run their full (finite) window and degrade in sequence.  The text is
    // never seen, so the submit gives up with land-never-observed — never
    // a box-cleared false confirm off the textless snapshot.
    const fake = fakeClient({ pre: ["base"], post: ["base"] });
    const h = harness(fake, {
      TUT_READY_POLL_MS: "0",
      TUT_READY_TIMEOUT_MS: "3",
      TUT_TEXT_LAND_TIMEOUT_MS: "2",
      TUT_SUBMIT_TIMEOUT_MS: "2",
      TUT_SUBMIT_RETRY_MS: "2",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "6",
    });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // window exhaustion still reports success
    expect(promptSends(fake.calls)).toHaveLength(1); // the prompt is sent exactly once
    const errors = h.errors().join("");
    expect(errors).toContain("not observed ready within 3ms — delivering anyway");
    expect(errors).toContain("prompt text not observed on p1 within 2ms — the receiver may not accept input yet; entering the no-blind-Enter wait (Enter only after the text is observed)");
    expect(errors).toContain("submit not confirmed on p1 within 6ms after 0 Enters");
    // The text was never observed: no Enter was ever sent, the honest hint
    // is inspect-the-pane (text visible → manual Enter; text gone →
    // manual re-delivery).
    expect(errors).toContain("no Enter was sent — inspect the pane: if the text is visible in the input box, press Enter there manually; if it is gone, re-deliver the prompt manually");
    expect(errors).not.toContain("the prompt is still visible in the input box; press Enter there manually to start the round");
    expect(fields(h.lines())).toContain(
      "give-up pane=p1 attempts=0 window_ms=6 box=unknown transport=false probe=not-attempted elapsed_ms=6 budget_ms=6 reason=land-never-observed",
    );
  });

  it("continuation with a holding screen (the review's repro shape): the bounded resend loop still ends", async () => {
    const held = "seat ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["seat"], post: [held] });
    const h = harness(fake, {
      TUT_READY_POLL_MS: "0",
      TUT_SUBMIT_TIMEOUT_MS: "2",
      TUT_SUBMIT_RETRY_MS: "2",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "5",
    });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    expect(promptSends(fake.calls)).toHaveLength(1);
    // Bounded by the 5ms budget: initial Enter + one resend.
    expect(fake.enters()).toBe(2);
    expect(fields(h.lines())).toContain(
      "give-up pane=p1 attempts=2 window_ms=5 box=held transport=true probe=observed elapsed_ms=5 budget_ms=5 reason=box-held",
    );
    expect(h.errors().join("")).toContain(giveUpGuidance("held"));
  });
});

// ---- the dual-sink diagnostics observer ------------------------------------------

function memoryFs(): {
  fs: DiagnosticsFs;
  dirs: string[];
  files: Map<string, string>;
  renames: Array<{ from: string; to: string }>;
  sizeOverrides: Map<string, number>;
  failAppendAfter: (count: number) => void;
} {
  const dirs: string[] = [];
  const files = new Map<string, string>();
  const renames: Array<{ from: string; to: string }> = [];
  const sizeOverrides = new Map<string, number>();
  let appendCalls = 0;
  let failFrom = Number.POSITIVE_INFINITY;
  return {
    dirs,
    files,
    renames,
    sizeOverrides,
    failAppendAfter: (count: number) => { failFrom = count; },
    fs: {
      isDirectory: (target) => target === "/proj" || target === "/anchor",
      mkdir: async (dir) => { dirs.push(dir); },
      append: async (file, text) => {
        appendCalls += 1;
        if (appendCalls > failFrom) throw new Error("disk full");
        files.set(file, (files.get(file) ?? "") + text);
      },
      // Byte-accurate like the real fs: size reports UTF-8 BYTES (stat semantics).
      size: async (file) =>
        sizeOverrides.get(file) ?? (files.has(file) ? Buffer.byteLength(files.get(file) ?? "", "utf8") : -1),
      rename: async (from, to) => {
        renames.push({ from, to });
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      },
    },
  };
}

describe("delivery diagnostics: decoupled dual sink", () => {
  it("TUT_DELIVERY_DIAG follows the legacy switch: on when unset or exactly 1, off otherwise", () => {
    expect(diagEnabled({})).toBe(true);
    expect(diagEnabled({ TUT_DELIVERY_DIAG: "1" })).toBe(true);
    expect(diagEnabled({ TUT_DELIVERY_DIAG: "0" })).toBe(false);
    expect(diagEnabled({ TUT_DELIVERY_DIAG: "true" })).toBe(false);
    expect(diagEnabled({ TUT_DELIVERY_DIAG: "2" })).toBe(false);
  });

  it("both sinks carry the same events; the file adds task/role context and keeps order", async () => {
    const stderr: string[] = [];
    const mem = memoryFs();
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      task_id: "t-pr",
      role: "architect",
      stderr: (text) => stderr.push(text),
      clock: () => 1_700_000_000_000,
      fs: mem.fs,
    });
    sink.emit("gate-start pane=p1");
    sink.emit("send-text pane=p1 branch=born len=9");
    await sink.flush();
    expect(stderr).toEqual([
      "tut-delivery t=1700000000000 gate-start pane=p1\n",
      "tut-delivery t=1700000000000 send-text pane=p1 branch=born len=9\n",
    ]);
    const file = mem.files.get("/proj/.context-hub/delivery.log") ?? "";
    expect(file).toBe(
      "tut-delivery t=1700000000000 task=t-pr role=architect gate-start pane=p1\n" +
      "tut-delivery t=1700000000000 task=t-pr role=architect send-text pane=p1 branch=born len=9\n",
    );
  });

  it("lazy persistence: nothing is created on disk until the first line; a silenced run touches nothing", async () => {
    const mem = memoryFs();
    const silent = createDeliveryDiagnostics({
      env: { TUT_DELIVERY_DIAG: "0", TUT_PROJECT_ROOT: "/proj" },
      fs: mem.fs,
    });
    silent.emit("gate-start pane=p1");
    await silent.flush();
    expect(mem.dirs).toHaveLength(0);
    // Enabled but never emitting: still nothing (lazy setup).
    const quiet = createDeliveryDiagnostics({ env: { TUT_PROJECT_ROOT: "/proj" }, fs: mem.fs });
    await quiet.flush();
    expect(mem.dirs).toHaveLength(0);
  });

  it("TUT_PROJECT_ROOT must be a real directory — otherwise the anchor-root fallback serves the durable tail", async () => {
    const mem = memoryFs();
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/not-a-dir" },
      persistRootFallback: "/anchor",
      task_id: "t",
      role: "executor",
      stderr: () => undefined,
      fs: mem.fs,
    });
    sink.emit("gate-release pane=p1");
    await sink.flush();
    expect(mem.files.has("/anchor/.context-hub/delivery.log")).toBe(true);
    expect(mem.files.has("/not-a-dir/.context-hub/delivery.log")).toBe(false);
  });

  it("no resolvable root → stderr only, never a delivery failure", async () => {
    const stderr: string[] = [];
    const sink = createDeliveryDiagnostics({ env: {}, stderr: (t) => stderr.push(t), fs: memoryFs().fs });
    sink.emit("gate-start pane=p1");
    await sink.flush();
    expect(stderr).toHaveLength(1);
  });

  it("the first failing append disables persistence for the run — stderr keeps its line", async () => {
    const stderr: string[] = [];
    const mem = memoryFs();
    mem.failAppendAfter(0);
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      stderr: (t) => stderr.push(t),
      fs: mem.fs,
    });
    sink.emit("first");
    sink.emit("second");
    sink.emit("third");
    await sink.flush();
    expect(stderr).toHaveLength(3); // the observer never loses the stderr timeline
    expect([...mem.files.values()].join("")).toBe(""); // nothing persisted after the failure
  });

  it("task/role default to ? when unknown (the persisted line stays parseable)", async () => {
    const mem = memoryFs();
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      clock: () => 42,
      stderr: () => undefined,
      fs: mem.fs,
    });
    sink.emit("gate-start pane=p1");
    await sink.flush();
    expect(mem.files.get("/proj/.context-hub/delivery.log")).toBe(
      "tut-delivery t=42 task=? role=? gate-start pane=p1\n",
    );
  });
});

// ---- clock-deadline phase windows --------------------------------------------------

describe("gate and land windows are CLOCK deadlines", () => {
  it("herdr read latency spends the gate window — a 3ms read cost halves a 10ms window's polls", async () => {
    // Costless reads would fit 10 polls; at 3ms per read the window admits
    // only two before the deadline. The nominal 15s/5s production windows
    // can no longer be stretched proportionally by slow herdr spawns.
    const vt = virtualClock();
    const fake = fakeClient({
      pre: ["base", "base", "base", "base", "base", "base", "base", "base", "base", "base", "base", "base"],
      post: [""],
      clock: vt,
      costs: { read: 3 },
    });
    const h = harness(fake, { TUT_READY_TIMEOUT_MS: "10" }, undefined, vt);
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    const lines = fields(h.lines());
    expect(lines).toContain("gate-timeout pane=p1 idx=2 len=4"); // baseline + TWO polls, not ten
    expect(h.errors().join("")).toContain("not observed ready within 10ms — delivering anyway");
    const gateReads = fake.calls.slice(0, fake.calls.findIndex((c) => c.startsWith("send-text"))).filter((c) => c === "read").length;
    expect(gateReads).toBe(3); // baseline read + two polls — latency accounted
  });

  it("herdr read latency spends the land window — the text-match loop ends on the clock", async () => {
    const vt = virtualClock();
    const fake = fakeClient({
      pre: ["seat"],
      postReads: ["seat v2", "seat v3", "seat v4", "seat v5"], // changes, never the prompt
      clock: vt,
      costs: { read: 2, "send-text": 2 },
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "6", TUT_SUBMIT_RETRY_TIMEOUT_MS: "4" }, undefined, vt);
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    const lines = fields(h.lines());
    expect(lines).toContain("land-timeout pane=p1 idx=2 len=7"); // 2 reads at 2ms cost + 1ms polls inside 6ms
    expect(h.errors().join("")).toContain("prompt text not observed on p1 within 6ms");
  });
});

// ---- a read returning past the deadline never reports success ---------------------

/**
 * Bespoke client for deadline-straddle cases: each read burns a per-call
 * budget (`burnsPre`/`burnsPost`, default 0), so a read that STARTS inside
 * a phase deadline can be made to RETURN past it — exactly the
 * async-control-call latency the strict clock boundary must govern.  The
 * screen model mirrors fakeClient (pre in order before send-text, post in
 * order after it; each list's last entry repeats).
 */
function straddleClient(vt: VirtualClock, options: {
  pre: string[];
  post: string[];
  burnsPre?: number[];
  burnsPost?: number[];
}): ReturnType<typeof fakeClient> {
  const calls: string[] = [];
  let enters = 0;
  let preIdx = 0;
  let postIdx = 0;
  let textSent = false;
  const burn = (list: number[] | undefined, index: number): void => {
    const value = list?.[Math.min(index, (list ?? []).length - 1)] ?? 0;
    vt.advance(value);
  };
  const client: DeliveryClient = {
    readPane: async () => {
      calls.push("read");
      if (!textSent) {
        burn(options.burnsPre, preIdx);
        return options.pre[Math.min(preIdx++, options.pre.length - 1)] ?? "";
      }
      burn(options.burnsPost, postIdx);
      return options.post[Math.min(postIdx++, options.post.length - 1)] ?? "";
    },
    sendText: async (_paneId, text) => {
      calls.push(`send-text prompt len=${text.length}`);
      textSent = true;
      return true;
    },
    sendKeys: async (_paneId, key) => {
      calls.push(`send-keys ${key}`);
      enters += 1;
      return true;
    },
  };
  return { client, calls, enters: () => enters, timed: () => [] };
}

describe("a read that straddles the deadline never reports success (strict clock boundary)", () => {
  it("gate: a quiescent-ready screen returning past the deadline is a timeout, not a release", async () => {
    // Stability is reached in-budget, but the floor holds the release until
    // the third poll — whose read returns at deadline+2 with the SAME ready
    // screen.  Old behavior: gate-release at t=12.  Strict deadline: the
    // budget is spent, the only honest outcome is gate-timeout (+ deliver
    // anyway, unchanged) — no success is reported from past the deadline.
    const vt = virtualClock();
    const fake = straddleClient(vt, {
      pre: ["", "A", "A", "A"],
      post: [""],
      burnsPre: [0, 0, 0, 9],
    });
    const h = harness(fake, {
      ...FAST,
      TUT_READY_FLOOR_MS: "8",
      TUT_READY_TIMEOUT_MS: "10",
      TUT_READY_STABLE_POLLS: "2",
      TUT_TEXT_LAND_TIMEOUT_MS: "2",
      TUT_SUBMIT_TIMEOUT_MS: "1",
      TUT_SUBMIT_RETRY_MS: "1",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "2",
    }, undefined, vt);
    await expect(h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" })).resolves.toBe(true);
    const lines = fields(h.lines());
    expect(lines).toContain("gate-timeout pane=p1 idx=3 len=1");
    expect(lines.some((l) => l.includes("gate-release"))).toBe(false);
    expect(h.errors().join("")).toContain("not observed ready within 10ms — delivering anyway");
    expect(promptSends(fake.calls)).toHaveLength(1); // timeout still delivers (never worse)
  });

  it("land: a matching screen returning past the deadline is a timeout — a real late landing is adopted by the wait phase", async () => {
    // The second land read would match (old behavior: land-observed at
    // t=11>deadline=4).  Strict deadline: land-timeout, landed=false — and
    // the no-blind-Enter wait then observes the text on its OWN clock and
    // submits exactly one informed Enter.
    const vt = virtualClock();
    const fake = straddleClient(vt, {
      pre: ["seat"],
      post: ["", "▎hello （tut delivery A1B2C3D4）"],
      burnsPost: [0, 9],
    });
    const h = harness(fake, {
      ...FAST,
      TUT_TEXT_LAND_TIMEOUT_MS: "4",
      TUT_SUBMIT_TIMEOUT_MS: "1",
      TUT_SUBMIT_RETRY_MS: "2",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "2",
    }, undefined, vt);
    await expect(h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" })).resolves.toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-timeout pane=p1 idx=2"))).toBe(true);
    expect(lines.some((l) => l.includes("land-observed pane=p1"))).toBe(false); // no success past the deadline
    expect(lines.some((l) => l.includes("land-late pane=p1"))).toBe(true); // the wait phase adopts it, in budget
    expect(fake.enters()).toBe(1); // one informed Enter — only after the text was observed
  });

  it("confirm recheck: a re-verification read returning past the deadline revokes the confirm", async () => {
    // submit-confirmed fires in-budget; the recheck read straddles the
    // deadline and returns a still-cleared screen at t=12>deadline=4.  The
    // observation updates the evidence, but the confirmation cannot stand
    // on budget spent — revoked, the loop never returns success.
    const vt = virtualClock();
    const fake = straddleClient(vt, {
      pre: ["seat"],
      post: ["▎hello （tut delivery A1B2C3D4）", "round started", "round started"],
      burnsPost: [0, 0, 9],
    });
    const h = harness(fake, {
      ...FAST,
      TUT_TEXT_LAND_TIMEOUT_MS: "4",
      TUT_SUBMIT_TIMEOUT_MS: "2",
      TUT_SUBMIT_RETRY_MS: "2",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "3",
    }, undefined, vt);
    await expect(h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" })).resolves.toBe(true);
    const lines = fields(h.lines());
    expect(lines).toContain("submit-confirmed pane=p1 attempt=1 phase=verify idx=0");
    expect(lines).toContain("confirm-revoked pane=p1 attempt=1 reason=budget");
    expect(lines.some((l) => l.includes("confirm-rechecked"))).toBe(false);
    expect(lines.some((l) => l.includes("give-up pane=p1 attempts=1") && l.includes("reason=box-cleared-unconfirmed"))).toBe(true);
    expect(fake.enters()).toBe(1);
  });
});

// ---- post-confirm re-verification + suffix-rule box evidence ----------------------

describe("a submit-confirmed must survive one re-verification read", () => {
  it("p6 shape in the loop: a startup repaint flips the bottom region but the nonce still ENDS the rows — held, resend, real commit", async () => {
    // The 09-01 p6 live shape: the banner/[Context] redraw changed the
    // bottom region within ~0.5s of the Enter — the old region-diff
    // criterion read "cleared" and confirmed while the composer still held
    // the text. The suffix rule keeps it held; the clocked resend then
    // commits for real.
    const fake = fakeClient({
      pre: ["", "", "ui", "ui", "ui", "ui"],
      post: [
        "ui ▎hello （tut delivery A1B2C3D4）",
        "[Context] loading 42 files ▎hello （tut delivery A1B2C3D4）",
        "working",
      ],
    });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "10" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    // The repaint read is HELD (box=held on the read line), never a confirm.
    expect(lines.some((l) => l.startsWith("read pane=p1 ") && l.includes("box=held") && l.includes("[Context]"))).toBe(true);
    expect(lines.some((l) => l.startsWith("submit-confirmed pane=p1 attempt=1 "))).toBe(false);
    // The resend commits; the confirmation survives its recheck.
    expect(lines.some((l) => /^submit-confirmed pane=p1 attempt=2 phase=loop/u.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("confirm-rechecked pane=p1 attempt=2 box=cleared"))).toBe(true);
    expect(lines.some((l) => l.startsWith("give-up"))).toBe(false);
    expect(fake.enters()).toBe(2);
    expect(promptSends(fake.calls)).toHaveLength(1); // the text itself is never re-sent
  });

  it("a transient cleared is revoked by the recheck — the loop continues and a later real cleared stands", async () => {
    const withText = "seat ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({
      pre: ["seat"],
      postReads: [withText, "x1", "cleared transient", withText, "working", "working"],
    });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "8", TUT_SUBMIT_RETRY_MS: "8", TUT_SUBMIT_RETRY_TIMEOUT_MS: "12" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = h.lines();
    const first = lines.findIndex((l) => l.includes("submit-confirmed pane=p1 attempt=1 phase=verify idx=0"));
    const revoked = lines.findIndex((l) => l.includes("confirm-revoked pane=p1 attempt=1 box=held"));
    const second = lines.findIndex((l) => l.includes("submit-confirmed pane=p1 attempt=1 phase=verify idx=1"));
    const rechecked = lines.findIndex((l) => l.includes("confirm-rechecked pane=p1 attempt=1 box=cleared"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(revoked).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(revoked);
    expect(rechecked).toBeGreaterThan(second);
    expect(fake.enters()).toBe(1); // a revoked confirmation triggers NO extra Enter
    expect(lines.some((l) => l.startsWith("give-up"))).toBe(false);
  });
});

// ---- the born never-landed wait slides on screen activity --------------------------

describe("the born landwait budget adapts to parallel cold starts", () => {
  it("late echo past the base window, screen still painting — the deadline slides, the landing is adopted, the Enter commits", async () => {
    // The 09-01 p7/p8 shape: three cold starts, the send-text echo renders
    // past the whole submit budget while the TUI keeps painting. The wait
    // slides one window per observed change (capped); the text then lands,
    // the submit budget anchors AT the landing, one informed Enter commits.
    const fake = fakeClient({
      pre: ["", "", "boot", "boot", "boot", "boot"],
      postReads: [
        "boot 1", "boot 2", // the land loop times out (window 2)
        "boot 3", "boot 4", "boot 5", "boot 6", "boot 7", "boot 8", // wait reads, each a CHANGE
        "composer ▎hello （tut delivery A1B2C3D4）", // lands at t=14 — past the base window end (13)
        "working", "working",
      ],
    });
    const h = harness(fake, {
      TUT_TEXT_LAND_TIMEOUT_MS: "2",
      TUT_SUBMIT_TIMEOUT_MS: "2",
      TUT_SUBMIT_RETRY_MS: "1",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "6", // base 6ms, born cap 12ms
    });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = h.lines();
    const extensions = fields(lines).filter((l) => l.startsWith("land-wait-extend pane=p1 "));
    expect(extensions.length).toBeGreaterThanOrEqual(3); // the window actually slid
    // The cap holds: no slid deadline exceeds start + 2×window (=12ms).
    for (const line of extensions) {
      const deadlineMs = Number(line.match(/deadline_ms=(\d+)/u)?.[1] ?? Number.NaN);
      expect(deadlineMs).toBeLessThanOrEqual(12);
    }
    const lateAt = tOf(lines, "land-late pane=p1 ");
    expect(lateAt).toBeGreaterThanOrEqual(14); // past the base window (start 7 + 6 = 13)
    // The submit budget anchored AT the landing: the Enter follows within the fresh window.
    const submitAt = tOf(lines, "submit pane=p1 ");
    expect(submitAt).toBe(lateAt);
    expect(fields(lines).some((l) => /^submit-confirmed pane=p1 attempt=1 /u.test(l))).toBe(true);
    expect(fields(lines).some((l) => l.startsWith("confirm-rechecked pane=p1 attempt=1"))).toBe(true);
    expect(fake.enters()).toBe(1);
    expect(fields(lines).some((l) => l.startsWith("give-up"))).toBe(false);
  });

  it("a STATIC textless born screen never slides — give-up at the base window, attempts=0", async () => {
    const fake = fakeClient({
      pre: ["", "", "boot", "boot", "boot", "boot"],
      postReads: ["boot 2", "boot 2"], // frozen after the land timeout: no activity, no slide
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "6" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-wait-extend"))).toBe(false);
    expect(lines.some((l) => l.startsWith("give-up pane=p1 ") && l.includes("attempts=0") && l.includes("reason=land-never-observed") && l.includes("elapsed_ms=6"))).toBe(true);
    expect(fake.enters()).toBe(0);
    // The static give-up does not claim an extended wait.
    expect(h.errors().join("")).toContain("within 6ms after 0 Enters");
    expect(h.errors().join("")).not.toContain("wait ran");
  });

  it("an extended born wait that still never lands gives up honestly with the extended-wait note", async () => {
    // Repainting-forever fixture: every post-text read differs (activity
    // without landing) — the wait slides to the cap, the text never comes.
    const changing = Array.from({ length: 40 }, (_, i) => `paint ${i + 1}`);
    const fake = fakeClient({ pre: ["", "", "boot", "boot", "boot", "boot"], postReads: changing });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "6" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-wait-extend"))).toBe(true);
    // The cap bounds the slide at start + 2×6 = 12ms: give-up with the extended-wait note.
    expect(lines.some((l) => l.startsWith("give-up pane=p1 ") && l.includes("attempts=0") && l.includes("reason=land-never-observed"))).toBe(true);
    expect(h.errors().join("")).toContain("wait ran 12ms — the window slid while the screen kept changing");
    expect(fake.enters()).toBe(0);
  });

  it("a continuation pane never slides its wait — the base window is the whole budget", async () => {
    const fake = fakeClient({
      pre: ["seat"],
      postReads: Array.from({ length: 40 }, (_, i) => `tick ${i + 1}`), // alive and changing, text never lands
    });
    const h = harness(fake, { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "6" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("land-wait-extend"))).toBe(false);
    expect(lines.some((l) => l.startsWith("give-up pane=p1 ") && l.includes("attempts=0") && l.includes("elapsed_ms=6") && l.includes("reason=land-never-observed"))).toBe(true);
    expect(fake.enters()).toBe(0);
  });
});

// ---- probe reads feed the box evidence; dead dispatches read nothing ---------------

describe("probe reads are observations too", () => {
  it("a dispatch that never went out starts NO read — the probe result is honestly empty", async () => {
    const failed = fakeClient({ pre: ["seat"], post: ["seat ▎hello （tut delivery A1B2C3D4）", "working"], probeDispatch: ["failed"] });
    const sent = fakeClient({ pre: ["seat"], post: ["seat ▎hello （tut delivery A1B2C3D4）", "working"] });
    const a = harness(failed);
    const b = harness(sent);
    await a.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    await b.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    const readsA = failed.calls.filter((c) => c === "read").length;
    const readsB = sent.calls.filter((c) => c === "read").length;
    expect(readsA).toBe(readsB - 1); // exactly the probe's read was skipped
    expect(fields(a.lines()).some((l) => /^probe-result pane=p1 attempt=1 phase=initial marker=TUT-DELIVERY-PROBE-[0-9A-F]{8} dispatch=failed found=false len=0 tail=''$/u.test(l))).toBe(true);
    // The delivery still confirms on transport+box evidence (probe is diagnostic only).
    expect(fields(a.lines()).some((l) => /^submit-confirmed pane=p1 attempt=1 /u.test(l))).toBe(true);
    expect(failed.enters()).toBe(1);
  });
});

// ---- the held-frozen stop-loss -----------------------------------------------------

describe("a frozen held screen stops the Enter loop early", () => {
  it("byte-identical held screens across the stall streak give up before the budget burns out", async () => {
    const held = "seat ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["seat"], post: [held] }); // never changes, never clears
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "60" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true); // the stop-loss is still an exit-0 degradation
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("held-stall pane=p1 polls="))).toBe(true);
    const giveUp = lines.find((l) => l.startsWith("give-up pane=p1 "));
    expect(giveUp).toContain("box=held");
    expect(giveUp).toContain("reason=box-held");
    const elapsed = Number(giveUp?.match(/elapsed_ms=(\d+)/u)?.[1] ?? Number.NaN);
    expect(elapsed).toBeLessThan(60); // NOT the full budget — the stop-loss fired
    // The guidance stays the held wording (the text IS still in the box).
    expect(h.errors().join("")).toContain(giveUpGuidance("held"));
    expect(h.errors().join("")).toContain("submit not confirmed on p1 after"); // no false "within 60ms"
    // Enter spam bounded: far fewer than the ~55 a full window would admit.
    expect(fake.enters()).toBeLessThanOrEqual(45);
    expect(promptSends(fake.calls)).toHaveLength(1);
  });

  it("a held screen that eventually changes never trips the streak (multi-swallow recovery intact)", async () => {
    const held = "seat ▎hello （tut delivery A1B2C3D4）";
    const fake = fakeClient({ pre: ["seat"], post: [held, held, held, held, held, "working"] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "12" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("held-stall"))).toBe(false);
    expect(lines.some((l) => /^submit-confirmed pane=p1 attempt=5 phase=loop/u.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("give-up"))).toBe(false);
  });
});

// ---- diagnostics hardening --------------------------------------------------------

describe("delivery diagnostics: rotation and the never-rejecting chain", () => {
  it("delivery.log rotates by size — one .1 generation kept, the active file restarts", async () => {
    const mem = memoryFs();
    mem.files.set("/proj/.context-hub/delivery.log", "OLD");
    mem.sizeOverrides.set("/proj/.context-hub/delivery.log", DELIVERY_LOG_MAX_BYTES + 10); // already over cap
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      clock: () => 7,
      stderr: () => undefined,
      fs: mem.fs,
    });
    sink.emit("first");
    sink.emit("second");
    await sink.flush();
    expect(mem.renames).toEqual([
      { from: "/proj/.context-hub/delivery.log", to: "/proj/.context-hub/delivery.log.1" },
    ]);
    expect(mem.files.get("/proj/.context-hub/delivery.log.1")).toBe("OLD");
    expect(mem.files.get("/proj/.context-hub/delivery.log")).toBe(
      "tut-delivery t=7 task=? role=? first\ntut-delivery t=7 task=? role=? second\n",
    );
  });

  it("rotation counts UTF-8 BYTES — multi-byte fields rotate before the byte cap, one .1 kept", async () => {
    // Non-ASCII diag fields (pane tails carry user text) make a line's byte
    // length exceed its character length.  The size ledger must count
    // BYTES (fs.size semantics), or a multibyte-heavy log overshoots the
    // cap before rotation fires.
    const mem = memoryFs();
    mem.files.set("/proj/.context-hub/delivery.log", "OLD");
    mem.sizeOverrides.set("/proj/.context-hub/delivery.log", DELIVERY_LOG_MAX_BYTES - 10); // 10 bytes left
    const sink = createDeliveryDiagnostics({
      env: { TUT_PROJECT_ROOT: "/proj" },
      clock: () => 7,
      stderr: () => undefined,
      fs: mem.fs,
    });
    // 30 CJK chars = 90 bytes: over the 10 remaining bytes in BYTES, well
    // under in characters — the old character-count check missed it.
    sink.emit(`tail='あ${"い".repeat(29)}'`);
    await sink.flush();
    expect(mem.renames).toEqual([
      { from: "/proj/.context-hub/delivery.log", to: "/proj/.context-hub/delivery.log.1" },
    ]);
    expect(mem.files.get("/proj/.context-hub/delivery.log.1")).toBe("OLD");
    const active = mem.files.get("/proj/.context-hub/delivery.log") ?? "";
    expect(active).toContain("あ"); // the multibyte line itself survived
    expect(Buffer.byteLength(active, "utf8")).toBeLessThanOrEqual(DELIVERY_LOG_MAX_BYTES);

    // A second overshoot rotates again — onto the SAME .1 name: at most one
    // rotated generation ever exists.  (The big line itself stays under the
    // cap; the FILE crosses it, so the NEXT append is what rotates.)
    sink.emit("y".repeat(DELIVERY_LOG_MAX_BYTES - 100));
    sink.emit("z");
    await sink.flush();
    expect(mem.renames).toHaveLength(2);
    expect(new Set(mem.renames.map((r) => r.to)).size).toBe(1); // one .1 target
    expect((mem.files.get("/proj/.context-hub/delivery.log") ?? "")).toContain("t=7 task=? role=? z");
  });

  it("a throwing fs seam never rejects flush — the exit-0 invariant survives diagnostics faults", async () => {
    const boom: DiagnosticsFs = {
      isDirectory: () => { throw new Error("stat exploded"); },
      mkdir: async () => undefined,
      append: async () => undefined,
      size: async () => -1,
      rename: async () => undefined,
    };
    const sink = createDeliveryDiagnostics({ env: { TUT_PROJECT_ROOT: "/proj" }, stderr: () => undefined, fs: boom });
    sink.emit("gate-start pane=p1");
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});

// ---- acceptance: the 09-01 three-pane parallel cold start, replayed ----------------

describe("parallel cold-start e2e (09-01 incident replay)", () => {
  it("three concurrent deliveries: late-echo recovery, repaint false-positive killed, static give-up — zero false confirms", async () => {
    // p7/p8 shape: echo past the base window while the TUI keeps painting.
    const lateEcho = harness(fakeClient({
      pre: ["", "", "boot", "boot", "boot", "boot"],
      postReads: [
        "boot 1", "boot 2",
        "boot 3", "boot 4", "boot 5", "boot 6", "boot 7", "boot 8",
        "composer ▎hello （tut delivery A1B2C3D4）",
        "working", "working",
      ],
    }), { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "6" });
    // p6 shape: startup repaint flips the bottom region right after the Enter.
    const repaint = harness(fakeClient({
      pre: ["", "", "ui", "ui", "ui", "ui"],
      post: [
        "ui ▎hello （tut delivery A1B2C3D4）",
        "[Context] loading 42 files ▎hello （tut delivery A1B2C3D4）",
        "working",
      ],
    }), { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "10" });
    // Static shape: textless frozen screen — honest attempts=0 give-up.
    const frozen = harness(fakeClient({
      pre: ["", "", "boot", "boot", "boot", "boot"],
      postReads: ["boot 2"],
    }), { TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "6" });

    const results = await Promise.all([
      lateEcho.delivery.deliver({ paneId: "p7", prompt: "hello", branch: "born" }),
      repaint.delivery.deliver({ paneId: "p6", prompt: "hello", branch: "born" }),
      frozen.delivery.deliver({ paneId: "p8", prompt: "hello", branch: "born" }),
    ]);
    expect(results).toEqual([true, true, true]); // every degradation keeps exit-0 semantics

    const lateLines = fields(lateEcho.lines());
    expect(lateLines.some((l) => /^submit-confirmed pane=p7 attempt=1 /u.test(l))).toBe(true);
    expect(lateLines.some((l) => l.startsWith("confirm-rechecked pane=p7"))).toBe(true);
    expect(lateLines.some((l) => l.startsWith("give-up"))).toBe(false);

    const repaintLines = fields(repaint.lines());
    expect(repaintLines.some((l) => l.startsWith("submit-confirmed pane=p6 attempt=1 "))).toBe(false); // the p6 false positive is dead
    expect(repaintLines.some((l) => /^submit-confirmed pane=p6 attempt=2 phase=loop/u.test(l))).toBe(true);
    expect(repaintLines.some((l) => l.startsWith("confirm-rechecked pane=p6"))).toBe(true);
    expect(repaintLines.some((l) => l.startsWith("give-up"))).toBe(false);

    const frozenLines = fields(frozen.lines());
    expect(frozenLines.some((l) => l.startsWith("submit-confirmed"))).toBe(false);
    expect(frozenLines.some((l) => l.startsWith("give-up pane=p8 ") && l.includes("attempts=0") && l.includes("reason=land-never-observed"))).toBe(true);
  });
});

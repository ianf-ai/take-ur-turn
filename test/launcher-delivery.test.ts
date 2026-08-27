// Unit coverage for the ported delivery loop and its dual-sink diagnostics
// (launcher port unit 5). The named behaviors from the design's must-cover
// list are tested here against injectable seams; the launch.sh fixture
// regressions (test/cli-assign-launch.test.ts, test/launcher-fresh.test.ts)
// remain the end-to-end authority and are untouched.
import { describe, expect, it } from "vitest";
import {
  boxCleared,
  createDelivery,
  createDeliveryDiagnostics,
  diagEnabled,
  diagTail,
  parseDeliveryKnobs,
  screenBottom,
  type DeliveryClient,
  type DeliveryDiagnostics,
  type DiagnosticsFs,
} from "../src/launcher/delivery.js";
import { createDeliveryClient } from "../src/launcher/compat.js";

// ---- harness -------------------------------------------------------------------

/** Fast knobs: 1ms poll so every window is an exact poll count. */
const FAST = {
  TUT_READY_POLL_MS: "1",
  TUT_READY_FLOOR_MS: "0",
  TUT_READY_TIMEOUT_MS: "10",
  TUT_TEXT_LAND_TIMEOUT_MS: "4",
  TUT_SUBMIT_TIMEOUT_MS: "2",
  TUT_SUBMIT_RETRY_MS: "2",
  TUT_SUBMIT_RETRY_TIMEOUT_MS: "8",
};

/**
 * Fake delivery client with the fixture's causal screen model: pre-text
 * reads (gate baseline + polls, or the continuation snapshot) serve `pre`
 * in order (last repeats); post-text reads are indexed by ENTER COUNT
 * (`post[enters]`, last repeats) — independent of poll cadence.
 */
function fakeClient(options: {
  pre: string[];
  post: string[];
  failSendText?: boolean;
  failSendKeys?: boolean;
}): {
  client: DeliveryClient;
  calls: string[];
  enters: () => number;
} {
  const calls: string[] = [];
  let preIdx = 0;
  let enters = 0;
  let textSent = false;
  const client: DeliveryClient = {
    readPane: async () => {
      calls.push("read");
      if (!textSent) {
        const screen = options.pre[Math.min(preIdx, options.pre.length - 1)] ?? "";
        preIdx += 1;
        return screen;
      }
      return options.post[Math.min(enters, options.post.length - 1)] ?? "";
    },
    sendText: async (_paneId, text) => {
      calls.push(`send-text len=${text.length}`);
      textSent = true;
      return options.failSendText !== true;
    },
    sendKeys: async (_paneId, key) => {
      calls.push(`send-keys ${key}`);
      enters += 1;
      return options.failSendKeys !== true;
    },
  };
  return { client, calls, enters: () => enters };
}

/** Collect the diagnostics lines (stand-in for the stderr sink). */
function lineSink(): { diagnostics: DeliveryDiagnostics; lines: () => string[] } {
  const lines: string[] = [];
  return {
    diagnostics: { emit: (fields) => lines.push(fields), flush: async () => undefined },
    lines: () => lines,
  };
}

function harness(
  fake: ReturnType<typeof fakeClient>,
  env: NodeJS.ProcessEnv = {},
): {
  delivery: ReturnType<typeof createDelivery>;
  diagnostics: DeliveryDiagnostics;
  lines: () => string[];
  errors: () => string[];
} {
  const sink = lineSink();
  const errors: string[] = [];
  return {
    diagnostics: sink.diagnostics,
    lines: sink.lines,
    errors: () => errors,
    delivery: createDelivery({
      client: fake.client,
      diagnostics: sink.diagnostics,
      env: { ...FAST, ...env },
      delayFn: async () => undefined,
      stderr: (text) => errors.push(text),
    }),
  };
}

const fields = (lines: string[]): string[] => lines.map((line) => line.replace(/^tut-delivery t=\d+ /u, ""));

// ---- pure helpers ---------------------------------------------------------------

describe("delivery screen helpers", () => {
  it("screenBottom takes the last non-empty lines with trailing whitespace trimmed", () => {
    expect(screenBottom("a\nb\nc\nd  \n\ne\n", 3)).toBe("c\nd\ne");
    expect(screenBottom("  x \ty\r\n", 3)).toBe("  x \ty");
    expect(screenBottom("", 3)).toBe("");
    // Whitespace-only lines drop out entirely (the awk NF rule).
    expect(screenBottom("a\n   \nb", 3)).toBe("a\nb");
  });

  it("boxCleared: only a non-empty screen whose bottom region changed confirms", () => {
    expect(boxCleared("", "sig")).toBe(false); // empty read is a glitch
    expect(boxCleared("same\nbottom", "same\nbottom")).toBe(false); // region unchanged
    expect(boxCleared("same\nbottom", "other")).toBe(true);
    // Repaints above the 3-line region do not count.
    expect(boxCleared("repaint\nx\ny\nz", "x\ny\nz")).toBe(false);
  });

  it("the degraded land-timeout baseline (empty region) lets any non-empty screen confirm — preserving the known live-operations failure mode", () => {
    // Land-confirm timed out with an unpainted screen → the with-text
    // snapshot is empty → signature is "" → ANY non-empty screen confirms.
    // This is the historical probabilistic false-positive window, kept
    // behavior-equivalent on purpose (its fix is a separate work unit).
    expect(boxCleared("anything at all", "")).toBe(true);
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
    // (0/0): the cadence clamp keeps every division finite.
    expect(parseDeliveryKnobs({
      TUT_READY_POLL_MS: "0",
      TUT_READY_FLOOR_MS: "0",
      TUT_READY_TIMEOUT_MS: "0",
      TUT_TEXT_LAND_TIMEOUT_MS: "0",
      TUT_SUBMIT_TIMEOUT_MS: "0",
      TUT_SUBMIT_RETRY_MS: "0",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "0",
    })).toEqual({
      pollMs: 1,
      readyFloorMs: 0,
      readyTimeoutMs: 0,
      textLandTimeoutMs: 0,
      submitTimeoutMs: 0,
      submitRetryMs: 1,
      submitRetryWindowMs: 1,
    });
  });

  it("TUT_SUBMIT_RETRIES and TUT_SUBMIT_READY_TIMEOUT_MS are inert legacy knobs — carrying them changes nothing", async () => {
    // The fixture-level live variant lives in cli-start-next tests; here the
    // parse itself ignores them, and a full delivery with them set produces
    // the identical call sequence as without.
    const without = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎prompt", "working"] });
    const withLegacy = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎prompt", "working"] });
    const a = harness(without);
    const b = harness(withLegacy, { TUT_SUBMIT_RETRIES: "2", TUT_SUBMIT_READY_TIMEOUT_MS: "999" });
    await a.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    await b.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(withLegacy.calls).toEqual(without.calls);
    expect(fields(b.lines())).toEqual(fields(a.lines()));
  });
});

// ---- the closed loop (named design tests) ----------------------------------------

describe("born readiness uses the visible stable baseline", () => {
  it("releases only after change-from-baseline + a stable pair + the floor poll", async () => {
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎prompt", "working"] });
    const h = harness(fake);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    // Gate: base read + poll("") + paint("ui") + the stable pair release.
    expect(fake.calls.slice(0, 4)).toEqual(["read", "read", "read", "read"]);
    expect(fields(h.lines())[0]).toBe("gate-start pane=p1 floor_ms=0 timeout_ms=10");
    expect(fields(h.lines())).toContain("gate-release pane=p1 idx=2 len=2 tail='ui'");
    // The gate-release screen is the land baseline: the very next read after
    // send-text sees the landed prompt and observes the land immediately.
    expect(fields(h.lines())).toContain("land-observed pane=p1 idx=0 len=10 tail='ui ▎prompt'");
  });

  it("an unchanged-from-baseline or unstable screen never releases — timeout degrades to delivering anyway", async () => {
    const fake = fakeClient({ pre: ["base", "base", "base"], post: [""] });
    const h = harness(fake, { TUT_READY_TIMEOUT_MS: "3", TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "2" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // degradation never fails the launch
    expect(h.errors().join("")).toContain("not observed ready within 3ms — delivering anyway");
    expect(fields(h.lines())).toContain("gate-timeout pane=p1 idx=3 len=4");
  });

  it("the floor holds the gate even when the screen is stable before it", async () => {
    // Stable paint at polls 0-1, floor at poll 2: no release until idx>=2.
    const fake = fakeClient({ pre: ["", "ui", "ui", "ui", "ui"], post: ["ui ▎prompt", "working"] });
    const h = harness(fake, { TUT_READY_FLOOR_MS: "3" }); // floor = 3 polls
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    const release = fields(h.lines()).find((l) => l.startsWith("gate-release"));
    expect(release).toBe("gate-release pane=p1 idx=3 len=2 tail='ui'");
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
  it("healthy path: ONE Enter, the verify read confirms, no resend", async () => {
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎prompt", "working"] });
    const h = harness(fake);
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(fake.calls.filter((c) => c === "send-keys Enter")).toHaveLength(1);
    expect(fields(h.lines())).toContain("submit-confirmed pane=p1 attempt=1 phase=verify idx=0");
    expect(h.errors().join("")).not.toContain("resending");
  });

  it("swallowed first Enter → clocked resend loop → the second Enter commits", async () => {
    // post[enters]: after Enter1 the composer still holds; after Enter2 it
    // lets go — the causal fixture shape (observed live-race window).
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎prompt", "ui ▎prompt", "working"] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(fake.enters()).toBe(2);
    expect(h.errors().join("")).toContain("resending Enter (attempt 2)");
    expect(h.errors().join("")).toContain("input box cleared on p1 — submit confirmed (attempt 2)");
    expect(fields(h.lines())).toContain("submit-confirmed pane=p1 attempt=2 phase=loop idx=2");
    // The text was sent exactly once — resends are Enter only.
    expect(fake.calls.filter((c) => c.startsWith("send-text"))).toHaveLength(1);
  });

  it("multi-swallow: the loop keeps resending on the clock until the box clears", async () => {
    const held = "codex shell ▎prompt";
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: [held, held, held, held, held, "working"] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "12" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(fake.enters()).toBe(5);
    expect(fake.calls.filter((c) => c.startsWith("send-text"))).toHaveLength(1); // text never re-sent
    expect(fields(h.lines()).some((l) => /^submit-confirmed pane=p1 attempt=5 phase=loop/u.test(l))).toBe(true);
  });

  it("an empty read is a glitch: it never confirms and never crashes the loop", async () => {
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: [""] });
    const h = harness(fake, { TUT_SUBMIT_RETRY_TIMEOUT_MS: "3" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // read failures degrade, never fail the launch
  });

  it("send-keys failures are loud notes, not delivery failures", async () => {
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: ["ui ▎prompt", "ui ▎prompt", "working"] });
    fake.client.sendKeys = async () => false;
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "1" });
    await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(h.errors().join("")).toContain("herdr pane send-keys p1 Enter failed (initial attempt)");
    expect(h.errors().join("")).toContain("herdr pane send-keys p1 Enter failed (attempt 2)");
  });
});

describe("give-up does not duplicate the prompt", () => {
  it("window exhaustion: bounded clocked resends, manual-fallback note, still reports success", async () => {
    const held = "ui ▎prompt";
    const fake = fakeClient({ pre: ["", "", "ui", "ui"], post: [held] });
    const h = harness(fake, { TUT_SUBMIT_TIMEOUT_MS: "2", TUT_SUBMIT_RETRY_MS: "2", TUT_SUBMIT_RETRY_TIMEOUT_MS: "5" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true); // exit 0: a failure exit would re-trigger duplicate delivery
    expect(fake.calls.filter((c) => c.startsWith("send-text"))).toHaveLength(1); // the prompt is never duplicated
    // Clock cadence: one Enter per retry interval (2 polls), bounded by the
    // 5-poll window — initial + resends at steps 1/3/5.
    expect(fake.enters()).toBe(4);
    const errors = h.errors().join("");
    expect(errors).toContain("submit not confirmed on p1 within 5ms after");
    expect(errors).toContain("press Enter there manually to start the round");
    expect(fields(h.lines())).toContain("give-up pane=p1 attempts=4 window_ms=5");
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

  it("gate timeout → land timeout → submit window: every step notes and keeps going", async () => {
    const fake = fakeClient({ pre: [""], post: [""] });
    const h = harness(fake, { TUT_READY_TIMEOUT_MS: "2", TUT_TEXT_LAND_TIMEOUT_MS: "2", TUT_SUBMIT_TIMEOUT_MS: "1", TUT_SUBMIT_RETRY_TIMEOUT_MS: "2" });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "born" });
    expect(ok).toBe(true);
    const errors = h.errors().join("");
    expect(errors).toContain("not observed ready within 2ms — delivering anyway");
    expect(errors).toContain("text landing not observed on p1 within 2ms — submitting anyway");
    expect(errors).toContain("submit not confirmed on p1 within 2ms after");
    // The empty screen can never confirm; the bounded loop DID resend.
    expect(fake.enters()).toBeGreaterThanOrEqual(2);
  });
});

describe("same-role continuation skips the born readiness gate but runs the same land/submit loop", () => {
  it("snapshot read → send-text → land → verified submit; no gate diagnostics", async () => {
    const fake = fakeClient({ pre: ["idle seat"], post: ["idle seat ▎prompt", "working"] });
    const h = harness(fake);
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    const lines = fields(h.lines());
    expect(lines.some((l) => l.startsWith("gate-start"))).toBe(false);
    expect(lines[0]).toBe("read pane=p1 step=snapshot idx=0 len=9 tail='idle seat'");
    expect(lines).toContain("send-text pane=p1 branch=continuation len=5");
    expect(lines).toContain("land-observed pane=p1 idx=0 len=17 tail='idle seat ▎prompt'");
    expect(lines).toContain("submit-confirmed pane=p1 attempt=1 phase=verify idx=0");
    expect(fake.calls[0]).toBe("read"); // the snapshot sits directly before the text
    expect(fake.calls[1]).toBe("send-text len=5");
  });

  it("a swallowed continuation Enter gets the same bounded resend loop (one delivery code path)", async () => {
    const fake = fakeClient({ pre: ["idle seat"], post: ["idle seat ▎prompt", "idle seat ▎prompt", "working"] });
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
  // The harness's no-op delayFn keeps the clamped 1ms cadence instant.
  it("born: readiness, land and submit/retry all return within finite windows; exhaustion still exits 0 with the manual fallback", async () => {
    // The screen never changes and never clears: gate, land and submit each
    // run their full (finite) window and degrade in sequence.
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
    expect(fake.calls.filter((c) => c.startsWith("send-text"))).toHaveLength(1); // the prompt is sent exactly once
    const errors = h.errors().join("");
    expect(errors).toContain("not observed ready within 3ms — delivering anyway");
    expect(errors).toContain("text landing not observed on p1 within 2ms — submitting anyway");
    expect(errors).toContain("submit not confirmed on p1 within 6ms after 4 Enters");
    expect(errors).toContain("press Enter there manually to start the round");
    expect(fields(h.lines())).toContain("give-up pane=p1 attempts=4 window_ms=6");
  });

  it("continuation with a holding screen (the review's repro shape): the bounded resend loop still ends", async () => {
    const held = "seat ▎prompt";
    const fake = fakeClient({ pre: ["seat"], post: [held] });
    const h = harness(fake, {
      TUT_READY_POLL_MS: "0",
      TUT_SUBMIT_TIMEOUT_MS: "2",
      TUT_SUBMIT_RETRY_MS: "2",
      TUT_SUBMIT_RETRY_TIMEOUT_MS: "5",
    });
    const ok = await h.delivery.deliver({ paneId: "p1", prompt: "hello", branch: "continuation" });
    expect(ok).toBe(true);
    expect(fake.calls.filter((c) => c.startsWith("send-text"))).toHaveLength(1);
    // Bounded by the 5-poll window: initial Enter + resends at steps 1/3/5.
    expect(fake.enters()).toBe(4);
    expect(fields(h.lines())).toContain("give-up pane=p1 attempts=4 window_ms=5");
    expect(h.errors().join("")).toContain("press Enter there manually to start the round");
  });
});

// ---- the dual-sink diagnostics observer ------------------------------------------

function memoryFs(): {
  fs: DiagnosticsFs;
  dirs: string[];
  files: Map<string, string>;
  failAppendAfter: (count: number) => void;
} {
  const dirs: string[] = [];
  const files = new Map<string, string>();
  let appendCalls = 0;
  let failFrom = Number.POSITIVE_INFINITY;
  return {
    dirs,
    files,
    failAppendAfter: (count: number) => { failFrom = count; },
    fs: {
      isDirectory: (target) => target === "/proj" || target === "/anchor",
      mkdir: async (dir) => { dirs.push(dir); },
      append: async (file, text) => {
        appendCalls += 1;
        if (appendCalls > failFrom) throw new Error("disk full");
        files.set(file, (files.get(file) ?? "") + text);
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

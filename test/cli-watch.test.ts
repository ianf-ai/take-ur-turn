import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tut watch (three-state exit codes + start-next-aligned task selection) —
// parse layer first; handler behavior below with a stubbed /state (the same
// discipline as test/cli-start-next.test.ts: a synthetic fetch queue, since
// watch is a pure /state consumer). --interval 0 keeps the poll loop tight.

import { main, parseArgs } from "../src/cli.js";

// --- parse -----------------------------------------------------------------------

describe("watch (parse)", () => {
  it("no-arg parses with undefined task_id and default url/interval", () => {
    expect(parseArgs(["watch"])).toEqual({
      command: "watch",
      url: "http://127.0.0.1:3001",
      interval: 5,
    });
  });

  it("keeps explicit task_id and flags (both flag forms)", () => {
    expect(parseArgs(["watch", "t1", "--url", "http://x:1", "--interval", "3"])).toEqual({
      command: "watch",
      task_id: "t1",
      url: "http://x:1",
      interval: 3,
    });
    expect(parseArgs(["watch", "--interval=2"])).toEqual({
      command: "watch",
      url: "http://127.0.0.1:3001",
      interval: 2,
    });
  });

  it("extra positionals rejected", () => {
    expect(parseArgs(["watch", "t1", "t2"]).command).toBe("usage");
  });

  it("unknown flag rejected", () => {
    expect(parseArgs(["watch", "--nope"]).command).toBe("usage");
  });

  it("non-integer interval rejected", () => {
    expect(parseArgs(["watch", "--interval", "fast"]).command).toBe("usage");
  });
});

// --- handler helpers -------------------------------------------------------------

/** Capture process stdout/stderr into strings for the duration of a handler run. */
function captureIo(): { out: () => string; err: () => string; restore: () => void } {
  let outText = "";
  let errText = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    outText += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errText += String(chunk);
    return true;
  });
  return { out: () => outText, err: () => errText, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

/** /state task fixture — only the fields watch consumes. */
interface StateTask {
  task_id: string;
  status: string;
  waiting_for: string;
  needs_attention?: boolean;
  version?: number;
}

/**
 * Stub global fetch as a /state response QUEUE: each poll shifts one entry (a
 * task list, or an Error to simulate an unreachable hub). An exhausted queue
 * sticks on its last entry so a watch that never sees a change cannot fake
 * one. Returns the mock for call-count assertions.
 */
function stubStateQueue(responses: Array<StateTask[] | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift() ?? responses.at(-1);
    if (next instanceof Error) throw next;
    return { ok: true, status: 200, json: async () => ({ flow_mode: "manual", tasks: next }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// --- handler: the three exit states ----------------------------------------------

describe("watch handler (three-state exit codes, /state stubbed)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    vi.unstubAllGlobals();
  });

  it("exit 0 — round boundary: a new record advanced the state to an agent's turn", async () => {
    const fetchMock = stubStateQueue([
      [{ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 1 }],
      [{ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", version: 2 }],
    ]);

    const code = await main(["watch", "t1", "--interval", "0"]);

    expect(code).toBe(0);
    const out = io.out();
    expect(out).toContain("t1 advanced to v2");
    expect(out).toContain("status=reviewing");
    expect(out).toContain("waiting_for=agent:reviewer");
    expect(out).toContain("round boundary");
    expect(io.err()).toContain("polling every 0s"); // baseline line precedes the loop
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exit 0 — round boundary includes the pending_approval human gate", async () => {
    stubStateQueue([
      [{ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 1 }],
      [{ task_id: "t1", status: "pending_approval", waiting_for: "human", version: 2 }],
    ]);

    const code = await main(["watch", "t1", "--interval", "0"]);

    expect(code).toBe(0);
    expect(io.out()).toContain("status=pending_approval");
    expect(io.out()).toContain("waiting_for=human");
    expect(io.out()).toContain("round boundary");
  });

  it("exit 0 — a note-only bump (same status/waiting) is still a reportable boundary", async () => {
    stubStateQueue([
      [{ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 1 }],
      [{ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 2 }],
    ]);

    const code = await main(["watch", "t1", "--interval", "0"]);

    expect(code).toBe(0);
    expect(io.out()).toContain("round boundary");
  });

  it("exit 2 — terminal: approved", async () => {
    stubStateQueue([
      [{ task_id: "t1", status: "pending_approval", waiting_for: "human", version: 3 }],
      [{ task_id: "t1", status: "approved", waiting_for: "human", version: 4 }],
    ]);

    const code = await main(["watch", "t1", "--interval", "0"]);

    expect(code).toBe(2);
    expect(io.out()).toContain("terminal state: approved");
    expect(io.out()).toContain("v4");
  });

  it("exit 2 — terminal: closed", async () => {
    stubStateQueue([
      [{ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", version: 3 }],
      [{ task_id: "t1", status: "closed", waiting_for: "none", version: 4 }],
    ]);

    const code = await main(["watch", "t1", "--interval", "0"]);

    expect(code).toBe(2);
    expect(io.out()).toContain("terminal state: closed");
  });

  it("exit 3 — needs attention", async () => {
    stubStateQueue([
      [{ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", version: 2 }],
      [{ task_id: "t1", status: "revising", waiting_for: "human", needs_attention: true, version: 3 }],
    ]);

    const code = await main(["watch", "t1", "--interval", "0"]);

    expect(code).toBe(3);
    expect(io.out()).toContain("needs attention");
    expect(io.out()).toContain("tut read t1");
  });

  it("baseline already terminal exits immediately (single fetch, no polling)", async () => {
    const fetchMock = stubStateQueue([[{ task_id: "t1", status: "closed", waiting_for: "none", version: 5 }]]);

    const code = await main(["watch", "t1"]);

    expect(code).toBe(2);
    expect(io.out()).toContain("terminal state: closed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("baseline already needs-attention exits immediately (exit 3)", async () => {
    const fetchMock = stubStateQueue([
      [{ task_id: "t1", status: "implementing", waiting_for: "human", needs_attention: true, version: 2 }],
    ]);

    const code = await main(["watch", "t1"]);

    expect(code).toBe(3);
    expect(io.out()).toContain("needs attention");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no change keeps polling — only the moved state exits", async () => {
    const same = [{ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 1 }];
    const fetchMock = stubStateQueue([
      same,
      same,
      same,
      [{ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", version: 2 }],
    ]);

    const code = await main(["watch", "t1", "--interval", "0"]);

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("transient hub outage is retried, never read as a state change (one throttled warning)", async () => {
    stubStateQueue([
      [{ task_id: "t1", status: "implementing", waiting_for: "agent:executor", version: 1 }],
      new Error("boom: connection refused"),
      new Error("boom: connection refused"),
      [{ task_id: "t1", status: "reviewing", waiting_for: "agent:reviewer", version: 2 }],
    ]);

    const code = await main(["watch", "t1", "--interval", "0"]);

    expect(code).toBe(0);
    const warnings = io.err().match(/hub unreachable/g) ?? [];
    expect(warnings).toHaveLength(1); // throttled: one line per outage, not per failure
  });

  it("hub unreachable at baseline exits 1 with a diagnostic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    const code = await main(["watch", "t1"]);

    expect(code).toBe(1);
    expect(io.err()).toContain("cannot read state");
  });
});

// --- handler: task selection aligned with start-next ------------------------------

describe("watch task selection (aligned with start-next)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    vi.unstubAllGlobals();
  });

  it("no-arg: the unique agent-waiting task is selected (human-waiting ignored)", async () => {
    stubStateQueue([
      [
        { task_id: "t-human", status: "pending_approval", waiting_for: "human", version: 4 },
        { task_id: "t-unique", status: "implementing", waiting_for: "agent:executor", version: 1 },
      ],
      [
        { task_id: "t-human", status: "pending_approval", waiting_for: "human", version: 4 },
        { task_id: "t-unique", status: "reviewing", waiting_for: "agent:reviewer", version: 2 },
      ],
    ]);

    const code = await main(["watch", "--interval", "0"]);

    expect(code).toBe(0);
    expect(io.out()).toContain("t-unique advanced to v2");
  });

  it("no-arg with zero agent-waiting tasks fails like start-next (lists human-waiting)", async () => {
    stubStateQueue([[{ task_id: "t-human", status: "pending_approval", waiting_for: "human", version: 4 }]]);

    const code = await main(["watch"]);

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("tut: no task is waiting for an agent");
    expect(io.err()).toContain("tasks waiting for a human:");
    expect(io.err()).toContain("t-human");
  });

  it("no-arg with multiple agent-waiting tasks fails like start-next (list, never guess)", async () => {
    stubStateQueue([
      [
        { task_id: "t-a", status: "implementing", waiting_for: "agent:executor", version: 1 },
        { task_id: "t-b", status: "reviewing", waiting_for: "agent:reviewer", version: 2 },
      ],
    ]);

    const code = await main(["watch"]);

    expect(code).toBe(1);
    expect(io.err()).toContain("pass a task_id explicitly");
    expect(io.err()).toContain("t-a");
    expect(io.err()).toContain("t-b");
  });

  it("explicit task_id absent from /state exits 1 with TASK_NOT_FOUND as the first stderr line", async () => {
    stubStateQueue([[{ task_id: "t-other", status: "implementing", waiting_for: "agent:executor", version: 1 }]]);

    const code = await main(["watch", "ghost-task"]);

    expect(code).toBe(1);
    expect(io.err().split("\n")[0]).toBe("tut: TASK_NOT_FOUND: no task ghost-task in /state");
  });
});

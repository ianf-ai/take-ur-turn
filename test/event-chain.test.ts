/**
 * Canonical Node event chain (system-design 7.2 signal-source contract):
 *
 *   herdr → scripts/herdr-hook.mjs   (stdin payload → filter/map/state/label)
 *         → scripts/on-agent-event.mjs (JSON.stringify body, fetch +
 *           AbortController 2s, unreachable → exit 0, contract error → exit 1)
 *         → notifier POST /agent-event
 *
 * plus the POSIX thin shims (on-agent-event.sh, hook.sh) that only forward,
 * and the package file list that must ship it all.
 *
 * Standing rule (cf. integration.full-stack): no mocks of our own code — every
 * case runs REAL child processes against REAL HTTP/TCP listeners. The parity
 * block additionally runs the vendored LEGACY hook (test/fixtures/legacy-herdr-hook.sh,
 * the deployed pre-Node hook) side by side with the Node hook: the Windows
 * Node hook must be semantically identical to the old hook (mapping, idle
 * rule, label fallback, exit-0 degradation). The always-on scenario matrix is
 * transcribed from system-design 7.2 + the deployed hook so it also pins the
 * behavior on platforms where the legacy hook cannot run.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = path.join(ROOT, "scripts");
const ON_AGENT_EVENT_MJS = path.join(SCRIPTS, "on-agent-event.mjs");
const ON_AGENT_EVENT_SH = path.join(SCRIPTS, "on-agent-event.sh");
const HERDR_HOOK_MJS = path.join(SCRIPTS, "herdr-hook.mjs");
const HOOK_SH = path.join(SCRIPTS, "hook.sh");
const HERDR_FIXTURE = fileURLToPath(new URL("./bin/herdr", import.meta.url));
const LEGACY_HOOK = fileURLToPath(new URL("./fixtures/legacy-herdr-hook.sh", import.meta.url));

const PANE = "w1:p1";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** herdr 0.8 empirical envelope, delivered on stdin (new) / env (legacy). */
const hookPayload = (status: string, paneId: string = PANE, agent: string | null = "codex") =>
  JSON.stringify({
    event: "pane_agent_status_changed",
    data: { pane_id: paneId, workspace_id: "w1", agent_status: status, agent },
  });

// --- process / listener helpers --------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin?.end(options.stdin ?? "", "utf8");
  });
}

const runNode = (script: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}) =>
  run(process.execPath, [script, ...args], options);

interface CapturedRequest {
  method: string;
  url: string;
  contentType: string;
  body: string;
}

interface CaptureServer {
  server: Server;
  port: number;
  url: string;
  requests: CapturedRequest[];
}

const openServers: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(openServers.map((entry) => entry.close()));
});

async function startCaptureServer(
  respond: (body: string) => { status: number; payload?: string } = () => ({ status: 200, payload: '{"ok":true}' }),
): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: String(req.headers["content-type"] ?? ""),
        body,
      });
      const { status, payload } = respond(body);
      res.statusCode = status;
      if (payload !== undefined) res.setHeader("content-type", "application/json");
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  openServers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  });
  return { server, port, url: `http://127.0.0.1:${port}/agent-event`, requests };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpRoot = () => mkdtempSync(path.join(tmpdir(), "tut-event-chain-"));

function entryEnv(url: string): NodeJS.ProcessEnv {
  return { ...process.env, TUT_EVENT_PORT_URL: url };
}

function hookEnv(url: string, stateDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TUT_EVENT_PORT_URL: url,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    TUT_HERDR_EXECUTABLE: HERDR_FIXTURE,
    ...overrides,
  };
}

async function runNodeHook(stdin: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return runNode(HERDR_HOOK_MJS, [], { env, stdin });
}

interface Delivered {
  event: string;
  agent: string;
  pane: string;
}

const deliveries = (capture: CaptureServer): Delivered[] =>
  capture.requests.map((request) => JSON.parse(request.body) as Delivered);

/**
 * The hook exits only after the forwarded event's fetch completed, so positive
 * deliveries are already settled when the child exits; only scenarios whose
 * last step deliberately delivers nothing need a small negative-settle wait.
 */
async function expectDeliveries(capture: CaptureServer, expected: Delivered[], settleNegative: boolean) {
  if (capture.requests.length < expected.length) {
    await waitFor(
      () => (capture.requests.length >= expected.length ? true : undefined),
      4000,
      `event deliveries (${expected.length} expected)`,
    );
  }
  if (settleNegative) await sleep(350);
  expect(deliveries(capture)).toEqual(expected);
}

/** Default fixture label: `pane get` serves "<pane_id>:label" unless overridden. */
const fixtureLabel = (paneId: string = PANE) => `${paneId}:label`;

// --- on-agent-event.mjs: canonical transport -------------------------------------------

describe("on-agent-event.mjs (canonical entry: argv contract + fetch transport)", () => {
  it.each(["working", "blocked", "done"])(
    "forwards %s with the exact JSON.stringify body and exits 0",
    async (event) => {
      const capture = await startCaptureServer();
      const result = await runNode(ON_AGENT_EVENT_MJS, [event, "codex", "task-7.executor"], {
        env: entryEnv(capture.url),
      });
      expect(result.code).toBe(0);
      await expectDeliveries(
        capture,
        [{ event, agent: "codex", pane: "task-7.executor" }],
        false,
      );
      const request = capture.requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/agent-event");
      expect(request.contentType).toContain("application/json");
      expect(request.body).toBe(JSON.stringify({ event, agent: "codex", pane: "task-7.executor" }));
    },
    8000,
  );

  it("preserves spaces and Unicode in agent/pane byte-for-byte (JSON.stringify, not printf)", async () => {
    const capture = await startCaptureServer();
    const agent = "àgent ✓ ünicode";
    const pane = "ta sk with spaces.rolé";
    const result = await runNode(ON_AGENT_EVENT_MJS, ["working", agent, pane], { env: entryEnv(capture.url) });
    expect(result.code).toBe(0);
    await expectDeliveries(capture, [{ event: "working", agent, pane }], false);
    expect(capture.requests[0]!.body).toBe(JSON.stringify({ event: "working", agent, pane }));
  }, 8000);

  it("exits 1 on argv contract violations (arity)", async () => {
    for (const args of [[], ["working", "codex"], ["working", "codex", "p1", "extra"]]) {
      const result = await runNode(ON_AGENT_EVENT_MJS, args, { env: entryEnv("http://127.0.0.1:9/agent-event") });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("usage:");
    }
  }, 8000);

  it("exits 1 on an event outside working|blocked|done (idle is a hook-level status, never an entry event)", async () => {
    const result = await runNode(ON_AGENT_EVENT_MJS, ["idle", "codex", "p1"], { env: entryEnv("http://127.0.0.1:9/agent-event") });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage:");
  }, 8000);

  it("exits 0 when the notifier is unreachable (a lost event is acceptable; polling is the primary channel)", async () => {
    const result = await runNode(ON_AGENT_EVENT_MJS, ["done", "codex", "some-task"], {
      env: entryEnv("http://127.0.0.1:9/agent-event"), // nothing listens there
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("cannot reach");
  }, 8000);

  it("exits 0 on a non-2xx notifier response, with a diagnostic only", async () => {
    const capture = await startCaptureServer(() => ({ status: 500, payload: '{"error":"boom"}' }));
    const result = await runNode(ON_AGENT_EVENT_MJS, ["done", "codex", "p1"], { env: entryEnv(capture.url) });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("responded 500");
  }, 8000);

  it("aborts the fetch after 2s against a server that accepts but never answers, then exits 0", async () => {
    // Track the sockets so teardown can destroy them: a bare net.Server's
    // close() waits for open connections forever, and the aborted fetch leaves
    // the server side half-tracked (masked by process.exit in manual runs).
    const sockets = new Set<{ destroy: () => void; on: (event: string, fn: () => void) => void }>();
    const silent = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }); // accepts the connection, never responds
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as { port: number }).port;
    try {
      const started = Date.now();
      const result = await runNode(ON_AGENT_EVENT_MJS, ["working", "codex", "p1"], {
        env: entryEnv(`http://127.0.0.1:${port}/agent-event`),
      });
      expect(result.code).toBe(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      expect(result.stderr).toContain("timed out after 2000ms");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 12000);

  it("uses the local default URL when TUT_EVENT_PORT_URL is unset or empty", async () => {
    const requests: string[] = [];
    const server = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        requests.push(body);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
    });
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(3002, "127.0.0.1", () => resolve(true));
    });
    if (!listening) {
      // Port 3002 busy (e.g. a real notifier running) — cannot pin the default.
      console.warn("event-chain: port 3002 busy — default-URL fallback test skipped");
      return;
    }
    try {
      const envUnset = { ...process.env };
      delete envUnset.TUT_EVENT_PORT_URL;
      const unset = await runNode(ON_AGENT_EVENT_MJS, ["working", "codex", "p1"], { env: envUnset });
      expect(unset.code).toBe(0);
      const empty = await runNode(ON_AGENT_EVENT_MJS, ["done", "codex", "p1"], {
        env: { ...process.env, TUT_EVENT_PORT_URL: "" },
      });
      expect(empty.code).toBe(0);
      expect(requests).toEqual([
        JSON.stringify({ event: "working", agent: "codex", pane: "p1" }),
        JSON.stringify({ event: "done", agent: "codex", pane: "p1" }),
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 12000);
});

// --- herdr-hook.mjs: canonical hook ----------------------------------------------------

describe("herdr-hook.mjs (stdin payload, state, mapping, label resolution)", () => {
  it.each(["working", "blocked", "done"])("maps %s straight through and exits 0", async (status) => {
    const capture = await startCaptureServer();
    const stateDir = tmpRoot();
    const result = await runNodeHook(hookPayload(status), hookEnv(capture.url, stateDir));
    expect(result.code).toBe(0);
    await expectDeliveries(capture, [{ event: status, agent: "codex", pane: fixtureLabel() }], false);
    rmSync(stateDir, { recursive: true, force: true });
  }, 8000);

  it("maps idle → done only when the previous state was working (focused-pane rule)", async () => {
    const capture = await startCaptureServer();
    const stateDir = tmpRoot();
    const env = hookEnv(capture.url, stateDir);
    expect((await runNodeHook(hookPayload("working"), env)).code).toBe(0);
    expect((await runNodeHook(hookPayload("idle"), env)).code).toBe(0);
    await expectDeliveries(
      capture,
      [
        { event: "working", agent: "codex", pane: fixtureLabel() },
        { event: "done", agent: "codex", pane: fixtureLabel() },
      ],
      false,
    );
    rmSync(stateDir, { recursive: true, force: true });
  }, 8000);

  it("ignores idle when the previous state was done or blocked (no false alerts)", async () => {
    for (const previous of ["done", "blocked", "idle"] as const) {
      const capture = await startCaptureServer();
      const stateDir = tmpRoot();
      const env = hookEnv(capture.url, stateDir);
      await runNodeHook(hookPayload(previous), env);
      expect((await runNodeHook(hookPayload("idle"), env)).code).toBe(0);
      await expectDeliveries(
        capture,
        previous === "idle" ? [] : [{ event: previous, agent: "codex", pane: fixtureLabel() }],
        true,
      );
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 10000);

  it("keeps per-pane state as SHA-256(pane_id) files with last-status content and no temp leftovers", async () => {
    const capture = await startCaptureServer();
    const stateDir = tmpRoot();
    const unicodePane = "wé:2 ü";
    const env = hookEnv(capture.url, stateDir);
    await runNodeHook(hookPayload("working"), env);
    await runNodeHook(hookPayload("idle"), env);
    await runNodeHook(hookPayload("done", unicodePane), env);

    const files = readdirSync(stateDir).sort();
    expect(files).toEqual([sha256(PANE), sha256(unicodePane)].sort());
    for (const name of files) expect(name).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path.join(stateDir, sha256(PANE)), "utf8")).toBe("idle"); // last STATUS, not the mapped event
    expect(readFileSync(path.join(stateDir, sha256(unicodePane)), "utf8")).toBe("done");
    expect(files.some((name) => name.includes(".tmp"))).toBe(false); // temp+rename leaves no residue
    rmSync(stateDir, { recursive: true, force: true });
  }, 8000);

  it.each([
    ["not json at all", "bad payload"],
    ["", "bad payload"],
    ['"just a string"', "bad payload"],
    ['{"data":"not an object"}', "bad payload"],
    ['{"data":{"agent_status":"working","agent":"codex"}}', "bad payload"], // no pane_id
    [`{"data":{"pane_id":"w1:p1","agent_status":"working"}}`, "bad payload"], // no agent
    [`{"data":{"pane_id":"w1:p1","agent_status":"working","agent":null}}`, "bad payload"], // agent null
    [`{"data":{"pane_id":"w1:p1","agent_status":"unknown","agent":"codex"}}`, "unknown agent_status"],
  ])("degrades to stderr + exit 0 on bad input (%s)", async (stdin, expectedDiag) => {
    const capture = await startCaptureServer();
    const stateDir = tmpRoot();
    const result = await runNodeHook(stdin, hookEnv(capture.url, stateDir));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(expectedDiag);
    await expectDeliveries(capture, [], true);
    rmSync(stateDir, { recursive: true, force: true });
  }, 8000);

  it("resolves the pane label via raw-argv `herdr pane get` and forwards the label", async () => {
    const capture = await startCaptureServer();
    const stateDir = tmpRoot();
    const herdrLog = path.join(stateDir, "herdr.log");
    const label = "task with spaces ✓.executor";
    const result = await runNodeHook(hookPayload("working"), hookEnv(capture.url, stateDir, {
      TUT_HERDR_PANE_LABEL: label,
      TUT_HERDR_LOG: herdrLog,
    }));
    expect(result.code).toBe(0);
    await expectDeliveries(capture, [{ event: "working", agent: "codex", pane: label }], false);
    expect(readFileSync(herdrLog, "utf8")).toContain(`pane get ${PANE}`); // raw argv through the shared fixture
    rmSync(stateDir, { recursive: true, force: true });
  }, 8000);

  it("forwards the raw pane_id when the label cannot be obtained — never guesses", async () => {
    for (const overrides of [
      { TUT_HERDR_FAIL: "pane:get" }, // pane get exits non-zero
      { TUT_HERDR_PANE_LABEL_RAW: "not json" }, // pane get returns invalid JSON
      { TUT_HERDR_PANE_LABEL: "" }, // response carries no usable label
    ] as NodeJS.ProcessEnv[]) {
      const capture = await startCaptureServer();
      const stateDir = tmpRoot();
      const result = await runNodeHook(hookPayload("working"), hookEnv(capture.url, stateDir, overrides));
      expect(result.code).toBe(0);
      await expectDeliveries(capture, [{ event: "working", agent: "codex", pane: PANE }], false);
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 10000);

  it("keeps working when the state root itself contains spaces and Unicode", async () => {
    const capture = await startCaptureServer();
    const stateDir = path.join(tmpRoot(), "stäte dir ✓");
    const result = await runNodeHook(hookPayload("working"), hookEnv(capture.url, stateDir));
    expect(result.code).toBe(0);
    await expectDeliveries(capture, [{ event: "working", agent: "codex", pane: fixtureLabel() }], false);
    expect(existsSync(path.join(stateDir, sha256(PANE)))).toBe(true);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(path.dirname(stateDir), { recursive: true, force: true });
  }, 8000);

  it("inherits TUT_EVENT_PORT_URL down to the canonical entry (plugin env propagation)", async () => {
    const capture = await startCaptureServer();
    const stateDir = tmpRoot();
    const env = hookEnv(capture.url, stateDir);
    // No TUT_EVENT_PORT_URL is passed anywhere else: the hook's env is the
    // single source the forwarded entry inherits from.
    const result = await runNodeHook(hookPayload("done"), env);
    expect(result.code).toBe(0);
    await expectDeliveries(capture, [{ event: "done", agent: "codex", pane: fixtureLabel() }], false);
    rmSync(stateDir, { recursive: true, force: true });
  }, 8000);
});

// --- parity with the legacy hook -------------------------------------------------------

/**
 * Scenario matrix transcribed from system-design 7.2 and the deployed legacy
 * hook: this is the observable semantics the Windows Node hook must reproduce.
 */
const PARITY_SCENARIOS: { name: string; statuses: string[]; expected: string[] }[] = [
  { name: "working passes through", statuses: ["working"], expected: ["working"] },
  { name: "blocked passes through", statuses: ["blocked"], expected: ["blocked"] },
  { name: "done passes through", statuses: ["done"], expected: ["done"] },
  { name: "cold idle is ignored (launch-time detection)", statuses: ["idle"], expected: [] },
  { name: "idle after working maps to done (focused/seen-tab finish)", statuses: ["working", "idle"], expected: ["working", "done"] },
  { name: "idle after done is ignored (done-then-seen)", statuses: ["done", "idle"], expected: ["done"] },
  { name: "idle after blocked is ignored (blocked-then-answered)", statuses: ["blocked", "idle"], expected: ["blocked"] },
  { name: "unknown status is ignored (not a TUT agent pane)", statuses: ["unknown"], expected: [] },
  {
    name: "full round trip working→blocked→working→idle→done",
    statuses: ["working", "blocked", "working", "idle", "done"],
    expected: ["working", "blocked", "working", "done", "done"],
  },
];

describe("Windows Node hook keeps the legacy hook's semantics (scenario matrix)", () => {
  for (const scenario of PARITY_SCENARIOS) {
    it(`legacy semantics: ${scenario.name}`, async () => {
      const capture = await startCaptureServer();
      const stateDir = tmpRoot();
      const env = hookEnv(capture.url, stateDir);
      for (const status of scenario.statuses) {
        const result = await runNodeHook(hookPayload(status), env);
        expect(result.code).toBe(0);
      }
      await expectDeliveries(
        capture,
        scenario.expected.map((event) => ({ event, agent: "codex", pane: fixtureLabel() })),
        scenario.expected.length === 0,
      );
      rmSync(stateDir, { recursive: true, force: true });
    }, 10000);
  }
});

const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const hasPython3 = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(process.platform === "win32" || !hasSh || !hasPython3)(
  "A/B parity: Node hook vs the vendored legacy hook (identical delivered sequences)",
  () => {
    for (const scenario of PARITY_SCENARIOS) {
      it(`both hooks deliver the same sequence: ${scenario.name}`, async () => {
        // One capture server PER hook: the assertion compares each hook's own
        // delivered sequence against the legacy semantics, then against each other.
        const nodeCapture = await startCaptureServer();
        const legacyCapture = await startCaptureServer();
        const nodeState = tmpRoot();
        const legacyState = tmpRoot();
        const nodeEnv = hookEnv(nodeCapture.url, nodeState);
        const legacyEnv: NodeJS.ProcessEnv = {
          ...process.env,
          TUT_EVENT_PORT_URL: legacyCapture.url,
          HERDR_PLUGIN_STATE_DIR: legacyState,
          HERDR_BIN_PATH: HERDR_FIXTURE,
          TUT_ON_AGENT_EVENT: ON_AGENT_EVENT_SH,
        };
        for (const status of scenario.statuses) {
          expect((await runNodeHook(hookPayload(status), nodeEnv)).code).toBe(0);
          const legacy = await run(LEGACY_HOOK, [], {
            env: { ...legacyEnv, HERDR_PLUGIN_EVENT_JSON: hookPayload(status) },
            stdin: "",
          });
          expect(legacy.code).toBe(0);
        }
        const expected = scenario.expected.map((event) => ({ event, agent: "codex", pane: fixtureLabel() }));
        await expectDeliveries(nodeCapture, expected, scenario.expected.length === 0);
        await expectDeliveries(legacyCapture, expected, scenario.expected.length === 0);
        rmSync(nodeState, { recursive: true, force: true });
        rmSync(legacyState, { recursive: true, force: true });
      }, 12000);
    }

    it("legacy hook still ignores payloads the matrix treats as bad (sanity: the fixture is the old hook)", async () => {
      const capture = await startCaptureServer();
      const legacyState = tmpRoot();
      const legacyEnv: NodeJS.ProcessEnv = {
        ...process.env,
        TUT_EVENT_PORT_URL: capture.url,
        HERDR_PLUGIN_STATE_DIR: legacyState,
        HERDR_BIN_PATH: HERDR_FIXTURE,
        TUT_ON_AGENT_EVENT: ON_AGENT_EVENT_SH,
      };
      const coldIdle = await run(LEGACY_HOOK, [], { env: { ...legacyEnv, HERDR_PLUGIN_EVENT_JSON: hookPayload("idle") }, stdin: "" });
      const unknown = await run(LEGACY_HOOK, [], {
        env: { ...legacyEnv, HERDR_PLUGIN_EVENT_JSON: hookPayload("unknown") },
        stdin: "",
      });
      const noAgent = await run(LEGACY_HOOK, [], {
        env: { ...legacyEnv, HERDR_PLUGIN_EVENT_JSON: hookPayload("working", PANE, null) },
        stdin: "",
      });
      expect([coldIdle.code, unknown.code, noAgent.code]).toEqual([0, 0, 0]);
      await expectDeliveries(capture, [], true);
      rmSync(legacyState, { recursive: true, force: true });
    }, 10000);
  },
);

// --- POSIX thin shims ------------------------------------------------------------------

describe("POSIX thin shims forward only (argv, stdin and exit codes pass through)", () => {
  it("on-agent-event.sh forwards to the canonical entry: contract errors keep exit 1", async () => {
    const result = await run(ON_AGENT_EVENT_SH, ["idle", "codex", "p1"], {
      env: entryEnv("http://127.0.0.1:9/agent-event"),
      stdin: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage:");
  }, 8000);

  it("on-agent-event.sh forwards a valid event byte-for-byte", async () => {
    const capture = await startCaptureServer();
    const result = await run(ON_AGENT_EVENT_SH, ["blocked", "codex", "task-7.executor"], {
      env: entryEnv(capture.url),
      stdin: "",
    });
    expect(result.code).toBe(0);
    await expectDeliveries(capture, [{ event: "blocked", agent: "codex", pane: "task-7.executor" }], false);
    expect(capture.requests[0]!.body).toBe(JSON.stringify({ event: "blocked", agent: "codex", pane: "task-7.executor" }));
  }, 8000);

  it("hook.sh forwards the stdin payload into the canonical hook", async () => {
    const capture = await startCaptureServer();
    const stateDir = tmpRoot();
    const result = await run(HOOK_SH, [], { env: hookEnv(capture.url, stateDir), stdin: hookPayload("working") });
    expect(result.code).toBe(0);
    await expectDeliveries(capture, [{ event: "working", agent: "codex", pane: fixtureLabel() }], false);
    rmSync(stateDir, { recursive: true, force: true });
  }, 8000);

  it("hook.sh keeps exit 0 on a bad payload (degradation passes through)", async () => {
    const capture = await startCaptureServer();
    const stateDir = tmpRoot();
    const result = await run(HOOK_SH, [], { env: hookEnv(capture.url, stateDir), stdin: "not json" });
    expect(result.code).toBe(0);
    await expectDeliveries(capture, [], true);
    rmSync(stateDir, { recursive: true, force: true });
  }, 8000);
});

describe.skipIf(process.platform === "win32")(
  "package layout with spaces and Unicode (shims + package-relative siblings)",
  () => {
    it("runs the whole chain from a package directory whose path contains spaces and Unicode", async () => {
      const capture = await startCaptureServer();
      const packageDir = path.join(tmpRoot(), "páck age ✓", "scripts");
      const payloadDir = path.join(tmpRoot(), "state ünits");
      mkdirSync(packageDir, { recursive: true });
      for (const name of ["on-agent-event.mjs", "herdr-hook.mjs", "on-agent-event.sh", "hook.sh"]) {
        copyFileSync(path.join(SCRIPTS, name), path.join(packageDir, name));
      }
      // (a) canonical entry runs from the awkward path
      const entry = await runNode(path.join(packageDir, "on-agent-event.mjs"), ["working", "codex", "p1"], {
        env: entryEnv(capture.url),
      });
      expect(entry.code).toBe(0);
      // (b) hook resolves its package-relative sibling entry and its state root under such paths
      const hook = await runNodeHook(hookPayload("done"), {
        ...process.env,
        TUT_EVENT_PORT_URL: capture.url,
        HERDR_PLUGIN_STATE_DIR: payloadDir,
        TUT_HERDR_EXECUTABLE: HERDR_FIXTURE,
      });
      expect(hook.code).toBe(0);
      // (c) the shims work from the same layout (CDPATH-safe dirname resolution)
      const shim = await run(path.join(packageDir, "hook.sh"), [], {
        env: { ...process.env, TUT_EVENT_PORT_URL: capture.url, HERDR_PLUGIN_STATE_DIR: payloadDir, TUT_HERDR_EXECUTABLE: HERDR_FIXTURE },
        stdin: hookPayload("blocked"),
      });
      expect(shim.code).toBe(0);
      await expectDeliveries(
        capture,
        [
          { event: "working", agent: "codex", pane: "p1" },
          { event: "done", agent: "codex", pane: fixtureLabel() },
          { event: "blocked", agent: "codex", pane: fixtureLabel() },
        ],
        false,
      );
      expect(existsSync(path.join(payloadDir, sha256(PANE)))).toBe(true);
      rmSync(path.dirname(packageDir), { recursive: true, force: true });
      rmSync(path.dirname(payloadDir), { recursive: true, force: true });
    }, 12000);
  },
);

// --- package boundary ------------------------------------------------------------------

describe("package boundary", () => {
  it("package.json files ships both canonical .mjs entries and the three POSIX shims", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "dist/",
        "scripts/on-agent-event.mjs",
        "scripts/herdr-hook.mjs",
        "scripts/launch.sh",
        "scripts/on-agent-event.sh",
        "scripts/hook.sh",
      ]),
    );
  });

  it("canonical event chain stays on the Node process boundary (no shell/curl escape hatches)", () => {
    const canonical = [
      readFileSync(ON_AGENT_EVENT_MJS, "utf8"),
      readFileSync(HERDR_HOOK_MJS, "utf8"),
      readFileSync(ON_AGENT_EVENT_SH, "utf8"),
      readFileSync(HOOK_SH, "utf8"),
    ].join("\n");
    for (const banned of ["shell: true", "sh -c", "cmd /c", "curl "]) {
      expect(canonical).not.toContain(banned);
    }
    // shims forward only: no transport/state/mapping decisions of their own
    for (const shim of [readFileSync(ON_AGENT_EVENT_SH, "utf8"), readFileSync(HOOK_SH, "utf8")]) {
      expect(shim).toContain("exec node");
      for (const decision of ["curl", "fetch(", "HERDR_PLUGIN_STATE_DIR", "TUT_EVENT_PORT_URL"]) {
        expect(shim).not.toContain(decision);
      }
    }
  });
});

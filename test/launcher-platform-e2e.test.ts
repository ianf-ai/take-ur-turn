// Endpoint ownership/discovery is exercised with real HTTP in rig-discovery.test.ts.
vi.mock("../src/rig-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rig-discovery.js")>()),
  resolveUpHub: async (url: string, _explicit: boolean, _root: string, eventPort?: number) => ({ url, eventPort: eventPort ?? 3002 }),
}));

// Platform-edge acceptance:
//  - space-path provisioning e2e: `tut up` in a project directory whose path
//    contains a space provisions BOTH system panes (serve + notify) with
//    on-demand sq quoting — the whole up→serve→notify chain, no truncated
//    argv words;
//  - CP936-adjacent simulation: CJK (CJK-codepage username shaped) paths
//    cross every dialect byte-exactly — no console codepage exists in the
//    chain to mojibake them.
// The probe-hang injection (fake hung which/where child, bounded kill) lives
// in launcher-target-resolver.test.ts next to the probe adapter itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Same mock shape as test/cli-up.test.ts: ONLY hubRead (the seed hint's one
// hub-client call) so the hint branch is deterministic without a live hub.
vi.mock("../src/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub-client.js")>()),
  hubRead: vi.fn(),
}));

import { main } from "../src/cli.js";
import { hubRead } from "../src/hub-client.js";
import { renderPaneCommand } from "../src/launcher/shell-renderer.js";

const REPO = path.resolve(import.meta.dirname, "..");
const TEST_BIN = path.join(REPO, "test", "bin");
const NODE_BIN_DIR = path.dirname(process.execPath);
const SAVED_CWD = process.cwd();
const SAVED_PATH = process.env.PATH ?? "";
const SAVED_LOG = process.env.TUT_HERDR_LOG;
const SAVED_PANES = process.env.TUT_HERDR_PANES;
const SAVED_SELF = process.env.TUT_UP_CLI_SELF;
const SAVED_USER_DIR = process.env.TUT_USER_CONFIG_DIR;
const TRASH: string[] = [];

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

function responseJson(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status });
}

const refused = (): Promise<Response> => Promise.reject(new TypeError("fetch failed"));

function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

function logLines(logPath: string): string[] {
  const text = readLog(logPath).trim();
  return text.length === 0 ? [] : text.split("\n");
}

beforeEach(() => {
  vi.mocked(hubRead).mockResolvedValue({
    task_id: "project",
    title: "project",
    versions: [],
  });
});

afterEach(() => {
  process.chdir(SAVED_CWD);
  process.env.PATH = SAVED_PATH;
  if (SAVED_LOG === undefined) delete process.env.TUT_HERDR_LOG;
  else process.env.TUT_HERDR_LOG = SAVED_LOG;
  if (SAVED_PANES === undefined) delete process.env.TUT_HERDR_PANES;
  else process.env.TUT_HERDR_PANES = SAVED_PANES;
  if (SAVED_SELF === undefined) delete process.env.TUT_UP_CLI_SELF;
  else process.env.TUT_UP_CLI_SELF = SAVED_SELF;
  if (SAVED_USER_DIR === undefined) delete process.env.TUT_USER_CONFIG_DIR;
  else process.env.TUT_USER_CONFIG_DIR = SAVED_USER_DIR;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(hubRead).mockReset();
  for (const dir of TRASH.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("space-path provisioning e2e (up → serve → notify)", () => {
  it("tut up in a space-named project provisions both panes with quoted words", async () => {
    // The project path itself carries a space (the break shape); the
    // provisioning target is the conventional dist/cli.js inside it.
    const outer = mkdtempSync(path.join(os.tmpdir(), "tut-platform-e2e-"));
    TRASH.push(outer);
    mkdirSync(path.join(outer, "my proj"), { recursive: true });
    // realpath: process.cwd() reports the REAL path (/private/var on macOS) —
    // every expected command string is built from cwd.
    const project = realpathSync(path.join(outer, "my proj"));
    writeFileSync(path.join(project, "package.json"), '{"name":"w4a-space"}\n', "utf8");
    const self = path.join(project, "dist", "cli.js");
    const logPath = path.join(project, "herdr.log");

    process.env.PATH = `${TEST_BIN}:${NODE_BIN_DIR}:/usr/bin:/bin`;
    process.env.TUT_HERDR_LOG = logPath;
    process.env.TUT_HERDR_PANES = JSON.stringify([{ pane_id: "FIX:p0", label: "exec" }]);
    process.env.TUT_UP_CLI_SELF = self;
    process.env.TUT_USER_CONFIG_DIR = path.join(outer, "empty-l2");
    process.chdir(project);

    // Log-aware probes: /state healthy once the serve pane command ran;
    // /agent-event answers the notifier probe once the notify command ran.
    vi.stubGlobal("fetch", vi.fn(async (input: unknown): Promise<Response> => {
      const url = String(input);
      const logged = readLog(logPath);
      if (url.includes(":3001/state")) {
        return logged.includes(" serve")
          ? Promise.resolve(responseJson({ hub_root: project, flow_mode: "manual", tasks: [] }))
          : refused();
      }
      if (url.includes(":3002/agent-event")) {
        return logged.includes(" notify")
          ? Promise.resolve(new Response(JSON.stringify({ hub_root: project, hub_url: "http://127.0.0.1:3001" }), { status: 405, headers: { Allow: "POST" } }))
          : refused();
      }
      return refused();
    }));

    const io = captureIo();
    try {
      const code = await main(["up"]);
      expect(code).toBe(0);
      // THE assertion set: both pane-run lines quote the space-carrying cwd
      // and cli path as single words — the renderer's on-demand sq, with the
      // legacy `cd <cwd> && node <cli> …` shape otherwise intact.
      expect(logLines(logPath)).toContain(`pane run FIX:p1 cd '${project}' && TUT_HUB_ROOT='${project}' TUT_HUB_URL=http://127.0.0.1:3001 TUT_EVENT_PORT_URL=http://127.0.0.1:3002/agent-event node '${self}' serve`);
      expect(logLines(logPath)).toContain(`pane run FIX:p2 cd '${project}' && TUT_HUB_ROOT='${project}' TUT_HUB_URL=http://127.0.0.1:3001 TUT_EVENT_PORT_URL=http://127.0.0.1:3002/agent-event node '${self}' notify`);
      expect(io.out()).toContain("up: hub serving on http://127.0.0.1:3001");
      expect(io.out()).toContain("up: notify running");
    } finally {
      io.restore();
    }
  });
});

describe("CP936-adjacent simulation: CJK paths cross every dialect byte-exactly", () => {
  const cjk = "C:\\Users\\李四\\TUT 项目";

  it("posix service: the CJK space path quotes as one word per token", () => {
    const { command_text } = renderPaneCommand({
      cwd: cjk, executable: "node", args: [`${cjk}\\dist\\cli.js`, "serve"],
      env: {}, dialect: "posix", purpose: "service",
    });
    expect(command_text).toBe(`cd '${cjk}' && node '${cjk}\\dist\\cli.js' serve`);
  });

  it("powershell5 empty-env: fail-closed Set-Location into the CJK path, quoted invocation", () => {
    const { command_text } = renderPaneCommand({
      cwd: cjk, executable: "C:\\Program Files\\nodejs\\node.exe",
      args: [`${cjk}\\dist\\cli.js`, "notify"],
      env: {}, dialect: "powershell5", purpose: "service",
    });
    expect(command_text).toContain(`Set-Location -LiteralPath '${cjk}' -ErrorAction Stop`);
    expect(command_text).toContain(`& 'C:\\Program Files\\nodejs\\node.exe' '${cjk}\\dist\\cli.js' 'notify'`);
    expect(command_text).not.toContain("&&");
  });

  it("cmd: the direct form double-quotes CJK + parens paths (x86 layouts work)", () => {
    const { command_text } = renderPaneCommand({
      cwd: "C:\\Users\\李四\\pro (x86)", executable: "C:\\Program Files (x86)\\nodejs\\node.exe",
      args: ["notify"], env: {}, dialect: "cmd", purpose: "service",
    });
    expect(command_text).toBe('cd /d "C:\\Users\\李四\\pro (x86)" && "C:\\Program Files (x86)\\nodejs\\node.exe" "notify"');
  });
});

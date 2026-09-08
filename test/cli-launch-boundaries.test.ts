import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({
  runInternalLaunch: vi.fn(),
  runInternalLaunchInvocation: vi.fn(),
}));
const hubMocks = vi.hoisted(() => ({
  hubDecide: vi.fn(),
  hubPublish: vi.fn(),
  hubRead: vi.fn(),
}));

vi.mock("../src/launcher/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/launcher/process.js")>()),
  runInternalLaunch: processMocks.runInternalLaunch,
  runInternalLaunchInvocation: processMocks.runInternalLaunchInvocation,
}));

vi.mock("../src/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub-client.js")>()),
  hubDecide: hubMocks.hubDecide,
  hubPublish: hubMocks.hubPublish,
  hubRead: hubMocks.hubRead,
}));

import { main } from "../src/cli.js";
import { DEFAULT_CHILD_TIMEOUT_MS } from "../src/launcher/process.js";

function captureIo(): { out: () => string; err: () => string; restore: () => void } {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  return { out: () => stdout, err: () => stderr, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

describe("CLI launcher process boundaries", () => {
  let io: ReturnType<typeof captureIo>;
  let temporary: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    io = captureIo();
    temporary = mkdtempSync(path.join(os.tmpdir(), "tut-cli-launch-boundary-"));
    processMocks.runInternalLaunch.mockReset();
    processMocks.runInternalLaunchInvocation.mockReset();
    hubMocks.hubDecide.mockReset();
    hubMocks.hubPublish.mockReset();
    hubMocks.hubRead.mockReset();
  });

  afterEach(() => {
    io.restore();
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(temporary, { recursive: true, force: true });
  });

  it("decide close reports a timed-out cleanup with the notifier wording", async () => {
    hubMocks.hubDecide.mockResolvedValue({ task_id: "cleanup-timeout", status: "closed" });
    processMocks.runInternalLaunch.mockResolvedValue({
      code: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      timedOut: true,
    });

    await expect(main([
      "decide", "cleanup-timeout", "--decision", "close", "--by", "host", "--url", "http://hub.test",
    ])).resolves.toBe(0);

    expect(io.err()).toContain(
      `launch --cleanup cleanup-timeout exceeded the child liveness budget (${DEFAULT_CHILD_TIMEOUT_MS}ms) and was killed`,
    );
    expect(io.err()).not.toContain("pane cleanup exited with code null");
  });

  it("manual start-next passes the frozen event-port environment to its launcher child", async () => {
    const eventUrl = "http://127.0.0.1:3105/agent-event";
    process.env.TUT_EVENT_PORT_URL = eventUrl;
    process.env.TUT_DRY_RUN = "1";
    process.env.TUT_PROJECT_ROOT = temporary;
    process.env.TUT_USER_CONFIG_DIR = path.join(temporary, "user-config");
    process.env.PATH = `${path.resolve(import.meta.dirname, "bin")}:${originalEnv.PATH ?? ""}`;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        flow_mode: "manual",
        tasks: [{
          task_id: "moved-event-port",
          status: "implementing",
          waiting_for: "agent:executor",
          needs_attention: false,
          version: 0,
        }],
      }),
    })));
    hubMocks.hubRead.mockResolvedValue({ task_id: "moved-event-port", versions: [] });
    hubMocks.hubPublish.mockResolvedValue({ task_id: "moved-event-port", version: 1 });
    processMocks.runInternalLaunchInvocation.mockResolvedValue({ code: 0, signal: null, stdout: "", stderr: "" });

    await expect(main(["start-next", "moved-event-port", "--url", "http://hub.test"])).resolves.toBe(0);

    expect(processMocks.runInternalLaunchInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "moved-event-port", role: "executor" }),
      { env: expect.objectContaining({ TUT_EVENT_PORT_URL: eventUrl }) },
    );
  });
});

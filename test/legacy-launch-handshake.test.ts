import { afterEach, describe, expect, it, vi } from "vitest";
import { taskLaunchMetadata } from "../src/launcher/compat.js";

const TASK = { task_id: "t1", checkout: { kind: "current" as const } };

function stateResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("legacy launch ownership handshake (hub_root check)", () => {
  it("refuses a hub that serves another workspace's root", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => stateResponse({
      hub_root: "/srv/another-workspace",
      tasks: [TASK],
    })));
    const outcome = await taskLaunchMetadata("t1", "http://127.0.0.1:3001", "/srv/this-workspace");
    expect(outcome).toMatchObject({ kind: "hub-foreign" });
    if (outcome.kind === "hub-foreign") {
      expect(outcome.detail).toContain("another-workspace");
      expect(outcome.detail).toContain("this-workspace");
    }
  });

  it("accepts the hub whose root matches this workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => stateResponse({ hub_root: "/srv/this-workspace", tasks: [TASK] })));
    const outcome = await taskLaunchMetadata("t1", "http://127.0.0.1:3001", "/srv/this-workspace");
    expect(outcome).toMatchObject({ kind: "ok", metadata: { checkout: { kind: "current" } } });
  });

  it("keeps the degraded path for hubs too old to expose hub_root", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => stateResponse({ tasks: [TASK] })));
    const outcome = await taskLaunchMetadata("t1", "http://127.0.0.1:3001", "/srv/this-workspace");
    expect(outcome).toMatchObject({ kind: "ok" });
  });

  it("still reports task-missing on an owned hub", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => stateResponse({ hub_root: "/srv/this-workspace", tasks: [] })));
    const outcome = await taskLaunchMetadata("t1", "http://127.0.0.1:3001", "/srv/this-workspace");
    expect(outcome).toMatchObject({ kind: "task-missing" });
  });
});

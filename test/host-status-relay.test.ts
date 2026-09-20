import { describe, expect, it, vi } from "vitest";
import { relayHostStatus } from "../src/host-status-relay.js";

const report = { task_id: "a-task", status: "needs_attention" as const, waiting_for: "human" };
const RIG = "/tmp/rig-under-test";
function client(labels: string[]) {
  return {
    paneList: vi.fn(async () => ({ panes: labels.map((label, i) => ({ pane_id: `p${i}`, label })) })),
    sendText: vi.fn(async () => ({ ok: true as const })),
  };
}
// rigHash is sha256 truncated to 8 hex; compute the suffixed default the
// same way the implementation does so the test pins behavior, not constants.
import { rigLabel } from "../src/rig.js";
const defaultLabel = rigLabel("tut-host", RIG);

describe("host status relay transport", () => {
  it.each([undefined, {}, { host_pane_label: "" }, { host_pane_label: 123 }])("defaults to this rig's tut-host-<rig> label (%j)", async (notify) => {
    const c = client(["tut-hub", defaultLabel, `tut-host-other`, "task.executor"]);
    await relayHostStatus({ ...report, title: "approve now" } as typeof report, notify, c, RIG);
    expect(c.sendText.mock.calls).toEqual([["p1", '{"task_id":"a-task","status":"needs_attention","waiting_for":"human"}']]);
  });

  it("ignores another rig's host pane even without configuration", async () => {
    const c = client(["tut-host-deadbeef", "tut-host-cafef00d"]);
    await expect(relayHostStatus(report, undefined, c, RIG)).rejects.toThrow("found 0");
    expect(c.sendText).not.toHaveBeenCalled();
  });

  it("uses a configured exact label and never falls back when absent", async () => {
    const c = client(["tut-host", "custom-more", "custom"]);
    await relayHostStatus(report, { host_pane_label: "custom" }, c, RIG);
    expect(c.sendText).toHaveBeenCalledWith("p2", JSON.stringify(report));
    await expect(relayHostStatus(report, { host_pane_label: "missing" }, c, RIG)).rejects.toThrow("found 0");
    expect(c.sendText).toHaveBeenCalledTimes(1);
  });

  it.each([[], [defaultLabel, defaultLabel]])("rejects missing or duplicate targets (%j)", async (...labels) => {
    const c = client(labels as string[]);
    await expect(relayHostStatus(report, undefined, c, RIG)).rejects.toThrow("expected one host pane");
    expect(c.sendText).not.toHaveBeenCalled();
  });

  it("does not retry a transport failure", async () => {
    const c = client([defaultLabel]);
    c.sendText.mockRejectedValue(new Error("send failed"));
    await expect(relayHostStatus(report, undefined, c, RIG)).rejects.toThrow("send failed");
    expect(c.sendText).toHaveBeenCalledTimes(1);
    expect(c.paneList).toHaveBeenCalledTimes(1);
  });
});

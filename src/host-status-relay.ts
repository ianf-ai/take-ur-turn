import { resolveRigRoot } from "./rig-discovery.js";
import { rigLabel } from "./rig.js";
import { HerdrClient } from "./launcher/herdr-client.js";

/** A signal for the host, never an instruction or an approval. */
export interface HostStatusReport {
  task_id: string;
  status: "pending_approval" | "needs_attention";
  waiting_for: string;
}

const herdr = new HerdrClient();

/** Single attempt; neither retries nor durable delivery bookkeeping. */
export async function relayHostStatus(
  report: HostStatusReport,
  notify: unknown,
  client: Pick<HerdrClient, "paneList" | "sendText"> = herdr,
  rigRoot: string = resolveRigRoot(),
): Promise<void> {
  const configured = typeof notify === "object" && notify !== null
    ? (notify as Record<string, unknown>).host_pane_label : undefined;
  const label = typeof configured === "string" && configured.trim() !== "" ? configured : undefined;
  // Default target is THIS rig's host pane only — a bare `tut-host` prefix
  // would sweep every workspace's panes on a shared herdr and deliver one
  // rig's approval signal into another rig's host session (multi-rig isolation).
  const defaultLabel = rigLabel("tut-host", rigRoot);
  const { panes } = await client.paneList();
  const candidates = panes.filter((pane) => pane.label === (label ?? defaultLabel));
  // Never broadcast a single edge to multiple host sessions. Ambiguity is
  // observable and can be resolved by configuring an exact label.
  if (candidates.length !== 1) {
    throw new Error(`expected one host pane (${label ?? defaultLabel}), found ${candidates.length}`);
  }
  const text = JSON.stringify({
    task_id: report.task_id,
    status: report.status,
    waiting_for: report.waiting_for,
  });
  await client.sendText(candidates[0]!.pane_id, text);
}

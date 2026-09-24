import { eventEndpoint, discoverWorkspaceNotifiers, notifierOwnership } from "../../hub/rig-discovery.js";
import type { DoctorCheck, DoctorContext } from "../types.js";
import type { HubOutcome } from "./hub.js";

// --- check 2: notifier ---------------------------------------------------------

async function checkNotifier(ctx: DoctorContext, hub: HubOutcome): Promise<DoctorCheck> {
  const check: DoctorCheck = {
    name: "notifier", title: "notifier event port", status: "fail", summary: "", details: [
      `target workspace: ${ctx.hubRoot}; Hub: ${ctx.url}`,
      "read-only discovery: local ports 3001–3200 plus Hub+1 candidate and explicit TUT_EVENT_PORT_URL",
    ],
  };
  const explicit = ctx.env.TUT_EVENT_PORT_URL || undefined;
  let explicitKey: string | undefined;
  let configError: string | undefined;
  if (explicit) {
    try { explicitKey = eventEndpoint(explicit); }
    catch { configError = `invalid event-port URL from TUT_EVENT_PORT_URL: ${explicit}`; }
    try {
      if (explicitKey && new URL(explicitKey).origin === new URL(eventEndpoint(ctx.url)).origin) {
        configError = "hub and notifier event port are the SAME — EADDRINUSE";
      }
    } catch { /* Hub check diagnoses malformed URL. */ }
  }
  const { probes, owned: discoveredOwned } = await discoverWorkspaceNotifiers(ctx.url, hub.verified?.root ?? ctx.hubRoot, explicit, ctx.fetchImpl);
  const owned = hub.verified ? discoveredOwned : [];
  for (const probe of probes) {
    if (probe.outcome === "unavailable" && ![explicitKey, eventEndpoint("http://127.0.0.1:3002/agent-event")].includes(eventEndpoint(probe.url))) continue;
    const identity = probe.identity;
    let ownership = "";
    if (probe.outcome === "signature") {
      const ownershipCode = notifierOwnership(identity, ctx.hubRoot, ctx.url);
      ownership = ownershipCode === "unknown-root" ? "归属无法确认 (unknown root)"
        : ownershipCode === "foreign-workspace" ? `非本 workspace（来自 ${identity?.root ?? "unknown"}）`
        : ownershipCode === "unknown-hub-url" ? "归属无法确认 (unknown Hub URL)"
        : ownershipCode === "hub-url-mismatch" ? "Hub 地址错配"
        : "workspace identity matches";
    }
    check.details.push(`${probe.url}: ${probe.detail}; ${ownership}${identity ? `; hub_root=${identity.root ?? "unknown"}; hub_url=${identity.hubUrl ?? "unknown"}` : ""}`);
  }
  if (explicit && !owned.some(p => eventEndpoint(p.url) === explicitKey)) {
    configError ??= `TUT_EVENT_PORT_URL does not route to a verified workspace notifier: ${explicit}`;
  }
  if (owned.length) check.details.push(`verified workspace notifier endpoint(s): ${owned.map(p => p.url).join(", ")}`);
  if (configError) check.summary = configError;
  else if (!hub.verified) check.summary = "本 Hub 身份未验证 — cannot confirm notifier pairing";
  else if (owned.length > 1) check.summary = `multiple notifiers belong to workspace ${ctx.hubRoot}: ${owned.map(p => p.url).join(", ")}`;
  else if (owned.length === 0) check.summary = `no notifier detected for workspace ${ctx.hubRoot}`;
  else {
    check.status = "ok";
    check.summary = `workspace notifier listening on ${owned[0]!.url}`;
    return check;
  }
  check.fix = `${configError ? "correct or unset TUT_EVENT_PORT_URL; " : ""}in workspace ${ctx.hubRoot}, run tut up; inspect duplicate or unknown-identity notifiers and upgrade/restart with the correct Hub URL before retrying`;
  return check;
}

export { checkNotifier };

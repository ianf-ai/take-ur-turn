import path from "node:path";
import { readPowerModeForSwitch } from "../../common/config.js";
import { readPowerState } from "../../../standalone/power/standalone-up.js";
import { describePowerDrift, inspectPowerDrift } from "../../../standalone/power/reconcile.js";
import type { DoctorCheck, DoctorContext } from "../types.js";

/** Report only; the owning rig root is independent of doctor's storage --root. */
export async function checkPower(ctx: DoctorContext): Promise<DoctorCheck> {
  const check: DoctorCheck = { name: "power", title: "standalone power registration", status: "ok", summary: "not applicable (power.mode=herdr)", details: [] };
  const storageDir = path.join(ctx.hubRoot, ".context-hub");
  try {
    if (await readPowerModeForSwitch(storageDir) !== "standalone") return check;
    const prior = await readPowerState(storageDir);
    const drift = await inspectPowerDrift(ctx.hubRoot, prior, ctx.url, ctx.fetchImpl, ctx.env.TUT_EVENT_PORT_URL);
    check.details = drift.map(describePowerDrift);
    for (const [name, facts] of [["hub", prior?.hub], ["notifier", prior?.notifier]] as const) {
      if (facts?.adopted) check.details.push(`${name}: adopted=true; session_inherited=false — TUT_POWER_SESSION was not injected; leaderless descendants cannot be attributed by the adoption session`);
    }
    check.status = drift.length ? "warn" : "ok";
    check.summary = drift.length ? `power drift detected: ${drift.length} unregistered live service(s)` : "no live service registration drift detected";
    if (drift.length) check.fix = "inspect the listed services; explicitly choose tut up --adopt in the owning workspace to adopt them (doctor makes no changes)";
  } catch (error) {
    check.status = "fail";
    check.summary = `cannot reconcile power registration: ${(error as Error).message}`;
  }
  return check;
}

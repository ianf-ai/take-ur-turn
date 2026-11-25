/** Production binding for report-only host diagnostics. */
import { runDoctor as runDoctorChecks } from "../../core/doctor/runner.js";
import type { DoctorOptions, DoctorReport } from "../../core/doctor/types.js";
import { probeDoctorPaths, probeDoctorShell } from "../../herdr/host-entry.js";
import { checkPower } from "../../standalone/host-entry.js";
export { DOCTOR_HUB_TIMEOUT_MS, DOCTOR_EVENT_TIMEOUT_MS, renderDoctorReport, preflightCheckFrom } from "../../core/doctor/runner.js";
export type { DoctorStatus, AgentChannelCode, AgentChannelReason, AgentChannelSeatVerdict, AgentChannelUdsVerdict, DoctorCheck, DoctorReport, DoctorOptions } from "../../core/doctor/types.js";

export function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  return runDoctorChecks(options, { paths: probeDoctorPaths, shell: probeDoctorShell, power: checkPower });
}

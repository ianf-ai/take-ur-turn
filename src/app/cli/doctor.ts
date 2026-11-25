import { runDoctorCommand } from "../../core/cli/doctor.js";
import { resolveRigRoot } from "../../hub/rig-discovery.js";
import { runDoctor as runDoctorChecks } from "../doctor/index.js";
import type { ParsedArgs } from "../../core/cli/args.js";

export function runDoctor(parsed: Extract<ParsedArgs, { command: "doctor" }>, identityError?: unknown, hubRoot = resolveRigRoot()): Promise<number> {
  return runDoctorCommand(parsed, identityError, hubRoot, runDoctorChecks);
}

import { renderDoctorReport } from "../doctor/runner.js";
import type { DoctorOptions, DoctorReport } from "../doctor/types.js";
import { envPreflightFixRunner, fixPreflight } from "../preflight/index.js";
import { printJson } from "./shared.js";
import type { ParsedArgs } from "./args.js";

/** tut doctor — report-only self-check. Both faces (text and --json) draw
 *  from the SAME DoctorReport; runDoctor's robustness contract is that it
 *  never rejects (a bad input becomes that check's failure item), so the
 *  exit code is purely report.ok. Warnings do not flip it. an explicit
 *  --fix-preflight repairs ONLY the preflight items (bounded, visible,
 *  in-checkout) before the report is assembled; the exit code remains the
 *  whole report's verdict. */
export async function runDoctorCommand(parsed: Extract<ParsedArgs, { command: "doctor" }>, identityError: unknown, hubRoot: string, runDoctorChecks: (options: DoctorOptions) => Promise<DoctorReport>): Promise<number> {
  let fixFailed = false;
  if (parsed.fixPreflight) {
    const result = await fixPreflight(parsed.checkout, envPreflightFixRunner(process.env));
    if (result.failure !== undefined) {
      fixFailed = true;
      process.stderr.write(`tut: preflight fix step failed (${result.failure.step.argv.join(" ")}, exit ${result.failure.code ?? `signal ${result.failure.signal}`}); no further steps — this invocation did NOT complete its repairs\n`);
    }
    for (const step of result.executed) process.stderr.write(`tut doctor: preflight fix ran: ${step.argv.join(" ")} (cwd ${step.cwd})\n`);
  }
  const report = await runDoctorChecks({
    root: parsed.root, url: parsed.url, hubRoot, checkout: parsed.checkout,
    // Keep offline diagnostics available without reading an unverified Hub.
    ...(identityError === undefined ? {} : { fetchImpl: (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === "/state") throw identityError;
      return fetch(input, init);
    }) as typeof fetch }),
  });
  if (parsed.json) printJson(report);
  else process.stdout.write(`${renderDoctorReport(report)}\n`);
  // A failed repair step is an operational failure of THIS invocation and
  // never reports as a successful completion, even when a half-applied fix
  // left the checked artifacts on disk (report checks stay authoritative
  // for their own verdict; the exit code takes the stricter of the two).
  if (fixFailed) return 1;
  return report.ok ? 0 : 1;
}

import { homedir } from "node:os";
import { worst } from "../shared.js";
import type { DoctorCheck, DoctorContext, DoctorStatus, DoctorHostProbes } from "../types.js";

// --- check 6: paths --------------------------------------------------------------

function pathHazards(p: string, platform: NodeJS.Platform): string[] {
  const hazards: string[] = [];
  if (/\s/u.test(p)) hazards.push("contains spaces");
  if (/[^\x00-\x7f]/u.test(p)) hazards.push("contains non-ASCII characters");
  if (platform === "win32") {
    if (/[%!^&()<>'"]/u.test(p)) hazards.push("contains cmd/pwsh metacharacters");
  } else {
    if (/['"\\$`;&|<>]/u.test(p)) hazards.push("contains shell metacharacters");
  }
  return hazards;
}

async function checkPaths(ctx: DoctorContext, probePaths: DoctorHostProbes["paths"]): Promise<DoctorCheck> {
  const check: DoctorCheck = {
    name: "paths",
    title: "path safety",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];
  let hazardFound = false;
  for (const [label, p] of [
    ["storage root", ctx.root],
    ["project root", ctx.projectRoot],
    ["home", homedir()],
  ] as const) {
    const hazards = pathHazards(p, ctx.platform);
    if (hazards.length > 0) {
      hazardFound = true;
      const severe = hazards.some((h) => h.includes("metacharacters"));
      statuses.push(severe ? "fail" : "warn");
      check.details.push(`${label} ${p}: ${hazards.join(", ")}`);
    }
  }
  if (!hazardFound) {
    check.details.push("storage/project/home paths: ASCII, no spaces or metacharacters");
  } else {
    check.fix = "prefer an ASCII, space-free project path; quoting is hardened, but path edges remain the classic breakage class";
  }
  check.status = worst(statuses);
  await probePaths(ctx, check);
  check.summary = check.status === "fail" ? "path or rig identity hazards — see details" : "path safety prechecks passed";
  return check;
}

export { checkPaths };

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HerdrClient } from "../../launcher/legacy-herdr-client.js";
import { rigHash } from "../../hub/rig.js";
import { worst } from "../shared.js";
import type { DoctorCheck, DoctorContext, DoctorStatus } from "../types.js";

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

async function checkPaths(ctx: DoctorContext): Promise<DoctorCheck> {
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
  // Only system panes carry the rig root as cwd; task checkouts can differ.
  try {
    const { panes } = await new HerdrClient({ env: ctx.env, platform: ctx.platform }).paneList();
    const rootsByHash = new Map<string, Set<string>>();
    for (const pane of panes) {
      const match = /^tut-(?:hub|notify)-([a-f0-9]{8})$/.exec(pane.label ?? "");
      if (!match || !pane.cwd || !path.isAbsolute(pane.cwd)) continue;
      let root = path.resolve(pane.cwd);
      try { root = realpathSync(root); } catch { /* report the visible path */ }
      const suffix = match[1]!;
      if (rigHash(root) !== suffix) continue;
      const roots = rootsByHash.get(suffix) ?? new Set<string>();
      roots.add(root);
      rootsByHash.set(suffix, roots);
    }
    for (const [hash, roots] of rootsByHash) {
      if (roots.size < 2) continue;
      check.status = "fail";
      check.details.push(`rigHash collision ${hash}: ${[...roots].join(" <-> ")}`);
      check.fix = "relocate one colliding rig root and restart its services; inspect existing pane labels before reuse";
    }
    check.details.push("rig label scan completed (system panes with root cwd evidence)");
  } catch (error) {
    check.details.push(`rig collision scan unavailable: ${(error as Error).message}`);
  }
  check.summary = check.status === "fail" ? "path or rig identity hazards — see details" : "path safety prechecks passed";
  return check;
}

export { checkPaths };

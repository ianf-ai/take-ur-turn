import { realpathSync } from "node:fs";
import path from "node:path";
import { rigHash } from "../../hub/rig-identity.js";
import { HerdrClient } from "../launcher/legacy-herdr-client.js";
import { resolvePaneShellDialect, PaneShellError } from "../launcher/shell-renderer.js";
import type { DoctorContext, DoctorCheck, DoctorStatus } from "../../core/doctor/types.js";

export async function probeDoctorPanes(ctx: DoctorContext) {
  return (await new HerdrClient({ env: ctx.env, platform: ctx.platform }).paneList()).panes;
}

export function probeDoctorShell(ctx: DoctorContext, check: DoctorCheck, statuses: DoctorStatus[]): void {
  try {
    const dialect = resolvePaneShellDialect(ctx.env, ctx.platform);
    check.details.push(
      `pane shell dialect: ${dialect}${ctx.env.TUT_PANE_SHELL !== undefined ? " (TUT_PANE_SHELL)" : " (platform default)"}`,
    );
  } catch (e) {
    if (e instanceof PaneShellError) {
      statuses.push("fail");
      check.details.push(`${e.message} — birth-time resolution fails loud on unknown dialects`);
      check.fix = "unset TUT_PANE_SHELL or set it to one of posix, powershell5, pwsh, cmd";
    }
  }
}

export async function probeDoctorPaths(ctx: DoctorContext, check: DoctorCheck): Promise<void> {
  // Only system panes carry the rig root as cwd; task checkouts can differ.
  try {
    const panes = await probeDoctorPanes(ctx);
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
}

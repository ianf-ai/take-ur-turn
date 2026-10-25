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

import { homedir } from "node:os";
import { resolvePaneShellDialect, PaneShellError } from "../../launcher/shell-renderer.js";
import { worst } from "../shared.js";
import type { DoctorCheck, DoctorContext, DoctorStatus } from "../types.js";

// --- check 7: platform -----------------------------------------------------------

function checkPlatform(ctx: DoctorContext): DoctorCheck {
  const check: DoctorCheck = {
    name: "platform",
    title: "platform info",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];
  const major = Number.parseInt(ctx.nodeVersion.replace(/^v/u, "").split(".")[0] ?? "0", 10);
  check.summary = `${ctx.platform} / node ${ctx.nodeVersion}`;
  check.details.push(`os: ${ctx.platform}; node: ${ctx.nodeVersion} (engines: >=20)`);
  if (major < 20) {
    statuses.push("warn");
    check.details.push("node below the engines floor (>=20) — unsupported territory");
  }
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
  if (ctx.platform === "win32") {
    const nonAscii = [homedir(), ctx.projectRoot, ctx.env.USERNAME ?? ""].some((p) => /[^\x00-\x7f]/u.test(p));
    if (nonAscii) {
      statuses.push("warn");
      check.details.push(
        "non-ASCII user/path on Windows: console code pages can mojibake text-probed agent paths. TUT's launcher self-enumerates PATH+PATHEXT in-process (unaffected); avoid routing agent paths through external text tools",
      );
    } else {
      check.details.push("windows paths ASCII-only — no code-page hazard flagged");
    }
  }
  // Env knobs in effect (delivery-facing, one line each).
  for (const [name, value] of [
    ["TUT_EVENT_PORT_URL", ctx.env.TUT_EVENT_PORT_URL],
    ["TUT_STATUS_FLIP_TIMEOUT_MS", ctx.env.TUT_STATUS_FLIP_TIMEOUT_MS],
    ["TUT_STATUS_POLL_MS", ctx.env.TUT_STATUS_POLL_MS],
  ] as const) {
    check.details.push(value !== undefined ? `${name}=${value}` : `${name} unset (default in effect)`);
  }
  check.status = worst(statuses);
  return check;
}

export { checkPlatform };

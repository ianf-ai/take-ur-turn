import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfigFile } from "./config.js";

// --- usage watcher (shared with the herdr path — identical output) ---------------

/** Where usage-watcher diagnostics land (the herdr path's convention). */
const USAGE_LOG_REL = path.join(".context-hub", "usage-audit.log");

/**
 * Start the shipped usage watcher detached (opt-in via usage_audit = "on").
 * EXACTLY the herdr up step's semantics and output, extracted so both power
 * modes share one implementation: read usage_audit (invalid file/value →
 * warning + off), plan in dry-run, otherwise spawn detached with the log as
 * stdio. Returns the spawned pid, or null when nothing was started. The
 * watcher's own file lock makes reruns self-healing (a second instance
 * exits immediately) — measurement must never fail the rig.
 */
export async function provisionUsageWatcher(cwd: string, hubUrl: string, dryRun: boolean, extraEnv: Readonly<Record<string, string>> = {}): Promise<{ pid: number } | null> {
  const outcome = await readConfigFile(path.join(cwd, ".context-hub"));
  if (outcome.status === "invalid") {
    process.stderr.write("tut: up: usage_audit skipped — .context-hub/config.json is unreadable or corrupt; fix it by hand\n");
    return null;
  }
  const usageAuditOn = outcome.status === "ok" && outcome.config.usage_audit === "on";
  if (outcome.status === "ok" && outcome.config.usage_audit !== undefined && outcome.config.usage_audit !== "on" && outcome.config.usage_audit !== "off") {
    process.stderr.write(`tut: up: ignoring invalid usage_audit "${String(outcome.config.usage_audit)}" (expected "off" | "on")\n`);
  }
  if (!usageAuditOn) return null;
  const usageScript = fileURLToPath(new URL("../../../scripts/usage-audit/run.mjs", import.meta.url));
  if (!existsSync(usageScript)) {
    process.stderr.write("tut: up: usage watcher script not found in this installation — measurement not started (non-fatal)\n");
    return null;
  }
  if (dryRun) {
    process.stdout.write(`up: [dry-run] would start the usage watcher (detached; log at ${USAGE_LOG_REL})\n`);
    return null;
  }
  const logPath = path.join(cwd, USAGE_LOG_REL);
  const out = openSync(logPath, "a");
  const child = spawn(process.execPath, [usageScript, "--watch", "--root", cwd, "--url", hubUrl], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
  // Spawn failures arrive asynchronously (ENOENT/EMFILE/...) — without a
  // listener they escape and kill the caller.
  child.on("error", (err) => {
    try { closeSync(out); } catch {}
    process.stderr.write(`tut: up: usage watcher failed to start (non-fatal): ${err.message}\n`);
  });
  child.unref();
  if (child.pid !== undefined) {
    process.stdout.write(`up: usage watcher spawned (pid ${child.pid}; per-round usage lands in tasks/<id>/usage.json)\n`);
    return { pid: child.pid };
  }
  return null;
}

import { runHerdrUp } from "../../herdr/host-entry.js";
import { runStandaloneUp, runDownCommand } from "../../standalone/host-entry.js";
import { upCliSelf, printActivationHint } from "./rig-support.js";
export { notifyHealthy } from "./rig-support.js";
export { herdrPaneList } from "../../herdr/host-entry.js";
import { resolveRigRoot, canonicalRoot } from "../hub/rig-discovery.js";
import { statSync } from "node:fs";
import path from "node:path";
import { startServer } from "../hub/server.js";
import { runNotify } from "../notifier/notifier.js";
import { readLaunchMode, readLaunchCatchup, readPowerMode, readPowerModeForSwitch, autoSectionOf, CONFIG_KEYS, configKeysHint, configPath, parseConfigValue, parseReviewStandards, readConfigFile, writeConfigKey, type Config, type PowerMode, type ReadOutcome } from "../common/config.js";
import { cliFetchInit, isHubUnreachable, hubUnreachableLine, printJson, clampPollInterval, type Handler } from "./shared.js";
import { type ParsedArgs } from "./args.js";

async function runServe(parsed: Extract<ParsedArgs, { command: "serve" }>): Promise<number> {
  const options = parsed.port === undefined ? { root: parsed.root } : { root: parsed.root, port: parsed.port };
  const { server, url, close } = await startServer(options);
  process.stdout.write(`${url}\n`);

  let signalCount = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    if (signalCount > 1) process.exit(130);
    void close().then(
      () => process.exit(0),
      (e: unknown) => {
        process.stderr.write(`tut: error during shutdown: ${(e as Error).message}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  server.on("close", () => process.exit(0));

  await new Promise<never>(() => undefined);
  return 0;
}

async function runMode(parsed: Extract<ParsedArgs, { command: "mode" }>): Promise<number> {
  let res: Response;
  try {
    res = await fetch(new URL("/mode", parsed.url), cliFetchInit({
      method: "POST",
      headers: { "content-type": "application/json", Connection: "close" },
      body: JSON.stringify({ flow_mode: parsed.mode }),
    }));
  } catch (e) {
    process.stderr.write(
      isHubUnreachable(e)
        ? hubUnreachableLine(parsed.url, e)
        : `tut: cannot reach Hub at ${parsed.url} (is tut serve running?): ${(e as Error).message}\n`,
    );
    return 1;
  }
  const body = (await res.json().catch(() => null)) as { flow_mode?: string; error?: string } | null;
  if (!res.ok || body === null || body.flow_mode === undefined) {
    process.stderr.write(`tut: mode failed: HTTP ${res.status}: ${body?.error ?? "unexpected response"}\n`);
    return 1;
  }
  printJson({ flow_mode: body.flow_mode });
  return 0;
}

// --- tut config ------------------------------------------------------------------

/**
 * tut config get/set — validated read/write of the project runtime config
 * (.context-hub/config.json, the file serve re-reads every request). get
 * prints the EFFECTIVE value (what serve/notify would use this cycle:
 * missing file = defaults); set is a key-preserving atomic write through
 * config.ts (the writeFlowMode discipline). Both refuse a corrupt file
 * rather than guessing at its contents.
 */
async function runConfig(parsed: Extract<ParsedArgs, { command: "config" }>): Promise<number> {
  const root = parsed.root;
  if (parsed.action === "get") {
    const outcome: ReadOutcome = await readConfigFile(root);
    if (outcome.status === "invalid") {
      process.stderr.write(`tut: config: cannot read ${configPath(root)}: unreadable or corrupt — fix it by hand\n`);
      return 1;
    }
    switch (parsed.key) {
      case "review_standards": {
        const raw = outcome.status === "ok" && "review_standards" in outcome.config ? outcome.config.review_standards : "";
        const value = parseReviewStandards(raw);
        if (!value.ok) {
          process.stderr.write(`tut: config: ${value.error}\n`);
          return 1;
        }
        // Paths belong to the reviewed checkout (cwd), not the Hub config root.
        for (const file of value.assignment.value.split(",").filter(Boolean)) {
          try {
            const info = statSync(path.resolve(file));
            if (info.isFile() && info.size > 20 * 1024) {
              process.stderr.write(`tut: warning: review_standards ${file} exceeds 20KB (20480 bytes); consider a digest with on-demand detail\n`);
            }
          } catch {
            // Advisory size check only; the reviewer handles unreadable standards.
          }
        }
        process.stdout.write(`${value.assignment.value}\n`);
        return 0;
      }
      case "usage_audit": {
        const value = outcome.status === "ok" && outcome.config.usage_audit !== undefined ? outcome.config.usage_audit : "off";
        if (value !== "off" && value !== "on") {
          process.stderr.write("tut: invalid usage_audit (expected off | on)\n");
          return 1;
        }
        process.stdout.write(`${value}\n`);
        return 0;
      }
      case "launch_mode": {
        try { process.stdout.write(`${await readLaunchMode(root)}\n`); return 0; }
        catch (e) { process.stderr.write(`tut: config: ${(e as Error).message}\n`); return 1; }
      }
      case "launch.catchup": {
        try { process.stdout.write(`${await readLaunchCatchup(root)}\n`); return 0; }
        catch (e) { process.stderr.write(`tut: config: ${(e as Error).message}\n`); return 1; }
      }
      case "power.mode": {
        try { process.stdout.write(`${await readPowerMode(root)}\n`); return 0; }
        catch (e) { process.stderr.write(`tut: config: ${(e as Error).message}\n`); return 1; }
      }
      case "flow_mode": {
        const value = outcome.status === "ok" ? outcome.config.flow_mode : "manual";
        process.stdout.write(`${value}\n`);
        return 0;
      }
      case "auto.remediate": {
        const cfg = outcome.status === "ok" ? outcome.config : null;
        const value = autoSectionOf(cfg)?.remediate ?? (cfg?.flow_mode === "auto" ? "enter-repress" : "off");
        process.stdout.write(`${value}\n`);
        return 0;
      }
      case "auto.launch_roles": {
        const value = autoSectionOf(outcome.status === "ok" ? outcome.config : null)?.launch_roles ?? [];
        process.stdout.write(`${value.join(",")}\n`);
        return 0;
      }
      case "notify": {
        const cfg = outcome.status === "ok" ? outcome.config : null;
        process.stdout.write(cfg !== null && "notify" in cfg ? `${JSON.stringify(cfg.notify)}\n` : "unset\n");
        return 0;
      }
      default:
        process.stderr.write(`tut: config: unknown key: ${parsed.key}\n`);
        process.stderr.write(`tut: ${configKeysHint()}\n`);
        return 1;
    }
  }
  // set
  if (parsed.key === "notify") {
    process.stderr.write(`tut: config: notify is not settable here (an object config — edit ${configPath(root)} by hand)\n`);
    return 1;
  }
  const key = CONFIG_KEYS.find((k) => k === parsed.key);
  if (key === undefined) {
    process.stderr.write(`tut: config: unknown key: ${parsed.key}\n`);
    process.stderr.write(`tut: ${configKeysHint()}\n`);
    return 1;
  }
  const parsedValue = parseConfigValue(key, parsed.value ?? "");
  if (!parsedValue.ok) {
    process.stderr.write(`tut: config: ${parsedValue.error}\n`);
    return 1;
  }
  let config: Config;
  try {
    config = await writeConfigKey(root, parsedValue.assignment);
  } catch (e) {
    process.stderr.write(`tut: config: ${(e as Error).message}\n`);
    return 1;
  }
  const rendered =
    parsedValue.assignment.key === "launch_mode"
      ? config.launch_mode
      : parsedValue.assignment.key === "launch.catchup"
      ? (config.launch?.catchup ?? "off")
      : parsedValue.assignment.key === "power.mode"
      ? (config.power as { mode: PowerMode }).mode
      : parsedValue.assignment.key === "review_standards"
      ? config.review_standards
      : parsedValue.assignment.key === "usage_audit"
      ? config.usage_audit
      : parsedValue.assignment.key === "flow_mode"
      ? config.flow_mode
      : parsedValue.assignment.key === "auto.remediate"
        ? config.auto?.remediate
        : (config.auto?.launch_roles ?? []).join(",");
  process.stdout.write(`config: ${parsedValue.assignment.key} = ${rendered} (${configPath(root)})\n`);
  return 0;
}

async function runUp(parsed: Extract<ParsedArgs, { command: "up" }>): Promise<number> {
  const dryRun = parsed.dryRun;
  const cwd = parsed.root !== undefined ? canonicalRoot(parsed.root) : resolveRigRoot();
  // Power-mode guard — the one entry split: config key power.mode selects the
  // power implementation for this rig. Missing key = herdr (the historical
  // behavior, byte-identical); the reader validates ONLY the power key, so
  // unrelated config damage keeps its old up behavior; an illegal
  // power.mode value fails visibly BEFORE any probe or provisioning.
  let powerMode: PowerMode;
  try {
    powerMode = await readPowerModeForSwitch(path.join(cwd, ".context-hub"));
  } catch (error) {
    process.stderr.write(`tut: up: ${(error as Error).message}\n`);
    return 1;
  }
  if (powerMode === "standalone") {
    const code = await runStandaloneUp(cwd, { url: parsed.url, eventPort: parsed.eventPort, adopt: parsed.adopt, dryRun, self: upCliSelf() });
    if (code === 0) printActivationHint();
    return code;
  }
  if (parsed.adopt) {
    process.stderr.write("tut: up: --adopt requires power.mode=standalone; no services changed\n");
    return 1;
  }
  return await runHerdrUp(parsed, cwd, upCliSelf());
}

const runNotifyCommand = (async (parsed) => {
    try {
      await runNotify({
        url: parsed.url,
        interval: clampPollInterval("notify", parsed.interval),
        eventPort: parsed.eventPort,
        stallTimeoutMin: parsed.stallTimeoutMin,
        ...(parsed.workingTimeoutSec !== undefined ? { workingTimeoutSec: parsed.workingTimeoutSec } : {}),
      });
    } catch (e: unknown) {
      // e.g. EADDRINUSE on the event port — fatal, visible in the dedicated pane.
      process.stderr.write(`tut: notify: ${(e as Error).message}\n`);
      return 1;
    }
    return 0;
  }) as Handler<Extract<ParsedArgs, { command: "notify" }>>;

export { runServe, runMode, runConfig, runUp, runNotifyCommand, runDownCommand as runDown };

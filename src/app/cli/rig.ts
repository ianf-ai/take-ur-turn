/** Production power and Notifier command bindings. */
import path from "node:path";
import { runHerdrUp } from "../../herdr/host-entry.js";
import { runStandaloneUp, runDownCommand } from "../../standalone/host-entry.js";
import { runUp as up } from "../../core/cli/rig-handlers.js";
import { upCliSelf, printActivationHint } from "../../core/cli/rig-support.js";
import { readPowerModeForSwitch, type PowerMode } from "../../core/common/config.js";
import { runNotify } from "../notifier/notifier.js";
import { setProcessTitle } from "../../core/common/process-title.js";
import { clampPollInterval, type Handler } from "../../core/cli/shared.js";
import type { PowerPort } from "../../core/cli/host-ports.js";
import type { ParsedArgs } from "../../core/cli/args.js";
export { runServe, runMode, runConfig, notifyHealthy } from "../../core/cli/rig-handlers.js";
export { herdrPaneList } from "../../herdr/host-entry.js";
export { runDownCommand as runDown };

const power: PowerPort = {
  up: async (parsed, cwd) => {
    const dryRun = parsed.dryRun;
    // Power-mode guard — the one entry split: config key power.mode selects the
    // power implementation for this rig. A missing key selects the default;
    // the reader validates ONLY the power key, so
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
  },
};

export function runUp(parsed: Extract<ParsedArgs, { command: "up" }>): Promise<number> {
  return up(parsed, power);
}

export const runNotifyCommand = (async (parsed) => {
    setProcessTitle("tut-notify");
    try {
      await runNotify({
        url: parsed.url,
        interval: clampPollInterval("notify", parsed.interval),
        eventPort: parsed.eventPort,
        stallTimeoutMin: parsed.stallTimeoutMin,
        ...(parsed.workingTimeoutSec !== undefined ? { workingTimeoutSec: parsed.workingTimeoutSec } : {}),
      });
    } catch (e: unknown) {
      // Event listener failures are fatal and reported on service stderr.
      process.stderr.write(`tut: notify: ${(e as Error).message}\n`);
      return 1;
    }
    return 0;
  }) as Handler<Extract<ParsedArgs, { command: "notify" }>>;

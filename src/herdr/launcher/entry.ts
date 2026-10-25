import { runCompatLaunch } from "./compat.js";
import type { LaunchEntry } from "../../core/launcher/entry-parse.js";

/** Execute the parsed entry.  The runner is kept behind this seam so the
 * lifecycle/birth/delivery work units can replace the compatibility runner
 * without changing the CLI process boundary. */
export async function runLaunchEntry(entry: LaunchEntry): Promise<number> {
  return await runCompatLaunch(entry);
}

import { DEFAULT_CHILD_TIMEOUT_MS, cliEntryPath, runInternalLaunch } from "./process.js";

/** Best-effort terminal cleanup after the Hub has accepted close. */
export async function cleanupTaskPanes(taskId: string): Promise<void> {
  const run = await runInternalLaunch(["--cleanup", taskId]);
  if (run.error !== undefined) {
    process.stderr.write(`tut: cannot run internal launcher ${cliEntryPath()}: ${run.error.message} (pane cleanup skipped)\n`);
  } else if (run.timedOut === true) {
    process.stderr.write(
      `tut: launch --cleanup ${taskId} exceeded the child liveness budget (${DEFAULT_CHILD_TIMEOUT_MS}ms) and was killed (task is closed regardless)\n`,
    );
  } else if (run.code !== 0) {
    process.stderr.write(`tut: pane cleanup exited with code ${run.code} (task is closed regardless)\n`);
  }
  if (run.stdout.length > 0) process.stdout.write(run.stdout.endsWith("\n") ? run.stdout : `${run.stdout}\n`);
  if (run.stderr.length > 0) process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);
}

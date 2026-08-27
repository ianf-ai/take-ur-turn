/**
 * Direct process boundary for launcher-owned child processes.
 *
 * Control-plane invocations always use Node's argv API with shell:false.  The
 * only command-string boundary in the launcher is the eventual Herdr pane
 * command, which is deliberately outside this helper and belongs to the
 * shell-dialect work unit.
 */

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serializeLaunchInvocation } from "./invocation.js";
import type { LaunchInvocation } from "../types.js";

export interface DirectSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  /** The launcher always sets this to false; exposed for injectable seams. */
  shell?: false;
}

/** A small injectable seam used by boundary tests and by the CLI/notifier. */
export type DirectSpawn = (file: string, args: readonly string[], options?: DirectSpawnOptions) => ChildProcess;

/** Spawn one executable with one argv item per argument; shell parsing is off. */
export const spawnDirect: DirectSpawn = (file, args, options = {}) =>
  spawn(file, [...args], {
    shell: false,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
  });

/**
 * Resolve the built CLI from either src/launcher or dist/launcher.  Keeping
 * this relative to the module makes npm installs, npm link, and repository
 * checkouts use the same absolute child target.
 */
export function cliEntryPath(metaUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../../dist/cli.js", metaUrl));
}

export interface ChildRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface RunNodeCommandOptions extends DirectSpawnOptions {
  /** Forward stderr chunks immediately (Notifier uses this as its log tee). */
  teeStderr?: (chunk: string) => void;
  /** Override only for tests; production always uses spawnDirect. */
  spawnFn?: DirectSpawn;
}

/** Run a direct child and collect its stdio without turning spawn errors into throws. */
export function runNodeCommand(
  args: readonly string[],
  options: RunNodeCommandOptions = {},
): Promise<ChildRunResult> {
  const spawnFn = options.spawnFn ?? spawnDirect;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnFn(process.execPath, args, {
        shell: false,
        env: { ...process.env, ...(options.env ?? {}) },
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout, stderr, error: error as Error });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options.teeStderr?.(text);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, stdout, stderr, error });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Spawn the internal launch subcommand.  `launchArgs` is the legacy positional
 * boundary; callers that already have the frozen plan should use the
 * invocation helper below so the child receives one JSON argv item.
 */
export function runInternalLaunch(
  launchArgs: readonly string[],
  options: RunNodeCommandOptions = {},
): Promise<ChildRunResult> {
  return runNodeCommand([cliEntryPath(), "launch", ...launchArgs], options);
}

/** Pass one immutable LaunchInvocation across the internal Node boundary. */
export function runInternalLaunchInvocation(
  invocation: LaunchInvocation,
  options: RunNodeCommandOptions = {},
): Promise<ChildRunResult> {
  return runInternalLaunch(["--invocation", serializeLaunchInvocation(invocation)], options);
}

/**
 * Pane runner (dist/launcher/pane-runner.js — launcher port design §3.3).
 *
 * The encoded-form execution target for cmd and PowerShell dialects: it
 * accepts exactly one `--payload <base64url>` argv pair, decodes the
 * versioned JSON, and spawns the target with explicit cwd/env, shell:false,
 * stdio inherited.  It never writes env into the pane shell and never
 * changes the pane's cwd.  Shell/file-association shims (.cmd/.bat/.ps1/.sh)
 * remain refused (exit 126); only native executables and direct Node entries
 * cross this boundary.
 *
 * Exit codes are fixed: 64 payload/contract error, 127 missing executable,
 * 126 permission or refused target type, 1 other spawn error; a child's
 * 0-255 code passes through, signals map to 128+N.
 */

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export const PANE_RUNNER_PROTOCOL_VERSION = 1;

/** The runner also accepts the renderer-internal purpose for chained dispatch. */
export type PaneRunnerPurpose = "agent" | "service" | "pane-runner";

export interface PaneRunnerPayload {
  protocol_version: number;
  cwd: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  purpose: PaneRunnerPurpose;
}

/** Payload decoding/validation failures — exit 64 territory. */
export class PaneRunnerPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneRunnerPayloadError";
  }
}

/** Target types this runner refuses to execute — exit 126 territory. */
export class PaneRunnerTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneRunnerTargetError";
  }
}

const PAYLOAD_FIELDS = new Set(["protocol_version", "cwd", "executable", "args", "env", "purpose"]);
const BASE64URL = /^[A-Za-z0-9_-]*$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PURPOSES: ReadonlySet<string> = new Set(["agent", "service", "pane-runner"]);

function rawString(value: unknown, field: string): string {
  if (typeof value !== "string" || /[\u0000\r\n]/u.test(value)) {
    throw new PaneRunnerPayloadError(`${field} must be a string without NUL/CR/LF`);
  }
  return value;
}

/** Validate a decoded payload object; unknown fields and versions refused. */
export function validatePaneRunnerPayload(value: unknown): PaneRunnerPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PaneRunnerPayloadError("payload must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!PAYLOAD_FIELDS.has(key)) throw new PaneRunnerPayloadError(`payload field '${key}' is not part of the pane-runner protocol`);
  }
  if (raw.protocol_version !== PANE_RUNNER_PROTOCOL_VERSION) {
    throw new PaneRunnerPayloadError(`payload protocol_version ${String(raw.protocol_version)} is not supported (expected 1)`);
  }
  const cwd = rawString(raw.cwd, "payload.cwd");
  if (cwd.length === 0) throw new PaneRunnerPayloadError("payload.cwd must be non-empty");
  if (!path.isAbsolute(cwd)) throw new PaneRunnerPayloadError(`payload.cwd '${cwd}' must be an absolute path`);
  const executable = rawString(raw.executable, "payload.executable");
  if (executable.length === 0) throw new PaneRunnerPayloadError("payload.executable must be non-empty");
  if (!Array.isArray(raw.args)) throw new PaneRunnerPayloadError("payload.args must be an array");
  const args = raw.args.map((arg, index) => rawString(arg, `payload.args[${index}]`));
  if (typeof raw.env !== "object" || raw.env === null || Array.isArray(raw.env)) {
    throw new PaneRunnerPayloadError("payload.env must be an object");
  }
  const env: Record<string, string> = {};
  for (const [name, item] of Object.entries(raw.env as Record<string, unknown>)) {
    if (!ENV_NAME.test(name)) throw new PaneRunnerPayloadError(`payload.env.${name} is not a portable environment name`);
    env[name] = rawString(item, `payload.env.${name}`);
  }
  if (typeof raw.purpose !== "string" || !PURPOSES.has(raw.purpose)) {
    throw new PaneRunnerPayloadError("payload.purpose must be agent, service or pane-runner");
  }
  return { protocol_version: PANE_RUNNER_PROTOCOL_VERSION, cwd, executable, args, env, purpose: raw.purpose as PaneRunnerPurpose };
}

/** Decode and validate the base64url payload token. */
export function decodePaneRunnerPayload(token: string): PaneRunnerPayload {
  if (!BASE64URL.test(token)) throw new PaneRunnerPayloadError("payload token is not base64url (no padding, [A-Za-z0-9_-] only)");
  const json = Buffer.from(token, "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PaneRunnerPayloadError("payload is not valid JSON");
  }
  return validatePaneRunnerPayload(parsed);
}

/** Map a termination signal name to its 128+N exit code (1 when unmappable). */
export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  for (const [name, number] of Object.entries(osConstants.signals)) {
    if (name === signal) return 128 + number;
  }
  return 1;
}

export interface PaneRunnerSpawnPlan {
  file: string;
  args: string[];
}

/**
 * Decide the spawn shape for one payload target.  Shell/file-association
 * shims are refused closed; everything else spawns directly.  The upstream
 * Windows resolver rejects the same family before Herdr mutation, and this
 * second check protects the encoded child boundary if it is called directly.
 */
export function spawnPlanFor(payload: PaneRunnerPayload): PaneRunnerSpawnPlan {
  const extension = path.win32.extname(payload.executable).toLowerCase();
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1" || extension === ".sh") {
    throw new PaneRunnerTargetError(
      `refusing to execute '${payload.executable}': ${extension} targets need a host shell; point the route at a native executable or a direct Node entry instead`,
    );
  }
  return { file: payload.executable, args: [...payload.args] };
}

export interface PaneRunnerDeps {
  /** Injectable for tests; production always uses child_process.spawn. */
  spawnFn?: typeof spawn;
  /** Environment the child inherits (payload env overlays it). */
  env?: NodeJS.ProcessEnv;
}

/** Exit code when the argv itself violates the pane-runner contract. */
export const PANE_RUNNER_USAGE_EXIT = 64;

/** Run the pane-runner main contract against argv and report the exit code. */
export async function runPaneRunner(argv: readonly string[], deps: PaneRunnerDeps = {}): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--payload") {
    process.stderr.write("pane-runner: usage: pane-runner.js --payload <base64url payload>\n");
    return PANE_RUNNER_USAGE_EXIT;
  }
  let payload: PaneRunnerPayload;
  try {
    payload = decodePaneRunnerPayload(argv[1] ?? "");
  } catch (error) {
    process.stderr.write(`pane-runner: ${(error as Error).message}\n`);
    return PANE_RUNNER_USAGE_EXIT;
  }
  let plan: PaneRunnerSpawnPlan;
  try {
    plan = spawnPlanFor(payload);
  } catch (error) {
    process.stderr.write(`pane-runner: ${(error as Error).message}\n`);
    return 126;
  }
  const spawnFn = deps.spawnFn ?? spawn;
  return await new Promise<number>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(plan.file, plan.args, {
        cwd: payload.cwd,
        env: { ...(deps.env ?? process.env), ...payload.env },
        shell: false,
        stdio: "inherit",
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      process.stderr.write(`pane-runner: spawn '${plan.file}' failed (${(error as Error).message})\n`);
      if (code === "ENOENT") return resolve(127);
      if (code === "EACCES" || code === "EPERM") return resolve(126);
      return resolve(1);
    }
    child.once("error", (error: NodeJS.ErrnoException) => {
      process.stderr.write(`pane-runner: spawn '${plan.file}' failed (${error.message})\n`);
      if (error.code === "ENOENT") return resolve(127);
      if (error.code === "EACCES" || error.code === "EPERM") return resolve(126);
      return resolve(1);
    });
    child.once("close", (code, signal) => {
      if (signal !== null) return resolve(signalExitCode(signal));
      if (code !== null) return resolve(code);
      return resolve(1);
    });
  });
}

// Entry-point guard: run only when executed as `node …/pane-runner.js`.
function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const real = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  return real(entry) === real(self) || pathToFileURL(real(entry)).href === pathToFileURL(real(self)).href;
}

if (invokedAsMain()) {
  runPaneRunner(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}

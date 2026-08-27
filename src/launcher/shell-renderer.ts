/**
 * Shell dialect renderer (launcher port design §4; work unit 6).
 *
 * A PaneCommand is the raw, shell-neutral execution request for one pane.
 * The renderer turns it into exactly one `command_text` string for the
 * `herdr pane run` boundary — every other Herdr control call stays on raw
 * argv.  Four dialects are deterministic here: posix (single-quote
 * algorithm), powershell5/pwsh (one conservative script-block form; a
 * non-empty env switches to the Node pane-runner so the pane environment is
 * never touched), and cmd (cmdq direct form, else the encoded pane-runner
 * payload so dynamic values never meet cmd expansion).
 *
 * Service commands keep the legacy POSIX bytes byte-for-byte (`cd <cwd> &&
 * node <cli> …`): the renderer is their single writer now, and existing
 * provisioning output must not drift.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** The only dialects a pane shell may be; unknown values fail before birth. */
export type ShellDialect = "posix" | "powershell5" | "pwsh" | "cmd";

/** PaneCommand purposes the renderer produces (the runner also accepts pane-runner). */
export type PanePurpose = "agent" | "service";

/**
 * The raw pane execution request.  Fields stay raw: no shell quoting, no
 * `cd` fragments, no env prefix — those are renderer output, never input.
 */
export interface PaneCommand {
  /** Non-empty raw working directory (a dry-run preview may carry `<…>` placeholders). */
  cwd: string;
  /** Raw executable word: bare PATH name (POSIX) or an absolute target path. */
  executable: string;
  /** Raw argv tokens in order; empty-string tokens must survive the renderer. */
  args: readonly string[];
  /** One-shot child env; empty by default. Names use portable env syntax. */
  env: Readonly<Record<string, string>>;
  /** Target pane dialect for this command. */
  dialect: ShellDialect;
  /** agent (round launch) or service (tut up hub/notify). */
  purpose: PanePurpose;
}

/** The renderer result: one final string for one herdr pane run call. */
export interface RenderedPaneCommand {
  dialect: ShellDialect;
  command_text: string;
  transport: "herdr-pane-run-single-string";
}

/** TUT_PANE_SHELL carries a value outside the four-dialect vocabulary. */
export class PaneShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneShellError";
  }
}

/** A PaneCommand field violated the raw-input contract. */
export class PaneCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneCommandError";
  }
}

/** A trusted cmd runtime path failed the absolute + cmdq-safe policy. */
export class CmdRuntimePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmdRuntimePathError";
  }
}

const DIALECTS: ReadonlySet<string> = new Set(["posix", "powershell5", "pwsh", "cmd"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Reject the characters no pane command may ever carry. */
function assertRawString(value: string, field: string): void {
  if (typeof value !== "string" || /[\u0000\r\n]/u.test(value)) {
    throw new PaneCommandError(`${field} must be a string without NUL/CR/LF`);
  }
}

/** Validate the raw input shape; quoting decisions stay with each dialect. */
export function validatePaneCommand(command: PaneCommand): void {
  assertRawString(command.cwd, "command.cwd");
  if (command.cwd.length === 0) throw new PaneCommandError("command.cwd must be non-empty");
  assertRawString(command.executable, "command.executable");
  if (command.executable.length === 0) throw new PaneCommandError("command.executable must be non-empty");
  if (!Array.isArray(command.args)) throw new PaneCommandError("command.args must be an array");
  command.args.forEach((arg, index) => assertRawString(arg, `command.args[${index}]`));
  if (typeof command.env !== "object" || command.env === null || Array.isArray(command.env)) {
    throw new PaneCommandError("command.env must be an object");
  }
  for (const [name, value] of Object.entries(command.env)) {
    if (!ENV_NAME.test(name)) throw new PaneCommandError(`command.env.${name} is not a portable environment name`);
    assertRawString(value, `command.env.${name}`);
  }
  if (!DIALECTS.has(command.dialect)) throw new PaneCommandError(`command.dialect '${String(command.dialect)}' is not a known dialect`);
  if (command.purpose !== "agent" && command.purpose !== "service") {
    throw new PaneCommandError("command.purpose must be agent or service");
  }
}

// ---------------------------------------------------------------------------
// Quote primitives
// ---------------------------------------------------------------------------

/** POSIX single-quote: wrap in '…' and replace each ' with the 4-char '\'' sequence. */
export function sq(value: string): string {
  assertRawString(value, "sq input");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** PowerShell single-quote: wrap in '…' and double each embedded '. */
export function psq(value: string): string {
  assertRawString(value, "psq input");
  return `'${value.replaceAll("'", "''")}'`;
}

/** Characters cmd may expand or treat as operators inside any context. */
const CMD_UNSAFE = /[%!^&|<>();"\u0000\r\n]/u;

/** True when a value must never enter a cmd command line unencoded. */
export function cmdUnsafe(value: string): boolean {
  return CMD_UNSAFE.test(value);
}

/**
 * The only direct cmd quoting: always double quotes, safe values only.
 * A trailing backslash run is doubled so it cannot escape the closing quote;
 * no caret escaping, no variable expansion, no second parse.
 */
export function cmdq(value: string): string {
  if (cmdUnsafe(value)) {
    throw new PaneCommandError(`'${value}' contains cmd expansion characters and cannot be quoted for direct cmd use`);
  }
  const trailing = /\\+$/u.exec(value);
  const body = trailing === null
    ? value
    : `${value.slice(0, value.length - trailing[0].length)}${"\\".repeat(trailing[0].length * 2)}`;
  return `"${body}"`;
}

// ---------------------------------------------------------------------------
// Pane-runner payload (cmd encoded form / PowerShell env form)
// ---------------------------------------------------------------------------

/** Fixed payload key order — golden bytes depend on it. */
export interface PaneRunnerPayloadShape {
  protocol_version: number;
  cwd: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  purpose: string;
}

/** Serialize one PaneCommand as the versioned, unpadded base64url payload. */
export function encodePaneRunnerPayload(command: PaneCommand): string {
  validatePaneCommand(command);
  const payload: PaneRunnerPayloadShape = {
    protocol_version: 1,
    cwd: command.cwd,
    executable: command.executable,
    args: [...command.args],
    env: { ...command.env },
    purpose: command.purpose,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// Dialect source and trusted runtime paths
// ---------------------------------------------------------------------------

/**
 * Resolve the pane shell dialect: non-empty TUT_PANE_SHELL, else the platform
 * default (powershell5 on Windows, posix elsewhere).  Unknown configured
 * values throw — never a silent guess.  Herdr pane metadata stays unread (v1).
 */
export function resolvePaneShellDialect(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ShellDialect {
  const configured = environment.TUT_PANE_SHELL;
  if (configured !== undefined && configured.length > 0) {
    if (!DIALECTS.has(configured)) {
      throw new PaneShellError(
        `TUT_PANE_SHELL '${configured}' is not a known pane shell dialect (expected one of posix, powershell5, pwsh, cmd)`,
      );
    }
    return configured as ShellDialect;
  }
  return platform === "win32" ? "powershell5" : "posix";
}

/** Trusted runtime entries the encoded forms invoke. */
export interface PaneRuntimeOptions {
  /** Node executable; defaults to process.execPath. */
  nodeExecutable: string;
  /** Absolute dist/launcher/pane-runner.js entry. */
  paneRunnerEntry: string;
}

/** Resolve the package-absolute pane-runner entry from either src or dist. */
export function defaultPaneRuntime(metaUrl: string = import.meta.url): PaneRuntimeOptions {
  return {
    nodeExecutable: process.execPath,
    paneRunnerEntry: fileURLToPath(new URL("../../dist/launcher/pane-runner.js", metaUrl)),
  };
}

/**
 * cmd runtime paths must be non-empty absolute Windows paths inside the cmdq
 * safe set (spaces are fine — Program Files is supported).  Violations throw
 * CmdRuntimePathError before any Herdr mutation.
 */
function cmdRuntimePath(value: string, field: string): string {
  if (value.length === 0) throw new CmdRuntimePathError(`${field} must be a non-empty absolute Windows path`);
  if (!path.win32.isAbsolute(value)) throw new CmdRuntimePathError(`${field} '${value}' is not an absolute Windows path`);
  if (cmdUnsafe(value)) throw new CmdRuntimePathError(`${field} '${value}' contains cmd expansion characters`);
  return value;
}

// ---------------------------------------------------------------------------
// Dialect renderers
// ---------------------------------------------------------------------------

/**
 * POSIX.  Agent commands use the frozen `cd --` + sq algorithm; service
 * commands keep the legacy provisioning bytes (`cd <cwd> && node <cli> …`)
 * exactly — the renderer inherited them verbatim from tut up.
 */
function renderPosix(command: PaneCommand): string {
  if (command.purpose === "service") {
    const words = [
      ...Object.entries(command.env).map(([name, value]) => `${name}=${value}`),
      command.executable,
      ...command.args,
    ].join(" ");
    return `cd ${command.cwd} && ${words}`;
  }
  const invocation = [
    ...(Object.keys(command.env).length > 0
      ? ["env", ...Object.entries(command.env).map(([name, value]) => sq(`${name}=${value}`))]
      : []),
    sq(command.executable),
    ...command.args.map((arg) => sq(arg)),
  ].join(" ");
  return `cd -- ${sq(command.cwd)} && ${invocation}`;
}

/**
 * PowerShell 5.1 / pwsh — one conservative form for both.  No `&&`, no POSIX
 * env, never a `$env:` write.  Empty env: a script block saves and restores
 * the pane cwd with try/finally.  Non-empty env: the Node pane-runner child
 * isolates the environment; the pane cwd is untouched.
 */
function renderPowerShell(command: PaneCommand, runtime: PaneRuntimeOptions): string {
  if (Object.keys(command.env).length === 0) {
    const invocation = [`& ${psq(command.executable)}`, ...command.args.map((arg) => psq(arg))].join(" ");
    return `& { $savedPath = (Get-Location).Path; $exitCode = 1; try { Set-Location -LiteralPath ${psq(command.cwd)}; ${invocation}; $exitCode = $LASTEXITCODE } finally { Set-Location -LiteralPath $savedPath }; $global:LASTEXITCODE = $exitCode }`;
  }
  const payload = encodePaneRunnerPayload(command);
  return `& ${psq(runtime.nodeExecutable)} ${psq(runtime.paneRunnerEntry)} --payload ${psq(payload)}; $global:LASTEXITCODE = $LASTEXITCODE`;
}

/**
 * cmd.  All dynamic values in the cmdq safe set and an empty env: the direct
 * `cd /d` form.  Anything else: the encoded pane-runner payload — dynamic
 * values then exist only inside the base64url token, never in cmd syntax.
 */
function renderCmd(command: PaneCommand, runtime: PaneRuntimeOptions): string {
  const envEmpty = Object.keys(command.env).length === 0;
  const dynamic = [command.cwd, command.executable, ...command.args];
  if (envEmpty && dynamic.every((value) => !cmdUnsafe(value))) {
    const invocation = [cmdq(command.executable), ...command.args.map((arg) => cmdq(arg))].join(" ");
    return `cd /d ${cmdq(command.cwd)} && ${invocation}`;
  }
  const node = cmdRuntimePath(runtime.nodeExecutable, "nodeExecutable");
  const entry = cmdRuntimePath(runtime.paneRunnerEntry, "paneRunnerEntry");
  const payload = encodePaneRunnerPayload(command);
  return `${cmdq(node)} ${cmdq(entry)} --payload ${cmdq(payload)}`;
}

/** Render one PaneCommand into the single herdr pane run command string. */
export function renderPaneCommand(
  command: PaneCommand,
  runtime: PaneRuntimeOptions = defaultPaneRuntime(),
): RenderedPaneCommand {
  validatePaneCommand(command);
  const command_text = (() => {
    switch (command.dialect) {
      case "posix":
        return renderPosix(command);
      case "powershell5":
      case "pwsh":
        return renderPowerShell(command, runtime);
      case "cmd":
        return renderCmd(command, runtime);
    }
  })();
  return { dialect: command.dialect, command_text, transport: "herdr-pane-run-single-string" };
}

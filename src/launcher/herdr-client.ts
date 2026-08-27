/**
 * Direct Herdr control-plane client.
 *
 * Herdr's control commands are deliberately kept on the executable/argv side
 * of the process boundary.  No method in this module accepts or constructs a
 * shell command string; the only string-valued argument that is forwarded
 * verbatim is the final command passed to `pane run`.
 */

import type { ChildProcess } from "node:child_process";
import { spawnDirect, type DirectSpawn, type DirectSpawnOptions } from "./process.js";

export interface HerdrPane {
  pane_id: string;
  label?: string;
  tab_id?: string;
  workspace_id?: string;
  cwd?: string;
  agent_status?: string;
}

export interface HerdrTab {
  tab_id: string;
  label?: string;
  workspace_id?: string;
  pane_count?: number;
}

export interface HerdrPaneListResult {
  panes: HerdrPane[];
}

export interface HerdrTabListResult {
  tabs: HerdrTab[];
}

export interface HerdrTabCreateResult {
  tabId: string;
  rootPaneId?: string;
}

export interface HerdrPaneCreateResult {
  paneId: string;
}

export interface HerdrMutationResult {
  ok: true;
  /** Parsed Herdr response when the command returned JSON. */
  response?: unknown;
}

export interface HerdrCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type HerdrErrorCode = "SPAWN_ERROR" | "EXIT_ERROR" | "INVALID_RESPONSE" | "INVALID_ARGUMENT";

/** A stable, inspectable error shape for all Herdr client failures. */
export class HerdrClientError extends Error {
  readonly code: HerdrErrorCode;
  readonly operation: string;
  readonly args: string[];
  readonly exitCode?: number | null;
  readonly stderr?: string;

  constructor(
    code: HerdrErrorCode,
    operation: string,
    message: string,
    details: { args?: readonly string[]; exitCode?: number | null; stderr?: string } = {},
  ) {
    super(message);
    this.name = "HerdrClientError";
    this.code = code;
    this.operation = operation;
    this.args = [...(details.args ?? [])];
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.stderr !== undefined && details.stderr.length > 0) this.stderr = details.stderr;
  }
}

export interface HerdrClientOptions {
  /** Herdr executable or absolute path. Defaults to a platform-safe PATH entry. */
  executable?: string;
  /** Environment snapshot for spawned control commands. */
  env?: NodeJS.ProcessEnv;
  /** Injectable direct-spawn seam for unit tests. */
  spawnFn?: DirectSpawn;
  /** Platform override for resolver tests; production defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export interface TabCreateOptions {
  workspaceId?: string;
  cwd?: string;
  label?: string;
  noFocus?: boolean;
}

export interface PaneSplitOptions {
  /** Split this pane; when absent, `current: true` emits --current. */
  paneId?: string;
  current?: boolean;
  direction?: string;
  noFocus?: boolean;
  cwd?: string;
}

export interface PaneMoveOptions {
  tabId: string;
  split?: string;
  ratio?: string | number;
  noFocus?: boolean;
  targetPane?: string;
}

export interface PaneReadOptions {
  source?: string;
  lines?: string | number;
}

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argument(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HerdrClientError("INVALID_ARGUMENT", field, `${field} must be a non-empty string`);
  }
  if (value.includes("\u0000")) {
    throw new HerdrClientError("INVALID_ARGUMENT", field, `${field} must not contain NUL`);
  }
  return value;
}

/**
 * Resolve the control executable without involving a shell.  Windows users
 * commonly have a native `herdr.exe` on PATH; passing the extension explicitly
 * avoids relying on a POSIX-style extensionless shim or shell PATHEXT rules.
 * `TUT_HERDR_EXECUTABLE` is an escape hatch for an installed absolute path and
 * is intentionally shared by the CLI, legacy launcher, and Notifier clients.
 */
export function resolveHerdrExecutable(options: {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): string {
  const environment = options.env ?? process.env;
  const configured = options.executable ?? environment.TUT_HERDR_EXECUTABLE;
  if (configured !== undefined && configured.length > 0) return argument(configured, "herdr executable");
  return (options.platform ?? process.platform) === "win32" ? "herdr.exe" : "herdr";
}

function optionalArgument(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : argument(value, field);
}

function parseJson(text: string, operation: string, args: readonly string[], stderr: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HerdrClientError(
      "INVALID_RESPONSE",
      operation,
      `${operation} returned invalid JSON`,
      { args, stderr },
    );
  }
}

function resultObject(value: unknown): JsonObject {
  if (!isObject(value)) return {};
  return isObject(value.result) ? value.result : value;
}

function responseRows(value: unknown, key: "panes" | "tabs"): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const top = isObject(value) ? value[key] : undefined;
  if (Array.isArray(top)) return top;
  const result = resultObject(value);
  return Array.isArray(result[key]) ? result[key] : undefined;
}

function paneFrom(value: unknown): HerdrPane | undefined {
  if (!isObject(value) || typeof value.pane_id !== "string" || value.pane_id.length === 0) return undefined;
  return {
    pane_id: value.pane_id,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.tab_id === "string" ? { tab_id: value.tab_id } : {}),
    ...(typeof value.workspace_id === "string" ? { workspace_id: value.workspace_id } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.agent_status === "string" ? { agent_status: value.agent_status } : {}),
  };
}

function tabFrom(value: unknown): HerdrTab | undefined {
  if (!isObject(value)) return undefined;
  const tabId = typeof value.tab_id === "string" ? value.tab_id : typeof value.id === "string" ? value.id : undefined;
  if (tabId === undefined || tabId.length === 0) return undefined;
  return {
    tab_id: tabId,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.workspace_id === "string" ? { workspace_id: value.workspace_id } : {}),
    ...(typeof value.pane_count === "number" ? { pane_count: value.pane_count } : {}),
  };
}

function paneIdFrom(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const result = resultObject(value);
  const pane = isObject(result.pane) ? result.pane : isObject(value.pane) ? value.pane : undefined;
  if (isObject(pane) && typeof pane.pane_id === "string" && pane.pane_id.length > 0) return pane.pane_id;
  if (typeof result.pane_id === "string" && result.pane_id.length > 0) return result.pane_id;
  if (typeof value.pane_id === "string" && value.pane_id.length > 0) return value.pane_id;
  return undefined;
}

function tabIdFrom(value: unknown): { tabId?: string; rootPaneId?: string } {
  if (!isObject(value)) return {};
  const result = resultObject(value);
  const tabValue = isObject(result.tab) ? result.tab : isObject(value.tab) ? value.tab : undefined;
  const tab = tabFrom(tabValue);
  const root = isObject(result.root_pane) ? result.root_pane : isObject(value.root_pane) ? value.root_pane : undefined;
  return {
    ...(tab !== undefined ? { tabId: tab.tab_id } : {}),
    ...(isObject(root) && typeof root.pane_id === "string" && root.pane_id.length > 0 ? { rootPaneId: root.pane_id } : {}),
    ...(tab === undefined && typeof result.tab_id === "string" && result.tab_id.length > 0 ? { tabId: result.tab_id } : {}),
    ...(tab === undefined && typeof value.tab_id === "string" && value.tab_id.length > 0 ? { tabId: value.tab_id } : {}),
  };
}

function mutationResponse(result: HerdrCommandResult): HerdrMutationResult {
  if (result.stdout.trim().length === 0) return { ok: true };
  try {
    return { ok: true, response: JSON.parse(result.stdout) };
  } catch {
    // Some Herdr versions use a plain acknowledgement for mutation commands.
    // The exit code remains the authoritative success signal for those calls.
    return { ok: true };
  }
}

/**
 * Herdr control-plane client.  `command()` is the low-level non-throwing seam;
 * verb helpers turn failed exits and malformed required responses into the
 * same HerdrClientError shape.
 */
export class HerdrClient {
  private readonly configuredExecutable: string | undefined;
  private readonly platform: NodeJS.Platform;
  /** An explicit env is frozen; the default client follows the process env. */
  private readonly environment: NodeJS.ProcessEnv | undefined;
  private readonly spawnFn: DirectSpawn;

  constructor(options: HerdrClientOptions = {}) {
    if (options.executable !== undefined) argument(options.executable, "herdr executable");
    this.configuredExecutable = options.executable;
    this.platform = options.platform ?? process.platform;
    this.environment = options.env === undefined ? undefined : { ...options.env };
    this.spawnFn = options.spawnFn ?? spawnDirect;
  }

  /** Resolve late so a process-wide configured executable reaches module-level clients. */
  get executable(): string {
    return resolveHerdrExecutable({
      ...(this.configuredExecutable !== undefined ? { executable: this.configuredExecutable } : {}),
      ...(this.environment !== undefined ? { env: this.environment } : {}),
      platform: this.platform,
    });
  }

  /** Execute an exact Herdr argv and return its process result without throwing. */
  command(args: readonly string[]): Promise<HerdrCommandResult> {
    const argv = args.map((value, index) => argument(value, `herdr argv[${index}]`));
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child: ChildProcess;
      try {
        const options: DirectSpawnOptions = {
          shell: false,
          env: { ...(this.environment ?? process.env) },
          stdio: ["ignore", "pipe", "pipe"],
        };
        child = this.spawnFn(this.executable, argv, options);
      } catch (error) {
        resolve({ code: null, signal: null, stdout, stderr, error: error as Error });
        return;
      }
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
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

  /** Alias useful at call sites that name the operation as an invocation. */
  run(args: readonly string[]): Promise<HerdrCommandResult> {
    return this.command(args);
  }

  private async successful(operation: string, args: readonly string[]): Promise<HerdrCommandResult> {
    const result = await this.command(args);
    if (result.error !== undefined) {
      throw new HerdrClientError(
        "SPAWN_ERROR",
        operation,
        `${operation} failed to spawn: ${result.error.message}`,
        { args, stderr: result.stderr },
      );
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n")[0] ?? "";
      throw new HerdrClientError(
        "EXIT_ERROR",
        operation,
        `${operation} exited ${result.code ?? `signal ${result.signal}`}${detail.length > 0 ? `: ${detail}` : ""}`,
        { args, exitCode: result.code, stderr: result.stderr },
      );
    }
    return result;
  }

  private async jsonCommand(operation: string, args: readonly string[]): Promise<{ result: HerdrCommandResult; value: unknown }> {
    const result = await this.successful(operation, args);
    return { result, value: parseJson(result.stdout, operation, args, result.stderr) };
  }

  async paneList(): Promise<HerdrPaneListResult> {
    const args = ["pane", "list"];
    const { value } = await this.jsonCommand("herdr pane list", args);
    const rows = responseRows(value, "panes");
    if (rows === undefined) {
      throw new HerdrClientError("INVALID_RESPONSE", "herdr pane list", "herdr pane list returned no panes array", { args });
    }
    return { panes: rows.flatMap((row) => {
      const pane = paneFrom(row);
      return pane === undefined ? [] : [pane];
    }) };
  }

  listPanes(): Promise<HerdrPaneListResult> {
    return this.paneList();
  }

  async tabList(workspaceId?: string): Promise<HerdrTabListResult> {
    const args = ["tab", "list"];
    const workspace = optionalArgument(workspaceId, "workspaceId");
    if (workspace !== undefined) args.push("--workspace", workspace);
    const { value } = await this.jsonCommand("herdr tab list", args);
    const rows = responseRows(value, "tabs");
    if (rows === undefined) {
      throw new HerdrClientError("INVALID_RESPONSE", "herdr tab list", "herdr tab list returned no tabs array", { args });
    }
    return { tabs: rows.flatMap((row) => {
      const tab = tabFrom(row);
      return tab === undefined ? [] : [tab];
    }) };
  }

  listTabs(workspaceId?: string): Promise<HerdrTabListResult> {
    return this.tabList(workspaceId);
  }

  async tabCreate(options: TabCreateOptions = {}): Promise<HerdrTabCreateResult> {
    const args = ["tab", "create"];
    const workspace = optionalArgument(options.workspaceId, "workspaceId");
    const cwd = optionalArgument(options.cwd, "cwd");
    const label = optionalArgument(options.label, "label");
    // Keep the two established Herdr call-site orders stable: workspace
    // births put workspace/cwd before naming, while the system-pane `up`
    // path historically emits label/no-focus before its cwd.
    if (workspace !== undefined) {
      args.push("--workspace", workspace);
      if (cwd !== undefined) args.push("--cwd", cwd);
      if (label !== undefined) args.push("--label", label);
      if (options.noFocus === true) args.push("--no-focus");
    } else {
      if (label !== undefined) args.push("--label", label);
      if (options.noFocus === true) args.push("--no-focus");
      if (cwd !== undefined) args.push("--cwd", cwd);
    }
    const { value } = await this.jsonCommand("herdr tab create", args);
    const ids = tabIdFrom(value);
    if (ids.tabId === undefined) {
      throw new HerdrClientError("INVALID_RESPONSE", "herdr tab create", "herdr tab create returned no tab id", { args });
    }
    return ids as HerdrTabCreateResult;
  }

  createTab(options: TabCreateOptions = {}): Promise<HerdrTabCreateResult> {
    return this.tabCreate(options);
  }

  async paneSplit(options: PaneSplitOptions): Promise<HerdrPaneCreateResult> {
    const args = ["pane", "split"];
    const paneId = optionalArgument(options.paneId, "paneId");
    if (paneId !== undefined) args.push(paneId);
    else if (options.current === true) args.push("--current");
    else throw new HerdrClientError("INVALID_ARGUMENT", "herdr pane split", "pane split requires paneId or current=true", { args });
    const direction = optionalArgument(options.direction, "direction");
    const cwd = optionalArgument(options.cwd, "cwd");
    if (direction !== undefined) args.push("--direction", direction);
    if (options.noFocus === true) args.push("--no-focus");
    if (cwd !== undefined) args.push("--cwd", cwd);
    const { value } = await this.jsonCommand("herdr pane split", args);
    const paneIdResult = paneIdFrom(value);
    if (paneIdResult === undefined) {
      throw new HerdrClientError("INVALID_RESPONSE", "herdr pane split", "herdr pane split returned no pane id", { args });
    }
    return { paneId: paneIdResult };
  }

  splitPane(paneId: string, options: Omit<PaneSplitOptions, "paneId" | "current"> = {}): Promise<HerdrPaneCreateResult> {
    return this.paneSplit({ ...options, paneId });
  }

  async paneMove(paneId: string, options: PaneMoveOptions): Promise<HerdrMutationResult> {
    const pane = argument(paneId, "paneId");
    const tab = argument(options.tabId, "tabId");
    const args = ["pane", "move", pane, "--tab", tab];
    const split = optionalArgument(options.split, "split");
    if (split !== undefined) args.push("--split", split);
    if (options.ratio !== undefined) args.push("--ratio", argument(String(options.ratio), "ratio"));
    if (options.noFocus === true) args.push("--no-focus");
    const targetPane = optionalArgument(options.targetPane, "targetPane");
    if (targetPane !== undefined) args.push("--target-pane", targetPane);
    const result = await this.successful("herdr pane move", args);
    return mutationResponse(result);
  }

  movePane(paneId: string, options: PaneMoveOptions): Promise<HerdrMutationResult> {
    return this.paneMove(paneId, options);
  }

  async paneClose(paneId: string): Promise<HerdrMutationResult> {
    const args = ["pane", "close", argument(paneId, "paneId")];
    const result = await this.successful("herdr pane close", args);
    return mutationResponse(result);
  }

  closePane(paneId: string): Promise<HerdrMutationResult> {
    return this.paneClose(paneId);
  }

  async paneRename(paneId: string, label: string): Promise<HerdrMutationResult> {
    const args = ["pane", "rename", argument(paneId, "paneId"), argument(label, "label")];
    const result = await this.successful("herdr pane rename", args);
    return mutationResponse(result);
  }

  renamePane(paneId: string, label: string): Promise<HerdrMutationResult> {
    return this.paneRename(paneId, label);
  }

  async paneRun(paneId: string, commandText: string): Promise<HerdrMutationResult> {
    const args = ["pane", "run", argument(paneId, "paneId"), argument(commandText, "commandText")];
    const result = await this.successful("herdr pane run", args);
    return mutationResponse(result);
  }

  runPane(paneId: string, commandText: string): Promise<HerdrMutationResult> {
    return this.paneRun(paneId, commandText);
  }

  async paneRead(paneId: string, options: PaneReadOptions = {}): Promise<string> {
    const args = ["pane", "read", argument(paneId, "paneId")];
    const source = optionalArgument(options.source, "source");
    if (source !== undefined) args.push("--source", source);
    if (options.lines !== undefined) args.push("--lines", argument(String(options.lines), "lines"));
    const result = await this.successful("herdr pane read", args);
    return result.stdout;
  }

  readPane(paneId: string, options: PaneReadOptions = {}): Promise<string> {
    return this.paneRead(paneId, options);
  }

  async paneSendText(paneId: string, text: string): Promise<HerdrMutationResult> {
    const args = ["pane", "send-text", argument(paneId, "paneId"), argument(text, "text")];
    const result = await this.successful("herdr pane send-text", args);
    return mutationResponse(result);
  }

  sendText(paneId: string, text: string): Promise<HerdrMutationResult> {
    return this.paneSendText(paneId, text);
  }

  async paneSendKeys(paneId: string, ...keys: string[]): Promise<HerdrMutationResult> {
    const args = ["pane", "send-keys", argument(paneId, "paneId"), ...keys.map((key, index) => argument(key, `key[${index}]`))];
    const result = await this.successful("herdr pane send-keys", args);
    return mutationResponse(result);
  }

  sendKeys(paneId: string, ...keys: string[]): Promise<HerdrMutationResult> {
    return this.paneSendKeys(paneId, ...keys);
  }
}

export function createHerdrClient(options: HerdrClientOptions = {}): HerdrClient {
  return new HerdrClient(options);
}

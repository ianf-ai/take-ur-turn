/**
 * Anchored pane birth.
 *
 * A tab created with an explicit workspace and cwd ships an empty root pane;
 * that root is adopted first.  If adoption cannot complete, the fallback
 * splits the frozen anchor, moves the split into the known tab, and performs
 * bounded root cleanup.  This module never resolves routes or naming values.
 */

import type { LaunchAnchor } from "../types.js";
import type { HerdrCommandResult, HerdrPane } from "./herdr-client.js";

export interface BirthClient {
  command(args: readonly string[]): Promise<HerdrCommandResult>;
}

export interface BirthOptions {
  client: BirthClient;
  anchor: LaunchAnchor;
  birthCwd: string;
  tabLabel: string;
  paneLabel: string;
  commandText: string;
  executable?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Legacy preview-only presence check; canonical invocations are preflighted upstream. */
  preflightAgent?: () => Promise<boolean>;
  preflightAgentName?: string;
}

export interface BirthPaneList {
  panes: HerdrPane[];
  usable: boolean;
  error?: string;
}

type JsonObject = Record<string, unknown>;

function out(options: BirthOptions, text: string): void {
  (options.stdout ?? ((value: string) => process.stdout.write(value)))(text);
}

function err(options: BirthOptions, text: string): void {
  (options.stderr ?? ((value: string) => process.stderr.write(value)))(text);
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function resultObject(value: unknown): JsonObject {
  const root = object(value);
  const result = root === undefined ? undefined : object(root.result);
  return result ?? root ?? {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function paneIdFrom(value: unknown): string | undefined {
  const root = object(value);
  const result = resultObject(value);
  const pane = object(result.pane) ?? (root === undefined ? undefined : object(root.pane));
  return string(pane?.pane_id) ?? string(result.pane_id) ?? string(root?.pane_id);
}

function tabIdFrom(value: unknown): { tabId?: string; rootPaneId?: string } {
  const root = object(value);
  const result = resultObject(value);
  const tab = object(result.tab) ?? (root === undefined ? undefined : object(root.tab));
  const rootPane = object(result.root_pane) ?? (root === undefined ? undefined : object(root.root_pane));
  const tabId = string(tab?.tab_id)
    ?? string(tab?.id)
    ?? string(result.tab_id)
    ?? string(rootPane?.tab_id)
    ?? string(root?.tab_id);
  const rootPaneId = string(rootPane?.pane_id);
  return {
    ...(tabId === undefined ? {} : { tabId }),
    ...(rootPaneId === undefined ? {} : { rootPaneId }),
  };
}

function paneRows(value: unknown): unknown[] | undefined {
  const root = object(value);
  if (Array.isArray(value)) return value;
  if (Array.isArray(root?.panes)) return root.panes;
  const result = resultObject(value);
  return Array.isArray(result.panes) ? result.panes : undefined;
}

function normalizePaneRows(value: unknown): BirthPaneList {
  const rows = paneRows(value);
  if (rows === undefined) return { panes: [], usable: false, error: "unparseable pane list" };
  return {
    usable: true,
    panes: rows.flatMap((row) => {
      const item = object(row);
      const paneId = string(item?.pane_id);
      if (paneId === undefined) return [];
      const label = string(item?.label);
      const tabId = string(item?.tab_id);
      const workspaceId = string(item?.workspace_id);
      const cwd = string(item?.cwd);
      const agentStatus = string(item?.agent_status);
      return [{
        pane_id: paneId,
        ...(label === undefined ? {} : { label }),
        ...(tabId === undefined ? {} : { tab_id: tabId }),
        ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(agentStatus === undefined ? {} : { agent_status: agentStatus }),
      }];
    }),
  };
}

async function command(client: BirthClient, args: readonly string[]): Promise<HerdrCommandResult> {
  try {
    return await client.command(args);
  } catch (error) {
    return { code: null, signal: null, stdout: "", stderr: "", error: error as Error };
  }
}

function succeeded(result: HerdrCommandResult | undefined): boolean {
  return result !== undefined && result.error === undefined && result.code === 0;
}

type TabCreateOutcome = "success" | "numeric-exit" | "spawn-failure" | "signal" | "unknown";

function tabCreateOutcome(result: HerdrCommandResult | undefined): TabCreateOutcome {
  if (succeeded(result)) return "success";
  if (result?.error !== undefined) return "spawn-failure";
  if (result?.signal !== null && result?.signal !== undefined) return "signal";
  if (typeof result?.code === "number" && result.code !== 0) return "numeric-exit";
  return "unknown";
}

function tabCreateExitDetail(result: HerdrCommandResult | undefined): string {
  if (result?.error !== undefined) return result.error.message;
  if (result?.signal !== null && result?.signal !== undefined) return `signal ${result.signal}`;
  if (typeof result?.code === "number") return `exit ${result.code}`;
  return "unknown termination";
}

async function readPanes(client: BirthClient): Promise<BirthPaneList> {
  const result = await command(client, ["pane", "list"]);
  if (!succeeded(result)) {
    return { panes: [], usable: false, error: (result.error?.message ?? result.stderr.trim()) || `exit ${result.code ?? "?"}` };
  }
  return normalizePaneRows(parseJson(result.stdout));
}

function tabIdByLabel(value: unknown, label: string): string | undefined {
  const root = object(value);
  const result = resultObject(value);
  const rows = Array.isArray(root?.tabs) ? root.tabs : Array.isArray(result.tabs) ? result.tabs : [];
  for (const row of rows) {
    const item = object(row);
    if (item?.label !== label) continue;
    const id = string(item.tab_id) ?? string(item.id);
    if (id !== undefined) return id;
  }
  return undefined;
}

function envInt(environment: NodeJS.ProcessEnv | undefined, name: string, fallback: number): number {
  const raw = environment?.[name];
  if (raw === undefined || !/^\d+$/u.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Close all panes in a tab except the newly moved work pane. */
export async function sweepTabRoots(
  client: BirthClient,
  tabId: string,
  keepPaneId: string,
  mode: "retry" | "sweep",
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  const attempts = mode === "retry" ? Math.max(1, envInt(environment ?? process.env, "TUT_ROOT_SWEEP_RETRIES", 3)) : 1;
  const waitMs = envInt(environment ?? process.env, "TUT_ROOT_SWEEP_RETRY_MS", 200);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const listing = await readPanes(client);
    const leftovers = listing.panes.filter((pane) => pane.tab_id === tabId && pane.pane_id !== keepPaneId);
    if (leftovers.length > 0) {
      for (const pane of leftovers) await command(client, ["pane", "close", pane.pane_id]);
      return;
    }
    if (attempt + 1 < attempts) await delay(waitMs);
  }
}

/** Execute one anchored birth and return the adopted or fallback pane id. */
export async function birthPane(options: BirthOptions): Promise<string | undefined> {
  if (options.preflightAgent !== undefined) {
    let present = false;
    try {
      present = await options.preflightAgent();
    } catch {
      present = false;
    }
    if (!present) {
      const agent = options.preflightAgentName ?? "agent";
      if (options.dryRun) {
        out(options, `DRY-RUN: birth skipped: agent '${agent}' not on PATH\n`);
        return "";
      }
      err(options, `launch: agent '${agent}' not on PATH — cannot birth a pane for it\n`);
      return undefined;
    }
  }

  if (options.dryRun) {
    out(options, `DRY-RUN: birth: herdr tab create --workspace ${options.anchor.workspace_id} --cwd ${options.birthCwd} --label ${options.tabLabel} --no-focus\n`);
    out(options, "DRY-RUN: birth: adopt the tab's root pane (response root_pane, else pane list by tab_id)\n");
    out(options, `DRY-RUN: birth: herdr pane rename <root> ${options.paneLabel}\n`);
    out(options, `DRY-RUN: birth: herdr pane run <root> ${options.commandText}\n`);
    return "<dry-root>";
  }

  const createArgs = [
    "tab", "create", "--workspace", options.anchor.workspace_id,
    "--cwd", options.birthCwd, "--label", options.tabLabel, "--no-focus",
  ];
  const create = await command(options.client, createArgs);
  const createOutcome = tabCreateOutcome(create);
  // A spawn error means Herdr never ran the command, so there is no safe birth
  // fallback to attempt.  More importantly, it must not be confused with the
  // numeric-exit case below, which is the only failure that permits a second
  // tab create.
  if (createOutcome === "spawn-failure") {
    err(options, `launch: herdr tab create could not start (${tabCreateExitDetail(create)}) — refusing birth; check Herdr availability and retry\n`);
    return undefined;
  }
  let tabId: string | undefined;
  let rootId: string | undefined;
  const ids = tabIdFrom(parseJson(create.stdout));
  tabId = ids.tabId;
  rootId = ids.rootPaneId;

  // A successful create, a signal termination, or an otherwise unknown
  // termination may already have mutated Herdr.  Recover by identity before
  // doing any fallback work.  A numeric non-zero exit is the one explicit
  // failure boundary where the legacy split + second-create fallback remains
  // safe and intentional.
  const mayHaveCreatedTab = createOutcome === "success" || createOutcome === "signal" || createOutcome === "unknown";
  if (tabId === undefined && mayHaveCreatedTab) {
    const tabs = await command(options.client, ["tab", "list", "--workspace", options.anchor.workspace_id]);
    if (succeeded(tabs)) tabId = tabIdByLabel(parseJson(tabs.stdout), options.tabLabel);
    if (tabId !== undefined) {
      const prefix = createOutcome === "success" ? "tab create output unparseable" : `tab create ${tabCreateExitDetail(create)}`;
      err(options, `launch: ${prefix} — tab id recovered via tab list ('${tabId}')\n`);
    }
  }
  if (tabId !== undefined && rootId === undefined) {
    const listing = await readPanes(options.client);
    rootId = listing.panes.find((pane) => pane.tab_id === tabId)?.pane_id;
  }

  if (rootId !== undefined) {
    const renamed = await command(options.client, ["pane", "rename", rootId, options.paneLabel]);
    const ran = succeeded(renamed) ? await command(options.client, ["pane", "run", rootId, options.commandText]) : undefined;
    if (succeeded(renamed) && succeeded(ran)) return rootId;
    await command(options.client, ["pane", "close", rootId]);
  }

  if (tabId === undefined && createOutcome !== "numeric-exit") {
    err(options, `launch: herdr tab create ${tabCreateExitDetail(create)} left tab identity unresolved — refusing a second create; inspect the tab manually\n`);
    return undefined;
  }

  err(options, "launch: adopt-root birth failed — falling back to the anchored split sequence\n");
  const split = await command(options.client, [
    "pane", "split", options.anchor.pane_id,
    "--direction", "right", "--no-focus", "--cwd", options.birthCwd,
  ]);
  const newPane = succeeded(split) ? paneIdFrom(parseJson(split.stdout)) : undefined;
  if (newPane === undefined) {
    err(options, "launch: herdr pane split returned no pane_id\n");
    return undefined;
  }

  if (tabId === undefined) {
    // Only a numeric non-zero Herdr exit reaches this branch.  Signal,
    // unknown, and spawn outcomes returned above before any second create.
    const second = await command(options.client, [
      "tab", "create", "--workspace", options.anchor.workspace_id,
      "--cwd", options.birthCwd, "--label", options.tabLabel, "--no-focus",
    ]);
    if (succeeded(second)) tabId = tabIdFrom(parseJson(second.stdout)).tabId;
    if (tabId === undefined) {
      err(options, "launch: herdr tab create returned no tab id\n");
      return undefined;
    }
  }

  const moved = await command(options.client, ["pane", "move", newPane, "--tab", tabId, "--split", "down"]);
  if (!succeeded(moved)) {
    err(options, `launch: herdr pane move ${newPane} --tab ${tabId} failed\n`);
    return undefined;
  }
  await sweepTabRoots(options.client, tabId, newPane, "retry", options.env);
  const renamed = await command(options.client, ["pane", "rename", newPane, options.paneLabel]);
  if (!succeeded(renamed)) {
    err(options, `launch: herdr pane rename ${newPane} ${options.paneLabel} failed\n`);
    return undefined;
  }
  const ran = await command(options.client, ["pane", "run", newPane, options.commandText]);
  if (!succeeded(ran)) {
    err(options, `launch: herdr pane run ${newPane} ${options.executable ?? options.commandText.split(/\s+/u)[0] ?? "agent"} failed\n`);
    return undefined;
  }
  await sweepTabRoots(options.client, tabId, newPane, "sweep", options.env);
  return newPane;
}

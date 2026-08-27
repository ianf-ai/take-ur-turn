#!/usr/bin/env node
/**
 * `tut` CLI entry — command handlers per subcommand group: the context
 * commands (create/publish/read/list/decide via hub-client over /mcp, plus
 * ack — a thin human wrapper over the same publish path — and status, a human
 * overview over the same hubList); notify wires the Notifier loop.
 *
 * Parser conventions (frozen): every value flag accepts BOTH `--flag value` and
 * `--flag=value`; boolean flags (`--json`) take no value. Flags not declared
 * for the command are "unknown argument" errors. `--url` is the Hub BASE url
 * (default http://127.0.0.1:3001); consumers append their own path. Every
 * hub-client command carries it (optional flag, default
 * DEFAULT_HUB_URL applied in the handler). No deps.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import {
  renderPaneCommand,
  resolvePaneShellDialect,
  type PaneCommand,
  type ShellDialect,
} from "./launcher/shell-renderer.js";
import { runNotify } from "./notifier.js";
import {
  autoSectionOf,
  CONFIG_KEYS,
  configKeysHint,
  configPath,
  parseConfigValue,
  readConfigFile,
  writeConfigKey,
  type Config,
  type ReadOutcome,
} from "./config.js";
import { launchBlocked, latestRecordVersion, markLaunched, readLaunchLog } from "./launch.js";
import { assertLaunchStateGate, bindLaunchBaseVersion, buildLaunchInvocation } from "./launcher/invocation.js";
import {
  AgentTargetError,
  UnsupportedWindowsShimError,
  resolvePlatformExecutionPlan,
} from "./launcher/target-resolver.js";
import { cliEntryPath, runInternalLaunch, runInternalLaunchInvocation, spawnDirect } from "./launcher/process.js";
import { parseLaunchEntry, runLaunchEntry } from "./launcher/entry.js";
import { requireBirthAnchor, resolveExecutionContext } from "./launcher/anchor.js";
import { HerdrClient, type HerdrPane as HerdrClientPane } from "./launcher/herdr-client.js";
import {
  KNOWN_ROLES,
  defaultUserConfigDir,
  readWorkspaceConfigSnapshot,
  resolveAgentRoute,
  resolveAgentRouteWithSource,
  resolveTabLabelTemplateFromSnapshot,
} from "./workspace.js";
import { AgentCommandError, formatAgentRoute, parseAgentInvocation, parseAgentRoute } from "./agent-command.js";
import {
  hubCreate,
  hubDecide,
  hubList,
  hubPublish,
  hubRead,
  HubError,
  type HubListEntry,
  type HubListResult,
  type HubReadResult,
} from "./hub-client.js";
import type { AgentRoute, Cast, Flow, LaunchRequest } from "./types.js";

/** Human rendering of a cast: "executor=pi, reviewer=codex" (insertion order). */
function formatCast(cast: Cast): string {
  return Object.entries(cast)
    .map(([role, route]) => `${role}=${formatAgentRoute(route)}`)
    .join(", ");
}

export const USAGE = `tut — Take Ur Turn Context Hub

Usage:
  tut serve [--port <n>] [--root <dir>]
      Start the Context Hub (MCP + /state). Default 127.0.0.1:3001; port 0 = ephemeral.
  tut notify [--url <u>] [--interval <s>] [--event-port <p>] [--stall-timeout <m>] [--working-timeout <s>]
      Run the Notifier (poll /state, receive agent events, notify via channels).
      Defaults: url http://127.0.0.1:3001, interval 5s, event-port 3002,
      stall-timeout 30min, launch-working timeout 300s.
  tut mode <manual|auto> [--url <u>]
      Switch flow_mode (takes effect on the next poll cycle).
  tut config get <key> [--root <dir>]
  tut config set <key> <value> [--root <dir>]
      Read / write project runtime config (.context-hub/config.json — the
      file serve re-reads every request, so writes take effect on the next
      poll cycle, no restart; works with the Hub down, same discipline as
      tut assign). Keys: flow_mode ("manual"|"auto" — the offline equivalent
      of tut mode), auto.launch_roles (comma-separated bare role names —
      e.g. architect,executor,reviewer; "" clears the whitelist). get also
      reads notify (read-only: an object config,
      edit config.json by hand). Unknown keys and illegal values are
      rejected with the available keys and their value domains. Default
      --root: .context-hub (relative to cwd — run from the project root,
      the same root tut serve defaults to).
  tut start-next [<task_id>] [--url <u>] [--force] [--fresh]
      Human-confirmed launch of the next agent. Without task_id: pick the single
      task waiting on an agent (none → list human-waiting tasks; ambiguous →
      list candidates and ask to specify). Duplicate launches are blocked;
      --force relaunches after a failed launch. --fresh (orthogonal to
      --force): force-close the task's same-role pane and birth a brand-new
      one — the explicit outside-perspective choice (system-design 4.4);
      the Notifier never passes it.
  tut launch [--fresh] <task_id> <role> [<agent> [<arg>...]]
  tut launch --cleanup <task_id>
      Internal launch entry used by start-next, Notifier, and the POSIX shim.
  tut watch [<task_id>] [--url <u>] [--interval <s>]
      Watch a task until its derived state changes, then exit with a code
      for the situation: 0 = round boundary (a new record advanced the
      state — someone's turn, including the pending_approval human gate),
      2 = terminal state (approved / closed), 3 = needs attention,
      1 = operational error (unreachable Hub, unknown task, ambiguous
      selection). Baseline is the state at start; a task ALREADY terminal
      or needs-attention exits immediately. Without task_id: the single
      task waiting for an agent (same default selection as start-next).
      Default interval 5s; transient fetch failures are retried with a
      throttled warning.
  tut create --title <t> --description <d> --creator <c> --role <r> [--flow <full|direct|solo>] [--cast <role=command>]... [--url <u>]
      Create a task; prints task_id, status, version. flow picks the workflow
      (immutable after creation, default full): full = design → implement →
      review → approval; direct = design already exists, starts implementing;
      solo = small change, review skipped (code_changes → approval directly).
      cast routes individual roles of THIS task to other agents (e.g.
      --cast executor=pi --cast 'reviewer=codex --model gpt-5.6'); routing
      only, immutable like flow. The legacy comma form remains supported;
      command values are shell-neutral argv words.
      create is the initiating-side action (host/human): the task exists before
      any delivery, and the first round is an ordinary round — manual mode
      starts it with tut start-next <task_id>; auto mode lets the Notifier
      auto-launch it (per its whitelist).
  tut publish <task_id> --role <r> --content-type <t> --summary <s>
             (--body <text> | --payload-file <md>)
             [--verdict <pass|fail_code|fail_design>] [--commits <a,b>]
             [--ref-version <n>] [--expected-version <n>] [--agent <a>] [--model <m>] [--url <u>]
      Append a context record. --summary required; body via --body or --payload-file.
  tut read <task_id> [--since-version <n>] [--json] [--url <u>]
      Read a task's records + derived status. --since-version returns records
      with version >= n (n itself included). --json for machine output.
  tut list [--status <s>] [--json] [--url <u>]
      List tasks (optionally filtered by derived status).
  tut decide <task_id> --decision <approve|reject|close> --by <b> [--reason <text>] [--url <u>]
      Record a human decision. decide close also reaps the task's panes
      (best-effort; the decision itself never depends on the terminal).
  tut assign <role> <command...>
      Change which agent command occupies a role seat, writing the PROJECT-level
      .context-hub/workspace.json (cwd). Missing file → initialized from the
      currently effective lineup (all three roles) first; a corrupt file is
      never clobbered. User-level ~/.config/tut/workspace.json is maintained
      by hand (a low-frequency machine-wide declaration).
  tut up [--url <u>] [--dry-run]
      Provision the workspace power switch (idempotent): hub + notify panes
      only — role/agent panes are no longer pre-provisioned: launchers
      raise agent panes on demand at hand-off time. --url targets a
      non-default local hub (loopback + explicit port).
  tut ack <task_id> [--note <text>] [--url <u>]
      Acknowledge a task's anomalies as handled: appends a human note with
      ack=true — accumulated warnings clear and needs_attention resets on
      the next state pass. Existing records are never modified.
  tut status [--json] [--url <u>]
      Human overview: task totals (attention/closed counts) plus a table of
      every task — needs_attention first, then newest updates first.
      One-shot snapshot (continuous watching is tut notify's job); --json
      prints the same filtered/sorted snapshot for scripts.
  tut skill <host|architect|executor|reviewer>
      Print a role skill's full text. The skills directory is resolved
      module-relative (../skills — npm install, git clone, and npm link
      shapes all work), read locally, zero network: runs inside
      default-sandboxed agent sessions.
  tut init
      Full onboarding for this repo, one command, idempotent (a non-JS
      repo becomes a TUT project without any hand editing): creates
      .context-hub/, appends it to .gitignore (no duplicate entry when the
      ignore rule is already there), and maintains the TUT block in this
      project's AGENTS.md (creates the file when absent; an existing marked
      block is refreshed in place, never duplicated). The block tells
      agents receiving "act as TUT Host / drive this task" instructions to
      run 'tut skill host'; worker-role skills are supplied automatically
      by the launcher.
`;

// --- parsed shapes (frozen — handlers consume these) -------------------------

export type ParsedArgs =
  | { command: "serve"; port?: number; root: string }
  | {
      command: "notify";
      url: string;
      interval: number;
      eventPort: number;
      stallTimeoutMin: number;
      /** Optional so the default parse shape remains backward compatible. */
      workingTimeoutSec?: number;
    }
  | { command: "mode"; mode: "manual" | "auto"; url: string }
  | { command: "config"; action: "get" | "set"; key: string; value?: string; root: string }
  | { command: "start-next"; task_id?: string; url: string; force: boolean; fresh: boolean }
  | { command: "launch"; args: string[] }
  | { command: "watch"; task_id?: string; url: string; interval: number }
  | { command: "create"; title: string; description: string; creator: string; role: string; flow?: Flow; cast?: Cast; url?: string }
  | {
      command: "publish";
      task_id: string;
      role: string;
      content_type: string;
      summary: string;
      body?: string;
      payloadFile?: string;
      verdict?: string;
      commits?: string[];
      refVersion?: number;
      expectedVersion?: number;
      agent?: string;
      model?: string;
      url?: string;
    }
  | { command: "read"; task_id: string; sinceVersion?: number; json: boolean; url?: string }
  | { command: "list"; status?: string; json: boolean; url?: string }
  | { command: "status"; json: boolean; url?: string }
  | { command: "decide"; task_id: string; decision: "approve" | "reject" | "close"; by: string; reason?: string; url?: string }
  | { command: "ack"; task_id: string; note?: string; url?: string }
  | { command: "assign"; role: "architect" | "executor" | "reviewer"; agent: AgentRoute }
  | { command: "up"; dryRun: boolean; url?: string }
  | { command: "skill"; role: SkillRole }
  | { command: "init" }
  | { command: "usage"; error?: string };

// --- shared tokenizer ---------------------------------------------------------

interface Tokens {
  positionals: string[];
  flags: Map<string, string>;
  /** All values for explicitly repeatable value flags, in input order. */
  repeated: Map<string, string[]>;
  bools: Set<string>;
}

interface FlagSpec {
  /** value-taking flags legal for this command */
  values: ReadonlySet<string>;
  /** boolean flags legal for this command */
  bools?: ReadonlySet<string>;
  /** value flags which may occur more than once (currently create --cast). */
  repeatable?: ReadonlySet<string>;
}

function tokenize(args: readonly string[], spec: FlagSpec): Tokens | { error: string } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const bools = new Set<string>();
  const boolSpec = spec.bools ?? new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (name.length === 0) return { error: `unknown argument: ${arg}` };
      if (!spec.values.has(name) && !boolSpec.has(name)) {
        return { error: `unknown argument: --${name}` };
      }
      if (flags.has(name) || bools.has(name)) {
        if (!spec.repeatable?.has(name) || bools.has(name)) return { error: `duplicate flag: --${name}` };
        const next = args[i + 1];
        if (eq === -1 && (next === undefined || next.startsWith("--"))) {
          return { error: `--${name} requires a value` };
        }
        const value = eq === -1 ? next! : arg.slice(eq + 1);
        const values = repeated.get(name) ?? [flags.get(name)!];
        values.push(value);
        repeated.set(name, values);
        if (eq === -1) i++;
        continue;
      }
      if (boolSpec.has(name)) {
        if (eq !== -1) return { error: `--${name} does not take a value` };
        bools.add(name);
      } else if (eq !== -1) {
        flags.set(name, arg.slice(eq + 1));
      } else {
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          return { error: `--${name} requires a value` };
        }
        flags.set(name, next);
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags, repeated, bools };
}

type FlagResult<T> = { value: T } | { error: string };

/**
 * Positional-count check: commands taking a fixed number of positionals
 * reject extras as usage errors instead of silently ignoring them.
 */
function extraPositionalError(tokens: Tokens, expected: number): string | undefined {
  const extra = tokens.positionals[expected];
  return extra === undefined ? undefined : `unexpected argument: ${extra}`;
}

function intFlag(tokens: Tokens, name: string): FlagResult<number> | { value?: undefined; error?: undefined } {
  const raw = tokens.flags.get(name);
  if (raw === undefined) return {};
  if (!/^\d+$/.test(raw)) {
    return { error: `--${name} requires a non-negative integer, got: ${raw}` };
  }
  return { value: Number.parseInt(raw, 10) };
}

function strFlag(tokens: Tokens, name: string): string | undefined {
  return tokens.flags.get(name);
}

function strFlags(tokens: Tokens, name: string): string[] {
  return tokens.repeated.get(name) ?? (tokens.flags.has(name) ? [tokens.flags.get(name)!] : []);
}

function requireStr(tokens: Tokens, name: string): FlagResult<string> {
  const v = tokens.flags.get(name);
  if (v === undefined || v.length === 0) return { error: `--${name} is required` };
  return { value: v };
}

function flagValue<T>(r: FlagResult<T> | { value?: undefined; error?: undefined }): T | undefined {
  return "value" in r ? r.value : undefined;
}

function flagError(r: FlagResult<unknown> | { value?: undefined; error?: undefined }): string | undefined {
  return "error" in r ? r.error : undefined;
}

// --- per-command parsers ------------------------------------------------------

const JSON_BOOLS = new Set(["json"]);

function parseServe(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["port", "root"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const port = intFlag(t, "port");
  const portErr = flagError(port);
  if (portErr !== undefined) return { command: "usage", error: portErr };
  const portValue = flagValue(port);
  const root = strFlag(t, "root") ?? ".context-hub";
  return { command: "serve", ...(portValue !== undefined ? { port: portValue } : {}), root };
}

function parseNotify(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, {
    values: new Set(["url", "interval", "event-port", "stall-timeout", "working-timeout", "launch-working-timeout", "launch-timeout"]),
  });
  if ("error" in t) return { command: "usage", error: t.error };
  for (const name of ["interval", "event-port", "stall-timeout"] as const) {
    const err = flagError(intFlag(t, name));
    if (err !== undefined) return { command: "usage", error: err };
  }
  const workingFlags = ["working-timeout", "launch-working-timeout", "launch-timeout"] as const;
  const workingValues: number[] = [];
  for (const name of workingFlags) {
    const err = flagError(intFlag(t, name));
    if (err !== undefined) return { command: "usage", error: err };
    const value = flagValue(intFlag(t, name));
    if (value !== undefined) workingValues.push(value);
  }
  if (workingValues.length > 1) {
    return { command: "usage", error: "notify accepts only one working-timeout flag" };
  }
  const workingTimeoutSec = workingValues[0];
  return {
    command: "notify",
    url: strFlag(t, "url") ?? "http://127.0.0.1:3001",
    interval: flagValue(intFlag(t, "interval")) ?? 5,
    eventPort: flagValue(intFlag(t, "event-port")) ?? 3002,
    stallTimeoutMin: flagValue(intFlag(t, "stall-timeout")) ?? 30,
    ...(workingTimeoutSec !== undefined ? { workingTimeoutSec } : {}),
  };
}

function parseMode(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["url"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const mode = t.positionals[0];
  if (mode !== "manual" && mode !== "auto") {
    return { command: "usage", error: `mode must be manual or auto, got: ${mode ?? "(missing)"}` };
  }
  return { command: "mode", mode, url: strFlag(t, "url") ?? "http://127.0.0.1:3001" };
}

function parseConfig(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["root"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const action = t.positionals[0];
  if (action !== "get" && action !== "set") {
    return { command: "usage", error: `config action must be get or set, got: ${action ?? "(missing)"}` };
  }
  const key = t.positionals[1];
  if (key === undefined || key.length === 0) {
    return { command: "usage", error: `config ${action} requires a key` };
  }
  if (action === "get") {
    const extra = extraPositionalError(t, 2);
    if (extra !== undefined) return { command: "usage", error: extra };
    return { command: "config", action, key, root: strFlag(t, "root") ?? ".context-hub" };
  }
  const value = t.positionals[2];
  if (value === undefined) {
    return { command: "usage", error: "config set requires a value (use \"\" to clear a list)" };
  }
  const extra = extraPositionalError(t, 3);
  if (extra !== undefined) return { command: "usage", error: extra };
  return { command: "config", action, key, value, root: strFlag(t, "root") ?? ".context-hub" };
}

function parseStartNext(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["url"]), bools: new Set(["force", "fresh"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const taskId = t.positionals[0]; // optional: no-arg default selection applies below
  return {
    command: "start-next",
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    url: strFlag(t, "url") ?? "http://127.0.0.1:3001",
    force: t.bools.has("force"),
    fresh: t.bools.has("fresh"),
  };
}

function parseWatch(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["url", "interval"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const intervalErr = flagError(intFlag(t, "interval"));
  if (intervalErr !== undefined) return { command: "usage", error: intervalErr };
  const taskId = t.positionals[0]; // optional: same no-arg default selection as start-next
  return {
    command: "watch",
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    url: strFlag(t, "url") ?? "http://127.0.0.1:3001",
    interval: flagValue(intFlag(t, "interval")) ?? 5,
  };
}

const CAST_ROLES = ["architect", "executor", "reviewer"] as const;

/** Split legacy comma shorthand only at a known role= boundary. */
function splitCastEntries(raw: string): string[] {
  const boundary = /,(?=\s*(?:architect|executor|reviewer)=)/u;
  return raw.split(boundary).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function parseCastPairs(raw: string): Cast | { error: string } {
  const out: Cast = {};
  for (const pair of splitCastEntries(raw)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return { error: `--cast entries must be role=agent pairs, got: '${pair}'` };
    const role = pair.slice(0, eq).trim();
    const command = pair.slice(eq + 1).trim();
    if (!(CAST_ROLES as readonly string[]).includes(role)) {
      return { error: `--cast role must be architect|executor|reviewer, got: '${role}'` };
    }
    if (command.length === 0) return { error: `--cast agent for '${role}' must be non-empty` };
    try {
      out[role as keyof Cast] = parseAgentRoute(command, `--cast agent for '${role}'`);
    } catch (e) {
      const message = e instanceof AgentCommandError ? e.message : "invalid command";
      return { error: `--cast agent for '${role}' is invalid: ${message}` };
    }
  }
  if (Object.keys(out).length === 0) return { error: `--cast entries must be role=agent pairs, got: '${raw}'` };
  return out;
}

function parseCreate(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, {
    values: new Set(["title", "description", "creator", "role", "flow", "cast", "url"]),
    repeatable: new Set(["cast"]),
  });
  if ("error" in t) return { command: "usage", error: t.error };
  const title = requireStr(t, "title");
  if ("error" in title) return { command: "usage", error: title.error };
  const description = requireStr(t, "description");
  if ("error" in description) return { command: "usage", error: description.error };
  const creator = requireStr(t, "creator");
  if ("error" in creator) return { command: "usage", error: creator.error };
  const role = requireStr(t, "role");
  if ("error" in role) return { command: "usage", error: role.error };
  // Flow enum: full (default) | direct | solo — mirrors context.create's schema.
  const flow = strFlag(t, "flow");
  if (flow !== undefined && flow !== "full" && flow !== "direct" && flow !== "solo") {
    return { command: "usage", error: `--flow must be full|direct|solo, got: ${flow}` };
  }
  const castValues = strFlags(t, "cast");
  let cast: Cast | undefined;
  for (const castRaw of castValues) {
    const parsed = parseCastPairs(castRaw);
    if ("error" in parsed) return { command: "usage", error: parsed.error };
    cast = { ...(cast ?? {}), ...parsed };
  }
  const url = strFlag(t, "url");
  return {
    command: "create",
    title: title.value,
    description: description.value,
    creator: creator.value,
    role: role.value,
    ...(flow !== undefined ? { flow } : {}),
    ...(cast !== undefined ? { cast } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function parsePublish(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, {
    values: new Set([
      "role", "content-type", "summary", "body", "payload-file", "verdict",
      "commits", "ref-version", "expected-version", "agent", "model", "url",
    ]),
  });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const taskId = t.positionals[0];
  if (taskId === undefined) return { command: "usage", error: "publish requires a task_id" };
  const role = requireStr(t, "role");
  if ("error" in role) return { command: "usage", error: role.error };
  const contentType = requireStr(t, "content-type");
  if ("error" in contentType) return { command: "usage", error: contentType.error };
  const summary = requireStr(t, "summary");
  if ("error" in summary) return { command: "usage", error: summary.error };
  const body = strFlag(t, "body");
  const payloadFile = strFlag(t, "payload-file");
  if (body === undefined && payloadFile === undefined) {
    return { command: "usage", error: "either --body or --payload-file is required" };
  }
  if (body !== undefined && payloadFile !== undefined) {
    return { command: "usage", error: "--body and --payload-file are mutually exclusive" };
  }
  for (const name of ["ref-version", "expected-version"] as const) {
    const err = flagError(intFlag(t, name));
    if (err !== undefined) return { command: "usage", error: err };
  }
  const refVersion = flagValue(intFlag(t, "ref-version"));
  const expectedVersion = flagValue(intFlag(t, "expected-version"));
  const verdict = strFlag(t, "verdict");
  const commitsRaw = strFlag(t, "commits");
  const commits = commitsRaw?.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
  const agent = strFlag(t, "agent");
  const model = strFlag(t, "model");
  const url = strFlag(t, "url");
  return {
    command: "publish",
    task_id: taskId,
    role: role.value,
    content_type: contentType.value,
    summary: summary.value,
    ...(body !== undefined ? { body } : {}),
    ...(payloadFile !== undefined ? { payloadFile } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(commits !== undefined ? { commits } : {}),
    ...(refVersion !== undefined ? { refVersion } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function parseRead(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["since-version", "url"]), bools: JSON_BOOLS });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const taskId = t.positionals[0];
  if (taskId === undefined) return { command: "usage", error: "read requires a task_id" };
  const since = intFlag(t, "since-version");
  const sinceErr = flagError(since);
  if (sinceErr !== undefined) return { command: "usage", error: sinceErr };
  const sinceValue = flagValue(since);
  const url = strFlag(t, "url");
  return {
    command: "read",
    task_id: taskId,
    ...(sinceValue !== undefined ? { sinceVersion: sinceValue } : {}),
    json: t.bools.has("json"),
    ...(url !== undefined ? { url } : {}),
  };
}

function parseList(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["status", "url"]), bools: JSON_BOOLS });
  if ("error" in t) return { command: "usage", error: t.error };
  const status = strFlag(t, "status");
  const listUrl = strFlag(t, "url");
  return {
    command: "list",
    ...(status !== undefined ? { status } : {}),
    json: t.bools.has("json"),
    ...(listUrl !== undefined ? { url: listUrl } : {}),
  };
}

function parseStatus(args: readonly string[]): ParsedArgs {
  // --json is boolean-only, anything else is unknown.
  const t = tokenize(args, { values: new Set(["url"]), bools: JSON_BOOLS });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 0);
  if (extra !== undefined) return { command: "usage", error: extra };
  const url = strFlag(t, "url");
  return { command: "status", json: t.bools.has("json"), ...(url !== undefined ? { url } : {}) };
}

function parseDecide(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["decision", "by", "reason", "url"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const taskId = t.positionals[0];
  if (taskId === undefined) return { command: "usage", error: "decide requires a task_id" };
  const decision = strFlag(t, "decision");
  if (decision !== "approve" && decision !== "reject" && decision !== "close") {
    return { command: "usage", error: `--decision must be approve|reject|close, got: ${decision ?? "(missing)"}` };
  }
  const by = requireStr(t, "by");
  if ("error" in by) return { command: "usage", error: by.error };
  const reason = strFlag(t, "reason");
  const url = strFlag(t, "url");
  return {
    command: "decide",
    task_id: taskId,
    decision,
    by: by.value,
    ...(reason !== undefined ? { reason } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function parseAck(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["note", "url"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const taskId = t.positionals[0];
  if (taskId === undefined) return { command: "usage", error: "ack requires a task_id" };
  // An explicitly empty --note ("--note ''" or "--note=") is a missing value:
  // the ack record's body must be a real note or the stable default — never "".
  if (t.flags.has("note") && (t.flags.get("note") ?? "").length === 0) {
    return { command: "usage", error: "--note requires a non-empty value" };
  }
  const note = strFlag(t, "note");
  const url = strFlag(t, "url");
  return { command: "ack", task_id: taskId, ...(note !== undefined ? { note } : {}), ...(url !== undefined ? { url } : {}) };
}

function parseAssign(args: readonly string[]): ParsedArgs {
  // Everything after the role belongs to the command value. This is
  // intentionally not passed through the TUT flag tokenizer: an unquoted
  // `--model` must be an agent argument, while the documented quoted form
  // remains equivalent.
  const role = args[0];
  if (!(CAST_ROLES as readonly string[]).includes(role ?? "")) {
    return { command: "usage", error: `role must be architect|executor|reviewer, got: ${role ?? "(missing)"}` };
  }
  const command = args.slice(1);
  if (command.length === 0) {
    return { command: "usage", error: "assign requires an agent name" };
  }
  try {
    return { command: "assign", role: role as "architect" | "executor" | "reviewer", agent: parseAgentInvocation(command, "assign command") };
  } catch (e) {
    const message = e instanceof AgentCommandError ? e.message : "invalid command";
    return { command: "usage", error: `assign command is invalid: ${message}` };
  }
}

function parseUp(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["url"]), bools: new Set(["dry-run"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 0);
  if (extra !== undefined) return { command: "usage", error: extra };
  const url = strFlag(t, "url");
  return { command: "up", dryRun: t.bools.has("dry-run"), ...(url !== undefined ? { url } : {}) };
}

/** The roles that ship a skill file (skills/<role>.md in the package). */
export const SKILL_ROLES = ["host", "architect", "executor", "reviewer"] as const;
export type SkillRole = (typeof SKILL_ROLES)[number];

function parseSkill(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(), bools: new Set() });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const role = t.positionals[0];
  if (role === undefined) return { command: "usage", error: `skill requires a role: ${SKILL_ROLES.join(" | ")}` };
  if (!(SKILL_ROLES as readonly string[]).includes(role)) {
    return { command: "usage", error: `skill role must be ${SKILL_ROLES.join(" | ")}, got: ${role}` };
  }
  return { command: "skill", role: role as SkillRole };
}

function parseInit(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(), bools: new Set() });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 0);
  if (extra !== undefined) return { command: "usage", error: extra };
  return { command: "init" };
}

/**
 * Internal launcher arguments deliberately bypass the public flag tokenizer:
 * after task_id and role, every remaining token belongs to the agent route
 * and must reach the launcher unchanged.  The launcher entry performs the
 * one allowed legacy-route parse.
 */
function parseLaunch(args: readonly string[]): ParsedArgs {
  return { command: "launch", args: [...args] };
}

/** Pure: argv (without node/script) → parsed command, or a usage result. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  const first = args.shift();
  if (first === undefined) return { command: "usage" };
  const rest = args;
  switch (first) {
    case "serve": return parseServe(rest);
    case "notify": return parseNotify(rest);
    case "mode": return parseMode(rest);
    case "config": return parseConfig(rest);
    case "start-next": return parseStartNext(rest);
    case "launch": return parseLaunch(rest);
    case "watch": return parseWatch(rest);
    case "create": return parseCreate(rest);
    case "publish": return parsePublish(rest);
    case "read": return parseRead(rest);
    case "list": return parseList(rest);
    case "status": return parseStatus(rest);
    case "decide": return parseDecide(rest);
    case "ack": return parseAck(rest);
    case "assign": return parseAssign(rest);
    case "up": return parseUp(rest);
    case "skill": return parseSkill(rest);
    case "init": return parseInit(rest);
    default: return { command: "usage", error: `unknown command: ${first}` };
  }
}

// --- handlers -----------------------------------------------------------------
// All seventeen subcommands are wired (notify; mode/config/start-next/watch;
// ack reuses the context publish path as a fixed human ack note; status is a
// human overview over the context list path). Task creation is the
// initiating side's action (tut create); the first round is an ordinary
// round hand-off, so no kickoff-specific handler exists.
// Each handler receives the parsed command object and returns a process exit code.

type Handler<T> = (parsed: T) => Promise<number>;

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

// --- context/approval command handlers -------------------------------------------

/** Hub BASE url for the context subcommands (--url override; default when the flag is absent). */
const DEFAULT_HUB_URL = "http://127.0.0.1:3001";

/**
 * Uniform failure exit: HubError prints "CODE: message" so the first stderr
 * line is the machine-parseable code (the same discipline as the MCP tool
 * surface); anything else (unreachable Hub, unreadable --payload-file, ...)
 * prints a plain one-liner. Always exit code 1.
 */
function failWith(e: unknown): number {
  if (e instanceof HubError) {
    process.stderr.write(`${e.code}: ${e.message}\n`);
  } else {
    process.stderr.write(`tut: ${(e as Error).message}\n`);
  }
  return 1;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runMode(parsed: Extract<ParsedArgs, { command: "mode" }>): Promise<number> {
  let res: Response;
  try {
    res = await fetch(new URL("/mode", parsed.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_mode: parsed.mode }),
    });
  } catch (e) {
    process.stderr.write(`tut: cannot reach Hub at ${parsed.url} (is tut serve running?): ${(e as Error).message}\n`);
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
      case "flow_mode": {
        const value = outcome.status === "ok" ? outcome.config.flow_mode : "manual";
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
    parsedValue.assignment.key === "flow_mode"
      ? config.flow_mode
      : (config.auto?.launch_roles ?? []).join(",");
  process.stdout.write(`config: ${parsedValue.assignment.key} = ${rendered} (${configPath(root)})\n`);
  return 0;
}

/** Shape of GET /state consumed by start-next/watch (six-field entries plus the additive version, see http.ts). */
interface StateSnapshot {
  tasks?: Array<{
    task_id: string;
    status?: string;
    waiting_for?: string;
    needs_attention?: boolean;
    version?: number;
    cast?: Cast;
  }>;
}

/** GET <hub>/state and status-check; throws on fetch/HTTP failure (callers own the message). */
async function fetchStateSnapshot(url: string): Promise<StateSnapshot> {
  const res = await fetch(new URL("/state", url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as StateSnapshot;
}

/**
 * No-arg default: from one /state snapshot, the tasks waiting for an agent
 * (waiting_for "agent:<role>"). An anomalous needs_attention combination is
 * still listed for truthful selection diagnostics, then withheld by the
 * canonical launch gate.
 */
function agentWaitingTasks(state: StateSnapshot): Array<NonNullable<StateSnapshot["tasks"]>[number]> {
  return (state.tasks ?? []).filter((t) => (t.waiting_for ?? "").startsWith("agent:"));
}

/**
 * Task selection shared by start-next and watch (watch's alignment
 * requirement): explicit task_id wins (must exist in /state); no-arg default
 * resolves the single task waiting for an agent (zero/multiple are
 * list-and-fail branch exits — never guess). Prints its own diagnostics;
 * `handled` is the process exit code.
 */
function selectTargetTask(
  state: StateSnapshot,
  explicitTaskId: string | undefined,
): { entry: NonNullable<StateSnapshot["tasks"]>[number] } | { handled: number } {
  const tasks = state.tasks ?? [];
  let taskId = explicitTaskId;
  if (taskId === undefined) {
    const candidates = agentWaitingTasks(state);
    if (candidates.length === 0) {
      process.stderr.write("tut: no task is waiting for an agent\n");
      const humanWaiting = tasks.filter((t) => t.waiting_for === "human");
      if (humanWaiting.length > 0) {
        const rows = humanWaiting.map((t) => [t.task_id, t.waiting_for ?? "human"]);
        const widths = [colWidth("task_id", rows, 0), colWidth("waiting_for", rows, 1)];
        process.stderr.write("tasks waiting for a human:\n");
        for (const row of rows) process.stderr.write(`  ${padRow(row, widths)}\n`);
      }
      return { handled: 1 };
    }
    if (candidates.length > 1) {
      // List, never guess. The `!!` column mirrors
      // tut status's attention notation.
      const rows = candidates.map((t) => [
        t.task_id,
        t.waiting_for ?? "",
        t.needs_attention === true ? ATTENTION_MARKER : "",
      ]);
      const widths = [colWidth("task_id", rows, 0), colWidth("waiting_for", rows, 1), colWidth("att", rows, 2)];
      process.stderr.write(`tut: ${candidates.length} tasks are waiting for an agent — pass a task_id explicitly:\n`);
      process.stderr.write(`${padRow(["task_id", "waiting_for", "att"], widths)}\n`);
      for (const row of rows) process.stderr.write(`${padRow(row, widths)}\n`);
      return { handled: 1 };
    }
    const selected = candidates[0];
    if (selected === undefined) return { handled: 1 }; // unreachable: length checked above
    taskId = selected.task_id;
  }
  const entry = tasks.find((t) => t.task_id === taskId);
  if (entry === undefined) {
    process.stderr.write(`tut: TASK_NOT_FOUND: no task ${taskId} in /state\n`);
    return { handled: 1 };
  }
  return { entry };
}

/** Internal launch command.  It is intentionally not part of the public
 * workflow parser: route tokens after task_id/role belong to the launcher. */
async function runLaunch(parsed: Extract<ParsedArgs, { command: "launch" }>): Promise<number> {
  const entry = parseLaunchEntry(parsed.args);
  if ("error" in entry) {
    process.stderr.write(`tut: launch: ${entry.error}\n`);
    return 1;
  }
  try {
    return await runLaunchEntry(entry);
  } catch (e) {
    process.stderr.write(`tut: launch: ${(e as Error).message}\n`);
    return 1;
  }
}

async function runStartNext(parsed: Extract<ParsedArgs, { command: "start-next" }>): Promise<number> {
  let state: StateSnapshot;
  try {
    state = await fetchStateSnapshot(parsed.url);
  } catch (e) {
    process.stderr.write(`tut: cannot read state from ${parsed.url}: ${(e as Error).message}\n`);
    return 1;
  }
  // No-arg default: resolve the task_id first (zero/multiple are branch
  // exits), then fall through — the explicit path below is the ONLY path
  // (guard via launch note, --force, spawn all unchanged for both ways in).
  const target = selectTargetTask(state, parsed.task_id);
  if ("handled" in target) return target.handled;
  const entry = target.entry;
  const taskId = entry.task_id;
  const waitingFor = entry.waiting_for ?? "none";
  const role = waitingFor.startsWith("agent:") ? waitingFor.slice("agent:".length) : "";
  if (role.length === 0) {
    process.stderr.write(
      `tut: task ${taskId} is waiting for "${waitingFor}" (status: ${entry.status ?? "?"}), not an agent — nothing to start\n`,
    );
    return 1;
  }

  const request: LaunchRequest = {
    kind: "round",
    task_id: taskId,
    role,
    fresh: parsed.fresh,
    via: "start-next",
  };
  try {
    assertLaunchStateGate(request, entry);
  } catch (e) {
    process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }

  let records;
  try {
    records = await readLaunchLog(parsed.url, taskId);
  } catch (e) {
    return failWith(e);
  }
  let baseVersion: number;
  try {
    baseVersion = bindLaunchBaseVersion(entry.version, latestRecordVersion(records));
  } catch (e) {
    process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }
  const blocked = launchBlocked(records, role);
  if (blocked.blocked && !parsed.force) {
    process.stderr.write(
      `tut: ALREADY_LAUNCHED: ${role} launched at v${blocked.noteVersion ?? "?"}, no new publish since; use --force to relaunch\n`,
    );
    return 1;
  }

  // Pre-checks, BEFORE the marker (failure leaves no trace — a plain retry
  // works, no --force): resolve one normalized route, build one immutable
  // invocation, then require its executable on PATH.  The child receives the
  // invocation as one JSON argv item; it is never asked to resolve the route
  // a second time.
  const launchEnvironment = { ...process.env };
  let invocation: ReturnType<typeof buildLaunchInvocation>;
  try {
    // Freeze the Herdr anchor and routing root before the marker.  The
    // internal child receives this snapshot and must not rediscover a
    // focused/different workspace during lifecycle execution.
    const executionContext = await resolveExecutionContext({
      caller_cwd: process.cwd(),
      env: launchEnvironment,
      dry_run: launchEnvironment.TUT_DRY_RUN === "1",
    });
    const projectRoot = executionContext.routingRoot.startsWith("<")
      ? executionContext.caller_cwd ?? process.cwd()
      : executionContext.routingRoot;
    const workspaceSnapshot = await readWorkspaceConfigSnapshot({
      projectRoot,
      userConfigDir: defaultUserConfigDir(launchEnvironment),
    });
    const resolved = await resolveAgentRouteWithSource(
      role,
      entry.cast,
      { workspaceSnapshot },
    );
    const route = typeof resolved.route === "string"
      ? { agent: resolved.route, args: [] }
      : { agent: resolved.route.agent, args: [...resolved.route.args] };
    // Target resolution happens after route selection and before the marker:
    // POSIX proves PATH presence (which + executable regular file), Windows
    // resolves its structured target and refuses shims.  Any failure leaves
    // no trace — a plain retry works, no --force needed.
    let plan: Awaited<ReturnType<typeof resolvePlatformExecutionPlan>>;
    try {
      plan = await resolvePlatformExecutionPlan(route, { environment: launchEnvironment });
    } catch (e) {
      if (e instanceof UnsupportedWindowsShimError || e instanceof AgentTargetError) {
        throw new Error(
          e instanceof UnsupportedWindowsShimError
            ? (e as Error).message
            : `agent '${route.agent}' (routed for ${role} on ${taskId}) is not on PATH — ${(e as Error).message}`,
        );
      }
      throw e;
    }
    const template = resolveTabLabelTemplateFromSnapshot(workspaceSnapshot);
    const tabLabel = template
      .replaceAll("{role}", role)
      .replaceAll("{task}", taskId)
      .replaceAll("{agent}", route.agent);
    if (tabLabel.length === 0 || /[\u0000\r\n]/u.test(tabLabel)) {
      throw new Error("naming.tab_label renders to an invalid label");
    }
    const skillPath = fileURLToPath(new URL(`../skills/${role}.md`, import.meta.url));
    invocation = buildLaunchInvocation({
      request,
      base_version: baseVersion,
      hub_url: parsed.url,
      route,
      route_source: resolved.source,
      context: executionContext,
      naming: { tab_label: tabLabel, pane_label: `${taskId}.${role}` },
      prompt: `轮到你了（role: ${role}）：请用 Context Hub 读取任务 ${taskId} 的完整上下文（context.read），按你的 role skill（${skillPath}）开始本轮工作，完成后发布相应记录（context.publish）。`,
      ...(plan.platform === "posix"
        ? { posix_direct: plan.posix_direct }
        : { resolved_target: plan.resolved_target, effective_agent: plan.effective_agent }),
    });
  } catch (e) {
    process.stderr.write(`tut: cannot resolve launch target for ${role} on ${taskId}: ${(e as Error).message}\n`);
    return 1;
  }

  if (launchEnvironment.TUT_DRY_RUN !== "1") {
    try {
      requireBirthAnchor(invocation.context);
    } catch (e) {
      process.stderr.write(`tut: cannot launch ${role} for ${taskId}: ${(e as Error).message}\n`);
      return 1;
    }
  }

  // Fail closed: the marker must win the optimistic-concurrency race before
  // the launcher is called. A VERSION_CONFLICT therefore cannot cause a
  // second pane prompt.
  try {
    await markLaunched(parsed.url, taskId, role, baseVersion, "start-next", invocation.marker_projection);
  } catch (e) {
    return failWith(e);
  }

  // --fresh is already frozen in the invocation.  The child receives no raw
  // route values, so there is no second parse or route-source drift.
  const run = await runInternalLaunchInvocation(invocation);
  if (run.error !== undefined) {
    process.stderr.write(`tut: cannot run internal launcher ${cliEntryPath()}: ${run.error.message}\n`);
    process.stderr.write("tut: relaunch with --force once the pane is fixed\n");
    return 1;
  }
  if (run.stdout.length > 0) process.stdout.write(run.stdout.endsWith("\n") ? run.stdout : `${run.stdout}\n`);
  if (run.stderr.length > 0) process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);
  if (run.code !== 0) {
    process.stderr.write(`tut: launcher exited with code ${run.code}\n`);
    process.stderr.write("tut: relaunch with --force once the pane is fixed\n");
    return 1;
  }
  process.stdout.write(`start-next: launched ${role} for ${taskId} via launch.sh\n`);
  return 0;
}

// --- tut watch -------------------------------------------------------------------

/** Watch exit codes: three distinguishable situations + the shared operational-error code. */
const WATCH_EXIT_ROUND = 0;
const WATCH_EXIT_ERROR = 1;
const WATCH_EXIT_TERMINAL = 2;
const WATCH_EXIT_ATTENTION = 3;

type WatchOutcome = "round" | "terminal" | "attention";

/** terminal outranks attention: a closed task carrying leftover warnings is still over. */
function classifyWatch(entry: NonNullable<StateSnapshot["tasks"]>[number]): WatchOutcome {
  if (entry.status === "approved" || entry.status === "closed") return "terminal";
  if (entry.needs_attention === true) return "attention";
  return "round";
}

/** Any derived-field move counts as a change; version bumps on every append, so it is the primary signal. */
function watchChanged(
  before: NonNullable<StateSnapshot["tasks"]>[number],
  after: NonNullable<StateSnapshot["tasks"]>[number],
): boolean {
  return (
    before.version !== after.version ||
    before.status !== after.status ||
    before.waiting_for !== after.waiting_for ||
    before.needs_attention !== after.needs_attention
  );
}

/**
 * tut watch [<task_id>] — the official round-watcher: polls /state until the
 * task's derived state moves, then exits 0 (round boundary — someone's turn,
 * the pending_approval human gate included), 2 (terminal approved/closed) or
 * 3 (needs attention). Replaces the hand-written `while sleep` loops (whose
 * pattern mistakes once misreported state): a transient fetch failure is
 * retried (one throttled stderr line per outage), never mistaken for a state
 * change, and the baseline snapshot is classified immediately — a task
 * already terminal or flagged needs no waiting and exits at once.
 */
async function runWatch(parsed: Extract<ParsedArgs, { command: "watch" }>): Promise<number> {
  const intervalMs = parsed.interval * 1000;
  let state: StateSnapshot;
  try {
    state = await fetchStateSnapshot(parsed.url);
  } catch (e) {
    process.stderr.write(`tut: cannot read state from ${parsed.url}: ${(e as Error).message}\n`);
    return WATCH_EXIT_ERROR;
  }
  const target = selectTargetTask(state, parsed.task_id);
  if ("handled" in target) return target.handled;
  type Task = NonNullable<StateSnapshot["tasks"]>[number];
  let entry: Task = target.entry;

  const report = (outcome: WatchOutcome): number => {
    const at = `v${entry.version ?? "?"}`;
    const status = entry.status ?? "?";
    if (outcome === "terminal") {
      process.stdout.write(`watch: ${entry.task_id} reached terminal state: ${status} (${at})\n`);
      return WATCH_EXIT_TERMINAL;
    }
    if (outcome === "attention") {
      process.stdout.write(`watch: ${entry.task_id} needs attention (status=${status}, ${at}) — inspect with: tut read ${entry.task_id}\n`);
      return WATCH_EXIT_ATTENTION;
    }
    process.stdout.write(
      `watch: ${entry.task_id} advanced to ${at} (status=${status}, waiting_for=${entry.waiting_for ?? "?"}) — round boundary\n`,
    );
    return WATCH_EXIT_ROUND;
  };

  // Baseline classification: an already-terminal or already-flagged task has
  // nothing to wait for — exit at once with the corresponding code.
  const baseline = classifyWatch(entry);
  if (baseline !== "round") return report(baseline);
  process.stderr.write(
    `watch: ${entry.task_id} v${entry.version ?? "?"} (status=${entry.status ?? "?"}, waiting_for=${entry.waiting_for ?? "?"}) — polling every ${parsed.interval}s\n`,
  );

  let fetchOk = true;
  for (;;) {
    await sleepMs(intervalMs);
    let next: StateSnapshot;
    try {
      next = await fetchStateSnapshot(parsed.url);
      fetchOk = true;
    } catch (e) {
      // A dead hub reads as "keep waiting", never as a state change (the
      // classic hand-loop bug): one throttled warning per outage, then retry.
      if (fetchOk) {
        process.stderr.write(`watch: hub unreachable, retrying: ${(e as Error).message}\n`);
        fetchOk = false;
      }
      continue;
    }
    const fresh = (next.tasks ?? []).find((t) => t.task_id === entry.task_id);
    if (fresh === undefined) {
      // Records are append-only; a task cannot leave /state. Fatal, not retryable.
      process.stderr.write(`watch: task ${entry.task_id} disappeared from /state — aborting\n`);
      return WATCH_EXIT_ERROR;
    }
    if (!watchChanged(entry, fresh)) {
      entry = fresh; // re-baseline; updated_at churn alone is not a change signal
      continue;
    }
    entry = fresh;
    return report(classifyWatch(entry));
  }
}

async function runCreate(parsed: Extract<ParsedArgs, { command: "create" }>): Promise<number> {
  try {
    printJson(
      await hubCreate(parsed.url ?? DEFAULT_HUB_URL, {
        title: parsed.title,
        description: parsed.description,
        creator: parsed.creator,
        role: parsed.role,
        ...(parsed.flow !== undefined ? { flow: parsed.flow } : {}),
        ...(parsed.cast !== undefined ? { cast: parsed.cast } : {}),
      }),
    );
    return 0;
  } catch (e) {
    return failWith(e);
  }
}

async function runPublish(parsed: Extract<ParsedArgs, { command: "publish" }>): Promise<number> {
  let body = parsed.body;
  if (body === undefined && parsed.payloadFile !== undefined) {
    // --payload-file: the WHOLE file is the body; --summary still names it.
    try {
      body = await readFile(parsed.payloadFile, "utf8");
    } catch (e) {
      process.stderr.write(`tut: cannot read --payload-file ${parsed.payloadFile}: ${(e as Error).message}\n`);
      return 1;
    }
  }
  try {
    const result = await hubPublish(parsed.url ?? DEFAULT_HUB_URL, {
      task_id: parsed.task_id,
      role: parsed.role,
      content_type: parsed.content_type,
      payload: {
        summary: parsed.summary,
        body: body ?? "",
        ...(parsed.verdict !== undefined ? { verdict: parsed.verdict } : {}),
        ...(parsed.commits !== undefined ? { commits: parsed.commits } : {}),
        ...(parsed.refVersion !== undefined ? { ref_version: parsed.refVersion } : {}),
      },
      ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.expectedVersion !== undefined ? { expected_version: parsed.expectedVersion } : {}),
    });
    printJson(result);
    return 0;
  } catch (e) {
    return failWith(e);
  }
}

/** Column width of cell i across all rows (noUncheckedIndexedAccess-safe). */
function colWidth(header: string, rows: string[][], i: number): number {
  return Math.max(header.length, ...rows.map((r) => (r[i] ?? "").length));
}

/** Row of cells padded to the given widths, two-space gutters. */
function padRow(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
}

/** Human rendering of context.read: header block + one row per record. */
function renderRead(result: HubReadResult): string {
  const rows = result.versions.map((r) => [
    String(r.version),
    r.content_type,
    r.role,
    String(r.payload?.summary ?? "").split("\n")[0] ?? "",
  ]);
  const widths = [
    colWidth("version", rows, 0),
    colWidth("type", rows, 1),
    colWidth("role", rows, 2),
  ];
  const lines = [
    `task:    ${result.task_id}`,
    `title:   ${result.title}`,
    // The requirement text from creation: one line, even when the
    // description itself is multi-line (--json shows it verbatim).
    ...(result.description !== undefined
      ? [`desc:    ${result.description.split("\n")[0] ?? ""}`]
      : []),
    ...(result.flow !== undefined
      ? [`flow:    ${result.flow}${result.cast !== undefined ? ` (cast: ${formatCast(result.cast)})` : ""}`]
      : []),
    ...(result.status !== undefined ? [`status:  ${result.status}`] : []),
    `records: ${result.versions.length}`,
    "",
    padRow(["version", "type", "role", "summary"], [...widths, 0]),
    ...rows.map((r) => padRow(r, widths)),
  ];
  return `${lines.join("\n")}\n`;
}

async function runRead(parsed: Extract<ParsedArgs, { command: "read" }>): Promise<number> {
  try {
    const result = await hubRead(parsed.url ?? DEFAULT_HUB_URL, parsed.task_id, parsed.sinceVersion);
    if (parsed.json) printJson(result);
    else process.stdout.write(renderRead(result));
    return 0;
  } catch (e) {
    return failWith(e);
  }
}

/** Human rendering of context.list: one row per task ("att" marks needs_attention). */
function renderList(result: HubListResult): string {
  if (result.tasks.length === 0) return "no tasks\n";
  const rows = result.tasks.map((t) => [
    t.task_id,
    t.scope === "project" ? "project" : (t.status ?? "-"),
    t.scope === "project" ? "-" : (t.waiting_for ?? "-"),
    t.scope === "project" ? "-" : (t.needs_attention === true ? "yes" : ""),
    t.title,
  ]);
  const widths = [
    colWidth("task_id", rows, 0),
    colWidth("status", rows, 1),
    colWidth("waiting_for", rows, 2),
    colWidth("att", rows, 3),
  ];
  const lines = [padRow(["task_id", "status", "waiting_for", "att", "title"], [...widths, 0]), ...rows.map((r) => padRow(r, widths))];
  return `${lines.join("\n")}\n`;
}

async function runList(parsed: Extract<ParsedArgs, { command: "list" }>): Promise<number> {
  try {
    const result = await hubList(parsed.url ?? DEFAULT_HUB_URL, parsed.status);
    if (parsed.json) printJson(result);
    else process.stdout.write(renderList(result));
    return 0;
  } catch (e) {
    return failWith(e);
  }
}

/**
 * tut status ordering: needs_attention tasks first, then updated_at newest
 * first, task_id ascending as the stable final key. Plain string compares —
 * updated_at is an ISO-8601 UTC string (lexicographic == chronological) and
 * locale-aware compares would vary by environment.
 */
function statusEntryOrder(a: HubListEntry, b: HubListEntry): number {
  const attDiff = Number(b.needs_attention === true) - Number(a.needs_attention === true);
  if (attDiff !== 0) return attDiff;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  if (a.task_id !== b.task_id) return a.task_id < b.task_id ? -1 : 1;
  return 0;
}

/**
 * The one status snapshot both views share: task-scope entries only (project
 * is long-lived memory, not a lifecycle task) in status order. Entries pass
 * through verbatim — the CLI adds nothing and re-derives nothing.
 */
function statusSnapshot(result: HubListResult): HubListEntry[] {
  return result.tasks.filter((t) => t.scope !== "project").sort(statusEntryOrder);
}

/** Anomaly marker for the status table — plain ASCII, no color dependence. */
const ATTENTION_MARKER = "!!";

/** Human rendering of tut status: summary line + fixed-column task table. */
function renderStatus(result: HubListResult): string {
  const tasks = statusSnapshot(result);
  if (tasks.length === 0) return "no tasks\n";
  const attention = tasks.filter((t) => t.needs_attention === true).length;
  const closed = tasks.filter((t) => t.status === "closed").length;
  const rows = tasks.map((t) => [
    t.needs_attention === true ? ATTENTION_MARKER : "",
    t.task_id,
    t.status ?? "-",
    t.waiting_for ?? "-",
    t.updated_at,
    t.title,
  ]);
  const widths = [
    colWidth("att", rows, 0),
    colWidth("task_id", rows, 1),
    colWidth("status", rows, 2),
    colWidth("waiting_for", rows, 3),
    colWidth("updated_at", rows, 4),
  ];
  const lines = [
    `${tasks.length} tasks, ${attention} needs attention, ${closed} closed`,
    "",
    padRow(["att", "task_id", "status", "waiting_for", "updated_at", "title"], [...widths, 0]),
    ...rows.map((r) => padRow(r, widths)),
  ];
  return `${lines.join("\n")}\n`;
}

async function runStatus(parsed: Extract<ParsedArgs, { command: "status" }>): Promise<number> {
  try {
    const result = await hubList(parsed.url ?? DEFAULT_HUB_URL);
    if (parsed.json) printJson({ tasks: statusSnapshot(result) });
    else process.stdout.write(renderStatus(result));
    return 0;
  } catch (e) {
    return failWith(e);
  }
}

async function runDecide(parsed: Extract<ParsedArgs, { command: "decide" }>): Promise<number> {
  let result: unknown;
  try {
    result = await hubDecide(parsed.url ?? DEFAULT_HUB_URL, {
      task_id: parsed.task_id,
      decision: parsed.decision,
      by: parsed.by,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    });
  } catch (e) {
    return failWith(e);
  }
  printJson(result);
  // decide(close) hooks the fresh-session lifecycle: reap the task's round
  // panes (`<task_id>.*`) via the launcher —
  // the single place that knows herdr (system-design 4.4 / 7.2). Best-effort
  // by design: cleanup warnings surface on stderr but never fail the decide
  // itself — approval must not be blocked by the terminal container.
  if (parsed.decision === "close") {
    const run = await runInternalLaunch(["--cleanup", parsed.task_id]);
    if (run.error !== undefined) {
      process.stderr.write(`tut: cannot run internal launcher ${cliEntryPath()}: ${run.error.message} (pane cleanup skipped)\n`);
    } else if (run.code !== 0) {
      process.stderr.write(`tut: pane cleanup exited with code ${run.code} (task is closed regardless)\n`);
    }
    if (run.stdout.length > 0) process.stdout.write(run.stdout.endsWith("\n") ? run.stdout : `${run.stdout}\n`);
    if (run.stderr.length > 0) process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);
  }
  return 0;
}

/** Stable default body when tut ack carries no --note (always non-empty). */
const ACK_DEFAULT_NOTE =
  "Anomalies reviewed and handled; derived needs_attention clears on the next state pass.";

/** Summary of an ack note: the --note's first line kept short, or stable text. */
function ackSummary(note: string | undefined): string {
  const firstLine = note?.split("\n")[0] ?? "";
  if (firstLine.length === 0) return "ack: anomalies handled";
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 72)}…`;
}

/**
 * tut ack <task_id> [--note <text>] — human acknowledgement that a task's
 * anomalies have been handled. One hubPublish with fixed role/content_type
 * and payload { summary, body, ack: true }: the note is append-only like any
 * record, the derived reset happens in the state machine — the
 * CLI never reads /state first and never duplicates derivation logic, so
 * acking a clean task is a harmless idempotent note.
 */
async function runAck(parsed: Extract<ParsedArgs, { command: "ack" }>): Promise<number> {
  try {
    printJson(
      await hubPublish(parsed.url ?? DEFAULT_HUB_URL, {
        task_id: parsed.task_id,
        role: "human",
        content_type: "note",
        payload: { summary: ackSummary(parsed.note), body: parsed.note ?? ACK_DEFAULT_NOTE, ack: true },
      }),
    );
    return 0;
  } catch (e) {
    return failWith(e);
  }
}

/**
 * tut assign <role> <agent> — change which agent occupies a role seat,
 * writing the PROJECT-level .context-hub/workspace.json (cwd — the same
 * root the three-level chain reads as L1). Missing file → initialized from
 * the currently effective lineup (all three roles resolved through the
 * chain, cast-less) before the target role is rewritten; a corrupt file is
 * never clobbered (exit 1, nothing written). Read-modify-write of the
 * parsed object so $comment and unknown keys survive untouched. Write is
 * atomic (temp sibling + rename, store.ts's pattern).
 */
async function runAssign(parsed: Extract<ParsedArgs, { command: "assign" }>): Promise<number> {
  const root = process.cwd();
  const dir = path.join(root, ".context-hub");
  const file = path.join(dir, "workspace.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      process.stderr.write(`tut: assign: cannot read ${file}: ${err.message}; nothing written\n`);
      return 1;
    }
    // Missing file → seed all three roles from the currently effective
    // lineup (user level and built-ins — L1 is this very file), so the new
    // file captures the full roster, not just the edited seat.
    const seeded: Record<string, unknown> = {};
    for (const role of KNOWN_ROLES) {
      const route = await resolveAgentRoute(role);
      if (typeof route === "string") seeded[role] = { agent: route };
      else seeded[role] = { agent: route.agent, args: [...route.args] };
    }
    raw = { roles: seeded };
  }
  const roles = (raw as { roles?: unknown })?.roles;
  if (typeof raw !== "object" || raw === null || typeof roles !== "object" || roles === null) {
    process.stderr.write(`tut: assign: ${file} is malformed (expected an object with a "roles" object); nothing written\n`);
    return 1;
  }
  const entry = (roles as Record<string, unknown>)[parsed.role];
  if (entry !== undefined && entry !== null && typeof entry !== "object") {
    process.stderr.write(`tut: assign: ${file}: roles.${parsed.role} is not an object; nothing written\n`);
    return 1;
  }
  const routeFields = typeof parsed.agent === "string"
    ? { agent: parsed.agent }
    : { agent: parsed.agent.agent, args: [...parsed.agent.args] };
  const next =
    entry === undefined || entry === null
      ? routeFields
      : (() => {
          const existing = entry as Record<string, unknown>;
          const { args: _staleArgs, ...withoutArgs } = existing;
          return { ...withoutArgs, ...routeFields };
        })();
  (roles as Record<string, unknown>)[parsed.role] = next;

  const temp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => undefined);
    process.stderr.write(`tut: assign: cannot write ${file}: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`assign: ${parsed.role} → ${formatAgentRoute(parsed.agent)} (${file})\n`);
  return 0;
}

// --- tut skill / tut init -----------------------------------------------------

/**
 * The skills directory shipped in the package, resolved module-relative
 * (../skills — one directory up from src/cli.ts and dist/cli.js alike;
 * identical for npm install, git clone, and npm link layouts).
 */
const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/** The marked block `tut init` maintains in a project's AGENTS.md. */
function agentsBlock(): string {
  return [
    "<!-- TUT:BEGIN -->",
    "<!-- Managed block: `tut init` refreshes between the markers; keep edits outside -->",
    "",
    "## TUT (Take Ur Turn)",
    "",
    "本仓库使用 TUT（Take Ur Turn）多 Agent 协作：本地 Context Hub——append-only 记录、",
    "派生任务状态、人工审批门。收到「担任 TUT Host／全程驱动」类指令的 Agent：运行",
    "`tut skill host` 读取并遵守 Host 角色规则（工具面 MCP-first，`tut` CLI 为等价通道）。",
    "工人角色（architect / executor / reviewer）的 skill 由启动器在投递时自动供给，",
    "无需人工配置。",
    "",
    "<!-- TUT:END -->",
  ].join("\n");
}

/** `/<!-- TUT:BEGIN -->[\s\S]*?<!-- TUT:END -->/` as a source literal. */
const TUT_BLOCK_RE = /<!-- TUT:BEGIN -->[\s\S]*?<!-- TUT:END -->/;

async function runSkill(parsed: Extract<ParsedArgs, { command: "skill" }>): Promise<number> {
  const file = path.join(SKILLS_DIR, `${parsed.role}.md`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(
      `tut: cannot read the ${parsed.role} skill (${file}) — the skills/ directory must sit next to the installed CLI (npm package content)\n`,
    );
    return 1;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

async function runInit(): Promise<number> {
  const root = process.cwd();

  // Step 1 — .context-hub/: the runtime-data root (serve's default --root,
  // and the layout marker tut up accepts for non-JS repos). mkdir recursive
  // is a no-op when it already exists — reruns stay idempotent.
  const hubDir = path.join(root, ".context-hub");
  try {
    await mkdir(hubDir, { recursive: true });
    process.stdout.write(`init: ensured ${hubDir}/\n`);
  } catch (e) {
    process.stderr.write(`tut: cannot create ${hubDir}: ${(e as Error).message}\n`);
    return 1;
  }

  // Step 2 — .gitignore: runtime data is machine-local, never committed.
  // Idempotent: any existing ignore line for it (with or without the
  // trailing slash) means no write at all.
  const gitignore = path.join(root, ".gitignore");
  const GITIGNORE_ENTRY = ".context-hub/";
  try {
    let giExisting: string | null = null;
    try {
      giExisting = readFileSync(gitignore, "utf8");
    } catch {
      giExisting = null; // absent (any other read failure resurfaces at the write below)
    }
    if (giExisting === null) {
      writeFileSync(gitignore, `${GITIGNORE_ENTRY}\n`, "utf8");
      process.stdout.write(`init: created ${gitignore} ignoring ${GITIGNORE_ENTRY}\n`);
    } else if (
      giExisting.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed === ".context-hub" || trimmed === GITIGNORE_ENTRY;
      })
    ) {
      process.stdout.write(`init: .gitignore already ignores ${GITIGNORE_ENTRY} (idempotent — no change)\n`);
    } else {
      const base = giExisting.replace(/\s+$/, "");
      writeFileSync(gitignore, base.length === 0 ? `${GITIGNORE_ENTRY}\n` : `${base}\n${GITIGNORE_ENTRY}\n`, "utf8");
      process.stdout.write(`init: appended ${GITIGNORE_ENTRY} to ${gitignore}\n`);
    }
  } catch (e) {
    process.stderr.write(`tut: cannot write ${gitignore}: ${(e as Error).message}\n`);
    return 1;
  }

  // Step 3 — the AGENTS.md TUT block (the original init behavior).
  const target = path.join(root, "AGENTS.md");
  const block = agentsBlock();
  let existing: string | null = null;
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    existing = null; // absent (any other read failure resurfaces at the write below)
  }
  try {
    if (existing === null) {
      writeFileSync(target, `${block}\n`, "utf8");
      process.stdout.write(`init: created ${target} with the TUT block\n`);
    } else if (TUT_BLOCK_RE.test(existing)) {
      writeFileSync(target, existing.replace(TUT_BLOCK_RE, block), "utf8");
      process.stdout.write(`init: refreshed the TUT block in ${target} (idempotent — no duplicate)\n`);
    } else {
      writeFileSync(target, `${existing.replace(/\s*$/, "\n\n")}${block}\n`, "utf8");
      process.stdout.write(`init: appended the TUT block to ${target}\n`);
    }
  } catch (e: unknown) {
    process.stderr.write(`tut: cannot write ${target}: ${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write("init: the activation phrase needs no instructions — paste「担任 TUT Host，全程驱动这个任务：<你的需求>」into any agent session\n");
  return 0;
}

// --- tut up ---------------------------------------------------------------------
// Herdr integration. Real CLI syntax verified live:
//   herdr pane list
//     → {"id":"cli:pane:list","result":{"panes":[{"pane_id","label",...}],...}}
//   herdr pane split --current --direction right --no-focus --cwd <dir>
//     → {"result":{"pane":{"pane_id":"w9:p2",...}}} — the NEW pane, no title arg
//   herdr pane rename <pane_id> <label>   → ok JSON (label via positional)
//   herdr pane run <pane_id> <command...> → types the command into the pane's
//     shell (single arg with && chains works, launch.sh's convention)
//   herdr tab create --label <t> --no-focus [--cwd <dir>]
//     → {"result":{"tab":{"tab_id",...},"root_pane":{"pane_id",...},"type":"tab_created"}}
//     — ships an EMPTY root pane (live-verified on herdr 0.8): close it
//     after moving panes in
//   herdr pane move <id> --tab <t> --split down --ratio 0.5 [--target-pane <id>] --no-focus
//   herdr pane close <id> → {"result":{"type":"ok"}}

/** Event-port probe target — the Notifier answers 405 on non-POST. */
const UP_EVENT_URL = "http://127.0.0.1:3002/agent-event";
const UP_HUB_WAIT_DEFAULT_MS = 10_000;
const UP_POLL_INTERVAL_MS = 250;

/**
 * The dedicated tab hosting the two system panes,
 * and the pane labels that make them idempotently discoverable. Sys panes
 * are exempt from role→pane routing (system-design 8.2) — these labels are
 * NOT agent names, so agent-keyed lookup never hits them.
 */
const SYS_TAB_LABEL = "tut-sys";
const SYS_HUB_PANE_LABEL = "tut-hub";
const SYS_NOTIFY_PANE_LABEL = "tut-notify";

/**
 * How long tut up waits for a freshly provisioned hub to answer /state.
 * TUT_UP_HUB_WAIT_MS (read per call) shortens the wait — test/ops knob.
 */
function hubWaitMs(): number {
  const parsed = Number(process.env.TUT_UP_HUB_WAIT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : UP_HUB_WAIT_DEFAULT_MS;
}

/**
 * Absolute path of this CLI itself — dev runs src/cli.ts, installs run
 * dist/cli.js. TUT_UP_CLI_SELF (read per call) overrides the resolution —
 * test/ops knob, the same discipline as TUT_UP_HUB_WAIT_MS.
 */
function upCliSelf(): string {
  return process.env.TUT_UP_CLI_SELF ?? fileURLToPath(import.meta.url);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry `check` until true or the deadline; sleepMs between attempts. */
async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleepMs(intervalMs);
  }
}

/**
 * GET <hub>/state and shape-check the answer: only a 2xx whose
 * JSON body carries `flow_mode` AND `tasks` counts as this system's hub —
 * anything else (refused, 404, alien JSON) means provisioning.
 */
async function hubHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/state", baseUrl));
    if (!res.ok) return false;
    const body: unknown = await res.json();
    if (body === null || typeof body !== "object") return false;
    return "flow_mode" in body && "tasks" in body;
  } catch {
    return false;
  }
}

/**
 * GET /agent-event: the Notifier's documented non-POST answer is 405 WITH an
 * Allow header naming POST (notifier.ts sends `Allow: POST` — verified).
 * Tightened: a bare 405 from an unrelated service on the port no longer counts
 * as "notifier present" — provisioning proceeds instead of silently skipping.
 */
export async function notifyHealthy(url: string = UP_EVENT_URL): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (res.status !== 405) return false;
    const allow = (res.headers.get("allow") ?? "").toUpperCase();
    return allow.split(/[\s,]+/).includes("POST");
  } catch {
    return false;
  }
}

/**
 * Seed hint: does the project scope carry an invariants seed? The marker is
 * the literal 不变量 in any record's summary or body. Returns false when the
 * project scope does not exist yet (fresh hub — definitely unseeded) and null
 * when the read fails otherwise (unknown — the hint stays silent, never nags
 * on a transient MCP failure).
 */
async function projectInvariantsSeeded(url: string): Promise<boolean | null> {
  let versions: HubReadResult["versions"];
  try {
    versions = (await hubRead(url, "project")).versions;
  } catch (e) {
    return e instanceof HubError && e.code === "TASK_NOT_FOUND" ? false : null;
  }
  return versions.some(
    (r) => r.payload.summary.includes(INVARIANTS_MARKER) || r.payload.body.includes(INVARIANTS_MARKER),
  );
}

/** Marker for an invariants seed note in the project scope (seed-hint check). */
const INVARIANTS_MARKER = "不变量";
const INVARIANTS_HINT_SUMMARY = "不变量种子：记录永不删除；写入永不拒绝≠许可；预写答案的评测材料不入库";
/** The three hard rules, AGENTS.md 不变量 wording condensed to one shell-safe line. */
const INVARIANTS_HINT_BODY =
  "记录永不删除：.context-hub/ 落盘的记录是不可变的审计材料，处置误写的正确动作是 tut decide close 或补一条说明 note，绝不是删文件。" +
  "写入永不拒绝≠许可：Hub 不做流程执法是信任设计，任何 Agent 不得利用写入自由绕过人工审批门。" +
  "预写答案的评测材料存放纪律：预先写明答案或预期结果的材料不得放入本仓库（存于仓库外），实现计划正常入库。";

/** Print the exact publish command as a HINT — seeds are human declarations, tut never auto-publishes. */
function printInvariantsHint(url: string): void {
  process.stdout.write(
    `up: project scope has no invariants seed (no note mentioning ${INVARIANTS_MARKER}) — hard rules belong where agents read them; declare them (seeds are human declarations, never auto-published):\n`,
  );
  process.stdout.write(
    `up:   tut publish project --role human --content-type note --summary '${INVARIANTS_HINT_SUMMARY}' --body '${INVARIANTS_HINT_BODY}'${url !== DEFAULT_HUB_URL ? ` --url ${url}` : ""}\n`,
  );
}

const herdrClient = new HerdrClient();

type HerdrPane = HerdrClientPane;

/**
 * `herdr pane list` → pane snapshot. A missing binary or failing call returns
 * { error } — that is the degradation trigger: without pane control tut up
 * prints manual commands instead of ever spawning hidden background processes.
 */
export async function herdrPaneList(): Promise<{ panes: HerdrPane[] } | { error: string }> {
  try {
    return await herdrClient.paneList();
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** `herdr pane split` off the current pane (no-focus, same window) → new pane id. */
async function herdrSplit(cwd: string): Promise<string | { error: string }> {
  try {
    return (await herdrClient.paneSplit({ current: true, direction: "right", noFocus: true, cwd })).paneId;
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * `herdr tab create --label tut-sys --no-focus` → the new tab's id plus the
 * EMPTY root pane it ships (live-verified shape on herdr 0.8). The root
 * pane id is optional in the return: a shape drift that omits it only costs
 * the cosmetic cleanup close, not the provisioning itself.
 */
async function herdrTabCreate(cwd: string): Promise<{ tabId: string; rootPaneId?: string } | { error: string }> {
  try {
    return await herdrClient.tabCreate({ label: SYS_TAB_LABEL, noFocus: true, cwd });
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Rename/run panes ops: exit-code check, herdr's stderr forwarded on failure. */
async function herdrOk(args: string[]): Promise<boolean> {
  const run = await herdrClient.command(args);
  if (run.error !== undefined) {
    process.stderr.write(`tut: up: herdr ${args[1] ?? ""} failed to spawn: ${run.error.message}\n`);
    return false;
  }
  if (run.code !== 0 && run.stderr.length > 0) {
    process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);
  }
  return run.code === 0;
}

/**
 * Explain the common headless-up failure: Herdr's `--current` split needs
 * either an interactive pane context or an explicit, valid pane id.
 * Include the configured value when present so an invalid id is actionable.
 */
function printHerdrAnchorHint(): void {
  const configured = process.env.HERDR_PANE_ID?.trim();
  const state = configured === undefined || configured.length === 0
    ? "unset/empty"
    : `'${configured}' (verify that it is valid)`;
  process.stderr.write(
    `tut: up: Herdr anchor unavailable — run up inside an interactive Herdr pane, or set HERDR_PANE_ID to a valid pane id (currently ${state})\n`,
  );
}

/**
 * The pane id to REPORT for a system pane, resolved fresh by label at
 * report time. Pane ids are window-scoped — a pane moved into the sys
 * tab's window is re-addressed (w1G:p2 → w1H:p2), so both the entry
 * snapshot and the split-time id can be stale by the moment we print
 * them. The label (set moments earlier by pane rename, or discovered by
 * the snapshot in the reuse path) is the stable addressing key; a fresh
 * pane list resolves it to the CURRENT id. Falls back to the
 * provisioning-time id when the fresh list is unusable or misses — the
 * report must never fail the provisioning.
 */
async function reportedPaneId(label: string, fallback: string): Promise<string> {
  const listing = await herdrPaneList();
  if ("panes" in listing) {
    const hit = listing.panes.find((p) => p.label === label);
    if (hit !== undefined) return hit.pane_id;
  }
  return fallback;
}

/**
 * tut up [--dry-run]: idempotent
 * provisioning of the power switch ONLY — hub + notify panes, raised into a
 * dedicated tut-sys tab (two log-style panes sharing one tab, split even via
 * explicit --ratio 0.5) instead of tiling the user's current tab. Role/agent
 * panes are raised on demand by launch.sh at hand-off (agent-keyed,
 * system-design 4.4).
 * 0. dev-layout guard: running from src/ means the pane commands would embed a
 *    non-runnable `node src/cli.ts` — build first (no tsx dependency);
 * 0b. cwd guardrail (package.json or .context-hub/ required);
 * 1. hub: /state shape-check → skip, or provision and WAIT for /state to turn
 *    healthy (spawn success ≠ serving);
 * 1b. seed hint: hub reachable → project scope read; no invariants note →
 *     print the exact publish command (reads only — dry-run included);
 * 2. notify: /agent-event 405+Allow:POST probe → skip, or provision (no wait
 *     mandated: the probe covers the next run);
 * Per-pane idempotency ladder: healthy skip (upstream probe) → dead-pane
 * reuse (labelled pane in the snapshot: rerun the command in place, never a
 * second split) → full provisioning (split → ensure tut-sys tab → move
 * --ratio 0.5 → close the tab's empty root when we created it → rename →
 * run). --dry-run prints the full plan (reads still happen: probes + pane
 * list). No usable Herdr → manual command list for whatever is down, roles
 * skipped, exit 0 — never a hidden background process.
 */

/** Guard message: up provisions a LOCAL hub, so --url must be loopback http with an explicit port. */
function upUrlError(url: string): string {
  return `tut: up: --url must be an http loopback URL with an explicit port (e.g. http://127.0.0.1:3002), got: ${url}\n`;
}

/**
 * The tail activation hint (final wording, human ruling 2026-08-25): pure
 * intent — no paths, no how-to-read-rules instructions. The mechanism
 * lives in the AGENTS.md block `tut init` maintains; printed on every up
 * exit path, --dry-run included.
 */
function printActivationHint(): void {
  process.stdout.write("up: activate a Host — tell any coding-agent session in this repo:\n");
  process.stdout.write("up:   「担任 TUT Host，全程驱动这个任务：<你的需求>」\n");
  process.stdout.write('up:   ("Act as TUT Host and drive this task end to end: <request>" — works via the AGENTS.md block from `tut init`)\n');
}

async function runUp(parsed: Extract<ParsedArgs, { command: "up" }>): Promise<number> {
  const dryRun = parsed.dryRun;
  const cwd = process.cwd();
  const self = upCliSelf();

  // --url selects the hub to provision. up provisions a LOCAL hub — the
  // host must be loopback and the port explicit (serve needs a concrete port
  // to bind). Validated before any probe, spawn, or pane read.
  const hubUrl = parsed.url ?? DEFAULT_HUB_URL;
  let hubPort: number;
  try {
    const u = new URL(hubUrl);
    const loopback = u.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
    if (!loopback || u.port.length === 0) throw new Error("not a loopback http URL with an explicit port");
    hubPort = Number(u.port);
  } catch {
    process.stderr.write(upUrlError(hubUrl));
    return 1;
  }

  // Dev-layout fix: a src-layout self would provision panes running
  // `node src/cli.ts …` (TypeScript — not directly runnable). Fail BEFORE any
  // probe, spawn, or side effect; building is the user's one-step remedy.
  // Judge by the self file's PARENT directory (dist layout ⇒ "dist"), not by
  // any path segment — a repo checked out under ~/src/TUT must not trip this.
  if (path.basename(path.dirname(self)) === "src") {
    process.stderr.write(
      "tut up: running from src layout — run `npm run build` first (dist/cli.js is the provision target); " +
        "or set TUT_UP_CLI_SELF to a dist-style path\n",
    );
    return 1;
  }

  if (!existsSync(path.join(cwd, "package.json")) && !existsSync(path.join(cwd, ".context-hub"))) {
    process.stderr.write(
      `tut: up: no package.json or .context-hub/ in ${cwd} — not a TUT project yet: run 'tut init' here to onboard (creates .context-hub/ and the AGENTS.md block), or cd to the project root and run tut up there\n`,
    );
    return 1;
  }

  // Workspace-lineup hint (a PROMPT, never a write — configs are human
  // declarations, the same discipline as the invariants seed hint): both
  // the project-level and user-level workspace configs missing → the
  // built-in defaults are in effect; print the migration pointer once.
  if (
    !existsSync(path.join(cwd, ".context-hub", "workspace.json")) &&
    !existsSync(path.join(defaultUserConfigDir(), "workspace.json"))
  ) {
    const seed = fileURLToPath(new URL("../scripts/workspace.json", import.meta.url));
    process.stdout.write(
      "up: no workspace lineup config found — using built-in defaults (architect=codex, executor=pi, reviewer=codex)\n",
    );
    process.stdout.write(
      "up:   to customize: tut assign <role> <agent>   (the light path — e.g. tut assign executor pi; rewrites one seat)\n",
    );
    process.stdout.write(
      `up:   full control: cp ${seed} ${path.join(cwd, ".context-hub", "workspace.json")}   (project-level; or ${path.join(defaultUserConfigDir(), "workspace.json")} for all projects)\n`,
    );
  }

  // A non-default --url must reach the provisioned panes too — serve binds
  // the parsed port, notify polls it (byte-identical commands when the default
  // is used, so existing provisioning output is unchanged).
  //
  // The service commands are PaneCommands now, rendered by the same dialect
  // renderer the agent panes use: POSIX output keeps the legacy `cd … &&
  // node …` bytes exactly; PowerShell dialects never see `&&`; cmd picks the
  // safe direct form or the encoded pane-runner.  The dialect resolves
  // BEFORE any probe so a bad TUT_PANE_SHELL fails the whole up run.
  let dialect: ShellDialect;
  try {
    dialect = resolvePaneShellDialect(process.env);
  } catch (error) {
    process.stderr.write(`tut: up: ${(error as Error).message}\n`);
    return 1;
  }
  // Windows carries the absolute node.exe the cmd/PowerShell forms quote;
  // POSIX keeps the bare PATH-resolved `node` word of the legacy bytes.
  const nodeWord = process.platform === "win32" ? process.execPath : "node";
  const renderServiceCommand = (args: readonly string[]): string =>
    renderPaneCommand({
      cwd,
      executable: nodeWord,
      args: [...args],
      env: {},
      dialect,
      purpose: "service",
    } as PaneCommand).command_text;
  let serveCmd: string;
  let notifyCmd: string;
  try {
    serveCmd = renderServiceCommand([self, "serve", ...(hubPort === 3001 ? [] : ["--port", String(hubPort)])]);
    notifyCmd = renderServiceCommand([self, "notify", ...(hubPort === 3001 ? [] : ["--url", hubUrl])]);
  } catch (error) {
    process.stderr.write(`tut: up: cannot render the service pane command: ${(error as Error).message}\n`);
    return 1;
  }
  const manual: string[] = [];

  // Herdr usability + the role-step pane snapshot in one read.
  const listing = await herdrPaneList();
  const panes = "panes" in listing ? listing.panes : null;
  const herdrError = "error" in listing ? listing.error : "";

  // C-layout sys-tab state, shared across the two provisioning steps: the
  // discovered/created tut-sys tab plus its anchor pane (the move --target).
  // Discovery rides the same pane-list snapshot — a labelled sys pane carries
  // its tab_id, so no `herdr tab list` (unobserved shape) is ever needed.
  let sysTab: { tabId: string; anchorPane?: string; rootPaneId?: string; fresh: boolean } | null = null;
  if (panes !== null) {
    const anchor =
      panes.find((p) => p.label === SYS_HUB_PANE_LABEL) ?? panes.find((p) => p.label === SYS_NOTIFY_PANE_LABEL);
    if (anchor !== undefined && anchor.tab_id !== undefined) {
      sysTab = { tabId: anchor.tab_id, anchorPane: anchor.pane_id, fresh: false };
    }
  }

  /**
   * Provision one system pane (hub/notify) into the tut-sys tab. Ladder:
   * labelled pane in the snapshot = dead pane → rerun in place (no split, no
   * tab work); otherwise split → ensure the tab → move (--split down
   * --ratio 0.5, even halves) → close the tab's empty root (only when we
   * created the tab this run) → rename → run. Returns the running pane id,
   * or null with the failure already printed.
   */
  const provisionSysPane = async (
    label: string,
    name: string,
    cmd: string,
  ): Promise<{ paneId: string; reused: boolean } | null> => {
    const dead = panes?.find((p) => p.label === label);
    if (dead !== undefined) {
      if (dryRun) {
        process.stdout.write(`up: [dry-run] would reuse pane ${dead.pane_id} (label ${label}) and run: ${cmd}\n`);
        return { paneId: dead.pane_id, reused: true };
      }
      if (!(await herdrOk(["pane", "run", dead.pane_id, cmd]))) {
        process.stderr.write(`tut: up: could not start ${name} in pane ${dead.pane_id}\n`);
        return null;
      }
      return { paneId: dead.pane_id, reused: true };
    }
    if (dryRun) {
      const freshTab = sysTab === null;
      const tabId = sysTab === null ? "<new-tab>" : sysTab.tabId;
      process.stdout.write(`up: [dry-run] would provision the ${label} pane into tab ${SYS_TAB_LABEL}:\n`);
      process.stdout.write(`up: [dry-run]   pane split --current --direction right --no-focus --cwd ${cwd}\n`);
      if (freshTab) {
        process.stdout.write(`up: [dry-run]   tab create --label ${SYS_TAB_LABEL} --no-focus --cwd ${cwd}\n`);
      }
      const move = `up: [dry-run]   pane move <new-pane> --tab ${tabId} --split down --ratio 0.5 --no-focus`;
      process.stdout.write(
        sysTab?.anchorPane !== undefined ? `${move} --target-pane ${sysTab.anchorPane}\n` : `${move}\n`,
      );
      if (freshTab) {
        process.stdout.write(`up: [dry-run]   pane close <root-pane>   (tab create ships an empty root pane)\n`);
      }
      process.stdout.write(`up: [dry-run]   pane rename <new-pane> ${label}\n`);
      process.stdout.write(`up: [dry-run]   pane run <new-pane> ${cmd}\n`);
      // Plan-level state so the notify plan targets the (planned) hub pane
      // and omits its own tab create/close lines.
      if (sysTab === null) {
        sysTab = { tabId, ...(label === SYS_HUB_PANE_LABEL ? { anchorPane: "<tut-hub-pane>" } : {}), fresh: true };
      } else if (sysTab.anchorPane === undefined && label === SYS_HUB_PANE_LABEL) {
        sysTab.anchorPane = "<tut-hub-pane>";
      }
      return { paneId: "<new-pane>", reused: false };
    }
    const pane = await herdrSplit(cwd);
    if (typeof pane !== "string") {
      process.stderr.write(`tut: up: ${pane.error}\n`);
      printHerdrAnchorHint();
      return null;
    }
    if (sysTab === null) {
      const tab = await herdrTabCreate(cwd);
      if ("error" in tab) {
        process.stderr.write(`tut: up: ${tab.error}\n`);
        return null;
      }
      sysTab = { tabId: tab.tabId, ...(tab.rootPaneId !== undefined ? { rootPaneId: tab.rootPaneId } : {}), fresh: true };
    }
    const moveArgs = ["pane", "move", pane, "--tab", sysTab.tabId, "--split", "down", "--ratio", "0.5", "--no-focus"];
    if (sysTab.anchorPane !== undefined) moveArgs.push("--target-pane", sysTab.anchorPane);
    if (!(await herdrOk(moveArgs))) {
      process.stderr.write(
        `tut: up: could not move pane ${pane} into tab ${SYS_TAB_LABEL} — orphan pane left in the current tab; clean up manually: herdr pane close ${pane}\n`,
      );
      printHerdrAnchorHint();
      return null;
    }
    sysTab.anchorPane = pane; // the next sys pane splits THIS pane (--ratio 0.5 → even halves)
    if (sysTab.fresh && sysTab.rootPaneId !== undefined) {
      // Empty-root cleanup, only for a tab created this run. Non-fatal: a
      // leftover empty pane is cosmetic (herdr's stderr is forwarded by herdrOk).
      await herdrOk(["pane", "close", sysTab.rootPaneId]);
      sysTab.fresh = false;
    }
    if (!(await herdrOk(["pane", "rename", pane, label]))) {
      process.stderr.write(`tut: up: could not label pane ${pane} as ${label} — rediscovery depends on it\n`);
      return null;
    }
    if (!(await herdrOk(["pane", "run", pane, cmd]))) {
      process.stderr.write(`tut: up: could not start ${name} in pane ${pane}\n`);
      return null;
    }
    return { paneId: pane, reused: false };
  };

  // Step 1 — hub.
  let hubUp = false;
  if (await hubHealthy(hubUrl)) {
    hubUp = true;
    process.stdout.write(`up: hub already running (${hubUrl}/state)\n`);
  } else if (panes === null) {
    manual.push(serveCmd);
  } else {
    const provisioned = await provisionSysPane(SYS_HUB_PANE_LABEL, "serve", serveCmd);
    if (provisioned === null) return 1;
    if (!dryRun) {
      const startedAt = Date.now();
      const waitMs = hubWaitMs();
      if (!(await pollUntil(() => hubHealthy(hubUrl), waitMs, UP_POLL_INTERVAL_MS))) {
        process.stderr.write(
          `tut: up: serve pane ${provisioned.paneId} started but ${hubUrl}/state stayed unhealthy for ${waitMs}ms — check the pane\n`,
        );
        return 1;
      }
      hubUp = true;
      process.stdout.write(
        `up: hub serving on ${hubUrl} (pane ${await reportedPaneId(SYS_HUB_PANE_LABEL, provisioned.paneId)}, tab ${SYS_TAB_LABEL}${provisioned.reused ? ", reused" : ""}, waited ${Date.now() - startedAt}ms)\n`,
      );
    }
  }

  // Step 1b — seed hint (hub reachable only; the read is allowed in dry-run).
  if (hubUp && (await projectInvariantsSeeded(hubUrl)) === false) {
    printInvariantsHint(hubUrl);
  }

  // Step 2 — notifier (no wait mandated: the probe covers the next run).
  if (await notifyHealthy()) {
    process.stdout.write(`up: notify already listening (${UP_EVENT_URL})\n`);
  } else if (panes === null) {
    manual.push(notifyCmd);
  } else {
    const provisioned = await provisionSysPane(SYS_NOTIFY_PANE_LABEL, "notify", notifyCmd);
    if (provisioned === null) return 1;
    if (!dryRun) {
      process.stdout.write(
        `up: notify running (pane ${await reportedPaneId(SYS_NOTIFY_PANE_LABEL, provisioned.paneId)}, tab ${SYS_TAB_LABEL}${provisioned.reused ? ", reused" : ""})\n`,
      );
    }
  }

  // Degradation: no usable Herdr → manual commands for whatever is down,
  // idempotent exit 0 — never a hidden background process.
  if (panes === null) {
    process.stdout.write(`up: herdr unusable (${herdrError}) — panes cannot be managed; start manually:\n`);
    for (const cmd of manual) process.stdout.write(`up:   ${cmd}\n`);
    process.stdout.write("up: agent panes are on-demand — launchers raise them at hand-off\n");
    printActivationHint();
    return 0;
  }
  // No role-pane provisioning here — panes are agent-keyed and
  // raised on demand by the launcher at hand-off time. up is the power
  // switch (hub + notify).
  process.stdout.write("up: agent panes are on-demand — launchers raise them at hand-off\n");
  printActivationHint();
  return 0;
}

export const HANDLERS = {
  serve: runServe as Handler<Extract<ParsedArgs, { command: "serve" }>>,
  notify: (async (parsed) => {
    try {
      await runNotify({
        url: parsed.url,
        interval: parsed.interval,
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
  }) as Handler<Extract<ParsedArgs, { command: "notify" }>>,
  mode: runMode,
  config: runConfig,
  startNext: runStartNext,
  launch: runLaunch,
  watch: runWatch,
  create: runCreate,
  publish: runPublish,
  read: runRead,
  list: runList,
  status: runStatus,
  decide: runDecide,
  ack: runAck,
  assign: runAssign,
  up: runUp,
  skill: runSkill as Handler<Extract<ParsedArgs, { command: "skill" }>>,
  init: runInit as Handler<Extract<ParsedArgs, { command: "init" }>>,
};

/** Runs a parsed invocation; returns the process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "usage") {
    if (parsed.error !== undefined) process.stderr.write(`tut: ${parsed.error}\n`);
    process.stderr.write(USAGE);
    return 1;
  }
  switch (parsed.command) {
    case "serve": return HANDLERS.serve(parsed);
    case "notify": return HANDLERS.notify(parsed);
    case "mode": return HANDLERS.mode(parsed);
    case "config": return HANDLERS.config(parsed);
    case "start-next": return HANDLERS.startNext(parsed);
    case "launch": return HANDLERS.launch(parsed);
    case "watch": return HANDLERS.watch(parsed);
    case "create": return HANDLERS.create(parsed);
    case "publish": return HANDLERS.publish(parsed);
    case "read": return HANDLERS.read(parsed);
    case "list": return HANDLERS.list(parsed);
    case "status": return HANDLERS.status(parsed);
    case "decide": return HANDLERS.decide(parsed);
    case "ack": return HANDLERS.ack(parsed);
    case "assign": return HANDLERS.assign(parsed);
    case "up": return HANDLERS.up(parsed);
    case "skill": return HANDLERS.skill(parsed);
    case "init": return HANDLERS.init(parsed);
  }
}

// Direct-invocation guard (`node dist/cli.js ...`, or the `tut` bin symlink
// created by `npm link`); imports for tests do not run main. Both sides go
// through realpath: the bin symlink must also fire main, and Node's ESM
// loader may or may not realpath import.meta.url depending on
// --preserve-symlinks — comparing realpaths covers every combination.
const scriptPath = process.argv[1];
function invokedAsScript(): boolean {
  if (scriptPath === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(scriptPath);
  } catch {
    return false;
  }
}
if (invokedAsScript()) {
  void main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`tut: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}

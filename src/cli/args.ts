import path from "node:path";
import { AgentCommandError, parseAgentInvocation, parseAgentRoute } from "../common/agent-command.js";
import type { AgentRoute, Cast, CheckoutRoute, Flow } from "../common/types.js";
import { DEFAULT_HUB_URL, DEFAULT_EVENT_PORT } from "./shared.js";

// --- parsed shapes (frozen — handlers consume these) -------------------------

export type ParsedArgs =
  | { command: "mcp" }
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
  | {
      command: "create";
      title: string;
      description: string;
      creator: string;
      role: string;
      flow?: Flow;
      cast?: Cast;
      checkout?: CheckoutRoute;
      url?: string;
    }
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
  | { command: "doctor"; root: string; url: string; json: boolean }
  | {
      command: "repair-meta";
      task_id: string;
      title?: string;
      description?: string;
      creator?: string;
      createdAt?: string;
      flow?: Flow;
      cast?: Cast;
      checkout?: CheckoutRoute;
      url: string;
    }
  | { command: "recover-record"; task_id: string; recordFile: string; from: string; source?: string; url: string }
  | { command: "decide"; task_id: string; decision: "approve" | "reject" | "close"; by: string; reason?: string; url?: string }
  | { command: "ack"; task_id: string; note?: string; url?: string }
  | { command: "assign"; role: "architect" | "executor" | "reviewer"; agent: AgentRoute }
  | { command: "up"; dryRun: boolean; url?: string; eventPort?: number }
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

/** Listener ports cannot use serve's special ephemeral-port value (0). */
function positiveIntFlag(tokens: Tokens, name: string): FlagResult<number> | { value?: undefined; error?: undefined } {
  const parsed = intFlag(tokens, name);
  if ("error" in parsed) return parsed;
  if (parsed.value === 0) return { error: `--${name} requires a positive integer, got: 0` };
  return parsed;
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
  for (const name of ["interval", "stall-timeout"] as const) {
    const err = flagError(intFlag(t, name));
    if (err !== undefined) return { command: "usage", error: err };
  }
  const eventPort = positiveIntFlag(t, "event-port");
  const eventPortErr = flagError(eventPort);
  if (eventPortErr !== undefined) return { command: "usage", error: eventPortErr };
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
    url: strFlag(t, "url") ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL,
    interval: flagValue(intFlag(t, "interval")) ?? 5,
    eventPort: flagValue(eventPort) ?? DEFAULT_EVENT_PORT,
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
  return { command: "mode", mode, url: strFlag(t, "url") ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL };
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
    url: strFlag(t, "url") ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL,
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
    url: strFlag(t, "url") ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL,
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

function checkoutPart(value: unknown, field: string): string | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
    return { error: `--${field} must be a non-empty string without NUL/CR/LF` };
  }
  return value;
}

/** Parse the CLI's explicit checkout route without resolving it against cwd. */
function parseCheckoutSpec(
  raw: string | undefined,
  pathValue: string | undefined,
  refValue: string | undefined,
): CheckoutRoute | undefined | { error: string } {
  if (raw === undefined && pathValue === undefined && refValue === undefined) return undefined;

  let route: CheckoutRoute;
  if (raw === undefined) {
    route = { kind: "worktree" };
  } else {
    const spec = raw.trim();
    if (spec === "current") {
      route = { kind: "current" };
    } else if (spec === "worktree") {
      route = { kind: "worktree" };
    } else if (spec.startsWith("worktree:") || spec.startsWith("worktree=")) {
      route = { kind: "worktree", path: spec.slice("worktree:".length) };
      if (spec.startsWith("worktree=")) route = { kind: "worktree", path: spec.slice("worktree=".length) };
    } else if (spec.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(spec);
      } catch {
        return { error: "--checkout JSON must be valid JSON" };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { error: "--checkout JSON must be a checkout object" };
      }
      const candidate = parsed as Record<string, unknown>;
      if (candidate.kind === "current") route = { kind: "current" };
      else if (candidate.kind === "worktree") {
        const parsedPath = checkoutPart(candidate.path, "checkout.path");
        if (typeof parsedPath === "object") return parsedPath;
        const parsedRef = checkoutPart(candidate.ref, "checkout.ref");
        if (typeof parsedRef === "object") return parsedRef;
        route = {
          kind: "worktree",
          ...(parsedPath !== undefined ? { path: parsedPath } : {}),
          ...(parsedRef !== undefined ? { ref: parsedRef } : {}),
        };
      } else {
        return { error: "--checkout.kind must be current or worktree" };
      }
    } else if (path.isAbsolute(spec) || spec.startsWith("./") || spec.startsWith("../") || /^[A-Za-z]:[\\/]/u.test(spec) || spec.startsWith("\\\\")) {
      // A path-only spelling is accepted as a convenience; the documented
      // unambiguous form remains `worktree:<path>`.
      route = { kind: "worktree", path: spec };
    } else {
      return { error: `--checkout must be current, worktree:<path>, or a checkout JSON object; got: ${raw}` };
    }
  }

  if (route.kind === "current") {
    if (pathValue !== undefined || refValue !== undefined) {
      return { error: "--checkout current cannot be combined with --checkout-path/--checkout-ref" };
    }
    return route;
  }

  if (route.path !== undefined && pathValue !== undefined) {
    return { error: "checkout path was specified more than once" };
  }
  if (route.ref !== undefined && refValue !== undefined) {
    return { error: "checkout ref was specified more than once" };
  }
  const mergedPath = route.path ?? pathValue;
  const mergedRef = route.ref ?? refValue;
  const checkedPath = checkoutPart(mergedPath, "checkout-path");
  if (typeof checkedPath === "object") return checkedPath;
  const checkedRef = checkoutPart(mergedRef, "checkout-ref");
  if (typeof checkedRef === "object") return checkedRef;
  if (checkedPath === undefined) {
    return {
      error:
        "worktree checkout requires a path (--checkout worktree:<path> or --checkout-path <path>); ref alone is not launchable — a ref may only annotate a path",
    };
  }
  return {
    kind: "worktree",
    ...(checkedPath !== undefined ? { path: checkedPath } : {}),
    ...(checkedRef !== undefined ? { ref: checkedRef } : {}),
  };
}

function parseCreate(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, {
    values: new Set([
      "title", "description", "creator", "role", "flow", "cast", "checkout",
      "checkout-kind", "checkout-path", "checkout-ref", "worktree", "worktree-path", "worktree-ref", "url",
    ]),
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
  let checkoutSpec = strFlag(t, "checkout") ?? strFlag(t, "worktree");
  if (strFlag(t, "checkout") !== undefined && strFlag(t, "worktree") !== undefined) {
    return { command: "usage", error: "--checkout and --worktree are mutually exclusive" };
  }
  const checkoutKind = strFlag(t, "checkout-kind");
  if (checkoutKind !== undefined && checkoutKind !== "current" && checkoutKind !== "worktree") {
    return { command: "usage", error: "--checkout-kind must be current or worktree" };
  }
  if (checkoutKind === "current") {
    if (checkoutSpec !== undefined && checkoutSpec !== "current") {
      return { command: "usage", error: "--checkout-kind current conflicts with the worktree checkout spec" };
    }
    checkoutSpec = "current";
  } else if (checkoutKind === "worktree") {
    if (checkoutSpec === "current") {
      return { command: "usage", error: "--checkout-kind worktree conflicts with --checkout current" };
    }
    checkoutSpec ??= "worktree";
  }
  const checkoutPath = strFlag(t, "checkout-path") ?? strFlag(t, "worktree-path");
  if (strFlag(t, "checkout-path") !== undefined && strFlag(t, "worktree-path") !== undefined) {
    return { command: "usage", error: "--checkout-path and --worktree-path are mutually exclusive" };
  }
  const checkoutRef = strFlag(t, "checkout-ref") ?? strFlag(t, "worktree-ref");
  if (strFlag(t, "checkout-ref") !== undefined && strFlag(t, "worktree-ref") !== undefined) {
    return { command: "usage", error: "--checkout-ref and --worktree-ref are mutually exclusive" };
  }
  const checkout = parseCheckoutSpec(checkoutSpec, checkoutPath, checkoutRef);
  if (checkout !== undefined && "error" in checkout) return { command: "usage", error: checkout.error };
  const url = strFlag(t, "url");
  return {
    command: "create",
    title: title.value,
    description: description.value,
    creator: creator.value,
    role: role.value,
    ...(flow !== undefined ? { flow } : {}),
    ...(cast !== undefined ? { cast } : {}),
    ...(checkout !== undefined ? { checkout } : {}),
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

/** doctor's run entry needs only the storage root and the hub base URL —
 *  the same defaults serve/config use (cwd's .context-hub, DEFAULT_HUB_URL). */
function parseDoctor(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["root", "url"]), bools: JSON_BOOLS });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 0);
  if (extra !== undefined) return { command: "usage", error: extra };
  return {
    command: "doctor",
    root: strFlag(t, "root") ?? ".context-hub",
    url: strFlag(t, "url") ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL,
    json: t.bools.has("json"),
  };
}

/**
 * tut repair-meta — the CLI client of POST /repair-meta (A-class,
 * system-design 4.3). Every flag mirrors one JSON body field of the
 * endpoint; absent flags OMIT the field so the store-side fallbacks apply
 * (title → task_id, flow → full). Values pass through untouched — the store
 * is the single validation authority, so a bad value comes back as an
 * honest 400 rather than a silently repaired default (http.ts's
 * parseRepairMetaBody discipline). Reuses create's --cast/--checkout
 * parsers so the rebuild surfaces accept the same spellings create does.
 */
function parseRepairMeta(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, {
    values: new Set(["title", "description", "creator", "created-at", "flow", "cast", "checkout", "url"]),
    repeatable: new Set(["cast"]),
  });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 1);
  if (extra !== undefined) return { command: "usage", error: extra };
  const taskId = t.positionals[0];
  if (taskId === undefined) return { command: "usage", error: "repair-meta requires a task_id" };
  const flow = strFlag(t, "flow");
  if (flow !== undefined && flow !== "full" && flow !== "direct" && flow !== "solo") {
    return { command: "usage", error: `--flow must be full|direct|solo, got: ${flow}` };
  }
  let cast: Cast | undefined;
  for (const castRaw of strFlags(t, "cast")) {
    const parsed = parseCastPairs(castRaw);
    if ("error" in parsed) return { command: "usage", error: parsed.error };
    cast = { ...(cast ?? {}), ...parsed };
  }
  const checkout = parseCheckoutSpec(strFlag(t, "checkout"), undefined, undefined);
  if (checkout !== undefined && "error" in checkout) return { command: "usage", error: checkout.error };
  const title = strFlag(t, "title");
  const description = strFlag(t, "description");
  const creator = strFlag(t, "creator");
  const createdAt = strFlag(t, "created-at");
  const url = strFlag(t, "url");
  return {
    command: "repair-meta",
    task_id: taskId,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(flow !== undefined ? { flow } : {}),
    ...(cast !== undefined ? { cast } : {}),
    ...(checkout !== undefined ? { checkout } : {}),
    url: url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL,
  };
}

/**
 * tut recover-record — the CLI client of POST /recover-record (B-class,
 * system-design 4.3): exactly the endpoint's three required fields
 * (task_id, record_file, from_path) plus the optional provenance note.
 * record_file is a file NAME within the task directory (v003.note.json),
 * not a path; --from is the local path to the recovered original bytes.
 */
function parseRecoverRecord(args: readonly string[]): ParsedArgs {
  const t = tokenize(args, { values: new Set(["from", "source", "url"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 2);
  if (extra !== undefined) return { command: "usage", error: extra };
  const taskId = t.positionals[0];
  if (taskId === undefined) return { command: "usage", error: "recover-record requires a task_id" };
  const recordFile = t.positionals[1];
  if (recordFile === undefined) {
    return { command: "usage", error: "recover-record requires a record file name (e.g. v003.note.json)" };
  }
  const from = requireStr(t, "from");
  if ("error" in from) return { command: "usage", error: from.error };
  const source = strFlag(t, "source");
  const url = strFlag(t, "url");
  return {
    command: "recover-record",
    task_id: taskId,
    recordFile,
    from: from.value,
    ...(source !== undefined ? { source } : {}),
    url: url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL,
  };
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
  const t = tokenize(args, { values: new Set(["url", "event-port"]), bools: new Set(["dry-run"]) });
  if ("error" in t) return { command: "usage", error: t.error };
  const extra = extraPositionalError(t, 0);
  if (extra !== undefined) return { command: "usage", error: extra };
  const parsedEventPort = positiveIntFlag(t, "event-port");
  const eventPortErr = flagError(parsedEventPort);
  if (eventPortErr !== undefined) return { command: "usage", error: eventPortErr };
  const url = strFlag(t, "url");
  const eventPort = flagValue(parsedEventPort);
  return {
    command: "up",
    dryRun: t.bools.has("dry-run"),
    ...(url !== undefined ? { url } : {}),
    ...(eventPort !== undefined ? { eventPort } : {}),
  };
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
    case "mcp": return rest.length === 0 ? { command: "mcp" } : { command: "usage", error: "mcp takes no arguments; configure TUT_HUB_ROOT / TUT_HUB_URL via env" };
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
    case "doctor": return parseDoctor(rest);
    case "repair-meta": return parseRepairMeta(rest);
    case "recover-record": return parseRecoverRecord(rest);
    case "decide": return parseDecide(rest);
    case "ack": return parseAck(rest);
    case "assign": return parseAssign(rest);
    case "up": return parseUp(rest);
    case "skill": return parseSkill(rest);
    case "init": return parseInit(rest);
    default: return { command: "usage", error: `unknown command: ${first}` };
  }
}
/**
 * Shell-neutral agent command values.
 *
 * A route is either the legacy bare executable name (kept as a string for
 * storage compatibility) or an explicit argv-shaped command.  TUT accepts a
 * deliberately small grammar: whitespace separates words, while shell
 * syntax is rejected instead of interpreted.  The launcher can therefore
 * expand a validated route into argv without shell evaluation or a second parser.
 */

import type { AgentCommand, AgentRoute } from "./types.js";

/**
 * Conservative shell-neutral token grammar shared with scripts/tut-resolve.mjs.
 *
 * An allowlist is deliberately used here instead of a denylist: a value that
 * is harmless in one shell can still be syntax in another (notably `#` and
 * `!`). These characters cover executable names, flags, model names, paths,
 * URLs, and ordinary flag values without giving the shell an operator,
 * quoting, expansion, or comment/history token.
 */
const SHELL_NEUTRAL_TOKEN = /^[A-Za-z0-9._@%+=:,\/-]+$/u;

export class AgentCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCommandError";
  }
}

/** A single executable/argument token is non-empty and shell-neutral. */
export function validateAgentToken(value: unknown, field = "command token"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentCommandError(`${field} must be a non-empty token`);
  }
  if (/\s/.test(value)) {
    throw new AgentCommandError(`${field} must not contain whitespace`);
  }
  if (!SHELL_NEUTRAL_TOKEN.test(value)) {
    throw new AgentCommandError(`${field} is not a shell-neutral token`);
  }
  return value;
}

/** Normalize and validate a route while preserving its legacy string shape. */
export function validateAgentRoute(value: unknown, field = "agent command"): AgentRoute {
  if (typeof value === "string") return parseAgentRoute(value, field);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentCommandError(`${field} must be a command string or {agent,args}`);
  }

  const raw = value as { agent?: unknown; args?: unknown };
  const agent = validateAgentToken(raw.agent, `${field}.agent`);
  if (!Array.isArray(raw.args)) {
    throw new AgentCommandError(`${field}.args must be an array`);
  }
  const args = raw.args.map((arg, index) => validateAgentToken(arg, `${field}.args[${index}]`));
  return { agent, args };
}

/**
 * Parse the human-facing command string.  The outer shell is expected to
 * deliver the whole value as one argv item; TUT itself only splits on
 * whitespace and never honors quotes, backslashes, variables, operators,
 * redirects, globbing, or command substitution.
 */
export function parseAgentRoute(value: string, field = "agent command"): AgentRoute {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentCommandError(`${field} must be a non-empty command`);
  }
  const tokens = value.trim().split(/\s+/u);
  const validated = tokens.map((token, index) => validateAgentToken(token, `${field}[${index}]`));
  const [agent, ...args] = validated;
  if (agent === undefined) throw new AgentCommandError(`${field} must include an executable`);
  return args.length === 0 ? agent : { agent, args };
}

/**
 * Parse an invocation boundary without losing argv boundaries.
 *
 * A single value is the legacy raw command-string form and is split once by
 * parseAgentRoute. Multiple values are already-separated argv and are
 * validated independently, preserving empty values as invalid rather than
 * silently swallowing them through join/split normalization.
 */
export function parseAgentInvocation(values: readonly string[], field = "agent invocation"): AgentRoute {
  if (values.length === 0) throw new AgentCommandError(`${field} must include an executable`);
  if (values.length === 1) return parseAgentRoute(values[0]!, field);
  const validated = values.map((value, index) => validateAgentToken(value, `${field}[${index}]`));
  const [agent, ...args] = validated;
  if (agent === undefined) throw new AgentCommandError(`${field} must include an executable`);
  return { agent, args };
}

/** Convert a route to a normalized argv object for an execution boundary. */
export function normalizeAgentRoute(route: AgentRoute): AgentCommand {
  const valid = validateAgentRoute(route);
  return typeof valid === "string" ? { agent: valid, args: [] } : { agent: valid.agent, args: [...valid.args] };
}

/** Return the executable/command head used by command -v and event routing. */
export function commandHead(route: AgentRoute): string {
  return normalizeAgentRoute(route).agent;
}

/** Return a defensive copy of the argv tail. */
export function commandArgs(route: AgentRoute): string[] {
  return normalizeAgentRoute(route).args;
}

/** Human/display form; all tokens are already shell-neutral. */
export function formatAgentRoute(route: AgentRoute): string {
  const normalized = normalizeAgentRoute(route);
  return [normalized.agent, ...normalized.args].join(" ");
}

/** True for the parameterized route representation. */
export function isAgentCommand(route: AgentRoute): route is AgentCommand {
  return typeof route !== "string";
}

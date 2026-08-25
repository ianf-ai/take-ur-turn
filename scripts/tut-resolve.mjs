#!/usr/bin/env node
// tut-resolve — launch.sh's half of the workspace-lineup resolution chain.
// Zero-dependency plain node (launch.sh stays
// zero-build): mirrors src/workspace.ts exactly. Parity between the two
// implementations is pinned by test (same fixture vectors, same output).
//
// Chain (per-field, never-throw — missing/corrupt file = level absent):
//   L1 project  <l1Root>/.context-hub/workspace.json
//   L2 user     $TUT_USER_CONFIG_DIR ?? ~/.config/tut  /workspace.json
//   L3 built-in DEFAULT_ROLES {architect: codex, executor: pi, reviewer: codex}
//
// L1 root precedence: $TUT_PROJECT_ROOT ?? the optional <anchorCwd>
// positional (launch.sh passes the anchor pane's cwd) ?? skip L1.
//
// Subcommands:
//   resolve <role> [anchorCwd]            → prints the route display
//   tab-label <role> <task> <agent> [anchorCwd]
//                                         → prints the rendered tab label.
//                                           Template chain (independent):
//                                           L1 naming.tab_label → L2 →
//                                           "TUT {role}". Placeholders
//                                           {role}/{task}/{agent}; unknown
//                                           placeholders preserved verbatim.
//                                           The PANE label is never rendered
//                                           here — it stays the fixed
//                                           <task_id>.<role> addressing key
//                                           (system-design 4.4).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_ROLES = { architect: "codex", executor: "pi", reviewer: "codex" };
const UNKNOWN_ROLE_AGENT = "codex";
const DEFAULT_TAB_LABEL = "TUT {role}";
// Keep this literal byte-for-byte aligned with src/agent-command.ts. An
// allowlist covers normal executable/flag/value words and rejects shell
// operators, quoting, expansion, comments, and history syntax (`#`, `!`).
const SHELL_NEUTRAL_TOKEN = /^[A-Za-z0-9._@%+=:,\/-]+$/u;

const commandError = (message) => {
  const error = new Error(message);
  error.name = "AgentCommandError";
  throw error;
};

const validateToken = (value, field = "command token") => {
  if (typeof value !== "string" || value.length === 0) commandError(`${field} must be a non-empty token`);
  if (/\s/.test(value)) commandError(`${field} must not contain whitespace`);
  if (!SHELL_NEUTRAL_TOKEN.test(value)) commandError(`${field} is not a shell-neutral token`);
  return value;
};

const parseCommand = (value, field = "agent command") => {
  if (typeof value !== "string" || value.trim().length === 0) commandError(`${field} must be a non-empty command`);
  const tokens = value.trim().split(/\s+/u).map((token, i) => validateToken(token, `${field}[${i}]`));
  const [agent, ...args] = tokens;
  if (agent === undefined) commandError(`${field} must include an executable`);
  return args.length === 0 ? agent : { agent, args };
};

// One raw value is the legacy command-string form. Multiple values are an
// already-separated argv and must be checked one by one; joining them would
// erase empty arguments and change the launcher's argv contract.
const parseInvocation = (values, field = "agent invocation") => {
  if (values.length === 0) commandError(`${field} must include an executable`);
  if (values.length === 1) return parseCommand(values[0], field);
  const tokens = values.map((token, index) => validateToken(token, `${field}[${index}]`));
  const [agent, ...args] = tokens;
  if (agent === undefined) commandError(`${field} must include an executable`);
  return { agent, args };
};

const validateRoute = (value, field = "agent command") => {
  if (typeof value === "string") return parseCommand(value, field);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    commandError(`${field} must be a command string or {agent,args}`);
  }
  const agent = validateToken(value.agent, `${field}.agent`);
  if (!Array.isArray(value.args)) commandError(`${field}.args must be an array`);
  const args = value.args.map((arg, i) => validateToken(arg, `${field}.args[${i}]`));
  return { agent, args };
};

const normalizeRoute = (route) => {
  const valid = validateRoute(route);
  return typeof valid === "string" ? { agent: valid, args: [] } : { agent: valid.agent, args: [...valid.args] };
};

const routeDisplay = (route) => {
  const normalized = normalizeRoute(route);
  return [normalized.agent, ...normalized.args].join(" ");
};

const readJson = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseRoles = (raw) => {
  const out = {};
  const roles = raw?.roles;
  if (roles === undefined || typeof roles !== "object" || roles === null || Array.isArray(roles)) return out;
  for (const [role, entry] of Object.entries(roles)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { agent, args } = entry;
    try {
      if (typeof agent !== "string" || agent.length === 0) continue;
      out[role] = args === undefined
        ? parseCommand(agent, `workspace role '${role}'`)
        : validateRoute({ agent, args }, `workspace role '${role}'`);
    } catch {
      // malformed role = absent at this level; per-role chain falls through
    }
  }
  return out;
};

const parseTabLabel = (raw) => {
  const naming = raw?.naming;
  if (naming === undefined || typeof naming !== "object" || naming === null || Array.isArray(naming)) return undefined;
  const label = naming.tab_label;
  return typeof label === "string" && label.length > 0 ? label : undefined;
};

// L1 root: $TUT_PROJECT_ROOT ?? anchorCwd (caller-resolved) ?? skip (null).
const l1Root = (anchorCwd) => {
  const env = process.env.TUT_PROJECT_ROOT;
  if (env !== undefined && env.length > 0) return env;
  return typeof anchorCwd === "string" && anchorCwd.length > 0 ? anchorCwd : null;
};

const levels = (anchorCwd) => {
  const root = l1Root(anchorCwd);
  // Parity with src/workspace.ts defaultUserConfigDir: an empty-string
  // TUT_USER_CONFIG_DIR means UNSET (falls back to ~/.config/tut) — `??`
  // alone would treat "" as a real dir and silently read ./workspace.json
  // relative to cwd.
  const userEnv = process.env.TUT_USER_CONFIG_DIR;
  const userDir = userEnv !== undefined && userEnv.length > 0 ? userEnv : path.join(homedir(), ".config", "tut");
  const l1 = root !== null ? readJson(path.join(root, ".context-hub", "workspace.json")) : null;
  const l2 = readJson(path.join(userDir, "workspace.json"));
  return { roles: [parseRoles(l1), parseRoles(l2)], tabLabel: [parseTabLabel(l1), parseTabLabel(l2)] };
};

const resolveAgent = (role, anchorCwd) => {
  const lv = levels(anchorCwd);
  process.stdout.write(routeDisplay(lv.roles[0][role] ?? lv.roles[1][role] ?? DEFAULT_ROLES[role] ?? UNKNOWN_ROLE_AGENT));
};

const renderTabLabel = (role, task, agent, anchorCwd) => {
  const lv = levels(anchorCwd);
  const template = lv.tabLabel[0] ?? lv.tabLabel[1] ?? DEFAULT_TAB_LABEL;
  const out = template.replace(/\{(role|task|agent)\}/g, (_, key) =>
    key === "role" ? role : key === "task" ? task : agent,
  );
  process.stdout.write(out); // unknown placeholders preserved verbatim
};

const argv = process.argv.slice(2);
const sub = argv[0];
if (sub === "resolve" && argv.length >= 2 && argv.length <= 3) {
  resolveAgent(argv[1], argv[2]);
} else if (sub === "tab-label" && argv.length >= 4 && argv.length <= 5) {
  renderTabLabel(argv[1], argv[2], argv[3], argv[4]);
} else if (sub === "parse-command" && argv.length === 2) {
  try {
    const route = parseCommand(argv[1]);
    const normalized = normalizeRoute(route);
    process.stdout.write([normalized.agent, ...normalized.args].join("\n"));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "invalid command"}\n`);
    process.exit(1);
  }
} else if (sub === "parse-argv" && argv.length >= 2) {
  try {
    const tokens = argv.slice(1).map((token, index) => validateToken(token, `command argv[${index}]`));
    process.stdout.write(tokens.join("\n"));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "invalid command"}\n`);
    process.exit(1);
  }
} else if (sub === "parse-invocation" && argv.length >= 2) {
  try {
    const raw = argv.slice(1);
    const route = parseInvocation(raw);
    const normalized = normalizeRoute(route);
    process.stdout.write([normalized.agent, ...normalized.args].join("\n"));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "invalid command"}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write(
    "usage: tut-resolve.mjs resolve <role> [anchorCwd]   |   tut-resolve.mjs tab-label <role> <task> <agent> [anchorCwd]   |   tut-resolve.mjs parse-command <command>   |   tut-resolve.mjs parse-invocation <argv...>\n",
  );
  process.exit(1);
}

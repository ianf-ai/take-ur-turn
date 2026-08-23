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
//   resolve <role> [anchorCwd]            → prints the agent name
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
    const { agent } = entry;
    if (typeof agent === "string" && agent.length > 0) out[role] = agent; // legacy {label, agent} tolerated
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
  process.stdout.write(lv.roles[0][role] ?? lv.roles[1][role] ?? DEFAULT_ROLES[role] ?? UNKNOWN_ROLE_AGENT);
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
} else {
  process.stderr.write(
    "usage: tut-resolve.mjs resolve <role> [anchorCwd]   |   tut-resolve.mjs tab-label <role> <task> <agent> [anchorCwd]\n",
  );
  process.exit(1);
}

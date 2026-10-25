// Workspace three-level chain, per-role fallback, corruption tolerance and
// naming. Route fixtures exercise the authoritative TypeScript resolver;
// rendering fixtures use the built Node launch entry that consumes it.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROLES,
  DEFAULT_TAB_LABEL,
  resolveAgent,
  resolveAgentRoute,
  resolveTabLabelTemplate,
} from "../src/core/common/workspace.js";

const homeFixture = vi.hoisted(() => ({ directory: undefined as string | undefined }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeFixture.directory ?? actual.homedir() };
});

const run = promisify(execFile);
const SCRIPTS_DIR = path.resolve(import.meta.dirname, "../scripts");
const CLI = path.resolve(import.meta.dirname, "../dist/cli.js");
const FIXTURE_BIN = path.resolve(import.meta.dirname, "bin");

function launchEnv(l1: string, l2: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [FIXTURE_BIN, process.env.PATH ?? ""].join(path.delimiter),
    TUT_DRY_RUN: "1",
    TUT_HUB_URL: "http://127.0.0.1:1",
    TUT_HERDR_PANES: "[]",
    TUT_PROJECT_ROOT: l1,
    TUT_USER_CONFIG_DIR: l2,
  };
}

/** A workspace config file written under <dir>/.context-hub/ (L1 layout). */
function writeL1(root: string, body: unknown): string {
  const dir = path.join(root, ".context-hub");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "workspace.json");
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

/** A workspace config file written at the L2 layout (<dir>/workspace.json). */
function writeL2(dir: string, body: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "workspace.json");
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

describe("workspace chain fixtures", () => {
  let l1: string;
  let l2: string;

  beforeEach(() => {
    l1 = mkdtempSync(path.join(os.tmpdir(), "tut-ws-l1-"));
    l2 = mkdtempSync(path.join(os.tmpdir(), "tut-ws-l2-"));
  });

  afterEach(() => {
    rmSync(l1, { recursive: true, force: true });
    rmSync(l2, { recursive: true, force: true });
  });

  // --- resolveAgent: the chain (design acceptance ①) ----------------------------

  it("L1 hit: the project-level file wins", async () => {
    writeL1(l1, { roles: { executor: { agent: "l1-agent" } } });

    expect(await resolveAgent("executor", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe("l1-agent");
  });

  it("L1 missing the role → L2 hit; both missing → built-in defaults", async () => {
    writeL1(l1, { roles: { architect: { agent: "l1-agent" } } });
    writeL2(l2, { roles: { executor: { agent: "l2-agent" } } });

    expect(await resolveAgent("executor", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe("l2-agent");
    // reviewer: in neither file → DEFAULT_ROLES
    expect(await resolveAgent("reviewer", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe(
      DEFAULT_ROLES.reviewer,
    );
    // no files at all → defaults for every role
    expect(await resolveAgent("architect", undefined, { projectRoot: mkdtempSync(path.join(os.tmpdir(), "tut-ws-x-")), userConfigDir: mkdtempSync(path.join(os.tmpdir(), "tut-ws-y-")) })).toBe(
      DEFAULT_ROLES.architect,
    );
  });

  it("corrupt L1 = level absent (never-throw): falls to L2", async () => {
    mkdirSync(path.join(l1, ".context-hub"), { recursive: true });
    writeFileSync(path.join(l1, ".context-hub", "workspace.json"), "{ not json", "utf8");
    writeL2(l2, { roles: { executor: { agent: "l2-agent" } } });

    expect(await resolveAgent("executor", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe("l2-agent");
  });

  it("per-role fallback: L1 defines executor only → architect takes L2 (per-field, not whole-file)", async () => {
    writeL1(l1, { roles: { executor: { agent: "l1-agent" } } });
    writeL2(l2, { roles: { architect: { agent: "l2-agent" }, executor: { agent: "l2-agent" } } });

    expect(await resolveAgent("executor", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe("l1-agent");
    expect(await resolveAgent("architect", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe("l2-agent");
  });

  it("cast hit overrides the whole file chain; partial cast falls back per unlisted role", async () => {
    writeL1(l1, { roles: { executor: { agent: "l1-agent" } } });

    expect(await resolveAgent("executor", { executor: "cast-agent" }, { projectRoot: l1, userConfigDir: l2 })).toBe(
      "cast-agent",
    );
    expect(await resolveAgent("architect", { executor: "cast-agent" }, { projectRoot: l1, userConfigDir: l2 })).toBe(
      DEFAULT_ROLES.architect,
    );
  });

  it("legacy {label, agent} entries tolerated: only .agent is read; unknown role → codex fallback", async () => {
    writeL1(l1, { roles: { executor: { label: "exec", agent: "l1-agent", extra: true } } });

    expect(await resolveAgent("executor", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe("l1-agent");
    expect(await resolveAgent("boss", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe("codex");
  });

  it("TUT_USER_CONFIG_DIR overrides the default L2 dir", async () => {
    writeL2(l2, { roles: { executor: { agent: "l2-agent" } } });
    const prev = process.env.TUT_USER_CONFIG_DIR;
    process.env.TUT_USER_CONFIG_DIR = l2;
    try {
      // projectRoot = empty temp (no L1) → the env-pinned L2 must win.
      expect(await resolveAgent("executor", undefined, { projectRoot: mkdtempSync(path.join(os.tmpdir(), "tut-ws-p-")) })).toBe(
        "l2-agent",
      );
    } finally {
      if (prev === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prev;
    }
  });

  // --- naming.tab_label: independent chain (design acceptance ①) -----------------

  it("tab-label template: L1 → L2 → default, independent of roles", async () => {
    writeL1(l1, { roles: { executor: { agent: "l1-agent" } }, naming: { tab_label: "L1 {role}" } });
    writeL2(l2, { naming: { tab_label: "L2 {role}" } });

    expect(await resolveTabLabelTemplate({ projectRoot: l1, userConfigDir: l2 })).toBe("L1 {role}");
    // L1 has roles but NO naming → naming falls to L2 (per-field chains)
    writeL1(l1, { roles: { executor: { agent: "l1-agent" } } });
    expect(await resolveTabLabelTemplate({ projectRoot: l1, userConfigDir: l2 })).toBe("L2 {role}");
    // neither → default
    expect(await resolveTabLabelTemplate({ projectRoot: mkdtempSync(path.join(os.tmpdir(), "tut-ws-n1-")), userConfigDir: mkdtempSync(path.join(os.tmpdir(), "tut-ws-n2-")) })).toBe(
      DEFAULT_TAB_LABEL,
    );
  });

  it("a non-string/empty naming.tab_label counts as absent (never-throw)", async () => {
    writeL1(l1, { naming: { tab_label: "" } });
    writeL2(l2, { naming: { tab_label: 42 } });

    expect(await resolveTabLabelTemplate({ projectRoot: l1, userConfigDir: l2 })).toBe(DEFAULT_TAB_LABEL);
  });
});

// --- authoritative route fixtures ----------------------------------------------

describe("workspace route resolution", () => {
  const TRASH: string[] = [];
  afterEach(() => {
    for (const dir of TRASH.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function temp(label: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), `tut-route-${label}-`));
    TRASH.push(dir);
    return dir;
  }

  async function routes(l1Body: unknown | null, l2Body: unknown | null) {
    const l1 = temp("l1");
    const l2 = temp("l2");
    if (l1Body !== null) writeL1(l1, l1Body);
    if (l2Body !== null) writeL2(l2, l2Body);
    return Object.fromEntries(await Promise.all(
      ["architect", "executor", "reviewer", "boss"].map(async role =>
        [role, await resolveAgentRoute(role, undefined, { projectRoot: l1, userConfigDir: l2 })]),
    ));
  }

  it("vector: L1 full hit", async () => {
    expect(await routes(
      { roles: { architect: { agent: "a1" }, executor: { agent: "e1" }, reviewer: { agent: "r1" } } },
      { roles: { architect: { agent: "a2" } } },
    )).toEqual({ architect: "a1", executor: "e1", reviewer: "r1", boss: "codex" });
  });

  it("vector: L1 partial → per-role L2 fallback", async () => {
    expect(await routes(
      { roles: { executor: { agent: "e1" } } },
      { roles: { architect: { agent: "a2" }, executor: { agent: "e2" }, reviewer: { agent: "r2" } } },
    )).toEqual({ architect: "a2", executor: "e1", reviewer: "r2", boss: "codex" });
  });

  it("vector: corrupt L1 → L2", async () => {
    const l1 = temp("corrupt");
    const l2 = temp("fallback");
    mkdirSync(path.join(l1, ".context-hub"), { recursive: true });
    writeFileSync(path.join(l1, ".context-hub", "workspace.json"), "{ broken", "utf8");
    writeL2(l2, { roles: { executor: { agent: "l2x" } } });
    expect(await resolveAgentRoute("executor", undefined, { projectRoot: l1, userConfigDir: l2 })).toBe("l2x");
  });

  it("vector: both levels absent → built-in defaults, including unknown role", async () => {
    expect(await routes(null, null)).toEqual({ architect: "codex", executor: "pi", reviewer: "codex", boss: "codex" });
  });

  it("vector: legacy {label, agent} tolerated", async () => {
    expect(await routes({ roles: { executor: { label: "exec", agent: "legacy-agent" } } }, null))
      .toEqual({ architect: "codex", executor: "legacy-agent", reviewer: "codex", boss: "codex" });
  });

  it("vector: empty TUT_USER_CONFIG_DIR uses the home config, never a cwd-relative read", async () => {
    const fakeHome = temp("home");
    const root = temp("root");
    writeL2(path.join(fakeHome, ".config", "tut"), { roles: { executor: { agent: "home-l2" } } });
    writeL2(root, { roles: { executor: { agent: "stray-trap" } } });
    const prevCwd = process.cwd();
    homeFixture.directory = fakeHome;
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.chdir(root);
    process.env.TUT_USER_CONFIG_DIR = "";
    try {
      expect(await resolveAgentRoute("executor")).toBe("home-l2");
    } finally {
      process.chdir(prevCwd);
      homeFixture.directory = undefined;
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
    }
  });

  it("vector: launch routing honors TUT_PROJECT_ROOT over caller cwd", async () => {
    const winner = temp("winner");
    const loser = temp("loser");
    writeL1(winner, { roles: { executor: { agent: "pi" } } });
    writeL1(loser, { roles: { executor: { agent: "codex" } } });
    const { stdout } = await run(process.execPath, [CLI, "launch", "route-root", "executor"], {
      cwd: loser,
      env: launchEnv(winner, temp("empty")),
    });
    expect(stdout).toContain("(agent 'pi',");
  });
});

// --- tab-label rendering through the Node launch entry ----------------------------

describe("tab-label template rendering (Node launcher)", () => {
  const TRASH: string[] = [];
  afterEach(() => {
    for (const dir of TRASH.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function render(
    template: string | null,
    role: string,
    task: string,
    agent: string,
  ): Promise<string> {
    const l1 = mkdtempSync(path.join(os.tmpdir(), "tut-tpl-"));
    const l2 = mkdtempSync(path.join(os.tmpdir(), "tut-tpl-l2-"));
    TRASH.push(l1, l2);
    if (template !== null) writeL1(l1, { naming: { tab_label: template } });
    const { stdout } = await run(
      process.execPath,
      [CLI, "launch", task, role, agent],
      { env: launchEnv(l1, l2) },
    );
    const label = stdout.match(/DRY-RUN: birth: herdr tab create .* --label (.+) --no-focus/);
    expect(label).not.toBeNull();
    return label![1]!;
  }

  it("default template renders the three conventional roles", async () => {
    expect(await render(null, "architect", "t9", "pi")).toBe("TUT architect");
    expect(await render(null, "executor", "t9", "pi")).toBe("TUT executor");
    expect(await render(null, "reviewer", "t9", "pi")).toBe("TUT reviewer");
  });

  it("placeholders {role} / {task} / {agent} all render; repeated occurrences too", async () => {
    expect(await render("{role}·{task}·{agent}", "executor", "fix-9", "pi")).toBe("executor·fix-9·pi");
    expect(await render("{role}/{role}", "executor", "t", "pi")).toBe("executor/executor");
  });

  it("first round renders the REAL task_id — no '-' → 'new' literal branch remains", async () => {
    // The first round after tut create is an ordinary round, so the
    // template sees a real task_id from round one; the retired kickoff
    // special case (task "-" → literal "new") must stay gone.
    expect(await render("TUT {task} · {role}", "architect", "kick-one", "pi")).toBe("TUT kick-one · architect");
    expect(await render("{task}", "architect", "kick-one", "pi")).toBe("kick-one");
  });

  it("unknown placeholders are preserved verbatim", async () => {
    expect(await render("TUT {role} {unknown}", "executor", "t1", "pi")).toBe("TUT executor {unknown}");
  });
});

// --- retired workspace contracts -------------------------------------------------

describe("retired workspace contracts", () => {
  it("scripts/routes.json is retired (deleted, not merely unread)", () => {
    expect(existsSync(path.join(SCRIPTS_DIR, "routes.json"))).toBe(false);
  });

  it("workspace.ts exports no label concept (resolveRole / WorkspaceRole retired)", async () => {
    const ws = (await import("../src/core/common/workspace.js")) as unknown as Record<string, unknown>;
    expect(ws.resolveRole).toBeUndefined();
    expect(ws.KNOWN_ROLES).toBeDefined();
    // DEFAULT_ROLES slimmed to role → agent (string values, no seat objects)
    for (const agent of Object.values(DEFAULT_ROLES)) expect(typeof agent).toBe("string");
  });
});

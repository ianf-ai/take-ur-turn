// Workspace three-level chain + naming: the resolution
// chain (L1 project → L2 user → built-in defaults), per-field fallback,
// never-throw corruption tolerance, the tab-label template rendering
// (scripts/tut-resolve.mjs), and — the parity pin — the SAME fixture vectors
// asserted against BOTH implementations (src/workspace.ts resolveAgent and
// `node scripts/tut-resolve.mjs resolve`) so the bash/TS dual-implementation
// world cannot drift. The repo's seed file (scripts/workspace.json) is
// asserted to exist and be valid JSON — its CONTENT is shape-example only
// and never asserted (runtime reads nothing from the repo).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ROLES,
  DEFAULT_TAB_LABEL,
  resolveAgent,
  resolveTabLabelTemplate,
} from "../src/workspace.js";

const run = promisify(execFile);
const SCRIPTS_DIR = path.resolve(import.meta.dirname, "../scripts");
const TUT_RESOLVE = path.join(SCRIPTS_DIR, "tut-resolve.mjs");

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

// --- parity: same fixture vectors, TS resolveAgent vs tut-resolve.mjs --------------
// The chain exists twice by necessity (bash-side launch.sh cannot run the TS
// build; single-file unification was rejected) — parity is pinned HERE: the
// same vectors must produce identical output on both sides.

describe("parity: src/workspace.ts resolveAgent ≡ scripts/tut-resolve.mjs resolve", () => {
  const TRASH: string[] = [];
  afterEach(() => {
    for (const dir of TRASH.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** One fixture pair → both implementations' answers for every role. */
  async function bothSides(l1Body: unknown | null, l2Body: unknown | null): Promise<Record<string, [string, string]>> {
    const l1 = mkdtempSync(path.join(os.tmpdir(), "tut-parity-l1-"));
    const l2 = mkdtempSync(path.join(os.tmpdir(), "tut-parity-l2-"));
    TRASH.push(l1, l2);
    if (l1Body !== null) writeL1(l1, l1Body);
    if (l2Body !== null) writeL2(l2, l2Body);

    const out: Record<string, [string, string]> = {};
    for (const role of ["architect", "executor", "reviewer", "boss"]) {
      const ts = await resolveAgent(role, undefined, { projectRoot: l1, userConfigDir: l2 });
      const sh = (
        await run(process.execPath, [TUT_RESOLVE, "resolve", role], {
          env: { ...process.env, TUT_PROJECT_ROOT: l1, TUT_USER_CONFIG_DIR: l2 },
        })
      ).stdout;
      out[role] = [ts, sh];
    }
    return out;
  }

  it("vector: L1 full hit", async () => {
    const sides = await bothSides(
      { roles: { architect: { agent: "a1" }, executor: { agent: "e1" }, reviewer: { agent: "r1" } } },
      { roles: { architect: { agent: "a2" } } },
    );
    for (const [ts, sh] of Object.values(sides)) expect(sh).toBe(ts);
    expect(sides.architect?.[0]).toBe("a1");
  });

  it("vector: L1 partial → per-role L2 fallback", async () => {
    const sides = await bothSides(
      { roles: { executor: { agent: "e1" } } },
      { roles: { architect: { agent: "a2" }, executor: { agent: "e2" }, reviewer: { agent: "r2" } } },
    );
    for (const [ts, sh] of Object.values(sides)) expect(sh).toBe(ts);
    expect(sides.architect?.[0]).toBe("a2");
    expect(sides.executor?.[0]).toBe("e1");
  });

  it("vector: corrupt L1 → L2", async () => {
    const l1 = mkdtempSync(path.join(os.tmpdir(), "tut-parity-c1-"));
    const l2 = mkdtempSync(path.join(os.tmpdir(), "tut-parity-c2-"));
    TRASH.push(l1, l2);
    mkdirSync(path.join(l1, ".context-hub"), { recursive: true });
    writeFileSync(path.join(l1, ".context-hub", "workspace.json"), "{ broken", "utf8");
    writeL2(l2, { roles: { executor: { agent: "l2x" } } });

    const ts = await resolveAgent("executor", undefined, { projectRoot: l1, userConfigDir: l2 });
    const sh = (
      await run(process.execPath, [TUT_RESOLVE, "resolve", "executor"], {
        env: { ...process.env, TUT_PROJECT_ROOT: l1, TUT_USER_CONFIG_DIR: l2 },
      })
    ).stdout;
    expect(sh).toBe(ts);
    expect(ts).toBe("l2x");
  });

  it("vector: both levels absent → DEFAULT_ROLES values identical on both sides (incl. unknown role)", async () => {
    const sides = await bothSides(null, null);
    for (const [ts, sh] of Object.values(sides)) expect(sh).toBe(ts);
    expect(sides.architect?.[0]).toBe("codex");
    expect(sides.executor?.[0]).toBe("pi");
    expect(sides.reviewer?.[0]).toBe("codex");
    expect(sides.boss?.[0]).toBe("codex"); // unknown-role fallback, parity-pinned
  });

  it("vector: legacy {label, agent} tolerated identically", async () => {
    const sides = await bothSides(
      { roles: { executor: { label: "exec", agent: "legacy-agent" } } },
      null,
    );
    for (const [ts, sh] of Object.values(sides)) expect(sh).toBe(ts);
    expect(sides.executor?.[0]).toBe("legacy-agent");
  });

  it("vector: TUT_USER_CONFIG_DIR empty string — both sides treat it as UNSET (HOME fallback), never a cwd-relative read", async () => {
    // The trap: a stray ./workspace.json next to the resolution root — exactly
    // what the old mjs `??` bug silently read when the env var was "" (L2 =
    // path.join("", "workspace.json")). Empty must mean unset on BOTH sides:
    // L2 falls back to <HOME>/.config/tut.
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "tut-parity-home-"));
    const root = mkdtempSync(path.join(os.tmpdir(), "tut-parity-root-"));
    TRASH.push(fakeHome, root);
    mkdirSync(path.join(fakeHome, ".config", "tut"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".config", "tut", "workspace.json"), JSON.stringify({ roles: { executor: { agent: "home-l2" } } }));
    writeFileSync(path.join(root, "workspace.json"), JSON.stringify({ roles: { executor: { agent: "stray-trap" } } })); // the bug's file

    const prevCwd = process.cwd();
    const prevHome = process.env.HOME;
    const prevUserDir = process.env.TUT_USER_CONFIG_DIR;
    process.chdir(root); // TS side: default projectRoot = cwd (L1 = root/.context-hub — absent)
    process.env.HOME = fakeHome; // os.homedir() reads $HOME at call time (POSIX)
    process.env.TUT_USER_CONFIG_DIR = ""; // the degenerate input under test
    try {
      const ts = await resolveAgent("executor"); // no options: defaultUserConfigDir() reads the env
      const sh = (
        await run(process.execPath, [TUT_RESOLVE, "resolve", "executor"], {
          env: { ...process.env, HOME: fakeHome, TUT_PROJECT_ROOT: root, TUT_USER_CONFIG_DIR: "" },
          cwd: root,
        })
      ).stdout;
      expect(sh).toBe(ts); // parity: identical output on both sides
      expect(ts).toBe("home-l2"); // empty = unset → HOME L2, NOT the stray cwd file
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserDir === undefined) delete process.env.TUT_USER_CONFIG_DIR;
      else process.env.TUT_USER_CONFIG_DIR = prevUserDir;
    }
  });

  it("vector: TUT_PROJECT_ROOT wins over the anchor-cwd positional", async () => {
    const winner = mkdtempSync(path.join(os.tmpdir(), "tut-parity-w-"));
    const loser = mkdtempSync(path.join(os.tmpdir(), "tut-parity-l-"));
    TRASH.push(winner, loser);
    writeL1(winner, { roles: { executor: { agent: "winner" } } });
    writeL1(loser, { roles: { executor: { agent: "loser" } } });

    const sh = (
      await run(process.execPath, [TUT_RESOLVE, "resolve", "executor", loser], {
        env: { ...process.env, TUT_PROJECT_ROOT: winner, TUT_USER_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "tut-parity-e-")) },
      })
    ).stdout;
    expect(sh).toBe("winner");
  });
});

// --- tab-label rendering (tut-resolve.mjs tab-label) -------------------------------

describe("tab-label template rendering (tut-resolve.mjs)", () => {
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
      [TUT_RESOLVE, "tab-label", role, task, agent],
      { env: { ...process.env, TUT_PROJECT_ROOT: l1, TUT_USER_CONFIG_DIR: l2 } },
    );
    return stdout;
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

// --- seed file + retired artifacts (design acceptance ②/④) -------------------------

describe("repo seed & retired artifacts", () => {
  it("scripts/workspace.json exists and is valid JSON (the ONLY thing asserted about the seed)", () => {
    const file = path.join(SCRIPTS_DIR, "workspace.json");
    expect(existsSync(file)).toBe(true);
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
  });

  it("scripts/routes.json is retired (deleted, not merely unread)", () => {
    expect(existsSync(path.join(SCRIPTS_DIR, "routes.json"))).toBe(false);
  });

  it("workspace.ts exports no label concept (resolveRole / WorkspaceRole retired)", async () => {
    const ws = (await import("../src/workspace.js")) as unknown as Record<string, unknown>;
    expect(ws.resolveRole).toBeUndefined();
    expect(ws.KNOWN_ROLES).toBeDefined();
    // DEFAULT_ROLES slimmed to role → agent (string values, no seat objects)
    for (const agent of Object.values(DEFAULT_ROLES)) expect(typeof agent).toBe("string");
  });
});

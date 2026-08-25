import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { main, parseArgs, SKILL_ROLES, USAGE } from "../src/cli.js";

// tut skill / tut init — the path-free delivery pair: a subcommand that
// prints a role skill (module-relative ../skills, zero network) and a
// subcommand that maintains the TUT marker block in a project's AGENTS.md
// (idempotent). Parse layer + real handler through main(); init tests chdir
// into temp dirs (cwd discipline, the same pattern as test/cli-up.test.ts).

const REPO = path.resolve(import.meta.dirname, "..");
const SAVED_CWD = process.cwd();

/** Capture process stdout/stderr into strings for the duration of a handler run. */
function captureIo(): { out: () => string; err: () => string; restore: () => void } {
  let outText = "";
  let errText = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    outText += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errText += String(chunk);
    return true;
  });
  return { out: () => outText, err: () => errText, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

function tempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "tut-skill-init-"));
}

afterEach(() => {
  process.chdir(SAVED_CWD);
});

// --- parse layer -----------------------------------------------------------------

describe("skill / init: parse layer", () => {
  it("each shipped role parses; SKILL_ROLES is the four-role canon", () => {
    expect([...SKILL_ROLES]).toEqual(["host", "architect", "executor", "reviewer"]);
    for (const role of SKILL_ROLES) {
      expect(parseArgs(["skill", role])).toEqual({ command: "skill", role });
    }
  });

  it("missing role lists the available values", () => {
    expect(parseArgs(["skill"])).toEqual({
      command: "usage",
      error: "skill requires a role: host | architect | executor | reviewer",
    });
  });

  it("illegal role is rejected with the available values", () => {
    expect(parseArgs(["skill", "foo"])).toEqual({
      command: "usage",
      error: "skill role must be host | architect | executor | reviewer, got: foo",
    });
  });

  it("extra positionals and flags are unknown (skill/init take no flags)", () => {
    expect(parseArgs(["skill", "host", "extra"])).toEqual({ command: "usage", error: "unexpected argument: extra" });
    expect(parseArgs(["skill", "host", "--json"])).toEqual({ command: "usage", error: "unknown argument: --json" });
    expect(parseArgs(["init"])).toEqual({ command: "init" });
    expect(parseArgs(["init", "x"])).toEqual({ command: "usage", error: "unexpected argument: x" });
    expect(parseArgs(["init", "--dry-run"])).toEqual({ command: "usage", error: "unknown argument: --dry-run" });
  });

  it("USAGE documents both subcommands", () => {
    expect(USAGE).toContain("tut skill");
    expect(USAGE).toContain("tut init");
  });
});

// --- tut skill: module-relative, zero network -------------------------------------

describe("skill handler", () => {
  it.each([...SKILL_ROLES])("skill %s prints the shipped file verbatim", async (role) => {
    const io = captureIo();
    try {
      const code = await main(["skill", role]);
      expect(code).toBe(0);
      const expected = readFileSync(path.join(REPO, "skills", `${role}.md`), "utf8");
      expect(io.out()).toBe(expected.endsWith("\n") ? expected : `${expected}\n`);
    } finally {
      io.restore();
    }
  });

  it("resolution is module-relative, not cwd-relative (runs from any directory)", async () => {
    const far = tempProject();
    process.chdir(far);
    const io = captureIo();
    try {
      const code = await main(["skill", "host"]);
      expect(code).toBe(0);
      const expected = readFileSync(path.join(REPO, "skills", "host.md"), "utf8");
      expect(io.out()).toBe(expected.endsWith("\n") ? expected : `${expected}\n`);
    } finally {
      io.restore();
    }
  });
});

// --- tut init: idempotent AGENTS.md block ------------------------------------------

describe("init handler", () => {
  it("creates AGENTS.md when absent: markers, trigger phrase, tut skill host", async () => {
    const dir = tempProject();
    process.chdir(dir);
    const io = captureIo();
    try {
      const code = await main(["init"]);
      expect(code).toBe(0);
      expect(io.out()).toContain("created");
      const text = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
      expect(text).toContain("<!-- TUT:BEGIN -->");
      expect(text).toContain("<!-- TUT:END -->");
      expect(text).toContain("担任 TUT Host／全程驱动");
      expect(text).toContain("`tut skill host`");
      expect(text).toContain("启动器");
    } finally {
      io.restore();
    }
  });

  it("appends to an existing AGENTS.md without markers, preserving content", async () => {
    const dir = tempProject();
    writeOriginal(dir, "# Project Notes\n\nSome conventions.\n\n\n");
    process.chdir(dir);
    const io = captureIo();
    try {
      const code = await main(["init"]);
      expect(code).toBe(0);
      expect(io.out()).toContain("appended");
      const text = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
      // Original prose intact (trailing blank lines normalized to one
      // separator gap), block appended exactly once, file ends with newline.
      expect(text).toContain("# Project Notes\n\nSome conventions.\n\n<!-- TUT:BEGIN -->");
      expect(countBlocks(text)).toBe(1);
      expect(text.endsWith("<!-- TUT:END -->\n")).toBe(true);
    } finally {
      io.restore();
    }
  });

  it("re-running is idempotent: existing marked block refreshed in place, byte-stable", async () => {
    const dir = tempProject();
    process.chdir(dir);
    const io = captureIo();
    try {
      await main(["init"]);
      const first = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
      const code = await main(["init"]);
      expect(code).toBe(0);
      expect(io.out()).toContain("refreshed");
      const second = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
      expect(second).toBe(first);
      expect(countBlocks(second)).toBe(1);
    } finally {
      io.restore();
    }
  });

  it("a stale marked block (old wording) is refreshed to the current one", async () => {
    const dir = tempProject();
    const stale = "# Notes\n\n<!-- TUT:BEGIN -->\nold wording — no trigger phrase\n<!-- TUT:END -->\n";
    writeOriginal(dir, stale);
    process.chdir(dir);
    const io = captureIo();
    try {
      const code = await main(["init"]);
      expect(code).toBe(0);
      const text = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
      expect(countBlocks(text)).toBe(1);
      expect(text).not.toContain("old wording");
      expect(text).toContain("担任 TUT Host／全程驱动");
      // Prose outside the markers is untouched.
      expect(text.startsWith("# Notes\n\n<!-- TUT:BEGIN -->")).toBe(true);
    } finally {
      io.restore();
    }
  });
});

function writeOriginal(dir: string, text: string): void {
  writeFileSync(path.join(dir, "AGENTS.md"), text, "utf8");
}

function countBlocks(text: string): number {
  return (text.match(/<!-- TUT:BEGIN -->/g) ?? []).length;
}

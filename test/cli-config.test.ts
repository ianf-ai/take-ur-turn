import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// tut config get/set — parse layer first; handler behavior below against a
// real temp-dir config.json (no mocks: the handler is a direct fs consumer
// like tut assign, deliberately not a Hub client).

import { main, parseArgs } from "../src/cli.js";

// --- parse -----------------------------------------------------------------------

describe("config (parse)", () => {
  it("get parses with default root", () => {
    expect(parseArgs(["config", "get", "flow_mode"])).toEqual({
      command: "config",
      action: "get",
      key: "flow_mode",
      root: ".context-hub",
    });
  });

  it("set parses key and value (comma-lists stay one positional)", () => {
    expect(parseArgs(["config", "set", "auto.launch_roles", "executor,reviewer"])).toEqual({
      command: "config",
      action: "set",
      key: "auto.launch_roles",
      value: "executor,reviewer",
      root: ".context-hub",
    });
  });

  it("set accepts an empty-string value (the clear-a-list form)", () => {
    expect(parseArgs(["config", "set", "auto.launch_roles", ""])).toEqual({
      command: "config",
      action: "set",
      key: "auto.launch_roles",
      value: "",
      root: ".context-hub",
    });
  });

  it("--root accepts both flag forms", () => {
    expect(parseArgs(["config", "get", "flow_mode", "--root", "/tmp/x"])).toEqual({
      command: "config",
      action: "get",
      key: "flow_mode",
      root: "/tmp/x",
    });
    expect(parseArgs(["config", "get", "flow_mode", "--root=/tmp/x"])).toEqual({
      command: "config",
      action: "get",
      key: "flow_mode",
      root: "/tmp/x",
    });
  });

  it("unknown action rejected", () => {
    expect(parseArgs(["config", "edit", "flow_mode"])).toEqual({
      command: "usage",
      error: "config action must be get or set, got: edit",
    });
  });

  it("missing key rejected", () => {
    expect(parseArgs(["config", "get"]).command).toBe("usage");
  });

  it("set missing value rejected", () => {
    expect(parseArgs(["config", "set", "flow_mode"]).command).toBe("usage");
  });

  it("get extra positional rejected", () => {
    expect(parseArgs(["config", "get", "flow_mode", "auto"]).command).toBe("usage");
  });

  it("unknown flag rejected (config is not a Hub client — no --url)", () => {
    expect(parseArgs(["config", "get", "flow_mode", "--url", "http://x:1"]).command).toBe("usage");
  });
});

// --- handler ---------------------------------------------------------------------

let tmp: string;
let root: string;
let io: { out: () => string; err: () => string; restore: () => void };

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-cli-config-"));
  root = path.join(tmp, ".context-hub");
  mkdirSync(root, { recursive: true });
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
  io = { out: () => outText, err: () => errText, restore: () => { out.mockRestore(); err.mockRestore(); } };
});

afterEach(() => {
  io.restore();
  rmSync(tmp, { recursive: true, force: true });
});

function configFile(): string {
  return path.join(root, "config.json");
}

describe("config get (effective values)", () => {
  it("missing config reads as defaults: manual / empty whitelist / notify unset", async () => {
    expect(await main(["config", "get", "flow_mode", "--root", root])).toBe(0);
    expect(await main(["config", "get", "auto.launch_roles", "--root", root])).toBe(0);
    expect(await main(["config", "get", "notify", "--root", root])).toBe(0);
    // one cumulative capture: manual, empty whitelist (empty line), unset
    expect(io.out()).toBe("manual\n\nunset\n");
  });

  it("reads real values back, including nested auto.launch_roles", async () => {
    writeFileSync(
      configFile(),
      JSON.stringify({ flow_mode: "auto", auto: { launch_roles: ["executor", "reviewer"] } }),
      "utf8",
    );

    expect(await main(["config", "get", "flow_mode", "--root", root])).toBe(0);
    expect(io.out()).toContain("auto");
  });

  it("get notify prints compact JSON when present", async () => {
    writeFileSync(configFile(), JSON.stringify({ flow_mode: "manual", notify: { channels: ["bell"] } }), "utf8");

    expect(await main(["config", "get", "notify", "--root", root])).toBe(0);
    expect(io.out()).toBe(JSON.stringify({ channels: ["bell"] }) + "\n");
  });

  it("corrupt config refuses to answer (exit 1, nothing guessed)", async () => {
    writeFileSync(configFile(), "{ not json", "utf8");

    expect(await main(["config", "get", "flow_mode", "--root", root])).toBe(1);
    expect(io.err()).toContain("unreadable or corrupt");
    expect(io.out()).toBe("");
  });

  it("unknown key lists the available keys and their value domains", async () => {
    expect(await main(["config", "get", "banana", "--root", root])).toBe(1);
    expect(io.err()).toContain("unknown key: banana");
    expect(io.err()).toContain("available keys: flow_mode");
    expect(io.err()).toContain("auto.launch_roles");
  });
});

describe("config set (validated, key-preserving writes)", () => {
  it("launch_mode defaults without writes, validates set and preserves siblings", async () => {
    expect(await main(["config", "get", "launch_mode", "--root", root])).toBe(0);
    expect(io.out()).toBe("tui\n");
    expect(existsSync(configFile())).toBe(false);
    writeFileSync(configFile(), JSON.stringify({ flow_mode: "auto", auto: { launch_roles: ["executor"], keep: true }, future: 3 }));
    expect(await main(["config", "set", "launch_mode", "tui", "--root", root])).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ launch_mode: "tui", future: 3, auto: { keep: true } });
    const before = readFileSync(configFile(), "utf8");
    expect(await main(["config", "set", "launch_mode", "bad", "--root", root])).toBe(1);
    expect(readFileSync(configFile(), "utf8")).toBe(before);
    writeFileSync(configFile(), JSON.stringify({ flow_mode: "auto", launch_mode: null }));
    expect(await main(["config", "get", "launch_mode", "--root", root])).toBe(1);
  });

  it("launch_mode get echoes explicit tui and headless round-trips", async () => {
    writeFileSync(configFile(), JSON.stringify({ flow_mode: "manual", launch_mode: "tui" }));
    expect(await main(["config", "get", "launch_mode", "--root", root])).toBe(0);
    expect(io.out()).toBe("tui\n");
    expect(await main(["config", "set", "launch_mode", "headless", "--root", root])).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ flow_mode: "manual", launch_mode: "headless" });
    expect(await main(["config", "get", "launch_mode", "--root", root])).toBe(0);
    expect(io.out()).toContain("config: launch_mode = headless");
    expect(io.out().endsWith("headless\n")).toBe(true);
  });

  it("usage_audit defaults off without writing and round-trips on/off without losing keys", async () => {
    expect(await main(["config", "get", "usage_audit", "--root", root])).toBe(0);
    expect(io.out()).toBe("off\n");
    writeFileSync(configFile(), JSON.stringify({ flow_mode: "manual", custom: { keep: true } }));
    expect(await main(["config", "set", "usage_audit", "on", "--root", root])).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ flow_mode: "manual", custom: { keep: true }, usage_audit: "on" });
    expect(await main(["config", "get", "usage_audit", "--root", root])).toBe(0);
    expect(io.out()).toContain("on\n");
    expect(await main(["config", "set", "usage_audit", "off", "--root", root])).toBe(0);
    const before = readFileSync(configFile(), "utf8");
    expect(await main(["config", "set", "usage_audit", "yes", "--root", root])).toBe(1);
    expect(readFileSync(configFile(), "utf8")).toBe(before);
    writeFileSync(configFile(), JSON.stringify({ flow_mode: "manual", usage_audit: "invalid" }));
    expect(await main(["config", "get", "usage_audit", "--root", root])).toBe(1);
  });

  it("auto.remediate reports the effective defaults and the saved switch", async () => {
    expect(await main(["config", "get", "auto.remediate", "--root", root])).toBe(0);
    expect(io.out()).toContain("off");
    await main(["config", "set", "flow_mode", "auto", "--root", root]);
    await main(["config", "get", "auto.remediate", "--root", root]);
    expect(io.out()).toContain("enter-repress");
    expect(await main(["config", "set", "auto.remediate", "off", "--root", root])).toBe(0);
    expect(io.out()).toContain("auto.remediate = off");
    expect(JSON.parse(readFileSync(configFile(), "utf8")).auto.remediate).toBe("off");
  });
  it("set flow_mode on a missing config creates the file", async () => {
    expect(await main(["config", "set", "flow_mode", "auto", "--root", root])).toBe(0);
    expect(io.out()).toContain("flow_mode = auto");

    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ flow_mode: "auto" });
  });

  it("set auto.launch_roles writes the nested key and round-trips through get", async () => {
    expect(await main(["config", "set", "auto.launch_roles", "executor, reviewer", "--root", root])).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({
      flow_mode: "manual",
      auto: { launch_roles: ["executor", "reviewer"] },
    });

    expect(await main(["config", "get", "auto.launch_roles", "--root", root])).toBe(0);
    expect(io.out()).toContain("executor,reviewer");
  });

  it("set \"\" clears the whitelist (the conservative default)", async () => {
    await main(["config", "set", "auto.launch_roles", "executor", "--root", root]);
    expect(await main(["config", "set", "auto.launch_roles", "", "--root", root])).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8")).auto).toEqual({ launch_roles: [] });
  });

  it("preserves unknown keys and auto siblings (key-preserving RMW)", async () => {
    writeFileSync(
      configFile(),
      JSON.stringify({
        flow_mode: "manual",
        notify: { channels: ["bell"] },
        future_key: 42,
        auto: { launch_roles: ["executor"], extra_sibling: true },
      }),
      "utf8",
    );

    expect(await main(["config", "set", "flow_mode", "auto", "--root", root])).toBe(0);
    expect(await main(["config", "set", "auto.launch_roles", "reviewer", "--root", root])).toBe(0);

    const after = JSON.parse(readFileSync(configFile(), "utf8"));
    expect(after.flow_mode).toBe("auto");
    expect(after.notify).toEqual({ channels: ["bell"] });
    expect(after.future_key).toBe(42);
    expect(after.auto).toEqual({ launch_roles: ["reviewer"], extra_sibling: true });
  });

  it("invalid flow_mode value rejected with the legal domain", async () => {
    expect(await main(["config", "set", "flow_mode", "banana", "--root", root])).toBe(1);
    expect(io.err()).toContain('invalid value for flow_mode: "banana"');
    expect(io.err()).toContain('"manual" | "auto"');
    expect(existsSync(configFile())).toBe(false); // nothing written
  });

  it("invalid role rejected with the legal role list (roles, not agents)", async () => {
    expect(await main(["config", "set", "auto.launch_roles", "executor,codex", "--root", root])).toBe(1);
    expect(io.err()).toContain('invalid role in auto.launch_roles: "codex"');
    expect(io.err()).toContain("architect|executor|reviewer");
    // The error teaches the way out: format + example (agents are the
    // classic wrong value here).
    expect(io.err()).toContain("comma-separated bare role names");
    expect(io.err()).toContain("e.g. architect,executor,reviewer");
    expect(existsSync(configFile())).toBe(false);
  });

  it("unknown key rejected with the available-keys hint", async () => {
    expect(await main(["config", "set", "notify", "x", "--root", root])).toBe(1);
    expect(io.err()).toContain("notify is not settable here");

    expect(await main(["config", "set", "banana", "x", "--root", root])).toBe(1);
    expect(io.err()).toContain("unknown key: banana");
    expect(io.err()).toContain("available keys:");
  });

  it("corrupt config is never clobbered (exit 1, file unchanged)", async () => {
    writeFileSync(configFile(), "{ not json", "utf8");

    expect(await main(["config", "set", "flow_mode", "auto", "--root", root])).toBe(1);
    expect(io.err()).toContain("unreadable or corrupt");
    expect(readFileSync(configFile(), "utf8")).toBe("{ not json");
  });
});

describe("config review_standards", () => {
  it.each(["missing directory", "missing file", "missing key", "empty value"])("is disabled with no writes for %s", async (scenario) => {
    if (scenario === "missing directory") rmSync(root, { recursive: true });
    if (scenario === "missing key" || scenario === "empty value") {
      writeFileSync(configFile(), JSON.stringify({ flow_mode: "manual", ...(scenario === "empty value" ? { review_standards: "" } : {}) }));
    }
    const before = existsSync(configFile()) ? readFileSync(configFile(), "utf8") : undefined;
    expect(await main(["config", "get", "review_standards", "--root", root])).toBe(0);
    expect(io.out()).toBe("\n");
    expect(io.err()).toBe("");
    if (before === undefined) expect(existsSync(configFile())).toBe(false);
    else expect(readFileSync(configFile(), "utf8")).toBe(before);
    if (scenario === "missing directory") expect(existsSync(root)).toBe(false);
  });

  it.each([
    ["not-created.txt", "not-created.txt"],
    [" standards/评审 标准.md , /shared/team.txt ", "standards/评审 标准.md,/shared/team.txt"],
    ["", ""], ["   ", ""],
  ])("sets and gets %j while preserving unrelated configuration", async (raw, normalized) => {
    const original = { flow_mode: "auto", auto: { launch_roles: ["reviewer"], extra: 1 }, notify: { channels: ["bell"] }, future: true, review_standards: "old.txt" };
    writeFileSync(configFile(), JSON.stringify(original));
    expect(await main(["config", "set", "review_standards", raw, "--root", root])).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ ...original, review_standards: normalized });
    const setOutput = io.out();
    expect(setOutput).toContain(`review_standards = ${normalized} (`);
    expect(await main(["config", "get", "review_standards", "--root", root])).toBe(0);
    expect(io.out().slice(setOutput.length)).toBe(`${normalized}\n`);
    expect(io.err()).toBe("");
  });

  it.each([",a", "a,", "a,,b", "a, ,b", "\ta", "a\n", "a\0b", "a\x1fb", "a\x7fb"])("rejects set %j without creating or changing config", async (raw) => {
    rmSync(root, { recursive: true });
    expect(await main(["config", "set", "review_standards", raw, "--root", root])).toBe(1);
    expect(existsSync(root)).toBe(false);
    mkdirSync(root);
    const original = '{"flow_mode":"auto","review_standards":"keep.txt"}\n';
    writeFileSync(configFile(), original);
    expect(await main(["config", "set", "review_standards", raw, "--root", root])).toBe(1);
    expect(readFileSync(configFile(), "utf8")).toBe(original);
    expect(io.out()).toBe("");
    expect(io.err()).toContain("review_standards");
    expect(io.err()).toContain("comma-separated non-empty file paths");
    expect(io.err()).toContain('"" disables');
  });

  it.each([null, [], {}, true, 7, ",a", "a,", "a,,b", "a, ,b", "\ta", "a\n", "a\0b", "a\x7fb"])("rejects get of hand-written %j without treating it as disabled", async (raw) => {
    const original = JSON.stringify({ flow_mode: "auto", review_standards: raw });
    writeFileSync(configFile(), original);
    expect(await main(["config", "get", "review_standards", "--root", root])).toBe(1);
    expect(io.out()).toBe("");
    expect(io.err()).toContain("invalid value for review_standards");
    expect(io.err()).toContain("e.g. standards/review.md,/shared/team.txt");
    expect(io.err()).toContain('"" disables');
    expect(readFileSync(configFile(), "utf8")).toBe(original);
    // Only this key's consumer rejects the malformed optional value.
    expect(await main(["config", "get", "flow_mode", "--root", root])).toBe(0);
    expect(io.out()).toBe("auto\n");
  });

  it.each([20479, 20480, 20481])("warns only above 20KB (%i bytes), preserving output and config", async (size) => {
    const standard = path.join(tmp, "评审 标准.md");
    writeFileSync(standard, Buffer.alloc(size, "a"));
    // Relative paths resolve against the checkout cwd, independent of --root.
    const value = `${path.relative(process.cwd(), standard)},${path.join(tmp, "missing.md")}`;
    const original = JSON.stringify({ flow_mode: "manual", review_standards: value });
    writeFileSync(configFile(), original);
    expect(await main(["config", "get", "review_standards", "--root", root])).toBe(0);
    expect(io.out()).toBe(`${value}\n`);
    expect(readFileSync(configFile(), "utf8")).toBe(original);
    if (size > 20480) {
      expect(io.err().trim().split("\n")).toHaveLength(1);
      expect(io.err()).toContain("exceeds 20KB");
      expect(io.err()).toContain(path.relative(process.cwd(), standard));
    } else expect(io.err()).toBe("");
  });

  it("checks absolute standard paths without reading directories as standards", async () => {
    const standard = path.join(tmp, "large.md");
    writeFileSync(standard, "大".repeat(7000));
    const value = `${standard},${tmp}`;
    writeFileSync(configFile(), JSON.stringify({ flow_mode: "manual", review_standards: value }));
    expect(await main(["config", "get", "review_standards", "--root", root])).toBe(0);
    expect(io.out()).toBe(`${value}\n`);
    expect(io.err().trim().split("\n")).toHaveLength(1);
    expect(io.err()).toContain(standard);
  });

  it("normalizes a hand-written list on get without rewriting it", async () => {
    const original = JSON.stringify({ flow_mode: "manual", review_standards: " a.txt , 评审 标准 " });
    writeFileSync(configFile(), original);
    expect(await main(["config", "get", "review_standards", "--root", root])).toBe(0);
    expect(io.out()).toBe("a.txt,评审 标准\n");
    expect(readFileSync(configFile(), "utf8")).toBe(original);
  });
});

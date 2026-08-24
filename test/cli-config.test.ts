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

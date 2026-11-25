import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  autoSectionOf,
  configKeyDomain,
  CONFIG_KEYS,
  ensureConfig,
  parseConfigValue,
  readConfig,
  readConfigFile,
  readFlowMode,
  readLaunchMode,
  readPowerMode,
  readPowerModeForSwitch,
  writeConfigKey,
  writeFlowMode,
  type Config,
} from "../../../src/core/common/config.js";

let tmp: string;
let root: string;

let stderrWrite: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tut-config-"));
  root = path.join(tmp, ".context-hub");
  mkdirSync(root, { recursive: true });
  stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  stderrWrite.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

describe("ensureConfig", () => {
  it("creates config.json with flow_mode manual when missing", async () => {
    rmSync(root, { recursive: true, force: true }); // root dir absent too: ensureConfig must create it

    const config = await ensureConfig(root);

    expect(config).toEqual({ flow_mode: "manual" });
    const onDisk = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as Config;
    expect(onDisk.flow_mode).toBe("manual");
  });

  it("returns the existing config untouched (no overwrite, unknown keys preserved)", async () => {
    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"auto","future_key":42}\n', "utf8");

    const config = await ensureConfig(root);

    expect(config.flow_mode).toBe("auto");
    expect(config.future_key).toBe(42);
    const raw = readFileSync(path.join(root, "config.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ flow_mode: "auto", future_key: 42 });
  });

  it("leaves no .tmp files behind after creating config", async () => {
    await ensureConfig(root);

    const leftovers = readdirSync(root).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("readFlowMode", () => {
  it("returns manual without throwing when config.json is missing", async () => {
    await expect(readFlowMode(root)).resolves.toBe("manual");
  });

  it("returns manual without throwing on corrupt JSON", async () => {
    writeFileSync(path.join(root, "config.json"), "{ not json", "utf8");

    await expect(readFlowMode(root)).resolves.toBe("manual");
    expect(stderrWrite).toHaveBeenCalled();
  });

  it("returns manual without throwing on an empty file", async () => {
    writeFileSync(path.join(root, "config.json"), "", "utf8");

    await expect(readFlowMode(root)).resolves.toBe("manual");
    expect(stderrWrite).toHaveBeenCalled();
  });

  it("returns manual with a warning on an invalid flow_mode value", async () => {
    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"banana"}', "utf8");

    await expect(readFlowMode(root)).resolves.toBe("manual");
    expect(stderrWrite).toHaveBeenCalled();
  });

  it("round-trips a valid auto value written via file", async () => {
    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"auto"}\n', "utf8");

    await expect(readFlowMode(root)).resolves.toBe("auto");
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it("reads fresh per call (a file flip is visible immediately)", async () => {
    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"manual"}\n', "utf8");
    await expect(readFlowMode(root)).resolves.toBe("manual");

    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"auto"}\n', "utf8");
    await expect(readFlowMode(root)).resolves.toBe("auto");
  });

  it("missing file is silent (no stderr warning)", async () => {
    await readFlowMode(root);

    expect(stderrWrite).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, "config.json"))).toBe(false);
  });
});

describe("readConfig", () => {
  it("returns null on a missing file, without throwing or creating anything", async () => {
    await expect(readConfig(root)).resolves.toBeNull();
    expect(existsSync(path.join(root, "config.json"))).toBe(false);
  });

  it("returns the full config object including unknown keys", async () => {
    writeFileSync(
      path.join(root, "config.json"),
      '{"flow_mode":"manual","notify":{"channels":["desktop","webhook"]},"future_key":42}\n',
      "utf8",
    );

    const config = await readConfig(root);

    expect(config).toEqual({
      flow_mode: "manual",
      notify: { channels: ["desktop", "webhook"] },
      future_key: 42,
    });
  });

  it("returns null (never throws) on corrupt JSON, an empty file, or an invalid flow_mode", async () => {
    for (const raw of ["{ not json", "", '{"flow_mode":"banana"}']) {
      writeFileSync(path.join(root, "config.json"), raw, "utf8");
      await expect(readConfig(root)).resolves.toBeNull();
    }
  });

  it("reads fresh per call", async () => {
    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"manual"}\n', "utf8");
    expect((await readConfig(root))?.flow_mode).toBe("manual");
    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"auto"}\n', "utf8");
    expect((await readConfig(root))?.flow_mode).toBe("auto");
  });
});

describe("auto section", () => {
  it("extracts a valid launch_roles whitelist from a config read off disk", async () => {
    writeFileSync(
      path.join(root, "config.json"),
      '{"flow_mode":"auto","auto":{"launch_roles":["executor","reviewer"]}}\n',
      "utf8",
    );

    const config = await readConfig(root);

    expect(config?.flow_mode).toBe("auto"); // the section changes no existing semantics
    expect(autoSectionOf(config)).toEqual({ launch_roles: ["executor", "reviewer"] });
  });

  it("missing auto key → section absent", async () => {
    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"manual"}\n', "utf8");

    expect(autoSectionOf(await readConfig(root))).toBeUndefined();
  });

  it("missing file / corrupt JSON / invalid flow_mode → readConfig null → section absent", async () => {
    for (const raw of ["{ not json", "", '{"flow_mode":"banana"}']) {
      writeFileSync(path.join(root, "config.json"), raw, "utf8");
      await expect(readConfig(root)).resolves.toBeNull();
      expect(autoSectionOf(await readConfig(root))).toBeUndefined();
    }
    rmSync(path.join(root, "config.json"));
    expect(autoSectionOf(await readConfig(root))).toBeUndefined();
  });

  /** Malformed-section fixtures bypass Config's types on purpose (they model
   *  hand-edited configs that must read as absent, not fail the type checker). */
  function configOf(raw: Record<string, unknown>): Config {
    return raw as unknown as Config;
  }

  it("malformed auto shapes read as absent; empty shapes normalize to the empty whitelist", () => {
    // Non-object section, non-array launch_roles, non-string entries: absent —
    // same conservative withhold-all effect as an empty list, but
    // the config is visibly not honored.
    expect(autoSectionOf(configOf({ flow_mode: "auto", auto: "banana" }))).toBeUndefined();
    expect(autoSectionOf(configOf({ flow_mode: "auto", auto: { launch_roles: "executor" } }))).toBeUndefined();
    expect(autoSectionOf(configOf({ flow_mode: "auto", auto: { launch_roles: ["executor", 42] } }))).toBeUndefined();
    expect(autoSectionOf(null)).toBeUndefined();
    expect(autoSectionOf(undefined)).toBeUndefined();
    // An explicit empty section or an empty list IS a valid (withhold-all) whitelist.
    expect(autoSectionOf(configOf({ flow_mode: "auto", auto: {} }))).toEqual({ launch_roles: [] });
    expect(autoSectionOf(configOf({ flow_mode: "auto", auto: { launch_roles: [] } }))).toEqual({ launch_roles: [] });
  });

  it("writeFlowMode preserves the auto section across a mode switch (key-preserving RMW)", async () => {
    const auto = { launch_roles: ["executor", "reviewer"] };
    writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ flow_mode: "manual", auto }, null, 2) + "\n",
      "utf8",
    );

    await writeFlowMode(root, "auto");

    const onDisk = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as Config;
    expect(onDisk).toEqual({ flow_mode: "auto", auto });
    expect(autoSectionOf(onDisk)).toEqual(auto);
  });
});

describe("writeFlowMode (POST /mode engine, key-preserving RMW)", () => {
  it("creates config.json when missing and returns the written config", async () => {
    rmSync(root, { recursive: true, force: true }); // root dir absent too

    const config = await writeFlowMode(root, "auto");

    expect(config).toEqual({ flow_mode: "auto" });
    const onDisk = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as Config;
    expect(onDisk.flow_mode).toBe("auto");
  });

  it("flips flow_mode while preserving unknown keys like notify", async () => {
    const notify = { channels: ["desktop"], webhook_url: "http://127.0.0.1:9/hook" };
    writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ flow_mode: "manual", notify, future_key: 42 }, null, 2) + "\n",
      "utf8",
    );

    await writeFlowMode(root, "auto");

    const onDisk = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as Config;
    expect(onDisk).toEqual({ flow_mode: "auto", notify, future_key: 42 });
    await expect(readFlowMode(root)).resolves.toBe("auto"); // fresh-read semantics
  });

  it("switches back manual → auto → manual across successive calls", async () => {
    await writeFlowMode(root, "auto");
    await writeFlowMode(root, "manual");
    expect((await readConfig(root))?.flow_mode).toBe("manual");
  });

  it("leaves no .tmp files behind", async () => {
    await writeFlowMode(root, "auto");

    const leftovers = readdirSync(root).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("throws instead of clobbering a corrupt existing config", async () => {
    writeFileSync(path.join(root, "config.json"), "{ not json", "utf8");

    await expect(writeFlowMode(root, "auto")).rejects.toThrow(/unreadable or corrupt/);
    // the corrupt file is left exactly as it was
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe("{ not json");
  });
});

describe("parseConfigValue (tut config set validation)", () => {
  it("accepts both flow_mode values", () => {
    expect(parseConfigValue("flow_mode", "manual")).toEqual({ ok: true, assignment: { key: "flow_mode", value: "manual" } });
    expect(parseConfigValue("flow_mode", "auto")).toEqual({ ok: true, assignment: { key: "flow_mode", value: "auto" } });
  });

  it("rejects an illegal flow_mode with the legal domain in the message", () => {
    const result = parseConfigValue("flow_mode", "banana");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"manual" | "auto"');
  });

  it("trims and de-duplicates launch_roles while preserving order", () => {
    const result = parseConfigValue("auto.launch_roles", "executor, reviewer ,executor");
    expect(result).toEqual({ ok: true, assignment: { key: "auto.launch_roles", value: ["executor", "reviewer"] } });
  });

  it("empty string clears to the empty whitelist", () => {
    expect(parseConfigValue("auto.launch_roles", "")).toEqual({
      ok: true,
      assignment: { key: "auto.launch_roles", value: [] },
    });
  });

  it("rejects non-role names with the legal role list (roles, not agents)", () => {
    const result = parseConfigValue("auto.launch_roles", "codex");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"codex"');
      expect(result.error).toContain("architect|executor|reviewer");
    }
  });

  it("the invalid-role error is its own documentation: format and a copy-pasteable example", () => {
    const result = parseConfigValue("auto.launch_roles", "codex");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("comma-separated bare role names");
      expect(result.error).toContain("e.g. architect,executor,reviewer");
      expect(result.error).toContain('"" clears the whitelist');
      // The domain hint (shared by the available-keys hint) carries the
      // same example — one source of truth.
      expect(configKeyDomain("auto.launch_roles")).toContain("e.g. architect,executor,reviewer");
    }
  });
});

describe("readConfigFile (detailed outcome)", () => {
  it("distinguishes ok / missing / invalid", async () => {
    expect(await readConfigFile(root)).toEqual({ status: "missing" });

    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"auto"}', "utf8");
    const ok = await readConfigFile(root);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.config.flow_mode).toBe("auto");

    writeFileSync(path.join(root, "config.json"), "{ nope", "utf8");
    expect(await readConfigFile(root)).toEqual({ status: "invalid" });
  });
});

describe("writeConfigKey (tut config set engine)", () => {
  it("flow_mode on a missing file starts from defaults", async () => {
    const config = await writeConfigKey(root, { key: "flow_mode", value: "auto" });

    expect(config.flow_mode).toBe("auto");
    expect(JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"))).toEqual({ flow_mode: "auto" });
  });

  it("nested launch_roles write lands under auto and preserves auto siblings", async () => {
    writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ flow_mode: "manual", auto: { launch_roles: ["executor"], extra: 7 }, notify: { channels: ["bell"] } }),
      "utf8",
    );

    const config = await writeConfigKey(root, { key: "auto.launch_roles", value: ["reviewer"] });

    expect(config.auto).toEqual({ launch_roles: ["reviewer"], extra: 7 });
    const onDisk = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as Config;
    expect(onDisk.auto).toEqual({ launch_roles: ["reviewer"], extra: 7 });
    expect(onDisk.notify).toEqual({ channels: ["bell"] }); // unknown keys all survive
  });

  it("throws instead of clobbering a corrupt existing config (nothing written)", async () => {
    writeFileSync(path.join(root, "config.json"), "{ not json", "utf8");

    await expect(writeConfigKey(root, { key: "flow_mode", value: "auto" })).rejects.toThrow(/unreadable or corrupt/);
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe("{ not json");
  });

  it("leaves no .tmp files behind", async () => {
    await writeConfigKey(root, { key: "auto.launch_roles", value: ["executor"] });

    const leftovers = readdirSync(root).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

// --- concurrent write safety ---------------------------------------------------

describe("concurrent config writes (unique temp suffix + serialized write chain)", () => {
  it("100 concurrent writeFlowMode calls never corrupt config.json and never lose the notify keys", async () => {
    // Seed a config with unknown keys that must survive every interleaving.
    writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ flow_mode: "manual", notify: { channels: ["desktop"], webhook_url: "https://example/hook" } }, null, 2) + "\n",
      "utf8",
    );

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => writeFlowMode(root, i % 2 === 0 ? "auto" : "manual")),
    );
    expect(results).toHaveLength(100);

    const raw = readFileSync(path.join(root, "config.json"), "utf8");
    const onDisk = JSON.parse(raw) as Config; // throws on corruption — the failure shape
    expect(onDisk.flow_mode === "manual" || onDisk.flow_mode === "auto").toBe(true);
    expect(onDisk.notify).toEqual({ channels: ["desktop"], webhook_url: "https://example/hook" });
    // No temp litter left behind after the storm.
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writeFlowMode and writeConfigKey serialize on the same chain — no lost updates between engines", async () => {
    writeFileSync(path.join(root, "config.json"), '{"flow_mode":"manual"}\n', "utf8");
    await Promise.all([
      writeFlowMode(root, "auto"),
      writeConfigKey(root, { key: "auto.launch_roles", value: ["executor", "reviewer"] }),
      writeConfigKey(root, { key: "flow_mode", value: "manual" }),
      writeFlowMode(root, "auto"),
    ]);
    const onDisk = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as Config;
    expect(onDisk.flow_mode === "manual" || onDisk.flow_mode === "auto").toBe(true);
    expect(onDisk.auto).toEqual({ launch_roles: ["executor", "reviewer"] });
  });
});

describe('auto.remediate', () => {
  it('validates the switch and preserves launch roles through writes and /state projection', async () => {
    expect(parseConfigValue('auto.remediate', 'enter-repress')).toEqual({ ok: true,
      assignment: { key: 'auto.remediate', value: 'enter-repress' } });
    expect(parseConfigValue('auto.remediate', 'retry').ok).toBe(false);
    await writeConfigKey(root, { key: 'auto.launch_roles', value: ['executor'] });
    const cfg = await writeConfigKey(root, { key: 'auto.remediate', value: 'off' });
    expect(autoSectionOf(cfg)).toEqual({ launch_roles: ['executor'], remediate: 'off' });
    expect(autoSectionOf({ flow_mode: 'auto', auto: { launch_roles: [], remediate: 'bad' } } as unknown as Config))
      .toEqual({ launch_roles: [], remediate: 'off' });
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('invalid auto.remediate'));
  });
  it('rejects an unsupported runtime key without changing config', async () => {
    await writeConfigKey(root, { key: 'auto.remediate', value: 'off' });
    const before = readFileSync(path.join(root, 'config.json'), 'utf8');
    await expect(writeConfigKey(root, { key: 'auto.future', value: 'on' } as unknown as Parameters<typeof writeConfigKey>[1]))
      .rejects.toThrow('unsupported config key');
    expect(readFileSync(path.join(root, 'config.json'), 'utf8')).toBe(before);
  });
});

describe("review_standards", () => {
  it.each([
    ["review.txt", "review.txt"],
    [" standards/评审 标准.md , /shared/team.txt ", "standards/评审 标准.md,/shared/team.txt"],
    ["", ""], ["   ", ""],
    ["off,on", "off,on"],
    ["~/literal,$HOME/file,*.md", "~/literal,$HOME/file,*.md"],
  ])("normalizes and round-trips %j without loading files", async (raw, value) => {
    const parsed = parseConfigValue("review_standards", raw);
    expect(parsed).toEqual({ ok: true, assignment: { key: "review_standards", value } });
    if (!parsed.ok) throw new Error(parsed.error);
    await writeConfigKey(root, parsed.assignment);
    expect((await readConfig(root))?.review_standards).toBe(value);
  });

  it.each([",a", "a,", "a,,b", "a, ,b", "\ta", "a\n", "\r", "a\0b", "a\x1fb", "a\x7fb"])("rejects malformed list %j", (raw) => {
    const parsed = parseConfigValue("review_standards", raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("review_standards");
      expect(parsed.error).toContain(configKeyDomain("review_standards"));
    }
  });

  it("preserves other keys through the shared concurrent write queue", async () => {
    const original = { flow_mode: "manual", auto: { launch_roles: ["reviewer"], extra: true }, notify: { channels: ["bell"] }, future: 42 };
    writeFileSync(path.join(root, "config.json"), JSON.stringify(original));
    await Promise.all([
      writeConfigKey(root, { key: "review_standards", value: "missing-file.txt" }),
      writeFlowMode(root, "auto"),
    ]);
    expect(await readConfig(root)).toEqual({ ...original, flow_mode: "auto", review_standards: "missing-file.txt" });
  });

  it.each([null, [], {}, false, 42, "a,,b"])("keeps malformed optional value %j out of global validation", async (value) => {
    const original = { flow_mode: "auto", review_standards: value };
    writeFileSync(path.join(root, "config.json"), JSON.stringify(original));
    expect(await ensureConfig(root)).toEqual(original);
    expect(await readFlowMode(root)).toBe("auto");
    expect(await readConfig(root)).toEqual(original);
  });
});

describe("power.mode", () => {
  it("parseConfigValue accepts both modes and rejects illegal values with the domain", () => {
    expect(parseConfigValue("power.mode", "herdr")).toEqual({ ok: true, assignment: { key: "power.mode", value: "herdr" } });
    expect(parseConfigValue("power.mode", "standalone")).toEqual({ ok: true, assignment: { key: "power.mode", value: "standalone" } });
    const rejected = parseConfigValue("power.mode", "both");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain('"herdr" | "standalone"');
    expect(CONFIG_KEYS).toContain("power.mode");
  });

  it("readPowerMode defaults to herdr (missing file, missing key, empty section)", async () => {
    expect(await readPowerMode(root)).toBe("herdr");
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual" }));
    expect(await readPowerMode(root)).toBe("herdr");
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual", power: {} }));
    expect(await readPowerMode(root)).toBe("herdr");
  });

  it("readPowerMode reads standalone and fails visibly on illegal values (never a silent default)", async () => {
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual", power: { mode: "standalone" } }));
    expect(await readPowerMode(root)).toBe("standalone");
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual", power: { mode: "both" } }));
    await expect(readPowerMode(root)).rejects.toThrow('invalid power.mode: "both" (expected "herdr" | "standalone")');
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual", power: "standalone" }));
    await expect(readPowerMode(root)).rejects.toThrow("invalid power.mode");
    writeFileSync(path.join(root, "config.json"), "{corrupt");
    await expect(readPowerMode(root)).rejects.toThrow("unreadable or corrupt");
  });

  it("writeConfigKey nests power.mode key-preservingly (siblings inside power survive)", async () => {
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "auto", power: { note: "keep" }, future: 1 }));
    const config = await writeConfigKey(root, { key: "power.mode", value: "standalone" });
    expect((config.power as { mode: string }).mode).toBe("standalone");
    expect(JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"))).toEqual({
      flow_mode: "auto",
      power: { note: "keep", mode: "standalone" },
      future: 1,
    });
  });

  it("configKeyDomain spells the two legal values", () => {
    expect(configKeyDomain("power.mode")).toBe('"herdr" | "standalone"');
  });

  it("readPowerModeForSwitch (the up/down reader) ignores unrelated config damage", async () => {
    // Missing file, corrupt JSON, non-object JSON: the herdr default, silently
    // (the pre-power up behavior; the usage step still warns on its own).
    expect(await readPowerModeForSwitch(root)).toBe("herdr");
    writeFileSync(path.join(root, "config.json"), "{corrupt");
    expect(await readPowerModeForSwitch(root)).toBe("herdr");
    writeFileSync(path.join(root, "config.json"), "[1, 2]");
    expect(await readPowerModeForSwitch(root)).toBe("herdr");
    // An illegal flow_mode with the power key absent: NOT a power problem.
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "bogus" }));
    expect(await readPowerModeForSwitch(root)).toBe("herdr");
    // Explicit herdr under the same damage stays herdr.
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "bogus", power: { mode: "herdr" } }));
    expect(await readPowerModeForSwitch(root)).toBe("herdr");
    // Legal power values win regardless of sibling damage.
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "bogus", power: { mode: "standalone" } }));
    expect(await readPowerModeForSwitch(root)).toBe("standalone");
    // Only a present-but-illegal POWER section throws — the fail-visible branch.
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "bogus", power: { mode: "both" } }));
    await expect(readPowerModeForSwitch(root)).rejects.toThrow('invalid power.mode: "both" (expected "herdr" | "standalone")');
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual", power: "standalone" }));
    await expect(readPowerModeForSwitch(root)).rejects.toThrow("invalid power.mode");
    // Contrast: the STRICT reader (tut config get) still refuses unrelated damage.
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "bogus" }));
    await expect(readPowerMode(root)).rejects.toThrow("unreadable or corrupt");
  });
});

describe("launch_mode normalization", () => {
  it.each(["detached", "headless", "tui"])("normalizes %s at the boundary and preserves concurrent updates", async (raw) => {
    const original = { flow_mode: "manual", power: { mode: "standalone", extra: true },
      auto: { launch_roles: ["executor"], extra: 3 }, launch: { catchup: "on" }, future: { keep: true } };
    writeFileSync(path.join(root, "config.json"), JSON.stringify(original));
    const value = raw === "headless" ? "detached" : raw;
    const parsed = parseConfigValue("launch_mode", raw);
    expect(parsed).toEqual({ ok: true, assignment: { key: "launch_mode", value } });
    if (!parsed.ok) throw new Error(parsed.error);
    await Promise.all([
      writeConfigKey(root, parsed.assignment),
      writeFlowMode(root, "auto"),
      writeConfigKey(root, { key: "launch.catchup", value: "off" }),
    ]);
    expect(await readLaunchMode(root)).toBe(value);
    expect(await readConfig(root)).toEqual({ ...original, flow_mode: "auto", launch_mode: value, launch: { catchup: "off" } });
    expect(readdirSync(root)).toEqual(["config.json"]);
  });
});

describe("single rig intent transactions", () => {
  it("validates programmatic writes as strictly as CLI writes without changing bytes", async () => {
    const original = JSON.stringify({ flow_mode: "manual", future: { untouched: true } });
    writeFileSync(path.join(root, "config.json"), original);
    for (const assignment of [
      { key: "flow_mode", value: "bogus" }, { key: "launch_mode", value: 42 },
      { key: "auto.launch_roles", value: ["executor", "bogus"] },
      { key: "auto.launch_roles", value: "executor" },
      { key: "usage_audit", value: ["on"] },
    ]) {
      await expect(writeConfigKey(root, assignment as Parameters<typeof writeConfigKey>[1])).rejects.toThrow();
      expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(original);
    }
    expect(readdirSync(root)).toEqual(["config.json"]);
  });

  it("round-trips minimal argv/stdin declarations, preserving unrelated intent", async () => {
    const { readAgentBinding, writeAgentBinding } = await import("../../../src/core/common/config.js");
    await writeConfigKey(root, { key: "auto.launch_roles", value: [] });
    for (const prompt of [{ kind: "argv", index: 1 }, { kind: "stdin" }] as const) {
      const binding = { executable: "external-cli", args: ["run", "--model", "chosen", "--quiet"], prompt };
      await writeAgentBinding(root, "external", binding);
      expect(await readAgentBinding(root, "external")).toEqual(binding);
      expect(autoSectionOf(await readConfig(root))?.launch_roles).toEqual([]);
    }
    expect(await readAgentBinding(root, "absent")).toBeUndefined();
    const before = readFileSync(path.join(root, "config.json"), "utf8");
    await expect(writeAgentBinding(root, "external", { executable: "external-cli", args: [], prompt: { kind: "argv", index: 1 } })).rejects.toThrow("insertion index");
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
  });

  it("serializes CLI assign/add/set/mode processes against POST /mode without losing successful edits", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { startServer } = await import("../../../src/hub/server.js");
    const exec = promisify(execFile);
    const cli = path.resolve(import.meta.dirname, "../../../dist/cli.js");
    const legacy = JSON.stringify({ roles: { architect: { agent: "codex" }, executor: { agent: "pi" }, reviewer: { agent: "codex" } }, naming: { tab_label: "custom {role}" }, futureWorkspace: { keep: true } });
    writeFileSync(path.join(root, "workspace.json"), legacy);
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ flow_mode: "manual", future: { keep: true }, auto: { launch_roles: [], keep: 7 } }));
    const server = await startServer({ root, port: 0 });
    const env = { ...process.env, TUT_HUB_ROOT: tmp, TUT_PROJECT_ROOT: tmp, TUT_USER_CONFIG_DIR: path.join(tmp, "absent-user") };
    const call = (args: string[]) => exec(process.execPath, [cli, ...args], { cwd: tmp, env, timeout: 15000 });
    try {
      for (let i = 0; i < 3; i++) {
        await Promise.all([
          call(["assign", "executor", "pi", "--model", `model-${i}`, "--quiet"]),
          call(["agent", "add", `custom-${i}`, "--prompt", "argv:1", "--", "external-cli", "run", "--quiet"]),
          call(["config", "set", "usage_audit", "on", "--root", root]),
          call(["mode", "auto", "--url", server.url]),
          fetch(`${server.url}/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flow_mode: "auto" }) }).then(response => expect(response.status).toBe(200)),
        ]);
      }
      const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
      expect(config).toMatchObject({ flow_mode: "auto", usage_audit: "on", future: { keep: true }, futureWorkspace: { keep: true }, naming: { tab_label: "custom {role}" }, auto: { launch_roles: [], keep: 7 } });
      expect(config.roles.executor).toEqual({ agent: "pi", args: ["--model", "model-2", "--quiet"] });
      expect(Object.keys(config.agent_bindings).sort()).toEqual(["custom-0", "custom-1", "custom-2"]);
      expect(readFileSync(path.join(root, "workspace.json"), "utf8")).toBe(legacy);
      const before = readFileSync(path.join(root, "config.json"), "utf8");
      await expect(call(["agent", "add", "bad", "--prompt", "argv:9", "--", "external-cli", "run"])).rejects.toThrow();
      const rejected = await fetch(`${server.url}/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flow_mode: "invalid" }) });
      expect(rejected.status).toBe(400);
      expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
      expect(readdirSync(tmp).sort()).toEqual([".context-hub"]);
      expect(readdirSync(root).some(name => name.endsWith(".lock") || name.endsWith(".tmp") || name.includes("authority"))).toBe(false);
      expect(existsSync(path.join(tmp, "absent-user"))).toBe(false);
    } finally { await server.close(); }
  }, 20000);
});

it("config locks protect live/unknown owners and recover only a proven dead owner", async () => {
  const { lockConfig } = await import("../../../src/core/common/config-lock.js");
  const { spawn } = await import("node:child_process");
  const file = path.join(root, "config.json.lock");
  const unlock = await lockConfig(file);
  await expect(lockConfig(file, 25)).rejects.toThrow("busy or unverifiable");
  unlock();
  writeFileSync(file, "{initializing");
  await expect(lockConfig(file, 25)).rejects.toThrow("busy or unverifiable");
  expect(readFileSync(file, "utf8")).toBe("{initializing");
  rmSync(file);
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  writeFileSync(file, JSON.stringify({ pid: child.pid, token: "dead-owner" }));
  const release = await lockConfig(file);
  expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
  release();
  expect(readdirSync(root)).toEqual([]);
});

it("preserves prototype-named legacy extension keys as ordinary data", async () => {
  const { writeConfigRole } = await import("../../../src/core/common/config.js");
  const seed = JSON.parse('{"roles":{},"__proto__":{"preserved":true}}');
  await writeConfigRole(root, "executor", "pi", async () => seed);
  const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
  expect(Object.hasOwn(config, "__proto__")).toBe(true);
  expect(config.__proto__).toEqual({ preserved: true });
  expect(config.roles.executor).toEqual({ agent: "pi" });
});

it('migrates invocation fields while preserving inert metadata, siblings and unrelated config',async()=>{
 const {writeAgentBinding,readAgentBinding}=await import('../../../src/core/common/config.js');
 const {resolveAgentRouteWithSource}=await import('../../../src/core/common/workspace.js');
 const metadata={label:'Keep me',future:{items:[1,{unchanged:true}]}};
 const legacy={executable:'external-cli',args:['run','--quiet'],prompt:{kind:'argv',index:1},...metadata};
 writeFileSync(path.join(root,'config.json'),JSON.stringify({flow_mode:'manual',futureConfig:{keep:true},roles:{executor:{agent:'binding:legacy'}},agent_bindings:{legacy,sibling:{keep:'untouched'}}}));
 const canonical={schema_version:1 as const,id:'legacy',command:{executable:'updated-cli',argv:['start',{slot:'args' as const},{slot:'prompt' as const}]},input:{kind:'argv' as const}};
 await writeAgentBinding(root,'legacy',canonical);
 const saved=JSON.parse(readFileSync(path.join(root,'config.json'),'utf8'));
 expect(saved).toMatchObject({futureConfig:{keep:true},agent_bindings:{legacy:{...canonical,...metadata},sibling:{keep:'untouched'}}});
 expect(saved.agent_bindings.legacy).not.toHaveProperty('executable');
 expect(await readAgentBinding(root,'legacy')).toEqual(canonical);
 const selected=await resolveAgentRouteWithSource('executor',undefined,{projectRoot:tmp});expect(selected.binding).toEqual(canonical);
 const before=readFileSync(path.join(root,'config.json'),'utf8');
 await expect(writeAgentBinding(root,'legacy',{...canonical,command:{...canonical.command,argv:[]}})).rejects.toThrow('command.argv');
 expect(readFileSync(path.join(root,'config.json'),'utf8')).toBe(before);
 // Persisted unknown keys stay inert on subsequent updates and reads too.
 const stdin={...canonical,input:{kind:'stdin' as const,encoding:'utf8' as const},command:{...canonical.command,argv:[]}};
 await writeAgentBinding(root,'legacy',stdin);
 expect(await readAgentBinding(root,'legacy')).toEqual(stdin);
 expect(JSON.parse(readFileSync(path.join(root,'config.json'),'utf8')).agent_bindings.legacy.label).toBe('Keep me');
});

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  autoSectionOf,
  configKeyDomain,
  ensureConfig,
  parseConfigValue,
  readConfig,
  readConfigFile,
  readFlowMode,
  writeConfigKey,
  writeFlowMode,
  type Config,
} from "../src/config.js";

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

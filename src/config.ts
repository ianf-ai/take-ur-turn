/**
 * .context-hub/config.json access (readConfig/writeFlowMode for POST /mode,
 * plus the tut config get/set engine at the bottom of this file).
 *
 * Read side is per-request semantics: readFlowMode re-reads the file on every
 * call so `tut mode` can switch flow_mode without restarting serve.
 * Read failures (missing/unreadable/corrupt) NEVER throw — /state must not 5xx
 * on config problems; fall back to "manual" with a stderr warning.
 * readConfig follows the same never-throw discipline (null instead of a
 * fallback) so /state can echo the optional `notify` key only when a real,
 * parseable config object exists behind it; the optional `auto` whitelist
 * section rides the same read via autoSectionOf — malformed
 * shapes read as absent, never invalidating the whole file.
 * Write side is atomic (temp + rename), same pattern as store.ts.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { KNOWN_ROLES } from "./workspace.js";

export type FlowMode = "manual" | "auto";

/**
 * The optional `auto` section: `launch_roles`
 * is the auto-mode trust whitelist, keyed by ROLE (not agent). Absent = empty
 * = withhold every auto launch (conservative default; the enabler fills it in
 * explicitly). Hand-edited into config.json; writeFlowMode's key-preserving
 * RMW keeps it across `tut mode` switches.
 */
export interface AutoConfig {
  launch_roles: string[];
}

/** Extend-only tolerance: unknown extra keys are preserved and ignored. */
export interface Config {
  flow_mode: FlowMode;
  auto?: AutoConfig;
  [key: string]: unknown;
}

const DEFAULT_CONFIG: Config = { flow_mode: "manual" };

export function configPath(root: string): string {
  return path.join(root, "config.json");
}

/** Same temp-file scheme as store.ts: sibling temp + atomic rename, best-effort cleanup on error. */
function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.tmp`;
}

async function writeConfigAtomic(filePath: string, config: Config): Promise<void> {
  const temp = tempPathFor(filePath);
  try {
    await writeFile(temp, JSON.stringify(config, null, 2) + "\n", "utf8");
    await rename(temp, filePath);
  } catch (e) {
    await unlink(temp).catch(() => undefined);
    throw e;
  }
}

/**
 * Ensure `<root>/config.json` exists with `{"flow_mode": "manual"}`; create it
 * atomically if missing. Returns the parsed config (existing file is left
 * untouched, including unknown keys).
 */
export async function ensureConfig(root: string): Promise<Config> {
  const filePath = configPath(root);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    if (!isErrnoException(e, "ENOENT")) throw e;
    await mkdir(root, { recursive: true });
    await writeConfigAtomic(filePath, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  // Existing corrupt config throws to the caller: ensureConfig runs once at
  // serve startup where failing fast is correct (readFlowMode owns the
  // never-throw contract).
  return parseConfigStrict(raw, filePath);
}

/**
 * Read flow_mode FRESH from `<root>/config.json` on every call. Missing file,
 * unreadable file, invalid JSON, or an invalid flow_mode value → "manual" +
 * stderr warning; never throws.
 */
export async function readFlowMode(root: string): Promise<FlowMode> {
  const filePath = configPath(root);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    if (isErrnoException(e, "ENOENT")) return "manual"; // pre-ensureConfig root: silent default
    process.stderr.write(`tut: warning: cannot read ${filePath}: ${(e as Error).message}; defaulting flow_mode to "manual"\n`);
    return "manual";
  }
  let config: Config;
  try {
    config = parseConfigStrict(raw, filePath);
  } catch (e) {
    process.stderr.write(`tut: warning: ${(e as Error).message}; defaulting flow_mode to "manual"\n`);
    return "manual";
  }
  return config.flow_mode;
}

/** Parse and validate; throws on invalid JSON or invalid flow_mode (caller decides policy). */
function parseConfigStrict(raw: string, filePath: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${filePath}: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`invalid config in ${filePath}: expected an object`);
  }
  const candidate = parsed as { flow_mode?: unknown };
  if (candidate.flow_mode !== "manual" && candidate.flow_mode !== "auto") {
    throw new Error(`invalid config in ${filePath}: flow_mode must be "manual" or "auto"`);
  }
  return parsed as Config;
}

/** Distinguish the three read outcomes readConfig collapses to null (writeFlowMode needs the difference). */
export type ReadOutcome = { status: "ok"; config: Config } | { status: "missing" } | { status: "invalid" };

export async function readConfigFile(root: string): Promise<ReadOutcome> {
  const filePath = configPath(root);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    if (isErrnoException(e, "ENOENT")) return { status: "missing" };
    return { status: "invalid" };
  }
  try {
    return { status: "ok", config: parseConfigStrict(raw, filePath) };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * Read the FULL config object fresh from `<root>/config.json` (same per-request
 * semantics as readFlowMode). Missing file, unreadable file, invalid JSON, or
 * an invalid flow_mode → null; never throws and never warns — callers decide
 * policy (/state echoes `notify` only when this returns a real object).
 */
export async function readConfig(root: string): Promise<Config | null> {
  const outcome = await readConfigFile(root);
  return outcome.status === "ok" ? outcome.config : null;
}

/**
 * Extract the validated `auto` section from a config object
 * (/state's optional `auto` key is this value). Tolerant of every malformed
 * shape and never throws: an `auto` that is not an object, or whose
 * `launch_roles` is present but not an array of strings, reads as ABSENT —
 * which withholds every auto launch (same conservative effect
 * as an empty list, but also keeps /state's surface schema-clean). An `auto`
 * object without `launch_roles` normalizes to the explicit empty whitelist.
 */
export function autoSectionOf(config: Config | null | undefined): AutoConfig | undefined {
  const candidate = config?.auto;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const roles = (candidate as { launch_roles?: unknown }).launch_roles;
  if (roles === undefined) return { launch_roles: [] };
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === "string")) return undefined;
  return { launch_roles: roles };
}

/**
 * Key-preserving flow_mode switch (POST /mode's engine):
 * read-modify-write — unknown keys (e.g. the Notifier's `notify` config) all
 * survive — via the same temp+rename atomic write as every other config write.
 * A missing file starts from defaults (serve's ensureConfig normally created
 * it already); a file that exists but cannot be parsed THROWS rather than
 * clobber keys it cannot read — POST /mode surfaces that as a 500.
 */
export async function writeFlowMode(root: string, mode: FlowMode): Promise<Config> {
  const outcome = await readConfigFile(root);
  if (outcome.status === "invalid") {
    throw new Error(`cannot switch flow_mode: ${configPath(root)} is unreadable or corrupt`);
  }
  const config: Config = outcome.status === "missing" ? { ...DEFAULT_CONFIG } : { ...outcome.config };
  config.flow_mode = mode;
  await mkdir(root, { recursive: true });
  await writeConfigAtomic(configPath(root), config);
  return config;
}

// --- tut config get/set engine -------------------------------------------------
//
// The CLI surface (tut config) edits the SAME file serve re-reads per request
// (readConfig above), so a write is picked up by the next poll cycle with no
// restart and no Hub round-trip — config get/set works with the Hub down too
// (same discipline as tut assign editing workspace.json directly).

/** Scalar-settable config keys exposed to `tut config set`. */
export type ConfigKey = "flow_mode" | "auto.launch_roles";

/** All keys `tut config set` accepts, in hint-listing order. */
export const CONFIG_KEYS: readonly ConfigKey[] = ["flow_mode", "auto.launch_roles"];

/** One typed key/value pair ready to apply (discriminated so writeConfigKey narrows). */
export type ConfigKeyAssignment = { key: "flow_mode"; value: FlowMode } | { key: "auto.launch_roles"; value: string[] };

/** Legal-value domain hint for a key — used by `tut config` error text and help. */
export function configKeyDomain(key: ConfigKey): string {
  return key === "flow_mode"
    ? '"manual" | "auto"'
    : `comma-separated bare role names (${KNOWN_ROLES.join("|")}), e.g. ${KNOWN_ROLES.join(",")}; "" clears the whitelist`;
}

/** Available-keys hint line shared by every `tut config` rejection path. */
export function configKeysHint(): string {
  const keys = CONFIG_KEYS.map((key) => `${key} (${configKeyDomain(key)})`).join(", ");
  return `available keys: ${keys}; notify (get only — an object config, edit config.json by hand)`;
}

/**
 * Validate and normalize a raw CLI string for one key. launch_roles: ""
 * clears to the empty whitelist; comma-separated role names are trimmed and
 * de-duplicated (order preserved) and must all be KNOWN_ROLES — the
 * whitelist is role-keyed, so a typo must fail loudly, not silently withhold.
 */
export function parseConfigValue(
  key: ConfigKey,
  raw: string,
): { ok: true; assignment: ConfigKeyAssignment } | { ok: false; error: string } {
  if (key === "flow_mode") {
    if (raw === "manual" || raw === "auto") return { ok: true, assignment: { key, value: raw } };
    return { ok: false, error: `invalid value for flow_mode: "${raw}" (expected ${configKeyDomain("flow_mode")})` };
  }
  const roles: string[] = [];
  for (const piece of raw.split(",")) {
    const role = piece.trim();
    if (role.length === 0) continue;
    if (!(KNOWN_ROLES as readonly string[]).includes(role)) {
      // The error is the documentation: the format AND a copy-pasteable
      // example ride along (roles are bare names — agents like "codex" are
      // the classic wrong value this must teach its way out of).
      return {
        ok: false,
        error:
          `invalid role in auto.launch_roles: "${role}" — not a known role; ` +
          `expected ${configKeyDomain("auto.launch_roles")}`,
      };
    }
    if (!roles.includes(role)) roles.push(role);
  }
  return { ok: true, assignment: { key, value: roles } };
}

/**
 * Key-preserving write of ONE validated key — the same read-modify-write +
 * atomic temp/rename discipline as writeFlowMode: unknown keys (notify, future
 * sections) and sibling keys inside `auto` all survive. Missing file starts
 * from defaults; a file that exists but cannot be parsed THROWS rather than
 * clobber keys it cannot read (the CLI surfaces that as exit 1).
 */
export async function writeConfigKey(root: string, assignment: ConfigKeyAssignment): Promise<Config> {
  const { key } = assignment;
  const outcome = await readConfigFile(root);
  if (outcome.status === "invalid") {
    throw new Error(`cannot set ${key}: ${configPath(root)} is unreadable or corrupt`);
  }
  const config: Config = outcome.status === "missing" ? { ...DEFAULT_CONFIG } : { ...outcome.config };
  if (assignment.key === "flow_mode") {
    config.flow_mode = assignment.value;
  } else {
    const existing = typeof config.auto === "object" && config.auto !== null ? config.auto : {};
    config.auto = { ...existing, launch_roles: assignment.value }; // siblings inside auto survive
  }
  await mkdir(root, { recursive: true });
  await writeConfigAtomic(configPath(root), config);
  return config;
}

function isErrnoException(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}

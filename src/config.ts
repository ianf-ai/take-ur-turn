/**
 * .context-hub/config.json access (readConfig/writeFlowMode for POST /mode).
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
 * Read flow_mode FRESH from `<root>/config.json` (decision 6). Missing file,
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
type ReadOutcome = { status: "ok"; config: Config } | { status: "missing" } | { status: "invalid" };

async function readConfigFile(root: string): Promise<ReadOutcome> {
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

function isErrnoException(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}

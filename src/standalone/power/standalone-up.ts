/**
 * Standalone power implementation (config power.mode = "standalone").
 *
 * `tut up` in standalone mode raises the rig's services — hub, notifier,
 * and (opt-in) the usage watcher — as DETACHED processes, each its own
 * process group (spawn detached ⇒ group leader, pgid === pid). Process
 * facts land in `.context-hub/power.json` (pid/pgid/started_at/port), the
 * single source `tut down` stops the rig from. Herdr mode provisions
 * panes instead and never touches power.json.
 *
 * Rig locating is explicit: the rig root is the directory owning
 * `.context-hub` — cwd's rig root (resolveRigRoot) or `--root`. Two roots
 * carry two independent power.json files and two port pairs
 * (resolveUpHub's discovery/free-pair scan), so their up/ps/down never
 * cross. Runs are OUT of scope on purpose: every run is its own detached
 * process group, so it survives both up and down (down lists the
 * survivors instead of killing them).
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { probeHub, probeNotifier, notifierMatches, resolveUpHub, resolveRigRoot } from "../../core/hub/rig-discovery.js";
import { acquireRigStartLock } from "../../core/hub/rig-lock.js";
import { rigEnvironment } from "../../core/hub/rig.js";
import { readConfigFile } from "../../core/common/config.js";
import { DEFAULT_HUB_PORT, DEFAULT_EVENT_PORT, sleepMs } from "../../core/cli/shared.js";

// --- power.json: process facts ---------------------------------------------------

/** What down needs to stop one service. pid null = alive but not ours to
 *  signal (e.g. a hub this up only verified and reused). start_token is the
 *  recorded process-start fingerprint — down's identity proof that a live
 *  pid is still the SAME process instance this file was written about. */
export interface PowerFacts {
  pid: number | null;
  pgid: number | null;
  started_at: string;
  start_token?: string | null;
}

/** Service facts plus the power session of THAT service's tree: the id up
 *  exported to the process (TUT_POWER_SESSION) whose non-detached children
 *  register under it. The session binds to the SURVIVING service instance —
 *  a reused service keeps its recorded session (its live tree still carries
 *  it); a freshly spawned service gets a new one. Absent for reused services
 *  without preserved facts (attribution impossible — down refuses their
 *  leaderless leftovers). */
export interface ServiceFacts extends PowerFacts {
  power_session?: string | null | undefined;
}

/** The standalone rig's power state; down stops from this file. */
export interface PowerState {
  mode: "standalone";
  started_at: string;
  hub: { url: string; port: number } & ServiceFacts;
  notifier: { event_port: number } & ServiceFacts;
  watcher?: { pid: number; pgid: number; started_at: string; start_token?: string | null; power_session?: string | null | undefined } | null;
  stopped_at?: string;
}

export function powerStatePath(storageDir: string): string {
  return path.join(storageDir, "power.json");
}

const isIso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const isPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function factsOf(raw: unknown): { ok: true; value: PowerFacts } | { ok: false } {
  if (typeof raw !== "object" || raw === null) return { ok: false };
  const r = raw as Record<string, unknown>;
  if ((r.pid !== null && !isPid(r.pid)) || (r.pgid !== null && !isPid(r.pgid)) || !isIso(r.started_at)) return { ok: false };
  if (r.start_token !== undefined && r.start_token !== null && typeof r.start_token !== "string") return { ok: false };
  return {
    ok: true,
    value: {
      pid: r.pid as number | null,
      pgid: r.pgid as number | null,
      started_at: r.started_at as string,
      ...(r.start_token !== undefined ? { start_token: r.start_token as string | null } : {}),
    },
  };
}

/** Per-service session parsing: absent → omitted, legal string → kept,
 *  anything else (explicit null included) → null (no attribution). */
const sessionOf = (raw: Record<string, unknown>): { power_session?: string | null } =>
  raw.power_session === undefined ? {} :
  typeof raw.power_session === "string" && raw.power_session.length > 0 ? { power_session: raw.power_session } :
  { power_session: null };

/**
 * Read power.json. Missing file → undefined (nothing provisioned).
 * Present but unreadable/corrupt/shape-invalid → throw (fail-visible:
 * down must never guess what to stop).
 */
export async function readPowerState(storageDir: string): Promise<PowerState | undefined> {
  const file = powerStatePath(storageDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read power state ${file}: unreadable — fix it by hand`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`cannot read power state ${file}: corrupt JSON — fix it by hand`);
  }
  const state = parsed as Partial<PowerState> & { hub?: unknown; notifier?: unknown };
  if (state.mode !== "standalone" || !isIso(state.started_at) || typeof state.hub !== "object" || state.hub === null ||
    typeof state.notifier !== "object" || state.notifier === null) {
    throw new Error(`cannot read power state ${file}: unexpected shape — fix it by hand`);
  }
  const hub = state.hub as unknown as Record<string, unknown>;
  const notifier = state.notifier as unknown as Record<string, unknown>;
  if (typeof hub.url !== "string" || !isPid(hub.port) || !isPid(notifier.event_port)) {
    throw new Error(`cannot read power state ${file}: unexpected shape — fix it by hand`);
  }
  const hubFacts = factsOf(hub);
  const notifierFacts = factsOf(notifier);
  if (!hubFacts.ok || !notifierFacts.ok) throw new Error(`cannot read power state ${file}: unexpected shape — fix it by hand`);
  let watcher: NonNullable<PowerState["watcher"]> | undefined;
  if (state.watcher !== undefined && state.watcher !== null) {
    const w = factsOf(state.watcher);
    if (!w.ok || w.value.pid === null || w.value.pgid === null) throw new Error(`cannot read power state ${file}: unexpected shape — fix it by hand`);
    watcher = {
      pid: w.value.pid as number,
      pgid: w.value.pgid as number,
      started_at: w.value.started_at,
      ...(w.value.start_token !== undefined ? { start_token: w.value.start_token } : {}),
      ...sessionOf(state.watcher as unknown as Record<string, unknown>),
    };
  }
  const hubRaw = hub as unknown as Record<string, unknown>;
  const notifierRaw = notifier as unknown as Record<string, unknown>;
  return {
    mode: "standalone",
    started_at: state.started_at,
    hub: { url: hub.url as string, port: hub.port as number, ...hubFacts.value, ...sessionOf(hubRaw) },
    notifier: { event_port: notifier.event_port as number, ...notifierFacts.value, ...sessionOf(notifierRaw) },
    ...(watcher !== undefined ? { watcher } : {}),
    ...(state.stopped_at !== undefined && isIso(state.stopped_at) ? { stopped_at: state.stopped_at } : {}),
  };
}

/** Atomic power.json write (temp + rename, the store.ts/config.ts pattern). */
export async function writePowerState(storageDir: string, state: PowerState): Promise<void> {
  mkdirSync(storageDir, { recursive: true });
  const file = powerStatePath(storageDir);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(temp, file);
  } catch (e) {
    await unlink(temp).catch(() => undefined);
    throw e;
  }
}

// --- probes and waits (same env knobs as the herdr path in cli/rig.ts) -----------

async function hubHealthy(baseUrl: string, root: string): Promise<boolean> {
  return (await probeHub(baseUrl))?.root === root;
}

async function notifierHealthy(eventUrl: string, root: string, hubUrl: string): Promise<boolean> {
  return notifierMatches(await probeNotifier(eventUrl), root, hubUrl);
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleepMs(intervalMs);
  }
}

/** TUT_UP_HUB_WAIT_MS / TUT_UP_NOTIFY_WAIT_MS — the same test/ops knobs the
 *  herdr path reads (per call); default 10s each. */
function waitMs(name: "hub" | "notify"): number {
  const raw = process.env[name === "hub" ? "TUT_UP_HUB_WAIT_MS" : "TUT_UP_NOTIFY_WAIT_MS"];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000;
}

/** Best-effort liveness probe; EPERM still means alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Group liveness: ESRCH = the whole recorded group is gone (leader and
 *  every member); EPERM = exists but foreign (conservative: alive). */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// --- process identitya live pid is not ownership) --------------------------

const execFileAsync = promisify(execFile);

/** Linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot) —
 *  stable for the life of the process, changes on pid reuse. */
async function procfsStartToken(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces and parens — the fields resume after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttime = fields[19]; // overall field 22
    return starttime !== undefined && starttime.length > 0 ? `procfs:${starttime}` : null;
  } catch {
    return null;
  }
}

/** macOS: `ps -p <pid> -lstart=` (absolute start timestamp, whitespace
 *  normalized) — the same stability properties on the BSD side. */
async function psStartToken(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 2_000 });
    const normalized = stdout.trim().replace(/\s+/g, " ");
    return normalized.length > 0 ? `ps:${normalized}` : null;
  } catch {
    return null;
  }
}

/** The current start fingerprint of a live pid, or null when this platform
 *  cannot derive one — null NEVER means mismatch; callers treat it as
 *  identity-unverifiable (the conservative branch). */
export async function processStartToken(pid: number): Promise<string | null> {
  if (process.platform === "linux") return procfsStartToken(pid);
  if (process.platform === "darwin") return psStartToken(pid);
  return null;
}

/** True only when the live pid provably IS the recorded instance: a token
 *  was recorded, the platform can re-derive it, and both agree. */
export async function pidMatchesStartToken(pid: number, recorded: string | null | undefined): Promise<boolean> {
  if (recorded === null || recorded === undefined) return false;
  return (await processStartToken(pid)) === recorded;
}

/** Fact-preservation gate: keep the recorded facts unless the pid is
 *  PROVABLY gone or provably a different instance. A dead pid (ESRCH) is
 *  definitive — respawn, never preserve; a LIVE pid whose recorded token
 *  agrees, or whose derivation currently fails (ps busy/timeout —
 *  transient), keeps the facts; only a positive mismatch (a recycled pid)
 *  resets them. Down re-verifies with its own probes, so preserving on
 *  "alive but cannot tell now" never weakens safety. */
async function tokenAgreesOrUnknown(pid: number, recorded: string | null | undefined): Promise<boolean> {
  if (recorded === null || recorded === undefined) return false; // nothing recorded to preserve
  if (!processAlive(pid)) return false; // the recorded instance is gone: facts are stale
  const current = await processStartToken(pid);
  return current === null || current === recorded;
}

/** The process group id of a live pid (POSIX): /proc field 5 on Linux,
 *  `ps -o pgid=` on macOS — Node exposes neither getpgrp nor getpgid. */
export async function processPgid(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const pgrp = Number(fields[2]); // overall field 5
      return Number.isSafeInteger(pgrp) && pgrp > 0 ? pgrp : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="], { timeout: 2_000 });
    const pgid = Number(stdout.trim());
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

// --- power session & member registry -------------------------------------------

/** One line of .context-hub/power-members.jsonl: a member of the rig's own
 *  process tree that carries the TUT_POWER_SESSION marker — the services up
 *  spawned plus their NON-detached descendants (e.g. `tut launch` children
 *  of the notifier, which inherit its process group). The registry is what
 *  lets down attribute a leftover group AFTER its recorded leader died:
 *  a live member whose pid, pgid, session and start token all match is
 *  positive proof the group is this rig's; foreign groups (stale records,
 *  other rigs, runs) never carry the session marker and never register. */
export interface PowerMember {
  pid: number;
  pgid: number;
  power_session: string;
  kind: string;
  registered_at: string;
  start_token: string | null;
}

export function powerMembersPath(storageDir: string): string {
  return path.join(storageDir, "power-members.jsonl");
}

/** Read the registry; missing file → empty, corrupt lines are skipped (the
 *  registry is advisory — attribution, not audit). */
export async function readPowerMembers(storageDir: string): Promise<PowerMember[]> {
  let raw: string;
  try {
    raw = await readFile(powerMembersPath(storageDir), "utf8");
  } catch {
    return [];
  }
  const members: PowerMember[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<PowerMember>;
      if (Number.isSafeInteger(parsed.pid) && parsed.pid! > 0 && Number.isSafeInteger(parsed.pgid) && parsed.pgid! > 0 &&
        typeof parsed.power_session === "string" && parsed.power_session.length > 0 && typeof parsed.kind === "string" &&
        typeof parsed.registered_at === "string" && (parsed.start_token === null || typeof parsed.start_token === "string")) {
        members.push({ pid: parsed.pid!, pgid: parsed.pgid!, power_session: parsed.power_session, kind: parsed.kind, registered_at: parsed.registered_at, start_token: parsed.start_token ?? null });
      }
    } catch { /* skip corrupt line */ }
  }
  return members;
}

/** Append one member line (O_APPEND small writes; best-effort by contract). */
export async function appendPowerMember(storageDir: string, member: PowerMember): Promise<void> {
  mkdirSync(storageDir, { recursive: true });
  await appendFile(powerMembersPath(storageDir), JSON.stringify(member) + "\n", "utf8");
}

/** Drop the whole registry — only after a VERIFIED full stop (down): every
 *  service group is gone and no tree member can still be registering, so
 *  the delete cannot lose a live member's line . */
export async function prunePowerMembers(storageDir: string): Promise<void> {
  await unlink(powerMembersPath(storageDir)).catch(() => undefined);
}

/** Register THIS process as a rig-tree member. Gated on the inherited
 *  TUT_POWER_SESSION marker (only processes descended from this rig's
 *  standalone services carry it); best-effort and silent — a registry
 *  failure only costs some future cleanup ability, never the launch. */
export async function registerPowerMember(kind: string): Promise<void> {
  const session = process.env.TUT_POWER_SESSION;
  if (session === undefined || session.length === 0) return;
  const pgid = await processPgid(process.pid);
  if (pgid === null) return;
  try {
    await appendPowerMember(path.join(resolveRigRoot(), ".context-hub"), {
      pid: process.pid,
      pgid,
      power_session: session,
      kind,
      registered_at: new Date().toISOString(),
      start_token: await processStartToken(process.pid),
    });
  } catch { /* best-effort registry */ }
}

// --- usage watcher (shared with the herdr path — identical output) ---------------

/** Where usage-watcher diagnostics land (the herdr path's convention). */
const USAGE_LOG_REL = path.join(".context-hub", "usage-audit.log");

/**
 * Start the shipped usage watcher detached (opt-in via usage_audit = "on").
 * EXACTLY the herdr up step's semantics and output, extracted so both power
 * modes share one implementation: read usage_audit (invalid file/value →
 * warning + off), plan in dry-run, otherwise spawn detached with the log as
 * stdio. Returns the spawned pid, or null when nothing was started. The
 * watcher's own file lock makes reruns self-healing (a second instance
 * exits immediately) — measurement must never fail the rig.
 */
export async function provisionUsageWatcher(cwd: string, hubUrl: string, dryRun: boolean, extraEnv: Readonly<Record<string, string>> = {}): Promise<{ pid: number } | null> {
  const outcome = await readConfigFile(path.join(cwd, ".context-hub"));
  if (outcome.status === "invalid") {
    process.stderr.write("tut: up: usage_audit skipped — .context-hub/config.json is unreadable or corrupt; fix it by hand\n");
    return null;
  }
  const usageAuditOn = outcome.status === "ok" && outcome.config.usage_audit === "on";
  if (outcome.status === "ok" && outcome.config.usage_audit !== undefined && outcome.config.usage_audit !== "on" && outcome.config.usage_audit !== "off") {
    process.stderr.write(`tut: up: ignoring invalid usage_audit "${String(outcome.config.usage_audit)}" (expected "off" | "on")\n`);
  }
  if (!usageAuditOn) return null;
  const usageScript = fileURLToPath(new URL("../../../scripts/usage-audit/run.mjs", import.meta.url));
  if (!existsSync(usageScript)) {
    process.stderr.write("tut: up: usage watcher script not found in this installation — measurement not started (non-fatal)\n");
    return null;
  }
  if (dryRun) {
    process.stdout.write(`up: [dry-run] would start the usage watcher (detached; log at ${USAGE_LOG_REL})\n`);
    return null;
  }
  const logPath = path.join(cwd, USAGE_LOG_REL);
  const out = openSync(logPath, "a");
  const child = spawn(process.execPath, [usageScript, "--watch", "--root", cwd, "--url", hubUrl], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
  // Spawn failures arrive asynchronously (ENOENT/EMFILE/...) — without a
  // listener they escape and kill the caller.
  child.on("error", (err) => {
    try { closeSync(out); } catch {}
    process.stderr.write(`tut: up: usage watcher failed to start (non-fatal): ${err.message}\n`);
  });
  child.unref();
  if (child.pid !== undefined) {
    process.stdout.write(`up: usage watcher spawned (pid ${child.pid}; per-round usage lands in tasks/<id>/usage.json)\n`);
    return { pid: child.pid };
  }
  return null;
}

// --- detached service spawn ------------------------------------------------------

interface DetachedService {
  child: ChildProcess & { pid: number };
  stop: () => void;
}

/** One detached service process group with an append-mode power log. */
function spawnPowerService(self: string, args: readonly string[], root: string, env: Readonly<Record<string, string>>, logFile: string): DetachedService {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [self, ...args], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
  }) as ChildProcess & { pid: number };
  child.on("error", (err) => {
    try { closeSync(out); } catch {}
    process.stderr.write(`tut: up: standalone service failed to start: ${err.message}\n`);
  });
  child.unref();
  return {
    child,
    stop: () => {
      // Group kill best-effort (detached ⇒ pid === pgid); the health probes
      // are the authoritative gate, this only reaps a half-born rig.
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { process.kill(child.pid, "SIGKILL"); } catch {} }
    },
  };
}

// --- standalone up ----------------------------------------------------------------

export interface StandaloneUpOptions {
  url?: string | undefined;
  eventPort?: number | undefined;
  dryRun: boolean;
  /** The CLI itself (dist-style path; the caller resolved TUT_UP_CLI_SELF). */
  self: string;
}

/**
 * `tut up` for power.mode=standalone. Idempotent: healthy services are
 * verified and reused (recorded facts preserved), missing ones are raised.
 * On a provisioning failure the half-born rig is reaped and up exits 1 —
 * power.json is only written for a rig that passed both health gates.
 */
export async function runStandaloneUp(root: string, options: StandaloneUpOptions): Promise<number> {
  const storageDir = path.join(root, ".context-hub");
  const { self, dryRun } = options;

  // Dev-layout fix, the herdr path's discipline: a src-layout self would
  // spawn `node src/cli.ts …` (TypeScript — not runnable). Fail BEFORE any
  // probe, spawn, or side effect.
  if (path.basename(path.dirname(self)) === "src") {
    process.stderr.write(
      "tut up: running from src layout — run `npm run build` first (dist/cli.js is the provision target); " +
        "or set TUT_UP_CLI_SELF to a dist-style path\n",
    );
    return 1;
  }
  if (!existsSync(path.join(root, "package.json")) && !existsSync(storageDir)) {
    process.stderr.write(
      `tut: up: no package.json or .context-hub/ in ${root} — not a TUT project yet: run 'tut init' here to onboard (creates .context-hub/ and the AGENTS.md block), or cd to the project root and run tut up there\n`,
    );
    return 1;
  }

  let hubUrl = options.url ?? process.env.TUT_HUB_URL ?? `http://127.0.0.1:${DEFAULT_HUB_PORT}`;
  let hubPort: number;
  try {
    const u = new URL(hubUrl);
    const loopback = u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
    if (!loopback || u.port.length === 0) throw new Error("not a loopback http URL with an explicit port");
    hubPort = Number(u.port);
  } catch {
    process.stderr.write(`tut: up: --url must be an http loopback URL with an explicit port (e.g. http://127.0.0.1:3003), got: ${hubUrl}\n`);
    return 1;
  }
  let eventPort = options.eventPort ?? DEFAULT_EVENT_PORT;
  if (hubPort === eventPort) {
    process.stderr.write(
      `tut: up: the hub port and the notifier event port are both ${eventPort} — they cannot share one port (the hub binds it; notify would die with EADDRINUSE); use a different hub port (e.g. --url http://127.0.0.1:3011) or move the event port (e.g. --event-port 3005)\n`,
    );
    return 1;
  }

  let releaseLock: (() => void) | undefined;
  // Everything THIS run raised (hub/notifier children + watcher pids). Any
  // failure after the first spawn reaps all of it: an up that cannot
  // deliver a manageable power.json must not leave services behind. Reused
  // pre-existing services and independent runs are never in this list.
  const spawnedServices: DetachedService[] = [];
  const spawnedPids: number[] = [];
  const reap = (): void => {
    for (const service of spawnedServices) service.stop();
    for (const pid of spawnedPids) {
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  };
  try {
    if (!dryRun) releaseLock = acquireRigStartLock(root);
    let selected: { url: string; eventPort: number };
    try {
      selected = await resolveUpHub(hubUrl, options.url !== undefined, root, options.eventPort);
    } catch (error) {
      process.stderr.write(`tut: up: ${(error as Error).message}\n`);
      return 1;
    }
    hubUrl = selected.url;
    hubPort = Number(new URL(hubUrl).port);
    eventPort = selected.eventPort;
    if (hubPort === eventPort) {
      process.stderr.write(`tut: up: hub port and notifier event port are both ${eventPort}; choose a different --event-port and rerun tut up\n`);
      return 1;
    }
    const eventUrl = `http://127.0.0.1:${eventPort}/agent-event`;
    // Power session markers, ONE PER SERVICE TREE : the id is bound to
    // the surviving instance, not to this up invocation. A freshly spawned
    // service gets a new id in its env (its non-detached children register
    // under it and become attributable even after the leader dies); a REUSED
    // service keeps its recorded id — the live tree still carries that one.
    const serviceEnv = (session: string): Record<string, string> => ({ ...rigEnvironment(root, hubUrl, eventUrl), TUT_POWER_SESSION: session });

    // Prior power state: facts to preserve across idempotent ups. A corrupt
    // file never blocks provisioning (this path REPLACES it) — down is the
    // strict reader.
    let prior: PowerState | undefined;
    try {
      prior = await readPowerState(storageDir);
    } catch (error) {
      process.stderr.write(`tut: up: ${(error as Error).message}; provisioning fresh (previous facts are lost)\n`);
    }
    if (dryRun) {
      process.stdout.write(`up: [dry-run] power.mode=standalone — would provision detached services for ${root}:\n`);
      process.stdout.write(`up: [dry-run]   node ${self} serve --port ${hubPort} --root ${storageDir}   (detached; log ${path.join(".context-hub", "power-hub.log")})\n`);
      process.stdout.write(`up: [dry-run]   node ${self} notify --url ${hubUrl} --event-port ${eventPort}   (detached; log ${path.join(".context-hub", "power-notify.log")})\n`);
      process.stdout.write(`up: [dry-run]   power state would land in ${path.join(".context-hub", "power.json")}\n`);
      await provisionUsageWatcher(root, hubUrl, true);
      return 0;
    }

    // Step 1 — hub: verify-then-spawn, then gate on /state health. Recorded
    // facts are preserved only when the live pid provably IS the recorded
    // instance (start-token match) — a recycled pid never re-becomes ours.
    const hubReused = await hubHealthy(hubUrl, root);
    let hubFacts: ServiceFacts;
    if (hubReused) {
      process.stdout.write(`up: hub already running (${hubUrl}/state)\n`);
      // Facts are dropped ONLY on a positive mismatch (a recycled pid). A
      // transient derivation failure (ps busy/timeout) PRESERVES the recorded
      // facts — down re-verifies them with its own probes later.
      const hubKeep = prior?.hub.url === hubUrl && prior.hub.pid !== null && (await tokenAgreesOrUnknown(prior.hub.pid, prior.hub.start_token));
      hubFacts = hubKeep
        ? { pid: prior!.hub.pid, pgid: prior!.hub.pgid, started_at: prior!.hub.started_at, ...(prior!.hub.start_token !== undefined ? { start_token: prior!.hub.start_token } : {}), ...(prior!.hub.power_session !== undefined ? { power_session: prior!.hub.power_session } : {}) }
        : { pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null, power_session: null };
    } else {
      const hubSession = randomUUID();
      const hubChild = spawnPowerService(self, ["serve", "--port", String(hubPort), "--root", storageDir], root, serviceEnv(hubSession), path.join(storageDir, "power-hub.log"));
      spawnedServices.push(hubChild);
      const startedAt = Date.now();
      if (!(await pollUntil(() => hubHealthy(hubUrl, root), waitMs("hub"), 250))) {
        reap();
        process.stderr.write(`tut: up: standalone serve (pid ${hubChild.child.pid}) started but ${hubUrl}/state stayed unhealthy for ${waitMs("hub")}ms — check ${path.join(".context-hub", "power-hub.log")}\n`);
        return 1;
      }
      hubFacts = { pid: hubChild.child.pid, pgid: hubChild.child.pid, started_at: new Date().toISOString(), start_token: await processStartToken(hubChild.child.pid), power_session: hubSession };
      process.stdout.write(`up: hub serving on ${hubUrl} (standalone pid ${hubChild.child.pid}, waited ${Date.now() - startedAt}ms)\n`);
    }

    // Step 2 — notifier: verify-then-spawn, then gate on the event port.
    const notifyReused = await notifierHealthy(eventUrl, root, hubUrl);
    let notifyFacts: ServiceFacts;
    if (notifyReused) {
      process.stdout.write(`up: notify already listening (${eventUrl})\n`);
      const notifyKeep = prior?.notifier.event_port === eventPort && prior.notifier.pid !== null && (await tokenAgreesOrUnknown(prior.notifier.pid, prior.notifier.start_token));
      notifyFacts = notifyKeep
        ? { pid: prior!.notifier.pid, pgid: prior!.notifier.pgid, started_at: prior!.notifier.started_at, ...(prior!.notifier.start_token !== undefined ? { start_token: prior!.notifier.start_token } : {}), ...(prior!.notifier.power_session !== undefined ? { power_session: prior!.notifier.power_session } : {}) }
        : { pid: null, pgid: null, started_at: new Date().toISOString(), start_token: null, power_session: null };
    } else {
      const notifySession = randomUUID();
      const notifyChild = spawnPowerService(self, ["notify", "--url", hubUrl, "--event-port", String(eventPort)], root, serviceEnv(notifySession), path.join(storageDir, "power-notify.log"));
      spawnedServices.push(notifyChild);
      const startedAt = Date.now();
      if (!(await pollUntil(() => notifierHealthy(eventUrl, root, hubUrl), waitMs("notify"), 250))) {
        reap();
        process.stderr.write(`tut: up: standalone notify (pid ${notifyChild.child.pid}) started but ${eventUrl} never answered for ${waitMs("notify")}ms — check ${path.join(".context-hub", "power-notify.log")}; the half-born rig was stopped\n`);
        return 1;
      }
      notifyFacts = { pid: notifyChild.child.pid, pgid: notifyChild.child.pid, started_at: new Date().toISOString(), start_token: await processStartToken(notifyChild.child.pid), power_session: notifySession };
      process.stdout.write(`up: notify running (standalone pid ${notifyChild.child.pid}, event port ${eventPort})\n`);
    }

    // Step 3 — usage watcher (opt-in). An alive recorded watcher keeps its
    // facts (token-verified); anything else follows the shared provision
    // path. A watcher raised THIS run joins the reap list — it is as much a
    // new service as hub/notifier.
    let watcher: PowerState["watcher"] = null;
    try {
      const priorWatcher = prior?.watcher;
      if (priorWatcher != null && priorWatcher.pid !== null && (await tokenAgreesOrUnknown(priorWatcher.pid, priorWatcher.start_token))) {
        process.stdout.write(`up: usage watcher already running (pid ${priorWatcher.pid})\n`);
        watcher = priorWatcher;
      } else {
        const watcherSession = randomUUID();
        const spawned = await provisionUsageWatcher(root, hubUrl, false, { TUT_POWER_SESSION: watcherSession });
        if (spawned !== null) {
          spawnedPids.push(spawned.pid);
          watcher = { pid: spawned.pid, pgid: spawned.pid, started_at: new Date().toISOString(), start_token: await processStartToken(spawned.pid), power_session: watcherSession };
        }
      }
    } catch {
      process.stderr.write("tut: up: usage watcher step failed (non-fatal) — measurement not started\n");
    }

    // Step 4 — record the power facts down will stop from. Any failure here
    // (disk full, permissions, …) reaps this run's services: without a
    // readable power.json they would be unmanageable forever.
    const state: PowerState = {
      mode: "standalone",
      started_at: hubReused ? (prior?.mode === "standalone" ? prior.started_at : new Date().toISOString()) : new Date().toISOString(),
      hub: { url: hubUrl, port: hubPort, ...hubFacts },
      notifier: { event_port: eventPort, ...notifyFacts },
      watcher,
    };
    try {
      await writePowerState(storageDir, state);
    } catch (error) {
      reap();
      throw error;
    }
    // Registry policy : up NEVER rewrites the registry. Any
    // read-filter-rewrite here races with concurrent launch appends (a lost
    // update deletes a freshly registered live member); stale lines are
    // harmless because attribution only trusts live, token-matching pids,
    // and the whole file is dropped after a VERIFIED full stop (down).
    process.stdout.write(`up: power state recorded (${path.join(".context-hub", "power.json")}; stop with tut down)\n`);
    return 0;
  } catch (error) {
    // : EVERY late failure (state write, log open, …) reaps this run's
    // services — a half-delivered rig must not survive a failed up.
    reap();
    process.stderr.write(`tut: up: ${(error as Error).message}\n`);
    return 1;
  } finally {
    releaseLock?.();
  }
}

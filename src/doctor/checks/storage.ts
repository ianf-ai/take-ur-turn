import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { LEGACY_TASK_ID_PATTERN, recordFileVersion, StoreError, validateMetaArtifact, validateRecordArtifact } from "../../hub/store.js";
import { worst, isErrnoException } from "../shared.js";
import type { DoctorCheck, DoctorContext, DoctorStatus } from "../types.js";
import type { HubOutcome } from "./hub.js";

/** The delivery.log rotation cap (rotates at 5 MiB, keeping one .1) — an
 *  over-limit live log means rotation is failing (rename degradation). */
const DELIVERY_LOG_MAX_BYTES = 5 * 1024 * 1024;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- check 5: storage -----------------------------------------------------------

interface TaskFinding {
  text: string;
  level: DoctorStatus;
  /** Repair entry this finding points at (A = repair-meta, B = recover-record). */
  fixCommand?: string;
}

interface TaskScan {
  status: DoctorStatus;
  findings: TaskFinding[];
}

/** Authoritative artifact classification: the SAME
 *  validators the Store's read path uses, shared via export — doctor must
 *  never call healthy what /state degrades. Returns null when valid, else
 *  the StoreError message (evidence for the finding). */
function recordArtifactProblem(value: unknown, fileName: string, taskId: string): string | null {
  try {
    validateRecordArtifact(value, fileName, taskId);
    return null;
  } catch (e) {
    if (e instanceof StoreError) return e.message;
    throw e;
  }
}

function metaArtifactProblem(value: unknown, fileName: string, taskId: string): string | null {
  try {
    validateMetaArtifact(value, fileName, taskId);
    return null;
  } catch (e) {
    if (e instanceof StoreError) return e.message;
    throw e;
  }
}

interface RecoveryLine {
  file: string;
  corrupt_sha256: string;
  recovered_sha256: string;
  recovered_file: string;
  source?: string;
}

/** recovery.jsonl lines as the Store's readRecoveryEntries sees them:
 *  BOTH syntax errors and schema-invalid lines (valid JSON, wrong field
 *  shapes — e.g. {"file":42}) are skipped by the Store; doctor counts them
 *  ALL as unparseable so a rotting manifest is never silently ignored. */
function parseRecoveryManifest(raw: string): { entries: RecoveryLine[]; unparseable: number } {
  const entries: RecoveryLine[] = [];
  let unparseable = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof parsed.file === "string" &&
        typeof parsed.corrupt_sha256 === "string" &&
        typeof parsed.recovered_sha256 === "string" &&
        typeof parsed.recovered_file === "string"
      ) {
        entries.push(parsed as unknown as RecoveryLine);
      } else {
        unparseable += 1; // schema-invalid line — skipped by the Store too
      }
    } catch {
      unparseable += 1;
    }
  }
  return { entries, unparseable };
}

/** recovery.jsonl as the Store's readRecoveryEntries sees it: an absent
 *  file is fine; a file that exists but cannot be READ is
 *  a diagnosable error (the Store turns it into VALIDATION_ERROR → degraded,
 *  so doctor must surface it, not swallow it as "no manifest");
 *  unparseable lines are SKIPPED, not fatal — the last VALID registration
 *  still stands. */
type ManifestRead =
  | { status: "absent" }
  | { status: "unreadable"; error: string }
  | { status: "ok"; entries: RecoveryLine[]; unparseable: number };

async function readRecoveryManifest(taskDir: string): Promise<ManifestRead> {
  let raw: string;
  try {
    raw = await readFile(path.join(taskDir, "recovery.jsonl"), "utf8");
  } catch (e) {
    if (isErrnoException(e, "ENOENT")) return { status: "absent" };
    return { status: "unreadable", error: (e as Error).message };
  }
  const { entries, unparseable } = parseRecoveryManifest(raw);
  return { status: "ok", entries, unparseable };
}

/** Mirror of the store's recovery consumption rule (system-design 4.3 B):
 *  the LAST valid registration for the file stands in iff the digest chain
 *  holds AND the copy passes the Store's own artifact validation for this
 *  task (same rule as recoveredRecordFor: a recovered
 *  stand-in is exactly as well-formed as a normally landed record). Doctor's
 *  copy is diagnostic — the hub remains the classification authority. */
async function recoveryVerdict(
  taskDir: string,
  taskId: string,
  fileName: string,
  corruptBytes: Buffer,
  manifest: ManifestRead,
): Promise<{ recovered: boolean; note: string; source?: string; manifestWarning?: string }> {
  const skipNote = (base: string): string =>
    manifest.status === "ok" && manifest.unparseable > 0
      ? `${base}; ${manifest.unparseable} unparseable manifest line(s) skipped`
      : base;
  if (manifest.status === "absent") return { recovered: false, note: "no recovery.jsonl" };
  if (manifest.status === "unreadable") {
    return {
      recovered: false,
      note: `recovery.jsonl unreadable (${manifest.error}) — the Store treats this as VALIDATION_ERROR (task stays degraded)`,
    };
  }
  const last = [...manifest.entries].reverse().find((e) => e.file === fileName);
  if (last === undefined) return { recovered: false, note: skipNote("no registration for this file") };
  if (sha256(corruptBytes) !== last.corrupt_sha256) {
    return { recovered: false, note: skipNote("registration void: corrupt original was modified after registration") };
  }
  let copyBytes: Buffer;
  try {
    copyBytes = await readFile(path.join(taskDir, last.recovered_file));
  } catch {
    return { recovered: false, note: skipNote("registered .recovered copy is missing") };
  }
  if (sha256(copyBytes) !== last.recovered_sha256) {
    return { recovered: false, note: skipNote("registered .recovered copy digest mismatch") };
  }
  try {
    const parsed: unknown = JSON.parse(copyBytes.toString("utf8"));
    const problem = recordArtifactProblem(parsed, last.recovered_file, taskId);
    if (problem !== null) return { recovered: false, note: skipNote(`recovered copy malformed: ${problem}`) };
    if ((parsed as { version?: unknown }).version !== recordFileVersion(fileName)) {
      return { recovered: false, note: skipNote("recovered copy version does not match the file name") };
    }
  } catch (e) {
    return { recovered: false, note: skipNote(`recovered copy unparseable: ${(e as Error).message}`) };
  }
  return {
    recovered: true,
    note: "recovered (digest chain verifies)",
    ...(last.source !== undefined ? { source: last.source } : {}),
    ...(manifest.unparseable > 0
      ? {
          manifestWarning:
            `${manifest.unparseable} unparseable manifest line(s) skipped — the Store consumes the last valid registration (readRecoveryEntries semantics)`,
        }
      : {}),
  };
}

async function scanTaskDir(taskDir: string, taskId: string): Promise<TaskScan> {
  const findings: TaskFinding[] = [];
  const statuses: DoctorStatus[] = [];

  // meta.json — class A damage surface. The Store's own meta validator
  // decides (task identity, required fields, flow/cast/checkout domains):
  // what doctor calls class A is exactly what /state degrades.
  let metaVersion: number | undefined;
  try {
    const raw = await readFile(path.join(taskDir, "meta.json"), "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      const problem = metaArtifactProblem(parsed, "meta.json", taskId);
      if (problem !== null) throw new Error(problem);
      metaVersion = (parsed as { version: number }).version;
    } catch (e) {
      statuses.push("fail");
      findings.push({
        text: `meta.json: malformed (${(e as Error).message}) — class A damage (records intact; task reports degraded)`,
        level: "fail",
        fixCommand: `tut repair-meta ${taskId} --title <title>   (version is rebuilt server-side from the record files)`,
      });
    }
  } catch (e) {
    statuses.push("fail");
    findings.push({
      text: `meta.json: ${isErrnoException(e, "ENOENT") ? "missing (create interrupted?)" : `unreadable (${(e as Error).message})`} — class A damage`,
      level: "fail",
      fixCommand: `tut repair-meta ${taskId} --title <title>   (version is rebuilt server-side from the record files)`,
    });
  }

  // record files — class B damage surface (recovery aware).
  let names: string[];
  try {
    names = await readdir(taskDir);
  } catch (e) {
    statuses.push("fail");
    findings.push({ text: `task dir unreadable: ${(e as Error).message}`, level: "fail" });
    return { status: worst(statuses), findings };
  }
  const recordNames = names
    .filter((n) => recordFileVersion(n) !== null)
    .sort((a, b) => recordFileVersion(a)! - recordFileVersion(b)!);
  // Version-domain scan mirrors derive's own classification (state-machine
  // prevVersion walk): leading gaps (records starting above
  // v1) and duplicate versions (multiple files claiming one version) are the
  // two shapes a plain adjacent-pair comparison misses.
  const byVersion = new Map<number, string[]>();
  for (const name of recordNames) {
    const v = recordFileVersion(name)!;
    byVersion.set(v, [...(byVersion.get(v) ?? []), name]);
  }
  // The walk is derive's own: prevVersion steps over the sorted FILES (one
  // file = one record), not over unique versions — grouping first would hide
  // duplicates by construction.
  let prevVersion = 0;
  for (const name of recordNames) {
    const v = recordFileVersion(name)!;
    if (v === prevVersion) {
      const namesForV = byVersion.get(v)!;
      statuses.push("warn");
      findings.push({
        text:
          `duplicate version (VERSION_DUPLICATE): v${v} present in ${namesForV.length} files (${namesForV.join(", ")}) — ` +
          "derive warns VERSION_DUPLICATE + needs_attention",
        level: "warn",
      });
    } else if (v !== prevVersion + 1) {
      statuses.push("warn");
      findings.push({
        text:
          `version gap (VERSION_GAP): v${prevVersion + 1}..v${v - 1} missing` +
          (prevVersion === 0
            ? ` — records start at v${v} (leading gap)`
            : ` between v${String(prevVersion).padStart(3, "0")} and ${name}`) +
          " — deleted records (append-only invariant) or interrupted writes; derive warns VERSION_GAP + needs_attention",
        level: "warn",
      });
    }
    prevVersion = v;
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  // recovery.jsonl once, with the Store's read semantics:
  // unreadable is a diagnosable failure, unparseable lines are skipped.
  const manifest = await readRecoveryManifest(taskDir);
  if (manifest.status === "unreadable") {
    statuses.push("fail");
    findings.push({
      text:
        `recovery.jsonl: unreadable (${manifest.error}) — the Store's readRecoveryEntries turns this into VALIDATION_ERROR (task stays degraded); registrations cannot be consumed`,
      level: "fail",
      fixCommand: `restore read access to tasks/${taskId}/recovery.jsonl (fix permissions / clear whatever squats on the name) — recoveries are dead until then`,
    });
  }
  // Bad manifest lines are visible even with NO damaged records: a rotting
  // manifest warns on its own — the Store's skip
  // semantics are unchanged, only their visibility is doctor's to add.
  if (manifest.status === "ok" && manifest.unparseable > 0) {
    statuses.push("warn");
    findings.push({
      text:
        `recovery.jsonl: ${manifest.unparseable} line(s) skipped (unparseable or wrong shape) — the Store consumes only well-formed registrations; the last valid one stands`,
      level: "warn",
    });
  }
  const registered = manifest.status === "ok" ? new Set(manifest.entries.map((e) => e.file)) : null;
  for (const name of recordNames) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(taskDir, name));
    } catch (e) {
      statuses.push("fail");
      findings.push({
        text: `${name}: unreadable (${(e as Error).message}) — class B damage`,
        level: "fail",
        fixCommand: `tut recover-record ${taskId} ${name} --from <external-snapshot-path> --source <origin>   (corrupt bytes stay pinned)`,
      });
      continue;
    }
    let problem: string | null;
    try {
      problem = recordArtifactProblem(JSON.parse(bytes.toString("utf8")), name, taskId);
    } catch (e) {
      problem = (e as Error).message;
    }
    if (problem === null) continue;
    const verdict = await recoveryVerdict(taskDir, taskId, name, bytes, manifest);
    if (verdict.recovered) {
      findings.push({
        text:
          `${name}: corrupt on disk but ${verdict.note}${verdict.source !== undefined ? ` (source: ${verdict.source})` : ""}` +
          (verdict.manifestWarning !== undefined ? ` — WARNING: ${verdict.manifestWarning}` : ""),
        level: verdict.manifestWarning !== undefined ? "warn" : "ok",
      });
      if (verdict.manifestWarning !== undefined) statuses.push("warn");
      continue;
    }
    statuses.push("fail");
    findings.push({
      text: `${name}: corrupt (${problem}) and unrecovered — ${verdict.note} — class B damage`,
      level: "fail",
      fixCommand: `tut recover-record ${taskId} ${name} --from <external-snapshot-path> --source <origin>   (corrupt bytes stay pinned)`,
    });
  }
  // Orphan recovered copies (registration lost) never fold — visible here.
  // With an unreadable manifest the registration set is unknowable: skip
  // rather than misreport every copy as orphan (the unreadable finding above
  // already fails the task).
  for (const name of names) {
    if (registered !== null && name.endsWith(".recovered") && !registered.has(name.slice(0, -".recovered".length))) {
      statuses.push("warn");
      findings.push({
        text: `${name}: recovered copy without a matching registration line — never consumed by the fold`,
        level: "warn",
      });
    }
  }
  // meta.version vs on-disk max — the crash window the store heals itself.
  if (metaVersion !== undefined && versions.length > 0) {
    const maxOnDisk = versions[versions.length - 1]!;
    if (metaVersion !== maxOnDisk) {
      findings.push({
        text: `meta.version=${metaVersion} vs on-disk max v${maxOnDisk} — crash-window skew; the next append reconciles from the disk max`,
        level: "ok",
      });
    }
  }
  return { status: worst(statuses), findings };
}

async function checkStorage(ctx: DoctorContext, hub: HubOutcome): Promise<DoctorCheck> {
  const check: DoctorCheck = {
    name: "storage",
    title: "storage health",
    status: "ok",
    summary: "",
    details: [],
  };
  const statuses: DoctorStatus[] = [];
  const tasksDir = path.join(ctx.root, "tasks");
  let entries;
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch (e) {
    if (isErrnoException(e, "ENOENT")) {
      check.summary = `no storage yet (${ctx.root} absent) — run tut init / tut serve from the project root, or pass --root`;
      return check;
    }
    check.status = "fail";
    check.summary = `cannot read ${tasksDir}: ${(e as Error).message}`;
    return check;
  }
  const taskDirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  let scanned = 0;
  const damaged: string[] = [];
  for (const name of taskDirNames.sort()) {
    // Same task-id domain the store enforces; anything else is invisible to
    // the hub by construction — surfacing it is exactly doctor's job.
    if (!LEGACY_TASK_ID_PATTERN.test(name)) {
      statuses.push("warn");
      check.details.push(`tasks/${name}: foreign directory name — the hub ignores it entirely`);
      continue;
    }
    scanned += 1;
    const scan = await scanTaskDir(path.join(tasksDir, name), name);
    for (const finding of scan.findings) {
      check.details.push(`tasks/${name}: ${finding.text}`);
      if (finding.fixCommand !== undefined) check.details.push(`  fix: ${finding.fixCommand}`);
    }
    if (scan.status === "fail") {
      statuses.push("fail");
      damaged.push(name);
    } else if (scan.status === "warn") {
      statuses.push("warn");
    }
  }
  // Leftover temp files — crash residue the store sweeps opportunistically.
  const tmpCount = entries.filter((e) => e.isFile() && e.name.includes(".tmp")).length;
  if (tmpCount > 0) {
    check.details.push(`${tmpCount} leftover temp file(s) under tasks/ — crash residue; the hub sweeps aged temps on its next append`);
  }
  // delivery.log — rotates at 5 MiB (one .1 generation kept).
  for (const logName of ["delivery.log", "delivery.log.1"]) {
    try {
      const info = await stat(path.join(ctx.root, logName));
      if (logName === "delivery.log" && info.size > DELIVERY_LOG_MAX_BYTES) {
        statuses.push("warn");
        check.details.push(
          `${logName}: ${info.size} bytes exceeds the ${DELIVERY_LOG_MAX_BYTES}-byte rotation cap — rotation is failing (check write/rename errors)`,
        );
      } else {
        check.details.push(`${logName}: ${info.size} bytes`);
      }
    } catch {
      // absent — fine
    }
  }
  // Cross-check against the hub's own view when it answered.
  if (hub.check.status !== "fail") {
    const unseenByDoctor = hub.degraded.filter((id) => !damaged.includes(id));
    if (unseenByDoctor.length > 0) {
      statuses.push("warn");
      check.details.push(
        `hub reports degraded but this scan finds no damage: ${unseenByDoctor.join(", ")} — the hub is the classification authority; with shared validators this means a race (files changed between reads) or a hub-side read error (see the hub's stderr)`,
      );
    }
  }
  check.status = worst(statuses);
  check.summary =
    damaged.length > 0
      ? `${scanned} task dir(s) scanned — damaged: ${damaged.join(", ")} (class + fix in details)`
      : `${scanned} task dir(s) scanned — no storage-level damage`;
  check.details.push(
    "boundary: a whole deleted task directory is invisible to any indexless scanner — the Notifier's snapshot diff is that detection path (system-design 4.3 C)",
  );
  return check;
}

export { checkStorage };

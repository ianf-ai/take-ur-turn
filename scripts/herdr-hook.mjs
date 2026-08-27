#!/usr/bin/env node
/**
 * Canonical Herdr plugin hook — pane.agent_status_changed → on-agent-event.mjs
 * (system-design 7.2 signal-source contract).
 *
 * Empirical payload (herdr 0.8, delivered on stdin here): the JSON envelope
 *   {"event":"pane_agent_status_changed","data":{"pane_id":"w1:p1",
 *    "workspace_id":"w1","agent_status":"idle|working|blocked|done|unknown",
 *    "agent":"codex"|null}}
 * carries NO task_id and NO pane label, so this hook:
 *   1. reads stdin to EOF and parses the payload (bad JSON → stderr, exit 0);
 *   2. filters: no pane_id, no agent, or status outside idle|working|blocked|
 *      done → ignored (not a TUT agent pane);
 *   3. maps herdr status → TUT event: working/blocked/done pass through; idle
 *      AFTER working → done (a finished turn in a focused/seen tab reports
 *      "idle", not "done" — without this, cross-validation never fires for
 *      watched panes); idle otherwise (launch-time detection, done-then-seen,
 *      blocked-then-answered) → ignored, avoiding false alerts;
 *   4. keeps per-pane last status under HERDR_PLUGIN_STATE_DIR (fallback
 *      os.tmpdir()/tut-herdr-state), one file per pane named SHA-256(pane_id),
 *      written atomically (temp file + rename);
 *   5. resolves pane_id → pane label via `herdr pane get` on raw argv — if the
 *      label cannot be obtained it does NOT guess and forwards the raw pane_id;
 *   6. spawns the sibling canonical entry on-agent-event.mjs with
 *      process.execPath, shell:false (package-relative absolute path).
 * Every degradation is stderr + exit 0: a lost event is acceptable because
 * polling is the primary channel (system-design 6.1).
 *
 * scripts/hook.sh is the POSIX thin shim over this file; the Windows Herdr
 * manifest uses a command array of absolute node + absolute herdr-hook.mjs.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const KNOWN_STATUSES = new Set(["idle", "working", "blocked", "done"]);
const PANE_GET_TIMEOUT_MS = 5000;
const EVENT_CHILD_TIMEOUT_MS = 10000;

/** Package-relative sibling of the canonical event entry (works in repo and pack). */
const ON_AGENT_EVENT = join(dirname(fileURLToPath(import.meta.url)), "on-agent-event.mjs");

const diag = (message) => process.stderr.write(`herdr-hook: ${message}\n`);

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** Resolve the Herdr control executable without a shell (TUT_HERDR_EXECUTABLE escape hatch). */
function herdrExecutable() {
  const configured = process.env.TUT_HERDR_EXECUTABLE;
  if (nonEmptyString(configured)) return configured;
  return process.platform === "win32" ? "herdr.exe" : "herdr";
}

async function readPreviousState(stateFile) {
  try {
    return (await readFile(stateFile, "utf8")).trim();
  } catch {
    return "";
  }
}

/** Atomic state write: temp file in the same directory, then rename over the target. */
async function writeStateAtomically(stateRoot, stateFile, status) {
  await mkdir(stateRoot, { recursive: true });
  const temp = join(stateRoot, `.${basename(stateFile)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temp, status, "utf8");
  await rename(temp, stateFile);
}

/**
 * pane_id → pane label via `herdr pane get <pane_id>` on raw argv. Resolves to
 * null when the label cannot be obtained (spawn error, non-zero exit, invalid
 * JSON, empty label) — the caller then forwards the raw pane_id, never a guess.
 */
function resolvePaneLabel(paneId) {
  return new Promise((resolve) => {
    const child = spawn(herdrExecutable(), ["pane", "get", paneId], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (label) => {
      if (settled) return;
      settled = true;
      resolve(label);
    };
    const timer = setTimeout(() => {
      child.kill();
      diag(`pane get timed out after ${PANE_GET_TIMEOUT_MS}ms`);
      finish(null);
    }, PANE_GET_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      diag(`pane get failed: ${error.message}`);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        diag(`pane get exited ${code ?? "by signal"}`);
        return finish(null);
      }
      try {
        const parsed = JSON.parse(stdout);
        const label = isRecord(parsed) && isRecord(parsed.result) && isRecord(parsed.result.pane)
          ? parsed.result.pane.label
          : undefined;
        finish(nonEmptyString(label) ? label : null);
      } catch {
        diag("pane get returned invalid JSON");
        finish(null);
      }
    });
  });
}

/** Forward through the sibling canonical entry (process.execPath, shell:false). */
function forwardEvent(event, agent, pane) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ON_AGENT_EVENT, event, agent, pane], {
      shell: false,
      stdio: ["ignore", "ignore", "inherit"],
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      diag(`on-agent-event timed out after ${EVENT_CHILD_TIMEOUT_MS}ms`);
      finish();
    }, EVENT_CHILD_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      diag(`on-agent-event spawn failed: ${error.message}`);
      finish();
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    diag("bad payload: stdin is not JSON");
    return;
  }
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
  const paneId = data.pane_id;
  const agent = data.agent;
  const status = data.agent_status;
  if (!nonEmptyString(paneId) || !nonEmptyString(agent) || !nonEmptyString(status)) {
    diag("bad payload: pane_id, agent or agent_status missing/empty");
    return;
  }
  if (!KNOWN_STATUSES.has(status)) {
    diag(`unknown agent_status ${JSON.stringify(status)}; ignored`);
    return;
  }

  const stateRoot = nonEmptyString(process.env.HERDR_PLUGIN_STATE_DIR)
    ? process.env.HERDR_PLUGIN_STATE_DIR
    : join(tmpdir(), "tut-herdr-state");
  const stateFile = join(stateRoot, createHash("sha256").update(paneId, "utf8").digest("hex"));
  const previous = await readPreviousState(stateFile);

  let event = null;
  if (status === "working" || status === "blocked" || status === "done") {
    event = status;
  } else if (status === "idle" && previous === "working") {
    // Focused/seen-tab finish reports idle; the turn did end.
    event = "done";
  }

  try {
    await writeStateAtomically(stateRoot, stateFile, status);
  } catch (error) {
    diag(`state write failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (event === null) return;
  const resolvedLabel = await resolvePaneLabel(paneId);
  await forwardEvent(event, agent, resolvedLabel ?? paneId);
}

try {
  await main();
} catch (error) {
  diag(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);

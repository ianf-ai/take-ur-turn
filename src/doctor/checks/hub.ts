import path from "node:path";
import { canonicalRoot } from "../../hub/rig-discovery.js";
import { DOCTOR_HUB_TIMEOUT_MS } from "../constants.js";
import { worst } from "../shared.js";
import type { DoctorCheck, DoctorContext } from "../types.js";

// --- check 1: hub --------------------------------------------------------------

interface HubStateView {
  hub_root?: string;
  flow_mode?: string;
  tasks?: Array<{ task_id: string; needs_attention?: boolean }>;
  degraded?: string[];
  auto?: { launch_roles: string[] };
}

interface HubOutcome {
  verified?: { root: string; url: string };
  check: DoctorCheck;
  /** The hub's degraded list when it answered (empty otherwise). */
  degraded: string[];
}

/** /state's own value domains (http.ts handleState): flow_mode selects the
 *  mode table; task entries carry typed fields. Doctor validates what the
 *  endpoint emits — an impersonating or drifted service fails loudly. */
const STATE_FLOW_MODES = new Set(["manual", "auto"]);
const STATE_TASK_FLOWS = new Set(["full", "direct", "solo"]);
const STATE_TASK_STRING_FIELDS = ["title", "status", "updated_at", "waiting_for"] as const;

/** Shape gate for a /state body: malformed
 *  documents — null task entries, non-array auto.launch_roles, wrong-typed
 *  task fields, out-of-domain flow values — are failure items with the
 *  offending field named, never a crash in the consumer. Returns null when
 *  the body is usable. */
function stateBodyProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "body is not an object";
  const body = value as Record<string, unknown>;
  if (typeof body.flow_mode !== "string" || !STATE_FLOW_MODES.has(body.flow_mode)) {
    return `flow_mode must be manual|auto, got: ${typeof body.flow_mode === "string" ? `'${body.flow_mode}'` : typeof body.flow_mode}`;
  }
  if (!Array.isArray(body.tasks)) return "tasks is not an array";
  for (const [i, entry] of body.tasks.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return `tasks[${i}] is not a task object`;
    const task = entry as Record<string, unknown>;
    if (typeof task.task_id !== "string" || task.task_id.length === 0) return `tasks[${i}].task_id missing or empty`;
    for (const field of STATE_TASK_STRING_FIELDS) {
      if (task[field] !== undefined && typeof task[field] !== "string") return `tasks[${i}].${field} must be a string`;
    }
    if (task.needs_attention !== undefined && typeof task.needs_attention !== "boolean") {
      return `tasks[${i}].needs_attention must be a boolean`;
    }
    if (task.version !== undefined &&
        (typeof task.version !== "number" || !Number.isInteger(task.version) || task.version < 0)) {
      return `tasks[${i}].version must be an integer ≥ 0`;
    }
    if (task.flow !== undefined && (typeof task.flow !== "string" || !STATE_TASK_FLOWS.has(task.flow))) {
      return `tasks[${i}].flow must be one of full|direct|solo`;
    }
    for (const field of ["cast", "checkout"] as const) {
      if (task[field] !== undefined &&
          (typeof task[field] !== "object" || task[field] === null || Array.isArray(task[field]))) {
        return `tasks[${i}].${field} must be an object`;
      }
    }
  }
  if (body.degraded !== undefined &&
      (!Array.isArray(body.degraded) || body.degraded.some((d) => typeof d !== "string"))) {
    return "degraded is not a string array";
  }
  if (body.auto !== undefined) {
    const auto = body.auto;
    if (typeof auto !== "object" || auto === null || Array.isArray(auto) ||
        !Array.isArray((auto as Record<string, unknown>).launch_roles) ||
        ((auto as Record<string, unknown>).launch_roles as unknown[]).some((r) => typeof r !== "string")) {
      return "auto.launch_roles is not a string array";
    }
  }
  return null;
}

async function checkHub(ctx: DoctorContext): Promise<HubOutcome> {
  const check: DoctorCheck = {
    name: "hub",
    title: "hub reachable",
    status: "ok",
    summary: "",
    details: [],
  };
  let hubUrl: URL;
  try {
    hubUrl = new URL(ctx.url);
  } catch (e) {
    check.status = "fail";
    check.summary = `invalid hub URL '${ctx.url}' (${(e as Error).message})`;
    check.details.push("a hub URL must be absolute, like http://127.0.0.1:3001");
    check.fix = "pass a valid --url (e.g. --url http://127.0.0.1:3001)";
    return { check, degraded: [] };
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hubUrl.hostname);
  if (!loopback) {
    check.status = "warn";
    check.details.push(
      `hub URL host '${hubUrl.hostname}' is not loopback — the hub's DNS-rebinding guard 403s non-loopback Host headers and sandboxed agents lose any loopback exemption`,
    );
  }
  let parsed: unknown = null;
  try {
    const res = await ctx.fetchImpl(new URL("/state", hubUrl), {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(DOCTOR_HUB_TIMEOUT_MS), redirect: "manual",
    });
    if (!res.ok) {
      check.status = "fail";
      check.summary = `hub answered HTTP ${res.status} on ${ctx.url}/state — not a healthy Context Hub`;
      check.fix = "tut serve   (or: tut up)";
      return { check, degraded: [] };
    }
    parsed = await res.json().catch(() => null);
  } catch (e) {
    check.status = "fail";
    check.summary = `cannot reach hub at ${ctx.url}/state (${(e as Error).message})`;
    check.fix = "tut serve   (or: tut up)";
    return { check, degraded: [] };
  }
  const problem = stateBodyProblem(parsed);
  if (problem !== null) {
    check.status = "fail";
    check.summary = `${ctx.url}/state answered 200 but the body is not a TUT /state document (${problem})`;
    check.fix = "tut serve   (restart on this port — another service may be impersonating the hub)";
    return { check, degraded: [] };
  }
  const body = parsed as HubStateView;
  if (typeof body.hub_root !== "string" || !path.isAbsolute(body.hub_root) || canonicalRoot(body.hub_root) !== ctx.hubRoot) {
    check.status = "fail";
    check.summary = `Hub ownership mismatch: hub_root=${body.hub_root ?? "unknown"}, expected ${ctx.hubRoot}`;
    check.fix = `run tut up in workspace ${ctx.hubRoot}; verify --url or upgrade/restart a Hub missing identity`;
    return { check, degraded: [] };
  }
  const tasks = body.tasks ?? [];
  const attention = tasks.filter((t) => t.needs_attention === true).length;
  const degraded = body.degraded ?? [];
  check.summary =
    `reachable at ${ctx.url}/state — flow_mode=${body.flow_mode}, ${tasks.length} task(s)` +
    (attention > 0 ? `, ${attention} needs_attention` : "");
  check.details.push(
    `flow_mode=${body.flow_mode}` +
      (body.auto !== undefined
        ? `, auto.launch_roles=[${body.auto.launch_roles.join(",")}]`
        : ", auto whitelist unset (auto mode withholds all launches)"),
  );
  if (degraded.length > 0) {
    check.status = worst([check.status, "warn"]);
    check.details.push(`hub reports degraded (storage-damaged) tasks: ${degraded.join(", ")}`);
    check.details.push("class/file-level diagnosis: see the storage check below");
  }
  return { check, degraded, verified: { root: ctx.hubRoot, url: ctx.url } };
}

export { checkHub };
export type { HubOutcome };

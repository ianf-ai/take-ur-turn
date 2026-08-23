/**
 * Shared launch provenance and de-duplication helpers.
 *
 * A launch is represented by an ordinary task-scope note.  The state machine
 * deliberately ignores notes, so this gives the two launch doors (manual
 * `tut start-next` and Notifier auto mode) one append-only source of truth
 * without adding a new content type or state transition.
 */

import { hubPublish, hubRead, type HubPublishResult } from "./hub-client.js";
import { resolveAgent } from "./workspace.js";
import type { Cast, ContextRecord } from "./types.js";

export type LaunchVia = "start-next" | "auto";

export interface LaunchDecision {
  blocked: boolean;
  /** Version of the launch note that blocks the requested role, when blocked. */
  noteVersion?: number;
}

export interface LaunchMarker {
  role: string;
  base_version: number;
  via: LaunchVia;
}

/** Return the greatest record version in a log, or zero for a newly-created task. */
export function latestRecordVersion(records: readonly ContextRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.version), 0);
}

function launchMarkerOf(record: ContextRecord): LaunchMarker | undefined {
  if (record.content_type !== "note") return undefined;
  const candidate = record.payload.launch;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const marker = candidate as Partial<LaunchMarker>;
  if (typeof marker.role !== "string") return undefined;
  return marker as LaunchMarker;
}

/**
 * Decide whether a role has already been launched in the current round.
 *
 * A launch note is valid only until the next non-note record.  Sorting by
 * version keeps this pure helper deterministic even if a caller supplies the
 * records out of order, matching state-machine derivation semantics.
 */
export function launchBlocked(records: readonly ContextRecord[], role: string): LaunchDecision {
  let lastContentVersion = 0;
  let latestMarkerVersion: number | undefined;

  const ordered = [...records].sort((a, b) => a.version - b.version);
  for (const record of ordered) {
    if (record.content_type === "note") {
      if (launchMarkerOf(record)?.role === role) latestMarkerVersion = record.version;
      continue;
    }
    lastContentVersion = Math.max(lastContentVersion, record.version);
  }

  if (latestMarkerVersion !== undefined && latestMarkerVersion > lastContentVersion) {
    return { blocked: true, noteVersion: latestMarkerVersion };
  }
  return { blocked: false };
}

function launchSummary(role: string, baseVersion: number): string {
  return `launch: ${role} (base v${baseVersion})`;
}

function launchBody(role: string, baseVersion: number, via: LaunchVia): string {
  return `Recorded launch of ${role} via ${via} at task log base version ${baseVersion}.`;
}

/** Read the full task log used by launch de-duplication. */
export async function readLaunchLog(url: string, taskId: string): Promise<ContextRecord[]> {
  return (await hubRead(url, taskId)).versions;
}

export interface LaunchTarget {
  /** Agent name the launcher should raise for the role. */
  agent: string;
  /** The task's cast, when /state exposes one (for callers that want the whole picture). */
  cast?: Cast;
}

/**
 * Launch-target resolution shared by both launch doors (start-next /
 * auto): read the task's cast from GET /state, then run the agent chain
 * (cast → three-level workspace chain: project .context-hub → user config
 * → DEFAULT_ROLES; cwd as project root). Pure read — side-effect free,
 * safe to call as a pre-check before the launch marker.
 */
export async function resolveLaunchTarget(url: string, taskId: string, role: string): Promise<LaunchTarget> {
  const res = await fetch(new URL("/state", url));
  if (!res.ok) throw new Error(`GET ${url}/state → HTTP ${res.status}`);
  const state = (await res.json()) as { tasks?: Array<{ task_id: string; cast?: Cast }> };
  const entry = state.tasks?.find((t) => t.task_id === taskId);
  if (entry === undefined) throw new Error(`task ${taskId} not in /state`);
  const cast = entry.cast;
  return { agent: await resolveAgent(role, cast), ...(cast !== undefined ? { cast } : {}) };
}

/**
 * Append a launch marker using the version observed by the caller.
 *
 * expected_version is intentionally required here: two launch doors that read
 * the same base version race at the Hub, and only the first can leave a marker.
 */
export async function markLaunched(
  url: string,
  taskId: string,
  role: string,
  baseVersion: number,
  via: LaunchVia,
): Promise<HubPublishResult> {
  return await hubPublish(url, {
    task_id: taskId,
    role: "human",
    content_type: "note",
    payload: {
      summary: launchSummary(role, baseVersion),
      body: launchBody(role, baseVersion, via),
      launch: { role, base_version: baseVersion, via },
    },
    expected_version: baseVersion,
  });
}

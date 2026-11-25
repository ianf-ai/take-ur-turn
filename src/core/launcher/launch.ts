/**
 * Shared launch provenance and de-duplication helpers.
 *
 * A launch is represented by an ordinary task-scope note.  The state machine
 * deliberately ignores notes, so this gives the two launch doors (manual
 * `tut start-next` and Notifier auto mode) one append-only source of truth
 * without adding a new content type or state transition.
 */

import { hubPublish, hubRead, type HubPublishResult } from "../../hub/hub-client.js";
import { latestStatusFlipVersion } from "../../hub/state-machine.js";
import { commandHead, commandArgs } from "../../protocol/agent-command.js";
import { resolveAgentRouteWithSource } from "../common/workspace.js";
import type { ResolveOptions } from "../common/workspace.js";
import type { AgentRoute, Cast, CheckoutRoute, ContextRecord, Flow, LaunchMarkerProjection, LaunchRouteSource } from "../../protocol/types.js";

export type LaunchVia = "start-next" | "auto";

export interface LaunchDecision {
  blocked: boolean;
  /** Version of the launch note that blocks the requested role, when blocked. */
  noteVersion?: number;
  /** Completed notes-only attempt to replace, verified by the detached owner. */
  recoveryVersion?: number;
}

/** Internal auto-only context. The caller establishes that this is a new edge;
 * the shared helper verifies its record before extending the dedup boundary. */
export interface NoteWake {
  version: number;
}

export function isWakeNote(record: ContextRecord): boolean {
  return record.content_type === "note" && record.payload.ack !== true && record.payload.launch === undefined;
}

export interface LaunchMarker {
  role: string;
  base_version: number;
  via: LaunchVia;
  protocol_version?: 2;
  route?: AgentRoute;
  route_source?: LaunchRouteSource;
  target_kind?: string;
  target_digest?: string;
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
 * Round-scoped: only a marker of the CURRENT waiting_for round dedups. The
 * round boundary is the record that started this round — the most recent
 * status flip (latestStatusFlipVersion); markers before it belong to earlier
 * rounds (e.g. the round-0 marker of a now-revising task) and never block.
 * Inside the round a launch note is valid until the next non-note record, or
 * a verified new note supplied by the auto consumer. The boundary MUST be
 * computed with the task's real flow — /state exposes it per task and every
 * launch consumer threads it here. An omitted flow keeps derivation's own
 * default table (absent = full) purely as a compatibility fallback for
 * inputs that genuinely carry no flow: replaying a direct/solo log under the
 * full table mis-derives the boundary (a plain worker note in a solo
 * implementing round reads as a reviewing→revising flip) and would wrongly
 * clear a valid same-round marker. Sorting by version keeps this pure helper
 * deterministic even if a caller supplies the records out of order, matching
 * state-machine derivation semantics.
 * Detached consumers may additionally supply verified completed notes-only
 * markers. Evidence is scoped to the exact marker version; it never exempts
 * a newer marker or changes log-only consumers such as Herdr.
 */
export function launchBlocked(records: readonly ContextRecord[], role: string, noteWake?: NoteWake, flow?: Flow, completedWithoutDelivery?: ReadonlySet<number>): LaunchDecision {
  const boundary = latestStatusFlipVersion(records, flow);
  let lastContentVersion = 0;
  let latestMarkerVersion: number | undefined;

  const ordered = [...records].sort((a, b) => a.version - b.version).filter(record => record.version > boundary);
  const candidates = noteWake === undefined ? [] : ordered.filter(record => record.version === noteWake.version);
  // Duplicate versions are corrupt evidence, not an unambiguous wake boundary.
  // The real /state attention gate also withholds such tasks.
  if (candidates.length === 1 && isWakeNote(candidates[0]!)) lastContentVersion = candidates[0]!.version;
  for (const record of ordered) {
    if (record.content_type === "note") {
      if (launchMarkerOf(record)?.role === role) latestMarkerVersion = record.version;
      continue;
    }
    lastContentVersion = Math.max(lastContentVersion, record.version);
  }

  if (latestMarkerVersion !== undefined && latestMarkerVersion > lastContentVersion) {
    // Callers without detached run evidence retain the log-only semantics.
    if (completedWithoutDelivery?.has(latestMarkerVersion)) return { blocked: false, recoveryVersion: latestMarkerVersion };
    return { blocked: true, noteVersion: latestMarkerVersion };
  }
  return { blocked: false };
}

/** Epoch-ms timestamp of the record that started the current waiting_for
 *  round (the latest status flip), or undefined while no record ever flipped
 *  the status (the initial round). Scopes stop-cancellation to the round the
 *  stop interrupted: a flip strictly after an observed stop starts a
 *  genuinely new round, and its candidates are not the cancelled ones. Pure
 *  function; the same flow discipline as launchBlocked. */
export function currentRoundStartedAt(records: readonly ContextRecord[], flow?: Flow): number | undefined {
  const flipVersion = latestStatusFlipVersion(records, flow);
  if (flipVersion <= 0) return undefined;
  const record = records.find(candidate => candidate.version === flipVersion);
  if (record === undefined) return undefined;
  const at = Date.parse(record.timestamp);
  return Number.isNaN(at) ? undefined : at;
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
  /** Agent executable name the launcher should raise for the role. */
  agent: string;
  /** Ordered route arguments; omitted for legacy bare routes. */
  args?: string[];
  /** The task's cast, when /state exposes one (for callers that want the whole picture). */
  cast?: Cast;
  /** The task's frozen checkout route, when /state exposes one. */
  checkout?: CheckoutRoute;
  /** Provenance of the normalized route for the canonical invocation planner. */
  route_source?: LaunchRouteSource;
}

/**
 * Launch-target resolution shared by both launch doors (start-next /
 * auto): read the task's cast from GET /state, then run the agent chain
 * (cast → three-level workspace chain: project .context-hub → user config
 * → DEFAULT_ROLES; cwd as project root). Pure read — side-effect free,
 * safe to call as a pre-check before the launch marker.
 */
export async function resolveLaunchTarget(url: string, taskId: string, role: string): Promise<LaunchTarget> {
  const target = await resolveLaunchTargetWithSource(url, taskId, role);
  const { route_source: _routeSource, ...compatibilityTarget } = target;
  return compatibilityTarget;
}

/** Resolve a target and retain the route provenance for canonical planning. */
export async function resolveLaunchTargetWithSource(
  url: string,
  taskId: string,
  role: string,
  resolveOptions: ResolveOptions = {},
): Promise<LaunchTarget> {
  const res = await fetch(new URL("/state", url), {
    headers: { Connection: "close" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET ${url}/state → HTTP ${res.status}`);
  const state = (await res.json()) as { tasks?: Array<{ task_id: string; cast?: Cast; checkout?: CheckoutRoute }> };
  const entry = state.tasks?.find((t) => t.task_id === taskId);
  if (entry === undefined) throw new Error(`task ${taskId} not in /state`);
  const cast = entry.cast;
  const resolved = await resolveAgentRouteWithSource(role, cast, resolveOptions);
  const route: AgentRoute = resolved.route;
  const normalizedAgent = commandHead(route);
  const args = commandArgs(route);
  return {
    agent: normalizedAgent,
    ...(args.length > 0 ? { args } : {}),
    ...(cast !== undefined ? { cast } : {}),
    ...(entry.checkout !== undefined ? { checkout: entry.checkout } : {}),
    route_source: resolved.source,
  };
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
  projection?: LaunchMarkerProjection,
): Promise<HubPublishResult> {
  if (projection !== undefined && (projection.role !== role || projection.base_version !== baseVersion || projection.via !== via)) {
    throw new Error("launch marker projection does not match the launch request");
  }
  const launch = projection === undefined
    ? { role, base_version: baseVersion, via }
    : {
        protocol_version: 2 as const,
        role: projection.role,
        base_version: projection.base_version,
        via: projection.via,
        route: { agent: projection.route.agent, args: [...projection.route.args] },
        route_source: projection.route_source,
        target_kind: projection.target_kind,
        target_digest: projection.target_digest,
      };
  return await hubPublish(url, {
    task_id: taskId,
    role: "human",
    content_type: "note",
    payload: {
      summary: launchSummary(role, baseVersion),
      body: launchBody(role, baseVersion, via),
      launch,
    },
    expected_version: baseVersion,
  });
}

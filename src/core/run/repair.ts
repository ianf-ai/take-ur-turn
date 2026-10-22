/** Disposition of unreadable run archives (tut repair-run).
 *
 *  All mechanics (locking, safe link-refusing reads, evidence renames) live
 *  in RunStore.repairArchive — the supported write channel; this module only
 *  classifies the safe inputs and maps the applied result. Two dispositions,
 *  one refusal class:
 *   - protocol repair: the write protocol lands meta atomically
 *     (meta.<hex>.tmp → rename → meta.json). A crash between write and
 *     rename — or a rename that outlived torn data blocks on power loss, or
 *     an initialize interrupted before its first rename — leaves a COMPLETE
 *     candidate tmp beside a missing/invalid meta.json. Adopting the newest
 *     tmp that passes the full validator IS the run protocol's own repair;
 *     the invalid previous bytes are still preserved under the quarantine
 *     name. Symlinked or non-regular artifacts are never adoption evidence.
 *   - quarantine: when no protocol artifact can restore the meta, the
 *     invalid meta.json is renamed to meta.json.broken[.<hex>] — bytes
 *     preserved for forensics, tut ps shows an explicit marker. The run log
 *     is NEVER touched: it is evidence material, and it is also the only
 *     remaining account of what the run did.
 *   - refusal: every modifying branch requires ALL identifiable writers to
 *     be provably dead — supervisor first (it lives OUTSIDE the run's
 *     process group and still writes session/end evidence after the group
 *     exits), then the root pid, then the group. A meta without supervisor
 *     evidence can only come from a pre-protocol writer (every current
 *     write validates supervisor_pid); such historical formats are
 *     disposable only in a terminal status (exited/stopped) with dead pid
 *     and group. Live, unknown or unproven writers are refused — nothing is
 *     modified. */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { probe, validateId, validateMeta, QUARANTINE_BASE, type RepairArtifact, type RepairDecision, type RepairMetaState, type RunMeta, type RunStore } from './store.js';

export { QUARANTINE_BASE };

export type RepairOutcome =
  | { disposition: 'already-valid'; run_id: string }
  | { disposition: 'repaired'; run_id: string; detail: string }
  | { disposition: 'quarantined'; run_id: string; detail: string }
  | { disposition: 'already-quarantined'; run_id: string }
  | { disposition: 'refused'; run_id: string; reason: string };

export interface RepairOptions { probe?: typeof probe }

/** The quarantine evidence file for an isolated archive (meta.json absent). */
export function quarantinedMarker(store: RunStore, id: string): string | undefined {
  validateId(id);
  const dir = store.directory(id);
  try {
    return readdirSync(dir).find(name => name === QUARANTINE_BASE || name.startsWith(`${QUARANTINE_BASE}.`));
  } catch { return undefined; }
}

interface LooseIdentity { pid?: unknown; pgid?: unknown; supervisor_pid?: unknown; status?: unknown }

/** null = all identifiable writers provably dead; otherwise the blocking reason. */
function writersBlocking(identity: LooseIdentity, probeFn: typeof probe): string | null {
  const supervisor = identity.supervisor_pid;
  if (Number.isSafeInteger(supervisor) && (supervisor as number) > 1) {
    const alive = probeFn(supervisor as number);
    if (alive === true) return `supervisor ${supervisor} is alive`;
    if (alive === null) return `supervisor ${supervisor} liveness unknown`;
  } else if (!['exited', 'stopped'].includes(identity.status as string)) {
    return 'no supervisor evidence and status is not terminal — historical writer completion unproven';
  }
  if (!Number.isSafeInteger(identity.pid) || (identity.pid as number) <= 1) return 'no safe pid evidence';
  const pidAlive = probeFn(identity.pid as number);
  if (pidAlive === true) return `pid ${identity.pid} is alive`;
  if (pidAlive === null) return `pid ${identity.pid} liveness unknown`;
  if (!Number.isSafeInteger(identity.pgid) || (identity.pgid as number) <= 1) return 'no safe pgid evidence';
  const groupAlive = probeFn(-(identity.pgid as number));
  if (groupAlive === true) return `process group ${identity.pgid} is alive`;
  if (groupAlive === null) return `process group ${identity.pgid} liveness unknown`;
  return null;
}

/** Comparable-identity conflicts between the parseable current meta and the
 *  candidate artifact: pid, pgid and supervisor are immutable per run
 *  (assertRunIdentity semantics) — any safe-int disagreement refuses. */
function identityConflict(original: LooseIdentity, candidate: RunMeta): string | undefined {
  for (const field of ['pid', 'pgid', 'supervisor_pid'] as const) {
    const o = original[field];
    if (Number.isSafeInteger(o) && o !== candidate[field]) {
      return `artifact identity (${field} ${candidate[field]}) differs from current meta (${field} ${o}) — never adopt across identities`;
    }
  }
  return undefined;
}

/** Newest validator-passing artifact, adopted only when BOTH the candidate's
 *  writers and every writer identifiable from the parseable current meta are
 *  provably dead, with no comparable-identity conflict. An unparseable or
 *  missing original contributes no identity — the artifact (the same run's
 *  pending write) is then the authority, preserving torn/first-write
 *  recovery. */
function pickAdoptable(id: string, originalParsed: LooseIdentity | undefined, getCandidates: () => RepairArtifact[], probeFn: typeof probe): RepairDecision | undefined {
  const candidates = getCandidates();
  if (candidates.length === 0) return undefined;
  const newest = candidates[0]!;
  const candidate = validateMeta(JSON.parse(newest.raw), id) as RunMeta;
  if (originalParsed !== undefined) {
    const conflict = identityConflict(originalParsed, candidate);
    if (conflict !== undefined) return { action: 'refuse', reason: conflict };
    const originalBlocking = writersBlocking(originalParsed, probeFn);
    if (originalBlocking !== null) return { action: 'refuse', reason: `current meta writers not provably dead: ${originalBlocking}` };
  }
  const blocking = writersBlocking(candidate, probeFn);
  if (blocking !== null) return { action: 'refuse', reason: `artifact not adopted: ${blocking}` };
  return { action: 'adopt', artifact: newest.name };
}

export function classifyRepair(id: string, meta: RepairMetaState, scanArtifacts: () => RepairArtifact[], options: RepairOptions = {}): RepairDecision {
  const probeFn = options.probe ?? probe;
  if (meta.kind === 'unsafe') {
    return { action: 'refuse', reason: `meta.json is a ${meta.reason} — refusing to follow or move it; manual disposition required` };
  }
  const candidates = (): RepairArtifact[] => {
    const validated = scanArtifacts()
      .filter(a => { try { validateMeta(JSON.parse(a.raw), id); return true; } catch { return false; } });
    return validated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  };
  if (meta.kind === 'absent') {
    // An adoptable artifact completes an interrupted initialize/adopt — the
    // pending promotion never overwrites earlier evidence (the isolate step
    // only runs when meta.json bytes exist).
    const adopt = pickAdoptable(id, undefined, candidates, probeFn);
    if (adopt !== undefined) return adopt;
    if (meta.isolatedMarker !== undefined) return { action: 'already-quarantined' };
    return { action: 'refuse', reason: 'meta.json missing (create interrupted?) and no adoptable complete artifact — evidence left intact' };
  }
  let parsed: LooseIdentity | undefined;
  try {
    const value: unknown = JSON.parse(meta.raw);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed = value as LooseIdentity;
  } catch { /* unparseable — no identity evidence */ }
  try {
    validateMeta(parsed as unknown, id);
    return { action: 'already-valid' };
  } catch { /* invalid — disposition below */ }
  // Adoption is considered even when the current bytes are unparseable: the
  // artifact is the same run's pending write, and ITS identity is the
  // authority for writer liveness (a parseable original adds its own
  // conflict and liveness checks).
  const adopt = pickAdoptable(id, parsed, candidates, probeFn);
  if (adopt !== undefined) return adopt;
  if (parsed === undefined) {
    return { action: 'refuse', reason: 'meta unparseable — process identity unknown, cannot prove writers dead; evidence left intact' };
  }
  const blocking = writersBlocking(parsed, probeFn);
  if (blocking !== null) return { action: 'refuse', reason: `${blocking}; refusing to modify a possibly-live archive — retry after it ends` };
  return { action: 'isolate' };
}

export async function repairRun(store: RunStore, id: string, options: RepairOptions = {}): Promise<RepairOutcome> {
  validateId(id);
  let applied: Awaited<ReturnType<RunStore['repairArchive']>>;
  try {
    applied = await store.repairArchive(id, (meta, artifacts) => classifyRepair(id, meta, artifacts, options));
  } catch (e) {
    return { disposition: 'refused', run_id: id, reason: `repair did not run: ${(e as Error).message}` };
  }
  switch (applied.applied) {
    case 'already-valid': return { disposition: 'already-valid', run_id: id };
    case 'already-quarantined': return { disposition: 'already-quarantined', run_id: id };
    case 'isolated': return { disposition: 'quarantined', run_id: id, detail: `invalid meta isolated as ${applied.isolatedAs}; run log preserved (never deleted)` };
    case 'adopted': return { disposition: 'repaired', run_id: id, detail: `adopted write artifact ${applied.adoptedFrom} as meta.json${applied.isolatedAs !== undefined ? `; invalid previous bytes preserved as ${applied.isolatedAs}` : ' (no previous meta on disk)'}` };
    case 'refused': return { disposition: 'refused', run_id: id, reason: applied.reason };
  }
}

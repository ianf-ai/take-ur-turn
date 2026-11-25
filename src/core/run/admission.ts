import {runSessionIdentities,contractSource,type ProfileSourceSnapshot} from '../../agents/public/index.js';
/**
 * Startup admission: cross-process exclusive admission for
 * resume and headless auto launches, built ONLY on RunStore facts —
 * incomplete runs and persisted startup intents — plus a rig-wide file lock
 * for the verify→reserve→spawn critical section.
 *
 * What blocks a new spawn:
 *  - any INCOMPLETE run carrying the same native session identity (agent +
 *    exact session id, matched structurally in argv or via the dedicated
 *    meta fields) — the source run, a previous resume, or an auto launch;
 *  - any PENDING/uncertain startup intent for the same identity (a failed
 *    handshake stays attributable; a KNOWN-FAILED intent does not block);
 *  - for managed (headless-owned) runs, additionally any incomplete run of
 *    the same task in ANY role (same-rig/task all-role seriality).
 *
 * Deliberately NOT admission evidence: a dead lock PID (the lock is only the
 * critical section, occupancy outlives it), the Notifier's in-memory map
 * (single-process only), or process-table liveness (the run protocol owns that domain).
 */
import { RunStore, complete, type RunMeta } from './store.js';

export interface SessionIdentity { agent: string; session_id: string }

export interface AdmissionOccupant {
  run_id: string;
  via: 'meta' | 'intent';
  /** Human-readable occupancy evidence (for refusal messages). */
  detail: string;
}

/** Structured session match: never a substring guess. The identities below
 *  are the only shapes TUT itself constructs — the observed/designed meta
 *  fields, the additive resume provenance (which exists for the resume's
 *  WHOLE lifetime, including the window before the native agent printed any
 *  session event), and argv selectors. codex's `exec resume <opts> <id>
 *  <prompt>` may carry options between `resume` and the id; the id can never
 *  be the trailing prompt position. Agent names compare by basename (routes
 *  may carry absolute paths). */
export function metaCarriesSession(meta: RunMeta, identity: SessionIdentity, snapshot=contractSource()): boolean {
  // Keep the legacy conservative cross-agent check for recorded native IDs.
  return runSessionIdentities(meta,snapshot).some(s=>s.session_id===identity.session_id);
}

/** Incomplete runs + pending intents holding the session identity. */
export function sessionOccupants(store: RunStore, identity: SessionIdentity): AdmissionOccupant[] {
  const occupants: AdmissionOccupant[] = [];
  const snapshot=contractSource(store.hubRoot);
  for (const result of store.readManyMetas(store.list())) {
    const { id } = result;
    const meta = result.kind === 'meta' ? result.meta : undefined;
    if (meta !== undefined) {
      if (!complete(meta) && metaCarriesSession(meta, identity,snapshot)) {
        occupants.push({ run_id: id, via: 'meta', detail: `incomplete run (status=${meta.status}${meta.ended_at ? '' : ', no ended_at'})` });
      }
      continue;
    }
    // Unreadable meta: a persisted intent keeps the reservation attributable.
    try {
      const intent = store.readResumeIntent(id);
      if (intent.session_id === identity.session_id && intent.startup === 'pending') {
        occupants.push({ run_id: id, via: 'intent', detail: `pending resume startup intent from ${intent.from_run_id}` });
      }
      continue;
    } catch { /* no resume intent */ }
    let startIntent:import('./meta.js').HeadlessStartIntent|undefined;
    try {startIntent=store.readStartIntent(id);}catch {/* No start intent. */}
    if(startIntent?.startup==='pending'&&intentHoldsSession(startIntent,identity,snapshot)) {
      occupants.push({run_id:id,via:'intent',detail:`pending headless startup intent (task ${startIntent.task_id})`});
    }
  }
  return occupants;
}

/** Incomplete runs + pending intents attached to a task (any role). */
export function taskOccupants(store: RunStore, taskId: string): AdmissionOccupant[] {
  const occupants: AdmissionOccupant[] = [];
  for (const result of store.readManyMetas(store.list())) {
    const { id } = result;
    const meta = result.kind === 'meta' ? result.meta : undefined;
    if (meta !== undefined) {
      if (meta.task_id === taskId && !complete(meta)) {
        occupants.push({ run_id: id, via: 'meta', detail: `incomplete run (status=${meta.status}${meta.ended_at ? '' : ', no ended_at'})` });
      }
      continue;
    }
    try {
      const intent = store.readStartIntent(id);
      if (intent.task_id === taskId && intent.startup === 'pending') {
        occupants.push({ run_id: id, via: 'intent', detail: 'pending headless startup intent' });
      }
      continue;
    } catch { /* no headless intent */ }
    try {
      const intent = store.readResumeIntent(id);
      if (intent.startup === 'pending' && taskOfSource(store, intent.from_run_id) === taskId) {
        occupants.push({ run_id: id, via: 'intent', detail: `pending resume startup intent from ${intent.from_run_id}` });
      }
    } catch { /* not attributable */ }
  }
  return occupants;
}

/** The source run's task association (the resume intent itself is
 *  session-scoped; the managed task binding lives on the source meta). */
function taskOfSource(store: RunStore, fromRunId: string): string | undefined {
  try {
    return store.read(fromRunId).task_id;
  } catch {
    return undefined;
  }
}

/** Run fn under the rig-wide admission lock. The lock bounds ONLY the
 *  critical section; occupancy after spawn is represented by the run/intent
 *  facts themselves, never by a held lock. */
export async function withAdmissionLock<T>(store: RunStore, fn: () => Promise<T>, waitMs?: number): Promise<T> {
  const unlock = await store.lockAdmission(waitMs);
  try {
    return await fn();
  } finally {
    unlock();
  }
}

function intentHoldsSession(intent:import('./meta.js').HeadlessStartIntent,identity:SessionIdentity,snapshot:ProfileSourceSnapshot):boolean {
 const run={run_id:'pending',cwd:intent.cwd,argv:[],headless:intent.headless};
 return runSessionIdentities(run,snapshot).some(s=>s.session_id===identity.session_id);
}

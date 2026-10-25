import type { StateResponse } from './contracts.js';
import type { ContextRecord } from '../common/types.js';

// --- defaults --------------------------------------------------------------------

/** in-lock staleness revalidation for auto launches — the PRODUCTION
 *  gate shared by the Notifier wiring and its tests. Throws when the plan is
 *  stale; NEVER resolves on missing evidence:
 *  - the task must still be visible and waiting for the SAME role, without
 *    attention, not pending_approval/approved/closed (fresh /state);
 *  - the task log read must SUCCEED (a read failure is not permission);
 *  - the log must be version-consistent with the state snapshot (a log newer
 *    than the fold refreshes the state once, bounded — then refuses);
 *  - any close decision in the log is stale (closed is absorbing);
 *  - the latest launch marker for the role must be this plan's own attempt
 *    (another launcher — typically a manual resume — already served the
 *    generation). */
export function createHeadlessRevalidate(input: {
  stateUrl: string;
  fetchState: (url: string) => Promise<StateResponse>;
  readLog: (taskId: string) => Promise<ContextRecord[]>;
}): (taskId: string, role: string, attemptId: string) => Promise<void> {
  return async (taskId: string, role: string, attemptId: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await input.fetchState(`${input.stateUrl}?include=closed`);
      const entry = state.tasks.find(task => task.task_id === taskId);
      if (entry === undefined) throw new Error(`task ${taskId} no longer visible on the Hub`);
      if (["pending_approval", "approved", "closed"].includes(entry.status)) throw new Error(`task is ${entry.status}`);
      if (entry.needs_attention) throw new Error("needs_attention set");
      if (entry.waiting_for !== `agent:${role}`) throw new Error(`waiting_for is now ${entry.waiting_for}`);
      let records: ContextRecord[];
      try {
        records = await input.readLog(taskId);
      } catch (e) {
        throw new Error(`task log unreadable, cannot confirm gate freshness: ${(e as Error).message}`);
      }
      const logMax = records.reduce((max, record) => Math.max(max, record.version), 0);
      if (typeof entry.version === "number" && Number.isSafeInteger(entry.version) && logMax > entry.version) {
        if (attempt === 0) continue; // log newer than the fold snapshot — one bounded refresh
        throw new Error(`task log (v${logMax}) kept advancing past /state (v${entry.version}); cannot establish a consistent gate`);
      }
      if (records.some(record => record.content_type === "decision" && (record.payload as { decision?: unknown }).decision === "close")) {
        throw new Error("task log carries a close decision");
      }
      let markerAttempt: string | undefined;
      let markerVersion = 0;
      for (const record of records) {
        const launch = record.content_type === "note" ? (record.payload as { launch?: { role?: string; attempt_id?: string } }).launch : undefined;
        if (launch?.role === role && record.version >= markerVersion) { markerVersion = record.version; markerAttempt = launch.attempt_id; }
      }
      if (markerAttempt !== undefined && markerAttempt !== attemptId) {
        throw new Error(`generation already served by another attempt's launch marker (v${markerVersion})`);
      }
      return;
    }
    throw new Error("could not establish a consistent gate");
  };
}

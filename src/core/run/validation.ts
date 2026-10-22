import type { RunMeta } from './store.js';
import { CONTROL_PROTOCOL, STOP_SCOPE } from './protocol.js';
const date = (s: unknown): boolean => typeof s === 'string' && Number.isFinite(Date.parse(s));
/** Unknown protocol versions remain readable, but cannot acquire control. */
export function validateControlMeta(m: RunMeta): void {
  if (m.control_protocol !== undefined && typeof m.control_protocol !== 'string') throw new Error('invalid control protocol');
  if (m.control_protocol !== CONTROL_PROTOCOL || m.stop_request === undefined) return;
  const r = m.stop_request;
  if (!r || typeof r.id !== 'string' || !/^[a-f0-9]{32}$/.test(r.id) || !date(r.requested_at) ||
      typeof r.requested_by !== 'string' || !r.requested_by || r.requested_at !== m.stopped_at || r.requested_by !== m.stopped_by || m.status !== 'stopped' ||
      !['requested', 'cooperative', 'term', 'kill', 'completed', 'incomplete'].includes(r.phase) || !Array.isArray(r.signals) || r.signals.length > 3) throw new Error('invalid stop request');
  for (const a of r.signals) {
    if (!a || !['SIGINT', 'SIGTERM', 'SIGKILL'].includes(a.signal) || a.target !== (a.signal === 'SIGINT' ? m.pid : -m.pgid) || !date(a.intended_at) ||
        !['uncertain', 'sent', 'esrch', 'error'].includes(a.delivery) || (a.sent_at !== undefined && !date(a.sent_at))) throw new Error('invalid stop signal evidence');
  }
  if (r.result !== undefined) {
    const result = r.result;
    if (!result || !['cooperative', 'forced-term', 'forced-kill', 'already-ended', 'incomplete'].includes(result.outcome) ||
        typeof result.success !== 'boolean' || !date(result.completed_at) || typeof result.root_exited !== 'boolean' ||
        ![true, false, null].includes(result.group_alive) || result.scope !== STOP_SCOPE || result.descendants_check !== 'not-performed' ||
        result.success !== (result.outcome !== 'incomplete') ||
        (result.success && (!result.root_exited || result.group_alive !== false || !m.ended_at || r.phase !== 'completed')) ||
        (!result.success && r.phase !== 'incomplete')) throw new Error('invalid persisted stop result');
  } else if (r.phase === 'completed' || r.phase === 'incomplete') throw new Error('stop terminal phase without persisted result');
}
export function assertRunIdentity(m: RunMeta, initial: RunMeta): void {
  if (m.run_id !== initial.run_id || m.pid !== initial.pid || m.pgid !== initial.pgid || m.supervisor_pid !== initial.supervisor_pid ||
      m.started_at !== initial.started_at || m.cwd !== initial.cwd || m.control_protocol !== initial.control_protocol) throw new Error('run identity changed; control unverified');
}

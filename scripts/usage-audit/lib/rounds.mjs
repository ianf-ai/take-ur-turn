import path from 'node:path';
import { instant } from './sessions.mjs';
const deliveries = { architect: ['design'], executor: ['code_changes','revision'], reviewer: ['review'] };
export function extract(task, root) {
  const rounds = [], pending = new Map();
  let ordinal = 0;
  const cwd = task.checkout?.kind === 'worktree' ? path.resolve(root, task.checkout.path) : root;
  for (const r of [...task.versions].sort((a,b) => a.version-b.version)) {
    const m = r.payload?.launch;
    if (r.content_type === 'note' && m && deliveries[m.role] && Number.isInteger(m.base_version) && m.base_version < r.version) {
      ordinal++;
      const previous = pending.get(m.role);
      const agent = typeof m.route === 'string' ? m.route.split(/\s/)[0] : m.route?.agent;
      // Supersession disposition is mode-split (tui zero-change contract): a
      // tui marker keeps the conservative whole-round diagnostic; a headless
      // marker records the replaced-launch chain instead, so the DELIVERING
      // (rescue) round stays measurable while every replaced launch stays
      // honestly unaccounted — anchored later as unresolved entries, never
      // merged into the round (that tradeoff is a human decision, see README).
      const superseded = previous ? (m.launch_mode === 'headless'
        ? { superseded_versions: [...(previous.superseded_versions ?? []), previous.launch_version] }
        : { problem: 'superseded_launch' }) : {};
      pending.set(m.role, { task_id: task.task_id, round: ordinal, role: m.role, agent,
        launch_version: r.version, launch_ts: r.timestamp, cwd,
        ...superseded });
      continue;
    }
    if (!deliveries[r.role]?.includes(r.content_type)) continue;
    const launch = pending.get(r.role);
    pending.delete(r.role);
    const round = { ...(launch ?? { task_id: task.task_id, role: r.role, cwd, problem: 'missing_launch' }), delivery_version: r.version, ts: r.timestamp };
    round.agent ??= r.agent;
    if (launch && instant(round.launch_ts) > instant(round.ts)) round.problem = 'invalid_round_time';
    if (launch?.agent && r.agent && launch.agent !== r.agent) round.problem = 'agent_conflict';
    if (!round.agent) round.problem ??= 'missing_route';
    else if (!['pi','codex'].includes(round.agent)) round.problem ??= 'unsupported_agent';
    rounds.push(round);
  }
  return rounds;
}
export function attribute(rounds, sessions) {
  const matches = rounds.map(round => {
    if (round.problem) return { round, reason: round.problem, candidates: [] };
    const candidates = [], errors = [];
    for (const s of sessions.filter(s => s.agent === round.agent && !s.excluded && path.resolve(s.header.cwd ?? '/') === round.cwd)) {
      try { candidates.push(...measureSafe(s, round)); } catch (e) { errors.push(e.message); }
    }
    return { round, candidates, reason: candidates.length > 1 ? 'ambiguous_sessions' : errors.length ? [...new Set(errors)].sort().join(',') : candidates.length ? undefined : 'missing_session_or_end' };
  });
  // Check every task, even when only one task is requested for output.
  // Two-tier conflict disclosure (tui zero-change redline): every round a
  // headless rescue delivery (it carries superseded_versions) joins the
  // candidate set NEWLY (the parent commit force-dropped it unmeasured), so
  // when it collides it absorbs the conflict alone and never rebrands
  // another round's unique measurement. All other pairs keep the parent
  // commit's exact symmetric semantics.
  const rescue = m => m.round.superseded_versions !== undefined;
  for (const a of matches) for (const b of matches) {
    if (a === b) continue;
    if (!a.candidates.some(x => b.candidates.some(y => x.session_file === y.session_file && x.start_line <= y.end_line && y.start_line <= x.end_line))) continue;
    if (rescue(a) && !rescue(b)) a.reason = 'overlapping_rounds';
    else if (rescue(b) && !rescue(a)) b.reason = 'overlapping_rounds';
    else { a.reason = 'overlapping_rounds'; b.reason = 'overlapping_rounds'; }
  }
  return matches;
}
import { measure as measureSafe } from './sessions.mjs';

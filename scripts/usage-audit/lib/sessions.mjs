import * as fs from 'node:fs/promises';
import path from 'node:path';

export function instant(value) {
  const n = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(n)) throw new Error('invalid_timestamp');
  return n;
}
export function vector(v) {
  if (!v || !['input_tokens', 'output_tokens', 'total_tokens'].every(k => Number.isSafeInteger(v[k]) && v[k] >= 0)
      || v.total_tokens !== v.input_tokens + v.output_tokens) throw new Error('invalid_token_vector');
  return { input_tokens: v.input_tokens, output_tokens: v.output_tokens, total_tokens: v.total_tokens };
}
function add(a, b) { return vector(Object.fromEntries(Object.keys(a).map(k => [k, a[k] + b[k]]))); }
const zero = () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
export async function files(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const e of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) result.push(...await files(path.join(root, e.name)));
    else if (e.isFile() && e.name.endsWith('.jsonl')) result.push(path.join(root, e.name));
  }
  return result;
}
// Discard message text immediately. Never put private session bodies in diagnostics.
export async function readSession(file, agent) {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n');
  const partial = lines.at(-1).length > 0;
  lines.pop();
  const rows = lines.map((s, i) => {
    if (!s.trim()) return null;
    let r; try { r = JSON.parse(s); } catch { throw new Error(`invalid_jsonl_line:${i + 1}`); }
    const p = r.payload ?? {}, m = r.message ?? {};
    return { line: i + 1, ts: r.timestamp, type: r.type, event: p.type,
      turn: p.turn_id, role: m.role, stop: m.stopReason, id: r.id,
      usage: agent === 'pi' ? m.usage : p.info?.total_token_usage,
      header: r.type === 'session_meta' ? { cwd: p.cwd, parent: p.parent_thread_id, source: p.source, version: p.cli_version }
        : r.type === 'session' ? { cwd: r.cwd, version: r.version } : undefined };
  }).filter(Boolean);
  const header = rows[0]?.header;
  return { file, agent, rows, partial, header,
    excluded: !header || !!header.parent || header.source === 'subagent' || (typeof header.source === 'object' && header.source !== null && 'subagent' in header.source) };
}

export function measure(session, round) {
  if (session.excluded || path.resolve(session.header.cwd ?? '/') !== round.cwd) return [];
  const { rows, agent } = session;
  if (agent === 'pi' && session.header.version !== 3) throw new Error('unsupported_pi_schema');
  const L = instant(round.launch_ts), D = instant(round.ts);
  const isStart = r => agent === 'codex' ? r.type === 'event_msg' && r.event === 'task_started' : r.type === 'message' && r.role === 'user';
  const starts = rows.filter(isStart);
  const candidates = starts.filter(r => instant(r.ts) >= L && instant(r.ts) <= D);
  const results = [];
  for (const start of candidates) {
    const next = starts.find(r => r.line > start.line);
    const segment = rows.filter(r => r.line >= start.line && (!next || r.line < next.line));
    const end = segment.find(r => instant(r.ts) >= D && (agent === 'codex'
      ? r.type === 'event_msg' && r.event === 'task_complete' && r.turn === start.turn && !!start.turn
      : r.type === 'message' && r.role === 'assistant' && r.stop === 'stop'));
    if (!end) continue;
    if (session.partial && !next) throw new Error('partial_jsonl_tail');
    const window = segment.filter(r => r.line <= end.line);
    // Ordering must be coherent even when timestamps share a millisecond.
    for (let i = 1; i < window.length; i++) if (instant(window[i].ts) < instant(window[i-1].ts)) throw new Error('nonmonotonic_session_time');
    let tokens = zero(), cost = agent === 'codex' ? null : 0;
    if (agent === 'pi') {
      const seen = new Map();
      for (const r of window.filter(r => r.type === 'message' && r.role === 'assistant')) {
        const u = r.usage;
        if (!u) throw new Error('missing_usage');
        const fingerprint = JSON.stringify(u), key = r.id ?? r.line;
        if (seen.has(key)) { if (seen.get(key) !== fingerprint) throw new Error('conflicting_message_usage'); continue; }
        seen.set(key, fingerprint);
        for (const key of ['input','output','cacheRead','cacheWrite','totalTokens']) {
          if (!Number.isSafeInteger(u[key]) || u[key] < 0) throw new Error('invalid_pi_usage');
        }
        tokens = add(tokens, vector({ input_tokens: u.input + u.cacheRead + u.cacheWrite, output_tokens: u.output, total_tokens: u.totalTokens }));
        if (u.cost?.total === undefined) cost = null;
        else if (!Number.isFinite(u.cost.total) || u.cost.total < 0) throw new Error('invalid_cost');
        else if (cost !== null) cost += u.cost.total;
      }
      if (!seen.size) throw new Error('missing_usage');
    } else {
      const snapshots = rows.filter(r => r.line <= end.line && r.type === 'event_msg' && r.event === 'token_count' && r.usage);
      const before = snapshots.filter(r => r.line < start.line);
      if (starts[0] !== start && !before.length) throw new Error('missing_baseline');
      const baseline = before.length ? vector(before.at(-1).usage) : zero();
      const current = snapshots.filter(r => r.line > start.line);
      if (!current.length || instant(current.at(-1).ts) < D) throw new Error('missing_terminal_usage');
      let prev = zero();
      for (const r of snapshots) {
        const v = vector(r.usage);
        if (Object.keys(prev).some(k => v[k] < prev[k])) throw new Error('cumulative_reset');
        prev = v;
      }
      const final = vector(current.at(-1).usage);
      tokens = vector(Object.fromEntries(Object.keys(baseline).map(k => [k, final[k] - baseline[k]])));
    }
    if (cost !== null && !Number.isFinite(cost)) throw new Error('invalid_cost');
    results.push({ ...tokens, cost_usd: cost, session_file: session.file,
      window_start: start.ts, window_end: end.ts, start_line: start.line, end_line: end.line,
      ...(start.turn ? { turn_id: start.turn } : {}) });
  }
  return results;
}

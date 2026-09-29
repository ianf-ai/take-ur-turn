import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfigFile } from '../../../dist/common/config.js';
import { hubList, hubRead } from '../../../dist/hub/hub-client.js';
import { probeHub, canonicalRoot } from '../../../dist/hub/rig-discovery.js';
import { extract, attribute } from './rounds.mjs';
import { files, readSession, vector, instant } from './sessions.mjs';

export async function enabled(root) {
  const result = await readConfigFile(path.join(root, '.context-hub'));
  if (result.status === 'invalid') throw new Error('invalid_config');
  const v = result.status === 'ok' && result.config.usage_audit !== undefined ? result.config.usage_audit : 'off';
  if (v !== 'on' && v !== 'off') throw new Error('invalid_usage_audit');
  return v === 'on';
}
export function lockPath(root) {
  return path.join(os.tmpdir(), `tut-usage-audit-${createHash('sha256').update(canonicalRoot(root)).digest('hex')}.lock`);
}
const LOCKED = (file) => new Error(`audit_locked:${file}; inspect owner and remove only after confirming no writer is alive`);

// pid liveness with errno discipline: ESRCH = gone (self-heal eligible),
// EPERM = exists but untouchable (ALIVE — never steal), any other error = alive.
function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null; // unidentifiable
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'ESRCH' ? false : true; }
}

async function claimLock(file, root) {
  // Create-then-link: the lock exists on disk only after its FINAL content is
  // fully written (mode 0600), so no reader ever sees an empty or half-written
  // lock and no post-link rewrite is needed (link(2) fails with EEXIST when a
  // competitor won the race; unlike rename it never overwrites).
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ pid: process.pid, root, started: new Date().toISOString() }), { mode: 0o600 });
  // The tmp source is the hardlink's second name, not data: leaving it behind
  // leaks one file into the shared tmpdir per claim.
  try { await fs.link(tmp, file); return true; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e; // ENOSPC/EMLINK etc are real failures, not a lost race
    return false;
  } finally { await fs.unlink(tmp).catch(() => {}); }
}

// Serialize stale retirement across healers (the .reclaim mkdir mutex is the
// same pattern as rig-lock.ts, per system-design stale-lock rule): two
// healers must not both see a dead owner and unlink each other's replacement.
async function healStale(file, root) {
  const reclaim = `${file}.reclaim`;
  await fs.mkdir(reclaim).catch((e) => {
    if (e.code !== 'EEXIST') throw e; // EACCES/ENOENT etc are real failures, not a competing healer
    // EEXIST = another healer on it, or a previous recovery was interrupted
    // (SIGKILL between mkdir and rmdir): name the residue so the operator can
    // resolve it — a bare "locked" would send them inspecting the wrong file.
    throw new Error(`audit_locked:${file}; stale-lock recovery in progress or a previous recovery was interrupted — inspect ${reclaim} and remove it only after confirming no watcher is alive`);
  });
  try {
    let owner;
    try { owner = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw LOCKED(file); } // became empty/corrupt meanwhile: alive, refuse
    if (pidAlive(owner.pid) !== false) throw LOCKED(file);
    await fs.unlink(file).catch(() => {}); // already retired by the healer that holds our memory of it; fine
    return await claimLock(file, root);
  } finally { await fs.rmdir(reclaim).catch(() => {}); }
}

export async function lock(root) {
  const file = lockPath(root);
  let claimed = await claimLock(file, root);
  if (!claimed) {
    // Lock exists. Self-heal only a provably stale one: SIGKILL/crash leaves
    // the lock with no signal handler to clean it. Empty/corrupt/unparseable
    // and EPERM owners count as ALIVE — refuse rather than steal.
    let owner;
    try { owner = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw LOCKED(file); }
    if (pidAlive(owner.pid) !== false) throw LOCKED(file);
    claimed = await healStale(file, root);
    if (!claimed) throw LOCKED(file); // another healer won the fair retry
  }
  return async () => {
    try {
      const current = JSON.parse(await fs.readFile(file, 'utf8'));
      if (current.pid === process.pid) await fs.unlink(file);
    } catch { /* already gone or unreadable: nothing of ours to remove */ }
  };
}

export async function taskDir(root, id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || id === 'project') throw new Error('unsafe_task_id');
  let current = root;
  for (const component of ['.context-hub','tasks',id]) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_task_directory');
  }
  return current;
}
function total(rounds, unresolved) {
  let count = 0, cost = 0;
  for (const r of rounds) { count += r.total_tokens; cost = cost === null || r.cost_usd === null ? null : cost + r.cost_usd; }
  if (!Number.isSafeInteger(count) || (cost !== null && !Number.isFinite(cost))) throw new Error('aggregate_overflow');
  return { rounds: rounds.length, total_tokens: count, cost_usd: cost, complete: unresolved.length === 0 };
}
export function validateUsage(v) {
  if (v?.schema_version !== 1 || !Array.isArray(v.rounds) || !Array.isArray(v.unresolved)) throw new Error('invalid_usage_schema');
  const seen = new Set();
  for (const r of v.rounds) {
    vector(r);
    if (!Number.isSafeInteger(r.launch_version) || r.launch_version < 1 || seen.has(r.launch_version)
      || !Number.isSafeInteger(r.delivery_version) || r.delivery_version <= r.launch_version
      || !Number.isSafeInteger(r.round) || r.round < 1 || !['pi','codex'].includes(r.agent)
      || !['architect','executor','reviewer'].includes(r.role)
      || typeof r.session_file !== 'string' || !path.isAbsolute(r.session_file)
      || !Number.isSafeInteger(r.start_line) || r.start_line < 1 || !Number.isSafeInteger(r.end_line) || r.end_line <= r.start_line
      || !(r.cost_usd === null || typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd) && r.cost_usd >= 0)) throw new Error('invalid_usage_round');
    if (instant(r.window_start) > instant(r.ts) || instant(r.ts) > instant(r.window_end)) throw new Error('invalid_usage_window');
    seen.add(r.launch_version);
  }
  for (const u of v.unresolved) if (!Number.isSafeInteger(u.delivery_version) || typeof u.reason !== 'string') throw new Error('invalid_unresolved');
  const expected = total(v.rounds, v.unresolved);
  if (!v.total || Object.keys(expected).some(k => v.total[k] !== expected[k])) throw new Error('invalid_usage_total');
  return v;
}
export async function loadUsage(dir) {
  const file = path.join(dir, 'usage.json');
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('unsafe_usage_file');
    return validateUsage(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function merge(previous, matches, since) {
  const rounds = new Map((previous?.rounds ?? []).map(r => [r.launch_version, r]));
  const unresolved = [];
  for (const m of matches) {
    const r = m.round, selected = since === undefined || instant(r.ts) >= since;
    if (selected && !m.reason) {
      const { cwd, task_id, launch_ts, problem, ...identity } = r;
      rounds.set(r.launch_version, { ...identity, ...m.candidates[0] });
    } else if (selected || !rounds.has(r.launch_version)) {
      unresolved.push({ delivery_version: r.delivery_version, ...(r.launch_version ? { launch_version: r.launch_version } : {}),
        reason: selected ? m.reason : 'not_selected', ...(rounds.has(r.launch_version) ? { preserved: true } : {}) });
    }
  }
  const sorted = [...rounds.values()].sort((a,b) => a.launch_version-b.launch_version);
  return { schema_version: 1, rounds: sorted, unresolved, total: total(sorted, unresolved) };
}
export async function writeUsage(root, id, value, mayCommit = async () => true, rename = fs.rename) {
  const dir = await taskDir(root, id), file = path.join(dir, 'usage.json');
  await loadUsage(dir); // Refuse corrupt or symlink replacements, including races since merge.
  const bytes = JSON.stringify(validateUsage(value), null, 2) + '\n';
  try { if (await fs.readFile(file, 'utf8') === bytes) return false; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!await mayCommit()) return false;
  const tmp = path.join(dir, `.usage-${process.pid}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
    if (!await mayCommit()) return false;
    await taskDir(root, id);
    await rename(tmp, file);
    return true;
  } finally { await fs.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function source(url, root) {
  if ((await probeHub(url))?.root !== root) throw new Error(`hub_root_mismatch:${url}`);
  return { list: async () => (await hubList(url)).tasks, read: id => hubRead(url, id) };
}
export async function collect(options, deps = {}) {
  const allowed = deps.allowed ?? (() => options.watch ? enabled(options.root) : Promise.resolve(true));
  if (!await allowed()) return [];
  const hub = deps.hub ?? await source(options.url, options.root);
  const entries = await hub.list(), tasks = [];
  for (const e of entries.filter(e => e.task_id !== 'project')) {
    if (!await allowed()) return [];
    tasks.push(await hub.read(e.task_id));
  }
  const rounds = tasks.flatMap(t => extract(t, options.root));
  const targets = tasks.filter(t => !options.task || t.task_id === options.task);
  if (!targets.length) return [];
  const sessions = [], diagnostics = [];
  const discover = deps.files ?? files, read = deps.readSession ?? readSession;
  // Watch passes rescan the same trees; a file whose mtime and size are
  // unchanged since the previous pass reuses its parse instead of re-reading
  // multi-MB histories (cached rows are metadata only — bodies were already
  // discarded at parse time). Keys are agent-prefixed: the same path can in
  // principle be discovered for both agents.
  const cache = options.cache ??= new Map();
  const listed = new Set();
  for (const agent of ['pi','codex']) {
    if (!await allowed()) return [];
    const relevant = rounds.filter(r => r.agent === agent && !r.problem);
    if (!relevant.length) continue;
    const roots = agent === 'pi' ? [...new Set(relevant.map(r => path.join(options.piRoot, `--${r.cwd.replace(/^\//,'').replaceAll('/','-')}--`)))] : [options.codexRoot];
    for (const root of roots) for (const file of await discover(root)) {
      if (!await allowed()) return [];
      listed.add(file);
      try {
        const st = await fs.stat(file), key = `${agent}\u0000${file}`, hit = cache.get(key);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { sessions.push(hit.session); continue; }
        const session = await read(file, agent);
        cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, session });
        sessions.push(session);
      } catch (e) { diagnostics.push({ agent, file, reason: e.message }); cache.delete(`${agent}\u0000${file}`); }
    }
  }
  for (const key of [...cache.keys()]) if (!listed.has(key.slice(key.indexOf('\u0000') + 1))) cache.delete(key); // files that disappeared
  const matches = attribute(rounds, sessions), reports = [];
  // An unreadable candidate cannot be silently discarded to make another
  // candidate appear unique. Its cwd may itself be unreadable.
  for (const m of matches) if (diagnostics.some(d => d.agent === m.round.agent)) m.reason = 'unreadable_session_candidate';
  for (const task of targets) {
    const own = matches.filter(m => m.round.task_id === task.task_id);
    if (!await allowed()) return reports;
    if (!own.length) {
      // No delivery round exists to attach an unresolved entry or snapshot to.
      reports.push({ task_id: task.task_id, changed: false, reason: 'no_matching_rounds' });
      continue;
    }
    if (!own.some(m => options.since === undefined || instant(m.round.ts) >= options.since)) continue;
    const dir = await taskDir(options.root, task.task_id);
    const previous = await loadUsage(dir);
    const value = merge(previous, own, options.since);
    const changed = await writeUsage(options.root, task.task_id, value, allowed);
    reports.push({ task_id: task.task_id, changed, total: value.total, unresolved: value.unresolved });
  }
  return [...reports, ...diagnostics.map(d => ({ diagnostic: d }))];
}
export async function run(options, deps = {}) {
  options = { ...options, root: canonicalRoot(options.root) };
  const on = deps.enabled ?? enabled;
  const allowed = () => options.signal?.aborted ? Promise.resolve(false) : options.watch ? on(options.root) : Promise.resolve(true);
  if (!await allowed()) return;
  const release = await (deps.lock ?? lock)(options.root);
  const started = Date.now();
  let failStreak = 0, lastFail = '';
  const lastReport = new Map();
  try {
    do {
      if (options.signal?.aborted || !await allowed()) break;
      let reports;
      try { reports = await (deps.collect ?? collect)(options, { ...deps, allowed }); }
      catch (e) {
        // Watch survives transient pass failures (hub restart window, one
        // corrupt usage.json): log to stderr, back off, keep measuring. Bad
        // config and switch-off remain fatal via allowed() above. An identical
        // failure every interval would flood the log (~17k lines/day at the
        // default interval): log the first occurrence, then every 20th.
        if (!options.watch) throw e;
        failStreak = e.message === lastFail ? failStreak + 1 : 0;
        lastFail = e.message;
        if (failStreak % 20 === 0) {
          process.stderr.write(`usage-audit: pass failed (${e.message})${failStreak ? ` — ${failStreak + 1} consecutive failures` : ''}; retrying next interval\n`);
        }
        if (options.signal?.aborted || Date.now() - started >= options.timeoutMs) break;
        const wait = Math.max(0, Math.min(options.intervalMs, options.timeoutMs - (Date.now() - started)));
        try { await (deps.sleep ?? sleep)(wait, undefined, { signal: options.signal }); } catch (se) { if (se.name !== 'AbortError') throw se; }
        continue;
      }
      // A permanently-unresolved task would otherwise re-emit the identical
      // report every pass (~17k lines/day at the default interval): a report
      // emits when it first appears or its content changes, not every pass.
      const visible = options.watch ? reports.filter(v => {
        if (!(v.changed || v.diagnostic || v.reason || v.unresolved?.length)) return false;
        const key = v.diagnostic ? `d:${v.diagnostic.agent}:${v.diagnostic.file}` : String(v.task_id);
        const serialized = JSON.stringify(v);
        if (lastReport.get(key) === serialized) return false;
        lastReport.set(key, serialized);
        return true;
      }) : reports;
      (deps.report ?? (r => { for (const v of r) process.stdout.write(JSON.stringify(v) + '\n'); }))(visible);
      if (!options.watch || options.signal?.aborted || Date.now()-started >= options.timeoutMs || !await allowed()) break;
      try { await (deps.sleep ?? sleep)(Math.min(options.intervalMs, options.timeoutMs-(Date.now()-started)), undefined, { signal: options.signal }); }
      catch (e) { if (e.name !== 'AbortError') throw e; }
    } while (true);
  } finally { await release(); }
}

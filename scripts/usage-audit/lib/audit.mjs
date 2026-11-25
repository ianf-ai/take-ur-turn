// runtime/usage-audit.lock[.cursor.json]: watcher owns mutex and disposable
// scan cursor; audit/recovery read them. Locks retire by owner identity only,
// cursor generations invalidate by their existing root/source fingerprints.
// Unknown runtime siblings are protected; no directory sweep is authorized.
import '../../../dist/app/agents.js';
import { contractSource, withContractBindings } from '../../../dist/agents/public/index.js';
import { readUsage, usageResultReason, bindUsageRun, usageNeedsRun, usageContracts, usageAvailability, usageReadable, withAgentProfileSnapshot, parseUsageSource, usageSourceFromLegacy, bindLegacyUsageRounds } from '../../../dist/agents/public/usage.js';

import { UsageRepository } from '../../../dist/hub/usage-repository.js';
import { writeServiceLog } from '../../../dist/core/logging/service-log.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfigFile } from '../../../dist/core/common/config.js';
import { canonicalRoot } from '../../../dist/hub/rig-discovery.js';
import { source, requestTimeout } from './hub.mjs';
import { localIO, localFs } from './io.mjs';
export { source } from './hub.mjs';
import { extract, attributeMatches } from './rounds.mjs';
import { files, vector, instant } from './sessions.mjs';
import { IncrementalScan } from './incremental.mjs';

export async function enabled(root, options = {}) {
  const storage = path.join(root, '.context-hub');
  const result = await localIO('config', options, signal => readConfigFile(storage, { signal }), false, path.join(storage, 'config.json'));
  if (result.status === 'invalid') throw new Error('invalid_config');
  const v = result.status === 'ok' && result.config.usage_audit !== undefined ? result.config.usage_audit : 'off';
  if (v !== 'on' && v !== 'off') throw new Error('invalid_usage_audit');
  return v === 'on';
}
export function lockPath(root) {
  return path.join(canonicalRoot(root), '.context-hub', 'runtime', 'usage-audit.lock');
}
const foreignOwner = (owner, root) => typeof owner?.root === 'string' && path.isAbsolute(owner.root) && owner.root !== canonicalRoot(root);
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
// same pattern as rig-lock.ts): two
// healers must not both see a dead owner and unlink each other's replacement.
async function healStale(file, root, options) {
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
    try { owner = JSON.parse(await localFs(options).readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'LOCAL_IO_TIMEOUT') throw e; throw LOCKED(file); } // became empty/corrupt meanwhile: alive, refuse
    if (!foreignOwner(owner, root) && pidAlive(owner.pid) !== false) throw LOCKED(file);
    await fs.unlink(file).catch(() => {}); // already retired by the healer that holds our memory of it; fine
    return await claimLock(file, root);
  } finally { await fs.rmdir(reclaim).catch(() => {}); }
}

export async function lock(root, options = {}) {
  const file = lockPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let claimed = await claimLock(file, root);
  if (!claimed) {
    // Lock exists. Self-heal only a provably stale one: SIGKILL/crash leaves
    // the lock with no signal handler to clean it. Empty/corrupt/unparseable
    // and EPERM owners count as ALIVE — refuse rather than steal.
    let owner;
    try { owner = JSON.parse(await localFs(options).readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'LOCAL_IO_TIMEOUT') throw e; throw LOCKED(file); }
    if (!foreignOwner(owner, root) && pidAlive(owner.pid) !== false) throw LOCKED(file);
    claimed = await healStale(file, root, options);
    if (!claimed) throw LOCKED(file); // another healer won the fair retry
  }
  return async () => {
    try {
      const current = JSON.parse(await localFs(options).readFile(file, 'utf8'));
      if (current.pid === process.pid) await fs.unlink(file);
    } catch (e) {
      // Do not let a saturated native read pool hide a terminal timeout exit.
      // An unreadable lock stays in place for the existing stale-owner recovery.
      if (e.code === 'LOCAL_IO_TIMEOUT') process.stderr.write(`usage-audit: lock release read timed out; retained ${file}\n`);
    }
  };
}

async function recoveryLock(root, log, options) {
  const file = lockPath(root);
  let owner, status;
  try {
    owner = JSON.parse(await localFs(options).readFile(file, 'utf8'));
    const alive = foreignOwner(owner, root) ? false : pidAlive(owner?.pid);
    status = alive === false ? 'dead' : alive === true ? 'alive' : 'unknown';
  } catch (e) { if (e.code === 'LOCAL_IO_TIMEOUT') throw e; status = e.code === 'ENOENT' ? 'absent' : 'unknown'; }
  log(JSON.stringify({ event: 'recovery_lock', lock: file, pid: owner?.pid ?? null, status }) + '\n');
  if (status === 'alive' || status === 'unknown') {
    throw new Error(`audit_locked:${file}; writer pid=${owner?.pid ?? 'unknown'} is ${status}; inspect the owner and stop it manually if appropriate, then rerun --recover; no process was killed and no lock was removed`);
  }
  // Inspection is advisory: lock() rechecks liveness under the existing
  // reclaim mutex, claims atomically, and retains ownership through backfill.
  return lock(root, options);
}

function usageRepository(root,options={},rename=fs.rename) {
 const io=localFs(options);
 return new UsageRepository(root,{
  lstat:file=>io.lstat(file),read:file=>io.readFile(file,'utf8'),
  write:(file,bytes)=>io.writeFile(file,bytes,{flag:'wx',mode:0o600}),unlink:file=>io.unlink(file),
  rename:(from,to)=>localIO('rename',options,()=>rename(from,to),true,to),
  allow:check=>localIO('config',options,check,false,path.join(root,'.context-hub','config.json')),
  validate:value=>validateUsage(value,{...options,root})
 });
}
export async function taskDir(root,id,options={}) {return usageRepository(root,options).taskDirectory(id);}
function total(rounds, unresolved) {
  let count = 0, cost = 0;
  for (const r of rounds) { count += r.total_tokens; cost = cost === null || r.cost_usd === null ? null : cost + r.cost_usd; }
  if (!Number.isSafeInteger(count) || (cost !== null && !Number.isFinite(cost))) throw new Error('aggregate_overflow');
  return { rounds: rounds.length, total_tokens: count, cost_usd: cost, complete: unresolved.length === 0 };
}
export function validateUsage(v,options={}) {
  if (v?.schema_version !== 1 || !Array.isArray(v.rounds) || !Array.isArray(v.unresolved)) throw new Error('invalid_usage_schema');
  const seen = new Set();
  for (const r of v.rounds) {
    vector(r);
    if (!Number.isSafeInteger(r.launch_version) || r.launch_version < 1 || seen.has(r.launch_version)
      || !Number.isSafeInteger(r.delivery_version) || r.delivery_version <= r.launch_version
      || !Number.isSafeInteger(r.round) || r.round < 1 || typeof r.agent !== 'string' || !r.agent
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
export async function loadUsage(dir,options={}) {return usageRepository(options.root??path.resolve(dir,'../../..'),options).readDirectory(dir);}
export function merge(previous, matches, since, options={}) {
  const rounds = new Map((previous?.rounds ?? []).map(r => [r.launch_version, r]));
  const unresolved = [];
  for (const m of matches) {
    const r = m.round;
    if (!m.availability && m.reason === 'unsupported_agent') m.availability = usageAvailability(r.agent, contractSource(options.root));
    const selected = since === undefined || instant(r.ts) >= since;
    const reason=m.reason??(m.candidates.length===1?undefined:m.candidates.length?'ambiguous_sessions':'missing_session_or_end');
    if (selected && !reason) {
      const { cwd, task_id, launch_ts, problem, superseded_versions, windows_attempt, route_args, pi_session, ...identity } = r;
      rounds.set(r.launch_version, { ...identity, ...m.candidates[0] });
    } else if (selected || !rounds.has(r.launch_version)) {
      unresolved.push({ delivery_version: r.delivery_version, ...(r.launch_version ? { launch_version: r.launch_version } : {}),
        reason: selected ? reason : 'not_selected', ...(selected&&m.availability?{agent:r.agent,reason_code:m.availability.reason,capability:m.availability.capability??'invalid'}:{}), ...(rounds.has(r.launch_version) ? { preserved: true } : {}) });
    }
    // Headless supersession (mode-split in extract): the delivering round
    // accounts for itself above; each launch it replaced stays unaccounted
    // and is anchored here with existing schema-v1 fields (attribution
    // without fabrication). Merging a replaced launch's usage into the round
    // is deliberately NOT done (human decision, see README dispositions).
    // The anchor is NOT gated on `selected`: a --since replay that preserves
    // the delivering round's earlier measurement must keep the disclosure
    // and its coverage gap (complete stays false). A superseding round's
    // successful measurement never stands in for its replaced launches.
    if (r.superseded_versions) for (const v of r.superseded_versions)
      unresolved.push({ delivery_version: r.delivery_version, launch_version: v, reason: 'superseded_launch' });
  }
  const sorted = [...rounds.values()].sort((a,b) => a.launch_version-b.launch_version);
  return { schema_version: 1, rounds: sorted, unresolved, total: total(sorted, unresolved) };
}
export async function writeUsage(root,id,value,mayCommit=async()=>true,rename=fs.rename,options={}) {
 return usageRepository(root,options,rename).commit(id,value,mayCommit);
}
export async function collect(options, deps = {}) {
  const allowed = () => localIO('config', options, deps.allowed ?? (() => options.watch ? enabled(options.root, options) : Promise.resolve(true)), false, path.join(options.root, '.context-hub', 'config.json'));
  if (!await allowed()) return [];
  return withAgentProfileSnapshot(options.root, () => collectSnapshot(options, { ...deps, allowed }));
}
async function collectSnapshot(options, deps) {
  const fs = localFs(options), allowed = deps.allowed;
  const config = await localIO('config', options, signal => readConfigFile(path.join(options.root,'.context-hub'), {signal}), false, path.join(options.root,'.context-hub','config.json'));
  if(config.status==='invalid')throw Error('invalid_config');
  const snapshot = withContractBindings(contractSource(options.root),config.status === 'ok' ? config.config.agent_bindings : undefined);
  const hub = deps.hub ?? await source(options.url, options.root, options);
  // Hub reads already own their deadline and network cancellation. A second
  // local-I/O timer would win the race and misclassify the original failure.
  options.onProgress?.('hub-list');
  const scan = options.watch ? (options.incremental ??= new IncrementalScan()) : undefined;
  scan?.begin();
  const entries = await hub.list(), tasks = [];
  scan?.pruneTasks(entries);
  for (const e of entries.filter(e => e.task_id !== 'project')) {
    if (!await allowed()) return [];
    options.onProgress?.('hub-read');
    tasks.push(scan ? await scan.task(hub, e) : await hub.read(e.task_id));
  }
  const rounds = tasks.flatMap(t => extract(t, options.root, options));
  const targets = tasks.filter(t => !options.task || t.task_id === options.task);
  if (!targets.length) return [];
  const availabilityByRound=new Map(),selectedByRound=new Map();
  for(const round of rounds) {
    if(round.problem&&round.problem!=='unsupported_agent')continue;
    const availability=usageAvailability(round.agent,snapshot);
    // A legacy Windows executable needs the frozen run's native target.
    if(round.windows_attempt&&availability.status==='invalid'&&availability.code==='CONTRACT_UNAVAILABLE')continue;
    if(availability.status!=='available') {
      availabilityByRound.set(round,availability);
      round.problem=availability.status==='unavailable'?(availability.capability==='unsupported'?'unsupported_agent':'usage_unavailable'):availability.reason;
    } else {
      selectedByRound.set(round,availability.handle);
      if(round.problem==='unsupported_agent')delete round.problem;
    }
  }
  if (rounds.some(r => r.windows_attempt && !r.problem)) {
    try {
      const runs = await localIO('run-read', options, async () => {
        if (deps.runs) return deps.runs();
        const { RunStore } = await import('../../../dist/core/run/store.js');
        const store = new RunStore(options.root);
        return store.list().map(id => store.read(id));
      }, false, path.join(options.root, '.context-hub', 'runs'));
      bindLegacyUsageRounds(rounds, runs, options);
    } catch (e) {
      if (e.code === 'LOCAL_IO_TIMEOUT') throw e;
      for (const r of rounds.filter(r => r.windows_attempt && !r.problem)) r.problem = 'unreadable_windows_runs';
    }
  }
  const diagnostics=[],cache=options.watch?new Map():(options.cache??=new Map()),listed=new Set();
  const discovery=new Map(),parses=new Map(),sourceErrors=new Map();
  let sourceTimeout;
  const remember=async(source,action)=>{try{return await action();}catch(e){sourceErrors.set(source,e);if(e.code==='LOCAL_IO_TIMEOUT')sourceTimeout=e;throw e;}};
  const profiles=usageContracts(snapshot,(options.platform??process.platform)==='win32'?'win32':'posix');
  const profilesById=new Map(profiles.map(profile=>[profile.id,profile]));
  const matches=rounds.map(round=>{
    // Legacy Windows binding has already projected the frozen target's id.
    const contract=profilesById.get(selectedByRound.get(round)?.id??round.agent);
    return {round,contract,candidates:[],...(round.problem?{reason:round.problem}:!contract?{reason:'usage_contract_unavailable'}:{}),
      ...(availabilityByRound.has(round)?{availability:availabilityByRound.get(round)}:{})};
  });
  let runFacts;
  const loadRunFacts=async()=>{
    if(!runFacts)runFacts=await localIO('run-read',options,async()=>{
      const {RunStore}=await import('../../../dist/core/run/store.js'),store=new RunStore(options.root);
      return new Map((deps.runs?await deps.runs():store.list().map(id=>store.read(id))).map(m=>[m.run_id,m]));
    },false,path.join(options.root,'.context-hub','runs'));
    return runFacts;
  };
  const services={
    facts:{home:options.home??os.homedir(),auditCwd:process.cwd(),profileRoot:options.root,platform:(options.platform??process.platform)==='win32'?'win32':'posix',
      ...(options.piRoot!==undefined?{piRoot:options.piRoot}:{}),codexRoot:options.codexRoot,piEnv:{...(options.piEnv??process.env)}},
    signal:options.signal,
    list(root,pattern) {
      const key=root+'\0'+pattern;
      if(!discovery.has(key))discovery.set(key,remember(root,()=>deps.files?localIO('session-discover',options,()=>deps.files(root),false,root):files(root,options,pattern)));
      return discovery.get(key);
    },
    async readLines(file) {const text=await fs.readFile(file,'utf8'),lines=text.split('\n'),partial=lines.at(-1).length>0;lines.pop();return {lines,partial};},
    async readSettings(file) {try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return undefined;sourceErrors.set('usage-root',e);if(e.code==='LOCAL_IO_TIMEOUT')sourceTimeout=e;throw e;}},
    readHead(file,maxBytes) {return localIO('read-head',options,async()=>{
      const {open}=await import('node:fs/promises'),handle=await open(file,'r');
      try{const buffer=Buffer.alloc(maxBytes),{bytesRead}=await handle.read(buffer,0,maxBytes,0);return buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
    },false,file);},
    async readRun(id) {return remember(id,async()=>{
      const value=(await loadRunFacts()).get(id);if(!value)throw Error('missing_usage_run');return value;
    });},
    async readRunLog(id) {return remember(id,()=>localIO('run-log-read',options,async()=>{
      const {RunStore}=await import('../../../dist/core/run/store.js');const store=new RunStore(options.root),fd=store.openLog(id);
      try {const {readFile}=await import('node:fs');const text=await new Promise((resolve,reject)=>readFile(fd,'utf8',(e,s)=>e?reject(e):resolve(s)));const lines=text.split('\n'),partial=lines.at(-1).length>0;lines.pop();return {absolute_path:store.logPath(id),lines,partial};}
      finally {(await import('node:fs')).closeSync(fd);}
    },false,id));},
    async loadSource(file,profile) {
      const key=profile.id+'\0'+file;
      if(!parses.has(key))parses.set(key,(async()=>{
        if(!await allowed())throw Error('usage-disabled-or-aborted');
        listed.add(file);
        try {
          const st=await fs.stat(file),hit=cache.get(key);
          if(hit&&hit.mtimeMs===st.mtimeMs&&hit.size===st.size&&hit.session.key===profile.sourceKey)return hit.session;
          const session=deps.readSession?usageSourceFromLegacy(await localIO('session-read',options,()=>deps.readSession(file,profile.id,options),false,file),profile):parseUsageSource(await fs.readFile(file,'utf8'),file,profile);
          cache.set(key,{mtimeMs:st.mtimeMs,size:st.size,session});return session;
        }catch(e){cache.delete(key);sourceErrors.set(file,e);if(e.code==='LOCAL_IO_TIMEOUT')sourceTimeout=e;throw e;}
      })());
      return parses.get(key);
    }
  };
  const markerFor=r=>tasks.find(t=>t.task_id===r.task_id)?.versions.find(v=>v.version===r.launch_version)?.payload?.launch;
  const routeFor=r=>{
    const marker=markerFor(r);
    if(typeof marker?.route==='object')return {agent:marker.route.agent,args:marker.route.args??[]};
    if(typeof marker?.route==='string'){const [agent,...args]=marker.route.split(/\s+/);return {agent,args};}
    return {agent:r.agent,args:r.route_args??[]};
  };
  for(const profile of profiles) {
    if(!await allowed())return [];
    const prepared=[];
    for(const match of matches.filter(m=>m.contract===profile&&!m.reason)) {
      const r=match.round,round={task_id:r.task_id,role:r.role,agent:profile.id,route:routeFor(r),cwd:r.cwd,launch_version:r.launch_version,delivery_version:r.delivery_version,launch_ts:r.launch_ts,delivery_ts:r.ts,...(r.pi_session?{pi_session:r.pi_session}:{})};
      round.attempt_id=r.windows_attempt?.attempt_id??markerFor(r)?.attempt_id;
      const binding=bindUsageRun(profile,round,usageNeedsRun(profile)?[...(await loadRunFacts()).values()]:[]);
      if(binding.status!=='bound'){match.reason=binding.reason;continue;}
      const ref=binding.ref;
      prepared.push({match,ref});
    }
    const refs=prepared.map(p=>p.ref);
    const profileServices=scan?{...services,readSource:(file,ref)=>remember(file,()=>scan.read(file,ref,refs,options,async file=>{
      try {
        if(!await allowed())throw Error('usage-disabled-or-aborted');
        return deps.readSession?usageSourceFromLegacy(await localIO('session-read',options,()=>deps.readSession(file,profile.id,options),false,file),profile):parseUsageSource(await fs.readFile(file,'utf8'),file,profile);
      }catch(e){sourceErrors.set(file,e);if(e.code==='LOCAL_IO_TIMEOUT')sourceTimeout=e;throw e;}
    }))}:services;
    const profilePass=scan?await scan.profile(profile,profileServices,options,refs):undefined;
    for(const {match,ref} of prepared) {
      const result=profilePass?await profilePass.read(ref,readUsage):await readUsage(ref,profileServices);
      match.problems=result.problems;
      match.candidates=result.status==='measured'?result.candidates:[];
      for(const problem of result.problems) {
        if(problem.cause_code==='LOCAL_IO_TIMEOUT')throw sourceTimeout??sourceErrors.get(problem.source)??Object.assign(Error(problem.reason),{code:'LOCAL_IO_TIMEOUT'});
        if(problem.code==='SOURCE_DIRECTORY_UNREADABLE'&&services.facts.platform!=='win32')throw sourceErrors.get(problem.source)??Object.assign(Error(problem.reason),{code:problem.cause_code});
        if(['SOURCE_UNREADABLE','SOURCE_DIRECTORY_UNREADABLE','USAGE_READ_ERROR'].includes(problem.code))!diagnostics.some(d=>d.agent===profile.id&&d.file===problem.source)&&diagnostics.push({agent:profile.id,file:problem.source,reason:problem.code==='SOURCE_DIRECTORY_UNREADABLE'?(problem.cause_code??'unreadable_session_directory'):problem.reason});
      }
      const errors=result.problems.filter(p=>p.code==='SOURCE_WINDOW_INVALID').map(p=>p.reason);
      match.reason=match.candidates.length>1?'ambiguous_sessions':errors.length?[...new Set(errors)].sort().join(','):match.candidates.length?undefined:usageResultReason(result);
    }
    if(profilePass)await profilePass.finish(refs);
  }
  for(const key of [...cache.keys()])if(!listed.has(key.slice(key.indexOf('\0')+1)))cache.delete(key);
  attributeMatches(matches);
  const reports=[];
  // An unreadable candidate cannot be silently discarded to make another
  // candidate appear unique. Its cwd may itself be unreadable.
  for (const m of matches) if (diagnostics.some(d => d.agent === m.contract?.id)) m.reason = 'unreadable_session_candidate';
  for (const task of targets) {
    const own = matches.filter(m => m.round.task_id === task.task_id);
    if (!await allowed()) return reports;
    if (!own.length) {
      // No delivery round exists to attach an unresolved entry or snapshot to.
      reports.push({ task_id: task.task_id, changed: false, reason: 'no_matching_rounds' });
      continue;
    }
    if (!own.some(m => options.since === undefined || instant(m.round.ts) >= options.since)) continue;
    const dir = await taskDir(options.root, task.task_id, options);
    const previous = await loadUsage(dir, options);
    const value = merge(previous, own, options.since, options);
    const changed = await writeUsage(options.root, task.task_id, value, allowed, undefined, options);
    reports.push({ task_id: task.task_id, changed, total: value.total, unresolved: value.unresolved });
  }
  scan?.finish(profiles.map(p=>p.sourceKey));
  return [...reports, ...diagnostics.map(d => ({ diagnostic: d }))];
}
export const TIMEOUT_PASS_LIMIT = 10;
const isTimeout = e => e.code === 'LOCAL_IO_TIMEOUT' || e.code === 'HUB_TIMEOUT';

export async function run(options, deps = {}) {
  options = { intervalMs: 5000, timeoutMs: Infinity, ...options, root: canonicalRoot(options.root),
    requestTimeoutMs: options.requestTimeoutMs ?? requestTimeout() };
  const started = Date.now(), log = text => process.stderr.write(text);
  let failStreak = 0, lastFail = '', consecutiveFailures = 0, lastSuccessfulPass = null;
  let inRequest = false, heartbeat, release, passId = 0, phase = 'config', progressAt = started;
  let lastHealthState = '', reportFailed = false, sleepUntil = 0;
  let countedFailure = false, consecutiveTimeouts = 0;
  const progress = next => { phase = next; progressAt = Date.now(); };
  const failed = e => {
    if (countedFailure) return;
    countedFailure = true;
    consecutiveFailures++;
    consecutiveTimeouts = isTimeout(e) ? consecutiveTimeouts + 1 : 0;
    if (isTimeout(e)) log(JSON.stringify({ event: 'IO_STALLED', timestamp: new Date().toISOString(), pid: process.pid,
      pass_id: passId, phase: e.phase ?? phase, code: e.code, target: e.target,
      elapsed_ms: e.elapsed_ms, timeout_ms: e.timeout_ms, consecutive_timeouts: consecutiveTimeouts }) + '\n');
    failStreak = e.message === lastFail ? failStreak + 1 : 0;
    lastFail = e.message;
    if (failStreak % 20 === 0) {
      log(`usage-audit: pass failed (${e.message})${failStreak ? ` — ${failStreak + 1} consecutive failures` : ''}; ${e.fatalConfig ? 'stopping: invalid configuration' : 'retrying next interval'}\n`);
    }
  };
  options.onProgress = progress;
  options.onIOTimeout = e => {
    failed(e);
    log(`usage-audit: ${e.message}; waiting for submitted mutation; writer lock retained\n`);
  };
  options.onRequest = value => { inRequest = value; };
  const on = deps.enabled ?? enabled;
  const allowed = async () => {
    if (options.signal?.aborted) return false;
    if (!options.watch) return true;
    try { return await localIO('config', options, () => on(options.root, options), false, path.join(options.root, '.context-hub', 'config.json')); }
    catch (e) { if (e.code !== 'LOCAL_IO_TIMEOUT') e.fatalConfig = true; throw e; }
  };
  // A disabled watcher still does no lock, session, Hub or heartbeat work.
  // Transient startup config timeouts enter the same observable retry loop.
  let initiallyAllowed = false, initialFailure;
  try { initiallyAllowed = await allowed(); if (!initiallyAllowed) return; }
  catch (e) { if (!options.watch || e.fatalConfig) throw e; initialFailure = e; }
  const acquire = async () => {
    progress('lock');
    try { return options.recover ? await recoveryLock(options.root, log, options) : await (deps.lock ?? lock)(options.root, options); }
    catch (e) { if (!isTimeout(e)) e.fatalLock = true; throw e; }
  };
  const lastReport = new Map();
  try {
    if (options.watch) heartbeat = (deps.setInterval ?? setInterval)(() => {
      const now = Date.now();
      const stalledMs = options.stallTimeoutMs ?? Math.max(120_000, 2 * options.requestTimeoutMs + options.intervalMs);
      const successAge = now - (lastSuccessfulPass === null ? started : Date.parse(lastSuccessfulPass));
      const plannedSleep = phase === 'sleep' && now <= sleepUntil;
      const stalled = !plannedSleep && now - progressAt >= stalledMs;
      // A long calibration with advancing work is not a frozen pass. Failed
      // passes are separately observable even when they keep making progress.
      const successOverdue = consecutiveFailures > 0 && successAge >= stalledMs;
      const status = { timestamp: new Date(now).toISOString(), pid: process.pid, pass_id: passId, phase,
        last_progress_at: new Date(progressAt).toISOString(), last_successful_pass: lastSuccessfulPass,
        consecutive_failures: consecutiveFailures, in_request: inRequest,
        planned_sleep: plannedSleep, sleep_until: sleepUntil ? new Date(sleepUntil).toISOString() : null,
        success_overdue: successOverdue };
      (deps.logHeartbeat ?? writeServiceLog)(JSON.stringify({ event: 'heartbeat', ...status, stalled }) + '\n');
      // Compare health flags, not counters/timestamps: continuing failures
      // must not turn a minute-by-minute file record into terminal noise.
      const failing = consecutiveFailures > 0;
      const healthState = JSON.stringify([stalled, failing, successOverdue]);
      if ((stalled || failing || successOverdue) && healthState !== lastHealthState) {
        const event = stalled ? 'PASS_STALLED' : successOverdue ? 'PASS_SUCCESS_OVERDUE' : 'PASS_FAILED';
        log(JSON.stringify({ event, ...status, stalled, threshold_ms: stalledMs }) + '\n');
      }
      lastHealthState = healthState;
    }, 60_000);
    do {
      if (options.signal?.aborted) break;
      passId++;
      const passStarted = performance.now();
      countedFailure = false;
      try {
        // The startup probe is the first pass's config read, not an extra
        // unnumbered failure (otherwise the terminal count would be off by one).
        if (initialFailure) { const error = initialFailure; initialFailure = undefined; throw error; }
        if (passId === 1 && initiallyAllowed) release = await acquire();
        // Both boundary config reads belong to the pass failure accounting.
        if (!await allowed()) break;
        if (!release) release = await acquire();
        progress('collect');
        const reports = await (deps.collect ?? collect)(options, { ...deps, allowed });
        if(options.watch && options.incremental) await options.incremental.persist(`${lockPath(options.root)}.cursor.json`, options);
        const visible = options.watch ? reports.filter(v => {
          if (!(v.changed || v.diagnostic || v.reason || v.unresolved?.length)) return false;
          const key = v.diagnostic ? `d:${v.diagnostic.agent}:${v.diagnostic.file}` : String(v.task_id);
          const serialized = JSON.stringify(v);
          if (lastReport.get(key) === serialized) return false;
          lastReport.set(key, serialized);
          return true;
        }) : reports;
        progress('report');
        try { (deps.report ?? (r => { for (const v of r) process.stdout.write(JSON.stringify(v) + '\n'); }))(visible); }
        catch (e) { reportFailed = true; throw e; }
        const stopping = !options.watch || options.signal?.aborted || Date.now() - started >= options.timeoutMs || !await allowed();
        lastSuccessfulPass = new Date().toISOString();
        consecutiveFailures = 0;
        consecutiveTimeouts = 0;
        if (stopping) break;
      } catch (e) {
        // Output failures remain fatal and never claim a successful pass.
        if (!options.watch || reportFailed) throw e;
        failed(e);
        if(options.incremental)for(const state of options.incremental.profiles.values()){state.signature=undefined;state.results.clear();}
        if (e.fatalConfig || e.fatalLock) throw e;
        if (consecutiveTimeouts >= TIMEOUT_PASS_LIMIT) {
          const error = Object.assign(new Error(`WATCHER_TIMEOUT_LIMIT: ${consecutiveTimeouts} consecutive passes timed out; last=${e.message}`), { code: 'WATCHER_TIMEOUT_LIMIT' });
          log(JSON.stringify({ event: error.code, timestamp: new Date().toISOString(), pid: process.pid, pass_id: passId,
            phase, consecutive_timeouts: consecutiveTimeouts, limit: TIMEOUT_PASS_LIMIT, code: e.code, target: e.target, reason: error.message }) + '\n');
          throw error;
        }
        if (options.signal?.aborted || Date.now() - started >= options.timeoutMs) break;
      }
      const wait = Math.max(0, Math.min(Math.max(options.intervalMs, performance.now() - passStarted), options.timeoutMs - (Date.now() - started)));
      sleepUntil = Date.now() + wait;
      progress('sleep');
      try { await (deps.sleep ?? sleep)(wait, undefined, { signal: options.signal }); }
      catch (e) { if (e.name !== 'AbortError') throw e; }
      finally { sleepUntil = 0; }
    } while (!options.signal?.aborted && Date.now() - started < options.timeoutMs);
  } finally {
    // Keep progress observation alive through cleanup, which may itself wait
    // for local I/O. Never hand the lock to another writer during a mutation.
    progress('release-lock');
    try { if (release) await release(); }
    finally { if (heartbeat !== undefined) (deps.clearInterval ?? clearInterval)(heartbeat); }
  }
  if (options.recover && !options.signal?.aborted) {
    log('usage-audit: recovery backfill complete; inspect stdout coverage/unresolved diagnostics. To resume monitoring, enable usage_audit if off and rerun --watch with the same --root, --url and session roots.\n');
  }
}

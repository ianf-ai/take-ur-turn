import '../../../dist/app/agents.js';
import { measureUsageSource, usageSourceNeutral, usageCachePolicy } from '../../../dist/agents/public/usage.js';
import { randomUUID } from 'node:crypto';
import { localFs } from './io.mjs';

// Only metadata and measured windows survive a pass. In particular neither
// publication bodies nor native JSONL rows belong in the resident watcher.
const compact = task => ({ ...task, description: undefined, versions: task.versions.map(r => ({
  version: r.version, timestamp: r.timestamp, role: r.role, agent: r.agent,
  content_type: r.content_type, payload: r.payload?.launch ? { launch: r.payload.launch } : {},
})) });
const windowKeys = new WeakMap();
const windowKey = ref => {
  if (!windowKeys.has(ref)) windowKeys.set(ref, ref.key);
  return windowKeys.get(ref);
};
const stamp = st => [st.mtimeMs, st.ctimeMs, st.size, st.ino, st.dev].join(':');

export class IncrementalScan {
  tasks = new Map();
  sessions = new Map();
  profiles = new Map();
  async profile(profile, services, options, refs) {
    let state = this.profiles.get(profile.sourceKey);
    if (!state) this.profiles.set(profile.sourceKey, state = { roots: new Map(), results: new Map(), signature: undefined });
    const refSignature = JSON.stringify(refs.map(windowKey));
    if (state.refSignature !== refSignature) {
      state.roots.clear(); state.results.clear(); state.signature = undefined;
      state.refSignature = refSignature;
    }
    const signature = async () => {
      const roots = [];
      for (const [key, [root, pattern]] of state.roots) {
        const paths = await services.list(root, pattern);
        const entries = [];
        for (const file of paths) {
          try { entries.push([file, await this.fingerprint(file, options)]); }
          catch(e) { if(e.code === 'LOCAL_IO_TIMEOUT') throw e; entries.push([file, {error:e.code??e.message}]); }
        }
        roots.push([key, entries]);
      }
      return JSON.stringify(roots);
    };
    // Windows settings and exact-run identity have their own live sources;
    // use the ordinary reader there rather than infer their freshness.
    const reusable = refs.every(ref => usageCachePolicy(ref).reusable);
    if (reusable && state.signature !== undefined) {
      const current = await signature();
      if (current !== state.signature) state.results.clear();
    } else state.results.clear();
    const wrapped = { ...services, list: (root, pattern) => {
      state.roots.set(root+'\0'+pattern, [root, pattern]);
      return services.list(root, pattern);
    } };
    return {
      read: async (ref, read) => {
        const key = windowKey(ref);
        if (reusable && state.results.has(key)) return state.results.get(key);
        const result = await read(ref, wrapped);
        // I/O failures must be retried even if file metadata is unchanged.
        if (!result.problems.some(p => p.status === 'error')) state.results.set(key, { ...result, sourceEvidence: [] });
        return result;
      },
      finish: async refs => {
        const live = new Set(refs.map(windowKey));
        for (const key of state.results.keys()) if (!live.has(key)) state.results.delete(key);
        if (reusable) state.signature = await signature();
      },
    };
  }
  async fingerprint(file, options) {
    if (!this.stats.has(file)) this.stats.set(file, localFs(options).stat(file).then(stamp));
    return this.stats.get(file);
  }
  begin() { this.probes = new Map(); this.stats = new Map(); }
  async task(hub, entry) {
    const token = JSON.stringify([entry.version, entry.updated_at, entry.checkout]);
    const hit = this.tasks.get(entry.task_id);
    // Sources without a version cannot promise an unchanged log.
    if (hit && Number.isInteger(entry.version) && hit.token === token) return hit.task;
    const incremental = hit && Number.isInteger(entry.version) && entry.version > hit.version;
    const next = compact(await hub.read(entry.task_id, incremental ? hit.version + 1 : undefined));
    if (incremental) next.versions = [...hit.task.versions, ...next.versions.filter(r => r.version > hit.version)];
    const version = Math.max(0, ...next.versions.map(r => r.version));
    this.tasks.set(entry.task_id, { token, version, task: next });
    return next;
  }
  pruneTasks(entries) {
    const ids = new Set(entries.map(e => e.task_id));
    for (const id of this.tasks.keys()) if (!ids.has(id)) this.tasks.delete(id);
  }
  async read(file, ref, refs, options, load) {
    const key = usageCachePolicy(ref).sourceKey + '\0' + file;
    // One stat per file/profile/pass, including failures. Never cache failures
    // across passes: recovery must be visible without an mtime change.
    if (!this.probes.has(key)) this.probes.set(key, this.prepare(key, file, ref, refs, options, load));
    const entry = await this.probes.get(key);
    return entry.results.get(windowKey(ref)) ?? entry.empty;
  }
  async prepare(key, file, ref, refs, options, load) {
    try {
      const fingerprint = await this.fingerprint(file, options);
      const keys = refs.map(windowKey);
      const hit = this.sessions.get(key);
      if (hit && hit.stamp === fingerprint && keys.every(k => hit.keys.has(k))) return hit;
      // New rounds in another cwd can use the saved header; all native schema
      // validation still runs for windows which can belong to this session.
      if (hit && hit.stamp === fingerprint && refs.every((r, i) => hit.keys.has(keys[i]) || this.neutralFor(hit,r))) {
        hit.keys = new Set(keys);
        return hit;
      }
      const session = await load(file);
      const { outcomes, proof } = measureUsageSource(session, refs);
      const results = new Map();
      let empty;
      for (let i = 0; i < refs.length; i++) {
        const result = outcomes[i];
        if (result.candidates.length || result.problems.length) results.set(keys[i], result);
        else empty ??= result;
      }
      const entry = { stamp: fingerprint, keys: new Set(keys), results,
        empty: empty ?? { sourceEvidence: [], candidates: [], problems: [] }, proof };
      this.sessions.set(key, entry);
      return entry;
    } catch (e) { this.sessions.delete(key); throw e; }
  }
  neutralFor(hit, ref) { return usageSourceNeutral(hit.proof, ref); }
  finish(digests) {
    const live = new Set(digests);
    for (const digest of this.profiles.keys()) if (!live.has(digest)) this.profiles.delete(digest);
    for (const key of this.sessions.keys()) if (!live.has(key.slice(0,key.indexOf('\0'))) || !this.stats.has(key.slice(key.indexOf('\0')+1))) this.sessions.delete(key);
    // Settled promises must not keep abandoned parser closures alive.
    this.probes.clear();
    this.stats.clear();
  }
  async persist(file, options) {
    const io = localFs(options), tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const value = JSON.stringify({ schema_version: 1, calibrated_at: new Date().toISOString(),
      tasks: [...this.tasks].map(([id, e]) => [id, e.version]),
      sessions: [...this.sessions].map(([id, e]) => [id, e.stamp]) });
    // This is a disposable cursor beside the watcher lock, not Hub storage or
    // usage output. Startup intentionally never trusts it: always calibrate.
    try {
      await io.writeFile(tmp, value, { mode: 0o600, flag: 'wx' });
      await io.rename(tmp, file);
    } finally {
      await io.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
  }
}

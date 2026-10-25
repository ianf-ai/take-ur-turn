#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { run } from './lib/audit.mjs';
import { requestTimeout } from './lib/hub.mjs';
export function parse(argv, env = process.env, runtime = {}) {
  const platform = runtime.platform ?? process.platform, home = runtime.home ?? os.homedir();
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const o = { root: runtime.cwd ?? process.cwd(), url: 'http://127.0.0.1:3001',
    ...(platform === 'win32' ? { platform, home, piEnv: { PI_CODING_AGENT_SESSION_DIR: env.PI_CODING_AGENT_SESSION_DIR, PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR } }
      : { piRoot: paths.join(home, '.pi/agent/sessions') }),
    codexRoot: paths.join(home, '.codex/sessions'), intervalMs: 5000, timeoutMs: Infinity };
  let modes = 0;
  const seen = new Set();
  for (let i=0; i<argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) throw new Error(`duplicate option:${key}`);
    seen.add(key);
    if (key === '--help') { o.help = true; continue; }
    if (key === '--watch' || key === '--backfill' || key === '--recover') {
      modes++; o.watch = key === '--watch'; o.recover = key === '--recover'; continue;
    }
    const names = { '--root':'root','--url':'url','--task':'task','--pi-root':'piRoot','--codex-root':'codexRoot','--since':'since','--interval-ms':'intervalMs','--timeout-ms':'timeoutMs' };
    if (!names[key] || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`unknown option or missing value:${key}`);
    const value = argv[++i];
    if (key === '--since') {
      modes++;
      const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
      const calendar = parts && new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
      if (!parts || !Number.isFinite(Date.parse(value)) || calendar.toISOString().slice(0,10) !== value.slice(0,10)
          || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) throw new Error('invalid_since');
      o.since = Date.parse(value);
    } else if (key.endsWith('-ms')) {
      const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid interval:${key}`);
      o[names[key]] = n;
    } else o[names[key]] = value;
  }
  if (!o.help && modes !== 1) throw new Error('choose exactly one: --watch | --since ISO8601 | --backfill | --recover');
  if (!o.help) o.requestTimeoutMs = requestTimeout(env);
  for (const key of ['root','piRoot','codexRoot']) if (o[key] !== undefined) o[key] = paths.resolve(runtime.cwd ?? process.cwd(), o[key]);
  return o;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.help) console.log('usage-audit --watch | --since ISO8601 | --backfill | --recover\n  --root PROJECT_ROOT --url HUB_URL --task TASK_ID\n  --pi-root DIR --codex-root DIR --interval-ms 5000 --timeout-ms N\n  TUT_USAGE_AUDIT_TIMEOUT_MS: Hub/local I/O deadline, default 30000ms\n  --recover: report owner, reclaim dead lock only, backfill, suggest --watch; never kill\nBuild first: npm run build. See README.md for schema and diagnostics.');
    else {
      const abort = new AbortController();
      for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => abort.abort());
      await run({ ...options, signal: abort.signal });
    }
  } catch (e) { console.error(`usage-audit: ${e.message}`); process.exitCode = 1; }
}

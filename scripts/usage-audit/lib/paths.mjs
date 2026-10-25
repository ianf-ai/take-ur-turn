import path from 'node:path';
import os from 'node:os';
import { windowsPiEncodedCwd, windowsPiRouteArgs, windowsPiSessionLocation, resolveWindowsPiPath } from '../../../dist/core/run/windows-pi-session.js';
import { localFs } from './io.mjs';

export const auditPath = options => (options?.platform ?? process.platform) === 'win32' ? path.win32 : path;
export function sameCwd(header, cwd, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return path.resolve(header ?? '/') === cwd;
  return typeof header === 'string' && path.win32.isAbsolute(header) && path.win32.resolve(header) === cwd;
}

// --pi-root remains TUT's parent of cwd directories. Pi's native CLI/env
// override is a FINAL directory. A frozen run determines which layout applies.
export async function piDirectory(round, options, deps = {}) {
  if ((options.platform ?? process.platform) !== 'win32')
    return path.join(options.piRoot, `--${round.cwd.replace(/^\//u, '').replaceAll('/', '-')}--`);
  const home = options.home ?? os.homedir();
  if (round.pi_session) {
    if (options.piRoot === undefined) return round.pi_session.session_directory;
    return round.pi_session.storage_layout === 'flat' ? options.piRoot
      : path.win32.join(options.piRoot, windowsPiEncodedCwd(round.cwd));
  }
  const env = options.piEnv ?? process.env;
  const directory = windowsPiRouteArgs(round.route_args ?? []).directory;
  if (options.piRoot !== undefined)
    return directory || env.PI_CODING_AGENT_SESSION_DIR ? options.piRoot
      : path.win32.join(options.piRoot, windowsPiEncodedCwd(round.cwd));
  // Read settings through the bounded I/O adapter; the shared leaf owns the
  // conservative refusal when their effective trust/merge state is unknown.
  const settings = new Map();
  if (!directory && !env.PI_CODING_AGENT_SESSION_DIR) {
    const agentDir = env.PI_CODING_AGENT_DIR ? resolveWindowsPiPath(env.PI_CODING_AGENT_DIR, round.cwd, home) : path.win32.join(home, '.pi', 'agent');
    for (const file of [path.win32.join(agentDir, 'settings.json'), path.win32.join(round.cwd, '.pi', 'settings.json')]) {
      try { settings.set(file, await (deps.readSettings ?? (file => localFs(options).readFile(file, 'utf8')))(file)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  return windowsPiSessionLocation(round.cwd, env, directory, { home, readSettings: file => settings.get(file) }).session_directory;
}

// Run metadata is read only through RunStore. Exact launch association is
// required; a marker alone does not prove where the agent stored its session.
export function bindWindowsPi(rounds, runs) {
  for (const round of rounds.filter(r => r.windows_attempt && !r.problem)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(round.windows_attempt.attempt_id ?? '')) {
      round.problem = 'invalid_windows_launch'; continue;
    }
    const matches = runs.filter(r => r.task_id === round.task_id && r.headless?.role === round.role &&
      r.headless.attempt_id === round.windows_attempt.attempt_id && r.headless.base_version === round.windows_attempt.base_version);
    if (matches.length !== 1) { round.problem = matches.length ? 'ambiguous_windows_run' : 'missing_windows_run'; continue; }
    const run = matches[0], windows = run.headless.windows, target = windows?.target;
    if (!round.windows_attempt.route_agent || run.headless.route?.agent !== round.windows_attempt.route_agent ||
        JSON.stringify(run.headless.route.args) !== JSON.stringify(round.route_args) ||
        windows?.schema !== 1 || !['pi', 'codex'].includes(target?.agent) ||
        typeof target.executable !== 'string' || !path.win32.isAbsolute(target.executable) ||
        !Array.isArray(target.prefix_args) || !target.prefix_args.every(a => typeof a === 'string' && !a.includes('\0')) ||
        !Array.isArray(windows.logical_argv) || windows.logical_argv[0] !== target.agent ||
        !windows.logical_argv.every(a => typeof a === 'string' && !a.includes('\0')) ||
        (windows.pi_session && target.agent !== 'pi') ||
        !sameCwd(run.cwd, round.cwd, { platform: 'win32' })) {
      round.problem = 'invalid_windows_session'; continue;
    }
    round.agent = target.agent;
    if (round.windows_attempt.delivery_agent && round.windows_attempt.delivery_agent !== round.agent) {
      round.problem = 'agent_conflict'; continue;
    }
    if (round.agent !== 'pi') continue;
    const s = windows.pi_session;
    if (!s || !['flat', 'cwd-encoded'].includes(s.storage_layout) || typeof s.session_directory !== 'string' ||
        !path.win32.isAbsolute(s.session_directory) || !sameCwd(s.launch_cwd, round.cwd, { platform: 'win32' }) ||
        !sameCwd(run.cwd, round.cwd, { platform: 'win32' }) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(s.session_id ?? '') ||
        s.session_id !== run.headless.designated_session_id) {
      round.problem = 'invalid_windows_session'; continue;
    }
    round.pi_session = s;
  }
}

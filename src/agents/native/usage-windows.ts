/** Decode historical Windows launch evidence without consulting live PATH. */
import path from 'node:path';
import {agentProfiles,usageReadable} from '../registry.js';
import {sameUsageCwd as sameCwd} from '../usage-session.js';
import type {UsageRunFact} from '../usage.js';
import type {StoreLocation} from '../runtime-contract.js';
export interface LegacyUsageRound {task_id:string;role:string;cwd:string;agent?:string;problem?:string;route_args?:string[];pi_session?:StoreLocation&{session_id:string};windows_attempt?:{attempt_id?:string;base_version:number;route_agent?:string;delivery_agent?:string}}
export function bindWindowsPi(rounds: LegacyUsageRound[], runs: UsageRunFact[], options: {root?:string} = {}) {
  for (const round of rounds.filter(r => r.windows_attempt && !r.problem)) {
    const attempt=round.windows_attempt!;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(attempt.attempt_id ?? '')) {
      round.problem = 'invalid_windows_launch'; continue;
    }
    const matches = runs.filter(r => r.task_id === round.task_id && r.headless?.role === round.role &&
      r.headless.attempt_id === attempt.attempt_id && r.headless.base_version === attempt.base_version);
    if (matches.length !== 1) { round.problem = matches.length ? 'ambiguous_windows_run' : 'missing_windows_run'; continue; }
    const run = matches[0]!, ownership=run.headless!, windows = ownership.windows, target = windows?.target;
    if (!attempt.route_agent || ownership.route?.agent !== attempt.route_agent ||
        JSON.stringify(ownership.route.args) !== JSON.stringify(round.route_args) ||
        windows?.schema !== 1 || !usageReadable(target?.agent,'task-usage-v1',options.root) ||
        typeof target?.executable !== 'string' || !path.win32.isAbsolute(target.executable) ||
        !Array.isArray(target.prefix_args) || !target.prefix_args.every((a:unknown) => typeof a === 'string' && !a.includes('\0')) ||
        !Array.isArray(windows.logical_argv) || windows.logical_argv[0] !== target.agent ||
        !windows.logical_argv.every((a:unknown) => typeof a === 'string' && !a.includes('\0')) ||
        (windows.pi_session && agentProfiles.get(target.agent,'posix',options.root)?.value.session.fresh_identity !== 'designated') ||
        !sameCwd(run.cwd, round.cwd, { platform: 'win32' })) {
      round.problem = 'invalid_windows_session'; continue;
    }
    round.agent = target.agent;
    if (attempt.delivery_agent && attempt.delivery_agent !== round.agent) {
      round.problem = 'agent_conflict'; continue;
    }
    if (round.agent !== 'pi') continue;
    const s = windows!.pi_session;
    if (!s || !['flat', 'cwd-encoded'].includes(s.storage_layout) || typeof s.session_directory !== 'string' ||
        !path.win32.isAbsolute(s.session_directory) || !sameCwd(s.launch_cwd, round.cwd, { platform: 'win32' }) ||
        !sameCwd(run.cwd, round.cwd, { platform: 'win32' }) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(s.session_id ?? '') ||
        s.session_id !== ownership.designated_session_id) {
      round.problem = 'invalid_windows_session'; continue;
    }
    round.pi_session = s;
  }
}

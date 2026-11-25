import { describe, expect, it } from 'vitest';
import { nativeArgv, previousSession } from '../../../src/standalone/launcher-detached/plan.js';
import { sessionFromLine } from '../../../src/core/run/supervisor.js';
import type { RunMeta } from '../../../src/core/run/store.js';

const session = 'ses_e7f2e2f6fffeBQoeooTlXeirvi';
const route = { agent: '/usr/local/bin/opencode', args: ['--model', 'zai-coding-plan/glm-5.3-flash', '--auto'] };
const prompt = '--session fake\n任务 空格🙂 "quote" $HOME `echo literal`';

describe('OpenCode detached native contract', () => {
  it('creates a session natively and sends the complete literal prompt after --', () => {
    expect(nativeArgv(route, prompt)).toEqual([
      route.agent, 'run', ...route.args, '--format', 'json', '--', prompt,
    ]);
    expect(nativeArgv(route, prompt, session)).toEqual([
      route.agent, 'run', ...route.args, '--format', 'json', '--session', session, '--', prompt,
    ]);
    expect(nativeArgv({ agent: 'opencode', args: ['run', '--auto', '--format=json', '--model=x/y', '--standalone'] }, prompt))
      .toEqual(['opencode', 'run', '--auto', '--format=json', '--model=x/y', '--standalone', '--', prompt]);
  });

  it.each([[], ['--model', 'x/y'], ['--title', '--auto'], ['--title=--auto'], ['--auto=false']])('refuses missing or ineffective --auto: %j', (...args) => {
    expect(() => nativeArgv({ agent: 'opencode', args }, prompt)).toThrow();
  });
  it('gives an actionable missing --auto reason', () => {
    expect(() => nativeArgv({ agent: 'opencode', args: [] }, prompt)).toThrow('requires explicit --auto');
  });

  it.each([
    ['--session', session], ['--session=' + session], ['-s', session], ['-s' + session],
    ['--continue'], ['-c'], ['--fork'], ['--format', 'default'], ['--format=json', '--format=json'],
    ['--model'], ['--model='], ['--help'], ['--server', 'http://elsewhere'], ['--'], ['extra-prompt'], ['run', 'run'],
  ])('rejects route selectors, alternate output and unsupported arguments: %j', (...args) => {
    expect(() => nativeArgv({ agent: 'opencode', args: ['--auto', ...args] }, prompt)).toThrow();
  });

  it('only accepts native ses_ identities for continuation', () => {
    for (const id of ['', 'not-a-session', 'ses_', 'ses_a b', 'ses_../escape']) {
      expect(() => nativeArgv(route, prompt, id)).toThrow('session identity');
    }
  });

  it('captures native frame sessionID without accepting arbitrary JSON or another agent format', () => {
    const frame = { type: 'step_start', timestamp: 1793162598322, sessionID: session, part: { type: 'step-start' } };
    for (const type of ['step_start', 'text', 'reasoning', 'tool_use', 'step_finish', 'error']) {
      expect(sessionFromLine(JSON.stringify({ ...frame, type }), 'opencode')).toBe(session);
    }
    for (const invalid of [null, {}, { sessionID: session }, { ...frame, type: 'unknown' }, { ...frame, timestamp: 'now' },
      { ...frame, sessionID: 'not-ses' }, { ...frame, sessionID: '' }, { ...frame, sessionID: undefined }, { ...frame, sessionID: 'ses_bad\nline' }]) {
      expect(sessionFromLine(JSON.stringify(invalid), 'opencode')).toBeUndefined();
    }
    expect(sessionFromLine(JSON.stringify(frame))).toBeUndefined();
    expect(sessionFromLine('{"type":"thread.started","thread_id":"12345678"}', 'opencode')).toBeUndefined();
    expect(sessionFromLine('partial {"sessionID":', 'opencode')).toBeUndefined();
  });

  it('continues only observed, completed, matching task/role/route/checkout sessions', () => {
    const task = { task_id: 't', title: 'test' };
    const old = { run_id: 'old', task_id: 't', cwd: '/checkout', started_at: '2026-10-27', ended_at: '2026-10-28',
      agent_session_id: session, headless: { role: 'executor', route, designated_session_id: 'ses_unobserved' } } as RunMeta;
    const find = (runs: RunMeta[]) => previousSession(runs, task, 'executor', route, '/checkout');
    expect(find([old])).toEqual({ id: session, run: 'old', reason: 'resume: exact native role session' });
    expect(find([{ ...old, agent_session_id: undefined } as unknown as RunMeta])).toMatchObject({ reason: 'fresh: native session identity unavailable' });
    // A damaged declared identity is an error, never fresh-session fallback.
    expect(()=>find([{ ...old, agent_session_id: 'invalid' }])).toThrow('opencode-session-unavailable');
    expect(find([{ ...old, ended_at: undefined } as unknown as RunMeta]).id).toBeUndefined();
    expect(find([{ ...old, task_id: 'other' }]).id).toBeUndefined();
    expect(find([{ ...old, cwd: '/other' }]).id).toBeUndefined();
    expect(find([{ ...old, headless: { ...old.headless!, route: { ...route, args: ['--auto'] } } }]).id).toBeUndefined();
    expect(previousSession([old], task, 'reviewer', route, '/checkout').id).toBeUndefined();
    expect(previousSession([{ ...old, headless: { ...old.headless!, role: 'architect' } }], task, 'architect', route, '/checkout').id).toBeUndefined();
    expect(previousSession([old], task, 'executor', route, '/checkout', '').id).toBeUndefined();
    // Do not fall back to an older run when the most recent one has no observed identity.
    expect(find([old, { ...old, run_id: 'newer', started_at: '2026-10-28', agent_session_id: undefined } as unknown as RunMeta]).id).toBeUndefined();
  });
});

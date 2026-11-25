import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RunStore, complete, type RunMeta } from '../../../src/core/run/store.js';
import { planResume, parsePlainOpencodeArgv } from '../../../src/core/run/resume.js';
import { metaCarriesSession } from '../../../src/core/run/admission.js';
import { startServer, type RunningServer } from '../../../src/hub/server.js';
import { hubCreate, hubDecide, hubPublish, hubRead } from '../../../src/hub/hub-client.js';
import { writeNodeExecutable } from '../../helpers/executable.js';

const nativeControl = await import(path.resolve('dist/core/run/control.js')) as typeof import('../../../src/core/run/control.js');
const roots: string[] = [], servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const r of roots.splice(0)) {
    const store = new RunStore(r);
    for (const id of store.list()) {
      try { if (!complete(store.read(id))) await nativeControl.stopRun(store, id); } catch { /* a failed startup has no process */ }
    }
    await rm(r, { recursive: true, force: true });
  }
});
function root(): string {
  const r = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tut-opencode-continuity-')));
  roots.push(r); return r;
}
async function ended(store: RunStore, id: string): Promise<RunMeta> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    try { const m = store.read(id); if (complete(m)) return m; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`run did not complete: ${id}`);
}
function fakeOpencode(r: string): string {
  mkdirSync(path.join(r, 'bin'), { recursive: true });
  return writeNodeExecutable(path.join(r, 'bin', 'opencode'), String.raw`
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    process.chdir(process.env.PWD ?? process.cwd());
    const args=process.argv.slice(2), index=args.indexOf('--session');
    const id=index<0 ? 'ses_'+crypto.randomBytes(16).toString('hex') : args[index+1];
    const file=path.join(process.cwd(),id+'.json');
    const memory=index<0 ? crypto.randomBytes(16).toString('hex') : JSON.parse(fs.readFileSync(file,'utf8')).memory;
    fs.writeFileSync(file,JSON.stringify({memory}));
    console.log(JSON.stringify({type:'text',timestamp:Date.now(),sessionID:id,
      part:{type:'text',text:JSON.stringify({memory,cwd:process.cwd(),args,git:process.env.GIT_ALLOW_PROTOCOL})}}));
  `);
}
function observation(store: RunStore, id: string): { memory: string; cwd: string; args: string[]; git?: string } {
  const frame = readFileSync(store.logPath(id), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(frame => frame.type === 'text');
  return JSON.parse(frame.part.text);
}
async function cli(r: string, url: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.resolve('dist/cli.js'), ...args], {
      cwd: r, env: { ...process.env, TUT_HUB_ROOT: r, TUT_HUB_URL: url, PWD: r },
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.once('error', reject); p.once('close', code => resolve({ code, out, err }));
  });
}

describe.skipIf(process.platform === 'win32')('OpenCode continuity through production CLI doors', () => {
  it('start-next reuses the captured session and manual resume keeps memory, checkout and managed gates', { timeout: 40_000 }, async () => {
    const r = root(), checkout = path.join(r, 'task checkout'); mkdirSync(checkout);
    mkdirSync(path.join(r, '.context-hub'));
    writeFileSync(path.join(r, '.context-hub', 'config.json'), JSON.stringify({ launch_mode: 'detached', flow_mode: 'manual' }));
    const server = await startServer({ root: path.join(r, '.context-hub'), port: 0 }); servers.push(server);
    const agent = fakeOpencode(r), store = new RunStore(r);
    const task = await hubCreate(server.url, { title: 'opencode continuity', description: 'fixture task', creator: 'test-user', role: 'executor', flow: 'direct',
      cast: { executor: { agent, args: ['--auto', '--model', 'fixture/model'] } }, checkout: { kind: 'worktree', path: checkout } });
    const first = await cli(r, server.url, ['start-next', task.task_id]);
    expect(first.code, first.err).toBe(0);
    expect(store.list()).toHaveLength(1);
    const one = await ended(store, store.list()[0]!), memory = observation(store, one.run_id);
    expect(one.agent_session_id).toMatch(/^ses_/);
    expect(one.headless).not.toHaveProperty('designated_session_id');
    expect(memory.cwd).toBe(checkout); expect(memory.args).not.toContain('--session');
    const before = readFileSync(path.join(store.directory(one.run_id), 'meta.json')), oldLog = readFileSync(store.logPath(one.run_id));
    // Model the worker/reviewer deliveries through the real Hub, opening a
    // legitimate revision round. No human approval is synthesized.
    await hubPublish(server.url, { task_id: task.task_id, role: 'executor', content_type: 'code_changes', payload: { summary: 'fixture delivery', body: 'fixture delivery' } });
    await hubPublish(server.url, { task_id: task.task_id, role: 'reviewer', content_type: 'review', payload: { summary: 'fixture revision request', body: 'fixture revision request', verdict: 'fail_code', ref_version: 2 } });
    const second = await cli(r, server.url, ['start-next', task.task_id]);
    expect(second.code, second.err).toBe(0);
    expect(store.list()).toHaveLength(2);
    const two = await ended(store, store.list().find(id => id !== one.run_id)!), continued = observation(store, two.run_id);
    expect(two.agent_session_id).toBe(one.agent_session_id);
    expect(two.headless).toMatchObject({ resume_from_run_id: one.run_id, session_reason: 'resume: exact native role session' });
    expect(continued.memory).toBe(memory.memory); expect(continued.cwd).toBe(checkout);
    expect(continued.args[continued.args.indexOf('--session') + 1]).toBe(one.agent_session_id);
    expect(continued.args.at(-1)).not.toContain(memory.memory);
    const manual = await cli(r, server.url, ['resume', two.run_id, '--', '--literal continuation']);
    expect(manual.code, manual.err).toBe(0);
    const three = await ended(store, manual.out.trim()), resumed = observation(store, three.run_id);
    expect(three.agent_session_id).toBe(one.agent_session_id);
    expect(three.resume).toMatchObject({ from_run_id: two.run_id, agent: 'opencode', identity: 'observed', session_id: one.agent_session_id });
    expect(resumed).toMatchObject({ memory: memory.memory, cwd: checkout, git: '' });
    expect(resumed.args.at(-1)).toBe('--literal continuation');
    const log = await hubRead(server.url, task.task_id);
    expect(log.versions.some(v => (v.payload.launch as { resume_from_run_id?: string } | undefined)?.resume_from_run_id === two.run_id)).toBe(true);
    expect(readFileSync(path.join(store.directory(one.run_id), 'meta.json'))).toEqual(before);
    expect(readFileSync(store.logPath(one.run_id))).toEqual(oldLog);
    await hubDecide(server.url, { task_id: task.task_id, decision: 'close', by: 'test-user' });
    const count = store.list().length, refused = await cli(r, server.url, ['resume', three.run_id]);
    expect(refused.code).toBe(1); expect(refused.err).toContain('task-not-waiting');
    expect(store.list()).toHaveLength(count);
  });

  it('plain resume replaces its selector and prompt using only the observed identity', { timeout: 20_000 }, async () => {
    const r = root(), agent = fakeOpencode(r), store = new RunStore(r);
    const source = await nativeControl.startRun(store, [agent, 'run', '--auto', '--format', 'json', '--', 'first'], r, undefined, { env: { ...process.env, PWD: r } });
    const one = await ended(store, source), first = observation(store, source);
    // A foreign inherited PWD must not redirect a plain manual continuation.
    const env = { ...process.env, PWD: os.tmpdir() };
    const plan = await planResume(store, source, { instruction: 'second', env });
    expect(env.PWD).toBe(os.tmpdir()); expect(plan.env.PWD).toBe(r);
    expect(plan.session).toMatchObject({ agent: 'opencode', session_id: one.agent_session_id, source: 'observed' });
    const result = await cli(r, 'http://127.0.0.1:1', ['resume', source, 'second']);
    expect(result.code, result.err).toBe(0);
    const two = await ended(store, result.out.trim());
    expect(two.agent_session_id).toBe(one.agent_session_id);
    expect(observation(store, two.run_id).memory).toBe(first.memory);
    const again = await planResume(store, two.run_id, { instruction: 'third' });
    expect(again.argv.filter(a => a === '--session')).toHaveLength(1);
    expect(again.argv.at(-1)).toBe('third');
    for (const identity of [undefined, 'invalid', 'ses_']) {
      await store.updateMeta(source, m => { const { agent_session_id: _id, ...rest } = m; return identity === undefined ? rest : { ...rest, agent_session_id: identity }; });
      await expect(planResume(store, source)).rejects.toMatchObject({ reason: 'opencode-session-unavailable' });
    }
  });
});

describe('OpenCode resume argv and early occupancy', () => {
  it('accepts TUT fresh and resumed shapes while preserving option values and literal prompt', () => {
    const args = ['--auto', '--model', 'x/y', '--format=json', '--title', 'run'];
    for (const selected of [[], ['--session', 'ses_native']]) {
      expect(parsePlainOpencodeArgv(['opencode', 'run', ...args, ...selected, '--', '--session ses_prompt'])).toEqual({ agent: 'opencode', optionTokens: args });
    }
  });
  it.each([
    ['run', '--format=json', '--', 'p'], ['run', '--auto', 'ambiguous'], ['run', '--auto', '--', 'p', 'extra'],
    ['run', '--auto', '--session', 'ses_', '--', 'p'], ['run', '--auto', '--continue', '--', 'p'],
    ['run', '--auto', '--session', 'ses_a', '--session', 'ses_b', '--', 'p'],
    ['run', '--auto', '--format', 'default', '--', 'p'], ['serve', '--auto', '--', 'p'],
  ])('refuses ambiguous or interactive plain argv: %j', (...args) => {
    expect(() => parsePlainOpencodeArgv(['opencode', ...args])).toThrow();
  });
  it('recognizes the exact native selector before capture, without reading the prompt as a selector', () => {
    const m = { argv: ['/bin/opencode', 'run', '--auto', '--session', 'ses_busy', '--', 'prompt'] } as RunMeta;
    expect(metaCarriesSession(m, { agent: 'opencode', session_id: 'ses_busy' })).toBe(true);
    expect(metaCarriesSession({ ...m, argv: ['opencode', 'run', '--auto', '--', '--session', 'ses_busy'] }, { agent: 'opencode', session_id: 'ses_busy' })).toBe(false);
  });
});

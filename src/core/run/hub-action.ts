/** Optional Hub side effects run in a bounded disposable process. Never on the
 * supervisor's lifecycle path; no offline queue and no retry of a write. */
import path from 'node:path';
import { HubSession } from '../hub/hub-client.js';
import { canonicalRoot } from '../hub/rig-discovery.js';
import { DEFAULT_HUB_URL } from '../cli/shared.js';

export type HubActionName = 'associate' | 'stop' | 'resume';

export async function hubAction(root: string, action: HubActionName, payload: Record<string, unknown>): Promise<void> {
  const base = process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL;
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('optional Hub must be loopback HTTP');
  const response = await fetch(new URL('/state?include=closed', url), { signal: AbortSignal.timeout(1000), redirect: 'error', headers: { Connection: 'close' } });
  if (!response.ok) throw new Error(`Hub state HTTP ${response.status}`);
  const state = await response.json() as { hub_root?: string; tasks?: { task_id?: string }[] };
  if (!state.hub_root || !path.isAbsolute(state.hub_root) || canonicalRoot(state.hub_root) !== canonicalRoot(root)) throw new Error('Hub root unverified/mismatched');
  if (action === 'associate') {
    if (!state.tasks?.some(t => t.task_id === payload.task_id)) throw new Error('task association unverified (missing/degraded task)');
    return;
  }
  if (action === 'resume') {
    // System operation audit on the project scope — explicit about NOT being a
    // human instruction, decision, ack, or launch (no task-scope wake-up loop).
    const session = new HubSession(base, { timeoutMs: 1000, clientName: 'tut-run-audit' });
    try {
      await session.call('context.publish', { task_id: 'project', role: 'human', agent: 'tut', content_type: 'note', payload: {
        summary: `CLI resume audit: ${payload.from_run_id} → ${payload.run_id ?? 'unconfirmed'}`,
        body: `System resume operation audit recorded by tut; not a human approval or authorization evidence.\n\n${JSON.stringify(payload)}`,
        operation: 'resume', ...payload,
      } });
    } finally { await session.close(); }
    return;
  }
  const session = new HubSession(base, { timeoutMs: 1000, clientName: 'tut-run-audit' });
  try {
    await session.call('context.publish', { task_id: 'project', role: 'human', agent: 'tut', content_type: 'note', payload: {
      summary: `CLI stop audit: ${payload.run_id}`, body: `CLI invocation audit, not human approval or authorization evidence.\n\n${JSON.stringify(payload)}`, ...payload,
    } });
  } finally { await session.close(); }
}
if (process.argv[2] === '--hub-action') {
  const deadline = setTimeout(() => { process.stderr.write('optional Hub budget exhausted; association/note unconfirmed\n'); process.exit(1); }, 1800);
  void hubAction(process.argv[3]!, process.argv[4] as HubActionName, JSON.parse(process.argv[5]!)).then(
    () => { clearTimeout(deadline); },
    e => { clearTimeout(deadline); process.stderr.write(`${(e as Error).message}\n`); process.exitCode = 1; },
  );
}

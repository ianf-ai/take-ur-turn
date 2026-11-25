import type { ChildProcess } from 'node:child_process';
import { RunStore, delay, probe } from '../../src/core/run/store.js';
import { stopWindowsFixtureRuns } from './run-cleanup.js';

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (probe(pid) !== false) {
    if (Date.now() >= deadline) throw new Error(`fixture process ${pid} did not exit`);
    await delay(25);
  }
}

function killGroup(pgid: number): void {
  try { process.kill(-pgid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

/** #113's register-at-spawn, SIGKILL, then await-close pattern. A detached
 * POSIX group remains owned even when its original leader has already exited. */
export class FixtureReaper {
  private children: { child: ChildProcess; group: boolean }[] = [];

  track<T extends ChildProcess>(child: T, detached = false): T {
    this.children.push({ child, group: detached && process.platform !== 'win32' });
    return child;
  }

  async reap(): Promise<void> {
    const results = await Promise.allSettled(this.children.splice(0).map(async ({ child, group }) => {
      const running = child.exitCode === null && child.signalCode === null && child.pid !== undefined;
      // Register during teardown: consumers may have removed old listeners.
      const closed = running ? new Promise<void>(resolve => child.once('close', () => resolve())) : undefined;
      if (running) child.kill('SIGKILL');
      await closed;
      if (group && child.pid) {
        // Reap the original child first: on macOS a group containing only its
        // uncollected zombie can reject a duplicate group signal with EPERM.
        // A surviving descendant still belongs to this registered group.
        killGroup(child.pid);
        await waitForExit(-child.pid);
      }
    }));
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'fixture children did not exit');
  }
}

/** Discover runs from this test's registered roots, including runs launched
 * before a failing assertion could collect their ids. Never sweep by name.
 * RunStore is the read channel; archives are retained unchanged. */
export async function reapFixtureRuns(roots: readonly string[]): Promise<void> {
  if (process.platform === 'win32') return stopWindowsFixtureRuns(roots);
  const runs = roots.flatMap(root => {
    const store = new RunStore(root);
    return store.list().flatMap(id => {
      try { return [store.read(id)]; }
      catch { return []; } // Deliberately invalid archives do not identify a process.
    });
  });
  const results = await Promise.allSettled(runs.map(async meta => {
    killGroup(meta.pgid);
    await waitForExit(-meta.pgid);
    // The supervisor is outside the command group; let it reap its child and
    // finish writing completion before the caller removes any fixture roots.
    await waitForExit(meta.supervisor_pid);
  }));
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (errors.length) throw new AggregateError(errors, 'fixture runs did not exit; roots retained');
}

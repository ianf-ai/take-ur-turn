import { RunStore, complete } from '../../src/core/run/store.js';
import { stopRun } from '../../src/core/run/control.js';
import { WINDOWS_PROTOCOL } from '../../src/core/run/windows-protocol.js';

/** Only runs created beneath this test's roots; use the owning supervisor,
 * never a Windows negative PID or a process-name sweep. Preserve failures. */
export async function stopWindowsFixtureRuns(roots: readonly string[]): Promise<void> {
  if (process.platform !== 'win32') return;
  const errors: unknown[] = [];
  for (const root of roots) {
    const store = new RunStore(root);
    for (const id of store.list()) {
      let meta;
      try { meta = store.read(id); } catch { continue; } // invalid archive fixtures own no process
      if (meta.control_protocol !== WINDOWS_PROTOCOL || complete(meta)) continue;
      try {
        const result = await stopRun(store, id);
        if (!result.success) throw new Error(`fixture cleanup ${id}: ${result.result}`);
      } catch (error) {
        errors.push(new Error(`fixture cleanup ${id} (${root}): ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    }
  }
  if (errors.length) throw new AggregateError(errors,
    'Windows fixture runs did not finish; evidence retained:\n' + errors.map(error => error instanceof Error ? error.message : String(error)).join('\n'));
}

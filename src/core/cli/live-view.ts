/** tut live-view --layout <json-file> — . The read-only seat grid. */
import { readFileSync } from 'node:fs';
import { resolveRigRoot } from '../hub/rig-discovery.js';
import { RunStore } from '../run/store.js';
import { LiveView } from '../../herdr/live-view/view.js';
import type { ParsedArgs } from './args.js';

export async function runLiveViewCommand(p: Extract<ParsedArgs, { command: 'live-view' }>): Promise<number> {
  let layoutText: string;
  try {
    layoutText = readFileSync(p.layout, 'utf8');
  } catch (e) {
    process.stderr.write(`tut: cannot read layout file ${p.layout}: ${(e as Error).message}\n`);
    return 1;
  }
  if (!process.stdout.isTTY) {
    // A non-TTY stdout cannot host a grid; refuse instead of smearing broken
    // frames through a pipe (design: point the user at tut attach).
    process.stderr.write('tut: live-view requires a TTY on stdout; to follow one run use: tut attach <run-id>\n');
    return 1;
  }
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt);
  try {
    const view = new LiveView({
      layoutText,
      store: new RunStore(resolveRigRoot()),
      terminal: { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24, isTTY: true },
      size: () => ({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }),
      signal: abort.signal,
    });
    return await view.run();
  } catch (e) {
    process.stderr.write(`tut: ${(e as Error).message}\n`);
    return 1;
  } finally {
    process.off('SIGINT', interrupt);
  }
}

/**
 * live-view runtime: a closable read-only terminal grid. Each
 * seat runs ONLY `<node> <absolute dist/cli.js> attach <run-id>` — the same
 * package's attach, never `tut run` (no pseudo agent runs) — with stdin
 * ignored: the parent establishes NO typing channel, and no stop/resume/
 * decide/pane operation is ever issued.
 *
 * Lifecycle: Ctrl-C (or any exit) ends THIS process and its attach children
 * only. The observed run's process group is never signalled — attach itself
 * owns that discipline. Seats switch to a newly resolved run by dropping the
 * old attach, clearing the buffer, and marking the new run-id. A finished run
 * keeps its last screen and real outcome in the seat.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { RunStore, complete, type RunMeta } from '../../core/run/store.js';
import { gridGeometry, renderFrame, SeatBuffer, type SeatRenderState } from './render.js';
import { parseLayoutText, resolveSeat, type LayoutSpec, type SeatSpec } from './layout.js';

/** The absolute CLI entry of THIS package (dist/cli.js above dist/herdr/live-view/). */
export const CLI_ENTRY = fileURLToPath(new URL('../../cli.js', import.meta.url));

export interface AttachSpawnDeps {
  spawnAttach?: (cliEntry: string, runId: string) => ChildProcess;
  stdout?: import("node:stream").Writable;
}

interface SeatRuntime {
  spec: SeatSpec;
  buffer: SeatBuffer;
  child?: ChildProcess | undefined;
  currentRun?: string | undefined;
  header: string;
  childError?: string | undefined;
  exitCode: number | null | undefined;
}

export interface LiveViewOptions extends AttachSpawnDeps {
  layoutText: string;
  store: RunStore;
  /** Live terminal size (SIGWINCH refreshes geometry); defaults to
   *  process.stdout's current columns/rows. */
  size?: () => { columns: number; rows: number };
  terminal: { columns: number; rows: number; isTTY: boolean };
  /** Resize notifications (defaults to process.stdout's resize event). */
  resizer?: EventEmitter;
  signal: AbortSignal;
  /** Render interval floor (default 150ms; test seam). */
  frameMs?: number;
  /** Selector poll interval (default 1000ms; test seam). */
  pollMs?: number;
}

function seatHeaderFor(spec: SeatSpec, detail: string): string {
  const target = 'task_id' in spec.selector ? `${spec.selector.task_id}/${spec.selector.role}` : spec.selector.run_id;
  return `${target} \u00b7 ${detail}`;
}

function metaDetail(meta: RunMeta | undefined): string {
  if (meta === undefined) return 'attach exited';
  const status = meta.status;
  const outcome = meta.ended_at
    ? `ended${meta.exit_code !== undefined ? ` code=${meta.exit_code}` : ''}${meta.exit_signal ? ` signal=${meta.exit_signal}` : ''}${complete(meta) ? '' : ' (stop unconfirmed)'}`
    : status;
  return outcome;
}

export class LiveView {
  private readonly layout: LayoutSpec;
  private readonly seats = new Map<string, SeatRuntime>();
  private readonly store: RunStore;
  private readonly stdout: import("node:stream").Writable;
  private readonly signal: AbortSignal;
  private readonly spawnAttach: (cliEntry: string, runId: string) => ChildProcess;
  private readonly size: () => { columns: number; rows: number };
  private readonly frameMs: number;
  private readonly pollMs: number;
  private readonly resizer: EventEmitter;
  private lastFrameAt = 0;
  private lastFrame = '';
  constructor(private readonly options: LiveViewOptions) {
    const parsed = parseLayoutText(options.layoutText);
    if ('error' in parsed) throw new Error(`invalid layout: ${parsed.error}`);
    this.layout = parsed;
    this.store = options.store;
    this.stdout = options.stdout ?? process.stdout;
    this.signal = options.signal;
    this.spawnAttach = options.spawnAttach ?? ((cliEntry, runId) =>
      spawn(process.execPath, [cliEntry, 'attach', runId], { stdio: ['ignore', 'pipe', 'pipe'], shell: false }));
    this.size = options.size ?? (() => ({ columns: options.terminal.columns, rows: options.terminal.rows }));
    this.frameMs = options.frameMs ?? 150;
    this.pollMs = options.pollMs ?? 1000;
    this.resizer = options.resizer ?? process.stdout;
    for (const spec of this.layout.seats) {
      this.seats.set(spec.id, { spec, buffer: new SeatBuffer(), header: seatHeaderFor(spec, 'resolving…'), exitCode: undefined });
    }
  }

  /** One selector poll: resolve every seat, switch seats to new runs. */
  poll(): void {
    const runIds = this.store.list();
    for (const seat of this.seats.values()) {
      const resolution = resolveSeat(this.store, seat.spec.selector, runIds);
      if (resolution.kind === 'run') {
        if (seat.currentRun !== resolution.run_id) {
          this.retach(seat, resolution.run_id);
        } else {
          let meta: RunMeta | undefined;
          try { meta = this.store.read(resolution.run_id); } catch { meta = undefined; }
          seat.header = seatHeaderFor(seat.spec, `${resolution.run_id} \u00b7 ${metaDetail(meta)}${seat.exitCode !== undefined ? ` \u00b7 attach exit=${seat.exitCode}` : ''}`);
        }
      } else if (resolution.kind === 'waiting') {
        this.retach(seat, undefined);
        seat.header = seatHeaderFor(seat.spec, 'waiting for a run');
      } else if (resolution.kind === 'conflict') {
        // Keep showing the current content; the conflict is explicit.
        seat.header = seatHeaderFor(seat.spec, `conflict: ${resolution.runs.length} incomplete runs (${resolution.runs.slice(0, 2).join(', ')}${resolution.runs.length > 2 ? '…' : ''})`);
      } else if (resolution.kind === 'unknown-run') {
        this.retach(seat, undefined);
        seat.header = seatHeaderFor(seat.spec, `unknown run ${resolution.run_id}`);
      } else {
        seat.header = seatHeaderFor(seat.spec, `unreadable store: ${resolution.error}`);
      }
    }
  }

  /** Switch a seat to a run (or to waiting): old attach stops — its stream
   *  listeners are removed AND every handler still guards on the seat's
   *  CURRENT child, so late data from a killed pipe can never land in the
   *  new seat's buffer — the buffer is cleared with a fresh decoder, and
   *  the new run-id is marked. The observed run itself is untouched. */
  private retach(seat: SeatRuntime, runId: string | undefined): void {
    if (seat.child !== undefined) {
      const old = seat.child;
      old.removeAllListeners();
      old.stdout?.removeAllListeners('data');
      old.stderr?.removeAllListeners('data');
      old.kill('SIGTERM');
      seat.child = undefined;
    }
    seat.exitCode = undefined;
    seat.childError = undefined;
    seat.currentRun = runId;
    seat.buffer.clear();
    if (runId === undefined) return;
    seat.header = seatHeaderFor(seat.spec, `${runId} \u00b7 attaching…`);
    const child = this.spawnAttach(CLI_ENTRY, runId);
    seat.child = child;
    child.stdout?.on('data', (chunk: Buffer) => { if (seat.child === child) seat.buffer.push(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (seat.child !== child) return;
      seat.childError = chunk.toString('utf8').trim().split('\n').at(-1);
    });
    // Finalize on 'close', NOT 'exit' — Node emits 'close' only after
    // the child's stdio streams have drained, so the legitimate final tail
    // (data flushed by the child right before/after exiting) still passes the
    // seat.child===child guard and lands in the last screen. A seat switch
    // (retach) removes these listeners and clears seat.child first, keeping
    // the decoder isolation intact.
    child.once('close', (code) => {
      if (seat.child === child) {
        seat.exitCode = code;
        seat.child = undefined;
      }
    });
    child.once('error', (e) => {
      if (seat.child === child) {
        seat.childError = `attach spawn failed: ${(e as Error).message}`;
        seat.child = undefined;
      }
    });
  }

  /** Compose and (optionally) emit the current frame. */
  renderFrame(emit: boolean): string {
    const current = this.size();
    const geometry = gridGeometry(this.layout, { columns: current.columns, rows: current.rows });
    let frameText: string;
    if ('error' in geometry) {
      const line = `live-view: ${geometry.error} — resize the terminal`;
      frameText = `${line}\n`;
    } else {
      const cells = new Map<string, SeatRenderState>();
      for (const seat of this.seats.values()) {
        const lines = seat.buffer.view();
        const extra = seat.childError !== undefined ? [`[attach] ${seat.childError}`] : [];
        cells.set(seat.spec.id, { id: seat.spec.id, ...(seat.spec.label !== undefined ? { label: seat.spec.label } : {}), header: seat.header, lines: [...extra, ...lines] });
      }
      frameText = renderFrame(cells, this.layout, geometry).join('\n');
    }
    if (emit && frameText !== this.lastFrame) {
      this.lastFrame = frameText;
      // Cursor discipline: home, clear each line's tail, no scrolling writes.
      this.stdout.write(`\x1b[H\x1b[2J${frameText}\n`);
    }
    return frameText;
  }

  private readonly onResize = (): void => { this.lastFrameAt = 0; };

  /** Main loop until abort. Returns a process exit code. */
  async run(): Promise<number> {
    this.resizer.on('resize', this.onResize);
    this.stdout.write('\x1b[?25l'); // hide cursor while redrawing
    let lastPoll = 0;
    try {
      while (!this.signal.aborted) {
        const now = Date.now();
        if (now - lastPoll >= this.pollMs) {
          lastPoll = now;
          this.poll();
        }
        if (now - this.lastFrameAt >= this.frameMs) {
          this.lastFrameAt = now;
          this.renderFrame(true);
        }
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(this.frameMs, 100)));
      }
      return 130;
    } finally {
      this.resizer.off('resize', this.onResize);
      for (const seat of this.seats.values()) {
        seat.child?.removeAllListeners();
        seat.child?.kill('SIGTERM');
        seat.child = undefined;
      }
      this.stdout.write('\x1b[?25h'); // restore cursor
    }
  }
}

export { seatHeaderFor, metaDetail };

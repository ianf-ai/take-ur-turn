import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { RunStore, type RunMeta, type HeadlessOwnership } from '../src/core/run/store.js';
import { CONTROL_PROTOCOL } from '../src/core/run/protocol.js';
import { parseLayout, parseLayoutText, resolveSeat } from '../src/herdr/live-view/layout.js';
import { sanitizeLine, displayWidth, fitToWidth, padToWidth, SeatBuffer, gridGeometry, renderSeat, renderFrame, type SeatRenderState } from '../src/herdr/live-view/render.js';
import { LiveView, CLI_ENTRY } from '../src/herdr/live-view/view.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function root(): string { const r = mkdtempSync(path.join(os.tmpdir(), 'tut-liveview-')); roots.push(r); return r; }

function meta(store: RunStore, id: string, patch: Partial<RunMeta> = {}): RunMeta {
  const at = new Date().toISOString();
  const base: RunMeta = { run_id: id, pid: 900001, pgid: 900001, argv: ['agent'], cwd: store.hubRoot, supervisor_pid: 900002,
    started_at: at, status: 'running', control_protocol: CONTROL_PROTOCOL, ...patch };
  closeSync(store.openLog(id, true));
  return base;
}
async function put(store: RunStore, patch: Partial<RunMeta> = {}): Promise<string> {
  const id = store.create();
  await store.initialize(id, meta(store, id, patch));
  return id;
}
function ownership(role: string, taskId: string): HeadlessOwnership {
  return { schema: 1, role, attempt_id: crypto.randomUUID(), base_version: 1, trigger_version: 1,
    route: { agent: 'codex', args: [] }, route_source: 'task-cast', session_reason: 'fixture' };
}

describe('layout validation', () => {
  const valid = { schema: 1, rows: 2, columns: 2, seats: [
    { id: 'a', row: 0, column: 0, selector: { task_id: 't1', role: 'executor' } },
    { id: 'b', row: 1, column: 1, label: 'rev', selector: { run_id: '20260101T000000000Z-00000000' } },
  ] };
  it('accepts a valid layout and normalizes nothing silently', () => {
    const parsed = parseLayout(valid);
    expect('error' in parsed && parsed.error).toBeFalsy();
    expect(parsed).toMatchObject({ rows: 2, columns: 2 });
  });
  it('rejects bad schema, bounds, duplicates, selectors, and cells before any subprocess', () => {
    for (const bad of [
      { ...valid, schema: 2 },
      { ...valid, rows: 0 },
      { ...valid, rows: 1.5 },
      { ...valid, rows: 17 },
      { ...valid, seats: [] },
      { ...valid, seats: [...valid.seats, { id: 'c', row: 1, column: 0 }, { id: 'd', row: 1, column: 0 }] },
      { ...valid, seats: [...valid.seats, { id: 'a', row: 0, column: 1, selector: { run_id: '20260101T000000000Z-00000000' } }] },
      { ...valid, seats: [{ id: 'x', row: 5, column: 0, selector: { task_id: 't', role: 'executor' } }] },
      { ...valid, seats: [{ id: 'x', row: 0, column: 0, selector: { task_id: 't', role: 'host' } }] },
      { ...valid, seats: [{ id: 'x', row: 0, column: 0, selector: { task_id: 't' } }] },
      { ...valid, seats: [{ id: 'x', row: 0, column: 0, selector: { run_id: 'not-a-run' } }] },
      { ...valid, seats: [{ id: '', row: 0, column: 0, selector: { task_id: 't', role: 'executor' } }] },
    ]) {
      const parsed = parseLayout(bad);
      expect('error' in parsed ? parsed.error : 'no error').toBeTruthy();
    }
    expect('error' in parseLayoutText('{ nope')).toBe(true);
  });
});

describe('seat resolution', () => {
  it('task+role matches explicit headless ownership only; plain task runs never imply a role', async () => {
    const r = root(); const store = new RunStore(r);
    const plain = await put(store, { task_id: 't1' });
    expect(resolveSeat(store, { task_id: 't1', role: 'executor' })).toEqual({ kind: 'waiting' });
    const owned = await put(store, { task_id: 't1', headless: ownership('executor', 't1') });
    expect(resolveSeat(store, { task_id: 't1', role: 'executor' })).toEqual({ kind: 'run', run_id: owned });
    expect(resolveSeat(store, { task_id: 't1', role: 'reviewer' })).toEqual({ kind: 'waiting' });
    void plain;
  });
  it('one incomplete run shows; several conflict; all complete → latest started_at', async () => {
    const r = root(); const store = new RunStore(r);
    const a = await put(store, { task_id: 't2', headless: ownership('executor', 't2'), started_at: '2026-01-01T00:00:00.000Z' });
    const b = await put(store, { task_id: 't2', headless: ownership('executor', 't2'), started_at: '2026-01-02T00:00:00.000Z' });
    expect(resolveSeat(store, { task_id: 't2', role: 'executor' })).toMatchObject({ kind: 'conflict', runs: expect.arrayContaining([a, b]) });
    // One incomplete remains → it shows.
    await store.updateMeta(a, m => ({ ...m, ended_at: m.started_at }));
    expect(resolveSeat(store, { task_id: 't2', role: 'executor' })).toEqual({ kind: 'run', run_id: b });
    // All complete → the latest started_at wins.
    await store.updateMeta(b, m => ({ ...m, ended_at: m.started_at }));
    expect(resolveSeat(store, { task_id: 't2', role: 'executor' })).toEqual({ kind: 'run', run_id: b });
  });
  it('fixed run-id selectors never follow another run; unknown ids are honest', async () => {
    const r = root(); const store = new RunStore(r);
    const a = await put(store, {});
    expect(resolveSeat(store, { run_id: a })).toEqual({ kind: 'run', run_id: a });
    expect(resolveSeat(store, { run_id: '20260101T000000000Z-deadbeef' })).toMatchObject({ kind: 'unknown-run' });
  });
});

describe('sanitization and buffers', () => {
  it('strips CSI/OSC/escape sequences and neutralizes control characters', () => {
    expect(sanitizeLine('\x1b[31mred\x1b[0m plain')).toBe('red plain');
    expect(sanitizeLine('\x1b]0;title\x07after')).toBe('after');
    expect(sanitizeLine('\x1bMok')).toBe('ok');
    expect(sanitizeLine('a\u0000b\u0007c')).toBe('a\u00b7b\u00b7c');
    expect(sanitizeLine('tab\there')).toBe('tab    here');
  });
  it('display width approximates CJK as double-width; fit/pad keep borders aligned', () => {
    expect(displayWidth('ab')).toBe(2);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a\u0301')).toBe(1); // combining mark
    expect(fitToWidth('abcdefghij', 5)).toBe('abcd\u2026');
    expect(fitToWidth('中文字符', 5)).toBe('中文\u2026');
    expect(displayWidth(padToWidth('中文', 6))).toBe(6);
    expect(padToWidth('abcdef', 3)).toBe('ab\u2026');
  });
  it('buffers lines across chunked UTF-8 and half-lines, bounded', () => {
    const buffer = new SeatBuffer();
    buffer.push(Buffer.from('line1\nline2\npartial'));
    // Split every multi-byte character of 中文一 across separate pushes.
    const bytes = Buffer.from('中文一');
    for (let i = 0; i < bytes.length; i++) buffer.push(bytes.subarray(i, i + 1));
    buffer.push(Buffer.from('\n'));
    expect(buffer.view()).toEqual(['line1', 'line2', 'partial中文一']);
    buffer.push(Buffer.from(`\n${'x'.repeat(5000)}\n`));
    const view = buffer.view();
    expect(view.at(-1)!.length).toBe(4096); // long line truncated
    buffer.clear();
    expect(buffer.view()).toEqual([]);
  });
});

describe('frame rendering', () => {
  it('geometry rejects too-small terminals', () => {
    expect('error' in gridGeometry({ rows: 2, columns: 2 }, { columns: 40, rows: 8 })).toBe(true);
    expect('error' in gridGeometry({ rows: 1, columns: 2 }, { columns: 200, rows: 4 })).toBe(true);
    expect('error' in gridGeometry({ rows: 1, columns: 1 }, { columns: 80, rows: 24 })).toBe(false);
  });
  it('each seat renders exactly cellHeight lines of cellWidth columns, frame joins cells', () => {
    const geometry = { rows: 1, columns: 2, cellWidth: 30, cellHeight: 6 };
    const seat: SeatRenderState = { id: 'a', header: 'run X · running', lines: ['hello', '中文宽字符', 'x'.repeat(60)] };
    const lines = renderSeat(seat, geometry);
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(displayWidth(line)).toBe(30);
    expect(lines[0]!.startsWith('┌')).toBe(true);
    expect(lines.at(-1)!.startsWith('└')).toBe(true);
    const frame = renderFrame(new Map([['a', seat]]), { rows: 1, columns: 2, seats: [{ id: 'a', row: 0, column: 1 }] }, geometry);
    expect(frame).toHaveLength(6);
    for (const line of frame) expect(displayWidth(line)).toBe(60);
  });
});

describe('LiveView runtime', () => {
  function capture(): { stream: Writable; chunks: string[] } {
    const chunks: string[] = [];
    const stream = new Writable({ write(c, _enc, cb) { chunks.push(c.toString('utf8')); cb(); } });
    return { stream, chunks };
  }
  it('spawns same-package attach children with stdin ignored and renders their output', { timeout: 20_000 }, async () => {
    const r = root(); const store = new RunStore(r);
    const id = await put(store, { task_id: 't3', headless: ownership('executor', 't3') });
    const spawned: { argv: string[]; stdio: unknown }[] = [];
    const children: ChildProcess[] = [];
    const view = new LiveView({
      layoutText: JSON.stringify({ schema: 1, rows: 1, columns: 1, seats: [{ id: 's1', row: 0, column: 0, selector: { task_id: 't3', role: 'executor' } }] }),
      store,
      terminal: { columns: 60, rows: 10, isTTY: true },
      signal: new AbortController().signal,
      frameMs: 50, pollMs: 30,
      spawnAttach: (cli, runId) => {
        spawned.push({ argv: [cli, 'attach', runId], stdio: 'ignore' });
        const child = spawn(process.execPath, ['-e', 'console.log("attach output line"); setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        return child;
      },
      stdout: capture().stream,
    });
    view.poll();
    await new Promise(res => setTimeout(res, 250));
    const frame = view.renderFrame(false);
    expect(frame).toContain('attach output line');
    expect(frame).toContain(id);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.argv[0]).toBe(CLI_ENTRY);
    expect(spawned[0]!.argv).toEqual([CLI_ENTRY, 'attach', id]);
    for (const child of children) child.kill('SIGKILL');
  });
  it('switching seats kills the old attach and clears the buffer, marking the new run', { timeout: 20_000 }, async () => {
    const r = root(); const store = new RunStore(r);
    const a = await put(store, { task_id: 't4', headless: ownership('executor', 't4'), started_at: '2026-01-01T00:00:00.000Z' });
    const killed: string[] = [];
    const spawnedRuns: string[] = [];
    const view = new LiveView({
      layoutText: JSON.stringify({ schema: 1, rows: 1, columns: 1, seats: [{ id: 's', row: 0, column: 0, selector: { task_id: 't4', role: 'executor' } }] }),
      store,
      terminal: { columns: 60, rows: 10, isTTY: true },
      signal: new AbortController().signal,
      frameMs: 1000, pollMs: 30,
      spawnAttach: (_cli, runId) => {
        spawnedRuns.push(runId);
        const child = spawn(process.execPath, ['-e', `console.log("out-${runId.slice(-2)}"); setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'pipe'] });
        (child as ChildProcess & { __id?: string }).__id = runId;
        const origKill = child.kill.bind(child);
        child.kill = (signal?: NodeJS.Signals) => { killed.push(runId); return origKill(signal); };
        return child;
      },
      stdout: capture().stream,
    });
    view.poll();
    await new Promise(res => setTimeout(res, 200));
    expect(spawnedRuns).toEqual([a]);
    // The old run completes and a NEW incomplete run appears: the seat switches.
    await store.updateMeta(a, m => ({ ...m, ended_at: m.started_at }));
    const b = await put(store, { task_id: 't4', headless: ownership('executor', 't4'), started_at: '2026-02-01T00:00:00.000Z' });
    view.poll();
    await new Promise(res => setTimeout(res, 100));
    expect(spawnedRuns).toEqual([a, b]);
    expect(killed).toEqual([a]);
    const frame = view.renderFrame(false);
    expect(frame).toContain(b);
    expect(frame).not.toContain(`out-${a.slice(-2)}`); // old output buffer cleared
  });
  it('late stdout/stderr data from the old attach child never reaches the new seat (half UTF-8 included)', async () => {
    const r = root(); const store = new RunStore(r);
    const a = await put(store, { task_id: 't8', headless: ownership('executor', 't8'), started_at: '2026-01-01T00:00:00.000Z' });
    interface FakeChild extends ChildProcess { emitOut(chunk: Buffer): void; emitErr(chunk: Buffer): void; }
    const fakeChildren: FakeChild[] = [];
    const makeFake = (): FakeChild => {
      const stdout: NonNullable<ChildProcess['stdout']> = new EventEmitter() as NonNullable<ChildProcess['stdout']>;
      const stderr: NonNullable<ChildProcess['stderr']> = new EventEmitter() as NonNullable<ChildProcess['stderr']>;
      const child = new EventEmitter() as unknown as FakeChild;
      Object.assign(child, { stdout, stderr, kill: () => true, killed: false });
      child.emitOut = (chunk: Buffer) => stdout.emit('data', chunk);
      child.emitErr = (chunk: Buffer) => stderr.emit('data', chunk);
      fakeChildren.push(child);
      return child;
    };
    const view = new LiveView({
      layoutText: JSON.stringify({ schema: 1, rows: 1, columns: 1, seats: [{ id: 's', row: 0, column: 0, selector: { task_id: 't8', role: 'executor' } }] }),
      store, terminal: { columns: 80, rows: 12, isTTY: true }, signal: new AbortController().signal,
      frameMs: 1000, pollMs: 30,
      spawnAttach: (_cli, runId) => { void runId; return makeFake(); },
      stdout: capture().stream,
    });
    view.poll();
    fakeChildren[0]!.emitOut(Buffer.from('OLD-RUN-DATA\n'));
    fakeChildren[0]!.emitErr(Buffer.from('old stderr line\n'));
    await new Promise(res => setTimeout(res, 80));
    expect(view.renderFrame(false)).toContain('OLD-RUN-DATA');
    // The old run completes and a NEW incomplete run takes the seat.
    await store.updateMeta(a, m => ({ ...m, ended_at: m.started_at }));
    const b = await put(store, { task_id: 't8', headless: ownership('executor', 't8'), started_at: '2026-03-01T00:00:00.000Z' });
    view.poll();
    await new Promise(res => setTimeout(res, 50));
    const frameAfterSwitch = view.renderFrame(false);
    expect(frameAfterSwitch).toContain(b);
    // The OLD child's streams flush late data (already-read bytes, half a
    // multi-byte char, stderr) AFTER the switch: none of it may appear.
    fakeChildren[0]!.emitOut(Buffer.concat([Buffer.from('LATE-STDOUT '), Buffer.from([0xe4])]));
    fakeChildren[0]!.emitErr(Buffer.from('LATE-STDERR\n'));
    fakeChildren[0]!.emit('exit', 1, null);
    const newChild = fakeChildren[1]!;
    newChild.emitOut(Buffer.from('NEW-RUN-DATA\n'));
    const frame = view.renderFrame(false);
    expect(frame).toContain('NEW-RUN-DATA');
    expect(frame).not.toContain('LATE-STDOUT');
    expect(frame).not.toContain('LATE-STDERR');
    expect(frame).not.toContain('OLD-RUN-DATA');
    expect(frame).not.toContain('\ufffd');
  });

  it('The final tail flushed around exit is retained (finalize on close, after streams drain)', { timeout: 20_000 }, async () => {
    const r = root(); const store = new RunStore(r);
    const id = await put(store, { task_id: 't11', headless: ownership('executor', 't11') });
    let realChild: ChildProcess | undefined;
    const view = new LiveView({
      layoutText: JSON.stringify({ schema: 1, rows: 1, columns: 1, seats: [{ id: 's', row: 0, column: 0, selector: { run_id: id } }] }),
      store, terminal: { columns: 200, rows: 12, isTTY: true }, signal: new AbortController().signal,
      frameMs: 2000, pollMs: 30,
      spawnAttach: (_cli, _runId) => {
        // A REAL child whose stdout is a pipe: it writes the tail and exits —
        // Node only emits 'close' after the pipe drains, so the view must
        // have received FINAL-TAIL-AFTER-EXIT by then.
        const child = spawn(process.execPath, ['-e', 'process.stdout.write("BEFORE-EXIT\\n"); process.stdout.write("FINAL-TAIL-AFTER-EXIT"); process.exit(0);'], { stdio: ['ignore', 'pipe', 'pipe'] });
        realChild = child;
        return child;
      },
      stdout: capture().stream,
    });
    view.poll();
    await new Promise<void>(resolve => realChild!.once('close', resolve));
    await new Promise(res => setTimeout(res, 50));
    view.poll(); // refresh the seat header with the finalized attach outcome
    const frame = view.renderFrame(false);
    expect(frame).toContain('BEFORE-EXIT');
    expect(frame).toContain('FINAL-TAIL-AFTER-EXIT'); // the tail survived exit finalization
    expect(frame).toContain('exit=0');
    // Deterministic harness ordering: data BETWEEN exit and close still lands,
    // and close (not exit) finalizes the seat.
    const r2 = root(); const store2 = new RunStore(r2);
    const id2 = await put(store2, {});
    let fake: (ChildProcess & { stdout: NonNullable<ChildProcess['stdout']> }) | undefined;
    const view2 = new LiveView({
      layoutText: JSON.stringify({ schema: 1, rows: 1, columns: 1, seats: [{ id: 's', row: 0, column: 0, selector: { run_id: id2 } }] }),
      store: store2, terminal: { columns: 200, rows: 12, isTTY: true }, signal: new AbortController().signal,
      frameMs: 2000, pollMs: 30,
      spawnAttach: () => {
        const stdout: NonNullable<ChildProcess['stdout']> = new EventEmitter() as NonNullable<ChildProcess['stdout']>;
        const child = new EventEmitter() as unknown as ChildProcess & { stdout: NonNullable<ChildProcess['stdout']> };
        Object.assign(child, { stdout, kill: () => true });
        fake = child;
        return child;
      },
      stdout: capture().stream,
    });
    view2.poll();
    fake!.emit('exit', 0, null);                                // exit fires first — must NOT finalize
    fake!.stdout.emit('data', Buffer.from('TAIL-BETWEEN-EXIT-AND-CLOSE\n'));
    const between = view2.renderFrame(false);
    expect(between).toContain('TAIL-BETWEEN-EXIT-AND-CLOSE');   // guard survived exit
    fake!.emit('close', 0, null);                               // close finalizes after the drain
    view2.poll();
    const after = view2.renderFrame(false);
    expect(after).toContain('TAIL-BETWEEN-EXIT-AND-CLOSE');
    expect(after).toContain('exit=0');
  });

  it('resize re-renders with the new geometry (size seam is live, not frozen)', async () => {
    const r = root(); const store = new RunStore(r);
    await put(store, { task_id: 't6', headless: ownership('executor', 't6') });
    let size = { columns: 60, rows: 10 };
    const dummies: ChildProcess[] = [];
    const view = new LiveView({
      layoutText: JSON.stringify({ schema: 1, rows: 1, columns: 1, seats: [{ id: 's', row: 0, column: 0, selector: { task_id: 't6', role: 'executor' } }] }),
      store, terminal: { ...size, isTTY: true }, size: () => ({ ...size }),
      signal: new AbortController().signal, frameMs: 1000, pollMs: 30,
      spawnAttach: () => { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] }); dummies.push(child); return child; },
      stdout: capture().stream,
    });
    view.poll();
    const before = view.renderFrame(false).split('\n');
    expect(before.every(l => l.length <= 60)).toBe(true);
    size = { columns: 100, rows: 14 };
    const after = view.renderFrame(false).split('\n');
    expect(after).toHaveLength(14);
    expect(after.every(l => l.length <= 100)).toBe(true);
    for (const child of dummies) child.kill('SIGKILL');
  });

  it('invalid layout refuses before any subprocess; conflict/waiting states render', async () => {
    const r = root(); const store = new RunStore(r);
    await put(store, { task_id: 't5', headless: ownership('executor', 't5') });
    await put(store, { task_id: 't5', headless: ownership('executor', 't5') });
    expect(() => new LiveView({
      layoutText: '{ bad', store, terminal: { columns: 60, rows: 10, isTTY: true }, signal: new AbortController().signal,
      spawnAttach: () => { throw new Error('must not spawn'); }, stdout: capture().stream,
    })).toThrow(/invalid layout/);
    const view = new LiveView({
      layoutText: JSON.stringify({ schema: 1, rows: 1, columns: 1, seats: [{ id: 's', row: 0, column: 0, selector: { task_id: 't5', role: 'executor' } }] }),
      store, terminal: { columns: 60, rows: 10, isTTY: true }, signal: new AbortController().signal,
      spawnAttach: () => { throw new Error('must not spawn on conflict'); }, stdout: capture().stream,
    });
    view.poll();
    expect(view.renderFrame(false)).toContain('conflict');
  });
});

void mkdirSync; void writeFileSync;

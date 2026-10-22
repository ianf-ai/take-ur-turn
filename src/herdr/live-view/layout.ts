/**
 * live-view layout: a declarative, strictly validated JSON
 * grid. Every seat resolves to at most one run inside the SAME RunStore root;
 * a task+role selector matches EXPLICIT headless ownership only (a plain run
 * merely associated with a task_id never implies a role).
 *
 * Selection semantics per poll:
 *  - {run_id}: fixed; the seat never follows another run.
 *  - {task_id, role}: incomplete runs of that ownership → one shows, more
 *    than one is a CONFLICT (never a silent pick); all complete → the most
 *    recent started_at (run_id as tiebreak); none → waiting.
 */
import { RunStore, complete, type RunMeta } from '../../core/run/store.js';

export interface TaskRoleSelector { task_id: string; role: string }
export interface RunIdSelector { run_id: string }
export type SeatSelector = TaskRoleSelector | RunIdSelector;

export interface SeatSpec {
  id: string;
  row: number;
  column: number;
  label?: string;
  selector: SeatSelector;
}

export interface LayoutSpec {
  schema: 1;
  rows: number;
  columns: number;
  seats: SeatSpec[];
}

export type SeatResolution =
  | { kind: 'run'; run_id: string }
  | { kind: 'waiting' }
  | { kind: 'conflict'; runs: string[] }
  | { kind: 'unknown-run'; run_id: string }
  | { kind: 'unreadable'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict v1 validation. Every rule violation is a precise error; nothing is
 *  coerced, defaulted, or silently dropped — invalid input fails BEFORE any
 *  subprocess exists. */
export function parseLayout(value: unknown): LayoutSpec | { error: string } {
  if (!isRecord(value)) return { error: 'layout must be a JSON object' };
  if (value.schema !== 1) return { error: 'layout.schema must be 1' };
  const rowsUnknown = value.rows;
  const columnsUnknown = value.columns;
  if (typeof rowsUnknown !== 'number' || !Number.isSafeInteger(rowsUnknown) || rowsUnknown < 1 || rowsUnknown > 16) return { error: 'layout.rows must be an integer in 1..16' };
  if (typeof columnsUnknown !== 'number' || !Number.isSafeInteger(columnsUnknown) || columnsUnknown < 1 || columnsUnknown > 16) return { error: 'layout.columns must be an integer in 1..16' };
  const rows = rowsUnknown;
  const columns = columnsUnknown;
  if (!Array.isArray(value.seats)) return { error: 'layout.seats must be an array' };
  if (value.seats.length === 0) return { error: 'layout.seats must not be empty' };
  if (value.seats.length > rows * columns) return { error: `layout has ${rows}x${columns}=${rows * columns} cells but ${value.seats.length} seats` };
  const seats: SeatSpec[] = [];
  const seenIds = new Set<string>();
  const seenPositions = new Set<string>();
  for (const raw of value.seats) {
    if (!isRecord(raw)) return { error: 'each seat must be an object' };
    const id = raw.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64 || /[\u0000-\u001f\u007f]/u.test(id)) return { error: 'seat.id must be 1..64 chars without control characters' };
    if (seenIds.has(id)) return { error: `duplicate seat id: ${id}` };
    seenIds.add(id);
    const rowUnknown = raw.row;
    const columnUnknown = raw.column;
    if (typeof rowUnknown !== 'number' || !Number.isSafeInteger(rowUnknown) || rowUnknown < 0 || rowUnknown >= rows) return { error: `seat ${id}: row must be an integer in 0..${rows - 1}` };
    if (typeof columnUnknown !== 'number' || !Number.isSafeInteger(columnUnknown) || columnUnknown < 0 || columnUnknown >= columns) return { error: `seat ${id}: column must be an integer in 0..${columns - 1}` };
    const row = rowUnknown;
    const column = columnUnknown;
    const position = `${row}:${column}`;
    if (seenPositions.has(position)) return { error: `seat ${id}: cell (${row},${column}) is already occupied` };
    seenPositions.add(position);
    let label: string | undefined;
    if (raw.label !== undefined) {
      if (typeof raw.label !== 'string' || raw.label.length === 0 || raw.label.length > 64 || /[\u0000-\u001f]/u.test(raw.label)) return { error: `seat ${id}: label must be 1..64 chars without control characters` };
      label = raw.label;
    }
    const selector = raw.selector;
    if (!isRecord(selector)) return { error: `seat ${id}: selector must be an object` };
    const keys = Object.keys(selector).sort().join(',');
    let parsed: SeatSelector;
    if (keys === 'role,task_id') {
      const task_id = (selector as Record<string, unknown>).task_id;
      const role = (selector as Record<string, unknown>).role;
      if (typeof task_id !== 'string' || task_id.length === 0 || /[\u0000\u000a\u000d]/u.test(task_id)) return { error: `seat ${id}: selector.task_id must be a non-empty task id` };
      if (typeof role !== 'string' || !['architect', 'executor', 'reviewer'].includes(role)) return { error: `seat ${id}: selector.role must be architect|executor|reviewer` };
      parsed = { task_id, role };
    } else if (keys === 'run_id') {
      const run_id = (selector as Record<string, unknown>).run_id;
      if (typeof run_id !== 'string' || !/^\d{8}T\d{9}Z-[a-f0-9]{8}$/u.test(run_id)) return { error: `seat ${id}: selector.run_id must be a run id` };
      parsed = { run_id };
    } else {
      return { error: `seat ${id}: selector must be exactly {task_id,role} or {run_id}` };
    }
    seats.push({ id, row, column, ...(label !== undefined ? { label } : {}), selector: parsed });
  }
  return { schema: 1, rows, columns, seats };
}

export function parseLayoutText(text: string): LayoutSpec | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { error: `layout is not valid JSON: ${(e as Error).message}` };
  }
  return parseLayout(value);
}

/** One poll's resolution of a seat selector against the shared RunStore. */
export function resolveSeat(store: RunStore, selector: SeatSelector, runIds?: readonly string[]): SeatResolution {
  if ('run_id' in selector) {
    try {
      store.read(selector.run_id);
      return { kind: 'run', run_id: selector.run_id };
    } catch {
      return { kind: 'unknown-run', run_id: selector.run_id };
    }
  }
  const matches: { meta: RunMeta; id: string }[] = [];
  const unreadable: { id: string; error: string }[] = [];
  for (const id of runIds ?? store.list()) {
    try {
      const meta = store.read(id);
      if (meta.task_id === selector.task_id && meta.headless?.role === selector.role) matches.push({ meta, id });
    } catch (e) {
      // An unreadable run of ANY task cannot be role-matched, but a wholly
      // unreadable store surfaces as an honest error instead of "waiting".
      unreadable.push({ id, error: (e as Error).message });
    }
  }
  const incomplete = matches.filter(m => !complete(m.meta));
  if (incomplete.length === 1) return { kind: 'run', run_id: incomplete[0]!.id };
  if (incomplete.length > 1) return { kind: 'conflict', runs: incomplete.map(m => m.id) };
  if (matches.length > 0) {
    const latest = matches.sort((a, b) => b.meta.started_at.localeCompare(a.meta.started_at) || b.id.localeCompare(a.id))[0]!;
    return { kind: 'run', run_id: latest.id };
  }
  if (unreadable.length > 0 && (runIds ?? store.list()).every(id => unreadable.some(u => u.id === id))) {
    return { kind: 'unreadable', error: `${unreadable[0]!.id}: ${unreadable[0]!.error}` };
  }
  return { kind: 'waiting' };
}

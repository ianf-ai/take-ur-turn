/**
 * live-view rendering primitives: seat output is sanitized at
 * the VIEW layer — control/escape sequences from agent logs can never reach
 * the terminal as commands — and buffers are bounded. Raw run logs are never
 * modified.
 *
 * Width model: code-point iteration with an East-Asian-width approximation
 * (CJK/fullwidth count 2 columns) — good enough to keep box borders aligned
 * for the Unicode content real agents emit; combining marks count 0.
 */

import { StringDecoder } from 'node:string_decoder';

const CSI_RE = /\x1b\[[0-9;?<=>! ]*[ -/]*[@-~]/gu;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;
const ESCAPE_RE = /\x1b[@-Z\\-_]/gu;
const CONTROL_RE = /[\u0000-\u0008\u0009\u000b\u000e-\u001f\u007f]/gu;

/** Neutralize terminal-control intent: CSI/OSC/other escapes are removed, the
 *  remaining ASCII control characters (tab included) become visible placeholders (\r and
 *  \n are handled by the line splitter before this runs). */
export function sanitizeLine(line: string): string {
  let out = line.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESCAPE_RE, '');
  out = out.replace(CONTROL_RE, match => (match === '\t' ? '    ' : `\u00b7`));
  return out;
}

/** Approximate terminal column width of one code-point run. */
function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0; // combining marks
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return 2; // Hangul Jamo
  if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return 2; // CJK radicals..Yi
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2; // Hangul syllables
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2; // CJK compat ideographs
  if (codePoint >= 0xfe30 && codePoint <= 0xfe6f) return 2; // CJK compat forms
  if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2; // fullwidth forms
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
  if (codePoint >= 0x20000 && codePoint <= 0x3fffd) return 2; // CJK ext
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0)!);
  return width;
}

/** Fit one line into `width` display columns, ellipsizing overflow. */
export function fitToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  const ellipsis = '\u2026';
  const budget = width - 1; // reserve one column for the ellipsis
  let used = 0;
  let out = '';
  for (const char of text) {
    const w = charWidth(char.codePointAt(0)!);
    if (used + w > budget) break;
    out += char;
    used += w;
  }
  return out + ellipsis;
}

/** Pad (or truncate) to an exact display width so box borders align. */
export function padToWidth(text: string, width: number): string {
  const current = displayWidth(text);
  if (current > width) return fitToWidth(text, width);
  return text + ' '.repeat(width - current);
}

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 4096;
const MAX_PENDING_CHARS = 64 * 1024;

/** Bounded, UTF-8-safe per-seat output buffer. StringDecoder carries split
 *  multi-byte characters across chunks; a trailing \n does not create an
 *  extra empty line; \r counts as a line break (agents emit both). */
export class SeatBuffer {
  private readonly lines: string[] = [];
  private pending = '';
  private decoder: StringDecoder = new StringDecoder('utf8');

  push(chunk: Buffer): void {
    let text = this.pending + this.decoder.write(chunk);
    const lastBreak = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    if (lastBreak === -1) {
      this.pending = text.length > MAX_PENDING_CHARS ? text.slice(-MAX_PENDING_CHARS) : text;
      return;
    }
    const completePart = text.slice(0, lastBreak);
    this.pending = text.slice(lastBreak + 1);
    text = completePart;
    const rawLines = text.split(/[\n\r]/u);
    for (const raw of rawLines) {
      const sanitized = sanitizeLine(raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw);
      this.lines.push(sanitized);
    }
    while (this.lines.length > MAX_LINES) this.lines.shift();
  }

  /** Sanitized lines including the pending partial line (the live cursor). */
  view(): string[] {
    const pending = this.pending.length > 0 ? [sanitizeLine(this.pending.length > MAX_LINE_CHARS ? this.pending.slice(0, MAX_LINE_CHARS) : this.pending)] : [];
    return [...this.lines.slice(-MAX_LINES), ...pending];
  }

  clear(): void {
    this.lines.length = 0;
    this.pending = '';
    // A fresh decoder isolates the new seat from any half-emitted multi-byte
    // sequence still buffered inside the old stream's decoder.
    this.decoder = new StringDecoder('utf8');
  }
}

export interface SeatRenderState {
  id: string;
  label?: string;
  /** Current resolution snapshot for the header. */
  header: string;
  lines: string[];
}

export interface GridGeometry {
  rows: number;
  columns: number;
  cellWidth: number;
  cellHeight: number;
}

export function gridGeometry(layout: { rows: number; columns: number }, terminal: { columns: number; rows: number }): GridGeometry | { error: string } {
  const cellWidth = Math.floor(terminal.columns / layout.columns);
  const cellHeight = Math.floor(terminal.rows / layout.rows);
  if (cellWidth < 24) return { error: `terminal too narrow: ${layout.columns} column(s) need >= ${24 * layout.columns} columns (have ${terminal.columns})` };
  if (cellHeight < 5) return { error: `terminal too short: ${layout.rows} row(s) need >= ${5 * layout.rows} rows (have ${terminal.rows})` };
  return { rows: layout.rows, columns: layout.columns, cellWidth, cellHeight };
}

const BOX_TOP_LEFT = '\u250c', BOX_TOP_RIGHT = '\u2510', BOX_BOTTOM_LEFT = '\u2514', BOX_BOTTOM_RIGHT = '\u2518';
const BOX_HORIZONTAL = '\u2500', BOX_VERTICAL = '\u2502';

/** Render one seat box as exactly cellHeight lines of cellWidth columns. */
export function renderSeat(seat: SeatRenderState, geometry: GridGeometry): string[] {
  const inner = geometry.cellWidth - 2;
  // Header line: `┌─ [label] header ─…─┐` fitted to the exact width — corners +
  // leading dash + trailing space + at least one closing dash.
  const headerText = fitToWidth(` ${seat.label !== undefined ? `[${seat.label}] ` : ''}${seat.header}`, Math.max(1, inner - 3));
  const dashes = Math.max(1, inner - 2 - displayWidth(headerText));
  const lines: string[] = [BOX_TOP_LEFT + BOX_HORIZONTAL + headerText + ' ' + BOX_HORIZONTAL.repeat(dashes) + BOX_TOP_RIGHT];
  const bodyHeight = geometry.cellHeight - 2;
  const visible = seat.lines.slice(-Math.max(0, bodyHeight));
  const blanks = bodyHeight - visible.length;
  for (let i = 0; i < Math.max(0, bodyHeight); i++) {
    const content = i < blanks ? '' : visible[i - blanks] ?? '';
    lines.push(BOX_VERTICAL + padToWidth(content, inner) + BOX_VERTICAL);
  }
  lines.push(BOX_BOTTOM_LEFT + BOX_HORIZONTAL.repeat(inner) + BOX_BOTTOM_RIGHT);
  return lines;
}

/** Compose the full frame: rows of cells; the LAST frame line carries no
 *  trailing newline (the caller controls cursor discipline). Layout
 *  validation guarantees every seat has its own in-bounds cell. */
export function renderFrame(
  cells: ReadonlyMap<string, SeatRenderState>,
  layout: { rows: number; columns: number; seats: ReadonlyArray<{ id: string; row: number; column: number }> },
  geometry: GridGeometry,
): string[] {
  const grid: (string[] | undefined)[][] = Array.from({ length: layout.rows }, () => Array.from({ length: layout.columns }, () => undefined));
  for (const spec of layout.seats) {
    const state = cells.get(spec.id);
    if (state !== undefined) grid[spec.row]![spec.column] ??= renderSeat(state, geometry);
  }
  const frame: string[] = [];
  for (let r = 0; r < layout.rows; r++) {
    const rowCells: string[][] = [];
    for (let c = 0; c < layout.columns; c++) {
      rowCells.push(grid[r]![c] ?? renderSeat({ id: 'empty', header: '(unused cell)', lines: [] }, geometry));
    }
    for (let line = 0; line < geometry.cellHeight; line++) {
      frame.push(rowCells.map(cell => cell[line] ?? '').join(''));
    }
  }
  return frame;
}

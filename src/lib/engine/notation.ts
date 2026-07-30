/**
 * Human-readable move notation and the save-file format.
 *
 * Cells read as column letter + row number with A1 at the top left, matching
 * the usual TwixT convention. Columns run A..Z then AA.. so the 30×30 board
 * still labels cleanly.
 *
 * Save files are JSON holding the move list, not a board snapshot — the board
 * is always recoverable by replaying, and a move list also restores history for
 * undo and the move-list scrubber.
 */

import { colOf, isHoleCell, rowOf } from './board';
import type { GameMove, GameState, LinkOp } from './game';

export const SAVE_VERSION = 1;

export interface SaveFile {
  v: number;
  size: number;
  moves: GameMove[];
}

export function columnLabel(col: number): string {
  let label = '';
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export function columnFromLabel(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) return -1;
    n = n * 26 + v;
  }
  return n - 1;
}

export function cellToNotation(size: number, cell: number): string {
  return `${columnLabel(colOf(size, cell))}${rowOf(size, cell) + 1}`;
}

export function notationToCell(size: number, text: string): number | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(text.trim());
  if (!match) return null;
  const col = columnFromLabel(match[1]!);
  const row = Number(match[2]) - 1;
  if (col < 0 || col >= size || row < 0 || row >= size) return null;
  const cell = row * size + col;
  return isHoleCell(size, cell) ? cell : null;
}

function formatLinkOp(size: number, op: LinkOp): string {
  const sign = op.add ? '+' : '-';
  return `${sign}${cellToNotation(size, op.a)}/${cellToNotation(size, op.b)}`;
}

/** One move as it appears in the sidebar move list. */
export function formatMove(size: number, move: GameMove): string {
  switch (move.t) {
    case 'turn': {
      const head = cellToNotation(size, move.place);
      if (move.linkOps.length === 0) return head;
      return `${head} ${move.linkOps.map((op) => formatLinkOp(size, op)).join(' ')}`;
    }
    case 'swap':
      return 'swap';
    case 'resign':
      return 'resign';
    case 'draw':
      return 'draw';
  }
}

export function serializeGame(state: GameState): string {
  const save: SaveFile = { v: SAVE_VERSION, size: state.size, moves: state.moves };
  return JSON.stringify(save, null, 2);
}

/**
 * Validate an untrusted value as a `GameMove`.
 *
 * Shared by save-file loading and the network protocol: both accept data we did
 * not produce, and neither may hand a malformed move to the engine. Rule
 * legality is a separate question, decided by replaying.
 */
export function parseMove(size: number, value: unknown): GameMove | null {
  if (typeof value !== 'object' || value === null) return null;
  const move = value as Record<string, unknown>;

  switch (move.t) {
    case 'turn': {
      if (!isCell(size, move.place)) return null;
      if (!Array.isArray(move.linkOps)) return null;
      const linkOps: LinkOp[] = [];
      for (const raw of move.linkOps) {
        if (typeof raw !== 'object' || raw === null) return null;
        const op = raw as Record<string, unknown>;
        if (typeof op.add !== 'boolean') return null;
        if (!isCell(size, op.a) || !isCell(size, op.b)) return null;
        linkOps.push({ add: op.add, a: op.a, b: op.b });
      }
      return { t: 'turn', place: move.place as number, linkOps };
    }
    case 'swap':
      return { t: 'swap' };
    case 'draw':
      return { t: 'draw' };
    case 'resign':
      if (move.seat !== 0 && move.seat !== 1) return null;
      return { t: 'resign', seat: move.seat };
    default:
      return null;
  }
}

function isCell(size: number, value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && isHoleCell(size, value);
}

export type ParseResult =
  | { ok: true; size: number; moves: GameMove[] }
  | { ok: false; error: string };

/** Parse a save file. Does not check rule legality — replay decides that. */
export function parseSaveFile(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }

  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'not a save file' };
  }
  const save = data as Record<string, unknown>;

  if (save.v !== SAVE_VERSION) {
    return { ok: false, error: `unsupported save version ${String(save.v)}` };
  }
  if (typeof save.size !== 'number' || !Number.isInteger(save.size)) {
    return { ok: false, error: 'missing board size' };
  }
  if (!Array.isArray(save.moves)) {
    return { ok: false, error: 'missing move list' };
  }

  const moves: GameMove[] = [];
  for (const [i, raw] of save.moves.entries()) {
    const move = parseMove(save.size, raw);
    if (!move) return { ok: false, error: `move ${i + 1} is malformed` };
    moves.push(move);
  }

  return { ok: true, size: save.size, moves };
}

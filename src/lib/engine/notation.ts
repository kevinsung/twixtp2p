/**
 * Human-readable move notation and the transcript format.
 *
 * Cells read as column letter + row number with A1 at the top left, matching
 * the usual TwixT convention. Columns run A..Z then AA.. so the 30×30 board
 * still labels cleanly.
 *
 * A transcript is the board size followed by the same notation the sidebar
 * shows, all whitespace separated — small enough to paste into a chat window,
 * and a move list rather than a board snapshot, so replaying it restores
 * history for undo and the move-list scrubber too.
 */

import { LIGHT, MAX_SIZE, MIN_SIZE, colOf, isHoleCell, otherSeat, rowOf, type Seat } from './board';
import type { GameMove, GameState, LinkOp } from './game';

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

/** The seat letter used in a transcript's `resign:` token. */
function seatLetter(seat: Seat): string {
  return seat === LIGHT ? 'R' : 'B';
}

/**
 * The whole game as pasteable text: `24 E5 F7 +E5/F7 M13 swap`.
 *
 * Resignation carries its seat, because a player may resign on the opponent's
 * turn — parity alone would not say who gave up.
 */
export function serializeTranscript(state: GameState): string {
  const parts = [String(state.size)];
  for (const move of state.moves) {
    parts.push(move.t === 'resign' ? `resign:${seatLetter(move.seat)}` : formatMove(state.size, move));
  }
  return parts.join(' ');
}

/**
 * Validate an untrusted value as a `GameMove`.
 *
 * Shared by the network protocol and peer resync: both accept data we did not
 * produce, and neither may hand a malformed move to the engine. Rule legality
 * is a separate question, decided by replaying.
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

const PLACEMENT = /^[A-Za-z]+\d+$/;
const LINK_OP = /^([+-])([A-Za-z]+\d+)\/([A-Za-z]+\d+)$/;

/**
 * Parse a transcript. Does not check rule legality — replay decides that.
 *
 * The grammar needs no punctuation between moves because the three token
 * shapes cannot be confused: a placement starts with a letter, a link edit with
 * `+` or `-`, and the leading board size with a digit. Link edits attach to the
 * placement in front of them, which is what makes a turn one move rather than
 * several.
 */
export function parseTranscript(text: string): ParseResult {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, error: 'empty transcript' };

  const size = Number(tokens[0]);
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) {
    return { ok: false, error: `"${tokens[0]}" is not a board size between ${MIN_SIZE} and ${MAX_SIZE}` };
  }

  const moves: GameMove[] = [];
  // The seat that would be resigning, for a bare `resign` in a hand-written
  // transcript. Mirrors the engine: a placement and a swap each pass the turn.
  let toMove: Seat = LIGHT;
  /** The turn link edits currently attach to. */
  let open: Extract<GameMove, { t: 'turn' }> | null = null;

  for (const token of tokens.slice(1)) {
    const word = token.toLowerCase();

    if (PLACEMENT.test(token)) {
      const cell = notationToCell(size, token);
      if (cell === null) return { ok: false, error: `"${token}" is not a hole on a ${size}×${size} board` };
      open = { t: 'turn', place: cell, linkOps: [] };
      moves.push(open);
      toMove = otherSeat(toMove);
      continue;
    }

    const link = LINK_OP.exec(token);
    if (link) {
      if (!open) return { ok: false, error: `link edit "${token}" has no placement before it` };
      const a = notationToCell(size, link[2]!);
      const b = notationToCell(size, link[3]!);
      if (a === null || b === null) {
        return { ok: false, error: `"${token}" names a hole that is not on the board` };
      }
      open.linkOps.push({ add: link[1] === '+', a, b });
      continue;
    }

    if (word === 'swap') {
      moves.push({ t: 'swap' });
      toMove = otherSeat(toMove);
      open = null;
      continue;
    }

    if (word === 'draw') {
      moves.push({ t: 'draw' });
      open = null;
      continue;
    }

    if (word === 'resign' || word === 'resign:r' || word === 'resign:b') {
      const seat: Seat = word === 'resign:r' ? 0 : word === 'resign:b' ? 1 : toMove;
      moves.push({ t: 'resign', seat });
      open = null;
      continue;
    }

    return { ok: false, error: `"${token}" is not a move` };
  }

  return { ok: true, size, moves };
}

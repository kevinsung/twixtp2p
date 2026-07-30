import { describe, expect, it } from 'vitest';

import { LIGHT, idx, isHoleCell } from './board';
import { applyMove, createGame, replay, stateHash, type GameState } from './game';
import {
  cellToNotation,
  columnFromLabel,
  columnLabel,
  formatMove,
  notationToCell,
  parseMove,
  parseSaveFile,
  serializeGame,
} from './notation';

const SIZE = 24;

function play(state: GameState, r: number, c: number): GameState {
  const result = applyMove(state, { t: 'turn', place: idx(state.size, r, c), linkOps: [] });
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

describe('column labels', () => {
  it('runs A..Z then AA..', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(23)).toBe('X');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(columnLabel(29)).toBe('AD');
  });

  it('round-trips every column of the largest board', () => {
    for (let col = 0; col < 30; col++) {
      expect(columnFromLabel(columnLabel(col))).toBe(col);
    }
  });
});

describe('cell notation', () => {
  it('puts A1 at the top left', () => {
    expect(cellToNotation(SIZE, idx(SIZE, 0, 1))).toBe('B1');
    expect(cellToNotation(SIZE, idx(SIZE, 13, 11))).toBe('L14');
  });

  it('round-trips every hole on the board', () => {
    for (let cell = 0; cell < SIZE * SIZE; cell++) {
      if (!isHoleCell(SIZE, cell)) continue;
      expect(notationToCell(SIZE, cellToNotation(SIZE, cell))).toBe(cell);
    }
  });

  it('rejects corners and out-of-range references', () => {
    expect(notationToCell(SIZE, 'A1')).toBeNull(); // removed corner
    expect(notationToCell(SIZE, 'Z1')).toBeNull(); // past the right edge
    expect(notationToCell(SIZE, 'B99')).toBeNull();
    expect(notationToCell(SIZE, 'nonsense')).toBeNull();
  });
});

describe('move formatting', () => {
  it('shows the placement alone when no links were edited', () => {
    expect(formatMove(SIZE, { t: 'turn', place: idx(SIZE, 13, 11), linkOps: [] })).toBe('L14');
  });

  it('appends link edits with a sign', () => {
    const text = formatMove(SIZE, {
      t: 'turn',
      place: idx(SIZE, 13, 11),
      linkOps: [
        { add: false, a: idx(SIZE, 12, 9), b: idx(SIZE, 13, 11) },
        { add: true, a: idx(SIZE, 13, 11), b: idx(SIZE, 15, 12) },
      ],
    });
    expect(text).toBe('L14 -J13/L14 +L14/M16');
  });

  it('names the non-placement moves', () => {
    expect(formatMove(SIZE, { t: 'swap' })).toBe('swap');
    expect(formatMove(SIZE, { t: 'resign', seat: LIGHT })).toBe('resign');
  });
});

describe('save files', () => {
  it('round-trips a game to an identical position', () => {
    let state = createGame(SIZE);
    state = play(state, 5, 5);
    const swapped = applyMove(state, { t: 'swap' });
    if (!swapped.ok) throw new Error(swapped.error);
    state = swapped.state;
    state = play(state, 6, 7);
    state = play(state, 7, 5);

    const parsed = parseSaveFile(serializeGame(state));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.size).toBe(SIZE);
    const rebuilt = replay(parsed.size, parsed.moves);
    expect(stateHash(rebuilt)).toBe(stateHash(state));
    expect(rebuilt.swapped).toBe(true);
  });

  it('rejects malformed input rather than throwing', () => {
    expect(parseSaveFile('{').ok).toBe(false);
    expect(parseSaveFile('null').ok).toBe(false);
    expect(parseSaveFile(JSON.stringify({ v: 99, size: 24, moves: [] })).ok).toBe(false);
    expect(parseSaveFile(JSON.stringify({ v: 1, size: 24 })).ok).toBe(false);
    expect(
      parseSaveFile(JSON.stringify({ v: 1, size: 24, moves: [{ t: 'turn', place: 0 }] })).ok,
    ).toBe(false);
  });
});

describe('parseMove', () => {
  it('accepts well-formed moves', () => {
    expect(parseMove(SIZE, { t: 'turn', place: idx(SIZE, 3, 3), linkOps: [] })).toEqual({
      t: 'turn',
      place: idx(SIZE, 3, 3),
      linkOps: [],
    });
    expect(parseMove(SIZE, { t: 'swap' })).toEqual({ t: 'swap' });
    expect(parseMove(SIZE, { t: 'resign', seat: 1 })).toEqual({ t: 'resign', seat: 1 });
  });

  it('rejects anything that is not a valid move shape', () => {
    // Cell references outside the board, or on a removed corner, must not
    // reach the engine — this is the boundary for untrusted peer input.
    expect(parseMove(SIZE, { t: 'turn', place: -1, linkOps: [] })).toBeNull();
    expect(parseMove(SIZE, { t: 'turn', place: 0, linkOps: [] })).toBeNull();
    expect(parseMove(SIZE, { t: 'turn', place: 9999, linkOps: [] })).toBeNull();
    expect(parseMove(SIZE, { t: 'turn', place: 1.5, linkOps: [] })).toBeNull();
    expect(parseMove(SIZE, { t: 'turn', place: idx(SIZE, 3, 3) })).toBeNull();
    expect(
      parseMove(SIZE, {
        t: 'turn',
        place: idx(SIZE, 3, 3),
        linkOps: [{ add: 'yes', a: 1, b: 2 }],
      }),
    ).toBeNull();
    expect(parseMove(SIZE, { t: 'resign', seat: 7 })).toBeNull();
    expect(parseMove(SIZE, { t: 'bogus' })).toBeNull();
    expect(parseMove(SIZE, null)).toBeNull();
    expect(parseMove(SIZE, 'A1')).toBeNull();
  });
});

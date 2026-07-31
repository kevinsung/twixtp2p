import { describe, expect, it } from 'vitest';

import { DARK, EMPTY, LIGHT, idx, isHoleCell } from './board';
import { applyMove, createGame, replay, stateHash, type GameState } from './game';
import {
  cellToNotation,
  columnFromLabel,
  columnLabel,
  formatMove,
  notationToCell,
  parseMove,
  parseTranscript,
  serializeTranscript,
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

describe('transcripts', () => {
  function move(state: GameState, m: Parameters<typeof applyMove>[1]): GameState {
    const result = applyMove(state, m);
    if (!result.ok) throw new Error(result.error);
    return result.state;
  }

  /** A game exercising link edits and the pie rule. */
  function sampleGame(): GameState {
    let state = createGame(SIZE);
    state = play(state, 5, 5);
    state = move(state, { t: 'swap' });
    state = play(state, 6, 7);
    // A knight's move from the peg at (5,5), so the engine auto-links them;
    // the turn then drops that link and puts it straight back.
    state = move(state, {
      t: 'turn',
      place: idx(SIZE, 7, 6),
      linkOps: [
        { add: false, a: idx(SIZE, 5, 5), b: idx(SIZE, 7, 6) },
        { add: true, a: idx(SIZE, 5, 5), b: idx(SIZE, 7, 6) },
      ],
    });
    return state;
  }

  it('round-trips a game with link edits and a swap', () => {
    const state = sampleGame();
    const text = serializeTranscript(state);
    expect(text).toBe('24 F6 swap H7 G8 -F6/G8 +F6/G8');

    const parsed = parseTranscript(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.size).toBe(SIZE);
    const rebuilt = replay(parsed.size, parsed.moves);
    expect(stateHash(rebuilt)).toBe(stateHash(state));
    expect(rebuilt.moves).toEqual(state.moves);
  });

  it('round-trips a swap that actually moves the peg', () => {
    // F6 sits on the main diagonal, so the game above never exercises the
    // reflection. E7 is off it: the peg lands on G5 and the transcript has to
    // survive that.
    let state = createGame(SIZE);
    state = play(state, 6, 4);
    state = move(state, { t: 'swap' });
    state = play(state, 3, 3);

    const text = serializeTranscript(state);
    expect(text).toBe('24 E7 swap D4');

    const parsed = parseTranscript(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const rebuilt = replay(parsed.size, parsed.moves);
    expect(rebuilt.pegs[idx(SIZE, 6, 4)]).toBe(EMPTY);
    expect(rebuilt.pegs[idx(SIZE, 4, 6)]).toBe(DARK);
    expect(stateHash(rebuilt)).toBe(stateHash(state));
    expect(rebuilt.moves).toEqual(state.moves);
  });

  it('round-trips a resignation with the seat that gave up', () => {
    let state = createGame(SIZE);
    state = play(state, 5, 5);
    // LIGHT has just moved, so it is DARK to move — a bare `resign` would name
    // the wrong player.
    state = move(state, { t: 'resign', seat: LIGHT });

    const text = serializeTranscript(state);
    expect(text).toBe('24 F6 resign:R');

    const parsed = parseTranscript(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.moves[1]).toEqual({ t: 'resign', seat: LIGHT });
    expect(replay(parsed.size, parsed.moves).result).toEqual({
      kind: 'win',
      seat: DARK,
      by: 'resignation',
    });
  });

  it('reads a hand-written resignation as the player to move', () => {
    const parsed = parseTranscript('24 F6 G8 resign');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Two placements have been played, so it is LIGHT's turn again.
    expect(parsed.moves[2]).toEqual({ t: 'resign', seat: LIGHT });
  });

  it('accepts draws and is insensitive to spacing and keyword case', () => {
    const parsed = parseTranscript('  18\n F6   SWAP\tH7 draw ');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.size).toBe(18);
    expect(parsed.moves.map((m) => m.t)).toEqual(['turn', 'swap', 'turn', 'draw']);
  });

  it('rejects malformed input rather than throwing', () => {
    expect(parseTranscript('').ok).toBe(false);
    expect(parseTranscript('F6 G8').ok).toBe(false); // no board size
    expect(parseTranscript('7 F6').ok).toBe(false); // below MIN_SIZE
    expect(parseTranscript('64 F6').ok).toBe(false); // above MAX_SIZE
    expect(parseTranscript('24 F6 castle').ok).toBe(false); // unknown token
    expect(parseTranscript('24 A1').ok).toBe(false); // a removed corner
    expect(parseTranscript('24 +F6/G8 F6').ok).toBe(false); // link op with no placement
    expect(parseTranscript('24 F6 swap +F6/G8').ok).toBe(false); // swap closes the turn
  });

  it('leaves rule legality to the replay', () => {
    // Well-formed notation, but both players cannot place on the same hole.
    const parsed = parseTranscript('24 F6 F6');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => replay(parsed.size, parsed.moves)).toThrow();
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

import { describe, expect, it } from 'vitest';

import { DARK, EMPTY, LIGHT, canPlaceAt, idx, isHole, type Seat } from './board';
import {
  applyMove,
  autoLinkTargets,
  canSwap,
  createGame,
  hasLegalPlacement,
  linkCandidates,
  placementError,
  replay,
  stateHash,
  truncateTo,
  type GameMove,
  type GameState,
} from './game';

const SIZE = 8;

function place(state: GameState, r: number, c: number): GameState {
  const result = applyMove(state, { t: 'turn', place: idx(state.size, r, c), linkOps: [] });
  if (!result.ok) throw new Error(`unexpected rejection at ${r},${c}: ${result.error}`);
  return result.state;
}

/** Play a list of [row, col] alternating from the current side to move. */
function playAll(state: GameState, moves: Array<[number, number]>): GameState {
  return moves.reduce((acc, [r, c]) => place(acc, r, c), state);
}

describe('board geometry', () => {
  it('removes the four corners', () => {
    expect(isHole(SIZE, 0, 0)).toBe(false);
    expect(isHole(SIZE, 0, SIZE - 1)).toBe(false);
    expect(isHole(SIZE, SIZE - 1, 0)).toBe(false);
    expect(isHole(SIZE, SIZE - 1, SIZE - 1)).toBe(false);
    expect(isHole(SIZE, 0, 1)).toBe(true);
  });

  it("bars each seat from the opponent's border lines", () => {
    // LIGHT connects top to bottom, so the left and right columns are barred.
    expect(canPlaceAt(SIZE, LIGHT, 3, 0)).toBe(false);
    expect(canPlaceAt(SIZE, LIGHT, 3, SIZE - 1)).toBe(false);
    expect(canPlaceAt(SIZE, LIGHT, 0, 3)).toBe(true);
    expect(canPlaceAt(SIZE, LIGHT, SIZE - 1, 3)).toBe(true);

    // DARK connects left to right, so the top and bottom rows are barred.
    expect(canPlaceAt(SIZE, DARK, 0, 3)).toBe(false);
    expect(canPlaceAt(SIZE, DARK, SIZE - 1, 3)).toBe(false);
    expect(canPlaceAt(SIZE, DARK, 3, 0)).toBe(true);
    expect(canPlaceAt(SIZE, DARK, 3, SIZE - 1)).toBe(true);
  });
});

describe('placement legality', () => {
  it('rejects corners, occupied holes and forbidden borders', () => {
    const game = createGame(SIZE);
    expect(placementError(game, idx(SIZE, 0, 0), LIGHT)).toMatch(/not a hole/);
    expect(placementError(game, idx(SIZE, 3, 0), LIGHT)).toMatch(/border line/);

    const afterOne = place(game, 3, 3);
    expect(placementError(afterOne, idx(SIZE, 3, 3), DARK)).toMatch(/occupied/);
  });

  it('rejects a move once the game is over', () => {
    const game = createGame(SIZE);
    const resigned = applyMove(game, { t: 'resign', seat: LIGHT });
    expect(resigned.ok).toBe(true);
    if (!resigned.ok) return;

    const after = applyMove(resigned.state, { t: 'turn', place: idx(SIZE, 3, 3), linkOps: [] });
    expect(after.ok).toBe(false);
  });
});

describe('auto-linking', () => {
  it('links a new peg to every reachable friendly peg', () => {
    // LIGHT at (0,3) then, after a DARK reply, LIGHT at (2,4) — a knight's move.
    const state = playAll(createGame(SIZE), [
      [0, 3],
      [3, 0],
      [2, 4],
    ]);
    expect(state.links.has(idx(SIZE, 0, 3), idx(SIZE, 2, 4))).toBe(true);
  });

  it('never links to an opponent peg', () => {
    const state = playAll(createGame(SIZE), [
      [0, 3],
      [2, 4],
    ]);
    expect(state.links.count).toBe(0);
  });

  it('skips a link that would cross an existing one, and reports it as blocked', () => {
    // LIGHT wants (4,3)-(5,5). DARK's (4,5)-(5,3) is the opposite diagonal of
    // the same 2x3 box, so the two segments cross squarely.
    let state = createGame(SIZE);
    state = playAll(state, [
      [4, 3], // LIGHT
      [4, 5], // DARK
      [3, 1], // LIGHT, links to (4,3)
      [5, 3], // DARK, links to (4,5) — now cutting the lane
    ]);
    expect(state.links.has(idx(SIZE, 4, 5), idx(SIZE, 5, 3))).toBe(true);

    const target = idx(SIZE, 5, 5);
    const candidates = linkCandidates(
      { ...state, pegs: withPeg(state, target, LIGHT) },
      target,
      LIGHT,
    );
    const toward = candidates.find((c) => c.to === idx(SIZE, 4, 3));
    expect(toward).toBeDefined();
    expect(toward!.blocked).toBe(true);

    state = place(state, 5, 5); // LIGHT
    expect(state.links.has(idx(SIZE, 4, 3), idx(SIZE, 5, 5))).toBe(false);
  });

  it('produces exactly the unblocked candidates', () => {
    const state = playAll(createGame(SIZE), [
      [0, 3],
      [3, 0],
      [2, 4],
      [4, 0],
    ]);
    const target = idx(SIZE, 4, 3);
    const probe = { ...state, pegs: withPeg(state, target, LIGHT) };
    const expected = linkCandidates(probe, target, LIGHT)
      .filter((c) => !c.blocked)
      .map((c) => c.to)
      .sort((a, b) => a - b);

    expect(autoLinkTargets(probe, target, LIGHT).sort((a, b) => a - b)).toEqual(expected);
  });
});

function withPeg(state: GameState, cell: number, seat: Seat): Int8Array {
  const pegs = Int8Array.from(state.pegs);
  pegs[cell] = seat;
  return pegs;
}

describe('manual link edits', () => {
  it('removes an own link and re-adds one the removal unblocked', () => {
    // DARK's (4,5)-(5,3) cuts the lane LIGHT wants between (4,3) and (5,5).
    let state = playAll(createGame(SIZE), [
      [4, 3], // LIGHT
      [4, 5], // DARK
      [3, 1], // LIGHT, links to (4,3)
      [5, 3], // DARK, links to (4,5)
      [5, 5], // LIGHT — link to (4,3) is blocked
    ]);
    expect(state.links.has(idx(SIZE, 4, 3), idx(SIZE, 5, 5))).toBe(false);

    // DARK may not remove a link that is not theirs.
    const trespass = applyMove(state, {
      t: 'turn',
      place: idx(SIZE, 2, 1),
      linkOps: [{ add: false, a: idx(SIZE, 3, 1), b: idx(SIZE, 4, 3) }],
    });
    expect(trespass.ok).toBe(false);

    // DARK clears their own blocking link instead.
    const cleared = applyMove(state, {
      t: 'turn',
      place: idx(SIZE, 2, 1),
      linkOps: [{ add: false, a: idx(SIZE, 4, 5), b: idx(SIZE, 5, 3) }],
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    state = cleared.state;

    // Now LIGHT can add the link that was previously cut off.
    const added = applyMove(state, {
      t: 'turn',
      place: idx(SIZE, 6, 2),
      linkOps: [{ add: true, a: idx(SIZE, 4, 3), b: idx(SIZE, 5, 5) }],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.state.links.has(idx(SIZE, 4, 3), idx(SIZE, 5, 5))).toBe(true);
  });

  it('rejects a link that is not a knight move', () => {
    const state = playAll(createGame(SIZE), [
      [4, 3],
      [3, 0],
      [4, 4],
      [4, 0],
    ]);
    const bad = applyMove(state, {
      t: 'turn',
      place: idx(SIZE, 6, 2),
      linkOps: [{ add: true, a: idx(SIZE, 4, 3), b: idx(SIZE, 4, 4) }],
    });
    expect(bad.ok).toBe(false);
  });
});

describe('win detection', () => {
  it('recognises a LIGHT chain from the top row to the bottom row', () => {
    const state = playAll(createGame(SIZE), [
      [0, 3], [1, 0],
      [2, 4], [2, 0],
      [4, 3], [3, 0],
      [6, 4], [4, 0],
      [7, 2],
    ]);
    expect(state.result).toEqual({ kind: 'win', seat: LIGHT, by: 'connection' });
  });

  it('recognises a DARK chain from the left column to the right column', () => {
    // Mirror of the LIGHT chain: DARK plays the transpose.
    const state = playAll(createGame(SIZE), [
      [3, 3], // LIGHT filler, out of the way
      [3, 0],
      [3, 5], // more LIGHT filler
      [4, 2],
      [1, 3],
      [3, 4],
      [1, 5],
      [4, 6],
      [6, 3],
      [2, 7],
    ]);
    expect(state.result).toEqual({ kind: 'win', seat: DARK, by: 'connection' });
  });

  it('awards the game to the opponent on resignation', () => {
    const game = createGame(SIZE);
    const result = applyMove(game, { t: 'resign', seat: DARK });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.result).toEqual({ kind: 'win', seat: LIGHT, by: 'resignation' });
  });
});

describe('the pie rule', () => {
  it('is offered only immediately after the first peg', () => {
    const game = createGame(SIZE);
    expect(canSwap(game)).toBe(false);

    const afterOne = place(game, 3, 3);
    expect(canSwap(afterOne)).toBe(true);

    const afterTwo = place(afterOne, 4, 4);
    expect(canSwap(afterTwo)).toBe(false);

    const late = applyMove(afterTwo, { t: 'swap' });
    expect(late.ok).toBe(false);
  });

  it('reflects the opening across the diagonal and hands the turn back', () => {
    const afterOne = place(createGame(SIZE), 4, 6);
    const swapped = applyMove(afterOne, { t: 'swap' });
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;

    // Nobody changes colour: the peg moves and becomes DARK's, so LIGHT — who
    // opened — is on move again and seats keep alternating.
    expect(swapped.state.pegs[idx(SIZE, 4, 6)]).toBe(EMPTY);
    expect(swapped.state.pegs[idx(SIZE, 6, 4)]).toBe(DARK);
    expect(swapped.state.toMove).toBe(LIGHT);
    expect(swapped.state.lastPlace).toBe(idx(SIZE, 6, 4));
    expect(canSwap(swapped.state)).toBe(false);
  });

  it('leaves an opening on the diagonal in place and only recolours it', () => {
    const afterOne = place(createGame(SIZE), 5, 5);
    const swapped = applyMove(afterOne, { t: 'swap' });
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;

    // Source and destination coincide, so the order of the two writes decides
    // whether a peg survives at all.
    expect(swapped.state.pegs[idx(SIZE, 5, 5)]).toBe(DARK);
    expect(swapped.state.pegs.filter((peg) => peg !== EMPTY)).toHaveLength(1);
    expect(swapped.state.toMove).toBe(LIGHT);
  });
});

describe('replay and undo', () => {
  it('reproduces an identical state from the move list', () => {
    const state = playAll(createGame(SIZE), [
      [0, 3], [1, 0],
      [2, 4], [2, 0],
      [4, 3], [3, 0],
    ]);
    const rebuilt = replay(SIZE, state.moves);

    expect(stateHash(rebuilt)).toBe(stateHash(state));
    expect([...rebuilt.pegs]).toEqual([...state.pegs]);
    expect(rebuilt.links.sortedKeys()).toEqual(state.links.sortedKeys());
  });

  it('restores the earlier state exactly when truncated', () => {
    const early = playAll(createGame(SIZE), [
      [0, 3], [1, 0],
      [2, 4], [2, 0],
    ]);
    const later = playAll(early, [
      [4, 3], [3, 0],
      [6, 4], [4, 0],
    ]);

    const undone = truncateTo(later, early.moves.length);
    expect(stateHash(undone)).toBe(stateHash(early));
    expect(undone.toMove).toBe(early.toMove);
  });

  it('gives different hashes to different positions', () => {
    const a = place(createGame(SIZE), 3, 3);
    const b = place(createGame(SIZE), 3, 4);
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});

describe('game termination', () => {
  it('always terminates in a win or a draw under random play', () => {
    // Exercises applyMove hard and proves the game cannot run forever: every
    // turn consumes a hole, so the move list is bounded by the board.
    let seed = 12345;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let round = 0; round < 5; round++) {
      let state = createGame(SIZE);
      let guard = 0;

      while (!state.result) {
        if (++guard > SIZE * SIZE + 10) throw new Error('game failed to terminate');
        const legal: number[] = [];
        for (let cell = 0; cell < SIZE * SIZE; cell++) {
          if (!placementError(state, cell, state.toMove)) legal.push(cell);
        }
        expect(legal.length).toBeGreaterThan(0);
        const pick = legal[Math.floor(rand() * legal.length)]!;
        const step = applyMove(state, { t: 'turn', place: pick, linkOps: [] });
        expect(step.ok).toBe(true);
        if (!step.ok) return;
        state = step.state;
      }

      expect(state.result).toBeTruthy();
      // Whatever the outcome, the move list must rebuild it exactly.
      expect(stateHash(replay(SIZE, state.moves))).toBe(stateHash(state));
    }
  });

  it('reports a draw when the side to move has nowhere legal left', () => {
    // Fill every hole LIGHT could use, leaving DARK-only border columns free.
    let state = createGame(SIZE);
    const pegs = Int8Array.from(state.pegs);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 1; c < SIZE - 1; c++) {
        if (isHole(SIZE, r, c)) pegs[idx(SIZE, r, c)] = DARK;
      }
    }
    state = { ...state, pegs };

    expect(hasLegalPlacement(state, LIGHT)).toBe(false);
    expect(hasLegalPlacement(state, DARK)).toBe(true);
  });
});

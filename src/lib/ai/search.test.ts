import { describe, expect, it } from 'vitest';

import { DARK, EMPTY, LIGHT, type Seat, canPlaceCell, idx, otherSeat } from '../engine/board';
import { applyMove, createGame, type GameState } from '../engine/game';
import { EvalScratch, connectionCost } from './eval';
import { geometryFor } from './geometry';
import { SearchPosition } from './position';
import { MATE, search } from './search';

const SIZE = 8;

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function place(state: GameState, r: number, c: number): GameState {
  const step = applyMove(state, { t: 'turn', place: r * state.size + c, linkOps: [] });
  if (!step.ok) throw new Error(step.error);
  return step.state;
}

/**
 * Red one peg from home.
 *
 * Two linked pairs — (0,3)-(2,4) hanging off the top row and (6,6)-(7,4)
 * resting on the bottom — with exactly one cell, (4,5), a knight's move from
 * both. Black's pegs sit in its own left column where they form no links at
 * all, so nothing is blocked and nothing is accidentally threatened.
 */
function nearWin(blackReplies: number): GameState {
  let state = createGame(SIZE);
  const red: Array<[number, number]> = [[0, 3], [2, 4], [6, 6], [7, 4]];
  const black: Array<[number, number]> = [[1, 0], [2, 0], [3, 0], [4, 0]];

  for (let i = 0; i < red.length; i++) {
    state = place(state, red[i]![0], red[i]![1]);
    if (i < blackReplies) state = place(state, black[i]![0], black[i]![1]);
  }
  return state;
}

const WINNING_CELL = idx(SIZE, 4, 5);

describe('tactics', () => {
  it('plays the placement that connects', () => {
    const state = nearWin(4);
    expect(state.toMove).toBe(LIGHT);

    const result = search(SearchPosition.fromState(state), LIGHT, state.lastPlace ?? -1, {
      budgetMs: 200,
      rng: () => 0,
    });

    expect(result.cell).toBe(WINNING_CELL);
    expect(result.score).toBeGreaterThanOrEqual(MATE - 8);
  });

  it('blocks the opponent from doing the same', () => {
    const state = nearWin(3);
    expect(state.toMove).toBe(DARK);
    expect(connectionCost(SearchPosition.fromState(state), LIGHT, new EvalScratch(geometryFor(SIZE)))).toBe(1);

    const result = search(SearchPosition.fromState(state), DARK, state.lastPlace ?? -1, {
      budgetMs: 300,
      rng: () => 0,
    });

    // Black cannot cross the lane from a standing start, so occupying the hole
    // is the only block there is.
    expect(result.cell).toBe(WINNING_CELL);

    const after = applyMove(state, { t: 'turn', place: result.cell, linkOps: [] });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      connectionCost(SearchPosition.fromState(after.state), LIGHT, new EvalScratch(geometryFor(SIZE))),
    ).toBeGreaterThan(1);
  });
});

describe('the clock', () => {
  it('returns inside a small multiple of its budget', () => {
    const state = createGame(24);
    const started = performance.now();
    const result = search(SearchPosition.fromState(state), LIGHT, -1, { budgetMs: 150 });
    const spent = performance.now() - started;

    expect(result.cell).toBeGreaterThanOrEqual(0);
    expect(result.depth).toBeGreaterThanOrEqual(1);
    expect(spent).toBeLessThan(150 * 4);
  });

  it('still returns a move on an absurdly small budget', () => {
    const state = createGame(24);
    const result = search(SearchPosition.fromState(state), LIGHT, -1, { budgetMs: 0 });
    expect(result.cell).toBeGreaterThanOrEqual(0);
    expect(result.depth).toBe(1);
  });

  it('searches deeper when given longer', () => {
    const state = createGame(12);
    const quick = search(SearchPosition.fromState(state), LIGHT, -1, { budgetMs: 20 });
    const slow = search(SearchPosition.fromState(state), LIGHT, -1, { budgetMs: 600 });
    expect(slow.depth).toBeGreaterThan(quick.depth);
  });
});

describe('every move it returns', () => {
  it('is one the rules engine accepts', () => {
    const rng = seeded(90210);
    const size = 12;

    for (let game = 0; game < 6; game++) {
      let state = createGame(size);
      let seat: Seat = LIGHT;

      for (let ply = 0; ply < 24; ply++) {
        // Alternate between the search and a random legal move, so the search
        // meets positions it would never have steered itself into.
        let cell: number;
        if (ply % 2 === 0) {
          cell = search(SearchPosition.fromState(state), seat, state.lastPlace ?? -1, {
            budgetMs: 15,
            rng,
          }).cell;
          expect(cell).toBeGreaterThanOrEqual(0);
        } else {
          const options: number[] = [];
          for (let c = 0; c < size * size; c++) {
            if (state.pegs[c] !== EMPTY) continue;
            if (canPlaceCell(size, seat, c)) options.push(c);
          }
          if (options.length === 0) break;
          cell = options[Math.floor(rng() * options.length)]!;
        }

        const step = applyMove(state, { t: 'turn', place: cell, linkOps: [] });
        expect(step.ok).toBe(true);
        if (!step.ok) return;
        state = step.state;
        if (state.result) break;
        seat = otherSeat(seat);
      }
    }
  });
});

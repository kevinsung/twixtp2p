import { describe, expect, it } from 'vitest';

import {
  DARK,
  EMPTY,
  LIGHT,
  type Seat,
  canPlaceCell,
  colOf,
  idx,
  rowOf,
} from '../engine/board';
import { applyMove, createGame, type GameMove } from '../engine/game';
import { chooseMove } from './bot';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('what the bot returns', () => {
  it('opens near the middle, and not always in the same place', () => {
    const size = 24;
    const seen = new Set<number>();
    const rng = seeded(11);

    for (let i = 0; i < 20; i++) {
      const move = chooseMove(size, [], LIGHT, { budgetMs: 10, rng });
      expect(move.t).toBe('turn');
      if (move.t !== 'turn') return;
      seen.add(move.place);
      const r = rowOf(size, move.place);
      const c = colOf(size, move.place);
      expect(Math.abs(r - (size - 1) / 2)).toBeLessThanOrEqual(size / 8 + 1);
      expect(Math.abs(c - (size - 1) / 2)).toBeLessThanOrEqual(size / 8 + 1);
    }

    expect(seen.size).toBeGreaterThan(1);
  });

  it('never asks for link edits, and never a move the engine rejects', () => {
    const size = 12;
    const rng = seeded(303);
    let state = createGame(size);
    const moves: GameMove[] = [];

    for (let ply = 0; ply < 12 && !state.result; ply++) {
      const move = chooseMove(size, moves, state.toMove, { budgetMs: 20, rng });
      expect(move.t === 'turn' ? move.linkOps : []).toEqual([]);
      const step = applyMove(state, move);
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      moves.push(move);
    }
  });

  it('refuses to move when it is not its turn', () => {
    const size = 12;
    expect(() => chooseMove(size, [], DARK, { budgetMs: 5 })).toThrow(/not the bot/);
  });
});

/**
 * A strength floor rather than a strength measurement.
 *
 * Random play is a low bar, but it is a bar that every one of the pieces has to
 * be working to clear: a broken cross table, a distance field that stops at the
 * wrong border, an off-by-one in the candidate potential — any of them turns
 * this from twenty wins into a handful.
 */
describe('against a player choosing at random', () => {
  it('wins essentially every game on a 12x12', () => {
    const size = 12;
    const rng = seeded(20260731);
    const games = 20;
    let wins = 0;

    for (let game = 0; game < games; game++) {
      // Alternate seats: Red and Black connect different axes, and a bug in one
      // seat's border tables would otherwise hide behind the other's.
      const botSeat: Seat = game % 2 === 0 ? LIGHT : DARK;
      let state = createGame(size);
      const moves: GameMove[] = [];

      while (!state.result && moves.length < 200) {
        let move: GameMove;
        if (state.toMove === botSeat) {
          move = chooseMove(size, moves, botSeat, { budgetMs: 40, rng });
        } else {
          const options: number[] = [];
          for (let cell = 0; cell < size * size; cell++) {
            if (state.pegs[cell] !== EMPTY) continue;
            if (canPlaceCell(size, state.toMove, cell)) options.push(cell);
          }
          move = { t: 'turn', place: options[Math.floor(rng() * options.length)]!, linkOps: [] };
        }

        const step = applyMove(state, move);
        expect(step.ok).toBe(true);
        if (!step.ok) return;
        state = step.state;
        moves.push(move);
      }

      if (state.result?.kind === 'win' && state.result.seat === botSeat) wins += 1;
    }

    expect(wins).toBeGreaterThanOrEqual(games - 1);
  }, 60_000);
});

describe('the pie rule', () => {
  /**
   * The swap reflects the opening across the diagonal, so "should I take this
   * opening?" and "is this opening any good?" are the same question. A peg in
   * the middle is worth taking; one pinned against the opponent's border line,
   * where its ladder has nowhere to spread, is not.
   */
  it.each([12, 24])('takes a central opening on a %ix board', (size) => {
    const mid = Math.floor(size / 2);
    const moves: GameMove[] = [{ t: 'turn', place: idx(size, mid, mid), linkOps: [] }];
    expect(chooseMove(size, moves, DARK, { budgetMs: 150, rng: () => 0.5 }).t).toBe('swap');
  });

  it.each([12, 24])('declines a cramped edge opening on a %ix board', (size) => {
    const mid = Math.floor(size / 2);
    const moves: GameMove[] = [{ t: 'turn', place: idx(size, mid, 1), linkOps: [] }];
    const reply = chooseMove(size, moves, DARK, { budgetMs: 150, rng: () => 0.5 });
    expect(reply.t).toBe('turn');
  });

  it('produces a swap the engine accepts', () => {
    const size = 12;
    const opening: GameMove = { t: 'turn', place: idx(size, 6, 6), linkOps: [] };
    let state = createGame(size);
    const first = applyMove(state, opening);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;

    const reply = chooseMove(size, [opening], DARK, { budgetMs: 150, rng: () => 0.5 });
    const second = applyMove(state, reply);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Reflected onto the same cell — (6,6) is on the diagonal — and now Black's.
    expect(second.state.pegs[idx(size, 6, 6)]).toBe(DARK);
    expect(second.state.toMove).toBe(LIGHT);
  });
});

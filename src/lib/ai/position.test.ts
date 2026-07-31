/**
 * The load-bearing test.
 *
 * `SearchPosition` is a second implementation of auto-linking and the crossing
 * rule, written for speed rather than clarity. Everything the bot decides is
 * decided on that board, so if it drifts from the engine by one lane the bot is
 * playing a different game from the one on screen — and nothing else would
 * notice. So: play random legal games through the real engine and check the
 * incremental position against the engine's own state after every single move.
 */

import { describe, expect, it } from 'vitest';

import { DARK, EMPTY, LIGHT, type Seat, canPlaceCell, otherSeat } from '../engine/board';
import { applyMove, checkConnection, createGame, type GameState } from '../engine/game';
import { geometryFor } from './geometry';
import { SearchPosition } from './position';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function legalCells(state: GameState, seat: Seat): number[] {
  const out: number[] = [];
  for (let cell = 0; cell < state.size * state.size; cell++) {
    if (state.pegs[cell] !== EMPTY) continue;
    if (canPlaceCell(state.size, seat, cell)) out.push(cell);
  }
  return out;
}

/** Every field of the fast board, against one rebuilt from the engine's state. */
function expectMatches(pos: SearchPosition, state: GameState): void {
  const fresh = SearchPosition.fromState(state);
  expect(Array.from(pos.pegs)).toEqual(Array.from(state.pegs));
  expect(Array.from(pos.pegs)).toEqual(Array.from(fresh.pegs));
  expect(Array.from(pos.linkOwner)).toEqual(Array.from(fresh.linkOwner));
  expect(Array.from(pos.crossCount)).toEqual(Array.from(fresh.crossCount));
  expect(pos.hash).toBe(fresh.hash);
  expect(pos.connected(LIGHT)).toBe(checkConnection(state.size, state.pegs, state.links, LIGHT));
  expect(pos.connected(DARK)).toBe(checkConnection(state.size, state.pegs, state.links, DARK));
}

describe('SearchPosition against the engine', () => {
  it.each([8, 12])('tracks a random game on a %ix board move for move', (size) => {
    const rng = seeded(size * 7919);

    for (let game = 0; game < 4; game++) {
      let state = createGame(size);
      const pos = new SearchPosition(geometryFor(size));
      let seat: Seat = LIGHT;

      for (let ply = 0; ply < 60; ply++) {
        const options = legalCells(state, seat);
        if (options.length === 0) break;
        const cell = options[Math.floor(rng() * options.length)]!;

        const step = applyMove(state, { t: 'turn', place: cell, linkOps: [] });
        expect(step.ok).toBe(true);
        if (!step.ok) return;
        state = step.state;
        pos.place(cell, seat);

        expectMatches(pos, state);
        if (state.result) break;
        seat = otherSeat(seat);
      }
    }
  });

  it('matches the engine when links are auto-created and blocked', () => {
    const size = 12;
    // Two Red pegs a knight's move apart, then a Black pair whose link would
    // cross the lane between them.
    let state = createGame(size);
    const moves: Array<[number, number]> = [
      [4, 4], // Red
      [5, 5], // Black
      [5, 6], // Red: links to (4,4)? no — set up deliberately below
      [3, 6], // Black: (5,5)-(3,6) is a knight move, crossing (4,4)-(5,6)
    ];

    const pos = new SearchPosition(geometryFor(size));
    let seat: Seat = LIGHT;
    for (const [r, c] of moves) {
      const cell = r * size + c;
      const step = applyMove(state, { t: 'turn', place: cell, linkOps: [] });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
      pos.place(cell, seat);
      expectMatches(pos, state);
      seat = otherSeat(seat);
    }

    // Red's link went in first, so Black's crossing link never formed.
    expect(state.links.count).toBe(1);
    expect(pos.linkOwner.filter((owner) => owner === DARK)).toHaveLength(0);
  });

  it('imports links a player edited away rather than re-deriving them', () => {
    const size = 12;
    let state = createGame(size);
    for (const [r, c, ops] of [
      [4, 4, []],
      [8, 8, []],
      [5, 6, [{ add: false, a: 4 * size + 4, b: 5 * size + 6 }]],
    ] as const) {
      const step = applyMove(state, { t: 'turn', place: r * size + c, linkOps: [...ops] });
      expect(step.ok).toBe(true);
      if (!step.ok) return;
      state = step.state;
    }

    expect(state.links.count).toBe(0);
    const pos = SearchPosition.fromState(state);
    expect(Array.from(pos.linkOwner).every((owner) => owner === EMPTY)).toBe(true);
    expect(Array.from(pos.crossCount).every((count) => count === 0)).toBe(true);
  });
});

describe('make and unmake', () => {
  it('restores every array and the hash exactly', () => {
    const size = 12;
    const geo = geometryFor(size);
    const pos = new SearchPosition(geo);
    const rng = seeded(4242);

    // A starting position with some structure to disturb.
    let seat: Seat = LIGHT;
    for (let i = 0; i < 20; i++) {
      let cell = -1;
      while (cell < 0) {
        const guess = Math.floor(rng() * geo.cells);
        if (pos.pegs[guess] === EMPTY && geo.placeable[seat][guess]) cell = guess;
      }
      pos.place(cell, seat);
      seat = otherSeat(seat);
    }

    const pegs = Array.from(pos.pegs);
    const owners = Array.from(pos.linkOwner);
    const crossings = Array.from(pos.crossCount);
    const hash = pos.hash;

    const undos = [];
    for (let i = 0; i < 12; i++) {
      let cell = -1;
      while (cell < 0) {
        const guess = Math.floor(rng() * geo.cells);
        if (pos.pegs[guess] === EMPTY && geo.placeable[seat][guess]) cell = guess;
      }
      undos.push(pos.place(cell, seat));
      seat = otherSeat(seat);
    }
    expect(pos.plies).toBe(32);

    for (let i = undos.length - 1; i >= 0; i--) pos.unplace(undos[i]!);

    expect(pos.plies).toBe(20);
    expect(Array.from(pos.pegs)).toEqual(pegs);
    expect(Array.from(pos.linkOwner)).toEqual(owners);
    expect(Array.from(pos.crossCount)).toEqual(crossings);
    expect(pos.hash).toBe(hash);
  });

  it('refuses to unmake out of order', () => {
    const pos = new SearchPosition(geometryFor(12));
    const first = pos.place(5 * 12 + 5, LIGHT);
    pos.place(6 * 12 + 7, LIGHT);
    expect(() => pos.unplace(first)).toThrow(/most recent/);
  });
});

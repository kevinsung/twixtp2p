import { describe, expect, it } from 'vitest';

import { DARK, EMPTY, LIGHT, type Seat, canPlaceCell, otherSeat } from '../engine/board';
import { applyMove, checkConnection, createGame, type GameState } from '../engine/game';
import { EvalScratch, connectionCost, evaluate, type CostMetric } from './eval';
import { geometryFor } from './geometry';
import { SearchPosition } from './position';

const METRICS: CostMetric[] = ['plain', 'two'];

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scratchFor(size: number): EvalScratch {
  return new EvalScratch(geometryFor(size));
}

function place(state: GameState, r: number, c: number): GameState {
  const step = applyMove(state, { t: 'turn', place: r * state.size + c, linkOps: [] });
  if (!step.ok) throw new Error(step.error);
  return step.state;
}

describe('connection cost on an open board', () => {
  it('counts the pegs a knight ladder needs from one border to the other', () => {
    // On an 8x8, Red must reach row 7 from row 0. A knight climbs two rows a
    // step, so rows 0, 2, 4, 6 and then a one-row step to 7: five pegs.
    const pos = new SearchPosition(geometryFor(8));
    const scratch = scratchFor(8);
    expect(connectionCost(pos, LIGHT, scratch)).toBe(5);
    expect(connectionCost(pos, DARK, scratch)).toBe(5);
  });

  it('scales with the board', () => {
    for (const size of [12, 24]) {
      const pos = new SearchPosition(geometryFor(size));
      const scratch = scratchFor(size);
      const cost = connectionCost(pos, LIGHT, scratch);
      // Two rows per peg, plus the odd step at the end.
      expect(cost).toBe(Math.ceil((size - 1) / 2) + 1);
    }
  });

  it('drops by one for each peg already on a cheapest route', () => {
    const size = 12;
    const scratch = scratchFor(size);
    const empty = new SearchPosition(geometryFor(size));
    const base = connectionCost(empty, LIGHT, scratch);

    let state = createGame(size);
    state = place(state, 0, 5); // Red, on its own border line
    expect(connectionCost(SearchPosition.fromState(state), LIGHT, scratch)).toBe(base - 1);
  });

  it('reads the same both ways where the board is wide open', () => {
    // Every cell in the middle of an empty board has several equally short
    // routes, so insisting on a second one costs nothing.
    const pos = new SearchPosition(geometryFor(12));
    const scratch = scratchFor(12);
    expect(connectionCost(pos, LIGHT, scratch, 'two')).toBe(
      connectionCost(pos, LIGHT, scratch, 'plain'),
    );
  });

  /**
   * Where the two metrics part company — and why the search evaluates with the
   * plain one. Red here is a single peg from winning, through a cell that is
   * the only bridge between its two groups. Plain says "one peg". Two-distance,
   * asked for a second independent route and finding none, says the position is
   * hopeless. That is a defensible answer about fragility and a disastrous one
   * for a bot deciding whether it has a win on the board.
   */
  it('writes off a forced winning route that the plain metric sees', () => {
    const size = 8;
    const scratch = scratchFor(size);
    let state = createGame(size);
    for (const [red, black] of [
      [[0, 3], [1, 0]],
      [[2, 4], [2, 0]],
      [[6, 6], [3, 0]],
      [[7, 4], [4, 0]],
    ] as const) {
      state = place(state, red[0], red[1]);
      state = place(state, black[0], black[1]);
    }

    const pos = SearchPosition.fromState(state);
    expect(connectionCost(pos, LIGHT, scratch, 'plain')).toBe(1);
    expect(connectionCost(pos, LIGHT, scratch, 'two')).toBeGreaterThan(1);
  });
});

describe('a wall of enemy links', () => {
  it('raises the cost of crossing it', () => {
    const size = 12;
    const scratch = scratchFor(size);
    let state = createGame(size);

    const before = connectionCost(SearchPosition.fromState(state), LIGHT, scratch);

    // Black builds a chain of linked pegs straight across row 5-6, which Red
    // can neither stand on nor link through.
    const wall: Array<[number, number]> = [
      [5, 1], [6, 3], [5, 5], [6, 7], [5, 9], [6, 11],
    ];
    // Red plays out of the way on its own left-hand side while Black builds.
    const filler: Array<[number, number]> = [
      [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6],
    ];

    for (let i = 0; i < wall.length; i++) {
      state = place(state, filler[i]![0], filler[i]![1]);
      state = place(state, wall[i]![0], wall[i]![1]);
    }

    const pos = SearchPosition.fromState(state);
    // The wall really is a chain of links, not six loose pegs.
    expect(state.links.count).toBeGreaterThanOrEqual(5);
    expect(connectionCost(pos, LIGHT, scratch)).toBeGreaterThan(before);
  });
});

describe('cost zero is exactly a win', () => {
  it.each(METRICS)('agrees with checkConnection under the %s metric', (metric) => {
    const size = 8;
    const scratch = scratchFor(size);
    const rng = seeded(20260731);

    let checked = 0;
    let wins = 0;

    for (let game = 0; game < 30; game++) {
      let state = createGame(size);
      let seat: Seat = LIGHT;

      for (let ply = 0; ply < 64; ply++) {
        const options: number[] = [];
        for (let cell = 0; cell < size * size; cell++) {
          if (state.pegs[cell] !== EMPTY) continue;
          if (canPlaceCell(size, seat, cell)) options.push(cell);
        }
        if (options.length === 0) break;

        const step = applyMove(state, {
          t: 'turn',
          place: options[Math.floor(rng() * options.length)]!,
          linkOps: [],
        });
        if (!step.ok) throw new Error(step.error);
        state = step.state;

        const pos = SearchPosition.fromState(state);
        for (const side of [LIGHT, DARK] as Seat[]) {
          const connected = checkConnection(size, state.pegs, state.links, side);
          expect(connectionCost(pos, side, scratch, metric) === 0).toBe(connected);
          checked += 1;
          if (connected) wins += 1;
        }

        if (state.result) break;
        seat = otherSeat(seat);
      }
    }

    // A fuzz test that never reached a win would prove only the easy half.
    expect(checked).toBeGreaterThan(500);
    expect(wins).toBeGreaterThan(0);
  });
});

describe('evaluate', () => {
  it('is symmetric on an empty board apart from the move', () => {
    const size = 12;
    const pos = new SearchPosition(geometryFor(size));
    const scratch = scratchFor(size);
    // The two seats are mirror images, so whoever is to move is equally placed.
    expect(evaluate(pos, LIGHT, scratch)).toBe(evaluate(pos, DARK, scratch));
  });

  it('prefers the side that needs fewer pegs', () => {
    const size = 12;
    const scratch = scratchFor(size);
    let state = createGame(size);
    // Red builds a linked ladder while Black scatters pegs down one column.
    for (const [red, black] of [
      [[0, 5], [4, 0]],
      [[2, 6], [6, 0]],
      [[4, 7], [8, 0]],
    ] as const) {
      state = place(state, red[0], red[1]);
      state = place(state, black[0], black[1]);
    }

    const pos = SearchPosition.fromState(state);
    expect(connectionCost(pos, LIGHT, scratch)).toBeLessThan(connectionCost(pos, DARK, scratch));
    expect(evaluate(pos, LIGHT, scratch)).toBeGreaterThan(0);
    expect(evaluate(pos, DARK, scratch)).toBeLessThan(0);
  });
});

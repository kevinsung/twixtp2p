/**
 * Move generation.
 *
 * Full legality offers roughly 570 placements on a 24×24 board, which no
 * alpha-beta search can chew through at a useful depth. Almost all of them are
 * irrelevant: a peg nowhere near either side's route changes nothing.
 *
 * The relevance filter is free, because the evaluation has already computed
 * what it needs. `dNear[c] + dFar[c] - cost(c)` is what a route through `c`
 * would cost, so a cell whose potential equals the connection cost lies on a
 * cheapest route. Cells at slack 0 matter most, cells at slack 1 or 2 are
 * plausible, and the rest are noise. Doing that for both seats at once is what
 * makes the same generator produce attacking and blocking moves.
 */

import { EMPTY, type Seat, colOf, otherSeat, rowOf } from '../engine/board';
import { FAR, INF_FIELD, NEAR, type EvalScratch } from './eval';
import type { Geometry } from './geometry';
import type { SearchPosition } from './position';

/** Forced replies are worth more than any positional score can reach. */
const WINNING = 1_000_000;
const BLOCKING = 500_000;

/** How much a cell's own slack and the opponent's slack are worth. */
function relevance(slack: number): number {
  if (slack <= 0) return 9;
  if (slack === 1) return 5;
  if (slack === 2) return 2;
  return 0;
}

/**
 * A fixed-capacity, score-ordered top-K list.
 *
 * Selection happens in one pass over the board: a cell only pays the insertion
 * cost when it beats the weakest survivor, which after the first few dozen
 * cells is rare.
 */
export class CandidateBuffer {
  readonly cells: Int32Array;
  readonly scores: Int32Array;
  count = 0;

  constructor(readonly capacity: number) {
    this.cells = new Int32Array(capacity);
    this.scores = new Int32Array(capacity);
  }

  reset(): void {
    this.count = 0;
  }

  offer(cell: number, score: number): void {
    const cap = this.capacity;
    if (this.count === cap && score <= this.scores[cap - 1]) return;
    let at = this.count < cap ? this.count : cap - 1;
    while (at > 0 && this.scores[at - 1] < score) {
      this.scores[at] = this.scores[at - 1];
      this.cells[at] = this.cells[at - 1];
      at -= 1;
    }
    this.scores[at] = score;
    this.cells[at] = cell;
    if (this.count < cap) this.count += 1;
  }
}

/**
 * Fill `out` with the most promising placements for `seat`, best first.
 *
 * Leaves both seats' connection costs in the scratch, so a caller that wants to
 * evaluate the same position does not pay for the distance fields twice.
 */
export function generateCandidates(
  pos: SearchPosition,
  seat: Seat,
  lastPlace: number,
  scratch: EvalScratch,
  out: CandidateBuffer,
): number {
  const geo = scratch.geo;
  const size = geo.size;
  const them = otherSeat(seat);

  const myCost = scratch.connectionCost(pos, seat, 'plain');
  const myNear = scratch.fieldOffset(seat, NEAR);
  const myFar = scratch.fieldOffset(seat, FAR);
  const theirCost = scratch.connectionCost(pos, them, 'plain');
  const theirNear = scratch.fieldOffset(them, NEAR);
  const theirFar = scratch.fieldOffset(them, FAR);

  const mine = geo.placeable[seat];
  const theirs = geo.placeable[them];
  const mid = (size - 1) / 2;
  const lastRow = lastPlace >= 0 ? rowOf(size, lastPlace) : -1;
  const lastCol = lastPlace >= 0 ? colOf(size, lastPlace) : -1;

  out.reset();

  for (let cell = 0; cell < geo.cells; cell++) {
    if (pos.pegs[cell] !== EMPTY) continue;
    if (!mine[cell]) continue;

    // The cell costs this seat one peg, so its route potential is the two
    // border distances less the double count.
    const dn = scratch.field[myNear + cell];
    const df = scratch.field[myFar + cell];
    const mySlack = dn >= INF_FIELD || df >= INF_FIELD ? Infinity : dn + df - 1 - myCost;

    let theirSlack = Infinity;
    if (theirs[cell]) {
      const tn = scratch.field[theirNear + cell];
      const tf = scratch.field[theirFar + cell];
      if (tn < INF_FIELD && tf < INF_FIELD) theirSlack = tn + tf - 1 - theirCost;
    }

    let score = relevance(mySlack) * 7 + relevance(theirSlack) * 6;

    // Pegs work in company: a lone peg far from your own structure rarely does
    // anything, however good the route through it looks on paper.
    let friends = 0;
    for (let dir = 0; dir < 8; dir++) {
      const next = geo.nbrOf[cell * 8 + dir];
      if (next >= 0 && pos.pegs[next] === seat) friends += 1;
    }
    score += friends > 3 ? 3 : friends;

    const r = rowOf(size, cell);
    const c = colOf(size, cell);
    const off = Math.abs(r - mid) + Math.abs(c - mid);
    score += Math.max(0, 4 - (off >> 1));

    // Play near the action: the reply to a move is usually close to it.
    if (lastRow >= 0) {
      const span = Math.max(Math.abs(r - lastRow), Math.abs(c - lastCol));
      if (span <= 3) score += 5 - span;
    }

    // A cost of one peg means exactly one placement away from winning, and the
    // cells achieving the minimum are those placements. Never let ordering
    // heuristics push a win or the block of one out of the list.
    if (myCost === 1 && mySlack === 0) score += WINNING;
    else if (theirCost <= 1 && theirSlack === 0) score += BLOCKING;

    out.offer(cell, score);
  }

  return out.count;
}

/**
 * A first move for an otherwise empty board.
 *
 * Search has nothing to say here — every central peg evaluates the same — so
 * the bot picks at random from the good central squares rather than opening
 * identically every game.
 */
export function openingMove(geo: Geometry, seat: Seat, rng: () => number): number {
  const size = geo.size;
  const mid = (size - 1) / 2;
  const reach = Math.max(1, Math.floor(size / 8));
  const choices: number[] = [];

  for (let r = Math.ceil(mid - reach); r <= Math.floor(mid + reach); r++) {
    if (r < 0 || r >= size) continue;
    for (let c = Math.ceil(mid - reach); c <= Math.floor(mid + reach); c++) {
      if (c < 0 || c >= size) continue;
      const cell = r * size + c;
      if (!geo.placeable[seat][cell]) continue;
      choices.push(cell);
    }
  }

  if (choices.length === 0) return -1;
  return choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))];
}

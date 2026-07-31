/**
 * How close is a seat to connecting?
 *
 * The whole evaluation is one number per side: the smallest number of extra
 * pegs that would join its two border lines, ignoring the opponent's replies.
 * Everything else — move generation, terminal detection, the score the search
 * maximises — is derived from it.
 *
 * Cells cost 0 if they already hold the seat's peg, 1 if they are empty and
 * legal for it, and infinity otherwise (an enemy peg, or the enemy's border
 * line, which is off limits). A lane may be walked if the seat already owns the
 * link, or if it is unlinked and nothing crosses it. Then:
 *
 *     connectionCost = min over cells of (dNear[c] + dFar[c] - cost(c))
 *
 * and **cost 0 is exactly a win**: a zero-cost route is the seat's own pegs
 * joined by its own links from one border to the other, which is what
 * `checkConnection` looks for. Terminal detection therefore falls out of the
 * evaluation rather than needing its own search.
 *
 * Costs are 0 or 1, so the relaxation is a 0-1 BFS over a deque rather than a
 * heap: linear, and it allocates nothing per call.
 *
 * Two metrics live here. `plain` is ordinary shortest path. `two` is the
 * two-distance variant, which finalises a cell on its *second* incoming
 * relaxation and so rewards having two independent routes instead of one
 * fragile one. See `evaluate` for which the search actually uses, and why.
 */

import { EMPTY, type Seat, otherSeat } from '../engine/board';
import type { Geometry } from './geometry';
import type { SearchPosition } from './position';

/** A distance that was never reached. Big, but small enough to add safely. */
export const INF_FIELD = 1 << 20;
/** Returned when a seat has no route at all. Larger than any real cost. */
export const INF_COST = 1 << 21;

export type CostMetric = 'plain' | 'two';

export const NEAR = 0;
export const FAR = 1;

/**
 * Reusable working memory for the distance fields.
 *
 * One scratch per searching thread; every array below is sized once and then
 * only overwritten, so evaluating a position allocates nothing.
 */
export class EvalScratch {
  readonly geo: Geometry;
  /** Four distance fields: `field[(seat * 2 + side) * cells + cell]`. */
  readonly field: Int32Array;
  /** Per-seat cell costs: `cost[seat * cells + cell]`. */
  readonly cost: Int32Array;
  /** Per-seat connection cost from the last `connectionCost` call. */
  readonly seatCost: Int32Array = new Int32Array(2);
  /** Per-seat count of cells lying on some cheapest route. */
  readonly seatRoutes: Int32Array = new Int32Array(2);

  private readonly settled: Int32Array;
  private readonly hits: Int32Array;
  private readonly hitGen: Int32Array;
  private readonly queueCell: Int32Array;
  private readonly queueDist: Int32Array;
  private readonly maxDist: number;
  private gen = 0;

  constructor(geo: Geometry) {
    this.geo = geo;
    this.field = new Int32Array(geo.cells * 4);
    this.cost = new Int32Array(geo.cells * 2);
    this.settled = new Int32Array(geo.cells).fill(-1);
    this.hits = new Int32Array(geo.cells);
    this.hitGen = new Int32Array(geo.cells).fill(-1);
    // A route never needs more pegs than this, and capping the distance keeps
    // hopeless corners of the board from being explored at all.
    this.maxDist = 2 * geo.size;
    // Each settled cell pushes at most its eight lanes; the deque grows from
    // the middle because zero-cost steps push to the front.
    const cap = geo.cells * 9 + 16;
    this.queueCell = new Int32Array(cap * 2);
    this.queueDist = new Int32Array(cap * 2);
  }

  /** The distance field written by the last `connectionCost` for this seat. */
  fieldOffset(seat: Seat, side: number): number {
    return (seat * 2 + side) * this.geo.cells;
  }

  private prepareCosts(pos: SearchPosition, seat: Seat): number {
    const geo = this.geo;
    const base = seat * geo.cells;
    const placeable = geo.placeable[seat];
    for (let cell = 0; cell < geo.cells; cell++) {
      const peg = pos.pegs[cell];
      this.cost[base + cell] =
        peg === seat ? 0 : peg === EMPTY && placeable[cell] ? 1 : INF_FIELD;
    }
    return base;
  }

  /**
   * Relax distances from one border line across the usable lanes.
   *
   * The deque keeps pops in non-decreasing distance order, which is what lets
   * the two-distance rule count *distinct* predecessors simply by counting
   * pops: a cell is pushed at most once by each cell that settles.
   */
  private relax(
    pos: SearchPosition,
    seat: Seat,
    side: number,
    metric: CostMetric,
  ): void {
    const geo = this.geo;
    const cells = geo.cells;
    const costBase = seat * cells;
    const out = this.fieldOffset(seat, side);
    const gen = ++this.gen;
    const two = metric === 'two';
    const maxDist = this.maxDist;

    for (let cell = 0; cell < cells; cell++) this.field[out + cell] = INF_FIELD;

    const mid = this.queueCell.length >> 1;
    let head = mid;
    let tail = mid;

    const sources = side === NEAR ? geo.nearCells[seat] : geo.farCells[seat];
    for (let i = 0; i < sources.length; i++) {
      const cell = sources[i];
      const cost = this.cost[costBase + cell];
      if (cost >= INF_FIELD) continue;
      // A cell on your own border line is attached to it by the border itself,
      // never by a single fragile link, so it settles on its first pop even
      // under the two-distance rule.
      this.hitGen[cell] = gen;
      this.hits[cell] = 1;
      if (cost === 0) {
        head -= 1;
        this.queueCell[head] = cell;
        this.queueDist[head] = 0;
      } else {
        this.queueCell[tail] = cell;
        this.queueDist[tail] = cost;
        tail += 1;
      }
    }

    while (head < tail) {
      const cell = this.queueCell[head];
      const dist = this.queueDist[head];
      head += 1;
      if (this.settled[cell] === gen) continue;

      if (two && this.cost[costBase + cell] > 0) {
        // Cost-carrying cells must be reachable two ways before we believe in
        // them. Cells that cost nothing are already part of the seat's own
        // structure, so one route to them is the truth.
        if (this.hitGen[cell] !== gen) {
          this.hitGen[cell] = gen;
          this.hits[cell] = 0;
        }
        if (++this.hits[cell] < 2) continue;
      }

      this.settled[cell] = gen;
      this.field[out + cell] = dist;

      for (let dir = 0; dir < 8; dir++) {
        const next = geo.nbrOf[cell * 8 + dir];
        if (next < 0) continue;
        if (this.settled[next] === gen) continue;
        const nextCost = this.cost[costBase + next];
        if (nextCost >= INF_FIELD) continue;
        const lane = geo.laneOf[cell * 8 + dir];
        const owner = pos.linkOwner[lane];
        // Usable: already ours, or free and uncrossed so we could still build it.
        if (owner !== seat && (owner !== EMPTY || pos.crossCount[lane] !== 0)) continue;
        const nextDist = dist + nextCost;
        if (nextDist > maxDist) continue;
        if (nextCost === 0) {
          head -= 1;
          this.queueCell[head] = next;
          this.queueDist[head] = nextDist;
        } else {
          this.queueCell[tail] = next;
          this.queueDist[tail] = nextDist;
          tail += 1;
        }
      }
    }
  }

  /**
   * The extra pegs `seat` needs to connect, also recording how many cells lie
   * on a cheapest route — a cheap proxy for how many ways it can get there.
   */
  connectionCost(pos: SearchPosition, seat: Seat, metric: CostMetric = 'plain'): number {
    const geo = this.geo;
    this.prepareCosts(pos, seat);
    this.relax(pos, seat, NEAR, metric);
    this.relax(pos, seat, FAR, metric);

    const near = this.fieldOffset(seat, NEAR);
    const far = this.fieldOffset(seat, FAR);
    const costBase = seat * geo.cells;

    let best = INF_COST;
    for (let cell = 0; cell < geo.cells; cell++) {
      const dn = this.field[near + cell];
      if (dn >= INF_FIELD) continue;
      const df = this.field[far + cell];
      if (df >= INF_FIELD) continue;
      const total = dn + df - this.cost[costBase + cell];
      if (total < best) best = total;
    }

    let routes = 0;
    if (best < INF_COST) {
      for (let cell = 0; cell < geo.cells; cell++) {
        const dn = this.field[near + cell];
        if (dn >= INF_FIELD) continue;
        const df = this.field[far + cell];
        if (df >= INF_FIELD) continue;
        if (dn + df - this.cost[costBase + cell] === best) routes += 1;
      }
    }

    this.seatCost[seat] = best;
    this.seatRoutes[seat] = routes;
    return best;
  }
}

/** Shorthand for a one-off cost, mostly for tests. */
export function connectionCost(
  pos: SearchPosition,
  seat: Seat,
  scratch: EvalScratch,
  metric: CostMetric = 'plain',
): number {
  return scratch.connectionCost(pos, seat, metric);
}

/** Weight of one peg of connection cost, in evaluation units. */
const PEG = 64;
/** Being on move is worth something, but much less than a peg. */
const TEMPO = 8;
/** Cap on the route-count bonus, so breadth never outweighs distance. */
const MAX_ROUTES = 24;

/**
 * The position from `seatToMove`'s point of view, assuming it is that seat's turn.
 *
 * Distance difference dominates; the number of cells on a cheapest route breaks
 * ties towards positions with several ways through rather than one. That
 * route count is why the search evaluates with the plain metric rather than the
 * two-distance one: two-distance answers the same "is my route fragile?"
 * question, but it reports infinity for a route that is forced — including the
 * single forced route that is about to win the game — and it puts the winning
 * cell out of reach of move generation. The route count degrades gracefully
 * where two-distance falls off a cliff, and costs nothing extra because the
 * scan is already happening.
 */
export function evaluate(pos: SearchPosition, seatToMove: Seat, scratch: EvalScratch): number {
  const them = otherSeat(seatToMove);
  // A seat whose every route is cut reports `INF_COST`, which is enormous. Left
  // raw it would swamp the mate scores and have the search chase a position it
  // merely likes over one that actually wins, so it is clamped to just beyond
  // the longest real route.
  const cap = 4 * scratch.geo.size;
  const mine = Math.min(scratch.connectionCost(pos, seatToMove, 'plain'), cap);
  const myRoutes = Math.min(scratch.seatRoutes[seatToMove], MAX_ROUTES);
  const theirs = Math.min(scratch.connectionCost(pos, them, 'plain'), cap);
  const theirRoutes = Math.min(scratch.seatRoutes[them], MAX_ROUTES);

  return (theirs - mine) * PEG + (myRoutes - theirRoutes) + TEMPO;
}

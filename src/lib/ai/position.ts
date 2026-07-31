/**
 * The search's mutable board.
 *
 * `GameState` is a pure fold: every `applyMove` clones an `Int8Array` and a
 * `LinkSet` of three `Map`s. That is exactly right for a rules engine and
 * hopeless for a search, which visits hundreds of thousands of positions a
 * second and needs make/unmake to be a handful of array writes.
 *
 * So the search gets its own representation. It is only useful if it agrees
 * with the engine down to the last auto-linked lane, which is what
 * `position.test.ts` checks by replaying random games through both.
 *
 * The whole thing rests on the precomputed cross table: adding a link marks one
 * lane and increments a counter on each of the ~10 lanes it blocks, and undoing
 * decrements them again. No set membership, no allocation, no cloning.
 */

import { EMPTY, type Seat } from '../engine/board';
import type { GameState } from '../engine/game';
import { type Geometry, geometryFor } from './geometry';

/**
 * A record of one placement, enough to reverse it exactly.
 *
 * Frames are pooled by ply rather than allocated per move, so a deep search
 * creates no garbage. `lanes` is fixed at 8 because a peg can auto-link along
 * at most its eight knight lanes.
 */
export interface Undo {
  cell: number;
  seat: Seat;
  laneCount: number;
  readonly lanes: Int32Array;
  h0: number;
  h1: number;
}

function newUndo(): Undo {
  return { cell: -1, seat: 0, laneCount: 0, lanes: new Int32Array(8), h0: 0, h1: 0 };
}

export class SearchPosition {
  readonly geo: Geometry;
  /** EMPTY or a seat, per cell. */
  readonly pegs: Int8Array;
  /** EMPTY or the seat owning the link, per lane. */
  readonly linkOwner: Int8Array;
  /** How many links, of either colour, cross this lane. */
  readonly crossCount: Int32Array;

  /** Zobrist halves. `hash` combines them into one safe-integer key. */
  h0 = 0;
  h1 = 0;

  private readonly frames: Undo[] = [];
  private depth = 0;

  // Connectivity scans stamp cells with a generation counter instead of
  // clearing a visited array each time.
  private readonly visit: Int32Array;
  private visitGen = 0;
  private readonly stack: Int32Array;

  constructor(geo: Geometry) {
    this.geo = geo;
    this.pegs = new Int8Array(geo.cells).fill(EMPTY);
    this.linkOwner = new Int8Array(geo.laneCount).fill(EMPTY);
    this.crossCount = new Int32Array(geo.laneCount);
    this.visit = new Int32Array(geo.cells).fill(-1);
    this.stack = new Int32Array(geo.cells);
  }

  /**
   * A key wide enough that transposition collisions are not a practical
   * concern: 32 bits from one half and 18 from the other, which stays inside
   * the safe-integer range even after the search tags on the side to move.
   */
  get hash(): number {
    return (this.h0 >>> 0) * 262144 + (this.h1 >>> 14);
  }

  static fromState(state: GameState): SearchPosition {
    const pos = new SearchPosition(geometryFor(state.size));
    const geo = pos.geo;

    for (let cell = 0; cell < geo.cells; cell++) {
      const seat = state.pegs[cell]!;
      if (seat === EMPTY) continue;
      pos.pegs[cell] = seat;
      pos.h0 ^= geo.zPeg0[cell * 2 + seat]!;
      pos.h1 ^= geo.zPeg1[cell * 2 + seat]!;
    }

    // Import the links the engine actually holds rather than re-deriving them:
    // a player may have declined or removed an auto-link, and the position has
    // to reflect that.
    for (const link of state.links.all()) {
      const seat = pos.pegs[link.a] as Seat;
      const lane = pos.laneBetween(link.a, link.b);
      if (lane < 0) continue;
      pos.addLink(lane, seat);
    }

    return pos;
  }

  /** The lane joining two cells a knight's move apart, or -1. */
  laneBetween(a: number, b: number): number {
    const geo = this.geo;
    for (let dir = 0; dir < 8; dir++) {
      if (geo.nbrOf[a * 8 + dir] === b) return geo.laneOf[a * 8 + dir]!;
    }
    return -1;
  }

  private addLink(lane: number, seat: Seat): void {
    const geo = this.geo;
    this.linkOwner[lane] = seat;
    this.h0 ^= geo.zLane0[lane * 2 + seat]!;
    this.h1 ^= geo.zLane1[lane * 2 + seat]!;
    const end = geo.crossStart[lane + 1];
    for (let i = geo.crossStart[lane]; i < end; i++) this.crossCount[geo.crossList[i]] += 1;
  }

  private removeLink(lane: number, seat: Seat): void {
    const geo = this.geo;
    this.linkOwner[lane] = EMPTY;
    this.h0 ^= geo.zLane0[lane * 2 + seat]!;
    this.h1 ^= geo.zLane1[lane * 2 + seat]!;
    const end = geo.crossStart[lane + 1];
    for (let i = geo.crossStart[lane]; i < end; i++) this.crossCount[geo.crossList[i]] -= 1;
  }

  /**
   * Place a peg and auto-link it, exactly as `applyTurn` does.
   *
   * The engine links to every friendly knight neighbour whose lane is free and
   * uncrossed. Because every candidate shares the new peg as an endpoint, none
   * of them can block another, so order does not matter here either.
   */
  place(cell: number, seat: Seat): Undo {
    const geo = this.geo;
    while (this.frames.length <= this.depth) this.frames.push(newUndo());
    const undo = this.frames[this.depth++]!;
    undo.cell = cell;
    undo.seat = seat;
    undo.laneCount = 0;
    undo.h0 = this.h0;
    undo.h1 = this.h1;

    this.pegs[cell] = seat;
    this.h0 ^= geo.zPeg0[cell * 2 + seat]!;
    this.h1 ^= geo.zPeg1[cell * 2 + seat]!;

    for (let dir = 0; dir < 8; dir++) {
      const other = geo.nbrOf[cell * 8 + dir]!;
      if (other < 0) continue;
      if (this.pegs[other] !== seat) continue;
      const lane = geo.laneOf[cell * 8 + dir]!;
      if (this.linkOwner[lane] !== EMPTY) continue;
      if (this.crossCount[lane] !== 0) continue;
      this.addLink(lane, seat);
      undo.lanes[undo.laneCount++] = lane;
    }

    return undo;
  }

  /** Reverse the most recent `place`. */
  unplace(undo: Undo): void {
    if (this.depth === 0 || this.frames[this.depth - 1] !== undo) {
      throw new Error('unplace must undo the most recent place');
    }
    this.depth -= 1;
    for (let i = 0; i < undo.laneCount; i++) this.removeLink(undo.lanes[i]!, undo.seat);
    this.pegs[undo.cell] = EMPTY;
    this.h0 = undo.h0;
    this.h1 = undo.h1;
  }

  /** How many placements are currently un-undone. */
  get plies(): number {
    return this.depth;
  }

  /**
   * True if `seat` has joined its two border lines — the same question
   * `checkConnection` answers, over the same graph.
   */
  connected(seat: Seat): boolean {
    const geo = this.geo;
    const gen = ++this.visitGen;
    const near = geo.nearCells[seat];
    const isFar = geo.isFar[seat];
    let top = 0;

    for (let i = 0; i < near.length; i++) {
      const cell = near[i]!;
      if (this.pegs[cell] !== seat) continue;
      if (isFar[cell]) return true;
      this.visit[cell] = gen;
      this.stack[top++] = cell;
    }

    while (top > 0) {
      const cell = this.stack[--top]!;
      for (let dir = 0; dir < 8; dir++) {
        const lane = geo.laneOf[cell * 8 + dir]!;
        if (lane < 0 || this.linkOwner[lane] !== seat) continue;
        const next = geo.nbrOf[cell * 8 + dir]!;
        if (this.visit[next] === gen) continue;
        if (isFar[next]) return true;
        this.visit[next] = gen;
        this.stack[top++] = next;
      }
    }

    return false;
  }
}

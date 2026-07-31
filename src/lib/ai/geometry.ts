/**
 * Precomputed board tables for the search.
 *
 * The rules engine answers "does this link cross anything?" by walking a spatial
 * index of the links actually on the board. A search cannot afford that: it
 * makes and unmakes moves millions of times, and every one of those queries
 * would rebuild the same geometric facts.
 *
 * The enabling observation is that the geometry is fixed. Which knight lanes
 * cross a given knight lane depends only on the board size, never on the
 * position. So we compute it once and reduce "add a link" to marking a lane and
 * bumping a counter on each lane it blocks.
 *
 * A *lane* is an unordered pair of holes a knight's move apart, given a dense
 * index. Everything here is a flat typed array keyed by cell or lane, so the
 * hot loops touch no objects and allocate nothing.
 */

import {
  DARK,
  KNIGHT_OFFSETS,
  LIGHT,
  type Seat,
  borderSide,
  canPlaceCell,
  colOf,
  idx,
  isHole,
  rowOf,
} from '../engine/board';
import { segmentsProperlyIntersect } from '../engine/crossing';

export interface Geometry {
  readonly size: number;
  readonly cells: number;
  readonly laneCount: number;

  /** True for holes, false for off-board indices and the removed corners. */
  readonly hole: Uint8Array;

  /** `(cell * 8 + dir)` → lane index, or -1 when that knight step leaves the board. */
  readonly laneOf: Int32Array;
  /** `(cell * 8 + dir)` → the cell at the far end, or -1. */
  readonly nbrOf: Int32Array;
  readonly laneA: Int32Array;
  readonly laneB: Int32Array;

  /** CSR adjacency: lanes that properly intersect lane `l` are `crossList[crossStart[l] .. crossStart[l+1])`. */
  readonly crossStart: Int32Array;
  readonly crossList: Int32Array;

  /** CSR knight adjacency over cells. */
  readonly knightStart: Int32Array;
  readonly knightList: Int32Array;

  /** Per seat, 1 where that seat may legally place. */
  readonly placeable: readonly [Uint8Array, Uint8Array];
  /** Per seat, 1 on that seat's near (top row / left column) border line. */
  readonly isNear: readonly [Uint8Array, Uint8Array];
  readonly isFar: readonly [Uint8Array, Uint8Array];
  /** Per seat, the holes on the near / far border line. */
  readonly nearCells: readonly [Int32Array, Int32Array];
  readonly farCells: readonly [Int32Array, Int32Array];

  /**
   * Zobrist keys, kept as two independent 32-bit halves so the combined key has
   * enough bits that transposition-table collisions stay negligible over a
   * search of millions of nodes.
   */
  readonly zPeg0: Int32Array;
  readonly zPeg1: Int32Array;
  readonly zLane0: Int32Array;
  readonly zLane1: Int32Array;
}

const cache = new Map<number, Geometry>();

/** The tables for a board size, built on first use and shared thereafter. */
export function geometryFor(size: number): Geometry {
  let geo = cache.get(size);
  if (!geo) {
    geo = build(size);
    cache.set(size, geo);
  }
  return geo;
}

/** The knight offset opposite to `dir` — the same lane seen from the other end. */
export function oppositeDir(dir: number): number {
  return (dir + 4) % 8;
}

/**
 * The two unit grid squares a lane's bounding box covers.
 *
 * Identical to the rules engine's link index: two segments can only meet if
 * they share a square, which turns the cross table from a quadratic scan into a
 * bucketed one.
 */
function squaresOf(size: number, a: number, b: number): [number, number] {
  const r1 = rowOf(size, a);
  const c1 = colOf(size, a);
  const r2 = rowOf(size, b);
  const c2 = colOf(size, b);
  const rMin = Math.min(r1, r2);
  const cMin = Math.min(c1, c2);
  const wide = Math.abs(c1 - c2) === 2;
  return wide
    ? [rMin * size + cMin, rMin * size + cMin + 1]
    : [rMin * size + cMin, (rMin + 1) * size + cMin];
}

/** Deterministic PRNG, so a given board size always gets the same Zobrist keys. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomKeys(count: number, rng: () => number): Int32Array {
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) out[i] = (rng() * 4294967296) | 0;
  return out;
}

function build(size: number): Geometry {
  const cells = size * size;

  const hole = new Uint8Array(cells);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) hole[idx(size, r, c)] = isHole(size, r, c) ? 1 : 0;
  }

  const laneOf = new Int32Array(cells * 8).fill(-1);
  const nbrOf = new Int32Array(cells * 8).fill(-1);
  const laneAList: number[] = [];
  const laneBList: number[] = [];

  // Walk each cell's knight steps and hand out one index per unordered pair.
  // The pair is registered from both ends, so a lane looks the same whichever
  // endpoint the search happens to be standing on.
  for (let cell = 0; cell < cells; cell++) {
    if (!hole[cell]) continue;
    const r = rowOf(size, cell);
    const c = colOf(size, cell);
    for (let dir = 0; dir < 8; dir++) {
      const [dr, dc] = KNIGHT_OFFSETS[dir]!;
      const nr = r + dr;
      const nc = c + dc;
      if (!isHole(size, nr, nc)) continue;
      const other = idx(size, nr, nc);
      nbrOf[cell * 8 + dir] = other;
      if (other < cell) continue; // already indexed from the other end
      const lane = laneAList.length;
      laneAList.push(cell);
      laneBList.push(other);
      laneOf[cell * 8 + dir] = lane;
      laneOf[other * 8 + oppositeDir(dir)] = lane;
    }
  }

  const laneCount = laneAList.length;
  const laneA = Int32Array.from(laneAList);
  const laneB = Int32Array.from(laneBList);

  // Bucket lanes by the unit squares they cover, then test only lanes sharing a
  // square. `segmentsProperlyIntersect` is the rules engine's own predicate, so
  // the table cannot drift from the crossing rule.
  const buckets: number[][] = Array.from({ length: cells }, () => []);
  for (let lane = 0; lane < laneCount; lane++) {
    for (const sq of squaresOf(size, laneA[lane]!, laneB[lane]!)) buckets[sq]!.push(lane);
  }

  const crossStart = new Int32Array(laneCount + 1);
  const crossOf: number[][] = new Array(laneCount);
  const seen = new Int32Array(laneCount).fill(-1);
  let crossTotal = 0;

  for (let lane = 0; lane < laneCount; lane++) {
    const a = laneA[lane]!;
    const b = laneB[lane]!;
    const ax = colOf(size, a);
    const ay = rowOf(size, a);
    const bx = colOf(size, b);
    const by = rowOf(size, b);
    const found: number[] = [];

    for (const sq of squaresOf(size, a, b)) {
      for (const other of buckets[sq]!) {
        if (other === lane || seen[other] === lane) continue;
        seen[other] = lane;
        const p = laneA[other]!;
        const q = laneB[other]!;
        if (
          segmentsProperlyIntersect(
            ax, ay, bx, by,
            colOf(size, p), rowOf(size, p),
            colOf(size, q), rowOf(size, q),
          )
        ) {
          found.push(other);
        }
      }
    }

    found.sort((x, y) => x - y);
    crossOf[lane] = found;
    crossTotal += found.length;
  }

  const crossList = new Int32Array(crossTotal);
  let cursor = 0;
  for (let lane = 0; lane < laneCount; lane++) {
    crossStart[lane] = cursor;
    for (const other of crossOf[lane]!) crossList[cursor++] = other;
  }
  crossStart[laneCount] = cursor;

  const knightStart = new Int32Array(cells + 1);
  const knightAll: number[] = [];
  for (let cell = 0; cell < cells; cell++) {
    knightStart[cell] = knightAll.length;
    if (hole[cell]) {
      for (let dir = 0; dir < 8; dir++) {
        const other = nbrOf[cell * 8 + dir]!;
        if (other >= 0) knightAll.push(other);
      }
    }
  }
  knightStart[cells] = knightAll.length;

  const placeable: [Uint8Array, Uint8Array] = [new Uint8Array(cells), new Uint8Array(cells)];
  const isNear: [Uint8Array, Uint8Array] = [new Uint8Array(cells), new Uint8Array(cells)];
  const isFar: [Uint8Array, Uint8Array] = [new Uint8Array(cells), new Uint8Array(cells)];
  const nearLists: [number[], number[]] = [[], []];
  const farLists: [number[], number[]] = [[], []];

  for (const seat of [LIGHT, DARK] as Seat[]) {
    for (let cell = 0; cell < cells; cell++) {
      if (!hole[cell]) continue;
      placeable[seat][cell] = canPlaceCell(size, seat, cell) ? 1 : 0;
      const side = borderSide(size, seat, rowOf(size, cell), colOf(size, cell));
      if (side === 'near') {
        isNear[seat][cell] = 1;
        nearLists[seat].push(cell);
      } else if (side === 'far') {
        isFar[seat][cell] = 1;
        farLists[seat].push(cell);
      }
    }
  }

  const rng = mulberry32(0x7c1a7 ^ (size * 2654435761));

  return {
    size,
    cells,
    laneCount,
    hole,
    laneOf,
    nbrOf,
    laneA,
    laneB,
    crossStart,
    crossList,
    knightStart,
    knightList: Int32Array.from(knightAll),
    placeable,
    isNear,
    isFar,
    nearCells: [Int32Array.from(nearLists[0]), Int32Array.from(nearLists[1])],
    farCells: [Int32Array.from(farLists[0]), Int32Array.from(farLists[1])],
    zPeg0: randomKeys(cells * 2, rng),
    zPeg1: randomKeys(cells * 2, rng),
    zLane0: randomKeys(laneCount * 2, rng),
    zLane1: randomKeys(laneCount * 2, rng),
  };
}

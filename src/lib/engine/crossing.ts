/**
 * Link storage and the link-crossing rule.
 *
 * A link is a knight's-move segment between two pegs. Links may not cross each
 * other — including the opponent's — which is the defensive heart of TwixT.
 *
 * Two properties of knight's-move segments make this exact and cheap:
 *
 *  1. A knight segment contains no interior lattice points (gcd(1, 2) = 1).
 *     So a link never passes through a peg hole, and any intersection at a
 *     lattice point must be a shared endpoint — which is legal, not a crossing.
 *     That means the strict "proper intersection" test is exactly the rule.
 *
 *  2. Two distinct knight segments can never be collinear and overlapping, so
 *     the degenerate collinear branch of segment intersection cannot fire for a
 *     genuine crossing and does not need handling.
 *
 * Endpoints are integers, so the orientation tests below are exact integer
 * arithmetic: no floating point, no epsilon, no ambiguity.
 *
 * For speed, links are indexed by the unit grid squares their bounding box
 * covers — exactly two per link. Two segments can only intersect if they share
 * a unit square, so a crossing check inspects a small constant number of
 * candidates rather than every link on the board. That reasoning is subtle
 * enough not to trust on inspection, so `crossing.test.ts` checks the indexed
 * result against a brute-force scan over randomised link sets.
 */

import { colOf, rowOf } from './board';

export interface Link {
  a: number;
  b: number;
}

/** Canonical key for an unordered pair of cells. */
export function linkKey(size: number, a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * size * size + hi;
}

/**
 * Twice the signed area of triangle (o, p, q). Sign gives the turn direction:
 * positive for counter-clockwise, negative for clockwise, zero for collinear.
 */
function orient(ox: number, oy: number, px: number, py: number, qx: number, qy: number): number {
  return (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
}

/**
 * True if segments p1p2 and p3p4 properly intersect — that is, each segment
 * strictly straddles the line through the other.
 *
 * Touching at an endpoint returns false, which is what we want: links sharing a
 * peg are legal.
 */
export function segmentsProperlyIntersect(
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  p3x: number, p3y: number,
  p4x: number, p4y: number,
): boolean {
  const d1 = orient(p3x, p3y, p4x, p4y, p1x, p1y);
  const d2 = orient(p3x, p3y, p4x, p4y, p2x, p2y);
  const d3 = orient(p1x, p1y, p2x, p2y, p3x, p3y);
  const d4 = orient(p1x, p1y, p2x, p2y, p4x, p4y);

  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/**
 * A set of links with a spatial index for crossing queries and an adjacency
 * map for connectivity searches.
 */
export class LinkSet {
  readonly size: number;
  private readonly links = new Map<number, Link>();
  private readonly bySquare = new Map<number, Set<number>>();
  private readonly byCell = new Map<number, Set<number>>();

  constructor(size: number) {
    this.size = size;
  }

  get count(): number {
    return this.links.size;
  }

  all(): Link[] {
    return [...this.links.values()];
  }

  /** Link keys in ascending order — used for state hashing. */
  sortedKeys(): number[] {
    return [...this.links.keys()].sort((x, y) => x - y);
  }

  has(a: number, b: number): boolean {
    return this.links.has(linkKey(this.size, a, b));
  }

  /** Cells linked to `cell`. The returned set must not be mutated. */
  neighbors(cell: number): ReadonlySet<number> {
    return this.byCell.get(cell) ?? EMPTY_SET;
  }

  /**
   * The unit grid squares a link's bounding box covers. A knight's-move link
   * always covers exactly two.
   */
  private squaresOf(a: number, b: number): [number, number] {
    const size = this.size;
    const r1 = rowOf(size, a);
    const c1 = colOf(size, a);
    const r2 = rowOf(size, b);
    const c2 = colOf(size, b);
    const rMin = Math.min(r1, r2);
    const cMin = Math.min(c1, c2);
    // A (±1, ±2) link spans two squares horizontally; a (±2, ±1) link spans two
    // squares vertically.
    const wide = Math.abs(c1 - c2) === 2;
    return wide
      ? [rMin * size + cMin, rMin * size + cMin + 1]
      : [rMin * size + cMin, (rMin + 1) * size + cMin];
  }

  add(a: number, b: number): void {
    const key = linkKey(this.size, a, b);
    if (this.links.has(key)) return;
    this.links.set(key, { a: Math.min(a, b), b: Math.max(a, b) });

    for (const sq of this.squaresOf(a, b)) {
      let bucket = this.bySquare.get(sq);
      if (!bucket) {
        bucket = new Set();
        this.bySquare.set(sq, bucket);
      }
      bucket.add(key);
    }

    addAdjacency(this.byCell, a, b);
    addAdjacency(this.byCell, b, a);
  }

  remove(a: number, b: number): void {
    const key = linkKey(this.size, a, b);
    if (!this.links.delete(key)) return;

    for (const sq of this.squaresOf(a, b)) {
      const bucket = this.bySquare.get(sq);
      if (bucket) {
        bucket.delete(key);
        if (bucket.size === 0) this.bySquare.delete(sq);
      }
    }

    removeAdjacency(this.byCell, a, b);
    removeAdjacency(this.byCell, b, a);
  }

  /**
   * True if a link between `a` and `b` would cross any link already present.
   *
   * Links sharing an endpoint with the candidate never count as crossing. An
   * identical link is likewise not a crossing — callers check `has` separately.
   */
  crossesAny(a: number, b: number): boolean {
    const size = this.size;
    const ax = colOf(size, a);
    const ay = rowOf(size, a);
    const bx = colOf(size, b);
    const by = rowOf(size, b);

    // Gather candidates from both squares first; a link registered under both
    // would otherwise be tested twice.
    const candidates = new Set<number>();
    for (const sq of this.squaresOf(a, b)) {
      const bucket = this.bySquare.get(sq);
      if (bucket) for (const key of bucket) candidates.add(key);
    }

    for (const key of candidates) {
      const link = this.links.get(key)!;
      if (link.a === a || link.a === b || link.b === a || link.b === b) continue;

      if (
        segmentsProperlyIntersect(
          ax, ay, bx, by,
          colOf(size, link.a), rowOf(size, link.a),
          colOf(size, link.b), rowOf(size, link.b),
        )
      ) {
        return true;
      }
    }

    return false;
  }

  clone(): LinkSet {
    const copy = new LinkSet(this.size);
    for (const link of this.links.values()) copy.add(link.a, link.b);
    return copy;
  }
}

const EMPTY_SET: ReadonlySet<number> = new Set();

function addAdjacency(map: Map<number, Set<number>>, from: number, to: number): void {
  let set = map.get(from);
  if (!set) {
    set = new Set();
    map.set(from, set);
  }
  set.add(to);
}

function removeAdjacency(map: Map<number, Set<number>>, from: number, to: number): void {
  const set = map.get(from);
  if (!set) return;
  set.delete(to);
  if (set.size === 0) map.delete(from);
}

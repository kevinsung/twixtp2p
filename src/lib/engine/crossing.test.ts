import { describe, expect, it } from 'vitest';

import { KNIGHT_OFFSETS, colOf, idx, isHole, rowOf } from './board';
import { LinkSet, type Link, segmentsProperlyIntersect } from './crossing';

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The reference implementation: compare against every link on the board, with
 * no spatial index. `LinkSet.crossesAny` must agree with this always.
 */
function bruteCrosses(size: number, links: Link[], a: number, b: number): boolean {
  const ax = colOf(size, a);
  const ay = rowOf(size, a);
  const bx = colOf(size, b);
  const by = rowOf(size, b);

  for (const link of links) {
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

function randomLink(size: number, rand: () => number): [number, number] | null {
  const r = Math.floor(rand() * size);
  const c = Math.floor(rand() * size);
  const offset = KNIGHT_OFFSETS[Math.floor(rand() * KNIGHT_OFFSETS.length)]!;
  const nr = r + offset[0];
  const nc = c + offset[1];
  if (!isHole(size, r, c) || !isHole(size, nr, nc)) return null;
  return [idx(size, r, c), idx(size, nr, nc)];
}

describe('knight segment geometry', () => {
  it('contains no interior lattice points', () => {
    // This is what lets us treat "proper intersection" as exactly the crossing
    // rule: a link can never pass through a peg hole, so an intersection at a
    // lattice point is always a shared endpoint.
    for (const [dr, dc] of KNIGHT_OFFSETS) {
      for (let r = Math.min(0, dr); r <= Math.max(0, dr); r++) {
        for (let c = Math.min(0, dc); c <= Math.max(0, dc); c++) {
          const isEndpoint = (r === 0 && c === 0) || (r === dr && c === dc);
          if (isEndpoint) continue;
          // Collinear with the segment would mean cross product zero.
          expect(r * dc - c * dr).not.toBe(0);
        }
      }
    }
  });
});

describe('segmentsProperlyIntersect', () => {
  it('detects a plain X crossing', () => {
    // (2,2)-(3,4) against (2,4)-(3,2), meeting at (3, 2.5) in x/y terms.
    expect(segmentsProperlyIntersect(2, 2, 4, 3, 4, 2, 2, 3)).toBe(true);
  });

  it('rejects parallel segments', () => {
    expect(segmentsProperlyIntersect(0, 0, 2, 1, 0, 2, 2, 3)).toBe(false);
  });

  it('rejects segments meeting only at a shared endpoint', () => {
    expect(segmentsProperlyIntersect(0, 0, 2, 1, 2, 1, 4, 2)).toBe(false);
  });
});

describe('LinkSet', () => {
  const size = 12;

  it('blocks a crossing link and allows a parallel one', () => {
    const links = new LinkSet(size);
    links.add(idx(size, 2, 2), idx(size, 3, 4));

    expect(links.crossesAny(idx(size, 2, 4), idx(size, 3, 2))).toBe(true);
    expect(links.crossesAny(idx(size, 5, 2), idx(size, 6, 4))).toBe(false);
  });

  it('never reports a crossing for links sharing a peg', () => {
    const links = new LinkSet(size);
    const hub = idx(size, 5, 5);
    links.add(hub, idx(size, 3, 4));
    for (const [dr, dc] of KNIGHT_OFFSETS) {
      expect(links.crossesAny(hub, idx(size, 5 + dr, 5 + dc))).toBe(false);
    }
  });

  it('forgets a link once removed', () => {
    const links = new LinkSet(size);
    const a = idx(size, 2, 2);
    const b = idx(size, 3, 4);
    links.add(a, b);
    expect(links.has(a, b)).toBe(true);
    expect(links.crossesAny(idx(size, 2, 4), idx(size, 3, 2))).toBe(true);

    links.remove(a, b);
    expect(links.has(a, b)).toBe(false);
    expect(links.count).toBe(0);
    expect(links.crossesAny(idx(size, 2, 4), idx(size, 3, 2))).toBe(false);
  });

  it('tracks adjacency in both directions', () => {
    const links = new LinkSet(size);
    const a = idx(size, 2, 2);
    const b = idx(size, 3, 4);
    links.add(a, b);
    expect([...links.neighbors(a)]).toEqual([b]);
    expect([...links.neighbors(b)]).toEqual([a]);
    links.remove(a, b);
    expect(links.neighbors(a).size).toBe(0);
  });

  it('survives a clone independently of the original', () => {
    const links = new LinkSet(size);
    links.add(idx(size, 2, 2), idx(size, 3, 4));
    const copy = links.clone();
    copy.add(idx(size, 6, 6), idx(size, 7, 8));

    expect(links.count).toBe(1);
    expect(copy.count).toBe(2);
  });

  it('agrees with the brute-force oracle on randomised boards', () => {
    // A small board keeps link density high so crossings are common.
    const boardSize = 9;
    let crossingsSeen = 0;
    let checks = 0;

    for (let seed = 1; seed <= 40; seed++) {
      const rand = mulberry32(seed);
      const links = new LinkSet(boardSize);
      const reference: Link[] = [];

      for (let step = 0; step < 120; step++) {
        const candidate = randomLink(boardSize, rand);
        if (!candidate) continue;
        const [a, b] = candidate;
        if (links.has(a, b)) continue;

        const indexed = links.crossesAny(a, b);
        const brute = bruteCrosses(boardSize, reference, a, b);
        expect(indexed).toBe(brute);
        checks++;
        if (brute) crossingsSeen++;

        // Only non-crossing links get added, mirroring how the engine builds
        // up a real position.
        if (!brute) {
          links.add(a, b);
          reference.push({ a: Math.min(a, b), b: Math.max(a, b) });
        }
      }
    }

    expect(checks).toBeGreaterThan(500);
    // Guard against a vacuous pass: if nothing ever crossed, the agreement
    // above would prove nothing.
    expect(crossingsSeen).toBeGreaterThan(50);
  });
});

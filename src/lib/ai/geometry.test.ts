import { describe, expect, it } from 'vitest';

import { DARK, LIGHT, colOf, isHole, knightNeighbors, rowOf } from '../engine/board';
import { segmentsProperlyIntersect } from '../engine/crossing';
import { geometryFor, oppositeDir } from './geometry';

const SIZES = [8, 12, 24];

describe('lane indexing', () => {
  it.each(SIZES)('gives both endpoints the same lane on a %ix board', (size) => {
    const geo = geometryFor(size);

    for (let cell = 0; cell < geo.cells; cell++) {
      for (let dir = 0; dir < 8; dir++) {
        const lane = geo.laneOf[cell * 8 + dir];
        const other = geo.nbrOf[cell * 8 + dir];
        if (other < 0) {
          expect(lane).toBe(-1);
          continue;
        }
        expect(lane).toBeGreaterThanOrEqual(0);
        // The same physical lane, whichever end you stand on.
        expect(geo.laneOf[other * 8 + oppositeDir(dir)]).toBe(lane);
        expect(new Set([geo.laneA[lane], geo.laneB[lane]])).toEqual(new Set([cell, other]));
      }
    }
  });

  it.each(SIZES)('covers exactly the knight moves between holes on a %ix board', (size) => {
    const geo = geometryFor(size);
    let expected = 0;
    for (let cell = 0; cell < size * size; cell++) {
      if (!isHole(size, rowOf(size, cell), colOf(size, cell))) continue;
      expected += knightNeighbors(size, cell).length;
    }
    expect(geo.laneCount * 2).toBe(expected);
  });
});

describe('the cross table', () => {
  /**
   * The whole search rests on this table standing in for `LinkSet.crossesAny`,
   * so it is checked against the rules engine's own predicate over every pair
   * of lanes rather than sampled.
   */
  it.each(SIZES)('agrees with a brute-force scan on a %ix board', (size) => {
    const geo = geometryFor(size);

    const x = (cell: number): number => colOf(size, cell);
    const y = (cell: number): number => rowOf(size, cell);

    for (let lane = 0; lane < geo.laneCount; lane++) {
      const brute = new Set<number>();
      for (let other = 0; other < geo.laneCount; other++) {
        if (other === lane) continue;
        if (
          segmentsProperlyIntersect(
            x(geo.laneA[lane]), y(geo.laneA[lane]),
            x(geo.laneB[lane]), y(geo.laneB[lane]),
            x(geo.laneA[other]), y(geo.laneA[other]),
            x(geo.laneB[other]), y(geo.laneB[other]),
          )
        ) {
          brute.add(other);
        }
      }

      const table = new Set(
        Array.from(geo.crossList.slice(geo.crossStart[lane], geo.crossStart[lane + 1])),
      );
      expect(table).toEqual(brute);
    }
  });

  it('is symmetric: crossing is a mutual relation', () => {
    const geo = geometryFor(12);
    for (let lane = 0; lane < geo.laneCount; lane++) {
      for (let i = geo.crossStart[lane]; i < geo.crossStart[lane + 1]; i++) {
        const other = geo.crossList[i];
        const back = geo.crossList.slice(geo.crossStart[other], geo.crossStart[other + 1]);
        expect(Array.from(back)).toContain(lane);
      }
    }
  });

  it('never lists lanes that merely share an endpoint', () => {
    const geo = geometryFor(12);
    for (let lane = 0; lane < geo.laneCount; lane++) {
      const ends = new Set([geo.laneA[lane], geo.laneB[lane]]);
      for (let i = geo.crossStart[lane]; i < geo.crossStart[lane + 1]; i++) {
        const other = geo.crossList[i];
        expect(ends.has(geo.laneA[other])).toBe(false);
        expect(ends.has(geo.laneB[other])).toBe(false);
      }
    }
  });
});

describe('placement tables', () => {
  it('bars each seat from the opponent border lines', () => {
    const size = 12;
    const geo = geometryFor(size);

    expect(geo.placeable[LIGHT][0 * size + 0]).toBe(0); // removed corner
    expect(geo.placeable[LIGHT][5 * size + 0]).toBe(0); // Black's left column
    expect(geo.placeable[LIGHT][5 * size + 5]).toBe(1);
    expect(geo.placeable[DARK][0 * size + 5]).toBe(0); // Red's top row
    expect(geo.placeable[DARK][5 * size + 0]).toBe(1);

    // Red connects top to bottom, Black left to right.
    expect(Array.from(geo.nearCells[LIGHT]).every((cell) => rowOf(size, cell) === 0)).toBe(true);
    expect(Array.from(geo.farCells[LIGHT]).every((cell) => rowOf(size, cell) === size - 1)).toBe(true);
    expect(Array.from(geo.nearCells[DARK]).every((cell) => colOf(size, cell) === 0)).toBe(true);
    expect(Array.from(geo.farCells[DARK]).every((cell) => colOf(size, cell) === size - 1)).toBe(true);
  });
});

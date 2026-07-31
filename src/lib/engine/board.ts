/**
 * Board geometry for TwixT.
 *
 * The board is an N×N grid of holes with the four corner holes removed.
 * Cells are addressed by a flat index `r * size + c` so they can be used as
 * plain numeric keys in maps and sets.
 *
 * Seats are named for the axis they connect:
 *   LIGHT owns the top and bottom rows and connects them (moves first).
 *   DARK owns the left and right columns and connects them.
 * A player may not place on their opponent's border lines, so LIGHT is barred
 * from columns 0 and N-1, and DARK is barred from rows 0 and N-1.
 */

export type Seat = 0 | 1;

export const LIGHT: Seat = 0;
export const DARK: Seat = 1;

export const EMPTY = -1;

export const BOARD_SIZES = [12, 18, 24, 30] as const;
export const DEFAULT_SIZE = 24;
export const MIN_SIZE = 8;
export const MAX_SIZE = 30;

export function otherSeat(seat: Seat): Seat {
  return seat === LIGHT ? DARK : LIGHT;
}

export function seatName(seat: Seat): string {
  return seat === LIGHT ? 'Red' : 'Black';
}

/**
 * The eight knight's-move offsets, in a fixed order.
 *
 * Auto-linking walks these in order, which makes its output deterministic and
 * therefore reproducible across peers.
 */
export const KNIGHT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-2, -1],
  [-2, 1],
  [-1, 2],
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
] as const;

export function idx(size: number, r: number, c: number): number {
  return r * size + c;
}

export function rowOf(size: number, cell: number): number {
  return Math.floor(cell / size);
}

export function colOf(size: number, cell: number): number {
  return cell % size;
}

export function inBounds(size: number, r: number, c: number): boolean {
  return r >= 0 && r < size && c >= 0 && c < size;
}

export function isCorner(size: number, r: number, c: number): boolean {
  return (r === 0 || r === size - 1) && (c === 0 || c === size - 1);
}

/** True if (r, c) is a real hole: on the board and not one of the removed corners. */
export function isHole(size: number, r: number, c: number): boolean {
  return inBounds(size, r, c) && !isCorner(size, r, c);
}

export function isHoleCell(size: number, cell: number): boolean {
  if (cell < 0 || cell >= size * size) return false;
  return isHole(size, rowOf(size, cell), colOf(size, cell));
}

/**
 * True if `seat` is allowed to place a peg at (r, c).
 *
 * The only restriction beyond "must be a hole" is that a player may not place
 * on their opponent's border lines.
 */
export function canPlaceAt(size: number, seat: Seat, r: number, c: number): boolean {
  if (!isHole(size, r, c)) return false;
  return seat === LIGHT ? c !== 0 && c !== size - 1 : r !== 0 && r !== size - 1;
}

export function canPlaceCell(size: number, seat: Seat, cell: number): boolean {
  if (cell < 0 || cell >= size * size) return false;
  return canPlaceAt(size, seat, rowOf(size, cell), colOf(size, cell));
}

/**
 * Which of a seat's two border lines (r, c) sits on, if any.
 * `near` is the top row / left column, `far` is the bottom row / right column.
 */
export function borderSide(
  size: number,
  seat: Seat,
  r: number,
  c: number,
): 'near' | 'far' | null {
  if (seat === LIGHT) {
    if (r === 0) return 'near';
    if (r === size - 1) return 'far';
  } else {
    if (c === 0) return 'near';
    if (c === size - 1) return 'far';
  }
  return null;
}

/**
 * A cell reflected across the main diagonal.
 *
 * Transposing exchanges the two seats' roles: LIGHT's top/bottom rows become
 * DARK's left/right columns, corners map to corners, and a cell legal for one
 * seat is always legal for the other. That is what lets the pie rule be a
 * reflection rather than a seat trade.
 */
export function reflectCell(size: number, cell: number): number {
  return idx(size, colOf(size, cell), rowOf(size, cell));
}

/** True if the two cells are exactly a knight's move apart. */
export function isKnightMove(size: number, a: number, b: number): boolean {
  const dr = Math.abs(rowOf(size, a) - rowOf(size, b));
  const dc = Math.abs(colOf(size, a) - colOf(size, b));
  return (dr === 1 && dc === 2) || (dr === 2 && dc === 1);
}

/** The cells a knight's move from `cell` that are real holes. */
export function knightNeighbors(size: number, cell: number): number[] {
  const r = rowOf(size, cell);
  const c = colOf(size, cell);
  const out: number[] = [];
  for (const [dr, dc] of KNIGHT_OFFSETS) {
    const nr = r + dr;
    const nc = c + dc;
    if (isHole(size, nr, nc)) out.push(idx(size, nr, nc));
  }
  return out;
}

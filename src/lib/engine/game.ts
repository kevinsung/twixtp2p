/**
 * TwixT rules engine.
 *
 * The central design decision: `GameState` is a pure fold over a list of moves.
 * Nothing mutates in place from the caller's perspective — `applyMove` returns a
 * fresh state. That single choice buys undo (truncate and replay), save/load
 * (serialise the list), move-list scrubbing (replay a prefix) and peer desync
 * detection (hash the folded state). Replay is cheap: a 24×24 board tops out
 * around 500 moves.
 */

import {
  DARK,
  EMPTY,
  KNIGHT_OFFSETS,
  LIGHT,
  MAX_SIZE,
  MIN_SIZE,
  type Seat,
  borderSide,
  canPlaceCell,
  colOf,
  idx,
  isHole,
  isHoleCell,
  isKnightMove,
  otherSeat,
  rowOf,
} from './board';
import { LinkSet } from './crossing';

/** Upper bound on link edits in one turn, so a hostile peer can't flood us. */
const MAX_LINK_OPS = 64;

export type Result =
  | { kind: 'win'; seat: Seat; by: 'connection' | 'resignation' }
  | { kind: 'draw' };

export interface LinkOp {
  /** true to create the link, false to remove it. */
  add: boolean;
  a: number;
  b: number;
}

export type GameMove =
  | { t: 'turn'; place: number; linkOps: LinkOp[] }
  | { t: 'swap' }
  | { t: 'resign'; seat: Seat }
  /** Draw by agreement. Both players must have consented before this is applied. */
  | { t: 'draw' };

export interface GameState {
  readonly size: number;
  readonly pegs: Int8Array;
  readonly links: LinkSet;
  readonly moves: GameMove[];
  readonly toMove: Seat;
  /** True once the pie rule has been exercised. Remaps players to seats. */
  readonly swapped: boolean;
  readonly result: Result | null;
  readonly lastPlace: number | null;
}

export type ApplyResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string };

export function createGame(size: number): GameState {
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) {
    throw new RangeError(`board size must be an integer in [${MIN_SIZE}, ${MAX_SIZE}]`);
  }
  const pegs = new Int8Array(size * size).fill(EMPTY);
  return {
    size,
    pegs,
    links: new LinkSet(size),
    moves: [],
    toMove: LIGHT,
    swapped: false,
    result: null,
    lastPlace: null,
  };
}

/**
 * Which seat a player sits in. Player 0 is whoever started as LIGHT; the pie
 * rule swaps the mapping without touching the board.
 */
export function seatOfPlayer(swapped: boolean, player: 0 | 1): Seat {
  return (swapped ? 1 - player : player) as Seat;
}

/** Inverse of `seatOfPlayer` — it is its own inverse. */
export function playerOfSeat(swapped: boolean, seat: Seat): 0 | 1 {
  return (swapped ? 1 - seat : seat) as 0 | 1;
}

export interface LinkCandidate {
  to: number;
  /** True if an existing link would be crossed, so this link cannot form. */
  blocked: boolean;
}

/**
 * Every knight's-move neighbour of `cell` holding a peg of `seat`, flagged with
 * whether a link there would be blocked by an existing link.
 *
 * Drives both auto-linking and the board's hover preview — showing which lanes
 * are already cut is most of what makes TwixT readable.
 */
export function linkCandidates(state: GameState, cell: number, seat: Seat): LinkCandidate[] {
  const { size, pegs, links } = state;
  const r = rowOf(size, cell);
  const c = colOf(size, cell);
  const out: LinkCandidate[] = [];

  for (const [dr, dc] of KNIGHT_OFFSETS) {
    const nr = r + dr;
    const nc = c + dc;
    if (!isHole(size, nr, nc)) continue;
    const to = idx(size, nr, nc);
    if (pegs[to] !== seat) continue;
    if (links.has(cell, to)) continue;
    out.push({ to, blocked: links.crossesAny(cell, to) });
  }

  return out;
}

/**
 * The links auto-linking would create for a peg of `seat` at `cell`.
 *
 * Order-independent: every candidate shares `cell` as an endpoint, so they can
 * never conflict with each other, and only pre-existing links can block. That
 * is what makes the result identical on both peers.
 */
export function autoLinkTargets(state: GameState, cell: number, seat: Seat): number[] {
  return linkCandidates(state, cell, seat)
    .filter((candidate) => !candidate.blocked)
    .map((candidate) => candidate.to);
}

function cloneState(state: GameState): {
  pegs: Int8Array;
  links: LinkSet;
  moves: GameMove[];
} {
  return {
    pegs: Int8Array.from(state.pegs),
    links: state.links.clone(),
    moves: [...state.moves],
  };
}

/**
 * True if `seat` has connected their two border lines.
 *
 * Breadth-first over the link graph from every peg on the seat's near border,
 * looking for one on the far border. The board is small enough that doing this
 * fresh each move is far simpler than maintaining an incremental structure —
 * and links can be removed, which union-find handles badly.
 */
export function checkConnection(
  size: number,
  pegs: Int8Array,
  links: LinkSet,
  seat: Seat,
): boolean {
  const queue: number[] = [];
  const seen = new Set<number>();

  const limit = size * size;
  for (let cell = 0; cell < limit; cell++) {
    if (pegs[cell] !== seat) continue;
    if (borderSide(size, seat, rowOf(size, cell), colOf(size, cell)) !== 'near') continue;
    queue.push(cell);
    seen.add(cell);
  }

  while (queue.length > 0) {
    const cell = queue.pop()!;
    if (borderSide(size, seat, rowOf(size, cell), colOf(size, cell)) === 'far') return true;
    for (const next of links.neighbors(cell)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return false;
}

/** True if `seat` has at least one legal placement left. */
export function hasLegalPlacement(state: GameState, seat: Seat): boolean {
  const { size, pegs } = state;
  const limit = size * size;
  for (let cell = 0; cell < limit; cell++) {
    if (pegs[cell] !== EMPTY) continue;
    if (canPlaceCell(size, seat, cell)) return true;
  }
  return false;
}

/** Why a placement is illegal, or null if it is fine. */
export function placementError(state: GameState, cell: number, seat: Seat): string | null {
  if (state.result) return 'the game is over';
  if (!isHoleCell(state.size, cell)) return 'not a hole on this board';
  if (state.pegs[cell] !== EMPTY) return 'that hole is already occupied';
  if (!canPlaceCell(state.size, seat, cell)) return "you may not place on your opponent's border line";
  return null;
}

function applyTurn(state: GameState, move: Extract<GameMove, { t: 'turn' }>): ApplyResult {
  const seat = state.toMove;

  const bad = placementError(state, move.place, seat);
  if (bad) return { ok: false, error: bad };

  if (move.linkOps.length > MAX_LINK_OPS) {
    return { ok: false, error: 'too many link edits in one turn' };
  }

  const { pegs, links, moves } = cloneState(state);
  pegs[move.place] = seat;

  for (const to of autoLinkTargets({ ...state, pegs, links }, move.place, seat)) {
    links.add(move.place, to);
  }

  // Link edits apply in order, each validated against the state the previous
  // ones produced — removing a blocker and then adding the link it blocked is a
  // normal and important sequence.
  for (const op of move.linkOps) {
    const { a, b } = op;
    if (!isHoleCell(state.size, a) || !isHoleCell(state.size, b)) {
      return { ok: false, error: 'link endpoint is not a hole' };
    }
    if (!isKnightMove(state.size, a, b)) {
      return { ok: false, error: 'links must span a knight\'s move' };
    }
    if (pegs[a] !== seat || pegs[b] !== seat) {
      return { ok: false, error: 'both ends of a link must be your own pegs' };
    }
    if (op.add) {
      if (links.has(a, b)) return { ok: false, error: 'that link already exists' };
      if (links.crossesAny(a, b)) return { ok: false, error: 'that link would cross another link' };
      links.add(a, b);
    } else {
      if (!links.has(a, b)) return { ok: false, error: 'no such link to remove' };
      links.remove(a, b);
    }
  }

  moves.push({ t: 'turn', place: move.place, linkOps: move.linkOps.map((op) => ({ ...op })) });

  let result: Result | null = null;
  if (checkConnection(state.size, pegs, links, seat)) {
    result = { kind: 'win', seat, by: 'connection' };
  }

  const next = otherSeat(seat);
  const nextState: GameState = {
    size: state.size,
    pegs,
    links,
    moves,
    toMove: next,
    swapped: state.swapped,
    result,
    lastPlace: move.place,
  };

  // A player with nowhere legal to place ends the game as a draw. In practice
  // this means the board has filled without either side connecting.
  if (!result && !hasLegalPlacement(nextState, next)) {
    return { ok: true, state: { ...nextState, result: { kind: 'draw' } } };
  }

  return { ok: true, state: nextState };
}

/** True if the pie rule is available right now. */
export function canSwap(state: GameState): boolean {
  return (
    state.result === null &&
    state.moves.length === 1 &&
    state.moves[0]!.t === 'turn' &&
    !state.swapped
  );
}

function applySwap(state: GameState): ApplyResult {
  if (!canSwap(state)) {
    return { ok: false, error: 'the swap is only available immediately after the first peg' };
  }
  // The board is untouched; only the players' seats trade. The second player
  // spends their turn on the swap, so it remains DARK to move — which is now
  // the player who opened the game.
  return {
    ok: true,
    state: { ...state, swapped: true, moves: [...state.moves, { t: 'swap' }] },
  };
}

function applyResign(state: GameState, move: Extract<GameMove, { t: 'resign' }>): ApplyResult {
  if (state.result) return { ok: false, error: 'the game is already over' };
  if (move.seat !== LIGHT && move.seat !== DARK) return { ok: false, error: 'unknown seat' };
  return {
    ok: true,
    state: {
      ...state,
      moves: [...state.moves, { t: 'resign', seat: move.seat }],
      result: { kind: 'win', seat: otherSeat(move.seat), by: 'resignation' },
    },
  };
}

function applyAgreedDraw(state: GameState): ApplyResult {
  if (state.result) return { ok: false, error: 'the game is already over' };
  return {
    ok: true,
    state: {
      ...state,
      moves: [...state.moves, { t: 'draw' }],
      result: { kind: 'draw' },
    },
  };
}

export function applyMove(state: GameState, move: GameMove): ApplyResult {
  switch (move.t) {
    case 'turn':
      return applyTurn(state, move);
    case 'swap':
      return applySwap(state);
    case 'resign':
      return applyResign(state, move);
    case 'draw':
      return applyAgreedDraw(state);
    default:
      return { ok: false, error: 'unknown move type' };
  }
}

/** Fold a move list into a state. Throws on an illegal list — callers validating
 * untrusted input should use `tryReplay`. */
export function replay(size: number, moves: readonly GameMove[]): GameState {
  const result = tryReplay(size, moves);
  if (!result.ok) throw new Error(`illegal move list: ${result.error}`);
  return result.state;
}

export function tryReplay(size: number, moves: readonly GameMove[]): ApplyResult {
  let state = createGame(size);
  for (let i = 0; i < moves.length; i++) {
    const step = applyMove(state, moves[i]!);
    if (!step.ok) return { ok: false, error: `move ${i + 1}: ${step.error}` };
    state = step.state;
  }
  return { ok: true, state };
}

/** Roll back to `ply` moves having been played. */
export function truncateTo(state: GameState, ply: number): GameState {
  const clamped = Math.max(0, Math.min(ply, state.moves.length));
  return replay(state.size, state.moves.slice(0, clamped));
}

/**
 * A 32-bit fingerprint of the visible game state.
 *
 * Piggybacked on every turn sent over the wire so peers notice divergence
 * immediately rather than drifting apart silently.
 */
export function stateHash(state: GameState): number {
  const parts: string[] = [
    String(state.size),
    String(state.toMove),
    state.swapped ? '1' : '0',
    state.result ? JSON.stringify(state.result) : '-',
  ];

  let pegRun = '';
  for (let i = 0; i < state.pegs.length; i++) pegRun += String(state.pegs[i] + 1);
  parts.push(pegRun);
  parts.push(state.links.sortedKeys().join(','));

  return fnv1a(parts.join('|'));
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

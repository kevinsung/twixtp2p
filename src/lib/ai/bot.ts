/**
 * The bot's decision, expressed as a `GameMove` the engine will accept.
 *
 * The input is a move list rather than a `GameState`, for two reasons. It
 * crosses a `postMessage` boundary without ceremony — a `LinkSet` is three
 * `Map`s and would need a custom serialiser — and replaying it through
 * `tryReplay` makes the rules engine, not the caller, the authority on what
 * position the bot is looking at. Replaying 500 moves costs a fraction of a
 * millisecond against a budget measured in seconds.
 *
 * The bot only ever emits `{ t: 'turn', place, linkOps: [] }`. Auto-linking is
 * modelled exactly by `SearchPosition`, so the links it wants are the links it
 * gets. Dropping an auto-link that blocks a better one of your own is a real
 * tactic, and one the bot does not know.
 */

import { type Seat, otherSeat } from '../engine/board';
import {
  applyMove,
  canSwap,
  tryReplay,
  type GameMove,
  type GameState,
} from '../engine/game';
import { openingMove } from './candidates';
import { geometryFor } from './geometry';
import { SearchPosition } from './position';
import { search, type SearchOptions } from './search';

export interface BotOptions {
  budgetMs?: number;
  maxDepth?: number;
  rng?: () => number;
  now?: () => number;
}

/** Depth used for the one-off swap decision, where a full budget is overkill. */
const SWAP_DEPTH = 2;
/**
 * How much better the swap must look before taking it. Hysteresis: the two
 * sides of the decision are within noise of each other by construction, and a
 * bot that swaps on noise looks like it is guessing.
 */
const SWAP_MARGIN = 6;

export function chooseMove(
  size: number,
  moves: readonly GameMove[],
  seat: Seat,
  opts: BotOptions = {},
): GameMove {
  const replayed = tryReplay(size, moves);
  if (!replayed.ok) throw new Error(`the bot was given an illegal game: ${replayed.error}`);

  const state = replayed.state;
  if (state.result) throw new Error('the game is over');
  if (state.toMove !== seat) throw new Error('it is not the bot to move');

  const rng = opts.rng ?? Math.random;

  if (canSwap(state) && wantsSwap(state, seat, opts)) return { t: 'swap' };

  // An empty board gives the search nothing to compare: every central peg
  // evaluates alike. Pick one at random instead, so games differ.
  if (state.moves.length === 0) {
    const cell = openingMove(geometryFor(size), seat, rng);
    if (cell >= 0) return { t: 'turn', place: cell, linkOps: [] };
  }

  const cell = best(state, seat, {
    budgetMs: opts.budgetMs,
    maxDepth: opts.maxDepth,
    rng,
    now: opts.now,
  });
  if (cell < 0) throw new Error('the bot found no legal placement');
  return { t: 'turn', place: cell, linkOps: [] };
}

function best(state: GameState, seat: Seat, opts: SearchOptions): number {
  const pos = SearchPosition.fromState(state);
  return search(pos, seat, state.lastPlace ?? -1, opts).cell;
}

/**
 * Should the bot take the pie rule?
 *
 * The swap reflects the opening peg across the main diagonal and hands it to
 * Black, leaving Red to move. So the choice is between two concrete positions,
 * and the honest way to compare them is to search both: what the position is
 * worth to us as it stands, against what it is worth to us after swapping —
 * which is what the opponent's best reply leaves, negated.
 */
function wantsSwap(state: GameState, seat: Seat, opts: BotOptions): boolean {
  const shared: SearchOptions = {
    budgetMs: opts.budgetMs,
    maxDepth: SWAP_DEPTH,
    rng: opts.rng,
    now: opts.now,
    jitter: 0,
  };

  const asIs = search(SearchPosition.fromState(state), seat, state.lastPlace ?? -1, shared);

  const swapped = applyMove(state, { t: 'swap' });
  if (!swapped.ok) return false;
  const after = swapped.state;
  const reply = search(
    SearchPosition.fromState(after),
    otherSeat(seat),
    after.lastPlace ?? -1,
    shared,
  );

  return -reply.score > asIs.score + SWAP_MARGIN;
}

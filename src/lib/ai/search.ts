/**
 * Iterative-deepening alpha-beta over the narrowed candidate set.
 *
 * Nothing exotic: negamax, a transposition table on the incremental Zobrist
 * key, killer moves, and a clock. The strength comes from the two pieces below
 * it — a connection metric sharp enough that a one-peg difference means
 * something, and a candidate filter that keeps the branching factor near 16 on
 * a board offering 570 legal moves.
 *
 * What that buys, honestly: four plies in a second and a half on a 24×24
 * middlegame, five or more where the position is forcing or the board still
 * sparse. Enough to see an immediate win, block one, follow a short forcing
 * sequence and set up a simple double threat. Not enough for deep ladder
 * tactics, and no substitute for the positional judgement a strong human
 * brings. A solid club opponent.
 */

import { type Seat, otherSeat } from '../engine/board';
import { CandidateBuffer, generateCandidates } from './candidates';
import { EvalScratch, evaluate } from './eval';
import type { SearchPosition } from './position';

/** A win, discounted by ply so the search prefers to win sooner. */
export const MATE = 1_000_000;

/** Candidates considered at the root, and at every deeper ply. */
const ROOT_WIDTH = 24;
const INNER_WIDTH = 16;
const MAX_PLY = 32;

/** Nodes between clock checks: invisible in cost, tight enough to stop on time. */
const CLOCK_INTERVAL = 512;

const EXACT = 0;
const LOWER = 1;
const UPPER = 2;

interface Entry {
  depth: number;
  score: number;
  flag: number;
  move: number;
}

export interface SearchOptions {
  /** Wall-clock budget in milliseconds. Depth 1 always completes regardless. */
  budgetMs?: number;
  maxDepth?: number;
  /** Randomness for choosing between root moves the search rates equal. */
  rng?: () => number;
  /** Injectable clock, so tests need not depend on real time. */
  now?: () => number;
  /** Root moves within this many points of the best count as equal. */
  jitter?: number;
}

export interface SearchResult {
  /** The chosen placement, or -1 if the position offers none. */
  cell: number;
  score: number;
  /** The deepest ply fully searched. */
  depth: number;
  nodes: number;
}

const defaultNow: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

class Searcher {
  private readonly scratch: EvalScratch;
  private readonly buffers: CandidateBuffer[] = [];
  private readonly order: Int32Array[] = [];
  private readonly table = new Map<number, Entry>();
  private readonly killers = new Int32Array(MAX_PLY * 2).fill(-1);

  /** Root moves from the last completed iteration, with their scores. */
  private rootCells: number[] = [];
  private rootScores: number[] = [];
  /** True where the score is a real value rather than a fail-low bound. */
  private rootExact: boolean[] = [];

  private deadline = Infinity;
  private aborted = false;
  private guarded = false;
  nodes = 0;

  constructor(
    private readonly pos: SearchPosition,
    private readonly now: () => number,
  ) {
    this.scratch = new EvalScratch(pos.geo);
  }

  private buffer(ply: number): CandidateBuffer {
    let buf = this.buffers[ply];
    if (!buf) {
      buf = new CandidateBuffer(ply === 0 ? ROOT_WIDTH : INNER_WIDTH);
      this.buffers[ply] = buf;
      this.order[ply] = new Int32Array(buf.capacity);
    }
    return buf;
  }

  private outOfTime(): boolean {
    this.nodes += 1;
    if (!this.guarded) return false;
    if ((this.nodes & (CLOCK_INTERVAL - 1)) !== 0) return this.aborted;
    if (this.now() >= this.deadline) this.aborted = true;
    return this.aborted;
  }

  search(seat: Seat, lastPlace: number, opts: SearchOptions): SearchResult {
    const budget = opts.budgetMs ?? 1500;
    const maxDepth = opts.maxDepth ?? MAX_PLY - 2;
    const rng = opts.rng ?? Math.random;
    const jitter = opts.jitter ?? 8;
    const start = this.now();

    let best: SearchResult = { cell: -1, score: 0, depth: 0, nodes: 0 };

    for (let depth = 1; depth <= maxDepth; depth++) {
      // Depth 1 runs unguarded: however tight the budget, the bot has to come
      // back with a move it has actually looked at.
      this.guarded = depth > 1;
      this.deadline = start + budget;
      this.aborted = false;

      const score = this.root(seat, lastPlace, depth);
      if (this.aborted) break;

      best = { cell: this.pickRoot(rng, jitter), score, depth, nodes: this.nodes };

      // A forced win or loss will not read differently deeper.
      if (Math.abs(score) >= MATE - MAX_PLY) break;
      if (this.rootCells.length <= 1) break;
      if (this.now() >= start + budget) break;
    }

    return best;
  }

  /**
   * The best root move, chosen at random among those the search rates equal.
   *
   * Only moves that raised alpha have exact scores; the rest returned upper
   * bounds and might be far worse than they look, so they never enter the draw
   * however close their bound came.
   */
  private pickRoot(rng: () => number, jitter: number): number {
    if (this.rootCells.length === 0) return -1;

    let top = -Infinity;
    for (let i = 0; i < this.rootCells.length; i++) {
      if (this.rootExact[i] && this.rootScores[i]! > top) top = this.rootScores[i]!;
    }

    const ties: number[] = [];
    for (let i = 0; i < this.rootCells.length; i++) {
      if (this.rootExact[i] && this.rootScores[i]! >= top - jitter) ties.push(this.rootCells[i]!);
    }
    if (ties.length === 0) return this.rootCells[0]!;
    return ties[Math.min(ties.length - 1, Math.floor(rng() * ties.length))]!;
  }

  private root(seat: Seat, lastPlace: number, depth: number): number {
    const buf = this.buffer(0);
    generateCandidates(this.pos, seat, lastPlace, this.scratch, buf);
    if (buf.count === 0) {
      this.rootCells = [];
      this.rootScores = [];
      this.rootExact = [];
      return 0;
    }

    const count = this.orderMoves(buf, 0, this.previousBest());
    const moves = this.order[0]!;

    const cells: number[] = [];
    const scores: number[] = [];
    const exact: boolean[] = [];

    let alpha = -Infinity;
    let bestScore = -Infinity;

    for (let i = 0; i < count; i++) {
      const cell = moves[i]!;
      const score = this.child(cell, seat, depth, 0, -Infinity, -alpha);
      if (this.aborted) return bestScore;
      cells.push(cell);
      scores.push(score);
      exact.push(score > alpha || i === 0);
      if (score > bestScore) bestScore = score;
      if (score > alpha) alpha = score;
    }

    this.rootCells = cells;
    this.rootScores = scores;
    this.rootExact = exact;
    return bestScore;
  }

  /** The move the previous iteration liked, to try first this time. */
  private previousBest(): number {
    let bestAt = -1;
    for (let i = 0; i < this.rootCells.length; i++) {
      if (!this.rootExact[i]) continue;
      if (bestAt < 0 || this.rootScores[i]! > this.rootScores[bestAt]!) bestAt = i;
    }
    return bestAt < 0 ? -1 : this.rootCells[bestAt]!;
  }

  /** Make the move, score the reply, unmake. */
  private child(
    cell: number,
    seat: Seat,
    depth: number,
    ply: number,
    alpha: number,
    beta: number,
  ): number {
    const undo = this.pos.place(cell, seat);
    let score: number;
    if (this.pos.connected(seat)) {
      score = MATE - ply - 1;
    } else {
      score = -this.negamax(otherSeat(seat), depth - 1, ply + 1, alpha, beta);
    }
    this.pos.unplace(undo);
    return score;
  }

  private negamax(seat: Seat, depth: number, ply: number, alpha: number, beta: number): number {
    if (this.outOfTime()) return 0;

    const key = this.pos.hash * 2 + seat;
    const hit = this.table.get(key);
    let ttMove = -1;
    if (hit) {
      ttMove = hit.move;
      if (hit.depth >= depth) {
        if (hit.flag === EXACT) return hit.score;
        if (hit.flag === LOWER && hit.score > alpha) alpha = hit.score;
        else if (hit.flag === UPPER && hit.score < beta) beta = hit.score;
        if (alpha >= beta) return hit.score;
      }
    }

    if (depth <= 0 || ply >= MAX_PLY - 1) return evaluate(this.pos, seat, this.scratch);

    const buf = this.buffer(ply);
    generateCandidates(this.pos, seat, -1, this.scratch, buf);
    // Nowhere legal to place ends the game as a draw, exactly as the engine says.
    if (buf.count === 0) return 0;

    const count = this.orderMoves(buf, ply, ttMove);
    const moves = this.order[ply]!;
    const alphaIn = alpha;
    let bestScore = -Infinity;
    let bestMove = -1;

    for (let i = 0; i < count; i++) {
      const cell = moves[i]!;
      const score = this.child(cell, seat, depth, ply, -beta, -alpha);
      if (this.aborted) return bestScore === -Infinity ? 0 : bestScore;
      if (score > bestScore) {
        bestScore = score;
        bestMove = cell;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        this.remember(ply, cell);
        break;
      }
    }

    const flag = bestScore <= alphaIn ? UPPER : bestScore >= beta ? LOWER : EXACT;
    this.table.set(key, { depth, score: bestScore, flag, move: bestMove });
    return bestScore;
  }

  /** Killers are moves that caused a cutoff at this ply in another line. */
  private remember(ply: number, cell: number): void {
    const at = ply * 2;
    if (this.killers[at] === cell) return;
    this.killers[at + 1] = this.killers[at];
    this.killers[at] = cell;
  }

  /**
   * Write the candidates into this ply's order buffer: the table's move first,
   * then the killers, then the generator's own ranking.
   */
  private orderMoves(buf: CandidateBuffer, ply: number, ttMove: number): number {
    const out = this.order[ply]!;
    const killer0 = this.killers[ply * 2]!;
    const killer1 = this.killers[ply * 2 + 1]!;
    let count = 0;

    const lift = (cell: number): void => {
      if (cell < 0) return;
      for (let i = 0; i < buf.count; i++) {
        if (buf.cells[i] === cell) {
          out[count++] = cell;
          return;
        }
      }
    };

    lift(ttMove);
    if (killer0 !== ttMove) lift(killer0);
    if (killer1 !== ttMove && killer1 !== killer0) lift(killer1);

    for (let i = 0; i < buf.count; i++) {
      const cell = buf.cells[i]!;
      if (cell === ttMove || cell === killer0 || cell === killer1) continue;
      out[count++] = cell;
    }

    return count;
  }
}

/**
 * Choose a placement for `seat`.
 *
 * `lastPlace` only nudges move ordering, so passing -1 is always safe.
 */
export function search(
  pos: SearchPosition,
  seat: Seat,
  lastPlace: number,
  opts: SearchOptions = {},
): SearchResult {
  const searcher = new Searcher(pos, opts.now ?? defaultNow);
  return searcher.search(seat, lastPlace, opts);
}

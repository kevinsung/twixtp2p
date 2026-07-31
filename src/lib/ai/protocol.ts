/** The message shapes exchanged with the search worker. */

import type { Seat } from '../engine/board';
import type { GameMove } from '../engine/game';

export interface ThinkRequest {
  size: number;
  /** The whole game so far. `tryReplay` in the worker is the trust boundary. */
  moves: GameMove[];
  seat: Seat;
  budgetMs: number;
}

export interface WorkerRequest extends ThinkRequest {
  id: number;
}

export type WorkerReply =
  | { id: number; move: GameMove }
  | { id: number; error: string };

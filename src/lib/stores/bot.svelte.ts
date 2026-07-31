/**
 * Drives a computer opponent against a `GameController`.
 *
 * The controller already had the shape this needs. Hot-seat play is `mySeat ===
 * null`, so giving the human a seat makes the board go quiet on the bot's turn
 * with no new plumbing. And `applyRemote` is precisely "a move arrived from
 * somewhere else: check it against our position and do not echo it back" —
 * which is what a bot's move is. Committing through it leaves `onCommit` free
 * for a peer session, and means the bot can never announce its own move to
 * itself.
 */

import type { Seat } from '../engine/board';
import type { GameMove, GameState } from '../engine/game';
import { BotCancelled, BotEngine } from '../ai/client';
import { botConfig } from '../ai/config';
import type { GameController } from './game.svelte';

export class BotController {
  /** True while a search is in flight, for the sidebar to show. */
  thinking = $state(false);
  /** Which seat the computer plays, or null when it is not attached. */
  seat = $state.raw<Seat | null>(null);
  /** Surfaced if the search itself fails, rather than swallowed. */
  error = $state<string | null>(null);

  private engine = new BotEngine();
  private game: GameController | null = null;
  /** Bumped whenever the position moves under us, so stale replies are dropped. */
  private token = 0;
  /** The committed state a search was last started for. */
  private considered: GameState | null = null;

  attach(game: GameController, seat: Seat): void {
    this.detach();
    this.game = game;
    this.seat = seat;
    this.error = null;
  }

  detach(): void {
    this.token += 1;
    this.thinking = false;
    this.considered = null;
    this.seat = null;
    this.game = null;
    this.error = null;
    this.engine.cancel();
    this.engine.terminate();
  }

  /**
   * Think if it is the computer's turn in this position.
   *
   * Idempotent by position identity: `committed` is replaced on every change,
   * so the same state object never starts a second search. That lets the app
   * call this from a single effect and have it cover the opening move, every
   * reply, and every takeback.
   */
  consider(state: GameState): void {
    const game = this.game;
    const seat = this.seat;
    if (!game || seat === null) return;
    if (state !== game.committed) return;
    if (state === this.considered) return;

    // The position changed, so whatever is in flight is about a board that no
    // longer exists.
    this.token += 1;
    this.considered = state;

    if (state.result || state.toMove !== seat) {
      this.thinking = false;
      this.engine.cancel();
      return;
    }

    const token = this.token;
    this.thinking = true;
    this.error = null;

    void this.engine
      .think({
        size: state.size,
        moves: state.moves.map(copyMove),
        seat,
        budgetMs: botConfig.budgetMs,
      })
      .then((move) => {
        if (token !== this.token) return;
        this.thinking = false;
        const applied = game.applyRemote(move);
        if (!applied.ok) this.error = `The computer suggested an illegal move: ${applied.error}.`;
      })
      .catch((error: unknown) => {
        if (token !== this.token || error instanceof BotCancelled) return;
        this.thinking = false;
        this.error = error instanceof Error ? error.message : 'The computer failed to move.';
      });
  }

  /**
   * Take back to the last position where the human is on move.
   *
   * Usually two plies, but the count is re-checked each step rather than
   * assumed: whose turn it is after a rewind depends on the move types in the
   * list, and only the engine knows that.
   */
  undo(): void {
    const game = this.game;
    const seat = this.seat;
    if (!game || seat === null) return;

    if (game.pending) {
      game.cancel();
      return;
    }

    this.token += 1;
    this.thinking = false;
    this.considered = null;
    this.engine.cancel();

    let ply = game.committed.moves.length;
    while (ply > 0) {
      ply -= 1;
      game.rewindTo(ply);
      if (!game.committed.result && game.committed.toMove !== seat) break;
    }
  }
}

/** Moves cross a `postMessage` boundary, so hand over plain data. */
function copyMove(move: GameMove): GameMove {
  if (move.t !== 'turn') return { ...move };
  return { t: 'turn', place: move.place, linkOps: move.linkOps.map((op) => ({ ...op })) };
}

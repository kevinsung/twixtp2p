/**
 * Reactive wrapper around the rules engine.
 *
 * A turn is built up in two stages. `committed` holds the agreed position;
 * `pending` holds the placement the local player is currently composing plus any
 * link edits. The board renders `view`, which is simply the pending turn applied
 * to the committed state — so provisional display reuses the engine rather than
 * duplicating its logic in the UI.
 *
 * The controller knows nothing about networking. `control` says which seats this
 * client may move for, and `onCommit` fires whenever a move is agreed locally so
 * a session can broadcast it.
 */

import { DEFAULT_SIZE, type Seat } from '../engine/board';
import {
  applyMove,
  canSwap,
  createGame,
  placementError,
  replay,
  seatOfPlayer,
  truncateTo,
  type GameMove,
  type GameState,
  type LinkOp,
} from '../engine/game';

export type SeatControl = 'both' | Seat;

interface PendingTurn {
  place: number;
  linkOps: LinkOp[];
}

export class GameController {
  committed = $state.raw<GameState>(createGame(DEFAULT_SIZE));
  pending = $state.raw<PendingTurn | null>(null);
  /** Transient explanation of the last rejected action. */
  message = $state<string | null>(null);

  /**
   * Which player this client is, or null for local play where it moves both.
   *
   * Deliberately a *player* rather than a seat: the pie rule trades seats
   * mid-game, so a fixed seat would leave both sides controlling the wrong
   * colour after a swap.
   */
  myPlayer = $state.raw<0 | 1 | null>(null);

  /** Seats this client may move for, following the players through a swap. */
  control = $derived<SeatControl>(
    this.myPlayer === null ? 'both' : seatOfPlayer(this.committed.swapped, this.myPlayer),
  );

  /** Commit immediately on placement instead of waiting for confirmation. */
  skipConfirmation = $state(false);

  /** Fired when a move is agreed locally, for a session to send onward. */
  onCommit: ((move: GameMove) => void) | null = null;

  /** The position as it should be drawn, including any uncommitted turn. */
  view = $derived.by<GameState>(() => {
    const pending = this.pending;
    if (!pending) return this.committed;
    const trial = applyMove(this.committed, {
      t: 'turn',
      place: pending.place,
      linkOps: pending.linkOps,
    });
    return trial.ok ? trial.state : this.committed;
  });

  get size(): number {
    return this.committed.size;
  }

  /** True if this client is allowed to act for the side to move. */
  isMyTurn = $derived.by(() => {
    if (this.committed.result) return false;
    return this.control === 'both' || this.control === this.committed.toMove;
  });

  canSwapNow = $derived.by(
    () => canSwap(this.committed) && this.pending === null && this.isMyTurn,
  );

  reset(size: number): void {
    this.committed = createGame(size);
    this.pending = null;
    this.message = null;
  }

  /** Replace the whole game, e.g. from a save file or a peer resync. */
  loadMoves(size: number, moves: readonly GameMove[]): void {
    this.committed = replay(size, moves);
    this.pending = null;
    this.message = null;
  }

  /**
   * Handle a click on a hole. Clicking the pending peg confirms the turn;
   * clicking elsewhere moves it.
   */
  clickCell(cell: number): void {
    if (!this.isMyTurn) return;

    if (this.pending && this.pending.place === cell) {
      this.confirm();
      return;
    }

    const seat = this.committed.toMove;
    const bad = placementError(this.committed, cell, seat);
    if (bad) {
      this.message = bad;
      return;
    }

    this.pending = { place: cell, linkOps: [] };
    this.message = null;

    if (this.skipConfirmation) this.confirm();
  }

  /**
   * Add or remove a link as part of the turn being composed.
   *
   * Every toggle is validated by running the whole turn through the engine, so
   * the pending state can never drift into something illegal — removing a
   * blocker and then adding the link it blocked stays consistent.
   */
  toggleLink(a: number, b: number): void {
    const pending = this.pending;
    if (!pending || !this.isMyTurn) return;

    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const existing = pending.linkOps.findIndex((op) => op.a === lo && op.b === hi);

    const linkOps =
      existing >= 0
        ? pending.linkOps.filter((_, i) => i !== existing)
        : [...pending.linkOps, { add: !this.view.links.has(lo, hi), a: lo, b: hi }];

    const trial = applyMove(this.committed, { t: 'turn', place: pending.place, linkOps });
    if (!trial.ok) {
      this.message = trial.error;
      return;
    }

    this.pending = { place: pending.place, linkOps };
    this.message = null;
  }

  confirm(): void {
    const pending = this.pending;
    if (!pending) return;
    this.commit({ t: 'turn', place: pending.place, linkOps: pending.linkOps });
  }

  cancel(): void {
    this.pending = null;
    this.message = null;
  }

  swap(): void {
    if (!this.canSwapNow) return;
    this.commit({ t: 'swap' });
  }

  resign(seat: Seat): void {
    if (this.committed.result) return;
    this.commit({ t: 'resign', seat });
  }

  /** Apply a locally-decided move and notify any listener. */
  private commit(move: GameMove): void {
    const result = applyMove(this.committed, move);
    if (!result.ok) {
      this.message = result.error;
      return;
    }
    this.committed = result.state;
    this.pending = null;
    this.message = null;
    this.onCommit?.(move);
  }

  /**
   * Apply a move that arrived from a peer.
   *
   * Returns false if the move is illegal in our position — the caller surfaces
   * that rather than trusting the sender.
   */
  applyRemote(move: GameMove): { ok: true } | { ok: false; error: string } {
    const result = applyMove(this.committed, move);
    if (!result.ok) return { ok: false, error: result.error };
    this.committed = result.state;
    this.pending = null;
    return { ok: true };
  }

  /** Agree a draw. Both players must already have consented. */
  agreeDraw(): void {
    if (this.committed.result) return;
    this.commit({ t: 'draw' });
  }

  /** Roll the game back to a given number of moves played. */
  rewindTo(ply: number): void {
    this.committed = truncateTo(this.committed, ply);
    this.pending = null;
    this.message = null;
  }

  /** Undo in local play: step back one move. */
  undoLocal(): void {
    if (this.pending) {
      this.cancel();
      return;
    }
    if (this.committed.moves.length === 0) return;
    this.rewindTo(this.committed.moves.length - 1);
  }
}

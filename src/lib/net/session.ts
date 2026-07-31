/**
 * Ties the rules engine to a peer connection.
 *
 * Deliberately free of both networking and UI framework code: it talks to a
 * minimal `Transport` (which the relay and manual handshakes both implement)
 * and to a `GameHost` (which `GameController` satisfies). That keeps the whole
 * negotiation — handshake, move exchange, takebacks, draws, resync — testable
 * over an in-memory loopback with no browser and no network involved.
 *
 * There is no server refereeing the game, so this layer treats the peer as
 * untrusted: every inbound move must be structurally valid, arrive in the right
 * order, come from the player whose turn it is, and be legal in our own copy of
 * the position. A move failing any of those is reported, never applied.
 */

import { otherSeat, type Seat } from '../engine/board';
import type { GameMove, GameState } from '../engine/game';
import { stateHash } from '../engine/game';
import { PROTOCOL_VERSION, decode, encode, isPrefixOf, type Message } from './protocol';

export interface Transport {
  send(data: string): void;
  close(): void;
  onMessage: ((data: string) => void) | null;
  onOpen: (() => void) | null;
  onClose: ((reason?: string) => void) | null;
  /**
   * Called once the session has wired up its handlers.
   *
   * A transport may connect before a session exists to listen to it — the peer
   * can arrive during the `await` that builds the transport. Transports hold
   * back the open notification until this runs, so it is never delivered to a
   * handler that is not attached yet.
   */
  start?(): void;
}

/** The part of the game controller a session needs. */
export interface GameHost {
  readonly committed: GameState;
  mySeat: Seat | null;
  onCommit: ((move: GameMove) => void) | null;
  loadMoves(size: number, moves: readonly GameMove[]): void;
  applyRemote(move: GameMove): { ok: true } | { ok: false; error: string };
  rewindTo(ply: number): void;
}

export type SessionStatus = 'connecting' | 'handshaking' | 'ready' | 'closed';

export interface SessionOptions {
  isHost: boolean;
  name: string;
  /** Host only — the guest adopts these from the handshake. */
  size: number;
  hostSeat: Seat;
  pingIntervalMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface SessionView {
  status: SessionStatus;
  opponentName: string;
  latencyMs: number | null;
  /** Fatal protocol or connection problem, shown to the user. */
  error: string | null;
  /** A takeback the peer has asked for, awaiting our answer. */
  undoRequest: number | null;
  awaitingUndoReply: boolean;
  drawOffered: boolean;
  awaitingDrawReply: boolean;
  /**
   * Set when the peer's history cannot be reconciled with ours automatically.
   * Someone has to yield, so the choice goes to the user.
   */
  desync: { size: number; moves: GameMove[] } | null;
}

export class Session {
  private readonly game: GameHost;
  private readonly transport: Transport;
  private readonly options: Required<
    Pick<SessionOptions, 'isHost' | 'name' | 'hostSeat' | 'pingIntervalMs'>
  > & { now: () => number };
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private size: number;
  private pingHandle: unknown = null;
  private weOfferedDraw = false;

  view: SessionView = {
    status: 'connecting',
    opponentName: '',
    latencyMs: null,
    error: null,
    undoRequest: null,
    awaitingUndoReply: false,
    drawOffered: false,
    awaitingDrawReply: false,
    desync: null,
  };

  /** Fired whenever `view` changes, so a UI layer can re-render. */
  onUpdate: (() => void) | null = null;

  constructor(game: GameHost, transport: Transport, options: SessionOptions) {
    this.game = game;
    this.transport = transport;
    this.size = options.size;
    this.options = {
      isHost: options.isHost,
      name: options.name,
      hostSeat: options.hostSeat,
      pingIntervalMs: options.pingIntervalMs ?? 5000,
      now: options.now ?? Date.now,
    };
    this.setIntervalFn =
      options.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms) as unknown);
    this.clearIntervalFn =
      options.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

    transport.onOpen = () => this.handleOpen();
    transport.onMessage = (raw) => this.handleMessage(raw);
    transport.onClose = (reason) => this.handleClose(reason);

    // Broadcast our own moves. `applyRemote` does not fire this, so moves that
    // arrived from the peer are never echoed back.
    game.onCommit = (move) => this.sendOwnMove(move);

    transport.start?.();
  }

  private patch(changes: Partial<SessionView>): void {
    this.view = { ...this.view, ...changes };
    this.onUpdate?.();
  }

  private send(message: Message): void {
    try {
      this.transport.send(encode(message));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'could not send to the opponent');
    }
  }

  private fail(error: string): void {
    this.patch({ error });
  }

  private handleOpen(): void {
    this.patch({ status: 'handshaking' });
    if (this.options.isHost) {
      this.game.mySeat = this.options.hostSeat;
      this.send({
        t: 'hello',
        v: PROTOCOL_VERSION,
        size: this.size,
        yourSeat: otherSeat(this.options.hostSeat),
        name: this.options.name,
        moves: [...this.game.committed.moves],
      });
    }
  }

  private handleClose(reason?: string): void {
    this.stopPings();
    this.patch({ status: 'closed', error: this.view.error ?? reason ?? null });
  }

  private startPings(): void {
    if (this.pingHandle !== null) return;
    this.pingHandle = this.setIntervalFn(() => {
      this.send({ t: 'ping', id: this.options.now() });
    }, this.options.pingIntervalMs);
  }

  private stopPings(): void {
    if (this.pingHandle === null) return;
    this.clearIntervalFn(this.pingHandle);
    this.pingHandle = null;
  }

  private get remoteSeat(): Seat {
    const mine = this.game.mySeat;
    return mine === null ? 1 : otherSeat(mine);
  }

  private sendOwnMove(move: GameMove): void {
    if (this.view.status !== 'ready') return;
    const ply = this.game.committed.moves.length - 1;
    this.send({ t: 'move', ply, move, hash: stateHash(this.game.committed) });
  }

  private handleMessage(raw: string): void {
    const message = decode(raw, this.size);
    if (!message) {
      this.fail('The opponent sent something this version cannot read.');
      return;
    }

    switch (message.t) {
      case 'hello':
        this.handleHello(message);
        break;
      case 'hi':
        this.handleHi(message);
        break;
      case 'move':
        this.handleMove(message);
        break;
      case 'undoRequest':
        this.patch({ undoRequest: message.toPly });
        break;
      case 'undoResponse':
        this.patch({ awaitingUndoReply: false });
        if (message.accept) this.game.rewindTo(message.toPly);
        break;
      case 'drawOffer':
        this.patch({ drawOffered: true });
        break;
      case 'drawResponse':
        this.patch({ awaitingDrawReply: false });
        if (message.accept && this.weOfferedDraw) {
          this.weOfferedDraw = false;
          this.game.applyRemote({ t: 'draw' });
        }
        break;
      case 'stateDump':
        this.handleStateDump(message);
        break;
      case 'ping':
        this.send({ t: 'pong', id: message.id });
        break;
      case 'pong':
        this.patch({ latencyMs: Math.max(0, this.options.now() - message.id) });
        break;
    }
  }

  private handleHello(message: Extract<Message, { t: 'hello' }>): void {
    if (this.options.isHost) {
      this.fail('Both peers tried to host this game.');
      return;
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.fail(
        `The opponent is running a different version of the game (protocol ${message.v}, expected ${PROTOCOL_VERSION}).`,
      );
      return;
    }

    this.size = message.size;
    this.game.mySeat = message.yourSeat;

    if (this.game.committed.moves.length === 0) {
      // Fresh guest: take the host's parameters wholesale. This is also what
      // adopts the host's board size, which must happen even when there is no
      // history to copy.
      try {
        this.game.loadMoves(message.size, message.moves);
      } catch (error) {
        this.fail(
          error instanceof Error ? error.message : "The opponent's game is not a legal position.",
        );
        return;
      }
    } else if (!this.reconcile(message.size, message.moves)) {
      return;
    }

    this.send({
      t: 'hi',
      v: PROTOCOL_VERSION,
      name: this.options.name,
      moves: [...this.game.committed.moves],
    });
    this.patch({ status: 'ready', opponentName: message.name });
    this.startPings();
  }

  private handleHi(message: Extract<Message, { t: 'hi' }>): void {
    if (!this.options.isHost) {
      this.fail('The opponent answered a handshake we did not send.');
      return;
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.fail(
        `The opponent is running a different version of the game (protocol ${message.v}, expected ${PROTOCOL_VERSION}).`,
      );
      return;
    }

    if (!this.reconcile(this.size, message.moves)) return;

    // If we hold history the guest lacks, bring them up to date.
    if (this.game.committed.moves.length > message.moves.length) {
      this.send({
        t: 'stateDump',
        size: this.size,
        moves: [...this.game.committed.moves],
      });
    }

    this.patch({ status: 'ready', opponentName: message.name });
    this.startPings();
  }

  /**
   * Merge the peer's history with ours on connect.
   *
   * Reconnecting mid-game is the normal case: one side simply has more moves,
   * and the shorter history is a prefix of the longer. Anything else means the
   * two games genuinely diverged, which no automatic rule can settle.
   */
  private reconcile(size: number, theirs: readonly GameMove[]): boolean {
    const ours = this.game.committed.moves;

    if (size !== this.game.committed.size) {
      this.patch({ desync: { size, moves: [...theirs] } });
      this.fail(
        `The opponent is playing on a ${size}×${size} board and this game is ${this.game.committed.size}×${this.game.committed.size}.`,
      );
      return false;
    }

    if (isPrefixOf(ours, theirs)) {
      if (theirs.length > ours.length) {
        try {
          this.game.loadMoves(size, theirs);
        } catch (error) {
          this.fail(
            error instanceof Error ? error.message : "The opponent's game is not a legal position.",
          );
          return false;
        }
      }
      return true;
    }

    if (isPrefixOf(theirs, ours)) return true;

    this.patch({ desync: { size, moves: [...theirs] } });
    this.fail('This game and your opponent\'s have diverged. Choose which one to keep.');
    return false;
  }

  private handleMove(message: Extract<Message, { t: 'move' }>): void {
    if (this.view.status !== 'ready') {
      this.fail('The opponent sent a move before the handshake finished.');
      return;
    }

    const expected = this.game.committed.moves.length;
    if (message.ply !== expected) {
      this.fail(
        `Move arrived out of order (expected move ${expected + 1}, got ${message.ply + 1}).`,
      );
      this.send({ t: 'stateDump', size: this.size, moves: [...this.game.committed.moves] });
      return;
    }

    if (!this.remoteMayPlay(message.move)) {
      this.fail('The opponent tried to move out of turn.');
      return;
    }

    const applied = this.game.applyRemote(message.move);
    if (!applied.ok) {
      this.fail(`The opponent sent an illegal move: ${applied.error}.`);
      return;
    }

    const ours = stateHash(this.game.committed);
    if (ours !== message.hash) {
      this.patch({ desync: { size: this.size, moves: [...this.game.committed.moves] } });
      this.fail('The two boards no longer agree. The game state has diverged.');
    }
  }

  /** True if the move is one the remote player is entitled to make right now. */
  private remoteMayPlay(move: GameMove): boolean {
    const state = this.game.committed;
    const theirSeat = this.remoteSeat;

    switch (move.t) {
      case 'turn':
      case 'swap':
        return state.toMove === theirSeat;
      case 'resign':
        // You may resign at any time, but only on your own behalf.
        return move.seat === theirSeat;
      case 'draw':
        // Draws only arrive through the offer/response exchange.
        return false;
    }
  }

  private handleStateDump(message: Extract<Message, { t: 'stateDump' }>): void {
    const ours = this.game.committed.moves;
    if (isPrefixOf(ours, message.moves)) {
      try {
        this.game.loadMoves(message.size, message.moves);
        this.patch({ error: null, desync: null });
      } catch (error) {
        this.fail(
          error instanceof Error ? error.message : "The opponent's game is not a legal position.",
        );
      }
      return;
    }
    if (isPrefixOf(message.moves, ours)) return;

    this.patch({ desync: { size: message.size, moves: [...message.moves] } });
    this.fail('This game and your opponent\'s have diverged. Choose which one to keep.');
  }

  // ---- actions the UI drives ----

  requestUndo(): void {
    const ply = this.game.committed.moves.length - 1;
    if (ply < 0 || this.view.status !== 'ready') return;
    this.patch({ awaitingUndoReply: true });
    this.send({ t: 'undoRequest', toPly: ply });
  }

  respondToUndo(accept: boolean): void {
    const toPly = this.view.undoRequest;
    if (toPly === null) return;
    this.send({ t: 'undoResponse', toPly, accept });
    this.patch({ undoRequest: null });
    if (accept) this.game.rewindTo(toPly);
  }

  offerDraw(): void {
    if (this.view.status !== 'ready') return;
    this.weOfferedDraw = true;
    this.patch({ awaitingDrawReply: true });
    this.send({ t: 'drawOffer' });
  }

  respondToDraw(accept: boolean): void {
    if (!this.view.drawOffered) return;
    this.send({ t: 'drawResponse', accept });
    this.patch({ drawOffered: false });
    if (accept) this.game.applyRemote({ t: 'draw' });
  }

  /** Abandon our history and take the peer's. */
  acceptPeerState(): void {
    const desync = this.view.desync;
    if (!desync) return;
    try {
      this.game.loadMoves(desync.size, desync.moves);
      this.patch({ desync: null, error: null });
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : "The opponent's game is not a legal position.",
      );
    }
  }

  /** Push our history to the peer and ask them to take it. */
  pushOwnState(): void {
    this.send({ t: 'stateDump', size: this.size, moves: [...this.game.committed.moves] });
    this.patch({ desync: null, error: null });
  }

  close(): void {
    this.stopPings();
    this.game.onCommit = null;
    this.transport.close();
    this.patch({ status: 'closed' });
  }
}

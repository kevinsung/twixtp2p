/**
 * Reactive shell around a `Session`.
 *
 * `Session` is deliberately framework-free so it can be tested over a loopback
 * transport; this class is the thin adapter that mirrors its state into runes
 * and owns the lifecycle of whichever transport was chosen.
 */

import type { Seat } from '../engine/board';
import {
  answerManualOffer,
  createManualOffer,
  type ManualOffer,
  type ManualTransport,
} from '../net/manual';
import { RelayTransport } from '../net/relay';
import { generateCode } from '../net/roomcode';
import { Session, type SessionView, type Transport } from '../net/session';
import type { GameController } from './game.svelte';

export type Phase =
  | 'idle'
  /** Building an offer or joining a room. */
  | 'starting'
  /** Connected to the rendezvous; nobody else has arrived yet. */
  | 'waiting'
  /** The host is holding an offer, waiting for the answer to be pasted back. */
  | 'awaiting-answer'
  | 'connected'
  | 'error';

const EMPTY_VIEW: SessionView = {
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

export class OnlineGame {
  phase = $state<Phase>('idle');
  /** Room code, when playing over relays. */
  code = $state<string | null>(null);
  /** Offer or answer blob, when using the manual handshake. */
  handshakeCode = $state<string | null>(null);
  error = $state<string | null>(null);
  view = $state.raw<SessionView>(EMPTY_VIEW);

  private session: Session | null = null;
  private transport: Transport | null = null;
  private offer: ManualOffer | null = null;

  get isHost(): boolean {
    return this.hosting;
  }
  private hosting = false;

  /** Host a game over public relays. Returns the code to share. */
  async hostViaRelay(
    game: GameController,
    options: { name: string; size: number; hostSeat: Seat },
  ): Promise<void> {
    const code = generateCode();
    await this.startRelay(game, code, { ...options, isHost: true });
    this.code = code;
  }

  /** Join a game over public relays using a code shared with you. */
  async joinViaRelay(game: GameController, code: string, name: string): Promise<void> {
    await this.startRelay(game, code, { name, size: game.size, hostSeat: 0, isHost: false });
    this.code = code;
  }

  private async startRelay(
    game: GameController,
    code: string,
    options: { name: string; size: number; hostSeat: Seat; isHost: boolean },
  ): Promise<void> {
    this.reset();
    this.hosting = options.isHost;
    this.phase = 'starting';

    try {
      const transport = await RelayTransport.join(code);
      transport.onWaiting = () => {
        if (this.phase === 'starting') this.phase = 'waiting';
      };
      this.attach(game, transport, options);
    } catch (error) {
      this.failWith(error, 'Could not reach any relay to set up the game.');
    }
  }

  /** Host a game with no relay at all: produce an offer to send by hand. */
  async hostManually(
    game: GameController,
    options: { name: string; size: number; hostSeat: Seat },
  ): Promise<void> {
    this.reset();
    this.hosting = true;
    this.phase = 'starting';

    try {
      const offer = await createManualOffer();
      this.offer = offer;
      this.handshakeCode = offer.code;
      this.phase = 'awaiting-answer';
      this.attach(game, offer.transport, { ...options, isHost: true });
    } catch (error) {
      this.failWith(error, 'Could not create an invitation.');
    }
  }

  /** Host side: complete the manual handshake with the guest's answer. */
  async acceptManualAnswer(answerCode: string): Promise<boolean> {
    if (!this.offer) return false;
    try {
      const ok = await this.offer.acceptAnswer(answerCode);
      if (!ok) {
        this.error = 'That answer code was not readable. Check it was copied in full.';
        return false;
      }
      this.error = null;
      this.phase = 'starting';
      return true;
    } catch (error) {
      this.failWith(error, 'That answer code could not be used.');
      return false;
    }
  }

  /** Guest side: answer a manual invitation. Returns the code to send back. */
  async answerManually(
    game: GameController,
    offerCode: string,
    name: string,
  ): Promise<string | null> {
    this.reset();
    this.hosting = false;
    this.phase = 'starting';

    try {
      const answer = await answerManualOffer(offerCode);
      if (!answer) {
        this.phase = 'error';
        this.error = 'That invitation was not readable. Check it was copied in full.';
        return null;
      }
      this.handshakeCode = answer.code;
      this.phase = 'awaiting-answer';
      this.attach(game, answer.transport, {
        name,
        size: game.size,
        hostSeat: 0,
        isHost: false,
      });
      return answer.code;
    } catch (error) {
      this.failWith(error, 'Could not answer that invitation.');
      return null;
    }
  }

  private attach(
    game: GameController,
    transport: Transport | ManualTransport,
    options: { name: string; size: number; hostSeat: Seat; isHost: boolean },
  ): void {
    this.transport = transport;

    const session = new Session(game, transport, {
      isHost: options.isHost,
      name: options.name,
      size: options.size,
      hostSeat: options.hostSeat,
    });

    session.onUpdate = () => {
      this.view = session.view;
      if (session.view.status === 'ready' && this.phase !== 'connected') {
        this.phase = 'connected';
        this.error = null;
      }
      if (session.view.error) this.error = session.view.error;
      if (session.view.status === 'closed' && this.phase !== 'idle') this.phase = 'error';
    };

    const previousClose = transport.onClose;
    transport.onClose = (reason) => {
      previousClose?.(reason);
      if (reason) this.error = reason;
    };

    this.session = session;
  }

  private failWith(error: unknown, fallback: string): void {
    this.phase = 'error';
    this.error = error instanceof Error ? error.message : fallback;
  }

  private reset(): void {
    this.session?.close();
    this.session = null;
    this.transport = null;
    this.offer = null;
    this.handshakeCode = null;
    this.error = null;
    this.view = EMPTY_VIEW;
  }

  // ---- pass-through actions ----

  requestUndo(): void {
    this.session?.requestUndo();
  }
  respondToUndo(accept: boolean): void {
    this.session?.respondToUndo(accept);
  }
  offerDraw(): void {
    this.session?.offerDraw();
  }
  respondToDraw(accept: boolean): void {
    this.session?.respondToDraw(accept);
  }
  acceptPeerState(): void {
    this.session?.acceptPeerState();
  }
  pushOwnState(): void {
    this.session?.pushOwnState();
  }

  leave(): void {
    this.reset();
    this.phase = 'idle';
    this.code = null;
    this.hosting = false;
  }
}

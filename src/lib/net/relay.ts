/**
 * The primary connection path: room codes over public relays, via Trystero.
 *
 * Nothing here is deployed by us. Trystero's default strategy is Nostr, whose
 * many independent public relays carry only the WebRTC handshake; once the peer
 * connection is up, every byte of the game travels directly between the two
 * browsers.
 *
 * Two safeguards matter because the relay is public infrastructure:
 *   - the room id is a hash of the code, so relays never see the secret;
 *   - the code doubles as Trystero's `password`, so the handshake is encrypted
 *     end to end with AES-GCM.
 *
 * Trystero rooms hold any number of peers and the library offers no cap, so the
 * two-player limit is enforced here: the first peer to arrive is the opponent
 * and every later arrival is ignored.
 */

import { joinRoom, type Room } from 'trystero';

import { rtcConfig } from './ice';
import { roomIdFor } from './roomcode';
import type { Transport } from './session';

const APP_ID = 'twixt-p2p-v1';

/** Trystero limits action names to 12 bytes. */
const ACTION = 'twixt';

export class RelayTransport implements Transport {
  onMessage: ((data: string) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;

  /** Fired when the room is joined but nobody else is there yet. */
  onWaiting: (() => void) | null = null;

  private room: Room | null = null;
  private post: ((data: string, options?: { target?: string }) => Promise<void>) | null = null;
  private opponent: string | null = null;
  private closed = false;
  private started = false;

  static async join(code: string): Promise<RelayTransport> {
    const transport = new RelayTransport();
    const roomId = await roomIdFor(code);

    const room = joinRoom(
      {
        appId: APP_ID,
        // The code itself is the encryption key; only its hash reaches a relay.
        password: code,
        rtcConfig,
      },
      roomId,
      {
        onJoinError: (details) => transport.fail(details.error),
      },
    );

    const action = room.makeAction<string>(ACTION);
    action.onMessage = (data, context) => {
      // Ignore anyone who is not the opponent we accepted.
      if (context.peerId !== transport.opponent) return;
      if (typeof data === 'string') transport.onMessage?.(data);
    };

    room.onPeerJoin = (peerId) => {
      if (transport.opponent !== null) return; // the game is already full
      transport.opponent = peerId;
      // The opponent can arrive before a session is listening, so hold the
      // notification until `start` says the handlers are in place.
      if (transport.started) transport.onOpen?.();
    };

    room.onPeerLeave = (peerId) => {
      if (peerId !== transport.opponent) return;
      transport.opponent = null;
      transport.onClose?.('Your opponent disconnected.');
    };

    transport.room = room;
    transport.post = (data, options) => action.send(data, options);

    // Nothing to do but wait for the other side to arrive.
    queueMicrotask(() => {
      if (!transport.closed && transport.opponent === null) transport.onWaiting?.();
    });

    return transport;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.opponent !== null) this.onOpen?.();
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.onClose?.(reason);
  }

  send(data: string): void {
    if (this.closed || !this.post || !this.opponent) return;
    this.post(data, { target: this.opponent }).catch((error: unknown) => {
      this.fail(error instanceof Error ? error.message : 'Could not reach your opponent.');
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opponent = null;
    void this.room?.leave();
    this.room = null;
    this.post = null;
  }
}

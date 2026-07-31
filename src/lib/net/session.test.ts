import { beforeEach, describe, expect, it } from 'vitest';

import { DARK, EMPTY, LIGHT, idx, type Seat } from '../engine/board';
import {
  applyMove,
  createGame,
  replay,
  stateHash,
  truncateTo,
  type GameMove,
  type GameState,
} from '../engine/game';
import { PROTOCOL_VERSION, decode, encode, isPrefixOf, type Message } from './protocol';
import { Session, type GameHost, type Transport } from './session';

const SIZE = 12;

/**
 * Two transports wired straight to each other. Delivery is synchronous, which
 * keeps the tests deterministic — no timers, no flushing, no ordering luck.
 */
class Loopback implements Transport {
  onMessage: ((data: string) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;

  peer: Loopback | null = null;
  /** Frames captured instead of delivered, for tampering tests. */
  intercept: ((data: string) => string | null) | null = null;
  closed = false;

  /** Simulates a transport that was already connected before the session existed. */
  openedEarly = false;
  started = false;

  start(): void {
    this.started = true;
    if (this.openedEarly) this.onOpen?.();
  }

  send(data: string): void {
    if (this.closed) return;
    const outgoing = this.intercept ? this.intercept(data) : data;
    if (outgoing === null) return;
    this.peer?.onMessage?.(outgoing);
  }

  close(): void {
    this.closed = true;
    this.onClose?.('closed');
  }
}

function pair(): [Loopback, Loopback] {
  const a = new Loopback();
  const b = new Loopback();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A plain implementation of the interface the session depends on. */
class TestGame implements GameHost {
  committed: GameState;
  mySeat: Seat | null = null;
  onCommit: ((move: GameMove) => void) | null = null;

  constructor(size: number) {
    this.committed = createGame(size);
  }

  loadMoves(size: number, moves: readonly GameMove[]): void {
    this.committed = replay(size, moves);
  }

  applyRemote(move: GameMove): { ok: true } | { ok: false; error: string } {
    const result = applyMove(this.committed, move);
    if (!result.ok) return result;
    this.committed = result.state;
    return { ok: true };
  }

  rewindTo(ply: number): void {
    this.committed = truncateTo(this.committed, ply);
  }

  /** Make a move locally, as the UI would. */
  play(move: GameMove): void {
    const result = applyMove(this.committed, move);
    if (!result.ok) throw new Error(result.error);
    this.committed = result.state;
    this.onCommit?.(move);
  }

  place(r: number, c: number): void {
    this.play({ t: 'turn', place: idx(this.committed.size, r, c), linkOps: [] });
  }
}

interface Rig {
  host: TestGame;
  guest: TestGame;
  hostSession: Session;
  guestSession: Session;
  hostWire: Loopback;
  guestWire: Loopback;
}

/** Timers are stubbed out so nothing fires during a test. */
const noTimers = {
  setInterval: () => 0,
  clearInterval: () => {},
};

function connect(options?: { hostSeat?: Seat; guestSize?: number }): Rig {
  const [hostWire, guestWire] = pair();
  const host = new TestGame(SIZE);
  const guest = new TestGame(options?.guestSize ?? SIZE);

  const hostSession = new Session(host, hostWire, {
    isHost: true,
    name: 'Host',
    size: SIZE,
    hostSeat: options?.hostSeat ?? 0,
    ...noTimers,
  });
  const guestSession = new Session(guest, guestWire, {
    isHost: false,
    name: 'Guest',
    size: options?.guestSize ?? SIZE,
    hostSeat: 0,
    ...noTimers,
  });

  guestWire.onOpen?.();
  hostWire.onOpen?.();

  return { host, guest, hostSession, guestSession, hostWire, guestWire };
}

describe('protocol decoding', () => {
  it('round-trips every message type', () => {
    const messages = [
      { t: 'hello', v: 1, size: SIZE, yourSeat: 1, name: 'A', moves: [] },
      { t: 'hi', v: 1, name: 'B', moves: [] },
      { t: 'move', ply: 0, move: { t: 'turn', place: idx(SIZE, 3, 3), linkOps: [] }, hash: 7 },
      { t: 'undoRequest', toPly: 2 },
      { t: 'undoResponse', toPly: 2, accept: true },
      { t: 'drawOffer' },
      { t: 'drawResponse', accept: false },
      { t: 'stateDump', size: SIZE, moves: [] },
      { t: 'ping', id: 5 },
      { t: 'pong', id: 5 },
    ] satisfies Message[];

    for (const message of messages) {
      expect(decode(encode(message), SIZE)).toEqual(message);
    }
  });

  it('rejects malformed and hostile frames', () => {
    expect(decode('not json', SIZE)).toBeNull();
    expect(decode('null', SIZE)).toBeNull();
    expect(decode(JSON.stringify({ t: 'nope' }), SIZE)).toBeNull();
    expect(decode(JSON.stringify({ t: 'move', ply: -1 }), SIZE)).toBeNull();
    expect(decode(JSON.stringify({ t: 'hello', v: 1, size: 4, yourSeat: 0, moves: [] }), SIZE))
      .toBeNull();
    expect(
      decode(JSON.stringify({ t: 'hello', v: 1, size: SIZE, yourSeat: 5, moves: [] }), SIZE),
    ).toBeNull();
    // A move list longer than the board could ever allow.
    expect(
      decode(
        JSON.stringify({ t: 'stateDump', size: SIZE, moves: new Array(SIZE * SIZE + 20).fill(0) }),
        SIZE,
      ),
    ).toBeNull();
  });

  it('recognises prefixes for reconnect reconciliation', () => {
    const a: GameMove[] = [{ t: 'turn', place: 5, linkOps: [] }];
    const b: GameMove[] = [
      { t: 'turn', place: 5, linkOps: [] },
      { t: 'turn', place: 9, linkOps: [] },
    ];
    const c: GameMove[] = [{ t: 'turn', place: 6, linkOps: [] }];

    expect(isPrefixOf(a, b)).toBe(true);
    expect(isPrefixOf(b, a)).toBe(false);
    expect(isPrefixOf(c, b)).toBe(false);
  });
});

describe('handshake', () => {
  it('brings both peers to ready with opposite seats', () => {
    const rig = connect();

    expect(rig.hostSession.view.status).toBe('ready');
    expect(rig.guestSession.view.status).toBe('ready');
    expect(rig.hostSession.view.opponentName).toBe('Guest');
    expect(rig.guestSession.view.opponentName).toBe('Host');
    expect(rig.host.mySeat).toBe(0);
    expect(rig.guest.mySeat).toBe(1);
  });

  it('makes the guest adopt the host board size', () => {
    const rig = connect({ guestSize: 24 });
    expect(rig.guest.committed.size).toBe(SIZE);
    expect(rig.guestSession.view.error).toBeNull();
  });

  it('honours the host choosing the second seat', () => {
    const rig = connect({ hostSeat: 1 });
    expect(rig.host.mySeat).toBe(1);
    expect(rig.guest.mySeat).toBe(0);
  });

  it('still handshakes when the peer arrived before the session was listening', () => {
    // The opponent can join during the await that builds the transport, so the
    // open notification has to survive until handlers are attached.
    const [hostWire, guestWire] = pair();
    hostWire.openedEarly = true;
    guestWire.openedEarly = true;

    const host = new TestGame(SIZE);
    const guest = new TestGame(SIZE);

    const guestSession = new Session(guest, guestWire, {
      isHost: false,
      name: 'Guest',
      size: SIZE,
      hostSeat: 0,
      ...noTimers,
    });
    const hostSession = new Session(host, hostWire, {
      isHost: true,
      name: 'Host',
      size: SIZE,
      hostSeat: 0,
      ...noTimers,
    });

    expect(hostSession.view.status).toBe('ready');
    expect(guestSession.view.status).toBe('ready');
    expect(guest.mySeat).toBe(1);
  });

  it('refuses a peer running a different protocol version', () => {
    const [hostWire, guestWire] = pair();
    const guest = new TestGame(SIZE);
    const guestSession = new Session(guest, guestWire, {
      isHost: false,
      name: 'Guest',
      size: SIZE,
      hostSeat: 0,
      ...noTimers,
    });
    guestWire.onOpen?.();

    hostWire.send(
      encode({
        t: 'hello',
        v: PROTOCOL_VERSION + 1,
        size: SIZE,
        yourSeat: 1,
        name: 'Future',
        moves: [],
      }),
    );

    expect(guestSession.view.status).not.toBe('ready');
    expect(guestSession.view.error).toMatch(/different version/);
  });
});

describe('move exchange', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = connect();
  });

  it('mirrors a move onto the opponent board', () => {
    rig.host.place(3, 3);

    expect(rig.guest.committed.moves).toHaveLength(1);
    expect(stateHash(rig.guest.committed)).toBe(stateHash(rig.host.committed));
    expect(rig.guestSession.view.error).toBeNull();
  });

  it('keeps a whole game in step across both peers', () => {
    rig.host.place(3, 3);
    rig.guest.place(4, 5);
    rig.host.place(5, 4);
    rig.guest.place(6, 6);

    expect(rig.host.committed.moves).toHaveLength(4);
    expect(stateHash(rig.host.committed)).toBe(stateHash(rig.guest.committed));
  });

  it('carries link edits with the move', () => {
    rig.host.place(4, 3); // LIGHT
    rig.guest.place(4, 5); // DARK
    rig.host.place(3, 1); // LIGHT, links to (4,3)

    const size = SIZE;
    rig.guest.play({
      t: 'turn',
      place: idx(size, 5, 3),
      linkOps: [{ add: false, a: idx(size, 4, 5), b: idx(size, 5, 3) }],
    });

    expect(rig.host.committed.links.has(idx(size, 4, 5), idx(size, 5, 3))).toBe(false);
    expect(stateHash(rig.host.committed)).toBe(stateHash(rig.guest.committed));
  });

  it('carries a pie-rule swap to both peers', () => {
    rig.host.place(4, 6);
    rig.guest.play({ t: 'swap' });

    // The opening is reflected across the diagonal and becomes the guest's.
    // Nobody changes seats, so it is the host — LIGHT — to move again.
    for (const game of [rig.host.committed, rig.guest.committed]) {
      expect(game.pegs[idx(SIZE, 4, 6)]).toBe(EMPTY);
      expect(game.pegs[idx(SIZE, 6, 4)]).toBe(DARK);
      expect(game.toMove).toBe(LIGHT);
    }
    expect(stateHash(rig.host.committed)).toBe(stateHash(rig.guest.committed));
  });

  it('rejects a move made out of turn', () => {
    // The guest fabricates a move while it is still the host's turn.
    rig.guestWire.send(
      encode({
        t: 'move',
        ply: 0,
        move: { t: 'turn', place: idx(SIZE, 3, 3), linkOps: [] },
        hash: 0,
      }),
    );

    expect(rig.hostSession.view.error).toMatch(/out of turn/);
    expect(rig.host.committed.moves).toHaveLength(0);
  });

  it('rejects an illegal move rather than applying it', () => {
    rig.host.place(3, 3);
    // DARK may not place on the top row.
    rig.guestWire.send(
      encode({
        t: 'move',
        ply: 1,
        move: { t: 'turn', place: idx(SIZE, 0, 4), linkOps: [] },
        hash: 0,
      }),
    );

    expect(rig.hostSession.view.error).toMatch(/illegal move/);
    expect(rig.host.committed.moves).toHaveLength(1);
  });

  it('rejects a move that arrives out of order', () => {
    rig.host.place(3, 3);
    rig.guestWire.send(
      encode({
        t: 'move',
        ply: 7,
        move: { t: 'turn', place: idx(SIZE, 4, 4), linkOps: [] },
        hash: 0,
      }),
    );

    expect(rig.hostSession.view.error).toMatch(/out of order/);
  });

  it('flags a divergence when the position hashes disagree', () => {
    // Corrupt only the hash, leaving a legal move — exactly the case a plain
    // legality check would miss.
    rig.hostWire.intercept = (data) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.t === 'move') message.hash = 12345;
      return JSON.stringify(message);
    };

    rig.host.place(3, 3);

    expect(rig.guestSession.view.error).toMatch(/diverged|no longer agree/);
    expect(rig.guestSession.view.desync).not.toBeNull();
  });

  it('refuses a bare draw move that skipped the offer exchange', () => {
    rig.guestWire.send(encode({ t: 'move', ply: 0, move: { t: 'draw' }, hash: 0 }));

    expect(rig.hostSession.view.error).toMatch(/out of turn/);
    expect(rig.host.committed.result).toBeNull();
  });
});

describe('takebacks', () => {
  it('rolls both peers back when the opponent accepts', () => {
    const rig = connect();
    rig.host.place(3, 3);
    rig.guest.place(4, 5);

    rig.guestSession.requestUndo();
    expect(rig.hostSession.view.undoRequest).toBe(1);

    rig.hostSession.respondToUndo(true);

    expect(rig.host.committed.moves).toHaveLength(1);
    expect(rig.guest.committed.moves).toHaveLength(1);
    expect(stateHash(rig.host.committed)).toBe(stateHash(rig.guest.committed));
  });

  it('changes nothing when the opponent declines', () => {
    const rig = connect();
    rig.host.place(3, 3);
    rig.guest.place(4, 5);

    rig.guestSession.requestUndo();
    rig.hostSession.respondToUndo(false);

    expect(rig.host.committed.moves).toHaveLength(2);
    expect(rig.guest.committed.moves).toHaveLength(2);
    expect(rig.guestSession.view.awaitingUndoReply).toBe(false);
  });
});

describe('draw offers', () => {
  it('ends the game as a draw when accepted', () => {
    const rig = connect();
    rig.host.place(3, 3);

    rig.hostSession.offerDraw();
    expect(rig.guestSession.view.drawOffered).toBe(true);

    rig.guestSession.respondToDraw(true);

    expect(rig.guest.committed.result).toEqual({ kind: 'draw' });
    expect(rig.host.committed.result).toEqual({ kind: 'draw' });
  });

  it('leaves the game running when declined', () => {
    const rig = connect();
    rig.hostSession.offerDraw();
    rig.guestSession.respondToDraw(false);

    expect(rig.host.committed.result).toBeNull();
    expect(rig.guest.committed.result).toBeNull();
    expect(rig.hostSession.view.awaitingDrawReply).toBe(false);
  });
});

describe('resignation', () => {
  it('ends the game on both sides', () => {
    const rig = connect();
    rig.host.play({ t: 'resign', seat: LIGHT });

    expect(rig.guest.committed.result).toEqual({ kind: 'win', seat: DARK, by: 'resignation' });
    expect(rig.guestSession.view.error).toBeNull();
  });

  it('refuses a resignation submitted on the opponent behalf', () => {
    const rig = connect();
    // The guest is DARK, so it may not resign LIGHT's game.
    rig.guestWire.send(encode({ t: 'move', ply: 0, move: { t: 'resign', seat: LIGHT }, hash: 0 }));

    expect(rig.hostSession.view.error).toMatch(/out of turn/);
    expect(rig.host.committed.result).toBeNull();
  });
});

describe('reconnecting mid-game', () => {
  it('brings a peer that fell behind back up to date', () => {
    const rig = connect();
    rig.host.place(3, 3);
    rig.guest.place(4, 5);
    rig.host.place(5, 4);

    // The guest reconnects with a stale copy of the game: two moves, not three.
    const [hostWire2, guestWire2] = pair();
    const staleGuest = new TestGame(SIZE);
    staleGuest.loadMoves(SIZE, rig.host.committed.moves.slice(0, 2));

    const hostSession2 = new Session(rig.host, hostWire2, {
      isHost: true,
      name: 'Host',
      size: SIZE,
      hostSeat: 0,
      ...noTimers,
    });
    const guestSession2 = new Session(staleGuest, guestWire2, {
      isHost: false,
      name: 'Guest',
      size: SIZE,
      hostSeat: 0,
      ...noTimers,
    });

    guestWire2.onOpen?.();
    hostWire2.onOpen?.();

    expect(guestSession2.view.status).toBe('ready');
    expect(hostSession2.view.error).toBeNull();
    expect(staleGuest.committed.moves).toHaveLength(3);
    expect(stateHash(staleGuest.committed)).toBe(stateHash(rig.host.committed));
  });

  it('asks the user to choose when the two histories truly diverged', () => {
    const hostGame = new TestGame(SIZE);
    const guestGame = new TestGame(SIZE);
    hostGame.place(3, 3);
    guestGame.place(4, 4); // a different first move entirely

    const [hostWire, guestWire] = pair();
    new Session(hostGame, hostWire, {
      isHost: true,
      name: 'Host',
      size: SIZE,
      hostSeat: 0,
      ...noTimers,
    });
    const guestSession = new Session(guestGame, guestWire, {
      isHost: false,
      name: 'Guest',
      size: SIZE,
      hostSeat: 0,
      ...noTimers,
    });

    guestWire.onOpen?.();
    hostWire.onOpen?.();

    expect(guestSession.view.error).toMatch(/diverged/);
    expect(guestSession.view.desync).not.toBeNull();

    // Yielding to the peer resolves it.
    guestSession.acceptPeerState();
    expect(guestSession.view.desync).toBeNull();
    expect(stateHash(guestGame.committed)).toBe(stateHash(hostGame.committed));
  });

  it('refuses to join a game on a different board size', () => {
    const hostGame = new TestGame(SIZE);
    const guestGame = new TestGame(24);
    hostGame.place(3, 3);
    guestGame.place(4, 4);

    const [hostWire, guestWire] = pair();
    new Session(hostGame, hostWire, {
      isHost: true,
      name: 'Host',
      size: SIZE,
      hostSeat: 0,
      ...noTimers,
    });
    const guestSession = new Session(guestGame, guestWire, {
      isHost: false,
      name: 'Guest',
      size: 24,
      hostSeat: 0,
      ...noTimers,
    });

    guestWire.onOpen?.();
    hostWire.onOpen?.();

    expect(guestSession.view.error).toMatch(/board/);
  });
});

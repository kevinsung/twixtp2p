/**
 * Wire format for peer-to-peer play.
 *
 * There is no server and therefore no referee: each peer independently
 * validates everything the other sends against its own copy of the rules. That
 * makes parsing a security boundary, not a convenience — every message is
 * checked structurally here before any of it reaches the engine.
 *
 * Every move carries a hash of the resulting position, so divergence surfaces
 * on the very next move instead of silently drifting.
 */

import { MAX_SIZE, MIN_SIZE } from '../engine/board';
import type { GameMove } from '../engine/game';
import { parseMove } from '../engine/notation';

export const PROTOCOL_VERSION = 1;

/** Refuse absurd payloads before parsing them. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

const MAX_NAME_LENGTH = 24;

export type Message =
  /** Host to guest: the authoritative game parameters and seat assignment. */
  | {
      t: 'hello';
      v: number;
      size: number;
      yourPlayer: 0 | 1;
      name: string;
      moves: GameMove[];
    }
  /** Guest to host: acknowledgement, with whatever history the guest holds. */
  | { t: 'hi'; v: number; name: string; moves: GameMove[] }
  | { t: 'move'; ply: number; move: GameMove; hash: number }
  | { t: 'undoRequest'; toPly: number }
  | { t: 'undoResponse'; toPly: number; accept: boolean }
  | { t: 'drawOffer' }
  | { t: 'drawResponse'; accept: boolean }
  /** Full history, used to recover after a reconnect or a detected desync. */
  | { t: 'stateDump'; size: number; moves: GameMove[] }
  | { t: 'ping'; id: number }
  | { t: 'pong'; id: number };

export function encode(message: Message): string {
  return JSON.stringify(message);
}

function isPlayer(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function isPly(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000;
}

function isSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SIZE &&
    value <= MAX_SIZE
  );
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function parseMoves(size: number, value: unknown): GameMove[] | null {
  if (!Array.isArray(value)) return null;
  // A game cannot outlast the board: one placement per hole, plus a handful of
  // non-placement moves.
  if (value.length > size * size + 8) return null;

  const moves: GameMove[] = [];
  for (const raw of value) {
    const move = parseMove(size, raw);
    if (!move) return null;
    moves.push(move);
  }
  return moves;
}

/**
 * Parse an untrusted frame. Returns null for anything malformed — callers treat
 * that as a protocol error rather than guessing at intent.
 *
 * `size` is the board size already agreed with this peer; before the handshake
 * completes it is only used to bound `hello`/`stateDump` history, which carry
 * their own size.
 */
export function decode(raw: string, agreedSize: number): Message | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;

  const message = data as Record<string, unknown>;

  switch (message.t) {
    case 'hello': {
      if (typeof message.v !== 'number') return null;
      if (!isSize(message.size)) return null;
      if (!isPlayer(message.yourPlayer)) return null;
      const moves = parseMoves(message.size, message.moves);
      if (!moves) return null;
      return {
        t: 'hello',
        v: message.v,
        size: message.size,
        yourPlayer: message.yourPlayer,
        name: cleanName(message.name),
        moves,
      };
    }

    case 'hi': {
      if (typeof message.v !== 'number') return null;
      const moves = parseMoves(agreedSize, message.moves);
      if (!moves) return null;
      return { t: 'hi', v: message.v, name: cleanName(message.name), moves };
    }

    case 'move': {
      if (!isPly(message.ply)) return null;
      if (typeof message.hash !== 'number') return null;
      const move = parseMove(agreedSize, message.move);
      if (!move) return null;
      return { t: 'move', ply: message.ply, move, hash: message.hash };
    }

    case 'undoRequest':
      if (!isPly(message.toPly)) return null;
      return { t: 'undoRequest', toPly: message.toPly };

    case 'undoResponse':
      if (!isPly(message.toPly) || typeof message.accept !== 'boolean') return null;
      return { t: 'undoResponse', toPly: message.toPly, accept: message.accept };

    case 'drawOffer':
      return { t: 'drawOffer' };

    case 'drawResponse':
      if (typeof message.accept !== 'boolean') return null;
      return { t: 'drawResponse', accept: message.accept };

    case 'stateDump': {
      if (!isSize(message.size)) return null;
      const moves = parseMoves(message.size, message.moves);
      if (!moves) return null;
      return { t: 'stateDump', size: message.size, moves };
    }

    case 'ping':
      if (typeof message.id !== 'number') return null;
      return { t: 'ping', id: message.id };

    case 'pong':
      if (typeof message.id !== 'number') return null;
      return { t: 'pong', id: message.id };

    default:
      return null;
  }
}

/** True if `prefix` is an exact leading run of `full`. */
export function isPrefixOf(prefix: readonly GameMove[], full: readonly GameMove[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (JSON.stringify(prefix[i]) !== JSON.stringify(full[i])) return false;
  }
  return true;
}

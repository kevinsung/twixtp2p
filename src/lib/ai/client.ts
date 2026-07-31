/**
 * The page's side of the search worker.
 *
 * Requests carry an incrementing id so a reply that arrives after a takeback —
 * or after the player left the game — is recognised as stale and dropped rather
 * than played on a board that has moved on.
 */

import type { ThinkRequest, WorkerReply } from './protocol';
import type { GameMove } from '../engine/game';

/** Thrown into a pending `think` when the caller no longer wants the answer. */
export class BotCancelled extends Error {
  constructor() {
    super('the bot was asked to stop thinking');
    this.name = 'BotCancelled';
  }
}

interface Waiting {
  resolve: (move: GameMove) => void;
  reject: (error: Error) => void;
}

export class BotEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();

  /** True where the environment has no `Worker` — jsdom, mostly. */
  private get workerless(): boolean {
    return typeof Worker === 'undefined';
  }

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        const pending = this.waiting.get(reply.id);
        if (!pending) return;
        this.waiting.delete(reply.id);
        if ('error' in reply) pending.reject(new Error(reply.error));
        else pending.resolve(reply.move);
      };
      this.worker.onerror = () => this.failAll(new Error('the search worker stopped'));
    }
    return this.worker;
  }

  think(request: ThinkRequest): Promise<GameMove> {
    // Without a worker the search runs here. It is the same code and the same
    // budget, which is a parameter — so a caller that cannot afford to block,
    // such as a test, simply asks for a small one. Loading it on demand keeps
    // the engine out of the main bundle in the normal case.
    if (this.workerless) {
      return import('./bot').then(({ chooseMove }) =>
        chooseMove(request.size, request.moves, request.seat, { budgetMs: request.budgetMs }),
      );
    }

    const id = this.nextId++;
    const worker = this.ensure();
    return new Promise<GameMove>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, ...request });
    });
  }

  /**
   * Abandon anything in flight.
   *
   * A worker mid-search cannot be interrupted politely, and the next request
   * would queue behind the one we no longer care about — so it is terminated
   * outright and respawned on demand.
   */
  cancel(): void {
    if (this.waiting.size === 0) return;
    this.failAll(new BotCancelled());
    this.terminate();
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private failAll(error: Error): void {
    for (const pending of this.waiting.values()) pending.reject(error);
    this.waiting.clear();
  }
}

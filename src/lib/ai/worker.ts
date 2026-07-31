/**
 * The search, off the main thread.
 *
 * A second and a half of alpha-beta on the UI thread would freeze the board, so
 * the whole engine lives here and the page only ever sees a move come back.
 * `client.ts` is the other half of this conversation.
 */

import { chooseMove } from './bot';
import type { WorkerReply, WorkerRequest } from './protocol';

// The worker global, without dragging the `webworker` lib into a project whose
// other files are typed against the DOM.
const ctx = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply): void;
};

ctx.onmessage = (event) => {
  const request = event.data;
  try {
    const move = chooseMove(request.size, request.moves, request.seat, {
      budgetMs: request.budgetMs,
    });
    ctx.postMessage({ id: request.id, move });
  } catch (error) {
    ctx.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

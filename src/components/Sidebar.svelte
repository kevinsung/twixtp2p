<script lang="ts">
  import { LIGHT, seatName } from '../lib/engine/board';
  import { formatMove } from '../lib/engine/notation';
  import type { GameController } from '../lib/stores/game.svelte';
  import type { OnlineGame } from '../lib/stores/online.svelte';

  interface Props {
    game: GameController;
    /** Present only in peer-to-peer games. */
    online: OnlineGame | null;
  }

  let { game, online }: Props = $props();

  let state = $derived(game.committed);
  let mySeat = $derived(game.control === 'both' ? null : game.control);
  let net = $derived(online?.view ?? null);

  let status = $derived.by(() => {
    const result = state.result;
    if (result) {
      if (result.kind === 'draw') return 'Draw.';
      const who = seatName(result.seat);
      const mine = mySeat !== null && result.seat === mySeat;
      const suffix = result.by === 'resignation' ? 'by resignation' : 'by connection';
      if (mySeat === null) return `${who} wins ${suffix}.`;
      return mine ? `You win ${suffix}.` : `${who} wins ${suffix}.`;
    }
    const mover = seatName(state.toMove);
    if (mySeat === null) return `${mover} to move.`;
    return state.toMove === mySeat ? `Your move (${mover}).` : `Waiting for ${mover}…`;
  });

  let rows = $derived.by(() => {
    const out: Array<{ n: number; light: string; dark: string }> = [];
    state.moves.forEach((move, i) => {
      const text = formatMove(state.size, move);
      if (i % 2 === 0) out.push({ n: i / 2 + 1, light: text, dark: '' });
      else out[out.length - 1]!.dark = text;
    });
    return out;
  });

  let canUndo = $derived(
    online
      ? net?.status === 'ready' && state.moves.length > 0 && !net.awaitingUndoReply
      : game.pending !== null || state.moves.length > 0,
  );

  function undo(): void {
    if (online) online.requestUndo();
    else game.undoLocal();
  }

  function resign(): void {
    const seat = mySeat ?? state.toMove;
    if (confirm(`Resign as ${seatName(seat)}?`)) game.resign(seat);
  }
</script>

<aside class="sidebar">
  {#if online && net}
    <section class="connection" class:live={net.status === 'ready'}>
      <span class="pip" class:live={net.status === 'ready'}></span>
      <span class="who">
        {#if net.status === 'ready'}
          {net.opponentName || 'Opponent'}
        {:else if net.status === 'closed'}
          Disconnected
        {:else}
          Connecting…
        {/if}
      </span>
      {#if net.latencyMs !== null && net.status === 'ready'}
        <span class="latency">{net.latencyMs} ms</span>
      {/if}
    </section>
  {/if}

  <section class="status" aria-live="polite">
    <span class="dot {state.toMove === LIGHT ? 'light' : 'dark'}" class:over={!!state.result}></span>
    <p>{status}</p>
  </section>

  {#if game.message}
    <p class="message" role="alert">{game.message}</p>
  {/if}

  {#if net?.desync}
    <div class="prompt danger" role="alert">
      <p>The two boards have diverged. Choose which game to keep.</p>
      <div class="prompt-actions">
        <button onclick={() => online?.acceptPeerState()}>Use theirs</button>
        <button onclick={() => online?.pushOwnState()}>Use mine</button>
      </div>
    </div>
  {:else if net?.error}
    <p class="message" role="alert">{net.error}</p>
  {/if}

  {#if net?.undoRequest !== null && net?.undoRequest !== undefined}
    <div class="prompt">
      <p>Your opponent asks to take back a move.</p>
      <div class="prompt-actions">
        <button class="primary" onclick={() => online?.respondToUndo(true)}>Allow</button>
        <button onclick={() => online?.respondToUndo(false)}>Decline</button>
      </div>
    </div>
  {/if}

  {#if net?.drawOffered}
    <div class="prompt">
      <p>Your opponent offers a draw.</p>
      <div class="prompt-actions">
        <button class="primary" onclick={() => online?.respondToDraw(true)}>Accept</button>
        <button onclick={() => online?.respondToDraw(false)}>Decline</button>
      </div>
    </div>
  {/if}

  {#if net?.awaitingUndoReply}
    <p class="hint">Waiting for a reply to your takeback request…</p>
  {/if}
  {#if net?.awaitingDrawReply}
    <p class="hint">Waiting for a reply to your draw offer…</p>
  {/if}

  <section class="controls">
    {#if game.pending}
      <button class="primary" onclick={() => game.confirm()}>Confirm move</button>
      <button onclick={() => game.cancel()}>Cancel</button>
    {:else if game.canSwapNow}
      <button class="primary" onclick={() => game.swap()}>Swap sides</button>
    {/if}
    <button onclick={undo} disabled={!canUndo}>
      {online ? 'Ask for takeback' : 'Undo'}
    </button>
    {#if online}
      <button
        onclick={() => online.offerDraw()}
        disabled={!!state.result || net?.status !== 'ready' || net?.awaitingDrawReply}
      >
        Offer draw
      </button>
    {/if}
    <button class="danger" onclick={resign} disabled={!!state.result}>Resign</button>
  </section>

  {#if game.pending}
    <p class="hint">
      Click a link to remove it, or a dashed lane to add one. Amber lanes are blocked by an existing
      link.
    </p>
  {/if}

  {#if game.canSwapNow}
    <p class="hint">
      The pie rule: you may take over your opponent's opening instead of replying to it. Available
      only right now.
    </p>
  {/if}

  <section class="moves">
    <h2>Moves</h2>
    {#if rows.length === 0}
      <p class="empty">No moves yet.</p>
    {:else}
      <ol>
        {#each rows as row (row.n)}
          <li>
            <span class="num">{row.n}.</span>
            <span class="ply light">{row.light}</span>
            <span class="ply dark">{row.dark}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    min-height: 0;
  }

  .connection {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85em;
    color: var(--text-dim);
    padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .pip {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--text-faint);
    flex: none;
  }
  .pip.live {
    background: var(--last-move);
  }

  .who {
    font-weight: 600;
    color: var(--text);
  }

  .latency {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 0.9em;
    color: var(--text-faint);
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .status p {
    margin: 0;
    font-weight: 600;
  }

  .dot {
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 50%;
    flex: none;
    border: 1px solid var(--border);
  }
  .dot.light {
    background: var(--seat-light);
  }
  .dot.dark {
    background: var(--seat-dark);
  }
  .dot.over {
    background: var(--text-faint);
  }

  .message {
    margin: 0;
    padding: 0.5rem 0.7rem;
    border-radius: 7px;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
    font-size: 0.9em;
  }

  .prompt {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.7rem;
    display: grid;
    gap: 0.5rem;
  }

  .prompt.danger {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }

  .prompt p {
    margin: 0;
    font-size: 0.9em;
  }

  .prompt-actions {
    display: flex;
    gap: 0.4rem;
  }

  .hint {
    margin: 0;
    font-size: 0.85em;
    color: var(--text-dim);
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .moves {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }

  .moves h2 {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    margin: 0 0 0.4rem;
  }

  .empty {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.9em;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 0.85em;
    min-height: 0;
  }

  li {
    display: grid;
    grid-template-columns: 2.5em 1fr 1fr;
    gap: 0.4rem;
    padding: 0.12rem 0;
  }

  .num {
    color: var(--text-faint);
    text-align: right;
  }

  .ply.light {
    color: var(--seat-light);
  }
  .ply.dark {
    color: var(--text);
  }
</style>

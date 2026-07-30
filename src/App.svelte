<script lang="ts">
  import Board from './components/Board.svelte';
  import Lobby from './components/Lobby.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import { BOARD_SIZES, DEFAULT_SIZE } from './lib/engine/board';
  import { parseSaveFile, serializeGame } from './lib/engine/notation';
  import { codeFromHash } from './lib/net/roomcode';
  import { GameController } from './lib/stores/game.svelte';
  import { OnlineGame } from './lib/stores/online.svelte';
  import { settings } from './lib/stores/settings.svelte';

  type Screen = 'menu' | 'lobby' | 'game';

  const game = new GameController();
  const online = new OnlineGame();

  let screen = $state<Screen>('menu');
  let chosenSize = $state<number>(DEFAULT_SIZE);
  let loadError = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let isOnline = $state(false);

  /** A room code or manual invitation carried in the URL fragment. */
  const linkCode = typeof location === 'undefined' ? null : codeFromHash(location.hash);
  const linkOffer =
    typeof location === 'undefined'
      ? null
      : new URLSearchParams(location.hash.replace(/^#/, '')).get('o');

  if (linkCode || linkOffer) screen = 'lobby';

  $effect(() => {
    game.skipConfirmation = settings.skipConfirmation;
  });

  $effect(() => {
    void settings.skipConfirmation;
    void settings.showCoordinates;
    void settings.playerName;
    void settings.theme;
    settings.save();
  });

  // 'auto' means "no opinion" — leave it to the browser's color-scheme.
  $effect(() => {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  });

  function cycleTheme(): void {
    settings.theme =
      settings.theme === 'auto' ? 'light' : settings.theme === 'light' ? 'dark' : 'auto';
  }

  let themeLabel = $derived(
    settings.theme === 'auto' ? 'Theme: auto' : settings.theme === 'light' ? 'Theme: light' : 'Theme: dark',
  );

  // The lobby hands over to the board as soon as the peers are talking.
  $effect(() => {
    if (online.phase === 'connected' && screen === 'lobby') {
      screen = 'game';
      isOnline = true;
    }
  });

  function startLocal(): void {
    game.reset(chosenSize);
    game.myPlayer = null;
    isOnline = false;
    screen = 'game';
  }

  function leaveGame(): void {
    if (isOnline) online.leave();
    isOnline = false;
    game.myPlayer = null;
    screen = 'menu';
    if (typeof location !== 'undefined' && location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function saveGame(): void {
    const blob = new Blob([serializeGame(game.committed)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `twixt-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadGame(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    const parsed = parseSaveFile(await file.text());
    if (!parsed.ok) {
      loadError = `Could not load that file: ${parsed.error}.`;
      return;
    }

    try {
      game.loadMoves(parsed.size, parsed.moves);
    } catch (error) {
      // Well-formed JSON can still describe a position the rules forbid.
      loadError = error instanceof Error ? error.message : 'That saved game is not a legal position.';
      return;
    }

    game.myPlayer = null;
    isOnline = false;
    loadError = null;
    screen = 'game';
  }

  function handleKey(event: KeyboardEvent): void {
    if (screen !== 'game') return;
    if (event.key === 'Enter' && game.pending) {
      event.preventDefault();
      game.confirm();
    } else if (event.key === 'Escape' && game.pending) {
      event.preventDefault();
      game.cancel();
    }
  }
</script>

<svelte:window onkeydown={handleKey} />

<div class="app">
  <header>
    <h1>TwixT</h1>
    <div class="header-actions">
      {#if screen === 'game'}
        <button onclick={saveGame}>Save</button>
        {#if !isOnline}
          <button onclick={() => fileInput?.click()}>Load</button>
        {/if}
        <button onclick={leaveGame}>{isOnline ? 'Leave game' : 'New game'}</button>
      {/if}
      <button onclick={cycleTheme} title="Switch between automatic, light and dark">
        {themeLabel}
      </button>
    </div>
  </header>

  {#if screen === 'menu'}
    <main class="menu">
      <div class="card">
        <h2>Local game</h2>
        <p>Both players share this device, taking turns.</p>
        <label>
          Board size
          <select bind:value={chosenSize}>
            {#each BOARD_SIZES as size (size)}
              <option value={size}>{size} × {size}{size === DEFAULT_SIZE ? ' (standard)' : ''}</option>
            {/each}
          </select>
        </label>
        <button class="primary" onclick={startLocal}>Start</button>
      </div>

      <div class="card">
        <h2>Play someone else</h2>
        <p>
          Connects the two browsers directly. There is no game server — a public relay introduces
          you, then steps out of the way.
        </p>
        <button class="primary" onclick={() => (screen = 'lobby')}>Set up a game</button>
      </div>

      <div class="card">
        <h2>Preferences</h2>
        <label class="check">
          <input type="checkbox" bind:checked={settings.showCoordinates} />
          Show coordinates
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={settings.skipConfirmation} />
          Skip move confirmation
        </label>
        <p class="note">
          Confirmation is what lets you adjust links before committing. Skipping it commits the
          moment you place a peg.
        </p>
      </div>

      {#if loadError}
        <p class="error" role="alert">{loadError}</p>
      {/if}
      <p class="load-row">
        <button onclick={() => fileInput?.click()}>Load a saved game</button>
      </p>
    </main>
  {:else if screen === 'lobby'}
    <main>
      <Lobby {game} {online} initialCode={linkCode} initialOffer={linkOffer} onBack={leaveGame} />
    </main>
  {:else}
    <main class="game">
      <div class="board-wrap">
        <Board
          view={game.view}
          committed={game.committed}
          pendingPlace={game.pending?.place ?? null}
          interactive={game.isMyTurn}
          showCoordinates={settings.showCoordinates}
          onCell={(cell) => game.clickCell(cell)}
          onLink={(a, b) => game.toggleLink(a, b)}
        />
      </div>
      <Sidebar {game} online={isOnline ? online : null} />
    </main>
  {/if}
</div>

<input bind:this={fileInput} type="file" accept="application/json,.json" hidden onchange={loadGame} />

<style>
  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
    gap: 1rem;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  h1 {
    margin: 0;
    font-size: 1.35rem;
    letter-spacing: 0.02em;
  }

  .header-actions {
    display: flex;
    gap: 0.5rem;
  }

  .menu {
    display: grid;
    gap: 1rem;
    align-content: start;
    max-width: 32rem;
  }

  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1rem 1.1rem;
    display: grid;
    gap: 0.7rem;
    justify-items: start;
  }

  .card h2 {
    margin: 0;
    font-size: 1rem;
  }

  .card p {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.9em;
  }

  .card label {
    display: grid;
    gap: 0.3rem;
    font-size: 0.9em;
    color: var(--text-dim);
  }

  .card label.check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text);
  }

  .note {
    font-size: 0.82em !important;
  }

  .error {
    margin: 0;
    color: var(--danger);
  }

  .load-row {
    margin: 0;
  }

  .game {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18rem;
    gap: 1.5rem;
  }

  /* The SVG is square and letterboxes itself, so filling the cell in both
     directions keeps the board as large as it can be without overflowing. */
  .board-wrap {
    min-width: 0;
    min-height: 0;
    display: grid;
    place-items: center;
  }

  @media (max-width: 860px) {
    .app {
      height: auto;
      min-height: 100%;
    }

    .game {
      grid-template-columns: minmax(0, 1fr);
    }

    /* Stacked on a phone, an unbounded square board would push the sidebar off
       the screen entirely. */
    .board-wrap {
      max-height: 70vh;
    }
  }
</style>

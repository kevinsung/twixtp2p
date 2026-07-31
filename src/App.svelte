<script lang="ts">
  import Board from './components/Board.svelte';
  import Home from './components/Home.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import ThemeButton from './components/ThemeButton.svelte';
  import Waiting from './components/Waiting.svelte';
  import { codeFromHash } from './lib/net/roomcode';
  import { GameController } from './lib/stores/game.svelte';
  import { OnlineGame } from './lib/stores/online.svelte';
  import { settings } from './lib/stores/settings.svelte';

  type Screen = 'home' | 'waiting' | 'game';

  const game = new GameController();
  const online = new OnlineGame();

  let screen = $state<Screen>('home');
  let isOnline = $state(false);
  /** Sticky once a connection attempt has failed, so home reopens the manual fallback. */
  let relayFailed = $state(false);

  /** A room code or manual invitation carried in the URL fragment. */
  const linkCode = typeof location === 'undefined' ? null : codeFromHash(location.hash);
  const linkOffer =
    typeof location === 'undefined'
      ? null
      : new URLSearchParams(location.hash.replace(/^#/, '')).get('o');

  // An invite link is an instruction, not a suggestion: act on it rather than
  // showing the home screen with a form pre-filled.
  if (linkCode) {
    screen = 'waiting';
    void online.joinViaRelay(game, linkCode, '');
  } else if (linkOffer) {
    screen = 'waiting';
    void online.answerManually(game, linkOffer, '');
  }

  $effect(() => {
    game.skipConfirmation = !settings.confirmMoves;
  });

  // 'auto' means "no opinion" — leave it to the browser's color-scheme.
  $effect(() => {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  });

  // Waiting hands over to the board as soon as the peers are talking.
  $effect(() => {
    if (online.phase === 'connected' && screen === 'waiting') {
      screen = 'game';
      isOnline = true;
    }
    if (online.phase === 'error') relayFailed = true;
  });

  function startLocal(size: number): void {
    game.reset(size);
    game.mySeat = null;
    isOnline = false;
    screen = 'game';
  }

  function startLoaded(): void {
    game.mySeat = null;
    isOnline = false;
    screen = 'game';
  }

  function leaveGame(): void {
    online.leave();
    isOnline = false;
    game.mySeat = null;
    screen = 'home';
    if (typeof location !== 'undefined' && location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
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

<div class="app" class:wide={screen === 'game'}>
  <!-- The game screen carries both controls in its sidebar, leaving the header
       with nothing to hold and the board with more room. -->
  {#if screen !== 'game'}
    <header>
      <!-- The home screen carries its own wordmark, so the header would repeat it. -->
      <h1 class:hidden={screen === 'home'}>TwixT</h1>
      <ThemeButton />
    </header>
  {/if}

  {#if screen === 'home'}
    <main>
      <Home
        {game}
        {online}
        openManual={relayFailed}
        onLocal={startLocal}
        onConnecting={() => (screen = 'waiting')}
        onLoaded={startLoaded}
      />
    </main>
  {:else if screen === 'waiting'}
    <main>
      <Waiting {online} onBack={leaveGame} />
    </main>
  {:else}
    <main class="game">
      <Sidebar {game} online={isOnline ? online : null} onLeave={leaveGame} />
      <div class="board-wrap">
        <Board
          view={game.view}
          committed={game.committed}
          pendingPlace={game.pending?.place ?? null}
          interactive={game.isMyTurn}
          onCell={(cell) => game.clickCell(cell)}
          onLink={(a, b) => game.toggleLink(a, b)}
        />
      </div>
    </main>
  {/if}
</div>

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

  /* The board is only as big as the space it is given, so the game screen takes
     the whole window rather than the measure that suits prose. */
  .app.wide {
    max-width: none;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  h1 {
    margin: 0;
    font-size: 1.35rem;
    letter-spacing: 0.02em;
  }

  h1.hidden {
    visibility: hidden;
  }

  /* The home and waiting screens centre themselves in whatever is left. */
  main {
    flex: 1;
    min-height: 0;
  }

  .game {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
  }

  /* The SVG is square, so the wrapper claims exactly the square it will draw:
     width follows the row height via aspect-ratio, leaving no dead space beside
     the board. When width runs short the wrapper shrinks and the SVG letterboxes
     vertically instead, which costs no horizontal space. */
  .board-wrap {
    flex: 0 1 auto;
    min-width: 0;
    min-height: 0;
    height: 100%;
    aspect-ratio: 1;
  }

  @media (max-width: 860px) {
    .app {
      height: auto;
      min-height: 100%;
    }

    .game {
      flex-direction: column;
    }

    /* Stacked on a phone, an unbounded square board would push the sidebar off
       the screen entirely. The board still reads first. */
    .board-wrap {
      order: -1;
      height: auto;
      aspect-ratio: auto;
      max-height: 70vh;
    }
  }
</style>

<script lang="ts">
  /**
   * The landing screen: every way into a game, one card each.
   *
   * Creating and joining a room sit side by side here rather than behind a
   * submenu, because a room code is the normal way two people start a game.
   * The manual handshake is the exception — it only matters when relays are
   * blocked — so it lives in a disclosure that opens itself after a relay
   * attempt has failed.
   */
  import { BOARD_SIZES, DEFAULT_SIZE, seatName, type Seat } from '../lib/engine/board';
  import { parseTranscript } from '../lib/engine/notation';
  import { isValidCode, normalizeCode } from '../lib/net/roomcode';
  import type { GameController } from '../lib/stores/game.svelte';
  import type { OnlineGame } from '../lib/stores/online.svelte';

  interface Props {
    game: GameController;
    online: OnlineGame;
    /** Open the manual disclosure — a relay attempt has already failed. */
    openManual?: boolean;
    onLocal: (size: number) => void;
    /** Start a game against the built-in engine, with the human on `humanSeat`. */
    onComputer: (size: number, humanSeat: Seat) => void;
    /** A connection attempt has started; show the waiting screen. */
    onConnecting: () => void;
    /** A transcript was replayed into the controller; show the board. */
    onLoaded: () => void;
  }

  let {
    game,
    online,
    openManual = false,
    onLocal,
    onComputer,
    onConnecting,
    onLoaded,
  }: Props = $props();

  type SeatChoice = 0 | 1 | 'random';

  let localSize = $state<number>(DEFAULT_SIZE);
  let botSize = $state<number>(DEFAULT_SIZE);
  let botSeatChoice = $state<SeatChoice>(0);
  let roomSize = $state<number>(DEFAULT_SIZE);
  let seatChoice = $state<SeatChoice>(0);
  let joinCode = $state('');
  let transcript = $state('');
  let loadError = $state<string | null>(null);
  let offerInput = $state('');
  let busy = $state(false);

  const SEATS: Array<{ value: SeatChoice; label: string }> = [
    { value: 0, label: seatName(0) },
    { value: 1, label: seatName(1) },
    { value: 'random', label: 'Random' },
  ];

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    onConnecting();
    try {
      await action();
    } finally {
      busy = false;
    }
  }

  function pickSeat(choice: SeatChoice): Seat {
    return choice === 'random' ? (Math.random() < 0.5 ? 0 : 1) : choice;
  }

  function startComputer(): void {
    onComputer(botSize, pickSeat(botSeatChoice));
  }

  function createRoom(): void {
    const hostSeat = pickSeat(seatChoice);
    game.reset(roomSize);
    void run(() => online.hostViaRelay(game, { name: '', size: roomSize, hostSeat }));
  }

  function joinRoom(): void {
    void run(() => online.joinViaRelay(game, normalizeCode(joinCode), ''));
  }

  function createInvitation(): void {
    const hostSeat = pickSeat(seatChoice);
    game.reset(roomSize);
    void run(() => online.hostManually(game, { name: '', size: roomSize, hostSeat }));
  }

  function answerInvitation(): void {
    void run(() => online.answerManually(game, offerInput.trim(), ''));
  }

  function load(): void {
    const parsed = parseTranscript(transcript);
    if (!parsed.ok) {
      loadError = `Could not read that transcript: ${parsed.error}.`;
      return;
    }

    try {
      game.loadMoves(parsed.size, parsed.moves);
    } catch (error) {
      // Well-formed notation can still describe a position the rules forbid.
      loadError = error instanceof Error ? error.message : 'That is not a legal game.';
      return;
    }

    loadError = null;
    onLoaded();
  }
</script>

<div class="home">
  <h1 class="wordmark">TwixT</h1>

  <div class="cards">
    <div class="card">
      <h2>Local game</h2>
      <p>Two players, one device</p>
      <div class="seg-row" role="radiogroup" aria-label="Board size">
        {#each BOARD_SIZES as size (size)}
          <button role="radio" aria-checked={localSize === size} onclick={() => (localSize = size)}>
            {size}
          </button>
        {/each}
      </div>
      <button class="primary wide" onclick={() => onLocal(localSize)}>Start</button>
    </div>

    <div class="card">
      <h2>Create room</h2>
      <p>Play a friend over the internet</p>
      <div class="seg-row" role="radiogroup" aria-label="Board size">
        {#each BOARD_SIZES as size (size)}
          <button role="radio" aria-checked={roomSize === size} onclick={() => (roomSize = size)}>
            {size}
          </button>
        {/each}
      </div>
      <div class="seg-row" role="radiogroup" aria-label="You play">
        {#each SEATS as seat (seat.label)}
          <button
            role="radio"
            aria-checked={seatChoice === seat.value}
            onclick={() => (seatChoice = seat.value)}
          >
            {seat.label}
          </button>
        {/each}
      </div>
      <button class="primary wide" disabled={busy} onclick={createRoom}>Create</button>
    </div>

    <form
      class="card"
      onsubmit={(event) => {
        event.preventDefault();
        if (isValidCode(joinCode)) joinRoom();
      }}
    >
      <h2>Join room</h2>
      <div class="row">
        <input
          type="text"
          class="code-input"
          bind:value={joinCode}
          placeholder="Room code"
          aria-label="Room code"
          spellcheck="false"
          autocapitalize="characters"
          autocomplete="off"
        />
        <button type="submit" class="primary" disabled={busy || !isValidCode(joinCode)}>Join</button>
      </div>
    </form>

    <div class="card">
      <h2>Play the computer</h2>
      <p>An opponent that runs in this tab</p>
      <div class="seg-row" role="radiogroup" aria-label="Board size for the computer game">
        {#each BOARD_SIZES as size (size)}
          <button role="radio" aria-checked={botSize === size} onclick={() => (botSize = size)}>
            {size}
          </button>
        {/each}
      </div>
      <div class="seg-row" role="radiogroup" aria-label="You play against the computer">
        {#each SEATS as seat (seat.label)}
          <button
            role="radio"
            aria-checked={botSeatChoice === seat.value}
            onclick={() => (botSeatChoice = seat.value)}
          >
            {seat.label}
          </button>
        {/each}
      </div>
      <button class="primary wide" onclick={startComputer}>Play</button>
    </div>

    <div class="card">
      <h2>Load a game</h2>
      <div class="row">
        <input
          type="text"
          bind:value={transcript}
          placeholder="Paste a transcript"
          aria-label="Game transcript"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="primary" disabled={transcript.trim().length === 0} onclick={load}>Load</button>
      </div>
      {#if loadError}
        <p class="error" role="alert">{loadError}</p>
      {/if}
    </div>
  </div>

  <div class="footnotes">
    <p class="note">Games run browser-to-browser; a public relay only introduces you.</p>

    <details open={openManual}>
      <summary>Relays blocked? Set up a game by hand</summary>
      <div class="manual">
        <p class="note">
          You send an invitation over any chat app and paste the reply back. Slower, but it needs no
          relay at all. The board size and seat above still apply.
        </p>
        <button disabled={busy} onclick={createInvitation}>Create invitation</button>
        <label class="field">
          Or paste an invitation you were sent
          <textarea bind:value={offerInput} rows="3" spellcheck="false"></textarea>
        </label>
        <button
          class="primary"
          disabled={busy || offerInput.trim().length === 0}
          onclick={answerInvitation}
        >
          Generate reply
        </button>
      </div>
    </details>
  </div>
</div>

<style>
  .wordmark {
    margin: 0;
    font-size: 2.2rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    width: min(30rem, 92vw);
  }

  .row {
    display: flex;
    gap: 0.5rem;
    width: 100%;
  }

  .row input {
    flex: 1;
    min-width: 0;
  }

  .code-input {
    font-family: var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .wide {
    width: 100%;
  }

  .error {
    margin: 0;
    color: var(--danger);
    font-size: 0.88em;
  }

  .footnotes {
    width: min(30rem, 92vw);
    display: grid;
    gap: 0.5rem;
    justify-items: center;
    text-align: center;
  }

  .note {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.85em;
  }

  summary {
    color: var(--text-dim);
    font-size: 0.85em;
    cursor: pointer;
  }

  .manual {
    display: grid;
    gap: 0.6rem;
    justify-items: start;
    text-align: left;
    margin-top: 0.7rem;
    padding: 0.9rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
  }

  .field {
    display: grid;
    gap: 0.3rem;
    width: 100%;
    font-size: 0.9em;
    color: var(--text-dim);
  }

  .manual textarea {
    width: 100%;
    font-family: var(--font-mono);
    font-size: 0.75em;
    resize: vertical;
  }
</style>

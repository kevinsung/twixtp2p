<script lang="ts">
  import { untrack } from 'svelte';

  import { BOARD_SIZES, DEFAULT_SIZE, seatName } from '../lib/engine/board';
  import { NAT_FAILURE_ADVICE } from '../lib/net/ice';
  import { formatCode, isValidCode, normalizeCode, shareLink } from '../lib/net/roomcode';
  import type { GameController } from '../lib/stores/game.svelte';
  import type { OnlineGame } from '../lib/stores/online.svelte';
  import { settings } from '../lib/stores/settings.svelte';

  interface Props {
    game: GameController;
    online: OnlineGame;
    /** A room code lifted from the share link, if the app was opened from one. */
    initialCode?: string | null;
    /** A manual invitation lifted from the share link. */
    initialOffer?: string | null;
    onBack: () => void;
  }

  let { game, online, initialCode = null, initialOffer = null, onBack }: Props = $props();

  type Path = 'relay' | 'manual';
  type Role = 'host' | 'join';

  // Opening an invite link should drop you straight onto the right form. These
  // read the link once to seed the form; later edits belong to the user.
  let path = $state<Path>(untrack(() => (initialOffer ? 'manual' : 'relay')));
  let role = $state<Role>(untrack(() => (initialCode || initialOffer ? 'join' : 'host')));
  let size = $state<number>(DEFAULT_SIZE);
  let hostPlayer = $state<0 | 1>(0);
  let joinCode = $state(untrack(() => initialCode ?? ''));
  let offerInput = $state(untrack(() => initialOffer ?? ''));
  let answerInput = $state('');
  let copied = $state<string | null>(null);
  let busy = $state(false);

  let shareUrl = $derived(online.code ? shareLink(online.code) : '');

  async function copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      setTimeout(() => (copied = null), 1800);
    } catch {
      copied = null;
    }
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
    }
  }

  function startRelayHost(): void {
    game.reset(size);
    void run(() =>
      online.hostViaRelay(game, { name: settings.playerName || 'Player', size, hostPlayer }),
    );
  }

  function startRelayJoin(): void {
    game.reset(size);
    void run(() =>
      online.joinViaRelay(game, normalizeCode(joinCode), settings.playerName || 'Player'),
    );
  }

  function startManualHost(): void {
    game.reset(size);
    void run(() =>
      online.hostManually(game, { name: settings.playerName || 'Player', size, hostPlayer }),
    );
  }

  function startManualJoin(): void {
    void run(() =>
      online.answerManually(game, offerInput.trim(), settings.playerName || 'Player'),
    );
  }

  function submitAnswer(): void {
    void run(() => online.acceptManualAnswer(answerInput.trim()));
  }

  let manualInviteLink = $derived(
    online.handshakeCode && typeof location !== 'undefined'
      ? `${location.origin}${location.pathname}#o=${online.handshakeCode}`
      : '',
  );
</script>

<div class="lobby">
  <div class="topline">
    <button onclick={onBack}>← Back</button>
    <label class="name">
      Your name
      <input type="text" bind:value={settings.playerName} placeholder="Player" maxlength="24" />
    </label>
  </div>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={path === 'relay'} onclick={() => (path = 'relay')}>
      Room code
    </button>
    <button role="tab" aria-selected={path === 'manual'} onclick={() => (path = 'manual')}>
      Manual invite
    </button>
  </div>

  <p class="blurb">
    {#if path === 'relay'}
      Share a code and the two browsers find each other through public relays. Nothing is deployed
      or hosted by this app, and once you are connected the game runs directly between you.
    {:else}
      No relays at all. You send an invitation over any chat app and paste the reply back. Slower,
      but it works when relays are blocked.
    {/if}
  </p>

  {#if online.phase === 'idle' || online.phase === 'error'}
    <div class="roles" role="tablist">
      <button role="tab" aria-selected={role === 'host'} onclick={() => (role = 'host')}>
        Start a game
      </button>
      <button role="tab" aria-selected={role === 'join'} onclick={() => (role = 'join')}>
        Join a game
      </button>
    </div>

    {#if role === 'host'}
      <div class="fields">
        <label>
          Board size
          <select bind:value={size}>
            {#each BOARD_SIZES as option (option)}
              <option value={option}
                >{option} × {option}{option === DEFAULT_SIZE ? ' (standard)' : ''}</option
              >
            {/each}
          </select>
        </label>
        <label>
          You play
          <select bind:value={hostPlayer}>
            <option value={0}>{seatName(0)} — moves first</option>
            <option value={1}>{seatName(1)} — may swap</option>
          </select>
        </label>
      </div>
      <button
        class="primary"
        disabled={busy}
        onclick={path === 'relay' ? startRelayHost : startManualHost}
      >
        {path === 'relay' ? 'Create room' : 'Create invitation'}
      </button>
    {:else if path === 'relay'}
      <label class="fields">
        Room code
        <input
          type="text"
          bind:value={joinCode}
          placeholder="4K9M-8HQ2"
          spellcheck="false"
          autocapitalize="characters"
        />
      </label>
      <button class="primary" disabled={busy || !isValidCode(joinCode)} onclick={startRelayJoin}>
        Join
      </button>
    {:else}
      <label class="fields">
        Paste the invitation you were sent
        <textarea bind:value={offerInput} rows="4" spellcheck="false"></textarea>
      </label>
      <button class="primary" disabled={busy || offerInput.trim().length === 0} onclick={startManualJoin}>
        Generate reply
      </button>
    {/if}
  {/if}

  {#if online.phase === 'starting'}
    <p class="pending">Connecting…</p>
  {/if}

  {#if online.phase === 'waiting' && online.code}
    <div class="share">
      <h3>Waiting for your opponent</h3>
      <p class="code">{formatCode(online.code)}</p>
      <div class="share-actions">
        <button onclick={() => copy(online.code!, 'code')}>Copy code</button>
        <button onclick={() => copy(shareUrl, 'link')}>Copy invite link</button>
      </div>
      <p class="hint">
        Send either one. The code is also the encryption key, so relays only ever see a hash of it.
      </p>
    </div>
  {/if}

  {#if online.phase === 'awaiting-answer' && online.handshakeCode}
    <div class="share">
      {#if online.isHost}
        <h3>Step 1 — send this invitation</h3>
        <textarea readonly rows="3" value={manualInviteLink}></textarea>
        <div class="share-actions">
          <button onclick={() => copy(manualInviteLink, 'invite')}>Copy invitation</button>
        </div>
        <h3>Step 2 — paste their reply</h3>
        <textarea bind:value={answerInput} rows="3" spellcheck="false"></textarea>
        <button class="primary" disabled={busy || answerInput.trim().length === 0} onclick={submitAnswer}>
          Connect
        </button>
      {:else}
        <h3>Send this reply back</h3>
        <textarea readonly rows="3" value={online.handshakeCode}></textarea>
        <div class="share-actions">
          <button onclick={() => copy(online.handshakeCode!, 'reply')}>Copy reply</button>
        </div>
        <p class="hint">The game starts as soon as they paste it in.</p>
      {/if}
    </div>
  {/if}

  {#if copied}
    <p class="copied" role="status">Copied {copied} to the clipboard.</p>
  {/if}

  {#if online.error}
    <div class="error" role="alert">
      <p>{online.error}</p>
      {#if online.error === NAT_FAILURE_ADVICE}
        <!-- Already the full explanation; nothing to add. -->
      {:else if online.phase === 'error'}
        <p class="hint">{NAT_FAILURE_ADVICE}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .lobby {
    display: grid;
    gap: 1rem;
    align-content: start;
    max-width: 34rem;
  }

  .topline {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
  }

  .name {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85em;
    color: var(--text-dim);
  }

  .tabs,
  .roles {
    display: flex;
    gap: 0.4rem;
  }

  .tabs button[aria-selected='true'],
  .roles button[aria-selected='true'] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
  }

  .blurb {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.9em;
  }

  .fields {
    display: grid;
    gap: 0.3rem;
    font-size: 0.9em;
    color: var(--text-dim);
  }

  .fields:has(select) {
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .fields label {
    display: grid;
    gap: 0.3rem;
  }

  .share {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1rem;
    display: grid;
    gap: 0.6rem;
  }

  .share h3 {
    margin: 0;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-faint);
  }

  .code {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 1.9rem;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .share-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  textarea {
    font-family: var(--font-mono);
    font-size: 0.75em;
    width: 100%;
    resize: vertical;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 0.5rem;
  }

  .hint {
    margin: 0;
    font-size: 0.82em;
    color: var(--text-faint);
  }

  .pending {
    margin: 0;
    color: var(--text-dim);
  }

  .copied {
    margin: 0;
    font-size: 0.85em;
    color: var(--last-move);
  }

  .error {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    border-radius: 10px;
    padding: 0.7rem 0.9rem;
    display: grid;
    gap: 0.4rem;
  }

  .error p {
    margin: 0;
    color: var(--danger);
    font-size: 0.9em;
  }

  input[type='text'] {
    font-family: var(--font-mono);
  }
</style>

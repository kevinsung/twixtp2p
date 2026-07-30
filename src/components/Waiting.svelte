<script lang="ts">
  /**
   * Everything between "I asked to connect" and "we are playing": the room code
   * to share, the manual handshake's two paste steps, and connection failures.
   */
  import { NAT_FAILURE_ADVICE } from '../lib/net/ice';
  import { copyText } from '../lib/net/clipboard';
  import { formatCode, shareLink } from '../lib/net/roomcode';
  import type { OnlineGame } from '../lib/stores/online.svelte';

  interface Props {
    online: OnlineGame;
    onBack: () => void;
  }

  let { online, onBack }: Props = $props();

  let answerInput = $state('');
  let copied = $state<string | null>(null);
  let busy = $state(false);

  let shareUrl = $derived(online.code ? shareLink(online.code) : '');

  let manualInviteLink = $derived(
    online.handshakeCode && typeof location !== 'undefined'
      ? `${location.origin}${location.pathname}#o=${online.handshakeCode}`
      : '',
  );

  async function copy(text: string, label: string): Promise<void> {
    copied = (await copyText(text)) ? label : null;
    if (copied) setTimeout(() => (copied = null), 1800);
  }

  function submitAnswer(): void {
    busy = true;
    void online.acceptManualAnswer(answerInput.trim()).finally(() => (busy = false));
  }
</script>

<div class="home">
  <div class="cards">
    {#if online.phase === 'error'}
      <div class="card error-card" role="alert">
        <h2>Could not connect</h2>
        <p class="danger">{online.error ?? 'The connection failed.'}</p>
        {#if online.error !== NAT_FAILURE_ADVICE}
          <p>{NAT_FAILURE_ADVICE}</p>
        {/if}
      </div>
    {:else if online.phase === 'awaiting-answer' && online.handshakeCode}
      {#if online.isHost}
        <div class="card">
          <h2>Step 1 — send this invitation</h2>
          <textarea readonly rows="3" value={manualInviteLink}></textarea>
          <button onclick={() => copy(manualInviteLink, 'invitation')}>Copy invitation</button>
        </div>
        <div class="card">
          <h2>Step 2 — paste their reply</h2>
          <textarea bind:value={answerInput} rows="3" spellcheck="false"></textarea>
          <button
            class="primary"
            disabled={busy || answerInput.trim().length === 0}
            onclick={submitAnswer}
          >
            Connect
          </button>
        </div>
      {:else}
        <div class="card">
          <h2>Send this reply back</h2>
          <textarea readonly rows="3" value={online.handshakeCode}></textarea>
          <button onclick={() => copy(online.handshakeCode!, 'reply')}>Copy reply</button>
          <p>The game starts as soon as they paste it in.</p>
        </div>
      {/if}
    {:else if online.code}
      <div class="card">
        {#if online.isHost}
          <h2>Room code</h2>
          <p class="code">{formatCode(online.code)}</p>
          <div class="row">
            <button onclick={() => copy(online.code!, 'code')}>Copy code</button>
            <button onclick={() => copy(shareUrl, 'link')}>Copy invite link</button>
          </div>
          <p>
            Send either one. The code is also the encryption key, so relays only ever see a hash of
            it.
          </p>
          <p class="pending">Waiting for your opponent…</p>
        {:else}
          <h2>Joining room {formatCode(online.code)}…</h2>
          <p>Waiting for your opponent…</p>
        {/if}
      </div>
    {:else}
      <div class="card">
        <h2>Connecting…</h2>
      </div>
    {/if}

    <!-- A rejected paste leaves the handshake standing, so the message belongs
         next to the form rather than on the failure card. -->
    {#if online.error && online.phase !== 'error'}
      <p class="danger" role="alert">{online.error}</p>
    {/if}

    {#if copied}
      <p class="copied" role="status">Copied {copied} to the clipboard.</p>
    {/if}

    <button class="back" onclick={onBack}>← Back</button>
  </div>
</div>

<style>
  .cards {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    width: min(30rem, 92vw);
  }

  .card p {
    font-size: 0.85em;
    color: var(--text-faint);
  }

  .code {
    font-family: var(--font-mono);
    font-size: 1.9rem !important;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: var(--text) !important;
  }

  .pending {
    font-size: 0.95em !important;
    color: var(--text-dim) !important;
  }

  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  textarea {
    width: 100%;
    font-family: var(--font-mono);
    font-size: 0.75em;
    resize: vertical;
  }

  .error-card {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    background: color-mix(in srgb, var(--danger) 8%, var(--panel));
  }

  .danger {
    margin: 0;
    color: var(--danger) !important;
    font-size: 0.95em !important;
  }

  .copied {
    margin: 0;
    font-size: 0.85em;
    color: var(--last-move);
  }

  .back {
    justify-self: start;
    align-self: start;
  }
</style>

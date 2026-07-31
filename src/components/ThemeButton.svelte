<script lang="ts">
  import { settings } from '../lib/stores/settings.svelte';

  function cycleTheme(): void {
    settings.theme =
      settings.theme === 'auto' ? 'light' : settings.theme === 'light' ? 'dark' : 'auto';
  }

  let themeLabel = $derived(
    settings.theme === 'auto'
      ? 'Theme: auto'
      : settings.theme === 'light'
        ? 'Theme: light'
        : 'Theme: dark',
  );
</script>

<!-- An icon, so the label lives in aria-label rather than on screen. -->
<button
  class="theme"
  onclick={cycleTheme}
  title="Switch between automatic, light and dark"
  aria-label={themeLabel}
>
  {#if settings.theme === 'auto'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  {:else if settings.theme === 'light'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path
        d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"
        stroke-linecap="round"
      />
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path
        d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"
        fill="currentColor"
        stroke-linejoin="round"
      />
    </svg>
  {/if}
</button>

<style>
  /* The base button rule pads for text; an icon needs it even on all sides. */
  .theme {
    padding: 0.4em;
  }

  svg {
    width: 1.05em;
    height: 1.05em;
    display: block;
  }
</style>

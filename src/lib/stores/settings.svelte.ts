/** User preferences, persisted to localStorage. */

// v2 dropped the coordinate and name preferences and inverted the confirmation
// one; a stored v1 blob must not reinstate the old defaults.
const STORAGE_KEY = 'twixt.settings.v2';

export type ThemeChoice = 'auto' | 'light' | 'dark';

interface Stored {
  confirmMoves?: boolean;
  theme?: ThemeChoice;
}

export class Settings {
  /**
   * Compose a turn before committing it, which is what allows link editing.
   * Off by default: placing a peg is the common case and confirming every one
   * of them is a tax on it.
   */
  confirmMoves = $state(false);
  theme = $state<ThemeChoice>('auto');

  constructor() {
    this.load();
  }

  private load(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Stored;
      if (typeof data.confirmMoves === 'boolean') this.confirmMoves = data.confirmMoves;
      if (data.theme === 'auto' || data.theme === 'light' || data.theme === 'dark') {
        this.theme = data.theme;
      }
    } catch {
      // A corrupt preferences blob is not worth surfacing — fall back to defaults.
    }
  }

  save(): void {
    if (typeof localStorage === 'undefined') return;
    const data: Stored = {
      confirmMoves: this.confirmMoves,
      theme: this.theme,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Private browsing modes can refuse writes; preferences simply won't persist.
    }
  }
}

export const settings = new Settings();

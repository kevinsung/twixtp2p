/** User preferences, persisted to localStorage. */

const STORAGE_KEY = 'twixt.settings.v1';

export type ThemeChoice = 'auto' | 'light' | 'dark';

interface Stored {
  skipConfirmation?: boolean;
  showCoordinates?: boolean;
  theme?: ThemeChoice;
  playerName?: string;
}

export class Settings {
  /** Commit a move the moment a peg is placed, skipping link editing. */
  skipConfirmation = $state(false);
  showCoordinates = $state(true);
  theme = $state<ThemeChoice>('auto');
  playerName = $state('');

  constructor() {
    this.load();
  }

  private load(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Stored;
      if (typeof data.skipConfirmation === 'boolean') this.skipConfirmation = data.skipConfirmation;
      if (typeof data.showCoordinates === 'boolean') this.showCoordinates = data.showCoordinates;
      if (data.theme === 'auto' || data.theme === 'light' || data.theme === 'dark') {
        this.theme = data.theme;
      }
      if (typeof data.playerName === 'string') this.playerName = data.playerName.slice(0, 24);
    } catch {
      // A corrupt preferences blob is not worth surfacing — fall back to defaults.
    }
  }

  save(): void {
    if (typeof localStorage === 'undefined') return;
    const data: Stored = {
      skipConfirmation: this.skipConfirmation,
      showCoordinates: this.showCoordinates,
      theme: this.theme,
      playerName: this.playerName,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Private browsing modes can refuse writes; preferences simply won't persist.
    }
  }
}

export const settings = new Settings();

/** User preferences for the current session. Nothing is persisted. */

export type ThemeChoice = 'auto' | 'light' | 'dark';

export class Settings {
  /**
   * Compose a turn before committing it. On by default: confirmation is what
   * makes link editing reachable at all, since without it a move commits the
   * moment a peg is placed.
   */
  confirmMoves = $state(true);
  theme = $state<ThemeChoice>('auto');
}

export const settings = new Settings();

/**
 * The bot's one tunable.
 *
 * A single strength, not a ladder of them: a difficulty slider on a search
 * engine means crippling it in ways that read as random blunders rather than as
 * a weaker opponent. Tests reach in and shorten the budget so they do not spend
 * a second and a half per move.
 */
export const botConfig = {
  /** Thinking time per move, in milliseconds. */
  budgetMs: 1500,
};

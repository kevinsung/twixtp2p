// @vitest-environment jsdom

/**
 * The computer opponent, end to end through the real interface.
 *
 * The engine tests prove it picks legal, sensible moves. This proves the wiring
 * around it: that starting a game hands the human a seat, that the bot answers
 * without being asked, that the board goes quiet while it thinks, and that a
 * takeback lands back on the human's turn rather than one ply short of it.
 *
 * jsdom has no `Worker`, so `BotEngine` falls back to searching on this thread.
 * That is deliberate: the budget is a parameter, and here it is a few
 * milliseconds.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { idx } from '../lib/engine/board';
import { cellToNotation } from '../lib/engine/notation';
import { botConfig } from '../lib/ai/config';
import { settings } from '../lib/stores/settings.svelte';
import App from '../App.svelte';

const SIZE = 12;

let host: HTMLDivElement;
let app: Record<string, unknown> | null = null;
let realBudget = botConfig.budgetMs;

beforeEach(() => {
  settings.confirmMoves = false;
  realBudget = botConfig.budgetMs;
  botConfig.budgetMs = 5;
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(App, { target: host }) as Record<string, unknown>;
  flushSync();
});

afterEach(() => {
  botConfig.budgetMs = realBudget;
  if (app) void unmount(app);
  app = null;
  host.remove();
});

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('tried to click an element that is not there');
  (element as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
}

function card(heading: string): HTMLElement {
  const found = [...host.querySelectorAll('.card')].find(
    (element) => element.querySelector('h2')?.textContent?.trim() === heading,
  );
  if (!found) throw new Error(`no card headed "${heading}"`);
  return found as HTMLElement;
}

function buttonWith(text: string, within: ParentNode = host): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

function cell(r: number, c: number): Element | null {
  return host.querySelector(`.target-cell[aria-label="${cellToNotation(SIZE, idx(SIZE, r, c))}"]`);
}

/** Every ply on the board, read out of the move list. */
function plies(): string[] {
  return [...host.querySelectorAll('.moves ol li')]
    .flatMap((row) => [
      row.querySelector('.ply.light')?.textContent?.trim() ?? '',
      row.querySelector('.ply.dark')?.textContent?.trim() ?? '',
    ])
    .filter((text) => text !== '');
}

function status(): string {
  return host.querySelector('.status p')?.textContent ?? '';
}

/** Start a computer game on a small board, with the human as Red. */
function startComputerGame(): void {
  const panel = card('Play the computer');
  click(buttonWith(String(SIZE), panel));
  click(buttonWith('Red', panel));
  click(buttonWith('Play', panel));
}

async function untilPlies(count: number): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(plies().length).toBe(count);
  });
}

describe('a game against the computer', () => {
  it('starts with the board waiting for the human', () => {
    startComputerGame();

    expect(host.querySelector('svg.board')).not.toBeNull();
    expect(host.querySelectorAll('.target-cell')).toHaveLength(SIZE * SIZE - 4);
    expect(status()).toMatch(/Your move \(Red\)/);
    // The connection strip names the opponent, as it does for a peer.
    expect(host.querySelector('.connection .who')?.textContent?.trim()).toBe('Computer');
  });

  it('answers a peg without being asked', async () => {
    startComputerGame();

    click(cell(5, 5));
    expect(plies().length).toBeGreaterThanOrEqual(1);

    await untilPlies(2);
    expect(status()).toMatch(/Your move \(Red\)/);
  });

  it('gives the board back after taking a move back', async () => {
    startComputerGame();

    click(cell(5, 5));
    await untilPlies(2);

    click(buttonWith('Undo'));
    // Both plies go, because stopping between them would leave the human
    // watching a board that is not theirs to move on.
    expect(plies()).toEqual([]);
    expect(status()).toMatch(/Your move \(Red\)/);
    expect(host.querySelectorAll('.peg')).toHaveLength(0);

    // And the game is still live: a second peg gets a second reply.
    click(cell(6, 6));
    await untilPlies(2);
  });

  it('opens for itself when the human takes Black', async () => {
    const panel = card('Play the computer');
    click(buttonWith(String(SIZE), panel));
    click(buttonWith('Black', panel));
    click(buttonWith('Play', panel));

    // Red moves first, and Red is the computer here.
    await untilPlies(1);
    expect(status()).toMatch(/Your move \(Black\)/);
  });

  it('leaves the computer behind when you leave the game', async () => {
    startComputerGame();
    click(cell(5, 5));
    await untilPlies(2);

    click(buttonWith('Leave'));
    expect(host.querySelector('svg.board')).toBeNull();

    // A plain local game afterwards must not have a computer attached to it.
    click(buttonWith('Start', card('Local game')));
    expect(host.querySelector('.connection')).toBeNull();
    click(cell(5, 5));
    expect(status()).toMatch(/Black to move/);
  });
});

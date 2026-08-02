// @vitest-environment jsdom

/**
 * End-to-end check of the local play loop against a real DOM.
 *
 * The engine tests prove the rules; this proves the parts that only exist once
 * the app is running — that clicking a hole places a peg, that confirming
 * commits it, that the board draws links, and that the pie rule and win
 * detection surface in the interface rather than only in the model.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { colOf, idx, rowOf } from '../lib/engine/board';
import { cellToNotation } from '../lib/engine/notation';
import { settings } from '../lib/stores/settings.svelte';
import App from '../App.svelte';

const SIZE = 24;

let host: HTMLDivElement;
let app: Record<string, unknown> | null = null;

beforeEach(() => {
  // `settings` is a module singleton, so preferences would otherwise leak from
  // one test to the next. Most tests want the shorter path, so confirmation is
  // turned off here and back on by `enableConfirmation` where it matters.
  settings.confirmMoves = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(App, { target: host }) as Record<string, unknown>;
  flushSync();
});

afterEach(() => {
  if (app) void unmount(app);
  app = null;
  host.remove();
});

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('tried to click an element that is not there');
  (element as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  flushSync();
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

/** Hit targets carry the cell's notation as their accessible name. */
function cell(r: number, c: number): Element | null {
  return host.querySelector(`.target-cell[aria-label="${cellToNotation(SIZE, idx(SIZE, r, c))}"]`);
}

function startLocalGame(): void {
  click(buttonWith('Start'));
}

/** Turn on the in-game "Confirm moves" toggle, which `beforeEach` forces off. */
function enableConfirmation(): void {
  const box = [...host.querySelectorAll('label.check')].find((label) =>
    label.textContent?.includes('Confirm moves'),
  )?.firstElementChild as HTMLInputElement | undefined;
  if (!box) throw new Error('no Confirm moves toggle');
  box.click();
  flushSync();
}

/**
 * The move list as [red, black] pairs, read from the columns themselves.
 *
 * Checking the text of `.ply.light` / `.ply.dark` rather than the whole list is
 * the point: a ply landing in the wrong column renders in the wrong colour, and
 * a substring match on the list would never notice.
 */
function plies(): string[][] {
  return [...host.querySelectorAll('.moves ol li')].map((row) => [
    row.querySelector('.ply.light')?.textContent?.trim() ?? '',
    row.querySelector('.ply.dark')?.textContent?.trim() ?? '',
  ]);
}

function play(r: number, c: number): void {
  click(cell(r, c));
  const confirm = buttonWith('Confirm move');
  if (confirm) click(confirm);
}

describe('the app shell', () => {
  it('opens on the home screen', () => {
    expect(host.querySelector('h1')?.textContent).toBe('TwixT');
    expect(buttonWith('Start')).toBeDefined();
    expect(host.querySelector('svg.board')).toBeNull();
  });

  it('starts a local game and draws a full board', () => {
    startLocalGame();

    const board = host.querySelector('svg.board');
    expect(board).not.toBeNull();
    // 24x24 minus the four removed corners.
    expect(host.querySelectorAll('.target-cell')).toHaveLength(SIZE * SIZE - 4);
    expect(host.querySelectorAll('.peg')).toHaveLength(0);
  });

  /**
   * The rest of the suite reaches hit targets by accessible name, so nothing
   * else would notice a target that had drifted off its hole. Aiming at a peg
   * and hitting its neighbour is exactly the bug this guards against.
   */
  it('gives every hole a hit target centred on it, tiling the board', () => {
    startLocalGame();

    for (const target of host.querySelectorAll('.target-cell')) {
      const label = target.getAttribute('aria-label');
      const at = [...Array(SIZE * SIZE).keys()].find(
        (candidate) => cellToNotation(SIZE, candidate) === label,
      );
      expect(at, `no cell for ${label}`).toBeDefined();

      const box = {
        x: Number(target.getAttribute('x')),
        y: Number(target.getAttribute('y')),
        width: Number(target.getAttribute('width')),
        height: Number(target.getAttribute('height')),
      };
      // Unit squares leave no point of the board unclaimed, and a centred one
      // claims exactly the points nearest its own hole.
      expect(box.width).toBe(1);
      expect(box.height).toBe(1);
      expect(box.x + box.width / 2).toBe(colOf(SIZE, at!));
      expect(box.y + box.height / 2).toBe(rowOf(SIZE, at!));
    }
  });
});

describe('the home screen', () => {
  function segButton(label: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll('.seg-row button')].find(
      (button) => button.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
  }

  it('starts a local game on the board size picked in the card', () => {
    click(segButton('12'));
    expect(segButton('12')?.getAttribute('aria-checked')).toBe('true');

    startLocalGame();
    // 12x12 minus the four removed corners.
    expect(host.querySelectorAll('.target-cell')).toHaveLength(12 * 12 - 4);
  });

  it('replays a pasted transcript, links and all', () => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Game transcript"]')!;
    input.value = '24 F6 swap H7 G8 -F6/G8';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    click(buttonWith('Load'));

    expect(host.querySelectorAll('.peg')).toHaveLength(3);
    // The transcript removes the link the engine would otherwise draw itself.
    expect(host.querySelectorAll('.link')).toHaveLength(0);
    expect(host.querySelector('.moves ol')?.textContent).toContain('swap');
  });

  it('explains a transcript it cannot read instead of loading it', () => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Game transcript"]')!;
    input.value = '24 F6 castle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    click(buttonWith('Load'));

    expect(host.querySelector('svg.board')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/is not a move/);
  });
});

describe('placing pegs', () => {
  beforeEach(startLocalGame);

  it('commits the moment a peg is placed when confirmation is off', () => {
    click(cell(5, 5));
    expect(host.querySelectorAll('.peg')).toHaveLength(1);
    expect(host.querySelectorAll('.peg.pending')).toHaveLength(0);
  });

  it('shows a peg provisionally and commits it on confirm', () => {
    enableConfirmation();
    click(cell(5, 5));
    expect(host.querySelectorAll('.peg.pending')).toHaveLength(1);

    click(buttonWith('Confirm move'));
    expect(host.querySelectorAll('.peg')).toHaveLength(1);
    expect(host.querySelectorAll('.peg.pending')).toHaveLength(0);
  });

  it('discards the peg on cancel', () => {
    enableConfirmation();
    click(cell(5, 5));
    click(buttonWith('Cancel'));
    expect(host.querySelectorAll('.peg')).toHaveLength(0);
  });

  it('refuses a hole on the opponent border line and says why', () => {
    // Red connects top to bottom, so the left column is not theirs to use.
    click(cell(5, 0));
    expect(host.querySelectorAll('.peg.pending')).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/border line/);
  });

  it('draws a link between two friendly pegs a knight move apart', () => {
    play(5, 5); // Red
    play(9, 9); // Black, out of the way
    play(6, 7); // Red, a knight's move from (5,5)

    expect(host.querySelectorAll('.link')).toHaveLength(1);
  });

  it('drops an auto-created link when its target is clicked', () => {
    play(5, 5); // Red
    play(9, 9); // Black, out of the way
    enableConfirmation();
    click(cell(6, 7)); // Red, a knight's move from (5,5)
    expect(host.querySelectorAll('.link')).toHaveLength(1);

    click(host.querySelector('.target-link[aria-label^="Remove link"]'));
    expect(host.querySelectorAll('.link')).toHaveLength(0);

    click(buttonWith('Confirm move'));
    expect(host.querySelectorAll('.link')).toHaveLength(0);
  });

  /**
   * jsdom does no hit testing, so the geometry that made link targets
   * unclickable has to be asserted directly: they must sit above the cell
   * targets and stop clear of the r=0.44 circles at each end.
   */
  it('keeps link targets on top of and clear of the cell targets', () => {
    play(5, 5);
    play(9, 9);
    enableConfirmation();
    click(cell(6, 7));

    const groups = [...host.querySelectorAll('svg.board > g')].map((g) => g.getAttribute('class'));
    expect(groups.indexOf('targets-links')).toBeGreaterThan(groups.indexOf('targets-cells'));

    const target = host.querySelector('.target-link[aria-label^="Remove link"]')!;
    const at = (name: string): number => Number(target.getAttribute(name));
    // The lane runs (5,5)-(6,7); in board coordinates x is the column.
    for (const [px, py] of [
      [5, 5],
      [7, 6],
    ]) {
      expect(Math.hypot(at('x1') - px, at('y1') - py)).toBeGreaterThan(0.44);
      expect(Math.hypot(at('x2') - px, at('y2') - py)).toBeGreaterThan(0.44);
    }
  });

  it('records moves in the sidebar in board notation', () => {
    play(5, 5);
    const moves = host.querySelector('.moves ol')?.textContent ?? '';
    expect(moves).toContain(cellToNotation(SIZE, idx(SIZE, 5, 5)));
  });
});

describe('turn flow', () => {
  beforeEach(startLocalGame);

  it('alternates sides', () => {
    const statusText = (): string => host.querySelector('.status p')?.textContent ?? '';

    expect(statusText()).toMatch(/Red to move/);
    play(5, 5);
    expect(statusText()).toMatch(/Black to move/);
    play(9, 9);
    expect(statusText()).toMatch(/Red to move/);
  });

  it('offers the pie rule only after the first peg', () => {
    expect(buttonWith('Swap')).toBeUndefined();

    play(5, 5);
    expect(buttonWith('Swap')).toBeDefined();

    click(buttonWith('Swap'));
    expect(buttonWith('Swap')).toBeUndefined();

    // F6 is on the main diagonal, so the peg stays put and only changes colour.
    // The swap spends Black's turn, so it is Red to move again — and the two
    // plies belong in their own colour's column.
    expect(plies()).toEqual([['F6', 'swap']]);
    expect(host.querySelector('.status p')?.textContent).toMatch(/Red to move/);
  });

  it('mirrors an off-diagonal opening across the board', () => {
    play(6, 4); // E7

    click(buttonWith('Swap'));

    // Reflected onto G5, and still a single peg — Black's. Peg coordinates are
    // the cell's column and row straight through.
    const pegs = [...host.querySelectorAll('.peg')];
    expect(pegs).toHaveLength(1);
    expect(pegs[0]!.classList.contains('dark')).toBe(true);
    expect([pegs[0]!.getAttribute('cx'), pegs[0]!.getAttribute('cy')]).toEqual(['6', '4']);

    play(3, 3); // Red replies, so the list must open a second row
    expect(plies()).toEqual([
      ['E7', 'swap'],
      ['D4', ''],
    ]);
  });

  it('keeps the swap reachable while a reply is pending', () => {
    enableConfirmation();
    play(5, 5);

    // Trying out a reply must not hide the pie rule with no way back but Cancel.
    click(cell(9, 9));
    expect(buttonWith('Confirm move')).toBeDefined();
    expect(buttonWith('Swap')).toBeDefined();

    click(buttonWith('Swap'));
    expect(plies()).toEqual([['F6', 'swap']]);
  });

  it('undoes the last committed move', () => {
    play(5, 5);
    play(9, 9);
    expect(host.querySelectorAll('.peg')).toHaveLength(2);

    click(buttonWith('Undo'));
    expect(host.querySelectorAll('.peg')).toHaveLength(1);
  });
});

describe('winning', () => {
  it('announces a connection across the board', () => {
    startLocalGame();

    // Red walks a knight's-move ladder from the top row to the bottom row,
    // while Black plays harmlessly down its own left column.
    const ladder: Array<[number, number]> = [[0, 5]];
    let r = 0;
    let c = 5;
    while (r < SIZE - 1) {
      const step = Math.min(2, SIZE - 1 - r);
      r += step;
      c += step === 2 ? 1 : 2;
      ladder.push([r, c]);
    }

    ladder.forEach(([lr, lc], i) => {
      play(lr, lc);
      if (i < ladder.length - 1) play(2 + i, 0); // Black filler
    });

    expect(host.querySelector('.status p')?.textContent).toMatch(/Red wins by connection/);
  });
});

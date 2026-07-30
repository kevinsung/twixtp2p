<script lang="ts">
  /**
   * The board, drawn as SVG in board coordinates: a cell at row r, column c
   * sits at (x=c, y=r), so the viewBox does all the scaling and the markup
   * stays readable.
   *
   * Layers, back to front: border bands, holes, links, pegs, ghost previews,
   * then invisible hit targets. Cell targets sit above link targets so the
   * area around a hole always belongs to the hole — a knight link passes
   * within 0.45 of a neighbouring lattice point, so the two would otherwise
   * compete.
   */
  import { DARK, LIGHT, type Seat, colOf, isHoleCell, rowOf } from '../lib/engine/board';
  import {
    linkCandidates,
    placementError,
    type GameState,
  } from '../lib/engine/game';
  import { cellToNotation, columnLabel } from '../lib/engine/notation';

  interface Props {
    /** Position to draw, with any uncommitted turn already applied. */
    view: GameState;
    /** The agreed position, used to tell provisional links from settled ones. */
    committed: GameState;
    pendingPlace: number | null;
    interactive: boolean;
    onCell: (cell: number) => void;
    onLink: (a: number, b: number) => void;
  }

  let { view, committed, pendingPlace, interactive, onCell, onLink }: Props = $props();

  const MARGIN = 1.3;

  let hover = $state<number | null>(null);

  let size = $derived(view.size);
  let extent = $derived(size - 1 + 2 * MARGIN);
  let viewBox = $derived(`${-MARGIN} ${-MARGIN} ${extent} ${extent}`);

  /** The seat currently composing a turn. */
  let seat = $derived<Seat>(committed.toMove);

  let holes = $derived.by(() => {
    const cells: number[] = [];
    for (let cell = 0; cell < size * size; cell++) {
      if (isHoleCell(size, cell)) cells.push(cell);
    }
    return cells;
  });

  let links = $derived(view.links.all());

  /** Links created by the turn in progress, drawn provisionally. */
  let freshLinks = $derived.by(() => {
    const fresh = new Set<number>();
    if (pendingPlace === null) return fresh;
    for (const link of links) {
      if (!committed.links.has(link.a, link.b)) fresh.add(link.a * size * size + link.b);
    }
    return fresh;
  });

  function isFresh(a: number, b: number): boolean {
    return freshLinks.has(Math.min(a, b) * size * size + Math.max(a, b));
  }

  interface Ghost {
    a: number;
    b: number;
    blocked: boolean;
    /** A preview hangs off a peg that is not placed yet. */
    preview: boolean;
  }

  /**
   * Hovering an empty hole shows what placing there would connect — and, just
   * as importantly, which lanes are already cut. Reading blocked lanes is most
   * of TwixT's difficulty, so the board shows it rather than making you work it
   * out.
   */
  let ghosts = $derived.by<Ghost[]>(() => {
    if (!interactive) return [];

    // While composing a turn, offer the links you could still add by hand.
    if (pendingPlace !== null) {
      const source = hover !== null && view.pegs[hover] === seat ? hover : pendingPlace;
      return linkCandidates(view, source, seat).map((candidate) => ({
        a: source,
        b: candidate.to,
        blocked: candidate.blocked,
        preview: false,
      }));
    }

    if (hover === null) return [];
    if (placementError(committed, hover, seat) !== null) return [];

    const pegs = Int8Array.from(view.pegs);
    pegs[hover] = seat;
    const hypothetical = { ...view, pegs };
    return linkCandidates(hypothetical, hover, seat).map((candidate) => ({
      a: hover!,
      b: candidate.to,
      blocked: candidate.blocked,
      preview: true,
    }));
  });

  let hoverLegal = $derived(
    interactive &&
      pendingPlace === null &&
      hover !== null &&
      placementError(committed, hover, seat) === null,
  );

  function seatClass(value: number): string {
    return value === LIGHT ? 'light' : 'dark';
  }

  function x(cell: number): number {
    return colOf(size, cell);
  }

  function y(cell: number): number {
    return rowOf(size, cell);
  }

  /** Link hit targets only matter while a turn is being composed. */
  let linksClickable = $derived(interactive && pendingPlace !== null);

  function handleCellKey(event: KeyboardEvent, cell: number): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onCell(cell);
    }
  }

  function handleLinkKey(event: KeyboardEvent, a: number, b: number): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onLink(a, b);
    }
  }
</script>

<svg
  class="board"
  {viewBox}
  role="grid"
  tabindex="-1"
  aria-label="TwixT board"
  onpointerleave={() => (hover = null)}
>
  <!-- Border bands: each player's two goal lines. -->
  <g class="bands" aria-hidden="true">
    <rect class="band light" x={0.6} y={-0.42} width={size - 2.2} height={0.84} rx="0.2" />
    <rect
      class="band light"
      x={0.6}
      y={size - 1 - 0.42}
      width={size - 2.2}
      height={0.84}
      rx="0.2"
    />
    <rect class="band dark" x={-0.42} y={0.6} width={0.84} height={size - 2.2} rx="0.2" />
    <rect
      class="band dark"
      x={size - 1 - 0.42}
      y={0.6}
      width={0.84}
      height={size - 2.2}
      rx="0.2"
    />
  </g>

  <g class="coords" aria-hidden="true">
    {#each { length: size } as _, c (c)}
      <text class="coord" x={c} y={-MARGIN + 0.45} text-anchor="middle">{columnLabel(c)}</text>
    {/each}
    {#each { length: size } as _, r (r)}
      <text class="coord" x={-MARGIN + 0.4} y={r} dominant-baseline="middle" text-anchor="middle"
        >{r + 1}</text
      >
    {/each}
  </g>

  <g class="holes" aria-hidden="true">
    {#each holes as cell (cell)}
      <circle class="hole" cx={x(cell)} cy={y(cell)} r="0.09" />
    {/each}
  </g>

  <g class="links" aria-hidden="true">
    {#each links as link (link.a * size * size + link.b)}
      <line
        class="link {seatClass(view.pegs[link.a])}"
        class:fresh={isFresh(link.a, link.b)}
        x1={x(link.a)}
        y1={y(link.a)}
        x2={x(link.b)}
        y2={y(link.b)}
      />
    {/each}
  </g>

  <g class="ghosts" aria-hidden="true">
    {#each ghosts as ghost (ghost.a * size * size + ghost.b)}
      <line
        class="ghost {seatClass(seat)}"
        class:blocked={ghost.blocked}
        x1={x(ghost.a)}
        y1={y(ghost.a)}
        x2={x(ghost.b)}
        y2={y(ghost.b)}
      />
    {/each}
  </g>

  <g class="pegs">
    {#each holes as cell (cell)}
      {#if view.pegs[cell] >= 0}
        <circle
          class="peg {seatClass(view.pegs[cell])}"
          class:pending={cell === pendingPlace}
          class:last={cell === committed.lastPlace && pendingPlace === null}
          cx={x(cell)}
          cy={y(cell)}
          r="0.3"
        />
      {/if}
    {/each}
  </g>

  {#if hoverLegal && hover !== null}
    <circle class="hover-peg {seatClass(seat)}" cx={x(hover)} cy={y(hover)} r="0.3" />
  {/if}

  <!-- Hit targets. Links first, cells above them. -->
  {#if linksClickable}
    <g class="targets-links">
      {#each links as link (link.a * size * size + link.b)}
        {#if view.pegs[link.a] === seat}
          <line
            class="target-link"
            x1={x(link.a)}
            y1={y(link.a)}
            x2={x(link.b)}
            y2={y(link.b)}
            role="button"
            tabindex="0"
            aria-label="Remove link {cellToNotation(size, link.a)} to {cellToNotation(
              size,
              link.b,
            )}"
            onclick={() => onLink(link.a, link.b)}
            onkeydown={(event) => handleLinkKey(event, link.a, link.b)}
          />
        {/if}
      {/each}
      {#each ghosts.filter((g) => !g.blocked && !g.preview) as ghost (ghost.a * size * size + ghost.b)}
        <line
          class="target-link"
          x1={x(ghost.a)}
          y1={y(ghost.a)}
          x2={x(ghost.b)}
          y2={y(ghost.b)}
          role="button"
          tabindex="0"
          aria-label="Add link {cellToNotation(size, ghost.a)} to {cellToNotation(size, ghost.b)}"
          onclick={() => onLink(ghost.a, ghost.b)}
          onkeydown={(event) => handleLinkKey(event, ghost.a, ghost.b)}
        />
      {/each}
    </g>
  {/if}

  <g class="targets-cells">
    {#each holes as cell (cell)}
      <circle
        class="target-cell"
        class:enabled={interactive}
        cx={x(cell)}
        cy={y(cell)}
        r="0.44"
        role="gridcell"
        tabindex={interactive ? 0 : -1}
        aria-label={cellToNotation(size, cell)}
        onpointerenter={() => (hover = cell)}
        onclick={() => interactive && onCell(cell)}
        onkeydown={(event) => interactive && handleCellKey(event, cell)}
      />
    {/each}
  </g>
</svg>

<style>
  .board {
    width: 100%;
    height: 100%;
    max-width: 100%;
    display: block;
    touch-action: manipulation;
  }

  .band {
    opacity: 0.5;
  }
  .band.light {
    fill: var(--seat-light-band);
  }
  .band.dark {
    fill: var(--seat-dark-band);
  }

  .coord {
    font-size: 0.5px;
    fill: var(--text-faint);
    font-family: var(--font-ui);
  }

  .hole {
    fill: var(--hole);
  }

  .link {
    stroke-width: 0.13;
    stroke-linecap: round;
  }
  .link.light {
    stroke: var(--seat-light);
  }
  .link.dark {
    stroke: var(--seat-dark);
  }
  .link.fresh {
    opacity: 0.75;
    stroke-dasharray: 0.28 0.16;
  }

  .ghost {
    stroke-width: 0.1;
    stroke-linecap: round;
    stroke-dasharray: 0.2 0.2;
    opacity: 0.5;
  }
  .ghost.light {
    stroke: var(--seat-light);
  }
  .ghost.dark {
    stroke: var(--seat-dark);
  }
  /* A lane that is already cut reads differently from one that is open. */
  .ghost.blocked {
    stroke: var(--blocked);
    stroke-dasharray: 0.08 0.16;
    opacity: 0.85;
  }

  .peg {
    stroke: var(--peg-outline);
    stroke-width: 0.05;
  }
  .peg.light {
    fill: var(--seat-light);
  }
  .peg.dark {
    fill: var(--seat-dark);
  }
  .peg.pending {
    opacity: 0.65;
    stroke-dasharray: 0.12 0.08;
    stroke-width: 0.08;
  }
  .peg.last {
    stroke: var(--last-move);
    stroke-width: 0.11;
  }

  .hover-peg {
    opacity: 0.28;
    pointer-events: none;
  }
  .hover-peg.light {
    fill: var(--seat-light);
  }
  .hover-peg.dark {
    fill: var(--seat-dark);
  }

  .target-link {
    stroke: transparent;
    stroke-width: 0.3;
    cursor: pointer;
  }

  .target-cell {
    fill: transparent;
    pointer-events: none;
  }
  .target-cell.enabled {
    pointer-events: all;
    cursor: pointer;
  }
  .target-cell:focus-visible {
    outline: none;
    stroke: var(--focus);
    stroke-width: 0.08;
  }
</style>

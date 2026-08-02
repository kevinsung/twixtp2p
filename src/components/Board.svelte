<script lang="ts">
  /**
   * The board, drawn as SVG in board coordinates: a cell at row r, column c
   * sits at (x=c, y=r), so the viewBox does all the scaling and the markup
   * stays readable.
   *
   * Layers, back to front: border bands, holes, links, pegs, ghost previews,
   * cell hit targets, then link hit targets. A cell's hit target is the whole
   * unit square around it, which on a square lattice is exactly the set of
   * points nearer to that hole than to any other — so every spot on the board
   * belongs to the peg you would say it belongs to, with no dead gaps in
   * between. Links sit on top because a knight lane passes only 0.447 from the
   * two lattice points it skirts and would otherwise be unreachable. Instead
   * the link target is trimmed clear of the holes at its ends and kept narrow
   * enough to stay outside the drawn radius of the pegs it passes — see
   * LINK_TARGET_CUT.
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

  /**
   * How much of each end of a link is left to the holes there.
   *
   * Link targets sit above cell targets, so without this the two ends of a link
   * would cover the pegs they join — including the pending peg, clicking which
   * confirms the turn. A knight lane leaves a hole's unit square 0.559 out, and
   * the target's round cap reaches 0.14 back from where it starts, so 0.70
   * hands every point of a peg's square back to the peg. That still leaves a
   * 0.84-long handle on a 2.24-long lane, three times its own width.
   */
  const LINK_TARGET_CUT = 0.7;

  /** A link's hit target: the lane with `LINK_TARGET_CUT` taken off each end. */
  function targetLine(a: number, b: number): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } {
    const ax = x(a);
    const ay = y(a);
    const dx = x(b) - ax;
    const dy = y(b) - ay;
    const scale = LINK_TARGET_CUT / Math.hypot(dx, dy);
    return {
      x1: ax + dx * scale,
      y1: ay + dy * scale,
      x2: ax + dx * (1 - scale),
      y2: ay + dy * (1 - scale),
    };
  }

  /**
   * The squares tile the holes but not the corners or the margin, so without
   * this the ghost would linger wherever it was last set. Link targets are
   * spared: mid-turn `hover` re-roots the ghost links, and clearing it as the
   * pointer arrives on a candidate would take that candidate away just as it
   * was about to be clicked.
   */
  function clearHoverOffTarget(event: PointerEvent): void {
    const target = event.target as Element;
    const classes = target.classList;
    if (!classes?.contains('target-cell') && !classes?.contains('target-link')) hover = null;
  }

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
  onpointerover={clearHoverOffTarget}
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

  <!-- Hit targets. Cells first, trimmed link handles above them. -->
  <g class="targets-cells">
    {#each holes as cell (cell)}
      <rect
        class="target-cell"
        class:enabled={interactive}
        x={x(cell) - 0.5}
        y={y(cell) - 0.5}
        width="1"
        height="1"
        role="gridcell"
        tabindex={interactive ? 0 : -1}
        aria-label={cellToNotation(size, cell)}
        onpointerenter={() => (hover = cell)}
        onclick={() => interactive && onCell(cell)}
        onkeydown={(event) => interactive && handleCellKey(event, cell)}
      />
    {/each}
  </g>

  {#if linksClickable}
    <g class="targets-links">
      {#each links as link (link.a * size * size + link.b)}
        {#if view.pegs[link.a] === seat}
          {@const line = targetLine(link.a, link.b)}
          <line
            class="target-link remove"
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
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
        {@const line = targetLine(ghost.a, ghost.b)}
        <line
          class="target-link add"
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          role="button"
          tabindex="0"
          aria-label="Add link {cellToNotation(size, ghost.a)} to {cellToNotation(size, ghost.b)}"
          onclick={() => onLink(ghost.a, ghost.b)}
          onkeydown={(event) => handleLinkKey(event, ghost.a, ghost.b)}
        />
      {/each}
    </g>
  {/if}
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

  /* 0.28 wide is the most a lane can take: half of it is 0.14, and the lane
     runs 0.447 from the holes it skirts, so the target stops just outside their
     drawn pegs (r 0.3). It does cover part of those holes' squares, but only
     while a turn is being composed, when the cells worth clicking are the
     pending peg and your own pegs — and LINK_TARGET_CUT keeps both of those
     whole. */
  .target-link {
    stroke: transparent;
    stroke-width: 0.28;
    stroke-linecap: round;
    cursor: pointer;
  }
  /* Sitting on top of the holes, a link has to announce itself — otherwise it
     reads as inert until you happen to hit it. */
  .target-link:hover,
  .target-link:focus-visible {
    outline: none;
    opacity: 0.4;
  }
  .target-link.remove:hover,
  .target-link.remove:focus-visible {
    stroke: var(--danger);
  }
  .target-link.add:hover,
  .target-link.add:focus-visible {
    stroke: var(--focus);
  }

  .target-cell {
    fill: transparent;
    pointer-events: none;
  }
  /*
   * `fill`, never `all`. Under `all` a shape is hit on its perimeter as well as
   * its interior "regardless of the value of the fill, stroke and visibility
   * properties" — and stroke-width defaults to 1, which on this board is a whole
   * cell. That gave every target an invisible one-cell-wide band around its edge,
   * so the squares overlapped three deep and each point went to the last of them
   * in document order: the hole down and to the right. Aiming at a peg picked its
   * neighbour, which read as the hit area sitting up and to the left.
   */
  .target-cell.enabled {
    pointer-events: fill;
    cursor: pointer;
  }
  .target-cell:focus-visible {
    outline: none;
    stroke: var(--focus);
    stroke-width: 0.08;
  }
</style>

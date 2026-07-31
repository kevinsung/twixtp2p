# TwixT

A complete [TwixT](https://en.wikipedia.org/wiki/TwixT) implementation for the browser, playable
hot-seat on one device, against the built-in engine, or peer-to-peer between two browsers anywhere.

**There is no backend.** The app is a static bundle — put it on GitHub Pages, Netlify, any CDN, or
open it from the filesystem. Nothing to deploy, run, or pay for.

## Running it

Node is required only to build. This repo pins Node 24 via `.nvmrc`:

```sh
nvm use          # or: nvm install
npm install
npm run dev      # http://localhost:5173
```

```sh
npm run build    # static bundle in dist/
npm run preview  # serve the built bundle
npm test         # engine, search, protocol, session and DOM tests
npm run check    # svelte-check + TypeScript
```

Deploying is just copying `dist/` somewhere. Asset URLs are relative, so a subdirectory works.

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`, which builds the
bundle and publishes it after `npm run check` and `npm test` pass. This needs Pages enabled once,
under Settings → Pages → Source: **GitHub Actions**.

## The rules

- 24×24 grid of holes with the four corners removed. 12, 18 and 30 are also available.
- **Red** owns the top and bottom rows and connects them, and moves first.
  **Black** owns the left and right columns and connects them.
- Neither player may place on the opponent's border lines.
- Placing a peg links it to friendly pegs a knight's move away — but **a link may never cross
  another link, of either colour**. Blocking with links is the core of the game.
- You may remove your own links on your turn, never your opponent's.
- **Pie rule**: immediately after the first peg, Black may play `swap` instead of replying. The
  opening peg is mirrored across the main diagonal and becomes Black's, so Black takes over a
  strong opening rather than answering it. Nobody changes colour — Red still moves next.
- Connecting your two border lines wins. A board that fills with neither side connected is a draw.

### Playing a turn

Click a hole to place a peg; links to your other pegs form automatically. Before confirming you can
click any of your links to remove it, or click a dashed lane to add a link auto-linking skipped.
**Enter** confirms, **Escape** cancels. Amber dashed lanes are ones already cut by an existing link.

Declining a link is a real tactic, which is why confirmation exists. If you would rather commit the
moment you place a peg, turn on *Skip move confirmation* — you give up link editing in exchange.

## Playing the computer

Pick a board size and a colour, and the engine plays the other side. It thinks for about a second
and a half a move, in a Web Worker, so the page stays responsive and the board simply goes quiet
while it is your opponent's turn. There is no model to download and nothing to call: it is search,
and it ships in the bundle.

It uses the pie rule, and it allows takebacks without negotiation — *Undo* rewinds past its reply as
well as your move. It does not resign and it does not answer draw offers.

There is one strength, deliberately. Weakening a search engine means making it blunder on purpose,
which reads as randomness rather than as a gentler opponent.

### How it plays

The evaluation is a single number per side: **the fewest extra pegs that would join its two border
lines**, over a board where cells you already own are free, empty legal cells cost one, and enemy
pegs and enemy border lines are impassable. A lane counts as usable if you already own the link, or
if it is unlinked and uncrossed. Cost zero is exactly a win, so detecting a finished game falls out
of the same computation.

That drives an iterative-deepening alpha-beta search. The one thing it cannot afford is 570 legal
moves per node, so the same distance fields do double duty as a relevance filter: a cell's potential
is what a route through it would cost, and cells lying on a cheapest route for *either* player —
attack and defence in one measure — are the ones the search looks at. Around sixteen per node, four
plies deep in the time allowed, more where the position is forcing.

Two implementation notes. The search cannot use `GameState`, which clones an array and three maps
per move; it gets a mutable board where placing a peg is a handful of array writes, and the two are
held to agreement by a test that replays random games through both and compares them move for move.
That board is fast because **which knight lanes cross a given knight lane is fixed geometry** —
computed once per board size, so adding a link is marking a lane and bumping a counter on each lane
it blocks.

## Playing over the internet

Two browsers cannot find each other unaided, so something has to introduce them. What that
something is *not*, here, is a server of ours — and nothing sits in the data path once you are
connected.

### Room codes (default)

[Trystero](https://github.com/dmotz/trystero) carries the WebRTC handshake over public Nostr relays.
Host a game, share the 8-character code or the invite link, and the two browsers connect directly.

The code is the only secret, and it does two jobs:

- **hashed**, it becomes the room identifier the relay sees — so relays never learn the code;
- **raw**, it is the AES-GCM encryption password — so the handshake is end-to-end encrypted on
  infrastructure nobody here controls.

Invite links carry the code in the URL *fragment*, which browsers never transmit, so not even the
static host that served the page sees it. Rooms are capped at two players in app code, since
Trystero itself does not limit them.

### Manual invitations (fallback)

No relay at all. The host generates an invitation, sends it over any chat app, and pastes back the
reply. This exists for when public relays are blocked or down.

The whole SDP is deflated and base64url'd rather than hand-reduced to its varying fields. That
gives longer codes than templating would, but templating breaks whenever a browser changes its SDP
shape — a bad trait in the thing you fall back to when everything else has failed.

### Connection failures, honestly

The app ships **STUN only**. STUN servers just report how a browser looks from outside; they never
carry traffic. TURN would relay traffic and so cannot be serverless, so there is none.

The consequence: when both players sit behind symmetric NAT — roughly one pairing in ten — no
direct route exists and the connection fails. **The manual fallback does not help here.** It uses
the same WebRTC and the same STUN, so it fails identically. It rescues relay outages, not NAT
traversal. The only fix from here is one player switching networks; a phone hotspot usually works.

### Trust

There is no referee, so each peer independently validates everything the other sends: messages are
structurally checked before reaching the engine, moves must arrive in order from the player whose
turn it is, and every move must be legal in the receiver's own position. A move failing any check is
reported, never applied. Each move also carries a hash of the resulting position, so if the two
boards ever diverge you find out on the very next move rather than hours later.

Takebacks and draws are negotiated, never unilateral. Reconnecting with the same room code resumes
the game — the peers reconcile histories, and the one that fell behind catches up.

## How it is built

Svelte 5 + TypeScript + Vite, board rendered as SVG.

```
src/lib/engine/    board geometry, link crossing, rules, notation — no UI, no network
src/lib/ai/        precomputed tables, search board, evaluation, search, worker
src/lib/net/       room codes, both transports, wire protocol, session negotiation
src/lib/stores/    reactive wrappers
src/components/    Board, Lobby, Sidebar
```

Two decisions carry most of the design:

**Game state is a pure fold over a move list.** Nothing mutates in place. Undo is "truncate and
replay", saving is "serialise the list", and desync detection is "hash the folded state" — one
choice covering four features.

**Link crossing is exact integer arithmetic.** Peg coordinates are integers, so the orientation
tests need no floating point and no epsilon. Two facts about knight's-move segments make the strict
"proper intersection" test exactly the rule: such a segment contains no interior lattice point, so
it never passes through a hole and any lattice-point meeting is a shared peg; and two distinct
knight segments can never be collinear and overlapping. Links are indexed by the two unit grid
squares their bounding box covers, so a crossing check looks at a handful of candidates instead of
the whole board — and because that argument is too subtle to trust by eye, the tests check the
indexed result against a brute-force scan over randomised positions.

## Limitations

- ~10–15% of NAT pairings cannot connect, with no in-app remedy. See above.
- Public relays are best-effort community infrastructure, not an SLA. Nostr's redundancy makes this
  robust in practice, and manual invitations are the backstop.
- The computer opponent is a club-level player, not a strong one. Four plies of search sees an
  immediate win, blocks one, and follows a short forcing sequence; it will not find deep ladder
  tactics, and it never edits its own links, so it cannot drop an auto-link that blocks a better one.
- No spectators, no matchmaking beyond sharing a code, no server-side persistence.

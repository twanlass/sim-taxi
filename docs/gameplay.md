# Gameplay

## The fare loop

`src/game/fares.js` is a three-stage machine: `idle → waiting → riding → idle`.

1. A passenger spawns at a random intersection (never the one the taxi is already about to reach)
   with a **60-second clock** (`FARE_SECONDS`).
2. Tap them → the taxi routes there.
3. On arrival the passenger boards, a destination pin appears, and the taxi **parks** until the
   player taps that destination.
4. Deliver → **$20** (`FARE_VALUE`), and a new passenger spawns.
5. Either clock expiring ends the run.

`fares.update()` returns one event string per frame (`'spawned' | 'pickup' | 'delivered'`) rather
than firing callbacks, so the fare system holds no reference to the taxi mesh, the HUD or the
toast. `main.js` translates events into all of that.

### The clock does not reset at pickup

One flat deadline covers **spawn to drop-off**. Collecting a rider quickly is what buys the time to
deliver them, and that is the entire tension of the game. Trips average ~17s one-way, so 60s for
both legs plus reaction time is tight but fair.

`ARRIVE_RADIUS = 7` is how close the taxi must get to count as arrived.

### Arrival requires direction

A fare only resolves — pickup or drop-off — if the player actually **sent** the taxi at it.

Without this rule a taxi cruising on random turns wanders into the pin by itself: measured at
**11 of 40 seeds** completing a drop-off with no tap at all. `state.directed` is cleared whenever a
new target appears and set by the tap that routes the taxi.

### Fare colours

A waiting passenger is **white — deliberately colourless**. Before pickup any taxi could take any
rider, so a colour there would imply a commitment that doesn't exist.

At pickup a colour is assigned and worn by both the taxi's roof sign and that rider's destination
pin. The *sign* carries it rather than a ring, because the rings are spoken for — the timer ring
is colour-coded by time remaining, so fare identity needed somewhere else to live.

Colours avoid every hue already doing a job: signal red/amber/green, the taxi's own yellow, and
the white of an unclaimed passenger. Consecutive fares never repeat a colour.

With one taxi this is flavour. With several it becomes the entire read of the board — and the fact
that colour is assigned only at pickup is what leaves the interesting decision (which taxi takes
which rider) to the player rather than to the spawner.

## Routing

`src/game/route.js` is BFS over **directed** states `(i, j, d)` — 144 states, instant.

The node has to carry the approach direction because `legalExits` forbids U-turns. A plain
`(i, j)` node would plan routes that flip direction on the spot, and the car could never execute
them.

`planOrigin(car)` handles the subtle case: **a car mid-turn has already committed its choice**, so
planning from its current intersection produces a route whose first step is silently skipped and
every later turn lands one intersection early. Planning starts from the intersection the taxi is
*heading toward*, plus its current heading — the first point at which it can still make a choice.

## Picking

`src/game/pick.js` raycasts against objects that opt in via `userData.pickable`, a string kind. The
ray walks up each hit's parents to find the tag, so a click on any child of the taxi group counts.

A plain `click` handler is enough because the camera is fixed — there is no drag gesture to
disambiguate from a tap. This is exactly why `city-lab`'s `attachCameraControls` (which binds
pointerdown to drag-panning) is deliberately unused here; it fought tap-to-select.

**The taxi is permanently selected.** There is only ever one, so a selection step was pure
ceremony: every tap on it was either a no-op or an accidental deselect that made the next tap on a
fare do nothing.

## The fare's timer travels

`src/game/timerring.js`. The countdown is a **physical object that belongs to the fare**, not a HUD
number and not a property of a marker.

It waits as a ring under the rider on the kerb, then **flies to the taxi** when they get in
(`TRANSFER_TIME = 0.65s`, eased, with a small arc) — because from that moment the deadline is the
car's problem.

**The arc sweeps clockwise** from screen-top as time drains. Screen-up is world `(-1, 0, -1)` at
this camera angle, hence `START_ANGLE = -Math.PI * 0.75`. The annulus is built as an explicit
triangle list in sweep order rather than using `THREE.RingGeometry`, because `setDrawRange` needs
draw order and sweep order to be the same thing.

**Colour snaps between four stages** and is never interpolated:

```
> 60%  #26E05A  green
> 35%  #FFE12E  yellow
> 15%  #FF8C1A  orange
else   #FF2E2E  red
```

A continuous ramp spends most of its life in muddy in-between hues — the first version read as
olive through the whole first half — and a colour that changes imperceptibly tells the player
nothing. Snapping makes each change an event you notice.

A dimmed **track** ring sits beneath the live arc. Without it a half-drained arc looks like a
crescent floating beside its owner rather than a ring centred on it.

The ring draws **on top of everything** (`depthTest: false`, `renderOrder 9`). The taxi and the
rider duck behind buildings constantly at this camera angle, and a clock you cannot see is
worthless — legibility beats depth correctness here.

The taxi's ground indicators nest deliberately: highlight disk innermost, selection ring around
it, timer ring outside both. The first attempt put the timer at the same radius as the selection
ring and it vanished inside its band.

## Beacon

`src/geometry/lightshaft.js` — a white shaft of light standing over a waiting rider. At play zoom
a person is a handful of pixels among a hundred buildings; the shaft is what makes "someone needs
picking up" readable from anywhere on the map without zooming or panning. The rider and their ring
render on top of it.

> The file is named `lightshaft.js`, **not** `beacon.js`, on purpose. Ad blockers match request
> URLs against tracking-beacon filter lists and block `beacon.js` outright with
> `ERR_BLOCKED_BY_CLIENT`, which takes the whole module graph down with it. The HUD element is
> `#run-end` rather than `#banner` for the same reason.

## Economy

`$0` at top left. On delivery a green **`$20` pops off the taxi itself** — animating up, holding,
then fading — and only when that animation ends does the counter tick up.

The lag is intentional: it connects the payout to the drop-off event in the world rather than
quietly incrementing a number in a corner while your attention is elsewhere. `popEarning()`
projects the taxi's world position to screen space to anchor the element.

## Crazy-taxi mode

The ⚡ button, bottom centre. 15 seconds active, 15 seconds recharging, no partial spend — so the
only decision is *when* to press it. The button doubles as the dial: a `--pct` CSS variable drains
while active and fills while recharging.

While active the taxi runs at 2.2× speed, forces its next junction green, doesn't slow for
corners, lays **skid marks** through turns, and kicks up **dust**. See
[rendering.md](rendering.md#effects) for how those two are drawn.

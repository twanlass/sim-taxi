# Gameplay

## The fare loop

`src/game/fares.js`. Each fare is its own little machine — `waiting → riding → gone` — carrying its
own clock, pins and ring. Up to `MAX_FARES = 3` run at once, and because the taxi has one seat,
that means up to two riders can be waiting on the kerb at the same time.

1. A passenger spawns at a random intersection (never the one the taxi is already about to reach)
   with a **60-second clock** (`FARE_SECONDS`) and a [meter](#the-meter-over-a-waiting-rider) over
   their head: how long they'll wait, and how far they're going. The whole trip is drawn now, but
   only its length is shown — see [How far, not where](#how-far-not-where).
2. Tap them → the taxi routes there.
3. On arrival the passenger boards, their drop-off pin appears, and the taxi **parks** until the
   player taps it.
4. Deliver → the meter pays out (`FARE_BASE + FARE_PER_BLOCK × blocks`, see [Economy](#economy)),
   and the board refills.
5. **Any** fare's clock expiring ends the run.

## How far, not where

Both ends of a trip are **drawn** the moment a rider spawns — the meter's distance bar needs the
length, and the price is fixed from it — but the drop-off is not **shown** until they're aboard.
What the player gets up front is how far, not where.

The middle ground was tried: a preview pin standing on the far kerb from spawn, smaller than a live
one and with its bounce held. It made "which fare do I grab?" a real decision instead of a coin
flip, but it also meant three riders and three destinations on the board at once, and the distance
bar turned out to carry the decision on its own. Where a trip ends is worth less to the player than
how long it is, and it costs a lot more screen.

The pin lands exactly where it was drawn at spawn — it never moves — so nothing about the reveal is
a re-roll. `tools/probe.mjs` asserts both halves: hidden while the rider waits, and at the drawn
junction the frame it appears.

Screen distance would not have been trip distance anyway: two pins forty pixels apart can be a
four-block drive or a one-block one depending on which way the streets run, and at play zoom nobody
counts blocks by eye. The bar says it directly.

`fares.update()` returns the events that happened this frame — `{type, fare}`, with type one of
`'spawned' | 'pickup' | 'delivered' | 'failed'` — rather than firing callbacks, so the fare system
holds no reference to the taxi mesh, the HUD or the toast. `main.js` translates events into all of
that. It is a list because more than one can land together: delivering the last fare clears the
board, and the refill follows on the next frame.

## Extra fares and prioritisation

The taxi has **one seat**, so any extra fare beyond the one aboard is someone *waiting* — a clock
draining on the kerb while you decide who to grab. Tapping a waiting rider while already carrying
one is refused outright with a toast, rather than driving there and quietly not picking anyone up.

Two waiting riders on the board at the same time is the whole difficulty of the game: you can't
take both, and the wrong pick loses one of the two clocks. `fares.waiting()` returns the *most
urgent* waiter (lowest `timeLeft`) so the finder button and the "perfect player" in the soak both
default to serving that one first.

Rules for when the extras appear:

| Rule | Value | Why |
|---|---|---|
| `SECOND_FARE_AFTER` | 1 delivery | The first fare teaches the loop with nothing else on screen. |
| `THIRD_FARE_AFTER`  | 3 deliveries | Two clocks is where the game turns into a prioritisation puzzle. Piling a third on top before the player has settled into that shape collapsed the survival curve — measured 2-fare median at 1.5s reaction against 3 with the ramp. |
| `SPAWN_MIN_GAP` | 15s | Extras arrive one at a time. Spawning them in the same frame gives one hard moment then a lull; staggering makes each clock a decision. |
| `SECOND_FARE_DELAY` | 5s aboard | A pickup and a spawn are never the same event. |
| `SECOND_FARE_RANGE` | 45 units | When someone is aboard and closing on their drop-off, the new rider appears near it. |
| `SECOND_FARE_RADIUS` | 3 blocks | And within a short hop of it, so the hand-off is fair. Also the fallback radius around the taxi when no drop-off is active. |
| `SECOND_FARE_MIN_CLOCK` | 18s | No rider flashes into existence a few seconds before an unrelated timer ends the run. |

The bias rules shape where an extra rider lands relative to the taxi. When someone is aboard and
closing on their drop-off, the new rider appears near that drop-off — the classic "second fare
while carrying" hand-off. When nobody is aboard, the extra lands near the taxi's current
intersection instead; a rider dropped in the far corner of the map has a 60-second clock the taxi
cannot possibly reach in time, which turns "prioritise" into "roll the dice". Either way the
radius is the same, so the two paths read alike.

`SPAWN_MIN_GAP` is what turns the board into a prioritisation puzzle rather than a burst: extras
land staggered by several seconds, so their kerbside clocks drain out of phase and the player has
to keep picking which to serve. `tools/probe.mjs` asserts both the peak (>= 2 waiting) and the
minimum spacing between spawns.

The measured tax at 1.5s reaction across nine seeds: a perfect player survives a median of
**3 fares** against the **4-fare** two-fare baseline. The mean drops much harder (6.6 → 2.3) and
the ceiling collapses from 25 to 3 — the game stops being winnable indefinitely, which is the
intended shape of a score-attack that ramps.

The rider *figure* is still white whatever else is on the board — see
[Fare colours](#fare-colours) — so every waiting rider reads the same way, with the urgency bar over
their head carrying how close each one is to giving up.

### The clock does not reset at pickup

One flat deadline covers **spawn to drop-off**. Collecting a rider quickly is what buys the time to
deliver them, and that is the entire tension of the game. Trips average ~17s one-way, so 60s for
both legs plus reaction time is tight but fair.

`ARRIVE_RADIUS = 7` is how close the taxi must get to count as arrived.

### Arrival requires direction

A fare only resolves — pickup or drop-off — if the player actually **sent** the taxi at it.

Without this rule a taxi cruising on random turns wanders into the pin by itself: measured at
**11 of 40 seeds** completing a drop-off with no tap at all. `directed` lives on the fare, is set by
the tap that routes the taxi at it, and clears whenever that fare's target changes.

### Fare colours

The passenger **figure** is white — deliberately colourless. Before pickup any taxi could take any
rider, so a colour on the *person* would imply a commitment that doesn't exist.

The fare's colour is assigned when the trip is drawn, at **spawn**, and first shows at pickup on
that fare's drop-off pin and the taxi's roof sign together. The *sign* carries it rather than
a ring, because the rings are spoken for — the timer ring is colour-coded by time remaining, so
fare identity needed somewhere else to live.

`nextFareColor()` refuses any colour a **live** fare is wearing, not just the previous one — five
colours against `MAX_FARES = 3` means that always resolves, and it still costs exactly one draw off
the stream. With one visible pin at a time this is belt and braces rather than load-bearing; it was
load-bearing during the spell when every waiting rider's drop-off was on the board too.

Colours avoid every hue already doing a job: signal red/amber/green, the taxi's own yellow, and
the white of an unclaimed passenger.

The one decision this defers is still deferred: colour says which *trip* a marker belongs to, never
which taxi is taking it. The day there is more than one taxi, that stays the player's call.

## Routing

`src/game/route.js` is Dijkstra over **directed** states `(i, j, d)` — 144 states, instant.

The node has to carry the approach direction because `legalExits` forbids U-turns. A plain
`(i, j)` node would plan routes that flip direction on the spot, and the car could never execute
them.

`planOrigin(car)` handles the subtle case: **a car mid-turn has already committed its choice**, so
planning from its current intersection produces a route whose first step is silently skipped and
every later turn lands one intersection early. Planning starts from the intersection the taxi is
*heading toward*, plus its current heading — the first point at which it can still make a choice.

### Road-hierarchy weights

Edges are not equal cost. The signal model was tuned around a coordinated green wave on two
arterials per axis (64% green share, offsets running with the wave direction) and an
unsignalised ring around the outside. A fewest-blocks router fights that coordination — it will
happily plan a route straight up a side street when the arterial parallel to it exists.

Current weights, per block traversed:

| Class | Weight |
|---|---|
| Ring (outermost roads) | 0.90 |
| Arterial, with the coordinated direction | 0.95 |
| Arterial, against the coordinated direction | 1.00 |
| Side street | 1.00 |

Kept close to 1.0 on purpose: the router is a **tie-breaker between paths of the same length**,
not a detour finder. Aggressive weights (ring 0.55, arterial 0.70) were tried and dropped
stopped-time further, but added enough distance to erase the gain. Measured across 240 fares vs
unit weights: trip time **−3.9%**, time-stopped-at-signals **−13.7%**, average path length
essentially unchanged. Sweep via `tools/router-sweep.mjs`.

## Picking

`src/game/pick.js` raycasts against objects that opt in via `userData.pickable`, a string kind. The
ray walks up each hit's parents to find the tag, so a click on any child of the taxi group counts.

Still a plain `click` handler, even though the camera drag-pans now. The disambiguation lives in
`attachDragPan`: a press only becomes a drag once it crosses `PAN_SLOP = 8px`, and the picker
ignores the click that closes out one. So a tap is an ordinary click and only a gesture that
actually moved the map is swallowed. This is exactly why `city-lab`'s `attachCameraControls`
(which binds pointerdown to dragging unconditionally) is still unused here; it fought
tap-to-select.

Every marker carries an oversized invisible hit box, 20 units square — the visible figure is a
handful of pixels at play zoom, and it stands on a kerb corner four units off the junction the box
is centred on, so a box merely the size of the junction put the rider on its own edge and lost half
the taps aimed at it.

**Which** pin was tapped is the instruction, not just that one was: `fares.fareFor(hit.object)`
walks up from the hit to the fare that owns it. Tapping a kerbside rider while already carrying one
is refused with a toast rather than routing a taxi that could never collect them.

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

**Below 5 seconds** the whole ring pulses — a ~3.5Hz sine scaling between 1.0 and 1.15. Threshold
is in seconds, not fraction, so "five left" stays five left when the debug panel has tuned
`fareSeconds` away from 60. The pulse and the red stage are the same object, so the two urgency
cues stack rather than compete for the eye.

A dimmed **track** ring sits beneath the live arc. Without it a half-drained arc looks like a
crescent floating beside its owner rather than a ring centred on it. It is opaque, with the
dimming baked into the colour rather than done with alpha — see the render-order note below.

A **black rim** underneath both, the same weight as the outlines on the marker pins. At play zoom
the ring is ~25px across on road barely darker than its own yellow stage colour, and without the
rim the arc's edge dissolves into the tarmac.

The ring draws **on top of everything** (`depthTest: false`, `renderOrder 7-9`). The taxi and the
rider duck behind buildings constantly at this camera angle, and a clock you cannot see is
worthless — legibility beats depth correctness here.

### …except its own owner

Which creates the one exception. The ring lies flat on the ground, its owner stands in the middle
of it, and at this camera angle the **far half of a flat circle projects upward on screen** across
whatever is standing at the centre. Drawn with the depth test off, the ring sliced the rider — and
later the taxi — in half.

The fix is draw order, not depth: the ring writes no depth, so anything drawn *after* it lands on
top while still self-occluding normally. `ABOVE_RING` is that renderOrder, worn by the rider's
meshes and the taxi's shell and sign.

This is why the track had to stop being translucent. A transparent object draws after **every**
opaque one no matter what its renderOrder says, so as a wash it painted a dark band across the
figure that no ordering could undo.

The taxi wears nothing else on the ground now, so the timer ring is simply sized to clear the car.
It used to sit outside a selection pool — and before that outside a selection ring, where the first
attempt put the timer at the same radius and it vanished inside the other ring's band.

## The meter over a waiting rider

`src/geometry/ridermeter.js` — an urgency bar above a distance bar, on a dark plate floating over
the rider's head. It answers the only two questions the player has about someone on the kerb — how
long have I got, and is this worth taking — without them reading anything.

| Bar | Segments | Says |
|---|---|---|
| **Urgency**, on top | 4, draining as the clock runs down. Green → yellow → orange → red, [by level](#urgency-is-one-scale). | How long this rider will keep waiting. |
| **Distance**, below | 3, fixed at spawn. Flat purple at every tier. | Short (1-3 blocks), medium (4-6), long (7+). |

The plate takes a **yellow ring** once the taxi has been sent at that rider — the Loco Mode pill's
yellow, which is the taxi's own. On a board with two riders waiting it is the only thing saying
which of them the car is already on its way to. `markDirected` pushes it so the ring lands on the
same frame as the route band; the per-frame tick reconciles it, because `directed` is also *cleared*
from elsewhere and one place that reflects the flag cannot drift from it.

Three tiers rather than a block figure: nobody weighs 5 blocks against 6, they weigh "quick and
cheap" against "slow and worth it", and a shape is read faster than a digit. The tiers live in
`game/triptier.js`.

It replaced three things, and is a straight win over all of them:

- **A shaft of light** over the rider, which marked them at range and said nothing else. At play
  zoom the meter is a bright ~67 × 27px block — a bigger target than the shaft's base, and it earns
  the screen space by carrying information.
- **A ring on the kerb**, which drained the same clock the urgency bar does now.
- **A seven-segment block count**, which was more precision than the decision needed and cost a
  read to parse.

### Urgency is one scale

`src/game/urgency.js`. Four levels, even quarters of the clock, each with its own colour. The
number of lit segments *is* the level.

Three surfaces show it — the bar over the rider, the ring that rides with the taxi, and the
countdown around each rider-finder chip — and they all read from here. A rider showing two orange
segments on the map whose chip is yellow in the corner is two answers to one question.

Even quarters rather than the ring's old 0.60 / 0.35 / 0.15 bands: those were fine for a colour but
wrong for a bar, holding four segments through the first 40% of the clock and then shedding the
other three in a rush.

Per-rider patience is not in yet — every rider drains at the same flat `fareSeconds`. The seam is
`urgencyOf(fare)` in `fares.js`: a patience mechanic changes what goes into that function and
nothing downstream of it, because every surface already speaks in levels rather than seconds.

## Economy

`$0` at top left. On delivery a green **fare price pops off the taxi itself**, rises for a beat,
then **flies to the counter** at the top-left. When it lands, the counter bumps green and its
number **rolls up** from the old total to the new one.

Two phases rather than one because the payout has to travel from *the world* to *the HUD*: a
number that jumps up without a visible link between the drop-off and the counter reads as a
side effect. `popEarning()` projects the taxi's world position to anchor phase 1, and
`counterScreenPos()` reads the counter's live viewport rect to aim phase 2 — resolved at launch,
so a mid-run resize still lands each flight where the counter actually is now. `rollMoneyTo()`
tweens the digits on rAF (not a CSS transition) so a second delivery arriving mid-roll re-aims
the same animation at the new total instead of two counters racing. Roll length scales with the
payout (~50ms per dollar, clamped) so a `$8` hop reads as a quick bump and a `$35` haul as a
longer roll.

### The meter

Each fare is priced by **trip distance**, not a flat rate: `FARE_BASE + FARE_PER_BLOCK × blocks`,
where `blocks` is the Manhattan distance between the pickup and drop-off intersections. The
price is fixed at spawn — the moment both endpoints are known — and stamped on the fare so a
long haul that runs into traffic pays the same as one that flies through green lights. Metering
during the trip would double-count the clock and reward Loco Mode for the wrong reasons.

The distance bar over the rider's head is a tier of that same `blocks`, so the bar is a coarse read
on the price: the player is glancing at the meter before deciding, not after.

| Blocks | Price |
|---:|---:|
| 1  | $8  |
| 3  | $14 |
| 5  | $20 |
| 8  | $29 |
| 10 | $35 |

Calibration: median trip in the current city is ~5 blocks, which pays the old flat `$20` — so the
soak suite's expected earnings are roughly unchanged. What is new is the *shape* of the choice: a
kerbside rider whose destination happens to be next door is now worth less than one going across
town, so "which fare to grab" is an economic decision as well as a timing one. A flat rate made
that decision trivial.

## Crazy-taxi mode

The **Loco Mode** button, bottom left. **Hold to enable, release to pause.** A short tap costs a
short slice, a long hold flows until the tank is empty. Full tank is 15 seconds of boost; from
empty it recharges in 15 seconds and, if you kept holding through the recharge, engages again the
moment it's full. Release with fuel still in the tank and it trickles back up at a fifth of the
empty-recharge rate — enough that a couple of quick taps aren't stranded halfway, slow enough
that a full drain still calls for the fast recharge. The decision is now *how long* to press as
well as *when*. The button doubles as the dial: a `--pct` CSS variable tracks the fuel level,
dropping as you drain and climbing as it recharges.

Pointer capture on `pointerdown` keeps the boost held even if the finger slides off the pill;
`pointerup`, `pointercancel`, `lostpointercapture` and the window `blur` all release it, so
alt-tabbing or switching apps never leaves the boost stuck on.

Every successful drop-off tops the tank up by **15%** — `boost.topUp(0.15)` queues the fuel as
*pending* and pours it in over ~0.3s so the bar visibly fills rather than snaps. A short green
pulse behind the pill (`.is-topping-up`, matching the flying `$20`) is the flash that ties the
top-up to the same payout the earnings pop is announcing.

While active the taxi runs at 2.2× speed, forces its next junction green, doesn't slow for
corners, lays **skid marks** through turns, and kicks up **dust**. See
[rendering.md](rendering.md#effects) for how those two are drawn.

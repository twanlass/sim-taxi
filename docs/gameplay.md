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
3. On arrival the passenger boards, their drop-off pin appears and the taxi **drives straight on to
   it** — the pin lands in the taxi's yellow, because the instruction it used to ask for is now
   given for you. See [The drop-off dispatches itself](#the-drop-off-dispatches-itself).
4. Deliver → the meter pays out (`FARE_BASE + FARE_PER_BLOCK × blocks`, see [Economy](#economy)),
   and the board refills.
5. **Any** fare's clock expiring ends the run.

## The drop-off dispatches itself

**A rider getting in is the taxi's instruction to drive them.** `dispatchToDropoff` in `main.js`
routes at the drop-off on the pickup frame; the player never taps a destination pin.

The tap it replaced confirmed a choice with exactly one option. Where the rider is going was
decided when they spawned — the meter's distance bar is a read on it, the price is fixed from it —
and their pin is on the map the instant they board, so the second tap added no decision, only
latency, and it spent that latency out of the *same* flat clock that still has to cover the
delivery. Meanwhile the decision the game is actually about — which of two kerbside riders to grab
while both clocks drain — is untouched.

What it costs a slow player is the whole point, and the soak measures it. Modelled as reaction time
paid on the kerbside legs only (`tools/soak.mjs`), a perfect player at **4s** reaction goes from a
median of 2 fares to **3** (mean 1.9 → 2.8, worst run 0 → 2). At 1.5s it is unchanged at 2 — the
faster the player, the less the tap was costing them, which is exactly the wrong way round for a
tap that carried no decision.

The pin stays tappable and `directed` still governs arrival, so nothing about
[arrival requires direction](#arrival-requires-direction) is skipped — the flag is now set from the
pickup instead of from a second tap.

**The taxi no longer parks at a pickup.** It used to sit at the kerb with `parked = true` until
told where to go; now a pickup is a pause in a drive rather than a full stop and a restart. In
practice it was never much of a stop anyway: the pickup fires with the taxi *inside* the junction
(`state === 'turn'` at every pickup across four run seeds, still doing the full 8.5 u/s), where the
`parked` check isn't consulted at all — it coasted across, braked on the far side, and then pulled
away again on the tap. The one surviving `parked = true` is the fallback for a drop-off the router
can't reach, which a shipped city never has: `main.js` rerolls any seed where `findRoute` fails a
pair. It exists so an unroutable taxi is still recoverable by hand rather than cruising on random
turns until the clock runs out.

Routing on the pickup frame means planning from a turn the car has already committed to —
`planOrigin` handles exactly that, and `tools/probe.mjs` asserts a fare is delivered end to end
with no drop-off ever tapped, because a route planned from the wrong origin silently drops its
first turn and the only symptom is a fare quietly timing out.

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
[The taxi's roof sign](#the-taxis-roof-sign) — so every waiting rider reads the same way, with the
urgency bar over their head carrying how close each one is to giving up.

### The clock does not reset at pickup

One flat deadline covers **spawn to drop-off**. Collecting a rider quickly is what buys the time to
deliver them, and that is the entire tension of the game. Trips average ~17s one-way, so 60s for
both legs plus reaction time is tight but fair.

`ARRIVE_RADIUS = 9` is how close the taxi's centre must get to the target **junction centre** to
count as arrived — exported from `fares.js`, and the headless tools import it rather than keeping
their own copy.

It is sized off the one place the taxi can stop and *stay* stopped short of a pin: that junction's
red light. The hold line sits `HALF_ROAD + STOP_SETBACK = 7.4` back along the lane, and the lane is
`LANE = 2` off the centreline, so a taxi waiting at the target's line is `hypot(7.4, 2) = 7.67`
from the centre — measured worst case **7.69** across 548 held-at-the-target samples in the
headless sim. At 7 it was 0.4 short — the car sat on the corner beside the pin with the drop
refusing to resolve until the light went green, which reads as the game ignoring an arrival that
plainly happened. A drive-through was never affected; only a stop was.

Not larger, either. One car back in the queue is another `MIN_GAP = 5.3`, past half the 20-unit
block pitch, and resolving there would pop the rider out mid-block with the pin still a visible
distance off.

### Arrival requires direction

A fare only resolves — pickup or drop-off — if the player actually **sent** the taxi at it.

Without this rule a taxi cruising on random turns wanders into the pin by itself: measured at
**11 of 40 seeds** completing a drop-off with no tap at all. `directed` lives on the fare, is set by
whatever routes the taxi at it, and clears whenever that fare's target changes.

On the drop-off leg [the game does the routing](#the-drop-off-dispatches-itself), so the flag is
set there rather than by a tap — but it is set by the same call that plans the route, so a
drop-off still only resolves for a taxi that was actually sent at it. Where the rule keeps its
teeth is the kerb: `beginRide` clears `directed`, and a rider is only ever collected by a taxi the
player pointed at them.

### The taxi's roof sign

The passenger **figure** is white — deliberately colourless. Before pickup any taxi could take any
rider, so a colour on the *person* would imply a commitment that doesn't exist.

The **roof sign** lights up while a rider is aboard and goes dark once they're dropped off — a
plain on/off, not a colour. It used to wear the fare's own colour, drawn at spawn from a five-colour
palette (`nextFareColor()`), because that colour was what paired a rider with their drop-off pin
across the map. **The drop-off pin no longer wears a fare colour at all** — it's fixed to **Loco
Mode's yellow**, the taxi's own, so the route band, the car and the place it is driving to are one
colour saying "this is the job" (see
[rendering.md](rendering.md#pin-outline-and-bounce--geometrymarkerjs)). With nothing left for a
fare colour to pair with, the sign's job shrank to the one thing still worth saying at a glance:
is the taxi free.

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

### The streak counter

`N×` at top-right, opposite the money counter. Nothing shows there until the first successful
drop-off — `updateStreak()` in `main.js` un-hides it and plays a scale/fade-in on that first
delivery, then bumps the number in the taxi's own yellow (not cash green, so it doesn't read as a
second money event) on every delivery after. No flight off the taxi the way the payout gets one;
the streak isn't travelling from anywhere.

The count is `fares.state.delivered` — the same number the run-end screen's **Fares** stat reads.
Any fare's clock expiring ends the run outright (there's no separate life to lose), so today a
"streak" and a running total of deliveries are the same thing read two ways. The name is chosen
for where this is going: a patience or combo mechanic that can break a streak without ending the
run is the natural next step, and `updateStreak()` is the one place that would need to change.

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

**There is no longer a case where holding it does nothing.** A taxi that had just picked someone up
used to be `parked` — waiting at the kerb for you to tap a destination — and `parked` sets
`allowed = 0` ahead of anything boost can do, so Loco Mode was dead in the hand until you'd
dispatched the car. Now [the drop-off dispatches itself](#the-drop-off-dispatches-itself) and the
taxi is never parked with a rider aboard; boost applies from the pickup frame on. Every other
reason the taxi slows while boosting is traffic, and those are dealt with in
[traffic.md](traffic.md#what-was-still-braking-it).

Pointer capture on `pointerdown` keeps the boost held even if the finger slides off the pill;
`pointerup`, `pointercancel`, `lostpointercapture` and the window `blur` all release it, so
alt-tabbing or switching apps never leaves the boost stuck on.

Every successful drop-off tops the tank up by **15%** — `boost.topUp(0.15)` queues the fuel as
*pending* and pours it in over ~0.3s so the bar visibly fills rather than snaps. A short green
pulse behind the pill (`.is-topping-up`, matching the flying `$20`) is the flash that ties the
top-up to the same payout the earnings pop is announcing.

While active the taxi runs at 2.2× speed, forces its next junction green, doesn't slow for
corners, lays **skid marks** off the line and through turns, and kicks up **dust**. See
[rendering.md](rendering.md#effects) for how those two are drawn.

The press itself also fires a **wheelie**, a tailpipe **flame burst** and a half-second launch
streak of rubber — all three gated on `boost.press()` returning true, so they fire on the
transition into Loco Mode and not on a re-press during a boost that's already running.

## The run-end screen

`src/game/runend.js`, styled in `index.html` under `#run-end`. The run ends three ways — a fare's
clock hitting zero, a collision, a police bust — and all three land on the same screen: a title, the
reason, four stats, and **Play again**. The title is set by the caller, so a bust reads **Busted**
while a timeout and a wreck read **Game Over**.

It is a **full-screen blackout**, not a modal over the city. An earlier pass dimmed the world and
floated a blurred card on top of it, and the card's edges turned out to be the loudest thing on the
screen. Blacking the whole viewport out puts the run's numbers on nothing at all, which is what
makes them the ending rather than an overlay on one.

The stats are **one row each, label and value side by side**, and both are set in the *same* size,
weight and colour. A small grey caption over a big yellow number made the label read as chrome and
the number as the content, when the pairing is the content; matched type makes each row one phrase
— "Fares  9" — and the four rows read as a list being counted out, which is what the stagger is
doing.

It reads as a **ledger**: label pinned to the left edge, value to the right, on a `1fr auto` grid
so the label column takes the slack and the values stay flush right however long the names get.
Both edges are then straight lines down the block, which is what lets four rows of identically
styled text read as four separate stats — centring each row on its own left the list ragged.
`.stat` is `display: contents` so its label and value become grid items of the row above; the
wrapper only exists for the reveal to animate a stat as a unit. Each entrance is anchored to the
edge its text is aligned to (`transform-origin: left`/`right`), so the label's oversized first
frame and the value's landing bump both grow *inward* rather than out past the container.

**The content container is capped at a phone's content width** — 358px, a 390px screen less its
16px gutters — so the desktop layout *is* the mobile layout. Pushing label and value to opposite
edges of a 1280px screen would strand each number three feet from its own name; at phone width the
gap is a gutter rather than a void, and the fail reason wraps on desktop exactly as it does on a
phone. On a phone the rows run right out to the screen edges, which is the layout the cap is
borrowing.

Type and rhythm scale with the viewport, off whichever axis is tighter: height for the list as a
whole (a landscape phone runs it past the fold) and width for the rows (`"Top Speed  54 mph"` at
30px is ~260px wide, and `nowrap` would push it off a 320px screen rather than wrap it). If it
still doesn't fit, the overlay scrolls — centred by `margin: auto` on the content rather than
`justify-content`, which clips its own overflow at the top, where the title is.

**Nothing appears at once.** The card is revealed as a sequence, because the version before this
one wrote a single line of `innerHTML` and the whole screen arrived in one frame — which reads as
the game stopping rather than as a scoreboard. The order is title → reason → each stat in turn →
**Play again**, and each stat's label **scales down** into place as it fades up before its number
rolls from zero. A number that rolls gets read; a number that is printed gets skipped past on the
way to the button. The button is last on purpose, appearing only once the final stat has finished
counting, so the player isn't invited to leave mid-tally.

**The stats are counted out one row at a time**, not staggered. A row's label arrives, its number
rolls, the number lands and pops, and only after a held beat does the next label appear. An earlier
pass overlapped the rows on a 165ms stride, and with four of them counting simultaneously the block
read as one animation with numbers moving inside it — you watched the screen rather than any single
figure. `STAT_STRIDE` is now *derived*: `ROW_MS + ROW_GAP`, where `ROW_MS` is a row's own beat
(`COUNT_LEAD + COUNT_MS + LAND_MS`). "Finished before the next one starts" is therefore a property
of the constants rather than something to keep re-checking by eye.

The whole cadence is ~3.5s and lives in the timeline constants at the top of the module rather
than in CSS keyframe delays, so it can be re-paced from one place and so the sequence works for
however many stats it is handed. Playing the rows in turn roughly doubled the wait, so **a tap
anywhere skips to the end** — finishing every animation and landing every number — and the retry
pill is `disabled` (and so `pointer-events: none`) until then, which both keeps an invisible button
from reloading the run mid-tally and lets a tap aimed at it fall through to the skip.

The counters are anchored to their **first animation frame**, not to `performance.now()` at build
time. A WAAPI animation starts on the frame after `animate()`, and the game-over frame is exactly
where the page hitches — on a stalled boot the numbers ran ~500ms ahead of their own labels, which
for a list played one row at a time meant a row counting before it had appeared.

The overlay sits at **`z-index: 30`**, above the toast (25) and the tweak toggle and rider-finder
chips (20). Without one the blackout painted *under* them and a waiting-rider chip stayed lit in
the corner of the game-over screen — and a chip still on top also swallows the tap that skips.

Under `prefers-reduced-motion` the card prints its final values with no entrance and no roll — the
sequence is the entire module, so there is nothing else to keep.

| Stat | Source | Notes |
|---|---|---|
| Fares | `fares.state.delivered` | |
| Streak | `fares.state.delivered` | same count as Fares — see [the streak counter](#the-streak-counter) |
| Cash | `fares.state.money` | |
| Red Lights | `traffic.stats.taxiRedLights` | reds the taxi *met*, one per light |
| Top Speed | `traffic.stats.taxiTopSpeed` | u/s, shown in mph |

Both traffic stats are taxi-only, accumulate over the whole run, and are never reset — a run ends
by reloading the page. They exist for this card and nothing in the sim reads them, which is exactly
why `tools/probe.mjs` asserts them: a counter that quietly stopped incrementing would otherwise
only show up on the run-end screen at the end of somebody's run.

**Red lights are counted per light, not per frame.** The junction is stamped on the taxi the first
time a red holds it and cleared when the turn commits, so sitting at one light for four seconds is
one red and coming back to the same junction later counts again. It reads the signal phase
directly rather than the `green` flag, because `green` also goes false for a junction blocked by a
stranded car — that is a jam, not a red. Ring junctions are exempt: they have no phase to be red.
A right-on-red still counts; the light was red when the taxi reached the line.

**Top speed is shown in mph** via `speedMph()` in `sim/traffic.js`. World units are metres-ish —
`CAR_LEN` is 3.4 against a real compact at ~4.4m — which puts one u/s at about 2.9mph and lands
the numbers where you'd want them anyway: cruise 8.5 → **25mph**, Loco Mode 18.7 → **54mph**.
Nothing in the simulation uses the conversion; it exists so the stat is in a unit a player has a
feel for.

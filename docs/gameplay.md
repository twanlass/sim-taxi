# Gameplay

## The opening tutorial

`src/game/tutorial.js`, with its markup and styling in `index.html` under `#coach`. A white speech
bubble in the bottom centre with the player's own taxi turning in a round avatar, and the line
typing itself out. **Two beats, and that is all of it:**

1. **"Let's pick up some rides and earn some cash."** The camera follows the taxi while it types.
   The one thing a new player cannot work out by looking is which of the hundred cars down there is
   theirs — so the car itself says it, and the camera puts it in the middle of the screen. Tap to
   dismiss.
2. **"Tap this rider to pick them up."** The camera pans to the waiting fare and the bubble comes
   back once it has arrived, so the figure it is talking about is on screen before it starts
   talking. Tapping the rider ends the tutorial; so does tapping the bubble.

Nothing else is taught. The drop-off [dispatches itself](#the-drop-off-dispatches-itself), the
clock is [a coloured crystal over a head](#the-fares-clock-travels), and Loco Mode is a pill with a
label on it — none of those need a sentence, and every extra beat is one more thing between the
player and the game.

### It does not spend the player's clock

`fares.setPaused` holds every fare's countdown while the bubble is up. Only the countdown: fares
still spawn, riders still wave, diamonds still bob, and the city carries on behind the bubble. A
tutorial that taught you how to pick someone up out of the sixty seconds you need to *deliver* them
would be charging for its own lesson. The spawn toast is suppressed for the same reason — the first
fare lands on frame one, and "New fare waiting" across the top of the screen is a second message
competing with the one being given.

Nothing auto-advances. Both beats wait for a tap, because a tutorial on a timer is one the slower
reader loses. A tap mid-type finishes the line instead of dismissing it, so an eager first tap
cannot throw away a sentence nobody has read.

### Where it sits in the camera's priority list

Below Loco Mode, above the [opening follow](architecture.md), and — unlike either of those — it
runs on **every** viewport, not just narrow ones. A desktop player has the whole city in frame and
still cannot tell which car is theirs, which is the entire reason the first beat exists. Because
moving the framing on a wide viewport takes away the default whole-city shot and nothing there
would ever put it back (drag-to-pan is narrow-only), the tutorial glides the camera home when it
finishes. On a phone it doesn't need to: the opening follow-cam picks the taxi back up.

A swipe hands the camera over mid-tutorial, the same as anywhere else — the bubble keeps talking,
it just stops moving the map while the player reads it.

`?tutorial=off` skips the whole thing, and shot mode never runs it: a screenshot has nobody to
teach, and the bubble would be the loudest thing in every frame.

## The fare loop

`src/game/fares.js`. Each fare is its own little machine — `waiting → riding → gone` — carrying its
own clock, its rider, its drop-off and the one marker that travels between them. Up to
`MAX_FARES = 3` run at once, and because the taxi has one seat, that means up to two riders can be
waiting on the kerb at the same time.

1. A passenger spawns at a random intersection (never the one the taxi is already about to reach)
   with a **60-second clock** (`FARE_SECONDS`) and a
   [diamond](#the-fares-clock-travels) over their head, coloured by how much of that clock
   is left. The whole trip is drawn now; none of it is shown until they board — see
   [Neither how far nor where](#neither-how-far-nor-where).
2. Tap them → the taxi routes there.
3. On arrival the passenger boards, their diamond flies from the kerb to the roof of the taxi, a
   teal ring appears on the road where they're going, and the taxi **drives straight on to it** —
   because the instruction it used to ask for is now given for you. See
   [The drop-off dispatches itself](#the-drop-off-dispatches-itself).
4. Deliver → the fare pays out (`FARE_BASE + FARE_PER_BLOCK × blocks`, see [Economy](#economy)),
   and the board refills.
5. **Any** fare's clock expiring ends the run.

## The drop-off dispatches itself

**A rider getting in is the taxi's instruction to drive them.** `dispatchToDropoff` in `main.js`
routes at the drop-off on the pickup frame; the player never taps a destination pin.

The tap it replaced confirmed a choice with exactly one option. Where the rider is going was
decided when they spawned — the price is fixed from it — and their pin is on the map the instant
they board, so the second tap added no decision, only
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

## Neither how far nor where

Both ends of a trip are **drawn** the moment a rider spawns — the price is fixed from the length, so
both have to be known — but nothing about the far end reaches the player until they're aboard. What
a rider on the kerb offers is a clock and a place to drive to.

Two stages of showing more were tried and both came back off.

**A preview pin** standing on the far kerb from spawn, smaller than a live one and with its bounce
held. It made "which fare do I grab?" a real decision instead of a coin flip, but it also meant
three riders and three destinations on the board at once. Screen distance would not have been trip
distance anyway: two pins forty pixels apart can be a four-block drive or a one-block one depending
on which way the streets run.

**A distance bar**, which replaced it — three fixed segments in the rider's meter saying short,
medium or long, a coarse read on the price with none of the pin's clutter. It went with the meter.
The bar was a second thing to parse in a glance the player only ever spends one read on, and the
read they actually make is the clock: on a board with two waiting riders the wrong pick loses a
whole fare, and a slightly cheaper fare delivered beats a dearer one that timed out. Once the plate
was down to one bar it was not a meter any more, and a colour on the rider's
[diamond](#the-fares-clock-travels) says urgency without any parse at all.

What went with it is real and worth saying plainly: the payout is no longer legible before the
choice. Fares are still priced by distance, so a long haul still pays more — the player just finds
out on delivery. "Which rider?" is a timing question now, not an economic one.

The pin lands exactly where it was drawn at spawn — it never moves — so nothing about the reveal is
a re-roll. `tools/probe.mjs` asserts both halves: hidden while the rider waits, and at the drawn
junction the frame it appears.

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
diamond over their head carrying how close each one is to giving up.

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
rider, so a colour on the *person* would imply a commitment that doesn't exist. The crystal over
their head and the disc under their feet are both spoken for by the clock, which is why the figure
between them has to stay out of the way.

The **roof sign** lights up while a rider is aboard and goes dark once they're dropped off — a
plain on/off, not a colour. It used to wear the fare's own colour, drawn at spawn from a five-colour
palette (`nextFareColor()`), because that colour was what paired a rider with their drop-off pin
across the map. The drop-off carries no fare colour any more, so with nothing left to pair with,
the sign's job shrank to the one thing still worth saying at a glance: is the taxi free.

#### The drop-off is a teal ring, and nothing else

The disc on the tarmac and the off-screen pointer that stands in for it are one fixed **teal**.
Nothing floats above it.

**It lost its head.** The drop-off was a crystal on a gold post, then the crystal alone at rooftop
height, then that crystal in teal once a waiting rider's marker became the same model. That last
step is what finished it: two diamonds on the board, and only one of them reporting anything. The
player had to tell "a clock is running here" from "this is just a place", by hue, on two shapes
that were otherwise identical — when the ring underneath was already saying "this is just a place",
at ground level, where the driving happens. So a diamond on the board now means a clock, and a ring
means a destination.

What went with it is the rooftop silhouette: the crystal stayed visible over the skyline for a beat
after the ring itself had slipped behind a tower. The
[off-screen pointer](rendering.md#off-screen-drop-off-pointer) covers the far end of that — a
drop-off outside the frame — and inside the frame the route band runs all the way into the disc, so
there is a line to follow to it. A drop-off briefly hidden behind a building on a road you are
already driving down is the case that is genuinely worse, and it is worth what it buys.

Teal is the point of the colour. Hue on a fare marker now *means* urgency — that is what the
[diamond over a rider](#the-fares-clock-travels) is saying — and the drop-off has nothing to report:
no clock of its own, and by the time it is drawn the taxi is already driving at it. A colour outside
the green-to-red scale is what says "this one is not on it". It wore **Loco Mode's yellow** before,
on the grounds that the route band, the car and the place it is driving to should be one colour
saying "this is the job"; but yellow is the taxi's, and a marker that reports nothing was borrowing
from a vocabulary it isn't part of. The band is still yellow, so band and disc meet at the kerb in
different colours — the band belongs to the car, the disc to the road. See
[rendering.md](rendering.md#the-drop-off-ring--geometrymarkerjs).

The one decision all of this defers is still deferred: nothing on a marker says which *taxi* is
taking a trip. The day there is more than one, that stays the player's call.

## Routing

`src/game/route.js` is Dijkstra over the road network's **lanes** — 120 of them at 5×5, instant.

A lane is a directed half of one road, so it says both which junction you are heading toward and
how you got there. It has to say both, because `legalExits` forbids U-turns: a plain junction node
would plan routes that flip direction on the spot, and the car could never execute them. This is
the same state the router used to spell `(i, j, d)`; what changes is where the successors come
from. They are now `lane.onward` — the turns the network baked at that junction — rather than
`(d + 1) % 4` arithmetic. A three-way, a diagonal or a roundabout has legal moves that direction
arithmetic cannot name; a lane's exits are whatever the geometry says they are.

Two details are load-bearing and easy to lose:

- **Exit order is straight, then right, then left.** Dijkstra here scans the open set and keeps
  the first minimum it finds, so successor order decides which of two *equal-cost* routes the taxi
  drives. The network fixes that order at bake (`HAND_ORDER` in `roadnet.js`) rather than leaving
  it to the order edges happened to be created in.
- **Cost is read off the lane** (`lane.klass`, `lane.withWave`), not recomputed from `(i, j, d)`.
  An editor-drawn arterial has no line index to look either up by.

`tools/roadnet.mjs` asserts the ported router returns the *same route* — not merely a route — as
the grid router did, over all 5,184 `(start, heading, target)` triples on three seeds.

`planOrigin(car)` handles the subtle case: **a car mid-turn has already committed its choice**, so
planning from its current intersection produces a route whose first step is silently skipped and
every later turn lands one intersection early. Planning starts from the intersection the taxi is
*heading toward*, plus its current heading — the first point at which it can still make a choice.
It finds that intersection by asking the network where the lane the turn is landing on ends.

The route it hands back is still a list of grid directions, because `traffic.js` still stores
`car.d` and drives `(i, j)` to `(i, j)`. That conversion (`laneDir`) is the one piece of `route.js`
that only works while the city is a grid, and it comes out when the sim drives lanes directly.

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

## The fare's clock travels

`src/game/faremarker.js`. The countdown is a **physical object that belongs to the fare** — not a
HUD number, not a property of a marker, and not something that changes hands. A geodesic crystal
floats over the rider's head on the kerb, painted by how much of their clock is left: green → yellow
→ orange → red, [by level](#urgency-is-one-scale). The instant they get in it **flies to the taxi**
(`TRANSFER_TIME = 0.65s`, eased, with a small arc) and keeps draining above the roof, because from
that moment the deadline is the car's problem.

**A disc under the rider's feet carries the same colour.** One hue, said twice: the crystal at eye
level where the eye happens to be, and the disc on the ground, which is where the taxi is actually
being aimed. The disc is the [drop-off's own shape](#the-drop-off-is-a-teal-ring-and-nothing-else)
in the fare's urgency colour rather than teal, so "a disc is a place the taxi has to reach" holds at
both ends of a trip and the hue is the only difference between them. It also survives what the
crystal does not: a rider behind a tower still has a mark on the road, because the disc is on a
plane the buildings mostly don't cover.

It never drains — time is the colour's job — and it **goes dark the moment they board**. The kerb
corner stops meaning anything then; the clock leaves with them, and a disc left glowing on an empty
pavement reads as another fare waiting there.

**The rider getting in and the deadline moving into the car are one gesture.** Nothing is created or
destroyed at the hand-off — the same object leaves the kerb corner it has been standing on and
crosses to the roof, which is the whole reason the flight is animated rather than a teleport. It is
also why the marker holds **one altitude** on both ends: the transfer reads as sliding sideways
rather than climbing into a different slot.

That flight is tuned against `BOARD_SECONDS = 0.9`, so the clock lands on the car a beat *before*
the rider figure finishes climbing in. The deadline arrives, then its owner does.

### It used to be a relay

Two objects did this job in turn: this diamond over the rider, and a **timer ring** — a swept
annulus lying on the road around the taxi, which took over at pickup while the diamond vanished.

The ring was the finer instrument, and losing it is a real cost. It drained *continuously*: a
`setDrawRange` sweep clockwise from screen-top over 96 segments, so the arc's length was the time
left, and a player could see a clock at 40% rather than at "orange". The diamond has four steps.
On the riding leg that is strictly less information.

What it bought is that there is nothing to learn. Two objects meant two vocabularies for one
deadline, and the hand-off between them was a moment the player had to be taught — the ring
appearing on the road at the same instant the diamond disappeared off the kerb reads as *two*
events, not one thing moving. A marker that simply flies across says it without teaching anything,
and the fare's clock is now one shape from spawn to drop-off.

The **panic pulse came across** with it: below 5 seconds the crystal beats, a ~3.5Hz sine scaling
between 1.0 and 1.15. Threshold in seconds, not fraction, so "five left" stays five left when the
debug panel has tuned `fareSeconds` away from 60. The pulse and the red level are the same object,
so the two urgency cues stack rather than compete for the eye. It now runs on the kerb as well as in
the car, which the ring never did — a rider about to give up is exactly as urgent as a delivery
about to fail.

What went with the ring, besides the sweep: it drew **on top of everything** (`depthTest: false`),
so the clock stayed legible through towers. The diamond is an ordinary depth-tested object — an
inverted-hull crystal cannot skip the depth test without painting its own back faces over its front
ones — so a taxi behind a building now takes its clock with it. The taxi's own
[ghost outline](rendering.md#taxi-ghost-outline--geometryghostoutlinejs) still says where the car is; the
seconds are what you lose sight of.

A whole apparatus went with the ring too, and its absence is worth recording: the `ABOVE_RING`
renderOrder that the rider's meshes and the taxi's shell, wheels and sign all wore. A flat circle
drawn with the depth test off projects its far half *upward on screen* at this camera angle, across
whatever is standing at its centre — so the ring sliced its own owner in half, and the fix was
drawing everything that stands inside it afterwards. Nothing lies on the ground any more, so all of
that is gone.

### What the crystal does

**A level change kicks it.** The crystal swells to 1.1 and hops about 4px, snapping up and easing
back over `KICK_TIME = 0.36s`. The colour snaps between four steps and is the news, but a hue change
on a 29px shape at the edge of the eye is easy to miss outright — and the ones that matter land
while the player is watching the road, not the kerb. The motion is what buys the glance; the colour
is what pays it off. It is deliberately a *beat* and not a state: over well before the next level
lands, so two fares at different levels are told apart by hue and never by whether something is
moving. A fresh rider does not kick on spawn — a marker that pops the moment it appears is
announcing a change that hasn't happened.

**It inks over in heavy black** once the taxi has been sent at that rider: the same outline the
crystal always wears, drawn at `1.34` instead of `1.12` — about 5px of rim against 1.7px at play
zoom. On a board with two riders waiting it is the only thing saying which of them the car is
already on its way to. The rim was the taxi's **yellow** first, which is what "you told me to do
this" means everywhere else in the HUD; but this crystal spends a quarter of every clock *being*
yellow, and a yellow rim on a yellow diamond is no rim at all. Black is the one value nothing on the
urgency scale can collide with, so the state reads as weight rather than hue. `markDirected` pushes
it so the rim lands on the same frame as the route band; the per-frame tick reconciles it, because
`directed` is also *cleared* from elsewhere and one place that reflects the flag cannot drift from
it. It comes off at pickup: it answered "which of the two waiting riders is the car already going
to?", and a fare in the car is not one of those.

A **diamond on the board means exactly one thing: a clock is running here.** The
[drop-off](#the-drop-off-is-a-teal-ring-and-nothing-else) wore the same model for a spell and gave
it back, because a second crystal reporting nothing made the shape ambiguous.

### What it replaced on the kerb

Four things, in this order:

- **A shaft of light** over the rider, which marked them at range and said nothing else.
- **A draining ring on the kerb**, an earlier body for the same clock. A disc is back under the
  rider now and it is worth being clear about what changed: that one *was* the clock, a countdown
  the player read by how much of it was left, and it was the only thing marking the corner. This one
  reports nothing on its own — it repeats the crystal's colour, and the crystal is the clock.
- **A seven-segment block count**, which was more precision than the decision needed and cost a
  read to parse.
- **A meter**: a dark plate carrying a four-segment urgency bar over a three-segment distance bar.
  It is the one of the four this was a genuine trade against rather than a straight win — see
  [Neither how far nor where](#neither-how-far-nor-where) for what the distance bar was doing and
  why it went. What the diamond wins is the read: a hue is taken in at a glance where a count of
  lit blocks is parsed, and the level was always the news rather than the number.

The meter was a bright ~67 × 27px slab; the diamond is ~29px across. Smaller, but saturated,
outlined, bouncing and kicking on every level change, which is what a marker needs to be found at
range — and three of them no longer crowd a city whose blocks are only ~92px across.

### Urgency is one scale

`src/game/urgency.js`. Four levels, even quarters of the clock, each with its own colour.

Two surfaces show it — the fare's diamond, wherever it currently is, and the countdown around each
rider-finder chip — and they both read from here. A rider showing orange on the map whose chip is
yellow in the corner is two answers to one question. It was three until the
[timer ring](#it-used-to-be-a-relay) went, which is exactly why the scale was pulled out of the ring
into its own module in the first place.

Even quarters rather than the ring's old 0.60 / 0.35 / 0.15 bands: those held the top level through
the first 40% of the clock and then ran through the other three in a rush. The levels outlived the
bar they were segments of — `URGENCY_SEGMENTS` is now just how many steps the scale has.

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

`N×` at top-right, opposite the money counter, and on screen from the first frame reading `0×` —
same as the money counter starting at `$0`. It used to stay hidden until the first drop-off, but
an empty corner gives the player nothing to aim at; the visible zero states the goal.
`updateStreak()` in `main.js` bumps the number in the taxi's own yellow (not cash green, so it
doesn't read as a second money event) on every delivery, the first one included. No flight off the
taxi the way the payout gets one; the streak isn't travelling from anywhere. It lives outside
`#hud`, so shot mode hides it with its own rule rather than inheriting `#hud`'s.

The count is `fares.state.delivered` — the same number the run-end screen's **Fares** stat reads.
Any fare's clock expiring ends the run outright (there's no separate life to lose), so today a
"streak" and a running total of deliveries are the same thing read two ways. The name is chosen
for where this is going: a patience or combo mechanic that can break a streak without ending the
run is the natural next step, and `updateStreak()` is the one place that would need to change.

### Priced by the trip

Each fare is priced by **trip distance**, not a flat rate: `FARE_BASE + FARE_PER_BLOCK × blocks`,
where `blocks` is the Manhattan distance between the pickup and drop-off intersections. The
price is fixed at spawn — the moment both endpoints are known — and stamped on the fare so a
long haul that runs into traffic pays the same as one that flies through green lights. Metering
during the trip would double-count the clock and reward Loco Mode for the wrong reasons.

The player does not see that distance before choosing — a bar over the rider's head used to
advertise a tier of it, and went with the meter (see
[Neither how far nor where](#neither-how-far-nor-where)). So the price is a fact about the trip
rather than a term in the decision: what a long haul costs the player is the clock it eats, and
paying more for it is the game being fair about that afterwards.

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
short slice, a long hold flows until the tank is empty. Full tank is 15 seconds of boost. The
decision is now *how long* to press as well as *when*. The button doubles as the dial: a `--pct`
CSS variable tracks the fuel level, dropping as you drain and climbing as a drop-off pours fuel in.

**The meter never refills on its own.** The run opens with **a third of a tank** and each
successful drop-off pours in **another third** — that is the only source of fuel. Spend it all and
the pill goes grey and dead (`.is-empty`, `disabled`) until you deliver someone. A top-up that
lands while you're still holding the button rolls straight back into boost rather than making you
press again.

Both ways out of a boost — letting go, and running the tank dry — pass through the one-second
`'cooldown'` momentum window first, so `'empty'` is where a drained tank lands *after* that tail
rather than the instant the fuel runs out. See
[traffic.md](traffic.md#boost-crazy-taxi-mode) for what stays armed through it.

That is a deliberate replacement for the old economy, which handed back 15% per drop-off but also
fast-recharged from empty in 15s and trickled a partial tank back up at a fifth of that rate. Under
those rules waiting was a valid way to get boost back, so the meter said nothing about how the run
was going; now every second of it was earned by a fare, and three deliveries is a full tank.
Opening with a third rather than empty keeps the toy in reach on the first fare — an empty start
leaves the button dead in the hand until the first drop-off lands.

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

### The refill animation

A drop-off pays two currencies and for a while it only showed one. The flying `$20` says *money*;
nothing said *and a third of a tank*, so the meter simply grew on its own in the corner of the
screen with no visible cause. `src/game/energybits.js` is that cause: **six little yellow sparks
break off the taxi and get pulled into the Punch It pill**, and the tank is topped up when the first
one lands, not on the delivery frame. A meter that starts filling a second and a half before
anything visibly reaches it reads exactly backwards.

They are **sequenced behind the payout, not fired alongside it** — the handoff is 1000ms, set from
the payout's own flight (620ms rise + 460ms fly), so the coin has landed and gone before the first
spark appears. Two swarms leaving the same car at the same time for two different corners is noise,
and the two currencies stop reading as two. The cost is that a delivery's fuel arrives ~1.6s after
the drop-off rather than immediately; that delay is the effect, and it's short enough to sit inside
the gap before the next fare is worth chasing.

Both endpoints are resolved as functions at burst time rather than baked in at call time, so a taxi
that has driven on — and a pill a resize has moved — are still aimed at correctly. If the pill is
hidden (shot mode, or the run-end blackout) the flight is skipped and the fuel is handed over
anyway: losing earned boost to a presentation detail would be a real bug wearing a cosmetic one.

Then the pour itself. `boost.topUp(BOOST_FARE_REWARD)` queues the fuel as *pending* and pours it in
at half a tank per second (~0.7s) so the bar visibly fills rather than snaps. Since that pour is now
the *only* way fuel ever enters the meter, it carries the rest of the reward and gets three more
layers, all timed by `src/game/boostmeter.js` and shaped in `index.html`:

| Layer | What it does | Wiring |
|---|---|---|
| **Overfill** | The bar runs ~7% of a tank past its new mark, then rings back down onto it | `--pct` |
| **Flutter** | The whole pill throbs — glow and 3.5% of scale together, 8Hz — for as long as fuel is arriving | `--fill` × `--pulse` → `.is-filling` |
| **Leading edge** | A blurred near-white line rides the front of the fill, fading in with the pour and out with the bounce | `--fill` → `#boost::after` |

`boostmeter.js` is pure and DOM-free for the same reason `boost.js` is: `main.js` reads three numbers
off it and writes three CSS variables, and the probe drives it with a real pour and asserts on the
same numbers. It keys off `boost.state.pending`, so nothing has to remember to fire the animation and
a second delivery landing mid-pour just extends it.

**The overshoot is authored, not simulated.** The obvious version — draw the bar as a spring chasing
the real fuel level and let its momentum carry it past the mark — was built and measured first: 3.3%
of a tank at its best (K=160, C=4), about 4px on the pill, and a 1.4s wobble to settle. A spring
following a ramp can only overshoot by around v/ω, and a 0.5-tank/s pour against any ω fast enough
not to look sluggish leaves nothing to work with. The scripted kick starts on the frame the pour
finishes, so it still doesn't read as a jump — the bar is already travelling at the pour rate and the
kick just carries it further, 0.1s out to the peak.

**Coming back is a damped ring, not a curve.** The first version eased from the peak down onto the
mark and stopped there, which is the exact moment the eye is on it, and it read as linear — the bar
*arrived* rather than *settled*. The peak now releases into a decaying cosine (4Hz, e-folding at 7/s)
so it dips under the mark, comes back over it smaller, and converges: off a 7% overshoot the swings
measure **-2.9%, +1.2%, -0.5%, +0.2%**, then it snaps to the real level once the ring is under a
fifth of a pixel, about 0.55s in. This is the spring the scripted kick doesn't get for free.

The flutter is deliberately fast. At 5Hz the pill read as *breathing*; the point is a signal that
something is being poured in right now, so it sits at the top of what still reads as a pulse rather
than a flicker. It moves the pill itself, not just the glow, which is what makes it visible at the
edge of vision — where this button is while the player is watching the road. `prefers-reduced-motion`
drops the scale and keeps the glow and the edge.

The glow used to be a one-shot green flash matching the flying `$20`. Green read as *money*, which
is what the earnings pop already says; yellow says *this is boost*. Driving its alpha from a variable
rather than a keyframe is also what lets it fade out cleanly however long the pour ran, instead of
snapping off when a fixed-length animation ends.

While active the taxi runs at 2.2× speed, forces its next junction green, doesn't slow for
corners, lays **skid marks** off the line and through turns, and kicks up **dust**. See
[rendering.md](rendering.md#effects) for how those two are drawn.

**Releasing isn't an instant off.** For `BOOST_COOLDOWN` (1s) after the button comes up — or the
tank runs dry — the taxi is still exposed to everything Loco Mode was: it can still crash into
traffic, still gets caught if a cop is in bust range, still forces the next light. What it loses
immediately is the speed — the cap drops back to cruise the moment the hold ends, and ordinary
braking (the same constant every other stop uses) hauls it down from 18.7 to 8.5 in under a
second, nose dipping hard the whole way. So letting go a beat too late doesn't buy safety; it buys
a car that's still committed to whatever's in front of it while visibly losing the ability to
dodge. Re-pressing mid-cooldown cancels it and snaps straight back to full send. See
[traffic.md](traffic.md#boost-crazy-taxi-mode) for the mechanism.

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
the numbers where you'd want them anyway: cruise 8.5 → **25mph**, Loco Mode 18.7 → **54mph**, and
the top of its [overdrive band](traffic.md#overdrive-only-on-a-straightaway) 22.95 → **67mph**. The
stat is worth reading now that the top end has to be driven for: 54 says you used the mode, 67 says
you found two clear blocks in a row to spend it on.
Nothing in the simulation uses the conversion; it exists so the stat is in a unit a player has a
feel for.

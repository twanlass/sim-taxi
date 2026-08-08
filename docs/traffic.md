# Traffic

`src/sim/traffic.js` is the largest file in the project and the one to read first. It owns signal
timing, car physics, and the single branch that makes the player's taxi different from everyone
else.

## The one routing branch

**A routed taxi is just a car whose turn choice comes from a route instead of a dice roll.**

There is exactly one place in the file where a car picks its exit direction at an intersection. A
car with a `route` takes the next step from it; everyone else rolls the weighted
straight/right/left dice. Everything downstream — signals, following distance, left-turn yielding,
don't-block-the-box — is untouched and applies to the taxi identically.

That single-branch design is load-bearing: it's why the taxi cannot cheat its way to a
destination, and why gameplay changes rarely need to touch traffic code. The taxi lives in the
same `cars` array as ambient traffic and is drawn as its own mesh only so it can be raycast and
highlighted.

**Which car becomes the taxi is a pick, not always the first draw.** `createTraffic` draws the
whole `count` uniformly, same as ever, then flags whichever car is heading for the intersection
closest to the middle of the grid as the taxi — downtown, per `layout.js`'s own density falloff —
rather than always `cars[0]`. A run used to open with the taxi anywhere on the map, including a
corner, and the first fare (biased to spawn near the taxi — see
[gameplay.md](gameplay.md#extra-fares-and-prioritisation)) followed it there.

Picking from the draw rather than drawing the taxi's spot separately with its own filter is
deliberate: it keeps this file's rng stream exactly what it was, so nothing downstream — the rest
of this same draw, `tools/probe.mjs`'s staged two-car boost scenarios, anything else reading from
this `rng` — consumes a different number of random values than before.

## Signals

The scheme that shipped first was `phaseOffset = ((i + j) % 4) * (CYCLE / 4)` on a 16.2s cycle.
Measured, that was **4** distinct timings across 36 junctions, **18 of 36** flipping within the
same half-second, and green-on-arrival at exactly **50%** — pure chance. It waved along the
*diagonal*, which looks synchronised while helping no actual road.

Three changes replaced it, each validated by `tools/signals.mjs`:

### Where the plan lives

The phase plan is **baked into the road network**, not computed from `(i, j)`. A phase is a
*street* — a pair of arms that carry on through the junction — rather than an axis, which is what
lets a three-way, a five-way or a diagonal junction have one at all. See
[roadnet.md](roadnet.md#signals-come-out-of-the-geometry).

The sim asks per **approach**, via `net.laneSignal(lane, t)`:

```js
{ signalised, open, yellow, remaining, street }
```

`signalised` is deliberately separate from `open`, because a red and no-light-at-all mean different
things to a driver — wait for green, versus yield on a gap. The old `{ axis, yellow, remaining }`
could only tell them apart by convention, returning `remaining: Infinity` for both a ring junction
and a green.

Asking per approach rather than per turn is the whole reason `phaseAt` alone was not enough: a car
asks "may I enter?" while still approaching, *before* it has chosen a turn. Every movement off one
approach shares a phase by construction, so the question is exactly as well-posed.

`lightPhase(i, j, t)` survives as a grid-shaped adapter for the probe and the metrics tool.
`approachSignal(car, t)` is what the sim uses, and it resolves the same layers in the same order:
boosting-taxi hold, police corridor, then the junction's own plan. The first two are still
grid-shaped because the things that *set* them are — that goes with `police.js`.

### Offsets from travel time

Each junction's offset is derived from how long a platoon takes to reach it, so consecutive greens
open ahead of moving traffic. This also de-synchronises the city for free, because offsets now
spread continuously instead of into four buckets.

The distance is **walked along a chain of edges** rather than read off a grid index. Same number on
an intact road; a defined one anywhere else. Where a park closure cuts an arterial in half, the
wave now restarts from the surviving chain's own head instead of being measured from a map edge the
platoon cannot reach — a wave cannot propagate across a road that isn't there. Measured across 12
seeds: 33 junctions shift, mean 4.39s of a 16s cycle, every shift a whole multiple of one
block-time (2.353s).

Cycle length stays common across the city on purpose — a shared cycle is the *precondition* for
coordination. Variety comes from splits and offsets, not from different cycle lengths.

### Arterials

Two roads per axis take a **64% green share** where they meet a side street, giving the map a
fast/slow grain. `layout.js` picks them and hands them to the network's bake.

### A signal-free ring road

The outermost roads carry no lights except at the four corners. Traffic joining from inside yields
into a gap (`RING_YIELD = 24` units of clear road).

"Unsignalised" is now `node.signal === null` rather than `ringAxisAt(i, j)`, and the difference is
not cosmetic. A junction the ring never touches can still end up with nothing to arbitrate — a
closure can leave an interior junction with only a straight-through — and the grid, deciding from
`(i, j)` alone, kept cycling a light there and held cars for a phase nobody could be in. Rare: one
junction in 40 seeds. It has no stop bars now, because there is nothing to stop for.

> Watch out: `phaseAt` returns **null** for an unsignalised node, where `lightPhase` returned an
> axis with `remaining: Infinity`. Any port that swaps one for the other while keeping `ringAxisAt`
> as the unsignalised test dereferences null at exactly those junctions — the grid says signalised,
> the network says no signal. The two have to move together.

Yielding is asked per **street** (`streetIsClear`) rather than per axis pair. `[0, 2]` / `[1, 3]`
was the last place the sim assumed a junction is two axes with two approaches each.

### Results

| | before | after |
|---|---|---|
| distinct signal timings | 4 | 12 |
| junctions flipping together | 18 / 36 | 6 / 36 |
| platoon meets green | 50% | 77% |
| throughput | 4.14 | **5.25** units/s per car |
| cars stationary | 51% | **39%** |

A sweep of cycle length against throughput came back **monotonic** — 14s gave 3.80, 28s gave 2.36
— so an early attempt at a "calmer" city with a 28s cycle made it materially worse. The calm comes
from spreading the offsets, not from slowing the cycle. Cycle is now **16s** with **1.6s** yellow.

### `lightPhase(i, j, t)` resolution order

Checked in this order, first match wins:

1. `priorityJunction` — the boosting taxi's next junction
2. `corridorCovers(i, j)` — an emergency corridor is running through this junction
3. `ringAxisAt(i, j)` — unsignalised ring road
4. the normal phase for this junction

A siren outranks the ring deliberately: otherwise a corridor crossing the ring would have a hole
in the middle of the green path it exists to create.

`displayPhase(i, j, t)` is the same resolution with step 1 dropped — it's what the stop bars are
drawn from, so the boosting taxi's hold never shows up on a lamp. See [Boost](#boost-crazy-taxi-mode).

## Where a car is

A car drives a **lane** — a directed half of one road, baked by
[the road network](roadnet.md) — and `car.s` is its **arc length along that lane**, from 0 at the
lane's start to `lane.length` at the junction boundary. There is no travel-direction sign to carry
around: `s` counts forward whichever way the lane points, and the position on screen is
`lane.path.at(s)`.

That replaces `(i, j, d)` plus a world coordinate on the travel axis. `car.i`, `car.j` and `car.d`
survive as a **view** of the lane, refreshed by `syncGrid` whenever the car changes lane, because
`game/routeline.js`, `game/fares.js`, `sim/police.js` and the probe still speak grid. They go when
those do.

The reason for the change is that a world coordinate on an axis is not a thing a curve or a
diagonal has, so the old representation could only ever describe a grid. Arc length is the property
that generalises — see the note at the top of `city/curves.js`.

### Car-following across a junction

This is the one thing the old model got for free and the new one has to work for.

`car.laneKey` used to be `"x|d|j"` — one **infinite** lane spanning the whole city — so a car saw
the queue on the far side of a junction because that queue was in the same list. (It also saw cars
three blocks away in the same row that it was about to turn away from, and queued behind them.)
Per-edge lanes end that, so the forward view is walked instead:

```js
ahead(lane, s, range)   // vehicles ahead, carrying straight on through junctions, nearest first
```

"Straight on" is the faithful continuation rather than an approximation of one — the old row *was*
the straight-through chain, and a car that turned off left the row and stopped being seen.

`LOOKAHEAD = 32` is derived, not tuned. A car brakes toward `sqrt(2 · BRAKE · allowed)`, so a
leader stops mattering once that exceeds the car's top speed: at the overdrive top (22.95 u/s) that
is 23.9 units of clear road, plus `BOOST_GAP`, so 28.4. Beyond that the leader cannot affect the
physics whether or not the bookkeeping can see it. 32 leaves margin and is exactly two lanes plus
the junction between them (12 + 8 + 12).

It was 26, derived the same way against the 18.7 that used to be the top speed. The
[overdrive band](#overdrive-only-on-a-straightaway) moved the ceiling and the horizon had to move
with it — 26 is 2.4 units short of a taxi in overdrive's own stopping distance, and a leader that
appears inside that is a rear-end rather than a lift. Ambient traffic never noticed either number:
at cruise a leader stops constraining beyond 3.3 units of clear road.

The same walk drives the Loco Mode scatter, which reaches `SCATTER_RANGE = 40` — two blocks.

> Watch out: a distance short of a junction can land *inside a junction box*, which no lane
> position can express. The infinite row could, and one probe scenario relied on it — staging a car
> 18 units back on a 12-unit lane, and the boosting taxi 30 units back from a junction one block
> from the map edge, i.e. 14 units off the western side of the city. `placeCar` and `approachRoom`
> exist so a test asks for the room rather than assuming it.

## Car physics

Cars accelerate and brake rather than snapping between speeds:

```js
SPEED  = 8.5    // cruise
ACCEL  = 6      // units/s² pulling away
BRAKE  = 11     // units/s² stopping; ~3.3 units from cruise to standstill
CORNER_SPEED = SPEED * 0.7
```

**Stop line setback.** `STOP_SETBACK = 3.4`. Cars used to hold with their *centre* on the junction
boundary, putting the nose 1.7 units inside and squarely across the crosswalk. The outer crosswalk
bar sits 5.65 from the junction centre, so the centre has to hold at ~7.35 for the nose to clear.

> Watch out: this setback once caused cars to drive off the map to x = −1064. A car spawning
> within 3.4 units of its target starts *past* the hold line, and a `distToLine > 0` guard meant
> the stop decision never fired. There is no guard now — don't reintroduce one.

**Right on red** is allowed with `RIGHT_ON_RED_YIELD = 15` units of clearance — shorter than the
ring's, because a right turn merges into the near lane rather than crossing it. The landing is
still governed by the usual don't-block-the-box check.

**The taxi runs yellows** (`taxiClearsYellow`). Ambient traffic still stops on yellow — the streets
would otherwise turn into a demolition derby — but the player's taxi treats a yellow-on-axis as
passable whenever it can still clear the far edge of the junction before the phase changes. That is
what a real driver does when they are already committed, and it stops the taxi braking to a crawl
half a block out for a light that is about to be gone. The physics is honest: at the taxi's actual
speed (with a floor so a car creeping up to the line still commits), does `distToLine + junction
width` divide out inside the remaining yellow, plus half a yellow of slack because cross traffic
still has to launch from standing when their green begins.

`lightPhase` returns `remaining` in seconds alongside `axis` / `yellow` so this check can be
made without recomputing the cycle. Corridor, priority, and ring branches return `Infinity`.

**Turns** follow a quadratic Bézier through the inbound lane's end, the turn's control point and
the outbound lane's start, with yaw interpolated by `lerpAngle` so a car never spins the long way
round. All three come off `car.turn`, straight from the network: the control point is where the two
lane tangents cross, which is `turnControl`'s rule with its "same axis falls back to the midpoint"
special case revealed as just that intersection being parallel. One rule covers a right turn, a
left, a straight-through and a sweep across a diagonal.

The *traversal* is deliberately unchanged — `turnLen` is still the control-polygon length and the
curve is still walked by Bézier parameter, not by arc length. Switching to the network's
arc-length turn path would make cars cross junctions about 20% faster, which is arguably more
correct but is a change to how the game plays, not to where the geometry comes from. Kept separate
on purpose.

`car.turn.hand` — `'straight'`, `'right'`, `'left'` — replaces comparing `dOut` against
`rightOf(d)` / `leftOf(d)`. It is what the corner-speed rule, the body roll and the random turn
weighting all read, and it is defined by the angle rather than by a lookup table, so a three-way
junction with two distinct lefts off one approach weights them both.

### Front wheels

The front pair steers. The angle is **read back from the path the car actually took** rather than
from the turn decision: `atan(WHEELBASE · dψ/ds)` is the Ackermann angle that produces the
curvature the car is describing, so one rule covers the junction arc, the Loco Mode weave and the
straight in between, and nothing has to be kept in step with the turn state machine.

Two things are deliberately outside it. The panic wobble is added *after* the difference is taken —
it is a shimmy through the body at ~0.9 rad per unit of road, and steering the wheels with it would
slam them lock to lock several times a second. And the ease is paced by **distance**, like the
weave and for the same reason: a car held at a red keeps the lock it rolled up to the line with,
and one stopped mid-turn waiting for room to land holds its wheels round the corner. That is also
what makes the divide safe — a stationary car never reaches it.

Measured over 240s of traffic, on the raw angle:

| | raw | rendered |
|---|---|---|
| right turn | 38.7° | 34° (on the clamp) |
| left turn | 15.0° | 24° |
| boost weave (p90) | 7° | 11° |
| straight on through a junction | 0° | 0° |

Right beats left by more than 2:1 because right-hand traffic cuts the near corner while a left
sweeps the far diagonal — the tighter arc genuinely wants more lock. `STEER_GAIN` of 1.6 is for
legibility, not physics: even on the doubled wheel, 15° moves the outline by about a pixel.
Everything under the clamp keeps its relative size, so a weave still reads as a flick and a corner
as full lock. Unwinding is the ease and nothing else — a car is down to 6.8° one unit out of the
junction and under 3° by three.

### Wheel size and ride height

`src/geometry/wheels.js` owns both, and owns them for every vehicle in the game. It is a module of
its own because `traffic.js` and `geometry/taxi.js` already import each other — a cycle that was
harmless while only functions crossed it, and stopped being harmless the moment a constant did.

The wheels are **double** what they shipped at (0.64 radius, 0.52 tread). At 0.32 the steering was
there and unreadable: a wheel was about 5px long at play zoom and its whole travel from straight to
full lock moved the outline by roughly a pixel.

Doubling alone is not enough, and the two failed attempts are the reason `CHASSIS_LIFT` exists:

- **Big wheels under an unchanged body** is the monster-truck look — the tops cleared the waistline
  and the car sat sunk between them.
- **Tucking them inside the flank** fixed the proportions and threw away the point. Occluded from
  this camera a wheel shows as a notch in the sill, and its angle goes straight back to being
  unreadable.

So the body rises with the wheel and the tread stays proud. Every y in the vehicle geometry — cars,
taxi, cruiser, and the app icon in `tools/make-icon.mjs` — is still written as the number it was
designed at, plus `CHASSIS_LIFT`, which is derived from `WHEEL_R` so the two can't drift apart.
The result reads as a chunky toy car up close and as an ordinary car at play zoom, which is the
zoom that matters.

The wheels don't **roll**, on purpose. At cruise a 0.32-radius wheel turns 0.44 rad per frame at
60fps against a facet every 0.79 rad on an 8-sided cylinder — past the half-facet point, so it
would strobe backwards. A 5px wheel spinning the wrong way is worse than one that doesn't spin.

Ambient cars carry theirs as a **second InstancedMesh** of two instances per car, each composed
*through* the body's matrix so it inherits the bob, the corner lean and the pitch rock for free.
They can't ride in the body geometry, which is one shared matrix per car. The taxi's are ordinary
meshes on its group, since it is drawn as a group anyway.

The rule itself is `steerToward()`, exported because the police cruiser runs it too — see
[The bust chase](#the-bust-chase).

## Boost (crazy-taxi mode)

```js
BOOST_SPEED = 2.2     // multiplier on top speed
BOOST_ACCEL = 24      // reaches full boost speed in well under a block
BOOST_KICK  = 1.25    // instant surge on activation, so the press has a feel
```

`BOOST_ACCEL` is the constant that made boost feel like anything. Raising the *cap* alone did
nothing: at 6 u/s² a car needs 24 units to reach top speed and junctions are only 20 apart, so it
never got there before having to slow for the next one.

The other half is the corner rule:

```js
const straightOn = car.dOut === car.d;
const cruise = car.boost ? SPEED * BOOST_SPEED : SPEED;
const straightTop = car.boost ? SPEED * OVERDRIVE_SPEED : cruise;
const boostTurn = car.boost ? (isRight ? cruise * 0.75 : cruise) : CORNER_SPEED;
const cornerTarget = straightOn ? straightTop : boostTurn;
```

A boosting taxi doesn't lift for straights or left turns — without that it braked at every junction
and the whole mode read as choppy rather than fast. Right turns are the one exception: with
right-hand traffic they cut the near corner instead of sweeping the far diagonal, so at full boost
the arc is over in ~0.35s against a left's ~0.7s and reads as *sped up*. 0.75× cruise gives the
tight arc its weight back. It is the only deliberate speed drop left in the mode, and it accounts
for ~9% of boosted frames.

### Overdrive: only on a straightaway

```js
OVERDRIVE_SPEED = 2.7   // multiplier on top speed — 22.95 u/s, 67mph
OVERDRIVE_ACCEL = 2.2   // units/s² through the band — 40 units of straight to use it all
```

The mode's ceiling is 22.95 u/s, but holding the button is not what buys it. `BOOST_ACCEL` runs out
at `SPEED · BOOST_SPEED` = 18.7, and the last 4.25 u/s arrive at `OVERDRIVE_ACCEL` instead:

```js
const boostAccel = (v) => (v < SPEED * BOOST_SPEED ? BOOST_ACCEL : OVERDRIVE_ACCEL);
```

`(22.95² − 18.7²) / (2 · 2.2)` is **40 units of unbroken straight road** — two blocks on the nose,
`PITCH` being 20. So the top end sits at the far end of a straightaway and nothing else reaches it:
a leader inside `LOOKAHEAD`, a red the mode isn't holding, or a corner all cost it, and a corner
costs it outright — the turn branch clamps a real turn to `cruise` and `BRAKE` is 11, so a left
sheds the whole band in 0.4s.

Going straight on through a junction *keeps* it, and has to. 40 units of run-up crosses one
junction and starts on a second, so capping the straight-through at `BOOST_SPEED` — which is what
the corner rule did before `straightTop` — would have made the band unreachable rather than merely
hard to reach.

This is the deliberate inverse of the note above about `BOOST_ACCEL`: punch comes from the
acceleration, so a band that is supposed to be earned gets its acceleration taken away rather than
its ceiling capped. The two halves are measured separately in `tools/probe.mjs` — the mode's own
18.7 is back within 0.3 units of a corner exit, and the top end has never been seen inside 28 units
of straight road.

2.7 rather than something rounder because [the bust chase](#the-bust-chase) runs at 26 and has to
stay faster than the quarry on its best day; 22.95 leaves the cruiser 3 u/s to close with.

**It stays in its lane and weaves inside it.** The first version slid a full `LANE` out onto the
road centreline to overtake, and that is what made the mode a lottery: on the centreline the taxi
sits 2 units from a same-direction leader and 2 from oncoming traffic, while the collision envelope
in `sim/collisions.js` is 2.31 wide — so *every* car it drew level with was a crash, whichever way
that car was pointing. It now holds its lane centre and weaves within it, from two sine waves of
different wavelength summed to a 0.52-unit peak (`SWERVE_AMP` 0.40 over 18 units, `SWERVE_AMP2`
0.12 over 9.5, periods that don't divide so the weave never lands on a beat). The lane centre has
about 1.1 units of play either side once half a car body is off, so the weave uses half of it.

Both the wave's argument and the envelope that fades it in with the boost are paced by **distance
travelled**, and neither advances outside the `drive` state. That is the same lesson the centreline
ramp learned twice: a time-paced offset slid the car sideways while it sat still at a red, and a
ramp running through a corner pushed it off its own Bézier partway round. Freezing the phase
mid-turn also means a corner ends on the offset it began on, with no jump back onto the wave.

Yaw follows the offset's slope. Because the offset is a function of distance rather than time, that
slope *is* the tangent of the steering angle at any speed — no dividing by `v` — and it peaks at
about 12°, against the 13° the old lane change held. Without it the car crabs, which is what
actually looked broken about the old overtake.

Holding the lane means the taxi has to **see the car ahead**, which the centreline version could
ignore. It tailgates at `BOOST_GAP = MIN_GAP × 0.85` = 4.5 units instead of queueing at the ambient
distance: close enough to read as impatient, still 0.29 clear of the collision envelope, and it
takes the gap the moment the leader turns off. It is also back in the lane bookkeeping it used to
be skipped in — which matters in both directions, because traffic behind it now sees it brake.
An ambient car rear-ending the taxi used to end the run through no fault of the player.

Measured over 18 minutes of continuous boosting: **one crash every 25.1s, against one every 9.7s**
on the centreline, with mean speed unchanged (17.5 u/s against a 18.7 cap). `tools/probe.mjs`
asserts both halves of it — the taxi never gets more than 0.6 units off its lane centre, and the
weave never goes flat.

A boosting taxi also sets `priorityJunction`, which forces its next junction green — that's the
"runs red lights" part, expressed through the signal model rather than by skipping the check. Ring
junctions are covered too: the ring/cross branches check `priorityCovers` and route the boosting
taxi through `canProceed`, so joining ring traffic yields to the taxi's axis exactly the way a
siren's corridor yields it.

`priorityJunction.block` names one further direction denied at that junction despite its axis
reading green. It is only ever the direction *opposite* the taxi, and only while the taxi's route
calls for a left turn — see [What was still braking it](#what-was-still-braking-it).

### What was still braking it

Loco Mode is meant to be go-go-go, and it wasn't. Attributing every frame the boosting taxi spent
below its 18.7 u/s cap, over 12 minutes per density (measured before the overdrive band existed, so
18.7 is the cap in question here — the limiters are the same either way, they just now also cost
the band on top):

| what was limiting it | ?cars=12 | 24 | 40 |
|---|---|---|---|
| signals | 0.0% | 0.0% | 0.0% |
| queued behind the car in front | 9.2% | 15.0% | 25.2% |
| stopped at the line | 2.8% | 4.9% | 11.0% |
| ...of which: exit lane full (don't-block-the-box) | 2.7% | 4.1% | 9.7% |
| ...of which: left turn yielding to oncoming | 0.1% | 0.7% | 0.8% |

The signal work was already done — **none** of it was lights. All of it was ordinary traffic, and
the taxi cannot go round: the lane is 4 wide against a 2.31-unit collision envelope, which is the
whole reason the centreline overtake was abandoned. So the traffic moves instead.

**Scatter.** A car with the boosting taxi behind it in its own lane — or sitting on the exit point
the taxi is about to land on — floors it (`SCATTER_SPEED` = 2.0× cruise, kept just under the taxi's
2.2 so the taxi still closes and the flee reads as *not quite enough*) and all but stops rolling
"carry straight on" when it reaches the next junction. Speed buys the second it takes to get there;
turning off is what actually clears the lane. It eases in over ~0.1s and out over ~0.8s, so a car
doesn't visibly deflate the instant the taxi turns away.

**Don't-block-the-box, priced in time.** The 1.5× following-distance margin on the exit lane exists
because the lane can back up during the second or so a turn takes. A boosting taxi crosses in
0.35–0.7s, so it is charged the plain `MIN_GAP` instead. Mid-junction stalls went *down*, not up
(2.6% → 1.0% of boosted frames at `?cars=40`), because scatter clears the exit lane anyway.

**Left turns.** Oncoming traffic shares the taxi's axis, so the priority hold left it green and the
left-turn yield then refused to let the taxi go — waiting on a car that was itself waiting. Hence
`block`: the oncoming lane holds at its own line for the beat it takes to cross, and the taxi only
checks for something already inside the junction.

Net, per density: dead stops at the line **2.8/4.9/11.0% → 1.1/1.7/4.2%**, time queued behind a
leader **9.2/15.0/25.2% → 5.1/9.0/16.7%**, mean speed **95/92/89% → 96/94/92%** of the cap. Crash
rate fell too — 13.3s → 15.7s between impacts at `?cars=12` — because the cars in front move away
rather than being run into.

Aggregate speed is *not* asserted in `tools/probe.mjs`. It was tried and thrown out: changing the
turn weights reroutes the whole city's rng stream, so a before/after pair is two different worlds,
and the seed-to-seed spread (73%–96% across eight cities) swamps a two-point effect. What the probe
checks instead is the mechanism — that traffic in front of a boosting taxi exceeds ambient cruise,
and that a boosting taxi takes its left turn while the oncoming car holds.

**The lamps don't show the hold.** Stop bars are coloured from `displayPhase`, which is
`lightPhase` with the priority branch skipped, so the heads keep running their real cycle while the
taxi barges through. Wired to `lightPhase` they flipped green a beat before the taxi arrived, and
Loco Mode read as the city politely opening up rather than as running every red in the grid — the
opposite of the point. The yielding still happens, it just happens *underneath*: cross traffic
balking under a green of its own reads as drivers getting out of a maniac's way. The police
corridor is deliberately not excepted — emergency preemption really does turn the lights, and
watching the green path open ahead of the siren is the whole effect.

The meter itself lives in `game/boost.js` as a pure clock with no knowledge of the taxi or the
DOM. Hold-to-enable: the tank drains only while the button is held (15s from full) and releasing
just pauses it. Nothing refills it but a drop-off — see
[gameplay.md](gameplay.md#crazy-taxi-mode) for the economy.

**Releasing doesn't switch it off.** It used to — the taxi went from full boost to ordinary traffic
in the same frame, so tapping off a beat before a crash or a cop was a free escape. `game/boost.js`
now holds the mode at `'cooldown'` for `BOOST_COOLDOWN` (1s) after release before it lands on
`'ready'` (or `'empty'`, if the tank ran dry rather than being released on purpose — both exits
from `'active'` get the same tail). `isEngaged()` covers `'active'` and `'cooldown'` both, and
is what `taxi.boost` is driven from — collision detection, the police bust range and the priority
junction that lets Loco Mode run reds all read `taxi.boost`, so all three stay armed through the
cooldown. What *doesn't* survive it is speed: `taxi.boostEasing` is true only during `'cooldown'`,
and `fullPower = car.boost && !car.boostEasing` in `traffic.js` is what the topSpeed/accel formulas
actually key off, so the cap drops back to cruise the instant the hold ends. The car doesn't snap
to cruise, though — `BRAKE` (11 u/s²) is still the only thing that sheds speed, same as any other
stop, and from 18.7 down to 8.5 that takes ~0.93s: the coast-down was already sitting there once
the speed cap and the hazard flag stopped being the same boolean. It's also where the nose-dip
comes from — the pitch spring downstream reads the deceleration straight off `car.v`, no separate
animation needed. A re-press mid-cooldown cancels it outright and returns to `'active'`.

### Seeing what you're about to hit

Because collision detection is armed only while boosting, the one moment a car hidden behind a
tower is a crash rather than a surprise is the one moment the player can't see it. The nearest
handful of ambient cars therefore wear the taxi's own occluded-only outline while Loco Mode is up,
each in its own paint — see [nearby-traffic ghost outlines](rendering.md#nearby-traffic-ghost-outlines--gamecarghostsjs).
It fades in and out with the boost rather than being always on, and follows `taxi.boost` rather
than the speed cap, so like every other hazard rule it stays up through the cooldown tail.

## The wreck

`sim/collisions.js` detects the impact, `main.js` stages it, `game/vanish.js` clears the bodywork
away.

**Both cars are destroyed.** The one the taxi hits used to be *stunned*: kicked sideways under a
little drift-physics packet, spun out, then snapped back onto the lane grid and driven off. Two
cars meet at a combined ~30 u/s, one is scrap and the other shakes it off — the survivor made the
player's own wreck look like a rule firing rather than a crash. Both are now marked `crashed`,
which is the flag every loop in `traffic.js` already skipped for the taxi: out of the lane
bookkeeping, out of the physics, out of the render pass, permanently. The stun path is gone with
it, and so is `recoverFromStun`.

**Each car detonates where it stands.** Sparks, a fireball, a smoke plume and a shower of debris at
the impact point, and the same set again at the other car's centre. The two are only a couple of
units apart, but that is enough to spread the blast across both bodies instead of stacking it on
the seam between them. A debris pool re-shoots its own pieces on every call, so the two cars get
**a pool each** — one shared pool would snap the taxi's wreckage across to the other car's the
instant the second burst fired. The victim's pool is repainted at burst time in that car's colour
(glass, rubber and the cabin lid keep theirs), so what lands on the road is visibly two cars.

**The shells shrink and fade into the fireballs** rather than being hidden. The old version cut:
`taxiGroup.visible = false` fired on the impact frame, one frame before the fireball had grown
large enough to hide anything, so the eye read a car blinking out and then, separately, a bang.
`vanish.take()` collapses each shell over 0.34s of sim time instead — stepped with the frame's
already-slowed `dt`, so it stretches to nearly two seconds on screen under the crash slow-mo,
which is exactly how long the fireball is at its biggest. The fade leads the collapse (halfway
through: three-quarters size, a quarter opaque), because matching the two curves left a small,
solid, brightly lit nugget riding the middle of the fireball to the last frame.

The taxi has its own group to fade, steered wheels and all. An ambient car is spread across two
`InstancedMesh`es — the body, plus one instance per steered front wheel — and neither has anywhere
to put a per-instance opacity, since `instanceColor` is RGB only. So `wreckShell()` copies the car
out into a standalone group (body plus both wheels at the lock the impact caught them at) sharing
one tinted, fadeable material, and collapses **every** instance behind it to zero scale. Collapsing
only the body would leave two wheels parked on the road; `tools/probe.mjs` asserts all three. This
is cheaper than the alternative — a custom alpha attribute plus an `onBeforeCompile` patch on the
traffic material — for something that happens once per run.

## Police priority corridor

`src/sim/police.js`. A police car crosses the city on a cycle, holding every signal on its road
green and every crossing road red. The override lives inside `lightPhase` — `canProceed` is the
single place any car asks "may I enter?", so the whole city reacts correctly without car logic
being touched at all.

It drives its **lane** — right-hand traffic, one `LANE` off the road centreline — at `SPEED = 19`
(about twice traffic). It skips the lane-following and collision machinery entirely, so it never
queues behind anyone; the priority corridor holds every downstream light green, so same-direction
cars in the lane are already launching or moving by the time the cruiser arrives behind them.
A red/blue point light rides with it.

The soak test caught the cost of this immediately: a taxi held at a corridor loses time through no
fault of the player. This doc claimed for a long while that the fare deadline carried a
`DISRUPTION_ALLOWANCE` to cover it — **it never did**, and no such constant has ever existed in the
source. What covers it now is the slack multiplier on every budgeted clock
([difficulty.md](difficulty.md#the-clock-is-budgeted)), which pays for whatever the drive actually
runs into, corridors included. That matters more than it used to: the corridor comes round about
twice as often at the top of the ramp as at the bottom.

This is also why the player can **tailgate**: following the police car through town is a legitimate
way to cross the map quickly.

It **fades in and out** at the ends of its run (`FADE_BAND = 18`), reaching fully invisible by
`|s| = 68` — well before the turnaround at 76, so the hard `visible = false` always lands on an
already-transparent car. The point lights fade with the bodywork, since leaving them lit would keep
washing red and blue across the tarmac from a car that is no longer there. The fade keys off `|s|`,
so it covers entry as well as exit; the pop existed at both ends.

`propMaterial()` returns a fresh instance per call, which is what makes this safe — turning on
transparency here affects the police car alone and not the merged prop meshes.

> Once fixed: the police car drove straight through a park. It now respects closed segments.

## The bust chase

Boost within `POLICE_BUST_RANGE` (20 — one block) of a live corridor run and the run is over:
`bustByPolice()` in `main.js` freezes the taxi, drops into slow-mo and holds the Game Over banner,
same beat as a wreck. What it adds is `police.chase(taxi)`.

**Why it exists.** The corridor run is scenery — it drives its line and never acknowledges the
player. So the bust used to land with the cruiser sailing obliviously past, and being busted read
as a rule firing somewhere off-screen rather than as a cop catching you. The chase makes the car
break off, come about, and pull up alongside.

**It drives the taxi's Loco Mode.** Same weave, shared out of `traffic.js` as `locoWeave()` so
there is one definition of it: the offset is a function of distance driven, so its slope *is* the
tangent of the steering angle. On top of that, `CHASE_SPEED = 26` (the boosting taxi tops out at
18.7, so the gap actually closes), a `CHASE_KICK` step in speed the frame it decides — the
cruiser's `BOOST_KICK` — and a hard **U-turn** if the taxi is behind it: a left-hand swing across
the full width of the road, braking in at `UTURN_BRAKE` and powering out, which is the beat that
sells the lock-on. The light bar goes double-time, 11 changes a second instead of 6, and that rate
change is the only cue the player gets that the run has become about them.

**Half of "aggressive" is the body, not the routing.** A car that tracks a perfect line at a
constant speed reads as a machine however fast it is going. So the cruiser carries itself the way
the boosting taxi does, off the same shapes:

- **Pitch** is the taxi's spring-damper on longitudinal acceleration, same constants. The kick, the
  dive into the U-turn and the stand-on-the-brakes arrival all arrive as Δv and come out as the
  body rocking, ending each event on a small bounce because it is underdamped.
- **A kickoff wheelie** on lock-on, `locoWheelie()` shared with the taxi.
- **Roll** leans *outward* — weight transfer; leaning inward reads as a motorbike. It comes off yaw
  rate × speed rather than off the geometry of a turn, since this car has no Bézier to ask. Going
  through the motion means the weave leans it as well as the corners do, in proportion, for free.
- **Rubber and dust**, laid from `main.js` where the effect pools live, off the yaw rate and
  distance `police.js` publishes. The slide threshold sits above the weave and below a corner
  (`POLICE_SLIDE_RATE`); below that gap the cruiser laid a continuous streak down every straight,
  which reads as permanently out of control rather than as being thrown about.

Both tilts pivot on the car's origin at road level, so each one alone drives an edge under the
tarmac; the same sagitta lift the ambient cars use keeps the low corner on the road. The body keeps
ticking after it parks, so the dive it stops on settles back to level instead of freezing nose-down.

**Routing** is greedy Manhattan, decided one junction at a time and scored on where each road
*goes* — the distance from the far end of the segment to the taxi — rather than on which way the
bonnet ends up pointing. Exits come from `legalExits`, so park closures and the map edge are
handled for free. Straight carries a small bonus, without which two equal-cost exits alternate at
every junction and the chase visibly dithers down a road it should just be driving down.

The priority corridor follows each leg. That is not a courtesy: the cruiser has no collision or
queueing coupling at all, so an un-yielded cross car is a car it drives through at 26 units/s.

**The rail is not what you see.** Position and heading come off an exact (axis, line, s) rail whose
corners are square and whose U-turn flips a whole road width at once. The drawn car eases toward it
(`CHASE_SMOOTH`), which is what turns each 90° snap into an arc — the steady-state lag of ~2.2
units *is* the corner radius. Two bounds on top, both of which were visible before they were added:
the ease is capped at `CHASE_SPEED * 1.2` (the corner snap otherwise spiked the car to 50 units/s
for a frame, and the apex of every corner read as a skip), and the nose eases toward the rail
heading over `YAW_EASE` rather than snapping the full 90°.

> Once fixed: heading was read off the smoothed motion instead of the rail. The frame after a
> corner snap the rail can sit *behind* the drawn car, so the step pointed back down the road and
> the nose flicked through 160° in one frame.

**Its front wheels steer too**, on the same `steerToward()` every car in `traffic.js` runs — the
cruiser is not in the `cars` array (no lane, no turn state, no collision coupling), so that
function is the only thing the two can share, and sharing it is what keeps the cruiser's wheels
from drifting out of step the next time the gain is touched. The difference is taken over the
**drawn** position and heading rather than the rail's, because the arc the player sees is the eased
one. Measured across five seeds:

| | p50 | max |
|---|---|---|
| corridor run | 0° | 0° |
| chase | 5.2° | 34° (on the clamp) |
| U-turn | 25.8° | 33° |
| parked after the arrest | 2.8° | 3.3° |

The corridor run is a flat zero because it is a straight rail — which is exactly why the cruiser
had no business having steered wheels before the chase existed. It also means the assertion that
matters is the chase one: a corridor-only check would pass an implementation that never turned
them at all.

**The banner waits for the arrest.** `BUST_BANNER_DELAY` is a floor, not the schedule — the retry
screen holds until the cruiser stops, plus a beat. A park district can close the one road between
the two cars and leave the only legal route three sides of a block long (68 units, 3.5s on seed
8888), and cutting away mid-chase throws out the one beat the feature exists for.
`BUST_BANNER_MAX` caps the wait. The bust also runs a much shallower slow-mo than a wreck
(`BUST_SLOW_MO_MIN = 0.42` against 0.18): at wreck depth the chase waded through treacle, which is
the opposite of "it came after you".

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

The roll itself now happens a second **before** the line rather than on it, in `intentFor` — the
car has to know which way it is going in order to indicate it (see [Indicators](#indicators)). The
branch is unchanged: the commit at the line reads that intent back, and where it cannot use it (a
lane closed since, a siren, a car fleeing the boosting taxi, a turn refused by the yield or
don't-block-the-box tests) it drops it and rolls again under the conditions that actually hold.

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

One road per axis takes a **64% green share** where it meets a side street, giving the map a
fast/slow grain. `layout.js` picks them and hands them to the network's bake.

They are also **a third wider than a side street, and divided** — 10.67 kerb to kerb against 8,
with the whole of the extra width going into the middle as a median. See
[city.md](city.md#divided-arterials-and-the-planted-median) for the geometry and why it is measured
from the kerb rather than from the centreline; the two things it changes in here are the junction
box and the overtake.

The junction box is the **crossing** road's half-width, not this road's. A side street meeting an
arterial holds its cars 5.33 back instead of 4, while the arterial enters that same junction no
earlier than it used to — which is what a wide road crossing a narrow one actually looks like, and
falls out of `junctionReach` in grid.js and the per-arm radius in roadnet.js without either side
knowing about the other.

### A signal-free ring road

The outermost roads carry no lights **anywhere, corners included**. Traffic joining from inside
yields into a gap (`RING_YIELD = 24` units of clear road).

"Unsignalised" is now `node.signal === null` rather than `ringAxisAt(i, j)`, and the difference is
not cosmetic. A junction the ring never touches can still end up with nothing to arbitrate — a
closure can leave an interior junction with only a straight-through — and the grid, deciding from
`(i, j)` alone, kept cycling a light there and held cars for a phase nobody could be in. Rare: one
junction in 40 seeds. It has no stop bars now, because there is nothing to stop for.

> Watch out: `phaseAt` returns **null** for an unsignalised node, where `lightPhase` returned an
> axis with `remaining: Infinity`. Any port that swaps one for the other while keeping `ringAxisAt`
> as the unsignalised test dereferences null at exactly those junctions — the grid says signalised,
> the network says no signal. The two have to move together.

#### The corners, and why they are not a special case

The four corners used to be the ring's exception: lights, stop bars and crosswalks, on the grounds
that "the ring meets itself and there is no single street to favour". That reasoning asked the
wrong question. A corner has **two arms**, meeting at a right angle, so every car through one is
turning — but the movement off one arm is a right and the movement off the other is a left, they
land in different lanes, and under right-hand traffic they sweep opposite sides of the bend without
ever crossing. `buildConflicts` says so directly: both turns come back with an empty `conflicts`.

So `bakeSignals` drops the signal wherever **no two movements conflict**, which subsumes the old
`streets.length <= 1` test (a straight-through conflicts with nothing either) and catches the
corners for the honest reason rather than by naming them. A closure that bends an interior junction
the same way gets the same treatment for free.

Dropping the light is only half of it. Those nodes are also marked **`uncontrolled`**, and
`laneSignal` reports every approach `open`. Without that they would fall to the ordinary
unsignalised rule — one priority street, everyone else yielding into a 24-unit gap — which on a
ring carrying continuous traffic means cars stopping at a bend for traffic that is turning *away*
from them. Nothing conflicts, so nobody yields.

The visible half is the paint: no stop bars (they follow `node.signal`) and no crosswalks (they
follow `isUnsignalised` in `grid.js`, which now covers the corners via `isRingCorner`).

Measured over a 300s run of 24 cars: throughput **7.19 → 7.61** units/s per car, time stationary
**15% → 10%** (`tools/signals.mjs`). The corner lights were holding ring traffic for cross traffic
that does not exist.

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
3. `node.signal === null` — the ring, its corners, or anything with nothing to arbitrate
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
leader stops mattering once that exceeds the car's top speed: at the overdrive top (34 u/s) against
`BRAKE` 17.5 that is 33.0 units of clear road, plus `BOOST_GAP`, so 37.5. Beyond that the leader
cannot affect the physics whether or not the bookkeeping can see it. 40 leaves margin and is
exactly two lanes plus the two junctions around them (12 + 8 + 12 + 8).

It has now been re-derived twice, and the history is the point: 26 against the 18.7 ceiling, 32 when
the overdrive band made the top 22.95, and 40 now the top is 34. **Anything that raises the ceiling
or softens the brake has to come back here** — including a session with the ⚙️ panel. The
[overdrive band](#overdrive-only-on-a-straightaway) moved the ceiling and the horizon had to move
with it — 26 is 2.4 units short of a taxi in overdrive's own stopping distance, and a leader that
appears inside that is a rear-end rather than a lift. Ambient traffic never noticed either number:
at cruise a leader stops constraining beyond 3.3 units of clear road.

The same walk drives the Loco Mode scatter, which reaches `SCATTER_RANGE = 40` — two blocks.

### A moving leader is not a wall

`sqrt(2 · BRAKE · room)` is the speed you can still *stop* from inside `room`. Against a car that is
itself driving away that is the wrong question — it prices in braking to a standstill for something
that will not be there — and it was the single biggest thing wrong with how Loco Mode felt.

Two symptoms, one cause. The taxi is documented as tailgating at `BOOST_GAP` (4.5 units) and it did
not: behind a car fleeing at `SCATTER_SPEED` the stopping rule settles it **17.6 units** back, which
is outside `PASS_TRIGGER`, so on an open road the overtake was never offered at all — measured over
12 minutes of routed boosting in the city, **zero** passes. And because the cap moves with the gap
while the mid-junction branch had no cap at all, the taxi spent every lane braking and every
junction accelerating: a sawtooth with a period of one block, which is what "it stutters on the
approach" looks like from outside the code.

The rule is now the leader's own speed plus what can be shed over the clear road between them — you
may out-run the car in front by exactly as much as you can give back before you reach it. A
*stopped* leader has `v = 0` and it collapses to the old expression exactly, so queueing at a red,
which everything else here is tuned around, is untouched.

**A speed cap and nothing else.** Following and stopping are now separate quantities: `allowed` is
the positional budget and only stationary things contribute to the speed it is turned into. The
leader used to clamp both, and that is where a freeze lived — a taxi abandoning a pass while still
alongside found zero room against a leader doing 16 u/s, and a budget of zero means `car.v = 0`
outright: **20.9 u/s to a standstill in one frame**, out in the oncoming lane. The snap-to-line rule
that did it is about arriving at a *line*, and it is keyed on the stationary distance now.

### The car in front stutters too

The mid-turn branch computed its cruise ceiling from a bare `SPEED`, so a car fleeing the boosting
taxi at 2.0× cruise dropped to a flat 8.5 the moment it entered a junction and spent the next lane
climbing back — a 17 ↔ 8.5 sawtooth of its own, with every car behind it braking in time. Both
branches read `cruiseCapFor` now, which is the same expression written once.

### Following distance *inside* a junction

The mid-turn branch had none at all, and for ambient traffic that never showed: a car crosses at
cruise and its target while crossing *is* cruise, so it cannot gain on anyone in there. A boosting
taxi can. It enters a junction slow — because it has been tailgating at `BOOST_GAP` on the approach
— and then floors it to the overdrive top across the 8 units of junction with the brake simply
absent, closing three units on a car it can see the whole way.

Staged on [the lab](lab.md)'s straight road, that was **43 of 160** approaches ending as a rear-end
at a dead stop with `pass` still 0.00: the taxi never got as far as pulling out, because it hit the
car during the crossing before the straight it would have passed on began. It is visible in
`tools/probe.mjs`'s own overtake scenario too, where the taxi drives clean through its leader —
that scenario just never ran collisions.

**The cap is deliberately not the drive branch's stopping-distance curve.** That was tried first and
it fixes the crash by destroying the mode: against a leader fleeing at `SCATTER_SPEED` the stopping
curve settles the taxi 12–17 units back, it never reaches `PASS_TRIGGER` (10), and the overtake
stops being offered at all — the same 160 approaches went from 117 passes to **4**. The rule that
works is the narrower true one: *inside the range where the pass has already been offered and
refused, match the leader rather than accelerate past it*. Floored at the leader's own speed, so it
stays a speed target and never becomes a hold — the taxi still never stops inside a junction, which
is what [`bargesThrough`](#nothing-stops-the-taxi) exists to guarantee.

What it costs, measured over eight cities with the button held down for a whole run:

| | before | after |
|---|---|---|
| wreck every, `?cars=22` | 7.9s | 8.0s |
| wreck every, `?cars=12` | 10.5s | **11.7s** |
| ground covered, `?cars=22` | 18.33 u/s | 18.07 |
| ground covered, `?cars=12` | 18.97 u/s | 18.38 |
| near-stationary frames | 0.50% | **0.37%** |

About 1.5–3% of ground speed, for not driving into the back of the car in front. The sample is
small — eight cities, each ending at its first wreck — so read the direction rather than the
decimals.

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
BRAKE  = 17.5   // units/s² stopping; ~2.1 units from cruise to standstill
HARD_BRAKE = 35 // the player's brake pedal — twice that, and the taxi's alone
CORNER_SPEED = SPEED * 0.7
```

### The brake pedal

`car.braking` is the one input in the sim that can bring the taxi to a dead stop wherever it
happens to be. Held from the bottom of [the throttle](gameplay.md#the-throttle) (or **B**), written onto the car by `main.js` each
frame the same way `boost` is — `sim/` may not import from `game/`, so both flags are pushed rather
than pulled.

It is deliberately blunt. Everywhere the drive branch and the turn branch compute a speed target,
`braking` replaces it with **zero** and swaps `brake()` for `hardBrake()`:

```js
const desired = car.braking ? 0 : Math.min(topSpeed, leadCap, sqrt(2 · brake() · stopRoom));
car.v = desired > car.v ? … : max(desired, car.v − (car.braking ? hardBrake() : brake()) · dt);
```

That single substitution is the whole feature, and it is what makes the pedal outrank everything
else the taxi could be doing — including Loco Mode, whose ceiling is one of the terms it replaces.
With a target of zero the accelerate branch can never fire, so a braking taxi cannot pull away from
a green, out of a queue, or into an overtake while the pedal is down. Letting go restores the
ordinary target on the next frame; there is nothing to re-arm, which is why "release" and "the taxi
drives itself again" are the same statement.

`hardBrake()` is `max(HARD_BRAKE, brake())` rather than the constant, because `brake()` is a live
knob on the ⚙️ panel and a *hard* brake that stops the car slower than lifting off is not a brake.
At 35 u/s² the stop is 1.0 units from cruise, 7.0 from the boost top and **16.5 from the overdrive
top** — that last one is the number the feel was picked on: about a second of screech and two car
lengths of rubber from flat out.

**It works inside a junction, and that needed one more line.** A pedal that only applied on a lane
would ignore the player for the ~0.9s a crossing takes, which is exactly when the brake is most
likely to be wanted. But a car stopped in the box is a hazard: cross traffic released into a
junction drives *through* whatever is standing in it. That case already existed for an ambient car
stranded mid-turn, and the `heldAt` set is what protects it — so a braking taxi joins that set at
any `turnT`, not just the ≥ 0.95 an out-of-arc car reaches. Keyed on the pedal rather than on
`v === 0` so the hold is in place while the taxi is still sliding to its stop, since the traffic it
is being protected from brakes on approach. Without it, the probe measures a crossing car spending
81 frames driving through a stopped taxi.

The brake is not `parked`. `parked` is a hold at the kerb the sim eases into off a positional
budget of zero; this overrides the budget outright, and is the only input that can stop the taxi
mid-junction.

Everything the brake *looks* like falls out of the physics for free: the nose-dive is the pitch
spring reading deceleration off `car.v`, and the brake lights come on because `accel < −BRAKE_ACCEL`
— `BRAKE_ACCEL` (1.5) is well under either braking constant, so they light on the first frame of
the hold and stay lit through the stop (`BRAKE_STOP_V`). What `main.js` adds is the rubber —
[four wheels, not two](gameplay.md#the-throttle).

**Stop line setback.** `STOP_SETBACK = 3.4`. Cars used to hold with their *centre* on the junction
boundary, putting the nose 1.7 units inside and squarely across the crosswalk. The outer crosswalk
bar sits 5.65 from the junction centre, so the centre has to hold at ~7.35 for the nose to clear.

> Watch out: this setback once caused cars to drive off the map to x = −1064. A car spawning
> within 3.4 units of its target starts *past* the hold line, and a `distToLine > 0` guard meant
> the stop decision never fired. There is no guard now — don't reintroduce one.

**Right on red** is allowed with `RIGHT_ON_RED_YIELD = 15` units of clearance — shorter than the
ring's, because a right turn merges into the near lane rather than crossing it. The landing is
still governed by the usual don't-block-the-box check. **A car indicating left does not take it**:
the free right used to go to whoever was at the front of the queue, which is fine as flow and wrong
as driving now that the lamp runs a second early — a car that had been showing left swung right
instead, 39 times in two minutes of a 24-car city. Only the left-handed ones are refused; a car
whose dice rolled straight still takes the free right, unindicated. Gating it on the whole intent
was measured and not taken — it suppresses two thirds of the city's right-on-reds and costs a fare
in ten over a 40-run soak (mean 9.7 against 11.1), which a lamp is not worth.

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

### Indicators

`SIGNAL_LEAD = 7` units before the hold line, `SIGNAL_LINGER = 0.7` seconds after the car lands,
blinking at `TURN_SIGNAL_HZ = 1.1` on a `TURN_SIGNAL_DUTY = 0.6` duty cycle (skewed toward "on"
because at this size an even square wave reads as a broken lamp rather than a blinking one).

Both ends used to be pinned to `state === 'turn'`, which is the arc plus its `STOP_SETBACK` run-up:
the lamp lit 0.4s before the junction and went out on the frame the car landed in the exit lane,
so it read as a car flashing *because* it was cornering rather than to say it was about to. The
warning is now `SIGNAL_LEAD + STOP_SETBACK` = 10.4 units, ~1.2s at cruise and over a full blink
cycle before the wheel moves at all — and longer than that for a car queued at a red, which
indicates for as long as it waits.

The lane is the real cap on the lead: an ordinary street's is 12 units end to end, so a car
indicates over most of the block it is leaving and never over one it hasn't reached its decision
for. The blink clock is per-signal rather than global, so every window opens **lit** — over a
window this short, coming on dark costs the first flash — and it desyncs a queue as well as the
old global-clock-plus-`car.phase` did, since no two cars reach their decision on the same frame.

Buying the lead is what moved the dice roll off the hold line (see [The one routing
branch](#the-one-routing-branch)), and that is the part with teeth: a decision that can still be
overruled at the line is a lamp that can end up pointing the wrong way. `tools/probe.mjs` measures
it over two minutes of a 24-car city — ~560 real turns, of which 481 begin under the lamp for the
hand actually taken, 80 under no lamp at all (the free right at a red, taken by a car whose dice
had rolled straight) and **none** under the wrong one.

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

### None of the vehicle meshes frustum-cull

All five — `mesh`, `wheelMesh`, `truckMesh`, `truckWheelMesh`, `truckBoxMesh` — set
`frustumCulled = false`, through `neverCull()` in `createTraffic`. Three computes an
`InstancedMesh`'s bounding sphere **once**, lazily, on the first frame the renderer culls it, from
whatever the instance matrices held at that moment, and never refreshes it. These meshes then drive
off across the city underneath it, and get culled against where they *were*.

The cars got away with it — 11 of them spread over the map on frame one give a sphere the size of
the city, which every frustum intersects. **The trucks are where it showed**, and it shipped:

- 27% of runs open with no truck at all (11 ambient vehicles at `TRUCK_CHANCE`), so the sphere is
  computed off `count = 0` and comes back **empty** — radius −1, pinned to the world origin. Every
  truck for the rest of that run draws only while the middle of the map is in frame.
- A run that opens with one truck latches a 3.1-unit bubble around wherever it stood at warmup and
  loses it as soon as it drives out. Measured on a portrait phone, where the camera follows the taxi
  rather than framing the whole city: a truck plainly on screen went undrawn in **27%** of sampled
  frames.
- The cab and the box are separate meshes with separate spheres — the box's is smaller and set back
  — so the box can fail the test on a frame the cab passes. That is what got reported: a cab and its
  wheels driving down the street with no cargo box on the back.
- The shadow pass culls against the *sun's* frustum, which covers the whole city, so a stale sphere
  still inside the city keeps the shadow drawing at the instances' real positions — an invisible
  truck towing a truck-shaped shadow. The AO prepass uses the play camera, so the occlusion
  disappears with the truck.

Turning culling off costs nothing here: the scene is about ten draw calls, and a mesh holding every
vehicle in the city is one the frustum test would pass anyway. `game/carghosts.js` already did this,
for the same reason; the traffic meshes were the ones that never got it.
`tools/probe.mjs` asserts both the flag and the symptom — one truck, warmed up, driven for a minute
under a phone-shaped follow camera, checked against `WebGLRenderer.projectObject`'s own rule.

### Box trucks

A rare ambient variant — `TRUCK_CHANCE` (1/12) of a spawned car, rolled once per car in
`spawnCars`. It shares an ordinary car's lane and collision envelope (`sim/collisions.js` is keyed
off `CAR_LEN`/`CAR_W` for every vehicle it tests, truck included — see "Driving feel" below for why
that stays a deliberate simplification). What it does *not* share is following distance, how it
drives, or how it moves: three separate departures, covered in the next three sections.

#### Following distance

`MIN_GAP` is car-length only, so using it unconditionally for a truck queued a follower 0.8 units
behind a truck's rear bumper instead of the 1.9 every other pairing gets — close enough to read as
clipped into the box rather than merely tight, which is what a player testing the feature actually
saw. `followGap(follower, leader)` is the pairwise fix: half of each vehicle's own length
(`CAR_LEN`/`TRUCK_LEN`, whichever `car.isTruck` says) plus the same fixed `BUMPER_GAP` (1.9) `MIN_GAP`
always implied. Every non-boost following and landing check goes through it now — the leader gap in
the main drive branch, `exitLaneFull`'s don't-block-the-box clearance, and the turn-completion
re-check — so a car settles at exactly 5.3 behind another car and 6.4 behind a truck, staged and
asserted directly in `tools/probe.mjs`.

`BOOST_GAP` (the boosting taxi's own tailgate distance in Loco Mode) is deliberately *not* run
through `followGap`. It's tuned against the taxi's own collision envelope in `sim/collisions.js`,
which stays `CAR_LEN`-sized for every target including a truck — widening the tailgate for a truck
while the hitbox that actually matters stayed car-sized would just be a taxi hanging back further
from a target it can still clip at the old range. The spawn-time clash check in `spawnCars` is
conservative instead of exact: a car's own `isTruck` isn't rolled until after it, so the check
assumes a possible truck on that side of the pairing — a no-op when `truckChance` is 0, which is
every scripted scenario in `tools/` but the one that exercises trucks on purpose.

The body is three InstancedMeshes rather than the car pair's two: `truckMesh` (chassis, cab and
windshield, from `truckCabGeometry()`) and `truckWheelMesh` alongside a third, `truckBoxMesh`
(the cargo box, from `truckBoxGeometry()`), all built at `TRUCK_LEN`/`TRUCK_W`. They have to be
separate meshes rather than one taller instance of the car body: an InstancedMesh draws one
geometry for every instance, so a visibly bigger vehicle can't share the car body's buffer no
matter how rare it is. Only the chassis is painted per-instance — it reads `PALETTE.carBody` at
the car's own `colorIndex`, exactly like an ordinary car's body, so a truck's livery varies the
way a car's does. The cab and windshield are baked at the fixed dark `carGlass` colour instead,
same as a car's own cabin glass: "make the cab black, so it looks like the cars in that sense" was
the brief, and a car's greenhouse is always dark regardless of its body colour, so the truck's cab
now reads as the same *kind* of part rather than as more chassis livery. The cargo box goes a step
further and is never instance-tinted at all — it's baked at the one fixed `PALETTE.truckBox` (a
plain tan/white) because a real box truck's box is bare aluminium or cardboard regardless of the
cab pulling it. One InstancedMesh only ever carries one tint per instance, so a part that varies,
a part that's fixed-dark and a part that's fixed-tan are three meshes by construction, not by
choice. `car.isTruck` is what routes a car to the right meshes everywhere that matters —
`writeAmbient`, `wreckShell`, the paint step.

`TRUCK_CHANCE` defaults to 0 on `spawnCars`/`createTraffic` — every scripted scenario in `tools/`
calls `createTraffic` without passing it, so none of them draw a truck and none of their staged
physics assertions have to know trucks exist. `main.js` is the one caller that opts the real game
in, passing `TRUCK_CHANCE` explicitly.

Trucks are left out of `ambient` for the same reason they are left out of the car meshes: an
`instanceIndex` only means anything alongside the array it came from, and the same index addresses
a car in `mesh` and a truck in `truckMesh`. `game/carghosts.js` reads *both* arrays for its
nearby-traffic outlines and keeps a pool per vehicle class to do it — see
[the ghost outlines](rendering.md#nearby-traffic-ghost-outlines--gamecarghostsjs). It used to read
`instanceIndex` straight into the car meshes with no type check, which is why trucks went without
an outline at all for a while: the only way to include one would have been to trace it from
whichever *car* held the same index.

**Whichever car this draw happens to pick as the taxi has its `isTruck` forced back to `false`.**
The taxi always renders through `createTaxiMesh()` regardless of the flag, so this was harmless
while `isTruck` only steered which mesh a car drew into — but once it started steering the physics
below too, a taxi that happened to win its own truck roll would have quietly cruised and rocked
like one. The taxi has to run at car physics whatever colour its unused roll came up.

#### Driving feel

A truck cruises noticeably slower than a car — `TRUCK_SPEED` is `SPEED * 0.65`. (It was `* 0.85`
at first; playtesting that build read as still too close to car speed to register as a different
kind of vehicle, so the second pass cut a real gap instead of a nudge.) `TRUCK_CORNER_SPEED` is cut
from it by the same 0.7 ratio `CORNER_SPEED` already is from `SPEED`, so a truck doesn't suddenly
out-corner a car the way a flat speed cap alone would let it. Both feed the same cruise-cap and
turn-target formulas every car already runs (`car.isTruck` just picks which `SPEED` they're
computed from), so a truck queues, brakes and takes signals exactly like a car — only slower.

**Right turns get a further cut of their own, `TRUCK_RIGHT_TURN_SPEED` (`TRUCK_CORNER_SPEED * 0.6`),
on top of the general cornering one.** Swinging a long box round a tight corner is the one turn
shape that visibly wants a beat longer than a car takes — real trucks take them wide and
cautious — where a left sweeps the far diagonal and doesn't read as hesitant at the plain corner
speed. `car.turn.hand` is what already tells every corner-lean and steering calculation left from
right (see "Turns" above), so the branch is the same test, once more. Staged in `tools/probe.mjs`
with a forced route on the identical turn: a car clears it in ~1.7s, a truck in ~3.4s.

It also rocks less on every start and stop. The pitch spring (search "Rocking" in
`traffic.js`) turns longitudinal acceleration into a nose dip/lift, underdamped so both events end
on a small bounce; for a truck, `TRUCK_PITCH_SCALE` (0.5) halves the impulse for the same Δv and
`TRUCK_PITCH_DAMPING_MULT` (1.8) damps the spring harder, so what dip there is settles instead of
rocking back through another cycle. "Feels heavier" is exactly those two numbers and nothing
else — measured over 12s of ordinary driving against a same-seed, same-count control scene of
ordinary cars, a truck's mean `|pitch|` comes out well under half a car's.

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
OVERDRIVE_SPEED = 4.0   // multiplier on top speed — 34 u/s, 99mph
OVERDRIVE_ACCEL = 4.7   // units/s² through the band — 71 units of straight to use it all
```

The mode's ceiling is 34 u/s, but holding the button is not what buys it. `BOOST_ACCEL` runs out
at `SPEED · BOOST_SPEED` = 22.1, and the last 11.9 u/s arrive at `OVERDRIVE_ACCEL` instead:

```js
const boostAccel = (v) => (v < boostCruise() ? loco.accel : loco.overdriveAccel);
```

`(34² − 22.1²) / (2 · 4.7)` is **71 units of unbroken straight road** — three and a half blocks,
`PITCH` being 20. So the top end sits at the far end of a straightaway and nothing else reaches it:
a leader inside `LOOKAHEAD`, or a red the mode isn't holding, both cost it.

**A corner no longer costs it outright, and that is a change worth knowing.** The turn branch still
clamps a real turn to `cruise` (22.1), but shedding 34 → 22.1 at `BRAKE` 17.5 takes 0.68s against a
left arc's ~0.70s and a right's ~0.35s — so a left still takes the band and a right does not. Under
the old 22.95 ceiling the drop was 4.25 u/s in 0.39s and *every* corner took it. The taxi can now
come out of a right-hander still at the top.

Going straight on through a junction *keeps* it, and has to. 71 units of run-up crosses three
junctions, so capping the straight-through at `BOOST_SPEED` — which is what the corner rule did
before `straightTop` — would have made the band unreachable rather than merely hard to reach.

This is the deliberate inverse of the note above about `BOOST_ACCEL`: punch comes from the
acceleration, so a band that is supposed to be earned gets its acceleration taken away rather than
its ceiling capped. `tools/probe.mjs` measures the two halves separately — the mode's own 22.1 is
back within a couple of units of a corner exit, and the band still costs 55+ units of climbing
between the cap and the top. That second check used to measure "distance since the last corner",
which stopped meaning anything the moment a right turn stopped resetting the speed.

4.0 rather than something rounder because [the bust chase](#the-bust-chase) has to stay faster than
the quarry on its best day; the cruiser runs at 37, which leaves it 3 u/s to close with. Those two
numbers move together — raise this one and the chase becomes an escort.

### The ramp is live tuning

The six numbers that make the ramp — `BOOST_KICK`, `BOOST_SPEED`, `BOOST_ACCEL`,
`OVERDRIVE_SPEED`, `OVERDRIVE_ACCEL` and `BRAKE` — are the defaults of a tuning object rather than
the values the physics reads directly. `LOCO_DEFAULTS` holds them, `setLocoTuning()` moves them and
`resetLocoTuning()` puts them back, and the **Loco Mode** section of the ⚙️ panel (`?debug`) is
wired to all three. The point is the driving seat: the shape of this mode is a feel, and a feel
cannot be tuned by editing a constant, rebuilding and hunting for a straightaway to test it on.
Hold the boost button, drag, feel, drag again.

Nothing is captured into a local at module load, and that is the whole discipline of the change: a
use site holding its own copy is a slider that moves, reports, redraws its preview and changes
nothing until the page is reloaded. It is also why `BOOST_CRUISE` is now `boostCruise()`. The check
that catches it is in `tools/probe.mjs` and it is the only one that can — it raises the ceiling in
the tuning and then *drives the sim*, because the tuning always reads back correctly whether or not
anything downstream is listening.

Two knobs reach further than the taxi, deliberately:

- **`brake`** is what every car in the city stops on. There is no separate taxi brake, and it owns
  the coast-down after the button is let go, which is a phase of the ramp. The panel labels it. It
  is also what `LOOKAHEAD` (32) is derived against, so a soft brake or a tall ceiling can outrun
  the horizon the following rule can see — that is where the rear-ends come from when a tuning
  session produces them.
- **`accel`** is also the top of the scatter lerp — a car fleeing the boosting taxi is pushed
  toward the taxi's own punch, because a ceiling a car cannot climb to is not a ceiling. Raising
  the punch raises the scatter with it.

The panel draws the curve above the sliders from `locoRamp()` — the same module's own integrator,
over the same tuning the physics reads, rather than a formula written out a second time in the
panel. A preview with its own copy of the maths is one that can be wrong, and it would be wrong in
the direction that matters: it would go on looking right after somebody changed the sim. `locoRamp()`
is the ideal curve on a clear straight road, which is exactly what the numbers above describe —
everything the city does to the ramp is absent from it by construction.

**Copy settings JSON** in the panel captures the tuning under `locoMode`, keyed to the constant
names above.

#### The sliders go a long way past shippable

| Lever | Range | At the top |
|---|---|---|
| Kick | 1–10× | 85 u/s the instant the button goes down |
| Boost top | 1.2–12× | 102 u/s, 298mph |
| Punch | 4–300 u/s² | |
| Overdrive | 1.2–20× | 170 u/s, 496mph |
| Band accel | 0.2–150 u/s² | |
| Brake | 3–80 u/s² | |

The question these exist to answer is *how does much faster feel*, and a slider stopping at 1.5×
the shipped value cannot answer it. The tops are where the game stops being a game, not where it
stops being tuned — 170 u/s crosses the whole 100-unit city in 0.6 seconds.

The acceleration ranges went up **with** the ceilings rather than for their own sake, and that is
the same rule as everywhere else on this page: a ceiling a car cannot climb to is not a ceiling. At
the shipped 2.2 u/s² band accel, a 20× overdrive ceiling measures **21.9 u/s** on a real drive — a
number that never appears on the road. Uncapping the speed alone buys nothing.

Two things genuinely break up there, and both are the game telling the truth rather than bugs:

- **Collisions tunnel** past ~135 u/s. One frame at 60fps then covers more than the 2.31-unit
  collision envelope, so the taxi passes through cars instead of hitting them. Measured at 510
  u/s: ten seconds of holding the button through traffic, no wreck.
- **`LOOKAHEAD` is 32 units**, so above about 26 u/s the taxi is already moving faster than it can
  see far enough ahead to brake for. That is most of what "significantly faster" feels like from
  the driving seat.
- **The boost ghosts stop being a warning.** `GHOST_RADIUS` (46) is a distance, and what it is
  worth is that distance over the boost cruise speed — 1.8s of fully-lit warning at the shipped
  22.1 u/s, 0.4s at the slider's 102. The 4-unit margin to `SPAWN_CLEARANCE` goes the same way.
  Neither is a bug in the outlines; a horizon fixed in *units* buys less time the faster you go,
  which is the honest behaviour of every horizon in the file. It is also why the radius went 42 → 46
  when the boost cap went 18.7 → 22.1: `tools/probe.mjs` holds the warning to 1.8s and caught it.

Nothing else does. Across the whole range — and past it — `car.v`, `car.x` and `car.z` stay finite
and the taxi stays on the network, because `step` is clamped to `allowed` however fast the car
thinks it is going.

**Past the end of a slider**, `window.__taxi.loco` is the same handle the panel drives:
`__taxi.loco.set({ overdriveSpeed: 60 })` is 510 u/s. `setLocoTuning` takes any finite positive
number and there is nothing to protect — a silly number makes a silly game, which is the point.

#### The tuning survives a crash

`game/locostash.js` keeps it in `localStorage`. A wreck ends the run and Retry is
`location.reload()`, which is precisely the moment a tuning session gets interrupted: you crank the
ceiling, crash *because* you cranked it, and the sliders are back to shipped. Two of those is about
as much re-dragging as anyone will do.

Written on slider **release** rather than on input — a drag fires `input` per pixel and
`setItem` is synchronous. Reset clears the stash rather than writing the defaults into it, so a
reset survives a reload as surely as a tweak does. The line under the Reset button reports what
storage actually did (`saved`, `restored from your last session`, or `not saved — storage
unavailable`) rather than promising it: Safari's private mode throws on the *write* while reporting
a healthy store, and a panel that claims a save that didn't happen is worse than one that says
nothing.

**It is only ever restored under `?debug`.** That gate lives in `main.js` and it is the whole
reason the stash is safe to have. Without the panel on screen nothing tells you the game is not the
game, so a leftover tuning would make an ordinary run silently unlike everyone else's — and put its
score on the table. Shot mode is excluded from the other end, since a screenshot has to be of the
shipped build. A load without `?debug` *ignores* the stash rather than clearing it, so the next
debug session still has it.

The restore runs before `traffic.warmup(10)`, so the ten sim-seconds of warmup drive on the same
numbers the rest of the page will.

`tools/probe.mjs` drives the stash against a fake store — the corrupt payload, the store that
throws on read, the one that throws on write. `tools/smoke.mjs` covers the half only a browser can
prove: that a stash written on one load is applied on the next, that it is *not* applied without
`?debug`, and that an ordinary load leaves it intact.

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
doesn't visibly deflate the instant the taxi turns away. **Trucks never scatter** — a 5.6-unit box
flooring it and skittering off at the next junction reads as weightless, so a truck ahead stays an
obstacle the taxi has to pass or follow.

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

### Nothing stops the taxi

The work above made the taxi stop at the line *less often*. It took a player report — "it gets
stuck at intersections", "the gas cuts out while I'm holding the button" — to notice that the
premise was wrong: in Loco Mode it should not stop at all.

The stop line has four ways to refuse a car. The signal already yielded, via the priority hold.
The other three did not: a car stranded mid-turn in the box, a full exit lane, and an oncoming car
on a left. Those are the rules for sharing a junction politely, and a car being driven like this
is not sharing it. `bargesThrough()` in `traffic.js` drops all three for a boosting taxi, and
`sim/collisions.js` is armed for exactly as long as that is true — so a junction with something in
it costs the **run**, not a wait. That is what makes the mode risky rather than merely fast: the
reason to lift off the button is that you can see what you are about to hit, not that the sim will
quietly stop you for you.

`car.boost` rather than `fullPower`, so it holds through the cooldown tail alongside every other
boost-only hazard rule — letting go doesn't buy a car that starts yielding again any more than it
buys one that stops being crashable. The mid-turn landing re-check goes with it: stopping *inside*
a junction is the one hold that would strand the taxi across live traffic, and it is landing on
that car either way.

Measured over six cities, 30 routed fares each at `?cars=24`, boost held down the whole way:

| | before | brake into the hold | **nothing stops it** |
|---|---|---|---|
| ground covered | 18.49 u/s | 17.92 | **18.71** |
| frames stationary | 3.39% | 2.42% | **0.76%** |
| ...of those, frozen while `v` claimed > 1 u/s | 3.36% | 0.00% | **0.00%** |

The middle column is the fix that was tried first — brake into the hold rather than hit it — and
it is why the approach test below exists. It is the right answer for *ambient* traffic and the
wrong one for the taxi: it removed the freeze but cost 0.6 u/s buying a politeness the mode should
never have had. Dropping the hold outright is faster than the code ever was and stationary a
quarter as often.

And it does not turn the mode into a lottery. A fresh city per run, taxi routed fare to fare with
boost held until the collision detector fires:

| | before | nothing stops it |
|---|---|---|
| median time to wreck, `?cars=7` | 22.8s | 22.2s |
| median time to wreck, `?cars=24` | 5.8s | 5.8s |
| taxi pinned at a hold line | 0.43% / 1.99% of frames | **0.00%** |

The holds were rare enough that removing them barely moves the crash rate — they were costing the
mode its feel, not protecting it. Closest undetected approach stays at 3.0–3.2 units against the
2.31-unit envelope, so nothing drives through anything: every contact is a detected wreck.

**What still slows it** is the car directly in front in its own lane, at `BOOST_GAP`. That one is
deliberate and predates this — see the scatter work above and the envelope tuning in
`sim/collisions.js`, which exists precisely so Loco Mode isn't a lottery over which same-road car
you died on. It costs 0.76% of frames stationary, almost all of it behind a leader scatter hasn't
cleared yet.

### The freeze underneath it

Being refused at the line is *pinning `s`*, which stops the car without touching `car.v`. Nothing
downstream is told: the wheels keep turning, the nose never dips, and the weave — paced off
`v · dt` — keeps sliding a stationary car sideways in its lane, up to 0.084 units a frame. On
release the whole speed comes straight back with no acceleration in between. At 18.7 u/s that read
as the gas cutting out; the worst single case measured **7.0s frozen at 19.7 u/s**.

The taxi no longer reaches that path while boosting, but ambient traffic still does, so it is
fixed rather than bypassed, in two parts:

- **The other three refusals are read on approach**, exactly as the signal always was, and folded
  into `allowed` so the car brakes for them. `exitLaneFull` and `leftYieldBlocked` came out of the
  arrival path into shared helpers called from both places, so the two askings cannot drift apart.
  A routed car asks about the exit its route names, which is exact; an unrouted one hasn't rolled
  its dice yet, so it only slows when *every* exit is blocked and no roll can save it. This cuts
  freeze frames across the ambient population by about **65%** (0.37% → 0.13% of car-frames).
- **The hold bleeds `v` off at `BRAKE`** instead of leaving it alone, so whatever does still get
  refused at speed lands on a stationary car with stationary wheels and a nose that dips.

The car this matters most for is one **fleeing the boosting taxi**: scatter lifts its ceiling to
2.0× cruise and the taxi's priority hold hands it the green, so it arrives fast with nothing else
slowing it. A lane is 12 units with the hold line 3.4 back, so it has **8.6 units** of warning
against the **13.1** it needs to stop from 17 u/s — which is the residual. `tools/probe.mjs` stages
exactly that car and asserts it brakes rather than freezes; it fails at 8.68 u/s stationary on the
code before this.

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
stop, and from 22.1 down to 8.5 that takes ~0.78s: the coast-down was already sitting there once
the speed cap and the hazard flag stopped being the same boolean. It's also where the nose-dip
comes from — the pitch spring downstream reads the deceleration straight off `car.v`, no separate
animation needed. A re-press mid-cooldown cancels it outright and returns to `'active'`.

### Overtaking

Once nothing else stops the taxi, the car directly in front is the only thing left that does. It
cannot be gone round *inside* the lane — 4 units wide against a 2.31-unit collision envelope — so
the taxi goes round outside it: a full lane change into the **oncoming** lane, past, and back.

> There is a workbench for this one: [`/lab/`](lab.md) is a straight road with no lights, a car in
> front, and a bottomless boost tank, so the manoeuvre can be watched on demand rather than waited
> for. The numbers below are what it is running.

**The player takes it by keeping the button down.** Holding through a car in front means "go around
it"; letting go means "tuck in behind". No new control on a HUD that has deliberately few, and the
button becomes a decision at the one moment it previously made none. It is the one place in
`traffic.js` that reads the narrower `boost && !boostEasing` rather than `car.boost`: every other
boost-only rule stays armed through the cooldown tail because those are *hazards* and hazards
should outlive the release, but this is an input, and letting go has to steer the car back.

**This was built once before and abandoned, and why matters.** The old overtake pulled out to the
road *centreline*, which is the single worst place on the road:

| | gap to the leader | gap to oncoming |
|---|---|---|
| own lane centre | 0 — blocked | 4.0 |
| **centreline — the old design** | **2.0** | **2.0** |
| oncoming lane centre | 4.0 | 0 |

Against a 2.31-unit envelope the centreline overlaps *both* lanes at once, so every car it drew
level with was a crash whichever way that car was pointing — "less a skill than a lottery over
which car you died on". Committing the *whole* lane is what fixes it: 2·LANE of clearance from the
car being passed, and zero from anything coming the other way, which is the entire point. The
centreline is now somewhere the taxi passes *through* in `PASS_FADE` units of road, never somewhere
it settles. `tools/probe.mjs` asserts the direct form of that — closest approach to the car being
overtaken, measured at **3.70 units** against the 2.31 envelope.

**Nothing new was needed to make it dangerous.** `sim/collisions.js` tests the taxi against every
car in world space and is armed for exactly as long as `car.boost` is true, and `car.x/z` already
carry the lateral offset — so oncoming traffic, and a leader that turns across the taxi mid-pass,
became live hazards the moment the taxi could be out there. Zero lines of collision code.

#### The shape of it

Three things decide whether a pass *reads* as driving rather than as a diagram, and the first
version of the manoeuvre got all three wrong in the same way — by treating a lane change as a
translation.

**The offset is smoothstepped, not linear.** The offset is a function of distance and the yaw is its
slope, so a constant slope means the car snaps to a 30° crab on one frame, translates down a ruled
diagonal, and snaps square again on another: two corners and a straight line. `e(t) = t²(3 − 2t)`
starts and ends at zero slope, so the yaw eases into the crab and out of it. That costs road —
smoothstep's peak slope is 1.5× the linear one over the same distance — so `PASS_FADE` went 7 → 10,
which puts the peak back at 31° and buys the easing at the ends rather than with a steeper middle.
What is left of the old snap is frame quantisation: 0.18 rad on the first frame at 60fps against the
0.571 a linear ramp put there.

**It no longer freezes mid-junction.** The offset is frozen through a *corner*, because a lane
change running through one would peel the car off its own Bézier arc — but `state === 'turn'` covers
every junction transition, and freezing on all of them meant that, since every pass spans a junction
by construction, most passes stopped dead half way across the road. The taxi parked at `pass` 0.66,
`z = −0.9` — near enough exactly the centreline, [the worst place on the
road](#overtaking) — and drove the whole 8 units of the junction like that before resuming. That
hole punched in the middle of the ramp was most of what read as angular. A straight-through crossing
has no arc to peel off; its path is a straight line and its yaw is constant, so the offset composes
with it exactly as it does on a lane.

**The body banks, and rocks both ways.** `PASS_BANK` (0.14 rad at cruise, speed-scaled on the same
clamp the corner lean uses) is driven by the *curvature* of the eased offset — `e''(t) = 6 − 12t`,
positive over the first half of a change and negative over the second. So the car rolls one way as
it is thrown out of its lane and the other as it settles into the new one, and mirrors that on the
way home: a rock over and back per change.

> **It leans the opposite way from a corner, on purpose.** A corner leans *outward*, away from the
> turn centre, because that is where weight transfer throws a body — leaning inward there reads as
> a motorbike. The lane change is negated against that: the car dips onto the edge it is heading
> *for*, so pulling out to overtake drops the driver's side and tucking back in drops the
> passenger's. Physically the wrong way round, chosen after looking at both. A lane change is over
> in half a second, and an outward lean spends that half second tipping *away* from the direction
> the eye is being asked to follow.

> **It only ever reached the screen on an east–west street.** The taxi posed with Three's default
> Euler order, which rolls about the **world** X axis rather than the car's own — so the bank
> rendered as pitch heading north or south, and mirrored heading west. The passing lab's road runs
> due east, where the default and `BODY_EULER_ORDER` agree exactly, so the bank looked right there
> and was invisible in the game. Fixed for the taxi, the police cruiser and the aeroplane; see
> [rendering.md](rendering.md#car-motion). The taxi's *corner* lean had the same defect for as long
> as it had existed.

It is added to the corner lean rather than replacing it, since they are two things happening to one
suspension — though in practice they never overlap. A pass is only offered where the route carries
straight on, and a straight-through crossing contributes no corner lean at all: measured over eight
cities at `?cars=22`, a pass is displaced through a real corner for exactly **0** frames.

**And it leaves rubber.** Throwing a car a full lane sideways at the overdrive top is the one
manoeuvre in the game that breaks traction without turning a corner, and it was the only one leaving
nothing on the road. `main.js` and the lab both stamp while `|passSlope| > PASS_RUBBER_SLOPE`, which
brackets the two lane *changes* and stops while the taxi is simply driving along in the borrowed
lane — not a moment anything is sliding.

#### On a divided arterial it is a wider swing

`PASS_LATERAL` is read off the road, not taken as `2 · LANE`. An arterial's carriageways are 6.67
apart rather than 4, and a 4-unit swing there would park the taxi **on the median**, side by side
with the car it was passing — the exact failure the old centreline overtake was abandoned for.

`PASS_FADE` and `PASS_SIGHT` scale with it. The fade keeps the peak crab angle at the 31° it was
tuned to instead of steepening to 45°; the sight line keeps the same margin over an exposure that
is 60% longer. The manoeuvre comes out at roughly **51 units of road against 32**, so a pass on a
main street spans two junctions rather than one — the straight-on gate already re-asks per lane, so
it tucks back in by itself if the route turns.

**The taxi drives over the median.** Props are not in the collision set, so this is a visual, not a
physical, event: a boosting taxi crossing a main street's planted strip goes through the grass and
the trees rather than over them. That is a deliberate trade — suppressing passes on the arterials
would take the manoeuvre away from exactly the roads worth boosting down. Nothing else may touch
one, and `tools/probe.mjs` asserts it (`nothing but a passing taxi drives on a median`), which is
what keeps the police dodge and every lane offset honest.

#### It has to be clear before it comes back

The commitment used to end the moment the taxi's *lane position* went past the leader's, and a lane
position is a centre point: level, not clear. So the taxi began its tuck-in a metre and a half ahead
of a car it was still bodily alongside, cut across its nose over the next `PASS_FADE` units, and the
two came within **2.01** units — inside the 2.31 collision envelope, on every seed, because the
geometry that produces it has nothing random in it. `PASS_CLEAR` (a car length and a half) is
measured against the latched `passTarget` in world space instead, and holds the commitment until the
whole body is past. Closest approach back to 3.65, against the 3.70 this was originally measured at.

#### Sizing it to the city

This is the part that took the measuring. A pass is two lane changes plus the time alongside, and
the road it needs scales with how far back it starts: closing to a body length past the leader is
`PASS_TRIGGER + 5` units of relative displacement, and at the ~10 u/s a boosting taxi gains on
cruising traffic that is **1.83 units of road for every unit of it**. A block is 20 — a 12-unit
lane and an 8-unit junction — so every pass spans a junction, and the offer only stands where the
route carries straight on. Across 30 runs at `?cars=22`:

| pull out at | passes/min | got by the car | still behind it when tucking in |
|---|---|---|---|
| 20 units (where a leader first costs speed) | 4.6 | 6 | 6 |
| 14 | 3.4 | 6 | 2 |
| **10** | **2.6** | **8** | **1** |
| 8 | 2.5 | 6 | 1 |

Pulling out *later* completes more passes, because at 20 the manoeuvre wants 46 units of road
against the 32 one straight junction buys and simply runs out of straightaway. Frequency is the
thing traded away, and it is the right trade: a pass that ends with the taxi tucking back in behind
the very car it pulled out for is all of the risk and none of the reward.

Asking for *two* straight junctions instead was tried and is worse than either — `route[0]` is
consumed crossing the first, so a taxi with exactly two fails the test on the far side of it and
abandons the pass mid-manoeuvre. Measured: 3 of every 4.

#### When it is allowed

Two gates decide *when*, and both were added after watching it wreck rather than pass. Neither was
in the first version, and without them a third of all overtakes ended in a collision — which is not
a risk, it is a coin flip the player never chose to toss, because holding the button is something
you want to do continuously and the pass fires off it automatically.

**Not around a car that is already turning.** A pass wants ~27 units of road against a 12-unit
lane, so the taxi is *always* still alongside when the leader reaches its junction — which is
exactly when the left-turn dice are rolled. Measured over 28 overtakes at `?cars=22`, 10 ended in a
wreck and **every one of them was against a car in the `turn` state**, 6 of those the car being
passed turning left across the taxi. It was the default outcome, not an edge case.

> **Except a straight-through crossing**, which is not what this gate is about, and reading it as
> one cost the pass for a long time. `car.state === 'turn'` covers *every* junction transition
> including carrying straight on — the trap the whole codebase warns about — so the gate refused to
> pull out around any leader that happened to be inside a junction, which on a 20-unit grid is 40%
> of the time and is exactly the 40% in which the taxi is tailgating hard enough to want to. The
> danger it exists to stop is a car turning *across* the borrowed lane; a leader whose committed
> movement is `hand === 'straight'` is going down the same road in the lane the taxi is leaving and
> sweeps nothing. Narrowing it to that took the [lab](lab.md)'s staged approaches from 117 passes in
> 160 to 142.

Refusing that car's left turn while it is being passed — the same courtesy `priorityJunction.block`
already extends to oncoming traffic — fixes only 1 in 10 of them, because by the time the taxi
pulls out the car has usually *already* chosen: a car in `turn` has committed, and the turn
decision does not run again. The gate that works is refusing to pull out around a car that is
mid-junction at all. Both are in, since the second one covers a leader that reaches its line later
in the manoeuvre. Together: 32% → 19% of passes wrecked, and **no same-way collisions at all**.

**Not into oncoming traffic already in sight.** `PASS_SIGHT` (35 units) is the exposure — the
manoeuvre plus the tuck-in, ~1.2s, against a closing speed of 22.1 + 8.5 = 30.6 u/s. Asked only at
the moment of pulling out: a car that emerges into the oncoming lane *during* the pass still costs
the run, and that is the risk worth keeping, because it is the one the player could not have read.
Being thrown into a car that was in plain sight the whole time is not — without this the taxi
pulled out with oncoming traffic **3 units** away, already inside the collision envelope.

> The side test measures against `PASS_LATERAL + CAR_W`, not `HALF_ROAD`. Opposing lane centres are
> exactly 2·LANE apart, which is exactly HALF_ROAD, so a bound of HALF_ROAD sits precisely on the
> car being looked for and the weave alone was enough to push it out of sight. That bug made the
> check look nearly useless (29% → 22%); fixing it took the same check to 17%.

What the two gates cost is frequency: 2.7 → 1.8 overtakes a minute, and 19.19 → 18.98 u/s of ground
covered. What they buy is that the manoeuvre mostly works.

#### How dangerous it should be

The honest way to read the risk is per second of exposure, not per pass — a pass lasts about a
second, and Loco Mode is lethal anyway:

| | wreck every | |
|---|---|---|
| in lane, boosting | 8.7s | |
| out in the oncoming lane, no gates | 3.3s | **2.7× as dangerous** |
| out in the oncoming lane, both gates | 7.8s | **1.1×** |

1.1× is arguably now *too* safe, and `PASS_SIGHT` is the dial: lowering it puts more oncoming
traffic in play. It is a feel judgement rather than a correctness one, so it is left at the value
that makes the manoeuvre reliable and the remaining deaths readable — oncoming traffic that
arrives during the pass, cross traffic at a junction being run, and a car turning out of the
oncoming lane.

#### It pays, and scatter never needed tuning

At `?cars=22`, boost held continuously:

| | without passing | with |
|---|---|---|
| ground covered | 18.18 u/s | **18.98** |
| held up behind a leader | 10.39% of frames | **4.50%** |
| median time to wreck | 5.1s | 7.3s |

Surviving *longer* is not a mistake. Tailgating at `BOOST_GAP` is where rear-endings and
turning-car collisions happen, and passing is how the taxi stops doing it — the oncoming lane costs
3 runs in 30, which is less than the queue it replaces. What passing buys is speed; what it costs
is a new way to die that you can see coming.

The one coupling that is load-bearing is **suppressing the leader brake while committed**: the taxi
is going round that car, so measuring its bumper is measuring the wrong lane. Without it the taxi
sits alongside matching speed — ground 18.18 rather than 19.19, mean pass 1.48s rather than 0.89s,
and 5 completions instead of 8. It also makes releasing the button a real abort, since the brake
comes straight back and drops the taxi in behind.

**Scatter, which was expected to be the blocker, turned out not to be.** A car fleeing at
`SCATTER_SPEED` (2.0× cruise, 17 u/s) against the taxi's boost cap closed at 1.7 u/s when that cap
was 18.7 — no pass at all — so suppressing the flee while passing looked obviously necessary. (At
the current 22.1 it closes at 5.1, so the premise is weaker than it was and the conclusion below is
stronger.) It measures as an exact
no-op at both ends of the density ramp: same passes, same completions, ground speed 19.14 *with* it
against 19.19 without. `PASS_TRIGGER` is why. A car still only 10 units ahead is by construction one
scatter has already failed to move, because one it moved would have opened the gap past the trigger
and never been passed at all. The cars the taxi goes round are the ones stuck behind something, and
telling them to floor it does nothing. Sizing the manoeuvre to the road is what made passing
possible; the flee was never in the way.

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

**Each car detonates where it stands.** One `blast.fire()` at the impact point and another at the
other car's centre. The two are only a couple of units apart, but that is enough to spread the
blast across both bodies instead of stacking it on the seam between them, and each call carries
that car's paint, so the shards come apart in two colours and what flies is visibly two cars.

**And then it all keeps going.** Both calls also carry the taxi's heading *and the speed it arrived
at* — as do the smoke collar and the two shells — so nothing in the wreck detonates out of a
stationary origin. `sim/collisions.js` reads that speed off the taxi one line before it zeroes it
and puts it on the impact event, because by the time the listener runs there is nothing left in the
world to recover it from. See [rendering.md](rendering.md#momentum) for what each piece keeps and
why they are not all given the same share.

**Two tyres per car get away.** They bounce out of the wreck and roll off down the street on the
taxi's heading, and they are the only recognisable piece of car in the whole effect — see
[rendering.md](rendering.md#the-tyres).

**And one collar of smoke around the pair**, at the point between them — `dust.wreckSmoke()`, the
same lit puffs a barricade throws, tinted grey and rung around the fire rather than trailed off the
back of a car. It is drawn under the fireball, so the fire keeps the middle, and it outlives it, so
the last thing on the road is smoke rather than orange. See
[rendering.md](rendering.md#the-smoke-collar).

It was four effects fired twice each plus a third wave on a `setTimeout`, and a **debris pool per
car** on top — a pool re-shot its own pieces on every call, so one shared pool would have snapped
the taxi's wreckage across to the other car's the instant the second burst fired. All of that is
one module now, and the pool-per-car problem is gone with it: nothing in `blast.js` is re-shot from
a stored position, so a second call cannot drag the first one's wreckage anywhere. See
[rendering.md](rendering.md#wreck--gameblastjs-gamevanishjs).

**The shells shrink and fade into the fireballs** rather than being hidden. The old version cut:
`taxiGroup.visible = false` fired on the impact frame, one frame before the fireball had grown
large enough to hide anything, so the eye read a car blinking out and then, separately, a bang.
`vanish.take()` collapses each shell over 0.34s of sim time instead — stepped with the frame's
already-slowed `dt`, so it stretches to nearly two seconds on screen under the crash slow-mo,
which is exactly how long the fireball is at its biggest. The fade leads the collapse (halfway
through: three-quarters size, a quarter opaque), because matching the two curves left a small,
solid, brightly lit nugget riding the middle of the fireball to the last frame.

They also collapse while still **moving** — `take()` takes a drift and a slew, on the same decaying
curve the rest of the wreck's momentum rides. This is where the momentum reads hardest, because a
shell is the only recognisable object in the picture: a fireball is an abstraction and can be
forgiven for standing still, a car cannot. The two are given deliberately different numbers — the
taxi keeps less for having hit something, the car it hit is shoved harder — and are slewed in
opposite directions, taken from which side of the taxi's line it was sitting on. Matched, the pair
travels as a rigid unit, which reads as a wreck being panned across rather than as one car hitting
another.

The taxi has its own group to fade, steered wheels and all. An ambient car is spread across two
`InstancedMesh`es — the body, plus one instance per steered front wheel — and neither has anywhere
to put a per-instance opacity, since `instanceColor` is RGB only. So `wreckShell()` copies the car
out into a standalone group (body plus both wheels at the lock the impact caught them at) sharing
one tinted, fadeable material, and collapses **every** instance behind it to zero scale. Collapsing
only the body would leave two wheels parked on the road; `tools/probe.mjs` asserts all three. This
is cheaper than the alternative — a custom alpha attribute plus an `onBeforeCompile` patch on the
traffic material — for something that happens once per run.

## Roadworks: a street closed at both ends

`src/game/roadwork.js` and `src/geometry/roadworks.js`. Once per run, about a minute in, a side
street is closed off: a striped trestle across each end, two rows of cones, a heap of spoil beside
the hole it came out of, and two workers standing over it. Ambient traffic routes around it. **The
player's taxi is sent through it**, so the closed street is the emptiest road in the city — and
each barricade is a ramp.

### The closure is soft, and that is not a shortcut

There was already a way to close a road: `grid.js`'s `setClosedSegments`, which a park district
uses. It is read **once, at bake time**, by `roadNetFromGrid` — it deletes the edge, merges the two
blocks it separated into one face, and re-derives every signal phase around the junctions at either
end. Re-baking mid-run would leave every `car.lane` and `car.turn` in the `cars` array pointing
into a graph that no longer exists, and `ground.js` is one merged mesh built at startup with no
road in it to remove.

So the network is untouched and two **lane ids** are handed to `setClosedLanes`. They are read in
exactly one place — the weighted dice at the single turn-decision site — where they zero a turn's
weight:

```js
return { turn, w: closedLanes.has(turn.outLane) ? 0 : w };
```

**A weight rather than a filter, and the zero is load-bearing in both directions.** With any open
exit present `total` is positive, `roll` is strictly greater than zero, and a zero-weight option
can never win the walk — it reads as a hard ban. With *every* exit closed `total` is zero, `roll`
is zero, and the first iteration's `roll -= 0` satisfies `roll <= 0`: the car takes `options[0]`
and drives on. A filter would empty the list instead, and a car with no legal exit holds at the
line **forever**, with its whole lane queued behind it. Placement already refuses any segment that
would strand an approach — see below — so the degenerate branch should never run; it exists so that
a bug in the placement rules is a car driving through a barricade rather than a wedged city.

Two smaller consequences in the same file: right-on-red is refused into a closed lane, and
`setCarCount`'s spawn filter will not mint a car inside one.

### Getting the player there

The same two lane ids go to `route.js` as well, via `setRoadworkLanes`, and say the opposite thing:
to ambient traffic these turns are **forbidden**, to the taxi's router they are **cheap**. That
asymmetry is the whole vignette — the city empties the street and the fare sends the player down it.

This was not the first build. Originally the taxi genuinely had never heard of the closure, on the
theory that stumbling into it was the discovery. Measured, that theory was wrong: **the player
cannot steer.** They tap a rider and the taxi routes itself, so "go and look at the roadworks" is
not a thing they are able to choose, and the zone was found in 33% of runs — mostly scenery, built
in full and rarely seen.

Two mechanisms fix it, and `tools/roadwork-pull.mjs` shows that neither is enough alone:

| | no drop-off aim | drop-off aimed |
|---|---|---|
| **no discount** | 33% | 50% |
| **`roadwork` 0.45** | 67% | 96% |

- **`EDGE_COST.roadwork = 0.45`** prices a closed lane well under an ordinary side street. Scale
  matters and is easy to get wrong: costs are ~1.0 per block, so a weight of `w` only wins a detour
  worth less than `1 - w` blocks. Anything near the ring's 0.90 is a pure tie-break, which is why
  the first attempt at this changed almost nothing. 0.45 buys about half a block. Below it nothing
  improves — 0.20 measures identically — so 0.45 is the knee.
- **`fares.aimNextDropoff`** gives exactly one fare a destination at a junction the closed street
  runs into, so there is a trip heading that way for the discount to pull. Only the *destination*
  moves; the pickup, the clock and the price are drawn as always, so the economy is untouched.

The player is still not being steered. What moved is where a rider wants to go and what the roads
cost — the same two things that decide every other route in the game.

**What this does to fare clocks is smaller than it looks.** A fare's budget comes from
`chainSeconds`, which does now plan over the discounted weights — but `estimateSeconds` prices a
route by `route.length * SEC_PER_BLOCK + turns * SEC_PER_TURN`, in blocks and turns, never in lane
cost. So the discount cannot make a given route cheaper to the clock; it can only change *which*
route is picked, and only by the length difference between the two. `probe.mjs` bounds that at one
leg either way, and across a sweep the mean planned route moves 4.23 → 4.17 legs — slightly
shorter, because a cheap lane straightens as many trips as it bends.

The player is left with a little more slack than the clock knows about, which is the right
direction to be wrong in: the closed street really is quicker to drive than the estimate assumes,
since there is nothing on it to queue behind.

### Which street

Placement (`roadwork.js`) refuses a segment unless all of:

- it is a **side** street — closing an arterial fights the 64% green share and the platoon offsets
  the city is timed around, and the ring is the road everything else escapes onto;
- every approach at both end junctions keeps at least one open onward lane. This is asked exactly,
  by walking `lane.onward`, rather than by a corner heuristic: what strands a car is not the shape
  of the junction but a single inbound lane whose every exit is closed, and U-turns are illegal;
- both lanes are empty of ambient traffic right now, so nothing appears on top of a car;
- no rider is waiting at either end — a pickup inside a construction site reads as a bug even
  though nothing about it breaks;
- its lanes are long enough to land the ramp's stunt in — `BARRIER_S + HOP_LEN + STOP_SETBACK` =
  11.0 units. A side street between two ordinary junctions is 12 units of lane and the chain lands
  1.0 clear of the hold line; one with an **arterial** at either end is 10.67, because the extra
  third of the arterial's width comes out of both its neighbours' lanes, and the same chain lands
  0.33 *past* the line the taxi picks its next turn at. That is 22 of the 56 side lanes on a
  default city. Behaviour is a little better than the arithmetic — the hop fires off the taxi's
  nose, about half a car length before `BARRIER_S`, so a measured overdrive run lands at 7.13
  against a line at 7.27 — but 0.14 of slack is one frame at 22 u/s. `BARRIER_S` and `HOP_LEN`
  were measured on a 12-unit lane and nothing re-measured them when the arterials were widened;
  skipping the short lanes keeps the stunt exactly as it is on every site it can appear at;
- it is at least 45 units from the taxi, the same number and the same honest caveat as
  `SPAWN_CLEARANCE`: on a desktop the whole city is in frame at once, so this cannot pretend to be
  off-camera. A segment currently outside the frustum is *preferred* where one exists.

The zone then **rises out of the road** over 1.1s rather than appearing on it. The slab is opaque
and drawn first, so the part still below y = 0 fails the depth test — which is what makes the rise
free, and what covers the desktop case where nothing can be set up off-screen.

### The ramp

`HOP_LEN`, `launchHop` and the arc live in `traffic.js`, next to `locoWheelie` and for the same
reason. The hop is **rendered only**: `car.s`, `car.lane`, the turn decision, following distance
and the collision test all carry on as if the car were on the tarmac, which is what stops a stunt
being able to break the sim.

**Paced by `car.travelled`, not by a clock** — the same lesson the Loco weave and the front-wheel
ease both record. A half-second hop covers 4.25 units at cruise and 11.5 in overdrive, and 11.5 is
nearly a whole 12-unit lane: the taxi would still be in the air at `holdS`, where it picks its next
turn. A fixed **5.5 units** of road lands in the same place at any speed, and freezes if the car
stops. `tools/probe.mjs` drives the same barricade at cruise and at 22 u/s and asserts both arcs
measure `HOP_LEN` and both peak at the same height.

**Height is not part of that chain.** What has to land before the hold line is the *span*; the apex
costs nothing. `HOP_HEIGHT` is 2.75 — most of a car length, about 21px at play zoom — against the
1.55 it started at, which at a 3/4 camera was a lift rather than a jump: the taxi's shadow never
separated from it far enough to say the wheels had left the road, and the shadow gap is what sells
it. `HOP_PITCH` went 0.26 → 0.34 with it.

**Touchdown hands off to a bounce**, and that one is paced by a **clock**, which is not an
inconsistency with the paragraph above. The arc is distance-paced because *where it ends* is the
whole constraint. A bounce ends wherever it likes — nothing downstream reads it, it moves the
rendered group and nothing else — and what it models is a spring settling, which happens in
seconds. Paced over 3.4 units instead it ran 0.4s at cruise and 0.15s in overdrive: nine frames for
two rebounds, somewhere between a flicker and nothing.

It is two parts. `landingBounce(t)` is `|sin|` over two periods under a linear decay, so the second
rebound comes back at a third of the first; and a one-frame **nose-down impulse into the pitch
spring** (`pitchV -= 1.25`), which is underdamped at ζ ≈ 0.4 and rocks itself back out — the reason
the suspension hit is an impulse rather than a second hand-animated curve. The decay was squared to
begin with, which sounds like the same shape and is not: the first hump peaks a quarter of the way
in, where a squared decay has already taken 44% off it, so the visible rebound was 0.22 units
against the 0.4 the constant claimed.

`car.bounceT` is a **separate field from `car.hopFrom`** on purpose. Everything that asks "is the
taxi airborne" — the barricade's landing event, the roadworks pack-up, the probe's arc assertions —
is asking about the *arc*, and a bounce that answered yes would move all of them. `landingBounce`
is exported so the probe can assert the curve directly: measured off the rendered taxi it would be
measuring the speed bob and the pitch lift too, and in overdrive those are three times its size.

Three constants have to keep closing here, and they are easy to move one at a time:

```
launch at BARRIER_S 2.1  →  land at 2.1 + HOP_LEN 5.5 = 7.6  →  holdS at 12 - STOP_SETBACK = 8.6
```

`HOP_LEN` came down from 6.0 when `BARRIER_S` went out from 1.7 to get the ramp's toe clear of the
junction box: 2.1 + 6.0 = 8.1 left half a unit before the line where the taxi picks its next turn.
The probe asserts the **margin**, not just that the taxi landed in time, so moving any one of the
three fails loudly rather than on whichever run happens to be fastest.

The barricade test is a **crossing** — `lastS < barrier.s <= s` on the same lane — not
`s >= barrier.s`, which is true for the whole rest of the lane and would launch a taxi that was
already past the line when the zone finished rising.

> **Known, and not yet fixed:** each barricade is bound to *its own* lane id, but both trestles
> span the full road. A taxi entering at one end smashes the barricade on the lane it is driving
> and then passes straight through the one at the far end, which belongs to the opposite lane —
> `1 of 2` on a full pass. Binding a barricade to a position along the *segment* rather than along
> one lane would fix it, at the cost of two launches per pass, which is a feel change rather than a
> bug fix and has not been made.

### Packing up

Once the taxi is **through** — off the closed lanes and back on the ground, not merely having
smashed something — **and the crew has gone**, the zone waits `LEAVE_DWELL` for the trestle to
finish cartwheeling and the cones and splinters to settle, then fades out and sinks back under the
road over `FADE_OUT`. The sink is the mirror of the arrival and works for the same reason: the slab
is opaque and drawn first, so whatever has gone below y = 0 fails the depth test for free.

The trigger is deliberately "off the closed lanes", not "has smashed": the taxi hits the barricade
at the *mouth* of the street and still has the whole block to drive, so fading from the smash would
dissolve the site around a car that is still inside it.

The **crew clause is the other half of the same lesson, and it only ever failed at speed.** The
zone's fade starts when the taxi is clear of the street, and in overdrive that is half a second
after the smash — while the two workers are still mid-sprint. The old rule started the site fading
at about t = 1.35s against a run that ends at 1.15s and a worker fade that ends at 1.65s, so they
spent the back half of the sprint dissolving: they read as *vanishing instead of escaping*. The
zone now waits for `workersGone()`, which sequences the beats rather than fixing the durations —
run, hold, fade, and only then the site. `probe.mjs` asserts the ordering, not the numbers, so the
constants stay free to move.

**The half of the teardown that is not cosmetic is giving the street back.** Both lane sets are
cleared — `setClosedLanes` and `setRoadworkLanes` — because a closure left behind after the
barricades have gone is invisible from every other angle: ambient traffic would avoid a road with
nothing on it for the rest of the run, and the router would keep taking a shortcut down it. There
is an assertion for exactly this, since nothing on screen would ever show it.

Workers all run the moment a barricade goes, rather than only those within `FLEE_R`. The proximity
rule is right for a taxi merely driving down the street and wrong once something is in the air — a
worker calmly holding a shovel eight units from a cartwheeling trestle reads as a figure that has
not been told what scene it is in. They reach the kerb, turn to look back, hold that pose for
`WORKER_HOLD` and only then fade — a figure that starts dissolving the instant they stop never
reads as having got there. Their alpha multiplies into the zone's rather than being overwritten
by it.

## Police priority corridor

`src/sim/police.js`. A police car crosses the city on a cycle, holding every signal on its road
green and every crossing road red. The override lives inside `lightPhase` — `canProceed` is the
single place any car asks "may I enter?", so the whole city reacts correctly without car logic
being touched at all.

It drives its **lane** — right-hand traffic, one `LANE` off the road centreline — at `SPEED = 19`
(about twice traffic). It skips the lane-following and collision machinery entirely, so it never
queues behind anyone. A red/blue point light rides with it.

### Nothing crashes into it, so the lane has to clear

This doc used to argue that never queueing was harmless, because the corridor holds every
downstream light green and so the cars in the cruiser's lane are already moving by the time it
arrives. They are moving at 8.5 against 19, which is not enough: what the player saw was the
cruiser driving *through* the traffic on its own road, one car after another, all the way down an
arterial.

There is still no collision response — a scripted car on a rail cannot be crashed into, and giving
it one would mean giving it the whole following model. Instead the lane clears, from both sides:

| Half | Where | What it does |
|---|---|---|
| The pull-over | `PULLOVER_*`, `traffic.js` | A car in the cruiser's **own lane** — same road, same direction — dives 1.5 units for the kerb, rides up onto it (part of `KERB_H`, leaning toward the road on its outer wheels), and sheds half its cruise on top of the panic dip. |
| The dodge | `DODGE_*`, `police.js` | The cruiser moves 1.1 units toward the road centreline to squeeze past, and its nose and front wheels tilt into the swerve. |

Neither half works alone: 1.5 units of pull-over against two 1.7-wide bodies still overlaps.
Together the two centres end up 2.6 apart with 1.7 of summed half-width — about **0.9 units of
daylight**, which reads as a squeeze rather than a clip. The cruiser never crosses the centreline,
because the corridor only clears *junctions* and says nothing about a car already mid-block coming
the other way.

Three details that are not obvious:

- **The pull-over and the panic shove take the larger of the two, not the sum.** Stacked they reach
  2.4 units off the lane centre, which puts a body edge 5.17 out — past the 4.85 where building
  façades start. Taking the max caps it at 4.34.
- **It survives a junction the car is going straight through.** `state === 'turn'` covers
  straight-through as well as a real turn, so gating on `'drive'` the way the panic shove does
  snapped every yielding car back to the lane centre for the eight units of each junction box.
- **A car with the siren about to come through its junction does not turn across it**
  (`sirenHoldsTurn`) — the same courtesy the no-left-across-a-pass rule extends to a boosting taxi,
  and for the same reason. This is the only part that reaches a car mid-junction, since the offset
  is released for the length of a real turn rather than bending the car off its own arc. It applies
  to the oncoming lane too, which never pulls over at all but is exactly where a left turn crosses
  the corridor.

Measured over 199 corridor runs across 24 seeds, frames with the cruiser inside an ambient body
fell from **1747 to 495**, and the ones on open road — the arterial case above — from **762 to 7**.
What remains is almost entirely cars mid-turn inside a junction box: the same category
[the wreck](#the-wreck) already leaves standing as a hazard the player can read.

The oncoming lane needed nothing. Two lane centres are `2·LANE` = 4 apart against 1.7-wide bodies,
so there was always 2.3 units between them.

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

**The light bar runs for the whole of a run; the bust arms a block in from the edge** —
`BUST_ARM_INSET`, which is `PITCH`. The gap between the two is deliberate: about two seconds of
visible siren before the cruiser can take a run off you. See
[the bust chase](#arming-it-where-it-can-be-seen) for why that number is the bust radius rather
than a tuned one.

`propMaterial()` returns a fresh instance per call, which is what makes this safe — turning on
transparency here affects the police car alone and not the merged prop meshes.

### It checks for roadworks too

A park closure is baked into the network, so `legalExits` has always kept the cruiser out of the
trees. A [roadworks closure](#the-closure-is-soft-and-that-is-not-a-shortcut) is **soft** — two lane
ids in a set, nothing removed from the graph — so nothing stops a car that does not look, and the
police car was that car: it drove through the barricades, the cones and the hole.

It looks in three places now, one per way a cruiser can reach a dug-up street:

- **Drawing a corridor.** `lineIsClear` walks the whole line and rejects it if any segment is
  closed, by a park or by a zone. Six of forty draws used to land on the closed line.
- **Every junction of a chase.** `turnAt` filters dug exits out in a first pass — only a first
  pass, because a chase that found every exit closed should drive through the cones rather than
  abandon the bust over a traffic cone.
- **Placing the zone.** `eligible` in `roadwork.js` declines an edge on a live siren's road, which
  closes the one case the other two cannot: a zone rising underneath a run already in progress.

> Once fixed: the police car drove straight through a park. It now respects closed segments.

## The bust chase

Boost within `POLICE_BUST_RANGE` (20 — one block) of an **armed** corridor run and the run is over:
`bustByPolice()` in `main.js` freezes the taxi, drops into slow-mo and holds the run-end banner,
same beat as a wreck. What it adds is `police.chase(taxi)`.

### Arming it where it can be seen

The bust radius is a block (20) and `FADE_BAND` is 18, so for a while the cruiser was **lethal
before it was drawn**. For a taxi `e` units in from the map edge, the bust fired with the cruiser
at `(e − 2) / 18` opacity:

| taxi is… | cruiser's opacity when it busts you | visible approach first |
|---|---|---|
| on the ring road (`e` = ±2, either lane) | **0.00** | none, ever |
| half a block in (e = 10) | 0.44 | 8 units, 0.4s |
| **one block in (e = 20)** | **1.00** | 18 units, ~0.95s |
| mid-map (e = 40) | 1.00 | 38 units, ~2.0s |

On the ring that was every bust: the lamps fade with the body, so there was no cue at all — only
ambient traffic quietly making room for a `setPolicePresence` you couldn't see. Measured over 238
corridor runs, the old check was armed while the body was still fading for **28.6%** of the frames
it could reach the slab at all, and while the body was completely invisible for **2.9%**.

`BUST_ARM_INSET` gates the whole thing on `|s| ≤ HALF_SPAN − PITCH`. It is **the bust radius, not a
tuned number** — the table is why: one `PITCH` in is exactly where that opacity column reaches 1.
A chase stays armed wherever it is routed, and so does the cruiser parked at an arrest, since both
are past the bust they were armed for.

What this gives up is a window where the outer band is bust-proof — but only against a cruiser
that is itself still out in the outer band, since the radius is 20 either way. The moment it is on
the slab the whole map is armed again, including the ring behind it.

`tools/probe.mjs` asserts the invariant rather than the constant: nothing that can bust you is
transparent, and nothing that can bust you has a dark light bar. On the code before this those two
fail at 3198 and 975 of 9346 armed frames.

### The lights lead the gate

The bar used to arm off `state.armed` too, on the argument that one flag meant the rule could be
read off a single run — *lights on means it can bust you*. It made the cue honest and it made it
late: the siren came up a block in, which is also the moment the bust exists, so the first thing
the player learned about a cruiser was that it had already got them.

So the two are separate flags now. `state.lit` goes up in `start()`, on the frame the cruiser
spawns off the slab, and comes down in `stop()`; `state.armed` is unchanged. The lamps still scale
by `fade`, so nothing shines out of a car that hasn't drawn yet — the announcement arrives exactly
as the body does, at `|s| = HALF_SPAN + FADE_BAND`, and the arming line is 38 units further on.
At `SPEED` = 19 that is **2.0 seconds of visible siren before the bust exists**, measured per run
by the probe (`every run telegraphs itself before the bust arms`) rather than assumed from the
arithmetic. Half that if the taxi is driving at it in Loco Mode, which is the case the grace period
is for.

The rule the player reads is now *lights on means a cop is here* — and the beat between seeing one
and being caught by one is the room to lift off. The three invariants the probe holds: an armed
cruiser is fully drawn and lit, a cruiser that is drawing at all is lit, and nothing is lit between
runs.

**And it reaches past the edge of the frame.** Being fully drawn is only a cue if the cruiser is in
shot, and on a portrait phone at play zoom a block is about a third of the frame — so a cruiser one
screen edge away is already inside the bust radius of anything on that edge, with nothing to see but
ambient traffic pulling over to a car that isn't there. `game/sirenglow.js` washes the bar's own red
and blue in over the edge the cruiser is coming from, armed off the same `state.lit` the bar is and
strobing off this same `sirenOn()`, so the whole rule stays one rule — the grace period included.
See
[rendering.md](rendering.md#off-screen-police-warning).

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

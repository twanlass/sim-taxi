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
boost-mode outlines and keeps a pool per vehicle class to do it — see
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
stop, and from 18.7 down to 8.5 that takes ~0.93s: the coast-down was already sitting there once
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

Refusing that car's left turn while it is being passed — the same courtesy `priorityJunction.block`
already extends to oncoming traffic — fixes only 1 in 10 of them, because by the time the taxi
pulls out the car has usually *already* chosen: a car in `turn` has committed, and the turn
decision does not run again. The gate that works is refusing to pull out around a car that is
mid-junction at all. Both are in, since the second one covers a leader that reaches its line later
in the manoeuvre. Together: 32% → 19% of passes wrecked, and **no same-way collisions at all**.

**Not into oncoming traffic already in sight.** `PASS_SIGHT` (35 units) is the exposure — the
manoeuvre plus the tuck-in, ~1.2s, against a closing speed of 18.7 + 8.5 = 27.2 u/s. Asked only at
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
`SCATTER_SPEED` (2.0× cruise, 17 u/s) against the taxi's 18.7 closes at 1.7 u/s, which is no pass
at all — so suppressing the flee while passing looked obviously necessary. It measures as an exact
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

**The bust is armed a block in from the edge, and the light bar arms with it** — `BUST_ARM_INSET`,
which is `PITCH`. See [the bust chase](#arming-it-where-it-can-be-seen) for why that number is the
bust radius rather than a tuned one.

`propMaterial()` returns a fresh instance per call, which is what makes this safe — turning on
transparency here affects the police car alone and not the merged prop meshes.

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

**The light bar arms with it**, which is half the point. It makes the rule readable off a single
run — *lights on means it can bust you* — rather than something inferred from deaths, and it keeps
the far end of the run honest too: the bar goes dark for the last block, so the cruiser is never
lethal while it is fading back out either. The corridor itself is unchanged and still runs from the
map edge, so the signals still open ahead of a cruiser whose bar hasn't come on yet.

What this gives up is a window where the outer band is bust-proof — but only against a cruiser
that is itself still out in the outer band, since the radius is 20 either way. The moment it is on
the slab the whole map is armed again, including the ring behind it.

`tools/probe.mjs` asserts the invariant rather than the constant: nothing that can bust you is
transparent, and nothing that can bust you has a dark light bar. On the code before this those two
fail at 3198 and 975 of 9346 armed frames.

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

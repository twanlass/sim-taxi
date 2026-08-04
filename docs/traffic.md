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

## Signals

The scheme that shipped first was `phaseOffset = ((i + j) % 4) * (CYCLE / 4)` on a 16.2s cycle.
Measured, that was **4** distinct timings across 36 junctions, **18 of 36** flipping within the
same half-second, and green-on-arrival at exactly **50%** — pure chance. It waved along the
*diagonal*, which looks synchronised while helping no actual road.

Three changes replaced it, each validated by `tools/signals.mjs`:

### Offsets from travel time

Each junction's offset is derived from how long a platoon takes to reach it (`blockTime() =
PITCH / SPEED`), so consecutive greens open ahead of moving traffic. This also de-synchronises the
city for free, because offsets now spread continuously instead of into four buckets.

Cycle length stays common across the city on purpose — a shared cycle is the *precondition* for
coordination. Variety comes from splits and offsets, not from different cycle lengths.

### Arterials

Two roads per axis take a **64% green share** where they meet a side street, giving the map a
fast/slow grain. `layout.js` picks them; `configureSignals()` hands them over.

### A signal-free ring road

The outermost roads carry no lights except at the four corners. Traffic joining from inside yields
into a gap (`RING_YIELD = 24` units of clear road).

The ring needs its own gate inside `lightPhase` rather than a permanent green: a permanent green
for the ring reads as a permanent *red* for everyone else, and inner traffic would queue at the
perimeter forever.

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

**Turns** follow a quadratic Bézier through `entryPoint → turnControl → exitPoint`, with yaw
interpolated by `lerpAngle` so a car never spins the long way round.

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
const cornerTarget = straightOn || car.boost ? cruise : CORNER_SPEED;
```

A boosting taxi does not slow for corners at all — without this it braked at every junction and
the whole mode read as choppy rather than fast.

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

**The lamps don't show the hold.** Stop bars are coloured from `displayPhase`, which is
`lightPhase` with the priority branch skipped, so the heads keep running their real cycle while the
taxi barges through. Wired to `lightPhase` they flipped green a beat before the taxi arrived, and
Loco Mode read as the city politely opening up rather than as running every red in the grid — the
opposite of the point. The yielding still happens, it just happens *underneath*: cross traffic
balking under a green of its own reads as drivers getting out of a maniac's way. The police
corridor is deliberately not excepted — emergency preemption really does turn the lights, and
watching the green path open ahead of the siren is the whole effect.

The meter itself lives in `game/boost.js` as a pure clock with no knowledge of the taxi or the
DOM. Hold-to-enable: the tank drains only while the button is held (15s from full), releasing just
pauses it, and once empty it refills over 15s before it can be held again.

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

The soak test caught the cost of this immediately — a taxi held at a corridor loses time through
no fault of the player — so the fare deadline carries a `DISRUPTION_ALLOWANCE` to cover it.

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
18.7, so the gap actually closes), and a hard **U-turn** if the taxi is behind it — a left-hand
swing across the full width of the road, which is the beat that sells the lock-on. The light bar
goes double-time, 11 changes a second instead of 6, and that rate change is the only cue the
player gets that the run has become about them.

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

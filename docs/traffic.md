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
const boostTurn = car.boost ? (isRight ? cruise * 0.75 : cruise) : CORNER_SPEED;
const cornerTarget = straightOn ? cruise : boostTurn;
```

A boosting taxi doesn't lift for straights or left turns — without that it braked at every junction
and the whole mode read as choppy rather than fast. Right turns are the one exception: with
right-hand traffic they cut the near corner instead of sweeping the far diagonal, so at full boost
the arc is over in ~0.35s against a left's ~0.7s and reads as *sped up*. 0.75× cruise gives the
tight arc its weight back. It is the only deliberate speed drop left in the mode, and it accounts
for ~9% of boosted frames.

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
below its 18.7 u/s cap, over 12 minutes per density:

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
DOM. Hold-to-enable: the tank drains only while the button is held (15s from full), releasing just
pauses it, and once empty it refills over 15s before it can be held again.

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

The taxi has its own group to fade. An ambient car is one instance of a shared `InstancedMesh`
with nowhere to put a per-instance opacity — `instanceColor` is RGB only — so `wreckShell()` copies
it out into a standalone mesh wearing a tinted, fadeable material and collapses the instance to
zero scale in place. That is cheaper than the alternative (a custom alpha attribute plus an
`onBeforeCompile` patch on the traffic material) for something that happens once per run.

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

**The banner waits for the arrest.** `BUST_BANNER_DELAY` is a floor, not the schedule — the retry
screen holds until the cruiser stops, plus a beat. A park district can close the one road between
the two cars and leave the only legal route three sides of a block long (68 units, 3.5s on seed
8888), and cutting away mid-chase throws out the one beat the feature exists for.
`BUST_BANNER_MAX` caps the wait. The bust also runs a much shallower slow-mo than a wreck
(`BUST_SLOW_MO_MIN = 0.42` against 0.18): at wreck depth the chase waded through treacle, which is
the opposite of "it came after you".

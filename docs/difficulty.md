# Difficulty

`src/game/difficulty.js` owns the whole ramp: one scalar along the run, and two dials hung off it.
It is pure and DOM-free, like `boost.js` and `urgency.js`, and it knows nothing about the sim —
`sim/` must not import from `game/`, so the two knobs that steer traffic and police are pushed
*into* those systems by `main.js`, the same way `traffic.taxi.boost` is.

```
d = clamp(delivered / RAMP_FARES, 0, 1)      // RAMP_FARES = 12
```

**Deliveries, not elapsed time.** A delivery is the player's own success, so the ramp self-adjusts
to skill: a quick player reaches the hard part sooner in wall-clock terms and a slow one gets more
room to find their feet.

## Two dials

| Dial | `d = 0` | `d = 1` | The question it answers |
|---|---|---|---|
| `pace` | 1.5 | 0.85 | How hard do I have to drive to make this rider? |
| `pressure` | 0.5 | 1.4 | Can I take everyone, or do I have to choose? |

**Pace** is a rider's clock over their own trip at cruise:

```
limit = clamp((drive to pickup + trip + reactionAllowance) × pace, 12s, 240s)
```

The drive is `estimateSeconds` (route.js), fitted against a taxi doing the speed limit and stopping
at every red. At 1.0 a clean, legal drive arrives on the last second; above it there is room for a
mistake; below it the seconds have to come out of Loco Mode, running reds and taking the overtake.
The end of the ramp sits below 1.0 on purpose — that driving is what the game is asking for.

**Pressure** is riders offered over riders one taxi can serve. It sets the spawn stagger,
`FARE_CYCLE / pressure`, where `FARE_CYCLE` (35s) is the measured seconds per delivery of a player
who boosts when behind. Below 1.0 the board drains faster than it fills; above it riders arrive
faster than anyone can take them.

Everything else that used to be a knob is now fixed or derived: the board is one rider until the
tutorial fare is delivered and four after it (`BOARD_MAX`), and the spawn radius is a constant
(`SPAWN_RADIUS` in fares.js), because every clock pays for its own approach. Cars and police still
ramp along `d` — they are the world, not the fare game.

| World knob | `d = 0` | `d = 1` | |
|---|---|---|---|
| `carCount` | 12 | 22 | Ambient traffic. Pushed into `sim/traffic.js`. |
| `policeCooldown` | 16–30s | 8–14s | Between patrols. Pushed into `game/patrol.js`. |

`?d=0..1` pins the curve. The ⚙️ panel has a slider for the same handle, and four more for the two
dials' endpoints — they act on the next rider to spawn.

## Every rider is budgeted as if served next

A rider's clock covers the rider aboard (you cannot take a kerbside fare while carrying one, and the
drop-off dispatches itself) and their own trip, and **nobody else on the kerb**. Two riders waiting
are two clocks that each assume the other is not being served. Late in the ramp there is no order
that makes both, and that is the choice.

This was tried once before and taken out, because any rider timing out ended the run: a board of
two riders on served-next clocks was a countdown, and it capped a perfect player at a median of 3–5
fares. The fix then was to budget the *whole queue* — the fare aboard, every waiting rider by
urgency, then this one — which made every board servable in urgency order. That is what got
reported as "you can pick any rider and have plenty of time".

## Strikes

A rider whose clock runs out is a strike, on the kerb or **aboard**. The third ends the run
(`MAX_STRIKES` in fares.js), and the HUD shows three rings under the cash total. A rider aboard
used to end the run on the spot, on the theory that picking them up was the commitment; in play it
read as a bug, because nothing on screen says the rider in the cab is worth all three rings. The
cost of one rule is that grabbing a rider you cannot make is now cheaper (a strike, not the run).
A VIP or a robber running out costs no strike: a VIP costs the streak, a robber the bonus.

**The HUD shows strikes as a driver rating** (Tyler, 2026-10-09): one gold star and a number under
the cash, starting at 5.0 and losing a whole star per strike (`RATING_START`, `ratingFor` in
fares.js). The run ends at 2.0 (`RATING_FLOOR`) with "Deactivated!", which is the same three misses
as before; the number goes red at 3.0. Packages and the burger run have no clock, so they cannot
cost a star. `?rating=off` brings back the three rings and "Three riders gave up on you."

## What the sweep found

`node tools/difficulty-sweep.mjs [cities] [preset]`, presets `pace`, `pressure`, `opening`, `ramp`,
`shipped`. Each variant is played by two perfect players at a 2s reaction: one who never boosts
(`cruise`) and one who holds Loco Mode while the job in hand would not make it at cruise (`loco`).
The loco player runs `sim/collisions.js`, so it can wreck.

Shipped, over 21 cities:

| | p10 | median | ended by | pace driven | picks with a choice |
|---|---|---|---|---|---|
| cruise | 8 | 9 | 21 strikes | 1.05 | 7% |
| loco | 11 | 12 | 20 strikes, 1 wreck | 0.96 | 10% |

(Before a rider aboard became a strike, the cruise player's p10 was 4 and median 8, with 9 of its 21
runs ended by a rider in the cab; the loco player's numbers barely moved.)

**The pace dial works, though less sharply since the in-cab strike.** A player who never touches the
pedal is done around the ninth fare; one who boosts when behind lasts to the twelfth. The old slack curve gave the never-boosting player
a median of 14 — Loco Mode was never needed.

**The pressure dial does not yet deliver choice.** Only about one kerbside pick in ten is made with
more than one rider waiting, at any pressure swept (0.5→1.0 through 0.5→1.8). A served-next clock
is about one trip long, and so is the spawn gap at full pressure, so the second rider tends to
expire or be served before a third appears. Pressure is currently producing *strikes* — riders who
appear while you are busy and are gone before you are free — more than it is producing decisions.
The levers for that are the open question, not more pressure.

**Holding Loco Mode everywhere is not a strategy.** A player who boosts at every chance drives a pace
of 0.41 on the runs it survives and wrecks on two runs in three. `LOCO_PACE_SELF` (0.8) is the pace
the probe holds `paceEnd` and `VIP_MIN_PACE` above.

**Re-measure before trusting a row.** A tuning table is a measurement, and it goes stale as the rest
of the build gets faster or slower to drive.

## Shifts

Four bands over the delivery count — 0, 3, 7, 12. They used to carry a payout multiplier each (1×,
1.25×, 1.5×, 2×); [the combo meter](gameplay.md#the-combo-meter) replaced it, so a shift is now only how hard
the city is. The ramp is otherwise invisible: clocks tighten, riders arrive closer together and the board grows, and
a player experiencing all three at once has no way to tell "the game got harder" from "I got worse".

| Shift | From |
|---|---|
| Early Shift | 0 |
| Busy | 3 |
| Rush Hour | 7 |
| Gridlock | 12 |

Deliberately **not** named after times of day: `daylight.js` runs the sky on its own clock, and a
"Night Shift" banner over a midday sky is two systems contradicting each other.

The opening shift is not announced — it is the state the run starts in, and a banner for it would be
announcing a change that hasn't happened. Same reason a fresh rider's diamond doesn't kick on spawn.

## The world half

Traffic density and police cadence ramp too, and both are pushed from `main.js` rather than read,
because `sim/` cannot import from `game/`.

**An InstancedMesh cannot be resized after construction.** The car and wheel pools are therefore
allocated for the curve's ceiling up front and gated with `mesh.count`, which costs one unused
matrix and colour per slot and nothing on screen. `traffic.setCarCount()` adds at most one car per
call, appends it so existing instance indices stay stable, and gives up quietly when the draw finds
nowhere legal — a saturated network just tries again next frame.

**It only ever grows.** Removing a car would mean deleting one out of the middle of the instance
buffer while the player watches. Arrivals land at least 50 units from the taxi; on a desktop the
whole city is in frame so nothing can truly spawn off-camera, but that does put it where the player
is not looking.

`?cars=N` overrides the density ramp outright, the way `?seed=` overrides a random city. The
headless tools pin their own count for the same reason: `soak.mjs`, `probe.mjs` and `signals.mjs`
all run at 7 cars, and their numbers are only comparable to each other at a fixed density.

## Gates

- `tools/probe.mjs` asserts pace never drops below `LOCO_PACE_SELF` (a clock tighter than the taxi
  can be driven is unwinnable by construction), that the opening is drivable without Loco Mode
  (`pace(0) > 1`) and drains faster than it fills (`pressure(0) < 1`), that the tutorial fare is
  alone, that a kerb miss is a strike and the third one ends the run, and that the clock floor does
  not swallow a median trip at full difficulty.
- `tools/eta.mjs` fails if the estimator's bias exceeds one block of driving or its MAE exceeds two.
- `tools/soak.mjs` gates the cruise player on a **band**, median 3..20.

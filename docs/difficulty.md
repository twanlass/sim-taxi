# Difficulty

`src/game/difficulty.js` owns the whole ramp: one scalar, and every knob hung off it. It is pure
and DOM-free, like `boost.js` and `urgency.js`, and it knows nothing about the sim — `sim/` must not
import from `game/`, so the two knobs that steer traffic and police are pushed *into* those systems
by `main.js`, the same way `traffic.taxi.boost` is.

```
d = clamp(delivered / RAMP_FARES, 0, 1)      // RAMP_FARES = 12
```

**Deliveries, not elapsed time.** A delivery is the player's own success, so the ramp self-adjusts
to skill: a quick player reaches the hard part sooner in wall-clock terms and a slow one gets more
room to find their feet. Ramping on the clock would lean hardest on the player already struggling,
and would make the escalation something that happens *to* you rather than something you earned.

| Knob | `d = 0` | `d = 1` | What it does |
|---|---|---|---|
| `slack` | 1.7× | 1.05× | Multiplier on the driving each fare costs. **The main lever.** |
| `maxFares` | 1 | 4 | Board size. Stepped at 1, 2 and 10 deliveries. |
| `spawnGap` | 15s | 7s | Seconds between spawns on a non-empty board. |
| `spawnRadius` | 3 blocks | whole map | How far from the bias point an extra may land. |
| `payoutMultiplier` | 1× | 2× | Stepped with the shift, stamped into `fare.value` at spawn. |
| `carCount` | 12 | 22 | Ambient traffic. Pushed into `sim/traffic.js`. |
| `policeCooldown` | 16–30s | 8–14s | Between corridor runs. Pushed into `sim/police.js`. |

`?d=0..1` pins the curve, and the ⚙️ panel has a slider for the same handle — the late game is
several minutes of play away otherwise, which makes the hard part of the game the awkward part to
look at or to tune. `?shot=11` renders a full four-fare board on the same mechanism.

## The clock is budgeted

This is the change everything else rests on.

```
budget = queue ahead + drive to the pickup + drive to the drop-off + reactionAllowance
limit  = clamp(budget × slack(delivered), clockFloor, clockCeiling)
```

Computed once, at spawn, and never revisited. A clock that grew because the board got busier would
be incoherent, and it would mean the player could earn time by dithering. It also means the newest
rider always holds the longest clock, so the board reads oldest-first — which is the order it wants
to be served in.

`estimateSeconds(route, fromDir)` in `route.js` is the conversion: `blocks × 3.28 + turns × 1.30`.
Both constants are **fitted, not derived** — `tools/eta.mjs` least-squares them against real
arrivals and `npm run check` runs it before the soak, because a drifted estimator makes every clock
in the game wrong in the same direction and nothing else would notice.

`chainSeconds` walks a list of stops carrying the heading forward rather than guessing it: the last
step of one leg's route *is* the direction the car arrives on, and `legalExits` forbids U-turns, so
planning the next leg from the wrong heading can cost or save a whole block.

### What was wrong with a flat 60 seconds

It made trip length the dominant source of difficulty, and none of it was under anyone's control.
`tools/soak.mjs` named it as its own biggest noise source: *"one corner-to-corner fare eats 40s
against a 17s average, and on some seeds even a perfect player loses the very first fare."*

Every fairness rule in `fares.js` existed to paper over that. Extras were held within 3 blocks of
the current drop-off because a flat clock could not pay for a distant one. Budgeting deletes the
noise, which is what turns difficulty from a dice roll into a dial — and it is what promotes the
spawn radius from a patch into a knob.

### The queue is the *whole* queue

The first version budgeted each rider as if they were next: the fare aboard, then this one. It was
measured and it was wrong.

Any expiry ends the run outright, so a board of two waiters where one is on an unmeetable clock is
not a choice, it is a countdown. It capped a perfect player at a median of **3–5 fares** no matter
which other knob moved — the survival curve was flat against the spawn gap, the board steps and the
slack alike, because none of them was the thing killing it.

So the chain covers everything the taxi must clear first: the rider aboard, then every waiting rider
by urgency, then the new arrival. Serving in the right order works; serving in the wrong order does
not. The puzzle survives as an *ordering* puzzle rather than a lottery, and slack squeezes how far
from the right order you can stray.

### The floor and ceiling are guards, not shapers

`clockFloor` 15s, `clockCeiling` 240s. If either is binding on an ordinary fare, the budget is what
needs fixing — and both earlier values were binding.

90s clipped ordinary late-game clocks, quietly reintroducing the unmeetable deadline the queue chain
exists to remove. 180s was subtler and worse: with a saturated board the median clock issued sat at
175s against the 180s cap, so `limit` was effectively `min(ceiling, work × slack)` with the ceiling
winning. Sweeping slack from 1.35 down to 1.05 then moved the median run length by less than a fare.
**A binding ceiling silently becomes the difficulty curve.**

The floor came down from 20 to 15 with the slack end, and it had to: a median 16.4s trip budgets
19.8s at slack 1.05, so 20 was about to become the clock every short late-game fare was issued.
`tools/probe.mjs` asserts that directly — **a floor is only ever tested against the tightest slack
on the curve**, so moving `slackEnd` means re-checking it.

## What the sweep found

`node tools/difficulty-sweep.mjs [runs] [preset]`, over N cities × 3 reaction times. Presets:
`slack`, `ramp`, `board`, `gap`, `shape`, `shipped`.

### Slack is what the player actually sees

Slack is not really a survival knob, it is **the fraction of the clock left at the drop-off**. A
fare served straight through eats its estimate and hands back `1 − 1/slack`, so 2.0 meant an on-time
delivery landed with half the ring lit — level 3, yellow — however the median said the game was
going. That is the reading the diamond gives the player every single fare, and it read generous.

| slack | remaining on an on-time drop-off | reads as |
|---|---|---|
| 2.0 | 50% | yellow |
| 1.7 | 41% | orange |
| 1.15 | 13% | red |
| 1.05 | 5% | red |

Swept over 21 cities × 2 reaction times, medians at 1.5s / 4s and the mean share of the clock the
drive ate at deliveries 1-3 / 12+:

| slack | 1.5s | 4s | spend 1-3 → 12+ | |
|---|---|---|---|---|
| 2.0 → 1.15 | 20 | 15 | 58% → 84% | was shipped; p10 12/11 |
| 1.7 → 1.10 | 15 | 11 | 65% → 85% | p10 11/4 |
| **1.7 → 1.05** | **14** | **11** | **64% → 87%** | shipped; p10 9/7 |
| 1.6 → 1.05 | 13 | 12 | 66% → 86% | a run died on fare 2 at 1.5s (p10 2) |

1.7 → 1.05 is the last row where nobody dies during the tutorial. Below it the tail starts eating
first-fare runs, which is the one failure a score-attack cannot have.

**Shortening the ramp is the wrong way to answer "too easy".** `difficulty-sweep.mjs 21 ramp` moves
`rampFares` 12 → 8, and both rows tried drop p10 to 2 at a 4s reaction — the curve lands on a player
who is still learning to read the board, which is exactly what ramping on deliveries rather than on
the clock exists to avoid. The end of the curve is the thing to move.

**Re-measure before trusting a row.** 2.0 → 1.15 was 15/13 when it shipped and 20/15 when it was
re-swept for this change: nothing touched `difficulty.js` in between, the rest of the build just got
faster to drive. A tuning table is a measurement, and it goes stale.

**Widening the spawn gap does not make the game easier.** Across 15→7 through 40→18 the median is
flat at 12–15 fares, but p10 falls from 7–12 down to 1–6. A sparse board means short queues, short
queues mean short budgeted clocks, and a short clock has less absolute margin to absorb one bad set
of lights. The stagger shapes how the board *reads*; it is not the difficulty.

**Reaction time barely separates players any more**, and that is a real finding rather than a
target that was hit. 1.5s and 4s land within two fares of each other. With the drop-off dispatching
itself, a fare costs exactly one reaction — and 2.5s of it is small against a chain of 90s or more.
The original target of 6–8 fares at 4s assumed a much steeper penalty and the data does not support
it.

## Shifts

Four bands over the delivery count — 0, 3, 7, 12 — each with a payout multiplier, reflected in the
[multiplier counter](gameplay.md#the-multiplier-counter) on the delivery that crosses into it. The
ramp is otherwise invisible: clocks tighten, riders arrive closer together and the board grows, and
a player experiencing all three at once has no way to tell "the game got harder" from "I got worse".

| Shift | From | Pays |
|---|---|---|
| Early Shift | 0 | 1× |
| Busy | 3 | 1.25× |
| Rush Hour | 7 | 1.5× |
| Gridlock | 12 | 2× |

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

- `tools/probe.mjs` asserts slack never drops below 1.0 anywhere on the curve (a deadline shorter
  than its own driving is unwinnable by construction), that the board cap grows one rider at a time,
  that the board never runs ahead of the curve, and that every fare spawns with a clock covering its
  own chain.
- `tools/eta.mjs` fails if the estimator's bias exceeds one block of driving or its MAE exceeds two.
- `tools/soak.mjs` gates on a **band**, median 3..20. A difficulty system fails by being too easy
  exactly as readily as by being too hard, and only one of those used to be caught.

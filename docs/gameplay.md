# Gameplay

## The opening tutorial

`src/game/tutorial.js`, with its markup and styling in `index.html` under `#coach`. A white speech
bubble in the bottom centre with the player's own taxi turning beside the text, tail on top pointing
up at whatever it is talking about, and the line typing itself out. **Three beats, and that is all
of it:**

1. **"Let's pick up some rides and earn some cash."** The camera follows the taxi while it types and
   a spotlight picks it out of a darkened city. The one thing a new player cannot work out by
   looking is which of the hundred cars down there is theirs — so the car itself says it, and both
   the camera and the light land on it.
2. **"Tap rider to start."** The spotlight moves to the waiting fare as the camera sets off for
   them, so the light is already on the rider and the pan carries the player to it; the bubble comes
   back once the camera has arrived. Tapping the rider answers it directly.
3. **"Hold to floor it"** — the Loco Mode pill, three seconds after the rider is tapped, with the
   bubble sitting directly over the pill and its tail pointing down at it, the spotlight on the pill
   and the pill pulsing under it. Skipped entirely if the player has already fired Loco Mode.

A beat of city comes first: `OPENING_HOLD` of traffic moving with nothing on screen, because a run
that opens mid-sentence gives the player nothing to attach the sentence to, and the lights coming
down after it lands as an event rather than as the initial state. The clocks are already held
through it, so it costs nothing. The camera is already easing onto the taxi during it — that is the
one thing that should be under way before the bubble speaks.

**A tap anywhere advances**, not just a tap on the bubble. The listener is on `window` rather than a
full-screen catcher, so the tap still reaches the city underneath — on the second beat the whole
lesson is the tap landing on the rider, and an overlay would eat the one gesture being taught. It
shares the picker's `didPan()` guard, so a swipe that dragged the map is not also an answer.

The avatar is the real `createTaxiMesh()` in its own small WebGL context, the way each rider-finder
chip owns one — so the car in the bubble is the car on the road and cannot drift out of step when
the taxi is restyled. It is viewed down the game's own `VIEW_DIR`, lit by the city's own sun and
hemisphere fill (mirrored per frame, so turning the day/night cycle on carries into the bubble), and
framed on the cylinder the car sweeps as it turns so nothing clips at any angle of the spin.

### The spotlight

A single `#spotlight` div: two radial gradients centred on the subject, a warm core over a darkening
wash. Not a three.js `SpotLight` — that would mean turning down the scene's own sun and re-lighting
one patch of a city built around a single global key, which is a rendering change to carry a
two-sentence lesson. This costs one composited element.

Both radii are sized in **world units** and converted per frame, because 1 world unit is only
~7.7px at play zoom and a pool measured in pixels would be a different size on every viewport (and
wrong the moment anything moves the zoom). The clear centre is 6 units — the subject and the kerb it
stands on, no more. At half again as wide it lit most of a 5×5 city and read as general gloom rather
than as a light pointed at one thing.

The third beat is the exception: it points at a **control**, which is a fixed thing on the glass at a
size that has nothing to do with the camera, so its pool is measured off the Loco Mode pill's own
box instead. Sizing that one in world units would grow and shrink the pool around a button that
never moved. Its falloff is proportionally wider than the world one, because a corner control
spends half its falloff off the edge of the glass.

The warm core matters more than it looks: the darkening alone left the subject merely *not dimmed*,
which at this contrast is not the same as lit.

### The HUD arrives afterwards

The money counter, the [multiplier counter](#the-multiplier-counter), the Loco Mode pill and the
rider chips all start off their own screen edge and slide in together the moment the last bubble is
dismissed. A run used to open
with all four already lit, every one of them reading zero and answering a question nobody had asked
yet. `main.js` adds `body.hud-ready`; with no tutorial to wait for (`?tutorial=off`, shot mode) they
are simply there from the first frame.

The offset is the standalone `translate` property, **not** a transform. Three of those four already
animate their own transform — the money bump, the streak bump, the Loco Mode press dip and its
top-up flutter — and a `body.hud-ready #boost { transform: none }` outranks `#boost:active` on
specificity, which would quietly kill the press feedback for the rest of the run.

Nothing else is taught. The drop-off [dispatches itself](#the-drop-off-dispatches-itself) and the
clock is [a coloured crystal over a head](#the-fares-clock-travels) — neither needs a sentence, and
every extra beat is one more thing between the player and the game.

### The third beat is not like the other two

The first two stand in front of the game: the clocks are held, the camera is theirs, and each waits
to be answered. The third runs *alongside* a live run — the player is driving, the clocks are
counting — so it gates nothing, holds nothing, and times itself out after
`BOOST_HINT_LINGER` rather than sitting over the road until someone taps it. Pressing Punch It
dismisses it too, since doing the thing it asks for answers it. (That call is explicit rather than
left to the window tap handler: `pressBoost` calls `preventDefault`, which can suppress the click a
touch would otherwise synthesise, so on a phone the hint would outstay its own lesson.)

It is also the only one that points at a **control** rather than at the city, so it is placed
differently: `#coach.at-boost` drops it onto the Loco Mode pill's own 26px gutter just above the
pill, flips the tail to the bottom, and grows the entrance upward out of it. The other two hang
centred with the tail up, because what they are talking about is up there.

**It fires on a fixed delay off the rider tap, not on trip progress.** The first version was a
fraction of the trip — half way to the pickup, measured as road actually driven against the trip's
block distance, both of which were corrections for the *straight-line distance remaining* that
came before them. All of that was a better description of the moment and unpredictable in practice:
trip lengths vary by a factor of five, so the hint landed anywhere between three seconds and half a
minute in, and on the long ones the player had stopped wondering about the pill long before it
arrived. `BOOST_HINT_DELAY` off the one action every run shares is the thing that can be tuned.

The countdown runs from the tap, not from the tutorial finishing getting out of the way — on a
desktop those differ by the restore glide, which is the tutorial's own business and should not be
charged to the delay. And it only runs once a ride is actually under way, so a player who dismissed
the second bubble without picking anyone gets the hint on whichever drive they do start.

**And it never appears if Loco Mode has already been fired.** `main.js` sets `locoUsed` on the
transition into boost — `kickLocoMode`, which by construction runs exactly once per press-from-rest
— and the tutorial reads it at the moment the delay elapses. Explaining a control the player is
mid-way through using is worse than saying nothing.

### It does not spend the player's clock

`fares.setPaused` holds every fare's countdown through the two gated beats. Only the countdown: fares
still spawn, riders still wave, diamonds still bob, and the city carries on behind the bubble. A
tutorial that taught you how to pick someone up out of the clock you need to *deliver* them would be
charging for its own lesson.

That got sharper when the clock stopped being flat. A rider's deadline is now
[budgeted from the driving their trip costs](#the-clock-is-budgeted) — it is margin sized for the
road rather than a round sixty seconds with slack to spare, so a lesson spent out of it comes
straight off the part the player needs. `state.elapsed` is deliberately *not* paused: it drives the
spawn stagger and the marker animations, neither of which is the player's to pay for. The spawn toast is suppressed for the same reason — the first
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

### It only runs once

**A player sees it on their first run and never again.** Play again on the run-end screen is a
`location.reload()`, and a run ends in a wreck or a bust often enough that the reload is the usual
way back into the game — so an opening that replayed every time would be a toll charged on each
retry for a lesson learned once. Which car is yours and that a rider is a thing you tap are two
facts; they do not need re-teaching on the fifth wreck of the evening.

Because the retry is a page load, the flag has to outlive one: `hasSeenTutorial()` /
`markTutorialSeen()` in `tutorial.js` keep it in `localStorage` under `simtaxi.tutorialSeen`. Both
are wrapped in a `try`, because `localStorage` **throws** rather than no-ops where it is unavailable
— Safari with cookies blocked, an iframe with third-party storage partitioned off — and it is the
property access itself that throws, not just the call. A player whose storage is broken gets the
tutorial every run, which is what everyone got before it was remembered at all. `npm run check`
drives all three states (no storage, a throwing one, a working one) against the real module.

It is marked seen in `finish()` — the moment both gated beats are answered, or the player dispatches
the taxi themselves and does beat two unprompted. Not at the start, which would spend the one
showing on a run nobody watched, and not in `end()`, which would spend it on a run that ended
mid-sentence.

`?tutorial=off` skips the whole thing and `?tutorial=on` forces it back after it has been seen —
otherwise iterating on it means clearing site data between runs. Shot mode never runs it: a
screenshot has nobody to teach, and the bubble would be the loudest thing in every frame.

## The fare loop

`src/game/fares.js`. Each fare is its own little machine — `waiting → riding → gone` — carrying its
own clock, its rider, its drop-off and the one marker that travels between them. The board holds
between one and four at once depending on how far into the run you are ([Difficulty](difficulty.md)),
and because the taxi has one seat, all but one of those are riders waiting on the kerb.

1. A passenger spawns at a random intersection (never the one the taxi is already about to reach)
   with a **clock budgeted from the driving their trip costs** — see
   [The clock is budgeted](#the-clock-is-budgeted) — and a
   [diamond](#the-fares-clock-travels) over their head, coloured by how much of that clock
   is left. The whole trip is drawn now; none of it is shown until they board — see
   [Neither how far nor where](#neither-how-far-nor-where).
2. Tap them → the taxi routes there.
3. On arrival the passenger boards, their diamond flies from the kerb to the roof of the taxi, a
   teal ring appears on the road where they're going, and the taxi **drives straight on to it** —
   because the instruction it used to ask for is now given for you. See
   [The drop-off dispatches itself](#the-drop-off-dispatches-itself).
4. Deliver → the fare pays out (`FARE_BASE + FARE_PER_BLOCK × blocks`, times the shift's
   multiplier, see [Economy](#economy)), and the board refills.
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

Rules for when the extras appear. Everything in the first group is a point on the
[difficulty curve](difficulty.md) rather than a constant:

| Rule | Early | Late | Why |
|---|---|---|---|
| `maxFares` | 1 fare | 4 fares | Second at 1 delivery, third at 2, fourth at 10. The first fare teaches the loop with nothing else on screen; the fourth is an endgame beat, well past where two clocks stopped being novel. |
| `spawnGap` | 15s | 7s | Extras arrive one at a time. Spawning them together gives one hard moment then a lull; staggering makes each clock a decision. Tightening it is pressure with no extra clutter. |
| `spawnRadius` | 3 blocks | whole map | How far from the bias point an extra may land. Used to be a fairness patch — see below. |
| `slack` | 2.0× | 1.15× | The margin on top of the driving each fare costs. The main lever. |

And the ones that are still fixed, shaping the "second fare while carrying" hand-off:

| Rule | Value | Why |
|---|---|---|
| `SECOND_FARE_DELAY` | 5s aboard | A pickup and a spawn are never the same event. |
| `SECOND_FARE_RANGE` | 45 units | When someone is aboard and closing on their drop-off, the new rider appears near it. |
| `SECOND_FARE_MIN_CLOCK` | 18s | No rider flashes into existence a few seconds before an unrelated timer ends the run. |

The bias rules shape where an extra rider lands relative to the taxi. When someone is aboard and
closing on their drop-off, the new rider appears near that drop-off — the classic "second fare
while carrying" hand-off. When nobody is aboard, the extra lands near the taxi's current
intersection instead. Either way the radius is the same, so the two paths read alike.

**`spawnRadius` builds a box, not a true block-distance circle** — it walks `±radius` on each axis
independently, so a corner of that box can sit up to `2 × radius` blocks out on the diagonal. Fine
for an ordinary extra, where the point is "reachable", not "exactly this close". The very first
fare of the run wants a real promise, though — especially now that the taxi itself
[opens downtown](traffic.md#the-one-routing-branch) rather than at a random corner, where the box
can span the whole map even at `radius = 3`. `FIRST_FARE_MAX_BLOCKS` in `fares.js` filters that
one draw by actual Manhattan distance, capped at 3, independent of the difficulty curve — so the
rider taught in the tutorial is never more than a short drive from where the taxi started, whatever
`spawnRadiusStart` happens to be tuned to.

**The radius used to be load-bearing and is now a difficulty knob.** Under the old flat clock an
extra rider *had* to land near the current drop-off: their 60 seconds had to cover the tail of that
delivery plus a fresh pickup drive, and charging them for a whole drop-off leg was ruinous —
measured 7-fare median → 3 at 1.5s reaction. A rider dropped in the far corner had a clock the taxi
could not possibly reach in time, which turned "prioritise" into "roll the dice". Budgeted clocks
pay for the distance explicitly, so the radius is free to open all the way up as the run goes on.

`spawnGap` is what turns the board into a prioritisation puzzle rather than a burst: extras land
staggered, so their kerbside clocks drain out of phase and the player has to keep picking which to
serve. `tools/probe.mjs` asserts both the peak (>= 2 waiting), the minimum spacing between spawns,
and that the board never runs ahead of the curve.

Widening the stagger, incidentally, does not make the game easier — it makes the *opening* more
fragile. See [difficulty.md](difficulty.md#what-the-sweep-found).

The rider *figure* is still white whatever else is on the board — see
[The taxi's roof sign](#the-taxis-roof-sign) — so every waiting rider reads the same way, with the
diamond over their head carrying how close each one is to giving up.

### The clock is budgeted

One deadline covers **spawn to drop-off**, and it does not reset at pickup. Collecting a rider
quickly is what buys the time to deliver them, and that is the entire tension of the game.

It is not a flat number. A rider's clock is the *estimated driving their trip costs*, plus whatever
the taxi is already committed to, times the run's current slack:

```
budget = queue ahead + drive to the pickup + drive to the drop-off + reaction allowance
limit  = clamp(budget × slack(deliveries), 20s, 240s)
```

`estimateSeconds` in `route.js` does the conversion at 3.28 s/block and 1.30 s/turn, fitted against
581 real trips. The whole design, what it replaced and how the numbers were chosen is in
[difficulty.md](difficulty.md).

Two consequences worth knowing here:

- **Urgency is proportional, not absolute.** A green diamond no longer means "lots of seconds", it
  means "you are on schedule for this rider" — which is the decision. `fares.waiting()` ranks by
  the same fraction, so the finder chip and the rider's own diamond never disagree about who is
  next. The panic pulse below 5s stays absolute, because "about to lose this" is true regardless of
  budget.
- **A long haul no longer punishes itself.** It gets proportionally more time. The cost of driving
  one is that *everyone else's clock keeps draining while you do* — opportunity cost against the
  queue rather than self-harm.

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

There is one taxi, so `markDirected` also clears the flag on whatever fare held it before: tapping
a second waiting rider re-routes the car and moves `directed` to that rider, rather than leaving
the abandoned one still marked. Without that, the abandoned rider stayed armed — if the new route
happened to pass within `ARRIVE_RADIUS` of its corner, it resolved a pickup too, and the taxi ended
up "carrying" two riders off a single seat.

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
→ orange → red, [by level](#urgency-is-one-scale) — and [draining like a
glass](#the-crystal-is-a-glass-of-time) between those steps. The instant they get in it **flies to the taxi**
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

The ring was the finer instrument, and losing it was a real cost. It drained *continuously*: a
`setDrawRange` sweep clockwise from screen-top over 96 segments, so the arc's length was the time
left, and a player could see a clock at 40% rather than at "orange". The diamond had four steps, and
on the riding leg that was strictly less information. [The liquid](#the-crystal-is-a-glass-of-time)
is that reading coming back on the shape that was already carrying the deadline.

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

### The crystal is a glass of time

`src/geometry/diamond.js`. The diamond is a **vessel**, and the clock is the liquid in it. Below the
surface the urgency colour is opaque, saturated and self-lit — exactly what the whole crystal used
to be. Above it the same hue is emptied glass: the city visible straight through it at just under
half alpha, most of the emissive lift gone, and a sheen on the facets turned edge-on to the camera.
A pale band rides the line between them, and that band is the part the eye actually reads.

So the two hands of the clock are on one object. The **colour** steps in quarters and kicks, which
is the alarm; the **level** moves every frame, which is where inside that quarter the fare actually
is. Green isn't one state any more — a fresh rider is a solid crystal and a rider a breath away
from yellow is a crystal two thirds full. It is the [ring's continuous
sweep](#it-used-to-be-a-relay) recovered without a second object to learn.

The level is **linear in height**, not in volume. Volume would be the physical answer and it reads
much worse: an octahedron is widest at its equator, so a volume-true drain spends the middle half of
the clock inside the middle 20% of the body. The player reads where the line *is*, so equal time has
to be equal travel. Both ends overshoot the tips slightly, which is what makes a full fare a plain
solid crystal and a dead one a plain empty vessel, with no highlight stranded on a vertex.

It is **one mesh with a per-fragment alpha**, split in the fragment shader — same silhouette, one
draw call, and the bounce, the kick and the pulse keep animating a single object. The cut is in the
geometry's **local Y**, so the liquid rides in the vessel instead of sloshing when the marker hops.

### Getting the empty half to look empty

The first build was opaque: the hue at half lightness above the line. It read as a **dark solid**,
not as an empty vessel, which is the whole point of the thing.

What stood in the way of real transparency is the **black inverted hull**. It is a larger octahedron
drawn back-faces-only, so its far faces cover the entire silhouette — glass over it shows a black
void rather than the city. The fix turned out to be draw order rather than a different outline:

> The crystal draws first (`renderOrder` 8) and **writes depth**, blending over the finished opaque
> scene. Then the hull draws (9) with the depth test on. Inside the silhouette its back faces are
> behind the glass and fail the test; the ring between the two silhouettes has nothing in front of
> it and passes. That ring is exactly the rim. Both are flagged `transparent` only to land in the
> same queue, which is the one place `renderOrder` decides anything — well clear of the [ghost
> outlines](rendering.md#taxi-ghost-outline--geometryghostoutlinejs) at 9990+, which already treated
> this marker as an occluder back when it was opaque.

`depthWrite` staying **on** for a transparent material is the load-bearing part, and it is the
opposite of the usual habit.

Three numbers were measured and moved:

- The empty glass was **desaturated** at first (`s × 0.55`), and the empty half of a nearly-dead
  marker came out a dusty rose — the most urgent state on the scale rendering as the least red thing
  on the board. It keeps 90% of its saturation now, and alpha does the emptying rather than the
  tint, which is what glass and liquid actually differ by.
- The **sheen exponent** went from 2.5 to 5. At 2.5 it was not a highlight but a wash: an octahedron
  at this camera angle shows almost nothing head-on, so every visible facet picked up most of the
  lift.
- The **emissive** above the line holds at 0.6 before alpha takes its share, so about 0.2 of the
  liquid's reaches the frame. At 0.22 opaque the shape survived after dark but a nearly-drained
  rider was genuinely hard to find on a night board.

### The far wall, and why it isn't there

Only the **near** half of the liquid's surface is drawn, and the near half of a horizontal plane
projects low — so at half full the level reads closer to a third. Drawing the back faces as a second
pass closes that chevron into the rhombus a real meniscus makes, centred on the level the clock
actually says. It was built, and taken out again.

It cost more than it bought. The far wall's liquid is a solid slab filling everything below its own
(higher) surface line, so the see-through top — the entire point of the vessel — shrank to the
narrow wedge above it, and the two meniscus bands closed into a hard bright rectangle across the
middle that read as a label rather than as liquid. More correct, less legible.

What is left is a known bias: the surface reads slightly low, by a chevron about 8px deep at play
zoom. It is the same shape at every level, so it offsets the reading rather than distorting it, and
the chevron's outer corners — where it meets the silhouette — sit at the true level anyway.

> **Trap.** A patched material needs `customProgramCacheKey`. Three builds the program cache key
> from the material's parameters *before* `onBeforeCompile` runs, so a patched Lambert material
> collides with every unpatched one sharing those parameters and `acquireProgram` hands back
> whichever compiled first. This city is full of flat-shaded Lambert: the diamond drew with a
> building's program, and the fill went missing with nothing logged anywhere.

> **Trap.** Under `flatShading` three takes the normal from the screen-space derivative of the view
> position, which follows the triangle's *rendered* winding — so on back faces it points into the
> screen and the surface lights as if the sun were behind it. Three's own `FLIP_SIDED` never reaches
> this path; it only fixes the interpolated-normal one. `patchFill`'s `flipped` argument is what the
> far-wall experiment left behind, and any back-face pass on this shape will need it.

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

### The multiplier counter

`N×` at top-right, opposite the money counter, and on screen from the first frame reading `1×` —
same as the money counter starting at `$0`. An empty corner gives the player nothing to aim at; the
visible number states the goal. `updateStreak()` in `main.js` bumps it in the taxi's own yellow (not
cash green, so it doesn't read as a second money event) on every delivery, the first one included.
No flight off the taxi the way the payout gets one; the multiplier isn't travelling from anywhere.
It lives outside `#hud`, so shot mode hides it with its own rule rather than inheriting `#hud`'s.

**It is a real multiplier now.** It used to show `fares.state.delivered` and call itself a streak,
which made the `×` decoration: the same number the run-end screen printed as "Fares", wearing a
symbol for an economy that did not exist. It now shows `difficulty.payoutMultiplier`, the multiple
every fare's price is actually stamped with at spawn, and it steps on the same beat as the
[shift toast](difficulty.md#shifts) that explains why. The bump still fires on every delivery even
when the number holds — the bump means "that one counted", the number means "and this is what they
are worth now".

### Priced by the trip

Each fare is priced by **trip distance**, not a flat rate: `FARE_BASE + FARE_PER_BLOCK × blocks`,
where `blocks` is the Manhattan distance between the pickup and drop-off intersections. The
price is fixed at spawn — the moment both endpoints are known — and stamped on the fare so a
long haul that runs into traffic pays the same as one that flies through green lights. Metering
during the trip would double-count the clock and reward Loco Mode for the wrong reasons.

The player does not see that distance before choosing — a bar over the rider's head used to
advertise a tier of it, and went with the meter (see
[Neither how far nor where](#neither-how-far-nor-where)). So the price is a fact about the trip
rather than a term in the decision.

What a long haul costs the player is no longer the clock it eats — the clock is
[budgeted from the trip](#the-clock-is-budgeted), so a long one gets proportionally more time. It
costs the *queue*: every other rider's clock drains while you drive it. Paying more for it is the
game being fair about that afterwards, exactly as before; only the mechanism it is fair about has
changed.

**The shift multiplier is stamped in at the same moment**, for the same reason — the price is
settled when the trip is. A rider who appeared during Rush Hour is worth Rush Hour money whenever
they happen to get delivered, and the table above is the 1× column.

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

## VIP pickups

`src/game/fares.js` and `src/game/faremarker.js`. A rare rider layered on top of the ordinary
board — their diamond and its ground disc open on a fixed purple, never drawn from the urgency
scale, so "this one is a VIP" is never confused with how much time they have left. The
rider-finder chip agrees: a VIP's countdown ring wears the same purple instead of the ordinary
green-to-red scale.

Everything about a VIP is the ordinary fare loop with three numbers turned:

- **A short clock.** Budgeted the same way as everyone else's — from the driving the trip actually
  costs — but at a fraction of the run's own slack (`VIP_SLACK_FACTOR = 0.7`) rather than the ramp's
  own. Never below `VIP_MIN_SLACK`, so it stays exactly as winnable as an ordinary fare: `tools/
  probe.mjs` asserts every fare's clock covers its own work, VIPs included.
- **A streak multiplier on the payout.** A VIP pays the ordinary distance price times the current
  shift multiplier, same as anyone — and then again by the player's *VIP streak*: how many VIPs
  have been delivered back to back, plus one for the delivery in progress. Stamped at spawn like
  every other price on the board, so the marker's fixed purple says what this one is worth the
  moment it appears rather than leaving it to be found out on delivery. A miss resets the streak to
  zero — the whole tension of stacking VIPs is that one late drop-off gives it all back.
- **A full tank on delivery**, rather than the ordinary third. `main.js` reads the boost meter's
  current fraction at the moment the delivery's energy bits land and tops up exactly what's missing,
  so a VIP always leaves Loco Mode topped off regardless of what was left in the tank going in.

**Missing one is not a run-ending event.** Every ordinary fare's clock hitting zero ends the run —
that is the entire tension of the fare loop. A VIP is the one exception: its clock running out just
clears it off the board the way a delivery would, resets the streak, and the run carries on. It is
pure upside by construction: taking one on can only make a run better, never worse, which is what
lets it stay optional without ever being a trap.

Rare on purpose — a cooldown (`VIP_COOLDOWN`) plus a per-opportunity chance (`VIP_CHANCE`), checked
only when the board is about to refill and no other VIP is already on it. Both are tuned against
the fare soak (`tools/soak.mjs`): frequent enough to be a real event, not so frequent that
forgiving misses meaningfully padded the survival curve. Never on the tutorial fare
(`VIP_MIN_DELIVERED`) — nothing on the board yet for a purple diamond to be distinguished *from*.

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

That release path cuts both ways, which is why the pill is `touch-action: none` rather than
`manipulation`. `manipulation` only drops double-tap zoom — pan and pinch stay live, and either
one starting on the pill lets the browser claim the touch and fire `pointercancel`, releasing a
boost the player still has their thumb on. Pointer capture then means nothing else arrives until
they lift and press again, so it reads as the gas cutting out with no way to get it back. The
case that hits it is exactly how this game is held: a thumb on the pill and a second finger
tapping a fare is a pinch gesture as far as the browser is concerned. `preventDefault` on
`pointerdown` is explicitly not a fix for that — `touch-action` is the only thing that suppresses
it, which is why the canvas has carried `none` all along.

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
| **Overfill** | The bar runs ~4.5% of a tank past its new mark, then rings back down onto it | `--pct` |
| **Flutter** | The whole pill throbs — glow and 3.5% of scale together, 4Hz — for as long as fuel is arriving | `--fill` × `--pulse` → `.is-filling` |
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
*arrived* rather than *settled*. The peak now releases into a decaying cosine (4Hz, e-folding at 8/s)
so it dips under the mark, comes back over it smaller, and converges: off a 4.5% overshoot the swings
measure **-1.7%, +0.6%, -0.2%**, then it snaps to the real level once the ring is under a fifth of a
pixel, about 0.43s in. This is the spring the scripted kick doesn't get for free. Both the overshoot
and the decay were pulled back from an original 7%/7-per-second pass that read as too bouncy.

The flutter runs at 4Hz, halved from an original 8Hz. At 8Hz a pour that landed several energy
circles at once stacked up enough pulses to read as chaotic rather than lively; one clear pulse
where there used to be two reads calmer without dropping all the way to the 5Hz "breathing" rate
that was tried and rejected earlier. It moves the pill itself, not just the glow, which is what
makes it visible at the edge of vision — where this button is while the player is watching the
road. `prefers-reduced-motion` drops the scale and keeps the glow and the edge.

The glow used to be a one-shot green flash matching the flying `$20`. Green read as *money*, which
is what the earnings pop already says; yellow says *this is boost*. Driving its alpha from a variable
rather than a keyframe is also what lets it fade out cleanly however long the pour ran, instead of
snapping off when a fixed-length animation ends.

While active the taxi runs at 2.2× speed, forces its next junction green, doesn't slow for
corners, lays **skid marks** off the line and through turns, and kicks up **dust**. See
[rendering.md](rendering.md#effects) for how those two are drawn.

**And it overtakes.** A slower car in front on a straight road is no longer something to sit
behind: **keep holding the button and the taxi pulls a full lane into the oncoming side, goes
past, and comes back.** Letting go is the abort — it tucks in behind instead. So the button stops
being a throttle at exactly the moment it gets interesting and becomes a question: is that lane
clear enough, and is that car about to turn across you? Nothing protects you either way. Collision
detection is armed for the whole of Loco Mode, so an oncoming car is the run. It buys real speed —
time stuck behind traffic drops from 10.4% of boosting to 4.5% — and the numbers, the geometry and
the reason an earlier version of this was abandoned are all in
[traffic.md](traffic.md#overtaking).

It will not pull out around a car that is already turning across the lane it wants, or into
oncoming traffic that is already in sight. Both of those are collisions the player could not have
seen coming, and without those two gates a third of all overtakes ended in one. What is left is
what you *can* read: a car arriving in the oncoming lane while you are out there, cross traffic at
a junction you are running, and a car turning out of the far lane.

**And it does not stop.** Not for a full exit lane, not for a car stranded in the box, not to
yield on a left — the three ambient courtesies that could still bring it to a halt at a junction
its priority hold had already turned green. Driving into a junction with something in it ends the
run instead, because collision detection is armed for exactly as long as the mode is. That is the
bargain: the only thing between you and a wreck is what you can see coming, and the button is the
only brake. See [traffic.md](traffic.md#nothing-stops-the-taxi) for the mechanism and the numbers
— it turns out to be *faster* than letting it yield, and it barely moves the crash rate, because
the holds were rare enough to cost the mode its feel without protecting it.

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
reason, four stats, and **Play again**. The title is set by the caller, so a timeout reads
**Too Slow!**, a collision reads **Wrecked!**, and a police bust reads **Busted!**.

It is a **full-screen blackout**, not a modal over the city. An earlier pass dimmed the world and
floated a blurred card on top of it, and the card's edges turned out to be the loudest thing on the
screen. Blacking the whole viewport out puts the run's numbers on nothing at all, which is what
makes them the ending rather than an overlay on one.

"Shift" replaced a row called "Streak" that printed `s.delivered` — the same number as "Fares"
directly above it, formatted with an `x`. Two rows counting out one number is a stat sheet padding
itself; how deep into the ramp a run got is a genuinely different fact about it, and it is the one
the multiplier was earned by. It rolls up through the shift names the run passed through, which is
what the counter does with every other stat.

The stats are **one row each, label and value side by side**, and both are set in the *same* size,
weight and colour. A small grey caption over a big yellow number made the label read as chrome and
the number as the content, when the pairing is the content; matched type makes each row one phrase
— "Fares  9" — and the rows read as a list being counted out, which is what the stagger is
doing.

It reads as a **ledger**: label pinned to the left edge, value to the right, on a `1fr auto` grid
so the label column takes the slack and the values stay flush right however long the names get.
Both edges are then straight lines down the block, which is what lets rows of identically
styled text read as separate stats — centring each row on its own left the list ragged.
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
whole (a landscape phone runs it past the fold) and width for the rows (the longest, `"Shift  Early
Shift"`, is the one `nowrap` risks pushing off a 320px screen rather than wrapping it). If it still
doesn't fit, the overlay scrolls — centred by `margin: auto` on the content rather than
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
pass overlapped the rows on a 165ms stride, and with several of them counting simultaneously the
block read as one animation with numbers moving inside it — you watched the screen rather than any
single figure. `STAT_STRIDE` is now *derived*: `ROW_MS + ROW_GAP`, where `ROW_MS` is a row's own beat
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
| Time | `fares.state.elapsed` | seconds, shown as `m:ss` + trailing `s` (e.g. `1:03s`) |
| Fares | `fares.state.delivered` | |
| Shift | `difficulty.shiftFor(delivered)` | how far up the ramp the run got, counted out by name |
| Cash | `fares.state.money` | |

Red Lights and Top Speed used to round out the list, tracked in `traffic.stats` purely so the card
had something to show — nothing in the sim itself read either counter. Both the tracking (including
the per-car `heldKey` dedup that kept a held red from counting once per frame) and the `speedMph()`
conversion were removed along with the rows.
Nothing in the simulation uses the conversion; it exists so the stat is in a unit a player has a
feel for.

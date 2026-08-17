# Gameplay

## The opening vignette

`src/game/opening.js`, over the depot in [city/garage.js](city.md#the-depot-block). A run does not
start with the taxi already in traffic. The camera comes down onto a garage door, the door rolls up,
the player's car drives out of it, bumps down the kerb into the street, and the camera pulls back
out to the game.

**PROTOTYPE.** It works end to end and the numbers below are the ones it shipped with, but three
things are hard-coded that a finished version would probably decide per city — see
[the depot block](city.md#the-depot-block) for why each is the way it is: the door always faces
**+X**, the depot always takes a **whole block**, and the exit is always a **right turn** into the
near lane.

### The beats

| Phase | What happens | Length |
|---|---|---|
| `wait` | The city's own [entrance wave](rendering.md) is still running. The taxi is already in the garage by now, so the wave spreads out from the depot — the building the camera is about to go to | until the wave lands |
| `approach` | `focusOn` eases target and zoom together onto the door, from the play framing at zoom 52 down to **15** | ~1.4s, capped at 1.9 |
| `settle` | A beat on the shut door, so arriving and the door moving read as two events | 0.12s |
| `door` | The curtain winds up on an ease-*out* — a roller door leaves fast under its counterweight and creeps the last few inches | 0.95s |
| `reveal` | The car sitting in a lit doorway. This is the shot | 0.35s |
| `roll` | Out of the bay, across the forecourt, down the kerb, right into the lane. The zoom starts widening as the nose clears the door, so the pull-back is already under way; the **shutter starts coming back down** the moment the car reaches the kerb | ~2.7s |
| `release` | `focusOn` back to whatever framing the run would have had — the city's centre on a desktop, the taxi on a phone, where the opening follow-cam picks it up | ~1.3s, capped at 2.0 |

The door comes down over 1.4s, slower than it went up — that is what a roller door does, leaving
under its counterweight and returning under a motor, and it is scenery by then rather than the
subject. It runs on its own clock rather than the phase's, so it keeps closing through `release`
after `roll` has stopped being called, and `finish` lands it shut. **Shut is the resting state** a
run is played in: the car is out and the depot closed up behind it, which is what shot mode sets too.

Both eased legs normally retire on **arrival** rather than on their cap, and the caps sit just past
where that happens: they are a backstop against a resize or a device dropping frames, not the thing
that sets the pace. The approach's rate came up from 1.7 to 2.4 for the same reason the `settle`
beat came down from 0.3 — the tail of an exponential is the part nobody is watching, and at 1.7 the
last third of a second was the frame creeping the final 2% of a zoom with the door sitting there
shut.

Then the tutorial starts. The three openers **queue on one guard**: the city builds itself, the taxi
comes out of its garage, and only then does anything start talking. `isBlocked` in `main.js` chains
them, and the fare loop is held for the whole of it — see [the board waits](#the-board-waits) below.

### Where the taxi parks

Its nose sits `NOSE_BEHIND` = 0.25 units back from the shut curtain, and the number that matters is
what that is measured from: **`TAXI_TAILPIPE_BACK`, half the *drawn* car**. The taxi group wears
`TAXI_SCALE` = 1.18, so the body on screen is 4.01 units long where `CAR_LEN` says 3.4 — and parking
it by half of `CAR_LEN` put the nose a third of a unit *through* the closed door, as a yellow
rectangle stamped across the middle of the shutter. The bay is sized off the same number: 5.2 deep,
which is the car plus the recess plus somewhere for the back bumper. The probe asserts both ends.

The back half of the body is hidden behind the +Z jamb at this camera, and no width of opening
changes that — the sightline gains a unit of z for every unit of x, so it walks out of the doorway
before it clears the bay. That is the shot rather than a limitation of it: a nose in a lit doorway.

### The taxi is out of the traffic model for the whole of it

It has to be. A garage is not anywhere on the road network, and a car parked inside one cannot be
expressed as a lane coordinate. `stageCar` in `sim/traffic.js` is that split, and the split is the
interesting part: a staged car is skipped by **every simulation loop** — nothing queues behind it,
yields to it or reserves a junction against it, exactly as for a crashed one — but it is **still in
the render pass**. Only where its `x/z/yaw` come from changes.

Which means the drive-out gets the car's own suspension for free. The nose dip coming off the kerb
is not animated: it is one impulse into the pitch spring that was already there (ζ ≈ 0.4, so one
shove gives a dip, a rebound and a settle), and a second, smaller one as the rear axle follows. The
speed bob, the brake lights and the indicator all keep working the same way — the indicator through
`stageSignal`, because a staged car has no committed turn to read a hand off.

`stageCar` is mostly a list of things it *clears*. Every lane-relative offset the render pass
applies on top of a position — the weave, the overtake, the siren panic, the pull-over — is eased in
the physics loop, which a staged car skips, so anything left standing would be frozen into the
vignette. A taxi that spent the warm-up near the police siren sat in its garage permanently shoved a
unit sideways until that list existed.

### The exit is one continuous curve

Straight down the driveway, then a quarter circle onto the lane. The fillet's radius is not a choice
— it has to be tangent to the driveway at the kerb lip and tangent to the lane where it lands, which
fixes it at the gap between the kerb and the near lane's centre, `HALF_ROAD - LANE` = **2**. That
happens to be the radius every right turn in this city already uses (`turnControl` in `grid.js`), so
the manoeuvre reads as one of them.

`releaseCar` then hands the taxi back to the traffic model with its speed intact, on the lane the
arc landed on, five and a half units short of the junction. The probe asserts that the arc's
end point and the point `placeCar` puts the car at are the same to within 1e-9 — they are computed
by completely different arithmetic, and a millimetre between them is a car twitching sideways on the
handover.

**It waits for a gap.** The taxi holds at the top of the dropped kerb until the lane it is joining
is clear — a box on that lane rather than a radius around the merge point, because the opposing
lane's centre is only 4 units away and a radius wide enough to see a car coming up behind also sees
every car going the other way. It gives up waiting after 5 seconds: a run that will not start is
worse than a near miss.

### The board waits

`fares.update` is not called while the vignette runs, on the same hold the "Add to Home Screen"
screen takes. The fare board is *seeded* by that first call — `shouldRefill` fills an empty board
immediately — so leaving the loop running stood a rider and a two-metre crystal on a kerb while the
camera was down at the garage door, and on the seed this was first watched on, that kerb was the one
the door faces. The board belongs to the run, and the run starts when the taxi is on the road.

The [taxi's ghost outline](rendering.md#taxi-ghost-outline--geometryghostoutlinejs) is switched off
for the same span, and it is the sharper version of the same point: that outline exists to find the
car behind a building, and for these few seconds the car is *in* one — so it drew a yellow blob
across the door the whole vignette was building up to. Where the car is, is what the camera is for.

### Tap to skip

**A tap anywhere on the city cuts to black, lands the vignette behind it, and fades back up on the
run.** No button and no "skip" label: the opening is seven seconds at the top of a run the player
has already chosen to start, so an affordance costs more screen than the thing it escapes — and a
tap is what every other beat of the opening already answers to.

The black is the feature, not decoration. `opening.skip()` is `settle()` plus one thing settling has
no reason to do: it **snaps** the camera to `restFraming()` at play zoom, from fifteen units off a
garage door. Done in plain sight that is either a jump cut across a third of the map or a second of
easing — the wait the player just asked to be let out of. Under the black it costs one invisible
frame, which is what a cut is for. `game/wipe.js` owns the cover: 160ms out, a 90ms hold, 300ms
back. The hold is what makes it read as a cut rather than a stutter, and the fade in is slower than
the fade out because going to black answers the press while coming back *is* the game arriving.

Three things about the tap:

- **Only while the vignette owns the camera** (`holdsCamera()`), which is false during `wait` — the
  city's own entrance still building itself. Skipping a sequence that has not started reads as the
  tap having broken something.
- **Only a tap on the canvas.** The ⏸ is live through all of this (it is not part of the HUD's
  entrance), so a bare `window` listener would skip the opening *and* pause the game on one press.
- **`pointerdown`, not `click`,** because a skip has to land on the press. Nothing else is tappable
  while the vignette runs — the board is held empty, the HUD has not arrived, there is no route band
  — so there is no gesture for this one to steal.

Both holds the vignette takes — [the fare board](#the-board-waits) and the tutorial — are extended
to the wipe rather than to the vignette alone, and that is the whole reason `covering()` is public:
the sequence stops running a beat *before* the player can see anything, and a bubble that started
typing under the black would have spent half its line by the time the screen came back.

`tools/probe.mjs` asserts the half that is arithmetic — the handover lands where `settle`'s does and
the camera ends exactly on the play framing — and `tools/smoke.mjs` asserts the half that is a page:
that a `pointerdown` on the canvas puts a black div on top of everything, that the run is on the
road behind it, and that the black takes itself down again afterwards.

### Where it sits in the camera's priority list

At the **top**, above even [the closing shot](rendering.md#the-closing-shot), and on every viewport
rather than narrow ones only. It is a cut scene: nothing else can be claiming the framing three
seconds into a run, and a player swiping through one should not be able to steer it off its subject.
It hands back by letting `holdsCamera()` go false with the camera already sitting on the framing the
next claimant wants, so there is no gap for the follow-cam to snap across.

Shot mode never stages the taxi at all — the module is not constructed there — and `main.js` just
shuts the door beside `cityEntry.settle()`, which is the state a run is actually played in.

**`?vignette=off`** skips it, the same escape hatch `?tutorial=off` is: seven seconds is a long
time to sit through on every reload while iterating on something else. It is a *settle* rather than a
skip — the module is built and then landed — so the fast path goes through the same handover the
real sequence does. A skip that reached the game any other way would be a second opening to keep
working. [The player's own skip](#tap-to-skip) goes through the same `settle`, which is what that
handover being one path is for; all it adds is the camera, because it is the one skip that lands
with the shot somewhere it cannot be left.

## The opening tutorial

`src/game/tutorial.js`, with its markup and styling in `index.html` under `#coach`. A white speech
bubble in the bottom centre with the player's own taxi turning beside the text, tail on top pointing
up at whatever it is talking about, and the line typing itself out. **Three beats, and that is all
of it** — though the first one is currently switched off:

1. ~~**"Let's pick up some rides and earn some cash."**~~ The camera follows the taxi while it types
   and a spotlight picks it out of a darkened city. **Off** — `TAXI_BEAT` in `tutorial.js`. The one
   thing a new player cannot work out by looking is which of the hundred cars down there is theirs,
   and this was the cheapest way to answer it until
   [the opening vignette](#the-opening-vignette) started the run by showing them their own garage
   door open and their own car drive out of it. That is a better answer than a sentence, and skipping
   the bubble gets the run to its first *instruction* a beat sooner. The beat is intact behind the
   flag — the line, `openOnTaxi`, and the `'taxi'` step in both step sets — because the vignette is
   a prototype and this is what has to come back if it goes.
2. **"Tap rider to start."** The spotlight moves to the waiting fare as the camera sets off for
   them, so the light is already on the rider and the pan carries the player to it; the bubble comes
   back once the camera has arrived. Tapping the rider answers it directly.
3. **"Hold to floor it"** — the Loco Mode pill, two seconds after the first rider is *dropped off*,
   with the bubble sitting directly over the pill and its tail pointing down at it, the spotlight on
   the pill and the pill pulsing under it. Skipped entirely if the player has already fired Loco
   Mode.

The city's own entrance and then the vignette come first: the whole tutorial is held frozen (via its
`isBlocked` hook — the same one the "Add to Home Screen" screen uses) while the buildings rise out of
the ground ([the entrance animation](rendering.md#the-city-entrance--gamecityentryjs)) and the taxi
comes out of its garage, then `OPENING_HOLD` — now just a 250ms breath — separates the camera landing
from the lights coming down. The hold used to be a full second of static city, because a run that opens
mid-sentence gives the player nothing to attach the sentence to; three-plus seconds of the city
building itself does that job better than the second of idling traffic did. The clocks are already
held through all of it, so it costs nothing. The camera is already easing onto the taxi during it —
that is the one thing that should be under way before the bubble speaks.

**A tap anywhere advances**, not just a tap on the bubble. The listener is on `window` rather than a
full-screen catcher, so the tap still reaches the city underneath — on the second beat the whole
lesson is the tap landing on the rider, and an overlay would eat the one gesture being taught. It
shares the picker's `didPan()` guard, so a swipe that dragged the map is not also an answer.

The avatar is the real `createTaxiMesh()` in its own small WebGL context, the way each rider-finder
chip owns one — so the car in the bubble is the car on the road and cannot drift out of step when
the taxi is restyled. It is lit by the city's own sun and hemisphere fill (mirrored per frame, so
turning the day/night cycle on carries into the bubble) and framed on the cylinder the car sweeps as
it turns, so nothing clips at any angle of the spin.

It is viewed at `VIEW_DIR`'s **elevation** but on the **rider avatar's azimuth** — the same +Z the
second beat and the rider-finder chips look down. Straight down `VIEW_DIR` was the first go, and it
put the sun three-quarters behind the car: the `+X` faces sit at `n·L = −0.78` at the hour the game
parks at, so one whole flank was black at every angle of the spin, inside a white bubble, while the
rider in the next beat stood in full sun. Turning the camera round the Y axis only offsets the phase
of a spin that goes all the way round, so no silhouette was lost — 65% of the visible sweep is lit
now rather than 40%. The reduced-motion still pose moved with it, from a three-quarter at `−0.08`
to one at `0.84` of full sun.

Its **roof sign is lit**, which is the one place the sign is not the occupancy readout it is
[everywhere else](#the-taxis-roof-sign): nothing in the bubble is asking whether the taxi is free,
and the lit off-white is the only bright mark on a roof that is otherwise a dark cabin block — it is
what makes the shape say "taxi" at 54px.

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

**It fires on a fixed delay off the first drop-off, not on trip progress and not off the rider
tap.** The first version was a fraction of the trip — half way to the pickup, measured as road
actually driven against the trip's block distance, both of which were corrections for the
*straight-line distance remaining* that came before them. All of that was a better description of a
moment and unpredictable in practice: trip lengths vary by a factor of five, so the hint landed
anywhere between three seconds and half a minute in, and on the long ones the player had stopped
wondering about the pill long before it arrived.

A fixed `BOOST_HINT_DELAY` off the tap that dispatched the taxi fixed the unpredictability but
landed in the wrong place: three seconds in, the player is watching their first pickup with a clock
draining, and Loco Mode is a fourth new thing arriving while they are still working out the first
three. Hanging the delay on the first **delivery** instead — `hasDelivered()`, which `main.js`
answers from `fares.state.delivered` — puts it in the one gap in a run where nothing is being asked
of the player, and it answers a question they have just earned: that took a while, can I go faster?
Two seconds, because the payout has finished flying into the counter by then.

It follows that a player who never completes a fare is never told about Loco Mode, which is the
right way round — there is no point selling a way to drive faster to someone who has not yet done
the driving. The countdown is ticked through the `restore` glide as well as `toBoost`, since on a
desktop that glide can still be running when the delivery lands.

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
spawn stagger and the marker animations, neither of which is the player's to pay for.

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

### It runs on every new game

Not just the first. Remembering it across loads was tried — a `localStorage` flag under
`simtaxi.tutorialSeen`, on the grounds that play-again is a `location.reload()` and a lesson learned
once should not be charged for on every retry — and taken back out. The opening is two taps long, it
[does not spend the player's clock](#it-does-not-spend-the-players-clock), and it is the only thing
in the game that frames the taxi and says which car is yours; a player back after a week gets that
for free rather than hunting the board for their car.

`?tutorial=off` skips the whole thing, and shot mode never runs it: a screenshot has nobody to
teach, and the bubble would be the loudest thing in every frame.

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
   ring in that same urgency colour appears on the road where they're going, and the taxi **drives
   straight on to it** — because the instruction it used to ask for is now given for you. See
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
holds no reference to the taxi mesh or the HUD. `main.js` translates events into all of
that. It is a list because more than one can land together: delivering the last fare clears the
board, and the refill follows on the next frame.

## Extra fares and prioritisation

The taxi has **one seat**, so any extra fare beyond the one aboard is someone *waiting* — a clock
draining on the kerb while you decide who to grab. Tapping a waiting rider while already carrying
one is refused outright, rather than driving there and quietly not picking anyone up.

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

The "queue ahead" term has exactly one exception, and it is the whole of what makes that fare hard:
a [VIP](#vip-pickups) is budgeted to be served **next**, so its clock pays for the rider aboard and
its own trip and for nobody standing on a kerb.

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
their head and [the disc under their feet](#the-disc-says-it-again-on-the-ground) are both spoken
for by the clock, which is why the figure between them has to stay out of the way.

The **roof sign** lights up while a rider is aboard and goes dark once they're dropped off — a
plain on/off, not a colour. It used to wear the fare's own colour, drawn at spawn from a five-colour
palette (`nextFareColor()`), because that colour was what paired a rider with their drop-off pin
across the map. The drop-off carries no fare colour any more, so with nothing left to pair with,
the sign's job shrank to the one thing still worth saying at a glance: is the taxi free.

#### The drop-off is a ring, and it wears the rider's clock

The disc on the tarmac and the off-screen pointer that stands in for it are painted from the
[urgency scale](#urgency-is-one-scale), at whatever level the rider **in the car** is standing at.
Nothing floats above it.

**It lost its head.** The drop-off was a crystal on a gold post, then the crystal alone at rooftop
height, then that crystal in teal once a waiting rider's marker became the same model. That last
step is what finished it: two diamonds on the board, and only one of them reporting anything. The
player had to tell "a clock is running here" from "this is just a place", by hue, on two shapes
that were otherwise identical — when the ring underneath was already saying "this is just a place",
at ground level, where the driving happens. So a diamond on the board means a clock, and a ring
means a place the taxi is being driven to.

What went with it is the rooftop silhouette: the crystal stayed visible over the skyline for a beat
after the ring itself had slipped behind a tower. The
[off-screen pointer](rendering.md#off-screen-drop-off-pointer) covers the far end of that — a
drop-off outside the frame — and inside the frame the route band runs all the way into the disc, so
there is a line to follow to it. A drop-off briefly hidden behind a building on a road you are
already driving down is the case that is genuinely worse, and it is worth what it buys.

**The colour is the argument that changed.** It was a fixed **teal** for a long time, and the
reasoning was sound as far as it went: hue on a fare marker means urgency, the drop-off has no clock
of its own, and only one is ever on the board — so a per-fare hue had nothing to tell it apart from,
and a colour outside the green-to-red scale is what says "this one is not on it". (Before the teal it
was **Loco Mode's yellow**, on the grounds that the car, the band and the place it is driving to are
one statement; yellow is the taxi's, and a marker reporting nothing was borrowing a vocabulary it
isn't part of.)

What that missed is that a colour does not have to *distinguish* to be worth reading. The ring is
where the player is looking — it is the thing being driven at, at ground level, for the whole second
leg of a trip — and the deadline they are racing is the one attached to the rider in the car. Putting
that clock on the tarmac means the answer arrives without a glance up at a 29px crystal riding a
moving roof. The disc reports nothing *of its own*; it repeats what the crystal above the taxi is
already saying, in the place the eye already is. A VIP's stays its
[fixed purple](#vip-pickups) at every level, the same exception the crystal makes.

So the marker language is: **shape says what a thing is, hue says whose clock is paying for it.** A
diamond is a clock, a ring is a destination, a band is a route — and all three of them, for one
trip, are the same colour. See [rendering.md](rendering.md#the-drop-off-ring--geometrymarkerjs).

The one decision all of this defers is still deferred: nothing on a marker says which *taxi* is
taking a trip. The day there is more than one, that stays the player's call.

#### The route band wears it too

`src/game/routeline.js`, painted per frame from `fares.colorOf()` on whichever fare the taxi has
been [sent at](#arrival-requires-direction). It was the taxi's own yellow before — the band belongs
to the car, not to the road — and the car is not the news. A route only exists because a fare is
draining at the end of it.

It is the **largest thing on the screen by a wide margin**: a lane-width band running across half a
5×5 city, on a road the eye is already following because that is where the taxi is going. Urgency
carried there is urgency the player takes in while doing the thing they were doing anyway, instead of
having to look away to a small shape at the edge of vision. Both the destination and the trouble
arrive in one read.

`PALETTE.routeLine`'s yellow is still the fallback for a route with no fare behind it — the
[recovery](traffic.md) re-route, and a route poked in by hand from the debug panel. A route sent
*at* a package — the [empty-seat dispatch](#with-a-rider-aboard-a-package-is-a-detour-with-the-seat-empty-a-destination)
— wears the courier's own cyan instead: a package has no clock, so an urgency hue there would be
reporting a countdown that does not exist.

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

### Dragging the route

`src/game/pathdrag.js`. **Press the band and pull it sideways.** The junction under your
finger becomes a waypoint, the route is re-planned through it, and the band redraws on the same
frame — so you can take the taxi round a block that has gone solid without giving up the fare you
are driving.

Until this existed the band was the only thing on screen saying what the taxi was about to do and
the only part of the interface you could not touch. Tapping a rider says **where**; this says
**which way**, which is the question a player is already asking the moment they can see a queue
building on the road the band is about to take. It is the one decision the game was showing them
and not letting them make.

**A single waypoint, snapped to a junction.** Not a freehand line: there is no hand-drawn path a
city of one-way lanes could honour, and a gesture that let you draw one would have to silently
throw most of it away. What the player is naming is a corner to go via, and `findRouteVia` answers
with a real drive — right-hand lanes, no U-turns, arterials still preferred, closed streets still
avoided. A drag of half a block does nothing until it crosses into the next junction's cell and
then the whole detour appears at once, which reads as the route *committing* rather than as paint
smearing under a finger.

Four things about it are load-bearing:

- **It re-plans from where the taxi is now, every frame the finger is down.** The car does not stop
  while you drag — its clock is running — so a waypoint chosen four seconds ago has to be
  re-stitched onto a route that now starts a block further on. `planOrigin` is what makes that safe
  mid-turn, and it is the same trap [the drop-off's own dispatch](#the-drop-off-dispatches-itself)
  walks into: a route planned from the intersection a turning car has *already committed to*
  silently drops its first step, and every later turn lands one junction early. Its sibling is
  `routeConsumed`, which has to be cleared on every re-plan or the commit at the end of the current
  turn eats the first step of the new plan instead of the old one's. Both failures are a route
  desync rather than a crash — the only symptom is a fare quietly timing out — which is why the
  probe drives 180 consecutive re-plans (119 of them mid-turn on the shipped seed) and asserts the
  taxi still arrives.
- **The waypoint retires when it is reached**, not when the gesture ends. Once the taxi is heading
  at it there is nothing left to detour around, and re-planning through a junction the car has
  driven *past* answers with a lap back to it.
- **Release commits what is drawn.** No confirm step and no revert. The band has been showing the
  real route the whole way, and a gesture that undid itself on release would make every frame of
  that a lie. Undo is dragging back onto the original line, which the router answers with the
  original route — `tools/probe.mjs` asserts that exactly.
- **A silly drag is refused rather than answered.** `MAX_VIA_DETOUR = 6` legs over the direct
  route. A finger that lands behind the taxi, or slips a block wide on a two-block hop, would
  otherwise be answered with a lap of the city. Under the cap the detour is taken exactly as drawn;
  over it the band simply holds still and the drag feels like it hit a wall.

**The cap is about short trips, and the numbers say why.** On a corner-to-corner run in the shipped
city the direct route is 9 legs and the *worst* waypoint on the whole map costs 2 extra — nothing
a 5×5 grid can produce comes near the cap. Only 10 of the 36 junctions cost anything at all to go
via, and **16 of the 26 the band does not already pass through cost zero**, because a Manhattan
grid is full of equal-length alternatives the router's straight-then-right-then-left tie-break
simply didn't pick. On a two-leg trip the same cap refuses 17 of the 36.

That last figure is also a warning about how to test this: "the waypoint is not on the drawn route"
is *not* the same claim as "the waypoint costs a detour", and a cap check written against the first
one goes red for a reason nobody can act on. It is asserted against real leg counts instead.

#### The grab flourish

A finger landing on the band has to be answered **on the band**, and answered before anything has
moved — the player is being told "this is a handle" at a moment when they have not yet pulled it.
So the whole response is a lift of what is already there rather than a new object appearing:

| | what it does | what it says |
|---|---|---|
| Whole-band lift | +0.30 on the alpha, everywhere | the thing you grabbed is the *route*, not this stretch of tarmac |
| Bloom at the finger | +0.50 more, Gaussian over ~11 units | and **here** is the point that moves |
| Thickening | +30% on the band's half-width | something has taken weight |
| The handle | a ring on the road under the finger | this is the object; it goes where you go |

It snaps on over 0.06s and settles off over 0.18s. A grab has to feel instant or it reads as lag on
the one gesture whose entire promise is that the path answers your finger; letting go is not news
in the same way.

Two numbers were measured and moved. The bloom pushed **0.45 toward white** at first and the core
went fully white over the additive blend, so the band lost its colour exactly where the player was
looking — and that colour is [the fare's clock](#the-route-band-wears-it-too), which is the one
thing on the band worth reading. Washing it out at the point of contact is the one place it must
not go. At 0.30 it is a hot version of whatever hue the band is wearing rather than a white. (The
number was measured when the band was the taxi's yellow, and survived the move to the urgency scale
because it is a lift rather than a colour of its own.)

And **the handle was additive yellow, and vanished.** It sits at the centre of the brightest thing
in the frame — the band's own bloom — and adding light to a blown highlight changes nothing. It is
[the crystal's black rim](#what-the-crystal-does) again: a marker cannot outline itself in the
colour it is standing on — and on a band that walks green to red over a run, black is the only
colour that survives all four. So the handle *subtracts* first. A darkened disc punches a hole in the
glow and the bright rim reads against that hole rather than against the road, which comes out as a
grommet in the paint — which is what the thing actually is.

#### Why the press has to be on `window`

The grab listens for `pointerdown` on **`window`, in the capture phase**, and stops propagation
when it takes hold. Not on the canvas, where everything else in this game listens.

Both this and [drag-to-pan](#picking) want the same press, and the band must win it. Registering
after `attachDragPan` does not achieve that: listener order *within one element* is registration
order whatever the capture flag says, so a capture listener on the canvas still runs second. An
ancestor's capture phase is the only ordering that holds regardless of which module happens to be
constructed first. Get it wrong and there is no error — the map slides out from under a drag that
was meant to move the route, which every headless tool here is blind to. `tools/smoke.mjs` asserts
the pair: a drag on the band re-routes and does not pan, and a drag anywhere else pans.

The click the browser synthesises after a drag is swallowed by the same `didDrag()` guard the
camera's `didPan()` uses, so a pull that happens to finish over a rider does not also dispatch the
taxi at them.

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
is refused rather than routing a taxi that could never collect them.

**The taxi is permanently selected.** There is only ever one, so a selection step was pure
ceremony: every tap on it was either a no-op or an accidental deselect that made the next tap on a
fare do nothing.

### The tap pops

`src/game/selectpop.js`. A tap that lands **swells and lights** the rider *and* the crystal over
their head, then settles them back, over `POP_TIME = 0.4s`:

| | rest | peak | on the way back |
|---|---|---|---|
| rider figure | ~26px | ~33px | dips to ~25px |
| crystal | ~29px | ~38px | dips to ~28px |

with a light that comes up on the same curve — the crystal's emissive from `0.35` to `1.05`, the
figure's from black to a `0.3` white lift — and fades out by 0.29s.

It exists because nothing else answers the tap *where it happened*. What the tap means — the taxi
has been sent — is said by the route band, and that starts a junction away from the finger and runs
off across the city. On the corner itself the frame after a tap that landed looked exactly like the
frame after one that missed, which on a rider a handful of pixels tall is a real question a player
was left to answer by waiting.

Four things it is careful about:

- **One envelope, shared.** The figure and the crystal have different owners (`fares.js` and
  `faremarker.js`) and different amplitudes, but they take their zero from the same frame's
  `state.elapsed` and ride the same curve, so they read as the fare reacting rather than as two
  objects that happened to be tapped at once. Phase alone is enough to break that: the first cut
  stamped the figure at the tap and the crystal on the next tick, and the two ran a frame apart.
- **The light is a lift, not a colour.** Hue on a fare marker means urgency, so a tap may not
  repaint anything — it turns up what each object is already emitting. The crystal can take a lot of
  it (its emissive *is* its own hue, so it saturates rather than washing out); the rider cannot,
  being a pale figure to start with, and at `0.45` the peak clipped them to a featureless white blob
  with the raised arm swallowed into the torso. The light also rides the fill, so an almost-spent
  crystal flashes on the liquid it has left rather than lighting up the empty glass above it.
- **Scale only, no hop.** The [level-change kick](#what-the-crystal-does) swells *and* lifts the
  crystal, and the lift is its signature. A pop that also left the ground would read as the clock
  having stepped on the frame the player tapped, which is news the marker must not invent.
- **It undershoots — but only the scale.** The envelope crosses back through rest and dips under
  before it lands. Decay alone spends its last third as a barely-moving object slowly stopping,
  which reads as lag; the dip gives the eye an ending to see. The *light* is clamped at zero over
  the same stretch, because a marker going dim reads as having been switched off rather than as
  having finished.

It fires from `markDirected`, which is where both entry points — a tap on the pin and a tap on a
[rider-finder chip](#extra-fares-and-prioritisation) — land once the route has actually been
planned, so a
selection that was refused never pops. Waiting fares only: the drop-off is a disc on the road with
nobody standing on it, and the taxi dispatches itself there. Re-tapping a rider the taxi is already
on its way to pops again — it acknowledges a gesture rather than reporting a state, and a second tap
that did nothing reads as a tap that was swallowed. Shot mode passes `{ pop: false }`, since a
staged dispatch is not a finger.

## The fare's clock travels

`src/game/faremarker.js`. The countdown is a **physical object that belongs to the fare** — not a
HUD number, not a property of a marker, and not something that changes hands. A **plumbob** floats
over the rider's head on the kerb — a crystal hanging point-down at the person it belongs to, the
way a plumb bob indicates a spot on the ground — painted by how much of their clock is left:
green → yellow → orange → red, [by level](#urgency-is-one-scale) — and [draining like a
glass](#the-crystal-is-a-glass-of-time) between those steps. The instant they get in it **flies to the taxi**
(`TRANSFER_TIME = 0.65s`, eased, with a small arc) and keeps draining above the roof, because from
that moment the deadline is the car's problem.

**The rider getting in and the deadline moving into the car are one gesture.** Nothing is created or
destroyed at the hand-off — the same object leaves the kerb corner it has been standing on and
crosses to the roof, which is the whole reason the flight is animated rather than a teleport. It is
also why the marker holds **one altitude** on both ends: the transfer reads as sliding sideways
rather than climbing into a different slot.

That flight is tuned against `BOARD_SECONDS = 0.9`, so the clock lands on the car a beat *before*
the rider figure finishes climbing in. The deadline arrives, then its owner does.

### The disc says it again, on the ground

A waiting rider stands in a **disc in their own urgency colour** — the same hue as the crystal over
their head, on the [drop-off's own shape](#the-drop-off-is-a-ring-and-it-wears-the-riders-clock).
One hue said twice: at eye level, where the eye happens to be, and on the road, where the taxi is
actually being aimed. It also survives what the crystal does not — a rider behind a tower still has
a mark on a plane the buildings mostly don't cover.

It never drains. Time is the colour's job; the disc only has to say "here".

**A fare owns one disc at a time, and it moves.** The rider's goes dark the instant they board and
the drop-off's lights on the same frame — the hand-off the crystal makes in the air from the kerb to
the taxi roof, made on the ground from one end of the trip to the other. So the shape means "a place
this clock is attached to" wherever it is, and what tells the two ends apart is whether anyone is
standing in it: a disc with a figure in it is somewhere to collect, an empty one is somewhere to
deliver. A disc left glowing on an empty pavement would read as a second fare, which is exactly why
it goes out.

The kerb disc was taken off for a spell on the argument that a disc ought to mean "the taxi is being
driven here" and a rider nobody has tapped is not that. It reads better than it argued: the eye is
down on the road, and that is where the colour is worth having.

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
drawing everything that stands inside it afterwards. A disc still lies under a rider today, but a
depth-tested one, so it is occluded by the figure standing in it instead of painted across them and
none of that apparatus is needed.

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
much worse: the crystal is widest a third of the way down from its top, so a volume-true drain would
spend most of the clock in a narrow band up there and then fall through the whole taper in the last
few seconds. (It was wrong on the octahedron too, which at least drained symmetrically.) The player
reads where the line *is*, so equal time has to be equal travel. Both ends overshoot the tips
slightly, which is what makes a full fare a plain solid crystal and a dead one a plain empty vessel,
with no highlight stranded on a vertex.

It is **one mesh with a per-fragment alpha**, split in the fragment shader — same silhouette, one
draw call, and the bounce, the kick and the pulse keep animating a single object. The cut is in the
geometry's **local Y**, so the liquid rides in the vessel instead of sloshing when the marker hops.

### Getting the empty half to look empty

The first build was opaque: the hue at half lightness above the line. It read as a **dark solid**,
not as an empty vessel, which is the whole point of the thing.

What stood in the way of real transparency is the **black inverted hull**. It is a larger copy of the
crystal drawn back-faces-only, so its far faces cover the entire silhouette — glass over it shows a
black void rather than the city. The fix turned out to be draw order rather than a different outline:

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
- The **sheen exponent** went from 2.5 to 5. At 2.5 it was not a highlight but a wash: very little
  of the crystal is truly head-on at this camera angle, so every visible facet picked up most of the
  lift. At 5 it stays on the two flanks either side of the front ridge.
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

**Its outline is one weight, always** — `RIM_SCALE = 1.12`, about 1.7px of rim at play zoom, on the
kerb and over the taxi alike. It used to carry a second state: once the taxi had been sent at that
rider the crystal inked over in heavy black, the same outline drawn at `1.34` (≈5px), and dropped
back to 1.12 at pickup. On a board with two riders waiting that said which of them the car was
already on its way to. It went because 5px is a *border* rather than a rim — heavy enough to change
the silhouette — and because a marker that swaps outline weight at the hand-off reads as two
markers in relay rather than one clock travelling, which is the exact thing the crystal exists to
say. The route band already answers "which rider?", and it answers it along the whole road instead
of on one corner. Black stays the rim's colour for the reason it always was: it was the taxi's
**yellow** first, and this crystal spends a quarter of every clock *being* yellow, so a yellow rim
on a yellow diamond is no rim at all.

A **diamond on the board means exactly one thing: a clock is running here.** The
[drop-off](#the-drop-off-is-a-ring-and-it-wears-the-riders-clock) wore the same model for a spell
and gave
it back, because a second crystal reporting nothing made the shape ambiguous.

### What it replaced on the kerb

Four things, in this order:

- **A shaft of light** over the rider, which marked them at range and said nothing else.
- **A draining ring on the kerb**, an earlier body for the same clock. A disc is back under the
  rider now and it is worth being clear about what changed: that one *was* the clock, a countdown
  the player read by how much of it was left, and it was the only thing marking the corner. This one
  reports nothing on its own — it repeats the crystal's colour, and the crystal is the clock. See
  [The disc says it again](#the-disc-says-it-again-on-the-ground).
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

Four surfaces show it — the fare's diamond wherever it currently is, the
[ring on the road](#the-drop-off-is-a-ring-and-it-wears-the-riders-clock) the taxi is being driven
at, the [route band](#the-route-band-wears-it-too) running between them, and the countdown around
each rider-finder chip — and they all read from here, through one `fareColor(level, vip)` that also
owns the VIP exception. A rider showing orange on the map whose chip is yellow in the corner is two
answers to one question, and a band arriving red at an orange disc is the same mistake drawn across
half the city. It was three surfaces until the [timer ring](#it-used-to-be-a-relay) went, which is
exactly why the scale was pulled out of the ring into its own module in the first place.

The [VIP](#vip-pickups) is the exception all four make together, and it is now a total one: purple
at every level, and the two surfaces that carried a *quantity* rather than a hue — the crystal's
fill and the chip's ring — are both simply held full. A VIP does not say how long you have.

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
every fare's price is actually stamped with at spawn, and it steps on the beat it crosses into a
new [shift](difficulty.md#shifts). The bump still fires on every delivery even
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
board — their diamond opens on a fixed purple, never drawn from the urgency scale, so "this one is a
VIP" is never confused with how much time they have left, and every other surface that fare speaks
through follows it: the ring on the road at the far end of their trip, the route band driving at it,
and the off-screen pointer.

**And that is the whole of what they will tell you.** A VIP's clock is not shown anywhere: the
crystal is a solid purple gem that never drains, and the rider-finder chip's ring — the last surface
that still reported the seconds — is held full and purple as well. You know one is worth three fares
and you do not know how long you have, which is what makes taking one a gamble instead of a sum. The
only thing that ever breaks the silence is the panic pulse the marker beats under five seconds, and
that is an alarm rather than a countdown: it says *now*, not *how long*.

Everything else about a VIP is the ordinary fare loop with four numbers turned:

- **A short clock, and one that assumes you drop everything.** Budgeted the same way as everyone
  else's — from the driving the trip actually costs, plus the same reaction allowance — but at a
  fraction of the run's own slack (`VIP_SLACK_FACTOR`, floored at `VIP_MIN_SLACK`), and, far more
  importantly, **without the kerb queue in the chain**. Every ordinary rider's clock pays for the
  riders ahead of them, so serving the board in the right order works (see [the fare
  clock](#the-clock-is-budgeted)). A VIP's does not: it covers the rider already
  aboard, whom you cannot abandon, its own trip, and nothing else. Jump the queue for it or lose it.
- **Triple pay, before the streak.** A VIP pays the ordinary distance price times the current shift
  multiplier, same as anyone — and then again by `VIP_PAYOUT + streak`, where the streak is how many
  VIPs have been delivered back to back. So the first is worth 3 fares, the next 4, the next 5.
  (The base multiplier is what makes the first one worth taking at all: before it, `streak + 1` made
  a fresh VIP worth exactly one ordinary fare.) Stamped at spawn like every other price on the
  board, so the marker's fixed purple says what this one is worth the moment it appears rather than
  leaving it to be found out on delivery. A miss resets the streak to zero — the whole tension of
  stacking VIPs is that one late drop-off gives it all back.
- **A full tank on delivery**, rather than the ordinary third. `main.js` reads the boost meter's
  current fraction at the moment the delivery's energy bits land and tops up exactly what's missing,
  so a VIP always leaves Loco Mode topped off regardless of what was left in the tank going in.

What the numbers are worth, measured over 20 auto-played runs at a 1.5s reaction (the harness in
`tools/autoplay.mjs`, driven from a scratch copy that counts VIP events):

| | landed | seconds left at the drop-off |
|---|---|---|
| Queue-budgeted clock, player serves the kerb in urgency order | 55% | 13.0 |
| Queue-budgeted clock, player drops everything for the VIP | 78% | **63.9** |
| Shipped clock, player serves the kerb in urgency order | **20%** | 7.2 |
| Shipped clock, player drops everything for the VIP | 86% | 8.8 |

The middle row is what was wrong with the old one: a minute of unspent clock is not a hard fare, it
is a free one wearing a countdown. The bottom two rows are the choice — go now and you land it with
seconds to spare, leave it in the queue and you lose four out of five.

**Missing one is still not a run-ending event.** Every ordinary fare's clock hitting zero ends the
run — that is the entire tension of the fare loop. A VIP is the one exception: its clock running out
takes the fare off the board, resets the streak, and the run carries on. It stays pure upside by
construction: taking one on can only make a run better, never worse, which is what lets it stay
optional without ever being a trap even now that it is genuinely hard.

### They leave, and they let you know

What a miss *looks* like is the rider walking out. Until it did, the only evidence was a payout that
never arrived — the diamond simply stopped, exactly as a delivery does, and the cost (the fare and
the streak behind it) had to be inferred. So `beginBail` in `fares.js` hands the figure to the same
`exits` list a delivered rider uses and plays `person.bail`: out of the moving cab if they were
aboard, off the kerb if nobody ever collected them, then a fast run and a fade. The taxi is released
on the same frame — an empty seat, or a route to a corner with nobody on it.

Over their head, `geometry/cursebubble.js`: a jagged outburst bubble with `%#&@!!` in it. Every mark
is geometry — six little stroke-and-dot glyphs merged into one mesh, drawn in the screen plane by
the constant orientation the fixed camera makes possible ([rendering.md](rendering.md)) — because
there is no font in this project and a canvas-drawn label would be the one thing on the board that
is a picture of writing rather than a built object. At play zoom it is about 57px wide and each
glyph is 7px, which is a grawlix doing exactly its job: it reads as swearing and never as any
particular swear.

Where they run is the one part with a rule behind it. **Not the diagonal**: a kerb corner sits half
a unit inside its block and buildings start 0.85 in, so the obvious "away from the junction"
direction ends with the rider standing inside a shopfront, invisible for the whole animation. A
rider who gave up on the kerb walks off *along* it, on one axis, staying at their own kerb's fixed
distance from the road; one who jumped out mid-street runs at the kerb corner of the junction the
taxi is at and no further than it.

Rare on purpose — a cooldown (`VIP_COOLDOWN`) plus a per-opportunity chance (`VIP_CHANCE`), checked
only when the board is about to refill and no other VIP is already on it. Both are tuned against
the fare soak (`tools/soak.mjs`): frequent enough to be a real event, not so frequent that
forgiving misses meaningfully padded the survival curve. Never on the tutorial fare
(`VIP_MIN_DELIVERED`) — nothing on the board yet for a purple diamond to be distinguished *from*.

## The package courier

`src/game/parcels.js`. A brown parcel sits on a kerb corner on a cyan rounded-square pad. Drive
near it and the taxi picks it up — **while carrying a passenger, if it is carrying one** — and the
pad it is going to lights up somewhere else on the map. Drive near that and it pays out in cash.
One on the board (`MAX_PARCELS`), one aboard at a time, and nothing about it can end a run.

### With a rider aboard, a package is a detour. With the seat empty, a destination

**The rule is about the seat.** While somebody is riding, their clock is the one being spent, so
there is no way to dispatch the taxi at a package. The only way to collect or deliver one is to
make the taxi's route **pass through its junction**, on the way to wherever it was already going —
which, since the route is planned to whatever fare the player is actually working, means bending
that route sideways until it crosses the pad.

Until this existed the band was the one thing on screen the player could reshape and had almost no
reason to. `pathdrag` answered *which way*, and on an empty street the answer did not matter — the
only thing that ever made it matter was traffic going solid ahead of you, which is a defensive
move. A package puts something worth having on a road the route does not currently take, so the
question becomes worth asking with the streets clear. **The route-drag mechanic gets a reason to
exist**, and the cost is paid in exactly the right currency: the seconds the detour takes come out
of the clock of whichever rider is in the back seat.

So it is the first decision on the board that spends *another job's* clock. Every other gesture in
this game answers "which rider?". This one answers "is the bonus worth the seconds?".

#### Two gestures ask for the same bend

**Drag the band** through the pad, or **tap the box**. With a rider aboard both plan the identical
route — origin → box → destination, `findRouteVia`. `divertToParcel` in `main.js` is the tap's whole
implementation, and the thing the detour does *not* do is route the taxi at the package: the
destination, the fare, and which clock is paying are all untouched, exactly as when a finger pulls
the band.

The tap removes the **aiming**, not the decision. A drag asks the player to work out which junction
bends the band through a box that may be half a city from the paint, and then to hold a finger on
the route of a car that is still driving while they do it. On a phone that is a two-handed job in
service of a single yes-or-no. The tap says *include this* and lets the router find the bend.

The drag keeps the half the tap cannot express. It answers *which way*, so it is still what you
reach for when the road ahead has gone solid, and it can bend a route through a corner no marker is
standing on.

##### The one thing the tap does not share is the cap

`TAP_MAX_DETOUR` is **uncapped**, and it is the one place the two gestures deliberately part company.

It shipped inheriting [the drag's `MAX_VIA_DETOUR`](#dragging-the-route), on the reasoning that the
same bend should refuse in the same case. That was wrong, and wrong in a way that only shows up in
play: it was reported straight away as *"tapping the box did not alter the route"*. It hadn't — the
cap had refused it.

The two caps are not doing the same job. **The drag's cap catches a finger that slipped.** A finger
on the band is by construction near the route, so the cap almost never binds — the worst waypoint on
the whole map costs 2 extra legs on a corner-to-corner run. **A tap names one corner anywhere on the
map and is never sloppy.** Measured over 8 seeds and 649 distinct tap opportunities in real runs, the
extra legs a tapped diversion costs:

| min | p25 | median | p75 | p90 | max |
|---|---|---|---|---|---|
| 0 | 4 | **6** | 10 | 12 | 20 |

The median tap costs exactly the cap. So at 6 it refused **41% of every tap in the game**, silently,
on the gesture whose entire promise is that the route bends to include the box. And no value fixes
it: 8 refuses 26%, 10 refuses 11%, and by 16 it refuses 0.6% and exists only to surprise people.
Either it caps meaningfully or it does not exist.

What makes uncapping safe is that nothing about a tap is hidden. The band redraws through the box on
the same frame, before a wheel has turned, so the cost is visible at the moment of the decision — and
the undo is a tap on the rider, which re-plans direct. It is also the only setting consistent with
the rule below it: a diversion already may cost the rider in the back their fare, so refusing a
seven-leg one while taking a six-leg one was never protecting anybody.

`tools/probe.mjs` asserts both halves — that a tapped diversion is always routable, and that the
drag's cap would still refuse a real share of them, because the day it wouldn't is the day this
constant should be deleted rather than kept in step.

What all this trades away is worth stating plainly, because it was the original argument for the box
having no hit box at all: **the drag was the price of a package**, and skill at aiming it was part of
what a box was worth. A tap makes the collection free and leaves only the routing cost — which,
uncapped, is now the *whole* of what a box costs, paid out of the clock of whoever is in the back.
That is the trade this layer exists to offer, made explicit rather than rationed by a cap. Whether it
still plays as a temptation is the open question; the number to turn if it does not is
`PARCEL_PAY_FACTOR`, not `MAX_PARCELS`.

Two things the tap deliberately does not do:

- **It does not persist.** The waypoint is spent the moment it is planned. The next thing that
  re-plans — a pickup [dispatching itself](#the-drop-off-dispatches-itself), a tap on another rider
  — drops it, and the player taps the box again if they still want it. Re-applying it every frame
  is the one shape this must not take: `routeConsumed` is cleared on every re-plan, so a standing
  diversion means the turn the car has already committed to never retires from the route and the
  taxi sits re-deciding the same junction. Measured, in `tools/probe.mjs`: $34 earned in seven
  simulated minutes and nothing delivered.
- **It does not check the clock.** The detour is taken exactly as asked, even when it costs the
  rider in the back their fare. That is the trade this layer exists to offer, and it is the player's
  to make — the same one the drag has always let them make. With no cap either, this is the whole of
  what a box costs, which is why it has to be visible on the frame of the tap rather than felt three
  junctions later.

#### The empty-seat tap is a dispatch

With nobody in the back there is no committed clock the drive has to be a detour *from*, so the box
is allowed to be the destination: the tap routes the taxi straight at it, and the band repaints in the
courier's own cyan — [the band wears the clock it is spending](#the-route-band-wears-it-too), and a
package has none to report, so the hue says "errand" and nothing else. The dispatch replaces
whatever the taxi was driving at, including a waiting rider the player had tapped: the same
retarget rule every fare tap already follows, applied to one more kind of target, with the waiting
rider's clock draining exactly as it would have. On arrival the drive retires itself the way a
fare's legs do — route and target cleared, taxi back to cruising — and the drop-off pad that lights
up is itself tappable, so an empty-seat courier run is two taps end to end.

This is not an exception to the rule above; it is what the rule reduces to when the seat it
protects is empty. It also subsumes the old between-jobs case: with no destination at all there was
never anything to bend, and the tap has always routed at the box in that beat.

#### The corner answers, and the sign is the answer

A tap on a rider is answered by [the rider](#the-tap-pops), because what the tap *means* — the taxi
has been sent — is said by a band that starts a junction away from the finger.

A tap on a box has the opposite problem. The band's answer lands exactly where the finger is: it
bends and comes through the pad, which is the most legible confirmation in the game. What it cannot
say is **no**. A refused drag is felt through the finger — the band stops following, the gesture
hits a wall — but a refused tap looks precisely like a tap that missed a shape a few pixels across,
and the player's next move is to tap it again.

So both answers are given on the corner, on [the pop's own envelope](#the-tap-pops), and they
differ only in sign:

| | what the corner does |
|---|---|
| Taken | swells (`ACK_SWELL`, +22%) — and here is where the route bends |
| Refused | flinches inward and settles (`ACK_FLINCH`, −12%) — heard, and no |

One channel, not two. No colour: hue on this board is spoken for by the clocks, and a package has
nothing to report with it. No light either — a shape that grew *and* lit would out-shout the band
redrawing itself through the same corner on the same frame. The flinch is deliberately shallower
than the swell is tall: a refusal is the quieter event, nothing has changed and nothing is about to,
and a flinch as deep as the swell reads as a second kind of yes.

It rides the marker's `postGroup` — the kerb corner, with the pad and whatever is standing on it —
because the pad's own scale is spoken for by its arrival and exit animations and the box's by the
flight. And `main.js` calls it only once the re-plan has actually been attempted, the same
discipline `markDirected` keeps, so a refused tap can never be answered as though it had landed.

**The flinch is now nearly unreachable, and that is the point.** With
[the cap gone](#the-one-thing-the-tap-does-not-share-is-the-cap) the only refusal left is a leg the
router cannot solve, which a shipped city never has. That is the right way round: the flinch was
built to make a refusal legible and it could not carry the load it was given — a −12% squash on a
~10px box is not an answer a player reads, which is exactly why the capped version was reported as
the tap doing *nothing*. A cue this quiet is a safety net for a case that should not happen, not a
substitute for the case not happening.

### What the detour actually costs

Measured in `tools/probe.mjs`, over three cities, 420s of a perfect fare player who also couriers.
The one knob is how many extra legs of route the player will accept to reach a pad:

Re-measured at one slot (seeds 71624, 4242, 90210; the two-slot numbers this table used to carry are
in the row below it):

| Detour budget | Survived | Fares | Fare cash | Boxes offered | Delivered | Courier cash |
|---|---|---|---|---|---|---|
| **1 leg** | 420s, all three | 12–16 | $252–319 | 1–2 | 0–1 | $0–26 |
| **2 legs** | 297s, 403s, 420s | 8–12 | $135–261 | 3 | 2–3 | $40–54 |
| 3 legs | indistinguishable from 2 | | | | | |
| *(2 slots, 1 leg)* | *420s, all three* | *12–14* | *$233–296* | | *1–3* | *$14–57* |

The shape of the trade is unchanged: the two-leg detours roughly double the courier income and cost
the run in the worst city, and courier cash never comes close to replacing the fare income it burns
— $54 at the very best against $100-plus forgone. Greed is punished by arithmetic rather than by a
rule, and what is worth taking is the package that is nearly on the way already, which is exactly
the decision the layer was added to create. (Past two legs the cap stops binding at all; a 5×5 grid
is full of equal-length alternatives, the same finding [the drag's own cap](#dragging-the-route)
rests on.)

The probe therefore plays at a **one-leg** budget, not at `MAX_VIA_DETOUR`'s 6. A greedy player is
supposed to die there, and a check that asserted otherwise would be asserting the layer is free.

**What the single slot cost, and it is not nothing.** A box the player declines holds the board for
the rest of the run, so at a one-leg budget the layer now goes quiet: two of the three cities offered
exactly one box, it never came within a leg of the route, and nothing else ever appeared. Delivered
counts at that budget fell from 1–3 to 0–1. That is the honest price of "one question about one
corner" — the flip side of the box not being a supply is that a *bad* box is the only box. A player
who takes the occasional two-leg detour clears the slot and sees three, which is the behaviour the
pacing assumes. If it plays too quiet, the lever is not `MAX_PARCELS`: it is giving a long-ignored
box permission to move, which needs to happen without a countdown and without anything vanishing
from under a player already driving at it.

### A package has no clock, and so has no diamond

The board's vocabulary is [shape says what a thing is, hue says whose clock is paying for
it](#the-drop-off-is-a-ring-and-it-wears-the-riders-clock). A plumbob **means** a countdown. A
package having no deadline is precisely why it must not have one — and it keeps the courier layer
from adding a second thing to read to a board that can already carry four fares. The cyan says
"courier job", full stop, which for a package is the only honest thing a colour can say.

It follows that nothing here can end a run. A parcel sits on its corner until somebody drives
through it; missing one is not a thing that can happen. It is pure upside by construction, the same
way a [VIP](#vip-pickups) is, which is what lets it stay optional without ever being a trap.

The hue is fixed and outside the [urgency scale](#urgency-is-one-scale) on exactly the argument the
VIP's purple is made on — and the *shape* is new for a reason the VIP did not need: a VIP is still a
fare, reached the way every fare is. A courier job is not, so it gets a silhouette of its own. Two
hues on one shape would ask the player to tell a package from a rider by colour at 50px; a rounded
square against a disc is read at a glance.

### The rest of it

- **One cargo slot, independent of the seat.** A second box the taxi drives past while loaded is
  left where it is — silently swapping the load would throw away a delivery already paid for in
  detour. The probe asserts the seat and the slot never touch: collecting a package does not move
  the rider's target and does not reset, pause or extend their clock.
- **Priced exactly like a rider going the same distance** — `priceFor`, times the shift multiplier,
  stamped at spawn. `PARCEL_PAY_FACTOR` is the one number to turn if it plays too rich.
- **Cash and a splash of fuel.** No multiplier bump (that number means "this is what a *fare* is
  worth now") and no run-end stat row, but a delivered package does pour **a sixth of a tank** into
  Loco Mode — half what a drop-off pays (`BOOST_PARCEL_REWARD` against `BOOST_FARE_REWARD`). Both
  the payout and the fuel take the same [two-phase flight](#economy) a fare's do, because it is the
  same kind of event arriving from the same place. The half is the whole argument: an errand that
  paid nothing into the tank was the only job in the game whose reward the pill ignored, and one
  that paid a fare's third would make a courier run the *cheap* way to fuel a run — six packages to
  a full tank keeps the fare the thing that fills it. With [one box on the board](#the-rest-of-it)
  that ceiling is a slow one to reach anyway: the fuel is a nudge toward a detour, never a supply.
- **One box on the board at a time** (`MAX_PARCELS`). It held two at first, on the argument that a
  choice of which detour to take beats a single offer, and what it actually produced was a *supply* —
  a pair of cyan pads is something you serve rather than something you notice, and it put two jobs'
  worth of cyan against a fare board that can already carry four discs, so the eye had to sort which
  box before it could ask whether either was worth the seconds. One box is one question, about one
  corner, which is the decision this layer exists to create.
- **A package is a find, not a fixture.** The gap between spawns is **drawn** per package (18–45s)
  rather than fixed, and a delivery pushes the next one further out again (`PARCEL_AFTER_DELIVERY`). A
  flat 12s gap made the board a metronome: back when it held two, that was a permanent pair of pads on
  the map, always something to detour for and nothing to notice, and a layer whose whole appeal is "oh,
  there's one" became scenery. The fare board *wants* to be a steady supply, because serving it is the
  game; the courier board is the opposite, and copying the fare cadence was copying the wrong thing.
  Cashing one in must not immediately produce another — that is the loop closing on itself, and it turns
  a find into a vending machine. At one slot the slot itself does most of the pacing: an uncollected box
  holds the board until somebody drives through it, and the drawn gap governs how long after a
  *resolution* the next one lands.
- **Neither board ever puts two jobs on one corner**, in either direction. The courier refuses to spawn
  on a fare's corner *and* `fares.js` refuses to spawn on a package's, through an injected `reserved`
  callback — injected rather than imported, because the fare loop has to keep working with nothing layered
  on top of it. Only the first half existed at one point, which made the rule *look* enforced while a
  package's indefinite wait guaranteed a later fare would eventually land on one. Blocks as well as
  junctions, since `cornerFor` flips its corner inward at `i === 0` and two intersections a whole block
  apart can still share a slab.
- **Never on a park.** A pad is a delivery address, and a park block has none — no door, no kerb cut,
  the box sitting among the trees — which on a [district](city.md#park-districts-close-roads) reads
  worse still,
  because a district is built *over* the road that used to reach one of its corners, so the pad stands
  beside a street the router knows is gone. Both ends are filtered, through `onParkBlock` in `fares.js`
  rather than a test written here: which block a corner pin ends up on is `cornerFor`'s −X−Z flip, and
  that flip has one owner. It is the only **hard** condition in the draw — every other one is about how
  good the errand is, and a bad draw there is a worse job; this one is not a job at all — so an unlucky
  city offers no box that frame and tries again on the next, which costs a layer with no clock nothing.
  The supply it spends is small: the leanest of 200 city seeds still leaves 24 of 36 junctions standing
  on pavement, and `tools/probe.mjs` asserts both that floor and the rule itself. The rule's check
  samples 80 fresh boards on one city rather than counting the run's own spawns — one board slot means
  a 420s run sees a handful of packages against a map that is a sixth green, so the run alone passes by
  not looking (measured: 0/2 in the run, 17/160 across the boards, with the filter deleted).
- **Packages land off the route the taxi is already driving**, at spawn. A box on a road the car was
  going to take anyway is collected for free and asks nothing. It is a spawn-time bias only — the
  next fare re-plans everything, and a package ending up on the new route is the "free money" case,
  which is fine and intended as the exception rather than the rule.
- **Never before the first delivery** (`PARCEL_MIN_DELIVERED`), for a sharper version of the reason
  a VIP waits: the second tutorial beat *is* "tap that rider", and a box on the board during it
  teaches the opposite lesson — it is the one thing on the board that tapping does nothing to.
- **`?parcels=0`** clears the board to measure the fare loop alone, the way `?cars=1` clears the
  roads. The layer is off in shot mode by default, since every framing in the sweep was composed
  before packages existed; **`?parcels=1`** forces it back on, which is the only way to point a
  camera at one (`?shot=22` and `?shot=23`).
- **The taxi does not wear its load.** It used to: a small parcel on the rear deck, which at play zoom
  is [about four pixels](#the-load-is-carried-into-the-hud). The load is stated in the HUD instead, at a
  size that can be read, and the car goes back to saying exactly one thing about what it is carrying —
  [the roof sign](#the-taxis-roof-sign), for a rider.

### The box visibly changes hands

Nothing about a package teleports. **The box flies**: out of the world and into the HUD on pickup, and
back out of the taxi into the pad on delivery, growing and fading in. It is the same argument [the
fare's crystal](#the-fares-clock-travels) is built on — nothing is created or destroyed at a hand-off,
which is why that flight is animated rather than a teleport — applied to the one object this layer
hands over. Details in [rendering.md](rendering.md#the-parcel--geometryparceljs).

**The pickup is two moves that cross-fade**, and the join between them is faked on purpose:

1. **In the city** (`parcels.js`, sim time): the kerb box is hidden and a flying copy takes over from
   the same spot — the same pose by *construction*, since the copy stands at the corner at
   `PARCEL_PAD_LIFT` and runs the same `idle` off the same clock. It rises, swells, slides away toward
   the corner of the screen the chip lives in, and fades out. The rise eases *out* (a thing being
   picked up); the drift eases *in*, accelerating away (a thing leaving).
2. **In the HUD** (`cargochip.js`, wall time): near the end of that — 78% along, with the world box
   down to ~a third opacity and still moving — `'loaded'` fires carrying the point the box had reached.
   The chip grows and fades in with a **short slide out of that direction**, capped at 120px, and
   inherits the spin the world copy was still turning at.

The first cut of this handed off **pixel-exact**: same point, same apparent size, same angle, on a
single frame, with the two ends of the seam verified to land on the same pixels. It was seamless and it
read as *too fast* — an exact hand-off has no moment in it where the object is visibly travelling, so
there is nothing to follow. Two shorter moves that overlap and agree only on **direction** take longer
to say the same thing and read as one journey. Which is why what leaves `parcels.js` is a point and a
direction rather than a pose, and why the chip quotes the box's position instead of tracking it.

Two more consequences worth naming:

- **The taxi's flourish fires on the pickup**, not on an arrival at the car: the whole car takes a white
  emissive lift on the [select pop](#the-tap-pops)'s own envelope, so collecting a package reads as the
  same *kind* of acknowledgement as a tap that landed.
- **`delivered` still pays out at once.** The money is earned on arrival, and making the player wait
  out an animation for it would read as lag. The chip goes down on that frame rather than when the
  outbound box lands: the flying box *is* the load leaving, and a corner still holding one while a
  package is being set down would read as the taxi carrying a second.

And the ground marks move rather than blink. A pad **grows out of its own centre** when it arrives and
pulls back into it when it leaves — as does a fare's disc, both ends. At a rider's pickup the kerb
disc now shrinks away on the same frame the drop-off's grows in, which is one clock changing ends of a
trip; two discs switching state in one frame was two events.

### The load is carried into the HUD

`src/game/cargochip.js` — the box itself at 42px under the cash total, up for exactly as
long as a package is aboard, and **flown there from the corner it was standing on**.

A deck parcel is the honest answer to "does the car have one", and at play zoom it is **about four
pixels**, on a car the player is mostly not looking at because they are reading the road ahead of it.
The cyan drop pad lighting up across town says *where*; nothing legible said *what*. This chip was
added beside the deck box to fix that, which left the board carrying two versions of one fact — so the
deck box went and the collected package comes *here* instead. That is also what lets the pickup be one
unbroken move: with nothing to arrive at on the car, the box has one destination rather than two.

- **The real mesh, not an icon.** `createParcel` in its own small WebGL context, lit by the city's own
  sun through `mirrorSceneLights` — the same rig as the [tutorial avatar](#the-opening-tutorial) and the
  [rider-finder chips](#extra-fares-and-prioritisation), so the box in the corner cannot drift out of
  step when the box on the road is restyled.
- **Three-quarter view, at the game camera's own elevation, with the azimuth mirrored** so that both
  visible faces are lit ones — see [rendering.md](rendering.md#the-parcel--geometryparceljs) for the
  angle and the framing.
- **It sits with the money, not with the rider chips.** The bottom-left row is the reach zone and
  everything in it is a control; a chip parked at the end of it would be the one that does nothing when
  pressed. That got sharper rather than weaker once [the box on the road became
  tappable](#two-gestures-ask-for-the-same-bend): a second box on the glass that answers nothing is now
  a box the player has every reason to press.
  Up beside the cash total it is unambiguously a readout, and it inherits `#hud`'s `pointer-events: none`
  so a thumb that lands on it goes straight through to the city.
- **The box and nothing else** — no disc behind it, no rim around it. A rider chip needs its disc
  because the ring around it is a clock, and a clock needs a dial to be read against. A package has
  none, which is the whole of [why it has no diamond](#a-package-has-no-clock-and-so-has-no-diamond),
  so there was never anything for a ring here to say — and with the ring gone the disc is a plate under
  an object that does not need one. Bare, it reads like the rest of the HUD: the cash total and the ⏸
  are marks on the sky too. The only thing between the box and a pale road is `#hud`'s own drop shadow,
  which is what holds the digits up there as well.
- **It turns, slowly, the whole time it is aboard** — a 360° every 20 seconds, with a bob of 0.03
  world units (about half a pixel at 42px) on a 4.6s period. It used to land square and sit dead
  still, on the argument that the kerb box's spin *means* "this is a thing to pick up" and repeating
  it on a readout asks for a second pickup. What that actually bought was a live mesh in its own lit
  context posed to look exactly like a static icon. The distinction survives in the **rate**: the
  kerb box comes round every 11.4s and bobs 0.07, so this one is visibly the slower, calmer of the
  two — and a package cannot be selected at all, so there is no gesture for the misreading to cost.
  Under `prefers-reduced-motion` it parks square and level, checked per frame.
- **The arrival hands over to that turn.** It *inherits* the spin the world copy was still turning at
  and eases the excess away over the same 460ms — a box sitting dead square while the other one is
  visibly still moving reads as a different object — leaving it on the idle turn rather than stopping
  it. The residual is folded to the **nearest quarter turn**, which is at most 45° of travel: the
  box's footprint is square by design, so a quarter turn from square is the same picture, and landing
  the raw angle instead crams up to half a turn into the slide and reads as a flourish rather than as
  the same spin running down.
- **Raised by the hand-off, lowered by the delivery.** `flyIn` is what a `'loaded'` does to it and is
  what raises it; `setCarrying(false)` is what a `'delivered'` does. It opens small (0.45) and fully
  transparent, is opaque by 45% of the way in — so the *arrival* is the growth settling rather than a
  fade finishing — and lands with a hair of overshoot, the same punctuation the money counter's bump
  makes. Under `prefers-reduced-motion` it hands over to the plain pop.
- **Checked in `tools/smoke.mjs`, not in the node suite**: a WebGL context inside a DOM node, carried by
  a Web Animation, has no headless equivalent. Three assertions matter. The **share of the canvas actually
  drawn** — the frustum is computed from the box's own dimensions, so the failure mode is a correct
  element with the box framed off the side of it, which reads as a pass in the DOM. That it **keeps
  turning**: two draws a second apart, differenced per pixel, because a chip that draws once and never
  again is what a correct static icon looks like from the DOM and from any screenshot. That one is read
  per pixel rather than as a mean over the box — the two visible faces swing through the sun in opposite
  directions, so a mean nets most of the turn out (2 of 255 against 18) — and its floor of 8 is set above
  the **2.3** the bob alone reads, so a chip that wobbles without turning still fails it. And that the arrival
  **starts away from its slot, small and transparent, in the box's own quadrant, and ends square in the
  slot at full size**: an identity transform is a chip appearing in the corner while the box vanishes
  across town, and a sign error is one sliding in from the opposite side. The smoke run pins
  `prefers-reduced-motion: no-preference` through CDP for that check, or a headless build answering
  `reduce` would quietly be asserting the fallback.

## Crazy-taxi mode

The **Loco Mode** button, bottom left. **Hold to enable, release to pause.** A short tap costs a
short slice, a long hold flows until the tank is empty. Full tank is 15 seconds of boost. The
decision is now *how long* to press as well as *when*. The button doubles as the dial: a `--pct`
CSS variable tracks the fuel level, dropping as you drain and climbing as a drop-off pours fuel in.

**The meter never refills on its own.** The run opens with **a third of a tank**, each successful
drop-off pours in **another third**, and a [delivered package](#the-rest-of-it) pours in **a
sixth** — that is the whole list of sources, and all three are jobs done. Spend it all and the pill
goes grey and dead (`.is-empty`, `disabled`) until you deliver something. A top-up that lands while
you're still holding the button rolls straight back into boost rather than making you press again.

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

### Spacebar

On a keyboard, **hold Space** — the same hold, for a hand that isn't dragging the mouse into the
corner. `keydown` and `keyup` on `window` route into the same `holdLocoMode()` / `boost.release()`
the pill uses, so the wheelie, the flame, the launch rubber, the tutorial dismissal and the fuel
economy are all one code path with two ways in. Desktop-only by construction rather than by sniffing
for a desktop: a phone with no keyboard never fires a `keydown`, and a phone *with* one has earned
it.

Five things it has to get right:

- **`event.code`, not `event.key`.** The physical bar on any layout, and unlike a `key` of `' '` it
  doesn't need unpicking from the modifiers (Ctrl/Cmd/Alt+Space are the OS's, and are ignored).
- **Auto-repeat is dropped** (`event.repeat`). `boost.press()` would return `false` on every repeat
  anyway, so no wheelie stacks — but a held key firing 30 presses a second through the tutorial
  dismissal and the disabled check is noise the guard costs one line to remove.
- **It only claims the key when nothing focusable has it.** Space is the browser's own activation
  key: tabbing to "Play again" and pressing it has to press *that*, so `spaceIsSpokenFor()` bows out
  when the target is inside an `input`, `button`, `select`, link or contenteditable. The pill itself
  is the exception, and not an optional one — clicking it once moves focus onto it, and without the
  exemption the hotkey would go dead for the rest of the run: the browser synthesises a `click`,
  which nothing here listens for.
- **The Home Screen tip outranks it.** `game/homescreen.js` dismisses itself on Space and holds the
  run behind it, so the press that clears that screen must not also spend fuel on a parked taxi —
  the same `homeTip.state.holding` guard the tutorial uses. Our listener is registered first, so it
  sees `holding` still true and bows out.
- **So does [the pause](#pause).** `frame()` returns before `boost.update`, so a press behind the
  veil would sit in `'active'` burning nothing and then resume into a launch nobody asked for — the
  mirror image of the release `createPause`'s `onChange` performs on the way in. Escape, P, ⏸ and a
  tap on the veil all stay live; Space is not another way out of the pause screen.

The window `blur` release matters more here than it did for the pointer: a keyup that lands on
another window never arrives at all, so alt-tabbing mid-hold is the case where blur is the *only*
end that hold gets. It clears the `spaceHeld` latch too — that latch is what stops a stray keyup
(one whose keydown we bowed out of) from cancelling a boost the player is holding on the pill.

The pill carries `aria-keyshortcuts="Space"`; there is no painted "SPACE" label on it, because the
pill is also the fuel dial and the tutorial's third beat points at it.

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

A delivered package fires the same swarm from the same car to the same pill, for `BOOST_PARCEL_REWARD`
instead — one effect for "you got fuel", regardless of which job paid it. It sits behind the courier
payout's flight for the same reason a fare's does.

Then the pour itself. `boost.topUp(BOOST_FARE_REWARD)` queues the fuel as *pending* and pours it in
at half a tank per second (~0.7s) so the bar visibly fills rather than snaps. A package's sixth takes
half that (~0.35s), which the probe pins as the floor: below about a quarter-second the fill stops
reading as a fill and starts reading as a jump. Since that pour is now the *only* way fuel ever
enters the meter, it carries the rest of the reward and gets three more layers, all timed by
`src/game/boostmeter.js` and shaped in `index.html`:

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
braking (the same constant every other stop uses) hauls it down from 22.1 to 8.5 in under a
second, nose dipping hard the whole way. So letting go a beat too late doesn't buy safety; it buys
a car that's still committed to whatever's in front of it while visibly losing the ability to
dodge. Re-pressing mid-cooldown cancels it and snaps straight back to full send. See
[traffic.md](traffic.md#boost-crazy-taxi-mode) for the mechanism.

The press itself also fires a **wheelie**, a tailpipe **flame burst** and a half-second launch
streak of rubber — all three gated on `boost.press()` returning true, so they fire on the
transition into Loco Mode and not on a re-press during a boost that's already running.

## Pause

`src/game/pause.js`, styled in `index.html` under `#pause` / `#pause-veil`. The ⏸ sits in the top
centre of the HUD, between the money counter and the streak — the one piece of that edge nothing
else was using, and the one spot either thumb reaches without crossing the city. It arrives with
the rest of the HUD (see [the HUD arrives afterwards](#the-hud-arrives-afterwards)) and it is gone
once the run is over, because a paused ending is not a thing.

**It stops the whole frame, not just the clocks.** `main.js` returns out of `frame()` before any
`update()` while it is set, so the traffic, the signals, the fare deadlines, the sky and the boost
tank are all where the player left them. Compare the two holds that already existed: the tutorial's
`fares.setPaused` and the Home Screen screen's `state.holding` both park the *fare loop* while the
city keeps driving, which is right for something talking over a live game. A pause that did that
would hand back a junction with a car in it that arrived while nobody was looking.

Three details in that early return are load-bearing:

- **The frame is still rendered.** `preserveDrawingBuffer` is off, so a resize or a rotation with
  the veil up repaints the canvas from an empty buffer — the city would blink out and stay out
  until the player resumed. One static render per frame is the cheap way to be right through both.
- **`clock.getDelta()` is still read**, above the return. It measures from its own last call, so
  skipping it would hand the first frame after a resume the whole length of the pause. The 0.05s
  clamp caps that — it is there to survive a stalled tab, not to license stalling on purpose.
- **A held boost is dropped** on the way in. The veil takes the pointer release the pill was waiting
  for, so without it the run would resume into a boost nobody is holding.

Only the Resume pill resumes — a stray tap elsewhere on the veil must not drop the player back into
traffic — and it resumes on `pointerdown` rather than `click` — the release then lands on the canvas
with no `click` synthesised after it, since the two ends of the gesture are on different elements,
which is what stops the tap that resumes from also dispatching the taxi at whatever it was over.
Escape and P toggle it from a keyboard.

## The run-end screen

`src/game/runend.js`, styled in `index.html` under `#run-end`. The run ends three ways — a fare's
clock hitting zero, a collision, a police bust — and all three land on the same screen: a title, the
reason, the run's four stats, the [high-score table](#high-scores), and **Play again**. The title is
set by the caller, so a timeout reads **Too Slow!**, a collision reads **Wrecked!**, and a police
bust reads **Busted!**.

All three also **hold the screen back for a beat** while the camera pulls into whatever ended the run
— the wreck, the cruiser, or the corner a fare's clock ran out on. See
[the closing shot](rendering.md#the-closing-shot) for the framing and the three sets of numbers; the
one thing that belongs here is that a timeout's shot is of the **drop-off the taxi never reached**,
which is the only place in the game where the answer to "what went wrong" is somewhere other than
where the taxi is standing.

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
gap is a gutter rather than a void. On a phone the rows run right out to the screen edges, which is
the layout the cap is borrowing. The title and reason are the one exception — see below — and are
free to run past this box on a wide enough title, still centred on the same axis.

**The title is the headline; the reason is a caption under it, not a second headline.** The title's
clamp was raised so "Wrecked!" reads as the loudest thing on the card, and the reason sits at a
noticeably smaller size beneath it. `matchReasonWidth` in `runend.js` caps the reason's width at the
title's own rendered width — measured, not assumed, since "Busted!" and "Patience wasn't your fare's
strong suit." are nowhere near the same length — and CSS `text-wrap: balance` picks the break point
inside that cap, so a two-line reason comes out as two even lines rather than a long first line and
a short orphan word on the second.

Type and rhythm scale with the viewport, off whichever axis is tighter: height for the list as a
whole (a landscape phone runs it past the fold) and width for the rows (the longest, `"Shift  Early
Shift"`, is the one `nowrap` risks pushing off a 320px screen rather than wrapping it). If it still
doesn't fit, the overlay scrolls — centred by `margin: auto` on the content rather than
`justify-content`, which clips its own overflow at the top, where the title is.

**Nothing appears at once.** The card is revealed as a sequence, because the version before this
one wrote a single line of `innerHTML` and the whole screen arrived in one frame — which reads as
the game stopping rather than as a scoreboard. The order is title → reason → each stat in turn →
the initials prompt, if the run placed → the table → **Play again**, and each stat's label **scales
down** into place as it fades up before its number rolls from zero. A number that rolls gets read; a
number that is printed gets skipped past on the way to the button. The button is last on purpose,
appearing only once the table has landed, so the player isn't invited to leave mid-tally.

**The stats, the prompt and the table are one slot taking turns**, not a list that grows. `#run-end
.run-end-body` holds whichever screen is current and cross-fades to the next. Stacking them was the
first shape and it does not fit: a title, a reason, four stat rows, a prompt and five table rows is
well past what a landscape phone shows at once, and this card's whole layout exists to keep **Play
again** above the fold. Swapping also makes each beat a screen of its own, which is the point of the
sequence — read your run, sign it, see where it placed. The slot is pinned to a `min-height` taken
from the stats' own rendered height, because a card centred by `margin: auto` re-centres on every
height change, and without the floor the title hopped up and down between beats.

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
anywhere skips the beat that is running** — finishing its animations and landing its numbers — and
the retry pill is `disabled` (and so `pointer-events: none`) until then, which both keeps an
invisible button from reloading the run mid-tally and lets a tap aimed at it fall through to the
skip.

**The skip is per-beat, not a jump to the end**, and the initials prompt is why. Every other beat is
on a timer; the prompt is waiting on the *player*, so nothing skips it and no timer runs past it.
That is why the handler is a single mutable `skip` that each beat installs on its way in and the
prompt leaves null, rather than one listener that finishes every animation on the screen. The first
shape landed the whole timeline at once, which blew straight through the field and threw away the
name being typed into it.

The counters are anchored to their **first animation frame**, not to `performance.now()` at build
time. A WAAPI animation starts on the frame after `animate()`, and the game-over frame is exactly
where the page hitches — on a stalled boot the numbers ran ~500ms ahead of their own labels, which
for a list played one row at a time meant a row counting before it had appeared.

The overlay sits at **`z-index: 30`**, above the tweak toggle and rider-finder chips (20). Without
one the blackout painted *under* them and a waiting-rider chip stayed lit in the corner of the
game-over screen — and a chip still on top also swallows the tap that skips.

Under `prefers-reduced-motion` the card prints its final values with no entrance and no roll — the
sequence is the entire module, so there is nothing else to keep. **The screens stack there instead
of swapping.** The whole sequence resolves in one frame under reduced motion, so a swap replaced the
stats with the prompt before the stats had been on screen for a single frame, and a player who
opted out of animation never saw their own run summary. Reduced motion means no movement, not less
content: everything is simply present at once and the card scrolls if it has to. The prompt still
gives way to the table, since a filled-in form sitting above the table it produced is clutter rather
than content. A high score still has to be signed — the animation is what was opted out of, not the
chance to put a name on the run.

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

## High scores

`src/game/highscores.js`, shown on [the run-end screen](#the-run-end-screen). Five runs, on this
device and nowhere else: no server, no account, no sync. `localStorage` is the whole backend, which
makes the failure modes the interesting part of the module rather than the ranking.

> **Trap.** The table is *titled* **Leaderboard** on screen, but it is **not** `leaderboard.js` and
> nothing in the DOM is called `.leaderboard` — the classes are all `.score-*`. "Leaderboard" is the
> IAB's name for a 728×90 ad unit and filter lists carry generic rules against it, the same trap
> that keeps `beacon.js` and `#banner` out of this codebase. What those rules match is URLs, ids and
> class names, not text content, so the visible word is safe and the filename is not. A blocked
> module takes the whole graph down with `ERR_BLOCKED_BY_CLIENT` and nothing in the console says why.

**One score, and for now it is the cash.** `scoreOf(entry)` in `highscores.js` is the only thing the
order is computed from — a function rather than a field read inline, because the point of naming it
is that the table ranks by a *score*. If that becomes a formula over fares, time and cash later,
that one line is what changes, and every run already stored keeps its place in the new order.
`fares` and `seconds` are still recorded on every entry for exactly that reason, even though nothing
reads them today.

**No tie-breaks.** An earlier pass broke ties on fares and then on the shorter run, and it went with
the fares column: a table that ranks by one number and then silently reorders equal numbers by a
quantity it does not show is a table the player cannot check. Two runs on $40 sit in the order they
were played — ties go to the incumbent, since the comparator returns 0 and `sort` is stable, which
is the convention every arcade table has used since arcade tables existed.

**A row is rank, name and score, and nothing else.** A fares column sat between the name and the
cash and came out with the tie-breaks: a second figure beside the score invited the player to work
out how the two combined into the order in front of them, and they don't combine. The row now shows
exactly what it is sorted by. The heading and the rank column are left-aligned, against the same
edge the list's own columns start on; centred, the heading floated free of the block it labels.

**Five rows, not ten.** The card is capped at 358px and its own layout is already fighting to keep
**Play again** above the fold on a landscape phone; ten rows loses that fight. Five is also about as
far back as anyone cares on a table only they will ever see.

### Not every run counts

A pinned difficulty, a pinned car count, a fare clock dragged around in the ⚙️ panel, or shot mode —
each of them changes what a dollar is worth, and a table with a tuning session sitting at the top of
it is worth nothing to the player who earned row two honestly. `isRankedRun()` in `main.js` reads
all four. An unranked run still gets its stats counted out; it just isn't recorded, and the screen
goes straight from the tally to **Play again** rather than showing a table this run could never have
joined.

The difficulty check is `difficulty.getPinned()` rather than `getDifficultyPin()` from `util/shot.js`.
The URL flag is only one of the two ways the curve gets pinned, and the ⚙️ slider — the one anybody
actually reaches for — calls `pinDifficulty` directly without touching the URL. Reading the live
state catches both.

### Signing a run

**Any run that makes the top five is asked for three initials**, not only a new number one. A board
where one row is named and four are `AAA` reads as broken, and a run that climbs from fifth to
second deserves a name as much as one that takes the top.

- **One `<input maxlength="3">`, not three fields.** One focus target, and backspace, arrows and the
  mobile keyboard all behave without a line of code. The arcade look comes from three spans painted
  from the value on every keystroke — letter-spacing a single field into three slots depends on the
  glyph advance of a font this game does not control (`ui-rounded` is SF Pro Rounded on iOS and
  something else everywhere it is developed; see the fit-to-width saga in `homescreen.js`), so the
  underscores drift out from under the letters on any face but the one it was eyeballed against.
- **`text-transform: uppercase` is not what makes the name uppercase.** That only changes what is
  painted; the value would still save as typed. `normaliseName` on every `input` event is — it
  uppercases, drops anything outside `A–Z0–9`, and caps at three. It runs on the way *out* of
  storage too, so a hand-edited `localStorage` can't put an eleven-character name through the row
  layout.
- **The last initials are remembered** under `simtaxi.initials` and pre-filled, so a repeat player
  confirms rather than retypes. The caret goes to the end of a pre-filled name rather than selecting
  it, so the first keystroke of someone changing their initials doesn't wipe all three.
- **The score is written before the prompt, not after it.** The player is being asked to type on a
  screen they can close at any moment, and a table that only saves once the prompt is answered loses
  the run of anyone who shuts the tab on it. Naming is an edit to a saved score, not a condition of
  saving one.
- iOS only opens the software keyboard inside a user gesture, so `focus()` is best-effort there. The
  transparent input is stretched over all three cells, which makes a tap anywhere on them a tap on
  the field — and **OK** is the way out for anyone who would rather not type at all.

**The keyboard is clamped against, not scrolled around.** iOS does not resize the *layout* viewport
when the software keyboard opens — it slides a shorter *visual* viewport up over an unchanged one —
so `#run-end`'s `position: fixed; inset: 0` still measures the whole screen and `margin: auto`
centres the card on a point behind the keys. The first fix was `scrollIntoView({ block: 'center' })`
on the cells and it could not work: the centre of that scroll container *is* the covered half, so
the field landed under the keyboard however the scroll went. `followKeyboard` in `runend.js` reads
`visualViewport` for as long as the field has focus and sets `--kb-top` / `--kb-height` on the
overlay, and `#run-end.is-keyboard` clamps `top`/`height` to them — the card then re-centres in the
band that is actually visible, with no change to how it is laid out. Measured on a fake viewport at
390×844 with a 336px keyboard: the initials sat at y 508, exactly on the keyboard's top edge, and
**OK** at 572, entirely behind it; clamped they sit at 340 and 404, with the "New high score!" line
still on screen.

- **The clamp is conditional.** Android *does* resize the layout viewport, so there the two agree
  and the clamp stays off — applying it anyway would subtract the keyboard's height twice.
  `KEYBOARD_MIN` (80px) is the gap that counts as a keyboard rather than a URL bar collapsing.
- **The scroll still runs**, as `block: 'nearest'` on the prompt rather than `center` on the cells:
  on a short viewport the card can outgrow even the visible band, and `nearest` pins the top of the
  prompt instead of pushing "New high score!" off the top of it.
- **The release is called on commit, not just on `blur`.** Removing a focused element does not
  reliably fire `blur`, and the board arriving inside a card still clamped to half the screen is a
  worse bug than the one being fixed.
- The blackout is the clamped element, so it stops painting where the clamp ends — a spread
  `box-shadow` in the same colour carries the black past it, because iOS sends the first `resize`
  while the keys are still sliding up and the strip underneath would otherwise flash the live city.

### A dead store is an empty table

`localStorage` is not a property you can rely on. Safari's private mode throws `SecurityError` on a
*write* while reporting a perfectly good object, blocked third-party storage throws on the property
access itself, and a full quota throws on `setItem`. Every call in the module is guarded and every
path degrades to "no table", because a game that dies on the game-over screen because a score could
not be saved is a far worse bug than one that quietly keeps no scores. A store that refuses the
write still gets a board for that one screen: the run happened and the rank was earned, it just
won't be there next time.

The store is **injectable**, which is what lets `tools/scores.mjs` drive the whole thing in node
against a fake — including the throwing cases and a corrupt payload, which is the half of the module
a browser on the machine this is developed on would never reach. The real `localStorage` round trip
is covered once, in `tools/smoke.mjs`, by writing a score and reloading the page.

The key is versioned (`simtaxi.scores.v1`) so a future shape change reads as "no scores yet" rather
than as a crash. **Clearing lives in the ⚙️ panel**, not on the run-end card: it is the only
destructive control in the game, and putting it next to a big yellow **Play again** is a misclick
that cannot be undone.

`shift` is stored on each entry and not shown. It is the one fact that tells two otherwise-similar
runs apart, and the row is too narrow to carry it — four columns is already what fits at the top of
the font-size clamp — so it is kept only so a future row can show it without orphaning every
existing score.

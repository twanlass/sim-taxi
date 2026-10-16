# Gameplay: history

How the game described in [gameplay.md](gameplay.md) got to where it is: superseded designs, first
attempts that did not survive, removed features, and what the `?x=classic` flags put back. The text
was moved out of gameplay.md more or less as written, so it keeps the voice and the measurements it
had when it was current; "now" in a passage below means *then*. Sections follow gameplay.md's order,
and each links back to the section that describes the game as it is today.

Dates and PR numbers are given where the text or the commit log records them.

## The startup screen

[Now](gameplay.md#the-startup-screen): black, then the taxi drops onto a patch of asphalt and
boosts off it, then the title menu.

Before it (to 2026-10-16) a cold start showed the sky's `#DCEDF7` — the iOS launch screen, the web
view behind the page and the page itself were all that colour, chosen so the frame before WebGL's
first paint matched the city's horizon — for however long the game took to load, and then cut
straight to the title menu. Reported as "it just shows blue sky when it first starts". `?splash=classic`
skips the drop and goes straight to the game; the black underlay stays.

The drop was first shot from the game's own three-quarter camera, the car leaving north (off the
top right). Tyler asked to try it side-on; the low side camera became the default the same day, and
`?splashcam=classic` keeps the three-quarter view.

## The opening vignette

Pacing numbers the vignette shipped with and later changed. Now: [The opening vignette](gameplay.md#the-opening-vignette).

Both eased legs normally retire on **arrival** rather than on their cap, and the caps sit just past
where that happens: they are a backstop against a resize or a device dropping frames, not the thing
that sets the pace. The approach's rate came up from 1.7 to 2.4 for the same reason the `settle`
beat came down from 0.3 — the tail of an exponential is the part nobody is watching, and at 1.7 the
last third of a second was the frame creeping the final 2% of a zoom with the door sitting there
shut.

## The opening tutorial

The tutorial's first beat is switched off (`TAXI_BEAT`) since the vignette started showing the player their own car; what follows is what the other beats, the bubbles and the HUD entrance used to do. Now: [The opening tutorial](gameplay.md#the-opening-tutorial).

2. **"Tap rider to start"** The lights come down and the spotlight lands on the waiting fare as the
   camera sets off for them, so the light is already on the rider and the pan carries the player to
   it; the bubble comes back once the camera has arrived. Tapping the rider answers it directly.
   With beat one switched off this is the beat that *lights* the pool, and for a while it wasn't:
   `spotlight-on` went on the body in `openOnTaxi` alone, so switching `TAXI_BEAT` off took the
   darkening away with it and left the one instruction a run still gives pointing at a rider in a
   fully lit city — the pool aimed correctly at them, sized correctly, at opacity 0. Whatever beat
   comes first has to be the one that turns the light on.

The city's own entrance and then the vignette come first: the whole tutorial is held frozen (via its
`isBlocked` hook — the same one the "Add to Home Screen" screen uses) while the buildings rise out of
the ground ([the entrance animation](rendering.md#the-city-entrance--gamecityentryjs)) and the taxi
comes out of its garage, then `OPENING_HOLD` — now just a 250ms breath — separates the camera landing
from the lights coming down. The hold used to be a full second of static city, because a run that opens
mid-sentence gives the player nothing to attach the sentence to; three-plus seconds of the city
building itself does that job better than the second of idling traffic did. The clocks are already
held through all of it, so it costs nothing. The camera is already easing onto the taxi during it —
that is the one thing that should be under way before the bubble speaks.

### Speech bubbles

Now: [Speech bubbles](gameplay.md#speech-bubbles).

The pointer always sits in the
**middle** of its side and only turns, leaning towards its target but no more than 40° off square
to the card's edge; it used to sit where the line to the target crossed the card, which made it
crawl along the edge as the camera panned. `placeSpeech` is the pure half of it.

There used to be four fixed places a bubble could be, and a turning 3D avatar in each (the taxi, the
rider under their crystal, the robber, a cop car) saying who was speaking — each its own WebGL
context. Pinning made them redundant: the pointer already says who, by touching them.

### The HUD arrives afterwards

Now: [The HUD arrives afterwards](gameplay.md#the-hud-arrives-afterwards).

The money counter starts off the top edge, and the ⏸ off the bottom, and they
slide in together the moment the last bubble is dismissed (the
[rider chips](gameplay.md#finding-the-next-rider) rode in with them, and still do under `?chips=on`). A run used
to open with all of them already lit, every one reading zero and answering a question nobody had
asked yet. `main.js` adds `body.hud-ready`; with no tutorial to wait for (`?tutorial=off`, shot mode)
they are simply there from the first frame.

**The two pedals come in earlier**, on `body.pedals-ready`: the frame the
[opening vignette](gameplay.md#the-opening-vignette) hands the taxi back to the lane, with its pull-back still
running (`pedalsDue` in `main.js`). They used to wait for `hud-ready` too, which meant the pull-back,
the tutorial's breath, the pan to the rider, the line typing itself out and the tap that answers it —
several seconds of a live taxi with nothing to press, which read as the game not having started. A
counter can wait for a lesson; a control is the thing the lesson is standing in front of. A press on
the pill during the rider beat ends that beat (`holdLocoMode` calls `tutorial.dismiss()`), which was
already true for the spacebar. Not before the handover — a staged car burns fuel going nowhere — and
not under a skip's black, the Home Screen tip or the city's own entrance. The stylesheet treats
`hud-ready` as implying `pedals-ready`, so nothing that sets the one has to know about the other.

### The third beat is not like the other two

Now: [The third beat is not like the other two](gameplay.md#the-third-beat-is-not-like-the-other-two).

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

### It runs on every new game

Now: [It runs on every new game](gameplay.md#it-runs-on-every-new-game).

Not just the first. Remembering it across loads was tried — a `localStorage` flag under
`simtaxi.tutorialSeen`, on the grounds that play-again is a `location.reload()` and a lesson learned
once should not be charged for on every retry — and taken back out. The opening is two taps long, it
[does not spend the player's clock](gameplay.md#it-does-not-spend-the-players-clock), and it is the only thing
in the game that frames the taxi and says which car is yours; a player back after a week gets that
for free rather than hunting the board for their car.

`?tutorial=off` skips the whole thing, and shot mode never runs it: a screenshot has nobody to
teach, and the bubble would be the loudest thing in every frame.

## New Move Unlocked: the overtake, U-turn and drift cards

How the U-turn clip's motion was made before it was recorded from the sim. Now: [New Move Unlocked: the overtake, U-turn and drift cards](gameplay.md#new-move-unlocked-the-overtake-u-turn-and-drift-cards).

The motion is **the game's own U-turn, recorded**: `tools/uturnreel.mjs` drives the shipped
traffic model, Loco Mode and bootleg on the passing lab's straight road with the pedals pressed on
the card's timeline, and writes the taxi group's transform, wheel lock, brake lamp, flame and rubber
for every frame to `game/uturnreel.js`. `npm run check` films it again and fails if the file no longer
matches (`node tools/uturnreel.mjs --write` refreshes it). A hand-scripted timeline came first and
read as fake: quicker than the real spin, and rocking where the real car does not. It is not the sim
running live because the world is frozen under the card and a second traffic instance would write
over the real one's module-level state. At the game's real speeds the run is three blocks long, so
`pickStreet` also needs the street to carry straight on, open, through the junctions at each end. The pedal row (the HUD's own pedal art, all three at one size with a
"+" between) is pressed off the **clip's clock**, so each key goes down on the frame the car does
the thing it does: dim until pressed, lit from then to the end of the loop.

## The drop-off dispatches itself

Before the drop-off dispatched itself, a pickup parked the taxi and waited for a second tap on the destination pin. The onward stub past the kerb came in with #480 (2026-10-11); `?route=classic` keeps the route that stops at the kerb. Now: [The drop-off dispatches itself](gameplay.md#the-drop-off-dispatches-itself).

**The taxi no longer parks at a pickup.** It used to sit at the kerb with `parked = true` until
told where to go; now a pickup is a pause in a drive rather than a full stop and a restart. In
practice it was never much of a stop anyway: the pickup fires with the taxi *inside* the junction
(`state === 'turn'` at every pickup across four run seeds, still doing the full 8.5 u/s), where the
`parked` check isn't consulted at all — it coasted across, braked on the far side, and then pulled
away again on the tap. The one surviving `parked = true` is the fallback for a drop-off the router
can't reach, which a shipped city never has: `main.js` rerolls any seed where `findRoute` fails a
pair. It exists so an unroutable taxi is still recoverable by hand rather than cruising on random
turns until the clock runs out.

**The route carries on through the pickup.** The pickup fires with the taxi already inside the
junction, so the exit it takes there is decided at the hold line — and with the route ending at the
kerb, that used to be the ambient dice roll (`rollExit`). Boosting into a pickup, the player found
out which way the taxi was leaving as it left, sometimes straight round a corner into a car. A route
at a waiting rider now carries on along the drop-off route (`carryOn` in `game/route.js`, the onward
steps tagged as `route.onward`), so the taxi leaves the kerb the way it is about to drive anyway,
and the [band](gameplay.md#the-route-band-wears-it-too) shows it as a dim stub `ONWARD_LEN` (18 units) past the
kerb. A stub rather than the whole leg, because the whole leg *is* the drop-off, which stays hidden
until boarding ([Neither how far nor where](gameplay.md#neither-how-far-nor-where)): the stub gives away a
direction, never a destination. `?route=classic` puts back the route that stops at the kerb.

## Neither how far nor where

Two ways of showing more of a trip before pickup were tried and taken back out. Now: [Neither how far nor where](gameplay.md#neither-how-far-nor-where).

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
[diamond](gameplay.md#the-fares-clock-travels) says urgency without any parse at all.

What went with it is real and worth saying plainly: the payout is no longer legible before the
choice. Fares are still priced by distance, so a long haul still pays more — the player just finds
out on delivery. "Which rider?" is a timing question now, not an economic one.

### Corners the camera cannot see

Now: [Corners the camera cannot see](gameplay.md#corners-the-camera-cannot-see).

A fare survives that. Its crystal floats at 9.65 and the tallest thing that ever stands in front of
a kerb corner tops out 5.6 units above it, so a rider always has *something* above the skyline
speaking for them. It used to have a second thing: a chip in the HUD's rider finder that could
dispatch the taxi at them without the map being involved at all, which is [exactly why it
went](gameplay.md#finding-the-next-rider). A courier pad has none of that:
[`marker.js`](../src/geometry/marker.js) took the drop-off's floating head away on purpose, and what
is left is a mark on the ground.

## Extra fares and prioritisation

Now: [Extra fares and prioritisation](gameplay.md#extra-fares-and-prioritisation).

### The board steps back while the seat is full

Now: [The board steps back while the seat is full](gameplay.md#the-board-steps-back-while-the-seat-is-full).

**The crystal keeps its size and its hue; the glow and the bounce are what go.** It was shrunk to half for a
first cut and that came back wrong: it read as a *different, smaller kind of marker* rather than as
the same one turned down, and it took the hue — which is the clock — down with it in screen area.
The glow is the right thing to spend instead, because the bloom's spill is an order of magnitude
wider than the thing spilling ([rendering.md](rendering.md#bloom--gamebloomjs-and-the-comparison-in-gamehdrjs)), so it is most of
what makes a marker carry across the city. The hop is the other half of the same claim — a thing that moves on its own is a thing asking to be
pressed — so it damps out on the same curve. Between them they are the loudest pair available that
doesn't touch what the marker *says*. `setEmissiveScale` is how the glow goes, rather than
`unmarkEmissive`/`markEmissive` per transition: these markers are pooled and switch several times a
run, and the scalar can be eased where a flag cannot.

### Finding the next rider

Now: [Finding the next rider](gameplay.md#finding-the-next-rider).

**The rider-finder chips are off.** They were a row above the Loco Mode pill, one per waiting fare:
the real animated figure in a 38px WebGL context, that fare's countdown as a conic-gradient ring
around it, and a tap that dispatched the taxi straight at them. They are still in the tree
(`game/riderfinder.js`) and `?chips=on` brings them back to compare against, but nothing builds them
on an ordinary run.

They worked, and that was the problem. A chip answered all three of the questions the board is
supposed to ask — *where is the next fare*, *how urgent is it*, and *shall I take it* — on a surface
that fits in a thumb's reach, so the optimal play was to never look at the city: sort the row by
colour, tap the reddest ring, repeat. Prioritisation stopped being a judgement about distance,
traffic and the trip you are already on, and became reading four ring fills.

### Why the first fare is close, and why that alone made it harder

Now: [Why the first fare is close, and why that alone made it harder](gameplay.md#why-the-first-fare-is-close-and-why-that-alone-made-it-harder).

**The radius used to be load-bearing, then a ramped knob, and is now a constant (`SPAWN_RADIUS`, 3
blocks).** Under the old flat clock an
extra rider *had* to land near the current drop-off: their 60 seconds had to cover the tail of that
delivery plus a fresh pickup drive, and charging them for a whole drop-off leg was ruinous —
measured 7-fare median → 3 at 1.5s reaction. A rider dropped in the far corner had a clock the taxi
could not possibly reach in time, which turned "prioritise" into "roll the dice". Budgeted clocks
pay for the distance explicitly, so how far out a rider lands changes how long their clock is and
not how hard it is.

### The taxi's roof sign

Now: [The taxi's roof sign](gameplay.md#the-taxis-roof-sign).

The **roof sign** lights up while a rider is aboard and goes dark once they're dropped off — a
plain on/off, not a colour. It used to wear the fare's own colour, drawn at spawn from a five-colour
palette (`nextFareColor()`), because that colour was what paired a rider with their drop-off pin
across the map. The drop-off carries no fare colour any more, so with nothing left to pair with,
the sign's job shrank to the one thing still worth saying at a glance: is the taxi free.

### The drop-off is a ring, and it wears the rider's clock

Now: [The drop-off is a ring, and it wears the rider's clock](gameplay.md#the-drop-off-is-a-ring-and-it-wears-the-riders-clock).

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

What that missed is that a colour does not have to *distinguish* to be worth reading (the argument
that replaced the teal is in gameplay.md).

### The route band wears it too

Now: [The route band wears it too](gameplay.md#the-route-band-wears-it-too).

`src/game/routeline.js`, painted per frame from `fares.colorOf()` on whichever fare the taxi has
been [sent at](gameplay.md#arrival-requires-direction). It was the taxi's own yellow before — the band belongs
to the car, not to the road — and the car is not the news. A route only exists because a fare is
draining at the end of it.

## Routing

Now: [Routing](gameplay.md#routing).

`src/game/route.js` is Dijkstra over the road network's **lanes** — 120 of them at 5×5, instant.

A lane is a directed half of one road, so it says both which junction you are heading toward and
how you got there. It has to say both, because `legalExits` forbids U-turns: a plain junction node
would plan routes that flip direction on the spot, and the car could never execute them. This is
the same state the router used to spell `(i, j, d)`; what changes is where the successors come
from. They are now `lane.onward` — the turns the network baked at that junction — rather than
`(d + 1) % 4` arithmetic. A three-way, a diagonal or a roundabout has legal moves that direction
arithmetic cannot name; a lane's exits are whatever the geometry says they are.

### Dragging the route

Now: [Dragging the route](gameplay.md#dragging-the-route).

`src/game/pathdrag.js`. **Press the band and pull it sideways.** The junction under your
finger becomes a waypoint, the route is re-planned through it, and the band redraws on the same
frame — so you can take the taxi round a block that has gone solid without giving up the fare you
are driving.

Until this existed the band was the only thing on screen saying what the taxi was about to do and
the only part of the interface you could not touch. Tapping a rider says **where**; this says
**which way**, which is the question a player is already asking the moment they can see a queue
building on the road the band is about to take. It is the one decision the game was showing them
and not letting them make.

## Picking

Now: [Picking](gameplay.md#picking).

### The tap target

Now: [The tap target](gameplay.md#the-tap-target).

It used to be a 20 × 14.5 × 20 **box centred on the junction**, and with two markers close together
that picked the wrong one — reported from a phone as a tap on the yellow rider dispatching the taxi
at the green one below them. Two faults, and fixing either alone leaves the bug standing:

- **The box was centred on the wrong point.** What the player aims at is the figure on the kerb, and
  `cornerFor` (in `game/fares.js`) pushes that 4.5 units off the junction on *both* axes — up and
  to the left on screen. The region was offset from its own marker by 6.4 units of ground.
- **Height reaches up the screen.** The camera looks down a 33° diagonal, so a box 14.5 tall throws
  its top face 11.1 units of ground up-screen of its base. Its silhouette covered a strip well past
  the junction it belonged to, and since [`pick.js`](gameplay.md#picking) takes the *nearest* hit and a box
  down-screen is nearer the camera, that box won the strip. Measured over a 3 × 3 patch of markers:
  a tap dead on a rider's own disc was answered by the marker one junction down-screen, and the
  rider's own region did not reach more than ~20px below their feet.

## The fare's clock travels

The fare's clock has had several bodies: a shaft of light, a draining kerb ring, a seven-segment count, a meter, a timer ring on the road around the taxi, and the crystal it is now. Now: [The fare's clock travels](gameplay.md#the-fares-clock-travels).

### The disc says it again, on the ground

Now: [The disc says it again, on the ground](gameplay.md#the-disc-says-it-again-on-the-ground).

The kerb disc was taken off for a spell on the argument that a disc ought to mean "the taxi is being
driven here" and a rider nobody has tapped is not that. It reads better than it argued: the eye is
down on the road, and that is where the colour is worth having.

### It used to be a relay

Removed from gameplay.md; the current account is in [The fare's clock travels](gameplay.md#the-fares-clock-travels).

Two objects did this job in turn: this diamond over the rider, and a **timer ring** — a swept
annulus lying on the road around the taxi, which took over at pickup while the diamond vanished.

The ring was the finer instrument, and losing it was a real cost. It drained *continuously*: a
`setDrawRange` sweep clockwise from screen-top over 96 segments, so the arc's length was the time
left, and a player could see a clock at 40% rather than at "orange". The diamond had four steps, and
on the riding leg that was strictly less information. [The liquid](gameplay.md#the-crystal-is-a-glass-of-time)
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

### Getting the empty half to look empty

Now: [Getting the empty half to look empty](gameplay.md#getting-the-empty-half-to-look-empty).

The first build was opaque: the hue at half lightness above the line. It read as a **dark solid**,
not as an empty vessel, which is the whole point of the thing.

- The empty glass was **desaturated** at first (`s × 0.55`), and the empty half of a nearly-dead
  marker came out a dusty rose — the most urgent state on the scale rendering as the least red thing
  on the board. That measurement stood for a long time and the rule drawn from it has since been
  overturned; see the next section, which is the story of why.

### Why alpha is the contrast knob, and what it cost to find out

Now: [Why alpha is the contrast knob, and what it cost to find out](gameplay.md#why-alpha-is-the-contrast-knob-and-what-it-cost-to-find-out).

The first shipped vessel put the glass at `0.45` alpha, `s × 0.9`, `l × 0.6`. At play zoom an amber
crystal in front of a **tan roof** read as one solid amber diamond: the level was in there, and you
could not see it. It took two passes to fix, and the second one reversed a rule the first one had
just written down.

**Pass one** went to `0.28` alpha and `l × 0.42`, widened the surface band from 0.32 to 0.40 local
units (2.5px to 3.1px), and left the saturation alone on this argument:

> The two halves are the same hue **by design** — the alarm has to carry across the whole
> silhouette, which is what the dusty-rose failure above is about. So every other knob here
> separates the halves by *value*, and a value gap can be swallowed whole by whatever the marker
> happens to be floating over. **Alpha cannot.** What alpha lets through is the city behind the
> crystal, which is by definition not the liquid's colour, so lowering it widens the gap whichever
> direction the backdrop happens to lie in.

That half of it is still right and is still the reason alpha gets turned first. The tan roof was
fixed. On a phone it was still called too subtle, and the reason is in the sentence the argument
opens with rather than anywhere in the numbers.

**Pass two** is `0.15` alpha, `s × 0.3`, `l × 0.38`. The rule about the hue carrying across the
whole silhouette was written against an **opaque** build, and it was never re-tested at a third of
that alpha. It does not survive the re-test: at 0.15 there is almost no ink in the empty half to be
dusty-rose *with*. So what a saturation cut buys there is not a second hue competing with the alarm.
It is a **segmentation** — the crystal splits into a saturated part and a glassy grey part, and the
eye makes a categorical judgement at a glance where it has to *measure* a value difference. Value
comparisons are precisely what kept failing at 22 pixels.

### The far wall, and why it isn't there

Now: [The far wall, and why it isn't there](gameplay.md#the-far-wall-and-why-it-isnt-there).

Only the **near** half of the liquid's surface is drawn, and the near half of a horizontal plane
projects low — so at half full the level reads closer to a third. Drawing the back faces as a second
pass closes that chevron into the rhombus a real meniscus makes, centred on the level the clock
actually says. It was built, and taken out again.

It cost more than it bought. The far wall's liquid is a solid slab filling everything below its own
(higher) surface line, so the see-through top — the entire point of the vessel — shrank to the
narrow wedge above it, and the two meniscus bands closed into a hard bright rectangle across the
middle that read as a label rather than as liquid. More correct, less legible.

### What the crystal does

Now: [What the crystal does](gameplay.md#what-the-crystal-does).

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
[drop-off](gameplay.md#the-drop-off-is-a-ring-and-it-wears-the-riders-clock) wore the same model for a spell
and gave
it back, because a second crystal reporting nothing made the shape ambiguous.

### What it replaced on the kerb

Removed from gameplay.md; the current account is in [The fare's clock travels](gameplay.md#the-fares-clock-travels).

Four things, in this order:

- **A shaft of light** over the rider, which marked them at range and said nothing else.
- **A draining ring on the kerb**, an earlier body for the same clock. A disc is back under the
  rider now and it is worth being clear about what changed: that one *was* the clock, a countdown
  the player read by how much of it was left, and it was the only thing marking the corner. This one
  reports nothing on its own — it repeats the crystal's colour, and the crystal is the clock. See
  [The disc says it again](gameplay.md#the-disc-says-it-again-on-the-ground).
- **A seven-segment block count**, which was more precision than the decision needed and cost a
  read to parse.
- **A meter**: a dark plate carrying a four-segment urgency bar over a three-segment distance bar.
  It is the one of the four this was a genuine trade against rather than a straight win — see
  [Neither how far nor where](gameplay.md#neither-how-far-nor-where) for what the distance bar was doing and
  why it went. What the diamond wins is the read: a hue is taken in at a glance where a count of
  lit blocks is parsed, and the level was always the news rather than the number.

The meter was a bright ~67 × 27px slab; the diamond is ~29px across. Smaller, but saturated,
outlined, bouncing and kicking on every level change, which is what a marker needs to be found at
range — and three of them no longer crowd a city whose blocks are only ~92px across.

### Urgency is one scale

Now: [Urgency is one scale](gameplay.md#urgency-is-one-scale).

Four surfaces show it — the fare's diamond wherever it currently is, the
[ring on the road](gameplay.md#the-drop-off-is-a-ring-and-it-wears-the-riders-clock) the taxi is being driven
at, the [route band](gameplay.md#the-route-band-wears-it-too) running between them, and the [edge
arrow](rendering.md#off-screen-fare-pointers) that stands in for any of them off the frame — and
they all read from here, through one `fareColor(level, vip)` that also owns the VIP exception. A
rider showing orange on the map whose arrow is yellow on the edge is two
answers to one question, and a band arriving red at an orange disc is the same mistake drawn across
half the city. It was three surfaces until the [timer ring](#it-used-to-be-a-relay) went, which is
exactly why the scale was pulled out of the ring into its own module in the first place.

The [VIP](gameplay.md#vip-pickups) is the exception all four make together, and it is now a total one: purple
at every level, and the two surfaces that carried a *quantity* rather than a hue — the crystal's
fill and the chip's ring — are both simply held full. A VIP does not say how long you have.

Even quarters rather than the ring's old 0.60 / 0.35 / 0.15 bands: those held the top level through
the first 40% of the clock and then ran through the other three in a rush. The levels outlived the
bar they were segments of — `URGENCY_SEGMENTS` is now just how many steps the scale has.

Per-rider patience is not in yet — every rider drains at the same flat `fareSeconds`. The seam is
`urgencyOf(fare)` in `fares.js`: a patience mechanic changes what goes into that function and
nothing downstream of it, because every surface already speaks in levels rather than seconds.

## Economy

Now: [Economy](gameplay.md#economy).

**It runs backwards too.** The [burger](gameplay.md#the-burger-run) is the one thing that takes cash off the
player, and it takes the same two phases wearing the other sign: a red `−$10` off the taxi, the same
flight to the counter, the same roll, and a red dip on the counter instead of the green swell
(`.money-charged` against `.money-bumped`). Same direction across the screen, deliberately — a
number flying from the counter *to* the taxi would read as the player being handed something.
`rollMoneyTo()` used to snap on any non-positive delta, which was invisible while nothing could
charge; it tweens either way now, and the total never goes below zero (see `charge()` in
`game/fares.js`).

### The combo meter

Now: [The combo meter](gameplay.md#the-combo-meter).

Before Stuntman (2026-10-14, `?stuntman=classic`), smashing through a roadworks barricade earned
nothing but the hop: the closed street's only reward was being empty.

**How it got here**, so nobody walks the same road twice. The [shift](difficulty.md#shifts) used to
stamp 1×, 1.25×, 1.5× or 2× into every price at spawn, with no counter on screen, and VIPs stacked a
streak of their own (3×, 4×, 5× back to back). Both paid for getting further rather than for *how*.
Then a clean-driving streak (×1, ×2, ×3 per drop-off, back to ×1 on damage), which only ever asked
"don't crash"; then three stacking run bonuses — Loco (80% boost, ×2), Perfect (no damage, ×1.5),
Stealth (boost past the patrol unspotted, ×1.5) — which was more to read than to play. Then the
**Perfect Run** (`game/runs.js`, removed): ×2 for a job driven more than half on Loco with no damage,
with a `PERFECT RUN` tag on the HUD and a price, label, extra payout sequence. It was one
yes-or-no rule judged at the end, and nothing on the drive built toward it. The combo meter replaced
it on 2026-10-07.

### Priced by the trip

Now: [Priced by the trip](gameplay.md#priced-by-the-trip).

The player does not see that distance before choosing — a bar over the rider's head used to
advertise a tier of it, and went with the meter (see
[Neither how far nor where](gameplay.md#neither-how-far-nor-where)). So the price is a fact about the trip
rather than a term in the decision.

Calibration: median trip in the current city is ~5 blocks, which pays the old flat `$20` — so the
soak suite's expected earnings are roughly unchanged. What is new is the *shape* of the choice: a
kerbside rider whose destination happens to be next door is now worth less than one going across
town, so "which fare to grab" is an economic decision as well as a timing one. A flat rate made
that decision trivial.

## VIP pickups

Now: [VIP pickups](gameplay.md#vip-pickups).

**And that is the whole of what they will tell you.** A VIP's clock is not shown anywhere: the
question mark is solid purple and never drains, and the rider-finder chip's ring — the last surface
that still reported the seconds, back when the chips were on — was held full and purple as well.
You know one is worth three fares
and you do not know how long you have, which is what makes taking one a gamble instead of a sum. The
only thing that ever breaks the silence is the panic pulse the marker beats under five seconds, and
that is an alarm rather than a countdown: it says *now*, not *how long*.

- **The shortest clock on the board.** Budgeted the same way as everyone else's — served next,
  from the driving the trip actually costs, plus the same reaction allowance — but at a fraction of
  the run's own pace (`VIP_PACE_FACTOR`, floored at `VIP_MIN_PACE`, about as fast as Loco Mode
  gets round the map). Letting one go costs the streak, never a strike.
- **Triple pay.** A VIP pays the ordinary distance price times `VIP_PAYOUT` (3), stamped at spawn,
  and then the [combo meter](gameplay.md#the-combo-meter) at the drop-off like anyone. There used to be a VIP-only
  streak on top (3×, 4×, 5× back to back, reset by a miss); it went with the shift multiplier.

## The bank robbery

The robbery first shipped as a **drive-past**: an empty cab passing the bank set it off. The cut of the robber leaving the bank came in behind `?robbery=intro` (#475, 2026-10-11) and became the default with #478; the robber running round the block rather than through the building is #484; the bank rider replaced the drive-past as the trigger in #499 (2026-10-13), with `?bankfare=classic` keeping the drive-past. The bank rider's coin was fair (50/50 on every visit) until it became loaded — rising 15 points per bank rider who rode, reset by a robbery (2026-10-14, `?robberyodds=classic` for the fair coin). Ramming a cop on the pill became the wreck outright in #466 (2026-10-10, `?cop=classic` for the bump). The cop chat bubbles were cut in #492 (2026-10-12, `?copchat=classic`). Now: [The bank robbery](gameplay.md#the-bank-robbery).

`src/game/robbery.js`, `src/city/bank.js`, `src/game/fares.js` (`spawnRobber`), `sim/traffic.js`
(`setPoliceCars`). One city block is a [bank](city.md#the-bank) — a low stone building under a
colonnade with a dome behind it. Drive past it **with an empty cab** and somebody comes down the
steps with a bag, gets in, and the streets go blue for as long as it takes to get them where they
are going.

- The fail state is untouched. Crashing into a cop car is crashing into a car:
  [`sim/collisions.js`](../src/sim/collisions.js) does not know what livery anything is wearing and
  is not told. What changed is that the police now **put themselves in your way** — see
  [they box you in](gameplay.md#they-box-you-in) — so ramming one is a bump that costs hit points, and the
  last one is the wreck.

### It is imposed, so it cannot cost the run

Now: [It is imposed, so it cannot cost the run](gameplay.md#it-is-imposed-so-it-cannot-cost-the-run).

A [VIP](gameplay.md#vip-pickups) is *taken on*: it appears on the kerb, the player chooses to jump the queue
for it, and it can stay optional-but-hard only because missing one is never worse than never having
seen it. A robbery is not taken on at all — it walks out of a building because the taxi drove past,
on a trigger the player never pressed.

An imposed event that can end a run is the one thing a score-attack cannot have. So a robber whose
clock runs out does exactly what a missed VIP does: gets out mid-street, swears about it
([the outburst bubble](gameplay.md#they-leave-and-they-let-you-know)) and goes. The event costs the bonus and
the seat it was occupying, and nothing else. There is no streak to lose, which is the one line of
the VIP's version that is absent here rather than shared.

**What it can cost now is the escape afterwards, and only once the job is done.** Deliver the robber
and one cop comes after *you* as an ordinary [patrol chase](traffic.md#the-patrol-cruiser) —
caught on a touch is "Busted!", though ramming it on the pill is only a bump" ([the drop-off](gameplay.md#the-drop-off-the-arrest-and-the-tail)). That is a
different claim from the one this section was written to defend: nothing about the event *being
imposed* can end the run, and a player who drives the getaway has chosen to finish it. The drop-off
fills the tank to pay for the chase, so the choice is "boost clear", not "hope".

### The robber's line

Now: [The robber's line](gameplay.md#the-robbers-line).

`game/robberline.js`. The event used to go straight from a drive-past to four cop cars and the radio
call on one frame — the whole thing arriving at once, while the player was looking at something
else. It read as traffic changing colour rather than as the game changing mode, so it now has a
setup, in three beats:

### The bank job

Now: [The bank job](gameplay.md#the-bank-job).

**The cut's first framing** (`?robberycam=classic`) was the steps, the bystander and the cab door
averaged in the ground plane, the door counted twice so the cab stayed central, with a half-height
of `10 + 0.9 × span` (the world distance from the steps or the bystander to the cab door) between
15 and 26. Fine with the cab out front. Picked up across the street or across the junction, the cab
is 14 screen units sideways from the steps, and an upright phone at a 26 half-height is 24 units
wide, so the bank and the cab sat out towards opposite edges with the middle on roofs — and right
on them whenever Loco was held into the pickup, because the push-in (0.76) is eased by the frame
loop the cut stops and stayed frozen through the cut and the line. On a
city whose L runs down the bank's street it was worse: the deck's fade was still keyed on where the
taxi and the pins were when the world stopped, so the shove played under the girders. Reported off
exactly that, with the robber's bubble pinned to the edge of the screen pointing at a cab you could
not see. Replaced by a fit on the screen's own axes between the HUD rows, and the deck fed the cut's
subjects.

`game/bankjob.js`, the default since it was tried out behind a flag; `?robbery=classic` keeps the
old drive-past. The robber's line fixed the event arriving
all at once, but not the thing it was reported for: you never *see* the robber get in. The trigger
was a drive-past, so the player was looking at the taxi or the next rider while a 20px figure ran
0.9s from the steps into the cab.

**It starts with the bank rider.** Now and then a fare spawns on the bank's steps rather than at a
kerb corner (`BANK_CHANCE` in game/fares.js: 30% of qualifying spawns, from the second delivery, the
bank junction within the spawn box, 35s after the last one left the board). A coin is tossed when
they spawn. Tap them and pull up: heads they get in like anybody else; tails, and if the robbery's
fairness gates are open at that moment (`swapReady` in game/robbery.js — every gate the drive-past
had except its range, with the bank rider's own clock left out of the calm test), they leave the
board without a strike and the robber takes their seat. Nobody stands outside the bank and there is
no alarm on it otherwise. `?bankfare=classic` keeps the drive-past, an ever-present bystander and the
alarm always on the building.

This makes the robbery **opt-in**, which the first version deliberately was not: a player who never
takes the bank rider never meets it. And the rate is unmeasured — the drive-past fired 18 times in
30 autoplay runs, and this fires only when the bank rider is taken and the coin agrees.

So the event opens on a cut, and the world stops **one beat earlier** than the line
would stop it anyway:

1. One red alarm light appears on the bank's entablature, over the doorway (`bankFrontage` in
   city/bank.js), and starts flashing, and the camera pulls in on the steps and the cab.
2. The robber bursts out of the portico, shedding notes out of the sack (the getaway's own cash
   trail, fed from the robber), shoves the **bank rider** clean off their feet (airborne, spun, a bounce and a skid, then
   dazed and stirring on the ground — never landing on the cab), and sprints for the cab's door, which swings open as they arrive.
   The cab can be round the side of the block (under the drive-past, most of the time):
   the run then turns at the block's pavement corner (`aroundBlock`) rather than going straight
   through the building, which it did on 37% of trigger points before.
3. They hop in, and the robber's line takes over exactly as it does under `?robbery=classic`.

The shove plays in **slow motion**: from contact until just before the bystander comes down the
cut's clock runs at 0.3x (`IMPACT_SLOW`), easing back to 1x so the bounce and skid land at full
speed. About 4s of wall time in all, and a tap (or Space/Enter) skips straight to step 3. The alarm keeps going
for as long as the robbery does and then goes; the rider gets up a few seconds into the getaway and
walks back into the bank; the door
slams and the camera eases back out when the line is cleared.

**Stopped, not slowed** — the world, that is; the impact slow-mo is the cut's own clock, with
everything else already frozen. Slowing the *world* would keep the traffic alive, but it runs every clock, the
crystal's flight and the fare loop at a crawl under a figure animated at full speed — two time bases
in one frame — and the line right after it is a freeze anyway. The cut and the line read as one held
beat. The robber's crystal waits for them to be in the car (`boardScripted` in game/fares.js) rather
than hanging over the steps for the whole run.

Under `?bankfare=classic` the figure shoved over is scenery rather than a fare: no crystal, no tap
target, no board change, standing outside the bank all run.

### Dispatch breaks in

Now: [Dispatch breaks in](gameplay.md#dispatch-breaks-in).

It was pinned on the taxi at first, which read as the taxi calling the police on itself. Under
`?copchat=classic`, a patrol cruiser that loses the taxi also says "POLICE / Lost the suspect.
Resuming patrol." from its own roof; by default the chase ends with the bar going dark.

The figure alone was not enough, and the reason is the trigger. A robbery fires on a drive-*past*,
so the player is watching the taxi or the next rider, not a 20px figure on the bank's steps. The
robber's line now says *who* got in; this says what it means — the police are coming.

### The clock, and the bonus that reads it

Now: [The clock, and the bonus that reads it](gameplay.md#the-clock-and-the-bonus-that-reads-it).

It used to be the tightest clock in the game: 0.62 floored at 1.05, which is `work × 1.05` from the
very first robbery since the old slack curve started at 1.7. That left no seconds to spend on a roadblock,
a detour or a ram, and made the chase something to escape rather than something to play with.

It was 1.5× the trip's own distance price on top of that price, which came to $50–75 — two or three
ordinary fares for the one event that takes the wheel and cannot be declined, and it read as a
slightly better fare. Flat, it is a jackpot worth five or six, and the same number every time.

### The getaway runs across town

Now: [The getaway runs across town](gameplay.md#the-getaway-runs-across-town).

`pickFarthest` scores every free junction by block distance from the bank and draws the drop-off
from the furthest band — the furthest, or `ROBBER_DROPOFF_SPREAD` = 1 short of it, so one city's
robberies do not all end on the same kerb. It is filtered through the same predicate as every other
drop-off, so the only thing it changes is that the distance is no longer left to chance. It used to
be eight random darts with the furthest kept: a median of 7 blocks over 55 cities, but as few as 5.
It is the one event in this game whose whole point is the drive.

### The trigger

Now: [The trigger](gameplay.md#the-trigger).

`TRIGGER_RANGE` is 12 world units from the bank's door, and it is arithmetic rather than a number.
The door point sits 0.5 out from the building's setback; the near lane is `LANE` = 2 off the kerb,
so a taxi passing the middle of the frontage is 2.9 units out, and passing its far end on the
*oncoming* side is hypot(6.9, 5.1) = 8.6 — which has still driven past the bank, so it counts. What
12 deliberately does not reach is the street on the other side of the block, whose nearest
carriageway is 18 units away.

### The police

Now: [The police](gameplay.md#the-police).

`setPoliceCars(n)` in `sim/traffic.js` takes the `n` ambient cars nearest the taxi, paints them
in the police two-tone (light-blue `policeBody`, white cab) and puts a light bar on their roofs. `setPoliceCars(0)` hands every one of them back its
own `colorIndex`, which is left untouched throughout — that is what makes ending the event free
rather than something to remember.

**The set follows the player; the cars do not.** It is re-run every two seconds, so a cop car that has
driven off across town is handed back its paint and a nearer one turns blue. That is the closest the
event comes to the traffic acknowledging the taxi and it is deliberately as far as it goes. Two
seconds because `SPEED` is 8.5, so a car covers 17 units in that time — most of a 20-unit block —
and anything that turns over between two re-picks has been out of the frame it was last seen in for
most of it.

**And two more cars actually arrive**, which is the half that adds traffic rather than repainting it.
`setCarCount` only ever grows and is capped at the pool the difficulty ramp's own ceiling sized, so
what a robbery does is spend that ramp's headroom *early*: the cars it brings forward are cars the run
was going to get a shift or two later, and no run can end up with more traffic in it than one that
never met a robbery. They are not painted and they are not un-spawned at the end — a fleet that shrank
on the frame an event ended would mean deleting cars out of the middle of an instance buffer while the
player watched.

The first version repainted the ambient cars nearest the taxi and deleted them at the end, which reads
exactly as badly as it sounds at both ends: a car you have been following turns into a police car,
and a police car in your mirror stops existing.

The checkpoint reinforcements' top-up used to lose every race to the recycle — both waited on one
gap clock and the recycle ticked it — so it only ever fired while no cop was lost.

### The chase

Now: [The chase](gameplay.md#the-chase).

**Nothing about the fail state changed — but a cop catching you is no longer nothing.** There is no
bust and no new ending. What there is instead is a cop in the way: across the junction ahead, or
braking in your lane having just gone round you. Ramming one is a bump that costs hit points
([bumps](traffic.md#bumps-and-hit-points)), and the one that empties them is the wreck the game
already had.

**And [the patrol cruiser](traffic.md#the-patrol-cruiser) does not come after you during one** — it
drives off when a robbery starts. That rule — boost within a block of the cruiser and it gives chase
(it used to end the run) — is a good one, and its legibility rests
entirely on there being *one* police car on the street and it being obvious which. A robbery puts
four more on the street in the same paint under the same flashing bar, and pays a bonus on the
clock that boosting is the way to earn. So the event asks for Loco
Mode and an unrelated patrol ends the run for using it, and at a glance there is no telling which of
the five blue cars is the one that does that. It was found the way these things are found: a real
run ended that way, with the note that none of the *other* police had so much as moved.

It restores a rule this event already states. A robbery is **imposed** — it walks out of a building
because the taxi drove past — which is why a robber who runs out of clock bails rather than ending
the run. Letting a patrol end it instead is that same rule going out the side door. The honest cost
is that Loco Mode has no downside but the wreck for the length of a getaway; the chase is what pays
that back, and it now drives cop cars into the road *ahead* of the taxi rather than trailing it.

### They box you in

Now: [They box you in](gameplay.md#they-box-you-in).

Before #466, a cop angled across both lanes "cannot be gone round on the pill — only rammed", and
ramming was a bump:

Each poses the same three-way choice, and all three are things the game already had. **Wait** — it
costs the robber's clock, and with it the bonus. **Route round** — redraw the route and
the roadblock is let go. **Ram it** — on the pill the taxi barges in, and the cop is a bump that
costs 12–60 hit points by closing speed; enough of them and it is the wreck.

That last one is the line this section used to hold: that an imposed event could not cost the run.
It still cannot *directly* — a robber who runs out of clock still bails, and there is still no bust.
But the event now puts things in the road that the player can choose to drive through, and what that
costs is paid in the currency every other crash is. The fairness lives in the choice being real:
every roadblock is let go when the taxi routes round it or waits it out, so ramming is never the only
way past.

### The drop-off: the arrest and the tail

Now: [The drop-off: the arrest and the tail](gameplay.md#the-drop-off-the-arrest-and-the-tail).

It used to be a ring: the cops circled the junction box for a few seconds before one pulled up at
the kerb. It read as cars going round in circles rather than as an arrest. The fan sits in the box
on the robber's side of it — a kerb corner has road on only a quarter of the directions out from it
— and fills from the slot furthest from each car first, because the cops mostly come down the same
arm and the slot nearest its mouth is parked right across it. A slot that faces back the way a car
came is reached by sliding the body round over the last stretch of the run (`slideIn`), not by a lap
of road the box does not have. Every run in and every pull-out is sampled before it is driven — four
corners on the road, the centre clear of every other car — and a car without a clear one waits.

### The police helicopter's first searchlight

[Today's light](gameplay.md#the-police-helicopter). `?helispot=classic` puts it back. The first pool
was flat to 0.72 of its radius and then fell to nothing over the last 28%, and the dark ring round it
went dark from just inside that rim, so the edge of the light was a hard bright line against a dark
band. It also ran at about 1.6× today's strength (beam 0.75 by day and 0.38 at night, pool 1.0 and
0.75, ring 0.45 and 0.12). Tyler found it "too strong and too sharp" (2026-10-14); the soft light
keeps the half-brightness radius where it was and changes only the edge and the strength.

## The package courier

The courier layer has always been collected by a route passing the pad. What changed is how the player bends the route there: the band drag came first, the tap on the box second, and since 2026-10-05 the drag is off by default (`?drag=on`), leaving the box tap and the street tap. Now: [The package courier](gameplay.md#the-package-courier).

### With a rider aboard, a package is a detour. With the seat empty, a destination

Now: [With a rider aboard, a package is a detour. With the seat empty, a destination](gameplay.md#with-a-rider-aboard-a-package-is-a-detour-with-the-seat-empty-a-destination).

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

### Two gestures ask for the same bend

Now: [Two gestures ask for the same bend](gameplay.md#two-gestures-ask-for-the-same-bend).

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

### The one thing the tap does not share is the cap

Now: [The one thing the tap does not share is the cap](gameplay.md#the-one-thing-the-tap-does-not-share-is-the-cap).

It shipped inheriting [the drag's `MAX_VIA_DETOUR`](gameplay.md#dragging-the-route), on the reasoning that the
same bend should refuse in the same case. That was wrong, and wrong in a way that only shows up in
play: it was reported straight away as *"tapping the box did not alter the route"*. It hadn't — the
cap had refused it.

### The rest of it

Now: [The rest of it](gameplay.md#the-rest-of-it).

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

- **The taxi does not wear its load.** It used to: a small parcel on the rear deck, which at play zoom
  is [about four pixels](gameplay.md#the-load-is-carried-into-the-hud). The load is stated in the HUD instead, at a
  size that can be read, and the car goes back to saying exactly one thing about what it is carrying —
  [the roof sign](gameplay.md#the-taxis-roof-sign), for a rider.

## Crazy-taxi mode

Loco Mode's button was a pill at the bottom left, 60% of a bottom row it shared with the brake, and the pill was also the fuel dial. It is now a round gas pedal centred on the bottom edge with an arc gauge round it ([the pedal slide](gameplay.md#the-pedal-slide)). Now: [Crazy-taxi mode](gameplay.md#crazy-taxi-mode).

The **Loco Mode** button, bottom left. **Hold to enable, release to pause.** A short tap costs a
short slice, a long hold flows until the tank is empty. Full tank is 15 seconds of boost. The
decision is now *how long* to press as well as *when*. The button doubles as the dial: a `--pct`
CSS variable tracks the fuel level, dropping as you drain and climbing as a drop-off pours fuel in.

That is a deliberate replacement for the old economy, which handed back 15% per drop-off but also
fast-recharged from empty in 15s and trickled a *whole* tank back up at a fifth of that rate. Under
those rules waiting was a valid way to get boost back, so the meter said nothing about how the run
was going; now all but the bottom quarter of it was earned by a fare, and three deliveries is a full
tank. Opening with a third rather than empty keeps the toy in reach on the first fare — an empty
start leaves the button dead in the hand until the first drop-off lands, which is the same reason
the recharge exists at all: a run that has spent its tank and is between fares should still have one
straightaway's worth of Loco Mode within five seconds of asking.

**There is no longer a case where holding it does nothing.** A taxi that had just picked someone up
used to be `parked` — waiting at the kerb for you to tap a destination — and `parked` sets
`allowed = 0` ahead of anything boost can do, so Loco Mode was dead in the hand until you'd
dispatched the car. Now [the drop-off dispatches itself](gameplay.md#the-drop-off-dispatches-itself) and the
taxi is never parked with a rider aboard; boost applies from the pickup frame on. Every other
reason the taxi slows while boosting is traffic, and those are dealt with in
[traffic.md](traffic.md#what-was-still-braking-it).

It pulls out whenever the road allows — an oncoming lane to borrow, and straight on through the
junction ahead — and never because the sim decided it was a bad idea. A car already turning across
the lane you want, or oncoming traffic in plain sight, is yours to read: holding the button is the
decision. There used to be two gates refusing exactly those, and they read as the button not
working and then as a rear-end; see [traffic.md](traffic.md#when-it-is-allowed).

### The refill animation

Now: [The refill animation](gameplay.md#the-refill-animation).

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

## Repairs at the depot

Now: [Repairs at the depot](gameplay.md#repairs-at-the-depot).

### The depot's card

Now: [The depot's card](gameplay.md#the-depots-card).

It was a speech bubble over the garage door, once per bout of damage; Tyler swapped it for the card
(2026-10-06). The card is **once ever** (`simTaxi.seen.repair`), stops the world like the move cards,
and answers to the same gates: the tips setting, debug mode, the opening tutorial being done, and a
calm beat (`newMoveCalm`) — a getaway, a patrol chase or a taxi already on its way in defers it, and
it is tried again every half second for as long as the car is still smoking. No pedal row: the
instruction is a tap, so the line says it. A finger tapping the door in the clip was tried and cut
(Tyler, 2026-10-06): the clip is just the visit.

The first version of the repair beat cut to black for a second, which said "time passed" and
nothing about what it was spent on.

**A rider waiting in front of it does not hide it.** A rider's tap target is an invisible quad
11 screen units across (`geometry/marker.js`), and on a corner in front of the depot it covers
half the building's front — nearest-hit, so every tap there answered the rider. `choosePick` in
`game/pick.js` now lets an invisible stand-in yield to the first *drawn* surface along the ray when
that surface is the depot (or the burger joint) and the tap would be taken; the rider's own figure,
crystal and disc are drawn and in front, so they still mean the rider. That last clause was false
for a while: the crystal and disc opted out of raycasting (the quad "already covered them") and live
at scene level outside the rider's group, so the ray never saw them — a tap on the crystal read as
empty margin, and a tap on the near half of the disc met the burger joint's apron before the quad.
Reported as a tap on a rider at the joint sending the taxi through the drive-through. Both are now
raycast and tagged as the rider's (`stampFareMarker` in `game/fares.js`), and every marker's
`postGroup` carries its kind so a pad or a parcel on the corner counts the same way. While a repair would be
refused — undamaged car, rider aboard — the margin stays the rider's, since the alternative is a
tap that does nothing.

## The brake

The bootleg's handbrake turn is #458 (2026-10-10). Now: [The brake](gameplay.md#the-brake).

The **Brake** button, to the right of the Loco Mode pill and sharing the bottom row with it:
**60% Loco Mode, 40% brake**, of the same band the pill used to have to itself. Hold it
and the taxi hauls itself to a stop wherever it is; let go and it drives itself again, because
driving itself is the game's resting state and the brake never took that away — it only outranked
it while held. The physics is in
[traffic.md](traffic.md#the-brake-pedal); this is what the player touches.

**It costs nothing and cannot run out.** No meter, no fuel, no cooldown, nothing to earn — which is
why the button carries no dial. A pill with a fill on it would promise a resource that isn't there.
It is a prototype control in the honest sense: the only thing it does is stop the car.

**Red, not yellow.** Everything else about it is the pill's — same bottom edge, same 49px height,
same radius, same black outline, same hold-to-hold contract, the same `touch-action: none` and
label-in-a-span iOS suppression (see [above](gameplay.md#crazy-taxi-mode)) — so the colour is doing all the
work of telling the two apart at the edge of vision, where this button is while the player is
watching the road. Held, it lights (`.is-on`) rather than dimming: it is a brake *light*, and the
taxi's own lamps are coming on out on the road at the same moment.

Both buttons stay independently `position: fixed` rather than becoming flex children of a row. A
wrapper would put a new element between `#boost` and the viewport, and that pill is measured
(the tutorial aims its third bubble at its `getBoundingClientRect`), animated (`translate` on the
HUD entrance) and pressed through pointer capture. Two `calc()`s against `--ctl-left` /
`--ctl-right` / `--ctl-gap` / `--brake-w` cost less than re-testing all of that. The shares are
of the *band*, not of the screen, so the 60/40 survives any change to the band's own margins.

**The row sits in one inset, and that inset is derived rather than typed.** The same gap left,
right and underneath, so the pair reads as a panel resting in the corner of the screen. The
number cannot be a constant, because the gap the player sees at the bottom is the constant plus
`env(safe-area-inset-bottom)` — 26px on a desktop and 60pt on a notched iPhone, from one
declaration. So `--ctl-inset` halves the *sum* (`(26px + var(--safe-bottom)) / 2`), which is
13px on a desktop and 30pt on a phone, and the sides take the same number. 30pt still clears
the home indicator's ~21pt of edge protection, which is why the bottom may spend part of the
safe area rather than sitting on top of all of it — but only the bottom. Landscape puts 47pt of
notch beside the row and no derived inset beats that, so `--ctl-left` / `--ctl-right` floor at
their own `env()`. The rider-finder chips, the taxi finder and the coach bubble are all stacked
on `--ctl-bottom` rather than placed on their own, so the whole bottom cluster moves together.

### The bootleg: boost, then brake twice

Now: [The bootleg: boost, then brake twice](gameplay.md#the-bootleg-boost-then-brake-twice).

- **Classic** (`?uturn=classic`). The first one: an angle choreographed over 0.76s with the
  position slid underneath, keeping 55% of its speed. It read as "pivoting on the spot", and a
  second, angle-first pass with momentum and a fishtail read as "messy" (Tyler, 2026-10-09), which
  is why the default turned path-first; a slower path-first pass that scrubbed speed in the bulb
  read as "stilted" (2026-10-10), which is why it now holds speed and kicks like the drift.

The first prototype was a swipe back down the road. Playtesting dropped it: on a phone, a swipe
already means a pan, a route-band drag or a fare tap.

### The drift: Loco, tap the brake, Loco again

Now: [The drift: Loco, tap the brake, Loco again](gameplay.md#the-drift-loco-tap-the-brake-loco-again).

Every boosted corner did this for one iteration; it made the combo
hard to tell from simply holding the pill, so a plain Loco corner went back to its lean and rear
rubber. Corner speeds are unchanged either way — a left at the boost cruise, a right at 0.75× —
because slowing every corner to make room for a reward was tried and was a bummer.

- **The tap alone is a brake.** At 13 u/s or more (`DRIFT_MIN_V`, so only off the pill) with a
  real turn within reach it *arms* a drift (`driftTaxi`), and nothing else: the brake sound, the
  rubber and the deceleration are an ordinary press's, and held, it stops the car. The slide used
  to start on the tap and hold the boost cruise with the pill off — a tap under the cruise had the
  taxi accelerating — which read as the brake giving the car a shove (Tyler, 2026-10-07). Only a
  kicked drift (`driftHolds`) slides, holds its speed and is deaf to the pedal.

## The pedal slide

Now: [The pedal slide](gameplay.md#the-pedal-slide).

The bottom row is two round pedals — an orange gas button 100px across, dead centre on the bottom
edge, and a red brake two thirds its size to its left, the two centres on one line so a thumb slides
straight across — and a ⏸ in the far corner. They were the Figma file's drawings (a tall gas pedal
with a pill-shaped brake tucked against its lower right) until both went round. Their depth is not
geometry: each is one flat circle with a 28-unit inner shadow along its bottom, which reads as the
side. A held pedal
**sinks** into its own outline: the silhouette stays put while its filter swaps to one with a
thinner side band and a dark inner shadow from the top edge, and the icon drops 8 units with the
face (the "The press" rules in `index.html`). It used to squash the whole pedal toward its base, but
that moved the cap 12px away from the fuel gauge hugging it. It sinks for the Space and B keys too, off
`boost.state.held` and the brake's `is-on`, not only under a finger. An empty tank greys the pedal
out.

**The fuel gauge is an arc over the gas pedal.** It used to be a wedge-shaped bar in the top-left
corner, which put the read-out as far from the thumb spending it as the screen allows. It is now a
tachometer-style band (`#boost-meter` in `index.html`, shaped by `game/fuelarc.js`) round the
button, from just under its centre on the left, over the top, to the same height on the right. Fuel
fills from the left end, so holding the gas sweeps the front back from the right, over the crown,
and down to the left. The band is an even 16 units wide (it used to taper, 8 → 14 round the old
pedal and briefly 12 → 20 round the button), and a thin white glint sits across the fuel's front
whenever there is any. A stroke can't taper, so the track and the fuel are filled outlines, and `main.js` rewrites the
fuel's outline whenever the level moves. The band's inner edge holds 4 units off the pedal's black
outline all the way round, and the width grows outward. The first build had the right tangent point
typed 10 units wrong, and the right leg hung visibly further off the pedal than the left, so the
probe now checks the clearance and the matching end heights. The gauge rides in with the pedals on
`pedals-ready`, not with the top HUD, and the boost sparks land on its crown. The trade: a thumb on
the pedal can cover part of the arc, and the last of the tank drains into the lower-left end, which
is the part a thumb coming in from that corner is most likely to be over.

## Pause

Now: [Pause](gameplay.md#pause).

`src/game/pause.js`, styled in `index.html` under `#pause` / `#pause-veil`. The ⏸ sits in the top
centre of the HUD, between the money counter and the streak — the one piece of that edge nothing
else was using, and the one spot either thumb reaches without crossing the city. It arrives with
the rest of the HUD (see [the HUD arrives afterwards](gameplay.md#the-hud-arrives-afterwards)) and it is gone
once the run is over, because a paused ending is not a thing.

## The run-end screen

Now: [The run-end screen](gameplay.md#the-run-end-screen).

It is a **full-screen blackout**, not a modal over the city. An earlier pass dimmed the world and
floated a blurred card on top of it, and the card's edges turned out to be the loudest thing on the
screen. Blacking the whole viewport out puts the run's numbers on nothing at all, which is what
makes them the ending rather than an overlay on one.

There used to be four rows — Time, Fares, Shift, Cash — and Fares and Shift were cut. Each
rider's clock is budgeted off the work the fare takes ([difficulty.md](difficulty.md)), so how many
fares a run carried and how far up the ramp it got both mostly restate how long it lasted, and four
rows of near-synonyms buried Cash, the one number the table ranks by. Cash comes first for that
reason.

The review used to hold for 420ms and swap itself, so a run summary was something you could miss
by glancing away.

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

## Getting caught, before the capture model

`?capture=classic`. Until 2026-10-14 the police ended a run by three rules, one per kind of cop:

- **A patrol cop's touch was "Busted!"**, at any speed — rammed from behind on a straight at full
  cruise was the same arrest as being pinned at a junction. Ramming the cop yourself on the pill was
  the exception (`RAMMED_GRACE`), until the next rule made that a wreck instead.
- **A boosted hit on any cop was the wreck**, whatever the HP (`lethalPolice` in
  `sim/collisions.js`, #466; `?cop=classic` on top priced a cop like any other car).
- **A getaway's cops could not arrest anybody**, so during a robbery the only way the police ended a
  run was that wreck.

Reported from play (Tyler, 2026-10-14): "hitting a cop is insta fail. That sucks during the robbery
vignette where you wanna smash through roadblocks." The getaway fills the tank and throws roadblocks
across your route; the third rule made the second the one thing it asked of you that ended the run.
Replaced by [getting caught](gameplay.md#getting-caught).

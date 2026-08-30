# The river

`src/city/river.js` for where it goes and what it is made of, `src/geometry/bridge.js` for the
spans, `src/game/drawbridge.js` for the one that lifts, and `src/geometry/boat.js` +
`src/game/boats.js` for the traffic on it.

A river runs east–west through the middle of the city, crossed by three bridges. Two of them arch.
The third is flat, and it opens.

## The city grew a row rather than losing one

The obvious way to put water on this map is to flood a block row. It costs five of the twenty-five
blocks, and with them whichever one-per-city landmark happened to be standing there — the depot, the
burger joint, the courtyard, the helipad.

So the Z axis has **six** block rows against X's five, and one of them is the channel. Land stays at
25 blocks, every street survives, and the map gains an east–west street it did not have. That is
what made `GRID` come apart into `GRID_I` and `GRID_J`
([architecture.md](architecture.md#the-grid-has-two-counts)), and it is the whole of the cost.

**The row *is* the river**, which is what keeps everything downstream cheap:

- `blockBounds` already describes the channel — it is the gap between two roads, which is what a
  block row is.
- `layout.js` types those blocks `'river'`, so `createBuildings` (which walks `'built'`) and
  `createProps` (which walks `'park'`) skip them without being told, and `chooseGarageBlock` /
  `chooseBurgerBlock` filter them out by the same rule they already used.
- The three crossings with **no** bridge are ordinary closed segments — the same mechanism a park
  district uses when it builds over a road, so `legalExits`, the road network, ambient traffic and
  the router all learn about them for free.

The river takes one of the two middle rows, so the land either side comes out 2 and 3. That is the
point of it: a trip across town has to pick a crossing.

### Two things the network could not work out for itself

`roadNetFromGrid` tags the faces over the channel `type: 'water'`. The graph has no idea water is
there — water is not a road, so it sees an ordinary face, merged across every crossing without a
bridge. That is the right answer about the graph and the wrong one about what can be built on.

And a river face is *not* what `blockBounds` says: five river blocks come back as one or two big
merged faces. `tools/roadnet.mjs` compares land against land.

## Which crossings bridge

`planRiver` decides, and two of the six are always the same:

| | |
|---|---|
| **The two ring roads** | Always a bridge. The outermost roads are the signal-free ring, the police corridor drives one end to end, and traffic yields into it rather than stopping — breaking either would need a fallback in all three. |
| **One of the four interior lines** | The drawbridge. |
| **The other three** | Open water. |

Three crossings, not four. The first cut bridged two interior lines as well as the ring, and playing
it the difference was obvious: with five of six lines carrying road there was almost always a
crossing within a block of wherever the taxi already was, and the river stopped being a decision.
Taking one out puts real distance between the ways over — which is the whole reason for the water.

That leaves **two ways across while the leaf is up**, which is the guarantee the whole feature
rests on: the drawbridge may close a route, but it may never cut the city in half.
`tools/probe.mjs` asserts it by planning all 7,056 (origin, heading, destination) triples with the
span blocked, and a 400-seed sweep confirms the city stays connected with three crossings.

## The fixed spans arch, and the drawbridge is flat

This is the part that makes the feature hang together rather than being two features.

A bascule leaf has to be **flat** to lie down and to hinge. So the one that lifts is the one span at
plain road level — and the hump on the other two is what lets a boat clear them without anything
having to move. **The bridge that lifts is the bridge that could not arch**, which is a better
reason than "this one is special".

The chain, measured to the deck's *soffit* since that is what a boat hits:

| | soffit | clearance over the water |
|---|---|---|
| Flat span, deck 0.35 thick | −0.35 | **1.65** |
| Arched span at the crest, rise 1.1 | +0.75 | **2.75** |
| Barge, air draught 1.4 | | clears both |
| Tug, air draught 2.4 | | clears the arches by 0.35, **0.75 short of the flat one** |

Four numbers across three files, so the probe asserts the **chain** rather than its outcome: move
any one of them and it fails here rather than shipping a tug that sails under the bridge it opens.
The tug's mast is positioned *from* `TUG_AIR` rather than eyeballed on top of its superstructure —
a first cut came out at 2.81, over the arches' 2.75, and would have left the tug unable to reach
the drawbridge at all.

### The rise is a camera number

A world-Y lift of `h` moves `6.45h` px up the screen at play zoom (`SCREEN_PER_WORLD_Y` 0.838 ×
7.7 px per unit), so 1.1 is about **7px**. That is deliberately under the roadworks hop's apex,
which was *raised* to 2.75 because 12px read as a lift rather than a jump: a hump wants to stop
short of where a jump starts. Peak grade is `rise · π / span` ≈ **16°**, and the arch occludes 1.7
units of the 12-unit channel behind it, so it never hides the water on its far side.

### How a car gets over it

**Render-only, exactly like the roadworks ramp.** `car.s`, `car.lane`, the turn decision, following
distance and the collision test all carry on as if the deck were flat, which is what stops a piece
of scenery being able to break the sim.

`deckHeightAt(x, z)` is **world-space** rather than keyed by lane id, because that is the shape both
callers already have in hand: `sim/traffic.js` poses a car from `car.x`/`car.z`, and
`sim/police.js`'s cruiser rides a rail and has no lane at all. Declining the crossing lines was
never an option for the corridor — every road running along Z crosses the river.

Sampled at the **nose and the tail**, not the centre. A rigid body pitched to the tangent under its
own origin floats at the crest and buries its nose at the foot; two lookups cost one rectangle test
per arched span and are simply correct.

The **route band** takes the same treatment, for the same reason and one layer up: `routeline.js`
builds its ribbon from lane geometry, which is flat, so a route over a hump drew a straight yellow
line through the middle of the deck. Every vertex it emits now takes `deckHeightAt` on the point it
is actually at, so the band rides over the arch with the road.

The profile is `rise · sin²(πu)`. Zero slope at both ends is the point, not a detail — a curve that
arrives at the abutment with slope left in it kinks where deck meets road, and no rise tunes that
out.

### Except in Loco Mode, where it is a ramp

The arch is not a gameplay surface — it changes no speed, no braking and no collision envelope. The
one exception is the boosting taxi, which **launches off the crest** into the same hop the roadworks
ramp fires (`launchHop`, `sim/traffic.js`), because a hump you take at boost speed reading as
nothing at all is the one place the render-only rule looks like a missing feature rather than a
clean separation.

Three guards, and each of them is load-bearing:

- `crest.y > ARCH_RISE * 0.75` — a fraction of the rise, not an absolute height, so the trigger
  follows the hump if the hump is ever re-tuned. It puts the launch in the middle third of the span
  rather than at the foot.
- `crest.dydz * dirSign(car.d) <= 0` — only on the way **down**. Firing on the climb throws the car
  up the slope it is already climbing, which reads as a stumble.
- `car.archHopLane !== car.lane.id` — once per crossing. Without it the hop retriggers every frame
  the crest test passes and the taxi hovers across the river.

## The embankment

Both banks carry a pavement and a railing, built exactly the way a block's platform is: a kerb box
with a sidewalk surface inset on top of it.

It opened with a solid 0.75 parapet standing on the road's own kerb, and that is wrong for **this**
camera rather than wrong in general: anything of height `h` hides `1.087h` of the ground behind it
in z, and what is behind the south bank's parapet is the near lane of the road below — a car's far
flank cleared it by 0.33 units and no more. A railing hides nothing, because you can see through it.

**The 1.4 comes out of the water.** The grid's pitch is uniform, so a walk on each bank takes the
channel from 12 units to 9.2 — a shade over one road width rather than the one and a half it was.
Widening the row instead would mean a non-uniform `lineZ`, which is a second refactor the size of
the first one. The bridges' footways are the same 1.4, so the walk does not narrow as it crosses.

Fare and courier markers still stay off the river row. It is the **mark** that rules those corners
out, not the pin: `cornerFor` stakes its pin 0.5 past the kerb, which is on pavement, but a fare's
disc reaches 1.75 further and would sit out over the water. It costs the board the row of junctions
along one bank — 42 junctions less that row is 36, exactly what a 5×5 city offered.

## The river mouth

The slab is cut bank to bank, and the cut is not a coast — so `asphaltFade` skips it, which leaves a
notch of sky at each mouth where the rim either side is still dark.

Filling that notch with fading water is no better, and measurably so. Sampled every two units out
from the coast, the asphalt skirt runs 85 → 210 luma over its sixteen units; water on the same band
and the same smoothstep ran **~24 luma ahead of it the whole way**, whether it faded from the open
tone, the deep one, or eased into the asphalt's own colour. A pale blade lying in the coastline,
with the bank line to give it a hard edge. Shortening the band only swapped the blade for a
hard-edged notch of sky — at six units the river hit sky while the coast beside it was still at 105.

What closes it is `riverMouthFade` in `ground.js`: the island's **own** rim carried straight across
the channel, on the skirt's colour and the skirt's curve, with the river ending underneath it.
Measured the same way afterwards, the mouth tracks the coast to within 1–2 luma the whole way out.

> **AO on a transparent surface.** `markOccluder` refuses to put a transparent mesh in the depth
> prepass, quite rightly — but *receiving* was the default, so the water read the occlusion of
> whatever was behind it. `propMaterial({ ao: false })` is the opt-out. The asphalt's own fade skirt
> has the same hole and gets away with it only because nothing stands near it.

## The drawbridge

`src/game/drawbridge.js`. **The only thing in this game that changes the road network while the
player is driving it.** A park district closes a road before the run starts and a roadworks zone
only ever makes one cheaper; this takes a route that was valid ten seconds ago and stops it
existing, with a clock running in the back seat.

### The cycle

```
open ─▶ closing ─▶ clearing ─▶ lifting ─▶ up ─▶ lowering ─▶ raising ─▶ open
```

| | |
|---|---|
| `closing` | Barriers down, and **both** closures published at once. 2.2s. |
| `clearing` | Hold until nothing is on either lane. **No timeout.** |
| `lifting` | 6.8s, smoothstepped, to 70°. |
| `up` | Until the boat releases it, or `HOLD_SECONDS` as a backstop. |
| `lowering` | 6.0s. Gravity is on its side and the beat wants to end sooner. |
| `raising` | The barriers come **back up**, 2.2s. |

**The whole cycle runs at half the speed it first shipped at.** Barriers 1.1 → 2.2, lift 3.4 → 6.8,
lower 3.0 → 6.0. Played at the original numbers the leaf snapped up and back inside four seconds and
read as a gate rather than as machinery: there was nothing to *watch*, and a closure the player
never notices opening is a closure that only ever arrives as a re-planned route. `OPEN_SECONDS` is
derived (`BARRIER_SECONDS + LIFT_SECONDS`, so 9.0) and everything that has to arrive on the opening
— the tug's ask-ahead distance, the staged screenshots in `util/shot.js` — is derived from *it*
rather than written down again.

`raising` exists to fix a pop. `open` set the barriers to 0 on the frame it was entered, so the
moment the leaf touched down both barriers vanished and reappeared lying flat — the user reported it
as "the gates disappear and pop back in". Lowering a barrier and raising it are not the same
transition and cannot share a phase.

The end of `lowering` fires an **`onLand` callback with both abutment feet**, and `main.js` throws a
puff of dust at each out of the pool the roadworks smash and the boosting taxi already share. The
leaf coming home is the one moment in the cycle with an impact in it and it was landing in silence;
a bridge dropping a hundred tonnes onto a stone seat kicks up what a car scrubbing its tyres does,
and it is the same dust either way. Smaller and shorter than a barricade smash — `power` 0.7 against
well over 1 — because this is a heavy thing settling, not something exploding, and aimed **along**
the span so the collars spread down the road rather than out over the water.

**`clearing` is what makes this safe.** The barriers are already down and the lanes already shut, so
nothing new can reach the deck; what is on it drives off, and only then does the leaf move. A car
queued behind a red at the far junction, or a player sitting on the crest with the brake held, holds
the whole cycle — the boat waits. A lift that fired anyway would be the one event here that can
throw a car into the river, and "it hardly ever happens" is not a property worth having.

`HOLD_SECONDS` is a backstop, not a hold, and **it has to be longer than the thing it backs up or
it becomes the thing**. A tug asks 30 units out and lets go `TUG_LEN + 4` past the span, which at
3.4 u/s is 11.3 seconds of request. At 4.5 the backstop fired first and started lowering the leaf
onto a boat still four seconds short of it. It is 20 now, which is that 11.3 plus most of it again.

### 70°, and what bounds it

A real bascule opens to about 80. The ceiling here is what the leaf **hides**: a raised leaf spans
the channel, so it stands 10 units up and casts a 15-unit blind spot over the far bank. Past that it
starts hiding the road beyond — and a marker the player cannot find is exactly what `cornerSeen`
exists to prevent, except that this one comes and goes, so no static filter can catch it.

The soffit is a related decision and a bigger one than it sounds. Raised, the leaf turns its belly
through the view axis, so **the underside is the whole of what the camera sees**. In the pale
`bridgeTrim` it presented a blank panel the size of a block at the same value as the buildings
behind it: the one moment in the game with a bridge standing on end read as a flat card lying on the
skyline. `bridgeSoffit` is luma 74 — the darkest surface in the city bar a roadworks trench, which
is right twice over.

Its **running** surface is the opposite decision, and it is the one the player reads from across the
map *before* anything moves. `drawbridgeDeck` is a cool luma 136 against `bridgeDeck`'s 100 and the
road's own 104: a bascule leaf is a steel grid, the road stops being road where the machinery
starts, and in `bridgeDeck` this span was a stripe of street lying over the water exactly like the
other two, with a counterweight house the size of a bus shelter as its only tell.

### The three closure sets

| Set | Who | Says |
|---|---|---|
| `setClosedLanes(ids, 'roadwork')` | `roadwork.js` | ambient traffic keeps out |
| `setRoadworkLanes` (`route.js`) | `roadwork.js` | the taxi is *tempted in* — the asymmetry is the vignette |
| `setClosedLanes(ids, 'drawbridge')` + `setBlockedLanes` | `drawbridge.js` | nobody crosses, taxi included |

`setClosedLanes` is **keyed by source** now. It was one set with one owner and `roadwork.js`
replaced it wholesale, which is correct exactly while nothing else holds a closure — a zone standing
up mid-lift would have reopened the span under it.

`setBlockedLanes` is enforced by **skipping** the lane in `search`'s successor expansion rather than
by pricing it high. A weight, however large, is still a number Dijkstra will pay if it has to — and
on a city where the bridge is the short way across, "has to" is precisely the case that comes up.

The re-plan on `closing` is unconditional and does not need to ask whether the old route used the
span: the lanes are already blocked, so a route that never went near the river re-plans to itself.
Passing the **same target object** keeps that free — the band's rollout sweep keys off
`pendingTarget`'s identity ([gameplay.md](gameplay.md#dragging-the-route)).

It also declines to lift while a siren is running down its line, the same courtesy `roadwork.js`
extends before digging up a road: the corridor holds every light on its road green and the cruiser
neither queues nor brakes, so a barrier in front of one is the single closure it cannot answer.

## Boats

`geometry/boat.js` builds them, `game/boats.js` runs them. **Run seed, not city seed**: which span
lifts is a fact about the map and has to stay learnable, but when it lifts is the situation.

A barge every 16–34s, a tug every 90–150s and never two at once. Both are slow on purpose — 2.6 and
3.4 units per second against a car's 8.5 — because what sells a boat is being the slowest thing in
the frame. The tug's wait went 55–95 → 90–150 with the cycle: a lift is a ten-second event now, and
one arriving every minute stops being an event.

The tug asks for the lift **`ASK_AHEAD` units out**, which is a distance rather than a clock for the
reason the roadworks hop is paced by distance: the answer has to be the same whatever else is
happening. And it is *derived*, not written down — `(OPEN_SECONDS + ASK_SLACK) · TUG_SPEED`, so
44.2 units at today's numbers. The arithmetic it stands for is `BARRIER_SECONDS` of barriers plus
however long the deck takes plus `LIFT_SECONDS` of lift, which is nine seconds with an empty deck;
`ASK_SLACK` is the four seconds of margin on top. Writing the 44 down instead is how the first cut
of this shipped, and doubling the cycle then quietly left the tug arriving at a span still grinding
upward.

And it **waits** if it is not: `HOLD_OFF` clamps it nine units short of a span whose leaf is not up.
`clearing` has no timeout, so a lift can take arbitrarily long, and a tug that sailed on regardless
would pass through a closed span.

> The clamp needs its `toGate > 0` guard. Without it, it went on applying after the tug was through —
> `toGate` negative, still under `HOLD_OFF` — so the moment the leaf started back down it teleported
> the boat to the near side of the bridge and held it there. One tug in 260 seconds instead of four,
> and the one was going round in circles.

### Fading in, and the wake

A boat starts its run off the end of the channel, well outside the island — and the island's own rim
fades into the sky, so a fully opaque barge crossing that band hangs in mid-air over nothing. It was
reported exactly that way, with a screenshot of a barge apparently flying past the coast. Every hull
now takes `fadeAt(x)`: opaque until `SLAB_X / 2`, then a smoothstep to nothing over `EDGE_FADE` —
the same distance and the same curve the asphalt's skirt uses, because the thing it has to agree
with is that skirt.

The **wake** is one unlit quad trailing each hull, `depthWrite: false` and `renderOrder = -1` so it
lays over the water without fighting it. Its opacity is the product of two things: the hull's own
fade (a wake outliving the boat it belongs to is worse than no wake) and how far the boat actually
moved this frame over how far it *would* have at full speed — so a tug clamped at `HOLD_OFF` waiting
on a leaf sits still with a flat wake, rather than standing on the spot throwing up spray.

## Looking at it

`?shot=14` frames the river, `?shot=15` the leaf half way up with the tug holding station, and
`?shot=16` the leaf fully up with the tug going through. All three step the **real** state machine
rather than posing it, so a screenshot cannot drift out of step with what the player gets — and the
boats are placed before the cycle is stepped, not after, or the tug turns up parked short of a
bridge that opened for nobody.

Two things that staging got wrong and are worth not getting wrong again. The **traffic has to be
stepped too**: `clearing` holds until the deck is empty, and a car left standing there by the warm-up
never drives off unless the sim runs, so a loop that ticked only the bridge photographed a span with
its barriers down and its leaf still flat — a real state, and not the one being framed. And
`drawbridgeAt` is seconds into the cycle, so it tracks `BARRIER_SECONDS` and `LIFT_SECONDS` and has
to be re-derived whenever they move; the 3.0 and 9.5 that framed the old cycle both landed on the
wrong phase once it was slowed.

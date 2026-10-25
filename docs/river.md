# The river

`src/city/river.js` for where it goes and what it is made of, `src/geometry/bridge.js` for the
spans, `src/game/drawbridge.js` for the one that lifts, and `src/geometry/boat.js` +
`src/game/boats.js` for the traffic on it.

A river runs east–west through the middle of the city. On the 5 × 5 island it is crossed by three
bridges: a fixed one a line in from each coast and the drawbridge between them (`planRiver`). The
ring roads stop at the water. The fixed spans arch; the drawbridge is flat, and it opens.

## The city grew a row rather than losing one

The obvious way to put water on this map is to flood a block row. It costs a whole row of land
blocks, and with them whichever one-per-city landmark happened to be standing there — the depot, the
burger joint, the courtyard, the helipad.

So the Z axis has **one more** block row than X has columns — six against five (seven against six
under `?city=big`) — and one of them is the channel. Land stays a square (25 blocks, or 36),
every street survives, and the map gains an east–west street it did not have. That is what made
`GRID` come apart into `GRID_I` and `GRID_J` ([city.md](city.md#coordinates)), and it is the whole
of the cost.

**The row *is* the river**, which is what keeps everything downstream cheap:

- `blockBounds` already describes the channel — it is the gap between two roads, which is what a
  block row is.
- `layout.js` types those blocks `'river'`, so `createBuildings` (which walks `'built'`) and
  `createProps` (which walks `'park'`) skip them without being told, and `chooseGarageBlock` /
  `chooseBurgerBlock` filter them out by the same rule they already used.
- The three crossings with **no** bridge are ordinary closed segments — the same mechanism a park
  district uses when it builds over a road, so `legalExits`, the road network, ambient traffic and
  the router all learn about them for free.

The river takes the middle row (`middleRow` in `city/river.js`), so the land either side comes out
3 and 3 — or 2 and 3 in the classic city, which has two middle rows to pick from. That is the
point of it: a trip across town has to pick a crossing.

### The channel is wider than a block row (`?river=classic`)

The row is the river, but it is not a block row's width: the gap between the two bank roads is
`PITCH + RIVER_EXTRA`, 15 units of channel between the kerbs against a block's 12 (Tyler,
2026-10-18: "Can we widen the river by 25%?"). The extra 3 **grows the map** rather than coming out
of the lots either side, the same call the wider streets made (`grid.js`): a lane between two
junctions stays at least `BLOCK` long, which a dozen along-the-lane chains are sized against. Only
the river crossings get longer, and everything on the water — the decks, the leaf, the boat lanes,
the L's truss — is measured from `riverBanks()`, so it follows.

The cost is that the z lines are no longer evenly spaced: everything south of the river sits
`RIVER_EXTRA` further south. `lineZ` knows, and anything turning a z *back* into an index goes
through `gridZ` / `lineIndexZ` / `rowIndexZ` rather than dividing by `PITCH`. The painted road
strokes do the same in their shader (`uRiverZ`). `?city=big` keeps the 12-unit channel.

### Two things the network could not work out for itself

`roadNetFromGrid` tags the faces over the channel `type: 'water'`. The graph has no idea water is
there — water is not a road, so it sees an ordinary face, merged across every crossing without a
bridge. That is the right answer about the graph and the wrong one about what can be built on.

And a river face is *not* what `blockBounds` says: a row of river blocks comes back as one or two big
merged faces. `tools/roadnet.mjs` compares land against land.

## Which crossings bridge

### The island: a block in from each coast (`?bridges=classic` for the old four)

On the 5 × 5 island the two fixed bridges stand on **lines 1 and 4**, one line in from each coast,
and the drawbridge stays on whichever middle line the L is not on. Three crossings: fixed, leaf,
fixed, with one or two lines between neighbours. (Tyler, 2026-10-18: "kill one of the fixed
bridges. Pull the outer ones in a block".)

- **The L's fixed span is the one that went.** It stood right beside the drawbridge, so it was the
  crossing doing the least, and the train needs no road under it: its through truss
  (`game/ltrain.js`) carries it over open water on its own.
- **The ring roads end at the water.** Each one comes down to the bank and bends onto the bank
  street. That node has two arms at a right angle, like a ring corner, so the road network finds no
  conflicting movement and leaves it uncontrolled (`bakeSignals`); nothing yields and nothing
  stops. The ring is now two loops, one per bank.
- **Trips run a little longer.** Over the soak's nine runs the median estimated work per fare went
  33s → 34s and the longest 101s → 125s, with the same median delivered. A full tank of Loco Mode
  shakes a patrol a little less often: 90 of 112 chases against 97 over seven cities.

`?bridges=classic` keeps the layout described below. `?city=big` is unaffected.

### The rule it replaced, and the big map

`planRiver` decides, and two of the six are always the same:

| | |
|---|---|
| **The two ring roads** | Always a bridge. The outermost roads are the signal-free ring, and traffic yields into it rather than stopping — breaking it would need a fallback. |
| **One of the middle lines** | The drawbridge — near the centre of the map, and never under the L train (below). |
| **The other three** | Open water. |

Three crossings, not four, in the 5 × 6 city. The first cut bridged two interior lines as well as
the ring, and playing it the difference was obvious: with five of six lines carrying road there was almost always a
crossing within a block of wherever the taxi already was, and the river stopped being a decision.
Taking one out puts real distance between the ways over — which is the whole reason for the water.

The 6 × 7 city has seven lines, and three of them left three blocks between every way over: with
the leaf up, the taxi drove round by the ring. So it gets a **fourth crossing, fixed, one line
beside the drawbridge** on a side the seed picks (`planRiver`). Four of seven is the density three
of six was. Beside the drawbridge rather than beside the ring, so a lift still matters: the far side
is three blocks from a crossing, and the ring already serves the edge.

**The L train moves the leaf.** The train runs north-south down the arterial (`LTRAIN_NS`,
[city.md](city.md#the-elevated-train-on-by-default-ltrainclassic-to-compare)), on a 6.4 deck a lifted
leaf would go through. So the train's line always gets a fixed bridge and the leaf never does: with
the arterial on the middle line (3) the leaf moves one line over to the seed's side; with it on
line 2 the leaf stays on 3 and the fourth crossing is the arterial's. Still one `next()`, still four
crossings. `?lroute=classic` restores the old rule. Since the line turns west at the east-west
arterial, which is always north of the river, the default train never actually crosses; the rule
stays because only the straight line (`?ltrainwest=classic`) does, and dropping it would move every
city's bridges.

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
| Arched span at the crest, rise 1.9 | +1.55 | **3.55** |
| Barge, air draught 1.63 | | clears both |
| Tug (the sailboat), air draught 3.4 | | clears the arches by 0.15, **1.75 short of the flat one** |

Four numbers across three files, so the probe asserts the **chain** rather than its outcome: move
any one of them and it fails here rather than shipping a tug that sails under the bridge it opens.
The tug's mast is sized *from* `TUG_AIR` rather than eyeballed on top of its superstructure —
a first cut came out at 2.81, over the 2.75 the arches then left, and would have left the tug unable
to reach the drawbridge at all. A 1.5x mast (4.82, `(TUG_AIR - foot) * 1.5`) was tried at the workshop
bench and stood through the bridge decks, so the mast is now exactly `TUG_AIR - foot`: the tallest the
arched spans allow, with the masthead at `TUG_AIR`.

**The rise is what the mast gets.** The gap between the two clearances is the rise and nothing
else (lower the water and both move together), so how far the sailboat's mast can tower over a
barge's load is set by `ARCH_RISE`. It went 1.1 → 1.9 for exactly that: at 2.4 off the water the
mast read as a stub against the cars on the deck above it, and "a big mast, to show why the
bridge has to open" had no other lever that moves it a long way.

### The rise is a camera number

A world-Y lift of `h` moves `6.45h` px up the screen at play zoom (`SCREEN_PER_WORLD_Y` 0.838 ×
7.7 px per unit), so 1.9 is about **12px**. That is still under the roadworks hop's 2.75 apex
(~18px): a hump wants to stop short of where a jump starts. Peak grade is `rise · π / span` ≈
**26°** on the 12-unit span and 29° on the narrow one. It opened at 1.1 (7px, 16°) and was raised
for the sailboat's mast — see above.

### Lit smooth, cut hard (`?bridgenormals=classic`)

The deck is `DECK_SEGMENTS` (10) flat quads, which is a hump with no visible kinks in its outline
at play zoom — but under the city's `flatShading` every quad also took its own face normal, so the
sun stepped across the crest in ten bands of shade down the carriageway (Tyler, 2026-10-25). The
surfaces that follow the profile — carriageway, footways, centre dashes and soffit — now carry the
arch's analytic normal `(0, 1, −dy/dz)` at every vertex (`bendNormals` in geometry/bridge.js), and
the fixed spans are drawn under `propMaterial({ smooth: true })`. Only the normal bends, along the
span; the geometry, its winding and the shadow and AO it casts are unchanged. Everything else on the
bridge — kerbs, edge beams, end caps, rails, abutments — keeps the face normal `bakeColor` gives it,
so the deck's edges stay as hard as they were. The probe asserts both halves. The drawbridge's leaf
is flat and untouched. `?bridgenormals=classic` restores the faceted deck.

### How a car gets over it

**Render-only, exactly like the roadworks ramp.** `car.s`, `car.lane`, the turn decision, following
distance and the collision test all carry on as if the deck were flat, which is what stops a piece
of scenery being able to break the sim.

`deckHeightAt(x, z)` is **world-space** rather than keyed by lane id, because that is the shape both
callers already have in hand: `sim/traffic.js` poses a car from `car.x`/`car.z`, and the effects
that come off the tarmac have a position and no lane.

Sampled at the **nose and the tail**, not the centre. A rigid body pitched to the tangent under its
own origin floats at the crest and buries its nose at the foot; two lookups cost one rectangle test
per arched span and are simply correct.

The **route band** takes the same treatment, for the same reason and one layer up: `routeline.js`
builds its ribbon from lane geometry, which is flat, so a route over a hump drew a straight yellow
line through the middle of the deck. Every vertex it emits takes `deckHeightAt` on the point it is
actually at.

> **That fix alone did nothing, and the reason is worth keeping.** The band emits one quad per path
> segment and deliberately does not subdivide straights — the fade is a per-fragment varying, so a
> 20-unit straight needs no interior vertices. True while the only per-vertex data is `aDist`, which
> is linear; false the moment Y is a `sin^2`. And the bridge case is exact rather than approximate:
> a junction arm is trimmed to the *crossing* road's half-width, so a bridge lane starts at
> `riverBanks().z0` and ends at `.z1` — the lane and the deck are the same segment — and those are
> precisely the two places the arch evaluates to **zero**. The height term was multiplying nothing,
> six vertices out of six. The band was not merely flat, either: it is depth-tested on purpose so
> traffic drives over it, so the chord was swallowed by the deck and the route vanished mid-river.
>
> `densifyOverWater` is the actual fix — it splits any segment crossing the channel at
> `DECK_SEGMENTS` fixed world z-planes, matching the deck's own facets so the two do not beat
> against each other. **Fixed in the world, not measured from the head of the path**: the file's
> contract is that nothing ahead of the car re-shapes as it advances, and a car-relative step would
> make the mid-span facets crawl every frame. `MAX_POINTS` had to be re-derived with it — an
> overrun is silent, because writes past the end of a `Float32Array` are dropped.

The profile is `rise · sin²(πu)`. Zero slope at both ends is the point, not a detail — a curve that
arrives at the abutment with slope left in it kinks where deck meets road, and no rise tunes that
out.

### Except in Loco Mode, where it is a ramp

The arch is not a gameplay surface — it changes no speed, no braking and no collision envelope. The
one exception is the boosting taxi, which **launches off the crest** into the same hop the roadworks
ramp fires (`launchHop`, `sim/traffic.js`), because a hump you take at boost speed reading as
nothing at all is the one place the render-only rule looks like a missing feature rather than a
clean separation.

**It launches `HOP_LEN / 2` short of the crest**, and that is derived rather than tuned: the arc is
`sin(pi u)` over `HOP_LEN` of travel, so it peaks half a hop-length after the launch, and firing
half a hop-length before the top puts the taxi in the air *over* the summit. `deckHeightAt` returns
a signed `toCrest` for it — the profile's own business, not something `traffic.js` should re-derive
a span to work out — and `dirSign` turns it into a distance ahead.

> **The first cut fired on the descending slope, and it was wrong in the way that is hardest to
> see: it did exactly what it said.** The guard was `y > 0.75 * ARCH_RISE && dydz * dirSign <= 0`,
> and on a `sin^2` the height test holds across the middle third while the slope test holds from
> the peak on — so the two together select the **first frame past the exact apex**, every time.
> The height test was doing nothing at all; the slope test was the whole gate. Played, it reads as
> "the bounce starts late, almost at the apex", which is precisely where it started. Measured: the
> launch landed 0.26 units past the top and the taxi came down **0.94 units past the far abutment,
> in the junction box**. Off the climb it touches down with about two units of deck still in hand.

The one guard that survived unchanged is `car.archHopLane !== car.lane.id` — once per crossing.
Without it the hop retriggers every frame the launch window is satisfied and the taxi hovers across
the river.

**It only launches a taxi doing at least cruise speed (`HOP_MIN_V`), and once up it always comes
down.** The arc is paced by distance, so a car that stops in the air stays in the air: boosting onto
the hump and braking hung the taxi 3.5 units over the crest for as long as the pedal was held, and
slowing before the hump launched a hop at walking pace (Tyler, 2026-10-14: "the car sort of gets
stuck in a little jump sequence"). Now the brake is deaf for every hop, not just the drift launch,
and the arc never runs slower than half of cruise — a taxi held up in the air by something else comes
down where it is. `?hop=classic` puts the stall back.

**The landing is the other half of the stunt.** Touchdown fires `traffic.onTaxiLand` — the same
event the barricade's landing fires, see [traffic.md](traffic.md#touchdown-published) — which rocks
the suspension through three decaying rebounds and puts a camera shake, a burst of dust and a shower
of sparks under the car. All three are placed against the event's `deck` height rather than against
the road: on an arch the taxi comes down about 0.3 up the far slope, and dust puffed at road level
there hangs in the channel a metre under the car, over open water, with the arch it came off in
between.

### The drift launch

A drift kick still being carried when the taxi reaches the hump (`car.drift.phase === 'carry'`)
turns the hop into a launch: the same `hopFrom` arc and the same trigger point, but
`DRIFT_LAUNCH_LEN` = 20 units long and `DRIFT_LAUNCH_HEIGHT` = 10 high (`car.hopBig`). The length
is derived: from 3.25 into the deck lane it clears the rest of the deck and the whole junction on
the far bank (8 wide, 10.67 for an arterial) and comes down 3.25 or 0.6 into the next street, five
units clear of its hold line. So it only fires when the exit at the far bank is **straight on** —
a turning route there gets the ordinary hop, since the arc would otherwise bend sideways in mid-air.
The router tips near-tied routes toward going straight on there (`BIG_AIR_TILT`,
[gameplay.md](gameplay.md#routing)), which took that from 35% of crossings to 69%.

The carry is a clock and the bridge is a place, so the kick also counts for `DRIFT_LAUNCH_GRACE`
= 12 units of travel after its carry runs out on its own (not braked, turned or crashed out of): a
tier-1 kick out of the corner one block back otherwise ran out ~5.5 units short of the launch point
and flew the ordinary hop at the kick's speed. A free-driving taxi (no route) with a kick in hand
has its far-bank exit set to straight on, rather than losing the jackpot to an unseen dice roll.

While it is up there the taxi keeps the boosting taxi's priority junction and its full boost power
whatever the pill says (letting go mid-flight used to coast it from 31 u/s down to 16 before
touchdown), ignores the brake (a distance-paced arc on a stopping car is a taxi parked ten units up), and
`sim/collisions.js` skips it above `DRIFT_LAUNCH_CLEAR`. main.js slows the sim toward the apex
(`launchTimeScale`, down to 0.4) so 0.65s of flight hangs for about a second, and the landing is
the slam: the squat and the pitch kick scaled by `DRIFT_SLAM`, a 1.6 shake, a body thud and a ring of
dust. `tools/probe.mjs` asserts the chain, the brake, the let-go pill, the turning exit and the collision
skip.

Mid-flight the taxi **barrel-rolls**: one full turn about its own long axis (`barrelRollAt` in
`sim/traffic.js`), eased in from 12% of the arc and level again by 78%, so the takeoff still reads
as a ramp and the slam lands on the wheels. It turns about `TAXI_ROLL_PIVOT` (half the deck height)
rather than the origin at road level, which would swing the car round its own tyres, and the Loco
plume (`game/locoflame.js`) swings with the tailpipe. Render-only; `?barrelroll=classic` flies it
level. The probe asserts the body goes upside down and is upright at touchdown, and that neither
the ordinary hop nor the classic flight rolls.

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

### The abutment stands proud of the channel wall

The wall runs the full width of the map, uninterrupted, and each bridge's abutment reaches forward
under its deck to the same water's edge — so the two want the same vertical plane, over the deck's
full 10.8 units and the 2.25 they share in height. They used to land on it *exactly*: the wall
arrives as `banks.z0 + EMBANK_WALK` and the abutment as
`span.z0 + ABUT_DEPTH + DECK_OVERHANG − ABUT_DEPTH`, and both round to the same float32,
6.733333110809326.

That was written up as safe, on the grounds that the pair face opposite ways so one is always
culled. They don't: the wall faces **into** the channel and so does the abutment's face, because it
is the far end of a box standing behind it. Both are front-facing at the far bank at once — which is
the bank you see through the arch.

**An exact tie does not shimmer**, which is why it survived so long. There is no depth to compare,
so the plane goes to whichever surface the rasteriser rounds in front, and it rounds a map-wide quad
and a small box face differently: one clean surface in every headless still, a hard-edged patchwork
under the arch on a phone. Headless the plane came out wholly the abutment's; on the device it was
reported from, the same face came back cut in two.

`ABUT_WALL_CLEAR` (0.1) breaks the tie by standing the abutment **proud** of the wall. The size is a
depth-buffer number: this camera's frustum is 1 to 1400, so a 16-bit buffer — which a phone may hand
back — quantises at 0.021 a step, and 0.1 is five of those against 1200 of a 24-bit one. Proud
rather than recessed is a decision about what the arch frames: recessed hands the plane to the wall,
which runs straight past the bridge, so the arch would frame an unbroken bank with no abutment in it
at all. `tools/probe.mjs` asserts the clearance signed, at both ends of every span — the near bank's
pair has the identical fault and is merely back-facing today.

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

## The harbor

`src/city/harbor.js`, placed by `harborBasin()` in `grid.js`. Default; `?harbor=classic` (and
`HARBOR=classic` for the headless tools) keeps the old east mouth.

The river used to run under the east ring bridge, along a few units of walled channel, and stop under
the island's rim. Now the east side of the island is a waterfront: the east ring road, a seawall a few
units off its kerb, and two piers either side of a dock basin 48 across that the channel opens into
nine units past the kerb. Everything else east of the ring road is **sea**, out to where the rim used
to be (`HARBOR_REACH`, 44, past the old coast). Two big cranes (`CRANE_SCALE` 1.4) stand on one
quay over the ship's berth, each pier carries a big warehouse at its landward end and a container
yard behind it, and long sheds stand on the aprons beside the channel's last stretch. The seawall is
a **rocky shore**: a bank of boulders tipped against it from the waterline nearly to the top, and a
looser apron of smaller ones out in the water (`ROCK_*`). Tyler, 2026-10-13: "keep the harbor on the
east edge. Rocky shore, maybe some warehouse buildings, 2 big cranes, ships coming in and out of
port".

**The ships move** (`game/harborships.js`). One container ship at a time: in from past the sea's fade
down a lane `LANE_OFF` off the berth, eased sideways onto the berth under the cranes, a spell
alongside, off again, **astern** out past the pier ends, turned about its middle in open water, and
away. Astern because a 19-long ship turning in the basin sweeps a circle reaching the river's mouth,
where the barges come out. Two hulls take turns. They fade with `alphaHash` past `coastEast()`, so a
ship arrives out of nothing rather than popping in over the sky. Shot mode settles one alongside.

**East, because east is the near edge.** The camera looks down the −x−z diagonal, so +x is the lower
right of the screen. The harbor sits in front of the city rather than behind its towers, and a
crane's height (about 12 to the apex, hiding ~13 units of ground behind it) is thrown up-screen over
its own yard rather than over the streets. For the same reason the cranes and the ship are on the
**far** (−z) quay by default: that quay wall faces the camera across the water, so the ship sits in
front of a lit wall.

**One outline, read by three files.** `city/harborplan.js` builds the shoreline — `islandHalf()` per
side: the west corner, the coast, a rounded corner into a seawall that wobbles on two sines, round
the pier and back along the quay. The slab is cut from it (`ground.js`), the walls and riprap stand
on it (`harbor.js`), and the sea (`seaMesh` in `river.js`) lies under it. Tyler, circling the bare
asphalt past the yards: "Can we fill these with water? And make the waterfront edge more organic".

**Nothing in the grid moved.** The harbor is all outside the ring road, so the road network, routing,
fares and every probe staging see the same city. The waterfront drive is the east ring road, and its
junctions already take riders.

What had to learn about it:

| | |
|---|---|
| The slab (`ground.js`) | Two polygons, one per side of the river, from `islandHalf`. `asphaltFade` treats everything from the corner where each coast turns into the seawall as a cut, and `seaCornerFade` carries the rim on round that corner over the water, tapering out. |
| The sea (`river.js`) | `seaMesh`: one sheet at sea level from the seawall corners to the rim, deep in the middle and dissolving into the sky with **no shoal**. Shoaling it the way the river mouth does drew a dark mud bank round the whole sea. It reaches six units back under the rim on a ramp, because sitting two units lower it draws 2.17 units further +x and +z than it is, and without the overlap that strip showed open sky. It shares the river's colours and the river's own water program (`patchHarborWater` is `patchRiverWater`'s compile), so the mouth is one body of water: the walls end where they end (`waterWallAt`), the basin's back wall and far quay are mirrored and seen under the surface (`waterBasinHit`), the lip runs along the quays and round each corner of the mouth (`waterEdgeDist`), and the channel's bed and colour run into the sea's over the last `SEA_RUN_IN` (10) before the mouth. A separate sea compose drew a hard line across the mouth. |
| The coast (`coastFor`) | The water's fade and where boats spawn, fade and retire are measured per side. The east side never shoals (`shoalMix`). |
| The L train (`ltrain.js`) | Runs north-south now and never comes near the harbor. Under `?lroute=classic` it runs east-west out over the harbor on columns stood in the water (`harborLandAt`), and in about half of all cities along the far pier through the cranes' landside rail, so `harbor.js` moves the cranes and the berth to the near quay when it does. |
| The camera | Manual panning reaches 0.7 × `HARBOR_REACH` further east, so a phone in portrait can see the ship. |

Shots 48 (`harbor`) and 49 (`harbor-far`) frame it, and `&view=x,z,zoom` reframes any shot.
`tools/probe.mjs` asserts that the quay walls face the water, that the ship is held off its quay and
never touches land or comes near the boats' lane on its way in and out, that
nothing stands inside the ring road, that no slab lies over the basin, that the sea faces up and stays
at sea level out to the rim, that the skirt never reaches back over the city, and that nothing in the
harbor reaches up into the L train's deck.

## The park shore

`src/city/parkshore.js`. Default; `?parkshore=classic` (and `PARKSHORE=classic`) keeps the old
corner. Needs both the harbor and the north park.

North of the harbor the seawall used to round its corner west at the old coast, under the north
park's lawn, so the rocks curled away and stopped and the park's grass met the water bare, fading
out over the sea. Tyler, 2026-10-14: "Let's continue the rocky edge along the park to make this
transition smoother". Now the seawall runs straight on north to the park's far edge with the same
rocks (harbor.js builds them, as it always did along the seawall), and the sea runs on north
beside it to a rim level with the park's. `islandHalf` closes the outline back west *under* the
park (`parkShoreClosure`, `parkShoreTurnX`), where the park's platform hides it and nothing builds a
wall on it. `parkshore.js` lays the park's own kerb, pavement band and lawn over the couple of units
between the park's east edge and the wall, and fades it north on the park's feather
(`PARK_FADE`). The park's feather no longer goes round its north-east corner (`lawnFade`).

## The south shore

`src/city/southshore.js`. Default; `?southshore=classic` (and `SOUTHSHORE=classic` for the headless
tools) keeps the old apron fading into the sky. Needs the harbor's sea, so it is off under
`?harbor=classic` too.

The harbor's seawall turns the south-east corner and runs west the whole length of the south end,
with the same bank of boulders against it and the sea in front. Between the south ring road and the
water is a raised strip of park: a kerb with a pale pavement band facing the road, lawn, a walkway
that swings along it (`PATH_SWING`) and turns up to meet the pavement at the corner, lawn on to the
water's edge, and a few small trees. Tyler, 2026-10-14, circling where the harbor's rocks stopped:
"Continue the rocky shoreline around the south end. Opposite the buildings add a curb, then grass
patch then swooping walkway then more grass at the waters edge."

**The outline is the harbor's.** `islandHalf` in `harborplan.js` runs the south half's west edge
square down to the shoreline (`shoreZ`: 13 off the kerb, wobbling on two sines and eased flat into
the corner arc) and along it, so the slab, the strip and the sea all read one line. The slab's
skirt skips the shoreline the way it skips the seawall (`onShoreline`), the sea (`seaMesh`) runs west
in front of it to the island's edge and fades on the skirt's band out past `seaRimSouth()`, and at
the west end the lawn, band and walkway carry on over that band and dissolve with it
(`westFade`).

**A hot dog cart** stands on the lawn beside the walkway, on the road side, at the point where the
path has swung furthest toward the water and left the most room (`placeCart`, no draw, so it is
the same spot every run of a city). Steel box, red skirt, red and mustard umbrella, scaled 1.3 so
it reads at play zoom. Tyler, 2026-10-14: "let's place a hot dog cart along the way".

**The trees are kept small and down by the water** (8 off the kerb, 3.3–4.4 tall). Everything
here is down-screen of the ring road, and the sightline climbs 0.92 per unit, so a crown that tall
hides about 5 units of ground behind it: lawn, never the road or a rider.

**The sea out there mirrors only the sky.** The water program follows a reflected ray toward −z,
which from the south shore crosses the whole city: it met the channel's far wall ninety units off
and every bridge deck on the way (whose profile reads 0 past its span) and drew them as dark bands
across the open water. Past `uWaterShore` it returns the sky, and the bed is the sea's depth rather
than the channel's shallow margin, which had shown through olive.

Nothing in the grid moved: the strip is outside the ring road, so no street, junction or fare
changes. Shots 52 (`south-shore`) and 53 (`south-shore-far`) frame it.


`src/city/riverwater.js`, layered over `propMaterial`'s own patch on the water strip. Ripples,
depth, refraction and reflection, all in the water's fragment shader with **no extra pass**.

The cheap version is honest here for a reason specific to this game: the camera never turns and is
orthographic, so every ray leaving the water heads the same way, and what it can hit is a short,
known list — the far channel wall, three bridge decks, the sky. Each is a plane the shader
intersects in closed form. A real refraction copy or a mirrored second render of the city would buy
almost nothing over that and cost a full pass on a phone.

| | How |
|---|---|
| **Ripples** | A jittered triangle lattice (`FACET` 1.35 units, ~10px at play zoom), each triangle the plane through a sum of travelling waves at its three corners. Flat-shaded on purpose — a smooth normal map would be the wrong look for this city. |
| **Depth / refraction** | The view ray is bent by the facet (Snell, 1.33) and followed down to the bed (`BED_DEPTH` 2.6) or the far wall's submerged face, then absorbed by the path length, red first (`ABSORB`). The wall visibly carries on under the surface near the far bank and fades — that is the depth cue — and the facets make it wobble. |
| **Reflection** | The mirrored ray is followed to the far wall (with its railing), each bridge's fascia or soffit, or the sky (the haze colour, so it follows `daylight.js`). Weighted by Fresnel with a floor (`REFLECT_FLOOR`), because water's real 4% at this angle is invisible at play zoom. |
| **Glints** | Blinn-Phong off the facets in the light loop (`RE_Direct_Water`). Mostly dark by day: at the parked 16:24 sun the light is *behind* the camera, so a facet would have to tilt ~58° to glint, which is physically right. The police cruiser's lamps do glint. |

**The smooth look is the default; the table above is `?water=classic`.** At play zoom the facets
read as pixels rather than as low-poly: one normal per ten-pixel triangle means the mirrored ray
crosses the top of the far wall a whole triangle at a time, and the reflection band's edge came out
as a staircase. There is no reflection texture behind it to sample better — the step was in the
normal. The default (`setWaterStyle`, `WATER_SMOOTH` in the shader) changes three things:

| | How |
|---|---|
| **Normal** | The analytic gradient of the same travelling waves plus a finer octave, per pixel (`waterSmooth`). `SMOOTH_AMP` is 0.06 — a quarter of the facets' height — because a continuous surface at the facets' slope folds the wall's top edge and the railing into closed rings (marbling); this low, the reflection stays as wavy bands parallel to the wall. The wall/sky blend is ±0.3 rather than ±0.06 and the railing lines are `fwidth`-antialiased for the same reason. |
| **Depth** | The bed shelves on a sine, `BED_EDGE` 0.45 at each wall to `BED_MID` 3.4 down the middle, so the margins show the lit bed and the centre loses itself; the strip's vertex colours turn round to match (open at the walls, `riverDeep` down the middle, five rows). |
| **Lip** | Fresnel pushed to `RIM_REFLECT` within `RIM_W` (0.55, ~4px) of each wall, plus a fainter sky sheen over 1.6 units, so the water lightens into the concrete. |

Two things are deliberate:

- **The mouth is untouched.** Every term is scaled by how deep the water is, *cubed*, so it has gone
  before the shoal's colour finishes turning into the asphalt `riverMouthFade` lies over. Linear,
  the half-shoaled stretch under the ring bridge came out teal against the skirt's grey.
- **The drawbridge drops out of the reflection the moment its leaf moves** (`bindRiverDrawbridge`).
  A flat deck mirrored under a leaf standing on end is worse than no deck.

`syncRiverWater` runs in `renderFrame` rather than the loop so shot mode gets the right sky and
leaf state; `tickRiverWater` runs on game time, so the ripples stop with the pause.
`tools/probe.mjs` runs the patch against three's real Lambert source and asserts every replace
landed.

## The drawbridge

`src/game/drawbridge.js`. **The only thing in this game that changes the road network while the
player is driving it.** A park district closes a road before the run starts and a roadworks zone
only ever makes one cheaper; this takes a route that was valid ten seconds ago and stops it
existing, with a clock running in the back seat.

It is a **double-leaf** bascule: two half-leaves meeting over the middle of the channel, each hinged
at its own bank with its own pair of counterweight houses, so the boat goes through the gap between
them. For the first few seconds of a lift the near leaf is a ramp, and the taxi can jump it — see
[Jumping it](#jumping-it-mega-air). `?bridgejump=classic` is the single long leaf hinged on the
near bank, with no jump.

### The cycle

```
open ─▶ clearing ─▶ closing ─▶ lifting ─▶ up ─▶ lowering ─▶ raising ─▶ open
```

| | |
|---|---|
| `clearing` | Lamps flashing, arms still up, **both** closures published at once. Hold until nothing is on either lane. **No timeout.** |
| `closing` | Barriers down, 2.2s. Re-checks the deck before the leaf moves. |
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

The arms are striped black and white on the diagonal, like a railway crossing arm, and the stripes
are geometry rather than a texture: each is a box sheared along the arm so its edges run at 45
degrees across both faces the camera sees, with the end stripes clamped square (`stripedBar`).

Each arm carries **two amber warning lamps**, one near either end, flashing alternately at a level
crossing's rate (`LAMP_PERIOD`, one flash a second per lamp). They come on with the first frame of
`clearing`, so they are the warning while the deck empties and are already flashing as the arms drop,
run through the whole lift, and go out `LAMP_TAIL` (1s) after `raising` has the arms back up. Both
arms flash in step so the pair across the road reads as one signal. A lamp is switched on its
colour (`lightYellow` against the dark `gateLampOff` lens) *and* its bloom scale, with a hard
switch rather than a fade: at that rate a fade spends most of its time at half brightness and reads
as a dim lamp. Shot 42 (`drawbridge-gate`) frames them; `tools/probe.mjs` asserts the timing and the
alternation.

The end of `lowering` fires an **`onLand` callback with both abutment feet**, and `main.js` throws a
puff of dust at each out of the pool the roadworks smash and the boosting taxi already share. The
leaf coming home is the one moment in the cycle with an impact in it and it was landing in silence;
a bridge dropping a hundred tonnes onto a stone seat kicks up what a car scrubbing its tyres does,
and it is the same dust either way. Smaller and shorter than a barricade smash — `power` 0.7 against
well over 1 — because this is a heavy thing settling, not something exploding, and aimed **along**
the span so the collars spread down the road rather than out over the water.

**`clearing` is what makes this safe.** The lamps are going and the lanes already shut, so nothing
new can reach the deck; what is on it drives off, and only then do the arms drop and the leaf move.

**It clears before the arms drop, not after.** The cycle used to run `closing` then `clearing`. Both
arms span the whole carriageway, so every car still on the span drove out through the far arm, and
one already committed to the turn onto it drove in under the near one — reported as cars driving
through the arms and sitting on the bridge with both arms down. Over 20 cities, 300s each with a
lift every 30s, 141 of 200 cycles dropped the arms on an occupied deck and 204 cars crossed an arm
line with it more than a quarter down. Clearing first: 0 and 2, and the 2 are cars setting off
under an arm on its way back up in `raising` at 56° off the road, which is the level-crossing
behaviour `raising` exists for. The audio master starts on `closing`, so the hold now sits ahead of
it rather than in the middle of it. A car
queued behind a red at the far junction, or a player sitting on the crest with the brake held, holds
the whole cycle — the boat waits. A lift that fired anyway would be the one event here that can
throw a car into the river, and "it hardly ever happens" is not a property worth having.

`HOLD_SECONDS` is a backstop, not a hold, and **it has to be longer than the thing it backs up or
it becomes the thing**. A tug asks 30 units out and lets go `TUG_LEN + 4` past the span, which at
3.4 u/s is 11.3 seconds of request. At 4.5 the backstop fired first and started lowering the leaf
onto a boat still four seconds short of it. It is 20 now, which is that 11.3 plus most of it again.

### 70°, and what bounds it

A real bascule opens to about 80. The ceiling here is what the leaf **hides**: the single leaf
(`?bridgejump=classic`) spans the channel, so it stands 10 units up and casts a 15-unit blind spot
over the far bank. Past that it starts hiding the road beyond — and a marker the player cannot find
is exactly what `cornerSeen` exists to prevent, except that this one comes and goes, so no static
filter can catch it. Split, each half is half that length and stands ~7 up, so the angle is kept and
the blind spot shrinks; the price is that the camera-side half now stands between the player and
part of the channel, which the one far-hinged leaf was placed to avoid.

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

### Jumping it: Mega Air

Tyler, 2026-10-24: "what if our drawbridge split in the middle and opened up from both sides, kind of
creating a ramp, and then that turned into a stunt route ... super max air". While the leaves are
rising through **8° to 45°** (`STUNT_FROM`/`STUNT_TO`, about 1.4s to 4.1s into the smoothstepped
lift) the near leaf is a ramp. Below that it is barely off its seat; above it, it is a wall.

**The route keeps the span until the window closes.** It used to be re-planned round the moment the
lamps started. Now the taxi's router (and only the taxi's: `setStuntLanes` in game/route.js keys off
`laneCost`, which no service router uses) can still plan over it through `clearing`, `closing` and
the window, and the span is blocked and the taxi re-planned the frame the leaves pass `STUNT_TO`.

**The gate decides at the hold line** (`gate` in drawbridge.js, `stuntVerdict` in sim/traffic.js):

| Phase | Says |
|---|---|
| `clearing` | `pass` — the arms are up; cross as a road, and the deck waits for you as it would anyway |
| `closing`, or `lifting` under 8° | `hold` — a red: the taxi brakes for it on the approach and waits at the line |
| `lifting` 8°–45° with Loco held | `go` |
| `lifting` 8°–45° without | `hold` |
| anything later | `refuse` — the ordinary refusal, which drops the route |

So **nothing ever falls short into the river**. Without Loco the taxi waits at the line and is
re-routed when the window closes; the cost of not jumping is those few seconds, and the wait is also
where the player finds out there was something to jump.

On `go` the arm the taxi drives through is flung up for 1.6s, the route is bent **straight on at the
far bank** (the flight crosses that junction in the air) and main.js re-plans from wherever the taxi
comes down. On the deck lane it launches at Loco's top speed whatever it had built up from the line:
the arc is distance-paced, and one flown at a crawl hangs over the river.

The arc (`hopKind: 'bridge'`, sim/traffic.js) rides the leaf's surface at its live angle up to the
tip, then flies an arc from the tip's height that peaks at `MEGA_AIR_HEIGHT` = 14 (~90px at play
zoom, four over Big Air) and comes down `MEGA_AIR_PAST` into the street past the far bank. It is
steeper than the leaf at the lip, deliberately: off a 30° ramp the true projectile apex is about 5,
which is a hop over a river. `hopBig` stays true, so everything that treats Big Air as airborne — the
priority junction, the deaf brake, the collision skip, the slam — does the same here; collisions ask
`airborneHeight` rather than assuming a sine. The trick is a **front flip** (`megaFlipAt`), because
the barrel roll is Big Air's, about the same pivot, and the Loco plume swings over the roof with the
tailpipe. main.js slows the sim to 0.28 at the apex (Big Air's 0.4) for it, and the meter pays
**Mega Air +3**.

`tools/probe.mjs` drives it end to end: held at the line with the arms down, launched inside the
window with the arm knocked, past 90% of `MEGA_AIR_HEIGHT`, upside down mid-flight and upright at
touchdown past the far bank on a route that wanted to turn there — and, without Loco or under
`?bridgejump=classic`, never on the deck at all.

### The three closure sets

| Set | Who | Says |
|---|---|---|
| `setClosedLanes(ids, 'roadwork')` | `roadwork.js` | ambient traffic keeps out |
| `setRoadworkLanes` (`route.js`) | `roadwork.js` | the taxi is *tempted in* — the asymmetry is the vignette |
| `setClosedLanes(ids, 'drawbridge')` + `setBlockedLanes` | `drawbridge.js` | nobody crosses, taxi included |

`setClosedLanes` is **keyed by source** now. It was one set with one owner and `roadwork.js`
replaced it wholesale, which is correct exactly while nothing else holds a closure — a zone standing
up mid-lift would have reopened the span under it.

The `'drawbridge'` source is also **hard** in the traffic model, which no other closure is. A
closed lane only zeroes the *dice*; a routed car drives its route regardless, which is right for
the taxi at roadworks and was wrong at the river: only the taxi is re-planned when the barriers drop,
so a patrol cruiser carrying a route planned with the span down drove across the open leaf. A routed
car whose next turn enters a hard-closed lane now drops its route and rolls an exit instead
(`hardClosed` in `sim/traffic.js`, counted in `stats.routeRefused`), and game/patrol.js re-plans the
empty route on its next frame.

`setBlockedLanes` is enforced by **skipping** the lane in `search`'s successor expansion rather than
by pricing it high. A weight, however large, is still a number Dijkstra will pay if it has to — and
on a city where the bridge is the short way across, "has to" is precisely the case that comes up.

The re-plan on `clearing` is unconditional and does not need to ask whether the old route used the
span: the lanes are already blocked, so a route that never went near the river re-plans to itself.
Passing the **same target object** keeps that free — the band's rollout sweep keys off
`pendingTarget`'s identity ([gameplay.md](gameplay.md#dragging-the-route)).

### It shows no traffic light

The span carries no stop bars, though the junctions at both banks are ordinary signalised interior
junctions. A bridge lane is exactly the deck, so a bar would land on it — and on the drawbridge it
did, on a leaf that then lifted out from under it. See
[traffic.md](traffic.md#and-none-over-the-river) for the rule and what it deliberately leaves alone.
The orange boom is the bridge's only "stop", which is also the only one telling the truth: during
`clearing` and `closing` the lane is already shut while a stop bar would happily be green.

It used to decline to lift while a siren was running down its line, because the patrol cruiser was
a scripted car that could not stop for a barrier. It is a car in traffic now and stops like anybody
else, so the hold is gone.

## Boats

`geometry/boat.js` builds them, `game/boats.js` runs them. **Run seed, not city seed**: which span
lifts is a fact about the map and has to stay learnable, but when it lifts is the situation.

**What they look like, and how big.** Sized against the cars (3.4 × 1.7) and the water (12.2 across,
10.87 on the narrow build). The barge is a 13.75 × 5.25 **trash barge**, about half the channel: a rusty scow
square at the stern and rounded at the bow, with tyre fenders down its sides, a heap of bin bags,
cardboard, tyres and drums drawn per hull, and a steel wheelhouse at the stern with a funnel up its
back wall. It replaced a 16 × 6 container barge that read as big and as a slab. It was 11 × 4.2 until the
river widened (#563) and left it at 39% of the water; it grew a quarter **in plan only**
(`BARGE_SCALE`), because every height on it is pinned under the flat soffit. The wheelhouse is
hunter green, matte and weathered (rust streaks under the windows, a grime line at its foot), on a
mesh of its own so its windows can wear the cars' glass (`propMaterial({ gloss })`). Everything stays under `BARGE_AIR` (1.63, against the flat span's 1.65), and that is
the only thing bounding how tall the wheelhouse can be — its roof sits on it exactly: the heap stops lower, at
`PERCH_CEIL`, so a gull standing on it still clears the flat span, and the wheelhouse roof is not a
perch for the same reason. The boat that asks for the lift is a 6 × 2.4 **sailboat** with a white hull with its
sails down, a tall mast and a little blocky outboard clamped to the transom (it reaches 0.3 past the
stern, so `TUG_LEN` is unchanged); the code still calls it the tug (`kind: 'tug'`, `TUG_AIR`, `TUG_LEN`).
Its mast runs from the deck to `TUG_AIR` exactly, the tallest the arched spans allow. The coachroof wears
its own palette entry (`sailCabin`, the pale river-cyan `#BCE6EB`; the hull's `sailHull` is the white) so it is coloured apart from the hull.

**The gulls** (`game/gulls.js`): five per barge, a child of the hull mesh wearing its material, so
they ride with it and fade with it at the coast. Some stand on the heap or the bow; the rest circle low over it, and every few seconds one lands or takes off. A flying gull is
drawn 1.5× life size (`FLY_SCALE`) — at play zoom a life-size one was a white speck. They draw from
their own rng stream, seeded with one draw off the boats', so the launch schedule does not depend on
how often a bird landed.

The bridges are the constraint, and there are two rules for them. A gull only takes off or lands
when no span is over the hull for the length of the move (`gullsClear` in boats.js) — a perched bird
fits under the flat soffit (`PERCH_CEIL + GULL_STAND` = 1.62 against 1.65) and a bird mid-move does
not. And the circle is flown at `FLY_LOW`, 3.8–4.9 off the water, but each bird climbs to `FLY_HIGH`
(7.4, over a truck on the arch crest) as it nears a span and drops back once past. The first cut flew
at bridge height the whole time and the birds hung so far up-screen they read as gulls over the far
bank. The probe soaks five minutes and counts bird-frames inside a deck: zero.

A barge every 16–34s and a tug every 30–50s, so **a lift about every 45 seconds** (median 45, first
one ~38s into a run) and the span shut about half the time. Both are slow on purpose — 2.6 and 3.4
units per second against a car's 8.5 — because what sells a boat is being the slowest thing in the
frame.

The river is single file and **every boat keeps `FOLLOW_GAP` behind the one ahead**: a tug that
catches a barge slows to it, and a barge reaching a tug held short of the leaf waits behind it. The
schedule only spaces launches (`LAUNCH_GAP`), and a tug that comes due goes before any barge. The
lift is held while *any* tug still wants it, re-asked every frame, so two tugs close together go
through on one lift and a tug left waiting by `HOLD_SECONDS` gets another.

It was a tug every 90–150s that could only set off onto an empty river, with no barge allowed out
while one was due or out. That made the wait the floor rather than the spacing: the tug also waited
out every barge and its own trip across the map, and the lift came round every **179s** (median of
30 seeds, 141–225), first 2:16 in. Tyler, 2026-10-19: "I rarely see it."

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

### Single file

**Everything runs down the middle** (`BOAT_LANE` is 0, `LANE_WANDER` 0.2). It started when the
barge filled three quarters of the water, and it survived the barge shrinking to half: two 5.25-wide
hulls need 10.5 of a 10.87 channel on the narrow build, which is touching. Boats used to keep a lane each way, port to port,
and the two bounds on that lane — a floor so passing hulls do not touch, a ceiling so the tug's mast
clears the arch off-centre — are what kept the hulls under half the channel wide. The centreline is
also where the arch is highest: `deckHeightAt` is a function of `z` alone and crests there, so the
mast's worst clearance is 3.64 against its 3.4 on the narrow channel.

Keeping hulls apart is the **launch schedule's** job now, three rules in `createBoats`:

- **Everything on the river goes the same way.** A new boat takes the direction of whatever is
  already out; only an empty river draws a fresh one. Barges all run at 2.6, so one never closes on
  another, and nothing meets head-on.
- **The sailboat only sets off on an empty river.** It is faster than a barge and would run one down.
- **No barge sets off while the sailboat is out or due.** A barge stops for nothing and would sail
  into the back of one holding at a shut leaf. Holding them back while it is due is what lets the
  river drain (a barge takes ~70s to cross) so the sailboat can go at all.

The probe asserts it over a five-minute soak: no frame with two boats going opposite ways, and the
closest bow-to-stern gap. The staged screenshots break the schedule on purpose — `settle()` puts a
barge and the sailboat on the river together — so the barge goes 60 units astern, which is what 13
seconds of staging needs to not sail through the sailboat waiting at the leaf.

> The old free-for-all lanes were once over the arch ceiling: `wander` reached 2.4 where `TUG_AIR`
> needed `|dz| ≤ 2.29`, so about one tug in twenty drove its mast through a fixed span's soffit,
> silently. The clearance check still asserts the bound on the widest lane the generator can hand
> out rather than on whatever a soak happened to draw.

There are exactly two channel widths, because `arterialX` holds a single line and so at most one
bank can be an arterial: 12.0 and 10.67 kerb to kerb.

### Fading in, and the wake

A boat starts its run off the end of the channel, well outside the island — and the island's own rim
fades into the sky, so a fully opaque barge crossing that band hangs in mid-air over nothing. It was
reported exactly that way, with a screenshot of a barge apparently flying past the coast. Every hull
now takes `fadeAt(x)`: opaque until `SLAB_X / 2`, then a smoothstep to nothing over `EDGE_FADE` —
the same distance and the same curve the asphalt's skirt uses, because the thing it has to agree
with is that skirt.

The **wake** is a particle pool — `game/wake.js`, and
[rendering.md](rendering.md#boat-wake--gamewakejs) carries the tuning. What this file owns is the
two things about it that are facts about the river rather than about the effect:

- **It is spent per unit travelled**, not per second, which is what makes a tug clamped at
  `HOLD_OFF` in front of a leaf that has not come up lay nothing at all. That used to be an explicit
  "how far did it actually move this frame over how far it would have" term multiplied into the
  wake's opacity — otherwise a boat holding station sat there throwing up spray, doing a wheelspin.
  Keyed to distance it stops being a special case and becomes what the emitter does.
- **The arms are clamped at the bank.** They open on the Kelvin angle, which is a function of the
  boat's speed and knows nothing about the water it is in — and this water is 7.87 units across on
  the narrow build against a barge whose arms start 2.0 off the middle (each hull throws them from
  just inside its own side), so there is under two units of open water outboard of a hull. Left to open freely the foam is over the embankment inside a second
  and a half. The pool takes `waterEdges()` for that reason, and a mote is held at the bank less its
  own radius, which is also what a wake in a narrow channel actually does.

Each mote also carries the hull's own `fadeAt`, sampled **at the x it was laid at** rather than the
boat's. Foam does not travel with the boat, so it cannot inherit the boat's opacity either — and
since a mote never moves along the channel, one sample at spawn is exact for the rest of its life.

> **The wake this replaced shipped wound upside down and therefore did not draw at all**, which is a
> worse failure than drawing wrong. It was one hand-written triangle through `unlitMaterial`, which
> is `MeshBasicMaterial` and `FrontSide` like everything else but has no lighting to go strange with
> — so where the roadworks ramp and the bridge deck at least *looked* broken, this was simply
> absent, for weeks, under a comment claiming it was wound to face up. The normal computed from the
> winding was `(0, -15.08, 0)` on both triangles. A feature that renders nothing is
> indistinguishable from one nobody got round to, and that is exactly how it was reported: "I think
> we're still missing boat water trails."
>
> The particle pool cannot fail that way — three builds the mote — but `?shot=18` still frames a
> boat under way, because every *other* way this can go missing looks the same from a wider shot. At
> play zoom a wake is a few pale pixels, and a few pale pixels missing looks like nothing at all.

## The mouth

**Under the fog of war (the default island), the river just runs on into the clouds.** The water
stays flat at `WATER_Y` and in its own colour, opaque, and the channel's walls, walk and railing run
`EDGE_FADE` past the west coast (`channelWest`), out to where the fog
([rendering.md](rendering.md#the-fog-of-war--gameedgefogjs)) has gone solid whatever its billows are doing. The
fog is what dissolves the mouth, so there is no rim fade for the channel to cross and nothing for a
shoal to close. Left on, the shoal drew the very thing it existed to hide, wherever a billow thinned
enough to show it: the river turning to asphalt and ramping up out of its own cutting into the
clouds (Tyler, 2026-10-20: "Don't have the water slope up - just continue flat off into the
clouds"). Checked at play zoom with the fog's noise pinned at its thinnest: the walls' ends stay
inside solid fog. `shoalMix` returns 0 and `waterHeightAt` is `WATER_Y` everywhere.

What follows is the mouth **without** the fog — `?edgefog=classic` and `?city=big`, where the island
still feathers into the sky.

Two different kinds of edge have to agree here and they are not the same kind of thing. The island
**dissolves**: a horizontal alpha ramp at `y = 0` that takes the ground to sky over `EDGE_FADE`. The
river is a **cutting**: two units down, with vertical walls. A flat skirt laid across the mouth
cannot fade a cutting — the walls and the deep water are *under* it and carry straight on out the
other side. So the channel did not fade at the coast, it stopped: walls ending on one line, water
running two units past it, and a hard dark blade of river lying in a coastline that had already gone
to haze.

**The channel shoals out instead, so there is nothing left to hide.** Over the last `MOUTH_SHOAL`
units the water rises to meet the ground. The wall face that reads as depth is exactly the strip
between the kerb and the waterline, so lifting the waterline shrinks it to a kerb's worth of lip, and
by the time the rim fade has to cross the notch there is no notch. 12 units, which starts the ramp at
x = 50 — the outer edge of the built city, so the whole shoal is out over the bare rim where the
river is scenery rather than somewhere boats work. `waterHeightAt` is exported, because the boats
have to ride it or they sail into the shallows half sunk.

And it is what finally lets the **colour** agree. Three earlier attempts faded the water itself and
all three left a pale blade, because water dissolving beside asphalt measured 24 luma ahead of it the
whole way down, whether it faded from `riverWater`, from `riverDeep` or eased into the asphalt on the
way. Shoaling gives that a physical reason to stop being true: shallow water shows its bed, so the
strip eases into the ground's own colour as it shallows and arrives at the coast matching the skirt
beside it. Measured after: 76 against the ground's 82.

Three holes had to be closed with it, and all three are the same mistake — a gap that is invisible
over the city, because what shows through it is dark ground, and is a bright speck at the mouth,
because what shows through it there is sky.

| | |
|---|---|
| The water stopped two units past the coast | so the mouth skirt spent the rest of its fade dissolving over **nothing**. Measured at the tip: luma 211 against 82 for the ground. The strip runs the full fade band now and dissolves on the skirt's own curve — which is only safe because by then it is the skirt's own colour. |
| The embankment railing had no end posts | `RAIL_POST_PITCH` is a *world* pitch, so a run ended with two rails hanging in mid-air and the corner where it met a bridge's railing left open. |
| The abutments stopped at the bank | leaving the embankment strip under each deck — a walk's width, roofed by the deck, open from the side — as a void. They reach `DECK_OVERHANG` further now, to where the channel wall stands. |

> **The shoal has to land on exactly `y = 0`, and 0.08 under it is worse than flush.** The
> coplanar-surfaces rule does not apply: two flat surfaces at one height shimmer when they
> *overlap*, and the water and the mouth skirt do not — the skirt covers the embankment strip either
> side and the water covers what is between them, edge to edge, sharing vertices. Set under, to be
> safe, and the step itself becomes the artefact: an 8cm riser seen from a camera that looks along it
> draws a hairline of open sky down the whole length of the mouth.

## Looking at it

`?shot=14` frames the river, `?shot=15` the leaf half way up with the tug holding station,
`?shot=16` the leaf fully up with the tug going through, `?shot=17` the coast at the mouth, and
`?shot=41` the trash barge and its gulls, close.
That last one is deliberately much tighter than play zoom: every failure at the mouth has been a
bright speck of sky a few pixels across, which a wide framing cannot resolve at all — the way to
check it is to count pixels brighter than the ground, not to look. All three step the **real** state machine
rather than posing it, so a screenshot cannot drift out of step with what the player gets — and the
boats are placed before the cycle is stepped, not after, or the tug turns up parked short of a
bridge that opened for nobody.

Two things that staging got wrong and are worth not getting wrong again. The **traffic has to be
stepped too**: `clearing` holds until the deck is empty, and a car left standing there by the warm-up
never drives off unless the sim runs, so a loop that ticked only the bridge photographed a span with
its lamps flashing and its leaf still flat — a real state, and not the one being framed. And
`drawbridgeAt` is seconds into the cycle, so it tracks `BARRIER_SECONDS` and `LIFT_SECONDS` and has
to be re-derived whenever they move; the 3.0 and 9.5 that framed the old cycle both landed on the
wrong phase once it was slowed.

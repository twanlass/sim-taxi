# The city

> The grid described here is still what the shipped city is built from, but it is no longer the
> only shape a city can be. `roadnet.js` generalises all of it — see [roadnet.md](roadnet.md) —
> and reproduces this layout exactly, which is asserted rather than assumed.

Everything geometric derives from `src/city/grid.js`. Nothing else is allowed to invent a road
width or a lane offset — the layout stays consistent by construction rather than by three files
happening to agree on the same magic number.

## Coordinates

```js
GRID_I = 5    // block columns → i runs 0..5
GRID_J = 6    // block rows    → j runs 0..6, and 6 × 7 = 42 intersections
PITCH = 20    // distance between road centrelines
ROAD_W = 8    // full road width (two lanes)
BLOCK = 12    // PITCH - ROAD_W, the buildable footprint between two ordinary streets
LANE  = 2     // lane centre offset from the centreline
SPAN_X = 100  // GRID_I * PITCH
SPAN_Z = 120  // GRID_J * PITCH

ARTERIAL_ROAD_W = 10.667   // ROAD_W × 4/3 — a main street is divided, see below
LANE_TO_KERB    = 2        // lane centre to its own kerb, the same on every road
MEDIAN_W        = 2.4      // the planted island between an arterial's carriageways
```

Intersections are indexed `(i, j)` from `0..GRID_I` and `0..GRID_J`, and `lineX(i)` / `lineZ(j)`
convert an index to a world coordinate. The city is centred on the origin **on both axes**, which is
why those are two functions rather than one: the half-spans no longer agree, so `x` and `z` are
genuinely different arithmetic and a single `lineCoord` would silently answer for the wrong one.

**The two counts are named after the index rather than the axis**, and that is not a coin flip.
Every other name in this file already means "runs along X" — `arterialX` is a set of `j` values and
`halfRoadX(j)` is a road's extent in z — so a `GRID_X` would have read as the opposite of what it is.

About five blocks a side is a gameplay constant, not an aesthetic one: the whole city has to fit on
screen at once, because that is what allows a fixed camera and unambiguous tap-to-select. (This is
the main change from `city-lab`, which used a 10×10 grid with a pannable camera.)

The sixth row is the one asymmetry, and it is **water** — see [river.md](river.md). Land is still 25
blocks, exactly what a 5×5 city had; the extra row is what stops the river costing the map a street
or a landmark.

## Direction encoding

Directions are `0..3` meaning `+X, +Z, -X, -Z`. The ordering is chosen so that:

```js
rightOf(d)   = (d + 1) % 4
leftOf(d)    = (d + 3) % 4
opposite(d)  = (d + 2) % 4
isXAxis(d)   = d === 0 || d === 2
dirSign(d)   = (d === 0 || d === 1) ? 1 : -1
```

Every turn lookup table this would otherwise need disappears. If you add a direction-dependent
behaviour, express it in this arithmetic rather than a `switch`.

`laneOffsetCoord` places a car on the right-hand side of its travel direction (right-hand
traffic), and `entryPoint` / `exitPoint` / `turnControl` give the three points of the quadratic
Bézier a car follows through a junction.

## Legal moves

`legalExits(dIn, i, j)` is the single authority on where a car may go. It enforces three things:

- **no U-turns** — which is why routing has to plan over *directed* states; see
  [gameplay.md](gameplay.md#routing)
- **the map edge** — you cannot leave the grid
- **closed segments** — a road inside a park district genuinely does not exist

Because it is the only source of truth, closing a road automatically affects ambient traffic,
route planning, and the connectivity assertions in the probe, with no extra plumbing.

## Divided arterials, and the planted median

An arterial is **a third wider** than an ordinary street — 10.67 kerb to kerb against 8 — and every
bit of the extra width goes into the middle. The two carriageways sit exactly where they would on an
8-unit street *relative to their own kerb*, and what opens up between them is a 2.67-unit centre
strip with nothing driving on it.

**Measuring from the kerb rather than from the centreline is what makes this cheap.** Every tuned
number in the sim that involves the edge of the road is a distance from the lane centre outward —
the pull-over that rides a car up onto the kerb at 1.15, the 2 units of weave room, the façade line
a panicking car must not reach — and all of them survive untouched. `LANE_TO_KERB` is the invariant,
and `tools/roadnet.mjs` asserts it on every edge in the network. What did have to move are the
numbers measured *across* the middle: the overtake
([traffic.md](traffic.md#on-a-divided-arterial-it-is-a-wider-swing)) and the police dodge.

It also gives the map a hierarchy you can read at a glance from a fixed camera, which is what the
arterials were always for and which a 64% green share alone could never show.

Four functions in `grid.js` carry it, all keyed on the line index:

| | |
|---|---|
| `halfRoadX(j)` / `halfRoadZ(i)` | how wide that road is |
| `laneOffX(j)` / `laneOffZ(i)` | how far its lanes sit off the centreline |
| `junctionReach(d, i, j)` | how far the junction box reaches along d — the **crossing** road's half-width, not this road's |
| `medianRuns()` | every stretch of planted island in the city |

`junctionReach` is the one with a trap in it. Where nothing crosses — a park closure can leave a
junction with only the road you are on — the box is this road's own half-width, because there is no
carriageway to clear. That case used to be invisible: with every street 8 wide the two answers were
the same number. `roadnet.js` reaches the identical conclusion from the arms it can see, which is
what keeps the two models equal at 1e-9 instead of adding a third documented difference to
[roadnet.md](roadnet.md#two-differences-on-purpose).

### The island

`medianRuns()` returns one run per gap between junctions, skipping any road a park district built
over, stopping `MEDIAN_END_GAP` (1.8) short of each junction box — that is where the turns cross,
and where the double-line paint takes over from the island. A run comes out 8.4 units long between
two ordinary streets and 7.07 where the two arterials cross each other.

It lives in `grid.js` rather than in `ground.js` because two systems have to agree on it exactly:
`ground.js` lays the kerb and the grass, and `props.js` plants the trees standing on it.

`MEDIAN_W` is sized off what has to stay clear, not off the 2.67 the widening opens up. A car in its
lane has its inner flank at `laneOff − CAR_W/2` = 2.48 from the centreline, so 2.4 of island leaves
1.28 of asphalt shoulder either side — enough that the strip reads as an island *in* a road rather
than as two roads with a gap. Widen it and the police dodge has to come down with it; the probe
asserts that nothing but a passing taxi is ever over one.

The ends are **stadium caps**, not square corners. At 2.4 across and eight long, a square-ended
planter reads as a kerbstone dropped in the road.

### Flowers, not trees

Trees were the first thing planted there and the camera is why they are not there now. It looks
down at 33°, so anything of height h hides the ground within `1.54h` behind it — and what sits
behind a median is the far carriageway of the road the player is most likely to be driving down.
That lane centre is 3.33 across, which is 4.71 along the view diagonal; even a stunted 2.9-unit
tree with a 0.9 crown reaches about 5.7, so it passed in front of cars over there for roughly half
of every block. Shortening it further just made it a shrub on a stick.

A flower bed tops out **0.54 above the island**, 0.89 above the road, which casts 1.4 of occlusion
against the 4.71 it would have to reach to touch the far lane. The question stops being "how often
does this hide a car" and simply goes away. It also suits the strip better: a median is a planter,
not a verge, and bedding is what a city puts in one.

**A single flower is not a thing this game can draw.** At play zoom 1 world unit is 7.7px, so even
a scaled-up bloom is three or four pixels and a stem is nothing at all. What has to read is the
*bed* — a 1.1–1.6 unit patch of colour against the island's grass — so `flowerBedParts` spends its
geometry on a foliage mound wide enough to see and packs blooms over it, rather than on stems
nobody resolves. Twenty to thirty of them per bed, which at radius 0.16 comes to **twice the
mound's own plan area**: they pile over each other and the green survives only where the mound
shows past them.

It took three passes to get there and the direction was the same each time. The first was two beds
an island of 7–11 blooms at radius 0.10, and at play zoom that is a shrub with dots on it. Density
and size are what this reads by; the mound is only the thing holding them up.

Four to six beds an island, spaced rather than scattered, for the same reason the park benches are
([above](#benches-and-one-statue)) — but at a 1.0 pitch against beds 1.1–1.6 across, so every one
of them overlaps its neighbours. That is the point. The "bed" stops being a discrete object and the
island reads as planted end to end, which is what a central reservation looks like; overlapping
mounds get it with no second kind of geometry, and the wasted interior faces are a one-off merge
cost rather than a per-frame one.

A bloom is an **octahedron**, not the icosahedron the mound uses: 8 triangles against 20, and at
three pixels the two are indistinguishable. The city carries ~1,300 of them, so the choice is most
of the props mesh — measured at this density, 118ms and 16.4k triangles against 166ms and 31.8k.

`planMedianBeds` is split out and exported the way `planParkFurniture` is: placement is the part
with a rule in it, and the rule — no bed may overhang its island's kerb into the carriageway — is
invisible once the props are merged into one mesh. The probe sweeps it over seeds, because the bed
that would escape is specifically the widest one on the narrowest island.

**Two different things can be a bed's outermost point, and which one wins changes with its size.**
The mound reaches `radius · 1.14` once `jitterVertices` has thrown its corners about; the rim
blooms reach `0.82 · radius + BLOOM_R`. The mound is wider on a big bed and the blooms are wider on
a small one — scaling the flowers up put them 0.016 past it at the bottom of the size range — so a
footprint taken from the mound alone lets a small bed's flowers hang over the kerb, which is the
exact thing the bound exists to prevent. `footprint` is the max of the two.

### The bloom palette is the free space on the wheel

Blooms are drawn per *flower*, not per bed, so one bed carries four or five colours. A bed used to
be one species, which is the tidier thing for a city to plant and the duller thing to look at: at
this size the whole payload of a flower bed is that it is many colours at once, and a monochrome
one is a coloured lump.

Which colours is not a taste question here. Measured where `getHSL` measures, the urgency ramp runs
1° → 126°, the taxi sits at 34°, the route yellow at 46°, the courier cyan at 192° and the VIP
purple at 260°. Requiring 20° of clearance either side leaves exactly four windows — 71–106°,
146–172°, 212–240° and 280–341° — and the first two are unusable for a different reason: they are
greens, and a green flower on a green mound on green grass is a flower nobody sees.

So the planting lives in the other two: blue at 223–230°, then violet, magenta and pink from 287°
round to 331°. Nearest approach to anything the player acts on is **27°**, and the loudest bloom is
0.66 saturated against the 0.86–1.00 of every marker on the board. `tools/probe.mjs` asserts both,
the same way it asserts the roadworks orange. That the range comes out cool and slightly wild is a
consequence of the constraint rather than a choice, and it happens to suit municipal bedding.

## Layout: what a block *is*

`layout.js` decides each block's identity before anything is built, so ground, buildings and props
all read one decision rather than each rolling their own dice and disagreeing.

**Density falls off from the centre.** That's what produces a downtown instead of a uniform mat of
identical towers, and it makes parks more likely out in the cheap suburbs.

**Arterials.** One road per axis is marked as an arterial and handed to `configureSignals()`. They
take a larger green share, which gives the map a fast/slow grain worth learning, and they are
[wider](#divided-arterials-and-the-planted-median). See [traffic.md](traffic.md#arterials).

They are decided **first**, before anything else in `createLayout`, because a wide road takes its
extra width out of the blocks either side of it and `blockBounds` cannot answer until
`setArterialLines` has been told.

## The depot block

`city/garage.js`. One block per city is `type: 'garage'` instead of `'built'`, which takes it out
of the tower generator's hands (`createBuildings` only walks `'built'` blocks) and leaves it for the
taxi's own depot: a single-storey shed at the back of the block with a roller door on the street, a
3-unit asphalt forecourt, and a dropped kerb the taxi comes off in
[the opening vignette](gameplay.md#the-opening-vignette).

**A whole block, not a lot.** The depot needs a forecourt to pull out of, and the generated city
only leaves 0.85 units of pavement between a façade and the kerb — a car pulling out of a door that
close is over the lip before it has straightened up. Reserving a footprint *inside* a block also
does not work, because `splitLot` divides the block afterwards and will happily put a tower on the
sliver left over.

**Chosen at the end of `createLayout`**, after every other draw in that function. That is what makes
it free: nothing in layout.js reads `rng` after it, and every generator downstream runs its own
offset stream — so adding the depot moved no park, no arterial and no building. `blocks.garageBlock`
is the answer, and it may be **null**: a city with nowhere to put one opens without the vignette
rather than not opening.

### The site filter is a sightline

The three constraints on which block it lands on are all about being *seen*. Two are obvious — the
block must be built rather than park, and the road its door faces must exist (a park district closes
the road between its two blocks). The third is the interesting one.

The door always faces **+X**. The camera never rotates, so only two of a building's four faces are
ever visible, and of those two, +X is the one whose sightline to the camera leaves the block over
the *road*. The door also sits near the block's **−Z** end, and that is what buys it: the line to
the camera gains a unit of z for every unit of x, so a door 4.5 units from the −Z edge crosses the
block's far edge after 7.5 units of x — inside the 8-unit road. The block straight across the street
can therefore never occlude it.

What can is the **diagonal** block, and only if it is tall: the line reaches that block's façade
16.35 units out, by which point it is 15.4 units up, against `buildTower`'s 16-unit ceiling. So the
filter is a height one, and height here comes from centrality — `5 + centrality * 11` clears the
line whenever centrality is under 0.945, and `occlusionClear` demands 0.75.

That is the arithmetic; `tools/probe.mjs` does not trust it. It fires nine real rays through the
real merged city, across ten seeds, and asserts every one of them reaches the camera. Getting this
wrong is a run that opens with a two-second close-up of a wall.

## The burger joint, and its drive-through

`city/burgerjoint.js` for the building and the lane, `game/drivethru.js` for the cars that use it.

One block per city is `type: 'burger'`, which — exactly like the depot above it — takes it out of
the tower generator's hands and leaves it for a single-storey roadside restaurant: a pale box under
a coloured mansard band, a lot of asphalt, a drive-through lane down its street side with an
illuminated menu board and a pickup window under a canopy, and **a burger turning on a pole above
the roof**.

It is a whole block for the depot's reasons, drawn at the very end of `createLayout` for the depot's
reasons, and `blocks.burgerBlock` may be **null** for the depot's reasons. What is different is
everything about the lane.

### Why the lot faces the way it does

None of the orientation is a free choice, and each constraint removes one degree of freedom.

The camera never rotates, so only the **+X and +Z** faces of a building are ever visible — and only
the +X and +Z *strips* of a block are ever in front of the building rather than behind it. A
drive-through nobody can see may as well not run. So the building sits against the block's −X−Z
corner, the lane runs down the +X strip in front of it, and both openings are on the +X face
pointing straight at the camera.

The **direction** the lane runs is fixed by the same right-hand traffic that decides which side of
the road a car drives on. The driver sits on the left; a drive-through window is on the driver's
side; the left-hand side of a car running −Z is the west, which is where the building is. Run it +Z
instead — which reads just as well on paper and puts every car nose-on to the camera — and every
driver is served through their passenger's window.

That fixes both ends of the lane, because a car may only leave a road by turning **right** off the
kerbside lane and may only join one by turning **right** into it. (A left turn across oncoming
traffic is a yielding problem, and the lane has no business inventing one.) Of the four roads round
a block that leaves exactly one pair:

| | road | what the car does |
|---|---|---|
| **in** | the +Z edge, kerbside lane runs −X | right turn into −Z, onto the lane |
| **out** | the +X edge, kerbside lane runs +Z | right off the lane onto a short +X run over the near kerb, then right again onto the road |

That one-way-in is a fact the *router* has to know as well, now that the player can send the taxi in
here: `site.approach` names the mouth's lane — direction and the junction it runs to — because a
route planned to a junction arrives from whichever of four sides is cheapest, and three of them
drive past the driveway. See [the burger run](gameplay.md#the-burger-run).

All three quarter turns share one radius, and it is not chosen either: each is tangent to a lane
centre at one end and to a kerbside lane at the other, so the radius is the gap between a kerb and
the lane nearest it — `LANE_TO_KERB`, which is 2 on an arterial and on a side street alike. It is
also the radius every right turn in the city already uses, so a car pulling into the lot corners
like a car pulling round a junction.

### Why the exit takes two turns instead of one

The obvious exit runs the lane down to the −Z kerb and turns right onto *that* road, which is one
quarter turn rather than two and reads fine until it is measured. That exit lands on the −Z road
**0.7 units short of the junction** at the block's own corner — inside its own stop line, so a car
released there is past the hold line before it can see the light. It runs the red, and since
`sim/collisions.js` only ever tests the taxi, it does not crash into the cross traffic. It drives
*through* it.

Going out through the +X kerb instead puts the merge on the road running along Z, where the distance
back to the junction is the whole depth of the block less `EXIT_LIFT` — eight units on the narrowest
block there is, against a `STOP_SETBACK` of 3.4. The joint keeps the −Z end of its block for the
building, and `tools/probe.mjs` asserts the clearance rather than trusting it.

### Three flat surfaces, at three different heights

The lot stacks the block's own pavement, the joint's asphalt apron, and the paint on that apron —
and each has to sit at a *different* height from the one under it. Coplanar is not "just touching":
it is two polygons the depth buffer cannot separate, and it ships as the ground shimmering when the
camera moves. The first cut of the apron put its top face at `KERB_H + 0.01`, which is exactly where
`createGround` lays the pavement, and the lot flickered.

So the three are named constants measured off each other (`PAVEMENT_Y`, `APRON_Y`, `PAINT_Y`) rather
than a set of nudged literals, `game/drivethru.js` takes the height its cars ride at from `APRON_Y`
instead of recomputing it, and `tools/probe.mjs` gathers every up-facing triangle either mesh puts
on the block and asserts no two of them land within 5mm of each other.

Vertical faces are exempt and so are down-facing ones: a wall cannot fight a floor, and a
down-facing surface is culled before it can fight anything — which is why the awning sitting exactly
on top of the door is fine.

### The neon on the roofline

A tube of it traces the roof, tucked under the parapet cap on the mansard band's own face. It is
part of the same unlit mesh as the pickup window and the menu panel, because it is the same kind of
thing: a light. That is what makes it read as neon rather than as a painted stripe — it holds full
brightness on whichever flank the sun has left, where the fascia around it has gone to shadow — and
it is why the joint stays lit in one colour after dark.

Three of its numbers are settled rather than picked.

**Under the cap, not on it.** Both read as "the roof line", and this camera is 33° above the
horizon: a vertical face projects at cos 33° = 0.84 of its height where a horizontal one projects at
sin 33° = 0.54, so the same tube laid flat along the parapet is two thirds the line it is standing
on the fascia. The cap oversails the band by 0.1 and the tube spends 0.08 of that — enough to stand
off the wall under the drip edge, with 0.02 left so its outer face is not *coplanar* with the cap's,
which is a z-fight rather than a flush detail. `tools/probe.mjs` measures that clearance off the cap
the shell actually drew and holds it to the same 5mm the coplanar check above uses.

**0.2 tall**, which is about a pixel and a half at play zoom, and that thinness is the budget rather
than a compromise: the band under it is a whole unit, and a tube eating a third of that stops being
a line on a red band and starts being a two-tone band. Being unlit is what buys the read back.

**Two arms, not four**, mitred round the one corner that faces the camera. The other two are not
merely facing away — they are *behind the cap*: a sightline off a tube on the −X face climbs 0.92
per unit of x and meets the cap's underside 0.17 of a unit in, well inside the 0.3 it oversails by.

The mitre is the fiddly part, and it is fiddly for a reason worth repeating: two boxes butted
end-on at an outside corner share a coplanar pair of faces and one of that pair is front-facing,
which puts an eighth of a unit of z-fight on the corner the camera is aimed at. So one arm carries
the corner rather than both meeting in it — the +X arm runs the full depth of its face and on past
the +Z arm to the outside corner, and the +Z arm stops on that arm's *inner* face, where its end cap
is a culled face with solid tube in front of it. Both arms run out to the band's own far corners,
where their end caps face away and are culled, so what the tube does at the two corners it cannot be
seen turning is carry on.

### The site filter is a sightline, along a whole lane

The depot's filter asks whether the camera can see one door. This one asks the same question of
every point on the lane, and it has to, because **the answer is routinely no**: every block in this
city is eight units of road from the next, so a sightline leaving the ground has climbed only 7.4
units by the time it reaches the far façade, and a downtown tower goes to 16. That is the same
arithmetic [game/sightline.js](../src/game/sightline.js) records about courier pads, and the reason
two junctions in a typical city cannot hold one.

`laneSeen` samples nine points along the lane and marches each one's sightline through the blocks
it crosses. The march is the cheap kind — the ray climbs monotonically, so the lowest it ever is
inside a block's footprint is where it *enters*, and one height comparison per block settles it.
Heights are predicted rather than measured, because the block has to be chosen before anything
stands on it: `5 + centrality * 11` for a built block (`buildTower`'s own ceiling) and 6 for a park's
tallest tree. Twenty-five blocks by nine samples, once per city.

There is a second preference on top of it. The joint avoids the top of the density curve, and it
earns that twice: a drive-through is a roadside building and downtown is where it least belongs, and
the block is one the tower generator no longer gets — so taking a *downtown* one costs the skyline
its tallest deck. That is measured rather than assumed. The helicopter's pad is chosen from every
flat deck in the city, and its low tail moved 5.79 → 5.14 over 192 cities when this module started
taking a block at all; `tools/probe.mjs` carries the numbers next to the check that watches it.

### The sign, and why it is not in the entrance wave

The burger is five slices and a scatter of seeds, every one of them a cylinder or a box, which under
`flatShading` at twelve radial segments is what makes it read as a *toy* burger rather than a small
photograph of lunch. The cheese is the only piece that is not round: a square turned 45°, so its
corners come out past the patty and its flats tuck inside, which is the one detail that says
*cheeseburger* rather than *bap*. Every thickness in it is a fraction of `BURGER_R`, so that one
constant is the sign's whole size — it went 0.95 → 1.9 in one edit, from a warm dot at play zoom to
**five units across, about forty pixels**, which is a car and a half.

Three things about it are consequences of **this camera looking down at 33°**, and all three were
settled by a screenshot rather than on paper.

It mostly sees the *top* of anything on a pole, and the top of a burger is a bun, which identifies
nothing — so the stack is bottom-heavy and each filling is wider than the piece under it, leaving a
ring of cheese and lettuce showing all the way round. A first pass with a taller crown and narrower
fillings photographed as a tan blob with a green edge.

For the same reason the sign **leans away from the viewer**, which reads backwards and is not: at
33° of elevation the angle between a level burger's top face and the line to the eye is already 57°,
so tilting the top *toward* the camera closes that angle and shows more bun. Leaning it away opens
it to 79°, turns the stack side-on, and puts the patty, the cheese and the lettuce square in front
of the lens. 22° is where that stops helping — at 15° the dome takes the frame back, and much past
22° the underside of the bottom bun becomes a third of the silhouette in shade.

The lean rides on a **pivot**, with the mesh turning inside it. `rotation.y` on a tilted mesh turns
it about the *world* vertical, which sweeps the burger round a cone; turning it about the pivot's
own tilted axis holds one three-quarter attitude all the way round.

And it **turns at all**, which is why it is an object of its own rather than part of the merged
shell. The
city's entrance animation ([cityentry.js](../src/game/cityentry.js)) grows every building in a vertex
shader, scaling each vertex about a ground anchor **stamped into the geometry in world
coordinates** — and a world coordinate in a rotating object's local space is not a coordinate at
all. So `createCityEntry` grew an `objects` list: a handful of transforms scaled on the CPU, on the
same easeOutBack over the same delay, so the sign comes up with the building under it instead of
hanging in the air over a hole in the ground.

## Park districts close roads

A park district is **two adjacent blocks plus the road that used to separate them**, merged into
one solid green mass.

The first version left the road in place, which produced two parks either side of a street — still
the same repeating grid, just greener. Closing the segment is what actually breaks the rhythm.

The closure is real, not cosmetic. `setClosedSegments()` removes the segment from `legalExits`, so
traffic routes around it and the router plans around it for free.

**Which blocks are green is registered the same way** — `setParkBlocks()` beside the closures, read
back through `isParkBlock(bi, bj)`. A park is a fact about the ground that anything placing a marker
on a kerb has to be able to ask about without holding the layout array: the courier board is the
caller, and it keeps both ends of a package off the grass
([gameplay.md](gameplay.md#the-package-courier)). Registered as blocks rather than as junctions,
because a junction has four corners and a marker only ever uses one of them — which one is
`cornerFor`'s business, in `game/fares.js`.

### A park has a frontage

A park is a block on a street, so it presents the same pavement to the street that a built block
does: `ground.js` lays a **1.0-unit walk** around the inside of the kerb and cuts the lawn out of
it (one `ShapeGeometry` with a hole, rather than grass laid over paving — two coplanar opaque
surfaces cost the overlap twice). Without it, a park was the one block in the city with no frontage
at all: the 0.15 of kerb a block's platform leaves showing is about a pixel at play zoom, so against
grass the edge vanished and the green read as a rug dropped on the asphalt.

`PARK_EDGE` — the kerb plus that walk — is where the green starts, and it is **exported because two
other systems stand things on the grass**: `props.js` plants trunks clear of it and `birds.js` keeps
the flock off the paving. Both derived their margin from the bare 0.15 before the walk existed, so
both would have been left standing on it. The probe measures the inset off the mesh rather than
trusting the constant, and checks the winding of the ring while it is there — a hole is triangulated
by earcut, not laid out in rows.

### Benches, and one statue

The walk is also what the benches are placed against — **on the lawn, a step inside the paving**
rather than on it. A bench on the walk's centreline is where a bench in the street goes, but a
park's walk is a thing you go *round* the park on, and furniture parked in the middle of it reads
as an obstacle rather than as somewhere to sit. `planParkFurniture()` in `props.js` spreads slots
evenly along each side of a plot — random points on a 32-unit district side put two benches back to
back about as often as they put them anywhere useful, and a park is the one place in this city where
evenly spaced furniture is more truthful than scattered furniture — then takes about half of them,
which comes out at two or three round a pocket park and five or six round a district. Every bench
faces **into** the park.

**Exactly one statue in a city**, the same shape of decision as the courtyard block and the helipad
and taken for the same reason: rolled per park it came out two or three times on most seeds, and the
third statue in a five-block city is a municipal habit rather than a landmark. It prefers a district,
because a district's centre is *the road that used to run between its two blocks* — the one spot in a
park that was never anything else. It brings its own square of paving with it (`city/ground.js` is
built before anything has decided where the statue goes, so a plaza planned in one file and drawn in
another would be two things to keep in step), and the trees are planted afterwards and keep out of
its clearing.

The figure is hand-built from boxes rather than taken from `geometry/person.js`: that one is a rig,
a Group of separately-pivoting limbs with materials of their own, and what a merged props mesh needs
is geometry that never moves again.

The placement rules are swept over seeds in `tools/probe.mjs` rather than looked at on one — a bench
half on the grass and a city with three statues in it are both perfectly plausible on the seed you
happen to be looking at.

The districts and the lone pocket parks are also the only thing in the city with any wildlife in it:
`game/birds.js` reads the same bounds `city/props.js` plants trees inside, and puts a flock down on
one of them. **Two flocks, in two different parks** — every seed produces between two and five green
areas big enough to hold one, and one flock left the other four empty. See
[rendering.md](rendering.md#the-park-flock--gamebirdsjs-geometrybirdjs).

This is the one generation step that can silently break the game, so the probe asserts two things:
no vehicle is ever inside a park's bounds, **and** all 5,184 `(approach, destination)` pairs remain
routable. Closing the wrong pair of roads could strand a corner of the city with no error at all.

Now that the city seed is random each load ([architecture.md](architecture.md#seeding)),
`main.js` runs `isCityConnected()` (grid.js) after every `createLayout` and rerolls the seed if
the directed state graph isn't strongly connected. Two BFS passes on 144 nodes — cheap, and it
never gets to spend time meshing a broken city.

> A known limitation: districts are pairs of blocks only. Larger ones would close more roads and
> need a connectivity guarantee stronger than the current all-pairs check.

### A duck pond

**Exactly one a city, and never in the statue's park.** Those are the two things a municipality puts
in the middle of a green, and standing them in the same one leaves every other park with nothing —
the same argument that keeps the two flocks off one lawn. `planPond` (`city/pond.js`) takes a plot
the statue did not, and it is a plain draw rather than the statue's preference for a district: a
statue wants the one spot in a park that was never anything else, and a pond wants nothing in
particular.

It is a **shore ring with the water as a hole in it**, both cut from one list of rim points so the
two can't disagree, and the outline is a circle bent by two low-frequency lobes rather than jittered
per point — 20 independent radii make a star, and smoothing them costs more code than not making the
mistake. What that buys is a guarantee rather than a look: the outline never comes in by more than
the lobes' own amplitudes, so `pond.water` is a radius the water certainly covers and `game/ducks.js`
can bound its birds by a number instead of re-evaluating the shape. See
[rendering.md](rendering.md#the-duck-pond--citypondjs-gameducksjs) for the water itself.

**The size floor is the birds, not the water.** A duck is drawn at the flock's own 1.3 units (the
same deliberate lie every animal in this game is drawn at) and loses a third of that to the
waterline, so a pond has to be several of them across before it stops being a puddle with three
birds jammed into it. 2.9 of radius is the floor; the setback that holds it inside the lawn is
`PARK_EDGE + 1.15`, which clears the bench band with a quarter-unit to spare and — the reason it is
not more — is what lets a block with an arterial down one side still hold one. At the wider setback
a quarter of all cities had nowhere to put a pond.

Three things then have to keep out of the water, and they are handled in three different places
because they arrive at three different times. The **benches** are the setback above, decided before
either exists. The **trees** are a rejection in `createProps`, at the pond's radius plus a crown's
own reach — a tree leaning over a bench is shade, and a tree leaning over a pond is a tree growing
out of it. And the **flock** is handed the pond as a keep-out circle, which is not the same job as
the other two: a bird has a *path*, and a target pushed to the far shore is a perfectly dry
destination with a pond in the way of it. `stopAtShore` clips the walk at the water's edge instead.

## Ground, buildings, props

| File | Produces | Notes |
|---|---|---|
| `ground.js` | asphalt slab, road surface, kerbs (`KERB_H = 0.35`), block tops — a park's is a walk around a lawn, [above](#a-park-has-a-frontage) — crosswalks | One merged mesh, plus the edge fade as a child — alpha can't ride in the merge's 3-component colour. Crosswalks are omitted at unsignalised junctions — a crosswalk implies a signal. |
| `buildings.js` | towers, courtyard blocks, façades, roof furniture | One merged mesh. Height ceiling is deliberately low; tall towers hid the taxi. See [what a building is made of](#what-a-building-is-made-of). |
| `props.js` | trees, park benches, the statue | Merged per material via `bakeColor`, so hundreds of props cost one draw call. Placement is [above](#benches-and-one-statue). |

### What a building is made of

A lot is subdivided (`splitLot`), and each parcel gets either a **tower** or, rarely, a
**courtyard block**. Both are built from the same four pieces.

**Massing.** Up to three setback tiers, each shrunk 62–82% off the one below with a ledge where it
steps in. Height comes from the block's centrality, capped low on purpose — see the note above.

**Façades.** Two treatments, and which one a building gets is decided by its envelope colour
rather than by a roll: `glass` and `slate` get a **curtain wall** (one continuous ribbon per
floor), everything masonry gets **punched openings** (a window per bay per floor). A glass tower
with holes cut in it and a brick walk-up glazed floor to ceiling are both wrong, and tying the two
together means the city never builds either.

Every face that sits on the **block edge** — i.e. that meets a street — also gets a glazed
shopfront at pavement level, and one of them gets a door with a light surround and, half the time,
a canopy over it. Interior lot lines get none of that: the difference between a building with a
front and one glazed on all four sides is most of what makes a row of them read as a street.

Glass carries a faux reflection: a vertex-colour gradient from `window` toward `windowSky`, with a
diagonal streak across each façade taken from a noise field over the city. It costs no geometry and
no rng — see [rendering.md](rendering.md#faux-window-reflections--citybuildingsjs).

Openings are hand-wound quads batched one geometry per face, not `PlaneGeometry` each. A mid-rise
carries forty windows and the city carries a few thousand; emitted individually they cost more to
merge than the whole rest of the city. Hand-wound means `tools/probe.mjs` asserts the **sign of the
face normal computed from the winding** — see the roadworks ramp in [CLAUDE.md](../CLAUDE.md).

**Roofs.** Flat by default: a cornice cut from the building's own colour darkened rather than from
a shared grey (a flat grey cap on everything drained the tan/brick/concrete families of any way to
tell each other apart at play zoom), then a plant room, up to two AC units, and — one roof in
eight, mid-rise only — a **water tower**: tank, hoop, conical cap and four legs.

Two exceptions to the flat deck, which together are most of what gives the map a suburb-to-downtown
gradient:

| | Where | Rate |
|---|---|---|
| **Pitched roof** — a hip (four-sided pyramid) or a gable (triangular prism, ridge along the long axis), in slate or clay tile | Low masonry buildings only: single-tier, ≤ 8 units tall. A pitch on a ten-storey tower is a folly and on a curtain wall a contradiction | ~14 a city, about a quarter of all buildings |
| **Helipad** — a dark circle with an `H` in the street's own `laneMark` paint | Tall towers with a clear deck. It claims the whole roof: no plant room, no water tower, no mast | 2 cities in 5 get one |

Both roof shapes come out of Three's own generators — a hip is `ConeGeometry` with four radial
segments, a gable is `CylinderGeometry` with three, rotated onto its side — rather than being hand
built. That is deliberate: a roof is nothing but sloped faces, which is exactly the shape the
roadworks ramp shipped inside out, and a generated geometry cannot be wound backwards. Rotation
and positive non-uniform scale both preserve handedness, so neither step can undo it.

The winding is still asserted, on the shape itself rather than on the merged city — courtyard trees
ride in the same mesh and half of every canopy points downward, so a whole-mesh sweep reported 8,847
downward faces on a city whose roofs were all correct.

> **Nothing on a roof may reach `SKYLINE_CEILING` (20.5).** The ambient aeroplane's belly is at
> 24.9 on the low side of its jitter and the probe asserts four units of clearance under it. The
> water tower and the mast are built *conditional on fitting*, and the probe checks the tallest
> thing across 24 seeds rather than trusting the one city the flyover check happens to fly over.

### The helipad

**Exactly one a city, and it is chosen after every roof is built** — the same shape as the courtyard
below, and for the same reason: "exactly one" cannot be decided lot by lot. It used to be a coin
flip on any deck over 8.5 units with 16 square units of roof, which gave a pad to 23 cities in 60
and none at all to the other 37. That was fine while it was scenery. It stopped being fine when a
[helicopter started landing on it](rendering.md#the-rooftop-helicopter--gamechopperjs-geometryhelicopterjs),
because a city with no pad is a city with no vignette.

So `roofKit` records every flat deck it builds, and `choosePad` takes one once they all exist. The
hard requirement is **width**, not height, which reads backwards until you look at the numbers: the
tallest masses are the ones that have set back twice, so the widest deck over 8.5 units is typically
3 to 5 across and demanding 4.2 of it left two thirds of all cities with nothing to choose. Any deck
2.9 or wider can take the circle; the tall ones are preferred, and among them the roomier half is
drawn from at random so the pad is a landmark rather than a rule. Seven cities in eight put it above
8.5 units and the rest land between 6 and 8.

The winner's roof furniture is then **spliced back out** of the parts list — a plant room in the
middle of a landing circle is the one thing a deck like that cannot have, and the one unit that
stays is moved into a corner only if the corner is genuinely clear of the paint. Building that
furniture and dropping it costs one roof's worth of boxes a city, which is the price of taking the
decision after every deck exists. `createBuildings` hands back `pad` — where the paint is, how wide
the circle came out, and the deck's own dimensions, which is how the helicopter knows to line its
approach up with the long axis of the roof.

### Courtyard blocks

A hollow perimeter block — four wings round a planted yard. **Exactly one a city**, which is why
`createBuildings` walks the lots twice: "exactly one" cannot be decided lot by lot. Rolled per lot
it came out at two or three with the tail running to five, and a distinctive massing repeated five
times across a 5×5 grid stops being distinctive — it just becomes the shape a block is.

Only an *undivided* block is wide enough to hollow out and still leave wings with rooms in them, so
the candidate list is short to begin with. A city whose blocks all happened to split gets no
courtyard rather than a cramped one; over 200 seeds that has not yet happened.

It only works because of a measurement. The camera looks down `VIEW_DIR (1, 0.92, 1)`, **33° above
horizontal**, so a wing of height `h` hides everything within `1.54h` of its inner face. The first
version had 2.3–3.1-unit wings at 3.2–4.6 tall around a 4.9-unit yard: 6.9 units on the view
diagonal against 4.9–7.1 of occlusion, and the yard was never once visible — the trees read as
sitting on the roof of a lumpy box rather than standing in a hole in it.

Two things fix it, and both are ordinary things for a building to do:

- The two wings **facing the camera** (+X and +Z, which are also the two the sun lights) are built
  from a lower range than the pair behind them. A perimeter block that steps down toward its front
  is normal architecture, and the camera never rotates, so "the front" is a fixed pair of sides.
- The wings are thinner. At 2.0–2.7 the yard averaged 4.96 across over 24 seeds; at 1.6–2.1, with
  the front pair capped at 3.1 rather than 3.6, it is 5.98 — 8.5 on the view diagonal against
  4.0–4.8 of occlusion, so a couple of units of the far corner is always in shot.

#### The trees have to show a trunk

The trees come from `treeParts()` in `props.js`, the same generator the parks use, and are grown
from the tall end of its range so a crown always clears a front wing. Sizing them off the *back*
wings instead produced one ten-unit tree filling a downtown yard like a cauliflower.

Widening the yard is only half of it, though, and the other half is what the massing actually gets
judged on. Measured across 24 seeds, the version before this one had **69 of its 91 trees showing
no bare trunk at all** — 11 of the 24 cities had not one — and **71 of the 91 with a wing through
the crown**, which is what a green blob half sunk into a roof is. Three changes, all of them things
a real courtyard tree does:

| | |
|---|---|
| **A trunk stands off the yard's edge by its own crown's reach** | So no part of a canopy is inside a wall. It may hang *over* a front wing, which is what a tree does to a low wall; the back pair are 5.2 and up and would swallow it. A yard too narrow to give a tree that room grows a **smaller tree** rather than planting one into a wall. |
| **The crown rides at 0.55 of the height, not the parks' 0.42** | What a wing hides is measured from the crown's *underside*, and at 0.42 that sits at 0.37 of the height — below the 2.6–3.1 the wing in front of it is tall. The wider yard alone got the average bare trunk to 0.41 of a unit; the raised stem takes it to 0.90, which is six pixels at play zoom. |
| **One tree to a band down the yard's long axis** | What is left of the yard after the margin is ~1.5 × 2.8, and three to five crowns 3.5 across drawn independently in that are one crown with four trunks under it. |

`tools/probe.mjs` holds all of it, and holds it by **casting the rays** rather than by redoing the
arithmetic above: the sightline maths knows nothing about the tree in front of this one, so it reads
1.61 where the rays measure 0.90 and calls every hidden tree visible. 2,275 rays is 0.7s.

Wings meet edge to edge rather than crossing, and each one declares how much of each of its four
sides is actually exposed. Two sides of a short wing are buried inside the long wing beside it and
a long wing's inner face only shows across the gap between them; glazing those produced two
coplanar window grids fighting over the same depth at all four corners.

### The slab has rounded corners

The asphalt base is a `Shape` with true circular corner arcs rather than a plane, so the city reads
as an island instead of a sheet cut out with scissors.

`SLAB_RADIUS` has a hard ceiling around **27**: any larger and the arc bites into the corner where
the two outermost roads meet, leaving the ring road hanging over nothing. It is set to 22, which
leaves 2.2 units of clearance at the tightest point — the diagonal through a road corner at
`(±54, ±54)`. Change it and re-check that clearance.

That outline is also where the asphalt stops being solid: a 16-unit skirt fades outward from it into
the sky, so the island has no hard edge at all. It is added *outside* the slab precisely because of
the 2.2 units above — see [rendering.md](rendering.md#the-island-edge--citygroundjs).

All three use the same technique: generate small geometries, bake colour into vertex attributes
with `bakeColor()` from `util/geo.js`, then merge into a single non-indexed mesh with
`flatShading: true`. See [rendering.md](rendering.md).

# The city

> The grid described here is still what the shipped city is built from, but it is no longer the
> only shape a city can be. `roadnet.js` generalises all of it — see [roadnet.md](roadnet.md) —
> and reproduces this layout exactly, which is asserted rather than assumed.

Everything geometric derives from `src/city/grid.js`. Nothing else is allowed to invent a road
width or a lane offset — the layout stays consistent by construction rather than by three files
happening to agree on the same magic number.

## Coordinates

```js
GRID  = 5     // blocks per side  → 6×6 = 36 intersections
PITCH = 20    // distance between road centrelines
ROAD_W = 8    // full road width (two lanes)
BLOCK = 12    // PITCH - ROAD_W, the buildable footprint
LANE  = 2     // lane centre offset from the centreline
SPAN  = 100   // GRID * PITCH, the whole city
```

Intersections are indexed `(i, j)` from `0..GRID`, and `lineCoord(i) = i * PITCH - HALF_SPAN`
converts an index to a world coordinate. The city is centred on the origin.

Five blocks a side is a gameplay constant, not an aesthetic one: the whole city has to fit on
screen at once, because that is what allows a fixed camera and unambiguous tap-to-select. (This is
the main change from `city-lab`, which used a 10×10 grid with a pannable camera.)

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

## Layout: what a block *is*

`layout.js` decides each block's identity before anything is built, so ground, buildings and props
all read one decision rather than each rolling their own dice and disagreeing.

**Density falls off from the centre.** That's what produces a downtown instead of a uniform mat of
identical towers, and it makes parks more likely out in the cheap suburbs.

**Arterials.** Two roads per axis are marked as arterials and handed to `configureSignals()`. They
take a larger green share, which gives the map a fast/slow grain worth learning. See
[traffic.md](traffic.md#arterials).

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
- The wings are thinner. The yard is now 5.7 across — 8.1 on the diagonal against 3.9–5.5 — so a
  couple of units of the far corner is always in shot.

The trees come from `treeParts()` in `props.js`, the same generator the parks use, and are grown
from the tall end of its range so a crown always clears a front wing. Sizing them off the *back*
wings instead produced one ten-unit tree filling a downtown yard like a cauliflower.

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

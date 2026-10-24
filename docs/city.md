# The city

> The grid described here is still what the shipped city is built from, but it is no longer the
> only shape a city can be. `roadnet.js` generalises all of it — see [roadnet.md](roadnet.md) —
> and reproduces this layout exactly, which is asserted rather than assumed.

Everything geometric derives from `src/city/grid.js`. Nothing else is allowed to invent a road
width or a lane offset — the layout stays consistent by construction rather than by three files
happening to agree on the same magic number.

## Coordinates

```js
GRID_I = 5    // block columns → i runs 0..5   (6 under ?city=big)
GRID_J = 6    // block rows    → j runs 0..6, and 6 × 7 = 42 intersections   (7 big)
ROAD_W = 9    // full road width (two lanes): 8 under ?streets=classic
BLOCK = 12    // the buildable footprint between two ordinary streets, on every width
PITCH = 21    // BLOCK + ROAD_W, the distance between road centrelines (20 classic)
LANE  = 2.25  // ROAD_W / 4, lane centre offset from the centreline
SPAN_X = 105  // GRID_I * PITCH   (126 big)
SPAN_Z = 126  // GRID_J * PITCH   (147 big)

ARTERIAL_ROAD_W = 11.667   // ROAD_W + 8/3 — a main street is divided, see below
LANE_TO_KERB    = 2.25     // ROAD_W / 8, lane centre to its own kerb, the same on every road
MEDIAN_W        = 2.4      // the planted island between an arterial's carriageways
```

### Street width (`?streets=`)

Streets are 9 units across, a unit wider than the 8 they were for most of the game's life (Tyler,
2026-10-17: "I want to see if it helps gameplay feel less cramped"). `?streets=classic` puts them back to
8; headless tools take `STREETS=`. A 10-unit option, half a lane wider, was tried alongside and
judged too wide.
Two choices travel with the number:

- **The lanes widen with the road.** `LANE` is a quarter of `ROAD_W`, so the extra width lands on
  both sides of every car rather than as a stripe down the middle. The overtake, the weave room, the
  swerve's kerb jink and every turn radius grow with it.
- **The blocks keep their size and the map grows.** `BLOCK` is fixed at 12 and `PITCH` is `BLOCK +
  ROAD_W`, so the island is 5 units wider a side than on `classic`. Taking the width out
  of the blocks instead was tried first and broke 28 probe checks, nearly all for one reason: a
  lane between two junctions is `BLOCK` long, and the roadworks launch, the L train's spans, the
  pond, the helipad and the bank's sightline band were all sized against 12 of it.

The arterial's median gap stays a fixed 8/3 (`ARTERIAL_EXTRA`), so a main street is `ROAD_W + 8/3`
rather than a third wider than whatever a side street is. The New Move cards play a recording per
width (`game/*reel-<width>.js`); `STREETS=classic node tools/uturnreel.mjs --write` films one.

Intersections are indexed `(i, j)` from `0..GRID_I` and `0..GRID_J`, and `lineX(i)` / `lineZ(j)`
convert an index to a world coordinate. The city is centred on the origin **on both axes**, which is
why those are two functions rather than one: the half-spans no longer agree, so `x` and `z` are
genuinely different arithmetic and a single `lineCoord` would silently answer for the wrong one.

**The two counts are named after the index rather than the axis**, and that is not a coin flip.
Every other name in this file already means "runs along X" — `arterialX` is a set of `j` values and
`halfRoadX(j)` is a road's extent in z — so a `GRID_X` would have read as the opposite of what it is.

The size is a gameplay constant, not an aesthetic one. On a desktop the whole city fits in frame,
which is what allows a fixed camera and unambiguous tap-to-select; on a phone in portrait it cannot,
so the camera follows the taxi and the map can be dragged (`attachDragPan` in `game/camera.js`, see
[rendering.md](rendering.md#camera)). The city is 5 × 5 land blocks on an island that feathers into
the sky on every side. It grew to 6 × 6 in #483, with a 2 × 2 central park, the harbor, the north
park, the shores, the west edge's high rises and the horizon filler round it; Tyler took that back
on 2026-10-16 ("The bigger map is bugging me"), and `?city=big` (`CITY=big` headless) builds it.
Every feature that only makes sense on it — those, plus the L's turn west — is off on the 5 × 5.

The extra row is the one asymmetry, and it is **water** — see [river.md](river.md). Land is still a
square (25 blocks); the extra row is what stops the river costing the map a street or a landmark.

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
a pulled-over car must not reach — and all of them survive untouched. `LANE_TO_KERB` is the invariant,
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

### Flowers, not park trees

The *park* tree was the first thing planted there and the camera is why it is not there now. It
looks down at 33°, so anything of height h hides the ground within `1.54h` behind it — and what
sits behind a median is the far carriageway of the road the player is most likely to be driving
down. That lane centre is 3.33 across, which is 4.71 along the view diagonal; even a stunted
2.9-unit tree with a 0.9 crown reaches about 5.7, so it passed in front of cars over there for
roughly half of every block.

A flower bed tops out **0.54 above the island**, 0.89 above the road, which casts 1.4 of occlusion
against the 4.71 it would have to reach to touch the far lane. The question stops being "how often
does this hide a car" and simply goes away. It also suits the strip better: a median is a planter,
not a verge, and bedding is what a city puts in one.

### And a small tree in some of the bedding

Sixty per cent of islands carry one or two small ornamentals standing in the flowers — two on an
8.4-unit run, one on a 7.07 — planted on the island's **spine** rather than at their host bed's own
centre, because a bed may wander up to `BED_ROOM - footprint` off the middle and every unit of that
spent toward the far carriageway comes straight off the sightline budget below. They are the park's
tree (`treeParts`), on a leggier `0.5` trunk so the canopy clears the mound it grows out of, at
`MEDIAN_TREE_H` = **1.65–1.95** against the park's 3.4–5.6.

That height range is the whole feature. It is set off a measurement of the *built geometry* rather
than off `treeShape`, because two things reach further than `crownReach` reports — the crown's
extra lobes sit up to `0.5r` out with a radius of their own, and `jitterVertices` throws every
corner another `0.1r` — and together they are worth about a fifth of the clearance.

**A jitter tail has to be found by sampling the generator, not by looking at a city.** The lobe
offsets and the vertex jitter are three independent draws deep, so the furthest vertex the
generator *can* produce sits a long way out from the furthest one twelve cities happen to contain:
116 real trees reach 2.98, a thousand at the top of the range reach 3.20, twenty thousand reach
3.23. The first cut took the 12-city figure for the worst case and set the range at 2.1 — where the
tail casts **3.45** and crosses the lane, on a city nobody had generated yet. `tools/probe.mjs`
therefore checks both: the real planting over 12 cities, and a thousand trees built at the top of
the range.

What it holds to is better than the lane centre anyway. The bar the range was picked against is
ground at 3.33; the number that matters is that nothing a whole unit above the road is shaded past
**2.15**, while the far lane's near flank is **2.48** out. No part of a car above knee height is
ever behind one of these. The crown stays over the island too — 0.75 off the spine at its widest
against 1.05 of grass — so it never hangs over a passing truck.

The trees are drawn in a **second pass**, after every bed in the city has been planned. Not for
readability: a draw taken inside the bed loop would have reshuffled every bed downstream of the
first island to grow one, and this way the bedding a seed already had stayed exactly where it was.
Same argument the beds themselves are planted after the parks for.

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

### The elevated train (on by default, `?ltrain=classic` to compare)

`game/ltrain.js` stands a Chicago-style L over the city's two arterials: in off the north park
down the **north-south** one's median, a quarter turn right at the **east-west** one, and out west
along its median, through the [west edge](#the-west-edge-high-rises-default-westedgeclassic-to-drop-them)'s
high rises and off the island. A steel deck on a column at each nose of every planted island, one
track, and one four-car train that crosses the city, waits off the end, and comes back the other
way. `?ltrain=classic` takes it out; shots `ltrain` and `ltrain-far` turn it on even then, framed on
the corner. Tyler, 2026-10-14: "make a right turn and head out of town through the west side high
rises. Doesn't make sense fading off into the ocean." `?ltrainwest=classic` keeps the straight
north-south line it replaced, and `?lroute=classic` the east-west one before that
([rendering-history.md](rendering-history.md#the-l-trains-route)).

- **Built along a path.** The geometry, the train and the timetable all work in `a`, distance along
  the line (0 at the middle of the curve, growing towards the north end), and `o`, the offset across
  it towards the camera. `planLTrain` turns the line into straight pieces and one quarter circle;
  `plan.world(a, o)`, `plan.frame(a)` and `plan.alongOf(x, z)` convert. Lengthwise members are swept
  along it (`sweepBox`, every triangle's winding checked against its face), cross members and bents
  are turned square to it, and each car stands on the chord between its two trucks.
- **The corner is a quarter circle across the junction, on no columns of its own.** Nothing stands
  in a junction box, so the curve runs from the far nose of the island on one leg to the far nose on
  the other: radius 13.65, a 21.4 span, the near noses dropped because they would stand under the
  curve off its centreline. 5.2-unit cars on 13.65 is the ratio of the Loop's tightest curves; a
  car's middle bows 0.11 in and its ends swing 0.13 out, and the probe walks every car round it
  (worst corner 1.00 off the line against the deck's 1.35). The inner edge comes about 0.5 over the
  corner of the block inside the curve, 6.4 up. Where a park district has closed the road next to
  the junction (about 1 city in 12), a bent stands on its lawn at the curve's end instead.
- **Out west it keeps the city's rhythm.** The west edge's streets have no islands, but the line
  stands a bent where each nose would be, so the spacing does not change at the ring road. The first
  stands on the centreline just behind the barricade, which leaves its middle cone out
  (`RAIL_CLEAR` in city/westedge.js). Past the far column it carries on at `OFFSHORE_PITCH` and
  dithers out with the coast. The coast fade tests all four coasts (`uLCoast`), since the line
  leaves over two of them.
- **The river.** The east-west arterial is always north of the river, so the turning line never
  crosses it and has no truss. Under `?ltrainwest=classic` it does: the bents either side stand 34
  apart, and any straight span past `TRUSS_FROM` (20) gets a through Warren truss standing up past
  the train's roof, its own mesh on a plain material that never fades (Tyler: "don't do any truss
  fading"). `planRiver` still keeps the drawbridge's leaf off the north-south arterial's line
  ([river.md](river.md#which-crossings-bridge)), so the bridges are where they were.
- **Off the north end** it runs on over the north park (`NORTH_PARK_DEPTH`, `coastNorth()`) and
  fades past it; off the west end it fades between the far column's towers.

- **The median is why it is on the arterial.** It is the one strip running the width of the city
  that no car drives on, so the columns need no clearance rule of their own: `planLTrain` reads
  `medianRuns()` and stands a bent `COLUMN_NOSE` in from each end. A park built over the arterial
  leaves a gap with no island, and the deck spans it on the bents either side.
- **One track over the median**, deck 1.35 off the centreline, on a T cap with knee braces. A
  double-track deck spanning both carriageways read well but covered three times the road. It is
  open steel (girders, stringers, floor beams and ties, no slab). The probe still holds the cap's
  underside (5.35) above the box trucks and the street lamps, so it can be widened again safely.
- **It is high (deck top 6.4) on purpose.** The first cut was low (3.3) and over the median only,
  because anything `h` tall hides about `1.09h` of ground behind it on each axis. At play zoom it
  read as a railway cut through the city at street level. What hides more now is paid for by the
  fade: every visible fare pin is projected up its sightline to the deck and the deck dithers out
  there (`FADE_*`). The taxi is not one of them: it has its ghost outline, which traces it through
  the deck as it does through a building, so the deck stays solid over it (`?trainfade=classic`
  thins it over the taxi too, as it used to). Off the island it dithers out the same way, a little ahead of
  the ground's own fade, which reads as gone sooner than its alpha says.
- **Wheel sparks** every few seconds off one truck, through the shared spark pool with its floor
  set to the road, so they fall through the open deck. Only at speed and only over the island.
- **Lamps** (`?trainlights=classic` for the unlit train): two headlights low on the leading end,
  two red tail lamps on the outer corners of the trailing one. Always lit and in the bloom, like
  the cars' pods. The two pairs are one group turned half round when the train runs west, since
  the train is symmetric. In the rain or after dark the headlights throw the cars' additive cone at
  1.5x, faded off the island from the nose's x because a cone has no dither.
- **Its own intro** (`?trainintro=classic` for the old one, which grew the whole line from its
  middle with the city's wave). The bents rise like the buildings, on the city entry's wave and
  levers. Once every bent on the island is up, the spans drop `DROP_H` into place one at a time
  from the end nearer the taxi, dithering in. It is a vertex patch on the deck and column meshes
  (`aLIntro`), carried into the shadow and AO depth passes, and the timetable holds the train
  until the line is built. The spans come from `deckSpans`, so a rerouted line keeps the stagger.
  For a still of it, `?shot=ltrain-far&introAt=2` freezes the intro two seconds in.
- **Not done:** no stations, and no sound (the rumble hook is commented in `ambientLevels`).

### The north park (default, `?northpark=classic` to drop it)

`city/northpark.js`: past the north ring road the apron gives way to a stone wall with gates, a lawn
with a lake and a loop of gravel paths, and trees thickening north into a wood that the lawn fades
out behind (`lawnFade`), so the map ends in green. Tyler, 2026-10-13: "a big park (think Central
Park). From game view will just look like map ends there at a park."

- **Scenery only**, the harbor's terms: outside the ring road, so no street, block or junction moves;
  its own rng stream (`seed + 53`). Trees are the shared `treeParts`, and their crowns go to the
  canopy fuzz with the rest.
- **The lake is the river's water** (`patchLakeWater`, `city/riverwater.js`): the duck pond's
  compose, with its shelf measured off the lake's lobed ellipse and the river's own reflection and
  lip (the pond's darker tuning left a lake this size a flat sheet). It shipped as a flat disc and read
  as paint beside the canal; every body of water wears the one shader (CLAUDE.md, checked in the
  probe). `?water=classic` keeps the flat disc.
- **Nothing in it hides the city.** The camera looks north-west, so everything planted there is
  up-screen of the streets.
- **The L's line runs over it.** Trees and the lake keep `TREE_CLEAR_RAIL` off the line and the wall
  breaks for its columns. `NORTH_PARK_DEPTH` lives in `grid.js` because the map's north edge
  (`coastNorth()`) moves with it.
- **The drives** (`?parkdrive=classic` to drop them): a rainbow of asphalt off the ring road through a
  break in the wall, round a statue on a lawn island, with three yellow pylons shutting each mouth.
  Tyler, 2026-10-14: "purely decorative and shouldn't be part of the traffic map", so it is not in
  the road network and no fare stands on it. `placeDrive` squares it on to a street meeting the
  ring road, so that street ends on the statue and its junction box falls between the two mouths.
  There is one each side of the L ("Add one to either side of the train"): on each side, the
  street nearest the line that is clear of it and of the lake's loop. Where the loop covers every
  street on a side, the lake slides along the wall the least distance that frees one; when the L
  runs down the middle street that can't be done and that city gets one drive (3 seeds in 40).
  Gates and trees keep off the drives, and they are built last.
- Hand-written triangles (paths, lake, shore, fade, drive) go through `upTriangles`, which computes each
  normal from the winding and flips any that face down.

### The west edge high rises (default, `?westedge=classic` to drop them)

`city/westedge.js`: past the west ring road the island carries on for two more columns of blocks on
the grid's own pitch (`WEST_COLUMNS`, `WEST_REACH` in `grid.js`, which moves `coastWest()` out by
40). Every street running along X carries on west to the coast with its own paint, and is shut where
it leaves the ring road by the roadworks' trestle (`barricadeParts`) and a row of cones. Tyler,
2026-10-14: "start some high rises and sky scrapers. Have through streets visually continue but
block them off from the game grid with construction barriers."

- **Scenery only**, the north park's terms: no lane, junction, fare or car is out there and the road
  network never hears of it; its own rng stream (`seed + 59`). The towers are `buildHighRise` in
  `city/buildings.js`, the city's own tower with a height handed in, so the setbacks, façades and
  shopfronts match. They rise in the entrance wave and Rain Mode lights their windows.
- **Two heights.** The near column stays under the city's `SKYLINE_CEILING`; the far one is the
  skyline, 22–33 to the parapet, glass and slate mostly, some with a mast. Nothing reaches past
  `WEST_SKYLINE` (38).
- **Nothing out there can hide the city, at any height.** The sightline off any point climbs toward
  +x+z, away from the west edge, so a tower west of the ring road's kerb is always drawn *behind*
  the streets. `tools/probe.mjs` fires rays from the ring road at taxi height to hold it.
- **The aircraft go round or over.** The aeroplane cruises at 48 rather than 30, so its belly clears
  `WEST_SKYLINE` by 4.6 at the bottom of its jitter. The two helicopters fly at 22, under the far
  column, so neither starts a leg west of `WEST_CLEAR_X` (its east kerb) plus `WEST_MARGIN`: the
  rooftop chopper flips its approach end for end, the police helicopter swings a westerly entry
  round to the north and never leaves westward. The clouds' keep-out takes the far column as a
  third box (`KEEP_OUT` in `game/clouds.js`).
- **The river runs through it.** The channel's walls, walk and railing run on to the new coast
  (`channelWest` in `city/river.js`) and the water shoals and fades there, so boats sail out between
  towers. The new north-south streets stop at the embankment; there are no bridges out there.
- **The camera can pan a little further west** (`PAN_LIMIT_WEST`, half the reach), to look up at the
  skyline.
- **The northwest corner** (`?westcorner=classic` leaves it open ground): the two columns carry on
  north of the north ring road for two rows of blocks (`cornerBlocks`), with mid-rises only (7–15,
  under `SKYLINE_CEILING`, so the helicopters need nothing new). The west ring road carries on north
  between them and the park, shut where it leaves the ring by a trestle and cones (`northClosure`).
  The park gives up its west strip to that street and starts at its far kerb, behind a pavement and
  a wall of its own, and its lawn feather no longer runs west: that feather is what spilled green
  across the asphalt. The ground there is an asphalt patch laid 0.03 under the slab, filling the
  slab's rounded corner, with its own feather off the west and north (`patchFade`). Tyler,
  2026-10-14: "fill in this corner with another some mid rise buildings and smooth out the park
  transition."
- **Past all of it the city carries on into the haze** (`city/horizon.js`, `?horizon=classic` for the
  bare edge): plain towers on the grid's pitch past the west towers and past the north park, fading
  into the sky. See [rendering.md](rendering.md#past-the-edge-of-the-map--cityhorizonjs).

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
[the opening vignette](gameplay.md#the-opening-vignette). It is painted in the cab company's own
colours and carries a neon taxi sign on its roof — see [the livery](#the-livery) and
[the sign](#the-roof-sign-and-what-is-derived-from-it) below.

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

**Never behind the L.** The block whose +X street is the L's north-south arterial is off the list
(`behindLTrain`): its door faces the median across one carriageway, so the sightline to the camera
meets the deck and any train on it, and the forecourt the taxi drives out over (in the vignette and
on every repair) went 55% behind the deck. It took the depot on 23% of seeds. One block further west
is clear. The pick spends the same single draw on both lists, so a seed that was already clear keeps
its depot where it was; `?garageplace=classic` (`GARAGEPLACE=classic` headless) lets it land there
again. A fade on the deck near the door was the alternative and was passed over: a chunk of track
dissolving in the hero shot, with the train and every repair visit needing the same treatment.

### The livery

The depot is the one building the player owns, and it is painted like it. **The envelope itself is
yellow** — `garageWall`, the biggest exception in `palette.js` to "yellow is reserved for the taxi",
and the note there carries the audit. The short version is that the rule protects the read of a
*yellow car on a road*, which is a small moving rectangle at play zoom; this is a static mass on a
block, and every seed puts it somewhere different, so there is no learned "the yellow thing is the
taxi" to break.

What it does have to survive is the opening vignette, where a yellow car drives out of this
building. Which is why it is **#DDA62F rather than `taxiBody`'s #F5C130** — ten points of lightness
and four degrees of hue below the car, enough for the taxi to read as a separate object against its
own depot. The bay behind the door stays `garageBay` dark for the reason it always did: the reveal
is a bright thing coming out of a dark hole, and the wall's colour must not become the hole.

Under the parapet runs one **black-and-white chequer course**, on the two elevations this camera can
ever see. Four shapes of the same trap here, each worth knowing before moving any of it:

- **The course is boxes standing `PAINT_PROUD` off the wall**, not a colour baked into the wall's
  own vertices. A stripe painted onto a face is two front-facing surfaces on one plane, and an exact
  tie resolves differently on different hardware — see [the coplanar note in CLAUDE.md](../CLAUDE.md).
  The paint is proud of the wall and the coping is proud of the paint, so the parapet still reads as
  a lid; `tools/probe.mjs` measures both.
- **It hangs `CHECK_DROP` below the coping rather than flush against it,** and the gap is the
  building's own yellow doing a job. The coping is dark and every other square is nearly as dark, so
  a flush course loses half of itself into the parapet. (That gap used to be a *yellow band*, back
  when the wall was grey. On a yellow wall a yellow band is not a band, so the wall does it
  directly.) **0.17 of the drop is spent before it shows**: the coping overhangs by 0.18 and this
  camera looks down at 0.92 of rise per unit of x, so its lip hides the top 0.17 of everything under
  it. The probe asserts the *visible* remainder, not the nominal drop.
- **The squares are wider than they are tall,** and that is the difference between square on the
  wall and square in the frame. A face running along z is seen at 45° to the view, so its horizontal
  extent is foreshortened by about 1/√2 while its height is not: at 0.46 square the course drew as a
  row of narrow vertical bars.
- **Each elevation is sized to a whole number of squares**, not to a fixed pitch. The two faces are
  different lengths and neither divides by anything, so a fixed pitch ends a run on half a square at
  the corner. The probe walks the squares and demands the colour flips at every step, because a
  course that stopped alternating is still a course of squares from far enough away.

**A blue neon tube runs round the roofline** in that reveal, under the coping, on the same two
elevations: the burger joint's roofline neon in the sign's `depotNeon` blue, mitred the same way
(the +X arm carries the corner, the +Z arm stops on its inner face). It stands 0.14 proud of the
wall, inside the coping's 0.18 overhang so their outer faces are never coplanar, and hangs 0.06
under the coping's underside, which is more than the 0.04 the lip hides. It is now the separator
between the dark coping and the course, a job the sliver of yellow wall used to do. Unlit and in
the bloom (kind `window`), like the sign. `?depotneon=classic` leaves it off.

**The two office windows light up after dark**, on the same switch as the city's lit windows
(`switchedLights` in game/citylights.js): night or a squall's shade passes each pane's threshold and
it fades on. Their thresholds sit at 0.1–0.22, early, with the shops. Only a city with weather has
the switch, so they exist only when `rain.enabled`. `?depotwindows=classic` leaves them dark.

The forecourt gets **two guide lines** out of the bay — the last thing still wearing `garageSign`,
which is `taxiBody`'s own hex, because two lines on the ground where the car is about to be are the
one place reading the taxi's yellow is the point. They are a third level on the block: `PAVEMENT_Y`
is the paving, `APRON_Y` the asphalt on it, `PAINT_Y` the paint on that, named off each other the
way [the burger joint](#the-burger-joint-and-its-drive-through) names its apron. They also stop
`KERB_RUN` short of the lip, where the dropped kerb starts falling away — a level strip carried out
over a ramp is buried in it at one end and hanging over it at the other.

### The roof sign, and what is derived from it

On the roof, **a taxi cut out of board, with a pink neon tube round its edge**, swaying on a pole.
The player's eye is already scanning the map for a yellow taxi, so a taxi is the fastest thing on
the roof to find; being *flat* is what stops it reading as their car, because a car on the road
never is, and the neon says "sign" a second time. It is `cutoutGeometry()`: one extruded outline
(body, a cartoon-tall cabin, the roof light), with the windows, chequer, roof-light face and wheels
each a solid running through the board so they show on both faces without a hand-wound triangle.

Three things about it are measured rather than chosen:

- **It sways rather than turns** (`CUT_SWAY` either side of the camera's diagonal). A flat board
  that turned would go edge-on twice a revolution, which is the problem the wrench had.
- **The board is self-lit** (`BOARD_LIFT`, an emissive share of its own yellow, on its own mesh so
  the glass and tyres stay dark). Facing the camera, its face is in shade for much of the day, and
  under the shadow tint the taxi's yellow went lilac.
- **The neon is unlit and in the bloom** (`depotNeon`, kind `window`), so by day it is a line of
  full colour against a sunlit roof and at night it glows. Blue, leaning cyan so it is not the
  police lamps' blue; amber, red and green all mean a fare's clock. The tube is flattened, thin in the board's plane and deep across it, so it
  stands proud of both faces without drawing a fat band (a round one had to be 0.4 across to clear
  them). A brighter spot chases round it and now and then it stutters, both written as vertex
  colour each frame, which the bloom's copy of the material reads as well. The tyres are wider
  than the tube is deep so the length of it along the sill is buried in them.

**Flames out of the tailpipe, painted on.** A chrome stub pokes out of the tail (`PIPE_*`) and a
hot-rod flame cut from board runs back off it: three licks curling up and back, red round orange
round lemon (`signFlame*` in palette.js), the inner two as solids through the outer each
`FLAME_PROUD` prouder. It is static and unlit and stays out of the bloom — sign paint, not fire. An
animated backfire in the Loco plume's own tongue was tried first and read as the player's boost
going off on the roof. It is in the sweep the pole is placed from but not in the centring, so the
pole stays under the taxi. `?signflames=classic` has no pipe and no flame.

`?depot=model` keeps the first cut of this sign: the real taxi's 3D model (`taxiSignGeometry()` in
geometry/taxi.js), banked on the pole and turning. It read as a car parked on the roof rather than
as a sign. `?depot=classic` brings back the sign before that, described below:
an **oversized wrench turning on a pole** — the depot is where the taxi comes back for
repairs and upgrades, and the building has to say so from play zoom before anybody has learned it.
It is a sign in the burger joint's sense: one big object, canted 45° off vertical, turning about
once every sixteen seconds (`DEPOT_SPIN`, shared by both signs). It replaced a radio mast and dish, which said
"dispatch" — true, and nothing a player can act on.

It is **one extruded `Shape`**: a combination spanner, open jaw up, hexagon ring down. One outline
rather than a handle and two heads merged, because three winds an extrusion itself (no hand-written
triangle to get backwards) and because separate solids would share their flat faces on one plane
where the handle runs into each head — coplanar overlap, which shimmers. A single-segment bevel puts
a chamfer round every edge, and that is most of what reads as metal: under `flatShading` a flat slab
lit by one sun is a cut-out, and the chamfer is a ring of 45° faces that catches the glint as it
turns. The material is the vehicles' **metal** finish (`propMaterial({ gloss })` with every vertex
on `FINISH.METAL`) — a darkened base with a tight glint and some sky and skyline reflected in it.
Under Crayon and Cartoon the gloss is declined and it is an ordinary prop, as the cars are.

The pole is static and rides in the shell's merge. The wrench cannot: the city's entrance wave is a
vertex shader whose anchor is a *world* coordinate, and a world coordinate in a turning object's
local space is not a coordinate, so it grows on the CPU through `createCityEntry`'s `objects` list
exactly as the burger does. Its pivot stands at the **pole's foot, on the kerb**, not at the
wrench's centre: the CPU path owns nothing but `object.scale`, and the shader scales the shell about
`KERB_H`, so a uniform scale about a point on that plane is the same arithmetic and the wrench rides
up the pole as the pole grows. It is out of the AO lookup as well as the prepass — the dish before
it, left receiving, wore a dark blotch of its own roof's crease that moved with the camera.

**Almost nothing else up here is a literal** — a habit carried over from the dish, which was
resized twice, and both times what broke was a hand-tuned number *around* it:

- **The pole's height** is wherever the sign's measured underside clears the roof plant by
  `WRENCH_CLEAR` (or `TAXI_SIGN_CLEAR` for both taxis). The pole stops at the sign's centre —
  inside the wrench's handle, or inside the taxi's body.
- **The pole's standoff from the roof corner** is the radius the sign actually sweeps (the
  cutout's included, neon and all, as if it turned rather than swayed) — the
  furthest any vertex gets from the pivot *axis*, which is not `boundingBox.max.x`, because the box
  measures a pose the wrench holds for an instant — plus a margin. One number answers both things it
  must not reach: the +Z parapet it could swing out over, and the **curtain plane**, since every
  sightline out of the door starts there and runs +X, so anything wholly behind it cannot occlude
  the door at any height.

One thing that is *not* derived and cost a probe failure to find: the rooftop plant. Its two boxes
were placed one offset from the back of the roof in x and one from the front in z, which only ever
stayed clear of the old radio mast because an ordinary block is 12 wide. A block squeezed between
two arterials is 9.33, and the mast walked into a box with nothing in the geometry to say so. Both are
measured off the back corner now, and the probe measures the gap.

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

## The graveyard

`city/graveyard.js`. **A double block** since 2026-10-13: two blocks side by side along X and the
north-south road between them closed, built the way a [park district](#park-districts-close-roads) is — one
kerb, one lawn and one fence over the lot. `?graveyard=single` (or `GRAVEYARD=single` for the
headless tools) brings back the first cut, one block drawn **last** in `createLayout` like the depot
and the burger joint; `?graveyard=classic` leaves the city without one.

The double lot cannot be drawn last, because the road it closes has to be closed before the network
is baked. So `planGraveyardPair` runs straight after the park districts, beside them, and picks
**without a draw**: the candidate is hashed off the districts' positions the way the pocket park
picks its block, so planning it moves no park, tree or tower. Every city gets one (24 of 24 in the
probe's sweep), never downtown, and never across an arterial — closing a main street breaks its
green wave.

It is scenery only. Nothing routes into it, nothing on it can be tapped, and the fare loop doesn't
know it exists. An iron railing on a stone plinth runs round the lawn, with a gate in the middle of
the +Z fence.
Headstones stand in rows either side of a gravel path that runs gate to gate (one gate in each
end), one of the parks' statues (`statueParts`) stands on its plaza in the −X half for some
asymmetry, and long grass grows between the rows (see [Long grass](#long-grass)). The fence's piers
stand every 6.4 units in a brownish stone (`gravePier`): at half that pitch and in the graves' own
grey they read from across the map as one more row of headstones. The big plum-crowned tree that
stood in the back corner is off since 2026-10-17; `?gravetree=classic` brings it back. The ground mist that used to drift across is off
since 2026-10-15; `?gravemist=classic` brings it back, thickening after dark on the same measure of
darkness as the helicopter's searchlight.

- **It faces the camera, like the burger joint.** Only +X and +Z faces are ever seen, so the gate is
  in the +Z fence and every stone faces +Z. A first cut had an above-ground crypt and bare spooky trees; Tyler cut
  both.
- **The stones are drawn 1.4× life size** (`STONE_SCALE`). At life size they were four pixels at play
  zoom, and the lot read as a fenced lawn with grit on it.
- **Out of downtown.** Both cuts keep it at centrality ≤ 0.5: a low lot among towers is one the
  camera cannot see into. In practice that is the outer ring of blocks. Each filter falls back to
  the pool it narrows. The single cut also keeps off any block touching the depot or the joint; the
  double lot is planned before either exists, and they are placed round it.
- **Side by side, because of which road it closes.** A pair stacked along Z closes an east-west
  street, and east-west side streets are the scarce kind: the U-turn's tip card films on three
  straight open blocks of one (`pickStreet` in game/uturnclip.js), and the north-south streets
  nearly all cross the river and never qualify. Stacked, 20 cities in 200 had nowhere to film;
  side by side it is 2 in 200, the same as with no graveyard at all.
- **What the double block costs.** One road segment and two blocks of kerb, so fewer riders' corners
  and one fewer way through at the edge of town. Measured on the robbery getaway over seven cities ×
  12 getaways: cops brake-check a third less (60 to 40) and pass a little less (33 to 28), with
  roadblocks unchanged (86 to 90). Why is not established; the getaway runs for a corner of the map
  and the lot sits out by the edge. Losing a cop round corners is unchanged (14 in 32 against 12).
- **It moves the probe's city.** Taking blocks and a road reshuffles the pinned seed's traffic, and
  several scenario checks there were calibrated on one draw. The first cut moved the bank (the arrest
  check's drive-to-drop-off window went from 10s to 25s); the double block widened the getaway
  sample, and fixed checks that were measuring the wrong thing — a watching taxi that
  braked to a stop *inside* the next junction and gridlocked the cops, a robber measured against
  after they had got into the car, a drive-through visit that waited on traffic held to the clip's length (the last two are #483's fixes, taken verbatim).

## The bank

`src/city/bank.js`. One per city: a low, wide stone building with a colonnade under a pediment and a
patinated-copper dome behind it. It is the third building the tower generator does not draw, and the first
of the three that is **a lot rather than a whole block** — the depot needs a forecourt to pull out of
and the burger joint needs a drive-through lane, both of which are ground `splitLot` would divide out
from under them. A bank is a building with a door on the street.

It is placed from `createBuildings` alongside the courtyard rather than from `createLayout`
alongside the other two, because which *lot* it takes is a fact about the tower generator's own
draw. Same discipline either way: it is drawn last, with the courtyard's lot already excluded, so
adding it cannot reshuffle a park, an arterial, a tower or the depot. `null` is a real answer —
**38 cities in 40 have somewhere to put one**, and the two that do not simply never have a bank
robbery ([gameplay.md](gameplay.md#the-bank-robbery)).

### The silhouette is the feature

A [robbery](gameplay.md#the-bank-robbery) starts when the empty taxi drives past this building, on a
trigger the player never presses. So a player who has had one happen has to be able to find the thing
that caused it, from across a five-block city, at play zoom, on a phone — which is a tighter brief
than "a distinctive building" and is the whole of why it is shaped the way it is.

| | |
|---|---|
| **Low and wide** | Roofline a flat 6.95, dome to 9.59 on average (9.39–9.73 over 40 seeds), against neighbours that run 5 to 16. The bank is a gap in the skyline before it is anything else — and the roofline is [derived rather than drawn](#the-roofline-is-derived-not-drawn). |
| **A colonnade** | The one vertical rhythm in a city of plain boxes. `bankColumn` is a paler stone than `bankStone` for this: at play zoom a column is about three pixels, and what reads is the column against the wall rather than the shadow between them. |
| **A pediment** | The one triangle at street level. Pitched roofs exist (`pitchedRoof`) but they sit on low-rise and never at the front. |
| **A dome** | The one curved mass in the city, in the one colour nothing else wears: verdigris (`bankDome`) on `FINISH.PATINA` (a broad green satin sheen, a faint clear shine, fine mottled sparkle) with soft normals. Each pane (a gore of a ring) gets a hash-jittered lightness and hue, darker the lower it runs and lighter on the top ring, so it streaks like weathered copper; coloured per triangle in `bank.js`. It is **not in `parts`**: `buildBank` hands it back as `site.domeGeometry` and `createBuildings` returns it as `domeMesh` (`bankDomeMesh`: a glossy `propMaterial` of its own, stamped with the lot's entry anchor so it rises with the building), which `main.js` adds, marks an occluder and puts in the entrance wave. The workshop bench draws it the same way. |

The envelope stays **inside** the muted building family, unlike the depot's and the joint's. A bank
is a bank among offices rather than a shed or a roadside box, and painting it to shout would have
taken the shape's job away from it.

**The front is not a choice**, for the same reason the drive-through's orientation is not: the camera
looks down the +X+Z diagonal and never rotates, so of a building's four faces only +X and +Z are ever
visible. `chooseBankLot` only offers lots with a +X or +Z street side, and the portico faces whichever
of the two the lot has. The frontage measures 10.19 across on a 40-seed sweep, which is very nearly a
whole block: the minimums (7.0 across, 5.5 back) are met by an undivided block and by essentially
nothing else.

### The roofline is derived, not drawn

The one number on this building that was measured. A bank takes a whole block, so its **back wall** is
a single flat 10-unit occluder standing directly up-screen of a kerb corner — and that corner is one a
rider or a courier pad can be placed on ([the visible-corner filter](gameplay.md#corners-the-camera-cannot-see)).

The geometry is fixed. A kerb corner stands `HALF_ROAD + 0.5` out from its junction, the block starts
`HALF_ROAD` the other side of it, and the buildable rectangle is `INSET` inside that — so the back
wall is **9.35 units away** on an ordinary street. The sightline climbs 0.92 per unit travelled, so it
is 7.64 up when it reaches the nearest part of the mark and 10.86 by the furthest.

Anything between those two **cuts the mark in half**, which is the one outcome `cornerSeen` cannot
express: it scores six samples and a half-hidden corner comes out at three of six, on the wrong side
of a threshold calibrated against towers that hide a mark outright or not at all. Measured over 840
corners in 20 cities against real rays:

| Bank roofline | Corners left on the board with <60% of their mark visible |
|---|---|
| 7.75 (the first draw) | **3**, and the score-4 bucket's worst case at 0.56 |
| 6.95 (shipped) | **0**, worst corner kept 0.64 — where every other city already sat |

So the mass ducks **under** 7.64 with margin rather than clearing 10.86: a taller bank would hide the
corner honestly and cost the board a junction, and a low wide bank is what the silhouette wanted
anyway. Everything at the front is then sized down to stay under the roof behind it, because a
pediment poking above its own roofline is a gable rather than a portico.

## The roadside lot, and its tube man

The fourth block taken from the tower generator (`city/roadside.js`, `?roadside=classic` to give it
back) is a roadside business with an inflatable tube man on its corner: a car wash or a gas
station, a coin flip off the city seed (`roadsideKind`, on a stream of its own so the flip moves
nothing else). Both stand on the same block. `?roadside=carwash` or `?roadside=gas` pins one. Tyler
had the two built side by side to compare and then picked both (2026-10-17).

**The car wash** (`city/carwash.js`) is a wash tunnel against the block's −Z edge, with its long +Z side open on posts so the brushes
turning inside it show, a blue fascia covered in soap bubbles, a concrete lot out front with two
vacuum bays and a pay kiosk, and a pylon sign spelling WASH in a pixel face. It is scenery only for
now: no car goes through, and nothing routes into it. Chosen last in `createLayout`, after the
graveyard, so adding it moves nothing above; it avoids touching the other landmarks and prefers
quiet, inner blocks, as the burger joint does.

**Taking the block moves no other building.** The towers on it are still split, drawn and built,
into a scratch array that is thrown away (`ghost` in `city/buildings.js`), because skipping them the
way the depot's and the joint's blocks are skipped shifts every draw after them and rebuilds the
skyline. That is what turned the probe's corner sweep red the first time: a reshuffled tower three
blocks away halving a kerb mark. A courtyard, the bank or the helipad drawn onto the roadside block
moves to another lot, picked by hash so nothing else moves with it; the probe holds every other
vertex in place.

**The roof is as tall as it is so the brushes show.** A sightline into the open side climbs 0.92
per unit of z on its way out under the eaves, and the top brush sits 2 up and 1.7 in, so the eaves
have to clear 3.56. At 3.0 the roof hid it.

**The gas station** (`city/gasstation.js`) is a convenience store with lit windows and a MART band
on the block's −X half, and a green canopy over two pump islands on its +X half, pulled back from
the +Z kerb so the tube man's corner stays open, plus a pylon with GAS over a price board. The
canopy's depth and height are a sightline too: the pumps sit 1.8 in from its +Z edge, so a line
from a pump's top climbs 1.66 on its way out and clears the 3.7 underside. Deeper or lower and the
pumps vanish under their own roof; the probe fires a ray from each pump to check.

**The movie theater** (`city/movietheater.js`) is a **workshop-only** bench model for now: nothing in
the city places it, but it exports a `LANDMARK`, so the workshop catalog finds it on its own. A deep teal
(`cinemaWall`, the complement of the red board, marquee and carpet) brick fly tower with CINEMA lit across a red board on its face, framed in gold, a low cream lobby in front, a marquee over the doors on two posts (a plain red slab: no light strip, no gold trim), poster frames
either side, a red carpet (`cinemaCarpet`) running from the doors across the forecourt to the kerb, and a ticket booth in the forecourt. The plant room on the tower roof is a muted teal-grey
(`cinemaRoofUnit`, only a step lighter than the wall so it blends with the roof rather than glaring), not the coping's dark `cinemaTrim`.
Bulbs run round the sign's frame only, and they chase: every third bulb shares one of three meshes, and the model's `update(dt)` darkens
one mesh at a time, 0.14s per phase, so a dark gap travels round the loop like a marquee's. Whole
meshes taking turns being `visible`, not a colour per bulb, because the glow is unlit vertex colour.
The entrance and the name are on +Z, since only +X and +Z faces are ever seen. The name is lettered
with `wordParts` from `city/roadside.js`, which gained C, I, N and E for it. Colours are the
`cinema*` entries in `palette.js`. Tyler asked for it at the bench (2026-10-20).

**The tube man** (`game/tubeman.js`) flails on the lot's +X+Z corner, the one the camera faces: a
red tube on a blower box, yellow streamers for hair and cuffs, a cartoon face. He is a chain of
capsules jointed end to end, bent by two travelling waves so the S runs up the tube, and every few
seconds he folds over and whips back up with an overshoot. The sway is across the screen, since a
bend toward or away from a camera that never rotates barely shows; the fold goes back over the lot,
because the two other ways out of that corner are roads. He is not tappable: a tall thin hit target
steals taps from markers up-screen of it.

**Which block is a sightline.** `chooseRoadsideBlock` only takes a block where the tube man's corner
and the middle of the block can both be seen over every block up-camera of them, using
the burger joint's height predictions. He stood on the burger joint's apron first, beside its
drive-through lane; Tyler wanted him on a business of his own (2026-10-17).

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

### One pocket park is guaranteed

Besides the two districts and the 2–5% roll for a lone pocket park on each block, `createLayout`
always hands **one more built block back to the grass**, because the districts now hold the statue,
the pond, the court and the skatepark between them and the open lawn had all been built on. It must
be off downtown (`centrality < 0.6`) and touch no other park on any side or corner, so it reads as a
separate green. It takes **no draw**: the candidate is hashed off the districts' positions, so the
depot and the burger joint downstream keep their stream. Over 80 seeds the share of cities with no
lone pocket park went from 32 to 0.

The probe's pond checks used to plan the statue and the pond off two separate `parkPlots` calls.
`planPond` keeps out of the statue's park by *identity*, so it never saw the statue's plot and could
put the probe's pond in it. It passed only because no seed had drawn that until this block moved the
stream. All three now share one plots array.

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

### A basketball court

**Exactly one a city**, on the pond's terms: scenery, nothing routes round it, nothing on it can be
tapped. `planCourt` (`city/blacktop.js`) draws after the pond on the same stream and places the
slab *around* the statue's plaza and the pond rather than instead of them, so it can share a
district with either — which is what gets every city one. It tries every length from 13 down to 9
at nine slide positions along each plot's long axis and prefers a district at the longest length
that fits; a full 13 cannot clear the statue's plaza from either half of a district, so in the
statue's district it comes out at 12.

- **The court has its own frame** (`u` along, `v` across) and `toWorld` maps it onto whichever axis
  it lies along. The mapping is a reflection on a Z-axis court, which is harmless only because
  nothing is built by rotating: boxes are sized through `boxAt` and every flat surface goes through
  `ShapeGeometry`, which rewinds itself to face up. The probe computes every triangle's normal from
  its winding.
- **No fence.** The first build ran a translucent chain-link panel down the far side and across the
  far end; it came out because the court reads better open to the lawn.
- **Two meshes, not one.** The slab and its paint merge into the props mesh. The hoops are a mesh of
  their own, because the props mesh is handed to the fare board's sightline field
  (`game/sightline.js`), which stamps each triangle's peak across its whole footprint, so thin
  furniture stamps as a solid column or wall. The fence showed what that costs: its 3.1-high top
  rail stamped as a wall with no gap under it and threw away a kerb corner a real ray could see 85%
  of.
- Benches the slab would stand on are filtered out after the plan (a filter, so no other bench
  moves); the ones left beside the court face it. Trees keep a crown's reach off it, grass a card's,
  and both flocks treat it as a rectangular keep-out (`offRect`/`stopAtRect` in `game/birds.js`).
- The single extra draw lands ahead of the trees in the props stream, so **every seed's park trees
  moved** when the court arrived, the same trade the pond made.

The players are `game/hoopers.js`, on the run seed (`+313`): one most of the time, two in 60% of
runs, each with a ball and a hoop of their own and kept on their own half. Dribble out to a spot in
range, settle, jump shot, watch it, chase the rebound, repeat. The arc is solved for a flight time
rather than an angle so it always arrives where it was aimed, and make or miss is decided at the
release as an aim point (dead centre, or a point on the ring). The poses live in
`geometry/person.js` as pure functions of phase (`dribblePose`, `shotPose`, `handAt`) so the ball
can be put in the hands that are holding it rather than in a second copy of the arm's geometry.
The probe runs five minutes of it: the ball never sinks into or leaves the slab, and every miss is
fetched. `?shot=court` and `?shot=court-far` frame it.

A **boom box** sits beside the court, playing to them (`planBoombox` in `city/blacktop.js`, drawn by
`game/boombox.js`). Where it goes takes no draw from the props stream: it faces the court, and the
spots round the court are ranked by how squarely that face turns to the camera — the speakers are
the read, so the far sideline first, then the **far sideline's apron** (set down on the blacktop
outside the lines), the far baseline after that, the near ones last — then the first on the lawn
and clear of benches, statue, pond and skatepark wins. The apron used to rank *behind* the far
baseline, and a court with no lawn up-screen of it put the box beside a hoop's pole with the park's
trees between it and the camera (9 boxes in 40 seeds); in practice the box now always stands at the
far sideline, on the lawn or the apron (13 in 40 on the apron), and on the half of it further from
the camera — the near hoop's backboard is thrown up-screen onto the other half. On each beat it hops, squashes as it lands, its woofers pump, and an orange quaver or beamed pair floats up over
it; the notes are opaque and go out by shrinking, because a translucent one blends twice where its
head, stem and flag overlap. Only the box is in the city's entrance wave; the notes follow its scale
and visibility, because the wave also owns `visible` on what it is handed and once switched the
pool's never-emitted spares on at the world origin. It is silent for now — see [audio.md](audio.md#the-boom-box) for the
hook.

### A skatepark

**Exactly one a city**, the court's neighbour and on the court's terms: scenery, nothing routes
round it, nothing on it can be tapped. `planSkatepark` (`city/skatepark.js`) plans after the court
and keeps clear of the statue's plaza, the pond *and the court*. It takes **no draw** from the props
stream: the winner is the longest slab in a district, then the one furthest from the court, so the
only trees it moves are the ones its keep-out turns away. Over 80 seeds every city got one, mostly
11 or 12 long in half of the statue's district.

- Two quarter pipes across the ends (radius 2.3, cut off at 72° so the lip is 1.57, about shoulder
  height on a figure), a deck behind each, and one feature per lane down the flat between them: a
  grind rail on the −v lane and a funbox on the +v.
- **Its frame is a rotation, not the court's swap.** A ramp is an `ExtrudeGeometry`, and a reflected
  extrusion is wound inside out, so a Z-axis park is the X-axis one turned a quarter about Y,
  (x, z) = (−v, u). The probe sums every piece's signed volume to hold the winding to account.
- Two meshes, the court's split: the concrete (slab, ramps, funbox) merges into the props mesh and
  *is* a sightline occluder, because a 1.57 quarter pipe does hide things; the coping and the rail
  are thin metal and get a mesh of their own (`skatepark-frame`).
- Benches go through the court's `clearBenches`, grass through `onCourt` and birds get a keep-out
  rectangle; all three only read a slab's centre, axis and size, which the two share.

The rider is `game/skaters.js`, on the run seed (`+349`): **one**, using the whole park. Still a
pendulum on the lane's surface (`surfaceAt`), pumped on entering the flat so the far end peaks
where its trick wants it, but now with its energy kept (`E`) so a hop or a grind can take it off the
surface and hand it back at the budgeted speed. Between passes it carves across the transition to
the other lane about half the time, spread over the path it covers up there so it is finished by
the flat. The ends draw from kickturns, airs (grabbed, kickflipped, a full 360), a rock to fakie, a
180 on the deck and a rest; the middle from ollies, kickflips and shove-its over the funbox, a
manual across its top, and 50-50s and boardslides down the rail. Stance is not stored: fakie is
travelling toward the tail, and a rock or a 360 is what toggles it.

- **The board is a rigid stick on two trucks.** Its pitch is the slope of the surface's upper hull
  under the wheelbase, and its height the lowest it can sit at that pitch without a wheel in the
  concrete (`restSlope` / `restHeight`). The first cut oriented the board off the slope under its
  middle, which on the funbox's piecewise-flat kickers flipped it 24° in one frame — the "snap".
  Now only the *jumps* in the hull's slope are eased (`TIP_STEP`, `TIP_W`), so the board tips over
  an edge in about a sixth of a second while still following a transition exactly.
- **The body is springs**, driven by what the rider feels: the load into a transition sinks the
  knees, deceleration pitches the body over the nose and the arms come up against it, a landing
  compresses. Underdamped on purpose — the overshoot is most of what reads as alive.
  `person.ride()` takes the dials; a lean folds the front knee so the feet stay on the deck.
- **It rides bent.** The figure has a waist now (`chest` in `geometry/person.js`, identity for every
  pose but `ride`), and the stance is a real one: knees well bent all the time, the chest folded
  over them, arms low and loose until a grind or an air needs them out. #461's set points (a 0.1
  crouch, an upright back, arms a radian out) read as a frozen T-pose and are kept behind
  `?skater=stiff`.

The probe runs five minutes over four runs: one rider, no wheel ever under the concrete, the board
never more than 0.12 rad of pitch in a frame, both lanes and at least ten tricks. `?skater=classic`
is the first cut (`game/skatersclassic.js`): two riders in 75% of runs, each in its own lane, airs
and kickturns only, and it keeps its own probe check. `?shot=skatepark` and `?shot=skatepark-far` frame it.

### Long grass

`city/grass.js` scatters tufts over every lawn: one alpha-cut card per tuft, cut from a small atlas
of blade drawings built in code (`util/cutout.js`: a `DataTexture` with its mip chain drawn level by level, so a blade
thins to a texel rather than averaging away under the 0.5 cut). Clumped by value noise rather than
spread evenly, because an even scatter reads as a texture laid over the park.

- **Every card faces the camera.** The view never turns, so a crossed pair would leave one card
  edge-on for the whole game. Each spans the screen's horizontal with ±0.6 rad of yaw; the probe
  asserts the winding.
- **Lit as the lawn.** Every vertex carries the ground's up normal and the material
  (`propMaterial({ cutout })`) is smooth-shaded so that normal is the one used — a flat-shaded card
  lights as its own camera-facing face and every tuft came out as a pale chip. The root is the
  lawn's colour, so only the tip (`grassTip`) shows.
- **Receives shadows, casts none, and is not an AO occluder.** The prepass would draw each card as
  a solid quad. It still *receives* AO, deliberately: what sits behind a tuft on screen is the lawn
  it grows from.
- Kept off the walk (both card ends, not just the root), the statue's plaza, the pond and the
  benches — swept over seeds in the probe. Its own stream (`seed + 122`), so retuning it moves no tree.
- Up to 0.9 tall — level with a bench's backrest — because that is the height at which a clump
  reads as a volume the tree shadows lie *across*. It does hide the lower half of a bird walking
  through it, which is meadow behaviour rather than a bug.
- **The edge lawns grow it too** (default; `?edgegrass=classic` leaves them flat green): the north
  park, the park shore beside it and the south shore's strip. Each module hands `createGrass` its
  lawn as an area (`grass` on what `createNorthPark`, `createParkShore` and `createSouthShore`
  return: bounds, an outline test, what stands on it, a density), scattered by the same rule off
  its own stream (`seed + 123`) and appended to the same mesh, so the edges cost triangles and no
  draw call. Kept off the park's paths, lake bank, drives and wall, the shore's walkway and cart,
  and the L's footings. The north park thins north (`NORTH_THIN`: gone by ~70% of the depth, where
  the wood stands — at full density it was ~7,200 tufts, four times every other park together) and
  every edge thins to nothing over the last 8 units before its lawn feathers out, so the grass
  never stops on a line the lawn runs past. Measured headless (`tools/perf.mjs`, seed 7): ~2,950
  tufts north and ~3,450 south, 308 draws either way, 651.1k → 664.0k triangles a frame (+2%). The
  `?bench` row `edge grass off` is there for the alpha-tested overdraw, which only a phone measures.
- **The graveyard grows it too** (default; `?gravegrass=classic` leaves the lawn flat): the lot
  inside the fence hands `createGrass` an area (`grass` on what `createGraveyard` returns) off its
  own stream (`seed + 124`), appended last. Rooted in `graveGrass` rather than the parks' green, at
  0.75 of a park tuft's height so no clump tops a headstone, and kept off the plinth, the path, the
  open gate leaves, the tree's trunk, the statue's square and each stone with the grave in front of
  it — the front reach matters most, since a tuft on the grave stands between the camera and the
  stone's face. About 90 tufts a lot, so ~180 triangles in the same draw. The probe checks the
  built cards against the fence, the path and the stones the graveyard reports.

### Leaf fuzz on the crowns

`city/canopyfuzz.js` is the same card technique on the trees: leaf-cluster cards scattered over
every canopy lobe, half sunk into it, so a crown's silhouette goes ragged while its facets still
read through the middle. `treeParts` records each lobe as it builds it (`crowns`) — a record, not
a draw, so the probe asserts a tree grown with it is identical to one grown without. Each card
carries the **lobe's outward normal** where it stands, so the fuzz lights with the crown's own
light direction rather than as a pale crust; cards on the far side of a lobe, which the fixed
camera never sees, are dropped after the draw. Covers the parks', the medians' and the courtyard's
trees; `seed + 144`. The atlas builder both share is `util/cutout.js`.

## The 6 × 7 city and the central park

`?city=big` (`CITY=big` for a headless tool) is 6 × 7 blocks, 36 of them land, with a **2 × 2
central park** and a curving road through it (`city/centralpark.js`). The default 5 × 6 city has
straight roads only. Ambient traffic scales with the street: 16 to 30 cars on the big city against
the default's 12 to 22 ([difficulty.md](difficulty.md)).

The park road is a trick worth knowing before extending it. Every grid road round the park's middle
junction is **closed**, so the road markings, the junction paint, the depot and drive-through
filters and `isCityConnected` all see one solid green. The road is then put back **in the network
only**, as two arcs, W → middle → E, with opposite bulge so they meet tangent. Keeping the middle
junction as a node is what keeps every lane between grid-adjacent nodes, which the sim's grid view
(`car.i`, `car.j`, `car.d`, `laneByGrid`) still needs; a single arc spanning the park would hand ~20
callers a `null`. The middle node has two arms and nothing crossing, so it bakes as uncontrolled,
and it is kept off the fare board (`isParkwayMid`) because its kerb corner is lawn.

The bulge, 0.25, bends the road 28° into the junctions at each end, inside the 30° at which the
network still calls it the same street as the road it continues — one signal phase, driven straight
on. That needed two network fixes the grid never exercised: a road carrying on through at an angle
is not a crossing road (it was holding both arms 8.5 back), and `planeCrossing` never trimmed a
curved lane at its far end. The lawns are built by offsetting the centreline further for each layer
(kerb, walk, grass) rather than by insetting the kerb polygon, whose clipped ends fold.

The park road is one-way in a direction the seed picks: one lane down the centreline of a 6-wide
road, with chevrons a quarter, half and three quarters of the way along and no centre line. `?parkway=twoway`
(`PARKWAY=twoway` headless) gives it two lanes.

The park road is the one road the grid has no opinion about, so `tools/roadnet.mjs` leaves its lanes
out of the grid comparisons. It also skips the trim checks at the road's two end junctions: the road
leaves them 28° off square, so its kerb holds the cross street ~0.6 further back than
`junctionReach` (which knows only square crossings) says. Several probe sweeps skip the park's
middle junction facing against the one-way, which no car can be in. `npm run check` covers the
default city; `CITY=big npm run check` is the big one's suite.

## Ground, buildings, props

| File | Produces | Notes |
|---|---|---|
| `ground.js` | asphalt slab, road surface, kerbs (`KERB_H = 0.35`), block tops — a park's is a walk around a lawn, [above](#a-park-has-a-frontage) — crosswalks | One merged mesh, plus the edge fade as a child — alpha can't ride in the merge's 3-component colour. Crosswalks are omitted at unsignalised junctions — a crosswalk implies a signal. |
| `buildings.js` | towers, courtyard blocks, façades, roof furniture | One merged mesh. Height ceiling is deliberately low; tall towers hid the taxi. See [what a building is made of](#what-a-building-is-made-of). |
| `props.js` | trees, park benches, the statue | Merged per material via `bakeColor`, so hundreds of props cost one draw call. Placement is [above](#benches-and-one-statue). |
| `manholes.js` | four or five manhole covers | Its own mesh, wet in the rain, not brushed. [Below](#manhole-covers). |
| `game/streetprops.js`, `geometry/streetprops.js` | two blue post boxes and a hot dog cart on the kerb | Their own meshes, since they fall over. [Below](#the-post-box-and-the-hot-dog-cart). |

### Manhole covers

Four or five cast-iron covers per city (`city/manholes.js`, `?manholes=classic` for none), placed
off the city seed in **junctions**: one per chosen junction, set off the box's centre on both axes,
at least 1.6 blocks apart (so never in neighbouring or diagonal junctions), inner junctions only and
only ones with three or more open roads. The junction box is the one piece of road with no paint in
it — crosswalks start just past its edge — and `BOX_CLEAR` keeps the disc half a unit inside it.
(The first cut put them mid-block in a lane; Tyler asked for intersections.) Flat, at the paint's
height, with no collision and no say in the traffic.

They are drawn bigger than life (`COVER_R` 0.72, so ~11 px across at play zoom on a phone) because at
true size they are four pixels. What reads at that distance is albedo — a lid darker than the
asphalt inside a frame lighter than it — and that is also what still reads at night, when the glint
has gone with the sun. Close up the lid's diamond tread and the frame's bevel are a height field in
the fragment shader, bending the normal; a Blinn glint added inside three's own direct-light loop
(`RE_Direct` wrapped) is what makes it metal, and being in that loop is what keeps it out of
shadows. The tread fades out by `fwidth` before it can crawl. Their own mesh rather than part of the
ground, because the ground wears the painterly road strokes and iron under a stroke reads as road;
`rain.wetGround` still patches it, so the covers shine in a squall like the street round them.

### The post box and the hot dog cart

Two blue post boxes and one hot dog cart under a red-and-yellow umbrella stand on the kerb near a
corner (`game/streetprops.js`, geometry in `geometry/streetprops.js`, `?streetprops=classic` for
none), and a taxi in Loco Mode takes them out: dust, the prop goes over onto the pavement, and a
spray of letters or hot dogs. The letters flutter down (paper has a terminal velocity), the hot
dogs drop and bounce once. Everything lies there for a few seconds and sinks away, and a fresh prop
comes back up 35s later once the taxi is out of the way.

**Where.** City seed (`seed + 211`). The cart works a **park's walk** and the post boxes stand on
**built blocks** (Tyler: "place the hot dog cart around a park, and then the mailbox can be near
anywhere"); the cart is placed first, since parks are few, and falls back to a built block in a
city with no park spot that qualifies (none in 20 seeds swept). Only on the **+X face**, 0.5 in from
the kerb, 4.2 units along the lane that runs +Z past it. Both halves are forced. The camera sits off
+X+Z, so a prop on a −X or −Z face has its own block's building in front of it. And on the +Z face
the passing lane starts at the block's +X+Z corner, which is where `cornerFor` stands every rider,
so a prop near that lane's start would stand beside the rider pins. The spot also has to clear the
sightline field (`sightlineClear`), stay off lanes shorter than 11.5 (the ones beside an arterial),
keep 1.6 from a rain street lamp, and keep 30 from the other props.

**The swipe.** The taxi can't reach the kerb on its own. Its lane centre is 2.25 off the kerb and
the drawn body is 1.0 across from it, so there's 1.25 of road between flank and kerb at every speed.
A hit radius big enough to cross that gap would blow up a box the car visibly missed. So under Loco
Mode, on the lane beside a prop, the taxi veers onto the kerb at it (`swipeOffset`/`swipeSlope`, a
render-only lateral like the weave and the overtake in `sim/traffic.js`). The veer is 1.75 at full
depth, reached 1.2 before the prop so the flank is already at the kerb when the nose arrives, and it
is back to zero 7.9 along the lane. That's short of the 8.6 hold line on the shortest lane allowed,
where the turn takes over. The probe drives every planned prop: 3/3 hit with the car's centre 1.28
across from the prop's at the hit (drawn half-width 1.0 plus the prop's own), and at cruise none
are touched.

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
no rng — see [rendering.md](rendering.md#window-reflections--citybuildingsjs).

Openings are hand-wound quads batched one geometry per face, not `PlaneGeometry` each. A mid-rise
carries forty windows and the city carries a few thousand; emitted individually they cost more to
merge than the whole rest of the city. Hand-wound means `tools/probe.mjs` asserts the **sign of the
face normal computed from the winding** — see the roadworks ramp in [CLAUDE.md](../CLAUDE.md).

**Roofs.** Flat by default: a cornice cut from the building's own colour darkened rather than from
a shared grey (a flat grey cap on everything drained the tan/brick/concrete families of any way to
tell each other apart at play zoom), then a plant room, up to two AC units, and — one roof in
eight, mid-rise only — a **water tower**: tank, hoop, conical cap and four legs.

Every flat cap is hollowed into a **lip**: `lippedCap` in `city/buildings.js` builds it as a floor
slab and a `LIP_W` (0.28) rim, with the deck sunk `ROOF_SINK` (0.22) inside, and the floor a stop
darker than the rim so the two-pixel sink still reads at play zoom. The towers, the courtyard
wings, the depot and the bank all go through it. The sink is cut *down* into the cap rather than
built up off it, so the roofline every occlusion measurement in the city was taken against does not
move; only the deck drops, and everything on a roof stands on `deck` — the furniture, the helipad,
the depot's sign pole, the bank's drum and the roosting pigeons go down with it. Five boxes merged
into the building's own geometry, so no draw calls. `?roofs=classic` keeps the solid cap
([history](rendering-history.md#flat-roofs)).

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
the 2.2 units above — see [rendering.md](rendering.md#the-feathered-skirt--citygroundjs).

All three use the same technique: generate small geometries, bake colour into vertex attributes
with `bakeColor()` from `util/geo.js`, then merge into a single non-indexed mesh with
`flatShading: true`. See [rendering.md](rendering.md).

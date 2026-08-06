# The city

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

Directions are `0..7`. **0–3 are the grid**, meaning `+X, +Z, -X, -Z`; 4–7 are the diagonals of
the [avenue](#the-diagonal-avenue) and are covered there. The grid ordering is chosen so that:

```js
rightOf(d)   = (d + 1) % 4
leftOf(d)    = (d + 3) % 4
opposite(d)  = (d + 2) % 4
isXAxis(d)   = d === 0 || d === 2
dirSign(d)   = (d === 0 || d === 1) ? 1 : -1
```

Every turn lookup table this would otherwise need disappears. If you add a direction-dependent
behaviour, express it in this arithmetic rather than a `switch` — but note that the arithmetic
only holds for 0–3. Anything that may see a diagonal wants `turnKind()` / `axisOf()` instead.

`laneOffsetCoord` places a car on the right-hand side of its travel direction (right-hand
traffic), and `entryPoint` / `exitPoint` / `turnControl` give the three points of the quadratic
Bézier a car follows through a junction.

## Legal moves

`legalExits(dIn, i, j)` is the single authority on where a car may go. It enforces three things:

- **no U-turns** — which is why routing has to plan over *directed* states; see
  [gameplay.md](gameplay.md#routing)
- **no turn sharper than 90°** — which subsumes the U-turn, and rules out the 135° hairpin the
  [avenue](#the-diagonal-avenue) would otherwise offer
- **the map edge** — you cannot leave the grid
- **closed segments** — a road inside a park district genuinely does not exist, and neither does
  any diagonal the avenue did not put there

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

## Park districts close roads

A park district is **two adjacent blocks plus the road that used to separate them**, merged into
one solid green mass.

The first version left the road in place, which produced two parks either side of a street — still
the same repeating grid, just greener. Closing the segment is what actually breaks the rhythm.

The closure is real, not cosmetic. `setClosedSegments()` removes the segment from `legalExits`, so
traffic routes around it and the router plans around it for free.

This is the one generation step that can silently break the game, so the probe asserts two things:
no vehicle is ever inside a park's bounds, **and** all 5,184 `(approach, destination)` pairs remain
routable. Closing the wrong pair of roads could strand a corner of the city with no error at all.

Now that the city seed is random each load ([architecture.md](architecture.md#seeding)),
`main.js` runs `isCityConnected()` (grid.js) after every `createLayout` and rerolls the seed if
the directed state graph isn't strongly connected. Two BFS passes on 144 nodes — cheap, and it
never gets to spend time meshing a broken city.

> A known limitation: districts are pairs of blocks only. Larger ones would close more roads and
> need a connectivity guarantee stronger than the current all-pairs check.

## One junction is a roundabout

Same job as a park district — break the grid's rhythm — done to a junction instead of a block:
one interior junction per city trades its signal for a kerbed island that traffic orbits,
yielding on entry. `layout.js` picks it (never on an arterial, whose fast grain a near-stop
junction would undo) and `setRoundabout()` in grid.js makes it real, the same pattern as
`setClosedSegments()`.

The geometry falls out of the lane offsets: every entry and exit point of a junction sits at
`√(HALF_ROAD² + LANE²) ≈ 4.47` from its centre, so one circulating circle serves all four
approaches. `roundaboutPath()` builds the drive path — an entry arc tangent to the lane and to
the circulating circle (radius ≈ 11, which is what makes the deflection read as steering rather
than a kink), the circle itself at `ROUNDABOUT_R = 2.6`, and the mirrored exit arc. Right turns
return null: the ordinary near-corner Bézier never reaches the circle, so it already *is* the
roundabout right turn. Both the traffic model and the route band draw from this one function, so
they cannot disagree.

The placement draw is appended to the end of layout's rng stream on purpose — parks and
arterials on a given seed stay exactly where they were before the feature existed.

## The diagonal avenue

One street that ignores the grid: a 45° avenue running junction to junction across the middle of
the city, cutting the three blocks it crosses into flatiron slivers. It is a real road — traffic
drives it, the router plans down it, and it is the fastest way across town for any trip that runs
its way.

**Directions are now `0..7`.** 0–3 are the grid, unchanged: same numbers, same signs, same yaws,
so `rightOf`/`leftOf`/`opposite` mod-4 arithmetic still holds for every caller that used it. 4–7
are the diagonals, and they cannot join that arithmetic — `rightOf(4)` is meaningless. Anything
that has to classify a turn with a diagonal in it goes through `turnKind()`, which measures the
actual heading change and reduces to exactly straight/right/left on an orthogonal pair.

The rest is one idea: **an axis is a unit vector, not a choice between x and z.** `car.s` was
always a *signed coordinate on a travel axis* rather than a forward projection — which is how +X
and −X share one number line — so NE/SW and NW/SE each get a number line of their own and every
geometry helper generalises instead of branching:

| was | is |
|---|---|
| `isXAxis(d) ? p.x : p.z` | `alongAxis(d, p)` — projection on `axisVec(d)` |
| lane coordinate on the cross axis | `lanePoint(d, i, j, s)` — centre + axis·slide + right·LANE |
| entry/exit by axis swap | the same, off `lanePoint` |
| control point by axis swap | intersection of the two lane centrelines |
| `x\|d\|j` / `z\|d\|i` | `axisOf(d)\|d\|roadLineId(d, i, j)` |

Every orthogonal case comes out algebraically identical — asserted, not assumed.

**Turns are capped at 90°** (`MAX_TURN`). What that excludes is the 135° hairpin: the two
*backward* orthogonal exits from a diagonal approach, which are legal on the lattice and read as
a car changing its mind at speed. It is also why the avenue stops one junction short of the ring
corners — arriving at a corner on a diagonal, *both* remaining exits are hairpins, so the avenue
would dead-end there and strand every car that drove it.

**The road surface is free.** The slab under the whole city is already asphalt, so cutting the
block platforms out of the avenue's path *is* the road. Blocks are described by `block.polys` —
almost always the one rectangle they have always been, and on the three cut blocks the two
slivers left either side. Ground, buildings and props all lay out polygons now, so none of them
has to know the avenue exists.

> `isCityConnected()` counts eight directions since, and only over *arrivable* states — a state
> needs a road behind it to have been reached on. "At the map corner, heading south-west" has no
> road in and (both 45° exits leaving the map) no road out, so it fails a forward-reachability
> test it was never part of. The orthogonal version of that state happened to have an exit, which
> is why the old count of four never tripped on it.

> Also fixed here: `mulberry32`'s opening draw is barely mixed — over twelve ordinary seeds it
> came back above 0.5 ten times — so the avenue's coin flip, taken as the very first pull, gave
> every city the same one. The stream is warmed four draws before that bit is read. Nothing else
> in the project had made a one-bit decision on the first pull.

## Ground, buildings, props

| File | Produces | Notes |
|---|---|---|
| `ground.js` | asphalt slab, road surface, kerbs (`KERB_H = 0.35`), block tops, crosswalks | One merged mesh. Crosswalks are omitted at unsignalised junctions — a crosswalk implies a signal. |
| `buildings.js` | blocky towers | One merged mesh. Height ceiling is deliberately low; tall towers hid the taxi. |
| `props.js` | trees, lamps, street furniture | Merged per material via `bakeColor`, so hundreds of props cost one draw call. |

### The slab has rounded corners

The asphalt base is a `Shape` with true circular corner arcs rather than a plane, so the city reads
as an island instead of a sheet cut out with scissors.

`SLAB_RADIUS` has a hard ceiling around **27**: any larger and the arc bites into the corner where
the two outermost roads meet, leaving the ring road hanging over nothing. It is set to 22, which
leaves 2.2 units of clearance at the tightest point — the diagonal through a road corner at
`(±54, ±54)`. Change it and re-check that clearance.

All three use the same technique: generate small geometries, bake colour into vertex attributes
with `bakeColor()` from `util/geo.js`, then merge into a single non-indexed mesh with
`flatShading: true`. See [rendering.md](rendering.md).

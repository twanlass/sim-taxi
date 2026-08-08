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

## Ground, buildings, props

| File | Produces | Notes |
|---|---|---|
| `ground.js` | asphalt slab, road surface, kerbs (`KERB_H = 0.35`), block tops, crosswalks | One merged mesh. Crosswalks are omitted at unsignalised junctions — a crosswalk implies a signal. |
| `island.js` | the floating rock under the slab: earth lip, layered beds, keel | One mesh, ~2200 triangles, built from the same outline the slab is. |
| `buildings.js` | blocky towers | One merged mesh. Height ceiling is deliberately low; tall towers hid the taxi. |
| `props.js` | trees, lamps, street furniture | Merged per material via `bakeColor`, so hundreds of props cost one draw call. |

### The slab has rounded corners

The asphalt base is a rounded square — true circular corner arcs rather than a plane — so the city
reads as an island instead of a sheet cut out with scissors.

`SLAB`, `SLAB_RADIUS` and `slabOutline()` live in `grid.js` with the rest of the geometry
constants. The outline is a **single polygon serving two meshes**: `ground.js` fans it into the
asphalt cap, `island.js` hangs every stratum ring off it. They have to agree along the top edge
exactly or a hairline of sky opens between the road and the ground under it, so `probe.mjs` checks
that all 60 boundary vertices are shared rather than merely close.

`SLAB_RADIUS` has a hard ceiling around **27**: any larger and the arc bites into the corner where
the two outermost roads meet, leaving the ring road hanging over nothing. It is set to 22, which
leaves 2.2 units of clearance at the tightest point — the diagonal through a road corner at
`(±54, ±54)`. Change it and re-check that clearance.

### The city floats on a rock

`island.js` extrudes that outline downwards into about 33 units of banded earth: topsoil, earth,
clay, then alternating stone, closed off by a keel. Every band is a ring of points around the
outline, roughened with smoothed radial and vertical noise, and the wall between two rings is one
bed — so neighbouring beds share a boundary ring by construction and can't crack apart.

Three decisions carry the look, and all three are about **the lighting, not the geology**. At the
fixed 3/4 camera the sun sits behind the city, so every cliff face you can see is turned away from
it and is lit by the hemisphere fill alone — one flat warm brown:

- **Beds step in, they don't slope in.** A bed that tapers over its full depth ends up tilted past
  45°, where the fill is all it gets: measured off a render, the lower beds came back at about a
  fifth of their own albedo with every colour difference between them gone. Each bed instead hangs
  near-vertical and spends its taper on a short shelf at its foot, which also terraces the
  silhouette.
- **Beds are separated by value, not by hue.** Hue differences disappear under a flat warm wash;
  lightness differences survive. Hence a palette that alternates dark → light going down, and
  stone that is much lighter than a stone swatch wants to be.
- **A pale seam opens every bed**, and each bed fades light-to-dark down its own face. The seam is
  a *line* rather than a shading change, so it reads in shadow and at any time of day. The fade is
  the one place in the project where colour is interpolated across a face instead of flat-filled:
  it puts a hard light-meets-dark step at every boundary.

Two invariants keep it from tearing. `tuck()` clamps every ring inside the one above it — rings
carry up to 2 units of noise while the shallow beds step in by barely more, and a lump reaching
past its neighbour turns that bed's shelf inside out (bright shards on the corners). And the top
ring is the slab outline *exactly*: no scale, no noise.

The **lip** is the one ring allowed to grow instead of narrow: a strip of bare earth ringing the
tarmac at road level, 1.8 units wide. It exists for the phone. Portrait sizes the frustum by
height, so the city fills the frame and the only slab edge on screen is the far one — and a rock
hanging *under* the far edge is hidden behind the slab from this camera. The lip is the only thing
that says "ground" on the edge where thickness can't show.

All three use the same technique: generate small geometries, bake colour into vertex attributes
with `bakeColor()` from `util/geo.js`, then merge into a single non-indexed mesh with
`flatShading: true`. See [rendering.md](rendering.md).

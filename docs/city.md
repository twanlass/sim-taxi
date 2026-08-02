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

> A known limitation: districts are pairs of blocks only. Larger ones would close more roads and
> need a connectivity guarantee stronger than the current all-pairs check.

## Ground, buildings, props

| File | Produces | Notes |
|---|---|---|
| `ground.js` | road surface, kerbs (`KERB_H = 0.35`), block tops, crosswalks | One merged mesh. Crosswalks are omitted at unsignalised junctions — a crosswalk implies a signal. |
| `buildings.js` | blocky towers | One merged mesh. Height ceiling is deliberately low; tall towers hid the taxi. |
| `props.js` | trees, lamps, street furniture | Merged per material via `bakeColor`, so hundreds of props cost one draw call. |

All three use the same technique: generate small geometries, bake colour into vertex attributes
with `bakeColor()` from `util/geo.js`, then merge into a single non-indexed mesh with
`flatShading: true`. See [rendering.md](rendering.md).

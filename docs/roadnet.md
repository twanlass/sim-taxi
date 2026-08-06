# The road network

`src/city/roadnet.js` and `src/city/curves.js`.

This is the model the level editor is built on, and the reason a road can be a diagonal, a bend or
a roundabout rather than only a row or a column.

## Why the grid had to stop being the model

The grid in [city.md](city.md) is not a *starting point* other systems build on — it is baked into
the type of every value they pass around:

| Concept | Grid representation | What it can't describe |
|---|---|---|
| Intersection | integer pair `(i, j)` | a junction that isn't on a lattice |
| Direction | `d ∈ 0..3`, `rightOf(d) = (d + 1) % 4` | a road at 45° |
| Position along a road | `car.s`, a **world coordinate on the travel axis** | a curve, which has no axis |
| Lane identity | `car.laneKey = "x\|d\|j"` — one *infinite* lane per row | a lane that ends |
| Signal phase | `{ axis: 'x' \| 'z' }` | a three-way, or a five-way |
| Block | `blockBounds(bi, bj)`, a rectangle | anything a diagonal cuts in half |

So "support diagonals and roundabouts" was never a feature to add to the grid. It is a change of
representation, and this is it.

## The shape of it

Two things are authored. Everything else is derived:

```
nodes + edges  ──▶  lanes ──▶ turns ──▶ conflicts ──▶ signal phases
       │
       └──faces──▶ blocks
```

That derivation is the whole point. An editor that made you place lane geometry and signal timing
per junction would be unusable; one that only asks where the roads go is not.

| Thing | Is | Derived from |
|---|---|---|
| **Node** | a junction, at any position | authored |
| **Edge** | a two-way (or one-way) road, straight or a circular arc | authored |
| **Arm** | one end of an edge at a node, with its bearing | edges |
| **Lane** | a directed half of an edge — what cars drive | edge centreline, offset and trimmed |
| **Turn** | inbound lane → outbound lane across a node | the two lanes' tangents |
| **Street** | arms that carry on through a junction | arm bearings |
| **Phase** | turns that move together | streets |
| **Block** | buildable land | faces of the planar graph |

### Bearings replace the direction encoding

`rightOf(d) = (d + 1) % 4` becomes "the next arm clockwise". A turn's handedness is the sign of
`wrapAngle(bearingOut - bearingIn)`, so a three-way junction produces **two distinct left turns off
one approach** — a thing the modulo arithmetic could not express at all. On a perpendicular
four-way it degenerates to exactly the old behaviour, which is asserted rather than assumed.

### A junction is not a circle

The junction reaches `radius` from the node centre **along each arm**, and a lane is trimmed where
it crosses the plane perpendicular to *that* arm. This is not a detail: `entryPoint` in `grid.js`
puts a car `HALF_ROAD` along the axis while it sits `LANE` off the centreline, which is 4.47 from
the node centre, not 4. A circular boundary would have moved every entry and exit point in the city
by half a metre.

### Turn arcs are one rule now

The control point of a turn is where the two lane tangents cross. `turnControl` had a special case
— "same axis falls back to the midpoint" — which turns out to be just this intersection being
parallel. One rule covers a right turn, a left, a straight-through, and a sweep across a diagonal.

### Signals come out of the geometry

Arms that oppose each other pair into a **street**; each street becomes a phase, in bearing order.
On a four-way that is exactly the X phase and the Z phase `lightPhase` hard-codes. On a three-way
the stem gets a phase of its own. The 64% arterial green share and the platoon offset survive
unchanged — the offset is now *walked* along a chain of edges rather than read off an index, which
is the same number on a grid and a defined one anywhere else.

Turn **conflicts** (do two movements' paths cross? do they merge into the same lane?) are computed
once at bake. Nothing uses them for phasing yet — streets are enough for the shapes so far — but
they are what a genuinely irregular junction will need.

### Blocks are faces, not cells

The observation the editor rests on: **`ground.js` never draws roads.** The slab is asphalt and the
blocks are raised platforms on top of it, so roads are negative space. A block can therefore be
whatever the roads happen to enclose — a face of the planar graph, inset by half a road width.

Two things fall out for free:

- Closing a road **merges** two blocks into one. That is the park-district behaviour, which used to
  be special-cased in `layout.js` and is now just what the model does.
- Drawing a diagonal across a block **splits** it into two triangles, with no further authoring.

`insetPolygon` returns null for a face narrower than the roads around it, because a sliver between
two roads genuinely has nothing buildable on it.

## Curves

`curves.js` has exactly two kinds, because straight lines and circular arcs are closed under the
three operations a road needs: offset sideways, trim the ends, sample a point and heading. A line's
offset is a line; an arc's is a concentric arc.

Everything is parameterised by **arc length in world units**, not a normalised `t`. That is the
property `car.s` had for free by being a world coordinate, and the one thing that had to survive.

Bulge is the DXF convention, `tan(theta / 4)`, and **positive bends right** — matching the sign of
a bearing delta everywhere else. Two traps, both of which bit:

- The centre offset must be `(chord / 2) · (1 - b²) / 2b`, not `radius · cos(theta / 2)`. They have
  the same magnitude, but the latter is *even* in theta, so a negative bulge put the centre on the
  wrong side of the chord and the arc ended nowhere near its own endpoint.
- Offsetting an arc **right** shrinks the radius on a right-bending arc and grows it on a
  left-bending one — the tangent is `sign · (-sin a, cos a)`, so its right normal is the *inward*
  radial for a positive sweep.

### A one-way road's lane is its centreline

A two-way road's lanes sit `LANE` either side of the centreline. A one-way road has one lane and it
runs *down* the middle. Offsetting it anyway pushed a roundabout's circulating lane two metres off
its own island.

## Equivalence with the grid is the safety net

`roadNetFromGrid(layout)` builds the shipped 5×5 city in this model, and `tools/roadnet.mjs`
asserts it against `grid.js` and `lightPhase` numerically at **1e-9** — node positions, lane
centres, junction entry and exit points, turn control points, legal moves, which junctions are
signalised, and the signal state sampled every 0.1s across a full cycle.

This exists so that porting traffic, routing and meshing onto the network is a change *with a
control*. Without it, a car behaving differently afterwards could be a porting bug or could be a
city that quietly moved, with no way to tell which.

### Two differences, on purpose

Both are reported by the tool rather than asserted away:

1. **A green wave measured along a surviving chain.** Where a park closure cuts an arterial in
   half, the grid still measures a platoon's travel from the map edge along the whole line; the
   network measures it along the chain that still exists. A wave cannot propagate across a road
   that isn't there, so the network's answer is the better one. ~3 junctions per seed.
2. **No signal where there is nothing to arbitrate.** Closures can leave an interior junction with
   only a straight-through. The grid decides signalisation from `(i, j)` alone, so it keeps cycling
   a light there and holds cars for a phase nobody can be in. The network drops the signal. Rare —
   about one junction in twelve seeds.

The tool *proves* each difference is one of these two (a truncated chain, or fewer than two
streets) rather than trusting the count, so a genuine bake bug still fails.

## Who consumes it

`createLayout` bakes the network for the city it has just decided and installs it as *the*
network — it is the one place that has the closures, the arterials and their coordinated
directions all in hand. Everything else asks `cityNetwork()` rather than being handed one.

`src/game/route.js` plans over it: search states are lanes, successors are `lane.onward`, and cost
reads `lane.klass`/`lane.withWave`. See [gameplay.md](gameplay.md#routing). It still returns grid
directions, because the sim still stores `car.d`.

## What isn't done yet

`traffic.js`, `ground.js` and `police.js` still read `grid.js`; porting them is the next step, and
the deepest part of it is car-following — `laneKey` is one infinite lane spanning the city, so a
car sees its leader for free, and per-edge lanes break that at every junction.

A roundabout is currently expressible — a ring of one-way arcs, asserted to circulate and to let
cars off at every spur — but as an assembly of ordinary nodes rather than a single primitive, and
entry is unsignalised rather than yield-controlled. `node.kind` carries `'roundabout'` for the day
that changes.

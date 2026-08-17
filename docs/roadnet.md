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

**And the radius is per-arm, derived rather than authored.** How far you must go down an arm to be
inside the junction is how far it takes to clear the carriageways that *cross* it — so a divided
arterial (`edge.halfWidth`, [city.md](city.md#divided-arterials-and-the-planted-median)) holds every
side street that meets it 5.33 back while entering those same junctions no earlier than before. Two
things the derivation must not do, both of which bit:

- **Don't count the arm opposite.** That is the same road carrying on through, and taking its
  half-width makes a wide road hold *itself* back at its own junctions — every entry and exit point
  on an arterial off by 1.33.
- **Don't assume the crossing is perpendicular.** A road meeting at angle θ presents a strip
  `halfWidth / |sin θ|` long down this arm. That is the perpendicular case at 90°, and it is why a
  diagonal junction is a longer box than a square one.

On a city of uniform 8-unit streets every arm comes out at `HALF_ROAD`, which is exactly the old
scalar radius — asserted, not assumed. A node may still name a `radius` in the spec, and an
authored one wins on every arm.

### Turn arcs are one rule now

The control point of a turn is where the two lane tangents cross. `turnControl` had a special case
— "same axis falls back to the midpoint" — which turns out to be just this intersection being
parallel. One rule covers a right turn, a left, a straight-through, and a sweep across a diagonal.

### Signals come out of the geometry

Arms that oppose each other pair into a **street**; each street becomes a phase, in bearing order.
On a four-way that is exactly the X phase and the Z phase `lightPhase` hard-codes. On a three-way
the stem gets a phase of its own. Streets that carry a phase now split the green evenly — an
arterial's old 64% share went when its lights did — and the platoon offset survives unchanged,
except that it is now *walked* along a chain of edges rather than read off an index, which is the
same number on a grid and a defined one anywhere else.

Turn **conflicts** (do two movements' paths cross? do they merge into the same lane?) are computed
once at bake. Two things read them, and neither is the phase generator — streets are enough for the
shapes so far:

- `bakeSignals` drops the light where *nothing* at a junction conflicts (the ring's corners — see
  [traffic.md](traffic.md#the-corners-and-why-they-are-not-a-special-case)).
- the sim refuses entry to a box where a **conflicting movement is already running**
  (`boxConflict`, [traffic.md](traffic.md#nobody-drives-through-the-box)). That is the one that had
  been missing: signals arbitrate a street at a time and say nothing about who is inside the
  junction right now.

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

The inset is **per side**, since the roads round a face are no longer all the same width. Each
vertex is stamped during the traversal with the width of the road leading away from it, because
that is the one place the edge behind a side is known for certain. Deriving it back out of the
geometry afterwards does not work: a merged face side has a node sitting mid-way along it, so
"nearest centreline to the midpoint" lands exactly on a junction where the crossing road is also at
distance zero, and the tie goes to whichever edge happened to be created first — one district face
per seed inset by 4 instead of 5.33.

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

A two-way road's lanes sit `edge.laneOffset` either side of the centreline — `LANE` on an ordinary
street, further out on a divided arterial, where the gap between them is the median. A one-way road
has one lane and it runs *down* the middle. Offsetting it anyway pushed a roundabout's circulating
lane two metres off its own island.

## Equivalence with the grid is the safety net

`roadNetFromGrid(layout)` builds the shipped 5×5 city in this model, and `tools/roadnet.mjs`
asserts it numerically at **1e-9** — node positions, lane centres, junction entry and exit points,
turn control points, legal moves, which junctions are signalised, the signal state sampled every
0.1s across a full cycle, and the routes the router returns for all 5,184 (start, heading, target)
triples.

It compares against **frozen copies** of the grid router and the analytic signal model, kept in the
tool, rather than against the live ones. That is not tidiness: `route.js` and `traffic.js` are now
network-backed, so importing them would have the network agreeing with itself. A `frozen signal
constants agree` check keeps the copies honest against `SIGNAL_DEFAULTS`, and the copies go when
there is nothing left to be a control for.

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

`src/sim/traffic.js` drives it: a car is a lane plus an arc length along it, junction geometry is
the lanes' own endpoints and the turn's control point, and turn handedness comes off `turn.hand`.
See [traffic.md](traffic.md#where-a-car-is), especially the note on car-following, which is the one
thing the old infinite-lane model got for free.

`src/sim/traffic.js` also takes its **signals** from here, per approach, via `net.laneSignal(lane,
t)`. Both intended differences are live: see [traffic.md](traffic.md#signals). Validated by a
frame-for-frame checksum — on a city seed where no phase drifts (103300) the sim is bit-identical
before and after the switch, so everything that *does* differ differs for the one documented reason.

## What isn't done yet

**`ground.js` still meshes from `blockBounds`** rather than from the faces this module already
computes, and **`police.js`** still describes its corridor as an `{axis, line}` pair rather than a
path through the graph.

The grid-shaped view a car still carries (`car.i`, `car.j`, `car.d`) exists for those three plus
`fares.js` and the probe. `net.dirOfLane` is the single point where it is derived, so it is also
the single thing to delete.

A roundabout is currently expressible — a ring of one-way arcs, asserted to circulate and to let
cars off at every spur — but as an assembly of ordinary nodes rather than a single primitive, and
entry is unsignalised rather than yield-controlled. `node.kind` carries `'roundabout'` for the day
that changes.

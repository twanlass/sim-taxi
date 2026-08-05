# Rendering

Three.js r0.180. **Zero external assets** — every mesh is generated in code, there is no loader,
no texture and no model file.

## The low-poly look

Three things produce it:

1. **Non-indexed geometry + `flatShading: true`.** Shared vertices would smooth normals across
   faces; keeping geometry non-indexed is what gives every facet its own hard edge.
2. **Baked vertex colours.** `bakeColor()` in `util/geo.js` writes a colour into a geometry's
   vertex attribute before merging. Hundreds of props with dozens of colours then collapse into
   **one mesh with one material**, because colour rides in the geometry rather than the material.
3. **Position-keyed jitter.** `jitterVertices()` displaces vertices keyed on their **position**,
   not their index.

> That last point was a real bug. `IcosahedronGeometry` is non-indexed, so a shared corner appears
> as several separate vertices. Jittering per-index pushed each copy a different way and tore the
> tree canopies open. Keying on position keeps the surface welded.

`palette.js` holds every colour in the game by name, plus `jitterColor()` for per-instance
variation. New colours belong there, not inline.

## Camera

`src/game/camera.js`. A fixed 3/4 orthographic camera:

```js
VIEW_DIR = (1, 0.92, 1)   // looking down the +X+Z diagonal
DISTANCE = 400
zoom     = 52             // vertical world span is exactly 2 * zoom
```

No zoom, and one fixed default framing — that's a gameplay decision, not a limitation. A fixed
frame is what makes every tap unambiguous and lets the whole city stay on screen.

**Two things override the fixed framing**, both by smooth-following the taxi and both on narrow
viewports only. `controller.followXZ` in `camera.js` closes a fraction `1 - exp(-dt * rate)` of the
gap per frame toward the taxi's `(x, z)`, so the chase is framerate-independent and lags just enough
that the car reads as leading the camera. Neither has a gate on the way *out*: the camera is left
wherever it landed rather than snapping back.

- **The opening follow**, at rate **1.5**. A run starts with the camera trailing the taxi and keeps
  doing it until the player takes the framing over — a swipe past `PAN_SLOP`, or a tap on a
  rider-finder chip. It exists for the same reason drag-to-pan does: in portrait the fixed framing
  has already given up, so a run otherwise opens with the taxi off-screen and the player's first job
  is hunting for their own car. Gentler than the boost chase because it is ambient and runs for as
  long as it is left alone — at 1.5 the camera drifts after the taxi rather than locking to it, and
  a turn at the edge of frame doesn't whip the city round.
- **Loco Mode**, at rate **3.2**, which outranks it. Active only while `boost.isActive()`, and it
  ignores the player's takeover: a drag during boost is quietly overridden on the next frame, because
  panning is a planning gesture and boost is the opposite.

`attachDragPan` reports the takeover through an `onPan` callback, fired once per gesture on the frame
it crosses the slop — the same boundary that separates a tap from a drag. Both halves are asserted
headless in `tools/probe.mjs` against a stub element: a few pixels of finger travel must leave the
camera alone, and a real swipe must report exactly once.

Desktop gets neither. The whole city is in frame at all times there, and drag-to-pan is switched off
above `NARROW_VIEWPORT` — so a follow would slide the map around under a player with no way to stop
it.

**Drag-to-pan is the one concession**, and a phone is what forced it: the frustum is sized by
*height*, so in portrait the city runs off both sides and half the fares spawn where you cannot
see them. `attachDragPan` only treats a press as a drag once it has moved `PAN_SLOP = 8px` — below
that it stays a tap, because on a phone every selection lands with a few pixels of finger travel
and a camera that answers all of it slides the map every time you pick a fare. It reports
`didPan()` so the picker can swallow the click that closes out a drag, and it clamps the target to
`HALF_SPAN`, so the map can never be pushed off screen with nothing left to steer back by.

The `VIEW_DIR` diagonal has consequences elsewhere: screen-up is world `(-1, 0, -1)`, which is why
the timer ring starts its sweep at `-3π/4`, and why riders are placed on the `-X-Z` kerb of a
junction — the block on the `+X+Z` side sits between the camera and anything standing on it.

Because the camera is orthographic, world-units-per-pixel falls straight out of the frustum
height: `(2 * zoom) / clientHeight`. Drag-panning converts pointer pixels into world units with it
(`camera.js`). The route band used to as well, to hold a constant 2px width; it no longer does,
because it is now paint on a lane and has to shrink with the road when you zoom out.

> This also explains why an early "invisible" skid mark wasn't invisible at all — it was 0.3 units
> wide, and at play zoom 1 unit ≈ 7.7px, so it rendered as 2px. Effects that need to *read* at play
> zoom must be sized against the camera, not by eye in a close-up.

## Lighting

`src/game/scene.js` returns `{ scene, sun, hemi, sky }`:

- **`sun`** — a directional light with shadows (`PCFSoftShadowMap`)
- **`hemi`** — a hemisphere light for ambient fill
- **`sky`** — the *material* of a sky dome, whose `topColor` / `bottomColor` uniforms are the only
  handle on sky colour

The default is golden hour: 16:24, sun 28.5° up, `#FFDEBB` at 3.55 intensity.

## Day/night cycle

`src/game/daylight.js` owns the hour → lighting curve. **Currently switched off by default** —
`main.js` calls `setCycling(false)`, so the game sits at the fixed golden hour above. The ⚙️ panel
turns it on.

`createDaylight({ sun, hemi, sky })` gives you `apply(hour)`, `update(dt)`, `setCycling`,
`setDayLength`. One full day takes `DAY_SECONDS = 180` by default.

**Eight keyframes** (midnight, pre-dawn, sunrise, morning, noon, golden, sunset, dusk) are lerped
for sun colour, intensity, ambient fill, hemisphere sky/ground and both sky uniforms. Keyframes
rather than a formula because a smooth analytic curve spends most of its range on a flat blue
afternoon and rushes the two minutes that actually look like something.

Sun elevation follows a day arc and azimuth swings 10° → 175°, so shadows sweep across the city.
**Elevation clamps at 6°** — at night intensity is 0 anyway, and a light below the ground plane
throws shadows up through everything.

Night is genuinely dark (sun 0.00, fill 0.34, deep navy) but stays playable because every game
marker — fare rings, rider meters, route band — is unlit (`MeshBasicMaterial`, or in the band's
case a plain `ShaderMaterial` that never reads a light).

Screenshot mode freezes the cycle: a rendered shot has to be reproducible.

## Effects

### Skid marks — `game/skidmarks.js`

A ring buffer of flat quads stamped onto the road while boosting **through a corner**, and for the
first `LAUNCH_SKID_TIME = 0.5s` **off the line** when Loco Mode is first pressed. Alpha lives in a
4-component vertex colour attribute. Pure black, `MARK_LENGTH = 1.5`, `MARK_WIDTH = 0.58`,
`START_ALPHA = 0.85`, spaced closer than one mark length so stamps overlap into a streak.

> `car.state === 'turn'` covers **every** junction crossing including going straight on, which is
> why rubber first appeared on the straights. A real turn is `car.dOut !== car.d`, and only after
> the straight run-up (`leadIn`) is done.

> The launch streak is **time**-boxed while the spacing between stamps is **distance**-boxed.
> Distance-boxing the window too would let a press at a red light bank the streak and spend it
> whenever the light changed. `kickLocoMode` also stamps one pair directly, so a standing start
> leaves a patch under the wheels before the car has travelled far enough to trigger the next
> stamp. Releasing mid-launch cuts it short — `car.boost` gates it exactly as it gates the corners.

### Dust — `game/dust.js`

An `InstancedMesh` of **squashed low-poly spheres** (`IcosahedronGeometry(0.5, 0)` — 20 faces, so
the facets show), scaled `(w, 0.55, 1)` so a puff spreads over the road rather than balling up, with
per-puff aspect and a slow tumble. Lit with `MeshLambertMaterial` + `flatShading`, so it picks up
the same sun as the cars.

Emitted whenever the taxi is boosting *and moving* — not only in corners like the rubber, since the
point is to make speed itself read.

> Per-puff alpha needs a custom `aAlpha` instanced attribute plus a three-line `onBeforeCompile`
> patch multiplying it into `gl_FragColor.a`. `instanceColor` cannot carry it: it is RGB only, and
> a 4-component colour attribute triggers `USE_COLOR_ALPHA` and a different code path.

An earlier version used camera-facing billboards. They sat in the same plane as the road and read
as flat stickers next to the faceted cars.

### Loco Mode kickoff — `game/flames.js`, plus a wheelie in `sim/traffic.js`

Two effects on the press that first engages Loco Mode. Fired from `kickLocoMode()` in `main.js`
only when `boost.press()` returns true — the ready→active transition — so a re-press during a
running boost doesn't re-fire either.

- **Tailpipe flame.** One-shot `InstancedMesh` burst of additive-blended orange motes, emitted
  from the taxi's rear bumper (`TAXI_TAILPIPE_BACK` / `TAXI_TAILPIPE_HEIGHT` exported from
  `geometry/taxi.js`) shooting backwards along `-yaw`. Short-lived (~0.38s), grows fast, air-brakes
  quickly; alpha snaps to 1 then eases out. Additive blend so it *brightens* the road behind it
  rather than reading as an opaque decal.

- **Wheelie pop.** A hand-shaped bump on `car.pitch` — sine ease-out to peak by t=0.28,
  smoothstep back to zero — layered on top of the pitch spring. Handled outside the spring
  because the spring is calibrated for tiny suspension travel; a 15°+ pop through it would either
  be swallowed by damping or need a wildly out-of-scale impulse. Lift compensation reuses the
  same `Math.abs(Math.sin(pitch)) * (CAR_LEN / 2)` so the rear stays on the road as the nose
  comes up.

### Wreck — `game/debris.js`, `game/vanish.js`, plus flames/smoke/sparks

The crash is a stack of the effects above fired at two points at once — one per car, since a crash
now destroys both. Debris runs a **pool per car** (a pool re-shoots its own pieces, so sharing one
would yank the taxi's wreckage across to the other car's), and the victim's pool is repainted at
burst time in that car's colour.

`vanish.js` owns the disappearance: each shell shrinks and fades into its own fireball over 0.34s
of sim time rather than being switched off. It steps on the frame's already-slowed `dt`, so it
runs at the same rate as the debris and smoke through the crash slow-mo. See
[traffic.md](traffic.md#the-wreck) for the rest of the staging.

### Route band — `game/routeline.js`

A band of paint down the **lane the taxi will drive**, from just ahead of the car to its
destination: lane width (0.85 of it), the taxi's yellow at 0.38 alpha. Shown only while the taxi
has a pending target — the route is a property of the *selection*, not of the world. Once planned
it does **not** re-path as the taxi drives; a line that keeps changing under you is unreadable.

There used to be a yellow pool on the road under the taxi marking it as selected. It is gone: the
taxi is permanently selected and there is only one of it, so the pool labelled something that was
never in question — and sitting directly under the band in the same yellow, it read as the band
leaking out around the car.

It was a 2px hairline down the road *centreline* first, and that was wrong twice over:

- A route drawn on the centreline sits **between** the two lanes, so it never says which side of
  the road the taxi is on — the one thing a driving line is for.
- It was filleted against the taxi's **own position**: the corner radius at the next junction was
  clamped to half the distance to the car, so the drawn corner shrank and re-shaped as the taxi
  closed on it. That squirm is what the band exists to remove.

`routePath(car, route)` now walks the same lane centrelines and the same junction Béziers the car
itself drives — `entryPoint` → `turnControl` → `exitPoint` from `city/grid.js`, and for a car
already mid-junction it picks its own arc up at `car.turnT`. **Nothing ahead of the car depends on
where the car is**, so the band only ever gets shorter from behind. `tools/probe.mjs` asserts
exactly that: every point of every later path still lies on the path drawn when the route was
planned, measured at a max drift of **0.021 units** over 2,175 frames of a cross-town route — and
that drift is bezier re-sampling, not motion.

The start point is the **lane** position rather than `car.x/car.z`: the taxi weaves inside its lane
in Loco Mode, and the band belongs to the lane, not to that manoeuvre.

**Width is 0.85 of a lane, not a full one.** A right turn's lane-to-lane arc has a radius of
`HALF_ROAD - LANE` = 2, so at a half-width of 2 the inside edge of the band collapses to a point at
every right turn and folds over itself — and a translucent band folded on itself paints a visibly
darker wedge. 0.85 leaves 0.3 units of inner radius and 0.3 of asphalt showing at the kerb, which
reads as *in* the lane rather than *instead of* it.

**The head end holds off, then fades in; the tail just fades.** A hard end at the taxi reads as a
second object butted against the car; a hard end at the destination reads as a wall across the
road. But a fade alone still starts *under* the car, and paint emerging from under the bumper reads
as something the taxi is dragging rather than something it is about to drive over — so nothing is
drawn for the first `HEAD_GAP` = 4 units, then it fades up over 6. The taxi's nose is
`(CAR_LEN / 2) * TAXI_SCALE` ≈ 2.0 units ahead of the point the path measures from, so that leaves
a clear couple of units of bare road in front of the car. Tail fade is 10 — half a block.

On a hop shorter than the gap and the two fades together (one block is 20 units, they total 20)
all three scale down in proportion, rather than overlapping into a band that never reaches full
opacity anywhere — or one the gap swallows whole.

The fade is a **`ShaderMaterial` with a distance-along-the-path attribute**, evaluated per fragment.
Per-vertex alpha would mean re-tessellating the path at both fade boundaries every frame (and, as
with `instanceColor`, a 4-component colour attribute takes a different code path); one float per
vertex interpolates the length of a 20-unit straight for free. The fragment shader has to
`#include <colorspace_fragment>` by hand — a `ShaderMaterial` gets none of the built-in chunks, and
without it the yellow renders linear and lands visibly darker than every `MeshBasicMaterial` marker
beside it. It runs *before* the premultiply below, because premultiplied colour is not in a colour
space any more and converting it is wrong by however much alpha isn't 1.

**Blend mode is switchable** — `additive` (the default), `normal`, `screen`, `multiply` — from the
⚙️ panel live, or pinned for a screenshot with `?blend=<name>`. The road is dark, and a flat
`normal` wash over it flattens the markings, crosswalks and kerbs the band crosses; the other three
let what is underneath come through to different degrees, `additive` by brightening rather than
covering. Which one is right is a judgement call about the whole frame, which is why it is a
control rather than a constant.

The shader writes **premultiplied** colour so `additive` and `screen` are alpha-weighted rather
than blowing out at full strength. `multiply` is the exception and shapes its own output —
`mix(white, colour, alpha)` against a `dst * src` blend — because premultiplied black at low alpha
would paint a hole rather than tint the road.

Unlike the fare rings the band is **depth-tested**, at y = 0.03: above the road paint (0.02), below
the cars (0.04), and so *under* passing traffic. At 2px a route drawn over the cars didn't matter;
at lane width it would paint yellow across every car it passes.

The band still offsets each *point* along its mitre rather than offsetting each segment
independently. Independent segments leave a wedge of bare road on the outside of every join —
invisible when the corner *was* the notch, obvious across a ten-step arc.

### Pin outline and bounce — `geometry/marker.js`

The destination pin is a **floating head and nothing else** — an octahedron at y = 9.6 over the
target ring on the kerb. It stood on a gold post until that shaft was cut; the head alone is the
cleaner read and it is what the eye tracked anyway. The head kept its height, so the marker still
occupies the same slot in the skyline and no framing moved.

The head is outlined by an **inverted hull**: the same geometry drawn a little larger
with `side: BackSide` and a black basic material, so the enlarged back faces sit behind the real
surface everywhere except around the silhouette. Cheaper than a post-processing edge pass and it
needs no render targets — this is one small object, not a whole-scene effect. Each hull is a *child*
of the mesh it wraps, so it inherits animation for free.

**The pin has two colours, and the difference is whether you have answered it.** There is only ever
one drop-off on the board — the rider currently aboard — so there is nothing for a per-fare hue to
tell it apart from, and the one thing worth saying about it is its own state.

| State | Head | Ring on the tarmac |
|---|---|---|
| Untapped — the taxi is parked, waiting to be told where to go | `#17C8B8` teal | `#5FE9DC` |
| Tapped — the taxi is on its way | `#F5C130` | `routeLine` `#FFE873` |

Teal because a drop-off appears the instant a rider boards, and at that moment it is a *question* —
`parked` holds the taxi at the kerb until the pin is tapped, so a marker already wearing the taxi's
colour would be claiming an instruction nobody gave. It is also the one clear hue left after the
signals, the taxi's yellow and the white of an unclaimed passenger, and far enough from the
`#2F8F94` traffic car to never be mistaken for one at play zoom.

Yellow is the answer: the taxi's own colour, so the moment the player commits, the pin joins the
same "this is the job" statement the car and the route band are making. The selected ring is exactly
`routeLine`, the paint the band running into it is drawn in, so the band and the disc it lands in
are one mark rather than two yellows meeting at the kerb. The change is also the *acknowledgement* —
on a phone the band can be drawn entirely off-screen, and the pin is what the finger was already on.

`createDestinationPin().setSelected()` swaps all four colours (colour and emissive on the head, rim
and fill on the ring) and early-outs on no change; `fares.js` reconciles it against `directed`
every frame the way it does the rider's meter ring, and pushes it in `markDirected` so the pin turns
on the same frame as the band. The off-screen pointer follows the same rule — see the CSS for
`#dropoff-indicator.is-selected`.

The fare's own colour still lives on the taxi's roof sign — see
[gameplay.md](gameplay.md#fare-colours). `?shot=10` frames the untapped state, which no other shot
can show: every other carrying framing sends the taxi on at pickup, and that is what turns the pin
yellow.

The head carries an **emissive** at 0.35 of its colour. The fixed camera sees the face turned *away*
from the sun, and pure Lambert on its own shades that face a long way down — the lift keeps the
crystal reading as its own hue rather than as a dark facet.

The head bounces on `Math.abs(Math.sin(t * 3.4)) * 0.45`: never below the rest position, with a
sharp cusp at the bottom that reads as a landing rather than a float. The amplitude used to be
bounded by the 0.8 units of overlap between head and post top; with the post gone nothing constrains
it but taste, and 0.45 is what the motion was tuned at. It freezes while hidden, which keeps
screenshots deterministic.

The drop-off's target ring is **filled in**, at the route band's own `ROUTE_OPACITY` — the band on
the road and the disc at the end of it are one statement in two places, and at different weights one
reads as the louder half. Depth-tested like the band, so a car crossing the junction drives over the
disc rather than the disc painting across the car. Being translucent puts it in the transparent
queue, which used to wash its far half up over the base of the post at its centre; with the post
gone nothing stands in the disc for it to wash over.

### Rider meter — `geometry/ridermeter.js`

The urgency and distance bars over a waiting rider. What they *mean* is in
[gameplay.md](gameplay.md#the-meter-over-a-waiting-rider); this is how they are drawn.

The plate is a **billboard against a camera that never rotates**, so its orientation is one
constant `Quaternion` resolved from the exported `VIEW_DIR` at module load — not a `lookAt` run
every frame on three floating meters.

**The layout is specified in pixels**, and converted once at the top of the module: 1 world unit is
about 7.7px at play zoom, since the orthographic frustum's height is exactly `2 * zoom`. The whole
meter is 84 × 34px as specified, which a `SCALE = 0.8` on the group takes to **67 × 27px** — still
over the ~25px timer ring that is the project's floor for "legible without zooming", and it needs
to be, because it is now the only thing marking a rider at range. Full size was accurate to the
sheet and too loud: three of them is three slabs over a city whose blocks are only ~92px across.
The scale is a group transform rather than a smaller `PX`, so the geometry still matches the spec
one-to-one and there is a single knob to turn.

Nothing about the layout ever changes size — always four urgency segments and three distance ones,
lit or not — so the meter is **three shared geometries** (plate, urgency segment, distance segment)
and per-frame work is a colour copy. Each is built at its own size rather than scaled from one unit
shape: scaling a rounded rect stretches its corners, and at a 2px radius on a 16px segment that is
the difference between a soft edge and a visibly lopsided one.

Every layer is `transparent`. The plate genuinely is (0.75 alpha), which puts it in three's
transparent queue — and that queue draws after every opaque object regardless of renderOrder, so
opaque segments would be buried by their own backing. Flagging both puts them in the same queue,
where renderOrder decides.

### Car motion

Cars get a subtle vertical bounce while driving and **roll into corners** for weight. The roll is
applied with a compensating lift:

```js
lift = Math.abs(Math.sin(roll)) * (CAR_W / 2)
```

Without it, leaning pushes the outer wheels underground. The taxi's ground disc is *not* rolled
with the body — it used to be, and tilting it into the road caused z-fighting.

## Debug panel

`src/game/debugpanel.js`, behind the ⚙️ button top right. Split by cost:

- **Live** — day cycle on/off, day length, time of day, sun colour/strength, ambient fill, fare clock
- **Restart to apply** — car count (writes a URL parameter and reloads)

Pretending a rebuild-only value is live would just show a slider that silently does nothing.

Touching any lighting control stops the day cycle, rather than letting the next frame overwrite the
change. **Copy settings JSON** exports the live values (not the slider positions, so manual
overrides are captured) for pasting back as new defaults.

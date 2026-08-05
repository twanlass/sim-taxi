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

`src/game/scene.js` returns `{ scene, sun, moon, hemi, sky }`:

- **`sun`** — a directional light with shadows (`PCFSoftShadowMap`)
- **`moon`** — a second directional light, off all day, **no shadows**
- **`hemi`** — a hemisphere light for ambient fill
- **`sky`** — the *material* of a sky dome, whose `topColor` / `bottomColor` uniforms are the only
  handle on sky colour

The default is golden hour: 16:24, sun 28.5° up, `#FFDEBB` at 3.55 intensity.

**Fog is off by default** and exists only while the weather says so — see [the weather](#weather).
The old note here said fog was unusable on an orthographic camera. That was half right: three's
fog is a function of view-space depth, and this camera stands a fixed 400 units back, so a range
anchored near zero really does wash the whole city out evenly. But the city is ~140 units across
the view diagonal, so depth genuinely varies 400 ± 70 — and a range written *relative to the
standoff distance* fades the far edge and leaves the near one clear. That is exactly the depth cue
that was thought unavailable, and `CAMERA_DISTANCE` is exported from `camera.js` so the range can
be written against it.

### The moon

Night used to be lit by the hemisphere fill alone, and a hemisphere light has no direction to
speak of: every roof, road and car took the same flat wash and the city became a silhouette. The
moon gives every surface a lit side again.

It **casts no shadows**, deliberately. A second shadow map is a second depth pass every frame for
the twelve hours a day it contributes nothing to, and toggling `castShadow` to dodge that
recompiles every material in the scene at dusk. Shadowless is also the better look — moonlight is
diffuse, and hard black shadows at 0.9 intensity read as a second sun.

Its arc is **on the same side of the sky as the sun**, sweeping the other way: 85° → 15° azimuth,
22°..48° elevation. That is not astronomy, it is the fixed camera. This view stands at
(+X, +Y, +Z) and sees each building's +X and +Z faces, and the sun's 10°→175° azimuth rakes
exactly those. The first version put the moon opposite the sun, where a moon belongs — and lit
every face the camera cannot see. The night render came back as black buildings standing in bright
pools of street light. `tools/sky.mjs` now asserts the moon direction against the visible face
normals rather than against an elevation angle, because the elevation was never what was wrong.

## Day/night cycle

`src/game/daylight.js` owns the hour → lighting curve. **It runs by default** — the night end of
it now has moonlight, lit windows, street lamps and headlights to see by, which is what it was
waiting on. `?hour=13.5` parks it, and the ⚙️ panel stops it.

`createDaylight({ sun, moon, hemi, sky })` gives you `apply(hour)`, `update(dt)`, `look()`,
`lit()`, `setCycling`, `setDayLength`, `setLookFilter`. One full day takes `DAY_SECONDS = 180`.

**Nine keyframes** (midnight, pre-dawn, sunrise, morning, noon, golden, sunset, dusk, midnight)
are lerped for sun colour and intensity, **moon intensity**, ambient fill, hemisphere sky/ground,
both sky uniforms, and `lit`. Keyframes rather than a formula because a smooth analytic curve
spends most of its range on a flat blue afternoon and rushes the two minutes that actually look
like something.

Sun elevation follows a day arc and azimuth swings 10° → 175°, so shadows sweep across the city.
**Elevation clamps at 6°** — at night intensity is 0 anyway, and a light below the ground plane
throws shadows up through everything.

`lit` is its own keyframe rather than something derived from `power`, because *when a city
switches its lights on* is a look decision, not a function of the sun. It is still 0.35 at sunrise
and 0.45 at sunset: lights outlast dusk in both directions, which is what makes the two
transitions read as transitions rather than as a switch throw. One number drives three consumers —
the windows and street lamps, every car's headlights, and the cruiser's.

### The visibility floor

```js
export const VISIBILITY_FLOOR = 1.05;   // as sun + moon + ambient fill
```

A playability constant, not an aesthetic one. You steer this game by tapping things on a map, so
"you can't see the road" is a lost run rather than a mood. Every darkening influence is a
*multiplier* — the night keyframes, an overcast sky, a downpour, fog — and multipliers compose, so
`apply()` enforces the floor **after** the weather has had its say and tops up the ambient fill if
the total came in short. Fill rather than sun or moon, because it is the one term that can be
raised without also moving the shadows or the colour of the light.

It is a backstop, not the design: `tools/sky.mjs` checks both that nothing can get under it *and*
that an ordinary midnight downpour clears it without the clamp doing any work.

Night is genuinely deep in colour and nowhere near black in level. Every game marker is unlit
anyway (`MeshBasicMaterial`, or the route band's plain `ShaderMaterial`), and the ones the player
has to *find* — the fare clock, the rider's meter, the destination pin and its ring — also set
`fog: false`, so the weather can never take them.

### Sky colour space

The sky dome is a raw `ShaderMaterial`, and it was writing linear colour straight to an sRGB
framebuffer: `new THREE.Color('#8CC4E8')` converts sRGB → linear on the way in, and nothing
converted back on the way out. Every sky in the game rendered darker and more saturated than the
hex it was written as. It only became obvious once the cycle ran by default — sunset's `#F09A60`
came out as rgb(222, 82, 29), and since this camera looks *down*, almost the whole visible dome
sits within a few degrees of the horizon where the gradient is ~80% `bottom`, so dusk filled the
entire frame with brick red.

`#include <colorspace_fragment>` fixes it, exactly as in `routeline.js`. The daytime keyframes were
then rewritten to the hexes that reproduce the sky the game actually shipped (`#8CC4E8` → `#438DCE`,
`#DCEDF7` → `#B7D8ED`): **the pixels are unchanged, the numbers now describe them.** Sunrise and
sunset were retuned properly, since neither had ever been on screen.

## Weather

`src/game/weather.js`, with the particles in `src/game/precip.js`. Five kinds — `clear`, `cloudy`,
`fog`, `rain`, `snow` — walked by a clock that holds one for 30–70s and then blends to the next
over 12s.

It sits **on top of** the day/night cycle rather than beside it. `daylight.setLookFilter()` hands
weather the sampled look for the current hour on its way to the lights, and `modify()` multiplies
the sun down, pushes the sky toward a tint, decides how far up the city's lights have to come, and
says how much fog and rain there is. One writer to the lights, one place the floor is enforced.

Every number in a weather profile is a **multiplier or a blend, never an absolute**. That is what
lets the same five kinds work at 3am and at noon: overcast at noon is a bright grey day, overcast
at midnight is a moonless one, and neither needed its own keyframe. Colours are *pulled toward* the
tint rather than replaced, for the same reason — replacing them would throw the hour away.

Note that `fill` goes **up** in the murk. Fog and snow scatter light rather than removing it, so an
overcast afternoon is flatter than a clear one but not darker; it is also the term that keeps the
city legible when the sun has been cut to a third.

`gloom` is a floor under `lit`: a rainy afternoon has every headlight on, which is most of what
sells the rain.

**Successors are a chain, not a uniform draw.** `clear → snow` in twelve seconds reads as a bug;
`clear → cloudy → snow` reads as a front coming in. Every kind can reach every other kind, just not
in one step — `tools/sky.mjs` BFSes the table to prove it rather than soaking until one turns up.

Three things are not lights and are synced separately: `scene.fog` (colour, near, far), the ground
mesh's `material.color` for wet tarmac — one multiply darkens road, kerb, markings and crosswalks
in step, which is what rain actually does — and the two particle fields.

**Lightning** is a flash of fill plus a whitened sky for a fraction of a second, armed only while
there is rain on both sides of the blend.

`?weather=rain` pins one kind and stops the clock; the ⚙️ panel has a cycle toggle and a forcing
dropdown. Forcing from the panel does *not* stop the clock — it hands the sky over and lets it
carry on, so you can pick `rain` and watch what it turns into.

### Precipitation — `game/precip.js`

Two instanced fields falling through a box around whatever the camera is looking at. The field is
**wrapped in world space, not carried by the camera**: a group parented to the camera target would
slide the whole downpour sideways on every pan, which reads as the weather moving rather than the
view. Each particle keeps a world position and is wrapped modulo the field around the current
focus, so panning reveals rain that was already there.

Particles are written straight into `instanceMatrix.array`. Every drop shares one rotation (the
lean into the wind) and one scale, so the 3×3 block is identical across the field and only the
translation column changes per frame; `Object3D.updateMatrix()` would redo that rotation 1,500
times a frame for nothing.

Count scales with strength, opacity barely does — thinning the field is what reads as "it is easing
off", while fading every drop to 10% alpha reads as a rendering bug. Rain is a thin box (the camera
never rotates, so it needs no billboarding); snow is a 20-face icosahedron, same reasoning as the
dust puffs.

## City lights

`src/game/nightlights.js` owns the materials and the one opacity; the geometry is built where the
things themselves are built and handed over as a merged `BufferGeometry`, so `city/` still knows
nothing about `game/`.

- **Lit windows** — `city/buildings.js`. A seeded subset of panes, on their own grid rather than a
  subdivision of the daytime window bands: those stop short of the parapet and skip the ground
  floor, which is right for a floor line on a mass but left this city — whose towers top out around
  eleven units — with *thirteen* band rows in total to hang a night skyline off. Occupancy is drawn
  **per tower**, so some blocks blaze and some are dark; a flat 30% everywhere reads as texture.
  The lit set is fixed per seed rather than flickering — a window that switches on and off is
  something the player will look at, and there is nothing there to reward looking.
- **Street lamps** — `city/props.js`. Three pieces each: the bulb, a cone of lit air, and a pool on
  the tarmac. The pool is the one that matters, because after dark it is what you steer by. It sits
  at y = 0.06 — above the road paint and the route band, below the sidewalk surface — so where it
  overhangs a block the depth test hides it, which is right: a lamp lights the road.

Both fade with `lit`, and both go `visible = false` outright below the threshold rather than being
drawn at opacity ~0.

**Two materials, not one.** Windows blend *normally* — a window is a surface with a light behind
it, and additive would let the dark facade show through and turn every pane into a smear of the
building's paint. Lamps blend *additively* — a pool is light arriving somewhere, not paint, and it
has to brighten the asphalt and the markings under it without hiding either.

The pools **stack**: four lamps per block corner, blocks 20 units apart, so three or four overlap
additively on any downtown road. The first pass ran a peak of 0.5 over a 6.5 radius and the whole
city centre came back as one continuous cream blanket with the roads lost inside it. It is 0.24
over 5.4 with a squared falloff now.

Night lighting draws from its own RNG streams (`seed + 202`, `seed + 203`) rather than from the
building and prop streams — the same principle as the per-generator streams in `main.js`, one level
down. Switching the city's lights on must not move a tower or a tree, so `?seed=N` is the city it
has always been.

## Vehicle lights

`src/geometry/carlights.js` builds one merged geometry per vehicle class: two headlight lenses,
two tail lights, a cone of lit air out of each lamp, and a wedge of light on the road. One geometry
and one additive material, so all the ambient traffic's lights are a single instanced draw.

Tail lights are two thirds the strength of the headlights; matching them makes it genuinely hard to
tell at a glance which way a car three blocks away is pointing. The wedge on the road is **one
across both lamps**, not one each — two overlapping wedges double the additive strength down the
middle of the road, which is where the taxi's own lane markings are. It is an explicit triangle
strip rather than a quad, because the falloff is not linear and four corners can only interpolate
into a flat sheet with a hard end.

**The rig rides an upright node, not the car body.** Position and yaw only: no bob, no corner lean,
no pitch rock. The wedge sits 0.06 units above the tarmac, and a car leaning 17° into a boosted
corner would swing half of it below the road surface where the depth test eats it — the beam would
flicker out every time a car turned. `car.yaw` already carries the Loco Mode weave and the panic
wobble at that point, so the beams still swing with the steering; it is only the suspension they
sit out. Everything else the rig gives up is worth well under a pixel at play zoom — the bob is
±0.045 units, a third of one. `tools/sky.mjs` asserts every rig is level and on its car.

The police cruiser's rig is built **without** the wedge, so it can hang off the group and lean with
a car that is being thrown around. A wreck's rig collapses to zero scale with the rest of its
instances, so no pair of beams is left on the road pointing at nothing.

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

The destination pin is outlined by an **inverted hull**: the same geometry drawn a little larger
with `side: BackSide` and a black basic material, so the enlarged back faces sit behind the real
surface everywhere except around the silhouette. Cheaper than a post-processing edge pass and it
needs no render targets — this is one small object, not a whole-scene effect. Each hull is a *child*
of the mesh it wraps, so it inherits animation for free.

**The pin has two colours, and the difference is whether you have answered it.** There is only ever
one drop-off on the board — the rider currently aboard — so there is nothing for a per-fare hue to
tell it apart from, and the one thing worth saying about it is its own state.

| State | Head | Post | Ring on the tarmac |
|---|---|---|---|
| Untapped — the taxi is parked, waiting to be told where to go | `#17C8B8` teal | `#12AC9E` | `#5FE9DC` |
| Tapped — the taxi is on its way | `#F5C130` | `#E0AE2A` | `routeLine` `#FFE873` |

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

`createDestinationPin().setSelected()` swaps all six materials (colour and emissive on head and post,
rim and fill on the ring) and early-outs on no change; `fares.js` reconciles it against `directed`
every frame the way it does the rider's meter ring, and pushes it in `markDirected` so the pin turns
on the same frame as the band. The off-screen pointer follows the same rule — see the CSS for
`#dropoff-indicator.is-selected`.

The fare's own colour still lives on the taxi's roof sign — see
[gameplay.md](gameplay.md#fare-colours). `?shot=10` frames the untapped state, which no other shot
can show: every other carrying framing sends the taxi on at pickup, and that is what turns the pin
yellow.

The post carries a low **emissive** (0.18 of its colour, against the head's 0.35). It is the only
post that is ever visible — a waiting rider's figure replaces theirs — and the fixed camera sees
the face turned *away* from the sun, so pure Lambert shaded the `#E0AE2A` pole down to
rgb(110, 68, 6): a brown stick under a gold head. With the lift it lands at rgb(152, 106, 19).

The post's hull is scaled `(1.6, 1, 1.6)` — widened but not lengthened, because a uniform scale
would push its end caps past the post's own, and both ends are meant to stay tucked (one in the
ground, one inside the head).

The head bounces on `Math.abs(Math.sin(t * 3.4)) * 0.45`: never below the rest position, with a
sharp cusp at the bottom that reads as a landing rather than a float. **Only the head hops** —
lifting the whole pin would pull its foot off the pavement. Amplitude is bounded by the 0.8 units
of overlap between head and post top; at 0.45 the head bottom peaks at 8.15 against a post top of
8.50, so no gap ever opens. It freezes while hidden, which keeps screenshots deterministic.

The drop-off's target ring is **filled in**, at the route band's own `ROUTE_OPACITY` — the band on
the road and the disc at the end of it are one statement in two places, and at different weights one
reads as the louder half. Depth-tested like the band, so a car crossing the junction drives over the
disc rather than the disc painting across the car. Being translucent puts it in the transparent
queue, so its far half washes up over the base of the post at its centre; that is invisible because
the post is the same yellow one shade down.

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

- **Light** — day cycle on/off, day length, time of day, sun colour/strength, ambient fill
- **Weather** — weather cycle on/off, force a kind, and a live readout of the blend (a sky 40% of
  the way from cloudy to rain has no checkbox that could show it)
- **Game** — fare clock, route blend
- **Restart to apply** — car count (writes a URL parameter and reloads)

Pretending a rebuild-only value is live would just show a slider that silently does nothing.

Touching any lighting control stops **both** clocks. The weather has to stop too, not just the day
cycle: weather owns the final write to the lights, so a hand-picked sun colour would survive the
day cycle being paused and then be stomped by the next overcast frame anyway.

**Copy settings JSON** exports the live values (not the slider positions, so manual overrides are
captured) for pasting back as new defaults.

## URL parameters for a frame

`?hour=13.5` parks the day/night cycle, `?weather=fog` pins one kind of weather. Both stop their
clock — you asked for that frame, not for that frame drifting away while you look at it. Either
works alone. They exist as parameters as well as panel controls because the panel doesn't exist in
shot mode, and "what does the route band look like in fog at midnight" has to be a link you can
send someone.

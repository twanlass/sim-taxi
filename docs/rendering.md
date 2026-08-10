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

### The rider pan

A tap on a rider-finder chip takes the camera to that rider — narrow viewports only, same rule as
everything else here. It **pans rather than cutting**, and it is a different curve from either
follow above: `controller.glideTo(x, z)` starts a one-shot tween, `updateGlide(dt)` steps it from
the frame loop, and it retires itself on its own clock.

A cut costs the player the one thing the fixed camera was chosen to give them. With the whole city
no longer in frame, a teleport leaves them re-reading a screen of near-identical blocks to work out
which way the map moved and whether the rider now under the chip is the one they tapped. Riding the
move across keeps the city continuous.

**A tween, not the exponential ease the follows use.** `1 - exp(-dt * rate)` leaves at its highest
speed on the very first frame — right when you are closing a gap that keeps reopening, and most of
the way to a snap when you start from a dead stop. The easing is **smootherstep**
(`k³(6k² − 15k + 10)`), which zeroes acceleration as well as velocity at both ends; plain smoothstep
still shows its start as a flick over a move this short.

Duration is **distance / `GLIDE_SPEED` = 150 u/s, clamped to 0.32–0.75s** — so a hop to the next
block and a cross-town pan both travel at a legible speed, without a short pan degenerating back
into a snap or a long one leaving the player watching the camera with a clock draining. The clamp
ceiling binds past 112 units; the city's full diagonal is 141.

It sits at the **bottom of the camera priority list** — wreck focus, then the two follows, then this
— and it is *dropped*, not paused, by anything above it: `followXZ` and `focusOn` both clear it, as
does `panBy`, so a finger on the map wins on the frame it lands rather than fighting a tween that is
still writing the target. The tap that starts a pan also takes the camera over, so the opening
follow is out of the way for the whole flight. The **dispatch doesn't wait for the pan** — the fare's
clock is draining, so the taxi leaves on the tap.

`tools/probe.mjs` asserts the ease-in (first frame moves far less than a linear step), the exact
arrival and self-retirement, the distance-scaled duration and both clamps, and that a drag mid-pan
kills it.

The `VIEW_DIR` diagonal has consequences elsewhere: screen-up is world `(-1, 0, -1)`, which is why
riders are placed on the `-X-Z` kerb of a junction — the block on the `+X+Z` side sits between the
camera and anything standing on it. It is also what set the timer ring's sweep start at `-3π/4` for
as long as that ring existed, since a clock has to drain from screen-top.

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

## Ambient occlusion — `game/ssao.js`

A soft darkening where geometry meets geometry: building bases on the pavement, kerbs against the
road, the crease under a tower's setback, tyres on the tarmac. On by default; `?ao=off` turns it
off, and the ⚙️ panel has the strength live.

**It is not a sampled hemisphere and not a port of three's `SSAOPass`.** Two properties of this
project make a much cheaper estimator the right one:

1. **The camera is orthographic.** Depth is linear in view space, so a packed depth value times
   `far - near` *is* a distance in world units — no `linearizeDepth`, no perspective divide. And a
   screen offset is a constant world distance wherever it lands, so the sample radius is stated in
   world units and converted by dividing by the frustum width. That is the whole of the
   [size-against-the-camera rule](#camera) here, and it falls out for free.
2. **The scene is nine draw calls and 12,625 triangles.** The expensive half of a normal SSAO
   prepass is re-submitting the scene; there is barely a scene to re-submit.

### The estimator is a depth Laplacian

Opposed pairs of taps, and the signal is `centre - (near + far) / 2`. **On any plane, however
steeply it recedes from this camera, the two taps of a pair sit an equal distance either side of
the centre and cancel exactly** — which is what lets this run with no normal buffer at all. Only a
concave crease leaves the centre farther from the camera than the average of its neighbours.
Convex edges go negative and clamp to zero, so it only ever darkens.

That is the whole reason there is no G-buffer here. The usual no-normals SSAO shades every sloped
surface, because a receding plane has a depth gradient and a one-sided test reads it as occlusion;
at this camera the ground itself is a receding plane and would have gone uniformly grey.

Eight taps: two rings of two pairs. The broad ring at **1.0 world units** is what reads as
occlusion, the tight one at **0.4** puts a darker core in the crease so the contact survives the
upsample. The broad ring is turned 45° against the tight one — two orthogonal pairs are a
five-point Laplacian, and a crease running along one of their axes is caught by the other pair
alone, so between the rings all four screen orientations are covered.

**The taps are fixed, not jittered.** There is no noise, so there is no bilateral blur pass, and a
frozen shot renders the same frame every time. Upsampling from half resolution is the hardware's
bilinear filter, which is the only softening the signal needs.

### `MAX_DEPTH_DIFF` is bounded on both sides, and that is what fixes the radius

Past some distance a tap is on the far side of a silhouette rather than across a crease, and the
pair says nothing about the surface under the centre pixel. Both bounds fall out of `VIEW_DIR`'s
33° elevation:

- it has to clear `cot(elevation)` = **1.54**, the depth a tap moves through on flat road, or open
  tarmac would reject itself and there would be no AO anywhere;
- times the broad radius it has to stay under `carHeight / sin(elevation)` = **2.93**, the depth
  jump across an ambient car's roofline, or every car would trail a second shadow up-screen that
  the sun never cast.

At radius 1.0 the window is 1.54 → 2.93 and `MAX_DEPTH_DIFF = 2.0` sits in the middle of it. A
bigger radius closes the window from the top, which is why 1.0 is not a free choice.
`tools/probe.mjs` recomputes both bounds from `VIEW_DIR` and the car's own bounding box rather than
trusting the numbers — re-angle the camera and it fails there rather than in a screenshot nobody
took.

### What it costs, and what it deliberately does not

The main render is **untouched**: still the default framebuffer, so MSAA survives, and still its own
stencil buffer, so the [ghost outlines](#taxi-ghost-outline--geometryghostoutlinejs) never see a
render target. Routing the frame through an `EffectComposer` would have cost both, and its
noise-then-blur output fights hard-edged flat shading anyway.

Per frame: a half-res depth prepass (9 draw calls, no colour), one half-res fullscreen pass of 8
taps — about 2.7M texture fetches at an iPhone 15's DPR-2 buffer — and one texture fetch per lit
fragment in the main render.

- **Depth is packed into RGBA8**, not kept as a half float: 24 bits over the 1399-unit frustum is
  sub-millimetre, where a half float's ten-bit mantissa quantises to 0.4 units — coarser than the
  creases this is looking for. The depth target is `NearestFilter` and must stay that way, because
  a bilinear blend of two packed depths unpacks to nothing meaningful.
- **The shadow map is switched off for the prepass.** Left on, three rebuilds all 2048×2048 of it a
  second time per frame for a render that never reads it.
- **Radius is clamped to 1–6 texels.** Below one texel both taps of a pair land on the same sample
  and the Laplacian is identically zero; above the ceiling the eight taps spread into a smudge. The
  floor binds only at the far end of the zoom range, past about zoom 100. The ceiling is a *texel*
  budget, though, not a world-unit one — held fixed while world-units-per-texel keeps growing as the
  player zooms in, so the world-space radius it clamps to grows right along with it. A wall standing
  behind a car cancels its own depth Laplacian far more weakly than flat ground does (see
  `MAX_DEPTH_DIFF` below), so once that clamped radius reached far enough up the wall, the broad
  ring's tap kept spilling from the car's roofline onto the wall behind it and painted a false crease
  climbing it — a shadow the sun never cast, worst right at `camera.js`'s `MIN_ZOOM` (14), the
  closest the player can actually scroll in. 6 keeps that climb to a couple of pixels there; 12 let
  it read as a shadow.
- **AO multiplies the indirect term only.** Occlusion is a statement about how much sky reaches a
  crease, not about whether the sun does, and this game's look is one lit face per building at
  golden hour. Folding it into the direct term greys those faces off and buys nothing the shadow
  map isn't already saying.

**A thin vertical post leaves a faint band beside it** at close zoom, strongest near its base where
the post-to-ground depth gap is still inside the rejection window. It is correct at the base and
overstays going up; at play zoom a lamp post is two pixels wide and it does not read. Rejecting it
properly would cost taps, which is the one thing this is built not to spend.

### The occluder rule

`markOccluder()` is what puts a mesh in the depth prepass, and it is **opt-in**: the prepass has to
contain the solid world and nothing else. Two halves to the rule, and both are asserted in
`tools/probe.mjs`:

- **An occluder is an opaque, colour-writing mesh.** Everything that fails that would corrupt the
  prepass rather than contribute to it. `scene.overrideMaterial` strips exactly the flags that keep
  the ghost outline out of a normal pass — its mask writes no colour and its rim is a hull inflated
  0.3 units past the car — so an unfiltered traversal draws AO around a silhouette bigger than the
  taxi. The invisible raycast boxes are the same story.
- **Anything lit by `propMaterial()` has to be in there.** A mesh that *receives* AO without
  *casting* it samples the occlusion of whatever stands behind it: a rider in front of a building
  would wear that building's contact line across their chest. This is why the riders are marked
  even though a figure is 23px tall.

The lookup itself rides in `propMaterial()` (`util/geo.js`) as an `onBeforeCompile` patch on
three's `<aomap_fragment>` hook, keyed in screen space off `gl_FragCoord`. It carries a
`customProgramCacheKey`, for [the reason the diamond's fill does](#the-diamond--geometrydiamondjs)
— this city is nothing but flat-shaded Lambert, and a patched material with no key gets handed
whichever program compiled first. Whether the patch is installed at all is decided by
`setAmbientOcclusion()` *before any geometry is meshed*, which is why `?ao=` is a URL flag and not a
panel toggle: switching it live would mean recompiling every program in the city.

## The renderer budget — `?safe` and friends

Four things on this page cost GPU memory that a plain three.js scene doesn't, and each has a URL
flag that drops it: the multisampled back buffer (`?msaa=off`), the sun's 2048² shadow map
(`?shadows=off`, or a size), the drawing buffer's pixel ratio (`?dpr=1`), and the AO pass above
(`?ao=off`). `?safe` is all four at their cheapest at once, and any single flag still overrides it.

They live in `util/shot.js` beside `?seed` and `?cars`, and every getter takes its **fallback from
safe mode rather than from a literal**, evaluated per call — so one flag moves all of them, and a
module that opens a renderer of its own reads the effective value without anyone threading it
through. Two do: the tutorial's avatar bubble and each rider-finder chip. They are a 46px and a
38px disc respectively and their own cost is nothing, but each is a **WebGL context this page is
holding**, and that is part of what `?safe` is asking about.

The flags exist because of a failure a desktop cannot see and a phone cannot report — see
[testing.md](testing.md#when-a-device-renders-nothing) for the whole picture. `stencil: true` is
deliberately *not* among them: MSAA and the stencil buffer ride in the same back buffer but they
are separate requests, and a run with multisampling off should still get its ghost outlines.

### The renderer readout — `game/diag.js`

`?diag` puts a six-line panel in the bottom-left corner. It is `pointer-events: none`, so the Loco
Mode pill underneath it still takes taps, and it wraps rather than truncating — the GPU string is
the longest line and also the one most likely to name the culprit, so an ellipsis would clip away
the reason the panel was opened.

Two of its lines decide what kind of failure is being looked at:

- **`ctx LOST`** — the GPU took the context away. Three catches that itself, sets a flag, and every
  later `render()` returns immediately; nothing throws and the rest of the page carries on.
- **`calls 0`** with a live context — the scene submitted nothing. A camera or culling problem, the
  opposite end of the codebase from a driver one.
- **`calls ~40`** and a black screen — the pipeline ran and the pixels came out wrong. A shader, a
  blend state, or a driver bug; the mirrored `THREE.WebGLProgram` error usually names it.

The rest is the device describing itself, and the part worth reading twice is what the context was
**granted** rather than asked for. `getContextAttributes()` and `SAMPLES` report the truth, and a
driver is free to decline multisampling or a stencil buffer and say nothing — the latter being a
trap this project has already paid for once
([the ghost outline](#taxi-ghost-outline--geometryghostoutlinejs) fills in solid without it).

GL parameters are read **once**, at construction: the device does not change under us, and
re-querying the driver every frame is a pipeline stall for text nobody is watching change. The live
half is averaged over half a second, because a number that changes sixty times a second is
unreadable on a screen held in one hand — and the question here is "is this drawing at all", not
"how long did this frame take".

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
marker — fare rings, target discs, route band — is unlit (`MeshBasicMaterial`, or in the band's
case a plain `ShaderMaterial` that never reads a light). The rider's diamond is the exception: it is
Lambert, and carries an emissive at 0.35 of its own colour to hold its hue after dark.

Screenshot mode freezes the cycle: a rendered shot has to be reproducible.

## The island edge — `city/ground.js`

The asphalt doesn't end on a line. A **fade skirt** hangs off the slab — `EDGE_FADE = 16` units of
asphalt stepping outward from the slab's own outline, alpha 1 → 0 — so the city feathers into the
sky rather than being cut out of it. At play zoom that is about 22% of the frame height, which is
what makes it read as a gradient instead of as a slightly blurry edge.

It is the depth cue this projection can't get from fog. Three's fog is a function of view-space
depth and the camera is orthographic, a fixed 400 units back from the whole scene, so distance fog
whitens the entire city uniformly rather than fading its far edge — the reason `scene.js` has none.
Keyed on distance from the *middle of the map* instead of from the camera, the same idea works.

**The skirt is added outside the slab, never eaten out of it.** Fading inward would mean shrinking
the solid part, and there is only 2.2 units of clearance at the corners before the arc bites into the
ring road junction at `(±54, ±54)` — the same ceiling that caps
[`SLAB_RADIUS`](city.md#the-slab-has-rounded-corners). So the silhouette that was there before is
still fully opaque; the fade is all new ground beyond it.

**Alpha rides in a 4-component vertex colour**, as it does on the skid marks, so the skirt needs no
shader of its own — and it wears `propMaterial()`'s recipe unchanged. A flat plane at the same
height, with the same normal and the same `asphalt` colour, is lit *identically* to the slab it
continues, and stays that way across the whole day cycle. A baked sky-coloured gradient would match
at golden hour and part company with the asphalt by dusk.

**The inner ring is the slab's outline rather than a copy of it.** Both come from `extractPoints` on
the same `Shape`, so there is no seam for the sky to leak through at the corner arcs — which is
exactly where a hand-sampled ring would drift from Three's own tessellation. Two flags on the
material: `renderOrder = -1` puts the skirt first in the transparent queue, because everything else
translucent in this game is paint *on* the road and centroid sorting would otherwise let a skid mark
at the far corner of the city draw before the plane it is stamped on; `depthWrite: false` for the
usual reason translucent paint doesn't write depth.

The falloff is a **smoothstep**, sampled over `FADE_RINGS = 4` rings. A linear ramp has a kink where
it meets the solid slab, and against a flat sky that kink is visible as the very edge the fade
exists to remove.

`tools/probe.mjs` asserts all of it: the alpha-1 ring lands on the slab boundary to **2.3e-6 units**
(float32 attribute storage, not slop in the construction), the ramp reaches alpha 0 exactly
`EDGE_FADE` out, and no part of the skirt reaches back over the road — translucent asphalt over the
ring road would show sky through the tarmac.

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
  rather than reading as an opaque decal. This pool used to double as the crash fireball, which is
  what its per-slot life and size arrays were for — one burst can't divide by another's `LIFE`. The
  crash owns its own module now, so this is a tailpipe and nothing else.

- **Wheelie pop.** A hand-shaped bump on `car.pitch` — sine ease-out to peak by t=0.28,
  smoothstep back to zero — layered on top of the pitch spring. Handled outside the spring
  because the spring is calibrated for tiny suspension travel; a 15°+ pop through it would either
  be swallowed by damping or need a wildly out-of-scale impulse. Lift compensation reuses the
  same `Math.abs(Math.sin(pitch)) * (CAR_LEN / 2)` so the rear stays on the road as the nose
  comes up.

### Wreck — `game/blast.js`, `game/vanish.js`

The crash is **one call per car** — `blast.fire(x, z, tint)` — and everything it puts on the road
lives in one module: a shockwave ring on the tarmac, a fireball, and a scatter of shards in that
car's paint. Three `InstancedMesh`es, about forty live instances at the peak of a two-car wreck.

It replaced a stack of four effects (`sparks.js`, `smoke.js`, `debris.js` and a `blast()` half of
`flames.js`) fired twice each at two points, plus a third wave on a `setTimeout` — roughly sixty
draw calls, and four separate physics packets with gravity, drag, restitution, friction and angular
damping between them. None of that is what makes a crash read at a fixed 3/4 camera; **shape and
timing** are, and both were buried under the sum of four tunings. The vocabulary here is graphic
rather than physical:

- **Unlit flat colour, not Lambert.** A faceted sphere needs a light to show its facets and the sun
  is behind the camera, so these carry no shading at all and read as silhouettes. It is also what
  keeps a night-time wreck as bright as a golden-hour one.
- **Colour is the animation.** Every puff walks one ramp — core → gold → flame → ember → smoke —
  keyed on its own life *plus a fixed shade bias*, so the cluster is spread across the ramp rather
  than marching through it together. That internal structure is what a flat fill would otherwise
  cost, and it retires the separate grey smoke plume: the fireball *becomes* the smoke.
- **Position is a curve, not an integration.** Puffs and rings are `origin + direction × ease(t)`
  evaluated from scratch each frame; the shards' ballistic arc is closed-form too, floored at the
  tarmac rather than bounced off it. Nothing accumulates, so nothing has a drag constant to tune,
  and a slow-mo frame is the same shape as a full-speed one.

> **The shade bias is what stops it reading mono.** Keyed on life alone the fireball rendered as one
> flat orange however many colours were in the ramp, because the puffs still alive at any instant
> are the long-lived ones and they all sit at the same stop. The bias is correlated with how far a
> puff is thrown — the outer ones run *ahead* of the ramp, the core runs behind it — so the fireball
> has a pale-gold heart and deepens towards its edge, rather than being noisy.

> The ember stop is load-bearing, not decoration. Lerped straight from flame to smoke a puff spends
> its whole tail around `#9A603D` — which is `brick` in the building palette, so the fireball died
> the colour of the wall behind it. The first version also faded a still-orange puff out over its
> last quarter, which left translucent pink hexagons hanging over the road; the ramp has to be
> allowed to *reach* smoke before any alpha comes off.

The shockwave is the mark that reads first, because a flat ring at this camera projects as an
ellipse spreading out from under the wreck — the blast has a size before the fireball has grown into
one. Fourteen segments, so the flat sides show at the wreck zoom.

Shards are the whole of what is left of the old debris: seven per car, one tetrahedron squashed
per instance into plates and chunks, tinted with that car's paint so a two-car wreck comes apart in
two colours. They no longer bounce, settle or come to rest — wreckage on the tarmac is a detail for
a camera that stays, and this one pulls into a close-up and then cuts to the retry screen.

`vanish.js` owns the disappearance: each shell shrinks and fades into its own fireball over 0.34s
of sim time rather than being switched off. It steps on the frame's already-slowed `dt`, so it
runs at the same rate as the blast through the crash slow-mo. See
[traffic.md](traffic.md#the-wreck) for the rest of the staging, and
[testing.md](testing.md#screenshots) for `?shot=12`, which stages a real crash and freezes it.

### Roadworks — `game/roadwork.js`, `geometry/roadworks.js`

A closed street: two striped trestles, a plywood ramp propped against each, a dozen cones, a spoil
heap and its hole, and two hi-viz workers. Five draw calls — one merged static mesh for the ramps
and the spoil, one trestle mesh per barricade so it can be thrown, one `InstancedMesh` for the
cones and a second for the plank splinters a smash throws off, plus the two figures. The sim side
is in [traffic.md](traffic.md#roadworks-a-street-closed-at-both-ends).

**Orange had to be found rather than picked.** The warm end of the wheel is spoken for twice over:
the taxi owns yellow outright and the urgency scale owns the ambers below it. Measured in the
working colour space `getHSL` reports in — linear-sRGB, so these are not the numbers a colour
picker shows for the same hex — `taxiBody` sits at 34° and `urgency[2]` at 20°. The cone is at
**6°**, 28° clear of the taxi and 14° clear of "this fare is half out of time". That gap is what
stops a prop on the road reading as the player's car at play zoom, and `tools/probe.mjs` asserts
it the same way it asserts the ghost paints'.

The ramp gets its own `plywood` rather than borrowing the spoil's brown, which is the one colour
change a screenshot forced: at the spoil colour it read as a mud patch on the tarmac instead of a
board propped against something, and the taxi launching off it made no sense.

**The ramp shipped wound inside out, and nothing caught it.** `rampWedge` writes its triangles by
hand, and every one of them was in clockwise order: measured off the built geometry, the slope's
normals were `y = -0.98` and the underside's `y = +1.00`. The face aimed at the camera was the
ramp's *bottom* — a flat plywood-coloured quad lying exactly on the road slab — and the slope
itself, being a back face under `FrontSide`, was culled. What players saw was an orange patch
flickering against the tarmac near the junction, reported as "z-fighting, maybe metal covers?", and
they were right about the symptom and necessarily wrong about the cause. The ramp had never once
been drawn as a ramp.

Two things made it survive review. `flatShading` takes its normal from a screen-space derivative,
so the wrong-facing quad still *lit* like a surface instead of going black — the usual loud symptom
of a reversed face was absent. And the bug looks exactly like a depth-precision problem, which is a
thing you tune rather than a thing you fix. This is the class of defect a screenshot cannot
adjudicate, so `probe.mjs` now asserts the sign of `normal.y` on both faces, computed from the
winding rather than from `computeVertexNormals` — which would happily launder a reversed triangle
into whatever its neighbours claimed.

**Heights on the carriageway are a stack, and it is written down** because "a hair above the road"
was how the trench ended up sitting at exactly `MARK_Y`, coplanar with every lane dash it crossed:

```
road slab 0  ·  lane paint MARK_Y 0.02  ·  TRENCH_Y 0.024  ·  route band 0.03  ·  WORKS_Y 0.035  ·  cars ROAD_Y 0.04
```

A solid prop therefore draws over the route band and under a car; the painted hole draws over the
lane dashes but still lets the band run across it. Props with a flat *downward* face — a cone's
base slab, a trestle's foot — are deliberately left sitting on y = 0 rather than lifted: with
correct winding those faces are culled and cannot fight anything, and lifting them would buy a
visible gap under the prop for nothing. Winding is the fix; clearance is the belt.

**The cones stand in two rows** at ±2.6 from the road centreline, six a side, with ±0.12 of jitter.
They were a sine zigzag with 0.9 of jitter, meant to read as hand-placed; it read as neither. A wave
that wanders across the centreline has no rule an eye can pick up, so it looked like cones dropped
at random rather than like a lane coned off — the order has to be legible before the imperfection
on top of it means anything. The offset is set against the car rather than by eye: the taxi tracks
a lane centre at `LANE` = 2.0 and is `CAR_W` = 1.7 wide, so its flank sweeps to 2.85. At 2.6 the
near row is squarely in the way and goes flying while the far row survives, which is what makes
driving through read as damage instead of as a clean corridor.

**Going through throws a burst of dust, not a puff.** The smash used to emit two ordinary trail
puffs — which is precisely what a boosting taxi lays down in two frames, so the one impact in the
run rendered as exhaust. `dust.burst` now fires **twenty-six** at once, thrown **radially out of
the impact point** rather than trailing off the back of the car, and stopped against a per-puff
drag: dust off a road impact punches outward and then halts, and the halt is the half that reads as
an impact rather than as a plume. The pool is 140 slots, so a burst plus its landing costs under a
third and leaves the boost trail intact. The landing reuses the same call at `count 14, power 0.7`
rather than carrying a second set of hand-picked numbers that would drift away from these.

Two bugs in `dust.js` surfaced on the way, and both are the same shape — a number that looked
applied and wasn't:

- `t` was normalised against the `LIFE` **constant** rather than the puff's own span, so a
  longer-lived burst puff started at a *negative* age: a sixteenth of its size and above full
  opacity, growing rather than dispersing. Each puff now carries its own `span`.
- `scale` only ever reached `wide`, which is the **x aspect alone**. A puff asked to be 2.6× the
  size came out 2.6× as *wide* and exactly as tall and deep as a boost puff — from a 3/4 camera, a
  smear on the road. This is why the burst kept being reported as too small while the probe's
  numbers agreed it had grown. Each puff now carries a `grow` multiplier on the whole size curve.

The probe compares a burst against a single trail puff rather than against a magic number, which is
what caught the first of those.

**Knocked cones come to rest, and they are the first effect here that does.** Position is closed
form, like the blast's shards — a curve of `age` rather than an integrated velocity, so nothing
accumulates and a slow-motion frame is the same shape as a full-speed one — and the flight's
*duration* is derived from its own launch velocity (`2·vy / g`) rather than picked, so the settle
lands exactly when the cone does. The lying-down pose is reached by **slerp**, not by blending
Eulers: Euler blending gimbals through the flat pose and snaps the cone ninety degrees in the last
frame. The wreck's shards get away with never settling because the camera cuts to the retry screen;
this one stays.

A cone caught by a *trestle going over* is thrown harder than one the taxi merely clipped —
`SMASH_POWER 1.5` on top of the speed term, and 12–26 rad/s of tumble against the old 7–15, which
is three to five turns on the way up rather than one and a half. The tumble is what the eye reads,
not the height. **`CONE_VY_MAX 13` is the ceiling**, and it is load-bearing: the speed term alone
reaches 2.15 at the overdrive top, so power × speed would launch a cone eleven units up and clean
out of frame on `?shot=15`. 13 tops out at 3.25 — about a car length of air, high enough to read as
flipped and low enough to stay in the picture with the thing that flipped it.

The trestle cartwheels rather than shattering — it flies 4.6 units downfield on a 1.25-unit arc and
lands past flat, which reads as slammed rather than laid down. It is animated inside the group that
carries its placement, so the flight is written in *across / up / downfield* rather than in world
axes, and works unchanged on a diagonal street.

**It also sheds wood.** `splinterGeometry` is a chip of plank — one box in `barrier` orange, one in
`barrierBand` white, split down the middle so a piece spinning past is legible as the *trestle* it
came off rather than as a cone fragment. Sixteen of them come out of a smash, from a pool built
with the zone (the smash is the one frame in a run where compiling a material is unaffordable),
thrown in the trestle's own local frame in a forward fan: a plank pushed aside goes aside at
crowbar speed, but what sends it down the street is the car. Their flight is the cones' closed form
with one difference — a chip starts a metre up on the plank line and lands at zero, so its rise and
fall are different lengths and `dur` comes out of the full quadratic rather than the cone's
symmetric `2·vy / g`. Dormant slots are scaled to zero: an `InstancedMesh` has no per-instance
visibility, so "absent" has to be spelled as "no size".

`?shot=14` frames a zone and `?shot=15` drives the taxi into one and freezes it mid-arc — the same
argument as the wreck's shot, since the smash is over in three quarters of a second and needs the
player to have driven at it.

### The flyover — `game/flyover.js`, `geometry/plane.js`

A light aircraft crossing the city every 45–90 seconds, at 30 units of altitude. Pure scenery:
nothing routes it, nothing can hit it, nothing can tap it, and neither the fare loop nor the
difficulty curve knows it exists. `geometry/plane.js` is the model; `game/flyover.js` is the flight.

It lives in `game/` beside the dust, the flames and the blast rather than in `sim/` beside the
traffic, because that is the line those two directories actually draw — `sim/` is the cars, the
signals and the things the player can hit, and this is an effect. It is also what lets it read
`VIEW_DIR` out of the camera, which the streamers need.

**The heading is skewed off the grid on purpose.** Screen right is world `(1, 0, -1)` here, so a
plane flying down a world axis already crosses the screen on a 45° diagonal — *the same diagonal
every street and every car is on*. Each flight takes an axis and turns it 15–35°, which puts the
path at a slant that matches nothing on the ground, and the flight line is pushed up to 30 units
sideways off the middle of the map so consecutive flights don't all bisect it.

**Both ends of the run are off the edge of every framing**, `RUN_MARGIN = 190` units either side of
the middle, so the aeroplane is always seen arriving rather than appearing. `tools/probe.mjs`
projects both ends through real cameras — portrait phone to ultrawide desktop, panned into each
corner — rather than trusting a hand-derived reach. The fade over the last 45 units is then belt and
braces, for a viewport shape nobody anticipated.

**It is not `propMaterial()`.** That recipe carries the screen-space AO lookup, and a mesh that
receives occlusion without being in the depth prepass wears the occlusion of whatever stands behind
it — [the occluder rule](#the-occluder-rule). Behind this one is the entire skyline. It cannot go
into the prepass either, being translucent. It casts no shadow for a separate reason: the sun is
28.5° up, so a shadow thrown from 30 units of altitude lands 55 units from the aeroplane that threw
it, which reads as a dark blob crossing a street with nothing above it.

**The wingtip streamers are ribbons rolled to face the camera.** Two tapered quads trailing 6.5
units off each tip, alpha in a four-component vertex colour, the same recipe the skid marks and the
fade skirt use. A ribbon is invisible edge-on and a streamer lying in the wing plane is very nearly
edge-on to a camera 33° above the horizon — so each is rolled about its own long axis until its
*normal* points as close to `VIEW_DIR` as a ribbon fixed to that axis can. The camera never rotates,
so that angle is a constant per heading resolved once at launch, not a per-frame billboard.

> Rolling it to point the ribbon's **width** at the camera instead — the same expression with two
> terms swapped — leaves every formula self-consistent and the streamers edge-on, which renders as a
> faint dotted line and nothing else. The probe now reads the normal back off the built quads rather
> than recomputing it, because a check written from the same formula agrees with the bug.

The bob, the bank and the pitch are three channels off two sine waves at different rates: pitch is
not its own wave but the *climb rate*, so the nose comes up as the aeroplane rises. The propeller is
one bar rather than a cross — a Cessna has two blades, and two blades is 180° of symmetry, so at
13 rad/s it turns 12.4° a frame at 60fps and reads as rotation rather than strobing backwards. The
faint disc behind it is what makes it read as a propeller at all; a spinning bar on its own reads as
a bar being rotated.

Four draw calls while one is up — airframe, blade, prop disc, streamers — and none at all the rest
of the time. `?shot=13` stages one; see [testing.md](testing.md#screenshots).

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

### Taxi ghost outline — `geometry/ghostoutline.js`

The taxi's silhouette, traced as a yellow rim (`taxiGhost` in the palette) drawn **only on pixels
where the taxi is hidden** behind other geometry — so the player can always see where their car
is, and a half-hidden car gets exactly a half outline. The pin's inverted hull turned inside out,
in two passes, both hung as children of every opaque part of the car — shell, roof sign and both
steered wheels — so they inherit steering, bounce and roll for free:

1. **A mask pass** re-draws the taxi's own geometry with `colorWrite: false` and no depth test,
   stamping the car's full screen footprint into the **stencil buffer**. This is what keeps the
   interior hollow — a traced outline rather than a filled ghost.
2. **A rim pass** draws the geometry inflated by 0.3 units (≈2.7px at play zoom), back faces
   only, with `depthFunc: GreaterDepth` — the reverse of the usual test, so a fragment renders
   only where something already in the depth buffer sits *in front of* it — plus a stencil test
   of "not the mask", so the rim never paints over the car's own visible pixels.

Where the taxi is visible the reversed test fails everywhere and the whole thing costs nothing;
where a tower covers part of the car, exactly those rim fragments pass. No render targets and no
post pass, but three things it cannot live without, all asserted headlessly in `tools/probe.mjs`:

- **The renderer must be created with `stencil: true`** — three defaults it *off* since r163, and
  without the buffer the stencil test silently passes everywhere and the outline fills in solid.
- **The hull must not inflate downward.** Scaled uniformly it dipped below the road, the road
  became an "occluder", and a fully visible taxi wore a permanent yellow smear at its bumper —
  so the hull's underside is clamped just above the car's own base.
- **Every opaque part of the car must be in the mask.** The rim's rule is "draw where something
  sits in front of the hull", and a taxi part missing from the mask *is* something in front of
  the hull. The steered front wheels were skipped at first — they're separate meshes, outside
  the merged shell — and the rim painted a yellow streak along the rocker panel of a fully
  visible car, tracked down by tinting the rim magenta and re-capturing the same frame with the
  wheels hidden.

Both passes are flagged `transparent` purely to land in the transparent queue, which draws after
every opaque object — the depth buffer has to be complete before the mask stamps. `addGhostOutline`
is per-mesh and reusable (the police cruiser could wear one as-is); the ambient traffic is
instanced and takes the variant below, which shares this file's geometry inflation and both of its
material recipes so the two paths cannot drift apart.

### Nearby-traffic ghost outlines — `game/carghosts.js`

The same outline, worn by the handful of ambient cars nearest the taxi and faded in with Loco Mode.
It exists because `sim/collisions.js` is armed *only* while boosting: the one moment a car hidden
behind a tower is a crash rather than a surprise is the one moment the player cannot see it. The
taxi's outline says where the player is; this says what they are about to drive into. It lives in
`game/` rather than `sim/` because it is a readout of a player-layer concept — the boost — and
because `main.js` is the only place allowed to know about both.

Each ghost wears **its own car's paint** rather than the taxi's yellow (`carBodyGhost`, index-aligned
with `carBody`). Three instanced meshes, three draw calls, and none while the player isn't boosting.

Four things here that the taxi's own outline never had to answer:

- **Four render-order tiers, not two.** The stencil buffer is never cleared mid-frame, so a mask
  stamped earlier still hollows a rim resolved later, and the order decides who may take a bite out
  of whom: taxi masks (9990) → taxi rim (9991) → traffic masks (9992) → traffic rims (9993). A car
  sliding past the taxi is hollowed by the taxi, because it really is behind it; the player's own
  outline can never be eaten by traffic. Squeezed into two tiers, a near miss would punch a hole in
  the player's ghost on exactly the frame they need it — and with a 33° camera, a near miss is the
  *only* time two cars at road level overlap on screen at all.
- **One shared stencil ref, deliberately.** Within a tier, one traced car's mask is what stops
  another's rim painting across its visible bodywork. Per-car refs are only recoverable with
  per-bit stencil masks, and stencil state is per-material — so that would mean one draw call per
  ghost, which is the whole thing instancing is here to avoid.
- **The rim is body-only, the mask is not.** The wheel *masks* are mandatory for the reason above:
  a part left out of the mask is an occluder of the rim behind it. A wheel *rim* is not — a front
  wheel reaches x 1.66 against the body hull's 2.0, so it is inside the body's outline everywhere
  but a ~0.4-unit sliver under the valance, about 3px at play zoom against a rim that is 2.3px wide.
  The taxi wears wheel rims because its outline is a find-my-car signal that has to be complete;
  this one is a don't-hit-that signal, and the body box is the whole message.
- **Off means gone, not transparent.** A mask writes no colour at all, so fading its rim to zero
  leaves it stamping the stencil every frame regardless. The pool drops its instance counts to zero
  instead, which is also what makes it free for the majority of a run.

Rim thickness is 0.35, not the taxi's 0.3: that 0.3 is applied *before* `TAXI_SCALE = 1.18` on the
taxi group, so 0.35 unscaled is what matches the taxi's ≈2.7px trace.

Selection is a plain radius — `GHOST_RADIUS = 30`, i.e. 1.5 × `PITCH`, covering the junction the
taxi is committed to plus the one behind it. At Loco Mode's 18.7 u/s a car crossing that next
junction appears about 1.6s out, which is still enough to lift off the button. `MAX_GHOSTS = 8` sits
deliberately *above* the ~6.5 cars that radius holds on average, so the cap is a rail against a
queue at a red rather than the real filter — and eviction always drops the farthest car, which the
distance fade has already made the faintest. Radius is the first number to turn down if it ever
reads busy.

Nothing in the module recomputes a transform. `traffic.update()` has composed every ambient matrix
by the time it runs, so it reads those matrices straight back out — the same read-back `wreckShell`
does — which is what keeps the bob, corner lean, pitch rock, wheelie, Loco weave and panic wobble
exactly in step with the car being traced. It is called last in the frame, after `collisions.update()`,
for two reasons: a frame's lag is 0.31 units ≈ 2.4px of rim sliding off its own car at boost speed,
and a car wrecked on this frame must not wear a ghost over its own fireball.

### The diamond — `geometry/diamond.js`

The crystal a waiting rider floats: an octahedron of radius 1.9 — about 29px across at play zoom —
outlined in black, bouncing, and painted by [urgency](gameplay.md#urgency-is-one-scale). The drop-off
wore the same model for a while and gave it back, so this is the rider's shape alone now; it stays
its own module because the shape, the outline and the bounce are a vocabulary the next marker should
inherit rather than re-derive.

One geometry serves every diamond on the board and every outline hull too — they differ from the
surface they wrap only by scale. Colour and emissive are per instance, so a repaint is a `Color.set`
on one material.

The outline is an **inverted hull**: the same geometry drawn a little larger with `side: BackSide`
and a black basic material, so the enlarged back faces sit behind the real surface everywhere except
around the silhouette. Cheaper than a post-processing edge pass and it needs no render targets —
these are small objects, not a whole-scene effect. Each hull is a *child* of the mesh it wraps, so
it inherits animation for free, and the rider's "the taxi is coming" state is one line: scale the
hull 1.12 → 1.34 and let it stay black. Crystal and hull sit at `renderOrder` **8** and **9** in the
transparent queue — after the ground layers (route band 4, target discs 3–4) and well before the
ghost outlines at 9990+.

Each diamond carries an **emissive** at 0.35 of its colour. The fixed camera sees the face turned
*away* from the sun, and pure Lambert on its own shades that face a long way down — the lift keeps
the crystal reading as its own hue rather than as a dark facet. It is also what keeps the urgency
colour legible after dark, this being the one lit marker in a game whose markers are otherwise all
unlit.

The surface is **split in the fragment shader** into opaque liquid below the fare's clock and
see-through glass above it, with a pale band on the line between — one mesh, one draw call, and the
shadow, the kick and the pulse all untouched by it. The cut is in the geometry's local Y, so the
liquid rides in the vessel rather than sloshing when the marker hops.

That transparency is what forces the **renderOrder pair** above: the crystal (8) is `transparent`
but keeps `depthWrite` on, so the hull (9) fails the depth test everywhere inside the silhouette and
survives only as the ring around it. Drawn the other way round — the usual `depthWrite: false` for a
transparent material — the hull's far faces are what you see through the empty half, and the marker
reads as a black void. Why the empty half is see-through rather than merely dark, why the level is
linear in height, what the far-wall pass cost, and the numbers that had to be measured are all in
[gameplay.md](gameplay.md#the-crystal-is-a-glass-of-time).

It bounces on `Math.abs(Math.sin(t * 3.4)) * 0.45`: never below the rest position, with a sharp cusp
at the bottom that reads as a landing rather than a float. The amplitude used to be bounded by the
0.8 units of overlap between the old pin's head and its post top; with the post gone nothing
constrains it but taste, and 0.45 is what the motion was tuned at. It freezes while hidden, which
keeps screenshots deterministic.

**The kick** is the one-shot on top of it, fired when the urgency level steps:
`kickEnvelope(t) = sin(π · (t / 0.36)^0.65)`, driving scale to `1 + 0.1 · env` and an extra
`0.55 · env` of lift. The exponent is what makes it a knock rather than a throb — it pushes the peak
early, so the crystal snaps up and eases down; a plain half-sine swells as slowly as it settles.
Both channels ride one envelope so the swell and the hop are the same gesture.

The kick is **retired on the clock, not on its value**. The envelope reads 0 at both ends, and
clearing the animation whenever it read 0 killed every kick on its own first frame — the bug was
invisible in the browser (nothing moved, which is also what "no kick" looks like) and the headless
assertion is what caught it.

Both the bounce and the kick are driven off **sim time**, not an accumulated `dt`: a frozen shot has
to render the same frame every time. The kick's start is stamped inside `update()` rather than at
the moment the level changes, so the animation doesn't depend on the order `setUrgency` and `update`
are called in. Each slot gets a fixed phase offset on the bounce, so two riders don't pulse in
lockstep.

### The target disc — `geometry/targetring.js`

A filled circle inside a solid rim, lying flat on a kerb corner. **Both ends of a trip wear one**:
under the waiting rider in the fare's urgency colour, on the drop-off corner in teal. One rim shape
and one fill shape serve every disc on the board — only the colour differs, and `setColor` moves
all three layers together, since they are one mark at three weights rather than different colours.

`RING_Y = 0.2` above the surface it marks, on all three, so they read as the same object. The fill
is at the route band's own `ROUTE_OPACITY` — a disc and the band running into it are one weight of
paint.

All three layers are **depth-tested**, with `depthWrite: false` so they don't fight each other for
the plane. The depth test is load-bearing under a rider: the far half of a flat circle projects
*upward on screen* at this camera angle, and without the test it would paint a band across the
figure standing in the middle of it. That is precisely what the old countdown ring did — it drew
with `depthTest: false` for legibility through buildings, and needed an `ABOVE_RING` renderOrder
worn by the rider's meshes and the taxi's whole body to survive it. Keeping the test on costs
occlusion by towers and buys all of that back.

**The sweep** is the third layer: a bright head with a fading tail, circling the outer edge of the
rim once every 3.2s. It is a `MeshBasicMaterial` on the same torus radius as the rim (a little
fatter), patched with `onBeforeCompile` to read a per-vertex angle attribute and fade each fragment
by how far behind a moving `uHead` uniform it sits — `ring.update(elapsed)` only ever touches that
one uniform, so nothing re-tessellates or re-uploads per frame. Additive blending is what makes a
beam of the same hue as the rim beneath it read as brighter rather than merely thicker.

Because the patch changes what the material draws without changing its constructor parameters, it
carries its own `customProgramCacheKey` — see the trap in [CLAUDE.md](../CLAUDE.md) about
`onBeforeCompile` and three's program cache. `setColor` paints it the same colour as the rim and
fill; `tools/probe.mjs` reads all three back together and expects one hex, repeated three times.

The beam has to be told to spin: `ring.update(elapsed)` is called from `game/faremarker.js`'s own
per-frame `update` while the rider's disc is visible, and from `game/fares.js`'s fare loop while a
fare is `riding`, for the drop-off's. Neither ring ticks while hidden.

### The drop-off ring — `geometry/marker.js`

The drop-off is a **filled disc on the kerb corner and nothing else** — no head, no post. It was a
crystal on a gold post, then the crystal alone at y = 9.6, then that crystal in teal; it went when
the rider's marker became the same model and the board had two identical silhouettes on it, only one
of which reported anything. See [gameplay.md](gameplay.md#the-drop-off-is-a-teal-ring-and-nothing-else).

**One colour, fixed at build time** — `destination` `#5FE0D9`, rim and fill alike. There is only ever
one drop-off on the board, so there is nothing for a per-fare hue to tell it apart from, and by the
time it is drawn the taxi is already driving at it. Teal keeps it clear of the urgency scale, which
is what hue on a fare marker means now.

**It has worn three colours.** Teal-until-tapped then yellow, back when a drop-off above a `parked`
taxi was a question rather than an instruction; then Loco Mode's yellow throughout, once the taxi
[dispatched itself at pickup](gameplay.md#the-drop-off-dispatches-itself) and there was no
unanswered stretch left; now teal again for a different reason than the first time — not "you have
not answered this yet" but "this one is not on the urgency scale".

Band and disc are no longer the same paint — the band is the taxi's yellow — but they still meet on
the same tarmac at the same opacity, so a disc heavier than the band running into it would read as
the louder half of one mark. The disc used to wash its far half up over the base of the post at its
centre, back when it was translucent *and* something stood in it; nothing stands in this one.

The taxi's roof sign no longer wears a fare colour either — it just lights on and off with whether
someone is aboard — see [gameplay.md](gameplay.md#the-taxis-roof-sign). `?shot=10` frames the
drop-off on its kerb corner; it was added to catch the untapped state, and it is now the only
framing that shows the ring close up.

### Off-screen drop-off pointer

`game/dropoffindicator.js`, styled under `#dropoff-indicator` in `index.html`. An arrow that clamps
to the viewport edge and rotates to point at the drop-off, in the ring's own teal, shown only while
a fare is aboard.

It carries more weight since the head came off. A crystal at rooftop height stayed visible over the
skyline for a beat after the ring had gone behind a tower; the arrow only covers the *off-frame*
case, which is the one the map being bigger than the viewport actually creates. It aims at `y = 0.1`
now — the ring on the road — where it used to aim halfway up the pin's post.

### The fare marker — `game/faremarker.js`

Where the fare's diamond is, and how it gets there. What its colour *means* is in
[gameplay.md](gameplay.md#the-fares-clock-travels).

It is **scene-level**, not parented to the rider's kerb group: it has to leave that corner and fly
to a moving car, so it owns its own world position for its whole life. The group carries that
position; the crystal inside it only ever bounces, kicks and pulses in local space, which keeps the
two concerns from fighting over one transform.

The **ground disc** ([above](#the-target-disc--geometrytargetringjs)) is a second scene-level group,
separate for the same reason inverted: the crystal's group flies to the taxi and this one has to
*stay* on the pavement until it is switched off, which happens on `beginTransfer`. `setUrgency`
paints both, so the two can never disagree about a level — `tools/probe.mjs` reads the disc's rim,
fill and sweep back alongside the crystal at every step of a drain.

`LIFT` is 6.6 on both ends of the trip. Over a rider (topping out a little over 3.3) that leaves the
bottom vertex 1.3 units — about 10px at play zoom — of air above their head, which is the gap the
meter's plate was tuned to. Over the taxi (which tops out at ~2.85 including its roof sign) it
leaves ~1.85, and being a little further off is right anyway: the taxi is wide, and a marker tight
to the roof reads as part of the vehicle. One altitude for both is what makes the transfer read as
sliding sideways instead of climbing.

The **flight** is `TRANSFER_TIME = 0.65s` on a cubic ease-out, lofted by `sin(eased · π) · 1.6` so it
arcs across rather than sliding along the pavement. Both endpoints are anchors without the bounce
folded in, so the crystal doesn't jump at either end of the flight.

Three animations share the crystal's local transform and simply add:

| Channel | Driven by |
|---|---|
| `position.y` | the resting bounce, plus `KICK_HOP` × the kick envelope |
| `scale` | `KICK_SCALE` × the kick envelope, plus the panic pulse's `0.15 × (0.5 + 0.5 sin)` |

Adding rather than switching is deliberate: a level change landing inside the last five seconds
should read as a knock on top of a beating marker, not replace it.

**Everything is a function of sim time**, including the flight and the pulse — no accumulated `dt`
anywhere — because a frozen shot has to render the same frame every time. Both the kick's and the
flight's start times are stamped inside `update()` rather than at the call site, so neither animation
depends on the order `setUrgency`, `beginTransfer` and `update` happen to be called in. Each slot
gets a fixed phase offset on the bounce so two fares don't pulse in lockstep.

**It is depth-tested**, unlike both markers it replaced — the meter's plate and the timer ring both
drew over everything, and an inverted-hull crystal cannot: with the depth test off an octahedron
paints its own back faces over its front ones. So a fare behind a tower is hidden with the tower, on
the kerb and in the car alike. On the kerb the
[rider-finder chips](gameplay.md#extra-fares-and-prioritisation) cover it — every waiting rider has
a chip with their own countdown and a tap that [pans the camera onto them](#the-rider-pan). In the
car nothing does;
the taxi's ghost outline says where the car is, but not how long is left.

The crystal and its hull both have `raycast` stubbed out. The rider's marker and the taxi both carry
an oversized invisible hit box that already covers this airspace, so intersecting the crystal would
only cost work on every tap.

### Car motion

Cars get a subtle vertical bounce while driving and **roll into corners** for weight. The roll is
applied with a compensating lift:

```js
lift = Math.abs(Math.sin(roll)) * (CAR_W / 2)
```

Without it, leaning pushes the outer wheels underground. The taxi's ground disc is *not* rolled
with the body — it used to be, and tilting it into the road caused z-fighting.

## The "Add to Home Screen" screen

`src/game/homescreen.js`, styled under `#home-tip` in `index.html`. A numbered list of the taps that
install the game, over a city sunk into black, waiting for one tap to start the run. **iOS only, and
only in a browser tab.**

It exists because the icons and the web-app meta tags in `index.html` are already there — launching
from the Home Screen drops the browser's chrome and hands the fixed 3/4 camera the whole screen. In
a tab the bottom toolbar slides in and out as the page is touched, which resizes the viewport
*mid-run* and moves the framing under the player. Every other platform's browser offers installation
itself (Chrome and Edge fire `beforeinstallprompt` and put an affordance in the address bar), so a
screen drawn by the page would be a worse second copy of it; iOS fires nothing and buries the action
in the share sheet, which is why it has to be described in words.

**Detecting it is two questions, each with a trap.** *Is this iOS* — iPadOS 13+ sends a desktop
user-agent, so the UA test has to fall through to `MacIntel` + a touch screen (a real Mac reports
`maxTouchPoints === 0`, since a trackpad is a pointer and not a digitiser). *Is it already
installed* — `navigator.standalone` is the iOS-only flag and the only one older Safari sets;
`display-mode: standalone` is the standard query and covers Safari 16.4+. Either being true means
there is nothing to suggest.

**One list, for every iOS browser.** It used to branch on the user-agent, because Safari's Share
sits in the toolbar and Chrome's is behind ⋯ — but that stopped being true: current Safari collapses
the toolbar behind its own ⋯, so Share is a menu item there exactly as it is in Chrome and Edge.
Verified on a device. A second, UA-sniffed list would now be a guess about someone else's iOS
version, and the failure it was guarding against — naming a first tap that isn't on screen — is the
one it would cause. Only the **first** step carries a glyph, because only the first step is a hunt;
everything after it is a labelled row in a sheet the player is already looking at.

**It does not hide the city, it sinks it.** The backdrop is a gradient, transparent at the top so
the skyline and the two HUD counters stay readable, solid black by the time the text starts. Reading
the game through it is what makes the screen a step on the way in rather than a different place —
and it means the black behind the list is genuinely black, with no skyline competing with the one
thing that has to be read.

**It holds the run.** `state.holding` is true from the moment the module decides to show — before
the screen is visible, because it appears a beat after load and a fare spawned inside that beat is
exactly the bug. `main.js` skips `fares.update` while it is set, so nothing spawns and no clock
drains; the traffic keeps driving, which is the point of sinking the city rather than freezing it.
Without the hold a rider would appear behind the black with a 60-second deadline already running,
and a player who read the screen slowly would lose a run they had not started.

**One size drives the block, and it is measured rather than guessed.** The steps are `1em` and every
other size and gap is a ratio of them. `"3. Add to Home Screen"` is eighteen characters of heavy
type that has to hold one line — wrapping it under its own number breaks the second straight edge
the grid exists for — on a 320px phone as well as a 430px one, in a font we do not control
(`ui-rounded` is SF Pro Rounded on iOS and something else wherever this is being developed, and
rounded faces run wide). So the CSS clamp is the *ideal* and `fitToWidth` only ever scales down from
it, against the widest line actually rendered. Measured: on a 390px viewport it leaves the ideal
28px alone under a narrow face and pulls it to 25.5px under a wide one.

**It shows on every load until the game is installed.** Nothing is remembered between loads and
there is no dismissal to persist — the thing it asks for *is* the thing that switches it off,
because installing the game is exactly what makes `isInstalled()` true. A player who taps past it
ten times and then adds it to their Home Screen never sees it again; one who never installs is being
told something that is still true. (An earlier version counted showings in `localStorage` and gave
up after three, which meant the advice expired while the reason for it did not.)

`?hometip` forces it up on any platform, which is the only way to lay it out without a phone in
hand; `tools/smoke.mjs` checks both directions of the detection, the step list, the run hold, and
that it returns after a reload, under an emulated iPhone.

## Debug panel

`src/game/debugpanel.js`, behind the ⚙️ button top right — only built when the URL carries
`?debug` or `?settings`. It used to be always on, but at small widths the button sat right where
the streak counter now lives, and it's a tool almost no player needs to see. Split by cost:

- **Live** — day cycle on/off, day length, time of day, sun colour/strength, ambient fill, fare
  clock, route blend, occlusion strength
- **Restart to apply** — car count (writes a URL parameter and reloads)

Pretending a rebuild-only value is live would just show a slider that silently does nothing.

Touching any lighting control stops the day cycle, rather than letting the next frame overwrite the
change. **Copy settings JSON** exports the live values (not the slider positions, so manual
overrides are captured) for pasting back as new defaults.

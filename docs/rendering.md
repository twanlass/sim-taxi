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
hull 1.12 → 1.34 and let it stay black.

Each diamond carries an **emissive** at 0.35 of its colour. The fixed camera sees the face turned
*away* from the sun, and pure Lambert on its own shades that face a long way down — the lift keeps
the crystal reading as its own hue rather than as a dark facet. It is also what keeps the urgency
colour legible after dark, this being the one lit marker in a game whose markers are otherwise all
unlit.

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
both layers together, since they are one mark at two weights rather than two colours.

`RING_Y = 0.2` above the surface it marks, on both, so they read as the same object. The fill is at
the route band's own `ROUTE_OPACITY` — a disc and the band running into it are one weight of paint.

Both layers are **depth-tested**, with `depthWrite: false` so they don't fight each other for the
plane. The depth test is load-bearing under a rider: the far half of a flat circle projects *upward
on screen* at this camera angle, and without the test it would paint a band across the figure
standing in the middle of it. That is precisely what the old countdown ring did — it drew with
`depthTest: false` for legibility through buildings, and needed an `ABOVE_RING` renderOrder worn by
the rider's meshes and the taxi's whole body to survive it. Keeping the test on costs occlusion by
towers and buys all of that back.

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
paints both, so the two can never disagree about a level — `tools/probe.mjs` reads the disc's rim
and fill back alongside the crystal at every step of a drain.

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

## Debug panel

`src/game/debugpanel.js`, behind the ⚙️ button top right — only built when the URL carries
`?debug` or `?settings`. It used to be always on, but at small widths the button sat right where
the streak counter now lives, and it's a tool almost no player needs to see. Split by cost:

- **Live** — day cycle on/off, day length, time of day, sun colour/strength, ambient fill, fare clock
- **Restart to apply** — car count (writes a URL parameter and reloads)

Pretending a rebuild-only value is live would just show a slider that silently does nothing.

Touching any lighting control stops the day cycle, rather than letting the next frame overwrite the
change. **Copy settings JSON** exports the live values (not the slider positions, so manual
overrides are captured) for pasting back as new defaults.

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
height: `(2 * zoom) / clientHeight`. The route line uses this to hold a constant pixel width.

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
marker — fare rings, beacon, route line — is `MeshBasicMaterial` and therefore unlit.

Screenshot mode freezes the cycle: a rendered shot has to be reproducible.

## Effects

### Skid marks — `game/skidmarks.js`

A ring buffer of flat quads stamped onto the road while boosting **through a corner**. Alpha lives
in a 4-component vertex colour attribute. Pure black, `MARK_LENGTH = 1.5`, `MARK_WIDTH = 0.58`,
`START_ALPHA = 0.85`, spaced closer than one mark length so stamps overlap into a streak.

> `car.state === 'turn'` covers **every** junction crossing including going straight on, which is
> why rubber first appeared on the straights. A real turn is `car.dOut !== car.d`, and only after
> the straight run-up (`leadIn`) is done.

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

### Route line — `game/routeline.js`

A ribbon on the road showing the planned route. Held at a constant ~2px using the
world-units-per-pixel factor above. Shown only while the taxi has a pending target — the route is a
property of the *selection*, not of the world.

Once planned it does **not** re-path as the taxi drives; a line that keeps changing under you is
unreadable.

**Corners are filleted**, not mitred to a point: each junction becomes a quadratic Bézier using the
junction itself as the control point, so the curve stays tangent to both legs. Radius 5, 8 steps,
clamped to half of either leg so fillets at adjacent junctions can't overlap and cut across a block.
A square 90° turn read as a wire diagram laid over the city rather than a path something is about
to drive.

That forced the second half: the ribbon offsets each *point* along its mitre rather than offsetting
each segment independently. Independent segments leave a wedge of bare road on the outside of every
join — invisible when the corner *was* the notch, obvious across an eight-step arc. Measured on a
real turn: sharpest drawn angle 90° → 14.3°, width held to 0.2600–0.2620 against a 0.2600 target,
and the arc strays at most 1.25 units from the centreline (road half-width is 4).

### Pin outline and bounce — `geometry/marker.js`

The destination pin is outlined by an **inverted hull**: the same geometry drawn a little larger
with `side: BackSide` and a black basic material, so the enlarged back faces sit behind the real
surface everywhere except around the silhouette. Cheaper than a post-processing edge pass and it
needs no render targets — this is one small object, not a whole-scene effect. Each hull is a *child*
of the mesh it wraps, so it inherits animation for free and survives `setColor` retinting.

The post's hull is scaled `(1.6, 1, 1.6)` — widened but not lengthened, because a uniform scale
would push its end caps past the post's own, and both ends are meant to stay tucked (one in the
ground, one inside the head).

The head bounces on `Math.abs(Math.sin(t * 3.4)) * 0.45`: never below the rest position, with a
sharp cusp at the bottom that reads as a landing rather than a float. **Only the head hops** —
lifting the whole pin would pull its foot off the pavement. Amplitude is bounded by the 0.8 units
of overlap between head and post top; at 0.45 the head bottom peaks at 8.15 against a post top of
8.50, so no gap ever opens. It freezes while hidden, which keeps screenshots deterministic.

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

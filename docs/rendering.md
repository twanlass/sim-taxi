# Rendering

Three.js r0.180. **Every visual is generated in code** — there is no loader, no texture file and no
model file. (The sound effects are the project's only loaded assets; see [audio.md](audio.md).)

This page describes the renderer as it is. How it got here — superseded designs, first attempts that
failed, removed features, and what each `?x=classic` flag brings back — is in
[rendering-history.md](rendering-history.md), section by section in the same order.

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

**The one deliberate exception is the tree crowns, which are soft.** The props and buildings meshes
are `propMaterial({ smooth: true })` — lit from the geometry's own normals rather than the
screen-space derivative — and that changes nothing for any facet, because `bakeColors` has already
given every non-indexed face its own normal. The crowns alone are handed the ellipsoid's normal at
each vertex (`softCrown` in `city/props.js`), so they light as one rounded mass while the walls,
trunks and benches around them stay faceted. A pixel diff of the city before and after differed
only on crowns, and `tools/probe.mjs` asserts that every bent normal in those two meshes belongs to
a crown. One cost: the crown's own shadow-map self-shadowing now draws a hard terminator across a
soft gradient, where on a faceted crown it fell along a facet edge and could not be seen.

`palette.js` holds every colour in the game by name, plus `jitterColor()` for per-instance
variation. New colours belong there, not inline.

### Flat shading does not mean flat colour

`bakeColor()` writes one colour to every vertex of a geometry, which is what almost everything
here wants. `bakeColors()` beside it takes a colour **per vertex**, and the gradient survives —
which looks like it shouldn't, given every mesh in the project is `flatShading: true`.

It survives because `FLAT_SHADED` only reaches the *normal*. Three derives that from a
screen-space derivative of the view position; `vColor` stays an ordinary interpolated varying
either way. So a gradient across a triangle costs nothing but the numbers: no extra vertices, no
second material, no texture, and it still merges into the same one-mesh-one-material pile as
everything else.

The window reflections are built entirely out of that.

### Faux window reflections — `city/buildings.js`

Glass is lerped from `window` toward `windowSky` by a weight computed per corner of every pane.
Nothing is being reflected — it is two numbers and an exponential — but it holds up because **the
camera never moves**. A real reflection changes when you walk past a building; this one never has
to.

Three things go into the weight:

| | What it does |
|---|---|
| **Height** (`SKY_RISE`) | Higher panes catch more sky, lower ones more of the street. This is the part that reads at play zoom, where a façade is 40px and a pane is 8 — it gives a mass a soft vertical falloff instead of a flat patch |
| **A diagonal streak** (`STREAK_GAIN`) | A soft band crossing the façade, which is what actually says *glass* rather than *dark paint*. Placed in a diagonal coordinate rather than aimed at anything: the eye reads the diagonal, not the geometry behind it |
| **Which way the face points** (`FACING`) | +X and +Z are the faces the camera sees and the sun lights, so they get it at full strength; the pair behind get a third. Without this the backs of buildings glowed as brightly as their fronts and the city lost its light direction |

Four details worth keeping:

- **The two front faces are deliberately unequal, and +X is the stronger one even though the sun
  favours +Z** (azimuth 56°). Matching the reflection to the light makes a corner read as one
  surface wrapped around it; opposing them puts a value break on the corner, so a tower reads as
  two glazed elevations meeting.
- **The streak position comes from a noise field over the city, not from each building's rng.** It
  is one sky: rolled per building, neighbours on a block caught the light at unrelated places and a
  street read as a row of independently lit objects. Sampled from a field at 26 units — about a
  block and a half — a run of buildings shows one sweep passing across them. The field is fixed-seed
  (the sky does not reseed with the city), which also means the whole feature draws **no rng**, so
  it is geometry-neutral: asserted identical massing across 60 seeds, and a before/after screenshot
  differs only by the colour under review.
- **A quad's gradient must stay on one axis.** A quad is two triangles, so interpolation is exactly
  linear only when the weights vary along a single axis; a twisted set of four corners shows the
  diagonal seam between them. Diagonal streaks come from varying the weights *between* panes.
  Curtain-wall bands are cut into `RIBBON_SEGMENTS` for the same reason — a band is one quad and a
  quad has two ends, so left-to-right is the only gradient it can hold, which gives a ramp across
  the whole façade and never the band the streak is meant to be.
- **A punched window never outshines its own wall** (`wallCeiling`). `windowSky` is more luminous
  than brick (0.25 against 0.18) and slate (0.20), so a pane at full streak on either comes out
  brighter than the masonry. On a curtain wall that is correct and wanted — the glass *is* the wall
  there. On masonry it inverts figure and ground, turning dark holes in a light wall into light
  patches on a dark one, and takes the scale cue with it. So the punched path carries a ceiling
  (0.52 on brick, 1.0 on the pale envelopes) and the curtain-wall path does not.

### Wheel wells — `archedBodyGeometries` in `geometry/wheels.js`

Every road vehicle's lower body — the fleet's cars, truck chassis, the cop cars and cruiser (through
`carGeometry`), the fire engine and the taxi — is one shared slab with an arch cut over each axle and
a dark liner (`wheelWell`, on the tyre's matte finish) filling the middle of the car as the well's back
wall, so no steering angle has the flank cutting the tyre on a slant.

The arch is sized to the **swept** tyre, not the still one: `ARCH_R = WHEEL_R + ARCH_GAP` clears a
wheel at `STEER_MAX` fore and aft and over the top, and `tools/probe.mjs` samples a tyre at full lock
on a car and a truck and asserts nothing lands in the panel. Because the wheels are oversized for the
camera, a car's arches run off both ends of the body — the corners are open below 0.81 — and they rise
to 1.34 against a 1.50 roofline. That last number is why the taxi's chequer stripe rides the shoulder:
cut at the waist, it would keep about two of its six cells. Anything else laid on a flank (the taxi's
rear door, the fire engine's band) is cut with the same `archOutlines`.

History: [what the arches replaced](rendering-history.md#wheel-wells--archedbodygeometries-in-geometrywheelsjs).

### Car finishes — `propMaterial({ gloss })` in `util/geo.js`

Every vehicle body and every wheel — the fleet, truck cabs and boxes, the cop cars, the cruiser and
the taxi, and [every other vehicle](#every-other-vehicle) — is `MeshPhongMaterial` rather than the
Lambert everything else wears, with one more patch on top of `patchProp`. Wrecks stay plain Lambert.

**Six finishes, one program.** `setFinish()` bakes an `aFinish` attribute per part —
`FINISH.TYRE`, `PAINT`, `GLASS`, `METAL` (the hubcaps, `geometry/wheels.js`, and the chrome
bumpers, `geometry/bumpers.js`), `MATTE`, for what a vehicle carries rather than what it is
made of (below), and `PATINA`, oxidised copper (the bank's dome, [city.md](city.md#the-bank)):
a satin sheen in its own green with no flop, since `METAL` is too hard a mirror and `PAINT` is
shared with every car — and the shader
indexes three shared `vec4` uniform arrays with it, so each finish has its own full set of numbers
(`FINISH_DEFAULTS`: glint, glint sharpness, glint bend, sheen, sheen sharpness, flake, reflect,
reflect edge, reflect bend, base colour) while every glossy material still compiles to the same
source. A geometry with no `aFinish` reads 0, so anything untagged comes out as tyre — matte rather
than mirrored; `tools/probe.mjs` asserts the car and the taxi carry all four.

**Metal is never paint.** The fleet is tinted per car through `instanceColor`, which multiplies
every vertex; the gloss patch swaps three's `color_vertex` for one that leaves the tint off
`METAL`, so a red car's bumpers are chrome rather than red. The cruiser's baked repaint
(`sim/police.js`) skips metal to match.

**Tuning them.** `?debug` → **Car finish**: pick a finish and its ten sliders retarget to it, plus
flake size, façade darkness and **Show finishes**, which paints each finish a flat false colour
(tyre grey, paint red, glass cyan, metal yellow) to check what the geometry tagged as what —
`?finishes` turns the same view on from a URL, for screenshots. Everything is live. **Copy
settings JSON** exports it as `carFinish`, whose keys are `FINISH_DEFAULTS` and
`GLOSS_GLOBAL_DEFAULTS`. **Freeze & zoom** (or `I`) stops the world with nothing over it and hands
the camera to `game/inspect.js`: wheel or pinch to zoom down to a frustum half-height of 2.5, drag
to pan, **Next car** (`N`) to step outward from the taxi, `I` again to resume where you were.
Paint's reflection is also scaled per material (`amount`: the taxi 1.33, a
cargo box 0.55).

**The diffuse keeps the flat normal.** Bending three's `normal` itself, which the diffuse reads too,
smooths the facets that make this a low-poly game into one rounded lump. Instead two *extra* normals
are bent outward by how far the fragment sits from the body's centre, and only the specular and the
reflection read them:

- **The glint's bends up to 45° at a panel's corner** (`glintBend` ≈ 1). It has to: the sun's
  half-vector sits about 45° round from both axes the traffic drives on, so a box panel bent less
  never lines up with it — a 17° bend rendered no glint at all on an axis-aligned car. A real car
  catches the sun on its curved shoulders; bent this far, the corner of a panel is that shoulder,
  and with a lobe this tight only the corner shows it.
- **The reflection's bends separately** (`reflectBend`, about 1.2 as tuned), which is what slides a
  skyline across a panel. It never reaches the diffuse, so the facets stay hard however far it goes.

**The specular is swapped, not tuned.** Phong's own specular line is replaced
(`GLOSS_SPECULAR_FROM`/`TO`) with two lobes: the glint on the glint normal, the sheen on the reflection's. It stays inside three's light loop,
so the shadow map is already folded into the light: a car in a tower's shadow has nothing to glint
with, and the cop's lamps glint off the cars beside it.

**The sheen carries metal flake.** The sheen is what separates paint from glass when no glint is
lined up, and paint's carries the flake — see [the layered finish](#car-paint--the-layered-finish)
below for how, and for why at play zoom it is a glow rather than a sparkle.

**The reflection marches the city.** The reflected ray is stepped through the height field
`game/sightline.js` already builds for the fare board, uploaded once as a byte texture
(`setGlossCity`). Under a roofline it returns a dark façade, otherwise the sky gradient
(`setGlossSky`, fed by `game/daylight.js`). Why not an env map: the camera never rotates, so the
reflected ray off a facet only changes when the *car* turns — a cubemap would hand a car driving
straight the same picture every frame. What changes as it drives is where it is.

**The ray is folded up off the road.** The camera looks down at 33°, so the honest reflection off a
side panel is the asphalt a metre away — correct and invisible. `gR.y = max(abs(gR.y), 0.12)`
mirrors it upward so a flank sees the street wall opposite.

**Off under Crayon and Cartoon.** `propMaterial` hands back the plain Lambert when either look is on
at boot. `outlinable` in `game/cartoon.js` accepts Phong as well, for a car built before the flag.

All glossy bodies share one program (`prop-gloss`, `-ssao` as it applies): the per-shape numbers
are per-material uniforms, not source. `tools/links.mjs` counts it at boot, not mid-run.

History: [the first bent normal](rendering-history.md#car-finishes--propmaterial-gloss--in-utilgeojs).

### Every other vehicle

The plane, the civil and police helicopters, the trash barge, the sailboat, the container ships and
the L train wear the same paint (Tyler, 2026-10-14). Each builder tags its parts by what they are
made of — liveries, hulls, wheelhouses and car bodies are `PAINT`, glazing is `GLASS`, rotors,
skids, masts, rigging and running gear are `METAL`, the barge's fender tyres `TYRE` — and hands
its mesh `propMaterial({ gloss })`. `?vehiclepaint=classic` puts them all back on the plain
material they wore before; the tags stay on the geometry either way, since a plain material
ignores them.

- **`MATTE` is for the cargo.** The barge's heap, its rust streaks and grime, the sailboat's sail
  cover, the gulls riding the barge and a ship's deck and containers share their vehicle's mesh and
  material but are not paint. Every number is zero and the diffuse is 1, so they draw exactly as a
  plain prop does. `TYRE` is no answer to "not shiny": its diffuse of 0.64 turned the barge's green
  wheelhouse black when it was tried as one.
- **The aircraft keep their AO off** (`propMaterial({ ao: false, gloss })`): they are transparent
  for their fade, so they cannot be in the AO prepass, and a receiver outside it wears the occlusion
  of whatever is behind it. That is one more program than the fleet's, shared by the plane and both
  helicopters.
- **The ships' curve is centred on a whole ship**, hull to funnel cap, measured off a throwaway
  build (`shipBounds` in `game/harborships.js`), because one material covers both hulls and
  everything on deck.
- **The ships and the train reflect at 0.55**, the cargo box's `amount`: a long flat side bends to
  grazing along most of its length, and at full strength the toon coat's sky band covered the
  whole train and a ship's whole bow — a silver streak across the city at play zoom.
- **The L train's body gets its own material** with the deck's fade and intro patched on top, so
  the deck and the columns stay plain.
- **Not covered:** the depot's neon taxi is a sign, the flatbed's deck and crates ride on a
  traffic truck that already wears the paint, and the skaters' boards are props.

### Car paint — the layered finish

The shipped default is the `real` look built on this (see the end of this section); everything below
is the layered paint it starts from, still one `?paint=layered` away. `?paint=classic` keeps the
paint before the layered one — its own GLSL, not the new shader fed the old numbers; see
[history](rendering-history.md#car-paint--the-layered-finish).

Paint is built the way a real one is layered, base coat up, and each layer is one of the `paint`
numbers in `FINISH_DEFAULTS`. The other three finishes leave every one of these at 0 and render
exactly as they did.

- **Flop** (`flop`). The base colour darkens toward a grazing angle, off the reflection's bent
  normal — whose view-space z *is* N·V under this camera. It is what gives a box panel a curve
  without touching the facets.
- **A metallic sheen** (`tint`). The broad lobe takes the paint's own hue, scaled to a peak of 1 so a
  dark red still gets a full red highlight. A white broad lobe over a coloured base is precisely what
  plastic looks like.
- **Flake** (`flake`, `flakeTilt`, `flakeSharp`, and the global `flakeSize`). Round chips, one per
  cell of the body's own space, each at a random spot and size and leaning off the panel by up to
  `flakeTilt`, each a mirror with exponent `flakeSharp` — so only a few catch the sun at once, and
  they cluster around the highlight the way real metallic paint does.
- **A clear coat** (`coat`). Schlick's Fresnel at 4%, off the bent normal, mixing the city
  reflection (below) over everything else. About 6% in the middle of a roof or a flank under this
  camera; capped at about half at the bent corners, because every corner of a box body is "grazing"
  and at 100% a corner turned into a slab of façade-black or sky-white. The glint stays the coat's
  own reflection of the sun, white.

**The flake is filtered, and at play zoom it is the glow, not the sparkle.** A chip's cell is
1/14.5 of a unit; a phone at play zoom puts ~16 px on a unit (DPR 2, portrait), so a cell is ~1.1
px, and any one pixel's answer depends on which cell its centre happens to land in — which changes
every frame a car moves a fraction of a pixel. That is shimmer. So the shader measures how many cells a pixel spans (`gFoot`, the screen-space derivative of the very
coordinate the cells are cut from), fades the sparkle out across 0.4–0.85 cells a pixel, and hands
its energy to the flakes' **mean lobe**: what a field of tilted chips averages into, derived from
`flakeTilt` and `flakeSharp` (`flakeMeanSharp`, the two widths added in quadrature). Both lobes are
normalised Blinn-Phong, so the fade moves the light rather than losing it.

Where it lands, measured on a phone framing (390x844 at DPR 2): sparkle is fully on at the closest
the player can pinch (zoom 14, ~4 px a cell), half-faded at the wreck cam (zoom 26), and gone to
glow at play zoom. Moving the camera a third of a pixel a frame at play zoom, paint pixels jumping
more than 12 levels frame to frame went from 4.3% (classic) to 3.3% on the taxi and 3.7% to 2.9% on
a traffic car; what is left is edges, which the paint cannot help. The sparkle is skipped outright
where `gFlakeVis` is 0, a branch a whole car takes the same way.

**The reflected skyline is soft.** Under a clear coat the reflection reaches the paint, and taking
the first step under a roofline as façade draws a ragged black claw mark from 14 coarse steps on a
white panel, which reads as a scratch. So the layered paint counts a step by how far under the roof it is, against a depth that grows with the ray's
length (`GLOSS_HIT_SOFT`): the further the thing reflected, the blurrier its edge.

**Three explored looks** sit on the same source behind `?paint=`, each the layered numbers with a
few overridden (`PAINT_LOOK_NUMBERS`) and up to four GLSL slots filled (`PAINT_LOOKS`):
`chameleon` turns the base hue by up to 2.3 rad as a panel turns away, so edges flip colour;
`satin` is a wrap — almost no coat, a broad sheen and a velvet rim; `toon` makes the glint and
sheen hard shapes and the coat one band of sky past 0.6 graze.

**`rim`** (the default 2026-10-16 to 17, `?paint=rim`): toon's hard glint and sheen in the paint's full hue, plus the
rim line, which every look but classic now wears. Two things make it:

- **The sheen takes the paint's full hue** (`tint` 1, toon has 0.5). Toon's half-white sheen is what
  turned the taxi pale blue-grey from above: a hard shape over most of a sunlit flank, half of it
  white. At 1 the taxi stays yellow.
- **The highlights are small.** Toon's glint snaps on at cos 0.996 of the half-angle and its sheen at
  0.975 (`uToonCut`, shared by toon and rim). The first cut, 0.982 and 0.86, drew a sun-sized oval
  across the windscreen and a lobe over half the roof (Tyler, 2026-10-17).
- **The rim is found on the screen, not on the surface.** The bodies are flat boxes, so no normal
  says where an edge is. Each light steps the fragment 4 half-res texels toward itself across the
  AO prepass's depth (`gRimEdge`); where the step lands more than 0.4 units further back — road, or
  nothing — the fragment is on that light's edge of the car and takes the light's colour, shadow
  map included. The sun lights the sun-side edges, a cop's bar lights the edges toward the bar, a
  car in a tower's shadow has none, and turning moves the line. A second step straight up-screen
  adds a fainter sky-coloured edge. It needs the AO depth pass, so the rim look asks for it even
  under `?ao=off`. The first build, a Fresnel on the ellipsoid fitted to the body, painted patches
  over whole corners instead of a line.

The line takes each car's own hue by default (`?rim=paint`; a yellow taxi gets a gold edge, a white
cop a white one), `?rim=magenta|cyan|gold|white` tints every car one colour (`RIM_COLORS`), and
`?rim=off` compiles it out. The ⚙️ panel has its width (in half-res texels), strength, sky share,
car-colour mix and depth gap live, and the two toon cuts (past 1, that highlight is gone). `?paint=toon` is the look before rim; `?paint=layered` the
realistic layered paint described above, and `?paint=satin&rim=off` any look without the line.

**Flip colour, realistic paint and smooth bodies** (2026-10-17, experiments from Tyler's car-paint
brief). The flip colour turns the paint toward a deeper shade of itself (its own colour squared,
so yellow goes amber and white stays white) as the bent normal turns away from the camera, at
`uFlip` strength: 0.7 on `rim`, 0.8 on `real`, `?flip=` to override, ⚙️ sliders for strength and
falloff. `?paint=real` is the brief's stack on this source: a sharp clear-coat glint over a soft
sheen, flakes, the full Fresnel coat and the flip, with both bends cut to a quarter because the
bends are what smeared the layered look's reflection across a box. `?carbody=smooth` rounds the
bodies instead: the arched body's profile corners filleted (0.14) and its flanks bevelled (0.05,
because the arches reach to within 0.13 of the top), cabins and the cop's cab as rounded boxes,
normals softened across anything under 40 degrees (`softenNormals`), and the paint material
lit from those normals rather than flat-shaded. Smooth bodies are not a default.

**`real` is the default** (2026-10-17). It dropped its sky reflection (coat 0; it washed the taxi pale, Tyler 2026-10-17) for
**painted reflection streaks** (`STREAKS`): a box panel reflects one point of the sky edge to
edge, so instead each flank and end gets a horizon line, and every panel two diagonal bands,
keyed to the body's box and slid by the flank's facing so they move as the car turns. Their colour
is the sky's, lifted toward its own brightness, so they fade at night. `real` also doubles the rim
to 8 texels, capped at 0.5 world units (`RIM_MAX_WORLD`), so the doubling shows in close-ups and
play zoom keeps the rim look's width: uncapped, 8 texels at play zoom on a phone is 1.1 units, the
whole flank of a car. The rim and the streaks only go on car- and truck-sized bodies
(`gCarSized`); the harbour's ships wear the same paint and came out white under both. And it only
draws on a fragment the AO prepass drew itself: the helicopter, the plane and the river boats are
not occluders, so the ground behind their own pixel read as an edge everywhere and they came out
white. The gap is measured against the fragment's own plane carried along the step, so a
receding bonnet or roof is not mistaken for an edge (it striped the taxi's panels at 2x). ⚙️ "Reflection streaks" sets their strength (0.6 on `real`, Tyler's pick; 0 elsewhere).

**Cost.** Per glossy fragment: two hashes, the derivatives, and two more Blinn-Phong lobes per
light (one at play zoom, where the sparkle is skipped). Cars are a few percent of the frame, and
`?bench` has a `paint classic` row to put a number on it on a device; SwiftShader cannot.

## Camera

`src/game/camera.js`. A fixed 3/4 orthographic camera:

```js
VIEW_DIR = (1, 0.92, 1)   // looking down the +X+Z diagonal
DISTANCE = 400
zoom     = 52             // the *base* half-height
punch    = 1              // Loco Mode's push-in, a multiplier on it
viewZoom() = zoom * punch // what is drawn — vertical world span is exactly 2 * this
```

No player-facing zoom, and one fixed default framing — that's a gameplay decision, not a limitation.
A fixed frame is what makes every tap unambiguous. **On a desktop** (viewport at least
`NARROW_VIEWPORT` = 768px wide, `main.js`) the frustum is sized by height and the whole city fits, so
the camera never moves during play and drag-to-pan is off. **On a narrow viewport** — a phone, where
the city runs off both sides — the player can drag to pan (`attachDragPan`, below), and two
follow-cams trail the taxi: an ambient one from the first frame of a run and a faster one under
Loco Mode. What changes the zoom is cinematic and brief: a wreck or another ending pulls `zoom` in
(`focusOn`), and a held Loco Mode pushes `punch` in. (`attachCameraControls` — WASD and wheel zoom —
exists in `camera.js` but nothing in the game attaches it.)

**One thing turns it, and only during a cut scene.** `state.yaw` swings the view about world Y, and
it is zero for the whole of play. The crash replay ([traffic.md](traffic.md#the-replay)) sets it
with `cutTo` for its swung cuts and hands it back at zero. Everything that is the arithmetic of the
fixed view is wrong while it is off zero: `BILLBOARD`, `RIGHT`/`UP`, the sightline's `RISE`, and the
clouds' ring placement. That is acceptable only because the replay hides the HUD, freezes the world
and frames the crash too tightly for any of it to be in shot. Anything that wants a turned camera
during play has to redo all of that first. **Anything converting between world units and the frame reads `viewZoom()`**, not
`state.zoom` — the two differ for as long as the pill is held, which is exactly when the taxi is
moving fastest and a marker sized off the wrong one drifts furthest from what it is marking.

**Two things override the fixed framing**, both by smooth-following the taxi and both on narrow
viewports only. `controller.followXZ` in `camera.js` closes a fraction `1 - exp(-dt * rate)` of the
gap per frame toward its aim, so the chase is framerate-independent. That aim is a little *past* the
taxi rather than on it — see [leading the car](#leading-the-car), which also covers why the ease's own
trail is cancelled rather than left in. Neither follow has a gate on the way *out*: the camera is
left wherever it landed rather than snapping back.

- **The opening follow**, at rate **1.5**. A run starts with the camera trailing the taxi and keeps
  doing it until the player takes the framing over — a swipe past `PAN_SLOP`, or a tap on a
  rider-finder chip. A swipe keeps it for good; a chip tap only borrows it, and hands it back at
  the end of [the peek](#the-rider-peek). It exists for the same reason drag-to-pan does: in portrait the fixed framing
  has already given up, so a run otherwise opens with the taxi off-screen and the player's first job
  is hunting for their own car. Gentler than the boost chase because it is ambient and runs for as
  long as it is left alone — at 1.5 the camera drifts after the taxi rather than locking to it, and
  a turn at the edge of frame doesn't whip the city round.
- **Loco Mode**, at rate **3.2**, which outranks it. Active only while `boost.isActive()`, and it
  ignores the player's takeover: a drag during boost is quietly overridden on the next frame, because
  panning is a planning gesture and boost is the opposite. The press also clears the takeover, so the
  camera stays on the car after the button comes up: still at 3.2 through `boost.isEngaged()`'s
  one-second tail and any drift kick still being carried, then the opening follow, until the player
  swipes again — the release is the moment a drift's exit kick fires, and a follow that stopped
  there would let the kicked taxi drive straight out of frame.

Both aim [past the taxi rather than at it](#leading-the-car).

### Leading the car

A follow centred on the taxi spends half the frame on road already driven, and under Loco Mode that
is the expensive half — the mode exists to cover ground, and the player was paying for it by swiping
ahead by hand, mid-boost, which is the one moment panning is the wrong gesture. So the follows aim
*past* the car and the car settles into the trailing quadrant: heading north-west it sits south-east
of centre with the north-west of the map opened up in front of it. On a portrait phone at the Loco
Mode top that is **52 → 68 world units of road ahead**, about three quarters of a block.

`followXZ` takes an `aim` — `{ x, z, gain, speed }`, a ground heading and a strength — and
`followAim()` in `main.js` builds it from the taxi's yaw and speed. `gain` is the speed against the
Loco Mode cruise ceiling (`boostCruise()`, 22.1 u/s by default — a function rather than a
constant since the ⚙️ panel can move it), which is what lets one number serve both
follows: full offset at the boost top, about 45% of it at ordinary cruise, and **dead centre at a
standstill**, where there is no "ahead" to look down and the player is reading the junction they are
sitting in. A caller that says nothing — the tutorial, whose first bubble is *pointing* at the car —
gets the car centred, and a standing offset eased back to zero rather than merely frozen.

**The offset is stated in screen space and converted back**, which is the whole reason `frameLead`
isn't three lines. A fixed world-space lead — what the passing lab uses, where the road runs due east
and nothing else is possible — buys wildly different amounts of visibility per heading here, for two
compounding reasons: the view is a diagonal, so a ground step up-screen is foreshortened to
`VIEW_DIR.y` = 0.55 of one across it; and the frustum is sized by *height*, so a portrait frame is
roughly 2:1 the other way. Multiplied out, the same world lead is worth ~4× more of the frame going
one way than the other — so the world distance has to stretch from **7.2 units across-screen to 28.6
up-screen** to hold the picture still. `tools/probe.mjs` asserts that ratio, and asserts the framing
itself by projecting the taxi through a real portrait frustum at eight headings.

Two details carry the rest of it:

- **The follow's own trail is paid back.** An exponential ease settles `v / rate` behind whatever it
  chases — 5.8 units at the Loco Mode top on rate 3.2, pointing backwards along exactly the axis this
  is trying to open up; left in, the boosting taxi sits past centre and the follow shows less road
  ahead than a static frame would. And the two follows run
  at 1.5 and 3.2, so the same speed trailed them by different amounts and the framing shifted on the
  Loco Mode press — the one frame the player is certain to be watching. Cancelling it is what makes
  `LEAD_FRACTION` a fact about the picture rather than an opening bid.
- **The offset eases on its own clock** (`LEAD_RATE` 2.4), slower than either follow. It swings
  through 90° at every corner, and at the follow's own rate that lands as a shove sideways at the
  moment the player is reading a new street. At 2.4 the frame opens into the turn over about half a
  second and never overshoots — measured at 30.6% of a half-frame through a junction taken at the
  boost top, against a 30% steady state.

Near the map edge `followXZ`'s clamp to `±HALF_SPAN_X` / `±HALF_SPAN_Z` absorbs the lead, which is correct: there is
nothing further out to frame. And a peek's ride home still lands exactly on the car — the follow then
eases the frame back open ahead of it, which is a drift rather than the snap the tracked aim exists
to avoid.

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
`didPan()` so the picker can swallow the click that closes out a drag, and it clamps the target per
axis (`PAN_LIMIT_X`/`_Z`, the half-spans; east reaches a further `0.7 × HARBOR_REACH` so the harbor
can be panned to), so the map can never be pushed off screen with nothing left to steer back by.
Drag-to-pan is also on at any width in debug mode, so the audio panel's placed sounds can be
auditioned. History: [how the follows used to end](rendering-history.md#camera).

### Loco Mode's push-in

The frame tightens by **`LOCO_PUNCH = 0.76`** while Loco Mode is held, and eases back out on the
release. An orthographic camera has no field of view to widen, so the whole of "the lens reacts" is
the frustum: everything on screen grows by 1 / 0.76 and the city crowds in. It is a change to the
frame, not to the framing — the taxi stays at exactly the same place in the picture, because
[the lead](#leading-the-car) is stated as a fraction of a half-frame and scales with it.

**It answers a hold, never a tap.** Releasing mid-spend is a designed input — a short tap costs a
short slice of fuel, see [boost.js](../src/game/boost.js) — so the pill gets jabbed constantly, and
a push-in keyed on the press popped the frame on every one of them. `boost.heldSeconds()` is the
clock and `LOCO_PUNCH_HOLD = 0.25s` is the line between the two gestures: a jab is over before it
elapses and the frustum never moves at all. That threshold is also **dead time between the press and
the reaction**, which is why it is not larger: it is twice a touchscreen tap (80-120ms is typical,
200ms a slow one), and under about 0.2s it stops being a gesture test and becomes a race. Once earned it survives the [momentum
tail](traffic.md#boost-crazy-taxi-mode) (`isEngaged()`), so feathering the pill — letting go and
grabbing it again inside the second the taxi is still at full tilt — holds the frame still instead
of breathing it out and back in. Earning it always takes a hold, though: the latch can stay on through a tail,
never switch on during one.

**In hard, out on the car's own clock — 9 and 3.** The rate is half of whether this is visible at
all: the eye reads the *speed* of a scale change far more readily than its size. At 9 the push-in is
63% there in 0.11s and done inside 0.35s, so the whole move lands under the wheelie and the flame
rather than arriving after them.

What stops that being a **cut** is that it still spans frames: the steepest frame at 60fps covers
**14% of the move**, seven or so frames of travel. That fraction — not a percentage of the frame —
is what `tools/probe.mjs` asserts, because it is the claim that survives the next retune. The way
out is a third of the speed, and that one is not taste: it has to outlast the momentum window
(`BOOST_COOLDOWN`, 1s) the taxi spends coasting its speed cap down, so the width comes back as the
speed does. Any quicker and the frame is full-width with the car still doing 30, which reads as the
mode ending early.

The depth and the rate are one decision: 24% dribbled out over a second is a frame that drifts, and
24% in one frame is a cut. History: [the three settings it took](rendering-history.md#loco-modes-push-in).

**What bounds the depth is look-ahead**, since the lead is a fraction of the frame and shrinks with
it: at the Loco Mode top on a portrait phone the road ahead goes from **124 world units to 94**,
against the `GHOST_RADIUS = 46` at which a hidden car
[lights its outline](#nearby-traffic-ghost-outlines--gamecarghostsjs) and the `PITCH` of 20 between
junctions. Still twice the warning radius and four junctions of road — but this is the one constant
here with a **floor** under it rather than a preference: past about 0.6 the frame edge closes on the
distance the outlines are warning at, and the mode starts hiding what it is about to hit.

`punchZoom` sits **outside the priority list** below rather than in it: it decides how tight the
frame is, not where it points, so it composes with whichever claim owns the target that frame — the
same shape, and the same reason, as `updateShake`. It gives way only to the opening vignette and the
end-of-run focus, the two claims that set the zoom themselves.

**It is narrow-only**, like the follows, and for a sharper reason than theirs: the desktop framing is
*sideways*-tight, not vertically tight. Measured across 12 seeds, the city reaches **92.5% of the
half-frame across a 4:3 desktop** at `PLAY_ZOOM` and only 77% of it up-screen — so the push-in would
carry its edge to 122% and crop the map outright, permanently, since drag-to-pan is off above
`NARROW_VIEWPORT`.

`tools/probe.mjs` drives the gesture at 60fps against a real frustum, because neither half has a
tell in a still: a tap must leave the frustum bit-for-bit untouched, a hold must actually arrive at
the constant, the steepest frame must not read as a pop, and the release must give all of it back.

### The rider peek

A tap on a rider-finder chip (`?chips=on` only now — see [finding the next
rider](gameplay.md#finding-the-next-rider)) takes the camera to that rider — narrow viewports only, same rule as
everything else here — **holds them in frame for a beat, and then rides back to the taxi**. It
**pans rather than cutting**, and it is a different curve from either follow above:
`controller.glideTo(x, z)` starts a one-shot tween, `updateGlide(dt)` steps it from the frame loop,
and it retires itself on its own clock. `controller.peekAt(x, z, getReturn, onArrive)` is the whole
round trip, and it is what a chip tap actually calls.

A cut costs the player the one thing the fixed camera was chosen to give them. With the whole city
no longer in frame, a teleport leaves them re-reading a screen of near-identical blocks to work out
which way the map moved and whether the rider now under the chip is the one they tapped. Riding the
move across keeps the city continuous.

**And it comes back**, because showing the rider is a glance rather than a destination. The taxi is
already driving at them on the same tap; leaving the camera parked on the kerb means the player
watching an empty corner while their own car is off-screen somewhere, so every chip tap ended in a
drag back across the map by hand — the same distance the pan had just saved them, on a clock that is
draining. The three legs are one glide, so they all sit at the same rung of the priority list below:

| Leg | What it is |
|---|---|
| **Out** | The pan to the rider's kerb corner. Ordinary `glideTo` curve and duration. |
| **Hold** | `PEEK_HOLD = 0.9s` sitting dead still. Long enough to read who is waiting and where, short enough that it never feels like being *shown* something. Measured against the legs either side: much under this and the camera reads as arriving and immediately changing its mind. |
| **Home** | Back to the taxi — whose **destination is re-read every frame**, because it has been driving the whole time. A leg aimed once at the start lands on the patch of road the car left; over a typical peek that is about 5 units out. |

The tracked aim is also what makes the handover clean. At the end of a smootherstep the camera is
moving at exactly the tracked point's speed, so it lands *on* the taxi already travelling with it —
`panToRider`'s `onArrive` then clears `cameraTakenOver`, handing the framing to the opening
follow-cam with no gap to close and nothing to snap. Handing it back matters as much as the trip
does: park the camera on the car instead and the car simply drives out of the frame the peek just
spent a second putting it in.

`onArrive` fires **only if the whole sequence runs out**. Everything that outranks a pan drops the
peek where it stands — a finger on the map, a boost chase, a wreck — and the callback never comes,
so a player who swipes away mid-peek keeps the camera they took rather than having the follow-cam
tow the map off it.

**A tween, not the exponential ease the follows use.** `1 - exp(-dt * rate)` leaves at its highest
speed on the very first frame — right when you are closing a gap that keeps reopening, and most of
the way to a snap when you start from a dead stop. The easing is **smootherstep**
(`k³(6k² − 15k + 10)`), which zeroes acceleration as well as velocity at both ends; plain smoothstep
still shows its start as a flick over a move this short.

Duration is **distance / `GLIDE_SPEED` = 150 u/s, clamped to 0.32–0.75s** — so a hop to the next
block and a cross-town pan both travel at a legible speed, without a short pan degenerating back
into a snap or a long one leaving the player watching the camera with a clock draining. The clamp
ceiling binds past 112 units; the city's full diagonal is 141.

It sits at the **bottom of the camera priority list** — [the closing shot](#the-closing-shot), then the two follows, then this
— and it is *dropped*, not paused, by anything above it: `followXZ` and `focusOn` both clear it, as
does `panBy`, so a finger on the map wins on the frame it lands rather than fighting a tween that is
still writing the target. All three legs live in the one `glide` field for exactly that reason —
every existing handover drops a peek the way it always dropped a pan, with nothing left half
sequenced behind it. The tap that starts a peek also takes the camera over, so the opening follow is
out of the way for the whole flight. The **dispatch doesn't wait for the pan** — the fare's clock is
draining, so the taxi leaves on the tap.

`tools/probe.mjs` asserts the ease-in (first frame moves far less than a linear step), the exact
arrival and self-retirement, the distance-scaled duration and both clamps, and that a drag mid-pan
kills it. The peek is walked leg by leg against a stand-in taxi driving a straight line: that it
pans out first, that it then sits still for about a second, that it lands on the moving car to
within floating-point exactness rather than near it, and that a drag, a boost chase and a wreck
focus each cancel the ride home *without* reporting an arrival. `tools/smoke.mjs` covers the same
round trip in a real browser, on the gap between the camera and the taxi: how far it ever got is the
evidence it visited the rider, where it ends up is the evidence it came home.

### Getting back to the taxi

The camera is the player's the moment they swipe, and it comes home on its own once they leave it:
**1.5 seconds with no touch on the map** (`CAMERA_RETURN_IDLE`, `updateCameraReturn` in main.js) and
it rides back to the taxi through the same `panToTaxi` the chip below uses, flash included, and the
follow-cam picks it up from there. Any pointer activity on the canvas restarts the count, a finger
resting on the map holds it, and nothing counts while another claim has the camera (a glide, the
tutorial, the vignette, the end-of-run focus). It runs on phones only, where the follow-cam does.
The 1.5 is a feel pick (it shipped at 3) rather than a measurement, and the trade it makes is with
[the edge arrow's look](gameplay.md), which was left off any timer because a player who rode out to
a fare may be reading the board with their thumb off the glass. `?camreturn=classic` leaves the
camera wherever the player put it, as it was before
([history](rendering-history.md#camera)).

That return is the whole answer by default. **The taxi-finder chip is off** (Tyler, 2026-10-20:
"get rid of the taxi button"); `?taxifinder=classic` brings it back, and the rest of this section
describes it as it behaves under that flag.

`src/game/taxifinder.js` covers the gap before that. The taxi can still drive off the
frame entirely, which on a phone is one look across town away, and dragging the map until the
yellow car turns up is a hunt across near-identical blocks on a clock that is draining. So while
the taxi is **completely** off-frame a chip of it fades in at the opposite end of the bottom row
from the rider chips, and a tap rides the camera back. Same affordance as those, pointed the other
way: they answer *who is waiting*, this answers *where am I*.

**The test is the whole silhouette outside the frame**, the car's on-screen radius included (2.79
world units, measured off the built mesh, times the live pixels-per-unit so a zoom change can't
shift it) — not "mostly off" and not "near the edge", because a chip offering to find something the
player can still see is one they learn to ignore. Two things keep it off the boundary: **14px of
hysteresis**, so a taxi tracking the frame edge doesn't blink it on and off, and a **0.4s dwell**,
so a car clipping a corner never raises it at all. It is armed off the *raw* frame rather than the
safe-area insets, unlike [the drop-off arrow](#off-screen-drop-off-pointer) — the canvas draws under
the status bar, so a car up there is on screen even with hardware sitting over it.

The camera move is `controller.chaseTo(getTaxi, onArrive)` — **a peek's ride home with no trip out**,
sharing its code. Same smootherstep and the same distance-driven 0.32–0.75s, because it is the same
kind of move: the player asked to be taken there, not teleported. The aim is re-read every frame, so
it lands on a car that has been driving the whole time and is already travelling at its speed, and
`onArrive` clears `cameraTakenOver` — the framing goes back to the opening follow rather than being
parked on a car that would drive straight out of it again. As ever, anything outranking a pan drops
the ride and the callback never comes.

The chip is **the car and a disc, and no ring**: a rider chip's ring is a clock, and the taxi has
none. So the ring's 49px outer diameter becomes the disc itself, which is what keeps the two bottom
corners the same weight. Inside it is the real `createTaxiMesh` lit by the city's own sun
(`mirrorSceneLights` in `game/avatarlights.js`, shared with the rider chips and the cargo chip), parked at the same
front three-quarter the tutorial's still avatar uses — the best-lit pose, at 0.84 of full sun. It
does **not** turn to the taxi's heading: at 44px a yaw is noise, and three quarters of the compass
would put the car's lit flank away from that camera and leave the chip a dark smudge for most of a
run. Which way to look is what the camera move answers.

**The car flashes when the ride lands** — the same white emissive lift on the same envelope a courier
box landing in it fires (see [the accept flourish](#the-parcel--geometryparceljs)), because it is the
same claim about the car: *this one, here*. On arrival rather than on the tap, and that is the whole
timing: the flash is over in 0.29s where the ride takes up to 0.75s, so firing it at the press would
spend it on a car that is still off-frame. It rides `onArrive`, so a swipe away mid-ride cancels the
flash along with the trip.

Armed only when nothing else has the framing: a run that has ended, a tutorial pointing at the city,
or a pan already in flight — including its own, which is what drops the chip on the tap.

### The closing shot

Every ending gets the same beat: the camera eases into whatever ended the run, the sim drops into
slow motion, and the run-end screen waits for both. It is one claim at the **top** of the priority
list — `controller.focusOn(endSpot.x, endSpot.z, endZoom, dt)`, which moves the target and the zoom
together on one rate so they converge in step — and it runs on **every** viewport, not only narrow
ones, because it is a cut scene rather than a driving aid. Only three numbers differ:

| Ending | Where it looks | Zoom | Slow-mo floor | Banner waits |
|---|---|---|---|---|
| **Wrecked** | the impact point | 26 | 0.18 | 2600ms |
| **Busted** | the taxi, with the cop that caught it already alongside | 26 | 0.42 | 2000ms |
| **Too Slow** | `fares.state.failSpot` — wherever the rider gets out | 30 | 0.40 | 3000ms |

The timeout is the odd one out and it is what the third row is for: nothing happens *to the taxi*, so
there is no impact to point at. What it has instead is the **rider**, who gets out and goes — the
`beginBail` animation a missed VIP has always had, reused verbatim for the ending
([gameplay.md](gameplay.md#they-leave-and-they-let-you-know)): out of the cab, `%#&@!!` overhead, a
fast run and a fade. `fares.js` names where that happens (`state.failSpot`) rather than main.js
guessing, because it is the same call that starts the bail. A rider aboard gets out at the **taxi**;
one who gave up waiting walks off their own **pavement corner** — the corner, not the junction
centre, because that is where the pin and its ring actually stand, and at this zoom the difference is
the subject sitting several units off frame centre.

The drop-off ring at the far end is left standing (`keepDestination` on `beginBail`), so the usual
way this goes — a trip that died within sight of the corner it was owed — has both in
frame. The rest of the board still goes, and the expired fare still leaves `state.fares`, so nothing
keeps ticking.

**The banner delay is sized off that animation, in sim time rather than its own.** `BAIL_SECONDS` is
2.2 and the delay is wallclock, so the slow-mo ramp has to be integrated to compare them: its first
`SLOW_MO_DURATION` = 2100ms averages a scale of (0.4 + 1) / 2 and spends 1.47s of sim, and the
remaining 0.73s runs at 1.0 — so the bail is ~2830ms on the clock and 3000 clears it with a beat to
spare. `fares.update` also keeps
ticking `updateExits` past `gameOver` for this; without that the bail freezes on its first frame.

The taxi **stops** for it, exactly as it does for a bust (`crashed`, the flag every loop in
`traffic.js` already skips): the run is over, and a car still driving a route to a fare that no
longer exists — out from under the rider climbing out of it — argues with the ending being shown.

Shallower slow-mo than a wreck and a wider stop on the zoom, both for the same reason: there is no
blast to stretch out and nothing on its way in, so the beat is a *held look* rather than a replay. At
wreck depth the city around the marker crawls with nothing to justify it, and at wreck zoom the
marker fills the frame and the junction it stands on — half of what makes it a place — is cropped
away. All the delays are wallclock, so the slow-mo never stretches the wait for the retry screen.

The `VIEW_DIR` diagonal has consequences elsewhere: screen-up is world `(-1, 0, -1)`, which is why
riders are placed on the `-X-Z` kerb of a junction — the block on the `+X+Z` side sits between the
camera and anything standing on it.

Because the camera is orthographic, world-units-per-pixel falls straight out of the frustum
height: `(2 * zoom) / clientHeight`. Drag-panning converts pointer pixels into world units with it
(`camera.js`). At play zoom 1 unit ≈ 7.7px, so effects that need to *read* at play zoom must be
sized against the camera, not by eye in a close-up.

History: [the old drop-off aim, the 2400ms delay, the timer ring and the invisible skid mark](rendering-history.md#the-closing-shot).

## Lighting

`src/game/scene.js` returns `{ scene, sun, hemi, sky, fog }`:

- **`sun`** — a directional light with shadows (`PCFSoftShadowMap`)
- **`hemi`** — a hemisphere light for ambient fill
- **`sky`** — the *material* of a sky dome, whose `topColor` / `bottomColor` uniforms are the only
  handle on sky colour
- **`fog`** — the haze, [below](#atmospheric-perspective)

The default is golden hour: 16:24, sun 28.5° up, `#CFBD8C` at 3.55 intensity over a 1.20 fill. Both
are held down to leave the shadow tint below something to work against — a bright sun over a bright
fill lights the shade almost as well as the lit faces, and a tint on it has nothing to bite on.
History: [where they started](rendering-history.md#lighting).

The ⚙️ panel drives all four live — the sun's colour and strength, and the fill's **two** colours,
`Fill sky` and `Fill ground`. Two because `hemi` is a hemisphere light and one well would only tint
the half of the scene facing up; a single "ambient colour" would leave every underside the colour it
already was, which reads as a broken control. Touching any of them stops the day-cycle clock, which
would otherwise overwrite the change on the next frame.

### Aiming the sun — `aim` in `game/daylight.js`

The hour drives two separable things — where the sun *is* (`elevationAt`, `azimuthAt`) and what the
light *looks like* (the keyframe colours) — and one slider for both cannot say "golden hour, but with
the shadows coming from over there".

`Pin sun` splits them. Pinned, `apply()` takes the direction from `aim` and leaves everything else on
the clock: the sun's colour and power, the fill, the sky and the haze all keep cycling while the
shadows stay where they were put. `Sun bearing` runs the full 0–360° — the arc only ever sweeps 10°
to 175°, and reaching the three quarters of the compass a day in this city never visits is the whole
point of the control. `Sun height` runs `MIN_ELEVATION` to 90°.

**Pinning deliberately does not stop the day cycle**, unlike every other manual control on the panel.
Those all fight the clock for one value, so they have to take it away from it (`takeManualControl`);
this one takes a value the clock then has no further opinion about. A day running its colours through
a sun that stays put is the point of the pin, not a contradiction to resolve. Both sliders track the
arc live while unpinned, so they always read where the sun actually is, and moving either one pins it
— no ticking a box first to make the control do something. Unticking `Pin sun` snaps back to the arc
at the current hour.

Two bounds worth knowing:

- **`MIN_ELEVATION` (6°) is a floor on the pin as well as on the arc.** Below it the light is under
  the ground plane and throws its shadows *upward* through everything; at 0° exactly every building's
  shadow is infinitely long and the map goes solid dark.
- **A low sun throws shadows longer than the shadow camera's own extent** (`MAX_SPAN * 1.05` in
  `scene.js`), so the far end of one can be clipped. The arc has always had this at dawn and dusk;
  the pin just makes it reachable at any hour.

### Thin casters — `sinkShadowCaster` in `game/scene.js`

`sun.shadow.bias` and `normalBias` are the *city's* numbers, and the city is boxes: a building's
shadow map records a far wall a long way behind the face being lit, so there is nothing for the
depth compare to get wrong. A **bridge** is the one caster in this game that is a thin shell which
also receives, and it self-shadowed — a band of blue acne smeared down the deck that reads exactly
like z-fighting, and got reported as it.

The arithmetic is in `scene.js` beside the constant. The short version: one shadow texel is 0.123
world units, the depth it records slides by `texel × tan(incidence)` across its own width, and a
soffit up to 70° off the light slides further than the 0.35 that separates it from the deck above.
An arch physically *cannot* shadow itself here — 16° of peak grade against a 28.6° sun — so all of
it is spurious.

The fix is per-mesh rather than another turn of the two light-wide knobs, because those would pay
for one bridge with peter-panning on every car in the city: bias −0.0026 clears the deck and
detaches a car's shadow from its wheels by 0.82 units, about 6px at play zoom. `sinkShadowCaster`
instead pushes the mesh's shadow geometry **back along the sun's own rays** — parallel rays, so
the silhouette it stamps on every receiver is pixel-identical and only the recorded depth moves.
The direction is free: the shadow camera is orthographic and looks down its own −Z, so in view
space the rays *are* the Z axis and one `mvPosition.z -=` needs no uniform to track the day cycle.

It applies to the three fixed spans (`main.js`) and the drawbridge's leaf (`game/drawbridge.js`).
Nothing else should reach for it without redoing the trade — see the note on the function.

### The shadow tint — `SHADOW_UNIFORMS` in `util/geo.js`

`Shadow colour` and `Shadow tint` push everything the sun doesn't reach toward one hue — a cool blue
against a warm sun by default (`PALETTE.shadowTint`), which is the colour contrast the hemisphere
fill alone cannot give you: the fill lights shade in the *sun's* family of hues, so sun and shade
differ only in brightness.

Applied at **0.65** out of the box (`SHADOW_TINT` in `util/geo.js`), not the full push: at 1.0 the
shade takes the tint's hue outright and the city reads as lit by two coloured lamps, which loses the
*material* of what is in shadow — a red brick wall and a grey one go the same blue. Two thirds keeps
each surface's own hue legible underneath while still opening a clear warm/cool split.

Two decisions worth keeping:

- **The shade factor is a ratio between the two light terms, not a shadow-map lookup.** Three only
  defines `getShadowMask()` for `ShadowMaterial`; pulling that chunk into a Lambert works and costs
  a second full PCF loop per fragment, on a game that runs on phones. Both halves of the lighting
  are already in scope at `lights_fragment_end`, and fill-over-total answers the question directly.
  It is scale-free, so nothing has to be told the sun's current power and it tracks the day cycle on
  its own — at midnight the sun is at 0 and the whole city reads as shade, which is correct.
- **It tints unlit faces as well as cast shadows, on purpose.** A cast shadow is not a different
  kind of dark from a wall the sun is behind; tinting one and not the other reads as a bug rather
  than as art direction. The knee (0.45) was measured off the parked lighting when the fill was 1.50
  — sun 3.55 against it put a fully lit face at 0.30 and anything the sun misses at 1.00. At today's
  1.20 fill a lit face sits at 0.25, still under the knee, so lit faces stay exactly where they were
  and only the shade travels.

This is the one patch in `patchProp` that is **not** behind a build-time flag — it is part of the
shipped look rather than an opt-in mode, so there is nothing to gate. It would not deserve a flag
either way: it costs a dot product and a mix rather than a texture fetch, and at amount 0 that mix is
against `1.0` and the frame comes out bit-identical to an unpatched one. Hence `propMaterial()`
patches unconditionally.
History: [when it only patched on request](rendering-history.md#the-shadow-tint--shadow_uniforms-in-utilgeojs).

## Atmospheric perspective

A soft haze over the back of the frame, so a block at the top of the screen sits behind some air and
the one under the taxi doesn't. Without it every façade is drawn at identical contrast however far
off it is — which is the one cue this projection cannot get any other way, since parallel lines stay
parallel and a distant block stays the same *size*, so nothing in the drawing says "further".

It is three's ordinary `THREE.Fog`, placed **around the 400-unit standoff** rather than from zero.
View-space depth here is `DISTANCE - (p - target)·VIEW_DIR`, which runs 335 at the near corner of the
map to 465 at the far one — a perfectly good gradient. Over that band `Fog(near = 0, far = 1000)`
varies by a few percent end to end and reads as a flat wash; put the near/far band around the
standoff and the ramp lands on the picture. History: [the note that said an ortho camera couldn't
have fog](rendering-history.md#atmospheric-perspective).

Two things fall out of the fixed camera and make this better behaved than fog usually is:

- **The gradient is vertical, exactly.** `RIGHT · VIEW_DIR` is zero — `(1,0,-1)·(1,0.92,1)` before
  either is normalised — so moving across the screen changes nothing about how far away a point is.
  Depth over the ground plane is a function of **screen height alone**, at
  `DEPTH_PER_SCREEN_UNIT` = 1.537 units of depth per unit of frame height (`camera.js`). The haze
  bands the picture rather than pooling around wherever the camera is aimed.
- **The frame carries its own depth band.** The camera and its target move together, so the bottom
  edge of the screen is always at depth `DISTANCE - zoom * DEPTH_PER_SCREEN_UNIT` — 320 at play
  zoom, whatever the player has panned to. Anchoring `near` there means the near edge of the picture
  is clear on every viewport and at any pan, and the haze can never creep forward onto the taxi.

`HAZE_TOP = 0.19` is the mix at the **top of the play frame**, and `hazeRange()` derives the two
planes from it by inverting smoothstep — `far` is a ramp length rather than a distance anything is
drawn at. Tuned against the city rather than by eye in a close-up: the top of the frame is at depth
480 and the far corner of the map at 465, so the frame edge is very nearly the haziest thing there
can ever be (the corners measured 0.132 against 0.17, 0.78 of it). Strength and colour trade
against each other: a wash with no chroma has to be laid on thickly before it says anything, while a
saturated sky blue says it at less. Past about 0.3 the back of the city starts reading as *weather*.

**Linear, not `FogExp2`.** Exponential fog is a distance from the eye and this eye is 400 units from
everything: any density strong enough to read across the city also puts a few percent of wash on the
nearest pixel — a flat whitening. Linear fog has a
hard zero, and smoothstep's ease-in spends most of the ramp on the far half of the frame, so the
near half stays untouched and the haze gathers behind it.

### The colour — `hazeColor()`

Derived from the sky on every keyframe change, never carried as a tint of its own: a haze that is a
*function* of the sky cannot drift away from it, and one picked at golden hour and left alone is a
pale blue wash over a midnight city — lighting the back of the board *brighter* than the front,
which is the cue running backwards.

**It is not the horizon.** `skyBottom` is #DCEDF7, a near-white — 27 points of spread between its
highest and lowest channel, deliberately so ("going paler, not white"). Mixed into `concrete`, the
commonest façade in the city, it lands on neutral grey. A haze with no chroma of its own can only
take chroma *away*: a value wash, which is half of atmospheric perspective with the recognisable
half missing. History: [the horizon haze it shipped as](rendering-history.md#the-colour--hazecolor).

Two steps, both about getting chroma back:

- **Sample the dome high.** `HAZE_SKY_H = 0.73` reads the sky dome's own gradient — the same
  `pow(h, SKY_EXPONENT)` curve the shader runs, which is why that exponent is exported — instead of
  taking its bottom colour flat. The horizon band is the *least* chromatic part of any sky, being
  where multiple scattering has washed the blue back out, and a column of air seen from 400 units up
  a 33° diagonal is not that band. (At 1.0 the sample would be the **zenith** exactly:
  `pow(1, exponent)` is 1, the lerp is a no-op, and the haze is `skyTop`.)
- **Give the chroma back.** Saturation lifted in the working space with the hue untouched, so a
  change here can only restate the sky's own colour more strongly. HSL→RGB cannot leave the cube for
  any saturation ≤ 1, so this can't clip a channel or bend a hue.

**×2.5 is past the clamp, deliberately.** `skyTop` measures 0.585 saturation at the parked hour where
`getHSL` measures, so anything from ×1.71 up pins it to fully saturated — 1.8, 2.0 and 2.5 all give
the same `#4AC6FF`. The effective rule is "take the sampled sky colour to full saturation", and the
number is a ceiling rather than a multiplier: to see it move you have to come *down* past 1.7, not up.

**The trade-off, stated plainly: the higher up the dome this samples, the less the haze tracks a
sunset.** At the zenith it does not track one at all — at 18:36 the dome runs orange at the bottom
and deep blue at the top, and the far city would go blue while the horizon behind it is still
orange. 0.73 is most of the way up: the parked hour still gets its blue (`#77CFFF`, against
`#4AC6FF` at the zenith — paler and a little greener, 136 points of blue-over-red rather than 181),
while a dusk sample comes off the part of the dome that is at least on its way toward the horizon.
Anyone who wants dusk back outright has one slider to move — Sky sample down to ~0.35 restores a warm
`#C17059` there, at the parked hour's expense.

The near/far separation was measured on a rendered shot, as mean blue-minus-red per band (the
*difference* is what atmospheric perspective is; raw chroma is the wrong metric because a warm city
mixed toward blue passes through neutral on the way). That table was taken at the earlier zenith
sample and 0.17 strength and wants re-taking — it is in the
[history](rendering-history.md#the-colour--hazecolor); the claim it makes, that the back of the city is a different
*colour* from the front and not just a lighter one, survives the move to a stronger but paler haze.

`PALETTE.fog` is the parked 16:24 answer, and what a scene built without a daylight module keeps.

### Unlit means unfogged

`propMaterial()` and `unlitMaterial()` (`util/geo.js`) are a pair, and the second one exists for
this: **anything that doesn't take the sun doesn't take the air either.** Every game marker, every
flat-colour effect, and the handful of lamps and rotor discs a light source has no say over.

It is the same argument that made those materials unlit in the first place. A fare's disc is painted
in that fare's clock, and a ring at the back of the board is the one the player is furthest from and
most needs to read; a wreck is meant to look identical at midnight and at golden hour. Both survive
the day/night cycle *because* nothing in the lighting reaches them — and fog is lighting. Hazed, a
marker across town would report a colour between its own and the sky's, which for a marker whose
whole content is its hue means reporting the wrong time remaining.

The **crystal is the one lit exception**: it is Lambert, it already carries an emissive so a dark
city can't take its hue away, and it sets `fog: false` for the same reason. The rider it floats over
is hazed like every other figure on a kerb — a person is scenery, the clock is not.

`tools/probe.mjs` asserts both halves: the disc, the pad, the crystal and the sky dome all refuse the
haze while `propMaterial()` takes it, and a **source scan** fails on any bare
`new THREE.MeshBasicMaterial` under `src/` that didn't come through the helper. The one exemption is
an invisible raycast box, which draws nothing there is anything to fog.

The rest of the probe's coverage is the placement, re-derived from a real frustum rather than read
back off the fog object: the bottom edge of the play frame at exactly zero and the top at exactly
`HAZE_TOP`, both unchanged by a pan to the map edge; no corner of the city hazier than the frame edge
it was tuned against; a wreck close-up spanning less haze than the play frame; and the colour
the colour built hue-for-hue from the sky at every keyframe, carrying real chroma wherever the
horizon is itself near-neutral, and staying *warm* at dusk. Getting the band wrong gives you either a
flat wash over everything or nothing at all, and both look like "the fog didn't work" in a
screenshot; getting the colour wrong looks like the game going black-and-white in the distance.

### Tuning it

The ⚙️ panel (`?debug`) has a **Haze** section with all three knobs live — two planes and a colour on
a fog object, so unlike the AO lookup there is nothing to recompile and they can be plain sliders.
All three want to be live: every one is a judgement about a whole frame that can't be made from the
numbers, and the only way to know whether the back of the city has separated from the front is to
watch the front stay put while the back moves.

| Control | Writes | Range |
|---|---|---|
| **Strength** | `HAZE_TOP` via `setHazeTop()` | 0 – 0.5, default 0.19 |
| **Sky sample** | `hazeTuning.skyH` | 0 (horizon) – 1 (overhead), default 0.73 |
| **Chroma** | `hazeTuning.saturation` | 1 – 2.5, default 2.5 (past the clamp) |
| **Haze colour** | *readout* | the derived hex, for pasting into `PALETTE.fog` |

The two colour knobs live on the exported `hazeTuning` object rather than as constants, which is
what lets `hazeColor()` pick them up on its next call — so a tweak survives a running day cycle
instead of being overwritten by it. The panel rebuilds the colour off the dome's **live uniforms**
rather than calling `daylight.apply()`: apply() rewrites the sun's colour and intensity too, so
tuning the haze would silently discard a sun picked by hand two rows up. The readout is refreshed
from `refresh()` so it keeps up while the cycle drives the sky underneath it.

At **Sky sample 1, Chroma 1** the colour comes out as `skyTop` exactly — the arithmetic stated in
one line, and what the probe pins the whole derivation against.

### Past the edge of the map — `city/horizon.js`

The island does not end any more; it fades. Past the west towers and past the north park the grid
carries on, block after block on the city's own pitch, and each block is more sky than the one
before it until there is only sky. Tyler, 2026-10-14: "fill in with some more buildings then some fog
to obscure the edge. Wanna create the illusion that the world goes on forever."
`?horizon=classic` puts the bare edge back.

- **Its own haze, not the scene's.** The scene's fog is a function of screen height (above), so it
  cannot thicken past the coast without thickening over the top of the playable city by the same
  amount. This one is a function of where a fragment stands on the ground: the distance outside the
  last street to the west (`lineX(-2)`) and the corner's last street to the north, ramped to opaque
  over `HORIZON_GONE` (92). Nothing on the island wears it. It feathers out over 14 units on the two
  sides that face the sea (south of the south shore's line, east of the north park).
- **It fades to the sky, exactly.** What the edge used to dissolve into was the dome, and the haze
  colour above is deliberately *not* the dome. So each fragment finds the point of the dome behind it
  — the camera is orthographic, so that is one ray along the view axis to the dome's sphere
  (`SKY_RADIUS`, `SKY_DROP` in `game/scene.js`) — and runs the dome's own gradient there, reading the
  dome's own uniform objects. The day cycle, Rain Mode's grade and the ⚙️ sky sliders move it with no
  wiring, and at full haze it is the sky's own pixel, at dusk as at noon.
- **Painted windows.** The towers are plain boxes (some with a set-back crown); the patch darkens a
  grid of storey-by-bay cells on every wall, found from the screen-space normal. That is the one
  detail that still says *building* through the haze, and it costs nothing in geometry.
- **Cheap on purpose.** One mesh, one draw, ~2.3k triangles, no shadow cast, no AO, not in the
  entrance wave (it is the world the island stands in, so it is already there while the island
  builds). It receives the sun's shadow where the map reaches. `?bench` has a "horizon off" row.
- **Every street stays open.** Blocks sit on the grid's pitch, so each street of the city runs on
  out through the haze as a clear corridor; `tools/check.mjs` holds that, and that no block stands
  on the island's own land. The river row is left as open ground.
- **Heights stay out of the aircraft's way.** West of the island the skyline carries on under
  `WEST_SKYLINE`, as the west towers do; north of the park it stays under 19, because the
  helicopters transit at 22 and nothing keeps them out of the north.

History: [the bare edge](rendering-history.md#past-the-edge-of-the-map).

## The render path — `game/renderpath.js`

The frame's shape, in one module so two pages can draw it: the game and the model workshop's
bench ([workshop.md](workshop.md#the-bench)). `renderBudget()` reads the URL's rendering flags,
`decideLooks()` takes every decision `propMaterial()` compiles in (AO, Crayon, Cartoon, painterly,
the paint look, the rim, cloud shadows), and must run before any mesh exists. `createRenderPath()`
builds the passes below and settles `?hdr` against `?bloom`. Its `render(scene, cam)` runs one
frame in order: crayon sizing, empty-pool culling, the rain's mirror, the AO prepass, the rim's
depth, the bloom, the river's fog sync, then the frame (or the HDR composer) and the rain on the
lens. The game's weather and `?diag` ride in as optional extras. A change to how a frame is drawn
goes here, never into `main.js`'s `renderFrame`, or the bench stops showing what the game shows.

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
noise-then-blur output fights hard-edged flat shading anyway. [Crayon Mode](#crayon-mode--gamecrayonjs)
was the first thing to genuinely want a full-screen pass and it did not change that answer — it
reads this pass's spare channel and draws its page as one more object in the scene.

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
  prepass rather than contribute to it. The prepass swaps a mesh's material out wholesale, which
  strips exactly the flags that keep the ghost outline out of a normal pass — its mask writes no
  colour and its rim is a hull inflated 0.3 units past the car — so an unfiltered traversal draws AO
  around a silhouette bigger than the taxi. The invisible raycast boxes are the same story.
- **Anything lit by `propMaterial()` has to be in there.** A mesh that *receives* AO without
  *casting* it samples the occlusion of whatever stands behind it: a rider in front of a building
  would wear that building's contact line across their chest. This is why the riders are marked
  even though a figure is 23px tall.

The stop bars are the one deliberate omission — 0.05-unit road paint, whose own outline is not a
contact.

`markOccluder()` also enrols the mesh in the prepass's **draw list**, which is what the pass walks
to pick each mesh's depth material. That is why it is a list and not a `scene.overrideMaterial`: an
override is all-or-nothing, and one occluder in this game doesn't hold still. The city's
[entrance](city.md) animates entirely in its vertex shader, so drawn through the *shared* depth
material it stands at its finished size in the depth buffer while the colour pass shows it a third
grown — and because AO is sampled in screen space, the resulting contact crease lands on whatever is
actually visible at those pixels: bare road, under the outline of a building that has not risen yet.
`setOccluderDepthMaterial()` is how a mesh names its own.

That material is deliberately **not** `mesh.customDepthMaterial`, even though the sun's pass wants
the identical patched shader. Three's shadow map assigns `side` on whatever depth material it is
handed, flipping FrontSide to BackSide through its `shadowSide` table
(`WebGLShadowMap.getDepthMaterial`) — every frame, before the next frame's AO pass reads it. Sharing
one instance would leave the prepass stamping the depth of each building's *far* wall, which is AO
that is wrong everywhere rather than wrong for two seconds. Two instances carrying the same patch
cost one extra program.

Because the list holds a hard reference and writes a material onto every entry each frame, anything
that *disposes* an occluder has to hand it back with `unmarkOccluder()`. The roadworks slab
(`game/roadwork.js`) is the only thing that does.

The lookup itself rides in `propMaterial()` (`util/geo.js`) as an `onBeforeCompile` patch on
three's `<aomap_fragment>` hook, keyed in screen space off `gl_FragCoord`. It carries a
`customProgramCacheKey`, for [the reason the pie's fill does](#the-pie--geometrydiamondjs)
— this city is nothing but flat-shaded Lambert, and a patched material with no key gets handed
whichever program compiled first. Whether the patch is installed at all is decided by
`setAmbientOcclusion()` *before any geometry is meshed*, which is why `?ao=` is a URL flag and not a
panel toggle: switching it live would mean recompiling every program in the city.

## Crayon Mode — `game/crayon.js`

A hand-drawn look laid over the whole game: paper tooth in every fill, a soft graphite line down
every edge the city has, and a ten-a-second wobble so it reads as *drawn* rather than as a filter.
`?crayon` turns it on; it is off by default while it is being judged, and the ⚙️ panel has every
number in it live.

Three layers, and they are three different mechanisms:

| Layer | Where it lives | What it costs |
|---|---|---|
| **The page** | one quad in the main scene, `renderOrder` 1 | one draw call, two texture fetches a pixel |
| **The fill** | the patch on `propMaterial()` (`util/geo.js`) | two fetches per lit fragment |
| **The line** | a second output from the AO pass (`game/ssao.js`), inked by the same patch | four extra taps on a half-res pass, one fetch per lit fragment |

### Still no composer

This is the first thing in the project that genuinely wanted a full-screen post pass, and it still
does not get one. Both reasons the [AO pass](#what-it-costs-and-what-it-deliberately-does-not)
gives are unchanged: the frame's MSAA and the stencil buffer the
[ghost outlines](#taxi-ghost-outline--geometryghostoutlinejs) stamp into both live in the default
framebuffer, and rendering the city into a target to composite it back costs both. (`samples` and
`stencilBuffer` on a `WebGLRenderTarget` can buy them back under WebGL2 — at two full-size
allocations and a resolve, on a budget `game/recovery.js` exists to climb *down* from.)

So the page is **an ordinary object in the scene** whose vertex shader writes clip space directly
and ignores every matrix — the same trick the AO quad uses, hoisted out of a render target and into
the transparent queue.

**Its `renderOrder` of 1 is the whole legibility argument.** The queue sorts by that, and the
existing ladder is skid marks 2, dust 3, the route band 4, the drag handle 5, flames 6, the fare
rings 7-9. At 1 the paper covers the city and the sky — every opaque object, since the opaque queue
draws first regardless — and *nothing the player reads a number off*. A fare's ring is a clock and
its hue is the time remaining; a beige wash over it reports the wrong one.

### The page — one tile, baked in code

`bakePaper()` writes a 256² RGBA8 `DataTexture`, which is the project's first texture. The
nothing-visual-is-loaded rule survives — it is generated in code like every mesh — and it is baked
from `valueNoise2D`/`fbm` in `util/rng.js` at a **fixed seed of its own**: the page does not reseed
when the city does, so a screenshot pair taken across a change to the buildings differs by the
buildings.

Four channels, because four things want different frequencies out of one fetch:

| | Content | Read by |
|---|---|---|
| `r` | tooth, 2px cells | the fill's grain, and the skip in a stroke |
| `g` | fibre, 32px blotches | the page, the fill's coarse patchiness |
| `b` | an uncorrelated per-texel draw | the line's wander |
| `a` | long fibres, stretched | the page |

Every field is **periodic at the tile size**. `valueNoise2D` grew a `period` argument for it —
sampled with `RepeatWrapping` in screen space, a field that does not close on itself puts a hard
seam every 256 pixels across the picture, which reads as a grid over the whole city. `probe.mjs`
measures the step across the wrap against the step between ordinary neighbours.

**Screen-locked, not world-locked.** The grain stays put when the camera pans, which is the
"shower door" artefact everywhere else and is the entire point here: the drawing is on paper and
the paper is the screen. And it is sized in **CSS** pixels — `gl_FragCoord` is in device pixels, so
a tooth stated in texels halves on a DPR-2 phone and stops reading at all.

### The fill — after the colour space, before the haze

The patch on `propMaterial()` splices its body in ahead of `#include <fog_fragment>`, and that seam
is a decision rather than a convenience. By then three has run `<opaque_fragment>`,
`<tonemapping_fragment>` and `<colorspace_fragment>`, so `gl_FragColor` is in display space — where
a paint-like multiply belongs, and where "mid-tone" means what an eye means by it — and the haze
has *not*, so a stroke at the back of the city fades into the air exactly as the façade under it
does. Hooked one chunk later, at `<dithering_fragment>`, the same ink would draw at full strength
across a hazed skyline.

Everything is keyed off `gl_FragCoord`, which is not a shortcut: `bakeColor()` strips every
attribute but position and normal, so there is no uv to reach for.

- **The tooth is weighted to the mid-tones** by `4·l·(1−l)`. Wax is patchy where it is thin and
  solid where it is piled up, so a flat amplitude both dirties the highlights and lifts speckle out
  of the shadows — the two places a drawing has neither.
- **Quantisation is luminance only**, and off by default. Hue is content in this game — a ring is a
  clock, yellow is the player's car, cyan is a parcel — and `probe.mjs` asserts measured hue
  separations between them, so `rgb` is scaled by a scalar and every channel ratio survives. It is
  also the one lever here that fights the existing look: this city's lighting idea is one lit face
  per building, and a hard step across that face flattens the thing the sun is doing.

### The line — a texel, not a radius

The AO pass already had a spare channel: `util/geo.js` reads `.r` and nothing read `.g` or `.b`. So
the edge rides in `.g` of the same texture, and the same fetch the fill already makes.

**It cannot reuse the occlusion's own taps.** A depth Laplacian at radius R answers over a band 2R
wide, and the rings are 1.0 and 0.4 *world* units — 7.7px and 3px at play zoom, double that at the
close framing — so every silhouette would wear a fifteen-pixel fringe. History:
[the first version, which did](rendering-history.md#the-line--a-texel-not-a-radius).

The line is its own pair of taps at **one texel** of the half-res buffer, and the honest cost is
four extra fetches on a pass that was making nine. Two things fall out of that:

- **A pen does not get wider because the camera zoomed out.** The band is one texel — about two CSS
  pixels — at every zoom.
- **The threshold means world units of departure from flatness, not a fraction of a radius.** A
  *step* registers the same however close the camera is; a *smooth slope* registers less as one
  texel spans less world. That asymmetry is exactly what stops a facet-covered canopy inking as
  moss while a building's corner still inks.

The estimator is `|a + b| / 2`, unsigned and summed. Either tap on its own is large everywhere —
flat ground recedes by `cot(elevation)` = 1.54 units per unit of offset — so a one-sided test inks
the open road solid. The sum cancels on any plane however steeply it recedes, which is the same
property the occlusion is built on, and what is left is silhouettes (one tap on the far plane), the
convex arrises the occlusion clamp throws away, and creases.

`EDGE_LOW = 0.15` and `EDGE_HIGH = 0.90` are placed against the features either side of them, and
`probe.mjs` recomputes all three from `VIEW_DIR` rather than trusting the numbers:

| | Step | Reads | |
|---|---|---|---|
| Stop-bar paint | 0.05 | 0.05 | under the floor — its edge is not a contact, and inking it sprinkles the open road |
| Kerb | 0.35 | 0.32 | faint, and wanted: the pavement's edge is one of the first things anyone draws in a street |
| Building arris | — | 1.69 | saturated |
| Car roofline | 1.6 | 1.47 | saturated |
| Against the sky | — | hundreds | saturated |

The lookup then **wanders** by up to `wobble` CSS pixels, sampled from the page's uncorrelated
channel at a low screen frequency, so the stroke bends off straight. And it is broken up by the
**coarse** fetch rather than the fine one: the tooth is 2px, so modulating a line with it dithers
the stroke pixel by pixel and the whole thing reads as noise along an edge rather than as a mark.
At a fifth of that frequency the skips run eight or ten pixels, which is a crayon lifting off the
page.

The ink is a **warm graphite, never black** — a crayon's darkest mark is paper showing through a
pile of pigment. It is set through `convertLinearToSRGB` because it is mixed in after
`<colorspace_fragment>` has run, where a `THREE.Color` built from a hex string is not.

### The boil

`floor(t · 10)`, hashed into the noise offsets. **The rate is the whole feature**: at the frame
rate it is television static, held still it is a decal stuck to the screen, and ten a second is
about where an eye reads a redrawn line. It takes **undilated** time — the slow-motion ramp at the
end of a run is a statement about the sim, and a drawing does not slow down because a taxi did —
and it is skipped on a paused frame, which is right: a held frame is a held drawing.

Shot mode ticks the loop once and freezes, so every screenshot renders step 0. That needs no
`settle()` only because the step is set at construction rather than on the first update — the same
trap the [ground discs](#the-fare-marker--gamefaremarkerjs) fell into, avoided by opening on a real
value instead of zero. `crayon.prepare()` is called from `renderFrame()` rather than the frame
loop, for the reason the AO pass is: shot mode and `__taxi.redraw()` both reach a render without
ever reaching the loop.

### What it costs, and where it is switched off

`?crayon` is a URL flag rather than a panel toggle for the same reason `?ao` is: the paper fetch is
compiled into every prop material before a mesh exists, so switching it live would mean recompiling
every program in the city. The ⚙️ panel tunes its uniforms; it does not turn it on.

The two flags are **independent**, and that is deliberate: **Android defaults to `?safe`, which
sets `?ao=off`** — so on the platform most likely to be asked for a drawn look, the depth buffer
the line is traced out of would not have been built at all. `createAmbientOcclusion` therefore
takes `edges` as well as `enabled`, and runs the pass for either; with occlusion off the strength
uniform is pinned to 0 and the occlusion multiply is never compiled into a material. All four
combinations key to different programs, which `probe.mjs` checks — this city is nothing but
flat-shaded Lambert, and a second independent flag makes the
[cache-key trap](#the-pie--geometrydiamondjs) twice as easy to fall into.

### What it is not doing yet

Written down because each is a real gap rather than a taste:

- **The sky is still sky.** The page is a wash and the dome is behind it, so the top of the frame
  reads as blue paper rather than as paper with a sky drawn on it. Pushing the wash far enough to
  fix that takes the city's colour with it — a low-chroma beige laid over everything can only take
  chroma away, which is the argument [`hazeColor()`](#the-colour--hazecolor) makes about a haze
  with no hue of its own.
- **The stroke is soft.** Its source is half-res and its estimator is a one-texel Laplacian, so it
  is a two-pixel smudge rather than a confident mark. Cross-hatching in the shadows, and a stroke
  with a direction to it, are the two things that would move this from "drawn on" to "drawn".
- **Nothing hatches.** Shadow is still shading, not line.

## Cartoon Mode — `game/cartoon.js`

Cel-banded light, ink on every edge in the city, and a **heavier** ink around the things the player
has to track. `?cartoon`, off by default, independent of `?crayon`, and every uniform in it live on
the ⚙️ panel.

Two mechanisms, because the two jobs are genuinely different:

| | The world | A hero |
|---|---|---|
| **How** | the screen-space edge in `.g` of the AO pass | an inflated back-face hull |
| **Where it draws** | on the object's own pixels, inward | outside the silhouette, outward |
| **Catches** | interior creases too — a setback, a kerb, a roof fold | the silhouette only |
| **Weight** | ~1 CSS pixel, everywhere | `HERO_RIM` 0.22, and the taxi 0.30 |

A screen-space line can only paint where a lit material runs, which is *inside* the thing it is
outlining. On a car 24px wide at play zoom, a line thick enough to pull it off the road eats a
fifth of the car and takes the paint that says which car it is. A hull draws outward, and takes its
thickness per object rather than per screen. So the vehicles get hulls, the city gets the line, and
**the difference in weight between them is the whole feature** — a hero reads as a hero because its
outline is half again everything else's.

### The bands

Spliced in after `<lights_fragment_end>`, which is the first point `reflectedLight.directDiffuse`
is finished — shadow map included. Earlier and the terminator bands a raw N·L with a soft shadow
laid over the top, which reads as neither cel-shaded nor lit.

It quantises a **ratio against the albedo**, not a colour: dividing the direct term by the
surface's own luminance recovers roughly the N·L times the sun, which is what a toon ramp is
actually about. Banding the colour instead would put the terminator at a different place on a dark
brick than on a pale concrete. Scaling `rgb` back by a scalar leaves every channel ratio — every
hue in `palette.js` — exactly where it was, which is the same guarantee
[the crayon's fill](#crayon-mode--gamecrayonjs) carries and for the same reason.

**Flat shading is what makes this clean.** Every facet has one normal, so N·L is constant across it
and a band edge can never crawl over a surface. The one thing that does vary per fragment is the
shadow map — so what the bands actually cut into hard steps is PCF's soft penumbra, which is the
cartoon look arrived at for free.

### The hero outline, and the two ways it was wrong first

Both of these rendered without an error and had to be caught by looking at the screen.

**One hull per vehicle, on its body — not one per part.** Outlining every lit mesh under the taxi is
the obvious thing and it is wrong twice over. A cartoon outlines an *object*; its interior part
boundaries are the thin line's job. And a rim stated in world units is a fraction of a body and a
*multiple* of a trim strip: the taxi carries two 3.46 × 0.54 × 0.54 bars down its flanks, and a hull
around each inflates the thin axes by two thirds and lays a black bar the whole length of the car on
both sides. Eight hulls on one taxi rendered as a black brick with yellow showing through the cracks
between them. So `outlineRoot` takes the biggest solid lit mesh by bounding-box volume and nothing
else — on the taxi that is the shell at 13.5 cubic units against 1.0 for a bar and 0.85 for a wheel,
not close. The wheels then sit inside the body's hull on every axis but a sliver under the front
valance, which [`carghosts.js`](#nearby-traffic-ghost-outlines--gamecarghostsjs) already measured at
~0.4 units.

**A scale-inflated hull is not an offset surface, and the taxi is not convex.** `inflatedGeometry`
scales about the bounding-box centre, so the *cabin* grows too — and the hull cabin's rear wall ends
up standing over the real boot, higher than it, therefore nearer the camera, therefore passing an
ordinary depth test and painting the boot black. Measured on the shipped taxi: hood and boot both
went solid, leaving yellow in curved slivers around the wheel arches.

The fix was already in the repo. The rim is masked out of its own silhouette exactly the way
[the ghost outline](#taxi-ghost-outline--geometryghostoutlinejs) masks its own — pass 1 stamps the
body's screen footprint into the stencil with `ghostMaskMaterial()`, pass 2 draws the hull with a
"not that footprint" test — and what survives is the part of the hull sticking out *past* the car.
Which is what a cartoon outline is.

Two things differ from the ghost's rim, both deliberate:

- **An ordinary depth test.** The ghost draws only where something is in *front* of the hull,
  because it is a see-through-walls signal. This is ink on a visible car and has to be hidden by the
  tower the car drives behind.
- **Fogged, unusually for an unlit material.** `unlitMaterial()` turns the haze off because a
  marker's hue is its content. An outline is the opposite kind of object — part of the drawing of
  the city — so it sits behind the same air as the car it wraps. Left unfogged, the back of the
  board becomes a mass of hard black over hazed pale buildings: the depth cue running backwards.

Its two tiers sit at **9980/9981, below the ghost outline's four**. The stencil buffer is never
cleared mid-frame, so the ordering is the contract: these stamp and resolve first against nothing
but their own masks, and the ghost tiers then stamp their own — a superset, since a ghost masks
every part of a vehicle where this masks only its body — and resolve exactly as they did before.

### The fleet

The ambient traffic is instanced, so its outline is two sibling `InstancedMesh`es per pool that
**share the source's own `instanceMatrix` object** — not copies. Traffic writes every car's
transform into it once a frame and three uploads a buffer per attribute rather than per mesh, so the
whole fleet outlines for two extra draw calls and no per-frame matrix work at all. A copy would mean
walking every car every frame to duplicate a matrix that already exists, and one that fell a frame
behind would show as ink sliding off the cars.

Three pools carry one: car bodies, truck cabs, truck boxes. `count` is the one thing that has to be
synced by hand — three assignments a frame — because three does not watch it and traffic moves it at
runtime, when a truck spawns and when the ⚙️ car slider is dragged. Left behind, a hull draws the
fleet's high-water mark: collapsed matrices at the world origin, a knot of ink under the middle of
the city.

Both pools and the source must also agree about culling. Three caches an `InstancedMesh`'s bounding
sphere from the matrices as they stood on the first frame it culled it, so a rim that survived a
frame its mask was culled on would draw as a *filled* silhouette rather than an outline.

### Order against `markOccluder`

**Outline after marking occluders, never before.** A hull is an opaque, colour-writing mesh, so
`markOccluder` would happily enrol one — and a hull in the depth prepass stamps a silhouette a rim
bigger than the car, which leaves the city's own screen-space line tracing the *outline* rather than
the vehicle. `tools/probe.mjs` asserts the occluder list is unchanged by outlining.

### The rim is a uniform, not a bake

The inflation lives in the **vertex shader**, not in the geometry: `outlineGeometry` bakes
`2 · (p − centre) / size` into an `aInflate` attribute and the hull's material offsets by
`aInflate · uToonRim`, floor-clamped, in `begin_vertex`.

That is exactly what `inflatedGeometry` produces — its per-axis scale about the bounding-box centre
puts a vertex at `p + (p − centre) · 2r / size`, which is *linear in r*, so one attribute reproduces
every width. `tools/probe.mjs` asserts the two agree to 1e-7 across three rims.
History: [the baked rim](rendering-history.md#the-rim-is-a-uniform-not-a-bake).

It is done that way because a rim baked into vertices is a rim you cannot scrub — moving it means
rebuilding a geometry per hull while a slider is being dragged. And the weight of an outline is the
one number here nobody can settle from a still: it is a judgement about how hard a car should shout
against a city, and it needs the game running and a hand on the slider. Everything in the ⚙️
panel's Cartoon section is now live, including both rims.

**The direction comes from position, never from normals.** Every mesh here is non-indexed and
flat-shaded, so a shared corner is several vertices carrying several normals; offsetting along
those tears the hull open at every hard edge. `aInflate` is a function of position alone, so it
agrees across a corner — the same argument [`jitterVertices`](#the-low-poly-look) makes one layer
down, and the probe checks it by looking for duplicated corners that disagree.

The material carries `customProgramCacheKey`, and this is the case the rule exists for: it is a
plain `MeshBasicMaterial` in a project full of them, so without a key of its own a hull is handed
whichever unpatched basic compiled first — and then draws at rim zero, invisible, with nothing
logged.

### The numbers

`HERO_RIM` is 0.22 and `TAXI_RIM` 0.30, in world units, and the ceiling on both is what a *car* can
carry rather than what looks bold in isolation. An ambient car is 1.8 units across and about 24px at
play zoom, so every 0.1 of rim spends 8% of its width: at 0.30 a third of the car is ink and the
paint that says which car it is has gone. The distance between "outlined" and "blacked out" is two
tenths of a unit wide.

The taxi's rides the taxi group's own `TAXI_SCALE` of 1.18 on top, landing at 0.35 world units —
about 2.7px, half again the traffic's, and it is the one object on the board that is *the player*.
`clampRim` caps any rim at a third of the part's smallest dimension, so one number can describe the
look without doubling a small part it also lands on — and with a live rim that clamp runs **per
write**, against each part the slider is reaching, rather than once at construction. Dragged past
what a truck's cargo box can carry, the box stops at its own ceiling and the car bodies keep going.

The two rims are **separate sliders**, and that is the mode rather than a convenience: a hero reads
as a hero because its ink is heavier than everything else's, so a single number would collapse the
only distinction being made.

### What it is not doing yet

- **No rim light and no hatching.** Borderlands' other half is hand-painted ink and hatching in the
  diffuse art; this has the lines and the bands and none of the drawn texture.
- **The hull's silhouette is not a uniform offset** of the car's, because bounding-box scaling
  isn't one — the ink is a little heavier over the cabin than along the flanks.
- **The bands are subtle at the shipped `steps` of 3**, since golden hour already puts most of a
  facade in one band. It is a slider for exactly that reason.

## Painted streets — `game/brushtiles.js`, `PAINT_*` in `util/geo.js`

The road surface carries dry-brush strokes, each a little lighter or darker and a little red or
blue, so the asphalt reads as painted rather than flat grey. `?painterly=classic` turns it off.

- **The strokes** are a 256² tile painted in code at boot (`paintRoad`), every dab drawn at its
  eight wrapped neighbours so the tile is seamless, all on one heading. The ground's fragment
  shader (`PAINT_KIND` 2, set by `brush(mesh, 2)` in `main.js`) reads it in world space every 12
  units and only on dark, non-green pixels, so kerbs, paint and lawns are left alone.
- **Direction.** The tile is read as (x, z) on an east–west street and (z, x) on a north–south one.
  At a junction one road runs straight through and the other's strokes fade out over 3 units at its
  kerb: the arterial wins, and between two of a kind the east–west road does, so a main street keeps
  one heading across the map. The arterial lines reach the shader as two bitmasks
  (`uRoadArt`, filled in `setPaintBrushes` after the layout exists). Splitting each box along its
  diagonals was the first cut and drew a pinwheel in every junction.
- **Patches.** Two octaves of value noise at a ~16-unit cell fade the strokes in and out, so some
  stretches are brushed and some are bare, and the 12-unit repeat never lines up down a whole
  street. The ground brush tile read at a big scale was tried first and came out as streaks.
- **What was tried and is dialled to 0** (still in the source, behind uniforms): a reddened,
  saturated shadow terminator and cool shadow core after Valve's TF2 paper (read as a glowing
  outline), a darker wall foot, and strokes on walls, roofs and lawns (read as dirty). Baked colour
  blotches cost 1.2M extra vertices and were dropped outright.
- **Compiled per brush, not branched on.** The brush kind is a `#define` (`paintPlan` in
  `util/geo.js`), and the terminator and wall foot only compile while their uniforms are above 0,
  read when three compiles the material. As a uniform `if`, every prop in the city carried the road
  path's two noises and three tile reads; `tools/gpucost.mjs` put that at a third of a SwiftShader
  frame, and pulling it out took the frame down 16% with every pixel unchanged. Inside the road path
  the tile reads are skipped wherever the fade mask, the lawn hold or the lane-paint hold is 0. So
  a tuning panel that turns the terminator or the foot back on has to rebuild the materials.

## Rain Mode — `game/rain.js`

`?rain`. An exploration and off by default: the city on a wet afternoon. Five layers, plus one
change to the physics:

- **The grade.** `daylight.setGrade(rain.grade)` grades every keyframe *before* anything reads it,
  so the haze and the clouds follow for free. The day's own colours are pulled toward the `rain*`
  palette entries, scaled by the day's own brightness so a rainy night is still night. How hard is
  the mood's (`MOODS` in `game/rain.js`, [below](#two-moods--the-sun-shower-and-the-night-storm)):
  the default sun shower keeps 115% of the sun and 105% of the fill with the haze at 0.26; the
  night mood drops the sun to 15% and the fill to 72%, with the haze at 0.34 against 0.19 dry —
  past the point where scene.js says the back of the city stops reading as air and starts reading
  as weather, which is the point there.
- **Wet ground.** The ground mesh's own `propMaterial`, patched on top of whatever AO or look mode
  is already there and keyed `…-wet`. It uses a screen-space face normal (`dFdx`/`dFdy` of world
  position, because the material is flat-shaded anyway) to find up-facing surfaces. The asphalt
  (y below 0.08) darkens to 58%. Pavement gets about 60% of that and grass half again. A
  two-octave noise field lays puddles on the road only.
- **The reflection.** The whole scene is drawn a second time at half resolution through the main
  camera mirrored about y = 0. Under an orthographic camera this is exact, with no reflector plane
  and no oblique clip: the ground reads the mirror back at its own `gl_FragCoord`. A mirror flips
  handedness, so the pass also flips x in the projection to keep front faces front-facing, and the
  ground samples at `1 − u` to undo that. A global clipping plane at `CLIP_Y` 0.03 removes the road
  and its paint, which lie *on* the mirror plane and would otherwise cover everything. The
  pavement survives and reflects as its own kerb. The pass reuses the frame's shadow map, binds a
  white AO texture (the real one is a map of the *main* view), and hides the sky dome, the rain
  and the bloom/crayon overlays. Its clear colour is `rainReflectSky`, a long way darker than the
  sky — mirroring the sky itself turns every street into a pale wash with its paint gone. The ground
  blurs the read over nine taps along screen y, the way lights smear on real wet
  asphalt, and wobbles it with procedural ripple rings. A puddle is the same read with almost no
  blur and 0.72 gloss, against 0.3 for bare asphalt.
- **Rain and splashes.** 14,000 instanced streaks and 2,600 point-sprite crowns. Both animate
  entirely in the vertex shader off one clock, wrapped in a box around the ground point under the
  middle of the frame, so a pan never runs out of weather and the CPU does nothing per drop.
  Depth-tested, so rain falls *behind* buildings.
- **The lens.** After the main render, the frame is copied to a `FramebufferTexture` and drawn back
  through drops on the glass: small beads that appear, sit and dry, a few large ones, and two
  sizes of drop that stick and slip down the screen, each trailing a tapering wet streak and
  stranded beads. Each is an inverted lens with a darker rim and a catch
  light. This is a copy plus one fullscreen triangle, not a composer, so the main render keeps its
  MSAA and its stencil. The copied frame is already display-space and the shader writes it back
  untouched.
- **Grip.** `setGrip(GRIP)` in `sim/traffic.js` scales `brake()` and `hardBrake()` by 0.6. Cars
  plan their stops against the same function they brake with, so the wet lengthens every stop
  instead of making anyone run a red. Measured with `tools/taxi.mjs 30` and `tools/signals.mjs` at
  grip 0.6: 0 red-light violations, minimum gap 5.30 (5.57 dry, `MIN_GAP` 5.3), throughput 6.97
  against 7.14.

History: [the first reflection and the first rain build](rendering-history.md#rain-mode--gamerainjs).

### The passing storm — `?storm`, `game/storm.js`

`?rain` is a still frame. `?storm` runs a storm across the ordinary afternoon on a 145-second loop:
30 s clear, 35 s clouding over, 45 s of storm, 35 s clearing. The clock is pure and gives three
levels, and `applyWeather` in `main.js` hands them out every frame:

| level | follows | drives |
|---|---|---|
| `dark` | the sky's envelope | the grade (`rain.grade` via `daylight.apply`), the haze (0.19 → 0.34), the city's lights (`setCityLights`), the headlights (`setRunningLights`, on over `dark` 0.25–0.42) |
| `rain` | the envelope read 7 s late going in and 7 s early going out, so it always trails the cloud | the streaks' opacity, the share of splash slots firing, the lens drops (which dry off over ~12 s) |
| `wet` | the rain, up with a 5 s time constant, down with 14 s | the ground's gloss and puddles, the mirror pass, the grip (1 → 0.6) |

Three things make a storm arriving read as weather rather than as a crossfade:

- **The sun goes first.** Its power falls at 1.4 times the rate of `dark`, so shadows soften and
  vanish while the sky is still only half grey.
- **The lights come on one at a time.** Every lit pane and every lamp carries an `aLitAt` threshold
  and fades on when `dark` passes it, over a ramp of 0.08 (about half a second under a squall's
  edge); a quarter of them, picked off a hash of their anchor, sputter for the first 0.14 past their
  threshold instead (`litOn` in game/citylights.js, timed off `dt` so shot mode freezes it). Shopfronts go at 0.08–0.5, street
  lamps close together at 0.28–0.5 (a photocell), and homes and offices across 0.2–0.95. It is one
  shared uniform, and it reaches the bloom's copies of those materials because `markEmissive` chains
  the source's `onBeforeCompile`.
- **The streets stay wet after the rain stops,** 20% as the sky finishes clearing, 7% halfway
  through the sunny stretch and 2% when the next storm comes.

The mirror pass and the lens copy are skipped while there is nothing for them to show. That is
most of the cost of the mode back during the clear stretch. The mirror still renders once on the
first frame, so its clipped programs compile before the first cloud rather than on the frame it
arrives. The streaks and splashes are faded rather than hidden for the same reason.
History: [streets that never dried](rendering-history.md#the-passing-storm--storm-gamestormjs).

#### Two moods — the sun shower and the night storm

The default peak is a **sun shower** (`MOODS.shower` in game/rain.js). `?storm=night` and
`?rain=night` pick the **night storm** instead — most of the way to night, the lamps doing the work,
too dark to play in as the default. History: [the first storm](rendering-history.md#two-moods--the-sun-shower-and-the-night-storm).

- **The clouds do the dimming, not the sun.** In the shower the sun keeps 115% of its power and
  most of its warmth. A drifting cloud field (`CLOUD_UNIFORMS`, `CLOUD_GLSL` in util/geo.js) dims
  only the sun's *direct* light, down to `uCloudFloor` 0.3 under cloud. It is compiled into every
  `propMaterial()` when a storm is on (`setCloudShadows`). The result is sunlit patches sliding
  across the city with the wind, with everything between them lit by the sky. It runs before the
  shadow tint, so cloud shade goes cool the way the sun's own shadows do.
- **The field had to be stretched.** Two octaves of value noise bunch tightly around 0.5, so at a
  cover of 0.56 only about a tenth of the city was in sun. It is stretched ×2 about its middle, and
  the threshold maps cover 0..1 over the stretched range (−0.65..1.65) so that 0 really is clear.
  The shower peaks at 0.46.
- **Shafts.** 40 additive quads ride the wind at exactly the field's own drift, so each one stays
  over the patch of ground it stands on. Each is lit only if the field says there is a gap at its
  foot, and only while there is cloud around it (cover > 0.08). They point at the sun.
- **Sunlit wet ground glints.** A warm lift on wet ground, in proportion to the direct light the
  fragment actually received, so building shadows inside a sunlit patch stay shadows (sampling the
  cloud field instead would light straight through them). It is not a specular highlight: the sun is
  behind this camera, so a true one could never face it.
- **The night mood:** sun to 15%, the cloud lid closed (cover 1.05), and no shafts or glint.

The mirror pass sets `uCloudViewInv` to the mirror camera for its render, because the field is
placed in world space through whichever camera is drawing.

`?storm=0.6` pins the storm at that level for screenshots. `__taxi.storm` exposes `pin(v)`,
`seek(t)` and `state`.

### A squall — the default weather, `game/squall.js`

**On in every run** (`getSquall` in util/shot.js), except in shot mode, safe mode, or under
`?rain`/`?storm`; `?squall=off` drops it. The crossings draw from the run seed (`runSeed + 733`).

The other kind of weather is one rain cell crossing a sunny city, not the whole sky changing. A
cell comes in over a corner and crosses to the one opposite in `CROSS` 75 s, with a sideways slip so
crossings take different lines. Then there are 25 s of quiet before the next one, from a different
corner. `?squall=0.45` pins a cell that far along a crossing. It also fast-forwards the wet map from
the start of the crossing, so a still frame shows the trail.

Everything that was a level in the storm becomes a position here:

- **The cell's footprint** is a soft, ragged disc: core radius `CELL_R` 30, soft edge `CELL_EDGE`
  14, and its edge noised over time. It exists twice, as `cellFront`/`cellMask`/`cellShade` on the
  CPU and `cellFront`/`cellRain`/`cellShade` in `CLOUD_GLSL`, built from the same hash, so the grip
  under the taxi agrees with the rain on screen. Keep the two in step.
- **The front arrives in order** (`RAMP` in game/squall.js, passed to the shaders as `uCellShape`
  and `uCellLight`). At ~3.6 u/s an edge is about 4 s at one point, and the three things a storm
  does are laid out across ~12 s of it: the shade first, from 3.2 edges out to full at 0.6; the
  lights through the darkening; then a drizzle, a quarter of the rain from 1.6 edges in; then the
  downpour over the last edge. Leaving, it runs backwards. Each cell also comes up to strength over
  the first tenth of its crossing and dies away over the last, so its shade does not snap on over
  the corner it starts beside. `?squallramp=classic` puts all three back on the same ~6 s.
- **Cloud shade.** Under the cell, `CLOUD_LIGHT` cuts the sun's direct light by 88% and the sky's by
  30%, by `cellShade`, well past the rain itself, because the cloud is wider than what falls out of
  it.
- **Rain and splashes** follow `cellRain` at each drop's position. In the drizzle a streak either
  falls or does not, each against its own share, so the band is a quarter of the drops rather than
  every drop at a quarter of its alpha; a drop that is not falling is clipped in the vertex shader
  rather than drawn transparent. Their wrap box closes in around the cell out to the drizzle's edge,
  2 × (radius + 1.6 edges) + 20 across, and carries drops by its area, so the downpour is as dense
  as it was in the first front's 108-unit box.
- **The wet map** is a 96² grid over 170 units of island. It soaks toward the footprint with a
  3 s time constant and dries with 45 s — any faster and the trail is half gone by the time the cell
  is halfway across, so the rain reads as drying the ground behind itself. The grid is uploaded as an
  R8 texture each frame, and the ground multiplies its wetness by it (`tWetMap`). Every other mode
  binds a white texel, so the lookup is one code path. Ripples follow the *rain* and not the wet
  map: a drying street is still, and only the street being rained on moves.
- **The lights.** Windows, lamp heads and lamp pools take the larger of the city-wide level and
  the shade where they stand, read over 0.15–0.95 of it (`litLevelAt` in game/citylights.js;
  `squall.lightAt` on the CPU). Each one still has its own
  threshold, so a block lights up pane by pane as the cell arrives. The level is read at each
  light's **anchor** (`aLitXZ` — a pane's centre, a lamp's post), never per vertex: the footprint's
  22-unit edge varies across one pane by more than the ramp, and read per corner every window wiped
  on from one side as the edge went over it. Car headlights come from
  `setRunningLightsAt(fn)` in sim/traffic.js, per car from its own position, half way through the
  city's lights.
- **What stays global:** a faint grade (`SQUALL_GREY` 0.2), building as the cell comes within
  `SQUALL_NEAR` (60 units) of its shade's edge from the middle of the frame and full with it
  overhead (`squallNearness` in main.js), the grip
  (read under the *taxi*, so every car brakes as the player's patch of road does), and the lens
  drops (on while the *taxi* is under the rain — it is the taxi's windscreen — or within `LENS_REACH`
  (15 units) of its edge, easing in over 0.5s and clearing over 5s once it drives out,
  `LENS_WET`/`LENS_DRY_SQUALL` in main.js; the frame
  centre stands in only before the taxi exists).
- **Mirror pass.** It runs while any of the map is wet (`maxWet`) and is skipped when the whole
  island has dried.

History: [the wet map's first drying rate, and windows that wiped on](rendering-history.md#a-squall--the-default-weather-gamesqualljs).

### Autumn, and the leaves a squall strips — `autumnBase` in `city/props.js`, `game/leaves.js`

The city is in autumn: about two thirds of the broadleaves have turned gold, orange or red, the
rest stay green. Which colour is a hash of each trunk's position, so it moves no tree and spends
no draw; `?fall=off` puts the summer back. The three turned colours are held to a narrow band
(luma 96–148, saturation 0.50–0.55, and the "red" is a rust at hue 15°) so no turned tree reads as
too extreme beside everything else. `?foliage=classic` brings back the first, stronger set; see
[history](rendering-history.md#autumn-and-the-leaves-a-squall-strips--autumnbase-in-citypropsjs-gameleavesjs).
Parks, medians and courtyards all grow the same tree, so
the season is set once on the module (`setAutumn`) before the city is built.

When the squall's cell reaches a park, its crown lobes shed leaves: most at the cell's **edge**
(the gust front strips the trees), a trickle under the core, a quarter as many off a tree that is
still green. A leaf drifts downwind along the cell's heading, swings side to side as it drops,
lies on the lawn for 5–8s and shrinks away. Park trees only. One `InstancedMesh` pool of 448
lit, double-sided cards behind `skipWhenEmpty`, so a sunny frame draws nothing; no shadow casting.
Leaves are drawn larger than life (0.75 units, ~6px at play zoom) because a 4px leaf read as rain.

### The city's lights — `game/citylights.js`, plus `setRunningLights` in `sim/traffic.js`

A wet street is mostly a mirror for *lamps*, and a daytime city has almost none — grey buildings
reflected into grey asphalt read as a filter. So the rain switches the city on:

- **Lit windows.** `collectPanes()` installs a sink in `city/buildings.js` (`setPaneSink`) for one
  `createBuildings` call and keeps every façade's openings exactly as they went to `facadeQuads`.
  About a third of the punched and ribbon panes get a glowing quad (warm, pale or a cool
  "screen"), as do three quarters of the shopfronts. Each quad sits `LIT_OUT` 0.045 off the wall:
  in front of the glass at 0.03, behind a door's surround at 0.06. The sink draws no rng, so the
  city is identical with it installed or not.
- **Street lamps.** Two per block on random edges: a post on the pavement, an arm out over the
  kerb, a glowing head (bloom `bay`), and an additive pool on the road. Posts and heads are stamped
  for the entrance wave and rise with their block. A post keeps 1.2 units clear of every doorway
  along the kerb, and off the bank's whole flight of steps (`entrances`: the building generator
  reports its doors through the pane sink as `kind: 'door'`); an edge with no clear spot in six
  tries gets no lamp. Placed blind, one landed on the bank's steps.
- **Headlights and tail lights.** `setRunningLights(1)` puts two white pods inboard of each
  vehicle's front indicators, which own the corners. The front indicator is narrower than the rear
  one (`turnSignalShapes`) so the headlight beside it still reads while it blinks; at full width the
  amber swallowed the lamp next to it. Each pod throws a cone of light (`coneGeometry`): open,
  additive, toed out and tilted down, hung off the lamp through the body matrix (on the taxi, its
  group, via `createTaxiHeadlights`) and cut by the road's depth where it meets it. It also gives
  every car a 0.6 floor on its brake pods, so it shows dim tail lights with a real brake still
  reading as a change. All of it is hidden while a car is a wreck. There is no pool on the road
  under the cones ([why](rendering-history.md#the-citys-lights--gamecitylightsjs-plus-setrunninglights-in-simtrafficjs)).

The lamp pools sit at 0.025, under the mirror's clip, so they do not reflect themselves. The
windows and lamp pools stay dark until the entrance wave finishes, so the city arrives and then
switches its lights on.

### What it is not doing yet

- **Nothing lights anything else.** The pools are additive decals, not lights, and the lamps cast
  no light on the cars passing under them.
- **Lamps are placed without asking what else is on the pavement,** so one can stand in a bus
  stop, a crossing's kerb ramp or the drive-through's apron.
- **Cost.** The mirror is a second full scene render: about 88 more draws and 120k more triangles
  a frame, at a quarter of the pixels. It clips with an oblique near plane and draws into a target
  flagged to take the screen's sRGB encode, so it runs the screen's own programs rather than a
  clipped variant of each (a clipping plane or an ordinary render target would each compile a
  different program from the screen's, and three re-resolves every lit material twice a frame):
  headless JS under `?squall=0.5` is 9.0 ms a frame against 7.7 dry. See `renderReflection`, and
  [history](rendering-history.md#what-it-is-not-doing-yet) for the iPhone numbers that forced it (#474).
- **No wet sheen on roofs or car bodies, and no ripples on the river.** (Tyres do throw spray now —
  see [wet tyres](#wet-tyres--gamesprayjs-plus-a-second-gameskidmarksjs-pool).)
- **Unlit markers on the road** (the route band, the target discs) are clipped out of the mirror
  with the road they sit on, so they do not reflect.

## Bloom — `game/bloom.js`, and the comparison in `game/hdr.js`

Spill around every self-lit thing in the game: brake pods and indicators on every vehicle, a
cruiser's light bar, the drive-through's lit windows and menu board, the depot's strip light. On by
default; `?bloom=off` takes it away, and the ⚙️ panel has every one of its numbers live.

### There is no HDR in this game to threshold

The obvious bloom is a bright-pass over the finished frame. Measured on a shipped frame at golden
hour, here is what a threshold would actually have to work with:

| | max channel |
|---|---|
| Sunlit building faces, kerbs, road paint | ~180–200 |
| The drive-through's lit windows | 255 |
| The fare ring, the route band, the taxi's roof sign | 250–255 |

Two things fall out of that. The first is that **the read-outs are exactly as bright as the lamps** —
a fare's ring is a clock and its hue is the time remaining ([gameplay.md](gameplay.md)), and a
threshold cannot tell it from a brake light. The second is that there is no headroom at all:
`renderer.toneMapping` is `NoToneMapping` and a white face in full sun computes to about 0.9 in
linear (sun intensity 3.55 through Lambert's `1/π`), so the whole picture lives inside 0..1 and only
0.08% of pixels ever reach 254. There is nothing above the frame to extract.

And it moves. `game/daylight.js` swings `sun.intensity` from 0 to 3.84 across a day, so every
surface in that first row walks up and down under whatever threshold was picked.

### So selection is a draw list, not a number

`markEmissive()`, opt-in, exactly the shape [`markOccluder()`](#the-occluder-rule) already has for
the AO prepass. A mesh is in the bloom because something said so.

That is also what makes it cheap, and the reason is a happy accident of how the lamps were already
built: **every emissive thing in this game is already its own mesh.** The light pods have to be, so
they can be switched by scale (`instanceColor` is paint and cannot carry an on/off — see
[traffic.md](traffic.md)) — and one pod per mesh rather than a pair, because a scale is about its
carrier's origin and a merged pair could only shrink toward the car's centre, which is a lamp that
*travels* as it dims rather than one that dims (`lightPodGeometry` in geometry/lights.js). The
lamps have to be, so they can be unlit. So the pass is a dozen draw
calls with no material surgery anywhere, and the instanced pods need no per-frame bookkeeping at
all — a pod that is off has already had its instance matrix collapsed to a zero scale, and a
degenerate triangle rasterises nothing whatever material it is wearing.

Marking happens in `main.js`, because `sim/` may not import from `game/` and the two vehicle modules
own most of the lamps; each hands its light meshes back the way the AO occluders are handed back.

### Adding something to it

**Nothing needs a special material.** There are only two ways a thing in this game is self-lit and
the pass reads both off the mesh it is handed:

| The mesh's material | What the pass takes as light |
|---|---|
| `unlitMaterial()` — flat or `vertexColors` | its `color` (times `vColor`) |
| A Lambert carrying an emissive | `emissive × emissiveIntensity` |

So if it is unlit it already qualifies, and if it is lit it qualifies to the extent it has an
emissive. What it needs is to be **named**:

```js
markEmissive(locoFlame.group, 'flame');
```

`kind` is a key into `BLOOM_INTENSITY` rather than a number, which is what gives the whole class one
slider in the ⚙️ panel instead of six sites answering "how bright is a brake light" separately. It
**traverses**, so a group is fine — most of what is worth glowing is one (the plume is three
coplanar tongues, a fare's disc is a rim, a fill and a sweep).

Three things it handles that a naive copy would not, each of which was a real thing in the way:

- **Materials that move.** The pass re-derives colour and opacity from the *live* material every
  frame. Without that the plume blooms while it is out (its opacity is animated: `material.opacity
  = heat`), and a fare's crystal blooms the urgency it was built with rather than the one on the
  clock — **its hue is the time remaining**, so a snapshot is not a small error.
- **Effects with a shader of their own.** The Loco kickoff burst multiplies a per-instance `aAlpha`
  into its alpha in an `onBeforeCompile` patch, and nearly every particle in the pool is dead at any
  moment. The pass inherits a source's patch and runs its own after it; without that the burst
  blooms as a solid disc of fire parked on the road.
- **Outlines hung off a lamp.** Every vehicle part wears a ghost outline — a mask and an inflated
  rim, attached as *children* — so the taxi's six light pods carry twelve between them. A traversal
  that took them blooms a hull three times the size of the lamp inside it. `isOutline` drops them:
  the mask by `colorWrite === false` (it has no colour to be light), the rim by name, the way
  `setGhostOutlines` already identifies them.

And one it handles by doing nothing, which is worth knowing because it looks like it should need
work: **a hue that lives in `instanceColor` rather than in the material.** The wreck's fireball
leaves its material white and writes its colour ramp per puff, so "what colour is this lamp" has no
answer in the material at all. `USE_INSTANCING_COLOR` is derived from the *mesh*, not the material,
so the pass's own material picks the ramp up on the same `InstancedMesh` — and the white it reads
off the source is exactly the identity that ramp multiplies. "Fixing" that is how every explosion in
the game ends up blooming white.

Where to call it from is the same split `markOccluder` has. Anything `sim/` or `city/` owns is
marked from `main.js`, because neither may import from `game/`; anything already in `game/` marks
itself, the way `game/roadwork.js` marks its own slab.

**`setEmissiveScale(root, 0..1)`** turns a marked object's glow down without unmarking it — for a
lamp that is still a lamp but should not be spilling right now. The one caller today is the fare
marker stepping back behind the rider in the car
([gameplay.md](gameplay.md#the-board-steps-back-while-the-seat-is-full)), and both of its properties
are the reason it exists rather than an `unmarkEmissive`/`markEmissive` pair: the markers are
**pooled** and switch several times a run, so a pair would dispose and rebuild a material per
transition; and it is a *scalar*, so the halo can be eased out rather than vanishing on one frame,
which reads as the marker being switched off rather than turned down. It folds into the pass's
intensity, so a scale of 0 leaves the draw list through `material.visible` exactly the way a kind
dialled to zero does — never by skipping the swap, which is the trap the next paragraph is about.

**What is in it today** (the calls are in `main.js` and the `game/` modules that mark themselves):
every vehicle's brake pods and indicators and the taxi's headlights, the cop cars' and the cruiser's
light bars, the city's lit windows (`window`) and street-lamp heads (`bay`) from
`game/citylights.js`, the drive-through's lit windows and menu board, the graveyard's glow, the
depot's strip light and neon, the L train's and the drawbridge's lamps, the Loco plume and its
kickoff burst, landing sparks, the building fire's flames, the wreck's fireball, and — quietly — a
fare's crystal and the disc under it.

**And one that is wired but ships at zero: the route band.** It is the third member of the
one-trip-one-hue trio and looks odd as the only one not lifted, so it was tried at 0.6 — already the
lowest number in the table. It fails on *area*, which is what this pass is least forgiving of,
because spill is a total rather than a peak. Isolated on shot 10 (`path` 0.6 against `path` 0, so
the band and nothing else) it lifted **4.1% of the frame by a mean of 52/255**, where every lamp in
the city together moves a fraction of one percent. The band stops being a wash you can read the road
markings through and becomes an opaque green swathe. It also fails the read-out test in its purest
form: **the band's alpha encodes distance along the route** — the head gap, the end fades, the
reveal sweep — and an additive accumulate saturates exactly where that alpha is highest, flattening
the gradient that says "this end is where you are" into one blown-out patch. Left wired so the
judgement is one drag of the **Path** slider rather than a paragraph.

It is also the one emitter that goes through `setEmissiveMaterial` rather than `markEmissive`, and
the reason that hatch exists: a hand-written `ShaderMaterial` has neither a `color` nor an
`emissive`, so nothing generic can say what it contributes as light. The owner supplies a clone of
its own material and a `sync` callback that carries the uniforms across each frame.

The fireball is the one place in this game where blowing the frame out is the *point* rather than a
cost, so it carries the highest intensity in the table. It also demonstrates the whole of the pass
in one object: its hue is per-instance, its alpha is a shader patch, and it is pooled — so it is
marked once at construction and everything else follows the frame. The **shockwave ring** beside it
is deliberately left out: it is a thin annulus, and a thin line is the first thing a blur destroys.

Those last two are the ones to be careful with rather than the ones to turn up. Bloom desaturates
toward white as it saturates, and a fare's ring is a clock whose hue *is* the answer. `crystal` and
`ring` are therefore the two lowest intensities in the table: a lift on their own facets rather than
a halo around them. They are in the list because that is a judgement to make with the game running,
not because they want to be loud.

### The pass

1. **The lamps into a half-res half-float target.** One `MeshBasicMaterial` per marked mesh, built
   from the mesh's own: an `unlitMaterial()`'s colour *is* the light (flat or per-vertex), and a
   Lambert's `emissive × emissiveIntensity` is what it actually adds. Times an intensity from
   `BLOOM_INTENSITY` — **this is the entire HDR pipeline.** `THREE.Color` does not clamp and
   `diffuse` is a plain `vec3`, so a value over 1 survives to the target untouched.
2. **Reject what the world is standing in front of.** A patch on each material discards against
   `game/ssao.js`'s packed depth — the solid world, already drawn, at exactly this resolution.
   Sharing it is why the bloom needs no prepass of its own; the price is a `depth` flag on the AO
   module so the prepass runs when only the bloom wants it.
3. **Three downsamples and three tent upsamples**, each adding into the level above.
4. **Composite additively as one more object in the main scene**, at `renderOrder` 0 — the same
   trick [the crayon page](#the-page--one-tile-baked-in-code) uses, hoisted out of a render target
   and into the transparent queue. **This is the whole reason the frame keeps its MSAA and the
   ghost outlines keep their stencil.** Additive on colour only (`blendSrcAlpha` zero): the
   composite's alpha is 1 across the quad, so plain `AdditiveBlending` made every pixel opaque and
   blacked out a canvas with a see-through background (the workshop's new-chat taxi).

The intensities are per *kind* of lamp because spill is a total rather than a peak: a brake pod is
four pixels and a menu board forty times that, so equal intensities put a wash over the
drive-through and a hint on a car.

The ⚙️ panel has all of it live: three masters — **Lamps** (how far past 1 a light is written, which
sets the shape of the falloff), **Spill** (how much of the blurred result reaches the frame) and
**Reach** (how the chain's levels are weighted against each other, from a tight hot core at 0 to a
flat fog at 1) — and then one row per kind, generated off `BLOOM_KINDS` so anything marked with a
new kind arrives with its own slider.

Where the three masters settled, tuned with the panel open on the running game rather than against a
still: **Lamps 0.35, Spill 0.25, Reach 0.55** (`BLOOM_DEFAULTS`). The first two are low, and the
direction is the point ([they opened at 1.0 and 0.7](rendering-history.md#the-pass)) — a brake pod is written at
3.4 x 0.35 = 1.19, which the intensity table's own note calls the faint-smudge end, below the ~2 it
calls the start of the useful range. At the opening numbers the bloom was a thing you looked at, and
this is a game you look *past*: what wants to survive is the read — a brake pod ahead, a siren two
blocks over — with the tarmac still tarmac around it. Note which knob did the work: `Lamps` moves the
whole intensity table at once and leaves its ratios (a siren over a pod, a menu board over both)
alone, so turning the effect down never became a renegotiation of nine entries. `Reach` did not move,
because it decides tight-against-wide and not how much, and 0.55 was already the tight end.

### Two numbers that were wrong first

**Summing the chain at equal weight is a fog, not a glow.** A box downsample preserves the *average*
of what it reads, so every level carries the same average as the one above it — and adding three of
them lifts the whole frame by three times the mean brightness of the lamps. On screen that is a pink
haze over the road around a police car rather than a light on its roof. `LEVEL_WEIGHT` brings each
level in at a fraction of the one below, so the finest stays dominant and the widest is a tail. It
is the same thing `UnrealBloomPass` spells as its `radius` lerp.

**A lit panel wants a fraction of a pod's intensity.** At the pod's 3.4 the drive-through's two
window panels washed out the entire building they are set into. 1.15 puts the same total spill into
forty times the area.

### What it costs

Half-res emissive target plus a 1/4, 1/8, 1/16 chain: about **1.3MB** at DPR 2 on a phone, against
the ~10.7MB an RGBA16F *frame* would cost. A dozen half-res draw calls and five small fullscreen
blits. `EXT_color_buffer_half_float` is what makes the target renderable and a device without it
falls back to RGBA8 — a bloom whose cores are flat rather than no bloom, and the ⚙️ panel says which
one is running.

### `?hdr` — the other route, for comparison

`game/hdr.js` is the real thing: the whole frame through an `EffectComposer` at RGBA16F with
`ACESFilmicToneMapping` on, `UnrealBloomPass`, and an `OutputPass`. It takes `?bloom`'s place rather
than stacking with it. It is a **comparison, not a shipped mode**, and what it costs is the reason
it exists:

- **Tone mapping changes every colour in the game.** Everything in `palette.js`, the sky dome's
  gradient, `hazeColor()`, the shadow tint and the golden-hour key were picked against a straight
  clamp at 1. Side by side, the city comes out cooler and flatter — the warm khaki ground goes
  grey-green and the shadows crush. Getting it back is a pass over the whole palette, not an
  exposure slider. **That is the bill, and the bloom is the cheap part.**
- **MSAA and the stencil buffer have to be bought back** as `samples` and `stencilBuffer` on the
  composer's target: two full-size allocations and a resolve per frame, on a budget
  [`game/recovery.js`](#losing-the-context--gamerecoveryjs) exists to climb down from.
- **Crayon and Cartoon Mode cannot run with it.** Three disables in-material tone mapping *and* the
  sRGB encode whenever the render target is not the screen — precisely so an `OutputPass` can do
  both — and [both look modes deliberately mix their ink in display space](#the-fill--after-the-colour-space-before-the-haze),
  after `<colorspace_fragment>`. The module declines the flag rather than drawing something wrong.
- **And it demonstrates the threshold problem rather than solving it.** The lamps have to be pushed
  above the threshold to bloom at all, and once the threshold is low enough to find them it finds
  the route band too — which glows, visibly, in the `?hdr` frames.

### What neither is doing yet

- **Only the windows `game/citylights.js` lights glow.** The rest of a building's glass is baked
  vertex colour on one merged mesh; the lit panes are a separate mesh generated alongside it.
- **Nothing glows harder for being in shadow**, where a real light reads far stronger.
- **No lens dirt, no anamorphic streak, no chromatic separation** in the spill — it is radially
  symmetric and colourless beyond the lamp's own hue.

History: [what this list used to say](rendering-history.md#what-neither-is-doing-yet).

## The renderer budget — `?safe` and friends

Four things on this page cost GPU memory that a plain three.js scene doesn't, and each has a URL
flag that drops it: the multisampled back buffer (`?msaa=off`), the sun's 2048² shadow map
(`?shadows=off`, or a size), the drawing buffer's pixel ratio (`?dpr=1`), and the AO pass above
(`?ao=off`). `?safe` is all four at their cheapest at once, and any single flag still overrides it.

**Android defaults to `?safe`**, and that is a holding measure rather than a conclusion: one
device — a Pixel on a PowerVR D-Series (Tensor G5) — lost the WebGL context in a loop on the full
budget and holds on the reduced one, and which single flag is responsible is not yet known. It is
wider than the evidence and it costs real quality on Android phones that were fine, taken because
the failure it avoids is a black screen rather than a soft one. `?safe=off` restores the full
budget there, which is how the narrowing gets done; replace the default with the one flag as soon
as it is known. Desktop and iOS are untouched, so screenshots and the shot list do not move.

[Crayon Mode](#crayon-mode--gamecrayonjs) and [Cartoon Mode](#cartoon-mode--gamecartoonjs) are two
more flags of the same shape (`?crayon`, `?cartoon`) but neither is part of `?safe`: both are off by
default everywhere, and a bare flag beats safe mode rather than deferring to it, because they exist
to be switched on by hand on the device that is hardest on them. They are independent of each other
— two looks being tried, not two halves of one — and switching both on is two inks over one frame.

They live in `util/shot.js` beside `?seed` and `?cars`, and every getter takes its **fallback from
safe mode rather than from a literal**, evaluated per call — so one flag moves all of them, and a
module that opens a renderer of its own reads the effective value without anyone threading it
through. Three do: each rider-finder chip, the courier
[cargo chip](gameplay.md#the-load-is-carried-into-the-hud) and the
[taxi finder](#getting-back-to-the-taxi). They are 38px, 42px and 44px square, and all three light
their one object with `mirrorSceneLights` (`game/avatarlights.js`): a fresh sun and hemisphere fill
copying the city's live colours, intensities and sun position each frame, so a chip is lit by the
same hour as the street. Their own cost is nothing,
but each is a **WebGL context this page is holding**, and that is part of what `?safe` is asking
about.

The flags exist because of a failure a desktop cannot see and a phone cannot report — see
[testing.md](testing.md#when-a-device-renders-nothing) for the whole picture. `stencil: true` is
deliberately *not* among them: MSAA and the stencil buffer ride in the same back buffer but they
are separate requests, and a run with multisampling off should still get its ghost outlines.

History: [the speech-bubble avatars that were contexts too](rendering-history.md#the-renderer-budget--safe-and-friends).

### Losing the context — `game/recovery.js`

A GPU can take the context away, and one did: a PowerVR D-Series (Tensor G5) rendered the city
correctly for about a second, reset, restored, and did it again. Draw calls and triangle counts
were normal right up to each loss, so the scene was never the problem — the device would not keep
giving us a context on the budget being asked for.

Three handles the mechanics already: it calls `preventDefault()` on the loss, which is what lets
the browser restore at all, no-ops every `render()` in between, and re-initialises on restore.
What it cannot do is conclude that **the budget was the problem**, so left alone that loop is a
black screen for as long as the player will look at one.

Two steps, split by what a live renderer can change:

1. **First loss — in place.** Pixel ratio to 1 and the shadow map to 1024. Both are plain
   properties, so no material is touched and **the run survives** — which matters, because the
   player is mid-fare with a clock draining and a reload is a lost run. It is a visibly softer
   picture and is not pretended otherwise; a context loss is not a routine event on a healthy
   page, and the cheapest thing that might stop a second one is worth more than the sharpness.
2. **Second loss — reload into `?safe`.** MSAA is a context attribute and AO is baked into every
   shader before any geometry is meshed, so neither can be given up without starting over. By then
   the run is going either way, and a playable game is worth more than the fare in progress.

Already in safe mode and still losing it? It stops, and leaves the mirrored `Context Lost.` on
screen saying so. A reload loop is worse than a black screen, because it also takes away the panel
that would have explained it.

### Heat — `game/governor.js`, and the paused still

The first iPhone `?bench` (2026-10-10, [testing.md](testing.md#what-a-frame-costs-on-a-phone--bench))
held 59.4 fps on 3.1 ms of CPU from cool, and the same baseline four minutes later read **52 fps
with 16.6% of frames late** on an unchanged scene. The phone had throttled. What answers it:

- **The governor** steps the pixel ratio down a notch (×0.875 of the cap each step) when a
  two-second window has 8% or more of its frames late, and back up after thirty seconds clean. A
  step up that slips straight back doubles that wait, up to four minutes. **It never goes below
  2x**, Regular's resolution, so Ultra walks 3 → 2.625 → 2.25 → 2 and Regular holds and drops
  frames instead; a screen or budget already below 2 is its own floor. Ratio is the only lever
  that moves on a live renderer; every target behind the drawing buffer already follows it, the
  same path recovery uses. Paused and finished runs don't count toward it, and neither does a gap
  over two seconds (the page was away). `?governor=off` holds the ratio, and `?bench` turns it off
  so its rows stay one setting each. Its moves show up in `?diag`. Why the floor is 2:
  [rendering-history.md](rendering-history.md#heat--gamegovernorjs-and-the-paused-still).
- **Antialiasing is a Settings switch** (`antialias`, game/settings.js), on by default. Off drops
  MSAA, which `tools/gpucost.mjs` put at 23% of a headless frame at 2x; at Ultra's 3x the stair
  steps it leaves on thin diagonals are hard to see at phone size. MSAA is a context attribute, so
  the switch applies at the next launch and its row says "(next launch)" until then. `?msaa=` beats
  it, and shot mode ignores it.
- **The pause draws one still**, not sixty a second. A canvas that is not drawn keeps showing its
  last frame, so the only thing that has to redraw under the veil is a resize.

`?soak` (testing.md) is how either gets judged: one setting for twenty minutes, a row a minute.

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

**`mid` is the tiebreak on that last case**, and it is the one line here that reads the frame
rather than the API: a single `readPixels` from the centre of the default framebuffer, taken in
the same task as the render that filled it. Black there and black on screen agree — the frame
really is black, and the bug is in the drawing. **Sky blue there with a black screen is the whole
answer**: the city was drawn and never presented, which is a compositing bug and a completely
different half of the browser from everything else this panel reports. It costs a pipeline stall,
which is why it is behind the flag and runs twice a second rather than sixty times.
`readRenderTargetPixels` cannot do it — it takes a render target, and the framebuffer actually on
screen, with the MSAA resolve this is asking about, is not one.

The limits on the fourth line — `vary`, `funif`, `tex` — are there because a phone's are close to
the spec minimums where a desktop's have headroom, and this city's materials are not plain: every
prop carries the AO patch's extra sampler and uniforms on top of a flat-shaded Lambert with a
shadow map. When a mirrored error says a program would not link, those numbers say whether it was
ever going to.

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

## The island edge — `game/edgefog.js`, `city/ground.js`

The island sits in a **bank of soft white fog**, the way an RTS hides the map you have not explored:
the ring road runs along its inner edge, and past it there is no coast and no sky, only fog, slowly
billowing. Tyler, 2026-10-17: "helps us hide the city ends at the edges but
gives the illusion you could unlock more city later". `?edgefog=classic` (`EDGEFOG=classic` headless)
puts back the island feathering into the sky, which is the skirt described further down — still
there under the fog, and what `?city=big` shows, since the fog is island-only.

### The fog of war — `game/edgefog.js`

- **A fog term, not a fog mesh.** A stack of translucent sheets is the obvious build and costs the
  one thing a phone has least of: full-screen overdraw, once per sheet, every frame. Instead the
  module appends to three's own fog chunks (`ShaderChunk.fog_*`) at import, before anything
  compiles, so every material that already wears the [haze](#atmospheric-perspective) also mixes
  toward the fog by where it stands on the *map*. No per-material patch to forget and no
  `customProgramCacheKey` to keep honest: every program has it. It lives inside three's `USE_FOG`
  guard, so [unlit markers](#unlit-means-unfogged) and the sky dome refuse it exactly as they refuse
  the haze. `main.js` imports it first for that reason.
- **One shared uniform, deliberately a plain object.** `edgeFog` is rgb (the colour) plus w (time).
  Three clones each material's uniforms, deep-copying vectors and colours but passing any other
  object by reference, so a plain `{ x, y, z, w }` is one object shared by every material — moving it
  once a frame moves them all. A material that never got it reads vec4(0), which the shader takes as
  "not wired" rather than painting black fog.
- **The shape.** A signed distance to a rounded rectangle round the ring road's outer kerbs
  (`FOG_HALF_X/Z`, `FOG_RADIUS`), ramped from 1 unit inside the kerb to opaque 7 outside it, with
  value noise pushing the edge **outward only**, up to 8 units. Outward only is a gameplay rule: the
  first cut billowed both ways, and on the near (south and east) side a hollow rolled the bank right
  across the ring road. `tools/check.mjs` holds `FOG_START` short of the outer lane. The same rule
  makes an early-out exact: a fragment whose distance is inside `FOG_START` is fog-free whatever the
  noise says, so its five noise reads are skipped. That is most of the screen at play zoom (a real
  GPU skips a branch a whole region fails; SwiftShader does not, so `tools/gpucost.mjs` cannot see
  this one).
- **The motion.** Two noise layers drift on headings about 100° apart at different speeds
  (`FOG_DRIFT`, `FOG_DRIFT_FINE`), and both are read through a slowly drifting warp field
  (`FOG_WARP`, up to 16 units of bend). The first cut slid one layer along one heading, which reads as
  a texture on a conveyor; the warp is what makes a billow swell, curl and pinch off instead. All of it
  stays outward-only, so the motion never brings the fog onto the road.
- **A sloped top.** The distance is taken minus 1.1 × the fragment's height, so the outermost
  buildings' roofs stand up out of the bank rather than being washed flat with their own pavement.
- **A floor for it to swallow.** Past the coast there is nothing to fog, so a plain plane sits at
  `FLOOR_Y` (−6, below the river's bed so it can never cover the channel) and is forced to full fog.
  It is what stands in for the sky everywhere past the island.
- **Colour follows the sky.** `daylight.js` calls `setEdgeFogSky` on every keyframe: the dome's
  horizon colour lifted 45% toward white, so it greys under rain and darkens at night with no wiring
  of its own. The noise shades it ±10% so the bank has bodies in it.
- **Sim time** drives it (`tickEdgeFog`), so a paused game holds its fog still and shots repeat;
  `__taxi.edgeFogAt(seconds)` sets the clock and redraws, for filming the drift from a frozen shot.
- **No city in the fog.** A ring of pale towers standing in the bank to the west and north was
  tried and dropped (Tyler, 2026-10-17: "let's not add the buildings in the distance then and just
  keep the fog"); towers can only go up-screen, so seen whole they bunched into one corner.

### The feathered skirt — `city/ground.js`

The asphalt doesn't end on a line. A **fade skirt** hangs off the slab — `EDGE_FADE = 16` units of
asphalt stepping outward from the slab's own outline, alpha 1 → 0 — so the city feathers into the
sky rather than being cut out of it. At play zoom that is about 22% of the frame height, which is
what makes it read as a gradient instead of as a slightly blurry edge.

It is an *edge* cue rather than a depth cue, and the two now sit on top of each other: the skirt is
keyed on distance from the middle of the map, so it fades the last 16 units of ground wherever they
are on screen, while [the haze](#atmospheric-perspective) is keyed on distance from the camera and
fades the whole back of the frame. The skirt hides where the island stops; the haze says how far
away it is. (This section once repeated the claim that distance fog could not do the
second job here — [history](rendering-history.md#atmospheric-perspective).)

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
4-component vertex colour attribute. `MARK_LENGTH = 1.5`, `MARK_WIDTH = 0.58`, spaced 0.42 apart so
stamps overlap into a streak, in `skidRubber` — a warm near-black, because pure black over the
blue-grey asphalt read as a hole in the road.

**Each mark is a feathered patch, not a quad**: a 4 × 4 vertex grid whose alpha is zero at both ends
and 0.25 at the sides, ramping to full over the outer 30% / 27%, so a streak has no hard edge every
0.42 units and no hard rectangle at each end ([the first version did](rendering-history.md#skid-marks--gameskidmarksjs)).
Per stamp alpha is `STAMP_ALPHA = 0.5`; stamps overlap ~2.6 deep at full weight, so the middle of a
streak still composites to ≈ 0.84. Vertex alpha rather than a fragment patch, so there is no shader
to keep in step with the look modes or the program cache.

**Streaks fade in and out.** A stamp joins the streak of the nearest mark younger than
`CHAIN_WINDOW` (0.3s) within `CHAIN_REACH` (1.1 — past the overdrive stamp spacing, inside the gap
between left and right tracks), so no caller says which wheel it is and the taxi, the brake and the
cops all get it. The first three stamps of a streak are drawn at 0.3 / 0.55 / 0.8. The tail can't be
known until the streak stops, so once a mark has gone `CHAIN_WINDOW` without a successor it and the
two before it **ease** down to the same ramp at `TAIL_EASE` per second — eased, so the end lightens
rather than pops. Each stamp is also drawn up to 20% lighter at random and varies ±8% in width, so a streak isn't a
flat band. `tools/probe.mjs` asserts the feathering, both ramps, the easing and the winding.

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

**Two plumes, one per rear tyre.** Each spawns at the contact patch that wheel actually stands on:
`TAXI_REAR_AXLE_BACK` (1.20) behind the origin and `TAXI_REAR_TRACK` (0.83) out to its own side,
both exported from `geometry/taxi.js` and read off the same `wheelAnchors` the wheels are *built*
at, through the group's 1.18 scale — so resizing a wheel or rescaling the car takes the dust with
it. Off the tyres, the pair separates on a straight and
swings apart through a corner, because the outside wheel travels further than the inside one. They
still merge behind the car — a puff swells to `END_SIZE` 2.3 against a 1.65 track — so the wide shot
keeps a single (wider) wake and the close shot gains two sources.

> **The pool is 200.** The trail spends a slot *per wheel* every 0.47 units travelled, so at the
> 34 u/s overdrive top it is **~145 a second and ~152 alive** across `LIFE`, which leaves 48 of the
> 200 for everything else against a barricade smash's 26 plus 14 for its landing. That fits, with
> 8 to spare: the next raise to the ceiling wants this pool checked before anything else, because a
> lapped ring buffer recycles a burst's own puffs out from under it. The probe's ring-buffer check
> laps the pool off `mesh.count` rather than a typed number for the same reason. History:
> [90 → 140 → 200](rendering-history.md#dust--gamedustjs).

> Per-puff alpha needs a custom `aAlpha` instanced attribute plus a three-line `onBeforeCompile`
> patch multiplying it into `gl_FragColor.a`. `instanceColor` cannot carry it: it is RGB only, and
> a 4-component colour attribute triggers `USE_COLOR_ALPHA` and a different code path.

Faceted volumes rather than camera-facing billboards, which sit in the same plane as the road and
read as flat stickers next to the faceted cars.

**Three effects come out of this one pool** — the boost trail, the wall a barricade throws
(`burst`, [below](#roadworks--gameroadworkjs-geometryroadworksjs)) and the smoke collar around a
wreck (`wreckSmoke`, [below](#wreck--gameblastjs-gamewreckagejs)) — plus the rotor wash off a helipad
and the puff under a landing — and the differences between them
are options on `burst` rather than three sets of hand-picked numbers: `tint`, `ring` (start each
puff that far out along its own bearing), `linger` (stretch the life) and `startSize` (begin as a
cloud rather than at a point). `instanceColor` *is* used for the tint, and it is allocated at build
time by painting every slot white, not left to be created by the first tinted puff — `setColorAt`
adds `USE_INSTANCING_COLOR` to the material, so a lazy first call would put a shader compile on the
frame of a crash. **The tint is rewritten on every spawn**, including the untinted ones: the pool is
a ring buffer shared with the boost trail, and a slot the collar painted grey comes back round half
a lap later.

### Wet tyres — `game/spray.js`, plus a second `game/skidmarks.js` pool

On a wet road the taxi's tyres throw water instead of dust (`wetTyres` in `main.js`). "Wet" is the
ground under the car — the squall's wet map (`squall.wetAt`) or the storm's one city-wide level — so
it follows the cell's trail rather than the rain itself. `?wet=spray|tracks|both|off` picks the
parts; `both` is the default.

**Spray** comes off the two rear contact patches the dust uses, but at any speed over 3 u/s rather
than only under boost: a car on a wet street throws water whether or not it is in a hurry. How much
scales with speed and wetness, from a dribble to a rooster tail. Two particles out of one pool: soft
**mist** puffs (the dust's squashed icosahedron, so it lights with the same facets) that read at play
zoom, and a few small **droplets** thrown high and pulled down hard, which are what make it water
rather than steam. The material is Lambert with an emissive lift (`waterSprayGlow`): under the cell's
shade a plain lit white came out the grey-brown of the dust.

**Tracks** are the rubber's streak machinery in a second pool, repainted per stamp: a pale sheen
(`wetSheen`) on wet asphalt, where the darkened, mirrored road made a dark mark vanish, and a dark
print (`wetTrack`) on dry road. The treads hold water (`tyreWet`), wrung out over `TREAD_DRY` = 14
units of dry road, so the taxi prints a short fading trail out past the edge of the wet patch.

While either is on and the ground is wetter than `WET_DUST_OFF` (0.25), the boost and brake dust
stand down.

### Landing sparks — `game/sparks.js`

The taxi lands a jump twice in a run at most — off a roadworks barricade, and off the crest of an
arched bridge under Loco Mode — and both landings throw this. Fired from the one `traffic.onTaxiLand`
handler in `main.js` alongside a camera shake and a dust burst, four to six per wheel off **all
four** contact patches: the boost trail comes off the driven wheels because that is where traction breaks,
but a landing lands on everything at once, and two streaks under the back of a car read as a
wheelspin. Same argument the brake's four-wheel skid is made from.

It is a **streak** pool rather than a puff pool, and every difference from `dust.js` follows from
that:

- **Thin boxes aligned to their own velocity**, stretched along the direction of travel and
  shortening as they slow (`SPARK_LEN` is 0.055 units per u/s, clamped to 0.35–1.15 — a 2.7px dash
  on a spent spark, 9px on a fresh one). A spark is seen as the line it draws, not the point it is;
  a round mote at this size is a dot of grit.
- **Additive and unlit**, like the tailpipe flame: a spark is a light source, so it brightens the
  road under it rather than sitting on it as an opaque fleck — which is also what keeps a night
  landing as bright as a golden-hour one. It blooms on the `flame` intensity rather than a kind of
  its own; the two are the same thing to that pass, small and hot and gone in half a second.
- **They bounce.** One skitter off the tarmac is what separates hot metal from thrown debris, and it
  costs a sign flip. The floor is passed in per burst rather than assumed to be the road — a landing
  on the hump of a span skitters along the **deck**, and a spark that fell through it would still be
  drawn, additive and depth-write-off, as a bright dash hanging over open water.
- **Hue is rolled once and kept**, spread across the shower rather than walked over each spark's
  life the way the fireball's ramp is. A spark is fading the whole time it is on screen, so a ramp
  buys nothing the alpha is not already saying; what the spread buys is metal at several
  temperatures at once.

`SPARK_CARRY` is 0.45 of the car's speed, well under a shard's 0.70 in `blast.js` and for the
opposite reason: a shard is a piece of the car and goes with it, a spark is separating *from* it. At
0.45 an overdrive landing throws sparks that creep forward for a tenth of a second and are then left
behind as the taxi drives out from under them.

### The getaway's cash trail — `game/cashtrail.js`

Banknotes off the back of the taxi while it boosts with a robber aboard
([the bank robbery](gameplay.md#the-bank-robbery)). The gate is the robbery and not the boost:
money off the back of any boosting taxi is a fun effect with nothing behind it, and the game already
has a flying `$20` that means something precise.

It is a **flutter** pool, and every difference from the three above follows from paper being light:

- **Low gravity, heavy drag on *both* axes.** A note thrown back at 9 u/s is doing 2 by the time it
  has left the bumper and travels 2.6 units of its own — most of a car length and no more. What
  makes the *trail* long is the car, not the note: measured at the Loco top, the live notes run
  from the tailpipe back some 36 units, the better part of two blocks of streamer. The sideways
  throw is 4.2, because a narrow one stacks the notes into a single line down the middle of the
  lane; at a lane's width it reads as a mess being
  left behind rather than a rope being paid out. The drag on the *fall* is what makes a note
  flutter rather than rain: without it they reached terminal speed and dropped straight down.
- **It falls like a leaf, not a flake.** The throw flips a note over its long axis a whole number
  of *half* turns in its first 0.5s, easing out, so it always comes out lying flat — face up or
  back up, never edge-on. After that it **swings**: displaced side to side across its own width
  (0.22–0.45 units, about once a second), tilting its leading edge up at each end and scooping down
  through the middle. That motion is what says "paper"; a random-axis tumble says "flake", and a
  0.02 plate tumbling freely spends a third of its frames edge-on, which is nothing.
- **It is a shallow V, two-sided.** Two quads meeting along the long axis, each wing rising 0.09 —
  so the outline changes as it rocks rather than being a rectangle at every angle. `DoubleSide`,
  with the back painted 35% of the way to `cashBack` off `gl_FrontFacing`, so the pale flash is a
  real back instead of a colour rolled per instance to fake one. That makes the winding a *colour*
  question — a reversed triangle swaps which side is green — so `tools/probe.mjs` asserts +y is the
  front from the winding.
- **Lit, not additive, not bloomed.** Money reflects light rather than emitting it. Additive over
  dark asphalt comes out as a glowing sliver, and a glowing banknote is a firefly; *unlit* is the
  same mistake in a quieter form — a note drawn at its full palette value whatever the sun is doing
  reads as emissive at golden hour. It is a Lambert like the dust, but **not** flat-shaded: a note is two-sided, and a flat-shaded
  back face takes its normal from a screen-space derivative and lights as if the sun were behind
  it. Real per-face normals, which Three flips for the back face itself.
- **It settles rather than bounces**, and onto a floor passed in per note the way a spark's is, so a
  getaway over a bridge drops its notes on the **deck**. It is recovered from what main.js passes
  (`y − TAXI_TAILPIPE_HEIGHT + ROAD_Y`), and the probe checks every settled note and bundle is on it.

**And a few wrapped bundles go with it.** Three with each press and one at the start of about a
third of the gusts: a brick of notes the note's footprint and 0.26 deep, with a white `cashBand`
0.32 wide round its middle standing 0.015 proud so it never shares a plane with the brick. They are the other
weight — gravity 24 against the notes' 7, one bounce at 0.32, then they slide to a stop and flop onto
their broad face — and they are there because a single note at 7px can only ever be a green fleck,
where a banded brick reads as money at any zoom. `propMaterial` rather than unlit, like the
roadworks cones: they are solid props lying on the road. They **cast no shadow**, which was tried —
a 0.26-tall caster at golden hour lands its shadow most of two units off its own base, detached by
the sun's `normalBias`, and reads as a dark smudge with nothing above it. They shrink away after
3.4s on the road rather than fading, because a translucent brick would be the one see-through
thing on the tarmac.

**The numbers**, each set against the effect being impossible to miss on a road already painted
with lane dashes (how they got here is in the
[history](rendering-history.md#the-getaways-cash-trail--gamecashtrailjs) — the first cut was a scattering you had to
go looking for):

| | now | why |
|---|---|---|
| Size | **0.88 × 0.48** (6.8 × 3.7px) | Much bigger and the notes stop reading as a shower of small things and start reading as a few large ones; density and alpha are what make it visible, and with those right a note can look like paper. |
| Rate | **a gust clock**: 39/s for 0.16–0.44s, then 3.5/s for 0.14–0.42s, each drawn fresh (~22/s mean) | A flat rate is a rope paid out of the back of the car, and a constant anything reads as a machine. The lull is a trickle rather than silence — at zero the stream visibly stops, which reads as the effect switching off. |
| Pool | 160 | the gust peak, the kick, and the notes lying on the road. |
| Life | 2.4s in the air, fading from 74% | Money should hang. Fading earlier spends most of the effect half-transparent. |
| On the road | half the notes that come down stay down (`GROUND_STAY`) ~7s, fading over the last 1.5s; a landed bundle lies 7s | A getaway leaves a line of cash across town behind it rather than a cloud that follows the car. |
| Tumble | **a flip, then a leaf swing** | A note is a 0.02 plate and is **invisible edge-on**. The flip lands on a whole number of half turns; the swing never goes past 0.7 rad of tilt. |
| Colour | **a spread**, `cashNote` → `cashShade` | See below. |
| The press | a 12-note, 2-bundle kick; a gust throws a bundle 15% of the time | An effect that only ramps up says nothing on the frame the button went down, and that is the frame the player is looking at. |

The **colour** is set against the ground the notes land on: `asphalt` is luma 104 and the lane
dashes painted all over it are 210, so a paler, greyer note sits *between* the road and the paint it
is competing with. At 179 with full saturation it is nowhere near the dashes in hue and half again
the road in value. The pale back is 232 — brighter than the dashes — because the flash as a note
turns over is what catches an eye that is on the road ahead.

**The face is a spread rather than a swatch.** Every note rolls its own colour between `cashNote`
and `cashShade` — *down* from the bundles' green, not up toward white: lit, a flat card square to
the sun already comes out brighter than a bundle in the same green, and a spread toward white on top
of that reads as emissive. The back is mixed only 35% of the way to `cashBack` for the same reason.
That is a different job from `cashBack`, which is the note's real back and is only ever seen when
the note is turned over; the face spread is there so 160 notes are 160 slightly different notes
rather than 160 copies of one colour, which at this size is the difference between a shower and a
texture. The roll is **squared** toward the saturated end: a uniform draw puts as much of the shower at the
pale end as the green one and the trail washes out, where `t²` keeps the mass on `cashNote` and lets
the pale ones be the highlights they are meant to be.

Measured on a rendered frame rather than argued: counting pixels that are bright green with more
blue than red (which separates a banknote from park grass, whose blue sits *below* its red), a
getaway frame scores **937** against **0** on a frame with no robbery in it — and that is with the
headless page throttled to a fraction of the note count a real 60fps hold produces.

**Fed before it is ticked**, which is the one ordering that matters here. The pool writes an
instance matrix only in its update pass, so a stream fed after it draws every note one frame late —
0.57 units of road at the Loco top, which reads as the trail starting a car length back from the
bumper.

### Cop cars' sirens — `geometry/lights.js`, `game/coplights.js`

A cop car in ambient traffic ([the police](gameplay.md#the-police)) gets its siren from three
places, and the split is worth knowing because the first two alone were not enough.

The **bar** is two instanced emissive pods on the roof, off the same machinery every brake light in
the game uses — one fixed material per colour, and on/off as a scale about each pod's own origin.
Red sits over the left lens and blue over the right, and they light alternately; the painted lenses
mean the dark side still shows its colour, so a split bar reads as red-and-blue rather than as two
flickering specks. History: [the whole-bar strobe](rendering-history.md#cop-cars-sirens--geometrylightsjs-gamecoplightsjs).

The **bloom** carries it the rest of the way at distance. `main.js` marks every lamp
`sim/traffic.js` owns in a single loop, and the kind rides on the mesh (`userData.bloomKind`) — a cop
car's bar is `siren`, at the cruiser's 4.2, not a brake light's 3.4 — so a new lamp arrives at the
right strength by being built rather than by being remembered in a second list.

And the **wash on the road** is `game/coplights.js`, which is the part neither of the other two can
do. The cruiser has had a real `PointLight` per colour since it existed, for the reason stated
there: the bar alone is a couple of pixels, and what sells a siren is the colour washing across the
tarmac and the fronts of nearby buildings as it goes past.

**Both read `car.siren`, not `car.police`.** The two flags differ for exactly one stretch — the
stand-down after a drop-off, when the cars are still on the road driving themselves off the map. The
paint is what a cop car *is* and does not switch off; the bar is what it was *doing*. Keying the bar
on the paint sent the whole fleet away with its lights still going, which reads as an event that has
not actually ended, and a wash still playing on the tarmac under a dark bar is the one place the two
would visibly disagree on the same vehicle. See
[standing down](traffic.md#standing-down).

**Two lights against four cars in livery**, and that asymmetry is the design. A point light is a
uniform slot and a per-fragment term on every lit material in the scene, paid every frame whether or
not a robbery is running — so the count is fixed at construction and small, and two is exactly what
the cruiser already costs. Which two is re-picked every frame: the nearest to the taxi, so the wash
is always on the cars the player can see while the further ones still flash their bars. `?safe`
builds none of them.

`PEAK` is 62 against the cruiser's 90, because there can be two of these at once and the cruiser is
one car: at 90 apiece a pair of cop cars a block apart washed the road between them into a flat
purple, which reads as a lighting bug rather than as two sirens. The off colour holds the cruiser's
own 14/90 floor rather than going dark, for the reason stated there — a hard on/off strobe reads as
flicker.

### Loco Mode kickoff — `game/flames.js`, plus a wheelie in `sim/traffic.js`

Two effects on the press that first engages Loco Mode — as against
[the plume](#the-tailpipe-plume--gamelocoflamejs) below, which burns for the whole of the hold that
follows. Fired from `kickLocoMode()` in `main.js`
only when `boost.press()` returns true — the ready→active transition — so a re-press during a
running boost doesn't re-fire either.

- **Tailpipe flame.** One-shot `InstancedMesh` burst of additive-blended orange motes, emitted
  from the taxi's rear bumper (`TAXI_TAILPIPE_BACK` / `TAXI_TAILPIPE_HEIGHT` exported from
  `geometry/taxi.js`) shooting backwards along `-yaw`. Short-lived (~0.38s), grows fast, air-brakes
  quickly; alpha snaps to 1 then eases out. Additive blend so it *brightens* the road behind it
  rather than reading as an opaque decal. The crash owns its own module (`game/blast.js`), so this
  is a tailpipe and nothing else.

- **Wheelie pop.** A hand-shaped bump on `car.pitch` — sine ease-out to peak by t=0.28,
  smoothstep back to zero — layered on top of the pitch spring. Handled outside the spring
  because the spring is calibrated for tiny suspension travel; a 15°+ pop through it would either
  be swallowed by damping or need a wildly out-of-scale impulse. Lift compensation reuses the
  same `Math.abs(Math.sin(pitch)) * (CAR_LEN / 2)` so the rear stays on the road as the nose
  comes up.

History: [when this pool was also the crash fireball](rendering-history.md#loco-mode-kickoff--gameflamesjs-plus-a-wheelie-in-simtrafficjs).

### The tailpipe plume — `game/locoflame.js`

The burst above is the *bark* on the press. This is the flame that burns for as long as the button
is held, and it is the only thing on screen that says Loco Mode is still on other than the pill
draining in the corner.

**A flat stylized cutout, not a particle system** — the same argument [the wreck](#wreck--gameblastjs-gamewreckagejs)
makes at length. Three nested tongues of flat unlit colour — `locoFlameOuter` outside,
`locoFlameMid` under it, `locoFlameCore` at the pipe — and it flickers by cycling **four hand-shaped
silhouettes at 16fps**, which is a flipbook and reads as drawn fire rather than as a blob being
scaled. 12 meshes over 4 geometries and 3 materials, all built once at module load; nothing is
allocated per frame and nothing is integrated. `update(dt, car, on)` is the whole interface, called
from `main.js` (and from the lab) with `boost.isActive()`.

**It stands in a vertical plane through the car's own long axis**, and that is a measurement rather
than a preference. A screen-plane billboard was the obvious build — the same `BILLBOARD` constant
the [outburst bubble](#the-outburst-bubble--geometrycursebubblejs) is authored in — but the plume
has to point along the car's *backward* direction, which projects into the screen plane at
(∓0.707, ±0.386) for the four headings. For two of them that is **down-screen**, and a 3-unit plume
sinks 3 × 0.386 × 0.838 ≈ 0.97 world units through a road only `TAXI_TAILPIPE_HEIGHT` = 0.74 below
the pipe: half the compass would draw a flame with its tail cut off by the asphalt. A cutout
standing on the car's axis can only ever reach down by its own half-width. Nor is it ever edge-on,
which is the failure the vertical plane *could* have had — the roads are axis-aligned and the
camera's azimuth is the 45° diagonal, so it faces the view at the same 53° on every heading and
foreshortens by the same 0.808 (3.0 long → 2.4 units on screen, ~19px at play zoom, behind a 31px
car).

> **It is `DoubleSide`, and that is not laziness.** Turned to the heading, the plane's normal comes
> out at (−sin yaw, 0, −cos yaw), whose dot with the view direction is −(sin yaw + cos yaw) —
> positive driving west and north, negative driving east and south. A single-sided cutout would be
> correct on exactly half the compass and *invisible* on the other half. It is unlit flat colour, so
> a back face is the same colour as a front one and there is nothing to lose. (This is also why it
> carries no `flatShading`: that takes its normal from a screen-space derivative and lights a back
> face as if the sun were behind it.)

Two numbers were set by the road rather than by eye, and both are asserted in `tools/probe.mjs`
rather than eyeballed:

- **`HALF_W = 0.50`.** The widest point of the tongue is the lowest thing it draws, so half-width ×
  the ruffle × the fattest beat of the pulse has to clear 0.74 — a width picked against the car's
  2.0 instead clears the tarmac by a coincidence rather than a margin. At 0.50 the worst frame of the pulse clears it by **0.095**, measured by the probe off the
  vertices actually drawn.
- **The taper exponent, 0.55.** At 0.85 the tongue has spent most of its girth by halfway and the
  back two-thirds is a spike: rendered, that is a dart stuck in the bumper rather than a flame.
  0.55 holds the body out to the midpoint and puts the taper in the last third, where a drawn flame
  has it.

**Ticked after `traffic.update`,** down with the rubber and the dust rather than up with the burst's
own pool, and for the same reason both of those are: it is pinned to the car's position *this*
frame rather than emitted and left behind. At the Loco Mode top the taxi covers 0.57 units in a
frame, so a plume ticked before the sim would ride visibly off the back of the bumper the whole time
it burned.

Its envelope is 0.05s up and 0.16s down — the attack answers a button press, and the release is out
well inside `BOOST_COOLDOWN` so the flame never outlasts the mode. A wrecked taxi drops it
immediately, the same bail `traffic.taxi.boost` gets.

History: [the first `HALF_W`](rendering-history.md#the-tailpipe-plume--gamelocoflamejs).

### Wreck — `game/blast.js`, `game/wreckage.js`

The crash is **one call per car** — `blast.fire(x, z, tint, yaw, speed)` — and everything *it* puts on the road
lives in one module: a fireball, a flash of firelight on the tarmac, a scatter of shards in that car's
paint, and two tyres that bounce out and roll away. Then **one `blast.burn(shell)` per wreck** keeps
it alight through the run-end hold: flame tongues licking off the shell, a dark column of smoke rising
from it, and a flickering pool of orange light on the road under it, all read off the shell's
position every frame so the fire slides with the car. Five `InstancedMesh`es; about seventy live
instances at the peak.

This is the `burn` style, the default since 2026-10-20, and it exists because the fire it replaced
was **unlit flat colour** — twelve one-colour hexagons and a white ring — which read as stickers once
the cars took real paint and the street a real sun ("flat and cartoony"). What changed, and what did
not:

- **Shaded, still faceted.** Each fireball facet is lit by how squarely it faces the camera — the
  facets square to the eye are the pale hot heart of a puff and the ones turning away its deep
  skin — and the silhouette facets fade out on the *sine* of that angle, the clouds' rim rule
  (CLAUDE.md, *A rim fade on `dot(normal, view)`*). The normal comes off a screen-space derivative,
  as `flatShading`'s does. Smoke is shaded the other way: sky on top, firelight underneath while it
  is still low over the wreck. A second per-instance attribute, `aFire` (shade, heat, underglow),
  carries it, and `shade` 0 leaves a puff in the older styles' flat fill.
- **Light on the road, without a light.** A real `PointLight` that appears only during a wreck
  changes every lit material's light count and relinks the city's shaders on the crash frame
  (CLAUDE.md); one kept in the scene at zero is a cost every frame of every run. So the glow is an
  additive radial quad, the headlight cones' trade. In daylight it barely registers; at night it is
  most of the picture.
- **No shockwave ring, and no [smoke collar](#the-smoke-collar).** The glow's flash gives the bang
  its size on the first frame, and the burning wreck's smoke column carries the beat after it. The
  pale translucent collar, laid over that, read as panes of tinted glass round the cars
  (`blast.wantsCollar()` keeps it for the older styles).
- **The cars stay readable.** The fireball keeps flat's shape — a skirt starting 1.4 units out from
  each car, no core puff — a little taller (squash 0.65) because the rim fade lets the eye through a
  puff's edge. The flame tongues are under a unit and a half across.

Everything below is common to all four styles. What makes a crash read at a fixed 3/4 camera is
**shape and timing**, not a physics packet, so the vocabulary is graphic rather than physical
(history: [the four-effect stack it replaced, and the unlit fire](rendering-history.md#wreck--gameblastjs-gamewreckagejs)):

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
> its whole tail around `#9A603D` — which is `brick` in the building palette, so the fireball dies
> the colour of the wall behind it. And the ramp has to be allowed to *reach* smoke before any alpha
> comes off, or a still-orange puff fading out leaves translucent pink hexagons over the road.

Under the older styles a shockwave ring reads first, because a flat ring at this camera projects as
an ellipse spreading out from under the wreck. Fourteen segments, so the flat sides show at the
wreck zoom. The big-air landing still fires it on its own (`blast.shock`).

**Four cuts of the fireball** (`WRECK_STYLES`, picked with `?wreck=classic|quick|flat|burn` or the ⚙️
panel's *Wreck fire*, read at detonation). **burn is the default**, above; flat was Tyler's pick
before it. `classic` is the
original full fireball, which hides the two cars the run ended on for most of a second — see
[history](rendering-history.md#wreck--gameblastjs-gamewreckagejs). `quick` is
the same fire smaller and over in ~55% of the time. `flat` squashes each puff to
0.42 of its height, starts it on a ring 1.6 units out from the car instead of on it, drops the core
puff and keeps the whole skirt under ~1.4 units, so the fire rolls outward along the road and the
bodywork stays visible in the middle; `tools/probe.mjs` asserts both of those claims.

Shards: seven per car, one tetrahedron squashed
per instance into plates and chunks, tinted with that car's paint so a two-car wreck comes apart in
two colours. They no longer bounce, settle or come to rest: a shard is a piece of the *moment* of
coming apart, and the thing that is left on the tarmac afterwards is the two cars themselves —
[below](#the-wrecks-that-stay).

#### The wrecks that stay

The two cars do not go anywhere. `traffic.wreckShell(car)` takes each one off the road for good and
hands its bodywork to `game/wreckage.js` — the taxi's own group for the taxi, and for an ambient car
a standalone copy wearing one tinted material, since `instanceColor` is RGB and an `InstancedMesh`
has nowhere to put the rest of this. Each shell slides out of the impact, crumples, scorches, and is
still lying there when the retry card slides over it. The run-end hold is `CRASH_BANNER_DELAY` =
2.6 seconds and the fireball is out after one, so without the shells more than half the beat would
be a held close-up of bare tarmac — and the one question a crash has to answer is **what did I just
hit**. (`game/vanish.js`, the shrink-and-fade the game [used before](rendering-history.md#the-wrecks-that-stay), is
now only the [passing lab's](lab.md) ending.)

Three things happen at once, on two clocks, and all of them are the same **closed form** the rest of
the wreck is built on — evaluated from scratch off the shell's age, so a frame under the crash
slow-mo, a full-speed frame and a shot-mode frame stepped by hand at 1/60 are all the same shape.

- **The carry**, on `util/carry.js`'s drag, exactly as the fade had it: the taxi hit something and
  keeps less of its speed, the car it hit is shoved and keeps more. See [Momentum](#momentum) below
  for the numbers.
- **The crumple**, a non-uniform scale in the *body* frame — 0.86 along its own long axis, 1.07
  across and 0.9 tall, plus a lean and a nose-down settle. This is the whole of what says wrecked
  rather than parked: a drawn car is 4.01 units long, 55 pixels at the wreck's zoom of 26, so 0.86
  takes nearly eight pixels out of its silhouette. The wheels are inside the same group and squash
  with it; that is a pixel and a half on an 11-pixel black disc, which is cheaper than carrying a
  list of which children are bodywork through two very different hierarchies.
- **The scorch**, a **multiply** on each material's colour rather than a lerp to a soot grey, with
  only a fifth of a pull toward `wreckChar` on top. A multiply preserves hue exactly, which is the
  property the whole feature rests on — the red car ends at L 0.18 from 0.32 with its hue moved by
  three thousandths, so it is a burnt red car and not a dark shape. Lerped far enough to read as
  charred, both wrecks come out the same grey and the crash stops answering its own question.

Two smaller things travel with it. The settle is **lifted by the sagitta of its own tilt**, because
roll and pitch pivot on an origin at road level and a tilt with nothing done about it drives a
corner underground — the same arithmetic as the `lift` beside `taxiGroup.position` in
`sim/traffic.js`, and worth 0.21 of a unit here, three pixels of a wheel. And a **smoulder**: one
wisp into the dust pool every 0.3s for six and a half seconds, because a completely static object at
the middle of a held close-up reads as a prop rather than as something that just happened.

Nothing is restored, and nothing needs to be: a wreck ends the run and Retry reloads the page. It
also costs no shader recompile — nothing flips `transparent`, which is part of the program cache key
and needs `needsUpdate` at runtime.

#### Momentum

A crash is not stationary. Launched from a fixed origin, nothing in the picture remembers that a car
arrived there at 22 u/s, and the beat reads as *car stops, then explodes* — which the crash slow-mo
makes worse rather than better, since it stretches exactly those opening frames out to five times
their length. History: [the stationary first version](rendering-history.md#momentum).

So `fire()` takes the speed the impact happened at, and each piece of the wreck is carried along the
heading by its own share of it. The shared arithmetic is in `util/carry.js`: a **closed form** of an
exponential drag, `origin + velocity × (1 − e^−k·age) / k`, in the same spirit as the puffs' fan and
the tyre roll. Nothing accumulates, so a slow-motion frame is the same shape as a full-speed one —
which matters here more than anywhere, given the whole beat is played back at 0.18×.

Two constants are shared. `CARRY_DRAG = 1.7` fixes the reach at `speed / 1.7` — 12.9 units for a
boost-speed impact, 44% of it spent in the first third of a second, so a wreck slides roughly its
own length through the fireball's opening frames. `CARRY_CAP = 26` saturates it: Loco Mode tops out
at 22.1 u/s and overdrive takes it to 34, and at 34 the shards left frame — worse, the two wrecks
looked like different *events* rather than the same one at different speeds.

What is per-effect is the fraction, and the ordering is about weight rather than taste:

| | keeps | measured drift at 22.1 u/s |
|---|---|---|
| Shards | 0.70 | 7.8 units, on top of their own 6–12 of fan |
| Shells (`wreckage`) | 0.26, ×0.8 taxi / ×1.25 struck | 2.7 units for the taxi, 4.2 for the car it shunted, both to rest |
| Smoke collar (`dust`) | 0.50 | 3.2 units |
| Fireball | 0.42 | 4.5 units |
| Shockwave ring | 0.30 | 2.0 units |
| Tyres | 0.28, on the bearing | 2.5–5.8 units of extra roll |

- **Shards keep the most.** They are bits of the car, and bodywork that separates from a car at
  22 u/s is still doing 22 u/s a moment later. Much under this and the shower fans out symmetrically
  around a point the taxi has already left.
- **The fireball keeps rather less.** Burning fuel is buoyant gas: it goes with the wreck, but the
  air the bodywork punches through drags it back. At the shards' fraction the flame front outran the
  wreckage it came out of, which reads as a fireball being *fired* downfield.
- **The ring keeps least of the three**, because what it wants is to stay under the fireball rather
  than to travel. At 0.30 the two stay concentric for the 0.45s the ring is alive.
- **The collar's 0.50 is not out of order** — it is spent against the dust pool's own drag of 3.4
  rather than `CARRY_DRAG`'s 1.7, so the same fraction buys less than half the ground. It lands a
  little behind the fireball, which is right for the thing that is meant to be trailing.
- **The tyres are the odd one out.** Theirs is not a drift at all: see below.

> **The fan is keyed on `t`, the carry on `age`.** Puff lives are rolled over a wide range (×0.6 to
> ×1.4) to stagger the colour ramp, so a puff keyed on its own fraction-of-life finishes its
> downfield travel early and hangs back while its longer-lived neighbours go on past it. Keyed that
> way the fireball **shears** rather than moving. Two terms, two clocks, on purpose.

> **The shards could not simply have the carry added to their velocity.** Their fan is a straight
> line at constant speed — there is no drag on a shard — so at 0.70 of 22 u/s one would still be
> gaining ground when its life ran out, 19 units downfield and off the top of the frame. It rides
> its own drag curve on top of the ballistic arc instead, which is bounded.

#### The tyres

Two per car bounce out of the wreck and roll off down the street. They are the one piece of it that
is **recognisable**: everything else here is an abstraction — a ring, a sphere, a squashed
tetrahedron — so the eye is told a car came apart without being shown a single part of one. A wheel
is the part that survives a real wreck intact and the only one small enough to keep moving after it.

It is `wheelGeometry()` out of `geometry/wheels.js` unchanged, not a torus of its own: the wheel
that rolls away has to be the wheel that was on the car. It arrives with its tyre colour baked into
the vertex attribute, so this is the one pool here that wants `vertexColors` and doesn't want
`instanceColor` — a tyre is black on every car in the city.

- **The bounce is a sequence of parabolas, not one.** Each hop launches at `TYRE_BOUNCE` = 0.5 of
  the last, so the hop times fall away geometrically (0.64s, 0.32s, 0.16s) and the tyre reads as
  landing, skipping, and settling into a roll. The walk down the hops is **bounded** at
  `TYRE_HOPS` = 5, past which the hop is under 4cm and the tyre is simply rolling — an unbounded
  walk would subdivide parabolas forever as the tyre asymptotes onto the road.
- **It is a curve of `age`, never an integrated velocity**, like the roadworks cones and unlike a
  physics packet: nothing accumulates, and a slow-motion frame is the same shape as a full-speed
  one. That matters here more than usual, because a wreck is *seen* in slow motion.
- **Horizontal travel is closed-form exponential drag**, so the reach is finite and known —
  `v / TYRE_DRAG`. It has to outrun the smoke collar, whose own front reaches about 8; a tyre still
  inside the smoke when it fades never rolled anywhere. And it is spent slowly enough that the tyre
  is *still moving* when it fades, because one that stops and then disappears is a thing being
  deleted.
- **The impact's momentum is folded into that launch rather than carried beside it.** This is the
  one piece of the wreck that does not get a drift vector, and the spin is why: it is read straight
  off the distance covered, so a carry added alongside would be ground the wheel crossed without
  turning — the exact "disc being spun and slid" the roll exists to avoid. `TYRE_CARRY` = 0.28 of
  the taxi's speed is projected onto each tyre's own bearing instead (`cos` of the fan offset, 0.94
  down to 0.41), so it is simply a harder launch, and the tyres thrown most nearly downfield get
  most of it — which is also what should happen. Over 400 seeds the furthest tyre is 18.9 units out
  at 2.5s against 12.4 without it, still inside the 26-unit half-height the camera pulls into.
- **The spin is the distance covered over the radius** — rolling without slipping, taken from the
  travel rather than picked to look right, which is the difference between a wheel rolling and a
  disc being spun and slid along. It costs nothing: the distance is already in hand.
- **The shadow is half of what sells the bounce.** A hop is about a unit of altitude, which at this
  camera is a couple of dozen pixels of gap opening between the tyre and its own shadow and closing
  again. Without it the arc reads as a tyre sliding up-screen.

`fire()` takes the **taxi's** heading for both cars and fans one tyre either side of it. The
momentum that throws anything downfield is the taxi's — the car it hit is doing 8 u/s to the taxi's
~19 and may not even be pointing the same way. Fanned evenly instead, half the tyres roll back up
the road the taxi came down, which reads as an explosion rather than as a collision. Note that the
heading is a **sim yaw**, not a bearing: `sim/traffic.js` builds it as `atan2(-tz, tx)`, so forward
is `(cos yaw, −sin yaw)` and the bearing the fan is taken about is `−yaw`.

They fade rather than shrinking. A tyre that shrinks is a tyre being taken away; one that thins out
while it is still moving is one that got away down the street.

#### The smoke collar

Everything above is unlit flat colour, which is what makes it read at this camera — and it is also
why a fireball on its own is a bright shape that appears and goes away again. The construction
zone already had the other half: **lit, faceted, billowing puffs**, the one effect in the game that
looks like something is still happening after the impact is over. `dust.wreckSmoke(x, z)` is that
burst, tinted and opened out into a ring, fired **once for the pair of cars at the point between
them**. Two collars, one per fire, would have packed grey into the seam where the two fireballs
meet, which is the middle of the blast.

It is `renderOrder` 3 against the fireball's 6, so the fire always keeps its own pixels and the
collar can only ever be *behind* the flame front — which is what lets it start at a radius of 3,
tucked against the core, and be pushed clear by its own throw. A collar that starts already clear
of the fire reads as a second, later event.

Five numbers, and none of them is free:

- **`WRECK_START_SIZE = 1.2`**, against the trail's 0.5. The size curve is tuned for dust coming off
  a tyre, which begins at a point and swells; at the frame the fireball peaks the collar was still
  at 29% of its size, and two dozen small hard-edged lumps ringing a blast read as **thrown rubble**,
  not smoke. The end of the curve is unchanged, so only the early frames move.
- **`WRECK_LINGER = 1.5`**, measured against the fire rather than picked. A fireball puff gets
  `PUFF_LIFE` 0.95 × up to 1.4 = 1.33s and a burst puff was already on 1.58s — a tenth of a second
  past the flame, spent at 4% opacity. At 2.4s the last thing on the road after a wreck is smoke
  rather than orange, which is the whole point of the effect.
- **The start radius is rolled per puff** (0.55–1.15 × the ring). At one fixed radius the collar is
  a torus, and once the fire inside it goes out a torus reads as a smoke *ring* — a shape with a
  deliberate hole in it — rather than as a cloud around a wreck.
- **`WRECK_CARRY = 0.5`** is what stops the collar giving the game away. Without it the fire, the
  shards and both shells slide downfield out of a grey ring left standing on the impact point —
  which reads *worse* than nothing having moved, because now there is a stationary thing in
  frame for the moving ones to be measured against. The fraction is high against the fireball's 0.42
  only because these puffs are spent against this pool's drag of 3.4 rather than `CARRY_DRAG`'s 1.7.
- **`wreckSmoke` in the palette is set against the road, not against `blastSmoke`.** The fireball is
  unlit, so its smoke stop can be `#4B4B55` and still read; this pool is Lambert and is lying on
  `asphalt` `#636972`. A sensible smoke grey by eye (`#6E6259`) came out at the same value as the
  tarmac and vanished for the entire duration of the fire, leaving smoke that only appeared once the
  flame had gone — the exact opposite of the brief. It ended up at `#C9C2BB`: roughly 1.8× the
  road's value, and still well short of the dust's pure white, because white here is a dust cloud
  and this is what is burning.

`wreckage.js` owns [the two cars themselves](#the-wrecks-that-stay). It steps on the frame's
already-slowed `dt`, so the crumple and the slide run at the same rate as the blast through the
crash slow-mo — as does the collar, which is stepped by the same `dust.update(dt)` the boost trail
is.

`take()` accepts a **drift and a slew** ([above](#momentum)), and this is where the momentum reads
hardest: the shells are the only recognisable objects in the wreck, and a car that freezes on the
spot reads as a car that stopped however much its explosion is moving. The two are given
deliberately different shares — the taxi keeps 0.8 of the base for having hit something, the car it
hit 1.25 — and are slewed in opposite directions (run to rest, about 20° and 64°) off which side of
the taxi's line it was sitting on. Matched, the pair travels as a rigid unit, which reads as a wreck
being panned across rather than as one car hitting another.

The slew is applied by **premultiplying** a world-Y rotation onto the pose the shell was caught in,
not by writing `rotation.y`; the crumple's lean and nose-down are **post**-multiplied onto the same
pose, so they land in the body's own frame. Neither can be an Euler component: a shell arrives
holding a quaternion decomposed out of a car's body matrix — corner lean, pitch rock and all — and
that already has both a roll and a pitch in it. See the note on `BODY_EULER_ORDER` in `util/geo.js`
for the shape of the trap.

Everything defaults to nothing, which is what keeps [the passing lab](lab.md) detonating its wrecks
on the spot and clearing them away with the older `vanish.js` fade: there the useful thing about a
wreck is *where it happened*, and a crumpled shell left in the way of the next staged approach is
not. See [traffic.md](traffic.md#the-wreck) for the rest of the staging, and
[testing.md](testing.md#screenshots) for `?shot=12`, `?shot=17` and `?shot=37`, which stage a real
crash and freeze it at the fire, at the smoke, and at the two wrecks left in the road.

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

**The ramp's winding is asserted.** `rampWedge` writes its triangles by hand, and a reversed wedge
shows the camera its *bottom* — a flat quad on the road that `flatShading` still lights like a
surface, and that reads as z-fighting. So `probe.mjs` asserts the sign of `normal.y` on both faces,
computed from the winding rather than from `computeVertexNormals` — which would happily launder a
reversed triangle into whatever its neighbours claimed. History: [the ramp that shipped inside
out](rendering-history.md#roadworks--gameroadworkjs-geometryroadworksjs).

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

**The cones stand in two rows** at ±2.6 from the road centreline, six a side, with ±0.12 of jitter:
the order has to be legible — a lane coned off — before the imperfection on top of it means
anything. The offset is set against the car rather than by eye: the taxi tracks
a lane centre at `LANE` = 2.0 and is `CAR_W` = 1.7 wide, so its flank sweeps to 2.85. At 2.6 the
near row is squarely in the way and goes flying while the far row survives, which is what makes
driving through read as damage instead of as a clean corridor.

**Going through throws a burst of dust, not a puff** — two ordinary trail puffs is what a boosting
taxi lays down in two frames, and would render the one impact in the run as exhaust. `dust.burst`
fires **twenty-six** at once, thrown **radially out of
the impact point** rather than trailing off the back of the car, and stopped against a per-puff
drag: dust off a road impact punches outward and then halts, and the halt is the half that reads as
an impact rather than as a plume. The pool is 200 slots, so a burst plus its landing costs a fifth
and leaves the boost trail intact. The landing reuses the same call at `count 14, power 0.7`
rather than carrying a second set of hand-picked numbers that would drift away from these.

Each puff carries its own `span` (so a longer-lived burst puff's age is normalised against its own
life, not the trail's `LIFE`) and a `grow` multiplier on the whole size curve (not just the x
aspect). The probe compares a burst against a single trail puff rather than against a magic number.
History: [the two `dust.js` bugs behind those](rendering-history.md#roadworks--gameroadworkjs-geometryroadworksjs).

**Knocked cones come to rest, and they are the first effect here that does.** Position is closed
form, like the blast's shards — a curve of `age` rather than an integrated velocity, so nothing
accumulates and a slow-motion frame is the same shape as a full-speed one — and the flight's
*duration* is derived from its own launch velocity (`2·vy / g`) rather than picked, so the settle
lands exactly when the cone does. The lying-down pose is reached by **slerp**, not by blending
Eulers: Euler blending gimbals through the flat pose and snaps the cone ninety degrees in the last
frame. The wreck's shards get away with never settling because the camera cuts to the retry screen;
this one stays.

A cone caught by a *trestle going over* is thrown harder than one the taxi merely clipped —
`SMASH_POWER 1.5` on top of the speed term, and 12–26 rad/s of tumble, which is three to five turns on the way up rather than one and a half. The tumble is what the eye reads,
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

### Clouds — `game/clouds.js`, `geometry/cloud.js`

Low-poly cumulus drifting past the city on one wind. Scenery on the same terms as the flyover and
the flocks — nothing routes around them, nothing collides with them, nothing can be tapped — with
one rule of their own: **a cloud must never come over the map you drive on.** The camera is fixed
and looks down a 33° diagonal, so anything in the air is drawn over whatever ground is up-screen of
it, and a cloud over the middle of the map sits on the taxi.

So they ride the island's coastline, which is also where the sky is. At play zoom the island is
221 × 120 units on screen against a frame 104 tall: what the player ever sees of the sky is the
wedge between the map's edge and the corner of the frame, and **91% of it is within 30 units of that
edge**. A band pushed generously clear of the city is a band nobody ever sees.

They come **in** over that edge rather than standing off it — `OVERLAP`, 20 units of a cloud's
bounding box sunk below the island's silhouette. The box is a long way outside the drawn shape,
since the fade has dissolved the lower rim before the box ends, so 20 units of box is about 14 units
of visible veil: at the map's far corner that reaches the outer half of the ring road and stops.
The line it stops at is the one thing here that is not a preference — `INNER_KEEP_OUT`, the ground
out to the ring road's centreline, asserted in the probe. Note what that box is *not*: it is at
ground level, not skyline height, because at this camera the top of a tall tower on the ring road
projects to 55.8 against the island's outer edge at 60.2 — any veil over the coast at all is a veil
over the roofs behind it, and nothing is played on a roof.

#### Authored on the screen, solved in the world

"Over the city" is a fact about the picture, not about the world. A world-Y lift buys 0.838 of a
unit up the screen (`SCREEN_PER_WORLD_Y`) and nothing else — no parallax, no perspective, nothing
that moves when the player pans — so a cloud at altitude 60 over the middle of the map is *drawn* 50
units up-screen of it, on the far edge's skyline.

`RIGHT`, `VIEW_UP` and `VIEW_DIR` ([camera](#camera)) are an orthonormal basis, so a cloud is
authored as `(sx, sy)` on the frame and `worldAt()` sums the three axes to get the world position
back. The third coordinate — how far the cloud floats *towards* the camera — is invisible under an
orthographic projection, and is therefore where the altitude goes: `standoffFor()` solves for
whatever standoff puts the cloud at the altitude it wants to be flying at.

That axis is not free, though: **view-space depth is measured from the camera's target**, which
follows the taxi. A cloud drawn *below* the island has to be a long way towards the camera to be up
in the air at all — the island is 120 units tall on screen and getting under it costs 1.54 units of
standoff per unit of drop — and a cloud placed with the camera at the origin can be **behind the
camera** once the player drives to the far corner ([it happened](rendering-history.md#authored-on-the-screen-solved-in-the-world)).
`STANDOFF_MAX` leaves 60 units of depth in hand after the worst pan and the price is paid where nothing can see it:
a cloud that wanted to fly at 80 and is drawn low ends up at 46 instead.

#### They ride the outline, not a lane

A straight lane clears the city only if the *whole line* does, and the set of lines that do covers
exactly **half** the map's perimeter: every line that could reach the sky beside the two edges the
wind is not parallel to crosses the city on its way. History: [the straight-lane
build](rendering-history.md#they-ride-the-outline-not-a-lane), measured at 0.13 clouds in frame on a portrait phone.

So a cloud holds a fixed height **above the city's silhouette** and tracks it as it drifts across.
The silhouette is the convex hull of the keep-out's projected corners, split into an upper and a
lower chain (Andrew's monotone chain), evaluated as a smooth-min over the chain's infinite lines and
clamped past the map's shoulders so a cloud carries straight on past its side rather than following
the outline down to a point. Every cloud still travels the same way across the screen, which is what
the straight lane was bought for in the first place.

The keep-out is **two boxes** — the ground out to its fade skirt, and the built city standing on the
middle of it — because one box costs 17 units of sky: built as a single 20.5-tall box out to the
skirt it claims a skyline standing on the very edge of the island, where there is nothing but empty
asphalt, and pushes the whole band up-screen off ground 28 units further out than any building.

`tools/probe.mjs` asserts the lot over eight simulated minutes on each of four seeds: the deepest a
cloud's screen box comes in past the island's edge, that no cloud's box ever reaches the ground
inside the ring road, that none is ever behind the camera across twenty framings from portrait phone
to ultrawide panned into each corner, and that a cloud is in frame 66% of the time on the tightest
framing the game has.

#### The one unlit thing in the sky

The scene's key is warm over a warm hemisphere fill at both ends, and a white lump under it comes
back as a **sandstone boulder** — every upward face cream, every downward face the colour of the
sidewalk, and the cool underside the palette asks for multiplied out of existence. That lighting is
right for a city at golden hour and wrong for the only white object in the sky, and no base colour
undoes it: a warm key cannot be cancelled without going past white in the blue channel.

So the material is `unlitMaterial()` and the light is **baked into the vertices** in
`geometry/cloud.js`, off the same sun direction the scene uses, leaving the colour exactly as
authored: `cloudLit` white on top, `cloudShade` blue underneath, over an ambient floor of 0.88 so
the unlit side of a cloud stays one of the brightest things in the sky.

That floor leaves the shading a *scalar*, though, and a scalar can only make a white cloud a darker
white, which reads as a paper cut-out. `SUN_WARMTH` is the other
half of what a light does: the lit surface is lerped halfway toward `PALETTE.sun`'s own hue, scaled
so its brightest channel is 1 so it shifts the colour without dimming it. The lit face lands on
#F4EED9 against the underside's #A9C0DA. It has to be that strong because of where the sun is —
`LIGHT · VIEW_DIR` is 0.98, so the sun sits almost directly behind the camera and *nearly every face
the player can see is a lit one*. There is no warm side and cool side to be had; the warmth is a
cast over the whole drawn surface, and the cool comes from the vertical gradient underneath it.

#### Soft, out of hard geometry

Everything else in this game wants its facets — `flatShading` and a hard silhouette are the whole
look. A cloud is the exception, and it takes three things to get there, all of them baked at build
time and all of them possible only because **the camera never rotates**.

**Smooth normals.** The shading normal is the direction from the lobe's own centre to the vertex,
as an ellipsoid so the vertical squash is accounted for, rather than the triangle's winding. The
light then runs across each face instead of stepping at every edge. Nothing is welded and no
vertices are shared: the normal is computed, used and thrown away, because the material is unlit and
the shading it produces is already in the colour. The per-lobe jitter is half the tree canopies' —
every unit of it is a unit of disagreement between the shading and the shape, which is free on a
flat-shaded canopy and a mottle here.

**A fade at the edges**, in the alpha of a 4-component vertex colour — the same trick the island's
own [edge fade](#the-feathered-skirt--citygroundjs) uses, so it needs no shader. This is what actually
stops a cloud reading as low-poly: the silhouette is the one place a polygon can still be *seen* as
a polygon, and dissolving it costs nothing but the numbers.

The fade is measured across the lobe's **drawn disc** — `sin` of the angle off the view axis — and
not off `dot(normal, VIEW_DIR)` directly. That is the difference between a soft cloud and a cloud
with a slightly blurred edge: the dot product is `cos` of that angle, which stays near 1 across most
of a disc and then collapses, so fading on it spends the whole ramp in the last tenth of the radius,
about four pixels at play zoom, and still reads as an edge.

Two corrections come with it. The lobes are grown 28% (`EDGE_GAIN`), because a fade eats the outside
of every one of them and a cloud built to the size it should look comes out small and thin. And a
vertex buried in a *neighbouring* lobe has its alpha put back to 1 (`BURY`): the fade is a statement
about the outside of a cloud, and applied blindly it fades every lobe against its own neighbours —
each intersection curve draws an arc, because that is exactly where one lobe's surface is turning
away from the camera while the next one's is still solid, and the cloud comes back as a row of
overlapping discs.

**No depth write, and the lobes pre-sorted back to front.** Every lobe is translucent around its
edge, so one that stamped depth would punch a hole in whatever is drawn behind it — including the
rest of its own cloud. Blending them in depth order is what makes the overlaps read as one body, and
sorting per frame is what an engine normally has to do here: this camera never rotates, so the order
is a property of the model and is settled once, at build time. Per lobe is enough because a lobe is
convex — its own front faces cannot overlap each other on screen.

History: [the first soft build](rendering-history.md#the-one-unlit-thing-in-the-sky--soft-out-of-hard-geometry).

About 960 triangles a cloud and five in the sky, against 34k for the city.

What it gives up is the shading turning with the day. The *tint* still does: `cloudTint()` is a
function of the sky the same way `hazeColor()` is, and `game/daylight.js` drives it on every
keyframe change — the sky sampled halfway up, most of its chroma taken out, its lightness pulled up
a gamma curve. That curve is the trick: a cloud is brighter than the sky at every hour, so the parked
afternoon barely moves (it is already light) while midnight lands at 0.14 lightness against the sky's
0.04 — a shape you can still make out rather than a hole in the stars. Sampled halfway up rather than
at the zenith, unlike the haze, because a cloud at dusk is the one thing in the frame still catching
the sun.

#### The model

A row of jittered icosahedra sitting on a common base plane, merged into one geometry — the tree
canopy's construction at four times the size, laid along a line rather than clustered on a trunk.
Each lobe is squashed to 0.8 and its centre put at exactly that height, which lands every lobe's
underside on `y = 0` whatever its size: one flat base, the way a cartoon cloud is drawn, with the
top broken up by the lobes themselves.

**How many lobes is derived from the span, not drawn.** At four lobes over a 46-unit span the
spacing came out at 11.5 against a radius of 7.7 and the cloud arrived as a string of separate
balls; spacing them at 0.82 radii always closes, and closes hard enough that no single circle
carries the outline. Puffs ride the shoulders over the middle 60%, lifted by less than the lobe under
them is tall so they always break its surface.

The long axis lies down the wind, which is **+45°** and not −45°: the project's convention takes +X
to `(cos, 0, −sin)`, so `RIGHT` — world (1, 0, −1), the direction screen `sx` runs in — is a positive
quarter turn. The other sign aims the model down (1, 0, 1), the horizontal part of the *view*
direction: the cloud points straight into the screen, projects to nothing across the frame, and every
one of them came out as a lumpy potato standing on end. The probe checks each cloud is at least 1.3×
wider than tall on screen, which is the shape of that mistake.

**Five** up out of a pool of 28, drifting at 0.5-0.9 screen units a second. Both numbers are about
the frame rather than about the sky: a cloud has no scale of its own, so the eye reads its speed
against a frame that is 140 units wide on a desktop and 48 on a phone — much faster and a cloud
crosses a phone's frame in under half a minute and reads as scudding. Five puts about two in frame
at a time on a 16:9 desktop; twice that is a sky with weather all over it. History:
[what it shipped with](rendering-history.md#the-model). `?shot=24` frames the band against the
map's far corner; the ⚙️ panel has the four knobs that decide how it reads — how many, how far in
over the coast, how deep the band, how fast — plus one for the other reading of the brief, **Over the
city**, which puts that many of them across the map instead of round it. It is 0 by default: a cloud
over the play area hides the taxi, which is the whole reason for everything above.

### The park flock — `game/birds.js`, `geometry/bird.js`

Birds living in the city's parks. They walk about on the grass, pecking and pausing; something puts
them up; they climb out on a shared heading and fade into the distance; a while later they come back
in from somewhere else, descend onto a park — often a different one — and land. Scenery on the same
terms as the flyover: nothing routes around them, nothing collides with them, nothing can be tapped.

**A city runs two of them, in two different parks.** A city has between two and five green areas
big enough to hold a flock, and one flock meant the rest of them were lawns with nothing on them;
the second is what makes the map feel inhabited rather than the one park you happen to be near.
They are built on separate offsets of the run seed, so they lead separate lives — one is on the
grass while the other is halfway across the city — and each is handed an `avoid` callback naming
the greens the others are on. `pickArea` treats *keeping off another flock's lawn* as outranking
*getting a change of scene*, and that order is the whole of the function: half of all cities have
exactly two usable parks, so asking those two wants the other way round makes every return leg in
such a city land on the other flock's grass. The probe drives the pair for ten minutes and asserts
they never share, on the seed whose city has only the two.

**A few rooftops are roosts too.** `chooseRoosts` picks three flat decks (`createBuildings(...).decks`,
minus the helipad's) at least 4 × 4 with 40% of their interior clear of furniture, off the *city*
seed — which roofs the pigeons use is part of the map. They join the parks in `pickArea`'s pool, so
a flock coming back can land on one; the two flocks share the same roost objects so `avoid` keeps
them apart by identity, as it does for lawns. Three things change on a roof. The deck's furniture
footprint (recorded by `roofFurniture` as `keep`, without touching the city's rng) is padded by half
a bird and walked round like the court, and a spot drawn inside it is redrawn rather than pushed,
because a cramped deck can leave the push no edge that stays on the roof. The taxi cannot startle a
rooftop flock — it is a dozen storeys down, and a plan-distance range would launch a corner tower's
roost every lap of the block — so it leaves on its timer. And heights are measured off the area's
own ground (`groundOf`): the stand height, the shadow gate (`shadowCeiling`), and a departure's
climb, which is held at least 3 units above the deck since `ALT` is measured off the grass. The run
always *opens* in a park: the entrance grows every building out of the ground, and a flock settled
on a roof would hang over a hole while it did.

**The whole flock is three draw calls.** One `InstancedMesh` for the bodies and one per wing side,
however many birds there are. A wing beat is a rotation about the shoulder, and a rotation about a
fixed point in the body's own frame goes straight into the instance matrix — so articulating six to
ten birds costs no more than instancing six to ten static props would. Per-bird variety is an
`instanceColor` grey multiplier over the baked vertex colours, drawn once and shared by all three
meshes so a bird can't wear one shade on its body and another on each wing. All three set
`frustumCulled = false`, for the reason the ambient traffic has to: a moving `InstancedMesh` latches
its bounding sphere on the first frame it is culled and never recomputes it, and a flock that
crosses the map would latch a bubble around one park and vanish the moment it left.

**Each wing is its own geometry, not one mirrored by a negative scale.** A mirror flips the winding
on every triangle, and `flatShading` then lights the whole wing as if the sun were behind it. The
probe reads both wingtips back off the instance matrices the flock actually wrote and asserts they
rise together on an upstroke, because the two sign flips involved (flap about X, sweep about Y) are
the kind that leave every formula self-consistent and one wing beating the wrong way.

**The taxi coming past is what puts them up**, and that one thread is the only contact between the
flock and the game — it runs one way, so a run plays identically whether or not it ever happens.
Two numbers keep it from swamping the effect: a park sits one block off two streets, so the taxi is
within the 8-unit startle range several times a minute, and an 11-second settle after landing is
what makes a take-off *the answer to a car going past* rather than the flock's default state. They
leave away from the car. Failing a startle they go anyway on a 26–52 second timer, and stay away for
11–22.

**The fade is what ends a departure, not the altitude.** They climb at 2.8 units/s toward a 17–23
ceiling and are still climbing when the fade runs out over 25 units of travel, so the ceiling is a
cap they rarely reach. A return leg begins 62 units out — past the far end of the fade-in — so the
flock is already invisible when it is placed and the first thing the player can see is a smudge that
resolves into birds. It is `transparent` for both fades and therefore, like the aeroplane, not
`propMaterial()`: it would otherwise receive AO without being in the depth prepass and wear the
occlusion of the trees and towers behind it — [the occluder rule](#the-occluder-rule).

**The flock stamps the ghost mask** (`stampGhostMask` in `geometry/ghostoutline.js`, which the
aeroplane and the helicopter use too). Transparent but still writing depth, a bird between the
camera and the taxi reads to the ghost rim's reversed depth test as an occluder, and the rim traced a
bird-shaped stroke of yellow across the hull — most take-offs, since the taxi is what usually
launches the flock. Stamping the stencil where a flyer draws knocks the rim out under it instead.
Drawing the flyers after the ghost tiers would also have worked, and would have taken them out from
under the crayon page at renderOrder 1.

**Shadows are on only while the whole flock is on the deck.** The shadow pass ignores a material's
opacity, so a faded-out flock that kept casting would drag hard shadows across the city with nothing
visible above them — and the sun is 28.5° up, so a shadow from any real altitude lands two units
away per unit of height and reads as a smudge crossing a street with nothing over it. The gate is
0.9 units, which a bird clears about a fifth of a second into its leap.

Two things the camera decided. The pale patch is on the **head**, not the breast: on the chest,
correct for a pigeon, it is invisible from 33° up and every bird is a featureless dark pebble on the
grass. On the head it says both "this is an animal" and which way it is facing. And the folded wing
is swept 1.45 rad: a rigid panel can't fold at the wrist, so the only way out of the silhouette is
to lay it along the body — swept less, a standing bird has wing sticking out past its tail on both
sides and reads as one that has hurt itself. History: [the first bird](rendering-history.md#the-park-flock--gamebirdsjs-geometrybirdjs).

Scale is a deliberate lie, as it is for the riders. A pigeon beside a 4-unit car is a quarter of a
unit long — two pixels at play zoom, which is a speck of dirt on the lawn. This is 1.30 units nose
to tail on a 1.73 span, so a bird is about 10px at play zoom against a rider's 23. `BIRD_SCALE` is
the one number that sets it: the model's boxes are written as proportions and every offset and
exported measurement runs through it, so the bird grows without the shape moving.

**The size is doing work the palette can't.** Birds are the one thing in the game with no chroma at
all — a couple of pixels of moving colour is the description of a fare marker, and the way to
guarantee a take-off never reads as something the player has to act on is to give it nothing to
read. That leaves value as the only channel they have, and the lawn caps it: the grass is luma 134,
so a body much past 118 stops separating from the ground it stands on and is left telling itself
apart by hue. The bodies sit at 118 (much darker reads as gravel) with the head patch at 221,
and the visibility that couldn't be bought there was bought with the extra fifth of a unit instead.
`?shot=18` stages a take-off; `?shot=0` has both flocks at play zoom, which is the framing that
decides whether any of this worked.

### The duck pond — `city/pond.js`, `game/ducks.js`

One pond, in one park, with two or three birds sitting on it. They paddle from one end to the other,
sit a while, tip forward to dabble, and never leave — which is the whole difference between these
and the flock above. That one has a life; this is scenery that moves. Where the pond goes is
[in city.md](city.md#a-duck-pond); this is what it looks like.

**The water is drawn as a fan about its own centre**, not as a `ShapeGeometry` like every other flat
surface in the city, and the reason is the one vertex earcut would not give it: the middle. The open
water is `pondWater` and the rim `pondShallow`, 17 luma darker, so the pond has depth for the price
of a vertex colour — [a gradient across a flat-shaded triangle](#faux-window-reflections--citybuildingsjs)
costs nothing but the numbers. One flat blue read as a painted disc. The shore is the other half of
it: a ring of damp earth cut with the water as a hole in it, the same construction the walk round a
park uses, which is also what removes the seam — both rims come off one point list, so there is no
pair of outlines to disagree. Hand-wound geometry means the probe computes the normal *from the
winding* on every triangle of both pieces, the roadworks-ramp rule.

**The surface is the river's** (`patchPondWater`, `city/riverwater.js`): the same per-pixel
ripples, glint, caustics and absorption, over a bed that shelves radially off the lobed outline, and
the river's Fresnel lip running round the whole shore. Two things are the pond's own. The lip is
narrower (0.3 rather than 0.55), because at the river's width it was a third of the pond's radius.
And the open-water sky reflection is cut to 45%, because at full strength it lifted the middle of the
pond from luma 80 to 98, over the lawn round it, and the pond stopped reading as a hole in the green.
That puts the water in a mesh of its own (`pondWaterMesh`) outside the props merge. `?water=classic`
keeps the old flat fan; see [history](rendering-history.md#the-duck-pond--citypondjs-gameducksjs).

**Value, not hue, is what makes it read.** A mid blue near the lawn's luma 140 is the same trap the
bird bodies document, and worse, because a pond is a 45-pixel area rather than a moving speck. At 101
it is a hole in the lawn from across the map. The
hue is 216°, in the window between the courier cyan and the VIP purple, on the clearance rule the
blooms and the roadworks orange are held to.

**The ducks are the flock's own bird, unscaled**, floating with the waterline a third of the way up
the torso. The water is opaque, so everything below it is simply hidden — which is what takes the
legs out of the silhouette, and the legs are the part that says *standing*. That only holds while
the sightline out of a foot crosses the surface over the pond, and at 33° a submerged 0.31 needs
0.48 of water beyond it, so a duck is held a bird's half-length plus that off its own shoreline. It
is also why the pond has a floor on its size: shrinking the birds to fit was tried and reads as a
different animal standing two seconds away from the full-sized flock.

**More than half of them wear the pale morph**, against a fifth of a flock. Those morphs were
balanced against the lawn, where the base bird at luma 118 is the dark shape; on 101 of water it is
the same value as what it is sitting on. `birdTint` takes the pale share as an argument for that
reason — the ducks are the same birds under different light, not a second palette. It is also what a
municipal pond actually has on it.

Everything else is the flock's vocabulary at a quarter speed: one `InstancedMesh` with
`frustumCulled = false`, a Lambert that skips `propMaterial` for [the occluder rule](#the-occluder-rule),
a bob and a rock on one slow clock per bird, and the peck slowed and deepened into a dabble. They
are posed the instant they are built, so shot mode — which ticks once and freezes — has birds on the
water rather than a pond of default poses. `?shot=25` is the pond close up and `?shot=26` the same
water at play zoom, which is the framing that decides whether it is a landmark or a smudge.

### Boat wake — `game/wake.js`

One `InstancedMesh` of flattened motes lying on the water, shared by every hull on the river — the
[dust](#dust--gamedustjs) recipe with a wake's tuning. Unlit through `unlitMaterial`, so foam reads
the same at noon and at dusk and takes no haze; `depthWrite: false` at `renderOrder = -1`, so it
sorts after the water at -2 and lies over it without fighting; per-mote alpha in the same three-line
`aAlpha` patch, because `instanceColor` is RGB only.

**Foam is left behind.** A shape welded to the stern travels *with* the boat, at exactly hull speed,
which contradicts the one thing a wake exists to say ([the triangle this
replaced](rendering-history.md#boat-wake--gamewakejs) did that). Every mote is spawned into the world and then stays where the
water is, so what the eye reads is the hull pulling away from its own trail, and a wake that is
still lying there a couple of seconds after the boat has gone.

**Three parts, and the middle one is the shape.** Two arms opening astern, a churn boiling out of
the stern between them, and a tail that comes apart rather than ending on a line drawn across open
water. The arms open at `KELVIN` = `tan(19.47°)` = 0.354 of the boat's **own speed**, which is the
Kelvin half-angle a displacement hull actually makes at any speed — so the tug and the barge throw
the same shape at different lengths, which is what makes the barge read as heavy rather than as a
tug with a slow wake. They start at `ARM_OFF` 1.0 off the centreline, just inboard of the hull's own
`BEAM / 2` = 1.1: at 0.85 the pair was 1.7 apart against motes growing to 1.05 and closed into a
single column before it had opened, and the V went missing at every framing.

Emission is keyed to **distance travelled** — a spawn every `SPAWN_STEP` = 0.5 units, with a churn
mote on every other one — which is what makes a boat holding station lay nothing, and is the
[river doc's](river.md#fading-in-and-the-wake) point rather than this one's. What belongs here is
what it costs: 2.5 motes per 0.5 units is 41 alive behind a tug and 31 behind a barge, and with the
five barges the spawner's `BARGE_WAIT` floor can actually put on 176 units of river at once that is
196 against a pool of **256**. The probe measures the peak over a five-minute soak (166 on the seed
it runs) and fails if it reaches the ceiling, for the reason the dust pool has twice been grown: a
lapped ring buffer recycles a mote out from under a wake that is still on screen, and what that
looks like is a bite out of the middle of a trail rather than an error.

`HEAD_ALPHA` is 0.36 because **motes overlap**: astern of the boil an arm mote has grown to 1.05
against a 0.5 spacing, so two or three cover any given patch and a pair alone stacks to 0.59. Much
higher and the river has a solid white stripe down the middle of it.

Each mote's whole state is evaluated from its **age** rather than integrated frame to frame, which
is unusual for this project and is there to buy one thing: shot mode ticks the world once and
freezes, so a pool that fills over two seconds of travel is photographed empty. With a closed form,
`prime` lays a finished trail in a single call by spawning each mote already the age it would have
been — the same wake the running game makes, not a posed one — and ends on `update(0)` so the
matrices are actually written. Without that last line every mote is at the scale 0 the pool was
built with: a wake laid down correctly and photographed invisible.

### The rooftop helicopter — `game/chopper.js`, `geometry/helicopter.js`

A helicopter that visits the city's helipad every couple of minutes: in over the skyline on a curve,
banking through the turn onto final, a hover over the circle, down into its own dust, a few seconds
sitting with the rotor idling, and then up and away the way it came. Scenery on the same terms as
the aeroplane and the flocks — nothing routes it, nothing collides with it, nothing can be tapped —
and about half a minute door to door against the plane's six seconds, which is why the gaps between
visits are 95–165 seconds rather than 45–90.

**Every city gets exactly one helipad, and that is this vignette's doing** (a per-roof coin flip
left most cities without one — [history](rendering-history.md#the-rooftop-helicopter--gamechopperjs-geometryhelicopterjs)).
`choosePad` in `city/buildings.js` picks the roof after every deck in the city
is known, which is the same shape as the courtyard's "exactly one a city": a rate that has to be
exactly one cannot be decided lot by lot. The hard requirement is *width* rather than height — the
tallest masses are the ones that have set back twice, so the widest deck over 8.5 units is typically
3 to 5 across and demanding 4.2 of it left two thirds of cities with no candidate. Decks 2.9 and
wider qualify, the tall ones are preferred, and the roomier half of those is drawn from at random.

The chosen deck's roof furniture is **spliced back out** of the geometry list before the circle goes
down. A plant room in the middle of a landing pad is the one thing a roof like that cannot have, and
building the furniture and then dropping it costs one roof's worth of boxes a city — which is the
price of taking the decision *after* every deck exists rather than as a roll before the next tower
is built. The probe checks the circle is clear by reading vertices back out of the built mesh.

**The transit is level and the descent is vertical, and that is a clearance rule rather than a
style.** The machine cruises at 22 units: above `SKYLINE_CEILING` (20.5), which nothing on a roof
may reach, and below the aeroplane's belly at its lowest (24.9) once the 1.35 to the top of the
rotor is counted. That is the only altitude in the city which is safe by construction: the pad is on
a tall roof but never the tallest, and the block next door is one street away, so a glide slope onto
it can fly through a neighbouring tower. So it arrives over the circle at cruise, comes
down the hole at 5 units/s easing to 1.6 for the last four, and on the way out climbs vertically all
the way back to 22 before a single unit of forward travel. `tools/probe.mjs` re-runs that sweep on
every check.

**The bank has to be spent over the city, not on the way to it.** A leg enters 34 units to one side
of the final approach line and steers at an aim point that slides onto the pad between 52 and 14
units out, so it flies a base leg, banks through the turn onto final and rolls level lined up — a
real approach, and one whose lean lands where a camera can see it. Pure pursuit from an offset
heading would do the turn too early — it converges fastest when the bearing moves fastest, which is
when the target is *near* — and spend it off the edge of the map.

**Bank is scaled by speed, and that one term is what keeps the attitude honest.** A helicopter turns
by tipping its rotor disc — the disc is the wing — and a *stationary* one turns on its pedals
instead, so the lean is `turn rate × gain`, clamped at 29°, times how fast it is going. It earns its
place on the way out: the departure turns hardest in the second it spends going nowhere, and without
the term it rolled 29° over a hover, which is the single thing that would give the whole model away.
It also lets the departure be one manoeuvre instead of two. The pedal turn on the climb stops 72°
short of the departure heading and holds there; the rest is flown, banked, as the machine
accelerates, so it leaves on a sweeping turn rather than pivoting on the spot and then setting off
in a straight line.

**And nothing in the flight model is unsteady, so the pose adds a wobble.** The transit is a
straight line at a fixed height and the hover is a lerp onto a point — between the turn onto final
and the touchdown the machine held a perfectly rigid attitude for several seconds and read as a
model being slid along a wire. Two sines per channel at rates that don't share a period, on roll,
pitch **and yaw** (a helicopter in the cruise sits slightly crabbed and hunts about it), faded in
over the first 1.6 units off the deck so a parked one is dead still. It is applied at pose time
only: the attitude jitters, the flight path does not, and the probe asserts both halves — never
rigid in the air, never twitching on the skids.

Two smaller things the roof decides. The approach lines up with the deck's **long axis**, because
these roofs are 3 to 8 units wide and the machine is nearly 7 long — arriving across one leaves the
tail hanging over the parapet — and the settle pedal-turns onto that line before touching down,
since the last fourteen units are flown straight at the pad from wherever the base leg left it. And
it parks its **skids** on the H rather than its origin: the model's centre is 0.575 forward of the
middle of its skids, so putting the origin on the circle sits the machine back on its tail with its
toes over the far edge.

**The rotor wash is the dust pool, eleven storeys up.** `game/dust.js` grew a `y` for it — every
other caller comes off the road, and a puff spawned at the road's own height would go up on a street
under the machine making it. It starts at 3.6 units above the deck rather than on touchdown, since
ground effect is what a helicopter kicks up on the way *down*, and it is metered through a
fractional debt rather than rolled per frame so the rate is per second and not per display refresh.
Two heavier bursts bracket the visit, one as the skids take the weight and one as they leave it.
The puff size took a rendered close-up to settle: at 0.42 power they were under a unit across, and a
dozen hard little lit icosahedra ringing the pad read as gravel scattered on the roof. Dust has to
be bigger than the thing kicking it up.

**The discs are much fainter than the propeller's**, and the reason is the angle. A prop disc is
edge-on to this camera; a main rotor is flat-on, so the same alpha covers eighty times the pixels —
a 5.4-unit disc under a camera 33° up projects an ellipse the size of the roof, and at the plane's
0.11 it read as a grey lens laid over the block behind it. Their strength also tracks the rotor's
own rate, so the blur fades as the machine spools down to idle on the deck and comes back before it
lifts: an idling rotor whose blades you can count still wearing a full-strength disc is the single
thing that makes a parked helicopter look like a decal.

**The paint is chosen against the deck, not against the sky.** Half of a visit is spent parked on
`roof`/`rooftop`, so a dark machine reads as a smudge on the deck. Near-white with a warm cast is 6.03
and 4.39 contrast against those two greys, and the warmth is what keeps it off the cold grey everything else on
a roof is made of. The two aircraft separate by paint instead: the plane's single red cheatline
against this one's **orange-over-gold** pair, in the same 0.17 of flank the one band had, repeated
on the fin cap. A pair rather than a single band because a lone stripe on a white body reads as a
stray line — an edge of its own between two saturated bands is what reads as paint at 40 pixels.
And the outboard sixth of each rotor blade is **red**, which a real machine wears for the reason
this one needs it: a dark bar over a near-white fuselage loses its ends exactly when it swings over
them, and a mark that stays visible all the way round is what makes the blade read as *turning*
rather than as a line drawn across the roof.

**Shadows are on only near the deck.** Same argument as the flock's: the sun is 28.5° up, so a
shadow from transit altitude lands 40 units from the machine that threw it. Close in, the surface
catching it *is* the roof it is landing on, and the shadow sliding onto the pad is the best cue in
the vignette for how far off the deck it still is. The beacon on the fin blinks 0.2s in every 1.4
off the visit's own clock, so a frozen shot renders the same state every time — and it is
`MeshBasicMaterial`, since a lamp lit by a light source is not a lamp.

Scale is the aeroplane's lie again. True to size a Jet Ranger would be a 9-unit rotor over a 12-unit
machine, which is wider than the roof it lands on. At 5.4 across the rotor it overhangs the circle a
little, which is what a helicopter on a city pad actually looks like. `?shot=20` puts it on the pad
in its own dust and `?shot=21` catches the turn onto final at play zoom — the two halves of the same
question the flyover's shot asks.

### Route band — `game/routeline.js`

A band of paint down the **lane the taxi will drive**, from just ahead of the car to its
destination: lane width (0.85 of it), the taxi's yellow at 0.38 alpha. Shown only while the taxi
has a pending target — the route is a property of the *selection*, not of the world. Once planned
it does **not** re-path as the taxi drives; a line that keeps changing under you is unreadable.

It is on the **lane**, not the centreline, because a route between the two lanes never says which
side of the road the taxi is on — the one thing a driving line is for. And nothing in its shape is
measured from the car's position, because a corner that re-shapes as the taxi closes on it is the
squirm the band exists to remove. History: [the hairline and the selection pool it
replaced](rendering-history.md#route-band--gameroutelinejs).

`routePath(car, route)` walks the same lane centrelines and the same junction Béziers the car
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
the cars (0.04), and so *under* passing traffic: at lane width a band drawn over the cars would
paint yellow across every car it passes.

The band still offsets each *point* along its mitre rather than offsetting each segment
independently. Independent segments leave a wedge of bare road on the outside of every join —
invisible when the corner *was* the notch, obvious across a ten-step arc.

### The taxi's roof — `geometry/taxi.js`

The cabin is a band of dark windows under a **yellow roof** (`taxiBody`, painted), not one glass
box. The camera looks down on the car, so the roof is most of what it sees: as an all-glass cabin
the empty taxi read from above as dark glass and an unlit sign with yellow trim, and got lost in a
busy frame. The glass runs from the body's top to `ROOF_BASE` (1.62) and the roof from there to the
cabin's old top (1.75), overhanging the glass by 0.03 each way so it reads as a lid; the roof sign
and the broken windscreen's plates sit where they always did. The depot's sign is built from the
same parts, so it wears the roof too. `?taxiroof=classic` puts the glass box back.

Still open: in low sun the bonnet and boot come out pale silver, because the paint's sky reflection
washes the yellow out of every face that points up — which costs the car more of its yellow from
above than the glass ever did.

### The taxi's chequer — `geometry/taxi.js`

A band down each flank, `CAR_LEN * 0.82` long and 0.22 tall, split into **six cells** alternating
`taxiTrim` near-black and `taxiSign` off-white. Six boxes a side rather than one, merged into the
shell with everything else, so the livery costs a draw call of nothing.

**One row, not a chequerboard**, and that is a zoom decision. Through `TAXI_SCALE` the band is about
2px tall at play zoom, so a second row would ask for 1px and get mush; a single row of alternating
cells is the largest thing that still reads as *chequer* at this size. Six cells puts one at ~4px —
about the finest pitch that survives. Square cells matching the band's own height would want twelve,
at ~2px each, which alias into a flicker as the car turns.

**Both colours are painted.** Letting the light cells fall through to the body makes a
yellow-and-black band, which is a hazard stripe, not a taxi. The white is the roof sign's own off-white rather than a new entry, so the livery keeps the
car to two colours.

The white cells clip under the accept flourish's 0.32 emissive lift, and that is fine — the roof sign
is the same off-white and has always taken the same lift. The *dark* cells have the whole of the lift
to climb, so the chequer stays legible as chequer while the car is lit.

History: [the app icon's chequer](rendering-history.md#the-taxis-chequer--geometrytaxijs).

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
  the hull. The steered front wheels are separate meshes, outside the merged shell, and have to be
  added by hand ([the streak when they weren't](rendering-history.md#taxi-ghost-outline--geometryghostoutlinejs)).

Both passes are flagged `transparent` purely to land in the transparent queue, which draws after
every opaque object — the depth buffer has to be complete before the mask stamps. `addGhostOutline`
is per-mesh and reusable (the police cruiser could wear one as-is); the ambient traffic is
instanced and takes the variant below, which shares this file's geometry inflation and both of its
material recipes so the two paths cannot drift apart.

### Nearby-traffic ghost outlines — `game/carghosts.js`

The same outline, worn by the handful of ambient vehicles nearest the taxi. It exists because
`sim/collisions.js` only charges a contact while boosting: the one moment a car hidden behind a tower is a
crash rather than a surprise is the one moment the player cannot see it. The taxi's outline says
where the player is; this says what they are about to drive into. It lives in `game/` rather than
`sim/` because it is a readout of a player-layer concept — the boost — and because `main.js` is the
only place allowed to know about both.

It runs whether or not the taxi is currently boosting, and deliberately so: gating it on
`taxi.boost` would only ever confirm a decision already made, since the collision test it is
warning about only starts charging once the button is down. Showing it beforehand is what lets the player spot
the hidden car and choose *not* to press the button — see `update()`'s `want` in `carghosts.js`,
which only drops to 0 once the taxi is `crashed`.

Each ghost wears **its own vehicle's paint** rather than the taxi's yellow (`carBodyGhost`,
index-aligned with `carBody`). Seven instanced meshes across two pools, and none of them drawing
once the run ends in a crash.

**Two pools, because a box truck is not a car.** A truck lives in its own instance space
([why](traffic.md#box-trucks)), so `car.instanceIndex` addresses a car in `mesh` and a truck in
`truckMesh`, and a truck is the vehicle that most needs outlining: the biggest thing on the road, the
obstacle that most fills a lane, and at `TRUCK_SPEED` the one most likely to still be sitting in the
junction the taxi is arriving at. `createPool` builds one pool per
vehicle class — a mask per opaque instanced mesh the class draws (car: body + steered wheels; truck:
cab + cargo box + steered wheels) plus one rim — and selection runs across both arrays into one
shared cap.

Two things a truck's rim has to answer that a car's did not:

- **One hull for the vehicle, merged before inflation.** The cab and the cargo box are two meshes,
  so two hulls is the obvious build and it is wrong twice over. The rim blends, so wherever two
  hulls overlap the fragment is drawn twice and comes out at 0.86 instead of `GHOST_OPACITY`'s 0.62
  — and inflating the two separately drives them 0.7 units into each other at the chassis line: a
  doubled band down the flank from y 1.65 to 2.95, about 10px at play zoom, which reads as a lit
  stripe rather than an outline. Merged first, chassis and box still only *touch* at y 1.5 (one
  affine scale preserves that), so the whole truck traces at one opacity.
- **The merge costs the cab roof some rim.** `inflatedGeometry` scales about the bounding box, so
  each offset is proportional to the part's distance from the centre and only the outer silhouette
  gets the full 0.35. Measured on the hull it builds: nose +0.35, tail +0.35 off the chassis, box
  roof +0.35, flank +0.35 — but the **cab roof only +0.17**, ≈1.3px against 2.7px, since it sits
  well inside a bounding box the box roof defines. That is the one soft edge, it faces the cargo box
  rather than open sky, and a truck's silhouette is legible from the box alone.

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
  a part left out of the mask is an occluder of the rim behind it — which is also why a truck's
  cargo box carries a mask of its own, or the cab's rim would resolve straight across it. A wheel
  *rim* is not — a front
  wheel reaches x 1.66 against the body hull's 2.0, so it is inside the body's outline everywhere
  but a ~0.4-unit sliver under the valance, about 3px at play zoom against a rim that is 2.3px wide.
  The taxi wears wheel rims because its outline is a find-my-car signal that has to be complete;
  this one is a don't-hit-that signal, and the body box is the whole message.
- **Off means gone, not transparent.** A mask writes no colour at all, so fading its rim to zero
  leaves it stamping the stencil every frame regardless. The pool drops its instance counts to zero
  instead, which is also what makes it free for the majority of a run.

Rim thickness is 0.35, not the taxi's 0.3: that 0.3 is applied *before* `TAXI_SCALE = 1.18` on the
taxi group, so 0.35 unscaled is what matches the taxi's ≈2.7px trace. A truck takes the same 0.35
rather than a rim scaled to the vehicle — the line is a signal to the player, and a signal reads at
one weight.

Selection is a plain radius — `GHOST_RADIUS = 46`, reaching past the junction the taxi is committed
to and covering the one after it, measured from vehicle centre for both classes.

**The radius is a time written down as a distance.** The figure that matters is the *fully lit*
one, `GHOST_RADIUS - FADE_BAND` = 40 — a ghost inside the 6-unit fade band is nearly transparent,
which is not a warning — and that is 1.81s at the boost cruise of 22.1 u/s. `tools/probe.mjs` asserts
it in seconds rather than as a bare number, against a 1.8s floor, so when the speed it warns against
moves, the check fails and the radius has to move with it. Measured over 150 headless boost crashes
(taking the vehicle the taxi went on to hit and resolving occlusion against the city's own building
and tree geometry), a radius that gives only ~1.3s of warning leaves a quarter of the hidden crash
partners with no outline at all 1.5s before impact; at 42 that was 0 of 17.

A wider radius does not turn the skyline into a wireframe. A rim only rasterises where something in
the depth buffer sits *in front of* it, so a vehicle standing in the open costs fill and paints
**nothing** — what the player sees is only the hidden ones, measured at 0.77 a frame at a radius of
30 against 1.28 at 42: half an extra outline on screen, for two thirds more warning.

`MAX_GHOSTS = 18` sits deliberately *above* the 6.1 vehicles the radius holds on average, so the cap
is a rail against a queue at a red rather than the real filter: eviction drops the *farthest*
vehicle, and farthest is not safest — the car two junctions out is the whole point of the horizon.
Swept over 24 city seeds × 60s of boosting (86,400 frames), the count in range peaks at 16 and a cap
of 16 binds on 0.00% of frames, so 18 clears it with two spare. Raising the radius from 42 to 46 did
not move that peak: the city holds 22 vehicles at the top of the density ramp, strung along roads,
so the taxi's neighbourhood saturates well below what the area implies. History: [30 → 42 → 46, and
the caps 8 → 12 → 18](rendering-history.md#nearby-traffic-ghost-outlines--gamecarghostsjs).

**The horizon has a ceiling: `SPAWN_CLEARANCE`.** A mid-run arrival appears at least 50 units from
the taxi ([why](traffic.md)), so 46 sits under it with 4 units to spare — the next raise needs the
clearance to move first.
If the radius ever reached the clearance, a car would materialise *already wearing an outline*: a
ghost blinking into existence beside the taxi with no vehicle having driven into view, which is
indistinguishable from the bug this module exists to prevent. `tools/probe.mjs` asserts the two stay
apart. Measured over 40 runs: no spawn lands inside the radius, the nearest 52.6 units out.

What the clearance does *not* buy is a car you saw arrive. About a quarter of spawn points are
hidden behind a building at the moment they are used, and the nearest measured arrival was inside
the ghost radius 0.7s later. No warning horizon can cover a vehicle that did not exist a second
ago — that is a property of growing the traffic mid-run, not of the outlines.

**The cap is shared across the two pools; the pools are not.** What the cap bounds is how much of
the frame this may paint, which is a fact about the player's screen and not about which buffer a
vehicle is drawn from — so one nearest-N list feeds both. Each pool is nevertheless sized for the
full cap, since three trucks and five cars in range is legal at `TRUCK_CHANCE` and a pool that ran
out of slots would drop the nearest vehicle on a technicality. The spare slots cost a matrix each
and draw nothing.

Nothing in the module recomputes a transform. `traffic.update()` has composed every ambient matrix
by the time it runs, so it reads those matrices straight back out — the same read-back `wreckShell`
does — which is what keeps the bob, corner lean, pitch rock, wheelie, Loco weave and panic wobble
exactly in step with the car being traced. It is called last in the frame, after `collisions.update()`,
for two reasons: a frame's lag is 0.31 units ≈ 2.4px of rim sliding off its own car at boost speed,
and a car wrecked on this frame must not wear a ghost over its own fireball.

### The pie — `geometry/diamond.js`

The marker a waiting rider floats: a **pie**, a thick disc, bouncing, with no black outline, cut into
eight slices, two per urgency level, the whole pie in the one [urgency](gameplay.md#urgency-is-one-scale)
colour of the level the fare is at. The clock eats it clockwise from twelve o'clock, so each pair
of slices that goes is a quarter of the clock, and the colour steps (with the kick) at that moment.
What is left is solid and one even shade; eaten slices stay as a flat black tint at 30%
(`PIE_EATEN_ALPHA`), not the pale glass of the hue the other vessels empty into: with no outline,
pale glass vanished into the road at play zoom and a half-eaten pie read as a semicircle. A fresh pie already has a sixteenth missing at twelve o'clock (`PIE_STARTER_SLIVER`), so it reads as a timer before anything has drained. After that the clock takes a **whole slice at a time**, so the cut always lands on a
slice's own radial wall, and a drained pie shows that wall as a solid edge of thickness where the
missing slices were. Every wall is drawn before every cap (`pieWedgeOf` maps faces back to slices
for the probe): the wall sits behind an eaten slice's glass face, and drawn after it the wall
failed the depth test and the cut came out flat. An eaten slice's walls are discarded rather than
drawn as glass, or they would stand in it as spokes. The walls on the vertical cut (twelve and six)
are edge-on under this tilt, so it is the horizontal cuts that show the most depth.
The marker sits `MARKER_CLEARANCE` (0.8) higher than the taller shapes, for air over the head.

**The geometry** is eight touching wedges (`pieGeometry`), 2.4 across (~18px at play zoom) and
0.55 thick, built face-on in their own XY plane and turned (`PIE_TURN`) toward the camera and
tilted back to a 60° normal, 27° past face-on, so the face reads as a disc with depth and the near
edge shows its thickness. The fill shader picks the cut and the alternate shading from the angle
of the untilted `fillXY` attribute. The outline hull is still built (one solid 32-sided drum at a lighter `PIE_RIM` of
0.14, since at the shared 0.22 it was the loudest thing on the marker) but hidden: the solid, lit,
tilted disc separates from the city by its own edge, and Tyler asked to "try without the black
outline".

History of this round: the first pie was four slices of the one current hue, 3.1 across, cut apart
by black gaps. Tyler: "More slices (8). Map to existing urgency colors. Smaller over all. Tilt
back to give it some depth. No black internal lines." The next build painted each slice its own
level's colour, so a fresh rider showed all four at once; Tyler: "Keep it a single color until it
reaches the next tier then change." A translucent build (0.7 alpha, walls removed because they
showed through as spokes) followed "let's try with less opacity", and was turned back: "Let's try
solid, no opacity. Bring back the internal walls so it looks 3d in its drained states."

`?plumbob=hourglass` brings back the hourglass below and `?plumbob=classic` the [plumbob before
it](rendering-history.md#the-plumbob--geometrydiamondjs).

#### The hourglass — `?plumbob=hourglass`

An **hourglass**, outlined in black. The hue is the sand: a fresh rider's top bulb is full
of it, it drains through the neck as their clock runs, and it piles up in the bottom bulb, with a
thin stream of it falling between the two while the clock is running. It is the rider's shape alone; it is its own module because the shape, the outline and the bounce are a vocabulary the next marker should
inherit rather than re-derive. (The file is still `diamond.js`: it is the crystal over a fare
whatever silhouette it wears, and the rename would have cost a hundred references to buy nothing.)

**The geometry** is a six-sided lathe: a profile (`GLASS_PROFILE`) from a 0.16 neck out to a bulb
of radius 1.2 and back in to 1.0 under each plate, then a walnut plate (`PALETTE.hourglassFrame`)
1.45 in radius and 0.3 thick on each end. 2.9 × 4.4 world units, within a tenth of the plumbob's
2.8 × 4.5, so it takes the same room on the board and `LIFT` barely moves. The plates overhang the
glass, and at 22px that overhang is what turns "two cones" into "an hourglass".

A **corner faces the camera**, turned to 45° for the plumbob's reason: `VIEW_DIR` looks down the
diagonal, and a corner rather than a flat runs a ridge down the middle of the silhouette and splits
the front into two facets the sun lights differently. The camera never rotates, so this is baked
into the geometry rather than maintained per frame.

**Each bulb has its own level.** The fill shader picks the top bulb's surface (falling from the
plate to the neck) above the neck and the bottom bulb's (rising from its plate to just under the
neck) below it, both linear in height and both overshooting by one meniscus band so a fresh fare
has a full top and a spotless bottom. The plates are frame rather than vessel: opaque, walnut, and
lit by 0.3 of their own colour instead of the hue's. The stream is a separate thin box, a child of
the mesh in the hue, hidden at either end of the clock — so a VIP's hourglass, whose clock never
drains, never runs.

Written as **non-indexed triangles wound counter-clockwise from outside**, and `tools/probe.mjs`
computes every face normal *from the winding* — not from the normal attribute, which
`computeVertexNormals` would launder — because a flipped triangle would both light as if the sun
were behind it (`flatShading` reads the screen-space derivative) and punch a hole in the
back-faces-only rim. See the trap in [CLAUDE.md](../CLAUDE.md).

One geometry serves every hourglass on the board, and one more serves every outline hull. Colour and emissive are per instance, so a repaint is a `Color.set`
on one material.

The outline is an **inverted hull**: the same geometry drawn a little larger with `side: BackSide`
and a black basic material, so the enlarged back faces sit behind the real surface everywhere except
around the silhouette. Cheaper than a post-processing edge pass and it needs no render targets —
these are small objects, not a whole-scene effect. Each hull is a *child* of the mesh it wraps, so
it inherits animation for free.

**The rim is a distance, not a factor**: `RIM_OFFSET` is 0.22 world units (≈1.7px at play zoom),
and the hull is the profile pushed out along its own normals by that much (`offsetProfile`) rather
than the body scaled. An hourglass is not convex, and a scale about the origin moves the neck out
by its own tiny radius times the factor — about a hundredth of a unit, so the rim pinched to nothing
at the waist. `tools/probe.mjs` measures every hull vertex against the body vertex it came from. Crystal and hull sit at `renderOrder` **8** and **9** in the
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
at the bottom that reads as a landing rather than a float; 0.45 is taste. It freezes while hidden, which
keeps screenshots deterministic.

**The kick** is the one-shot on top of it, fired when the urgency level steps:
`kickEnvelope(t) = sin(π · (t / 0.36)^0.65)`, driving scale to `1 + 0.1 · env` and an extra
`0.55 · env` of lift. The exponent is what makes it a knock rather than a throb — it pushes the peak
early, so the crystal snaps up and eases down; a plain half-sine swells as slowly as it settles.
Both channels ride one envelope so the swell and the hop are the same gesture.

The kick is **retired on the clock, not on its value**: the envelope reads 0 at both ends, so
clearing the animation whenever it reads 0 kills every kick on its own first frame — invisible in the
browser, since nothing moving is also what "no kick" looks like; the headless assertion guards it.

Both the bounce and the kick are driven off **sim time**, not an accumulated `dt`: a frozen shot has
to render the same frame every time. The kick's start is stamped inside `update()` rather than at
the moment the level changes, so the animation doesn't depend on the order `setUrgency` and `update`
are called in. Each slot gets a fixed phase offset on the bounce, so two riders don't pulse in
lockstep.

### The target disc — `geometry/targetring.js`

A filled circle inside a solid rim, lying flat on a kerb corner. **Both ends of a trip wear one** —
under the waiting rider and on the corner they are going to — in that fare's urgency colour either
way, and never both at once for the same fare: the kerb disc goes dark on the frame the drop-off's
lights (see [gameplay.md](gameplay.md#the-disc-says-it-again-on-the-ground)). One rim shape and one
fill shape serve every disc on the board — only the colour differs, and `setColor` moves all three
layers together, since they are one mark at three weights rather than different colours.

`RING_Y = 0.2` above the surface it marks, on all three, so they read as the same object. The fill
is at the route band's own `ROUTE_OPACITY` — a disc and the band running into it are one weight of
paint.

All three layers are **depth-tested**, with `depthWrite: false` so they don't fight each other for
the plane. The depth test is load-bearing under a rider: the far half of a flat circle projects
*upward on screen* at this camera angle, and without the test it would paint a band across the
figure standing in the middle of it. Keeping the test on costs occlusion by towers. History: [the
countdown ring that drew without it](rendering-history.md#the-target-disc--geometrytargetringjs).

**It grows out of its own centre and pulls back into it.** Both ends of a pickup change on the same
frame — the kerb disc going dark as the drop-off's lights — and two discs switching on and off read
as two unrelated events rather than as one clock changing hands. `appear()` / `vanish()`
drive a back-eased 0 → 1 (peaking ~1.045, `RING_GROW_TIME` 0.30s) and an accelerating 1 → 0
(`RING_SHRINK_TIME` 0.20s). The exit is deliberately *not* the mirror of the entrance: arriving is
news and wants the beat, leaving is a thing getting out of the way, and an eased exit spends its last
frames as a barely-moving object — the same argument the select pop's undershoot rests on. Both
envelopes are exported and the courier pad imports them, so the two shapes differ and the gesture
cannot.

> **Trap, and it fired.** Shot mode ticks the fare loop **once** and then freezes, so an entrance
> driven off sim time never gets past its first frame — and `appear()` starts at scale 0. Every
> rider's kerb disc disappeared from every screenshot. Hence `settle()`, called via `fares.settleMarkers()` / `parcels.settleMarkers()` right
> before the shot renders, next to the route band's `routeLine.update(..., 999)` — which exists for
> exactly the same reason.

**The sweep** is the third layer: a bright head with a fading tail, circling the outer edge of the
rim once every 3.2s. It is a `MeshBasicMaterial` on the same torus radius as the rim (a little
fatter), patched with `onBeforeCompile` to read a per-vertex angle attribute and fade each fragment
by how far behind a moving `uHead` uniform it sits — `ring.update(elapsed)` only ever touches that
one uniform, so nothing re-tessellates or re-uploads per frame. Additive blending is what makes a
beam of the same hue as the rim beneath it read as brighter rather than merely thicker.

Because the patch changes what the material draws without changing its constructor parameters, it
carries its own `customProgramCacheKey` — see the trap in [CLAUDE.md](../CLAUDE.md) about
`onBeforeCompile` and three's program cache. `setColor` paints it the same colour as the rim and
fill; `tools/probe.mjs` reads all three back together and expects one hex, repeated three times —
except on a **backgrounded** disc, below, where only the rim and fill carry the dim.

The beam has to be told to spin: `ring.update(elapsed)` is called from `game/faremarker.js`'s own
per-frame `update` while the rider's disc is visible, and from `game/fares.js`'s fare loop while a
fare is `riding`, for the drop-off's. Neither ring ticks while hidden.

**`setDim(0..1)` steps a disc back behind the fare in the car.** A waiting rider cannot be picked up
while the seat is full, so their mark turns down for as long as that holds — see
[gameplay.md](gameplay.md#the-board-steps-back-while-the-seat-is-full) for why the disc *darkens*
rather than disappearing. Mechanically it is a colour scale (0.42× on the rim and fill) plus half
again off the fill's opacity, with the sweep fading on `opacity` and then dropping out of the draw
entirely. Scaling the colour rather than fading the material is what keeps it cheap: two of the three
layers are opaque `unlitMaterial`s whose colour *is* their light, and turning them transparent to dim
them would move them into three's transparent queue for a look change. The dim and the clock write
the same channel, so both go through one `paint()` — otherwise a level change would repaint a
backgrounded disc at full brightness four times a fare. The caller (`game/faremarker.js`) owns the
easing; this only ever applies the number it is handed.

**`pulse()` swells a disc once and settles**, borrowing the select pop's own envelope at
`PULSE_SCALE = 0.16` — about +4px of radius on a 27px disc, half the crystal's 0.34 because the two
are wildly different sizes on screen and the gesture has to read as the same one. It is fired on the
**drop-off's** disc when a tap on a kerbside rider is refused, as the "that one first" half of the
answer. The swell *multiplies* whatever the arrival/exit animation has got to rather than replacing
it, so a disc pulsed mid-grow swells out of where it is instead of jumping to full size.

### The courier pad — `geometry/parcelpad.js`

A **rounded square** lying flat on the pavement corner, in the courier's fixed cyan: one rim shape
with the inner square punched out of it as a hole, and one fill shape at the route band's own
`ROUTE_OPACITY`. Both ends of a package's trip wear one. Same `RING_Y`, same depth-tested /
`depthWrite: false` pair, and the same load-bearing reason as [the target
disc](#the-target-disc--geometrytargetringjs): the far half of a flat shape projects *upward on
screen* at this camera angle, so without the depth test the pad would paint a band across the box
standing in the middle of it.

**The shape is the whole point.** A courier job is not a fare and is not reached the way one is, so
it gets a silhouette of its own rather than a second hue on a disc — see
[gameplay.md](gameplay.md#a-package-has-no-clock-and-so-has-no-diamond). `tools/probe.mjs` asserts
the corners reach further from the centre than the edge midpoints do, which is true of a square and
false of every circle: if the pad ever silently becomes a disc, a package and a fare destination
stop being distinguishable at zoom, and no other check would notice.

**It arrives and leaves the same way a fare disc does** — `appear()` / `vanish()` off the very
envelopes exported from `targetring.js`, rather than a second implementation. The shapes are meant to
differ; the gesture is not, or a courier pad and a drop-off disc landing on the same board would be
two different kinds of event.

**It wears the fare disc's beam** — same shader, same speed, same tail, off the shared
`createSweepFor` in `targetring.js`. On a board where the fare discs glint and the pads sit dead, the
pads look like road paint somebody forgot to clean up ([it was left off at
first](rendering-history.md#the-courier-pad--geometryparcelpadjs)). The beam is what says a mark belongs to the
game, and both marks do.

The **path** is the only part that differs, which is why the geometry is the only thing `createSweepFor`
takes — two copies of that shader patch would be two beams free to drift apart in speed, tail or
falloff, and a board carrying a disc and a pad would show two subtly different kinds of "live". The
band is built by hand round the rounded square, and each vertex carries its **normalised arc length**
as `aAngle`, not its angle from the centre: on a rounded square those disagree badly — the centre angle
races through the corners and crawls along the flats — so a beam keyed to the wrong one visibly changes
speed four times a lap. `tools/probe.mjs` asserts radians-per-world-unit is near-constant round the
path, and walks all 882 triangles of the three layers for their winding: a hand-wound band facing away
from this camera is indistinguishable from a beam nobody added.

Nothing calls `setColor`: a package has no clock to repaint for.

> **Trap, and it fired.** The contour is hand-written, so its winding is **asserted, not eyeballed**
> — see the roadworks ramp below. The
> check went red on the first run, and for a third reason worth recording: `ShapeGeometry` is
> **indexed**, so `attributes.position` items 0/1/2 are not a triangle. Reading the attribute in
> order tests a triangle that does not exist, and reported a perfectly good pad as face-down. The
> check walks the index buffer and computes the normal from the winding across all 106 triangles.

### The parcel — `geometry/parcel.js`

A kraft box with a darker lid slab, one tape strip over the top and a white label, merged into one mesh with one material
the way every prop here is. Scale is the same deliberate lie [the
figure](gameplay.md#the-taxis-roof-sign) tells: a real parcel beside a 3.4-unit car would be half a
unit, which is four pixels at play zoom, so this is a crate two units across — squat and wide where
the figure is tall and thin.

**It is sized by area, not by height.** Matching the rider's 3.3-unit *height* measures nothing the
eye does: a box is mass in all three dimensions where the figure is a tall thin sliver, so a crate
that tall reads as a shipping container beside a person. At 1.35 the two have roughly the same
apparent area, with the box a shade under — which is what "the same size" means for shapes this
different. History: [the 2.4-unit box](rendering-history.md#the-parcel--geometryparceljs).

**Every number in the two load modules is a proportion, and `CARGO_SCALE` is the one that turns them
into a size.** It multiplies the finished geometry in `geometry/parcel.js` and `geometry/food.js`
alike, and it is the only knob for how large cargo reads on the board. A factor rather than new
literals because those literals argue one part against another — the label against the tape strip, the
burger against the cup, the straw against the lid — and multiplying twenty tuned numbers by hand would
leave every one of those arguments quoting a size that no longer exists.

It is **set by the food order, not by the box**. At 1.0 a load stands 1.38 across, ~11px at play zoom,
and the box clears the floor because it spends that width on solid card with a white label on it. The
order spends most of it on air between two halves, and on a phone it read as a smudge on a 6.4-unit
pad — reported as exactly that. At 1.45 a load is 2.0 across (~15px), which puts the burger back over
the floor the box was tuned to and still stops a third of the way short of the 2.4 that failed. Both
kinds move together because that is what the shared envelope *is*: a factor on one kind alone would be
the three bugs below.

The HUD chip's frustum carries the same factor (`FIT` in `game/cargochip.js`), so the readout is
pixel-identical whatever the board does — 42px is 42px, and the chip's job is to show the whole of
what is aboard rather than to report how big it is. The deck scale divides it back out, so the size a
flight opens at is unchanged at 0.53.

The tape crosses the **top** face because the camera looks down the +X+Z diagonal, which makes the
top the largest face on screen; a band around the girth would be mostly hidden. It is what says
*parcel* rather than *crate*.

**A courier job carries one of two loads**, this box or the [food order](#the-food-order--geometryfoodjs)
below, and `geometry/cargo.js` is the rig that holds both and switches between them. Both are built
once per slot and one is shown, because a slot is built once and reused for the whole run.

`idle(t)` is a slow Y spin plus a gentle bob, off sim time, and it lives on that rig rather than in
either geometry module — two loads turning at two rates would be two answers to the one thing the
motion says. The rider's answer to "come and get me" is a raised waving arm; a load has no arm, so the
motion carries all of it — and it is deliberately slower than the wave, because a courier job is not
impatient, it has no clock. The box's footprint is square so the spin never changes the silhouette's
width, which is what makes it read as turning rather than as pulsing.

**It is built to read as 📦**, and each of the four parts is doing one job at ~15px: a kraft body; a
darker lid slab so the top seam is a plane rather than a stripe; **one** semi-white tape strip; and a
white shipping label. The strip wraps over the top and down both Z faces as a *single* box — narrow in
X, proud in Y and Z — which is one part doing what three would.

One strip rather than a cross: two strips leave four small squares of card and read as a hot cross
bun. Off-white rather than brown: a dark strip at 15px on dark card is a shadow rather than a strip.

**The label is mirrored onto both Z faces**, which is not decoration. The camera sees exactly two faces
of a box at this angle and they are always one X face and one Z face, so a label on both Z faces is a
label that is *always* visible however far the spin has turned — and the visible Z face then carries
the strip and the label together, which is the pair 📦 shows. With one label it read at half the
rotation, and the half where it was edge-on was a white sliver that looked like a lighting artefact.

**The outbound flight.** A *third* copy crosses from the taxi to the pad on a delivery
(`game/parcels.js`), and it is a separate mesh rather than the kerb one reparented, for the reason the
fare crystal is scene-level: the kerb box lives two transforms deep inside a marker's `postGroup` on a
corner it must not leave, and a flight has to own its world position. Two nested groups, also the
crystal's arrangement — the outer one carries the travel and the scale, the inner box goes on spinning
and bobbing in local space, so the two concerns never fight over one transform.

It grows from `PARCEL_DECK_SCALE` and fades in from `FLIGHT_MIN_ALPHA` over `FLIGHT_TIME` (0.55s, a shade
under the crystal's 0.65 — that one is tuned against the rider's run-and-jump, and the two flights should
not look like the same object anyway). Scale and alpha run *with* the travel rather than on their own
curve, so the box reads as coming out of the car rather than as fading in while it happens to move.

Two numbers were measured, both in service of the departure being a **hand-off** rather than a spawn:

- **The arc is 2.6, up from 1.4.** A world unit is about 7.7px at play zoom, so the first number bought
  roughly eleven pixels of rise over half a second — technically an arc and, on a box that had just been
  halved in size, not one anybody could see. It is a lob now, which is also what makes the *direction* of
  the hand-off legible: up and over out of the car rather than sliding across the tarmac.
- **It leaves from the deck, not from the road.** Launched at the taxi's XZ at pavement height it starts
  under the car's own sills, which reads as the box being posted out through the tarmac. `TAXI_DECK_Y` is
  exported from `geometry/taxi.js` for this.
- **The fade starts at 0.25**, not at zero. From nothing the box is *invisible for the frames it leaves
  in*, so the moment the player reads as the load departing happens later and vaguer than the delivery it
  belongs to.

`tools/probe.mjs` asserts the airborne frames, the growth, and the faintest opacity across the whole
flight — the last deliberately as a floor rather than a reading at either end, because `updateFlights`
calls `rest()` on the same frame it lands and a read taken after `update` returns reports the resting
state. It did exactly that, and passed while printing "opacity 1.00 on contact".

**The pickup's lift.** A collected box does not arrive anywhere in the city — it **leaves**. The kerb
copy is hidden and the flying copy takes over from the same spot, standing at the corner at
`PARCEL_PAD_LIFT` and running the same `idle` off the same clock, so the two are one pose by
construction rather than by a reading taken on the hand-off frame. Over `LIFT_TIME` (0.45s) it climbs
3.6, swells to 1.35, slides 5.5 along `TOWARD_HUD` and fades to nothing.

- **Two curves, and the difference is the read.** The rise eases *out* — the box leaves the pad smartly
  and settles, which is a thing being picked up. The drift eases *in*, accelerating away, which is a
  thing leaving. One shared curve gives a box that either jumps sideways or floats up and stops.
- **It gets bigger, not smaller.** It is not going into anything, and what it becomes is more than twice
  its size, so shrinking would point at the wrong end of the journey.
- **`TOWARD_HUD` is derived, not typed.** It is `UP − RIGHT` from `game/camera.js`, normalised —
  screen-up-and-left across the ground plane, which is where the chip sits. The answer comes out as
  exactly −X and that is not a licence to write −X: the view never rotates, so one world direction is
  one screen direction, and this is the arithmetic that would have to be redone if the azimuth moved.
- **The hand-off fires at 78%, not at the end**, carrying the point the box had reached (its middle,
  which is what the chip's picture is centred on). At the end there is nothing left to cross-fade with
  and the chip reads as a separate pop.

`tools/probe.mjs` asserts the lift starts on the kerb to within 0.01 in all three axes, that it climbs,
swells, fades and moves −X, that the kerb is empty from that frame, and that the hand-off fires **once**,
late, with the box still visible and clearly on its way out (measured: 81% along, alpha 0.30).

> **Trap.** `material.transparent` and `depthWrite` are shader-define switches, so changing `opacity`
> alone does nothing until `needsUpdate` forces a recompile — the rider figure shipped that bug once
> and never faded, it just popped when `visible` flipped. `setOpacity` tracks the last state and only
> invalidates on a transition, because this runs every frame of a flight and a per-frame recompile is
> a stall rather than a fade. `tools/probe.mjs` asserts both halves: transparent *while* fading, and
> opaque with `depthWrite` back on once landed — a box left transparent z-sorts wrong for the rest of
> the run, and the slot gets reused.

**The third copy is in the HUD, and it is where a collected box goes.** While a package is aboard,
`game/cargochip.js` draws the same box into a 42px square under the cash total — a parcel on the taxi's
rear deck was about four pixels at play zoom, which is why that one is gone and the
[courier doc](gameplay.md#the-load-is-carried-into-the-hud) covers the argument. It is the box alone,
with no disc behind it and no rim around it; `#hud`'s own drop shadow is what lifts it off a pale road,
the same one the digits above it wear. Three things about the view:

- **The camera keeps `VIEW_DIR`'s elevation and mirrors its azimuth in x**, so the vector is
  `(−VIEW_DIR.x, VIEW_DIR.y, VIEW_DIR.z)` — still unit length, since negating one component of a unit
  vector leaves it one. The elevation is what makes the silhouette in the corner the silhouette on the
  deck. The azimuth turns for the reason [the tutorial avatar's does](gameplay.md#the-opening-tutorial):
  at the hour the game parks at, the sun's horizontal direction is (−0.78, +0.40), so the +X faces the
  city camera looks at sit at n·L = −0.78. Out in the world that is what makes the shadows read; in a
  42px square with no ground under it, half a black box is a smudge. From the −X +Z quadrant the visible
  X face is at +0.78 and the Z face stays at +0.40, and the visible Z face is the one carrying the strip
  and a label — the pair 📦 shows.
- **The frustum is computed, not eyeballed — once, for both loads.** The box stands 1.16 tall and 1.384 across at the lid, so
  at 45° its half-diagonal is 0.979 and its screen half-height is 1.16·cos33/2 + 0.979·sin33 = 1.02 —
  near enough the same number as the half-width, so one square frustum covers both. `FIT` is 1.15, that
  plus 13% for the drop shadow and nothing else, because a *square* canvas has no corner for the box to
  foul. It measures 52% of the canvas drawn, which is
  what `tools/smoke.mjs` asserts a floor under: a camera pointed slightly wrong frames the box off the
  side of an element that still passes every DOM check.
- **The arrival quotes the box's direction rather than tracking it.** The chip grows from 0.45, fades
  up (opaque by 45% of the way, so the arrival is the growth settling rather than a fade finishing),
  and slides in from a **fraction** of the way toward where the world box faded out — 26% of the gap,
  capped at 120px, scaled along the line so the cap shortens the slide without bending it off the
  direction the box left in. It inherits that box's spin and eases it to the nearest quarter turn: a
  square box a quarter turn from square is the same picture, so the longest settle is 45° rather than
  180°. Tracking it exactly — the box's screen point and apparent size, the whole distance in one move
  — reads as **too fast**: a hand-off with no overlap gives the eye nothing to follow. History:
  [the pixel-exact first cut](rendering-history.md#the-parcel--geometryparceljs).

**The accept flourish.** When a package is collected, every opaque part of the car takes a white
emissive lift together — shell, roof sign and both steered wheels — on the select pop's own envelope,
so an accepted package reads as the same *kind* of acknowledgement a tapped rider gets rather than as a
new effect to learn. 0.32 rather than the rider's measured 0.3: the taxi's yellow is already
the brightest thing on the road, so it has less headroom before the chequer stripe washes into the
body, and the lift has to register on a car that is moving. The chequer's white cells clip at it and
its dark ones do not, which is what keeps the band readable through the flash — see
[The taxi's chequer](#the-taxis-chequer--geometrytaxijs). The brake light and indicators are left
alone — they are lamps with their own state, and lifting them would read as the taxi braking at the
moment it accepted a package.

**Two things fire it**, and they make the same claim about the car: *this one, here*. The other is
[the ride back to the taxi](#getting-back-to-the-taxi) landing, where it answers a player who had
lost the car rather than a box arriving in it. One flourish rather than two, so the gesture is
learned once.

**Two numbers are exported from the mesh** rather than restated wherever they are wanted, because both
are facts about *this box* and both have to agree across a seam. `PARCEL_DECK_SCALE` is "the size this
car handles a box at", derived from `BOX_W` — it is what the outbound flight grows from.
`PARCEL_CENTRE_Y` is half the standing height, and it is both the point the chip's
camera is centred on and the point the pickup hand-off is measured from: the two ends of that line have
to be the same point on the box, or it moves on the frame it changes renderers.

The taxi carries no box on its deck, so the ghost-outline stencil mask is seven parts
(`tools/probe.mjs` counts them, because a part left *out* of the mask counts as an occluder of the
rim behind it).

### The food order — `geometry/food.js`

The courier's other load: an oversized burger with a soda cup standing behind it. Same pad, same
cyan, same money — it differs in what it *is*, and in one thing that is not cosmetic: it is collected
at the [burger joint](gameplay.md#two-kinds-of-load-and-one-of-them-has-an-address) and nowhere else.

**Two objects and no container, and that is the whole design.** A takeaway bag would be a squat
tapered block that reads at ten pixels as *another box*, and cargo on this board is already a box
([the first cut had one](rendering-history.md#the-food-order--geometryfoodjs)). What is worth having here is the pair of shapes nothing else in the game has,
at the size they can be recognised at — so both are several sizes too big, the same deliberate lie
[the figure](gameplay.md#the-taxis-roof-sign) and the parcel both tell. The burger is 1.24 of the
envelope's 1.35, nearly the box's own width, and the finished pair is multiplied by `CARGO_SCALE` like
the box — **the order is what set that factor**, because the proportions here were right and the drawn
size was not.

**A different silhouette, not a different colour.** Hue on this board is spent: shape says what a
thing is and hue says whose clock is paying for it, and a courier job has no clock — so a second load
arriving as a second cyan would be saying something the board cannot mean. What is left is the
outline: a round stack and a tall tapered cup against a squat square, plus the **straw**, which is the
only part of any load in the game that breaks the outline at the top and is what makes the spin
legible the way the tape strip is for the box.

**The burger is the drive-through's own mesh**, `burgerGeometry()` from
[city/burgerjoint.js](city.md#the-burger-joint-and-its-drive-through), shrunk — not a second recipe
for one. That sign is fourteen pixels on a pole and solved this exact problem once already: which
slices read at that size, how much of each has to stand out past the crown, why the cheese is a square
turned 45°. Rebuilding it here would put two burgers in one city, tuned twice, drifting apart on the
first change to either. It is scaled and stood on the ground **by its own measured bounding box**
rather than by arithmetic off `BURGER_R`, so it follows any re-tune of the sign.

**It shares the box's envelope, and that is a hard constraint.** Three things measure a load without
asking which kind it is: the chip frames one square frustum around whatever is aboard, a pickup hands
the chip a point on the load's own middle, and the outbound flight opens at "cargo, at the scale the
car handles cargo at". A taller second load overflows the first, sits off-centre in the second and
opens at the wrong size in the third — three bugs out of one dimension. So the straw's tip lands on
the box's 1.16 and the pair stays inside its sweep, and `tools/probe.mjs` asserts that against the two
meshes that actually get built rather than against the numbers meant to produce them. The width there
is measured as the **furthest vertex from the spin axis**, not off a bounding box: a box's corners are
real vertices, a burger and a cup on a diagonal have nothing at the corners of theirs, and what both
the chip's frustum and the spin care about is the radius.

Three things were measured rather than guessed:

- **The tall one goes up-screen, and the pair sits on the diagonal.** −X−Z is away from the eye and up
  the frame, so cup behind and burger in front is the one arrangement where the burger cannot cover
  the cup's body. On the diagonal rather than side by side for a second reason: two objects strung out
  along one axis swing between their full width and nothing as the order turns.
- **The pair is centred on its own plan extents, after the fact.** The offsets are chosen to balance,
  but the burger carries a scatter of sesame seeds that is deliberately *not* symmetric, so the pair
  as built leans a few hundredths — and the idle spin is about this mesh's Y axis, where a lopsided
  plan reads as an orbit rather than a turn.
- **The cup's body stops well short of the lid line.** Drawn up to it, the straw gets a tenth of a
  unit of air and is a nub; at 0.78 the body is still half again as tall as it is wide, which is all a
  cup needs to be a cup, and the straw gets a third of a unit to stand up in. The lid is **red** for
  the other half of the same read: paper and bun are near neighbours under this sun, so an off-white
  cap on an off-white cup was one shade of one colour.

> **Trap.** `BufferGeometry.scale` goes through `applyMatrix4`, which **recomputes a bounding box that
> already exists**. So a box read off the sign before the scale and held by reference has silently had
> the scale applied to it by the time it is used, and standing the mesh on the ground with it applies
> the scale twice — it sank the burger a quarter of a unit into the pavement. `.clone()` the reading.

Everything is a cylinder, a box or a squashed hemisphere — nothing here is hand-wound, which is what
keeps it clear of [the winding trap](#the-courier-pad--geometryparcelpadjs) the pad next door fell
into.

### The drop-off ring — `geometry/marker.js`

The drop-off is a **filled disc on the kerb corner and nothing else** — no head, no post, so the
board never carries two identical silhouettes of which only one reports anything. See
[gameplay.md](gameplay.md#the-drop-off-is-a-ring-and-it-wears-the-riders-clock), and
[history](rendering-history.md#the-drop-off-ring--geometrymarkerjs) for the crystal-on-a-post and the four colours it
has worn.

**It wears the clock of the rider in the car**, rim, fill and sweep alike: built on the top of the
urgency scale and repainted by `game/fares.js` (`paintDropoff`) whenever that clock steps a level, so
the disc and the crystal riding over the taxi are never seen a level apart. A VIP's stays its fixed
purple. The gate is on the level, not the frame — three materials, four steps in a whole clock.

The clock the drive is spending belongs on the thing being driven at. Band and disc are the same
paint as a result — both are that fare's colour — and they meet on the same tarmac at the same
opacity, so the band running into the disc reads as one mark from the car to the kerb.

The taxi's roof sign no longer wears a fare colour either — it just lights on and off with whether
someone is aboard — see [gameplay.md](gameplay.md#the-taxis-roof-sign). `?shot=10` frames the
drop-off on its kerb corner, the only framing that shows the ring close up.

### Off-screen fare pointers

`game/farepointers.js`, styled under `.fare-pointer` in `index.html`. Arrows that clamp to the
viewport edge and rotate to point at a mark that has slipped off the frame. Each wears the colour of
the fare it stands in for, which is that rider's clock: the colour is written from JS onto the
wrapper's `color` and the polygon fills with `currentColor`, so a level change is one style write.
The value in the stylesheet is only what one opens on before its first write.

**Two kinds, one arrow, and they are exclusive.** With the seat free, *every rider still on a kerb*
gets one — which replaced the [rider-finder chips](gameplay.md#finding-the-next-rider). With a rider
aboard there is exactly **one** arrow on the whole frame and it is the drop-off's.

That exclusivity is the [step-back](gameplay.md#the-board-steps-back-while-the-seat-is-full) reaching
the frame edge. An arrow is a *go here*, and a kerbside rider is the one thing on the board a player
carrying someone may not go to — so a ring of three or four of them is that many invitations to do
the thing the game refuses, spent on the only channel that has no room for nuance: an arrow has a
direction and a hue and nothing else to say "not yet" with. The rule lives in `update` rather than in
the caller passing an empty list, because it is one rule about arrows.

It costs something real. A waiting rider off the side of the frame now has *no* mark at all while you
are carrying — their disc is still on the tarmac at their corner, and the arrow returns the instant
the seat empties, but on a phone mid-trip "off frame" and "invisible" are the same thing, so the
board's ordering puzzle is readable only by panning. That is the deliberate price of the frame saying
one thing at a time.

#### Off-screen drop-off pointer

The drop-off's arrow is drawn a size up (`.is-dropoff`, 42px against 35px) even though it is alone
while carrying: the sizes have to keep meaning what they mean across the transition, and a lone arrow
that shrank when the seat filled would read as the trip mattering less. It aims at `y = 0.1` — the
mark on the road — and it is the only cue for an *off-frame* drop-off, which is the case the map
being bigger than the viewport actually creates. History: [the pin it used to aim at](rendering-history.md#off-screen-fare-pointers).

#### The rest of the pool

The pool grows on demand and is never shrunk: `maxFares` riders plus one drop-off, so it tops out at
five divs. `tools/smoke.mjs` asserts the bookkeeping — as many arrows up as there are marks *eligible*
to raise one and outside the band, each coloured and each inside the frame — through
`__taxi.projectToScreen` and `__taxi.cornerFor`, which are the same functions the HUD itself aims
with. It mirrors the exclusivity rule rather than reading it off the module, so the two have to agree
rather than agreeing by construction, and it reports whether the sample it passed on actually
*reached* a board with someone aboard and a kerbside rider off-frame — the state is a fact about
where the taxi has driven by then, and a pass that never met it says so rather than looking like
proof.

The third thing the map outgrowing the frame can lose is the **taxi itself**, and that one gets a
chip rather than an arrow: a direction is enough when you already know what is over there, and not
enough when what is missing is your own car. See [getting back to the taxi](#getting-back-to-the-taxi).

#### Tapping an edge arrow

On a narrow viewport a press on an arrow glides the camera onto the mark it is pointing at, and the
arrow then takes itself down because the thing it stood in for is in frame. `onTap` in
`game/farepointers.js`, `lookAtMark` in `main.js`, and it is a two-line handler on top of the same
`glideTo` [the rider peek](#the-rider-peek) travels on — the interesting part is all in what it
deliberately does not do.

**It moves the camera and nothing else.** Dispatching in the same tap is exactly what the
[rider-finder chips](gameplay.md#finding-the-next-rider) did, and what the board was rebuilt without:
the player still has to read the corner, judge whether the fare is worth the drive, and tap the
rider. What the arrow hands over is the *pan* — dragging the map in a direction it was already
naming, guessing when to stop, on a clock that is draining — which was never the decision.

**It keeps the camera.** A [chip tap](#the-rider-peek) peeked and rode home, because it was a glance
at a rider the taxi was already driving at. This is the player asking to *look* somewhere and then
act there, so it takes the camera the way a swipe does (`releaseCameraToPlayer`) and stays.

**Until the player acts.** The arrow sets `arrowLookOut`, and the next tap that dispatches the taxi
at a *waiting* rider (`rideHomeAfterPick`) brings the camera home: a zero-length `peekAt` on where
the camera already stands, so it holds the peek's 0.9s beat — long enough to see the crystal flip and
the route band draw — then rides back onto the car and hands it to the follow-cam, with the same
`flashTaxi` as the finder chip. Without it every arrow-then-pick ended in a drag back across the map
to watch the trip the player had just started. One pick consumes it; a drop-off tap or a refused
pickup does not (neither started a trip), and the taxi-finder chip clears it. A swipe mid-beat drops
the ride home like any peek. The other way back remains the taxi-finder chip, which comes up 0.4s
after the car goes fully off-frame.

**Narrow only,** for the reason drag-to-pan and both follow-cams are: above `NARROW_VIEWPORT` the
whole city is in frame, so nothing is ever off it and there is no pan to save. The gate is a
`can-tap` class on the host, set from `isNarrow` every frame so a resize flips it without a reload,
and while it is off the arrows keep `pointer-events: none` — which matters for more than tidiness:
an arrow that answered a pointer on a desktop would be an invisible hole in the map at each point
around the frame, eating clicks meant for the city.

Three details that are each a bug if they go the other way:

- **The hit area is a pad, not the shape.** The art is 35px, under the 44 a thumb wants, so
  `.fare-pointer::before` runs `inset: -8px` for a 51px square about the same centre. A pad rather
  than a bigger box, so `EDGE_MARGIN`'s clamp arithmetic and the drop-off's size step keep meaning
  what they say.
- **The destination is read at press time**, off `atX`/`atZ` on the pool slot. One pooled div
  answers for a different fare from one frame to the next, so a listener closed over whoever held
  the slot when it was created would ride the camera to a rider who was picked up two blocks ago.
  `aimed` is cleared whenever an arrow goes down, so a hidden slot cannot answer with a stale mark.
- **A `pointerdown`/`pointerup` pair, not a `click`.** WebKit only synthesises a click on a bare div
  that passes its own "is this clickable" test, and the pair also has to reject two things a naive
  handler accepts: a drag that began on the map and merely *finished* over an arrow (hence pairing at
  all), and a press that slid away to mean *no* — a touch pointer is implicitly captured to the
  element it landed on, so the `pointerup` arrives here regardless and only a `TAP_SLOP` travel test
  tells the two apart. The press dip is an `is-held` class for the same reason `:active` fails on
  [the pedals](gameplay.md#the-pedal-slide), arriving by a different route: `:active` would stay lit
  on an arrow the finger had already abandoned.

What it costs is that an arrow outranks the canvas under it. A press within ~25px of one belongs to
the arrow, so the [route band](#route-band--gameroutelinejs) is that much harder to grab out at the frame edge,
and a swipe that *starts* on an arrow does not pan the map at all — the capture means the canvas
never sees the rest of the gesture. Four 51px squares against a whole frame of map, and the swipe is
still there one thumb-width away. It sits at z-index 18, under the pedals (20) and the pause button
(24), so a thumb sliding onto the brake still gets the brake.

`tools/smoke.mjs` presses one with a real `Input.dispatchTouchEvent` rather than a synthesised click
— for the reason the initials check does (see the caret trap in `CLAUDE.md`): a
`dispatchEvent(new MouseEvent)` runs the
handler whatever the hit-testing says, so it passes just as happily against an arrow that is
`pointer-events: none`, buried under the HUD, or too small for a thumb, and every one of those is the
bug. It asserts the camera *landed on a mark* — compared against the corners the board was offering,
read in the same task as the arrow's rect — that the taxi was **not** dispatched, and that the host
carries no `can-tap` at 900px wide.

### Off-screen police warning

`game/sirenglow.js`, styled under `#siren-glow` in `index.html`. Red and blue washing in over the
viewport edge a chasing patrol cruiser is coming from, strobing in step with its own light bar and
gone by the time the car is properly in frame.

Same problem as the pointer above and aimed the other way. The drop-off is somewhere the player is
driving *to*, and a pointer is navigation; the siren is something driving *at* them, and this is a
threat they cannot see yet: a patrol that spotted the taxi and is coming for it from wherever it was.

**It is on exactly when the light bar is on, and does what the bar does.** `state.lit` gates both.
On patrol ([the patrol cruiser](traffic.md#the-patrol-cruiser)) the bar swings slowly between red
and blue and so does the wash, eased and at `PATROL_WASH` (0.6) of a chase's strength — *a cop is on
the board*. Once it gives chase both strobe hard — *it is after you*. Driving off after losing you,
both are dark. The probe asserts it directly: nothing with a dark bar ever lights the edge, nothing
lit and off-frame ever fails to, and the patrol wash changes side twice a second against the hunt's
eleven, never in a step.

The strobe comes off `sirenOn()` in `geometry/lights.js` rather than a clock of its own, which is
the only reason the two stay in step. The off colour holds the same low
glow the lamps do (14/90 of the lit one): a hard on/off alternation reads as flicker rather than as
a siren.

Two numbers decide how hard it burns, multiplied:

| | | |
|---|---|---|
| off-frame | `FADE_ON` 0.88 → `FADE_FULL` 1.30 | as a fraction of the half-frame, so 1.0 is the edge exactly. Ramped rather than switched: the cruiser crosses the band in about half a second, so "you can see it" hands over to "it is behind the edge" as a fade. |
| proximity | `GLOW_NEAR` 40 → `GLOW_FAR` 120 | world units, so the wash is a distance read and not just a bearing — full inside two blocks, easing back to a `GLOW_FLOOR` of 0.35 at six. Never to zero: a siren on the far side of the city is still worth knowing about, it just isn't the thing about to happen. |

`q` is the **max** of the two axes' offsets rather than their length, which is what makes 1.0 mean
"on the frame edge" for every bearing — a viewport is a rectangle, and a radial measure calls the
corners off-screen while they are plainly in shot.

Drawn as one fixed full-screen div carrying two radial gradients, centred *on* the point where the
cruiser crosses the frame edge, so a side approach shows half a bloom and a corner shows a quarter
with no per-side special cases. `mix-blend-mode: screen`, because an emergency light adds rather
than tints and over a daylit city an alpha red reads as a muddy filter. That blend is a full-frame
compositing pass, which is why the element is `hidden` outright whenever the wash is off — a siren
is up for a few seconds a minute. Not a three.js light: a real one would mean lighting a city built
for a single global key off a car that is by definition outside the frustum.

Under the HUD at `z-index: 8`, over the canvas and below everything else — this is light in the
world, and washing it across the money counter would read as a UI effect.

**The getaway's frame — `game/robberyglow.js`**, styled under `#robbery-glow` in `index.html`. The
same light put to the opposite use: during a robbery four cop cars hunt the taxi from every side, so
a bearing would be noise, and what the player needs told is *which mode the game is in*. Six soft
blooms of red and blue sit round the frame edge for as long as the getaway runs — each the siren
wash's own radial gradient centred on the edge, `screen`-blended, the same dim floor on the off
colour — alternating colours with their neighbours and swapping on the patrol beat (`sirenOn(time)`)
like the two halves of a light bar. Spots rather than a band round the whole perimeter, which crept
into the play view from every side at once. Peak alpha 0.5 (between the wash's floor and its full
strength, since six are up at once), radius 0.8 of the wash's; the envelope rises over 0.8s when the
robber gets in and falls over 1.2s after the drop-off. `stepLevel` and `frameWash` are pure so
`tools/probe.mjs` can check them.

**The hit cue — `game/hitcue.js`, off by default.** A prototype behind `?hitcue=chip|edge|both`
that says what a bump cost, then goes away (the car itself is the damage gauge,
`game/taxidamage.js`). `chip` is a short bar over the taxi's roof whose lost chunk flashes red and
drains, with ticks at the two damage tiers; `edge` is a red vignette in from the frame edge
(`#hit-edge`), harder for a bigger hit and an emptier car, drawn as a plain multiply-style wash
rather than another screen-blended bloom since the siren and robbery glows already own that edge.
Both run on game time, so a pause holds them.

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
fill and sweep back alongside the crystal at every step of a drain. The drop-off's disc is painted
from the same level by `game/fares.js`, one module further out, because that one has to survive this
marker flying away from it.

`LIFT` is 7.05 on both ends of the trip, measured from the crystal's **bottom point** rather than
from its middle — which is what kept the headroom fixed when the shape became a plumbob and grew a
longer taper. Over a rider (topping out a little over 3.3) that leaves the point 1.3 units — about
10px at play zoom — of air above their head. Over the taxi (which tops out at ~2.85 including its roof sign) it
leaves ~1.85, and being a little further off is right anyway: the taxi is wide, and a marker tight
to the roof reads as part of the vehicle. One altitude for both is what makes the transfer read as
sliding sideways instead of climbing.

The **flight** is `TRANSFER_TIME = 0.65s` on a cubic ease-out, lofted by `sin(eased · π) · 1.6` so it
arcs across rather than sliding along the pavement. Both endpoints are anchors without the bounce
folded in, so the crystal doesn't jump at either end of the flight.

Four animations share the crystal's local transform and simply add:

| Channel | Driven by |
|---|---|
| `position.y` | the resting bounce, plus `KICK_HOP` × the kick envelope |
| `scale` | `KICK_SCALE` × the kick envelope, plus the panic pulse's `0.15 × (0.5 + 0.5 sin)`, plus `POP_SCALE_DIAMOND` × the [select pop](gameplay.md#the-tap-pops) |
| `emissiveIntensity` | the select pop's light, `EMISSIVE` (0.35) → `HIGHLIGHT_EMISSIVE` (1.05) and back |

Adding rather than switching is deliberate: a level change landing inside the last five seconds
should read as a knock on top of a beating marker, not replace it — and a tap on that same rider has
to answer over both. The pop is the one that touches `scale` and *not* `position.y`: the hop is the
kick's signature, and a pop that left the ground would read as the clock having stepped.

**Everything is a function of sim time**, including the flight and the pulse — no accumulated `dt`
anywhere — because a frozen shot has to render the same frame every time. Both the kick's and the
flight's start times are stamped inside `update()` rather than at the call site, so neither animation
depends on the order `setUrgency`, `beginTransfer` and `update` happen to be called in. `pop()` is
deferred the same way, and there it buys something extra: the rider figure's half of the pop stamps
in the same tick, so both take their zero from one `state.elapsed` and stay on one curve. Each slot
gets a fixed phase offset on the bounce so two fares don't pulse in lockstep.

**It is depth-tested**, because an inverted-hull crystal has to be: with the depth test off it paints
its own back faces over its front ones. So a fare behind a tower is hidden with the tower, on
the kerb and in the car alike. Nothing covers that now: the rider-finder chips used to, with a
countdown of their own per rider, and they were taken out on purpose — see [finding the next
rider](gameplay.md#finding-the-next-rider). What is left is the
[edge arrow](#off-screen-fare-pointers), which says the direction and the clock but not where along
that direction the rider is standing. In the car nothing does either;
the taxi's ghost outline says where the car is, but not how long is left.

The crystal and its hull both have `raycast` stubbed out. The rider's marker and the taxi both carry
an oversized invisible tap target that already covers this airspace — the rider's
[reaches to the crystal's top point](gameplay.md#the-tap-target) for exactly this reason — so
intersecting the crystal would only cost work on every tap.

History: [the markers it replaced](rendering-history.md#the-fare-marker--gamefaremarkerjs).

### The outburst bubble — `geometry/cursebubble.js`

What a [VIP](gameplay.md#vip-pickups) says on their way out of a cab that didn't make it: a jagged
comic bubble with `%#&@!!` in it, riding over the rider for the two seconds of their bail.

**It is drawn in the screen plane, by a constant.** The camera never rotates, so facing it is one
quaternion built once out of `RIGHT` and `VIEW_DIR` — `BILLBOARD`, which lives in `game/camera.js`
beside the view direction it comes from and is shared with the markers' tap targets
([gameplay.md](gameplay.md#the-tap-target)). Same property the flyover's streamers use for their
roll, and the reason nothing here needs a per-frame `lookAt`. Everything in the module is
then authored in that plane: local +X is screen right, +Y is screen up, +Z is straight at the
viewer. It also makes the bubble's position trivial — a pure world-Y offset has no component along
`RIGHT`, so lifting it in world Y moves it straight up the *screen* and the tail stays pointed at
the head under it wherever the rider is standing.

**Every mark is geometry.** There is no font in this project and no texture loader, and a
canvas-drawn label would be the one thing on the board that is a picture of writing rather than a
built object. So the six glyphs are strokes: a rotated rectangle helper, a square-blob helper for
the dots, and one annulus for the `@`. The `&` is an asterisk and the `@` a ring with a pip, which
is how a grawlix is lettered rather than typeset — at ~7px per glyph an ampersand's loops are a
smudge and a five-armed star is a mark. The whole thing is ~57px wide at play zoom, which is
comfortably the largest thing the game ever puts over a rider, and it is meant to be: it is on
screen for two seconds and it is the only notice a player gets that a fare has just walked.

Three flat layers back to front — a dark outline, the VIP's own purple filling the whole shape, then
the grawlix in white — each `unlitMaterial`, `depthWrite: false`, ordered by `renderOrder` above the
crystal's own pair. **The purple is the mass, not the border**: as a border the identity is 2px of
rim while 57px of blank paper carries nothing. Filled, the silhouette itself says *that was your
VIP*, and the marks read white-on-purple, which is the higher-contrast way round at 7px a glyph. The
strokes are 0.24, because light marks on a saturated field need more body than
dark ones on a pale one to read at the same weight.

The outline is an enlarged copy of the same silhouette rather than an inverted hull: a hull is a
*volume* trick, and on a flat shape the enlarged copy's back faces point away from the camera and
draw nothing at all. Its offset is in world units per axis, for the reason [the plumbob's
rim](#the-pie--geometrydiamondjs) gives — the bubble is nearly twice as wide as it is tall, so
one scale factor would draw a border half as thick at the top as at the sides.

**The tail is a rim point, not a triangle stuck on the bottom.** The silhouette is one closed
polygon of alternating spikes and notches with a single long spike pointing down, and it is drawn as
one fan from the centre — so no two triangles overlap. Two overlapping translucent triangles are
invisible at full opacity and then paint a bright seam across the shape as it fades out, which is
exactly when someone is looking at it. Every triangle is hand-wound counter-clockwise seen from +Z
and `tools/probe.mjs` checks the sign of the normal computed *from that winding*, on every face of
all three layers — the lesson the [roadworks ramp](#roadworks--gameroadworkjs-geometryroadworksjs)
paid for, and the one the courier pad's first winding check learned one layer further down.

History: [the purple border](rendering-history.md#the-outburst-bubble--geometrycursebubblejs).

### Car motion

Cars get a subtle vertical bounce while driving and **roll into corners** for weight. The roll is
applied with a compensating lift:

```js
lift = Math.abs(Math.sin(roll)) * (CAR_W / 2)
```

Without it, leaning pushes the outer wheels underground. Nothing flat on the road is rolled with the
body — tilting a ground disc into the road z-fights.

**Every body poses with `BODY_EULER_ORDER` (`'YXZ'`, in `util/geo.js`), and the default order is
wrong here.** Three composes `'XYZ'` as Rx·Ry·Rz, which puts the roll *outside* the yaw and so turns
it about the **world** X axis — the body's own long axis only when the body happens to be heading
east. On a north or south street the same number renders as pitch and the lean disappears entirely;
heading west it leans the opposite way. `'YXZ'` is Ry·Rx·Rz: yaw first, roll about the body, the
same lean at every heading.

The two orders agree *exactly* at yaw 0 — which is why [the passing lab](lab.md), whose road runs
due east, cannot show the difference. `tools/probe.mjs` measures the lean at all four headings and
asserts the constant reaches every body that leans. History: [the taxi that leaned on two streets
of four](rendering-history.md#car-motion).

### The city entrance — `game/cityentry.js`

**Prototype.** When a run opens, the streets and ground are already in place and the buildings and
trees grow out of them in a wave that spreads from the taxi's spawn — the run starts where the
player's car is, and the city builds itself outward from them. Each object rises from the kerb
while it fades in, overshoots its full size (easeOutBack, peak +37%) and settles, with a puff of
dust off each building's footprint as it breaks ground. About two seconds end to end — the
defaults were tuned in the panel below toward quick-and-snappy: a brisk sweep, a 0.3s grow, zero
delay jitter (clean distance rings read as one wavefront at this speed) and a deliberately
cartoon-loud pop, which at 0.3s is over before a subtler one would register. Replay it from the
console with `__taxi.cityEntry.replay()`, or re-aim the wave with
`__taxi.cityEntry.replay(__taxi.traffic.taxi)`.

On iOS in a browser tab — where [the "Add to Home Screen" screen](#the-add-to-home-screen-screen)
parks the run behind its veil — the entrance is skipped outright rather than deferred: a city
that hasn't built yet is a bare street grid under the overlay, which reads as a broken load. The
skip lands before the first frame (see the frame loop in main.js), so that screen always dims a
finished city.

The levers — wave speed, per-object grow time, delay jitter, overshoot, dust strength — are live
uniforms with a **City entrance** section in the ⚙️ panel (`?debug`): every slider replays the
entrance on release, and the panel's settings-JSON export captures the values under
`cityEntrance`, keyed to the module's constants for pasting a keeper back in.

The interesting constraint is that the city is **two merged meshes** — that's the whole rendering
strategy above — so there are no per-building objects to animate. Instead every vertex is stamped
at build time with its building's ground anchor in an `aEntry` attribute (`stampEntry` in
`util/geo.js`), and a vertex-shader patch scales each vertex about its own anchor off one shared
clock uniform. The merge never comes apart; the whole animation is one uniform write per frame.
The per-object delay jitter is a **hash** of the anchor, not an rng draw, so stamping is
geometry-neutral: the city a seed builds is byte-for-byte the same city.

Things the module already accounts for (details in its header comment): composed
`customProgramCacheKey`s so the patch coexists with the SSAO patch; a patched
`customDepthMaterial` so shadows grow with their buildings; a fragment discard while an object is
unrevealed, because a scale-0 building is a flat depth-writing sheet at kerb height rather than
nothing; and `settle()` on the shot path, since a frozen shot would otherwise render an empty
street grid — the same class of bug as the fare discs' `settleMarkers()`.

The dust rides the boost trail's pool in `game/dust.js`. That's a deliberate borrow: the entrance
runs out in the opening seconds, before anything else can be spending slots. One burst per
building (7 puffs, power ~0.9–1.25 by footprint, started most of the way up the size curve) — much
less is invisible at play zoom, where a two-unit cloud is a couple of pixels of haze.

History: [the first dust pass](rendering-history.md#the-city-entrance--gamecityentryjs).

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

**One list, for every iOS browser.** Current Safari collapses the toolbar behind its own ⋯, so Share
is a menu item there exactly as it is in Chrome and Edge (verified on a device). A second,
UA-sniffed list would be a guess about someone else's iOS version, and naming a first tap that isn't
on screen is the failure it would cause. History: [the per-browser list](rendering-history.md#the-add-to-home-screen-screen). Only the **first** step carries a glyph, because only the first step is a hunt;
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
told something that is still true — a show count with a give-up would expire the advice while the
reason for it did not.

`?hometip` forces it up on any platform, which is the only way to lay it out without a phone in
hand; `tools/smoke.mjs` checks both directions of the detection, the step list, the run hold, and
that it returns after a reload, under an emulated iPhone.

## Debug panel

`src/game/debugpanel.js`, behind the ⚙️ button bottom right — only built when the URL carries
`?debug`, `?settings` or `?audio` (or in dev mode, and never in shot mode — `debugMode` in
`main.js`). At small widths the button would sit where the streak counter lives, and it's a tool
almost no player needs to see. Split by cost:

- **Live** — day cycle on/off, day length, time of day, sun colour/strength, ambient fill, fare
  clock, route blend, occlusion strength, the city-entrance levers, the
  [Loco Mode ramp](traffic.md#the-ramp-is-live-tuning), and — when their flag is on — every number
  in [Crayon Mode](#crayon-mode--gamecrayonjs) and [Cartoon Mode](#cartoon-mode--gamecartoonjs),
  the two hull rims included
- **Restart to apply** — car count, and **which look is on** (off / crayon / cartoon / both), both
  written as URL parameters before a reload

The look switcher is in the second group and cannot be in the first: both modes are compiled into
every prop material *before a mesh exists*, so switching one means recompiling every program in the
city. It is written as an explicit `on`/`off` rather than by deleting the parameter, so a reload out
of a look lands on the stock renderer instead of on whatever the URL happened to carry. What it buys
is that trying the two against each other stops meaning hand-editing the address bar — which is
exactly the friction that stops a look from being judged properly.

Pretending a rebuild-only value is live would just show a slider that silently does nothing.

Those flags are **debug mode**, and debug mode also plays differently so the game can sit open
behind the panel untouched: the tutorial is skipped, and every fare clock is held for the session
(the same `fares.setPaused` hold the tutorial uses, via `holdFareClocks` in main.js), so no rider
expires and the run never ends on a missed fare. The title screen's tips setting is not touched.

Every section starts **collapsed**, with a search box pinned above them. The code still builds the
panel flat — `heading()` then rows — and `organise()` folds it into sections at the end, so a new
section only has to start with `heading()`. Search matches section titles plus row labels and
button text (every word has to land somewhere, so "loco brake" finds one slider), forces matching
sections open and hides the rest. Which sections the user opened is kept in `sessionStorage` and is
never written while a search is narrowing the panel, so clearing the search restores it. The look
is deliberately a neutral tool style rather than the game's. The sound designer's mix controls
are sections here too ([audio.md](audio.md)); `?audio` opens the same panel.

Touching any lighting control stops the day cycle, rather than letting the next frame overwrite the
change. **Copy settings JSON** exports the live values (not the slider positions, so manual
overrides are captured) for pasting back as new defaults.

Nothing here persists across a reload **except** the Loco Mode tuning, which is stashed in
`localStorage` and restored on the next `?debug` load — see
[traffic.md](traffic.md#the-tuning-survives-a-crash) for why that one is worth keeping and why the
gate matters.

History: [when the button was always on](rendering-history.md#debug-panel).

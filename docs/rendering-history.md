# Rendering history

How the renderer got to where [rendering.md](rendering.md) describes it: designs that were
superseded, first attempts that failed, features that were removed, and what the `?x=classic` flags
bring back. rendering.md says what the game does now and why; this page keeps the record of what it
used to do, so the reasoning behind a change can still be read after the change has landed.

The sections follow rendering.md's order and headings, and each links back to the current one.
Pull-request numbers and dates are given where the git history records them — most of this
predates the repository's first commit here (2026-10-08) and is undated.

## Wheel wells — `archedBodyGeometries` in `geometry/wheels.js`

[Current](rendering.md#wheel-wells--archedbodygeometries-in-geometrywheelsjs).

The arched body replaced a plain box that the front wheels' inner 0.41 sat buried in, so at any
steering angle the flank cut the tyre on a slant. The taxi's chequer stripe used to sit at the waist;
once the arches rose to 1.34 that cut kept about two of its six cells, which is why it moved to the
shoulder.

## Car finishes — `propMaterial({ gloss })` in `util/geo.js`

[Current](rendering.md#car-finishes--propmaterial-gloss--in-utilgeojs).

The first cut bent three's `normal` itself, which the diffuse reads too, and every car went soft and
bubbly — the facets that make this a low-poly game smoothed into one rounded lump. That is why the
glint and the reflection now read two *extra* bent normals and the diffuse keeps the flat one.

## Car paint — the layered finish

**Rim was the default from 2026-10-16 to 2026-10-17** (`?paint=rim`): toon's hard glint and sheen in
the paint's full hue with the rim line, until the realistic look with painted streaks replaced it.

**Toon was the default from 2026-10-13 to 2026-10-16** (`?paint=toon`): the same hard glint and
sheen as the rim look, with the sheen half white (`tint` 0.5) and a band of sky mixed over the
body past 0.6 graze where the rim look adds its coloured backlight. The half-white sheen is what
made the taxi read silver from above.

[Current](rendering.md#car-paint--the-layered-finish).

**`?paint=classic`** keeps the paint from before the layered finish — its own GLSL, not the new
shader fed the old numbers. What it does differently:

- **A white sheen.** The classic broad lobe was white, and a white broad lobe over a coloured base is
  precisely what plastic looks like; the layered paint tints it with the paint's own hue.
- **A square flake.** The classic flake was a square cell 3x or 0.6x bright multiplied into the
  sheen: a mosaic up close, and it shimmered at play zoom, where a cell is about a pixel. Measured
  moving the camera a third of a pixel a frame at play zoom, paint pixels jumping more than 12 levels
  frame to frame were 4.3% on the taxi under classic (3.3% layered) and 3.7% on a traffic car (2.9%).
- **A hard reflection march.** The classic march takes the first step under a roofline as façade.
  Its streaks were already on the glass, but under the layered paint's clear coat they reached the
  paint, and on a white panel a ragged black claw mark from 14 coarse steps read as a scratch — which
  is why the layered paint softens the hit by ray length (`GLOSS_HIT_SOFT`).

`?bench` keeps a `paint classic` row for measuring the cost difference on a device.

The layered paint was the default until **toon** replaced it, picked 2026-10-13 (#501, "Toon car
paint by default, with layered, chameleon, satin and classic behind ?paint=").

## Camera

**The camera stayed where the player left it** until 2026-10 (`?camreturn=classic`). A swipe handed
the framing over for good, on the reasoning that a camera fighting a deliberate pan is worse than
one occasionally pointed at nothing; the taxi-finder chip and the peek's ride home were the only
ways back. In practice a look across town left the car lost in the frame or off it, and finding it
again was a drag by hand, so the camera now rides home after 1.5 idle seconds (3 at first).

[Current](rendering.md#camera).

- **The boost follow used to stop dead on release.** That is the moment a drift's exit kick fires, so
  the kicked taxi drove straight out of frame. The press now clears the player's takeover and the
  follow carries on through the momentum tail.
- **The follow's own trail was left in at first.** Before the lead (and the trail cancellation that
  came with it), the boosting taxi sat 6% of the half-frame *past* centre, so the follow showed less
  road ahead than a static frame would have.
- **The route band used to convert pixels to world units too**, to hold a constant 2px width. It
  stopped when it became paint on a lane, which has to shrink with the road when you zoom out.

### Loco Mode's push-in

[Current](rendering.md#loco-modes-push-in).

**The depth and the rate took three settings to land.** It opened at 0.93/2.2, which was invisible:
7% spread over 1.4s is 0.05% of the frame per frame, under the threshold anything reads as motion,
against a whole city already sliding past under the follow-cam. Verified in a real browser at
390×844 rather than argued about — the push-in was arriving in full and simply could not be seen.
0.84/5 was visible and still read as gentle. It is 0.76 in at 9 and out at 3 now.

### The closing shot

[Current](rendering.md#the-closing-shot).

- **Too Slow used to aim at the drop-off** for a rider aboard — "here is the corner you didn't reach"
  — with that one pin left standing while the rest of the board cleared. The corner stopped being the
  event once the rider got out and walked: the door being thrown open is, and a shot held a block
  away from it frames a stopped taxi with nobody in it. The ring at the far end is still left
  standing.
- **The Too Slow banner waited 2400ms.** The retry screen slid over a rider still running; the bail
  is ~2830ms on the clock, so it is 3000 now.
- **The timer ring.** The `VIEW_DIR` diagonal set the old timer ring's sweep start at `-3π/4` for as
  long as that ring existed, since a clock has to drain from screen-top.
- **The invisible skid mark.** An early skid mark that was reported invisible wasn't: it was 0.3
  units wide, and at play zoom 1 unit ≈ 7.7px, so it rendered as 2px. That is where the
  size-it-against-the-camera rule comes from.

## Lighting

[Current](rendering.md#lighting).

The golden-hour sun and fill started at `#FFDEBB` and 1.50 and were held down (to `#CFBD8C` at 3.55
over a 1.20 fill) to leave the shadow tint something to work against. The shadow tint's knee (0.45)
was measured against the 1.50 fill.

### The shadow tint — `SHADOW_UNIFORMS` in `util/geo.js`

[Current](rendering.md#the-shadow-tint--shadow_uniforms-in-utilgeojs).

`propMaterial()` used to patch only when AO, Crayon or Cartoon Mode asked. The shadow tint is the
first patch that is not behind a flag, so it patches unconditionally now.

## Atmospheric perspective

[Current](rendering.md#atmospheric-perspective).

**A note in `scene.js` used to say an orthographic camera couldn't have distance fog, and it was
wrong.** The claim was that a camera sitting a fixed 400 units back whitens the whole city
uniformly. What is actually true is that fog placed *from zero* does: over the 335–465 depth band
`Fog(near = 0, far = 1000)` varies by a few percent end to end and reads as a flat wash, which is
exactly what got measured and then written down as a property of the projection. The island edge's
section repeated the claim. Both were corrected when the band was moved round the standoff.

`HAZE_TOP` started at 0.22, came down to 0.17 when the colour stopped being a near-white, and is
0.19 now (paired with the paler 0.73 sky sample below). At 0.17 the map's corners measured 0.132,
0.78 of the frame edge.

### The colour — `hazeColor()`

[Current](rendering.md#the-colour--hazecolor).

**It shipped as the horizon**, and got reported as "reads as pure grey". `skyBottom` is #DCEDF7;
mixed at the 0.22 the haze then carried into `concrete`, the commonest façade in the city, it lands
on #C0C1BC — **5 points of spread**, which is neutral grey.

**Then it sampled the zenith** (`HAZE_SKY_H = 1.0`), which made the haze `skyTop` exactly, taken to
full saturation:

| | 06:30 | 09:00 | 16:24 | 18:36 | 00:00 |
|---|---|---|---|---|---|
| horizon | `#F0B080` | `#CFE0EA` | `#DCEDF7` | `#F09A60` | `#16202E` |
| haze | `#0069AA` | `#009EE0` | `#4AC6FF` | `#004788` | `#001024` |

At 18:36 that gave `#004788` — the far city blue while the horizon behind it was still orange, which
inverts what air does at dusk. It was accepted because the shipped look is 16:24 with the cycle off;
Sky sample ~0.35 restored a warm `#D05600` at dusk at the parked hour's expense. The sample is 0.73
now (`#77CFFF` at the parked hour).

Measured on a rendered shot, as mean blue-minus-red per band, across those versions:

| | no haze | horizon haze | zenith @ 0.22 | zenith @ 0.17 |
|---|---|---|---|---|
| far band | −18.8 | −12.5 | −6.7 | **+0.3** |
| near band | −17.9 | −17.4 | −16.8 | −16.3 |
| separation | −1.0 | +4.8 | +10.1 | **+16.6** |

The road read #636972 → #5F7F97 at 0.17 and the zenith colour (56 points of blue-over-red against the
bare road's 15). `scene.js` notes both want re-taking at 0.19 / 0.73.

### Past the edge of the map

[Current](rendering.md#past-the-edge-of-the-map--cityhorizonjs).

Until 2026-10-14 the island simply stopped: past the west towers' last street, and past the north
park, the asphalt and the lawn ran out over the slab's fade skirt and dissolved into the sky dome.
With the 22–33 unit west skyline standing right at that line, the fade read as a dark smear with the
sky behind it — reported as "the world just ends". `?horizon=classic` brings it back.

### The island edge

[Current](rendering.md#the-island-edge--gameedgefogjs-citygroundjs).

Until 2026-10-17 the island's edge was the feathered skirt alone: the asphalt apron past the ring
road faded to nothing over 16 units and the sky dome showed through, so the island read as a slab
floating in the sky with its outline on show. `?edgefog=classic` brings it back.

## Crayon Mode — `game/crayon.js`

### The line — a texel, not a radius

[Current](rendering.md#the-line--a-texel-not-a-radius).

**The first version reused the occlusion's own taps and was free, and wrong.** A depth Laplacian at
radius R answers over a band 2R wide, and the rings are 1.0 and 0.4 *world* units — 7.7px and 3px at
play zoom, double that at the close framing. Every silhouette in the city came out wearing a
fifteen-pixel fringe: recognisably an outline, and recognisably not a line. Tree canopies, which are
jittered icosahedra and therefore all facet, went furry.

## Cartoon Mode — `game/cartoon.js`

### The rim is a uniform, not a bake

[Current](rendering.md#the-rim-is-a-uniform-not-a-bake).

The hull rim used to be baked into each hull's geometry by `inflatedGeometry`. Moving it to the
`aInflate` attribute and a uniform landed with a **zero-pixel** difference against the baked build.

## Rain Mode — `game/rain.js`

[Current](rendering.md#rain-mode--gamerainjs).

- **The first reflection mirrored the sky itself**, and every street came out a pale wash with its
  paint gone. The pass clears to `rainReflectSky` instead.
- **The first rain build reflected grey buildings into grey asphalt** and read as a filter, which is
  why the rain switches the city's lights on.

### The passing storm — `?storm`, `game/storm.js`

[Current](rendering.md#the-passing-storm--storm-gamestormjs).

With the streets' `DRY` constant at 28 they never dried at all between storms.

#### Two moods — the sun shower and the night storm

[Current](rendering.md#two-moods--the-sun-shower-and-the-night-storm).

**The first storm peaked most of the way to night**, which was too dark to play in. That storm is
the `night` mood now (`?storm=night`, `?rain=night`); the default became the sun shower. rendering.md
carried two older readings of the rain grade that predate the mood table — "the sun keeps 32% of its
power and the fill picks up 15%", and, as a known gap, "darker than an honest overcast afternoon (sun
at 22%, fill at 90%) so the lamps read; a real night key under the rain would be the next thing to
try". `MOODS` in `game/rain.js` has the current numbers.

The shower's wet-ground glint first sampled the cloud field and lit straight through building
shadows inside a sunlit patch; it follows the direct light the fragment actually received instead.

### A squall — the default weather, `game/squall.js`

[Current](rendering.md#a-squall--the-default-weather-gamesqualljs).

The wet map dried with a 30 s time constant at first: the trail was half gone by the time the cell
was halfway across, so the rain read as drying the ground behind itself. It is 45 s. Lit windows
first read the footprint per vertex, and every window wiped on from one side as the edge went over
it; they read it at their anchor now. The lens drops' reach and linger were raised on 2026-10-08
(#454).

**The first front arrived all at once** (`?squallramp=classic`). The shade reached 1.6 edges past
the core, the lights read that same shade, and the rain filled over the one edge inside it, so at any
point the sun went, every window came on and the streaks appeared inside the same ~6 s — reported
(2026-10-15) as "rain appears, lighting gets dark, lights pop on". The streaks faded every drop
together rather than thinning them, so the edge of the rain was a faint full curtain, not a drizzle.
And the city-wide grey came on over 4 s the moment a cell switched on outside a corner, wherever the
player was, at full strength from the first frame, so the shade it cast over the nearest corner
popped on too. The graded front pulls the three apart in space, thins the drops, fades each cell in
and out over a tenth of its crossing, and reads the grey off the cell's distance from the frame.

### Autumn, and the leaves a squall strips — `autumnBase` in `city/props.js`, `game/leaves.js`

[Current](rendering.md#autumn-and-the-leaves-a-squall-strips--autumnbase-in-citypropsjs-gameleavesjs).

**`?foliage=classic`** brings back the first autumn set, whose hue-6° red read as too extreme beside
everything else. The palette was softened to a narrow band (luma 96–148, saturation 0.50–0.55, a
rust "red" at hue 15°) on 2026-10-12 (#486).

### The city's lights — `game/citylights.js`, plus `setRunningLights` in `sim/traffic.js`

[Current](rendering.md#the-citys-lights--gamecitylightsjs-plus-setrunninglights-in-simtrafficjs).

**A pool of light on the road under the headlight cones was tried both ways and dropped.** Parented
to the body it rose off a ramp as a flat slab and cut into the asphalt on the way down; laid on the
road it read as a second set of lights beside the cones.

### What it is not doing yet

[Current](rendering.md#what-it-is-not-doing-yet-2).

**The mirror pass's cost before #474** (2026-10-11, "Cheaper rain reflections"). On an iPhone
(`?bench`, 2026-10-11) the squall row cost **+22% busy** against baseline and dropped to 32 fps, with
14.7 ms of CPU a frame against 3.3 dry. Most of that CPU was not the draws: it was three re-resolving
every lit material's program twice a frame, because the pass used a clipping plane and an ordinary
render target, and each of those compiles a different program from the screen's (3.9 ms of
`getProgram` in a 15.5 ms headless frame). Moving to an oblique near plane and a target flagged to
take the screen's sRGB encode took headless JS under `?squall=0.5` from 15.5 to 9.0 ms a frame.

This list also used to say there was no spray off tyres; `game/spray.js` added it.

## Bloom — `game/bloom.js`, and the comparison in `game/hdr.js`

### The pass

[Current](rendering.md#the-pass).

The masters opened at **Lamps 1.0, Spill 0.7** and came down to 0.35 and 0.25 with the panel open on
the running game: at the opening numbers the bloom was a thing you looked at.

### What neither is doing yet

[Current](rendering.md#what-neither-is-doing-yet).

This list used to say the city's own windows and street lamps did not glow, only the
drive-through's and the depot's. `game/citylights.js` added lit panes and lamp heads, and both are
marked emissive.

## The renderer budget — `?safe` and friends

[Current](rendering.md#the-renderer-budget--safe-and-friends).

The speech bubbles' avatars — the tutorial's taxi and rider, the robber, dispatch's cop car — were
WebGL contexts too, and went with the [pinned bubbles](gameplay.md#speech-bubbles) (the cop chat
bubbles were cut on 2026-10-12, #492, and `?copchat=classic` keeps them).

## Effects

### Skid marks — `game/skidmarks.js`

[Current](rendering.md#skid-marks--gameskidmarksjs).

The first version was one quad at 0.85 alpha per stamp, which left a hard edge every 0.42 units down
a streak and a hard rectangle at each end. Each stamp is a feathered 4 × 4 patch at 0.5 now.

### Dust — `game/dust.js`

[Current](rendering.md#dust--gamedustjs).

- **It used to be a single puff on the centreline 1.9 back**, which is behind the axle and *between*
  the wheels: dust with nothing under it. It comes off both rear tyres now.
- **The pool grew 90 → 140 → 200.** 90 → 140 was so the trail would stop recycling a burst's puffs
  out from under it. 140 → 200 came with the two plumes: the trail spends a slot per wheel every
  0.47 units, ~98 a second and ~103 alive when the overdrive top was 22.95, which left 60 spare;
  against 140 the trail would have recycled the burst's own puffs again.
- **An earlier version used camera-facing billboards.** They sat in the same plane as the road and
  read as flat stickers next to the faceted cars.

### The getaway's cash trail — `game/cashtrail.js`

[Current](rendering.md#the-getaways-cash-trail--gamecashtrailjs).

**It was rebuilt once for being too subtle, and every number moved.** The first cut ran 14 notes a
second at 0.62 × 0.34 units into a pool of 48 — 22 notes in the air, each a 4.8 × 2.6px rectangle, on
a road already painted with lane dashes. That is a scattering you have to go looking for.

| | first cut | second | then | why it moved |
|---|---|---|---|---|
| Size | 0.62 × 0.34 (4.8 × 2.6px) | 1.15 × 0.62 | 0.88 × 0.48 | It has been both too small and too big. 1.15 is *a third of the drawn taxi's length* — at that size the notes stop reading as a shower of small things and start reading as a few large ones. What made the big size necessary was never the size; it was the density and the alpha. |
| Rate | 14/s | 40/s flat | a gust clock, 78/s and 7/s (~44/s mean) | A flat rate is a rope paid out of the back of the car. |
| Pool | 48 | 160 | 160 | ~105 in the air at steady state, plus the gust peak and the kick. |
| Life | 1.6s | 2.4s, fading from 74% | 2.4s, fading from 74% | Fading from 55% spent most of the effect half-transparent. |
| Tumble | 7.5 rad/s | 4.2 | a flip, then a leaf swing | At 1.2 revolutions a second every note strobed through its own edge on the way down, and even at 4.2 a free tumble ended wherever it stopped. |
| Colour | one swatch, #7FC08A | one swatch, #5FD182 | a spread, `cashNote` → `cashShade` | See below. |
| The press | nothing | a 24-note kick | a 24-note kick | An effect that only ramps up says nothing on the frame the button went down. |

**Then it was halved, and a trail left on the road** (Tyler, after the getaway grew checkpoints): the
gust clock went to 39/s and 3.5/s (~22/s mean), the kick to 12 notes and 2 bundles, a gust's bundle
chance from 30% to 15%, and half the landed notes stay ~7s (a landed bundle 7s rather than 3.4).

Other changes along the way:

- **The colour was reversed.** The first cut pulled the hue toward a paper green on the argument that
  the HUD's earnings green is 27px of type on a dark scrim while these are small objects on a road.
  What that missed is the ground: a note at luma 174 sat *between* the asphalt (104) and the lane
  dashes (210). It went to 179 with the saturation back, and the pale back to 232.
- **The face spread first went up toward `cashPale`**, which was right while the notes were unlit and
  read as emissive once they were lit. The back came down from 70% of the way to `cashBack` to 35% for
  the same reason.
- **The notes were unlit for a long time**, on the argument that made additive wrong — and an unlit
  note at golden hour, road and buildings gone dark and warm around it, read as emissive and was
  reported as such. They are Lambert now.
- **The sideways throw was widened from 2.4 to 4.2** when the stream got dense, because a narrow one
  stacked the notes into a single line down the middle of the lane.
- **A random-axis tumble** said "flake" before the flip-and-swing said "paper".
- **The settle floor was once the *tailpipe* height** less the lift — 0.59 above the road — so the
  cash "lying" behind a getaway hovered at bumper height for as long as the effect existed.

### Cop cars' sirens — `geometry/lights.js`, `game/coplights.js`

[Current](rendering.md#cop-cars-sirens--geometrylightsjs-gamecoplightsjs).

- **A whole-bar strobe** (both pods red, then both blue) was the earlier choice, on the grounds that
  a split bar alternates two 4px specks and flickers — true while an unlit pod was simply gone, and
  wrong once the painted lenses meant the dark side still shows its colour. On a phone the whole-bar
  version read as two red lights.
- **Every traffic lamp used to be marked `pod`**, which gave a cop car's bar a brake light's 3.4
  against the cruiser's 4.2 — dimmer than the police car parked beside it, for no reason on screen.
  The kind rides on the mesh (`userData.bloomKind`) now.

### Loco Mode kickoff — `game/flames.js`, plus a wheelie in `sim/traffic.js`

[Current](rendering.md#loco-mode-kickoff--gameflamesjs-plus-a-wheelie-in-simtrafficjs).

The kickoff pool used to double as the crash fireball, which is what its per-slot life and size
arrays were for — one burst can't divide by another's `LIFE`. The crash moved to `game/blast.js`.

### The tailpipe plume — `game/locoflame.js`

[Current](rendering.md#the-tailpipe-plume--gamelocoflamejs).

`HALF_W` was first tried at 0.62, picked against the car's 2.0 width; it cleared the tarmac by
**0.002**, which is a coincidence and not a margin. 0.50 clears it by 0.095.

### Wreck — `game/blast.js`, `game/wreckage.js`

[Current](rendering.md#wreck--gameblastjs-gamewreckagejs).

**The wreck replaced a stack of four effects** (`sparks.js`, `smoke.js`, `debris.js` and a `blast()`
half of `flames.js`) fired twice each at two points, plus a third wave on a `setTimeout` — roughly
sixty draw calls, and four separate physics packets with gravity, drag, restitution, friction and
angular damping between them. **Shape and timing** were buried under the sum of four tunings. The
shards are what is left of the old debris, and they no longer bounce or settle.

The first fireball also faded a still-orange puff out over its last quarter, which left translucent
pink hexagons hanging over the road.

**`?wreck=classic`** is the original full fireball: it hid the two cars the run ended on for most of a
second, which is why `flat` became the default (Tyler's pick).

#### The wrecks that stay

[Current](rendering.md#the-wrecks-that-stay).

**The shells used to be consumed**: both shrank and faded into their own fireballs over 0.34s
(`game/vanish.js`, which is now only the passing lab's ending). That sold the *bang* and left nothing
behind it — with the run-end hold at 2.6 seconds and the fireball out after one, more than half the
beat was a held close-up of bare tarmac, and *what did I just hit* was only answerable from the
half-second of flame that had already gone past. The fade also cost a shader recompile, since it
flipped `transparent`.

#### Momentum

[Current](rendering.md#momentum).

**The first version of all of it was stationary**: the shells froze at the impact point, the
fireball bloomed out of a fixed centre and the shards fanned off a point the taxi had already driven
through. The carry numbers then had to be reworked when the shells stopped disappearing partway
along the curve. The smoke collar was the last piece to be taught the taxi's momentum; until it was,
the fire, shards and shells slid downfield out of a grey ring left standing on the impact point.

### Roadworks — `game/roadwork.js`, `geometry/roadworks.js`

[Current](rendering.md#roadworks--gameroadworkjs-geometryroadworksjs).

**The ramp shipped wound inside out, and nothing caught it.** `rampWedge` writes its triangles by
hand, and every one of them was in clockwise order: measured off the built geometry, the slope's
normals were `y = -0.98` and the underside's `y = +1.00`. The face aimed at the camera was the ramp's
*bottom* — a flat plywood-coloured quad lying exactly on the road slab — and the slope itself, being
a back face under `FrontSide`, was culled. Players saw an orange patch flickering against the tarmac
near the junction, reported as "z-fighting, maybe metal covers?" — right about the symptom and
necessarily wrong about the cause. The ramp had never once been drawn as a ramp. Two things made it
survive review: `flatShading` still lit the wrong-facing quad like a surface instead of going black,
and the bug looks exactly like a depth-precision problem, which is a thing you tune rather than fix.

Other changes:

- **The cones were a sine zigzag** with 0.9 of jitter, meant to read as hand-placed. A wave that
  wanders across the centreline has no rule an eye can pick up, so it looked like cones dropped at
  random rather than a lane coned off.
- **The smash used to emit two ordinary trail puffs** — precisely what a boosting taxi lays down in
  two frames, so the one impact in the run rendered as exhaust.
- **Two `dust.js` bugs surfaced building the burst**, both a number that looked applied and wasn't.
  `t` was normalised against the `LIFE` **constant** rather than the puff's own span, so a
  longer-lived burst puff started at a *negative* age: a sixteenth of its size and above full
  opacity, growing rather than dispersing. And `scale` only ever reached `wide`, the **x aspect
  alone**, so a puff asked to be 2.6× the size came out 2.6× as *wide* and exactly as tall and deep as
  a boost puff — a smear on the road from a 3/4 camera, which is why the burst kept being reported as
  too small while the probe's numbers agreed it had grown. The probe comparing a burst against a
  single trail puff is what caught the first.
- **A thrown cone tumbled at 7–15 rad/s** before smashes got 12–26.

### Clouds — `game/clouds.js`, `geometry/cloud.js`

#### Authored on the screen, solved in the world

[Current](rendering.md#authored-on-the-screen-solved-in-the-world).

The first build put the low clouds at 35 units of depth with the camera at the origin, which is
**behind the camera** by the time the player drives to the far corner. They vanished, and only from
one end of the map. `STANDOFF_MAX` came from that.

#### They ride the outline, not a lane

[Current](rendering.md#they-ride-the-outline-not-a-lane).

**The obvious design was built first**: a straight lane, a wind blowing down it, clouds wrapping
round. With the wind down world +X the lanes hugged the two z-facing edges, and every line that could
reach the sky beside the other two crossed the city. Measured on that build: 0.13 clouds in frame on
a portrait phone against 1.04 on a desktop, with 83% of portrait frames showing sky and nothing in
it.

#### The one unlit thing in the sky / Soft, out of hard geometry

[Current](rendering.md#the-one-unlit-thing-in-the-sky).

The first soft build read as a paper cut-out, because a scalar shade can only make a white cloud a
darker white; `SUN_WARMTH` came after. It also faded its edge on `dot(normal, VIEW_DIR)` — a cosine —
and so spent the whole ramp in the last tenth of the radius, about four pixels at play zoom, still
reading as an edge.

#### The model

[Current](rendering.md#the-model).

The clouds shipped drifting at 1.5–2.6 screen units a second, which crossed a phone's frame in under
half a minute and read as scudding; and ten of them put four and a half in frame at a time on a 16:9
desktop once the band came in over the coast. It is 0.5–0.9 and five now.

### The park flock — `game/birds.js`, `geometry/bird.js`

[Current](rendering.md#the-park-flock--gamebirdsjs-geometrybirdjs).

- **The pale patch was first on the chest**, which is correct for a pigeon and invisible from 33° up —
  its top sat under the torso's, so every bird was a featureless dark pebble on the grass.
- **The folded wing started at 1.18 rad.** At 68° a standing bird had 22° of wing sticking out past
  its tail on both sides and read as one that had hurt itself. It is 1.45.
- **The bodies were luma 98**, which read as gravel; they are 118.

### The duck pond — `city/pond.js`, `game/ducks.js`

[Current](rendering.md#the-duck-pond--citypondjs-gameducksjs).

**`?water=classic`** keeps the old flat fan — `pondWater` open water and a `pondShallow` rim baked as
vertex colours, merged with the props, pixel for pixel. The river's water program replaced it on
2026-10-08 (#450).

The first water was a handsome #5E88B4, luma 130 against the park's 140 — the same trap the bird
bodies document, and worse, because a pond is a 45-pixel area. It went to 101. Shrinking the ducks
to fit a smaller pond was tried, and reads as a different animal standing two seconds away from the
full-sized flock.

### Boat wake — `game/wake.js`

[Current](rendering.md#boat-wake--gamewakejs).

**The old wake was one flat cone welded to the stern**, which meant the foam travelled *with* the
boat: a shape towed along at exactly hull speed, contradicting the one thing it existed to say. Its
alpha was 0.45; the motes, which overlap, are 0.36 — at the triangle's number the river had a solid
white stripe down the middle. For weeks before that it also drew nothing at all: its triangle was
wound facing down, `(0, -15.08, 0)`, on an unlit material (see the CLAUDE.md trap).

### The rooftop helicopter — `game/chopper.js`, `geometry/helicopter.js`

[Current](rendering.md#the-rooftop-helicopter--gamechopperjs-geometryhelicopterjs).

- **A helipad used to be a coin flip** on any deck over 8.5 units with 16 square units of roof, which
  produced one on 23 cities out of 60 and none at all on the other 37 — fine for roof furniture,
  useless as a place to land. `choosePad` picks exactly one.
- **The first approach flew a 45-unit glide slope** onto the pad — much prettier on paper — and a
  headless sweep of the flown path against a height field of the city put the machine *through* a
  neighbouring tower on eleven cities in twenty-four, by as much as seven units.
- **The version before the base leg** entered pointing 40–65° off the pad and let pure pursuit
  straighten it out. The whole turn happened in the first 1.4 seconds, 75 units out, with the machine
  still faded out and off the edge of the map.
- **The machine used to be dark slate**, on the argument that the aeroplane owned white and two
  aircraft should separate by value — true of the pair and false of the vignette. The slate was
  within **1.11** contrast of `roof`, so a landed helicopter read as a smudge on the deck.

### Route band — `game/routeline.js`

[Current](rendering.md#route-band--gameroutelinejs).

- **There used to be a yellow pool on the road under the taxi** marking it as selected. The taxi is
  permanently selected and there is only one of it, so the pool labelled something never in
  question — and sitting under the band in the same yellow, it read as the band leaking out around
  the car.
- **It was a 2px hairline down the road centreline first**, wrong twice over: on the centreline it sat
  **between** the two lanes and never said which side of the road the taxi was on; and it was
  filleted against the taxi's **own position** — the corner radius at the next junction clamped to
  half the distance to the car — so the drawn corner shrank and re-shaped as the taxi closed on it.
  It was also drawn over the cars, which at 2px didn't matter.

### The taxi's chequer — `geometry/taxi.js`

[Current](rendering.md#the-taxis-chequer--geometrytaxijs).

Letting the light cells fall through to the body was tried in the old hand-drawn app icon — three
dark cells with yellow between them, right at 180px on a static image. On the car it makes a hazard
stripe.

### Taxi ghost outline — `geometry/ghostoutline.js`

[Current](rendering.md#taxi-ghost-outline--geometryghostoutlinejs).

The steered front wheels were left out of the mask at first, and the rim painted a yellow streak
along the rocker panel of a fully visible car — tracked down by tinting the rim magenta and
re-capturing the same frame with the wheels hidden.

### Nearby-traffic ghost outlines — `game/carghosts.js`

[Current](rendering.md#nearby-traffic-ghost-outlines--gamecarghostsjs).

**Trucks went un-outlined for as long as they existed.** The module read `car.instanceIndex`
straight into the car meshes with no type check, so including a truck would have traced it from
whichever *car* held the same index; trucks were left out instead, and the per-class pools came
after.

**The radius: 30 → 42 → 46.** At 30 it was a braking distance rather than a warning. Reported as
"cars behind buildings sometimes don't get an outline": the outline did arrive, at 1.3s out at Loco
cruise (1.05s in overdrive), when the junction was already a commitment. Over 150 headless boost
crashes, 4 of the 17 crash partners hidden 1.5s before impact wore **no outline at all** and the rest
averaged 0.41 alpha; at 2.0s it was 6 of 19. At 42, 0 of 17 at 1.5s (mean alpha 0.55) and 3 of 19 at
2.0s, measured when Loco cruise was 18.7 u/s. When the boost ceiling moved to 22.1 the same 42 units
quietly became 1.63s of fully-lit warning, under the probe's 1.8s floor, which is what caught it; 46
puts it back at 1.81s.

An old note warned that a wider radius would put half a dozen more cars in range and turn the
skyline into a wireframe. 30 held **3.4** vehicles a frame, not the 6.5 assumed, and 42 holds 6.1;
and only hidden vehicles draw anything.

**The cap: 8 → 12 → 18.** 8 was a rail only by luck at radius 30; at 42 a genuinely hidden vehicle was
dropped by it on 5.5% of frames. 12 was read off one 15-second window on one seed — the same window
the probe asserted it in, so the check agreed with the constant because both looked at the same
handful of frames — and was quietly binding all along. Swept properly (24 seeds × 60s, 86,400
frames):

    cap          10      11      12      13      14      15      16
    binds on   10.0%   5.1%   1.92%   0.59%   0.09%   0.01%   0.00%

A cap of 12 was evicting the farthest vehicle on roughly one boosting frame in fifty. Peak observed
was 16 (17 before the ring's corners lost their signals), so 18. Re-swept at radius 46: peak 16,
unchanged. (rendering.md said 16 for a while; the code has been 18.)

### The plumbob — `geometry/diamond.js`

[Current](rendering.md#the-pie--geometrydiamondjs).

- **It was a plumbob until 2026-10-18** (Tyler: "what if we made the plumbob an hour glass?"), and
  `?plumbob=classic` still draws it. A square bipyramid built by hand: an equator of half-width 1.4
  sitting two thirds of the way up, a 1.5-unit cap above it and a 3.0-unit point below, 2.8 × 4.5
  world units (about 22 × 29px at play zoom), the equator turned 45° so a corner faced the camera.
  Its case was that a plumb bob's job is to *indicate a spot on the ground*: a long lower point has a
  direction, and it pointed at the rider. It was already a draining vessel, though, and the
  hourglass keeps that while wearing the one shape everybody already reads as a clock. Its outline
  hull was the body scaled per axis — fine on a convex shape, and why the hourglass needed an
  offset profile instead.

- **It was an octahedron**, 3.8 across, reading 29 × 24px; its axis-aligned vertices put an *edge*
  toward the camera and the silhouette came out a flat hexagon. The plumbob is the same amount of
  marker stood on its end, equator turned 45°. On the octahedron a rim factor and a rim distance were
  the same thing.
- **The drop-off wore the same model for a while** and gave it back.
- **The bounce amplitude used to be bounded** by the 0.8 units of overlap between the old pin's head
  and its post top.
- **The kick was first retired on its value**: the envelope reads 0 at both ends, so it killed every
  kick on its own first frame. Invisible in the browser; the headless assertion caught it.

### The target disc — `geometry/targetring.js`

[Current](rendering.md#the-target-disc--geometrytargetringjs).

- **The old countdown ring drew with `depthTest: false`** for legibility through buildings, and
  needed an `ABOVE_RING` renderOrder worn by the rider's meshes and the taxi's whole body to survive
  its far half projecting up across the figure.
- **A disc used to switch on and off**, and both ends of a pickup did it on the same frame, which read
  as two unrelated events. The grow-in that replaced it then removed every rider's disc from every
  screenshot until `settle()` existed.

### The courier pad — `geometry/parcelpad.js`

[Current](rendering.md#the-courier-pad--geometryparcelpadjs).

The beam was left off at first, on the argument that it is the fare disc's "this is the live thing
being driven at" cue and a courier pad is a standing offer rather than a target. That read worse than
it argued.

### The parcel — `geometry/parcel.js`

[Current](rendering.md#the-parcel--geometryparceljs).

- **It was 2.4 units and read about twice too big**, from matching the rider's 3.3-unit *height*: a
  2.4 crate beside a rider read as a shipping container beside a person.
- **It was a tape cross first**, which at this size read as a hot cross bun, and the tape was a dark
  brown, which at 15px on dark card is a shadow rather than a strip.
- **A box rode the taxi's rear deck** while a package was aboard — about four pixels at play zoom —
  until the cargo chip replaced it. The accept flourish lit five parts then, and the ghost mask had
  eight. `PARCEL_DECK_SCALE` was named the day the box was resized and three hand-typed numbers
  encoding "about half a unit wide" all needed finding.
- **The chip's frustum was 1.42 while there was a disc behind the box**: a box framed to a circle's
  inscribed square has its corners against the rim twice a turn, so a quarter of the frame was air.
- **The chip's arrival first tracked the box exactly** — its screen point and apparent size (this
  canvas gives a world unit `SIZE / (2·FIT)` = 18.3px against the city's ~7.7, measured live) — and
  flew the whole distance in one move. Verified pixel-exact, it read as **too fast**.

### The food order — `geometry/food.js`

[Current](rendering.md#the-food-order--geometryfoodjs).

The first cut put the burger and the cup in a takeaway bag, which is what a real order comes in. The
bag was a squat tapered block, took two thirds of the envelope, and left the burger and the cup as
trinkets on top of something that read at ten pixels as *another box*.

### The drop-off ring — `geometry/marker.js`

[Current](rendering.md#the-drop-off-ring--geometrymarkerjs).

**The shape:** a crystal on a gold post, then the crystal alone at y = 9.6, then that crystal in
teal; it went when the rider's marker became the same model and the board had two identical
silhouettes on it, only one of which reported anything. The translucent disc used to wash its far
half up over the base of the post at its centre.

**It has worn four colours.** Teal-until-tapped then yellow, back when a drop-off above a `parked`
taxi was a question rather than an instruction; then Loco Mode's yellow throughout, once the taxi
dispatched itself at pickup; then a fixed teal, on the argument that a marker with no clock of its
own had to sit outside the urgency scale; and now the urgency scale itself. `?shot=10` was added to
catch the untapped state.

### Off-screen fare pointers

[Current](rendering.md#off-screen-fare-pointers).

The drop-off's arrow used to aim halfway up the pin's post. While the drop-off had a crystal at
rooftop height it stayed visible over the skyline for a beat after the ring had gone behind a tower,
so the arrow carried less weight than it does now.

### The fare marker — `game/faremarker.js`

[Current](rendering.md#the-fare-marker--gamefaremarkerjs).

It replaced the meter's plate and the timer ring, both of which drew over everything. `LIFT` leaves
the gap above a rider's head that the meter's plate was tuned to.

### The outburst bubble — `geometry/cursebubble.js`

[Current](rendering.md#the-outburst-bubble--geometrycursebubblejs).

The VIP purple was the border first, which put the identity in 2px of rim while 57px of blank paper
carried nothing. The strokes grew from 0.2 to 0.24 when the fill and border swapped.

### Car motion

[Current](rendering.md#car-motion).

- **The taxi's ground disc used to be rolled with the body**, and tilting it into the road caused
  z-fighting.
- **For a long time the taxi leaned into corners on only two of its four streets**, and the wrong way
  on one of them. The ambient cars had `BODY_EULER_ORDER` right from the start; the taxi, the police
  cruiser and the aeroplane were on three's default `'XYZ'`. It surfaced when the overtake got a bank
  of its own — the passing lab's road runs due east, so the lane change banked there and did nothing
  in the game.

### The city entrance — `game/cityentry.js`

[Current](rendering.md#the-city-entrance--gamecityentryjs).

The first pass at the dust was 5 puffs at power ~0.6 per building, invisible at play zoom.

## The "Add to Home Screen" screen

[Current](rendering.md#the-add-to-home-screen-screen).

- **The list used to branch on the user-agent**, because Safari's Share sat in the toolbar and
  Chrome's behind ⋯. Current Safari collapses the toolbar behind its own ⋯ too.
- **An earlier version counted showings in `localStorage`** and gave up after three, which meant the
  advice expired while the reason for it did not.

## Debug panel

[Current](rendering.md#debug-panel).

The ⚙️ button used to be always on, but at small widths it sat right where the streak counter now
lives.

## Flat roofs

Until the lip, a flat roof's cap was one solid box — 0.3 tall on a tower, 0.26 on a courtyard wing,
0.34 on the depot, 0.25 on the bank — and the deck was its top face. It read as the top of a
building thanks to the cornice's overhang, but from 33° up every roof was one flat plane of a
single colour. Tyler asked for a raised lip and a sunk centre for detail; `?roofs=classic` keeps
the solid cap. See [city.md](city.md).

## The L train's route

[Current](city.md#the-elevated-train-on-by-default-ltrainclassic-to-compare).

The L first ran east-west along the river's arterial (`?lroute=classic`). On 2026-10-13 (#483) it
moved to the north-south arterial and ran straight across the city: over the river on a through
truss, past which a Big Air launch off the arched bridge flew up through the steel, and on south to
fade out over the south shore's lawn, where its last column stood. Tyler, 2026-10-14: "Doesn't make
sense fading off into the ocean." It now turns west at the east-west arterial instead, which is
always north of the river, so the truss and the south half went with that stretch.
`?ltrainwest=classic` brings the straight line back, truss and all.


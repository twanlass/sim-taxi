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

### The reflection crossing a car's glass

`propMaterial({ sheen: true })` in `util/geo.js`, masked by the per-vertex `aGloss` that
`geometry/carbody.js` stamps on a greenhouse. The same trick as the windows above, turned inside
out — and the inversion is the whole design.

A façade never moves, so its highlight can be baked into the vertex colours once and read as glass
forever on a camera that never moves either. A car does nothing but move, and a highlight baked into
*its* glass travels with it — which is exactly the thing that says **paint** rather than **glass**.
A reflection is the one feature of a surface that is supposed to stay behind while the surface
slides out from under it.

So the streak is a property of the **city**, not of the car. Each vertex carries its own world
position into the fragment shader, and the band is a function of that position alone. A car crossing
a junction drives through the field and its roof lights up and goes out again; a car standing at a
red holds whatever it stopped in; two cars nose to tail catch it a beat apart. **Nothing is
animated** — there is no clock in there at all, which is also why a frozen screenshot renders the
same frame twice. At cruise a car crosses a band about every 3.5 seconds.

Four details carry the rest of it:

- **Per fragment, not per vertex.** The vertex shader is where this wanted to live: it is a handful
  of instructions on a car's dozen corners and `vColor` is already interpolated. But a greenhouse is
  quads, a quad is two triangles, and a weight varying across *both* axes of one shows the diagonal
  seam between them — the trap the curtain-wall bands are cut into `RIBBON_SEGMENTS` to dodge. A
  cabin roof is one quad and there is nothing to cut it into.
- **Two wavelengths, neither a multiple of the other.** One band alone is a metronome: every car on
  a street glints at the same interval and it reads as a flashing light rather than as a sky. The
  second, much longer band crosses the first diagonally and gates it.
- **The pane's facing matters as much as its position**, and for the same reason the façades' does:
  a pane pointing at the sky catches most of it, the two faces this camera can see catch some. Left
  off, a car's flanks stayed dead while its roof lit and the greenhouse read as a lid rather than as
  glass wrapped around a cabin.
- **It multiplies into the diffuse term rather than the emissive**, so glass catching the sky at
  golden hour goes quiet at midnight along with the sky it is catching. This is scenery, not a
  marker — see [unlit means unfogged](#unlit-means-unfogged) for where the other rule applies.

The two patches on a vehicle's material have to **compose rather than replace**: AO touches
`<aomap_fragment>` and this touches `<color_fragment>`, and the cache key is built from whichever
are actually installed. Chaining it wrong is invisible — an uninstalled AO lookup looks exactly like
AO that simply isn't very strong — so `tools/probe.mjs` compiles the material against a stub and
checks both reached the shader, and that all four combinations of the two patches carry distinct
keys.

`aGloss` is absent entirely from geometry with no glass, which is safe: WebGL hands the shader a
constant 0 for an attribute the buffer doesn't carry, so an untagged mesh opts itself out. Every
part merged into *one* vehicle does have to carry it, though — `mergeGeometries` refuses a set whose
attributes disagree.

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
  panning is a planning gesture and boost is the opposite.

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
  is trying to open up. Before any of this the boosting taxi sat 6% of the half-frame *past* centre,
  so the follow was showing less road ahead than a static frame would have. And the two follows run
  at 1.5 and 3.2, so the same speed trailed them by different amounts and the framing shifted on the
  Loco Mode press — the one frame the player is certain to be watching. Cancelling it is what makes
  `LEAD_FRACTION` a fact about the picture rather than an opening bid.
- **The offset eases on its own clock** (`LEAD_RATE` 2.4), slower than either follow. It swings
  through 90° at every corner, and at the follow's own rate that lands as a shove sideways at the
  moment the player is reading a new street. At 2.4 the frame opens into the turn over about half a
  second and never overshoots — measured at 30.6% of a half-frame through a junction taken at the
  boost top, against a 30% steady state.

Near the map edge `followXZ`'s `±HALF_SPAN` clamp absorbs the lead, which is correct: there is
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
`didPan()` so the picker can swallow the click that closes out a drag, and it clamps the target to
`HALF_SPAN`, so the map can never be pushed off screen with nothing left to steer back by.

### The rider peek

A tap on a rider-finder chip takes the camera to that rider — narrow viewports only, same rule as
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

`src/game/taxifinder.js`. The camera is the player's the moment they swipe, and it stays theirs —
nothing here tows it back onto the car. The bill for that arrives when the taxi drives off the frame
entirely, which on a phone is one look across town away: the only way home was to drag the map until
the yellow car turned up, a hunt across near-identical blocks on a clock that is draining. So while
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
(`mirrorSceneLights`, shared with the tutorial avatar and the rider chips), parked at the same
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
| **Busted** | the taxi, so the cruiser swings into a held shot | 26 | 0.42 | until the cop pulls up, 3400–4800ms |
| **Too Slow** | `fares.state.failSpot` — the corner the expired clock was counting down to | 30 | 0.40 | 2400ms |

The timeout is the odd one out and it is what the third row is for: nothing happens *to the taxi*, so
there is no impact to point at. What failed is a **place** — the drop-off ring the rider never
reached, or the kerb they gave up waiting on — and `fares.js` names it (`state.failSpot`) rather than
main.js guessing, because `fare.target` is already whichever end of the trip was still owed. It is the
**pavement corner**, not the junction centre: that is where the pin and its ring actually stand, and
at this zoom the difference is the subject sitting several units off frame centre.

Which is also why the fare system **leaves that one pin standing** where a wreck clears the whole
board — a two-second pull-in onto a junction that has just been emptied is a shot of nothing. The
rest of the board still goes, and the expired fare still leaves `state.fares`, so nothing keeps
ticking.

The taxi **stops** for it, exactly as it does for a bust (`crashed`, the flag every loop in
`traffic.js` already skips): the run is over, and a car still driving a route to a fare that no
longer exists — through the very ring the shot is holding on — argues with the ending being shown.

Shallower slow-mo than a wreck and a wider stop on the zoom, both for the same reason: there is no
blast to stretch out and nothing on its way in, so the beat is a *held look* rather than a replay. At
wreck depth the city around the marker crawls with nothing to justify it, and at wreck zoom the
marker fills the frame and the junction it stands on — half of what makes it a place — is cropped
away. All the delays are wallclock, so the slow-mo never stretches the wait for the retry screen.

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

`src/game/scene.js` returns `{ scene, sun, hemi, sky, fog }`:

- **`sun`** — a directional light with shadows (`PCFSoftShadowMap`)
- **`hemi`** — a hemisphere light for ambient fill
- **`sky`** — the *material* of a sky dome, whose `topColor` / `bottomColor` uniforms are the only
  handle on sky colour
- **`fog`** — the haze, [below](#atmospheric-perspective)

The default is golden hour: 16:24, sun 28.5° up, `#FFDEBB` at 3.55 intensity.

## Atmospheric perspective

A soft haze over the back of the frame, so a block at the top of the screen sits behind some air and
the one under the taxi doesn't. Without it every façade is drawn at identical contrast however far
off it is — which is the one cue this projection cannot get any other way, since parallel lines stay
parallel and a distant block stays the same *size*, so nothing in the drawing says "further".

It is three's ordinary `THREE.Fog`, and **the note that used to sit in `scene.js` saying an
orthographic camera couldn't have one was wrong.** Worth spelling out, because the mistake is easy
to make twice:

> The claim was that a camera sitting a fixed 400 units back whitens the whole city uniformly. What
> is actually true is that fog placed *from zero* does. View-space depth here is
> `DISTANCE - (p - target)·VIEW_DIR`, which runs 335 at the near corner of the map to 465 at the far
> one — a perfectly good gradient. Over that band `Fog(near = 0, far = 1000)` varies by a few
> percent end to end and reads as a flat wash, which is exactly what got measured and then written
> down as a property of the projection. Put the near/far band **around the standoff** instead and
> the ramp lands on the picture.

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

`HAZE_TOP = 0.17` is the mix at the **top of the play frame**, and `hazeRange()` derives the two
planes from it by inverting smoothstep — `far` is a ramp length rather than a distance anything is
drawn at. Tuned against the city rather than by eye in a close-up: the top of the frame is at depth
480 and the far corner of the map at 465, so the frame edge is very nearly the haziest thing there
can ever be (the corners measure 0.132, 0.78 of it). It came down from 0.22 when the colour stopped
being a near-white, and the two trade against each other for exactly that reason: a wash with no
chroma has to be laid on thickly before it says anything, while a fully saturated sky blue says it
at less. Past about 0.3 the back of the city starts reading as *weather*.

**Linear, not `FogExp2`.** Exponential fog is a distance from the eye and this eye is 400 units from
everything: any density strong enough to read across the city also puts a few percent of wash on the
nearest pixel — the flat whitening the old note was afraid of, arrived at honestly. Linear fog has a
hard zero, and smoothstep's ease-in spends most of the ramp on the far half of the frame, so the
near half stays untouched and the haze gathers behind it.

### The colour — `hazeColor()`

Derived from the sky on every keyframe change, never carried as a tint of its own: a haze that is a
*function* of the sky cannot drift away from it, and one picked at golden hour and left alone is a
pale blue wash over a midnight city — lighting the back of the board *brighter* than the front,
which is the cue running backwards.

**It is not the horizon**, which is what this shipped as first and what got reported as "reads as
pure grey". `skyBottom` is #DCEDF7, a near-white — 27 points of spread between its highest and lowest
channel, deliberately so ("going paler, not white"). Mixed at the 0.22 the haze then carried, into
`concrete`, the commonest façade
in the city, that lands on #C0C1BC: **5 points of spread**, which is neutral grey. A haze with no
chroma of its own can only take chroma *away*. That is a value wash, and a value wash is half of
atmospheric perspective with the recognisable half missing.

Two steps, both about getting chroma back:

- **Sample the dome high.** `HAZE_SKY_H = 1.0` reads the sky dome's own gradient — the same
  `pow(h, SKY_EXPONENT)` curve the shader runs, which is why that exponent is exported — instead of
  taking its bottom colour flat. The horizon band is the *least* chromatic part of any sky, being
  where multiple scattering has washed the blue back out, and a column of air seen from 400 units up
  a 33° diagonal is not that band. At 1.0 the sample is the **zenith** exactly: `pow(1, exponent)` is
  1, the lerp is a no-op, and the haze is `skyTop`.
- **Give the chroma back.** Saturation lifted in the working space with the hue untouched, so a
  change here can only restate the sky's own colour more strongly. HSL→RGB cannot leave the cube for
  any saturation ≤ 1, so this can't clip a channel or bend a hue.

**×2.5 is past the clamp, deliberately.** `skyTop` measures 0.585 saturation at the parked hour where
`getHSL` measures, so anything from ×1.71 up pins to fully saturated — 1.8, 2.0 and 2.5 all give the
same `#4AC6FF`. The effective rule is "take the sky's top colour to full saturation", and the number
is a ceiling rather than a multiplier: to see it move you have to come *down* past 1.7, not up.

| | 06:30 | 09:00 | 16:24 | 18:36 | 00:00 |
|---|---|---|---|---|---|
| horizon | `#F0B080` | `#CFE0EA` | `#DCEDF7` | `#F09A60` | `#16202E` |
| haze | `#0069AA` | `#009EE0` | `#4AC6FF` | `#004788` | `#001024` |

**The trade-off, stated plainly: at `skyH` 1.0 the haze no longer tracks a sunset.** At 18:36 the dome
runs orange at the bottom and deep blue at the top, so the zenith sample gives `#004788` — the far
city goes blue while the horizon behind it is still orange, which inverts what air actually does at
dusk. It is accepted because **the shipped look is 16:24 with the cycle off**, where the zenith
sample is the whole point: it is what takes the haze from a grey wash to `#4AC6FF`. Anyone turning
the cycle on who wants dusk back has one slider to move — Sky sample down to ~0.35 restores a warm
`#D05600` there, at the parked hour's expense. The probe pins both halves of that.

Measured on a rendered shot, as mean blue-minus-red per band — the near/far *difference* is what
atmospheric perspective actually is, and raw chroma is the wrong metric because a warm city mixed
toward blue passes through neutral on the way:

| | no haze | horizon haze | zenith @ 0.22 | shipped @ 0.17 |
|---|---|---|---|---|
| far band | −18.8 | −12.5 | −6.7 | **+0.3** |
| near band | −17.9 | −17.4 | −16.8 | −16.3 |
| separation | −1.0 | +4.8 | +10.1 | **+16.6** |

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
| **Strength** | `HAZE_TOP` via `setHazeTop()` | 0 – 0.5, default 0.17 |
| **Sky sample** | `hazeTuning.skyH` | 0 (horizon) – 1 (overhead), default 1.0 |
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

**Android defaults to `?safe`**, and that is a holding measure rather than a conclusion: one
device — a Pixel on a PowerVR D-Series (Tensor G5) — lost the WebGL context in a loop on the full
budget and holds on the reduced one, and which single flag is responsible is not yet known. It is
wider than the evidence and it costs real quality on Android phones that were fine, taken because
the failure it avoids is a black screen rather than a soft one. `?safe=off` restores the full
budget there, which is how the narrowing gets done; replace the default with the one flag as soon
as it is known. Desktop and iOS are untouched, so screenshots and the shot list do not move.

They live in `util/shot.js` beside `?seed` and `?cars`, and every getter takes its **fallback from
safe mode rather than from a literal**, evaluated per call — so one flag moves all of them, and a
module that opens a renderer of its own reads the effective value without anyone threading it
through. Four do: the tutorial's avatar bubble, each rider-finder chip, the courier
[cargo chip](gameplay.md#the-load-is-carried-into-the-hud) and the
[taxi finder](#getting-back-to-the-taxi). They are 46px, 38px, 42px and 44px square respectively and
their own cost is nothing, but each is a **WebGL context this page is holding**, and that is part of
what `?safe` is asking about.

The flags exist because of a failure a desktop cannot see and a phone cannot report — see
[testing.md](testing.md#when-a-device-renders-nothing) for the whole picture. `stencil: true` is
deliberately *not* among them: MSAA and the stencil buffer ride in the same back buffer but they
are separate requests, and a run with multisampling off should still get its ghost outlines.

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

## The island edge — `city/ground.js`

The asphalt doesn't end on a line. A **fade skirt** hangs off the slab — `EDGE_FADE = 16` units of
asphalt stepping outward from the slab's own outline, alpha 1 → 0 — so the city feathers into the
sky rather than being cut out of it. At play zoom that is about 22% of the frame height, which is
what makes it read as a gradient instead of as a slightly blurry edge.

It is an *edge* cue rather than a depth cue, and the two now sit on top of each other: the skirt is
keyed on distance from the middle of the map, so it fades the last 16 units of ground wherever they
are on screen, while [the haze](#atmospheric-perspective) is keyed on distance from the camera and
fades the whole back of the frame. The skirt hides where the island stops; the haze says how far
away it is. This paragraph used to claim distance fog couldn't do the second job here — see that
section for why that was wrong.

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

**Two plumes, one per rear tyre.** Each spawns at the contact patch that wheel actually stands on:
`TAXI_REAR_AXLE_BACK` (1.20) behind the origin and `TAXI_REAR_TRACK` (0.83) out to its own side,
both exported from `geometry/taxi.js` and read off the same `wheelAnchors` the wheels are *built*
at, through the group's 1.18 scale — so resizing a wheel or rescaling the car takes the dust with
it. It used to be a single puff on the centreline 1.9 back, which is behind the axle and *between*
the wheels: dust with nothing under it. Off the tyres instead, the pair separates on a straight and
swings apart through a corner, because the outside wheel travels further than the inside one. They
still merge behind the car — a puff swells to `END_SIZE` 2.3 against a 1.65 track — so the wide shot
keeps a single (wider) wake and the close shot gains two sources.

> **The pool had to grow for it: 140 → 200.** The trail spends a slot *per wheel* every 0.47 units
> travelled, so at the overdrive top it lays a puff per wheel per 0.47 units — ~98 a second and
> ~103 alive across `LIFE` when that top was 22.95. At the current 34 u/s top it is **~145 a second
> and ~152 alive**, which leaves 48 of the 200 for everything else against a barricade smash's 26
> plus 14 for its landing. That still fits, but the headroom is now 8 rather than 60: the next
> raise to the ceiling wants this pool checked before anything else. Against the old 140 the trail
> would have recycled the burst's own puffs out from under it, which is the exact failure the
> earlier 90 → 140 jump was made to fix. The probe's
> ring-buffer check laps the pool off `mesh.count` rather than a typed 140 for the same reason.

> Per-puff alpha needs a custom `aAlpha` instanced attribute plus a three-line `onBeforeCompile`
> patch multiplying it into `gl_FragColor.a`. `instanceColor` cannot carry it: it is RGB only, and
> a 4-component colour attribute triggers `USE_COLOR_ALPHA` and a different code path.

An earlier version used camera-facing billboards. They sat in the same plane as the road and read
as flat stickers next to the faceted cars.

**Three effects come out of this one pool** — the boost trail, the wall a barricade throws
(`burst`, [below](#roadworks--gameroadworkjs-geometryroadworksjs)) and the smoke collar around a
wreck (`wreckSmoke`, [below](#wreck--gameblastjs-gamevanishjs)) — and the differences between them
are options on `burst` rather than three sets of hand-picked numbers: `tint`, `ring` (start each
puff that far out along its own bearing), `linger` (stretch the life) and `startSize` (begin as a
cloud rather than at a point). `instanceColor` *is* used for the tint, and it is allocated at build
time by painting every slot white, not left to be created by the first tinted puff — `setColorAt`
adds `USE_INSTANCING_COLOR` to the material, so a lazy first call would put a shader compile on the
frame of a crash. **The tint is rewritten on every spawn**, including the untinted ones: the pool is
a ring buffer shared with the boost trail, and a slot the collar painted grey comes back round half
a lap later.

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

### Wreck — `game/blast.js`, `game/vanish.js`, plus a smoke collar out of `game/dust.js`

The crash is **one call per car** — `blast.fire(x, z, tint)` — and everything *it* puts on the road
lives in one module: a shockwave ring on the tarmac, a fireball, a scatter of shards in that car's
paint, and two tyres that bounce out and roll away. Four `InstancedMesh`es, about forty-five live
instances at the peak of a two-car wreck.
Around the pair of them goes one call to [`dust.wreckSmoke`](#dust--gamedustjs), which is
[the collar](#the-smoke-collar) below.

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
  `v / TYRE_DRAG`, 11–14 units. It has to outrun the smoke collar, whose own front reaches about 8;
  a tyre still inside the smoke when it fades never rolled anywhere. And it is spent slowly enough
  that the tyre is *still moving* when it fades, because one that stops and then disappears is a
  thing being deleted.
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

Four numbers, and none of them is free:

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
- **`wreckSmoke` in the palette is set against the road, not against `blastSmoke`.** The fireball is
  unlit, so its smoke stop can be `#4B4B55` and still read; this pool is Lambert and is lying on
  `asphalt` `#636972`. A sensible smoke grey by eye (`#6E6259`) came out at the same value as the
  tarmac and vanished for the entire duration of the fire, leaving smoke that only appeared once the
  flame had gone — the exact opposite of the brief. It ended up at `#C9C2BB`: roughly 1.8× the
  road's value, and still well short of the dust's pure white, because white here is a dust cloud
  and this is what is burning.

`vanish.js` owns the disappearance: each shell shrinks and fades into its own fireball over 0.34s
of sim time rather than being switched off. It steps on the frame's already-slowed `dt`, so it
runs at the same rate as the blast through the crash slow-mo — as does the collar, which is stepped
by the same `dust.update(dt)` the boost trail is. See
[traffic.md](traffic.md#the-wreck) for the rest of the staging, and
[testing.md](testing.md#screenshots) for `?shot=12` and `?shot=17`, which stage a real crash and
freeze it at the fire and at the smoke respectively.

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
an impact rather than as a plume. The pool is 200 slots, so a burst plus its landing costs a fifth
and leaves the boost trail intact. The landing reuses the same call at `count 14, power 0.7`
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

### The park flock — `game/birds.js`, `geometry/bird.js`

Birds living in the city's parks. They walk about on the grass, pecking and pausing; something puts
them up; they climb out on a shared heading and fade into the distance; a while later they come back
in from somewhere else, descend onto a park — often a different one — and land. Scenery on the same
terms as the flyover: nothing routes around them, nothing collides with them, nothing can be tapped.

**A city runs two of them, in two different parks.** A 5×5 map has between two and five green areas
big enough to hold a flock, and one flock meant the rest of them were lawns with nothing on them;
the second is what makes the map feel inhabited rather than the one park you happen to be near.
They are built on separate offsets of the run seed, so they lead separate lives — one is on the
grass while the other is halfway across the city — and each is handed an `avoid` callback naming
the greens the others are on. `pickArea` treats *keeping off another flock's lawn* as outranking
*getting a change of scene*, and that order is the whole of the function: half of all cities have
exactly two usable parks, so asking those two wants the other way round makes every return leg in
such a city land on the other flock's grass. The probe drives the pair for ten minutes and asserts
they never share, on the seed whose city has only the two.

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

**Shadows are on only while the whole flock is on the deck.** The shadow pass ignores a material's
opacity, so a faded-out flock that kept casting would drag hard shadows across the city with nothing
visible above them — and the sun is 28.5° up, so a shadow from any real altitude lands two units
away per unit of height and reads as a smudge crossing a street with nothing over it. The gate is
0.9 units, which a bird clears about a fifth of a second into its leap.

Two things the camera decided. The pale patch is on the **head**, not the breast: the first attempt
put it on the chest, which is correct for a pigeon and invisible from 33° up — its top sat under the
torso's, so every bird was a featureless dark pebble on the grass. On the head it says both "this is
an animal" and which way it is facing. And the folded wing is swept 1.45 rad, not the 1.18 it
started at: a rigid panel can't fold at the wrist, so the only way out of the silhouette is to lay
it along the body, and at 68° a standing bird had 22° of wing sticking out past its tail on both
sides and read as one that had hurt itself.

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
apart by hue. The bodies sit at 118 (up from 98, which read as gravel) with the head patch at 221,
and the visibility that couldn't be bought there was bought with the extra fifth of a unit instead.
`?shot=18` stages a take-off; `?shot=0` has both flocks at play zoom, which is the framing that
decides whether any of this worked.

### The rooftop helicopter — `game/chopper.js`, `geometry/helicopter.js`

A helicopter that visits the city's helipad every couple of minutes: in over the skyline on a curve,
banking through the turn onto final, a hover over the circle, down into its own dust, a few seconds
sitting with the rotor idling, and then up and away the way it came. Scenery on the same terms as
the aeroplane and the flocks — nothing routes it, nothing collides with it, nothing can be tapped —
and about half a minute door to door against the plane's six seconds, which is why the gaps between
visits are 95–165 seconds rather than 45–90.

**Every city now gets exactly one helipad, and that is this vignette's doing.** A pad used to be a
coin flip on any deck over 8.5 units with 16 square units of roof, which produced one on 23 cities
out of 60 and none at all on the other 37 — fine for a piece of roof furniture, useless as a place
for something to land. `choosePad` in `city/buildings.js` picks the roof after every deck in the city
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
rotor is counted. That is the only altitude in the city which is safe by construction. The first
version flew a 45-unit glide slope onto the pad — much prettier on paper — and a headless sweep of
the flown path against a height field of the city put the machine *through* a neighbouring tower on
eleven cities in twenty-four, by as much as seven units. The pad is on a tall roof but never the
tallest, and the block next door is one street away. So it arrives over the circle at cruise, comes
down the hole at 5 units/s easing to 1.6 for the last four, and on the way out climbs vertically all
the way back to 22 before a single unit of forward travel. `tools/probe.mjs` re-runs that sweep on
every check.

**The bank has to be spent over the city, not on the way to it.** A leg enters 34 units to one side
of the final approach line and steers at an aim point that slides onto the pad between 52 and 14
units out, so it flies a base leg, banks through the turn onto final and rolls level lined up — a
real approach, and one whose lean lands where a camera can see it. The version before it entered
pointing 40–65° off the pad and let pure pursuit straighten it out; same manoeuvre on paper, and
useless, because pursuit converges fastest when the bearing moves fastest, which is when the target
is *near*. The whole turn happened in the first 1.4 seconds, 75 units out, with the machine still
faded out and off the edge of the map.

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

**The paint is chosen against the deck, not against the sky.** The machine used to be dark slate,
on the argument that the aeroplane owned white and two aircraft should separate by value — which
was true of the pair and false of the vignette. Half of a visit is spent parked on `roof`/`rooftop`,
and that slate was within **1.11** contrast of `roof`: the same value, so a landed helicopter read
as a smudge on the deck rather than a thing standing on it. Near-white with a warm cast is 6.03 and
4.39 against those two greys, and the warmth is what keeps it off the cold grey everything else on
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

### The taxi's chequer — `geometry/taxi.js`

A band down each flank, `CAR_LEN * 0.82` long and 0.22 tall, split into **six cells** alternating
`taxiTrim` near-black and `taxiSign` off-white. Six boxes a side rather than one, merged into the
shell with everything else, so the livery costs a draw call of nothing.

**One row, not a chequerboard**, and that is a zoom decision. Through `TAXI_SCALE` the band is about
2px tall at play zoom, so a second row would ask for 1px and get mush; a single row of alternating
cells is the largest thing that still reads as *chequer* at this size. Six cells puts one at ~4px —
about the finest pitch that survives. Square cells matching the band's own height would want twelve,
at ~2px each, which alias into a flicker as the car turns.

**Both colours are painted.** Letting the light cells fall through to the body was tried in the app
icon (`tools/make-icon.mjs` paints three dark cells and shows yellow between them, which is right at
180px on a static image); on the car it makes a yellow-and-black band, which is a hazard stripe, not
a taxi. The white is the roof sign's own off-white rather than a new entry, so the livery keeps the
car to two colours.

The white cells clip under the accept flourish's 0.32 emissive lift, and that is fine — the roof sign
is the same off-white and has always taken the same lift. The *dark* cells have the whole of the lift
to climb, so the chequer stays legible as chequer while the car is lit.

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

The same outline, worn by the handful of ambient vehicles nearest the taxi. It exists because
`sim/collisions.js` is armed *only* while boosting: the one moment a car hidden behind a tower is a
crash rather than a surprise is the one moment the player cannot see it. The taxi's outline says
where the player is; this says what they are about to drive into. It lives in `game/` rather than
`sim/` because it is a readout of a player-layer concept — the boost — and because `main.js` is the
only place allowed to know about both.

It runs whether or not the taxi is currently boosting, and deliberately so: gating it on
`taxi.boost` would only ever confirm a decision already made, since the collision test it is
warning about only arms once the button is down. Showing it beforehand is what lets the player spot
the hidden car and choose *not* to press the button — see `update()`'s `want` in `carghosts.js`,
which only drops to 0 once the taxi is `crashed`.

Each ghost wears **its own vehicle's paint** rather than the taxi's yellow (`carBodyGhost`,
index-aligned with `carBody`). Seven instanced meshes across two pools, and none of them drawing
once the run ends in a crash.

**Two pools, because a box truck is not a car.** A truck lives in its own instance space
([why](traffic.md#box-trucks)), so `car.instanceIndex` addresses a car in `mesh` and a truck in
`truckMesh` — and this module read it straight into the car meshes, with no type check, for as long
as trucks existed. Including one would have traced it from whichever *car* held the same index, so
trucks were left out and went un-outlined. That gap pointed the wrong way: a truck is the biggest
thing on the road, the obstacle that most fills a lane, and at `TRUCK_SPEED` the one most likely to
still be sitting in the junction the taxi is arriving at. `createPool` now builds one pool per
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

Selection is a plain radius — `GHOST_RADIUS = 42`, i.e. 2.1 × `PITCH`, reaching past the junction
the taxi is committed to and covering the one after it, measured from vehicle centre for both
classes.

**It was 30, and 30 was a braking distance rather than a warning.** This got reported as "cars
behind buildings sometimes don't get an outline", which is exactly what it looked like: the outline
did arrive, it arrived at 1.3s out at Loco cruise (1.05s in overdrive), and by then the junction was
already a commitment. Measured over 150 headless boost crashes — taking the vehicle the taxi went on
to hit and resolving occlusion against the city's own building and tree geometry — 4 of the 17 crash
partners that were hidden 1.5s before impact wore **no outline at all**, and the rest averaged 0.41
alpha; at 2.0s it was 6 of 19. At 42 the same 150 crashes give 0 of 17 unoutlined at 1.5s, mean
alpha 0.55.

The figure that matters is the *fully lit* one, `GHOST_RADIUS - FADE_BAND` = 40 — a ghost inside the
fade band is nearly transparent, which is not a warning — and that is 1.81s at the boost cruise of
22.1 u/s. `tools/probe.mjs` asserts it in seconds rather than as a bare number, and that is exactly
what caught the radius when Loco Mode's ceiling went up: at 42 the same warning had quietly shrunk
to 1.63s, under the 1.8s floor. **The radius is a time; when the speed it warns against moves, it
moves.** 42 → 46, and `MAX_GHOSTS` 12 → 16 with it, since a radius holds vehicles by area and 1.2×
the radius squared put a peak of 13 in range against a cap of 12.

The old note here warned that a wider radius would put half a dozen more cars in range and turn the
skyline into a wireframe. Both halves were wrong, and the correction is worth keeping because the
argument will come back. 30 held **3.4** vehicles a frame, not the 6.5 that note assumed. And a rim
only rasterises where something in the depth buffer sits *in front of* it, so a vehicle standing in
the open costs fill and paints **nothing** — what the player actually sees is only the hidden ones,
and widening from 30 to 42 takes those from 0.77 to 1.28 a frame. Half an extra outline on screen,
for two thirds more warning.

`MAX_GHOSTS = 12` sits deliberately *above* the 6.1 vehicles the new radius holds on average, so the
cap stays a rail against a queue at a red rather than becoming the real filter. It had to move with
the radius: eviction drops the *farthest* vehicle, and farthest is not safest — the car two junctions
out is the whole point of the wider horizon. At radius 42 with the old cap of 8, a genuinely hidden
vehicle was dropped on 5.5% of frames; at 12 that is 0.0% and stays there out to a radius of 46. The
probe drives fifteen seconds of boosting and asserts the cap never binds, so the two numbers cannot
drift apart again silently.

**The horizon has a ceiling: `SPAWN_CLEARANCE`.** A mid-run arrival appears at least 50 units from
the taxi ([why](traffic.md)), so 42 sits under it with 8 units — 0.43s at `boostCruise()` — to spare.
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

### The plumbob — `geometry/diamond.js`

The crystal a waiting rider floats: a **plumbob**, hanging point-down over whoever it belongs to,
outlined in black, bouncing, and painted by [urgency](gameplay.md#urgency-is-one-scale). The drop-off
wore the same model for a while and gave it back, so this is the rider's shape alone now; it stays
its own module because the shape, the outline and the bounce are a vocabulary the next marker should
inherit rather than re-derive. (The file is still `diamond.js`: it is the crystal over a fare
whatever silhouette it wears, and the rename would have cost a hundred references to buy nothing.)

**The geometry** is a square bipyramid built by hand: an equator of half-width 1.4 sitting two
thirds of the way up, a 1.5-unit cap above it and a 3.0-unit point below. 2.8 × 4.5 world units, so
about 22px wide and — after the camera's 33° elevation foreshortens the height by 0.84 — 29px tall.
The octahedron it replaces was 3.8 across and read 29 × 24px, so it is the same amount of marker
stood on its end.

The **equator is turned 45°**, which is the difference between a plumbob and a lozenge. `VIEW_DIR`
looks down the diagonal, so the octahedron's axis-aligned vertices put an *edge* toward the camera
and the silhouette came out a flat hexagon. A corner facing the camera runs a ridge down the middle
of the shape and splits the front into two facets the sun lights differently. The camera never
rotates, so this is baked into the geometry rather than maintained per frame.

Why this shape at all: a plumb bob is a pointed weight whose entire job is to *indicate a spot on
the ground*, which is this marker's job too and the one thing a regular octahedron was worst at —
symmetric top to bottom, it has no more claim on the pavement below it than on the sky above. A long
lower point has a direction, and it points at the rider. It also borrows a silhouette players
already know; nothing about what it *says* is borrowed, since the hue here is a clock rather than a
mood.

Written as **non-indexed triangles wound counter-clockwise from outside**, and `tools/probe.mjs`
computes every face normal *from the winding* — not from the normal attribute, which
`computeVertexNormals` would launder — because a flipped triangle would both light as if the sun
were behind it (`flatShading` reads the screen-space derivative) and punch a hole in the
back-faces-only rim. See the trap in [CLAUDE.md](../CLAUDE.md).

One geometry serves every crystal on the board and every outline hull too — they differ from the
surface they wrap only by scale. Colour and emissive are per instance, so a repaint is a `Color.set`
on one material.

The outline is an **inverted hull**: the same geometry drawn a little larger with `side: BackSide`
and a black basic material, so the enlarged back faces sit behind the real surface everywhere except
around the silhouette. Cheaper than a post-processing edge pass and it needs no render targets —
these are small objects, not a whole-scene effect. Each hull is a *child* of the mesh it wraps, so
it inherits animation for free.

**The rim is a distance, not a factor**: `RIM_OFFSET` is 0.22 world units (≈1.7px at play zoom) and
the hull's scale is computed per axis from it. On the old octahedron the two were the same thing; on
a shape three times longer below its equator than it is wide, a single multiplier hangs a black
needle off the bottom point and shaves the flanks. `tools/probe.mjs` measures every hull corner
against the body corner it came from. Crystal and hull sit at `renderOrder` **8** and **9** in the
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
figure standing in the middle of it. That is precisely what the old countdown ring did — it drew
with `depthTest: false` for legibility through buildings, and needed an `ABOVE_RING` renderOrder
worn by the rider's meshes and the taxi's whole body to survive it. Keeping the test on costs
occlusion by towers and buys all of that back.

**It grows out of its own centre and pulls back into it.** A disc used to switch on and off, and both
ends of a pickup did it on the same frame — the kerb disc going dark as the drop-off's lit — which
reads as two unrelated events rather than as one clock changing hands. `appear()` / `vanish()` now
drive a back-eased 0 → 1 (peaking ~1.045, `RING_GROW_TIME` 0.30s) and an accelerating 1 → 0
(`RING_SHRINK_TIME` 0.20s). The exit is deliberately *not* the mirror of the entrance: arriving is
news and wants the beat, leaving is a thing getting out of the way, and an eased exit spends its last
frames as a barely-moving object — the same argument the select pop's undershoot rests on. Both
envelopes are exported and the courier pad imports them, so the two shapes differ and the gesture
cannot.

> **Trap, and it fired.** Shot mode ticks the fare loop **once** and then freezes, so an entrance
> driven off sim time never gets past its first frame — and `appear()` starts at scale 0. Every
> rider's kerb disc disappeared from every screenshot, which is a worse failure than the pop it
> replaced. Hence `settle()`, called via `fares.settleMarkers()` / `parcels.settleMarkers()` right
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
fill; `tools/probe.mjs` reads all three back together and expects one hex, repeated three times.

The beam has to be told to spin: `ring.update(elapsed)` is called from `game/faremarker.js`'s own
per-frame `update` while the rider's disc is visible, and from `game/fares.js`'s fare loop while a
fare is `riding`, for the drop-off's. Neither ring ticks while hidden.

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
`createSweepFor` in `targetring.js`. It was left off at first, on the argument that the beam is that
disc's "this is the live thing being driven at" cue and a courier pad is a standing offer rather than a
target. That reads worse than it argues: on a board where the fare discs glint and the pads sit dead,
the pads look like road paint somebody forgot to clean up. The beam is what says a mark belongs to the
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
> — the roadworks ramp below shipped wound clockwise throughout and read as z-fighting for weeks. The
> check went red on the first run, and for a third reason worth recording: `ShapeGeometry` is
> **indexed**, so `attributes.position` items 0/1/2 are not a triangle. Reading the attribute in
> order tests a triangle that does not exist, and reported a perfectly good pad as face-down. The
> check walks the index buffer and computes the normal from the winding across all 106 triangles.

### The parcel — `geometry/parcel.js`

A kraft box with a darker lid slab and a tape cross on top, merged into one mesh with one material
the way every prop here is. Scale is the same deliberate lie [the
figure](gameplay.md#the-taxis-roof-sign) tells: a real parcel beside a 3.4-unit car would be half a
unit, which is four pixels at play zoom, so this is a crate a bit over one unit — squat and wide where
the figure is tall and thin.

**It was 2.4 units and read about twice too big.** The mistake was matching the rider's 3.3-unit
*height*, which measures nothing the eye does: a box is mass in all three dimensions where the figure
is a tall thin sliver, so a 2.4 crate beside a rider read as a shipping container beside a person. At
1.35 the two have roughly the same apparent area, with the box a shade under — which is what "the same
size" means for shapes this different.

The cross is on the **top** face because the camera looks down the +X+Z diagonal, which makes the top
the largest face on screen; a band around the girth would be mostly hidden. It is what says *parcel*
rather than *crate*.

`idle(t)` is a slow Y spin plus a gentle bob, off sim time. The rider's answer to "come and get me" is
a raised waving arm; a box has no arm, so the motion carries all of it — and it is deliberately
slower than the wave, because a parcel is not impatient, it has no clock. The footprint is square so
the spin never changes the silhouette's width, which is what makes it read as turning rather than as
pulsing.

**It is built to read as 📦**, and each of the four parts is doing one job at ~15px: a kraft body; a
darker lid slab so the top seam is a plane rather than a stripe; **one** semi-white tape strip; and a
white shipping label. The strip wraps over the top and down both Z faces as a *single* box — narrow in
X, proud in Y and Z — which is one part doing what three would.

It was a tape **cross** first, and at this size that read as a hot cross bun: two strips on a 2.4-unit
box leave four small squares of card and the silhouette stops being a box with tape on it. The tape
was also a dark brown, which at 15px on dark card is a shadow rather than a strip — it is off-white
now, because the strip is the single part that says *parcel* rather than *crate*.

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
- **The frustum is computed, not eyeballed.** The box stands 1.16 tall and 1.384 across at the lid, so
  at 45° its half-diagonal is 0.979 and its screen half-height is 1.16·cos33/2 + 0.979·sin33 = 1.02 —
  near enough the same number as the half-width, so one square frustum covers both. `FIT` is 1.15, that
  plus 13% for the drop shadow and nothing else, because a *square* canvas has no corner for the box to
  foul. It was 1.42 while there was a disc behind it: a box framed to a circle's inscribed square has
  its corners against the rim twice a turn, so a quarter of the frame was air paid to a plate that has
  since gone — and the box was what got smaller for it. It measures 52% of the canvas drawn, which is
  what `tools/smoke.mjs` asserts a floor under: a camera pointed slightly wrong frames the box off the
  side of an element that still passes every DOM check.
- **The arrival quotes the box's direction rather than tracking it.** The chip grows from 0.45, fades
  up (opaque by 45% of the way, so the arrival is the growth settling rather than a fade finishing),
  and slides in from a **fraction** of the way toward where the world box faded out — 26% of the gap,
  capped at 120px, scaled along the line so the cap shortens the slide without bending it off the
  direction the box left in. It inherits that box's spin and eases it to the nearest quarter turn: a
  square box a quarter turn from square is the same picture, so the longest settle is 45° rather than
  180°.

  The first cut *did* track it — the chip opened at the box's exact screen point and exact apparent
  size (the ratio of the two cameras' scales: this canvas gives a world unit `SIZE / (2·FIT)` = 18.3px
  against the city's ~7.7, measured live because the zoom moves) and flew the whole distance in one
  move. It was verified pixel-exact and it read as **too fast**: a hand-off with no overlap gives the
  eye nothing to follow. The exactness was the thing to give up.

**The accept flourish.** When a package is collected, every opaque part of the car takes a white
emissive lift together — shell, roof sign and both steered wheels — on the select pop's own envelope,
so an accepted package reads as the same *kind* of acknowledgement a tapped rider gets rather than as a
new effect to learn. (It was five parts while a box rode the deck.) 0.32 rather than the rider's measured 0.3: the taxi's yellow is already
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
car handles a box at", derived from `BOX_W` — it is what the outbound flight grows from, and it was
named the day the box was resized and three hand-typed numbers encoding "about half a unit wide" all
needed finding. `PARCEL_CENTRE_Y` is half the standing height, and it is both the point the chip's
camera is centred on and the point the pickup hand-off is measured from: the two ends of that line have
to be the same point on the box, or it moves on the frame it changes renderers.

The deck copy those numbers were first written for is gone — the taxi carries nothing now, so it also
drops out of the ghost-outline stencil mask, which is seven parts rather than eight (`tools/probe.mjs`
counts them, because a part left *out* of the mask counts as an occluder of the rim behind it).

### The drop-off ring — `geometry/marker.js`

The drop-off is a **filled disc on the kerb corner and nothing else** — no head, no post. It was a
crystal on a gold post, then the crystal alone at y = 9.6, then that crystal in teal; it went when
the rider's marker became the same model and the board had two identical silhouettes on it, only one
of which reported anything. See [gameplay.md](gameplay.md#the-drop-off-is-a-ring-and-it-wears-the-riders-clock).

**It wears the clock of the rider in the car**, rim, fill and sweep alike: built on the top of the
urgency scale and repainted by `game/fares.js` (`paintDropoff`) whenever that clock steps a level, so
the disc and the crystal riding over the taxi are never seen a level apart. A VIP's stays its fixed
purple. The gate is on the level, not the frame — three materials, four steps in a whole clock.

**It has worn four colours.** Teal-until-tapped then yellow, back when a drop-off above a `parked`
taxi was a question rather than an instruction; then Loco Mode's yellow throughout, once the taxi
[dispatched itself at pickup](gameplay.md#the-drop-off-dispatches-itself) and there was no unanswered
stretch left; then a fixed teal, on the argument that a marker with no clock of its own had to sit
outside the urgency scale; and now the scale itself, on the argument that the clock the drive is
spending belongs on the thing being driven at.

Band and disc are the same paint again as a result — both are that fare's colour — and they already
met on the same tarmac at the same opacity, so the band running into the disc now reads as one mark
from the car to the kerb. The disc used to wash its far half up over the base of the post at its
centre, back when it was translucent *and* something stood in it; nothing stands in this one.

The taxi's roof sign no longer wears a fare colour either — it just lights on and off with whether
someone is aboard — see [gameplay.md](gameplay.md#the-taxis-roof-sign). `?shot=10` frames the
drop-off on its kerb corner; it was added to catch the untapped state, and it is now the only
framing that shows the ring close up.

### Off-screen drop-off pointer

`game/dropoffindicator.js`, styled under `#dropoff-indicator` in `index.html`. An arrow that clamps
to the viewport edge and rotates to point at the drop-off, shown only while a fare is aboard. It
wears the ring's colour, which is that rider's clock: the colour is written from JS onto the
wrapper's `color` and the polygon fills with `currentColor`, so a level change is one style write.
The value in the stylesheet is only what it opens on before the first pickup.

It carries more weight since the head came off. A crystal at rooftop height stayed visible over the
skyline for a beat after the ring had gone behind a tower; the arrow only covers the *off-frame*
case, which is the one the map being bigger than the viewport actually creates. It aims at `y = 0.1`
now — the ring on the road — where it used to aim halfway up the pin's post.

The third thing the map outgrowing the frame can lose is the **taxi itself**, and that one gets a
chip rather than an arrow: a direction is enough when you already know what is over there, and not
enough when what is missing is your own car. See [getting back to the taxi](#getting-back-to-the-taxi).

### Off-screen police warning

`game/sirenglow.js`, styled under `#siren-glow` in `index.html`. Red and blue washing in over the
viewport edge the police cruiser is coming from, strobing in step with its own light bar and gone by
the time the car is properly in frame.

Same problem as the pointer above and aimed the other way. The drop-off is somewhere the player is
driving *to*, and a pointer is navigation; the siren is something driving *at* them, and this is a
threat they cannot see yet. `POLICE_BUST_RANGE` is one block, and a block is about a third of a
portrait phone's frame at play zoom — so a cruiser one screen edge away is already close enough to
end a run, and the only cue it existed was ambient traffic pulling over to a car that was off-frame.

**It is on exactly when the light bar is on.** `state.lit` gates both, so the rule the player
already learns from a single run — [*lights on means a cop is
here*](traffic.md#the-lights-lead-the-gate) — extends to the edge of the screen without needing a
second rule. That includes the run-up: the bar comes on as the cruiser spawns and the bust only
arms a block in, so the wash covers the two-second grace period as well, which is the part of it a
player off-frame most needs. The probe asserts both halves directly: nothing with a dark bar ever
lights the edge, and nothing lit and off-frame ever fails to.

The strobe comes off `sirenOn()` in `sim/police.js` rather than a clock of its own, which is the
only reason the two stay in step — including the rate change to 11Hz once the cruiser has locked on,
which is the only cue that a corridor run has become about you. The off colour holds the same low
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
10px at play zoom — of air above their head, which is the gap the meter's plate was tuned to. Over the taxi (which tops out at ~2.85 including its roof sign) it
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

**It is depth-tested**, unlike both markers it replaced — the meter's plate and the timer ring both
drew over everything, and an inverted-hull crystal cannot: with the depth test off a crystal
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

**Every body poses with `BODY_EULER_ORDER` (`'YXZ'`, in `util/geo.js`), and the default order is
wrong here.** Three composes `'XYZ'` as Rx·Ry·Rz, which puts the roll *outside* the yaw and so turns
it about the **world** X axis — the body's own long axis only when the body happens to be heading
east. On a north or south street the same number renders as pitch and the lean disappears entirely;
heading west it leans the opposite way. `'YXZ'` is Ry·Rx·Rz: yaw first, roll about the body, the
same lean at every heading.

The two orders agree *exactly* at yaw 0, which is what hid this. The ambient cars had it right from
the start; the taxi, the police cruiser and the aeroplane were all on the default, so for a long
time the taxi only leaned into corners on two of the four streets it could be on and leaned the
wrong way on one of them. It surfaced when the overtake got a bank of its own — [the passing
lab](lab.md)'s road runs due east, so the lane change banked beautifully there and did nothing in
the game. `tools/probe.mjs` now measures the lean at all four headings and asserts the constant
reaches every body that leans.

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
building (7 puffs, power ~0.9–1.25 by footprint, started most of the way up the size curve) — the
first pass at 5 puffs and power ~0.6 was invisible at play zoom, where a two-unit cloud is a
couple of pixels of haze.

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
  clock, route blend, occlusion strength, the city-entrance levers, and the
  [Loco Mode ramp](traffic.md#the-ramp-is-live-tuning)
- **Restart to apply** — car count (writes a URL parameter and reloads)

Pretending a rebuild-only value is live would just show a slider that silently does nothing.

Touching any lighting control stops the day cycle, rather than letting the next frame overwrite the
change. **Copy settings JSON** exports the live values (not the slider positions, so manual
overrides are captured) for pasting back as new defaults.

Nothing here persists across a reload **except** the Loco Mode tuning, which is stashed in
`localStorage` and restored on the next `?debug` load — see
[traffic.md](traffic.md#the-tuning-survives-a-crash) for why that one is worth keeping and why the
gate matters.

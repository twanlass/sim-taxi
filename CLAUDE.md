# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Sim Taxi** — a low-poly 3D browser game. Crazy Taxi meets Flight Control: a fixed 3/4 view of a
5-by-6 block city with a river down the middle of it, ambient traffic obeying real signals, and one
taxi you route by tapping fares.

Three.js r0.180 + Vite 7. **Zero external assets** — every mesh is generated in code.

## Read the docs first

`docs/` covers each system: what it does, which files own it, and the decisions behind it that
aren't obvious from the code. Start at the index and read the one doc that covers what you're
about to change.

| Doc | Covers |
|---|---|
| [docs/README.md](docs/README.md) | **Index — start here** |
| [docs/architecture.md](docs/architecture.md) | Module map, frame loop, seeding, `window.__taxi` test hook |
| [docs/city.md](docs/city.md) | Coordinates, direction encoding, layout, park districts, divided arterials |
| [docs/river.md](docs/river.md) | The river, the three bridges, the drawbridge and the boats |
| [docs/traffic.md](docs/traffic.md) | Signals, arterials, ring road, car physics, boost, police corridor, the bust chase |
| [docs/gameplay.md](docs/gameplay.md) | Opening vignette, fare loop, routing, picking, timer ring, economy |
| [docs/difficulty.md](docs/difficulty.md) | The ramp: budgeted clocks, board size, shifts, the sweeps behind the numbers |
| [docs/rendering.md](docs/rendering.md) | Low-poly technique, camera, lighting, day/night, effects |
| [docs/testing.md](docs/testing.md) | `npm run check`, the headless tools, screenshots |
| [docs/lab.md](docs/lab.md) | The passing lab at `/lab/` — a straight road with no lights, for watching Loco Mode |
| [docs/ios.md](docs/ios.md) | The App Store build: the WKWebView shell, the custom URL scheme, `window.__native` |

## Commands

```bash
npm run dev        # http://localhost:5173 — and the passing lab at /lab/
npm run check      # the whole headless suite, ~1.8s — run this before reporting anything
npm run build      # production bundle into dist/ (two pages: the game and /lab/)
npm run build:ios  # the same bundle, minus /lab/, copied into the iOS app — see docs/ios.md
npm run push:ios   # build:ios, then sign and install to a paired iPhone over Wi-Fi (or /push-ios)
npm run preview    # serve dist/ — rebuild first, it will happily serve a stale one
```

## Working conventions

**Verify with `npm run check`, not with screenshots.** The assertion suite takes ~1s; a rendered
screenshot takes ~2s each and cannot make the assertions that matter (does the routed taxi
actually arrive? does it still stop at every red?). Screenshots are for *looking at* the game.
Don't run a render-review loop unless asked.

**Never patch with a blind `s.replace()` or `sed`.** A no-op replace fails silently and the
breakage surfaces three steps later. Any scripted edit must assert its match and exit on NO MATCH.

**Anything browser-only goes in the `BOOT` list in `tools/check.mjs`.** A scope slip in `scene.js`
once shipped undetected because nothing headless imported it.

**Colours live in `palette.js`.** Geometry constants live in `city/grid.js`. Don't inline either.

**The grid has two counts and two coordinate functions.** `GRID_I` bounds `i`, `GRID_J` bounds `j`,
and they differ — the city is six block rows tall against five columns because one row is the river.
`lineX(i)` gives an x and `lineZ(j)` gives a z; there is no `lineCoord`, no `GRID`, no `SPAN` and no
`HALF_SPAN`, because the two axes are centred on the origin with different half-spans and one
function cannot tell which it was handed. Anything reaching for "the whole map" wants `MAX_SPAN`;
anything clamping a *position* wants the per-axis pair.

**A road's width is not one number.** An arterial is a third wider than a side street, so
`ROAD_W`/`HALF_ROAD`/`LANE` are the *ordinary street's* values and anything asking about a specific
road has to go through `halfRoadX/Z`, `laneOffX/Z`, `laneOffsetFor` or `junctionReach`
([city.md](docs/city.md#divided-arterials-and-the-planted-median)).

**Two seeds, kept separate.** `?seed=` is the city and `?run=` is the situation; both are random
each load unless pinned. Shot mode pins the city seed so screenshots don't move under an
unrelated change. Each generator draws from its own offset stream so that editing one system
doesn't reshuffle every other one.

**Comments carry the "why".** Many record a measurement or a failed first attempt. If you change
behaviour a comment describes, update the comment — and if you measure something, write the number
down.

## Reporting back

When a change is done, close out with three short parts — scannable in a few seconds, not a wall
of prose. Skip this shape for pure Q&A or exploratory discussion; it's for "I made a change" replies.

**TL;DR** — what changed, in two sentences max.

**Testing** — one or two sentences on how to check it by hand in the running game (open it, click/
tap through the specific thing that changed). This is in addition to `npm run check`, which you
still run yourself before reporting — don't just restate that it passed.

**Notes** — a short bulleted list, only when there's something worth flagging: things left undone,
tradeoffs taken, edge cases not handled, anything that conflicts with existing behaviour or a doc.
Omit the whole section if there's nothing to note.

## Traps that have bitten before

- **Don't name a file `beacon.js`** (or an element `#banner`, or anything `leaderboard`). Ad
  blockers match those against filter lists — `leaderboard` is the IAB's name for a 728×90 ad unit
  — and `ERR_BLOCKED_BY_CLIENT` takes the whole module graph down. Hence `#run-end` rather than
  `#banner`, `highscores.js` rather than `leaderboard.js`, and why the rider's shaft of light was
  `lightshaft.js` for as long as it existed.
- **`car.state === 'turn'` includes going straight through a junction.** A real turn is
  `car.dOut !== car.d` (or `car.turn.hand !== 'straight'`). This is not a one-off gotcha: reading it
  as "is turning" is what made the overtake refuse every leader that happened to be inside a
  junction — 40% of the time on a 20-unit grid — and cost a quarter of all passes. Whenever this
  flag gates a *danger*, ask which `hand` the danger actually belongs to.
- **No `distToLine > 0` guard on the stop decision.** A car spawning within `STOP_SETBACK` of its
  target starts past the hold line; that guard once sent cars off the map to x = −1064.
- **An `onBeforeCompile` patch needs `customProgramCacheKey`.** Three builds the cache key from the
  material's parameters *before* the patch runs, so a patched material collides with every unpatched
  one sharing those parameters and gets handed whichever program compiled first. The diamond's fill
  drew with a building's shader and went missing with nothing logged.
- **On an unlit material a reversed triangle does not draw wrong, it does not draw.** The winding
  trap below has a nastier second form. `MeshBasicMaterial` (everything through `unlitMaterial`) is
  `FrontSide` like everything else, but it has no lighting to go strange — so where the roadworks
  ramp and the bridge deck at least *looked* wrong, the boats' wake was simply absent, for weeks,
  with a comment above it stating it was wound to face up. It was `(0, -15.08, 0)`. A feature that
  renders nothing is indistinguishable from one that was never wired up, which is how it got
  reported: "I think we're still missing boat water trails." Compute the normal from the winding in
  a probe check the moment you hand-write a triangle — not after someone notices.
- **Hand-written triangles need their winding asserted, not eyeballed.** The roadworks ramp shipped
  wound clockwise throughout: its slope normals came out at `y = −0.98` and its underside's at
  `+1.00`, so the only face the camera saw was the bottom — a flat quad lying on the road, which
  reads exactly like z-fighting and got reported as such. `flatShading` (below) is why it lit like a
  surface instead of going black. Check the sign of a face normal computed *from the winding*;
  `computeVertexNormals` launders a reversed triangle into whatever its neighbours say.
- **An animation that opens at zero needs shot mode told to land it.** Shot mode ticks the fare loop
  **once** and then freezes, so anything driven off sim time is stuck on its first frame. Making the
  ground discs grow out of their own centre therefore removed the rider's disc from *every*
  screenshot — `appear()` sets the scale to 0 and nothing ever advanced it. Same class as the route
  band's `routeLine.update(..., 999)`: if you add an entrance, give it a `settle()` and call it beside
  `fares.settleMarkers()` before the shot renders.
- **`ShapeGeometry` is indexed, so `attributes.position` 0/1/2 is not a triangle.** The winding check
  on the courier pad (`geometry/parcelpad.js`) went red on its first run against a pad that was
  perfectly fine: reading the position attribute in order tests a triangle that does not exist. Walk
  `geometry.index` and compute the normal from *that* winding — for every triangle, not just the
  first. This is the same trap one layer down from the one above it: a winding check written wrong
  fails exactly like a winding bug.
- **Vertex-shader animation has to be patched into *every* depth pass, and there are two.** The
  sun's shadow map is the one people remember; the SSAO prepass in `game/ssao.js` is the other, and
  it fails differently. AO is sampled in screen space, so an unpatched prepass drew the city's
  entrance at its finished size and painted each building's contact crease onto the *bare road* it
  hadn't risen out of yet — reported, reasonably, as "the SSAO looks like it isn't realtime". It is;
  it was rendering a different scene. The two passes cannot share one material: three's shadow map
  assigns `side` on whatever depth material it is handed, flipping FrontSide to BackSide
  (`WebGLShadowMap.getDepthMaterial`), so a shared instance leaves the prepass stamping the depth of
  every building's far wall. Hence `setOccluderDepthMaterial()` beside `customDepthMaterial`, and a
  draw list rather than `scene.overrideMaterial` — an override is all-or-nothing and silently
  outranks any per-mesh choice.
- **Re-planning a route every frame stalls the taxi.** `pathdrag` clears `routeConsumed` on every
  frame the finger is down, which is safe for the second or two a gesture lasts and not safe as a
  policy: the turn the car has already committed to never retires from the route, so it sits
  re-deciding the same junction. A probe that bent the route toward a package on every tick earned
  $34 in seven simulated minutes and delivered nothing. Key a plan on its endpoints and leave it
  alone in between.
- **A constant measured *across* the road did not survive the arterials being widened; one measured
  from the kerb did.** The extra third of an arterial's width all goes into the middle, so a lane
  sits at 3.33 rather than 2 while staying the same 2 units off its own kerb. Everything phrased as
  "so far out from the lane centre" — the pull-over, the weave room, the façade clearance — came
  through untouched. Everything phrased in `LANE` as a stand-in for *half the road* broke, and
  quietly: `PASS_LATERAL = 2 * LANE` sent the boosting taxi's overtake into the **median** instead
  of the oncoming lane, level with the car it was passing, which is the precise failure the old
  centreline overtake was abandoned for. When you meet a `LANE` or a `HALF_ROAD`, ask which of the
  two things it means, because only one of them is still a constant.
- **The junction box reaches by the *crossing* road's width, and the arm opposite is not a
  crossing.** Deriving a node's per-arm radius as "the widest other arm" reads fine and is wrong:
  the arm opposite is the same road carrying on through, so a wide road ends up holding itself back
  at its own junctions — every entry and exit point on an arterial off by 1.33, caught only because
  `tools/roadnet.mjs` compares the network against `grid.js` at 1e-9. Same shape one layer up:
  `grid.js` had to learn that a junction where the crossing road has been **closed** reaches by this
  road's width instead, a case that was invisible while every street was 8 wide because both
  answers were 4.
- **A backtick inside a GLSL template literal ends the shader, not the sentence.** Every shader in
  this project is a `/* glsl */ \`...\`` literal, and the house comment style leans hard on
  `backticks` for identifiers — so writing a normal comment inside one closes the template and the
  rest of the shader parses as JavaScript. It cost two builds in a row on the crayon pass, and the
  error it throws (`Unexpected identifier`, pointing at a word in the middle of a comment) names
  nothing that would lead you to it. Inside a shader literal, identifiers go bare.
- **A route through a junction does not name a *lane* into it, and a U-turn is not a legal exit.**
  `findRouteVia` plans its second leg from the heading the first leg arrives on, so a car that
  reaches the waypoint travelling along the target road the *wrong way* cannot take the lane you
  meant — and rather than failing, the router answers with a three-leg lap that reaches the right
  junction from the wrong side. That is how the burger run's tap was first written and it drove
  straight past the drive-through on about one trip in five, with nothing to see: the taxi is
  driving a perfectly good route, just not to the thing that was asked for. Anything reachable from
  one side only wants `findRouteOnto` (game/route.js), which stops the same Dijkstra on a lane
  instead of a junction. And note what it deliberately does *not* do: a car already on that lane
  gets a lap rather than an empty route, because "I am on it" and "the thing I wanted on it is
  behind me" are the same state from inside the router.
- **`makeRng()` returns an object, not a function.** `rng()` throws `rng is not a function`; the
  members are `next`, `range`, `int`, `gauss`, `pick`, `chance`, `jitter`. Reach for `rng.pick(arr)`.
- **`rotation.set(roll, yaw, pitch)` on the default Euler order rolls about the *world* X axis.**
  Three composes `'XYZ'` as Rx·Ry·Rz, so the roll lands outside the yaw. It coincides with the car's
  own long axis only when the car is driving east: north and south render the roll as pitch and show
  no lean at all, west leans the wrong way. Use `BODY_EULER_ORDER` from `util/geo.js`. The two orders
  agree exactly at yaw 0, which is why this survived for so long — and why the passing lab, whose
  road runs due east, showed a lane-change bank the game did not.
- **`flatShading` takes its normal from a screen-space derivative,** so on back faces it points into
  the screen and the surface lights as if the sun were behind it. Three's `FLIP_SIDED` only fixes
  the interpolated-normal path. Flip it by hand in any back-face pass.
- **A moving `InstancedMesh` must set `frustumCulled = false`.** Three computes its bounding sphere
  once, on the first frame the renderer culls it, from the instance matrices as they stood *then* —
  and never again. The ambient traffic meshes didn't, and the trucks paid for it: a run opening with
  no truck latched an empty sphere off `count = 0` (radius −1, at the origin), and a run opening with
  one latched a 3.1-unit bubble it then drove out of. The cab and the box are separate meshes with
  separate spheres, so the box could vanish on a frame the cab survived — a box truck with no box.
  The shadow pass culls against the *sun's* frustum, which covers the whole city, so the shadow kept
  drawing at the real position under the missing truck.
- **`user-select: none` does not stop iOS selecting text, and `touch-action` does not inherit.**
  Two separate holes that showed up as one bug on the Loco Mode pill: a thumb on it picked out
  "Loco Mode™", raised the magnifier and zoomed the city in. iOS 15 stopped honouring
  `-webkit-user-select: none` for the selection and zoom gestures ([webkit.org/b/231161]) — they run
  off the raw touch stream, so the `preventDefault` on `pointerdown` misses them too; that only
  suppresses the compatibility *mouse* events one layer above. What does reach them is
  `preventDefault` on `touchstart` (guarded by `event.cancelable`: Chrome, which already honours
  `touch-action: none`, dispatches it non-cancelable and warns on every press) plus keeping the label
  in a `pointer-events: none` span, so the gesture has no text node to hit-test onto. And
  `touch-action` is *not* an inherited property, which is why it sits on `*` and not next to the
  selection properties on `html, body`: set it on the root alone and every control the player
  actually presses computes `auto` again and keeps its own double-tap zoom.

  [webkit.org/b/231161]: https://bugs.webkit.org/show_bug.cgi?id=231161
- **`env(safe-area-inset-*)` reads 0 until `viewport-fit=cover` is on the viewport meta.** Without
  `cover`, iOS spends the notch and home-indicator insets *itself*, by shrinking the layout
  viewport — which is how `black-translucent` once measured as capping the document short of the
  true bottom "by more than the inset accounts for": the `env()` that was supposed to account for
  it was reading zero, and no canvas-sizing trick could move an edge the UA owned. The pieces
  travel together: `viewport-fit=cover`, the `black-translucent` status-bar meta, and the
  `--safe-*` calc()s on every pinned HUD element. Drop any one and the app is either letterboxed
  or has its HUD under the Dynamic Island. And even with all three, the **bottom stays short**:
  in standalone mode the layout viewport, `window.innerHeight` and percentage heights all stop
  ~34pt above the physical bottom (measured: a strip of bare sky under the canvas). `100vh` is
  the one length that reaches it from a cold start — `100dvh` reads the short value until the
  phone has been rotated once — so html/body, every `inset: 0` overlay, and the canvas (via
  `util/viewport.js`, which measures a hidden `100vw×100vh` probe instead of trusting
  `innerHeight`) all size themselves by it.
- **iOS doesn't resize the layout viewport when the software keyboard opens.** It slides a shorter
  *visual* viewport up over an unchanged one, so a `position: fixed; inset: 0` overlay still measures
  the whole screen and anything centred in it — the initials prompt did — sits behind the keys.
  `scrollIntoView` cannot fix it: the centre of that scroll container *is* the covered half. Clamp
  the container to `visualViewport` instead (`followKeyboard` in `runend.js`), and only when the two
  viewports actually disagree — Android resizes the layout viewport itself, and clamping on top of
  that takes the keyboard's height off twice.
- **A tap on a field lands where the *text* is, not where the boxes are.** The initials prompt is
  one centred 16px input stretched over three big cells, so its glyphs occupy ~30px in the middle of
  a ~214px box and a tap on the first cell collapses the caret to offset 0. With a name pre-filled
  the field is then completely inert — backspace at offset 0 deletes nothing and `maxlength` blocks
  every letter because the value is already full — which reads as "the keyboard opens and I can't
  type". Anywhere a hidden caret is painted somewhere else, pin the real one to match
  (`caretToEnd` in `runend.js`). Hook it on `click`, never on `focus` alone: the browser places the
  tap's caret *after* it fires focus, so a snap on focus is undone by the tap that caused it.
- **A synthesised click cannot test caret placement.** Untrusted events don't move a caret, so a
  `dispatchEvent(new MouseEvent('click'))` check passes against the very bug above. The initials
  check in `tools/smoke.mjs` uses `Input.dispatchTouchEvent` for that reason.
- **Two listeners on the same element fire in registration order, capture flag or not.** At the
  target node the DOM spec runs capturing and bubbling listeners in the order they were added, so
  `{ capture: true }` on the canvas does *not* let a later module beat `attachDragPan` to a
  `pointerdown`. The only ordering that holds regardless of construction order is a capture
  listener on an **ancestor** — which is why the route-band drag listens on `window`. Getting this
  wrong throws nothing; the map just slides out from under a gesture meant for something else.
- **`:active` names the button the press *started* on, not the one the finger is over.** The bottom
  row is one control surface — a thumb slides from Loco Mode onto the brake without lifting
  ([gameplay.md](docs/gameplay.md#the-pedal-slide)) — and the browser pins `:active` to the
  `pointerdown` target for the life of the gesture, so the press dip lit the pill the thumb had left
  and the brake it was standing on looked untouched. Anywhere a press can *move*, the pressed look
  has to be a class you set (`is-held`, with `body.pedal-slide` suppressing `:active` on both) and
  not the pseudo-class. Same shape one layer down: pointer capture means every event for the rest of
  that gesture lands on the origin element, so the event's target tells you nothing about what is
  under the finger — hit-test coordinates against rectangles, and measure those rectangles *before*
  the press, because both buttons scale while held.
- **The drawn taxi is not `CAR_LEN` long.** `createTaxiMesh` puts `TAXI_SCALE = 1.18` on the group,
  so the body on screen is 4.01 units where the simulation's constant says 3.4 — and every sim
  number (following distance, the collision envelope, `MIN_GAP`) is in the 3.4 space, which is why
  the discrepancy never surfaces there. It surfaces the moment anything *places* the taxi against
  scenery: parking it in the garage by half of `CAR_LEN` put its nose a third of a unit through a
  shut door. The drawn half-length is already exported as `TAXI_TAILPIPE_BACK`.
- **A face pointing at the camera is not the same as a face the camera can see.** The view is a
  fixed diagonal, so the sightline off any surface climbs 0.92 of a unit for every unit it travels
  in *both* x and z — which means it leaves the block it started on diagonally and can end up
  behind a tower two blocks away that nothing about the local geometry mentions. The garage door
  faces +X and is still only visible because it sits near its block's −Z edge: that buys it 7.5
  units of x before the line crosses the block's far edge, which keeps the crossing inside the
  8-unit road. Work the ray out (`occlusionClear` in `city/garage.js` shows it) — and then fire a
  real `Raycaster` through the real merged city in the probe, because the arithmetic is about what
  the *generator* is going to build there, not about what it built this time.
- **The fare board is seeded by the first `fares.update`, not at construction.** `shouldRefill`
  fills an empty board immediately, so "the clocks are paused" (`setPaused`) is not the same claim
  as "no rider has appeared" — pausing holds the countdown and spawns a rider anyway. Anything that
  wants the board to stay empty has to skip the `update` call, the way the Home Screen tip and the
  opening vignette both do. Left running through the vignette, a two-metre crystal turned up on the
  kerb the camera was pointed at.
- **`createLayout()` is not a pure function.** It closes segments and installs the road network it
  just baked as *the* city network, so calling it a second time — a probe sweeping seeds, a tool
  building a comparison city — silently replaces the city everything else is measuring against.
  Eight traffic and routing checks went red for a change that only touched buildings. Rebuild the
  layout you meant to keep afterwards.
- **Distance fog under this orthographic camera is not uniform — fog placed *from zero* is.** The
  city sits at view-space depth 400 ± 65, so a `Fog(near = 0, far = 1000)` varies by a few percent
  across the whole map and reads as a flat wash. That got measured once and written down as "an
  ortho camera can't have distance fog", which is wrong and cost the scene its only depth cue for a
  long time. The band has to be placed **around the 400-unit standoff** (`hazeRange()` in
  `scene.js`). The same arithmetic is why it must be linear rather than `FogExp2`: an exponential is
  a distance from the eye, and this eye is 400 units from everything, so any density that reads at
  the back also washes the nearest pixel.
- **A tall hit box under this camera steals taps from the marker *up-screen* of it.** The picker
  takes the nearest hit, and the view is a fixed 33° diagonal, so a box 14.5 tall throws its top
  face 11.1 units of ground up-screen of its base — past the junction it belongs to, onto a marker
  that is further from the camera and therefore loses. The fare markers' 20 × 14.5 × 20 box was also
  centred on the *junction* while the rider stands 4.5 units off it on both axes, so the region was
  offset from its own marker as well as reaching over its neighbour: measured over a 3 × 3 of
  markers, a tap dead on a rider's disc selected the marker one junction down-screen, every time.
  A tap target wants to be a **quad in the screen plane** (`BILLBOARD` in `game/camera.js`) over the
  thing it answers for — then what it covers is what you see, and `VIEW_UP` raises it in frame
  without moving it in depth. And check the *screen* separations before sizing one: neighbouring
  junctions are 14.1 screen units apart sideways and 15.4 down the diagonal, which is the whole
  budget.
- **A mark on the ground can be behind a building, and that is a fact about the *city*.** The view
  never rotates and the projection is orthographic, so what occludes what does not change when the
  player pans or zooms — a corner hidden on one frame is hidden for the whole run. Which is what
  makes it fixable at spawn (`cornerSeen` in `game/fares.js`) rather than per frame, and what makes
  it worth measuring rather than eyeballing: the corner the courier pad kept disappearing behind was
  **(0, 0)**, because `cornerFor` flips *both* axes at the origin junction and lands the pin on the
  one corner of block (0, 0) with its own building between it and the camera. The test behind it
  (`game/sightline.js`) is a height field and not a raycast for a measured reason — 324 rays through
  the merged city is 527 ms — and its rasterisation deliberately rounds occluders **up**, so its only
  possible error is losing a junction rather than hiding a marker.
- **View-space depth is measured from the camera's *target*, and the target moves.** Anything
  placed by where it lands on screen — the clouds ring the island that way (`game/clouds.js`) —
  gets its third coordinate for free under an orthographic projection, and "free" lasts exactly
  until the player drives to a corner: a target at the map's far corner sits 59 units further down
  the view axis than one in the middle. A cloud drawn *below* the island has to be a long way
  towards the camera to be up in the air at all (1.54 units of standoff per unit of drop), and the
  first build put those at 35 units of depth measured from the origin — **behind the camera** by
  the time the taxi reached the far corner. They vanished, and only from one end of the map.
- **A straight lane outside a convex keep-out can only ever cover half its perimeter.** The clouds
  were first flown down straight lines chosen to clear the city, which reads as obviously
  sufficient and is not: a lane clears the island only if the *whole infinite line* does, and every
  line that could reach the sky beside the two edges the wind is not parallel to crosses the city on
  its way. Half the map had weather and half never could — 0.13 clouds in frame on a phone against
  1.04 on a desktop. Where a thing has to stay outside a shape, the shape is usually the path.
- **A rim fade on `dot(normal, view)` spends its whole ramp in the last tenth of the radius.** That
  dot is the *cosine* of the angle off the view axis, and a cosine sits near 1 across most of a
  sphere's disc and then falls off a cliff: fading linearly on it feathers a 40-pixel cloud lobe over
  about four pixels, which reads as a slightly blurry edge and not as soft at all. The screen radius
  is the **sine** of the same angle — `sqrt(1 - d²)` — and fading on that puts the ramp where it can
  be seen (`geometry/cloud.js`). Two things travel with it: the shape has to be grown to pay for
  what the fade eats, and a surface *buried inside a neighbour* has to be exempted, or every
  intersection curve between two lobes draws an arc where one is turning away while the other is
  still solid.
- **A formula applied per vertex does nothing where there are no vertices.** The route band emits
  one quad per path segment and deliberately never subdivides a straight — the fade is a
  per-fragment varying, so a 20-unit straight needs no interior points. That is sound while the only
  per-vertex data is a *linear* one; it stops being sound the moment Y is a `sin^2`. Adding
  `deckHeightAt` to the emitter and calling the arched bridges fixed was therefore a no-op, and an
  exact one rather than an approximate one: a junction arm is trimmed to the **crossing** road's
  half-width, so a bridge lane starts and ends precisely on the two abutments — the lane and the
  deck are the same segment — and those are exactly the two places `rise · sin²(πu)` evaluates to
  zero. Six vertices out of six read 0.0. Before believing a per-vertex fix, count the vertices it
  has to work with, and check what the geometry does *at the ones it has*.
- **Two guards can each look reasonable and select nothing between them.** The Loco arch jump fired
  on `y > 0.75 · ARCH_RISE && dydz · dirSign <= 0`. On a `sin²` the height test holds across the
  middle third and the slope test holds from the peak on, so the conjunction is satisfied on the
  *first frame past the exact apex* — the height test was inert, the slope test was the whole gate,
  and the hop then peaked `HOP_LEN/2` down the far side and landed the taxi 0.94 units past the
  abutment, in the junction box. It read as "the bounce starts late", which is the kindest possible
  symptom for a trigger that is firing in exactly the wrong place. When a trigger is a conjunction,
  work out the interval each term admits and where they actually intersect.
- **A hole in the geometry is invisible over the city and a bright speck at the coast.** The island
  fades to sky at its rim, so anywhere the map has a gap, what shows through it is dark ground
  inland and *sky* out at the edge — 211 luma against the 82 of the ground beside it. Three separate
  gaps at the river mouth were each years-old and each only ever reported as "a white speck near the
  bridge": the water strip stopping short of the end of the fade band, a railing run with no end post
  (`RAIL_POST_PITCH` is a world pitch, so a run's ends land wherever they land), and an abutment that
  stopped at the bank and left the embankment strip under the deck open from the side. Count pixels
  brighter than the ground rather than looking — at play zoom each of these is two or three pixels,
  and at the framing that resolves them they are obvious.
- **The coplanar-shimmer rule is about surfaces that *overlap*, not surfaces that touch.** Two
  co-planar quads laid edge to edge sharing their vertices are a seam, not a fight, and pushing one
  of them down "to be safe" creates the artefact it was meant to avoid: the river's shoal set 0.08
  below the skirt it butts against drew a hairline of open sky down the whole length of the mouth,
  because this camera looks *along* an 8cm riser. Ask whether the two surfaces cover any of the same
  ground before nudging either one.
- **A scale is about its carrier's origin, so "shrink it to hide it" moves anything whose offset is
  in its vertices.** The brake and turn-signal pods are switched by scaling their level to 0
  (`instanceColor` is paint and cannot carry an on/off), and each *pair* was one merged geometry
  holding both pods' offsets in its own vertices. Scaling that does not dim a lamp, it flies it: the
  pods slid toward the car's origin and down to the road as the level fell — 1.59 units forward and
  0.87 down on a car, **2.69 forward on a truck**, which parks a brake light level with the middle
  of the cargo box. Three things kept it hidden for so long, and each is worth its own note. A pod
  is a handful of pixels at play zoom, so the mesh's own slide reads as nothing; it was the *bloom*
  that showed it, the spill being an order of magnitude wider than the thing spilling, and it got
  reported as the glow having come unstuck from the car. Only the **brake** lamp can show it at all,
  because only the brake level is eased (`BRAKE_LIGHT_FALL`, ~0.75s) — a turn signal steps 0 to 1
  and is never caught in between. And the taxi had it too, by the same line of reasoning in a
  different file (`setLights` in geometry/taxi.js), because both read their geometry from
  geometry/lights.js. The fix is that the anchor is a **pivot**: pods are centred on their own
  origin and the offset rides the transform, one pod per mesh or instance. It has to be per pod —
  one merged pair can only be scaled about a point both pods share, and the two kinds disagree about
  which point that is (a brake pair differs across the car, a turn-signal pair along it).
- **A thin shell that both casts and receives shadows will shadow itself, and it looks like
  z-fighting.** One shadow texel is 0.123 world units (`MAX_SPAN * 1.05` each way over a 2048 map),
  and the depth a texel records slides by `texel × tan(incidence)` across its own width — up to
  0.33 for a bridge soffit 70° off the light, more once PCFSoft reads a three-texel kernel. A
  bridge deck sits `DECK_THICK` = 0.35 above that soffit, so the map cannot tell the two apart and
  the deck goes blue in blotches down the carriageway. Every *other* caster in this city is a solid
  box whose far wall is a long way behind the lit face, which is why `sun.shadow.bias` and
  `normalBias` are tuned as if the problem did not exist — and why the fix is per-mesh
  (`sinkShadowCaster` in game/scene.js) rather than another turn of those: the bias that clears the
  deck detaches every car's shadow from its wheels by 0.82 units. Push a thin caster **along the
  light's own rays** instead; a directional light's rays are parallel, so its silhouette on every
  receiver is unchanged and only the recorded depth moves. Under an orthographic shadow camera that
  direction is free — it is view-space −Z, so `mvPosition.z -=` needs no uniform.
- **`instanceColor` is RGB only.** Per-instance alpha needs a custom attribute plus an
  `onBeforeCompile` patch — a 4-component colour attribute takes a different code path.
- **Jitter vertices by position, not index.** Non-indexed geometry repeats shared corners, and
  per-index jitter tears surfaces open.
- **Effects must be sized against the camera.** At play zoom 1 world unit ≈ 7.7px.
- **A bundled web app on a `file://` origin fails in four ways, and only one of them is loud.** This
  is why the iOS shell serves `dist/` through a `WKURLSchemeHandler` on `simtaxi://` rather than
  calling `loadFileURL` (`ios/SimTaxi/BundleSchemeHandler.swift`). ES modules fail the CORS check, so
  the game doesn't boot — that one announces itself. The other three don't: root-absolute `/assets/…`
  paths resolve to the filesystem root, service workers never register, and **`localStorage` throws
  `SecurityError`** — which `highscores.js` catches *by design*, degrading to an empty table rather
  than losing a run over a saved score. On `file://` that safety net turns into silent data loss:
  scores appear to save and every relaunch comes up empty, with nothing logged. Whenever a store is
  allowed to fail soft, check what an origin change does to it.
- **The city's entrance wave cannot animate anything with a transform of its own.** It is a vertex
  shader, and the anchor each vertex scales about is stamped into the geometry in **world**
  coordinates (`stampEntry`) — which only means anything while the mesh's own matrix is the
  identity. A world coordinate in a rotating object's local space is not a coordinate. The burger
  turning over the drive-through has to be its own mesh for exactly that reason, and it grows
  through `createCityEntry`'s `objects` list instead: a handful of transforms scaled on the CPU, on
  the same curve and the same delay. Leaving it out of the wave entirely is not the alternative it
  looks like — the sign then hangs in the air over a hole in the ground for the whole two seconds
  the city takes to arrive.
- **Two flat surfaces at the same height is a shimmer, not a touch.** The block platform lays its
  pavement at `KERB_H + 0.01`, and anything else put down on a block — the depot's forecourt, the
  drive-through's asphalt apron, the paint on it — has to clear that rather than land on it. The
  apron's first cut used `base ± 0.01` off `KERB_H`, which is the *same plane*, and the whole lot
  flickered as the camera moved. Vertical faces are exempt and so are down-facing ones (a
  down-facing surface is culled before it can fight anything, which is why the burger joint's awning
  sitting exactly on its door's top face is fine). Name the levels off each other —
  `PAVEMENT_Y`/`APRON_Y`/`PAINT_Y` in `city/burgerjoint.js` — rather than nudging literals, and let
  the module that *lays* a surface export the height anything standing on it needs.
- **A car handed back to the traffic model inside its own stop line runs the light, and nothing
  stops it.** `placeCar` will happily put one anywhere on a lane, `STOP_SETBACK` is 3.4, and there
  is no `distToLine > 0` guard on the stop decision — so a car released nearer than that is past
  its hold line before it can see the signal. The half that makes it invisible rather than loud is
  `sim/collisions.js`: it only ever tests the **taxi**, and only while it is boosting, so the car
  does not crash into the cross traffic it just drove into. It drives *through* it. This is what
  costs the drive-through its short exit and buys it two quarter turns (`EXIT_LIFT` in
  `city/burgerjoint.js`), and it is the question to ask of any new `releaseCar` site: how far back
  from the junction does this land, measured?
- **A transparent `propMaterial()` receives ambient occlusion it can never cast.** `markOccluder`
  refuses to put a transparent mesh in the AO depth prepass — quite rightly, a surface you can see
  through has no business writing depth — but *receiving* is the default, so a translucent prop
  samples the occlusion of whatever is behind it. The river's water is where that stopped being
  invisible: at the bottom of a two-unit channel it read the walls' own crease and went nearly
  black, while the stretch running off the end of the island had an empty AO buffer behind it and
  came out at full brightness, with the discontinuity landing exactly on the coast. Pass
  `propMaterial({ ao: false })`. The asphalt's fade skirt has the same hole and gets away with it
  only because nothing stands near it.
- **A lofted strip built from a `sign` is wound backwards on one of its two sides.** Half the
  bridge deck's pieces are built as a mirrored pair off `sign = ±1`, so one of each pair arrives
  with its ends the other way round — and a quad wound from `x1` to `x0` faces *down*. Sort the
  span inside the builder rather than trusting the caller. This is the roadworks ramp's bug wearing
  a loop, and it fails the same way: `flatShading` takes its normal from a screen-space derivative,
  so the reversed face still lights and reads as z-fighting rather than as inside out.
- **Three turns off in-material tone mapping *and* the sRGB encode the moment the render target is
  not the screen.** `WebGLPrograms.getParameters` reads `renderer.toneMapping` only when the current
  target is null, and the colour-space encode follows the target's own `colorSpace` — both by
  design, so an `EffectComposer`'s `OutputPass` can do them once at the end. Which means routing the
  city through *any* render target silently moves a seam this project builds on: `propMaterial()`
  patches `<colorspace_fragment>` because the frame is in **display space** by then, and both
  Crayon and Cartoon Mode mix sRGB-encoded ink constants into it there. Under a composer those
  constants land in linear values and every line in the game is the wrong colour, with nothing
  logged. `game/hdr.js` declines the two look modes outright rather than drawing it.
- **In a layer-gated pass, skipping the material swap does not skip the draw.** What decides who
  renders is `camera.layers`; swapping each mesh's material is only what decides *how*. So a loop
  that `continue`s over an entry — because it is switched off, or fails a test — leaves that mesh on
  the layer wearing its **own** material, and it goes into the pass at full strength with none of
  the patches the pass relies on. The bloom's route band shipped like this for an afternoon: dialled
  to zero it came out **brighter** than at 0.6, and glowing over the building in front of it,
  because the material carrying both the intensity and the depth reject was the one being skipped.
  Switch an entry off on the material instead — three honours `material.visible` when it builds the
  render list — and never let the loop that swaps have an early exit
  (`refreshEmissive` in `game/bloom.js`).
- **A downsample chain summed at equal weight is a fog, not a glow.** A box downsample preserves the
  *average* of what it reads, so every level of a bloom chain carries the same average as the one
  above it — and adding three of them lifts the whole frame by three times the mean brightness of
  whatever is glowing. It reads as a pink haze across the road around a police car rather than a
  light on its roof, and it looks like the strength being too high, so the instinct is to turn down
  the one knob that was not the problem. Each level has to come in at a fraction of the one below
  (`LEVEL_WEIGHT` in `game/bloom.js`); it is the same thing `UnrealBloomPass` spells as `radius`.
- **Never name a Rollup chunk after anything under `src/`.** `vite.config.js` has two entries now
  (the game and `/lab/`), and a `manualChunks` rule that swept `src/main.js` into a shared chunk
  made every page importing that chunk *boot the game* — `/lab/` came up with the city's road
  network installed under its own. Rollup already gives each entry module its own chunk; overriding
  that turns an import into a boot. See [docs/lab.md](docs/lab.md#build-and-deploy).

## Deploy

Netlify, configured in `netlify.toml` (build `npm run build`, publish `dist`, Node 22). Push to
`main` and Netlify builds it. Verify a production bundle locally with `npm run build && npm run
preview` plus `node tools/smoke.mjs --url http://localhost:4173`.

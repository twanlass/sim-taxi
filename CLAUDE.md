# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Sim Taxi** — a low-poly 3D browser game. Crazy Taxi meets Flight Control: a fixed 3/4 view of a
5×5 block city, ambient traffic obeying real signals, and one taxi you route by tapping fares.

Three.js r0.180 + Vite 7. **Zero external assets** — every mesh is generated in code.

## Read the docs first

`docs/` covers each system: what it does, which files own it, and the decisions behind it that
aren't obvious from the code. Start at the index and read the one doc that covers what you're
about to change.

| Doc | Covers |
|---|---|
| [docs/README.md](docs/README.md) | **Index — start here** |
| [docs/architecture.md](docs/architecture.md) | Module map, frame loop, seeding, `window.__taxi` test hook |
| [docs/city.md](docs/city.md) | Coordinates, direction encoding, layout, park districts |
| [docs/traffic.md](docs/traffic.md) | Signals, arterials, ring road, car physics, boost, police corridor, the bust chase |
| [docs/gameplay.md](docs/gameplay.md) | Opening vignette, fare loop, routing, picking, timer ring, economy |
| [docs/difficulty.md](docs/difficulty.md) | The ramp: budgeted clocks, board size, shifts, the sweeps behind the numbers |
| [docs/rendering.md](docs/rendering.md) | Low-poly technique, camera, lighting, day/night, effects |
| [docs/testing.md](docs/testing.md) | `npm run check`, the headless tools, screenshots |
| [docs/lab.md](docs/lab.md) | The passing lab at `/lab/` — a straight road with no lights, for watching Loco Mode |

## Commands

```bash
npm run dev        # http://localhost:5173 — and the passing lab at /lab/
npm run check      # the whole headless suite, ~1.8s — run this before reporting anything
npm run build      # production bundle into dist/ (two pages: the game and /lab/)
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

**Two seeds, kept separate.** `?seed=` is the city and `?run=` is the situation; both are random
each load unless pinned. Shot mode pins the city seed so screenshots don't move under an
unrelated change. Each generator draws from its own offset stream so that editing one system
doesn't reshuffle every other one.

**Comments carry the "why".** Many record a measurement or a failed first attempt. If you change
behaviour a comment describes, update the comment — and if you measure something, write the number
down.

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
- **`instanceColor` is RGB only.** Per-instance alpha needs a custom attribute plus an
  `onBeforeCompile` patch — a 4-component colour attribute takes a different code path.
- **Jitter vertices by position, not index.** Non-indexed geometry repeats shared corners, and
  per-index jitter tears surfaces open.
- **Effects must be sized against the camera.** At play zoom 1 world unit ≈ 7.7px.
- **Never name a Rollup chunk after anything under `src/`.** `vite.config.js` has two entries now
  (the game and `/lab/`), and a `manualChunks` rule that swept `src/main.js` into a shared chunk
  made every page importing that chunk *boot the game* — `/lab/` came up with the city's road
  network installed under its own. Rollup already gives each entry module its own chunk; overriding
  that turns an import into a boot. See [docs/lab.md](docs/lab.md#build-and-deploy).

## Deploy

Netlify, configured in `netlify.toml` (build `npm run build`, publish `dist`, Node 22). Push to
`main` and Netlify builds it. Verify a production bundle locally with `npm run build && npm run
preview` plus `node tools/smoke.mjs --url http://localhost:4173`.

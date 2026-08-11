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
| [docs/gameplay.md](docs/gameplay.md) | Fare loop, routing, picking, timer ring, economy |
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

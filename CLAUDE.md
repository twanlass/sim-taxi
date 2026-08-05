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
| [docs/rendering.md](docs/rendering.md) | Low-poly technique, camera, lighting, day/night, weather, effects |
| [docs/testing.md](docs/testing.md) | `npm run check`, the headless tools, screenshots |

## Commands

```bash
npm run dev        # http://localhost:5173
npm run check      # the whole headless suite, ~1.8s — run this before reporting anything
npm run build      # production bundle into dist/
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
doesn't reshuffle every other one — including the night lighting, which has streams of its own so
that switching the city's lights on doesn't move a tower or a tree.

**The sky is never allowed to go dark enough to lose in.** `VISIBILITY_FLOOR` in `daylight.js` is a
playability constant, not an aesthetic one: every darkening influence (night, overcast, rain, fog)
is a multiplier, they compose, and the floor is the one thing stopping them from reaching zero
between them. `tools/sky.mjs` sweeps every hour against every kind of weather to prove it.

**`?hour=` and `?weather=` pin a frame.** Either stops its own clock. Use them to look at one
moment instead of chasing it.

**Comments carry the "why".** Many record a measurement or a failed first attempt. If you change
behaviour a comment describes, update the comment — and if you measure something, write the number
down.

## Traps that have bitten before

- **Don't name a file `beacon.js`** (or an element `#banner`). Ad blockers match those against
  filter lists — `ERR_BLOCKED_BY_CLIENT` takes the whole module graph down. Hence `#run-end`
  rather than `#banner`, and why the rider's shaft of light was `lightshaft.js` for as long as it
  existed.
- **`car.state === 'turn'` includes going straight through a junction.** A real turn is
  `car.dOut !== car.d`.
- **No `distToLine > 0` guard on the stop decision.** A car spawning within `STOP_SETBACK` of its
  target starts past the hold line; that guard once sent cars off the map to x = −1064.
- **`instanceColor` is RGB only.** Per-instance alpha needs a custom attribute plus an
  `onBeforeCompile` patch — a 4-component colour attribute takes a different code path.
- **Jitter vertices by position, not index.** Non-indexed geometry repeats shared corners, and
  per-index jitter tears surfaces open.
- **Effects must be sized against the camera.** At play zoom 1 world unit ≈ 7.7px.
- **A raw `ShaderMaterial` gets no `#include <colorspace_fragment>`.** Without it a colour renders
  linear — darker and more saturated than the hex says. The route band knew this; the sky dome
  didn't, and every sky in the game was wrong by that amount until the cycle started running.
- **This camera sees each building's +X and +Z faces.** A light placed anywhere else lights the far
  side of the city and renders black boxes. It cost a whole night pass to find.
- **Lamp pools stack.** Four per block corner, blocks 20 units apart — anything additive on the
  road has to be tuned against three or four of itself overlapping, not against one.
- **`tools/smoke.mjs` must click `body > canvas`.** Rider-finder chips own canvases that sit
  earlier in document order, so a bare `querySelector('canvas')` clicks a 38px chip and the
  picker never fires.

## Deploy

Netlify, configured in `netlify.toml` (build `npm run build`, publish `dist`, Node 22). Push to
`main` and Netlify builds it. Verify a production bundle locally with `npm run build && npm run
preview` plus `node tools/smoke.mjs --url http://localhost:4173`.

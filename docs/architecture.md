# Architecture

## Module map

```
src/
  main.js               wiring + the frame loop + HUD. The only file that knows about all systems.
  palette.js            every colour in the game, named

  city/                 the world, generated once at startup
    grid.js             coordinate system, direction encoding, legal moves
    layout.js           decides what each block *is* (density, parks) before anything is built
    ground.js           roads, kerbs, block surfaces, crosswalks
    buildings.js        one merged mesh of blocky towers
    props.js            trees, lamps, street furniture

  sim/                  things that move on their own
    traffic.js          signals + car physics + the single routing branch. The largest file.
    police.js           the priority-corridor car
    collisions.js       taxi-vs-car impact test, boost only — wrecks both cars

  game/                 the player's layer
    fares.js            fare state machine, spawning, scoring
    route.js            directed Dijkstra with road-hierarchy weights
    routeline.js        the route band painted down the taxi's lane
    pick.js             raycast click picking
    faremarker.js       the fare clock, as a physical object: kerb, flight, taxi
    boost.js            crazy-taxi duty cycle (a pure clock, no scene knowledge)
    camera.js           fixed 3/4 orthographic camera
    scene.js            scene, sun, hemisphere fill, sky shader
    daylight.js         hour → lighting curve, and the clock that can drive it
    debugpanel.js       the ⚙️ tweak panel
    skidmarks.js        rubber ring buffer
    dust.js             instanced dust puffs
    sparks/smoke/debris/flames.js   the crash detonation, one set fired per wrecked car
    vanish.js           shrink-and-fade for wrecked bodywork, so it is consumed not deleted
    runend.js           the run-end blackout: stats counted out a row at a time

  geometry/             one-off models, all procedural
    taxi.js  wheels.js  diamond.js  marker.js  person.js  riderdiamond.js

  util/
    rng.js              seeded RNG (mulberry32) + value noise
    geo.js              vertex-colour baking, jitter, shared prop material
    shot.js             URL parameter parsing (?seed= ?run= ?cars= ?shot=)

tools/                  headless test + screenshot harness — see docs/testing.md
```

The dependency direction is one-way: `city/` knows nothing about `sim/`, `sim/` knows nothing
about `game/`, and only `main.js` knows about everything. The one deliberate exception is
`city/layout.js` calling `configureSignals()` in `sim/traffic.js` — the layout decides which roads
are arterials, and that has to reach the signal model.

## The frame loop

`main.js` runs one `requestAnimationFrame` loop with a `dt` clamped to 0.05s, so a background tab
or a stall can never teleport a car through a junction.

Order matters in three places:

```js
boost.update(dt);                      // 1. decide whether the taxi is boosting this frame
traffic.taxi.boost = boost.isActive();
skids.update(dt); dust.update(dt); daylight.update(dt);

police.update(dt);                     // 2. may flip a whole corridor green...
traffic.update(dt);                    // 3. ...before any car reads the signals

const event = fares.update(dt, traffic.taxi);   // 4. arrival is judged against settled positions
```

1. Boost state is pushed onto the taxi *before* the sim reads it, so activation takes effect the
   same frame the button is pressed.
2. `police.update` sets the priority corridor. If it ran after `traffic.update`, cars would read
   last frame's signal state and the corridor would lag a frame behind the car creating it.
3. Fares resolve last, against positions that are already final for the frame.

`fares.update` returns the frame's events as `{type, fare}` objects (`'spawned'`, `'pickup'`,
`'delivered'`, `'failed'`) rather than firing callbacks. The fare system therefore has no reference
to the taxi mesh, the HUD, or the toast — `main.js` translates the events into all of those. It is
a list rather than one value because two fares run at once and more than one thing can resolve in
the same frame.

## Seeding

Two independent seeds, and keeping them separate matters:

| Seed | Controls | URL | Default |
|---|---|---|---|
| **city seed** | layout, buildings, props, parks, arterials | `?seed=` | random each load (shot mode pins `71624`) |
| **run seed** | car spawns, fare spawns, police timing | `?run=` | random each load |

Both are random by default: every load is a fresh city with a fresh situation on it. `?seed=N`
pins a map you want to keep playing — the accepted seed is logged to the console on every load
and mirrored to `window.__taxi.seed` so it's easy to grab. Shot mode always pins the city seed
so review screenshots don't shift under a change unrelated to the layout.

`main.js` also runs a connectivity check after `createLayout` and rerolls the city seed if the
random park closures happen to strand part of the map — the fare loop depends on `findRoute`
never returning null, so a bad seed can't be allowed to reach the meshers.

Within a seed, every generator draws from its own offset stream:

```js
createLayout(makeRng(seed));
createGround(makeRng(seed + 11), layout);
createBuildings(makeRng(seed + 22), layout);
createProps(makeRng(seed + 33), layout);
createTraffic(makeRng(runSeed + 44), ...);
```

This is deliberate. A single shared stream means adding one `rng.range()` call inside the building
generator reshuffles every park and every car — you change one thing and the whole city moves,
so you can't tell what your edit actually did.

## Testing hooks

`main.js` exposes `window.__taxi` with `traffic`, `boost`, `skids`, `police`, `fares`, `daylight`,
`routeTo`, `findRoute` and `isSelected`. The headless tools in `tools/` drive the game through
this instead of through the DOM, which is what makes the whole suite run in about a second.

`?shot=` puts the app in screenshot mode: it freezes the day/night cycle, hides the HUD, warms the
sim forward to a specific moment (mid-pickup, mid-corridor), then sets `document.body.dataset.shotReady`
for the capture tool to wait on.

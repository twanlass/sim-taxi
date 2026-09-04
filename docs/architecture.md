# Architecture

> **The grid has two counts.** `GRID_I` is the highest `i` line index and `GRID_J` the highest `j`,
> and they are not the same number: the city is six block rows tall against five columns, because
> one of the rows is the river ([river.md](river.md)). `lineCoord` split into `lineX`/`lineZ` with
> them, since the city is centred on the origin on both axes and the half-spans no longer agree.
>
> `GRID`, `SPAN`, `HALF_SPAN` and `lineCoord` were **deleted rather than aliased**. An ESM named
> import of a missing export fails at link time, which is what forced all 133 call sites to be
> looked at instead of silently keeping the old meaning — and the split shipped as its own commit
> with both counts still at 5, so `npm run check` was a control on it rather than a hope.

## Module map

```
src/
  main.js               wiring + the frame loop + HUD. The only file that knows about all systems.
  palette.js            every colour in the game, named

  city/                 the world, generated once at startup
    grid.js             coordinate system, direction encoding, legal moves
    curves.js           lines and arcs, arc-length parameterised — offset, trim, sample
    roadnet.js          the road network: nodes/edges in, lanes/turns/signals/blocks out
    layout.js           decides what each block *is* (density, parks) before anything is built
    ground.js           roads, kerbs, block surfaces, crosswalks
    buildings.js        one merged mesh of blocky towers
    props.js            trees, street furniture
    pond.js             the one duck pond: which park it lands in, and the water itself
    garage.js           the taxi's depot: which block it takes, and the roller door on the front
    burgerjoint.js      the burger joint: its block, its drive-through lane, and the turning sign

  sim/                  things that move on their own
    traffic.js          signals + car physics + the single routing branch. The largest file.
                        Cars drive lanes off the road network; `car.s` is arc length along one.
    police.js           the priority-corridor car
    collisions.js       taxi-vs-car impact test, boost only — wrecks both cars

  game/                 the player's layer
    fares.js            fare state machine, spawning, scoring
    difficulty.js       the ramp: one scalar, and every knob hung off it
    route.js            Dijkstra over the road network's lanes, road-hierarchy weights
    routeline.js        the route band painted down the taxi's lane
    pick.js             raycast click picking
    sightline.js        which kerb corners the camera can see, settled once per city
    farepointers.js     one edge arrow per off-frame fare — direction and clock, nothing more
    riderfinder.js      the HUD chips that used to do that job, now behind `?chips=on`
    taxifinder.js       the chip that comes up when the taxi is off-frame — tap to ride back to it
    faremarker.js       the fare clock, as a physical object: kerb, flight, taxi
    selectpop.js        the swell-and-settle curve a tapped rider and their crystal share
    boost.js            crazy-taxi duty cycle (a pure clock, no scene knowledge)
    camera.js           fixed 3/4 orthographic camera
    scene.js            scene, sun, hemisphere fill, sky shader, distance haze
    daylight.js         hour → lighting curve, and the clock that can drive it
    debugpanel.js       the ⚙️ tweak panel
    skidmarks.js        rubber ring buffer
    dust.js             instanced dust puffs
    blast.js            the crash detonation whole — shockwave, fireball, shards; one per wrecked car
    flames.js           the tailpipe bark on the press that engages Loco Mode
    locoflame.js        the flat stylized plume that burns out of it for the whole hold
    vanish.js           shrink-and-fade for wrecked bodywork, so it is consumed not deleted
    carghosts.js        occluded-only outlines on the traffic nearest the taxi, faded in with boost
    flyover.js          the ambient plane that crosses the city every so often — scenery, nothing more
    chopper.js          the helicopter that lands on the city's rooftop helipad, idles and leaves
    birds.js            the park flocks: walk the grass, startled up by the taxi, come back; two per city
    ducks.js            the birds on the pond: paddle, sit, dabble, never leave
    clouds.js           the weather ringing the island — placed on the screen, never over the city
    opening.js          the opening vignette: camera onto the garage door, door up, taxi out
    drivethru.js        who pulls into the burger joint, what they do in there, how they leave
    burgerrun.js        the secret: a tap on the joint sends the taxi through it for a splash of boost
    runend.js           the run-end blackout: stats counted out, then initials, then the table
    highscores.js       the local top five — localStorage is the whole backend
    homescreen.js       the iOS-only "add it to your Home Screen" screen; parks the run while up
    pause.js            the HUD's ⏸ and the screen behind it; stops the frame loop dead

  geometry/             one-off models, all procedural
    taxi.js  wheels.js  diamond.js  targetring.js  marker.js  person.js  riderdiamond.js
    plane.js bird.js helicopter.js cursebubble.js cloud.js

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

The loop's one early exit is the pause button: while it is set, `frame()` renders and returns
before a single `update()`, so nothing in the game advances at all. See
[gameplay.md](gameplay.md#pause) for what that has to be careful about.

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
to the taxi mesh or the HUD — `main.js` translates the events into all of those. It is
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

## Installability and offline support

`public/sw.js`, registered from the top of `main.js`, guarded by `!import.meta.env.DEV` — skipped
under `npm run dev`, where Vite rewrites module URLs on every change and a worker caching those
responses would serve stale code back mid-session. It only runs against a real build (`npm run
build` + `preview`, or the deployed site).

The worker's job is one thing: a Home Screen launch has to work with no connection, which nothing
gave it for free. The city has zero external assets already (see the docs index), but the *shell*
— `index.html` and the Vite-built JS bundle — still has to be fetched over the network on first
paint like any other page, and a browser that fails that fetch offline just fails to load.

**Two cache strategies, split by request.** Navigations (`index.html`) go network-first, so a tab
open online always sees the latest deploy, falling back to the cached shell only once there is no
connection. Everything else — the hashed `/assets/*` bundle Vite fingerprints per build, the icons
— goes cache-first: those filenames are content-hashed and therefore immutable, so a cache hit is
always correct.

**The hashed bundle is precached at install, not left to the fetch handler.** The shell's own
`<script>`/`<link>` requests, on the load that registers the worker, race the worker's own install
and are not guaranteed to be intercepted — a device that was only ever online for one visit could
still come up empty offline otherwise. Since the bundle's filename isn't known ahead of time, the
install step fetches `/index.html` fresh, regexes the real `/assets/...` paths back out of it, and
caches those alongside the static shell files (icons, `manifest.webmanifest`). That is what makes
a single online visit enough.

`public/manifest.webmanifest` names the app and its icons for platforms that read one (Android /
desktop Chrome and Edge use it for their own install prompts); iOS ignores it and relies on the
`apple-mobile-web-app-*` meta tags in `index.html` instead — see
[the "Add to Home Screen" screen](rendering.md#the-add-to-home-screen-screen) for how installing on
iOS actually gets suggested. `netlify.toml` sets `Cache-Control: no-cache`-equivalent headers on
both `/sw.js` and the manifest, the same as `index.html` — they're the other unhashed files a new
deploy can change, and a long-lived CDN or browser cache on the worker script itself would hide
every future update behind it.

Checked in `tools/smoke.mjs` against a built preview: the page has to end up controlled by the
worker, and a reload with the browser's own HTTP cache disabled and the network taken offline still
has to boot the game — disabling the HTTP cache is what makes a pass mean the worker's Cache
Storage actually served it, rather than Chrome's ordinary disk cache papering over a worker that
isn't caching anything.

## Testing hooks

`main.js` exposes `window.__taxi` with `traffic`, `boost`, `skids`, `police`, `fares`, `daylight`,
`routeTo`, `findRoute`, `isSelected`, `flyover`, `chopper`, `flocks` (every park flock, in build order), `clouds` and `redraw`. The headless tools in `tools/` drive the game
through this instead of through the DOM, which is what makes the whole suite run in about a second.

`redraw()` draws one frame on demand. Shot mode never starts the render loop — it warms the sim,
renders once and stops — so a shot poked from the console or over CDP keeps showing the frame it
froze on. That is what makes a frozen framing reviewable at states the shot list doesn't cover: set
a fare's clock, `redraw()`, capture.

`?shot=` puts the app in screenshot mode: it freezes the day/night cycle, hides the HUD, warms the
sim forward to a specific moment (mid-pickup, mid-corridor), then sets `document.body.dataset.shotReady`
for the capture tool to wait on.

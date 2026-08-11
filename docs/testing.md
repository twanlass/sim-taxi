# Testing and iteration

## One command

```bash
npm run check
```

Runs the whole headless suite in **under 20s** and prints one compact summary:

```
ok    modules  all import and construct · sun 0.00→3.84
ok    roadnet  250/250
ok    probe    185/185
ok    routing  30/30
ok    eta      MAE 3.99s  bias -0.14s
ok    fares    p10 7 · median 13 · p90 20
ok    signals  7.16

all green · 26.4s
```

(It was ~1.8s when the suite was four tools and 28 probe assertions. Most of the time now is the
fare soak and the probe, both of which run real sim seconds.)

The point is round trips, not compute. The tools below total well under a second between them, but
running them separately costs four exchanges — so `tools/check.mjs` runs them together and a change
can be made and verified in a single step.

## What each step covers

| Step | Tool | Asserts |
|---|---|---|
| **modules** | inline in `check.mjs` | Every browser-only module imports *and constructs* in node, and a full simulated day swings the sun from 0.00 to >3 |
| **roadnet** | `tools/roadnet.mjs` | The road network reproduces the grid at 1e-9 — positions, lanes, turns, legal moves, signal phase across a cycle — plus diagonals, roundabouts and curves the grid can't express. Runs first: it is the control on every step below |
| **probe** | `tools/probe.mjs` | Traffic invariants: no car in a park, no car off-map, no signal violations, all 5,184 (approach, destination) pairs routable, front wheels locked through corners and straight on the straight |
| **routing** | `tools/taxi.mjs 30` | Given a target, the routed taxi actually **arrives** — while still stopping at every red |
| **eta** | `tools/eta.mjs 40 3` | Fits and grades the trip-time estimator every fare deadline is budgeted from. Runs before the soak: a drifted estimator makes the soak's numbers a measurement of the drift |
| **fares** | `tools/soak.mjs 25 4 9` | Auto-plays the fare loop over **9 cities × 9 situations** with a fixed "player reaction" delay, and gates on a **band** around the median |
| **signals** | `tools/signals.mjs` | Throughput, stationary fraction, green-wave hit rate. Informational — it reports rather than fails |

`taxi.mjs` is the assertion that matters most and the one **no screenshot can make**.

`soak.mjs` is the difficulty gauge. A perfect player is *meant* to lose eventually, so it does not
gate on "never fails" — it gates on the median run landing inside a **band**. The lower bound is the
old one, a run so short the loop never got going. The upper bound is newer and catches the failure
nothing used to: a difficulty system is broken by being too easy exactly as readily as by being too
hard, and a median that climbs out of the top means the ramp has stopped biting.

It reports a distribution rather than a single number, because what is being tuned is the *shape* of
the survival curve — p10 is the "did anyone die during the tutorial" number and a median hides it.
It also reports how much of its budget the average fare ate, bucketed along the ramp, which is the
direct read on whether the ramp is ramping: 50% → 56% → 73% → 87% is what the shipped curve does.

`difficulty-sweep.mjs` is what the numbers in [difficulty.md](difficulty.md#what-the-sweep-found)
came from. It plays the same cities and situations through several tunings at three reaction times,
so the comparison is paired. Both drive `tools/autoplay.mjs`, which holds the perfect-player harness
— a copied harness is one that drifts, and the sweep only means anything if it is playing the same
game the soak gates on.

**It sweeps seeds, and that is the point.** A single run is trip-length luck more than it is
difficulty: one corner-to-corner fare eats 40s against a 17s average, and on some seeds even a
perfect player loses the very first fare. Tuning against one seed is tuning against noise — it is
how a 30% harder game once measured as a 75% harder one, and how a one-seed gate stayed green on
luck rather than on merit.

The module-construction step exists because a scope slip in `scene.js` once shipped undetected —
nothing headless imported it. Anything browser-only belongs in that file's `BOOT` list.

## Other tools

```bash
node tools/roadnet.mjs 40                     # road-network equivalence over 40 city seeds
node tools/probe.mjs                          # individually, for detail on a failure
node tools/taxi.mjs 60                        # more trials
node tools/soak.mjs 40 3 20                   # 40 fares, 3s reaction, 20 runs
node tools/soak.mjs 25 4 15 71624 103300      # ...and pin the city, to compare two builds on one map
node tools/eta.mjs 100 6                      # refit the trip-time estimator over 6 cities
node tools/difficulty-sweep.mjs 9 slack       # sweep a difficulty preset: slack, board, gap, shape
node tools/signals.mjs                        # signal metrics, incl. cycle-length sweeps
node tools/roadwork-pull.mjs                  # how often a run actually meets the construction zone
node tools/diag.mjs                           # ad-hoc scratch diagnostics
node tools/smoke.mjs --url http://localhost:4173   # real browser, real DOM
./shots.sh                                    # render the screenshot set
```

`roadwork-pull.mjs` is deliberately **not** in `npm run check`. What it measures is a distribution —
the share of runs in which the taxi is routed through the closed street — and the honest assertion
("most players meet it") is a percentage with real variance across seeds. A suite that gates on one
goes red for reasons nobody can act on. What it produced instead are the invariants that *are*
crisp, and those are in `probe.mjs`: that the discount reaches the router at all, that it never
lengthens a route by more than a leg, and that an aimed drop-off lands on the zone or falls back
cleanly. The percentages live in the comments they justify — `EDGE_COST.roadwork` in `route.js` and
the table in [traffic.md](traffic.md#getting-the-player-there).

## Screenshots

`shots.sh` / `tools/shoot.mjs` drive headless Chrome over CDP. `?shot=<name>` puts the app in
screenshot mode: the HUD hides, the day/night cycle freezes, the sim warms forward to a chosen
moment (mid-pickup, mid-corridor, framed on the rider), and then `document.body.dataset.shotReady`
is set for the capture to wait on.

Rendering costs about **2s per shot** against ~1s for the entire assertion suite, so screenshots
are for *looking at* the game, not for verifying it.

Shot 11 (`busy`) pins the difficulty curve at its top (`difficulty: 1` on the preset) and auto-plays
the fare loop until the board is full, so a four-fare late-game board can be looked at without
playing ten fares to reach it. It exists because "can you read this board" is the one question a
screenshot answers better than an assertion — and because the board was capped at three for years
on a readability judgement made against a marker that no longer exists.

Shot 9 (`route-far`) is the odd one out: instead of routing at whichever fare the seed produced — often
two blocks away, where the route band's two end fades meet in the middle and show you nothing — it
sends the taxi to the **opposite corner of the map**, so a full-length band with several turns is
in frame.

Shot 12 (`wreck`) is the other exception, and for the opposite reason: everything else in the game
has a steady state to point a camera at, and the crash does not — it fires once, ends the run and is
over in about a second and a half. So the shot **stages a real one**: the taxi is parked on an
ambient car with boost on, `collisions.update()` detonates it through the same handler a live run
uses, and then only the blast and the two shrinking shells are stepped forward, to `wreckAt`
seconds. Traffic is deliberately *not* stepped with them — the rest of the city driving on under a
frozen wreck is a different picture. Driving the real path rather than firing the effects by hand is
what stops the framing drifting away from the thing it exists to review; move `wreckAt` to look at a
different beat of the explosion (0.08 is the flash, 0.22 the peak, 0.9 the embers).

Shot 17 (`wreck-smoke`) is the same staging one second later, and it exists because shot 12 answers
only half the question now. The wreck's [smoke collar](rendering.md#the-smoke-collar) is thrown
outward and is at its most legible once it has travelled — by which time the fireball shot 12 is
framed on has gone out entirely. At `wreckAt` 1.15 the fire is a couple of frames dead and the
smoke is what is left, which is what the player is actually looking at while the retry banner comes
up. The dust pool is stepped alongside the blast in this staging; left out, the collar would freeze
stacked on the impact point at zero age.

Shot 13 (`flyover`) has the wreck's problem without the wreck's drama: the
[ambient plane](rendering.md#the-flyover--gameflyoverjs) is up for six seconds every minute or so,
so there is nothing to point a camera at unless one is staged. It launches a flight, steps it
`flyoverAt` seconds forward, and then **aims at the aeroplane** rather than at the middle of the
map — the heading and the sideways offset of the flight line both come off the run seed, so a
fixed target frames it by luck or not at all. The aim is taken along `VIEW_DIR` rather than
straight down: the camera targets a point on the *ground*, and an orthographic camera projects
everything along the view axis to the same place, so the ground point that shares the aeroplane's
screen position is its own position slid back down that axis to y = 0. Aiming at the point
underneath it instead puts it 33 units off the top of a close framing, which is exactly what the
first attempt did.

A flyover never appears in any *other* shot, and that is structural rather than lucky: shot mode
never starts the frame loop, so nothing ever calls `flyover.update()` outside this one preset.

Both browser tools take the same two env overrides, for boxes that aren't a Mac desktop:

```bash
CHROME=/opt/pw-browsers/chromium CHROME_FLAGS=--no-sandbox node tools/shoot.mjs --url http://localhost:4173
```

`--url` may carry query params of its own — `--url 'http://localhost:4173/?run=7'` picks which
situation gets shot, since `?shot=` is merged in rather than concatenated. `?blend=<name>` pins the
route band's blend mode the same way, which is the only way to shoot it: the ⚙️ panel that switches
it live doesn't exist in shot mode. `?ao=off` does the same for
[ambient occlusion](rendering.md#ambient-occlusion--gamessaojs), which is what makes an A/B pair
out of one URL — it is a build-time switch, so it cannot be toggled after load either.

The AO pass is safe to shoot through: its taps are fixed rather than jittered, so it adds nothing
non-deterministic to a frozen frame. It does change every reference shot once, being new.

## When a device renders nothing

A phone came up **black**: no city, no sky, no markers — and the page underneath it working
perfectly. The HUD counted, the tutorial talked, its spotlight tracked a taxi nobody could see.
Nothing in the toolbox above reaches that. `npm run check` passes, because the failure is not in
any of the logic it asserts; a screenshot from this machine is a picture of this machine's GPU.

**The failure is silent by construction.** Three of the ways a WebGL page stops producing pixels
throw nothing at all:

| What happened | What three does | What you see |
|---|---|---|
| Context lost (memory pressure, driver reset, the OS reclaiming the GPU) | `console.log('THREE.WebGLRenderer: Context Lost.')`, sets a flag, every later `render()` returns immediately | black |
| A shader the driver refuses to compile | `console.error('THREE.WebGLProgram: Shader Error …')`, carries on | that material missing |
| No context could be created | `console.error`, from `webglcontextcreationerror` | black |

So `index.html`'s error overlay never opened — it only listens for `error` and
`unhandledrejection`, and none of the above is either. Three legs were added for this:

**1. Three's own reports are mirrored onto the screen.** An inline script in `index.html`, ahead
of the module so it catches a context-creation failure mid-evaluation, wraps `console.log/warn/
error` and copies the messages above into the `#error` panel. It is an **allow-list, not a
`THREE.` prefix match**: that panel covers the whole screen, and three writes plenty of benign
prefixed warnings that would turn a working build into a broken-looking one.
`Context Restored.` takes the panel back down.

**2. `?diag`** puts [the renderer readout](rendering.md#the-renderer-readout--gamediagjs) in the
bottom-left corner: the GPU's own name, what the context was *granted* as opposed to asked for,
whether the context is alive, how many draw calls the frame just made, and `mid` — one pixel read
back out of the frame that is supposedly on screen, which is what separates "drew nothing" from
"drew the city and never presented it".

**3. `?safe` and the budget flags** let the renderer be turned down from the address bar, on the
device, with no rebuild. Each drops one of the four things this page asks a GPU for that a plain
three.js page does not:

```
?msaa=off        the multisampled back buffer — the largest single allocation at DPR 2
?shadows=off     the sun's 2048² shadow map (?shadows=1024 for a quarter of it)
?dpr=1           the drawing buffer itself, quartered
?ao=off          the depth prepass, its two render targets, and the patch on every material
?safe            all four at their cheapest, in one load
```

`?safe` is a **playable** configuration rather than a diagnostic one — a device that only works
this way can still be played this way. Every flag overrides it, so `?safe&msaa=on` bisects upward
exactly as `?msaa=off` bisects down, and the flags reach the tutorial avatar's renderer and the
rider-finder chips' too: each of those opens a WebGL context of its own, and "how many contexts is
this page holding" is part of what `?safe` is asking.

**Android defaults to it**, as a holding measure — see below. The consequence for bisecting is
that a bare `?msaa=off` on an Android device tells you nothing, because the other three are
already off: reach for **`?safe=off`** first and bisect down from the full budget
(`?safe=off&msaa=off`, and so on). Desktop and iOS are unaffected and bisect either way.

The order to try them in is the order of what they rule out. `?diag` first — it answers *which
kind* of failure this is before anything is changed, and `ctx LOST`, `calls 0`, `calls 40` with a
black `mid`, and `calls 40` with a *sky-blue* `mid` are four different investigations. Then
`?safe`, which is the one load that says whether the device will render this scene at all.

### What the first one turned out to be

`?diag` on the reporting device, in one screenshot:

```
ANGLE (Imagination Technologies, PowerVR D-Series DXT-48-1536, OpenGL ES 3.2)
webgl2 · aa yes (4x) · stencil yes (8b)
depth 24b · maxtex 8192 · vary 15 · funif 1024 · tex 24
flags msaa=on shadows=2048 dpr=2 ao=on
ctx LOST · calls 37 (stale) · tris 22969 · progs 27
822x1520 @2.625 · 60fps · mid --
```

`THREE.WebGLRenderer: Context Lost.` three times over, and the city visibly rendering for about a
second between each. **A context-loss loop**, not a rendering bug: 37 draw calls and 23k triangles
say the scene was fine right up to the moment the driver reset. The GPU is a PowerVR D-Series —
the Tensor G5 — which is a different vendor from every previous Pixel and a very new driver.

`game/recovery.js` is the answer to the loop itself: turn the budget down rather than leave the
player looking at a black screen. It de-escalates in two steps, split by what a live renderer can
change (pixel ratio, shadow map size) versus what needs a new context and new programs (MSAA, AO).

`?safe` holds on that device. **Which one of the four flags is the trigger is still not known** —
the four single-variable loads have not been run — so Android defaults to the whole reduced budget
in the meantime. That default is deliberately wider than the evidence (one device, not a platform)
and costs real quality on Android phones that were rendering this fine; it is taken because the
failure it avoids is not "slightly soft" but "black screen, no game", and recovery can only climb
*down* from a budget, never up. It should be replaced with whichever single flag turns out to be
responsible. `?safe=off` is the escape hatch that keeps that narrowing possible on the affected
device.

Note `vary 15` — `MAX_VARYING_VECTORS` at the ES spec minimum, against 31 on a desktop. It is not
what caused this (a program over the limit fails to link, and 27 linked), but it is the sort of
headroom this panel exists to show, and it is worth remembering before adding a varying.

### Reading the pair

The first report of this was **Android Chrome, with iOS Chrome on the same build working fine**.
That pair is worth reading carefully rather than as "mobile is broken": iOS Chrome is WebKit, so
it shares nothing below the JavaScript with Android Chrome's Blink and ANGLE-over-GLES. It says
the scene, the shaders as written and the game logic are all fine, and puts the fault in the
bottom half of one browser on one GPU — which is exactly the half none of the headless tools can
reach, and why the panel reports the driver's own strings and limits.

## Working notes

These are the things that have actually cost time on this project:

- **Assertions catch what screenshots can't.** A yaw = −2π deadlock, four separate airport traffic
  bugs, unfair fare deadlines, and cars driving off the map to x = −1064 were all found headlessly
  and would all have looked fine in a still.
- **The real cost is round trips and self-inflicted breakage**, not compute. Batch verification
  into one `npm run check`.
- **Never patch with a blind `s.replace()`.** A no-op replace fails silently and you discover it
  three steps later. Every scripted edit should assert its match and exit on NO MATCH.
- **`vite preview` serves a stale `dist/`.** Rebuild first, or verify against `npm run dev`. This
  has invalidated a verification run before.
- **Check assumptions with a sweep.** "A longer signal cycle will read calmer" was wrong, and one
  parameter sweep showed it immediately (14s → 3.80, 28s → 2.36 throughput).
- **Measure the metric itself.** An early green-wave measurement always read exactly 50% because it
  released phantom cars at random phases — a wave only helps a platoon released *by* a green. The
  metric was broken, not the signals. It was broken **twice more** after that, both times reading
  plausibly the whole while: it walked `i = 0..GRID` along a row whether or not those roads existed,
  driving a phantom platoon straight through a park district; and it looked for its release green at
  `(0, j)`, which is on the ring for every interior `j`, so the condition never fired and every
  platoon in fact departed at `t = 0`. It now walks a *chain* — the network's maximal through-route,
  which stops where the road does — and releases at the first signalised junction the platoon
  actually meets. The number it prints is not comparable to the old one.
- **A sweep has to sweep the thing that varies most.** `soak.mjs` averaged over nine *situations* on
  one *city*, and the city is the larger source of variance: a change that shifted that one city's
  signal offsets moved the median a whole fare, while across six cities the same change was
  invisible. It now rerolls the city per run, the way `main.js` does, connectivity check included.

## Test hook

The tools drive the game through `window.__taxi` (`traffic`, `boost`, `skids`, `police`, `fares`,
`daylight`, `routeTo`, `findRoute`, `isSelected`, `redraw`) rather than through the DOM. That's what
makes the suite fast.

> Shot mode renders **once** and stops — there is no loop behind a frozen shot. Poking the world
> over CDP therefore changes nothing on screen until `__taxi.redraw()` is called, and
> `Page.captureScreenshot` will happily hand back the stale frame with no sign anything is wrong.
> That is how a shader patch that was genuinely broken looked identical to one that worked.

> `tools/smoke.mjs` clicks with synthetic DOM events. CDP's `Input.dispatchMouseEvent` is accepted
> in this headless config but never produces a DOM click, so it tests nothing. The picker, raycast
> and listener are covered; Chrome's OS-level input plumbing is not.

Two things about that tool bit once and are worth keeping in mind when adding to it.

**It targets `body > canvas`, not `canvas`.** Every rider-finder chip carries its own 38px WebGL
canvas, inside `#rider-finder-stack` — which sits *earlier* in the DOM than the game's canvas. Once
a rider was waiting, `querySelector('canvas')` handed back a chip, so every gesture went to a
38-pixel button in the corner. The drag check failed for it; the tap check *passed* for it, because
a click on a chip's canvas bubbles to the chip's button and dispatches the taxi anyway.

**The camera checks emulate a phone.** Drag-to-pan, both follow-cams and the rider peek are all
gated under `NARROW_VIEWPORT = 768`, and the tool launches a 900px window — so the drag check was
asserting a feature that is deliberately switched off there. That half of the run now flips to a
390×844 viewport with `Emulation.setDeviceMetricsOverride` first.

A third is about reading state back: anything asserted *at the instant of* an input has to be
gathered inside a single `Runtime.evaluate`, with no `await` in the middle. Split across round
trips the page renders in between — long enough that a pan reads as having already jumped, which is
precisely the bug that check exists to catch.

**The offline check only means anything against a built preview.** The service worker registration
in `main.js` is skipped under `npm run dev` on purpose — see
[architecture.md](architecture.md#installability-and-offline-support) — so run this tool with
`--url http://localhost:4173` (or the deployed site), not against the dev server. The check disables
Chrome's own HTTP cache before going offline, which is what makes a pass mean the worker's Cache
Storage actually served the reload rather than the browser's ordinary disk cache quietly covering
for a worker that isn't caching anything.

**The Home Screen screen is checked here for want of anywhere better.** It is a user-agent test
([rendering.md](rendering.md#the-add-to-home-screen-screen)), so nothing in the node suite can see
it — and it is invisible on every machine the game is developed on, which is exactly how a broken
condition ships. The run opens a *second* page under an emulated iPhone, because the emulation has
to be in place before the navigation. Five things are asserted there, and the one that is easy to
get subtly wrong is worth naming: that the steps read back **More → Share → Add to Home Screen, in
that order**. Naming a first tap that isn't on the player's screen sends them hunting for a button
that doesn't exist, and a wrong list renders perfectly well, so only a check that reads the labels
catches it.

The rest: it shows under an iPhone user-agent and not otherwise, it returns after a reload (nothing
is remembered, so a dismissal that persisted would be the bug), and the run hold — no fare may exist
while the screen is up, and one must appear once it is dismissed. That second half matters as much
as the first: a hold that is never released is a game that never starts.

# Testing and iteration

## One command

```bash
npm run check
```

Runs the whole headless suite and prints one compact summary:

```
ok    modules  all import and construct · sun 0.00→3.84 · moon 1.00
ok    probe    95/95
ok    routing  30/30
ok    fares    6/25
ok    signals  7.05
ok    sky      31/31

all green · 1.8s
```

The point is round trips, not compute. The tools below total well under a second between them on
the machine this was tuned on, but running them separately costs five exchanges — so
`tools/check.mjs` runs them together and a change can be made and verified in a single step.

## What each step covers

| Step | Tool | Asserts |
|---|---|---|
| **modules** | inline in `check.mjs` | Every browser-only module imports *and constructs* in node, and a full simulated day swings the sun from 0.00 to >3 |
| **probe** | `tools/probe.mjs` | Traffic invariants: no car in a park, no car off-map, no signal violations, all 5,184 (approach, destination) pairs routable, front wheels locked through corners and straight on the straight |
| **routing** | `tools/taxi.mjs 30` | Given a target, the routed taxi actually **arrives** — while still stopping at every red |
| **fares** | `tools/soak.mjs 25 4 9` | Auto-plays the fare loop over **9 run seeds** with a fixed "player reaction" delay, and gates on the median |
| **signals** | `tools/signals.mjs` | Throughput, stationary fraction, green-wave hit rate. Informational — it reports rather than fails |
| **sky** | `tools/sky.mjs` | The day/night curve, the weather director, the visibility floor, and everything the two of them switch on and off |

`taxi.mjs` is the assertion that matters most and the one **no screenshot can make**.

`sky.mjs` is the other one. It asks a different kind of question from `probe.mjs`: not "is the
simulation correct" but "**is the game still playable to look at**". The floor check is the one
that earns its keep — every darkening influence in the game is a multiplier, night × overcast ×
fog is three of them, and the only reason that combination can't black the city out is a single
clamp in `daylight.js`. It sweeps all 24 hours against all five kinds of weather and asserts the
total never drops under it, that there is always a light with a *direction* to it, and that no dark
hour is left with the city's own lights still down.

It also caught two bugs a screenshot would have shown but not explained, and one it would never
have shown at all:

- The moon was placed opposite the sun, where a moon belongs, and lit every building face the fixed
  camera cannot see. It is asserted as a **direction** against the visible face normals now, not as
  an elevation angle — the angle was never the thing that was wrong.
- The weather's hold timer was never re-armed, so every change ran straight into the next. The pace
  check is a **range**, not a floor: too few changes means it parked, too many means the hold isn't
  holding.
- The headlight rigs ride an upright node so a car leaning into a corner doesn't swing its beam
  under the road. `sky.mjs` asserts every rig is level and on its car, which is invisible in a still
  until the frame it is wrong in.

`soak.mjs` is the difficulty gauge. One flat clock covering both legs means a perfect player is
*meant* to lose eventually, so it does not gate on "never fails" — it gates on the median run being
long enough that the loop got going at all.

**It sweeps seeds, and that is the point.** A single run is trip-length luck more than it is
difficulty: one corner-to-corner fare eats 40s against a 17s average, and on some seeds even a
perfect player loses the very first fare. Tuning against one seed is tuning against noise — it is
how a 30% harder game once measured as a 75% harder one, and how a one-seed gate stayed green on
luck rather than on merit.

The module-construction step exists because a scope slip in `scene.js` once shipped undetected —
nothing headless imported it. Anything browser-only belongs in that file's `BOOT` list.

## Other tools

```bash
node tools/probe.mjs                          # individually, for detail on a failure
node tools/taxi.mjs 60                        # more trials
node tools/soak.mjs 40 3 20                   # 40 fares, 3s reaction, 20 run seeds
node tools/signals.mjs                        # signal metrics, incl. cycle-length sweeps
node tools/diag.mjs                           # ad-hoc scratch diagnostics
node tools/smoke.mjs --url http://localhost:4173   # real browser, real DOM
./shots.sh                                    # render the screenshot set
```

## Screenshots

`shots.sh` / `tools/shoot.mjs` drive headless Chrome over CDP. `?shot=<name>` puts the app in
screenshot mode: the HUD hides, **both** the day/night and weather clocks freeze, the sim warms
forward to a chosen moment (mid-pickup, mid-corridor, framed on the rider), and then
`document.body.dataset.shotReady` is set for the capture to wait on.

Shots 10–16 are the night and weather framings, and each pins an `hour` *and* a `weather`: the
whole point of layering weather on the day cycle is that rain at 1am and rain at noon are different
frames, so a shot that pinned only one of the two would be showing half a thing.

Rendering costs about **2s per shot** against ~1s for the entire assertion suite, so screenshots
are for *looking at* the game, not for verifying it.

Shot 9 (`route-far`) is the odd one out: instead of routing at whichever fare the seed produced — often
two blocks away, where the route band's two end fades meet in the middle and show you nothing — it
sends the taxi to the **opposite corner of the map**, so a full-length band with several turns is
in frame.

Both browser tools take the same two env overrides, for boxes that aren't a Mac desktop:

```bash
CHROME=/opt/pw-browsers/chromium CHROME_FLAGS=--no-sandbox node tools/shoot.mjs --url http://localhost:4173
```

`--url` may carry query params of its own — `--url 'http://localhost:4173/?run=7'` picks which
situation gets shot, since `?shot=` is merged in rather than concatenated. `?blend=<name>` pins the
route band's blend mode the same way, and `?hour=` / `?weather=` pin the sky, which is the only way
to shoot any of them: the ⚙️ panel that switches them live doesn't exist in shot mode.

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
  metric was broken, not the signals.

## Test hook

The tools drive the game through `window.__taxi` (`traffic`, `boost`, `skids`, `police`, `fares`,
`daylight`, `weather`, `nightLights`, `routeTo`, `findRoute`, `isSelected`) rather than through the
DOM. That's what makes the suite fast.

> `tools/smoke.mjs` clicks with synthetic DOM events. CDP's `Input.dispatchMouseEvent` is accepted
> in this headless config but never produces a DOM click, so it tests nothing. The picker, raycast
> and listener are covered; Chrome's OS-level input plumbing is not.

> It dispatches them at **`body > canvas`**, not `canvas`. Every rider-finder chip owns a WebGL
> renderer of its own, and `#rider-finder-stack` is in the static HTML — so its canvases come
> *earlier* in document order than the game's, which `main.js` appends to the body at boot. A bare
> `querySelector('canvas')` therefore starts returning a 38px chip the moment a fare is waiting,
> and every click in the test lands on that instead of on the game: the picker's listener never
> fires at all. It presented as flakiness, because it depended on whether a chip existed yet when
> the click went out.

> **Known failure:** `dragging pans the camera` fails in this harness. Drag-to-pan is gated to
> viewports under `NARROW_VIEWPORT = 768px` (on a desktop the whole city is already in frame and
> panning would only slide the map for no reason), and the harness window is 900px wide. The test
> would need to size the viewport before it could pass.

# Testing and iteration

## One command

```bash
npm run check
```

Runs the whole headless suite in **under 20s** and prints one compact summary:

```
ok    modules  all import and construct · sun 0.00→3.84
ok    roadnet  250/250
ok    probe    111/111
ok    routing  30/30
ok    fares    3/25 median
ok    signals  7.16

all green · 18.4s
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
| **fares** | `tools/soak.mjs 25 4 9` | Auto-plays the fare loop over **9 cities × 9 situations** with a fixed "player reaction" delay, and gates on the median |
| **signals** | `tools/signals.mjs` | Throughput, stationary fraction, green-wave hit rate. Informational — it reports rather than fails |

`taxi.mjs` is the assertion that matters most and the one **no screenshot can make**.

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
node tools/roadnet.mjs 40                     # road-network equivalence over 40 city seeds
node tools/probe.mjs                          # individually, for detail on a failure
node tools/taxi.mjs 60                        # more trials
node tools/soak.mjs 40 3 20                   # 40 fares, 3s reaction, 20 runs
node tools/soak.mjs 25 4 15 71624 103300      # ...and pin the city, to compare two builds on one map
node tools/signals.mjs                        # signal metrics, incl. cycle-length sweeps
node tools/diag.mjs                           # ad-hoc scratch diagnostics
node tools/smoke.mjs --url http://localhost:4173   # real browser, real DOM
./shots.sh                                    # render the screenshot set
```

## Screenshots

`shots.sh` / `tools/shoot.mjs` drive headless Chrome over CDP. `?shot=<name>` puts the app in
screenshot mode: the HUD hides, the day/night cycle freezes, the sim warms forward to a chosen
moment (mid-pickup, mid-corridor, framed on the rider), and then `document.body.dataset.shotReady`
is set for the capture to wait on.

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
route band's blend mode the same way, which is the only way to shoot it: the ⚙️ panel that switches
it live doesn't exist in shot mode.

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
`daylight`, `routeTo`, `findRoute`, `isSelected`) rather than through the DOM. That's what makes
the suite fast.

> `tools/smoke.mjs` clicks with synthetic DOM events. CDP's `Input.dispatchMouseEvent` is accepted
> in this headless config but never produces a DOM click, so it tests nothing. The picker, raycast
> and listener are covered; Chrome's OS-level input plumbing is not.

Two things about that tool bit once and are worth keeping in mind when adding to it.

**It targets `body > canvas`, not `canvas`.** Every rider-finder chip carries its own 38px WebGL
canvas, inside `#rider-finder-stack` — which sits *earlier* in the DOM than the game's canvas. Once
a rider was waiting, `querySelector('canvas')` handed back a chip, so every gesture went to a
38-pixel button in the corner. The drag check failed for it; the tap check *passed* for it, because
a click on a chip's canvas bubbles to the chip's button and dispatches the taxi anyway.

**The camera checks emulate a phone.** Drag-to-pan, both follow-cams and the rider pan are all
gated under `NARROW_VIEWPORT = 768`, and the tool launches a 900px window — so the drag check was
asserting a feature that is deliberately switched off there. That half of the run now flips to a
390×844 viewport with `Emulation.setDeviceMetricsOverride` first.

A third is about reading state back: anything asserted *at the instant of* an input has to be
gathered inside a single `Runtime.evaluate`, with no `await` in the middle. Split across round
trips the page renders in between — long enough that a pan reads as having already jumped, which is
precisely the bug that check exists to catch.

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

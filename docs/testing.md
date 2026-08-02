# Testing and iteration

## One command

```bash
npm run check
```

Runs the whole headless suite in **~1.8s** and prints one compact summary:

```
ok    modules  all import and construct · sun 0.00→3.84
ok    probe    28/28
ok    routing  30/30
ok    fares    6/25
ok    signals  7.05

all green · 1.8s
```

The point is round trips, not compute. The tools below total well under a second between them, but
running them separately costs four exchanges — so `tools/check.mjs` runs them together and a change
can be made and verified in a single step.

## What each step covers

| Step | Tool | Asserts |
|---|---|---|
| **modules** | inline in `check.mjs` | Every browser-only module imports *and constructs* in node, and a full simulated day swings the sun from 0.00 to >3 |
| **probe** | `tools/probe.mjs` | Traffic invariants: no car in a park, no car off-map, no signal violations, all 5,184 (approach, destination) pairs routable |
| **routing** | `tools/taxi.mjs 30` | Given a target, the routed taxi actually **arrives** — while still stopping at every red |
| **fares** | `tools/soak.mjs 25 4` | Auto-plays the fare loop with a fixed "player reaction" delay |
| **signals** | `tools/signals.mjs` | Throughput, stationary fraction, green-wave hit rate. Informational — it reports rather than fails |

`taxi.mjs` is the assertion that matters most and the one **no screenshot can make**. `soak.mjs`
is the fairness check: if a perfect player with a fixed reaction delay ever fails on a timer, the
deadline formula is unfair, because a real player is strictly slower.

The module-construction step exists because a scope slip in `scene.js` once shipped undetected —
nothing headless imported it. Anything browser-only belongs in that file's `BOOT` list.

## Other tools

```bash
node tools/probe.mjs                          # individually, for detail on a failure
node tools/taxi.mjs 60                        # more trials
node tools/soak.mjs 40 3                      # 40 fares, 3s reaction delay
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
`daylight`, `routeTo`, `findRoute`, `isSelected`) rather than through the DOM. That's what makes
the suite fast.

> `tools/smoke.mjs` clicks with synthetic DOM events. CDP's `Input.dispatchMouseEvent` is accepted
> in this headless config but never produces a DOM click, so it tests nothing. The picker, raycast
> and listener are covered; Chrome's OS-level input plumbing is not.

# The passing lab

**`/lab/` — a workbench, not part of the game.** Nothing in the game links to it and the game does
not import a line of it.

One straight road with no traffic lights, a taxi, and a car in front of it. Loco Mode is held down
and the tank never empties, so [the overtake](traffic.md#overtaking) can be watched over and over
without playing a run to earn the fuel, hunting for a straightaway, and hoping a car turns up on it
at the right distance.

```
npm run dev            # then open http://localhost:5173/lab/
```

| File | What it owns |
|---|---|
| `lab/index.html` | the page — the knobs, the pill, the readout |
| `src/lab/passing.js` | the app: staging, the frame loop, the camera, the reset |
| `src/lab/labroad.js` | the road, as a network, and the ground under it |
| `tools/lab.mjs` | the headless checks, in `npm run check` |

## The road

Ten blocks at the city's own `PITCH`, so 200 units end to end: twelve-unit lanes with eight-unit
junction boxes between them, which is the shipped ring road's geometry to the decimal.

It is a **real road network**, baked through `bakeNetwork` exactly as the city is. That matters more
than it sounds: the point of the lab is to watch the shipped traffic model, and a hand-faked lane
would be watching something else. [`city/roadnet.js`](roadnet.md) was written to take nodes and
edges at arbitrary positions and *derive* lanes, turns and signal phases from them, so a straight
chain of nodes is a legal city — just a very boring one.

**There are no traffic lights, and that is not a special case.** `bakeSignals` gives a node a signal
only when it has more than one *street* to arbitrate between, and a street is a pair of arms that
carry on through the junction. Every interior node here has exactly two arms pointing exactly
opposite each other, so they pair into one street and the node comes out `signal === null` — the
same branch a park closure leaves an interior junction on in the real city. Nothing asks for the
lights to be switched off; there is simply never anything to arbitrate.

The east end is a dead end: its last lane has no legal exit, so the sim holds cars at the line
there, which is correct and dull. The lab re-stages sixteen units short of it instead, so holding
the button just runs the scenario again.

**Why 200 units and not more.** A pass is ~27 units of road on its own, the run-up from cruise to
`PASS_TRIGGER` behind a cruising leader is another ~40, and the [overdrive
band](traffic.md#overdrive-only-on-a-straightaway) wants 40 units of unbroken straight before it is
reachable at all. 200 fits all three with room to watch the taxi settle back into lane afterwards —
and stays inside the sun's shadow frustum, which covers ±`SPAN * 1.05` = ±105 (`game/scene.js`). A
longer road would lose its shadows at the ends, which is a strange thing for a lab about how
something *looks* to give up.

The verges are 150 units of grass either side and the asphalt runs 160 past each end. Those numbers
are derived, not eyeballed, and the first pass eyeballed 60 and put the edge of the world in the
corner of the very first screenshot: the 3/4 camera maps *both* screen axes onto world z (see
`game/camera.js`), so the corner of the frame is the worst case — at `LAB_MAX_ZOOM` on a wide
monitor that is ~110 units off the road. Being reliably off-screen is what lets the lab ground skip
the city's `asphaltFade` skirt entirely.

Trees come from `city/props.js` unchanged, planted on verge strips shaped as blocks. They are not
decoration: on bare asphalt a car at cruise and a car in overdrive look about the same, and roadside
parallax is the only thing in frame that says how fast the taxi is actually going.

## What is not the game

Three departures, all so a scenario can be run twice.

- **The tank is bottomless.** `boost.state.fuel` is pinned full every frame rather than topped up
  through `topUp()`, which queues fuel to *pour* in over ~0.7s and lights the pill's
  delivery-reward flutter while it does — right in the game, a strobe here.
- **A wreck doesn't consume the taxi.** The game hands both shells to `game/vanish.js`, which says
  up front that it never restores anything: a wreck ends the run and Retry reloads the page. The lab
  resets in place a beat later, and leaves the taxi standing where it stopped — in a lab the useful
  thing about a wreck is *where it happened*. The car it hit still gets the full treatment, since
  that one is re-staged from the pool anyway.
- **The taxi is handed a route.** The overtake is only offered where the taxi's route carries
  straight on through the junction ahead — `room` in `traffic.js` reads `route[0] === car.d`, which
  is what stops the game pulling out on the approach to a corner it is about to take. A lab taxi has
  no fares to route it, so the road's only exit is fed back as a route each frame. On this network
  "straight on" is the sole legal move anyway, so that asserts what the sim would have rolled rather
  than steering it.

Everything else — the pass, the weave, the scatter, the tailgate at `BOOST_GAP`, both gates on when
pulling out is allowed — is `sim/traffic.js` driving `traffic.taxi` exactly as `main.js` does. **If
the taxi behaves differently here than it does in the game, that is a bug in the lab.**

## The knobs

Sliders on the page, or query parameters, and both re-stage on change. `R` resets, `Space` or the
pill boosts, `P` freezes the sim while continuing to draw, and the wheel zooms.

`P` earns its place: the manoeuvre this page exists for takes about half a second at the overdrive
top, which is not long enough to look at the thing you came to look at — the crab angle at the
midpoint, how far the body is leaning, where the rubber went.

| | `?param=` | Default | |
|---|---|---|---|
| Cars ahead | `ahead` | 1 | a queue one gap apart, so passing the first puts you on the run-up to the next |
| Gap | `gap` | 22 | comfortably outside `PASS_TRIGGER` (10), so the run-up is part of what you watch |
| Oncoming | `oncoming` | 0 | spread down the other carriageway. `PASS_SIGHT` (35 units) decides whether the taxi pulls out with one in view — that gate is the whole reason this slider exists |
| Seed | `seed` | random | paint colours and the tree scatter; the manoeuvre itself is deterministic |

The pool is allocated once — an `InstancedMesh` cannot be resized — so the sliders top out at three
each and cars the current setting doesn't want are collapsed to zero scale rather than removed.

**The readout reports the gap it actually got, not the one the slider asked for.** Cars are staged
in world x rather than by walking arc length along the chain, because the gap is a distance between
two cars on different lanes and walking it costs the junction's own 8 units at every boundary — the
first version quietly turned a requested 22 into 28. The one place world x isn't a legal position is
*inside* a junction box, which no lane position can express, so a car that lands in one is clamped
to the nearer end of its block: up to `HALF_ROAD` out, and the readout is what tells you.

## What to look at

The numbers behind all of this are in [traffic.md](traffic.md#overtaking); the lab is where you find
out whether they feel right.

- **The run-up.** `BOOST_ACCEL` to 18.7 u/s, then `OVERDRIVE_ACCEL` grinding out the last 4.25 over
  40 units of straight. The readout shows both, in mph.
- **Scatter.** The car in front floors it to 2.0× cruise with the taxi behind it. It no longer keeps
  the taxi out of `PASS_TRIGGER` — that was the wall-following bug — but it is still the reason the
  approach takes the road it does, and it is much easier to watch here than in traffic.
- **The commitment.** `PASS_FADE` is 10 units of road for a full 2·`LANE` lane change, smoothstepped.
  Watch the yaw: the offset is a function of distance, so its slope *is* the steering angle, and
  easing the offset is what eases the steering. Freeze it with `P` at the midpoint to see the crab.
- **The bank.** Driven by the offset's *curvature*, so the body rolls one way as the car is thrown
  out of its lane and the other as it settles — and mirrors that coming home. Two rocks per pass.
- **The rubber.** Laid across both lane changes and nowhere in between, because the taxi is only
  sliding while it is actually moving sideways.
- **Letting go mid-pass.** Releasing the button is a real abort — it is the one rule in `traffic.js`
  that reads `boost && !boostEasing` rather than `car.boost`, because it is an input rather than a
  hazard.

## What it found on its first day

Worth recording, because it is the argument for the lab existing at all: the very first session with
it turned up **the taxi rear-ending the car in front on 27% of approaches** — a crash better than
one in four, where the reported symptom was simply "it only passes about a third of the time".

Two bugs, both in `sim/traffic.js`, neither visible in the city:

1. **A car crossing a junction had no following distance at all.** Ambient traffic never showed it,
   because a car crosses at cruise and its target while crossing *is* cruise, so it cannot gain on
   anyone. A boosting taxi enters slow — it has been tailgating at `BOOST_GAP` — and then floors it
   to the overdrive top across the 8 units of junction with the brake absent, closing three units on
   a car it can see the whole way. Every one of the 43 crashes had `pass` still at 0.00: the taxi
   never got as far as pulling out.
2. **A leader carrying straight on through a junction was treated as "already turning"** and refused
   as a thing to pass. `car.state === 'turn'` covers every junction transition including going
   straight on — the trap this codebase warns about in three places — and on a 20-unit grid that is
   40% of the time, which is exactly the 40% in which the taxi is tailgating hard enough to want to
   pull out.

Fixed, the same 160 staged approaches go **117 passes / 43 wrecks → 148 / 12**.

Then the second session, on the follow-up complaint that the taxi "stutters on the approach — it
brakes instead of blasting by", turned up three more, and they are the ones that mattered:

3. **The following rule treated a moving car as a wall.** `sqrt(2·BRAKE·room)` is the speed you can
   still *stop* from, which is the wrong question about something driving away from you. It settled
   the taxi 17.6 units behind a fleeing car — outside `PASS_TRIGGER`, so the pass was never offered
   — and made the gap speed-dependent enough to produce the stutter directly.
4. **The car in front was stuttering too**, because the mid-turn branch computed its cruise ceiling
   from a bare `SPEED` and dropped a fleeing car from 17 to 8.5 at every junction.
5. **The lane change froze mid-junction**, parking the taxi on the centreline — the worst place on
   the road — for the whole 8 units of every crossing a pass spanned. That hole in the middle of the
   ramp was most of what read as "angular".

All five are in [traffic.md](traffic.md#a-moving-leader-is-not-a-wall), with the numbers. Two of the
fixes are worth reading before touching them, because the *obvious* version of each destroys the
mode — measured, in both cases, at 4 passes out of 160.

None of them would have been found in the game. In the city the taxi is rarely tailgating at the
moment it reaches a junction — scatter usually clears the lane first — so the failures read as "Loco
Mode is dangerous", which it is supposed to be. It takes a road that is nothing but straight, and
one car that will not get out of the way, to turn a rare wreck into the default outcome. What the
same changes did to the city, eight seeds with the button held for a whole run:

| | before | after |
|---|---|---|
| ground covered, `?cars=22` | 18.07 u/s | **19.15** |
| wreck every, `?cars=22` | 8.0s | **9.6s** |
| overtakes | **0.0** / min | **0.8** / min |
| crawling under 12 u/s | 7.4% of frames | **1.2%** |

## Checked headlessly

`tools/lab.mjs`, in `npm run check`. Nothing else imports `src/lab/`, so without it the one page in
the project whose entire job is to be looked at could stop working silently.

It asserts the world is what it claims — one straight chain, no signals anywhere, city lane offsets,
every junction movement a straight-through — and then that the scenario resolves: a taxi staged
behind a cruising leader with the button held reaches the overdrive band, commits the whole lane,
gets past, tucks back in, and never comes inside the 2.31-unit collision envelope.

It also checks the *shape* rather than only the outcome: that the lane change never stalls half way
across, that the crab angle is eased into rather than snapped to, that the body banks over **and**
back, and that rubber covers the meat of both changes. Each of those is a bug that shipped.

Then it runs the scenario **130 times**, over gap × starting position, and gates on the rates: at
least 85% get past, no more than 12% rear-end, none may park half way across the road, and — the one
a crash counter would miss — *none* may end with the taxi neither passing nor hitting anything. That
last check is the guard on the two fixes that were tried and thrown out: braking on the full
stopping-distance curve behind a fleeing leader stops the crashes by never closing to `PASS_TRIGGER`
at all, which looks perfect on the first two counters while the mode quietly does nothing. Currently
130 / 0 / 0 / 0.

The `start` axis is the one that caught both junction bugs: sliding the whole scenario along the road
changes where the junctions fall relative to the pass, and the junction was where the taxi was
driving into the back of the car in front — and, later, where the lane change was stopping dead.

## Build and deploy

`vite.config.js` exists only to name the second entry: the dev server finds `lab/index.html` on its
own, but `npm run build` walks `index.html` and nothing else unless told, and would ship a `dist/`
with the lab silently missing. The lab deploys alongside the game at `/lab/` and costs the game
nothing — three files it doesn't load.

There is deliberately no service worker, no manifest and no icons on the lab page. `public/sw.js`
precaches the *game's* shell and knows nothing about `/lab/`, which is right: this is a workbench,
not a thing to install.

> **Trap.** `vite.config.js` names the three.js chunk `vendor` and must not be extended to name any
> chunk under `src/`. An earlier version folded `/src/` into a shared `app` chunk, which swept
> `src/main.js` in with it — and `main.js` *boots the game* on import. Every page touching that
> chunk started a whole second game behind itself: `/lab/` came up with the city's road network
> installed under the lab's own, and the console filled with the sim dereferencing junctions that
> were not on the road it was driving. Rollup already keeps every entry module in its own entry
> chunk; the moment a rule overrides that, an import turns into a boot.

# Rocket Rides 🚕

Crazy Taxi meets Flight Control. A fixed 3/4 view of a 6 × 6 city with a river through the middle,
ambient traffic, and one taxi you route by tapping fares. Three.js, and every mesh is generated in
code; the only files loaded are the sound designer's recordings and the radio.

## Play

```bash
npm install
npm run dev          # http://localhost:5173  (and the passing lab at /lab/)
```

Tap a waiting rider and the taxi drives there, obeying every junction exactly like the rest of the
traffic. Once they're aboard it carries on to their destination by itself; the choice is which
rider to grab, and how to drive the trip. A fare pays by distance, **$8** for a one-block hop up to
**$35** across town, times the **combo meter**.

Each rider's clock is budgeted from the driving their trip costs and runs from spawn to drop-off, so
collecting quickly is what buys the time to deliver. A rider whose clock runs out costs a star: the
run opens on 5.0 and ends at 2.0.

Two pedals on the bottom edge:

- **Loco Mode** (centre, or hold Space) is the crazy-taxi button. Hold for double speed that runs
  red lights and squeals round corners. A full tank is 15 seconds; you start with a third and each
  drop-off earns another third.
- **Brake** (to its left, or hold B) stops the taxi where it is. Let go and it drives itself again.

Combine them for moves that build the combo: **overtake** (blip Loco behind a car), **U-turn**
(Loco, then brake twice), **drift** (Loco, tap the brake, Loco again), and **Big Air** off an arched
bridge with a drift kick, which ends in a barrel roll. The first three unlock as you deliver, and
each is taught by a card after the run that unlocked it.

On a desktop the whole city is in frame. On a phone the camera follows the taxi and you can drag to
look around.

## Test

```bash
npm run check        # the whole headless suite, ~2s
```

The assertion that matters most is the one no screenshot can make: given a target, does the routed
taxi actually arrive, while still stopping where it should? The soak test is the fairness check: if
a perfect player with a fixed reaction delay ever fails on a timer, the deadline is unfair, because
a real player is strictly slower. See [docs/testing.md](docs/testing.md).

## Documentation

Start at [**docs/README.md**](docs/README.md): one doc per system, what it does, which files own it,
and the decisions behind it. Every URL parameter is listed in [docs/params.md](docs/params.md).

## The idea worth stealing

**A routed taxi is just a car whose turn choice comes from a route instead of a dice roll.**

There is exactly one place in `src/sim/traffic.js` where a car picks its exit at an intersection. A
car with a `route` takes the next step from it; everyone else rolls the weighted straight/right/left
dice. Everything downstream (junction control, following distance, left-turn yielding,
don't-block-the-box) is untouched and applies to the taxi identically. So the taxi cannot cheat its
way to a destination, and gameplay changes almost never touch traffic code.

The router is a Dijkstra over **directed** states, a junction plus the direction the car arrives
from, because U-turns are not a legal exit and a plain junction node would plan routes the car could
never drive. See [docs/gameplay.md](docs/gameplay.md#routing).

## Deploy

Static build on Netlify (`netlify.toml`): push to `main` and it deploys.

```bash
npm run build        # → dist/
```

The iOS app under `ios/` is a WKWebView serving the same bundle over a custom URL scheme, which gives
it a real origin and therefore working `localStorage`. See [docs/ios.md](docs/ios.md).

```bash
npm run build:ios    # → dist/, then ios/SimTaxi/web/
```

## Built with

Three.js r0.180 · Vite 7 · no models, no loaders, no textures.

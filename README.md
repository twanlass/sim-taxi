# Sim Taxi 🚕

Crazy Taxi meets Flight Control. A fixed 3/4 view of a small city with real traffic signals, and
one taxi you route by tapping. Three.js, no external assets — every mesh is generated in code.

## Play

```bash
npm install
npm run dev          # http://localhost:5173
```

Tap the waiting passenger and the taxi drives there, **obeying every traffic signal**. Pick them
up and it carries straight on to their destination by itself — the only thing you choose is *which
rider to grab*. A fare pays by distance, **$8** for a one-block hop up to **$35** across town.

The 60-second clock does **not** reset at pickup: one deadline covers spawn to drop-off, so
collecting a rider quickly is what buys the time to deliver them. Let a clock expire and the run
ends.

**Loco Mode** (bottom left) is the crazy-taxi button — **hold** for double speed that blows
through red lights and squeals around corners, release to pause. A full tank is 15 seconds of
boost; from empty it recharges in 15 seconds.

The whole city is always on screen. There is nothing to pan or zoom, so every tap is unambiguous.

## Weather and time of day

A full day takes three minutes, and the weather runs on a clock of its own — clear, cloudy, fog,
rain, snow, blending from one to the next rather than switching. After dusk the towers' windows
come on, the street lamps throw pools onto the tarmac, and every car turns its headlights on; a
downpour at three in the afternoon turns them on too.

Night is genuinely dark and never dark enough to lose in. There is a floor under the total light in
the scene that every darkening influence has to clear between them, because you steer this game by
tapping things on a map and "you can't see the road" is a lost run rather than a mood.

Pin a frame with `?hour=1` or `?weather=fog` — either stops its own clock.

## Test

```bash
npm run check        # the whole headless suite, ~1.8s
```

```
ok    modules  all import and construct · sun 0.00→3.84 · moon 1.00
ok    probe    95/95
ok    routing  30/30
ok    fares    6/25
ok    signals  7.05
ok    sky      31/31
```

The assertion that matters most is the one **no screenshot can make**: given a target, does the
routed taxi actually arrive — while still stopping at every red? The soak test is the fairness
check: if a perfect player with a fixed reaction delay ever fails on a timer, the deadline is
unfair, because a real player is strictly slower.

See [docs/testing.md](docs/testing.md) for the individual tools and the screenshot harness.

## Documentation

[**docs/**](docs/README.md) covers each system — what it does, which files own it, and the
decisions behind it.

- [architecture.md](docs/architecture.md) — module map, frame loop, seeding
- [city.md](docs/city.md) — coordinates, layout, park districts
- [traffic.md](docs/traffic.md) — signals, physics, boost, police corridor
- [gameplay.md](docs/gameplay.md) — fares, routing, the travelling timer
- [rendering.md](docs/rendering.md) — low-poly technique, lighting, day/night, weather, effects
- [testing.md](docs/testing.md) — the headless suite

## The idea worth stealing

**A routed taxi is just a car whose turn choice comes from a route instead of a dice roll.**

There is exactly one place in `src/sim/traffic.js` where a car picks its exit direction at an
intersection. A car with a `route` takes the next step from it; everyone else rolls the weighted
straight/right/left dice. Everything downstream — signals, following distance, left-turn yielding,
don't-block-the-box — is untouched and applies to the taxi identically.

So the taxi cannot cheat its way to a destination, and gameplay changes almost never touch traffic
code.

The routing itself is BFS over **directed** states `(i, j, d)` — 144 of them, instant. The node has
to carry the approach direction because U-turns are illegal; a plain `(i, j)` node would plan
routes the car could never execute.

## Deploy

Static build, deployed on Netlify — see `netlify.toml`.

```bash
npm run build        # → dist/
```

## Built with

Three.js r0.180 · Vite 7 · no assets, no loaders, no textures.

# Taxi Lab — documentation index

Start here. Each doc covers one system: what it does, which files own it, and the decisions
behind it that aren't obvious from the code.

| Doc | Covers | Main files |
|---|---|---|
| [architecture.md](architecture.md) | Module map, the frame loop, seeding and determinism, how a change flows through the app, offline support | `src/main.js` |
| [city.md](city.md) | Coordinate system, direction encoding, block layout, park districts, ground/buildings/props | `src/city/` |
| [roadnet.md](roadnet.md) | The road network: nodes, edges, lanes, turns, derived signals, blocks as graph faces | `src/city/roadnet.js`, `src/city/curves.js` |
| [traffic.md](traffic.md) | Signal timing, arterials, the ring road, car physics, turns, the police corridor and the bust chase | `src/sim/` |
| [gameplay.md](gameplay.md) | The opening tutorial, the fare loop, **swipe steering**, routing, picking, the travelling clock, economy, crazy-taxi mode | `src/game/` |
| [difficulty.md](difficulty.md) | The ramp: budgeted fare clocks, board size, shifts, and how the numbers were swept | `src/game/difficulty.js` |
| [rendering.md](rendering.md) | Low-poly technique, palette, camera, lighting, the day/night cycle, the island's faded edge, effects | `src/game/scene.js`, `src/geometry/` |
| [testing.md](testing.md) | `npm run check`, the headless tools, screenshots, and the iteration workflow | `tools/` |

## The 60-second version

Every run opens with three speech bubbles from the taxi — "this car is you", "swipe to drive
there", and a nod at the boost pill a couple of seconds after the first drop-off — and that is the
whole tutorial; see [the opening tutorial](gameplay.md#the-opening-tutorial).

A 5×5 block city on a fixed 3/4 orthographic camera. Ambient cars drive a lane-following traffic
model with real signals. **The player's taxi is one of those cars** — the only difference is that
its turn at each junction comes from the player rather than a dice roll, so it obeys every red light
exactly like everyone else and cannot cheat its way anywhere.

**The taxi never stops driving, and you steer it by swiping.** Roads run along the screen diagonals,
so a swipe along the one you want turns the car onto it at the next junction; a swipe along the road
it is already on floors it instead. The window is about a second, and less than half of that at full
speed. See [Steering](gameplay.md#steering).

A passenger appears at an intersection under a floating **diamond**, coloured green through red by
how much of their patience is left, swelling each time that colour steps, with a **disc**
under their feet in the same colour. Drive to them and they get in; a **teal ring** then appears on
the road where they're going, and you drive there too. The choice on the board is which rider to
grab — and then whether you can actually get there. The clock does
**not** reset at pickup — one deadline covers spawn to drop-off, which is
the whole tension of the game, and it is **budgeted from the driving that trip actually costs**
rather than being the same number for everyone. A delivery pays by distance, $8 for a one-block hop
up to $35 across town, times the shift multiplier. Let a clock expire and the run ends.

Everything **ramps with the deliveries you land**: the board grows from one rider to four, clocks
tighten from twice the driving they cost down to 1.15×, traffic thickens, the police come round more
often, and fares pay up to double. A perfect player survives a median of 15.

Once a run, a side street closes for **roadworks** — barricades at both ends, cones, a hole in the
road and two workers standing over it. Ambient traffic routes around it while the taxi's own router
is told the street is cheap, so it is the emptiest road in the city with a ramp at each end — and a
fare that leads you down it. See [traffic.md](traffic.md#roadworks-a-street-closed-at-both-ends).

**Loco Mode** is the crazy-taxi mode: double speed that runs red lights. **Swipe forward** for a
2.5-second burst, or **hold** the pill bottom-left and release to pause the meter. Two clear blocks
in a row take it past double into the overdrive band, and any corner takes that back. A full tank is
15 seconds of boost, earned rather than regenerated: you start with a third and each drop-off tops
it up by another third.

## Conventions worth knowing before editing

- **Zero external assets.** Every mesh is generated in code. There is no loader, no texture, no
  model file. If something needs to look different, it changes in geometry or in `palette.js`.
- **Seeded generation.** The city is one seed, the run situation is another; see
  [architecture.md](architecture.md#seeding).
- **Comments carry the "why".** Most non-obvious lines already explain themselves in place —
  particularly the ones recording a measurement or a failed first attempt. These docs summarise;
  the code is the detail.
- **`npm run check` before believing anything.** The whole headless suite is under two seconds.
  See [testing.md](testing.md).

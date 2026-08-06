# Taxi Lab — documentation index

Start here. Each doc covers one system: what it does, which files own it, and the decisions
behind it that aren't obvious from the code.

| Doc | Covers | Main files |
|---|---|---|
| [architecture.md](architecture.md) | Module map, the frame loop, seeding and determinism, how a change flows through the app | `src/main.js` |
| [city.md](city.md) | Coordinate system, direction encoding, block layout, park districts, ground/buildings/props | `src/city/` |
| [roadnet.md](roadnet.md) | The road network: nodes, edges, lanes, turns, derived signals, blocks as graph faces | `src/city/roadnet.js`, `src/city/curves.js` |
| [traffic.md](traffic.md) | Signal timing, arterials, the ring road, car physics, turns, the police corridor and the bust chase | `src/sim/` |
| [gameplay.md](gameplay.md) | The fare loop, routing, picking, the travelling timer ring, economy, crazy-taxi mode | `src/game/` |
| [rendering.md](rendering.md) | Low-poly technique, palette, camera, lighting, the day/night cycle, effects | `src/game/scene.js`, `src/geometry/` |
| [testing.md](testing.md) | `npm run check`, the headless tools, screenshots, and the iteration workflow | `tools/` |

## The 60-second version

A 5×5 block city on a fixed 3/4 orthographic camera. Ambient cars drive a lane-following traffic
model with real signals. **The player's taxi is one of those cars** — the only difference is that
its turn at each junction comes from a planned route rather than a dice roll, so it obeys every
red light exactly like everyone else and cannot cheat its way to a destination.

A passenger appears at an intersection under a **meter**: an urgency bar counting down their
60-second patience, and a distance bar saying whether this is a short, medium or long trip. Tap
them to route the taxi there; once they're aboard their drop-off appears and the taxi drives on to
it **without being told to** — the only choice on the board is which rider to grab. The clock does
**not** reset at pickup — one deadline covers spawn to drop-off, which is
the whole tension of the game. A delivery pays by distance, $8 for a one-block hop up to $35
across town. Let a clock expire and the run ends.

**Loco Mode** (bottom left) is the crazy-taxi button: **hold** for double speed that runs red
lights, release to pause the meter. A full tank is 15 seconds of boost; from empty it recharges in
15 seconds.

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

# Taxi Lab — documentation index

Start here. Each doc covers one system: what it does, which files own it, and the decisions
behind it that aren't obvious from the code.

| Doc | Covers | Main files |
|---|---|---|
| [architecture.md](architecture.md) | Module map, the frame loop, seeding and determinism, how a change flows through the app, offline support | `src/main.js` |
| [city.md](city.md) | Coordinate system, direction encoding, block layout, park districts, ground/buildings/props | `src/city/` |
| [roadnet.md](roadnet.md) | The road network: nodes, edges, lanes, turns, derived signals, blocks as graph faces | `src/city/roadnet.js`, `src/city/curves.js` |
| [traffic.md](traffic.md) | Signal timing, arterials, the ring road, car physics, turns, the police corridor and the bust chase | `src/sim/` |
| [gameplay.md](gameplay.md) | The opening vignette, the opening tutorial, the fare loop, routing, dragging the route, the package courier, picking, the travelling clock, economy, crazy-taxi mode, pause | `src/game/` |
| [difficulty.md](difficulty.md) | The ramp: budgeted fare clocks, board size, shifts, and how the numbers were swept | `src/game/difficulty.js` |
| [rendering.md](rendering.md) | Low-poly technique, palette, camera, lighting, the day/night cycle, the island's faded edge, the sea and country beyond it, Crayon and Cartoon Mode, effects | `src/game/scene.js`, `src/geometry/`, `src/city/surrounds.js` |
| [testing.md](testing.md) | `npm run check`, the headless tools, screenshots, and the iteration workflow | `tools/` |
| [lab.md](lab.md) | The passing lab at `/lab/` — one straight road with no lights, for watching Loco Mode overtake | `src/lab/`, `lab/` |
| [ios.md](ios.md) | The App Store build: the WKWebView shell, why a custom URL scheme rather than `file://`, the native flag | `ios/`, `src/util/platform.js` |

## The 60-second version

A run opens on the taxi's **garage**: the camera comes down onto a roller door, the door goes up, the
car drives out and bumps down the kerb into traffic, and the camera pulls back to the game. One block
of every city is the depot rather than a block of towers. See
[the opening vignette](gameplay.md#the-opening-vignette).

After that, three speech bubbles from the taxi — "this car is you", "tap that rider", and a
nod at the boost pill a couple of seconds after the first drop-off — and that is the whole tutorial;
see [the opening tutorial](gameplay.md#the-opening-tutorial).

The city is an island, and it now sits in something. The asphalt's feathered edge hands over to
**open country** on the two borders that come toward the camera — meadow, scrub and clumps of
forest — and to **sea** on the two that face up-screen, with surf on the beach and a few boats
bobbing at anchor. None of it is playable; all of it is there so the map stops floating in blue.
See [what is outside the city](rendering.md#what-is-outside-the-city--citysurroundsjs).

A 5×5 block city on a fixed 3/4 orthographic camera. Ambient cars drive a lane-following traffic
model with real signals. **The player's taxi is one of those cars** — the only difference is that
its turn at each junction comes from a planned route rather than a dice roll, so it obeys every
red light exactly like everyone else and cannot cheat its way to a destination.

A passenger appears at an intersection under a floating **plumbob**, coloured green through red by
how much of their patience is left and swelling each time that colour steps, standing in a **disc**
on the pavement in the same colour. Tap them to route the taxi there — the road ahead fills with a
**band of paint in that rider's own colour**, and you can drag it sideways to send the car round a
different way — and once they're aboard a **ring** in the same colour appears where they're going
and the taxi drives on to it **without being told to**. Crystal, band and ring: one trip, one hue.
The only choice on the board is which rider to grab. The clock does **not** reset at pickup — one
deadline covers spawn to drop-off, which is the whole tension of the game, and it is **budgeted
from the driving that trip actually costs** rather than being the same number for everyone. A
delivery pays by distance, $8 for a one-block hop up to $35 across town, times the shift multiplier. Let a clock expire and the run ends.

Everything **ramps with the deliveries you land**: the board grows from one rider to four, clocks
tighten from twice the driving they cost down to 1.15×, traffic thickens, the police come round more
often, and fares pay up to double. A perfect player survives a median of 15.

Alongside the riders, one or two **packages** wait on corners under cyan rounded-square pads. You
cannot tap one: the only way to collect or deliver a package is to **drag the route band through its
junction**, which is what finally gives that gesture a reason to exist. A package rides alongside a
passenger, carries no clock and can never cost you a run — but the detour is paid out of the clock of
whoever is in the back seat, and taking every one on offer halves how long you last. See
[the package courier](gameplay.md#the-package-courier).

Once a run, a side street closes for **roadworks** — barricades at both ends, cones, a hole in the
road and two workers standing over it. Ambient traffic routes around it while the taxi's own router
is told the street is cheap, so it is the emptiest road in the city with a ramp at each end — and a
fare that leads you down it. See [traffic.md](traffic.md#roadworks-a-street-closed-at-both-ends).

The route the taxi is driving is drawn as a yellow band down the lane, and it is **draggable**:
press it and pull sideways and the junction under your finger becomes a waypoint the route has to
go through, re-planned live while the car keeps driving. That is the one way to answer traffic on
the road ahead without giving up the fare. See
[dragging the route](gameplay.md#dragging-the-route).

**Loco Mode** (bottom left) is the crazy-taxi button: **hold** for double speed that runs red
lights, release to pause the meter. Two clear blocks in a row take it past double into the
overdrive band, and any corner takes that back. A full tank is 15 seconds of boost, earned rather than
regenerated: you start with a third, each drop-off tops it up by another third, and a delivered
package pours in half of that.

Next to it, taking the right 40% of the same row, is the **brake**: hold it and the taxi screeches
to a halt with rubber off all four wheels, let go and it drives itself again. It costs nothing and
has nothing to run out of. See [the brake](gameplay.md#the-brake).

The two are one control surface: **slide** a held thumb from Loco Mode onto the brake and the car
changes hands as it crosses, with no lift in between. See
[the pedal slide](gameplay.md#the-pedal-slide).

## Conventions worth knowing before editing

- **Zero external assets.** Every mesh is generated in code. There is no loader and no model file.
  If something needs to look different, it changes in geometry or in `palette.js`. The one texture
  in the project is [Crayon Mode](rendering.md#crayon-mode--gamecrayonjs)'s paper, which is baked
  from seeded noise at boot — generated in code like everything else.
- **Seeded generation.** The city is one seed, the run situation is another; see
  [architecture.md](architecture.md#seeding).
- **Comments carry the "why".** Most non-obvious lines already explain themselves in place —
  particularly the ones recording a measurement or a failed first attempt. These docs summarise;
  the code is the detail.
- **`npm run check` before believing anything.** The whole headless suite is under two seconds.
  See [testing.md](testing.md).

# Taxi Lab — documentation index

Start here. Each doc covers one system: what it does, which files own it, and the decisions
behind it that aren't obvious from the code.

| Doc | Covers | Main files |
|---|---|---|
| [architecture.md](architecture.md) | Module map, the frame loop, seeding and determinism, how a change flows through the app, offline support | `src/main.js` |
| [city.md](city.md) | Coordinate system, direction encoding, block layout, park districts and the duck pond, the depot and the burger joint, ground/buildings/props | `src/city/` |
| [river.md](river.md) | The river, its three bridges, the span that lifts and the boats it lifts for | `src/city/river.js`, `src/game/drawbridge.js` |
| [roadnet.md](roadnet.md) | The road network: nodes, edges, lanes, turns, derived signals, blocks as graph faces | `src/city/roadnet.js`, `src/city/curves.js` |
| [traffic.md](traffic.md) | Signal timing, arterials, the ring road, car physics, turns, the drive-through, the police corridor and the bust chase | `src/sim/` |
| [gameplay.md](gameplay.md) | The opening vignette, the opening tutorial, the fare loop, routing, dragging the route, the package courier, picking, the travelling clock, economy, crazy-taxi mode, pause | `src/game/` |
| [difficulty.md](difficulty.md) | The ramp: budgeted fare clocks, board size, shifts, and how the numbers were swept | `src/game/difficulty.js` |
| [rendering.md](rendering.md) | Low-poly technique, palette, camera, lighting, the day/night cycle, the island's faded edge, Crayon and Cartoon Mode, bloom, effects | `src/game/scene.js`, `src/geometry/` |
| [testing.md](testing.md) | `npm run check`, the headless tools, screenshots, and the iteration workflow | `tools/` |
| [lab.md](lab.md) | The passing lab at `/lab/` — one straight road with no lights, for watching a nitro overtake | `src/lab/`, `lab/` |
| [ios.md](ios.md) | The App Store build: the WKWebView shell, why a custom URL scheme rather than `file://`, the native flag | `ios/`, `src/util/platform.js` |

## The 60-second version

A run opens on the taxi's **garage**: the camera comes down onto a roller door, the door goes up, the
car drives out and bumps down the kerb into traffic, and the camera pulls back to the game. One block
of every city is the depot rather than a block of towers. See
[the opening vignette](gameplay.md#the-opening-vignette).

After that, three speech bubbles from the taxi — "this car is you", "tap that rider", and a
nod at the boost pill a couple of seconds after the first drop-off — and that is the whole tutorial;
see [the opening tutorial](gameplay.md#the-opening-tutorial).

A 5-by-6 block city on a fixed 3/4 orthographic camera. Ambient cars drive a lane-following traffic
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

A **river** runs east–west through the middle of the city, so every trip across town has to pick a
crossing. Three of the six roads that meet it carry a bridge; the other three just stop at the
water. Two of the three **arch** — a low hump the cars rise and pitch over, and a ramp the boosting
taxi gets air off — and the third is flat, because it is the one that **lifts**: barriers drop, the
deck clears, and a leaf tilts up off one bank to let a tug through, closing that route for a dozen
seconds while it does. The barges pass under everything, which is what the arch on the other two is
for. See [river.md](river.md).

Alongside the riders, one or two **packages** wait on corners under cyan rounded-square pads. You
cannot tap one: the only way to collect or deliver a package is to **drag the route band through its
junction**, which is what finally gives that gesture a reason to exist. A package rides alongside a
passenger, carries no clock and can never cost you a run — but the detour is paid out of the clock of
whoever is in the back seat, and taking every one on offer halves how long you last. See
[the package courier](gameplay.md#the-package-courier).

One block of every city is a **burger joint**: a low restaurant under a red band with a line of
neon tracing its roofline, a burger turning slowly on a pole above that, and a drive-through lane
down its street side. Ambient cars
pull in off one road, crawl past the menu board and the pickup window, and come back out onto
another — a third of the time there is one in there.

**And you can tap it.** The taxi drives itself round to the mouth, crawls the lane, stops at the
board and again at the window, and comes back out. It used to come back out with 15% of a tank of
boost, the smallest top-up in the game and the only one that wasn't paid for a job; with nitro no
longer a resource that payout is gone and the detour currently pays nothing, while still costing
whatever the clock in the back seat is worth. See
[the burger run](gameplay.md#the-burger-run),
[the burger joint](city.md#the-burger-joint-and-its-drive-through) and
[the drive-through](traffic.md#the-drive-through).

Once a run, a side street closes for **roadworks** — barricades at both ends, cones, a hole in the
road and two workers standing over it. Ambient traffic routes around it while the taxi's own router
is told the street is cheap, so it is the emptiest road in the city with a ramp at each end — and a
fare that leads you down it. See [traffic.md](traffic.md#roadworks-a-street-closed-at-both-ends).

The route the taxi is driving is drawn as a yellow band down the lane, and it is **draggable**:
press it and pull sideways and the junction under your finger becomes a waypoint the route has to
go through, re-planned live while the car keeps driving. That is the one way to answer traffic on
the road ahead without giving up the fare. See
[dragging the route](gameplay.md#dragging-the-route).

**Nitro** (bottom left) is the crazy-taxi button: **hold** for double speed that runs red lights,
release to stop. Two clear blocks in a row take it past double into the overdrive band, and any
corner takes that back. It is free and always available — it used to be a 15-second tank earned by
delivering, and that meter is gone. What a press costs is the risk it arms, for as long as it is
held and a second after.

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

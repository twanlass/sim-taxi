# Rocket Rides — documentation index

Start here. Each doc covers one system: what it does, which files own it, and the decisions
behind it that aren't obvious from the code.

| Doc | Covers | Main files |
|---|---|---|
| [architecture.md](architecture.md) | Module map, the frame loop, seeding and determinism, how a change flows through the app, offline support | `src/main.js` |
| [city.md](city.md) | Coordinate system, direction encoding, block layout, park districts and the duck pond, the depot, the burger joint, the graveyard and the bank, ground/buildings/props | `src/city/` |
| [river.md](river.md) | The river, its bridges, the span that lifts, the boats it lifts for, and the harbor at its east mouth | `src/city/river.js`, `src/game/drawbridge.js`, `src/city/harbor.js` |
| [roadnet.md](roadnet.md) | The road network: nodes, edges, lanes, turns, derived signals, blocks as graph faces | `src/city/roadnet.js`, `src/city/curves.js` |
| [traffic.md](traffic.md) | Signal timing, arterials, the ring road, car physics, turns, the drive-through, the building fire and its engine, cop cars in ambient traffic, the patrol cruiser, and the wreck and its replay | `src/sim/`, `game/wreckage.js`, `game/replay.js` |
| [gameplay.md](gameplay.md) | The startup screen, the title screen, the opening vignette and tutorial, the fare loop, routing and tapping a street, the bank robbery, the package courier, picking, the travelling clock, economy and the combo meter, the pedals and the moves (overtake, U-turn, drift), the New Move cards, the burger run, repairs at the depot, pause | `src/game/` |
| [gameplay-history.md](gameplay-history.md) | How each of those got to where it is: superseded designs, rejected attempts, and what each `?x=classic` brings back | |
| [difficulty.md](difficulty.md) | The ramp: budgeted fare clocks, board size, shifts, and how the numbers were swept | `src/game/difficulty.js` |
| [rendering.md](rendering.md) | Low-poly technique, palette, camera, lighting, the day/night cycle, the island's faded edge, car paint, weather, Crayon and Cartoon Mode, bloom, effects, sirens | `src/game/scene.js`, `src/geometry/` |
| [rendering-history.md](rendering-history.md) | The same for rendering: looks that were replaced and why | |
| [audio.md](audio.md) | The taxi's sound: the designer's files and how they're encoded, the engine and Loco beds, the one-shots and where they fire, the tap unlock, pause and mute, the Audio sections of the ⚙️ panel (`?audio`) | `src/game/sfx.js`, `src/game/audiopanel.js`, `assets/audio/` |
| [params.md](params.md) | Every URL parameter, including the `?<feature>=classic` toggles. `npm run check` keeps it complete | `src/util/shot.js`, `src/main.js` |
| [testing.md](testing.md) | `npm run check`, the headless tools, screenshots, and the iteration workflow | `tools/` |
| [lab.md](lab.md) | The passing lab at `/lab/` — one straight road with no lights, for watching Loco Mode overtake | `src/lab/`, `lab/` |
| [ios.md](ios.md) | The App Store build: the WKWebView shell, why a custom URL scheme rather than `file://`, the native flag | `ios/`, `src/util/platform.js` |

## The 60-second version

A 6 × 6 block city on a fixed 3/4 orthographic camera, with a river through the middle of it and a
2 × 2 central park. Ambient cars drive a lane-following traffic model through junctions that run as
all-way stops (the signal plan is still there, behind `?lights=on`). **The player's taxi is one of
those cars**: the only difference is that its turn at each junction comes from a planned route
rather than a dice roll, so it obeys every junction exactly like everyone else and cannot cheat its
way to a destination. On a desktop the whole city is in frame; on a phone the camera follows the
taxi and the map can be dragged ([rendering.md](rendering.md#camera)).

A cold start is black, then the **startup screen**: the taxi drops out of the sky onto a patch of asphalt and boosts off it ([gameplay.md](gameplay.md#the-startup-screen)). A run opens on the **title screen** over the live city ([gameplay.md](gameplay.md#the-title-screen)).
Press Play and the camera comes down onto the taxi's **garage**: the door goes up, the car drives out
into traffic and the camera pulls back to the game ([the opening vignette](gameplay.md#the-opening-vignette)).
Three speech bubbles from the taxi are the whole tutorial ([the opening tutorial](gameplay.md#the-opening-tutorial)).

**The fare loop.** A rider appears on a corner under a floating crystal, coloured green through red
by how much of their patience is left, standing in a disc of the same colour. Tap them and the road
ahead fills with a band of paint in that rider's colour; once they're aboard a ring in the same
colour marks where they're going and the taxi drives there **without being told to**. Tap a street
to send the route down it instead ([tap a street](gameplay.md#tap-a-street-to-send-the-route-down-it)).
The clock does **not** reset at pickup: one deadline covers spawn to drop-off, **budgeted from the
driving that trip actually costs**. A rider whose clock runs out is a strike, shown as a driver's
**star rating** that opens at 5.0 and ends the run at 2.0 ([difficulty.md](difficulty.md#strikes)).

**Pay.** A delivery pays by distance, $8 for a one-block hop up to $35 across town, times the
[combo meter](gameplay.md#the-combo-meter): overtakes, U-turns, drift kicks and Big Air on the way
build it up, and a hit that costs HP, or a rider walking out, breaks it.

**The pedals.** Two round buttons on the bottom edge. **Loco Mode**, in the middle, is the
crazy-taxi button: hold for double speed that runs red lights; two clear blocks take it past double,
and any corner takes that back. A full tank is 15 seconds, earned rather than regenerated: a third
to start, a third per drop-off, a sixth per package, 15% from a burger run, and a dry tank creeps
back to a quarter. The **brake**, to its left, stops the car where it is and costs nothing. Slide a
thumb from one to the other without lifting ([the pedal slide](gameplay.md#the-pedal-slide)). See
[crazy-taxi mode](gameplay.md#crazy-taxi-mode) and [the brake](gameplay.md#the-brake).

**The moves.** Combinations of the two pedals:

- **Overtake**: blip Loco off and on behind a car and the taxi goes round it. Hold Loco behind a car
  without the blip and, after a short grace, you ram it.
- **U-turn**: in Loco, tap the brake twice for a handbrake turn onto the far lane, with a drift kick
  out of it.
- **Drift**: Loco, tap the brake, Loco again round a corner, for a slide and an exit kick that
  refunds some of the tank. Kicks chain, up to three tiers.
- **Big Air**: carry a drift kick over an arched bridge and the taxi launches off it in a barrel roll
  ([river.md](river.md#the-drift-launch)).

The first three unlock as you deliver, and each is taught by a card **after the run** that unlocked
it ([gameplay.md](gameplay.md#new-move-unlocked-the-overtake-u-turn-and-drift-cards)).

**The ramp.** Everything ramps with the deliveries you land: the board grows from one rider to four,
clocks tighten, traffic thickens, the police come round more often, and fares pay more. See
[difficulty.md](difficulty.md).

**The river** runs east–west through the middle of the city, so every trip across town picks a
crossing. Four of the seven north–south roads carry a bridge. Three of them **arch**, a hump the cars
rise over and a ramp the boosting taxi gets air off; the fourth is flat, because it **lifts** to let
a tug through, closing that route for a dozen seconds. At the east mouth is a **harbor** with cranes,
warehouses and ships moving in and out. See [river.md](river.md).

**The L train** comes south on a raised track off the north park, turns west at the east-west
arterial and runs out through the west edge's high rises, with sparks, lamps and an intro of its own; the deck fades where it would hide the taxi or a fare. See
[city.md](city.md#the-elevated-train-on-by-default-ltrainclassic-to-compare).

**Landmarks**, one of each per city:

- The **depot**: the taxi's garage. Tap it with a damaged taxi to drive in and come out repaired
  ([repairs at the depot](gameplay.md#repairs-at-the-depot)).
- The **burger joint**: tap it for a drive-through run that buys 15% of a tank for $10
  ([the burger run](gameplay.md#the-burger-run)). Ambient cars use the drive-through too.
- The **bank**: sometimes a rider waits on its steps. Pick them up and half the time a masked robber
  shoves them over and takes the seat; four cop cars come onto the map and box you in on the way to
  the getaway drop-off, and a clock bonus pays for beating them
  ([the bank robbery](gameplay.md#the-bank-robbery)). Boosting into a cop is a full wreck.
- The **graveyard**: two blocks and the street between them behind an iron fence, with a statue
  ([city.md](city.md#the-graveyard)).
- A **basketball court** with a boom box and a **skatepark** with one rider, in the parks.

**Things that happen.** Packages wait on corners under cyan pads; drive near one and the taxi picks
it up ([the package courier](gameplay.md#the-package-courier)). A patrol cruiser crosses town and
comes after you if you boost in front of it. Once a run a side street closes for **roadworks**, with
a ramp at each end. A **flatbed** sheds crates, a rammed **box truck** spills its load, and now and
then a **building catches fire** and an engine comes to put it out. One car in forty is a classic: a
convertible or an 80s camper van. See [traffic.md](traffic.md).

**Weather and season.** It is autumn by default, a squall crosses the city now and then, and the day
runs to night. See [rendering.md](rendering.md).

Every switch behind these, including the `?<feature>=classic` toggles that bring back what a rework
replaced, is listed in [params.md](params.md).

## Conventions worth knowing before editing

- **Every mesh is generated in code.** There is no loader and no model file. If something needs
  to look different, it changes in geometry or in `palette.js`. The one texture in the project is
  [Crayon Mode](rendering.md#crayon-mode--gamecrayonjs)'s paper, which is baked from seeded noise
  at boot — generated in code like everything else. **Audio is the exception**: the sound effects
  are a designer's recordings, shipped as `assets/audio/*.m4a` — see [audio.md](audio.md).
- **Seeded generation.** The city is one seed, the run situation is another; see
  [architecture.md](architecture.md#seeding).
- **Comments carry the "why".** Most non-obvious lines already explain themselves in place —
  particularly the ones recording a measurement or a failed first attempt. These docs summarise;
  the code is the detail.
- **`npm run check` before believing anything.** The whole headless suite is under two seconds.
  See [testing.md](testing.md).

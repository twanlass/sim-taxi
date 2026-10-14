# URL parameters

Every query parameter the game reads, in one place. Combine them with `&`:
`/?dev&seed=7&cars=1`. The page at `/lab/` has its own, in [lab.md](lab.md).

`tools/docs.mjs` (part of `npm run check`) fails if the code reads a parameter that is not in a
table here, or a row names one nothing reads any more. So adding a `?flag` means adding its row.

**The house rule** (Tyler, 2026-10-11): a new feature or rework ships **on**, and the experience it
replaced goes behind `?<feature>=classic`. There are no opt-in `?x=on` gates for new work; the few
`=on` flags below are older experiments that stayed off.

## Classic toggles: the version before a rework

Each of these brings back what the default replaced. The current default is described in the linked
doc; what the classic version was, and why it changed, is in that doc's history file.

| Param | Brings back | PR | Doc |
|---|---|---|---|
| `?city=classic` | The 5 × 6 city (25 land blocks, straight roads only, three bridges). Headless tools take `CITY=classic` | #483 | [city.md](city.md) |
| `?harbor=classic` | The old river mouth, with no harbor, cranes or ships | #488, #497 | [river.md](river.md) |
| `?northpark=classic` | No park past the north ring road | #483 | [city.md](city.md) |
| `?westedge=classic` | No high rises past the west ring road: the island ends at the old west coast. Headless tools take `WESTEDGE=classic` | #510 | [city.md](city.md#the-west-edge-high-rises-default-westedgeclassic-to-drop-them) |
| `?westcorner=classic` | No mid-rises in the northwest corner: open asphalt between the west edge and the north park, which keeps its old west strip and feather. Headless tools take `WESTCORNER=classic` | | [city.md](city.md#the-west-edge-high-rises-default-westedgeclassic-to-drop-them) |
| `?parkdrive=classic` | No arched drives round statues in the north park's wall | | [city.md](city.md) |
| `?parkshore=classic` | The harbor's seawall curling west and stopping at the north park's corner, instead of running on north beside it. Headless tools take `PARKSHORE=classic` | #512 | [river.md](river.md#the-park-shore) |
| `?southshore=classic` | The old south apron fading into the sky, instead of the rocky shore and park strip. Headless tools take `SOUTHSHORE=classic` | #512 | [river.md](river.md#the-south-shore) |
| `?edgegrass=classic` | Flat green lawns on the north park, the park shore and the south shore, with no long grass. Headless tools take `EDGEGRASS=classic` | | [city.md](city.md#long-grass) |
| `?parkway=twoway` | A two-lane road through the central park instead of the one-way one | #473 | [city.md](city.md) |
| `?graveyard=single` / `=classic` | One graveyard block / no graveyard (default is two blocks with the street between closed) | #487, #491 | [city.md](city.md) |
| `?ltrain=classic` | No L train | #482 | [city.md](city.md) |
| `?lroute=classic` | The L train running east–west instead of north–south over the river | #483 | [city.md](city.md) |
| `?trainlights=classic` | The L's deck without its lamps | #489 | [city.md](city.md) |
| `?trainintro=classic` | The L without its own intro | #494 | [city.md](city.md) |
| `?depot=classic` / `=model` | The depot's wrench sign / a 3D taxi on its roof (default is the neon cutout) | #479 | [city.md](city.md) |
| `?skater=classic` / `=stiff` | The first pair of skaters / the single skater before it got a waist joint | #461, #463 | [city.md](city.md) |
| `?roofs=classic` | Solid flat roof caps, with no lip and no sunk deck | #511 | [city.md](city.md) |
| `?foliage=classic` | The first, louder autumn palette | #486 | [rendering.md](rendering.md) |
| `?water=classic` | The faceted first river surface | | [river.md](river.md) |
| `?paint=classic` / `=layered` / `=chameleon` / `=satin` | Car paint before the layered finish, or one of the explored looks (default is `toon`) | #501 | [rendering.md](rendering.md) |
| `?classics=classic` / `=0.3` | No convertibles or camper vans / that chance per car, capped at 0.5 (default 1 in 40) | #495 | [traffic.md](traffic.md) |
| `?damage=classic` | The taxi's damage ladder before the first-hit flash, grime and steam | #456 | [gameplay.md](gameplay.md) |
| `?wreck=classic` / `=quick` | The old fireball, or the quick cut (default is `flat`) | #398 | [traffic.md](traffic.md) |
| `?cop=classic` | Boosting into a cop is a bump rather than a full wreck | #466 | [gameplay.md](gameplay.md) |
| `?chasesiren=classic` | No 🚨 on the cash row during a chase | #513 | [traffic.md](traffic.md#spotted-and-then-caught-or-lost) |
| `?helispot=classic` | The police helicopter's first, brighter and harder-edged searchlight | | [gameplay.md](gameplay.md) |
| `?menumusic=classic` | The radio's intro plays under the title menu on the first tap, rather than a song until Play | | [audio.md](audio.md#the-radio) |
| `?copchat=classic` | The cops' "pull over" and "lost the suspect" bubbles | #492 | [gameplay.md](gameplay.md) |
| `?robbery=classic` | The robbery with no opening cut (straight to the drive-past). Also implies `?bankfare=classic` | #475, #478 | [gameplay.md](gameplay.md) |
| `?bankfare=classic` | The drive-past robbery instead of the bank rider fare | #499 | [gameplay.md](gameplay.md) |
| `?uturn=classic` | The first U-turn, a spin on the spot, instead of the handbrake turn | #458 | [gameplay.md](gameplay.md) |
| `?barrelroll=classic` | Big Air flown level, no barrel roll | #485 | [river.md](river.md) |
| `?route=classic` | The route stops dead at the rider's kerb, with no stub past the pickup | #480 | [gameplay.md](gameplay.md) |
| `?newmove=classic` | New Move cards mid-run instead of after the run | #493 | [gameplay.md](gameplay.md) |

## Gameplay switches and tuning

| Param | Does | Doc |
|---|---|---|
| `?drag=on` | Turns the route-band drag back on (tap-a-street is the default way to bend a route) | [gameplay.md](gameplay.md) |
| `?chips=on` | The HUD rider chips instead of the edge arrows | [gameplay.md](gameplay.md) |
| `?combo=run` | The combo meter carries across fares instead of cashing per ride | [gameplay.md](gameplay.md) |
| `?rating=off` | Three strike rings instead of the star rating | [difficulty.md](difficulty.md) |
| `?grace=1.6` | How long a newly caught car is tailgated before holding Loco rams it (default `OVERTAKE_GRACE`); `0` is the old rule | [gameplay.md](gameplay.md) |
| `?hitcue=chip` / `edge` / `both` | A cue for how much a hit cost: a bar over the roof, a red edge, or both. Off by default | [gameplay.md](gameplay.md) |
| `?lights=on` | Junctions run their signal phases instead of all-way stops (pair with `?stopbars=on`) | [traffic.md](traffic.md) |
| `?stopbars=on` | Shows the stop bars, hidden by default | [traffic.md](traffic.md) |
| `?blend=additive` | How the route band mixes with the road: `normal`, `additive`, `screen`, `multiply` | [gameplay.md](gameplay.md) |
| `?flatbed=soon` | The flatbed starts shedding crates three seconds in | [traffic.md](traffic.md) |
| `?fire=soon` | A building catches fire early | [traffic.md](traffic.md) |
| `?parcels=0` / `=1` | Packages off / forced on (they are off in shot mode by default) | [gameplay.md](gameplay.md) |
| `?cars=N` | Total vehicles, taxi included. `?cars=1` leaves the taxi alone on the road | [testing.md](testing.md) |
| `?d=0..1` | Pins the difficulty curve instead of the delivery count | [difficulty.md](difficulty.md) |
| `?seed=N` | Pins the city. Random each load otherwise | [architecture.md](architecture.md) |
| `?run=N` | Pins the situation (start, riders, events). Random each load otherwise | [architecture.md](architecture.md) |

## Skipping the front of a run

| Param | Does |
|---|---|
| `?dev` | Debug mode, past the title screen and the opening vignette, straight into a run |
| `?debug` | The ⚙️ panel. Fare clocks are frozen while it is on |
| `?settings` | Same as `?debug` |
| `?audio` | Same as `?debug`, for the Audio sections ([audio.md](audio.md)) |
| `?title=off` | No title screen (the city-build intro plays instead) |
| `?vignette=off` | Settles the opening vignette instead of playing it |
| `?tutorial=off` | No tutorial bubbles |
| `?hometip` | Forces the "Add to Home Screen" tip on any platform |

## Looks and weather

| Param | Does |
|---|---|
| `?crayon` | Crayon Mode. Off by default |
| `?cartoon` | Cartoon Mode. Off by default |
| `?hdr` | The full HDR bloom route instead of the emissive bloom, as a comparison. Not with Crayon or Cartoon |
| `?bloom=off` | No emissive bloom |
| `?rain` | Rain Mode: overcast, wet streets, rain on the lens |
| `?storm` / `=0.6` / `=night` | The passing storm on a loop, pinned at a point, or the darker storm |
| `?squall=off` / `=0.45` | No squall (on by default) / pinned that far along its crossing |
| `?wet=spray` / `tracks` / `both` / `off` | What the taxi's tyres do on a wet road (default `both`) |
| `?fall=off` | Summer trees instead of autumn |
| `?finishes` | Paints each car finish a flat false colour, to check what the geometry tagged as what |

See [rendering.md](rendering.md) for all of these.

## Renderer budget and diagnostics

| Param | Does |
|---|---|
| `?safe` / `=off` | All four budget flags at their cheapest (no MSAA, 1024 shadows, DPR 1, no AO). On by default on Android; `=off` restores the full budget |
| `?msaa=off` | No multisampling |
| `?shadows=off` / `=1024` | No sun shadows, or that map size (power of two, 256–4096) |
| `?dpr=N` | Caps `devicePixelRatio` (0.5–4, default 2) and pins it against the Quality setting |
| `?ao=off` | No ambient occlusion |
| `?fps=30` | Caps the frame rate, overriding the Settings choice |
| `?governor=off` | Holds the resolution where the budget put it, instead of stepping down when hot |
| `?diag` | The on-screen renderer readout |
| `?bench` | The step-by-step GPU benchmark |
| `?br=` | Internal to `?bench`: the rows measured so far, carried across its reloads |
| `?soak` / `=20` | The battery and heat soak, in minutes |
| `?st=` | Internal to `?soak`: elapsed time, carried across its reloads |
| `?sr=` | Internal to `?soak`: the rows measured so far |

See [rendering.md](rendering.md) and [testing.md](testing.md).

## Screenshots

| Param | Does |
|---|---|
| `?shot=N` | Shot mode: a fixed framing from `SHOTS` in `src/util/shot.js`, with the city and run seeds pinned and the HUD hidden |
| `?view=x,z,zoom` | Re-frames any shot without adding one |
| `?introAt=1.9` | With an L train shot, freezes the L's intro that many seconds in |

See [testing.md](testing.md).

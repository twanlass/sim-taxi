# URL parameters

Every query parameter the game reads, in one place. Combine them with `&`:
`/?dev&seed=7&cars=1`. The page at `/lab/` has its own, in [lab.md](lab.md), and so does the model workshop at `/workshop/`, in [workshop.md](workshop.md).

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
| `?streets=classic` | 8-unit streets, the width they were before 2026-10-17. The default is 9. Blocks keep their size, so the map shrinks with the streets. Headless tools take `STREETS=` | | [city.md](city.md#street-width-streets) |
| `?river=classic` | The 12-unit river, the width it was before 2026-10-18. The default is 15 (25% wider); the blocks keep their size, so the map is 3 units taller. `?city=big` keeps the 12-unit river either way. Headless tools take `RIVER=classic` | | [river.md](river.md#the-channel-is-wider-than-a-block-row-riverclassic) |
| `?bridges=classic` | The island's old four crossings: both ring roads and the L's line bridged beside the drawbridge. The default (2026-10-18) is three: fixed bridges one line in from each coast and the drawbridge between them. `?city=big` is unaffected. Headless tools take `BRIDGES=classic` | | [river.md](river.md#which-crossings-bridge) |
| `?city=big` | The 6 × 7 city (36 land blocks) with the central park, harbor, north park, shores, west edge high rises, horizon filler and the L's turn west. The default is the 5 × 5 island with feathered edges. Headless tools take `CITY=big` | #483 | [city.md](city.md) |
| `?harbor=classic` | The old river mouth, with no harbor, cranes or ships | #488, #497 | [river.md](river.md) |
| `?northpark=classic` | No park past the north ring road | #483 | [city.md](city.md) |
| `?westedge=classic` | No high rises past the west ring road: the island ends at the old west coast. Headless tools take `WESTEDGE=classic` | #510 | [city.md](city.md#the-west-edge-high-rises-default-westedgeclassic-to-drop-them) |
| `?westcorner=classic` | No mid-rises in the northwest corner: open asphalt between the west edge and the north park, which keeps its old west strip and feather. Headless tools take `WESTCORNER=classic` | | [city.md](city.md#the-west-edge-high-rises-default-westedgeclassic-to-drop-them) |
| `?edgefog=classic` | The island feathering into the sky, with no fog bank round it. Headless tools take `EDGEFOG=classic` | | [rendering.md](rendering.md#the-island-edge--gameedgefogjs-citygroundjs) |
| `?horizon=classic` | The bare edge of the map: no city carrying on past the west towers and the north park, the ground fading straight into the sky. Headless tools take `HORIZON=classic` | | [rendering.md](rendering.md#past-the-edge-of-the-map--cityhorizonjs) |
| `?parkdrive=classic` | No arched drives round statues in the north park's wall | | [city.md](city.md) |
| `?parkshore=classic` | The harbor's seawall curling west and stopping at the north park's corner, instead of running on north beside it. Headless tools take `PARKSHORE=classic` | #512 | [river.md](river.md#the-park-shore) |
| `?southshore=classic` | The old south apron fading into the sky, instead of the rocky shore and park strip. Headless tools take `SOUTHSHORE=classic` | #512 | [river.md](river.md#the-south-shore) |
| `?plumbob=classic` | The green plumbob crystal over a waiting rider instead of the pie. `?plumbob=hourglass` gives the hourglass that came between. Headless tools take `PLUMBOB=` | | [rendering.md](rendering.md#the-pie--geometrydiamondjs) |
| `?pieoutline=classic` | The rider's pie with no black outline. Headless tools take `PIEOUTLINE=classic` | | [rendering.md](rendering.md#the-pie--geometrydiamondjs) |
| `?gravetree=classic` | The graveyard's one big plum-crowned tree in the back corner. Headless tools take `GRAVETREE=classic` | | [city.md](city.md#the-graveyard) |
| `?gravemist=classic` | The graveyard's ground mist, drifting over the lawn and thicker after dark. Headless tools take `GRAVEMIST=classic` | | [city.md](city.md#the-graveyard) |
| `?gravegrass=classic` | The graveyard's lawn flat, with no long grass between the stones. Headless tools take `GRAVEGRASS=classic` | | [city.md](city.md#long-grass) |
| `?edgegrass=classic` | Flat green lawns on the north park, the park shore and the south shore, with no long grass. Headless tools take `EDGEGRASS=classic` | | [city.md](city.md#long-grass) |
| `?parkway=twoway` | A two-lane road through the central park instead of the one-way one | #473 | [city.md](city.md) |
| `?graveyard=single` / `=classic` | One graveyard block / no graveyard (default is two blocks with the street between closed) | #487, #491 | [city.md](city.md) |
| `?ltrain=classic` | No L train | #482 | [city.md](city.md) |
| `?lroute=classic` | The L train running east–west instead of north–south over the river | #483 | [city.md](city.md) |
| `?ltrainwest=classic` | The L train running straight on south over the river truss to the south shore, instead of turning west at the east-west arterial and out through the west edge. Headless tools take `LTRAINWEST=classic` | | [city.md](city.md#the-elevated-train-on-by-default-ltrainclassic-to-compare) |
| `?trainfade=classic` | The L's deck dithering out over the taxi as well as over the fare pins, instead of staying solid and leaving the taxi to its ghost outline | | [city.md](city.md#the-elevated-train-on-by-default-ltrainclassic-to-compare) |
| `?trainlights=classic` | The L's deck without its lamps | #489 | [city.md](city.md) |
| `?trainintro=classic` | The L without its own intro | #494 | [city.md](city.md) |
| `?depot=classic` / `=model` | The depot's wrench sign / a 3D taxi on its roof (default is the neon cutout) | #479 | [city.md](city.md) |
| `?depotneon=classic` | No blue neon tube round the depot's roofline (default traces the two visible faces under the coping, like the burger joint's) | | [city.md](city.md#the-livery) |
| `?depotwindows=classic` | The depot's two office windows stay dark at night and under a squall (default: they light with the city's windows) | | [city.md](city.md#the-livery) |
| `?skater=classic` / `=stiff` | The first pair of skaters / the single skater before it got a waist joint | #461, #463 | [city.md](city.md) |
| `?roadside=carwash` / `=gas` | Pin the roadside lot to the car wash or the gas station; by default each city seed rolls one. Headless tools take `ROADSIDE=` | | [city.md](city.md#the-roadside-lot-and-its-tube-man) |
| `?roadside=classic` | No roadside lot: its block goes back to the towers, and the tube man goes with it | | [city.md](city.md#the-roadside-lot-and-its-tube-man) |
| `?manholes=classic` | The streets without their manhole covers | | [city.md](city.md#manhole-covers) |
| `?roofs=classic` | Solid flat roof caps, with no lip and no sunk deck | #511 | [city.md](city.md) |
| `?foliage=classic` | The first, louder autumn palette | #486 | [rendering.md](rendering.md) |
| `?water=classic` | The faceted first river surface | | [river.md](river.md) |
| `?paint=classic` / `=layered` / `=chameleon` / `=satin` / `=toon` / `=rim` | Car paint before the layered finish, or one of the explored looks (default is `real`: sharp glint, flakes, flip colour, painted reflection streaks, double-width rim; `rim` was the default before it, `toon` before that) | #501 | [rendering.md](rendering.md) |
| `?rim=off` / `=magenta` / `=cyan` / `=gold` / `=white` | The rim line every paint look wears: off, or one tint for every car (default: each car's own colour) | | [rendering.md](rendering.md#car-paint--the-layered-finish) |
| `?flip=<0..1>` / `=off` | The paint's flip colour, a deeper shade of itself at grazing angles (default: 0.7 on `rim`, 0.8 on `real`, off elsewhere) | | [rendering.md](rendering.md#car-paint--the-layered-finish) |
| `?carbody=smooth` | Experimental: cars with rounded body edges and soft normals instead of flat boxes | | [rendering.md](rendering.md#car-paint--the-layered-finish) |
| `?vehiclepaint=classic` | The plane, helicopters, boats, container ships and L train back on the plain flat material instead of the cars' paint | | [rendering.md](rendering.md#every-other-vehicle) |
| `?classics=classic` / `=0.3` | No convertibles or camper vans / that chance per car, capped at 0.5 (default 1 in 40) | #495 | [traffic.md](traffic.md) |
| `?damage=classic` | The taxi's damage ladder before the first-hit flash, grime and steam | #456 | [gameplay.md](gameplay.md) |
| `?wreck=flat` / `=classic` / `=quick` | The unlit ring of fire that was the default until 2026-10-20, the original fireball, or the quick cut. The default is `burn`: shaded fire, firelight on the road, the wrecks left burning | #398 | [rendering.md](rendering.md#wreck--gameblastjs-gamewreckagejs) |
| `?capture=classic` | The old police rules: any patrol touch is "Busted!", a boosted hit on any cop is a full wreck, a getaway's cops never arrest. Default: hitting a cop costs HP like any car, and "Busted!" is being pinned by a chasing cop | #527 | [gameplay.md](gameplay.md#getting-caught) |
| `?standdown=classic` | A patrol cop that loses you goes dark and drives off the map, instead of going back on patrol with its bar swinging | | [traffic.md](traffic.md#the-life-of-a-patrol) |
| `?cop=classic` | With `?capture=classic`: boosting into a cop is a bump rather than a full wreck | #466 | [gameplay.md](gameplay.md) |
| `?stuntman=classic` | Smashing a roadworks barricade is scenery: no Stuntman combo step, no Loco refund | | [gameplay.md](gameplay.md#the-combo-meter) |
| `?taxifinder=classic` | The "back to the taxi" chip above the brake corner, which comes up while the taxi is completely off-frame. Off by default since 2026-10-20, since the camera rides home on its own after 1.5s | | [rendering.md](rendering.md#getting-back-to-the-taxi) |
| `?camreturn=classic` | The camera stays where the player panned it, instead of riding back to the taxi after 1.5s with no touch on the map | #530 | [rendering.md](rendering.md#getting-back-to-the-taxi) |
| `?taxiroof=classic` | The taxi's cabin is one dark glass box again, instead of a yellow roof over a band of windows | #530 | [rendering.md](rendering.md#the-taxis-roof--geometrytaxijs) |
| `?locobar=classic` | The fuel arc with no tailpipe flame burning off its front | — | [gameplay.md](gameplay.md#crazy-taxi-mode) |
| `?buttons=classic` | The NES B and A with their white shine (glint, dot, the dish's lit rim), and the fuel arc 8 units closer to Loco Mode | — | [gameplay.md](gameplay.md#crazy-taxi-mode) |
| `?pedals=classic` | The round pedals with stop and lightning icons (not the NES B and A buttons), the wider ~197° fuel arc, and the 🚨 on the cash row instead of over Loco Mode | — | [gameplay.md](gameplay.md#crazy-taxi-mode) |
| `?chasesiren=classic` | No 🚨 during a chase | #513 | [traffic.md](traffic.md#spotted-and-then-caught-or-lost) |
| `?helispot=classic` | The police helicopter's first, brighter and harder-edged searchlight | | [gameplay.md](gameplay.md) |
| `?splashcam=classic` | The startup screen from the game's 33° three-quarter view (the first cut) instead of the low side-on camera | | [gameplay.md](gameplay.md#the-startup-screen) |
| `?splashsound=classic` | The startup screen plays silent, as it first shipped, rather than with the landing, bounce and Loco sounds | | [gameplay.md](gameplay.md#the-startup-screen) |
| `?eject=classic` | The wrecked taxi's driver appearing full size in the air above the bonnet and fading in, instead of squeezing out through the windscreen | | [traffic.md](traffic.md) |
| `?gameover=classic` | The run-end card without the polaroid of the ending over its title, and with "Tap to continue" grey over the Play again slot instead of pulsing at the foot of the screen | | [gameplay.md](gameplay.md#the-polaroid) |
| `?splashlogo=classic` | The startup screen's plain taxi drop onto the asphalt, with no ROCKET RIDES logo for it to smash through | | [gameplay.md](gameplay.md#the-startup-screen) |
| `?splash=classic` | No startup screen: the game loads behind black and opens on the title menu, with no taxi drop first | | [gameplay.md](gameplay.md#the-startup-screen) |
| `?radiofade=classic` | The station cuts hard between every track, instead of the DJ talking over the start and end of the songs | | [audio.md](audio.md#talking-over-the-music) |
| `?radiointro=classic` | The radio is full-range from Play, instead of playing through the taxi's dash speakers until the car rolls out of its garage | | [audio.md](audio.md#the-dash-radio) |
| `?titlemusic=classic` | Songs play back to back under the title menu until Play cuts them, instead of the menu being effects only with the music starting on Play | | [audio.md](audio.md#the-radio) |
| `?menumusic=classic` | The radio's intro plays under the title menu on the first tap, rather than a song until Play | #519 | [audio.md](audio.md#the-radio) |
| `?bubbles=classic` | Speech bubbles pinned over whatever they are about (cars, riders, the pedal), following it round the screen, instead of a card docked at the top with a small tag on the talker | | [gameplay.md](gameplay.md#speech-bubbles) |
| `?bubblestyle=classic` | The docked speech card and tag in see-through black with white type instead of white with black type | | [gameplay.md](gameplay.md#speech-bubbles) |
| `?bubblestyle=card` | The docked speech card as the white Figma card with its blue gradient | | [gameplay.md](gameplay.md#speech-bubbles) |
| `?tipfocus=classic` | A speech tag waiting at the screen edge takes no tap; the racer's still asks from where it is, and nothing pans the camera to the talker | | [gameplay.md](gameplay.md#speech-bubbles) |
| `?bubbles=dock` | The docked card with no tag on the talker | | [gameplay.md](gameplay.md#speech-bubbles) |
| `?copchat=classic` | The cops' "pull over" and "lost the suspect" bubbles | #492 | [gameplay.md](gameplay.md) |
| `?race=classic` | No street racers: the city before the race vignette, with no violet car tailing the empty taxi to challenge it | | [gameplay.md](gameplay.md#the-street-race) |
| `?robbery=classic` | The robbery with no opening cut (straight to the drive-past). Also implies `?bankfare=classic` | #475, #478 | [gameplay.md](gameplay.md) |
| `?bankfare=classic` | The drive-past robbery instead of the bank rider fare | #499 | [gameplay.md](gameplay.md) |
| `?robberyskip=classic` | A tap (or Space/Enter) skips the bank job's cut, as it used to | | [gameplay.md](gameplay.md#the-bank-job) |
| `?robberycam=classic` | The bank job's cut framed the first way, averaged on the cab in the ground plane, a held Loco push-in left on, and the L's deck left solid over the shove | | [gameplay.md](gameplay.md#the-cuts-framing) |
| `?bankpickup=classic` | The bank rider is collected anywhere within `ARRIVE_RADIUS` of the bank's junction, from any side, instead of level with the steps on the bank's own street | | [gameplay.md](gameplay.md#the-bank-robbery) |
| `?robberyodds=classic` | The bank rider's coin stays a fair 50/50 instead of loading toward a robbery with each bank ride | #522 | [gameplay.md](gameplay.md#the-bank-job) |
| `?uturn=classic` | The first U-turn, a spin on the spot, instead of the handbrake turn | #458 | [gameplay.md](gameplay.md) |
| `?barrelroll=classic` | Big Air flown level, no barrel roll | #485 | [river.md](river.md) |
| `?crush=classic` | Big Air coming down on a car is a hit (usually the wreck) instead of Crushin' It | | [gameplay.md](gameplay.md#the-combo-meter) |
| `?overtake=classic` | The overtake combo judges the road before pulling out: it waits until the car is close, won't pull out round a car turning left, and only swerves round a slow car in the junction it has a clean line round. The default throws the taxi into the oncoming lane the moment the combo lands, whatever is there, or up on the kerb round the right of a car signalling left | | [traffic.md](traffic.md#overtaking) |
| `?passturn=classic` | The taxi pulls out to overtake a car already turning left across it, and grinds along its side | #520 | [traffic.md](traffic.md) |
| `?swerve=classic` | The overtake combo is for a car in front only: a car stopped or creeping in the junction ahead is hit rather than swerved round | | [traffic.md](traffic.md#swerving-round-a-car-stood-in-the-junction) |
| `?passpace=classic` | The overtaking taxi held back to the passed car's speed while it swings out, and to a truck's through every junction of the pass | #520 | [traffic.md](traffic.md) |
| `?hop=classic` | A hop can stall in mid-air: braking (or crawling) over the hump hangs the taxi in the air | | [river.md](river.md) |
| `?route=classic` | The route stops dead at the rider's kerb, with no stub past the pickup | #480 | [gameplay.md](gameplay.md) |
| `?newmove=classic` | New Move cards mid-run instead of after the run | #493 | [gameplay.md](gameplay.md) |
| `?arrowpulse=classic` | The off-screen fare arrows hold still at the frame edge, with no slow swell and lean toward their mark | | [rendering.md](rendering.md#off-screen-fare-pointers) |
| `?movecard=classic` | The New Move card's clip bare with rounded corners (not on polaroid paper), and its pedal keys drawn as the HUD buttons (not flat) and greyed until pressed | | [gameplay.md](gameplay.md#new-move-unlocked-the-overtake-u-turn-and-drift-cards) |
| `?repairtip=classic` | The depot's repair tip as the New Move-style card with a clip of the visit, once ever, stopping the world (not a line in the speech card, once per run until the depot has been used) | | [gameplay.md](gameplay.md#the-depots-tip) |
| `?squallramp=classic` | A squall's edge arriving all at once: shade, rain and city lights over the same few seconds, and the whole sky greying the moment a cell comes on | | [rendering.md](rendering.md#a-squall--the-default-weather-gamesqualljs) |

## Gameplay switches and tuning

| Param | Does | Doc |
|---|---|---|
| `?drag=on` | Turns the route-band drag back on (tap-a-street is the default way to bend a route) | [gameplay.md](gameplay.md) |
| `?chips=on` | The HUD rider chips instead of the edge arrows | [gameplay.md](gameplay.md) |
| `?combo=run` | The combo meter carries across fares instead of cashing per ride | [gameplay.md](gameplay.md) |
| `?rating=off` | Three strike rings instead of the star rating | [difficulty.md](difficulty.md) |
| `?stars=classic` | Show the star rating under the cash (hidden by default since 2026-10-20; the rating still fires you) | [difficulty.md](difficulty.md) |
| `?grace=1.6` | How long a newly caught car is tailgated before holding Loco rams it (default `OVERTAKE_GRACE`); `0` is the old rule | [gameplay.md](gameplay.md) |
| `?pressgrace=classic` | No grace on a fresh Loco press behind a car: the combo's first tap from a taxi already sitting behind one can ram it | [traffic.md](traffic.md) |
| `?hitcue=chip` / `edge` / `both` | A cue for how much a hit cost: a bar over the roof, a red edge, or both. Off by default | [gameplay.md](gameplay.md) |
| `?lights=on` | Junctions run their signal phases instead of all-way stops (pair with `?stopbars=on`) | [traffic.md](traffic.md) |
| `?stopbars=on` | Shows the stop bars, hidden by default | [traffic.md](traffic.md) |
| `?blend=additive` | How the route band mixes with the road: `normal`, `additive`, `screen`, `multiply` | [gameplay.md](gameplay.md) |
| `?flatbed=soon` | The flatbed starts shedding crates three seconds in | [traffic.md](traffic.md) |
| `?fire=soon` | A building catches fire early | [traffic.md](traffic.md) |
| `?race=soon` | The street racer turns up a few seconds in rather than after the 2nd-4th drop-off, and comes back ~12s after each race | [gameplay.md](gameplay.md#the-street-race) |
| `?parcels=0` / `=1` | Packages off / forced on (they are off in shot mode by default) | [gameplay.md](gameplay.md) |
| `?cars=N` | Total vehicles, taxi included. `?cars=1` leaves the taxi alone on the road | [testing.md](testing.md) |
| `?d=0..1` | Pins the difficulty curve instead of the delivery count | [difficulty.md](difficulty.md) |
| `?difficulty=easy\|regular\|hard` | Pins the Settings Difficulty mode for this load, leaving the saved choice alone | [difficulty.md](difficulty.md#modes) |
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
| `?painterly=classic` | Without the painterly prototype: painted brush strokes running along the streets, each a little lighter or darker and a little red or blue, fading in and out in block-sized patches |
| `?crayon` | Crayon Mode. Off by default |
| `?cartoon` | Cartoon Mode. Off by default |
| `?hdr` | The full HDR bloom route instead of the emissive bloom, as a comparison. Not with Crayon or Cartoon |
| `?bloom=off` | No emissive bloom |
| `?grade=<preset>` | Draw this load through one of the colour grade's bundled LUTs (`warm`, `cool`, `teal & orange` as `teal+%26+orange`, `faded film`, `bleach bypass`, `punchy`) without remembering it. See [rendering.md](rendering.md#colour-grade--gamecolorgradejs) |
| `?gradesat=<0..2>` | The colour grade's saturation for this load (1 is unchanged), on its own or with `?grade` |
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
| `?governor=off` | Holds the resolution where the budget put it, instead of stepping down (never below 2x) when hot |
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
| `?wreckAt=0.4` | With a wreck shot (12, 17, 37), freezes the crash that many seconds in instead of the shot's own beat. `tools/wreckreel.mjs` films from `0` |

See [testing.md](testing.md).

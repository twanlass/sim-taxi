// Deterministic review framings. ?shot=N pins the seed, warms the sim up a fixed amount, freezes
// it and fixes the camera, so before/after screenshots differ only by the change under review.
//
// `select` and `route` put the game into the state a given shot is meant to show — a screenshot
// of an unselected taxi says nothing about whether selection or routing renders correctly.

export const SHOTS = [
  { name: 'city', description: 'whole city, taxi and waiting fare', target: [0, 0], zoom: 52, warmup: 12 },
  { name: 'routed', description: 'taxi selected with its route drawn', target: [0, 0], zoom: 52, warmup: 12, select: true, route: true },
  { name: 'close', description: 'close on the selected taxi', target: [0, 0], zoom: 26, warmup: 12, select: true, route: true },
  { name: 'pin', description: 'unclaimed passenger — white, not yet aboard', target: [18, 18], zoom: 26, warmup: 12 },
  { name: 'riding', description: 'taxi carrying a fare: its clock overhead and the drop-off ring in the same colour', target: [0, 0], zoom: 44, warmup: 12, select: true, untilPickup: true },
  { name: 'riding-close', description: 'close on the taxi with its roof sign lit', target: [0, 0], zoom: 24, warmup: 12, select: true, untilPickup: true },
  // Asset-inspection framing: close enough to judge vehicle detail that is a couple of pixels
  // wide at play zoom. Cheaper than guessing whether a change to the model actually landed.
  { name: 'vehicles', description: 'extreme close-up for vehicle detail', target: [0, 0], zoom: 9, warmup: 12, select: true, untilPickup: true },
  { name: 'police', description: 'police corridor: its road green, crossings red', target: [0, 0], zoom: 30, warmup: 12, untilPolice: true },
  { name: 'rider', description: 'waiting rider on the kerb', target: [0, 0], zoom: 11, warmup: 12, atPassenger: true },
  // The route band is the one element a short hop tells you nothing about: with the fare two
  // blocks away the two end fades meet in the middle. This one sends the taxi to the far corner
  // instead, so a full-length band with several turns is in frame.
  //
  // Both this and `route-grab` below show the band in `PALETTE.routeLine`'s fallback yellow rather
  // than in a fare's urgency colour, and that is not a bug to fix here: there *is* no fare, since
  // the whole point is a destination further away than any rider. `?shot=1` frames a band that is
  // actually spending someone's clock.
  { name: 'route-far', description: 'the route band, taxi to the far corner', target: [0, 0], zoom: 22, warmup: 12, select: true, routeFar: true },
  // The drop-off, framed on the kerb corner it sits on. It used to be the shot for the pin *before*
  // it was tapped, back when there was such a state, and then for the pin's floating head; the
  // marker is a ring on the road now, and this is the only framing that shows it close up.
  { name: 'dropoff', description: 'the drop-off ring the taxi is driving at', target: [0, 0], zoom: 18, warmup: 12, untilPickup: true, atDropoff: true },
  // The endgame board, at play zoom. `fares.js` records that three *waiting* riders was tried once
  // and "the board stops being readable at play zoom before it stops being solvable" — the ramp
  // now goes to four, so that judgement has to be re-made rather than inherited. It is the one
  // question a screenshot answers better than an assertion, and the only way to reach it otherwise
  // is to play ten fares, so this shot pins the curve at its top and fills the board.
  { name: 'busy', description: 'a full late-game board at play zoom', target: [0, 0], zoom: 52, warmup: 12, difficulty: 1, untilBoardFull: true },
  // The wreck is the only thing in the game with no steady state: it fires once, ends the run, and
  // is over in a second and a half. Without a staged framing the only way to look at the explosion
  // was to crash in a live run and hope to catch the right frame. `wreckAt` is where in the blast's
  // own life the shot freezes — 0.22s of sim time, which is the fireball at full size with the
  // shockwave still crossing the road under it. Zoom matches WRECK_ZOOM, since that is what the
  // camera actually pulls into.
  { name: 'wreck', description: 'the crash blast, frozen at its peak', target: [0, 0], zoom: 26, warmup: 12, wreckAt: 0.22 },
  // The ambient flyover, at play zoom — which is the question it has to answer, since the whole
  // brief is "noticeable without being a distraction". It has the same problem the wreck does:
  // it is up for a few seconds every minute or so, so there is no steady state to point a camera
  // at. 5.3s in is the middle of the run, with the plane over the city.
  { name: 'flyover', description: 'the ambient plane crossing the city', target: [0, 0], zoom: 52, warmup: 12, flyoverAt: 5.3 },
  // The construction zone, close enough to read the cones. It is forty seconds into a run before
  // one appears and it only ever appears once, so like the wreck and the flyover there is no way
  // to look at it without staging it. `roadworkAt` is seconds after it is placed: 1.4 is past the
  // 1.1s rise, so the props are opaque and standing rather than halfway out of the road.
  // The river, and the one span on it that moves. Both have the wreck's problem — a lift is up for
  // a dozen seconds once or twice a session — so `drawbridgeAt` is seconds into the bridge's own
  // cycle, stepped through the real state machine rather than posed. 6.2 is past the barriers
  // (1.1s) and the full lift (3.4s) with the tug arriving at the opening; 3.0 catches the leaf
  // half way up, which is the frame that says what it is.
  { name: 'river', description: 'the river, its bridges and the boats on it', target: [0, 0], zoom: 34, warmup: 12, drawbridgeAt: 6.2 },
  { name: 'drawbridge', description: 'the leaf half way up, with the tug waiting', target: [0, 0], zoom: 17, warmup: 12, drawbridgeAt: 3.0 },
  { name: 'drawbridge-open', description: 'the leaf fully up and the tug going through', target: [0, 0], zoom: 17, warmup: 12, drawbridgeAt: 9.5 },
  { name: 'roadwork', description: 'a street closed for roadworks', target: [0, 0], zoom: 22, warmup: 12, roadworkAt: 1.4 },
  // And the taxi going through it. Same argument as the wreck: the smash has no steady state —
  // it is over in three quarters of a second and it needs the player to have driven at it — so
  // without a staged framing the only way to look at it is to play until a zone appears and then
  // find it. `smashAt` is seconds after the barricade goes: 0.34 is the taxi near the top of its
  // arc with the trestle still cartwheeling and the cones in the air.
  { name: 'roadwork-smash', description: 'the taxi launching off a barricade', target: [0, 0], zoom: 15, warmup: 12, roadworkAt: 0, smashAt: 0.34 },
  // The zone close enough to judge it by. `roadwork` above is at play zoom, which is the right
  // framing for "does this read in a game" and useless for the three decisions that actually needed
  // looking at: the ramp's pitch, the two rows of cones, and whether anything is fighting the road
  // at the barricade line. At 22 the whole zone is about ninety pixels wide.
  { name: 'roadwork-close', description: 'the closed street, close enough to inspect', target: [0, 0], zoom: 11, warmup: 12, roadworkAt: 1.4 },
  // The other half of the wreck. Shot 12 freezes the flash, which is the fire's beat and says
  // nothing about the smoke collar ringing it — that one is thrown outward and only reads once it
  // has travelled, by which time the fireball is gone. 1.15s is a couple of frames past the last
  // flame, so this is the picture the player is left looking at while the retry banner comes up.
  { name: 'wreck-smoke', description: 'the wreck after the fire, its smoke collar still up', target: [0, 0], zoom: 26, warmup: 12, wreckAt: 1.15 },
  // Appended rather than filed next to the flyover it is a sibling of. Shots are addressed by
  // *index* — `?shot=12`, and the comment four lines up names one — so slotting a new entry into
  // the middle silently renumbers every shot after it and every reference to one.
  //
  // The park flock, framed on the park it lives in. Same problem the flyover has — it walks about
  // for most of a run and the departure is over in two seconds — so the take-off is staged. 0.75s
  // in is the leap: the last birds are still leaving the grass while the first are a couple of
  // units up with their wings at full stretch, which is the frame that has to be judged. Zoom 18
  // puts the whole park in shot at a size where a bird is about twenty pixels.
  { name: 'birds', description: 'the park flock going up', target: [0, 0], zoom: 18, warmup: 12, birdsAt: 0.75 },
  // The route band with a finger on it. The drag flourish is the one part of that feature a
  // screenshot answers better than an assertion — whether the lift, the bloom and the handle read
  // as *one* response to a touch or as three things switching on — and it is also the one part
  // that cannot be reached any other way: it exists only while a pointer is down, and shot mode
  // has no pointer. `grabAt` is the fraction along the band the flourish is centred at.
  //
  // Framed on the taxi at the same zoom as `route-far`, and routed to the far corner for the same
  // reason: the bloom is 11 units wide and a two-block hop would be all bloom.
  { name: 'route-grab', description: 'the route band held under a finger', target: [0, 0], zoom: 22, warmup: 12, select: true, routeFar: true, grabAt: 0.4 },
  // The helicopter on the pad, in its own dust. Staged for the reason every other ambient thing is
  // — it visits once every couple of minutes and the landing itself lasts three seconds — and
  // framed close, because at play zoom the machine is thirty pixels on a roof and the question this
  // shot is asked to answer is whether the wash, the skids and the blade read at all. `heliAt` is
  // seconds into the visit: 11.6 is a moment after touchdown, with the dust still going up and the
  // rotor still winding down off flight rpm.
  { name: 'heli', description: 'the helicopter settling onto a rooftop pad', target: [0, 0], zoom: 14, warmup: 12, heliAt: 11.6 },
  // And the same visit at play zoom, which is the other half of the brief the flyover's shot has:
  // an ambient event has to be noticeable without being a distraction, and that is not a judgement
  // a close-up can make. 4.4s in is the turn onto final — out over the city, at full bank.
  { name: 'heli-far', description: 'the helicopter banking onto final, at play zoom', target: [0, 0], zoom: 52, warmup: 12, heliAt: 4.4 },
  // The package courier (game/parcels.js). **Both need `?parcels=1`** — the layer is off in shot mode
  // by default, and `untilParcel` has nothing to frame without it.
  //
  // Appended after the helicopter's pair rather than filed with them, for the reason stated above the
  // `birds` entry: shots are addressed by *index*, so inserting anywhere but the end silently
  // renumbers every shot after it. These moved from 20-22 to 22-24 when the two `heli` framings landed
  // on main, which is the cost of that rule being paid rather than a reason to break it.
  //
  // Two distances because the two questions are at different distances. Close: does a kraft box read
  // as a *parcel* at all, and does the tape strip and its label survive at this size? At play zoom: is
  // the pad's rounded square distinguishable from a fare's disc, which is the whole of "shape says
  // what a thing is" and the one claim no assertion can make.
  { name: 'parcel', description: 'a package waiting on its pad — needs ?parcels=1', target: [0, 0], zoom: 11, warmup: 12, untilParcel: true },
  { name: 'parcel-board', description: 'a courier pad against the fare board at play zoom — needs ?parcels=1', target: [0, 0], zoom: 30, warmup: 12, untilParcel: true },
  // The weather ringing the island (game/clouds.js). Appended, for the index-addressing reason
  // stated above the `birds` entry.
  //
  // Framed on the map's **far corner** rather than on the middle of it, and that is the whole point
  // of the shot: at play zoom the island is 221 x 120 on screen against a frame 104 tall, so what
  // the player ever sees of the sky is the wedge between the map's edge and the corner of the frame
  // — 91% of it within 30 units of the edge — and a cloud that is not against that edge is a cloud
  // nobody is ever going to see. The question this framing asks is whether the band sits where the
  // sky actually is.
  { name: 'clouds', description: 'the weather ringing the island', target: [-38, -38], zoom: 52, warmup: 12 },
  // The duck pond (city/pond.js, game/ducks.js). Appended, for the index-addressing reason stated
  // above the `birds` entry.
  //
  // Two framings, and the pair is the whole brief an ambient thing gets round here. Close: does the
  // water read as *water* — a shore, a dark middle, birds sitting in the surface rather than on it
  // — at a size where a duck is ten pixels. At play zoom: is it a landmark you notice while driving
  // past, or a blue smudge on a lawn? Nothing here is staged: a pond does not have a moment, and
  // the ducks are posed the instant they are built precisely so a frozen frame has birds on it.
  { name: 'pond', description: 'the duck pond, close', target: [0, 0], zoom: 9, warmup: 12, atPond: true },
  { name: 'pond-far', description: 'the duck pond at play zoom', target: [0, 0], zoom: 52, warmup: 12, atPond: true },
  // The burger joint and the drive-through running through it (city/burgerjoint.js,
  // game/drivethru.js). Appended, for the index-addressing reason stated above the `birds` entry.
  //
  // Two framings, the same pair every ambient thing round here gets. Close: does a stack of five
  // cylinders on a pole read as a *burger*, does the lane read as a lane, and is the car at the
  // window still visible from under its own canopy — which is a clearance worked out on paper in
  // `CANOPY_Y` and the one thing a screenshot can settle better than an assertion. At play zoom:
  // is it a landmark you notice while driving past, or a red smudge on a block?
  //
  // Neither needs a `burgerAt`, because the lot has no *moment* — but both do need it filled, and
  // `driveThru.settle()` is what does that: a shot ticks the world once, so a drive-through left
  // to fill itself is photographed empty. See the note over `settle` in game/drivethru.js.
  { name: 'burger', description: 'the drive-through, close', target: [0, 0], zoom: 11, warmup: 12, atBurger: true },
  { name: 'burger-far', description: 'the burger joint at play zoom', target: [0, 0], zoom: 52, warmup: 12, atBurger: true },
  // There were two more here, `parcel-aboard` and `parcel-flight`, and both photographed a load that
  // has since left the world: the box no longer rides on the taxi's rear deck and no longer crosses
  // the road to get there — it flies into the HUD (game/cargochip.js), and shot mode hides the HUD.
  // Removed from the **end** of the list rather than blanked in place, which is the one edit the
  // index-addressing rule above allows without renumbering anything that survived.
];

export function getActiveShot() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('shot')) return null;
  const index = Number.parseInt(params.get('shot'), 10);
  const shot = SHOTS[Number.isNaN(index) ? 0 : index];
  return shot ? { ...shot, index } : null;
}

/**
 * Total vehicles including the taxi, via ?cars=N. `?cars=1` leaves the taxi alone on the roads,
 * which makes testing the fare loop far easier — note that this genuinely removes the other cars
 * from the simulation rather than just hiding them, so there are no invisible obstacles left to
 * block the taxi.
 */
export function getCarCount(fallback = 12) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('cars');
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : Math.max(1, parsed);
}

/**
 * Whether the package courier layer runs, via `?parcels=0` / `?parcels=1`.
 *
 * Returns **null when unpinned**, the way `getDifficultyPin` does, because the default is not a
 * constant: the layer ships on in an ordinary run and off in shot mode. Every framing in the sweep
 * was composed before packages existed, and a cyan pad wandering into one is a change to a reference
 * image that has nothing to do with whatever is being looked at.
 *
 * So `?parcels=0` clears the board to measure the fare loop alone (the way `?cars=1` clears the
 * roads), and `?parcels=1` forces it back on — including in shot mode, which is the only way to
 * point a camera at a courier job.
 */
export function getParcelsPin() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('parcels');
  if (raw === null || raw === '') return null;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

/**
 * Pins the difficulty curve via `?d=0..1`, overriding the delivery count that normally drives it.
 *
 * The ramp is worth several minutes of play to reach the far end of, which makes the hard part of
 * the game the awkward part to look at: a screenshot of a four-fare board would otherwise mean
 * playing ten fares first, and a tweak to the late game would mean playing there again to see it.
 *
 * Returns null when unpinned, which is what `difficulty.pinDifficulty` wants.
 */
export function getDifficultyPin() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('d');
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? null : Math.max(0, Math.min(1, parsed));
}

/**
 * Seed for everything that changes run to run: where the taxi starts, where riders and
 * destinations appear, when the police car runs.
 *
 * Split from the city seed on purpose. The map — streets, arterials, the ring, park districts —
 * stays identical across runs so it stays learnable, which is the entire point of having a road
 * hierarchy. Only the situation you're dropped into is random.
 *
 * `?run=N` pins it for reproducing a specific game, and shot mode always pins it so review
 * framings don't move.
 */
export function getRunSeed(citySeed, deterministic) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('run');
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (deterministic) return citySeed;
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * The city itself. Random by default so no two loads share a layout, `?seed=N` to pin one you
 * want back. Shot mode always pins it to the same historical default so review screenshots
 * don't move — a random city per screenshot would make every diff also a layout diff.
 */
export function getSeed({ deterministic = false } = {}) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('seed');
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (deterministic) return 71624;
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * The renderer budget flags, and why they are URL flags rather than settings.
 *
 * A phone that comes up black has told you almost nothing. There is no console to read, and the
 * three failures that produce exactly that picture all report themselves to one and then carry on:
 * a lost context, a shader the driver refuses to compile, a context that was never created.
 * Nothing throws, so the page keeps running perfectly over a black canvas — the sim ticks, the HUD
 * updates, the tutorial talks. (`index.html` now mirrors those console lines onto the screen, and
 * `?diag` below reports what the device actually granted; this is the third leg.)
 *
 * What is left is bisection, and bisecting a renderer means being able to *ask it for less* from
 * the address bar, on the device, without a rebuild. Each flag drops one of the four things this
 * page asks a GPU for that a plain three.js page does not:
 *
 *   - `?msaa=off`     — the multisampled back buffer. At DPR 2 this is the largest single
 *                       allocation the page makes.
 *   - `?shadows=off`  — the sun's 2048² shadow map, or `?shadows=1024` for a quarter of it.
 *   - `?dpr=1`        — the drawing buffer itself, quartered.
 *   - `?ao=off`       — the depth prepass, its two render targets, and the shader patch carried by
 *                       every material in the city.
 *
 * `?safe` is all four at their cheapest in one load: no MSAA, a 1024 shadow map, DPR 1, no AO. It
 * answers "will this device render *anything*", and it is a playable configuration rather than a
 * diagnostic one — a device that only works this way can still be played this way.
 *
 * **Every getter below takes its fallback from safe mode rather than from a literal**, evaluated
 * per call. One flag therefore moves all of them, an explicit flag still wins over it (`?safe` +
 * `?msaa=on` bisects upward exactly as `?msaa=off` bisects down), and a module that opens a
 * renderer of its own — the tutorial's avatar, the rider-finder chips — reads the effective value
 * without anyone threading it through.
 */

/**
 * Android, as well as this can be asked.
 *
 * `userAgentData` is the one that is actually specified to answer this and is what Chromium hands
 * over without a string to parse; everything else still needs the user-agent string. **Chrome's
 * "Desktop site" toggle defeats both** — it sends a Linux x86_64 UA with no Android hint at all —
 * which is the same shape of trap as the iPad one in `game/homescreen.js`. The consequence here
 * is mild and the right way round: a phone in desktop mode gets the full budget rather than a
 * desktop being needlessly turned down, and `?safe` is one tap away if it comes up black.
 *
 * Read at call time rather than at import so the module still loads under `npm run check`.
 */
export function isAndroid() {
  if (typeof navigator === 'undefined') return false;
  if (navigator.userAgentData?.platform === 'Android') return true;
  return /Android/i.test(navigator.userAgent ?? '');
}

/**
 * Why the reduced budget is on: `'url'` for an explicit `?safe`, `'android'` for the platform
 * default below, `null` for neither. Reported by the diagnostics panel, because "safe mode is on"
 * and "safe mode is on *and nobody asked for it*" are different things to be looking at.
 */
export function safeModeSource() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('safe')) return isOff(params.get('safe')) ? null : 'url';
  return isAndroid() ? 'android' : null;
}

/**
 * **Android defaults to the reduced budget**, and this is a holding measure rather than a
 * conclusion.
 *
 * What is actually known: one Android device — a Pixel on a PowerVR D-Series (Tensor G5), a GPU
 * vendor no previous Pixel used — rendered the city correctly for about a second and then lost
 * the WebGL context, over and over. `?safe` holds on it. Which *one* of the four flags is the
 * trigger is not known yet, and the four single-variable loads that would settle it have not been
 * run, so this gives up all four rather than guessing at one.
 *
 * It is deliberately blunt in two directions. It is wider than the evidence — one device, not a
 * platform — and it is a real quality cost: no multisampling and half the pixel ratio on every
 * Android phone, most of which were rendering this fine. That trade is taken on purpose, because
 * the failure it avoids is not "slightly soft" but "black screen, no game", and `game/recovery.js`
 * can only climb *down* from a budget, never up.
 *
 * **`?safe=off` is the escape hatch and is what the narrowing will be done through** — it restores
 * the full budget on Android, so the single-variable loads (`?safe=off&msaa=off`, and so on) still
 * work on the device that has the bug. Replace this default with whichever one flag turns out to
 * be responsible as soon as that is known.
 */
export function getSafeMode() {
  return safeModeSource() !== null;
}

/**
 * Screen-space ambient occlusion, via `?ao=off` / `?ao=0` (and `?ao=on` to be explicit).
 *
 * A flag rather than a setting because it is decided before anything is meshed: with AO off the
 * shader patch is never installed on a single material, so switching it at runtime would mean
 * recompiling every program in the city. It is here so the cost can be measured on a real phone
 * by loading the same URL twice.
 */
export function getAmbientOcclusion(fallback = !getSafeMode()) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('ao');
  if (raw === null) return fallback;
  return !isOff(raw);
}

/**
 * Crayon Mode, via `?crayon` / `?crayon=on` (and `?crayon=off` to be explicit).
 *
 * Off by default while the look is being judged — it changes the game's whole identity, and the
 * only way to decide that is to load the same URL twice on a real phone. Promote the fallback to
 * `!getSafeMode()` when it earns it.
 *
 * Like `?ao`, it is a flag rather than a live setting because it is decided *before anything is
 * meshed*: `util/geo.js` bakes the patch into every material it builds, so switching it at runtime
 * would mean recompiling every program in the city. The ⚙️ panel tunes its uniforms; it does not
 * turn it on. And it takes its fallback from safe mode for the same reason everything else here
 * does — an Android default, and the reload `game/recovery.js` performs after a second context
 * loss, both have to land without it.
 */
export function getCrayon(fallback = false) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('crayon');
  if (raw === null) return fallback;
  // A bare `?crayon` is a request, so it wins over safe mode: the flag exists to be switched on by
  // hand on the device that is hardest on it.
  return !isOff(raw);
}

/**
 * Cartoon Mode, via `?cartoon` / `?cartoon=on` — cel-banded light and hard ink, with a thicker
 * outline on the vehicles. Off by default, same as `?crayon`, and independent of it: they are two
 * separate looks being tried, not two halves of one.
 *
 * A flag rather than a setting for the same reason every other look-level switch here is one: the
 * cel bands are compiled into every prop material before a mesh exists, and the hero outlines are
 * hulls built at construction. The ⚙️ panel tunes it; it does not turn it on.
 */
export function getCartoon(fallback = false) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('cartoon');
  if (raw === null) return fallback;
  // A bare `?cartoon` is a request, and beats safe mode — the flag exists to be switched on by
  // hand on the device that is hardest on it.
  return !isOff(raw);
}

/**
 * Multisampling, via `?msaa=off`.
 *
 * Not the same request as the stencil buffer, even though the two ride in the same back buffer:
 * `main.js` keeps asking for stencil with MSAA off, because the ghost outlines need it and a
 * device that declines it has a documented, visible symptom of its own (see `docs/rendering.md`).
 */
export function getMsaa(fallback = !getSafeMode()) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('msaa');
  if (raw === null) return fallback;
  return !isOff(raw);
}

/**
 * The sun's shadow map, in texels a side, via `?shadows=off` or `?shadows=<size>`. Returns 0 for
 * "no shadows", which `createScene` reads as "don't ask for the depth pass at all".
 *
 * Clamped to a power of two between 256 and 4096: a shadow map is a texture allocation, and an
 * arbitrary number here would be a quietly rounded one.
 */
export function getShadowMapSize(fallback = getSafeMode() ? 1024 : 2048) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('shadows');
  if (raw === null) return fallback;
  if (isOff(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  const clamped = Math.max(256, Math.min(4096, parsed));
  return 2 ** Math.round(Math.log2(clamped));
}

/**
 * The ceiling on `devicePixelRatio`, via `?dpr=N`.
 *
 * The default of 2 is a budget rather than a resolution: past DPR 2 the flat facets this game is
 * made of gain nothing an eye can see at arm's length, and the drawing buffer grows with the
 * square. Clamped to 0.5–4 so a typo cannot ask for a buffer no device will allocate.
 */
export function getPixelRatioCap(fallback = getSafeMode() ? 1 : 2) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('dpr');
  if (raw === null) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0.5, Math.min(4, parsed));
}

/**
 * The on-screen renderer readout, via `?diag`. What it says and why each line is in it are in
 * `game/diag.js`.
 */
export function getDiagnostics() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('diag')) return false;
  return !isOff(params.get('diag'));
}

/** `off` / `0` / `false` — the spelling every switch above takes. */
function isOff(raw) {
  return raw === 'off' || raw === '0' || raw === 'false';
}

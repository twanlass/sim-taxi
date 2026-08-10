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
  { name: 'riding', description: 'taxi carrying a fare: its clock overhead and the teal drop-off ring', target: [0, 0], zoom: 44, warmup: 12, select: true, untilPickup: true },
  { name: 'riding-close', description: 'close on the taxi with its roof sign lit', target: [0, 0], zoom: 24, warmup: 12, select: true, untilPickup: true },
  // Asset-inspection framing: close enough to judge vehicle detail that is a couple of pixels
  // wide at play zoom. Cheaper than guessing whether a change to the model actually landed.
  { name: 'vehicles', description: 'extreme close-up for vehicle detail', target: [0, 0], zoom: 9, warmup: 12, select: true, untilPickup: true },
  { name: 'police', description: 'police corridor: its road green, crossings red', target: [0, 0], zoom: 30, warmup: 12, untilPolice: true },
  { name: 'rider', description: 'waiting rider on the kerb', target: [0, 0], zoom: 11, warmup: 12, atPassenger: true },
  // The route band is the one element a short hop tells you nothing about: with the fare two
  // blocks away the two end fades meet in the middle. This one sends the taxi to the far corner
  // instead, so a full-length band with several turns is in frame.
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
export function getSafeMode() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('safe')) return false;
  return !isOff(params.get('safe'));
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

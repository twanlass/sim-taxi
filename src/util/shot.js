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
  // The rock the city floats on. Framed on the near corner, which is the only part of the cliff
  // the play camera ever shows at any size — the far two sides are a few pixels of edge. Its beds
  // are the one thing here with no assertion behind them: `probe` can check the rim is flush and
  // the depth is right, but whether you can *count the layers* is a question for the eye.
  { name: 'island', description: 'the rim: strata under the tarmac', target: [42, 42], zoom: 26, warmup: 12 },
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

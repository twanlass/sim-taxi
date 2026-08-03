// Deterministic review framings. ?shot=N pins the seed, warms the sim up a fixed amount, freezes
// it and fixes the camera, so before/after screenshots differ only by the change under review.
//
// `select` and `route` put the game into the state a given shot is meant to show — a screenshot
// of an unselected taxi says nothing about whether selection or routing renders correctly.

export const SHOTS = [
  { name: 'city', description: 'whole city, taxi and waiting fare', target: [0, 0], zoom: 52, warmup: 12 },
  { name: 'routed', description: 'taxi selected with its route drawn', target: [0, 0], zoom: 52, warmup: 12, select: true, route: true },
  { name: 'close', description: 'close on the selected taxi', target: [0, 0], zoom: 26, warmup: 12, select: true, route: true },
  { name: 'pin', description: 'unclaimed passenger — white, no fare colour yet', target: [18, 18], zoom: 26, warmup: 12 },
  { name: 'riding', description: 'taxi carrying a fare: matching ring and destination pin', target: [0, 0], zoom: 44, warmup: 12, select: true, untilPickup: true },
  { name: 'riding-close', description: 'close on the fare-coloured taxi', target: [0, 0], zoom: 24, warmup: 12, select: true, untilPickup: true },
  // Asset-inspection framing: close enough to judge vehicle detail that is a couple of pixels
  // wide at play zoom. Cheaper than guessing whether a change to the model actually landed.
  { name: 'vehicles', description: 'extreme close-up for vehicle detail', target: [0, 0], zoom: 9, warmup: 12, select: true, untilPickup: true },
  { name: 'police', description: 'police corridor: its road green, crossings red', target: [0, 0], zoom: 30, warmup: 12, untilPolice: true },
  { name: 'rider', description: 'waiting rider on the kerb', target: [0, 0], zoom: 11, warmup: 12, atPassenger: true },
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
 * Which signal visual to render. `?signals=overhead|post|bollard|bar`, default `bar` (the painted
 * stop line on the tarmac). The other three are alternate designs kept around for review — each
 * shows the same phase data, just as a different piece of geometry.
 */
export function getSignalStyle(fallback = 'bar') {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('signals');
  if (!raw) return fallback;
  const allowed = new Set(['bar', 'overhead', 'post', 'bollard']);
  return allowed.has(raw) ? raw : fallback;
}

export function getSeed(fallback = 71624) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('seed');
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

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
  { name: 'riding', description: 'taxi carrying a fare: timer ring and the yellow destination pin', target: [0, 0], zoom: 44, warmup: 12, select: true, untilPickup: true },
  { name: 'riding-close', description: 'close on the fare-coloured taxi', target: [0, 0], zoom: 24, warmup: 12, select: true, untilPickup: true },
  // Asset-inspection framing: close enough to judge vehicle detail that is a couple of pixels
  // wide at play zoom. Cheaper than guessing whether a change to the model actually landed.
  { name: 'vehicles', description: 'extreme close-up for vehicle detail', target: [0, 0], zoom: 9, warmup: 12, select: true, untilPickup: true },
  { name: 'police', description: 'police corridor: its road green, crossings red', target: [0, 0], zoom: 30, warmup: 12, untilPolice: true },
  { name: 'rider', description: 'waiting rider on the kerb', target: [0, 0], zoom: 11, warmup: 12, atPassenger: true },
  // The route band is the one element a short hop tells you nothing about: with the fare two
  // blocks away the two end fades meet in the middle. This one sends the taxi to the far corner
  // instead, so a full-length band with several turns is in frame.
  { name: 'route-far', description: 'the route band, taxi to the far corner', target: [0, 0], zoom: 22, warmup: 12, select: true, routeFar: true },
  // The drop-off pin, framed on the kerb corner it stands on. It used to be the shot for the pin
  // *before* it was tapped, back when there was such a state; the taxi dispatches itself at pickup
  // now, so what this frames is the one pin the game has.
  { name: 'dropoff', description: 'the drop-off pin the taxi is driving at', target: [0, 0], zoom: 18, warmup: 12, untilPickup: true, atDropoff: true },
  // The night and weather framings. Each one pins an hour *and* a weather type, because either on
  // its own is only half the picture: the whole point of building the weather on top of the day
  // cycle is that rain at 1am and rain at noon are different frames.
  //
  // Appended after `dropoff` rather than before it, so that shot stays at index 10 — docs/rendering.md
  // sends the reader to `?shot=10` for the untapped pin by number.
  { name: 'night', description: 'the city at 01:00 — moonlight, windows, headlights', target: [0, 0], zoom: 52, warmup: 12, hour: 1, weather: 'clear' },
  { name: 'night-close', description: 'close on the taxi at night, beams on the road', target: [0, 0], zoom: 18, warmup: 12, hour: 1, weather: 'clear', select: true, route: true },
  { name: 'dusk', description: 'the lights coming on at 19:15', target: [0, 0], zoom: 52, warmup: 12, hour: 19.25, weather: 'clear' },
  { name: 'rain', description: 'a wet afternoon, headlights on', target: [0, 0], zoom: 52, warmup: 12, hour: 15, weather: 'rain' },
  { name: 'night-rain', description: 'rain at 22:00 — the hardest thing to keep legible', target: [0, 0], zoom: 52, warmup: 12, hour: 22, weather: 'rain' },
  { name: 'fog', description: 'fog: the far edge of the city dissolving into the sky', target: [0, 0], zoom: 52, warmup: 12, hour: 9, weather: 'fog' },
  { name: 'snow', description: 'snow over the morning city', target: [0, 0], zoom: 52, warmup: 12, hour: 10, weather: 'snow' },
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
 * `?hour=13.5` parks the day/night cycle at one time of day, and `?weather=rain` pins one kind of
 * weather. Both stop their clock: you asked for that frame, not for that frame drifting away
 * while you look at it. Either can be used on its own — `?hour=2` is a clear night, `?weather=fog`
 * is fog at whatever hour the cycle happens to be at.
 *
 * URL parameters as well as ⚙️ panel controls because the panel doesn't exist in shot mode, and
 * "what does the route band look like in fog at midnight" has to be a link you can send someone.
 */
export function getHour() {
  const raw = new URLSearchParams(window.location.search).get('hour');
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? null : ((parsed % 24) + 24) % 24;
}

export function getWeather() {
  return new URLSearchParams(window.location.search).get('weather');
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

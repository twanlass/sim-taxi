import * as THREE from 'three';
import { SPAN } from '../city/grid.js';

// The sky over one day, as a set of keyframes the clock, the weather and the tweak panel all read.
//
// Keyframes rather than a formula because sunrise and sunset are where all the interest is: an
// analytic curve spends most of its range on a flat blue afternoon and rushes the two minutes
// that actually look like something.

const SUN_RADIUS = SPAN * 1.2;

/** One full day, in real seconds. Short enough that a single fare sees the light change. */
export const DAY_SECONDS = 180;

/**
 * The floor the city is never allowed to fall below, as `sun + moon + ambient fill`.
 *
 * This is a playability constant, not an aesthetic one. You steer this game by tapping things on
 * a map, so "you can't see the road" is a lost run rather than a mood. Every darkening influence
 * in the game — the night keyframes, an overcast sky, a downpour, fog, or any two of those at
 * once — is multiplicative and could in principle stack to nothing, so `apply()` enforces this
 * after the weather has had its say, and tops the ambient fill up if the total came in short.
 *
 * 1.05 is where a mid-grey road still separates from the black under a parked car at play zoom.
 */
export const VISIBILITY_FLOOR = 1.05;

// `power`  — sun intensity.  `moon` — moon intensity (see scene.js; it casts no shadows).
// `fill`   — hemisphere ambient.
// `lit`    — how far up the city's own lights are: windows, street lamps, headlights. Its own
//            keyframe rather than something derived from `power`, because when a city switches
//            its lights on is a look decision and not a function of the sun. Note it is still
//            0.35 at sunrise and 0.45 at sunset: lights outlast dusk in both directions, which is
//            what makes the two transitions read as transitions rather than as a switch throw.
const KEYS = [
  // Night. Genuinely deep in colour and nowhere near black in level — see VISIBILITY_FLOOR. The
  // fill was 0.34 when the cycle was still switched off by default and nothing else lit the city;
  // with the moon carrying the shaping, this can be a soft blue wash rather than the only light
  // in the scene.
  { hour: 0,    top: '#0B1626', bottom: '#1C2942', sun: '#2A3550', power: 0.00, moon: 1.00, fill: 0.62, lit: 1.00, sky: '#4A6FA0', ground: '#1E2734' },
  { hour: 5,    top: '#17293F', bottom: '#3A3E58', sun: '#5A4C6E', power: 0.10, moon: 0.82, fill: 0.66, lit: 1.00, sky: '#5A6C90', ground: '#252A36' },
  { hour: 6.5,  top: '#3E6EA0', bottom: '#D79B7C', sun: '#FFB05A', power: 2.10, moon: 0.14, fill: 0.95, lit: 0.35, sky: '#E8BFA0', ground: '#5E5245' },
  { hour: 9,    top: '#215A9D', bottom: '#9FBED2', sun: '#FFF0D2', power: 3.60, moon: 0.00, fill: 1.40, lit: 0.00, sky: '#DCEAF4', ground: '#7A7A6E' },
  { hour: 13,   top: '#2965A8', bottom: '#9CC4DA', sun: '#FFF4DE', power: 3.85, moon: 0.00, fill: 1.55, lit: 0.00, sky: '#D6E8F4', ground: '#84847A' },
  // The parked look — this was the sky the game shipped with while the cycle was switched off, and
  // it is still the hour the clock starts at. Light blue rather than the warm haze the rest of
  // late afternoon has; see the note in palette.js. The sun and fill stay golden, so only the
  // backdrop changed.
  { hour: 16.4, top: '#438DCE', bottom: '#B7D8ED', sun: '#FFDEBB', power: 3.55, moon: 0.00, fill: 1.50, lit: 0.00, sky: '#F0C79B', ground: '#6B5A48' },
  // Sunset and sunrise are dusty rose rather than the saturated `#F09A60`/`#F0B080` they used to
  // be, and the change is about *area* rather than about the colour being wrong: this camera looks
  // down, so almost the whole visible sky dome sits within a few degrees of the horizon, where the
  // gradient is ~80% `bottom`. A saturated orange there is not a band of sunset light, it is an
  // orange screen behind a city that has already gone dark. Neither was ever visible before, since
  // the cycle only started running by default with this change.
  { hour: 18.6, top: '#33497A', bottom: '#B4756B', sun: '#FF8C46', power: 1.70, moon: 0.18, fill: 0.88, lit: 0.45, sky: '#E8A276', ground: '#4E4038' },
  { hour: 20,   top: '#1C2C48', bottom: '#463D62', sun: '#4A4060', power: 0.28, moon: 0.74, fill: 0.60, lit: 1.00, sky: '#5E6288', ground: '#282B38' },
  { hour: 24,   top: '#0B1626', bottom: '#1C2942', sun: '#2A3550', power: 0.00, moon: 1.00, fill: 0.62, lit: 1.00, sky: '#4A6FA0', ground: '#1E2734' },
];

/** Sun angle above the horizon. Clamped low rather than negative — at night `power` is 0 anyway,
 *  and a light below the ground plane throws shadows upward through everything. */
const elevationAt = (hour) => Math.max(6, 70 * Math.sin(Math.PI * (hour - 6) / 12));

/** Swings through the day so shadows sweep rather than sitting still. */
const azimuthAt = (hour) => 10 + THREE.MathUtils.clamp((hour - 6) / 12, 0, 1) * 165;

// The moon's arc. Rises through the evening, highest around midnight, back down by dawn — and
// crucially, **inside the quadrant the camera can see into**, sweeping the other way to the sun.
//
// That last part is not astronomy, it is the fixed camera. This view stands at (+X, +Y, +Z) and
// sees each building's +X and +Z faces. The first version put the moon opposite the sun, at
// 190°→355° — which is where a moon belongs, and which lights every face the camera cannot see:
// the first night render came back with black buildings standing in bright pools of street light.
// 85°→15° keeps the light on the faces that are actually on screen while still reversing the
// sweep, so the rake shifts from the +Z walls at dusk to the +X walls by dawn and 1am is visibly
// not a dimmer 1pm.
//
// The elevation band is much lower than the sun's, too — 22°..48° against 6°..70°. A light
// directly overhead lands almost entirely on roofs, and roofs are the one surface of this city
// nobody is trying to read. tools/sky.mjs asserts both of these as a direction rather than as an
// angle, because the angle is not what went wrong.
const moonElevationAt = (hour) => Math.max(22, 48 * Math.sin(Math.PI * (hour - 18) / 12));
const moonAzimuthAt = (hour) => 85 - THREE.MathUtils.clamp((((hour - 18) + 24) % 24) / 12, 0, 1) * 70;

function sample(hour) {
  const h = ((hour % 24) + 24) % 24;
  let a = KEYS[0];
  let b = KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) {
    if (h >= KEYS[i].hour && h <= KEYS[i + 1].hour) { a = KEYS[i]; b = KEYS[i + 1]; break; }
  }
  const t = b.hour === a.hour ? 0 : (h - a.hour) / (b.hour - a.hour);
  const mix = (x, y) => new THREE.Color(x).lerp(new THREE.Color(y), t);

  return {
    top: mix(a.top, b.top),
    bottom: mix(a.bottom, b.bottom),
    sun: mix(a.sun, b.sun),
    hemiSky: mix(a.sky, b.sky),
    hemiGround: mix(a.ground, b.ground),
    power: THREE.MathUtils.lerp(a.power, b.power, t),
    moon: THREE.MathUtils.lerp(a.moon, b.moon, t),
    fill: THREE.MathUtils.lerp(a.fill, b.fill, t),
    lit: THREE.MathUtils.lerp(a.lit, b.lit, t),
    // Weather fills these in on its way through; see game/weather.js. Declared here so every
    // consumer can read a complete look whether or not a weather system is installed.
    fogColor: null,
    fogNear: 0,
    fogFar: 0,
    wet: 0,
  };
}

export function createDaylight({ sun, moon, hemi, sky }, startHour = 16.4) {
  const state = { hour: startHour, cycling: true, dayLength: DAY_SECONDS, look: null };

  // The weather installs itself here. One hook rather than weather reaching into the lights
  // directly, so there is exactly one place that writes to `sun`/`moon`/`hemi`/`sky` and exactly
  // one place the visibility floor has to be enforced — after every darkening influence has had
  // its say and before anything reaches a light.
  let filter = null;

  function place(light, elevationDeg, azimuthDeg) {
    const e = THREE.MathUtils.degToRad(elevationDeg);
    const a = THREE.MathUtils.degToRad(azimuthDeg);
    light.position.set(
      Math.cos(a) * Math.cos(e) * SUN_RADIUS,
      Math.sin(e) * SUN_RADIUS,
      Math.sin(a) * Math.cos(e) * SUN_RADIUS,
    );
    light.target.position.set(0, 0, 0);
    light.target.updateMatrixWorld();
  }

  function apply(hour = state.hour) {
    state.hour = ((hour % 24) + 24) % 24;

    const look = sample(state.hour);
    if (filter) filter(look, state.hour);

    // The one guarantee. Anything the weather took away comes back as ambient fill rather than as
    // sun or moon, because fill is the term that can be raised without also moving the shadows or
    // the colour of the light.
    const total = look.power + look.moon + look.fill;
    if (total < VISIBILITY_FLOOR) look.fill += VISIBILITY_FLOOR - total;

    place(sun, elevationAt(state.hour), azimuthAt(state.hour));
    place(moon, moonElevationAt(state.hour), moonAzimuthAt(state.hour));

    sun.color.copy(look.sun);
    sun.intensity = look.power;
    moon.intensity = look.moon;
    hemi.color.copy(look.hemiSky);
    hemi.groundColor.copy(look.hemiGround);
    hemi.intensity = look.fill;
    sky.uniforms.topColor.value.copy(look.top);
    sky.uniforms.bottomColor.value.copy(look.bottom);

    state.look = look;
    return look;
  }

  function update(dt) {
    if (!state.cycling) return;
    apply(state.hour + (24 / state.dayLength) * dt);
  }

  apply();

  return {
    state,
    apply,
    update,
    /** The look last written to the lights, floor and weather included. */
    look: () => state.look,
    /** How far up the city's own lights should be, 0 by day and 1 after dusk. */
    lit: () => state.look?.lit ?? 0,
    setCycling: (on) => { state.cycling = on; },
    setDayLength: (seconds) => { state.dayLength = Math.max(10, seconds); },
    /** Install the weather (or nothing, to remove it). `fn(look, hour)` mutates the look in place. */
    setLookFilter: (fn) => { filter = fn; },
    elevation: () => elevationAt(state.hour),
    moonElevation: () => moonElevationAt(state.hour),
  };
}

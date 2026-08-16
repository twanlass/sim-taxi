import * as THREE from 'three';
import { SPAN } from '../city/grid.js';
import { hazeColor } from './scene.js';

// The sky over one day, as a set of keyframes the clock and the tweak panel both read.
//
// Keyframes rather than a formula because sunrise and sunset are where all the interest is: an
// analytic curve spends most of its range on a flat blue afternoon and rushes the two minutes
// that actually look like something.

const SUN_RADIUS = SPAN * 1.2;

/** One full day, in real seconds. Short enough that a single fare sees the light change. */
export const DAY_SECONDS = 180;

const KEYS = [
  { hour: 0,    top: '#0A1320', bottom: '#16202E', sun: '#2A3550', power: 0.00, fill: 0.34, sky: '#33506E', ground: '#141C26' },
  { hour: 5,    top: '#16273F', bottom: '#33354C', sun: '#5A4C6E', power: 0.10, fill: 0.42, sky: '#4A5A78', ground: '#1E222C' },
  { hour: 6.5,  top: '#3E6EA0', bottom: '#F0B080', sun: '#FFB05A', power: 2.10, fill: 0.95, sky: '#E8BFA0', ground: '#5E5245' },
  { hour: 9,    top: '#65A0CE', bottom: '#CFE0EA', sun: '#FFF0D2', power: 3.60, fill: 1.40, sky: '#DCEAF4', ground: '#7A7A6E' },
  { hour: 13,   top: '#6FA9D4', bottom: '#CDE3EE', sun: '#FFF4DE', power: 3.85, fill: 1.55, sky: '#D6E8F4', ground: '#84847A' },
  // The parked look — this is the sky the game actually ships with, since the cycle is off by
  // default and createDaylight() applies this keyframe on construction. Light blue rather than the
  // warm haze the rest of late afternoon has; see the note in palette.js. The sun and fill stay
  // golden, so only the backdrop changed.
  { hour: 16.4, top: '#8CC4E8', bottom: '#DCEDF7', sun: '#FFDEBB', power: 3.55, fill: 1.50, sky: '#F0C79B', ground: '#6B5A48' },
  { hour: 18.6, top: '#35507E', bottom: '#F09A60', sun: '#FF8C46', power: 1.70, fill: 0.88, sky: '#E8A276', ground: '#4E4038' },
  { hour: 20,   top: '#1B2A44', bottom: '#40395A', sun: '#4A4060', power: 0.28, fill: 0.48, sky: '#5A5A7A', ground: '#232630' },
  { hour: 24,   top: '#0A1320', bottom: '#16202E', sun: '#2A3550', power: 0.00, fill: 0.34, sky: '#33506E', ground: '#141C26' },
];

/** Sun angle above the horizon. Clamped low rather than negative — at night `power` is 0 anyway,
 *  and a light below the ground plane throws shadows upward through everything. */
const elevationAt = (hour) => Math.max(6, 70 * Math.sin(Math.PI * (hour - 6) / 12));

/** Swings through the day so shadows sweep rather than sitting still. */
const azimuthAt = (hour) => 10 + THREE.MathUtils.clamp((hour - 6) / 12, 0, 1) * 165;

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
    fill: THREE.MathUtils.lerp(a.fill, b.fill, t),
  };
}

/**
 * @param fog  the scene's haze, or null. Its colour is derived from the same two keyframe colours
 *             the dome is drawn from, through `hazeColor()` — the sky sampled a little above the
 *             skyline, with its chroma restored. See the long note on that function for why it is
 *             not simply `bottom`.
 *
 *             Derived rather than carried as a keyframe field of its own, and that is the load-
 *             bearing part: a haze that is a *function* of the sky cannot drift away from it. A
 *             tint picked at golden hour and left alone is a pale blue wash over a midnight city.
 */
export function createDaylight({ sun, hemi, sky, fog = null }, startHour = 16.4) {
  const state = { hour: startHour, cycling: true, dayLength: DAY_SECONDS };

  function apply(hour = state.hour) {
    state.hour = ((hour % 24) + 24) % 24;
    const look = sample(state.hour);

    const e = THREE.MathUtils.degToRad(elevationAt(state.hour));
    const a = THREE.MathUtils.degToRad(azimuthAt(state.hour));
    sun.position.set(
      Math.cos(a) * Math.cos(e) * SUN_RADIUS,
      Math.sin(e) * SUN_RADIUS,
      Math.sin(a) * Math.cos(e) * SUN_RADIUS,
    );
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();

    sun.color.copy(look.sun);
    sun.intensity = look.power;
    hemi.color.copy(look.hemiSky);
    hemi.groundColor.copy(look.hemiGround);
    hemi.intensity = look.fill;
    sky.uniforms.topColor.value.copy(look.top);
    sky.uniforms.bottomColor.value.copy(look.bottom);
    if (fog) hazeColor(look.top, look.bottom, fog.color);

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
    setCycling: (on) => { state.cycling = on; },
    setDayLength: (seconds) => { state.dayLength = Math.max(10, seconds); },
    elevation: () => elevationAt(state.hour),
  };
}

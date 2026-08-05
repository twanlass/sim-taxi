import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, bakeGradient } from '../util/geo.js';
import { color } from '../palette.js';
import { CHASSIS_LIFT } from './wheels.js';

// Every vehicle's night rig, as one merged geometry: two headlight lenses, two tail lights, a
// cone of lit air out of each headlight, and a wedge of light on the road ahead.
//
// Built in car-local space, where **+X is forward** (`dirYaw(0) === 0`, and a yaw rotation about
// Y sends local +X to `(cos yaw, 0, -sin yaw)` — the same basis the tailpipe flame in main.js
// uses with the sign flipped).
//
// One geometry and one additive material for the whole rig, so a hundred cars' worth of lights is
// one instanced draw. Additive throughout: light lands *on* the road, the kerb and the car in
// front, and it must not hide the lane markings it crosses.

/** How far the wedge on the road reaches. Roughly two car lengths — far enough to read as a beam
 *  at play zoom, short enough that the far end is still in front of the car it belongs to when
 *  traffic is queued at a light. */
const BEAM_LEN = 7.4;
const BEAM_NEAR_W = 0.72;      // half-width where it leaves the bumper
const BEAM_FAR_W = 2.9;        // half-width where it fades out
/** Peak additive strength at the bumper. Deliberately under half: two cars nose to tail must not
 *  stack into a white patch, and this is drawn over asphalt that already has the moon on it. */
const BEAM_PEAK = 0.42;

/** Length and spread of the lit air above the wedge, per headlight. */
const CONE_LEN = 5.6;
const CONE_R = 0.92;
const CONE_PEAK = 0.2;

/**
 * The wedge of light on the tarmac, as an explicit triangle strip.
 *
 * A strip rather than one quad because the falloff is not linear, and a two-triangle quad can only
 * interpolate its four corners — the beam would come out as a flat sheet with a hard end. Ten
 * steps is enough that the gradient reads as a gradient.
 *
 * Its own strip rather than a PlaneGeometry with the vertices pushed around: the shape widens as
 * it goes, so every row needs a different half-width, and writing the positions directly is
 * shorter than remapping a grid.
 */
function beamStrip(x0, y) {
  const STEPS = 10;
  const positions = [];
  const weights = [];

  const at = (n) => {
    const t = n / STEPS;
    return {
      x: x0 + t * BEAM_LEN,
      w: THREE.MathUtils.lerp(BEAM_NEAR_W, BEAM_FAR_W, t),
      // Square falloff, so the near half carries the brightness and the far end arrives at zero
      // rather than stopping at a visible line across the road.
      k: BEAM_PEAK * (1 - t) ** 2,
    };
  };

  for (let n = 0; n < STEPS; n++) {
    const a = at(n);
    const b = at(n + 1);
    // Wound so the face normal points up (+Y) with three's default counter-clockwise front.
    positions.push(a.x, y, -a.w, a.x, y, a.w, b.x, y, -b.w);
    weights.push(a.k, a.k, b.k);
    positions.push(b.x, y, -b.w, a.x, y, a.w, b.x, y, b.w);
    weights.push(b.k, a.k, b.k);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const c = color('headlight');
  const colors = new Float32Array(weights.length * 3);
  for (let i = 0; i < weights.length; i++) {
    colors[i * 3] = c.r * weights[i];
    colors[i * 3 + 1] = c.g * weights[i];
    colors[i * 3 + 2] = c.b * weights[i];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * @param len    car length along X
 * @param width  car width along Z
 * @param beam   include the wedge on the road. Off for anything whose rig has to hang off a body
 *               that rolls and pitches — see the note in sim/traffic.js about why the rig is
 *               normally carried on an upright node instead.
 */
export function carLightGeometry(len, width, { beam = true } = {}) {
  const parts = [];

  const nose = len / 2;
  const tail = -len / 2;
  const lampY = 0.72 + CHASSIS_LIFT;
  const lampZ = width / 2 - 0.34;

  for (const side of [-1, 1]) {
    // The lens itself. Sits a hair proud of the bumper so it is never z-fighting the body it is
    // set into, and reads as the one genuinely bright point on the car at play zoom.
    const lens = new THREE.BoxGeometry(0.14, 0.24, 0.36);
    lens.translate(nose + 0.03, lampY, side * lampZ);
    parts.push(bakeColor(lens, color('headlight')));

    const rear = new THREE.BoxGeometry(0.12, 0.2, 0.32);
    rear.translate(tail - 0.03, lampY, side * lampZ);
    // Two thirds strength. A tail light that matches the headlight for brightness makes it
    // genuinely hard to tell at a glance which way a car three blocks away is pointing.
    parts.push(bakeGradient(rear, color('tailLight'), () => 0.66));

    // Lit air. `ConeGeometry` is built about +Y with its apex at +h/2, so a +90° turn about Z
    // sends the apex to -X; centring it half a length ahead of the lens puts the point *at* the
    // lamp and the mouth out in front of the car.
    const cone = new THREE.ConeGeometry(CONE_R, CONE_LEN, 7, 1, true);
    cone.rotateZ(Math.PI / 2);
    const apexX = nose + 0.05;
    cone.translate(apexX + CONE_LEN / 2, lampY - 0.08, side * lampZ);
    parts.push(bakeGradient(cone, color('headlight'),
      (px) => CONE_PEAK * Math.max(0, 1 - (px - apexX) / CONE_LEN) ** 1.6));
  }

  // One wedge across both lamps rather than one each. Two overlapping wedges double the additive
  // strength down the middle of the road, which is where the taxi's own lane markings are.
  if (beam) parts.push(beamStrip(nose, 0.06));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

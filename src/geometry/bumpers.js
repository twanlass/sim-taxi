import * as THREE from 'three';
import { bakeColor, setFinish, FINISH } from '../util/geo.js';
import { color } from '../palette.js';
import { CHASSIS_LIFT } from './wheels.js';

// Chrome bumpers, a thin bar across each end of every road vehicle: the fleet's cars and truck
// cabs (sim/traffic.js), the cop cars and the cruiser built off them (sim/police.js), and the taxi
// (geometry/taxi.js), which also hangs this same bar off one corner once it has been knocked loose.
//
// Its own module beside wheels.js and lights.js for the same import-cycle reason they are.
//
// Tagged `FINISH.METAL`, the hubcaps' finish, and that is what keeps them chrome on a red car: the
// fleet is one instanced mesh tinted per car, and the gloss shader leaves the instance tint off
// metal (`propMaterial({ gloss })`, util/geo.js). Without that a bumper comes out the car's colour.

export const BUMPER_H = 0.14;                  // tall — ~1px at play zoom, so it reads as a line
export const BUMPER_D = 0.12;                  // fore-aft, of which BUMPER_SINK is inside the body
const BUMPER_SINK = 0.02;
// The bottom of the body (`SILL_Y`) plus a little: low on the end face, under the light pods'
// centres (LIGHT_Y, geometry/lights.js), the way a real bumper sits under its lamps.
export const BUMPER_Y = 0.46 + CHASSIS_LIFT;

/** How far across the car a bumper runs — short of the flanks, so it never lies on one. */
export function bumperLength(width) {
  return width * 0.9;
}

/**
 * One bumper, `end` +1 the nose and −1 the tail, in car-local space (+x is the nose). Its inner
 * face is buried `BUMPER_SINK` in the end of the body rather than laid on it — two faces at one
 * depth are a shimmer (CLAUDE.md).
 */
export function bumperGeometry(len, width, end) {
  const bar = new THREE.BoxGeometry(BUMPER_D, BUMPER_H, bumperLength(width));
  bar.translate(end * (len / 2 + BUMPER_D / 2 - BUMPER_SINK), BUMPER_Y, 0);
  return setFinish(bakeColor(bar, color('bumperChrome')), FINISH.METAL);
}

/** Both bumpers, for merging into a body. */
export function bumperGeometries(len, width) {
  return [1, -1].map((end) => bumperGeometry(len, width, end));
}

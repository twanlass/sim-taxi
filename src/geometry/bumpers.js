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

// 0.14 by 0.12 at first, which at play zoom (1 unit ≈ 7.7px) is a one-pixel line: chrome you had to
// look for. Chunkier reads as a bumper rather than as trim.
export const BUMPER_H = 0.2;                   // tall — ~1.5px at play zoom
export const BUMPER_D = 0.16;                  // fore-aft, of which BUMPER_SINK is inside the body
const BUMPER_SINK = 0.02;
// Low on the end face, the way a real bumper sits under its lamps (LIGHT_Y, geometry/lights.js). Its
// underside is 0.01 above the bottom of the body (`SILL_Y`) rather than level with it: level is two
// faces on one plane where the bar's buried inner edge overlaps the body.
export const BUMPER_Y = 0.49 + CHASSIS_LIFT;

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

/**
 * Where bumper `end` sits on a body `len` long, car-local — the centre of the bar
 * `bumperGeometry` bakes in. For the fleet, which draws its bumpers as instances of one centred bar
 * (sim/traffic.js) so a car the taxi has hit can hang one off a corner (game/cardamage.js).
 */
export function bumperAt(len, end, target) {
  return target.set(end * (len / 2 + BUMPER_D / 2 - BUMPER_SINK), BUMPER_Y, 0);
}

/** Both bumpers, for merging into a body. */
export function bumperGeometries(len, width) {
  return [1, -1].map((end) => bumperGeometry(len, width, end));
}

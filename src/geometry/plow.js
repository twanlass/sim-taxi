import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, unlitMaterial, setFinish, FINISH, BODY_EULER_ORDER } from '../util/geo.js';
import { color } from '../palette.js';
import { outlineVehicle, VEHICLE_RIM, WHEEL_RIM } from './ghostoutline.js';
import {
  SILL_Y, CHASSIS_LIFT, wheelAnchors, wheelGeometry, wheelGeometries, archedBodyGeometries,
} from './wheels.js';

// The Snow Day's snowplow (game/plow.js drives it; this only builds it). Same frame as every
// vehicle in sim/traffic.js — **+X forward, +Y up, origin on the road at the middle of the
// wheelbase** — on a box truck's footprint (`TRUCK_LEN`, `TRUCK_W`), since that is what the traffic
// model follows it at and what the taxi bumps into. The blade hangs off the nose past that
// footprint, angled across the lane, the one shape that says "plow" from this camera; behind the
// cab, a salt hopper in place of a box.
//
// Built the garbage truck's way (geometry/garbage.js): one merged body under the vehicles' gloss,
// the front wheels separate so they steer, the beacon's lamp its own unlit mesh switched by
// `visible`, the whole thing dissolved in and out by alphaHash.

export const PLOW_LEN = 5.6;          // = TRUCK_LEN
export const PLOW_W = 2.0;            // = TRUCK_W
const BASE_Y = 0.78 + CHASSIS_LIFT;
const CHASSIS_TOP = BASE_Y + 0.4;
const CAB_LEN = 1.6;
const CAB_H = 1.2;
const CAB_X = PLOW_LEN / 2 - CAB_LEN / 2 - 0.05;
const CAB_Y = CHASSIS_TOP + CAB_H / 2;
const CAB_TOP = CHASSIS_TOP + CAB_H;
const HOPPER_X0 = -PLOW_LEN / 2 + 0.1;
const HOPPER_X1 = CAB_X - CAB_LEN / 2 - 0.12;
const HOPPER_H = 1.25;
/** The blade: how far ahead of the nose, how wide across, its height, and its angle off square. */
const BLADE_OUT = 0.55;
export const BLADE_W = 2.9;
const BLADE_H = 0.75;
export const BLADE_ANGLE = 0.32;
const BEACON = { w: 0.28, h: 0.16, d: 0.36, x: CAB_X - 0.25 };

function box(w, h, d, x, y, z, paint, finish = FINISH.PAINT) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return setFinish(bakeColor(geometry, color(paint)), finish);
}

function merge(parts) {
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

function bodyGeometry() {
  const W = PLOW_W;
  const parts = [
    ...archedBodyGeometries(PLOW_LEN, W, BASE_Y, 0.8, color('plowBody')),
    box(CAB_LEN, CAB_H, W * 0.96, CAB_X, CAB_Y, 0, 'plowCab'),
    box(0.08, 0.55, W * 0.82, CAB_X + CAB_LEN / 2 + 0.02, CAB_Y + 0.22, 0, 'carGlass', FINISH.GLASS),
    box(0.85, 0.48, W * 0.96 + 0.04, CAB_X + 0.22, CAB_Y + 0.24, 0, 'carGlass', FINISH.GLASS),
    box(BEACON.w, BEACON.h, BEACON.d, BEACON.x, CAB_TOP + BEACON.h / 2, 0, 'garbageBeacon'),
    // The salt hopper: a tapered bin read as a box with a lip, grey steel.
    box(HOPPER_X1 - HOPPER_X0, HOPPER_H, W * 0.94, (HOPPER_X0 + HOPPER_X1) / 2, CHASSIS_TOP + HOPPER_H / 2, 0,
      'plowHopper', FINISH.METAL),
    box(HOPPER_X1 - HOPPER_X0 + 0.06, 0.1, W * 0.98, (HOPPER_X0 + HOPPER_X1) / 2, CHASSIS_TOP + HOPPER_H + 0.05, 0,
      'plowBody'),
    // The blade's push frame, from the bumper out to the blade.
    box(BLADE_OUT + 0.1, 0.16, 0.9, PLOW_LEN / 2 + BLADE_OUT / 2, BASE_Y - 0.15, 0, 'plowBladeEdge', FINISH.METAL),
  ];
  parts.push(...wheelGeometries(PLOW_LEN, PLOW_W));
  return merge(parts);
}

/** The blade, about its own middle, turned across the lane: yellow face, dark cutting edge. */
function bladeGeometry() {
  const face = box(0.14, BLADE_H, BLADE_W, 0, BLADE_H / 2 + 0.12, 0, 'plowBlade');
  const edge = box(0.18, 0.12, BLADE_W + 0.04, 0.02, 0.06, 0, 'plowBladeEdge', FINISH.METAL);
  const geometry = merge([face, edge]);
  geometry.rotateY(BLADE_ANGLE);
  geometry.translate(PLOW_LEN / 2 + BLADE_OUT, 0.02, 0);
  return geometry;
}

export function createPlowMesh() {
  const group = new THREE.Group();
  group.name = 'snowplow';
  group.rotation.order = BODY_EULER_ORDER;
  const shell = new THREE.Group();
  group.add(shell);

  const bodyGeo = bodyGeometry();
  const body = new THREE.Mesh(bodyGeo, propMaterial({ gloss: { geometry: bodyGeo, floor: SILL_Y } }));
  body.castShadow = true;
  body.receiveShadow = true;
  shell.add(body);

  const bladeGeo = bladeGeometry();
  const blade = new THREE.Mesh(bladeGeo, propMaterial({ gloss: { geometry: bladeGeo } }));
  blade.castShadow = true;
  blade.receiveShadow = true;
  shell.add(blade);

  const wheelGeo = wheelGeometry();
  const wheelMat = propMaterial({ gloss: { geometry: wheelGeo } });
  wheelMat.color.set(color('plowBody'));
  const wheels = wheelAnchors(PLOW_LEN, PLOW_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      shell.add(wheel);
      return wheel;
    });

  const beaconGeo = new THREE.BoxGeometry(BEACON.w + 0.04, BEACON.h + 0.02, BEACON.d + 0.04);
  const beacon = new THREE.Mesh(beaconGeo, unlitMaterial({ color: color('garbageBeaconLit') }));
  beacon.position.set(BEACON.x, CAB_TOP + BEACON.h / 2 + 0.01, 0);
  beacon.visible = false;
  shell.add(beacon);

  const faders = [body.material, blade.material, wheelMat];
  for (const material of faders) material.alphaHash = true;
  outlineVehicle(group, {
    rims: [[body, VEHICLE_RIM], [blade, WHEEL_RIM], ...wheels.map((w) => [w, WHEEL_RIM])],
    tint: color('plowGhost'),
  });
  shell.visible = false;

  return { group, shell, body, blade, wheels, beacon, faders, occluders: [body, blade, ...wheels] };
}

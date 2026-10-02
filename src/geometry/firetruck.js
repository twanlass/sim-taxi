import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, setFinish, FINISH, BODY_EULER_ORDER } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { SILL_Y, CHASSIS_LIFT, wheelAnchors, wheelGeometry, wheelGeometries } from './wheels.js';
import { sirenPodGeometry, sirenRedMaterial } from './lights.js';

// The fire engine: a red cab-forward truck with a white band down each flank, aluminium locker
// doors, a light bar on the cab roof and a ladder on a turntable at the back that swings round and
// lifts to point the hose at the fire. game/fire.js drives it; this only builds it.
//
// Same frame as every vehicle in sim/traffic.js — **+X forward, +Y up, origin on the road at the
// middle of the wheelbase** — and the same footprint as a box truck (`TRUCK_LEN`, `TRUCK_W`), since
// it is a box truck as far as the traffic model is concerned: that is the length it follows at and
// the envelope the taxi bumps into. The ladder is what makes it longer than the box truck it
// replaces on screen, and it overhangs the cab rather than the tail, so nothing behind the truck is
// drawn into.

export const ENGINE_LEN = 5.6;         // = TRUCK_LEN; restated so geometry/ need not import sim/
export const ENGINE_W = 2.0;           // = TRUCK_W
const BASE_Y = 0.78 + CHASSIS_LIFT;    // the chassis centre, where a car's body rides
const CHASSIS_TOP = BASE_Y + 0.4;

const CAB_LEN = 1.55;
const CAB_H = 1.15;
const CAB_X = ENGINE_LEN / 2 - CAB_LEN / 2 - 0.05;
const CAB_Y = CHASSIS_TOP + CAB_H / 2;
const CAB_TOP = CHASSIS_TOP + CAB_H;

// The locker body behind the cab, and the deck the turntable stands on.
const LOCKER_X0 = -ENGINE_LEN / 2 + 0.1;
const LOCKER_X1 = CAB_X - CAB_LEN / 2 - 0.08;
const LOCKER_H = 0.95;
const LOCKER_TOP = CHASSIS_TOP + LOCKER_H;

// The ladder pivots on a turntable over the back axle and lies forward over the cab at rest. Its
// rails ride `LADDER_CLEAR` over the cab roof, and it stops short of the light bar at the front of
// that roof, so at rest nothing it carries passes through anything else.
const TURNTABLE_X = LOCKER_X0 + 0.75;
const TURNTABLE_H = 0.28;
const PIVOT_Y = LOCKER_TOP + TURNTABLE_H;
const LADDER_CLEAR = 0.2;
export const LADDER_LEN = 3.9;
const RAIL_Y = CAB_TOP + LADDER_CLEAR - PIVOT_Y;   // the rails' height in the pivot's frame
const RAIL_GAP = 0.36;
const RUNG_PITCH = 0.42;
const BAR_X = CAB_X + CAB_LEN / 2 - 0.3;

/** A box, baked one colour and finish, centred where it is told. */
function box(w, h, d, x, y, z, paint, finish = FINISH.PAINT) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return setFinish(bakeColor(geometry, color(paint)), finish);
}

function bodyGeometry() {
  const W = ENGINE_W;
  const parts = [
    box(ENGINE_LEN, 0.8, W, 0, BASE_Y, 0, 'fireTruckBody'),
    box(CAB_LEN, CAB_H, W * 0.96, CAB_X, CAB_Y, 0, 'fireTruckBody'),
    // Glass: the windscreen proud of the cab's nose, and a side window standing out of both flanks.
    box(0.08, 0.55, W * 0.82, CAB_X + CAB_LEN / 2 + 0.02, CAB_Y + 0.22, 0, 'carGlass', FINISH.GLASS),
    box(0.85, 0.48, W * 0.96 + 0.04, CAB_X + 0.2, CAB_Y + 0.24, 0, 'carGlass', FINISH.GLASS),
    // The locker body, a shade deeper than the cab so the two masses read apart from above.
    box(LOCKER_X1 - LOCKER_X0, LOCKER_H, W * 0.96, (LOCKER_X0 + LOCKER_X1) / 2,
      CHASSIS_TOP + LOCKER_H / 2, 0, 'fireTruckLocker'),
    // The white band, sleeved round the chassis: its top, bottom and ends are all buried in it.
    box(ENGINE_LEN - 0.1, 0.18, W + 0.04, 0, BASE_Y + 0.12, 0, 'fireTruckTrim'),
    // Front bumper, proud of the nose.
    box(0.14, 0.26, W * 0.92, ENGINE_LEN / 2 + 0.05, BASE_Y - 0.2, 0, 'fireTruckLadder', FINISH.METAL),
    // The bar's housing, on the front of the cab roof.
    box(0.34, 0.12, 1.1, BAR_X, CAB_TOP + 0.06, 0, 'sirenHousing'),
  ];
  // Three roller doors per side, in bare aluminium, proud of the locker flanks.
  const span = LOCKER_X1 - LOCKER_X0;
  const doors = 3;
  const doorLen = span / doors - 0.14;
  for (let k = 0; k < doors; k++) {
    const x = LOCKER_X0 + (k + 0.5) * (span / doors);
    parts.push(box(doorLen, LOCKER_H * 0.7, W * 0.96 + 0.04, x, CHASSIS_TOP + LOCKER_H * 0.47, 0,
      'fireTruckLadder', FINISH.METAL));
  }
  // The turntable: a squat drum on the locker roof.
  const drum = new THREE.CylinderGeometry(0.42, 0.46, TURNTABLE_H, 10);
  drum.translate(TURNTABLE_X, LOCKER_TOP + TURNTABLE_H / 2, 0);
  parts.push(setFinish(bakeColor(drum, color('sirenHousing')), FINISH.METAL));
  parts.push(...wheelGeometries(ENGINE_LEN, ENGINE_W));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * The ladder in its pivot's frame: the origin on top of the turntable, laid along +X. Rails, rungs
 * every RUNG_PITCH, a pair of struts down to the pivot at the heel, and the monitor nozzle at the
 * tip. Rotating the pitch group about Z lifts the tip; the yaw group above it swings the whole lot.
 */
function ladderGeometry() {
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push(box(LADDER_LEN, 0.1, 0.08, LADDER_LEN / 2, RAIL_Y, side * RAIL_GAP, 'fireTruckLadder', FINISH.METAL));
    // Heel struts from the turntable up to the rails.
    parts.push(box(0.12, RAIL_Y, 0.1, 0.1, RAIL_Y / 2, side * RAIL_GAP, 'fireTruckLadder', FINISH.METAL));
  }
  for (let x = 0.3; x < LADDER_LEN - 0.1; x += RUNG_PITCH) {
    parts.push(box(0.05, 0.05, RAIL_GAP * 2, x, RAIL_Y, 0, 'fireTruckLadder', FINISH.METAL));
  }
  // The monitor at the tip, in red so the business end reads against the aluminium.
  parts.push(box(0.3, 0.2, 0.26, LADDER_LEN, RAIL_Y + 0.1, 0, 'fireTruckBody'));
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Where the water leaves the nozzle, in the ladder's pitch frame. */
export const NOZZLE_LOCAL = new THREE.Vector3(LADDER_LEN + 0.2, RAIL_Y + 0.12, 0);

/**
 * One engine, ready to be posed by the traffic model through `skin`.
 *
 * Same shell arrangement as the patrol cruiser (sim/police.js): the group stays visible for the
 * whole run and only `shell` is switched, so nothing in here can change the scene's light count.
 * There are no point lights on it — the bar's spill comes from the bloom, which is enough at the
 * size an engine is on screen and costs no lit program anything.
 */
export function createFireTruckMesh() {
  const group = new THREE.Group();
  group.name = 'fire-engine';
  group.rotation.order = BODY_EULER_ORDER;
  const shell = new THREE.Group();
  group.add(shell);

  const bodyGeo = bodyGeometry();
  const body = new THREE.Mesh(bodyGeo, propMaterial({ gloss: { geometry: bodyGeo, floor: SILL_Y } }));
  body.castShadow = true;
  body.receiveShadow = true;
  shell.add(body);

  // Front wheels, steered by the skin. Tinted like the fleet's: `wheelGeometry()` is baked neutral.
  const wheelGeo = wheelGeometry();
  const wheelMat = propMaterial({ gloss: { geometry: wheelGeo } });
  wheelMat.color.set(PALETTE.fireTruckBody);
  const wheels = wheelAnchors(ENGINE_LEN, ENGINE_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      shell.add(wheel);
      return wheel;
    });

  // The ladder: yaw about the turntable, then pitch about its heel.
  const ladderYaw = new THREE.Group();
  ladderYaw.position.set(TURNTABLE_X, PIVOT_Y, 0);
  const ladderPitch = new THREE.Group();
  ladderYaw.add(ladderPitch);
  const ladderGeo = ladderGeometry();
  const ladder = new THREE.Mesh(ladderGeo, propMaterial({ gloss: { geometry: ladderGeo } }));
  ladder.castShadow = true;
  ladder.receiveShadow = true;
  ladderPitch.add(ladder);
  shell.add(ladderYaw);
  const nozzle = new THREE.Object3D();
  nozzle.position.copy(NOZZLE_LOCAL);
  ladderPitch.add(nozzle);

  // Two red lamps on the bar, lit alternately. Switched by `visible`, never a scale — see lights.js.
  const pod = (z) => {
    const mesh = new THREE.Mesh(sirenPodGeometry(), sirenRedMaterial());
    mesh.position.set(BAR_X, CAB_TOP + 0.12 + 0.1, z);
    mesh.visible = false;
    shell.add(mesh);
    return mesh;
  };
  const pods = [pod(-0.36), pod(0.36)];

  // Dissolved in and out rather than blended — see `faders` in sim/police.js for why alphaHash.
  const faders = [body.material, wheelMat, ladder.material, ...pods.map((p) => p.material)];
  for (const material of faders) material.alphaHash = true;
  shell.visible = false;

  return {
    group, shell, body, wheels, ladderYaw, ladderPitch, nozzle, pods, faders,
    /** Every solid part, for the AO prepass. */
    occluders: [body, ladder, ...wheels],
  };
}

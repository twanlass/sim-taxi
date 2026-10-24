import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  bakeColor, bakeColors, propMaterial, unlitMaterial, setFinish, FINISH, BODY_EULER_ORDER,
} from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import {
  SILL_Y, CHASSIS_LIFT, wheelAnchors, wheelGeometry, wheelGeometries, archedBodyGeometries,
} from './wheels.js';

// The bag piles on the kerb and the garbage truck that comes round for them (game/garbage.js
// drives both; this only builds them).
//
// The truck is in the same frame as every vehicle in sim/traffic.js — **+X forward, +Y up, origin
// on the road at the middle of the wheelbase** — and on a box truck's footprint (`TRUCK_LEN`,
// `TRUCK_W`), since that is what the traffic model follows it at and what the taxi bumps into.
//
// **The hopper opens at the top, not the back.** A real rear-loader's mouth is in its tail, and
// this camera never sees a tail: every pile stands on a block's +X kerb, so the truck that stops
// beside one is heading +Z, and its back faces −Z — away from a view that looks down the −X−Z
// diagonal. So the hopper is an open box behind the body with a lid hinged at its front edge, and
// what the player sees is the lid swinging up, the bags arcing in over the side, and the lid
// slamming shut on them. All of which happens on the faces the camera can see: the top and the
// truck's left flank.

export const GARBAGE_LEN = 5.6;        // = TRUCK_LEN; restated so geometry/ need not import sim/
export const GARBAGE_W = 2.0;          // = TRUCK_W
const BASE_Y = 0.78 + CHASSIS_LIFT;    // the chassis centre, where a car's body rides
const CHASSIS_TOP = BASE_Y + 0.4;

const CAB_LEN = 1.45;
const CAB_H = 1.15;
const CAB_X = GARBAGE_LEN / 2 - CAB_LEN / 2 - 0.05;
const CAB_Y = CHASSIS_TOP + CAB_H / 2;
const CAB_TOP = CHASSIS_TOP + CAB_H;

// The hopper at the tail, the packer body between it and the cab. The body stands taller than the
// cab, which is the silhouette that says "garbage truck" from any angle.
export const HOPPER_LEN = 1.3;
const HOPPER_X0 = -GARBAGE_LEN / 2;
const HOPPER_X1 = HOPPER_X0 + HOPPER_LEN;
const HOPPER_H = 1.15;
const HOPPER_TOP = CHASSIS_TOP + HOPPER_H;
const WALL = 0.12;
const BODY_X0 = HOPPER_X1;
const BODY_X1 = CAB_X - CAB_LEN / 2 - 0.08;
const BODY_H = 1.6;
const BODY_TOP = CHASSIS_TOP + BODY_H;

/**
 * Where a bag lands in the hopper, in the truck's frame — the middle of its open top, a little
 * below the rim. game/garbage.js aims the arcs at this, and stops the truck so that it is level
 * with the pile.
 */
export const HOPPER_MOUTH = new THREE.Vector3((HOPPER_X0 + HOPPER_X1) / 2, CHASSIS_TOP + 0.75, 0);
const BEACON = { w: 0.26, h: 0.16, d: 0.36, x: CAB_X - 0.2 };

/** How far the lid swings up when the truck is taking bags, in radians. */
export const LID_OPEN = 1.2;

/** A box, baked one colour and finish, centred where it is told. */
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
  const W = GARBAGE_W;
  const inner = W - 2 * WALL;
  const parts = [
    ...archedBodyGeometries(GARBAGE_LEN, W, BASE_Y, 0.8, color('garbageHopper')),
    box(CAB_LEN, CAB_H, W * 0.96, CAB_X, CAB_Y, 0, 'garbageCab'),
    // Glass: the windscreen proud of the cab's nose, and a side window standing out of both flanks.
    box(0.08, 0.52, W * 0.82, CAB_X + CAB_LEN / 2 + 0.02, CAB_Y + 0.22, 0, 'carGlass', FINISH.GLASS),
    box(0.8, 0.46, W * 0.96 + 0.04, CAB_X + 0.22, CAB_Y + 0.24, 0, 'carGlass', FINISH.GLASS),
    // The amber beacon's housing on the cab roof, dark; the lamp that flashes is its own mesh.
    box(BEACON.w, BEACON.h, BEACON.d, BEACON.x, CAB_TOP + BEACON.h / 2, 0, 'garbageBeacon'),
    // The packer body.
    box(BODY_X1 - BODY_X0, BODY_H, W * 0.98, (BODY_X0 + BODY_X1) / 2, CHASSIS_TOP + BODY_H / 2, 0,
      'garbageBody'),
    // A white band down each flank, proud of the body by 0.02.
    box(BODY_X1 - BODY_X0 - 0.2, 0.22, W * 0.98 + 0.04, (BODY_X0 + BODY_X1) / 2,
      CHASSIS_TOP + BODY_H * 0.55, 0, 'garbageStripe'),
    // The hopper: two side walls, a lower back wall, and a dark well between them that reads as
    // the inside from above. The well's top sits well under the rim so the walls have depth.
    box(HOPPER_LEN, HOPPER_H, WALL, (HOPPER_X0 + HOPPER_X1) / 2, CHASSIS_TOP + HOPPER_H / 2,
      W / 2 - WALL / 2, 'garbageHopper'),
    box(HOPPER_LEN, HOPPER_H, WALL, (HOPPER_X0 + HOPPER_X1) / 2, CHASSIS_TOP + HOPPER_H / 2,
      -W / 2 + WALL / 2, 'garbageHopper'),
    box(WALL, HOPPER_H * 0.78, inner, HOPPER_X0 + WALL / 2, CHASSIS_TOP + HOPPER_H * 0.39, 0, 'garbageHopper'),
    box(HOPPER_LEN - WALL, 0.55, inner, (HOPPER_X0 + WALL + HOPPER_X1) / 2, CHASSIS_TOP + 0.275, 0,
      'garbageMouth', FINISH.MATTE),
    // The riding step across the tail, and the front bumper.
    box(0.22, 0.1, W * 0.9, HOPPER_X0 - 0.08, CHASSIS_TOP - 0.1, 0, 'garbageMetal', FINISH.METAL),
    box(0.14, 0.26, W * 0.92, GARBAGE_LEN / 2 + 0.05, BASE_Y - 0.2, 0, 'garbageMetal', FINISH.METAL),
  ];
  // Three ribs up each flank of the body, the darker green, proud of it by 0.03.
  for (let k = 0; k < 3; k++) {
    const x = BODY_X0 + (k + 0.5) * ((BODY_X1 - BODY_X0) / 3);
    parts.push(box(0.1, BODY_H - 0.1, W * 0.98 + 0.06, x, CHASSIS_TOP + BODY_H / 2, 0, 'garbageHopper'));
  }
  parts.push(...wheelGeometries(GARBAGE_LEN, GARBAGE_W));
  return merge(parts);
}

/** The lid, in its hinge's frame: the hinge on the origin, the lid lying back along −X. */
function lidGeometry() {
  const parts = [
    box(HOPPER_LEN + 0.04, 0.08, GARBAGE_W, -(HOPPER_LEN + 0.04) / 2, 0.04, 0, 'garbageBody'),
    // A grab rail along its trailing edge, which is also what catches the light as it swings.
    box(0.06, 0.06, GARBAGE_W * 0.8, -HOPPER_LEN + 0.02, 0.11, 0, 'garbageMetal', FINISH.METAL),
  ];
  return merge(parts);
}

/**
 * One truck, ready to be posed by the traffic model through `skin`. Same shell arrangement as the
 * fire engine (geometry/firetruck.js): the group stays visible and only `shell` is switched, and
 * there are no lights on it to change the scene's light count.
 */
export function createGarbageTruckMesh() {
  const group = new THREE.Group();
  group.name = 'garbage-truck';
  group.rotation.order = BODY_EULER_ORDER;
  const shell = new THREE.Group();
  group.add(shell);

  const bodyGeo = bodyGeometry();
  const body = new THREE.Mesh(bodyGeo, propMaterial({ gloss: { geometry: bodyGeo, floor: SILL_Y } }));
  body.castShadow = true;
  body.receiveShadow = true;
  shell.add(body);

  const wheelGeo = wheelGeometry();
  const wheelMat = propMaterial({ gloss: { geometry: wheelGeo } });
  wheelMat.color.set(PALETTE.garbageHopper);
  const wheels = wheelAnchors(GARBAGE_LEN, GARBAGE_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      shell.add(wheel);
      return wheel;
    });

  // The lid hinges on the top of the hopper's front edge, against the body.
  const hinge = new THREE.Group();
  hinge.position.set(HOPPER_X1, HOPPER_TOP, 0);
  const lidGeo = lidGeometry();
  const lid = new THREE.Mesh(lidGeo, propMaterial({ gloss: { geometry: lidGeo } }));
  lid.castShadow = true;
  lid.receiveShadow = true;
  hinge.add(lid);
  shell.add(hinge);

  // The beacon's lit lamp, a hair proud of the housing on every side, switched by `visible` while
  // the truck collects — never a scale (geometry/lights.js). Unlit, so it reads as a lamp in shade
  // and at night, and main.js puts it in the bloom.
  const beaconGeo = new THREE.BoxGeometry(BEACON.w + 0.04, BEACON.h + 0.02, BEACON.d + 0.04);
  const beacon = new THREE.Mesh(beaconGeo, unlitMaterial({ color: PALETTE.garbageBeaconLit }));
  beacon.position.set(BEACON.x, CAB_TOP + BEACON.h / 2 + 0.01, 0);
  beacon.visible = false;
  shell.add(beacon);

  // Dissolved in and out rather than blended — see `faders` in sim/police.js for why alphaHash.
  const faders = [body.material, wheelMat, lid.material];
  for (const material of faders) material.alphaHash = true;
  shell.visible = false;

  return {
    group, shell, body, wheels, hinge, lid, beacon, faders,
    /** Every solid part, for the AO prepass. */
    occluders: [body, lid, ...wheels],
  };
}

// --- The bags ------------------------------------------------------------------

// At 0.34 a pile at play zoom was three black specks that read as a stack of tyres; 0.42 gives it
// a shape, and the ties show.
export const BAG_R = 0.42;

// A deterministic lump per vertex position, not per index (CLAUDE.md: a non-indexed geometry
// repeats shared corners, and jittering by index tears the surface open).
const lump = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

const BAG_FLOOR = -BAG_R * 0.6;   // where the ball is cut flat, before it is lifted onto y = 0
const BAG_SQUASH = 0.82;
/** The middle of a bag above its foot, which its sheen is laid round. */
export const BAG_CENTRE_Y = -BAG_FLOOR;

/**
 * One black bag: a lumpy ball squashed onto a flat bottom, lighter toward the top. y = 0 is the
 * ground it stands on. Its sheen is a separate streak (`bagStreakGeometry`).
 */
export function bagGeometry() {
  const ball = new THREE.IcosahedronGeometry(BAG_R, 1);
  const pos = ball.attributes.position;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k);
    const y = pos.getY(k);
    const z = pos.getZ(k);
    const n = 0.88 + 0.24 * lump(x, y, z);
    pos.setXYZ(k, x * n, Math.max(BAG_FLOOR, y * BAG_SQUASH * n), z * n * 0.94);
  }
  ball.translate(0, -BAG_FLOOR, 0);
  const top = BAG_R * BAG_SQUASH - BAG_FLOOR;
  // Lighter toward the top, as plastic catches the sky — a flat black ball reads as a tyre.
  const flat = ball.index ? ball.toNonIndexed() : ball;
  const fp = flat.attributes.position;
  const low = color('trashBag');
  const high = color('trashBagSheen');
  const tint = new THREE.Color();
  const colors = new Float32Array(fp.count * 3);
  for (let k = 0; k < fp.count; k++) {
    tint.copy(low).lerp(high, Math.max(0, Math.min(1, fp.getY(k) / top)) ** 2);
    colors.set([tint.r, tint.g, tint.b], k * 3);
  }
  return bakeColors(flat, colors);
}

// The sheen: a white streak at 35% (Tyler, 2026-10-24: "a little white streak (35% opacity) to give
// them a plastic sheen feel"). Painted into the bag's vertex colours first, and it did not read:
// even at 1280 triangles a bag the lumps broke the band into blotches. So it is its own ribbon, laid
// just proud of the bag's shoulder on the side facing the camera, and drawn **without the bag's
// yaw** (game/garbage.js) so it is on the seen side of every bag in a pile, however each one turned.
export const STREAK_OPACITY = 0.35;
const STREAK_OUT = 1.18;         // off the bag's centre, in BAG_R: clear of its tallest lump (1.12)
const STREAK_HALF_W = 0.045;
const STREAK_ARC = 0.6;          // radians either side of the middle

/** The streak, in the bag's frame (unrotated): a short curved ribbon of quads, wound outward. */
export function bagStreakGeometry() {
  const lift = BAG_CENTRE_Y;
  // Its middle on the upper shoulder facing the camera, a little to the screen's left of centre
  // (the camera looks down −X−Z, so screen-left is −X+Z); it curves round that shoulder about a
  // near-vertical axis, the way a highlight wraps a ball.
  const mid = new THREE.Vector3(0.15, 0.8, 0.7).normalize();
  const axis = new THREE.Vector3(0.35, 1, -0.2).normalize();
  axis.sub(mid.clone().multiplyScalar(axis.dot(mid))).normalize();
  const steps = 8;
  const at = (t, side) => {
    // Swinging `mid` round `axis` draws the arc, so the ribbon's width runs along `axis` itself.
    const d = mid.clone().applyAxisAngle(axis, t);
    // Tapered toward its ends, like a highlight.
    const w = STREAK_HALF_W * Math.cos((t / STREAK_ARC) * Math.PI / 2);
    const p = d.multiplyScalar(BAG_R * STREAK_OUT).addScaledVector(axis, side * w);
    return new THREE.Vector3(p.x, p.y * BAG_SQUASH + lift, p.z);
  };
  const verts = [];
  for (let k = 0; k < steps; k++) {
    const t0 = -STREAK_ARC + (2 * STREAK_ARC * k) / steps;
    const t1 = -STREAK_ARC + (2 * STREAK_ARC * (k + 1)) / steps;
    const a = at(t0, -1);
    const b = at(t0, 1);
    const c = at(t1, -1);
    const d = at(t1, 1);
    verts.push(a, c, b, b, c, d);
  }
  // Wound so the face normal points away from the bag's centre; checked here rather than trusted
  // (CLAUDE.md: hand-written triangles need their winding asserted).
  const centre = new THREE.Vector3(0, lift, 0);
  const n = new THREE.Vector3().crossVectors(verts[1].clone().sub(verts[0]), verts[2].clone().sub(verts[0]));
  if (n.dot(verts[0].clone().sub(centre)) < 0) {
    for (let k = 0; k < verts.length; k += 3) [verts[k + 1], verts[k + 2]] = [verts[k + 2], verts[k + 1]];
  }
  const geo = new THREE.BufferGeometry().setFromPoints(verts);
  geo.computeVertexNormals();
  return geo;
}

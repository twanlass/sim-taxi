import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  propMaterial, unlitMaterial, bakeColor, setFinish, srcTag, BODY_EULER_ORDER, FINISH,
} from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { SILL_Y, WHEEL_R, wheelAnchors, wheelGeometry, wheelGeometries } from './wheels.js';

// The robo-taxi: a rounded retro bubble car — one smooth arc from the bumper over the roof to the
// tail, four fenders standing off the body over the wheels, frog-eye lamps on the front pair — in
// brushed silver on the metal finish, so it is the one car in town that the sky and the skyline
// slide across. A dark sensor puck rides the roof and a cold cyan band runs round it and across the
// nose: the lamps say robot, the shape says it is not like anything else on the road.
//
// Car-local like every vehicle: +x is the nose, y is up, z is across, on the ordinary car's
// `len` × `width` footprint and its wheels, so the traffic model's envelope, lamp pods and steered
// front pair land where they do on a sedan. Taken as arguments for the same reason classics.js
// takes them (sim/traffic.js imports the geometry modules).

// The body shell's half-width before the fenders, which stand proud of it.
const BODY_HALF_W = 0.74;
// Where the ends of the shell close, above the road.
const NOSE_Y = 1.0;
const TAIL_Y = 1.08;
// The belt line: glass above it, silver below.
const BELT_Y = 1.6;

// The roof line, nose (+1) to tail (-1), as (xn, y). One arc with a long sloped bonnet in front of a
// steep screen, a dome over the cabin, and a round tail falling away behind — the profile is what
// makes it read as a bubble car before any detail does.
const ROOF = [
  [-1, TAIL_Y], [-0.86, 1.56], [-0.62, 1.98], [-0.32, 2.2], [0, 2.24], [0.22, 2.1],
  [0.38, 1.78], [0.56, 1.6], [0.8, 1.46], [0.93, 1.3], [1, NOSE_Y],
];

/** Catmull-Rom through ROOF. */
function roofAt(xn) {
  let k = 0;
  while (k < ROOF.length - 2 && xn > ROOF[k + 1][0]) k++;
  const p0 = ROOF[Math.max(0, k - 1)];
  const p1 = ROOF[k];
  const p2 = ROOF[k + 1];
  const p3 = ROOF[Math.min(ROOF.length - 1, k + 2)];
  const t = (xn - p1[0]) / (p2[0] - p1[0] || 1);
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
    + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
}

const smooth01 = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** The shell's underside: flat along the sill, curling up to meet the roof at each end. */
function floorAt(xn) {
  const floor = SILL_Y + 0.03;
  const end = xn > 0 ? NOSE_Y : TAIL_Y;
  return floor + (end - floor) * smooth01((Math.abs(xn) - 0.72) / 0.28) ** 1.6;
}

/** Half-width at a station: full through the middle, closing round at both ends. */
const widthAt = (xn) => BODY_HALF_W * (1 - Math.abs(xn) ** 4.5) ** (1 / 4.5);

const signPow = (v, p) => Math.sign(v) * Math.abs(v) ** p;

/**
 * A point on the shell at station `xn` (-1 tail .. +1 nose) and angle `v` round its section (0 is
 * the +z flank at mid-height, pi/2 the roof): a lofted superellipse, rounder over the top than under
 * it so the flanks drop to a flat floor.
 */
function shellPoint(len, xn, v, out) {
  const top = roofAt(xn);
  const bottom = floorAt(xn);
  const w = widthAt(xn);
  const yc = (top + bottom) / 2;
  const h = (top - bottom) / 2;
  const cv = Math.cos(v);
  const sv = Math.sin(v);
  const up = sv >= 0;
  return out.set(xn * len / 2 * 0.985, yc + h * signPow(sv, up ? 0.9 : 0.35), w * signPow(cv, up ? 0.8 : 0.45));
}

/** The angle above which the section at `xn` is over the belt line. */
function beltAngle(xn) {
  const top = roofAt(xn);
  const bottom = floorAt(xn);
  const k = (BELT_Y - (top + bottom) / 2) / ((top - bottom) / 2);
  return Math.asin(Math.max(0, Math.min(1, k)) ** (1 / 0.9));
}

/**
 * A patch of the shell over `[x0, x1]` × `[v0(xn), v1(xn)]`, indexed so its normals come out soft,
 * and pushed `lift` out along them — 0 for the shell itself, a hair for the glass laid on it (two
 * surfaces on one plane is a z-fight, CLAUDE.md).
 */
function patch(len, x0, x1, v0, v1, stations, around, lift, { packEnds = false } = {}) {
  const pos = [];
  const index = [];
  const at = new THREE.Vector3();
  for (let a = 0; a <= stations; a++) {
    const s = a / stations;
    // Packed toward the ends, where the curve turns fastest.
    const xn = packEnds ? -Math.cos(s * Math.PI) : x0 + (x1 - x0) * s;
    const va = v0(xn);
    const vb = v1(xn);
    for (let b = 0; b <= around; b++) {
      shellPoint(len, xn, va + (vb - va) * (b / around), at);
      pos.push(at.x, at.y, at.z);
    }
  }
  const row = around + 1;
  for (let a = 0; a < stations; a++) {
    for (let b = 0; b < around; b++) {
      const q = a * row + b;
      // Wound so the outward face is the front face — asserted in tools/probe.mjs.
      index.push(q, q + row, q + 1, q + 1, q + row, q + row + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  if (lift) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i, p.getX(i) + n.getX(i) * lift, p.getY(i) + n.getY(i) * lift, p.getZ(i) + n.getZ(i) * lift);
    }
  }
  return g;
}

const GLASS_LIFT = 0.012;
// Where the side windows stop climbing toward the roof, as an angle round the section.
const SIDE_TOP = 1.0;

/** The silver shell, closed end to end. */
function shellGeometry(len) {
  return softPart(patch(len, -1, 1, () => 0, () => Math.PI * 2, 56, 48, 0, { packEnds: true }),
    'roboSilver', FINISH.CHROME);
}

/**
 * The glass: a wrap-round windscreen, a rear window, and two side windows split by a pillar each
 * side — laid on the shell rather than painted into it, so every edge is a clean curve along the
 * body instead of the stair-step of its triangles.
 */
function glassGeometries(len) {
  const belt = beltAngle;
  const wrap = (xn) => Math.PI - beltAngle(xn);
  const parts = [
    // Windscreen and rear window wrap over the top.
    patch(len, 0.25, 0.4, belt, wrap, 6, 24, GLASS_LIFT),
    patch(len, -0.84, -0.67, belt, wrap, 6, 24, GLASS_LIFT),
  ];
  for (const [x0, x1] of [[-0.14, 0.21], [-0.62, -0.21]]) {
    parts.push(patch(len, x0, x1, belt, () => SIDE_TOP, 8, 8, GLASS_LIFT));
    parts.push(patch(len, x0, x1, (xn) => Math.PI - SIDE_TOP, wrap, 8, 8, GLASS_LIFT));
  }
  return parts.map((g) => softPart(g, 'roboGlass', FINISH.GLASS));
}

/** A soft part: indexed sphere maths for the normals, then the vertex colour and finish baked on. */
function softPart(geometry, colorName, finishSlot) {
  geometry.computeVertexNormals();
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  const c = color(colorName);
  const colors = new Float32Array(flat.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return setFinish(flat, finishSlot);
}

const FENDER_RY = WHEEL_R * 1.05;
const FENDER_Y = WHEEL_R + 0.06;

/** The four fenders: an elongated dome over each wheel, standing off the shell to the tread. */
function fenderGeometries(len, width) {
  const parts = [];
  for (const anchor of wheelAnchors(len, width)) {
    // Down to a little below the hub so the arch frames the tyre's top half.
    const dome = new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI * 0.56);
    dome.scale(0.92, FENDER_RY, 0.36);
    dome.translate(anchor.x, FENDER_Y, Math.sign(anchor.z) * (width / 2 - 0.06));
    parts.push(softPart(dome, 'roboSilver', FINISH.CHROME));
    if (anchor.front) {
      // Frog-eye lamp on the fender's crown, a chrome cup with a pale lens a hair proud of it.
      const cup = new THREE.SphereGeometry(0.2, 14, 8);
      cup.scale(1, 1, 1);
      const lx = anchor.x + 0.5;
      const ly = FENDER_Y + FENDER_RY * 0.8;
      const lz = Math.sign(anchor.z) * (width / 2 - 0.12);
      cup.translate(lx, ly, lz);
      parts.push(softPart(cup, 'bumperChrome', FINISH.METAL));
      const lens = new THREE.SphereGeometry(0.15, 14, 8);
      lens.scale(0.6, 1, 1);
      lens.translate(lx + 0.12, ly, lz);
      parts.push(softPart(lens, 'headlightLens', FINISH.MATTE));
    }
  }
  return parts;
}

/** Running boards between the fenders, and a slim chrome blade of a bumper at each end. */
function trimGeometries(len, width) {
  const parts = [];
  for (const sz of [-1, 1]) {
    const board = new THREE.BoxGeometry(len * 0.32, 0.08, 0.2);
    board.translate(0, SILL_Y + 0.06, sz * (width / 2 - 0.12));
    parts.push(setFinish(bakeColor(board, color('roboTrim')), FINISH.METAL));
  }
  for (const end of [-1, 1]) {
    const blade = new THREE.CapsuleGeometry(0.07, width * 0.86, 4, 10);
    blade.rotateX(Math.PI / 2);
    blade.translate(end * (len / 2 - 0.03), SILL_Y + 0.22, 0);
    parts.push(softPart(blade, 'bumperChrome', FINISH.METAL));
  }
  return parts;
}

/** The sensor puck on the roof, dark, on a short stalk. */
function sensorGeometry() {
  const parts = [];
  const base = roofAt(-0.04) - 0.04;
  const stalk = new THREE.CylinderGeometry(0.12, 0.16, 0.12, 14);
  stalk.translate(-0.06, base + 0.06, 0);
  parts.push(softPart(stalk, 'roboSensor', FINISH.METAL));
  const puck = new THREE.CylinderGeometry(0.22, 0.22, 0.12, 20);
  puck.translate(-0.06, base + 0.18, 0);
  parts.push(softPart(puck, 'roboSensor', FINISH.METAL));
  const cap = new THREE.SphereGeometry(0.22, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.4, 1);
  cap.translate(-0.06, base + 0.24, 0);
  parts.push(softPart(cap, 'roboSensor', FINISH.GLASS));
  return parts;
}

/** Where the cyan lamps go: a band round the puck and a slim bar across the nose. */
function glowGeometry(len) {
  const base = roofAt(-0.04) - 0.04;
  const ring = new THREE.CylinderGeometry(0.232, 0.232, 0.05, 24, 1, true);
  ring.translate(-0.06, base + 0.18, 0);
  const noseX = len / 2 * 0.9;
  const bar = new THREE.CapsuleGeometry(0.035, 0.55, 3, 8);
  bar.rotateX(Math.PI / 2);
  // Laid along the nose's slope, just proud of it.
  bar.translate(noseX - 0.02, roofAt(0.9) + 0.03, 0);
  const merged = mergeGeometries([ring.toNonIndexed(), bar.toNonIndexed()], false);
  ring.dispose();
  bar.dispose();
  return merged;
}

/** The shell and the glass laid on it, for tools/probe.mjs to check the winding of. */
export const roboShellParts = (len) => [shellGeometry(len), ...glassGeometries(len)];

/** Everything that is paint, chrome and glass, in one geometry. */
export function roboTaxiBodyGeometry(len, width) {
  const parts = [
    shellGeometry(len),
    ...glassGeometries(len),
    ...fenderGeometries(len, width),
    ...trimGeometries(len, width),
    ...sensorGeometry(),
    ...wheelGeometries(len, width),
  ];
  // Every part has to agree on its attributes to merge: position, normal, color, aFinish.
  for (const g of parts) {
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'color', 'aFinish'].includes(name)) g.deleteAttribute(name);
    }
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return srcTag(merged, 'src/geometry/robotaxi.js · roboTaxiBodyGeometry');
}

/**
 * The rig the game drives: `group` posed by the traffic model, `shell` switched on and off, the
 * steered front pair, the cyan lamps (`glow`, for the bloom) and the dissolving materials.
 */
export function createRoboTaxiMesh(len, width) {
  const group = new THREE.Group();
  group.name = 'robotaxi';
  group.rotation.order = BODY_EULER_ORDER;
  const shell = new THREE.Group();
  group.add(shell);

  const bodyGeo = roboTaxiBodyGeometry(len, width);
  // Smooth: the soft normals are the whole of what makes the silver read as one curved mirror
  // rather than a faceted can.
  const body = new THREE.Mesh(bodyGeo, propMaterial({ gloss: { geometry: bodyGeo, floor: SILL_Y }, smooth: true }));
  body.castShadow = true;
  body.receiveShadow = true;
  shell.add(body);

  const wheelGeo = wheelGeometry();
  const wheelMat = propMaterial({ gloss: { geometry: wheelGeo } });
  wheelMat.color.set(PALETTE.roboSilver);
  const wheels = wheelAnchors(len, width)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      shell.add(wheel);
      return wheel;
    });

  const glowMat = unlitMaterial({ color: PALETTE.roboGlow });
  const glow = new THREE.Mesh(glowGeometry(len), glowMat);
  shell.add(glow);

  // Dissolved in and out rather than blended — see `faders` in sim/police.js for why alphaHash.
  const faders = [body.material, wheelMat, glowMat];
  for (const material of faders) material.alphaHash = true;
  shell.visible = false;

  return { group, shell, body, wheels, glow, faders, occluders: [body, ...wheels] };
}

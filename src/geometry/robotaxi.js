import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  propMaterial, unlitMaterial, setFinish, srcTag, BODY_EULER_ORDER, FINISH,
} from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { SILL_Y, WHEEL_R, wheelAnchors, wheelGeometry, wheelGeometries } from './wheels.js';

// The robo-taxi: a pod, not a car. An elongated rounded box — a superellipsoid, square-ish in every
// section with soft corners — whose whole upper half is one continuous piece of tinted glass, roof,
// windscreens and side windows alike, over a brushed-silver lower body on the chrome finish. It is
// the same at both ends: no bonnet, no boot, a cyan light bar across each end and the sensor puck in
// the middle of the roof, so you cannot tell which way it is about to go. (Tyler, 2026-11-05: the
// first build was a retro bubble car with fenders and frog-eye lamps; "a little too retro".)
//
// Car-local like every vehicle: +x is the direction of travel, y is up, z is across, on the
// ordinary car's `len` × `width` footprint and its wheels, so the traffic model's envelope, lamp
// pods and steered front pair land where they do on a sedan. Taken as arguments for the same reason
// classics.js takes them (sim/traffic.js imports the geometry modules).

// The body's half-width: the wheels' treads stand WHEEL_PROUD past the ordinary car's flank, so a
// pod a touch narrower than the car leaves the outer 0.16 of each tread standing out of its well.
const BODY_HALF_W = 0.8;
// Low, as a skirt round the wheels: the tyres show in their wells, not under the body.
const FLOOR_Y = 0.32;
const ROOF_Y = 2.12;
// Glass above this, silver below: the silver carries the wheel wells, the glass the top third.
const BELT_Y = 1.56;
// How square the pod is: superellipse exponents along its length and round its section. Higher
// along the length is flatter ends; lower round the section (as a power on the unit circle) is
// fuller, squarer corners.
const END_P = 5;
const SECTION_P = 0.42;

const signPow = (v, p) => Math.sign(v) * Math.abs(v) ** p;
const endShape = (xn) => (1 - Math.abs(xn) ** END_P) ** (1 / END_P);

/**
 * A point on the pod at station `xn` (-1 .. +1, symmetric) and angle `v` round its section (0 the
 * +z flank at mid-height, pi/2 the roof). Each section is a rounded rectangle that shrinks toward
 * the ends, closing on a soft point at mid-height.
 */
function shellPoint(len, xn, v, out) {
  const e = endShape(xn);
  const mid = (ROOF_Y + FLOOR_Y) / 2;
  const h = (ROOF_Y - FLOOR_Y) / 2 * (0.25 + 0.75 * e);
  const w = BODY_HALF_W * e;
  return out.set(xn * len / 2 * 0.985, mid + h * signPow(Math.sin(v), SECTION_P),
    w * signPow(Math.cos(v), SECTION_P));
}

/** The angle round the section at `xn` where the surface crosses the belt line. */
function beltAngle(xn) {
  const e = endShape(xn);
  const mid = (ROOF_Y + FLOOR_Y) / 2;
  const h = (ROOF_Y - FLOOR_Y) / 2 * (0.25 + 0.75 * e);
  const k = (BELT_Y - mid) / h;
  return Math.asin(Math.max(-1, Math.min(1, k)) ** (1 / SECTION_P) * Math.sign(k) || 0);
}

/**
 * A patch of the pod over `[-1, 1]` × `[v0(xn), v1(xn)]`, indexed so its normals come out soft,
 * stations packed toward the ends where the curve turns fastest.
 */
function patch(len, v0, v1, stations, around) {
  const pos = [];
  const index = [];
  const at = new THREE.Vector3();
  for (let a = 0; a <= stations; a++) {
    const xn = -Math.cos((a / stations) * Math.PI);
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
  return g;
}

/**
 * The silver lower body, from the belt on one flank under the floor to the belt on the other. It
 * and the canopy share the belt line edge to edge — a seam, not an overlap, so nothing fights.
 */
function shellGeometry(len) {
  return softPart(patch(len, (xn) => Math.PI - beltAngle(xn), (xn) => 2 * Math.PI + beltAngle(xn), 48, 40),
    'roboSilver', FINISH.CHROME);
}

/** The canopy: one piece of glass over the whole top, ends included, belt to belt. */
function glassGeometries(len) {
  return [softPart(patch(len, beltAngle, (xn) => Math.PI - beltAngle(xn), 48, 28), 'roboGlass', FINISH.GLASS)];
}

/** A soft part: normals from the indexed surface, then split and the colour and finish baked on. */
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

// The well round each wheel: a dark arch over the tyre, laid *on* the flank — every point projected
// onto the shell where it is, so it follows the curve into the ends instead of standing off it as a
// flat disc (the first cut was a half-cylinder, whose caps jutted 0.18 past the narrowing ends).
const WELL_R = WHEEL_R + 0.1;
const WELL_LIFT = 0.01;
const WELL_REACH = 0.88;

/** The flank's z at (x, y) on the +z side, or null where the body does not reach. */
function flankZ(len, x, y) {
  const xn = x / (len / 2 * 0.985);
  if (Math.abs(xn) >= 0.999) return null;
  const e = endShape(xn);
  const mid = (ROOF_Y + FLOOR_Y) / 2;
  const h = (ROOF_Y - FLOOR_Y) / 2 * (0.25 + 0.75 * e);
  const k = (y - mid) / h;
  if (k <= -1 || k >= 1) return null;
  const v = Math.asin(signPow(k, 1 / SECTION_P));
  return BODY_HALF_W * e * Math.cos(v) ** SECTION_P;
}

function wellGeometries(len, width) {
  const parts = [];
  const RINGS = 6;
  const SWEEP = 24;
  for (const anchor of wheelAnchors(len, width)) {
    const side = Math.sign(anchor.z);
    const pos = [];
    const index = [];
    for (let r = 0; r <= RINGS; r++) {
      for (let t = 0; t <= SWEEP; t++) {
        const rad = WELL_R * (0.35 + 0.65 * r / RINGS);
        const th = Math.PI * t / SWEEP;
        // Below the floor there is no flank to lay it on: pinned just above it. Past the end it
        // is pulled back along the length until it lands on the body.
        const y = Math.max(FLOOR_Y + 0.03, WHEEL_R + Math.sin(th) * rad);
        // Stopped short of the end's turn, where the flank starts to face along the car: an arch
        // wrapped round it folded over itself. Past that the arch is cut off square.
        const xMax = len / 2 * 0.985 * WELL_REACH;
        const x = Math.max(-xMax, Math.min(xMax, anchor.x + Math.cos(th) * rad));
        const z = flankZ(len, x, y) ?? 0;
        // Lifted along the surface's own normal, not along z: round the ends the flank faces
        // along the car, and a lift across it pushed the arch back inside the shell.
        const dx = ((flankZ(len, x + 0.01, y) ?? z) - (flankZ(len, x - 0.01, y) ?? z)) / 0.02;
        const dy = ((flankZ(len, x, y + 0.01) ?? z) - (flankZ(len, x, y - 0.01) ?? z)) / 0.02;
        const nl = Math.hypot(dx, dy, 1);
        pos.push(x - dx / nl * WELL_LIFT, y - dy / nl * WELL_LIFT, side * (z + WELL_LIFT / nl));
      }
    }
    const row = SWEEP + 1;
    for (let r = 0; r < RINGS; r++) {
      for (let t = 0; t < SWEEP; t++) {
        const q = r * row + t;
        // Outward is +z on the +z flank; the mirror on the other side reverses the winding.
        if (side > 0) index.push(q, q + row, q + 1, q + 1, q + row, q + row + 1);
        else index.push(q, q + 1, q + row, q + 1, q + row + 1, q + row);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(index);
    parts.push(softPart(g, 'wheelWell', FINISH.TYRE));
  }
  return parts;
}

/** The sensor puck in the middle of the roof, dark, on a short stalk. */
function sensorGeometry() {
  const parts = [];
  const base = ROOF_Y - 0.03;
  const stalk = new THREE.CylinderGeometry(0.14, 0.18, 0.1, 16);
  stalk.translate(0, base + 0.05, 0);
  parts.push(softPart(stalk, 'roboSensor', FINISH.METAL));
  const puck = new THREE.CylinderGeometry(0.24, 0.24, 0.12, 24);
  puck.translate(0, base + 0.16, 0);
  parts.push(softPart(puck, 'roboSensor', FINISH.METAL));
  const cap = new THREE.SphereGeometry(0.24, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.4, 1);
  cap.translate(0, base + 0.22, 0);
  parts.push(softPart(cap, 'roboSensor', FINISH.GLASS));
  return parts;
}

/** The cyan lamps: a band round the puck and a light bar across each end, just under the belt. */
function glowGeometry(len) {
  const parts = [];
  const ring = new THREE.CylinderGeometry(0.252, 0.252, 0.09, 24, 1, true);
  ring.translate(0, ROOF_Y - 0.03 + 0.16, 0);
  parts.push(ring.toNonIndexed());
  ring.dispose();
  const y = BELT_Y - 0.12;
  for (const end of [-1, 1]) {
    // END_P makes the ends blunt: the pod is still ~0.6 wide a hundredth of its length from the
    // tip, so a short bar laid across the tip stands proud of it over its whole length.
    const bar = new THREE.CapsuleGeometry(0.06, 0.5, 3, 8);
    bar.rotateX(Math.PI / 2);
    bar.translate(end * (len / 2 * 0.985 - 0.03), y, 0);
    parts.push(bar.toNonIndexed());
    bar.dispose();
  }
  return mergeGeometries(parts, false);
}

/** The shell and the glass laid on it, for tools/probe.mjs to check the winding of. */
export const roboShellParts = (len) => [shellGeometry(len), ...glassGeometries(len)];

/** Everything that is paint, chrome and glass, in one geometry. */
export function roboTaxiBodyGeometry(len, width) {
  const parts = [
    shellGeometry(len),
    ...glassGeometries(len),
    ...wellGeometries(len, width),
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

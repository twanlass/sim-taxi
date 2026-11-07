import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  propMaterial, unlitMaterial, setFinish, srcTag, BODY_EULER_ORDER, FINISH,
} from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { SILL_Y, WHEEL_R, WHEEL_W, wheelAnchors } from './wheels.js';

// The robo-taxi: a pod, not a car. An elongated rounded box — a superellipsoid, square-ish in every
// section with soft corners — whose whole upper half is one continuous piece of tinted glass, roof,
// windscreens and side windows alike, over a brushed-silver lower body on the chrome finish. It is
// the same at both ends, and it rolls on balls rather than wheels: no bonnet, no boot, a cyan belly
// band round its waist and the sensor puck in the middle of the roof, so you cannot tell which way
// it is about to go. (Tyler, 2026-11-05: the
// first build was a retro bubble car with fenders and frog-eye lamps; "a little too retro". The
// balls were his next ask: futuristic, and they leave room for it to move in ways a car cannot.)
//
// Car-local like every vehicle: +x is the direction of travel, y is up, z is across, on the
// ordinary car's `len` × `width` footprint and its wheels, so the traffic model's envelope, lamp
// pods and steered front pair land where they do on a sedan. Taken as arguments for the same reason
// classics.js takes them (sim/traffic.js imports the geometry modules).

// Drawn at the taxi's size, not a sedan's: the group is scaled the way geometry/taxi.js scales the
// taxi (TAXI_SCALE, 1.18 — not imported, for the same cycle reason wheels.js gives), so the pod is
// 4.0 long and 2.5 tall on screen. At 1:1 it read as a small car; Tyler (2026-11-06) wanted "little
// minivans", the taxi's size. The sim's envelope stays CAR_LEN, exactly as the taxi's does.
export const ROBO_SCALE = 1.18;

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

// The ball tyres. A sphere of the ordinary wheel's radius, so the pod rides at the height every
// other body is built for, set in so its outer face stands where a tyre's tread did. Plain and dark:
// a pair of cyan rings round each ball (a cross on the hub that turned as it rolled) went in with
// them and came out again on Tyler's call (2026-11-07), in favour of the belly band below.
const BALL_SEGMENTS = 28;
const BALL_RINGS = 18;
const BALL_TUCK = 0.1;     // in from a tyre's outer face: a ball bulges further than a tread did

function ballZ(anchor) {
  // Outer face a little in from where a tyre's sat (wheelAnchors places a tyre by that face).
  return Math.sign(anchor.z) * (Math.abs(anchor.z) + WHEEL_W / 2 - WHEEL_R - BALL_TUCK);
}

function ballGeometry() {
  return softPart(new THREE.SphereGeometry(WHEEL_R, BALL_SEGMENTS, BALL_RINGS), 'roboSensor', FINISH.TYRE);
}

// The belly band: a thin cyan ribbon all the way round the pod, just under the glass and just clear
// of the wheel wells' crowns (WHEEL_R + WELL_R = 1.38), with a light tracing round it (`bandMaterial`).
// A vertical ribbon on the band's own outline rather than a strip laid on the shell: the flank is
// near vertical at this height (the section starts turning in at the belt), and a strip that
// followed it would have to stop at the tips, where the shell does not reach this high at all.
// It replaces the two bars that stood at the ends at the same height — it runs through both.
const BAND_Y = 1.45;
const BAND_HALF = 0.05;    // 0.1 tall: ~1px at play zoom before the bloom takes it
const BAND_PROUD = 0.02;   // out from the shell, so the two never share a surface
const BAND_STATIONS = 64;  // per side, packed toward the tips where the outline turns

/** The band's outline at BAND_Y: [x, z, nx, nz] round the pod, +z side then -z, closed. */
function bandOutline(len) {
  const half = len / 2 * 0.985;
  const pts = [];
  for (const side of [1, -1]) {
    for (let i = 0; i < BAND_STATIONS; i++) {
      // Packed with -cos like the shell's own stations; the +z side runs -x to +x, the -z back.
      const xn = -Math.cos(Math.PI * i / BAND_STATIONS) * side;
      const x = xn * half;
      pts.push([x, side * (flankZ(len, x, BAND_Y) ?? 0)]);
    }
  }
  return pts.map((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[(i + 1) % pts.length];
    // The loop runs +x along the +z flank and back along the -z, so (-dz, dx) points away from
    // the pod: (0, 1) on the +z flank. The probe checks the ribbon's winding agrees.
    let nx = -(b[1] - a[1]);
    let nz = b[0] - a[0];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    return [p[0] + nx * BAND_PROUD, p[1] + nz * BAND_PROUD, nx, nz];
  });
}

/** The ribbon, indexed and closed, with `aTrace` 0..1 round it by arc length for the trace. */
export function roboBandGeometry(len) {
  const loop = bandOutline(len);
  const n = loop.length;
  const pos = [];
  const trace = [];
  const index = [];
  let run = 0;
  const lengths = [0];
  for (let i = 1; i <= n; i++) {
    const a = loop[i - 1];
    const b = loop[i % n];
    run += Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(run);
  }
  // One more column than stations, so the seam can carry aTrace 1 beside the first column's 0.
  for (let i = 0; i <= n; i++) {
    const [x, z] = loop[i % n];
    pos.push(x, BAND_Y - BAND_HALF, z, x, BAND_Y + BAND_HALF, z);
    trace.push(lengths[i] / run, lengths[i] / run);
  }
  for (let i = 0; i < n; i++) {
    const q = i * 2;
    index.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTrace', new THREE.Float32BufferAttribute(trace, 1));
  g.setIndex(index);
  return g;
}

// The trace: a bright head with a fading tail chasing round the band, two of them half a lap
// apart, over a steady dim base so the band still reads as a band between them. The clock is one
// uniform shared by every band (and by the bloom's copy, which inherits this patch through
// `markEmissive`), set once a frame by game/robotaxi.js.
export const ROBO_BAND_TIME = { value: 0 };
const BAND_LAPS_PER_SECOND = 0.45;
const BAND_BASE = 0.3;
const BAND_HEAD = 1.4;

function bandMaterial() {
  const material = unlitMaterial({ color: PALETTE.roboGlow });
  material.customProgramCacheKey = () => 'robotaxi-band';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBandTime = ROBO_BAND_TIME;
    const vert = shader.vertexShader;
    shader.vertexShader = vert
      .replace('#include <common>', '#include <common>\nattribute float aTrace;\nvarying float vTrace;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTrace = aTrace;');
    const frag = shader.fragmentShader;
    shader.fragmentShader = frag
      .replace('#include <common>', '#include <common>\nuniform float uBandTime;\nvarying float vTrace;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      float bandBehind = fract(2.0 * (uBandTime * ${BAND_LAPS_PER_SECOND.toFixed(3)} - vTrace));
      diffuseColor.rgb *= ${BAND_BASE.toFixed(3)} + ${BAND_HEAD.toFixed(3)} * pow(1.0 - bandBehind, 6.0);`);
    if (shader.vertexShader === vert || !shader.vertexShader.includes('vTrace = aTrace')
      || !shader.fragmentShader.includes('bandBehind')) {
      throw new Error('robotaxi band: a shader hook matched nothing');
    }
  };
  return material;
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

/** The cyan lamp on the roof: a band round the puck. (The belly band is its own mesh.) */
function glowGeometry(len) {
  const parts = [];
  const ring = new THREE.CylinderGeometry(0.252, 0.252, 0.09, 24, 1, true);
  ring.translate(0, ROOF_Y - 0.03 + 0.16, 0);
  parts.push(ring.toNonIndexed());
  ring.dispose();
  // The bars that stood at each end at this height are the belly band's now (`roboBandGeometry`).
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
  group.scale.setScalar(ROBO_SCALE);
  const shell = new THREE.Group();
  group.add(shell);

  const bodyGeo = roboTaxiBodyGeometry(len, width);
  // Smooth: the soft normals are the whole of what makes the silver read as one curved mirror
  // rather than a faceted can.
  const body = new THREE.Mesh(bodyGeo, propMaterial({ gloss: { geometry: bodyGeo, floor: SILL_Y }, smooth: true }));
  body.castShadow = true;
  body.receiveShadow = true;
  shell.add(body);

  const glowMat = unlitMaterial({ color: PALETTE.roboGlow });
  const glow = new THREE.Mesh(glowGeometry(len), glowMat);
  shell.add(glow);

  // All four balls are their own meshes: each rolls (about z, by the distance driven) and the front
  // pair steers (about y). 'YZX' composes Ry·Rz, so the roll happens about the ball's own axle and
  // the steer turns that axle; the default 'XYZ' would roll it about the car's axle instead.
  const ballGeo = ballGeometry();
  const wheelMat = propMaterial({ gloss: { geometry: ballGeo } });
  const wheels = wheelAnchors(len, width).map((anchor) => {
    const wheel = new THREE.Mesh(ballGeo, wheelMat);
    wheel.position.set(anchor.x, anchor.y, ballZ(anchor));
    wheel.rotation.order = 'YZX';
    wheel.userData.steers = anchor.front;
    wheel.castShadow = true;
    shell.add(wheel);
    return wheel;
  });

  // Dissolved in and out rather than blended — see `faders` in sim/police.js for why alphaHash.
  const band = new THREE.Mesh(roboBandGeometry(len), bandMaterial());
  band.userData.roboLamp = true;
  shell.add(band);

  const faders = [body.material, wheelMat, glowMat, band.material];
  for (const material of faders) material.alphaHash = true;
  shell.visible = false;

  return { group, shell, body, wheels, band, glow, faders, occluders: [body, ...wheels] };
}

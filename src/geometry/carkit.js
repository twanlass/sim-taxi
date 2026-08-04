import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// Parametric vehicle kit: one spec object in, one merged low-poly geometry out — the same
// construction discipline as the hand-built cars (non-indexed, baked vertex colours, one
// material), so anything designed in the editor is drop-in compatible with the game's meshes.
//
// The `sedan` preset reproduces carGeometry() in sim/traffic.js box for box, and check.mjs
// asserts it stays that way — the kit is only trustworthy as an editing surface for the game's
// vehicles while its baseline *is* the game's vehicle.
//
// Orientation: +X is the nose, -X the tail (the sedan's cabin sits at -0.2, biased rearward).
// The origin is on the road surface under the car's centre, like every vehicle in the game.

const WHEEL_COLOR = new THREE.Color(0.16, 0.16, 0.18);
// Cabin and cargo sink this far into the surface below them, so lighting never opens a seam
// between stacked boxes. The sedan's cabin at y 1.45 = body top 1.18 − 0.03 + half-height 0.30.
const SINK = 0.03;

/** Slider ranges, shared by the editor UI and by normalizeSpec() clamping imported JSON. */
export const LIMITS = {
  'body.len': [2.4, 6],
  'body.width': [1.2, 2.6],
  'body.height': [0.4, 2],
  'body.clearance': [0.2, 0.8],
  'cabin.lenFrac': [0.15, 0.95],
  'cabin.offsetFrac': [-0.42, 0.42],
  'cabin.height': [0.2, 1.4],
  'cabin.widthFrac': [0.6, 1],
  'wheels.radius': [0.2, 0.6],
  'wheels.width': [0.14, 0.6],
  'wheels.insetFrac': [0.18, 0.44],
  'wheels.axles': [2, 3],
  'cargo.boxHeight': [0.6, 2.4],
  'cargo.bedWall': [0.15, 0.9],
};

export const DEFAULT_SPEC = {
  name: 'Sedan',
  body: { len: 3.4, width: 1.7, height: 0.8, clearance: 0.38 },
  // Fractions of body length, so stretching the body carries the cabin with it.
  cabin: { lenFrac: 0.5, offsetFrac: -0.2 / 3.4, height: 0.6, widthFrac: 0.86 },
  wheels: { radius: 0.32, width: 0.26, insetFrac: 0.3, axles: 2 },
  // type: 'none' | 'bed' (open pickup walls) | 'box' (tall cargo body). color 'body' follows
  // the body colour, so recolouring the truck doesn't leave a stale bed behind.
  cargo: { type: 'none', boxHeight: 1.6, bedWall: 0.4, color: 'body' },
  colors: { body: PALETTE.carBody[2], glass: PALETTE.carGlass },
  // stripe: 'none' | 'flank' (the taxi's side chequer band) | 'skirt' (the police wrap).
  extras: {
    stripe: 'none',
    stripeColor: PALETTE.taxiTrim,
    sign: false,
    signColor: PALETTE.taxiSign,
    lightbar: false,
  },
};

export const PRESETS = {
  sedan: DEFAULT_SPEC,
  taxi: {
    ...DEFAULT_SPEC,
    name: 'Taxi',
    colors: { body: PALETTE.taxiBody, glass: PALETTE.carGlass },
    extras: { ...DEFAULT_SPEC.extras, stripe: 'flank', sign: true },
  },
  van: {
    name: 'Van',
    body: { len: 3.9, width: 1.8, height: 1.4, clearance: 0.4 },
    cabin: { lenFrac: 0.72, offsetFrac: -0.04, height: 0.5, widthFrac: 0.88 },
    wheels: { radius: 0.34, width: 0.28, insetFrac: 0.32, axles: 2 },
    cargo: { ...DEFAULT_SPEC.cargo },
    colors: { body: PALETTE.carBody[1], glass: PALETTE.carGlass },
    extras: { ...DEFAULT_SPEC.extras },
  },
  pickup: {
    name: 'Pickup',
    body: { len: 4.1, width: 1.8, height: 0.75, clearance: 0.45 },
    cabin: { lenFrac: 0.34, offsetFrac: 0.1, height: 0.65, widthFrac: 0.88 },
    wheels: { radius: 0.36, width: 0.3, insetFrac: 0.32, axles: 2 },
    cargo: { ...DEFAULT_SPEC.cargo, type: 'bed', bedWall: 0.4 },
    colors: { body: PALETTE.carBody[0], glass: PALETTE.carGlass },
    extras: { ...DEFAULT_SPEC.extras },
  },
  boxtruck: {
    name: 'Box truck',
    body: { len: 4.9, width: 2, height: 0.7, clearance: 0.5 },
    cabin: { lenFrac: 0.24, offsetFrac: 0.33, height: 0.85, widthFrac: 0.95 },
    wheels: { radius: 0.38, width: 0.32, insetFrac: 0.34, axles: 3 },
    cargo: { ...DEFAULT_SPEC.cargo, type: 'box', boxHeight: 1.9, color: PALETTE.pale },
    colors: { body: PALETTE.carBody[0], glass: PALETTE.carGlass },
    extras: { ...DEFAULT_SPEC.extras },
  },
  police: {
    name: 'Police',
    // Matches policeGeometry() in sim/police.js: 3.6 × 1.8 body, white 1.9-long roof at −0.2,
    // a wrap-around skirt stripe, wheels at ±1.08. The "glass" slot carries the white roof.
    body: { len: 3.6, width: 1.8, height: 0.8, clearance: 0.38 },
    cabin: { lenFrac: 1.9 / 3.6, offsetFrac: -0.2 / 3.6, height: 0.62, widthFrac: 1.6 / 1.8 },
    wheels: { radius: 0.32, width: 0.26, insetFrac: 0.3, axles: 2 },
    cargo: { ...DEFAULT_SPEC.cargo },
    colors: { body: PALETTE.policeBody, glass: PALETTE.policeRoof },
    extras: {
      ...DEFAULT_SPEC.extras,
      stripe: 'skirt',
      stripeColor: PALETTE.policeRoof,
      lightbar: true,
    },
  },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function get(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function set(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}

/**
 * Fills gaps from DEFAULT_SPEC and clamps every number into LIMITS. Imported JSON goes through
 * here, so a hand-edited or truncated spec degrades to a buildable car rather than NaN geometry.
 */
export function normalizeSpec(spec = {}) {
  const out = structuredClone(DEFAULT_SPEC);
  out.name = typeof spec.name === 'string' ? spec.name : out.name;

  for (const [path, [lo, hi]] of Object.entries(LIMITS)) {
    const v = Number(get(spec, path));
    if (Number.isFinite(v)) set(out, path, clamp(v, lo, hi));
  }
  out.wheels.axles = Math.round(out.wheels.axles);

  if (['none', 'bed', 'box'].includes(spec.cargo?.type)) out.cargo.type = spec.cargo.type;
  if (['none', 'flank', 'skirt'].includes(spec.extras?.stripe)) out.extras.stripe = spec.extras.stripe;
  out.extras.sign = Boolean(spec.extras?.sign ?? out.extras.sign);
  out.extras.lightbar = Boolean(spec.extras?.lightbar ?? out.extras.lightbar);

  const color = (v, fallback) => {
    if (v === 'body') return 'body';
    try { return `#${new THREE.Color(v).getHexString()}`; } catch { return fallback; }
  };
  out.colors.body = color(spec.colors?.body ?? out.colors.body, out.colors.body);
  out.colors.glass = color(spec.colors?.glass ?? out.colors.glass, out.colors.glass);
  out.cargo.color = color(spec.cargo?.color ?? out.cargo.color, 'body');
  out.extras.stripeColor = color(spec.extras?.stripeColor ?? out.extras.stripeColor, out.extras.stripeColor);
  out.extras.signColor = color(spec.extras?.signColor ?? out.extras.signColor, out.extras.signColor);

  // The cabin has to stay on the body: pull the offset in so neither end overhangs a bumper.
  const halfSlack = Math.max(0, (1 - out.cabin.lenFrac) / 2);
  out.cabin.offsetFrac = clamp(out.cabin.offsetFrac, -halfSlack, halfSlack);

  return out;
}

/** Every wheel's x position along the body. A third axle doubles up the rear, truck-style. */
function axlePositions(s) {
  const inset = s.body.len * s.wheels.insetFrac;
  const xs = [inset, -inset];
  if (s.wheels.axles === 3) {
    // Ahead of the rearmost axle by just over a wheel's diameter, clamped clear of the front.
    xs.push(Math.min(inset - s.wheels.radius * 1.2, -inset + s.wheels.radius * 2 + 0.14));
  }
  return xs;
}

/**
 * Builds the whole vehicle as one merged, non-indexed geometry with baked vertex colours —
 * ready for propMaterial(), or for tinting via instanceColor if the body is baked white.
 */
export function buildVehicleGeometry(spec) {
  const s = normalizeSpec(spec);
  const parts = [];
  const { len, width, height, clearance } = s.body;
  const bodyColor = new THREE.Color(s.colors.body);
  const bodyTop = clearance + height;

  const body = new THREE.BoxGeometry(len, height, width);
  body.translate(0, clearance + height / 2, 0);
  parts.push(bakeColor(body, bodyColor));

  const cabinLen = len * s.cabin.lenFrac;
  const cabinX = len * s.cabin.offsetFrac;
  const cabinTop = bodyTop - SINK + s.cabin.height;
  const cabin = new THREE.BoxGeometry(cabinLen, s.cabin.height, width * s.cabin.widthFrac);
  cabin.translate(cabinX, bodyTop - SINK + s.cabin.height / 2, 0);
  parts.push(bakeColor(cabin, new THREE.Color(s.colors.glass)));

  for (const x of axlePositions(s)) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(s.wheels.radius, s.wheels.radius, s.wheels.width, 8);
      wheel.rotateX(Math.PI / 2);   // axle across the car
      wheel.translate(x, s.wheels.radius, sz * (width / 2 - 0.02));
      parts.push(bakeColor(wheel, WHEEL_COLOR));
    }
  }

  // Cargo occupies whatever the cabin leaves free at the tail. If the cabin reaches nearly to
  // the rear bumper there is no bed to build, so it quietly disappears rather than inverting.
  const cargoColor = s.cargo.color === 'body' ? bodyColor : new THREE.Color(s.cargo.color);
  const cargoFront = cabinX - cabinLen / 2 - 0.08;
  const cargoRear = -len / 2;
  if (s.cargo.type !== 'none' && cargoFront - cargoRear > 0.3) {
    const span = cargoFront - cargoRear;
    const mid = (cargoFront + cargoRear) / 2;
    if (s.cargo.type === 'box') {
      // Slightly wider than the body, box-truck style, so the box reads as its own volume.
      const box = new THREE.BoxGeometry(span, s.cargo.boxHeight, width * 1.05);
      box.translate(mid, bodyTop - 2 * SINK + s.cargo.boxHeight / 2, 0);
      parts.push(bakeColor(box, cargoColor));
    } else {
      // Open bed: four thin walls around the body top, which itself reads as the bed floor.
      const t = 0.09;
      const y = bodyTop - 0.05 + s.cargo.bedWall / 2;
      for (const [bx, bz, lx, lz] of [
        [cargoFront - t / 2, 0, t, width],            // headboard, behind the cabin
        [cargoRear + t / 2, 0, t, width],             // tailgate
        [mid, width / 2 - t / 2, span, t],
        [mid, -(width / 2 - t / 2), span, t],
      ]) {
        const wall = new THREE.BoxGeometry(lx, s.cargo.bedWall, lz);
        wall.translate(bx, y, bz);
        parts.push(bakeColor(wall, cargoColor));
      }
    }
  }

  if (s.extras.stripe === 'flank') {
    // The taxi's chequer band: a thin box proud of each flank, at the same relative height.
    for (const side of [-1, 1]) {
      const stripe = new THREE.BoxGeometry(len * 0.82, 0.22, 0.06);
      stripe.translate(0, clearance + height * 0.55, side * (width / 2 + 0.02));
      parts.push(bakeColor(stripe, new THREE.Color(s.extras.stripeColor)));
    }
  } else if (s.extras.stripe === 'skirt') {
    // The police wrap: a band a hair larger than the body all round, low on the sill.
    const stripe = new THREE.BoxGeometry(len + 0.02, 0.3, width + 0.02);
    stripe.translate(0, clearance + 0.24, 0);
    parts.push(bakeColor(stripe, new THREE.Color(s.extras.stripeColor)));
  }

  if (s.extras.sign) {
    const sign = new THREE.BoxGeometry(0.75, 0.34, 0.4);
    sign.translate(cabinX + 0.1, cabinTop + 0.17, 0);
    parts.push(bakeColor(sign, new THREE.Color(s.extras.signColor)));
  }

  if (s.extras.lightbar) {
    // Baked, unlike the game police car's flashing meshes — the kit builds silhouettes; a
    // flashing bar is behaviour, and behaviour stays in sim/police.js.
    for (const [hex, z] of [['#E24B3C', -0.24], ['#3E66E0', 0.24]]) {
      const lamp = new THREE.BoxGeometry(0.28, 0.2, 0.44);
      lamp.translate(cabinX, cabinTop + 0.1, z);
      parts.push(bakeColor(lamp, new THREE.Color(hex)));
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  merged.userData.spec = s;
  return merged;
}

/** A ready-to-place mesh in the game's shared prop material. */
export function createVehicleMesh(spec) {
  const mesh = new THREE.Mesh(buildVehicleGeometry(spec), propMaterial());
  mesh.castShadow = true;
  return mesh;
}

/**
 * A plausible random vehicle: pick an archetype, jitter every dimension, draw a palette colour.
 * Takes the random source as an argument so a seeded rng can reproduce a roll.
 */
export function randomSpec(rand = Math.random) {
  const names = Object.keys(PRESETS);
  const base = structuredClone(PRESETS[names[Math.floor(rand() * names.length)]]);
  const jitter = (path, amount) => {
    const [lo, hi] = LIMITS[path];
    set(base, path, clamp(get(base, path) + (rand() * 2 - 1) * amount, lo, hi));
  };
  jitter('body.len', 0.5);
  jitter('body.width', 0.2);
  jitter('body.height', 0.15);
  jitter('body.clearance', 0.08);
  jitter('cabin.lenFrac', 0.1);
  jitter('cabin.offsetFrac', 0.06);
  jitter('cabin.height', 0.12);
  jitter('wheels.radius', 0.06);
  jitter('wheels.insetFrac', 0.03);
  base.colors.body = PALETTE.carBody[Math.floor(rand() * PALETTE.carBody.length)];
  base.name = `Random ${base.name.toLowerCase()}`;
  return normalizeSpec(base);
}

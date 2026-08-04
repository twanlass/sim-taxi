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
//
// The body is not a box but an extruded side profile: a chain of (x, y) points, each a fraction
// of body length / height, running nose-bottom up over the roofline to tail-bottom and closing
// flat along the ground. A rectangular chain *is* the old box (identical envelope, which is what
// keeps the sedan pin true); dragging the chain is what the editor's silhouette mode does.
// Fractions rather than units so the length and height sliders keep composing with a drawn
// profile instead of invalidating it.

const WHEEL_COLOR = new THREE.Color(0.16, 0.16, 0.18);
// Cabin and cargo sink this far into the surface below them, so lighting never opens a seam
// between stacked boxes. The sedan's cabin at y 1.45 = body top 1.18 − 0.03 + half-height 0.30.
const SINK = 0.03;

export const PROFILE_MIN_POINTS = 4;
export const PROFILE_MAX_POINTS = 12;
const RECT_PROFILE = [[0.5, 0], [0.5, 1], [-0.5, 1], [-0.5, 0]];

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
  'cabin.rakeFront': [0, 1.2],
  'cabin.rakeBack': [0, 1.2],
  'wheels.radius': [0.2, 0.6],
  'wheels.width': [0.14, 0.6],
  'wheels.insetFrac': [0.18, 0.44],
  'wheels.axles': [2, 3],
  'cargo.boxHeight': [0.6, 2.4],
  'cargo.bedWall': [0.15, 0.9],
};

export const DEFAULT_SPEC = {
  name: 'Sedan',
  body: { len: 3.4, width: 1.7, height: 0.8, clearance: 0.38, profile: RECT_PROFILE },
  // Fractions of body length, so stretching the body carries the cabin with it. The rakes shear
  // the cabin's top face inward in world units — a raked windshield and rear screen.
  cabin: { lenFrac: 0.5, offsetFrac: -0.2 / 3.4, height: 0.6, widthFrac: 0.86, rakeFront: 0, rakeBack: 0 },
  wheels: { radius: 0.32, width: 0.26, insetFrac: 0.3, axles: 2 },
  // type: 'none' | 'bed' (open pickup walls) | 'box' (tall cargo body). color 'body' follows
  // the body colour, so recolouring the truck doesn't leave a stale bed behind.
  cargo: { type: 'none', boxHeight: 1.6, bedWall: 0.4, color: 'body' },
  colors: { body: PALETTE.carBody[2], glass: PALETTE.carGlass },
  // Per-part overrides on top of the role colours, keyed by manifest part name ('body',
  // 'cabin', 'wheels', 'bed', 'box', 'stripe', 'sign', 'lightbar'). Written by the editor's
  // click-to-select; absent keys fall through to colors/cargo defaults.
  partColors: {},
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
  sports: {
    name: 'Sports car',
    // The profile showcase: nose low, screen fast, tail chopped — none of it reachable with a box.
    body: {
      len: 3.7, width: 1.75, height: 0.95, clearance: 0.3,
      profile: [[0.5, 0], [0.5, 0.4], [0.1, 0.78], [-0.18, 1], [-0.44, 0.96], [-0.5, 0.5], [-0.5, 0]],
    },
    cabin: { lenFrac: 0.4, offsetFrac: -0.12, height: 0.34, widthFrac: 0.88, rakeFront: 0.45, rakeBack: 0.3 },
    wheels: { radius: 0.34, width: 0.3, insetFrac: 0.34, axles: 2 },
    cargo: { ...DEFAULT_SPEC.cargo },
    colors: { body: PALETTE.carBody[0], glass: PALETTE.carGlass },
    partColors: {},
    extras: { ...DEFAULT_SPEC.extras },
  },
  van: {
    name: 'Van',
    body: { len: 3.9, width: 1.8, height: 1.4, clearance: 0.4, profile: RECT_PROFILE },
    cabin: { lenFrac: 0.72, offsetFrac: -0.04, height: 0.5, widthFrac: 0.88, rakeFront: 0.3, rakeBack: 0 },
    wheels: { radius: 0.34, width: 0.28, insetFrac: 0.32, axles: 2 },
    cargo: { ...DEFAULT_SPEC.cargo },
    colors: { body: PALETTE.carBody[1], glass: PALETTE.carGlass },
    partColors: {},
    extras: { ...DEFAULT_SPEC.extras },
  },
  pickup: {
    name: 'Pickup',
    body: { len: 4.1, width: 1.8, height: 0.75, clearance: 0.45, profile: RECT_PROFILE },
    cabin: { lenFrac: 0.34, offsetFrac: 0.1, height: 0.65, widthFrac: 0.88, rakeFront: 0.28, rakeBack: 0 },
    wheels: { radius: 0.36, width: 0.3, insetFrac: 0.32, axles: 2 },
    cargo: { ...DEFAULT_SPEC.cargo, type: 'bed', bedWall: 0.4 },
    colors: { body: PALETTE.carBody[0], glass: PALETTE.carGlass },
    partColors: {},
    extras: { ...DEFAULT_SPEC.extras },
  },
  boxtruck: {
    name: 'Box truck',
    body: { len: 4.9, width: 2, height: 0.7, clearance: 0.5, profile: RECT_PROFILE },
    cabin: { lenFrac: 0.24, offsetFrac: 0.33, height: 0.85, widthFrac: 0.95, rakeFront: 0.35, rakeBack: 0 },
    wheels: { radius: 0.38, width: 0.32, insetFrac: 0.34, axles: 3 },
    cargo: { ...DEFAULT_SPEC.cargo, type: 'box', boxHeight: 1.9, color: PALETTE.pale },
    colors: { body: PALETTE.carBody[0], glass: PALETTE.carGlass },
    partColors: {},
    extras: { ...DEFAULT_SPEC.extras },
  },
  police: {
    name: 'Police',
    // Matches policeGeometry() in sim/police.js: 3.6 × 1.8 body, white 1.9-long roof at −0.2,
    // a wrap-around skirt stripe, wheels at ±1.08. The "glass" slot carries the white roof.
    body: { len: 3.6, width: 1.8, height: 0.8, clearance: 0.38, profile: RECT_PROFILE },
    cabin: { lenFrac: 1.9 / 3.6, offsetFrac: -0.2 / 3.6, height: 0.62, widthFrac: 1.6 / 1.8, rakeFront: 0, rakeBack: 0 },
    wheels: { radius: 0.32, width: 0.26, insetFrac: 0.3, axles: 2 },
    cargo: { ...DEFAULT_SPEC.cargo },
    colors: { body: PALETTE.policeBody, glass: PALETTE.policeRoof },
    partColors: {},
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
 * A profile chain is valid when x never increases along it (ties allowed — that's a vertical
 * edge) and both ends sit on the ground. With the bottom closure running straight back along
 * y = 0, a monotonic top chain can never self-intersect — which is the whole reason the editor
 * constrains drags this way rather than validating polygons after the fact.
 */
function sanitizeProfile(input) {
  if (!Array.isArray(input)) return structuredClone(RECT_PROFILE);
  const pts = input
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .slice(0, PROFILE_MAX_POINTS)
    .map(([x, y]) => [clamp(Number(x), -0.5, 0.5), clamp(Number(y), 0, 1)]);
  if (pts.length < PROFILE_MIN_POINTS) return structuredClone(RECT_PROFILE);
  for (let i = 1; i < pts.length; i++) pts[i][0] = Math.min(pts[i][0], pts[i - 1][0]);
  pts[0][1] = 0;
  pts[pts.length - 1][1] = 0;
  // A chain that never gets off the ground extrudes to nothing.
  if (Math.max(...pts.map((p) => p[1])) < 0.15) return structuredClone(RECT_PROFILE);
  return pts;
}

/** The profile's height (fraction) directly above fraction-x, taking the max over vertical edges. */
function profileYAt(profile, fx) {
  let top = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const [x0, y0] = profile[i];
    const [x1, y1] = profile[i + 1];
    if (fx > x0 || fx < x1) continue;
    top = Math.max(top, x0 === x1 ? Math.max(y0, y1) : y0 + ((fx - x0) / (x1 - x0)) * (y1 - y0));
  }
  return top;
}

/** The highest point of the profile across a fraction-x span — what a part sits on. */
export function profileTopOver(profile, fxLo, fxHi) {
  const lo = Math.max(-0.5, Math.min(fxLo, fxHi));
  const hi = Math.min(0.5, Math.max(fxLo, fxHi));
  let top = Math.max(profileYAt(profile, lo), profileYAt(profile, hi));
  for (const [x, y] of profile) if (x >= lo && x <= hi) top = Math.max(top, y);
  return top;
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
  out.body.profile = sanitizeProfile(spec.body?.profile ?? out.body.profile);
  // The cabin's top face has to keep some length after both rakes shear it inward.
  const cabinLen = out.body.len * out.cabin.lenFrac;
  const rakeRoom = Math.max(0, cabinLen - 0.3);
  if (out.cabin.rakeFront + out.cabin.rakeBack > rakeRoom) {
    const scale = rakeRoom / (out.cabin.rakeFront + out.cabin.rakeBack);
    out.cabin.rakeFront *= scale;
    out.cabin.rakeBack *= scale;
  }

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

  // Part overrides: sane keys, real colours, bounded count — a spec is pasteable JSON, and
  // pasteable means survivable.
  out.partColors = {};
  for (const [key, value] of Object.entries(spec.partColors ?? {}).slice(0, 32)) {
    if (!/^[a-z][a-z-]{0,23}$/.test(key)) continue;
    const hex = color(value, null);
    if (hex && hex !== 'body') out.partColors[key] = hex;
  }

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

/** Find which manifest part a raycast hit belongs to, from the hit's faceIndex. */
export function partAtFace(manifest, faceIndex) {
  const vertex = faceIndex * 3;
  return manifest.find((p) => vertex >= p.start && vertex < p.start + p.count)?.name ?? null;
}

/**
 * Builds the whole vehicle as one merged, non-indexed geometry with baked vertex colours —
 * ready for propMaterial(), or for tinting via instanceColor if the body is baked white.
 *
 * `geometry.userData.manifest` records each named part's contiguous vertex range
 * (`{ name, start, count }`, in push order — mergeGeometries preserves it), which is what lets
 * the editor raycast the single merged mesh and still know what was clicked.
 */
export function buildVehicleGeometry(spec) {
  const s = normalizeSpec(spec);
  const parts = [];
  // Role colour unless this part has an override. Overrides win even over 'body'-following
  // cargo — an explicit click beats a convention.
  const paint = (name, fallback) => new THREE.Color(s.partColors[name] ?? fallback);
  const add = (name, geo, colorInput) => parts.push({ name, geo: bakeColor(geo, colorInput) });

  const { len, width, height, clearance, profile } = s.body;
  const bodyColor = paint('body', s.colors.body);

  // The side profile, extruded across the width. The chain runs nose → tail and closes along
  // the ground; a rectangular chain builds the exact box the game's carGeometry() uses.
  const shape = new THREE.Shape();
  shape.moveTo(profile[0][0] * len, profile[0][1] * height);
  for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0] * len, profile[i][1] * height);
  const body = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  body.translate(0, clearance, -width / 2);
  add('body', body, bodyColor);

  const cabinLen = len * s.cabin.lenFrac;
  const cabinX = len * s.cabin.offsetFrac;
  // The cabin sits on the roofline beneath it, not on a nominal box top — on a wedge profile
  // the glass follows the body down.
  const cabinBase = clearance
    + height * profileTopOver(profile, s.cabin.offsetFrac - s.cabin.lenFrac / 2, s.cabin.offsetFrac + s.cabin.lenFrac / 2)
    - SINK;
  const cabinTop = cabinBase + s.cabin.height;
  const cabin = new THREE.BoxGeometry(cabinLen, s.cabin.height, width * s.cabin.widthFrac);
  // Shear the top face inward: a raked windscreen (front) and rear screen (back). Applied to
  // the indexed box so every duplicate of a corner moves together — the same welding rule as
  // jitterVertices(), for the same tearing reason.
  {
    const pos = cabin.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        pos.setX(i, pos.getX(i) + (pos.getX(i) > 0 ? -s.cabin.rakeFront : s.cabin.rakeBack));
      }
    }
  }
  cabin.translate(cabinX, cabinBase + s.cabin.height / 2, 0);
  add('cabin', cabin, paint('cabin', s.colors.glass));

  for (const x of axlePositions(s)) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(s.wheels.radius, s.wheels.radius, s.wheels.width, 8);
      wheel.rotateX(Math.PI / 2);   // axle across the car
      wheel.translate(x, s.wheels.radius, sz * (width / 2 - 0.02));
      add('wheels', wheel, paint('wheels', WHEEL_COLOR));
    }
  }

  // Cargo occupies whatever the cabin leaves free at the tail. If the cabin reaches nearly to
  // the rear bumper there is no bed to build, so it quietly disappears rather than inverting.
  const cargoDefault = s.cargo.color === 'body' ? bodyColor : new THREE.Color(s.cargo.color);
  const cargoFront = cabinX - cabinLen / 2 - 0.08;
  const cargoRear = -len / 2;
  if (s.cargo.type !== 'none' && cargoFront - cargoRear > 0.3) {
    const span = cargoFront - cargoRear;
    const mid = (cargoFront + cargoRear) / 2;
    const deckTop = clearance + height * profileTopOver(profile, cargoFront / len, cargoRear / len);
    if (s.cargo.type === 'box') {
      // Slightly wider than the body, box-truck style, so the box reads as its own volume.
      const box = new THREE.BoxGeometry(span, s.cargo.boxHeight, width * 1.05);
      box.translate(mid, deckTop - 2 * SINK + s.cargo.boxHeight / 2, 0);
      add('box', box, paint('box', cargoDefault));
    } else {
      // Open bed: four thin walls around the body top, which itself reads as the bed floor.
      const t = 0.09;
      const y = deckTop - 0.05 + s.cargo.bedWall / 2;
      for (const [bx, bz, lx, lz] of [
        [cargoFront - t / 2, 0, t, width],            // headboard, behind the cabin
        [cargoRear + t / 2, 0, t, width],             // tailgate
        [mid, width / 2 - t / 2, span, t],
        [mid, -(width / 2 - t / 2), span, t],
      ]) {
        const wall = new THREE.BoxGeometry(lx, s.cargo.bedWall, lz);
        wall.translate(bx, y, bz);
        add('bed', wall, paint('bed', cargoDefault));
      }
    }
  }

  if (s.extras.stripe === 'flank') {
    // The taxi's chequer band: a thin box proud of each flank, at the same relative height.
    for (const side of [-1, 1]) {
      const stripe = new THREE.BoxGeometry(len * 0.82, 0.22, 0.06);
      stripe.translate(0, clearance + height * 0.55, side * (width / 2 + 0.02));
      add('stripe', stripe, paint('stripe', s.extras.stripeColor));
    }
  } else if (s.extras.stripe === 'skirt') {
    // The police wrap: a band a hair larger than the body all round, low on the sill.
    const stripe = new THREE.BoxGeometry(len + 0.02, 0.3, width + 0.02);
    stripe.translate(0, clearance + 0.24, 0);
    add('stripe', stripe, paint('stripe', s.extras.stripeColor));
  }

  // Roof furniture recentres on the raked top face — with a fast windscreen the flat part of
  // the roof is further back than the cabin's own centre.
  const roofX = cabinX + (s.cabin.rakeBack - s.cabin.rakeFront) / 2;

  if (s.extras.sign) {
    const sign = new THREE.BoxGeometry(0.75, 0.34, 0.4);
    sign.translate(roofX + 0.1, cabinTop + 0.17, 0);
    add('sign', sign, paint('sign', s.extras.signColor));
  }

  if (s.extras.lightbar) {
    // Baked, unlike the game police car's flashing meshes — the kit builds silhouettes; a
    // flashing bar is behaviour, and behaviour stays in sim/police.js.
    for (const [hex, z] of [['#E24B3C', -0.24], ['#3E66E0', 0.24]]) {
      const lamp = new THREE.BoxGeometry(0.28, 0.2, 0.44);
      lamp.translate(roofX, cabinTop + 0.1, z);
      add('lightbar', lamp, paint('lightbar', hex));
    }
  }

  const merged = mergeGeometries(parts.map((p) => p.geo), false);

  // Consecutive same-name pushes collapse into one manifest entry, so "wheels" is one
  // selectable part rather than four — a range per logical part, not per box.
  const manifest = [];
  let cursor = 0;
  for (const { name, geo } of parts) {
    const count = geo.attributes.position.count;
    const last = manifest[manifest.length - 1];
    if (last && last.name === name) last.count += count;
    else manifest.push({ name, start: cursor, count });
    cursor += count;
  }

  parts.forEach((p) => p.geo.dispose());
  merged.userData.spec = s;
  merged.userData.manifest = manifest;
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
  jitter('cabin.rakeFront', 0.15);
  jitter('wheels.radius', 0.06);
  jitter('wheels.insetFrac', 0.03);
  base.colors.body = PALETTE.carBody[Math.floor(rand() * PALETTE.carBody.length)];
  base.name = `Random ${base.name.toLowerCase()}`;
  return normalizeSpec(base);
}

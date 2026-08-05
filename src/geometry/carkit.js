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
// Body, cabin and cargo box are each an extruded side profile — a chain of (x, y) points, each
// a fraction of that part's length / height, running front-bottom over the top to rear-bottom
// and closing flat along its base. A rectangular chain *is* a box (identical envelope, which is
// what keeps the sedan pin true); dragging a chain is what the editor's silhouette mode does.
// Fractions rather than units so the size sliders keep composing with a drawn profile.
//
// A chain may double back on itself — a bumper that juts at mid-height, a spoiler lip — so
// validity is "the closed polygon is simple", checked edge against edge, not "x is monotonic".
// The editor rejects a drag that would cross the outline; sanitizeChain() repairs or falls back
// for imported JSON.

const WHEEL_COLOR = '#6f6f76';   // sRGB for the linear (0.16, 0.16, 0.18) the game's wheels bake
// How far the tread stands out past the flank — geometry/wheels.js's rule, kept in step: wheels
// anchor by their OUTER FACE, not their centre, so widening a tyre doesn't push the track out.
const WHEEL_PROUD = 0.11;
const SINK = 0.03;
// Cabin and cargo sink SINK into the surface below them, so lighting never opens a seam
// between stacked volumes. The sedan's cabin at y 1.45 = body top 1.18 − 0.03 + half-height 0.30.

export const CHAIN_MIN_POINTS = 3;
export const PROFILE_MAX_POINTS = 12;
const RECT_PROFILE = [[0.5, 0], [0.5, 1], [-0.5, 1], [-0.5, 0]];

/** Slider ranges, shared by the editor UI and by normalizeSpec() clamping imported JSON. */
export const LIMITS = {
  'body.len': [2.4, 6],
  'body.width': [1.2, 2.6],
  'body.height': [0.4, 2],
  'body.clearance': [0.2, 1],
  'cabin.lenFrac': [0.15, 0.95],
  'cabin.offsetFrac': [-0.42, 0.42],
  'cabin.height': [0.2, 1.4],
  'cabin.widthFrac': [0.6, 1],
  'cabin.rakeFront': [0, 1.2],
  'cabin.rakeBack': [0, 1.2],
  'wheels.radius': [0.2, 0.85],
  'wheels.width': [0.14, 0.7],
  'wheels.insetFrac': [0.18, 0.44],
  'wheels.axles': [2, 3],
  'wheels.segments': [6, 24],
  'cargo.boxHeight': [0.6, 2.4],
  'cargo.boxWidthFrac': [0.7, 1.15],
  'cargo.boxOverhang': [0, 0.6],
  'cargo.bedWall': [0.15, 0.9],
  'cargo.bedThickness': [0.05, 0.2],
};

export const DEFAULT_SPEC = {
  name: 'Sedan',
  // Clearance 0.70 = the 0.38 the body was designed at plus the game's CHASSIS_LIFT (0.32),
  // which followed the wheels doubling to r 0.64 so the steering would read at play zoom.
  body: { len: 3.4, width: 1.7, height: 0.8, clearance: 0.7, profile: RECT_PROFILE },
  // Fractions of body length, so stretching the body carries the cabin with it. The rakes lean
  // the windscreen and rear screen in; profile null means "shaped by the rakes" — a trapezoid —
  // and a chain drawn in the editor replaces the rakes as the cabin's silhouette.
  cabin: {
    lenFrac: 0.5, offsetFrac: -0.2 / 3.4, height: 0.6, widthFrac: 0.86,
    rakeFront: 0, rakeBack: 0, profile: null,
  },
  wheels: { radius: 0.64, width: 0.52, insetFrac: 0.3, axles: 2, segments: 8 },
  // type: 'none' | 'bed' (open pickup walls) | 'box' (tall cargo body). color 'body' follows
  // the body colour, so recolouring the truck doesn't leave a stale bed behind. boxOverhang
  // extends the box past the rear bumper, box-truck style; profile shapes the box's flank.
  cargo: {
    type: 'none', boxHeight: 1.6, boxWidthFrac: 1.05, boxOverhang: 0,
    bedWall: 0.4, bedThickness: 0.09, color: 'body', profile: null,
  },
  colors: { body: PALETTE.carBody[2], glass: PALETTE.carGlass, wheels: WHEEL_COLOR },
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
    colors: { ...DEFAULT_SPEC.colors, body: PALETTE.taxiBody },
    extras: { ...DEFAULT_SPEC.extras, stripe: 'flank', sign: true },
  },
  sports: {
    name: 'Sports car',
    // The profile showcase: nose low, screen fast, tail chopped — none of it reachable with a box.
    body: {
      len: 3.7, width: 1.75, height: 0.95, clearance: 0.56,
      profile: [[0.5, 0], [0.5, 0.4], [0.1, 0.78], [-0.18, 1], [-0.44, 0.96], [-0.5, 0.5], [-0.5, 0]],
    },
    cabin: { ...DEFAULT_SPEC.cabin, lenFrac: 0.4, offsetFrac: -0.12, height: 0.34, widthFrac: 0.88, rakeFront: 0.45, rakeBack: 0.3 },
    wheels: { ...DEFAULT_SPEC.wheels, radius: 0.6, width: 0.5, insetFrac: 0.34 },
    cargo: { ...DEFAULT_SPEC.cargo },
    colors: { ...DEFAULT_SPEC.colors, body: PALETTE.carBody[0] },
    partColors: {},
    extras: { ...DEFAULT_SPEC.extras },
  },
  van: {
    name: 'Van',
    body: { len: 3.9, width: 1.8, height: 1.4, clearance: 0.72, profile: RECT_PROFILE },
    cabin: { ...DEFAULT_SPEC.cabin, lenFrac: 0.72, offsetFrac: -0.04, height: 0.5, widthFrac: 0.88, rakeFront: 0.3 },
    wheels: { ...DEFAULT_SPEC.wheels, radius: 0.66, insetFrac: 0.32 },
    cargo: { ...DEFAULT_SPEC.cargo },
    colors: { ...DEFAULT_SPEC.colors, body: PALETTE.carBody[1] },
    partColors: {},
    extras: { ...DEFAULT_SPEC.extras },
  },
  pickup: {
    name: 'Pickup',
    body: { len: 4.1, width: 1.8, height: 0.75, clearance: 0.79, profile: RECT_PROFILE },
    cabin: { ...DEFAULT_SPEC.cabin, lenFrac: 0.34, offsetFrac: 0.1, height: 0.65, widthFrac: 0.88, rakeFront: 0.28 },
    wheels: { ...DEFAULT_SPEC.wheels, radius: 0.7, width: 0.56, insetFrac: 0.32 },
    cargo: { ...DEFAULT_SPEC.cargo, type: 'bed', bedWall: 0.4 },
    colors: { ...DEFAULT_SPEC.colors, body: PALETTE.carBody[0] },
    partColors: {},
    extras: { ...DEFAULT_SPEC.extras },
  },
  boxtruck: {
    name: 'Box truck',
    body: { len: 4.9, width: 2, height: 0.7, clearance: 0.86, profile: RECT_PROFILE },
    cabin: { ...DEFAULT_SPEC.cabin, lenFrac: 0.24, offsetFrac: 0.33, height: 0.85, widthFrac: 0.95, rakeFront: 0.35 },
    wheels: { ...DEFAULT_SPEC.wheels, radius: 0.74, width: 0.58, insetFrac: 0.34, axles: 3 },
    cargo: { ...DEFAULT_SPEC.cargo, type: 'box', boxHeight: 1.9, boxOverhang: 0.35, color: PALETTE.pale },
    colors: { ...DEFAULT_SPEC.colors, body: PALETTE.carBody[0] },
    partColors: {},
    extras: { ...DEFAULT_SPEC.extras },
  },
  police: {
    name: 'Police',
    // Matches policeGeometry() in sim/police.js: 3.6 × 1.8 body, white 1.9-long roof at −0.2,
    // a wrap-around skirt stripe, wheels at ±1.08. The "glass" slot carries the white roof.
    body: { len: 3.6, width: 1.8, height: 0.8, clearance: 0.7, profile: RECT_PROFILE },
    cabin: { ...DEFAULT_SPEC.cabin, lenFrac: 1.9 / 3.6, offsetFrac: -0.2 / 3.6, height: 0.62, widthFrac: 1.6 / 1.8 },
    wheels: { ...DEFAULT_SPEC.wheels },
    cargo: { ...DEFAULT_SPEC.cargo },
    colors: { ...DEFAULT_SPEC.colors, body: PALETTE.policeBody, glass: PALETTE.policeRoof },
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

// --- Chain geometry helpers ---------------------------------------------------------------

const cross = (ox, oy, ax, ay, bx, by) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

/** Proper or improper intersection of segments ab and cd (touching counts as intersecting). */
function segmentsCross(a, b, c, d) {
  const d1 = cross(c[0], c[1], d[0], d[1], a[0], a[1]);
  const d2 = cross(c[0], c[1], d[0], d[1], b[0], b[1]);
  const d3 = cross(a[0], a[1], b[0], b[1], c[0], c[1]);
  const d4 = cross(a[0], a[1], b[0], b[1], d[0], d[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p, q, r) => Math.min(p[0], q[0]) - 1e-9 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-9
    && Math.min(p[1], q[1]) - 1e-9 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  if (Math.abs(d1) < 1e-12 && on(c, d, a)) return true;
  if (Math.abs(d2) < 1e-12 && on(c, d, b)) return true;
  if (Math.abs(d3) < 1e-12 && on(a, b, c)) return true;
  if (Math.abs(d4) < 1e-12 && on(a, b, d)) return true;
  return false;
}

/**
 * True when the chain, closed along its base, is a simple polygon. This is the validity rule
 * that lets a chain double back — obtuse noses, spoiler lips — while a drag that would fold the
 * outline through itself is refused by the editor before it ever reaches the mesh.
 */
export function chainIsSimple(pts) {
  const n = pts.length;
  if (n < CHAIN_MIN_POINTS) return false;
  const at = (i) => pts[i % n];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share an endpoint; the first and last edge close the polygon together.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(at(i), at(i + 1), at(j), at(j + 1))) return false;
    }
  }
  return true;
}

function chainArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

/**
 * Clamp, weld and validate an imported chain. Returns null when nothing usable survives — the
 * caller decides the fallback (the rectangle for the body, "shaped by the rakes" for a cabin).
 * A crossing chain is first repaired by forcing x monotonic, which is simple by construction;
 * only if that still fails does it give up.
 */
export function sanitizeChain(input) {
  if (!Array.isArray(input)) return null;
  let pts = input
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .slice(0, PROFILE_MAX_POINTS)
    .map(([x, y]) => [clamp(Number(x), -0.5, 0.5), clamp(Number(y), 0, 1)]);
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6);
  if (pts.length < CHAIN_MIN_POINTS) return null;
  pts[0][1] = 0;
  pts[pts.length - 1][1] = 0;
  for (let i = 1; i < pts.length - 1; i++) pts[i][1] = Math.max(pts[i][1], 0.02);
  if (!chainIsSimple(pts)) {
    for (let i = 1; i < pts.length; i++) pts[i][0] = Math.min(pts[i][0], pts[i - 1][0]);
    pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6);
    if (pts.length < CHAIN_MIN_POINTS || !chainIsSimple(pts)) return null;
  }
  // A sliver or a chain that never gets off the ground extrudes to nothing.
  if (Math.abs(chainArea(pts)) < 0.05 || Math.max(...pts.map((p) => p[1])) < 0.15) return null;
  return pts;
}

/** The chain's height (fraction) directly above fraction-x, over every edge covering that x. */
function chainYAt(profile, fx) {
  let top = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const [x0, y0] = profile[i];
    const [x1, y1] = profile[i + 1];
    if (fx < Math.min(x0, x1) || fx > Math.max(x0, x1)) continue;
    top = Math.max(top, x0 === x1 ? Math.max(y0, y1) : y0 + ((fx - x0) / (x1 - x0)) * (y1 - y0));
  }
  return top;
}

/** The highest point of the chain across a fraction-x span — what a part stacked on it sits on. */
export function profileTopOver(profile, fxLo, fxHi) {
  const lo = Math.max(-0.5, Math.min(fxLo, fxHi));
  const hi = Math.min(0.5, Math.max(fxLo, fxHi));
  let top = Math.max(chainYAt(profile, lo), chainYAt(profile, hi));
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
  out.wheels.segments = Math.round(out.wheels.segments);
  out.body.profile = sanitizeChain(spec.body?.profile ?? out.body.profile) ?? structuredClone(RECT_PROFILE);
  // null means "no drawn silhouette": the cabin falls back to its rake trapezoid, the cargo box
  // to a rectangle. An invalid drawn chain degrades to that same null rather than to junk.
  out.cabin.profile = spec.cabin?.profile == null ? null : sanitizeChain(spec.cabin.profile);
  out.cargo.profile = spec.cargo?.profile == null ? null : sanitizeChain(spec.cargo.profile);
  // The cabin's top edge has to keep some length after both rakes lean in.
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
  out.colors.wheels = color(spec.colors?.wheels ?? out.colors.wheels, out.colors.wheels);
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

/**
 * The silhouette actually in force for each profiled part of a normalized spec. A cabin with no
 * drawn chain is its rake trapezoid — which extrudes to exactly the sheared box the rakes used
 * to produce — and a cargo box with none is a rectangle. `box` is null when there is no box.
 */
export function effectiveChains(s) {
  const cabinLen = s.body.len * s.cabin.lenFrac;
  return {
    body: s.body.profile,
    cabin: s.cabin.profile ?? [
      [0.5, 0],
      [0.5 - s.cabin.rakeFront / cabinLen, 1],
      [-0.5 + s.cabin.rakeBack / cabinLen, 1],
      [-0.5, 0],
    ],
    box: s.cargo.type === 'box' ? (s.cargo.profile ?? structuredClone(RECT_PROFILE)) : null,
  };
}

/**
 * Where each profiled part sits: origin (x at centre, y at base), length, height and half-width
 * of its extrusion. One computation shared by the builder and the editor's silhouette handles,
 * so the handles can never drift off the mesh they claim to edit.
 */
export function layoutOf(s) {
  const { len, width, height, clearance, profile } = s.body;
  const cabinLen = len * s.cabin.lenFrac;
  const cabinX = len * s.cabin.offsetFrac;
  const cabinBase = clearance
    + height * profileTopOver(profile, s.cabin.offsetFrac - s.cabin.lenFrac / 2, s.cabin.offsetFrac + s.cabin.lenFrac / 2)
    - SINK;
  const layout = {
    body: { x: 0, y: clearance, len, height, halfW: width / 2 },
    cabin: { x: cabinX, y: cabinBase, len: cabinLen, height: s.cabin.height, halfW: (width * s.cabin.widthFrac) / 2 },
    box: null,
    bed: null,
  };

  const cargoFront = cabinX - cabinLen / 2 - 0.08;
  const cargoRear = -len / 2;
  if (s.cargo.type !== 'none' && cargoFront - cargoRear > 0.3) {
    const deckTop = clearance + height * profileTopOver(profile, cargoFront / len, cargoRear / len);
    if (s.cargo.type === 'box') {
      // The overhang extends the box past the rear bumper, box-truck style.
      const rear = cargoRear - s.cargo.boxOverhang;
      layout.box = {
        x: (cargoFront + rear) / 2,
        y: deckTop - 2 * SINK,
        len: cargoFront - rear,
        height: s.cargo.boxHeight,
        halfW: (width * s.cargo.boxWidthFrac) / 2,
      };
    } else {
      layout.bed = { front: cargoFront, rear: cargoRear, deckTop, width };
    }
  }
  return layout;
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

/** A chain extruded across `depth`, in its part's local frame (x, y at the origin, z centred). */
function extrudeChain(chain, spanLen, height, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(chain[0][0] * spanLen, chain[0][1] * height);
  for (let i = 1; i < chain.length; i++) shape.lineTo(chain[i][0] * spanLen, chain[i][1] * height);
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  return geo;
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

  const { len, width, clearance } = s.body;
  const bodyColor = paint('body', s.colors.body);
  const chains = effectiveChains(s);
  const frames = layoutOf(s);

  const body = extrudeChain(chains.body, len, s.body.height, width);
  body.translate(0, clearance, 0);
  add('body', body, bodyColor);

  const cabin = extrudeChain(chains.cabin, frames.cabin.len, frames.cabin.height, frames.cabin.halfW * 2);
  cabin.translate(frames.cabin.x, frames.cabin.y, 0);
  add('cabin', cabin, paint('cabin', s.colors.glass));

  for (const x of axlePositions(s)) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(s.wheels.radius, s.wheels.radius, s.wheels.width, s.wheels.segments);
      wheel.rotateX(Math.PI / 2);   // axle across the car
      // Anchored by the tread's outer face, like geometry/wheels.js — widening a tyre grows it
      // inward under the body instead of pushing the track out onto outriggers.
      wheel.translate(x, s.wheels.radius, sz * (width / 2 + WHEEL_PROUD - s.wheels.width / 2));
      add('wheels', wheel, paint('wheels', s.colors.wheels));
    }
  }

  // Cargo occupies whatever the cabin leaves free at the tail. If the cabin reaches nearly to
  // the rear bumper there is no bed or box to build, so it quietly disappears rather than
  // inverting — layoutOf() already made that call.
  const cargoDefault = s.cargo.color === 'body' ? bodyColor : new THREE.Color(s.cargo.color);
  if (frames.box) {
    const box = extrudeChain(chains.box, frames.box.len, frames.box.height, frames.box.halfW * 2);
    box.translate(frames.box.x, frames.box.y, 0);
    add('box', box, paint('box', cargoDefault));
  } else if (frames.bed) {
    // Open bed: four thin walls around the body top, which itself reads as the bed floor.
    const { front, rear, deckTop } = frames.bed;
    const t = s.cargo.bedThickness;
    const span = front - rear;
    const mid = (front + rear) / 2;
    const y = deckTop - 0.05 + s.cargo.bedWall / 2;
    for (const [bx, bz, lx, lz] of [
      [front - t / 2, 0, t, width],            // headboard, behind the cabin
      [rear + t / 2, 0, t, width],             // tailgate
      [mid, width / 2 - t / 2, span, t],
      [mid, -(width / 2 - t / 2), span, t],
    ]) {
      const wall = new THREE.BoxGeometry(lx, s.cargo.bedWall, lz);
      wall.translate(bx, y, bz);
      add('bed', wall, paint('bed', cargoDefault));
    }
  }

  if (s.extras.stripe === 'flank') {
    // The taxi's chequer band: a thin box proud of each flank, at the same relative height.
    for (const side of [-1, 1]) {
      const stripe = new THREE.BoxGeometry(len * 0.82, 0.22, 0.06);
      stripe.translate(0, clearance + s.body.height * 0.55, side * (width / 2 + 0.02));
      add('stripe', stripe, paint('stripe', s.extras.stripeColor));
    }
  } else if (s.extras.stripe === 'skirt') {
    // The police wrap: a band a hair larger than the body all round, low on the sill.
    const stripe = new THREE.BoxGeometry(len + 0.02, 0.3, width + 0.02);
    stripe.translate(0, clearance + 0.24, 0);
    add('stripe', stripe, paint('stripe', s.extras.stripeColor));
  }

  // Roof furniture sits on the cabin chain's highest run, recentred on it — with a fast
  // windscreen (or a drawn silhouette) the flat part of the roof is not the cabin's centre.
  const cabinPeak = Math.max(...chains.cabin.map((p) => p[1]));
  const peaks = chains.cabin.filter((p) => p[1] >= cabinPeak - 1e-6);
  const roofX = frames.cabin.x + (peaks.reduce((sum, p) => sum + p[0], 0) / peaks.length) * frames.cabin.len;
  const cabinTop = frames.cabin.y + cabinPeak * frames.cabin.height;

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
  base.wheels.segments = [6, 8, 8, 10, 12][Math.floor(rand() * 5)];
  base.colors.body = PALETTE.carBody[Math.floor(rand() * PALETTE.carBody.length)];
  base.name = `Random ${base.name.toLowerCase()}`;
  return normalizeSpec(base);
}

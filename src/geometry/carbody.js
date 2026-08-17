import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { CHASSIS_LIFT, WHEEL_R, wheelAnchors } from './wheels.js';

// The bodywork every vehicle in the game is cut from: the ambient fleet and the box trucks
// (sim/traffic.js), the player's taxi (geometry/taxi.js) and the cruiser (sim/police.js).
//
// It exists for the same reason geometry/wheels.js does — traffic.js and taxi.js already import
// each other, and a constant crossing that cycle at module-evaluation time is a temporal-dead-zone
// error — and for one more: four files were each building a car out of two `BoxGeometry` calls and
// the same two magic y values, so every one of them had to be edited in step or the fleet stopped
// looking like one fleet. Nothing here imports back.
//
// ## Everything is a lofted box
//
// `loftBox` takes a stack of rectangular rings and skins them. That single primitive is what
// produces all four of the shapes below, none of which a `BoxGeometry` can hold:
//
//   - a **chamfer**, by insetting the top ring — the cut edge catches a different value from the
//     roof and the flank either side of it, which at this camera is the only thing that says an
//     edge is an edge rather than a colour change;
//   - a **tuck**, by insetting the bottom ring, so the sill draws in under the waist instead of
//     dropping to the road as a slab;
//   - a **trapezoid greenhouse**, by narrowing the roof ring — the tumblehome that stops a cabin
//     reading as a shoebox parked on a shoebox;
//   - a **lean-back**, by walking the ring's *centre* aft as it rises, which rakes the windscreen
//     hard and the backlight gently. That asymmetry is the whole silhouette: rake both ends equally
//     and the car has no front.
//
// A ring is a rectangle rather than an arbitrary polygon on purpose. Every gradient this project
// bakes has to stay on one axis per quad (see docs/rendering.md), and four-cornered rings keep each
// face a planar quad — a twisted one shows the diagonal seam between its two triangles.
//
// ## Wheel arches
//
// The lower flank is cut back `ARCH_DEPTH` over the length of the car and filled back out to full
// width only *between* the wheels. What is left is an opening at each axle with the tyre standing
// in it, an eyebrow of full-width bodywork over the top, and a rocker panel in the middle — which
// is also why `WHEEL_PROUD` could finally go negative (geometry/wheels.js): the arch is what makes
// a tucked-in wheel visible, so the tread no longer has to stand outside the flank to be seen.
//
// The segments are **derived from the wheel anchors**, not typed. A car's wheels are so large
// relative to it (radius 0.64 on a 3.4-long body) that both arches run clean off the ends and the
// only full-width section left is the rocker; a truck, three times the wheelbase, keeps a nose and
// a tail section as well. One rule covers both, and re-proportioning a vehicle moves its arches.

/** How far a top edge is cut back, in world units — the chamfer's own width. */
const CHAMFER = 0.10;
/** How far the sill draws in under the waist. */
const TUCK = 0.09;
/** How far the flank is cut back at an axle. Half the tread (0.26) sits in the opening. */
const ARCH_DEPTH = 0.30;

// The four stations every body is built between, in the same design space every vehicle y is
// written in — the number the part was drawn at, plus CHASSIS_LIFT (see geometry/wheels.js).
const FLOOR = 0.38;      // underside of the bodywork
const WAIST = 0.47;      // where the tuck meets full width
const ARCH_TOP = 0.80;   // top of the wheel opening
const SHOULDER = 1.04;   // where the roof chamfer starts
const DECK = 1.18;       // top of the bodywork

/**
 * The top of the wheel sits at `2 * WHEEL_R - CHASSIS_LIFT` = 0.96 in this space, which is
 * deliberately **above** `ARCH_TOP`: the crown of the tyre is 0.16 up inside the wing, the way a
 * real one is, and only the part of it below the eyebrow shows through the opening. Cut the arch
 * any higher and the wing stops being a wing — you see daylight over the tyre.
 */
export const ARCH_CLEARANCE = (2 * WHEEL_R - CHASSIS_LIFT) - ARCH_TOP;

/**
 * How dark the inside of an arch is against the paint outside it.
 *
 * Measured against a rendered close-up rather than picked: at 0.42 the opening went black under its
 * own eyebrow — the shoulder shadows it, and the AO pass darkens the crease on top of that — and a
 * black opening reads as a hole cut through the car rather than as bodywork you are looking into.
 * 0.55 survives both and still leaves the well a clear stop darker than the flank.
 */
const WELL_SHADE = 0.55;

/** Fore-aft half-length of an arch opening. A little past the tyre, so the tread never touches a
 * wall of the well it is standing in. */
const ARCH_HALF = WHEEL_R * 1.06;

/** A full-width section shorter than this isn't a panel, it's a sliver — see `bodySegments`. */
const MIN_SEGMENT = 0.18;

/**
 * Skin a stack of rectangular rings, bottom to top, and cap both ends.
 *
 * A ring is `{ y, hx, hz, cx }` — its height, its half-length, its half-width, and where its
 * centre sits along the car. Consecutive rings are joined by four planar quads; the first and last
 * are capped.
 *
 * **Winding is set here and asserted in `tools/probe.mjs`**, not eyeballed. `bakeColor` runs
 * `computeVertexNormals`, which launders a reversed triangle into whatever its neighbours claim —
 * so a face wound backwards does not vanish, it lights as if the sun were behind it and reads as a
 * shading bug three steps away from its cause (the roadworks ramp shipped exactly that way). The
 * corner order below — `+x-z, +x+z, -x+z, -x-z` — is what makes each side quad's normal point out
 * of the solid; the top cap has to be walked in reverse for the same reason.
 */
export function loftBox(rings) {
  const pos = [];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const corner = (ring, k) => [
    (ring.cx ?? 0) + (k === 0 || k === 1 ? ring.hx : -ring.hx),
    ring.y,
    k === 1 || k === 2 ? ring.hz : -ring.hz,
  ];

  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const next = (k + 1) % 4;
      quad(corner(rings[i], k), corner(rings[i + 1], k),
        corner(rings[i + 1], next), corner(rings[i], next));
    }
  }

  const base = rings[0];
  quad(corner(base, 0), corner(base, 1), corner(base, 2), corner(base, 3));
  const top = rings[rings.length - 1];
  quad(corner(top, 3), corner(top, 2), corner(top, 1), corner(top, 0));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geometry;
}

/**
 * Tag a geometry's vertices as glass, 0..1 — the mask the moving reflection in `util/geo.js` is
 * keyed off (`propMaterial({ sheen: true })`).
 *
 * It has to run **after** `bakeColor`, which strips every attribute it doesn't recognise. And every
 * part merged into one vehicle has to carry it, glass or not: `mergeGeometries` refuses a set whose
 * attributes disagree. A material declaring the attribute against geometry that lacks it is safe —
 * WebGL hands the shader a constant 0 — which is why the wheels and light pods need no tagging of
 * their own.
 */
export function stampGloss(geometry, value) {
  const data = new Float32Array(geometry.attributes.position.count);
  data.fill(value);
  geometry.setAttribute('aGloss', new THREE.BufferAttribute(data, 1));
  return geometry;
}

/** `loftBox` + `bakeColor` + `stampGloss`, which is how every part below is made. */
function panel(rings, tint, gloss = 0) {
  return stampGloss(bakeColor(loftBox(rings), tint), gloss);
}

/**
 * The full-width sections of the lower flank: everything left over once an arch opening has been
 * taken out around each axle. Derived from the vehicle's own wheel anchors, so re-proportioning it
 * moves the arches with the wheels.
 *
 * An arch that runs off the end of the car is clamped rather than refused — on a car it genuinely
 * does, and the bumper is what closes the nose there.
 */
export function bodySegments(len, width) {
  const hl = len / 2;
  const cuts = wheelAnchors(len, width)
    .filter((anchor) => anchor.z > 0)
    .map((anchor) => [anchor.x - ARCH_HALF, anchor.x + ARCH_HALF])
    .sort((a, b) => a[0] - b[0]);

  const segments = [];
  let x = -hl;
  for (const [from, to] of cuts) {
    if (Math.min(from, hl) - x > MIN_SEGMENT) segments.push([x, Math.min(from, hl)]);
    x = Math.max(x, to);
  }
  if (hl - x > MIN_SEGMENT) segments.push([x, hl]);
  return segments;
}

/**
 * A bumper, wrapping one end of the car. Sits a shade proud of the flank so its outer face and the
 * body's can never be coplanar — the same fix `LIGHT_PROUD` (geometry/lights.js) applies to a light
 * pod, for the same z-fighting reason.
 *
 * It is deliberately *shallow* fore-aft and does not reach past the light pods. A wheel of this
 * size on a car this short leaves about 4cm of front overhang, so anything deeper simply intersects
 * the front tyre — and anything longer would push the ghost outline's hull past the envelope the
 * taxi-finder chip and the tutorial avatar are framed against (see `tools/probe.mjs`).
 */
function bumper(hl, hw, sx, tint) {
  const DEPTH = 0.14;
  const cx = sx * (hl - DEPTH / 2);
  return panel([
    { y: 0.30, hx: DEPTH / 2, hz: hw - 0.06, cx },
    { y: 0.37, hx: DEPTH / 2, hz: hw + 0.02, cx },
    { y: 0.53, hx: DEPTH / 2, hz: hw + 0.02, cx },
    { y: 0.60, hx: DEPTH / 2 - 0.03, hz: hw - 0.04, cx },
  ], tint);
}

/**
 * Every panel of one vehicle's bodywork, baked, gloss-tagged and lifted onto its wheels — ready to
 * merge with `wheelGeometries()` and whatever livery the caller adds on top.
 *
 * @param len          fore-aft length of the body
 * @param width        across the flanks
 * @param paint        body colour. **White for an instanced fleet**, whose `instanceColor`
 *                     multiplies it; an actual colour for the taxi and the cruiser.
 * @param trim         the bumpers. Dark on every vehicle so far.
 * @param cabin        the greenhouse, or `null` for a chassis that carries its own (the trucks).
 *                     `{ color, lengthOf, widthOf, x, top, gloss }` — the first two as fractions of
 *                     the body, so a cabin stays in proportion when a vehicle is resized.
 */
export function carBodyParts({ len, width, paint, trim, cabin }) {
  const hl = len / 2;
  const hw = width / 2;
  const inner = hw - ARCH_DEPTH;
  const well = new THREE.Color(paint).multiplyScalar(WELL_SHADE);
  const parts = [];

  // The spine: full length at arch width, and what you actually see inside a wheel well. Painted a
  // shade of the car's own paint rather than a flat black — on the instanced fleet that is the one
  // construction that survives `instanceColor`, since a baked grey times the car's tint is that car
  // in shadow, and a baked black times anything is still black.
  parts.push(panel([
    { y: FLOOR, hx: hl - 0.06, hz: inner - 0.05 },
    { y: WAIST, hx: hl, hz: inner },
    { y: ARCH_TOP, hx: hl, hz: inner },
  ], well));

  // ...filled back out to full width wherever there is no wheel. On a car that is the rocker panel
  // between the arches and nothing else; on a truck it is a nose and a tail as well.
  for (const [from, to] of bodySegments(len, width)) {
    const cx = (from + to) / 2;
    const hx = (to - from) / 2;
    parts.push(panel([
      { y: FLOOR, hx, hz: hw - TUCK, cx },
      { y: WAIST, hx, hz: hw, cx },
      { y: ARCH_TOP, hx, hz: hw, cx },
    ], paint));
  }

  // The shoulder — full width over the whole car, so the arches get their eyebrow — with the roof
  // edge chamfered off. Overlapping solids rather than a watertight hull: everything here is opaque
  // and the depth buffer sorts it out, where mitring the joins would cost geometry nobody can see.
  parts.push(panel([
    { y: ARCH_TOP, hx: hl, hz: hw },
    { y: SHOULDER, hx: hl, hz: hw },
    { y: DECK, hx: hl - 0.12, hz: hw - CHAMFER },
  ], paint));

  if (trim) for (const sx of [-1, 1]) parts.push(bumper(hl, hw, sx, trim));

  if (cabin) {
    const chl = (len * cabin.lengthOf) / 2;
    const chw = (width * cabin.widthOf) / 2;
    const sill = DECK - 0.03;                       // buried in the deck, never flush with it
    const mid = sill + (cabin.top - sill) * 0.45;
    parts.push(panel([
      { y: sill, hx: chl, hz: chw, cx: cabin.x },
      { y: mid, hx: chl * 0.92, hz: chw * 0.985, cx: cabin.x - 0.04 },
      { y: cabin.top, hx: chl * 0.68, hz: chw * 0.82, cx: cabin.x - 0.14 },
    ], cabin.color, cabin.gloss ?? 1));
  }

  for (const part of parts) part.translate(0, CHASSIS_LIFT, 0);
  return parts;
}

/**
 * The belt line — where a stripe, a chequer or a livery band goes, and the only band on the car
 * that is full width for its whole length.
 *
 * Exported because both liveries in the game sit in it and neither may guess at it: the flank below
 * `ARCH_TOP` is *missing* over each arch, so a stripe painted at the old waist height floated in
 * mid-air across both wheel openings. `{ y, height }` is the middle of the band and how tall a
 * stripe may be without touching the arch under it or the chamfer over it.
 */
export const BELT = {
  y: (ARCH_TOP + SHOULDER) / 2 + CHASSIS_LIFT,
  height: (SHOULDER - ARCH_TOP) - 0.04,
};

/** Top of the bodywork, lifted — where a roof sign, a light bar or an antenna is bolted on. */
export const BODY_TOP = DECK + CHASSIS_LIFT;

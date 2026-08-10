import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, jitterVertices } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';

// The furniture of a closed street: cones, a striped trestle barricade with a plywood ramp
// propped against it, and the spoil heap from whatever hole the crew is standing over.
//
// Same idiom as `city/props.js` — every function returns an *array of baked geometries* in world
// (or local) space rather than meshes, so the caller merges them into one draw call. The one
// exception is the cone, which is returned as a single geometry because it is drawn as an
// InstancedMesh: cones are the only piece that has to move independently once the taxi arrives.
//
// Everything here sits on the carriageway, so y = 0 is the road surface — not KERB_H, which is
// where `props.js` puts its trees and lamps.
//
// The heights things sit at are a stack, and the two constants below are the roadworks' slots in
// it: road slab 0 · lane paint MARK_Y 0.02 · **TRENCH_Y** · route band 0.03 · **WORKS_Y** · cars
// ROAD_Y 0.04. A solid prop therefore draws over the route band and under a car, and the painted
// hole draws over the lane dashes it overlaps but still lets the band run across it.
//
// Anything with a flat *downward* face — a cone's base slab, a trestle's feet — is left sitting on
// y = 0 rather than lifted. `propMaterial()` is FrontSide, so a correctly wound bottom face is
// culled and cannot fight the road; lifting those would be a gap under the prop bought for
// nothing. Which makes winding the thing that matters, not clearance — see `rampWedge`.
export const WORKS_Y = 0.035;
export const TRENCH_Y = 0.024;

const CONE_H = 0.95;          // ~7px at play zoom. A real cone would be a third of this and invisible.
export const CONE_BASE_R = 0.31;
const CONE_TIP_R = 0.05;
const CONE_SIDES = 7;         // odd, so a row of cones never lines its facets up into a flat wall

/**
 * One traffic cone, origin at the centre of its base.
 *
 * The band is a separate short cylinder sleeved over the taper rather than a second colour on the
 * cone's own vertices, because `bakeColor` paints a whole geometry one colour — splitting the
 * taper into three stacked cylinders would triple the facet count for a stripe that is two pixels
 * tall. Its radii are the taper's own radii at the band's height plus 0.012, which is what keeps
 * it from z-fighting the surface it is wrapped around.
 */
export function coneGeometry() {
  const parts = [];

  const slab = new THREE.BoxGeometry(0.62, 0.07, 0.62);
  slab.translate(0, 0.035, 0);
  parts.push(bakeColor(slab, color('cone')));

  const body = new THREE.CylinderGeometry(CONE_TIP_R, CONE_BASE_R, CONE_H, CONE_SIDES);
  body.translate(0, CONE_H / 2 + 0.07, 0);
  parts.push(bakeColor(body, color('cone')));

  // Band from 0.42 to 0.56 of the way up the taper.
  const at = (h) => CONE_BASE_R + (CONE_TIP_R - CONE_BASE_R) * (h / CONE_H) + 0.012;
  const band = new THREE.CylinderGeometry(at(0.56), at(0.42), 0.14, CONE_SIDES);
  band.translate(0, 0.49 + 0.07, 0);
  parts.push(bakeColor(band, color('coneBand')));

  return mergeAll(parts);
}

/** How high a cone's origin sits when it has been knocked onto its side. */
export const CONE_REST_Y = CONE_BASE_R;

const PLANK_H = 0.26;
const PLANK_T = 0.11;
const PLANK_LOW = 0.46;
const PLANK_HIGH = 0.92;
const BARRIER_TOP = PLANK_HIGH + PLANK_H / 2;
const STRIPES = 9;            // odd, so both ends of a plank are the same colour
// 0.62 over 1.9 is 18° of slope. The first pair was 0.66 over 3.2 — 12°, which at this camera is
// not a ramp but a plywood plate, and long enough that its toe landed 1.5 units *inside* the
// junction box behind the barricade (see BARRIER_S in game/roadwork.js, which the run has to clear).
export const RAMP_RUN = 1.9;
export const RAMP_H = 0.62;

/**
 * A trestle barricade and the ramp leaning on it, in local space:
 * **+X across the road, +Y up, +Z the direction of travel**, origin on the road at the line the
 * barricade stands on. The caller rotates it onto a lane.
 *
 * `centreX` is where the trestle's midpoint sits relative to that origin, because the origin is a
 * lane centre and the barricade spans the whole road — the two are `LANE` apart. The ramp spans and
 * is centred on the same span: a barricade that blocks the street across but is only rampable in
 * one lane reads as half-closed, and the ramp was the half that looked wrong.
 *
 * The two come back **separately** because they meet different ends: the trestle is knocked flying
 * when the taxi arrives and needs a mesh of its own to be thrown, while the ramp is bolted to the
 * road and belongs in the zone's static mesh.
 *
 * The ramp is a wedge written out by hand rather than a squashed box: a box has its top face
 * parallel to the road, and pulling two of its vertices down leaves the side faces as
 * non-planar quads that flat-shade into a crease down the middle of the slope.
 */
export function barricadeParts({ width, centreX = 0 } = {}) {
  const parts = [];
  const half = width / 2;

  // Legs: an A-frame at each end, plus the feet they stand on.
  for (const side of [-1, 1]) {
    const x = centreX + side * (half - 0.35);
    for (const splay of [-1, 1]) {
      const leg = new THREE.BoxGeometry(0.13, BARRIER_TOP, 0.13);
      leg.translate(x, BARRIER_TOP / 2, splay * 0.28);
      parts.push(bakeColor(leg, color('barrierBand')));
    }
    const foot = new THREE.BoxGeometry(0.2, 0.08, 0.85);
    foot.translate(x, 0.04, 0);
    parts.push(bakeColor(foot, color('barrier')));
  }

  // Two striped planks. Stripes are separate boxes rather than a texture — there are no textures
  // in this project — and they alternate along the plank rather than running diagonally, because
  // a diagonal at this size is four pixels of aliasing where a block is a clean edge.
  const seg = width / STRIPES;
  for (const y of [PLANK_LOW, PLANK_HIGH]) {
    for (let n = 0; n < STRIPES; n++) {
      const box = new THREE.BoxGeometry(seg * 1.02, PLANK_H, PLANK_T);
      box.translate(centreX - half + seg * (n + 0.5), y + PLANK_H / 2, 0);
      parts.push(bakeColor(box, color(n % 2 === 0 ? 'barrier' : 'barrierBand')));
    }
  }

  return { trestle: parts, ramp: [bakeColor(rampWedge(width, centreX), color('plywood'))] };
}

/**
 * The plywood sheet: a right-triangle prism climbing from `-RAMP_RUN` to the barricade line,
 * spanning `width` about `centreX`.
 *
 * **Wind every triangle counter-clockwise seen from outside.** This was written inside out and
 * shipped that way: the slope's normals came out at y = −0.98 and the underside's at +1.00, so the
 * face aimed at the camera was the ramp's *bottom* — a flat plywood-coloured quad lying exactly on
 * the road slab. It read as an orange patch of z-fighting near the junction, and the slope, being a
 * back face, was culled outright. The ramp had never once been drawn as a ramp.
 *
 * `flatShading` is what made it convincing rather than obviously broken: it takes the normal from a
 * screen-space derivative, so the wrong-facing quad still lit like a surface instead of going black.
 * tools/probe.mjs asserts the sign of `normal.y` on both faces, because this is precisely the class
 * of bug a screenshot looks at and accepts.
 */
function rampWedge(width, centreX) {
  const w = width / 2;
  const a = [centreX - w, 0, -RAMP_RUN];   // toe, left
  const b = [centreX + w, 0, -RAMP_RUN];   // toe, right
  const c = [centreX - w, 0, 0];
  const d = [centreX + w, 0, 0];
  const e = [centreX - w, RAMP_H, 0];
  const f = [centreX + w, RAMP_H, 0];

  const tri = (...pts) => pts.flat();
  const positions = new Float32Array([
    ...tri(a, f, b), ...tri(a, e, f),     // the slope
    ...tri(c, f, e), ...tri(c, d, f),     // the vertical back, against the trestle
    ...tri(a, d, c), ...tri(a, b, d),     // underside
    ...tri(a, c, e), ...tri(b, f, d),     // the two triangular sides
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  // Lifted clear of the route band, which is the one thing that would otherwise slice through the
  // shallow end of the slope: the band is drawn flat at 0.03 and the ramp starts at zero, so its
  // first 0.03 of climb shared a depth range with it.
  geo.translate(0, WORKS_Y, 0);
  return geo;
}

// A chip off a plank. Long, thin, and thick enough that it still catches the sun edge-on while it
// tumbles — a chip of the thickness a real splinter would have (PLANK_T/4) is a single pixel at
// play zoom and flickers in and out of existence as it spins.
const SPLINTER = [0.5, 0.13, 0.16];

/** How high a splinter's origin sits once it is lying flat on the road. */
export const SPLINTER_REST_Y = SPLINTER[1] / 2;

/**
 * A chip off a striped plank, origin at its centre so it tumbles about itself.
 *
 * Split down the middle into the barricade's two colours rather than being one or the other. A
 * plain orange chip is indistinguishable from a cone fragment at this size, and a set of chips
 * half orange and half white reads as two kinds of debris rather than as one broken thing; carrying
 * the stripe *within* each chip is what makes a piece spinning past legible as the trestle it came
 * off. It costs one extra box per instance and they are all merged into the one geometry anyway.
 */
export function splinterGeometry() {
  const [w, h, d] = SPLINTER;
  const parts = [];
  for (const side of [-1, 1]) {
    const half = new THREE.BoxGeometry(w / 2, h, d);
    half.translate((side * w) / 4, 0, 0);
    parts.push(bakeColor(half, color(side < 0 ? 'barrier' : 'barrierBand')));
  }
  return mergeAll(parts);
}

/** The heap of dug-out road base, and the flat patch of hole it came from. */
export function spoilParts(x, z, rng) {
  const parts = [];

  const r = rng.range(0.9, 1.25);
  const heap = new THREE.IcosahedronGeometry(r, 1);
  jitterVertices(heap, rng, r * 0.16);
  heap.scale(1.35, 0.5, 1.1);
  heap.translate(x, r * 0.16, z);
  parts.push(bakeColor(heap, jitterColor(PALETTE.spoil, rng, { l: 0.05 })));

  // The hole, painted on rather than dug: the ground is one merged mesh built once at startup and
  // there is nothing to cut into. A dark quad a hair above the asphalt reads the same at this
  // camera, which never gets low enough to see that it has no depth.
  //
  // At TRENCH_Y rather than the MARK_Y it used to sit on: exactly MARK_Y is coplanar with every
  // lane dash it overlaps, and this quad is deliberately laid across the middle of a road.
  const hole = new THREE.PlaneGeometry(rng.range(2.4, 3.2), rng.range(1.8, 2.4));
  hole.rotateX(-Math.PI / 2);
  hole.translate(x + rng.jitter(0.6), TRENCH_Y, z + rng.jitter(0.6));
  parts.push(bakeColor(hole, color('trench')));

  return parts;
}

/** Merge and dispose, the closing move every builder in this project makes. */
export function mergeAll(parts) {
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

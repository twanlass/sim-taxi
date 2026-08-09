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
export const RAMP_RUN = 3.2;
export const RAMP_H = 0.66;

/**
 * A trestle barricade and the ramp leaning on it, in local space:
 * **+X across the road, +Y up, +Z the direction of travel**, origin on the road at the line the
 * barricade stands on. The caller rotates it onto a lane.
 *
 * `centreX` is where the trestle's midpoint sits relative to that origin, because the origin is a
 * lane centre and the barricade spans the whole road — the two are `LANE` apart. The ramp stays at
 * x = 0, over the lane a car actually arrives in.
 *
 * The two come back **separately** because they meet different ends: the trestle is knocked flying
 * when the taxi arrives and needs a mesh of its own to be thrown, while the ramp is bolted to the
 * road and belongs in the zone's static mesh.
 *
 * The ramp is a wedge written out by hand rather than a squashed box: a box has its top face
 * parallel to the road, and pulling two of its vertices down leaves the side faces as
 * non-planar quads that flat-shade into a crease down the middle of the slope.
 */
export function barricadeParts({ width, centreX = 0, rampWidth = 3.4 } = {}) {
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

  return { trestle: parts, ramp: [bakeColor(rampWedge(rampWidth), color('plywood'))] };
}

/** The plywood sheet: a right-triangle prism climbing from `-RAMP_RUN` to the barricade line. */
function rampWedge(width) {
  const w = width / 2;
  const a = [-w, 0, -RAMP_RUN];   // toe, left
  const b = [w, 0, -RAMP_RUN];    // toe, right
  const c = [-w, 0, 0];
  const d = [w, 0, 0];
  const e = [-w, RAMP_H, 0];
  const f = [w, RAMP_H, 0];

  const tri = (...pts) => pts.flat();
  const positions = new Float32Array([
    ...tri(a, b, f), ...tri(a, f, e),     // the slope
    ...tri(c, e, f), ...tri(c, f, d),     // the vertical back, against the trestle
    ...tri(a, c, d), ...tri(a, d, b),     // underside
    ...tri(a, e, c), ...tri(b, d, f),     // the two triangular sides
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
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
  const hole = new THREE.PlaneGeometry(rng.range(2.4, 3.2), rng.range(1.8, 2.4));
  hole.rotateX(-Math.PI / 2);
  hole.translate(x + rng.jitter(0.6), 0.02, z + rng.jitter(0.6));
  parts.push(bakeColor(hole, color('trench')));

  return parts;
}

/** Merge and dispose, the closing move every builder in this project makes. */
export function mergeAll(parts) {
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

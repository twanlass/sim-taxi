import * as THREE from 'three';
import { bakeColor, setFinish, FINISH, SMOOTH_BODY, softenNormals } from '../util/geo.js';
import { color } from '../palette.js';
import { CHASSIS_LIFT } from './wheels.js';

// Wing mirrors: a paint-coloured housing on a short stalk off the foot of each A-pillar, with a dark
// glass face on its back. The housing is half an ellipsoid — domed to the front, flat glass behind —
// tapered toward the door, the shape a real mirror has. Shared by the taxi (geometry/taxi.js), the fleet (`carGeometry` in
// sim/traffic.js) and the box trucks' cabs, which differ only in where the pillar is and what paint
// the housing takes — the fleet bakes it white for the instance tint, like the rest of the body.
//
// Sized off the camera, not off a real car, but less cartoon-big than #755 shipped them. That cut
// stood a 0.2 × 0.22 × 0.26 rounded box 0.28 off the flank and read as a brick bolted to the door
// (Tyler, 2026-11-24: "big and boxy"). This one stands `MIRROR_OUT` = 0.22 clear — ~1.7px on a fleet
// car at play zoom (1 unit ≈ 7.7px), ~2px on the taxi through TAXI_SCALE — which still clears the
// aliasing floor: below ~1.5px a bump on the silhouette flickers in and out as the car turns. The
// volume is about a third of the box's, and the dome and taper are what take the corners off.
//
// `?mirrors=classic` takes them off everything.
export const MIRRORS = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('mirrors') !== 'classic';

const HOUSING_LEN = 0.12;     // fore-aft: the dome's depth in front of the glass
const HOUSING_H = 0.15;       // at the outer end; the inner end is TAPER_H of it
const HOUSING_W = 0.2;        // across
const TAPER_H = 0.65;         // inner end's height against the outer end's
const TAPER_LEN = 0.75;       // and its dome depth
export const MIRROR_OUT = 0.22;   // how far the housing's outer tip stands off the body's flank
const STALK_H = 0.05;
const STALK_LEN = 0.05;       // fore-aft
// Low-poly on purpose: 8 steps round the dome and 6 down it is ~90 triangles a mirror, against the
// ~590 of the rounded box it replaced. DOME_V must be even, so the glass disc's rim (2·DOME_V steps
// round a circle) lands exactly on the dome's two edge meridians and the seam has no gap.
const DOME_U = 8;
const DOME_V = 6;
// Swept back about the vertical, outer end toward the tail, the way a real mirror is raked. Square
// to the flank (0, as #755 shipped) it read as a peg stuck out of the door. Turned about the
// housing's own centre, so it stays on its stalk, and set out so the swept tip lands on MIRROR_OUT.
export const MIRROR_SWEEP = 25 * Math.PI / 180;
const GLASS_SCALE = 0.8;      // the glass against the back plate it sits on: the rest is a painted rim
const GLASS_PROUD = 0.01;     // off the back plate, so the two are not one plane (CLAUDE.md)
// Up off the body's top: the housing hangs over the shoulder, not on it, so its underside is never
// laid on the body's top plane (CLAUDE.md on coplanar surfaces) and the stalk is the only contact.
const HOUSING_LIFT = 0.03;
const STALK_LIFT = 0.01;

/**
 * The housing's three pieces about its own centre, outer end toward +z, unswept: the dome (+x, the
 * front), the painted back plate closing it at x = 0, and the glass GLASS_PROUD behind that. Shifted
 * so the whole thing is centred fore-aft. All three are tapered by the same rule, so the plate's rim
 * stays on the dome's.
 */
function housingPieces() {
  // phi from π/2 to 3π/2 is the half of three's sphere with x = −cos(phi)·sin(theta) ≥ 0.
  const dome = new THREE.SphereGeometry(1, DOME_U, DOME_V, Math.PI / 2, Math.PI);
  // A unit circle in xy facing +z, turned to face −x: (cos a, sin a, 0) → (0, sin a, cos a).
  const disc = (scale, x) => new THREE.CircleGeometry(scale, 2 * DOME_V).rotateY(-Math.PI / 2).translate(x, 0, 0);
  const plate = disc(1, 0);
  const pane = disc(GLASS_SCALE, -GLASS_PROUD);
  for (const g of [dome, plate, pane]) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getZ(i) + 1) / 2;   // 0 at the inner end, 1 at the outer
      pos.setXYZ(i,
        pos.getX(i) * HOUSING_LEN * (TAPER_LEN + (1 - TAPER_LEN) * t) - HOUSING_LEN / 2,
        pos.getY(i) * HOUSING_H / 2 * (TAPER_H + (1 - TAPER_H) * t),
        pos.getZ(i) * HOUSING_W / 2);
    }
  }
  return { dome, plate, pane };
}

/**
 * One mirror's parts in car-local space (+x the nose, +z the right), on `side` (+1 right, −1 left).
 *
 * `x` is the housing's centre fore-aft, `top` the body's top (where the shoulder is), `flank` the
 * body's half-width and `glass` the cabin's — the stalk runs from inside the cabin's side out to the
 * housing, so its inner end is buried in the glass and never shows as an end face.
 */
export function mirrorParts({ x, top, flank, glass, side, paint }) {
  const parts = [];
  const outer = flank + MIRROR_OUT;
  const mid = outer - (HOUSING_W / 2) * Math.cos(MIRROR_SWEEP);
  const y = top + HOUSING_LIFT + HOUSING_H / 2;
  // Housing and glass are built about the origin and swept as one: −side·angle about +y takes the
  // outer end (+side·z) toward −x, the tail, on both sides.
  const sweep = new THREE.Matrix4().makeRotationY(-side * MIRROR_SWEEP);
  const place = (g) => g.applyMatrix4(sweep).translate(x, y, side * mid);

  // Built for the right side; the left is the same taper read from the other end, so flip the
  // pieces' z by turning them half round x rather than scaling by −1, which would rewind them.
  const { dome, plate, pane } = housingPieces();
  const flip = (g) => (side < 0 ? g.rotateX(Math.PI) : g);
  const shell = bakeColor(place(flip(dome)), paint);
  parts.push(setFinish(SMOOTH_BODY ? softenNormals(shell, 60) : shell, FINISH.PAINT));
  parts.push(setFinish(bakeColor(place(flip(plate)), paint), FINISH.PAINT));

  // From 0.04 inside the cabin's glass to the housing's centre, so its end stays buried in the
  // housing whichever way that is turned.
  const stalkFrom = glass - 0.04;
  const stalkTo = mid;
  const stalk = new THREE.BoxGeometry(STALK_LEN, STALK_H, stalkTo - stalkFrom);
  // 0.02 behind the housing's centre, so its top edge stays under the dome rather than in front of it.
  stalk.translate(x - 0.02, top + STALK_LIFT + STALK_H / 2, side * (stalkFrom + stalkTo) / 2);
  parts.push(setFinish(bakeColor(stalk, paint), FINISH.PAINT));

  // The glass, a disc GLASS_PROUD behind the back plate with a painted rim showing round it.
  parts.push(setFinish(bakeColor(place(flip(pane)), color('carGlass')), FINISH.GLASS));
  return parts;
}

/** Both sides' parts, for a body that merges them in. Empty under `?mirrors=classic`. */
export function mirrorGeometries(opts) {
  if (!MIRRORS) return [];
  return [-1, 1].flatMap((side) => mirrorParts({ ...opts, side }));
}

/** The fleet car's body top, as carGeometry() builds it: archedBodyGeometries at 0.78 ± 0.4. */
export const CAR_BODY_TOP = 1.18 + CHASSIS_LIFT;

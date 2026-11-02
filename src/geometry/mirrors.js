import * as THREE from 'three';
import { bakeColor, setFinish, FINISH, SMOOTH_BODY, bodyBox, softenNormals } from '../util/geo.js';
import { color } from '../palette.js';
import { CHASSIS_LIFT } from './wheels.js';

// Wing mirrors: a paint-coloured housing on a short stalk off the foot of each A-pillar, with a dark
// glass face on its back. Shared by the fleet (`carGeometry` in sim/traffic.js) and the box trucks'
// cabs, which differ only in where the pillar is and what paint the housing takes — the fleet bakes
// it white for the instance tint, like the rest of the body. The taxi wears a stalkless wedge on its
// door instead (`doorMirrorParts`, below).
//
// Sized off the camera, not off a real car. A real mirror is ~0.2 of a unit out from the door, which
// at play zoom (1 unit ≈ 7.7px) is a pixel and a half and aliases into a flicker as the car turns. So
// these are cartoon-big — the housing stands `MIRROR_OUT` clear of the flank, ~2.2px on a fleet car
// and ~2.6 on the taxi through TAXI_SCALE — and chunky rather than thin, because the thing that has
// to survive at that size is a bump on the silhouette, not the shape of a mirror.
//
// `?mirrors=classic` takes them off everything.
export const MIRRORS = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('mirrors') !== 'classic';

const HOUSING_LEN = 0.2;      // fore-aft
const HOUSING_H = 0.22;
const HOUSING_W = 0.26;       // across
export const MIRROR_OUT = 0.28;   // how far the housing's outer face stands off the body's flank
const STALK_H = 0.08;
const GLASS_INSET = 0.035;    // the glass face's margin inside the housing's back
const GLASS_T = 0.012;
// Up off the body's top: the housing hangs over the shoulder, not on it, so its underside is never
// laid on the body's top plane (CLAUDE.md on coplanar surfaces) and the stalk is the only contact.
const HOUSING_LIFT = 0.04;
const STALK_LIFT = 0.01;

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
  const inner = outer - HOUSING_W;
  const y = top + HOUSING_LIFT + HOUSING_H / 2;

  const housing = bodyBox(HOUSING_LEN, HOUSING_H, HOUSING_W, 0.05);
  housing.translate(x, y, side * (outer - HOUSING_W / 2));
  const shell = bakeColor(housing, paint);
  parts.push(setFinish(SMOOTH_BODY ? softenNormals(shell) : shell, FINISH.PAINT));

  // From 0.04 inside the cabin's glass to 0.02 inside the housing.
  const stalkFrom = glass - 0.04;
  const stalkTo = inner + 0.02;
  const stalk = new THREE.BoxGeometry(0.08, STALK_H, stalkTo - stalkFrom);
  stalk.translate(x - 0.02, top + STALK_LIFT + STALK_H / 2, side * (stalkFrom + stalkTo) / 2);
  parts.push(setFinish(bakeColor(stalk, paint), FINISH.PAINT));

  // The glass on the housing's back, GLASS_T proud of it. Its front face sits on the housing's back
  // face facing into it — buried, so it cannot fight it.
  const pane = new THREE.BoxGeometry(GLASS_T, HOUSING_H - 2 * GLASS_INSET, HOUSING_W - 2 * GLASS_INSET);
  pane.translate(x - HOUSING_LEN / 2 - GLASS_T / 2, y, side * (outer - HOUSING_W / 2));
  parts.push(setFinish(bakeColor(pane, color('carGlass')), FINISH.GLASS));
  return parts;
}

// The taxi's door mirror: no stalk, the housing itself grows out of the front door just under the
// shoulder, as a wedge — full length where it meets the door, tapering in length to
// WEDGE_TIP of that at its outer end, in plan only: its height is the same all the way out. The back face stays square to the car so the glass can lie on
// it. Kept below the shoulder rather than at the window because the shoulder is where the body's
// outline is, so the bump reads on the flank instead of floating beside the glass.
const WEDGE_LEN = 0.28;
const WEDGE_H = 0.22;
const WEDGE_TIP = 0.45;
// Under the shoulder by this much: clear of the body's top edge, and with `?carbody=smooth` the
// shoulder's round (BODY_ROUND) has only fallen 0.042 off the flank at the wedge's top, inside
// WEDGE_BURY, so the root never shows a gap.
const WEDGE_DROP = 0.04;
const WEDGE_BURY = 0.05;

/**
 * The taxi's door mirror on `side`, car-local like mirrorParts. `x` is the root's centre fore-aft,
 * `top` the body's shoulder and `flank` its half-width.
 */
export function doorMirrorParts({ x, top, flank, side, paint }) {
  const inner = flank - WEDGE_BURY;
  const outer = flank + MIRROR_OUT;
  const taper = (z) => 1 + (WEDGE_TIP - 1) * Math.min(1, Math.max(0, (z - inner) / (outer - inner)));
  const back = x - WEDGE_LEN / 2;
  const y = top - WEDGE_DROP - WEDGE_H / 2;

  // Built on the +z side with the back face at x = 0 and the centre at y = 0, so the taper only has
  // to scale x and y. The left one is turned half round the long axis rather than mirrored in z,
  // which would flip the winding.
  const place = (geo) => {
    if (side < 0) geo.rotateX(Math.PI);
    geo.translate(back, y, 0);
    return geo;
  };

  // Every face of a box tapered this way stays planar, so its flat normals are still true.
  const housing = new THREE.BoxGeometry(WEDGE_LEN, WEDGE_H, outer - inner);
  housing.translate(WEDGE_LEN / 2, 0, (inner + outer) / 2);
  const pos = housing.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const s = taper(pos.getZ(i));
    pos.setX(i, pos.getX(i) * s);   // height stays WEDGE_H: the taper is a plan view one only
  }
  housing.computeVertexNormals();

  // The glass on the square back, GLASS_T behind it with its front face buried in the housing's
  // back, inset from the tapered edges by GLASS_INSET and starting just off the door.
  const pane = new THREE.BoxGeometry(GLASS_T, 1, outer - GLASS_INSET - (flank + 0.03));
  pane.translate(-GLASS_T / 2, 0, (flank + 0.03 + outer - GLASS_INSET) / 2);
  const pp = pane.attributes.position;
  for (let i = 0; i < pp.count; i++) pp.setY(i, Math.sign(pp.getY(i)) * (WEDGE_H / 2 - GLASS_INSET));

  return [
    setFinish(bakeColor(place(housing), paint), FINISH.PAINT),
    setFinish(bakeColor(place(pane), color('carGlass')), FINISH.GLASS),
  ];
}

/** Both sides' parts, for a body that merges them in. Empty under `?mirrors=classic`. */
export function mirrorGeometries(opts) {
  if (!MIRRORS) return [];
  return [-1, 1].flatMap((side) => mirrorParts({ ...opts, side }));
}

/** The fleet car's body top, as carGeometry() builds it: archedBodyGeometries at 0.78 ± 0.4. */
export const CAR_BODY_TOP = 1.18 + CHASSIS_LIFT;

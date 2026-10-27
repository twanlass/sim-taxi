import * as THREE from 'three';
import { bakeColor, setFinish, FINISH, SMOOTH_BODY, bodyBox, softenNormals } from '../util/geo.js';
import { color } from '../palette.js';
import { CHASSIS_LIFT } from './wheels.js';

// Wing mirrors: a paint-coloured housing on a short stalk off the foot of each A-pillar, with a dark
// glass face on its back. Shared by the taxi (geometry/taxi.js), the fleet (`carGeometry` in
// sim/traffic.js) and the box trucks' cabs, which differ only in where the pillar is and what paint
// the housing takes — the fleet bakes it white for the instance tint, like the rest of the body.
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

/** Both sides' parts, for a body that merges them in. Empty under `?mirrors=classic`. */
export function mirrorGeometries(opts) {
  if (!MIRRORS) return [];
  return [-1, 1].flatMap((side) => mirrorParts({ ...opts, side }));
}

/** The fleet car's body top, as carGeometry() builds it: archedBodyGeometries at 0.78 ± 0.4. */
export const CAR_BODY_TOP = 1.18 + CHASSIS_LIFT;

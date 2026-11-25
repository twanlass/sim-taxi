import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { bakeColor, setFinish, FINISH } from '../util/geo.js';
import { color } from '../palette.js';
import { CHASSIS_LIFT } from './wheels.js';

// Wing mirrors: a black housing on a short stalk off the foot of each A-pillar, with a dark glass
// face on its back. Shared by the taxi (geometry/taxi.js), the fleet (`carGeometry` in
// sim/traffic.js) and the box trucks' cabs, which differ only in where the pillar is.
//
// Black plastic rather than the body's paint (Tyler, 2026-11-24): a paint-coloured housing melts
// into the flank behind it at play zoom, and a different material is what makes a few pixels read
// as a mirror. The fleet bakes it black too — the instance tint multiplies a vertex colour, and
// black times any paint is still black.
//
// Sized off the camera, not off a real car. A real mirror is ~0.2 of a unit out from the door, which
// at play zoom (1 unit ≈ 7.7px) is a pixel and a half and aliases into a flicker as the car turns.
// Three cuts so far: #755's plain 0.2 × 0.22 × 0.26 box 0.28 off the flank ("big and boxy"), then a
// tapered half-ellipsoid 0.22 off it (too small, too round, too much going on), and now the middle
// of the two — a box with its edges chamfered once, `MIRROR_OUT` = 0.25 clear, ~1.9px on a fleet car
// and ~2.3 on the taxi through TAXI_SCALE.
//
// `?mirrors=classic` takes them off everything.
export const MIRRORS = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('mirrors') !== 'classic';

const HOUSING_LEN = 0.16;     // fore-aft
const HOUSING_H = 0.18;
const HOUSING_W = 0.23;       // across
// One segment of RoundedBoxGeometry is a single 45° facet on every edge: a chamfer, not a curve —
// the little bit of rounding that takes the brick off without adding detail (108 triangles).
const CHAMFER = 0.04;
export const MIRROR_OUT = 0.25;   // how far the housing's swept tip stands off the body's flank
const STALK_H = 0.06;
const STALK_LEN = 0.06;       // fore-aft
// Swept back about the vertical, outer end toward the tail, the way a real mirror is raked. Square
// to the flank (0, as #755 shipped) it read as a peg stuck out of the door. Turned about the
// housing's own centre, so it stays on its stalk, and set out so the swept tip lands on MIRROR_OUT.
export const MIRROR_SWEEP = 25 * Math.PI / 180;
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
 * housing, so its inner end is buried in the glass and never shows as an end face. `paint` is
 * accepted and ignored: the housing is black on every car.
 */
export function mirrorParts({ x, top, flank, glass, side }) {
  const parts = [];
  const black = color('mirrorBlack');
  const outer = flank + MIRROR_OUT;
  const mid = outer - (HOUSING_W / 2) * Math.cos(MIRROR_SWEEP) - (HOUSING_LEN / 2) * Math.sin(MIRROR_SWEEP);
  const y = top + HOUSING_LIFT + HOUSING_H / 2;
  // Housing and glass are built about the origin and swept as one: −side·angle about +y takes the
  // outer end (+side·z) toward −x, the tail, on both sides.
  const sweep = new THREE.Matrix4().makeRotationY(-side * MIRROR_SWEEP);
  const place = (g) => g.applyMatrix4(sweep).translate(x, y, side * mid);

  const housing = new RoundedBoxGeometry(HOUSING_LEN, HOUSING_H, HOUSING_W, 1, CHAMFER);
  parts.push(setFinish(bakeColor(place(housing), black), FINISH.PAINT));

  // From 0.04 inside the cabin's glass to the housing's centre, so its end stays buried in the
  // housing whichever way that is turned.
  const stalkFrom = glass - 0.04;
  const stalkTo = mid;
  const stalk = new THREE.BoxGeometry(STALK_LEN, STALK_H, stalkTo - stalkFrom);
  stalk.translate(x - 0.02, top + STALK_LIFT + STALK_H / 2, side * (stalkFrom + stalkTo) / 2);
  parts.push(setFinish(bakeColor(stalk, black), FINISH.PAINT));

  // The glass on the housing's back, GLASS_T proud of it. Its front face sits on the housing's back
  // face facing into it — buried, so it cannot fight it.
  const pane = new THREE.BoxGeometry(GLASS_T, HOUSING_H - 2 * GLASS_INSET, HOUSING_W - 2 * GLASS_INSET);
  pane.translate(-HOUSING_LEN / 2 - GLASS_T / 2, 0, 0);
  parts.push(setFinish(bakeColor(place(pane), color('carGlass')), FINISH.GLASS));
  return parts;
}

/** Both sides' parts, for a body that merges them in. Empty under `?mirrors=classic`. */
export function mirrorGeometries(opts) {
  if (!MIRRORS) return [];
  return [-1, 1].flatMap((side) => mirrorParts({ ...opts, side }));
}

/** The fleet car's body top, as carGeometry() builds it: archedBodyGeometries at 0.78 ± 0.4. */
export const CAR_BODY_TOP = 1.18 + CHASSIS_LIFT;

import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { color } from '../palette.js';
import { mergeAll } from './roadworks.js';
import { TRUCK_BOX_LEN, TRUCK_BOX_X, TRUCK_CHASSIS_TOP, TRUCK_W } from '../sim/traffic.js';

// A box truck's rear doors and the hold behind them, for game/boxspill.js — drawn over the
// ambient truck's own box rather than cut into it, so nothing in sim/traffic.js's truck builders
// has to know the doors exist.
//
// Everything is in the **truck's own frame** (+X forward, +Y up, +Z across), the frame the
// truck's instance matrix carries.

/** The box's rear face, in the truck frame. truckBoxGeometry() is 2.0 tall on the chassis top. */
export const BOX_REAR = TRUCK_BOX_X - TRUCK_BOX_LEN / 2;
export const BOX_H = 2.0;
export const BOX_MID_Y = TRUCK_CHASSIS_TOP + BOX_H / 2;

// Stood off the rear face rather than laid on it — two faces in one plane is the shimmer in
// CLAUDE.md. The hold sits nearer the face than a shut leaf does, so a leaf swinging shut over it
// never meets it either.
const HOLD_T = 0.03;
const HOLD_PROUD = 0.005;
const LEAF_T = 0.05;
const BAR_T = 0.03;
/** From the rear face out to the hinge line, which is the leaf's outside face (bar included). */
export const HINGE_OUT = HOLD_PROUD + HOLD_T + 0.01 + LEAF_T + BAR_T;
const LEAF_H = BOX_H - 0.08;
const LEAF_GAP = 0.02;                       // between the two leaves where they meet
const LEAF_W = TRUCK_W / 2 - LEAF_GAP / 2;
const BAR_W = 0.07;

/**
 * One door leaf, **origin on its hinge** so it swings about itself: centred on the hinge in y,
 * running out along +Z from it, and standing *in* (+X) from it toward the face it closes on.
 *
 * The hinge is on the leaf's outside face, not its inside one, and that is a measured choice: hung
 * from the inside face, the leaf's thickness swings round into the box past a half turn — the probe
 * found the hinge-side edge 0.05 inside the side wall at every angle from 3.15 rad on. Hung from
 * the outside face, the thickness turns away from the box the whole way round.
 *
 * The right-hand leaf is the same geometry turned half over about X (see game/boxspill.js) — a
 * proper rotation, so the leaf never needs a mirror and a mirror never turns its winding inside out.
 */
export function doorLeafGeometry() {
  const parts = [];
  const leaf = new THREE.BoxGeometry(LEAF_T, LEAF_H, LEAF_W);
  leaf.translate(BAR_T + LEAF_T / 2, 0, LEAF_W / 2);
  parts.push(bakeColor(leaf, color('truckBox')));
  // The latch bar down the free edge, on the outside face. It is most of what says "door" at
  // seven pixels a unit: a white flap off the side of a white box is just more box.
  const bar = new THREE.BoxGeometry(BAR_T, LEAF_H * 0.92, BAR_W);
  bar.translate(BAR_T / 2, 0, LEAF_W - BAR_W / 2 - 0.05);
  parts.push(bakeColor(bar, color('truckDoorBar')));
  return mergeAll(parts);
}

/** The dark of the hold, a plate just off the rear face, in the truck frame. */
export function holdGeometry() {
  const hold = new THREE.BoxGeometry(HOLD_T, BOX_H - 0.16, TRUCK_W - 0.18);
  hold.translate(BOX_REAR - HOLD_PROUD - HOLD_T / 2, BOX_MID_Y, 0);
  return bakeColor(hold, color('truckHold'));
}

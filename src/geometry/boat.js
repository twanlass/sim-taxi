import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { BARGE_AIR, TUG_AIR } from '../city/river.js';

// Two boats, and the difference between them is the whole reason the drawbridge exists.
//
// **They are told apart by their air draught, not by their looks.** A barge sits low enough to
// clear every span in the city; a tug's wheelhouse and mast do not clear the flat one. The numbers
// are `BARGE_AIR` and `TUG_AIR` in city/river.js, where they sit next to the soffit heights they
// have to beat, because a chain of four constants is only checkable if it is written in one place.
//
// Built the way every vehicle in this game is: boxes and cylinders, `bakeColor`, one merged mesh,
// `flatShading`. A boat at play zoom is about twenty pixels long.

/** Hull length. A car is 3.4, so a barge is two and a half cars and the tug a little over one. */
export const BARGE_LEN = 8.6;
export const TUG_LEN = 4.4;
/**
 * Hull width, and both boats share it — the channel is what sets it, not the vessel.
 *
 * Exported because it is the **floor on the lane separation**: two boats passing have to be at
 * least a beam apart or their hulls overlap, and a separation written as a literal somewhere else
 * is a number that stops tracking this one the moment either changes.
 */
export const BEAM = 2.2;
const FREEBOARD = 0.55;        // hull above the waterline
const DRAFT = 0.35;            // ...and below it, which is only ever seen at the bow wave

/**
 * A hull: a box with its bow drawn in.
 *
 * Tapered by scaling the front face rather than by hand-winding a wedge — a `BoxGeometry` cannot be
 * built inside out, and a hull is exactly the sloped-face shape the roadworks ramp shipped
 * reversed. Rotation and positive non-uniform scale both preserve handedness, so neither step here
 * can undo the winding Three gave it.
 */
function hull(length, col) {
  const geo = new THREE.BoxGeometry(BEAM, FREEBOARD + DRAFT, length);
  const pos = geo.attributes.position;
  const nose = length / 2;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z > nose - 1e-6) {
      // The bow: pinched to a third of the beam and lifted, so it reads as a prow from above.
      pos.setX(i, pos.getX(i) * 0.34);
      if (pos.getY(i) < 0) pos.setY(i, pos.getY(i) * 0.3);
    }
  }
  geo.computeVertexNormals();
  geo.translate(0, FREEBOARD / 2 - DRAFT / 2, 0);
  return bakeColor(geo, col);
}

/** A flat deck lid, so the open hull does not read as a trough from this camera. */
function deck(length, inset, y, col) {
  const geo = new THREE.BoxGeometry(BEAM - inset * 2, 0.12, length - inset * 2);
  geo.translate(0, y, 0);
  return bakeColor(geo, col);
}

/**
 * The barge: long, flat, and carrying a load low enough to pass under everything.
 *
 * The cargo is what makes it read as a working boat rather than as a plank, and it is deliberately
 * kept **under `BARGE_AIR`** — the whole point of this hull is that it never asks for the bridge.
 */
export function createBargeMesh(rng) {
  const hullCol = jitterColor(PALETTE.bargeHull, rng, { l: 0.03 });
  const deckCol = jitterColor(PALETTE.boatDeck, rng, { l: 0.03 });
  const cargoCol = jitterColor(PALETTE.bargeCargo, rng, { l: 0.04 });

  const parts = [hull(BARGE_LEN, hullCol), deck(BARGE_LEN, 0.18, FREEBOARD, deckCol)];

  // Three low containers down the middle, each a little different, with gaps between them.
  const slots = 3;
  const run = BARGE_LEN * 0.62;
  // Capped against `BARGE_AIR` rather than trusted to stay under it: the point of this hull is that
  // it never asks for the bridge, and a container half a unit taller would make it a tug.
  const cargoCeil = BARGE_AIR - FREEBOARD - 0.06;
  for (let k = 0; k < slots; k++) {
    const h = Math.min(rng.range(0.42, 0.68), cargoCeil);
    const box = new THREE.BoxGeometry(BEAM * 0.62, h, (run / slots) * 0.82);
    box.translate(0, FREEBOARD + 0.06 + h / 2, -run / 2 + (run / slots) * (k + 0.5));
    parts.push(bakeColor(box, jitterColor(cargoCol, rng, { l: 0.05 })));
  }

  // A stub wheelhouse at the stern, because something has to be steering it.
  const house = new THREE.BoxGeometry(BEAM * 0.5, 0.5, 0.9);
  house.translate(0, FREEBOARD + 0.31, -BARGE_LEN / 2 + 0.75);
  parts.push(bakeColor(house, deckCol));

  return merge(parts);
}

/**
 * The tug: short, tall, and the one that has to ask.
 *
 * Its height is the point — a wheelhouse on a raised deck with a stack and a mast on top of that,
 * reaching `TUG_AIR` and needing the flat span out of the way to get past it.
 */
export function createTugMesh(rng) {
  const hullCol = jitterColor(PALETTE.tugHull, rng, { l: 0.03 });
  const deckCol = jitterColor(PALETTE.boatDeck, rng, { l: 0.03 });
  const trimCol = jitterColor(PALETTE.tugTrim, rng, { l: 0.03 });

  const parts = [hull(TUG_LEN, hullCol), deck(TUG_LEN, 0.16, FREEBOARD, deckCol)];

  // Superstructure: a deckhouse, the wheelhouse on top of it, a funnel behind, and a mast above.
  const base = new THREE.BoxGeometry(BEAM * 0.78, 0.62, TUG_LEN * 0.42);
  base.translate(0, FREEBOARD + 0.37, -0.15);
  parts.push(bakeColor(base, deckCol));

  const wheelhouse = new THREE.BoxGeometry(BEAM * 0.56, 0.58, TUG_LEN * 0.26);
  wheelhouse.translate(0, FREEBOARD + 0.97, 0.05);
  parts.push(bakeColor(wheelhouse, trimCol));

  const funnel = new THREE.CylinderGeometry(0.24, 0.28, 0.7, 8);
  funnel.translate(0, FREEBOARD + 1.05, -TUG_LEN * 0.3);
  parts.push(bakeColor(funnel, trimCol));

  // **The mast is placed from `TUG_AIR`, not measured afterwards.** It is the tallest thing on the
  // boat and the only number in the clearance chain that a bit of styling could quietly break: a
  // first cut with the same superstructure and a mast eyeballed on top of it came out at 2.81,
  // which is over the 2.75 an arched span leaves — so the tug could not have got under the three
  // bridges it is supposed to sail straight past, and the drawbridge would have been the least of
  // its problems. Hanging it off the constant means the geometry cannot disagree with the chain.
  const MAST_H = 1.0;
  const mast = new THREE.BoxGeometry(0.11, MAST_H, 0.11);
  mast.translate(0, TUG_AIR - MAST_H / 2, 0.05);
  parts.push(bakeColor(mast, deckCol));

  return merge(parts);
}

function merge(parts) {
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

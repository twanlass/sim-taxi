import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { BARGE_AIR, TUG_AIR } from '../city/river.js';

// Two boats, and the difference between them is the whole reason the drawbridge exists.
//
// **They are told apart by their air draught, not by their looks.** A barge sits low enough to
// clear every span in the city; the sailboat's mast does not clear the flat one. The numbers
// are `BARGE_AIR` and `TUG_AIR` in city/river.js, where they sit next to the soffit heights they
// have to beat, because a chain of four constants is only checkable if it is written in one place.
//
// Built the way every vehicle in this game is: boxes and cylinders, `bakeColor`, one merged mesh,
// `flatShading`. A boat at play zoom is about twenty pixels long.

/** Hull length. A car is 3.4, so a barge is two and a half cars and the sailboat a little over one. */
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

/**
 * A hull, as a box drawn in along its length.
 *
 * `plan` is the beam fraction at each of `plan.length` stations from the stern (first) to the bow
 * (last), and `rake` lifts the bottom at the same stations — a bow that climbs out of the water
 * rather than ending in a wall. Both are applied by scaling and shifting the vertices of a
 * `BoxGeometry` with that many depth segments, rather than by hand-winding a wedge: a box cannot be
 * built inside out, and a hull is exactly the sloped-face shape the roadworks ramp shipped
 * reversed. Positive per-vertex scaling preserves handedness, and the y shift only ever moves a
 * bottom vertex *up* to a height still under the top, so neither step can turn a face over.
 *
 * Two hulls built off the same `plan` meet exactly along a shared height, which is how the
 * sailboat gets its boot stripe: two pieces stacked, touching, not overlapping.
 */
function hullPiece(length, y0, y1, plan, rake, col) {
  const segs = plan.length - 1;
  const geo = new THREE.BoxGeometry(BEAM, y1 - y0, length, 1, 1, segs);
  geo.translate(0, (y0 + y1) / 2, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round((pos.getZ(i) / length + 0.5) * segs);
    pos.setX(i, pos.getX(i) * plan[k]);
    if (rake && pos.getY(i) < y1 - 1e-6) pos.setY(i, Math.min(y0 + rake[k], y1 - 0.02));
  }
  geo.computeVertexNormals();
  return bakeColor(geo, col);
}

/**
 * A deck lid, so the open hull does not read as a trough from this camera — drawn in on the same
 * plan as the hull it sits in, so it cannot poke out through the bow where the hull narrows.
 * Half under the hull's top face and half over it, so the two never share a plane.
 */
function deckLid(length, inset, y, plan, col) {
  const segs = plan.length - 1;
  const geo = new THREE.BoxGeometry(BEAM - inset * 2, 0.1, length - inset * 2, 1, 1, segs);
  geo.translate(0, y, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round((pos.getZ(i) / (length - inset * 2) + 0.5) * segs);
    pos.setX(i, pos.getX(i) * plan[k]);
  }
  return bakeColor(geo, col);
}

/** A box `w` × `h` × `d` with its base centred on (x, y, z) — what most of a boat is. */
function block(w, h, d, x, y, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h / 2, z);
  return bakeColor(geo, col);
}

/** A thin square rod from `a` to `b`: a stay, a shroud, a spreader. Rotation keeps the winding. */
function rod(a, b, t, col) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const geo = new THREE.BoxGeometry(t, t, dir.length());
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return bakeColor(geo, col);
}

/** A round spar lying along Z from `z0` up to `z1`, tapering `r0` → `r1`. */
function spar(z0, z1, r0, r1, y, col, sides = 8) {
  const geo = new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), sides);
  // +Y onto +Z, so the cylinder's top (r1) ends up at the larger z.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, y, (z0 + z1) / 2);
  return bakeColor(geo, col);
}

// --- The barge ---------------------------------------------------------------
//
// A **deck barge**: a flat steel box raked up at both ends, with whatever it is carrying stood on
// top in the open. The first cut was a hull with three grey lozenges down the middle, which read
// as "a boat-shaped thing" and nothing more specific; what makes a barge a barge is its *load*, and
// the load is where the variety goes. Every barge picks its own mix of containers and crates, so
// the river is never the same boat twice.

const BARGE_FREEBOARD = 0.45;
const BARGE_DRAFT = 0.3;
// Square in plan, raked at both ends: a scow. The bow is drawn in only slightly — a barge that
// came to a point would be a ship.
const BARGE_PLAN = [0.94, 1, 1, 1, 1, 1, 0.9];
const BARGE_RAKE = [0.24, 0, 0, 0, 0, 0, 0.27];
const BARGE_DECK_Y = BARGE_FREEBOARD + 0.05;   // top of the deck lid, where the load stands

// A container, at the scale of this boat rather than of a car: two fit side by side across the
// deck and two stack under `BARGE_AIR`. A real 20-foot box is 2.5 times as long as it is wide, and
// that ratio is most of what makes a box read as a container rather than as a crate.
const BOX_W = 0.8;
const BOX_H = 0.4;
const BOX_L = 1.62;

/**
 * The barge: long, flat, and carrying a load low enough to pass under everything.
 *
 * The load is kept **under `BARGE_AIR`** and capped against it rather than trusted to stay there —
 * the whole point of this hull is that it never asks for the bridge, and a stack one box higher
 * would make it the boat that does.
 */
export function createBargeMesh(rng) {
  const hullCol = jitterColor(PALETTE.bargeHull, rng, { l: 0.03 });
  const deckCol = jitterColor(PALETTE.boatDeck, rng, { l: 0.03 });

  const parts = [
    hullPiece(BARGE_LEN, -BARGE_DRAFT, BARGE_FREEBOARD, BARGE_PLAN, BARGE_RAKE, hullCol),
    deckLid(BARGE_LEN, 0.14, BARGE_FREEBOARD, BARGE_PLAN, deckCol),
  ];

  const ceil = BARGE_AIR - 0.02;
  const tiers = Math.max(1, Math.min(2, Math.floor((ceil - BARGE_DECK_Y) / (BOX_H + 0.01))));

  // A barge has a *character*: mostly boxes, mostly crates, or a mix. Drawn once per hull, so two
  // barges in a row differ in kind and not just in which slot is which colour.
  const boxShare = rng.pick([0.85, 0.55, 0.2]);
  const palette = PALETTE.bargeContainers;

  // Slots down the deck, a container long, from just ahead of the wheelhouse to the bow rake.
  const fore = BARGE_LEN / 2 - 0.7;
  const aft = -BARGE_LEN / 2 + 1.35;
  const slots = Math.floor((fore - aft + 0.08) / (BOX_L + 0.08));
  const run = slots * (BOX_L + 0.08) - 0.08;
  const z0 = (fore + aft) / 2 - run / 2;

  for (let k = 0; k < slots; k++) {
    const zc = z0 + k * (BOX_L + 0.08) + BOX_L / 2;
    if (rng.chance(boxShare)) {
      // Two columns across the deck, each a stack of one or two.
      for (const side of [-1, 1]) {
        if (rng.chance(0.08)) continue;              // a gap where one has been lifted off
        const n = rng.chance(0.45) ? tiers : 1;
        for (let t = 0; t < n; t++) {
          const col = jitterColor(rng.pick(palette), rng, { l: 0.04, s: 0.03 });
          parts.push(block(BOX_W, BOX_H, BOX_L, side * (BOX_W / 2 + 0.05),
            BARGE_DECK_Y + t * (BOX_H + 0.01), zc, col));
        }
      }
    } else {
      // Loose crates: a two-by-three grid, some missing and some stacked, each a little off square.
      const crateCol = PALETTE.bargeCrate;
      for (let cx = 0; cx < 2; cx++) {
        for (let cz = 0; cz < 3; cz++) {
          if (rng.chance(0.2)) continue;
          const s = rng.range(0.36, 0.46);
          const x = (cx - 0.5) * 0.82 + rng.jitter(0.06);
          const z = zc + (cz - 1) * 0.52 + rng.jitter(0.04);
          const col = jitterColor(crateCol, rng, { l: 0.06, s: 0.02 });
          parts.push(block(s, s, s, x, BARGE_DECK_Y, z, col));
          if (rng.chance(0.3) && BARGE_DECK_Y + s * 1.9 < ceil) {
            const s2 = s * rng.range(0.78, 0.9);
            parts.push(block(s2, s2, s2, x + rng.jitter(0.04), BARGE_DECK_Y + s, z + rng.jitter(0.04),
              jitterColor(crateCol, rng, { l: 0.06, s: 0.02 })));
          }
        }
      }
    }
  }

  // A small wheelhouse at the stern, because something has to be steering it — pale, with a dark
  // band of windows round it, so it reads as a cabin rather than as one more crate.
  const houseZ = -BARGE_LEN / 2 + 0.68;
  parts.push(block(BEAM * 0.56, 0.5, 0.8, 0, BARGE_DECK_Y, houseZ, deckCol));
  parts.push(block(BEAM * 0.56 + 0.03, 0.14, 0.83, 0, BARGE_DECK_Y + 0.28, houseZ, PALETTE.rigging));

  return merge(parts);
}

// --- The sailboat --------------------------------------------------------------
//
// The boat that asks for the lift. It used to be a tug, and a tug's wheelhouse and mast read as
// "a boat" without saying *why* this one needs the bridge out of the way when the barge does not.
// A sailboat's mast says it on sight: a white hull, sails down and furled along the boom, and a
// stick standing far taller than anything else on the water. The simulation still calls it the
// tug (`TUG_AIR`, `TUG_LEN`, `kind: 'tug'`) — it is the same boat to everything but the eye.

const SAIL_FREEBOARD = 0.42;
const SAIL_DRAFT = 0.3;
// Where the white topsides meet the blue stripe. High enough that a band of it shows above the
// water: at 0.07 it sat under the surface and the hull read as white all the way down.
const BOOT_Y = 0.15;
// A yacht's planform: a wide transom, fullest just aft of the middle, and a fine entry to a point.
const SAIL_PLAN = [0.8, 0.95, 1, 0.97, 0.82, 0.5, 0.06];
const SAIL_RAKE = [0.06, 0, 0, 0.02, 0.1, 0.22, 0.32];
const SAIL_DECK_Y = SAIL_FREEBOARD + 0.05;
const MAST_Z = 0.55;

/**
 * The sailboat: short, white, and the one that has to ask.
 *
 * **The masthead is placed at `TUG_AIR`, not measured afterwards.** It is the tallest thing on the
 * boat and the only number in the clearance chain a bit of styling could quietly break: a first
 * cut of the old tug with a mast eyeballed on top came out at 2.81, which is over the 2.75 an
 * arched span leaves, and would have left it unable to reach the drawbridge at all. Hanging the
 * mast off the constant means the geometry cannot disagree with the chain — and everything else up
 * there (stays, spreaders) is hung off the masthead and stops short of it.
 *
 * Which is also why the mast is "big" by proportion rather than by height. `TUG_AIR` is capped by
 * the two *arched* spans the boat has to sail under unopened, so the way to make the mast the
 * thing you notice is to put it on the lowest hull on the river: 1.9 units of spar over 0.42 of
 * freeboard, against the barge's whole load stopping at 1.4.
 */
export function createTugMesh(rng) {
  const white = jitterColor(PALETTE.sailHull, rng, { l: 0.015, s: 0.01 });
  const trim = jitterColor(PALETTE.sailTrim, rng, { l: 0.03 });
  // White on deck as well as on the topsides: a glass-fibre boat. The barge's tan deck here made the
  // hull read as a white rim round a brown boat.
  const deckCol = jitterColor(PALETTE.sailHull, rng, { l: 0.04, s: 0.01 }).offsetHSL(0, 0, -0.06);

  const parts = [
    hullPiece(TUG_LEN, -SAIL_DRAFT, BOOT_Y, SAIL_PLAN, SAIL_RAKE, trim),
    hullPiece(TUG_LEN, BOOT_Y, SAIL_FREEBOARD, SAIL_PLAN, null, white),
    deckLid(TUG_LEN, 0.12, SAIL_FREEBOARD, SAIL_PLAN, deckCol),
  ];

  // The coachroof: a low white cabin aft of the mast, with a dark band of windows down each side.
  // The band is a hair wider and shorter than the cabin, so no face of one lies on a face of the
  // other.
  parts.push(block(1.1, 0.27, 1.55, 0, SAIL_DECK_Y, -0.45, white));
  parts.push(block(1.12, 0.09, 1.3, 0, SAIL_DECK_Y + 0.1, -0.45, PALETTE.rigging));

  // The mast, from the cabin top to `TUG_AIR` exactly.
  const foot = SAIL_DECK_Y;
  const mastH = TUG_AIR - foot;
  const mast = new THREE.CylinderGeometry(0.05, 0.08, mastH, 8);
  mast.translate(0, foot + mastH / 2, MAST_Z);
  parts.push(bakeColor(mast, PALETTE.mast));

  // Spreaders, two thirds of the way up, and the shrouds over them to the deck edge.
  const top = new THREE.Vector3(0, TUG_AIR - 0.06, MAST_Z);
  const sprY = foot + mastH * 0.62;
  parts.push(rod(new THREE.Vector3(-0.42, sprY, MAST_Z), new THREE.Vector3(0.42, sprY, MAST_Z), 0.035, PALETTE.mast));
  for (const side of [-1, 1]) {
    const tip = new THREE.Vector3(side * 0.42, sprY, MAST_Z);
    const chain = new THREE.Vector3(side * 0.8, SAIL_DECK_Y, MAST_Z - 0.15);
    parts.push(rod(top, tip, 0.025, PALETTE.rigging));
    parts.push(rod(tip, chain, 0.025, PALETTE.rigging));
  }

  // Forestay to the stemhead and backstay to the transom: the two lines that make the triangle,
  // and the triangle is what says "sailboat" from across the map. The forestay carries the jib,
  // rolled up round it, so it is drawn as a thin white spar rather than as wire.
  const stem = new THREE.Vector3(0, SAIL_DECK_Y, TUG_LEN / 2 - 0.12);
  const transom = new THREE.Vector3(0, SAIL_DECK_Y, -TUG_LEN / 2 + 0.12);
  parts.push(rod(top, stem, 0.07, white));
  parts.push(rod(top, transom, 0.025, PALETTE.rigging));

  // The boom, and the mainsail lowered onto it under a blue cover: fat at the mast where the sail
  // is bunched up, thinning aft. This is "sails down" — the one shape on the boat that is not a
  // stick or a box.
  const boomY = SAIL_DECK_Y + 0.5;
  const boomAft = -TUG_LEN / 2 + 0.35;
  parts.push(spar(boomAft, MAST_Z - 0.02, 0.035, 0.035, boomY, PALETTE.mast, 6));
  parts.push(spar(boomAft + 0.2, MAST_Z - 0.06, 0.07, 0.14, boomY + 0.1, trim, 8));

  return merge(parts);
}

function merge(parts) {
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

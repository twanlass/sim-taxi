import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { BARGE_AIR, SAIL_AIR } from '../city/river.js';

// Two boats, and the difference between them is the whole reason the drawbridge exists.
//
// **They are told apart by their air draught, not by their looks.** A barge sits low enough to
// clear every span in the city; a sailboat's rig does not clear the flat one. The numbers are
// `BARGE_AIR` and `SAIL_AIR` in city/river.js, where they sit next to the soffit heights they have
// to beat, because a chain of four constants is only checkable if it is written in one place.
//
// **But an air draught the player cannot see is not a reason, it is bookkeeping**, and that is what
// the tug this replaced got wrong. Its mast was 0.11 wide — 0.85 of a pixel at play zoom — on a
// hull twenty pixels long, so the boat that could not fit under the flat span was, on screen, the
// barge that could. The clearance chain was right and nobody could read it. A sailboat spends the
// *same* 2.4 units of air on a gaff mainsail instead of a stick: 3.3 by 1.2 units of pale canvas,
// about thirty times the silhouette, and a shape that says what it needs without being told.
//
// **The height itself could not go up, and that is worth writing down before someone tries.** The
// tall boat has to sail under both ring-road bridges to reach the drawbridge at all, and an arched
// span leaves 2.75 at its crest and 2.52 over the outermost lane the generator hands out
// (`laneZ` in game/boats.js). So 2.4 is not a taste number with room over it — it is 0.12 short of
// a hard ceiling, and the only lever that moves that ceiling is `ARCH_RISE`, which is a camera
// number with its own argument (city/river.js). Drama had to come out of area, not altitude.
//
// Built the way every vehicle in this game is: boxes and cylinders, `bakeColor`, one merged mesh,
// `flatShading`. A boat at play zoom is about twenty pixels long.

/** Hull length. A car is 3.4, so a barge is two and a half cars and the sailboat a shade under two. */
export const BARGE_LEN = 8.6;
export const SAIL_LEN = 6.4;
/**
 * Hull width — the barge's, and the **wider of the two**, which is the property that matters.
 *
 * Exported because it is the **floor on the lane separation**: two boats passing have to be at
 * least a beam apart or their hulls overlap, and a separation written as a literal somewhere else
 * is a number that stops tracking this one the moment either changes. The sailboat is slimmer
 * (`SAIL_BEAM`), so a separation cleared against this one is cleared against both — keep it that
 * way round, or the bound stops being conservative and starts being wrong.
 */
export const BEAM = 2.2;
/** ...and the sailboat's own, because a sloop at 3.4:1 is a sloop and at 2.9:1 is a launch. */
const SAIL_BEAM = 1.9;
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
function hull(length, col, beam = BEAM) {
  const geo = new THREE.BoxGeometry(beam, FREEBOARD + DRAFT, length);
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
function deck(length, inset, y, col, beam = BEAM) {
  const geo = new THREE.BoxGeometry(beam - inset * 2, 0.12, length - inset * 2);
  geo.translate(0, y, 0);
  return bakeColor(geo, col);
}

/**
 * A sail: a flat panel standing in the boat's fore-and-aft plane, given as `[z, y]` corners.
 *
 * **Extruded rather than hand-wound**, and that is the whole of the design. A sail is exactly the
 * shape this project has shipped inside out three times — the roadworks ramp, the bridge deck, the
 * wake's triangle that drew nothing at all for weeks — and `computeVertexNormals` launders a
 * reversed face into something that merely looks odd. `ExtrudeGeometry` winds its own caps and
 * walls, and the two transforms after it are a rotation and a translation, both of which preserve
 * handedness, so there is no winding here for anyone to get wrong.
 *
 * `rotateY(-PI/2)` is picked so the shape's own x axis lands on the boat's **z**: the corners below
 * are then written in the fore-and-aft coordinates the rest of this file is in, rather than in a
 * mirrored space nobody can check by eye. The extrusion runs along x and is re-centred on 0.
 */
function sail(corners, thick, col) {
  const shape = new THREE.Shape();
  shape.moveTo(corners[0][0], corners[0][1]);
  for (let k = 1; k < corners.length; k++) shape.lineTo(corners[k][0], corners[k][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, steps: 1 });
  geo.rotateY(-Math.PI / 2);
  geo.translate(thick / 2, 0, 0);
  return bakeColor(geo, col);
}

/**
 * A spar or a stay: a square section running from one `[z, y]` point to another.
 *
 * The box's long axis is +z, so the rotation that aims it is `-atan2(dy, dz)` about X — a point at
 * `(0, 0, L/2)` goes to `(0, -sin(phi) L/2, cos(phi) L/2)`, and wanting that to be `(0, dy, dz)/2`
 * fixes both the angle and its sign. Written out because the sign is the half that is guessable
 * and a backstay aimed the wrong way still looks like rigging.
 */
function spar(z0, y0, z1, y1, thick, col) {
  const dz = z1 - z0;
  const dy = y1 - y0;
  const geo = new THREE.BoxGeometry(thick, thick, Math.hypot(dz, dy));
  geo.rotateX(-Math.atan2(dy, dz));
  geo.translate(0, (y0 + y1) / 2, (z0 + z1) / 2);
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
  // it never asks for the bridge, and a container half a unit taller would make it a sailboat.
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
 * The sailboat: the one that has to ask, and the one that has to *look* like it has to ask.
 *
 * **Gaff-rigged, and that is a consequence rather than a style choice.** The rig has 1.85 units
 * between the deck and the ceiling the arched spans impose, on a 6.4-unit hull — a Bermudan
 * triangle in that box is a tall thin sliver on a long boat, which is the tug's problem again with
 * a nicer outline. A gaff fills the box: a four-sided mainsail from the boom up to a spar slung
 * aft, 3.3 units of foot against 1.2 of hoist. Low-slung working sail is also what a craft built to
 * duck under bridges actually carries, so the shape the clearance forces is the honest one.
 *
 * The **peak of the rig is placed from `SAIL_AIR`**, the way the tug's mast was and for the same
 * reason: it is the tallest thing on the boat and the only number in the clearance chain a bit of
 * styling can quietly break. The tug's first cut eyeballed a mast on top of its superstructure and
 * came out at 2.81 against the 2.75 an arched span leaves, which would have left it unable to reach
 * the drawbridge at all. Hanging the masthead off the constant means the geometry cannot disagree
 * with the chain, and everything else in the rig is hung off the masthead.
 */
export function createSailboatMesh(rng) {
  const hullCol = jitterColor(PALETTE.sailHull, rng, { l: 0.03 });
  const deckCol = jitterColor(PALETTE.boatDeck, rng, { l: 0.03 });
  const trimCol = jitterColor(PALETTE.sailTrim, rng, { l: 0.03 });
  const canvasCol = jitterColor(PALETTE.sailCanvas, rng, { l: 0.025 });

  const parts = [
    hull(SAIL_LEN, hullCol, SAIL_BEAM),
    deck(SAIL_LEN, 0.16, FREEBOARD, deckCol, SAIL_BEAM),
  ];

  const DECK_Y = FREEBOARD + 0.06;       // the top of the deck lid, which everything stands on
  const BOW = SAIL_LEN / 2;
  // The mast sits 36% of the way aft from the bow, which is where a sloop's is. Far enough forward
  // that the mainsail has the back half of the boat to fill, which is the whole silhouette.
  const MAST_Z = BOW - SAIL_LEN * 0.36;

  // A cabin trunk forward of the mast, and a cockpit coaming aft of it. Both low: this camera sees
  // the deck from above at 33 degrees, so anything standing on it competes with the sail for the
  // same pixels, and what has to win is the sail.
  const trunk = new THREE.BoxGeometry(SAIL_BEAM * 0.54, 0.40, SAIL_LEN * 0.36);
  trunk.translate(0, DECK_Y + 0.20, MAST_Z + SAIL_LEN * 0.17);
  parts.push(bakeColor(trunk, trimCol));

  const coaming = new THREE.BoxGeometry(SAIL_BEAM * 0.46, 0.14, SAIL_LEN * 0.30);
  coaming.translate(0, DECK_Y + 0.07, -SAIL_LEN * 0.25);
  parts.push(bakeColor(coaming, deckCol));

  // The mast: deck-stepped, running the full height to `SAIL_AIR`. Tapered, and thicker than the
  // tug's 0.11 stick — at play zoom that was under a pixel, which is how a boat defined by its air
  // draught ended up with nothing on screen to show it.
  const mastH = SAIL_AIR - DECK_Y;
  const mast = new THREE.CylinderGeometry(0.055, 0.09, mastH, 6);
  mast.translate(0, DECK_Y + mastH / 2, MAST_Z);
  parts.push(bakeColor(mast, deckCol));

  // The rig, in fore-and-aft `[z, y]` coordinates. Everything is measured off the masthead and the
  // boom, so the sail can never poke out through its own spars.
  //
  // **The boom rides low and the peak rides high, and that is the whole of the tuning.** A first
  // cut hung the boom half a unit over the deck and slung the gaff 0.46 under the masthead, which
  // is where they would sit on a boat with room over its head — and it left the sail occupying 0.97
  // of the 1.79 units the rig actually has, 54% of the only budget this boat is allowed. Measured
  // as a screen area that is 114 px against the 149 the same rig gives with the spars pushed to
  // their stops. On a vessel whose entire job is to look too tall for a bridge, half the canvas is
  // half the argument.
  const boomY = DECK_Y + 0.30;                 // low enough to sweep the cockpit, as a gaff boom does
  const clewZ = MAST_Z - SAIL_LEN * 0.52;      // how far aft the mainsail reaches, and it overhangs
  const throatY = SAIL_AIR - 0.42;             // where the gaff is slung on the mast
  const peakZ = MAST_Z - SAIL_LEN * 0.34;
  const peakY = SAIL_AIR - 0.12;               // ...and its aft end, under the masthead by design

  parts.push(spar(MAST_Z - 0.05, boomY, clewZ - 0.05, boomY + 0.06, 0.10, deckCol));
  parts.push(spar(MAST_Z - 0.05, throatY, peakZ, peakY, 0.09, deckCol));

  // The mainsail, inside its spars by half their section on every edge.
  parts.push(sail([
    [MAST_Z - 0.06, boomY + 0.07],             // tack
    [clewZ, boomY + 0.09],                     // clew
    [peakZ - 0.02, peakY - 0.06],              // peak
    [MAST_Z - 0.06, throatY - 0.06],           // throat
  ], 0.05, canvasCol));

  // A jib forward of it, on a forestay to the stemhead. It is a third of the mainsail's area and it
  // earns its place by filling the one part of the boat the mainsail cannot reach — without it a
  // 6.4-unit hull carries all of its canvas abaft the mast and reads as unbalanced from above.
  const stayHeadY = DECK_Y + (SAIL_AIR - DECK_Y) * 0.74;
  parts.push(spar(BOW - 0.18, DECK_Y + 0.05, MAST_Z, stayHeadY + 0.1, 0.07, deckCol));
  parts.push(sail([
    [BOW - 0.24, DECK_Y + 0.12],               // tack, at the stemhead
    [MAST_Z + 0.04, stayHeadY],                // head, on the stay
    [MAST_Z - 0.02, DECK_Y + 0.16],            // clew, at the mast foot
  ], 0.05, canvasCol));

  // The backstay, masthead to transom. A single 0.08 line and the longest diagonal on the boat —
  // it costs nothing and it is the detail that makes the silhouette unmistakably a sailing boat at
  // the close framings (`?shot=wake`) rather than a barge with a board on it.
  parts.push(spar(MAST_Z, SAIL_AIR - 0.06, -BOW + 0.2, DECK_Y + 0.08, 0.08, deckCol));

  return merge(parts);
}

function merge(parts) {
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

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
// *same* 2.4 units of air on a mainsail instead of a stick: 93 px² of pale canvas at play zoom
// against the mast's 5, and — the half that took two goes to get right — a shape that says what it
// is without being told. See `createSailboatMesh` for why that is a Bermudan rig on a short hull
// and not the gaff on a long one that held half again as much cloth.
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
export const SAIL_LEN = 4.6;
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
const SAIL_BEAM = 1.72;
const FREEBOARD = 0.55;        // the barge's hull above the waterline
const DRAFT = 0.35;            // ...and below it, which is only ever seen at the bow wave
/**
 * The sailboat's, and it is **mast height bought for nothing**.
 *
 * Every unit of freeboard is a unit the deck stands off the water, and the deck is where the mast
 * starts — so on a rig whose top is pinned by the arches at `SAIL_AIR`, dropping the deck is the
 * one way to make the mast longer without touching a single number in the clearance chain. 0.34
 * against the barge's 0.55 is 0.21 more mast, which on 1.79 is an eighth of the whole rig, and it
 * costs only what a yacht gives up anyway: a sailing hull sits lower and wetter than a cargo one.
 */
const SAIL_FREEBOARD = 0.34;

/**
 * A hull: a box with its bow drawn in.
 *
 * Tapered by scaling the front face rather than by hand-winding a wedge — a `BoxGeometry` cannot be
 * built inside out, and a hull is exactly the sloped-face shape the roadworks ramp shipped
 * reversed. Rotation and positive non-uniform scale both preserve handedness, so neither step here
 * can undo the winding Three gave it.
 */
function hull(length, col, beam = BEAM, free = FREEBOARD) {
  const geo = new THREE.BoxGeometry(beam, free + DRAFT, length);
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
  geo.translate(0, free / 2 - DRAFT / 2, 0);
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
 * **The luff is the mast, and everything else was tried first.** The rig has 1.79 units between the
 * deck and the ceiling the arched spans impose, which is a short mast by any measure — so the first
 * cut spent the width instead and hung a gaff mainsail off it, 3.3 units of foot against 1.2 of
 * hoist. It was the most canvas the box can hold (209 px² against this rig's 93) and it did not
 * read as a boat at all: a peak slung high and aft, a jib mirroring it forward, and the two of them
 * together drew one symmetrical roof with the mast buried inside it. Reported, exactly right, as
 * "the sail doesn't follow the mast and rig".
 *
 * What says *sailboat* is not area, it is **a vertical leading edge with a triangle hanging off the
 * back of it**. So the main is Bermudan: its luff runs the mast from boom to head, the leech is one
 * diagonal down to the clew, and the masthead stands clear above the head where it can be seen. The
 * jib is a third the size and set well forward with daylight between the two, so it reads as a
 * second sail rather than as the other half of a tent.
 *
 * **And the hull came down from 6.4 to 4.6 to pay for it.** A mast is read against the boat under
 * it, so on the long hull a 1.79 rig was 0.28 of the waterline and looked like a mast that had
 * snapped. At 4.6, with `SAIL_FREEBOARD` dropping the deck to buy the rig back up to 2.0, it is
 * **0.43** — still short of a real sloop's 1.3, and enough. Nothing about the clearance chain
 * wanted the long hull: the air draught is what the bridge cares about, and that is unchanged at
 * 2.4 whatever the hull does. What the short hull does cost is that the boat the bridge opens for
 * is now smaller than the barge that sails straight under it — which is also what a yacht and a
 * lighter actually look like side by side, and the mast is the part that matters.
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
    hull(SAIL_LEN, hullCol, SAIL_BEAM, SAIL_FREEBOARD),
    deck(SAIL_LEN, 0.16, SAIL_FREEBOARD, deckCol, SAIL_BEAM),
  ];

  const DECK_Y = SAIL_FREEBOARD + 0.06;  // the top of the deck lid, which everything stands on
  const BOW = SAIL_LEN / 2;
  // The mast sits a third of the way aft from the bow, which is where a sloop's is: far enough
  // forward to leave the whole back of the boat to the mainsail, far enough aft to leave a
  // foretriangle the jib can fill.
  const MAST_Z = BOW - SAIL_LEN * 0.34;
  // Everything in the rig is measured off this. It is the one number in the clearance chain that a
  // bit of styling can quietly break — the tug before this eyeballed a mast on top of its
  // superstructure and came out at 2.81 against the 2.75 an arched span leaves, which would have
  // left it unable to reach the drawbridge at all.
  const mastH = SAIL_AIR - DECK_Y;

  // A low cabin trunk forward of the mast and a cockpit coaming aft of it. Both deliberately squat:
  // this camera looks down at 33 degrees, so anything standing on the deck competes with the sail
  // for the same pixels, and what has to win is the sail.
  const trunk = new THREE.BoxGeometry(SAIL_BEAM * 0.56, 0.32, SAIL_LEN * 0.34);
  trunk.translate(0, DECK_Y + 0.16, MAST_Z + SAIL_LEN * 0.20);
  parts.push(bakeColor(trunk, trimCol));

  const coaming = new THREE.BoxGeometry(SAIL_BEAM * 0.46, 0.12, SAIL_LEN * 0.26);
  coaming.translate(0, DECK_Y + 0.06, -SAIL_LEN * 0.28);
  parts.push(bakeColor(coaming, deckCol));

  // The mast: deck-stepped, running the full height to `SAIL_AIR`, and tapered. Thicker than the
  // tug's 0.11 stick — at play zoom that was under a pixel, which is how a boat defined entirely by
  // its air draught ended up with nothing on screen to show it.
  const mast = new THREE.CylinderGeometry(0.05, 0.085, mastH, 6);
  mast.translate(0, DECK_Y + mastH / 2, MAST_Z);
  parts.push(bakeColor(mast, deckCol));

  // The rig, in fore-and-aft `[z, y]` coordinates.
  //
  // **The head stops short of the masthead on purpose.** A triangle taken all the way to the top
  // hides the spar it hangs on, and the bare masthead above the sail is what stops the silhouette
  // reading as a wedge. 0.16 is two pixels at play zoom, which is the least that survives.
  const boomY = DECK_Y + 0.16;                 // low, so the luff gets as much of the mast as it can
  const headY = SAIL_AIR - 0.16;
  // **The foot is short because the camera shears it.** A world X unit projects to 0.707 across the
  // screen and 0.385 *down* it, against a world Y unit's 0.838 straight up — so on a boat running
  // east-west the foot and the leech both travel up-screen as they go aft, and the triangle opens
  // out into a shallow wedge. At 0.46 of the hull the leech came down at 19 degrees off horizontal
  // and read as a pennant; at 0.36 it is 32 and reads as a sail. It costs a fifth of the mainsail's
  // area, which is the same trade this whole rig is: the shape is what carries, not the square units.
  const clewZ = MAST_Z - SAIL_LEN * 0.36;      // the foot, ending well short of the transom

  parts.push(spar(MAST_Z - 0.04, boomY, clewZ - 0.06, boomY + 0.05, 0.09, deckCol));

  // The mainsail. Its luff is the mast — the same z as the spar, offset only by half a section —
  // which is the whole of what makes this read as a sail rather than as an awning.
  parts.push(sail([
    [MAST_Z - 0.05, boomY + 0.06],             // tack
    [clewZ, boomY + 0.08],                     // clew
    [MAST_Z - 0.05, headY],                    // head
  ], 0.05, canvasCol));

  // The jib, on a forestay from the masthead to the stemhead. **Set with daylight between it and
  // the main**: the gaff version ran the two together into one outline, and two sails that touch
  // are one shape. The stay goes to the masthead rather than part way up, because a stay that stops
  // short leaves the top of the mast looking broken off.
  parts.push(spar(BOW - 0.16, DECK_Y + 0.04, MAST_Z, SAIL_AIR - 0.05, 0.06, deckCol));
  const jibHeadY = DECK_Y + mastH * 0.62;
  const jibHeadZ = MAST_Z + (BOW - 0.16 - MAST_Z) * (1 - 0.62);   // on the stay, where that height is
  parts.push(sail([
    [BOW - 0.30, DECK_Y + 0.10],               // tack, at the stemhead
    [jibHeadZ, jibHeadY],                      // head, on the stay
    [MAST_Z + 0.24, DECK_Y + 0.12],            // clew, short of the mast so the two sails stay apart
  ], 0.05, canvasCol));

  // The backstay, masthead to transom. One 0.07 line and the longest diagonal on the boat — it
  // costs nothing and it is what makes the mast read as stayed rather than as a pole stuck in a
  // deck at the close framings (`?shot=18`).
  parts.push(spar(MAST_Z, SAIL_AIR - 0.05, -BOW + 0.16, DECK_Y + 0.06, 0.07, deckCol));

  return merge(parts);
}

function merge(parts) {
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

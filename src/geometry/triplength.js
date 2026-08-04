import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { VIEW_DIR } from '../game/camera.js';

// How many blocks this rider is going, shown on a plate over their head while they wait.
//
// The destination pin now appears the moment a rider does, so the *where* is on the map — but at
// play zoom two pins forty pixels apart look much the same distance away as two pins eighty pixels
// apart, and the trip that actually matters is measured in blocks driven, not in screen distance.
// The number is the whole judgement in one glyph: 2 is a hop, 9 is a haul across town.
//
// Seven-segment digits rather than a texture, because a canvas glyph would be the first thing in
// this project that isn't generated geometry — and because it has to construct under `node` for
// the headless tools, which have no DOM to draw into. The meter read is a happy accident: this is
// a taxi, and a taxi's number lives on a segment display.

// Sized against the camera, where 1 world unit is about 7.7px at play zoom. The timer ring is
// ~25px across and is the project's floor for "legible without zooming"; a glyph you have to
// *read* needs more than an arc you only have to see the colour of, so the plate lands a little
// over that and the digit inside it fills ~23px of height.
const DIGIT_W = 1.9;         // ~15px at play zoom
const DIGIT_H = 3.0;         // ~23px — below about 18 the segments stop resolving into a digit
const STROKE = 0.52;         // ~4px. Thinner and the segments dissolve into the plate.
const DIGIT_GAP = 0.38;
// Padding is wider than it is tall because the digit is not: without it a one-digit badge came out
// a tall thin portrait, which reads as a signpost rather than as a number.
const PAD_X = 0.8;
const PAD_Y = 0.45;

// Same weight as the outlines on the marker pins, for the same reason: the plate wears the fare's
// own colour, and several of those are light enough to wash out against a pale building behind.
const OUTLINE = 0.28;

// Clear of the rider's head (the figure tops out a little over 3.3) with a gap, so the plate reads
// as floating above them rather than worn as a hat.
const LIFT = 6.0;

// Draws over everything, including its own rider — the whole point is a number readable at a
// glance from anywhere on the map, and this camera puts a building in front of a kerb constantly.
// Above ABOVE_RING (12) so the timer ring's layers can't paint over it either.
const PLATE_ORDER = 14;

// Every layer of the badge is flagged transparent despite being fully opaque, which is the
// opposite of the trick the timer ring's track had to play.
//
// The light shaft stands over exactly this spot and it *is* transparent, so three draws it after
// the entire opaque queue no matter what renderOrder either one claims. Left opaque, the plate got
// an additive white wash straight up its middle and the shaft's facet seams stepped across the
// digits. Joining the transparent queue puts both in the same pass, where renderOrder decides —
// and the shaft's is 1 against this 13-and-up.
const LAYER = { transparent: true, opacity: 1, depthTest: false, depthWrite: false };

// Seven segments, in the conventional a-b-c-d-e-f-g order:
//
//      a
//    f   b
//      g
//    e   c
//      d
//
//              a  b  c  d  e  f  g
const MASKS = [
  [1, 1, 1, 1, 1, 1, 0],   // 0
  [0, 1, 1, 0, 0, 0, 0],   // 1
  [1, 1, 0, 1, 1, 0, 1],   // 2
  [1, 1, 1, 1, 0, 0, 1],   // 3
  [0, 1, 1, 0, 0, 1, 1],   // 4
  [1, 0, 1, 1, 0, 1, 1],   // 5
  [1, 0, 1, 1, 1, 1, 1],   // 6
  [1, 1, 1, 0, 0, 0, 0],   // 7
  [1, 1, 1, 1, 1, 1, 1],   // 8
  [1, 1, 1, 1, 0, 1, 1],   // 9
];

// Segment placement, in the digit's own space with (0, 0) at its centre.
//
// Horizontals span the *full* digit width so their ends finish flush with the outer edge of the
// verticals. The first version ran them from vertical-centre to vertical-centre, which left each
// upright poking half a stroke past every bar it met — at 18px tall that reads as a ragged glyph
// rather than a digit. Verticals run from the outer edge to the middle bar, overlapping both by
// half a stroke, which is what closes the corners.
const HALF_H = DIGIT_H / 2;
const BAR_W = DIGIT_W;
const BAR_H = HALF_H - STROKE;
const SIDE_X = (DIGIT_W - STROKE) / 2;
const SEGMENTS = [
  { x: 0, y: HALF_H - STROKE / 2, w: BAR_W, h: STROKE },     // a — top
  { x: SIDE_X, y: HALF_H / 2, w: STROKE, h: BAR_H },         // b — upper right
  { x: SIDE_X, y: -HALF_H / 2, w: STROKE, h: BAR_H },        // c — lower right
  { x: 0, y: -HALF_H + STROKE / 2, w: BAR_W, h: STROKE },    // d — bottom
  { x: -SIDE_X, y: -HALF_H / 2, w: STROKE, h: BAR_H },       // e — lower left
  { x: -SIDE_X, y: HALF_H / 2, w: STROKE, h: BAR_H },        // f — upper left
  { x: 0, y: 0, w: BAR_W, h: STROKE },                       // g — middle
];

// One unit quad, scaled per piece. Every part of this badge is a rectangle facing the camera, so
// they can all share it — and sharing means one geometry per slot instead of seventeen.
const QUAD = new THREE.PlaneGeometry(1, 1);

// The badge faces the camera, and the camera never turns — so this is a constant, resolved once
// here rather than a lookAt every frame on three floating plates.
const FACING = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().lookAt(VIEW_DIR, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)),
);

const PLATE_H = DIGIT_H + PAD_Y * 2;
const plateWidth = (digits) => digits * DIGIT_W + (digits - 1) * DIGIT_GAP + PAD_X * 2;

/** A rectangle on the badge plane. `z` separates the layers; they are all opaque and unlit. */
function panel(color, order, z) {
  // Same bargain the timer ring makes: legibility beats depth correctness. A count you cannot see
  // because a tower is in the way tells the player nothing.
  const mesh = new THREE.Mesh(QUAD, new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    ...LAYER,
  }));
  mesh.renderOrder = order;
  mesh.position.z = z;
  mesh.raycast = () => {};   // never a click target; the rider underneath it is
  return mesh;
}

/** One seven-segment digit. Returns a group plus the setter that lights the right segments. */
function digit(material) {
  const group = new THREE.Group();
  const bars = SEGMENTS.map((s) => {
    const mesh = new THREE.Mesh(QUAD, material);
    mesh.scale.set(s.w, s.h, 1);
    mesh.position.set(s.x, s.y, 0.02);
    mesh.renderOrder = PLATE_ORDER + 1;
    mesh.raycast = () => {};
    group.add(mesh);
    return mesh;
  });
  return {
    group,
    show(value) {
      const mask = MASKS[value];
      for (let s = 0; s < bars.length; s++) bars[s].visible = mask[s] === 1;
    },
  };
}

/**
 * The plate over a waiting rider's head. Built once per fare slot and re-set on every spawn, the
 * same way the rest of the slot's meshes are reused.
 */
export function createTripLength() {
  const group = new THREE.Group();
  group.quaternion.copy(FACING);
  group.position.y = LIFT;
  group.visible = false;

  const outline = panel(0x000000, PLATE_ORDER - 1, -0.02);
  const plate = panel(PALETTE.passenger, PLATE_ORDER, 0);
  group.add(outline, plate);

  // Digits share one material, so retinting is a single assignment — but the *plate* carries the
  // fare colour, not the digits, so this one never actually changes. It exists as a material
  // rather than a colour per mesh purely so fourteen segments cost one uniform upload.
  const ink = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.tripInk), ...LAYER });

  // Tens then units. A trip is at most GRID * 2 = 10 blocks corner to corner, so two is all the
  // room this ever needs.
  const digits = [digit(ink), digit(ink)];
  digits.forEach((d) => group.add(d.group));

  /**
   * Show `blocks` in `color`. Lays the digits out around the centre and resizes the plate to fit,
   * so a one-digit number gets a compact badge rather than a wide one with a hole in it.
   */
  function set(blocks, color) {
    const value = Math.max(0, Math.min(99, Math.round(blocks)));
    const tens = Math.floor(value / 10);
    const count = tens > 0 ? 2 : 1;

    const step = DIGIT_W + DIGIT_GAP;
    const left = -((count - 1) * step) / 2;
    digits[0].group.visible = count === 2;
    if (count === 2) {
      digits[0].show(tens);
      digits[0].group.position.x = left;
    }
    digits[1].show(value % 10);
    digits[1].group.position.x = left + (count - 1) * step;

    const w = plateWidth(count);
    plate.scale.set(w, PLATE_H, 1);
    outline.scale.set(w + OUTLINE * 2, PLATE_H + OUTLINE * 2, 1);
    // The plate wears the fare's own colour, which is what pairs this rider with the destination
    // pin standing in that colour somewhere else on the map. With two riders on the kerb that
    // pairing is the only thing saying which drop-off belongs to whom.
    plate.material.color.set(color ?? PALETTE.passenger);

    group.visible = true;
  }

  return {
    group,
    set,
    hide() { group.visible = false; },
  };
}

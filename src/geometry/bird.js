import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor } from '../util/geo.js';
import { color } from '../palette.js';

// One bird, in three pieces: a merged body and a wing per side. The flock that flies them is in
// game/birds.js — this is only the model.
//
// Nose points +X, the same convention every other body in the project uses (`dirYaw` in
// city/grid.js turns a direction into the yaw that aims a +X model down it), so the flock computes
// a heading exactly the way the traffic and the aeroplane do.
//
// **Each wing is its own geometry with the shoulder at its origin**, rather than one wing mirrored
// by a negative scale. A mirrored scale flips the winding on every triangle, and with
// `flatShading` that lights the whole wing as if the sun were behind it — the same trap the
// back-face passes elsewhere in the project have to work around. Two geometries cost one extra
// draw call for the entire flock and no thought at all.
//
// Scale is a deliberate lie, as it is for the riders in geometry/person.js. A pigeon next to a
// 4-unit car should be a quarter of a unit long, which is two pixels at play zoom and reads as a
// speck of dirt on the grass. This is a bit over a unit — a gull, near enough, at the 1 unit ≈ 1.1m
// the taxi sets — so the silhouette survives the camera.

export const BIRD_LEN = 1.08;        // bill tip to tail tip
export const BIRD_SPAN = 1.44;       // wingtip to wingtip, wings spread level
export const BIRD_STAND_Y = 0.33;    // origin to the soles, i.e. how far to lift it off the grass

/**
 * Where a wing hangs off the body, in model space — the +Z (right) side; the left wing mirrors the
 * z. The flock rotates each wing *about this point*, which is why the wing geometries are built
 * with the shoulder at their own origin and this offset is applied in the instance matrix instead
 * of being baked in.
 */
export const WING_ROOT = { x: 0.05, y: 0.09, z: 0.10 };

/** One axis-aligned box, coloured and placed. Every part of a bird is one of these. */
function box(w, h, d, x, y, z, name) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return bakeColor(geometry, color(name));
}

/**
 * Body, head, tail and legs as one merged geometry — none of it articulates. The peck and the
 * waddle are rotations of the whole body about its own origin, which is what a pecking bird
 * actually does: the tail comes up as the bill goes down.
 */
export function birdBodyGeometry() {
  const parts = [
    // Torso, then a tapering rear the tail hangs off. Two boxes stepping down is the whole body,
    // the same way three make up the aeroplane's fuselage.
    box(0.40, 0.24, 0.22, 0.02, 0, 0, 'birdBody'),
    box(0.20, 0.15, 0.15, -0.28, 0.01, 0, 'birdBody'),
    // Tail: flat, and tilted nose-down a touch so it reads as a fan rather than a plank.
    box(0.26, 0.045, 0.17, -0.50, 0.04, 0, 'birdWing'),

    // Head sits forward and up on no visible neck — at seven pixels a neck is a gap, not a part.
    //
    // Pale, and that is the whole of how a bird reads. It is the one value break on the thing, it
    // is on the *top* surface, and the camera is 33° up — so it is what says "this is an animal and
    // it is facing that way" from a framing where the flanks are barely in shot. The first attempt
    // put the pale patch on the breast, which is correct for a pigeon and completely invisible
    // here: its top sat under the torso's, so from above every bird was a featureless dark pebble.
    box(0.15, 0.16, 0.15, 0.26, 0.14, 0, 'birdPale'),
    box(0.12, 0.05, 0.05, 0.39, 0.13, 0, 'birdBill'),
  ];

  // Legs and feet. Two pixels of each at play zoom, and worth having anyway: without them the body
  // sits *on* the grass rather than standing on it, which is the difference between a bird and a
  // stone. They are the bill's colour rather than their own — one dark for every hard part.
  for (const side of [-1, 1]) {
    parts.push(box(0.035, 0.18, 0.035, 0, -0.21, side * 0.055, 'birdBill'));
    parts.push(box(0.09, 0.03, 0.07, 0.02, -0.315, side * 0.055, 'birdBill'));
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  return merged;
}

/**
 * One wing, shoulder at the origin, reaching out along `side * Z`.
 *
 * Two boxes: an inner panel and a narrower outer one swept back off it. The sweep is the whole
 * reason it is two boxes — a straight slab reads as a paddle, and the step where the chord narrows
 * is what a wing's leading edge looks like from a fixed camera 33° up.
 *
 * @param side  +1 for the right wing, -1 for the left
 */
export function birdWingGeometry(side) {
  const parts = [
    box(0.30, 0.035, 0.34, 0, 0, side * 0.17, 'birdWing'),
    box(0.21, 0.030, 0.30, -0.055, 0, side * 0.47, 'birdWing'),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  return merged;
}

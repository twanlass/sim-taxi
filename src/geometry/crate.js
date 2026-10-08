import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { color } from '../palette.js';
import { mergeAll } from './roadworks.js';
import { TRUCK_BOX_LEN, TRUCK_BOX_X, TRUCK_CHASSIS_TOP, TRUCK_W } from '../sim/traffic.js';

// The flatbed's load and the flatbed itself — see game/flatbed.js.
//
// A timber crate rather than a cardboard box, and the difference is the point: the courier's
// parcels (geometry/parcel.js) are kraft boxes with one tape strip, and a box of that colour lying
// in the road would read as something to collect. Pale pine with a darker batten round each end is
// a different object at a glance. Same reason for the size: a crate is sized to the truck it rides
// on, two across a 2.0-wide deck, not to the ~2-unit cargo the HUD argues about.
//
// Everything here is built in the **truck's own frame** (+X forward, +Y up, +Z across), which is
// the frame the ambient truck's instance matrix carries — the deck is composed through that matrix
// exactly the way the box it replaces was.

// Two across a 2.0 deck inside its side rails (inner faces at ±0.92), with room for the few
// hundredths a hand-loaded yaw adds to a crate's half-width. At 0.9 there was none, and the probe
// found every crate on the deck through a rail.
export const CRATE = 0.86;
/** How high a crate's origin sits once it is lying on the road. Its origin is its centre. */
export const CRATE_REST_Y = CRATE / 2;

const BATTEN_W = 0.16;
const BATTEN_PROUD = 0.02;    // stands off the face it is nailed to, so the two never share a plane

const DECK_T = 0.12;
/** The top of the deck's planking, in the truck frame. What the bottom row of crates stands on. */
export const DECK_TOP = TRUCK_CHASSIS_TOP + DECK_T;
/** The deck's rear edge, in the truck frame. A crate slid past this is off the back. */
export const DECK_REAR = TRUCK_BOX_X - TRUCK_BOX_LEN / 2;

// The stencilled mark on one side. It is the only thing about a crate that is not the same on all
// four sides, and it is there for exactly that: the load is turned a random quarter on the deck
// (`crateLook`), and a cube banded the same all the way round looks identical at every quarter.
const STENCIL = [0.34, 0.2];
const STENCIL_PROUD = 0.01;   // less than a batten's, and between them, so it touches neither

/**
 * One crate, origin at its centre so it tumbles about itself, standing on its base.
 *
 * Two battens, one round the top and one round the bottom, rather than a single band: at ~7px a
 * crate with one stripe through the middle is a parcel with tape on it again, and two framing it
 * is the silhouette of a crate. They used to ring the two *ends* (about X), which put two straps
 * across the lid and read as a crate lying on its side; ringed about Y they frame the faces the
 * camera sees and leave the lid clear. They are sleeves proud of the body on four faces — a
 * hand-written triangle is the winding trap in CLAUDE.md, and a BoxGeometry cannot be wound wrong.
 */
export function crateGeometry() {
  const parts = [];
  const body = new THREE.BoxGeometry(CRATE, CRATE, CRATE);
  parts.push(bakeColor(body, color('crate')));

  const sleeve = CRATE + BATTEN_PROUD * 2;
  for (const side of [-1, 1]) {
    const batten = new THREE.BoxGeometry(sleeve, BATTEN_W, sleeve);
    batten.translate(0, side * (CRATE / 2 - BATTEN_W / 2 - 0.04), 0);
    parts.push(bakeColor(batten, color('crateBatten')));
  }

  const [sw, sh] = STENCIL;
  const stencil = new THREE.BoxGeometry(STENCIL_PROUD * 2, sh, sw);
  stencil.translate(CRATE / 2, 0, 0);
  parts.push(bakeColor(stencil, color('crateStencil')));
  return mergeAll(parts);
}

// What a crate's per-instance tint multiplies its baked colours by. A handful of woods rather than
// a jitter round one: a lightness jitter small enough to keep it pine is invisible at ~7px, and a
// large one turns some crates the colour of the courier's kraft parcels. These are fresh pine,
// a darker board, an older greyed one and a warm reddish one, each nudged a little more.
const CRATE_TINTS = ['crateTintFresh', 'crateTintDark', 'crateTintGrey', 'crateTintWarm'];

/**
 * One crate's look: a tint for `setColorAt` and a quarter turn to add to its yaw. Drawn from the
 * caller's stream once, when the crate is made, so it never changes while the crate is about.
 */
export function crateLook(rng, out = new THREE.Color()) {
  out.copy(color(rng.pick(CRATE_TINTS)));
  out.multiplyScalar(1 - rng.range(0, 0.08));
  return { tint: out, turn: rng.int(0, 3) * (Math.PI / 2) };
}

// A chip off a smashed crate. The same reasoning as the trestle's splinter (geometry/roadworks.js):
// thick enough to catch the sun edge-on while it tumbles, since a true-to-life plank chip is a
// single pixel at play zoom and flickers as it spins.
const CHIP = [0.46, 0.1, 0.18];
export const CRATE_CHIP_REST_Y = CHIP[1] / 2;

/** A splintered slat, half pine and half batten, so a piece in the air still reads as the crate. */
export function crateChipGeometry() {
  const [w, h, d] = CHIP;
  const parts = [];
  for (const side of [-1, 1]) {
    const half = new THREE.BoxGeometry(w / 2, h, d);
    half.translate((side * w) / 4, 0, 0);
    parts.push(bakeColor(half, color(side < 0 ? 'crate' : 'crateBatten')));
  }
  return mergeAll(parts);
}

/**
 * The open deck that stands in for a box truck's box: planking over the chassis in the box's own
 * footprint, a steel headboard behind the cab, and a low rail down each side.
 *
 * The rails are what keep the load reading as *on* the truck rather than hovering over it — a bare
 * plank the colour of the road is invisible from a 33° camera, and without them the bottom row of
 * crates looks like it is resting on the chassis roof.
 */
export function flatbedDeckGeometry() {
  const parts = [];

  const deck = new THREE.BoxGeometry(TRUCK_BOX_LEN, DECK_T, TRUCK_W);
  deck.translate(TRUCK_BOX_X, TRUCK_CHASSIS_TOP + DECK_T / 2, 0);
  parts.push(bakeColor(deck, color('flatbedDeck')));

  const head = new THREE.BoxGeometry(0.12, 1.05, TRUCK_W * 0.92);
  head.translate(TRUCK_BOX_X + TRUCK_BOX_LEN / 2 - 0.06, DECK_TOP + 1.05 / 2, 0);
  parts.push(bakeColor(head, color('flatbedRail')));

  // Down each side, stopping short of the tail so the load has an open end to go off.
  const railLen = TRUCK_BOX_LEN - 0.35;
  for (const side of [-1, 1]) {
    const rail = new THREE.BoxGeometry(railLen, 0.22, 0.08);
    rail.translate(TRUCK_BOX_X + 0.35 / 2, DECK_TOP + 0.11, side * (TRUCK_W / 2 - 0.04));
    parts.push(bakeColor(rail, color('flatbedRail')));
  }

  return mergeAll(parts);
}

import * as THREE from 'three';
import { ROUTE_OPACITY } from '../game/routeline.js';
import {
  RING_GROW_TIME, RING_SHRINK_TIME, ringGrowScale, ringShrinkScale,
} from './targetring.js';

// The mark a courier job puts on the ground: a **rounded square**, lying flat on the pavement
// corner, in the courier's fixed cyan. Both ends of a package's trip wear one — under the box while
// it waits, and on the pad it is going to once it is aboard.
//
// **The shape is the whole point.** The board already says "shape says what a thing is, hue says
// whose clock is paying for it": a diamond is a clock, a disc is a fare's destination, a band is a
// route. A package is neither a clock nor a fare, and it is not reached the way either of those is —
// there is nothing to tap, only a route to bend through it. So it gets a shape of its own, and a
// square is the one that reads as *cargo* against a board full of circles. At play zoom the
// silhouette is what carries it: a rounded square and a disc are told apart at 50px in a way two
// hues never would be.
//
// Built as one rim shape and one fill shape shared by every pad on the board — only the position
// ever differs, since a package has no clock and so no colour to step through. That is also why
// there is **no sweep beam** here, unlike the fare disc: the beam is that disc's "this is the live
// thing being driven at" cue, and a courier pad is not being driven at. It is a standing offer. A
// pad that pulsed forever would be motion carrying no news.

/** Half-width of the pad. A shade under the fare disc's radius, so the square doesn't out-mass it. */
export const PAD_R = 3.2;
const PAD_RADIUS = 1.1;      // corner rounding
const PAD_RIM = 0.34;        // rim band width

/**
 * A rounded-square outline as a THREE.Shape, half-width `r`.
 *
 * Wound counter-clockwise in the XY plane so that after the -X/2 rotation onto the ground plane the
 * face normal comes out **+Y**. Hand-written winding gets asserted rather than eyeballed here — the
 * roadworks ramp shipped wound the wrong way and read as z-fighting for weeks. `tools/probe.mjs`
 * checks the sign of this geometry's normal.
 */
function roundedSquare(r, radius) {
  const shape = new THREE.Shape();
  const k = r - radius;
  shape.moveTo(-k, -r);
  shape.lineTo(k, -r);
  shape.quadraticCurveTo(r, -r, r, -k);
  shape.lineTo(r, k);
  shape.quadraticCurveTo(r, r, k, r);
  shape.lineTo(-k, r);
  shape.quadraticCurveTo(-r, r, -r, k);
  shape.lineTo(-r, -k);
  shape.quadraticCurveTo(-r, -r, -k, -r);
  return shape;
}

// The rim is the outer square with the inner one punched out of it as a hole, so it is a genuine
// band rather than two outlines drawn at different sizes. The fill overlaps *into* the rim by half
// its width, the way the disc's fill overlaps its torus, so no hairline of road shows between them
// where the curves tessellate.
const RIM_SHAPE = roundedSquare(PAD_R, PAD_RADIUS);
RIM_SHAPE.holes.push(roundedSquare(PAD_R - PAD_RIM, Math.max(0.1, PAD_RADIUS - PAD_RIM)));
const RIM_GEO = new THREE.ShapeGeometry(RIM_SHAPE, 8).rotateX(-Math.PI / 2);
const FILL_GEO = new THREE.ShapeGeometry(
  roundedSquare(PAD_R - PAD_RIM / 2, PAD_RADIUS - PAD_RIM / 2), 8,
).rotateX(-Math.PI / 2);

/**
 * A courier pad in one colour.
 *
 * Depth-tested with `depthWrite: false`, exactly as the fare disc is, and for the same two reasons:
 * a car crossing the junction has to drive *over* the pad rather than the pad painting across the
 * car, and the two layers must not fight each other for the same plane. The depth test is
 * load-bearing under the waiting box — the far half of a flat shape projects *upward on screen* at
 * this camera angle, and without the test the pad would paint a band across the parcel standing in
 * the middle of it.
 *
 * `setColor` is here for symmetry with `createTargetRing` and because both layers are one mark at
 * two weights; nothing calls it today, since a package has no clock to repaint for.
 */
export function createParcelPad(colorHex) {
  const group = new THREE.Group();
  const color = new THREE.Color(colorHex);

  const rim = new THREE.Mesh(
    RIM_GEO,
    new THREE.MeshBasicMaterial({ color: color.clone(), depthWrite: false }),
  );
  rim.renderOrder = 4;
  rim.raycast = () => {};
  group.add(rim);

  const fill = new THREE.Mesh(FILL_GEO, new THREE.MeshBasicMaterial({
    color: color.clone(),
    transparent: true,
    opacity: ROUTE_OPACITY,
    depthWrite: false,
  }));
  fill.renderOrder = 3;   // under the rim, so the rim still reads as an edge
  fill.raycast = () => {};
  group.add(fill);

  // Arrival and exit, exactly the fare disc's — see the note above `RING_GROW_TIME` in
  // targetring.js. The envelopes are imported rather than reimplemented: the two shapes differ, the
  // gesture must not, or a courier pad and a drop-off disc appearing on the same board would be two
  // different kinds of event.
  let grewAt = null;
  let goneAt = null;
  let pending = null;      // 'grow' | 'shrink'

  return {
    group,
    /** Both layers together — they are one mark at two weights, never different colours. */
    setColor(value) {
      rim.material.color.set(value);
      fill.material.color.set(value);
    },
    /** Arrive: grow out of the centre. Scale goes to nothing now, so no frame draws it full-size. */
    appear() {
      pending = 'grow';
      goneAt = null;
      group.scale.setScalar(0);
      group.visible = true;
    },
    /** Leave: pull back into the centre, then hide. Stays visible until it has. */
    vanish() {
      if (!group.visible) return;
      pending = 'shrink';
      grewAt = null;
    },
    /**
     * Jump to fully arrived, cancelling any animation.
     *
     * For **shot mode**, which ticks the fare loop exactly once and then freezes: an arrival that is
     * a function of sim time needs sim time to pass, so a disc that opens at scale 0 and is never
     * updated again is a disc that is simply not there. Every rider's kerb disc vanished from every
     * screenshot the day `appear()` landed, which is a worse failure than the pop it replaced —
     * hence a way to say "be arrived" without pretending a frame went by.
     */
    settle() {
      pending = null;
      grewAt = null;
      goneAt = null;
      group.scale.setScalar(1);
    },
    /** Off, with no animation — a run ending, or a slot handed to the next package. */
    hideNow() {
      group.visible = false;
      group.scale.setScalar(1);
      grewAt = null;
      goneAt = null;
      pending = null;
    },
    isLeaving: () => pending === 'shrink' || goneAt !== null,
    /**
     * Advances whichever size animation is running. There is no beam to spin — see the note at the
     * top of this file — so on a settled pad this is a couple of null checks.
     */
    update(elapsed) {
      if (pending === 'grow') { grewAt = elapsed; pending = null; }
      else if (pending === 'shrink') { goneAt = elapsed; pending = null; }

      if (goneAt !== null) {
        const t = (elapsed - goneAt) / RING_SHRINK_TIME;
        group.scale.setScalar(ringShrinkScale(t));
        if (t >= 1) { group.visible = false; goneAt = null; group.scale.setScalar(1); }
      } else if (grewAt !== null) {
        const t = (elapsed - grewAt) / RING_GROW_TIME;
        group.scale.setScalar(ringGrowScale(t));
        if (t >= 1) grewAt = null;
      }
    },
  };
}

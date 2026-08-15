import * as THREE from 'three';
import { ROUTE_OPACITY } from '../game/routeline.js';
import { unlitMaterial } from '../util/geo.js';
import {
  RING_GROW_TIME, RING_SHRINK_TIME, ringGrowScale, ringShrinkScale, createSweepFor,
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
// Built as one rim, one fill and one sweep-band shape shared by every pad on the board — only the
// position ever differs, since a package has no clock and so no colour to step through.
//
// **It wears the fare disc's beam**, off the same shader (targetring.js, `createSweepFor`). It was
// left off at first, on the argument that the beam is the disc's "this is the live thing being driven
// at" cue and a courier pad is a standing offer rather than a target. That reads worse than it argues:
// on a board where the fare discs glint and the pads sit dead, the pads look like road paint somebody
// forgot to clean up. The beam is what says a mark belongs to the game, and both marks do.

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

// The beam's path. Same shader, same speed, same tail as the disc's — only the shape differs, which is
// why the geometry is the only thing `createSweepFor` takes.
//
// Built by hand rather than from a torus, because the path is a rounded square. The perimeter is
// sampled once, and each vertex carries its **normalised arc length** as `aAngle` — arc length, not
// the angle from the centre, or the beam would visibly slow down along the flats and race round the
// corners where the centre-angle sweeps fastest.
const SWEEP_WIDTH = PAD_RIM * 1.4;   // a little fatter than the rim, so it reads as a glint on the edge
const SWEEP_GEO = (() => {
  // Sampled on the rim's own centreline, so the band sits over the rim rather than beside it.
  const path = roundedSquare(PAD_R - PAD_RIM / 2, PAD_RADIUS - PAD_RIM / 2);
  const pts = path.getPoints(96);
  // `getPoints` closes the loop by repeating the first point; drop it so no zero-length segment
  // appears, and wrap by index instead.
  const last = pts[pts.length - 1];
  if (Math.hypot(last.x - pts[0].x, last.y - pts[0].y) < 1e-6) pts.pop();

  const n = pts.length;
  // Cumulative arc length round the loop, normalised to 0..2π so it feeds the shared shader unchanged.
  const cum = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = cum[n];

  const position = [];
  const angle = [];
  const half = SWEEP_WIDTH / 2;
  // Outward normal of each segment, from its own tangent. Per segment rather than per vertex: the band
  // is a couple of hundred pixels round at most, and mitring the corners of a shape this soft buys
  // nothing the eye can see.
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const aOut = [a.x + nx * half, a.y + ny * half];
    const aIn = [a.x - nx * half, a.y - ny * half];
    const bOut = [b.x + nx * half, b.y + ny * half];
    const bIn = [b.x - nx * half, b.y - ny * half];
    const t0 = (cum[i] / total) * Math.PI * 2;
    const t1 = (cum[i + 1] / total) * Math.PI * 2;
    // Two triangles per segment, wound so the face normal comes out **+Y** after the rotation below.
    // Asserted in tools/probe.mjs across every triangle rather than eyeballed — a band wound the wrong
    // way is invisible from this camera, which is exactly what a missing beam looks like.
    const push = (p, t) => { position.push(p[0], p[1], 0); angle.push(t); };
    push(aIn, t0); push(bIn, t1); push(bOut, t1);
    push(aIn, t0); push(bOut, t1); push(aOut, t0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(position), 3));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(new Float32Array(angle), 1));
  return geo.rotateX(-Math.PI / 2);
})();

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
    unlitMaterial({ color: color.clone(), depthWrite: false }),
  );
  rim.renderOrder = 4;
  rim.raycast = () => {};
  group.add(rim);

  const fill = new THREE.Mesh(FILL_GEO, unlitMaterial({
    color: color.clone(),
    transparent: true,
    opacity: ROUTE_OPACITY,
    depthWrite: false,
  }));
  fill.renderOrder = 3;   // under the rim, so the rim still reads as an edge
  fill.raycast = () => {};
  group.add(fill);

  const sweep = createSweepFor(SWEEP_GEO, colorHex);
  group.add(sweep.mesh);

  // Arrival and exit, exactly the fare disc's — see the note above `RING_GROW_TIME` in
  // targetring.js. The envelopes are imported rather than reimplemented: the two shapes differ, the
  // gesture must not, or a courier pad and a drop-off disc appearing on the same board would be two
  // different kinds of event.
  let grewAt = null;
  let goneAt = null;
  let pending = null;      // 'grow' | 'shrink'

  return {
    group,
    /** All three layers together — one mark at three weights, never different colours. */
    setColor(value) {
      rim.material.color.set(value);
      fill.material.color.set(value);
      sweep.material.color.set(value);
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
    /** Advances the beam circling the rim, and whichever size animation is running. */
    update(elapsed) {
      sweep.update(elapsed);

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

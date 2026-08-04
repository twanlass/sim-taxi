import * as THREE from 'three';
import { KERB_H } from '../city/ground.js';
import { urgencyColorFor } from './urgency.js';

// The fare's clock, as a physical object.
//
// It belongs to the *fare*, not to a marker. While the rider is on the kerb their deadline is the
// urgency bar on the meter over their head; the instant they board, this ring is placed on that
// same corner and flies to the taxi, so the hand-off reads as the clock following them into the
// car. It does not restart at pickup — one deadline covers spawn all the way to drop-off, which is
// where the difficulty of the game lives.

// Sized to clear the taxi comfortably — it used to be sized against the pool that marked the taxi
// as selected, and before that imported from a ring the taxi wore itself. Both are gone; the ring
// shape belongs to fares now, and these numbers are simply what reads at play zoom.
const RING = { inner: 2.35 * 1.18, outer: 3.05 * 1.18 };

const SEGMENTS = 96;
const TRANSFER_TIME = 0.65;

// Black rim, drawn as a slightly wider annulus underneath the other two so it shows on both edges
// of the band. Same job and roughly the same weight as the inverted-hull outlines on the marker
// pins (0.18 units there), so the two read as the same drawing.
//
// It earns its place at play zoom, where the ring is ~25px across on road that is barely darker
// than the yellow stage colour: without a rim the arc's edge dissolves into the tarmac and the
// clock stops being readable at a glance, which is the only thing it is for.
const OUTLINE_W = 0.22;

/**
 * The renderOrder anything that stands *inside* the ring must use — the rider on the kerb, and the
 * taxi once the clock has flown to it.
 *
 * The ring draws with `depthTest: false` so it stays legible through buildings, and at this camera
 * angle the far half of a flat circle projects *upward* across whatever is standing at its centre.
 * Without this the ring cut its own owner in half. Because the ring writes no depth, an ordinary
 * depth-tested object drawn afterwards simply lands on top and still self-occludes correctly.
 *
 * It has to clear every layer of the ring — outline 7, track 8, arc 9 — and the taxi's selection
 * disk at 5. All of them are opaque, which is what makes renderOrder decide the outcome at all:
 * a translucent layer would draw after every opaque object regardless.
 */
export const ABOVE_RING = 12;

// Screen-space top. The camera looks down the +X+Z diagonal, so screen-up is world (-1, 0, -1),
// which is this angle. Sweeping from here with increasing theta reads as clockwise on screen.
const START_ANGLE = -Math.PI * 0.75;

// The unfilled part of the circle. Opaque, with the dimming already baked in — this is what
// #16222B at 0.45 used to composite to over asphalt.
//
// It was a translucent wash, and that put it in three's transparent queue, which always draws
// after every opaque object no matter what renderOrder says. The rider stands at the centre of
// this ring and the far half of it projects *up* across their body at this camera angle, so a
// transparent track painted a dark band over the figure that no draw order could undo.
const TRACK = new THREE.Color('#404952');

// Colour comes from the shared urgency model, not from a ramp of this ring's own.
//
// It used to keep its own four bands here. That was fine while the ring was the only clock, but the
// meter over a waiting rider now shows the same deadline as a count of lit segments — a rider on
// two orange segments whose ring turns yellow the moment they board is two answers to one question.
// One scale, three surfaces: see game/urgency.js.
export const fareStageColour = urgencyColorFor;
const colourFor = urgencyColorFor;

// Panic pulse. Below PULSE_BELOW_S the ring beats — same object the eye is already reading for
// colour, so the two cues stack ("red AND getting bigger") rather than compete. Threshold is in
// seconds, not fraction, so it stays "five seconds left" whether fareSeconds is the shipped 60 or
// something the debug panel has tuned to 20.
//
// Amplitude and frequency chosen against the ring's ~25px play-zoom size: 15% scale is a visible
// twitch there without spilling far enough to overlap adjacent lanes, and ~3.5Hz is fast enough to
// read as urgency without turning into a strobe.
const PULSE_BELOW_S = 5;
const PULSE_HZ = 3.5;
const PULSE_AMPLITUDE = 0.15;

/**
 * A flat annulus built as an explicit triangle list in sweep order.
 *
 * THREE.RingGeometry's vertex order isn't guaranteed to run cleanly around the circle, and this
 * needs setDrawRange to carve an arc that shrinks clockwise from twelve o'clock. Building it by
 * hand makes draw order and sweep order the same thing.
 */
function sweepAnnulus(inner, outer) {
  const positions = new Float32Array(SEGMENTS * 6 * 3);
  let v = 0;

  const at = (radius, angle) => [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
  const push = (p) => { positions[v++] = p[0]; positions[v++] = p[1]; positions[v++] = p[2]; };

  for (let k = 0; k < SEGMENTS; k++) {
    const a0 = START_ANGLE + (k / SEGMENTS) * Math.PI * 2;
    const a1 = START_ANGLE + ((k + 1) / SEGMENTS) * Math.PI * 2;
    const i0 = at(inner, a0);
    const o0 = at(outer, a0);
    const i1 = at(inner, a1);
    const o1 = at(outer, a1);
    push(i0); push(o0); push(o1);
    push(i0); push(o1); push(i1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export function createTimerRing(scene) {
  const geometry = sweepAnnulus(RING.inner, RING.outer);

  const mesh = new THREE.Mesh(
    geometry,
    // Always drawn on top. The taxi and the rider both duck behind buildings constantly at this
    // camera angle, and a clock you cannot see is worthless — correctness about occlusion loses
    // to legibility here.
    new THREE.MeshBasicMaterial({
      color: urgencyColorFor(1).clone(),
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.renderOrder = 9;
  mesh.visible = false;

  // The unfilled remainder of the circle, dimmed. Without it a half-drained arc looks like a
  // crescent floating beside its owner rather than a ring centred on it — the geometry was always
  // concentric, but with only part of the circle drawn the eye reads the arc's mass as the centre.
  const track = new THREE.Mesh(
    sweepAnnulus(RING.inner, RING.outer),
    new THREE.MeshBasicMaterial({
      color: TRACK,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  track.renderOrder = 8;   // just beneath the live arc
  mesh.add(track);         // child, so position/visibility follow the arc for free

  // A full circle, not a swept arc: the rim belongs to the ring as an object, so it stays whole
  // while the arc inside it drains. Beneath the track, which paints over everything but the edges.
  const outline = new THREE.Mesh(
    sweepAnnulus(RING.inner - OUTLINE_W, RING.outer + OUTLINE_W),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  outline.renderOrder = 7;
  mesh.add(outline);

  scene.add(mesh);

  const anchor = new THREE.Vector3();
  const from = new THREE.Vector3();
  let transfer = -1;
  let pulseTime = 0;

  function resetPulse() {
    pulseTime = 0;
    mesh.scale.setScalar(1);
  }

  function placeAt(x, z, y = KERB_H + 0.05) {
    anchor.set(x, y, z);
    mesh.position.copy(anchor);
    mesh.visible = true;
    transfer = -1;
    resetPulse();
  }

  function beginTransfer() {
    from.copy(mesh.position);
    transfer = 0;
  }

  function update(dt, target, fraction, secondsLeft = Infinity) {
    if (!mesh.visible) return;

    anchor.set(target.x, target.y ?? KERB_H + 0.05, target.z);

    if (transfer >= 0) {
      transfer += dt / TRANSFER_TIME;
      const t = Math.min(1, transfer);
      const eased = 1 - (1 - t) ** 3;
      mesh.position.lerpVectors(from, anchor, eased);
      mesh.position.y += Math.sin(eased * Math.PI) * 1.6;
      if (t >= 1) transfer = -1;
    } else {
      mesh.position.copy(anchor);
    }

    const clamped = Math.max(0, Math.min(1, fraction));
    geometry.setDrawRange(0, Math.round(clamped * SEGMENTS) * 6);
    mesh.material.color.copy(colourFor(clamped));

    if (secondsLeft <= PULSE_BELOW_S) {
      pulseTime += dt;
      const wave = 0.5 + 0.5 * Math.sin(pulseTime * PULSE_HZ * Math.PI * 2);
      mesh.scale.setScalar(1 + PULSE_AMPLITUDE * wave);
    } else if (pulseTime !== 0) {
      resetPulse();
    }
  }

  return {
    mesh,
    placeAt,
    beginTransfer,
    update,
    hide: () => { mesh.visible = false; transfer = -1; resetPulse(); },
    isTransferring: () => transfer >= 0,
  };
}

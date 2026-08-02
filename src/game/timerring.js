import * as THREE from 'three';
import { KERB_H } from '../city/ground.js';

// The fare's clock, as a physical object.
//
// It belongs to the *fare*, not to a marker: it sits under the rider while they wait, then flies
// to the taxi when they get in. The clock does not restart at pickup — one deadline covers spawn
// all the way to drop-off, which is where the difficulty of the game lives.

// Sized to sit just outside the taxi's selection pool. These used to be imported from the taxi,
// back when it wore a ring of its own; the ring shape belongs to fares now.
const RING = { inner: 2.35 * 1.18, outer: 3.05 * 1.18 };

const SEGMENTS = 96;
const TRANSFER_TIME = 0.65;

// Screen-space top. The camera looks down the +X+Z diagonal, so screen-up is world (-1, 0, -1),
// which is this angle. Sweeping from here with increasing theta reads as clockwise on screen.
const START_ANGLE = -Math.PI * 0.75;

const TRACK = new THREE.Color('#16222B');

// Four discrete states, deliberately not interpolated.
//
// A continuous ramp spends most of its life in muddy in-between hues — the old blend read as
// olive through the whole first half — and a colour that changes imperceptibly tells the player
// nothing. Snapping makes each change an event you notice. High chroma so they carry against
// grey asphalt and the dark track beneath.
const STAGES = [
  { above: 0.60, color: new THREE.Color('#26E05A') },   // green
  { above: 0.35, color: new THREE.Color('#FFE12E') },   // yellow
  { above: 0.15, color: new THREE.Color('#FF8C1A') },   // orange
  { above: -1, color: new THREE.Color('#FF2E2E') },     // red
];

export const fareStageColour = (fraction) => STAGES.find((stage) => fraction > stage.above).color;
const colourFor = fareStageColour;

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
  // Matched to the taxi's selection ring in diameter and thickness, so the two read as the same
  // family of object — one says "selected", the other says "this is your clock".
  const geometry = sweepAnnulus(RING.inner, RING.outer);

  const mesh = new THREE.Mesh(
    geometry,
    // Same treatment as the taxi's selection ring: always drawn on top. The taxi and the rider
    // both duck behind buildings constantly at this camera angle, and a clock you cannot see is
    // worthless — correctness about occlusion loses to legibility here.
    new THREE.MeshBasicMaterial({
      color: STAGES[0].color.clone(),
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
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  track.renderOrder = 8;   // just beneath the live arc
  mesh.add(track);         // child, so position/visibility follow the arc for free

  scene.add(mesh);

  const anchor = new THREE.Vector3();
  const from = new THREE.Vector3();
  let transfer = -1;

  function placeAt(x, z, y = KERB_H + 0.05) {
    anchor.set(x, y, z);
    mesh.position.copy(anchor);
    mesh.visible = true;
    transfer = -1;
  }

  function beginTransfer() {
    from.copy(mesh.position);
    transfer = 0;
  }

  function update(dt, target, fraction) {
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
  }

  return {
    mesh,
    placeAt,
    beginTransfer,
    update,
    hide: () => { mesh.visible = false; transfer = -1; },
    isTransferring: () => transfer >= 0,
  };
}

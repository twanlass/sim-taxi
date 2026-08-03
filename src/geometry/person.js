import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { ABOVE_RING } from '../game/timerring.js';

// A blocky rider hailing a cab, and then running to it.
//
// Scale is a deliberate lie: a person next to a 3.4-unit car should be about 1.3 units tall,
// which is two pixels at play zoom. This is a bit over 3, so the figure reads as a person.
//
// Torso + head + hair are one merged mesh sharing a single material; the four limbs are separate
// so the running animation can pivot each one at its hip or shoulder. The right arm's raised
// hail-a-cab pose was the original reason for that separation — running just made it apply to the
// other three limbs too.

const SKIN = '#E8B78C';
const HAIR = '#4A3A2E';
const SHOULDER_Y = 2.25;
const HIP_Y = 1.15;
const LEG_LEN = 1.15;
const ARM_LEN = 1.0;

export function createPerson() {
  const group = new THREE.Group();
  const body = PALETTE.passenger;

  // Torso + head + hair: merged, since none of them articulate.
  const bodyParts = [];
  const box = (w, h, d, x, y, z, col) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, y, z);
    bodyParts.push(bakeColor(geo, new THREE.Color(col)));
  };
  box(1.0, 1.3, 0.6, 0, 1.8, 0, body);          // torso
  box(0.62, 0.62, 0.62, 0, 2.75, 0, SKIN);      // head
  box(0.68, 0.2, 0.68, 0, 3.14, 0, HAIR);       // hair

  const merged = mergeGeometries(bodyParts, false);
  bodyParts.forEach((p) => p.dispose());
  const torso = new THREE.Mesh(merged, propMaterial());
  torso.castShadow = true;
  // The rider stands in the middle of their own timer ring; see ABOVE_RING for why that needs
  // saying out loud.
  torso.renderOrder = ABOVE_RING;
  torso.userData.pickable = 'passenger';
  group.add(torso);

  // Each limb hangs *below* its own origin, so the mesh pivots at the top (hip or shoulder) when
  // rotated. Same trick the old right arm used for its hail-a-cab swing; the other three now share
  // it so a running cycle can move them.
  const limb = (w, h, d, hexCol, x, y) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0, -h / 2, 0);
    const mesh = new THREE.Mesh(bakeColor(geo, new THREE.Color(hexCol)), propMaterial());
    mesh.castShadow = true;
    mesh.renderOrder = ABOVE_RING;
    mesh.userData.pickable = 'passenger';
    mesh.position.set(x, y, 0);
    group.add(mesh);
    return mesh;
  };

  const legL = limb(0.34, LEG_LEN, 0.34, '#3C3A45', -0.26, HIP_Y);
  const legR = limb(0.34, LEG_LEN, 0.34, '#3C3A45', 0.26, HIP_Y);
  const armL = limb(0.26, ARM_LEN, 0.26, body, -0.72, SHOULDER_Y);
  const armR = limb(0.26, ARM_LEN, 0.26, body, 0.72, SHOULDER_Y);

  /** Zero every articulated joint and undo any pose the boarding pass left behind. */
  function rest() {
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    armL.rotation.set(0, 0, 0);
    armR.rotation.set(0, 0, 0);
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.setScalar(1);
    group.visible = true;
  }

  /**
   * Hailing: right arm up and swinging, feet planted.
   *
   * Replaces an earlier hop-in-place. Bouncing read as impatience or idling; a raised, waving arm
   * says specifically "I want that taxi", which is the one thing the figure exists to communicate.
   */
  function wave(t) {
    // Left arm and legs stay at rest; the whole point of the wave is that only the raised right
    // arm moves. Reset them so boarding → waiting on a slot reuse doesn't leave a running pose.
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    armL.rotation.set(0, 0, 0);
    group.position.set(0, 0, 0);
    group.rotation.x = 0;
    group.scale.setScalar(1);

    armR.rotation.set(0, 0, 2.15 + Math.sin(t * 7) * 0.3);
    group.rotation.y = Math.sin(t * 0.9) * 0.25;   // slight turn, as if scanning for a cab
  }

  /**
   * Boarding: run from the kerb to the taxi and then jump into it.
   *
   * `t` is 0..1 across the whole animation. `dx`/`dz` are the horizontal offset from the rider's
   * starting world position to the taxi's, so the figure's local translation ends up right on top
   * of the car. The character's local +Z is treated as forward — leg swing on `rotation.x` moves
   * them along that axis, so the group is yawed to point +Z at the taxi and the limbs cycle in
   * body-local space.
   */
  function board(t, dx, dz) {
    const RUN_END = 0.7;
    const running = t < RUN_END;

    // Face the taxi. atan2(dx, dz) so (dx=0, dz=+1) → yaw 0, i.e. local +Z aligns with the target.
    group.rotation.y = Math.atan2(dx, dz);

    if (running) {
      const stride = t / RUN_END;
      // Fast cadence — this is a sprint from a standing wave, not a stroll.
      const cadence = t * 22;
      const legSwing = Math.sin(cadence) * 0.95;
      const armSwing = Math.sin(cadence) * 0.7;

      // Legs and arms cycle in opposition; opposite arm to opposite leg.
      legL.rotation.set(legSwing, 0, 0);
      legR.rotation.set(-legSwing, 0, 0);
      armL.rotation.set(-armSwing, 0, 0);
      armR.rotation.set(armSwing, 0, 0);

      // Slight forward lean and a body bob keyed to the leg cadence, so the run has weight.
      group.rotation.x = -0.22;
      const bob = Math.abs(Math.sin(cadence)) * 0.18;
      group.position.set(dx * stride, bob, dz * stride);
    } else {
      const jump = (t - RUN_END) / (1 - RUN_END);
      // A cheat: slide the last 15% during the jump so they land *on* the car, not next to it.
      const slide = 1 + 0.15 * jump;
      // Arc up ~roof-height (car cabin roof is ~2.05 local, TAXI_SCALE 1.18 → ~2.4 world). Peak
      // slightly above so the tuck reads before the shrink swallows them.
      const arcY = Math.sin(jump * Math.PI) * 1.6 + jump * 0.9;

      // Tuck: knees pulled up, arms swung back for a hop-in.
      legL.rotation.set(-1.35, 0, 0);
      legR.rotation.set(-1.35, 0, 0);
      armL.rotation.set(0.6, 0, 0);
      armR.rotation.set(0.6, 0, 0);
      group.rotation.x = -0.4;
      group.position.set(dx * slide, arcY, dz * slide);

      // Shrink toward vanish as they drop into the cabin — the roof isn't a real hole, but a
      // scale-down + arc reads as "in".
      group.scale.setScalar(1 - jump * 0.7);
    }
  }

  rest();
  wave(0);
  return { group, wave, board, rest };
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

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
    mesh.userData.pickable = 'passenger';
    mesh.position.set(x, y, 0);
    group.add(mesh);
    return mesh;
  };

  const legL = limb(0.34, LEG_LEN, 0.34, '#3C3A45', -0.26, HIP_Y);
  const legR = limb(0.34, LEG_LEN, 0.34, '#3C3A45', 0.26, HIP_Y);
  const armL = limb(0.26, ARM_LEN, 0.26, body, -0.72, SHOULDER_Y);
  const armR = limb(0.26, ARM_LEN, 0.26, body, 0.72, SHOULDER_Y);

  // Every mesh on the figure carries its own material (torso + four limbs), so the exit fade can
  // dim all of them together. Collected up front rather than walked from `group.children` on every
  // frame — the set is fixed for the lifetime of the person.
  const meshes = [torso, legL, legR, armL, armR];

  /**
   * Set the whole figure's opacity. `1` returns the meshes to opaque (no blend cost).
   *
   * `material.transparent` and `depthWrite` are shader-define switches — flipping them at
   * runtime does nothing until `needsUpdate` triggers a program recompile. The old version
   * changed `opacity` but the material stayed opaque, so the rider never faded and popped off
   * when `visible` finally flipped. Track the last-set flag to only invalidate on transitions.
   */
  function setOpacity(a) {
    for (const mesh of meshes) {
      const opaque = a >= 1;
      const wasTransparent = mesh.material.transparent;
      if (opaque === wasTransparent) {
        mesh.material.transparent = !opaque;
        mesh.material.depthWrite = opaque;
        mesh.material.needsUpdate = true;
      }
      mesh.material.opacity = a;
    }
  }

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
    setOpacity(1);
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

  /**
   * Exiting: hop out of the taxi, run to the kerb, then fade out.
   *
   * The mirror of `board`. `t` is 0..1 across the whole animation. `dx`/`dz` are the horizontal
   * offset from the rider's local origin (parked at the kerb corner) to the taxi they climb out of,
   * so at `t = 0` the figure is on top of the car and at the run's end they are back at the origin.
   */
  function exit(t, dx, dz) {
    const HOP_END = 0.25;      // brief arc out of the cabin onto the road
    const RUN_END = 0.75;      // sprint from the taxi to the kerb
    // Face away from the taxi — the person walks toward the kerb origin, so local +Z is (-dx,-dz).
    group.rotation.y = Math.atan2(-dx, -dz);

    if (t < HOP_END) {
      // Exactly `board`'s jump section played backwards. `jump` runs 1→0 across the hop, so the
      // sub-expressions (slide 1.15→1.0, arc from 0.9 back down through the sine to 0, tuck
      // relaxing, scale 0.3→1.0) match the boarding landing frame-for-frame in reverse.
      const jump = 1 - t / HOP_END;
      const slide = 1 + 0.15 * jump;
      const arcY = Math.sin(jump * Math.PI) * 1.6 + jump * 0.9;
      legL.rotation.set(-1.35 * jump, 0, 0);
      legR.rotation.set(-1.35 * jump, 0, 0);
      armL.rotation.set(0.6 * jump, 0, 0);
      armR.rotation.set(0.6 * jump, 0, 0);
      group.rotation.x = -0.4 * jump;
      group.position.set(dx * slide, arcY, dz * slide);
      group.scale.setScalar(1 - jump * 0.7);
      setOpacity(1);
    } else if (t < RUN_END) {
      // Straight sprint from the car back to the kerb, cycling arms and legs in opposition — same
      // shape as board(), just running the position from (dx, dz) → (0, 0) instead of the reverse.
      const stride = 1 - (t - HOP_END) / (RUN_END - HOP_END);
      const cadence = t * 22;
      const legSwing = Math.sin(cadence) * 0.95;
      const armSwing = Math.sin(cadence) * 0.7;
      legL.rotation.set(legSwing, 0, 0);
      legR.rotation.set(-legSwing, 0, 0);
      armL.rotation.set(-armSwing, 0, 0);
      armR.rotation.set(armSwing, 0, 0);
      group.rotation.x = -0.22;
      const bob = Math.abs(Math.sin(cadence)) * 0.18;
      group.position.set(dx * stride, bob, dz * stride);
      group.scale.setScalar(1);
      setOpacity(1);
    } else {
      // On the kerb, settling out of the run and fading. Opacity does the vanish, not scale — a
      // shrink here would read as sinking into the pavement, but a fade reads as "on their way".
      const fade = (t - RUN_END) / (1 - RUN_END);
      legL.rotation.set(0, 0, 0);
      legR.rotation.set(0, 0, 0);
      armL.rotation.set(0, 0, 0);
      armR.rotation.set(0, 0, 0);
      group.rotation.x = 0;
      group.position.set(0, 0, 0);
      group.scale.setScalar(1);
      setOpacity(Math.max(0, 1 - fade));
    }
  }

  rest();
  wave(0);
  return { group, wave, board, exit, rest };
}

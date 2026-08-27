// Shrink-and-fade for wrecked bodywork. Both cars in a crash — the taxi and the one it hit — are
// handed here on the impact frame and collapse into their own explosions.
//
// It exists because the wreck used to *cut*. `taxiGroup.visible = false` fired on the impact
// frame, a frame before the fireball had grown big enough to hide anything, so the eye read a car
// blinking out and then, separately, a bang. Collapsing the shell under the flames instead makes
// it one event: the car is consumed rather than deleted.
//
// Stepped with the frame's already-scaled dt, so it stretches out under the crash slow-mo
// alongside the debris and the smoke instead of running at wallclock speed through a slowed shot.
// At SLOW_MO_MIN that turns 0.34s of sim into a bit under two seconds on screen — which is the
// point, since that is exactly how long the fireball is at its biggest.
//
// A shell can also be given the momentum it had when it stopped being a car — `drift` and `spin` in
// `take`, on the closed-form drag in util/carry.js. That is the *most* visible half of the crash's
// momentum, because a shell is a recognisable object where the fireball around it is an
// abstraction: a car that freezes on the spot and collapses reads as a car that stopped, however
// much its explosion is moving. Both are optional and both default to nothing, because the passing
// lab wants exactly the old behaviour — there the useful thing about a wreck is where it happened.

import * as THREE from 'three';
import { carryTravel } from '../util/carry.js';

const VANISH_TIME = 0.34;

const UP = new THREE.Vector3(0, 1, 0);

export function createVanish() {
  // Scratch for the spin, which is applied as a world-Y rotation *premultiplied* onto the pose the
  // shell was caught in rather than by writing `rotation.y`. A shell arrives holding a quaternion
  // decomposed out of a car's body matrix — corner lean, pitch rock and all — and the Euler that
  // comes back out of it is in XYZ order, where `.y` is not the car's yaw. Premultiplying is
  // order-independent and needs to know nothing about the pose it is turning.
  const yawQuat = new THREE.Quaternion();
  const entries = [];

  /**
   * Take over an object's scale and its materials' opacity. Nothing is ever restored: a wreck
   * ends the run, and Retry reloads the page.
   */
  function take(object, options = {}) {
    if (!object) return;
    const {
      duration = VANISH_TIME,
      driftX = 0,     // u/s along world x, spent against CARRY_DRAG
      driftZ = 0,     // u/s along world z
      spin = 0,       // rad/s about world y, on the same curve
    } = options;
    // A Set, not an array: a wrecked ambient car's body and both its front wheels share one
    // material, and stepping the same opacity three times a frame is just noise.
    const materials = new Set();
    object.traverse((node) => {
      const list = Array.isArray(node.material) ? node.material : (node.material ? [node.material] : []);
      for (const material of list) {
        // The taxi's oversized pick volume is already invisible — there is nothing to fade, and
        // switching it to a transparent pass would cost a shader recompile for nothing.
        if (!material.visible) continue;
        material.transparent = true;
        material.depthWrite = false;
        // `transparent` is part of the program cache key, so flipping it at runtime needs the
        // recompile flag. One recompile, on the frame a run ends.
        material.needsUpdate = true;
        materials.add(material);
      }
    });
    entries.push({
      object,
      materials,
      base: object.scale.clone(),
      // Where and how it was pointing on the frame it was handed over. Every frame below is
      // `from + drift × carryTravel(age)` off these rather than an accumulation, so a shell steps
      // the same distance whether the crash slow-mo is running at 0.18× or the shot tool is
      // stepping it by hand at a fixed 1/60.
      from: object.position.clone(),
      pose: object.quaternion.clone(),
      driftX,
      driftZ,
      spin,
      age: 0,
      t: 0,
      duration,
    });
  }

  function update(dt) {
    for (let k = entries.length - 1; k >= 0; k--) {
      const entry = entries[k];
      entry.age += dt;
      entry.t = Math.min(1, entry.t + dt / entry.duration);

      // Still moving while it comes apart. The drift is the wreck's momentum (util/carry.js) and
      // the spin is the shove that went with it — both on the same decaying curve, so the shell
      // slews hardest in the frames the fireball is opening around it and has all but stopped by
      // the time there is nothing left of it to watch.
      if (entry.driftX || entry.driftZ || entry.spin) {
        const drift = carryTravel(entry.age);
        entry.object.position.set(
          entry.from.x + entry.driftX * drift,
          entry.from.y,
          entry.from.z + entry.driftZ * drift,
        );
        if (entry.spin) {
          entry.object.quaternion.copy(entry.pose);
          entry.object.quaternion.premultiply(yawQuat.setFromAxisAngle(UP, entry.spin * drift));
        }
      }

      // The fade leads the collapse: halfway through, the shell is still three-quarters size but
      // only a quarter opaque. Matching the two curves left a small, solid, brightly lit nugget
      // riding the middle of the fireball right up to the last frame.
      const shrink = 1 - entry.t * entry.t;
      const fade = (1 - entry.t) * (1 - entry.t);
      entry.object.scale.set(entry.base.x * shrink, entry.base.y * shrink, entry.base.z * shrink);
      for (const material of entry.materials) material.opacity = fade;

      if (entry.t >= 1) {
        entry.object.visible = false;
        entries.splice(k, 1);
      }
    }
  }

  /** For the headless checks — how many shells are still collapsing. */
  const pending = () => entries.length;

  return { take, update, pending };
}

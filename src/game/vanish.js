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

const VANISH_TIME = 0.34;

export function createVanish() {
  const entries = [];

  /**
   * Take over an object's scale and its materials' opacity. Nothing is ever restored: a wreck
   * ends the run, and Retry reloads the page.
   */
  function take(object, duration = VANISH_TIME) {
    if (!object) return;
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
    entries.push({ object, materials, base: object.scale.clone(), t: 0, duration });
  }

  function update(dt) {
    for (let k = entries.length - 1; k >= 0; k--) {
      const entry = entries[k];
      entry.t = Math.min(1, entry.t + dt / entry.duration);

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

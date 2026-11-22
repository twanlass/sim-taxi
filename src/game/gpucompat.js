/**
 * The WebGPU port's worklist, enforced at run time.
 *
 * three's WebGPURenderer draws node materials. A built-in material (Lambert, Phong, Basic...) is
 * converted on the fly, but two kinds of thing the WebGL game is full of are not:
 *
 *   - a `ShaderMaterial` (hand-written GLSL) cannot be converted at all, and a mesh wearing one
 *     throws inside the pipeline build, which loses the device rather than skipping the mesh;
 *   - an `onBeforeCompile` patch is silently ignored, so the mesh draws, without its patch.
 *
 * Until each one has a TSL twin this hides the first kind and counts the second, so the game runs
 * on WebGPU from the first commit of the port and what is missing is a list rather than a crash.
 * `__taxi.unported()` prints it. The list is empty when the port is done, and this file goes.
 */
const hidden = new Map();
const unpatched = new Map();
const seen = new WeakSet();

const nameOf = (o) => {
  for (let p = o; p; p = p.parent) if (p.name) return p.name;
  return o.type;
};

// Meshes whose whole shape is their patch: a plain quad whose fragment shader draws the plume or
// the beam in its alpha. Unpatched they are opaque white rectangles standing in the street, which
// is worse than their absence. Named here until each is ported.
const SHAPED_BY_PATCH = new Set(['manhole-steam', 'billboard-beams', 'boat-wake']);

function hide(o) {
  // Hidden for good: a later `visible = true` from the game would hand the renderer a material it
  // throws on, or bring the white rectangle back.
  Object.defineProperty(o, 'visible', { get: () => false, set: () => {}, configurable: true });
  hidden.set(nameOf(o), (hidden.get(nameOf(o)) ?? 0) + 1);
}

/** Walk `scene` once for anything new. Cheap to call again: objects already judged are skipped. */
export function gpuCompat(scene) {
  scene.traverse((o) => {
    // Every call, not once: the city's entrance hands out its depth materials when it starts.
    if (o.customDepthMaterial && !o.customDepthMaterial.isNodeMaterial) {
      o.customDepthMaterial = undefined;
      unpatched.set(`${nameOf(o)} (shadow depth)`, (unpatched.get(`${nameOf(o)} (shadow depth)`) ?? 0) + 1);
    }
    if (o.customDistanceMaterial && !o.customDistanceMaterial.isNodeMaterial) o.customDistanceMaterial = undefined;
    if (seen.has(o)) return;
    seen.add(o);
    const materials = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of materials) {
      if (m.isNodeMaterial) {
        // A ported material says what it still lacks.
        for (const what of m.userData.unported ?? []) {
          const key = `${nameOf(o)}: ${what}`;
          unpatched.set(key, (unpatched.get(key) ?? 0) + 1);
        }
        continue;
      }
      if (m.isShaderMaterial || m.isRawShaderMaterial) {
        hide(o);
      } else if (SHAPED_BY_PATCH.has(nameOf(o))) {
        hide(o);
      } else if (m.onBeforeCompile && m.onBeforeCompile !== Object.getPrototypeOf(m).onBeforeCompile) {
        unpatched.set(nameOf(o), (unpatched.get(nameOf(o)) ?? 0) + 1);
      }
    }
  });
}

export function unported() {
  return { hidden: Object.fromEntries(hidden), unpatched: Object.fromEntries(unpatched) };
}

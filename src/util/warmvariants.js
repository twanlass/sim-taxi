/**
 * The other states a material is drawn in, for the boot's warm-up (game/warmup.js) to draw too.
 *
 * Under WebGPURenderer a pipeline is built per *state* as well as per shader: `transparent`,
 * `depthWrite`, blending, side, and which way round the mesh is wound are all in three's pipeline
 * key (`WebGPUBackend.getRenderCacheKey`). WebGL keeps those as GL state and switches them for
 * free. So a rider that fades as they get in, or the city going back to opaque when its entrance
 * lands, costs nothing there and builds a pipeline here, on the frame it happens: measured
 * headless, the entrance landing built 12 at once, four seconds into the run.
 *
 * Anything that changes such a state mid-run says so here, and the warm-up draws a second frame
 * with every one of them switched over. Harmless on WebGL, where the second frame is not drawn.
 */
const variants = [];

/** `apply()` switches something to its other state for one warm-up frame; `restore()` puts it back. */
export function alsoWarm(apply, restore) {
  variants.push({ apply, restore });
}

/** A material that is also drawn with these properties (`{ transparent, depthWrite }`). */
export function alsoWarmAs(material, state) {
  let was = null;
  alsoWarm(() => {
    was = Object.fromEntries(Object.keys(state).map((key) => [key, material[key]]));
    Object.assign(material, state);
    // Everything that fades this way flips with `needsUpdate` (it has to, on WebGL), and under
    // WebGPU that rebuilds the nodes — where `transparent` picks between writing alpha 1 and a
    // discard at alpha 0. Without the same nudge here the warm-up draws the transparent *state* on
    // the opaque *shader*, which is a pipeline nothing in the run ever asks for: the roadworks'
    // stand-ins warmed three and the works then built five of their own, 34 characters apart.
    material.needsUpdate = true;
  }, () => {
    Object.assign(material, was);
    material.needsUpdate = true;
  });
  return material;
}

let kept = null;

/** Draw once more with every variant switched over. A no-op with none registered. */
export function drawVariants(draw) {
  if (!variants.length) return;
  // Before anything flips: the flip itself is what releases the first state's node builds.
  pinWarmedNodes();
  for (const variant of variants) variant.apply();
  try {
    // three redraws a shadow map once per *frame id* per camera (`ShadowNode.updateBefore`), and the
    // id only moves on its own rAF tick — so a second draw inside the same task skips the shadow
    // pass, and every variant's shadow pipeline was left for the run to build. Tick it by hand.
    kept?._nodes?.nodeFrame?.update();
    draw();
  } finally {
    for (const variant of variants) variant.restore();
  }
}

/**
 * Stop three throwing a pipeline away the moment nothing is wearing it.
 *
 * three counts the render objects on each pipeline and drops it from its cache at zero
 * (`Pipelines._releasePipeline`) — and a material changing state moves its object from one pipeline
 * to another, so the count hits zero on every flip. That makes the warm-up above self-defeating: it
 * builds the transparent variant, restores the material, and three releases what was just built.
 * Measured on the garage door through the entrance wave: the same stages and the same state key
 * built at the warm-up, built again when the wave started, and a third time when it landed.
 *
 * Both caches are keyed on content (shader source, render state), so keeping everything is bounded
 * by how many distinct variants the game has — a few hundred — rather than by how long it runs.
 */
export function keepPipelines(renderer) {
  kept = renderer;
  const pipelines = renderer._pipelines;
  if (!pipelines || typeof pipelines._releasePipeline !== 'function') {
    console.warn('keepPipelines: three no longer has the release hooks this patches');
    return;
  }
  pipelines._releasePipeline = () => {};
  pipelines._releaseProgram = () => {};
}

/**
 * Keep every node build the warm-up made, for the rest of the session. Call once it has finished.
 *
 * The same release as the pipelines', one layer up: three caches a material's built nodes (the
 * generated WGSL and its bindings) under a key, counts the render objects using each, and deletes
 * the entry at zero (`Nodes.delete`). A `needsUpdate` flip disposes the render object, so a state
 * only one mesh is ever in is rebuilt on **every** flip back to it — in JavaScript, with no
 * pipeline built and nothing for the device to report. An InstancedMesh is always that mesh: its
 * uuid is in the key. The roadworks' three pools were made at load and warmed in both states, and
 * still rebuilt all six as the works appeared and finished fading, until this.
 *
 * Pinned rather than never released, unlike the pipelines: these keys can carry an object's uuid,
 * so keeping every one would grow with each instanced mesh a run creates and frees.
 */
export function pinWarmedNodes() {
  const cache = kept?._nodes?.nodeBuilderCache;
  if (!cache) return;
  for (const state of cache.values()) state.usedTimes += 1;
}

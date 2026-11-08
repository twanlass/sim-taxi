/**
 * One frame of everything, drawn at boot so the run never pays for anything's first draw.
 *
 * `renderer.compile()` links every program the scene needs, and on a desktop that is the whole
 * cost of a first sight. On iOS it is not: WebKit runs WebGL on Metal through ANGLE, and a Metal
 * pipeline is only built when a program is first *drawn* — per vertex layout, blend state and
 * render target, so the same program pays again in the shadow map, the AO prepass and the bloom.
 * Geometry is the same story: three uploads a mesh's buffers on its first draw, not when it is
 * built. So a TestFlight build that had linked everything at boot still hitched, intermittently,
 * for the first run only (Tyler, 2026-10-24: "on the second play it's much smoother"): every block
 * the camera reached for the first time, every effect pool's first use, the garbage truck turning
 * up, each one paying on the frame it appeared.
 *
 * So draw it all once, behind the load: every mesh with culling off, every hidden one shown, through
 * the real render path so every pass and every target is the one the run will use. Then put it all
 * back. Two things are held still while that happens, both because a change to them is a change to
 * every lit material's program key (CLAUDE.md, "a light under a hidden group"): a light that was
 * not being counted stays uncounted, and nothing that is already showing is touched.
 *
 * A pooled object at scale 0 or with an instance count of 0 draws nothing and so builds nothing;
 * that is the honest limit of this, and `tools/links.mjs --tour` is what says how much is left.
 */
export function warmFirstDraws(scene, draw, roots = [scene]) {
  const lit = new Set();
  scene.traverseVisible((o) => { if (o.isLight) lit.add(o); });

  const culled = [];
  const shown = [];
  for (const root of roots) root.traverse((o) => {
    if (o.isLight) return;
    if (o.frustumCulled) { o.frustumCulled = false; culled.push(o); }
    if (!o.visible) { o.visible = true; shown.push(o); }
  });
  const dimmed = [];
  scene.traverseVisible((o) => {
    if (o.isLight && !lit.has(o) && o.visible) { o.visible = false; dimmed.push(o); }
  });

  try {
    draw();
  } finally {
    for (const o of culled) o.frustumCulled = true;
    for (const o of shown) o.visible = false;
    for (const o of dimmed) o.visible = true;
  }
  return { culled: culled.length, shown: shown.length };
}

/**
 * The same warm-up in `steps` slices, a frame apart, so the load bar has something true to say.
 *
 * One `warmFirstDraws` over the whole scene is one long synchronous task — measured headless at
 * 3.3 s of a 5 s boot (SwiftShader, so the split is the useful part, not the seconds), and on a
 * phone it is the bulk of a *first* launch after a new build, because that is when iOS has no
 * Metal pipelines cached and every one of them is built here. Nothing can move on screen while it
 * runs except a compositor animation, so the bar could only guess. Sliced, the bar moves for real.
 *
 * A slice is a run of the scene's top-level children, and it is drawn **alone**: every mesh outside
 * it is hidden for its frame, so the cost of the city's own first draw is spread across the slices
 * too instead of all landing on the first (the first version left the rest of the scene drawing
 * normally beside each slice, and slice one took 3.3 s of 3.6). Only meshes are hidden, never a
 * group, so no light leaves the count and no program key moves (CLAUDE.md, "a light under a hidden
 * group"). Every slice still goes through the full render path, so every pass builds every
 * pipeline it will need — the coverage is the one-frame warm-up's, just in pieces.
 *
 * Slices are balanced on **new materials**, not meshes: a pipeline is built per program and state,
 * so a material already drawn by an earlier slice costs next to nothing the second time.
 *
 * `onStep(from, to)` is called before each slice draws, with the fraction done before and after
 * it; the draw itself blocks, so whatever is told `to` has to animate there on the compositor.
 */
export async function warmFirstDrawsInSteps(scene, draw, { steps = 10, onStep = () => {}, yieldFrame } = {}) {
  const drawable = (o) => o.isMesh || o.isPoints || o.isLine || o.isSprite;
  const seen = new Set();
  const units = [];
  let total = 0;
  for (const child of scene.children) {
    if (child.isLight) continue;
    let cost = 0;
    let any = false;
    child.traverse((o) => {
      if (!drawable(o)) return;
      any = true;
      for (const m of [].concat(o.material ?? [])) if (!seen.has(m)) { seen.add(m); cost++; }
    });
    if (!any) continue;
    units.push({ child, cost });
    total += cost;
  }
  // Contiguous slices by cumulative cost. A child bigger than one share is a slice of its own.
  const slices = [];
  let slice = [];
  let acc = 0;
  for (const unit of units) {
    slice.push(unit.child);
    acc += unit.cost;
    if (acc >= (total * (slices.length + 1)) / steps && slices.length < steps - 1) {
      slices.push(slice);
      slice = [];
    }
  }
  if (slice.length) slices.push(slice);
  for (let i = 0; i < slices.length; i++) {
    await yieldFrame();
    onStep(i / slices.length, (i + 1) / slices.length);
    const inSlice = new Set(slices[i]);
    const hidden = [];
    for (const child of scene.children) {
      if (inSlice.has(child)) continue;
      child.traverse((o) => { if (drawable(o) && o.visible) { o.visible = false; hidden.push(o); } });
    }
    try {
        warmFirstDraws(scene, draw, slices[i]);
    } finally {
      for (const o of hidden) o.visible = true;
    }
  }
  return slices.length;
}

/**
 * Waits, a frame at a time, for the programs `renderer.compile()` queued to finish linking, telling
 * `onProgress` the fraction done. With `KHR_parallel_shader_compile` the links run in the GPU
 * process while the page stays free — measured headless, they are 2.7 s of the boot, and before
 * this they all landed on the warm-up's first draw as one block, because the first draw is the first
 * call that has to wait for them. Without the extension three reports every program ready at once,
 * this returns on the first frame, and the cost lands on that first draw as it always did.
 * Gives up after `limit` ms rather than hold a load on a driver that never says "done".
 */
export async function awaitPrograms(renderer, { onProgress = () => {}, yieldFrame, limit = 30000 } = {}) {
  const start = performance.now();
  for (;;) {
    const programs = renderer.info.programs ?? [];
    let ready = 0;
    for (const program of programs) if (program.isReady()) ready++;
    onProgress(programs.length ? ready / programs.length : 1);
    if (ready === programs.length || performance.now() - start > limit) return;
    await yieldFrame();
  }
}

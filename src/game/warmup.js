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
export function warmFirstDraws(scene, draw) {
  const lit = new Set();
  scene.traverseVisible((o) => { if (o.isLight) lit.add(o); });

  const culled = [];
  const shown = [];
  scene.traverse((o) => {
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

/**
 * The pixel-art screen — on by default, `?pixel=classic` for the smooth frame, `?pixelsize=` for
 * how many CSS px one art pixel spans (default `PIXEL_SIZE`).
 *
 * **Not a shader pass.** The city is drawn at a low resolution and the browser scales the canvas up
 * with nearest-neighbour filtering (`image-rendering: pixelated`). So it is the same on WebGPU and
 * WebGL, adds no pass and no target, and *removes* work: at 2 CSS px an art pixel, a 3x phone
 * shades 1/36 of the pixels its Ultra frame does and 1/16 of Regular's, in the main pass, the
 * occlusion and the bloom alike. Every render target in the pipeline already follows the drawing
 * buffer (the governor relies on that, game/governor.js), so AO, bloom and the shadow pass carry on
 * untouched, just at the art resolution. The HUD is DOM and stays sharp.
 *
 * The drawing buffer is set through the pixel ratio (`1 / size`) rather than around it, so anything
 * that reads `renderer.getPixelRatio()` to size itself in CSS px (the rain's drops) still comes out
 * right. The budget's ratio cap is pinned to the same number, which leaves the governor and the
 * context recovery with nowhere to go: neither may move it.
 *
 * **The camera is snapped to the art grid, or the city crawls.** A camera that follows the taxi
 * moves by fractions of an art pixel every frame, and at this size every static edge in the city
 * re-quantises as it does: kerbs, windows and roof lines shimmer the whole time the camera moves.
 * So for the render alone the camera is pulled back onto the nearest art-pixel boundary of a grid
 * anchored in the *world* (its position along screen right and screen up, in art pixels, rounded
 * down), and the canvas is slid by CSS the fraction it was pulled — so the picture still pans
 * smoothly, a CSS px at a time on a 1x screen and finer on a phone, while what is drawn in it stays
 * put on the city. The canvas is one art pixel larger than the screen on every side to have room to
 * slide (`setViewOffset` widens the frustum to match), and the camera is put back after the render,
 * so the follow, the picking and every DOM marker projected through it never see the snap.
 *
 * What still moves is what really moves: a car crawls over the pixel grid as it drives, exactly as
 * a sprite does. A zoom (a Loco push-in, a wreck close-up) changes the size of an art pixel in
 * world units and re-quantises everything while it runs; it settles when the zoom does.
 *
 * Picking reads the canvas's rectangle to turn a tap into a ray, and the slid, oversized canvas no
 * longer has the frame's rectangle, so it publishes the one it stands in for (`viewRect`, read by
 * `canvasRect` below).
 */
import * as THREE from 'three';

/**
 * CSS px per art pixel. 2 makes the taxi about 16 art pixels nose to tail at phone play zoom (8.1
 * CSS px a world unit, `PHONE_PX_PER_UNIT`), the size of a classic sprite, and a 390-wide phone 195
 * art pixels across. 3 reads as chunky (130 across, an 11-pixel taxi) and starts losing the riders'
 * pies and the lane paint.
 */
export const PIXEL_SIZE = 2;

/** The canvas's rectangle as the frame sees it: the screen under the pixel look, the element otherwise. */
export function canvasRect(el) {
  return el.viewRect ? el.viewRect() : el.getBoundingClientRect();
}

/**
 * @param renderer  the WebGPURenderer or WebGLRenderer; its canvas is the one that is scaled
 * @param size      CSS px per art pixel
 */
export function createPixelArt(renderer, { size = PIXEL_SIZE } = {}) {
  const canvas = renderer.domElement;
  const ratio = 1 / size;
  const view = { w: 1, h: 1, bw: 1, bh: 1 };
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const saved = new THREE.Vector3();
  let held = null;

  // `pixelated` is the standard spelling and what Safari and Chrome both honour on a canvas;
  // `crisp-edges` is Firefox's.
  canvas.style.imageRendering = 'pixelated';
  if (canvas.style.imageRendering !== 'pixelated') canvas.style.imageRendering = 'crisp-edges';
  canvas.viewRect = () => ({ left: 0, top: 0, width: view.w, height: view.h, right: view.w, bottom: view.h });

  function slide(fx, fy) {
    // The individual `translate` property, not `transform`: the title's blur scales the canvas with
    // a `transform` from the stylesheet, and an inline transform would take that over.
    canvas.style.translate = `${(-size - fx * size).toFixed(3)}px ${(-size + fy * size).toFixed(3)}px`;
  }

  return {
    size,
    ratio,
    /**
     * Size the canvas for a screen of w × h CSS px: whole art pixels, one spare on every side. The
     * width handed to three carries a hair over the whole number so its `floor(width · ratio)`
     * cannot land one short on a ratio like 1/3 that is not exact in binary.
     */
    resize(w, h) {
      view.w = w;
      view.h = h;
      view.bw = Math.ceil(w / size) + 2;
      view.bh = Math.ceil(h / size) + 2;
      renderer.setPixelRatio(ratio);
      renderer.setSize(view.bw * size + 1e-6, view.bh * size + 1e-6);
      slide(0, 0);
    },
    /** Pull `cam` onto the art grid and widen it over the spare border. Pair with `restore`. */
    snap(cam) {
      if (held) return;
      const fullW = view.w / size;
      const fullH = view.h / size;
      cam.setViewOffset(fullW, fullH, -1, -1, view.bw, view.bh);
      held = cam;
      saved.copy(cam.position);
      if (!cam.isOrthographicCamera) { slide(0, 0); return; }
      // World units per art pixel, off the frustum the camera was built with (`camera.js` sets its
      // half-height directly and leaves `zoom` at 1).
      const unit = (cam.top - cam.bottom) / cam.zoom / fullH;
      cam.updateMatrixWorld();
      right.setFromMatrixColumn(cam.matrixWorld, 0);
      up.setFromMatrixColumn(cam.matrixWorld, 1);
      const px = cam.position.dot(right) / unit;
      const py = cam.position.dot(up) / unit;
      const fx = px - Math.floor(px);
      const fy = py - Math.floor(py);
      cam.position.addScaledVector(right, -fx * unit).addScaledVector(up, -fy * unit);
      cam.updateMatrixWorld();
      // The camera moved left by fx, so the picture moved right by fx: slide the canvas back left.
      // Up by fy moved the picture up, so the canvas comes down (CSS y runs down the screen).
      slide(fx, fy);
    },
    restore() {
      if (!held) return;
      held.position.copy(saved);
      held.clearViewOffset();
      held.updateMatrixWorld();
      held = null;
    },
  };
}

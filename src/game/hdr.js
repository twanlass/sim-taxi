import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { emissiveList } from './bloom.js';

/**
 * The other bloom: the whole frame through an `EffectComposer`, in HDR, with tone mapping on.
 *
 * **This is a comparison, not a shipped mode.** `?hdr` turns it on and takes `game/bloom.js`'s
 * place; it exists so the two can be looked at side by side on the same city, because the argument
 * between them is about the *look* and no amount of reasoning settles that.
 *
 * What it costs is the point of having it. Four things, in rough order of how much work they are:
 *
 *   1. **Tone mapping changes every colour in the game.** Every value in `palette.js`, the sky
 *      dome's gradient, `hazeColor()`, the shadow tint and the golden-hour key were picked against
 *      `NoToneMapping` — a straight clamp at 1. ACES rolls the top off and desaturates as it goes,
 *      so the city comes out flatter and cooler than the one that was authored, and getting it
 *      back is a pass over the whole palette rather than an exposure slider. That is the bill.
 *   2. **The frame stops being the default framebuffer.** MSAA has to be bought back as `samples`
 *      on the composer's target, and the stencil buffer the ghost outlines stamp into
 *      (`geometry/ghostoutline.js`) as `stencilBuffer` — two full-size allocations and a resolve
 *      per frame, at RGBA16F, which is ~10.7MB at DPR 2 on a phone. `game/recovery.js` exists
 *      because some GPUs already decline the budget without it.
 *   3. **Crayon and Cartoon Mode break.** Both mix their ink *after* `<colorspace_fragment>`, in
 *      display space, deliberately and documented as such. Three disables in-material tone mapping
 *      and sRGB encode whenever the render target is not the screen — precisely so an `OutputPass`
 *      can do it — so under a composer both are mixing sRGB-encoded constants into linear values.
 *      This module refuses to run with either rather than drawing something wrong quietly.
 *   4. **A luminance threshold is the wrong selector for this game, and this shows it.** The lamps
 *      have to be pushed above the threshold to bloom at all (`prime()` below), and once they are,
 *      so is anything else that gets there — the fare rings, the route band and the taxi's roof
 *      sign are all at 1.0 in the shipped frame. That is not a bug in this pass; it is the reason
 *      `game/bloom.js` uses an explicit draw list instead.
 */

/** Live tuning — the ⚙️ panel. */
export const HDR_DEFAULTS = {
  // Overall exposure into the tone curve. 1.0 is what three defaults to; the city was authored
  // without a curve at all, so this is the one knob that gets it back near where it started.
  exposure: 1.0,
  // UnrealBloomPass's three. `threshold` is in *tone-mapped* luminance, so it sits below 1 even
  // though the lamps are pushed well above it.
  strength: 0.55,
  radius: 0.5,
  threshold: 0.85,
};

/**
 * How far above 1 a lamp has to be written for a threshold to find it — a multiplier applied to
 * the emissive draw list's own materials, on top of whatever `markEmissive` recorded.
 *
 * This is the "what HDR work is needed" answer in one number, and note where it has to be applied:
 * on the lamps' **real** materials, the ones the main render uses, because in this route there is
 * no separate pass to put the headroom in. A `MeshBasicMaterial`'s `color` and a Lambert's
 * `emissiveIntensity` both pass a value over 1 straight through to a half-float target; neither
 * does anything at all on the way to an RGBA8 one, which is why this is inseparable from item 2
 * above.
 */
const LAMP_HEADROOM = 2.2;

/**
 * @param renderer      the one WebGLRenderer
 * @param enabled       false leaves every method a no-op and allocates nothing
 * @param incompatible  names of look modes that cannot run with this — see item 3 above. Non-empty
 *                      means the flag is declined rather than honoured.
 * @param onNotice      called with a one-line summary, for `game/diag.js`
 */
export function createHdr(renderer, { enabled = false, incompatible = [], onNotice = () => {} } = {}) {
  const state = { enabled: false, ...HDR_DEFAULTS };

  if (enabled && incompatible.length) {
    onNotice(`?hdr declined: ${incompatible.join(' and ')} mix ink in display space`);
    enabled = false;
  }

  if (enabled && !(renderer.extensions.has('EXT_color_buffer_half_float')
    || renderer.extensions.has('EXT_color_buffer_float'))) {
    onNotice('?hdr declined: no renderable half-float target');
    enabled = false;
  }

  if (!enabled) {
    return {
      state,
      /** False means "I did not draw the frame" — `main.js` renders it the ordinary way. */
      render: () => false,
      setSize: () => {},
      set: () => {},
      dispose: () => {},
    };
  }

  state.enabled = true;

  // The half of this that is not the composer, and the half that costs the palette.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = state.exposure;

  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Both flags bought back explicitly. Neither is a default: `samples` is what replaces the
  // multisampled back buffer the game normally renders straight into, and `stencilBuffer` is what
  // the ghost outlines' two-pass mask needs — without it the stencil test passes everywhere and
  // the "outline" fills the whole car.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: renderer.getContext().getParameter(renderer.getContext().MAX_SAMPLES) > 0 ? 4 : 0,
    stencilBuffer: true,
    depthBuffer: true,
  });

  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(null, null);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y), state.strength, state.radius, state.threshold,
  );
  composer.addPass(bloomPass);

  // Tone maps and encodes, which is the job three moved out of the materials the moment the frame
  // stopped being the screen. Without it the city renders in linear and comes out washed out.
  composer.addPass(new OutputPass());

  let primed = false;

  /**
   * Give every lamp headroom, once, on the first frame.
   *
   * Deferred rather than done at construction because the draw list is filled while the city is
   * being built, which happens after this module exists. Idempotent by the flag: run twice, every
   * lamp in the game would be four times as bright as it should be, and there is nothing on screen
   * that would say so beyond the picture looking wrong.
   */
  function prime() {
    for (const mesh of emissiveList()) {
      const material = mesh.material;
      if (!material || material.userData.hdrPrimed) continue;
      material.userData.hdrPrimed = true;
      material.toneMapped = true;
      if (material.emissive) material.emissiveIntensity *= LAMP_HEADROOM;
      else material.color.multiplyScalar(LAMP_HEADROOM);
    }
  }

  const drawingBuffer = new THREE.Vector2();
  // Tracked here rather than asked of the composer, which has a `setSize` and no getter.
  let sizedX = size.x;
  let sizedY = size.y;

  return {
    state,

    /**
     * Draw the frame through the composer. Returns true, which is how `main.js` knows not to draw
     * it again — the ordinary path and this one are alternatives, not layers.
     */
    render(scene, camera) {
      if (!primed) { prime(); primed = true; }
      renderPass.scene = scene;
      renderPass.camera = camera;
      // Sized off the drawing buffer every frame, for the reason `game/ssao.js` is: shot mode never
      // resizes but can be re-rendered through `__taxi.redraw()` after the viewport has moved.
      renderer.getDrawingBufferSize(drawingBuffer);
      if (drawingBuffer.x !== sizedX || drawingBuffer.y !== sizedY) {
        sizedX = drawingBuffer.x;
        sizedY = drawingBuffer.y;
        composer.setSize(sizedX, sizedY);
        bloomPass.setSize(sizedX, sizedY);
      }
      composer.render();
      return true;
    },

    /** Live tuning — the ⚙️ panel, and `window.__taxi.hdr`. */
    set(key, value) {
      if (!(key in state)) return;
      state[key] = value;
      if (key === 'exposure') renderer.toneMappingExposure = value;
      else if (key === 'strength') bloomPass.strength = value;
      else if (key === 'radius') bloomPass.radius = value;
      else if (key === 'threshold') bloomPass.threshold = value;
    },

    dispose() {
      composer.dispose();
      target.dispose();
      renderer.toneMapping = THREE.NoToneMapping;
    },
  };
}

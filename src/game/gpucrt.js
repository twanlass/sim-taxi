/**
 * The CRT screen for the WebGPU renderer. The look, its numbers and where they came from are
 * game/crt.js; this is `CRT_FRAGMENT` as nodes, and `state`, `set` and `preset` are the same
 * interface, so the panel and `__taxi.crt` do not know which renderer is drawing.
 *
 * **Not a pass of its own.** The WebGL screen copies the finished canvas to a texture and draws
 * it back through one triangle. Here the frame's last step is already a full-screen pass over a
 * target (the occlusion and the bloom's composite, game/gpuframe.js; or the wet lens after it,
 * game/gpulens.js), so the screen is a wrapper round whatever that pass was going to write: it
 * hands the pass a curved coordinate to work at and shades what comes back. No copy, no extra
 * target and no extra pass, which on WebGL were the whole cost of the effect.
 *
 * So `screen(finish, on)` is called from inside the last pass's fragment:
 *
 *   - `finish({ at, atR, atB })` returns the finished texel, display-encoded and premultiplied, as
 *     that pass computes it. `at` is where on the frame the glass shows (texture coordinates, y
 *     down); `atR` and `atB` are the same pushed out and in along the radius, for the red and blue
 *     of the chromatic aberration. A caller reads the frame's own red and blue there and keeps
 *     everything it computes (occlusion, spill, a drop's bend) from `at`: at the shipped 0.0002
 *     the offset is under half a pixel in the corner of a phone, and the expensive part of the
 *     pass runs once rather than three times.
 *   - `on` is a per-site switch, 0 or 1 in a uniform. While the lens is wet the frame's pass
 *     writes into the lens's target and the lens is the last pass, so the frame's screen is
 *     switched off for that frame: at 0 every term is exactly the identity.
 *
 * Only where the frame has a target to end in: off under MSAA and with `?ao=off`, as the
 * occlusion and the bloom are.
 */
import * as THREE from 'three';
import {
  abs, clamp, dot, float, floor, max, min, mix, mod, normalize, pow, screenCoordinate, screenUV, sin, step,
  uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { CRT_DEFAULTS, CRT_PRESETS } from './crt.js';

/**
 * @param renderer  the WebGPURenderer, for the drawing buffer's size
 * @param still     shot mode: the flicker is pinned at its midpoint, so a screenshot is repeatable
 */
export function createGpuCrt(renderer, { still = false } = {}) {
  const state = { enabled: true, ...CRT_DEFAULTS };
  const start = performance.now();
  const buffer = new THREE.Vector2();

  // `strength` is the master over all six, folded in here as game/crt.js folds it into its uniforms.
  const dial = (key) => uniform(0).onRenderUpdate(() => (state.enabled ? state[key] * state.strength : 0));
  const curvature = dial('curvature');
  const scanline = dial('scanline');
  const vignette = dial('vignette');
  const aberration = dial('aberration');
  const aperture = dial('aperture');
  const flicker = dial('flicker');
  const time = uniform(0).onRenderUpdate(() => (still ? 0 : (performance.now() - start) / 1000));
  // Scanlines and the grille are measured in CSS pixels (game/crt.js says why).
  const cssScale = uniform(1).onRenderUpdate(() => renderer.getPixelRatio());
  const cssHeight = uniform(1).onRenderUpdate(() => renderer.getDrawingBufferSize(buffer).y / renderer.getPixelRatio());

  const flip = (p) => vec2(p.x, float(1).sub(p.y));

  return {
    state,
    set(key, value) {
      if (key in state) state[key] = value;
    },
    preset(name) {
      if (name === 'Default') Object.assign(state, CRT_DEFAULTS);
      else if (CRT_PRESETS[name]) Object.assign(state, CRT_PRESETS[name]);
    },
    dispose() {},

    /** Call inside the last pass's `Fn`. See the note at the top of the file. */
    screen(finish, on = float(1)) {
      // The GLSL's `vUv`: y up, so the line pairs land on the rows they land on there.
      const centred = flip(screenUV).mul(2).sub(1);
      const bow = abs(centred.yx).mul(curvature.mul(on));
      const glass = centred.add(centred.mul(bow).mul(bow)).mul(0.5).add(0.5).toVar();
      const inside = step(0, glass.x).mul(step(glass.x, 1)).mul(step(0, glass.y)).mul(step(glass.y, 1));

      const centre = glass.sub(0.5);
      const dir = normalize(centre.add(0.0001));
      const ab = dir.mul(aberration.mul(on).mul(dot(centre, centre).mul(6).add(1)));
      const at = flip(glass).toVar();
      const texel = vec4(finish({ at, atR: flip(glass.sub(ab)), atB: flip(glass.add(ab)) })).toVar();

      // One line pair per 2 CSS px, on the curved coordinate so the lines bow with the glass.
      const lines = scanline.mul(on);
      const scan = sin(glass.y.mul(cssHeight).mul(Math.PI)).mul(0.5).add(0.5);
      // The grille, one stripe per CSS px: 1.15 on this pixel's own colour, 0.85 on the other two.
      const stripe = mod(floor(screenCoordinate.x.div(cssScale)), 3);
      const mask = vec3(step(stripe, 0.5), step(0.5, stripe).mul(step(stripe, 1.5)), step(1.5, stripe)).mul(0.3).add(0.85);
      const corner = glass.mul(float(1).sub(glass.yx));
      // `max`: off the glass the product is negative, and a negative base is NaN in WGSL.
      const vig = clamp(pow(max(corner.x.mul(corner.y).mul(15), 0), 0.3), 0, 1);
      const wobble = flicker.mul(on);
      const colour = texel.rgb
        .mul(mix(1.0, scan, lines))
        .mul(mix(vec3(1), mask, aperture.mul(on)))
        .mul(mix(1.0, vig, vignette.mul(on)))
        .mul(sin(time.mul(8)).mul(0.5).add(0.5).mul(wobble).sub(wobble.mul(0.5)).add(1))
        // Make-up gain for the light the scanlines took, all of it (game/crt.js has the measurement).
        .div(float(1).sub(lines.mul(0.5)));
      // The frame is premultiplied, so colour can never exceed its own alpha. Off the glass: black.
      return mix(vec4(0, 0, 0, 1), vec4(min(colour, vec3(texel.a)), texel.a), inside);
    },
  };
}

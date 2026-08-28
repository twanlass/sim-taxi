import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { fbm, valueNoise2D } from '../util/rng.js';
import { CRAYON_UNIFORMS } from '../util/geo.js';

/**
 * Crayon Mode — the paper the city is drawn on, and the tooth every stroke is laid into.
 *
 * Three layers make the look, and only the third one lives here:
 *
 *   1. **The line.** `game/ssao.js` already fetches eight half-res depth taps per pixel; it now
 *      folds an edge term out of the taps it has *already fetched* and writes it into the green
 *      channel of a texture nothing was reading. `util/geo.js` inks it into every lit material.
 *   2. **The fill.** The same patch in `util/geo.js` presses the paper's tooth into the shading,
 *      keyed off `gl_FragCoord` — screen space, because `bakeColor()` strips every attribute but
 *      position and normal, and because a drawing wants screen space anyway.
 *   3. **The page.** This file: one tile, and one quad over the whole frame.
 *
 * **No composer, no render target, no second `render()` call.** The overlay is an ordinary object
 * in the main scene whose vertex shader writes clip space directly, so the frame still goes
 * straight to the default framebuffer — MSAA intact, and the stencil buffer the taxi's ghost
 * outline stamps into (`geometry/ghostoutline.js`) never sees a target. That was the whole reason
 * `docs/rendering.md` ruled an `EffectComposer` out, and none of it has changed.
 */

// Where the quad lands in the transparent queue, and the only thing standing between this pass and
// an unreadable game.
//
// Three sorts the transparent queue by `renderOrder`, and the existing ladder is skid marks 2,
// dust 3, the route band 4, the drag handle 5, flames 6, the fare rings 7-9. At 1 the paper covers
// the city and the sky — every opaque object, since the opaque queue is drawn first regardless —
// and *nothing the player reads a number off*. A fare's ring is a clock and its hue is the time
// remaining (`docs/gameplay.md`); a paper tint over it reports the wrong one.
const PAPER_ORDER = 1;

// The tile, in texels. Sampled 1:1 against CSS pixels, so this is also how often it repeats across
// the screen — 256 is about a fifth of a phone's width, far enough apart that the eye reads fibre
// rather than wallpaper, and 256KB of RGBA8 that never changes.
export const PAPER_SIZE = 256;

// Fixed, and not the city's seed. The page does not reseed when the city does: a screenshot pair
// taken across a change to the buildings has to differ by the buildings.
const PAPER_SEED = 90210;

/**
 * The four channels, and what each is for. Every one is *periodic* at the tile size — a field that
 * doesn't close on itself puts a hard seam every 256px across the picture, which reads as a grid
 * over the whole city.
 *
 *   r — tooth, ~2px cells. The grain a crayon skips over. The busiest channel and the one the
 *       fill patch spends most of its amplitude on.
 *   g — fibre, ~32px blotches. What makes a page look like a page rather than like film grain.
 *   b — an uncorrelated per-texel draw. Sampled at a *low* screen frequency it becomes a smooth
 *       wander, which is what bends the ink line off straight.
 *   a — long fibres, stretched across the page. Anisotropic on purpose: paper is pressed, and the
 *       fibres in it lie down.
 */
const TOOTH_FREQ = 128;    // lattice cells across the tile — 256/128 = 2px cells
const FIBRE_FREQ = 8;      // 32px
const FIBRE_FREQ_Y = 40;   // the long fibres, across the short axis

/** Push a 0..1 field away from its middle. `k = 1` is a no-op; above it, more contrast. */
function contrast(v, k) {
  return Math.min(1, Math.max(0, 0.5 + (v - 0.5) * k));
}

/**
 * Bake the page.
 *
 * Pure, deterministic and free of any GL call, so `tools/probe.mjs` can assert it in node — which
 * is the whole reason it is a function rather than a few lines inside `createCrayon`.
 */
export function bakePaper(size = PAPER_SIZE, seed = PAPER_SEED) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      const tooth = fbm(u * TOOTH_FREQ, v * TOOTH_FREQ, seed, {
        octaves: 2, period: TOOTH_FREQ,
      });
      const fibre = fbm(u * FIBRE_FREQ, v * FIBRE_FREQ, seed + 7, {
        octaves: 3, period: FIBRE_FREQ,
      });
      // Exactly one lattice point per texel, so this is the hash itself rather than an
      // interpolation of it — uncorrelated between neighbours, which is what a wander wants
      // before the sampler smooths it.
      const dither = valueNoise2D(x, y, seed + 19, size);
      const streak = fbm(u * FIBRE_FREQ * 0.5, v * FIBRE_FREQ_Y, seed + 31, {
        octaves: 2, period: 0,
      });

      const i = (y * size + x) * 4;
      data[i] = Math.round(contrast(tooth, 1.6) * 255);
      data[i + 1] = Math.round(contrast(fibre, 1.35) * 255);
      data[i + 2] = Math.round(dither * 255);
      data[i + 3] = Math.round(contrast(streak, 1.2) * 255);
    }
  }
  return data;
}

/** Defaults, all live on the ⚙️ panel. Every one of these was looked at rather than guessed. */
export const CRAYON_DEFAULTS = {
  // How hard the tooth presses into the fill. Weighted to the mid-tones in the shader, so this is
  // the amplitude at l = 0.5 and nothing at either end.
  grain: 0.10,
  // The coarse fibre, over the top of it. Much gentler: it is there to stop the tooth reading as
  // uniform noise, not to be seen on its own.
  blotch: 0.06,
  // Luminance quantisation, off by default. It is the one lever here that fights the existing
  // look — this city's whole lighting idea is one lit face per building, and a hard step across
  // that face flattens the very thing the sun is doing.
  quantize: 0,
  // Ink. Full strength on a silhouette, which is what the edge term saturates at.
  line: 0.70,
  // How far the ink lookup wanders off the true edge, in CSS pixels. Under about one it reads as
  // a soft edge rather than a drawn one; past about three the line stops tracking the shape.
  wobble: 1.4,
  // The page itself, as an alpha over the whole frame.
  paper: 0.10,
  // The sketchpad edge — pressed a little harder at the corners, the way a page shades where a
  // hand rests on it.
  vignette: 0.10,
  // Hand-drawn animation, in steps a second. **This number is the difference between "drawn" and
  // "broken".** Left at the frame rate it is television static; left at zero it is a decal stuck
  // to the screen. Ten is about where an eye reads a redrawn line.
  boilHz: 10,
};

// Clip space written directly, the same trick `ssao.js`'s fullscreen quad uses: no matrices, so
// the quad covers the frame whatever the camera is doing and never has to be resized.
const OVERLAY_VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const OVERLAY_FRAGMENT = /* glsl */ `
uniform sampler2D tCrayonPaper;
uniform vec2 uCrayonPaperScale;
uniform vec2 uCrayonBoil;
uniform vec2 uResolution;
uniform vec3 uPaper;
uniform vec3 uFibre;
uniform float uAmount;
uniform float uVignette;

void main() {
  vec2 px = gl_FragCoord.xy;

  // Two fetches, no more. The fine one carries the tooth; the coarse one is the same tile read a
  // quarter as often, which costs nothing extra and gives a second, larger scale of blotch.
  vec4 fine = texture2D(tCrayonPaper, px * uCrayonPaperScale + uCrayonBoil);
  vec4 coarse = texture2D(tCrayonPaper, px * uCrayonPaperScale * 0.25 + uCrayonBoil * 0.37);

  // Fibre first, tooth over it, and the long streaks last at a third of the weight — they are a
  // direction in the page rather than a texture on it.
  float grain = coarse.g * 0.55 + fine.r * 0.45;
  grain = mix(grain, coarse.a, 0.22);

  // The page is a *lerp*, not a multiply, so it lifts the blacks as well as knocking back the
  // whites. Wax on paper has no true black in it and neither should this.
  vec3 page = mix(uFibre, uPaper, grain);

  // Sized off the shorter axis so the shading at the edge of the page is round on a phone rather
  // than a wide oval.
  vec2 centred = (px - 0.5 * uResolution) / min(uResolution.x, uResolution.y);
  float edge = uVignette * pow(clamp(length(centred) * 1.35, 0.0, 1.0), 3.0);

  // The modulation is deliberately gentle. The page is a *wash*, and at anything past about a
  // fifth the city stops being a city drawn on paper and starts being a city behind tracing paper
  // — the colour goes first, since a low-chroma beige laid over everything can only take chroma
  // away (the same argument hazeColor() makes about a haze with no hue of its own).
  float a = clamp(uAmount * (0.5 + 0.8 * (1.0 - grain)) + edge, 0.0, 1.0);
  gl_FragColor = vec4(mix(page, uFibre, edge), a);
  #include <colorspace_fragment>
}
`;

/**
 * `colorspace_fragment` is not optional here for exactly the reason the route band records
 * (`game/routeline.js`): a `ShaderMaterial` gets none of three's built-in chunks, so a colour
 * built from a hex string — which `THREE.Color` has already converted *out* of sRGB — renders
 * linear and comes out visibly darker than every material beside it.
 */
function createOverlay() {
  const uniforms = {
    tCrayonPaper: CRAYON_UNIFORMS.tCrayonPaper,
    uCrayonPaperScale: CRAYON_UNIFORMS.uCrayonPaperScale,
    uCrayonBoil: CRAYON_UNIFORMS.uCrayonBoil,
    uResolution: { value: new THREE.Vector2(1, 1) },
    uPaper: { value: new THREE.Color(PALETTE.paper) },
    uFibre: { value: new THREE.Color(PALETTE.paperFibre) },
    uAmount: { value: CRAYON_DEFAULTS.paper },
    uVignette: { value: CRAYON_DEFAULTS.vignette },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: OVERLAY_VERTEX,
    fragmentShader: OVERLAY_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // The city is drawn into it, not the other way round: this is a wash over a finished picture.
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = 'crayon-paper';
  // The vertex shader ignores every matrix, so there is no position for three to cull against —
  // and it would cull it, since the quad's bounding sphere sits at the world origin.
  mesh.frustumCulled = false;
  mesh.renderOrder = PAPER_ORDER;
  return mesh;
}

const DISABLED = {
  state: { enabled: false },
  overlay: null,
  prepare: () => {},
  update: () => {},
  set: () => {},
  dispose: () => {},
};

/**
 * @param renderer  the one WebGLRenderer — read for its drawing-buffer size, never rebound
 * @param enabled   false leaves every method a no-op and bakes nothing. `util/geo.js` decides the
 *                  same thing for the materials off the same flag.
 */
export function createCrayon(renderer, { enabled = true } = {}) {
  if (!enabled) return DISABLED;

  const paper = new THREE.DataTexture(
    bakePaper(), PAPER_SIZE, PAPER_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  paper.wrapS = THREE.RepeatWrapping;
  paper.wrapT = THREE.RepeatWrapping;
  paper.minFilter = THREE.LinearFilter;
  paper.magFilter = THREE.LinearFilter;
  // No mips. The tile is sampled at roughly 1:1 and never minified far enough to need them, and a
  // mip chain would blur the tooth away at exactly the scale the tooth exists at.
  paper.generateMipmaps = false;
  paper.needsUpdate = true;

  CRAYON_UNIFORMS.tCrayonPaper.value = paper;
  CRAYON_UNIFORMS.uCrayonGrain.value = CRAYON_DEFAULTS.grain;
  CRAYON_UNIFORMS.uCrayonBlotch.value = CRAYON_DEFAULTS.blotch;
  CRAYON_UNIFORMS.uCrayonQuantize.value = CRAYON_DEFAULTS.quantize;
  CRAYON_UNIFORMS.uCrayonLine.value = CRAYON_DEFAULTS.line;
  CRAYON_UNIFORMS.uCrayonWobble.value = CRAYON_DEFAULTS.wobble;
  // Set through `convertLinearToSRGB` because the ink is mixed in *after* three's
  // `colorspace_fragment` has run — see the patch in `util/geo.js` for why that seam and not an
  // earlier one. A `THREE.Color` built from a hex string is in the linear working space; the frame
  // at that point in the shader is not.
  CRAYON_UNIFORMS.uCrayonInk.value.set(PALETTE.crayonLine).convertLinearToSRGB();

  const overlay = createOverlay();
  const uniforms = overlay.material.uniforms;

  const drawingBuffer = new THREE.Vector2();
  const state = { enabled: true, ...CRAYON_DEFAULTS };
  let elapsed = 0;
  let step = -1;

  /**
   * Advance the boil.
   *
   * Discrete steps, not a smooth drift: a continuously sliding noise field reads as a *material*
   * moving under the picture, where a field that jumps on its own clock reads as a hand redrawing
   * the frame. The offset per step is an arbitrary irrational pair so consecutive steps never land
   * back on the tile's own lattice.
   */
  function setStep(next) {
    if (next === step) return;
    step = next;
    uniforms.uCrayonBoil.value.set(
      (step * 0.7548776662) % 1,
      (step * 0.5698402909) % 1,
    );
  }

  setStep(0);

  return {
    state,
    overlay,

    /**
     * Size the screen-space uniforms. Called from `renderFrame()` in `main.js` rather than from
     * the frame loop, because shot mode and `__taxi.redraw()` both reach the render without ever
     * reaching the loop — the same argument `ssao.js` makes for sizing off the drawing buffer
     * every frame instead of off a resize event.
     */
    prepare() {
      renderer.getDrawingBufferSize(drawingBuffer);
      uniforms.uResolution.value.copy(drawingBuffer);
      // CSS pixels, not device pixels: `gl_FragCoord` is in device pixels, so dividing the tile
      // size by the pixel ratio is what keeps a 2px tooth 2 *CSS* px on every screen.
      const ratio = renderer.getPixelRatio();
      CRAYON_UNIFORMS.uCrayonPixelRatio.value = ratio;
      CRAYON_UNIFORMS.uCrayonPaperScale.value.set(
        1 / (PAPER_SIZE * ratio),
        1 / (PAPER_SIZE * ratio),
      );
    },

    /**
     * Step the boil. Takes **undilated** time: the slow-motion ramp at the end of a run is a
     * statement about the sim, and a drawing does not slow down because a taxi did.
     */
    update(dt) {
      elapsed += dt;
      setStep(state.boilHz > 0 ? Math.floor(elapsed * state.boilHz) : 0);
    },

    /** Live tuning — the ⚙️ panel, and nothing else. */
    set(key, value) {
      if (!(key in state)) return;
      state[key] = value;
      if (key === 'paper') uniforms.uAmount.value = value;
      else if (key === 'vignette') uniforms.uVignette.value = value;
      else if (key === 'grain') CRAYON_UNIFORMS.uCrayonGrain.value = value;
      else if (key === 'blotch') CRAYON_UNIFORMS.uCrayonBlotch.value = value;
      else if (key === 'quantize') CRAYON_UNIFORMS.uCrayonQuantize.value = value;
      else if (key === 'line') CRAYON_UNIFORMS.uCrayonLine.value = value;
      else if (key === 'wobble') CRAYON_UNIFORMS.uCrayonWobble.value = value;
    },

    dispose() {
      overlay.geometry.dispose();
      overlay.material.dispose();
      paper.dispose();
      CRAYON_UNIFORMS.tCrayonPaper.value = null;
    },
  };
}

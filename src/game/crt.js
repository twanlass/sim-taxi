import * as THREE from 'three';

/**
 * The CRT screen — on by default, `?crt=classic` for the clean frame. Ported from Grog
 * (twanlass/grog, `game/src/rendering/crtPostEffect.js`): a curved screen, scanlines, an RGB
 * aperture grille, a vignette, a touch of chromatic aberration at the edges and a slow flicker.
 *
 * **Not a composer.** The same shape as the rain's lens (game/rain.js, `renderLens`): the finished
 * frame copied to a texture and drawn back through one fullscreen triangle. So the main render keeps
 * the default framebuffer, its MSAA and its stencil, and none of the display-space seams the looks
 * are built on move (CLAUDE.md, "Three turns off in-material tone mapping"). What it costs is one
 * full-frame copy and one full-frame fragment pass with three texture reads a pixel — `?bench` has a
 * `crt off` row for exactly that number.
 *
 * **Only the canvas wears it.** The HUD, the speech cards and the ⚙️ panel are DOM over the canvas,
 * so the small type stays sharp; the screen effect is the city's, not the UI's. And tap picking runs
 * on the un-curved frame: at Grog's 0.10 curvature the warp is zero along both centre lines and
 * 1% of the half-screen at a corner, which is ~2pt on a phone — under a finger's error.
 *
 * Two departures from Grog, both because this game changes its own resolution and Grog does not:
 *
 *   - **Scanlines and the grille are measured in CSS pixels, not drawing-buffer pixels.** Grog keys
 *     them to the physical canvas; here the Quality setting (2x or 3x) and the heat governor
 *     (game/governor.js) both move the drawing buffer under a running game, and lines keyed to it
 *     would change pitch mid-run — or, at 2x on a 3x phone, alias into a beat pattern. One line pair
 *     every 2 CSS px is Grog's own pitch on a 2x display (`sin(y · res · 1.6)` is a 3.9-pixel period).
 *   - **Alpha is carried through.** The canvas is see-through (CLAUDE.md, "The canvas is see-through"),
 *     so the pass writes back the frame's own alpha rather than Grog's 1, and keeps colour under it.
 */

/**
 * Grog's shipped mix — "heavier scanlines, lighter curvature/vignette/aperture/aberration than
 * Classic" — and `strength`, a master over all six, which Grog does not have. The six are the look;
 * `strength` is the dial-back. Shipped at 0.6: at Grog's full mix the scanlines stripe the white sky
 * round the island grey at phone play zoom, which over Grog's black backdrop never comes up. 0.6
 * keeps the lines readable on the city and the sky near white (mean luma 116 clean, 109 at 0.6,
 * 104 at 1 on shot 0, 390x844 at 2x).
 */
export const CRT_DEFAULTS = {
  strength: 0.6,
  curvature: 0.10,
  scanline: 0.23,
  vignette: 0.25,
  aberration: 0.0002,
  aperture: 0.10,
  flicker: 0.034,
};

/** The ⚙️ panel's sliders: key, label, min, max, digits. Grog's ranges. */
export const CRT_SLIDERS = [
  ['strength', 'Strength', 0, 1.5, 2],
  ['curvature', 'Curvature', 0, 0.6, 2],
  ['scanline', 'Scanlines', 0, 1, 2],
  ['vignette', 'Vignette', 0, 1, 2],
  ['aberration', 'Aberration', 0, 0.015, 4],
  ['aperture', 'Aperture', 0, 0.7, 2],
  ['flicker', 'Flicker', 0, 0.1, 3],
];

/** Grog's one-click recipes. */
export const CRT_PRESETS = {
  Subtle: { curvature: 0.10, scanline: 0.15, vignette: 0.25, aberration: 0.001, aperture: 0.10, flicker: 0.01 },
  Classic: { curvature: 0.20, scanline: 0.35, vignette: 0.45, aberration: 0.003, aperture: 0.25, flicker: 0.02 },
  Heavy: { curvature: 0.40, scanline: 0.60, vignette: 0.70, aberration: 0.008, aperture: 0.50, flicker: 0.05 },
};

// Grog's fragment, with `uv` and `tex` from a varying and a uniform instead of Kaplay's template.
// Inside this literal identifiers go bare: a backtick ends the shader (CLAUDE.md).
const CRT_FRAGMENT = /* glsl */ `
uniform sampler2D tFrame;
uniform vec2 uCssSize;
uniform float uCssScale;
uniform float uTime;
uniform float uCurvature;
uniform float uScanline;
uniform float uVignette;
uniform float uAberration;
uniform float uAperture;
uniform float uFlicker;
varying vec2 vUv;

vec2 crtCurve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 offset = abs(uv.yx) * uCurvature;
  uv = uv + uv * offset * offset;
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = crtCurve(vUv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec2 center = uv - 0.5;
  float edge = dot(center, center);
  vec2 dir = normalize(center + 0.0001);
  float ab = uAberration * (1.0 + edge * 6.0);
  vec4 mid = texture2D(tFrame, uv);
  float r = texture2D(tFrame, uv - dir * ab).r;
  float b = texture2D(tFrame, uv + dir * ab).b;
  vec3 col = vec3(r, mid.g, b);

  // One line pair per 2 CSS px, on the curved coordinate so the lines bow with the glass.
  float scan = sin(uv.y * uCssSize.y * 3.14159265) * 0.5 + 0.5;
  col *= mix(1.0, scan, uScanline);

  // The grille, one stripe per CSS px.
  float ap = mod(floor(gl_FragCoord.x / uCssScale), 3.0);
  vec3 mask = ap < 1.0 ? vec3(1.15, 0.85, 0.85) : ap < 2.0 ? vec3(0.85, 1.15, 0.85) : vec3(0.85, 0.85, 1.15);
  col *= mix(vec3(1.0), mask, uAperture);

  vec2 vig = uv * (1.0 - uv.yx);
  float v = pow(vig.x * vig.y * 15.0, 0.3);
  col *= mix(1.0, clamp(v, 0.0, 1.0), uVignette);

  col *= 1.0 + (sin(uTime * 8.0) * 0.5 + 0.5) * uFlicker - uFlicker * 0.5;
  // Make-up gain for the light the scanlines took, and all of it: a line pair averages
  // 1 - scanline/2. Grog's 1 + 0.3 * scanline gives back about half, which over a black backdrop
  // reads as nothing and over this city's white sky measured as the whole frame 15% dimmer (mean
  // luma 116 to 99 on shot 0) — undoing the colour grade's exposure.
  col /= 1.0 - uScanline * 0.5;

  // The frame is premultiplied, so colour can never exceed its own alpha.
  gl_FragColor = vec4(min(col, vec3(mid.a)), mid.a);
}
`;

/**
 * @param renderer  the one WebGLRenderer
 * @param enabled   false allocates nothing and leaves `render` a no-op for good — `?crt=classic`
 * @param still     shot mode: the flicker is pinned at its midpoint, so a screenshot is repeatable
 */
export function createCrt(renderer, { enabled = true, still = false } = {}) {
  const state = { enabled, ...CRT_DEFAULTS };
  if (!enabled) {
    return { state, render: () => {}, set: () => {}, preset: () => {}, dispose: () => {} };
  }

  const uniforms = {
    tFrame: { value: null },
    uCssSize: { value: new THREE.Vector2(1, 1) },
    uCssScale: { value: 1 },
    uTime: { value: 0 },
    uCurvature: { value: 0 },
    uScanline: { value: 0 },
    uVignette: { value: 0 },
    uAberration: { value: 0 },
    uAperture: { value: 0 },
    uFlicker: { value: 0 },
  };
  const screen = new THREE.Scene();
  const screenCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    // Replaces the frame outright, alpha included — see the note on alpha above.
    blending: THREE.NoBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: CRT_FRAGMENT,
  });
  const quad = new THREE.Mesh(geo, material);
  quad.frustumCulled = false;
  screen.add(quad);

  let frameTex = null;
  const drawingBuffer = new THREE.Vector2();
  const start = performance.now();

  /** After everything else has drawn, the rain's lens included: the glass is in front of the drops. */
  function render() {
    const s = state.strength;
    if (!state.enabled || s <= 0) return;
    renderer.getDrawingBufferSize(drawingBuffer);
    if (!frameTex || frameTex.image.width !== drawingBuffer.x || frameTex.image.height !== drawingBuffer.y) {
      frameTex?.dispose();
      frameTex = new THREE.FramebufferTexture(drawingBuffer.x, drawingBuffer.y);
      frameTex.minFilter = THREE.LinearFilter;
      frameTex.magFilter = THREE.LinearFilter;
      uniforms.tFrame.value = frameTex;
    }
    const ratio = renderer.getPixelRatio();
    uniforms.uCssScale.value = ratio;
    uniforms.uCssSize.value.set(drawingBuffer.x / ratio, drawingBuffer.y / ratio);
    uniforms.uTime.value = still ? 0 : (performance.now() - start) / 1000;
    uniforms.uCurvature.value = state.curvature * s;
    uniforms.uScanline.value = state.scanline * s;
    uniforms.uVignette.value = state.vignette * s;
    uniforms.uAberration.value = state.aberration * s;
    uniforms.uAperture.value = state.aperture * s;
    uniforms.uFlicker.value = state.flicker * s;
    renderer.copyFramebufferToTexture(frameTex);
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(screen, screenCam);
    renderer.autoClear = prevAuto;
  }

  return {
    state,
    render,
    /** Live tuning — the ⚙️ panel, and `window.__taxi.crt`. `enabled` included: it is a post pass. */
    set(key, value) {
      if (key in state) state[key] = value;
    },
    preset(name) {
      if (name === 'Default') Object.assign(state, CRT_DEFAULTS);
      else if (CRT_PRESETS[name]) Object.assign(state, CRT_PRESETS[name]);
    },
    dispose() {
      frameTex?.dispose();
      geo.dispose();
      material.dispose();
    },
  };
}

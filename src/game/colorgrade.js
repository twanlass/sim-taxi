import * as THREE from 'three';

// --- The colour grade -------------------------------------------------------------------------------
//
// A 3D lookup table and a saturation knob over the whole game view, tuned from the ⚙️ panel's
// **Colour grade** section. The table is whatever look is picked (bundled, or a loaded `.cube`) with
// the panel's photo-editor controls — exposure, white balance, lift/gamma/gain, split tone,
// vibrance, curves — baked into it on the CPU, so nobody needs a grading app to make one. It ships
// Tyler's look (`GRADE_DEFAULTS`); `?grade=classic` draws the neutral frame it replaced.
//
// **It is a fragment tail, not a full-screen pass.** A screen-space LUT is the textbook build — draw
// the city into a target, then one pass over it that looks every pixel up — and it costs the things
// `game/hdr.js` lists for the composer: the frame stops being the default framebuffer, MSAA has to be
// bought back as `samples` on a target, and a phone pays a full-screen resolve plus a full-screen
// draw every frame for the privilege. This instead rides three's own fog chunk, the way the fog of
// war does (`game/edgefog.js`): every built-in material looks its own fragment up as its very last
// step, after the haze and the edge fog, in display space, which is the space a `.cube` file is
// authored in. No target, no extra pass, MSAA untouched. Off — the shipped state — it is one uniform
// branch a fragment, and a uniform branch costs nothing a GPU can measure.
//
// What that trades away, so nobody is surprised by it:
//   - **Translucent surfaces are graded before they blend, not after.** For saturation the two are
//     identical (it is linear in the colour, so it commutes with the blend); for a LUT they differ by
//     how far the table bends between the two colours being mixed, which for any grade gentle enough
//     to ship is nothing an eye can find.
//   - **A hand-written `ShaderMaterial` has none of three's chunks**, so it is graded only where it
//     asks for it with `#include <colorgrade_fragment>`. The sky dome and the route band do. The
//     small additive glows (window lights, headlamp cones, the rain) do not, and nor does the bloom's
//     spill on top of the frame: glow is light, and it reads right ungraded at any grade worth using.
//   - **A fragment shaded twice is graded twice the cost.** Overdraw is the price where a pass would
//     have paid per pixel once — the city is opaque and drawn front to back, so it is small.
//
// Every LUT is resampled onto one fixed `LUT_SIZE` grid on the way in. Not for the quality — it is
// about the texture: three allocates a 3D texture's storage once (`texStorage3D`) and only ever
// re-uploads into it, so a LUT of a different size swapped into the same texture would write past
// the end of the old allocation. One size means one texture, forever.

/** The grid every LUT is resampled to. 33 is the size most grading tools export. */
export const LUT_SIZE = 33;

/**
 * What the panel's Reset goes back to, and what the game ships: Tyler's look, made in the panel's
 * editor and pasted back as its Copy look code (2026-10-23). A touch brighter, cooler shadows with a
 * blue split tone, a hair of magenta, and a slightly lowered blue mid on the curve. `?grade=classic`
 * draws the neutral frame the game shipped with before it.
 */
export const GRADE_DEFAULTS = {
  preset: 'none',
  strength: 1,
  saturation: 1,
  adjust: {
    exposure: 0.54, contrast: 0.09, temperature: -0.11, tint: 0.13,
    shadows: -0.07, midtones: 0.11, highlights: 0.04,
    shadowAmount: 0.36, shadowHue: 224,
    curve: { g: [0, 0.25, 0.501, 0.75, 1], b: [0, 0.25, 0.447, 0.75, 1] },
  },
};

/** `?grade=classic`: the neutral frame, as the game shipped before the look above. */
export const GRADE_NEUTRAL = { preset: 'none', strength: 1, saturation: 1, adjust: null };

/**
 * The panel's photo-editor controls, at rest. Every one of them is neutral here, so a look that never
 * touched them bakes to exactly the LUT underneath. A look to ship goes in `GRADE_DEFAULTS.adjust`
 * as the object the panel's **Copy look** prints; anything it leaves out stays at rest here.
 *
 * The curves are five knots each, at inputs 0, ¼, ½, ¾ and 1: few enough to drag with a thumb on a
 * 250-pixel canvas, and the same five a photo app's "points" curve starts with.
 */
export const ADJUST_DEFAULTS = Object.freeze({
  exposure: 0, // stops, −2..2, in linear light
  contrast: 0, // −1..1, about mid grey
  temperature: 0, // −1..1, cool to warm
  tint: 0, // −1..1, green to magenta
  shadows: 0, // −1..1, the lift
  midtones: 0, // −1..1, the gamma
  highlights: 0, // −1..1, the gain
  vibrance: 0, // −1..1, saturation that spares what is already saturated
  shadowHue: 200, // degrees; the split tone's two colours, which do nothing at amount 0
  shadowAmount: 0, // 0..1
  highlightHue: 40,
  highlightAmount: 0,
  curve: Object.freeze({
    rgb: Object.freeze([0, 0.25, 0.5, 0.75, 1]),
    r: Object.freeze([0, 0.25, 0.5, 0.75, 1]),
    g: Object.freeze([0, 0.25, 0.5, 0.75, 1]),
    b: Object.freeze([0, 0.25, 0.5, 0.75, 1]),
  }),
});

/** The slider ranges, for the panel and for clamping a pasted look. Hues are not clamped, wrapped. */
export const ADJUST_RANGES = {
  exposure: [-2, 2], contrast: [-1, 1], temperature: [-1, 1], tint: [-1, 1],
  shadows: [-1, 1], midtones: [-1, 1], highlights: [-1, 1], vibrance: [-1, 1],
  shadowHue: [0, 360], shadowAmount: [0, 1], highlightHue: [0, 360], highlightAmount: [0, 1],
};

export const CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'];

/**
 * A texture that is its own clone.
 *
 * Built-in materials take a *clone* of ShaderLib's uniforms (`cloneUniforms`), and a texture is one
 * of the things that clones — so a LUT put into ShaderLib as a plain `Data3DTexture` would be copied
 * into a few hundred materials with version 0, never upload, and swapping the table would reach none
 * of them. Returning `this` makes every material share the one texture, which is what the edge fog's
 * plain-object uniform does for a vector.
 */
class SharedLut extends THREE.Data3DTexture {
  clone() { return this; }
}

function makeLutTexture() {
  const n = LUT_SIZE;
  const tex = new SharedLut(new Uint16Array(n * n * n * 4), n, n, n);
  tex.format = THREE.RGBAFormat;
  // Half float, not float: linear filtering of a 32-bit float texture needs OES_texture_float_linear,
  // which iOS does not have, and a LUT that cannot filter is a posterised one. Half float filters in
  // core WebGL2. 8-bit would filter too, and band in the shadows.
  tex.type = THREE.HalfFloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const lut = makeLutTexture();

/**
 * x: saturation, y: LUT strength, w: 1 when anything is non-neutral. A plain object rather than a
 * Vector4 for the reason `edgeFogUniform` is one — a vector would be cloned per material and frozen.
 */
export const gradeUniform = { x: 1, y: 0, z: 0, w: 0 };

/** For a hand-written ShaderMaterial that wants grading: spread into its `uniforms`. */
export const GRADE_UNIFORMS = {
  colorGrade: { value: gradeUniform },
  colorGradeLut: { value: lut },
};

const n = LUT_SIZE;
const f = (v) => v.toFixed(6);

THREE.ShaderChunk.colorgrade_pars_fragment = /* glsl */ `
uniform vec4 colorGrade;
uniform sampler3D colorGradeLut;
`;

// Clamped first because the table only covers 0..1, and texel centres because a 3D texture's edge
// texels sit half a texel in from 0 and 1 — sampling at the raw colour would read the corners of
// the cube half a step inward and lift every black.
THREE.ShaderChunk.colorgrade_fragment = /* glsl */ `
if ( colorGrade.w > 0.5 ) {
	vec3 cgc = clamp( gl_FragColor.rgb, 0.0, 1.0 );
	cgc = mix( cgc, texture( colorGradeLut, cgc * ${f((n - 1) / n)} + ${f(0.5 / n)} ).rgb, colorGrade.y );
	cgc = mix( vec3( dot( cgc, vec3( 0.2126, 0.7152, 0.0722 ) ) ), cgc, colorGrade.x );
	gl_FragColor.rgb = max( cgc, 0.0 );
}
`;

let installed = false;

/**
 * Put the grade on the end of three's fog chunk. Called from `decideLooks` rather than at import,
 * because the order matters and an import cannot promise it: the edge fog appends its own term to
 * the same chunk when *it* is imported, and the grade has to come after it or the fog bank is the
 * one thing on screen left ungraded. By the time the render path is deciding looks, every module
 * the page imports has run.
 */
export function installColorGrade() {
  if (installed) return;
  installed = true;
  const chunk = THREE.ShaderChunk;
  chunk.fog_pars_fragment += '\n#include <colorgrade_pars_fragment>\n';
  chunk.fog_fragment += '\n#include <colorgrade_fragment>\n';
  // Every built-in shader that includes the fog chunk now reads the two uniforms, so every one of
  // them has to be handed them — a sampler3D left unset defaults to texture unit 0, which is
  // somebody's 2D map, and a draw with two sampler types on one unit is a GL error, not a no-op.
  Object.assign(THREE.UniformsLib.fog, GRADE_UNIFORMS);
  for (const shader of Object.values(THREE.ShaderLib)) {
    if (shader.fragmentShader?.includes('<fog_fragment>')) Object.assign(shader.uniforms, GRADE_UNIFORMS);
  }
}

// --- Tables -----------------------------------------------------------------------------------------

/** A table: `size` cubed RGB triples, red fastest, then green, then blue — the `.cube` order. */
function tableFrom(fn, size = LUT_SIZE) {
  const data = new Float32Array(size * size * size * 3);
  let k = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data[k++] = out[0];
        data[k++] = out[1];
        data[k++] = out[2];
      }
    }
  }
  return { size, data };
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (v) => v * v * (3 - 2 * v);
const sat = (rgb, s) => {
  const l = luma(...rgb);
  return rgb.map((c) => l + (c - l) * s);
};

/**
 * The bundled looks, built in code like everything else in this game rather than shipped as files.
 * Each is a function of a display-space colour, so it is a starting point to judge against, not a
 * tuned grade — a `.cube` from a real grading tool goes in through the panel's file picker.
 */
export const PRESETS = {
  none: null,
  warm: (r, g, b) => [r * 1.05 + 0.02, g * 1.01 + 0.005, b * 0.9],
  cool: (r, g, b) => [r * 0.92, g * 1.0 + 0.005, b * 1.05 + 0.025],
  // Shadows toward teal, highlights toward orange, split on luminance — the blockbuster look.
  'teal & orange': (r, g, b) => {
    const t = smooth(clamp01(luma(r, g, b)));
    return [
      r + 0.07 * t - 0.05 * (1 - t),
      g + 0.01 * t + 0.015 * (1 - t),
      b - 0.08 * t + 0.06 * (1 - t),
    ];
  },
  // Lifted blacks, pulled-down whites, a little less colour and a warm tilt.
  'faded film': (r, g, b) => sat([0.07 + r * 0.88 + 0.015, 0.07 + g * 0.87, 0.07 + b * 0.84], 0.82),
  // A luminance overlay mixed back over the colour, then most of the colour taken out.
  'bleach bypass': (r, g, b) => {
    const l = luma(r, g, b);
    const over = (c) => (l < 0.5 ? 2 * c * l : 1 - 2 * (1 - c) * (1 - l));
    return sat([r, g, b].map((c) => c + (over(c) - c) * 0.6), 0.55);
  },
  // An S-curve on each channel, and more colour.
  punchy: (r, g, b) => sat([r, g, b].map((c) => c + (smooth(c) - c) * 0.45), 1.18),
};

/** Trilinear read of a table at a 0..1 colour — what the GPU does, so resampling loses nothing new. */
function sampleTable({ size, data }, r, g, b) {
  const at = (v) => {
    const x = clamp01(v) * (size - 1);
    const i = Math.min(size - 2, Math.floor(x));
    return [i, x - i];
  };
  const [ri, rf] = at(r);
  const [gi, gf] = at(g);
  const [bi, bf] = at(b);
  const out = [0, 0, 0];
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const w = (dx ? rf : 1 - rf) * (dy ? gf : 1 - gf) * (dz ? bf : 1 - bf);
        if (!w) continue;
        const k = (((bi + dz) * size + (gi + dy)) * size + (ri + dx)) * 3;
        out[0] += data[k] * w;
        out[1] += data[k + 1] * w;
        out[2] += data[k + 2] * w;
      }
    }
  }
  return out;
}

/**
 * Parse a `.cube` file (Adobe/Resolve). 3D tables only; a 1D table or an input domain other than
 * 0..1 is refused with a message rather than drawn wrong.
 */
export function parseCube(text) {
  let size = 0;
  let title = '';
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^TITLE/i.test(line)) { title = line.replace(/^TITLE\s*/i, '').replace(/^"|"$/g, ''); continue; }
    if (/^LUT_1D_SIZE/i.test(line)) throw new Error('1D LUTs are not supported — export a 3D .cube');
    if (/^LUT_3D_SIZE/i.test(line)) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (/^DOMAIN_(MIN|MAX)/i.test(line)) {
      const want = /MIN/i.test(line) ? 0 : 1;
      if (line.split(/\s+/).slice(1).some((v) => Math.abs(Number(v) - want) > 1e-6)) {
        throw new Error('only a 0..1 input domain is supported');
      }
      continue;
    }
    if (/^[A-Z_]/i.test(line)) continue; // LUT_3D_INPUT_RANGE and other keywords we can ignore
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every(Number.isFinite)) values.push(parts[0], parts[1], parts[2]);
  }
  if (size < 2 || size > 256) throw new Error('no LUT_3D_SIZE line');
  if (values.length !== size * size * size * 3) {
    throw new Error(`expected ${size ** 3} entries for LUT_3D_SIZE ${size}, found ${values.length / 3}`);
  }
  return { title, size, data: Float32Array.from(values) };
}

/** Write a table out as a `.cube`, for the panel's Download — a grade with its knobs baked in. */
export function toCube({ size, data }, title = 'Rocket Rides grade') {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let k = 0; k < data.length; k += 3) {
    lines.push(`${data[k].toFixed(6)} ${data[k + 1].toFixed(6)} ${data[k + 2].toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- The adjustments --------------------------------------------------------------------------------
//
// Baked into the LUT on the CPU rather than done in the shader: a 33³ table is ~36k colours and the
// fragment tail stays the one texture read it already was, however many knobs move. Measured in Node
// on a desktop core, one bake is ~12 ms (~9 with no LUT under it), and the panel coalesces a drag to one bake a frame.

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toDisplay = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** A fully saturated colour at a hue, in display space. */
function hueColour(deg) {
  const h = (((deg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  return [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(h) % 6];
}

/**
 * A monotone cubic through the five knots (Fritsch–Carlson), read off a 1024-entry table. Monotone so
 * that a curve dragged steep cannot overshoot into a ripple between two knots — a ripple in a tone
 * curve is a band of solarised colour on every gradient in the sky.
 */
function curveTable(ys) {
  const xs = [0, 0.25, 0.5, 0.75, 1];
  const k = xs.length;
  const d = [];
  for (let i = 0; i < k - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = [d[0]];
  for (let i = 1; i < k - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[k - 2]);
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const r = a * a + b * b;
    if (r > 9) { const t = 3 / Math.sqrt(r); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const N = 1024;
  const out = new Float32Array(N + 1);
  for (let j = 0; j <= N; j++) {
    const x = j / N;
    const i = Math.min(k - 2, Math.floor(x * 4));
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    out[j] = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  }
  return out;
}

const readCurve = (tab, v) => {
  const x = clamp01(v) * 1024;
  const i = Math.min(1023, Math.floor(x));
  return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
};

const isIdentityCurve = (ys) => ys.every((y, i) => Math.abs(y - i / 4) < 1e-4);

/** True when nothing in an adjust object moves a colour. */
export function adjustIsNeutral(a) {
  if (!a) return true;
  const d = ADJUST_DEFAULTS;
  for (const key of ['exposure', 'contrast', 'temperature', 'tint', 'shadows', 'midtones', 'highlights', 'vibrance', 'shadowAmount', 'highlightAmount']) {
    if (Math.abs((a[key] ?? d[key]) - d[key]) > 1e-4) return false;
  }
  return CURVE_CHANNELS.every((ch) => isIdentityCurve(a.curve?.[ch] ?? d.curve[ch]));
}

/**
 * The adjustments as a function of one display-space colour. Built once per bake, so the knobs and
 * curve tables are read outside the 36k-colour loop.
 *
 * The order is a grading app's: light first (exposure and white balance, in linear light, where
 * they are multiplies), then tone (contrast, lift/gamma/gain), then colour (split tone, vibrance),
 * then the curves on top as the last word.
 */
function adjuster(a) {
  if (adjustIsNeutral(a)) return null;
  const d = ADJUST_DEFAULTS;
  const get = (key) => a[key] ?? d[key];
  const exposure = 2 ** get('exposure');
  const t = get('temperature');
  const tn = get('tint');
  // White balance as per-channel gains, normalised to keep luminance where it was, so warming the
  // frame does not also brighten it.
  const wb = [(1 + 0.22 * t) * (1 + 0.08 * tn), 1 - 0.16 * tn, (1 - 0.22 * t) * (1 + 0.08 * tn)];
  const wbL = luma(...wb);
  for (let i = 0; i < 3; i++) wb[i] = (wb[i] / wbL) * exposure;
  // Contrast as a power about mid grey on each half, so it pivots at 0.5 and can never clip 0 or 1.
  const ck = 2 ** (get('contrast') * 1.4);
  const contrast = (x) => (x < 0.5 ? 0.5 * (2 * x) ** ck : 1 - 0.5 * (2 - 2 * x) ** ck);
  const lift = get('shadows') * 0.2;
  const gamma = 2 ** -get('midtones');
  const gain = 1 + get('highlights') * 0.4;
  const split = (deg, amount) => {
    const c = hueColour(deg);
    const l = luma(...c);
    return c.map((v) => (v - l) * amount * 0.22);
  };
  const shadowTint = split(get('shadowHue'), get('shadowAmount'));
  const highTint = split(get('highlightHue'), get('highlightAmount'));
  const vibrance = get('vibrance');
  const curves = CURVE_CHANNELS.map((ch) => {
    const ys = a.curve?.[ch] ?? d.curve[ch];
    return isIdentityCurve(ys) ? null : curveTable(ys);
  });
  // Everything up to the split tone works on each channel alone, so it is read off one table per
  // channel rather than computed: that is nine powers a colour that a bake no longer pays.
  const tone = [0, 1, 2].map((i) => {
    const tab = new Float32Array(1025);
    for (let j = 0; j <= 1024; j++) {
      const v = Math.min(1, toDisplay(toLinear(j / 1024) * wb[i]));
      const x = contrast(v);
      tab[j] = Math.max(0, x * gain + lift * (1 - x)) ** gamma;
    }
    return tab;
  });
  const c = [0, 0, 0];
  return (rgb) => {
    for (let i = 0; i < 3; i++) c[i] = readCurve(tone[i], rgb[i]);
    const l = clamp01(luma(c[0], c[1], c[2]));
    const ws = (1 - l) ** 2;
    const wh = l * l;
    for (let i = 0; i < 3; i++) c[i] += shadowTint[i] * ws + highTint[i] * wh;
    if (vibrance) {
      const s = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
      const l2 = luma(c[0], c[1], c[2]);
      const k = 1 + vibrance * (1 - clamp01(s)) * (vibrance > 0 ? 1.2 : 1);
      for (let i = 0; i < 3; i++) c[i] = l2 + (c[i] - l2) * k;
    }
    for (let i = 0; i < 3; i++) {
      let v = clamp01(c[i]);
      if (curves[0]) v = readCurve(curves[0], v);
      if (curves[i + 1]) v = readCurve(curves[i + 1], v);
      c[i] = v;
    }
    return [c[0], c[1], c[2]];
  };
}

// --- The live state ---------------------------------------------------------------------------------

const STORE_KEY = 'simtaxi.colorgrade';
// localStorage gives an origin ~5MB; a 65-point .cube is ~7MB of text. Anything over this is applied
// for the session and not remembered, rather than throwing away everything else the origin stores.
const STORE_CUBE_MAX = 1.5e6;

const cloneAdjust = (a) => ({ ...ADJUST_DEFAULTS, ...a, curve: Object.fromEntries(CURVE_CHANNELS.map((ch) => [ch, [...(a?.curve?.[ch] ?? ADJUST_DEFAULTS.curve[ch])]])) });

const state = { ...GRADE_DEFAULTS, adjust: cloneAdjust(GRADE_DEFAULTS.adjust), cubeName: '', cubeText: '' };
let table = null; // the active LUT as loaded, before strength, the adjustments and saturation
let baked = false; // whether the texture holds anything but the identity
let bypass = false; // the panel's hold-to-compare

/**
 * The colour a grid point bakes to: the LUT at its strength, then the adjustments. Saturation is the
 * one knob left to the shader, where it is free and cannot band.
 */
function composer() {
  const adjust = adjuster(state.adjust);
  if (!table && !adjust) return null;
  const s = state.strength;
  return (r, g, b, direct) => {
    let c = [r, g, b];
    if (table && s > 0) {
      const looked = direct ?? sampleTable(table, r, g, b);
      c = c.map((v, i) => v + (looked[i] - v) * s);
    }
    return adjust ? adjust(c) : c;
  };
}

function bake() {
  const fn = composer();
  baked = Boolean(fn);
  const out = lut.image.data;
  const direct = table?.size === n ? table.data : null;
  const one = THREE.DataUtils.toHalfFloat(1);
  let k = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const c = [r / (n - 1), g / (n - 1), b / (n - 1)];
        let v = c;
        if (fn) {
          const j = ((b * n + g) * n + r) * 3;
          v = fn(c[0], c[1], c[2], direct ? [direct[j], direct[j + 1], direct[j + 2]] : null);
        }
        out[k] = THREE.DataUtils.toHalfFloat(clamp01(v[0]));
        out[k + 1] = THREE.DataUtils.toHalfFloat(clamp01(v[1]));
        out[k + 2] = THREE.DataUtils.toHalfFloat(clamp01(v[2]));
        out[k + 3] = one;
        k += 4;
      }
    }
  }
  lut.needsUpdate = true;
  applyUniforms();
}

// A drag fires `input` faster than a phone bakes, so a slider asks for a bake and gets one a frame.
let bakePending = false;
function requestBake() {
  const raf = globalThis.requestAnimationFrame;
  if (!raf) { bake(); return; }
  if (bakePending) return;
  bakePending = true;
  raf(() => { bakePending = false; bake(); });
}

function applyUniforms() {
  gradeUniform.x = state.saturation;
  gradeUniform.y = baked ? 1 : 0;
  const on = baked || Math.abs(state.saturation - 1) > 1e-4;
  gradeUniform.w = on && !bypass ? 1 : 0;
}

function save() {
  try {
    const keep = { preset: state.preset, strength: state.strength, saturation: state.saturation };
    // Always written, neutral included: an absent `adjust` restores the shipped look, so a player
    // who zeroed every knob would otherwise get the default back on the next load.
    keep.adjust = state.adjust;
    if (state.preset === 'file' && state.cubeText.length <= STORE_CUBE_MAX) {
      keep.cubeName = state.cubeName;
      keep.cubeText = state.cubeText;
    }
    if (keep.preset === 'file' && !keep.cubeText) keep.preset = 'none';
    localStorage.setItem(STORE_KEY, JSON.stringify(keep));
  } catch { /* private mode, or full — the grade still applies for this session */ }
}

/** The panel's view of the grade. */
export function colorGrade() {
  // From the state rather than from `baked`: a slider's bake lands on the next frame, and the panel
  // reads this on the same input event.
  const active = Boolean(table) || !adjustIsNeutral(state.adjust) || Math.abs(state.saturation - 1) > 1e-4;
  return { ...state, active };
}

/** Pick a bundled look by name (`PRESETS`). */
export function setGradePreset(name) {
  if (!(name in PRESETS)) return;
  state.preset = name;
  state.cubeName = '';
  state.cubeText = '';
  table = PRESETS[name] ? tableFrom(PRESETS[name]) : null;
  bake();
  save();
}

/** Load a `.cube` file's text. Throws with a readable message if the file is not one we can use. */
export function setGradeCube(text, name = 'custom.cube') {
  const parsed = parseCube(text);
  state.preset = 'file';
  state.cubeName = name;
  state.cubeText = text;
  table = parsed;
  bake();
  save();
  return parsed;
}

export function setGradeStrength(v) {
  state.strength = clamp01(v);
  requestBake();
  save();
}

export function setGradeSaturation(v) {
  state.saturation = Math.min(2, Math.max(0, v));
  applyUniforms();
  save();
}

/** Move one of the photo-editor knobs (`ADJUST_RANGES`). */
export function setGradeAdjust(key, v) {
  const range = ADJUST_RANGES[key];
  if (!range || !Number.isFinite(v)) return;
  state.adjust[key] = key.endsWith('Hue') ? ((v % 360) + 360) % 360 : Math.min(range[1], Math.max(range[0], v));
  requestBake();
  save();
}

/** Move one knot of one curve: `index` 0..4 along the input, `y` the output it maps to. */
export function setGradeCurve(channel, index, y) {
  const ys = state.adjust.curve[channel];
  if (!ys || !(index >= 0 && index < ys.length) || !Number.isFinite(y)) return;
  ys[index] = clamp01(y);
  requestBake();
  save();
}

/** Put one curve, or every curve, back on the diagonal. */
export function resetGradeCurve(channel = null) {
  for (const ch of channel ? [channel] : CURVE_CHANNELS) state.adjust.curve[ch] = [...ADJUST_DEFAULTS.curve[ch]];
  requestBake();
  save();
}

/** The panel's hold-to-compare: draw the shipped frame while held, without forgetting the grade. */
export function setGradeBypass(on) {
  bypass = Boolean(on);
  applyUniforms();
}

/**
 * A curve's response at `x`, for the panel to draw: the curve alone, with nothing else in the grade
 * applied, so what is drawn is the shape under the finger.
 */
export function curveAt(channel, x) {
  const ys = state.adjust.curve[channel];
  return isIdentityCurve(ys) ? x : readCurve(curveTable(ys), x);
}

export function resetGrade() {
  Object.assign(state, GRADE_DEFAULTS, { adjust: cloneAdjust(GRADE_DEFAULTS.adjust) });
  setGradePreset(GRADE_DEFAULTS.preset);
  try { localStorage.removeItem(STORE_KEY); } catch { /* nothing to forget */ }
}

/** Put the knobs back but keep the look underneath. */
export function resetGradeAdjust() {
  state.adjust = cloneAdjust(null);
  bake();
  save();
}

/** The grade as it stands, strength, adjustments and saturation folded into one table — the panel's Download. */
export function bakedTable() {
  const fn = composer();
  return tableFrom((r, g, b) => sat(fn ? fn(r, g, b, null) : [r, g, b], state.saturation).map(clamp01));
}

const round = (v) => Number(v.toFixed(3));

/**
 * The grade as a short piece of JSON — every knob that is not at rest, and the bundled look under
 * them. This is what to send back to be made the shipped default: it goes into `GRADE_DEFAULTS`
 * as it stands, where a baked .cube would be 36k lines in the repo. A loaded file cannot travel this
 * way, and the code says so rather than quietly dropping it.
 */
export function lookCode() {
  const out = {};
  if (state.preset === 'file') out.preset = `file: ${state.cubeName} (not in this code; use Download .cube)`;
  else if (state.preset !== 'none') out.preset = state.preset;
  if (out.preset && state.strength !== 1) out.strength = round(state.strength);
  if (Math.abs(state.saturation - 1) > 1e-4) out.saturation = round(state.saturation);
  const adjust = {};
  for (const key of Object.keys(ADJUST_RANGES)) {
    if (key.endsWith('Hue')) continue;
    if (Math.abs(state.adjust[key] - ADJUST_DEFAULTS[key]) > 1e-4) adjust[key] = round(state.adjust[key]);
  }
  if (state.adjust.shadowAmount > 0) adjust.shadowHue = Math.round(state.adjust.shadowHue);
  if (state.adjust.highlightAmount > 0) adjust.highlightHue = Math.round(state.adjust.highlightHue);
  const curve = {};
  for (const ch of CURVE_CHANNELS) if (!isIdentityCurve(state.adjust.curve[ch])) curve[ch] = state.adjust.curve[ch].map(round);
  if (Object.keys(curve).length) adjust.curve = curve;
  if (Object.keys(adjust).length) out.adjust = adjust;
  return JSON.stringify(out);
}

/** Apply a look pasted from `lookCode`. Throws with a readable message on anything else. */
export function setLookCode(text) {
  let look;
  try { look = JSON.parse(String(text).trim()); } catch { throw new Error('that is not a look code'); }
  if (!look || typeof look !== 'object' || Array.isArray(look)) throw new Error('that is not a look code');
  const adjust = cloneAdjust(null);
  for (const [key, v] of Object.entries(look.adjust ?? {})) {
    if (key === 'curve') {
      for (const ch of CURVE_CHANNELS) {
        const ys = v?.[ch];
        if (Array.isArray(ys) && ys.length === 5 && ys.every(Number.isFinite)) adjust.curve[ch] = ys.map(clamp01);
      }
    } else if (ADJUST_RANGES[key] && Number.isFinite(v)) {
      const [lo, hi] = ADJUST_RANGES[key];
      adjust[key] = key.endsWith('Hue') ? ((v % 360) + 360) % 360 : Math.min(hi, Math.max(lo, v));
    }
  }
  const preset = look.preset in PRESETS ? look.preset : 'none';
  state.preset = preset;
  state.cubeName = '';
  state.cubeText = '';
  state.strength = Number.isFinite(look.strength) ? clamp01(look.strength) : 1;
  state.saturation = Number.isFinite(look.saturation) ? Math.min(2, Math.max(0, look.saturation)) : 1;
  state.adjust = adjust;
  table = PRESETS[preset] ? tableFrom(PRESETS[preset]) : null;
  bake();
  save();
}

/** What the Export JSON carries. `false` while neutral, like the look modes. */
export function gradeSnapshot() {
  if (!colorGrade().active) return false;
  return {
    preset: state.preset === 'file' ? `file: ${state.cubeName}` : state.preset,
    strength: Number(state.strength.toFixed(2)),
    saturation: Number(state.saturation.toFixed(2)),
    look: lookCode(),
  };
}

// Restore the last session's grade, or seed the shipped one. Shot mode never reads the stored one,
// so a screenshot draws the shipped frame unless the URL asks otherwise: `?grade=<preset>` (over the
// shipped adjustments), `?grade=classic` (the neutral frame) and `?gradesat=<0..2>` pick a look for
// this load without remembering it, which is how a before/after still or a shared link shows one.
(function restore() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  let saved = null;
  try {
    if (typeof localStorage !== 'undefined' && !params.has('shot')) {
      saved = JSON.parse(localStorage.getItem(STORE_KEY));
    }
  } catch { saved = null; }
  if (params.get('grade') === 'classic') {
    saved = { ...GRADE_NEUTRAL, adjust: ADJUST_DEFAULTS };
  } else if (params.has('grade') || params.has('gradesat')) {
    const preset = params.get('grade');
    const s = Number(params.get('gradesat'));
    saved = {
      preset: preset in PRESETS ? preset : 'none',
      strength: 1,
      saturation: params.has('gradesat') && Number.isFinite(s) ? s : 1,
    };
  }
  state.strength = Number.isFinite(saved?.strength) ? clamp01(saved.strength) : GRADE_DEFAULTS.strength;
  state.saturation = Number.isFinite(saved?.saturation) ? Math.min(2, Math.max(0, saved.saturation)) : GRADE_DEFAULTS.saturation;
  if (saved?.adjust && typeof saved.adjust === 'object') {
    const a = cloneAdjust(null);
    for (const key of Object.keys(ADJUST_RANGES)) if (Number.isFinite(saved.adjust[key])) a[key] = saved.adjust[key];
    for (const ch of CURVE_CHANNELS) {
      const ys = saved.adjust.curve?.[ch];
      if (Array.isArray(ys) && ys.length === 5 && ys.every(Number.isFinite)) a.curve[ch] = ys.map(clamp01);
    }
    state.adjust = a;
  }
  if (saved?.preset === 'file' && saved.cubeText) {
    try {
      setGradeCube(saved.cubeText, saved.cubeName);
      return;
    } catch { /* a stored file that no longer parses falls through to the preset */ }
  }
  state.preset = saved?.preset in PRESETS ? saved.preset : GRADE_DEFAULTS.preset;
  table = PRESETS[state.preset] ? tableFrom(PRESETS[state.preset]) : null;
  bake();
})();

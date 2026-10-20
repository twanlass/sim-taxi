import * as THREE from 'three';

// --- The colour grade -------------------------------------------------------------------------------
//
// A 3D lookup table and a saturation knob over the whole game view, tuned from the ⚙️ panel's
// **Colour grade** section. Neutral by default: the shipped game is drawn exactly as it was until a
// grade is picked.
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

/** What the panel's Reset goes back to, and what the game ships. Neutral — see the top of the file. */
export const GRADE_DEFAULTS = { preset: 'none', strength: 1, saturation: 1 };

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

// --- The live state ---------------------------------------------------------------------------------

const STORE_KEY = 'simtaxi.colorgrade';
// localStorage gives an origin ~5MB; a 65-point .cube is ~7MB of text. Anything over this is applied
// for the session and not remembered, rather than throwing away everything else the origin stores.
const STORE_CUBE_MAX = 1.5e6;

const state = { ...GRADE_DEFAULTS, cubeName: '', cubeText: '' };
let table = null; // the active LUT as loaded, before strength and saturation

function upload(source) {
  table = source;
  const out = lut.image.data;
  const ident = !source;
  let k = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const c = [r / (n - 1), g / (n - 1), b / (n - 1)];
        const v = ident ? c : (source.size === n ? null : sampleTable(source, ...c));
        const j = ((b * n + g) * n + r) * 3;
        for (let ch = 0; ch < 3; ch++) {
          out[k + ch] = THREE.DataUtils.toHalfFloat(clamp01(v ? v[ch] : source.data[j + ch]));
        }
        out[k + 3] = THREE.DataUtils.toHalfFloat(1);
        k += 4;
      }
    }
  }
  lut.needsUpdate = true;
}

function applyUniforms() {
  gradeUniform.x = state.saturation;
  gradeUniform.y = table ? state.strength : 0;
  gradeUniform.w = (gradeUniform.y > 0 || Math.abs(state.saturation - 1) > 1e-4) ? 1 : 0;
}

function save() {
  try {
    const keep = { preset: state.preset, strength: state.strength, saturation: state.saturation };
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
  return { ...state, active: gradeUniform.w > 0 };
}

/** Pick a bundled look by name (`PRESETS`). */
export function setGradePreset(name) {
  if (!(name in PRESETS)) return;
  state.preset = name;
  state.cubeName = '';
  state.cubeText = '';
  upload(PRESETS[name] ? tableFrom(PRESETS[name]) : null);
  applyUniforms();
  save();
}

/** Load a `.cube` file's text. Throws with a readable message if the file is not one we can use. */
export function setGradeCube(text, name = 'custom.cube') {
  const parsed = parseCube(text);
  state.preset = 'file';
  state.cubeName = name;
  state.cubeText = text;
  upload(parsed);
  applyUniforms();
  save();
  return parsed;
}

export function setGradeStrength(v) {
  state.strength = clamp01(v);
  applyUniforms();
  save();
}

export function setGradeSaturation(v) {
  state.saturation = Math.min(2, Math.max(0, v));
  applyUniforms();
  save();
}

export function resetGrade() {
  Object.assign(state, GRADE_DEFAULTS);
  setGradePreset(GRADE_DEFAULTS.preset);
  try { localStorage.removeItem(STORE_KEY); } catch { /* nothing to forget */ }
}

/** The grade as it stands, strength and saturation folded into one table — the panel's Download. */
export function bakedTable() {
  return tableFrom((r, g, b) => {
    let c = [r, g, b];
    if (table) {
      const looked = sampleTable(table, r, g, b);
      c = c.map((v, i) => v + (looked[i] - v) * state.strength);
    }
    return sat(c, state.saturation).map(clamp01);
  });
}

/** What the Export JSON carries. `false` while neutral, like the look modes. */
export function gradeSnapshot() {
  if (!gradeUniform.w) return false;
  return {
    preset: state.preset === 'file' ? `file: ${state.cubeName}` : state.preset,
    strength: Number(state.strength.toFixed(2)),
    saturation: Number(state.saturation.toFixed(2)),
  };
}

// Restore the last session's grade, or seed the neutral default. Shot mode never reads the stored
// one, so a screenshot draws the shipped frame unless the URL asks otherwise: `?grade=<preset>` and
// `?gradesat=<0..2>` pick a look for this load without remembering it, which is how a before/after
// still or a shared link shows a grade.
(function restore() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  let saved = null;
  try {
    if (typeof localStorage !== 'undefined' && !params.has('shot')) {
      saved = JSON.parse(localStorage.getItem(STORE_KEY));
    }
  } catch { saved = null; }
  if (params.has('grade') || params.has('gradesat')) {
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
  if (saved?.preset === 'file' && saved.cubeText) {
    try {
      setGradeCube(saved.cubeText, saved.cubeName);
      return;
    } catch { /* a stored file that no longer parses falls through to the preset */ }
  }
  state.preset = saved?.preset in PRESETS ? saved.preset : GRADE_DEFAULTS.preset;
  upload(PRESETS[state.preset] ? tableFrom(PRESETS[state.preset]) : null);
  applyUniforms();
})();

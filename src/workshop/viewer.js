// The model workshop's bench — /workshop/, not part of the game. See docs/workshop.md.
//
// One model from the catalog on a patch of asphalt, under the game's own sky, sun and daylight,
// seen either up close on an orbit or through the game's fixed 3/4 camera.
//
// **This module is its own hot-reload boundary.** It accepts itself, so an edit to anything in its
// import graph — a builder in geometry/, the palette, the scene — re-runs this whole file against
// the new code instead of reloading the page. `dispose` tears the old renderer down and hands the
// camera to the new run through `import.meta.hot.data`, so the bench comes back framed where you
// left it with the edit in it. The chat lives in a separate module (chat.js) that imports nothing
// from the game, so the conversation never goes down with the model.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createScene } from '../game/scene.js';
import { createDaylight, DAY_SECONDS } from '../game/daylight.js';
import { createCityCamera, aimAtHeight, PLAY_ZOOM, VIEW_DIR } from '../game/camera.js';
import { findZFighting, describeZFighting } from '../util/zfight.js';
import { bakeColor, propMaterial, unlitMaterial, setClassicPaint, setPaintLook, rimTuning, setRimTuning } from '../util/geo.js';
import { markOccluder, unmarkOccluder } from '../game/ssao.js';
import { markEmissive, unmarkEmissive } from '../game/bloom.js';
import { renderBudget, decideLooks, createRenderPath } from '../game/renderpath.js';
import { createRain } from '../game/rain.js';
import { setCityLights } from '../game/citylights.js';
import { setRunningLights } from '../sim/traffic.js';
import { makeRng } from '../util/rng.js';
import { PALETTE } from '../palette.js';
import { CATALOG, byId } from './catalog.js';
import { createComposer } from './composer.js';

const hot = import.meta.hot;
// What a hot re-run hands to the next one (`hot.data`), or, after the full reload a shared-state edit
// forces (see the `vite:beforeUpdate` hook at the bottom), the same things from sessionStorage.
const STASH = 'workshop-viewer-stash';
const kept = hot?.data?.orbit ? hot.data : (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STASH));
    sessionStorage.removeItem(STASH);
    // A bench URL naming another model (`?model=`) is a different subject: its framing is not ours.
    const wanted = new URLSearchParams(window.location.search).get('model');
    return saved && (!wanted || wanted === saved.model) ? saved : {};
  } catch { return {}; }
})();
const params = new URLSearchParams(window.location.search);

// The game's `?paint=` looks (util/geo.js, PAINT_LOOK_NUMBERS and PAINT_CLASSIC), real first because
// it is the game's default (PAINT_LOOK_DEFAULT) — the bench opened on toon after the game had moved
// on, so a model looked different here than in play. Same param name as the game, so a bench URL
// pastes straight into a game URL.
const PAINTS = ['real', 'rim', 'toon', 'layered', 'chameleon', 'satin', 'classic'];
const DEFAULT_PAINT = PAINTS[0];

// Weather, for previewing lamps: the game's own switches (`setCityLights`, `setRunningLights`, a
// model's `lamps`) thrown by hand. Squall is the shower storm's grade and falling rain with the
// lights on; night is the day clock parked in the dark with the lights on.
const WEATHERS = ['day', 'squall', 'night'];
const NIGHT_HOUR = 22;

const state = {
  weather: WEATHERS.includes(params.get('weather')) ? params.get('weather') : 'day',
  model: byId(params.get('model') ?? kept.model ?? 'taxi').id,
  paint: PAINTS.includes(params.get('paint')) ? params.get('paint') : DEFAULT_PAINT,
  hour: Number.isFinite(Number(params.get('hour'))) && params.has('hour') ? Number(params.get('hour')) : 16.4,
  spin: params.get('spin') === '1',
  inset: params.get('inset') !== '0',
  wire: params.get('wire') === '1',
};

const stage = document.getElementById('stage');
const els = {
  model: document.getElementById('model'),
  paint: document.getElementById('paint'),
  weather: document.getElementById('weather'),
  hour: document.getElementById('hour'),
  hourV: document.getElementById('hour-v'),
  spin: document.getElementById('spin'),
  wire: document.getElementById('wire'),
  inset: document.getElementById('inset-toggle'),
  play: document.getElementById('play'),
  insetBox: document.getElementById('inset-box'),
  frame: document.getElementById('frame'),
  reloaded: document.getElementById('reloaded'),
  error: document.getElementById('bench-error'),
  zfight: document.getElementById('bench-zfight'),
};
// Every listener this run adds, so the next run can take them all back off the shared DOM.
const listening = new AbortController();
const on = (target, type, fn) => target.addEventListener(type, fn, { signal: listening.signal });

// --- Renderer and world -----------------------------------------------------

// **The game's rendering path, not a copy of it** (game/renderpath.js): the same budget off the
// same URL flags, the same look decisions baked into every material, and the same passes run in
// the same order — AO prepass, rim depth, bloom, then the frame. The bench's own copy drifted:
// it stayed on toon paint after the game moved to real, and drew no rim and no AO because both
// read a depth prepass the bench had never been given. Every game flag works here too
// (`?ao=off`, `?crayon`, `?bloom=off`, ...), since it is the same code reading them. Decided
// before any mesh exists, as main.js does, because `propMaterial` bakes all of it into the shader.
//
// What the bench keeps of its own: a 2048 shadow map whatever the budget says (pulled in to one
// block, below), a pixel-ratio cap of 2 rather than the player's Quality setting, and the paint
// dropdown, applied over `decideLooks` by `applyPaint`.
const budget = renderBudget();
decideLooks(budget);
const renderer = new THREE.WebGLRenderer({ antialias: budget.msaa, stencil: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.prepend(renderer.domElement);
const renderPath = createRenderPath(renderer, budget, {
  onNotice: (text) => console.info(`[workshop] ${text}`),
});

const { scene, sun, hemi, sky, fog } = createScene({ shadowMapSize: 2048 });
renderPath.addOverlays(scene);
// The scene's shadow camera covers the whole city (±MAX_SPAN · 1.05), which is 0.12 units a texel.
// A car is 3.4 long, so on the bench that is a shadow with about thirty texels in it; the bench is
// never more than a block, so the frustum is pulled in to one and the texels come out ~6× finer.
const BENCH_SHADOW = 24;
Object.assign(sun.shadow.camera, { left: -BENCH_SHADOW, right: BENCH_SHADOW, top: BENCH_SHADOW, bottom: -BENCH_SHADOW });
sun.shadow.camera.updateProjectionMatrix();

const daylight = createDaylight({ sun, hemi, sky, fog }, state.hour);
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);

// The bench: a round pad of road under the model, sized to it in `load` (BENCH_SPAN times the
// model's own footprint across) and faded out to the sky over its outer part, so the model reads
// as on a stand rather than at the edge of an endless car park. A unit disc scaled per model, so a
// hot reload or a model switch never rebuilds it. Baked rather than tinted on the material:
// `propMaterial` reads vertex colours, and a geometry without any draws black.
//
// The fade is an alphaMap, not a colour ramp, because what lies past the rim is the sky's gradient
// and no single colour fades into it. Transparent, so `ao: false` (CLAUDE.md: a transparent prop
// receives occlusion it can never cast), and no depth write so it never hides the model's shadow
// side from below. Solid out to FADE_FROM of the radius; the texture is radial, so UVs of 0.5 at
// the centre and 0 or 1 at the rim read it directly.
const BENCH_SPAN = 3;
const FADE_FROM = 0.5;
function fadeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d');
  const ramp = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  ramp.addColorStop(0, '#fff');
  ramp.addColorStop(FADE_FROM, '#fff');
  ramp.addColorStop(1, '#000');
  g.fillStyle = ramp;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}
const groundMaterial = propMaterial({ ao: false });
groundMaterial.alphaMap = fadeTexture();
groundMaterial.transparent = true;
groundMaterial.depthWrite = false;
// UVs rebuilt from position after baking: `bakeColors` deletes every attribute but position and
// normal, and an alphaMap with no UVs to read it by samples one texel for the whole disc. The first
// cut lost them that way and the pad drew nowhere at all, shadow included.
const groundGeometry = bakeColor(new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2), PALETTE.asphalt);
{
  const pos = groundGeometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let k = 0; k < pos.count; k++) {
    uv[k * 2] = pos.getX(k) / 2 + 0.5;
    uv[k * 2 + 1] = pos.getZ(k) / 2 + 0.5;
  }
  groundGeometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
const ground = new THREE.Mesh(groundGeometry, groundMaterial);
ground.receiveShadow = true;
scene.add(ground);

// A faint grid on the pad, one line per world unit, so a size or a nudge can be read off it. Its
// origin is the bench's: `load` recentres every model on x = z = 0, so the two axis lines cross
// under the model's middle, and they are drawn a little stronger than the rest. Drawn in the
// fragment shader off the world position rather than as line geometry, so a line is the same
// width at any zoom and the pad's size can change per model without a rebuild. It fades from the
// centre out to well inside the pad's own fade, and also wherever its lines get closer than a few
// pixels apart, which is what a 1-unit grid would otherwise turn into at a grazing orbit: moiré.
const GRID_ALPHA = 0.07;
const AXIS_ALPHA = 0.16;
const gridMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uColor: { value: new THREE.Color(PALETTE.benchGrid) },
    uRadius: { value: 10 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vPos;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vPos = world.xz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uRadius;
    varying vec2 vPos;
    void main() {
      vec2 w = fwidth(vPos);
      vec2 cell = abs(fract(vPos - 0.5) - 0.5) / w;
      float line = 1.0 - min(min(cell.x, cell.y), 1.0);
      vec2 axis2 = abs(vPos) / (w * 1.5);
      float axis = 1.0 - min(min(axis2.x, axis2.y), 1.0);
      float dense = 1.0 - smoothstep(0.2, 0.45, max(w.x, w.y));
      float fade = 1.0 - smoothstep(0.1 * uRadius, 0.75 * uRadius, length(vPos));
      float a = max(line * ${GRID_ALPHA.toFixed(3)} * dense, axis * ${AXIS_ALPHA.toFixed(3)}) * fade;
      gl_FragColor = vec4(uColor, a);
      #include <colorspace_fragment>
    }
  `,
});
// A unit square scaled with the pad in `load`, a hair above it: the pad writes no depth, so this
// only has to clear it in draw order and in the depth test against the model, not fight it.
const grid = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), gridMaterial);
grid.position.y = 0.005;
grid.renderOrder = 1;
scene.add(grid);

// --- Cameras ----------------------------------------------------------------

const size = () => ({ w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });
const aspect = () => size().w / size().h;

// Orthographic, like the game's: the AO and the rim both read the prepass's depth as linear world
// units (`far - near` times the packed value), which only holds without a perspective divide, and
// the paint's highlights are shaped for a view direction that is the same across the whole car.
// The orbit's dolly arrives as `camera.zoom`; `foldZoom` moves it into the frustum, because the
// AO's sample rings are sized off `right - left` alone, as the city camera has it.
//
// The standoff and far plane are the game camera's (400, 1400), not whatever clears the model: the
// sky dome is a 900-unit sphere, and a far plane at twice a smaller standoff cut it off, leaving the
// bench on black. The haze is also placed around the 400-unit standoff (`hazeRange`, game/scene.js).
const ORBIT_STANDOFF = 400;
let orbitHalf = kept.orbitHalf ?? 6;   // the frustum's half-height, world units
const orbitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1400);
function orbitFrustum() {
  Object.assign(orbitCamera, { left: -orbitHalf * aspect(), right: orbitHalf * aspect(), top: orbitHalf, bottom: -orbitHalf });
  orbitCamera.updateProjectionMatrix();
}
function foldZoom() {
  if (orbitCamera.zoom === 1) return;
  orbitHalf /= orbitCamera.zoom;
  orbitCamera.zoom = 1;
  orbitFrustum();
}
orbitFrustum();
const orbit = new OrbitControls(orbitCamera, renderer.domElement);
orbit.enableDamping = true;
orbit.autoRotateSpeed = 1.6;

const game = createCityCamera(aspect(), { zoom: 12 });
let gameZoom = kept.gameZoom ?? null;

const activeCamera = () => orbitCamera;

// The game-zoom inset: the same camera again, drawn into a corner of the same canvas at the
// density the game plays at, so a tweak made in close-up can be judged at the size it will be seen.
// `PLAY_ZOOM` is a frustum half-height, so the game's pixels per unit depend on its window: this
// takes the 7.7 px/unit every effect in docs/rendering.md is sized against (an ~800 px-tall
// window) rather than the bench's own height, which would make the inset as big as the bench.
// Same renderer, same scene, a scissored second pass — a second WebGL context would need a second
// copy of every geometry and shader, rebuilt on every hot reload.
const PLAY_PX_PER_UNIT = 7.7;
// 200 × 140 CSS px (index.html's #inset-box): a tighter crop than the 300 × 210 it opened at, at the
// same density, so a car fills more of it while a block-sized landmark still fits.
const INSET = { w: 200, h: 140, margin: 14 };
const insetCanvas = document.getElementById('inset-canvas');
const insetCtx = insetCanvas.getContext('2d');
const inset = createCityCamera(INSET.w / INSET.h, { zoom: INSET.h / (2 * PLAY_PX_PER_UNIT) });
// Checked, not assumed: the 7.7 is PLAY_ZOOM's own density at an 800 px window, and the two
// should drift apart only if one of them moves.
console.assert(Math.abs(800 / (2 * PLAY_ZOOM) - PLAY_PX_PER_UNIT) < 0.1, 'PLAY_PX_PER_UNIT no longer matches PLAY_ZOOM');

// --- The model --------------------------------------------------------------

let current = null;       // { object, update, box }
const box = new THREE.Box3();

function disposeObject(root) {
  root.traverse((node) => {
    node.geometry?.dispose();
    const list = Array.isArray(node.material) ? node.material : (node.material ? [node.material] : []);
    list.forEach((m) => m.dispose());
  });
}

/**
 * `box` fitted to what actually draws. `Box3.setFromObject` counts every mesh, and a model can
 * carry geometry that never renders: the taxi's tap target is a 6.5-unit box under an invisible
 * material, hung 0.33 below the road, and measured with the rest it sat the car 0.33 in the air
 * with its shadow on the bench beneath it.
 */
function fitDrawn(object) {
  box.makeEmpty();
  object.traverseVisible((node) => {
    if (!node.geometry) return;
    const list = Array.isArray(node.material) ? node.material : [node.material];
    if (list.some((m) => m && m.visible)) box.expandByObject(node);
  });
  if (box.isEmpty()) box.setFromObject(object);
  return box;
}

/**
 * The model's own materials only, never the bench's: the ground stays solid so the wires have a
 * floor to read against. Every model is built fresh by `load` and disposed with it, so flipping
 * its materials cannot leak into the next one; `wireframe` is a draw mode, not part of the
 * program key, so toggling it compiles nothing.
 */
function applyWire() {
  current?.holder.traverse((node) => {
    const list = Array.isArray(node.material) ? node.material : (node.material ? [node.material] : []);
    for (const m of list) if ('wireframe' in m) m.wireframe = state.wire;
  });
}

/**
 * The paint look is baked into the shader `propMaterial` builds (it is part of the program key), so
 * flipping it means setting it *before* building and then rebuilding the model — the same order
 * main.js takes it in, before any vehicle is meshed. Classic is its own switch in geo.js rather
 * than a look, so the two are set together.
 */
function applyPaint() {
  setClassicPaint(state.paint === 'classic');
  setPaintLook(state.paint === 'classic' ? null : state.paint);
  // The rim line is worn by every look but classic (util/geo.js, `rimPaintOn`), so its sliders
  // would move nothing there.
  document.getElementById('rim-box').hidden = state.paint === 'classic';
  // Each look sets its own rim width, so the sliders follow it.
  syncRim();
}

// The rim light's live numbers (util/geo.js `setRimTuning`), the same rows as the game's ⚙️ panel:
// uniforms, so they move the paint without a rebuild. Reset goes back to what they read when this
// run started.
const RIM_FIELDS = [
  ['width', 'Width', 1, 12, 0.5, 1],
  ['strength', 'Strength', 0, 8, 0.05, 2],
  ['sky', 'Sky', 0, 2, 0.05, 2],
  ['carColour', 'Car colour', 0, 1, 0.05, 2],
  ['gap', 'Depth gap', 0.05, 2, 0.05, 2],
  ['glintCut', 'Glint cut', 0.97, 1.001, 0.001, 3],
  ['sheenCut', 'Sheen cut', 0.8, 1.01, 0.005, 3],
  ['flip', 'Flip colour', 0, 1, 0.05, 2],
  ['flipPower', 'Flip falloff', 0.5, 4, 0.1, 1],
  ['streaks', 'Streaks', 0, 2, 0.05, 2],
];
const rimInputs = [];
function syncRim() {
  const now = rimTuning();
  for (const { key, input, value, digits } of rimInputs) {
    input.value = String(now[key]);
    value.value = Number(now[key]).toFixed(digits);
  }
}

/**
 * Makes a slider's readout a field you can type into. A committed number goes through the range
 * itself, so it clamps and snaps to the slider's own min, max and step, and the slider's `input`
 * handler stays the one place a change lands. Enter or leaving the field commits; Escape, or
 * anything that doesn't parse, puts the readout back.
 */
function bindReadout(range, field, parse = Number) {
  field.spellcheck = false;
  let cancel = false;
  on(field, 'focus', () => field.select());
  on(field, 'keydown', (event) => {
    if (event.key === 'Enter') field.blur();
    else if (event.key === 'Escape') { cancel = true; field.blur(); }
  });
  on(field, 'blur', () => {
    const v = cancel ? NaN : parse(field.value.trim());
    cancel = false;
    if (Number.isFinite(v)) range.value = String(v);
    range.dispatchEvent(new Event('input'));
  });
}
{
  const rows = document.getElementById('rim-rows');
  rows.replaceChildren();
  const start = rimTuning();
  for (const [key, text, min, max, step, digits] of RIM_FIELDS) {
    const label = document.createElement('label');
    label.className = 'slider';
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step });
    const value = document.createElement('input');
    Object.assign(value, { className: 'value', type: 'text', inputMode: 'decimal' });
    value.setAttribute('aria-label', text);
    label.append(text, input, value);
    rows.append(label);
    rimInputs.push({ key, input, value, digits });
    on(input, 'input', () => {
      setRimTuning(key, Number(input.value));
      value.value = Number(input.value).toFixed(digits);
      saveRim();
    });
    bindReadout(input, value);
  }
  // Kept in localStorage so a reload keeps the sliders, and echoed as a warning because the page
  // forwards warnings to .workshop/console.log, which is how the chat reads the numbers back.
  let saveTimer = 0;
  function saveRim() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const json = JSON.stringify(rimTuning());
      localStorage.setItem('workshop.rim', json);
      console.warn(`[rim-tuning] ${json}`);
    }, 400);
  }
  try {
    const saved = JSON.parse(localStorage.getItem('workshop.rim') ?? 'null');
    for (const [key, v] of Object.entries(saved ?? {})) if (key in start && Number.isFinite(v)) setRimTuning(key, v);
  } catch { /* a stale or hand-edited entry is not worth a broken bench */ }
  syncRim();
  on(document.getElementById('rim-reset'), 'click', () => {
    for (const [key] of RIM_FIELDS) setRimTuning(key, start[key]);
    syncRim();
    saveRim();
  });
}

function showError(error) {
  els.error.style.display = error ? 'block' : 'none';
  els.error.textContent = error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : '';
}

// Where the current model was set on the bench ({ id, x, y, z }), handed to the next run of an edit.
let placement = kept.placement ?? null;
/**
 * A hash of what the model draws: every mesh's vertices, transform, instance matrices and material
 * colours, as FNV-1a over their float bits. Carried across an edit so the scan sweep (`startScan`)
 * only runs when the edit actually changed the model; any edit re-runs this module (a chat or
 * composer tweak included), and sweeping the model for those said it had been rebuilt when it had
 * not.
 */
function fingerprint(root) {
  let h = 0x811c9dc5;
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const mix = (n) => { h = Math.imul(h ^ n, 0x01000193) >>> 0; };
  const floats = (arr, count = arr.length) => {
    for (let i = 0; i < count; i++) { f32[0] = arr[i]; mix(u32[0]); }
  };
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh && !o.isLine && !o.isPoints) return;
    floats(o.matrixWorld.elements);
    for (const attr of ['position', 'color']) {
      const a = o.geometry?.attributes?.[attr];
      if (a) floats(a.array);
    }
    if (o.isInstancedMesh) {
      mix(o.count);
      floats(o.instanceMatrix.array, o.count * 16);
      if (o.instanceColor) floats(o.instanceColor.array, o.count * 3);
    }
    for (const m of [o.material].flat()) {
      if (!m) continue;
      if (m.color) floats(m.color.toArray());
      if (m.emissive) floats(m.emissive.toArray());
      mix(m.visible ? 1 : 0);
    }
  });
  return h;
}

function load(id, { keepFraming = false } = {}) {
  if (current) {
    scene.remove(current.holder);
    unmarkOccluder(current.holder);
    unmarkEmissive(current.holder);
    disposeObject(current.holder);
    current = null;
  }
  const entry = byId(id);
  state.model = entry.id;
  els.model.value = entry.id;

  let built;
  try {
    built = entry.build(makeRng(7));
    showError(null);
  } catch (error) {
    console.error(error);
    showError(error);
    return;
  }

  // Recentred on the bench: a landmark comes out of its builder at its block's world position, a
  // car at its own origin. Sat on the ground by its lowest point either way.
  const holder = new THREE.Group();
  holder.add(built.object);
  holder.updateMatrixWorld(true);
  fitDrawn(built.object);
  // An edit that rebuilds the model in place reuses the last run's offset rather than recentring:
  // a part added to one end moves the box's centre, and recentring on it slid the whole model
  // across the viewport under the camera the edit was meant to leave alone.
  const reuse = keepFraming && placement?.id === id ? placement : null;
  const centre = box.getCenter(new THREE.Vector3());
  const shift = reuse ?? { id, x: -centre.x, y: -Math.min(0, box.min.y), z: -centre.z };
  built.object.position.x += shift.x;
  built.object.position.z += shift.z;
  built.object.position.y += shift.y;
  placement = shift;
  holder.updateMatrixWorld(true);
  fitDrawn(built.object);
  // Into the prepass, as main.js puts each vehicle and landmark in; `markOccluder` itself skips
  // what has no business there (tap targets, transparent glass).
  scene.add(markOccluder(holder));
  // And into the bloom's draw list, the lit meshes the entry names at the kinds main.js gives them.
  for (const [mesh, kind] of built.glow ?? []) markEmissive(mesh, kind);

  current = {
    source: entry.source, holder, update: built.update ?? null, lamps: built.lamps ?? null, box: box.clone(),
    print: fingerprint(holder),
  };
  showZFighting(entry, built.object, holder);
  current.lamps?.(state.weather === 'day' ? 0 : 1);
  // "Diameter" as the footprint's diagonal rather than its longer side, so a long car's pad
  // clears its corners by as much as its nose.
  const span = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z);
  ground.scale.setScalar(Math.max(1, (span * BENCH_SPAN) / 2));
  grid.scale.copy(ground.scale);
  gridMaterial.uniforms.uRadius.value = ground.scale.x;
  applyWire();
  if (!keepFraming) frame();
  syncUrl();
}

/**
 * The z-fighting scan `npm run check` runs (tools/zfight.mjs), run on every build of the model —
 * so an edit, the chat's or a hand's, shows its ties the moment it hot-reloads rather than when the
 * background checks come back. Each tie gets a magenta pin where the biggest patch of it is, and a
 * line in the banner. Echoed as a warning too, because the page forwards warnings to
 * .workshop/console.log, which is where the chat's agent reads what went wrong.
 */
function showZFighting(entry, object, holder) {
  let found = [];
  try {
    // Seen as the game sees it: down the fixed view, and at every heading for anything that drives.
    found = findZFighting(object, { view: VIEW_DIR, spin: entry.kind !== 'Landmarks' });
  } catch (error) {
    console.error(error);
  }
  els.zfight.hidden = !found.length;
  if (!found.length) return;
  const lines = describeZFighting(found, 6);
  els.zfight.textContent = `Z-fighting: ${found.length} pair${found.length === 1 ? '' : 's'} of surfaces share a plane\n${lines.join('\n')}`;
  console.warn(`[zfight] ${entry.id}\n${lines.join('\n')}`);
  const pins = new THREE.Group();
  pins.userData.zfight = false;
  const pinMaterial = unlitMaterial({ color: PALETTE.benchZFight, depthTest: false, transparent: true });
  const local = holder.matrixWorld.clone().invert();
  // Sized off the model, so a pin reads on a whole landmark as well as on a parcel.
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).length();
  const radius = Math.max(0.05, size * 0.012);
  for (const f of found) {
    const pin = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 6), pinMaterial);
    pin.position.copy(f.at).applyMatrix4(local);
    pin.renderOrder = 10;
    pins.add(pin);
  }
  holder.add(pins);
}

/** Put the whole model in view, from the game's own diagonal. */
function frame() {
  if (!current) return;
  const sphere = current.box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(1, sphere.radius);
  // The game camera looks down VIEW_DIR from +x, +y, +z; the orbit starts from the same side so
  // the first thing you see is the face the player sees.
  const dir = new THREE.Vector3(1, 0.9, 1).normalize();
  orbit.target.copy(sphere.center);
  orbitCamera.position.copy(sphere.center).addScaledVector(dir, ORBIT_STANDOFF);
  orbitCamera.zoom = 1;
  orbitHalf = (r * 1.15) / Math.min(1, aspect());
  orbitFrustum();
  orbit.update();
  gameZoom = Math.max(4, r * 1.4);
  applyGame();
}

function applyGame() {
  if (!current) return;
  const c = current.box.getCenter(new THREE.Vector3());
  const aim = aimAtHeight(c.x, c.y, c.z);
  game.cutTo(aim.x, aim.z, gameZoom ?? 12, 0, aspect());
  inset.cutTo(aim.x, aim.z, INSET.h / (2 * PLAY_PX_PER_UNIT), 0, INSET.w / INSET.h);
}

// --- Panel ------------------------------------------------------------------

function buildPicker() {
  els.model.replaceChildren();
  const groups = new Map();
  for (const entry of CATALOG) {
    if (!groups.has(entry.kind)) {
      const g = document.createElement('optgroup');
      g.label = entry.kind;
      groups.set(entry.kind, g);
      els.model.append(g);
    }
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    groups.get(entry.kind).append(option);
  }
  els.paint.replaceChildren(...PAINTS.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name[0].toUpperCase() + name.slice(1);
    return option;
  }));
}

// The hour the day was at before night took the clock, so Day and Squall hand it back.
let dayHour = state.weather === 'night' ? 16.4 : state.hour;
// Built the first time Squall is chosen: it is a mirror target and a few thousand streaks, and the
// shower mood is the game's default squall look.
let rain = null;

function applyWeather() {
  const level = state.weather === 'day' ? 0 : 1;
  if (state.weather === 'squall' && !rain) {
    rain = createRain(renderer, { enabled: true, mood: 'shower' });
    rain.addTo(scene);
    daylight.setGrade(rain.grade);
  }
  // Wet stays 0: the bench's ground is not the game's patched one, so a mirror pass would only
  // draw the model a second time for nothing. Lens 0 for the same reason, the drops are the taxi's.
  rain?.setWeather({ dark: state.weather === 'squall' ? 1 : 0, rain: state.weather === 'squall' ? 1 : 0, wet: 0, lens: 0 });
  setCityLights(level);
  setRunningLights(level);
  current?.lamps?.(level);
  if (state.weather === 'night') {
    if (state.hour !== NIGHT_HOUR) dayHour = state.hour;
    state.hour = NIGHT_HOUR;
  } else {
    state.hour = dayHour;
  }
  daylight.state.hour = state.hour;
  daylight.apply();
  if (rain) rain.setSunDir(sun.position);
}

function syncPanel() {
  els.paint.value = state.paint;
  els.weather.value = state.weather;
  els.hour.value = String(state.hour);
  els.hourV.value = formatHour(state.hour);
  els.spin.checked = state.spin;
  els.wire.checked = state.wire;
  // Minimized rather than hidden: the frame stays as a tab so the restore button has somewhere to be.
  els.insetBox.classList.toggle('min', !state.inset);
  els.inset.textContent = state.inset ? '–' : '+';
  els.inset.title = state.inset ? 'Minimize' : 'Restore';
  els.inset.setAttribute('aria-label', state.inset ? 'Minimize game zoom' : 'Restore game zoom');
  orbit.autoRotate = state.spin;
}

function formatHour(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

// The hour's readout takes what it shows, "16:30", as well as a plain "16.5".
function parseHour(text) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  return m ? Number(m[1]) + Number(m[2]) / 60 : Number(text);
}

function syncUrl() {
  const q = new URLSearchParams(window.location.search);
  q.set('model', state.model);
  if (state.paint !== DEFAULT_PAINT) q.set('paint', state.paint); else q.delete('paint');
  q.delete('view');
  q.set('hour', state.hour.toFixed(1));
  if (state.weather !== 'day') q.set('weather', state.weather); else q.delete('weather');
  if (state.spin) q.set('spin', '1'); else q.delete('spin');
  if (state.wire) q.set('wire', '1'); else q.delete('wire');
  if (state.inset) q.delete('inset'); else q.set('inset', '0');
  window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
}

on(els.model, 'change', () => load(els.model.value));
on(els.paint, 'change', () => {
  state.paint = els.paint.value;
  applyPaint();
  load(state.model, { keepFraming: true });
});
on(els.weather, 'change', () => {
  state.weather = els.weather.value;
  applyWeather();
  syncPanel();
  syncUrl();
});
on(els.hour, 'input', () => {
  state.hour = Number(els.hour.value);
  if (state.weather !== 'night') dayHour = state.hour;
  daylight.state.hour = state.hour;
  daylight.apply();
  syncPanel();
  syncUrl();
});
bindReadout(els.hour, els.hourV, parseHour);
on(els.spin, 'change', () => {
  state.spin = els.spin.checked;
  syncPanel();
  syncUrl();
});
on(els.wire, 'change', () => {
  state.wire = els.wire.checked;
  applyWire();
  syncUrl();
});
on(els.inset, 'click', () => {
  state.inset = !state.inset;
  syncPanel();
  syncUrl();
});
on(els.frame, 'click', () => frame());
// Play: the real game, booted fresh in a frame over the bench, with the bench's paint look passed
// through as the game's own `?paint=`. The game is its own page with its own hot reload, so an
// edit made from the chat while it is up lands in it the same way it lands here. A new frame every
// time rather than one kept hidden: a hidden game still runs its loop, its audio and a second
// WebGL context, and coming back to the bench should give all of that back. The bench stops
// drawing while the game is up for the same reason. All of it lives in the DOM (the body class and
// the frame), so a hot reload of this module picks it up where the last run left it.
const playing = () => document.body.classList.contains('playing');
function labelPlay() {
  els.play.querySelector('.glyph').textContent = playing() ? '◀' : '▶';
  els.play.querySelector('.label').textContent = playing() ? 'Back to workshop' : 'Play';
}
function setPlaying(on) {
  document.getElementById('game-frame')?.remove();
  document.body.classList.toggle('playing', on);
  labelPlay();
  if (on) {
    const frame = document.createElement('iframe');
    frame.id = 'game-frame';
    frame.title = 'Rocket Rides';
    frame.allow = 'autoplay; fullscreen';
    // The rim sliders ride along as `?rimtune=`, so the game opens on what the bench shows.
    const query = new URLSearchParams();
    // Straight into a run: no startup screen or title menu, no opening vignette, no tutorial bubbles.
    query.set('title', 'off');
    query.set('vignette', 'off');
    query.set('tutorial', 'off');
    if (state.paint !== DEFAULT_PAINT) query.set('paint', state.paint);
    query.set('rimtune', Object.entries(rimTuning()).map(([k, v]) => `${k}:${v}`).join(','));
    frame.src = `/?${query.toString().replace(/%3A/g, ':').replace(/%2C/g, ',')}`;
    // Focused once it has loaded, so the game's keys work without a click into it first.
    frame.addEventListener('load', () => frame.focus(), { once: true });
    stage.append(frame);
  } else {
    resize();
  }
}
// Labels only: a hot reload of this module must not reboot a game that is mid-run.
labelPlay();
on(els.play, 'click', () => setPlaying(!playing()));

// --- Pins: click the model, say what to change there ----------------------------
//
// A click (not a drag — the orbit owns drags) on the bench drops a pin where the ray meets the
// model, and opens a note beside it. Sending the note posts it to the chat with a description of the
// spot attached (chat.js, `__workshopChat.send`), and the screenshot that goes with it has the pin
// drawn into it (`capture` below), so "make this thinner" arrives with a "this".
//
// The description is in the *builder's* coordinates — the hit point taken back through the model's
// own transform, recentring and TAXI_SCALE included — because those are the numbers written in its
// source, and a point in bench space would have the agent undoing our recentring by hand. The
// face's vertex colour is matched back to its palette name for the same reason: `taxiTrim` can be
// grepped for, an RGB triple cannot.

const pinEl = document.getElementById('pin');
const noteEl = document.getElementById('pin-note');
// The note is the chat's own composer (composer.js) — Speed picker, mic and Send included — so a
// pinned message can be dictated or sent to a particular model like any other. Rebuilt with this
// module on every hot reload; the text being typed is handed across (`data.pinText`).
const note = createComposer({
  placeholder: 'What should change here?',
  rows: 2,
  inputId: 'pin-input',
  onSend: sendPin,
  signal: listening.signal,
});
noteEl.replaceChildren(note.el);
if (kept.pinText) note.value = kept.pinText;
let pin = null;           // { point: Vector3 (world), context, label }

const PALETTE_COLORS = Object.entries(PALETTE)
  .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
  .map(([name, v]) => [name, new THREE.Color(v)]);

/** The palette entry nearest a baked vertex colour, or null when nothing is close (a jittered or
 *  lerped colour, say), so a guess is never passed off as a name. */
function paletteName(c) {
  let best = null;
  let bestD = 0.02 ** 2 * 3;
  for (const [name, p] of PALETTE_COLORS) {
    const d = (p.r - c.r) ** 2 + (p.g - c.g) ** 2 + (p.b - c.b) ** 2;
    if (d < bestD) { best = name; bestD = d; }
  }
  return best;
}

const fmt = (v) => `(${v.toArray().map((n) => n.toFixed(2)).join(', ')})`;

function facing(n) {
  const axes = [['+x', n.x], ['-x', -n.x], ['+y (up)', n.y], ['-y (down)', -n.y], ['+z', n.z], ['-z', -n.z]];
  return axes.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/** Draws only: an invisible material is a tap target, a hidden one is switched off. */
function drawnHit(hit) {
  const m = Array.isArray(hit.object.material) ? hit.object.material[hit.face?.materialIndex ?? 0] : hit.object.material;
  if (!m || !m.visible) return false;
  for (let n = hit.object; n; n = n.parent) if (!n.visible) return false;
  return true;
}

const raycaster = new THREE.Raycaster();
function pick(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, activeCamera());
  const model = current ? raycaster.intersectObject(current.holder, true).find(drawnHit) : null;
  if (model) return describeHit(model);
  const floor = raycaster.intersectObject(ground, false)[0];
  if (!floor) return null;
  const root = current?.holder.children[0];
  const local = root ? root.worldToLocal(floor.point.clone()) : floor.point.clone();
  return {
    point: floor.point.clone(),
    label: 'on the bench beside it',
    context: `- on the ground beside the model, not on it — a spot for something new\n`
      + `- in the model's own coordinates: ${fmt(local)} (y is the road)`,
  };
}

function describeHit(hit) {
  const root = current.holder.children[0];
  const local = root.worldToLocal(hit.point.clone());
  const lines = [];
  // The names from the hit mesh up to the model's root, which is how its builder labels its parts.
  const path = [];
  for (let n = hit.object; n && n !== current.holder; n = n.parent) {
    path.unshift(n.name || (n.isMesh ? 'unnamed mesh' : 'group'));
  }
  // Builders that merge their parts (geometry/classics.js `merge`) leave vertex ranges on the
  // geometry; the range holding the hit triangle names the part inside the mesh.
  const range = hit.face && hit.object.geometry.userData.parts?.find((r) => hit.face.a >= r.start && hit.face.a < r.start + r.count);
  if (range) path.push(range.name);
  lines.push(`- part: ${path.join(' > ')}${hit.object.userData.pickable ? ` (pickable: ${hit.object.userData.pickable})` : ''}`);
  // Where to edit it, so nobody greps: a part (or its geometry, or an ancestor) can say which
  // function built it with `userData.src` — e.g. 'src/sim/traffic.js · carGeometry (shared by every
  // car)' — and the model's own builder is always named. Unmarked parts fall back to the latter.
  let partSrc = hit.object.geometry.userData.src;
  for (let n = hit.object; n && !partSrc && n !== current.holder; n = n.parent) partSrc = n.userData.src;
  if (partSrc) lines.push(`- built by: ${partSrc}`);
  if (current.source) lines.push(`- model source: ${current.source}`);
  lines.push(`- point, in the model's own (builder) coordinates: ${fmt(local)}`);
  if (hit.face) {
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    normal.transformDirection(root.matrixWorld.clone().invert());
    lines.push(`- surface faces ${facing(normal)}, normal ${fmt(normal)} in the same coordinates`);
    const colors = hit.object.geometry.attributes.color;
    if (colors) {
      const c = new THREE.Color().fromBufferAttribute(colors, hit.face.a);
      const name = paletteName(c);
      lines.push(`- colour there: ${name ? `PALETTE.${name} (#${new THREE.Color(PALETTE[name]).getHexString()})` : `#${c.getHexString()} linear, no exact palette match`}`);
    }
  }
  const size = current.box.getSize(new THREE.Vector3());
  lines.push(`- for scale, the whole model is ${fmt(size)} across on the bench (world units, scale included)`);
  return { point: hit.point.clone(), label: path.at(-1), context: lines.join('\n') };
}

/** A world point's spot on screen, in the stage's CSS pixels, or null when it is behind the camera. */
function pinScreen(point = pin?.point, camera = activeCamera()) {
  if (!point) return null;
  const p = point.clone().project(camera);
  if (p.z > 1) return null;
  const { w, h } = size();
  return { x: (p.x + 1) / 2 * w, y: (1 - p.y) / 2 * h };
}

// Pins already sent, each up until the reply to its own message is done — messages queue
// (chat.js), so several can be waiting at once. Keyed by the id that rides along with the message
// and comes back on `workshop:run-done`. Their elements are made here, so a hot reload takes the
// old run's off the page and makes its own from `kept.sent`.
const sent = new Map();   // id → { point: Vector3, el }
function addSent(id, point) {
  const el = document.createElement('div');
  el.className = 'pin sent';
  stage.append(el);
  sent.set(id, { point, el });
}
function removeSent(id) {
  sent.get(id)?.el.remove();
  sent.delete(id);
}

function placePin() {
  for (const { point, el } of sent.values()) {
    const s = pinScreen(point);
    el.hidden = !s;
    if (s) el.style.transform = `translate(${s.x}px, ${s.y}px)`;
  }
  const s = pinScreen();
  pinEl.hidden = !s;
  noteEl.hidden = !s;
  if (!s) return;
  pinEl.style.transform = `translate(${s.x}px, ${s.y}px)`;
  // The note sits right of the pin and below it, flipped to the other side at the stage's edges.
  const { w, h } = size();
  const nw = noteEl.offsetWidth;
  const nh = noteEl.offsetHeight;
  const x = s.x + 18 + nw > w - covered - 8 ? s.x - 18 - nw : s.x + 18;
  const y = Math.min(Math.max(8, s.y - 20), h - nh - 8);
  noteEl.style.transform = `translate(${x}px, ${y}px)`;
}

function openPin(found) {
  pin = found;
  note.value = '';
  // "Queue" while the chat is still on a reply, as the chat's own Send says.
  note.setQueued(Boolean(window.__workshopChat?.busy?.()));
  placePin();
  note.autosize();          // measured now it is shown: a hidden box has no height to measure
  note.focus();
}

function closePin() {
  note.stopListening();
  pin = null;
  pinEl.hidden = true;
  noteEl.hidden = true;
}

function sendPin(text) {
  const chatApi = window.__workshopChat;
  if (!text || !pin || !chatApi) return;
  const id = `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // The screenshot is taken now, ring and all, not when the message reaches the front of the
  // queue: by then the camera has moved on, and the ring with it.
  const image = capture(pin.point);
  const crop = captureCrop(pin.point);
  chatApi.send(text, { id, label: pin.label, context: pin.context, image, thumbs: crop ? [crop] : [], speed: note.speedSelect.value });
  // The pin stays up, without its note, so what was asked about is still marked while it waits
  // and while the reply comes in; it comes down when that reply is done.
  addSent(id, pin.point);
  closePin();
  placePin();
}
on(window, 'workshop:run-done', (event) => {
  if (event.detail?.pinId) removeSent(event.detail.pinId);
});

// Click, not drag: a press that travels or lingers is the orbit's.
let press = null;
on(renderer.domElement, 'pointerdown', (event) => {
  press = event.button === 0 ? { x: event.clientX, y: event.clientY, t: performance.now() } : null;
  // A click out of the swatch's colour picker (the browser's popup) or hex field only dismisses
  // that: it lands here too, and used to close the panel and revert the edit along with it.
  if (press && swatch && swatchEl.contains(document.activeElement)) {
    document.activeElement.blur();
    press.swallow = true;
  }
});
on(renderer.domElement, 'pointerup', (event) => {
  if (!press || event.button !== 0) return;
  const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
  const quick = performance.now() - press.t < 450;
  const swallow = press.swallow;
  press = null;
  if (moved > 4 || !quick || swallow) return;
  if (event.metaKey || event.ctrlKey) { openSwatch(event.clientX, event.clientY); return; }
  closeSwatch();
  const found = pick(event.clientX, event.clientY);
  if (found) openPin(found); else closePin();
});
// Enter and Send are the composer's; Escape is the note's own.
on(note.input, 'keydown', (event) => {
  if (event.key === 'Escape') closePin();
});
on(window, 'keydown', (event) => {
  if (event.key === 'Escape' && pin && !event.target.closest?.('textarea:not(#pin-input), input, select')) closePin();
});

// --- ⌘-click colour swatch ----------------------------------------------------
//
// Cmd- (or Ctrl-) clicking the model opens a colour picker on the spot and recolours, live, every
// surface in the model that wears the colour under the cursor. Nearly every colour here is baked
// into vertices (`bakeColor`), not set on a material, so "the material's colour" means *that baked
// colour wherever it appears* — the same paint is one palette entry, and recolouring only the hit
// triangle would show something the palette cannot express. The preview is only ever a preview:
// closing the panel puts the old colour back, and "Save" hands the change to the chat to make in
// palette.js, which is where it actually lives (and whose edit reloads the page with it built in).

const swatchEl = document.getElementById('swatch');
let swatch = null;        // { point, name, from: Color (linear), to, targets, restore() }

/** Everything in the model wearing `c`: vertex colour ranges, instance colours or material colours. */
function wearersOf(hit, c) {
  const close = (r, g, b) => (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2 < 1e-6;
  const targets = [];
  const seen = new Set();   // geometry is shared between meshes (and with the game's own traffic)
  current.holder.traverse((o) => {
    if (!o.isMesh) return;
    // Only the kind of colour that was hit: a white material under vertex colours is not "white".
    const byVertex = Boolean(hit.object.geometry.attributes.color);
    const byInstance = !byVertex && Boolean(hit.object.instanceColor);
    if (byVertex || byInstance) {
      const attr = byVertex ? o.geometry.attributes.color : o.instanceColor;
      if (!attr || seen.has(attr)) return;
      seen.add(attr);
      const at = [];
      for (let i = 0; i < attr.count; i++) if (close(attr.getX(i), attr.getY(i), attr.getZ(i))) at.push(i);
      if (at.length) targets.push({ attr, at });
      return;
    }
    for (const m of [o.material].flat()) {
      if (m?.color && !seen.has(m) && close(m.color.r, m.color.g, m.color.b)) { seen.add(m); targets.push({ material: m }); }
    }
  });
  return targets;
}

function paint(targets, c) {
  for (const t of targets) {
    if (t.material) { t.material.color.copy(c); continue; }
    for (const i of t.at) t.attr.setXYZ(i, c.r, c.g, c.b);
    t.attr.needsUpdate = true;
  }
}

function openSwatch(clientX, clientY) {
  closeSwatch();
  closePin();
  if (!current) return;
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), activeCamera());
  const hit = raycaster.intersectObject(current.holder, true).find(drawnHit);
  if (!hit?.face) return;
  const geoColor = hit.object.geometry.attributes.color;
  const material = [hit.object.material].flat()[hit.face.materialIndex ?? 0];
  const from = geoColor ? new THREE.Color().fromBufferAttribute(geoColor, hit.face.a)
    : hit.object.instanceColor && hit.instanceId != null ? new THREE.Color().fromBufferAttribute(hit.object.instanceColor, hit.instanceId)
      : material?.color?.clone();
  if (!from) return;
  const targets = wearersOf(hit, from);
  const where = describeHit(hit);
  swatch = { point: hit.point.clone(), name: paletteName(from), from, to: from.clone(), targets, where };
  const count = targets.reduce((n, t) => n + (t.at ? t.at.length : 1), 0);
  const unit = targets[0]?.at ? (geoColor ? 'vertices' : 'instances') : 'materials';

  const head = document.createElement('div');
  head.className = 'swatch-head';
  // Just "Edit": the palette name means nothing at a glance, and Save's tooltip still carries it.
  head.textContent = 'Edit';
  head.title = `${count} ${unit} in this model wear this colour`;
  const picker = Object.assign(document.createElement('input'), { type: 'color', value: `#${from.getHexString()}` });
  const hex = Object.assign(document.createElement('input'), { type: 'text', value: `#${from.getHexString()}`, spellcheck: false, size: 7, maxLength: 7 });
  const revert = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel', className: 'act' });
  const save = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Save', className: 'act primary' });
  save.title = swatch.name ? `Ask the chat to set PALETTE.${swatch.name} in palette.js` : 'Ask the chat to make this change in the source';
  const row = document.createElement('div');
  row.className = 'swatch-row';
  row.append(picker, hex);
  const actions = document.createElement('div');
  actions.className = 'swatch-actions';
  actions.append(revert, save);
  swatchEl.replaceChildren(head, row, actions);

  // The input's hex is sRGB and the baked colours are linear; THREE.Color converts both ways.
  const set = (value, from) => {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return;
    swatch.to.set(value);
    paint(targets, swatch.to);
    if (from !== picker) picker.value = value.toLowerCase();
    if (from !== hex) hex.value = value.toLowerCase();
    save.disabled = swatch.to.equals(swatch.from);
  };
  save.disabled = true;
  on(picker, 'input', () => set(picker.value, picker));
  on(hex, 'change', () => set(hex.value.startsWith('#') ? hex.value : `#${hex.value}`, hex));
  on(hex, 'keydown', (event) => { if (event.key === 'Enter') hex.blur(); });
  on(revert, 'click', () => closeSwatch());
  on(save, 'click', saveSwatch);
  placeSwatch();
}

function closeSwatch({ keep = false } = {}) {
  if (!swatch) return;
  if (!keep) paint(swatch.targets, swatch.from);
  swatch = null;
  swatchEl.hidden = true;
  swatchEl.replaceChildren();
}

function saveSwatch() {
  const chatApi = window.__workshopChat;
  if (!swatch || !chatApi || swatch.to.equals(swatch.from)) return;
  const was = `#${swatch.from.getHexString()}`;
  const now = `#${swatch.to.getHexString()}`;
  const what = swatch.name ? `PALETTE.${swatch.name}` : `the ${was} colour here`;
  const text = `Change ${what} to ${now} (was ${was}).`;
  const context = `${swatch.where.context}\n`
    + `- picked live with the ⌘-click colour swatch, which recoloured every surface in this model wearing ${was}; `
    + (swatch.name ? `if PALETTE.${swatch.name} is shared with things that should keep the old colour, give this model its own entry instead` : 'that colour matches no palette entry, so find where it is made');
  chatApi.send(text, { id: `swatch-${Date.now().toString(36)}`, label: what, context, image: capture(swatch.point) });
  // Left showing the new colour: the edit to palette.js reloads the page with it built in.
  closeSwatch({ keep: true });
}

function placeSwatch() {
  if (!swatch) return;
  const s = pinScreen(swatch.point);
  swatchEl.hidden = !s;
  if (!s) return;
  const { w, h } = size();
  const sw = swatchEl.offsetWidth;
  const sh = swatchEl.offsetHeight;
  const x = s.x + 14 + sw > w - covered - 8 ? s.x - 14 - sw : s.x + 14;
  const y = Math.min(Math.max(8, s.y - 20), h - sh - 8);
  swatchEl.style.transform = `translate(${x}px, ${y}px)`;
}
on(window, 'keydown', (event) => {
  if (event.key === 'Escape' && swatch) closeSwatch();
});

// `.` hides every panel and leaves just the viewport. Kept on the body's class rather than in
// `state`, so it survives a hot reload of this module without being handed across. Not while
// typing — a full stop in the chat is a full stop.
on(window, 'keydown', (event) => {
  if (event.key !== '.' || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  document.body.classList.toggle('bare');
  // The chat no longer covers the stage, and on a wide screen the stage itself doesn't change
  // size, so the observer never fires: re-measure by hand.
  resize();
});
// Fold and unfold the bench's panels. The state is a class on the panel, so it survives a hot reload
// of this module; the column is a flex stack (index.html), so the panels below reflow by themselves.
on(document.getElementById('bench'), 'click', (event) => {
  const toggle = event.target.closest?.('.panel-toggle');
  if (!toggle) return;
  const panel = toggle.closest('.panel');
  const folded = panel.classList.toggle('collapsed');
  const name = panel.dataset.name;
  toggle.setAttribute('aria-label', `${folded ? 'Expand' : 'Collapse'} ${name}`);
  toggle.title = folded ? 'Expand' : 'Collapse';
});
// The inset's minimize button shows only while the pointer is over the window (see index.html).
on(window, 'pointermove', (event) => {
  const r = els.insetBox.getBoundingClientRect();
  const over = event.clientX >= r.left && event.clientX <= r.right
    && event.clientY >= r.top && event.clientY <= r.bottom;
  els.insetBox.classList.toggle('hover', over);
});
// `R` reframes, like the Frame button. Not while typing, and not with a modifier (Cmd-R is reload).
on(window, 'keydown', (event) => {
  if (event.key.toLowerCase() !== 'r' || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  frame();
});

// --- Frame loop -------------------------------------------------------------

// How much of the stage's right side the floating chat covers (0 when it is docked underneath,
// on a narrow screen). Both cameras are shifted by half of it with a view offset, so the model
// centres in the part of the bench you can see and the canvas still runs on under the chat.
let covered = 0;
function measureCovered(w) {
  const chat = document.getElementById('chat')?.getBoundingClientRect();
  return chat && chat.left > w / 2 ? Math.max(0, w - chat.left) : 0;
}

function resize() {
  const { w, h } = size();
  covered = measureCovered(w);
  renderer.setSize(w, h);
  orbitFrustum();
  orbitCamera.setViewOffset(w, h, covered / 2, 0, w, h);
  game.camera.setViewOffset(w, h, covered / 2, 0, w, h);
  game.resize(w / h);
  els.insetBox.style.right = `${covered + INSET.margin}px`;
}
const resizer = new ResizeObserver(resize);
resizer.observe(stage);

// The model's counterpart of the panels' `.ui-changed` sweep: when an edit lands, a scan-lined
// plane with a bright rim rises through the model from its feet to its top, the same cyan as the
// panels' line, so you can see the geometry was rebuilt. Depth-tested, so it cuts *through* the
// model rather than floating over it, and additive so it never hides what it passes.
const SCAN_SECONDS = 0.9;
const SCAN_COLOUR = 0x82e1ff;
let scan = null;
function startScan() {
  if (!current) return;
  stopScan();
  const b = current.box;
  const size = b.getSize(new THREE.Vector3());
  const w = Math.max(size.x, size.z) * 1.25;
  const stripes = document.createElement('canvas');
  stripes.width = stripes.height = 8;
  const g = stripes.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 8, 2);
  const tex = new THREE.CanvasTexture(stripes);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.repeat.set(w * 2, w * 2);
  const fill = unlitMaterial({
    color: SCAN_COLOUR, map: tex, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, w).rotateX(-Math.PI / 2), fill);
  const h = w / 2;
  const rim = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([[-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h]].map((p) => new THREE.Vector3(...p))),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  const group = new THREE.Group();
  group.add(plane, rim);
  group.position.set((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
  group.renderOrder = 10;
  scene.add(group);
  scan = { group, fill, rim, tex, t: 0, y0: b.min.y, y1: b.max.y };
}
function stopScan() {
  if (!scan) return;
  scene.remove(scan.group);
  scan.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  scan.tex.dispose();
  scan = null;
}
function updateScan(dt) {
  if (!scan) return;
  scan.t += dt / SCAN_SECONDS;
  if (scan.t >= 1) return stopScan();
  // Eased so it leaves the ground quickly and settles at the top, and faded over the last third.
  const e = 1 - (1 - scan.t) ** 2;
  scan.group.position.y = scan.y0 + (scan.y1 - scan.y0) * e;
  const fade = Math.min(1, (1 - scan.t) * 3);
  scan.fill.opacity = 0.5 * fade;
  scan.rim.material.opacity = 0.95 * fade;
}

const clock = new THREE.Clock();
let raf = 0;
let elapsed = 0;
function tick() {
  raf = requestAnimationFrame(tick);
  if (playing()) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  updateScan(dt);
  orbit.update();
  foldZoom();
  try {
    current?.update?.(dt, elapsed);
  } catch (error) {
    showError(error);
    current.update = null;
  }
  // The streaks fall on the rain's own clock, which `render` only reads (it passes 0).
  rain?.update(dt, activeCamera());
  draw();
  placePin();
  placeSwatch();
}

// The inset's camera, stretched to the whole canvas. The AO, the rim's depth and the bloom are all
// full-canvas textures looked up by `gl_FragCoord`, so a view squeezed into a corner viewport would
// read whatever the canvas held at that spot. Instead the inset is drawn with a camera whose frustum runs on past
// the inset's edges by exactly the canvas around it, at the inset's own density, and scissored to
// the corner: inside the scissor it is the inset camera to the pixel, and its prepass lines up.
const insetWide = new THREE.OrthographicCamera();
function wideInset(x, y, w, h) {
  const c = inset.camera;
  insetWide.copy(c);
  const left = c.left / c.zoom;
  const right = c.right / c.zoom;
  const top = c.top / c.zoom;
  const bottom = c.bottom / c.zoom;
  const k = (right - left) / INSET.w;
  Object.assign(insetWide, {
    zoom: 1,
    left: left - x * k,
    right: right + (w - x - INSET.w) * k,
    bottom: bottom - y * k,
    top: top + (h - y - INSET.h) * k,
  });
  insetWide.clearViewOffset();
  insetWide.updateProjectionMatrix();
  return insetWide;
}

/**
 * The inset first, then the main view over the whole canvas. The inset is rendered into its corner
 * of the main canvas and copied straight out into #inset-canvas, whose box rounds the corners; the
 * main view then paints over the spot it was drawn in. The copy has to happen in the same task as
 * the render, before the drawing buffer is presented and cleared.
 */
function draw() {
  const { w, h } = size();
  renderer.setViewport(0, 0, w, h);
  if (state.inset && !document.body.classList.contains('bare')) {
    // Scissor in CSS pixels from the bottom-left; the clear inside `render` is scissored too. The
    // passes render to their own targets, which carry their own (off) scissor, so only the frame
    // itself is clipped.
    const x = w - covered - INSET.w - INSET.margin;
    const y = h - INSET.h - INSET.margin;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, INSET.w, INSET.h);
    renderPath.render(scene, wideInset(x, y, w, h), { rain });
    renderer.setScissorTest(false);
    const src = renderer.domElement;
    const ratio = src.width / w;
    const pw = Math.round(INSET.w * ratio);
    const ph = Math.round(INSET.h * ratio);
    if (insetCanvas.width !== pw || insetCanvas.height !== ph) {
      insetCanvas.width = pw;
      insetCanvas.height = ph;
    }
    // Canvas coordinates run from the top-left, the scissor's from the bottom-left.
    insetCtx.drawImage(src, x * ratio, (h - y - INSET.h) * ratio, pw, ph, 0, 0, pw, ph);
  }
  renderPath.render(scene, activeCamera(), { rain });
}

/** The inset's place on the stage, in CSS pixels from the top-left, for `capture`. */
function insetRect() {
  const { w } = size();
  return { x: w - covered - INSET.w - INSET.margin, y: INSET.margin, w: INSET.w, h: INSET.h };
}

/**
 * What the chat panel reads off the bench each turn: which model, which view, and a picture of
 * exactly that. Rendered here rather than read off the canvas, which a WebGL context without
 * `preserveDrawingBuffer` has already cleared by the time anything else asks. Downscaled to 1024
 * across, because the agent reads it as an image and the full canvas is several megabytes of
 * base64 per message for no detail it can use.
 */
window.__workshop = {
  model: () => {
    const entry = byId(state.model);
    return { id: entry.id, label: entry.label, source: entry.source };
  },
  view: () => 'orbit',
  capture: () => capture(pin?.point),
};

/**
 * A square of the bench around `mark`, ring at its centre: the thumbnail that rides on a pinned
 * message's bubble so the note can be tied back to the spot it was about. Taken from the live
 * canvas at its own pixel density, so it is sharper than the 1024-wide shot the agent gets.
 */
function captureCrop(mark, side = 220, px = 240) {
  const s = pinScreen(mark);
  if (!s) return null;
  draw();
  const src = renderer.domElement;
  const k = src.width / size().w;
  const out = document.createElement('canvas');
  out.width = px;
  out.height = px;
  const g = out.getContext('2d');
  g.fillStyle = '#10151a';
  g.fillRect(0, 0, px, px);
  g.drawImage(src, (s.x - side / 2) * k, (s.y - side / 2) * k, side * k, side * k, 0, 0, px, px);
  g.lineWidth = 3;
  for (const [colour, r] of [['rgba(0, 0, 0, 0.6)', 13], ['#eef3f7', 11]]) {
    g.strokeStyle = colour;
    g.beginPath();
    g.arc(px / 2, px / 2, r, 0, Math.PI * 2);
    g.stroke();
  }
  return out.toDataURL('image/jpeg', 0.8);
}

/** The bench as it stands, with a ring drawn at `mark` (a world point) if there is one. */
function capture(mark) {
  draw();
  const src = renderer.domElement;
  const scale = Math.min(1, 1024 / src.width);
  const out = document.createElement('canvas');
  out.width = Math.round(src.width * scale);
  out.height = Math.round(src.height * scale);
  const g = out.getContext('2d');
  g.drawImage(src, 0, 0, out.width, out.height);
  // The inset lives in its own canvas now, so it is drawn back over its corner, rounded as on screen.
  if (state.inset && !document.body.classList.contains('bare')) {
    const k = out.width / size().w;
    const r = insetRect();
    g.save();
    g.beginPath();
    g.roundRect(r.x * k, r.y * k, r.w * k, r.h * k, 12 * k);
    g.clip();
    g.drawImage(insetCanvas, r.x * k, r.y * k, r.w * k, r.h * k);
    g.restore();
  }
  // The pin, drawn in: the DOM one is not part of the canvas. A ring rather than a dot so the
  // spot itself is still visible inside it.
  const s = pinScreen(mark);
  if (s) {
    const k = out.width / size().w;
    g.lineWidth = 3;
    for (const [colour, r] of [['rgba(0, 0, 0, 0.6)', 13], ['#eef3f7', 11]]) {
      g.strokeStyle = colour;
      g.beginPath();
      g.arc(s.x * k, s.y * k, r, 0, Math.PI * 2);
      g.stroke();
    }
  }
  return out.toDataURL('image/png');
}

// --- The last frame, across a reload ------------------------------------------
//
// A reload (an edit Vite cannot swap in place, or the page itself) blanks the tab until the module
// has loaded and the shaders have compiled, and that gap was a flash. So as the page goes away the
// bench's last frame is kept (`stashSnapshot`), index.html's head script puts it back over the stage
// in the very first paint, and this run fades it out once its own first frame is on screen
// (`releaseSnapshot`). Hot swaps never reach it: they keep the old canvas up themselves.

const SNAPSHOT = 'workshop-snapshot';

function stashSnapshot() {
  try {
    if (playing()) return;
    draw();                       // fresh, and in this task: the drawing buffer is cleared after it
    const src = renderer.domElement;
    const scale = Math.min(1, 1280 / src.width);
    const out = document.createElement('canvas');
    out.width = Math.round(src.width * scale);
    out.height = Math.round(src.height * scale);
    out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
    sessionStorage.setItem(SNAPSHOT, out.toDataURL('image/jpeg', 0.75));
  } catch { /* no snapshot: the reload just flashes as it used to */ }
}

function releaseSnapshot() {
  const root = document.documentElement;
  if (!root.classList.contains('has-snapshot')) return;
  // Two frames on, so the new run's first frame has been presented before the old one fades.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.classList.add('snapshot-done');
    setTimeout(() => {
      root.classList.remove('has-snapshot', 'snapshot-done');
      root.style.removeProperty('--snapshot');
    }, 400);
    try { sessionStorage.removeItem(SNAPSHOT); } catch { /* nothing to clear */ }
  }));
}
on(window, 'pagehide', stashSnapshot);
// Any way the page goes away (a full reload Vite does itself, a manual refresh, an edit to the page
// or the chat) hands the framing to the next load. Only the hot-swapping paths used to, so every
// other reload recentred the model and lost the zoom.
function stashFraming() {
  if (!current) return;
  try {
    foldZoom();
    sessionStorage.setItem(STASH, JSON.stringify({
      model: state.model,
      gameZoom,
      orbitHalf,
      placement,
      print: current.print,
      orbit: { position: orbitCamera.position.toArray(), target: orbit.target.toArray() },
    }));
  } catch { /* the framing is lost, the reload still happens */ }
}
on(window, 'pagehide', stashFraming);

// --- An edit lands as a crossfade, and what it changed lights up -------------
//
// An edit to the page or the chat used to blank the tab and pop every panel back in empty, then
// fill them. Two things replace that. The reload becomes a *navigation* to the same URL
// (`reloadSmoothly`), because a cross-document view transition (`@view-transition` in index.html)
// runs on push, replace and traverse but never on a reload; and both module scripts are
// `blocking="render"`, so the new page's first frame is a filled one and the old page holds still
// until then, then crossfades into it. After that, the panels whose box or look the edit actually
// moved get a scan line swept down them (`flashChanged`), so you can see where it landed. The
// comparison is between the page just before the edit and just after: element by element, its
// rounded box and a handful of computed styles, so a new panel, a moved one, a recoloured one all
// count, and the chat's own messages (which change all the time) do not.

const UI_BEFORE = 'workshop-ui-before';
const UI_PROPS = [
  'display', 'color', 'background-color', 'background-image', 'border-top-width', 'border-top-color',
  'border-radius', 'box-shadow', 'font-size', 'font-weight', 'padding', 'gap',
];

/** Every element outside the chat log and the canvases, keyed by its id or else its nearest id'd
 *  ancestor plus tag, class and index, so one new element does not shift every key after it. */
function uiElements() {
  const out = new Map();
  const counts = new Map();
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('#log, #game-frame, .ui-changed, .pin') || el instanceof HTMLCanvasElement) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'OPTION') continue;
    let key = el.id;
    if (!key) {
      const base = `${el.parentElement.closest('[id]')?.id ?? 'body'}>${el.tagName}.${el.className}`;
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      key = `${base}#${n}`;
    }
    out.set(key, el);
  }
  return out;
}

function signature(el) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return `${[r.x, r.y, r.width, r.height].map(Math.round)}|${UI_PROPS.map((p) => cs.getPropertyValue(p)).join('|')}`;
}

function uiSignatures() {
  return Object.fromEntries([...uiElements()].map(([key, el]) => [key, signature(el)]));
}

function flashChanged(before) {
  const changed = [...uiElements()].filter(([key, el]) => before[key] !== signature(el)).map(([, el]) => el);
  // Only the outermost of each changed run: a panel that grew moves everything inside it, and one
  // sweep over the panel says that better than twenty over its rows.
  const set = new Set(changed);
  const roots = changed.filter((el) => {
    for (let up = el.parentElement; up; up = up.parentElement) if (set.has(up)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  });
  for (const el of roots.slice(0, 10)) {
    const r = el.getBoundingClientRect();
    const fx = document.createElement('div');
    fx.className = 'ui-changed';
    Object.assign(fx.style, {
      left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      borderRadius: getComputedStyle(el).borderRadius,
    });
    document.body.append(fx);
    setTimeout(() => fx.remove(), 1600);
  }
}

/** Reload as a same-URL navigation, which can crossfade. The panels' look is kept for the next page. */
function reloadSmoothly() {
  try { sessionStorage.setItem(UI_BEFORE, JSON.stringify(uiSignatures())); } catch { /* no flash, still reloads */ }
  // A hash would make it a same-document jump that reloads nothing.
  if (window.location.hash) return window.location.reload();
  if (window.navigation) window.navigation.navigate(window.location.href, { history: 'replace' });
  else window.location.replace(window.location.href);
  // If the navigation never commits, fall back to the plain reload rather than sit on stale code.
  setTimeout(() => window.location.reload(), 4000);
}

const uiBefore = hot?.data?.ui ?? (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(UI_BEFORE));
    sessionStorage.removeItem(UI_BEFORE);
    return saved;
  } catch { return null; }
})();

// --- Boot, and coming back from an edit -------------------------------------

buildPicker();
applyPaint();
applyWeather();
syncPanel();
resize();
load(state.model, { keepFraming: Boolean(kept.orbit) });
if (kept.orbit) {
  orbit.target.fromArray(kept.orbit.target);
  // Only the direction is kept: under an orthographic camera the distance is just clearance, and
  // pinned to the standoff it can never end up inside a big landmark.
  const dir = new THREE.Vector3().fromArray(kept.orbit.position).sub(orbit.target).normalize();
  orbitCamera.position.copy(orbit.target).addScaledVector(dir, ORBIT_STANDOFF);
  orbit.update();
  applyGame();
  // Only when the model itself came out different: a stash without a print (the page just after
  // this change shipped) sweeps as before.
  if (kept.model !== state.model || kept.print == null || kept.print !== current?.print) startScan();
  els.reloaded.classList.add('show');
  setTimeout(() => els.reloaded.classList.remove('show'), 1200);
}
if (kept.pin) pin = { ...kept.pin, point: new THREE.Vector3().fromArray(kept.pin.point) };
else closePin();
for (const el of stage.querySelectorAll('.pin.sent')) el.remove();
for (const [id, point] of kept.sent ?? []) addSent(id, new THREE.Vector3().fromArray(point));
tick();
releaseSnapshot();
// Once the fonts are in and the crossfade is most of the way through, so the sweep reads over the
// new page rather than under the old one.
if (uiBefore) document.fonts.ready.then(() => setTimeout(() => flashChanged(uiBefore), 220));
// The run this replaced, now that this one has drawn a frame of its own. `forceContextLoss` gives
// the GL context back: a browser holds about sixteen, and an afternoon of edits is more than that.
if (kept.old) {
  kept.old.dispose();
  kept.old.forceContextLoss();
  kept.old.domElement.remove();
}

if (hot) {
  // Spelled out in full rather than as `hot.accept()`: Vite finds a self-accepting module by
  // scanning its source for this exact expression, and through an alias it never sees one — every
  // edit then dead-ends at this module and reloads the page.
  import.meta.hot.accept();
  // **Some edits cannot be hot-swapped, and the symptom is a bench that draws only the sky.** After
  // an edit to the palette the model, the road pad and every lit surface went missing (the grid and
  // the sky, which are not `propMaterial`s, still drew) until the tab was reloaded by hand. Nearly
  // every module imports the palette, so its edit re-evaluates the whole graph under this one at
  // once, against module-level state (the paint uniforms, the AO and bloom draw lists, three's
  // cached programs) that the previous run has just torn down; the cause was never pinned further
  // than that. Reloading is what fixed it, so these edits now do it themselves, carrying the
  // framing across in sessionStorage so the model stays where it was.
  const RELOAD_ON = /\/src\/(palette|util\/geo|game\/(renderpath|ssao|bloom|scene))\.js$/;
  hot.on('vite:beforeUpdate', (payload) => {
    if (!payload.updates.some((u) => RELOAD_ON.test(u.path))) return;
    stashFraming();
    reloadSmoothly();
  });
  // Vite's own full reloads (an edit nothing can hot-swap, the page itself) say so first; `pagehide`
  // would catch them too, but this is earlier and the canvas is still drawn. Vite awaits this
  // listener before its own `location.reload()`, so a promise that never settles takes the reload
  // over and makes it `reloadSmoothly`'s navigation. Only for a reload Vite would have done here:
  // it skips an .html edit that names another page (the same test as its client's).
  hot.on('vite:beforeFullReload', (payload) => {
    stashSnapshot();
    stashFraming();
    const page = decodeURI(window.location.pathname);
    const path = payload?.path;
    if (path?.endsWith('.html') && !(path === page || path === '/index.html' || (page.endsWith('/') && `${page}index.html` === path))) return undefined;
    reloadSmoothly();
    return new Promise(() => {});
  });
  hot.dispose((data) => {
    foldZoom();   // a wheel zoom not yet folded into orbitHalf would otherwise be lost
    data.ui = uiSignatures();
    data.model = state.model;
    data.print = current?.print;
    data.gameZoom = gameZoom;
    data.placement = placement;
    // The pin outlives an edit (the agent's own, often) along with whatever is typed in its note,
    // which the next run's composer is handed, since it builds a fresh one.
    data.pin = pin && { ...pin, point: pin.point.toArray() };
    data.pinText = note.value;
    data.sent = [...sent].map(([id, { point }]) => [id, point.toArray()]);
    data.orbit = { position: orbitCamera.position.toArray(), target: orbit.target.toArray() };
    // An unsaved preview comes off: the geometry it painted may be shared with modules that outlive
    // this run, and the next run's model would come up wearing it.
    closeSwatch();
    cancelAnimationFrame(raf);
    listening.abort();
    resizer.disconnect();
    orbit.dispose();
    data.orbitHalf = orbitHalf;
    // The prepass's and the bloom's draw lists live in game/ssao.js and game/bloom.js, which
    // outlive this run: anything left in them would be drawn into the next run's passes, a freed
    // geometry included.
    unmarkOccluder(scene);
    unmarkEmissive(scene);
    renderPath.dispose();
    if (current) disposeObject(current.holder);
    // The old canvas stays up until the new run has drawn into its own, so an edit doesn't flash
    // the page blue for the frame in between.
    data.old = renderer;
  });
}

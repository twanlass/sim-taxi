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
import { createCityCamera, aimAtHeight, PLAY_ZOOM } from '../game/camera.js';
import { bakeColor, propMaterial, setClassicPaint, setPaintLook } from '../util/geo.js';
import { markOccluder, unmarkOccluder } from '../game/ssao.js';
import { markEmissive, unmarkEmissive } from '../game/bloom.js';
import { renderBudget, decideLooks, createRenderPath } from '../game/renderpath.js';
import { createRain } from '../game/rain.js';
import { setCityLights } from '../game/citylights.js';
import { setRunningLights } from '../sim/traffic.js';
import { makeRng } from '../util/rng.js';
import { PALETTE } from '../palette.js';
import { CATALOG, byId } from './catalog.js';

const hot = import.meta.hot;
// What a hot re-run hands to the next one (`hot.data`), or, after the full reload a shared-state edit
// forces (see the `vite:beforeUpdate` hook at the bottom), the same things from sessionStorage.
const STASH = 'workshop-viewer-stash';
const kept = hot?.data?.orbit ? hot.data : (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STASH));
    sessionStorage.removeItem(STASH);
    return saved ?? {};
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
  view: params.get('view') === 'game' ? 'game' : 'orbit',
  hour: Number.isFinite(Number(params.get('hour'))) && params.has('hour') ? Number(params.get('hour')) : 16.4,
  spin: params.get('spin') === '1',
  inset: params.get('inset') !== '0',
  wire: params.get('wire') === '1',
};

const stage = document.getElementById('stage');
const els = {
  model: document.getElementById('model'),
  paint: document.getElementById('paint'),
  source: document.getElementById('source'),
  views: document.getElementById('views'),
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

const activeCamera = () => (state.view === 'game' ? game.camera : orbitCamera);

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
}

function showError(error) {
  els.error.style.display = error ? 'block' : 'none';
  els.error.textContent = error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : '';
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
  els.source.textContent = entry.source;

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
  const centre = box.getCenter(new THREE.Vector3());
  built.object.position.x -= centre.x;
  built.object.position.z -= centre.z;
  built.object.position.y -= Math.min(0, box.min.y);
  holder.updateMatrixWorld(true);
  fitDrawn(built.object);
  // Into the prepass, as main.js puts each vehicle and landmark in; `markOccluder` itself skips
  // what has no business there (tap targets, transparent glass).
  scene.add(markOccluder(holder));
  // And into the bloom's draw list, the lit meshes the entry names at the kinds main.js gives them.
  for (const [mesh, kind] of built.glow ?? []) markEmissive(mesh, kind);

  current = { holder, update: built.update ?? null, lamps: built.lamps ?? null, box: box.clone() };
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
  for (const b of els.views.querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === state.view);
  els.paint.value = state.paint;
  els.weather.value = state.weather;
  els.hour.value = String(state.hour);
  els.hourV.textContent = formatHour(state.hour);
  els.spin.checked = state.spin;
  els.wire.checked = state.wire;
  // Minimized rather than hidden: the frame stays as a tab so the restore button has somewhere to be.
  els.insetBox.classList.toggle('min', !state.inset);
  els.inset.textContent = state.inset ? '–' : '+';
  els.inset.title = state.inset ? 'Minimize' : 'Restore';
  els.inset.setAttribute('aria-label', state.inset ? 'Minimize game zoom' : 'Restore game zoom');
  orbit.enabled = state.view === 'orbit';
  orbit.autoRotate = state.spin && state.view === 'orbit';
}

function formatHour(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

function syncUrl() {
  const q = new URLSearchParams(window.location.search);
  q.set('model', state.model);
  if (state.paint !== DEFAULT_PAINT) q.set('paint', state.paint); else q.delete('paint');
  if (state.view === 'game') q.set('view', 'game'); else q.delete('view');
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
on(els.views, 'click', (event) => {
  const view = event.target.closest('button')?.dataset.view;
  if (!view) return;
  state.view = view;
  syncPanel();
  syncUrl();
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
    frame.src = state.paint === DEFAULT_PAINT ? '/' : `/?paint=${state.paint}`;
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
const noteInput = document.getElementById('pin-input');
const noteSend = document.getElementById('pin-send');
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
  lines.push(`- part: ${path.join(' > ')}${hit.object.userData.pickable ? ` (pickable: ${hit.object.userData.pickable})` : ''}`);
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
  noteInput.value = '';
  placePin();
  noteInput.focus();
}

function closePin() {
  pin = null;
  pinEl.hidden = true;
  noteEl.hidden = true;
}

function sendPin() {
  const text = noteInput.value.trim();
  const chatApi = window.__workshopChat;
  if (!text || !pin || !chatApi) return;
  const id = `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // The screenshot is taken now, ring and all, not when the message reaches the front of the
  // queue: by then the camera has moved on, and the ring with it.
  const image = capture(pin.point);
  chatApi.send(text, { id, label: pin.label, context: pin.context, image });
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
});
on(renderer.domElement, 'pointerup', (event) => {
  if (!press || event.button !== 0) return;
  const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
  const quick = performance.now() - press.t < 450;
  press = null;
  if (moved > 4 || !quick) return;
  const found = pick(event.clientX, event.clientY);
  if (found) openPin(found); else closePin();
});
on(noteSend, 'click', sendPin);
on(noteInput, 'keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendPin();
  } else if (event.key === 'Escape') {
    closePin();
  }
});
on(window, 'keydown', (event) => {
  if (event.key === 'Escape' && pin && !event.target.closest?.('textarea:not(#pin-input), input, select')) closePin();
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
// The game view zooms on the wheel like the game does; the orbit has its own dolly.
on(renderer.domElement, 'wheel', (event) => {
  if (state.view !== 'game') return;
  event.preventDefault();
  gameZoom = THREE.MathUtils.clamp((gameZoom ?? 12) * Math.exp(event.deltaY * 0.0012), 2, 80);
  applyGame();
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

const clock = new THREE.Clock();
let raf = 0;
let elapsed = 0;
function tick() {
  raf = requestAnimationFrame(tick);
  if (playing()) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  if (state.view === 'orbit') {
    orbit.update();
    foldZoom();
  }
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
  view: () => state.view,
  capture: () => capture(pin?.point),
};

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
  els.reloaded.classList.add('show');
  setTimeout(() => els.reloaded.classList.remove('show'), 1200);
}
if (kept.pin) pin = { ...kept.pin, point: new THREE.Vector3().fromArray(kept.pin.point) };
else closePin();
for (const el of stage.querySelectorAll('.pin.sent')) el.remove();
for (const [id, point] of kept.sent ?? []) addSent(id, new THREE.Vector3().fromArray(point));
tick();
releaseSnapshot();
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
    try {
      sessionStorage.setItem(STASH, JSON.stringify({
        model: state.model,
        gameZoom,
        orbitHalf,
        orbit: { position: orbitCamera.position.toArray(), target: orbit.target.toArray() },
      }));
    } catch { /* the framing is lost, the reload still happens */ }
    window.location.reload();
  });
  // Vite's own full reloads (an edit nothing can hot-swap, the page itself) say so first; `pagehide`
  // would catch them too, but this is earlier and the canvas is still drawn.
  hot.on('vite:beforeFullReload', stashSnapshot);
  hot.dispose((data) => {
    data.model = state.model;
    data.gameZoom = gameZoom;
    // The pin outlives an edit (the agent's own, often) along with whatever is typed in its note,
    // which is the DOM's and survives on its own.
    data.pin = pin && { ...pin, point: pin.point.toArray() };
    data.sent = [...sent].map(([id, { point }]) => [id, point.toArray()]);
    data.orbit = { position: orbitCamera.position.toArray(), target: orbit.target.toArray() };
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

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
import { createCityCamera, aimAtHeight } from '../game/camera.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { PALETTE } from '../palette.js';
import { CATALOG, byId } from './catalog.js';

const hot = import.meta.hot;
const kept = hot?.data ?? {};
const params = new URLSearchParams(window.location.search);

const state = {
  model: byId(params.get('model') ?? kept.model ?? 'taxi').id,
  view: params.get('view') === 'game' ? 'game' : 'orbit',
  hour: Number.isFinite(Number(params.get('hour'))) && params.has('hour') ? Number(params.get('hour')) : 16.4,
  spin: params.get('spin') === '1',
};

const stage = document.getElementById('stage');
const els = {
  model: document.getElementById('model'),
  source: document.getElementById('source'),
  views: document.getElementById('views'),
  hour: document.getElementById('hour'),
  hourV: document.getElementById('hour-v'),
  spin: document.getElementById('spin'),
  frame: document.getElementById('frame'),
  reloaded: document.getElementById('reloaded'),
  error: document.getElementById('bench-error'),
};
// Every listener this run adds, so the next run can take them all back off the shared DOM.
const listening = new AbortController();
const on = (target, type, fn) => target.addEventListener(type, fn, { signal: listening.signal });

// --- Renderer and world -----------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.prepend(renderer.domElement);

const { scene, sun, hemi, sky, fog } = createScene({ shadowMapSize: 2048 });
// The scene's shadow camera covers the whole city (±MAX_SPAN · 1.05), which is 0.12 units a texel.
// A car is 3.4 long, so on the bench that is a shadow with about thirty texels in it; the bench is
// never more than a block, so the frustum is pulled in to one and the texels come out ~6× finer.
const BENCH_SHADOW = 24;
Object.assign(sun.shadow.camera, { left: -BENCH_SHADOW, right: BENCH_SHADOW, top: BENCH_SHADOW, bottom: -BENCH_SHADOW });
sun.shadow.camera.updateProjectionMatrix();

const daylight = createDaylight({ sun, hemi, sky, fog }, state.hour);
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);

// The bench: a slab of road, big enough that its edge stays out of frame at the widest zoom. Baked
// rather than tinted on the material: `propMaterial` reads vertex colours, and a geometry without
// any draws black.
const ground = new THREE.Mesh(
  bakeColor(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), PALETTE.asphalt),
  propMaterial(),
);
ground.receiveShadow = true;
scene.add(ground);

// --- Cameras ----------------------------------------------------------------

const size = () => ({ w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });
const aspect = () => size().w / size().h;

const orbitCamera = new THREE.PerspectiveCamera(35, aspect(), 0.1, 2000);
const orbit = new OrbitControls(orbitCamera, renderer.domElement);
orbit.enableDamping = true;
orbit.autoRotateSpeed = 1.6;

const game = createCityCamera(aspect(), { zoom: 12 });
let gameZoom = kept.gameZoom ?? null;

const activeCamera = () => (state.view === 'game' ? game.camera : orbitCamera);

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

function showError(error) {
  els.error.style.display = error ? 'block' : 'none';
  els.error.textContent = error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : '';
}

function load(id, { keepFraming = false } = {}) {
  if (current) {
    scene.remove(current.holder);
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
  box.setFromObject(built.object);
  const centre = box.getCenter(new THREE.Vector3());
  built.object.position.x -= centre.x;
  built.object.position.z -= centre.z;
  built.object.position.y -= Math.min(0, box.min.y);
  holder.updateMatrixWorld(true);
  box.setFromObject(built.object);
  scene.add(holder);

  current = { holder, update: built.update ?? null, box: box.clone() };
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
  const dist = r / Math.sin(THREE.MathUtils.degToRad(orbitCamera.fov / 2)) * 1.15;
  orbit.target.copy(sphere.center);
  orbitCamera.position.copy(sphere.center).addScaledVector(dir, dist);
  orbit.update();
  gameZoom = Math.max(4, r * 1.4);
  applyGame();
}

function applyGame() {
  if (!current) return;
  const c = current.box.getCenter(new THREE.Vector3());
  const aim = aimAtHeight(c.x, c.y, c.z);
  game.cutTo(aim.x, aim.z, gameZoom ?? 12, 0, aspect());
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
}

function syncPanel() {
  for (const b of els.views.querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === state.view);
  els.hour.value = String(state.hour);
  els.hourV.textContent = formatHour(state.hour);
  els.spin.checked = state.spin;
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
  if (state.view === 'game') q.set('view', 'game'); else q.delete('view');
  q.set('hour', state.hour.toFixed(1));
  if (state.spin) q.set('spin', '1'); else q.delete('spin');
  window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
}

on(els.model, 'change', () => load(els.model.value));
on(els.views, 'click', (event) => {
  const view = event.target.closest('button')?.dataset.view;
  if (!view) return;
  state.view = view;
  syncPanel();
  syncUrl();
});
on(els.hour, 'input', () => {
  state.hour = Number(els.hour.value);
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
on(els.frame, 'click', () => frame());
// The game view zooms on the wheel like the game does; the orbit has its own dolly.
on(renderer.domElement, 'wheel', (event) => {
  if (state.view !== 'game') return;
  event.preventDefault();
  gameZoom = THREE.MathUtils.clamp((gameZoom ?? 12) * Math.exp(event.deltaY * 0.0012), 2, 80);
  applyGame();
});

// --- Frame loop -------------------------------------------------------------

function resize() {
  const { w, h } = size();
  renderer.setSize(w, h);
  orbitCamera.aspect = w / h;
  orbitCamera.updateProjectionMatrix();
  game.resize(w / h);
}
const resizer = new ResizeObserver(resize);
resizer.observe(stage);

const clock = new THREE.Clock();
let raf = 0;
let elapsed = 0;
function tick() {
  raf = requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  if (state.view === 'orbit') orbit.update();
  try {
    current?.update?.(dt, elapsed);
  } catch (error) {
    showError(error);
    current.update = null;
  }
  renderer.render(scene, activeCamera());
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
  capture() {
    renderer.render(scene, activeCamera());
    const src = renderer.domElement;
    const scale = Math.min(1, 1024 / src.width);
    const out = document.createElement('canvas');
    out.width = Math.round(src.width * scale);
    out.height = Math.round(src.height * scale);
    out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  },
};

// --- Boot, and coming back from an edit -------------------------------------

buildPicker();
syncPanel();
resize();
load(state.model, { keepFraming: Boolean(kept.orbit) });
if (kept.orbit) {
  orbitCamera.position.fromArray(kept.orbit.position);
  orbit.target.fromArray(kept.orbit.target);
  orbit.update();
  applyGame();
  els.reloaded.classList.add('show');
  setTimeout(() => els.reloaded.classList.remove('show'), 1200);
}
tick();
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
  hot.dispose((data) => {
    data.model = state.model;
    data.gameZoom = gameZoom;
    data.orbit = { position: orbitCamera.position.toArray(), target: orbit.target.toArray() };
    cancelAnimationFrame(raf);
    listening.abort();
    resizer.disconnect();
    orbit.dispose();
    if (current) disposeObject(current.holder);
    // The old canvas stays up until the new run has drawn into its own, so an edit doesn't flash
    // the page blue for the frame in between.
    data.old = renderer;
  });
}

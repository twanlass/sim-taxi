// Wreck Playground — an internal-only tool for tweaking the taxi explosion.
//
// Not linked from the game and not reachable by any player. This file (and playground.html) exist
// so the four explosion systems can be tuned side by side without a full crash + reload cycle for
// each experiment: sliders write straight into each system's live `cfg`, and structural changes
// (buffer sizes, piece counts) are applied via a Rebuild button.
//
// The transport row (Fire, Pause, Rewind, Reset) treats the burst like a video clip so a specific
// tick can be studied. Copy JSON reads back the current config in a shape you can paste into a
// prompt and have the constants updated in the ship modules.

import * as THREE from 'three';
import { makeRng } from '../util/rng.js';
import { createTaxiMesh } from '../geometry/taxi.js';
import { createDebris, DEBRIS_DEFAULTS } from '../game/debris.js';
import { createFlames, FLAMES_DEFAULTS } from '../game/flames.js';
import { createSmoke, SMOKE_DEFAULTS } from '../game/smoke.js';
import { createSparks, SPARKS_DEFAULTS } from '../game/sparks.js';
import { PALETTE } from '../palette.js';

// --- Scene ------------------------------------------------------------------

const stage = document.getElementById('stage');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#1e2a34');

// A small camera setup, framed on a spot at the origin where the wreck happens. Perspective
// rather than the game's orthographic — a slight parallax reads the pieces' arcs better.
const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 400);
camera.position.set(14, 10, 14);
camera.lookAt(0, 1, 0);

// Approximate the game's lighting so tuned tone matches what will land in the game. The daylight
// module isn't wired in — a single fixed sun is enough for this tool.
const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 1.5);
scene.add(hemi);

const sun = new THREE.DirectionalLight(PALETTE.sun, 3.55);
sun.position.set(20, 30, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -18;
sun.shadow.camera.right = 18;
sun.shadow.camera.top = 18;
sun.shadow.camera.bottom = -18;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(sun.target);

// Asphalt-tinted disc as a stand-in for the road — big enough that a rolling wheel doesn't run off
// the edge at any reasonable slider.
const groundGeo = new THREE.CircleGeometry(40, 48);
groundGeo.rotateX(-Math.PI / 2);
const groundMat = new THREE.MeshLambertMaterial({ color: PALETTE.asphalt });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.receiveShadow = true;
scene.add(ground);

// Faint grid so pieces have a scale reference. 1-unit lines match the game's world units.
const grid = new THREE.GridHelper(30, 30, 0x2a3844, 0x1a2530);
grid.position.y = 0.01;
scene.add(grid);

// The taxi itself — hidden the moment a burst fires, restored on Reset. Uses the same builder as
// the game so the mesh is exactly what the player sees before it explodes.
const taxiBuild = createTaxiMesh();
const taxi = taxiBuild.group;
taxi.castShadow = true;
taxi.traverse((n) => { if (n.isMesh) n.castShadow = true; });
scene.add(taxi);

// --- State ------------------------------------------------------------------

// Snapshot of every module's DEFAULTS at load — used as the reset baseline for the "Reset to
// defaults" button. Deep-cloned so slider edits never mutate the module constant.
const BASELINE = {
  debris: JSON.parse(JSON.stringify(DEBRIS_DEFAULTS)),
  flames: JSON.parse(JSON.stringify(FLAMES_DEFAULTS)),
  smoke:  JSON.parse(JSON.stringify(SMOKE_DEFAULTS)),
  sparks: JSON.parse(JSON.stringify(SPARKS_DEFAULTS)),
  meta: {
    // How the game fires the systems today — burst counts and the follow-up blast delay.
    // Bundled with the export because these are the second half of the recipe.
    sparksCount1: 96,
    smokeCount1: 56,       // smoke's default burst count when no override is passed
    flamesBlastCount1: 48,
    followupDelayMs: 260,
    followupFlamesCount: 32,
    followupSmokeCount: 28,
    followupSparksCount: 32,
  },
};

// Live edited copy. Sliders write straight into these; the module cfgs point at the same values.
const state = JSON.parse(JSON.stringify(BASELINE));

let rng = makeRng(0xC1A5);
let debris = createDebris(scene, rng, state.debris);
let flames = createFlames(scene, rng, state.flames);
let smoke  = createSmoke(scene, rng, state.smoke);
let sparks = createSparks(scene, rng, state.sparks);

// Sliders that change pool composition need the system rebuilt; track them so a change on those
// specific keys flips a Rebuild badge on. (Rebuild wipes any live burst.)
const STRUCTURAL_KEYS = {
  debris: new Set(['chunkCount', 'wheelCount', 'trimCount', 'shrapnelCount',
                   'bodySize', 'cabinSize', 'signSize', 'wheelRadius', 'wheelWidth', 'trimSize']),
  flames: new Set(['maxFlames']),
  smoke:  new Set(['maxPuffs']),
  sparks: new Set(['maxSparks']),
};

let dirty = false;                     // structural change pending
let elapsed = 0;                       // seconds since last burst
let running = false;                   // false = paused / no burst active
let followupTimer = null;

// Push edits into the currently-live module cfgs, so already-flying pieces respond to slider
// moves. Structural keys are read at spawn time only, hence the Rebuild path.
function pushLive() {
  Object.assign(debris.cfg, state.debris);
  Object.assign(flames.cfg, state.flames);
  Object.assign(smoke.cfg, state.smoke);
  Object.assign(sparks.cfg, state.sparks);
}

function rebuildAll() {
  // Nuke old meshes and their GPU-side buffers. THREE cleans up geometries and materials via
  // dispose(); the InstancedMesh's texture-backed matrix is bound to the geometry itself, so
  // disposing it there is enough.
  const disposeSystem = (sys) => {
    if (sys.mesh) {
      scene.remove(sys.mesh);
      sys.mesh.geometry?.dispose?.();
      sys.mesh.material?.dispose?.();
    }
    // Debris exposes individual pieces rather than a single mesh.
    if (sys.pieces) {
      for (const p of sys.pieces) {
        scene.remove(p.mesh);
        p.mesh.geometry?.dispose?.();
        p.material?.dispose?.();
      }
    }
  };
  disposeSystem(debris);
  disposeSystem(flames);
  disposeSystem(smoke);
  disposeSystem(sparks);

  rng = makeRng(0xC1A5);
  debris = createDebris(scene, rng, state.debris);
  flames = createFlames(scene, rng, state.flames);
  smoke  = createSmoke(scene, rng, state.smoke);
  sparks = createSparks(scene, rng, state.sparks);

  dirty = false;
  setRebuildDirty(false);
}

function resetAll() {
  debris.reset();
  flames.reset();
  smoke.reset();
  sparks.reset();
  taxi.visible = true;
  elapsed = 0;
  running = false;
  if (followupTimer) { clearTimeout(followupTimer); followupTimer = null; }
  updateHud();
}

function fireBurst() {
  // Reset first so re-firing plays the clip from a clean slate.
  debris.reset();
  flames.reset();
  smoke.reset();
  sparks.reset();
  if (followupTimer) { clearTimeout(followupTimer); followupTimer = null; }

  taxi.visible = false;
  elapsed = 0;
  running = true;

  sparks.burst(0, 0, state.meta.sparksCount1);
  smoke.burst(0, 0, state.meta.smokeCount1);
  flames.blast(0, 0, state.meta.flamesBlastCount1);
  debris.burst(0, 0);

  // Follow-up flare — the game fires this ~260ms after impact so the crash reads as two thumps
  // rather than one flat pop. Wallclock, same as the game.
  followupTimer = setTimeout(() => {
    flames.blast(0, 0, state.meta.followupFlamesCount);
    smoke.burst(0, 0, state.meta.followupSmokeCount);
    sparks.burst(0, 0, state.meta.followupSparksCount);
  }, state.meta.followupDelayMs);

  updateHud();
}

// --- Panel ------------------------------------------------------------------

const panel = document.getElementById('panel');

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

// Sticky transport bar with the play/pause/rewind controls.
const transport = el('div', { id: 'transport' });
const title = el('h1', { text: 'Wreck Playground' });
const sub = el('div', { class: 'sub', text: 'Live-tune the explosion. Copy JSON to send back to Claude.' });
const buttons = el('div', { class: 'buttons' });
const btnFire   = el('button', { class: 'primary' }); btnFire.textContent = '▶ Fire';
const btnPause  = el('button'); btnPause.textContent = '⏸ Pause';
const btnRewind = el('button'); btnRewind.textContent = '⟲ Rewind';
const btnReset  = el('button'); btnReset.textContent = '⏹ Reset';
buttons.append(btnFire, btnPause, btnRewind, btnReset);

const status = el('div', { class: 'status' });
const statusT = el('span'); statusT.innerHTML = 't <span id="s-t">0.00</span>s';
const statusPill = el('span', { class: 'pill', text: 'idle' });
status.append(statusT, statusPill);

const rebuildRow = el('div', { class: 'toggle-row' });
const rebuildBtn = el('button');
rebuildBtn.textContent = 'Rebuild pools';
rebuildBtn.style.cssText = 'padding:6px 10px;border:0;border-radius:6px;background:#a05426;color:#fff;font-weight:700;cursor:pointer;';
const rebuildHint = el('span', { text: 'Buffer/count changes need this' });
rebuildHint.style.cssText = 'font-size:10px;opacity:0.55;';
rebuildRow.append(rebuildBtn, rebuildHint);
rebuildRow.style.display = 'none';

transport.append(title, sub, buttons, status, rebuildRow);
panel.append(transport);

function setRebuildDirty(on) {
  rebuildRow.style.display = on ? 'flex' : 'none';
  rebuildBtn.textContent = on ? '⚠ Rebuild pools' : 'Rebuild pools';
}

btnFire.addEventListener('click', fireBurst);
btnPause.addEventListener('click', () => {
  running = !running;
  updateHud();
});
btnRewind.addEventListener('click', fireBurst);
btnReset.addEventListener('click', resetAll);
rebuildBtn.addEventListener('click', () => {
  rebuildAll();
  // Snap taxi back — a rebuild resets the pool but doesn't touch the shell.
  taxi.visible = true;
  elapsed = 0;
  running = false;
  updateHud();
});

// --- Slider generation ------------------------------------------------------
// One row per numeric key in DEFAULTS. Ranges are inferred (0 → 2x default, or a sensible floor
// for tiny values), so adding a new tunable in a module makes it show up here automatically.

function inferRange(key, value) {
  if (typeof value === 'string') return null;            // handled separately as color
  if (Array.isArray(value))       return null;            // sizes — skipped in this pass
  const abs = Math.abs(value);
  // Fractions (0..1) — restitution, drag, alpha.
  if (abs > 0 && abs <= 1.5) return { min: 0, max: Math.max(1.5, value * 2), step: 0.01 };
  // Small integers — counts, buffer sizes.
  if (Number.isInteger(value) && abs <= 400) {
    return { min: 0, max: Math.max(4, Math.ceil(value * 2.5)), step: 1 };
  }
  // Everything else — scale up-to 2.5x with a fine step.
  const max = Math.max(1, Math.round(abs * 2.5 * 10) / 10);
  return { min: 0, max, step: Math.max(0.01, Math.round(max / 100 * 100) / 100) };
}

function makeSection(sysName, sysState, host) {
  const heading = el('h3', { text: `${sysName} (${Object.keys(sysState).length})` });
  const body = el('div', { class: 'section-body' });
  heading.addEventListener('click', () => heading.classList.toggle('collapsed'));
  host.append(heading, body);

  for (const [key, value] of Object.entries(sysState)) {
    if (typeof value === 'string' && value.startsWith('#')) {
      const row = el('div', { class: 'row' });
      const lbl = el('label', { text: key });
      const input = el('input', { type: 'color' });
      input.value = value;
      const val = el('span', { class: 'val', text: value });
      input.addEventListener('input', () => {
        sysState[key] = input.value;
        val.textContent = input.value;
        pushLive();
        // Colour is baked into a material at creation time, so a live change needs a rebuild
        // to actually recolour the mesh.
        setRebuildDirty(true);
      });
      row.append(lbl, input, val);
      body.append(row);
      continue;
    }

    if (Array.isArray(value)) {
      // Multi-value size arrays are rare enough to hand off to JSON export rather than eat panel
      // space on three sliders each — a heavy edit here needs a rebuild anyway.
      const row = el('div', { class: 'row' });
      row.append(
        el('label', { text: key }),
        el('span', { class: 'val', text: value.join(', ') }),
        el('span', { class: 'val', text: '(JSON)' }),
      );
      body.append(row);
      continue;
    }

    if (typeof value !== 'number') continue;

    const range = inferRange(key, value);
    if (!range) continue;

    const row = el('div', { class: 'row' });
    const lbl = el('label', { text: key });
    const input = el('input', { type: 'range' });
    input.min = range.min;
    input.max = range.max;
    input.step = range.step;
    input.value = value;
    const val = el('span', { class: 'val', text: String(value) });
    input.addEventListener('input', () => {
      const n = Number(input.value);
      sysState[key] = n;
      val.textContent = range.step >= 1 ? String(n) : n.toFixed(2);
      pushLive();
      if (STRUCTURAL_KEYS[sysName]?.has(key)) {
        dirty = true;
        setRebuildDirty(true);
      }
    });
    row.append(lbl, input, val);
    body.append(row);
  }
}

makeSection('debris', state.debris, panel);
makeSection('flames', state.flames, panel);
makeSection('smoke',  state.smoke,  panel);
makeSection('sparks', state.sparks, panel);

// Firing counts + follow-up timing — the recipe the game uses to compose the four systems.
{
  const heading = el('h3', { text: 'Fire recipe' });
  const body = el('div', { class: 'section-body' });
  heading.addEventListener('click', () => heading.classList.toggle('collapsed'));
  panel.append(heading, body);

  for (const [key, value] of Object.entries(state.meta)) {
    const row = el('div', { class: 'row' });
    const lbl = el('label', { text: key });
    const input = el('input', { type: 'range', min: 0, max: Math.max(16, value * 3), step: 1 });
    input.value = value;
    const val = el('span', { class: 'val', text: String(value) });
    input.addEventListener('input', () => {
      state.meta[key] = Number(input.value);
      val.textContent = input.value;
    });
    row.append(lbl, input, val);
    body.append(row);
  }
}

// Camera framing — separate from the effect config; useful for lining up a specific angle.
{
  const heading = el('h3', { text: 'Camera' });
  const body = el('div', { class: 'section-body' });
  heading.addEventListener('click', () => heading.classList.toggle('collapsed'));
  panel.append(heading, body);

  const mkCam = (label, initial, min, max, step, apply) => {
    const row = el('div', { class: 'row' });
    const input = el('input', { type: 'range', min, max, step });
    input.value = initial;
    const val = el('span', { class: 'val', text: String(initial) });
    input.addEventListener('input', () => {
      const n = Number(input.value);
      val.textContent = step >= 1 ? String(n) : n.toFixed(2);
      apply(n);
    });
    row.append(el('label', { text: label }), input, val);
    body.append(row);
  };

  let camDist = 22;
  let camHeight = 10;
  let camYaw = Math.PI * 0.25;
  const applyCam = () => {
    camera.position.set(
      Math.cos(camYaw) * camDist,
      camHeight,
      Math.sin(camYaw) * camDist,
    );
    camera.lookAt(0, 1, 0);
  };
  applyCam();
  mkCam('distance', camDist, 5, 60, 0.5, (n) => { camDist = n; applyCam(); });
  mkCam('height',   camHeight, 1, 40, 0.5, (n) => { camHeight = n; applyCam(); });
  mkCam('yaw',      camYaw, 0, Math.PI * 2, 0.02, (n) => { camYaw = n; applyCam(); });
  mkCam('fov',      camera.fov, 15, 90, 1, (n) => { camera.fov = n; camera.updateProjectionMatrix(); });
}

// --- Export ------------------------------------------------------------------

const exportSection = el('div', { class: 'export' });
const exportBtn = el('button', { text: 'Copy JSON' });
const exportOut = el('textarea', { readonly: 'true' });
exportSection.append(exportBtn, exportOut);
panel.append(exportSection);

/** The whole live state, laid out for pasting into a prompt. */
function snapshot() {
  return {
    _meta: {
      tool: 'Sim Taxi wreck playground',
      timestamp: new Date().toISOString(),
      note: 'Paste this and ask Claude to update the DEFAULTS blocks in src/game/{debris,flames,smoke,sparks}.js and the crash burst counts in src/main.js.',
    },
    debris: state.debris,
    flames: state.flames,
    smoke:  state.smoke,
    sparks: state.sparks,
    fireRecipe: state.meta,
  };
}

function renderExport() {
  exportOut.value = JSON.stringify(snapshot(), null, 2);
}

exportBtn.addEventListener('click', async () => {
  renderExport();
  try {
    await navigator.clipboard.writeText(exportOut.value);
    exportBtn.textContent = 'Copied ✓';
  } catch {
    exportOut.select();
    exportBtn.textContent = 'Select above and copy';
  }
  setTimeout(() => { exportBtn.textContent = 'Copy JSON'; }, 1600);
});
renderExport();

// --- Frame loop -------------------------------------------------------------

const clock = new THREE.Clock();
const hudT = document.getElementById('hud-t');
const hudMode = document.getElementById('hud-mode');
const statusPillEl = statusPill;
const sTime = statusT.querySelector('#s-t');

function updateHud() {
  const mode = !running ? (elapsed > 0 ? 'paused' : 'idle') : 'playing';
  statusPillEl.textContent = mode;
  statusPillEl.classList.toggle('playing', mode === 'playing');
  statusPillEl.classList.toggle('paused', mode === 'paused');
  hudMode.textContent = mode;
  btnPause.textContent = running ? '⏸ Pause' : '▶ Resume';
}

function frame() {
  requestAnimationFrame(frame);
  const rawDt = Math.min(clock.getDelta(), 0.05);
  const dt = running ? rawDt : 0;

  if (dt > 0) {
    elapsed += dt;
    debris.update(dt);
    flames.update(dt);
    smoke.update(dt);
    sparks.update(dt);
  }

  hudT.textContent = elapsed.toFixed(2);
  sTime.textContent = elapsed.toFixed(2);

  renderer.render(scene, camera);
}

function resize() {
  const rect = stage.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

frame();
updateHud();

console.log('[wreck playground] ready');

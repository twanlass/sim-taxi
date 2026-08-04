import * as THREE from 'three';
import { createScene } from '../game/scene.js';
import { VIEW_DIR } from '../game/camera.js';
import { PALETTE } from '../palette.js';
import { propMaterial, bakeColor } from '../util/geo.js';
import { LANE, HALF_ROAD } from '../city/grid.js';
import {
  PRESETS, LIMITS, normalizeSpec, buildVehicleGeometry, randomSpec, partAtFace,
  PROFILE_MIN_POINTS, PROFILE_MAX_POINTS,
} from '../geometry/carkit.js';

// The vehicle editor: a workbench for carkit.js specs, served at /editor.html alongside the
// game. Everything here is presentation and plumbing — the mesh itself comes from the same
// buildVehicleGeometry() a game vehicle would use, under the game's own scene lighting
// (createScene()), so what the workbench shows is what the city street would get.

const STORE_CURRENT = 'simtaxi.vehicle-editor.current';
const STORE_GARAGE = 'simtaxi.vehicle-editor.garage';

// ---------------------------------------------------------------------------
// Scene. The game's sky, sun and fill, with the shadow frustum pulled in from
// city-sized to bench-sized — 2048px over ±147 units is a blurry smear on one car.
const { scene, sun } = createScene();
for (const [k, v] of Object.entries({ left: -9, right: 9, top: 9, bottom: -9, far: 500 })) {
  sun.shadow.camera[k] = v;
}
sun.shadow.camera.updateProjectionMatrix();

// A patch of street for scale: the car sits mid-lane, dashes on the centreline one LANE away,
// kerb strips at the road edges — the same 8-unit road it will drive in the game.
function buildGround() {
  const parts = [];
  const disc = new THREE.CircleGeometry(60, 48);
  disc.rotateX(-Math.PI / 2);
  parts.push(bakeColor(disc, new THREE.Color(PALETTE.asphalt)));

  for (const z of [-LANE, HALF_ROAD + LANE]) {
    const kerb = new THREE.BoxGeometry(56, 0.02, 0.5);
    kerb.translate(0, 0.011, z);
    parts.push(bakeColor(kerb, new THREE.Color(PALETTE.sidewalk)));
  }
  for (let x = -27; x <= 27; x += 4) {
    const dash = new THREE.BoxGeometry(2, 0.02, 0.18);
    dash.translate(x, 0.011, LANE);
    parts.push(bakeColor(dash, new THREE.Color(PALETTE.laneMark)));
  }

  const group = new THREE.Group();
  for (const geo of parts) {
    const mesh = new THREE.Mesh(geo, propMaterial());
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
scene.add(buildGround());

// The vehicle under edit.
const vehicle = new THREE.Mesh(new THREE.BufferGeometry(), propMaterial());
vehicle.castShadow = true;
scene.add(vehicle);

// A stock sedan parked in the oncoming lane for scale comparison — "is my van actually bigger
// than a car?" is unanswerable with nothing beside it.
const reference = new THREE.Mesh(buildVehicleGeometry(PRESETS.sedan), propMaterial());
reference.castShadow = true;
reference.position.z = 2 * LANE;
reference.rotation.y = Math.PI;
reference.visible = false;
scene.add(reference);

// ---------------------------------------------------------------------------
// Renderer and cameras.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2000);
const orbit = { yaw: 0.7, pitch: 0.5, dist: 13, target: new THREE.Vector3(0, 0.9, 0) };

function applyOrbit() {
  const { yaw, pitch, dist, target } = orbit;
  camera.position.set(
    target.x + Math.cos(pitch) * Math.cos(yaw) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(pitch) * Math.sin(yaw) * dist,
  );
  camera.lookAt(target);
}

// The play-zoom inset's camera: the game's own view direction, orthographic, sized so one world
// unit covers the same pixels it does in play (frustum half-height 52 over the window height).
// Far plane reaches the sky dome (radius 900), so the inset shows sky rather than clear-colour.
const pipCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1500);
const PIP = { w: 210, h: 160, margin: 18 };

const view = { turntable: true, reference: false, pip: true };
// Same discipline as the game's shot mode: a screenshot has to be reproducible, so a pinned
// ?shot= freezes the turntable at its starting angle. tools/shoot.mjs waits on shotReady.
if (new URLSearchParams(location.search).has('shot')) view.turntable = false;

// ---------------------------------------------------------------------------
// Spec state.
let spec = normalizeSpec(PRESETS.sedan);
try {
  const saved = localStorage.getItem(STORE_CURRENT);
  if (saved) spec = normalizeSpec(JSON.parse(saved));
} catch { /* a corrupt autosave falls back to the sedan */ }
// ?preset= beats the autosave: it makes a link (or a screenshot) mean one specific vehicle.
const pinned = new URLSearchParams(location.search).get('preset');
if (PRESETS[pinned]) spec = normalizeSpec(structuredClone(PRESETS[pinned]));

// --- Part selection. The mesh stays merged; the manifest's vertex ranges are what make a
// raycast hit name a part, and the pulse highlight is a per-frame rewrite of that range's
// slice of the colour attribute, restored from a copy taken at build time.
let selected = null;
let baseColors = null;
const PART_LABELS = {
  body: 'Body', cabin: 'Cabin glass', wheels: 'Wheels', bed: 'Pickup bed',
  box: 'Cargo box', stripe: 'Stripe', sign: 'Roof sign', lightbar: 'Light bar',
};

function setSelected(name) {
  if (baseColors) {
    vehicle.geometry.attributes.color.array.set(baseColors);
    vehicle.geometry.attributes.color.needsUpdate = true;
  }
  selected = name;
}

function rebuild() {
  vehicle.geometry.dispose();
  vehicle.geometry = buildVehicleGeometry(spec);
  baseColors = vehicle.geometry.attributes.color.array.slice();
  // The selected part can genuinely vanish — toggling cargo off deletes the bed.
  if (selected && !vehicle.geometry.userData.manifest.some((p) => p.name === selected)) selected = null;
  if (silhouette.on) syncHandles();
  localStorage.setItem(STORE_CURRENT, JSON.stringify(spec));
  statsEl.textContent =
    `${spec.body.len.toFixed(1)} × ${spec.body.width.toFixed(1)} u · `
    + `${(vehicle.geometry.attributes.position.count / 3).toFixed(0)} tris`;
}

function replaceSpec(next) {
  spec = normalizeSpec(next);
  rebuild();
  renderPanel();
}

// --- Silhouette mode. The body profile's points become draggable handle spheres on the car's
// near flank; dragging moves them in the side plane, double-click inserts on the outline or
// deletes a point. The camera swings to a near-side view and orbiting pauses — a drag has to
// mean "move this point", not two things at once.
const silhouette = { on: false, saved: null };
const handles = new THREE.Group();
scene.add(handles);
const raycaster = new THREE.Raycaster();
const clampNum = THREE.MathUtils.clamp;

function ndcFrom(e) {
  return new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
}

function syncHandles() {
  const profile = spec.body.profile;
  const { len, width, height, clearance } = spec.body;
  while (handles.children.length > profile.length) {
    const h = handles.children.pop();
    h.geometry.dispose();
    h.material.dispose();
  }
  while (handles.children.length < profile.length) {
    handles.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#F5C130', depthTest: false }),
    ));
  }
  profile.forEach(([fx, fy], i) => {
    const h = handles.children[i];
    h.renderOrder = 20;
    h.userData.index = i;
    h.position.set(fx * len, clearance + fy * height, width / 2 + 0.06);
  });
}

function pickHandle(e) {
  raycaster.setFromCamera(ndcFrom(e), camera);
  return raycaster.intersectObjects(handles.children)[0]?.object.userData.index ?? null;
}

/** Where the pointer lands on the car's near-side plane, in world units. */
function sidePlanePoint(e) {
  raycaster.setFromCamera(ndcFrom(e), camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(spec.body.width / 2));
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, out) ? out : null;
}

function dragHandleTo(i, e) {
  const p = sidePlanePoint(e);
  if (!p) return;
  const prof = spec.body.profile;
  const n = prof.length;
  let fx = p.x / spec.body.len;
  let fy = (p.y - spec.body.clearance) / spec.body.height;
  // The chain stays x-monotonic — clamped between its neighbours — so it can never
  // self-intersect, and the endpoints stay on the ground (they close the polygon).
  if (i === 0) { fx = clampNum(fx, prof[1][0], 0.5); fy = 0; }
  else if (i === n - 1) { fx = clampNum(fx, -0.5, prof[n - 2][0]); fy = 0; }
  else { fx = clampNum(fx, prof[i + 1][0], prof[i - 1][0]); fy = clampNum(fy, 0.02, 1); }
  prof[i] = [fx, fy];
  spec = normalizeSpec(spec);
  rebuild();
}

function setSilhouette(on) {
  silhouette.on = on;
  if (on) {
    silhouette.saved = { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist };
    view.turntable = false;
    vehicle.rotation.y = 0;   // handles live in world space; the car has to face them
    orbit.yaw = Math.PI / 2;
    orbit.pitch = 0.12;
    orbit.dist = Math.max(9, spec.body.len * 2.6);
    syncHandles();
  } else {
    if (silhouette.saved) Object.assign(orbit, silhouette.saved);
    while (handles.children.length) {
      const h = handles.children.pop();
      h.geometry.dispose();
      h.material.dispose();
    }
  }
  renderPanel();
}

const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function set(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

// ---------------------------------------------------------------------------
// Panel. Rebuilt wholesale whenever the spec is replaced or a discrete control changes —
// it is a few dozen nodes, and one render path beats a mesh of partial updates.
const panel = document.getElementById('panel');
const statsEl = document.createElement('div');
statsEl.id = 'stats';

const SLIDERS = {
  Body: [
    ['body.len', 'Length', 0.05, (v) => v.toFixed(2)],
    ['body.width', 'Width', 0.05, (v) => v.toFixed(2)],
    ['body.height', 'Height', 0.05, (v) => v.toFixed(2)],
    ['body.clearance', 'Clearance', 0.01, (v) => v.toFixed(2)],
  ],
  Cabin: [
    ['cabin.lenFrac', 'Length', 0.01, (v) => `${Math.round(v * 100)}%`],
    ['cabin.offsetFrac', 'Position', 0.01, (v) => `${Math.round(v * 100)}%`],
    ['cabin.height', 'Height', 0.02, (v) => v.toFixed(2)],
    ['cabin.widthFrac', 'Width', 0.01, (v) => `${Math.round(v * 100)}%`],
    ['cabin.rakeFront', 'Screen rake', 0.02, (v) => v.toFixed(2)],
    ['cabin.rakeBack', 'Rear rake', 0.02, (v) => v.toFixed(2)],
  ],
  Wheels: [
    ['wheels.radius', 'Radius', 0.01, (v) => v.toFixed(2)],
    ['wheels.width', 'Width', 0.01, (v) => v.toFixed(2)],
    ['wheels.insetFrac', 'Stance', 0.01, (v) => `${Math.round(v * 100)}%`],
  ],
};

const BODY_SWATCHES = [...PALETTE.carBody, PALETTE.taxiBody, PALETTE.policeBody];
const GLASS_SWATCHES = [PALETTE.carGlass, PALETTE.policeRoof, '#1B2026'];

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function heading(text) { return el('h2', { textContent: text }); }

function chipRow(options, isOn, pick) {
  const row = el('div', { className: 'chips' });
  for (const [value, label] of options) {
    row.append(el('button', {
      textContent: label,
      className: isOn(value) ? 'on' : '',
      onclick: () => { pick(value); rebuild(); renderPanel(); },
    }));
  }
  return row;
}

function sliderRow([path, label, step, fmt]) {
  const [min, max] = LIMITS[path];
  const value = get(spec, path);
  const output = el('output', { textContent: fmt(value) });
  const input = el('input', { type: 'range', min, max, step, value });
  input.oninput = () => {
    set(spec, path, Number(input.value));
    // Moving the cabin re-clamps against its length (and vice versa); mirror what stuck.
    spec = normalizeSpec(spec);
    input.value = get(spec, path);
    output.textContent = fmt(get(spec, path));
    rebuild();
  };
  return el('div', { className: 'row' }, el('label', { textContent: label }), input, output);
}

function swatchRow(swatches, path, { allowBody = false } = {}) {
  const row = el('div', { className: 'swatches' });
  const current = get(spec, path);
  if (allowBody) {
    row.append(el('button', {
      title: 'match body colour',
      className: current === 'body' ? 'on' : '',
      style: 'background: linear-gradient(135deg,#C9503F,#4E7FC0)',
      onclick: () => { set(spec, path, 'body'); rebuild(); renderPanel(); },
    }));
  }
  for (const hex of swatches) {
    const norm = `#${new THREE.Color(hex).getHexString()}`;
    row.append(el('button', {
      title: hex,
      className: current === norm ? 'on' : '',
      style: `background: ${hex}`,
      onclick: () => { set(spec, path, norm); rebuild(); renderPanel(); },
    }));
  }
  const picker = el('input', {
    type: 'color',
    // A part with no override yet has no current colour to show; grey is the empty well.
    value: !current || current === 'body' ? '#888888' : current,
    title: 'custom colour',
  });
  picker.oninput = () => { set(spec, path, picker.value); rebuild(); };
  row.append(picker);
  return row;
}

function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.style.opacity = 1;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.style.opacity = 0; }, 1800);
}

function garage() {
  try { return JSON.parse(localStorage.getItem(STORE_GARAGE)) ?? {}; } catch { return {}; }
}

async function copyJson() {
  const json = JSON.stringify(spec, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    toast('Spec JSON copied to clipboard');
  } catch {
    window.prompt('Copy the spec JSON:', json);
  }
}

function importJson() {
  const raw = window.prompt('Paste a vehicle spec JSON:');
  if (!raw) return;
  try {
    replaceSpec(JSON.parse(raw));
    toast(`Imported “${spec.name}”`);
  } catch {
    toast('That was not valid JSON');
  }
}

function renderPanel() {
  panel.replaceChildren();

  panel.append(heading('Presets'), chipRow(
    Object.entries(PRESETS).map(([key, p]) => [key, p.name]),
    () => false,
    (key) => { spec = normalizeSpec(structuredClone(PRESETS[key])); },
  ));

  // The selected part, when there is one — click the car to pick, Esc or empty space clears.
  if (selected) {
    panel.append(heading(`Selected · ${PART_LABELS[selected] ?? selected}`));
    panel.append(swatchRow([...BODY_SWATCHES, ...GLASS_SWATCHES], `partColors.${selected}`));
    panel.append(el('div', { className: 'actions' },
      el('button', {
        textContent: 'Reset part colour',
        onclick: () => { delete spec.partColors[selected]; rebuild(); renderPanel(); },
      }),
      el('button', { textContent: 'Deselect', onclick: () => { setSelected(null); renderPanel(); } })));
  } else if (!silhouette.on) {
    panel.append(el('div', { className: 'hint', textContent: 'Click a part of the car to recolour it.' }));
  }

  for (const [section, rows] of Object.entries(SLIDERS)) {
    panel.append(heading(section));
    for (const def of rows) panel.append(sliderRow(def));
    if (section === 'Body') {
      panel.append(chipRow(
        [['silhouette', silhouette.on ? '✓ Done shaping' : '✎ Edit silhouette']],
        () => silhouette.on,
        () => setSilhouette(!silhouette.on),
      ));
      if (silhouette.on) {
        panel.append(el('div', {
          className: 'hint',
          textContent: 'Drag the points to reshape the body. Double-click the side to add a point, double-click a point to remove it. Esc to finish.',
        }));
      }
    }
    if (section === 'Wheels') {
      panel.append(chipRow(
        [[2, '2 axles'], [3, '3 axles']],
        (v) => spec.wheels.axles === v,
        (v) => { spec.wheels.axles = v; },
      ));
    }
  }

  panel.append(heading('Cargo'), chipRow(
    [['none', 'None'], ['bed', 'Pickup bed'], ['box', 'Cargo box']],
    (v) => spec.cargo.type === v,
    (v) => { spec.cargo.type = v; },
  ));
  if (spec.cargo.type === 'bed') panel.append(sliderRow(['cargo.bedWall', 'Wall height', 0.02, (v) => v.toFixed(2)]));
  if (spec.cargo.type === 'box') panel.append(sliderRow(['cargo.boxHeight', 'Box height', 0.05, (v) => v.toFixed(2)]));
  if (spec.cargo.type !== 'none') {
    panel.append(swatchRow([PALETTE.pale, PALETTE.concrete, ...PALETTE.carBody.slice(0, 4)], 'cargo.color', { allowBody: true }));
  }

  panel.append(heading('Paint'), swatchRow(BODY_SWATCHES, 'colors.body'));
  panel.append(heading('Glass / roof'), swatchRow(GLASS_SWATCHES, 'colors.glass'));

  panel.append(heading('Extras'), chipRow(
    [['none', 'No stripe'], ['flank', 'Taxi stripe'], ['skirt', 'Police skirt']],
    (v) => spec.extras.stripe === v,
    (v) => { spec.extras.stripe = v; },
  ));
  if (spec.extras.stripe !== 'none') panel.append(swatchRow([PALETTE.taxiTrim, PALETTE.policeRoof, PALETTE.taxiBody], 'extras.stripeColor'));
  panel.append(chipRow(
    [['sign', 'Roof sign'], ['lightbar', 'Light bar']],
    (v) => spec.extras[v],
    (v) => { spec.extras[v] = !spec.extras[v]; },
  ));

  panel.append(heading('View'), chipRow(
    [['turntable', 'Turntable'], ['reference', 'Stock sedan'], ['pip', 'Play-zoom inset']],
    (v) => view[v],
    (v) => { view[v] = !view[v]; reference.visible = view.reference; },
  ));

  panel.append(heading('Garage'));
  panel.append(el('input', {
    id: 'spec-name', value: spec.name, placeholder: 'Name this vehicle',
    onchange: (e) => { spec.name = e.target.value || spec.name; rebuild(); },
  }));
  const saved = garage();
  const list = el('select', { id: 'garage-list' },
    el('option', { textContent: Object.keys(saved).length ? '— saved vehicles —' : '— garage is empty —', value: '' }),
    ...Object.keys(saved).map((name) => el('option', { textContent: name, value: name })));
  panel.append(list);
  panel.append(el('div', { className: 'actions' },
    el('button', {
      textContent: 'Save',
      className: 'primary',
      onclick: () => {
        const all = garage();
        all[spec.name] = spec;
        localStorage.setItem(STORE_GARAGE, JSON.stringify(all));
        toast(`Saved “${spec.name}” to the garage`);
        renderPanel();
      },
    }),
    el('button', {
      textContent: 'Load',
      onclick: () => {
        const picked = garage()[list.value];
        if (picked) { replaceSpec(picked); toast(`Loaded “${spec.name}”`); }
      },
    }),
    el('button', {
      textContent: 'Delete',
      onclick: () => {
        if (!list.value) return;
        const all = garage();
        delete all[list.value];
        localStorage.setItem(STORE_GARAGE, JSON.stringify(all));
        toast(`Deleted “${list.value}”`);
        renderPanel();
      },
    })));

  panel.append(heading('Spec'));
  panel.append(el('div', { className: 'actions' },
    el('button', { textContent: '🎲 Randomize', onclick: () => replaceSpec(randomSpec()) }),
    el('button', { textContent: 'Copy JSON', onclick: copyJson }),
    el('button', { textContent: 'Import JSON', onclick: importJson })));

  panel.append(statsEl);
}

// ---------------------------------------------------------------------------
// Input: drag to orbit (or to move a silhouette handle), wheel to zoom, and a sub-slop press
// is a click that picks a part — the same press-vs-drag split the game's pan makes, and for
// the same reason: every real click lands with a few pixels of travel.
const CLICK_SLOP = 5;
let pointerState = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerState = silhouette.on
    ? { handle: pickHandle(e) }
    : { x: e.clientX, y: e.clientY, downX: e.clientX, downY: e.clientY, moved: false };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!pointerState) return;
  if (silhouette.on) {
    if (pointerState.handle != null) dragHandleTo(pointerState.handle, e);
    return;
  }
  if (Math.hypot(e.clientX - pointerState.downX, e.clientY - pointerState.downY) > CLICK_SLOP) {
    pointerState.moved = true;
    if (view.turntable) { view.turntable = false; renderPanel(); }
  }
  if (pointerState.moved) {
    orbit.yaw += (e.clientX - pointerState.x) * 0.008;
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + (e.clientY - pointerState.y) * 0.006, 0.06, 1.35);
  }
  pointerState.x = e.clientX;
  pointerState.y = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (pointerState && !silhouette.on && !pointerState.moved) {
    raycaster.setFromCamera(ndcFrom(e), camera);
    const hit = raycaster.intersectObject(vehicle)[0];
    setSelected(hit ? partAtFace(vehicle.geometry.userData.manifest, hit.faceIndex) : null);
    renderPanel();
  }
  pointerState = null;
});

// In silhouette mode, double-click edits the point set: on a handle it deletes that point, on
// the outline it inserts one at the pointer, keeping the chain's front-to-back order.
renderer.domElement.addEventListener('dblclick', (e) => {
  if (!silhouette.on) return;
  const prof = spec.body.profile;
  const h = pickHandle(e);
  if (h != null) {
    if (h > 0 && h < prof.length - 1 && prof.length > PROFILE_MIN_POINTS) prof.splice(h, 1);
  } else if (prof.length < PROFILE_MAX_POINTS) {
    const p = sidePlanePoint(e);
    if (!p) return;
    const fx = clampNum(p.x / spec.body.len, -0.5, 0.5);
    const fy = clampNum((p.y - spec.body.clearance) / spec.body.height, 0.02, 1);
    let at = prof.length - 1;
    for (let i = 0; i < prof.length - 1; i++) {
      if (fx <= prof[i][0] && fx >= prof[i + 1][0]) { at = i + 1; break; }
    }
    prof.splice(at, 0, [fx, fy]);
  }
  spec = normalizeSpec(spec);
  rebuild();
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (silhouette.on) setSilhouette(false);
  else if (selected) { setSelected(null); renderPanel(); }
});
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = THREE.MathUtils.clamp(orbit.dist * Math.exp(e.deltaY * 0.0012), 5, 45);
}, { passive: false });

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Frame loop.
const pipFrame = document.getElementById('pip-frame');
const clock = new THREE.Clock();

let pulseT = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (view.turntable && !silhouette.on) vehicle.rotation.y += dt * 0.45;
  applyOrbit();

  // Pulse the selected part toward white so the selection reads on any base colour. Rewrites
  // only that part's slice of the colour attribute; baseColors is the truth it returns to.
  pulseT += dt;
  if (selected && baseColors) {
    const entry = vehicle.geometry.userData.manifest.find((p) => p.name === selected);
    if (entry) {
      const colors = vehicle.geometry.attributes.color;
      const k = 0.3 + 0.18 * Math.sin(pulseT * 5.5);
      for (let i = entry.start * 3; i < (entry.start + entry.count) * 3; i++) {
        colors.array[i] = baseColors[i] + (1 - baseColors[i]) * k;
      }
      colors.needsUpdate = true;
    }
  }

  renderer.setScissorTest(false);
  renderer.render(scene, camera);

  pipFrame.hidden = !view.pip;
  if (view.pip) {
    // One world unit here covers the same pixels as in play: the game's frustum is 104 world
    // units over the full window height, whatever that height is.
    const upp = 104 / window.innerHeight;
    pipCamera.left = -(PIP.w / 2) * upp;
    pipCamera.right = (PIP.w / 2) * upp;
    pipCamera.top = (PIP.h / 2) * upp;
    pipCamera.bottom = -(PIP.h / 2) * upp;
    pipCamera.updateProjectionMatrix();
    pipCamera.position.copy(VIEW_DIR).multiplyScalar(120);
    pipCamera.lookAt(0, 0, 0);

    // setViewport/setScissor take CSS pixels — the renderer applies the pixel ratio itself.
    // The scissor origin is the canvas's bottom-left.
    renderer.setScissorTest(true);
    renderer.setScissor(PIP.margin, PIP.margin, PIP.w, PIP.h);
    renderer.setViewport(PIP.margin, PIP.margin, PIP.w, PIP.h);
    renderer.render(scene, pipCamera);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.setScissorTest(false);

    pipFrame.style.left = `${PIP.margin}px`;
    pipFrame.style.top = `${window.innerHeight - PIP.margin - PIP.h}px`;
    pipFrame.style.width = `${PIP.w}px`;
    pipFrame.style.height = `${PIP.h}px`;
  }

  document.body.dataset.shotReady = 'true';
  requestAnimationFrame(frame);
}

// Test hook, in the spirit of the game's window.__taxi: enough state for a headless driver to
// aim real pointer events at real screen positions instead of guessing pixels.
window.__editor = {
  get spec() { return spec; },
  get selected() { return selected; },
  handleScreen(i) {
    const h = handles.children[i];
    if (!h) return null;
    const v = h.position.clone().project(camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  },
};

rebuild();
renderPanel();
// ?silhouette=1 opens straight into shaping mode — for screenshots and shared links.
if (new URLSearchParams(location.search).has('silhouette')) setSilhouette(true);
requestAnimationFrame(frame);

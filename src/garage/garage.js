// The garage — /garage/, not part of the game. Paint a vehicle in 3D and save its skin.
//
// The car on the stand is the game's own `createTaxiMesh()`, drawn with the game's own materials,
// sun and sky, so what is painted here is what the game draws — the paint lives in a volume over
// the car (util/paint.js), not in this page. Saving writes `assets/skins/taxi.json` through the
// dev server, and every open game tab picks it up live (geometry/skins.js).
//
// **The game camera is the one view that tells the truth.** At play zoom the taxi is about thirty
// pixels long and one voxel is under a pixel, so a detail that reads beautifully in the orbit view
// can be nothing at all in the game. The toggle puts the car under the game's own orthographic
// camera at `PLAY_ZOOM`, and painting works there too.
//
// See docs/garage.md.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createScene } from '../game/scene.js';
import { createDaylight } from '../game/daylight.js';
import { createCityCamera, PLAY_ZOOM } from '../game/camera.js';
import { createTaxiMesh } from '../geometry/taxi.js';
import { getSkin } from '../geometry/skins.js';
import { paintSphere, PAINT_FIXED, PAINT_NONE } from '../util/paint.js';
import { bakeColor, propMaterial, unlitMaterial } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';

const SKIN = 'taxi';
const skin = getSkin(SKIN);

// --- Renderer, scene, light --------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  // The taxi wears ghost outlines, which stamp a stencil mask — same reason main.js asks for it.
  stencil: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const { scene, sun, hemi, sky, fog } = createScene({ shadowMapSize: 2048 });
const daylight = createDaylight({ sun, hemi, sky, fog });
daylight.setCycling(false);

// The game's sun covers the whole city with one shadow map; here it only has to cover a car, so
// the frustum is pulled in and the same map resolves a shadow fine enough to judge a paint job by.
const SHADOW_REACH = 6;
Object.assign(sun.shadow.camera, {
  left: -SHADOW_REACH, right: SHADOW_REACH, top: SHADOW_REACH, bottom: -SHADOW_REACH,
});
sun.shadow.camera.updateProjectionMatrix();

const floor = new THREE.PlaneGeometry(60, 60);
floor.rotateX(-Math.PI / 2);   // +Z face to +Y
const ground = new THREE.Mesh(bakeColor(floor, color('asphalt')), propMaterial());
ground.receiveShadow = true;
scene.add(ground);

const taxi = createTaxiMesh();
scene.add(taxi.group);

// What a stroke can land on: every part that reads paint, plus the roof sign so a stroke aimed at
// the sign stops there rather than painting the roof underneath it.
const paintable = [];
taxi.group.traverse((node) => {
  if (node.isMesh && node.geometry.attributes.paintPos
    && node.material.customProgramCacheKey?.().includes('-paint')) paintable.push(node);
});
const strokeTargets = [...paintable, taxi.sign];

// --- Cameras -----------------------------------------------------------------------------------

const aspect = () => window.innerWidth / window.innerHeight;

const orbitCamera = new THREE.PerspectiveCamera(32, aspect(), 0.1, 3000);
orbitCamera.position.set(6.5, 4.2, 7.5);
const orbit = new OrbitControls(orbitCamera, renderer.domElement);
orbit.target.set(0, 1.1, 0);
orbit.enableDamping = true;
orbit.minDistance = 2.5;
orbit.maxDistance = 30;
orbit.maxPolarAngle = Math.PI * 0.49;   // never under the floor
orbit.update();

// The game's camera, aimed at the stand. Its zoom is the frustum's half-height in world units, so
// PLAY_ZOOM here is the game's own framing to the pixel on a window the game's size.
const city = createCityCamera(aspect(), { zoom: PLAY_ZOOM, target: [0, 0] });

let view = 'orbit';
const activeCamera = () => (view === 'orbit' ? orbitCamera : city.camera);

// --- Brush -------------------------------------------------------------------------------------

const brush = {
  tool: 'paint',
  size: 3,                     // diameter, in voxels
  mirror: true,
  rgb: [0x16, 0x12, 0x0a],
};

const radiusOf = () => (brush.size * skin.voxel) / 2;

// The ring under the cursor. Unlit, through `unlitMaterial` like every flat-colour marker, and drawn
// over everything so it is never lost inside the panel it is sitting on.
const ring = new THREE.Mesh(
  new THREE.RingGeometry(0.86, 1, 40),
  unlitMaterial({
    color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide,
  }),
);
ring.renderOrder = 10;
ring.visible = false;
scene.add(ring);

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tri = new THREE.Triangle();
const local = new THREE.Vector3();
const bary = new THREE.Vector3();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

/**
 * What is under the pointer, in paint space: the stroke's `centre` — where the shader reads, a
 * quarter voxel inside the surface — plus the surface's rest-frame normal. Null off the car, or on
 * the sign.
 *
 * The point is interpolated off the hit triangle's own `paintPos`, not computed from the live
 * transform, so a stroke on a door that is swung open lands where the door's paint actually lives.
 */
function probe(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1);
  taxi.group.updateMatrixWorld(true);
  raycaster.setFromCamera(ndc, activeCamera());
  const hit = raycaster.intersectObjects(strokeTargets, false)[0];
  if (!hit || hit.object === taxi.sign) return null;
  const mesh = hit.object;
  const { position, paintPos } = mesh.geometry.attributes;
  const { a: ia, b: ib, c: ic } = hit.face;
  mesh.worldToLocal(local.copy(hit.point));
  tri.set(a.fromBufferAttribute(position, ia), b.fromBufferAttribute(position, ib),
    c.fromBufferAttribute(position, ic));
  tri.getBarycoord(local, bary);
  const rest = THREE.Triangle.getInterpolatedAttribute(paintPos, ia, ib, ic, bary, new THREE.Vector3());
  const normal = hit.face.normal.clone();   // the triangle's, in mesh space = rest space
  return {
    mesh, hit, face: hit.face, bary: bary.clone(), normal,
    centre: skin.surfacePoint(rest, normal),
    worldNormal: normal.clone().transformDirection(mesh.matrixWorld),
  };
}

function showRing(at) {
  ring.visible = Boolean(at) && brush.tool !== 'pick';
  if (!ring.visible) return;
  ring.position.copy(at.hit.point).addScaledVector(at.worldNormal, 0.01);
  ring.quaternion.setFromUnitVectors(Z, at.worldNormal);
  ring.scale.setScalar(Math.max(radiusOf(), skin.voxel * 0.5) * taxi.group.scale.x);
}

const mirrored = new THREE.Vector3();

function dab(centre) {
  const mode = brush.tool === 'erase' ? PAINT_NONE : PAINT_FIXED;
  let changed = paintSphere(skin, centre, radiusOf(), brush.rgb, mode);
  if (brush.mirror) {
    changed += paintSphere(skin, mirrored.set(centre.x, centre.y, -centre.z), radiusOf(), brush.rgb, mode);
  }
  return changed;
}

/** Dabs from `from` to `to` at half-voxel steps, so a fast drag draws a line and not a dotted one. */
function line(from, to) {
  const span = from.distanceTo(to);
  // A jump this long is the pointer crossing from one part of the car to another — the roof to a
  // door, say — and joining the two would paint straight through the car between them.
  if (span > radiusOf() + skin.voxel * 6) { dab(to); return; }
  const steps = Math.max(1, Math.ceil(span / (skin.voxel * 0.5)));
  const at = new THREE.Vector3();
  for (let s = 1; s <= steps; s++) dab(at.lerpVectors(from, to, s / steps));
}

const toHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The colour on the car at `at`: the paint if there is any, the geometry's own colour otherwise. */
function pickColour(at) {
  const painted = skin.sample(at.centre);
  if (painted && painted[3] !== PAINT_NONE) return painted.slice(0, 3);
  const attr = at.mesh.geometry.attributes.color;
  if (!attr) return null;
  const { a: ia, b: ib, c: ic } = at.face;
  const lin = THREE.Triangle.getInterpolatedAttribute(attr, ia, ib, ic, at.bary, new THREE.Vector3());
  const srgb = new THREE.Color().setRGB(lin.x, lin.y, lin.z, THREE.LinearSRGBColorSpace);
  return fromHex(`#${srgb.getHexString()}`);
}

// --- History ------------------------------------------------------------------------------------

const UNDO_DEPTH = 40;
const undoStack = [];
const redoStack = [];

function snapshot() {
  undoStack.push(skin.bytes.slice());
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  redoStack.length = 0;
}

function restore(from, to) {
  const bytes = from.pop();
  if (!bytes) return;
  // A skin reloaded from disk under us (another tab saved it) may have different dimensions; the
  // history is for the volume it was taken from, so it goes.
  if (bytes.length !== skin.bytes.length) { undoStack.length = 0; redoStack.length = 0; refresh(); return; }
  to.push(skin.bytes.slice());
  skin.bytes.set(bytes);
  skin.touch();
  refresh();
}

// --- Pointer ------------------------------------------------------------------------------------
//
// A capture listener on `window`, not on the canvas: OrbitControls listens on the canvas, and at a
// single target two listeners fire in the order they were added whatever their capture flag says
// (CLAUDE.md). Only an ancestor's capture listener reliably goes first — so a press that lands on
// the car is a stroke and OrbitControls never hears about it, and a press off the car is left
// alone to orbit.

let stroke = null;       // { last: Vector3 } while painting
let spinDrag = null;     // { x } while turning the car under the game camera

window.addEventListener('pointerdown', (event) => {
  if (event.target !== renderer.domElement || event.button !== 0) return;
  const at = probe(event);
  if (at) {
    event.stopPropagation();
    if (brush.tool === 'pick') {
      const rgb = pickColour(at);
      if (rgb) setColour(rgb);
      setTool('paint');
      return;
    }
    snapshot();
    dab(at.centre);
    stroke = { last: at.centre.clone() };
    refresh();
  } else if (view === 'game') {
    event.stopPropagation();
    spinDrag = { x: event.clientX };
  }
}, { capture: true });

window.addEventListener('pointermove', (event) => {
  if (spinDrag) {
    taxi.group.rotation.y += (event.clientX - spinDrag.x) * 0.01;
    spinDrag.x = event.clientX;
    return;
  }
  const at = event.target === renderer.domElement || stroke ? probe(event) : null;
  showRing(at);
  if (stroke && at) {
    line(stroke.last, at.centre);
    stroke.last.copy(at.centre);
  }
});

window.addEventListener('pointerup', () => {
  if (stroke) { stroke = null; refresh(); }
  spinDrag = null;
});

// --- Panel --------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const status = $('status');

function setTool(tool) {
  brush.tool = tool;
  for (const button of $('tools').children) button.classList.toggle('on', button.dataset.tool === tool);
  renderer.domElement.style.cursor = tool === 'pick' ? 'copy' : 'crosshair';
}

function setColour(rgb) {
  brush.rgb = rgb;
  const hex = toHex(rgb);
  $('colour').value = hex;
  $('hex').textContent = hex.toUpperCase();
  for (const swatch of $('swatches').children) swatch.classList.toggle('on', swatch.dataset.hex === hex);
}

function setSize(size) {
  brush.size = THREE.MathUtils.clamp(size, 1, 10);
  $('size').value = brush.size;
  $('size-value').textContent = `${brush.size}`;
}

function setView(next) {
  view = next;
  for (const button of $('views').children) button.classList.toggle('on', button.dataset.view === view);
  orbit.enabled = view === 'orbit';
  $('zoom-row').style.display = view === 'game' ? '' : 'none';
  if (view === 'orbit') taxi.group.rotation.y = 0;
  resize();
}

function setZoom(zoom) {
  city.state.zoom = zoom;
  city.update(aspect());
  $('zoom').value = zoom;
  // What a world unit comes to on this screen. 7.7px at PLAY_ZOOM on a ~800px-tall window — the
  // number every effect in the game is sized against.
  const px = window.innerHeight / (2 * zoom);
  $('zoom-value').textContent = `${px.toFixed(1)}px`;
}

function refresh() {
  const dirty = skin.toJSON().data !== skin.saved;
  status.classList.toggle('dirty', dirty);
  status.textContent = `${skin.painted().toLocaleString()} voxels painted · `
    + `${skin.dims.join('×')} at ${skin.voxel}u${dirty ? ' · unsaved' : ' · saved'}`;
  $('undo').disabled = undoStack.length === 0;
  $('redo').disabled = redoStack.length === 0;
}

// Every named colour in the game, so the car can be painted in the city's own palette. A custom
// colour is one click away on the picker; the swatches are there to make the default the
// consistent choice.
const seen = new Set();
for (const [name, value] of Object.entries(PALETTE)) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) continue;
  const hex = value.toLowerCase();
  if (seen.has(hex)) continue;
  seen.add(hex);
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.title = name;
  swatch.dataset.hex = hex;
  swatch.style.background = hex;
  swatch.addEventListener('click', () => { setColour(fromHex(hex)); if (brush.tool === 'erase') setTool('paint'); });
  $('swatches').appendChild(swatch);
}

for (const button of $('tools').children) button.addEventListener('click', () => setTool(button.dataset.tool));
for (const button of $('views').children) button.addEventListener('click', () => setView(button.dataset.view));
$('colour').addEventListener('input', (e) => setColour(fromHex(e.target.value)));
$('size').addEventListener('input', (e) => setSize(Number(e.target.value)));
$('mirror').addEventListener('change', (e) => { brush.mirror = e.target.checked; });
$('zoom').addEventListener('input', (e) => setZoom(Number(e.target.value)));
$('hour').addEventListener('input', (e) => setHour(Number(e.target.value)));
$('doors').addEventListener('change', (e) => taxi.setDoor(e.target.checked ? 1 : 0, e.target.checked ? 1.15 : 0));
$('lids').addEventListener('change', (e) => {
  taxi.damage.setBoot(e.target.checked ? 0.95 : null);
  taxi.damage.setHood(e.target.checked ? 0.85 : null);
});
$('undo').addEventListener('click', () => restore(undoStack, redoStack));
$('redo').addEventListener('click', () => restore(redoStack, undoStack));
$('clear').addEventListener('click', () => {
  if (!skin.painted() || !window.confirm('Clear all paint from the taxi? (Undo brings it back.)')) return;
  snapshot();
  skin.bytes.fill(0);
  skin.touch();
  refresh();
});
$('save').addEventListener('click', save);
$('download').addEventListener('click', download);

function setHour(hour) {
  daylight.apply(hour);
  $('hour').value = hour;
  const h = Math.floor(hour);
  $('hour-value').textContent = `${h}:${String(Math.round((hour - h) * 60)).padStart(2, '0')}`;
}

function download() {
  const blob = new Blob([`${JSON.stringify(skin.toJSON(), null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${SKIN}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function save() {
  const file = skin.toJSON();
  try {
    const response = await fetch(`/__garage/save/${SKIN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file),
    });
    if (!response.ok) throw new Error(`${response.status}`);
    // Before the dev server's echo of this very file arrives, so skins.js knows to ignore it.
    skin.saved = file.data;
    refresh();
    status.textContent += ` → assets/skins/${SKIN}.json`;
  } catch {
    // A built bundle has no dev server to write through: hand the file over instead, to drop over
    // assets/skins/ by hand.
    download();
    status.textContent = `No dev server to save through — downloaded ${SKIN}.json instead. `
      + `Drop it over assets/skins/${SKIN}.json.`;
  }
}

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type !== 'range'
    && event.target.type !== 'checkbox') return;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.code === 'KeyZ') {
    event.preventDefault();
    if (event.shiftKey) restore(redoStack, undoStack); else restore(undoStack, redoStack);
  } else if (mod && event.code === 'KeyY') {
    event.preventDefault();
    restore(redoStack, undoStack);
  } else if (mod && event.code === 'KeyS') {
    event.preventDefault();
    save();
  } else if (mod) {
    // Leave every other shortcut to the browser.
  } else if (event.code === 'KeyB') setTool('paint');
  else if (event.code === 'KeyE') setTool('erase');
  else if (event.code === 'KeyI') setTool('pick');
  else if (event.code === 'BracketLeft') setSize(brush.size - 1);
  else if (event.code === 'BracketRight') setSize(brush.size + 1);
  else if (event.code === 'KeyM') { brush.mirror = !brush.mirror; $('mirror').checked = brush.mirror; }
  else if (event.code === 'KeyG') setView(view === 'orbit' ? 'game' : 'orbit');
});

// --- Frame --------------------------------------------------------------------------------------

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  orbitCamera.aspect = aspect();
  orbitCamera.updateProjectionMatrix();
  setZoom(city.state.zoom);
}
window.addEventListener('resize', resize);

// The skin can change under the page — another garage tab saving — and the history and status
// should follow it rather than describe a volume that is gone.
let lastBytes = skin.bytes;

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if ($('spin').checked) taxi.group.rotation.y += dt * 0.6;
  if (skin.bytes !== lastBytes) { lastBytes = skin.bytes; undoStack.length = 0; redoStack.length = 0; refresh(); }
  if (view === 'orbit') orbit.update();
  renderer.render(scene, activeCamera());
});

setTool('paint');
setColour(brush.rgb);
setSize(brush.size);
setHour(16.4);
setView('orbit');
refresh();

// The probe's handle, same idea as `window.__taxi` in the game.
window.__garage = {
  skin, taxi, paintable, setView, setZoom, brush,
  /** Client coordinates of a point in the taxi's own frame, under the current camera. */
  screenOf(x, y, z) {
    taxi.group.updateMatrixWorld(true);
    const p = taxi.group.localToWorld(new THREE.Vector3(x, y, z)).project(activeCamera());
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  },
};

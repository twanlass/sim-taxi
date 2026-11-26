/**
 * The hand-painted road (Tyler, 2026-11-25: "Make me a vertex paint tool for the road").
 *
 * A splat map, not vertex colour: one RGBA texture laid over the whole island in world space, one
 * texel per pixel of the pixel street (`ROAD_TEX.texel`, 0.15), read by the road's paint pass
 * (PAINT_FRAGMENT in util/geo.js, `createPaving` in util/gpupaving.js) at each road pixel's centre
 * and multiplied in *before* the grey ramp, so a stroke comes out in the street's own pixels.
 * Vertex paint at that detail would have meant cutting every road quad into 0.15-unit cells (the
 * ground is ~20k triangles; that would be millions) for the same picture; this is one texture read
 * on fragments the road shader was already shading.
 *
 * Four channels, each 0..255 of "how much": r darkens, g lightens, b pulls warm, a pulls cool
 * (ROAD_PAINT_LOOK in util/geo.js says how far). `uRoadPaintAmt` scales each one live.
 *
 * The bake is `city/roadpaintbake.js`: the box it was painted in and its bytes, deflated and
 * base64'd. An empty bake costs nothing — the texture stays 1x1 and the shader skips the read —
 * unless the ⚙️ panel is open, which allocates the full map so there is something to paint into.
 * The panel's Road paint section (game/debugpanel.js) drives the brush; the dev server's
 * `/__roadpaint` endpoint (tools/roadpaint-save.mjs) writes the bake straight into the repo.
 */
import * as THREE from 'three';
import { PAINT_UNIFORMS, unlitMaterial } from '../util/geo.js';
import { coastWest, coastEast, coastNorth, coastSouth } from '../city/grid.js';
import { ROAD_PAINT_BAKE } from '../city/roadpaintbake.js';

/** World units per texel: the pixel street's own, so a painted texel is one road pixel exactly. */
export const PAINT_TEXEL = 0.15;
export const CHANNELS = ['Dark', 'Light', 'Warm', 'Cool'];
const STORE_KEY = 'simtaxi-roadpaint';
const UNDO_DEPTH = 30;

const map = {
  data: null, width: 0, height: 0, minX: 0, minZ: 0,
  // Bumped on every change, so a panel can tell "matches the bake" from "edited since".
  version: 0,
};
const amounts = [1, 1, 1, 1];

function applyAmounts() {
  const on = map.width > 1 ? 1 : 0;
  PAINT_UNIFORMS.uRoadPaintAmt.value.set(amounts[0] * on, amounts[1] * on, amounts[2] * on, amounts[3] * on);
}

/** How hard channel `c` lands, 0..2 (1 is ROAD_PAINT_LOOK's full strength). */
export function setPaintAmount(c, v) {
  if (!Number.isFinite(v)) return;
  amounts[c] = Math.max(0, v);
  applyAmounts();
}
export const paintAmount = (c) => amounts[c];

function upload() {
  const tex = PAINT_UNIFORMS.tRoadPaint.value;
  tex.needsUpdate = true;
  map.version += 1;
}

/**
 * Size the map to the island and fill it from the bake. Called once from main.js after the layout
 * exists (coastNorth reads it) and before the first frame, so the one texture object is resized
 * before anything has uploaded it. `always` allocates even with an empty bake — debug mode.
 */
export function installRoadPaint({ always = false } = {}) {
  const bake = ROAD_PAINT_BAKE;
  const stored = always ? readStored() : null;
  if (!always && !bake?.data) { applyAmounts(); return Promise.resolve(false); }
  // Snapped to the texel grid at the world origin, the grid the pixel street rounds to.
  const minX = Math.floor(coastWest() / PAINT_TEXEL) * PAINT_TEXEL;
  const minZ = Math.floor(coastNorth() / PAINT_TEXEL) * PAINT_TEXEL;
  const width = Math.ceil((coastEast() - minX) / PAINT_TEXEL);
  const height = Math.ceil((coastSouth() - minZ) / PAINT_TEXEL);
  Object.assign(map, { data: new Uint8Array(width * height * 4), width, height, minX, minZ });
  const tex = PAINT_UNIFORMS.tRoadPaint.value;
  tex.dispose();
  tex.image = { data: map.data, width, height };
  tex.needsUpdate = true;
  PAINT_UNIFORMS.uRoadPaintBox.value.set(minX, minZ, 1 / (width * PAINT_TEXEL), 1 / (height * PAINT_TEXEL));
  applyAmounts();
  const source = stored ?? bake;
  if (!source?.data) return Promise.resolve(true);
  return decode(source).then(() => true, (err) => { console.warn('road paint: bake did not load', err); return false; });
}

/** Copy a saved map into this one by world position: a bake from a city of another size lands where it was painted. */
async function decode(saved) {
  const bytes = await inflate(saved.data);
  const ox = Math.round((saved.minX - map.minX) / PAINT_TEXEL);
  const oz = Math.round((saved.minZ - map.minZ) / PAINT_TEXEL);
  for (let z = 0; z < saved.height; z++) {
    const tz = z + oz;
    if (tz < 0 || tz >= map.height) continue;
    const x0 = Math.max(0, -ox);
    const x1 = Math.min(saved.width, map.width - ox);
    if (x1 <= x0) continue;
    map.data.set(bytes.subarray((z * saved.width + x0) * 4, (z * saved.width + x1) * 4), (tz * map.width + x0 + ox) * 4);
  }
  upload();
}

// --- Bake encoding --------------------------------------------------------------------------
// Raw RGBA through the browser's own deflate (CompressionStream), then base64. An untouched map
// is all zeroes and deflates to almost nothing; no image codec, because a canvas premultiplies
// alpha and would throw away every colour under a zero cool channel.

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function inflate(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The map as a bake: `{ texel, minX, minZ, width, height, data }`, or null if nothing is painted. */
export async function encodeRoadPaint() {
  if (!map.data) return null;
  // Cropped to what was painted, so the bake does not carry a city's worth of zeroes.
  let x0 = map.width, z0 = map.height, x1 = -1, z1 = -1;
  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const i = (z * map.width + x) * 4;
      if (map.data[i] | map.data[i + 1] | map.data[i + 2] | map.data[i + 3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    }
  }
  if (x1 < 0) return { texel: PAINT_TEXEL, minX: 0, minZ: 0, width: 0, height: 0, data: '' };
  const w = x1 - x0 + 1, h = z1 - z0 + 1;
  const out = new Uint8Array(w * h * 4);
  for (let z = 0; z < h; z++) out.set(map.data.subarray(((z + z0) * map.width + x0) * 4, ((z + z0) * map.width + x1 + 1) * 4), z * w * 4);
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return {
    texel: PAINT_TEXEL, minX: round(map.minX + x0 * PAINT_TEXEL), minZ: round(map.minZ + z0 * PAINT_TEXEL),
    width: w, height: h, data: await deflate(out),
  };
}

/** The bake as the source of city/roadpaintbake.js. */
export function bakeSource(bake) {
  return `// The hand-painted road (game/roadpaint.js). Written by the ⚙️ panel's Road paint > Save to repo;
// don't edit by hand. Raw RGBA (dark, light, warm, cool), deflated, base64.
export const ROAD_PAINT_BAKE = ${JSON.stringify(bake ?? { data: '' })};
`;
}

// --- Local autosave (debug mode only) -------------------------------------------------------

function readStored() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}
export const hasLocalPaint = () => readStored() !== null;
let storeTimer = 0;
function scheduleStore() {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(async () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(await encodeRoadPaint())); } catch (err) {
      console.warn('road paint: autosave refused (too big for localStorage?) — Save to repo to keep it', err);
    }
  }, 600);
}
/** Forget the local painting and reload the bake. */
export async function revertRoadPaint() {
  try { localStorage.removeItem(STORE_KEY); } catch { /* private mode */ }
  if (!map.data) return;
  map.data.fill(0);
  undoStack.length = 0;
  if (ROAD_PAINT_BAKE?.data) await decode(ROAD_PAINT_BAKE); else upload();
}

// --- Viewing aids ----------------------------------------------------------------------------

/** Mark something to stay on screen under Road only: the ground, the manholes, the asphalt patches. */
export function roadViewKeep(object) {
  if (object) object.userData.roadView = true;
  return object;
}

/** No lighting: the ground drawn as its bare colour times the paint (uAlbedoView in util/geo.js). */
export function setAlbedoView(on) {
  PAINT_UNIFORMS.uAlbedoView.value = on ? 1 : 0;
}
export const albedoView = () => PAINT_UNIFORMS.uAlbedoView.value > 0.5;

// --- The brush ------------------------------------------------------------------------------

export const brush = {
  on: false,      // a left press paints (the panel's Paint box, or G)
  channel: 0,     // index into CHANNELS
  size: 1.2,      // radius, world units
  strength: 0.35, // how far one dab moves a texel toward its target, at the brush's centre
  hardness: 0.5,  // 0: falls off from the centre; 1: a flat disc
  erase: false,
};

const undoStack = [];
let stroke = null; // { x0, z0, x1, z1, before } in texels while a stroke is down

function beginStroke() {
  if (!map.data) return;
  stroke = { x0: Infinity, z0: Infinity, x1: -1, z1: -1, before: map.data.slice() };
}

function endStroke() {
  if (!stroke) return;
  const { x0, z0, x1, z1, before } = stroke;
  stroke = null;
  if (x1 < x0) return;
  // Keep only the rectangle the stroke touched, not a copy of the whole map per stroke.
  const w = x1 - x0 + 1;
  const pixels = new Uint8Array(w * (z1 - z0 + 1) * 4);
  for (let z = z0; z <= z1; z++) pixels.set(before.subarray((z * map.width + x0) * 4, (z * map.width + x1 + 1) * 4), (z - z0) * w * 4);
  undoStack.push({ x0, z0, x1, z1, pixels });
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  scheduleStore();
}

export function undoRoadPaint() {
  const step = undoStack.pop();
  if (!step || !map.data) return false;
  const { x0, z0, x1, z1, pixels } = step;
  const w = x1 - x0 + 1;
  for (let z = z0; z <= z1; z++) map.data.set(pixels.subarray((z - z0) * w * 4, (z - z0 + 1) * w * 4), (z * map.width + x0) * 4);
  upload();
  scheduleStore();
  return true;
}

export function clearRoadPaint() {
  if (!map.data) return;
  beginStroke();
  stroke.x0 = 0; stroke.z0 = 0; stroke.x1 = map.width - 1; stroke.z1 = map.height - 1;
  map.data.fill(0);
  upload();
  endStroke();
}

/** One dab of the brush at world (x, z). */
function dab(x, z, erase) {
  const r = brush.size / PAINT_TEXEL;
  const cx = (x - map.minX) / PAINT_TEXEL - 0.5;
  const cz = (z - map.minZ) / PAINT_TEXEL - 0.5;
  const ix0 = Math.max(0, Math.floor(cx - r)), ix1 = Math.min(map.width - 1, Math.ceil(cx + r));
  const iz0 = Math.max(0, Math.floor(cz - r)), iz1 = Math.min(map.height - 1, Math.ceil(cz + r));
  if (ix1 < ix0 || iz1 < iz0) return;
  const target = erase ? 0 : 255;
  const c = brush.channel;
  const inner = Math.min(0.999, brush.hardness);
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const d = Math.hypot(ix - cx, iz - cz) / r;
      if (d >= 1) continue;
      const t = d <= inner ? 1 : 1 - (d - inner) / (1 - inner);
      const fall = t * t * (3 - 2 * t);
      const i = (iz * map.width + ix) * 4 + c;
      const v = map.data[i];
      // At least one step toward the target, or a light brush never finishes the last few levels.
      const move = (target - v) * brush.strength * fall;
      map.data[i] = Math.abs(move) < 1 && move !== 0 ? v + Math.sign(move) : v + Math.round(move);
    }
  }
  if (stroke) {
    stroke.x0 = Math.min(stroke.x0, ix0); stroke.x1 = Math.max(stroke.x1, ix1);
    stroke.z0 = Math.min(stroke.z0, iz0); stroke.z1 = Math.max(stroke.z1, iz1);
  }
}

/**
 * The brush on screen: while `active()`, a left press on the canvas paints instead of panning or
 * picking, a ring on the road shows the brush, Alt (or the Erase box) erases, `[` `]` resize,
 * 1-4 pick the channel, E toggles erase and Cmd/Ctrl+Z undoes. G switches painting on and off.
 * Holding Shift lets a press through to pan (Space is boost and B the brake, so neither is free).
 *
 * Listens on `window` in the capture phase, because that is the only ordering that beats the
 * canvas's own listeners regardless of who registered first (CLAUDE.md, "Two listeners on the
 * same element fire in registration order").
 */
export function createRoadBrush({ camera, canvas, scene, active, onChange = () => {} }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2),
    unlitMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
  );
  ring.renderOrder = 999;
  ring.visible = false;
  ring.position.y = 0.05;
  ring.userData.zfight = false; // a dev cursor drawn over everything, never part of the city
  scene.add(ring);
  let panHeld = false;
  let down = null; // { id, x, z, erase }

  const groundAt = (e) => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(ground, hit) ? { x: hit.x, z: hit.z } : null;
  };
  const showRing = (p, erase) => {
    ring.visible = Boolean(p) && active();
    if (!p) return;
    ring.position.set(p.x, 0.05, p.z);
    ring.scale.setScalar(brush.size);
    ring.material.color.set(erase ? 0xff5a5a : 0xffffff);
  };
  const strokeTo = (p) => {
    // Dabs a quarter of the radius apart, so a fast drag is a line rather than beads.
    const gap = Math.max(PAINT_TEXEL, brush.size * 0.25);
    const n = Math.max(1, Math.ceil(Math.hypot(p.x - down.x, p.z - down.z) / gap));
    for (let k = 1; k <= n; k++) dab(down.x + ((p.x - down.x) * k) / n, down.z + ((p.z - down.z) * k) / n, down.erase);
    down.x = p.x; down.z = p.z;
    upload();
  };

  const swallow = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
  window.addEventListener('pointerdown', (e) => {
    if (!active() || e.target !== canvas || e.button !== 0 || panHeld || !map.data) return;
    const p = groundAt(e);
    if (!p) return;
    swallow(e);
    down = { id: e.pointerId, x: p.x, z: p.z, erase: brush.erase || e.altKey };
    beginStroke();
    dab(p.x, p.z, down.erase);
    upload();
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!active()) { ring.visible = false; return; }
    const p = e.target === canvas || down ? groundAt(e) : null;
    showRing(p, brush.erase || e.altKey);
    if (down && e.pointerId === down.id) { swallow(e); if (p) strokeTo(p); }
  }, true);
  const lift = (e) => {
    if (!down || e.pointerId !== down.id) return;
    swallow(e);
    down = null;
    endStroke();
    onChange();
  };
  window.addEventListener('pointerup', lift, true);
  window.addEventListener('pointercancel', lift, true);
  // The click that follows a stroke would otherwise reach the fare picker.
  window.addEventListener('click', (e) => { if (active() && e.target === canvas && !panHeld) swallow(e); }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') panHeld = true;
    const typing = e.target?.closest?.('input, textarea, select');
    if (!typing && !e.metaKey && !e.ctrlKey && e.code === 'KeyG') {
      brush.on = !brush.on;
      if (!brush.on) ring.visible = false;
      onChange();
      return;
    }
    if (!active() || e.target?.closest?.('input, textarea, select')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { swallow(e); undoRoadPaint(); onChange(); return; }
    if (e.key === '[') brush.size = Math.max(0.15, brush.size / 1.2);
    else if (e.key === ']') brush.size = Math.min(12, brush.size * 1.2);
    else if (e.key >= '1' && e.key <= '4') brush.channel = Number(e.key) - 1;
    else if (e.key.toLowerCase() === 'e') brush.erase = !brush.erase;
    else return;
    ring.scale.setScalar(brush.size);
    onChange();
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') panHeld = false; });
  // Road only: every drawable outside the ground hidden, and put back exactly as it was. Meshes
  // only, never a group: a light under a hidden group drops out of the light count and recompiles
  // every lit program in the city (CLAUDE.md). Something spawned while it is on (a new car) shows;
  // toggling again catches it.
  let hidden = null;
  const keeps = (o) => { for (let p = o; p; p = p.parent) if (p.userData.roadView || p === ring) return true; return false; };
  function setRoadOnly(on) {
    if (on === Boolean(hidden)) return;
    if (on) {
      hidden = [];
      scene.traverse((o) => {
        if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || !o.visible || keeps(o)) return;
        let lit = false;
        o.traverse((c) => { if (c.isLight) lit = true; });
        if (lit) return;
        o.visible = false;
        hidden.push(o);
      });
    } else {
      for (const o of hidden) o.visible = true;
      hidden = null;
    }
  }
  return {
    /** Hide the ring when painting is switched off. */
    sync() { if (!active()) ring.visible = false; },
    setRoadOnly,
    roadOnly: () => Boolean(hidden),
  };
}

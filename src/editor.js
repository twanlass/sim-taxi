// The level editor.
//
// It edits exactly two things — where the roads are, and what each block is — because everything
// else is derived. Lanes, turn arcs, signal phases, which junctions carry lights, and the shape of
// every block all fall out of `bakeNetwork` the moment an edge changes, so there is nothing here
// that places a lane or times a light. See docs/roadnet.md.
//
// A second entry point rather than a mode inside `main.js`: the game's boot is a one-shot top-level
// script that starts traffic, fares and police, and none of that belongs behind an `if (editing)`.

import * as THREE from 'three';
import { makeRng } from './util/rng.js';
import { createScene } from './game/scene.js';
import { createCityCamera } from './game/camera.js';
import { createLayout } from './city/layout.js';
import { createGround } from './city/ground.js';
import { createBuildings } from './city/buildings.js';
import { createProps } from './city/props.js';
import { createDaylight, DAY_SECONDS } from './game/daylight.js';
import { cityNetwork, isNetworkConnected } from './city/roadnet.js';
import {
  cityFromLevel, levelFromCity, latticeNodes, latticeEdgeId, saveLevel, loadLevel,
} from './city/level.js';
import { GRID, PITCH } from './city/grid.js';
import { pointInPolygon } from './city/curves.js';

// The city the meshes are generated against. Fixed, because an editor that re-rolled its buildings
// every time you drew a road would be unreadable — you could not tell what your edit did.
const MESH_SEED = 71624;

// --- Scene ------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const { scene, sun, hemi, sky } = createScene();
const daylight = createDaylight({ sun, hemi, sky });
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);

const aspect = () => window.innerWidth / window.innerHeight;
const controller = createCityCamera(aspect(), { zoom: 52, target: [0, 0] });
const { camera } = controller;
controller.update(aspect());

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  controller.update(aspect());
});

// --- The level --------------------------------------------------------------

/** The generated city, as a level — the thing "Reset" goes back to and the first-run default. */
function generatedLevel() {
  const blocks = createLayout(makeRng(MESH_SEED));
  return levelFromCity(cityNetwork(), blocks);
}

let level = loadLevel() ?? generatedLevel();

// Every lattice position, whether or not a road currently reaches it. A junction with no roads is
// still somewhere you can draw *to*, so the editor keeps the full set and lets `bakeNetwork` ignore
// the ones nothing connects.
const NODES = latticeNodes();
const nodeById = new Map(NODES.map((n) => [n.id, n]));

const edgeKey = (a, b) => latticeEdgeId(a, b);
const hasEdge = (a, b) => level.edges.some((e) => e.id === edgeKey(a, b));

/** The four lattice junctions one block from this one. */
function neighbours(node) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([di, dj]) => nodeById.get(`${node.gi + di},${node.gj + dj}`))
    .filter(Boolean);
}

// --- Meshing ----------------------------------------------------------------

let cityGroup = null;
let blocks = [];

/** Drop a group's geometries and materials — the editor rebuilds on every edit, so this matters. */
function dispose(group) {
  group?.traverse((o) => {
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose();
  });
}

function rebuild() {
  // `level.nodes` carries every lattice position; bake only the ones a road reaches, or the graph
  // picks up isolated nodes with no arms and the face walk has nothing to do with them.
  const used = new Set(level.edges.flatMap((e) => [e.a, e.b]));
  level.nodes = NODES.filter((n) => used.has(n.id));

  blocks = cityFromLevel(level);

  dispose(cityGroup);
  scene.remove(cityGroup);
  cityGroup = new THREE.Group();
  cityGroup.add(createGround(makeRng(MESH_SEED + 11), blocks));
  cityGroup.add(createBuildings(makeRng(MESH_SEED + 22), blocks).mesh);
  cityGroup.add(createProps(makeRng(MESH_SEED + 33), blocks));
  scene.add(cityGroup);

  drawHandles();
  refreshStatus();
  saveLevel(level);
}

// --- Handles: what you can click -------------------------------------------

const handles = new THREE.Group();
scene.add(handles);

const NODE_GEO = new THREE.SphereGeometry(1.1, 10, 8);
const nodeIdle = new THREE.MeshBasicMaterial({ color: 0x2a3340, transparent: true, opacity: 0.55 });
const nodeLive = new THREE.MeshBasicMaterial({ color: 0xffd23f });
const edgeGhost = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.5 });

function drawHandles() {
  dispose(handles);
  handles.clear();

  const used = new Set(level.edges.flatMap((e) => [e.a, e.b]));
  for (const n of NODES) {
    const dot = new THREE.Mesh(NODE_GEO, used.has(n.id) ? nodeIdle : nodeLive);
    dot.position.set(n.x, 6, n.z);
    dot.userData.node = n;
    handles.add(dot);
  }
}

/** A translucent slab standing in for a road that does not exist yet, while you drag it out. */
function ghostRoad(a, b) {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const geo = new THREE.PlaneGeometry(len, 8);
  geo.rotateX(-Math.PI / 2);
  geo.rotateY(Math.atan2(-(b.z - a.z), b.x - a.x));
  geo.translate((a.x + b.x) / 2, 0.5, (a.z + b.z) / 2);
  return new THREE.Mesh(geo, edgeGhost);
}

// --- Picking ----------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
const pointer = new THREE.Vector2();

/** Where on the ground plane the pointer is, in world units. */
function groundAt(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.intersectPlane(groundPlane, hit) ? { x: hit.x, z: hit.z } : null;
}

/** The lattice junction nearest a world point, if it is close enough to have been aimed at. */
function nodeNear(p, radius = PITCH * 0.42) {
  let best = null;
  let bestD = radius;
  for (const n of NODES) {
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

/** The road nearest a world point — distance to the segment, not to its ends. */
function edgeNear(p, radius = 5) {
  let best = null;
  let bestD = radius;
  for (const e of level.edges) {
    const a = nodeById.get(e.a);
    const b = nodeById.get(e.b);
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / (vx * vx + vz * vz)));
    const d = Math.hypot(a.x + vx * t - p.x, a.z + vz * t - p.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

const blockAt = (p) => blocks.find((b) => pointInPolygon(p.x, p.z, b.polygon)) ?? null;

// --- Tools ------------------------------------------------------------------

const HINTS = {
  road: 'Drag between two neighbouring junctions to lay a road. Drag along an existing one to remove it.',
  erase: 'Click a road to remove it. Blocks either side merge into one.',
  park: 'Click a block to turn it into a park, and again to build on it.',
  arterial: 'Click a road to make it a main street — 64% of the green, and a coordinated wave.',
};

let tool = 'road';
const hintEl = document.getElementById('hint');
const statusEl = document.getElementById('status');

function setTool(next) {
  tool = next;
  for (const name of Object.keys(HINTS)) {
    document.getElementById(`tool-${name}`).setAttribute('aria-pressed', String(name === next));
  }
  hintEl.textContent = HINTS[next];
}

function addEdge(a, b) {
  if (hasEdge(a.id, b.id)) return false;
  const outer = a.gi === b.gi ? (a.gi === 0 || a.gi === GRID) : (a.gj === 0 || a.gj === GRID);
  level.edges.push({ id: edgeKey(a.id, b.id), a: a.id, b: b.id, klass: outer ? 'ring' : 'side', wave: 0 });
  return true;
}

function removeEdge(edge) {
  level.edges = level.edges.filter((e) => e.id !== edge.id);
}

// --- Interaction ------------------------------------------------------------

let dragFrom = null;
let ghost = null;

renderer.domElement.addEventListener('pointerdown', (event) => {
  const p = groundAt(event);
  if (!p) return;

  if (tool === 'road') {
    dragFrom = nodeNear(p);
    return;
  }
  if (tool === 'erase') {
    const edge = edgeNear(p);
    if (edge) { removeEdge(edge); rebuild(); }
    return;
  }
  if (tool === 'park') {
    const block = blockAt(p);
    if (block) {
      block.type = block.type === 'park' ? 'built' : 'park';
      level.blocks[keyOf(block)] = { type: block.type };
      rebuild();
    }
    return;
  }
  if (tool === 'arterial') {
    const edge = edgeNear(p);
    if (!edge) return;
    // A main street is a whole line, not one block of it — the green wave is a property of the
    // road, and half an arterial would coordinate with nothing.
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    const along = a.gj === b.gj ? 'x' : 'z';
    const line = along === 'x' ? a.gj : a.gi;
    const makeMain = edge.klass !== 'arterial';
    for (const e of level.edges) {
      const ea = nodeById.get(e.a);
      const eb = nodeById.get(e.b);
      const sameLine = along === 'x'
        ? ea.gj === line && eb.gj === line
        : ea.gi === line && eb.gi === line;
      if (!sameLine || e.klass === 'ring') continue;
      e.klass = makeMain ? 'arterial' : 'side';
      e.wave = makeMain ? 1 : 0;
    }
    rebuild();
  }
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (tool !== 'road' || !dragFrom) return;
  const p = groundAt(event);
  const to = p && nodeNear(p);
  if (ghost) { handles.remove(ghost); ghost.geometry.dispose(); ghost = null; }
  if (to && to !== dragFrom && neighbours(dragFrom).includes(to)) {
    ghost = ghostRoad(dragFrom, to);
    handles.add(ghost);
  }
});

renderer.domElement.addEventListener('pointerup', (event) => {
  if (tool !== 'road' || !dragFrom) return;
  const from = dragFrom;
  dragFrom = null;
  if (ghost) { handles.remove(ghost); ghost.geometry.dispose(); ghost = null; }

  const p = groundAt(event);
  const to = p && nodeNear(p);
  if (!to || to === from || !neighbours(from).includes(to)) return;

  // Dragging along a road you already have takes it out, so one tool both draws and undoes.
  if (hasEdge(from.id, to.id)) removeEdge({ id: edgeKey(from.id, to.id) });
  else addEdge(from, to);
  rebuild();
});

/** The stored key for a block, recomputed because a face's identity is its ring of junctions. */
const keyOf = (block) => block.nodes.slice().sort().join('|');

// --- Status: is this level actually playable? -------------------------------

function refreshStatus() {
  const net = cityNetwork();
  if (!isNetworkConnected(net)) {
    statusEl.className = 'bad';
    statusEl.textContent = `${net.edges.length} roads · not drivable:`
      + " some junctions can't be reached from everywhere";
    return;
  }
  statusEl.className = '';
  const signals = net.nodes.filter((n) => n.signal).length;
  statusEl.textContent = `${net.edges.length} roads · ${blocks.length} blocks · ${signals} signals · drivable`;
}

// --- Buttons ----------------------------------------------------------------

for (const name of Object.keys(HINTS)) {
  document.getElementById(`tool-${name}`).addEventListener('click', () => setTool(name));
}

document.getElementById('reset').addEventListener('click', () => {
  level = generatedLevel();
  rebuild();
});

document.getElementById('clear').addEventListener('click', () => {
  // The ring stays. A city with no roads at all has no faces, so there would be nothing on screen
  // to draw against — and the ring is the one part of the plan the game assumes exists.
  level.edges = level.edges.filter((e) => e.klass === 'ring');
  rebuild();
});

document.getElementById('export').addEventListener('click', async () => {
  const text = JSON.stringify(level, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    hintEl.textContent = 'Level JSON copied to the clipboard.';
  } catch {
    // Clipboard needs a secure context and a permission; a download always works.
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sim-taxi-level.json';
    a.click();
    URL.revokeObjectURL(url);
  }
});

document.getElementById('import').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      level = JSON.parse(await file.text());
      rebuild();
      hintEl.textContent = 'Level loaded.';
    } catch (error) {
      hintEl.textContent = `That file didn't parse: ${error.message}`;
    }
  });
  input.click();
});

document.getElementById('play').addEventListener('click', () => {
  saveLevel(level);
  window.location.href = '/?level=local';
});

// --- Go ---------------------------------------------------------------------

setTool('road');
rebuild();

renderer.setAnimationLoop(() => {
  // Hover highlight, cheap enough to just rebuild the one mesh each frame it changes.
  renderer.render(scene, camera);
});

window.__editor = { get level() { return level; }, rebuild, setTool };

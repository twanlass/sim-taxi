/**
 * Icons that sit inside a line of text — `{:robotaxi}` in a speech line (game/speech.js
 * `parseLine`) — rendered by the game's own renderer, the way tools/icon/ renders the app icon: the
 * real mesh, the real finishes, the game's sun and the game's camera direction. So when the model
 * changes, `node tools/make-inline-icons.mjs` picks it up with nothing here to edit.
 *
 * Unlike the app icon these are transparent (they sit on the speech card, whatever colour it is
 * showing through its glass) and cropped tight to the model, so the text can size them by height.
 *
 * Rendered large with MSAA, then halved down on a 2D canvas, for the reason tools/icon/icon.js
 * gives: one big resample skips most of the source and the chrome sparkles into noise.
 */
import * as THREE from 'three';
import { createRoboTaxiMesh } from '../../src/geometry/robotaxi.js';
import { CAR_LEN, CAR_W } from '../../src/sim/traffic.js';
import { SUN } from '../../src/game/scene.js';
import { VIEW_DIR } from '../../src/game/camera.js';
import { PALETTE } from '../../src/palette.js';
import { setGlossCity } from '../../src/util/geo.js';
import { renderBudget, decideLooks, createRenderPath } from '../../src/game/renderpath.js';
import { SKYLINE_CEILING } from '../../src/city/buildings.js';
import { makeRng } from '../../src/util/rng.js';

// What each icon is, by the name a line uses for it. `yaw` turns the model under the game's fixed
// camera: π/4 is a pure side-on view (world (1, 0, −1) is screen right), and less than that swings
// the nose down toward the viewer, a three-quarter view that shows the end and the glass roof.
export const INLINE_ICONS = {
  robotaxi: {
    build: () => {
      const robo = createRoboTaxiMesh(CAR_LEN, CAR_W);
      robo.shell.visible = true;
      return robo.group;
    },
    yaw: Math.PI / 4 - 0.2,
  },
};
// Output height in pixels. The card sizes an icon to 1.15em of 17px type, ~20 CSS px, so this
// covers a 3x phone with a little to spare.
const OUT_H = 72;
// The render's height; its width follows the model's aspect.
const RENDER_H = 1152;
// Transparent margin round the model, as a fraction of its height: the halving filter spreads the
// silhouette by a pixel or two and a crop flush to the model would clip it.
const PAD = 0.04;

const budget = renderBudget();
budget.bloom = false;   // tools/icon/icon.js: the composite washes a lone model out to pastel
decideLooks(budget);
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: true, alpha: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.id = 'render';
document.body.appendChild(renderer.domElement);
const renderPath = createRenderPath(renderer, budget);

// The stand-in skyline for the chrome to reflect, as tools/icon/icon.js builds it (its comment says
// why): without one the robo-taxi's mirror finish reflects bare sky and reads as flat grey.
{
  const cell = 0.5;
  const reach = 64;
  const nx = (2 * reach) / cell;
  const rng = makeRng(7);
  const heights = new Float32Array(nx * nx);
  const blockHeight = new Map();
  for (let ci = 0; ci < nx; ci++) {
    for (let cj = 0; cj < nx; cj++) {
      const x = -reach + (ci + 0.5) * cell;
      const z = -reach + (cj + 0.5) * cell;
      const bx = Math.floor((x + 10.5) / 21);
      const bz = Math.floor((z + 10.5) / 21);
      const inX = Math.abs(x - bx * 21) > 4.5 && Math.abs(x - bx * 21) < 10.5;
      const inZ = Math.abs(z - bz * 21) > 4.5 && Math.abs(z - bz * 21) < 10.5;
      if (!inX || !inZ) continue;
      const key = `${Math.floor(x / 10.5)},${Math.floor(z / 10.5)}`;
      if (!blockHeight.has(key)) blockHeight.set(key, rng.range(5, SKYLINE_CEILING - 2));
      heights[ci * nx + cj] = blockHeight.get(key);
    }
  }
  setGlossCity({ x0: -reach, z0: -reach, nx, nz: nx, cell, heights }, SKYLINE_CEILING);
}

function halve(source, w, h) {
  let current = source;
  let cw = source.width;
  let ch = source.height;
  while (cw / 2 >= w) {
    cw = Math.round(cw / 2);
    ch = Math.round(ch / 2);
    const step = document.createElement('canvas');
    step.width = cw; step.height = ch;
    const ctx = step.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, cw, ch);
    current = step;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, w, h);
  return out;
}

function renderIcon({ build, yaw }) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, SUN.fill));
  const sun = new THREE.DirectionalLight(PALETTE.sun, SUN.intensity);
  sun.position.set(
    Math.cos(SUN.azimuth) * Math.cos(SUN.elevation),
    Math.sin(SUN.elevation),
    Math.sin(SUN.azimuth) * Math.cos(SUN.elevation),
  ).multiplyScalar(30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 80 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  const model = build();
  model.rotation.y = yaw;
  scene.add(model);
  model.updateMatrixWorld(true);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 40, 60);
  camera.position.copy(VIEW_DIR).multiplyScalar(50);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  // The model's projected bounds, from every vertex (a box's corners overshoot a rounded pod).
  const view = new THREE.Box3();
  const v = new THREE.Vector3();
  model.traverse((obj) => {
    if (!obj.isMesh || !obj.visible || !obj.parent.visible) return;
    const pos = obj.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      view.expandByPoint(v);
    }
  });
  const pad = (view.max.y - view.min.y) * PAD;
  Object.assign(camera, {
    left: view.min.x - pad, right: view.max.x + pad, top: view.max.y + pad, bottom: view.min.y - pad,
  });
  camera.updateProjectionMatrix();
  const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
  renderer.setSize(Math.round(RENDER_H * aspect), RENDER_H, false);

  renderPath.addOverlays(scene);
  renderPath.render(scene, camera);
  const frame = document.createElement('canvas');
  frame.width = renderer.domElement.width;
  frame.height = renderer.domElement.height;
  frame.getContext('2d').drawImage(renderer.domElement, 0, 0);
  return halve(frame, Math.round(OUT_H * aspect), OUT_H);
}

const icons = {};
for (const [name, def] of Object.entries(INLINE_ICONS)) {
  const canvas = renderIcon(def);
  icons[name] = canvas.toDataURL('image/png');
  const big = document.createElement('img');
  big.src = icons[name];
  big.style.height = `${OUT_H * 2}px`;
  document.body.appendChild(big);
  const card = document.createElement('p');
  card.innerHTML = `Those rolling toasters <img src="${icons[name]}" alt=""> brake for pigeons. I have no idea why people like ’em.`;
  document.body.appendChild(card);
}
renderer.domElement.remove();
window.__inlineIcons = icons;
document.body.dataset.iconReady = '1';

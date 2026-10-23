/**
 * The app icon, rendered by the game's own renderer: the real taxi mesh (`createTaxiMesh`), the real
 * finishes (`propMaterial({ gloss })` reading `FINISH_DEFAULTS`), the real sun and fill
 * (`createScene`'s numbers) and the game's camera direction (`VIEW_DIR`). So when the car or its
 * paint changes, `node tools/make-icon.mjs` picks it up with nothing here to edit.
 *
 * It replaced an analytic SVG drawn face by face with hand-picked tones. That was the right call
 * while the car was flat-shaded Lambert — three tones per box survived a 180px resample better than
 * a WebGL frame did — and stopped being one when the car grew a glint, a flaked sheen and a
 * reflection, none of which an SVG polygon can carry.
 *
 * Rendered once, large (`RENDER` px with MSAA), then stepped down by halves on a 2D canvas to each
 * size: a single 2048 → 16 resample skips most of the source pixels and the car sparkles into
 * noise, where repeated halving averages every one of them.
 */
import * as THREE from 'three';
import { createTaxiMesh, TAXI_SCALE } from '../../src/geometry/taxi.js';
import { SUN } from '../../src/game/scene.js';
import { VIEW_DIR } from '../../src/game/camera.js';
import { createLocoFlame } from '../../src/game/locoflame.js';
import { PALETTE } from '../../src/palette.js';
import { setGlossGlobal, GLOSS_GLOBAL_DEFAULTS, setGlossCity, setPaintLook, setFlip } from '../../src/util/geo.js';
import { getPaintLook, getFlip } from '../../src/util/shot.js';
import { SKYLINE_CEILING } from '../../src/city/buildings.js';
import { makeRng } from '../../src/util/rng.js';

// The purple the icon has always been on — `theme_color` in public/manifest.webmanifest — as the
// middle of a gentle diagonal: a pinker lavender in the upper left, a bluer violet in the lower
// right, and a soft lift behind the car (Tyler, 2026-10-23: "a subtle pop"). Kept close in hue and
// value so it still reads as the one purple at 32px.
const BG = '#A46BFF';
const BG_STOPS = [[0, '#C07CFF'], [0.5, BG], [1, '#7F5BFF']];
const BG_GLOW = 'rgba(255, 235, 255, 0.22)';
// A deep violet rather than black: black on #A46BFF greys out and reads dirty.
const SHADOW = '#3E1878';
const SHADOW_OPACITY = 0.55;

const RENDER = 2048;
// Every file make-icon.mjs writes, by size. 1024 is the App Store icon, 180 the iOS Home Screen,
// 192/512 the manifest, 16/32 the tab.
const SIZES = [1024, 512, 192, 180, 32, 16];

// Which way the car points. π/2 is world −Z, which this camera draws as straight up and to the
// right: the car rocketing away into the screen with its plumes trailing toward the lower left,
// Tyler's ask (2026-10-23). The old icon had 0 (world +X, bonnet to the lower right), which left the
// tailpipe at the far end and the flame a tongue peeking past the rear quarter.
const YAW = Math.PI / 2;
// How much of the frame the widest extent (car plus plumes, measured from the car's own centre)
// fills. iOS's superellipse crops about 10% off each corner, and the plume tips reach toward the
// lower left one.
const FILL = 0.86;
// Twin tailpipes, for the icon only: how far each sits off the centreline, in world units. The game
// burns one plume from the middle of the bumper; two read as a rocket's pair of engines.
const PIPE_SPREAD = 0.5;

const renderer = new THREE.WebGLRenderer({
  antialias: true, stencil: true, preserveDrawingBuffer: true, alpha: false,
});
renderer.setPixelRatio(1);
renderer.setSize(RENDER, RENDER, false);
renderer.domElement.id = 'render';
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = RENDER;
  const ctx = canvas.getContext('2d');
  const linear = ctx.createLinearGradient(0, 0, RENDER, RENDER);
  for (const [at, c] of BG_STOPS) linear.addColorStop(at, c);
  ctx.fillStyle = linear;
  ctx.fillRect(0, 0, RENDER, RENDER);
  const glow = ctx.createRadialGradient(RENDER / 2, RENDER / 2, 0, RENDER / 2, RENDER / 2, RENDER * 0.55);
  glow.addColorStop(0, BG_GLOW);
  glow.addColorStop(1, 'rgba(255, 235, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, RENDER, RENDER);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
})();

// The finishes as the game sets them up (game/renderpath.js): the paint look and its flip colour.
// The rim line is left off — it reads the AO prepass's depth, which this page has no pass for.
setPaintLook(getPaintLook());
setFlip(getFlip());

// Something for the paint and chrome to reflect. In the game that is the city's own height field
// (main.js hands it over with setGlossCity), which is what puts a skyline sliding across the body;
// with nothing there the reflection is bare sky and the car reads flat. So a stand-in skyline: the
// game's 12-unit blocks on a 21-unit pitch, the car at a crossing, towers at city heights.
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
      // Junction at the origin: streets 9 wide centred on multiples of 21, blocks between.
      const bx = Math.floor((x + 10.5) / 21);
      const bz = Math.floor((z + 10.5) / 21);
      const inX = Math.abs(x - (bx * 21)) > 4.5 && Math.abs(x - bx * 21) < 10.5;
      const inZ = Math.abs(z - (bz * 21)) > 4.5 && Math.abs(z - bz * 21) < 10.5;
      if (!inX || !inZ) continue;
      // Each block split into four lots, a tower apiece.
      const key = `${Math.floor(x / 10.5)},${Math.floor(z / 10.5)}`;
      if (!blockHeight.has(key)) blockHeight.set(key, rng.range(5, SKYLINE_CEILING - 2));
      heights[ci * nx + cj] = blockHeight.get(key);
    }
  }
  setGlossCity({ x0: -reach, z0: -reach, nx, nz: nx, cell, heights }, SKYLINE_CEILING);
}

// The game's lights at the game's numbers (game/scene.js), minus the city-sized shadow frustum.
scene.add(new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, SUN.fill));
const sun = new THREE.DirectionalLight(PALETTE.sun, SUN.intensity);
sun.position.set(
  Math.cos(SUN.azimuth) * Math.cos(SUN.elevation),
  Math.sin(SUN.elevation),
  Math.sin(SUN.azimuth) * Math.cos(SUN.elevation),
).multiplyScalar(30);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 80 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const taxi = createTaxiMesh();
taxi.setOccupied(true);       // the roof sign lit, the way it drives with a fare aboard
taxi.group.rotation.y = YAW;
scene.add(taxi.group);

// Loco Mode lit: the game's own tailpipe flame, driven exactly as main.js drives it. One update
// longer than its attack brings it to full heat; FLAME_CLOCK picks the flipbook frame and the point
// in its pulse, chosen by eye for a long tongue with a lick in the tip.
// The second pipe's clock is a little further on, so the pair is not two copies of one shape.
const FLAME_CLOCKS = [0.21, 0.29];
const flames = [-1, 1].map((side, n) => {
  const flame = createLocoFlame(scene);
  flame.update(FLAME_CLOCKS[n], {
    x: side * PIPE_SPREAD * Math.sin(YAW), z: side * PIPE_SPREAD * Math.cos(YAW), yaw: YAW, crashed: false,
  }, true);
  return flame;
});

// The ground only exists as a soft shadow straight under the car — the purple is the background.
// It was the sun's cast shadow, which this camera throws off to the upper right as a hard-edged
// second car (Tyler, 2026-10-23: "it's not working"). The sun still shadows the car on itself.
{
  const SIZE = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.filter = `blur(${SIZE * 0.045}px)`;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(SIZE * 0.2, SIZE * 0.2, SIZE * 0.6, SIZE * 0.6, SIZE * 0.12);
  ctx.fill();
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: SHADOW, alphaMap: new THREE.CanvasTexture(canvas), transparent: true,
      opacity: SHADOW_OPACITY, depthWrite: false,
    }),
  );
  // The painted square is 0.6 of the texture, so this puts its core on the body's footprint plus
  // the tyres' overhang, and the blur spills past it.
  const len = (3.4 * TAXI_SCALE) / 0.6 * 0.9;
  const wide = (1.7 * TAXI_SCALE) / 0.6 * 1.05;
  blob.scale.set(len, 1, wide);
  blob.rotation.y = YAW;
  blob.position.y = 0.01;
  scene.add(blob);
}

// The game's camera: orthographic, down VIEW_DIR. Centred on the *car's* projected bounds and sized
// to hold the plumes too: centring on car plus flames put the body visibly off to one side, since
// the plumes only ever trail one way.
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
camera.position.copy(VIEW_DIR).multiplyScalar(50);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

taxi.group.updateMatrixWorld(true);
for (const flame of flames) flame.group.updateMatrixWorld(true);
const box = new THREE.Box3();
const corner = new THREE.Vector3();
const carView = new THREE.Box3();
const view = new THREE.Box3();
const isFlame = (obj) => flames.some((flame) => flame.group.getObjectById(obj.id));
[taxi.group, ...flames.map((flame) => flame.group)].forEach((root) => root.traverse((obj) => {
  // Only what casts a shadow is the car itself: the ghost outline's hulls are far bigger than the
  // body and draw nothing here, and counting them left the taxi a speck in the middle of the frame.
  // The flame casts none, so it is let in by name — the frame has to hold the whole plume.
  const plume = isFlame(obj);
  if (!obj.isMesh || !(obj.castShadow || plume)) return;
  if (!obj.parent.visible) return;
  // Hidden-by-scale parts (damage, the door, unlit lamps) collapse to a point and must not count.
  const e = obj.matrixWorld.elements;
  if (Math.abs(e[0]) + Math.abs(e[5]) + Math.abs(e[10]) < 1e-6) return;
  if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
  box.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    corner.applyMatrix4(camera.matrixWorldInverse);
    view.expandByPoint(corner);
    if (!plume) carView.expandByPoint(corner);
  }
}));
const cx = (carView.min.x + carView.max.x) / 2;
const cy = (carView.min.y + carView.max.y) / 2;
const half = Math.max(cx - view.min.x, view.max.x - cx, cy - view.min.y, view.max.y - cy) / FILL;
Object.assign(camera, { left: cx - half, right: cx + half, top: cy + half, bottom: cy - half });
camera.updateProjectionMatrix();

// The paint's flake is sized for play zoom, where `flakeSize` cells per unit put each one under a
// pixel (1 unit is ~7.7px there) and the flake averages into a livelier sheen. The icon frames the
// car about 25x closer, which at the shipped number makes every flake a 7px square — the bonnet
// reads as gravel. So it is held at the same *screen* size it is designed for instead: just under
// a pixel and a half at 1024, averaging away by 180. Every other finish number is the shipped one.
// Flake cells are counted in the body's own space, which TAXI_SCALE stretches.
const pxPerUnit = (1024 / (2 * half)) * TAXI_SCALE;
setGlossGlobal('flakeSize', Math.max(GLOSS_GLOBAL_DEFAULTS.flakeSize, pxPerUnit / 1.4));

renderer.render(scene, camera);

/** Halve until the next halving would undershoot, then one last resample to the exact size. */
function downsample(source, size) {
  let current = source;
  let w = source.width;
  while (w / 2 >= size) {
    w = Math.round(w / 2);
    const step = document.createElement('canvas');
    step.width = step.height = w;
    const ctx = step.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, w, w);
    current = step;
  }
  if (w === size) return current;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, size, size);
  return out;
}

// Copied into a 2D canvas first so every size comes off one frozen frame, opaque — App Store
// Connect rejects an icon with any alpha channel.
const frame = document.createElement('canvas');
frame.width = frame.height = RENDER;
const fctx = frame.getContext('2d', { alpha: false });
fctx.fillStyle = BG;
fctx.fillRect(0, 0, RENDER, RENDER);
fctx.drawImage(renderer.domElement, 0, 0);

// make-icon.mjs captures each size with a CDP screenshot rather than reading `toDataURL` back: a
// 2D canvas encodes RGBA even when every pixel is opaque, and App Store Connect rejects an icon
// with any alpha channel at all. A screenshot is RGB. So each size is shown alone at the top-left,
// one CSS pixel per pixel, for the capture to clip.
const icons = new Map(SIZES.map((size) => [size, downsample(frame, size)]));
window.__iconSizes = SIZES;
window.__showIcon = (size) => {
  document.body.replaceChildren(icons.get(size));
  Object.assign(icons.get(size).style, {
    position: 'fixed', left: '0', top: '0', width: `${size}px`, height: `${size}px`,
  });
};
// Opened by hand, the page shows the big render and the small sizes beside it.
for (const size of [1024, 180, 32, 16]) document.body.appendChild(icons.get(size).cloneNode(false))
  .getContext('2d').drawImage(icons.get(size), 0, 0);
renderer.domElement.remove();
document.body.dataset.iconReady = '1';

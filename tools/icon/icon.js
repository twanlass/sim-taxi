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
import { setGlossGlobal, GLOSS_GLOBAL_DEFAULTS } from '../../src/util/geo.js';

// The purple the icon has always been on — `theme_color` in public/manifest.webmanifest.
const BG = '#A46BFF';
// A deep violet rather than black: black on #A46BFF greys out and reads dirty.
const SHADOW = '#3E1878';
const SHADOW_OPACITY = 0.5;

const RENDER = 2048;
// Every file make-icon.mjs writes, by size. 1024 is the App Store icon, 180 the iOS Home Screen,
// 192/512 the manifest, 16/32 the tab.
const SIZES = [1024, 512, 192, 180, 32, 16];

// Which way the car points. 0 is world +X: bonnet to the lower right, the three-quarter view the
// old icon drew — but with the Loco flame lit the tailpipe is then at the far end and the plume
// hides behind the car as a thin spike. 30° swings the car toward profile, nose to the right, so the
// flame trails out to the left in full view while the near flank's chequer stripe stays on show.
// 45° is pure profile and loses the bonnet's top face.
const YAW = THREE.MathUtils.degToRad(30);
// How much of the frame the widest extent (car plus plume, which is horizontal) fills. The flame
// tip lands mid-left, clear of the corners iOS's superellipse crops, so this can run wide.
const FILL = 0.9;

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
scene.background = new THREE.Color(BG);

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
const FLAME_CLOCK = 0.21;
const flame = createLocoFlame(scene);
flame.update(FLAME_CLOCK, { x: 0, z: 0, yaw: YAW, crashed: false }, true);

// The ground only exists as the shadow on it — the purple is the background.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
  new THREE.ShadowMaterial({ color: SHADOW, opacity: SHADOW_OPACITY }),
);
ground.receiveShadow = true;
scene.add(ground);

// The game's camera: orthographic, down VIEW_DIR. Framed off the car's own projected bounds, so a
// change to the mesh re-centres itself rather than drifting off the middle of the icon.
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
camera.position.copy(VIEW_DIR).multiplyScalar(50);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

taxi.group.updateMatrixWorld(true);
flame.group.updateMatrixWorld(true);
const box = new THREE.Box3();
const corner = new THREE.Vector3();
const view = new THREE.Box3();
[taxi.group, flame.group].forEach((root) => root.traverse((obj) => {
  // Only what casts a shadow is the car itself: the ghost outline's hulls are far bigger than the
  // body and draw nothing here, and counting them left the taxi a speck in the middle of the frame.
  // The flame casts none, so it is let in by name — the frame has to hold the whole plume.
  if (!obj.isMesh || !(obj.castShadow || flame.group.getObjectById(obj.id))) return;
  if (!obj.parent.visible) return;
  // Hidden-by-scale parts (damage, the door, unlit lamps) collapse to a point and must not count.
  const e = obj.matrixWorld.elements;
  if (Math.abs(e[0]) + Math.abs(e[5]) + Math.abs(e[10]) < 1e-6) return;
  if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
  box.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    view.expandByPoint(corner.applyMatrix4(camera.matrixWorldInverse));
  }
}));
const half = Math.max(view.max.x - view.min.x, view.max.y - view.min.y) / 2 / FILL;
const cx = (view.min.x + view.max.x) / 2;
const cy = (view.min.y + view.max.y) / 2;
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

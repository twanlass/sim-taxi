// The new-chat screen's taxi — /workshop/, not part of the game. See docs/workshop.md.
//
// The game's own taxi (createTaxiMesh), side on, doing its Loco Mode weave and bob on the spot: the
// empty chat panel used to be a paragraph of instructions nobody needed after the first visit. It
// burns the Loco plume out of its tailpipe (game/locoflame.js, the game's own) and sits on a short
// strip of road whose centre dashes stream past underneath it, so it reads as driving flat out
// rather than as a car on a turntable.
//
// **Drawn through the game's render path** (game/renderpath.js), like the bench: the rim line and
// the AO both read a depth prepass, and a plain `renderer.render` has none, so the car came out
// without its rim. The looks themselves were already decided by viewer.js, which is on this page
// and loads first; this only stands up the passes for its own renderer. Every pass sets its global
// uniforms (`setRimDepth`) right before its own frame, so two renderers sharing them is safe.
//
// **Its own hot-reload boundary, like viewer.js.** chat.js must import nothing from the game (an
// edit would re-run it and wipe the conversation), so it loads this lazily, and this accepts
// itself: an edit to the taxi re-runs only this file, which picks its host back up out of
// `hot.data` and redraws with the new car in it.

import * as THREE from 'three';
import { createTaxiMesh } from '../geometry/taxi.js';
import { SPEED, boostCruise, locoWeave } from '../sim/traffic.js';
import { BODY_EULER_ORDER, bakeColor, propMaterial } from '../util/geo.js';
import { ROAD_W, LANE } from '../city/grid.js';
import { PALETTE } from '../palette.js';
import { renderBudget, createRenderPath } from '../game/renderpath.js';
import { createLocoFlame } from '../game/locoflame.js';
import { createDust } from '../game/dust.js';
import { createBlast } from '../game/blast.js';
import { makeRng } from '../util/rng.js';

const hot = import.meta.hot;
let current = null;

// The strip of road: long enough to run past both ends of the car with room to fade, a real
// street's width across. The dashes match `markRoad`'s (the bridge deck copies them the same way,
// geometry/bridge.js), so it is the game's own centre line going by.
const ROAD_LEN = 26;
const DASH = 1.6;
const DASH_GAP = 1.4;
const DASH_W = 0.18;
const PAINT_LIFT = 0.02;

// The hop a click on the taxi buys: a little toy of a jump, landing with the drift launch's own dust
// and ring (main.js's `onTaxiLand`, `big`) turned down to suit a car this small in the panel.
// Gravity rather than a sine so it hangs at the top and drops hard, which is what makes the landing
// read as weight. The nose lifts going up and dips coming down by HOP_PITCH per u/s of climb, and a
// short squash after touchdown sells the thump. The first cut (7.5 u/s against 17.5, 0.86s in the
// air) read as slow and floaty; this one is up and down in half a second.
const HOP_V = 10; // u/s straight up: peaks at HOP_V² / 2g = 1.25 units, in 0.25s
const HOP_G = 40;
const HOP_PITCH = 0.014;
const LAND_DIP = 0.12; // how far the body sinks on touchdown, recovering over LAND_SETTLE
const LAND_SETTLE = 0.22;
// Clicking again in the air kicks it back up from wherever it is, so a fast enough clicker climbs:
// each kick is worth another HOP_V² / 2g on top of the height it was given at. Past HOP_CEIL it
// stalls and stops taking clicks, tips nose-down and comes down hard (CRASH_V on top of gravity),
// landing with a bigger squash and a heavier cloud than a hop. 7 units is about two thirds of the
// way up the panel from the road at this camera.
const HOP_CEIL = 7;
const CRASH_V = 6;
const CRASH_TIP = -0.5; // radians of nose-down pitch on the way down
const CRASH_DIP = 0.32;
const CRASH_SETTLE = 0.45;

// The strip's fade, as an alphaMap: a disc of solid road round the car that falls off to nothing,
// so it is a patch of road under the taxi rather than a bar across the panel. The bar read as a
// band with hard ends at the panel's edges. An alphaMap rather than a colour ramp because the panel
// behind it is the page, not a colour.
const FADE_PX = 10; // canvas pixels per world unit, so the circle stays round on the strip
const FADE_SOLID = 2.6; // world units of fully opaque road round the car
const FADE_OUT = 6; // ... and where it has faded to nothing
function fadeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = ROAD_LEN * FADE_PX;
  canvas.height = ROAD_W * FADE_PX;
  const g = canvas.getContext('2d');
  // Centred on the car's lane, LANE to +Z of the road's middle. The texture is flipped on upload,
  // so +Z (v near 1) is the top of the canvas.
  const cx = canvas.width / 2;
  const cy = (0.5 - LANE / ROAD_W) * canvas.height;
  const disc = g.createRadialGradient(cx, cy, 0, cx, cy, FADE_OUT * FADE_PX);
  disc.addColorStop(0, '#fff');
  disc.addColorStop(FADE_SOLID / FADE_OUT, '#fff');
  disc.addColorStop(1, '#000');
  g.fillStyle = disc;
  g.fillRect(0, 0, canvas.width, canvas.height);
  return new THREE.CanvasTexture(canvas);
}

/** Draws the taxi into `host` until the host leaves the page or the module is replaced. */
export function mount(host) {
  if (current?.host === host) return;
  current?.dispose();

  const budget = renderBudget();
  const renderer = new THREE.WebGLRenderer({ antialias: budget.msaa, alpha: true, stencil: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);
  const renderPath = createRenderPath(renderer, budget);

  const scene = new THREE.Scene();
  renderPath.addOverlays(scene);
  scene.add(new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 1.6));
  const sun = new THREE.DirectionalLight(PALETTE.sun, 2.4);
  sun.position.set(3, 8, 6);
  // The shadow is what sets the car down on the road; a few units round the car is all it covers.
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 30 });
  scene.add(sun);

  // createTaxiMesh hands back the taxi's controls (lights, steer, damage), the drawn car is `group`.
  const { group: taxi } = createTaxiMesh();
  // Only the shell, wheels and bumpers: the ghost outline has nothing in front of it to show
  // through here, and the picker's hit box is invisible anyway.
  taxi.traverse((o) => {
    if (o.name === 'ghostMask' || o.name === 'ghostRim') o.visible = false;
    else if (o.isMesh) o.castShadow = true;
  });
  const pose = new THREE.Group();
  pose.add(taxi);
  scene.add(pose);

  // The road, with the car in its right-hand lane (+Z is the driver's right facing +X), so the
  // centre line runs past on the far side of it. UVs rebuilt after baking, which strips them.
  const fade = fadeTexture();
  const roadMaterial = propMaterial({ ao: false });
  roadMaterial.alphaMap = fade;
  roadMaterial.transparent = true;
  roadMaterial.depthWrite = false;
  const roadGeometry = bakeColor(new THREE.PlaneGeometry(ROAD_LEN, ROAD_W).rotateX(-Math.PI / 2), PALETTE.asphalt);
  {
    const pos = roadGeometry.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let k = 0; k < pos.count; k++) {
      uv[k * 2] = pos.getX(k) / ROAD_LEN + 0.5;
      uv[k * 2 + 1] = pos.getZ(k) / ROAD_W + 0.5;
    }
    roadGeometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const road = new THREE.Mesh(roadGeometry, roadMaterial);
  road.position.z = -LANE;
  road.receiveShadow = true;
  scene.add(road);

  // The dashes are what move: one strip of quads rewritten each frame, slid back by the distance
  // driven modulo one dash period. Their UVs follow their x into the same fade, so a dash comes in
  // out of nothing at the front and goes out at the back. Wound to face up, (a, b, c) and (a, c, d)
  // with b − a along +Z and c − a along +X.
  const PERIOD = DASH + DASH_GAP;
  const dashCount = Math.ceil(ROAD_LEN / PERIOD) + 1;
  const dashPos = new Float32Array(dashCount * 18);
  const dashUv = new Float32Array(dashCount * 12);
  const dashColor = new Float32Array(dashCount * 18);
  const dashNormal = new Float32Array(dashCount * 18);
  const paint = new THREE.Color(PALETTE.laneMark);
  for (let k = 0; k < dashCount * 6; k++) {
    dashColor.set([paint.r, paint.g, paint.b], k * 3);
    dashNormal.set([0, 1, 0], k * 3);
  }
  const dashGeometry = new THREE.BufferGeometry();
  dashGeometry.setAttribute('position', new THREE.BufferAttribute(dashPos, 3));
  dashGeometry.setAttribute('uv', new THREE.BufferAttribute(dashUv, 2));
  dashGeometry.setAttribute('color', new THREE.BufferAttribute(dashColor, 3));
  dashGeometry.setAttribute('normal', new THREE.BufferAttribute(dashNormal, 3));
  const dashMaterial = propMaterial({ ao: false });
  dashMaterial.alphaMap = fade;
  dashMaterial.transparent = true;
  dashMaterial.depthWrite = false;
  const dashes = new THREE.Mesh(dashGeometry, dashMaterial);
  dashes.renderOrder = 1;
  dashes.frustumCulled = false;
  dashes.receiveShadow = true;
  // On the road's own centre line (z = 0 of the road's frame).
  road.add(dashes);

  const layDashes = (driven) => {
    const slide = driven % PERIOD;
    const w = DASH_W / 2;
    const vz0 = 0.5 - w / ROAD_W;
    const vz1 = 0.5 + w / ROAD_W;
    for (let k = 0; k < dashCount; k++) {
      const x0 = -ROAD_LEN / 2 + k * PERIOD - slide;
      const x1 = x0 + DASH;
      const u0 = x0 / ROAD_LEN + 0.5;
      const u1 = x1 / ROAD_LEN + 0.5;
      const corners = [[x0, -w, u0, vz0], [x0, w, u0, vz1], [x1, w, u1, vz1],
        [x0, -w, u0, vz0], [x1, w, u1, vz1], [x1, -w, u1, vz0]];
      corners.forEach(([x, z, u, v], c) => {
        dashPos.set([x, PAINT_LIFT, z], (k * 6 + c) * 3);
        dashUv.set([u, v], (k * 6 + c) * 2);
      });
    }
    dashGeometry.attributes.position.needsUpdate = true;
    dashGeometry.attributes.uv.needsUpdate = true;
  };

  // The game's tailpipe plume, held on: it reads its pipe off a car-shaped object, so the pose is
  // handed to it in the sim's terms (yaw about +Y, heading +X at 0; the lift is the bob).
  const flame = createLocoFlame(scene);
  const car = { x: 0, z: 0, yaw: 0, crashed: false, shownLift: 0 };

  // Side on, the car's nose (+X) to the right, stood well back (×4.7 the old 13-unit standoff) so
  // the car is a small mark in the empty panel, about a fifth of its width. Looking down about 22°
  // rather than the 7° it started at: at 7° the 8-unit road foreshortened to a sliver a unit tall
  // and the dashes going by could not be told from a line.
  const BACK = 4.7;
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
  camera.position.set(0, 1.0 + 5.2 * BACK, 13 * BACK);
  camera.lookAt(0, 1.0, 0);

  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  // Paced exactly as the taxi is in Loco Mode at its boost cruise: the weave by distance driven
  // (`locoWeave`), its yaw the slope's angle, and the speed bob off the same distance at the same
  // 2.4 rad/unit and 0.045 × v/SPEED as every car in sim/traffic.js. Only the car never moves; the
  // road's dashes go by at that same v instead.
  const v = boostCruise();

  // The hop. A click lands on the taxi through the picker's own hit box (invisible, but a raycast
  // does not care), so the target is the generous one the game taps against rather than the
  // bodywork's exact outline. A click while airborne kicks it higher (HOP_CEIL above); once it has
  // stalled at the top, clicks do nothing until it is back on the road.
  const dust = createDust(scene, camera, makeRng(7));
  const blast = createBlast(scene, makeRng(11));
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hop = { y: 0, vy: 0, air: false, crash: false, settle: 0, settleLen: LAND_SETTLE, dipDepth: LAND_DIP, tip: 0 };
  const overTaxi = (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObject(taxi, true).length > 0;
  };
  const onDown = (event) => {
    if (hop.crash || !overTaxi(event)) return;
    Object.assign(hop, { air: true, vy: HOP_V });
  };
  const onMove = (event) => { renderer.domElement.style.cursor = overTaxi(event) ? 'pointer' : ''; };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointermove', onMove);
  const land = (z) => {
    const crashed = hop.crash;
    Object.assign(hop, {
      y: 0, vy: 0, air: false, crash: false, tip: 0,
      settle: crashed ? CRASH_SETTLE : LAND_SETTLE,
      settleLen: crashed ? CRASH_SETTLE : LAND_SETTLE,
      dipDepth: crashed ? CRASH_DIP : LAND_DIP,
    });
    // Thrown backwards along the road (yaw π is heading −X) at the road's own speed, so the dust
    // stays on the tarmac it came off as the tarmac streams past, rather than keeping up with a car
    // that in this scene never moves.
    if (crashed) dust.burst(0, z, Math.PI, 40, 1.1, { ring: 3, linger: 1.4, carry: v * 0.6 });
    else dust.burst(0, z, Math.PI, 18, 0.55, { ring: 1.6, linger: 0.9, carry: v * 0.6 });
    blast.shock(0, z, { tint: PALETTE.landRing, yaw: Math.PI, speed: v });
  };

  const start = performance.now();
  let last = start;
  let frame = 0;
  const tick = () => {
    frame = requestAnimationFrame(tick);
    if (!host.isConnected) { dispose(); return; }
    const now = performance.now();
    // Capped so a backgrounded tab coming back does not hand the flame one enormous step.
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const u = ((now - start) / 1000) * v;
    const wave = locoWeave(u);
    const bob = Math.sin(u * 2.4) * 0.045 * (v / SPEED);
    if (hop.air) {
      hop.vy -= HOP_G * dt;
      hop.y += hop.vy * dt;
      if (!hop.crash && hop.y >= HOP_CEIL) Object.assign(hop, { crash: true, vy: -CRASH_V });
      // Eased toward the dive rather than snapped, so the stall reads as it tipping over.
      if (hop.crash) hop.tip += (CRASH_TIP - hop.tip) * Math.min(1, dt * 8);
      if (hop.y <= 0) land(wave.lateral);
    }
    hop.settle = Math.max(0, hop.settle - dt);
    const dip = -hop.dipDepth * Math.sin((hop.settle / hop.settleLen) * Math.PI);
    const lift = bob + hop.y + dip;
    pose.position.set(0, lift, wave.lateral);
    // Negated: a positive yaw turns +X toward −Z, and the lateral offset here runs along +Z.
    const yaw = -Math.atan(wave.slope);
    // Pitch is the third slot of BODY_EULER_ORDER; positive turns the nose (+X) up.
    const pitch = !hop.air ? 0 : hop.crash ? hop.tip : hop.vy * HOP_PITCH;
    pose.rotation.set(0, yaw, pitch, BODY_EULER_ORDER);
    Object.assign(car, { z: wave.lateral, yaw, shownLift: lift });
    flame.update(dt, car, true);
    dust.update(dt);
    blast.update(dt);
    layDashes(u);
    renderPath.render(scene, camera);
  };
  tick();

  function dispose() {
    cancelAnimationFrame(frame);
    observer.disconnect();
    renderer.domElement.removeEventListener('pointerdown', onDown);
    renderer.domElement.removeEventListener('pointermove', onMove);
    renderer.domElement.remove();
    renderPath.dispose();
    // The flame's tongue geometries are module-wide and shared with nothing else here, but they
    // outlive this mount, so only its materials go.
    flame.materials.forEach((m) => m.dispose());
    [roadGeometry, dashGeometry].forEach((g) => g.dispose());
    [roadMaterial, dashMaterial, fade].forEach((m) => m.dispose());
    renderer.dispose();
    if (current?.dispose === dispose) current = null;
  }
  current = { host, dispose };
}

if (hot) {
  hot.accept();
  if (hot.data.host?.isConnected) mount(hot.data.host);
  hot.dispose((data) => {
    data.host = current?.host;
    current?.dispose();
  });
}

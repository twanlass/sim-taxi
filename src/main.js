import * as THREE from 'three';
import { makeRng } from './util/rng.js';
import { createScene } from './game/scene.js';
import { createCityCamera } from './game/camera.js';
import { createLayout } from './city/layout.js';
import { createGround } from './city/ground.js';
import { createBuildings } from './city/buildings.js';
import { createProps } from './city/props.js';
import { createTraffic } from './sim/traffic.js';
import { createPolice } from './sim/police.js';
import { createFareSystem, cornerFor, setFareSeconds, getFareSeconds, FARE_VALUE } from './game/fares.js';
import { createDebugPanel } from './game/debugpanel.js';
import { createBoost } from './game/boost.js';
import { createSkidMarks } from './game/skidmarks.js';
import { createDust } from './game/dust.js';
import { createDaylight, DAY_SECONDS } from './game/daylight.js';
import { createPicker } from './game/pick.js';
import { createRouteLine } from './game/routeline.js';
import { findRoute, planOrigin } from './game/route.js';
import { getActiveShot, getSeed, getRunSeed, getCarCount } from './util/shot.js';

const seed = getSeed();                             // the city itself — stable, so it's learnable
const shot = getActiveShot();
const runSeed = getRunSeed(seed, Boolean(shot));    // this run's situation — random unless pinned

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: Boolean(shot),
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const { scene, sun, hemi, sky } = createScene();

// The clock that drives the sky. Parked at golden hour for now — the cycle works, but the night
// end of it needs more tuning before it earns its place, so it's off until the ⚙️ panel turns it
// on. Screenshots keep it frozen regardless: a rendered shot has to be reproducible.
const daylight = createDaylight({ sun, hemi, sky });
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);

// Every generator draws from its own stream so that changing one system doesn't reshuffle the
// others — editing building code shouldn't move the parks.
const layout = createLayout(makeRng(seed));
scene.add(createGround(makeRng(seed + 11), layout));
scene.add(createBuildings(makeRng(seed + 22), layout).mesh);
scene.add(createProps(makeRng(seed + 33), layout));

const traffic = createTraffic(makeRng(runSeed + 44), scene, getCarCount());
const fares = createFareSystem(makeRng(runSeed + 55), scene);
const police = createPolice(makeRng(runSeed + 66), scene);
// Fixed camera framing the whole city. No panning, so every click is unambiguous — this is why
// city-lab's attachCameraControls (which binds pointerdown to drag-pan) is deliberately unused.
const aspect = () => window.innerWidth / window.innerHeight;
const controller = createCityCamera(aspect(), {
  zoom: shot?.zoom ?? 52,
  target: shot?.target ?? [0, 0],
});
const { camera } = controller;
controller.update(aspect());

const dust = createDust(scene, camera, makeRng(seed + 77));

// Orthographic camera: the vertical world span is exactly 2 * zoom, so world-units-per-pixel
// falls straight out of the frustum height.
const boost = createBoost();
const skids = createSkidMarks(scene);

const routeLine = createRouteLine(
  scene,
  () => (2 * controller.state.zoom) / renderer.domElement.clientHeight,
);

// --- Selection and routing --------------------------------------------------

// The taxi is permanently selected. There is only ever one, so a selection step was pure
// ceremony: every tap on it was either a no-op or an accidental deselect that made the next tap
// on a fare do nothing.
const selected = true;
traffic.taxiSelection.visible = true;

/**
 * Route the taxi to an intersection. Planning starts from the intersection the taxi is *heading
 * toward* plus its current heading, because that is the first point at which it can make a choice.
 */
function routeTo(target) {
  const car = traffic.taxi;
  const route = findRoute(planOrigin(car), target);
  if (!route) return false;
  car.route = route;
  car.routeConsumed = false;
  car.pendingTarget = target;
  return true;
}

createPicker(
  camera,
  renderer.domElement,
  () => [traffic.taxiGroup, ...fares.pickables()],
  (kind) => {
    if (fares.state.gameOver) return;

    if (kind === 'passenger' || kind === 'destination') {
      if (routeTo(fares.state.target)) {
        fares.markDirected();
        flash('On the way');
      }
    }
  },
);

// --- HUD --------------------------------------------------------------------

const hud = {
  money: document.getElementById('money'),
  banner: document.getElementById('run-end'),
  toast: document.getElementById('toast'),
};

// The counter lags the payout on purpose: the flying "$20" lands first, then the total ticks.
let shownMoney = 0;

/** Screen position of the taxi, for anchoring the earnings pop. */
function taxiScreenPos() {
  const v = new THREE.Vector3(traffic.taxi.x, 1.4, traffic.taxi.z).project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
  };
}

function popEarning(amount) {
  const at = taxiScreenPos();
  const el = document.createElement('div');
  el.className = 'earning';
  el.textContent = `$${amount}`;
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  document.body.append(el);

  el.addEventListener('animationend', () => {
    el.remove();
    shownMoney = fares.state.money;
    if (hud.money) hud.money.textContent = String(shownMoney);
  }, { once: true });
}

let toastTimer = 0;
function flash(text) {
  if (!hud.toast) return;
  hud.toast.textContent = text;
  hud.toast.style.opacity = '1';
  toastTimer = 1.6;
}


function updateHud(dt) {
  const s = fares.state;

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0 && hud.toast) hud.toast.style.opacity = '0';
  }

  if (s.gameOver && hud.banner && hud.banner.hidden) {
    hud.banner.hidden = false;
    hud.banner.innerHTML = `<strong>Run over</strong><span>${s.failReason}</span>`
      + `<span>${s.delivered} fares · $${s.money}</span>`
      + '<span class="small">refresh to try again</span>';
  }
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  controller.resize(aspect());
});

// --- Crazy taxi button ------------------------------------------------------

const boostButton = document.getElementById('boost');

function updateBoostButton() {
  if (!boostButton) return;
  const mode = boost.state.mode;
  boostButton.classList.toggle('is-active', mode === 'active');
  boostButton.classList.toggle('is-charging', mode === 'recharging');
  boostButton.style.setProperty('--pct', `${(boost.fraction() * 100).toFixed(1)}%`);
  boostButton.disabled = mode === 'recharging';
}

boostButton?.addEventListener('click', () => {
  if (fares.state.gameOver) return;
  if (boost.activate()) flash('Loco Mode!');
});

// Rubber gets laid from the rear wheels while boosting through a corner, spaced by distance so
// the trail is even regardless of frame rate.
let lastSkidAt = 0;
function layRubber() {
  const car = traffic.taxi;

  // `state === 'turn'` covers every junction crossing, including going straight on — which is why
  // rubber was appearing on the straights. An actual turn means the exit direction differs from
  // the entry one, and only after the straight run-up to the junction is done.
  const cornering = car.boost
    && car.state === 'turn'
    && car.dOut !== car.d
    && Math.min(car.turnT, 1) * car.turnLen > car.leadIn;

  if (!cornering) { lastSkidAt = car.travelled; return; }
  // Closer than one mark length, so consecutive stamps overlap into a continuous streak.
  if (car.travelled - lastSkidAt < 0.42) return;
  lastSkidAt = car.travelled;

  const fx = Math.cos(car.yaw);
  const fz = -Math.sin(car.yaw);
  const rx = Math.sin(car.yaw);
  const rz = Math.cos(car.yaw);
  for (const side of [-1, 1]) {
    skids.add(
      car.x - fx * 1.2 + rx * side * 1.04,
      car.z - fz * 1.2 + rz * side * 1.04,
      car.yaw,
    );
  }
}

// Dust comes off the back of the car whenever it's boosting and actually moving — not only in
// corners like the rubber, since the point is to make speed itself read.
let lastDustAt = 0;
function kickDust() {
  const car = traffic.taxi;
  if (!car.boost || car.v < 2) { lastDustAt = car.travelled; return; }
  if (car.travelled - lastDustAt < 0.7) return;
  lastDustAt = car.travelled;
  dust.add(car.x - Math.cos(car.yaw) * 1.9, car.z + Math.sin(car.yaw) * 1.9, car.yaw);
}

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  boost.update(dt);
  traffic.taxi.boost = boost.isActive();
  updateBoostButton();
  skids.update(dt);
  dust.update(dt);
  daylight.update(dt);

  police.update(dt);   // may flip a whole corridor green before traffic reads the signals
  traffic.update(dt);

  const event = fares.update(dt, traffic.taxi);
  if (event === 'pickup') {
    flash('Passenger aboard — tap the destination');
    traffic.taxi.route = [];
    traffic.taxi.pendingTarget = null;
    traffic.taxi.parked = true;   // sit at the kerb until told where to go
    // The taxi now wears this rider's colour, and so does their destination pin.
    traffic.setTaxiFareColor(fares.state.fareColor);
  } else if (event === 'delivered') {
    popEarning(FARE_VALUE);
    traffic.taxi.route = [];
    traffic.taxi.pendingTarget = null;
    traffic.setTaxiFareColor(null);
  } else if (event === 'spawned') {
    flash('New fare waiting');
  }

  // The route is a property of the selection, not of the world — deselecting clears it from view
  // even though the taxi keeps driving it.
  if (selected && traffic.taxi.pendingTarget && !fares.state.gameOver) {
    routeLine.update(traffic.taxi, traffic.taxi.route);
  } else {
    routeLine.hide();
  }

  layRubber();
  kickDust();
  updateHud(dt);
  renderer.render(scene, camera);
}

if (shot) {
  document.body.classList.add('shot-mode');
  traffic.warmup(shot.warmup ?? 12);
  fares.update(0.016, traffic.taxi);          // spawn the first fare

  // Some shots are about the carrying state, which only exists after a pickup. Auto-play the
  // fare loop forward until it happens rather than pointing a camera at an arbitrary moment.
  if (shot.untilPickup) {
    routeTo(fares.state.target);
    fares.markDirected();
    for (let guard = 0; guard < 90 * 60 && fares.state.stage !== 'riding'; guard++) {
      traffic.update(1 / 60);
      const e = fares.update(1 / 60, traffic.taxi);
      if (e === 'pickup') {
        traffic.setTaxiFareColor(fares.state.fareColor);
        routeTo(fares.state.target);
        fares.markDirected();
        // Let the timer finish flying to the taxi, or the shot catches it mid-transfer.
        for (let settle = 0; settle < 90; settle++) {
          traffic.update(1 / 60);
          fares.update(1 / 60, traffic.taxi);
        }
        break;
      }
    }
  }

  // Run forward until the police car is mid-city, so the shot shows a live corridor.
  if (shot.untilPolice) {
    for (let guard = 0; guard < 90 * 60; guard++) {
      police.update(1 / 60);
      traffic.update(1 / 60);
      fares.update(1 / 60, traffic.taxi);
      if (police.state.active && Math.abs(police.state.s) < 30) break;
    }
    // Follow the car rather than hoping it drives through the middle of the frame.
    const pos = police.group.position;
    controller.state.target.set(pos.x, 0, pos.z);
    controller.update(aspect());
  }

  // Frame the waiting rider rather than the middle of the map.
  if (shot.atPassenger && fares.state.target) {
    // Aim at the kerb the rider is standing on, not the middle of the junction — at close zoom
    // the corner building sits squarely between the camera and the figure otherwise.
    const c = cornerFor(fares.state.target.i, fares.state.target.j);
    controller.state.target.set(c.x, 0, c.z);
    controller.update(aspect());
  }


  if (shot.route) { routeTo(fares.state.target); fares.markDirected(); }
  if (selected && traffic.taxi.pendingTarget) {
    routeLine.update(traffic.taxi, traffic.taxi.route);
  }
  renderer.render(scene, camera);
  document.body.dataset.shotReady = 'true';
} else {
  traffic.warmup(10);
  frame();
}

if (!shot) {
  createDebugPanel({
    sun,
    hemi,
    sky,
    daylight,
    carCount: getCarCount(),
    fares: { getSeconds: getFareSeconds, setSeconds: setFareSeconds },
  });
}

window.__taxi = {
  traffic,
  daylight,
  boost,
  skids,
  police,
  fares,
  routeTo,
  findRoute,
  isSelected: () => selected,
  /** Screen-space helpers so the browser smoke test can click real pixels. */
  taxiScreenPosition: taxiScreenPos,
  targetScreenPosition: () => {
    const t = fares.state.target;
    if (!t) return null;
    const c = fares.intersectionCentre(t.i, t.j);
    const v = new THREE.Vector3(c.x, 5, c.z).project(camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  },
};

console.log('[taxi] ready', { seed, runSeed, shot: shot?.name ?? 'interactive', cars: traffic.cars.length });
window.__taxi.runSeed = runSeed;   // reproduce a run with ?run=<this>

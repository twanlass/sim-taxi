// The passing lab — /lab/, not part of the game.
//
// One straight road with no lights, a taxi, and a car in front of it. Loco Mode is held down and
// the tank never empties, so the overtake can be watched over and over without playing a run to
// earn the fuel or waiting for a straightaway to turn up.
//
// **Nothing here re-implements the manoeuvre.** The pass, the weave, the scatter, the tailgate at
// `BOOST_GAP`, the two gates that decide when pulling out is allowed — all of it is `sim/traffic.js`
// driving `traffic.taxi` exactly as `main.js` does. This file builds a world with nothing else in
// it, points a camera at the car, and holds the button. If the taxi behaves differently here than
// it does in the game, that is a bug in the lab, not a different mode.
//
// Two things are deliberately *not* the game, both so a scenario can be run twice:
//
//   - **The tank is bottomless.** `boost.state.fuel` is pinned full every frame rather than topped
//     up through `topUp()`, which would put the pill into its delivery-reward pour animation once a
//     second for the whole session.
//   - **A wreck doesn't consume the taxi.** The game hands both shells to `game/vanish.js`, which
//     says up front that it never restores anything — a wreck ends the run and Retry reloads the
//     page. The lab resets in place instead, so the taxi stays where it stopped and drives again a
//     beat later. The car it hit still gets the full treatment, because that one is replaced from
//     the pool anyway.
//
// See docs/lab.md.

import * as THREE from 'three';
import { makeRng } from '../util/rng.js';
import { createScene } from '../game/scene.js';
import { createCityCamera } from '../game/camera.js';
import { createProps } from '../city/props.js';
import { setCityNetwork } from '../city/roadnet.js';
import { createTraffic, placeCar, SPEED, laysPassRubber, MPH_PER_UNIT } from '../sim/traffic.js';
import { createCollisions } from '../sim/collisions.js';
import { createBoost, BOOST_DURATION } from '../game/boost.js';
import { createSkidMarks } from '../game/skidmarks.js';
import { createDust } from '../game/dust.js';
import { createBlast } from '../game/blast.js';
import { createFlames } from '../game/flames.js';
import { createVanish } from '../game/vanish.js';
import { createCarGhosts } from '../game/carghosts.js';
import { createDaylight, DAY_SECONDS } from '../game/daylight.js';
import { createAmbientOcclusion, markOccluder } from '../game/ssao.js';
import { setAmbientOcclusion } from '../util/geo.js';
import {
  TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT, TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK,
} from '../geometry/taxi.js';
import { DIR, dirSign, dirYaw, HALF_ROAD, PITCH } from '../city/grid.js';
import { PALETTE } from '../palette.js';
import { getAmbientOcclusion, getMsaa, getPixelRatioCap, getShadowMapSize } from '../util/shot.js';
import {
  labNetwork, createLabGround, labTreeBlocks, labRoadLength, labNodeX, LAB_BLOCKS,
} from './labroad.js';

// --- Knobs ------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const num = (name, fallback, lo, hi) => {
  const raw = Number(params.get(name));
  return Number.isFinite(raw) && params.has(name)
    ? Math.min(hi, Math.max(lo, Math.round(raw)))
    : fallback;
};

// The instance pool is allocated once and cannot grow (an InstancedMesh cannot be resized), so
// the ceilings are fixed here and the sliders only decide how many of the pool are on the road.
const MAX_AHEAD = 3;
const MAX_ONCOMING = 3;

const knobs = {
  ahead: num('ahead', 1, 0, MAX_AHEAD),
  // 22 units: comfortably outside `PASS_TRIGGER` (10), so the run-up — closing at ~10 u/s with the
  // overdrive band still building — is part of what you watch rather than something that already
  // happened before the first frame.
  gap: num('gap', 22, 8, 70),
  oncoming: num('oncoming', 0, 0, MAX_ONCOMING),
  seed: num('seed', (Math.random() * 0xffffffff) >>> 0, 0, 0xffffffff),
};

// Where the taxi starts, measured from the west end. Far enough in that there is road behind it in
// frame, which is what makes the opening read as "driving along" rather than "spawning".
const TAXI_START = 12;
// Reset this far short of the east end. The last junction is a dead end — no exits, so the sim
// holds the car at the line there (correctly) — and watching the taxi park is not the point.
const RESET_MARGIN = 16;

// --- Renderer and scene -----------------------------------------------------

const budget = {
  msaa: getMsaa(),
  shadowMapSize: getShadowMapSize(),
  pixelRatioCap: getPixelRatioCap(),
  ao: getAmbientOcclusion(),
};

const renderer = new THREE.WebGLRenderer({
  antialias: budget.msaa,
  // The ghost outlines stamp a stencil mask every frame; Three defaults the buffer off since r163
  // and without it the "outline" fills the whole hull. Same reason main.js asks for it.
  stencil: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, budget.pixelRatioCap));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = budget.shadowMapSize > 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

setAmbientOcclusion(budget.ao);
const ao = createAmbientOcclusion(renderer, { enabled: budget.ao });

const { scene, sun, hemi, sky } = createScene({ shadowMapSize: budget.shadowMapSize });
const daylight = createDaylight({ sun, hemi, sky });
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);

const net = setCityNetwork(labNetwork(LAB_BLOCKS));
const ROAD_EAST = labNodeX(LAB_BLOCKS);

scene.add(markOccluder(createLabGround(makeRng(knobs.seed + 11), LAB_BLOCKS)));
scene.add(markOccluder(createProps(makeRng(knobs.seed + 33), labTreeBlocks(LAB_BLOCKS))));

// --- Traffic ----------------------------------------------------------------

// One taxi plus every car either slider can ask for. `spawnCars` draws these against the 5×5
// city's own ranges and drops them wherever `labNetwork`'s `laneByGrid` says is legal; `stage()`
// below repositions every one of them before the first frame, so where they land here is only
// ever a source of paint colours.
const POOL = 1 + MAX_AHEAD + MAX_ONCOMING;
const traffic = createTraffic(makeRng(knobs.seed + 44), scene, POOL, POOL, 0);
const taxi = traffic.taxi;
const pool = traffic.cars.filter((c) => !c.isTaxi);
const aheadPool = pool.slice(0, MAX_AHEAD);
const oncomingPool = pool.slice(MAX_AHEAD);

markOccluder(traffic.mesh);
markOccluder(traffic.wheelMesh);
markOccluder(traffic.taxiGroup);

const carGhosts = createCarGhosts(scene, traffic);

// --- Camera -----------------------------------------------------------------

// Closer than the game's 52. The lab is about two cars a few metres apart, not about a city, and
// at play zoom the whole manoeuvre happens inside about eighty pixels.
const LAB_ZOOM = 30;
// The lab ground has no fade skirt — it is simply big enough that its edge never comes into frame
// (see LAB_VERGE in labroad.js, which is sized off exactly this number). Zooming out past it would
// put the end of the world on screen, so the wheel stops here.
const LAB_MAX_ZOOM = 46;
const LAB_MIN_ZOOM = 16;

const aspect = () => window.innerWidth / window.innerHeight;
const controller = createCityCamera(aspect(), { zoom: LAB_ZOOM, target: [labNodeX(0), 0] });
const { camera } = controller;

// How hard the camera chases, and how far in front of the car it aims. The lead is in *seconds of
// road*: at cruise it is barely a car length, at the overdrive top it is nearly a block, so the
// framing opens up ahead of the taxi exactly as fast as the taxi needs to see further.
const FOLLOW_SMOOTHING = 4.5;
const CAMERA_LEAD = 0.55;

renderer.domElement.addEventListener('wheel', (event) => {
  event.preventDefault();
  const factor = Math.exp(event.deltaY * 0.0012);
  controller.state.zoom = THREE.MathUtils.clamp(
    controller.state.zoom * factor, LAB_MIN_ZOOM, LAB_MAX_ZOOM,
  );
  controller.update(aspect());
}, { passive: false });

// --- Effects ----------------------------------------------------------------

const boost = createBoost(BOOST_DURATION, 1);
const skids = createSkidMarks(scene);
const dust = createDust(scene, camera, makeRng(knobs.seed + 77));
const blast = createBlast(scene, makeRng(knobs.seed + 88));
const flames = createFlames(scene, makeRng(knobs.seed + 133));
const vanish = createVanish();

// --- Staging ----------------------------------------------------------------

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Take a car out of the world without removing it from the pool.
 *
 * `crashed` is the flag every loop in `traffic.js` already skips, so it does the whole job of
 * taking a car out of the sim; what it does *not* do is stop the car being drawn, because the
 * render pass skips it too and its instance matrix simply keeps whatever it last held. Collapsing
 * the matrix is the same trick `wreckShell` uses for the car it copies out.
 */
function park(car) {
  car.crashed = true;
  traffic.mesh.setMatrixAt(car.instanceIndex, HIDDEN);
  for (let w = 0; w < traffic.wheelsPerCar; w++) {
    traffic.wheelMesh.setMatrixAt(car.instanceIndex * traffic.wheelsPerCar + w, HIDDEN);
  }
  traffic.mesh.instanceMatrix.needsUpdate = true;
  traffic.wheelMesh.instanceMatrix.needsUpdate = true;
}

/**
 * Put `car` on the carriageway running `d`, at world x.
 *
 * Staged in world coordinates rather than in arc length along the chain, because the knob the lab
 * is actually about is a *gap between two cars* and the two are not on the same lane: walking
 * "22 units along the road" through lanes and junctions costs the junction's own 8 units at every
 * boundary, and the first version of this quietly turned the gap slider's 22 into 28.
 *
 * On a straight road x is as good a coordinate as arc length, and better here because both ends of
 * the measurement mean the same thing. The one place it isn't defined is *inside* a junction box,
 * which no lane position can express — the same limit the probe hit staging cars across junctions
 * (see docs/traffic.md) — so an x that lands in one is clamped to the nearer end of the block it
 * fell in, which is never more than `HALF_ROAD` out. The readout reports the gap it actually got.
 */
function placeAtX(car, d, x) {
  // Which block of road x falls in, clamped so the ends of the road are still legal positions.
  const block = THREE.MathUtils.clamp(
    Math.floor((x - labNodeX(0)) / PITCH), 0, LAB_BLOCKS - 1,
  );
  const from = labNodeX(block) + HALF_ROAD;              // where this block's lanes begin
  const to = labNodeX(block + 1) - HALF_ROAD;            // and end
  const at = THREE.MathUtils.clamp(x, from, to);
  const junction = dirSign(d) > 0 ? block + 1 : block;
  const lane = net.laneByGrid(d, junction);
  if (!lane) return false;
  // `placeCar` measures back from the junction the car is heading for, so an eastbound car
  // `at - from` into the lane is `lane.length - (at - from)` short of the line.
  const along = dirSign(d) > 0 ? at - from : to - at;
  return placeCar(car, d, junction, 0, lane.length - along);
}

/** Everything `spawnCars` seeds on a fresh car, reset so a re-staged car isn't mid-manoeuvre. */
function reseat(car, d, x, v = SPEED) {
  car.crashed = false;
  if (!placeAtX(car, d, x)) return false;
  car.v = v;
  car.prevV = v;
  car.speedFactor = v / SPEED;
  car.pitch = 0;
  car.pitchV = 0;
  car.lateral = 0;
  car.steer = 0;
  car.swerve = 0;
  car.swervePhase = 0;
  car.pass = 0;
  car.passing = false;
  car.passTarget = null;
  car.passOffset = 0;
  car.passSlope = 0;
  car.passBank = 0;
  car.scatter = 0;
  car.panic = 0;
  car.route = [];
  car.routeConsumed = false;
  car.parked = false;
  car.boost = false;
  car.boostEasing = false;
  car.wasBoosting = false;
  car.wheelAngle = 0;
  car.prevSteerYaw = dirYaw(d);
  car.prevTravelled = car.travelled;
  car.wheelieT = null;
  car.hopFrom = null;
  car.bounceT = null;
  return true;
}

// Wreck shells are copies `wreckShell` adds to the scene and `vanish` only ever hides. In the game
// that is the last thing that happens before the page reloads; here it happens every time you
// misjudge a pass, so they are tracked and cleared on the next reset.
const shells = [];

function clearShells() {
  for (const shell of shells) {
    scene.remove(shell);
    shell.traverse((node) => node.material?.dispose?.());
  }
  shells.length = 0;
}

let resetAt = 0;          // wallclock ms the lab re-stages itself, or 0 when nothing is pending

function stage() {
  clearShells();
  resetAt = 0;
  wreckSpot = null;
  slowMoUntil = 0;
  controller.state.zoom = zoomBeforeWreck ?? controller.state.zoom;
  zoomBeforeWreck = null;

  const start = labNodeX(0) + TAXI_START;
  reseat(taxi, DIR.PX, start);

  // The queue in front, one gap apart, so passing the first car puts you on the run-up to the
  // next one rather than ending the scenario.
  aheadPool.forEach((car, k) => {
    if (k < knobs.ahead) reseat(car, DIR.PX, start + knobs.gap * (k + 1));
    else park(car);
  });

  // Oncoming traffic, spread down the other carriageway so it arrives during a pass rather than
  // all at once. `PASS_SIGHT` (35 units) is what decides whether the taxi will pull out with one
  // of these in view — that gate is the whole reason this slider is here.
  oncomingPool.forEach((car, k) => {
    if (k < knobs.oncoming) reseat(car, DIR.NX, ROAD_EAST - 40 - k * 52);
    else park(car);
  });

  // Put the camera on the taxi rather than easing to it, so a reset is a cut and not a swoop.
  controller.state.target.set(taxi.x, 0, taxi.z);
  controller.update(aspect());
}

// --- The wreck --------------------------------------------------------------

const WRECK_ZOOM = 24;
const SLOW_MO_MIN = 0.18;
const SLOW_MO_DURATION = 1400;
const RESET_DELAY = 1600;

let wreckSpot = null;
let slowMoUntil = 0;
let zoomBeforeWreck = null;

const collisions = createCollisions(traffic.cars, taxi);
collisions.onImpact(({ x, z, other }) => {
  blast.fire(x, z, PALETTE.taxiBody);
  blast.fire(other.x, other.z, PALETTE.carBody[other.colorIndex]);
  controller.kickShake(2.4);

  // Only the car that was hit is consumed. The taxi stays exactly where it stopped — in a lab the
  // useful thing about a wreck is *where it happened*, and a shell that fades out under the
  // fireball takes that away. See the note at the top of this file.
  const shell = traffic.wreckShell(other);
  shells.push(shell);
  vanish.take(shell);

  wreckSpot = { x, z };
  zoomBeforeWreck = controller.state.zoom;
  slowMoUntil = performance.now() + SLOW_MO_DURATION;
  resetAt = performance.now() + RESET_DELAY;
  boost.release();
});

// --- Controls ---------------------------------------------------------------

const boostButton = document.getElementById('boost');
const readout = document.getElementById('lab-readout');

function pressBoost(event) {
  event.preventDefault();
  boostButton.setPointerCapture?.(event.pointerId);
  if (boost.press()) kickLocoMode();
}

function releaseBoost(event) {
  boost.release();
  boostButton.releasePointerCapture?.(event.pointerId);
}

/** The tailpipe bark and the chirp off the line, same as main.js fires on the engaging press. */
function kickLocoMode() {
  if (taxi.crashed) return;
  taxi.wheelieT = 0;
  const bx = -Math.cos(taxi.yaw);
  const bz = Math.sin(taxi.yaw);
  flames.burst(
    taxi.x + bx * TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT, taxi.z + bz * TAXI_TAILPIPE_BACK,
    taxi.yaw,
  );
  stampRearRubber(taxi);
  launchSkidT = LAUNCH_SKID_TIME;
}

boostButton.addEventListener('pointerdown', pressBoost);
boostButton.addEventListener('pointerup', releaseBoost);
boostButton.addEventListener('pointercancel', releaseBoost);
boostButton.addEventListener('lostpointercapture', releaseBoost);
// The game's pill guard, for the same iOS gesture recogniser — see main.js for the long version,
// including why the `cancelable` test is what keeps Chrome quiet.
boostButton.addEventListener('touchstart', (event) => {
  if (event.cancelable) event.preventDefault();
}, { passive: false });
window.addEventListener('blur', () => boost.release());
window.addEventListener('contextmenu', (e) => {
  if (e.target === boostButton) e.preventDefault();
});

// Space is the keyboard half of the same hold — a lab is a thing you use with one hand on the
// keyboard, and holding a pointer down on a button for a minute is not it. `repeat` is ignored so
// the autorepeat stream doesn't re-fire the wheelie forty times a second.
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    if (!event.repeat && boost.press()) kickLocoMode();
  } else if (event.code === 'KeyR') {
    stage();
  } else if (event.code === 'KeyP') {
    // Freeze the sim, keep drawing. The manoeuvre this page is about takes about half a second at
    // the overdrive top, which is not long enough to look at the thing you came to look at — the
    // crab angle at the midpoint, how far the body is leaning, where the rubber went. Rendering
    // continues, so the frozen frame still responds to the wheel.
    paused = !paused;
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') boost.release();
});

/** Wire one slider to a knob, and re-stage whenever it moves. */
function slider(id, key, format) {
  const input = document.getElementById(id);
  const label = document.getElementById(`${id}-value`);
  input.value = String(knobs[key]);
  const paint = () => { label.textContent = format(knobs[key]); };
  input.addEventListener('input', () => {
    knobs[key] = Number(input.value);
    paint();
    stage();
  });
  paint();
}

slider('ahead', 'ahead', (n) => String(n));
slider('gap', 'gap', (n) => `${n} u`);
slider('oncoming', 'oncoming', (n) => String(n));
document.getElementById('reset').addEventListener('click', () => stage());

/**
 * Speed, manoeuvre state, and the gap to the nearest car in front.
 *
 * The gap is measured live rather than echoed off the slider, and that is the point of showing it:
 * the slider is a *request*, and a request that lands inside a junction box gets clamped to the
 * edge of it by up to `HALF_ROAD` (see `placeAtX`). This is the number the sim is actually working
 * with — and once the run starts it is the number that decides everything, since `PASS_TRIGGER`
 * (10 units) is what the taxi pulls out at.
 */
function updateReadout() {
  if (!readout) return;
  const mph = Math.round(taxi.v * MPH_PER_UNIT);
  const state = taxi.crashed ? 'wrecked'
    : taxi.passing ? 'out in the oncoming lane'
      : taxi.pass > 0.01 ? 'tucking back in'
        : taxi.boost ? 'in lane, boosting' : 'in lane';

  let gap = Infinity;
  for (const car of aheadPool) {
    if (car.crashed || car.x <= taxi.x) continue;
    gap = Math.min(gap, car.x - taxi.x);
  }
  const ahead = Number.isFinite(gap) ? ` · ${gap.toFixed(1)} u to the car in front` : '';
  readout.textContent = `${taxi.v.toFixed(1)} u/s · ${mph} mph — ${state}${ahead}`;
}

// --- Rubber and dust --------------------------------------------------------
//
// Lifted from main.js unchanged in substance: the effect pools live on this side of the module
// layering, so the rules that decide when to stamp one have to live here too.

const LAUNCH_SKID_TIME = 0.5;
let launchSkidT = 0;
let lastSkidAt = 0;
let lastDustAt = 0;

function stampRearRubber(car) {
  const fx = Math.cos(car.yaw);
  const fz = -Math.sin(car.yaw);
  const rx = Math.sin(car.yaw);
  const rz = Math.cos(car.yaw);
  for (const side of [-1, 1]) {
    skids.add(car.x - fx * 1.2 + rx * side * 1.04, car.z - fz * 1.2 + rz * side * 1.04, car.yaw);
  }
}

function layRubber(dt) {
  if (launchSkidT > 0) launchSkidT = Math.max(0, launchSkidT - dt);
  // No corner case here, unlike main.js: this road has no corners. Every junction crossing is a
  // straight-through, and `car.dOut !== car.d` is never true. The launch and the two lane changes
  // are the whole list, and on a road that is nothing but straightaway the lane changes are the
  // only rubber there is — which is exactly what the lab is for looking at.
  const swapping = laysPassRubber(taxi);
  if (!(taxi.boost && launchSkidT > 0) && !swapping) { lastSkidAt = taxi.travelled; return; }
  if (taxi.travelled - lastSkidAt < 0.42) return;
  lastSkidAt = taxi.travelled;
  stampRearRubber(taxi);
}

// One plume per rear tyre, off the contact patch, exactly as main.js lays it — and the lab is the
// place to look at it, since a lane change here swings the two trails apart against a straight
// road with nothing else moving.
function kickDust() {
  if (!taxi.boost || taxi.v < 2) { lastDustAt = taxi.travelled; return; }
  if (taxi.travelled - lastDustAt < 0.47) return;
  lastDustAt = taxi.travelled;
  const fx = Math.cos(taxi.yaw);
  const fz = -Math.sin(taxi.yaw);
  const rx = Math.sin(taxi.yaw);
  const rz = Math.cos(taxi.yaw);
  for (const side of [-1, 1]) {
    dust.add(
      taxi.x - fx * TAXI_REAR_AXLE_BACK + rx * side * TAXI_REAR_TRACK,
      taxi.z - fz * TAXI_REAR_AXLE_BACK + rz * side * TAXI_REAR_TRACK,
      taxi.yaw,
    );
  }
}

// --- Frame ------------------------------------------------------------------

function renderFrame() {
  ao.render(scene, camera);
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  controller.resize(aspect());
});

const clock = new THREE.Clock();
let paused = false;

function frame() {
  requestAnimationFrame(frame);
  let dt = Math.min(clock.getDelta(), 0.05);
  // Paused: draw the same frame again and step nothing. `getDelta` is still read above so the
  // clock doesn't bank the whole pause and hand it back as one enormous step on resume.
  if (paused) { renderFrame(); return; }

  const nowMs = performance.now();
  if (nowMs < slowMoUntil) {
    const t = 1 - (slowMoUntil - nowMs) / SLOW_MO_DURATION;
    dt *= SLOW_MO_MIN + (1 - SLOW_MO_MIN) * t;
  }
  if (resetAt && nowMs >= resetAt) stage();

  boost.update(dt);
  // A bottomless tank. Written straight onto the clock's state rather than through `topUp()`,
  // which queues fuel to *pour* in over ~0.7s and lights the pill's delivery-reward flutter while
  // it does — correct in the game, a strobe in a lab where the tank refills every frame.
  boost.state.fuel = BOOST_DURATION;
  if (boost.state.mode === 'empty') boost.state.mode = boost.state.held ? 'active' : 'ready';

  if (!taxi.crashed) {
    taxi.boost = boost.isEngaged();
    taxi.boostEasing = boost.isCoolingDown();
    // The overtake is offered only where the taxi's route carries straight on through the junction
    // ahead — `room` in traffic.js reads `route[0] === car.d`, which is what stops the game pulling
    // out on the approach to a corner it is about to take. A lab taxi has no fares to route it, so
    // the road's only exit is handed back as a route: on this network "straight on" is the sole
    // legal move anyway, so this asserts what the sim would have rolled rather than steering it.
    while (taxi.route.length < 3) taxi.route.push(taxi.d);
  }

  boostButton.classList.toggle('is-active', boost.state.mode === 'active');

  skids.update(dt);
  dust.update(dt);
  blast.update(dt);
  flames.update(dt);
  vanish.update(dt);
  controller.updateShake(dt, aspect());
  daylight.update(dt);

  traffic.update(dt);
  collisions.update();
  carGhosts.update(dt);

  if (wreckSpot) {
    controller.focusOn(wreckSpot.x, wreckSpot.z, WRECK_ZOOM, dt, aspect());
  } else {
    // The camera's own ease rather than `followXZ`, which clamps the target to ±HALF_SPAN — that
    // is the *city's* bound, and this road is twice as long as the city is wide, so the clamp
    // would leave the taxi driving off the right of frame halfway down it.
    const lead = taxi.v * CAMERA_LEAD;
    const target = controller.state.target;
    const k = 1 - Math.exp(-dt * FOLLOW_SMOOTHING);
    target.x += (taxi.x + Math.cos(taxi.yaw) * lead - target.x) * k;
    target.z += (taxi.z - Math.sin(taxi.yaw) * lead - target.z) * k;
    controller.update(aspect());
  }

  layRubber(dt);
  kickDust();
  updateReadout();

  // Out of road. The east end is a dead end and the sim holds cars at the last line, which is
  // correct and dull — re-stage instead, so holding the button just runs the scenario again.
  if (!resetAt && taxi.x > ROAD_EAST - RESET_MARGIN) stage();

  renderFrame();
}

stage();
frame();

// The same hook `main.js` exposes, for poking at a scenario from the console: `__lab.knobs.gap =
// 40; __lab.stage()`.
window.__lab = {
  traffic, taxi, boost, net, camera: controller, knobs, stage, redraw: renderFrame,
  freeze: () => { paused = true; },
  resume: () => { paused = false; },
  isPaused: () => paused,
  roadLength: labRoadLength(LAB_BLOCKS),
};

console.log('[lab] passing', {
  seed: knobs.seed, road: labRoadLength(LAB_BLOCKS), junctions: LAB_BLOCKS + 1,
  signalised: net.nodes.filter((n) => n.signal).length,
});

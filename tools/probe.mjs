/**
 * Headless simulation probe. Runs the city generators and the traffic model in Node with no
 * browser and no GL context, and asserts on invariants.
 *
 * This exists because the previous prototype proved the expensive part of the loop is *seeing*
 * results. Anything checkable as a number should be checked here in milliseconds, so screenshots
 * are spent only on questions that genuinely need eyes.
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createLayout } from '../src/city/layout.js';
import { createGround, SLAB, SLAB_RADIUS, EDGE_FADE } from '../src/city/ground.js';
import { createBuildings } from '../src/city/buildings.js';
import { createProps } from '../src/city/props.js';
import { createTraffic, lightPhase, displayPhase, setPriorityJunction, getPriorityCorridor, isUnsignalised, ringAxisAt, placeCar, approachRoom, ROAD_Y, wheelAnchors, WHEEL_R, STEER_MAX, speedMph, SPEED } from '../src/sim/traffic.js';
import { createCollisions } from '../src/sim/collisions.js';
import { createPolice, POLICE_BUST_RANGE } from '../src/sim/police.js';
import {
  createFareSystem, cornerFor, blockDistance, priceFor, MAX_FARES,
} from '../src/game/fares.js';
import * as difficulty from '../src/game/difficulty.js';
import { createDestinationPin } from '../src/geometry/marker.js';
import { bounceOffset, KICK_SCALE, KICK_HOP } from '../src/geometry/diamond.js';
import { createTaxiMesh } from '../src/geometry/taxi.js';
import { propMaterial, setAmbientOcclusion, AO_UNIFORMS } from '../src/util/geo.js';
import {
  AO_LAYER, markOccluder, RING_BROAD, RING_TIGHT, MAX_DEPTH_DIFF,
} from '../src/game/ssao.js';
import {
  GHOST_MASK_ORDER, GHOST_RIM_ORDER, CAR_GHOST_MASK_ORDER, CAR_GHOST_RIM_ORDER,
} from '../src/geometry/ghostoutline.js';
import {
  createCarGhosts, GHOST_RADIUS, MAX_GHOSTS, GHOST_OPACITY,
} from '../src/game/carghosts.js';
import { createCityCamera, attachDragPan, VIEW_DIR } from '../src/game/camera.js';
import { URGENCY_SEGMENTS, urgencyLevel, urgencyColor } from '../src/game/urgency.js';
import { planOrigin } from '../src/game/route.js';
import { HALF_SPAN, ROAD_W, LANE, PITCH, lineCoord, GRID, isXAxis, leftOf, opposite, dirSign, legalExits } from '../src/city/grid.js';
import { cityNetwork } from '../src/city/roadnet.js';
import { routePath } from '../src/game/routeline.js';
import { findRoute, allIntersections } from '../src/game/route.js';
import { PALETTE } from '../src/palette.js';
import { createVanish } from '../src/game/vanish.js';
import { createBlast } from '../src/game/blast.js';
import {
  createBoost, BOOST_DURATION, BOOST_START_FRACTION, BOOST_FARE_REWARD, BOOST_COOLDOWN,
} from '../src/game/boost.js';
import { createBoostMeter } from '../src/game/boostmeter.js';

const seed = Number(process.argv[2] ?? 71624);
const CARS_DEFAULT = 7;    // low-density baseline for the fare-loop checks — keeps timing thresholds stable regardless of runtime default
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const time = (label, fn) => {
  const t0 = process.hrtime.bigint();
  const out = fn();
  console.log(`  ${label}: ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)}ms`);
  return out;
};

// Read a rider's diamond back the way a player does — off the material it is painted in, not by
// trusting the argument we passed in. Its colour is the whole of what that marker says now.
const diamondHex = (marker) => marker.mesh.material.color.getHexString();
// The disc under the rider's feet, rim and fill — one mark at two weights, so they must never
// disagree with each other or with the crystal overhead.
const ringHexes = (marker) => marker.ring.children.map((m) => m.material.color.getHexString());

// Slot 0's bounce phase offset — fares.js staggers the slots so two riders don't pulse in lockstep,
// and slot 0 draws the zero offset. Named here so the kick assertions can subtract the bounce out.
const PHASE_0 = 0;

const scene = new THREE.Scene();

const layout = time('layout', () => createLayout(makeRng(seed)));
const ground = time('ground', () => createGround(makeRng(seed + 11), layout));
const buildings = time('buildings', () => createBuildings(makeRng(seed + 22), layout));
const props = time('props', () => createProps(makeRng(seed + 33), layout));
const traffic = time('traffic init', () => createTraffic(makeRng(seed + 44), scene, 24));

const tris = (mesh) => mesh.geometry.attributes.position.count / 3;
console.log(`  triangles: ground ${tris(ground)}, buildings ${tris(buildings.mesh)}, props ${tris(props)}`);

// --- The asphalt's feathered edge -----------------------------------------
// The fade skirt is a second mesh because alpha cannot ride in the merged ground's 3-component
// colour attribute, and being a second mesh is exactly what makes it worth asserting: its inner
// ring has to land on the slab's own outline to the last bit, or a ring of sky leaks between the
// two meshes at the corner arcs, where Three's tessellation is the only thing that decides where
// the boundary actually is.
{
  const fade = ground.children.find((c) => c.name === 'asphalt-fade');
  // Signed distance to the rounded-square outline: 0 on the edge, positive outside.
  const inset = SLAB / 2 - SLAB_RADIUS;
  const edgeDist = (x, z) => Math.hypot(
    Math.max(Math.abs(x) - inset, 0), Math.max(Math.abs(z) - inset, 0),
  ) - SLAB_RADIUS;

  const pos = fade?.geometry.attributes.position;
  const col = fade?.geometry.attributes.color;
  let seam = 0;      // how far the alpha-1 ring strays from the slab boundary
  let inside = 0;    // any part of the skirt reaching back over the road
  let reach = 0;     // how far the alpha-0 ring gets out
  for (let i = 0; pos && i < pos.count; i++) {
    const d = edgeDist(pos.getX(i), pos.getZ(i));
    inside = Math.min(inside, d);
    if (col.getW(i) === 1) seam = Math.max(seam, Math.abs(d));
    if (col.getW(i) === 0) reach = Math.max(reach, d);
  }

  check('the asphalt edge carries a fade skirt', !!fade && col?.itemSize === 4,
    fade ? `${pos.count / 3} triangles, alpha in the colour attribute` : 'missing');
  // Tolerance is float32 storage, not slop in the construction: both meshes keep their positions
  // in a Float32Array, and 62 units quantises to about 4e-6 there. Anything the geometry itself
  // got wrong lands orders of magnitude above this — and 1e-4 units is 1/1000th of a pixel.
  const FLOAT32 = 1e-4;
  check('the fade starts exactly on the slab edge', seam < FLOAT32,
    `max seam ${seam.toExponential(1)} units`);
  check('the fade reaches full transparency', Math.abs(reach - EDGE_FADE) < FLOAT32,
    `${reach.toFixed(1)} units out`);
  // Translucent asphalt over a road would show sky through the tarmac the ring road drives on.
  check('the fade never reaches back over the city', inside > -FLOAT32,
    `${inside.toExponential(1)} units inside`);
}

check('layout covers every block', layout.length === GRID * GRID, `${layout.length} blocks`);
check('some blocks are parks', layout.some((b) => b.type === 'park'),
  `${layout.filter((b) => b.type === 'park').length} parks`);
check('all cars spawned', traffic.cars.length === 24, `${traffic.cars.length}`);

// --- Run the simulation.
time('sim 120s', () => traffic.warmup(120));

const { stats } = traffic;
check('no car entered an intersection on red', stats.violations === 0, `${stats.violations} violations`);
check('traffic is flowing', stats.moving > traffic.cars.length * 0.35,
  `${stats.moving} moving / ${stats.waiting} waiting`);
check('signals actually stop people', stats.waiting > 0, `${stats.waiting} waiting`);

// --- Positional invariants.
const positions = traffic.cars.map((c) => ({ x: c.x, z: c.z, state: c.state }));
// The outermost road centrelines sit exactly at ±HALF_SPAN, so a car in the far lane is
// legitimately LANE units beyond that. The original bound here was simply too tight.
const limit = HALF_SPAN + LANE + 1;
const inBounds = positions.every((p) => Math.abs(p.x) <= limit && Math.abs(p.z) <= limit);
check('every car is inside the city', inBounds);

/** Distance from a coordinate to the nearest road centreline. */
const distToLine = (v) => {
  let best = Infinity;
  for (let i = 0; i <= GRID; i++) best = Math.min(best, Math.abs(v - lineCoord(i)));
  return best;
};

// A driving car must sit on a lane centre: offset LANE from a centreline on one axis, and
// somewhere along a road on the other.
const offLane = positions.filter((p) => {
  if (p.state !== 'drive') return false;
  const dx = distToLine(p.x);
  const dz = distToLine(p.z);
  const onXLane = Math.abs(dz - LANE) < 0.05;
  const onZLane = Math.abs(dx - LANE) < 0.05;
  return !(onXLane || onZLane);
});
check('driving cars sit on lane centres', offLane.length === 0, `${offLane.length} off-lane`);

const turning = positions.filter((p) => p.state === 'turn');
const inIntersection = turning.every((p) => distToLine(p.x) <= ROAD_W && distToLine(p.z) <= ROAD_W);
check('turning cars are inside intersections', inIntersection, `${turning.length} turning`);

check('no rear-end overlaps', stats.minGap > 3.2, `min gap ${stats.minGap.toFixed(2)}`);

// --- Pairwise proximity, the check that actually catches visual overlap.
let worst = Infinity;
let worstPair = null;
for (let a = 0; a < positions.length; a++) {
  for (let b = a + 1; b < positions.length; b++) {
    const d = Math.hypot(positions[a].x - positions[b].x, positions[a].z - positions[b].z);
    if (d < worst) { worst = d; worstPair = [positions[a], positions[b]]; }
  }
}
check('no two cars occupy the same space', worst > 1.6,
  `closest pair ${worst.toFixed(2)} (${worstPair?.[0].state}/${worstPair?.[1].state})`);

// --- Front-wheel steering ---------------------------------------------------
// Render-only state, so every other assertion in this file would stay green if it broke
// completely. Three things have to hold: the wheels reach a real lock through a corner, they come
// back to straight once the car is on the straight, and they never go past full lock.
{
  const wScene = new THREE.Scene();
  const wTraffic = createTraffic(makeRng(seed + 44), wScene, 24);
  const sinceJunction = new Map();
  let maxLock = 0;
  let cornerLock = 0;
  let cockedOnStraight = 0;
  // The taxi's fronts are meshes on the group rather than instances, so they are wired up
  // separately and can be dropped separately. Read the angle back off the rig itself.
  let taxiLock = 0;
  let rigLock = 0;

  for (let step = 0; step < 60 * 60; step++) {
    wTraffic.update(1 / 60);
    taxiLock = Math.max(taxiLock, Math.abs(wTraffic.taxi.wheelAngle));
    for (const part of wTraffic.taxiGroup.children) {
      rigLock = Math.max(rigLock, Math.abs(part.rotation.y));
    }
    for (const car of wTraffic.cars) {
      if (car.crashed) continue;
      const lock = Math.abs(car.wheelAngle);
      maxLock = Math.max(maxLock, lock);

      if (car.state === 'turn') {
        sinceJunction.set(car, 0);
        // Straight on through a junction is still 'turn'; only a real corner should show lock.
        if (car.dOut !== car.d) cornerLock = Math.max(cornerLock, lock);
        continue;
      }

      const run = (sinceJunction.get(car) ?? 0) + car.v / 60;
      sinceJunction.set(car, run);
      // Six units clear of the junction, anything left is a wheel stuck over rather than one
      // still unwinding — measured, a car is under 0.2° by then.
      if (run > 6 && lock > 0.05) cockedOnStraight += 1;
    }
  }

  const asDeg = (r) => `${((r * 180) / Math.PI).toFixed(0)}°`;
  check('the front wheels reach a real lock through a corner', cornerLock > 0.3,
    `${asDeg(cornerLock)} at the tightest`);
  check('the front wheels straighten up on the straight', cockedOnStraight === 0,
    `${cockedOnStraight} frames still cocked`);
  check('the front wheels never pass full lock', maxLock <= STEER_MAX + 1e-6,
    `${asDeg(maxLock)} peak`);
  check('the taxi\'s own front wheels are steered too',
    taxiLock > 0.2 && Math.abs(rigLock - taxiLock) < 1e-9,
    `rig ${asDeg(rigLock)} vs model ${asDeg(taxiLock)}`);

  // The ambient wheels are instances composed through the car's own matrix, which nothing else
  // here exercises — a multiply the wrong way round leaves them at the world origin, or orbiting
  // the city at the car's distance from it. Checked on straight-driving cars only, so the corner
  // lean isn't in the way.
  const front = wheelAnchors().filter((anchor) => anchor.front);
  const reach = Math.hypot(front[0].x, front[0].z);
  const wheelMatrix = new THREE.Matrix4();
  const wheelPos = new THREE.Vector3();
  let adrift = 0;
  let checked = 0;
  for (const car of wTraffic.cars) {
    if (car.isTaxi || car.state !== 'drive' || car.crashed) continue;
    for (let w = 0; w < front.length; w++) {
      wTraffic.wheelMesh.getMatrixAt(car.instanceIndex * front.length + w, wheelMatrix);
      wheelPos.setFromMatrixPosition(wheelMatrix);
      checked += 1;
      const out = Math.hypot(wheelPos.x - car.x, wheelPos.z - car.z);
      if (Math.abs(out - reach) > 0.25) adrift += 1;
      else if (wheelPos.y < WHEEL_R - 0.25 || wheelPos.y > WHEEL_R + 0.45) adrift += 1;
    }
  }
  check('every front wheel is bolted to its car', adrift === 0 && checked > 0,
    `${adrift} adrift of ${checked}`);
}

// --- Police priority corridor ----------------------------------------------
// The override lives inside lightPhase, so the assertion is about signals, not about the car:
// while a corridor is live every junction on that road must show green along it and red across
// it, and no vehicle may enter on red as the corridor flips on and off.
{
  const pScene = new THREE.Scene();
  const pTraffic = createTraffic(makeRng(seed + 44), pScene, 24);
  const police = createPolice(makeRng(seed + 66), pScene);

  let activations = 0;
  let wasActive = false;
  let corridorChecks = 0;
  let corridorBad = 0;
  let crossBad = 0;

  for (let step = 0; step < 240 * 60; step++) {
    police.update(1 / 60);
    pTraffic.update(1 / 60);

    const c = getPriorityCorridor();
    if (c && !wasActive) activations += 1;
    wasActive = Boolean(c);

    if (c && step % 30 === 0) {
      const t = pTraffic.stats.time;
      for (let k = 0; k <= GRID; k++) {
        const i = c.axis === 'x' ? k : c.line;
        const j = c.axis === 'x' ? c.line : k;
        const phase = lightPhase(i, j, t);
        corridorChecks += 1;
        if (phase.axis !== c.axis || phase.yellow) corridorBad += 1;

        // A junction one road over must be unaffected.
        const offI = c.axis === 'x' ? i : (c.line + 1) % (GRID + 1);
        const offJ = c.axis === 'x' ? (c.line + 1) % (GRID + 1) : j;
        if (lightPhase(offI, offJ, t).axis === c.axis && lightPhase(offI, offJ, t) === phase) crossBad += 1;
      }
    }
  }

  check('the police car runs corridors repeatedly', activations >= 3, `${activations} runs in 240s`);
  check('every junction on the corridor shows green along it', corridorBad === 0,
    `${corridorChecks} junction-checks`);
  check('no vehicle ran a red while corridors flipped', pTraffic.stats.violations === 0);
  check('traffic still flows with corridors active',
    pTraffic.stats.distance / pTraffic.stats.time / pTraffic.cars.length > 1,
    `${(pTraffic.stats.distance / pTraffic.stats.time / pTraffic.cars.length).toFixed(2)} units/s per car`);
}

// --- The fare's travelling clock --------------------------------------------
// The clock belongs to the fare, not to a place: one diamond waits over the rider's head and flies
// to the taxi the moment they get in. None of that is checkable from a still image, and every
// failure is silent — a marker left standing on an empty kerb, one that teleports to the car
// instead of travelling, one that stops following once it lands.
{
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 44), fScene, 24);
  const fares = createFareSystem(makeRng(seed + 55), fScene);
  fTraffic.warmup(5);

  let marker = null;
  let overTheRider = false;
  let discUnderRider = false;
  let discClearedAtPickup = false;
  let launchedFromKerb = false;
  let transferred = false;
  let landedOnTaxi = false;
  let leftTheKerb = false;
  let hiddenAfter = false;
  let kerbAtSpawn = null;
  let elapsed = 0;

  // Where the marker actually is, in the plane — its group carries the world position and the
  // crystal inside it only bounces.
  const at = () => marker.group.position;
  const distanceTo = (p) => Math.hypot(at().x - p.x, at().z - p.z);

  while (elapsed < 220 && !fares.state.gameOver) {
    fTraffic.update(1 / 60);
    const events = fares.update(1 / 60, fTraffic.taxi);
    elapsed += 1 / 60;

    const route = (fare) => {
      const r = findRoute(planOrigin(fTraffic.taxi), fare.target);
      if (r) { fTraffic.taxi.route = r; fTraffic.taxi.routeConsumed = false; fares.markDirected(fare); }
    };

    let done = false;
    for (const { type, fare } of events) {
      if (type === 'spawned' && !marker) {
        // Follow the first fare all the way through; a later one appearing mid-ride is a
        // different assertion, made further down.
        marker = fare.slot.marker;
        kerbAtSpawn = cornerFor(fare.target.i, fare.target.j);
        // It stands over the rider from the frame they appear — this is the only thing marking
        // someone on the kerb, so a hidden one is an invisible fare.
        overTheRider = marker.group.visible && distanceTo(kerbAtSpawn) < 0.01;
        // The disc lands on the same corner, under their feet — it is the crystal's colour said
        // again on the ground, where the driving is aimed.
        discUnderRider = marker.ring.visible
          && Math.hypot(marker.ring.position.x - kerbAtSpawn.x,
            marker.ring.position.z - kerbAtSpawn.z) < 0.01
          && new Set([...ringHexes(marker), diamondHex(marker)]).size === 1;
        route(fare);
      }
      if (type === 'pickup' && fare.slot.marker === marker) {
        transferred = marker.isTransferring();
        // Launched from the corner the rider was standing on, not replanted on the car: the
        // hand-off has to read as the same object moving.
        launchedFromKerb = marker.group.visible && distanceTo(kerbAtSpawn) < 0.01;
        // ...and the disc goes out on the same frame: the corner stops meaning anything the moment
        // the clock leaves it, and one left glowing reads as another fare waiting there.
        discClearedAtPickup = !marker.ring.visible;
        route(fare);
      }
      // The run may end on the clock rather than a delivery; the marker must clear either way.
      if ((type === 'delivered' || type === 'failed') && fare.slot.marker === marker) {
        hiddenAfter = !marker.group.visible;
        done = true;
      }
    }
    if (done) break;

    const carried = fares.carrying();
    if (transferred && carried?.slot.marker === marker) {
      // Mid-flight it is neither on the kerb nor on the car — that is what makes it a flight.
      if (marker.isTransferring() && distanceTo(kerbAtSpawn) > 1 && distanceTo(fTraffic.taxi) > 1) {
        leftTheKerb = true;
      }
      if (!marker.isTransferring() && !landedOnTaxi) {
        landedOnTaxi = distanceTo(fTraffic.taxi) < 0.05;
      }
    }
  }

  check('the clock stands over the rider from the frame they appear', overTheRider);
  check('and marks the ground under their feet in the same colour', discUnderRider);
  check('the ground disc clears when they board', discClearedAtPickup);
  check('it launches from the corner the rider was standing on', launchedFromKerb);
  check('it flies rather than teleports', transferred && leftTheKerb);
  check('it then rides with the taxi', landedOnTaxi);
  check('it clears on delivery', hiddenAfter);

  // The clock has to keep draining after the hand-off — the deadline covers spawn to drop-off, so a
  // marker that froze the moment it landed on the car would be lying for the whole second leg.
  // Drive it by hand on the taxi and read the crystal back.
  {
    const rider = fares.slots[1].marker;
    rider.showAt(URGENCY_SEGMENTS, 0, 0);
    rider.beginTransfer();
    const taxi = { x: 40, z: -20 };
    const hues = [];
    const fills = [];
    let t = 0;
    for (const fraction of [1, 0.7, 0.45, 0.2, 0.02]) {
      for (let f = 0; f < 60; f++) {
        t += 1 / 60;
        rider.setUrgency(urgencyLevel(fraction));
        rider.setFill(fraction);
        rider.update(t, taxi, fraction * 60);
      }
      hues.push(rider.mesh.material.color.getHexString());
      fills.push(rider.getFill());
    }
    check('it keeps draining once it is on the taxi',
      hues.join(' -> ') === [1, 0.7, 0.45, 0.2, 0.02]
        .map((f) => urgencyColor(urgencyLevel(f)).getHexString()).join(' -> '),
      hues.join(' -> '));

    // The liquid in the vessel is the fine hand: it has to keep moving *between* two colour steps,
    // which is the whole point of it. 0.7 and 0.45 are both level 2 — a fill that only followed the
    // colour would report the same crystal for both.
    check('the crystal drains continuously between colour steps',
      fills.every((f, i) => i === 0 || f < fills[i - 1])
        && urgencyLevel(0.2) === urgencyLevel(0.02) && fills[3] > fills[4],
      fills.map((f) => f.toFixed(2)).join(' -> '));
    check('and it is riding the taxi, not the kerb it left',
      Math.hypot(rider.group.position.x - taxi.x, rider.group.position.z - taxi.z) < 0.05);

    // The panic pulse: below five seconds the marker beats, so the end of a clock is an event and
    // not just a shade of red. It came across from the ring, which only ever pulsed on the taxi.
    let beats = 0;
    let calm = 0;
    for (let f = 0; f < 120; f++) {
      t += 1 / 60;
      rider.update(t, taxi, 3);
      if (rider.mesh.scale.x > 1.02) beats += 1;
      rider.update(t, taxi, 30);
      if (Math.abs(rider.mesh.scale.x - 1) < 1e-6) calm += 1;
    }
    check('the last five seconds pulse', beats > 40 && calm === 120,
      `${beats}/120 frames beating, ${calm}/120 calm above the threshold`);
    rider.hide();
  }
}

// --- The difficulty curve is winnable everywhere on it ------------------------
// A deadline shorter than the driving it pays for is unwinnable by construction, and it would look
// exactly like the game being hard. Slack below 1.0 is therefore not a tuning choice, it is a bug,
// and it is the kind that only shows up several fares into a run on someone else's machine.
{
  let minSlack = Infinity;
  let capJumps = 0;
  let prevCap = difficulty.maxFares(0);
  for (let delivered = 0; delivered <= 40; delivered++) {
    minSlack = Math.min(minSlack, difficulty.slack(delivered));
    const cap = difficulty.maxFares(delivered);
    // The board grows one rider at a time. Two arriving on the same delivery is a burst the
    // spawn stagger cannot smooth out, because the cap is what gates it in the first place.
    if (cap - prevCap > 1) capJumps += 1;
    prevCap = cap;
  }
  check('slack never drops below 1.0 anywhere on the curve', minSlack >= 1,
    `min slack ${minSlack.toFixed(2)}`);
  check('the board cap grows one rider at a time', capJumps === 0);
  check('the curve reaches its ceiling', difficulty.maxFares(40) === MAX_FARES
    && difficulty.difficulty(40) === 1);
  // A fare that spawns already past its floor is one the clamp is doing all the work for. The
  // floor exists for the next-door hop; if it is catching a median trip, the budget is broken.
  const medianWork = 16.4;   // measured mean trip, tools/eta.mjs
  check('the clock floor does not swallow a median trip',
    difficulty.fareLimit(medianWork, 40) > difficulty.getTuning().clockFloor,
    `${difficulty.fareLimit(medianWork, 40).toFixed(1)}s at full difficulty`);
}

// --- Multiple fares, staggered ----------------------------------------------
// The board fills to MAX_FARES with extras arriving one at a time, so more than one clock can
// drain on the kerb and the player has to pick which to grab first. Every rule about when they
// appear is a timing rule — invisible in a still image and easy to break by accident. So: play a
// perfect run and assert the shape of the board at every frame of it.
{
  const mScene = new THREE.Scene();
  const mTraffic = createTraffic(makeRng(seed + 44), mScene, CARS_DEFAULT);
  const fares = createFareSystem(makeRng(seed + 55), mScene);
  mTraffic.warmup(5);

  let mostAtOnce = 0;
  let mostWaiting = 0;
  let extrasBeforeDelivery = false;
  let overCurveCap = 0;
  let spawnedWhileBusy = 0;
  let spawnedIdle = 0;
  let elapsed = 0;
  let prevSpawnAt = -Infinity;
  let minSpawnGap = Infinity;

  // Serve the carried rider first, then the most urgent one on the kerb — the only order one
  // taxi can work in, and the same policy the soak uses.
  const aim = () => {
    const job = fares.carrying() ?? fares.waiting();
    if (!job || job.directed) return;
    const r = findRoute(planOrigin(mTraffic.taxi), job.target);
    if (r) { mTraffic.taxi.route = r; mTraffic.taxi.routeConsumed = false; fares.markDirected(job); }
  };

  while (elapsed < 400 && !fares.state.gameOver && fares.state.delivered < 6) {
    mTraffic.update(1 / 60);
    for (const { type } of fares.update(1 / 60, mTraffic.taxi)) {
      if (type !== 'spawned') continue;
      if (fares.state.fares.length > 1) {
        // The board is only allowed to be this big at this point in the run. Asserted against the
        // curve rather than a constant, because the cap is now a function of deliveries — a ramp
        // that quietly handed out the fourth rider on delivery one would still satisfy any fixed
        // ceiling.
        if (fares.state.fares.length > difficulty.maxFares(fares.state.delivered)) {
          overCurveCap += 1;
        }
        if (fares.state.delivered < 1) extrasBeforeDelivery = true;
        spawnedWhileBusy += 1;
        // The stagger is what turns this into a prioritisation puzzle — every extra rider must
        // arrive at least difficulty.spawnGap() after the previous one, not in the same burst.
        minSpawnGap = Math.min(minSpawnGap, elapsed - prevSpawnAt);
      } else {
        spawnedIdle += 1;
      }
      prevSpawnAt = elapsed;
    }

    // Sampled here, before aim() can direct anything: at this point every waiting fare's diamond
    // has just been ticked against the `directed` it had going into the frame, so the rim and the
    // flag must agree exactly. Doing it after aim() would flag the one-frame lag as a bug.
    for (const f of fares.state.fares) {
      if (f.stage !== 'waiting') continue;
      if (f.slot.marker.isSelected() !== f.directed) selectionOutOfStep += 1;
    }

    aim();
    elapsed += 1 / 60;

    mostAtOnce = Math.max(mostAtOnce, fares.state.fares.length);
    mostWaiting = Math.max(mostWaiting, fares.state.fares.filter((f) => f.stage === 'waiting').length);
  }

  check('the board can fill past two fares', mostAtOnce >= 2,
    `peak ${mostAtOnce}, ${fares.state.delivered} delivered`);
  check('never more than MAX_FARES', mostAtOnce <= MAX_FARES);
  check('the board never runs ahead of the difficulty curve', overCurveCap === 0,
    `${overCurveCap} frames over the cap`);
  check('the extra fares only arrive after the tutorial delivery',
    !extrasBeforeDelivery && spawnedWhileBusy > 0,
    `${spawnedWhileBusy} extras, ${spawnedIdle} on an empty board`);
  // Two waiting riders is the whole point of the change — a single-choice board would leave
  // "prioritise which one to grab" as words in the docs and nothing in the game.
  check('more than one rider can wait on the kerb at once', mostWaiting >= 2,
    `peak ${mostWaiting}`);
  // The stagger is the fairness guarantee: extras land at least difficulty.spawnGap() apart, so
  // their clocks drain out of phase instead of ending on the same tick. 6.5 is the floor of that
  // curve (7s at full difficulty) with a frame's grace — tightening spawnGapEnd below it is a
  // deliberate act that has to come here and say so.
  check('extra fares arrive staggered', minSpawnGap >= 6.5,
    `min gap ${Number.isFinite(minSpawnGap) ? minSpawnGap.toFixed(2) : '-'}s`);

  // The one-seat rule, from the outside: a kerbside rider cannot be directed at while carrying.
  const carried = fares.carrying();
  const kerb = fares.waiting();
  if (carried && kerb) {
    check('a waiting rider cannot be taken while carrying', fares.markDirected(kerb) === false);
  } else {
    check('a waiting rider cannot be taken while carrying', true, 'board not doubled up at exit');
  }
}

// --- Tapping a second waiting rider before the first is picked up -----------------------------
// Regression for a real bug: with two riders on the kerb, tapping one then the other before either
// is collected left both `directed` — the first tap's flag never cleared when the second re-routed
// the taxi. If the new route happened to pass within ARRIVE_RADIUS of the abandoned rider's corner
// too, `update()` resolved a pickup for it as well: two riders "riding" off one seat. An erratic
// player here is whoever taps every un-directed waiter, every frame, the instant carrying() is
// false — the worst case for exactly this.
{
  const xScene = new THREE.Scene();
  const xTraffic = createTraffic(makeRng(seed + 44), xScene, CARS_DEFAULT);
  const fares = createFareSystem(makeRng(seed + 55), xScene);
  xTraffic.warmup(5);

  let elapsed = 0;
  let maxRiding = 0;
  let maxDirected = 0;
  let sawTwoWaiting = false;

  while (elapsed < 400 && !fares.state.gameOver && fares.state.delivered < 6) {
    xTraffic.update(1 / 60);
    for (const { type, fare } of fares.update(1 / 60, xTraffic.taxi)) {
      if (type !== 'pickup') continue;
      // The drop-off dispatches itself, same as dispatchToDropoff in main.js.
      const r = findRoute(planOrigin(xTraffic.taxi), fare.target);
      if (r) { xTraffic.taxi.route = r; xTraffic.taxi.routeConsumed = false; fares.markDirected(fare); }
    }

    maxRiding = Math.max(maxRiding, fares.state.fares.filter((f) => f.stage === 'riding').length);
    maxDirected = Math.max(maxDirected, fares.state.fares.filter((f) => f.directed).length);

    if (!fares.carrying()) {
      const waiters = fares.state.fares.filter((f) => f.stage === 'waiting');
      if (waiters.length >= 2) sawTwoWaiting = true;
      const target = waiters.find((f) => !f.directed);
      if (target) {
        const r = findRoute(planOrigin(xTraffic.taxi), target.target);
        if (r) { xTraffic.taxi.route = r; xTraffic.taxi.routeConsumed = false; fares.markDirected(target); }
      }
    }

    elapsed += 1 / 60;
  }

  check('the board doubles up enough to exercise the switch', sawTwoWaiting);
  check('at most one fare is ever directed at once', maxDirected <= 1, `peak ${maxDirected}`);
  check('switching targets before pickup never seats two riders', maxRiding <= 1, `peak ${maxRiding}`);
}

// --- The trip is public from the moment the rider is --------------------------
// The diamond over the rider's head is the only thing marking someone on the kerb, and the trip it
// belongs to stays hidden until pickup. Every failure mode is silent: a diamond that never appears,
// a drop-off leaking onto the map early, or one that quietly moves between being drawn at spawn
// and being shown at pickup.
{
  const tScene = new THREE.Scene();
  const tTraffic = createTraffic(makeRng(seed + 44), tScene, CARS_DEFAULT);
  const fares = createFareSystem(makeRng(seed + 55), tScene);
  tTraffic.warmup(5);

  let shownOnSpawn = 0;
  let missingPin = 0;
  let wrongCount = 0;
  let wrongPrice = 0;
  let unwinnableClock = 0;
  const budgetSlack = [];
  let movedAtPickup = 0;
  let leakedPin = 0;
  let pinHiddenAtPickup = 0;
  let selectionOutOfStep = 0;
  let wrongOpening = 0;
  let drainedOpening = 0;
  let fillOutOfStep = 0;
  let pickups = 0;
  let stillMarked = 0;   // markers that vanished at pickup instead of flying to the taxi
  let sharedJunction = 0;
  let elapsed = 0;

  // Same perfect-player policy as the multi-fare block above, so the board actually doubles up.
  const aim = () => {
    const job = fares.carrying() ?? fares.waiting();
    if (!job || job.directed) return;
    const r = findRoute(planOrigin(tTraffic.taxi), job.target);
    if (r) { tTraffic.taxi.route = r; tTraffic.taxi.routeConsumed = false; fares.markDirected(job); }
  };

  while (elapsed < 400 && !fares.state.gameOver && fares.state.delivered < 6) {
    tTraffic.update(1 / 60);
    for (const { type, fare } of fares.update(1 / 60, tTraffic.taxi)) {
      if (type === 'spawned') {
        shownOnSpawn += 1;
        if (!fare.slot.marker.group.visible) missingPin += 1;
        if (fare.slot.destination.group.visible) leakedPin += 1;
        // A rider appears with their whole clock, so their diamond opens on the top urgency level
        // — except a VIP, whose diamond opens (and stays) on its own fixed purple instead.
        const wantOpening = fare.vip
          ? new THREE.Color(PALETTE.vip).getHexString()
          : urgencyColor(URGENCY_SEGMENTS).getHexString();
        if (diamondHex(fare.slot.marker) !== wantOpening) wrongOpening += 1;
        // And with a full vessel: the crystal is a glass of time, and it is poured at spawn. A
        // VIP's stays full forever rather than draining — see the fillOutOfStep loop below.
        if (fare.slot.marker.getFill() < 0.99) drainedOpening += 1;
        if (fare.blocks !== blockDistance(fare.pickup, fare.dropoff)) wrongCount += 1;
        // Distance price times the shift's multiplier, both settled at spawn — so this reads the
        // multiplier as of *this* frame, which is the one the fare was stamped with. A VIP stacks
        // its own streak multiplier on top (see fares.js); `fare.vipMultiplier` is 1 for everyone
        // else, so the formula is unchanged for an ordinary fare.
        const due = Math.round(priceFor(fare.pickup, fare.dropoff)
          * difficulty.payoutMultiplier(fares.state.delivered)
          * fare.vipMultiplier);
        if (fare.value !== due) wrongPrice += 1;
        // The clock is budgeted from the driving, so it has to cover it with the run's slack in
        // hand. Below 1.0 the rider cannot be delivered even by a perfect drive.
        if (fare.limit < fare.work) unwinnableClock += 1;
        budgetSlack.push(fare.limit / Math.max(1e-6, fare.work));
      }
      if (type === 'pickup') {
        pickups += 1;
        // The pin is promoted, not replanted — a drop-off that jumped at pickup would make the
        // preview a lie and every judgement made from it worthless.
        if (fare.target.i !== fare.dropoff.i || fare.target.j !== fare.dropoff.j) movedAtPickup += 1;
        // It does not clear at pickup any more — it flies to the taxi and keeps draining there.
        if (!fare.slot.marker.group.visible) stillMarked += 1;
        if (!fare.slot.destination.group.visible) pinHiddenAtPickup += 1;
      }
    }

    // Sampled here, before aim() can direct anything: at this point every waiting fare's diamond
    // has just been ticked against the `directed` it had going into the frame, so the rim and the
    // flag must agree exactly. Doing it after aim() would flag the one-frame lag as a bug.
    for (const f of fares.state.fares) {
      // The liquid level *is* the seconds, on both legs — a crystal that drifts from the clock it
      // draws is worse than one that never drained, because it reads as precision and isn't. A
      // VIP's crystal is the one exception: it never drains at all, by design (faremarker.js).
      const want = f.vip ? 1 : Math.max(0, Math.min(1, f.timeLeft / f.limit));
      if (Math.abs(f.slot.marker.getFill() - want) > 1e-6) fillOutOfStep += 1;
      if (f.stage !== 'waiting') continue;
      if (f.slot.marker.isSelected() !== f.directed) selectionOutOfStep += 1;
    }

    aim();
    elapsed += 1 / 60;

    const live = fares.state.fares;
    // No two fares may claim the same junction at either end, even while the far ends are hidden:
    // a rider spawning on another fare's drop-off ends up sharing a kerb corner once it appears.
    // A riding fare's `target` *is* its drop-off, so it contributes one junction, not two.
    const ends = live.flatMap((f) => (f.stage === 'waiting'
      ? [`${f.target.i},${f.target.j}`, `${f.dropoff.i},${f.dropoff.j}`]
      : [`${f.target.i},${f.target.j}`]));
    if (new Set(ends).size !== ends.length) sharedJunction += 1;
  }

  check('a waiting rider shows their diamond', shownOnSpawn > 0 && missingPin === 0,
    `${shownOnSpawn} spawns, ${missingPin} missing`);
  check('the block count matches the trip', wrongCount === 0, `${wrongCount} mismatched`);
  check('a fresh rider\'s diamond opens on full urgency', wrongOpening === 0,
    `${wrongOpening} opened wrong`);
  check('and opens with a full vessel', drainedOpening === 0, `${drainedOpening} opened drained`);
  // Catches the wiring, not the model: `setUrgency` alone leaves a crystal that steps in quarters
  // and never moves between them, which is exactly the marker this replaced.
  check('the fill tracks the seconds on every live fare', fillOutOfStep === 0,
    `${fillOutOfStep} frames out of step`);
  check('the price agrees with the advertised distance', wrongPrice === 0, `${wrongPrice} mispriced`);
  // The clock now comes from the trip rather than a constant, so "is it enough?" is a live
  // question every spawn rather than something settled once in a comment.
  check('every fare spawns with a clock that covers its own driving',
    unwinnableClock === 0 && budgetSlack.length > 0,
    `${budgetSlack.length} fares, tightest ${Math.min(...budgetSlack).toFixed(2)}x work`);
  check('the drop-off stays hidden while the rider waits', leakedPin === 0, `${leakedPin} leaked`);
  check('the drop-off appears at pickup', pickups > 0 && pinHiddenAtPickup === 0,
    `${pickups} pickups, ${pinHiddenAtPickup} still hidden`);
  check('the drop-off lands where it was drawn at spawn', movedAtPickup === 0,
    `${movedAtPickup} moved`);
  check('the diamond stays up through the pickup', stillMarked === 0, `${stillMarked} vanished`);
  // The heavy rim on the diamond is the only thing saying "the taxi is on its way to this one",
  // which matters most on a board with two riders waiting.
  check('the selection rim tracks whether the taxi was sent', selectionOutOfStep === 0,
    `${selectionOutOfStep} frames out of step`);
  // --- The drop-off is a ring and nothing else.
  //
  // Read off the built marker rather than assumed. The head that used to float over it is gone, so
  // the assertion is as much about what is *not* there: anything standing on the corner would be a
  // second silhouette competing with the rider's diamond, which is the whole reason it went.
  {
    const pin = createDestinationPin();
    const hex = (c) => new THREE.Color(c).getHexString();
    const painted = pin.ring.group.children.map((m) => m.material.color.getHexString()).join('/');
    check('the drop-off ring is teal, rim and fill',
      painted === `${hex(PALETTE.destination)}/${hex(PALETTE.destination)}`, painted);
    check('the drop-off wears no urgency colour',
      !PALETTE.urgency.map(hex).includes(hex(PALETTE.destination)));
    // The ring group and nothing else on the corner; the hit box is a child of the root, not of it.
    check('the drop-off stands nothing on its corner',
      pin.standing === null && pin.postGroup.children.length === 1
      && pin.postGroup.children[0] === pin.ring.group,
      `${pin.postGroup.children.length} on the corner`);
  }
  check('no two fares claim the same junction', sharedJunction === 0, `${sharedJunction} frames`);

  // --- The rider's diamond changes colour as the clock drains.
  //
  // The colour is the whole of what that marker says and none of it is visible in a still image:
  // it has to walk green → yellow → orange → red as the clock runs down, one step per quarter, and
  // never back up the scale. Drive a fare's clock by hand and read the crystal back.
  {
    const diamond = fares.slots[0].marker;
    const seen = [];
    const wrongColour = [];
    for (let step = 0; step <= 20; step++) {
      const fraction = 1 - step / 20;
      const level = urgencyLevel(fraction);
      diamond.showAt(level, 0, 0);
      const want = urgencyColor(level).getHexString();
      const got = diamondHex(diamond);
      if (got !== want) wrongColour.push(`${level}: ${got} != ${want}`);
      // Crystal and disc are one statement. A disc lagging a level behind would have the board
      // saying two different things about the same rider.
      for (const disc of ringHexes(diamond)) {
        if (disc !== want) wrongColour.push(`${level} disc: ${disc} != ${want}`);
      }
      if (got !== seen.at(-1)) seen.push(got);
    }
    check('each urgency level paints the diamond its own colour', wrongColour.length === 0,
      wrongColour.join('; '));
    // Four levels above zero and one at it, but 1 and 0 share red, so a full drain shows exactly
    // four distinct colours in scale order and never repeats one it has already left.
    const scale = [...new Set(PALETTE.urgency.map((h) => new THREE.Color(h).getHexString()))]
      .reverse();
    check('the diamond walks the urgency scale from green to red',
      seen.join(' -> ') === scale.join(' -> '), seen.join(' -> '));

    // The rim is the only mark saying the taxi has been sent at this rider. It reads as *weight*
    // and must stay black at both weights: it was yellow once, and yellow is a colour this very
    // crystal wears for a quarter of every clock.
    const hull = diamond.rim;
    const rim = () => `${hull.material.color.getHexString()}@${hull.scale.x.toFixed(2)}`;
    diamond.setSelected(false);
    const idle = rim();
    diamond.setSelected(true);
    const sent = rim();
    diamond.setSelected(false);
    check('the diamond is inked in heavier black once it is sent, and back again',
      idle.startsWith('000000') && sent.startsWith('000000')
      && Number(sent.split('@')[1]) > Number(idle.split('@')[1]) * 1.1
      && rim() === idle, `${idle} -> ${sent}`);

    // --- The level change kicks.
    //
    // A hue that snaps between four steps is easy to miss on a 29px shape at the edge of the eye,
    // so a change swells and hops the crystal. None of that is visible in a still: drive the clock
    // by hand and watch the scale over the frames after a step.
    diamond.showAt(URGENCY_SEGMENTS, 0, 0);
    let t = 0;
    diamond.update(t);
    const restScale = diamond.mesh.scale.x;
    diamond.setUrgency(URGENCY_SEGMENTS - 1);
    let peakScale = 0;
    let peakLift = 0;
    let framesKicking = 0;
    for (let f = 0; f < 60; f++) {
      t += 1 / 60;
      diamond.update(t);
      if (diamond.isKicking()) framesKicking += 1;
      peakScale = Math.max(peakScale, diamond.mesh.scale.x);
      // Against the bounce this frame would have shown on its own, so the lift is the kick's.
      peakLift = Math.max(peakLift, diamond.mesh.position.y - bounceOffset(t + PHASE_0));
    }
    check('a level change swells the diamond and settles it back',
      peakScale > restScale * 1.05 && peakScale <= restScale * (1 + KICK_SCALE) + 1e-6
      && Math.abs(diamond.mesh.scale.x - restScale) < 1e-6,
      `peak ${peakScale.toFixed(3)}, back to ${diamond.mesh.scale.x.toFixed(3)}`);
    check('it hops on the same beat', peakLift > 0.2 && peakLift <= KICK_HOP + 1e-6,
      `${peakLift.toFixed(2)} units`);
    // Long enough to be seen, short enough that it is over well before the next level lands.
    check('the kick is a beat, not a state',
      framesKicking > 10 && framesKicking < 40 && !diamond.isKicking(),
      `${framesKicking} frames`);

    // A marker that pops the moment it appears is announcing a change that hasn't happened.
    diamond.showAt(URGENCY_SEGMENTS, 0, 0);
    diamond.update(t);
    check('a fresh rider\'s diamond does not kick on spawn',
      !diamond.isKicking() && Math.abs(diamond.mesh.scale.x - restScale) < 1e-6);
    // Once the kick is spent the diamond is back on the plain bounce and nothing else.
    check('the diamond settles back onto its bounce',
      Math.abs(diamond.mesh.position.y - bounceOffset(t + PHASE_0)) < 1e-6,
      `${diamond.mesh.position.y.toFixed(3)}`);
  }

  // A waiting fare offers exactly one target: its rider. Offering the hidden drop-off too would
  // put an invisible 20-unit hit box on a junction the player cannot see anything at.
  const kerb = fares.waiting();
  if (kerb) {
    const hittable = fares.pickables();
    check('a waiting fare offers only its rider as a target',
      hittable.includes(kerb.slot.passenger.group)
      && !hittable.includes(kerb.slot.destination.group));
    check('a tap on the rider resolves to their fare',
      fares.fareFor(kerb.slot.passenger.group) === kerb);
  } else {
    check('a waiting fare offers only its rider as a target', true, 'no waiter at exit');
    check('a tap on the rider resolves to their fare', true, 'no waiter at exit');
  }
}

// --- Ring road and signal health -------------------------------------------
// The ring has no signals, so joining traffic yields into gaps instead of waiting for a phase.
// The failure mode that matters is a car queueing at the perimeter forever with no way in, which
// no screenshot would reveal — so the assertion is on the longest time any car stands still.
{
  const rScene = new THREE.Scene();
  const rTraffic = createTraffic(makeRng(seed + 44), rScene, 24);
  let longestWait = 0;
  const stopped = new Map(rTraffic.cars.map((c) => [c, 0]));
  let prev = rTraffic.cars.map((c) => ({ x: c.x, z: c.z }));

  for (let step = 0; step < 300 * 60; step++) {
    rTraffic.update(1 / 60);
    rTraffic.cars.forEach((c, k) => {
      const moved = Math.hypot(c.x - prev[k].x, c.z - prev[k].z);
      stopped.set(c, moved < 0.005 ? stopped.get(c) + 1 / 60 : 0);
      longestWait = Math.max(longestWait, stopped.get(c));
      prev[k] = { x: c.x, z: c.z };
    });
  }

  check('nobody is stranded at an unsignalised junction', longestWait < 45,
    `longest wait ${longestWait.toFixed(1)}s`);

  // Asked of the network, which is what the sim now obeys. `isUnsignalised` in grid.js still
  // answers the same on this seed, but it answers from `(i, j)` alone — it cannot see that a
  // closure has left an interior junction with nothing to arbitrate, so asserting against it would
  // be testing a function no car consults.
  const net = cityNetwork();
  const signalled = (i, j) => net.nodeByGrid(i, j).signal !== null;
  const ringCorners = [[0, 0], [0, GRID], [GRID, 0], [GRID, GRID]];
  check('ring corners keep their signals', ringCorners.every(([i, j]) => signalled(i, j)));
  check('the rest of the ring has none',
    !signalled(1, 0) && !signalled(0, 1) && signalled(1, 1));

  const perCar = rTraffic.stats.distance / rTraffic.stats.time / rTraffic.cars.length;
  check('traffic moves better than the old fixed-phase grid', perCar > 4.14,
    `${perCar.toFixed(2)} vs 4.14 units/s per car`);

  // Loco Mode should fly through ring junctions too, not just interior signalised ones. The
  // priority-junction override used to skip ring junctions on the grounds that they had no phase
  // to override; the ring/cross branches now consult `priorityCovers` and route through the
  // signal model, so `lightPhase` at the taxi's target junction reads green on its axis whether
  // it's a signalised interior or a yield-controlled ring approach.
  const boostScene = new THREE.Scene();
  const boostTraffic = createTraffic(makeRng(seed + 77), boostScene, 1);
  const bTaxi = boostTraffic.taxi;
  bTaxi.boost = true;
  bTaxi.d = 3; bTaxi.i = 2; bTaxi.j = 0;   // heading NZ toward a non-corner ring junction
  boostTraffic.update(1 / 60);
  const ringPhase = lightPhase(bTaxi.i, bTaxi.j, boostTraffic.stats.time);
  check('boost forces the ring junction green on the taxi axis',
    ringPhase.axis === 'z' && !ringPhase.yellow, `axis=${ringPhase.axis} yellow=${ringPhase.yellow}`);

  // ...but the lamps must not follow the hold. Loco Mode is meant to *look* like running every
  // red — the yielding happens underneath, in `canProceed`. Heads that flipped green as the taxi
  // arrived made the city read as politely opening up instead.
  const shown = displayPhase(bTaxi.i, bTaxi.j, boostTraffic.stats.time);
  setPriorityJunction(null);
  const honest = lightPhase(bTaxi.i, bTaxi.j, boostTraffic.stats.time);
  check('the signal heads ignore the boost hold',
    shown.axis === honest.axis && shown.yellow === honest.yellow && shown.axis !== ringPhase.axis,
    `shown ${shown.axis}/${shown.yellow}, honest ${honest.axis}/${honest.yellow}`);

  // Loco Mode weaves *inside its lane*. It used to slide a full LANE out onto the road centreline
  // to overtake, which put it 2 units from same-direction and oncoming traffic alike — inside the
  // 2.31-unit collision envelope, so every car it passed was a crash (one every 9.7s of boosting,
  // against one every 25.1s now). Two failures to guard against, and this checks both: the weave
  // growing back out of the lane, and the weave quietly going flat.
  const wScene = new THREE.Scene();
  const wTraffic = createTraffic(makeRng(seed + 91), wScene, CARS_DEFAULT);
  const wTaxi = wTraffic.taxi;
  wTraffic.warmup(10);
  wTaxi.boost = true;
  let widest = 0;
  let straightFrames = 0;
  for (let f = 0; f < 60 * 20; f++) {
    wTraffic.update(1 / 60);
    if (wTaxi.state !== 'drive') continue;
    straightFrames += 1;
    // Distance from the lane centre, measured off the rendered position — the offset is applied
    // at render, so reading `car.x/car.z` is reading what the player sees. On the travel axis the
    // coordinate runs along the road and says nothing; only the cross-axis one is the lane.
    const cross = isXAxis(wTaxi.d) ? wTaxi.z : wTaxi.x;
    widest = Math.max(widest, Math.abs(distToLine(cross) - LANE));
  }
  // 0.52 is the two waves' peak sum; the margin covers a frame landing mid-corner-exit. The frame
  // floor is the sample size: at boost speed a junction arrives about every 1.1s, so barely half
  // of these 20s are spent in the 'drive' state at all.
  check('the boosting taxi holds its lane', widest < 0.6 && straightFrames > 400,
    `widest ${widest.toFixed(2)} units off the lane centre over ${straightFrames} frames`);
  check('the boosting taxi actually weaves', widest > 0.25, `widest ${widest.toFixed(2)}`);
  setPriorityJunction(null);

  // --- Loco Mode is supposed to be go-go-go, and for a long time it wasn't.
  //
  // Attributing every frame the boosting taxi spent below full speed put signals at 0.0% — the
  // priority hold was already doing its job — and ordinary traffic at everything else: queued
  // behind a leader, or stopped dead at a green line because the exit lane was full. Hence
  // `scatter` in traffic.js. These two checks pin the parts of it that can go quietly wrong: the
  // flee not firing, and oncoming traffic re-acquiring its veto over a left turn.
  //
  // Both are two-car scenarios placed by hand, so nothing else can be the reason either car moves
  // or doesn't. The aggregate version — mean speed over a long routed drive through heavy traffic
  // — was written and then thrown away: changing the turn weights reroutes the whole city's rng
  // stream, so a before/after pair is two different worlds rather than a comparison, and the
  // seed-to-seed spread (73%-96% of the cap across eight cities) swamped a two-point effect.
  //
  // Not a fixed junction either: park districts close whole segments, so on some cities the left
  // out of the middle intersection doesn't exist and the taxi's route desyncs into a random turn.
  // Take the first signalised junction where both the left and the facing approach are legal.
  let jI = -1;
  let jJ = -1;
  let dIn = -1;
  outer: for (let i = 1; i < GRID && dIn < 0; i++) {
    for (let j = 1; j < GRID && dIn < 0; j++) {
      if (ringAxisAt(i, j)) continue;
      for (const d of [0, 1, 2, 3]) {
        if (!legalExits(d, i, j).includes(leftOf(d))) continue;
        if (!legalExits(opposite(d), i, j).length) continue;
        // The scatter scenario below stages a car 30 units back, so the approach has to be that
        // long. A junction one block in from the edge is not — and the old infinite lane hid it
        // by letting the car sit off the map and drive in.
        if (approachRoom(d, i, j) < 30) continue;
        jI = i; jJ = j; dIn = d;
        break;
      }
    }
  }
  // `back` is measured from the junction boundary, and may be more than one block — placeCar
  // walks back along the straight-through chain, which is what the old infinite lane allowed.
  const place = (car, d, back) => {
    placeCar(car, d, jI, jJ, back);
    car.route = []; car.parked = false;
  };

  // 1. A leader with the boosting taxi on its bumper gets going. The taxi starts 30 units out and
  // the leader 12, well inside SCATTER_RANGE, on an otherwise empty road.
  //
  // The leader used to be staged 18 units out. That is not a place a car can be: a lane is 12 long
  // and the junction beyond it 8, so 18 is inside the junction box. The old infinite `laneKey` row
  // had no such notion — it also, on this junction, placed the *taxi* 14 units off the western edge
  // of the map and let it drive in — so the distance went unquestioned. 12 is the near end of the
  // lane, which is as much clear road as a car on this city can actually have.
  const sScene = new THREE.Scene();
  const sTraffic = createTraffic(makeRng(seed + 103), sScene, 2);
  const [sTaxi, leader] = sTraffic.cars;
  place(sTaxi, dIn, 30);
  place(leader, dIn, 12);
  sTaxi.boost = true;
  let fleeSpeed = 0;
  let fleePeak = 0;      // peak of the scatter envelope, not its value at the end — the leader
                         // turns off the taxi's road partway through and it decays from there
  let taxiFloor = Infinity;
  for (let f = 0; f < 60 * 2; f++) {
    sTraffic.update(1 / 60);
    sTaxi.boost = true;
    fleePeak = Math.max(fleePeak, leader.scatter);
    if (leader.state === 'drive') fleeSpeed = Math.max(fleeSpeed, leader.speedFactor);
    // Skip the first few frames: the taxi is still spinning up from cruise.
    if (f > 20 && sTaxi.state === 'drive') taxiFloor = Math.min(taxiFloor, sTaxi.speedFactor);
  }
  // speedFactor is v/SPEED, so anything over 1 is a car exceeding the ambient cruise, and 2.2 is
  // full boost. Measured against its own control — the identical scenario with the taxi not
  // boosting — the leader peaks at exactly 1.00x cruise with a scatter envelope of 0.00, against
  // 1.43x and a full 1.00 envelope with the taxi on its bumper. So the discrimination is total,
  // even though the absolute figure is down from the 2.00x the 18-unit staging used to report:
  // that number needed 18 units of clear road ahead of the leader before it had to brake for its
  // junction, and no lane in this city is that long. The taxi's floor is where it eases up behind
  // the leader as the leader turns off.
  check('traffic gets out of the boosting taxi\'s way',
    dIn >= 0 && fleePeak > 0.9 && fleeSpeed > 1.35 && taxiFloor > 1.25,
    `leader peaked at ${fleeSpeed.toFixed(2)}x cruise, taxi never fell below ${taxiFloor.toFixed(2)}x`);

  // 2. A boosting taxi turning left used to stop dead under a green: the oncoming lane shares its
  // axis, so it kept its green, and the left-turn yield then refused to let the taxi go — waiting
  // on a car that was itself waiting. The priority hold now denies that one direction (`block` in
  // traffic.js) and the taxi only looks for something already inside the junction.
  const dScene = new THREE.Scene();
  const dTraffic = createTraffic(makeRng(seed + 117), dScene, 2);
  const [dTaxi, oncoming] = dTraffic.cars;
  place(dTaxi, dIn, 24);
  place(oncoming, opposite(dIn), 18);
  dTaxi.route = [leftOf(dIn)];
  dTaxi.routeConsumed = false;
  dTaxi.boost = true;

  let turned = false;
  let oncomingEntered = false;
  for (let f = 0; f < 60 * 6 && !turned; f++) {
    dTraffic.update(1 / 60);
    dTaxi.boost = true;
    if (dTaxi.state === 'turn' && dTaxi.dOut === leftOf(dIn)) turned = true;
    if (oncoming.state === 'turn') oncomingEntered = true;
  }
  check('Loco Mode takes its left turn instead of yielding',
    dIn >= 0 && turned && !oncomingEntered,
    `turned=${turned}, oncoming entered the junction=${oncomingEntered}`);

  setPriorityJunction(null);
}

// --- Loco Mode momentum cooldown --------------------------------------------
// Letting go used to drop every boost-only rule in the same frame — collision detection, the
// police bust range, running reds — so tapping off a beat before impact was a free escape. The
// cooldown keeps those rules live for BOOST_COOLDOWN seconds after release while the taxi's own
// speed cap drops immediately, so it's still committed to the risk while visibly coasting down.
{
  // Plain release: active -> cooldown (still engaged) -> ready, fuel untouched while it's frozen.
  // Opened full rather than at the run's starting third so half a second of holding is a rounding
  // error against the tank, and the cooldown is the only thing under test.
  const boost = createBoost(15, 1, BOOST_COOLDOWN);
  boost.press();
  for (let f = 0; f < 30; f++) boost.update(1 / 60); // hold for half a second
  boost.release();
  check('release enters cooldown rather than going straight to ready',
    boost.isCoolingDown() && !boost.isActive() && !boost.isReady(), `mode=${boost.state.mode}`);
  check('cooldown still reads as engaged, for the collision/bust/red-light gates',
    boost.isEngaged());

  const fuelAtRelease = boost.state.fuel;
  boost.update(BOOST_COOLDOWN * 0.5);
  check('fuel stays frozen mid-cooldown', boost.state.fuel === fuelAtRelease,
    `${boost.state.fuel.toFixed(3)} vs ${fuelAtRelease.toFixed(3)} at release`);

  boost.update(BOOST_COOLDOWN * 0.5 + 0.01);
  check('cooldown hands off to ready once the window closes',
    boost.isReady() && !boost.isEngaged(), `mode=${boost.state.mode}`);
}
{
  // Re-pressing mid-cooldown catches the car before the window closes: back to active outright,
  // same as the button reads a fresh Loco Mode press (wheelie/flame/kick in main.js key off this).
  const boost = createBoost(15, 1, BOOST_COOLDOWN);
  boost.press();
  boost.update(1 / 60);
  boost.release();
  boost.update(BOOST_COOLDOWN * 0.5);
  const resumed = boost.press();
  check('re-press mid-cooldown snaps straight back to active',
    resumed && boost.isActive(), `resumed=${resumed} mode=${boost.state.mode}`);
}
{
  // Draining the tank to empty while still held gets the same cooldown tail as an on-purpose
  // release — it doesn't skip straight to the dead-button state just because the player never
  // let go.
  const boost = createBoost(0.1, 1, BOOST_COOLDOWN);
  boost.press();
  boost.update(0.2); // more than the whole tank in one step
  check('running dry enters cooldown instead of going dead immediately',
    boost.isCoolingDown(), `mode=${boost.state.mode}`);
  boost.update(BOOST_COOLDOWN + 0.01);
  check('cooldown from a dry tank lands on empty', boost.isEmpty(), `mode=${boost.state.mode}`);
}
{
  // The taxi's own physics: `boost` (the hazard flag) stays true through the cooldown tail, but
  // `boostEasing` tells traffic.js the hold itself is over, so the speed cap drops at once and the
  // car coasts down under ordinary braking — same braking constant as any other stop, which is
  // also what drives the visible nose-dip (the pitch spring reads deceleration off car.v).
  const eScene = new THREE.Scene();
  const eTraffic = createTraffic(makeRng(seed + 129), eScene, 1);
  const eTaxi = eTraffic.taxi;
  eTaxi.boost = true;
  for (let f = 0; f < 60; f++) eTraffic.update(1 / 60); // spin up to full boost speed
  const peakFactor = eTaxi.speedFactor; // v/SPEED — 2.2 is full boost, 1.0 is cruise
  eTaxi.boostEasing = true; // the button just came up — cooldown starts, hold ends
  for (let f = 0; f < Math.round(BOOST_COOLDOWN * 60); f++) eTraffic.update(1 / 60);
  check('boost speed peaks well above cruise before release', peakFactor > 1.8,
    `peak ${peakFactor.toFixed(2)}x cruise`);
  check('easing off drops the speed cap and the car actually coasts back toward cruise',
    eTaxi.speedFactor < peakFactor * 0.7 && eTaxi.speedFactor < 1.3,
    `${peakFactor.toFixed(2)}x -> ${eTaxi.speedFactor.toFixed(2)}x cruise over ${BOOST_COOLDOWN}s`);
  setPriorityJunction(null);
}

// --- Routing ---------------------------------------------------------------
// Every (approach state, destination) pair must be solvable. A single unreachable pair would
// strand the taxi with no way for the player to recover.
const ints = allIntersections();
let unroutable = 0;
let longest = 0;
for (const from of ints) {
  for (const to of ints) {
    for (let d = 0; d < 4; d++) {
      const route = findRoute({ i: from.i, j: from.j, d }, to);
      if (route === null) unroutable += 1;
      else longest = Math.max(longest, route.length);
    }
  }
}
check('every intersection is routable from every approach', unroutable === 0,
  `${ints.length * ints.length * 4} pairs, longest ${longest} turns`);

// --- The drawn route band --------------------------------------------------
// The band is paint on the lane the taxi will drive, so it has to (a) stay on the tarmac,
// (b) sit in the *right-hand* lane on every straight, and (c) never re-shape ahead of the car.
// (c) is the one that matters and the one the centreline version failed: its corner fillet was
// clamped against the distance to the car, so the drawn corner visibly moved as the taxi closed
// on it. Nothing in the path may depend on where the car is except where the band starts.
{
  const rScene = new THREE.Scene();
  const rTraffic2 = createTraffic(makeRng(seed + 91), rScene, 1);   // taxi alone: nothing to block it
  const rTaxi = rTraffic2.taxi;

  // Somewhere far enough away to cross the map and take several turns.
  const dest = { i: rTaxi.i > GRID / 2 ? 0 : GRID, j: rTaxi.j > GRID / 2 ? 0 : GRID };
  rTaxi.route = findRoute(planOrigin(rTaxi), dest);
  rTaxi.routeConsumed = false;

  const HALF_ROAD = ROAD_W / 2;
  const BAND_HALF = ((ROAD_W / 2) * 0.85) / 2;
  /** Coordinate of the road centreline nearest v, on either axis. */
  const lineNear = (v) => lineCoord(Math.round((v + HALF_SPAN) / PITCH));

  // Distance from a point to a polyline, so "the new path lies on the old one" is one number.
  const distToPath = (p, path) => {
    let best = Infinity;
    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k];
      const b = path[k + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz)));
    }
    return best;
  };

  const planned = routePath(rTaxi, rTaxi.route);
  let offRoad = 0;
  let wrongLane = 0;
  let straights = 0;
  let drift = 0;
  let frames = 0;

  for (let step = 0; step < 120 * 60; step++) {
    rTraffic2.update(1 / 60);
    const path = routePath(rTaxi, rTaxi.route);
    if (path.length < 2) break;
    frames += 1;

    for (const p of path) {
      const dx = Math.abs(p.x - lineNear(p.x));
      const dz = Math.abs(p.z - lineNear(p.z));
      // Inside a junction box the tarmac runs both ways, so being near a centreline on either
      // axis is enough. Out on a straight the band's own half-width has to fit as well: a lane
      // centre is LANE (2) off the centreline and the band is 1.7 wide, which leaves 0.3 of
      // asphalt showing at the kerb.
      const inJunction = dx <= HALF_ROAD && dz <= HALF_ROAD;
      if (!inJunction && Math.min(dx, dz) + BAND_HALF > HALF_ROAD) offRoad += 1;
      drift = Math.max(drift, distToPath(p, planned));
    }

    // Right-hand lane on the straights: take mid-block segments (both ends clear of a junction
    // box) and check the cross-axis offset is exactly one LANE, on the side travel dictates.
    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k];
      const b = path[k + 1];
      const dirX = Math.abs(b.x - a.x) > Math.abs(b.z - a.z);
      const cross = dirX ? a.z : a.x;
      const alongMid = dirX ? (a.x + b.x) / 2 : (a.z + b.z) / 2;
      if (Math.abs(alongMid - lineNear(alongMid)) < HALF_ROAD) continue;   // inside a junction box
      if (Math.hypot(b.x - a.x, b.z - a.z) < 1) continue;
      const crossLine = lineNear(cross);
      const sign = dirX ? Math.sign(b.x - a.x) : Math.sign(b.z - a.z);
      const want = dirX ? sign * LANE : -sign * LANE;
      straights += 1;
      if (Math.abs((cross - crossLine) - want) > 1e-6) wrongLane += 1;
    }

    if (!rTaxi.route.length && Math.hypot(rTaxi.x - lineCoord(dest.i), rTaxi.z - lineCoord(dest.j)) < 8) break;
  }

  check('the route band stays on the road', offRoad === 0, `${offRoad} points off tarmac`);
  check('the route band sits in the right-hand lane', wrongLane === 0 && straights > 20,
    `${straights - wrongLane}/${straights} straight segments in lane`);
  // The band may only get shorter from behind: every point of every later path must still lie on
  // the path drawn when the route was planned.
  check('the route band never re-shapes ahead of the taxi', drift < 0.05 && frames > 300,
    `max drift ${drift.toFixed(4)} units over ${frames} frames`);
}

// Park districts build over a road. The closure has to be real in the traffic model, not just
// hidden in the ground mesh, and it must not strand any part of the city.
check('park districts closed a road each', (layout.districts ?? []).length > 0,
  `${(layout.districts ?? []).length} districts`);

const drivingThroughPark = traffic.cars.filter((car) => (layout.districts ?? []).some((d) =>
  car.x > d.bounds.x0 && car.x < d.bounds.x1 && car.z > d.bounds.z0 && car.z < d.bounds.z1));
check('no vehicle is driving through a park district', drivingThroughPark.length === 0,
  `${drivingThroughPark.length} inside park bounds`);

check('the taxi is an ordinary car in the traffic array',
  traffic.cars.includes(traffic.taxi) && traffic.taxi.isTaxi,
  'so signals and following distance apply to it');

// --- Parked taxi with a same-intersection destination ---------------------
// The taxi picks up a rider, then the player taps a destination that happens to be the
// intersection the taxi is already heading toward. findRoute returns [] ("already at target"),
// which used to leave the parked check with an empty route — allowed = 0 forever, no arrival,
// no way out even with Loco Mode. Mirrors main.js:routeTo, which now clears `parked` too.
{
  const sScene = new THREE.Scene();
  const sTraffic = createTraffic(makeRng(seed + 44), sScene, CARS_DEFAULT);
  const sFares = createFareSystem(makeRng(seed + 55), sScene);
  const sTaxi = sTraffic.taxi;
  sTraffic.warmup(5);

  const routeTo = (target) => {
    const r = findRoute(planOrigin(sTaxi), target);
    if (!r) return false;
    sTaxi.route = r; sTaxi.routeConsumed = false; sTaxi.parked = false;
    return true;
  };

  let pickedUp = false;
  let tapped = false;
  let elapsed = 0;
  while (elapsed < 120 && !sFares.state.gameOver && sFares.state.delivered === 0) {
    sTraffic.update(1 / 60);
    for (const { type } of sFares.update(1 / 60, sTaxi)) {
      if (type === 'pickup') { sTaxi.route = []; sTaxi.parked = true; pickedUp = true; }
    }
    elapsed += 1 / 60;

    const waiting = sFares.waiting();
    if (waiting && !waiting.directed && !pickedUp) {
      if (routeTo(waiting.target)) sFares.markDirected(waiting);
    }
    if (pickedUp && !tapped) {
      const c = sFares.carrying();
      if (c) {
        c.target = { i: sTaxi.i, j: sTaxi.j };   // destination = taxi's current target junction
        if (routeTo(c.target)) sFares.markDirected(c);
        tapped = true;
      }
    }
  }

  check('a parked taxi still delivers when the destination is its own next junction',
    sFares.state.delivered === 1,
    `${sFares.state.delivered} delivered after ${elapsed.toFixed(1)}s`);
}

// --- The drop-off dispatches itself ----------------------------------------
// The player taps riders on the kerb and nothing else — no drop-off is ever tapped in this
// run — and a delivery still has to land. Mirrors main.js:dispatchToDropoff, which routes at the
// drop-off on the pickup frame instead of parking the taxi for a confirming tap.
//
// The pickup frame is the awkward one and the reason this is asserted rather than assumed: the
// taxi is *inside* the junction when the rider boards (measured: `state === 'turn'` at every
// pickup across four run seeds, still doing the full 8.5 u/s), so the route has to be planned from
// a turn the car has already committed to. planOrigin handles that, and a route planned from the
// wrong origin drops its first turn silently — the taxi would wander off and the fare would time
// out with nothing in the log to say why.
{
  const aScene = new THREE.Scene();
  const aTraffic = createTraffic(makeRng(seed + 44), aScene, CARS_DEFAULT);
  const aFares = createFareSystem(makeRng(seed + 55), aScene);
  const aTaxi = aTraffic.taxi;
  aTraffic.warmup(5);

  // Mirrors main.js:routeTo.
  const routeTo = (target) => {
    const r = findRoute(planOrigin(aTaxi), target);
    if (!r) return false;
    aTaxi.route = r; aTaxi.routeConsumed = false; aTaxi.parked = false;
    return true;
  };

  let pickups = 0;
  let dispatched = 0;
  let parkedWhileCarrying = 0;
  let elapsed = 0;

  while (elapsed < 200 && !aFares.state.gameOver && aFares.state.delivered === 0) {
    aTraffic.update(1 / 60);
    for (const { type, fare } of aFares.update(1 / 60, aTaxi)) {
      if (type !== 'pickup') continue;
      pickups += 1;
      aTaxi.route = [];
      if (routeTo(fare.target)) { aFares.markDirected(fare); dispatched += 1; }
      else aTaxi.parked = true;
    }

    // A pickup is a pause in a drive now, not a full stop: with a rider aboard the taxi is never
    // held at the kerb waiting to be told where to go. Sampled every frame, not just the pickup
    // one — `parked` is what Loco Mode used to be dead against.
    if (aFares.carrying() && aTaxi.parked) parkedWhileCarrying += 1;

    // The only tap the "player" makes in this run is on a rider standing on the kerb.
    const waiting = aFares.waiting();
    if (waiting && !waiting.directed && !aFares.carrying()) {
      if (routeTo(waiting.target)) aFares.markDirected(waiting);
    }
    elapsed += 1 / 60;
  }

  check('a rider is delivered without the drop-off ever being tapped',
    aFares.state.delivered === 1 && dispatched === pickups && pickups > 0,
    `${aFares.state.delivered} delivered after ${elapsed.toFixed(1)}s`);
  check('a carried rider never leaves the taxi parked', parkedWhileCarrying === 0,
    `${parkedWhileCarrying} frames held at the kerb`);
}

// --- Taxi-vs-car collisions ------------------------------------------------
// The whole feature only fires while boosting, and its silent failure modes are: no impact ever
// detected, an impact that doesn't wreck the taxi, or a wrecked car left driving around because
// something forgot to take it out of the sim. Drive the taxi head-on into an unsuspecting car and
// assert the whole crash chain, both cars included.
{
  const cScene = new THREE.Scene();
  const cTraffic = createTraffic(makeRng(seed + 44), cScene, CARS_DEFAULT);
  const cFares = createFareSystem(makeRng(seed + 55), cScene);
  const cTaxi = cTraffic.taxi;
  const collisions = createCollisions(cTraffic.cars, cTaxi);
  const cVanish = createVanish();
  let hits = 0;
  let impact = null;
  const shells = [];
  collisions.onImpact((event) => {
    hits += 1;
    impact = event;
    // Mirror the main.js wiring: both cars hand over their bodywork to the shrink-and-fade, and
    // the run ends.
    for (const car of [event.taxi, event.other]) {
      const shell = cTraffic.wreckShell(car);
      shells.push(shell);
      cVanish.take(shell);
    }
    cFares.crash();
  });

  cTraffic.warmup(3);

  // Park the taxi on top of an ambient car and start boosting.
  const target = cTraffic.cars.find((c) => !c.isTaxi && c.state === 'drive');
  cTaxi.x = target.x;
  cTaxi.z = target.z;
  cTaxi.boost = true;

  for (let step = 0; step < 90; step++) {
    collisions.update();
    cTraffic.update(1 / 60);
    if (hits > 0) break;
  }

  check('boosting into another car fires an impact', hits >= 1, `${hits} impacts`);
  check('the taxi is wrecked by the impact', cTaxi.crashed);
  check('game over fires with a collision reason', cFares.state.gameOver
    && /collision/i.test(cFares.state.failReason ?? ''), cFares.state.failReason);

  const victim = impact?.other;
  check('the car it hit is wrecked too', Boolean(victim?.crashed));

  // A wrecked car must be gone from the road, not merely marked: same place a second later, and
  // its instance collapsed to nothing so the InstancedMesh isn't still drawing it.
  const restX = victim.x;
  const restZ = victim.z;
  for (let step = 0; step < 60; step++) cTraffic.update(1 / 60);
  check('the wrecked car stops driving', victim.x === restX && victim.z === restZ,
    `${victim.x.toFixed(2)},${victim.z.toFixed(2)} vs ${restX.toFixed(2)},${restZ.toFixed(2)}`);

  // Body *and* both steered front wheels — the wheels are their own instanced mesh, so a wreck
  // that only collapsed the body would leave two wheels parked on the road.
  const instanceScale = new THREE.Vector3();
  const instanceMatrix = new THREE.Matrix4();
  const scaleOf = (instMesh, index) => {
    instMesh.getMatrixAt(index, instanceMatrix);
    instanceMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), instanceScale);
    return instanceScale.x;
  };
  const wheelsPerCar = cTraffic.wheelMesh.count / (cTraffic.cars.length - 1);
  const wheelScales = [];
  for (let w = 0; w < wheelsPerCar; w++) {
    wheelScales.push(scaleOf(cTraffic.wheelMesh, victim.instanceIndex * wheelsPerCar + w));
  }
  check('its instances are collapsed out of the traffic meshes',
    scaleOf(cTraffic.mesh, victim.instanceIndex) === 0 && wheelScales.every((s) => s === 0),
    `body + ${wheelScales.length} wheels`);

  // Two shells handed over — the taxi group and a standalone copy of the ambient car — and both
  // shrink and fade rather than cutting out on the impact frame.
  check('both wrecks hand over a shell to fade', shells.length === 2 && shells[0] !== shells[1]);
  // One material across the copy's body and wheels; read it off the body mesh.
  const shellMaterial = shells[1].children[0].material;
  const baseScale = shells[1].scale.x;
  cVanish.update(0.17);
  check('a wreck shell shrinks and fades under the explosion',
    shells[1].scale.x < baseScale && shells[1].scale.x > 0
    && shellMaterial.opacity < 1 && shellMaterial.opacity > 0,
    `scale ${shells[1].scale.x.toFixed(2)}, opacity ${shellMaterial.opacity.toFixed(2)}`);
  cVanish.update(0.4);
  check('a wreck shell ends hidden at zero size',
    !shells[1].visible && shells[1].scale.x === 0 && cVanish.pending() === 0);

  check('a wrecked taxi does not fire further impacts', hits === 1, `${hits} impacts`);

  // A non-boosting taxi must never trigger a collision — normal lane logic keeps them apart.
  const qScene = new THREE.Scene();
  const qTraffic = createTraffic(makeRng(seed + 44), qScene, CARS_DEFAULT);
  const qCollisions = createCollisions(qTraffic.cars, qTraffic.taxi);
  let quietHits = 0;
  qCollisions.onImpact(() => { quietHits += 1; });
  for (let step = 0; step < 60 * 30; step++) {
    qCollisions.update();
    qTraffic.update(1 / 60);
  }
  check('no collisions fire while the taxi is not boosting', quietHits === 0,
    `${quietHits} impacts over 30s`);
}

// --- The crash blast -------------------------------------------------------
// game/blast.js is what a wreck detonates. Its silent failure modes are all "it looked fine on the
// impact frame": a pool that wraps and truncates the second car's burst, a slot left drawing after
// its life ran out, or both cars' shards coming out the same colour — which is the one thing the
// two separate debris pools it replaced were carrying.
{
  const eScene = new THREE.Scene();
  const blast = createBlast(eScene, makeRng(seed + 88));

  const liveScales = (mesh) => {
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const out = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      if (scale.x > 0) out.push(scale.x);
    }
    return out;
  };

  check('a blast starts with nothing drawn', blast.active() === 0);

  // Both cars of a wreck, a couple of units apart and in their own paint.
  blast.fire(0, 0, PALETTE.taxiBody);
  blast.fire(3, 1.5, PALETTE.carBody[1]);
  const fired = blast.active();
  blast.update(1 / 60);

  check('both cars fit the pools without wrapping', fired === 2 * (12 + 7 + 1), `${fired} instances`);
  check('a blast puts a ring, a fireball and shards on the road',
    liveScales(blast.ringMesh).length === 2
    && liveScales(blast.puffMesh).length === 24
    && liveScales(blast.shardMesh).length === 14,
    `${liveScales(blast.ringMesh).length} rings, ${liveScales(blast.puffMesh).length} puffs, `
    + `${liveScales(blast.shardMesh).length} shards`);

  // Each car's shards wear that car's paint — a shared pool would have repainted the first car's
  // wreckage when the second one detonated.
  const shardColors = new Set();
  const instanceColor = new THREE.Color();
  for (let i = 0; i < blast.shardMesh.count; i++) {
    blast.shardMesh.getColorAt(i, instanceColor);
    shardColors.add(instanceColor.getHexString());
  }
  const taxiHex = new THREE.Color(PALETTE.taxiBody).getHexString();
  const otherHex = new THREE.Color(PALETTE.carBody[1]).getHexString();
  check('each car\'s shards keep their own paint',
    shardColors.has(taxiHex) && shardColors.has(otherHex),
    [...shardColors].join(' '));

  // The fireball peaks and then collapses — a blast that only faded left a full-size ghost of
  // itself hanging over the road for the whole retry screen.
  let peak = 0;
  for (let step = 0; step < 40; step++) {
    blast.update(1 / 60);
    peak = Math.max(peak, Math.max(0, ...liveScales(blast.puffMesh)));
  }
  const later = Math.max(0, ...liveScales(blast.puffMesh));
  check('the fireball blooms and then collapses', peak > 1 && later < peak,
    `peak ${peak.toFixed(2)}, ${later.toFixed(2)} at 0.67s`);

  // And it ends. Every slot back to zero scale, not merely faded — an instance left at size is
  // still a draw, and this pool is never cleared by anything else.
  for (let step = 0; step < 60 * 3; step++) blast.update(1 / 60);
  check('a blast retires completely',
    blast.active() === 0
    && liveScales(blast.ringMesh).length === 0
    && liveScales(blast.puffMesh).length === 0
    && liveScales(blast.shardMesh).length === 0,
    `${blast.active()} still alive`);

  // Shards arc, but nothing may end up under the road: there is no bounce to catch them any more,
  // only a floor.
  const bScene = new THREE.Scene();
  const floorBlast = createBlast(bScene, makeRng(seed + 89));
  floorBlast.fire(0, 0, PALETTE.taxiBody);
  let lowest = Infinity;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  for (let step = 0; step < 90; step++) {
    floorBlast.update(1 / 60);
    for (let i = 0; i < floorBlast.shardMesh.count; i++) {
      floorBlast.shardMesh.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      const scale = new THREE.Vector3();
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      if (scale.x > 0) lowest = Math.min(lowest, position.y);
    }
  }
  check('no shard falls through the road', lowest >= 0.2 - 1e-6, `lowest y ${lowest.toFixed(3)}`);
}

// --- Busted by the police --------------------------------------------------
// Boosting near an active police car ends the run with a distinct "Busted" title. Mirrors the
// wiring in src/main.js: proximity < POLICE_BUST_RANGE while boosting → fares.crash('...',
// 'Busted'). No wreck plume, so the check is about the state transition, not particle effects.
{
  const bScene = new THREE.Scene();
  const bTraffic = createTraffic(makeRng(seed + 44), bScene, CARS_DEFAULT);
  const bFares = createFareSystem(makeRng(seed + 55), bScene);
  const bPolice = createPolice(makeRng(seed + 66), bScene);
  const bTaxi = bTraffic.taxi;

  // Fast-forward to a live police run — the corridor logic drives when the car appears.
  bPolice.state.cooldown = 0;
  for (let step = 0; step < 60 * 60 && !bPolice.state.active; step++) {
    bPolice.update(1 / 60);
    bTraffic.update(1 / 60);
  }
  check('police run activates for the bust test', bPolice.state.active);

  // Put the taxi within bust range of the cop, boost engaged.
  bTaxi.x = bPolice.group.position.x + 5;
  bTaxi.z = bPolice.group.position.z + 5;
  bTaxi.boost = true;

  const dx = bTaxi.x - bPolice.group.position.x;
  const dz = bTaxi.z - bPolice.group.position.z;
  const near = dx * dx + dz * dz < POLICE_BUST_RANGE * POLICE_BUST_RANGE;
  if (near && bTaxi.boost && bPolice.state.active && !bFares.state.gameOver && !bTaxi.crashed) {
    bTaxi.crashed = true;
    bFares.crash('You were caught by the police for reckless driving.', 'Busted');
  }

  check('boosting near the police ends the run', bFares.state.gameOver);
  check('bust banner title is "Busted"', bFares.state.failTitle === 'Busted',
    bFares.state.failTitle);
  check('bust reason mentions the police', /police/i.test(bFares.state.failReason ?? ''),
    bFares.state.failReason);

  // Well outside bust range: same setup, no trigger.
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 44), fScene, CARS_DEFAULT);
  const fFares = createFareSystem(makeRng(seed + 55), fScene);
  const fPolice = createPolice(makeRng(seed + 66), fScene);
  fPolice.state.cooldown = 0;
  for (let step = 0; step < 60 * 60 && !fPolice.state.active; step++) {
    fPolice.update(1 / 60);
    fTraffic.update(1 / 60);
  }
  const fTaxi = fTraffic.taxi;
  fTaxi.x = fPolice.group.position.x + POLICE_BUST_RANGE + 20;
  fTaxi.z = fPolice.group.position.z;
  fTaxi.boost = true;
  const fdx = fTaxi.x - fPolice.group.position.x;
  const fdz = fTaxi.z - fPolice.group.position.z;
  const farClear = fdx * fdx + fdz * fdz > POLICE_BUST_RANGE * POLICE_BUST_RANGE;
  check('boosting far from the police leaves the run running', farClear && !fFares.state.gameOver);
}

// --- The bust chase --------------------------------------------------------
// On the bust the cruiser breaks off its corridor run and hunts the (now frozen) taxi down. What
// has to hold: it gets there, it gets there inside the cinematic's time budget, and it stays on
// the road grid while doing it — the greedy router turns at junctions, so a bug there sends it
// across a block rather than merely somewhere unhelpful.
{
  // Distance from a point to the nearest road centreline, on whichever axis is closer. A car in
  // its lane sits LANE (2) off; a car cutting a corner is inside the junction box (HALF_ROAD = 4
  // either way). Anything much past 4 means it left the asphalt.
  const offRoad = (x, z) => {
    let dx = Infinity;
    let dz = Infinity;
    for (let k = 0; k <= GRID; k++) {
      dx = Math.min(dx, Math.abs(x - lineCoord(k)));
      dz = Math.min(dz, Math.abs(z - lineCoord(k)));
    }
    return Math.min(dx, dz);
  };

  // Four quarries around the cruiser, spread over the envelope the bust can actually produce:
  // POLICE_BUST_RANGE is 20, one block, so nothing here is further out than that plus the width of
  // the taxi's own road. Offsets are relative to the cruiser's heading — `along` down its road,
  // `across` in whole blocks sideways — and always land on a lane of a real road.
  const cases = [
    { name: 'ahead on the same road', along: 18, across: 0 },
    { name: 'behind it (U-turn)', along: -18, across: 0 },
    { name: 'one road over', along: 0, across: 1 },
    { name: 'one road over and behind', along: -12, across: 1 },
  ];

  let slowest = 0;
  let worstGap = 0;
  let worstOffRoad = 0;
  let worstStep = 0;
  let worstYawRate = 0;
  let failed = null;
  let uturns = 0;
  let peakRoll = 0;
  let noseUp = 0;
  let noseDown = 0;
  let sunk = 0;
  let peakKick = 0;
  // Front wheels. The corridor run is a straight rail, so anything but a flat zero there means
  // the difference is picking up noise; the chase corners, weaves and U-turns, so it has to reach
  // a real lock. `rigLock` reads the angle back off the meshes rather than off the model.
  let corridorLock = 0;
  let chaseLock = 0;
  let rigLock = 0;
  // Only the steered wheels yaw; the light-bar boxes and the body sit at 0.
  const wheelLock = (p) => Math.max(...p.group.children.map((c) => Math.abs(c.rotation.y)));

  for (const kase of cases) {
    const cScene = new THREE.Scene();
    const cPolice = createPolice(makeRng(seed + 66), cScene);
    cPolice.state.cooldown = 0;
    // Run it up to mid-city so there is room on every side for the quarry.
    for (let step = 0; step < 60 * 90; step++) {
      cPolice.update(1 / 60);
      if (cPolice.state.active) corridorLock = Math.max(corridorLock, Math.abs(cPolice.state.wheelAngle));
      if (cPolice.state.active && Math.abs(cPolice.state.s) < PITCH) break;
    }
    if (!cPolice.state.active) { failed = `${kase.name}: no run to chase from`; break; }

    // Place the quarry relative to the cruiser's own heading. Sideways steps go toward the middle
    // of the map so the target road exists whichever line the run happened to pick.
    const inward = cPolice.state.line <= GRID / 2 ? 1 : -1;
    const alongCoord = cPolice.state.s + cPolice.state.dir * kase.along;
    const crossLine = cPolice.state.line + kase.across * inward;
    const crossCoord = lineCoord(crossLine) + LANE;
    const quarry = cPolice.state.axis === 'x'
      ? { x: alongCoord, z: crossCoord }
      : { x: crossCoord, z: alongCoord };

    const before = cPolice.state.dir;
    cPolice.chase(quarry);
    if (!cPolice.state.chasing) { failed = `${kase.name}: chase() did not engage`; break; }
    if (cPolice.state.dir !== before) uturns += 1;
    // Read before the first update: the kick has to be a step in speed on the frame it decides,
    // not something the accel ramp gets to a few frames later.
    peakKick = Math.max(peakKick, cPolice.state.v);

    let t = 0;
    let prev = { x: cPolice.group.position.x, z: cPolice.group.position.z, y: cPolice.group.rotation.y };
    while (!cPolice.state.arrived && t < 10) {
      cPolice.update(1 / 60);
      t += 1 / 60;
      const now = cPolice.group.position;
      worstOffRoad = Math.max(worstOffRoad, offRoad(now.x, now.z));
      // The rail underneath this car turns corners square and flips a whole road width on the
      // U-turn. Only the smoothing keeps that off the screen, so both the step and the yaw rate
      // are watched frame by frame — a snap that reaches the mesh is a visible teleport.
      worstStep = Math.max(worstStep, Math.hypot(now.x - prev.x, now.z - prev.z));
      // Shortest-arc difference: the U-turn sweep ends on uturnYaw0 + π, which can be a whole
      // turn away from the atan2 the next frame produces for the same heading. Identical on
      // screen, so the metric has to see it that way too.
      const raw = cPolice.group.rotation.y - prev.y;
      const dYaw = Math.abs(Math.atan2(Math.sin(raw), Math.cos(raw)));
      worstYawRate = Math.max(worstYawRate, dYaw);
      chaseLock = Math.max(chaseLock, Math.abs(cPolice.state.wheelAngle));
      rigLock = Math.max(rigLock, wheelLock(cPolice));
      prev = { x: now.x, z: now.z, y: cPolice.group.rotation.y };

      // Body: it should lean, rock both ways, and never drop an edge through the tarmac.
      peakRoll = Math.max(peakRoll, Math.abs(cPolice.group.rotation.x));
      noseUp = Math.max(noseUp, cPolice.group.rotation.z);
      noseDown = Math.min(noseDown, cPolice.group.rotation.z);
      if (now.y < ROAD_Y - 1e-6) sunk += 1;
    }
    if (!cPolice.state.arrived) { failed = `${kase.name}: never arrived`; break; }

    slowest = Math.max(slowest, t);
    worstGap = Math.max(worstGap, Math.hypot(
      cPolice.group.position.x - quarry.x, cPolice.group.position.z - quarry.z,
    ));

    if (getPriorityCorridor()) { failed = `${kase.name}: corridor still held after arrival`; break; }
  }

  check('the cruiser runs down the taxi from every side', failed === null, failed ?? '4 approaches');
  // The banner waits for the arrest, but only so long: BUST_BANNER_MAX at BUST_SLOW_MO_MIN works
  // out at ~4.2s of sim time (see main.js). A typical approach is ~2.2s; the worst measured is
  // seed 8888's, where a park closes the only direct road and the legal route runs 68 units.
  check('the chase lands before the banner stops waiting', slowest < 4.1,
    `slowest ${slowest.toFixed(2)}s`);
  check('it pulls up next to the taxi, not on top of it', worstGap > 2 && worstGap < 9,
    `widest final gap ${worstGap.toFixed(2)}`);
  check('the chase never leaves the road grid', worstOffRoad < 4.4,
    `furthest off a centreline ${worstOffRoad.toFixed(2)}`);
  check('a quarry behind the cruiser makes it swing round', uturns >= 1, `${uturns} U-turns`);
  // Both numbers are the caps in police.js showing through: the drawn step is bounded at
  // CHASE_SPEED * 1.2 (0.52 units at 60fps), and easing the nose at YAW_EASE spreads the rail's
  // instant 90° corner over ~0.35s — 13.3°/frame at the sharpest, measured across eight seeds.
  // Unbounded, the corner snap put them at 0.83 units and 79° in a single frame.
  check('the chase never teleports', worstStep < 0.55, `biggest step ${worstStep.toFixed(3)} units`);
  check('the nose never snaps round', worstYawRate < 0.28,
    `fastest yaw ${(worstYawRate * 180 / Math.PI).toFixed(1)}°/frame`);


  // The body language, which is what makes the chase read as aggressive rather than as a fast
  // machine tracking a line. Bounds are the caps in police.js: ROLL_LIMIT, and PITCH_LIMIT plus
  // the kickoff wheelie riding on top of it.
  check('the cruiser leans through what it throws the car at', peakRoll > 0.08 && peakRoll <= 0.34,
    `peak lean ${(peakRoll * 180 / Math.PI).toFixed(1)}°`);
  check('it squats and dives, both', noseUp > 0.02 && noseDown < -0.02,
    `pitch ${(noseDown * 180 / Math.PI).toFixed(1)}°..+${(noseUp * 180 / Math.PI).toFixed(1)}°`);
  check('no tilt puts a corner through the tarmac', sunk === 0, `${sunk} frames below road level`);
  // CHASE_KICK against the corridor cruise of 19: the lock-on is a step in speed, not a ramp.
  check('it plants the throttle on lock-on', peakKick > 24,
    `${peakKick.toFixed(1)} units/s on the deciding frame, up from 19`);

  // The cruiser runs the same steerToward() as every car in traffic.js, so what is checked here is
  // that it is wired to a heading that actually moves — a corridor run alone would pass any
  // implementation, including one that never turned the wheels at all.
  check('the cruiser holds its wheels straight down a corridor', corridorLock < 1e-6,
    `${(corridorLock * 180 / Math.PI).toFixed(1)}° peak on the rail`);
  check('the cruiser steers into the chase', chaseLock > 0.3 && Math.abs(rigLock - chaseLock) < 1e-9,
    `rig ${(rigLock * 180 / Math.PI).toFixed(0)}° vs model ${(chaseLock * 180 / Math.PI).toFixed(0)}°`);
}

// --- The pan gesture, and the opening follow-cam it hands off from ----------
// A run opens with the camera trailing the taxi and stops the moment the player swipes, so the
// whole handover hangs on `attachDragPan` deciding a press *became* a drag — the same 8px boundary
// that decides tap-versus-pan. Both halves are silent when wrong: a slop that fires too eagerly
// takes the camera off the taxi on the finger travel of an ordinary tap, and one that never fires
// leaves the follow towing the map back off wherever the player just swiped to.
//
// This runs on a stub element rather than a DOM, which is enough: attachDragPan only ever calls
// addEventListener, setPointerCapture and clientHeight on it.
{
  const listeners = new Map();
  const el = {
    clientHeight: 800,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  };
  const fire = (type, x, y) => {
    for (const fn of listeners.get(type) ?? []) fn({ isPrimary: true, pointerId: 1, clientX: x, clientY: y });
  };

  const cam = createCityCamera(1.5, { zoom: 52 });
  let released = 0;
  const dragPan = attachDragPan(cam, el, () => 1.5, () => true, () => { released += 1; });

  // A tap with a few pixels of finger travel: still a tap. Nothing moves, and the follow-cam keeps
  // the taxi — this is the case that made a fixed camera necessary in the first place.
  const before = cam.state.target.clone();
  fire('pointerdown', 400, 300);
  fire('pointermove', 402, 301);
  fire('pointermove', 403, 302);
  fire('pointerup', 403, 302);
  check('a tap leaves the camera alone', released === 0 && !dragPan.didPan()
    && cam.state.target.equals(before), `${released} releases`);

  // A real swipe: the map moves and the player owns the framing from here.
  fire('pointerdown', 400, 300);
  fire('pointermove', 430, 340);
  fire('pointermove', 470, 380);
  fire('pointerup', 470, 380);
  check('a swipe hands the camera to the player', released === 1 && dragPan.didPan()
    && !cam.state.target.equals(before), `${released} releases`);
  // Once per gesture, not once per move event — the callback is what a run's opening follow-cam is
  // switched off by, and a second one arriving mid-drag would be a bug hidden by idempotence.
  fire('pointerdown', 400, 300);
  fire('pointermove', 460, 360);
  fire('pointermove', 480, 380);
  fire('pointerup', 480, 380);
  check('each swipe reports once', released === 2, `${released} releases over 2 swipes`);

  // --- The rider pan ---------------------------------------------------------
  // A tap on a rider-finder chip pans the camera to that rider instead of cutting to them. All of
  // this is invisible in a screenshot — a pan and a snap render identically once they've landed —
  // and the failure mode is a curve that technically arrives while reading as a teleport, so the
  // shape of the move is what gets asserted, not just the destination.
  const STEP = 1 / 60;

  // Eased *in*, which is the whole reason this isn't the follow-cams' exponential smoothing: that
  // leaves at full speed on frame one. Over a 40-unit pan the first frame must be a small
  // fraction of the linear step, and the move must still finish on time.
  cam.cancelGlide();
  cam.state.target.set(0, 0, 0);
  cam.glideTo(40, 0);
  const firstFrame = (cam.updateGlide(STEP, 1.5), cam.state.target.x);
  const linearStep = 40 * (STEP / 0.32);   // 40 units is under the floor, so it runs at min time
  check('the rider pan eases in rather than leaving at full speed',
    firstFrame > 0 && firstFrame < linearStep * 0.1,
    `${firstFrame.toFixed(4)} units on frame 1 vs ${linearStep.toFixed(3)} linear`);

  // It arrives exactly and retires itself. Retiring on the clock rather than on the distance left
  // is what keeps the flat tail of the smootherstep — cutting it early throws away the gentlest
  // part of the move, and "close enough" is invisible in the browser.
  let frames = 1;
  while (cam.updateGlide(STEP, 1.5)) frames += 1;
  check('the rider pan lands on its target and retires itself',
    !cam.isGliding() && Math.abs(cam.state.target.x - 40) < 1e-9 && Math.abs(cam.state.target.z) < 1e-9,
    `${frames} frames, landed at x=${cam.state.target.x.toFixed(6)}`);
  check('a short pan runs at the floor, not shorter', frames >= 19 && frames <= 21,
    `${frames} frames = ${(frames * STEP).toFixed(3)}s against a 0.32s floor`);

  // Duration scales with distance between the clamps, and stops scaling at the ceiling. Without
  // the ceiling a cross-town pan is the player watching the camera with a fare's clock draining;
  // without the floor a hop to the next block is a snap again.
  const durationOf = (from, to) => {
    cam.cancelGlide();
    cam.state.target.set(from[0], 0, from[1]);
    cam.glideTo(to[0], to[1]);
    let n = 0;
    while (cam.updateGlide(STEP, 1.5)) n += 1;
    return n * STEP;   // over by up to a frame, since the last step is clamped to the duration
  };
  // 75 units at 150 u/s = 0.5s, clear of both clamps. Laid out across the middle of the map
  // rather than out from the origin, since glideTo clamps its destination to HALF_SPAN = 50.
  const mid = durationOf([-40, 0], [35, 0]);
  // Corner to corner: 141 units, well past the 112 the 0.75s ceiling buys — and the longest pan
  // the map can ask for, since glideTo clamps its destination to HALF_SPAN.
  const far = durationOf([-HALF_SPAN, -HALF_SPAN], [HALF_SPAN, HALF_SPAN]);
  check('pan duration scales with distance', mid >= 0.5 && mid <= 0.5 + 2 * STEP,
    `${mid.toFixed(3)}s for 75 units`);
  check('pan duration is capped', far >= 0.75 && far <= 0.75 + 2 * STEP,
    `${far.toFixed(3)}s across the city diagonal, against a 0.75s ceiling`);

  // The target is clamped like every other camera move, so a pan can't push the map off screen.
  cam.cancelGlide();
  cam.state.target.set(0, 0, 0);
  cam.glideTo(HALF_SPAN * 3, 0);
  while (cam.updateGlide(STEP, 1.5)) { /* run it out */ }
  check('a rider pan clamps to the map like a drag does',
    Math.abs(cam.state.target.x - HALF_SPAN) < 1e-9, `landed at x=${cam.state.target.x.toFixed(2)}`);

  // A finger on the map wins immediately. A tween still writing the target every frame would drag
  // the city back out from under the drag that interrupted it.
  cam.cancelGlide();
  cam.state.target.set(0, 0, 0);
  cam.glideTo(40, 0);
  cam.updateGlide(STEP, 1.5);
  fire('pointerdown', 400, 300);
  fire('pointermove', 440, 350);
  fire('pointerup', 440, 350);
  const afterDrag = cam.state.target.clone();
  const stillPanning = cam.updateGlide(STEP, 1.5);
  check('a drag kills a pan in flight',
    !stillPanning && !cam.isGliding() && cam.state.target.equals(afterDrag),
    stillPanning ? 'the pan kept writing the target' : 'ok');

  // Same for the follow-cams: a boost chase or a wreck focus starting mid-pan takes the camera
  // over, rather than the two easing the target to different places on alternate frames.
  cam.cancelGlide();
  cam.glideTo(-40, 40);
  cam.updateGlide(STEP, 1.5);
  cam.followXZ(0, 0, STEP, 3.2, 1.5);
  check('a follow outranks a pan in flight', !cam.isGliding(), 'the pan survived a followXZ');
  cam.glideTo(-40, 40);
  cam.updateGlide(STEP, 1.5);
  cam.focusOn(0, 0, 30, STEP, 1.5);
  check('a wreck focus outranks a pan in flight', !cam.isGliding(), 'the pan survived a focusOn');

  // Re-basing on a redirect: a second chip tapped mid-flight has to pick up from where the camera
  // actually is, or the pan jumps back to the first tap's start point before setting off again.
  cam.cancelGlide();
  cam.state.target.set(0, 0, 0);
  cam.glideTo(60, 0);
  for (let i = 0; i < 10; i++) cam.updateGlide(STEP, 1.5);
  const midFlight = cam.state.target.x;
  cam.glideTo(0, 60);
  const beforeRedirect = cam.state.target.x;
  cam.updateGlide(STEP, 1.5);
  check('a redirect mid-pan continues from where the camera is',
    midFlight > 0.1 && beforeRedirect === midFlight
    && Math.abs(cam.state.target.x - midFlight) < midFlight * 0.02,
    `redirected from x=${midFlight.toFixed(3)}`);
}

// --- The run summary's stats -----------------------------------------------
// Both numbers are for the retry screen and nothing else, which is exactly why they are checked
// here: nothing in the sim reads them, so a counter that silently stopped incrementing (or one
// that ticked every frame instead of every light) would never show up anywhere but on the card at
// the end of somebody's run.
{
  const rScene = new THREE.Scene();
  const rTraffic = createTraffic(makeRng(seed + 44), rScene, CARS_DEFAULT);
  const rTaxi = rTraffic.taxi;
  rTraffic.warmup(5);

  // Junction crossings, counted independently of the stat: a red is only ever met on the approach
  // to one, so reds can never legitimately outnumber them.
  let crossings = 0;
  let wasTurning = rTaxi.state === 'turn';
  // Frames the taxi spent held at a line — the count a per-frame bug would produce instead.
  let heldFrames = 0;

  for (let step = 0; step < 60 * 150; step++) {
    rTraffic.update(1 / 60);
    const turning = rTaxi.state === 'turn';
    if (turning && !wasTurning) crossings += 1;
    wasTurning = turning;
    if (!turning && rTaxi.v < 0.05) heldFrames += 1;
  }

  const reds = rTraffic.stats.taxiRedLights;
  check('the run counts red lights', reds > 0, `${reds} reds over ${crossings} junctions`);
  check('a red counts once, not once per frame', reds <= crossings && reds < heldFrames,
    `${reds} reds vs ${crossings} junctions and ${heldFrames} held frames`);

  // Cruise is 8.5 and the taxi is not boosting here, so the top speed has to sit at cruise: high
  // enough that it is being sampled at all, and no higher.
  const cruiseTop = rTraffic.stats.taxiTopSpeed;
  check('top speed tracks the taxi at cruise', cruiseTop > 8 && cruiseTop < 9,
    `${cruiseTop.toFixed(2)} units/s = ${speedMph(cruiseTop)} mph`);

  rTaxi.boost = true;
  for (let step = 0; step < 60 * 40; step++) rTraffic.update(1 / 60);
  const boostTop = rTraffic.stats.taxiTopSpeed;
  check('top speed follows Loco Mode up', boostTop > cruiseTop + 6,
    `${cruiseTop.toFixed(1)} -> ${boostTop.toFixed(1)} units/s`);
  // The whole point of the unit is that a player recognises it: city cruise and a fast run, not
  // 8.5 of something. The window covers the mode's own 54mph through the 67mph at the top of the
  // overdrive band, since which of the two a 40s run lands on depends on the straights it found.
  check('top speed reads as a plausible mph', speedMph(boostTop) >= 50 && speedMph(boostTop) <= 75,
    `${speedMph(boostTop)} mph`);
}

// --- Loco Mode's overdrive band ---------------------------------------------
// The mode's ceiling is 22.95 u/s, but holding the button does not buy it: BOOST_ACCEL runs out at
// 18.7 and the last 4.25 u/s arrive at 2.2 u/s², which is 40 units of unbroken straight road. The
// top end is a straightaway you drove rather than a button you held, and both halves of that are
// asserted here — that the band is reachable at all, and that there is no shortcut into it.
// Neither failure has a tell on screen: a taper that got lost, or a straightaway that stopped
// ending at corners, still looks exactly like an ordinary boost.
{
  const oScene = new THREE.Scene();
  const oTraffic = createTraffic(makeRng(seed + 44), oScene, CARS_DEFAULT);
  const oTaxi = oTraffic.taxi;
  oTraffic.warmup(5);
  oTaxi.boost = true;

  const BOOST_TOP = SPEED * 2.2;       // what holding the button is worth on its own
  const OVERDRIVE_TOP = SPEED * 2.7;   // the ceiling, at the far end of a straightaway

  let top = 0;
  let straight = 0;               // distance driven since the last real turn
  let runToNearTop = Infinity;    // shortest straightaway that ever got within 1 u/s of the top
  let runToBoostTop = Infinity;   // ...and the shortest that reached the button's own ceiling

  for (let step = 0; step < 60 * 300; step++) {
    oTraffic.update(1 / 60);
    // Going straight on through a junction runs through the turn state as well, and is still part
    // of the straightaway — only a real turn ends one. See the `car.state === 'turn'` trap.
    if (oTaxi.state === 'turn' && oTaxi.turn?.hand !== 'straight') { straight = 0; continue; }
    straight += oTaxi.v * (1 / 60);
    top = Math.max(top, oTaxi.v);
    if (oTaxi.v > OVERDRIVE_TOP - 1) runToNearTop = Math.min(runToNearTop, straight);
    if (oTaxi.v > BOOST_TOP) runToBoostTop = Math.min(runToBoostTop, straight);
  }

  check('Loco Mode reaches its overdrive ceiling', top > OVERDRIVE_TOP - 0.01,
    `${top.toFixed(2)} of ${OVERDRIVE_TOP.toFixed(2)} units/s`);
  check('and never goes past it', top <= OVERDRIVE_TOP + 1e-6, `${top.toFixed(3)} units/s`);
  // 28.7 units is what the physics says, starting from the 18.9 a corner exit leaves behind.
  // Anything much under that means the taper is gone and the top end has become free.
  check('the top end takes a straightaway to reach', runToNearTop > 25,
    `${runToNearTop.toFixed(1)} units of straight road`);
  // The other half of the deal: the mode itself still lands instantly. Its own ceiling is back
  // within a couple of units of a corner exit, which is where the go-go-go feel lives.
  check('boost speed itself is still instant', runToBoostTop < 5,
    `${runToBoostTop.toFixed(1)} units of straight road`);
}

// --- The Loco Mode meter ----------------------------------------------------
//
// The meter is now an earned resource: it opens at a third, drains only while held, and the sole
// way fuel gets in is a drop-off. A regression here is invisible in a screenshot — a stray refill
// path just makes the game quietly easier — so assert the whole arc as numbers.
{
  const b = createBoost();
  check('the meter opens at a third of a tank',
    Math.abs(b.fraction() - BOOST_START_FRACTION) < 1e-9, `${b.fraction().toFixed(3)}`);

  // Idle for a full tank's worth of seconds with the button untouched. Nothing may move.
  const idleStart = b.fraction();
  for (let i = 0; i < 60 * BOOST_DURATION; i++) b.update(1 / 60);
  check('an idle meter does not regenerate', b.fraction() === idleStart,
    `${idleStart.toFixed(3)} -> ${b.fraction().toFixed(3)}`);

  // Drain it dry: a third of a tank is 5s of boost, plus the BOOST_COOLDOWN momentum tail that
  // running dry earns the same as an on-purpose release, so 7s of holding lands on 'empty' with
  // room to spare.
  b.press();
  for (let i = 0; i < 60 * 7; i++) b.update(1 / 60);
  check('holding drains the tank to empty', b.fraction() === 0 && b.isEmpty(), `mode ${b.state.mode}`);

  // Still held, still empty, and — the point of the change — it stays that way. The old fast
  // recharge would have refilled it inside 15s and re-engaged under the finger.
  for (let i = 0; i < 60 * BOOST_DURATION; i++) b.update(1 / 60);
  check('an empty meter never recharges itself', b.fraction() === 0 && !b.isActive(),
    `mode ${b.state.mode} after ${BOOST_DURATION}s held on empty`);

  // A drop-off is the only way back. It pours in over ~0.7s, and because the button was never
  // released the boost re-engages rather than waiting for a fresh press.
  b.topUp(BOOST_FARE_REWARD);
  b.update(1 / 60);
  check('a drop-off revives an empty meter under a held button', b.isActive() && b.fraction() > 0,
    `mode ${b.state.mode}, ${b.fraction().toFixed(3)}`);

  // Three drop-offs fill it from empty. Release first so the pour isn't racing the drain.
  const c = createBoost(BOOST_DURATION, 0);
  check('a meter can start empty', c.fraction() === 0);
  for (let i = 0; i < 3; i++) c.topUp(BOOST_FARE_REWARD);
  for (let i = 0; i < 60 * 3; i++) c.update(1 / 60);
  check('three drop-offs fill the tank', Math.abs(c.fraction() - 1) < 1e-9, `${c.fraction().toFixed(3)}`);

  // And a fourth cannot overflow it.
  c.topUp(BOOST_FARE_REWARD);
  for (let i = 0; i < 60; i++) c.update(1 / 60);
  check('top-ups clamp at a full tank', c.fraction() === 1, `${c.fraction().toFixed(3)}`);
}

// --- The Punch It pill's fill animation -------------------------------------
//
// The pour is the reward for a drop-off, and all three of its layers are timing — an overshoot
// that never overshoots, or a glow that latches on and never fades, is exactly the kind of thing a
// screenshot can't see. boostmeter.js is pure for this reason: drive it with a real pour and read
// the numbers the CSS variables would have got.
{
  const b = createBoost();
  const m = createBoostMeter();
  const dt = 1 / 60;
  const before = b.fraction();
  b.topUp(BOOST_FARE_REWARD);

  let peak = -1, peakT = 0, t = 0, litFrames = 0, pulseMin = 1, pulseMax = 0;
  let markT = null;         // when the fuel itself finished arriving
  const trace = [];
  for (let i = 0; i < 60 * 3; i++) {
    b.update(dt);
    const pouring = b.state.pending > 0;
    m.update(dt, b.fraction(), pouring);
    t += dt;
    if (!pouring && markT === null) markT = t;
    if (m.state.pct > peak) { peak = m.state.pct; peakT = t; }
    if (m.state.fill > 0) litFrames++;
    if (markT === null && t > 0.2) {          // sample the throb mid-pour, past the attack ramp
      pulseMin = Math.min(pulseMin, m.state.pulse);
      pulseMax = Math.max(pulseMax, m.state.pulse);
    }
    trace.push({ t, pct: m.state.pct, fill: m.state.fill });
  }

  const mark = before + BOOST_FARE_REWARD;
  check('the bar overshoots the fuel it was given', peak > mark + 0.04 && peak < mark + 0.1,
    `${(before * 100).toFixed(0)}% -> ${(mark * 100).toFixed(0)}%, peaked at ${(peak * 100).toFixed(1)}%`);
  check('the overshoot lands just after the fuel does', peakT > markT && peakT < markT + 0.2,
    `fuel done ${markT.toFixed(2)}s, peak ${peakT.toFixed(2)}s`);

  // The bar has to come back to the fuel it actually holds — an overshoot that stuck would be the
  // meter lying about how much boost is in the tank.
  const settled = trace[trace.length - 1];
  check('the bar returns to the real level', Math.abs(settled.pct - b.fraction()) < 1e-9,
    `${(settled.pct * 100).toFixed(1)}% vs ${(b.fraction() * 100).toFixed(1)}% fuel`);

  // ...and it *rings* on the way there rather than easing straight down onto it. Every extremum
  // after the peak, measured against the level the bar ends on: alternating signs, each smaller
  // than the last. An eased fall — the version this replaced — produces none of them, so the
  // count alone is the check that the spring is still a spring.
  const after = trace.filter((s) => s.t > peakT).map((s) => s.pct - settled.pct);
  const swings = [];
  for (let i = 1; i < after.length - 1; i++) {
    if ((after[i] - after[i - 1]) * (after[i + 1] - after[i]) < 0) swings.push(after[i]);
  }
  const alternates = swings.every((v, i) => i === 0 || (v * swings[i - 1] < 0 && Math.abs(v) < Math.abs(swings[i - 1])));
  check('the settle rings instead of easing flat onto the mark',
    swings.length >= 3 && swings[0] < -0.01 && alternates,
    swings.map((v) => `${(v * 100).toFixed(1)}%`).join(' '));

  // The bar climbs the whole way — no stall or step backwards before the peak.
  const climbs = trace.filter((s) => s.t <= peakT).every((s, i, a) => i === 0 || s.pct >= a[i - 1].pct - 1e-9);
  check('the fill never steps backwards on the way up', climbs);

  check('the glow pulses while fuel is arriving', pulseMax - pulseMin > 0.5 && pulseMax <= 1,
    `${pulseMin.toFixed(2)}..${pulseMax.toFixed(2)}`);

  // The glow and the leading edge fade out — and specifically, they outlast the pour (so they're
  // still up while the bar bounces) but are gone well before the next fare could land.
  check('the glow fades out after the bounce', settled.fill === 0 && litFrames * dt > markT,
    `lit for ${(litFrames * dt).toFixed(2)}s, pour took ${markT.toFixed(2)}s`);

  // Nothing may move when no fuel is arriving: a drain has to read 1:1 with the fuel it costs.
  const d = createBoost();
  const dm = createBoostMeter();
  d.press();
  let drainMismatch = 0;
  for (let i = 0; i < 60 * 4; i++) {
    d.update(dt);
    dm.update(dt, d.fraction(), d.state.pending > 0);
    if (Math.abs(dm.state.pct - d.fraction()) > 1e-9 || dm.state.fill !== 0) drainMismatch++;
  }
  check('a drain draws exactly the fuel it has left', drainMismatch === 0, `${drainMismatch} frames off`);
}

// --- Ghost outline ----------------------------------------------------------
//
// The taxi's occluded-only outline (geometry/ghostoutline.js) is a two-pass stencil trick whose
// failure modes are all silent and visual — a wrong depthFunc draws the outline over the visible
// car, a missing mask fills the silhouette instead of tracing it. The material flags ARE the
// behaviour, so assert them here where a regression costs milliseconds, not a screenshot.
{
  const { group } = createTaxiMesh();
  const masks = [];
  const rims = [];
  group.traverse((node) => {
    if (node.name === 'ghostMask') masks.push(node);
    if (node.name === 'ghostRim') rims.push(node);
  });

  // Four parts: shell, roof sign, both steered wheels. Every opaque part of the car must be in
  // the mask — a part left out counts as an occluder of the rim behind it, and the wheels being
  // skipped painted a yellow streak along the rocker panel of a fully visible car.
  check('taxi wears a ghost outline on every opaque part', masks.length === 4 && rims.length === 4,
    `${masks.length} masks, ${rims.length} rims`);

  const rimsHidden = rims.every((r) => r.material.depthFunc === THREE.GreaterDepth
    && r.material.depthWrite === false && r.material.side === THREE.BackSide);
  check('ghost rim draws only where the taxi is hidden', rimsHidden,
    'depthFunc GreaterDepth, no depth write, back faces');

  // The mask stamps the car's footprint into the stencil; the rim tests against it. Break either
  // half of the pairing and the outline turns into a filled ghost.
  const masksStamp = masks.every((m) => m.material.colorWrite === false
    && m.material.depthTest === false && m.material.stencilWrite
    && m.material.stencilZPass === THREE.ReplaceStencilOp);
  const rimsHollow = rims.every((r) => r.material.stencilWrite
    && r.material.stencilFunc === THREE.NotEqualStencilFunc
    && r.material.stencilRef === masks[0]?.material.stencilRef);
  const ordered = masks.every((m) => m.renderOrder === GHOST_MASK_ORDER)
    && rims.every((r) => r.renderOrder === GHOST_RIM_ORDER) && GHOST_MASK_ORDER < GHOST_RIM_ORDER;
  check('ghost outline is hollow — mask stamps before rim tests', masksStamp && rimsHollow && ordered,
    'stencil stamp/test paired, mask ordered first');

  // The rim hull must actually stand off the shell, or the trace has no thickness to show.
  const shellBox = new THREE.Box3().setFromBufferAttribute(masks[0].geometry.attributes.position);
  const rimBox = new THREE.Box3().setFromBufferAttribute(rims[0].geometry.attributes.position);
  const standoff = rimBox.max.x - shellBox.max.x;
  check('ghost rim stands off the shell', standoff > 0.2 && standoff < 0.5,
    `${standoff.toFixed(2)} units`);

  // The stencil trick needs the renderer's stencil buffer, which three has defaulted OFF since
  // r163. Nothing headless can construct a WebGLRenderer, so read the flag out of main.js —
  // without it the stencil test silently passes everywhere and the outline fills in.
  const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  check('renderer keeps its stencil buffer', /stencil:\s*true/.test(mainSource),
    'main.js constructs WebGLRenderer with stencil: true');
}

// --- Screen-space ambient occlusion -------------------------------------------
//
// game/ssao.js plus the patch it hangs on propMaterial(). Every failure mode here is silent: a
// no-op replace leaves the shader unpatched, a missing cache key hands the patched material
// somebody else's compiled program, and a mesh left out of the depth prepass wears the occlusion
// of whatever is standing behind it. None of that logs anything and none of it is obvious in a
// screenshot — it just looks like AO that "isn't doing much".
{
  setAmbientOcclusion(true);
  const aoMaterial = propMaterial();

  // Run the patch against a stub carrying the two chunk names three's Lambert shader actually
  // has. A `.replace()` on a chunk that moved would silently do nothing — the trap CLAUDE.md
  // names outright — and the result is AO that compiles fine and darkens nothing.
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {}',
    fragmentShader: '#include <common>\nvoid main() {\n\t#include <aomap_fragment>\n}',
  };
  aoMaterial.onBeforeCompile(shader, null);

  check('the AO patch reaches the Lambert fragment shader',
    shader.fragmentShader.includes('uniform sampler2D tAmbientOcclusion')
    && shader.fragmentShader.includes('uniform vec2 uAOTexel')
    && /aomap_fragment>[\s\S]*indirectDiffuse \*=/.test(shader.fragmentShader),
    'sampler declared and multiplied in after <aomap_fragment>');

  // Indirect only. Folding AO into the direct term greys off the one lit face per building that
  // golden hour is built around, and the sun's own shadow map already says that part.
  check('AO darkens the indirect term and leaves the sun alone',
    !shader.fragmentShader.includes('reflectedLight.directDiffuse *=')
    && shader.fragmentShader.includes('reflectedLight.indirectDiffuse *='),
    'reflectedLight.directDiffuse untouched');

  // One shared uniform bag, not per-material copies: ssao.js writes the texture once a frame, and
  // if Object.assign handed each shader its own object that write would reach nothing.
  check('every AO material reads the one shared uniform bag',
    shader.uniforms.tAmbientOcclusion === AO_UNIFORMS.tAmbientOcclusion
    && shader.uniforms.uAOTexel === AO_UNIFORMS.uAOTexel,
    'same uniform objects, not clones');

  // The cache key. Without it three keys the program off the material's *parameters*, computed
  // before onBeforeCompile runs, so this patched flat-shaded Lambert collides with every
  // unpatched one in the city and gets handed whichever compiled first.
  const aoKey = typeof aoMaterial.customProgramCacheKey === 'function'
    ? aoMaterial.customProgramCacheKey() : null;
  setAmbientOcclusion(false);
  const plainMaterial = propMaterial();
  const plainKey = typeof plainMaterial.customProgramCacheKey === 'function'
    ? plainMaterial.customProgramCacheKey() : null;
  check('the AO-patched material cannot collide with an unpatched one',
    Boolean(aoKey) && aoKey !== plainKey && plainMaterial.onBeforeCompile !== aoMaterial.onBeforeCompile,
    `patched key "${aoKey}", unpatched "${plainKey}"`);

  // The occluder filter, which is the failure that would actually be visible: the ghost outline's
  // inflated rim hull stamped into the depth prepass draws AO around a silhouette 0.3 units bigger
  // than the car, and `overrideMaterial` strips exactly the flags that would otherwise keep it
  // out. The taxi carries masks, rims and an invisible hit box, so it exercises the whole rule.
  const aoTaxi = createTaxiMesh();
  markOccluder(aoTaxi.group);
  const casting = [];
  const excluded = [];
  aoTaxi.group.traverse((o) => {
    if (o.isMesh) (o.layers.isEnabled(AO_LAYER) ? casting : excluded).push(o);
  });
  const solid = (m) => m.transparent !== true && m.visible !== false && m.colorWrite !== false;
  check('only solid, colour-writing meshes cast AO',
    casting.length > 0 && excluded.length > 0
    && casting.every((o) => solid(o.material)) && excluded.every((o) => !solid(o.material)),
    `${casting.length} casting, ${excluded.length} excluded (rims, masks, hit box)`);

  // The other half of the same rule: anything lit by propMaterial() has to cast as well as
  // receive, or it samples the occlusion of whatever is standing behind it.
  const receivingOnly = excluded.filter((o) => o.material.vertexColors && solid(o.material));
  check('no propMaterial mesh receives AO without casting it', receivingOnly.length === 0,
    'every lit prop mesh on the taxi is in the prepass');

  // The rejection window, recomputed from the camera and the car rather than trusted. Both bounds
  // fall out of VIEW_DIR's elevation, so re-angling the camera fails here rather than in a
  // screenshot nobody takes.
  const elevation = Math.asin(VIEW_DIR.y);
  const groundSwing = 1 / Math.tan(elevation);         // depth a tap crosses on flat road, per unit of radius
  const aoTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), 8);
  const carBox = new THREE.Box3().setFromBufferAttribute(aoTraffic.mesh.geometry.attributes.position);
  const roofJump = (carBox.max.y - carBox.min.y) / Math.sin(elevation);
  check('the AO rejection window clears flat road and still rejects a car roofline',
    MAX_DEPTH_DIFF > groundSwing && RING_BROAD * MAX_DEPTH_DIFF < roofJump,
    `${groundSwing.toFixed(2)} < ${(RING_BROAD * MAX_DEPTH_DIFF).toFixed(2)} < ${roofJump.toFixed(2)}`);

  check('the tight ring sits inside the broad one',
    RING_TIGHT > 0 && RING_TIGHT < RING_BROAD && RING_TIGHT * MAX_DEPTH_DIFF < roofJump,
    `${RING_TIGHT} inside ${RING_BROAD}`);

  // Every render path has to run the pass. A frozen shot that skipped it would composite against
  // whatever the previous frame happened to leave in the AO texture.
  const aoMainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const outsideRenderFrame = aoMainSource.replace(/function renderFrame\(\)[\s\S]*?\n}/, '');
  check('every render goes through the AO pass',
    !/renderer\.render\(scene, camera\)/.test(outsideRenderFrame),
    'main.js renders only via renderFrame()');
}

// --- Nearby-traffic ghost outlines --------------------------------------------
//
// The instanced variant (game/carghosts.js). Same reasoning as the block above — the material
// flags ARE the behaviour and every failure mode is silent — plus two things the taxi's outline
// never had to worry about: which cars get picked, and whether the pool's matrices agree with the
// cars they are supposed to be tracing. A one-frame lag or a transposed wheel index looks like a
// broken outline in a screenshot and like nothing at all anywhere else.
{
  const gScene = new THREE.Scene();
  // Full density, not CARS_DEFAULT's low-density baseline: the whole thing under test is *which*
  // cars get picked out of a crowd, and at 7 cars on a 100-unit map the radius is usually empty.
  const gTraffic = createTraffic(makeRng(seed + 44), gScene, 24);
  const ghosts = createCarGhosts(gScene, gTraffic);
  gTraffic.warmup(30);

  const { bodyMask, wheelMask, bodyRim } = ghosts;
  const perCar = gTraffic.wheelsPerCar;

  check('car ghost pool is sized to the cap',
    bodyMask.instanceMatrix.count === MAX_GHOSTS && bodyRim.instanceMatrix.count === MAX_GHOSTS
    && wheelMask.instanceMatrix.count === MAX_GHOSTS * perCar,
    `${MAX_GHOSTS} bodies, ${MAX_GHOSTS * perCar} wheels`);

  // Three computes an InstancedMesh's bounding sphere once and caches it. Every slot starts
  // collapsed at the origin, so culling against that sphere drops the pool the moment the origin
  // leaves frame — and mask and rim culling *differently* is a filled ghost, not a missing one.
  const pool = [bodyMask, wheelMask, bodyRim];
  check('car ghosts never frustum-cull',
    pool.every((m) => m.frustumCulled === false && !m.castShadow),
    'culling off, no shadows borrowed from the traffic meshes');

  // The load-bearing ordering. The taxi's rim has to resolve before a single traffic mask exists in
  // the stencil buffer, or a car sliding past at a couple of units bites a chunk out of the
  // player's own outline on exactly the frame they need it.
  check('taxi ghost resolves before any traffic mask stamps',
    GHOST_MASK_ORDER < GHOST_RIM_ORDER && GHOST_RIM_ORDER < CAR_GHOST_MASK_ORDER
    && CAR_GHOST_MASK_ORDER < CAR_GHOST_RIM_ORDER
    && bodyMask.renderOrder === CAR_GHOST_MASK_ORDER && wheelMask.renderOrder === CAR_GHOST_MASK_ORDER
    && bodyRim.renderOrder === CAR_GHOST_RIM_ORDER,
    `${GHOST_MASK_ORDER} < ${GHOST_RIM_ORDER} < ${CAR_GHOST_MASK_ORDER} < ${CAR_GHOST_RIM_ORDER}`);

  // Same stencil pairing as the taxi's, and the SAME ref — one ref across every ghost is what stops
  // one traced car's rim painting over another's visible bodywork. Assert it rather than leave it
  // to be "fixed" into per-car refs, which cannot be done without one draw call per ghost.
  const taxiMask = [];
  createTaxiMesh().group.traverse((n) => { if (n.name === 'ghostMask') taxiMask.push(n); });
  const flagsOk = bodyRim.material.depthFunc === THREE.GreaterDepth
    && bodyRim.material.depthWrite === false && bodyRim.material.side === THREE.BackSide
    && bodyRim.material.stencilFunc === THREE.NotEqualStencilFunc
    && [bodyMask, wheelMask].every((m) => m.material.colorWrite === false
      && m.material.depthTest === false && m.material.stencilZPass === THREE.ReplaceStencilOp)
    && [bodyMask, wheelMask, bodyRim].every((m) => m.material.stencilWrite
      && m.material.stencilRef === taxiMask[0].material.stencilRef);
  check('car ghosts share the taxi ghost stencil recipe', flagsOk,
    `ref ${bodyRim.material.stencilRef}, mask stamps / rim tests NotEqual`);

  // The masks must trace the exact silhouette, so they share traffic's own geometries — which also
  // means nothing here may add an attribute to them. Only the rim's private inflated clone carries
  // the per-instance alpha.
  check('car ghost masks share the traffic geometry untouched',
    bodyMask.geometry === gTraffic.mesh.geometry && wheelMask.geometry === gTraffic.wheelMesh.geometry
    && !bodyMask.geometry.attributes.aAlpha && !wheelMask.geometry.attributes.aAlpha
    && bodyRim.geometry !== gTraffic.mesh.geometry && Boolean(bodyRim.geometry.attributes.aAlpha),
    'masks shared, rim cloned and inflated');

  const bodyBox = new THREE.Box3().setFromBufferAttribute(bodyMask.geometry.attributes.position);
  const ghostBox = new THREE.Box3().setFromBufferAttribute(bodyRim.geometry.attributes.position);
  const standoff = ghostBox.max.x - bodyBox.max.x;
  check('car ghost rim stands off the body', standoff > 0.2 && standoff < 0.5,
    `${standoff.toFixed(2)} units`);

  // --- Drive it. Hold the boost until the envelope is at full strength.
  const runFrames = (n) => {
    for (let f = 0; f < n; f++) { gTraffic.update(1 / 60); ghosts.update(1 / 60); }
  };

  check('car ghosts are gone entirely with the boost off',
    ghosts.state.strength === 0 && bodyMask.count === 0 && wheelMask.count === 0
    && bodyRim.count === 0,
    'counts at zero — a mask writes no colour, so fading it is not the same as retiring it');

  gTraffic.taxi.boost = true;
  runFrames(40);

  check('car ghosts fade up while boosting', ghosts.state.strength === 1 && ghosts.state.active > 0,
    `${ghosts.state.active} cars ghosted`);

  // Nearest-first, radius-limited, capped — recomputed by brute force and compared. This is what
  // catches a selection that quietly degrades into "whichever cars the loop reached first".
  const nearest = gTraffic.ambient
    .filter((c) => !c.crashed)
    .map((car) => ({ car, dist: Math.hypot(car.x - gTraffic.taxi.x, car.z - gTraffic.taxi.z) }))
    .filter((e) => e.dist <= GHOST_RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_GHOSTS);
  check('car ghosts pick the nearest traffic, in range and capped',
    ghosts.state.active === nearest.length && ghosts.state.active <= MAX_GHOSTS
    && bodyMask.count === ghosts.state.active && wheelMask.count === ghosts.state.active * perCar,
    `${ghosts.state.active} of ${gTraffic.ambient.length} within ${GHOST_RADIUS}`);

  // Every slot's transform must be the traced car's own, wheels included. Recomposing instead of
  // reading back would drift the bob, the lean, the pitch rock and the wheelie apart from the car;
  // a transposed wheel index (slot*perCar+w against instanceIndex*perCar+w) is invisible until a
  // wheel outline turns up bolted to the wrong car.
  const a = new THREE.Matrix4();
  const b = new THREE.Matrix4();
  let drift = 0;
  for (let slot = 0; slot < ghosts.state.active; slot++) {
    const { car } = nearest[slot];
    gTraffic.mesh.getMatrixAt(car.instanceIndex, a);
    bodyMask.getMatrixAt(slot, b);
    if (!a.equals(b)) drift++;
    bodyRim.getMatrixAt(slot, b);
    if (!a.equals(b)) drift++;
    for (let w = 0; w < perCar; w++) {
      gTraffic.wheelMesh.getMatrixAt(car.instanceIndex * perCar + w, a);
      wheelMask.getMatrixAt(slot * perCar + w, b);
      if (!a.equals(b)) drift++;
    }
  }
  check('every car ghost sits exactly on the car it traces', drift === 0,
    `${drift} matrices adrift across ${ghosts.state.active} cars`);

  // Alpha: the boost envelope times each car's own distance fade, so the farthest ghost — the one
  // the cap would evict next — is already the faintest.
  const live = Array.from(ghosts.alphas.slice(0, ghosts.state.active));
  check('car ghost alpha falls off with distance',
    live.every((v, k) => v > 0 && v <= GHOST_OPACITY + 1e-6 && (k === 0 || v <= live[k - 1] + 1e-6))
    && GHOST_OPACITY < taxiMask[0].parent.children.find((n) => n.name === 'ghostRim').material.opacity,
    `peak ${Math.max(...live).toFixed(2)} under the taxi's 0.85, monotone outward`);

  // A wrecked car leaves the road for good; its ghost must go with it rather than hang over the
  // fireball. wreckShell collapses the instance, so a stale slot would trace a zero-scale car.
  const wrecked = nearest[0]?.car;
  if (wrecked) {
    gTraffic.wreckShell(wrecked);
    runFrames(1);
    gTraffic.mesh.getMatrixAt(wrecked.instanceIndex, a);
    let tracesWreck = false;
    for (let slot = 0; slot < ghosts.state.active; slot++) {
      bodyRim.getMatrixAt(slot, b);
      if (a.equals(b)) tracesWreck = true;
    }
    check('a wrecked car drops its ghost', !tracesWreck && ghosts.state.active > 0,
      `${ghosts.state.active} still ghosted, the wreck not among them`);
  }

  // Release the boost and the whole thing must retire, not merely go transparent.
  gTraffic.taxi.boost = false;
  gTraffic.taxi.crashed = false;   // the wreck above was the other car; keep the taxi driving
  runFrames(40);
  check('car ghosts retire when the boost ends',
    ghosts.state.strength === 0 && ghosts.state.active === 0 && bodyMask.count === 0
    && wheelMask.count === 0 && bodyRim.count === 0,
    'strength 0, all three counts 0');
}

// --- Ghost paints -------------------------------------------------------------
// "Yellow is reserved for the taxi" is a rule palette.js records having already been broken once —
// an amber ambient car was genuinely mistakable for the player's. The ghost rims are the same trap
// one level up: two carBody entries are hue ~41° at low saturation, and they only read as off-white
// because of that saturation. Make the clearance mechanical rather than a comment.
{
  // getHSL defaults to the *working* colour space, which is Linear-sRGB — every lightness below is
  // an sRGB number, and read linearly they all come out far darker than they look. Ask for sRGB
  // explicitly or this block measures a different colour than the eye sees.
  const SRGB = THREE.SRGBColorSpace;
  const ghostHsl = { h: 0, s: 0, l: 0 };
  const bodyHsl = { h: 0, s: 0, l: 0 };
  const taxiHsl = new THREE.Color(PALETTE.taxiGhost).getHSL({ h: 0, s: 0, l: 0 }, SRGB);

  let unlit = 0;
  let clashes = 0;
  for (let k = 0; k < PALETTE.carBody.length; k++) {
    new THREE.Color(PALETTE.carBodyGhost[k]).getHSL(ghostHsl, SRGB);
    new THREE.Color(PALETTE.carBody[k]).getHSL(bodyHsl, SRGB);

    // Every ghost has to read from the shadowed side of a tower, which is the only place it is ever
    // seen. The dark slate is the one this is really about: L 0.32 raw.
    if (ghostHsl.l < 0.55) unlit++;
    // Saturation must not have been pushed up — that is what would drag the two near-neutral creams
    // into taxiGhost's own hue family, where a 2px outline is indistinguishable from the player's.
    if (ghostHsl.s > bodyHsl.s + 0.02) clashes++;
    const dh = Math.abs(ghostHsl.h - taxiHsl.h) * 360;
    if (Math.min(dh, 360 - dh) < 25 && ghostHsl.s > 0.35) clashes++;
  }

  check('every car has a ghost paint', PALETTE.carBodyGhost.length === PALETTE.carBody.length,
    `${PALETTE.carBodyGhost.length} of ${PALETTE.carBody.length}`);
  check('ghost paints read from under a tower', unlit === 0, `${unlit} too dark`);
  check('no ghost paint strays into the taxi\'s yellow', clashes === 0,
    `${clashes} within 25° of taxiGhost, or saturated past its own body colour`);
}

// --- Taxi roof sign -----------------------------------------------------------
// The sign no longer carries the fare's own colour — it just says occupied or not. Assert the
// on/off states directly rather than trusting the toggle by eye.
{
  const { sign, setOccupied } = createTaxiMesh();
  const hex = (c) => new THREE.Color(c).getHexString();
  check('taxi sign starts dark, empty', sign.material.color.getHexString() === hex(PALETTE.taxiTrim));
  setOccupied(true);
  check('taxi sign lights up once a rider boards',
    sign.material.color.getHexString() === hex(PALETTE.taxiSign));
  setOccupied(false);
  check('taxi sign goes dark again once the rider is dropped off',
    sign.material.color.getHexString() === hex(PALETTE.taxiTrim));
}

// Average speed per car over the whole run — a stable throughput number, unlike a snapshot of
// how many cars happen to be moving at the instant the sim stops.
const throughput = stats.distance / stats.time / traffic.cars.length;
console.log(`\nthroughput: ${throughput.toFixed(2)} avg units/s per car`);

const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

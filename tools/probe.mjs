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
import { createGround } from '../src/city/ground.js';
import { createBuildings } from '../src/city/buildings.js';
import { createProps } from '../src/city/props.js';
import { createTraffic, lightPhase, displayPhase, setPriorityJunction, getPriorityCorridor, isUnsignalised, ringAxisAt, placeCar, approachRoom, ROAD_Y, wheelAnchors, WHEEL_R, STEER_MAX, speedMph } from '../src/sim/traffic.js';
import { createCollisions } from '../src/sim/collisions.js';
import { createPolice, POLICE_BUST_RANGE } from '../src/sim/police.js';
import {
  createFareSystem, cornerFor, blockDistance, priceFor, MAX_FARES, SECOND_FARE_AFTER,
} from '../src/game/fares.js';
import { createDestinationPin } from '../src/geometry/marker.js';
import { createTaxiMesh } from '../src/geometry/taxi.js';
import { GHOST_MASK_ORDER, GHOST_RIM_ORDER } from '../src/geometry/ghostoutline.js';
import { createCityCamera, attachDragPan } from '../src/game/camera.js';
import { URGENCY_SEGMENTS, urgencyLevel, urgencyColor } from '../src/game/urgency.js';
import { DISTANCE_TIERS, distanceTier } from '../src/game/triptier.js';
import { planOrigin } from '../src/game/route.js';
import { HALF_SPAN, ROAD_W, LANE, PITCH, lineCoord, GRID, isXAxis, leftOf, opposite, dirSign, legalExits } from '../src/city/grid.js';
import { cityNetwork } from '../src/city/roadnet.js';
import { routePath } from '../src/game/routeline.js';
import { findRoute, allIntersections } from '../src/game/route.js';
import { PALETTE } from '../src/palette.js';
import { createVanish } from '../src/game/vanish.js';

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

// Read a meter's bars back the way a player does — by counting lit segments, not by trusting the
// argument we passed in. "Lit" is any colour other than the shared unfilled grey.
const EMPTY_HEX = PALETTE.meterEmpty.replace('#', '').toLowerCase();
const lit = (bar) => bar.filter((m) => m.material.color.getHexString() !== EMPTY_HEX).length;
const litUrgency = (meter) => lit(meter.bars.urgency);
const litDistance = (meter) => lit(meter.bars.distance);

const scene = new THREE.Scene();

const layout = time('layout', () => createLayout(makeRng(seed)));
const ground = time('ground', () => createGround(makeRng(seed + 11), layout));
const buildings = time('buildings', () => createBuildings(makeRng(seed + 22), layout));
const props = time('props', () => createProps(makeRng(seed + 33), layout));
const traffic = time('traffic init', () => createTraffic(makeRng(seed + 44), scene, 24));

const tris = (mesh) => mesh.geometry.attributes.position.count / 3;
console.log(`  triangles: ground ${tris(ground)}, buildings ${tris(buildings.mesh)}, props ${tris(props)}`);

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

// --- The fare's travelling timer -------------------------------------------
// The clock belongs to the fare, not to a marker: it waits with the rider and then flies to the
// taxi at pickup. None of that is checkable from a still image, and a silent failure would leave
// the player with a timer stuck at an empty kerb. The kerb half of the clock is the meter's
// urgency bar now, so the ring must stay *off* the map until the rider is aboard — and then it has
// to launch from the corner they were standing on, or the hand-off reads as a ring teleporting in.
{
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 44), fScene, 24);
  const fares = createFareSystem(makeRng(seed + 55), fScene);
  fTraffic.warmup(5);

  let ring = null;
  let ringHiddenWhileWaiting = false;
  let launchedFromKerb = false;
  let transferred = false;
  let followsTaxi = false;
  let hiddenAfter = false;
  let kerbAtSpawn = null;
  let elapsed = 0;

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
      if (type === 'spawned' && !ring) {
        // Follow the first fare all the way through; a later one appearing mid-ride is a
        // different assertion, made further down.
        ring = fare.slot.timer.mesh;
        // The rider's own clock is the meter over their head; no ring on the kerb.
        ringHiddenWhileWaiting = !ring.visible;
        kerbAtSpawn = cornerFor(fare.target.i, fare.target.j);
        route(fare);
      }
      if (type === 'pickup' && fare.slot.timer.mesh === ring) {
        transferred = fare.slot.timer.isTransferring();
        // Launched from the corner the rider was standing on, not from wherever the ring last was.
        launchedFromKerb = ring.visible
          && Math.hypot(ring.position.x - kerbAtSpawn.x, ring.position.z - kerbAtSpawn.z) < 0.01;
        route(fare);
      }
      // The run may end on the timer rather than a delivery; the ring must be cleared either way.
      if ((type === 'delivered' || type === 'failed') && fare.slot.timer.mesh === ring) {
        hiddenAfter = !ring.visible;
        done = true;
      }
    }
    if (done) break;

    const carried = fares.carrying();
    if (transferred && carried && !carried.slot.timer.isTransferring() && !followsTaxi) {
      followsTaxi = Math.hypot(ring.position.x - fTraffic.taxi.x, ring.position.z - fTraffic.taxi.z) < 0.05;
    }
  }

  check('no ring stands on the kerb while the rider waits', ringHiddenWhileWaiting);
  check('the ring takes the clock over from the rider\'s corner', launchedFromKerb);
  check('the timer flies to the taxi at pickup', transferred);
  check('the timer then rides with the taxi', followsTaxi);
  check('the timer clears on delivery', hiddenAfter);

  // Colour has to carry the urgency on its own — drain it and read the hue back.
  // The ring is hidden after a delivery and update() no-ops while hidden, so show it first.
  const probeRing = fares.slots[0].timer;
  probeRing.mesh.visible = true;
  const hues = [1, 0.75, 0.5, 0.25, 0.05].map((f) => {
    probeRing.update(0.016, { x: 0, z: 0 }, f);
    return probeRing.mesh.material.color.getHexString();
  });
  const [full, , mid, , low] = hues;
  const green = (h) => parseInt(h.slice(2, 4), 16) > parseInt(h.slice(0, 2), 16);
  const red = (h) => parseInt(h.slice(0, 2), 16) > parseInt(h.slice(2, 4), 16) * 1.4;
  check('the timer ramps green to red as it drains', green(full) && !green(mid) && red(low),
    hues.join(' -> '));
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
        if (fares.state.delivered < SECOND_FARE_AFTER) extrasBeforeDelivery = true;
        spawnedWhileBusy += 1;
        // The stagger is what turns this into a prioritisation puzzle — every extra rider must
        // arrive at least SPAWN_MIN_GAP after the previous one, not in the same burst.
        minSpawnGap = Math.min(minSpawnGap, elapsed - prevSpawnAt);
      } else {
        spawnedIdle += 1;
      }
      prevSpawnAt = elapsed;
    }

    // Sampled here, before aim() can direct anything: at this point every waiting fare's meter has
    // just been ticked against the `directed` it had going into the frame, so the ring and the flag
    // must agree exactly. Doing it after aim() would flag the one-frame lag as a bug.
    for (const f of fares.state.fares) {
      if (f.stage !== 'waiting') continue;
      if (f.slot.meter.isSelected() !== f.directed) selectionOutOfStep += 1;
    }

    aim();
    elapsed += 1 / 60;

    mostAtOnce = Math.max(mostAtOnce, fares.state.fares.length);
    mostWaiting = Math.max(mostWaiting, fares.state.fares.filter((f) => f.stage === 'waiting').length);
  }

  check('the board can fill past two fares', mostAtOnce >= 2,
    `peak ${mostAtOnce}, ${fares.state.delivered} delivered`);
  check('never more than MAX_FARES', mostAtOnce <= MAX_FARES);
  check('the extra fares only arrive after the tutorial delivery',
    !extrasBeforeDelivery && spawnedWhileBusy > 0,
    `${spawnedWhileBusy} extras, ${spawnedIdle} on an empty board`);
  // Two waiting riders is the whole point of the change — a single-choice board would leave
  // "prioritise which one to grab" as words in the docs and nothing in the game.
  check('more than one rider can wait on the kerb at once', mostWaiting >= 2,
    `peak ${mostWaiting}`);
  // The stagger is the fairness guarantee: extras land at least SPAWN_MIN_GAP apart, so their
  // clocks drain out of phase instead of ending on the same tick.
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

// --- The trip is public from the moment the rider is --------------------------
// The meter over the rider's head is the whole basis of "is this a short hop or a haul across
// town?", and the drop-off it describes stays hidden until pickup. Every failure mode is silent: a
// meter that never appears, a tier that disagrees with the route, a drop-off pin leaking onto the
// map early, or one that quietly moves between being drawn and being shown.
{
  const tScene = new THREE.Scene();
  const tTraffic = createTraffic(makeRng(seed + 44), tScene, CARS_DEFAULT);
  const fares = createFareSystem(makeRng(seed + 55), tScene);
  tTraffic.warmup(5);

  let shownOnSpawn = 0;
  let missingPin = 0;
  let wrongCount = 0;
  let wrongPrice = 0;
  let movedAtPickup = 0;
  let leakedPin = 0;
  let pinHiddenAtPickup = 0;
  let selectionOutOfStep = 0;
  let pickups = 0;
  let stillMetered = 0;
  let wrongTier = 0;
  let sharedColour = 0;
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
        if (!fare.slot.meter.group.visible) missingPin += 1;
        if (fare.slot.destination.group.visible) leakedPin += 1;
        // The meter is the only thing saying how far this rider is going, so the tier it lights
        // has to be the tier their actual trip falls in.
        if (litDistance(fare.slot.meter) !== distanceTier(fare.blocks)) wrongTier += 1;
        if (fare.blocks !== blockDistance(fare.pickup, fare.dropoff)) wrongCount += 1;
        if (fare.value !== priceFor(fare.pickup, fare.dropoff)) wrongPrice += 1;
      }
      if (type === 'pickup') {
        pickups += 1;
        // The pin is promoted, not replanted — a drop-off that jumped at pickup would make the
        // preview a lie and every judgement made from it worthless.
        if (fare.target.i !== fare.dropoff.i || fare.target.j !== fare.dropoff.j) movedAtPickup += 1;
        if (fare.slot.meter.group.visible) stillMetered += 1;
        if (!fare.slot.destination.group.visible) pinHiddenAtPickup += 1;
      }
    }

    // Sampled here, before aim() can direct anything: at this point every waiting fare's meter has
    // just been ticked against the `directed` it had going into the frame, so the ring and the flag
    // must agree exactly. Doing it after aim() would flag the one-frame lag as a bug.
    for (const f of fares.state.fares) {
      if (f.stage !== 'waiting') continue;
      if (f.slot.meter.isSelected() !== f.directed) selectionOutOfStep += 1;
    }

    aim();
    elapsed += 1 / 60;

    // Colour is assigned when the trip is drawn, so no two live fares may wear the same one — a
    // carried fare must never match the one the board is about to hand over to.
    const live = fares.state.fares;
    const colours = new Set(live.map((f) => f.color));
    if (colours.size !== live.length) sharedColour += 1;
    // No two fares may claim the same junction at either end, even while the far ends are hidden:
    // a rider spawning on another fare's drop-off ends up sharing a kerb corner once it appears.
    // A riding fare's `target` *is* its drop-off, so it contributes one junction, not two.
    const ends = live.flatMap((f) => (f.stage === 'waiting'
      ? [`${f.target.i},${f.target.j}`, `${f.dropoff.i},${f.dropoff.j}`]
      : [`${f.target.i},${f.target.j}`]));
    if (new Set(ends).size !== ends.length) sharedJunction += 1;
  }

  check('a waiting rider shows their meter', shownOnSpawn > 0 && missingPin === 0,
    `${shownOnSpawn} spawns, ${missingPin} missing`);
  check('the block count matches the trip', wrongCount === 0, `${wrongCount} mismatched`);
  check('the distance bar lights the trip\'s tier', wrongTier === 0, `${wrongTier} mistiered`);
  check('the price agrees with the advertised distance', wrongPrice === 0, `${wrongPrice} mispriced`);
  check('the drop-off stays hidden while the rider waits', leakedPin === 0, `${leakedPin} leaked`);
  check('the drop-off appears at pickup', pickups > 0 && pinHiddenAtPickup === 0,
    `${pickups} pickups, ${pinHiddenAtPickup} still hidden`);
  check('the drop-off lands where it was drawn at spawn', movedAtPickup === 0,
    `${movedAtPickup} moved`);
  check('the meter clears at pickup', stillMetered === 0, `${stillMetered} left up`);
  // The yellow ring around the plate is the only thing saying "the taxi is on its way to this
  // one", which matters most on a board with two riders waiting.
  check('the selection ring tracks whether the taxi was sent', selectionOutOfStep === 0,
    `${selectionOutOfStep} frames out of step`);
  // --- The pin's colour.
  //
  // One state, read off the materials rather than assumed: the taxi's yellow on the head, and
  // specifically the route band's own yellow on the tarmac — the band and the disc it ends in are
  // one mark of paint, not two that happen to be near each other. The emissive has to carry the
  // same colour or the pin lights in a hue nothing else on screen is wearing.
  {
    const pin = createDestinationPin();
    const hex = (c) => new THREE.Color(c).getHexString();
    const painted = [
      pin.head.material.color.getHexString(),
      pin.head.material.emissive.getHexString(),
      pin.ring.group.children.map((m) => m.material.color.getHexString()).join('/'),
    ].join(' ');
    check('the drop-off pin is the taxi\'s yellow, and its ring the route band\'s',
      painted === `${hex(PALETTE.destination)} ${hex(PALETTE.destination)} `
        + `${hex(PALETTE.routeLine)}/${hex(PALETTE.routeLine)}`, painted);
  }
  check('no two live fares share a colour', sharedColour === 0, `${sharedColour} frames`);
  check('no two fares claim the same junction', sharedJunction === 0, `${sharedJunction} frames`);

  // --- The urgency bar drains.
  //
  // This is the whole point of the bar and none of it is visible in a still image: the level has to
  // fall one segment at a time as the clock runs down, never climb, and the colour has to be the
  // one that level owns. Drive a fare's clock by hand and read the bar back segment by segment.
  {
    const meter = fares.slots[0].meter;
    const seen = [];
    const wrongColour = [];
    for (let step = 0; step <= 20; step++) {
      const fraction = 1 - step / 20;
      const level = urgencyLevel(fraction);
      meter.show(level, 1);
      seen.push(litUrgency(meter));
      const want = urgencyColor(level).getHexString();
      const got = meter.bars.urgency[0].material.color.getHexString();
      // Segment 1 is lit at every level above zero, so its colour is the level's colour.
      if (level > 0 && got !== want) wrongColour.push(`${level}: ${got} != ${want}`);
    }
    const monotonic = seen.every((v, i) => i === 0 || v <= seen[i - 1]);
    check('the urgency bar drains from full to empty',
      seen[0] === URGENCY_SEGMENTS && seen.at(-1) === 0 && monotonic, seen.join(''));
    check('it sheds one segment at a time',
      new Set(seen).size === URGENCY_SEGMENTS + 1
      && seen.every((v, i) => i === 0 || seen[i - 1] - v <= 1), `${new Set(seen).size} distinct`);
    check('each level wears its own colour', wrongColour.length === 0, wrongColour.join('; '));
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
// The player taps riders on the kerb and nothing else — no drop-off pin is ever tapped in this
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
  // 8.5 of something.
  check('top speed reads as a plausible mph', speedMph(boostTop) >= 45 && speedMph(boostTop) <= 60,
    `${speedMph(boostTop)} mph`);
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

// Average speed per car over the whole run — a stable throughput number, unlike a snapshot of
// how many cars happen to be moving at the instant the sim stops.
const throughput = stats.distance / stats.time / traffic.cars.length;
console.log(`\nthroughput: ${throughput.toFixed(2)} avg units/s per car`);

const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

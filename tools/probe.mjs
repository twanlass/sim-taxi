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
import { createTraffic, lightPhase, displayPhase, setPriorityJunction, getPriorityCorridor, isUnsignalised, ringAxisAt, placeCar, approachRoom, setClosedLanes, isLaneClosed, ROAD_Y, HOP_LEN, STOP_SETBACK, wheelAnchors, WHEEL_R, STEER_MAX, SPEED, CAR_LEN, CAR_W, landingBounce, BOUNCE_DUR } from '../src/sim/traffic.js';
import { createRoadwork, BARRIER_S, CONE_ROW } from '../src/game/roadwork.js';
import { createDust } from '../src/game/dust.js';
import { barricadeParts, spoilParts, RAMP_RUN, RAMP_H, WORKS_Y, TRENCH_Y, SPLINTER_REST_Y } from '../src/geometry/roadworks.js';
import { findRoute as planRoute, setRoadworkLanes, laneCost } from '../src/game/route.js';
import { createCollisions } from '../src/sim/collisions.js';
import { createPolice, POLICE_BUST_RANGE, BUST_ARM_INSET } from '../src/sim/police.js';
import {
  createFareSystem, cornerFor, blockDistance, priceFor, MAX_FARES,
} from '../src/game/fares.js';
import * as difficulty from '../src/game/difficulty.js';
import { createDestinationPin } from '../src/geometry/marker.js';
import { bounceOffset, KICK_SCALE, KICK_HOP, RIM_SCALE } from '../src/geometry/diamond.js';
import { createTaxiMesh } from '../src/geometry/taxi.js';
import { createPlaneMesh, PLANE_SPAN, PLANE_UNDERSIDE } from '../src/geometry/plane.js';
import { createFlyover, trailRoll, heading, PROP_SPIN } from '../src/game/flyover.js';
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
import { HALF_SPAN, ROAD_W, LANE, PITCH, lineCoord, GRID, isXAxis, leftOf, rightOf, opposite, dirSign, legalExits } from '../src/city/grid.js';
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
// The disc under the rider's feet, rim and fill and sweep — one mark at three weights, so they
// must never disagree with each other or with the crystal overhead.
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
  const rimWeights = new Set();
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

    for (const f of fares.state.fares) {
      // The liquid level *is* the seconds, on both legs — a crystal that drifts from the clock it
      // draws is worse than one that never drained, because it reads as precision and isn't. A
      // VIP's crystal is the one exception: it never drains at all, by design (faremarker.js).
      const want = f.vip ? 1 : Math.max(0, Math.min(1, f.timeLeft / f.limit));
      if (Math.abs(f.slot.marker.getFill() - want) > 1e-6) fillOutOfStep += 1;
      // One outline weight, whatever the fare is doing — waiting, directed at, or riding. It was
      // two for a while (a heavier rim inked the rider the taxi had been sent at), and the change
      // of weight at the hand-off read as the marker becoming a different object mid-trip.
      rimWeights.add(f.slot.marker.rim.scale.x.toFixed(4));
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
  // Which rider the car is on its way to is the route band's job. The diamond's outline says
  // nothing about it and never changes weight — on the kerb, once directed at, or over the taxi.
  check('the diamond wears one outline weight for its whole life',
    rimWeights.size === 1 && rimWeights.has(RIM_SCALE.toFixed(4)),
    [...rimWeights].join(', '));
  // --- The drop-off is a ring and nothing else.
  //
  // Read off the built marker rather than assumed. The head that used to float over it is gone, so
  // the assertion is as much about what is *not* there: anything standing on the corner would be a
  // second silhouette competing with the rider's diamond, which is the whole reason it went.
  {
    const pin = createDestinationPin();
    const hex = (c) => new THREE.Color(c).getHexString();
    const painted = pin.ring.group.children.map((m) => m.material.color.getHexString()).join('/');
    check('the drop-off ring is teal, rim and fill and sweep',
      painted === `${hex(PALETTE.destination)}/${hex(PALETTE.destination)}/${hex(PALETTE.destination)}`,
      painted);
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

    // The rim must stay black at the one weight it has: it was yellow once, and yellow is a colour
    // this very crystal wears for a quarter of every clock, so a yellow rim on a yellow diamond is
    // no rim at all. The weight itself is asserted across a played run above.
    const hull = diamond.rim;
    check('the diamond wears a black rim at RIM_SCALE',
      hull.material.color.getHexString() === '000000'
      && Math.abs(hull.scale.x - RIM_SCALE) < 1e-9,
      `${hull.material.color.getHexString()}@${hull.scale.x.toFixed(4)}`);

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

  // 3. A junction the taxi genuinely cannot enter — the lane it would land in is full.
  //
  // Two cars and an immovable blocker parked on the landing point, so nothing else can be the
  // reason the taxi does or doesn't stop. The same scenario is run twice, because boosting and not
  // boosting are supposed to give opposite answers.
  //
  // **Boosting: it does not stop.** Loco Mode's premise is that nothing halts the taxi, and the
  // consequence is the wreck — collisions.js is armed for exactly as long as `taxi.boost` is true,
  // so a junction with something in it costs the run rather than costing a wait. The taxi used to
  // be held at the line by the ambient don't-block-the-box rule instead, which is a politeness a
  // car being driven like this has no business observing.
  //
  // **Not boosting: it brakes into the hold.** The exit-lane and left-yield tests used to be asked
  // only on arrival, and the only way to obey one there is to pin `s` to the hold line — which
  // stops the car without touching `car.v`. That left a car sat at the line with its wheels
  // turning, no nose dip, and the weave (paced off `v · dt`) still sliding it sideways.
  // A *left* rather than a straight-through, which the junction search above already guarantees is
  // legal here. It has to be a turn: on a straight-through the blocker sits in the approach lane's
  // own straight-on chain, so `ahead()` hands it over as an ordinary leader and the car brakes for
  // it whatever the entry tests do. Round a corner nothing sees it until the exit test, which is
  // exactly the case that used to freeze.
  const roads = cityNetwork();
  const exitDir = leftOf(dIn);
  const inLane = roads.laneByGrid(dIn, jI, jJ);
  const exitTurn = inLane.exits.map((id) => roads.turnById.get(id))
    .find((turn) => roads.dirOfLane(roads.laneById.get(turn.outLane)) === exitDir);
  const exitLane = exitTurn && roads.laneById.get(exitTurn.outLane);
  const exitNode = exitLane && roads.nodeById.get(exitLane.to);

  /**
   * Drive the staged approach into the full exit lane and report what the taxi did.
   * `frozenFast` is the fastest it ever claimed to be going on a frame it did not actually move.
   */
  const runBlockedJunction = (boosting) => {
    const scene = new THREE.Scene();
    const traffic = createTraffic(makeRng(seed + 131), scene, 2);
    const [car, blocker] = traffic.cars;
    // 30 units back is one junction further out than (jI, jJ) — `placeCar` walks back along the
    // straight-through chain — so the route has to carry straight on through that one first.
    place(car, dIn, 30);
    car.route = [dIn, exitDir];
    car.routeConsumed = false;
    car.boost = boosting;
    // `back` of the whole lane length puts the blocker at s = 0, which *is* the point the taxi
    // lands on. Parked with an empty route holds it there — `allowed = 0` in traffic.js.
    placeCar(blocker, exitDir, exitNode.gi, exitNode.gj, exitLane.length);
    blocker.route = [];
    blocker.parked = true;

    const collisions = createCollisions(traffic.cars, car);
    let wrecked = false;
    collisions.onImpact(() => { wrecked = true; });

    let frozenFast = 0;
    let slid = 0;
    let rest = Infinity;
    let entered = false;
    let prevS = car.s;
    let prevLateral = car.lateral;
    for (let f = 0; f < 60 * 5 && !wrecked; f++) {
      traffic.update(1 / 60);
      car.boost = boosting;
      collisions.update();
      if (car.state === 'turn' && car.i === jI && car.j === jJ) entered = true;
      if (car.state === 'drive') {
        if (Math.abs(car.s - prevS) < 1e-9) {
          frozenFast = Math.max(frozenFast, car.v);
          slid = Math.max(slid, Math.abs(car.lateral - prevLateral));
          rest = Math.min(rest, car.v);
        }
        prevS = car.s;
      }
      prevLateral = car.lateral;
    }
    return { frozenFast, slid, rest, entered, wrecked };
  };

  const loco = runBlockedJunction(true);
  check('Loco Mode drives into a junction it cannot enter and wrecks, rather than waiting',
    dIn >= 0 && Boolean(exitLane) && loco.entered && loco.wrecked && loco.rest === Infinity,
    `entered=${loco.entered} wrecked=${loco.wrecked}, `
    + `${loco.rest === Infinity ? 'never stopped' : 'held at the line'}`);

  // Ambient traffic still yields — and still has to *brake* for it rather than arrive and freeze.
  //
  // The car that shows this is one **fleeing the boosting taxi**. Scatter lifts a car's ceiling to
  // 2.0x cruise (17 u/s) and the taxi's priority hold hands it the green, so it reaches the line
  // fast and with nothing else slowing it — and a lane is 12 units with the hold line 3.4 back, so
  // it has 8.6 units of warning against the 13.1 it needs to stop from there. Before the exit-lane
  // test was asked on approach that was a car pinned to the line still reading 17 u/s.
  //
  // Routed rather than rolled, so the exit it takes is the blocked one every time.
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 149), fScene, 3);
  const [fTaxi, flee, fBlocker] = fTraffic.cars;
  place(fTaxi, dIn, 30);
  fTaxi.boost = true;
  place(flee, dIn, 12);
  flee.route = [exitDir];
  flee.routeConsumed = false;
  placeCar(fBlocker, exitDir, exitNode.gi, exitNode.gj, exitLane.length);
  fBlocker.route = [];
  fBlocker.parked = true;

  let fleeFrozen = 0;
  let fleeSlid = 0;
  let fleeRest = Infinity;
  let fleeTop = 0;
  let fPrevS = flee.s;
  let fPrevLateral = flee.lateral;
  for (let f = 0; f < 60 * 4; f++) {
    fTraffic.update(1 / 60);
    fTaxi.boost = true;
    if (flee.state === 'drive') {
      fleeTop = Math.max(fleeTop, flee.v);
      if (Math.abs(flee.s - fPrevS) < 1e-9) {
        fleeFrozen = Math.max(fleeFrozen, flee.v);
        fleeSlid = Math.max(fleeSlid, Math.abs(flee.lateral - fPrevLateral));
        fleeRest = Math.min(fleeRest, flee.v);
      }
      fPrevS = flee.s;
    }
    fPrevLateral = flee.lateral;
  }
  // `fleeRest` reaching 0 is what proves the hold actually happened — without one there are no
  // stationary frames and the other two numbers keep their initial values. `fleeTop` proves the
  // car was genuinely travelling before it got there, so a pass can't come from a car that
  // crawled up to the line.
  check('a car held at the line brakes into it rather than freezing at speed',
    dIn >= 0 && Boolean(exitLane) && fleeTop > 10 && fleeRest < 0.01 && fleeFrozen < 0.5
      && fleeSlid < 0.002,
    `peaked at ${fleeTop.toFixed(1)} u/s, stationary at up to ${fleeFrozen.toFixed(2)} u/s, `
    + `weave slid ${fleeSlid.toFixed(4)}/frame`);

  // 4. Overtaking. A boosting taxi with a slower car in front, on a route that carries straight
  // on, pulls a full lane into the *oncoming* side, goes past, and comes back.
  //
  // The invariant that matters most is the one the abandoned version of this failed: the taxi must
  // never sit on the road centreline. At LANE (2) off its own lane it is 2 from the car it is
  // passing and 2 from anything coming the other way, both inside collisions.js's 2.31-unit
  // envelope — which is what made the old overtake "a lottery over which car you died on". The
  // whole lane is the safe place to be; the centreline is somewhere to pass *through*. Asserted
  // here as clearance from the car being overtaken, which is the direct form of it.
  let pI = -1; let pJ = -1; let pD = -1;
  outerPass: for (let i = 1; i < GRID; i++) {
    for (let j = 1; j < GRID; j++) {
      if (ringAxisAt(i, j)) continue;
      for (const d of [0, 1, 2, 3]) {
        // Straight on out of this junction, and straight on out of the next, so the pass has road.
        if (!legalExits(d, i, j).includes(d)) continue;
        if (approachRoom(d, i, j) < 30) continue;
        pI = i; pJ = j; pD = d;
        break outerPass;
      }
    }
  }

  /** Drive a two-car overtake and report what the taxi managed. `held` is the button. */
  const runOvertake = (held, route, opts = {}) => {
    const scene = new THREE.Scene();
    const traffic = createTraffic(makeRng(seed + 167), scene, opts.oncoming ? 3 : 2);
    const [car, lead, onc] = traffic.cars;
    placeCar(car, pD, pI, pJ, 26); car.parked = false;
    placeCar(lead, pD, pI, pJ, 14); lead.parked = false;
    car.route = route; car.routeConsumed = false;
    // Straight by default so it stays in front rather than rolling a random turn-off.
    lead.route = opts.leadRoute ?? [pD, pD, pD]; lead.routeConsumed = false;
    if (opts.oncoming) {
      // The other half of this road, coming the other way, and *far enough up it to still be
      // there*. The two close on each other at 18.7 + 8.5 = 27 u/s, so a car staged level with
      // the junction ahead has gone by before the taxi has even closed on its leader — the first
      // attempt at this staged one 5.7 units ahead, watched it pass, and then reported a clear
      // road, correctly. A lane further back along its own chain leaves it in sight at the moment
      // the decision is actually taken.
      const back = roads.nodeById.get(car.lane.from);
      const facing = roads.laneByGrid(opposite(pD), back.gi, back.gj);
      placeCar(onc, opposite(pD), back.gi, back.gj, facing.length + PITCH);
      onc.route = []; onc.parked = false;
    }
    let peak = 0;
    let closest = Infinity;
    let got = false;
    let leadTurned = false;
    let outWhileLeadTurning = 0;   // how far out the taxi got while the lead was mid-junction
    for (let f = 0; f < 60 * 6; f++) {
      car.boost = held;
      car.boostEasing = false;
      traffic.update(1 / 60);
      peak = Math.max(peak, car.pass);
      if (lead.state === 'turn' && !lead.crashed) {
        leadTurned = true;
        outWhileLeadTurning = Math.max(outWhileLeadTurning, car.pass);
      }
      if (!lead.crashed) {
        closest = Math.min(closest, Math.hypot(car.x - lead.x, car.z - lead.z));
        const sgn = dirSign(car.d);
        const rel = isXAxis(car.d) ? (lead.x - car.x) * sgn : (lead.z - car.z) * sgn;
        if (rel < -CAR_LEN) got = true;
      }
    }
    return { peak, closest, got, leadTurned, outWhileLeadTurning };
  };

  const over = runOvertake(true, [pD, pD, pD]);
  check('Loco Mode overtakes a slower car by taking the oncoming lane',
    pD >= 0 && over.peak > 0.95 && over.got,
    `reached ${(over.peak * 2 * LANE).toFixed(2)} of ${2 * LANE} units across, got by=${over.got}`);

  // 2.31 is the collision envelope in sim/collisions.js — CAR_W * 0.68, doubled. Clearing it by a
  // margin is the difference between a manoeuvre and a coin flip.
  check('an overtaking taxi never comes within the collision envelope of the car it passes',
    pD >= 0 && over.closest > 2.31,
    `closest approach ${over.closest.toFixed(2)} units, envelope 2.31`);

  // The route gate. A pass always spans a junction — 30-odd units of manoeuvre against a 12-unit
  // lane — so one that starts before a turn strands the taxi on the wrong side of the road going
  // into a corner. Turning at the very next junction must not offer one at all.
  const turnOff = runOvertake(true, [leftOf(pD), pD, pD]);
  check('no overtake is offered when the route turns at the next junction',
    pD >= 0 && turnOff.peak < 0.02, `reached ${(turnOff.peak * 2 * LANE).toFixed(2)} units across`);

  // And the control: the pass is the button. Not holding it is not a pass.
  const coasting = runOvertake(false, [pD, pD, pD]);
  check('an overtake needs the button held',
    pD >= 0 && coasting.peak < 0.02, `reached ${(coasting.peak * 2 * LANE).toFixed(2)} units across`);

  // The two gates that decide *when* it is allowed, both added after watching it wreck rather
  // than pass. A pass wants ~27 units of road against a 12-unit lane, so the taxi is always still
  // alongside when the leader reaches its junction — which is exactly when the left-turn dice are
  // rolled. Passing a car that is already crossing one means driving into its arc.
  //
  // Asserted as "the taxi never got out of its lane while that car was in the junction" rather
  // than as an absence of contact: a no-contact check passes whether the rule works or the
  // scenario simply never set it up, and this one has to prove the trap was laid. `leadTurned` is
  // that proof.
  const turningLead = runOvertake(true, [pD, pD, pD], { leadRoute: [leftOf(pD), pD, pD] });
  check('no overtake of a car that is already turning across the lane being borrowed',
    pD >= 0 && turningLead.leadTurned && turningLead.outWhileLeadTurning < 0.02,
    `lead turned=${turningLead.leadTurned}, taxi got `
    + `${(turningLead.outWhileLeadTurning * 2 * LANE).toFixed(2)} units across while it did`);

  // And the borrowed lane has to be empty to start with. Without this the taxi pulled out with
  // oncoming traffic 3 units away — inside the envelope, and nothing the player could have read.
  // A car that arrives *during* the pass still costs the run; that one is visible and is the risk.
  const intoTraffic = runOvertake(true, [pD, pD, pD], { oncoming: true });
  check('no overtake into oncoming traffic that is already in sight',
    pD >= 0 && intoTraffic.peak < 0.02,
    `reached ${(intoTraffic.peak * 2 * LANE).toFixed(2)} units across`);

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
  check('game over fires with the wreck reason', cFares.state.gameOver
    && /paycheck/i.test(cFares.state.failReason ?? ''), cFares.state.failReason);

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

// --- Box trucks --------------------------------------------------------------
// A purely opt-in ambient variant — every scenario in this file runs with truckChance at its
// default of 0, so nothing above ever draws one. This is the one place it gets turned on, forcing
// every ambient car to be a truck and driving the same crash path as the block above, aimed at the
// truck meshes instead of the car ones — the failure mode worth catching is a wrecked truck
// collapsing the wrong InstancedMesh slot (its own car-mesh index, which happens to belong to some
// other truck) instead of its own.
{
  const uScene = new THREE.Scene();
  const uTraffic = createTraffic(makeRng(seed + 44), uScene, CARS_DEFAULT, CARS_DEFAULT, 1);
  check('truckChance=1 puts every ambient car in the truck meshes',
    uTraffic.mesh.count === 0 && uTraffic.truckMesh.count === CARS_DEFAULT - 1
    && uTraffic.truckBoxMesh.count === CARS_DEFAULT - 1,
    `car mesh ${uTraffic.mesh.count}, truck mesh ${uTraffic.truckMesh.count}, box mesh ${uTraffic.truckBoxMesh.count}`);

  // The invisible truck. Three computes an InstancedMesh's bounding sphere once, off the instance
  // matrices as they stood on the first frame the renderer culled it, and never refreshes it — so
  // a mesh whose instances drive across the city is culled against where they *were*. See the note
  // by `neverCull` in sim/traffic.js; game/carghosts.js has the same assertion for the same reason.
  //
  // Staged at the worst case that shipped: one truck, whose sphere is then a 3.1-unit bubble around
  // its warmup position, watched through a portrait phone's frustum (where the camera follows the
  // taxi rather than framing the whole city). Before the fix, a truck plainly on screen went
  // unsubmitted in 27% of these samples — and since the cab and the box are separate meshes with
  // separate spheres, some of those frames dropped only the box and left a cab driving down the
  // street with nothing on its back.
  {
    const kScene = new THREE.Scene();
    const kTraffic = createTraffic(makeRng(seed + 44), kScene, 2, 2, 1);
    check('every moving vehicle mesh is out of frustum culling',
      [kTraffic.mesh, kTraffic.wheelMesh,
        kTraffic.truckMesh, kTraffic.truckWheelMesh, kTraffic.truckBoxMesh]
        .every((m) => m.frustumCulled === false));

    const kAspect = 390 / 844;
    const kCam = createCityCamera(kAspect, { zoom: 46 });
    const kFrustum = new THREE.Frustum();
    const kMat = new THREE.Matrix4();
    const kPoint = new THREE.Vector3();
    // WebGLRenderer.projectObject's own test, verbatim — `frustumCulled` first, and the sphere
    // only if it is still on. WebGLShadowMap applies the same rule to the sun's frustum, which
    // covers the whole city, so a stale sphere drops the truck from the play camera while its
    // shadow keeps sliding along the road underneath it.
    const submitted = (m) => {
      kScene.updateMatrixWorld(true);
      kCam.camera.updateMatrixWorld(true);
      kMat.multiplyMatrices(kCam.camera.projectionMatrix, kCam.camera.matrixWorldInverse);
      kFrustum.setFromProjectionMatrix(kMat);
      return !m.frustumCulled || kFrustum.intersectsObject(m);
    };

    kTraffic.warmup(10);                 // main.js warms up before its first frame; so does this
    submitted(kTraffic.truckMesh);       // ...and that first frame is what would latch the sphere
    let kInShot = 0;
    let kDropped = 0;
    for (let step = 0; step < 60 * 60; step++) {
      kTraffic.update(1 / 60);
      kCam.followXZ(kTraffic.taxi.x, kTraffic.taxi.z, 1 / 60, 3.2, kAspect);
      if (step % 15) continue;
      const onScreen = kTraffic.trucks.some((t) => {
        kPoint.set(t.x, 1.5, t.z).project(kCam.camera);
        return Math.abs(kPoint.x) < 0.95 && Math.abs(kPoint.y) < 0.95;
      });
      if (!onScreen) continue;
      kInShot += 1;
      if (!submitted(kTraffic.truckMesh) || !submitted(kTraffic.truckWheelMesh)
        || !submitted(kTraffic.truckBoxMesh)) kDropped += 1;
    }
    check('a truck on screen is still drawn once it has left where it spawned',
      kInShot > 20 && kDropped === 0,
      `${kInShot} sampled frames with a truck in shot, ${kDropped} of them culled away`);
  }

  // truckMesh's instance colour — which tints its chassis (the cab itself is baked dark
  // regardless, see truckCabGeometry) — is painted from PALETTE.carBody, same as an ordinary car.
  // Only the cargo box breaks from that, and it does so by never getting an instance colour at
  // all, not by reading a different palette.
  const uChassisColor = new THREE.Color();
  uTraffic.truckMesh.getColorAt(0, uChassisColor);
  const uCab = uTraffic.trucks[0];
  check("a truck's chassis is painted from the car palette",
    uChassisColor.getHexString()
    === new THREE.Color(PALETTE.carBody[uCab.colorIndex]).getHexString(),
    `#${uChassisColor.getHexString()} vs carBody[${uCab.colorIndex}] #${new THREE.Color(PALETTE.carBody[uCab.colorIndex]).getHexString()}`);
  check("a truck's cargo box is never instance-tinted", uTraffic.truckBoxMesh.instanceColor === null);

  // Driving feel: a truck cruises a little slower than a car (TRUCK_SPEED) and rocks less on every
  // start and stop (TRUCK_PITCH_SCALE / TRUCK_PITCH_DAMPING_MULT). Measured over a stretch of
  // ordinary driving against a same-seed, same-count control scene of ordinary cars, so the
  // comparison isn't luck of which junction either population happened to be at.
  const vTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), CARS_DEFAULT);
  const sampleDriving = (traf, seconds) => {
    let vSum = 0; let vN = 0;
    let pitchSum = 0; let pitchN = 0;
    for (let step = 0; step < seconds * 60; step++) {
      traf.update(1 / 60);
      for (const car of traf.cars) {
        if (car.isTaxi || car.crashed) continue;
        if (car.state === 'drive') { vSum += car.v; vN += 1; }
        pitchSum += Math.abs(car.pitch); pitchN += 1;
      }
    }
    return { avgV: vN ? vSum / vN : 0, avgPitch: pitchN ? pitchSum / pitchN : 0 };
  };
  const truckSample = sampleDriving(uTraffic, 12);
  const carSample = sampleDriving(vTraffic, 12);
  check('trucks cruise slower than cars', truckSample.avgV < carSample.avgV * 0.95,
    `truck avg v ${truckSample.avgV.toFixed(2)} vs car avg v ${carSample.avgV.toFixed(2)}`);
  check('trucks rock less than cars on every start and stop',
    truckSample.avgPitch < carSample.avgPitch * 0.85,
    `truck avg |pitch| ${truckSample.avgPitch.toFixed(4)} vs car avg |pitch| ${carSample.avgPitch.toFixed(4)}`);

  // Following distance: a car has to leave more clear road behind a truck than behind another
  // car, since a leader's actual length has to be part of the gap — see followGap in traffic.js.
  // Staged directly on a straight, roomy lane: a parked leader (parked + no route holds any
  // ambient car forever, same trick the taxi's own kerb wait uses) and a follower that closes in
  // behind it and brakes to a stop, read once both have settled.
  // The lane itself — not just the chained approach room — has to be long enough for both `back`
  // values below to land inside it: placeCar walks back across a junction into the previous lane
  // in the chain once `back` exceeds this one's own length, which would leave leader and follower
  // on two unrelated lanes instead of nose-to-tail on one.
  let gI = -1; let gJ = -1; let gD = -1;
  const gNet = cityNetwork();
  outerGap: for (let i = 1; i < GRID; i++) {
    for (let j = 1; j < GRID; j++) {
      for (const d of [0, 1, 2, 3]) {
        const lane = gNet.laneByGrid(d, i, j);
        if (!lane || lane.degenerate || lane.length < 11.5) continue;
        gI = i; gJ = j; gD = d;
        break outerGap;
      }
    }
  }
  const settledGap = (leaderIsTruck) => {
    const gTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), 3);
    const [, leader, follower] = gTraffic.cars;
    leader.isTruck = leaderIsTruck;
    placeCar(leader, gD, gI, gJ, 4);
    leader.parked = true;
    placeCar(follower, gD, gI, gJ, 11);
    for (let step = 0; step < 300; step++) gTraffic.update(1 / 60);
    return Math.hypot(leader.x - follower.x, leader.z - follower.z);
  };
  // CAR_LEN/2 + CAR_LEN/2 + BUMPER_GAP (1.9) = MIN_GAP = 5.3; with a truck leader,
  // CAR_LEN/2 + TRUCK_LEN/2 + BUMPER_GAP = 1.7 + 2.8 + 1.9 = 6.4.
  const carGap = settledGap(false);
  const truckGap = settledGap(true);
  check('a car settles further back behind a truck than behind a car',
    truckGap > carGap + 0.9, `behind a car ${carGap.toFixed(2)}, behind a truck ${truckGap.toFixed(2)}`);
  check('the settled gaps match followGap exactly, not the old flat MIN_GAP for both',
    Math.abs(carGap - 5.3) < 0.1 && Math.abs(truckGap - 6.4) < 0.1,
    `behind a car ${carGap.toFixed(2)} (want ~5.3), behind a truck ${truckGap.toFixed(2)} (want ~6.4)`);

  const uCollisions = createCollisions(uTraffic.cars, uTraffic.taxi);
  const uVanish = createVanish();
  let uHits = 0;
  let uImpact = null;
  const uShells = [];
  uCollisions.onImpact((event) => {
    uHits += 1;
    uImpact = event;
    for (const car of [event.taxi, event.other]) {
      const shell = uTraffic.wreckShell(car);
      uShells.push(shell);
      uVanish.take(shell);
    }
  });

  uTraffic.warmup(3);
  const uTarget = uTraffic.cars.find((c) => !c.isTaxi && c.state === 'drive');
  uTraffic.taxi.x = uTarget.x;
  uTraffic.taxi.z = uTarget.z;
  uTraffic.taxi.boost = true;
  for (let step = 0; step < 90; step++) {
    uCollisions.update();
    uTraffic.update(1 / 60);
    if (uHits > 0) break;
  }

  check('boosting into a truck fires an impact', uHits >= 1, `${uHits} impacts`);
  const uVictim = uImpact?.other;
  check('the truck it hit is wrecked', Boolean(uVictim?.crashed) && uVictim.isTruck === true);

  const uScale = new THREE.Vector3();
  const uMatrix = new THREE.Matrix4();
  const scaleOfTruck = (instMesh, index) => {
    instMesh.getMatrixAt(index, uMatrix);
    uMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), uScale);
    return uScale.x;
  };
  const truckWheelScales = [];
  for (let w = 0; w < uTraffic.truckWheelsPerCar; w++) {
    truckWheelScales.push(scaleOfTruck(
      uTraffic.truckWheelMesh, uVictim.instanceIndex * uTraffic.truckWheelsPerCar + w,
    ));
  }
  check('a wrecked truck collapses out of the truck meshes, not the car ones',
    scaleOfTruck(uTraffic.truckMesh, uVictim.instanceIndex) === 0
    && scaleOfTruck(uTraffic.truckBoxMesh, uVictim.instanceIndex) === 0
    && truckWheelScales.every((s) => s === 0),
    `cab + box + ${truckWheelScales.length} wheels`);

  // The shell itself carries two materials for a truck — cab+wheels in its car-palette colour, the
  // box in the fixed PALETTE.truckBox — and game/vanish.js has to find and fade both.
  const uShell = uShells[1];
  check('a wrecked truck hands over both a cab and a box mesh',
    uShell.children.length === 2 + truckWheelScales.length);

  // Right turns: a truck should visibly take longer than a car on the identical turn — see
  // TRUCK_RIGHT_TURN_SPEED in traffic.js. Staged with a forced route, the same "one routing
  // branch" any car can use and not just the taxi (docs/traffic.md), so the turn direction isn't
  // left to the weighted dice.
  let rI = -1; let rJ = -1; let rD = -1;
  outerRight: for (let i = 1; i < GRID; i++) {
    for (let j = 1; j < GRID; j++) {
      for (const d of [0, 1, 2, 3]) {
        if (!legalExits(d, i, j).includes(rightOf(d))) continue;
        const lane = gNet.laneByGrid(d, i, j);
        if (!lane || lane.degenerate || lane.length < 8) continue;
        rI = i; rJ = j; rD = d;
        break outerRight;
      }
    }
  }
  const rightTurnSeconds = (isTruck) => {
    const rTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), 2);
    const [, car] = rTraffic.cars;
    car.isTruck = isTruck;
    placeCar(car, rD, rI, rJ, 7);
    car.route = [rightOf(rD)];
    let seconds = 0;
    let seenTurn = false;
    for (let step = 0; step < 60 * 30; step++) {
      rTraffic.update(1 / 60);
      if (car.state === 'turn') { seconds += 1 / 60; seenTurn = true; } else if (seenTurn) break;
    }
    return seconds;
  };
  const carRightSeconds = rightTurnSeconds(false);
  const truckRightSeconds = rightTurnSeconds(true);
  check('a truck takes measurably longer than a car on the same right turn',
    truckRightSeconds > carRightSeconds * 1.3,
    `car ${carRightSeconds.toFixed(2)}s, truck ${truckRightSeconds.toFixed(2)}s`);
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
// Boosting near an active police car ends the run with a distinct "Busted!" title. Mirrors the
// wiring in src/main.js: proximity < POLICE_BUST_RANGE while boosting → fares.crash('...',
// 'Busted!'). No wreck plume, so the check is about the state transition, not particle effects.
{
  const bScene = new THREE.Scene();
  const bTraffic = createTraffic(makeRng(seed + 44), bScene, CARS_DEFAULT);
  const bFares = createFareSystem(makeRng(seed + 55), bScene);
  const bPolice = createPolice(makeRng(seed + 66), bScene);
  const bTaxi = bTraffic.taxi;

  // Fast-forward to a live police run — the corridor logic drives when the car appears. Armed
  // rather than merely active: the bust does not exist until the cruiser is a block in from the
  // edge, so a test staged on `active` would sit next to a cop that cannot bust anyone.
  bPolice.state.cooldown = 0;
  for (let step = 0; step < 60 * 60 && !bPolice.state.armed; step++) {
    bPolice.update(1 / 60);
    bTraffic.update(1 / 60);
  }
  check('police run arms for the bust test', bPolice.state.armed);

  // Put the taxi within bust range of the cop, boost engaged.
  bTaxi.x = bPolice.group.position.x + 5;
  bTaxi.z = bPolice.group.position.z + 5;
  bTaxi.boost = true;

  const dx = bTaxi.x - bPolice.group.position.x;
  const dz = bTaxi.z - bPolice.group.position.z;
  const near = dx * dx + dz * dz < POLICE_BUST_RANGE * POLICE_BUST_RANGE;
  if (near && bTaxi.boost && bPolice.state.armed && !bFares.state.gameOver && !bTaxi.crashed) {
    bTaxi.crashed = true;
    bFares.crash("The fuzz caught you slippin'.", 'Busted!');
  }

  check('boosting near the police ends the run', bFares.state.gameOver);
  check('bust banner title is "Busted!"', bFares.state.failTitle === 'Busted!',
    bFares.state.failTitle);
  check('bust reason mentions the fuzz', /fuzz/i.test(bFares.state.failReason ?? ''),
    bFares.state.failReason);

  // Well outside bust range: same setup, no trigger.
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 44), fScene, CARS_DEFAULT);
  const fFares = createFareSystem(makeRng(seed + 55), fScene);
  const fPolice = createPolice(makeRng(seed + 66), fScene);
  fPolice.state.cooldown = 0;
  for (let step = 0; step < 60 * 60 && !fPolice.state.armed; step++) {
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

// --- The bust is never lethal before it is readable -------------------------
// A cruiser arriving on the map used to be able to end a run before it had drawn a pixel: the bust
// radius is a block (20) and FADE_BAND is 18, so on the ring road the check fired at exactly zero
// opacity, lamps included. BUST_ARM_INSET gates the whole thing on the cruiser being a block in.
//
// Two invariants, and they are the same invariant said twice on purpose: whatever can bust you is
// fully drawn, and its light bar is running. The second is what the player actually reads, so the
// two flags are asserted against each other rather than each against the geometry.
{
  const aScene = new THREE.Scene();
  const aPolice = createPolice(makeRng(seed + 66), aScene);
  const lamps = aPolice.group.children.filter((child) => child.isPointLight);

  let armedFrames = 0;
  let armedWhileFading = 0;      // lethal while still transparent — the bug
  let armedWithLampsDark = 0;    // lethal with no cue at all
  let litWhileUnarmed = 0;       // the opposite lie: a bar that means nothing
  let ringExposed = 0;           // armed while the cruiser is still in the outer band
  let runs = 0;
  let wasActive = false;

  for (let step = 0; step < 600 * 60; step++) {
    aPolice.update(1 / 60);
    const p = aPolice.state;
    if (p.active && !wasActive) runs += 1;
    wasActive = p.active;

    const lit = lamps.some((lamp) => lamp.intensity > 0);
    if (!p.armed) {
      if (lit) litWhileUnarmed += 1;
      continue;
    }
    armedFrames += 1;
    if (p.fade < 1) armedWhileFading += 1;
    if (!lit) armedWithLampsDark += 1;
    if (Math.abs(p.s) > HALF_SPAN - BUST_ARM_INSET) ringExposed += 1;
  }

  check('the police car runs corridors for the arming test', runs >= 5, `${runs} runs`);
  check('the bust is never armed while the cruiser is still fading in',
    armedWhileFading === 0, `${armedWhileFading} of ${armedFrames} armed frames`);
  check('an armed cruiser always has its light bar running',
    armedWithLampsDark === 0, `${armedWithLampsDark} of ${armedFrames} armed frames`);
  check('the light bar is dark whenever the bust is disarmed', litWhileUnarmed === 0,
    `${litWhileUnarmed} frames`);
  check('the bust never arms out in the outer band', ringExposed === 0, `${ringExposed} frames`);
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

// --- The ambient flyover --------------------------------------------------------
// A plane crossing the sky is the one thing in the game with no failure state to notice: if it
// clips a tower, pops into frame at the edge of a wide monitor, or flies parallel to the streets,
// nothing breaks and nobody is told. All three are numbers, so they belong here.
{
  const model = createPlaneMesh();
  const box = new THREE.Box3().setFromObject(model.group);
  check('the plane model measures what geometry/plane.js says it does',
    Math.abs(-box.min.y - PLANE_UNDERSIDE) < 1e-6
    && Math.abs((box.max.z - box.min.z) - PLANE_SPAN) < 1e-6,
    `underside ${(-box.min.y).toFixed(2)}, span ${(box.max.z - box.min.z).toFixed(2)}`);

  // Both streamers face the camera as squarely as a ribbon fixed to the fuselage axis can. The
  // ceiling is the length of VIEW_DIR with its component along that axis removed — hit it exactly
  // and the roll is right; a sign error lands on its negative and the ribbons turn edge-on.
  // Read the normal off the built quads rather than recomputing it from the roll angle: rolling
  // the ribbon to point its *width* at the camera instead of its face is a one-character
  // difference that leaves every formula self-consistent and the streamers invisible.
  const triangleNormal = (array, yaw) => {
    const v = (i) => new THREE.Vector3(array[i * 3], array[i * 3 + 1], array[i * 3 + 2]);
    const a = v(0);
    return new THREE.Vector3().crossVectors(v(1).sub(a), v(2).sub(a)).normalize()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  };
  let facingError = 0;
  for (let k = 0; k < 32; k++) {
    const yaw = (k / 32) * Math.PI * 2;
    model.setTrailRoll(trailRoll(yaw));
    const normal = triangleNormal(model.trails.geometry.attributes.position.array, yaw);
    // The ceiling: VIEW_DIR with its component along the fuselage axis taken out, which is all a
    // ribbon fixed to that axis can ever turn to face.
    const f = heading(yaw);
    const along = VIEW_DIR.x * f.x + VIEW_DIR.z * f.z;
    const best = Math.hypot(VIEW_DIR.x - along * f.x, VIEW_DIR.y, VIEW_DIR.z - along * f.z);
    facingError = Math.max(facingError, Math.abs(best - Math.abs(normal.dot(VIEW_DIR))));
  }
  model.setTrailRoll(0);
  check('wingtip streamers turn to face the camera', facingError < 1e-6,
    `off the best a ribbon on the fuselage axis can do by ${facingError.toExponential(1)}`);

  const planeScene = new THREE.Scene();
  const flyover = createFlyover(planeScene, makeRng(seed + 155));

  // Ten minutes of sim, which is several flights and a lot more waiting.
  let minY = Infinity;
  let hiddenOverCity = 0;        // frames faded down while over the map, where it has to be solid
  let airborne = 0;
  let frames = 0;
  let straight = 0;              // launches within 12° of a street
  let lastFlight = 0;
  let wasActive = false;
  const ends = [];               // where each run starts and where it stops being drawn
  for (let step = 0; step < 600 * 60; step++) {
    flyover.update(1 / 60);
    frames++;
    if (flyover.state.flights !== lastFlight) {
      lastFlight = flyover.state.flights;
      // Distance from the nearest world axis, i.e. from the nearest street direction.
      const off = Math.abs(((flyover.state.yaw % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2));
      if (Math.min(off, Math.PI / 2 - off) < THREE.MathUtils.degToRad(12)) straight++;
      ends.push(flyover.group.position.clone());
    }
    if (wasActive && !flyover.state.active) ends.push(flyover.group.position.clone());
    wasActive = flyover.state.active;
    if (!flyover.state.active) continue;
    airborne++;
    minY = Math.min(minY, flyover.group.position.y);
    const p = flyover.group.position;
    if (Math.max(Math.abs(p.x), Math.abs(p.z)) < HALF_SPAN && flyover.state.fade < 1) hiddenOverCity++;
  }

  check('the flyover comes round every so often, not constantly',
    flyover.state.flights >= 4 && airborne / frames < 0.2,
    `${flyover.state.flights} flights in 10 min, airborne ${(100 * airborne / frames).toFixed(0)}% of it`);

  // The tallest thing it has to miss, measured off the city that was actually built rather than
  // off the constant the generator caps at.
  buildings.mesh.geometry.computeBoundingBox();
  const skyline = buildings.mesh.geometry.boundingBox.max.y;
  check('the plane clears the skyline',
    minY - PLANE_UNDERSIDE > skyline + 4,
    `underside ${(minY - PLANE_UNDERSIDE).toFixed(1)} vs tallest tower ${skyline.toFixed(1)}`);

  // Both ends of a run have to be off the edge of the frame, so the aeroplane is only ever seen
  // arriving rather than appearing. Projected through real cameras at the extremes the game
  // allows — portrait phone to ultrawide desktop, panned into each corner of the map — rather
  // than compared against a hand-derived reach.
  const framings = [];
  for (const aspect of [0.46, 1, 1.78, 2.4]) {
    for (const target of [[0, 0], [HALF_SPAN, HALF_SPAN], [-HALF_SPAN, HALF_SPAN],
      [HALF_SPAN, -HALF_SPAN], [-HALF_SPAN, -HALF_SPAN]]) {
      framings.push(createCityCamera(aspect, { zoom: 52, target }).camera);
    }
  }
  let onScreenEnds = 0;
  for (const p of ends) {
    for (const cam of framings) {
      const ndc = p.clone().project(cam);
      if (Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1) onScreenEnds++;
    }
  }
  check('the plane flies in from off-frame and out the other side', onScreenEnds === 0,
    `${ends.length} run ends against ${framings.length} framings, ${onScreenEnds} of them in shot`);

  check('it is fully painted while over the city', hiddenOverCity === 0,
    `${hiddenOverCity} frames faded while inside the map`);
  check('it never flies parallel to the streets', straight === 0,
    `${straight} of ${flyover.state.flights} headings within 12° of an axis`);

  // Two blades, so the prop repeats every half turn: past 90° a frame it reads as running
  // backwards, and at exactly 180° it stands still.
  check('the propeller does not strobe', PROP_SPIN / 60 < Math.PI / 2,
    `${THREE.MathUtils.radToDeg(PROP_SPIN / 60).toFixed(1)}° per frame at 60fps`);
}

// --- The barricade's geometry, before any of it is placed ----------------------
// The ramp shipped wound inside out: its slope normals came out at y = -0.98 and its underside's
// at +1.00, so the only face the camera ever saw was the bottom — a flat quad lying exactly on the
// road, which read as a patch of z-fighting near the junction. `flatShading` takes its normal from
// a screen-space derivative, so the wrong-facing quad still lit like a surface rather than going
// black, and it survived a screenshot review. Hence a test on the numbers.
{
  const { ramp } = barricadeParts({ width: ROAD_W - 0.4, centreX: -LANE });
  const pos = ramp[0].getAttribute('position');
  // Face normals straight off the winding, which is the thing under test — `computeVertexNormals`
  // would launder a reversed triangle into whatever its neighbours said.
  const faces = [];
  for (let f = 0; f < pos.count / 3; f++) {
    const p = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, f * 3 + k));
    faces.push(new THREE.Vector3()
      .subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).normalize());
  }
  // Written in this order by `rampWedge`: slope, vertical back, underside, the two sides.
  const slope = faces.slice(0, 2);
  const underside = faces.slice(4, 6);

  check('the ramp\'s slope faces the sky and its underside faces the road',
    slope.every((n) => n.y > 0.9) && underside.every((n) => n.y < -0.99),
    `slope y ${slope.map((n) => n.y.toFixed(2)).join('/')}, `
    + `underside y ${underside.map((n) => n.y.toFixed(2)).join('/')}`);

  // The slope's pitch, from the same normals. Shallow enough and it is a plate, not a ramp — the
  // first pair was 0.66 over 3.2, which is 12°.
  const pitch = Math.acos(slope[0].y) * 180 / Math.PI;
  check('and it is pitched steeply enough to read as a ramp',
    pitch > 15 && pitch < 25, `${pitch.toFixed(1)}° from ${RAMP_H} over ${RAMP_RUN}`);

  // Nothing coplanar with the road slab (0), the lane paint (0.02) or the route band (0.03). A
  // flat face at any of those three z-fights whatever is already drawn there.
  let lowest = Infinity;
  for (let v = 0; v < pos.count; v++) lowest = Math.min(lowest, pos.getY(v));
  check('the ramp sits clear of the road paint and the route band',
    Math.abs(lowest - WORKS_Y) < 1e-6 && WORKS_Y > 0.03,
    `lowest vertex ${lowest.toFixed(3)} against band 0.03`);

  const hole = spoilParts(0, 0, makeRng(seed + 909))[1].getAttribute('position');
  let holeY = -Infinity;
  for (let v = 0; v < hole.count; v++) holeY = Math.max(holeY, hole.getY(v));
  check('and the trench is above the lane paint but under the route band',
    Math.abs(holeY - TRENCH_Y) < 1e-6 && holeY > 0.02 && holeY < 0.03,
    `${holeY.toFixed(3)} in (0.02, 0.03)`);

  // The chain the landing depends on: the ramp runs RAMP_RUN back from BARRIER_S, so its toe is at
  // the difference and that has to stay on the tarmac. At 1.7 against a 3.2 ramp it was -1.5,
  // which put the toe in the middle of a live intersection.
  check('the ramp\'s toe is inside the lane, not in the junction behind it',
    BARRIER_S - RAMP_RUN > 0,
    `toe at ${(BARRIER_S - RAMP_RUN).toFixed(2)} (barrier ${BARRIER_S} - run ${RAMP_RUN})`);
}

// --- A street closed for roadworks ---------------------------------------------
// The vignette has two halves that can fail silently. The closure is a *soft* one — two lane ids
// that zero a turn's weight rather than a road removed from the graph — so a mistake there does
// not throw, it just puts ambient cars back inside the barricades or, worse, strands one at a
// hold line it can never leave. And the taxi's ramp is drawn from `car.travelled`, so a mistake
// there is a stunt that gets longer the faster you are going and lands inside a junction.
{
  setClosedLanes([]);
  const rwScene = new THREE.Scene();
  const rwTraffic = createTraffic(makeRng(seed + 210), rwScene, 24);
  const rwCars = rwTraffic.cars;
  const rwTaxi = rwTraffic.taxi;
  for (let step = 0; step < 300; step++) rwTraffic.update(1 / 60);

  const roadwork = createRoadwork(makeRng(seed + 211), rwScene, null);
  const placed = roadwork.place(rwTaxi, rwCars, []);
  const net = cityNetwork();
  const closedIds = new Set(roadwork.closedLaneIds);
  const closed = roadwork.closedLaneIds.map((id) => net.laneById.get(id));

  check('a construction zone finds a street to close', placed && closed.length === 2,
    placed ? closed.map((l) => l.id).join(' + ') : 'no candidate');

  check('it closes a side street, never an arterial or the ring',
    closed.every((l) => l.edge.klass === 'side'), closed[0]?.edge.klass);

  // The invariant that actually matters. A car whose every onward lane is closed can never leave
  // the junction — U-turns are illegal — so it holds at the line with its whole lane behind it.
  let stranded = 0;
  for (const end of [closed[0].edge.a, closed[0].edge.b]) {
    for (const lane of net.nodeById.get(end).inbound) {
      if (lane.degenerate) continue;
      if (!lane.onward.some((out) => !closedIds.has(out.id))) stranded += 1;
    }
  }
  check('no approach to either end is left with nowhere to go', stranded === 0,
    `${stranded} stranded approaches`);

  // Cones and the hole go on the *tarmac between* the junctions. An edge runs node centre to node
  // centre, so laying them out along it puts the first and last few across two live intersections.
  const lane = closed[0];
  const a = lane.path.at(0);
  const b = lane.path.at(lane.length);
  const ux = (b.x - a.x) / lane.length;
  const uz = (b.z - a.z) / lane.length;
  let worstLateral = 0;
  let outsideSpan = 0;
  const laterals = [];
  for (const cone of roadwork.cones) {
    const along = (cone.x - a.x) * ux + (cone.z - a.z) * uz;
    // Lateral offset from the road centreline, which sits LANE to the left of this lane.
    const lateral = (cone.x - a.x) * uz - (cone.z - a.z) * ux + LANE;
    worstLateral = Math.max(worstLateral, Math.abs(lateral));
    laterals.push(lateral);
    if (along < 0 || along > lane.length) outsideSpan += 1;
  }
  check('every cone is on the tarmac, clear of both junction boxes',
    outsideSpan === 0 && worstLateral < ROAD_W / 2,
    `${outsideSpan} past an end, worst offset ${worstLateral.toFixed(2)} of ${ROAD_W / 2}`);

  // Two rows rather than a scatter. This was a sine zigzag that wandered across the centreline,
  // which read as cones dropped at random — the order has to be legible before the jitter on top of
  // it reads as a crew having placed them rather than as noise.
  const rowError = Math.max(...laterals.map((v) => Math.abs(Math.abs(v) - CONE_ROW)));
  const perSide = laterals.filter((v) => v > 0).length;
  check('the cones stand in two rows, one either side of the works',
    rowError < 0.2 && perSide === roadwork.cones.length / 2,
    `${perSide}/${roadwork.cones.length - perSide} split, worst row error ${rowError.toFixed(3)}`);

  // The near row has to be in the taxi's way and the far row out of it, or driving through is
  // either a clean corridor or a wall. The taxi tracks a lane centre at LANE and is CAR_W wide.
  check('one row is in the taxi\'s path and the other survives it',
    CONE_ROW < LANE + CAR_W / 2 && CONE_ROW > LANE - 1,
    `row at ${CONE_ROW}, taxi flank reaches ${(LANE + CAR_W / 2).toFixed(2)}`);

  // Ambient traffic routes around it. Sampled every frame rather than at the end, because a car
  // that turns in and out again between two samples is exactly the bug this is looking for.
  let intrusions = 0;
  let held = 0;
  for (let step = 0; step < 150 * 60; step++) {
    rwTraffic.update(1 / 60);
    roadwork.update(1 / 60, rwTaxi, rwCars, []);
    for (const car of rwCars) {
      if (car === rwTaxi) continue;
      if (closedIds.has(car.lane?.id)) intrusions += 1;
      if (car.v < 0.01) held += 1;
    }
  }
  check('no ambient car enters the closure over 150s', intrusions === 0,
    `${intrusions} car-frames inside the barricades`);
  check('closing a street does not wedge the traffic model',
    rwTraffic.stats.routeDesync === 0 && rwTraffic.stats.violations === 0,
    `desync ${rwTraffic.stats.routeDesync}, red-light violations ${rwTraffic.stats.violations}, `
    + `${(held / (150 * 60 * rwCars.length) * 100).toFixed(0)}% of car-frames stationary`);

  check('the zone finishes rising out of the road and everything is at rest',
    roadwork.state.phase === 'live' && roadwork.active() === 0);

  // --- The ramp -------------------------------------------------------------
  // Driven at two very different speeds, because the arc is paced by distance and the whole point
  // of that is that the two agree. A time-paced hop covers 4.25 units at cruise and 11.5 in
  // overdrive, which is most of a 12-unit lane — the taxi would still be in the air at the line
  // where it picks its next turn.
  const flights = [];
  for (const boosting of [false, true]) {
    setClosedLanes([]);
    const runScene = new THREE.Scene();
    const runTraffic = createTraffic(makeRng(seed + 212), runScene, 6);
    const runwork = createRoadwork(makeRng(seed + 211), runScene, null);
    for (let step = 0; step < 300; step++) runTraffic.update(1 / 60);
    if (!runwork.place(runTraffic.taxi, runTraffic.cars, [])) continue;
    // Let the zone finish rising before staging the run at it. A player reaches one long after it
    // has settled, and a barricade half out of the road is a different test.
    while (runwork.state.phase !== 'live') runwork.update(1 / 60, runTraffic.taxi, runTraffic.cars, []);

    const taxi = runTraffic.taxi;
    const target = net.laneById.get(runwork.closedLaneIds[0]);
    const [ti, tj] = target.to.split(',').map(Number);
    // placeCar takes the junction the car is *heading for*, so this lands the taxi on the closed
    // lane itself, a unit short of the barricade at its mouth.
    placeCar(taxi, cityNetwork().dirOfLane(target), ti, tj, target.length - 1);
    taxi.boost = boosting;
    taxi.v = boosting ? 22 : SPEED;

    let smashes = 0;
    let lands = 0;
    let peakY = 0;
    let launchAt = null;
    let air = null;
    let airborneAtLine = false;
    // The wreckage, sampled every frame rather than read at the end: a cone that goes up and comes
    // back down is indistinguishable from one that never left the road once it has landed, and
    // "flipped into the air" is the whole claim being made.
    let peakCone = 0;
    let peakChip = 0;
    // Frames spent in the landing bounce. The curve itself is asserted separately, off
    // `landingBounce` — see below for why it cannot usefully be measured off the rendered taxi.
    let bounceFrames = 0;
    runwork.onSmash(() => { smashes += 1; });
    runwork.onLand(() => { lands += 1; });

    for (let step = 0; step < 60 * 6; step++) {
      const before = taxi.hopFrom;
      runTraffic.update(1 / 60);
      runwork.update(1 / 60, taxi, runTraffic.cars, []);
      if (before == null && taxi.hopFrom != null) launchAt = taxi.hopFrom;
      if (taxi.hopFrom != null) {
        peakY = Math.max(peakY, runTraffic.taxiGroup.position.y - ROAD_Y);
        // The line where the next turn is chosen. Still airborne there and the stunt has outrun
        // its own street.
        if (taxi.lane && taxi.s >= taxi.lane.length - STOP_SETBACK) airborneAtLine = true;
      }
      if (before != null && taxi.hopFrom == null && air === null) {
        air = taxi.travelled - launchAt;
      }
      if (taxi.hopFrom == null && taxi.bounceT != null) bounceFrames += 1;
      for (const cone of runwork.cones) if (cone.knocked) peakCone = Math.max(peakCone, cone.y);
      for (const chip of runwork.chips) if (chip.live) peakChip = Math.max(peakChip, chip.y);
    }
    flights.push({
      boosting, smashes, lands, peakY, air, airborneAtLine, taxi, runwork,
      peakCone, peakChip, bounceFrames,
    });
  }

  const cruise = flights.find((f) => !f.boosting);
  const fast = flights.find((f) => f.boosting);

  check('the taxi rams the barricade and is launched off it',
    flights.length === 2 && flights.every((f) => f.smashes >= 1 && f.lands === 1),
    flights.map((f) => `${f.boosting ? 'boost' : 'cruise'} ${f.smashes} smash / ${f.lands} land`).join(', '));

  check('it actually leaves the road and comes back down',
    flights.every((f) => f.peakY > 1.2 && Math.abs(f.taxi.hopFrom ?? 0) === 0),
    flights.map((f) => `peak ${f.peakY.toFixed(2)}`).join(', '));

  // One frame of slack: the flag clears on the first frame past the arc's end, so the measured
  // distance overshoots by whatever that frame covered.
  check('the hop is the same length at cruise and in overdrive',
    cruise && fast
    && cruise.air >= HOP_LEN && cruise.air < HOP_LEN + SPEED / 60 + 1e-6
    && fast.air >= HOP_LEN && fast.air < HOP_LEN + 23 / 60 + 1e-6,
    `${cruise?.air?.toFixed(3)} vs ${fast?.air?.toFixed(3)} against HOP_LEN ${HOP_LEN}`);

  check('and it is back on the tarmac before the line where it picks its next turn',
    flights.every((f) => !f.airborneAtLine));

  // The same fact as a number rather than an outcome, because it is a chain of three constants that
  // have to keep closing: the taxi launches at BARRIER_S and lands HOP_LEN later, against a hold
  // line STOP_SETBACK back from the end of a lane. Moving BARRIER_S out to clear the junction ate
  // most of the old slack (2.1 + 6.0 = 8.1 against 8.6), which is why HOP_LEN came down to 5.5.
  // Asserting only the outcome lets any one of the three drift until a fast run happens to fail.
  const holdS = closed[0].length - STOP_SETBACK;
  const margin = holdS - (BARRIER_S + HOP_LEN);
  check('the launch-to-landing chain leaves real slack before the hold line',
    margin > 0.75,
    `lands at ${(BARRIER_S + HOP_LEN).toFixed(2)}, line at ${holdS.toFixed(2)}, `
    + `margin ${margin.toFixed(2)}`);

  check('going through knocks the cones over, and they come to rest',
    flights.every((f) => f.runwork.cones.filter((c) => c.knocked).length >= 4
      && f.runwork.active() === 0),
    flights.map((f) => `${f.runwork.cones.filter((c) => c.knocked).length} knocked`).join(', '));

  // --- The wreckage ---------------------------------------------------------
  // "More chaotic" is a look, but the two things carrying it are numbers: cones that genuinely
  // leave the road rather than sliding along it, and wood off the trestle at all. Both are bounded
  // above as well as below — a cone thrown eleven units up (which SMASH_POWER without CONE_VY_MAX
  // would do at the overdrive top) leaves the frame on a close shot, and debris that outlives the
  // zone is a prop nobody cleared away.
  check('a smash flips cones into the air rather than sliding them along the road',
    flights.every((f) => f.peakCone > 1.2 && f.peakCone < 4),
    flights.map((f) => `${f.boosting ? 'boost' : 'cruise'} peak ${f.peakCone.toFixed(2)}`).join(', '));

  check('and blows splinters off the barricade, which land flat on the road',
    flights.every((f) => {
      const thrown = f.runwork.chips.filter((c) => c.live);
      return thrown.length >= 12
        && thrown.every((c) => c.age >= c.dur && Math.abs(c.y - SPLINTER_REST_Y) < 1e-6);
    }),
    flights.map((f) => `${f.runwork.chips.filter((c) => c.live).length} chips, `
      + `up to ${f.peakChip.toFixed(2)}`).join(', '));

  // The landing bounce, in two halves.
  //
  // First that the taxi enters it *on touchdown and at both speeds*: it is paced by a clock while
  // the arc above it is paced by distance, so the two are wired together at exactly one point — the
  // frame the arc ends — and a bounce that never started would be invisible in every other number
  // here. Same frame count at cruise and in overdrive is the point of the clock.
  const bounceFrames = Math.round(BOUNCE_DUR * 60);
  check('touchdown hands off to a landing bounce, the same length at either speed',
    flights.every((f) => Math.abs(f.bounceFrames - bounceFrames) <= 1
      && f.taxi.bounceT == null),
    flights.map((f) => `${f.boosting ? 'boost' : 'cruise'} ${f.bounceFrames}`).join(', ')
    + ` against ${bounceFrames} frames`);

  // ...and then the curve itself, off `landingBounce` rather than off the rendered taxi. The
  // rendered height also carries the speed bob and the pitch lift, and in overdrive those are three
  // times the size of the bounce — measured there, a bounce of zero passes and a bounce of double
  // fails. Two decaying rebounds, the second clearly smaller, back to nothing by the end, and the
  // whole thing well under the jump it follows: a landing that out-hops the hop reads as a ramp.
  {
    const samples = Array.from({ length: 61 }, (_, n) => landingBounce((n / 60) * BOUNCE_DUR));
    const peakAt = (from, to) => Math.max(...samples.slice(from, to));
    const first = peakAt(0, 31);
    const second = peakAt(31, 61);
    const jump = Math.min(...flights.map((f) => f.peakY));
    check('the bounce is two decaying rebounds that end on the road',
      first > 0.3 && first < jump * 0.35
      && second > 0.05 && second < first * 0.6
      && landingBounce(-0.1) === 0 && landingBounce(BOUNCE_DUR) === 0
      && samples[0] === 0,
      `rebounds ${first.toFixed(2)} then ${second.toFixed(2)}, against a ${jump.toFixed(2)} jump`);
  }

  // --- The dust off a barricade ---------------------------------------------
  // The smash used to emit two ordinary trail puffs, which is exactly what a boosting taxi lays
  // down in two frames — the one impact in the run looked like exhaust. Measured against a single
  // trail puff so the assertion is "bigger than the thing it was confused with", not a magic
  // number: pull the per-instance scale straight off the InstancedMesh.
  {
    const puffScene = new THREE.Scene();
    const trail = createDust(puffScene, null, makeRng(seed + 501));
    const boom = createDust(puffScene, null, makeRng(seed + 501));

    const scales = (d) => {
      const m = new THREE.Matrix4();
      const v = new THREE.Vector3();
      const out = [];
      for (let n = 0; n < d.mesh.count; n++) {
        d.mesh.getMatrixAt(n, m);
        m.decompose(new THREE.Vector3(), new THREE.Quaternion(), v);
        if (v.x > 0) out.push(v.x);
      }
      return out;
    };

    trail.add(0, 0, 0);
    trail.update(1 / 60);
    boom.burst(0, 0, 0);
    boom.update(1 / 60);

    const one = scales(trail);
    const many = scales(boom);
    check('a barricade throws a burst of dust, not a boost puff',
      many.length >= 10 && many.length > one.length * 5
      && Math.max(...many) > Math.max(...one) * 1.5,
      `${many.length} puffs at up to ${Math.max(...many).toFixed(2)} `
      + `against ${one.length} at ${Math.max(...one).toFixed(2)}`);
  }

  // --- Packing up once the taxi has been through ----------------------------
  // The zone clears itself away afterwards, and the half of that which is not cosmetic is giving
  // the street *back*. Two lane sets were pushed out when it was built — one that keeps ambient
  // traffic out, one that tempts the taxi in — and a teardown that forgets either leaves the city
  // with an invisible closure it drives around for the rest of the run.
  {
    setClosedLanes([]);
    setRoadworkLanes([]);
    const outScene = new THREE.Scene();
    const outTraffic = createTraffic(makeRng(seed + 212), outScene, 6);
    const outWork = createRoadwork(makeRng(seed + 211), outScene, null);
    for (let step = 0; step < 300; step++) outTraffic.update(1 / 60);

    let cleared = 0;
    outWork.onCleared(() => { cleared += 1; });

    if (outWork.place(outTraffic.taxi, outTraffic.cars, [])) {
      while (outWork.state.phase !== 'live') {
        outWork.update(1 / 60, outTraffic.taxi, outTraffic.cars, []);
      }

      const taxi = outTraffic.taxi;
      const target = net.laneById.get(outWork.closedLaneIds[0]);
      const [ti, tj] = target.to.split(',').map(Number);
      placeCar(taxi, cityNetwork().dirOfLane(target), ti, tj, target.length - 1);
      taxi.v = SPEED;

      // Long enough to drive the block, get clear, dwell and fade — but the assertions are on what
      // happened, not on the clock, so a slower teardown fails rather than passing by luck.
      let allFleeingAt = null;
      let ranAt = null;      // every worker has finished the sprint and is standing at the kerb
      let goneAt = null;     // ...and has faded out afterwards
      let sinkAt = null;     // ...and only then does the site itself start going
      for (let step = 0; step < 60 * 25 && outWork.state.phase !== 'gone'; step++) {
        outTraffic.update(1 / 60);
        outWork.update(1 / 60, taxi, outTraffic.cars, []);
        if (allFleeingAt === null && outWork.state.smashed) allFleeingAt = outWork.workersFleeing();
        if (ranAt === null && outWork.workersClear() === 2) ranAt = step;
        if (goneAt === null && outWork.workersGone() === 2) goneAt = step;
        if (sinkAt === null && outWork.state.phase === 'leaving') sinkAt = step;
      }

      check('every worker runs when a barricade goes, not just the nearest',
        allFleeingAt === 2, `${allFleeingAt} of 2 fleeing on the frame of the smash`);

      // The order of the beats, not their durations. It used to come out wrong at speed and only at
      // speed: the zone's fade is triggered by the taxi being clear of the street, and in overdrive
      // that happens half a second after the smash — while the crew is still mid-sprint — so they
      // dissolved on their way to the kerb instead of reaching it. Asserted as an ordering because
      // that is the thing that has to hold; the constants behind it are free to move.
      check('the crew runs clear and fades before the site starts packing up',
        ranAt !== null && goneAt !== null && sinkAt !== null
        && goneAt > ranAt && sinkAt >= goneAt,
        `ran clear at frame ${ranAt}, gone at ${goneAt}, site starts sinking at ${sinkAt}`);

      check('the zone clears itself away once the taxi is through',
        outWork.state.phase === 'gone' && cleared === 1 && outWork.group.parent === null,
        `phase ${outWork.state.phase}, ${cleared} cleared, `
        + `${outWork.group.parent === null ? 'detached' : 'still in the scene'}`);

      // The one that would otherwise be invisible.
      const stillClosed = outWork.closedLaneIds.filter((id) => isLaneClosed(id));
      const stillCheap = outWork.closedLaneIds
        .filter((id) => laneCost(net.laneById.get(id)) < 1);
      check('and gives the street back to both the traffic and the router',
        stillClosed.length === 0 && stillCheap.length === 0,
        `${stillClosed.length} still closed, ${stillCheap.length} still discounted`);
    }
    setClosedLanes([]);
    setRoadworkLanes([]);
  }

  // --- Steering the player into it ------------------------------------------
  // The player cannot drive. They tap a rider and the taxi routes itself, so unless the router is
  // told to like the closed street the whole vignette is scenery the game never visits — measured
  // at 33% of runs before this, 96% after (tools/roadwork-pull.mjs). Two mechanisms do it, and both
  // fail silently: a discount that never reaches `laneCost` changes nothing, and a drop-off hint
  // that is quietly dropped changes nothing either.
  {
    const ends = [closed[0].edge.a, closed[0].edge.b].map((id) => net.nodeById.get(id));
    const junctions = [...net.nodeById.values()].map((n) => ({ i: n.gi, j: n.gj }));
    const origin = { i: ends[0].gi, j: ends[0].gj, d: net.dirOfLane(closed[0]) };

    setRoadworkLanes([]);
    const plain = junctions.map((t) => planRoute(origin, t));
    setRoadworkLanes(roadwork.closedLaneIds);
    const cheap = junctions.map((t) => planRoute(origin, t));

    const same = (p, q) => (p === null || q === null
      ? p === q : p.length === q.length && p.every((d, k) => d === q[k]));
    const changed = plain.filter((p, k) => !same(p, cheap[k])).length;
    check('pricing the closed street low actually reaches the router',
      changed > 0, `${changed} of ${junctions.length} routes rerouted`);

    // ...and does not turn into a detour finder. The weights in route.js are tie-breakers by
    // design — 0.45 is worth about half a block, so nothing should gain more than one leg.
    const worst = Math.max(...plain.map((p, k) => (p && cheap[k] ? cheap[k].length - p.length : 0)));
    check('and does not drag routes across town to use it',
      worst <= 1, `worst route grew by ${worst} legs`);

    // A fare's drop-off can be aimed at the zone. The hint is one-shot and silently declined when
    // neither end is free, so the failure mode is "nothing happened" — worth pinning both ways.
    const aimScene = new THREE.Scene();
    const aimFares = createFareSystem(makeRng(seed + 313), aimScene);
    const aimTaxi = { i: 0, j: 0, x: 0, z: 0, lane: null, s: 0, v: 0 };
    aimFares.aimNextDropoff(ends.map((n) => ({ i: n.gi, j: n.gj })));
    let aimed = null;
    for (let step = 0; step < 120 && !aimed; step++) {
      for (const { type, fare } of aimFares.update(1 / 60, aimTaxi)) {
        if (type === 'spawned') aimed = fare;
      }
    }
    check('a fare can have its drop-off aimed at the closed street',
      aimed !== null && ends.some((n) => n.gi === aimed.dropoff.i && n.gj === aimed.dropoff.j),
      aimed ? `dropoff ${aimed.dropoff.i},${aimed.dropoff.j} of `
        + `${ends.map((n) => `${n.gi},${n.gj}`).join(' / ')}` : 'no fare spawned');

    // Aimed at junctions that do not exist: the hint has to be declined rather than honoured or
    // thrown, and the ordinary unbiased draw has to still produce a legal drop-off.
    const badFares = createFareSystem(makeRng(seed + 314), new THREE.Scene());
    badFares.aimNextDropoff([{ i: -5, j: -5 }]);
    let fallback = null;
    for (let step = 0; step < 120 && !fallback; step++) {
      for (const { type, fare } of badFares.update(1 / 60, aimTaxi)) {
        if (type === 'spawned') fallback = fare;
      }
    }
    check('and an unusable hint falls back to an ordinary drop-off',
      fallback !== null && fallback.dropoff.i >= 0 && fallback.dropoff.j >= 0
      && blockDistance(fallback.pickup, fallback.dropoff) > 0,
      fallback ? `dropoff ${fallback.dropoff.i},${fallback.dropoff.j}` : 'no fare spawned');

    setRoadworkLanes([]);
  }

  // --- Placement rules ------------------------------------------------------
  // A rider standing on a kerb corner inside a construction site is not broken — the taxi drives
  // through a closure — but it reads as one, so the spawner is told to keep clear.
  {
    // A band of junctions rather than a parity set: every edge joins an even corner to an odd
    // one, so `(i + j) % 2` excludes the whole city and the check passes by placing nothing.
    const busy = [];
    for (let i = 0; i <= GRID; i++) busy.push({ i, j: 2 }, { i, j: 3 });
    let touched = 0;
    let tries = 0;
    for (let n = 0; n < 8; n++) {
      setClosedLanes([]);
      const s = new THREE.Scene();
      const t = createTraffic(makeRng(seed + 300 + n), s, 12);
      for (let step = 0; step < 200; step++) t.update(1 / 60);
      const rw = createRoadwork(makeRng(seed + 400 + n), s, null);
      if (!rw.place(t.taxi, t.cars, busy)) continue;
      tries += 1;
      const e = cityNetwork().laneById.get(rw.closedLaneIds[0]).edge;
      for (const end of [e.a, e.b]) {
        const node = cityNetwork().nodeById.get(end);
        if (busy.some((b) => b.i === node.gi && b.j === node.gj)) touched += 1;
      }
    }
    check('a zone never closes a street a rider is waiting in', tries > 0 && touched === 0,
      `${tries} placements, ${touched} on an occupied corner`);
  }

  // Same seed, same street. The zone is part of the *situation*, so `?run=` has to reproduce it.
  {
    const build = () => {
      setClosedLanes([]);
      const s = new THREE.Scene();
      const t = createTraffic(makeRng(seed + 210), s, 24);
      for (let step = 0; step < 300; step++) t.update(1 / 60);
      const rw = createRoadwork(makeRng(seed + 211), s, null);
      rw.place(t.taxi, t.cars, []);
      return rw.closedLaneIds.join('+');
    };
    const first = build();
    check('the same run seed closes the same street', first === build(), first);
  }

  // Orange is the whole read, and the warm end of the wheel is spoken for twice: the taxi owns
  // yellow, and the urgency scale owns the ambers under it. Same clearance argument the ghost
  // paints get, for the same reason — at play zoom hue is most of what a small shape is.
  {
    const hueOf = (hex) => {
      const hsl = { h: 0, s: 0, l: 0 };
      new THREE.Color(hex).getHSL(hsl);
      return hsl.h * 360;
    };
    const taxiHue = hueOf(PALETTE.taxiBody);
    const gap = (hex) => Math.abs(hueOf(hex) - taxiHue);
    check('roadworks orange is clearly not the taxi',
      gap(PALETTE.cone) > 20 && gap(PALETTE.barrier) > 20 && gap(PALETTE.hiVis) > 20,
      `cone ${gap(PALETTE.cone).toFixed(0)}°, barrier ${gap(PALETTE.barrier).toFixed(0)}°, `
      + `vest ${gap(PALETTE.hiVis).toFixed(0)}° from the taxi's ${taxiHue.toFixed(0)}°`);
  }

  // Leave the sim as it was found: `closedLanes` is module state in traffic.js, and anything below
  // this point would inherit a city with a street shut in it.
  setClosedLanes([]);
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

/**
 * Headless simulation probe. Runs the city generators and the traffic model in Node with no
 * browser and no GL context, and asserts on invariants.
 *
 * This exists because the previous prototype proved the expensive part of the loop is *seeing*
 * results. Anything checkable as a number should be checked here in milliseconds, so screenshots
 * are spent only on questions that genuinely need eyes.
 */

import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createLayout } from '../src/city/layout.js';
import { createGround } from '../src/city/ground.js';
import { createBuildings } from '../src/city/buildings.js';
import { createProps } from '../src/city/props.js';
import { createTraffic, lightPhase, getPriorityCorridor, isUnsignalised, ringAxisAt } from '../src/sim/traffic.js';
import { createPolice } from '../src/sim/police.js';
import { createFareSystem, cornerFor } from '../src/game/fares.js';
import { planOrigin } from '../src/game/route.js';
import { HALF_SPAN, ROAD_W, LANE, lineCoord, GRID } from '../src/city/grid.js';
import { findRoute, allIntersections } from '../src/game/route.js';

const seed = Number(process.argv[2] ?? 71624);
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
// the player with a timer stuck at an empty kerb.
{
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 44), fScene, 24);
  const fares = createFareSystem(makeRng(seed + 55), fScene);
  const ring = fares.timer.mesh;
  fTraffic.warmup(5);

  let onRider = false;
  let transferred = false;
  let followsTaxi = false;
  let hiddenAfter = false;
  let elapsed = 0;

  while (elapsed < 220 && !fares.state.gameOver) {
    fTraffic.update(1 / 60);
    const event = fares.update(1 / 60, fTraffic.taxi);
    elapsed += 1 / 60;

    const route = () => {
      const r = findRoute(planOrigin(fTraffic.taxi), fares.state.target);
      if (r) { fTraffic.taxi.route = r; fTraffic.taxi.routeConsumed = false; fares.markDirected(); }
    };

    if (event === 'spawned') {
      // Under the rider on the kerb, not at the junction centre.
      const c = cornerFor(fares.state.target.i, fares.state.target.j);
      onRider = Math.hypot(ring.position.x - c.x, ring.position.z - c.z) < 0.01;
      route();
    }
    if (event === 'pickup') { transferred = fares.timer.isTransferring(); route(); }
    if (transferred && !fares.timer.isTransferring() && !followsTaxi) {
      followsTaxi = Math.hypot(ring.position.x - fTraffic.taxi.x, ring.position.z - fTraffic.taxi.z) < 0.05;
    }
    // A 24s fare clock means the run may end on the timer rather than a delivery; the ring must
    // be cleared either way.
    if (event === 'delivered' || event === 'failed') { hiddenAfter = !ring.visible; break; }
  }

  check('the timer waits under the rider', onRider);
  check('the timer flies to the taxi at pickup', transferred);
  check('the timer then rides with the taxi', followsTaxi);
  check('the timer clears on delivery', hiddenAfter);

  // Colour has to carry the urgency on its own — drain it and read the hue back.
  // The ring is hidden after a delivery and update() no-ops while hidden, so show it first.
  ring.visible = true;
  const hues = [1, 0.75, 0.5, 0.25, 0.05].map((f) => {
    fares.timer.update(0.016, { x: 0, z: 0 }, f);
    return ring.material.color.getHexString();
  });
  const [full, , mid, , low] = hues;
  const green = (h) => parseInt(h.slice(2, 4), 16) > parseInt(h.slice(0, 2), 16);
  const red = (h) => parseInt(h.slice(0, 2), 16) > parseInt(h.slice(2, 4), 16) * 1.4;
  check('the timer ramps green to red as it drains', green(full) && !green(mid) && red(low),
    hues.join(' -> '));
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

  const ringCorners = [[0, 0], [0, GRID], [GRID, 0], [GRID, GRID]];
  check('ring corners keep their signals', ringCorners.every(([i, j]) => !isUnsignalised(i, j)));
  check('the rest of the ring has none',
    isUnsignalised(1, 0) && isUnsignalised(0, 1) && !isUnsignalised(1, 1));

  const perCar = rTraffic.stats.distance / rTraffic.stats.time / rTraffic.cars.length;
  check('traffic moves better than the old fixed-phase grid', perCar > 4.14,
    `${perCar.toFixed(2)} vs 4.14 units/s per car`);
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

// Average speed per car over the whole run — a stable throughput number, unlike a snapshot of
// how many cars happen to be moving at the instant the sim stops.
const throughput = stats.distance / stats.time / traffic.cars.length;
console.log(`\nthroughput: ${throughput.toFixed(2)} avg units/s per car`);

const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

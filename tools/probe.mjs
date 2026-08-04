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
import { createCollisions } from '../src/sim/collisions.js';
import { createPolice, POLICE_BUST_RANGE } from '../src/sim/police.js';
import { createFareSystem, cornerFor, MAX_FARES, SECOND_FARE_AFTER } from '../src/game/fares.js';
import { planOrigin } from '../src/game/route.js';
import { HALF_SPAN, ROAD_W, LANE, PITCH, lineCoord, GRID } from '../src/city/grid.js';
import { routePath } from '../src/game/routeline.js';
import { findRoute, allIntersections } from '../src/game/route.js';

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
  fTraffic.warmup(5);

  let ring = null;
  let onRider = false;
  let transferred = false;
  let followsTaxi = false;
  let hiddenAfter = false;
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
        // Under the rider on the kerb, not at the junction centre.
        const c = cornerFor(fare.target.i, fare.target.j);
        onRider = Math.hypot(ring.position.x - c.x, ring.position.z - c.z) < 0.01;
        route(fare);
      }
      if (type === 'pickup' && fare.slot.timer.mesh === ring) {
        transferred = fare.slot.timer.isTransferring();
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

  check('the timer waits under the rider', onRider);
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

// --- Taxi-vs-car collisions ------------------------------------------------
// The whole feature only fires while boosting, and its silent failure modes are: no impact ever
// detected, an impact that doesn't wreck the taxi, or the other car stuck in the stun state.
// Drive the taxi head-on into an unsuspecting car and assert the whole crash chain.
{
  const cScene = new THREE.Scene();
  const cTraffic = createTraffic(makeRng(seed + 44), cScene, CARS_DEFAULT);
  const cFares = createFareSystem(makeRng(seed + 55), cScene);
  const cTaxi = cTraffic.taxi;
  const collisions = createCollisions(cTraffic.cars, cTaxi);
  let hits = 0;
  collisions.onImpact(() => {
    hits += 1;
    // Mirror the main.js wiring: an impact wrecks the taxi and ends the run.
    cFares.crash();
  });

  cTraffic.warmup(3);

  // Park the taxi on top of an ambient car and start boosting.
  const victim = cTraffic.cars.find((c) => !c.isTaxi && c.state === 'drive');
  cTaxi.x = victim.x;
  cTaxi.z = victim.z;
  cTaxi.boost = true;

  for (let step = 0; step < 90; step++) {
    collisions.update();
    cTraffic.update(1 / 60);
    if (hits > 0 && !victim.stunned) break;
  }

  check('boosting into another car fires an impact', hits >= 1, `${hits} impacts`);
  check('the taxi is wrecked by the impact', cTaxi.crashed);
  check('game over fires with a collision reason', cFares.state.gameOver
    && /collision/i.test(cFares.state.failReason ?? ''), cFares.state.failReason);
  check('the other car recovers from stun onto a lane',
    !victim.stunned && victim.state === 'drive');
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

// Average speed per car over the whole run — a stable throughput number, unlike a snapshot of
// how many cars happen to be moving at the instant the sim stops.
const throughput = stats.distance / stats.time / traffic.cars.length;
console.log(`\nthroughput: ${throughput.toFixed(2)} avg units/s per car`);

const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

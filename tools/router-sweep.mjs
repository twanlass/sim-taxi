/**
 * Weight-tuning sweep for the road-hierarchy router.
 *
 * Runs the same fare sequence per seed through several weight combinations and averages
 * across seeds — a single seed produces too much trip-time variance to compare tunings.
 * Baseline is `findRoute` with uniform weights, which reduces Dijkstra to fewest-blocks
 * (equivalent to the previous BFS router).
 *
 *   node tools/router-sweep.mjs [runsPerSeed] [numSeeds]
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { findRoute, planOrigin, allIntersections } from '../src/game/route.js';
import { intersectionCentre, ARRIVE_RADIUS } from '../src/game/fares.js';

const CARS = 7;
const RUNS = Number(process.argv[2] ?? 40);
const SEEDS = Number(process.argv[3] ?? 8);
const STEP = 1 / 60;
const TIMEOUT = 120;
const STOPPED_V = 0.4;

function costFor(w) {
  return (lane) => {
    if (lane.klass === 'ring') return w.ring;
    if (lane.klass === 'arterial') return lane.withWave ? w.artWith : w.artAgainst;
    return w.side;
  };
}

function runSeed(seed, cost) {
  const rng = makeRng(seed);
  createLayout(makeRng(71624));
  const traffic = createTraffic(makeRng(71624 + 44), new THREE.Scene(), CARS);
  const taxi = traffic.taxi;
  traffic.warmup(10);
  const ints = allIntersections();

  const trips = [];
  let missed = 0, blocks = 0, count = 0;
  for (let n = 0; n < RUNS; n++) {
    const target = ints[rng.int(0, ints.length - 1)];
    const route = findRoute(planOrigin(taxi), target, cost);
    if (route === null) continue;
    blocks += route.length;
    count += 1;
    taxi.route = route;
    taxi.routeConsumed = false;
    const centre = intersectionCentre(target.i, target.j);
    let elapsed = 0, stopped = 0, arrived = false;
    while (elapsed < TIMEOUT) {
      traffic.update(STEP);
      elapsed += STEP;
      if (taxi.v < STOPPED_V) stopped += STEP;
      if (Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < ARRIVE_RADIUS) { arrived = true; break; }
    }
    if (arrived) trips.push({ elapsed, stopped }); else missed += 1;
    taxi.route = [];
  }

  const arr = trips.length;
  return {
    arr, missed,
    avgTrip: arr ? trips.reduce((s, t) => s + t.elapsed, 0) / arr : 0,
    avgStop: arr ? trips.reduce((s, t) => s + t.stopped, 0) / arr : 0,
    avgBlocks: count ? blocks / count : 0,
    viol: traffic.stats.violations,
  };
}

function evaluate(label, cost) {
  let arr = 0, missed = 0, viol = 0;
  const trips = [], stops = [], blocks = [];
  for (let s = 0; s < SEEDS; s++) {
    const seed = 10000 + s * 1237;
    const r = runSeed(seed, cost);
    arr += r.arr; missed += r.missed; viol += r.viol;
    trips.push(r.avgTrip); stops.push(r.avgStop); blocks.push(r.avgBlocks);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const meanTrip = mean(trips), meanStop = mean(stops), meanBlk = mean(blocks);
  const share = meanTrip > 0 ? (meanStop / meanTrip) * 100 : 0;
  console.log(
    `${label.padEnd(52)} `
    + `${meanTrip.toFixed(2).padStart(5)}s  `
    + `${meanStop.toFixed(2).padStart(5)}s  `
    + `${share.toFixed(1).padStart(4)}%  `
    + `${meanBlk.toFixed(2).padStart(4)}blk `
    + `arr ${arr}/${SEEDS * RUNS}${viol ? `  VIOL ${viol}` : ''}${missed ? `  MISS ${missed}` : ''}`
  );
  return { meanTrip, meanStop };
}

const UNIFORM = { ring: 1.0, artWith: 1.0, artAgainst: 1.0, side: 1.0 };
const SHIPPED = { ring: 0.90, artWith: 0.95, artAgainst: 1.00, side: 1.00 };

console.log(`# ${RUNS} fares × ${SEEDS} seeds = ${RUNS * SEEDS} trips per variant\n`);
console.log('label                                                 trip    stop  share  blocks');
console.log('-'.repeat(112));
const base = evaluate('baseline (uniform weights = fewest blocks)', costFor(UNIFORM));
const now = evaluate('shipped (ring 0.90 / with 0.95)', costFor(SHIPPED));
console.log(`\ndelta shipped vs baseline: trip ${(now.meanTrip - base.meanTrip).toFixed(2)}s `
  + `(${(((now.meanTrip - base.meanTrip) / base.meanTrip) * 100).toFixed(1)}%), `
  + `stop ${(now.meanStop - base.meanStop).toFixed(2)}s `
  + `(${(((now.meanStop - base.meanStop) / base.meanStop) * 100).toFixed(1)}%)`);

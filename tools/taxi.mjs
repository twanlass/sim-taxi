/**
 * The assertion that matters most for this prototype, and the one a screenshot can never make:
 * given a target, does the routed taxi actually *arrive* — while still obeying every signal?
 *
 * Drives the headless sim through N randomly chosen destinations and reports arrival times.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';

// Matches the game's default so these numbers describe the game as played, not a denser city.
const CARS = 7;
import { findRoute, planOrigin, allIntersections } from '../src/game/route.js';
import { intersectionCentre, ARRIVE_RADIUS } from '../src/game/fares.js';

const RUNS = Number(process.argv[2] ?? 20);
const STEP = 1 / 60;
const TIMEOUT = 120;          // seconds of sim time allowed per fare

const rng = makeRng(9001);
createLayout(makeRng(71624));   // registers closed road segments before anything spawns
const traffic = createTraffic(makeRng(71624 + 44), new THREE.Scene(), CARS);
const taxi = traffic.taxi;
traffic.warmup(10);

const ints = allIntersections();
const times = [];
let failures = 0;
let unroutable = 0;

for (let run = 0; run < RUNS; run++) {
  const target = ints[rng.int(0, ints.length - 1)];
  const centre = intersectionCentre(target.i, target.j);

  const route = findRoute(planOrigin(taxi), target);
  if (route === null) { unroutable += 1; continue; }
  taxi.route = route;
  taxi.routeConsumed = false;

  const planned = route.length;
  let elapsed = 0;
  let arrived = false;

  while (elapsed < TIMEOUT) {
    traffic.update(STEP);
    elapsed += STEP;
    if (Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < ARRIVE_RADIUS) { arrived = true; break; }
  }

  if (arrived) {
    times.push(elapsed);
  } else {
    failures += 1;
    console.log(`  MISS target (${target.i},${target.j}) — ${planned} turns planned, `
      + `${taxi.route.length} unconsumed, taxi at (${taxi.x.toFixed(0)},${taxi.z.toFixed(0)}) heading to (${taxi.i},${taxi.j})`);
  }
  taxi.route = [];
}

const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
const max = times.length ? Math.max(...times) : 0;

console.log(`arrived ${times.length}/${RUNS}  (unroutable ${unroutable}, missed ${failures})`);
console.log(`trip time: avg ${avg.toFixed(1)}s, worst ${max.toFixed(1)}s`);
console.log(`red-light violations: ${traffic.stats.violations}`);
console.log(`route desyncs: ${traffic.stats.routeDesync}`);
console.log(`min gap between vehicles: ${traffic.stats.minGap.toFixed(2)}`);

const ok = failures === 0 && unroutable === 0 && traffic.stats.violations === 0
  && traffic.stats.routeDesync === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);

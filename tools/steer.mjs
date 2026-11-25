/**
 * Pac-Man steering (src/game/steer.js), headless: what a screenshot cannot say.
 *
 * 1. A swipe means what it looks like: `readSwipe` against the game's own camera axes.
 * 2. A steered taxi arrives: a "player" who queues the next turn of the best route at every corner
 *    — through the real `steerPlan`, the real one-step route and the real traffic model — reaches
 *    every target, with no red run and no route desync.
 * 3. Hands off and empty, it goes straight on wherever it can and never stops at a dead end.
 * 4. Hands off with a rider aboard, it drives itself to the drop-off (`auto`).
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { findRoute, planOrigin, allIntersections } from '../src/game/route.js';
import { intersectionCentre, ARRIVE_RADIUS } from '../src/game/fares.js';
import { steerPlan, readSwipe, decisionLane, exitDirs } from '../src/game/steer.js';
import { RIGHT, UP, VIEW_DIR } from '../src/game/camera.js';
import { snapStick } from '../src/game/joystick.js';
import { DIR } from '../src/city/grid.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// --- 1. Swipes ----------------------------------------------------------------------------------
// The game's projection, up to scale: screen right is RIGHT, and a ground vector's screen-up is
// its UP component foreshortened by the camera's elevation.
const lift = VIEW_DIR.y;
const toScreen = (dx, dz) => {
  const v = new THREE.Vector3(dx, 0, dz);
  return { x: v.dot(RIGHT), y: -v.dot(UP) * lift };
};
// Heading +X runs down-right on screen; its right (+Z) is down-left and its left (-Z) up-right.
check('swipe along the heading is straight on', readSwipe(1, 0.6, DIR.PX, toScreen) === 'straight');
check('swipe against the heading is backwards', readSwipe(-1, -0.6, DIR.PX, toScreen) === 'back');
check('a thumb\'s "up" heading +X turns toward -Z', readSwipe(0, -1, DIR.PX, toScreen) === DIR.NZ);
check('a thumb\'s "down" heading +X turns toward +Z', readSwipe(0, 1, DIR.PX, toScreen) === DIR.PZ);
// Foreshortening lays every street ~29° off the horizontal, so heading -Z (up-right) a sideways
// thumb is nearly along the street, and it is up and down that turn.
check('a thumb\'s "up" heading -Z turns toward -X', readSwipe(0, -1, DIR.NZ, toScreen) === DIR.NX);
check('a thumb\'s "down" heading -Z turns toward +X', readSwipe(0, 1, DIR.NZ, toScreen) === DIR.PX);
check('a thumb\'s "left" heading -Z is backwards', readSwipe(-1, 0, DIR.NZ, toScreen) === 'back');

// The stick snaps absolutely to the street directions as drawn: right-and-up is -Z, right-and-down
// +X, left-and-up -X, left-and-down +Z — whatever the heading.
check('stick up-right is -Z', snapStick(1, -0.5, toScreen) === DIR.NZ);
check('stick down-right is +X', snapStick(1, 0.5, toScreen) === DIR.PX);
check('stick up-left is -X', snapStick(-1, -0.5, toScreen) === DIR.NX);
check('stick down-left is +Z', snapStick(-1, 0.5, toScreen) === DIR.PZ);

// --- 2. A steered taxi arrives -------------------------------------------------------------------
const STEP = 1 / 60;
const RUNS = Number(process.argv[2] ?? 20);
createLayout(makeRng(71624));
const traffic = createTraffic(makeRng(71624 + 44), new THREE.Scene(), 7);
const taxi = traffic.taxi;
traffic.warmup(10);

function drive(queueFor, autoFor = () => null) {
  const at = decisionLane(taxi);
  const queued = at ? queueFor(at) : null;
  const plan = steerPlan(taxi, queued, undefined, at ? autoFor(at) : null);
  taxi.route = plan.route;
  taxi.routeConsumed = false;
  traffic.update(STEP);
}

const rng = makeRng(4242);
const ints = allIntersections();
let arrived = 0;
let total = 0;
for (let run = 0; run < RUNS; run++) {
  const target = ints[rng.int(0, ints.length - 1)];
  const centre = intersectionCentre(target.i, target.j);
  let t = 0;
  let done = false;
  while (t < 120) {
    drive((at) => {
      const route = findRoute(planOrigin(taxi), target);
      const want = route?.[0];
      return want != null && want !== at.d ? want : null;
    });
    t += STEP;
    if (Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < ARRIVE_RADIUS) { done = true; break; }
  }
  if (done) { arrived += 1; total += t; } else {
    console.log(`  miss (${target.i},${target.j}): taxi at (${taxi.x.toFixed(0)},${taxi.z.toFixed(0)})`);
  }
}
check(`steered taxi reaches every target (${arrived}/${RUNS})`, arrived === RUNS);
check('no red run while steering', traffic.stats.violations === 0, `${traffic.stats.violations}`);
check('no route desync while steering', traffic.stats.routeDesync === 0, `${traffic.stats.routeDesync}`);

// --- 3. Hands off, empty ------------------------------------------------------------------------
let turnedWithStraight = 0;
let deadEnds = 0;
let emptyRoute = 0;
let stillFor = 0;
let longestStill = 0;
let lastState = taxi.state;
for (let t = 0; t < 240; t += STEP) {
  const at = decisionLane(taxi);
  const straightThere = at ? exitDirs(at.lane).includes(at.d) : true;
  drive(() => null);
  if (taxi.state === 'drive' && !taxi.route.length) emptyRoute += 1;
  if (lastState === 'drive' && taxi.state === 'turn') {
    if (!straightThere) deadEnds += 1;
    if (taxi.turn.hand !== 'straight' && straightThere) turnedWithStraight += 1;
  }
  stillFor = taxi.v < 0.05 ? stillFor + STEP : 0;
  longestStill = Math.max(longestStill, stillFor);
  lastState = taxi.state;
  if (taxi.crashed) break;
}
check('hands off, the taxi goes straight on wherever it can', turnedWithStraight === 0,
  `${turnedWithStraight} turns taken with straight on available`);
check(`hands off, it turns out of a dead end on its own (${deadEnds} met)`, deadEnds > 0 && emptyRoute === 0,
  `${emptyRoute} frames with no route`);
// A red is 30s at most here; anything near a minute standing still is a car waiting on nobody.
check('hands off, it is never parked waiting for input', longestStill < 45, `${longestStill.toFixed(1)}s still`);
check('no red run hands off', traffic.stats.violations === 0, `${traffic.stats.violations}`);

// --- 4. Hands off, a rider aboard ----------------------------------------------------------------
let selfArrived = 0;
const SELF = 10;
for (let run = 0; run < SELF; run++) {
  const target = ints[rng.int(0, ints.length - 1)];
  const centre = intersectionCentre(target.i, target.j);
  for (let t = 0; t < 120; t += STEP) {
    drive(() => null, () => findRoute(planOrigin(taxi), target)?.[0] ?? null);
    if (Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < ARRIVE_RADIUS) { selfArrived += 1; break; }
  }
}
check(`hands off with a rider, it drives itself to the drop-off (${selfArrived}/${SELF})`, selfArrived === SELF);

console.log(`steered trips: mean ${(total / Math.max(1, arrived)).toFixed(1)}s`);
console.log(`${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);

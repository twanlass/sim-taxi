/**
 * Pac-Man steering (src/game/steer.js), headless: what a screenshot cannot say.
 *
 * 1. A swipe means what it looks like: `readSwipe` against the game's own camera axes.
 * 2. A steered taxi arrives: a "player" who queues the next turn of the best route at every corner
 *    — through the real `steerPlan`, the real one-step route and the real traffic model — reaches
 *    every target, with no red run and no route desync.
 * 3. With nothing queued it goes straight on wherever it can, and at a dead end it holds at the
 *    line instead of choosing for the player — and one queued exit lets it go.
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

function drive(queueFor) {
  const at = decisionLane(taxi);
  const queued = at ? queueFor(at) : null;
  const plan = steerPlan(taxi, queued);
  taxi.route = plan.route;
  taxi.routeConsumed = false;
  taxi.steerHold = plan.hold;
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

// --- 3. Hands off --------------------------------------------------------------------------------
let turnedWithStraight = 0;
let heldAtDeadEnd = 0;
let enteredWhileHeld = 0;
let commits = 0;
let lastState = taxi.state;
let released = 0;
let lastHeld = -Infinity;
let pick = null;
for (let t = 0; t < 240; t += STEP) {
  const at = decisionLane(taxi);
  const straightThere = at ? exitDirs(at.lane).includes(at.d) : true;
  const heldBefore = Boolean(taxi.steerHold);
  // Nothing queued — except that after two seconds parked at a dead end, the "player" swipes
  // toward the first exit there.
  const stuck = heldBefore && taxi.v < 0.05;
  drive((here) => {
    if (stuck && (taxi.stuckFor ?? 0) >= 2 && pick == null) pick = exitDirs(here.lane)[0];
    return pick;
  });
  taxi.stuckFor = stuck ? (taxi.stuckFor ?? 0) + STEP : 0;
  if (lastState === 'drive' && taxi.state === 'turn') {
    commits += 1;
    pick = null;
    if (taxi.turn.hand !== 'straight' && straightThere && !heldBefore) turnedWithStraight += 1;
    if (heldBefore && (taxi.stuckFor ?? 0) < 2 && taxi.route.length === 0) enteredWhileHeld += 1;
    if (t - lastHeld < 1) released += 1;
  }
  if (stuck && (taxi.stuckFor ?? 0) > 1) heldAtDeadEnd += 1;
  if (heldBefore) lastHeld = t;
  lastState = taxi.state;
  if (taxi.crashed) break;
}
check(`hands off, the taxi goes straight on wherever it can (${commits} junctions)`,
  turnedWithStraight === 0, `${turnedWithStraight} turns taken with straight on available`);
check('a dead end with nothing queued holds at the line', heldAtDeadEnd > 0 && enteredWhileHeld === 0,
  `held ${heldAtDeadEnd} frames, entered ${enteredWhileHeld} times unasked`);
check('one queued exit releases a dead-end hold', released > 0);
check('no red run hands off', traffic.stats.violations === 0, `${traffic.stats.violations}`);

console.log(`steered trips: mean ${(total / Math.max(1, arrived)).toFixed(1)}s`);
console.log(`${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);

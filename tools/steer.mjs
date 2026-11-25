/**
 * Pac-Man steering (src/game/steer.js), headless: what a screenshot cannot say.
 *
 * 1. A swipe means what it looks like: `readSwipe` against the game's own camera axes.
 * 2. A steered taxi arrives: a "player" who queues the next turn of the best route at every corner
 *    — through the real `steerPlan`, the real one-step route and the real traffic model — reaches
 *    every target, with no red run and no route desync.
 * 3. Hands off, it goes straight on wherever it can and never stops at a dead end.
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
import { DIR, leftOf } from '../src/city/grid.js';

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
// Heading +X (down-right), the way back is -X (up-left). Straight up sits on the border between
// -Z and -X; leaving the way back out makes it the left turn rather than a push that does nothing.
const fromPX = { exclude: DIR.NX };
check('heading +X, stick straight up is the left turn (-Z)', snapStick(0, -1, toScreen, fromPX) === DIR.NZ);
check('heading +X, stick straight left is the right turn (+Z)', snapStick(-1, 0.05, toScreen, fromPX) === DIR.PZ);
check('the way back is never picked', [0, 1, 2, 3, 4, 5, 6, 7].every((k) => {
  const a = (k * Math.PI) / 4 + 0.1;
  return snapStick(Math.cos(a), Math.sin(a), toScreen, fromPX) !== DIR.NX;
}));
// Squarely backwards (up-left, along -X) says nothing rather than handing over a turn.
check('heading +X, stick squarely backwards is nothing', snapStick(-1, -0.55, toScreen, fromPX) === null);
// A held push keeps its direction across a wobble over the border, and lets go of it well past it.
const nearRight = (deg) => [Math.cos((deg * Math.PI) / 180), -Math.sin((deg * Math.PI) / 180)];
check('a hold keeps -Z through a wobble just below the horizontal',
  snapStick(...nearRight(-5), toScreen, { prev: DIR.NZ }) === DIR.NZ);
check('fresh, the same push reads +X', snapStick(...nearRight(-5), toScreen) === DIR.PX);
check('a hold gives -Z up once the push is well past the border',
  snapStick(...nearRight(-20), toScreen, { prev: DIR.NZ }) === DIR.PX);

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

// --- 2b. A push a beat late still wins the corner ------------------------------------------------
// Committed to a turn at the hold line, the taxi can still be asked for another exit in the run-up
// — straight on, or the other way — and takes it (`retakeCrossing` in sim/traffic.js). Before, a
// turn committed at the line overruled the stick and the car turned against it.
let retakes = 0;
let retaken = 0;
for (let t = 0; t < 240 && retakes < 12; t += STEP) {
  // Steer for turns, so the line commits to plenty of them.
  drive((at) => {
    const ex = exitDirs(at.lane).filter((d) => d !== at.d);
    return ex.length ? ex[0] : null;
  });
  if (taxi.state === 'turn' && taxi.turn.hand !== 'straight' && taxi.turnT * taxi.turnLen < 0.5) {
    const ex = exitDirs(taxi.lane).filter((d) => d !== taxi.dOut);
    if (!ex.length) continue;
    const want = ex[0];
    retakes += 1;
    taxi.lateTurn = Object.assign([want], { force: true });
    traffic.update(STEP);
    t += STEP;
    if (taxi.dOut === want) retaken += 1;
  }
}
// Forced, nothing refuses it — not oncoming traffic, not a full exit lane.
check(`a committed turn can be retaken in the run-up (${retaken}/${retakes})`,
  retakes >= 6 && retaken === retakes);
check('no red run after retakes', traffic.stats.violations === 0, `${traffic.stats.violations}`);

// --- 3. Hands off ------------------------------------------------------------------------
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

// --- 4. The stick's lane ---------------------------------------------------------------------
// Steered by the stick, `stickLane` is the overtake: out pulls into the oncoming lane with no car
// and no Loco needed, in tucks back. Rams stay the player's (`canPass`).
let outAt = null;
let backAt = null;
taxi.stickLane = 'in';
for (let t = 0, phase = 'wait'; t < 120; t += STEP) {
  drive(() => null);
  const onLane = taxi.state === 'drive' && taxi.s < 2 && taxi.lane.length > 10;
  if (phase === 'wait' && onLane) { taxi.stickLane = 'out'; phase = 'out'; outAt = null; }
  else if (phase === 'out' && taxi.pass >= 0.99) { outAt = t; taxi.stickLane = 'in'; phase = 'in'; }
  else if (phase === 'in' && taxi.pass <= 0.01 && !taxi.passing) { backAt = t; break; }
  // A dead end or a corner while out sends it back in (steer.js) — start over on the next lane.
  if (phase === 'out' && taxi.state === 'turn' && taxi.turn.hand !== 'straight') {
    taxi.stickLane = 'in'; phase = 'wait';
  }
}
check('stick out pulls the taxi fully into the oncoming lane', outAt !== null);
check('stick in tucks it back', backAt !== null);

// Out in the oncoming lane, a left is taken from there (Tyler: "Why not just support turning left
// even when in the oncoming lane?"), and the pass ends on the lane after the corner. The path has to
// stay a path: no frame jumps further than the car can drive, which a frozen offset folding the
// arc over itself would.
let leftsFromOut = 0;
let leftsTried = 0;
let worstJump = 0;
let backAfter = 0;
let crashedOut = false;
let backwards = 0;
for (let t = 0, phase = 'wait', want = null, px = taxi.x, pz = taxi.z; t < 240 && leftsFromOut < 6; t += STEP) {
  drive((at) => (phase === 'turning' ? want : null));
  const step = Math.hypot(taxi.x - px, taxi.z - pz);
  worstJump = Math.max(worstJump, step - taxi.v * STEP);
  // An offset bigger than the arc's radius folds the path back on itself: the car runs backwards.
  if (step > 1e-4 && ((taxi.x - px) * Math.cos(taxi.yaw) - (taxi.z - pz) * Math.sin(taxi.yaw)) < -0.25 * step) backwards += 1;
  px = taxi.x; pz = taxi.z;
  if (taxi.crashed) { crashedOut = true; break; }
  const at = decisionLane(taxi);
  if (phase === 'wait' && taxi.state === 'drive' && taxi.s < 2 && at
    && exitDirs(at.lane).includes(leftOf(at.d))) {
    taxi.stickLane = "out"; want = leftOf(at.d); phase = "turning"; leftsTried += 1;
  } else if (phase === 'turning' && taxi.state === 'turn' && taxi.turn.hand !== 'straight') {
    if (taxi.dOut === want && taxi.pass > 0.9) leftsFromOut += 1;
    taxi.stickLane = 'in'; phase = 'after';
  } else if (phase === 'after' && taxi.state === 'drive') {
    if (taxi.pass <= 0.01) { backAfter += 1; phase = 'wait'; }
  }
}
check(`out in the oncoming lane, the left is taken from there (${leftsFromOut}/${leftsTried})`,
  leftsFromOut >= 4 && leftsFromOut >= leftsTried - 1);
check('and the pass ends on the lane after the corner', backAfter >= leftsFromOut - 1, `${backAfter}`);
check('a corner from the oncoming lane never runs backwards', backwards === 0, `${backwards} frames`);
check('a corner from the oncoming lane never jumps', worstJump < 0.3 && !crashedOut,
  `${worstJump.toFixed(2)} units${crashedOut ? ', crashed' : ''}`);
taxi.stickLane = undefined;

console.log(`steered trips: mean ${(total / Math.max(1, arrived)).toFixed(1)}s`);
console.log(`${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);

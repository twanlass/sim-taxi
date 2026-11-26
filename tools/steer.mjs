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
import { createTraffic, boostCruise, SPEED, stageCar, releaseCar } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { findRoute, planOrigin, allIntersections } from '../src/game/route.js';
import { intersectionCentre, ARRIVE_RADIUS } from '../src/game/fares.js';
import { steerPlan, readSwipe, decisionLane, exitDirs } from '../src/game/steer.js';
import { RIGHT, UP, VIEW_DIR } from '../src/game/camera.js';
import { snapStick } from '../src/game/joystick.js';
import { DIR, leftOf, lineX, lineZ, GRID_I, GRID_J } from '../src/city/grid.js';
import { createFreeDrive, roadCorridors, screenToGround, magnet, stickMagnet, FREE_TUNING } from '../src/game/freedrive.js';
// The cruise-and-Loco model, which every free-driving check here was written against. The gas
// pedal (the default) gets its own check below.
// pedal (the default) gets its own check below. They also aim the stick by projecting a heading
// onto the screen, which is the exact reading (`stickCorrect: 1`); the default gets its own check.
// And on the first cut's steering, not Tyler's tuned defaults (game/freedrive.js, FREE_TUNING): these
// check the weight and the turn mechanisms, which his stiffer, sharper values leave nothing of to
// measure — a quarter turn at the top in 0.33s, on the 4 rad/s backstop.
const CRUISE = () => ({ ...FREE_TUNING, gasPedal: 0, stickCorrect: 1, magnetOnStick: 0, assistDeg: 16, laneAssist: 0,
  loco: null, turnTop: 19, turnGain: 8, yawLag: 0.11, relSpan: 0.6, steerCurve: 1, settle: 3, wallTurn: 7, gasAccel: 12 });
import { cityNetwork } from '../src/city/roadnet.js';
import { deadZone, nearestInDirection, STICK_DEAD } from '../src/game/gamepad.js';

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

// --- 5. The stick's nudge -----------------------------------------------------------------------
// The thumb's sideways push leans the taxi across its lane, paced by road: full lean within a few
// units, never more than NUDGE_MAX, back to the middle when let go, and no slide while stopped.
let peakNudge = 0;
let leaned = false;
for (let t = 0; t < 30; t += STEP) {
  taxi.stickNudge = t < 4 ? 1 : 0;
  drive(() => null);
  peakNudge = Math.max(peakNudge, Math.abs(taxi.nudge));
  if (t > 1 && t < 4 && taxi.state === 'drive' && taxi.v > 3 && taxi.nudge > 0.5) leaned = true;
}
check('a sideways push leans the taxi across its lane', leaned, `peak ${peakNudge.toFixed(2)}`);
check('the lean never passes NUDGE_MAX', peakNudge <= 0.6 + 1e-6, peakNudge.toFixed(3));
check('let go, it settles back to the middle', Math.abs(taxi.nudge) < 0.05, taxi.nudge.toFixed(3));
taxi.stickNudge = 0;

// --- 6. Free driving (game/freedrive.js) ----------------------------------------------------------
// The stick as a heading, the taxi as a body off the lanes. A screen push comes back as the ground
// direction it was drawn from; the body stays on the island, out of the river and out of anything
// solid, and is free to cross a pavement; a "player" who points the stick at the next junction of
// the best route gets everywhere; hands off it stops against whatever ends the ground; a turn at
// Loco carries on before it bites and then grips; and handed back, the traffic model picks the car
// up on a lane and drives it on.
{
  const back = (dx, dz) => { const v = toScreen(dx, dz); return screenToGround(v.x, v.y, toScreen); };
  const round = [[1, 0], [0, 1], [-1, 0], [0, -1], [0.6, -0.8]].every(([dx, dz]) => {
    const g = back(dx, dz);
    return g && Math.hypot(g.x - dx, g.z - dz) < 1e-6;
  });
  check('a screen push comes back as the ground direction it was drawn from', round);
  check('the magnet takes a heading 10° off a street onto it', Math.abs(magnet(0.17)) < 1e-9);
  check('the magnet leaves a 30° heading alone', Math.abs(magnet(0.52) - 0.52) < 1e-9);

  const net = cityNetwork();
  let aim = null;      // world point the "thumb" is pointing the taxi at, or null for hands off
  let isLive = true;
  let push = null;     // a raw stick vector, for the tests that hold a direction rather than aim
  const free = createFreeDrive({ tune: CRUISE(),
    taxi,
    toScreen,
    live: () => isLive,
    stick: () => {
      if (push) return push;
      if (!aim) return null;
      const v = toScreen(aim.x - taxi.x, aim.z - taxi.z);
      const l = Math.hypot(v.x, v.y) || 1;
      return { dx: (v.x / l) * 30, dy: (v.y / l) * 30, len: 30 };
    },
  });
  const tick = () => { free.update(STEP); traffic.update(STEP); };
  const roads = { inside: free.drivable };

  let offRoad = 0;
  let freeArrived = 0;
  let freeTime = 0;
  const FREE_RUNS = 10;
  for (let run = 0; run < FREE_RUNS; run++) {
    const target = ints[rng.int(0, ints.length - 1)];
    const centre = intersectionCentre(target.i, target.j);
    for (let t = 0; t < 120; t += STEP) {
      // Aim at the junction the route goes through next — the one ahead, or the target itself.
      const route = findRoute(planOrigin(taxi), target);
      const next = intersectionCentre(taxi.i, taxi.j);
      aim = route && route.length ? next : centre;
      if (Math.hypot(taxi.x - next.x, taxi.z - next.z) < 3 && route?.length) {
        // In the box: point down the street the route leaves by.
        const [vx, vz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][route[0]];
        aim = { x: taxi.x + vx * 10, z: taxi.z + vz * 10 };
      }
      tick();
      if (!roads.inside(taxi.x, taxi.z)) offRoad += 1;
      if (Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < ARRIVE_RADIUS) { freeArrived += 1; freeTime += t; break; }
    }
  }
  check(`free-driven, the taxi reaches every target (${freeArrived}/${FREE_RUNS})`, freeArrived === FREE_RUNS);
  check('free-driven, the body never leaves the island or enters the river', offRoad === 0, `${offRoad} frames`);
  check('free-driven, the taxi is off the traffic model', taxi.free === true);

  // Hands off: it rolls on its heading until the ground runs out.
  aim = null;
  taxi.stalled = false;
  let rolled = 0;
  for (let t = 0; t < 40; t += STEP) {
    const px = taxi.x; const pz = taxi.z;
    tick();
    rolled += Math.hypot(taxi.x - px, taxi.z - pz);
    if (!roads.inside(taxi.x, taxi.z)) offRoad += 1;
  }
  check('hands off, it keeps rolling', rolled > 20, `${rolled.toFixed(1)} units`);
  // It used to end up stopped against the edge. The walls are ice now, so where it meets the edge
  // at a slant it slides along it instead — and either way it never leaves the ground.
  check('hands off, it never leaves the drivable ground', offRoad === 0,
    `v ${taxi.v.toFixed(2)}`);

  // Weight and grip. From a straight run at full Loco, snap the stick a quarter turn left. The taxi
  // must carry on a while before its course comes round (momentum), and once the nose is round the
  // velocity must be back on it within half a second (no ice).
  {
    const corridors = roadCorridors(net);
    const lane = net.lanes.filter((l) => l.path && l.length > 12)[0];
    const p0 = lane.path.at(0);
    const p1 = lane.path.at(lane.length);
    const yaw0 = Math.atan2(-(p1.z - p0.z), p1.x - p0.x);
    const open = createFreeDrive({ tune: CRUISE(), taxi, toScreen, live: () => true, stick: () => push, net,
      locoSpeed: () => boostCruise() });
    // An open plain: this instance has no `solid`, and the test is over before the island ends.
    open.update(STEP);
    open.place(p0.x, p0.z, yaw0);
    taxi.boost = true;
    taxi.braking = false;
    taxi.stalled = false;
    const hold = (yaw) => { const v = toScreen(Math.cos(yaw), -Math.sin(yaw)); push = { dx: v.x, dy: v.y, len: 30 }; };
    hold(yaw0);
    taxi.v = boostCruise();
    for (let t = 0; t < 0.3; t += STEP) open.update(STEP);
    const topSeen = taxi.v;
    const at = { x: taxi.x, z: taxi.z };
    hold(yaw0 + Math.PI / 2);
    let carried = 0;       // distance along the old heading before the nose is 80° round
    let roundAt = null;
    let settled = null;    // seconds after the nose came round that the course matched it
    let px = taxi.x; let pz = taxi.z;
    for (let t = 0; t < 3; t += STEP) {
      open.update(STEP);
      const course = Math.atan2(-(taxi.z - pz), taxi.x - px);
      px = taxi.x; pz = taxi.z;
      const turned = Math.abs(Math.atan2(Math.sin(taxi.yaw - yaw0), Math.cos(taxi.yaw - yaw0)));
      if (roundAt == null && turned > (80 * Math.PI) / 180) {
        roundAt = t;
        carried = (taxi.x - at.x) * Math.cos(yaw0) - (taxi.z - at.z) * Math.sin(yaw0);
      }
      const off = Math.abs(Math.atan2(Math.sin(course - taxi.yaw), Math.cos(course - taxi.yaw)));
      if (roundAt != null && settled == null && turned > (88 * Math.PI) / 180 && off < (3 * Math.PI) / 180) settled = t - roundAt;
    }
    push = null;
    taxi.boost = false;
    check('free-driven, Loco tops out at the game\'s own Loco speed', Math.abs(topSeen - boostCruise()) < 0.5,
      `${topSeen.toFixed(1)} of ${boostCruise().toFixed(1)}`);
    check('a quarter turn at Loco carries the taxi on before it comes round (weight)',
      roundAt != null && roundAt > 0.5 && carried > 6, `${roundAt?.toFixed(2)}s, ${carried.toFixed(1)} units`);
    check('...and once the nose is round, the course is back on it within half a second (grip)',
      settled != null && settled < 0.5, `${settled?.toFixed(2)}s`);
    // A pavement is open ground and a building is not.
    console.log(`free quarter turn at Loco: nose round in ${roundAt?.toFixed(2)}s, ${carried.toFixed(1)} units carried, course back on the nose ${settled?.toFixed(2)}s later`);
    // The first spot off the side of any lane that is not road and not river or coast.
    let kerb = null;
    for (const l of net.lanes) {
      if (kerb || !l.path) continue;
      const a0 = l.path.at(0);
      const a1 = l.path.at(l.length);
      const mid = l.path.at(l.length / 2);
      const side = { x: -(a1.z - a0.z) / l.length, z: (a1.x - a0.x) / l.length };
      for (let r = 0; r < 12 && !kerb; r += 0.25) {
        const q = { x: mid.x + side.x * r, z: mid.z + side.z * r };
        if (!corridors.onRoad(q.x, q.z)) { if (corridors.inside(q.x, q.z)) kerb = q; break; }
      }
    }
    // A building-sized box: the field's seams are rounded over WALL_SMOOTH, so a box smaller than
    // that beside a road would be eaten by the rounding, which no real building is.
    const walled = roadCorridors(net, kerb ? [{ cx: kerb.x, cz: kerb.z, hx: 2, hz: 2 }] : []);
    check('a pavement is open ground', kerb && corridors.inside(kerb.x, kerb.z));
    check('...and a building standing on it is not', kerb && !walled.inside(kerb.x, kerb.z));
    // A wall met at a slant is a scrape along it, not a stop: into the east coast at 45°.
    open.place(lineX(GRID_I) - 1, lineZ(0) + 3, -Math.PI / 4);
    taxi.v = SPEED;
    hold(-Math.PI / 4);
    const z0 = lineZ(0) + 3;
    for (let t = 0; t < 1.5; t += STEP) open.update(STEP);
    push = null;
    // Ice: the slide keeps its speed. The first wall model kept half per second and ground to a halt.
    check('a wall met at a slant is a slide along it at full speed', taxi.v > 0.95 * SPEED && taxi.z - z0 > 9,
      `v ${taxi.v.toFixed(1)}, ${(taxi.z - z0).toFixed(1)} units along`);

    // A building box out on open ground: a glancing slide down its face keeps its speed and never
    // goes inside, a corner clipped on the way past is ridden round rather than snagged on, and a
    // head-on hit still stops.
    {
      const cx = (lineX(1) + lineX(2)) / 2;
      const cz = (lineZ(0) + lineZ(1)) / 2;
      const box = { cx, cz, hx: 3, hz: 3 };
      const boxed = createFreeDrive({ tune: CRUISE(), taxi, toScreen, live: () => true, stick: () => push, net, boxes: [box] });
      const R = boxed.tune.bodyR;
      boxed.update(STEP);
      check('the box test stands on open ground', open.drivable(cx - 3 - R - 3, cz) && open.drivable(cx, cz - 8));
      const run = (secs) => {
        let deepest = Infinity;
        let slowest = Infinity;
        for (let t = 0; t < secs; t += STEP) {
          boxed.update(STEP);
          deepest = Math.min(deepest, boxed.collider.distance(taxi.x, taxi.z));
          if (t > 0.1) slowest = Math.min(slowest, taxi.v);
        }
        return { deepest, slowest };
      };
      // 30° into the west face, heading up it.
      const glance = Math.atan2(-Math.cos(Math.PI / 6), Math.sin(Math.PI / 6));
      boxed.place(cx - 3 - R - 0.3, cz - 4, glance);
      taxi.v = SPEED;
      hold(glance);
      const slide = run(0.9);
      check('a 30° glance down a building keeps its speed', slide.slowest > 0.9 * SPEED,
        `slowest ${slide.slowest.toFixed(2)} of ${SPEED.toFixed(1)}`);
      check('...and the body never goes into the building', slide.deepest > R - 0.08,
        `${slide.deepest.toFixed(2)} from the wall against a body of ${R}`);
      // Straight up past the south-west corner, the body overlapping it by 0.4.
      boxed.place(cx - 3 - R + 0.4, cz - 3 - 5, -Math.PI / 2);
      taxi.v = SPEED;
      hold(-Math.PI / 2);
      const corner = run(1.5);
      check('a corner clipped on the way past is ridden round, not snagged on',
        corner.slowest > 0.85 * SPEED && taxi.z > cz + 3, `slowest ${corner.slowest.toFixed(2)}, z ${(taxi.z - cz).toFixed(1)} past the middle`);
      // Square on.
      boxed.place(cx - 3 - R - 3, cz, 0);
      taxi.v = SPEED;
      hold(0);
      run(1);
      check('a building met head-on still stops the taxi', taxi.v < 1 && taxi.x < cx - 3 - R + 0.1,
        `v ${taxi.v.toFixed(2)}`);
      push = null;
      // ...and the brake held backs it out (brake to reverse).
      const wallX = taxi.x;
      taxi.braking = true;
      run(1.5);
      taxi.braking = false;
      check('nosed into a building, the brake held backs the taxi out', wallX - taxi.x > 2,
        `${(wallX - taxi.x).toFixed(1)} units back off the wall`);
      run(2);
    }

    // Loco is the button: down is Loco, up is cruise, at once — not after the boost's one-second
    // tail for the rules (Tyler: "when you're letting go, it's off").
    {
      let held = true;
      const loco = createFreeDrive({ tune: CRUISE(), taxi, toScreen, live: () => true, stick: () => null, net,
        locoSpeed: () => boostCruise(), locoHeld: () => held });
      loco.update(STEP);
      loco.place(0, lineZ(0) + 30, Math.PI / 2);
      taxi.v = SPEED;
      for (let t = 0; t < 1.5; t += STEP) loco.update(STEP);
      const top = taxi.v;
      held = false;
      for (let t = 0; t < 0.5; t += STEP) loco.update(STEP);
      check('letting go of Loco is back to cruise within half a second', top > boostCruise() - 0.5 && taxi.v < SPEED + 0.3,
        `${top.toFixed(1)} → ${taxi.v.toFixed(1)} u/s`);
    }
    // The gas pedal: no cruise. Off the pedals it rolls to a stop, the gas takes it to the top, the
    // brake stops it — and the gas never gets a boost involved (that is main.js and game/boost.js).
    {
      let gasDown = false;
      const g = createFreeDrive({ taxi, toScreen, live: () => true, stick: () => null, net,
        locoSpeed: () => boostCruise(), locoHeld: () => gasDown });
      // The gas-pedal model, whichever one ships (`gasPedal`).
      g.tune.gasPedal = 1;
      // A hold before reverse, so "stopped" can be read at the end of a second of braking rather
      // than the car already backing away (the shipped `reverseDelay` is 0).
      g.tune.reverseDelay = 0.3;
      g.update(STEP);
      g.place(0, lineZ(0) + 30, Math.PI / 2);
      taxi.v = SPEED;
      taxi.braking = false;
      for (let t = 0; t < 1; t += STEP) g.update(STEP);
      const rolled = taxi.v;
      for (let t = 0; t < 4; t += STEP) g.update(STEP);
      const stopped = taxi.v;
      gasDown = true;
      // What the pill's press does in the game (`holdLocoMode`): a stalled car drives on.
      taxi.stalled = false;
      taxi.stun = 0;
      // Each phase gets its own run-up, heading south from the north edge, so none of them meets
      // the coast (which stops a car head-on, and would read as the pedal doing nothing).
      g.place(0, lineZ(0) + 4, -Math.PI / 2);
      taxi.v = 0;
      for (let t = 0; t < 2.2; t += STEP) g.update(STEP);
      const floored = taxi.v;
      gasDown = false;
      g.place(0, lineZ(0) + 4, -Math.PI / 2);
      taxi.v = boostCruise();
      taxi.braking = true;
      for (let t = 0; t < 1; t += STEP) g.update(STEP);
      taxi.braking = false;
      check('gas pedal: off the pedals it rolls, slowing', rolled < SPEED - 1 && rolled > SPEED - 5,
        `${SPEED.toFixed(1)} → ${rolled.toFixed(1)} in 1s`);
      check('...and comes to a stop', stopped === 0, `${stopped.toFixed(2)}`);
      const gasTop = g.tune.loco ?? boostCruise();
      check('...the gas takes it from a standstill to the top', Math.abs(floored - gasTop) < 0.3,
        `${floored.toFixed(1)} of ${gasTop.toFixed(1)}`);
      check('...and the brake stops it', taxi.v === 0, `${taxi.v.toFixed(2)}`);
      // With no hold before reverse (`reverseDelay` 0, shipped), the brake at speed is still the
      // brake: a clock that had not started once read 0 >= 0 and braked at `reverseAccel` instead.
      g.tune.reverseDelay = 0;
      g.place(0, lineZ(0) + 4, -Math.PI / 2);
      taxi.v = boostCruise();
      taxi.braking = true;
      let stopAt = null;
      for (let t = 0; t < 2 && stopAt == null; t += STEP) { g.update(STEP); if (taxi.v <= 0) stopAt = t; }
      taxi.braking = false;
      const brakeTime = boostCruise() / g.tune.brake;
      check('...and with no hold before reverse, braking from the top still takes the brake\'s time',
        stopAt != null && stopAt < brakeTime + 0.1, `${stopAt?.toFixed(2)}s, ${brakeTime.toFixed(2)}s at the brake`);
    }
    // Turn steering (`turnSteer`): right is a right turn (yaw falling) whichever
    // way the taxi is pointing, and a push straight up is no turn at all.
    {
      const rel = createFreeDrive({ tune: { ...CRUISE(), turnSteer: 1 }, taxi, toScreen, live: () => true,
        stick: () => push, net });
      rel.update(STEP);
      for (const yawStart of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        rel.place(0, lineZ(0) + 30, yawStart);
        taxi.v = SPEED;
        push = { dx: 34, dy: 0, len: 34 };
        for (let t = 0; t < 0.3; t += STEP) rel.update(STEP);
        const right = Math.atan2(Math.sin(taxi.yaw - yawStart), Math.cos(taxi.yaw - yawStart));
        // Clear of the heading magnet (16°), which would settle a hands-off heading onto the street.
        rel.place(0, lineZ(0) + 30, yawStart + 0.5);
        push = { dx: 0, dy: -34, len: 34 };
        for (let t = 0; t < 0.3; t += STEP) rel.update(STEP);
        const ahead = Math.atan2(Math.sin(taxi.yaw - yawStart - 0.5), Math.cos(taxi.yaw - yawStart - 0.5));
        check(`turn steering, facing ${yawStart.toFixed(2)}: a right push turns right`, right < -0.3,
          `${right.toFixed(2)} rad`);
        check(`turn steering, facing ${yawStart.toFixed(2)}: a push straight up holds the heading`,
          Math.abs(ahead) < 0.02, `${ahead.toFixed(3)} rad`);
      }
      push = null;
    }
    // The ¾ stick with the tilt taken out (`stickCorrect: 0`, the default): a push on the stick's
    // diagonal is a street, and the stick's axes split the streets evenly.
    {
      const deg = Math.PI / 180;
      const headingFor = (thumbDeg, c) => {
        const t = thumbDeg * deg;
        const g = screenToGround(Math.cos(t), -Math.sin(t), toScreen, c);
        return Math.round(((Math.atan2(-g.z, g.x) / deg) % 360 + 360) % 360);
      };
      const diag = [45, 135, 225, 315].map((t) => headingFor(t, 0));
      check('¾ stick, tilt corrected out: the four thumb diagonals are the four streets',
        diag.every((h) => h % 90 === 0) && new Set(diag).size === 4, diag.join(', '));
      const between = [headingFor(90, 0), headingFor(0, 0)];
      check('...and straight up or across lands halfway between two streets',
        between.every((h) => h % 90 === 45), between.join(', '));
      check('...while at 1 the 45° push is off its street, as drawn', headingFor(45, 1) % 90 !== 0,
        `${headingFor(45, 1)}`);
    }
    // The magnet measured on the stick: at the exact reading (`stickCorrect: 1`), every street's snap
    // window is the same ±16° of thumb centred on where the street is drawn — on the ground it was
    // lopsided, and the up-right street's window ran 16.8°..44.5°.
    {
      const deg = Math.PI / 180;
      const edges = [];
      for (const centre of [28.6, 151.4, 208.6, 331.4]) {
        const at = (t) => stickMagnet(Math.cos(t * deg), -Math.sin(t * deg), toScreen, 1, 16 * deg);
        edges.push(at(centre) != null && at(centre + 15.5) != null && at(centre - 15.5) != null
          && at(centre + 16.5) == null && at(centre - 16.5) == null);
      }
      check('magnet on the stick: every street snaps over ±16° of thumb round where it is drawn',
        edges.every(Boolean), edges.join(', '));
    }
    // No pivoting on the spot: a stopped car with the stick hard over keeps its heading, and one
    // rolling at walking pace turns, but slower than at cruise.
    {
      let stickPush = null;
      const pv = createFreeDrive({ taxi, toScreen, live: () => true, stick: () => stickPush, net,
        locoSpeed: () => boostCruise(), locoHeld: () => false });
      pv.tune.turnSteer = 1;
      // On the gas pedal, so a car left at a standstill stays there rather than pulling away to cruise.
      pv.tune.gasPedal = 1;
      pv.update(STEP);
      const turnOver = (speed) => {
        pv.place(lineX(1) + 2, lineZ(GRID_J) - 30, Math.PI / 2);
        taxi.v = speed;
        taxi.stalled = false;
        pv.tune.roll = 0;
        pv.update(STEP);
        const y0 = taxi.yaw;
        stickPush = { dx: 34, dy: 0, len: 34 };
        for (let t = 0; t < 0.3; t += STEP) pv.update(STEP);
        stickPush = null;
        return Math.abs(Math.atan2(Math.sin(taxi.yaw - y0), Math.cos(taxi.yaw - y0)));
      };
      const still = turnOver(0);
      const walk = turnOver(2);
      const cruise = turnOver(SPEED);
      check('a stopped car does not pivot; turning comes in with speed', still < 1e-6 && walk > 0.02 && walk < cruise * 0.5,
        `${still.toFixed(3)} rad stopped, ${walk.toFixed(3)} at 2 u/s, ${cruise.toFixed(3)} at cruise, in 0.3s`);
    }
    // The drift: steering at speed, a tap of the brake breaks the rear loose — the car slides far
    // further sideways than the same turn without it — and straightening up ends it.
    {
      let stickPush = null;
      let gasDown = true;
      const corner = (tap) => {
        const dr = createFreeDrive({ taxi, toScreen, live: () => true, stick: () => stickPush, net,
          locoSpeed: () => boostCruise(), locoHeld: () => gasDown });
        dr.update(STEP);
        // Open ground: the middle of the north edge's road, heading east, at speed.
        dr.place(lineX(0) + 6, lineZ(0), 0);
        taxi.v = 20;
        taxi.stalled = false;
        taxi.braking = false;
        dr.update(STEP);
        // Ask for a turn to the right (south), 70° off the nose.
        const want = -70 * (Math.PI / 180);
        const sv = toScreen(Math.cos(want), -Math.sin(want));
        stickPush = { dx: sv.x * 3, dy: sv.y * 3, len: Math.hypot(sv.x, sv.y) * 3 };
        dr.update(STEP);
        if (tap) {
          taxi.braking = true;
          for (let t = 0; t < 0.1; t += STEP) dr.update(STEP);
          taxi.braking = false;
        }
        let maxSlip = 0;
        let drifted = false;
        for (let t = 0; t < 0.5; t += STEP) {
          dr.update(STEP);
          maxSlip += Math.abs(dr.debug.slip) * STEP;
          drifted ||= dr.debug.drifting;
        }
        // Straighten up: the stick let go.
        stickPush = null;
        for (let t = 0; t < 0.8; t += STEP) dr.update(STEP);
        return { maxSlip, drifted, after: dr.debug.drifting };
      };
      const grip = corner(false);
      const slide = corner(true);
      // Sideways distance over the half second after the tap: a hard turn slides a little at this
      // grip anyway; a drift keeps sliding.
      check('drift: a brake tap mid-turn at speed breaks the rear loose', slide.drifted && !grip.drifted
        && slide.maxSlip > 1.5 * grip.maxSlip,
        `${slide.maxSlip.toFixed(1)} units slid sideways against ${grip.maxSlip.toFixed(1)} without the tap`);
      check('...and straightening up ends it', !slide.after, `${slide.after ? 'still drifting' : 'gripping again'}`);
      gasDown = false;
    }
    // Brake to reverse: the brake held on a stopped car backs it up once `reverseDelay` has run,
    // letting go rolls it to a stop, and backing up the stick aims the tail.
    {
      let stickPush = null;
      const rv = createFreeDrive({ taxi, toScreen, live: () => true, stick: () => stickPush, net,
        locoSpeed: () => boostCruise(), locoHeld: () => false });
      // On the gas pedal, so letting go rolls to a stop; and with the hold the first cut had (the
      // shipped `reverseDelay` is 0, which backs at once), so the hold itself is still tested.
      rv.tune.gasPedal = 1;
      rv.tune.reverseDelay = 0.3;
      rv.update(STEP);
      rv.place(lineX(1) + 2, lineZ(GRID_J) - 40, Math.PI / 2);
      taxi.v = 0;
      taxi.stalled = false;
      taxi.braking = true;
      for (let t = 0; t < 0.2; t += STEP) rv.update(STEP);
      const early = taxi.v;
      // Read after an update: `place` moves the model, and `taxi.z` follows on its next frame.
      const z0 = taxi.z;
      for (let t = 0; t < 1.5; t += STEP) rv.update(STEP);
      const backing = taxi.v;
      const backed = taxi.z - z0;
      taxi.braking = false;
      for (let t = 0; t < 3; t += STEP) rv.update(STEP);
      const after = taxi.v;
      check('brake held at a stop: nothing for the first moment, then it backs up',
        early === 0 && Math.abs(backing + FREE_TUNING.reverseSpeed) < 0.05 && backed > 2,
        `v ${early.toFixed(2)} at 0.2s, ${backing.toFixed(2)} at 1.7s, ${backed.toFixed(1)} units backed (south)`);
      check('...and letting go of the brake rolls it to a stop', after === 0, `v ${after.toFixed(2)}`);
      // Backing up with the stick pushed east: the tail swings east, the nose round to the west.
      taxi.braking = true;
      rv.place(lineX(1) + 2, lineZ(GRID_J) - 40, Math.PI / 2);
      taxi.v = 0;
      const east = toScreen(1, 0);
      stickPush = { dx: east.x * 4, dy: east.y * 4, len: Math.hypot(east.x, east.y) * 4 };
      for (let t = 0; t < 3; t += STEP) rv.update(STEP);
      stickPush = null;
      taxi.braking = false;
      const noseOff = Math.abs(Math.atan2(Math.sin(taxi.yaw - Math.PI), Math.cos(taxi.yaw - Math.PI)));
      check('...and backing up, the stick aims the tail', noseOff < 0.3 && taxi.v < 0,
        `nose ${((taxi.yaw * 180) / Math.PI).toFixed(0)}° (west is 180°), v ${taxi.v.toFixed(2)}`);
      for (let t = 0; t < 3; t += STEP) rv.update(STEP);
    }
    // Lane assist: hands off, a car on a street but off its lane is drawn into the lane without
    // weaving — with the street magnet off (Tyler's own settings: magnet 0°, magnet pull 0), and
    // from a heading drifting off the street. And a deliberate turn passes through it.
    {
      const laneOf = (rk) => rk.debug.keep;
      const drive = ({ keep = true, yaw0 = Math.PI / 2, x0 = lineX(1) - 1, stickPush = null, seconds = 4, magnet = true } = {}) => {
        const rk = createFreeDrive({ taxi, toScreen, live: () => true, stick: () => stickPush, net,
          locoSpeed: () => boostCruise(), locoHeld: () => true });
        rk.tune.laneAssist = keep ? FREE_TUNING.laneAssist : 0;
        if (!magnet) { rk.tune.assistDeg = 0; rk.tune.settle = 0; }
        rk.update(STEP);
        rk.place(x0, lineZ(GRID_J) - 4, yaw0);
        taxi.v = SPEED;
        taxi.stalled = false;
        rk.update(STEP);
        const before = Math.abs(laneOf(rk)?.lat ?? NaN);
        let side = 0;
        let worst = 0;
        let lastLat = laneOf(rk)?.lat ?? 0;
        for (let t = 0; t < seconds; t += STEP) {
          rk.update(STEP);
          const k = laneOf(rk);
          if (k) {
            // Overshoot: how far past the centre it swung, on the far side from where it started.
            if (Math.sign(k.lat) !== Math.sign(lastLat) && lastLat !== 0) side = Math.sign(k.lat);
            if (side && Math.sign(k.lat) === side) worst = Math.max(worst, Math.abs(k.lat));
          }
        }
        const k = laneOf(rk);
        return { before, after: k ? Math.abs(k.lat) : Infinity, overshoot: worst, x: taxi.x - lineX(1), drivable: rk.drivable(taxi.x, taxi.z), yaw: taxi.yaw };
      };
      const on = drive();
      check('lane assist, hands off: an off-centre car is drawn into its lane', on.after < 0.15,
        `${on.before.toFixed(2)} → ${on.after.toFixed(2)} off the lane in 4s`);
      check('...without weaving', on.overshoot < 0.6, `${on.overshoot.toFixed(2)} past the centre at most`);
      const bare = drive({ magnet: false });
      check('...with the street magnet off', bare.after < 0.15, `${bare.before.toFixed(2)} → ${bare.after.toFixed(2)}`);
      const drifting = drive({ magnet: false, yaw0: Math.PI / 2 + 0.14, x0: lineX(1) + 2 });
      const loose = drive({ magnet: false, keep: false, yaw0: Math.PI / 2 + 0.14, x0: lineX(1) + 2, seconds: 2 });
      check('...and a heading drifting 8° off the street is caught before the kerb', drifting.after < 0.3 && drifting.drivable,
        `${drifting.after.toFixed(2)} off the lane after 4s (without it: ${loose.x.toFixed(1)} off the street's centreline in 2s)`);
      // A held push 40° off the street, which is outside the window: the car goes where it is told.
      const deg = Math.PI / 180;
      const want = Math.PI / 2 + 40 * deg;
      const s2 = toScreen(Math.cos(want), -Math.sin(want));
      const turned = drive({ stickPush: { dx: s2.x * 3, dy: s2.y * 3, len: Math.hypot(s2.x, s2.y) * 3 }, x0: lineX(1) + 2, seconds: 0.8 });
      check('...and a deliberate turn passes through it', Math.abs(turned.yaw - want) < 8 * deg,
        `heading ${((turned.yaw * 180) / Math.PI).toFixed(0)}° for a push at ${((want * 180) / Math.PI).toFixed(0)}°`);
    }
    // The two turning circles: a full push turns the car on `turnTight` at town speed and on
    // `turnTop` flat out, so the swing is speed ÷ that circle.
    {
      const sp = createFreeDrive({ tune: { ...CRUISE(), turnSteer: 1 }, taxi, toScreen, live: () => true,
        stick: () => push, net, locoSpeed: () => boostCruise() });
      sp.update(STEP);
      const rateAt = (speed) => {
        sp.place(0, lineZ(0) + 30, 0);
        taxi.v = speed;
        taxi.boost = speed > SPEED;
        push = { dx: 34, dy: 0, len: 34 };
        // Let the swing build, then measure a steady stretch.
        for (let t = 0; t < 0.4; t += STEP) sp.update(STEP);
        const y0 = taxi.yaw;
        for (let t = 0; t < 0.2; t += STEP) sp.update(STEP);
        push = null;
        taxi.boost = false;
        return Math.abs(Math.atan2(Math.sin(taxi.yaw - y0), Math.cos(taxi.yaw - y0))) / 0.2;
      };
      const top = boostCruise();
      const topCircle = sp.tune.turnTop;
      const wide = rateAt(top);
      sp.tune.turnTop = 10;
      const sharp = rateAt(top);
      sp.tune.turnTop = topCircle;
      // Held at 2 u/s: in the cruise model the car would otherwise climb to cruise mid-measurement.
      sp.tune.accel = 0;
      const slow = rateAt(2);
      const circle = (rate, v) => v / rate;
      check('flat out the car turns on the top-speed circle, and a smaller one is sharper',
        Math.abs(circle(wide, top) - topCircle) < 0.15 * topCircle
          && Math.abs(circle(sharp, top) - 10) < 1.5,
        `circle ${circle(wide, top).toFixed(1)} at ${topCircle}, ${circle(sharp, top).toFixed(1)} at 10`);
      check('...and slow it turns on the tightest circle', Math.abs(circle(slow, 2) - FREE_TUNING.turnTight) < 0.4,
        `circle ${circle(slow, 2).toFixed(2)} at 2 u/s against ${FREE_TUNING.turnTight}`);
    }
    // The Drive panel's switches: Turn steering under the ¾ camera is the follow camera's, and
    // Invert mirrors it — a right push turns left.
    {
      const sw = createFreeDrive({ tune: CRUISE(), taxi, toScreen, live: () => true, stick: () => push, net });
      sw.tune.turnSteer = 1;
      sw.update(STEP);
      const turnOf = () => {
        sw.place(0, lineZ(0) + 30, 0.5);
        taxi.v = SPEED;
        push = { dx: 34, dy: 0, len: 34 };
        for (let t = 0; t < 0.3; t += STEP) sw.update(STEP);
        push = null;
        return Math.atan2(Math.sin(taxi.yaw - 0.5), Math.cos(taxi.yaw - 0.5));
      };
      const plain = turnOf();
      sw.tune.invertSteer = 1;
      const inverted = turnOf();
      check('¾ view Turn steering: a right push turns right', plain < -0.3, `${plain.toFixed(2)} rad`);
      check('...and inverted, a right push turns left', inverted > 0.3, `${inverted.toFixed(2)} rad`);
    }
    // A taxi let go of a staged trip (the opening's skip) and taken by free driving before the
    // traffic model has run: it has to come out on the lane it was released onto, not at the spot
    // it was staged on — which for the opening is inside the garage, behind a shut door.
    {
      let wheel = false;
      const rel = createFreeDrive({ tune: CRUISE(), taxi, toScreen, live: () => wheel, stick: () => null, net });
      const lane = net.lanes.find((l) => l.path && l.length > 12);
      const d = net.dirOfLane(lane);
      const node = net.nodeById.get(lane.to);
      stageCar(taxi, lineX(0) - 40, lineZ(0) - 40, 0);
      rel.update(STEP);
      const released = releaseCar(taxi, d, node.gi, node.gj, 6);
      wheel = true;
      rel.update(STEP);
      const on = taxi.lane.path.at(taxi.s);
      check('a taxi released from a staged trip is picked up on its lane, not where it was staged',
        released && Math.hypot(taxi.x - on.x, taxi.z - on.z) < 1,
        `${Math.hypot(taxi.x - on.x, taxi.z - on.z).toFixed(2)} units off the lane`);
      wheel = false;
      rel.update(STEP);
    }
    free.place(taxi.x, taxi.z, taxi.yaw);
  }

  // Handed back (a scripted trip takes the wheel): on a lane, in the model, and moving again.
  isLive = false;
  free.update(STEP);
  const handed = taxi.free === false && taxi.lane && taxi.s >= 0 && taxi.s <= taxi.lane.length;
  let moved = 0;
  for (let t = 0; t < 20; t += STEP) {
    const px = taxi.x; const pz = taxi.z;
    drive(() => null);
    moved += Math.hypot(taxi.x - px, taxi.z - pz);
  }
  check('handed back, the traffic model drives it on from a lane', handed && moved > 20, `${moved.toFixed(1)} units`);
  console.log(`free trips: mean ${(freeTime / Math.max(1, freeArrived)).toFixed(1)}s`);
}

// --- The game controller (src/game/gamepad.js) -------------------------------------------------
{
  check('pad: a resting stick says nothing', deadZone(0.1, -0.12) === null);
  const up = deadZone(0, -1);
  check('pad: full up is full length straight up', up && Math.abs(up.mag - 1) < 1e-9 && up.y < -0.99);
  const edge = deadZone(STICK_DEAD + 1e-6, 0);
  check('pad: the push grows from zero at the dead zone', edge && edge.mag < 1e-4);
  // Pad screen-up drives the same ground heading as the touch stick pushed up.
  const g = screenToGround(0, -1, toScreen);
  const back = toScreen(g.x, g.z);
  check('pad: stick up steers screen-up', back.y < 0 && Math.abs(back.x) < 1e-6 * Math.hypot(back.x, back.y) + 1e-6,
    `${back.x.toFixed(3)}, ${back.y.toFixed(3)}`);
  // A menu: Play over Settings over Credits in a column, a Board button off to the right of Play.
  const play = { el: 'play', x: 200, y: 300 };
  const settings = { el: 'settings', x: 200, y: 360 };
  const credits = { el: 'credits', x: 200, y: 420 };
  const board = { el: 'board', x: 330, y: 300 };
  const menu = [play, settings, credits, board];
  check('pad: down from Play is Settings', nearestInDirection(play, menu, [0, 1])?.el === 'settings');
  check('pad: right from Play is the button beside it', nearestInDirection(play, menu, [1, 0])?.el === 'board');
  check('pad: down from the side button lands in the column', nearestInDirection(board, menu, [0, 1])?.el === 'settings');
  check('pad: up from the top stays put', nearestInDirection(play, menu, [0, -1]) === null);
}

console.log(`steered trips: mean ${(total / Math.max(1, arrived)).toFixed(1)}s`);
console.log(`${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
